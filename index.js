const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
require('dotenv').config();

// SETUP FIREBASE
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// SETUP BOT
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// MIDDLEWARE AUTH
const isAdmin = (ctx, next) => {
    if (String(ctx.from?.id) === ADMIN_ID) return next();
    return ctx.reply("⛔ Akses Ditolak!");
};

// --- 1. THE WATCHER (MATA-MATA DATABASE) ---
// Ini rahasianya. Bot memantau orderan baru secara realtime.
const startWatcher = () => {
    console.log("Mata-mata diaktifkan...");
    
    // Pantau Order PENDING (Manual Transfer)
    db.collection('orders').where('status', '==', 'pending').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const orderId = change.doc.id;
                notifyNewOrder(orderId, data, 'MANUAL');
            }
        });
    });

    // Pantau Order SUCCESS (Saldo - Langsung Kirim Data)
    db.collection('orders').where('status', '==', 'success').where('processed', '==', false).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const orderId = change.doc.id;
                // Tandai sudah diproses agar tidak notif 2x
                db.collection('orders').doc(orderId).update({ processed: true });
                notifyNewOrder(orderId, data, 'SALDO (AUTO)');
                // Auto fetch content untuk saldo
                autoFulfillOrder(orderId, data);
            }
        });
    });

    // Pantau KOMPLAIN
    db.collection('orders').where('complain', '==', true).where('complainResolved', '==', false).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const data = change.doc.data();
                bot.telegram.sendMessage(ADMIN_ID, `⚠️ *ADA KOMPLAIN!* ⚠️\nID: \`${change.doc.id}\`\nUser: ${data.buyerPhone}\nCek segera!`, {parse_mode:'Markdown'});
            }
        });
    });
};

// --- 2. LOGIC NOTIFIKASI & PROSES ---

const notifyNewOrder = (id, data, type) => {
    let itemText = "";
    data.items.forEach(i => itemText += `- ${i.name} (${i.variantName||'-'}) x${i.qty}\n`);
    
    const msg = `🔔 *ORDER BARU (${type})*\n🆔 \`${id}\`\n👤 ${data.buyerPhone}\n💰 Rp ${data.total.toLocaleString()}\n\n🛒 *Item:*\n${itemText}`;
    
    const buttons = [];
    if (type === 'MANUAL') {
        buttons.push(Markup.button.callback('✅ ACC & PROSES', `acc_${id}`));
        buttons.push(Markup.button.callback('❌ TOLAK', `tolak_${id}`));
    } else {
        buttons.push(Markup.button.callback('🔍 CEK STATUS', `cek_${id}`));
    }

    bot.telegram.sendMessage(ADMIN_ID, msg, Markup.inlineKeyboard([buttons], { columns: 2 }).resize());
};

// --- 3. AUTO FULFILLMENT (OTAK CERDAS) ---
const autoFulfillOrder = async (orderId, orderData, isManualAcc = false) => {
    try {
        let fulfilledItems = [];
        let needsRevision = false;
        let finalMessageToUser = "";

        // Loop setiap item untuk cari kontennya di database Produk
        for (const item of orderData.items) {
            let contentFound = null;

            // Cari Produk Master
            const prodSnap = await db.collection('products').doc(item.id).get();
            if (prodSnap.exists) {
                const prodData = prodSnap.data();
                
                // Cek apakah ini variasi?
                if (item.variantName && prodData.variations) {
                    const variant = prodData.variations.find(v => v.name === item.variantName);
                    if (variant && variant.content) contentFound = variant.content;
                }
                
                // Jika tidak ketemu di variasi, atau tidak ada variasi, cek konten utama
                if (!contentFound && prodData.content) {
                    contentFound = prodData.content;
                }
            }

            if (contentFound) {
                fulfilledItems.push({ ...item, content: contentFound });
                finalMessageToUser += `📦 *${item.name}*: ${contentFound}\n`;
            } else {
                fulfilledItems.push({ ...item, content: null }); // Kosong
                needsRevision = true;
            }
        }

        // UPDATE ORDER DI FIREBASE
        await db.collection('orders').doc(orderId).update({
            items: fulfilledItems,
            status: 'success', // Jadi sukses agar user bisa liat di web
            processed: true
        });

        // INCREMENT SOLD COUNT
        orderData.items.forEach(async (item) => {
            await db.collection('products').doc(item.id).update({ sold: admin.firestore.FieldValue.increment(item.qty) });
        });

        // NOTIFIKASI BALIK KE ADMIN
        if (needsRevision) {
            bot.telegram.sendMessage(ADMIN_ID, `⚠️ *ORDER ${orderId} BUTUH REVISI!*\nAda item yang kontennya kosong di database. Silakan update manual.\n\nKetik: /update ${orderId} [urutan_item] [konten]`);
        } else {
            bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI OTOMATIS!*\nData terkirim ke web.`);
            // SEND WA OTOMATIS (Simulasi Link Click karena keterbatasan server)
            const waText = `Halo kak! Orderan *${orderId}* SUKSES.\n\n${finalMessageToUser}\nTerima kasih!`;
            const waLink = `https://wa.me/${orderData.buyerPhone.replace(/^0/,'62')}?text=${encodeURIComponent(waText)}`;
            
            bot.telegram.sendMessage(ADMIN_ID, "Klik tombol di bawah untuk kirim WA ke pembeli (Semi-Auto):", 
                Markup.inlineKeyboard([Markup.button.url('📲 KIRIM WA SEKARANG', waLink)])
            );
        }

    } catch (e) {
        console.error(e);
        bot.telegram.sendMessage(ADMIN_ID, `❌ Error Auto Fulfill: ${e.message}`);
    }
};

// --- 4. ACTION HANDLERS ---
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    ctx.answerCbQuery("Memproses...");
    ctx.editMessageText(`⏳ Memproses Order ${orderId}... Mencari data produk...`);
    
    const doc = await db.collection('orders').doc(orderId).get();
    if (!doc.exists) return ctx.reply("Order hilang.");
    
    // Jalankan logika Cerdas
    await autoFulfillOrder(orderId, doc.data(), true);
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'failed' });
    ctx.editMessageText(`🚫 Order ${orderId} Ditolak.`);
});

// --- 5. MANUAL UPDATE (REVISI) ---
// Jika konten kosong, admin bisa isi manual lewat bot
bot.command('update', isAdmin, async (ctx) => {
    // Format: /update [ORDER_ID] [INDEX_ITEM_MULAI_0] [KONTEN]
    // Contoh: /update uY7a8 0 Akun:user/pass
    const args = ctx.message.text.split(' ');
    const orderId = args[1];
    const itemIndex = parseInt(args[2]);
    const content = args.slice(3).join(' ');

    if (!orderId || isNaN(itemIndex) || !content) return ctx.reply("Format: /update [ID] [IndexItem] [Konten]");

    try {
        const docRef = db.collection('orders').doc(orderId);
        const docSnap = await docRef.get();
        if(!docSnap.exists) return ctx.reply("Order ga ada.");

        let items = docSnap.data().items;
        if (!items[itemIndex]) return ctx.reply("Item index ga ketemu.");

        // Update konten item spesifik
        items[itemIndex].content = content;
        
        await docRef.update({ items: items });
        ctx.reply(`✅ Item ke-${itemIndex} di Order ${orderId} berhasil diupdate!`);
    } catch(e) { ctx.reply("Error update."); }
});

// --- 6. COMMAND TAMBAH PRODUK (DENGAN KONTEN) ---
bot.command('tambah', isAdmin, async (ctx) => {
    // Format Baru: nama | harga | image | deskripsi | KONTEN_RAHASIA
    const text = ctx.message.text.replace('/tambah ', '');
    const [name, price, image, desc, content] = text.split('|').map(t => t.trim());

    if (!name || !price) return ctx.reply("Format: /tambah Nama | Harga | ImgURL | Desc | KontenRahasia");

    await db.collection('products').add({
        name, price: parseInt(price), image, desc, 
        content: content || "", // Simpan konten di sini
        view: 0, sold: 0, variations: [], createdAt: new Date()
    });
    ctx.reply("✅ Produk + Konten tersimpan!");
});

// --- SERVER INIT ---
const app = express();
app.get('/', (req, res) => res.send('Bot Watcher Active'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running port ${PORT}`);
    startWatcher(); // JALANKAN MATA-MATA
    bot.launch();
});
