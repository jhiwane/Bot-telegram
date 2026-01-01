const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// ==========================================
// BAGIAN 1: START SERVER EXPRESS (PRIORITAS UTAMA)
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

// Config CORS & Body Parser
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Endpoint Cek Nyawa (Buka URL Railway di browser untuk cek ini)
app.get('/', (req, res) => {
    res.json({ 
        status: 'Online', 
        message: 'Server JSN-02 Berjalan!',
        botStatus: botReady ? 'Siap' : 'Sedang Loading...'
    });
});

// Jalankan Server LANGSUNG (Jangan tunggu database/bot)
app.listen(PORT, () => {
    console.log(`✅ [SERVER] HTTP Server listening on port ${PORT}`);
    console.log(`⏳ [INIT] Mulai menghubungkan Firebase & Telegram...`);
    
    // Baru jalankan fungsi berat di belakang layar
    initSystem();
});

// ==========================================
// BAGIAN 2: LOGIKA SISTEM (DATABASE & BOT)
// ==========================================

let db;
let bot;
let botReady = false;
const ADMIN_ID = process.env.ADMIN_ID;

async function initSystem() {
    // 1. Konek Firebase
    try {
        if (!admin.apps.length) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            db = admin.firestore();
            console.log("✅ [FIREBASE] Terhubung ke Database.");
        }
    } catch (e) {
        console.error("❌ [FIREBASE] Gagal:", e.message);
        return; // Stop jika database mati
    }

    // 2. Setup Bot Object
    if (process.env.BOT_TOKEN) {
        bot = new Telegraf(process.env.BOT_TOKEN);
        setupBotLogic(); // Pasang fungsi-fungsi bot
        
        // 3. Nyalakan Bot (Metode Anti-Macet)
        startBotTelegram();
    } else {
        console.log("⚠️ [BOT] Token tidak ditemukan.");
    }
}

// Fungsi Menyalakan Bot dengan Reset Webhook
async function startBotTelegram() {
    try {
        console.log("🔄 [BOT] Menghapus sesi lama (Delete Webhook)...");
        // Kita paksa hapus webhook biar polling bisa jalan
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log("✅ [BOT] Sesi lama bersih.");

        console.log("🚀 [BOT] Memulai Long Polling...");
        bot.launch().then(() => {
            botReady = true;
            console.log(`🤖 [BOT] BERHASIL LOGIN! Username: @${bot.botInfo.username}`);
            bot.telegram.sendMessage(ADMIN_ID, "🟢 SISTEM RESTART & ONLINE!").catch(()=>{});
        }).catch((err) => {
            console.error("❌ [BOT] Gagal Launch (Biasanya Conflict 409):", err.message);
            // Jika gagal, biarkan saja server tetap jalan. Jangan dimatikan process-nya.
            // Kita coba lagi nanti secara manual atau tunggu restart otomatis Railway
        });

    } catch (e) {
        console.error("❌ [BOT] Error saat inisialisasi:", e.message);
    }
}

// ==========================================
// BAGIAN 3: API & LOGIKA BISNIS
// ==========================================

// API: Terima Sinyal dari Website (Tombol Sudah Bayar)
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    console.log(`🔔 [API] Request Masuk: Order ${orderId}`);

    if (!orderId) return res.status(400).json({ error: 'No ID' });

    // Format Pesan
    let txt = "";
    if (Array.isArray(items)) items.forEach(i => txt += `- ${i.name} (${i.variantName||'-'}) x${i.qty}\n`);
    const msg = `🔔 *ORDER MANUAL BARU*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n🛒 *Item:*\n${txt}`;

    // Kirim ke Telegram (Fire & Forget)
    if (bot) {
        bot.telegram.sendMessage(ADMIN_ID, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ACC', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ]).resize()
        }).then(() => {
            console.log("✅ [API] Notif terkirim ke Admin");
        }).catch((e) => {
            console.error("⚠️ [API] Gagal kirim notif:", e.message);
        });
    }

    // Selalu balas SUKSES ke frontend biar web tidak loading terus
    res.json({ status: 'ok', message: 'Sinyal diterima server' });
});

// --- 5. LOGIKA BOT (AUTO FULFILL - VERSI ANTI MACET) ---
const autoFulfillOrder = async (orderId, orderData) => {
    console.log(`⚙️ [LOGIC] Memproses Order ${orderId}`);
    
    try {
        let fulfilledItems = [];
        let needsRevision = false;
        let msgLog = "";

        // Pastikan orderData.items ada isinya
        if (!orderData.items || !Array.isArray(orderData.items)) {
            bot.telegram.sendMessage(ADMIN_ID, `⚠️ Order ${orderId} struktur datanya rusak (tidak ada items).`);
            return;
        }

        for (const item of orderData.items) {
            let content = null;
            let statusItem = "❓";

            try {
                // Cek ID Produk valid atau tidak
                if (!item.id) throw new Error("ID Produk hilang");

                const snap = await db.collection('products').doc(item.id).get();
                
                if (snap.exists) {
                    const p = snap.data();
                    
                    // Cek Variasi dulu
                    if (item.variantName && p.variations && Array.isArray(p.variations)) {
                        const v = p.variations.find(x => x.name === item.variantName);
                        if (v && v.content) {
                            content = v.content;
                            statusItem = "✅ Varian";
                        }
                    }
                    
                    // Jika variasi kosong/tidak ketemu, cek konten utama
                    if (!content && p.content) {
                        content = p.content;
                        statusItem = "✅ Utama";
                    }
                } else {
                    statusItem = "❌ Produk Dihapus";
                }
            } catch (err) {
                console.error(`Error item ${item.name}:`, err.message);
                statusItem = "❌ Error DB";
            }

            // Hasil Akhir per Item
            if (content) {
                fulfilledItems.push({ ...item, content: content });
                msgLog += `${statusItem} ${item.name}: Terkirim\n`;
            } else {
                // KOSONG? Tetap push tapi content null
                fulfilledItems.push({ ...item, content: null });
                needsRevision = true;
                msgLog += `⚠️ ${item.name}: KOSONG / HILANG\n`;
            }
        }

        // UPDATE DATABASE (WAJIB JALAN MESKIPUN ADA YANG KOSONG)
        // Kita set status 'success' agar user bisa lihat di history, meski isinya masih kosong (pending revisi)
        await db.collection('orders').doc(orderId).update({ 
            items: fulfilledItems, 
            status: 'success', 
            processed: true 
        });
        
        // Update Sold Count (Hanya yang produknya ketemu)
        orderData.items.forEach(async (i) => {
            if(i.id) {
                try {
                    await db.collection('products').doc(i.id).update({sold: admin.firestore.FieldValue.increment(i.qty)});
                } catch(e) {} // Abaikan error sold count biar ga macet
            }
        });

        // LAPORAN FINAL KE TELEGRAM
        if (needsRevision) {
            bot.telegram.sendMessage(ADMIN_ID, 
                `⚠️ *ORDER ${orderId} SELESAI TAPI BUTUH REVISI!*\n\n${msgLog}\n👇 *CARA ISI MANUAL:*\nKetik: \`/update ${orderId} [Urutan 0,1,2..] [DataBaru]\``, 
                { parse_mode: 'Markdown' }
            );
        } else {
            bot.telegram.sendMessage(ADMIN_ID, 
                `✅ *ORDER ${orderId} SUKSES TOTAL!*\n${msgLog}`, 
                { parse_mode: 'Markdown' }
            );
        }

    } catch (e) {
        console.error("❌ [LOGIC] Fatal Error Fulfill:", e);
        bot.telegram.sendMessage(ADMIN_ID, `☠️ CRITICAL ERROR ORDER ${orderId}: ${e.message}`);
    }
};
// ==========================================
// BAGIAN 4: SETUP BOT LISTENER
// ==========================================
function setupBotLogic() {
    // Middleware Admin
    bot.use(async (ctx, next) => {
        if (ctx.from && String(ctx.from.id) === ADMIN_ID) return next();
    });

    bot.command('start', (ctx) => ctx.reply('Server JSN-02 Online Bos!'));

    // Klik ACC
    bot.action(/^acc_(.+)$/, async (ctx) => {
        const id = ctx.match[1];
        ctx.reply(`⏳ Memproses ${id}...`);
        const doc = await db.collection('orders').doc(id).get();
        if(doc.exists) await autoFulfillOrder(id, doc.data());
        else ctx.reply("Data order hilang dari database.");
    });

    // Klik TOLAK
    bot.action(/^tolak_(.+)$/, async (ctx) => {
        await db.collection('orders').doc(ctx.match[1]).update({ status: 'failed' });
        ctx.editMessageText("🚫 Order Ditolak.");
    });

    // Tambah Produk
    bot.command('tambah', async (ctx) => {
        const t = ctx.message.text.replace('/tambah ', '').split('|').map(s=>s.trim());
        if(t.length < 3) return ctx.reply("Format: /tambah Nama | Harga | Gambar | Desc | Konten");
        await db.collection('products').add({
            name:t[0], price:parseInt(t[1]), image:t[2], desc:t[3]||"", content:t[4]||"", 
            view:0, sold:0, createdAt:new Date()
        });
        ctx.reply("✅ Produk disimpan!");
    });

    // Update Manual
    bot.command('update', async (ctx) => {
        const args = ctx.message.text.split(' '); // /update ID INDEX KONTEN
        if(args.length < 4) return ctx.reply("Format: /update [ID] [Index] [Konten]");
        
        const docRef = db.collection('orders').doc(args[1]);
        const snap = await docRef.get();
        if(!snap.exists) return ctx.reply("Order ga ada.");
        
        let items = snap.data().items;
        if(items[args[2]]) {
            items[args[2]].content = args.slice(3).join(' ');
            await docRef.update({ items, status: 'success' });
            ctx.reply("✅ Revisi Berhasil!");
        } else {
            ctx.reply("Index item salah.");
        }
    });
    
    // Fake Stats
    bot.command('fake', async (ctx) => {
        const [_, id, view, sold] = ctx.message.text.split(' ');
        await db.collection('products').doc(id).update({ view: parseInt(view), sold: parseInt(sold) });
        ctx.reply("✅ Fake stats updated.");
    });
}

// Graceful Shutdown
process.once('SIGINT', () => bot && bot.stop('SIGINT'));
process.once('SIGTERM', () => bot && bot.stop('SIGTERM'));
