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
// 2. LOGIKA STOK & ORDER (CORE BRAIN)
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
        if (item.content) { items.push(item); msgLog += `✅ ${item.name}: OK (Manual)\n`; continue; }

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
        } catch (e) { items.push({ ...item, content: null }); needsRev = true; msgLog += `❌ ${item.name}: ERROR DB\n`; }
    }

    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    if (needsRev) bot.telegram.sendMessage(ADMIN_ID, `⚠️ *REVISI ORDER ${orderId}*\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) });
    else bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\n${msgLog}`);
};

// ==========================================
// 3. API WEBHOOK
// ==========================================
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    bot.telegram.sendMessage(ADMIN_ID, `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, Markup.inlineKeyboard([[Markup.button.callback('⚡ PROSES', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]]));
    res.json({ status: 'ok' });
});

app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    await db.collection('orders').doc(orderId).update({ complain: true, complainResolved: false, userComplainText: message });
    bot.telegram.sendMessage(ADMIN_ID, `🚨 *KOMPLAIN!* 🚨\n🆔 \`${orderId}\`\n💬 "${message}"`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📩 BALAS', `reply_comp_${orderId}`), Markup.button.callback('✅ SELESAI', `solve_${orderId}`)]]) });
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('SERVER JSN-02 READY'));

// ==========================================
// 4. BOT BRAIN (PANEL ADMIN SUPER LENGKAP)
// ==========================================

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('💳 ATUR PEMBAYARAN', 'set_payment')],
    [Markup.button.callback('💰 LAPORAN SALES', 'sales_today'), Markup.button.callback('⏳ PENDING ORDER', 'list_pending')],
    [Markup.button.callback('🚨 DAFTAR KOMPLAIN', 'list_complain')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JSN-02*\nKetik Kode Produk atau ID Order untuk mencarinya.", mainMenu));

// --- LISTENER TEKS (INPUT WIZARD & SEARCH) ---
bot.on('text', async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    // A. WIZARD SESSION (INPUT BERTAHAP)
    if (session) {
        // 1. TAMBAH PRODUK LENGKAP
        if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("🏷 Kode Produk Utama:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("💰 Harga Utama:", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("🖼 URL Gambar:", cancelBtn); }
            else if (session.step === 'IMG') { d.image = text; session.step = 'STATS'; ctx.reply("📊 Fake Sold & View (cth: 100 5000):", cancelBtn); }
            else if (session.step === 'STATS') { 
                const [s, v] = text.split(' '); d.sold = parseInt(s)||0; d.view = parseInt(v)||0; 
                session.step = 'DESC'; ctx.reply("📝 Deskripsi Produk:", cancelBtn); 
            }
            else if (session.step === 'DESC') { d.desc = text; session.step = 'CONTENT'; ctx.reply("📦 Stok Utama (Skip jika cuma variasi):", cancelBtn); }
            else if (session.step === 'CONTENT') { d.content = text==='skip'?'':text; session.step = 'VARS'; ctx.reply("🔀 Ada Variasi? (ya/tidak):", cancelBtn); }
            else if (session.step === 'VARS') {
                if (text.toLowerCase() === 'ya') {
                    session.step = 'VAR_NAME'; ctx.reply("🔀 Nama Variasi:", cancelBtn);
                } else {
                    await db.collection('products').add({...d, createdAt: new Date()});
                    delete adminSession[userId];
                    ctx.reply("✅ Produk Tersimpan!");
                }
            }
            // Loop Variasi
            else if (session.step === 'VAR_NAME') {
                if(!d.variations) d.variations = [];
                session.tempVar = { name: text }; session.step = 'VAR_CODE'; ctx.reply("🏷 Kode Variasi:", cancelBtn);
            }
            else if (session.step === 'VAR_CODE') {
                session.tempVar.code = text; session.step = 'VAR_PRICE'; ctx.reply("💰 Harga Variasi:", cancelBtn);
            }
            else if (session.step === 'VAR_PRICE') {
                session.tempVar.price = parseInt(text); session.step = 'VAR_CONTENT'; ctx.reply("📦 Stok Variasi:", cancelBtn);
            }
            else if (session.step === 'VAR_CONTENT') {
                session.tempVar.content = text;
                d.variations.push(session.tempVar);
                session.step = 'VARS'; // Kembali tanya variasi lain
                ctx.reply("✅ Variasi ditambahkan! Ada lagi? (ya/tidak)", cancelBtn);
            }
        }

        // 2. SETTING PEMBAYARAN CERDAS
        else if (session.type === 'SET_PAYMENT') {
            const d = session.data;
            if (session.step === 'BANK') { d.bankName = text; session.step = 'NO_REK'; ctx.reply("🔢 Nomor Rekening/Dana:", cancelBtn); }
            else if (session.step === 'NO_REK') { d.noRek = text; session.step = 'ATAS_NAMA'; ctx.reply("👤 Atas Nama:", cancelBtn); }
            else if (session.step === 'ATAS_NAMA') { d.atasNama = text; session.step = 'QRIS'; ctx.reply("🖼 URL Gambar QRIS (Ketik 'skip' jika tidak ada):", cancelBtn); }
            else if (session.step === 'QRIS') {
                const qris = text==='skip' ? '' : text;
                const infoText = `🏦 ${d.bankName}\n🔢 ${d.noRek}\n👤 ${d.atasNama}`;
                await db.collection('settings').doc('payment').set({ info: infoText, qris });
                delete adminSession[userId];
                ctx.reply("✅ Info Pembayaran Diupdate!");
            }
        }

        // 3. EDIT PRODUK (SINGLE FIELD)
        else if (session.type === 'EDIT_PROD') {
            const { prodId, field } = session;
            if(field==='price') await db.collection('products').doc(prodId).update({price:parseInt(text)});
            else if(field==='name') await db.collection('products').doc(prodId).update({name:text});
            else if(field==='code') await db.collection('products').doc(prodId).update({code:text});
            else if(field==='content') await db.collection('products').doc(prodId).update({content:text});
            
            delete adminSession[userId];
            ctx.reply("✅ Update Berhasil!");
        }

        // 4. BALAS KOMPLAIN / REVISI
        else if (session.type === 'REPLY_COMPLAIN') {
            await db.collection('orders').doc(session.orderId).update({ adminReply: text, complainResolved: true });
            delete adminSession[userId]; ctx.reply("✅ Terkirim.");
        }
        else if (session.type === 'REVISI') {
            const docRef = db.collection('orders').doc(session.orderId);
            const snap = await docRef.get(); const data = snap.data();
            data.items[session.itemIdx].content = text;
            await docRef.update({ items: data.items });
            delete adminSession[userId]; ctx.reply("✅ Revisi OK.");
            processOrderLogic(session.orderId, data);
        }
        return;
    }

    // B. SMART SEARCH (PRODUK & ORDER)
    
    // Cek apakah ini ID Order?
    const orderSnap = await db.collection('orders').doc(text).get();
    if(orderSnap.exists) {
        const o = orderSnap.data();
        const items = o.items.map(i=>`${i.name} x${i.qty}`).join(', ');
        ctx.reply(`📦 *ORDER ${orderSnap.id}*\nStatus: ${o.status}\nUser: ${o.buyerPhone}\nItem: ${items}\nTotal: ${o.total}`, Markup.inlineKeyboard([
            [Markup.button.callback('🗑 HAPUS HISTORY', `del_order_${orderSnap.id}`)]
        ]));
        return;
    }

    // Cek apakah ini Kode Produk?
    const prodSnap = await db.collection('products').where('code', '==', text).get();
    if (!prodSnap.empty) {
        const doc = prodSnap.docs[0];
        const p = doc.data();
        const mainStok = p.content ? p.content.split('\n').filter(x=>x.trim()).length : 0;
        
        ctx.reply(`🔎 *${p.name}*\n🏷 ${p.code} | Rp ${p.price}\n📦 Stok Utama: ${mainStok}\n🔀 Variasi: ${p.variations?.length||0}`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✏️ Nama', `ed_name_${doc.id}`), Markup.button.callback('✏️ Harga', `ed_price_${doc.id}`)],
                [Markup.button.callback('✏️ Kode', `ed_code_${doc.id}`), Markup.button.callback('📦 Stok Utama', `ed_stok_${doc.id}`)],
                [Markup.button.callback('🗑️ HAPUS PRODUK', `del_prod_${doc.id}`)]
            ])
        });
        return;
    }

    ctx.reply("❌ Tidak ditemukan (Produk/Order).");
});

// --- ACTION HANDLERS ---

// WIZARD START
bot.action('add_prod', (ctx) => {
    adminSession[ctx.from.id] = { type: 'ADD_PROD', step: 'NAME', data: {} };
    ctx.reply("➕ *WIZARD TAMBAH PRODUK*\nMasukkan Nama Produk:", cancelBtn);
});

bot.action('set_payment', (ctx) => {
    adminSession[ctx.from.id] = { type: 'SET_PAYMENT', step: 'BANK', data: {} };
    ctx.reply("🏦 Masukkan Nama Bank/E-Wallet (Cth: BCA / DANA):", cancelBtn);
});

// SALES REPORT (FIX LOGIC)
bot.action('sales_today', async (ctx) => {
    const start = new Date(); start.setHours(0,0,0,0);
    const snap = await db.collection('orders').where('status','==','success').where('createdAt','>=',start).get();
    
    let totalUang = 0;
    let totalTrx = 0;
    let itemsSold = 0;

    snap.forEach(d => {
        const data = d.data();
        totalUang += data.total;
        totalTrx++;
        data.items.forEach(i => itemsSold += i.qty);
    });

    ctx.reply(`💰 *LAPORAN SALES HARI INI*\n\n💵 Omset: Rp ${totalUang.toLocaleString()}\n🛒 Transaksi: ${totalTrx}\n📦 Item Terjual: ${itemsSold}`);
});

// EDIT HANDLERS
bot.action(/^ed_name_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'EDIT_PROD', prodId:ctx.match[1], field:'name'}; ctx.reply("Kirim Nama Baru:"); });
bot.action(/^ed_price_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'EDIT_PROD', prodId:ctx.match[1], field:'price'}; ctx.reply("Kirim Harga Baru:"); });
bot.action(/^ed_code_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'EDIT_PROD', prodId:ctx.match[1], field:'code'}; ctx.reply("Kirim Kode Baru:"); });
bot.action(/^ed_stok_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'EDIT_PROD', prodId:ctx.match[1], field:'content'}; ctx.reply("Kirim Stok Baru (Timpa):"); });

// HAPUS
bot.action(/^del_prod_(.+)$/, async (ctx)=>{ await db.collection('products').doc(ctx.match[1]).delete(); ctx.editMessageText("🗑️ Produk Terhapus."); });
bot.action(/^del_order_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).delete(); ctx.editMessageText("🗑️ History Order Dihapus."); });

// COMMON HANDLERS
bot.action('cancel_action', (ctx)=>{ delete adminSession[ctx.from.id]; ctx.reply("Batal."); });
bot.action('list_pending', async (ctx) => {
    const snap = await db.collection('orders').where('status','==','pending').get();
    if(snap.empty) return ctx.reply("Aman.");
    const btns = snap.docs.map(d=>[Markup.button.callback(`${d.data().buyerPhone}`, `cek_${d.id}`)]);
    ctx.reply("Pending:", Markup.inlineKeyboard(btns));
});
bot.action(/^cek_(.+)$/, async (ctx) => {
    const d = await db.collection('orders').doc(ctx.match[1]).get();
    ctx.reply(`Order ${d.id}`, Markup.inlineKeyboard([[Markup.button.callback('ACC', `acc_${d.id}`), Markup.button.callback('TOLAK', `tolak_${d.id}`)]]));
});
bot.action(/^acc_(.+)$/, async (ctx) => {
    ctx.reply("Proses..."); 
    const d = await db.collection('orders').doc(ctx.match[1]).get();
    if(d.exists) processOrderLogic(ctx.match[1], d.data());
});
bot.action(/^tolak_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({status:'failed'}); ctx.editMessageText("Ditolak."); });
bot.action(/^rev_(.+)_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'REVISI', orderId:ctx.match[1], itemIdx:parseInt(ctx.match[2])}; ctx.reply("Isi Manual:"); });

// LIST COMPLAIN
bot.action('list_complain', async (ctx)=>{
    const snap = await db.collection('orders').where('complain','==',true).where('complainResolved','==',false).get();
    if(snap.empty) return ctx.reply("Aman.");
    const btns = snap.docs.map(d=>[Markup.button.callback(`🚨 ${d.id.slice(0,5)}`, `view_comp_${d.id}`)]);
    ctx.reply("Komplain:", Markup.inlineKeyboard(btns));
});
bot.action(/^view_comp_(.+)$/, async (ctx)=>{
    const d = await db.collection('orders').doc(ctx.match[1]).get();
    ctx.reply(`Msg: ${d.data().userComplainText}`, Markup.inlineKeyboard([[Markup.button.callback('BALAS', `reply_comp_${d.id}`), Markup.button.callback('SELESAI', `solve_${d.id}`)]]));
});
bot.action(/^reply_comp_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'REPLY_COMPLAIN', orderId:ctx.match[1]}; ctx.reply("Balasan:"); });
bot.action(/^solve_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({complainResolved:true}); ctx.editMessageText("Done."); });

// START
app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
