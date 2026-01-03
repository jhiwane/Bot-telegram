const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
// const fetch = require('node-fetch'); 
require('dotenv').config();

// ==========================================
// 1. SETUP SERVER & CONFIG
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_ID;
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

// ==========================================
// 2. SECURITY & CORE LOGIC
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
    if (orderData.total < (calculatedTotal - 500)) return { isSafe: false, realTotal: calculatedTotal };
    return { isSafe: true };
};

const processStock = async (productId, variantName, qtyNeeded) => {
    const docRef = db.collection('products').doc(productId);
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        const data = doc.data();
        let contentPool = "", isVariant = false, variantIndex = -1, isPermanent = false;

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

        if (isPermanent) {
            const inc = parseInt(qtyNeeded);
            if (isVariant) t.update(docRef, { sold: (data.sold || 0) + inc }); 
            else t.update(docRef, { sold: (data.sold || 0) + inc });
            return { success: true, data: contentPool, currentStock: 999999 }; 
        } else {
            let stocks = contentPool.split('\n').filter(s => s.trim().length > 0);
            if (stocks.length >= qtyNeeded) {
                const taken = stocks.slice(0, qtyNeeded); 
                const remaining = stocks.slice(qtyNeeded).join('\n');
                const inc = parseInt(qtyNeeded);
                if (isVariant) {
                    data.variations[variantIndex].content = remaining;
                    t.update(docRef, { variations: data.variations, sold: (data.sold || 0) + inc });
                } else {
                    t.update(docRef, { content: remaining, sold: (data.sold || 0) + inc });
                }
                return { success: true, data: taken.join('\n'), currentStock: stocks.length };
            } else {
                return { success: false, currentStock: stocks.length };
            }
        }
    });
};

const processOrderLogic = async (orderId, orderData) => {
    let items = [], allComplete = true, msgLog = "", revBtns = [];
    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];
        const isContentFull = item.content && !item.content.includes('[...MENUNGGU');
        if (isContentFull) { items.push(item); msgLog += `✅ ${item.name}: OK\n`; continue; }

        let currentContentLines = item.content ? item.content.split('\n') : [];
        let validLinesCount = currentContentLines.filter(l => !l.includes('[...MENUNGGU')).length;
        let qtyButuh = item.qty - validLinesCount;
        if (qtyButuh <= 0) { items.push(item); continue; }

        try {
            const result = await processStock(item.id, item.variantName, qtyButuh);
            if (result && result.success) {
                const validLines = currentContentLines.filter(l => !l.includes('[...MENUNGGU'));
                let newContent = result.data;
                const finalContent = result.currentStock === 999999 ? newContent : [...validLines, ...newContent.split('\n')].join('\n');
                items.push({ ...item, content: finalContent });
                msgLog += `✅ ${item.name}: SUKSES\n`;
            } else if (result && !result.success && result.currentStock > 0) {
                const partialRes = await processStock(item.id, item.variantName, result.currentStock);
                const validLines = currentContentLines.filter(l => !l.includes('[...MENUNGGU'));
                const newLines = partialRes.data.split('\n');
                const totalKurang = item.qty - (validLines.length + newLines.length);
                let finalLines = [...validLines, ...newLines];
                for(let k=0; k<totalKurang; k++) finalLines.push(`[...MENUNGGU ${totalKurang} LAGI...]`);
                items.push({ ...item, content: finalLines.join('\n') });
                allComplete = false;
                msgLog += `⚠️ ${item.name}: PARTIAL (Kurang ${totalKurang})\n`;
                revBtns.push([Markup.button.callback(`🔧 ISI SISA: ${item.name}`, `rev_${orderId}_${i}`)]);
            } else {
                let finalLines = currentContentLines.filter(l => !l.includes('[...MENUNGGU'));
                const totalKurang = item.qty - finalLines.length;
                if (finalLines.length === 0 || totalKurang > 0) for(let k=0; k<totalKurang; k++) finalLines.push(`[...MENUNGGU ${totalKurang} LAGI...]`);
                items.push({ ...item, content: finalLines.join('\n') });
                allComplete = false;
                msgLog += `❌ ${item.name}: STOK KOSONG\n`;
                revBtns.push([Markup.button.callback(`🔧 ISI SISA: ${item.name}`, `rev_${orderId}_${i}`)]);
            }
        } catch (e) { items.push(item); allComplete = false; msgLog += `❌ ${item.name}: ERROR DB\n`; }
    }
    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });
    if (!allComplete) bot.telegram.sendMessage(ADMIN_ID, `⚠️ *REVISI ORDER ${orderId}*\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) });
    else bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🛠 MENU EDIT', `menu_edit_ord_${orderId}`)]]) });
};

// ==========================================
// 3. API WEBHOOKS
// ==========================================
// A. KONFIRMASI PEMBAYARAN MANUAL (FIXED RESPONSE)
app.post('/api/confirm-manual', async (req, res) => {
    try {
        const { orderId, buyerPhone, total, items } = req.body;
        let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
        
        // Await agar kita tahu pesan terkirim atau gagal
        await bot.telegram.sendMessage(ADMIN_ID, 
            `🔔 *ORDER MASUK (MANUAL)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, 
            Markup.inlineKeyboard([
                [Markup.button.callback('⚡ PROSES', `acc_${orderId}`)],
                [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ])
        );
        
        // Kirim sinyal SUKSES ke Frontend
        res.status(200).json({ status: 'ok' });
        
    } catch (error) {
        console.error("Gagal kirim notif manual:", error);
        // Kirim sinyal ERROR ke Frontend (Penting agar Frontend bisa kasih Fallback)
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    await db.collection('orders').doc(orderId).update({ complain: true, complainResolved: false, userComplainText: message });
    bot.telegram.sendMessage(ADMIN_ID, `🚨 *KOMPLAIN!* 🚨\n🆔 \`${orderId}\`\n💬 "${message}"`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📩 BALAS', `reply_comp_${orderId}`), Markup.button.callback('✅ SELESAI', `solve_${orderId}`)]]) });
    res.json({ status: 'ok' });
});

app.post('/api/notify-order', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    const docRef = db.collection('orders').doc(orderId);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
        const orderData = docSnap.data();
        const security = await validateOrderSecurity(orderId, orderData);
        if (!security.isSafe) {
            await docRef.update({ status: 'FRAUD', adminReply: 'BANNED: CHEATING.' });
            if (orderData.uid) await db.collection('users').doc(orderData.uid).delete();
            await bot.telegram.sendMessage(ADMIN_ID, `🚨 *MALING!* Order: \`${orderId}\` User: ${buyerPhone}. Harga Fake: ${total} vs Asli: ${security.realTotal}. USER BANNED.`);
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
    [Markup.button.callback('👥 PANDUAN USER', 'manage_users'), Markup.button.callback('💳 PAYMENT', 'set_payment')],
    [Markup.button.callback('🎨 GANTI BACKGROUND', 'set_bg')],
    [Markup.button.callback('💰 SALES', 'sales_today'), Markup.button.callback('🚨 KOMPLAIN', 'list_complain')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN*\nKetik APAPUN (Kode Produk / Email / ID Order) untuk mencari.", mainMenu));

bot.on(['text', 'photo', 'document'], async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    
    let text = "";
    if (ctx.message.document) {
        try {
            const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            const response = await fetch(fileLink);
            text = await response.text();
            ctx.reply("📂 File diterima.");
        } catch(e) { return ctx.reply("Gagal baca file."); }
    } else if (ctx.message.photo) {
        text = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else {
        text = ctx.message.text ? ctx.message.text.trim() : '';
    }

    const textLower = text.toLowerCase();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    // --- 1. JIKA SEDANG ADA SESI WIZARD (INPUT BERTAHAP) ---
    if (session) {
        // --- 2. FITUR ADMIN: BUAT VOUCHER (Format: /voucher KODE 5000) ---
    if (text.startsWith('/voucher ')) {
        const parts = text.split(' ');
        if (parts.length === 3) {
            const code = parts[1].toUpperCase();
            const amount = parseInt(parts[2]);
            if (!isNaN(amount)) {
                await db.collection('vouchers').doc(code).set({ 
                    amount: amount, 
                    active: true,
                    createdAt: new Date() 
                });
                return ctx.reply(`🎟 *VOUCHER DIBUAT*\nKode: \`${code}\`\nDiskon: Rp ${amount.toLocaleString()}`);
            }
        }
        return ctx.reply("❌ Format Salah. Ketik: `/voucher KODE NOMINAL`\nContoh: `/voucher BERKAH 5000`");
    }

    // --- 3. FITUR ADMIN: HAPUS VOUCHER (Format: /delvoucher KODE) ---
    if (text.startsWith('/delvoucher ')) {
        const code = text.split(' ')[1].toUpperCase();
        await db.collection('vouchers').doc(code).delete();
        return ctx.reply(`🗑 Voucher \`${code}\` dihapus.`);
    }
        // ... (REVISI LOGIC) ...
        if (session.type === 'REVISI') {
            if (!isNaN(text) && parseInt(text) > 0 && text.length < 5) {
                session.targetLine = parseInt(text) - 1; session.type = 'REVISI_LINE_INPUT'; ctx.reply(`🔧 Kirim data baru baris #${text}:`, cancelBtn);
            } else {
                const d = await db.collection('orders').doc(session.orderId).get(); const data = d.data(); const item = data.items[session.itemIdx];
                let ex = item.content?item.content.split('\n'):[]; let inp = text.split('\n').filter(x=>x.trim());
                let fill=0; let newC=[...ex];
                for(let i=0;i<newC.length;i++){ if(newC[i].includes('[...MENUNGGU') && inp.length>0){newC[i]=inp.shift();fill++;} }
                const isAllValid = !item.content.includes('[...MENUNGGU');
                if(isAllValid) { item.content = text; ctx.reply("✅ Ditimpa Semua."); } else { item.content = newC.join('\n'); ctx.reply(`✅ Terisi ${fill} slot.`); }
                await db.collection('orders').doc(session.orderId).update({ items: data.items }); delete adminSession[userId]; processOrderLogic(session.orderId, data);
            }
            return;
        }
        else if (session.type === 'REVISI_LINE_INPUT') {
            const d = await db.collection('orders').doc(session.orderId).get(); const data = d.data(); const item = data.items[session.itemIdx];
            let lines = item.content?item.content.split('\n'):[];
            if(lines[session.targetLine]!==undefined) { lines[session.targetLine]=text; item.content=lines.join('\n'); await db.collection('orders').doc(session.orderId).update({items:data.items}); delete adminSession[userId]; ctx.reply("✅ Updated."); }
            else { delete adminSession[userId]; ctx.reply("❌ Baris salah."); }
            return;
        }
        // ... (ADD PROD LOGIC) ...
        else if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("🏷 Kode Produk:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("💰 Harga:", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("🖼 Gambar/URL:", cancelBtn); }
            else if (session.step === 'IMG') { d.image = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : text; session.step = 'STATS'; ctx.reply("📊 Sold View (100 500):", cancelBtn); }
            else if (session.step === 'STATS') { const [s,v] = text.split(' '); d.sold=parseInt(s)||0; d.view=parseInt(v)||0; session.step='DESC'; ctx.reply("📝 Deskripsi:", cancelBtn); }
            else if (session.step === 'DESC') { d.desc = text; session.step = 'CONTENT'; ctx.reply("📦 STOK UTAMA (Skip jika variasi):", cancelBtn); }
            else if (session.step === 'CONTENT') { d.content = text==='skip'?'':text; if (d.content) { session.step = 'IS_PERM'; ctx.reply("♾️ PERMANEN? (YA/TIDAK):", cancelBtn); } else { session.step = 'VARS'; ctx.reply("🔀 Ada Variasi? (ya/tidak):", cancelBtn); } }
            else if (session.step === 'IS_PERM') { d.isPermanent = text.toLowerCase() === 'ya'; session.step = 'VARS'; ctx.reply("🔀 Ada Variasi? (ya/tidak):", cancelBtn); }
            else if (session.step === 'VARS') {
                if(text.toLowerCase()==='ya'){ session.step='VAR_NAME'; ctx.reply("Nama Variasi:", cancelBtn); }
                else { await db.collection('products').add({...d, createdAt:new Date()}); delete adminSession[userId]; ctx.reply("✅ Saved."); }
            }
            else if (session.step === 'VAR_NAME') { if(!d.variations)d.variations=[]; session.tempVar={name:text}; session.step='VAR_CODE'; ctx.reply("Kode Var:", cancelBtn); }
            else if (session.step === 'VAR_CODE') { session.tempVar.code=text; session.step='VAR_PRICE'; ctx.reply("Harga Var:", cancelBtn); }
            else if (session.step === 'VAR_PRICE') { session.tempVar.price=parseInt(text); session.step='VAR_CONTENT'; ctx.reply("Stok Var:", cancelBtn); }
            else if (session.step === 'VAR_CONTENT') { session.tempVar.content=text; session.step='VAR_PERM'; ctx.reply("♾️ Variasi PERMANEN? (YA/TIDAK):", cancelBtn); }
            else if (session.step === 'VAR_PERM') { session.tempVar.isPermanent = text.toLowerCase() === 'ya'; d.variations.push(session.tempVar); session.step='VARS'; ctx.reply("✅ Lanjut? (ya/tidak)", cancelBtn); }
            return;
        }
        // ... (SETTINGS & USER LOGIC) ...
        else if (session.type === 'TOPUP_USER') { await db.collection('users').doc(session.targetUid).update({balance:admin.firestore.FieldValue.increment(parseInt(text))}); delete adminSession[userId]; ctx.reply("✅ Saldo Ditambah."); return;}
        else if (session.type === 'DEDUCT_USER') { await db.collection('users').doc(session.targetUid).update({balance:admin.firestore.FieldValue.increment(-parseInt(text))}); delete adminSession[userId]; ctx.reply("✅ Saldo Dipotong."); return;}
        else if (session.type === 'SET_PAYMENT') {
            if(session.step === 'BANK') { session.data.bank=text; session.step='NO'; ctx.reply("Nomor:", cancelBtn); }
            else if(session.step === 'NO') { session.data.no=text; session.step='AN'; ctx.reply("Atas Nama:", cancelBtn); }
            else if(session.step === 'AN') { session.data.an=text; session.step='QR'; ctx.reply("QRIS:", cancelBtn); }
            else if(session.step === 'QR') { await db.collection('settings').doc('payment').set({info:`🏦 ${session.data.bank}\n🔢 ${session.data.no}\n👤 ${session.data.an}`, qris: text==='skip'?'':text}); delete adminSession[userId]; ctx.reply("✅ Saved."); }
            return;
        }
        else if (session.type === 'SET_BG') { await db.collection('settings').doc('layout').set({ backgroundUrl: ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : text }, { merge: true }); delete adminSession[userId]; ctx.reply("✅ Background OK."); return; }
        else if (session.type === 'EDIT_MAIN') { await db.collection('products').doc(session.prodId).update({[session.field]:(session.field.includes('price')||session.field.includes('sold'))?parseInt(text):text}); delete adminSession[userId]; ctx.reply("Updated."); return; }
        else if (session.type === 'EDIT_VAR') { const ref=db.collection('products').doc(session.prodId); const s=await ref.get(); let v=s.data().variations; v[session.varIdx][session.field]=(session.field==='price')?parseInt(text):text; await ref.update({variations:v}); delete adminSession[userId]; ctx.reply("Updated."); return; }
        else if (session.type === 'REPLY_COMPLAIN') { await db.collection('orders').doc(session.orderId).update({adminReply:text, complainResolved:true}); delete adminSession[userId]; ctx.reply("Terkirim."); return; }
    }

    // --- 2. JIKA TIDAK ADA SESI -> UNIVERSAL SEARCH (MATA ELANG) ---
    // Logika ini akan berjalan kapanpun Anda mengetik sesuatu di bot
    if (text) {
        ctx.reply("🔍 Sedang mencari...");

        // A. CEK ORDER ID
        try {
            const orderSnap = await db.collection('orders').doc(text).get();
            if (orderSnap.exists) {
                const o = orderSnap.data();
                return ctx.reply(`📦 *ORDER ${orderSnap.id}*\nStatus: ${o.status}\nItems: ${o.items.length}\nUser: ${o.buyerPhone}`, {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('🛠 MENU EDIT', `menu_edit_ord_${orderSnap.id}`)],[Markup.button.callback('🗑 HAPUS', `del_order_${orderSnap.id}`)]])});
            }
        } catch(e){}

        // B. CEK PRODUK (KODE UTAMA & VARIASI)
        try {
            const allProds = await db.collection('products').get();
            let found = null;
            allProds.forEach(doc => { 
                const p = doc.data(); 
                // Cek kode utama ATAU kode variasi (case insensitive)
                if ((p.code && p.code.toLowerCase() === textLower) || (p.variations && p.variations.some(v => v.code && v.code.toLowerCase() === textLower))) {
                    found = { id: doc.id, ...p };
                }
            });
            if (found) {
                return ctx.reply(`🔎 *${found.name}*\n🏷 Kode: ${found.code}\n💰 Rp ${found.price}`, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✏️ Edit Utama', `menu_edit_main_${found.id}`)],
                        [Markup.button.callback('🔀 ATUR VARIASI', `menu_vars_${found.id}`)],
                        [Markup.button.callback('🗑️ Hapus', `del_prod_${found.id}`)]
                    ])
                });
            }
        } catch(e){}

        // C. CEK USER (EMAIL atau UID)
        try {
            let foundUser = null;
            let targetUid = null;
            const cleanText = text.trim();

            // Cek by Email
            let userSnap = await db.collection('users').where('email', '==', cleanText).get();
            if (userSnap.empty) userSnap = await db.collection('users').where('email', '==', cleanText.toLowerCase()).get();
            
            if (!userSnap.empty) {
                foundUser = userSnap.docs[0].data();
                targetUid = userSnap.docs[0].id;
            } else {
                // Cek by UID (Dokumen ID langsung)
                const uidDoc = await db.collection('users').doc(cleanText).get();
                if (uidDoc.exists) {
                    foundUser = uidDoc.data();
                    targetUid = uidDoc.id;
                }
            }

            if (foundUser) {
                return ctx.reply(
                    `👤 *USER DITEMUKAN*\n🆔 \`${targetUid}\`\n📧 ${foundUser.email||'Anon'}\n💰 Saldo: Rp ${foundUser.balance?.toLocaleString() || 0}`, 
                    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                        [Markup.button.callback('💵 TAMBAH SALDO', `topup_${targetUid}`)],
                        [Markup.button.callback('💸 POTONG SALDO', `deduct_${targetUid}`)],
                        [Markup.button.callback('🚫 BANNED AKUN', `ban_user_${targetUid}`)]
                    ])}
                );
            }
        } catch(e){}

        // D. JIKA SEMUA GAGAL
        ctx.reply("❌ Tidak ditemukan (Order/Produk/User).");
    }
});

// --- ACTION HANDLERS ---
bot.action('list_pending', async (ctx) => {
    const s = await db.collection('orders').where('status', '==', 'pending').get();
    if (s.empty) return ctx.reply("✅ Aman.");
    const btns = s.docs.map(d => [Markup.button.callback(`🆔 ${d.id.slice(0,5)}... | Rp ${d.data().total}`, `acc_${d.id}`)]);
    ctx.reply("⏳ **PENDING:**", Markup.inlineKeyboard(btns));
});
bot.action('list_all_stock', async (ctx) => {
    ctx.reply("📦 Mendata...");
    const snap = await db.collection('products').get();
    let msg = "📊 **STOK GUDANG**\n\n";
    snap.forEach(doc => {
        const p = doc.data(); msg += `🔹 *${p.name}* (${p.code})\n`;
        if (p.variations) { p.variations.forEach(v => { const c = v.isPermanent?"♾️": (v.content?v.content.split('\n').filter(x=>x.trim()).length:0); msg += `   - ${v.name}: ${c}\n`; }); } 
        else { const c = p.isPermanent?"♾️": (p.content?p.content.split('\n').filter(x=>x.trim()).length:0); msg += `   - Stok: ${c}\n`; }
        msg += "\n";
    });
    if (msg.length > 4000) { const chunks = msg.match(/.{1,4000}/g); for (const c of chunks) await ctx.reply(c, {parse_mode:'Markdown'}); } 
    else ctx.reply(msg, {parse_mode:'Markdown'});
});
bot.action('set_bg', (ctx) => { adminSession[ctx.from.id] = { type: 'SET_BG' }; ctx.reply("🖼 Kirim **URL/GAMBAR**:", cancelBtn); });
bot.action('manage_users', (ctx) => { ctx.reply("🔍 Ketik langsung **EMAIL** atau **UID** di chat untuk mencari user."); });
bot.action(/^topup_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'TOPUP_USER', targetUid:ctx.match[1]}; ctx.reply("Nominal:", cancelBtn); });
bot.action(/^deduct_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'DEDUCT_USER', targetUid:ctx.match[1]}; ctx.reply("Nominal:", cancelBtn); });
bot.action(/^ban_user_(.+)$/, async (ctx)=>{ await db.collection('users').doc(ctx.match[1]).delete(); ctx.editMessageText("Banned."); });
bot.action('sales_today', async (ctx)=>{ try { ctx.reply("⏳ Hitung..."); const now=new Date(); const start=new Date(now.getFullYear(),now.getMonth(),now.getDate()); const s=await db.collection('orders').orderBy('createdAt','desc').limit(200).get(); let t=0,c=0,i=0; s.forEach(d=>{const dt=d.data(); if(dt.status==='success'){const tm=dt.createdAt.toDate?dt.createdAt.toDate():new Date(dt.createdAt); if(tm>=start){t+=dt.total;c++;dt.items.forEach(x=>i+=x.qty)}}}); ctx.reply(`💰 *HARI INI*\nOmset: ${t.toLocaleString()}\nTrx: ${c}\nItem: ${i}`); } catch(e){ctx.reply("Error.");} }); 
bot.action(/^acc_(.+)$/, async (ctx) => { ctx.reply("Proses..."); const d = await db.collection('orders').doc(ctx.match[1]).get(); if(d.exists) processOrderLogic(ctx.match[1], d.data()); });
bot.action(/^tolak_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({status:'failed'}); ctx.editMessageText("Ditolak."); });
bot.action('list_complain', async (ctx)=>{ const s=await db.collection('orders').where('complain','==',true).where('complainResolved','==',false).get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.id.slice(0,5),`view_comp_${d.id}`)]); ctx.reply("Komplain",Markup.inlineKeyboard(b)); });
bot.action(/^view_comp_(.+)$/, async (ctx)=>{ const d = await db.collection('orders').doc(ctx.match[1]).get(); ctx.reply(`Msg: ${d.data().userComplainText}`, Markup.inlineKeyboard([[Markup.button.callback('BALAS', `reply_comp_${d.id}`), Markup.button.callback('SELESAI', `solve_${d.id}`)]])); });
bot.action(/^reply_comp_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'REPLY_COMPLAIN', orderId:ctx.match[1]}; ctx.reply("Balasan:", cancelBtn); });
bot.action(/^solve_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({complainResolved:true}); ctx.editMessageText("Done."); });
bot.action(/^back_prod_(.+)$/, async (ctx) => { const d = await db.collection('products').doc(ctx.match[1]).get(); const p = d.data(); ctx.editMessageText(`🔎 *${p.name}*`, Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Utama', `menu_edit_main_${d.id}`)],[Markup.button.callback('🔀 ATUR VARIASI', `menu_vars_${d.id}`)],[Markup.button.callback('🗑️ HAPUS PRODUK', `del_prod_${d.id}`)]])); });
bot.action(/^del_prod_(.+)$/, async (ctx)=>{ await db.collection('products').doc(ctx.match[1]).delete(); ctx.editMessageText("Dihapus."); });
bot.action(/^del_order_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).delete(); ctx.editMessageText("Dihapus."); });
bot.action('cancel_action', (ctx)=>{ delete adminSession[ctx.from.id]; ctx.reply("Batal."); });
bot.action('add_prod', (ctx)=>{ adminSession[ctx.from.id]={type:'ADD_PROD', step:'NAME', data:{}}; ctx.reply("Nama Produk:", cancelBtn); });
bot.action('set_payment', (ctx)=>{ adminSession[ctx.from.id]={type:'SET_PAYMENT', step:'BANK', data:{}}; ctx.reply("Nama Bank:", cancelBtn); });
bot.action(/^menu_edit_main_(.+)$/, (ctx) => { const pid = ctx.match[1]; ctx.editMessageText("✏️ *EDIT UTAMA*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ [Markup.button.callback('Nama', `ed_main_name_${pid}`), Markup.button.callback('Harga', `ed_main_price_${pid}`)], [Markup.button.callback('Kode', `ed_main_code_${pid}`), Markup.button.callback('Stok', `ed_main_content_${pid}`)], [Markup.button.callback('Fake Sold', `ed_main_sold_${pid}`), Markup.button.callback('Fake View', `ed_main_view_${pid}`)], [Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)] ])}); });
bot.action(/^ed_main_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_MAIN', prodId: ctx.match[2], field: ctx.match[1] }; ctx.reply(`Nilai Baru:`, cancelBtn); });
bot.action(/^menu_vars_(.+)$/, async (ctx) => { const pid = ctx.match[1]; const d = await db.collection('products').doc(pid).get(); const vars = d.data().variations || []; const btns = vars.map((v, i) => [Markup.button.callback(`${v.name}`, `sel_var_${pid}_${i}`)]); btns.push([Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)]); ctx.editMessageText("🔀 *VARIASI:*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) }); });
bot.action(/^sel_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const d = await db.collection('products').doc(pid).get(); const v = d.data().variations[idx]; ctx.editMessageText(`🔀 ${v.name}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ [Markup.button.callback('Nama', `ed_var_name_${pid}_${idx}`), Markup.button.callback('Harga', `ed_var_price_${pid}_${idx}`)], [Markup.button.callback('Stok', `ed_var_content_${pid}_${idx}`)], [Markup.button.callback('🗑️ Hapus', `del_var_${pid}_${idx}`), Markup.button.callback('🔙 List', `menu_vars_${pid}`)] ])}); });
bot.action(/^ed_var_(.+)_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_VAR', prodId: ctx.match[2], varIdx: parseInt(ctx.match[3]), field: ctx.match[1] }; ctx.reply(`Nilai Baru:`, cancelBtn); });
bot.action(/^del_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const ref = db.collection('products').doc(pid); const s = await ref.get(); let v = s.data().variations; v.splice(parseInt(idx), 1); await ref.update({ variations: v }); ctx.reply("🗑️ Dihapus."); });
bot.action(/^menu_edit_ord_(.+)$/, async (ctx) => { const oid = ctx.match[1]; const doc = await db.collection('orders').doc(oid).get(); const items = doc.data().items; const btns = items.map((item, idx) => [Markup.button.callback(`✏️ EDIT: ${item.name}`, `rev_${oid}_${idx}`)]); ctx.reply(`🛠 Pilih item:`, Markup.inlineKeyboard(btns)); });
bot.action(/^rev_(.+)_(.+)$/, async (ctx)=>{ const orderId = ctx.match[1]; const itemIdx = parseInt(ctx.match[2]); const d = await db.collection('orders').doc(orderId).get(); const item = d.data().items[itemIdx]; const content = item.content || ""; let msg = `🔧 *EDIT: ${item.name}*\n\n`; if (content.length > 3000) { const buffer = Buffer.from(content, 'utf-8'); await ctx.replyWithDocument({ source: buffer, filename: `data.txt` }, { caption: "📂 Data panjang." }); msg += "👉 Data via file.\n"; } else { const lines = content.split('\n'); lines.forEach((l, i) => msg += `*${i+1}.* ${l.substring(0, 30)}...\n`); } msg += `\n👉 Kirim ANGKA (Edit baris) atau TEKS (Smart Fill).`; adminSession[ctx.from.id]={type:'REVISI', orderId, itemIdx}; ctx.reply(msg, {parse_mode:'Markdown', ...cancelBtn}); });

app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
