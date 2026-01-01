const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- 1. SETUP SERVER WEB (PRIORITAS UTAMA) ---
// Server ini HARUS nyala duluan supaya Railway tidak mematikan container.
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Endpoint Cek Nyawa (Penting buat Railway Health Check)
app.get('/', (req, res) => {
    const statusBot = bot && bot.botInfo ? `ONLINE (${bot.botInfo.username})` : 'MENUNGGU GILIRAN...';
    res.send(`SERVER JSN-02 AKTIF! Status Bot: ${statusBot}`);
});

// --- 2. SETUP FIREBASE ---
let serviceAccount;
try {
    if(process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Firebase Config Loaded");
    }
} catch (error) { console.error("❌ ERROR JSON:", error.message); }

if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// --- 3. SETUP BOT ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// --- 4. API CONFIRM MANUAL (Webhook dari Frontend) ---
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    console.log(`🔔 API HIT: Order ${orderId}`);

    if(!orderId) return res.status(400).json({ error: 'No ID' });

    // Cek apakah bot sudah siap?
    if (!bot.botInfo) {
        return res.status(503).json({ status: 'queued', message: 'Bot sedang restart, data aman.' });
    }

    let txt = "";
    if(Array.isArray(items)) items.forEach(i => txt += `- ${i.name} (${i.variantName||'-'}) x${i.qty}\n`);

    const msg = `🔔 *ORDER MANUAL BARU*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n🛒 *Item:*\n${txt}`;
    
    try {
        await bot.telegram.sendMessage(ADMIN_ID, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('✅ ACC', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]]).resize()
        });
        res.json({ status: 'ok' });
    } catch (e) {
        console.error("Gagal lapor Telegram:", e.message);
        res.json({ status: 'error', message: e.message });
    }
});

// --- 5. LOGIKA BOT (Command & Action) ---
// (Disederhanakan untuk test koneksi dulu)
bot.start((ctx) => ctx.reply('🤖 BOT ONLINE & SIAP KERJA!'));

bot.action(/^acc_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    ctx.reply(`Sedang memproses Order ${id}... (Logika Database Aktif)`);
    // Masukkan logika update firebase di sini nanti
    await db.collection('orders').doc(id).update({ status: 'success' });
    ctx.reply("✅ Order Sukses!");
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    await db.collection('orders').doc(id).update({ status: 'failed' });
    ctx.editMessageText("🚫 Ditolak.");
});

// --- 6. START SERVER DENGAN DELAY BOT (SOLUSI BENTROK) ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 SERVER WEB SUDAH JALAN DI PORT ${PORT}`);
    console.log("⏳ Menunggu 10 detik sebelum menyalakan Bot (Agar sesi lama mati dulu)...");
    
    // TUNDA START BOT 10 DETIK
    setTimeout(() => {
        startBot();
    }, 10000); 
});

async function startBot() {
    if(!process.env.BOT_TOKEN) return console.log("❌ Token Bot Kosong");

    try {
        console.log("🔄 Menghapus webhook lama...");
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        console.log("🤖 Sedang login ke Telegram...");
        await bot.launch();
        
        console.log(`✅ BOT BERHASIL LOGIN! Username: @${bot.botInfo.username}`);
        // Kirim pesan ke admin tanda bot hidup
        bot.telegram.sendMessage(ADMIN_ID, "🟢 Sistem JSN-02 Telah Restart & Online!").catch(() => {});

    } catch (error) {
        if (error.response && error.response.error_code === 409) {
            console.log("⚠️ Masih Bentrok! Mencoba lagi dalam 5 detik...");
            setTimeout(startBot, 5000); // Coba lagi
        } else {
            console.error("❌ Bot Gagal:", error.message);
        }
    }
}

// GRACEFUL SHUTDOWN (PENTING BUAT RAILWAY)
// Saat Railway mau mematikan server ini, kita matikan bot dulu biar gak nyangkut.
process.once('SIGINT', () => {
    console.log("🛑 Mematikan Bot...");
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    console.log("🛑 Mematikan Bot...");
    bot.stop('SIGTERM');
    process.exit(0);
});
