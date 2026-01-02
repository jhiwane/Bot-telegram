const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// ==========================================
// 1. SETUP SERVER & CONFIG
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_ID;
const adminSession = {}; // Ingatan Bot

// --- FIREBASE ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) { console.error("❌ Firebase Error:", error.message); }
const db = admin.firestore();

// --- BOT TELEGRAM ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const cancelBtn = Markup.inlineKeyboard([Markup.button.callback('❌ BATAL', 'cancel_action')]);

// ==========================================
// 2. LOGIKA STOK & ORDER
// ==========================================

const processStock = async (productId, variantName, qtyNeeded) => {
    const docRef = db.collection('products').doc(productId);
    
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        
        const data = doc.data();
        let contentPool = "";
        let isVariant = false;
        let variantIndex = -1;

        if (variantName && data.variations) {
            variantIndex = data.variations.findIndex(v => v.name === variantName);
            if (variantIndex !== -1) {
                contentPool = data.variations[variantIndex].content || "";
                isVariant = true;
            }
        } else {
            contentPool = data.content || "";
        }

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
            return { success: true, data: taken.join('\n') };
        } else {
            return { success: false, currentStock: stocks.length };
        }
    });
};

const processOrderLogic = async (orderId, orderData) => {
    let items = [], needsRev = false, msgLog = "", revBtns = [];

    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];
        if (item.content) {
            items.push(item);
            msgLog += `✅ ${item.name}: OK (Manual)\n`;
            continue;
        }

        try {
            const result = await processStock(item.id, item.variantName, item.qty);
            if (result && result.success) {
                items.push({ ...item, content: result.data });
                msgLog += `✅ ${item.name}: SUKSES\n`;
            } else {
                items.push({ ...item, content: null });
                needsRev = true;
                msgLog += `⚠️ ${item.name}: STOK KURANG\n`;
                revBtns.push([Markup.button.callback(`🔧 ISI: ${item.name}`, `rev_${orderId}_${i}`)]);
            }
        } catch (e) {
            items.push({ ...item, content: null });
            needsRev = true;
            msgLog += `❌ ${item.name}: ERROR DB\n`;
        }
    }

    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    if (needsRev) {
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ *REVISI ORDER ${orderId}*\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) });
    } else {
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\n${msgLog}`);
    }
};

// ==========================================
// 3. API WEBHOOK (ORDER & KOMPLAIN)
// ==========================================

// A. TERIMA ORDER BARU
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    
    try {
        await bot.telegram.sendMessage(ADMIN_ID, 
            `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, 
            Markup.inlineKeyboard([[Markup.button.callback('⚡ PROSES', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]])
        );
        res.json({ status: 'ok' });
    } catch (error) {
        console.error("Gagal kirim notif bot:", error);
        res.status(500).json({ error: error.message });
    }
});

// B. TERIMA KOMPLAIN TEKS
app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    
    // Update DB status
    await db.collection('orders').doc(orderId).update({ 
        complain: true, 
        complainResolved: false,
        userComplainText: message 
    });

    // Notif ke Admin
    await bot.telegram.sendMessage(ADMIN_ID, 
        `🚨 *KOMPLAIN MASUK!* 🚨\n\n🆔 Order: \`${orderId}\`\n💬 Pesan: "${message}"`, 
        { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📩 BALAS PESAN', `reply_comp_${orderId}`)],
                [Markup.button.callback('✅ TANDAI SELESAI', `solve_${orderId}`)]
            ])
        }
    );
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('SERVER JSN-02 READY'));

// ==========================================
// 4. BOT BRAIN (PANEL ADMIN)
// ==========================================

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('💳 ATUR PEMBAYARAN', 'set_payment')],
    [Markup.button.callback('💰 SALES HARI INI', 'sales_today'), Markup.button.callback('🚨 KOMPLAIN', 'list_complain')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JSN-02*", mainMenu));

// --- LISTENER TEKS (INPUT) ---
bot.on('text', async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    if (session) {
        // 1. TAMBAH PRODUK (WIZARD)
        if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("🏷 Kode Produk:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("💰 Harga:", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("🖼 URL Gambar:", cancelBtn); }
            else if (session.step === 'IMG') { d.image = text; session.step = 'DESC'; ctx.reply("📝 Deskripsi:", cancelBtn); }
            else if (session.step === 'DESC') { d.desc = text; session.step = 'CONTENT'; ctx.reply("📦 Stok Utama (Skip jika variasi):", cancelBtn); }
            else if (session.step === 'CONTENT') { d.content = text==='skip'?'':text; session.step = 'VARS'; ctx.reply("🔀 Variasi? (Nama,Harga,Stok | ...):", cancelBtn); }
            else if (session.step === 'VARS') {
                if(text!=='skip') d.variations = text.split('|').map(v=>{ const l=v.split(','); return {name:l[0], price:parseInt(l[1]), content:l.slice(2).join(',')} });
                else d.variations = [];
                await db.collection('products').add({...d, sold:0, view:0, createdAt:new Date()});
                delete adminSession[userId];
                ctx.reply("✅ Produk Tersimpan!");
            }
        }
        // 2. SETTING PEMBAYARAN
        else if (session.type === 'SET_PAYMENT') {
            if (session.step === 'INFO') {
                session.data.info = text;
                session.step = 'QRIS';
                ctx.reply("🖼 Sekarang kirim *URL GAMBAR QRIS*:", cancelBtn);
            } else if (session.step === 'QRIS') {
                // Simpan ke Dokumen Khusus di Firebase
                await db.collection('settings').doc('payment').set({
                    info: session.data.info,
                    qris: text
                });
                delete adminSession[userId];
                ctx.reply("✅ Info Pembayaran & QRIS Diupdate!");
            }
        }
        // 3. BALAS KOMPLAIN
        else if (session.type === 'REPLY_COMPLAIN') {
            const { orderId } = session;
            // Update DB agar muncul di Web User
            await db.collection('orders').doc(orderId).update({
                adminReply: text,
                complainResolved: true // Anggap selesai jika sudah dibalas
            });
            delete adminSession[userId];
            ctx.reply(`✅ Balasan terkirim untuk Order ${orderId}`);
        }
        // 4. REVISI & EDIT
        else if (session.type === 'REVISI') {
            const { orderId, itemIdx } = session;
            const docRef = db.collection('orders').doc(orderId);
            const snap = await docRef.get();
            const data = snap.data();
            data.items[itemIdx].content = text;
            await docRef.update({ items: data.items });
            delete adminSession[userId];
            ctx.reply("✅ Revisi Tersimpan!");
            processOrderLogic(orderId, data);
        }
        return;
    }

    // SMART SEARCH
    const snap = await db.collection('products').where('code', '==', text).get();
    if (!snap.empty) {
        const doc = snap.docs[0];
        const p = doc.data();
        let btns = [[Markup.button.callback('🗑️ HAPUS', `del_prod_${doc.id}`)]];
        ctx.reply(`🔎 ${p.name}\n${p.code}`, Markup.inlineKeyboard(btns));
    }
});

// --- ACTION HANDLERS ---

bot.action('set_payment', (ctx) => {
    adminSession[ctx.from.id] = { type: 'SET_PAYMENT', step: 'INFO', data: {} };
    ctx.reply("💳 Kirim *INFO REKENING/DANA* (Teks yang akan muncul di web):", cancelBtn);
});

bot.action(/^reply_comp_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'REPLY_COMPLAIN', orderId: ctx.match[1] };
    ctx.reply("💬 Tulis balasan pesan untuk pembeli:", cancelBtn);
});

bot.action('list_complain', async (ctx) => {
    const snap = await db.collection('orders').where('complain', '==', true).where('complainResolved', '==', false).get();
    if(snap.empty) return ctx.reply("✅ Aman.");
    const btns = snap.docs.map(d => [Markup.button.callback(`🚨 ${d.id.slice(0,5)}...`, `view_comp_${d.id}`)]);
    ctx.reply("List Komplain:", Markup.inlineKeyboard(btns));
});

bot.action(/^view_comp_(.+)$/, async (ctx) => {
    const d = await db.collection('orders').doc(ctx.match[1]).get();
    const data = d.data();
    ctx.reply(`🚨 KOMPLAIN ${d.id}\n👤 ${data.buyerPhone}\n💬 "${data.userComplainText}"`, 
        Markup.inlineKeyboard([[Markup.button.callback('📩 BALAS', `reply_comp_${d.id}`), Markup.button.callback('✅ SELESAI', `solve_${d.id}`)]])
    );
});

bot.action(/^solve_(.+)$/, async (ctx) => {
    await db.collection('orders').doc(ctx.match[1]).update({ complainResolved: true });
    ctx.editMessageText("✅ Masalah Selesai.");
});

bot.action('add_prod', (ctx) => {
    adminSession[ctx.from.id] = { type: 'ADD_PROD', step: 'NAME', data: {} };
    ctx.reply("➕ Nama Produk:", cancelBtn);
});

bot.action(/^acc_(.+)$/, async (ctx) => {
    ctx.reply("⚙️ Proses...");
    const d = await db.collection('orders').doc(ctx.match[1]).get();
    if(d.exists) processOrderLogic(ctx.match[1], d.data());
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    await db.collection('orders').doc(ctx.match[1]).update({status:'failed'});
    ctx.editMessageText("🚫 Ditolak.");
});

bot.action(/^rev_(.+)_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'REVISI', orderId: ctx.match[1], itemIdx: parseInt(ctx.match[2]) };
    ctx.reply("🔧 Isi Manual:", cancelBtn);
});

bot.action(/^del_prod_(.+)$/, async (ctx) => {
    await db.collection('products').doc(ctx.match[1]).delete();
    ctx.editMessageText("🗑️ Terhapus.");
});

bot.action('cancel_action', (ctx) => {
    delete adminSession[ctx.from.id];
    ctx.reply("Batal.");
});

// START
app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
