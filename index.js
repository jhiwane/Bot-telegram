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
// 2. LOGIKA STOK & ORDER (CORE)
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
        if (item.content) { items.push(item); msgLog += `✅ ${item.name}: OK\n`; continue; }

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

// C. NOTIFIKASI ORDER SALDO (AUTO SUCCESS)
app.post('/api/notify-order', async (req, res) => {
    const { orderId, buyerPhone, total, items, method } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    
    // Kirim Notif ke Admin (Tanpa Tombol ACC karena sudah Lunas)
    await bot.telegram.sendMessage(ADMIN_ID, 
        `✅ *ORDER LUNAS (SALDO)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}\n\n🚀 *Status: Auto-Processed*`, 
        { parse_mode: 'Markdown' }
    );
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('SERVER JSN-02 READY'));

// ==========================================
// 4. PANEL ADMIN (BOT BRAIN)
// ==========================================

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('👥 KELOLA USER', 'manage_users'), Markup.button.callback('💳 ATUR PEMBAYARAN', 'set_payment')],
    [Markup.button.callback('💰 LAPORAN HARI INI', 'sales_today'), Markup.button.callback('🚨 KOMPLAIN', 'list_complain')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JSN-02*\nKetik Kode Produk / ID Order / Email User.", mainMenu));

// --- LISTENER TEKS (SEARCH & WIZARD) ---
bot.on('text', async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    const text = ctx.message.text.trim();
    const textLower = text.toLowerCase();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    // A. MODE WIZARD (INPUT DATA)
    if (session) {
        // ... (LOGIKA TAMBAH PRODUK - TETAP SAMA AGAR TIDAK HILANG) ...
        if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("🏷 Kode Produk Utama:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("💰 Harga Utama (Angka):", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("🖼 URL Gambar:", cancelBtn); }
            else if (session.step === 'IMG') { d.image = text; session.step = 'STATS'; ctx.reply("📊 Fake Sold & View (cth: 100 5000):", cancelBtn); }
            else if (session.step === 'STATS') { const [s, v] = text.split(' '); d.sold = parseInt(s)||0; d.view = parseInt(v)||0; session.step = 'DESC'; ctx.reply("📝 Deskripsi:", cancelBtn); }
            else if (session.step === 'DESC') { d.desc = text; session.step = 'CONTENT'; ctx.reply("📦 Stok Utama (Skip jika variasi):", cancelBtn); }
            else if (session.step === 'CONTENT') { d.content = text==='skip'?'':text; session.step = 'VARS'; ctx.reply("🔀 Ada Variasi? (ya/tidak):", cancelBtn); }
            else if (session.step === 'VARS') {
                if (text.toLowerCase() === 'ya') { session.step = 'VAR_NAME'; ctx.reply("🔀 Nama Variasi:", cancelBtn); }
                else { await db.collection('products').add({...d, createdAt: new Date()}); delete adminSession[userId]; ctx.reply("✅ Produk Tersimpan!"); }
            }
            else if (session.step === 'VAR_NAME') { if(!d.variations) d.variations=[]; session.tempVar={name:text}; session.step='VAR_CODE'; ctx.reply("🏷 Kode Variasi:", cancelBtn); }
            else if (session.step === 'VAR_CODE') { session.tempVar.code=text; session.step='VAR_PRICE'; ctx.reply("💰 Harga Variasi:", cancelBtn); }
            else if (session.step === 'VAR_PRICE') { session.tempVar.price=parseInt(text); session.step='VAR_CONTENT'; ctx.reply("📦 Stok Variasi:", cancelBtn); }
            else if (session.step === 'VAR_CONTENT') { session.tempVar.content=text; d.variations.push(session.tempVar); session.step='VARS'; ctx.reply("✅ Variasi OK. Ada lagi? (ya/tidak)", cancelBtn); }
        }

        // --- MANAJEMEN USER (SEARCH LOGIC - FIX EMAIL) ---
        else if (session.type === 'SEARCH_USER') {
            try {
                let foundDocs = [];
                const cleanText = text.trim(); // Hapus spasi depan/belakang

                // 1. Cari by Email (Exact Match)
                let snap = await db.collection('users').where('email', '==', cleanText).get();
                
                // 2. Jika tidak ketemu, coba cari by Email (Lowercase conversion - jaga2 user ngetik huruf besar)
                if (snap.empty) {
                     snap = await db.collection('users').where('email', '==', cleanText.toLowerCase()).get();
                }

                if (!snap.empty) foundDocs = snap.docs;
                
                // 3. Cari by UID (Jika email zonk)
                if (foundDocs.length === 0) {
                    const docRef = await db.collection('users').doc(cleanText).get();
                    if (docRef.exists) foundDocs = [docRef];
                }

                if (foundDocs.length > 0) {
                    const u = foundDocs[0].data();
                    const uid = foundDocs[0].id;
                    ctx.reply(
                        `👤 *USER DITEMUKAN*\n\n🆔 ID: \`${uid}\`\n📧 Email: ${u.email || 'Tamu/Anonim'}\n💰 Saldo: Rp ${u.balance?.toLocaleString() || 0}\n🎭 Role: ${u.role || 'Member'}`, 
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('💵 Top Up Saldo', `topup_${uid}`), Markup.button.callback('💸 Potong Saldo', `deduct_${uid}`)],
                                [Markup.button.callback('🚫 HAPUS AKUN', `ban_user_${uid}`)]
                            ])
                        }
                    );
                    delete adminSession[userId]; 
                } else {
                    ctx.reply("❌ User tidak ditemukan.\nTips: Pastikan Email atau UID benar persis.");
                }
            } catch(e) { ctx.reply("Error: " + e.message); }
        }
        // PROSES TOPUP
        else if (session.type === 'TOPUP_USER') {
            const amount = parseInt(text);
            if(isNaN(amount)) return ctx.reply("Harus angka!");
            await db.collection('users').doc(session.targetUid).update({ balance: admin.firestore.FieldValue.increment(amount) });
            delete adminSession[userId];
            ctx.reply(`✅ Berhasil Top Up Rp ${amount.toLocaleString()}`);
        }
        // PROSES POTONG
        else if (session.type === 'DEDUCT_USER') {
            const amount = parseInt(text);
            if(isNaN(amount)) return ctx.reply("Harus angka!");
            await db.collection('users').doc(session.targetUid).update({ balance: admin.firestore.FieldValue.increment(-amount) });
            delete adminSession[userId];
            ctx.reply(`✅ Berhasil Potong Rp ${amount.toLocaleString()}`);
        }

        // --- FITUR LAIN (EDIT, PAYMENT, ETC) ---
        else if (session.type === 'SET_PAYMENT') {
            if(session.step === 'BANK') { session.data.bank=text; session.step='NO'; ctx.reply("Nomor:", cancelBtn); }
            else if(session.step === 'NO') { session.data.no=text; session.step='AN'; ctx.reply("Atas Nama:", cancelBtn); }
            else if(session.step === 'AN') { session.data.an=text; session.step='QR'; ctx.reply("URL QRIS (skip/url):", cancelBtn); }
            else if(session.step === 'QR') { await db.collection('settings').doc('payment').set({info:`🏦 ${session.data.bank}\n🔢 ${session.data.no}\n👤 ${session.data.an}`, qris:text==='skip'?'':text}); delete adminSession[userId]; ctx.reply("✅ Saved."); }
        }
        else if (session.type === 'EDIT_MAIN') { await db.collection('products').doc(session.prodId).update({[session.field]:(session.field==='price'||session.field.includes('sold')||session.field.includes('view'))?parseInt(text):text}); delete adminSession[userId]; ctx.reply("Updated."); }
        else if (session.type === 'EDIT_VAR') { const docRef = db.collection('products').doc(session.prodId); const snap = await docRef.get(); let vars = snap.data().variations; vars[session.varIdx][session.field] = (session.field==='price')?parseInt(text):text; await docRef.update({ variations: vars }); delete adminSession[userId]; ctx.reply("Variasi Updated."); }
        else if (session.type === 'REPLY_COMPLAIN') { await db.collection('orders').doc(session.orderId).update({adminReply:text, complainResolved:true}); delete adminSession[userId]; ctx.reply("Terkirim."); }
        else if (session.type === 'REVISI') { const d = await db.collection('orders').doc(session.orderId).get(); const data = d.data(); data.items[session.itemIdx].content = text; await db.collection('orders').doc(session.orderId).update({items:data.items}); delete adminSession[userId]; ctx.reply("OK."); processOrderLogic(session.orderId, data); }
        
        return;
    }

    // B. LOGIKA PENCARIAN (Smart Search)
    try {
        // Cek ID Order
        const orderSnap = await db.collection('orders').doc(text).get();
        if (orderSnap.exists) {
            const o = orderSnap.data();
            const items = o.items.map(i=>`${i.name} x${i.qty}`).join(', ');
            return ctx.reply(`📦 *ORDER ${orderSnap.id}*\nStatus: ${o.status}\nUser: ${o.buyerPhone}\nItem: ${items}\nTotal: ${o.total}`, {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('🗑 HAPUS', `del_order_${orderSnap.id}`)]])});
        }

        // Cek Produk (Deep Scan)
        const allProds = await db.collection('products').get();
        let found = null;
        allProds.forEach(doc => {
            const p = doc.data();
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
                    [Markup.button.callback('🗑️ HAPUS PRODUK', `del_prod_${found.id}`)]
                ])
            });
        }
        ctx.reply("❌ Tidak ditemukan.");
    } catch (e) { ctx.reply("Eror: " + e.message); }
});

// --- ACTION HANDLERS ---

// A. USER MANAGEMENT HANDLERS
bot.action('manage_users', (ctx) => {
    adminSession[ctx.from.id] = { type: 'SEARCH_USER' };
    ctx.reply("🔍 Kirim **EMAIL** atau **UID** User:", cancelBtn);
});
bot.action(/^topup_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'TOPUP_USER', targetUid: ctx.match[1] };
    ctx.reply("💵 Masukkan Nominal Top Up (Angka):", cancelBtn);
});
bot.action(/^deduct_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'DEDUCT_USER', targetUid: ctx.match[1] };
    ctx.reply("💸 Masukkan Nominal Potongan (Angka):", cancelBtn);
});
bot.action(/^ban_user_(.+)$/, async (ctx) => {
    await db.collection('users').doc(ctx.match[1]).delete();
    ctx.editMessageText("🚫 User berhasil dihapus/ban.");
});

// B. SALES REPORT (FIXED LOGIC)
bot.action('sales_today', async (ctx) => {
    try {
        ctx.reply("⏳ Menghitung...");
        
        // Ambil waktu hari ini 00:00 (Local Server Time)
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()); 

        // Query AMAN (Tanpa Index Kompleks)
        const snap = await db.collection('orders')
            .orderBy('createdAt', 'desc')
            .limit(200) // Ambil 200 transaksi terakhir untuk dicek
            .get();

        let totalOmset = 0;
        let totalTrx = 0;
        let totalItem = 0;

        snap.forEach(doc => {
            const data = doc.data();
            // Hanya proses yang statusnya 'success'
            if (data.status === 'success') {
                // Konversi tanggal aman (Support Timestamp Firebase & Date JS)
                let orderDate;
                if (data.createdAt && typeof data.createdAt.toDate === 'function') {
                    orderDate = data.createdAt.toDate();
                } else {
                    orderDate = new Date(data.createdAt);
                }

                // Cek apakah tanggalnya >= startOfDay (Hari ini)
                if (orderDate >= startOfDay) {
                    totalOmset += data.total;
                    totalTrx += 1;
                    if(data.items) data.items.forEach(i => totalItem += i.qty);
                }
            }
        });

        ctx.reply(`💰 *LAPORAN HARI INI*\n(${startOfDay.toLocaleDateString()})\n\n💵 Omset: Rp ${totalOmset.toLocaleString()}\n🛒 Transaksi: ${totalTrx}\n📦 Item Terjual: ${totalItem}`, {parse_mode:'Markdown'});

    } catch (e) {
        console.error(e);
        ctx.reply("⚠️ Gagal hitung sales. Error: " + e.message);
    }
});

// ... (SISA KODE HANDLER EDIT, ADD, PAYMENT, DLL - SAMA SEPERTI SEBELUMNYA) ...
// Saya singkat agar tidak kepanjangan, karena logika Edit/Add/Delete produk tidak berubah dari yang sukses sebelumnya.
bot.action('add_prod', (ctx)=>{ adminSession[ctx.from.id]={type:'ADD_PROD', step:'NAME', data:{}}; ctx.reply("Nama Produk:", cancelBtn); });
bot.action('set_payment', (ctx)=>{ adminSession[ctx.from.id]={type:'SET_PAYMENT', step:'BANK', data:{}}; ctx.reply("Nama Bank:", cancelBtn); });
bot.action(/^menu_edit_main_(.+)$/, (ctx) => { const pid = ctx.match[1]; ctx.editMessageText("✏️ *EDIT DATA UTAMA*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ [Markup.button.callback('Nama', `ed_main_name_${pid}`), Markup.button.callback('Harga', `ed_main_price_${pid}`)], [Markup.button.callback('Kode', `ed_main_code_${pid}`), Markup.button.callback('Stok', `ed_main_content_${pid}`)], [Markup.button.callback('Fake Sold', `ed_main_sold_${pid}`), Markup.button.callback('Fake View', `ed_main_view_${pid}`)], [Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)] ])}); });
bot.action(/^ed_main_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_MAIN', prodId: ctx.match[2], field: ctx.match[1] }; ctx.reply(`Kirim nilai baru untuk *${ctx.match[1].toUpperCase()}*:`, cancelBtn); });
bot.action(/^menu_vars_(.+)$/, async (ctx) => { const pid = ctx.match[1]; const d = await db.collection('products').doc(pid).get(); const vars = d.data().variations || []; const btns = vars.map((v, i) => [Markup.button.callback(`${v.name} (${v.code})`, `sel_var_${pid}_${i}`)]); btns.push([Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)]); ctx.editMessageText("🔀 *PILIH VARIASI:*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) }); });
bot.action(/^sel_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const d = await db.collection('products').doc(pid).get(); const v = d.data().variations[idx]; const stok = v.content ? v.content.split('\n').filter(x=>x.trim()).length : 0; ctx.editMessageText(`🔀 *VARIASI: ${v.name}*\n🏷 ${v.code} | Rp ${v.price}\n📦 Stok: ${stok}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ [Markup.button.callback('Nama', `ed_var_name_${pid}_${idx}`), Markup.button.callback('Harga', `ed_var_price_${pid}_${idx}`)], [Markup.button.callback('Kode', `ed_var_code_${pid}_${idx}`), Markup.button.callback('Stok', `ed_var_content_${pid}_${idx}`)], [Markup.button.callback('🗑️ Hapus', `del_var_${pid}_${idx}`), Markup.button.callback('🔙 List', `menu_vars_${pid}`)] ])}); });
bot.action(/^ed_var_(.+)_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_VAR', prodId: ctx.match[2], varIdx: parseInt(ctx.match[3]), field: ctx.match[1] }; ctx.reply(`Kirim nilai baru untuk Variasi *${ctx.match[1].toUpperCase()}*:`, cancelBtn); });
bot.action(/^del_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const docRef = db.collection('products').doc(pid); const snap = await docRef.get(); let vars = snap.data().variations; vars.splice(parseInt(idx), 1); await docRef.update({ variations: vars }); ctx.reply("🗑️ Variasi dihapus."); });
bot.action(/^back_prod_(.+)$/, async (ctx) => { const d = await db.collection('products').doc(ctx.match[1]).get(); const p = d.data(); ctx.editMessageText(`🔎 *${p.name}*\n🏷 ${p.code}`, Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Utama', `menu_edit_main_${d.id}`)],[Markup.button.callback('🔀 ATUR VARIASI', `menu_vars_${d.id}`)],[Markup.button.callback('🗑️ HAPUS PRODUK', `del_prod_${d.id}`)]])); });
bot.action(/^del_prod_(.+)$/, async (ctx)=>{ await db.collection('products').doc(ctx.match[1]).delete(); ctx.editMessageText("Produk Dihapus."); });
bot.action(/^del_order_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).delete(); ctx.editMessageText("History Dihapus."); });
bot.action('cancel_action', (ctx)=>{ delete adminSession[ctx.from.id]; ctx.reply("Batal."); });
bot.action('list_pending', async (ctx)=>{ const s=await db.collection('orders').where('status','==','pending').get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.data().buyerPhone,`acc_${d.id}`)]); ctx.reply("Pending",Markup.inlineKeyboard(b)); });
bot.action(/^acc_(.+)$/, async (ctx) => { ctx.reply("Proses..."); const d = await db.collection('orders').doc(ctx.match[1]).get(); if(d.exists) processOrderLogic(ctx.match[1], d.data()); });
bot.action(/^tolak_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({status:'failed'}); ctx.editMessageText("Ditolak."); });
bot.action(/^rev_(.+)_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'REVISI', orderId:ctx.match[1], itemIdx:parseInt(ctx.match[2])}; ctx.reply("Isi Manual:", cancelBtn); });
bot.action('list_complain', async (ctx)=>{ const s=await db.collection('orders').where('complain','==',true).where('complainResolved','==',false).get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.id.slice(0,5),`view_comp_${d.id}`)]); ctx.reply("Komplain",Markup.inlineKeyboard(b)); });
bot.action(/^view_comp_(.+)$/, async (ctx)=>{ const d = await db.collection('orders').doc(ctx.match[1]).get(); ctx.reply(`Msg: ${d.data().userComplainText}`, Markup.inlineKeyboard([[Markup.button.callback('BALAS', `reply_comp_${d.id}`), Markup.button.callback('SELESAI', `solve_${d.id}`)]])); });
bot.action(/^reply_comp_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'REPLY_COMPLAIN', orderId:ctx.match[1]}; ctx.reply("Balasan:", cancelBtn); });
bot.action(/^solve_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({complainResolved:true}); ctx.editMessageText("Done."); });

// START
app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
