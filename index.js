const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// ==========================================
// 1. SETUP SERVER (SERVER FIRST -> ANTI CRASH)
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_ID;
const adminSession = {}; // Memory Bot

// --- FIREBASE ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) { console.error("❌ Firebase Error:", error.message); }
const db = admin.firestore();

// --- BOT TELEGRAM ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// ==========================================
// 2. LOGIKA STOK CERDAS (PER BARIS)
// ==========================================
const processStock = async (productId, variantName, qtyNeeded) => {
    const docRef = db.collection('products').doc(productId);
    
    // Gunakan Transaction agar stok tidak tabrakan saat ada yang beli barengan
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        
        const data = doc.data();
        let contentPool = "";
        let isVariant = false;
        let variantIndex = -1;

        // Cek Variasi vs Utama
        if (variantName && data.variations) {
            variantIndex = data.variations.findIndex(v => v.name === variantName);
            if (variantIndex !== -1) {
                contentPool = data.variations[variantIndex].content || "";
                isVariant = true;
            }
        } else {
            contentPool = data.content || "";
        }

        // LOGIKA POTONG BARIS (QTY 6 = 6 Baris)
        // Split enter, filter baris kosong
        let stocks = contentPool.split('\n').filter(s => s.trim().length > 0);
        
        if (stocks.length >= qtyNeeded) {
            // Ambil stok dari atas
            const taken = stocks.slice(0, qtyNeeded); 
            // Sisanya kembalikan ke pool
            const remaining = stocks.slice(qtyNeeded).join('\n');
            
            // Update Sold & Content di DB
            const increment = parseInt(qtyNeeded);
            if (isVariant) {
                data.variations[variantIndex].content = remaining;
                t.update(docRef, { variations: data.variations, sold: (data.sold || 0) + increment });
            } else {
                t.update(docRef, { content: remaining, sold: (data.sold || 0) + increment });
            }
            
            return { success: true, data: taken.join('\n') }; // Kembalikan data yg diambil
        } else {
            return { success: false, currentStock: stocks.length }; // Stok kurang
        }
    });
};

// ==========================================
// 3. LOGIKA PROSES ORDER (FULFILLMENT)
// ==========================================
const processOrderLogic = async (orderId, orderData) => {
    let items = [], needsRev = false, msgLog = "", revisionBtns = [];

    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];
        
        // Jika konten sudah ada (hasil revisi), jangan potong stok lagi
        if (item.content) {
            items.push(item);
            msgLog += `✅ ${item.name}: TERKIRIM (Manual)\n`;
            continue;
        }

        try {
            // Coba ambil stok otomatis
            const result = await processStock(item.id, item.variantName, item.qty);
            
            if (result && result.success) {
                items.push({ ...item, content: result.data });
                msgLog += `✅ ${item.name} (x${item.qty}): SUKSES\n`;
            } else {
                // Stok Kosong -> Minta Admin Isi
                items.push({ ...item, content: null });
                needsRev = true;
                msgLog += `⚠️ ${item.name} (x${item.qty}): STOK KURANG (Sisa: ${result?.currentStock||0})\n`;
                // Buat tombol revisi spesifik
                revisionBtns.push([Markup.button.callback(`🔧 ISI MANUAL (${item.qty} Baris): ${item.name}`, `rev_${orderId}_${i}`)]);
            }
        } catch (e) {
            console.error(e);
            items.push({ ...item, content: null });
            needsRev = true;
            msgLog += `❌ ${item.name}: ERROR DATABASE\n`;
        }
    }

    // Update Status Order
    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    if (needsRev) {
        bot.telegram.sendMessage(ADMIN_ID, 
            `⚠️ *ORDER ${orderId} BUTUH REVISI*\nStok habis/kurang saat pembelian Qty banyak.\n\n${msgLog}`, 
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revisionBtns) }
        );
    } else {
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\nStok terpotong otomatis.\n\n${msgLog}`);
    }
};

// ==========================================
// 4. API WEBHOOK (WEB -> BOT)
// ==========================================
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    
    bot.telegram.sendMessage(ADMIN_ID, 
        `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('⚡ PROSES (AUTO STOK)', `acc_${orderId}`)],
            [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
        ])
    );
    res.json({ status: 'ok' });
});

// Endpoint Cek Server
app.get('/', (req, res) => res.send('JSN-02 SERVER READY'));

// ==========================================
// 5. BOT BRAIN (PANEL ADMIN)
// ==========================================

// --- UTILS ---
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod'), Markup.button.callback('💰 PENJUALAN', 'sales_today')],
    [Markup.button.callback('⏳ CEK PENDING', 'list_pending'), Markup.button.callback('❓ BANTUAN', 'help')]
]);

const cancelBtn = Markup.inlineKeyboard([Markup.button.callback('❌ BATAL', 'cancel_action')]);

// --- COMMANDS ---
bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JSN-02*", { parse_mode: 'Markdown', ...mainMenu }));
bot.action('back_home', (ctx) => ctx.editMessageText("🛠 *PANEL ADMIN JSN-02*", { parse_mode: 'Markdown', ...mainMenu }));

// HAPUS PRODUK
bot.command('hapus', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const code = ctx.message.text.split(' ')[1];
    if(!code) return ctx.reply("Format: `/hapus KODE`", {parse_mode:'Markdown'});
    
    const snap = await db.collection('products').where('code', '==', code).get();
    if(snap.empty) return ctx.reply("Produk tidak ditemukan.");
    
    snap.forEach(async d => await db.collection('products').doc(d.id).delete());
    ctx.reply(`🗑️ Produk ${code} dihapus permanen.`);
});

// --- LISTENER CHAT (SMART SEARCH & WIZARD) ---
bot.on('text', async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    // A. JIKA SEDANG MODE INPUT (WIZARD)
    if (session) {
        // Mode Tambah Produk
        if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') {
                d.name = text; session.step = 'PRICE';
                ctx.reply("💰 Kirim *HARGA* (Angka):", cancelBtn);
            } else if (session.step === 'PRICE') {
                if(isNaN(text)) return ctx.reply("Harus Angka!");
                d.price = parseInt(text); session.step = 'CODE';
                ctx.reply("🏷 Kirim *KODE PRODUK* (Unik, cth: C1):", cancelBtn);
            } else if (session.step === 'CODE') {
                d.code = text; session.step = 'IMG';
                ctx.reply("🖼 Kirim *URL GAMBAR*:", cancelBtn);
            } else if (session.step === 'IMG') {
                d.image = text; session.step = 'STATS';
                ctx.reply("👁 Kirim *FAKE SOLD & VIEW* (Pisah spasi, cth: 100 500):", cancelBtn);
            } else if (session.step === 'STATS') {
                const [s, v] = text.split(' ');
                d.sold = parseInt(s)||0; d.view = parseInt(v)||0; session.step = 'DESC';
                ctx.reply("📝 Kirim *DESKRIPSI*:", cancelBtn);
            } else if (session.step === 'DESC') {
                d.desc = text; session.step = 'CONTENT';
                ctx.reply("📦 Kirim *DATA STOK UTAMA* (Enter untuk baris baru).\nKetik 'skip' jika kosong.", cancelBtn);
            } else if (session.step === 'CONTENT') {
                d.content = text.toLowerCase()==='skip' ? '' : text; 
                session.step = 'VARS';
                ctx.reply("🔀 Kirim *VARIASI* (Format: Nama,Kode,Stok)\nContoh: Varian A,C1,Akun1\n\nKetik 'skip' jika tidak ada.", cancelBtn);
            } else if (session.step === 'VARS') {
                if(text.toLowerCase() !== 'skip') {
                    // Logic Multi Line Variasi
                    d.variations = text.split('|').map(v => {
                         const lines = v.split('\n'); 
                         const [name, code, ...contentArr] = lines[0].split(',');
                         // Gabung sisa baris jika user paste banyak akun
                         const fullContent = [contentArr.join(','), ...lines.slice(1)].join('\n').trim();
                         return { name: name?.trim(), code: code?.trim(), content: fullContent };
                    });
                } else { d.variations = []; }
                
                await db.collection('products').add({...d, createdAt: new Date()});
                delete adminSession[userId];
                ctx.reply(`✅ *PRODUK TERSIMPAN!*\n${d.name} (${d.code})`);
            }
        }
        
        // Mode Revisi (Isi Manual)
        else if (session.type === 'REVISI') {
            const { orderId, itemIdx } = session;
            const docRef = db.collection('orders').doc(orderId);
            const snap = await docRef.get();
            if(snap.exists) {
                const data = snap.data();
                if(data.items[itemIdx]) {
                    data.items[itemIdx].content = text; 
                    await docRef.update({ items: data.items });
                    delete adminSession[userId];
                    ctx.reply("✅ Data Tersimpan!");
                    // Cek kelengkapan lagi
                    processOrderLogic(orderId, data);
                }
            }
        }
        return;
    }

    // B. JIKA TIDAK ADA SESI -> SMART SEARCH (CARI KODE)
    // Cari produk berdasarkan field 'code'
    const snap = await db.collection('products').where('code', '==', text).get();
    if (!snap.empty) {
        const doc = snap.docs[0];
        const p = doc.data();
        const stokCount = p.content ? p.content.split('\n').filter(x=>x.trim()).length : 0;
        
        const msg = `🔎 *PRODUK DITEMUKAN*\n📦 ${p.name}\n🏷 Kode: ${p.code}\n💰 Rp ${p.price}\n📊 Stok: ${stokCount} baris\n🛒 Sold Real: ${p.sold}`;
        
        ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✏️ Update Stok', `upd_stok_${doc.id}`), Markup.button.callback('✏️ Update Harga', `upd_price_${doc.id}`)],
                [Markup.button.callback('🗑️ HAPUS PRODUK', `del_prod_${doc.id}`)]
            ])
        });
    }
});

// --- ACTION HANDLERS ---
bot.action('add_prod', (ctx) => {
    adminSession[ctx.from.id] = { type: 'ADD_PROD', step: 'NAME', data: {} };
    ctx.reply("➕ Kirim *NAMA PRODUK*:", cancelBtn);
});

bot.action('cancel_action', (ctx) => {
    delete adminSession[ctx.from.id];
    ctx.reply("❌ Batal.");
});

bot.action('list_pending', async (ctx) => {
    const snap = await db.collection('orders').where('status', '==', 'pending').get();
    if(snap.empty) return ctx.reply("Aman, tidak ada pending.");
    const btns = snap.docs.map(d => [Markup.button.callback(`👤 ${d.data().buyerPhone} - Rp ${d.data().total}`, `cek_${d.id}`)]);
    ctx.reply("⏳ *LIST PENDING*", Markup.inlineKeyboard(btns));
});

bot.action(/^cek_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const d = await db.collection('orders').doc(id).get();
    const items = d.data().items.map(i => `${i.name} (x${i.qty})`).join(', ');
    ctx.reply(`Detail: ${items}\nTotal: ${d.data().total}`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ ACC', `acc_${id}`), Markup.button.callback('❌ TOLAK', `tolak_${id}`)]
    ]));
});

bot.action(/^acc_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    ctx.reply(`⚙️ Memproses stok...`);
    const d = await db.collection('orders').doc(id).get();
    if(d.exists) await processOrderLogic(id, d.data());
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    await db.collection('orders').doc(ctx.match[1]).update({ status: 'failed' });
    ctx.editMessageText("🚫 Order Ditolak.");
});

bot.action(/^rev_(.+)_(.+)$/, (ctx) => {
    const [_, oid, idx] = ctx.match;
    adminSession[ctx.from.id] = { type: 'REVISI', orderId: oid, itemIdx: parseInt(idx) };
    ctx.reply("🔧 Kirim Data Konten Manual (Bisa Multi Baris):", cancelBtn);
});

bot.action(/^del_prod_(.+)$/, async (ctx) => {
    await db.collection('products').doc(ctx.match[1]).delete();
    ctx.editMessageText("🗑️ Produk Dihapus Permanen.");
});

// START
app.listen(PORT, () => {
    console.log(`SERVER RUNNING PORT ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
