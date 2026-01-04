const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

// ==========================================
// 0. KONFIGURASI & VARIABEL GLOBAL
// ==========================================
const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_ID;
const VIP_ID = process.env.VIP_ID; 
const VIP_KEY = process.env.VIP_KEY;

const KEYS = {
    VIP: { id: process.env.VIP_ID, key: process.env.VIP_KEY },
    DIGI: { user: process.env.DIGI_USER, key: process.env.DIGI_KEY },
};

// Variable Session untuk menyimpan state admin (Wizard Mode)
const adminSession = {}; 

// ==========================================
// 1. SETUP FIREBASE & SERVER
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Inisialisasi Firebase
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) { 
    console.error("❌ Firebase Error (Cek Env Var):", error.message); 
}
const db = admin.firestore();

// Inisialisasi Bot Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

// Tombol Batal Umum
const cancelBtn = Markup.inlineKeyboard([Markup.button.callback('❌ BATAL / KELUAR', 'cancel_action')]);

// ==========================================
// 2. FUNGSI HELPER (API & UTILS)
// ==========================================

// Helper: Kirim Notif ke User (Aman dari error block)
const notifyUser = async (targetId, message) => {
    if (!targetId) return;
    try { await bot.telegram.sendMessage(targetId, message, { parse_mode: 'Markdown' }); } catch (e) { console.log(`Gagal PM user ${targetId}`); }
};

// Helper: Deteksi Provider API
const getCredentialsByUrl = (url) => {
    const u = url.toLowerCase();
    if (u.includes('vip-reseller')) return { id: KEYS.VIP.id, key: KEYS.VIP.key, type: 'VIP' };
    if (u.includes('api-digi') || u.includes('digiflazz')) return { id: KEYS.DIGI.user, key: KEYS.DIGI.key, type: 'DIGI' };
    return null; 
};

// Helper: Eksekusi Pembelian ke API Luar
const beliGeneric = async (apiUrl, serviceCode, target) => {
    try {
        const creds = getCredentialsByUrl(apiUrl);
        
        // --- JALUR RESMI (VIP/DIGI) ---
        if (creds) {
            let payload = {};
            // VIP
            if (creds.type === 'VIP') {
                const sign = crypto.createHash('md5').update(creds.id + creds.key).digest("hex");
                payload = { key: creds.key, sign: sign, type: 'order', service: serviceCode, data_no: target };
            } 
            // DIGI
            else if (creds.type === 'DIGI') {
                const sign = crypto.createHash('md5').update(creds.id + creds.key + "depo").digest("hex"); 
                payload = { username: creds.id, buyer_sku_code: serviceCode, customer_no: target, sign: sign };
            }

            const response = await axios.post(apiUrl, payload);
            const res = response.data;

            // Cek Response Sukses/Pending
            if (res.result === true || (res.data && (res.data.status === 'Pending' || res.data.status === 'Success')) || (res.data && res.data.rc === '00')) {
                return { sukses: true, sn: res.data?.trx_id || res.data?.sn || "Diproses", msg: "Sukses" };
            }
            return { sukses: false, msg: res.message || res.data?.message || "Gagal Provider" };
        } 
        
        // --- JALUR URL BEBAS / GOOGLE SHEET ---
        else {
            const separator = apiUrl.includes('?') ? '&' : '?';
            const fullUrl = `${apiUrl}${separator}service=${serviceCode}&target=${target}`;
            const response = await axios.get(fullUrl);
            const res = response.data;

            if (typeof res === 'string') {
                if (res.includes('STOK_HABIS')) return { sukses: false, msg: "Stok Habis" };
                if (res.includes('ERROR')) return { sukses: false, msg: "Error Script" };
                // Jika return string panjang/SN
                if (res.length > 2) return { sukses: true, sn: res, msg: "Sukses" };
            } else if (typeof res === 'object') {
                 if (res.status === true || res.success === true || res.code === 200) {
                     return { sukses: true, sn: res.data || "Berhasil", msg: "Sukses" };
                 }
            }
            return { sukses: false, msg: "Gagal URL Bebas" };
        }
    } catch (error) {
        return { sukses: false, msg: `Err Network: ${error.message}` };
    }
};

// Helper: Security Check (Anti Fraud Sederhana)
const validateOrderSecurity = async (orderId, orderData) => {
    let calculatedTotal = 0;
    for (const item of orderData.items) {
        const prodRef = await db.collection('products').doc(item.id).get();
        if (!prodRef.exists) continue; 
        const p = prodRef.data();
        let realPrice = p.price; 
        if (item.variantName && item.variantName !== 'Regular' && p.variations) {
            const variant = p.variations.find(v => v.name === item.variantName);
            if (variant) realPrice = parseInt(variant.price);
        }
        calculatedTotal += (realPrice * item.qty);
    }
    // Cek Voucher
    if (orderData.voucherCode) {
        const vRef = await db.collection('vouchers').doc(orderData.voucherCode).get();
        if (vRef.exists) calculatedTotal -= vRef.data().amount;
    }
    calculatedTotal = Math.max(0, calculatedTotal);
    // Toleransi selisih 500 perak
    if (orderData.total < (calculatedTotal - 500)) return { isSafe: false };
    return { isSafe: true };
};

// ==========================================
// 3. CORE LOGIC (STOK & ORDER) - [FIXED]
// ==========================================

const processStock = async (productId, variantName, qtyNeeded, forceHunterMode = false) => {
    const docRef = db.collection('products').doc(productId);
    
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        
        const data = doc.data();
        let contentPool = "", isPermanent = false, vIndex = -1;

        // --- 1. Ambil Konten Berdasarkan Variasi ---
        if (variantName && data.variations) {
            vIndex = data.variations.findIndex(v => v.name === variantName);
            if (vIndex !== -1) {
                contentPool = data.variations[vIndex].content || "";
                isPermanent = data.variations[vIndex].isPermanent === true;
            }
        } else {
            contentPool = data.content || "";
            isPermanent = data.isPermanent === true;
        }

        // Cek Flag Multi API
        if (contentPool.startsWith('MULTI_API:')) isPermanent = true;

        // --- 2. [FIX PERMANEN] Logika Produk Permanen ---
        // Jika permanen & bukan Auto Backup, langsung sukses tanpa hitung baris
        if (isPermanent && !contentPool.includes('AUTO_BACKUP:')) {
            // Hanya update sold count
            const currentSold = parseInt(data.sold) || 0;
            t.update(docRef, { sold: currentSold + parseInt(qtyNeeded) });
            return { success: true, data: contentPool, isPermanent: true }; 
        }

        // --- 3. Logika Produk Stok Baris (Manual / Auto Backup) ---
        let lines = contentPool.split('\n').filter(s => s.trim().length > 0);
        let backupConfig = lines.find(l => l.startsWith('AUTO_BACKUP:'));
        let stocks = lines.filter(l => !l.startsWith('AUTO_BACKUP:'));

        // Jika mode FORCE HUNTER aktif, anggap stok DB 0 agar lari ke Hunter
        if (forceHunterMode) {
             return { 
                success: false, 
                currentStock: 0, 
                backupConfig: backupConfig ? backupConfig.replace('AUTO_BACKUP:', '').trim() : null 
            };
        }

        // Cek Ketersediaan Stok DB
        if (stocks.length >= qtyNeeded) {
            // STOK CUKUP
            const taken = stocks.slice(0, qtyNeeded);
            const remaining = stocks.slice(qtyNeeded);
            if(backupConfig) remaining.push(backupConfig); // Kembalikan config ke DB

            const finalContent = remaining.join('\n');
            const incSold = parseInt(qtyNeeded);
            const currentSold = parseInt(data.sold) || 0;

            if (vIndex !== -1) {
                data.variations[vIndex].content = finalContent;
                t.update(docRef, { variations: data.variations, sold: currentSold + incSold });
            } else {
                t.update(docRef, { content: finalContent, sold: currentSold + incSold });
            }
            return { success: true, data: taken.join('\n'), isPermanent: false };
        } else {
            // STOK KURANG -> Return info untuk Hunter
            return { 
                success: false, 
                currentStock: stocks.length, 
                backupConfig: backupConfig ? backupConfig.replace('AUTO_BACKUP:', '').trim() : null 
            };
        }
    });
};

const processOrderLogic = async (orderId, orderData, forceHunter = false) => {
    let items = [], allComplete = true, hasPartial = false, msgLog = "", revBtns = [];

    // Loop setiap item dalam order
    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];
        
        // Pre-check: Apakah item ini Permanen di DB? (Untuk fix masalah Partial di item permanen)
        let isItemPermanent = false;
        try {
            const pRef = await db.collection('products').doc(item.id).get();
            if(pRef.exists) {
                const pd = pRef.data();
                if(item.variantName && pd.variations) {
                    const v = pd.variations.find(va => va.name === item.variantName);
                    if(v && v.isPermanent) isItemPermanent = true;
                } else if(pd.isPermanent) isItemPermanent = true;
            }
        } catch(e){}

        // Cek Status Item Sekarang
        const exContent = item.content || "";
        const isPending = exContent.includes('[...MENUNGGU') || exContent === "";
        
        // Jika sudah DONE dan bukan Force, Skip
        if (!isPending && !forceHunter) {
            items.push(item);
            msgLog += `✅ ${item.name}: OK\n`;
            continue;
        }

        // [FIX PERMANEN] Jika Produk Permanen, Langsung Tembak Sukses
        if (isItemPermanent) {
            // Panggil processStock untuk update sold count saja
            const res = await processStock(item.id, item.variantName, item.qty, false);
            items.push({ ...item, content: res.data });
            msgLog += `✅ ${item.name}: PERMANEN (OK)\n`;
            continue; 
        }

        // --- PROSES ITEM STOK / HUNTER ---
        let currentContentLines = item.content ? item.content.split('\n') : [];
        // Ambil baris yang valid (bukan placeholder menunggu)
        let validLines = currentContentLines.filter(l => !l.includes('[...MENUNGGU') && l.trim().length > 0);
        let qtyButuh = item.qty - validLines.length;

        if (qtyButuh <= 0 && !forceHunter) { items.push(item); continue; }

        try {
            // 1. Coba Ambil Stok dari DB
            const result = await processStock(item.id, item.variantName, qtyButuh, forceHunter);

            if (result && result.success) {
                // Skenario A: Stok DB Cukup
                items.push({ ...item, content: validLines.concat(result.data.split('\n')).join('\n') });
                msgLog += `✅ ${item.name}: AMBIL DB\n`;
            } 
            else if (result && !result.success) {
                // Skenario B: Stok DB Kurang -> Jalankan Hunter (Backup)
                let stockFromDB = [];
                // Ambil sisa stok DB dulu (jika ada dan tidak force)
                if(result.currentStock > 0 && !forceHunter) {
                    const partial = await processStock(item.id, item.variantName, result.currentStock);
                    stockFromDB = partial.data.split('\n');
                }

                const haveNow = validLines.length + stockFromDB.length;
                let stillNeed = item.qty - haveNow;
                let hunterResults = [];
                let successCount = 0;

                // Logika Hunter (Tembak API / Link Backup)
                if (result.backupConfig && stillNeed > 0) {
                    const [url, sku] = result.backupConfig.split('|');
                    console.log(`🤖 Hunter Active: Mencari ${stillNeed} unit...`);
                    for(let k=0; k<stillNeed; k++) {
                        const h = await beliGeneric(url, sku, orderData.buyerPhone);
                        if(h.sukses) { 
                            hunterResults.push(h.sn); 
                            successCount++; 
                        } else { 
                            hunterResults.push(`[...MENUNGGU PROSES (Gagal API)...]`); 
                        }
                    }
                    
                    // [FIX SOLD COUNT] Update Sold Count jika Hunter berhasil
                    if(successCount > 0) {
                         try {
                            await db.collection('products').doc(item.id).update({
                                sold: admin.firestore.FieldValue.increment(successCount)
                            });
                         } catch(e) { console.log("Gagal update sold hunter"); }
                    }

                } else {
                    // Jika tidak ada config backup, isi placeholder kosong
                    for(let k=0; k<stillNeed; k++) hunterResults.push(`[...MENUNGGU STOK (Kosong)...]`);
                }

                const finalLines = [...validLines, ...stockFromDB, ...hunterResults];
                
                // Cek Partial Status
                const isStillPartial = finalLines.some(l => l.includes('MENUNGGU'));
                if (isStillPartial) {
                    allComplete = false;
                    hasPartial = true;
                    msgLog += `⚠️ ${item.name}: PARTIAL (Stok Kurang)\n`;
                    revBtns.push([Markup.button.callback(`✏️ EDIT: ${item.name}`, `rev_${orderId}_${i}`)]);
                } else {
                    msgLog += `✅ ${item.name}: SUKSES (Hunter)\n`;
                }

                items.push({ ...item, content: finalLines.join('\n') });
            }
        } catch (e) { 
            items.push(item); 
            allComplete = false;
            msgLog += `❌ Error System: ${e.message}\n`; 
        }
    }

    // --- FINALISASI STATUS ---
    let finalStatus = allComplete ? 'success' : (hasPartial ? 'processing' : 'pending');
    await db.collection('orders').doc(orderId).update({ items, status: finalStatus, processed: true });

    // Notifikasi ke Admin
    if (!allComplete) {
        revBtns.push([Markup.button.callback('⚡ PAKSA PROSES ULANG', `force_send_${orderId}`)]);
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ *ORDER ${orderId} BELUM LENGKAP*\nStatus: ${finalStatus}\n\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) });
    } else {
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\n\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🛠 MENU UTAMA', 'menu')]]) });
    }

    // Notifikasi ke User (Hanya kirim yang bersih)
    if (finalStatus !== 'pending') {
        let userMsg = `✅ *UPDATE PESANAN*\n🆔 Order: \`${orderId}\`\n\n`;
        items.forEach(it => {
            let clean = it.content.replace(/\[\.\.\.MENUNGGU.*?\]/g, '_(Sedang diproses / Menunggu Restock)_').replace('MULTI_API:', '');
            // Hapus config backup dari tampilan user
            clean = clean.replace(/AUTO_BACKUP:.*?(\n|$)/g, '');
            userMsg += `📦 *${it.name}*\n\`${clean}\`\n\n`;
        });
        userMsg += `_Terima kasih!_`;
        await notifyUser(orderData.buyerPhone, userMsg);
    }
};

// ==========================================
// 4. API WEBHOOKS (UNTUK FRONTEND/USER)
// ==========================================

// Webhook Order Masuk
app.post('/api/notify-order', async (req, res) => {
    const { orderId, buyerPhone, total, items, voucherCode, uid } = req.body;
    
    // Simpan Order Awal
    await db.collection('orders').doc(orderId).set({
        items, total, buyerPhone, uid: uid || null, voucherCode: voucherCode || null,
        status: 'pending', createdAt: new Date(), processed: false
    });

    bot.telegram.sendMessage(ADMIN_ID, `🔔 *ORDER BARU MASUK*\n🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}`);
    
    // Validasi Keamanan (Anti Cheat)
    const security = await validateOrderSecurity(orderId, {items, total, voucherCode});
    if(!security.isSafe) {
         await db.collection('orders').doc(orderId).update({status: 'FRAUD', adminReply: 'BANNED.'});
         bot.telegram.sendMessage(ADMIN_ID, `🚨 FRAUD DETECTED ON ${orderId}. Auto-Banned.`);
         return res.json({status: 'fraud'});
    }

    // Jalankan Proses
    const d = await db.collection('orders').doc(orderId).get();
    processOrderLogic(orderId, d.data());
    
    res.json({ status: 'ok' });
});

// Webhook Konfirmasi Manual
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    await bot.telegram.sendMessage(ADMIN_ID, 
        `🔔 *KONFIRMASI MANUAL*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}\n\n_Cek mutasi bank, lalu klik PROSES PAKSA._`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('⚡ PROSES PAKSA', `force_send_${orderId}`)],
            [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
        ])
    );
    res.json({ status: 'ok' });
});

app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    await db.collection('orders').doc(orderId).update({ complain: true, complainResolved: false, userComplainText: message });
    bot.telegram.sendMessage(ADMIN_ID, `🚨 *KOMPLAIN USER*\nID: ${orderId}\nMsg: "${message}"`, Markup.inlineKeyboard([
        [Markup.button.callback('📩 BALAS', `reply_comp_${orderId}`)]
    ]));
    res.json({status: 'ok'});
});

// ==========================================
// 5. BOT TELEGRAM HANDLERS (LOGIC ADMIN)
// ==========================================

// Middleware: Cek Admin
bot.use(async (ctx, next) => {
    if (ctx.from && String(ctx.from.id) !== ADMIN_ID) return;
    return next();
});

// --- MENU UTAMA ---
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('⏳ LIST PENDING', 'list_pending'), Markup.button.callback('📦 CEK GUDANG', 'list_all_stock')],
    [Markup.button.callback('📄 UPLOAD STOK', 'restock_sheet_ask')],
    [Markup.button.callback('👥 USER MANAGER', 'manage_users'), Markup.button.callback('💳 SET PAYMENT', 'set_payment')],
    [Markup.button.callback('🎨 GANTI BACKGROUND', 'set_bg')],
    [Markup.button.callback('💰 OMSET HARI INI', 'sales_today'), Markup.button.callback('📥 IMPORT DB', 'import_db_ask')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JIE STORE*", {parse_mode:'Markdown', ...mainMenu}));
bot.action('menu', (ctx) => ctx.reply("🛠 *PANEL ADMIN*", {parse_mode:'Markdown', ...mainMenu}));
bot.action('cancel_action', (ctx)=>{ delete adminSession[ctx.from.id]; ctx.reply("❌ Aksi dibatalkan.", mainMenu); });

// --- HANDLER TEXT & SESSION (WIZARD MODE) ---
bot.on(['text', 'photo', 'document'], async (ctx, next) => {
    const userId = ctx.from.id;
    const session = adminSession[userId];
    let text = ctx.message.text || "";
    
    // Handle File Document (Import DB / Restock Sheet)
    if (ctx.message.document) {
        if (!session) return ctx.reply("📂 File diterima.");
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const response = await axios.get(fileLink.href);

            if (session.type === 'IMPORT_DB') {
                const data = response.data;
                const batch = db.batch();
                for (const [col, items] of Object.entries(data)) {
                    if (Array.isArray(items)) items.forEach(item => batch.set(db.collection(col).doc(item.id), item));
                }
                await batch.commit();
                delete adminSession[userId];
                return ctx.reply("✅ Import Database Sukses!");
            }
            if (session.type === 'RESTOCK_SHEET') {
                const rawData = response.data;
                const stockArray = typeof rawData === 'string' ? rawData.split('\n').filter(s=>s.trim()) : [];
                if(stockArray.length === 0) return ctx.reply("File kosong.");
                // Kirim ke GAS
                try {
                    await axios.post(session.targetUrl, { data: stockArray });
                    delete adminSession[userId];
                    return ctx.reply(`✅ Sukses Upload ${stockArray.length} baris ke Sheet.`);
                } catch(e) { return ctx.reply("Gagal koneksi ke Script Google."); }
            }
        } catch(e) { return ctx.reply("Error File: " + e.message); }
    }

    // Handle Image Input (Background / Produk)
    if (ctx.message.photo) {
        text = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    }

    // --- COMMAND SHORTCUT ---
    if (text.toLowerCase() === 'menu') return ctx.reply("Menu:", mainMenu);
    if (text.toLowerCase() === 'help') return ctx.reply("Ketik: Voucher, Unban, atau ID Order/User untuk mencari.");
    
    if (text.toLowerCase() === 'voucher') {
        adminSession[userId] = { type: 'MAKE_VOUCHER', step: 'CODE' };
        return ctx.reply("🎫 Masukkan KODE VOUCHER:", cancelBtn);
    }

    // --- SESSION HANDLER ---
    if (session) {
        // [FIX MENU EDIT] - LOGIKA SMART FILL
        if (session.type === 'REVISI') {
            const { orderId, itemIdx } = session;
            const docRef = db.collection('orders').doc(orderId);
            const snap = await docRef.get();
            if (!snap.exists) return ctx.reply("Order hilang.");

            const data = snap.data();
            const item = data.items[itemIdx];
            
            // Logic Pengisian
            const inputLines = text.split('\n').filter(l => l.trim());
            let currentLines = item.content ? item.content.split('\n') : [];
            let filledCount = 0;

            // 1. Timpa Slot Kosong
            for (let i = 0; i < currentLines.length; i++) {
                if (currentLines[i].includes('MENUNGGU') && inputLines.length > 0) {
                    currentLines[i] = inputLines.shift();
                    filledCount++;
                }
            }
            // 2. Jika sisa, tambah di bawah
            if (inputLines.length > 0) {
                currentLines = [...currentLines, ...inputLines];
                filledCount += inputLines.length;
            }

            item.content = currentLines.join('\n');
            await docRef.update({ items: data.items });
            delete adminSession[userId];

            ctx.reply(`✅ Data Terupdate (${filledCount} slot diisi).\n🔄 Mengecek ulang status order...`);
            await processOrderLogic(orderId, data, false);
            return;
        }

        // Tambah Produk Baru
        if (session.type === 'ADD_PROD') {
            const d = session.data || {};
            if(session.step === 'NAME') { d.name = text; session.step='CODE'; ctx.reply("Kode Produk:", cancelBtn); }
            else if(session.step === 'CODE') { d.code = text; session.step='PRICE'; ctx.reply("Harga (Angka):", cancelBtn); }
            else if(session.step === 'PRICE') { d.price = parseInt(text); session.step='IMG'; ctx.reply("Gambar (File ID/URL):", cancelBtn); }
            else if(session.step === 'IMG') { d.image = text; d.sold=0; session.step='DESC'; ctx.reply("Deskripsi:", cancelBtn); }
            else if(session.step === 'DESC') { d.desc = text; session.step='CONTENT'; ctx.reply("Stok Awal (Ketik 'skip' jika kosong):", cancelBtn); }
            else if(session.step === 'CONTENT') { d.content = text==='skip'?'':text; session.step='PERM'; ctx.reply("Permanen? (ya/tidak):", cancelBtn); }
            else if(session.step === 'PERM') { 
                d.isPermanent = text.toLowerCase()==='ya'; 
                await db.collection('products').add({...d, createdAt: new Date()});
                delete adminSession[userId];
                ctx.reply("✅ Produk Disimpan!");
            }
            session.data = d;
            return;
        }

        // Tambah Voucher
        if (session.type === 'MAKE_VOUCHER') {
            if (session.step === 'CODE') {
                session.code = text.toUpperCase(); session.step = 'AMT';
                ctx.reply(`Kode: ${session.code}. Masukkan Nominal (Rp):`, cancelBtn);
            } else if (session.step === 'AMT') {
                await db.collection('vouchers').doc(session.code).set({ amount: parseInt(text), active: true });
                delete adminSession[userId];
                ctx.reply("✅ Voucher Aktif.");
            }
            return;
        }

        // Topup Saldo
        if (session.type === 'TOPUP') {
            await db.collection('users').doc(session.uid).update({ balance: admin.firestore.FieldValue.increment(parseInt(text)) });
            await notifyUser(session.uid, `💰 Saldo ditambahkan: Rp ${parseInt(text).toLocaleString()}`);
            delete adminSession[userId];
            ctx.reply("✅ Saldo Masuk.");
            return;
        }

        // Balas Komplain
        if (session.type === 'REPLY_COMP') {
            await db.collection('orders').doc(session.oid).update({ adminReply: text, complainResolved: true });
            const o = await db.collection('orders').doc(session.oid).get();
            await notifyUser(o.data().buyerPhone, `💬 Balasan Admin: "${text}"`);
            delete adminSession[userId];
            ctx.reply("Terkirim.");
            return;
        }

        // Restock via Sheet
        if (session.type === 'ASK_SHEET') {
            session.type = 'RESTOCK_SHEET'; session.targetUrl = text;
            ctx.reply("Sekarang kirim file .txt (Format: KODE|DATA)", cancelBtn);
            return;
        }
    }

    // --- GLOBAL SEARCH (ORDER / USER / PRODUCT) ---
    // 1. Cek Order
    try {
        const o = await db.collection('orders').doc(text).get();
        if(o.exists) {
            const d = o.data();
            return ctx.reply(`📦 *ORDER ${o.id}*\nUser: ${d.buyerPhone}\nStatus: ${d.status}`, {
                parse_mode:'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⚡ PAKSA PROSES', `force_send_${o.id}`)],
                    [Markup.button.callback('✏️ MENU EDIT', `menu_edit_ord_${o.id}`)]
                ])
            });
        }
    } catch(e){}

    // 2. Cek User (Email/UID)
    try {
        let u = await db.collection('users').where('email','==',text).get();
        if(u.empty) u = await db.collection('users').doc(text).get();
        else u = u.docs[0];

        if(u.exists || (u.docs && u.docs[0])) {
            const ud = u.exists ? u.data() : u.docs[0].data();
            const uid = u.exists ? u.id : u.docs[0].id;
            return ctx.reply(`👤 *USER*\nUID: ${uid}\nSaldo: ${ud.balance}`, Markup.inlineKeyboard([
                [Markup.button.callback('➕ ISI SALDO', `topup_${uid}`)],
                [Markup.button.callback('🚫 BAN USER', `ban_${uid}`)]
            ]));
        }
    } catch(e){}

    ctx.reply("🔍 Tidak ditemukan. Gunakan Menu.");
});

// ==========================================
// 6. ACTION HANDLERS (CALLBACK BUTTONS)
// ==========================================

// Navigasi
bot.action('add_prod', (ctx) => { adminSession[ctx.from.id] = {type:'ADD_PROD', step:'NAME'}; ctx.reply("Nama Produk:", cancelBtn); });
bot.action('restock_sheet_ask', (ctx) => { adminSession[ctx.from.id] = {type:'ASK_SHEET'}; ctx.reply("Kirim URL Script Google:", cancelBtn); });
bot.action('import_db_ask', (ctx) => { adminSession[ctx.from.id] = {type:'IMPORT_DB'}; ctx.reply("Kirim File JSON:", cancelBtn); });
bot.action('list_pending', async (ctx) => {
    const s = await db.collection('orders').where('status','==','pending').get();
    if(s.empty) return ctx.reply("Aman.");
    const btns = s.docs.map(d => [Markup.button.callback(`${d.id} (${d.data().total})`, `force_send_${d.id}`)]);
    ctx.reply("List Pending:", Markup.inlineKeyboard(btns));
});

// Aksi User
bot.action(/^topup_(.+)$/, (ctx) => { adminSession[ctx.from.id]={type:'TOPUP', uid:ctx.match[1]}; ctx.reply("Nominal:", cancelBtn); });
bot.action(/^ban_(.+)$/, async (ctx) => { await db.collection('users').doc(ctx.match[1]).delete(); ctx.reply("User dibanned."); });

// Aksi Order
bot.action(/^force_send_(.+)$/, async (ctx) => {
    ctx.reply("⏳ Memaksa proses...");
    const d = await db.collection('orders').doc(ctx.match[1]).get();
    if(d.exists) await processOrderLogic(ctx.match[1], d.data(), true); // FORCE = TRUE
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    const oid = ctx.match[1];
    await db.collection('orders').doc(oid).update({status:'failed'});
    const d = await db.collection('orders').doc(oid).get();
    notifyUser(d.data().buyerPhone, `❌ Order ${oid} Ditolak.`);
    ctx.reply("Order ditolak.");
});

// Aksi Komplain
bot.action(/^reply_comp_(.+)$/, (ctx) => { adminSession[ctx.from.id]={type:'REPLY_COMP', oid:ctx.match[1]}; ctx.reply("Isi balasan:", cancelBtn); });

// [PENTING] Menu Edit Order
bot.action(/^menu_edit_ord_(.+)$/, async (ctx) => {
    const oid = ctx.match[1];
    const d = await db.collection('orders').doc(oid).get();
    const items = d.data().items;
    let btns = items.map((it, idx) => [Markup.button.callback(`✏️ EDIT: ${it.name}`, `rev_${oid}_${idx}`)]);
    btns.push([Markup.button.callback('🔄 REFRESH STATUS', `force_send_${oid}`)]);
    ctx.reply("Pilih item:", Markup.inlineKeyboard(btns));
});

// [PENTING] Handler Tombol Revisi (Trigger Edit Mode)
bot.action(/^rev_(.+)_(.+)$/, async (ctx) => {
    const oid = ctx.match[1];
    const idx = parseInt(ctx.match[2]);
    const d = await db.collection('orders').doc(oid).get();
    const item = d.data().items[idx];

    let msg = `🔧 *EDIT: ${item.name}*\n\nData saat ini:\n\`${item.content}\`\n\n`;
    msg += `👉 **SILAKAN REPLY** pesan ini dengan data pengganti.\n`;
    msg += `Bot akan otomatis mengisi slot "MENUNGGU" dengan inputanmu.`;

    adminSession[ctx.from.id] = { type: 'REVISI', orderId: oid, itemIdx: idx };
    // Force Reply biar muncul keyboard
    ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: { force_reply: true } });
});

// Aksi Produk (List/Hapus) - Standar
bot.action('list_all_stock', async (ctx) => {
    const snap = await db.collection('products').get();
    let txt = "📦 **STOK GUDANG**\n";
    snap.forEach(d => {
        const p = d.data();
        txt += `\n🔹 ${p.name} (${p.code}) : ${p.isPermanent?'♾️': (p.content?p.content.split('\n').length:0)}`;
    });
    ctx.reply(txt.substring(0, 4000)); // Limit Telegram
});

// Jalankan Server
app.listen(PORT, () => {
    console.log(`Bot & Server Running on ${PORT}`);
    bot.launch();
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
