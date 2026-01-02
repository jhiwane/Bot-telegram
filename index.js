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
const adminSession = {}; // Ingatan Bot untuk sesi input

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
// 2. LOGIKA STOK & ORDER (CORE ENGINE)
// ==========================================

// FUNGSI: Cek & Potong Stok dari Database
const processStock = async (productId, variantName, qtyNeeded) => {
    const docRef = db.collection('products').doc(productId);
    
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        
        const data = doc.data();
        let contentPool = "";
        let isVariant = false;
        let variantIndex = -1;

        // Cek apakah ini Variasi atau Produk Utama
        if (variantName && data.variations) {
            variantIndex = data.variations.findIndex(v => v.name === variantName);
            if (variantIndex !== -1) {
                contentPool = data.variations[variantIndex].content || "";
                isVariant = true;
            }
        } else {
            contentPool = data.content || "";
        }

        // Logic Split Stok (Per Baris / Enter)
        let stocks = contentPool.split('\n').filter(s => s.trim().length > 0);
        
        if (stocks.length >= qtyNeeded) {
            // Stok Cukup
            const taken = stocks.slice(0, qtyNeeded); 
            const remaining = stocks.slice(qtyNeeded).join('\n');
            const inc = parseInt(qtyNeeded);

            // Update Database
            if (isVariant) {
                data.variations[variantIndex].content = remaining;
                t.update(docRef, { variations: data.variations, sold: (data.sold || 0) + inc });
            } else {
                t.update(docRef, { content: remaining, sold: (data.sold || 0) + inc });
            }
            
            return { success: true, data: taken.join('\n'), currentStock: stocks.length };
        } else {
            // Stok Kurang
            return { success: false, currentStock: stocks.length };
        }
    });
};

// FUNGSI: Proses Order (Otomatis / Manual / Saldo)
const processOrderLogic = async (orderId, orderData) => {
    let items = [], 
        allComplete = true,
        msgLog = "", 
        revBtns = [];

    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];
        
        // Skip jika konten sudah terisi (misal hasil revisi manual)
        if (item.content) { 
            items.push(item); 
            msgLog += `✅ ${item.name}: SUKSES (Manual)\n`; 
            continue; 
        }

        try {
            // Proses pemotongan stok
            const result = await processStock(item.id, item.variantName, item.qty);
            
            if (result && result.success) {
                // SUKSES PENUH
                items.push({ ...item, content: result.data });
                msgLog += `✅ ${item.name}: SUKSES\n`;
            } 
            else if (result && !result.success && result.currentStock > 0) {
                // PARTIAL (Stok Ada Dikit)
                const partialRes = await processStock(item.id, item.variantName, result.currentStock);
                const sisa = item.qty - result.currentStock;
                const txt = partialRes.data + `\n\n[...MENUNGGU ${sisa} LAGI...]`;
                
                items.push({ ...item, content: txt });
                allComplete = false;
                msgLog += `⚠️ ${item.name}: PARTIAL (Dapat ${result.currentStock}, Kurang ${sisa})\n`;
                revBtns.push([Markup.button.callback(`🔧 ISI SISA: ${item.name}`, `rev_${orderId}_${i}`)]);
            }
            else {
                // GAGAL TOTAL (Stok Kosong)
                items.push({ ...item, content: null });
                allComplete = false;
                msgLog += `❌ ${item.name}: STOK KOSONG\n`;
                revBtns.push([Markup.button.callback(`🔧 ISI: ${item.name}`, `rev_${orderId}_${i}`)]);
            }
        } catch (e) {
            console.error(e);
            items.push({ ...item, content: null });
            allComplete = false;
            msgLog += `❌ ${item.name}: ERROR DB\n`;
        }
    }

    // Update Order di Firebase
    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    // Lapor Admin
    if (!allComplete) {
        bot.telegram.sendMessage(ADMIN_ID, 
            `⚠️ *ORDER ${orderId} BUTUH REVISI*\n${msgLog}`, 
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) }
        );
    } else {
        // Jika sukses, tetap kasih tombol edit (buat jaga-jaga ada akun error)
        bot.telegram.sendMessage(ADMIN_ID, 
            `✅ *ORDER ${orderId} SELESAI*\n${msgLog}`, 
            { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('🛠 MENU EDIT ORDER INI', `menu_edit_ord_${orderId}`)]])
            }
        );
    }
};

// ==========================================
// 3. API WEBHOOK (WEB -> BOT)
// ==========================================

// A. KONFIRMASI PEMBAYARAN MANUAL
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    
    bot.telegram.sendMessage(ADMIN_ID, 
        `🔔 *ORDER MASUK (MANUAL)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('⚡ PROSES', `acc_${orderId}`)],
            [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
        ])
    );
    res.json({ status: 'ok' });
});

// B. KOMPLAIN DARI USER
app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    
    await db.collection('orders').doc(orderId).update({ 
        complain: true, 
        complainResolved: false, 
        userComplainText: message 
    });

    bot.telegram.sendMessage(ADMIN_ID, 
        `🚨 *KOMPLAIN MASUK!* 🚨\n🆔 \`${orderId}\`\n💬 "${message}"`, 
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

// C. NOTIFIKASI ORDER SALDO (AUTO SUCCESS)
app.post('/api/notify-order', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    
    // Kirim Laporan ke Bot
    await bot.telegram.sendMessage(ADMIN_ID, 
        `✅ *ORDER LUNAS (SALDO)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}\n\n🚀 *Status: Memproses Stok...*`, 
        { parse_mode: 'Markdown' }
    );

    // LANGSUNG JALANKAN LOGIKA STOK
    const docRef = db.collection('orders').doc(orderId);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
        await processOrderLogic(orderId, docSnap.data());
    }

    res.json({ status: 'ok' });
});

// Endpoint Cek Server
app.get('/', (req, res) => res.send('SERVER JSN-02 READY'));

// ==========================================
// 4. BOT BRAIN (PANEL ADMIN)
// ==========================================

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('👥 KELOLA USER', 'manage_users'), Markup.button.callback('💳 ATUR PEMBAYARAN', 'set_payment')],
    [Markup.button.callback('🎨 GANTI BACKGROUND', 'set_bg')], // <-- BARU
    [Markup.button.callback('💰 LAPORAN HARI INI', 'sales_today'), Markup.button.callback('🚨 KOMPLAIN', 'list_complain')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JSN-02*\nKetik Kode Produk / ID Order / Email User.", mainMenu));

// --- LISTENER TEKS (SEARCH & WIZARD) ---
// Note: Menggunakan bot.on(['text', 'photo']) untuk menangani input gambar juga
bot.on(['text', 'photo'], async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    
    // Handle text input or caption if photo
    const text = ctx.message.text ? ctx.message.text.trim() : (ctx.message.caption ? ctx.message.caption.trim() : '');
    const textLower = text.toLowerCase();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    // Helper untuk mengambil URL/File ID gambar
    const getPhoto = () => {
        if (ctx.message.photo) {
            // Ambil file_id resolusi terbesar
            return ctx.message.photo[ctx.message.photo.length - 1].file_id;
        }
        return text; // Jika user kirim URL text
    };

    // A. JIKA SEDANG DALAM SESI INPUT (WIZARD)
    if (session) {
        
        // 1. REVISI & EDIT BARIS (FEATURE BARU)
        if (session.type === 'REVISI') {
            // Cek apakah admin mengetik ANGKA (untuk edit baris spesifik)
            if (!isNaN(text) && parseInt(text) > 0) {
                session.targetLine = parseInt(text) - 1; // Array index mulai dari 0
                session.type = 'REVISI_LINE_INPUT'; // Pindah state
                ctx.reply(`🔧 Oke, kirim data baru untuk **BARIS #${text}**:`, cancelBtn);
            } else {
                // Jika teks biasa, berarti REPLACE ALL (Timpa Semua)
                const d = await db.collection('orders').doc(session.orderId).get();
                const data = d.data();
                data.items[session.itemIdx].content = text;
                await db.collection('orders').doc(session.orderId).update({ items: data.items });
                delete adminSession[userId];
                ctx.reply("✅ Data item berhasil ditimpa semua.");
                processOrderLogic(session.orderId, data);
            }
        }
        else if (session.type === 'REVISI_LINE_INPUT') {
            const d = await db.collection('orders').doc(session.orderId).get();
            const data = d.data();
            const currentItem = data.items[session.itemIdx];
            
            let lines = currentItem.content ? currentItem.content.split('\n') : [];
            
            if (lines[session.targetLine] !== undefined) {
                lines[session.targetLine] = text; // Update baris itu saja
                currentItem.content = lines.join('\n'); // Gabung lagi
                
                await db.collection('orders').doc(session.orderId).update({ items: data.items });
                delete adminSession[userId];
                ctx.reply(`✅ Baris #${session.targetLine + 1} berhasil diupdate!`);
            } else {
                delete adminSession[userId];
                ctx.reply("❌ Nomor baris tidak valid.");
            }
        }

        // 2. TAMBAH PRODUK (LENGKAP)
        else if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("🏷 Kode Produk Utama:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("💰 Harga Utama (Angka):", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("🖼 Kirim **GAMBAR** atau URL Gambar:", cancelBtn); }
            else if (session.step === 'IMG') { 
                d.image = getPhoto(); // Bisa terima file foto atau URL teks
                session.step = 'STATS'; 
                ctx.reply("📊 Fake Sold & View (cth: 100 5000):", cancelBtn); 
            }
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
            else if (session.step === 'VAR_CONTENT') {
                session.tempVar.content=text; d.variations.push(session.tempVar); session.step='VARS'; ctx.reply("✅ Variasi OK. Ada lagi? (ya/tidak)", cancelBtn);
            }
        }

        // 3. SEARCH USER (FIX EMAIL)
        else if (session.type === 'SEARCH_USER') {
            try {
                let foundDocs = [];
                const cleanText = text.trim(); 
                let snap = await db.collection('users').where('email', '==', cleanText).get();
                if (snap.empty) snap = await db.collection('users').where('email', '==', cleanText.toLowerCase()).get();
                if (!snap.empty) foundDocs = snap.docs;
                if (foundDocs.length === 0) { const r = await db.collection('users').doc(cleanText).get(); if(r.exists) foundDocs=[r]; }
                
                if (foundDocs.length > 0) {
                    const u = foundDocs[0].data(); const uid = foundDocs[0].id;
                    ctx.reply(`👤 *USER FOUND*\nID: \`${uid}\`\nEmail: ${u.email||'Anon'}\n💰 Saldo: ${u.balance}`, Markup.inlineKeyboard([[Markup.button.callback('TopUp', `topup_${uid}`), Markup.button.callback('Potong', `deduct_${uid}`)],[Markup.button.callback('Hapus', `ban_user_${uid}`)]]));
                    delete adminSession[userId];
                } else ctx.reply("❌ User tidak ketemu.");
            } catch(e) { ctx.reply("Eror: "+e.message); }
        }
        else if (session.type === 'TOPUP_USER') { await db.collection('users').doc(session.targetUid).update({balance:admin.firestore.FieldValue.increment(parseInt(text))}); delete adminSession[userId]; ctx.reply("✅ TopUp Sukses."); }
        else if (session.type === 'DEDUCT_USER') { await db.collection('users').doc(session.targetUid).update({balance:admin.firestore.FieldValue.increment(-parseInt(text))}); delete adminSession[userId]; ctx.reply("✅ Potong Sukses."); }

        // 4. LAINNYA
        else if (session.type === 'SET_PAYMENT') {
            if(session.step === 'BANK') { session.data.bank=text; session.step='NO'; ctx.reply("Nomor:", cancelBtn); }
            else if(session.step === 'NO') { session.data.no=text; session.step='AN'; ctx.reply("Atas Nama:", cancelBtn); }
            else if(session.step === 'AN') { session.data.an=text; session.step='QR'; ctx.reply("Kirim **GAMBAR QRIS** atau URL (skip/url):", cancelBtn); }
            else if(session.step === 'QR') { 
                const qris = getPhoto() === 'skip' ? '' : getPhoto();
                await db.collection('settings').doc('payment').set({info:`🏦 ${session.data.bank}\n🔢 ${session.data.no}\n👤 ${session.data.an}`, qris: qris}); 
                delete adminSession[userId]; ctx.reply("✅ Saved."); 
            }
        }
        else if (session.type === 'EDIT_MAIN') { await db.collection('products').doc(session.prodId).update({[session.field]:(session.field.includes('price')||session.field.includes('sold')||session.field.includes('view'))?parseInt(text):text}); delete adminSession[userId]; ctx.reply("Updated."); }
        else if (session.type === 'EDIT_VAR') { const ref=db.collection('products').doc(session.prodId); const s=await ref.get(); let v=s.data().variations; v[session.varIdx][session.field]=(session.field==='price')?parseInt(text):text; await ref.update({variations:v}); delete adminSession[userId]; ctx.reply("Variasi Updated."); }
        else if (session.type === 'REPLY_COMPLAIN') { await db.collection('orders').doc(session.orderId).update({adminReply:text, complainResolved:true}); delete adminSession[userId]; ctx.reply("Terkirim."); }
        
        return;

        // 5. SETTING BACKGROUND
        else if (session.type === 'SET_BG') {
            await db.collection('settings').doc('layout').set({ backgroundUrl: getPhoto() }, { merge: true });
            delete adminSession[userId];
            ctx.reply("✅ Background Website Berhasil Diganti!");
        }
    }

    // B. LOGIKA PENCARIAN (Smart Search) - Hanya jika ada teks
    if (text) {
        try {
            // Cek ID Order
            const orderSnap = await db.collection('orders').doc(text).get();
            if (orderSnap.exists) {
                const o = orderSnap.data();
                const items = o.items.map(i=>`${i.name} x${i.qty}`).join(', ');
                return ctx.reply(`📦 *ORDER ${orderSnap.id}*\nStatus: ${o.status}\nUser: ${o.buyerPhone}\nItem: ${items}\nTotal: ${o.total}`, {parse_mode:'Markdown',...Markup.inlineKeyboard([
                    [Markup.button.callback('🛠 MENU EDIT / REVISI', `menu_edit_ord_${orderSnap.id}`)],
                    [Markup.button.callback('🗑 HAPUS', `del_order_${orderSnap.id}`)]
                ])});
            }

            // Cek Produk (Deep Scan)
            const allProds = await db.collection('products').get();
            let found = null;
            allProds.forEach(doc => {
                const p = doc.data();
                if ((p.code && p.code.toLowerCase() === textLower) || (p.variations && p.variations.some(v => v.code && v.code.toLowerCase() === textLower))) found = { id: doc.id, ...p };
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
    }
});

// --- ACTION HANDLERS (FULL LIST) ---
bot.action('set_bg', (ctx) => {
    adminSession[ctx.from.id] = { type: 'SET_BG' };
    ctx.reply("🖼 Kirim **URL GAMBAR / GIF** untuk background website:", cancelBtn);
});
// User Management
bot.action('manage_users', (ctx) => { adminSession[ctx.from.id] = { type: 'SEARCH_USER' }; ctx.reply("🔍 Kirim **EMAIL** atau **UID** User:", cancelBtn); });
bot.action(/^topup_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'TOPUP_USER', targetUid: ctx.match[1] }; ctx.reply("💵 Nominal Top Up (Angka):", cancelBtn); });
bot.action(/^deduct_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'DEDUCT_USER', targetUid: ctx.match[1] }; ctx.reply("💸 Nominal Potong (Angka):", cancelBtn); });
bot.action(/^ban_user_(.+)$/, async (ctx) => { await db.collection('users').doc(ctx.match[1]).delete(); ctx.editMessageText("🚫 User diban."); });

// Sales Report (Fixed)
bot.action('sales_today', async (ctx) => {
    try {
        ctx.reply("⏳ Menghitung...");
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()); 
        const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(200).get(); // Limit 200 biar aman
        
        let totalOmset = 0, totalTrx = 0, totalItem = 0;
        snap.forEach(doc => {
            const data = doc.data();
            if (data.status === 'success') {
                const orderDate = data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt);
                if (orderDate >= startOfDay) {
                    totalOmset += data.total; totalTrx += 1;
                    if(data.items) data.items.forEach(i => totalItem += i.qty);
                }
            }
        });
        ctx.reply(`💰 *LAPORAN HARI INI*\n\n💵 Omset: Rp ${totalOmset.toLocaleString()}\n🛒 Transaksi: ${totalTrx}\n📦 Item Terjual: ${totalItem}`, {parse_mode:'Markdown'});
    } catch (e) { ctx.reply("⚠️ Gagal hitung sales: " + e.message); }
});

// Menu Edit Utama
bot.action(/^menu_edit_main_(.+)$/, (ctx) => { 
    const pid = ctx.match[1]; 
    ctx.editMessageText("✏️ *EDIT DATA UTAMA*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ 
        [Markup.button.callback('Nama', `ed_main_name_${pid}`), Markup.button.callback('Harga', `ed_main_price_${pid}`)], 
        [Markup.button.callback('Kode', `ed_main_code_${pid}`), Markup.button.callback('Stok', `ed_main_content_${pid}`)], 
        [Markup.button.callback('Fake Sold', `ed_main_sold_${pid}`), Markup.button.callback('Fake View', `ed_main_view_${pid}`)], 
        [Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)] 
    ])}); 
});
bot.action(/^ed_main_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_MAIN', prodId: ctx.match[2], field: ctx.match[1] }; ctx.reply(`Kirim nilai baru untuk *${ctx.match[1].toUpperCase()}*:`, cancelBtn); });

// Menu Variasi
bot.action(/^menu_vars_(.+)$/, async (ctx) => { 
    const pid = ctx.match[1]; const d = await db.collection('products').doc(pid).get(); 
    const vars = d.data().variations || []; 
    const btns = vars.map((v, i) => [Markup.button.callback(`${v.name} (${v.code})`, `sel_var_${pid}_${i}`)]); 
    btns.push([Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)]); 
    ctx.editMessageText("🔀 *PILIH VARIASI:*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) }); 
});
bot.action(/^sel_var_(.+)_(.+)$/, async (ctx) => { 
    const [_, pid, idx] = ctx.match; const d = await db.collection('products').doc(pid).get(); const v = d.data().variations[idx]; const stok = v.content ? v.content.split('\n').filter(x=>x.trim()).length : 0; 
    ctx.editMessageText(`🔀 *VARIASI: ${v.name}*\n🏷 ${v.code} | Rp ${v.price}\n📦 Stok: ${stok}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ 
        [Markup.button.callback('Nama', `ed_var_name_${pid}_${idx}`), Markup.button.callback('Harga', `ed_var_price_${pid}_${idx}`)], 
        [Markup.button.callback('Kode', `ed_var_code_${pid}_${idx}`), Markup.button.callback('Stok', `ed_var_content_${pid}_${idx}`)], 
        [Markup.button.callback('🗑️ Hapus', `del_var_${pid}_${idx}`), Markup.button.callback('🔙 List', `menu_vars_${pid}`)] 
    ])}); 
});
bot.action(/^ed_var_(.+)_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_VAR', prodId: ctx.match[2], varIdx: parseInt(ctx.match[3]), field: ctx.match[1] }; ctx.reply(`Kirim nilai baru untuk Variasi *${ctx.match[1].toUpperCase()}*:`, cancelBtn); });
bot.action(/^del_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const ref = db.collection('products').doc(pid); const s = await ref.get(); let v = s.data().variations; v.splice(parseInt(idx), 1); await ref.update({ variations: v }); ctx.reply("🗑️ Variasi dihapus."); });

// Menu Order Edit
bot.action(/^menu_edit_ord_(.+)$/, async (ctx) => {
    const oid = ctx.match[1];
    const doc = await db.collection('orders').doc(oid).get();
    const items = doc.data().items;
    const btns = items.map((item, idx) => [Markup.button.callback(`✏️ EDIT: ${item.name}`, `rev_${oid}_${idx}`)]);
    ctx.reply(`🛠 Pilih item yang mau direvisi:`, Markup.inlineKeyboard(btns));
});
bot.action(/^rev_(.+)_(.+)$/, async (ctx)=>{ 
    const orderId = ctx.match[1]; const itemIdx = parseInt(ctx.match[2]);
    const d = await db.collection('orders').doc(orderId).get(); const item = d.data().items[itemIdx];
    let msg = `🔧 *EDIT ITEM: ${item.name}*\n\nData saat ini:\n`;
    const lines = item.content ? item.content.split('\n') : [];
    lines.forEach((l, i) => msg += `*${i+1}.* ${l.substring(0, 30)}...\n`);
    msg += `\n👉 *OPSI:* Kirim ANGKA (1, 2) untuk ganti baris, atau TEKS untuk timpa semua.`;
    adminSession[ctx.from.id]={type:'REVISI', orderId, itemIdx}; ctx.reply(msg, {parse_mode:'Markdown', ...cancelBtn}); 
});

// Lainnya
bot.action('add_prod', (ctx)=>{ adminSession[ctx.from.id]={type:'ADD_PROD', step:'NAME', data:{}}; ctx.reply("Nama Produk:", cancelBtn); });
bot.action('set_payment', (ctx)=>{ adminSession[ctx.from.id]={type:'SET_PAYMENT', step:'BANK', data:{}}; ctx.reply("Nama Bank:", cancelBtn); });
bot.action('list_pending', async (ctx)=>{ const s=await db.collection('orders').where('status','==','pending').get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.data().buyerPhone,`acc_${d.id}`)]); ctx.reply("Pending",Markup.inlineKeyboard(b)); });
bot.action(/^acc_(.+)$/, async (ctx) => { ctx.reply("Proses..."); const d = await db.collection('orders').doc(ctx.match[1]).get(); if(d.exists) processOrderLogic(ctx.match[1], d.data()); });
bot.action(/^tolak_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({status:'failed'}); ctx.editMessageText("Ditolak."); });
bot.action('list_complain', async (ctx)=>{ const s=await db.collection('orders').where('complain','==',true).where('complainResolved','==',false).get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.id.slice(0,5),`view_comp_${d.id}`)]); ctx.reply("Komplain",Markup.inlineKeyboard(b)); });
bot.action(/^view_comp_(.+)$/, async (ctx)=>{ const d = await db.collection('orders').doc(ctx.match[1]).get(); ctx.reply(`Msg: ${d.data().userComplainText}`, Markup.inlineKeyboard([[Markup.button.callback('BALAS', `reply_comp_${d.id}`), Markup.button.callback('SELESAI', `solve_${d.id}`)]])); });
bot.action(/^reply_comp_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'REPLY_COMPLAIN', orderId:ctx.match[1]}; ctx.reply("Balasan:", cancelBtn); });
bot.action(/^solve_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({complainResolved:true}); ctx.editMessageText("Done."); });
bot.action(/^back_prod_(.+)$/, async (ctx) => { const d = await db.collection('products').doc(ctx.match[1]).get(); const p = d.data(); ctx.editMessageText(`🔎 *${p.name}*\n🏷 ${p.code}`, Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Utama', `menu_edit_main_${d.id}`)],[Markup.button.callback('🔀 ATUR VARIASI', `menu_vars_${d.id}`)],[Markup.button.callback('🗑️ HAPUS PRODUK', `del_prod_${d.id}`)]])); });
bot.action(/^del_prod_(.+)$/, async (ctx)=>{ await db.collection('products').doc(ctx.match[1]).delete(); ctx.editMessageText("Produk Dihapus."); });
bot.action(/^del_order_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).delete(); ctx.editMessageText("History Dihapus."); });
bot.action('cancel_action', (ctx)=>{ delete adminSession[ctx.from.id]; ctx.reply("Batal."); });

app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
