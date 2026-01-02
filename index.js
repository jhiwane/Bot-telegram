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
    try {
        await bot.telegram.sendMessage(ADMIN_ID, `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, Markup.inlineKeyboard([[Markup.button.callback('⚡ PROSES', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]]));
        res.json({ status: 'ok' });
    } catch (e) { console.error(e); res.status(500).json({error:e.message}); }
});

app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    await db.collection('orders').doc(orderId).update({ complain: true, complainResolved: false, userComplainText: message });
    bot.telegram.sendMessage(ADMIN_ID, `🚨 *KOMPLAIN!* 🚨\n🆔 \`${orderId}\`\n💬 "${message}"`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📩 BALAS', `reply_comp_${orderId}`), Markup.button.callback('✅ SELESAI', `solve_${orderId}`)]]) });
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('SERVER JSN-02 READY'));

// ==========================================
// 4. BOT BRAIN (PANEL ADMIN COMPLETE)
// ==========================================

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('👥 KELOLA USER', 'manage_users'), Markup.button.callback('💳 ATUR PEMBAYARAN', 'set_payment')],
    [Markup.button.callback('💰 SALES REPORT', 'sales_today'), Markup.button.callback('🚨 KOMPLAIN', 'list_complain')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JSN-02*\nKetik Kode Produk (Utama/Variasi) atau ID Order untuk mencari.", mainMenu));

// --- LISTENER TEKS (SEARCH & WIZARD) ---
bot.on('text', async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    // A. MODE WIZARD / EDIT
    if (session) {
        // 1. TAMBAH PRODUK
        if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("🏷 Kode Produk Utama:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("💰 Harga Utama (Angka):", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("🖼 URL Gambar:", cancelBtn); }
            else if (session.step === 'IMG') { d.image = text; session.step = 'STATS'; ctx.reply("📊 Fake Sold & View (cth: 100 5000):", cancelBtn); }
            else if (session.step === 'STATS') { const [s, v] = text.split(' '); d.sold = parseInt(s)||0; d.view = parseInt(v)||0; session.step = 'DESC'; ctx.reply("📝 Deskripsi:", cancelBtn); }
            else if (session.step === 'DESC') { d.desc = text; session.step = 'CONTENT'; ctx.reply("📦 Stok Utama (Skip jika cuma variasi):", cancelBtn); }
            else if (session.step === 'CONTENT') { d.content = text==='skip'?'':text; session.step = 'VARS'; ctx.reply("🔀 Ada Variasi? (ya/tidak):", cancelBtn); }
            else if (session.step === 'VARS') {
                if (text.toLowerCase() === 'ya') { session.step = 'VAR_NAME'; ctx.reply("🔀 Nama Variasi:", cancelBtn); } 
                else { await db.collection('products').add({...d, createdAt: new Date()}); delete adminSession[userId]; ctx.reply("✅ Produk Tersimpan!"); }
            }
            else if (session.step === 'VAR_NAME') { if(!d.variations) d.variations=[]; session.tempVar = { name: text }; session.step = 'VAR_CODE'; ctx.reply("🏷 Kode Variasi:", cancelBtn); }
            else if (session.step === 'VAR_CODE') { session.tempVar.code = text; session.step = 'VAR_PRICE'; ctx.reply("💰 Harga Variasi:", cancelBtn); }
            else if (session.step === 'VAR_PRICE') { session.tempVar.price = parseInt(text); session.step = 'VAR_CONTENT'; ctx.reply("📦 Stok Variasi:", cancelBtn); }
            else if (session.step === 'VAR_CONTENT') {
                session.tempVar.content = text; d.variations.push(session.tempVar);
                session.step = 'VARS'; ctx.reply("✅ Variasi OK. Ada lagi? (ya/tidak)", cancelBtn);
            }
        }
        
        // 2. EDIT VARIASI
        else if (session.type === 'EDIT_VAR') {
            const { prodId, varIdx, field } = session;
            const docRef = db.collection('products').doc(prodId);
            const snap = await docRef.get();
            let vars = snap.data().variations;
            
            if (field === 'price') vars[varIdx].price = parseInt(text);
            else if (field === 'name') vars[varIdx].name = text;
            else if (field === 'code') vars[varIdx].code = text;
            else if (field === 'content') vars[varIdx].content = text; // Replace stok

            await docRef.update({ variations: vars });
            delete adminSession[userId];
            ctx.reply(`✅ Variasi Updated!`);
        }

        // 3. EDIT PRODUK UTAMA
        else if (session.type === 'EDIT_MAIN') {
            const { prodId, field } = session;
            const update = {};
            if(field === 'price' || field === 'sold' || field === 'view') update[field] = parseInt(text);
            else update[field] = text;
            
            await db.collection('products').doc(prodId).update(update);
            delete adminSession[userId];
            ctx.reply("✅ Data Utama Updated!");
        }

        // 4. LAINNYA
        else if (session.type === 'SET_PAYMENT') { /* ... logic payment ... */ 
             if(session.step === 'BANK') { session.data.bank = text; session.step='NO'; ctx.reply("Nomor:", cancelBtn); }
             else if(session.step === 'NO') { session.data.no = text; session.step='AN'; ctx.reply("Atas Nama:", cancelBtn); }
             else if(session.step === 'AN') { session.data.an = text; session.step='QR'; ctx.reply("URL QRIS (Skip jika tdk ada):", cancelBtn); }
             else if(session.step === 'QR') { 
                 const q = text==='skip'?'':text;
                 const info = `🏦 ${session.data.bank}\n🔢 ${session.data.no}\n👤 ${session.data.an}`;
                 await db.collection('settings').doc('payment').set({info, qris:q});
                 delete adminSession[userId]; ctx.reply("✅ Payment Updated!");
             }
        }
        else if (session.type === 'REPLY_COMPLAIN') {
            await db.collection('orders').doc(session.orderId).update({ adminReply: text, complainResolved: true });
            delete adminSession[userId]; ctx.reply("✅ Terkirim.");
        }
        else if (session.type === 'REVISI') {
            const snap = await db.collection('orders').doc(session.orderId).get();
            const data = snap.data();
            data.items[session.itemIdx].content = text;
            await db.collection('orders').doc(session.orderId).update({ items: data.items });
            delete adminSession[userId]; ctx.reply("✅ Revisi OK.");
            processOrderLogic(session.orderId, data);
        }
        return;
    }

        // 5. MANAJEMEN USER (TOP UP / EDIT)
        else if (session.type === 'SEARCH_USER') {
            // Cari user by Email (Exact match) atau UID
            let snap = await db.collection('users').where('email', '==', text).get();
            if (snap.empty) {
                // Coba cari by UID
                const docRef = await db.collection('users').doc(text).get();
                if (docRef.exists) snap = { docs: [docRef], empty: false };
            }

            if (!snap.empty) {
                const u = snap.docs[0].data();
                const uid = snap.docs[0].id;
                ctx.reply(`👤 *USER DITEMUKAN*\n🆔 ID: \`${uid}\`\n📧 Email: ${u.email || 'Tamu/Anon'}\n💰 Saldo: Rp ${u.balance?.toLocaleString() || 0}\n🎭 Role: ${u.role || 'Member'}`, 
                    Markup.inlineKeyboard([
                        [Markup.button.callback('💵 Top Up Saldo', `topup_${uid}`), Markup.button.callback('💸 Potong Saldo', `deduct_${uid}`)],
                        [Markup.button.callback('🚫 BAN / HAPUS', `ban_user_${uid}`)]
                    ])
                );
                delete adminSession[userId];
            } else {
                ctx.reply("❌ User tidak ditemukan. Pastikan Email/UID benar.");
            }
        }
        else if (session.type === 'TOPUP_USER') {
            const amount = parseInt(text);
            if (isNaN(amount)) return ctx.reply("Harus angka!");
            
            await db.collection('users').doc(session.targetUid).update({
                balance: admin.firestore.FieldValue.increment(amount)
            });
            delete adminSession[userId];
            ctx.reply(`✅ Berhasil Top Up Rp ${amount.toLocaleString()} ke user tersebut.`);
        }
        else if (session.type === 'DEDUCT_USER') {
            const amount = parseInt(text);
            if (isNaN(amount)) return ctx.reply("Harus angka!");
            
            await db.collection('users').doc(session.targetUid).update({
                balance: admin.firestore.FieldValue.increment(-amount)
            });
            delete adminSession[userId];
            ctx.reply(`✅ Saldo dipotong Rp ${amount.toLocaleString()}.`);
        }
    // B. SMART SEARCH (DEEP SEARCH VARIATION)
    // 1. Cek Kode Utama
    let snap = await db.collection('products').where('code', '==', text).get();
    let foundProd = null;

    if (!snap.empty) {
        foundProd = { id: snap.docs[0].id, ...snap.docs[0].data() };
    } else {
        // 2. Cek Kode Variasi (Manual Search - Deep Scan)
        const allProds = await db.collection('products').get();
        allProds.forEach(doc => {
            const p = doc.data();
            if (p.variations && p.variations.some(v => v.code === text)) {
                foundProd = { id: doc.id, ...p };
            }
        });
    }

    if (foundProd) {
        const p = foundProd;
        const mainStok = p.content ? p.content.split('\n').filter(x=>x.trim()).length : 0;
        
        ctx.reply(`🔎 *${p.name}*\n🏷 Kode Utama: ${p.code}\n💰 Rp ${p.price}\n📦 Stok Utama: ${mainStok}\n🔀 ${p.variations?.length||0} Variasi`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✏️ Edit Utama', `menu_edit_main_${p.id}`)],
                [Markup.button.callback('🔀 ATUR VARIASI', `menu_vars_${p.id}`)],
                [Markup.button.callback('🗑️ HAPUS PRODUK', `del_prod_${p.id}`)]
            ])
        });
        return;
    }

    // Cek ID Order
    const orderSnap = await db.collection('orders').doc(text).get();
    if(orderSnap.exists) {
        const o = orderSnap.data();
        ctx.reply(`📦 *ORDER ${orderSnap.id}*\nStatus: ${o.status}\nTotal: ${o.total}`, Markup.inlineKeyboard([[Markup.button.callback('Hapus History', `del_order_${orderSnap.id}`)]]));
        return;
    }

    ctx.reply("❌ Tidak ditemukan.");
});

// --- ACTION HANDLERS ---

// 1. MENU EDIT UTAMA
bot.action(/^menu_edit_main_(.+)$/, (ctx) => {
    const pid = ctx.match[1];
    ctx.editMessageText("✏️ *EDIT DATA UTAMA*", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('Nama', `ed_main_name_${pid}`), Markup.button.callback('Harga', `ed_main_price_${pid}`)],
            [Markup.button.callback('Kode', `ed_main_code_${pid}`), Markup.button.callback('Stok', `ed_main_content_${pid}`)],
            [Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)]
        ])
    });
});

// HANDLER USER MANAGEMENT
bot.action('manage_users', (ctx) => {
    adminSession[ctx.from.id] = { type: 'SEARCH_USER' };
    ctx.reply("🔍 Kirim **EMAIL** atau **UID** user yang mau diedit:", cancelBtn);
});

bot.action(/^topup_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'TOPUP_USER', targetUid: ctx.match[1] };
    ctx.reply("💵 Masukkan nominal Top Up (Angka saja):", cancelBtn);
});

bot.action(/^deduct_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'DEDUCT_USER', targetUid: ctx.match[1] };
    ctx.reply("💸 Masukkan nominal Potongan (Angka saja):", cancelBtn);
});

bot.action(/^ban_user_(.+)$/, async (ctx) => {
    await db.collection('users').doc(ctx.match[1]).delete();
    ctx.editMessageText("🚫 Data User dihapus dari database (Logout paksa).");
});

// 2. MENU VARIASI (LIST)
bot.action(/^menu_vars_(.+)$/, async (ctx) => {
    const pid = ctx.match[1];
    const d = await db.collection('products').doc(pid).get();
    const vars = d.data().variations || [];
    
    if(vars.length === 0) return ctx.reply("Tidak ada variasi.", Markup.inlineKeyboard([[Markup.button.callback('➕ Tambah Variasi', `add_new_var_${pid}`)]]));

    const btns = vars.map((v, i) => [Markup.button.callback(`${v.name} (${v.code})`, `sel_var_${pid}_${i}`)]);
    btns.push([Markup.button.callback('➕ Tambah Variasi', `add_new_var_${pid}`)]);
    btns.push([Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)]);

    ctx.editMessageText("🔀 *PILIH VARIASI UNTUK DIEDIT:*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

// 3. MENU DETAIL VARIASI (EDIT SPECIFIC)
bot.action(/^sel_var_(.+)_(.+)$/, async (ctx) => {
    const [_, pid, idx] = ctx.match;
    const d = await db.collection('products').doc(pid).get();
    const v = d.data().variations[idx];
    const stok = v.content ? v.content.split('\n').filter(x=>x.trim()).length : 0;

    ctx.editMessageText(`🔀 *VARIASI: ${v.name}*\n🏷 ${v.code}\n💰 Rp ${v.price}\n📦 Stok: ${stok}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✏️ Nama', `ed_var_name_${pid}_${idx}`), Markup.button.callback('✏️ Harga', `ed_var_price_${pid}_${idx}`)],
            [Markup.button.callback('✏️ Kode', `ed_var_code_${pid}_${idx}`), Markup.button.callback('📦 Stok', `ed_var_content_${pid}_${idx}`)],
            [Markup.button.callback('🗑️ Hapus Variasi', `del_var_${pid}_${idx}`)],
            [Markup.button.callback('🔙 List Variasi', `menu_vars_${pid}`)]
        ])
    });
});

bot.action(/^ed_var_(.+)_(.+)_(.+)$/, (ctx) => {
    const [_, field, pid, idx] = ctx.match;
    adminSession[ctx.from.id] = { type: 'EDIT_VAR', prodId: pid, varIdx: parseInt(idx), field: field };
    ctx.reply(`Kirim nilai baru untuk Variasi *${field.toUpperCase()}*:`, cancelBtn);
});

// HAPUS VARIASI
bot.action(/^del_var_(.+)_(.+)$/, async (ctx) => {
    const [_, pid, idx] = ctx.match;
    const docRef = db.collection('products').doc(pid);
    const snap = await docRef.get();
    let vars = snap.data().variations;
    vars.splice(parseInt(idx), 1); // Hapus array item
    await docRef.update({ variations: vars });
    ctx.reply("🗑️ Variasi dihapus.");
});

// TAMBAH VARIASI BARU (Ke Produk Lama)
bot.action(/^add_new_var_(.+)$/, (ctx) => {
    // Reuse logic ADD_PROD step VARS? Agak ribet.
    // Kita buat simple session manual saja nanti kalau butuh.
    ctx.reply("ℹ️ Fitur tambah variasi ke produk lama belum aktif di versi ini. Silakan hapus & buat ulang produk jika ingin merombak struktur total.");
});

// UTILS
bot.action(/^back_prod_(.+)$/, async (ctx) => {
    // Kembali ke tampilan awal produk
    const d = await db.collection('products').doc(ctx.match[1]).get();
    const p = d.data();
    ctx.editMessageText(`🔎 *${p.name}*\n🏷 ${p.code}`, Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit Utama', `menu_edit_main_${d.id}`)],
        [Markup.button.callback('🔀 ATUR VARIASI', `menu_vars_${d.id}`)],
        [Markup.button.callback('🗑️ HAPUS PRODUK', `del_prod_${d.id}`)]
    ]));
});

// DEFAULT ACTIONS
bot.action('add_prod', (ctx)=>{ adminSession[ctx.from.id]={type:'ADD_PROD', step:'NAME', data:{}}; ctx.reply("Nama Produk:", cancelBtn); });
bot.action('set_payment', (ctx)=>{ adminSession[ctx.from.id]={type:'SET_PAYMENT', step:'BANK', data:{}}; ctx.reply("Nama Bank:", cancelBtn); });
bot.action('sales_today', async (ctx)=>{ 
    const start=new Date(); start.setHours(0,0,0,0);
    const snap=await db.collection('orders').where('status','==','success').where('createdAt','>=',start).get();
    let t=0, c=0; snap.forEach(d=>{t+=d.data().total;c++}); ctx.reply(`Omset: Rp ${t.toLocaleString()} (${c} Trx)`); 
});
bot.action('list_pending', async (ctx)=>{ const s=await db.collection('orders').where('status','==','pending').get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.data().buyerPhone,`acc_${d.id}`)]); ctx.reply("Pending",Markup.inlineKeyboard(b)); });
bot.action('list_complain', async (ctx)=>{ const s=await db.collection('orders').where('complain','==',true).where('complainResolved','==',false).get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.id,`view_comp_${d.id}`)]); ctx.reply("Komplain",Markup.inlineKeyboard(b)); });

bot.action(/^del_prod_(.+)$/, async (ctx)=>{ await db.collection('products').doc(ctx.match[1]).delete(); ctx.editMessageText("Dihapus."); });
bot.action('cancel_action', (ctx)=>{ delete adminSession[ctx.from.id]; ctx.reply("Batal."); });

app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
