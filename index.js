const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- 1. SETUP EXPRESS & CORS (WAJIB UTK KONEKSI FRONTEND) ---
const app = express();
app.use(cors({ origin: '*' })); // Izinkan semua akses
app.use(express.json());

// --- 2. SETUP FIREBASE (DENGAN PENGAMANAN ERROR) ---
let serviceAccount;
try {
    // Membersihkan format JSON jika ada karakter aneh dari copy-paste
    if(process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Firebase Config Loaded");
    } else {
        throw new Error("Variable FIREBASE_SERVICE_ACCOUNT kosong!");
    }
} catch (error) {
    console.error("❌ ERROR JSON FIREBASE:", error.message);
    // Kita tidak matikan process agar bisa cek log di Railway
}

if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// --- 3. SETUP BOT TELEGRAM ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// Middleware: Proteksi agar hanya kamu yang bisa akses menu admin
const isAdmin = (ctx, next) => {
    if (String(ctx.from?.id) === ADMIN_ID) return next();
    // Silent block untuk orang asing
};

// --- 4. LOGIKA OTAK CERDAS (AUTO FULFILLMENT) ---
const autoFulfillOrder = async (orderId, orderData) => {
    try {
        console.log(`⚙️ Memproses Konten untuk Order: ${orderId}`);
        
        let fulfilledItems = [];
        let needsRevision = false;
        let messageLog = "";

        // Loop setiap item yang dibeli user
        for (const item of orderData.items) {
            let contentFound = null;

            // Ambil data produk asli dari database untuk cari kontennya
            const prodSnap = await db.collection('products').doc(item.id).get();
            
            if (prodSnap.exists) {
                const prodData = prodSnap.data();
                
                // 1. Cek apakah ada konten khusus Variasi?
                if (item.variantName && prodData.variations) {
                    const variant = prodData.variations.find(v => v.name === item.variantName);
                    if (variant && variant.content) contentFound = variant.content;
                }
                
                // 2. Jika tidak, pakai konten utama produk
                if (!contentFound && prodData.content) {
                    contentFound = prodData.content;
                }
            }

            if (contentFound) {
                // KONTEN KETEMU: Masukkan ke order user
                fulfilledItems.push({ ...item, content: contentFound });
                messageLog += `✅ ${item.name}: Data Terkirim\n`;
            } else {
                // KONTEN KOSONG: Tandai butuh revisi manual
                fulfilledItems.push({ ...item, content: null });
                needsRevision = true;
                messageLog += `⚠️ ${item.name}: KOSONG (Butuh Revisi)\n`;
            }
        }

        // Update Order di Firebase (User langsung bisa lihat di Web)
        await db.collection('orders').doc(orderId).update({
            items: fulfilledItems,
            status: 'success', // Status jadi sukses agar muncul di history user
            processed: true
        });

        // Tambah Counter Terjual (Sold)
        orderData.items.forEach(async (item) => {
            if(item.id) {
                await db.collection('products').doc(item.id).update({
                    sold: admin.firestore.FieldValue.increment(item.qty)
                });
            }
        });

        // Lapor Balik ke Telegram Admin
        if (needsRevision) {
            bot.telegram.sendMessage(ADMIN_ID, 
                `⚠️ *ORDER ${orderId} SELESAI TAPI ADA YANG KOSONG!*\n\n${messageLog}\n\n👇 *CARA REVISI (ISI MANUAL):*\nKetik: \`/update ${orderId} 0 DataAkun:Password\``, 
                { parse_mode: 'Markdown' }
            );
        } else {
            bot.telegram.sendMessage(ADMIN_ID, 
                `✅ *ORDER ${orderId} SUKSES SEMPURNA!*\nSemua data akun/voucher sudah masuk ke web user.`,
                { parse_mode: 'Markdown' }
            );
        }

    } catch (e) {
        console.error("Error Auto Fulfill:", e);
        bot.telegram.sendMessage(ADMIN_ID, `❌ Gagal Proses Otomatis: ${e.message}`);
    }
};

// --- 5. API ENDPOINT (Webhook Tombol "Sudah Bayar") ---
app.post('/api/confirm-manual', async (req, res) => {
    try {
        const { orderId, buyerPhone, total, items } = req.body;

        if(!orderId) return res.status(400).json({ error: 'No Order ID' });

        console.log(`🔔 Notif Masuk: ${orderId}`);

        let itemText = "";
        if(Array.isArray(items)) {
            items.forEach(i => itemText += `- ${i.name} (${i.variantName||'-'}) x${i.qty}\n`);
        }

        const msg = `🔔 *ORDER MANUAL BARU*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n🛒 *Item:*\n${itemText}`;
        
        // Kirim Notif ke Admin dengan Tombol ACC
        await bot.telegram.sendMessage(ADMIN_ID, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ACC & KIRIM DATA', `acc_${orderId}`)],
                [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ]).resize()
        });

        res.json({ status: 'ok' });

    } catch (error) {
        console.error("❌ Gagal kirim notif:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- 6. BOT ACTIONS (Respon Tombol) ---

// Klik ACC
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    ctx.answerCbQuery("Memproses...");
    ctx.editMessageText(`⏳ Sedang memproses Order \`${orderId}\`...\nMencari stok konten di database...`, { parse_mode: 'Markdown' });
    
    const doc = await db.collection('orders').doc(orderId).get();
    if (doc.exists) {
        // Panggil fungsi otak cerdas
        await autoFulfillOrder(orderId, doc.data());
    } else {
        ctx.reply("❌ Order ID tidak ditemukan di database.");
    }
});

// Klik TOLAK
bot.action(/^tolak_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'failed' });
    ctx.editMessageText(`🚫 Order \`${orderId}\` telah DITOLAK.`, { parse_mode: 'Markdown' });
});

// --- 7. BOT COMMANDS (Manajemen Stok & Revisi) ---

// /tambah Nama | Harga | Gambar | Desc | KONTEN
bot.command('tambah', isAdmin, async (ctx) => {
    try {
        const text = ctx.message.text.replace('/tambah ', '');
        // Split dengan batas 5 variabel
        const parts = text.split('|').map(t => t.trim());
        
        if (parts.length < 3) return ctx.reply("❌ Format: /tambah Nama | Harga | LinkGambar | Deskripsi | Konten(Opsional)");

        const [name, price, image, desc, content] = parts;

        await db.collection('products').add({
            name, 
            price: parseInt(price), 
            image, 
            desc: desc || "", 
            content: content || "", // Konten otomatis disinpan
            view: 0, 
            sold: 0, 
            createdAt: new Date()
        });
        ctx.reply(`✅ Produk "${name}" Berhasil Ditambah!`);
    } catch (e) { ctx.reply("Gagal: " + e.message); }
});

// /update ID_ORDER INDEX KONTEN_BARU (Fitur Revisi)
bot.command('update', isAdmin, async (ctx) => {
    const args = ctx.message.text.split(' ');
    // args[0]=/update, args[1]=OrderID, args[2]=IndexItem, args[3..]=Konten
    const orderId = args[1];
    const itemIndex = parseInt(args[2]);
    const content = args.slice(3).join(' ');

    if (!orderId || isNaN(itemIndex) || !content) {
        return ctx.reply("⚠️ Format Revisi: /update [ORDER_ID] [URUTAN_ITEM_MULAI_0] [DATA_BARU]");
    }

    try {
        const docRef = db.collection('orders').doc(orderId);
        const docSnap = await docRef.get();
        
        if (!docSnap.exists) return ctx.reply("Order tidak ada.");

        let items = docSnap.data().items;
        if (items[itemIndex]) {
            items[itemIndex].content = content; // Isi konten manual
            
            await docRef.update({ 
                items: items,
                status: 'success' // Pastikan status sukses biar user bisa lihat
            });
            ctx.reply(`✅ Revisi Berhasil!\nUser sekarang bisa melihat data di menu history.`);
        } else {
            ctx.reply("❌ Urutan item salah (Mulai dari 0).");
        }
    } catch(e) { ctx.reply("Error: " + e.message); }
});

// /fake ID VIEW SOLD (Manipulasi Data)
bot.command('fake', isAdmin, async (ctx) => {
    const [_, id, view, sold] = ctx.message.text.split(' ');
    if(!id) return ctx.reply("Format: /fake [ID_PRODUK] [VIEW] [SOLD]");
    
    await db.collection('products').doc(id).update({
        view: parseInt(view) || 0,
        sold: parseInt(sold) || 0
    });
    ctx.reply("😎 Data Fake Berhasil Diupdate!");
});

// --- 8. START SERVER (GUNAKAN METODE POLLING YANG AMAN) ---
app.get('/', (req, res) => res.send('BACKEND MANGA STORE IS RUNNING!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    
    if(process.env.BOT_TOKEN) {
        // dropPendingUpdates: true -> Hapus pesan lama yg nyangkut (Obat Error 409)
        bot.launch({ dropPendingUpdates: true }).then(() => {
            console.log("🤖 Bot Telegram ONLINE!");
        }).catch(err => {
            console.error("❌ Bot Error:", err);
        });
    }
});

// Graceful Stop agar tidak nyangkut saat deploy ulang
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
