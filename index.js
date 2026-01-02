const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// ==========================================
// 1. SETUP SERVER & STATE (OTAK BOT)
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// INI KUNCI RAHASIANYA: VARIABLE INGATAN BOT
// Menyimpan status admin sedang ngapain (misal: lagi isi harga, lagi isi konten, dll)
const adminSession = {}; 

// Endpoint Cek Server
app.get('/', (req, res) => res.send('SERVER JSN-02 INTERAKTIF AKTIF!'));

// ==========================================
// 2. SETUP FIREBASE
// ==========================================
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) { console.error("❌ ERROR JSON:", error.message); }

if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ==========================================
// 3. SETUP BOT TELEGRAM
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// Tombol Batal Umum
const cancelBtn = Markup.inlineKeyboard([Markup.button.callback('❌ BATAL', 'cancel_action')]);

// ==========================================
// 4. LOGIKA INTERAKSI CHAT (BRAIN)
// ==========================================

// --- LISTENER TEKS (Saat Admin Mengetik Pesan) ---
bot.on('text', async (ctx, next) => {
    // Hanya respon Admin
    if (String(ctx.from.id) !== ADMIN_ID) return next();

    const userId = ctx.from.id;
    const text = ctx.message.text;
    const session = adminSession[userId];

    // Jika tidak ada sesi aktif, abaikan (atau jalankan command biasa)
    if (!session) return next();

    // --- LOGIKA TAMBAH PRODUK BERTAHAP ---
    if (session.type === 'ADD_PRODUCT') {
        const data = session.data;

        switch (session.step) {
            case 'NAME':
                data.name = text;
                session.step = 'PRICE';
                return ctx.reply(`💰 Oke, nama produk: *${text}*\nSekarang kirim *HARGA* (Angka saja):`, {parse_mode:'Markdown', ...cancelBtn});
            
            case 'PRICE':
                if(isNaN(text)) return ctx.reply("⚠️ Harap kirim angka saja!");
                data.price = parseInt(text);
                session.step = 'IMAGE';
                return ctx.reply("🖼 Sip! Sekarang kirim *LINK GAMBAR* (URL):", cancelBtn);

            case 'IMAGE':
                data.image = text;
                session.step = 'DESC';
                return ctx.reply("📝 Oke, sekarang kirim *DESKRIPSI* produk:", cancelBtn);

            case 'DESC':
                data.desc = text;
                session.step = 'CONTENT';
                return ctx.reply("🔑 Terakhir! Kirim *KONTEN UTAMA* (Akun/Kode).\nKetik 'kosong' jika ingin dikosongkan dulu.", cancelBtn);

            case 'CONTENT':
                data.content = text.toLowerCase() === 'kosong' ? "" : text;
                
                // SIMPAN KE DATABASE
                await db.collection('products').add({
                    ...data,
                    view: 0, sold: 0, createdAt: new Date()
                });

                delete adminSession[userId]; // Hapus ingatan
                return ctx.reply(`✅ *PRODUK BERHASIL DIBUAT!*\n\n📦 ${data.name}\n💰 Rp ${data.price.toLocaleString()}`, {parse_mode:'Markdown'});
        }
    }

    // --- LOGIKA REVISI ORDER (REPLY INTERACTION) ---
    if (session.type === 'REVISI_ITEM') {
        const { orderId, itemIdx, itemName } = session;
        
        try {
            const docRef = db.collection('orders').doc(orderId);
            const snap = await docRef.get();
            if(!snap.exists) {
                delete adminSession[userId];
                return ctx.reply("❌ Order hilang dari database.");
            }

            const orderData = snap.data();
            
            // Update konten item spesifik
            if (orderData.items[itemIdx]) {
                orderData.items[itemIdx].content = text; // Isi dengan pesan admin
                
                // Simpan sementara
                await docRef.update({ items: orderData.items });
                delete adminSession[userId]; // Selesai

                ctx.reply(`✅ Konten untuk *${itemName}* disimpan!`, {parse_mode:'Markdown'});
                
                // Panggil ulang logika fulfillment untuk cek apakah sudah lengkap semua?
                // Jika lengkap, otomatis kirim WA dan selesaikan order.
                await processOrderLogic(orderId, orderData); 

            } else {
                delete adminSession[userId];
                ctx.reply("❌ Index item error.");
            }
        } catch (e) {
            ctx.reply(`Error: ${e.message}`);
        }
    }
});

// --- ACTION HANDLERS (KLIK TOMBOL) ---

// 1. Mulai Tambah Produk
bot.action('btn_tambah_produk', (ctx) => {
    adminSession[ctx.from.id] = { type: 'ADD_PRODUCT', step: 'NAME', data: {} };
    ctx.reply("📦 *MODE TAMBAH PRODUK*\n\nSilakan kirim *NAMA PRODUK*:", {parse_mode:'Markdown', ...cancelBtn});
});

// 2. Mulai Revisi Item (Dari Notif Order)
bot.action(/^rev_(.+)_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const itemIdx = parseInt(ctx.match[2]);
    
    // Ambil nama item dulu buat konteks
    const doc = await db.collection('orders').doc(orderId).get();
    if(!doc.exists) return ctx.reply("Order ga ada.");
    const itemName = doc.data().items[itemIdx].name;

    // Set Ingatan Bot
    adminSession[ctx.from.id] = { 
        type: 'REVISI_ITEM', 
        orderId: orderId, 
        itemIdx: itemIdx,
        itemName: itemName
    };

    ctx.reply(`🔧 *MODE ISI MANUAL*\n\nSilakan kirim/paste konten untuk:\n👉 *${itemName}*`, {parse_mode:'Markdown', ...cancelBtn});
});

// 3. Batal
bot.action('cancel_action', (ctx) => {
    delete adminSession[ctx.from.id];
    ctx.reply("❌ Operasi dibatalkan.");
});

// 4. Panel Utama (/admin)
bot.command(['admin', 'panel', 'start'], isAdmin, (ctx) => {
    ctx.reply("🛠 *PANEL ADMIN JSN-02*", Markup.inlineKeyboard([
        [Markup.button.callback('➕ TAMBAH PRODUK BARU (WIZARD)', 'btn_tambah_produk')],
        [Markup.button.callback('📂 LIHAT SEMUA PRODUK', 'list_produk')] // Bisa dikembangkan nanti
    ]));
});


// ==========================================
// 5. LOGIKA ORDER & AUTO WA
// ==========================================

const processOrderLogic = async (orderId, orderData) => {
    let items = [], needsRev = false, msgLog = "";
    
    // Array untuk tombol revisi (Dynamic Buttons)
    let revisionButtons = []; 

    for (let i = 0; i < orderData.items.length; i++) {
        let item = orderData.items[i];
        let content = item.content || null;

        // Cari di DB Produk jika belum ada konten
        if (!content) {
            const pSnap = await db.collection('products').doc(item.id).get();
            if (pSnap.exists) {
                const p = pSnap.data();
                if (item.variantName && p.variations) {
                    const v = p.variations.find(va => va.name === item.variantName);
                    if (v && v.content) content = v.content;
                }
                if (!content && p.content) content = p.content;
            }
        }

        if (content) {
            items.push({ ...item, content });
            msgLog += `✅ ${item.name}: ADA\n`;
        } else {
            items.push({ ...item, content: null });
            needsRev = true;
            msgLog += `⚠️ ${item.name}: KOSONG\n`;
            
            // TAMBAHKAN TOMBOL KHUSUS ITEM INI
            // Format callback: rev_ORDERID_INDEX
            revisionButtons.push([Markup.button.callback(`🔧 ISI MANUAL: ${item.name}`, `rev_${orderId}_${i}`)]);
        }
    }

    // Update Firebase
    await db.collection('orders').doc(orderId).update({ 
        items, status: 'success', processed: true 
    });

    if (needsRev) {
        // KIRIM NOTIF DENGAN TOMBOL REVISI YANG SPESIFIK
        bot.telegram.sendMessage(ADMIN_ID, 
            `⚠️ *ORDER ${orderId} BUTUH ISIAN!*\n\n${msgLog}\nKlik tombol di bawah untuk mengisi data yang kosong (Reply Chat):`, 
            { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(revisionButtons) 
            }
        );
    } else {
        // SUKSES TOTAL
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI!*\nSemua data lengkap. User senang.`);
        
        // AUTO WA SIMULASI (Logic kirim WA ada disini)
        if (orderData.buyerPhone) {
            // sendWhatsApp(orderData.buyerPhone, "Orderan Anda Selesai! Cek Web.");
            console.log(`📲 Kirim WA ke ${orderData.buyerPhone}`);
        }
    }
};

// API Webhook dari Frontend
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    
    // Notif Awal
    const txt = items.map(i => `- ${i.name}`).join('\n');
    const msg = `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}\n${txt}`;
    
    bot.telegram.sendMessage(ADMIN_ID, msg, 
        Markup.inlineKeyboard([
            [Markup.button.callback('⚡ PROSES SEKARANG', `acc_${orderId}`)],
            [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
        ])
    );
    res.json({ status: 'ok' });
});

// Action ACC
bot.action(/^acc_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    ctx.editMessageText(`⚙️ Mengecek stok database...`);
    const doc = await db.collection('orders').doc(id).get();
    if (doc.exists) await processOrderLogic(id, doc.data());
});


// ==========================================
// 6. START SERVER (ANTI CRASH)
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 SERVER WEB JALAN DI PORT ${PORT}`);
    startBot();
});

async function startBot() {
    if(!process.env.BOT_TOKEN) return;
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.launch();
        console.log("🤖 BOT INTERAKTIF ONLINE!");
        bot.telegram.sendMessage(ADMIN_ID, "🟢 PANEL ADMIN SIAP! Ketik /admin").catch(()=>{});
    } catch (e) {
        console.log("⚠️ Bot retry...", e.message);
        setTimeout(startBot, 5000);
    }
}

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
