const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

const axios = require('axios');
const crypto = require('crypto');

// ==========================================
// KONFIGURASI KUNCI API (DARI ENV RAILWAY)
// ==========================================
const KEYS = {
    VIP: { id: process.env.VIP_ID, key: process.env.VIP_KEY },
    DIGI: { user: process.env.DIGI_USER, key: process.env.DIGI_KEY },
};

const ADMIN_ID = process.env.ADMIN_ID;
const VIP_ID = process.env.VIP_ID; 
const VIP_KEY = process.env.VIP_KEY;

// ==========================================
// FUNGSI PINTAR: DETEKSI CREDENTIALS DARI URL
// ==========================================
const getCredentialsByUrl = (url) => {
    const u = url.toLowerCase();
    if (u.includes('vip-reseller')) return { id: KEYS.VIP.id, key: KEYS.VIP.key, type: 'VIP' };
    if (u.includes('api-digi') || u.includes('digiflazz')) return { id: KEYS.DIGI.user, key: KEYS.DIGI.key, type: 'DIGI' };
    return null; 
};

// ==========================================
// FUNGSI TEMBAK API (UPDATED: SUPPORT GOOGLE SHEET RESPONSE)
// ==========================================
const beliGeneric = async (apiUrl, serviceCode, target) => {
    try {
        const creds = getCredentialsByUrl(apiUrl);
        
        // SKENARIO 1: API RESMI (VIP / DIGI)
        if (creds) {
            let payload = {};
            if (creds.type === 'VIP') {
                const sign = crypto.createHash('md5').update(creds.id + creds.key).digest("hex");
                payload = { key: creds.key, sign: sign, type: 'order', service: serviceCode, data_no: target };
            } 
            else if (creds.type === 'DIGI') {
                const sign = crypto.createHash('md5').update(creds.id + creds.key + "depo").digest("hex"); 
                payload = { username: creds.id, buyer_sku_code: serviceCode, customer_no: target, sign: sign };
            }
            else {
                const sign = crypto.createHash('md5').update(creds.id + creds.key).digest("hex");
                payload = { key: creds.key, sign: sign, service: serviceCode, target: target };
            }

            const response = await axios.post(apiUrl, payload);
            const res = response.data;

            if (res.result === true || (res.data && (res.data.status === 'Pending' || res.data.status === 'Success'))) {
                return { sukses: true, sn: res.data?.trx_id || res.data?.sn || "Diproses", msg: res.message || "Sukses" };
            } 
            else if (res.data && res.data.rc === '00') {
                 return { sukses: true, sn: res.data.sn, msg: "Sukses" };
            }
            return { sukses: false, msg: res.message || res.data?.message || "Gagal dari Pusat" };
        } 
        
        // SKENARIO 2: URL BEBAS / GRATISAN / GOOGLE SHEET (GET REQUEST)
        else {
            const separator = apiUrl.includes('?') ? '&' : '?';
            const fullUrl = `${apiUrl}${separator}service=${serviceCode}&target=${target}`;
            const response = await axios.get(fullUrl);
            const res = response.data;

            if (res) {
                // Handle Response Google Sheet
                if (typeof res === 'string') {
                    if (res.includes('STOK_HABIS')) return { sukses: false, msg: "Stok Habis di Sheet" };
                    if (res.includes('ERROR')) return { sukses: false, msg: "Error Script Google" };
                    if (res.length > 2) return { sukses: true, sn: res, msg: "Sukses" };
                }
                else if (typeof res === 'object') {
                    if (res.status === true || res.success === true || res.code === 200) {
                        return { sukses: true, sn: res.data || res.content || "Berhasil", msg: "Sukses" };
                    }
                }
            }
            return { sukses: false, msg: "Gagal ambil data URL Bebas" };
        }

    } catch (error) {
        console.error("API Error:", error.message);
        return { sukses: false, msg: `Error Jaringan: ${error.message}` };
    }
};

const cekSaldoVip = async () => {
    if (!VIP_ID || !VIP_KEY) return 0;
    try {
        const sign = crypto.createHash('md5').update(VIP_ID + VIP_KEY).digest("hex");
        const response = await axios.post('https://vip-reseller.co.id/api/profile', { key: VIP_KEY, sign: sign });
        return parseInt(response.data.data.balance) || 0;
    } catch (e) { return 0; }
};

// ==========================================
// 1. SETUP SERVER & CONFIG
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
} catch (error) { console.error("❌ Firebase Error:", error.message); }
const db = admin.firestore();

// --- TELEGRAM BOT SETUP ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const cancelBtn = Markup.inlineKeyboard([Markup.button.callback('❌ BATAL', 'cancel_action')]);

// 🛡️ SECURITY MIDDLEWARE
bot.use(async (ctx, next) => {
    if (ctx.from && String(ctx.from.id) !== process.env.ADMIN_ID) return;
    return next();
});

// ==========================================
// FUNGSI BANTUAN
// ==========================================
const notifyUser = async (targetId, message) => {
    if (!targetId || isNaN(targetId)) return; 
    try {
        await bot.telegram.sendMessage(targetId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.log(`⚠️ Gagal kirim notif ke user ${targetId}`);
    }
};

// ==========================================
// 2. SECURITY CHECK
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
        calculatedTotal += (realPrice * item.qty);
    }
    if (orderData.voucherCode) {
        const vRef = db.collection('vouchers').doc(orderData.voucherCode);
        const vSnap = await vRef.get();
        if (vSnap.exists && vSnap.data().active) calculatedTotal -= vSnap.data().amount;
    }
    calculatedTotal = Math.max(0, calculatedTotal);
    if (orderData.total < (calculatedTotal - 500)) return { isSafe: false, realTotal: calculatedTotal };
    return { isSafe: true };
};

// ==========================================
// 3. LOGIKA STOK (UPDATED: Support Force Hunter & Variasi)
// ==========================================
const processStock = async (productId, variantName, qtyNeeded, forceHunterMode = false) => {
    const docRef = db.collection('products').doc(productId);
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        const data = doc.data();
        let contentPool = "", isVariant = false, variantIndex = -1, isPermanent = false;

        // Cek Variasi
        if (variantName && data.variations) {
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

        let lines = contentPool.split('\n').filter(s => s.trim().length > 0);
        let backupConfig = lines.find(l => l.startsWith('AUTO_BACKUP:')); // Cari baris hunter

        // [LOGIKA FORCE]: Jika mode paksa, return stok 0 biar masuk ke hunter
        if (forceHunterMode) {
             return { 
                success: false, 
                currentStock: 0, 
                backupConfig: backupConfig ? backupConfig.replace('AUTO_BACKUP:', '').trim() : null 
            };
        }

        const currentSold = parseInt(data.sold) || 0;
        const inc = parseInt(qtyNeeded);

        // Jika Permanen Biasa (Tanpa Hunter)
        if (isPermanent && !contentPool.includes('AUTO_BACKUP:')) {
            t.update(docRef, { sold: currentSold + inc });
            return { success: true, data: contentPool, currentStock: 999999 }; 
        } else {
            // Logika Stok Manual
            let stocks = lines.filter(l => !l.startsWith('AUTO_BACKUP:'));

            if (stocks.length >= qtyNeeded) {
                const taken = stocks.slice(0, qtyNeeded); 
                const remaining = stocks.slice(qtyNeeded);
                if(backupConfig) remaining.push(backupConfig); // Keep config

                const finalContent = remaining.join('\n');
                if (isVariant) {
                    data.variations[variantIndex].content = finalContent;
                    t.update(docRef, { variations: data.variations, sold: currentSold + inc });
                } else {
                    t.update(docRef, { content: finalContent, sold: currentSold + inc });
                }
                return { success: true, data: taken.join('\n'), currentStock: stocks.length };
            } else {
                // Stok Kurang -> Trigger Hunter
                return { 
                    success: false, 
                    currentStock: stocks.length, 
                    backupConfig: backupConfig ? backupConfig.replace('AUTO_BACKUP:', '').trim() : null 
                };
            }
        }
    });
};

// ==========================================
// 4. LOGIKA ORDER (UPDATED: Fix Bug Qty & Sold Count)
// ==========================================
const processOrderLogic = async (orderId, orderData, forceHunter = false) => {
    let items = [], allComplete = true, msgLog = "", revBtns = [];

    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];
        
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

        // --- MODE 1: MURNI MULTI-API ---
        if (sourceContent.startsWith('MULTI_API:')) {
            const apiEntries = sourceContent.replace('MULTI_API:', '').split('#').filter(x => x.trim().length > 5);
            let providerList = apiEntries.map(entry => {
                const [url, sku, buyPrice] = entry.split('|');
                return { url: url?.trim(), sku: sku?.trim(), price: parseInt(buyPrice || 9999999) };
            });
            providerList.sort((a, b) => a.price - b.price);

            let successBuy = false; let finalSn = ""; let errMessage = "";
            for (const prov of providerList) {
                if(!prov.url) continue;
                const hasil = await beliGeneric(prov.url, prov.sku, orderData.buyerPhone);
                if (hasil.sukses) { successBuy = true; finalSn = hasil.sn; break; } 
                else { errMessage = hasil.msg; }
            }

            if (successBuy) {
                items.push({ ...item, content: `✅ SUKSES DIKIRIM!\nSN/TrxID: ${finalSn}` });
                msgLog += `✅ ${item.name}: AUTO SUCCESS (API)\n`;
                // UPDATE SOLD COUNT
                try { await db.collection('products').doc(item.id).update({ sold: admin.firestore.FieldValue.increment(parseInt(item.qty)) }); } catch(e){}
            } else {
                items.push({ ...item, content: `[...MENUNGGU PROSES ADMIN...]\n(Semua Jalur Gagal: ${errMessage})` });
                allComplete = false;
                msgLog += `❌ ${item.name}: GAGAL API\n`;
                revBtns.push([Markup.button.callback(`🔧 MANUAL: ${item.name}`, `rev_${orderId}_${i}`)]);
            }
            continue; 
        }

        // --- MODE 2: MANUAL + HUNTER + FORCE ---
        const isContentFull = item.content && !item.content.includes('[...MENUNGGU') && !item.content.includes('GAGAL');
        // Jika forceHunter = true, kita abaikan konten lama dan proses ulang
        if (isContentFull && !forceHunter) { items.push(item); msgLog += `✅ ${item.name}: OK\n`; continue; }

        let currentContentLines = item.content ? item.content.split('\n') : [];
        if (forceHunter) currentContentLines = []; // Reset jika dipaksa

        let validLines = currentContentLines.filter(l => !l.includes('[...MENUNGGU') && !l.includes('GAGAL'));
        let validLinesCount = validLines.length;
        let qtyButuh = item.qty - validLinesCount;
        if (qtyButuh <= 0) { items.push(item); continue; }

        try {
            // PANGGIL STOK (Dengan Parameter Force Hunter)
            const result = await processStock(item.id, item.variantName, qtyButuh, forceHunter);
            
            if (result && result.success) {
                // STOK MANUAL CUKUP
                let newContent = result.data;
                const finalContent = result.currentStock === 999999 ? newContent : [...validLines, ...newContent.split('\n')].join('\n');
                items.push({ ...item, content: finalContent });
                msgLog += `✅ ${item.name}: SUKSES (Gudang)\n`;

            } else if (result && !result.success) {
                // STOK KURANG -> HUNTER
                let stockFromDB = [];
                // Ambil sisa stok manual (jika ada & bukan force)
                if(result.currentStock > 0 && !forceHunter) {
                    const partialRes = await processStock(item.id, item.variantName, result.currentStock);
                    stockFromDB = partialRes.data.split('\n');
                }

                // FIX: Gabungkan semua sumber dengan benar
                const currentHave = (forceHunter ? 0 : validLinesCount) + stockFromDB.length;
                const stillNeed = item.qty - currentHave;
                
                let hunterContent = [];
                let hunterSuccessCount = 0;

                if (result.backupConfig && stillNeed > 0) {
                    const [url, sku] = result.backupConfig.split('|');
                    if (url && sku) {
                        console.log(`🤖 Hunter ${item.name}: Cari ${stillNeed} biji...`);
                        for(let k=0; k<stillNeed; k++) {
                            const hasil = await beliGeneric(url, sku, orderData.buyerPhone);
                            if(hasil.sukses) {
                                hunterContent.push(`${hasil.sn}`);
                                hunterSuccessCount++;
                            } else {
                                hunterContent.push(`[...MENUNGGU PROSES (Gagal Ambil: ${hasil.msg})...]`);
                            }
                        }
                    }
                }

                // UPDATE SOLD COUNT JIKA HUNTER BERHASIL
                if (hunterSuccessCount > 0) {
                    try { 
                        await db.collection('products').doc(item.id).update({ 
                            sold: admin.firestore.FieldValue.increment(hunterSuccessCount) 
                        }); 
                    } catch(e) {}
                }

                let prevLines = forceHunter ? [] : validLines;
                let finalLines = [...prevLines, ...stockFromDB, ...hunterContent];
                
                const totalSekarang = finalLines.length;
                const totalKurang = item.qty - totalSekarang;

                if (totalKurang > 0) {
                    for(let k=0; k<totalKurang; k++) finalLines.push(`[...MENUNGGU ${totalKurang} LAGI...]`);
                }

                // Cek apakah ada masalah?
                const hasProblem = finalLines.some(l => l.includes('MENUNGGU') || l.includes('GAGAL'));

                if (hasProblem) {
                    allComplete = false;
                    msgLog += `⚠️ ${item.name}: PARTIAL/GAGAL\n`;
                    // FIX: TOMBOL PASTI MUNCUL JIKA ADA MASALAH
                    revBtns.push([Markup.button.callback(`🔧 EDIT MANUAL: ${item.name}`, `rev_${orderId}_${i}`)]);
                } else {
                    msgLog += `✅ ${item.name}: SUKSES (Hunter)\n`;
                }

                items.push({ ...item, content: finalLines.join('\n') });
            }
        } catch (e) { items.push(item); allComplete = false; msgLog += `❌ ${item.name}: ERROR DB\n`; }
    }
    
    // PERBAIKAN: PAKSA STATUS SUCCESS
    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    if (!allComplete) {
        revBtns.push([Markup.button.callback('⚡ PROSES ULANG (PAKSA)', `force_send_${orderId}`)]);
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ *PERHATIAN: ORDER ${orderId} BELUM LENGKAP*\nWeb User sudah menampilkan status "Menunggu".\n\n${msgLog}\nSegera isi manual atau proses paksa!`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) });
    } else {
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🛠 MENU EDIT', `menu_edit_ord_${orderId}`)]]) });
    }

    let userMsg = `✅ *PESANAN SELESAI!*\n🆔 Order: \`${orderId}\`\n\n`;
    items.forEach(item => {
        let clean = item.content.replace('MULTI_API:', '').replace(/AUTO_BACKUP:.*?\|.*?\|.*?/g, ''); 
        let contentClean = clean.replace(/\[\.\.\.MENUNGGU.*?\]/g, '_(Sedang Diproses/Menunggu Pembayaran)_').replace(/\n/g, '\n'); 
        userMsg += `📦 *${item.name}*\n\`${contentClean}\`\n\n`;
    });
    userMsg += `_Terima kasih sudah belanja!_`;

    if (typeof notifyUser === 'function') {
        await notifyUser(orderData.buyerPhone, userMsg);
    }
};

// [BARU]: Fungsi Helper Force Fulfill
const forceFulfillOrder = async (orderId) => {
    try {
        const docRef = db.collection('orders').doc(orderId);
        const docSnap = await docRef.get();
        if (!docSnap.exists) return { success: false, msg: "Order 404" };
        
        // Panggil dengan parameter TRUE (Force Mode)
        await processOrderLogic(orderId, docSnap.data(), true);
        return { success: true, msg: "✅ Order dipaksa proses ulang ke Supplier/Sheet!" };
    } catch (e) { return { success: false, msg: "Err: " + e.message }; }
};

// ==========================================
// 3. API WEBHOOKS
// ==========================================
app.post('/api/confirm-manual', async (req, res) => {
    try {
        const { orderId, buyerPhone, total, items } = req.body;
        let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
        
        // [UPDATE]: Tombol Force Send
        await bot.telegram.sendMessage(ADMIN_ID, 
            `🔔 *ORDER MASUK (MANUAL)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}\n\n_Klik PAKSA KIRIM jika uang sudah masuk._`, 
            Markup.inlineKeyboard([
                [Markup.button.callback('⚡ PROSES PAKSA (KIRIM)', `force_send_${orderId}`)],
                [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ])
        );
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 🔥 WEBHOOK KOMPLAIN DENGAN AUTO REPLY (AI STYLE 3 DETIK)
app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    await db.collection('orders').doc(orderId).update({ complain: true, complainResolved: false, userComplainText: message });
    
    bot.telegram.sendMessage(ADMIN_ID, `🚨 *KOMPLAIN!* 🚨\n🆔 \`${orderId}\`\n💬 "${message}"`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📩 BALAS', `reply_comp_${orderId}`), Markup.button.callback('✅ SELESAI', `solve_${orderId}`)]]) });

    // AUTO REPLY
    const orderRef = await db.collection('orders').doc(orderId).get();
    if(orderRef.exists) {
        const data = orderRef.data();
        setTimeout(async () => {
            await notifyUser(data.buyerPhone, 
                `👋 *Halo Kak!*\n\nLaporan komplain untuk Order \`${orderId}\` sudah kami terima.\n\n🤖 _"Sistem sedang meneruskan pesan kakak ke Admin. Mohon tunggu sebentar ya, Admin akan segera mengecek dan membalas pesan ini."_\n\nTerima kasih sudah bersabar! 🙏`
            );
        }, 3000); 
    }
    res.json({ status: 'ok' });
});

app.post('/api/notify-order', async (req, res) => {
    const { orderId, buyerPhone, total, items, voucherCode } = req.body; 
    const docRef = db.collection('orders').doc(orderId);
    const docSnap = await docRef.get();
    
    if (docSnap.exists) {
        const orderData = docSnap.data();
        const security = await validateOrderSecurity(orderId, orderData);
        
        if (!security.isSafe) {
            await docRef.update({ status: 'FRAUD', adminReply: 'BANNED: CHEATING.' });
            
            if (orderData.uid) {
                const userRef = db.collection('users').doc(orderData.uid);
                const userSnap = await userRef.get();
                if (userSnap.exists) {
                    await db.collection('banned_users').doc(orderData.uid).set({
                        ...userSnap.data(),
                        bannedAt: new Date(),
                        reason: `Fraud Order ${orderId}`,
                        lastBalance: userSnap.data().balance || 0
                    });
                    await userRef.delete(); 
                }
            }
            
            await bot.telegram.sendMessage(ADMIN_ID, `🚨 *MALING DITANGKAP!* \nOrder: \`${orderId}\` \nUser: ${buyerPhone}\nUID: \`${orderData.uid}\`\n\n🛡 *Tindakan:* User dipindah ke BANNED LIST (Saldo Aman).`);
            return res.json({ status: 'fraud' });
        }
        
        let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
        await bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER LUNAS (SALDO)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, { parse_mode: 'Markdown' });
        await processOrderLogic(orderId, orderData);
    }
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('JSN-02 READY'));

// ==========================================
// 4. BOT BRAIN (UNIVERSAL SEARCH)
// ==========================================
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('⏳ LIST PENDING', 'list_pending'), Markup.button.callback('📦 CEK SEMUA STOK', 'list_all_stock')],
    [Markup.button.callback('📄 ISI STOK (UPLOAD)', 'restock_sheet_ask')], // [UPDATE] TOMBOL BARU
    [Markup.button.callback('👥 PANDUAN USER', 'manage_users'), Markup.button.callback('💳 PAYMENT', 'set_payment')],
    [Markup.button.callback('🎨 GANTI BACKGROUND', 'set_bg')],
    [Markup.button.callback('💰 SALES', 'sales_today'), Markup.button.callback('🚨 KOMPLAIN', 'list_complain')],
    [Markup.button.callback('📂 BACKUP DB', 'backup_db'), Markup.button.callback('📥 IMPORT DB', 'import_db_ask')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN*\nKetik 'help' untuk bantuan.\nKetik APAPUN untuk mencari.", mainMenu));

// ==========================================
// 4. BOT BRAIN (OTAK BOT - VERSI BARU)
// ==========================================
bot.on(['text', 'photo', 'document'], async (ctx, next) => {
    // 1. Cek apakah yang chat adalah ADMIN
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    
    // 2. Ambil teks pesan
    let text = "";
    // LOGIKA IMPORT DB & UPLOAD STOK SHEET
    if (ctx.message.document) {
        try { 
            const session = adminSession[ctx.from.id];
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const response = await axios.get(fileLink.href);

            if (session && session.type === 'IMPORT_DB') {
                ctx.reply("⏳ Sedang memproses file backup...");
                const data = response.data;
                if (!data || typeof data !== 'object') throw new Error("Format JSON salah.");
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
                return ctx.reply("✅ **IMPORT SUKSES!**\nSemua data telah dikembalikan.");
            } 
            // [UPDATE]: LOGIKA UPLOAD STOK KE GOOGLE SHEET
            else if (session && session.type === 'RESTOCK_SHEET') {
                ctx.reply("⏳ Membaca file & Upload ke Sheet...");
                const rawData = response.data; 
                let stockArray = [];
                if (typeof rawData === 'string') {
                    stockArray = rawData.split('\n').map(s => s.trim()).filter(s => s.length > 0);
                }
                if (stockArray.length === 0) return ctx.reply("❌ File kosong atau bukan text.");

                try {
                    const resGoogle = await axios.post(session.targetUrl, { data: stockArray }, { headers: { 'Content-Type': 'application/json' } });
                    if (String(resGoogle.data).includes('BERHASIL')) {
                        delete adminSession[ctx.from.id];
                        return ctx.reply(`✅ **SUKSES UPLOAD!**\n\n📊 Total: ${stockArray.length} baris\n📥 Masuk ke Google Sheet.`);
                    } else { return ctx.reply(`⚠️ Gagal Script: ${resGoogle.data}`); }
                } catch(err) { return ctx.reply("❌ Gagal Tembak Script: " + err.message); }
            }
            else {
                ctx.reply("📂 File diterima (Tapi tidak sedang dalam mode Import/Restock).");
            }
        } catch(e) { return ctx.reply("❌ Gagal Baca File: " + e.message); }
    } else if (ctx.message.photo) {
        text = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else {
        text = ctx.message.text ? ctx.message.text.trim() : '';
    }

    const textLower = text.toLowerCase();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    if (textLower === 'help' || textLower === 'bantuan') {
        const msg = `📘 **PANDUAN ADMIN**\n\nKetik kata kunci:\n\n🔹 **MENU** - Buka menu utama.\n🔹 **VOUCHER** - Buat kode diskon.\n🔹 **UNBAN** - Unban user.\n🔹 **PENCARIAN** - Ketik langsung Nama Produk, Email, atau ID Order.`;
        return ctx.reply(msg, {parse_mode: 'Markdown'});
    }

    if (textLower === 'menu' || textLower === 'admin') {
        return ctx.reply("🛠 *PANEL ADMIN*", mainMenu);
    }

    if (textLower === 'voucher') {
        adminSession[userId] = { type: 'MAKE_VOUCHER', step: 'CODE', data: {} };
        return ctx.reply("🎫 **BUAT VOUCHER BARU**\n\nSilakan ketik KODE VOUCHER yang diinginkan (Misal: PROMO10K):", cancelBtn);
    }

    if (textLower === 'unban') {
        adminSession[userId] = { type: 'DO_UNBAN', step: 'UID' };
        return ctx.reply("🔓 **UNBAN USER**\n\nSilakan kirim/paste **UID USER** yang mau dibebaskan:", cancelBtn);
    }
    
    if (text.startsWith('/delvoucher ')) {
        const parts = text.split(' ');
        if (parts.length > 1) {
            const code = parts[1].toUpperCase();
            await db.collection('vouchers').doc(code).delete();
            return ctx.reply(`🗑 Voucher \`${code}\` berhasil dihapus.`);
        } else {
            return ctx.reply("❌ Format salah. Ketik: `/delvoucher KODE`");
        }
    }

    if (session) {
        // [UPDATE] SESI UPLOAD STOK
        if (session.type === 'ASK_SHEET_URL') {
            if (!text.includes('script.google.com')) return ctx.reply("❌ URL Salah. Harus link Google Script.", cancelBtn);
            session.type = 'RESTOCK_SHEET'; session.targetUrl = text;
            ctx.reply("📂 Oke. Sekarang **Kirim File .txt** (Format: KODE|DATA).", cancelBtn); return;
        }

        // --- FITUR BARU: ADD VARIATION TO EXISTING PRODUCT ---
        else if (session.type === 'ADD_VAR_EXISTING') {
            const prodRef = db.collection('products').doc(session.prodId);
            const docSnap = await prodRef.get();
            const prodData = docSnap.data();
            let variations = prodData.variations || [];

            if (session.step === 'NAME') { session.tempVar = { name: text, apiList: [] }; session.step = 'CODE'; ctx.reply("Kode Variasi:", cancelBtn); }
            else if (session.step === 'CODE') { session.tempVar.code = text; session.step = 'PRICE'; ctx.reply("Harga Variasi:", cancelBtn); }
            else if (session.step === 'PRICE') { session.tempVar.price = parseInt(text); session.step = 'ASK_API'; ctx.reply("Pakai API? (ya/tidak)", cancelBtn); }
            else if (session.step === 'ASK_API') {
                if (text.toLowerCase() === 'ya') { session.step = 'INPUT_API'; ctx.reply("Format: `URL|KODE|MODAL`", cancelBtn); } else { session.step = 'CONTENT'; ctx.reply("Stok Manual (Bisa + AUTO_BACKUP:):", cancelBtn); }
            }
            else if (session.step === 'INPUT_API') {
                if(text.includes('|')) {
                    session.tempVar.apiList.push(text);
                    session.tempVar.content = 'MULTI_API:' + session.tempVar.apiList.join('#');
                    session.tempVar.isPermanent = true;
                    variations.push(session.tempVar);
                    await prodRef.update({ variations });
                    delete adminSession[userId];
                    ctx.reply("✅ Variasi API Ditambahkan!");
                } else { ctx.reply("Format Salah.", cancelBtn); }
            }
            else if (session.step === 'CONTENT') { session.tempVar.content = text; session.step = 'PERM'; ctx.reply("Permanen? (ya/tidak)", cancelBtn); }
            else if (session.step === 'PERM') {
                session.tempVar.isPermanent = text.toLowerCase() === 'ya';
                variations.push(session.tempVar);
                await prodRef.update({ variations });
                delete adminSession[userId];
                ctx.reply("✅ Variasi Manual Ditambahkan!");
            }
            return;
        }

        else if (session.type === 'MAKE_VOUCHER') {
            if (session.step === 'CODE') { session.data.code = text.toUpperCase().replace(/\s/g, ''); session.step = 'AMOUNT'; ctx.reply("Nominal:", cancelBtn); } 
            else if (session.step === 'AMOUNT') {
                const amount = parseInt(text);
                if (isNaN(amount)) return ctx.reply("⚠️ Harap masukkan angka saja!", cancelBtn);
                await db.collection('vouchers').doc(session.data.code).set({ amount: amount, active: true, createdAt: new Date() });
                delete adminSession[userId];
                return ctx.reply(`🎉 **SUKSES!**\n\nVoucher \`${session.data.code}\` berhasil dibuat.\nNilai: Rp ${amount.toLocaleString()}`);
            }
        }

        else if (session.type === 'DO_UNBAN') {
            const targetUid = text.trim(); const jailRef = db.collection('banned_users').doc(targetUid); const jailSnap = await jailRef.get();
            if (jailSnap.exists) {
                const savedData = jailSnap.data();
                await db.collection('users').doc(targetUid).set({ ...savedData, restoredAt: new Date() });
                await jailRef.delete();
                delete adminSession[userId];
                return ctx.reply(`✅ **USER DI-UNBAN!**\nUID: \`${targetUid}\``);
            } else { return ctx.reply("❌ User tidak ditemukan.", cancelBtn); }
        }

        // [FIX]: LOGIKA REVISI LEBIH CERDAS (MENIMPA "MENUNGGU")
        else if (session.type === 'REVISI') {
            if (!isNaN(text) && parseInt(text) > 0 && text.length < 5) {
                session.targetLine = parseInt(text) - 1; session.type = 'REVISI_LINE_INPUT'; ctx.reply(`🔧 Kirim data baru baris #${text}:`, cancelBtn);
            } else {
                const d = await db.collection('orders').doc(session.orderId).get(); const data = d.data(); const item = data.items[session.itemIdx];
                if(text.includes('|') && text.includes('http')) { item.content = 'MULTI_API:' + text; ctx.reply("✅ Diubah menjadi Format API."); } 
                else {
                    let ex = item.content?item.content.split('\n'):[]; let inp = text.split('\n').filter(x=>x.trim());
                    let fill=0; let newC=[...ex];
                    
                    // Loop cari slot kosong/menunggu/gagal
                    for(let i=0;i<newC.length;i++){ 
                        if((newC[i].includes('MENUNGGU') || newC[i].includes('GAGAL')) && inp.length>0){
                            newC[i]=inp.shift(); fill++;
                        } 
                    }
                    
                    // Jika masih ada sisa input, atau data lama bersih, timpa/tambah
                    if (inp.length > 0) {
                        item.content = text; 
                        ctx.reply("✅ Data Ditimpa Full (Manual).");
                    } else {
                        item.content = newC.join('\n'); 
                        ctx.reply("✅ Slot Kosong Terisi.");
                    }
                }
                await db.collection('orders').doc(session.orderId).update({ items: data.items }); delete adminSession[userId]; processOrderLogic(session.orderId, data);
            }
            return;
        }
        else if (session.type === 'REVISI_LINE_INPUT') {
            const d = await db.collection('orders').doc(session.orderId).get(); const data = d.data(); const item = data.items[session.itemIdx];
            let lines = item.content?item.content.split('\n'):[];
            if(session.targetLine >= lines.length) lines[session.targetLine] = text; else lines[session.targetLine] = text;
            item.content=lines.join('\n'); await db.collection('orders').doc(session.orderId).update({items:data.items}); delete adminSession[userId]; ctx.reply("✅ Updated."); return;
        }
        else if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("🏷 Kode Produk:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("💰 Harga:", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("🖼 Gambar/URL (Multi pisah koma/enter):", cancelBtn); }
            else if (session.step === 'IMG') { const raw = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : text; d.images = raw.split(/[\n,]+/).map(s => s.trim()).filter(s => s.length > 0); d.image = d.images[0] || ""; d.sold=0; d.view=0; session.step='STATS'; d.apiList = []; session.step = 'ASK_IF_API'; ctx.reply("🔗 Produk Utama pakai API? (ya/tidak)", cancelBtn); }
            else if (session.step === 'ASK_IF_API') {
                if(text.toLowerCase() === 'ya') { session.step = 'INPUT_API_DATA'; ctx.reply("Format: URL|KODE|MODAL", cancelBtn); } else { if (d.apiList.length > 0) { d.content = 'MULTI_API:' + d.apiList.join('#'); d.isPermanent = true; session.step = 'DESC'; ctx.reply("Deskripsi:", cancelBtn); } else { session.step = 'STATS'; ctx.reply("Sold View:", cancelBtn); } }
            }
            else if (session.step === 'INPUT_API_DATA') { d.apiList.push(text); session.step = 'ASK_IF_API'; ctx.reply("API Lain? (ya/tidak)", cancelBtn); }
            else if (session.step === 'STATS') { const [s,v] = text.split(' '); d.sold=parseInt(s)||0; d.view=parseInt(v)||0; session.step='DESC'; ctx.reply("Deskripsi:", cancelBtn); }
            else if (session.step === 'DESC') { d.desc = text; if(d.apiList.length > 0) { await db.collection('products').add({...d, createdAt:new Date()}); delete adminSession[userId]; ctx.reply("✅ Saved."); } else { session.step = 'CONTENT'; ctx.reply("Stok Manual (Bisa + AUTO_BACKUP:):", cancelBtn); } }
            else if (session.step === 'CONTENT') { d.content = text==='skip'?'':text; if(d.content){ session.step='IS_PERM'; ctx.reply("Permanen? (ya/tidak)", cancelBtn); } else { session.step='VARS'; ctx.reply("Variasi? (ya/tidak)", cancelBtn); } }
            else if (session.step === 'IS_PERM') { d.isPermanent = text.toLowerCase() === 'ya'; session.step = 'VARS'; ctx.reply("Variasi? (ya/tidak)", cancelBtn); }
            else if (session.step === 'VARS') { if(text.toLowerCase()==='ya'){ session.step='VAR_NAME'; ctx.reply("Nama Variasi:", cancelBtn); } else { await db.collection('products').add({...d, createdAt:new Date()}); delete adminSession[userId]; ctx.reply("✅ Saved."); } }
            else if (session.step === 'VAR_NAME') { if(!d.variations)d.variations=[]; session.tempVar={name:text, apiList:[]}; session.step='VAR_CODE'; ctx.reply("Kode Var:", cancelBtn); }
            else if (session.step === 'VAR_CODE') { session.tempVar.code=text; session.step='VAR_PRICE'; ctx.reply("Harga Var:", cancelBtn); }
            else if (session.step === 'VAR_PRICE') { session.tempVar.price=parseInt(text); session.step='VAR_ASK_API'; ctx.reply("API Var? (ya/tidak)", cancelBtn); }
            else if (session.step === 'VAR_ASK_API') { if(text.toLowerCase()==='ya'){ session.step='VAR_INPUT_API'; ctx.reply("Format API:", cancelBtn); } else { if(session.tempVar.apiList.length>0) { session.tempVar.content = 'MULTI_API:' + session.tempVar.apiList.join('#'); session.tempVar.isPermanent = true; d.variations.push(session.tempVar); session.step='VARS'; ctx.reply("Var Lain? (ya/tidak)", cancelBtn); } else { session.step='VAR_CONTENT'; ctx.reply("Stok Manual:", cancelBtn); } } }
            else if (session.step === 'VAR_INPUT_API') { session.tempVar.apiList.push(text); session.step='VAR_ASK_API'; ctx.reply("API Lain? (ya/tidak)", cancelBtn); }
            else if (session.step === 'VAR_CONTENT') { session.tempVar.content=text; session.step='VAR_PERM'; ctx.reply("Permanen? (ya/tidak)", cancelBtn); }
            else if (session.step === 'VAR_PERM') { session.tempVar.isPermanent = text.toLowerCase()==='ya'; d.variations.push(session.tempVar); session.step='VARS'; ctx.reply("Var Lain? (ya/tidak)", cancelBtn); }
            return;
        }
        else if (session.type === 'TOPUP_USER') { await db.collection('users').doc(session.targetUid).update({balance:admin.firestore.FieldValue.increment(parseInt(text))}); await notifyUser(session.targetUid, `💰 *SALDO MASUK*\nRp ${parseInt(text).toLocaleString()}`); delete adminSession[userId]; ctx.reply("Done."); return; }
        else if (session.type === 'DEDUCT_USER') { await db.collection('users').doc(session.targetUid).update({balance:admin.firestore.FieldValue.increment(-parseInt(text))}); delete adminSession[userId]; ctx.reply("Done."); return; }
        else if (session.type === 'SET_PAYMENT') {
            if(session.step === 'BANK') { session.data.bank=text; session.step='NO'; ctx.reply("Nomor:", cancelBtn); }
            else if(session.step === 'NO') { session.data.no=text; session.step='AN'; ctx.reply("Atas Nama:", cancelBtn); }
            else if(session.step === 'AN') { session.data.an=text; session.step='QR'; ctx.reply("QRIS:", cancelBtn); }
            else if(session.step === 'QR') { await db.collection('settings').doc('payment').set({info:`🏦 ${session.data.bank}\n🔢 ${session.data.no}\n👤 ${session.data.an}`, qris: text==='skip'?'':text}); delete adminSession[userId]; ctx.reply("✅ Saved."); }
            return;
        }
        else if (session.type === 'SET_BG') { const raw = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : text; const urls = raw.split(/[\n,]+/).map(u=>u.trim()).filter(u=>u); await db.collection('settings').doc('layout').set({ backgroundUrls: urls }, { merge: true }); delete adminSession[userId]; ctx.reply(`✅ Updated.`); return; }
        else if (session.type === 'EDIT_MAIN') { if (session.field === 'images') { const urls = text.split(/[\n,]+/).map(u=>u.trim()).filter(u=>u); await db.collection('products').doc(session.prodId).update({ images: urls, image: urls[0] || "" }); } else { await db.collection('products').doc(session.prodId).update({[session.field]:parseInt(text)||text}); } delete adminSession[userId]; ctx.reply("Updated."); return; }
        else if (session.type === 'EDIT_VAR') { const ref=db.collection('products').doc(session.prodId); const s=await ref.get(); let v=s.data().variations; v[session.varIdx][session.field]=parseInt(text)||text; await ref.update({variations:v}); delete adminSession[userId]; ctx.reply("Updated."); return; }
        
        // --- BALAS KOMPLAIN ---
        else if (session.type === 'REPLY_COMPLAIN') { 
            await db.collection('orders').doc(session.orderId).update({adminReply:text, complainResolved:true}); 
            // Notif Balik
            const orderSnap = await db.collection('orders').doc(session.orderId).get();
            if(orderSnap.exists) {
                await notifyUser(orderSnap.data().buyerPhone, 
                    `🔔 *UPDATE KOMPLAIN*\nOrder: \`${session.orderId}\`\n\n💬 *Pesan Admin:*\n"${text}"\n\n_Terima kasih telah menunggu. 🙏_`);
            }
            delete adminSession[userId]; ctx.reply("Sent."); return; 
        }
    }

    if (text) {
        ctx.reply("🔍...");
        try {
            const orderSnap = await db.collection('orders').doc(text).get();
            // [FIX]: Tombol Force Send saat cari order
            if (orderSnap.exists) { 
                const o = orderSnap.data(); 
                return ctx.reply(
                    `📦 *ORDER ${orderSnap.id}*\nStatus: ${o.status}\nItems: ${o.items.length}\nUser: ${o.buyerPhone}`, 
                    {
                        parse_mode:'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('⚡ PROSES DATA (REVISI OTOMATIS)', `force_send_${orderSnap.id}`)],
                            [Markup.button.callback('🛠 MENU EDIT', `menu_edit_ord_${orderSnap.id}`)],
                            [Markup.button.callback('🗑 HAPUS', `del_order_${orderSnap.id}`)]
                        ])
                    }
                ); 
            }
        } catch(e){}
        try {
            const allProds = await db.collection('products').get(); let found = null;
            allProds.forEach(doc => { const p = doc.data(); if (p.name.toLowerCase().includes(textLower)) found = { id: doc.id, ...p }; });
            if (found) return ctx.reply(`🔎 *${found.name}*`, Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit', `menu_edit_main_${found.id}`)],[Markup.button.callback('🔀 Var', `menu_vars_${found.id}`)],[Markup.button.callback('🗑️ Del', `del_prod_${found.id}`)]]));
        } catch(e){}
        try {
            let userSnap = await db.collection('users').where('email', '==', text.trim()).get();
            if (userSnap.empty) userSnap = await db.collection('users').doc(text.trim()).get();
            if (userSnap.exists || !userSnap.empty) { const u = userSnap.exists ? userSnap.data() : userSnap.docs[0].data(); const uid = userSnap.exists ? userSnap.id : userSnap.docs[0].id; return ctx.reply(`👤 ${u.name}\n💰 ${u.balance}`, Markup.inlineKeyboard([[Markup.button.callback('Topup', `topup_${uid}`)],[Markup.button.callback('Potong', `deduct_${uid}`)]])); }
        } catch(e){}
        ctx.reply("❌ 404");
    }
});

// ACTIONS
bot.action('restock_sheet_ask', (ctx) => { adminSession[ctx.from.id] = { type: 'ASK_SHEET_URL' }; ctx.reply("🔗 Kirim URL Google Apps Script:", cancelBtn); });
bot.action('list_pending', async (ctx) => { const s = await db.collection('orders').where('status', '==', 'pending').get(); if (s.empty) return ctx.reply("Aman."); const btns = s.docs.map(d => [Markup.button.callback(`🆔 ${d.id.slice(0,5)}...`, `acc_${d.id}`)]); ctx.reply("PENDING:", Markup.inlineKeyboard(btns)); });
bot.action('list_all_stock', async (ctx) => { ctx.reply("Mendata..."); const snap = await db.collection('products').get(); let msg = ""; snap.forEach(doc => { const p = doc.data(); msg += `• ${p.name} (${p.variations?p.variations.length+' var':(p.content?p.content.split('\n').length:0)})\n`; }); ctx.reply(msg || "Kosong."); });
bot.action('set_bg', (ctx) => { adminSession[ctx.from.id] = { type: 'SET_BG' }; ctx.reply("Kirim URL/Gambar (Multi):", cancelBtn); });
bot.action('manage_users', (ctx) => ctx.reply("Ketik Email/UID user."));
bot.action(/^topup_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'TOPUP_USER', targetUid:ctx.match[1]}; ctx.reply("Nominal:", cancelBtn); });
bot.action(/^deduct_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'DEDUCT_USER', targetUid:ctx.match[1]}; ctx.reply("Nominal:", cancelBtn); });
bot.action(/^ban_user_(.+)$/, async (ctx)=>{ await db.collection('users').doc(ctx.match[1]).delete(); ctx.editMessageText("Banned."); });
bot.action('sales_today', async (ctx)=>{ try { const now=new Date(); const start=new Date(now.getFullYear(),now.getMonth(),now.getDate()); const s=await db.collection('orders').orderBy('createdAt','desc').limit(200).get(); let t=0,c=0; s.forEach(d=>{const dt=d.data(); if(dt.status==='success' && (dt.createdAt.toDate?dt.createdAt.toDate():new Date(dt.createdAt))>=start){t+=dt.total;c++;}}); ctx.reply(`💰 Omset: ${t.toLocaleString()}\nTrx: ${c}`); } catch(e){ctx.reply("Err");} }); 
bot.action(/^acc_(.+)$/, async (ctx) => { ctx.reply("Proses..."); const d = await db.collection('orders').doc(ctx.match[1]).get(); if(d.exists) processOrderLogic(ctx.match[1], d.data()); });
bot.action(/^tolak_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({status:'failed'}); ctx.editMessageText("Ditolak."); });
bot.action('list_complain', async (ctx)=>{ const s=await db.collection('orders').where('complain','==',true).where('complainResolved','==',false).get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.id.slice(0,5),`view_comp_${d.id}`)]); ctx.reply("Komplain",Markup.inlineKeyboard(b)); });
bot.action(/^view_comp_(.+)$/, async (ctx)=>{ const d = await db.collection('orders').doc(ctx.match[1]).get(); ctx.reply(`Msg: ${d.data().userComplainText}`, Markup.inlineKeyboard([[Markup.button.callback('BALAS', `reply_comp_${d.id}`), Markup.button.callback('SELESAI', `solve_${d.id}`)]])); });
bot.action(/^reply_comp_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'REPLY_COMPLAIN', orderId:ctx.match[1]}; ctx.reply("Balasan:", cancelBtn); });
bot.action(/^solve_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({complainResolved:true}); ctx.editMessageText("Done."); });
bot.action(/^back_prod_(.+)$/, async (ctx) => { const d = await db.collection('products').doc(ctx.match[1]).get(); ctx.editMessageText(`🔎 *${d.data().name}*`, Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit', `menu_edit_main_${d.id}`)],[Markup.button.callback('🔀 Var', `menu_vars_${d.id}`)],[Markup.button.callback('🗑️ Del', `del_prod_${d.id}`)]])); });
bot.action(/^del_prod_(.+)$/, async (ctx)=>{ await db.collection('products').doc(ctx.match[1]).delete(); ctx.editMessageText("Deleted."); });
bot.action(/^del_order_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).delete(); ctx.editMessageText("Deleted."); });
bot.action('cancel_action', (ctx)=>{ delete adminSession[ctx.from.id]; ctx.reply("Batal."); });
bot.action('add_prod', (ctx)=>{ adminSession[ctx.from.id]={type:'ADD_PROD', step:'NAME', data:{}}; ctx.reply("Nama:", cancelBtn); });
bot.action('set_payment', (ctx)=>{ adminSession[ctx.from.id]={type:'SET_PAYMENT', step:'BANK', data:{}}; ctx.reply("Bank:", cancelBtn); });
bot.action(/^menu_edit_main_(.+)$/, (ctx) => { const pid = ctx.match[1]; ctx.editMessageText("✏️ *EDIT*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ [Markup.button.callback('Nama', `ed_main_name_${pid}`), Markup.button.callback('Harga', `ed_main_price_${pid}`)], [Markup.button.callback('Kode', `ed_main_code_${pid}`), Markup.button.callback('Stok', `ed_main_content_${pid}`)], [Markup.button.callback('Fake Sold', `ed_main_sold_${pid}`), Markup.button.callback('Fake View', `ed_main_view_${pid}`)], [Markup.button.callback('🖼 Gambar (Multi)', `ed_main_images_${pid}`)], [Markup.button.callback('🔙', `back_prod_${pid}`)] ])}); });
bot.action(/^ed_main_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_MAIN', prodId: ctx.match[2], field: ctx.match[1] }; ctx.reply(`Nilai Baru:`, cancelBtn); });
bot.action(/^menu_vars_(.+)$/, async (ctx) => { const pid = ctx.match[1]; const d = await db.collection('products').doc(pid).get(); const vars = d.data().variations || []; const btns = vars.map((v, i) => [Markup.button.callback(`${v.name}`, `sel_var_${pid}_${i}`)]); btns.push([Markup.button.callback('➕ TAMBAH VARIASI', `add_var_${pid}`)]); btns.push([Markup.button.callback('🔙', `back_prod_${pid}`)]); ctx.editMessageText("🔀 *VARIASI:*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) }); });
bot.action(/^add_var_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'ADD_VAR_EXISTING', prodId: ctx.match[1], step: 'NAME' }; ctx.reply("Nama Variasi Baru:", cancelBtn); });
bot.action(/^sel_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const d = await db.collection('products').doc(pid).get(); const v = d.data().variations[idx]; ctx.editMessageText(`🔀 ${v.name}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ [Markup.button.callback('Nama', `ed_var_name_${pid}_${idx}`), Markup.button.callback('Harga', `ed_var_price_${pid}_${idx}`)], [Markup.button.callback('Stok', `ed_var_content_${pid}_${idx}`)], [Markup.button.callback('🗑️', `del_var_${pid}_${idx}`), Markup.button.callback('🔙', `menu_vars_${pid}`)] ])}); });
bot.action(/^ed_var_(.+)_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_VAR', prodId: ctx.match[2], varIdx: parseInt(ctx.match[3]), field: ctx.match[1] }; ctx.reply(`Nilai Baru:`, cancelBtn); });
bot.action(/^del_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const ref = db.collection('products').doc(pid); const s = await ref.get(); let v = s.data().variations; v.splice(parseInt(idx), 1); await ref.update({ variations: v }); ctx.reply("Deleted."); });
bot.action(/^menu_edit_ord_(.+)$/, async (ctx) => { const oid = ctx.match[1]; const doc = await db.collection('orders').doc(oid).get(); const items = doc.data().items; 
    let btns = items.map((item, idx) => [Markup.button.callback(`✏️ ${item.name}`, `rev_${oid}_${idx}`)]); 
    // [FIX] Tambahkan tombol Force Send di menu edit
    btns.push([Markup.button.callback('⚡ PROSES DATA (REVISI OTOMATIS)', `force_send_${oid}`)]);
    ctx.reply(`🛠 Pilih item:`, Markup.inlineKeyboard(btns)); 
});
bot.action(/^rev_(.+)_(.+)$/, async (ctx)=>{ const orderId = ctx.match[1]; const itemIdx = parseInt(ctx.match[2]); const d = await db.collection('orders').doc(orderId).get(); const item = d.data().items[itemIdx]; const content = item.content || ""; let msg = `🔧 *EDIT: ${item.name}*\n\n`; if (content.length > 3000) { const buffer = Buffer.from(content, 'utf-8'); await ctx.replyWithDocument({ source: buffer, filename: `data.txt` }, { caption: "📂 Data panjang." }); msg += "👉 Data via file.\n"; } else { const lines = content.split('\n'); lines.forEach((l, i) => msg += `*${i+1}.* ${l.substring(0, 30)}...\n`); } msg += `\n👉 Kirim ANGKA (Edit baris) atau TEKS (Smart Fill).`; adminSession[ctx.from.id]={type:'REVISI', orderId, itemIdx}; ctx.reply(msg, {parse_mode:'Markdown', ...cancelBtn}); });

// [BARU] TOMBOL SAKTI
bot.action(/^force_send_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.reply(`⏳ Memproses paksa order ${orderId} ke Supplier/Sheet...`);
    const hasil = await forceFulfillOrder(orderId);
    if (hasil.success) await ctx.reply(hasil.msg);
    else await ctx.reply(`❌ GAGAL: ${hasil.msg}`);
});

bot.action('backup_db', async (ctx) => {
    ctx.reply("⏳ Creating backup...");
    const collections = ['products', 'users', 'orders', 'vouchers', 'settings'];
    let backupData = {};
    for (const colName of collections) {
        const snap = await db.collection(colName).get();
        backupData[colName] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    const buffer = Buffer.from(JSON.stringify(backupData, null, 2), 'utf-8');
    ctx.replyWithDocument({ source: buffer, filename: `BACKUP_JIESTORE_${Date.now()}.json` });
});
bot.action('import_db_ask', (ctx) => {
    adminSession[ctx.from.id] = { type: 'IMPORT_DB' };
    ctx.reply("📥 Kirim File JSON Backup:", cancelBtn);
});

app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
