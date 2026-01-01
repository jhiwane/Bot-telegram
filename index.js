const express = require('express');
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');
require('dotenv').config();

// --- 1. SETUP FIREBASE ADMIN (KUNCI MASTER) ---
// Kita akan menaruh kunci JSON di Environment Variable Railway nanti
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- 2. SETUP BOT TELEGRAM ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID; // ID Telegram kamu agar orang lain gak bisa bajak bot

// Middleware: Cek apakah yang chat adalah Owner?
const isAdmin = (ctx, next) => {
    if (String(ctx.from.id) === ADMIN_ID) return next();
    return ctx.reply("⛔ Eits! Kamu bukan admin. Pergi sana!");
};

// --- MENU UTAMA ---
bot.start((ctx) => ctx.reply(`
🤖 *PANEL ADMIN MANGA STORE* 🤖
Selamat datang, Bos!

*DAFTAR PERINTAH:*

📦 *MANAJEMEN PRODUK:*
/tambah [nama] | [harga] | [url_gambar] | [deskripsi]
/list - Lihat semua ID produk
/edit [id] [field] [value]
/hapus [id]

📈 *MANIPULASI STATS:*
/fake [id] [views] [sold]
(Contoh: /fake 7a8b9c 1000 50)

💰 *ORDERAN:*
/cek [id_order] - Lihat detail order
/acc [id_order] [konten_rahasia] - Terima & Kirim Data ke User
/tolak [id_order] - Batalkan order
`));

// --- LOGIC PRODUK ---
bot.command('tambah', isAdmin, async (ctx) => {
    try {
        const text = ctx.message.text.replace('/tambah ', '');
        const [name, price, image, desc] = text.split('|').map(t => t.trim());

        if (!name || !price || !image) return ctx.reply("❌ Format Salah!\nContoh: /tambah Akun ML | 50000 | https://foto.com/a.jpg | Full Skin");

        await db.collection('products').add({
            name,
            price: parseInt(price),
            image,
            desc: desc || "Tidak ada deskripsi",
            view: 0,
            sold: 0,
            variations: [], // Default kosong dulu
            createdAt: new Date()
        });
        ctx.reply(`✅ Sukses Upload: ${name}`);
    } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

bot.command('list', isAdmin, async (ctx) => {
    const snap = await db.collection('products').get();
    if (snap.empty) return ctx.reply("Toko masih kosong bos.");
    
    let msg = "📦 *DATABASE PRODUK:*\n";
    snap.forEach(doc => {
        const d = doc.data();
        msg += `\n🆔 \`${doc.id}\`\n📌 ${d.name}\n💰 Rp ${d.price}\n👁 ${d.view} | 🛒 ${d.sold}\n------------------`;
    });
    // Telegram melimit pesan panjang, hati-hati jika produk ribuan (bisa dipotong)
    ctx.replyWithMarkdown(msg);
});

bot.command('edit', isAdmin, async (ctx) => {
    // Format: /edit ID field value
    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply("Format: /edit [ID] [field] [value]");
    
    const id = parts[1];
    const field = parts[2];
    let value = parts.slice(3).join(' ');

    // Auto convert ke number jika field harga/view/sold
    if(['price','view','sold'].includes(field)) value = parseInt(value);

    try {
        await db.collection('products').doc(id).update({ [field]: value });
        ctx.reply(`✅ Berhasil ubah ${field} jadi ${value}`);
    } catch(e) { ctx.reply("❌ Gagal. ID salah mungkin?"); }
});

bot.command('hapus', isAdmin, async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if(!id) return ctx.reply("Mana ID nya?");
    await db.collection('products').doc(id).delete();
    ctx.reply("🗑️ Produk dihapus selamanya.");
});

// --- LOGIC MANIPULASI (BIAR RAME) ---
bot.command('fake', isAdmin, async (ctx) => {
    const [_, id, view, sold] = ctx.message.text.split(' ');
    if(!id) return ctx.reply("Format: /fake [ID] [View] [Sold]");
    
    await db.collection('products').doc(id).update({
        view: parseInt(view) || 0,
        sold: parseInt(sold) || 0
    });
    ctx.reply("😎 Data palsu berhasil disuntikkan!");
});

// --- LOGIC ORDERAN (PENTING) ---
bot.command('cek', isAdmin, async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if(!id) return ctx.reply("Mana ID Order?");
    
    const doc = await db.collection('orders').doc(id).get();
    if(!doc.exists) return ctx.reply("Order ga ketemu.");
    
    const d = doc.data();
    let msg = `🧾 *DETAIL ORDER*\nUser: ${d.buyerPhone}\nTotal: ${d.total}\nStatus: ${d.status}\n\nItem:\n`;
    d.items.forEach(i => msg += `- ${i.name} x${i.qty}\n`);
    ctx.reply(msg);
});

bot.command('acc', isAdmin, async (ctx) => {
    // Format: /acc [ORDER_ID] [KONTEN RAHASIA]
    // Contoh: /acc uY7s8a9 User: admin Pass: 123
    const parts = ctx.message.text.split(' ');
    const id = parts[1];
    const content = parts.slice(2).join(' ');

    if(!id) return ctx.reply("Mana ID nya bos?");
    
    try {
        const orderRef = db.collection('orders').doc(id);
        const orderSnap = await orderRef.get();
        
        if(!orderSnap.exists) return ctx.reply("Order ga ada.");
        
        // 1. Update Status jadi Success & Masukkan Konten
        await orderRef.update({
            status: 'success',
            content: content || "Transaksi Berhasil! Terima kasih."
        });

        // 2. Tambah Counter Sold di Produk Terkait (Otomatis)
        const items = orderSnap.data().items;
        items.forEach(async (item) => {
            if(item.id) {
                await db.collection('products').doc(item.id).update({
                    sold: admin.firestore.FieldValue.increment(item.qty)
                });
            }
        });

        ctx.reply(`✅ ORDER ${id} DITERIMA!\nKonten rahasia sudah dikirim ke panel member.`);
    } catch(e) { ctx.reply(`❌ Error: ${e.message}`); }
});

bot.command('tolak', isAdmin, async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    await db.collection('orders').doc(id).update({ status: 'failed' });
    ctx.reply("🚫 Order ditolak.");
});

// --- 3. SERVER EXPRESS (Agar Railway tidak mati) ---
const app = express();
app.get('/', (req, res) => res.send('Bot Manga Store Aktif!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server jalan di port ${PORT}`);
    bot.launch();
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
