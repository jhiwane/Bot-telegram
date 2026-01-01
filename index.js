const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- 1. SETUP SERVER ---
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// --- 2. SETUP FIREBASE ---
let serviceAccount;
try {
    if(process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Firebase Config Loaded");
    } else { throw new Error("JSON Firebase Kosong"); }
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

// --- 4. LOGIKA AUTO FULFILL (OTAK CERDAS) ---
const autoFulfillOrder = async (orderId, orderData) => {
    try {
        let fulfilledItems = [];
        let needsRevision = false;
        let msgLog = "";

        for (const item of orderData.items) {
            let contentFound = null;
            const prodSnap = await db.collection('products').doc(item.id).get();
            
            if (prodSnap.exists) {
                const p = prodSnap.data();
                if (item.variantName && p.variations) {
                    const v = p.variations.find(va => va.name === item.variantName);
                    if (v && v.content) contentFound = v.content;
                }
                if (!contentFound && p.content) contentFound = p.content;
            }

            if (contentFound) {
                fulfilledItems.push({ ...item, content: contentFound });
                msgLog += `✅ ${item.name}: Ada\n`;
            } else {
                fulfilledItems.push({ ...item, content: null });
                needsRevision = true;
                msgLog += `⚠️ ${item.name}: KOSONG\n`;
            }
        }

        await db.collection('orders').doc(orderId).update({
            items: fulfilledItems,
            status: 'success',
            processed: true
        });

        // Update Sold
        orderData.items.forEach(async (i) => {
            if(i.id) await db.collection('products').doc(i.id).update({sold: admin.firestore.FieldValue.increment(i.qty)});
        });

        if (needsRevision) {
            bot.telegram.sendMessage(ADMIN_ID, `⚠️ *ORDER ${orderId} BUTUH REVISI!*\n${msgLog}\nKetik: \`/update ${orderId} 0 DataBaru\``, {parse_mode:'Markdown'});
        } else {
            bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SUKSES!* Data terkirim.`, {parse_mode:'Markdown'});
        }
    } catch (e) {
        console.error(e);
        bot.telegram.sendMessage(ADMIN_ID, `❌ Error Fulfill: ${e.message}`);
    }
};

// --- 5. API WEBHOOK (UNTUK TOMBOL SUDAH BAYAR) ---
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
        res.status(500).json({ error: 'Bot Error' });
    }
});

// --- 6. BOT ACTIONS ---
bot.action(/^acc_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    ctx.reply(`⏳ Memproses Order ${id}...`);
    const doc = await db.collection('orders').doc(id).get();
    if(doc.exists) await autoFulfillOrder(id, doc.data());
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    await db.collection('orders').doc(ctx.match[1]).update({ status: 'failed' });
    ctx.reply("🚫 Order Ditolak.");
});

bot.command('tambah', isAdmin, async (ctx) => {
    const t = ctx.message.text.replace('/tambah ', '').split('|').map(s=>s.trim());
    if(t.length < 3) return ctx.reply("Format: /tambah Nama | Harga | Gambar | Desc | Konten");
    await db.collection('products').add({name:t[0], price:parseInt(t[1]), image:t[2], desc:t[3]||"", content:t[4]||"", view:0, sold:0, createdAt:new Date()});
    ctx.reply("✅ Disimpan!");
});

// --- 7. SERVER & BOT LAUNCHER (DENGAN AUTO-RETRY) ---
app.get('/', (req, res) => res.send('Server Aman.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Server jalan di port ${PORT}`);
    startBotSafe(); // Jalankan bot dengan pengaman
});

// FUNGSI RAHASIA ANTI-CRASH 409
async function startBotSafe() {
    if(!process.env.BOT_TOKEN) return;
    
    try {
        console.log("🔄 Membersihkan sesi lama...");
        // Hapus webhook lama agar tidak bentrok dengan polling
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        console.log("🤖 Menyalakan Bot...");
        await bot.launch();
        console.log("✅ BOT ONLINE & SIAP MENERIMA PERINTAH!");
        
    } catch (error) {
        if (error.response && error.response.error_code === 409) {
            console.log("⚠️ TERDETEKSI BENTROK (Error 409)!");
            console.log("⏳ Menunggu 5 detik agar bot lama mati otomatis...");
            
            // Tunggu 5 detik lalu coba lagi (Rekursif)
            setTimeout(startBotSafe, 5000); 
        } else {
            console.error("❌ Error Bot Fatal:", error);
        }
    }
}

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
