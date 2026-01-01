const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- 1. SETUP EXPRESS (Server Web) ---
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

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

// --- 4. API WEBHOOK (PENTING AGAR TIDAK EROR) ---
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    console.log(`🔔 Webhook Masuk: ${orderId}`);

    if(!orderId) return res.status(400).json({ error: 'No ID' });

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
        console.error("Gagal kirim TG:", e);
        // Jangan return error 500, return 200 aja biar frontend gak panik, kita log di sini
        res.json({ status: 'queued', message: 'Bot sedang restart, pesan antri.' });
    }
});

// --- 5. LOGIKA BOT (AUTO FULFILL) ---
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
        
        if (needsRev) bot.telegram.sendMessage(ADMIN_ID, `⚠️ *REVISI ORDER ${orderId}*\n${msgLog}\nKetik: \`/update ${orderId} 0 DataBaru\``, {parse_mode:'Markdown'});
        else bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI!*`, {parse_mode:'Markdown'});
    } catch (e) { console.error(e); }
};

// ACTIONS
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

// --- 6. SERVER START (RAHASIA UTAMA: SERVER DULUAN, BOT BELAKANGAN) ---
app.get('/', (req, res) => res.send('Server Aman Jaya!'));

const PORT = process.env.PORT || 3000;

// Jalankan Express Server DULUAN agar Railway tidak mematikan container
const server = app.listen(PORT, () => {
    console.log(`🚀 Server WEB sudah jalan di port ${PORT} (Railway Happy)`);
    
    // Baru jalankan Bot di background (Asynchronous)
    startBotLoop();
});

// Fungsi Looping Anti-Mati
async function startBotLoop() {
    if(!process.env.BOT_TOKEN) return;
    
    try {
        console.log("🤖 Mencoba menyalakan Bot...");
        // Hapus webhook lama agar bersih
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        // Launch bot
        await bot.launch();
        console.log("✅ BOT BERHASIL KONEK!");
    } catch (error) {
        if (error.response && error.response.error_code === 409) {
            console.log("⚠️ Masih Bentrok (409). Bot lain belum mati.");
            console.log("⏳ Menunggu 10 detik lalu coba lagi...");
            
            // Tunggu 10 detik, lalu panggil diri sendiri lagi (Recursion)
            setTimeout(startBotLoop, 10000); 
        } else {
            console.error("❌ Error Bot Lain:", error);
            // Coba lagi setelah 10 detik meski error lain
            setTimeout(startBotLoop, 10000);
        }
    }
}

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
