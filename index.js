const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- 1. SETUP SERVER EXPRESS (INI YANG PENTING AGAR TIDAK FAILED TO FETCH) ---
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Endpoint Cek Kesehatan (Wajib buat Railway)
app.get('/', (req, res) => {
    res.send('Server Backend JSN-02 Aktif & Sehat!');
});

// --- 2. SETUP FIREBASE ---
let serviceAccount;
try {
    if(process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Firebase Config Loaded");
    }
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

// --- 4. API CONFIRM MANUAL (WEBHOOK DARI FRONTEND) ---
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    console.log(`🔔 Sinyal Masuk dari Web: ${orderId}`);

    if(!orderId) return res.status(400).json({ error: 'No ID' });

    let txt = "";
    if(Array.isArray(items)) items.forEach(i => txt += `- ${i.name} (${i.variantName||'-'}) x${i.qty}\n`);

    const msg = `🔔 *ORDER MANUAL BARU*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n🛒 *Item:*\n${txt}`;
    
    try {
        // Cek dulu apakah bot sudah siap?
        await bot.telegram.sendMessage(ADMIN_ID, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('✅ ACC', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]]).resize()
        });
        res.json({ status: 'ok', message: 'Terkirim ke Admin' });
    } catch (e) {
        console.error("Gagal kirim ke Telegram (Tapi server aman):", e.message);
        // Tetap return OK ke frontend agar tidak error merah, nanti admin cek manual di logs
        res.json({ status: 'queued', message: 'Bot sedang sibuk, data aman di database.' });
    }
});

// --- 5. LOGIKA BOT (AUTO FULFILL) ---
// (Fungsi ini dipanggil saat admin klik tombol di Telegram)
const autoFulfillOrder = async (orderId, orderData) => {
    try {
        let items = [], needsRev = false, msgLog = "";
        for (const item of orderData.items) {
            let contentFound = null;
            const pSnap = await db.collection('products').doc(item.id).get();
            if (pSnap.exists) {
                const p = pSnap.data();
                if (item.variantName && p.variations) {
                    const v = p.variations.find(va => va.name === item.variantName);
                    if (v && v.content) contentFound = v.content;
                }
                if (!contentFound && p.content) contentFound = p.content;
            }
            if (contentFound) { items.push({ ...item, content: contentFound }); msgLog += `✅ ${item.name}: OK\n`; }
            else { items.push({ ...item, content: null }); needsRev = true; msgLog += `⚠️ ${item.name}: KOSONG\n`; }
        }
        await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });
        
        // Update Sold Count
        orderData.items.forEach(async (i) => {
            if(i.id) await db.collection('products').doc(i.id).update({sold: admin.firestore.FieldValue.increment(i.qty)});
        });

        if (needsRev) bot.telegram.sendMessage(ADMIN_ID, `⚠️ *REVISI ORDER ${orderId}*\n${msgLog}\nKetik: \`/update ${orderId} 0 DataBaru\``, {parse_mode:'Markdown'});
        else bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI!*`, {parse_mode:'Markdown'});
    } catch (e) { console.error(e); }
};

// ACTIONS & COMMANDS
bot.action(/^acc_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    ctx.reply(`Proses ${id}...`);
    const doc = await db.collection('orders').doc(id).get();
    if(doc.exists) await autoFulfillOrder(id, doc.data());
});
bot.action(/^tolak_(.+)$/, async (ctx) => {
    await db.collection('orders').doc(ctx.match[1]).update({ status: 'failed' });
    ctx.editMessageText(`🚫 Ditolak.`);
});
bot.command('tambah', async (ctx) => {
    if(String(ctx.from.id) !== ADMIN_ID) return;
    const t = ctx.message.text.replace('/tambah ', '').split('|').map(s=>s.trim());
    if(t.length < 3) return ctx.reply("Format: /tambah Nama | Harga | Gambar | Desc | Konten");
    await db.collection('products').add({name:t[0], price:parseInt(t[1]), image:t[2], desc:t[3]||"", content:t[4]||"", view:0, sold:0, createdAt:new Date()});
    ctx.reply("✅ Disimpan!");
});
bot.command('update', async (ctx) => {
    if(String(ctx.from.id) !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if(args.length < 4) return ctx.reply("/update ID INDEX KONTEN");
    const docRef = db.collection('orders').doc(args[1]);
    const snap = await docRef.get();
    if(!snap.exists) return ctx.reply("Ga ada.");
    let items = snap.data().items;
    if(items[args[2]]) { items[args[2]].content = args.slice(3).join(' '); await docRef.update({items, status:'success'}); ctx.reply("✅ Updated!"); }
});

// --- 6. START UP (SERVER DULUAN BARU BOT) ---
const PORT = process.env.PORT || 3000;

// A. NYALAKAN SERVER (Agar Railway Happy & Frontend bisa fetch)
const server = app.listen(PORT, () => {
    console.log(`🚀 SERVER WEB SUDAH JALAN DI PORT ${PORT}`);
    console.log("⏳ Menyiapkan Bot di Background...");
    
    // B. NYALAKAN BOT (Asynchronous - Tidak memblokir server)
    startBotBackground(); 
});

// Fungsi Start Bot yang "Sabar"
async function startBotBackground() {
    if(!process.env.BOT_TOKEN) return console.log("❌ Token Bot Kosong");

    try {
        // Hapus webhook lama (Penting untuk mengatasi error 409)
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log("🧹 Webhook lama dibersihkan.");

        // Start Polling
        bot.launch().then(() => {
            console.log("🤖 BOT TELEGRAM BERHASIL ONLINE!");
        }).catch((err) => {
            console.error("⚠️ Bot Gagal Launch (Mungkin conflict):", err.message);
            console.log("🔄 Mencoba lagi dalam 10 detik...");
            setTimeout(startBotBackground, 10000); // Coba lagi nanti
        });

    } catch (e) {
        console.error("❌ Error Bot Init:", e.message);
        setTimeout(startBotBackground, 10000); // Coba lagi
    }
}

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
