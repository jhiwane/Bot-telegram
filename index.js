const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- 1. SETUP EXPRESS (Jantung Server) ---
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// --- 2. SETUP FIREBASE ---
let serviceAccount;
try {
    if(process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Firebase Config Loaded");
    } else { throw new Error("JSON Kosong"); }
} catch (error) {
    console.error("❌ ERROR JSON:", error.message);
}

if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// --- 3. SETUP BOT ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

const isAdmin = (ctx, next) => {
    if (String(ctx.from?.id) === ADMIN_ID) return next();
};

// --- 4. API WEBHOOK (Penerima Sinyal dari Web) ---
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    console.log(`🔔 Sinyal Masuk: ${orderId}`);

    if(!orderId) return res.status(400).json({ error: 'No ID' });

    let txt = "";
    if(Array.isArray(items)) items.forEach(i => txt += `- ${i.name} (${i.variantName||'-'}) x${i.qty}\n`);

    const msg = `🔔 *ORDER MANUAL BARU*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n🛒 *Item:*\n${txt}`;
    
    try {
        await bot.telegram.sendMessage(ADMIN_ID, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ACC', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ]).resize()
        });
        res.json({ status: 'ok' });
    } catch (e) {
        console.error("Gagal kirim TG:", e);
        res.status(500).json({ error: 'Bot Error' });
    }
});

// --- 5. LOGIKA ACC (Update Database & Kirim Konten) ---
bot.action(/^acc_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    ctx.answerCbQuery("Proses...");
    ctx.reply(`Sedang memproses ${id}...`);
    
    try {
        const doc = await db.collection('orders').doc(id).get();
        if(!doc.exists) return ctx.reply("Data hilang.");
        
        const data = doc.data();
        let items = [];
        
        // Cari konten
        for (const item of data.items) {
            let content = "Stok Kosong/Manual";
            const prod = await db.collection('products').doc(item.id).get();
            if(prod.exists) {
                const p = prod.data();
                if(p.content) content = p.content;
                if(item.variantName && p.variations) {
                    const v = p.variations.find(x => x.name === item.variantName);
                    if(v && v.content) content = v.content;
                }
            }
            items.push({...item, content});
        }

        await db.collection('orders').doc(id).update({
            status: 'success',
            items: items,
            processed: true
        });
        
        ctx.reply("✅ SUKSES! Data terkirim ke User.");
    } catch(e) { ctx.reply("Gagal: " + e.message); }
});

// --- 6. JURUS ANDALAN: ANTI-CRASH LAUNCHER ---
// Ini yang bikin bot kebal error 409
const startBot = async () => {
    try {
        console.log("🧹 Membersihkan sesi lama...");
        // Hapus webhook sisa-sisa deploy sebelumnya (WAJIB)
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        console.log("🤖 Menyalakan Bot...");
        // Launch dengan opsi drop pending agar pesan lama tidak bikin crash
        await bot.launch({ dropPendingUpdates: true });
        
        console.log("✅ BOT ONLINE & SIAP KERJA!");
    } catch (error) {
        console.error("⚠️ Gagal start bot:", error.message);
        console.log("⏳ Mencoba lagi dalam 5 detik...");
        setTimeout(startBot, 5000); // Coba lagi otomatis
    }
};

// --- 7. SERVER START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server Web (API) jalan di port ${PORT}`);
    if(process.env.BOT_TOKEN) startBot(); // Jalankan bot setelah server siap
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
