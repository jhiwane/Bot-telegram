const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- CONFIG ---
const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_ID; // Pastikan ini ID Telegram Anda
// Jika mau Auto-WA, Anda butuh layanan Gateway (Contoh: Fonnte/Watsap). 
// Jika tidak ada, bot hanya akan memberi link wa.me
const WA_API_URL = "https://api.fonnte.com/send"; // Contoh jika punya
const WA_API_TOKEN = process.env.WA_TOKEN || ""; 

// --- INIT EXPRESS & FIREBASE ---
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Init Firebase (Cek agar tidak double init)
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// --- INIT BOT ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// STATE MANAGEMENT (Agar bot tau admin sedang edit apa)
// Format: { 'ID_TELEGRAM': { mode: 'EDIT_HARGA', data: 'ID_PRODUK', ... } }
const adminState = {};

// ============================================================
//  BAGIAN 1: API DARI WEBSITE (Handle Order Masuk)
// ============================================================

app.get('/', (req, res) => res.send('JSN-02 BRAIN ONLINE'));

app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    
    // Format pesan lapor ke Admin
    let txtItems = items.map(i => `- ${i.name} (${i.variantName||'Reg'}) x${i.qty}`).join('\n');
    const msg = `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n🛒 *Item:*\n${txtItems}`;

    try {
        await bot.telegram.sendMessage(ADMIN_ID, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ TERIMA (ACC)', `acc_${orderId}`)],
                [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ])
        });
        res.json({ status: 'ok' });
    } catch (e) {
        console.error("Bot Error:", e);
        res.status(500).json({ error: 'Bot Fail' });
    }
});

// ============================================================
//  BAGIAN 2: LOGIKA ORDER CERDAS (ACC & REVISI)
// ============================================================

// A. Fungsi Kirim WA Otomatis (Placeholder)
async function sendToWhatsApp(phone, message) {
    // Ubah 08xxx jadi 628xxx
    let formattedPhone = phone;
    if (phone.startsWith('0')) formattedPhone = '62' + phone.slice(1);
    
    console.log(`[WA-AUTO] Sending to ${formattedPhone}: ${message}`);
    
    // JIKA ANDA PUNYA API WA GATEWAY (Aktifkan kode di bawah ini)
    /*
    try {
        const axios = require('axios');
        await axios.post(WA_API_URL, { target: formattedPhone, message: message }, { headers: { Authorization: WA_API_TOKEN }});
        return true;
    } catch (e) { return false; }
    */
    
    return false; // Default return false karena belum pasang API
}

// B. Handler Tombol ACC
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    ctx.editMessageText("⏳ *Memproses Order...* Mengecek Stok/Konten...", { parse_mode: 'Markdown' });
    
    const docRef = db.collection('orders').doc(orderId);
    const docSnap = await docRef.get();
    
    if (!docSnap.exists) return ctx.reply("❌ Data order hilang.");
    const orderData = docSnap.data();
    
    let updatedItems = [];
    let itemsNeedRevision = [];
    let fullContentMsg = `*PESANAN ANDA: #${orderId}*\n\n`;

    // 1. CEK STOK OTOMATIS
    for (let [index, item] of orderData.items.entries()) {
        let contentFound = null;
        
        // Ambil data produk asli dari DB
        if(item.id) {
            const prodSnap = await db.collection('products').doc(item.id).get();
            if (prodSnap.exists) {
                const p = prodSnap.data();
                
                // Prioritas 1: Cek Variasi
                if (item.variantName && p.variations) {
                    const v = p.variations.find(x => x.name === item.variantName);
                    if (v && v.content && v.content !== "-") contentFound = v.content;
                }
                // Prioritas 2: Cek Konten Utama
                if (!contentFound && p.content && p.content !== "-") {
                    contentFound = p.content;
                }
            }
        }

        if (contentFound) {
            // Stok Ada: Masukkan ke item
            updatedItems.push({ ...item, content: contentFound });
            fullContentMsg += `📦 *${item.name}*\nDATA: \`${contentFound}\`\n\n`;
        } else {
            // Stok Kosong: Tandai butuh revisi
            updatedItems.push({ ...item, content: null }); // Content null = Web menampilkan "Diproses"
            itemsNeedRevision.push({ index, name: item.name, variant: item.variantName });
        }
    }

    // 2. UPDATE DATABASE
    // Kita set status 'success' agar user tidak panik, tapi item yg null akan loading di web
    await docRef.update({ items: updatedItems, status: 'success', processedAt: new Date() });

    // 3. KEPUTUSAN BOT
    if (itemsNeedRevision.length === 0) {
        // SKENARIO A: SEMUA ADA STOK
        ctx.reply(`✅ *ORDER ${orderId} SELESAI (AUTO)*\nSemua data item ditemukan dan dikirim ke web.`, { parse_mode: 'Markdown' });
        
        // Coba kirim WA
        const sent = await sendToWhatsApp(orderData.buyerPhone, fullContentMsg);
        if(!sent) ctx.reply(`⚠️ Gagal Auto-WA (API Belum ada). Manual: https://wa.me/${orderData.buyerPhone}?text=${encodeURIComponent(fullContentMsg)}`);
        
    } else {
        // SKENARIO B: ADA YANG KOSONG (BUTUH REVISI)
        let msg = `⚠️ *ORDER DITERIMA TAPI KOSONG*\nID: \`${orderId}\`\n\nItem berikut belum ada kontennya:\n`;
        const buttons = [];
        
        itemsNeedRevision.forEach(r => {
            msg += `- ${r.name} (${r.variant || 'Utama'})\n`;
            // Buat tombol REVISI per item
            buttons.push([Markup.button.callback(`✍️ ISI KONTEN: ${r.name.substr(0,10)}...`, `revisi_${orderId}_${r.index}`)]);
        });

        msg += `\nSilakan klik tombol di bawah untuk mengisi data secara manual (interaktif).`;
        ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    }
});

// C. Handler Klik Tombol REVISI
bot.action(/^revisi_(.+)_(.+)$/, (ctx) => {
    const [_, orderId, itemIndex] = ctx.match;
    // Simpan state bahwa admin sedang mau merevisi item ini
    adminState[ctx.from.id] = {
        mode: 'REVISI_ORDER',
        orderId: orderId,
        itemIndex: parseInt(itemIndex)
    };
    ctx.reply(`✍️ *MODE REVISI AKTIF*\n\nSilakan REPLY/BALAS pesan ini dengan konten untuk Order \`${orderId}\` (Item Index: ${itemIndex}).\n\nContoh: \`Akun: user123 Pass: abcde\``, { parse_mode: 'Markdown' });
});

// ============================================================
//  BAGIAN 3: MANAJEMEN PRODUK VIA TELEGRAM (/kode)
// ============================================================

// 1. Command List Produk
bot.command('kode', async (ctx) => {
    const snaps = await db.collection('products').orderBy('createdAt', 'desc').limit(10).get();
    if (snaps.empty) return ctx.reply("Belum ada produk. Ketik /tambah");
    
    const buttons = snaps.docs.map(doc => {
        const p = doc.data();
        return [Markup.button.callback(`📦 ${p.name}`, `prod_${doc.id}`)];
    });
    
    // Tombol Tambah Produk Baru
    buttons.push([Markup.button.callback('➕ TAMBAH PRODUK BARU', 'add_product')]);
    
    ctx.reply("📂 *PANEL DATA PRODUK*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// 2. Detail Produk & Menu Edit
bot.action(/^prod_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const doc = await db.collection('products').doc(id).get();
    if (!doc.exists) return ctx.reply("Produk hilang.");
    const p = doc.data();
    
    let msg = `📦 *${p.name}*\n💰 Rp ${p.price}\n👁 View: ${p.view||0} | Sold: ${p.sold||0}\n\n`;
    if (p.variations && p.variations.length) {
        msg += `🗂 *Variasi:*\n`;
        p.variations.forEach((v, i) => msg += `- [${i}] ${v.name}: Rp ${v.price}\n`);
    }

    const btn = [
        [Markup.button.callback('✏️ Ubah Nama', `edit_${id}_name`), Markup.button.callback('💵 Ubah Harga', `edit_${id}_price`)],
        [Markup.button.callback('🖼 Set Gambar', `edit_${id}_image`), Markup.button.callback('📝 Deskripsi', `edit_${id}_desc`)],
        [Markup.button.callback('📊 Fake Sold', `edit_${id}_sold`), Markup.button.callback('👁 Fake View', `edit_${id}_view`)],
        [Markup.button.callback('📦 Set Konten Utama', `edit_${id}_content`)],
        [Markup.button.callback('➕ Tambah Variasi', `addvar_${id}`), Markup.button.callback('🗑 HAPUS', `del_${id}`)],
        [Markup.button.callback('🔙 KEMBALI', 'back_list')]
    ];
    
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btn) });
});

// 3. Handler Klik Tombol Edit (Set State)
bot.action(/^edit_(.+)_(.+)$/, (ctx) => {
    const [_, id, field] = ctx.match;
    adminState[ctx.from.id] = { mode: 'EDIT_PRODUCT', id, field };
    ctx.reply(`⌨️ Silakan ketik nilai baru untuk *${field.toUpperCase()}*:`, { parse_mode: 'Markdown' });
});

bot.action('add_product', (ctx) => {
    adminState[ctx.from.id] = { mode: 'ADD_PRODUCT_NAME' };
    ctx.reply("⌨️ Masukkan NAMA Produk Baru:");
});

bot.action(/^addvar_(.+)$/, (ctx) => {
    adminState[ctx.from.id] = { mode: 'ADD_VAR_NAME', id: ctx.match[1] };
    ctx.reply("⌨️ Masukkan NAMA Variasi (Contoh: 100 Diamond):");
});

bot.action('back_list', (ctx) => ctx.deleteMessage().then(() => ctx.reply('/kode'))); // Hacky back

// ============================================================
//  BAGIAN 4: TEXT LISTENER (INTI KECERDASAN)
// ============================================================
// Ini menangkap semua teks yang diketik admin
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    if (String(userId) !== ADMIN_ID) return; // Security check

    const state = adminState[userId];
    const text = ctx.message.text;

    if (!state) return; // Tidak sedang edit apa-apa

    try {
        // --- A. LOGIKA REVISI ORDER (REPLY) ---
        if (state.mode === 'REVISI_ORDER') {
            const { orderId, itemIndex } = state;
            const docRef = db.collection('orders').doc(orderId);
            const snap = await docRef.get();
            
            if (snap.exists) {
                let items = snap.data().items;
                // Update Konten di Index yang spesifik
                if (items[itemIndex]) {
                    items[itemIndex].content = text; // Inject Text Admin ke Database
                    
                    // Update DB
                    await docRef.update({ items: items });
                    
                    ctx.reply(`✅ *Data Tersimpan!* Klien sekarang bisa melihat data di Web.`);
                    
                    // AUTO SEND KE WHATSAPP (Setelah Revisi)
                    const buyerPhone = snap.data().buyerPhone;
                    const waMsg = `*ORDER UPDATE #${orderId}*\n\nData pesanan Anda sudah siap:\n\n${items[itemIndex].name}\nDATA: ${text}\n\nTerima kasih!`;
                    
                    const sent = await sendToWhatsApp(buyerPhone, waMsg);
                    if (sent) ctx.reply("✅ Terkirim ke WA Pelanggan (Auto).");
                    else ctx.reply(`⚠️ Gagal Auto-WA. Klik link ini untuk kirim: https://wa.me/${buyerPhone}?text=${encodeURIComponent(waMsg)}`);
                }
            }
            delete adminState[userId]; // Reset state
        }

        // --- B. LOGIKA EDIT PRODUK ---
        else if (state.mode === 'EDIT_PRODUCT') {
            let val = text;
            // Convert angka jika perlu
            if (['price', 'sold', 'view'].includes(state.field)) val = parseInt(text);
            
            await db.collection('products').doc(state.id).update({ [state.field]: val });
            ctx.reply(`✅ Berhasil ubah ${state.field}. Ketik /kode untuk lihat.`);
            delete adminState[userId];
        }

        // --- C. LOGIKA TAMBAH PRODUK (Multistep) ---
        else if (state.mode === 'ADD_PRODUCT_NAME') {
            // Buat draft produk baru
            const ref = await db.collection('products').add({
                name: text, price: 0, view: 0, sold: 0, createdAt: new Date()
            });
            adminState[userId] = { mode: 'EDIT_PRODUCT', id: ref.id, field: 'price' }; // Auto lanjut ke harga
            ctx.reply(`✅ Nama diset. Sekarang masukkan HARGA:`);
        }
        
        // --- D. LOGIKA TAMBAH VARIASI (Multistep) ---
        else if (state.mode === 'ADD_VAR_NAME') {
            adminState[userId] = { mode: 'ADD_VAR_PRICE', id: state.id, varName: text };
            ctx.reply(`Oke variasi "${text}". Sekarang masukkan HARGANYA:`);
        }
        else if (state.mode === 'ADD_VAR_PRICE') {
            adminState[userId] = { ...state, mode: 'ADD_VAR_CONTENT', varPrice: parseInt(text) };
            ctx.reply(`Harga Rp ${text}. Sekarang masukkan KONTEN/DATA (Ketik "-" jika kosong):`);
        }
        else if (state.mode === 'ADD_VAR_CONTENT') {
            const newVar = { name: state.varName, price: state.varPrice, content: text };
            // Pakai arrayUnion firebase
            await db.collection('products').doc(state.id).update({
                variations: admin.firestore.FieldValue.arrayUnion(newVar)
            });
            ctx.reply("✅ Variasi berhasil ditambahkan!");
            delete adminState[userId];
        }

    } catch (e) {
        console.error(e);
        ctx.reply("❌ Terjadi kesalahan: " + e.message);
    }
});

// --- STARTUP ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    bot.launch().then(() => console.log("Bot Telegram Online"));
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
