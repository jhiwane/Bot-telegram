const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); // WAJIB ADA
require('dotenv').config();

// SETUP FIREBASE
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// SETUP BOT
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// SETUP EXPRESS APP
const app = express();
app.use(express.json());
app.use(cors()); // IZINKAN FRONTEND MENGHUBUNGI BACKEND

// MIDDLEWARE AUTH BOT
const isAdmin = (ctx, next) => {
    if (String(ctx.from?.id) === ADMIN_ID) return next();
    return ctx.reply("⛔ Akses Ditolak!");
};

// --- FUNGSI NOTIFIKASI STANDARD ---
const sendTelegramNotification = (id, data, type) => {
    let itemText = "";
    if(data.items) {
        data.items.forEach(i => itemText += `- ${i.name} (${i.variantName||'-'}) x${i.qty}\n`);
    }
    
    const msg = `🔔 *ORDER BARU (${type})*\n🆔 \`${id}\`\n👤 ${data.buyerPhone}\n💰 Rp ${parseInt(data.total).toLocaleString()}\n\n🛒 *Item:*\n${itemText}`;
    
    const buttons = [];
    if (type === 'MANUAL') {
        buttons.push(Markup.button.callback('✅ ACC & PROSES', `acc_${id}`));
        buttons.push(Markup.button.callback('❌ TOLAK', `tolak_${id}`));
    } else {
        buttons.push(Markup.button.callback('🔍 CEK STATUS', `cek_${id}`));
    }

    // Kirim pesan ke Admin ID
    bot.telegram.sendMessage(ADMIN_ID, msg, Markup.inlineKeyboard([buttons], { columns: 2 }).resize());
};

// --- API ENDPOINT (YANG DIPANGGIL TOMBOL 'SUDAH BAYAR') ---
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;

    if(!orderId) return res.status(400).json({ error: 'No Order ID' });

    console.log(`🔔 Menerima Konfirmasi Manual: ${orderId}`);

    // Langsung kirim notif ke Telegram Admin
    // Kita pakai data dari request frontend biar cepat (tanpa baca DB lagi)
    try {
        sendTelegramNotification(orderId, { buyerPhone, total, items }, 'MANUAL');
        res.json({ status: 'success', message: 'Notif dikirim ke Admin' });
    } catch (error) {
        console.error("Gagal kirim TG:", error);
        res.status(500).json({ error: 'Gagal kirim notif' });
    }
});

// --- THE WATCHER (BACKUP & AUTO SALDO) ---
// Tetap kita nyalakan untuk memantau order saldo otomatis / komplain
const startWatcher = () => {
    // Pantau Order SUCCESS (Saldo - Langsung Kirim Data)
    db.collection('orders').where('status', '==', 'success').where('processed', '==', false).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const orderId = change.doc.id;
                db.collection('orders').doc(orderId).update({ processed: true });
                sendTelegramNotification(orderId, data, 'SALDO (AUTO)');
                autoFulfillOrder(orderId, data);
            }
        });
    });

    // Pantau KOMPLAIN
    db.collection('orders').where('complain', '==', true).where('complainResolved', '==', false).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const data = change.doc.data();
                bot.telegram.sendMessage(ADMIN_ID, `⚠️ *ADA KOMPLAIN!* ⚠️\nID: \`${change.doc.id}\`\nUser: ${data.buyerPhone}\nCek segera!`, {parse_mode:'Markdown'});
            }
        });
    });
};

// --- LOGIC AUTO FULFILLMENT (SAMA SEPERTI SEBELUMNYA) ---
const autoFulfillOrder = async (orderId, orderData, isManualAcc = false) => {
    try {
        let fulfilledItems = [];
        let needsRevision = false;
        let finalMessageToUser = "";

        for (const item of orderData.items) {
            let contentFound = null;
            const prodSnap = await db.collection('products').doc(item.id).get();
            if (prodSnap.exists) {
                const prodData = prodSnap.data();
                if (item.variantName && prodData.variations) {
                    const variant = prodData.variations.find(v => v.name === item.variantName);
                    if (variant && variant.content) contentFound = variant.content;
                }
                if (!contentFound && prodData.content) contentFound = prodData.content;
            }

            if (contentFound) {
                fulfilledItems.push({ ...item, content: contentFound });
                finalMessageToUser += `📦 *${item.name}*: ${contentFound}\n`;
            } else {
                fulfilledItems.push({ ...item, content: null });
                needsRevision = true;
            }
        }

        await db.collection('orders').doc(orderId).update({
            items: fulfilledItems,
            status: 'success',
            processed: true
        });

        if (needsRevision) {
            bot.telegram.sendMessage(ADMIN_ID, `⚠️ *ORDER ${orderId} BUTUH REVISI KONTEN!* \nKetik: /update ${orderId} [index] [konten]`);
        } else {
            bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI!*\nData terkirim ke web user.`);
        }

    } catch (e) {
        console.error(e);
        bot.telegram.sendMessage(ADMIN_ID, `❌ Error Auto Fulfill: ${e.message}`);
    }
};

// --- ACTION HANDLERS BOT ---
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    ctx.answerCbQuery("Memproses...");
    ctx.editMessageText(`⏳ Memproses Order ${orderId}...`);
    const doc = await db.collection('orders').doc(orderId).get();
    if (doc.exists) await autoFulfillOrder(orderId, doc.data(), true);
    else ctx.reply("Order tidak ditemukan.");
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'failed' });
    ctx.editMessageText(`🚫 Order ${orderId} Ditolak.`);
});

// --- COMMANDS ---
bot.command('tambah', isAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/tambah ', '');
    const [name, price, image, desc, content] = text.split('|').map(t => t.trim());
    if (!name || !price) return ctx.reply("Format: /tambah Nama | Harga | ImgURL | Desc | KontenRahasia");
    await db.collection('products').add({ name, price: parseInt(price), image, desc, content: content || "", view: 0, sold: 0, variations: [], createdAt: new Date() });
    ctx.reply("✅ Produk tersimpan!");
});

bot.command('update', isAdmin, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const orderId = args[1];
    const itemIndex = parseInt(args[2]);
    const content = args.slice(3).join(' ');
    if (!orderId || !content) return ctx.reply("Format: /update [ID] [Index] [Konten]");
    
    const docRef = db.collection('orders').doc(orderId);
    const docSnap = await docRef.get();
    if(!docSnap.exists) return ctx.reply("Gagal load order.");
    
    let items = docSnap.data().items;
    if(items[itemIndex]) {
        items[itemIndex].content = content;
        await docRef.update({ items: items, status: 'success' }); // Force success
        ctx.reply("✅ Revisi Berhasil!");
    }
});

// --- SERVER LISTENER ---
app.get('/', (req, res) => res.send('Backend Aman Bos!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running port ${PORT}`);
    startWatcher();
    bot.launch();
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
