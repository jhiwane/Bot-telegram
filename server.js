// server.js
const express = require('express');
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');
require('dotenv').config();

// --- 1. SETUP FIREBASE ADMIN ---
// Di Railway, masukkan Service Account JSON ke variable: FIREBASE_SERVICE_ACCOUNT
// Formatnya harus JSON string satu baris.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- 2. SETUP BOT TELEGRAM ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID; // ID Telegram kamu (supaya orang lain gak bisa asal pencet)

// Middleware Check Admin
const isAdmin = (ctx, next) => {
    if (String(ctx.from.id) === ADMIN_ID) return next();
    return ctx.reply("⛔ Anda bukan admin!");
};

bot.start((ctx) => ctx.reply('🤖 Admin Bot Siap! Ketik /menu'));

bot.command('menu', isAdmin, (ctx) => {
    const msg = `
🛠 *PANEL ADMIN QOMI STORE* 🛠

📦 *PRODUK:*
/tambah [nama] | [harga] | [img_url] | [desc]
/list - Lihat semua produk & ID
/edit [id_produk] [field] [value]
/hapus [id_produk]

📈 *MANIPULASI:*
/fake [id_produk] [views] [sold]
(Contoh: /fake abc 500 20)

💰 *ORDERAN:*
/cek [id_order] - Cek status
/acc [id_order] [konten_rahasia] - Terima & Kirim Data
/tolak [id_order] - Tolak order
    `;
    ctx.replyWithMarkdown(msg);
});

// --- FITUR PRODUK ---
bot.command('tambah', isAdmin, async (ctx) => {
    const raw = ctx.message.text.split(' ').slice(1).join(' ');
    const [name, price, image, desc] = raw.split('|').map(s => s.trim());

    if (!name || !price || !image) return ctx.reply("Format salah! Contoh:\n/tambah Akun ML | 50000 | https://img.com/a.jpg | Full skin");

    try {
        await db.collection('products').add({
            name,
            price: parseInt(price),
            image,
            desc: desc || '',
            view: 0,
            sold: 0,
            createdAt: new Date()
        });
        ctx.reply(`✅ Sukses tambah: ${name}`);
    } catch (e) {
        ctx.reply(`❌ Gagal: ${e.message}`);
    }
});

bot.command('list', isAdmin, async (ctx) => {
    const snap = await db.collection('products').get();
    if (snap.empty) return ctx.reply("Kosong.");
    
    let msg = "📦 *LIST PRODUK:*\n";
    snap.forEach(doc => {
        const d = doc.data();
        msg += `\n🆔 \`${doc.id}\`\n📌 ${d.name}\n💰 ${d.price}\n👁 ${d.view} | 🛒 ${d.sold}\n`;
    });
    ctx.replyWithMarkdown(msg);
});

bot.command('fake', isAdmin, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const id = args[1];
    const views = parseInt(args[2]);
    const sold = parseInt(args[3]);

    if (!id || isNaN(views)) return ctx.reply("Format: /fake [id] [views] [sold]");

    try {
        await db.collection('products').doc(id).update({
            view: views,
            sold: sold || 0
        });
        ctx.reply(`✅ Data palsu diupdate untuk ID: ${id}`);
    } catch (e) { ctx.reply("❌ ID Salah/Gagal"); }
});

// --- FITUR ORDER ---
bot.command('acc', isAdmin, async (ctx) => {
    // Format: /acc ORDER_ID AKUN:user/pass
    const parts = ctx.message.text.split(' ');
    const orderId = parts[1];
    const content = parts.slice(2).join(' '); // Sisa text adalah konten

    if (!orderId) return ctx.reply("Mana ID ordernya?");

    try {
        const ref = db.collection('orders').doc(orderId);
        const doc = await ref.get();
        if (!doc.exists) return ctx.reply("Order ga ketemu.");

        // Update Status & Masukkan Konten Rahasia
        await ref.update({
            status: 'success',
            content: content || "Transaksi Berhasil. Terima kasih!"
        });

        // Update Sold Count Produk Terkait (Otomatis)
        const orderData = doc.data();
        orderData.items.forEach(async (item) => {
            if (item.id) {
                await db.collection('products').doc(item.id).update({
                    sold: admin.firestore.FieldValue.increment(item.qty)
                });
            }
        });

        ctx.reply(`✅ Order ${orderId} SUKSES!\nKonten terkirim ke user.`);
    } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
});

// --- 3. EXPRESS SERVER (Agar jalan terus di Railway) ---
const app = express();
app.use(express.json());

// Webhook untuk Telegram (Opsional, polling lebih mudah untuk pemula)
app.get('/', (req, res) => res.send('Bot is Running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    bot.launch(); // Jalankan Bot Mode Polling
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
