const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// ==========================================
// 1. SETUP SERVER EXPRESS (NYAWA UTAMA)
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Variabel Global
let db;
let bot;
const adminSession = {}; // Ingatan Bot untuk sesi tanya jawab
const ADMIN_ID = process.env.ADMIN_ID;

// Endpoint Cek Status (Agar Railway tidak error timeout)
app.get('/', (req, res) => {
    res.json({
        status: "Server Online",
        bot: bot ? "Aktif" : "Sedang Menghubungkan..."
    });
});

// ==========================================
// 2. FUNGSI INISIALISASI (DATABASE & BOT)
// ==========================================

async function initSystem() {
    console.log("🔄 Memulai Inisialisasi Sistem...");

    // A. Konek Firebase
    try {
        if (!admin.apps.length) {
            if(process.env.FIREBASE_SERVICE_ACCOUNT) {
                const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
                db = admin.firestore();
                console.log("✅ Firebase Berhasil Terhubung");
            } else {
                console.error("❌ Variabel FIREBASE_SERVICE_ACCOUNT kosong!");
            }
        }
    } catch (e) { console.error("❌ Error Firebase:", e.message); }

    // B. Konek Bot Telegram (Dengan Loop Anti-Crash)
    if (process.env.BOT_TOKEN) {
        bot = new Telegraf(process.env.BOT_TOKEN);
        
        // Pasang Logika Bot (Brain)
        setupBotLogic();
        
        // Jalankan Bot di Background
        startBotLoop();
    }
}

// Fungsi Loop untuk menyalakan bot (Coba terus sampai berhasil)
async function startBotLoop() {
    try {
        // Hapus webhook lama biar tidak bentrok
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        console.log("🤖 Menyalakan Bot Telegram...");
        await bot.launch();
        console.log("✅ BOT ONLINE & SIAP INTERAKSI!");
        bot.telegram.sendMessage(ADMIN_ID, "🟢 PANEL ADMIN SIAP! Ketik /admin").catch(()=>{});
        
    } catch (e) {
        console.error("⚠️ Bot Gagal Start (Mungkin Bentrok):", e.message);
        console.log("⏳ Mencoba lagi dalam 10 detik...");
        setTimeout(startBotLoop, 10000); // Coba lagi nanti
    }
}

// ==========================================
// 3. LOGIKA INTERAKSI (BRAIN BOT)
// ==========================================

function setupBotLogic() {
    // Middleware Admin
    bot.use((ctx, next) => {
        if (ctx.from && String(ctx.from.id) === ADMIN_ID) return next();
    });

    // --- A. LISTENER TEKS (TANYA JAWAB) ---
    bot.on('text', async (ctx, next) => {
        const userId = ctx.from.id;
        const text = ctx.message.text;
        const session = adminSession[userId];

        // Jika tidak ada sesi tanya jawab, skip ke command biasa
        if (!session) return next();

        // 1. SESI TAMBAH PRODUK
        if (session.type === 'ADD_PRODUCT') {
            const data = session.data;
            switch (session.step) {
                case 'NAME':
                    data.name = text;
                    session.step = 'PRICE';
                    return ctx.reply(`💰 Nama: ${text}\nKirim *HARGA* (Angka):`, Markup.inlineKeyboard([Markup.button.callback('❌ Batal', 'cancel')]));
                case 'PRICE':
                    if(isNaN(text)) return ctx.reply("Harus angka!");
                    data.price = parseInt(text);
                    session.step = 'IMAGE';
                    return ctx.reply("🖼 Kirim *LINK GAMBAR*:", Markup.inlineKeyboard([Markup.button.callback('❌ Batal', 'cancel')]));
                case 'IMAGE':
                    data.image = text;
                    session.step = 'DESC';
                    return ctx.reply("📝 Kirim *DESKRIPSI*:", Markup.inlineKeyboard([Markup.button.callback('❌ Batal', 'cancel')]));
                case 'DESC':
                    data.desc = text;
                    session.step = 'CONTENT';
                    return ctx.reply("🔑 Kirim *KONTEN UTAMA* (Akun/Kode).\nKetik 'kosong' jika ingin nanti saja.", Markup.inlineKeyboard([Markup.button.callback('❌ Batal', 'cancel')]));
                case 'CONTENT':
                    data.content = text.toLowerCase() === 'kosong' ? "" : text;
                    await db.collection('products').add({ ...data, view: 0, sold: 0, createdAt: new Date() });
                    delete adminSession[userId];
                    return ctx.reply(`✅ *PRODUK DISIMPAN!*\n📦 ${data.name}\n💰 Rp ${data.price}`);
            }
        }

        // 2. SESI REVISI ORDER
        if (session.type === 'REVISI_ITEM') {
            const { orderId, itemIdx, itemName } = session;
            try {
                const docRef = db.collection('orders').doc(orderId);
                const snap = await docRef.get();
                if(snap.exists) {
                    const data = snap.data();
                    if(data.items[itemIdx]) {
                        data.items[itemIdx].content = text; // Simpan konten
                        await docRef.update({ items: data.items });
                        delete adminSession[userId];
                        ctx.reply(`✅ Konten *${itemName}* Disimpan!`);
                        
                        // Cek apakah sudah lengkap semua?
                        processOrderLogic(orderId, data);
                    }
                }
            } catch(e) { ctx.reply("Error DB: " + e.message); }
        }
    });

    // --- B. ACTION TOMBOL ---
    bot.action('cancel', (ctx) => {
        delete adminSession[ctx.from.id];
        ctx.reply("❌ Dibatalkan.");
    });

    bot.action('btn_tambah', (ctx) => {
        adminSession[ctx.from.id] = { type: 'ADD_PRODUCT', step: 'NAME', data: {} };
        ctx.reply("📦 Kirim *NAMA PRODUK*:");
    });

    bot.command('admin', (ctx) => {
        ctx.reply("🛠 *PANEL ADMIN*", Markup.inlineKeyboard([[Markup.button.callback('➕ TAMBAH PRODUK (INTERAKTIF)', 'btn_tambah')]]));
    });

    // Tombol Revisi Manual
    bot.action(/^rev_(.+)_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        const idx = parseInt(ctx.match[2]);
        const doc = await db.collection('orders').doc(orderId).get();
        const itemName = doc.data().items[idx].name;

        adminSession[ctx.from.id] = { type: 'REVISI_ITEM', orderId, itemIdx: idx, itemName };
        ctx.reply(`🔧 Kirim Konten untuk: *${itemName}*`);
    });

    // Tombol ACC Order
    bot.action(/^acc_(.+)$/, async (ctx) => {
        const id = ctx.match[1];
        ctx.editMessageText("⚙️ Memproses...");
        const doc = await db.collection('orders').doc(id).get();
        if(doc.exists) processOrderLogic(id, doc.data());
    });
    
    // Tombol TOLAK
    bot.action(/^tolak_(.+)$/, async (ctx) => {
        await db.collection('orders').doc(ctx.match[1]).update({ status: 'failed' });
        ctx.editMessageText("🚫 Ditolak.");
    });
}

// ==========================================
// 4. LOGIKA AUTO FULFILLMENT (ORDER)
// ==========================================

async function processOrderLogic(orderId, orderData) {
    let items = [], needsRev = false, msgLog = "", btns = [];

    for (let i = 0; i < orderData.items.length; i++) {
        let item = orderData.items[i];
        let content = item.content || null;

        if (!content) {
            const pSnap = await db.collection('products').doc(item.id).get();
            if (pSnap.exists) {
                const p = pSnap.data();
                if (item.variantName && p.variations) {
                    const v = p.variations.find(va => va.name === item.variantName);
                    if (v && v.content) content = v.content;
                }
                if (!content && p.content) content = p.content;
            }
        }

        if (content) {
            items.push({ ...item, content });
            msgLog += `✅ ${item.name}: ADA\n`;
        } else {
            items.push({ ...item, content: null });
            needsRev = true;
            msgLog += `⚠️ ${item.name}: KOSONG\n`;
            btns.push([Markup.button.callback(`🔧 ISI: ${item.name}`, `rev_${orderId}_${i}`)]);
        }
    }

    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    if (needsRev) {
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ *ORDER ${orderId} BUTUH ISI MANUAL*\n\n${msgLog}`, { parse_mode:'Markdown', ...Markup.inlineKeyboard(btns) });
    } else {
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SUKSES!*\nSemua data terkirim.`);
    }
}

// ==========================================
// 5. START SERVER (ANTI TIMEOUT RAILWAY)
// ==========================================

// Nyalakan Server Dulu (Supaya Railway Senang)
app.listen(PORT, () => {
    console.log(`🚀 SERVER WEB JALAN DI PORT ${PORT}`);
    
    // Baru nyalakan sistem lain
    initSystem();
});

// API Webhook dari Frontend
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name}`).join('\n');
    
    if(bot) {
        bot.telegram.sendMessage(ADMIN_ID, `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n💰 Rp ${total}\n${txt}`, 
            Markup.inlineKeyboard([[Markup.button.callback('⚡ PROSES', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]])
        );
    }
    res.json({ status: 'ok' });
});

// Graceful Shutdown
process.once('SIGINT', () => bot && bot.stop('SIGINT'));
process.once('SIGTERM', () => bot && bot.stop('SIGTERM'));
