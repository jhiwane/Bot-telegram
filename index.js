const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

const axios = require('axios');
const crypto = require('crypto');

// ==========================================
// KONFIGURASI DAN ENV CHECK
// ==========================================
// Pastikan semua ENV terisi agar tidak error undefined
const KEYS = {
    VIP: { id: process.env.VIP_ID, key: process.env.VIP_KEY },
    DIGI: { user: process.env.DIGI_USER, key: process.env.DIGI_KEY },
};

const ADMIN_ID = String(process.env.ADMIN_ID); // Pastikan string
const VIP_ID = process.env.VIP_ID; 
const VIP_KEY = process.env.VIP_KEY;

// ==========================================
// FUNGSI PINTAR: DETEKSI CREDENTIALS
// ==========================================
const getCredentialsByUrl = (url) => {
    if (!url) return null;
    const u = url.toLowerCase();
    if (u.includes('vip-reseller')) {
        return { id: KEYS.VIP.id, key: KEYS.VIP.key, type: 'VIP' };
    }
    if (u.includes('api-digi') || u.includes('digiflazz')) {
        return { id: KEYS.DIGI.user, key: KEYS.DIGI.key, type: 'DIGI' };
    }
    return null; 
};

// ==========================================
// FUNGSI TEMBAK API (DIPERBAIKI: ERROR HANDLING)
// ==========================================
const beliGeneric = async (apiUrl, serviceCode, target) => {
    try {
        const creds = getCredentialsByUrl(apiUrl);
        
        // --- JALUR 1: API RESMI (VIP / DIGI) ---
        if (creds) {
            let payload = {};
            
            // LOGIKA VIP
            if (creds.type === 'VIP') {
                const sign = crypto.createHash('md5').update(creds.id + creds.key).digest("hex");
                payload = { key: creds.key, sign: sign, type: 'order', service: serviceCode, data_no: target };
            } 
            // LOGIKA DIGI
            else if (creds.type === 'DIGI') {
                const sign = crypto.createHash('md5').update(creds.id + creds.key + "depo").digest("hex"); 
                payload = { username: creds.id, buyer_sku_code: serviceCode, customer_no: target, sign: sign };
            }
            // LOGIKA GENERIC POST
            else {
                const sign = crypto.createHash('md5').update(creds.id + creds.key).digest("hex");
                payload = { key: creds.key, sign: sign, service: serviceCode, target: target };
            }

            // Request dengan timeout agar tidak hang
            const response = await axios.post(apiUrl, payload, { timeout: 30000 });
            const res = response.data;

            // Normalisasi Response yang beragam
            if (!res) return { sukses: false, msg: "API No Response" };

            // Cek sukses umum
            if (res.result === true || (res.data && ['Pending', 'Success', 'Proses'].includes(res.data.status))) {
                return { sukses: true, sn: res.data?.trx_id || res.data?.sn || "Sedang Diproses", msg: res.message || "Sukses" };
            } 
            // Cek sukses code '00' (Digi)
            else if (res.data && res.data.rc === '00') {
                 return { sukses: true, sn: res.data.sn, msg: "Sukses" };
            }
            
            return { sukses: false, msg: res.message || res.data?.message || JSON.stringify(res) };
        } 
        
        // --- JALUR 2: URL BEBAS / GOOGLE SCRIPT (GET REQUEST) ---
        else {
            const separator = apiUrl.includes('?') ? '&' : '?';
            const fullUrl = `${apiUrl}${separator}service=${serviceCode}&target=${target}`;
            
            const response = await axios.get(fullUrl, { timeout: 30000 });
            const res = response.data;

            if (res) {
                if (typeof res === 'object') {
                    if (res.status === true || res.success === true || res.code === 200) {
                        return { sukses: true, sn: res.data || res.content || "Berhasil", msg: "Sukses" };
                    }
                } else if (typeof res === 'string') {
                    if (res.includes('STOK_HABIS')) return { sukses: false, msg: "Stok Habis (Script)" };
                    if (res.includes('ERROR')) return { sukses: false, msg: "Script Error" };
                    if (res.length > 2) return { sukses: true, sn: res, msg: "Sukses" };
                }
            }
            return { sukses: false, msg: "Gagal: Respon Script Tidak Valid" };
        }

    } catch (error) {
        console.error("API Error:", error.message);
        const msg = error.response ? JSON.stringify(error.response.data) : error.message;
        return { sukses: false, msg: `Network Err: ${msg}` };
    }
};

// ==========================================
// 1. SETUP SERVER & DATABASE
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;
const adminSession = {}; 

// --- FIREBASE SETUP ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) { 
    console.error("❌ Firebase Config Error:", error.message); 
    process.exit(1); // Matikan app jika DB gagal load
}
const db = admin.firestore();

// --- TELEGRAM BOT SETUP ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware: Hanya Admin
bot.use(async (ctx, next) => {
    if (ctx.from && String(ctx.from.id) !== ADMIN_ID) return; // Silent block for non-admin
    return next();
});
const cancelBtn = Markup.inlineKeyboard([Markup.button.callback('❌ BATAL', 'cancel_action')]);

// Helper: Kirim Pesan Panjang (Safe Split)
const safeReply = async (ctx, text) => {
    if (text.length <= 4000) return ctx.reply(text, { parse_mode: 'Markdown' });
    const chunks = text.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks) {
        await ctx.reply(chunk); // Matikan markdown untuk chunk agar aman
    }
};

// Helper: Notifikasi User
const notifyUser = async (targetId, message) => {
    if (!targetId || isNaN(targetId)) return; 
    try {
        await bot.telegram.sendMessage(targetId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.log(`⚠️ Gagal kirim notif ke user ${targetId}: ${error.message}`);
    }
};

// ==========================================
// 2. SECURITY CHECK (ANTI FRAUD)
// ==========================================
const validateOrderSecurity = async (orderId, orderData) => {
    let calculatedTotal = 0;
    
    for (const item of orderData.items) {
        const prodRef = db.collection('products').doc(item.id);
        const prodSnap = await prodRef.get();
        
        if (!prodSnap.exists) continue; 
        
        const p = prodSnap.data();
        let realPrice = p.price; 

        if (item.variantName && item.variantName !== 'Regular' && p.variations) {
            const variant = p.variations.find(v => v.name === item.variantName);
            if (variant) realPrice = parseInt(variant.price);
        }
        calculatedTotal += (realPrice * parseInt(item.qty));
    }

    if (orderData.voucherCode) {
        const vRef = db.collection('vouchers').doc(orderData.voucherCode);
        const vSnap = await vRef.get();
        if (vSnap.exists && vSnap.data().active) {
            calculatedTotal -= vSnap.data().amount;
        }
    }

    calculatedTotal = Math.max(0, calculatedTotal);

    // Toleransi selisih 500 perak
    if (orderData.total < (calculatedTotal - 500)) {
        return { isSafe: false, realTotal: calculatedTotal };
    }
    return { isSafe: true };
};

// ==========================================
// 3. CORE LOGIC: STOCK & ORDER PROCESSING
// ==========================================

// [PERBAIKAN]: Logic pengambilan stok lebih teliti, tidak ghosting.
const processStock = async (productId, variantName, qtyNeeded, forceHunterMode = false) => {
    const docRef = db.collection('products').doc(productId);
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return { success: false, currentStock: 0, backupConfig: null };
        
        const data = doc.data();
        let contentPool = "", isVariant = false, variantIndex = -1, isPermanent = false;

        if (variantName && variantName !== 'Regular' && data.variations) {
            variantIndex = data.variations.findIndex(v => v.name === variantName);
            if (variantIndex !== -1) {
                contentPool = data.variations[variantIndex].content || "";
                isPermanent = data.variations[variantIndex].isPermanent === true;
                isVariant = true;
            }
        } else {
            contentPool = data.content || "";
            isPermanent = data.isPermanent === true;
        }

        if (contentPool.startsWith('MULTI_API:')) isPermanent = true;

        // Ambil Config Backup (Auto Hunter)
        let lines = contentPool.split('\n').map(s => s.trim()).filter(s => s.length > 0);
        let backupConfig = lines.find(l => l.startsWith('AUTO_BACKUP:'));
        
        // Bersihkan stok murni (tanpa config)
        let availableStocks = lines.filter(l => !l.startsWith('AUTO_BACKUP:'));

        // Jika mode force hunter, kita anggap stok DB "kosong" agar script lari ke API/Hunter
        if (forceHunterMode) {
             return { 
                success: false, 
                currentStock: 0, 
                backupConfig: backupConfig ? backupConfig.replace('AUTO_BACKUP:', '').trim() : null 
            };
        }

        // Logic Pengurangan Stok
        const currentSold = parseInt(data.sold) || 0;
        const inc = parseInt(qtyNeeded);

        if (isPermanent && !contentPool.includes('AUTO_BACKUP:')) {
            // Jika permanen murni
            t.update(docRef, { sold: currentSold + inc });
            return { success: true, data: contentPool, currentStock: 999999 }; 
        } else {
            // Jika stok manual (habis pakai)
            if (availableStocks.length >= qtyNeeded) {
                const taken = availableStocks.slice(0, qtyNeeded); 
                const remaining = availableStocks.slice(qtyNeeded);
                if(backupConfig) remaining.push(backupConfig); // Balikin config

                const finalContent = remaining.join('\n');
                
                if (isVariant) {
                    data.variations[variantIndex].content = finalContent;
                    t.update(docRef, { variations: data.variations, sold: currentSold + inc });
                } else {
                    t.update(docRef, { content: finalContent, sold: currentSold + inc });
                }
                return { success: true, data: taken.join('\n'), currentStock: availableStocks.length };
            } else {
                // Stok kurang
                return { 
                    success: false, 
                    currentStock: availableStocks.length,
                    backupConfig: backupConfig ? backupConfig.replace('AUTO_BACKUP:', '').trim() : null
                };
            }
        }
    });
};

// [PERBAIKAN BESAR]: Logic Force Retry tidak menghapus data yang sudah sukses
const processOrderLogic = async (orderId, orderData, forceHunter = false) => {
    let items = orderData.items || []; // Ambil items eksisting
    let allComplete = true;
    let msgLog = "";
    let revBtns = [];

    // Loop setiap item dalam order
    for (let i = 0; i < items.length; i++) {
        let item = items[i];
        
        // 1. Cek apa item ini sudah selesai sebelumnya?
        // Jika konten ada dan TIDAK mengandung kata "MENUNGGU", berarti sudah sukses.
        // KECUALI jika forceHunter=true, kita coba cek lagi (opsional), tapi sebaiknya yang sukses biarkan sukses.
        const existingContent = item.content || "";
        const isPending = existingContent.includes('[...MENUNGGU') || existingContent === "";
        
        if (!isPending) {
            // Sudah sukses, skip proses untuk item ini agar tidak double beli
            msgLog += `✅ ${item.name}: SUDAH SELESAI\n`;
            continue;
        }

        // --- PREPARE DATA PRODUK ---
        let sourceContent = "";
        try {
            const prodRef = await db.collection('products').doc(item.id).get();
            if (prodRef.exists) {
                const prodData = prodRef.data();
                sourceContent = prodData.content || "";
                if (item.variantName && item.variantName !== 'Regular' && prodData.variations) {
                    const v = prodData.variations.find(va => va.name === item.variantName);
                    if (v) sourceContent = v.content || "";
                }
            }
        } catch (err) { console.log("DB Err:", err); }

        // ============================================================
        // TAHAP 1: API MULTI PROVIDER (SMART API)
        // ============================================================
        if (sourceContent.startsWith('MULTI_API:')) {
            const apiEntries = sourceContent.replace('MULTI_API:', '').split('#').filter(x => x.trim().length > 5);
            let providerList = apiEntries.map(entry => {
                const [url, sku, buyPrice] = entry.split('|');
                return { url: url?.trim(), sku: sku?.trim(), price: parseInt(buyPrice || 9999999) };
            });
            providerList.sort((a, b) => a.price - b.price); // Urutkan termurah

            let successBuy = false;
            let finalSn = "";
            let errMessage = "";
            
            console.log(`🤖 Smart Buy: Mencari termurah untuk ${item.name}...`);
            
            for (const prov of providerList) {
                if(!prov.url) continue;
                const hasil = await beliGeneric(prov.url, prov.sku, orderData.buyerPhone);
                
                if (hasil.sukses) {
                    successBuy = true;
                    finalSn = hasil.sn;
                    console.log(`✅ SUKSES di ${prov.url}`);
                    break;
                } else {
                    errMessage = hasil.msg;
                    console.log(`❌ GAGAL di ${prov.url}: ${hasil.msg}`);
                }
            }

            if (successBuy) {
                items[i] = { 
                    ...item, 
                    content: `✅ SUKSES!\nSN/TrxID: ${finalSn}\n\nTerima kasih!` 
                };
                msgLog += `✅ ${item.name}: AUTO API SUKSES\n`;
                // Increment sold count
                try {
                    await db.collection('products').doc(item.id).update({ sold: admin.firestore.FieldValue.increment(parseInt(item.qty)) });
                } catch(e){}
            } else {
                items[i] = { 
                    ...item, 
                    content: `[...MENUNGGU PROSES ADMIN...]\n(Semua Jalur Gagal: ${errMessage})` 
                };
                allComplete = false;
                msgLog += `❌ ${item.name}: GAGAL SEMUA API\n`;
                revBtns.push([Markup.button.callback(`🔧 MANUAL: ${item.name}`, `rev_${orderId}_${i}`)]);
            }
            continue; 
        }

        // ============================================================
        // TAHAP 2: STOK MANUAL & HYBRID HUNTER
        // ============================================================
        
        // Hitung berapa qty yang KURANG.
        // Kita tidak mereset array konten, tapi melengkapinya.
        let currentLines = existingContent ? existingContent.split('\n') : [];
        // Filter baris yang valid (bukan placeholder menunggu)
        let validLines = currentLines.filter(l => !l.includes('[...MENUNGGU') && l.trim().length > 0);
        let qtyFilled = validLines.length;
        let qtyNeeded = parseInt(item.qty) - qtyFilled;

        if (qtyNeeded <= 0) {
            msgLog += `✅ ${item.name}: VALID\n`;
            continue;
        }

        try {
            // Minta stok kekurangan ke DB
            const result = await processStock(item.id, item.variantName, qtyNeeded, forceHunter);
            
            let newStockData = [];
            
            if (result.success) {
                // Stok manual CUKUP
                newStockData = result.data.split('\n');
                msgLog += `✅ ${item.name}: DIAMBIL DARI GUDANG\n`;
            } else {
                // Stok manual KURANG / Force Hunter -> Cek Backup Config
                
                // Ambil sisa stok manual yang ada (jika tidak force)
                if (result.currentStock > 0 && !forceHunter) {
                    const partial = await processStock(item.id, item.variantName, result.currentStock);
                    newStockData = partial.data.split('\n');
                }

                // Sisa kekurangan setelah ambil manual
                const stillNeed = qtyNeeded - newStockData.length;

                // JALANKAN HUNTER (AUTO_BACKUP)
                if (result.backupConfig && stillNeed > 0) {
                    const [url, sku] = result.backupConfig.split('|');
                    console.log(`🤖 Hunter Active: Mencari ${stillNeed} via Backup...`);
                    
                    for(let k=0; k<stillNeed; k++) {
                        const hasil = await beliGeneric(url, sku, orderData.buyerPhone);
                        if(hasil.sukses) {
                            newStockData.push(`SN: ${hasil.sn}`);
                        } else {
                            newStockData.push(`[...MENUNGGU (API Gagal: ${hasil.msg})...]`);
                        }
                    }
                }
            }

            // GABUNGKAN DATA: [Stok Lama yg Valid] + [Stok Baru dr DB/API]
            let finalLines = [...validLines, ...newStockData];
            
            // Cek apakah masih kurang? (Gagal hunter dll)
            const totalNow = finalLines.length;
            const finalLack = parseInt(item.qty) - totalNow;

            // Isi placeholder jika masih kurang
            for(let k=0; k<finalLack; k++) finalLines.push(`[...MENUNGGU PROSES...]`);

            if (finalLack > 0 || finalLines.some(l => l.includes('MENUNGGU'))) {
                allComplete = false;
                msgLog += `⚠️ ${item.name}: PARTIAL/PENDING\n`;
                revBtns.push([Markup.button.callback(`🔧 ISI SISA: ${item.name}`, `rev_${orderId}_${i}`)]);
            } else {
                msgLog += `✅ ${item.name}: LENGKAP\n`;
            }

            items[i] = { ...item, content: finalLines.join('\n') };

        } catch (e) {
            console.error(e);
            items[i] = item; // Keep as is
            allComplete = false;
            msgLog += `❌ ${item.name}: DB ERROR\n`;
        }
    }
    
    // ============================================================
    // TAHAP 3: FINALISASI STATUS & NOTIFIKASI
    // ============================================================
    
    // Tentukan status global
    let finalStatus = allComplete ? 'success' : 'processing'; // Jangan set success jika belum beres
    
    // Simpan ke DB
    await db.collection('orders').doc(orderId).update({ 
        items: items, 
        status: finalStatus, // Update status agar web user tau
        processed: true 
    });

    // Notif ke Admin
    if (!allComplete) {
        revBtns.push([Markup.button.callback('⚡ PAKSA RETRY (HUNTER)', `force_send_${orderId}`)]);
        bot.telegram.sendMessage(ADMIN_ID, 
            `⚠️ *ORDER ${orderId} BELUM LENGKAP*\nStatus: Processing/Partial.\n\n${msgLog}\nSegera isi manual atau paksa retry!`, 
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) }
        );
    } else {
        bot.telegram.sendMessage(ADMIN_ID, 
            `✅ *ORDER ${orderId} SELESAI*\n${msgLog}`, 
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🛠 MENU EDIT', `menu_edit_ord_${orderId}`)]]) }
        );
    }

    // Notif ke User (Hanya kirim yang bersih)
    let userMsg = `✅ *STATUS PESANAN*\n🆔 Order: \`${orderId}\`\n\n`;
    items.forEach(item => {
        let clean = item.content.replace('MULTI_API:', '').replace(/AUTO_BACKUP:.*?\|.*?\|.*?/g, '');
        // Ganti placeholder internal dengan pesan user friendly
        let contentClean = clean.replace(/\[\.\.\.MENUNGGU.*?\]/g, '_(Sedang diproses/Menunggu pembayaran)_');
        userMsg += `📦 *${item.name}*\n\`${contentClean}\`\n\n`;
    });
    userMsg += `_Terima kasih sudah belanja!_`;

    await notifyUser(orderData.buyerPhone, userMsg);
};

const forceFulfillOrder = async (orderId) => {
    try {
        const docRef = db.collection('orders').doc(orderId);
        const docSnap = await docRef.get();
        if (!docSnap.exists) return { success: false, msg: "Order 404" };
        
        // Panggil Logic dengan Force Hunter = TRUE
        await processOrderLogic(orderId, docSnap.data(), true);
        return { success: true, msg: "✅ Perintah Retry Terkirim!" };
    } catch (e) { return { success: false, msg: "Err: " + e.message }; }
};

// ==========================================
// 4. API WEBHOOKS (UNTUK FRONTEND WEB)
// ==========================================
app.post('/api/confirm-manual', async (req, res) => {
    try {
        const { orderId, buyerPhone, total, items } = req.body;
        let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
        
        await bot.telegram.sendMessage(ADMIN_ID, 
            `🔔 *ORDER MASUK (MANUAL)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}\n\n_Cek mutasi bank, lalu klik Proses._`, 
            Markup.inlineKeyboard([
                [Markup.button.callback('⚡ TERIMA & PROSES', `force_send_${orderId}`)], // Logic sama dengan force send
                [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ])
        );
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    await db.collection('orders').doc(orderId).update({ complain: true, complainResolved: false, userComplainText: message });
    bot.telegram.sendMessage(ADMIN_ID, `🚨 *KOMPLAIN USER* 🚨\n🆔 \`${orderId}\`\n💬 "${message}"`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📩 BALAS', `reply_comp_${orderId}`), Markup.button.callback('✅ TANDAI SELESAI', `solve_${orderId}`)]]) });
    res.json({ status: 'ok' });
});

app.post('/api/notify-order', async (req, res) => {
    // Dipanggil saat pembayaran otomatis gateway sukses
    const { orderId, buyerPhone, total, items, voucherCode } = req.body; 
    const docRef = db.collection('orders').doc(orderId);
    const docSnap = await docRef.get();
    
    if (docSnap.exists) {
        const orderData = docSnap.data();
        
        // Security Check
        const security = await validateOrderSecurity(orderId, orderData);
        if (!security.isSafe) {
            await docRef.update({ status: 'FRAUD', adminReply: 'SYSTEM: BANNED DUE TO CHEATING.' });
            if (orderData.uid) {
                // Auto Ban User
                await db.collection('banned_users').doc(orderData.uid).set({ bannedAt: new Date(), reason: `Fraud Order ${orderId}` });
                await db.collection('users').doc(orderData.uid).delete(); 
            }
            bot.telegram.sendMessage(ADMIN_ID, `🚨 *FRAUD DETECTED!* \nOrder: ${orderId}\nUser dibanned.`);
            return res.json({ status: 'fraud' });
        }
        
        let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER LUNAS (SALDO)*\n🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, { parse_mode: 'Markdown' });
        
        // Jalankan proses order (Normal Mode)
        await processOrderLogic(orderId, orderData, false);
    }
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('JSN-02 ENGINE RUNNING'));

// ==========================================
// 5. BOT BRAIN & MENU
// ==========================================
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('⏳ PENDING', 'list_pending'), Markup.button.callback('📦 CEK STOK GUDANG', 'list_all_stock')],
    [Markup.button.callback('📄 RESTOCK VIA FILE', 'restock_sheet_ask')],
    [Markup.button.callback('👥 PANDUAN', 'help_msg'), Markup.button.callback('💳 SET PAYMENT', 'set_payment')],
    [Markup.button.callback('💰 SALES HARI INI', 'sales_today'), Markup.button.callback('🚨 KOMPLAIN', 'list_complain')],
    [Markup.button.callback('📂 BACKUP DB', 'backup_db'), Markup.button.callback('📥 RESTORE DB', 'import_db_ask')]
]);

bot.command('start', (ctx) => ctx.reply("🤖 *PANEL ADMIN*\n\nSelamat datang bos. Gunakan menu di bawah ini atau ketik 'help' untuk panduan perintah manual.", {parse_mode:'Markdown', ...mainMenu}));
bot.command('menu', (ctx) => ctx.reply("🛠 *MENU UTAMA*", mainMenu));
bot.command('help', (ctx) => ctx.reply("📘 *PANDUAN*\n\n1. Ketik Kode Produk/Nama untuk cari & edit.\n2. Ketik Order ID untuk cek status.\n3. Ketik Email User untuk cek saldo.\n4. Ketik 'VOUCHER' untuk buat kode promo.", cancelBtn));

bot.on(['text', 'photo', 'document'], async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    
    let text = "";
    // Handle File Upload (Restore DB / Restock)
    if (ctx.message.document) {
        try { 
            const session = adminSession[ctx.from.id];
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const response = await axios.get(fileLink.href);

            if (session && session.type === 'IMPORT_DB') {
                ctx.reply("⏳ Restore DB sedang berjalan...");
                const data = response.data;
                const batchLimit = 400; let batch = db.batch(); let opCount = 0;
                for (const [collectionName, items] of Object.entries(data)) {
                    if (!Array.isArray(items)) continue;
                    for (const item of items) {
                        const docRef = db.collection(collectionName).doc(item.id);
                        const { id, ...docData } = item; 
                        batch.set(docRef, docData, { merge: true });
                        opCount++;
                        if (opCount >= batchLimit) { await batch.commit(); batch = db.batch(); opCount = 0; }
                    }
                }
                if (opCount > 0) await batch.commit();
                delete adminSession[ctx.from.id];
                return ctx.reply("✅ **RESTORE SUKSES!** Data kembali.");
            } 
            else if (session && session.type === 'RESTOCK_SHEET') {
                ctx.reply("⏳ Upload ke Script...");
                const rawData = response.data; 
                let stockArray = typeof rawData === 'string' ? rawData.split('\n').map(s=>s.trim()).filter(s=>s) : [];
                if (stockArray.length === 0) return ctx.reply("❌ File kosong.");

                try {
                    const resGoogle = await axios.post(session.targetUrl, { data: stockArray }, { headers: { 'Content-Type': 'application/json' } });
                    delete adminSession[ctx.from.id];
                    return ctx.reply(`✅ **UPLOAD SUKSES!**\nTotal: ${stockArray.length} baris.`);
                } catch(err) { return ctx.reply("❌ Gagal Script: " + err.message); }
            }
        } catch(e) { return ctx.reply("❌ Error File: " + e.message); }
    } 
    else if (ctx.message.photo) {
        text = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else {
        text = ctx.message.text ? ctx.message.text.trim() : '';
    }

    const textLower = text.toLowerCase();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    // SHORTCUT COMMANDS
    if (textLower === 'voucher') {
        adminSession[userId] = { type: 'MAKE_VOUCHER', step: 'CODE', data: {} };
        return ctx.reply("🎫 **BUAT VOUCHER**\nKetik KODE:", cancelBtn);
    }
    
    // SESSION LOGIC
    if (session) {
        // --- RESTOCK SHEET SESSION ---
        if (session.type === 'ASK_SHEET_URL') {
            if (!text.includes('script.google.com')) return ctx.reply("❌ Link Script Google Salah.", cancelBtn);
            session.type = 'RESTOCK_SHEET'; session.targetUrl = text;
            ctx.reply("📂 Oke, sekarang kirim **File TXT** isinya stok.", cancelBtn); return;
        }

        // --- ADD VARIATION EXISTING ---
        else if (session.type === 'ADD_VAR_EXISTING') {
            const prodRef = db.collection('products').doc(session.prodId);
            const docSnap = await prodRef.get();
            const prodData = docSnap.data();
            let variations = prodData.variations || [];

            if (session.step === 'NAME') { session.tempVar = { name: text, apiList: [] }; session.step = 'CODE'; ctx.reply("Kode Variasi:", cancelBtn); }
            else if (session.step === 'CODE') { session.tempVar.code = text; session.step = 'PRICE'; ctx.reply("Harga:", cancelBtn); }
            else if (session.step === 'PRICE') { session.tempVar.price = parseInt(text); session.step = 'ASK_API'; ctx.reply("Pakai API? (ya/tidak)", cancelBtn); }
            else if (session.step === 'ASK_API') {
                if (text.toLowerCase() === 'ya') { session.step = 'INPUT_API'; ctx.reply("Format: `URL|KODE|MODAL`", cancelBtn); } 
                else { session.step = 'CONTENT'; ctx.reply("Stok Manual:", cancelBtn); }
            }
            else if (session.step === 'INPUT_API') {
                session.tempVar.content = 'MULTI_API:' + text; session.tempVar.isPermanent = true;
                variations.push(session.tempVar); await prodRef.update({ variations });
                delete adminSession[userId]; ctx.reply("✅ Variasi API Saved!");
            }
            else if (session.step === 'CONTENT') {
                session.tempVar.content = text; session.tempVar.isPermanent = false;
                variations.push(session.tempVar); await prodRef.update({ variations });
                delete adminSession[userId]; ctx.reply("✅ Variasi Manual Saved!");
            }
            return;
        }

        // --- MAKE VOUCHER ---
        else if (session.type === 'MAKE_VOUCHER') {
            if (session.step === 'CODE') { session.data.code = text.toUpperCase(); session.step = 'AMOUNT'; ctx.reply("Nominal Diskon (Angka):", cancelBtn); }
            else if (session.step === 'AMOUNT') {
                await db.collection('vouchers').doc(session.data.code).set({ amount: parseInt(text), active: true, createdAt: new Date() });
                delete adminSession[userId]; ctx.reply("✅ Voucher Aktif.");
            }
            return;
        }

        // --- REVISI ITEM ORDER ---
        else if (session.type === 'REVISI') {
            const d = await db.collection('orders').doc(session.orderId).get();
            const data = d.data();
            data.items[session.itemIdx].content = text; // Langsung timpa
            await db.collection('orders').doc(session.orderId).update({ items: data.items });
            delete adminSession[userId];
            ctx.reply("✅ Data diedit manual. Klik Force Retry jika perlu kirim ulang.");
            return;
        }

        // --- TAMBAH PRODUK BARU ---
        else if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("Kode:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("Harga:", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("Gambar (URL/Kirim Foto):", cancelBtn); }
            else if (session.step === 'IMG') { 
                d.image = text; d.images = [text]; d.sold = 0; 
                session.step = 'CONTENT'; ctx.reply("Isi Stok (Manual / MULTI_API:...):", cancelBtn); 
            }
            else if (session.step === 'CONTENT') {
                d.content = text; 
                d.isPermanent = text.includes('MULTI_API');
                await db.collection('products').add({...d, createdAt: new Date()});
                delete adminSession[userId];
                ctx.reply("✅ Produk Saved!");
            }
            return;
        }

        // --- TOPUP USER ---
        else if (session.type === 'TOPUP_USER') {
            await db.collection('users').doc(session.targetUid).update({ balance: admin.firestore.FieldValue.increment(parseInt(text)) });
            await notifyUser(session.targetUid, `💰 *DEPOSIT BERHASIL*\nSaldo ditambah: Rp ${parseInt(text).toLocaleString()}`);
            delete adminSession[userId]; ctx.reply("✅ Berhasil."); return;
        }
        
        // --- EDIT VALUE ---
        else if (session.type === 'EDIT_MAIN') {
             await db.collection('products').doc(session.prodId).update({[session.field]: isNaN(text) ? text : parseInt(text)});
             delete adminSession[userId]; ctx.reply("✅ Updated."); return;
        }

        // --- REPLY COMPLAIN ---
        else if (session.type === 'REPLY_COMPLAIN') {
             await db.collection('orders').doc(session.orderId).update({adminReply: text, complainResolved: true});
             const ord = await db.collection('orders').doc(session.orderId).get();
             if(ord.exists) await notifyUser(ord.data().buyerPhone, `🔔 *INFO KOMPLAIN*\nRef: ${session.orderId}\n\n${text}`);
             delete adminSession[userId]; ctx.reply("✅ Terkirim."); return;
        }
    }

    // UNIVERSAL SEARCH
    if (text) {
        ctx.reply("🔍 Mencari...");
        
        // Cek Order ID
        const orderSnap = await db.collection('orders').doc(text).get();
        if (orderSnap.exists) {
            const o = orderSnap.data();
            return ctx.reply(`📦 *ORDER ${orderSnap.id}*\nUser: ${o.buyerPhone}\nStatus: ${o.status}`, {
                parse_mode:'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⚡ PROSES (RETRY)', `force_send_${orderSnap.id}`)],
                    [Markup.button.callback('🛠 MENU EDIT', `menu_edit_ord_${orderSnap.id}`)],
                    [Markup.button.callback('🗑 HAPUS', `del_order_${orderSnap.id}`)]
                ])
            });
        }
        
        // Cek Produk
        const prods = await db.collection('products').where('code', '==', textLower).get();
        if (!prods.empty) {
            const p = prods.docs[0];
            return ctx.reply(`📦 *${p.data().name}*\nRp ${p.data().price}`, Markup.inlineKeyboard([
                [Markup.button.callback('✏️ EDIT', `menu_edit_main_${p.id}`)],
                [Markup.button.callback('🗑 HAPUS', `del_prod_${p.id}`)]
            ]));
        }

        ctx.reply("❌ Data tidak ditemukan.");
    }
});

// ==========================================
// ACTION HANDLERS (CALLBACK BUTTONS)
// ==========================================
bot.action('cancel_action', (ctx) => { delete adminSession[ctx.from.id]; ctx.editMessageText("❌ Dibatalkan."); });
bot.action('restock_sheet_ask', (ctx) => { adminSession[ctx.from.id] = { type: 'ASK_SHEET_URL' }; ctx.reply("🔗 Kirim URL Script Google:", cancelBtn); });
bot.action('add_prod', (ctx)=>{ adminSession[ctx.from.id]={type:'ADD_PROD', step:'NAME', data:{}}; ctx.reply("Nama Produk:", cancelBtn); });
bot.action('backup_db', async (ctx) => {
    ctx.reply("⏳ Backup process...");
    let data = {};
    for (const c of ['products', 'orders', 'users', 'vouchers']) {
        const s = await db.collection(c).get();
        data[c] = s.docs.map(d => ({id: d.id, ...d.data()}));
    }
    const buffer = Buffer.from(JSON.stringify(data, null, 2));
    ctx.replyWithDocument({ source: buffer, filename: 'BACKUP.json' });
});
bot.action('import_db_ask', (ctx)=>{ adminSession[ctx.from.id]={type:'IMPORT_DB'}; ctx.reply("📥 Kirim File JSON Backup:", cancelBtn); });

// [PERBAIKAN]: List Stok Aman dari Crash
bot.action('list_all_stock', async (ctx) => {
    ctx.reply("📦 Mengambil data...");
    const snap = await db.collection('products').get();
    let msg = "📊 **STOK GUDANG**\n\n";
    snap.forEach(doc => {
        const p = doc.data(); 
        const stok = p.isPermanent ? "♾️" : (p.content ? p.content.split('\n').filter(x=>x.trim()).length : 0);
        msg += `🔹 ${p.name} (${p.code}): ${stok}\n`;
    });
    safeReply(ctx, msg);
});

bot.action('list_pending', async (ctx) => {
    const s = await db.collection('orders').where('status', 'in', ['pending', 'processing', 'partial']).limit(10).get();
    if(s.empty) return ctx.reply("✅ Tidak ada pendingan.");
    const btns = s.docs.map(d => [Markup.button.callback(`🕒 ${d.id.slice(0,5)}.. | Rp ${d.data().total}`, `force_send_${d.id}`)]);
    ctx.reply("⏳ Order Pending:", Markup.inlineKeyboard(btns));
});

bot.action('help_msg', (ctx) => ctx.reply("Ketik 'help' untuk lihat perintah manual."));
bot.action(/^force_send_(.+)$/, async (ctx) => {
    await ctx.reply(`⏳ Memaksa proses ulang order ${ctx.match[1]}...`);
    const res = await forceFulfillOrder(ctx.match[1]);
    ctx.reply(res.msg);
});
bot.action(/^menu_edit_ord_(.+)$/, async (ctx) => { 
    const d = await db.collection('orders').doc(ctx.match[1]).get(); 
    const items = d.data().items; 
    const btns = items.map((i, idx) => [Markup.button.callback(`✏️ ${i.name}`, `rev_${ctx.match[1]}_${idx}`)]);
    ctx.reply("Pilih Item:", Markup.inlineKeyboard(btns));
});
bot.action(/^rev_(.+)_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'REVISI', orderId: ctx.match[1], itemIdx: parseInt(ctx.match[2]) };
    ctx.reply("🔧 Kirim Data Baru (Isi stok manual):", cancelBtn);
});
bot.action(/^menu_edit_main_(.+)$/, (ctx) => {
    const pid = ctx.match[1];
    ctx.editMessageText("Edit apa?", Markup.inlineKeyboard([
        [Markup.button.callback('Nama', `ed_main_name_${pid}`), Markup.button.callback('Harga', `ed_main_price_${pid}`)],
        [Markup.button.callback('Stok/Content', `ed_main_content_${pid}`)],
        [Markup.button.callback('➕ Tambah Variasi', `add_var_${pid}`)]
    ]));
});
bot.action(/^ed_main_(.+)_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'EDIT_MAIN', prodId: ctx.match[2], field: ctx.match[1] };
    ctx.reply("Nilai Baru:", cancelBtn);
});
bot.action(/^add_var_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'ADD_VAR_EXISTING', prodId: ctx.match[1], step: 'NAME' };
    ctx.reply("Nama Variasi:", cancelBtn);
});

// Start Server
app.listen(PORT, () => {
    console.log(`✅ JSN ENGINE STARTED ON PORT ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(() => bot.launch());
});
