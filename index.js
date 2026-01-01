const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- 1. SETUP SERVER WEB (PRIORITAS UTAMA - ANTI MATI) ---
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Endpoint Cek Nyawa (Agar Railway senang)
app.get('/', (req, res) => {
    const status = bot && bot.botInfo ? `ONLINE (@${bot.botInfo.username})` : 'SEDANG STARTING...';
    res.send(`SERVER JSN-02 UTAMA AKTIF! Status Bot: ${status}`);
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

const isAdmin = (ctx, next) => {
    if (String(ctx.from?.id) === ADMIN_ID) return next();
};

// --- 4. LOGIKA OTAK CERDAS (AUTO FULFILLMENT) ---
const autoFulfillOrder = async (orderId, orderData) => {
    try {
        console.log(`⚙️ Memproses Konten Otomatis: ${orderId}`);
        
        let fulfilledItems = [];
        let needsRevision = false;
        let messageLog = "";

        // Loop setiap item yang dibeli user
        for (const item of orderData.items) {
            let contentFound = null;

            // Cek Database Produk
            const prodSnap = await db.collection('products').doc(item.id).get();
            
            if (prodSnap.exists) {
                const prodData = prodSnap.data();
                
                // 1. Cek Variasi
                if (item.variantName && prodData.variations) {
                    const variant = prodData.variations.find(v => v.name === item.variantName);
                    if (variant && variant.content) contentFound = variant.content;
                }
                
                // 2. Cek Utama
                if (!contentFound && prodData.content) {
                    contentFound = prodData.content;
                }
            }

            if (contentFound) {
                fulfilledItems.push({ ...item, content: contentFound });
                messageLog += `✅ ${item.name}: OK (Data Terkirim)\n`;
            } else {
                fulfilledItems.push({ ...item, content: null });
                needsRevision = true;
                messageLog += `⚠️ ${item.name}: KOSONG (Butuh Isi Manual)\n`;
            }
        }

        // Update Firebase (User langsung lihat di Web)
        await db.collection('orders').doc(orderId).update({
            items: fulfilledItems,
            status: 'success',
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

        // Lapor Admin
        if (needsRevision) {
            bot.telegram.sendMessage(ADMIN_ID, 
                `⚠️ *ORDER ${orderId} SELESAI TAPI ADA YG KOSONG!*\n${messageLog}\n👇 *REVISI MANUAL:* \nKetik: \`/update ${orderId} 0 DataAkunBaru\``, 
                { parse_mode: 'Markdown' }
            );
        } else {
            bot.telegram.sendMessage(ADMIN_ID, 
                `✅ *ORDER ${orderId} SUKSES SEMPURNA!*\nSemua data sudah masuk ke web user.`,
                { parse_mode: 'Markdown' }
            );
        }

    } catch (e) {
        console.error("Error Fulfill:", e);
        bot.telegram.sendMessage(ADMIN_ID, `❌ Gagal Proses Otomatis: ${e.message}`);
    }
};

// --- 5. API WEBHOOK (DARI TOMBOL SUDAH BAYAR) ---
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
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ACC', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ]).resize()
        });
        res.json({ status: 'ok' });
    } catch (e) {
        console.error("Gagal lapor TG (Server tetap aman):", e.message);
        res.json({ status: 'queued', message: 'Bot restart, pesan antri.' });
    }
});

// --- 6. BOT COMMANDS & ACTIONS ---

// Tombol ACC
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    ctx.answerCbQuery("Memproses...");
    ctx.editMessageText(`⏳ Memproses Order \`${orderId}\`...\nMencari stok konten di database...`, {parse_mode:'Markdown'});
    
    const doc = await db.collection('orders').doc(orderId).get();
    if (doc.exists) await autoFulfillOrder(orderId, doc.data());
    else ctx.reply("❌ Data order hilang.");
});

// Tombol TOLAK
bot.action(/^tolak_(.+)$/, async (ctx) => {
    await db.collection('orders').doc(ctx.match[1]).update({ status: 'failed' });
    ctx.editMessageText(`🚫 Order Ditolak.`);
});

// Admin: Tambah Produk (+Konten)
bot.command('tambah', isAdmin, async (ctx) => {
    const text = ctx.message.text.replace('/tambah ', '');
    const parts = text.split('|').map(t => t.trim());
    
    if (parts.length < 3) return ctx.reply("❌ Format: /tambah Nama | Harga | Gambar | Desc | Konten(Opsional)");
    const [name, price, image, desc, content] = parts;

    await db.collection('products').add({
        name, price: parseInt(price), image, desc: desc||"", content: content||"", 
        view: 0, sold: 0, createdAt: new Date()
    });
    ctx.reply(`✅ Produk "${name}" Siap Jual!`);
});

// Admin: Manipulasi Views
bot.command('fake', isAdmin, async (ctx) => {
    const [_, id, view, sold] = ctx.message.text.split(' ');
    if(!id) return ctx.reply("/fake ID VIEW SOLD");
    await db.collection('products').doc(id).update({ view: parseInt(view), sold: parseInt(sold) });
    ctx.reply("😎 Data Fake Updated!");
});

// Admin: Revisi Konten Manual
bot.command('update', isAdmin, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const orderId = args[1];
    const idx = parseInt(args[2]);
    const content = args.slice(3).join(' ');

    if(!orderId || isNaN(idx) || !content) return ctx.reply("/update ID INDEX KONTEN");

    const doc = await db.collection('orders').doc(orderId).get();
    if(!doc.exists) return ctx.reply("Ga ada.");

    let items = doc.data().items;
    if(items[idx]) {
        items[idx].content = content;
        await db.collection('orders').doc(orderId).update({ items, status: 'success' });
        ctx.reply("✅ Revisi Berhasil! User bisa cek web sekarang.");
    }
});

// --- 7. STARTUP SEQUENCE (SERVER DULUAN -> BOT BELAKANGAN) ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 SERVER WEB JALAN DI PORT ${PORT}`);
    console.log("⏳ Menunggu 10 detik agar sesi bot lama mati total...");
    
    // DELAY START BOT (KUNCI KESTABILAN)
    setTimeout(() => {
        startBotSafe();
    }, 10000); 
});

async function startBotSafe() {
    if(!process.env.BOT_TOKEN) return console.log("❌ Token kosong.");

    try {
        console.log("🔄 Hapus webhook lama...");
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        console.log("🤖 Login Bot...");
        await bot.launch();
        
        console.log(`✅ BOT FINAL ONLINE! Username: @${bot.botInfo.username}`);
        bot.telegram.sendMessage(ADMIN_ID, "🚀 JSN-02 FULL SYSTEM ONLINE!").catch(()=>{});

    } catch (error) {
        if (error.response && error.response.error_code === 409) {
            console.log("⚠️ Masih bentrok. Coba lagi 5 detik...");
            setTimeout(startBotSafe, 5000);
        } else {
            console.error("❌ Bot Error:", error.message);
        }
    }
}

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
