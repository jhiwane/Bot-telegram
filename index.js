const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- SETUP EXPRESS ---
const app = express();

// --- KONFIGURASI CORS (PENTING UNTUK MENGATASI ERROR FRONTEND) ---
// Kita izinkan semua origin (*) agar tidak ada blokir-blokiran
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// --- DEBUGGING ERROR HANDLING ---
process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR:', err);
});

// --- SETUP FIREBASE ---
let serviceAccount;
try {
    // Menghapus spasi/newline yang mungkin terbawa saat copy-paste di Railway
    if(process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Firebase Config Loaded");
    } else {
        throw new Error("Variable FIREBASE_SERVICE_ACCOUNT kosong!");
    }
} catch (error) {
    console.error("❌ ERROR JSON FIREBASE:", error.message);
    console.error("Pastikan format JSON di Railway Variables Valid dan tidak terpotong!");
    // Jangan exit process agar kita bisa lihat log di Railway
}

if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// --- SETUP BOT ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// --- API ENDPOINT (YANG DIPANGGIL TOMBOL 'SUDAH BAYAR') ---
app.post('/api/confirm-manual', async (req, res) => {
    console.log("🔔 HIT: /api/confirm-manual");
    
    try {
        const { orderId, buyerPhone, total, items } = req.body;

        if(!orderId) {
            console.log("❌ Request ditolak: No Order ID");
            return res.status(400).json({ error: 'No Order ID' });
        }

        console.log(`✅ Memproses Order ID: ${orderId}`);

        let itemText = "";
        if(Array.isArray(items)) {
            items.forEach(i => itemText += `- ${i.name} (${i.variantName||'-'}) x${i.qty}\n`);
        }

        const msg = `🔔 *ORDER MANUAL BARU*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n🛒 *Item:*\n${itemText}`;
        
        // Kirim ke Telegram
        await bot.telegram.sendMessage(ADMIN_ID, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ACC', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ]).resize()
        });

        res.json({ status: 'ok', message: 'Notifikasi terkirim' });

    } catch (error) {
        console.error("❌ Gagal di API:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- HELPER UNTUK BOT ---
const autoFulfillOrder = async (orderId, orderData) => {
    // ... (Logika Auto Fulfill sama seperti sebelumnya) ...
    // Saya persingkat di sini agar muat, gunakan logika fulfill dari kode sebelumnya
    console.log(`Auto fulfilling order ${orderId}`);
};

// --- BOT ACTIONS ---
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    ctx.answerCbQuery("Sedang memproses...");
    ctx.reply(`Sedang memproses Order ${orderId}...`);
    
    // Logic ACC manual di sini (Update status firestore jadi success)
    try {
        await db.collection('orders').doc(orderId).update({ status: 'success' });
        ctx.reply("✅ Order Sukses diupdate!");
    } catch(e) {
        ctx.reply("❌ Gagal update database.");
    }
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'failed' });
    ctx.editMessageText(`🚫 Order ${orderId} Ditolak.`);
});

// --- JALANKAN SERVER ---
app.get('/', (req, res) => res.send('BACKEND HIDUP DAN SEHAT!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    
    // Jalankan bot hanya jika token ada
    if(process.env.BOT_TOKEN) {
        bot.launch().catch(err => console.error("❌ Bot Gagal Launch:", err));
        console.log("🤖 Bot Telegram Started");
    }
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
