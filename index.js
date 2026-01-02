const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- SETUP SERVER ---
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// --- FIREBASE ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) { console.error("❌ Error JSON Firebase"); }

if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// --- BOT TELEGRAM ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// --- STATE MANAGEMENT (INGATAN BOT) ---
// Ini untuk menyimpan status saat admin sedang mengedit produk
const adminState = {}; // Format: { adminId: { action: 'edit_price', productId: 'xxx' } }

// Middleware Admin
const isAdmin = (ctx, next) => {
    if (String(ctx.from?.id) === ADMIN_ID) return next();
};

// ==========================================
// 1. FITUR MANAJEMEN PRODUK (PANEL ADMIN)
// ==========================================

// Command: /kode (Lihat semua produk)
bot.command('kode', isAdmin, async (ctx) => {
    const snaps = await db.collection('products').get();
    if (snaps.empty) return ctx.reply("Belum ada produk.");

    // Buat tombol untuk setiap produk
    const buttons = snaps.docs.map(doc => {
        const p = doc.data();
        return [Markup.button.callback(`📦 ${p.name}`, `menu_prod_${doc.id}`)];
    });

    ctx.reply("📂 **PANEL ADMIN: DAFTAR PRODUK**\nKlik produk untuk edit:", 
        Markup.inlineKeyboard(buttons).resize()
    );
});

// Action: Menu Detail Produk
bot.action(/^menu_prod_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const snap = await db.collection('products').doc(id).get();
    if (!snap.exists) return ctx.reply("Produk hilang.");
    
    const p = snap.data();
    const info = `📦 *${p.name}*\n💰 Rp ${p.price}\n👁 View: ${p.view} | 🛒 Sold: ${p.sold}\n📝 Desc: ${p.desc ? 'Ada' : 'Kosong'}\n🔑 Konten Utama: ${p.content ? 'Terisi' : 'KOSONG'}\n🔀 Variasi: ${p.variations?.length || 0} Item`;

    // Menu Edit Lengkap
    const keyboard = [
        [Markup.button.callback('✏️ Ubah Nama', `edit_name_${id}`), Markup.button.callback('✏️ Ubah Harga', `edit_price_${id}`)],
        [Markup.button.callback('👁 Fake View', `edit_view_${id}`), Markup.button.callback('🛒 Fake Sold', `edit_sold_${id}`)],
        [Markup.button.callback('🖼 Ubah Gambar', `edit_image_${id}`), Markup.button.callback('📝 Deskripsi', `edit_desc_${id}`)],
        [Markup.button.callback('🔑 Konten Utama', `edit_content_${id}`), Markup.button.callback('🔀 Edit Variasi', `edit_vars_${id}`)],
        [Markup.button.callback('🔙 KEMBALI', `back_list`)]
    ];

    ctx.editMessageText(info, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(keyboard) });
});

// Action: Handler Klik Tombol Edit
bot.action(/^edit_(.+)_(.+)$/, (ctx) => {
    const field = ctx.match[1]; // name, price, view, dll
    const prodId = ctx.match[2];
    
    // Simpan status di ingatan bot
    adminState[ctx.from.id] = { action: field, productId: prodId };

    let msg = "";
    if (field === 'vars') msg = "Kirim Format Variasi:\n`Nama,Harga,Konten | Nama2,Harga2,Konten2`\n\nContoh:\n`Skin A,10000,KodeA | Skin B,20000,KodeB`";
    else if (field === 'content') msg = "Kirim Konten/Data Akun Utama baru:";
    else msg = `Kirim nilai baru untuk ${field.toUpperCase()}:`;

    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.action('back_list', (ctx) => ctx.deleteMessage()); // Atau panggil /kode lagi

// Listener Teks (Untuk Menangkap Input Admin)
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    // Cek apakah admin sedang dalam mode edit?
    if (adminState[userId]) {
        const { action, productId } = adminState[userId];
        const text = ctx.message.text;
        
        try {
            const docRef = db.collection('products').doc(productId);
            let updateData = {};
            let replyMsg = "✅ Update Berhasil!";

            // Logika Update Berdasarkan Action
            switch (action) {
                case 'name': updateData = { name: text }; break;
                case 'price': updateData = { price: parseInt(text) }; break;
                case 'view': updateData = { view: parseInt(text) }; break;
                case 'sold': updateData = { sold: parseInt(text) }; break;
                case 'image': updateData = { image: text }; break;
                case 'desc': updateData = { desc: text }; break;
                case 'content': updateData = { content: text }; break;
                case 'vars': 
                    // Parsing Format Variasi: Nama,Harga,Konten | Nama2...
                    const rawVars = text.split('|');
                    const newVars = rawVars.map(v => {
                        const [n, p, c] = v.split(',').map(s => s.trim());
                        return { name: n, price: parseInt(p), content: c };
                    });
                    updateData = { variations: newVars };
                    break;
                case 'revisi_order':
                    // Khusus Revisi Order (Format: ID_ORDER INDEX KONTEN)
                    // Logic ini ditangani terpisah di bawah, tapi kita reset state disini
                    break;
            }

            if (Object.keys(updateData).length > 0) {
                await docRef.update(updateData);
                ctx.reply(replyMsg);
            }
            
            // Hapus ingatan setelah selesai
            delete adminState[userId];

        } catch (e) {
            ctx.reply(`❌ Error: ${e.message}`);
        }
    } else {
        next(); // Jika bukan mode edit, lanjut ke listener lain
    }
});


// ==========================================
// 2. SISTEM ORDER CERDAS (AUTO WA & REVISI)
// ==========================================

// Fungsi Simulasi Kirim WA (Membutuhkan Server WA Gateway Pihak ke-3)
const sendWhatsApp = async (phone, message) => {
    console.log(`📲 [WA OTOMATIS] Ke: ${phone}, Pesan: ${message.substring(0, 50)}...`);
    // DISINI ANDA BISA PASANG API FONNTE / WMB / TWILIO
    // Contoh: axios.post('https://api.fonnte.com/send', { target: phone, message: message }, ...)
};

const processOrderLogic = async (orderId, orderData) => {
    let items = [], needsRev = false, msgLog = "", waMessage = `Halo kak! Order *${orderId}* Selesai:\n\n`;

    for (const item of orderData.items) {
        let content = item.content || null; // Pakai konten yg sudah ada kalau ada

        // Jika konten masih kosong, cari di database produk
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
            waMessage += `📦 *${item.name}*: ${content}\n`;
        } else {
            items.push({ ...item, content: null });
            needsRev = true;
            msgLog += `⚠️ ${item.name}: KOSONG (Perlu Revisi)\n`;
        }
    }

    // Update Firebase
    await db.collection('orders').doc(orderId).update({ 
        items, status: 'success', processed: true 
    });

    if (needsRev) {
        // Mode Revisi
        bot.telegram.sendMessage(ADMIN_ID, 
            `⚠️ *ORDER ${orderId} BUTUH REVISI!*\n${msgLog}\nKlik tombol di bawah untuk isi manual:`, 
            Markup.inlineKeyboard([
                [Markup.button.callback('🔧 REVISI SEKARANG', `revisi_${orderId}`)]
            ])
        );
    } else {
        // Sukses Total -> Kirim WA Otomatis
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} COMPLETE!*\nData terkirim ke Web & WA Pelanggan.`);
        
        // AUTO SEND WA (Jika nomor valid)
        if (orderData.buyerPhone && orderData.buyerPhone.length > 5) {
            waMessage += "\nTerima kasih sudah order!";
            sendWhatsApp(orderData.buyerPhone, waMessage);
        }
    }
};

// API Trigger dari Web
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    
    // Notif Awal
    let txt = items.map(i => `- ${i.name} (${i.variantName||'-'})`).join('\n');
    const msg = `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`;
    
    bot.telegram.sendMessage(ADMIN_ID, msg, 
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ PROSES OTOMATIS', `acc_${orderId}`)],
            [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
        ])
    );
    res.json({ status: 'ok' });
});

// Action: ACC Order
bot.action(/^acc_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    ctx.editMessageText(`⚙️ Memproses Order ${id}...`);
    const doc = await db.collection('orders').doc(id).get();
    if (doc.exists) await processOrderLogic(id, doc.data());
});

// Action: Trigger Revisi
bot.action(/^revisi_(.+)$/, (ctx) => {
    const id = ctx.match[1];
    ctx.reply(`Mode Revisi Aktif.\nFormat: \`/update ${id} [UrutanItem 0/1/2] [IsiKonten]\``);
});

// Command Manual Update (Revisi)
bot.command('update', isAdmin, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const orderId = args[1];
    const idx = parseInt(args[2]);
    const content = args.slice(3).join(' ');

    if (!orderId || !content) return ctx.reply("Format salah.");

    const docRef = db.collection('orders').doc(orderId);
    const snap = await docRef.get();
    let data = snap.data();
    
    if (data.items[idx]) {
        data.items[idx].content = content; // Update konten item
        
        // Cek lagi apakah semua item sudah terisi?
        const masihKosong = data.items.some(i => !i.content);
        
        if (!masihKosong) {
            ctx.reply("✅ Revisi Selesai! Semua item terisi. Mengirim WA Otomatis...");
            // Panggil ulang logika proses agar men-trigger kirim WA
            await processOrderLogic(orderId, data);
        } else {
            // Update DB saja, tunggu revisi item lain
            await docRef.update({ items: data.items });
            ctx.reply(`✅ Item ke-${idx} terisi. Masih ada item lain yang kosong.`);
        }
    }
});


// Start Server & Bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
    // Paksa start bot
    bot.telegram.deleteWebhook({ drop_pending_updates: true }).then(() => bot.launch());
});
