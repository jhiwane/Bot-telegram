const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// --- 1. SETUP SERVER ---
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

// State Ingatan Bot (Session)
const adminSession = {}; 
const ADMIN_ID = process.env.ADMIN_ID;

// --- 2. FIREBASE ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase Connected");
} catch (error) { console.error("❌ Firebase Error:", error.message); }
const db = admin.firestore();

// --- 3. BOT TELEGRAM ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 4. LOGIKA STOK CERDAS (NEWLINE SPLITTER) ---
const processStock = async (productId, variantName, qtyNeeded) => {
    const docRef = db.collection('products').doc(productId);
    
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        
        const data = doc.data();
        let contentPool = "";
        let isVariant = false;
        let variantIndex = -1;

        // Cek apakah ini variasi atau utama
        if (variantName && data.variations) {
            variantIndex = data.variations.findIndex(v => v.name === variantName);
            if (variantIndex !== -1) {
                contentPool = data.variations[variantIndex].content || "";
                isVariant = true;
            }
        } else {
            contentPool = data.content || "";
        }

        // LOGIKA POTONG STOK (PER BARIS)
        // Split berdasarkan Enter (\n), filter baris kosong
        let stocks = contentPool.split('\n').filter(s => s.trim().length > 0);
        
        if (stocks.length >= qtyNeeded) {
            // Ambil Qty yang dibutuhkan dari atas
            const taken = stocks.slice(0, qtyNeeded); 
            // Sisanya kembalikan ke pool
            const remaining = stocks.slice(qtyNeeded).join('\n');
            
            // Update Database dengan sisa stok
            if (isVariant) {
                data.variations[variantIndex].content = remaining;
                t.update(docRef, { variations: data.variations, sold: (data.sold || 0) + qtyNeeded });
            } else {
                t.update(docRef, { content: remaining, sold: (data.sold || 0) + qtyNeeded });
            }
            
            return { success: true, data: taken.join('\n') }; // Kembalikan data yang diambil
        } else {
            return { success: false, currentStock: stocks.length }; // Stok kurang
        }
    });
};

// --- 5. LOGIKA FULFILLMENT (ORDERAN) ---
const processOrderLogic = async (orderId, orderData) => {
    let items = [], needsRev = false, msgLog = "", revisionBtns = [];

    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];
        
        // Jika konten sudah ada (misal hasil revisi), skip proses stok
        if (item.content) {
            items.push(item);
            msgLog += `✅ ${item.name}: TERKIRIM (Manual)\n`;
            continue;
        }

        // Coba Ambil Stok Otomatis
        try {
            const result = await processStock(item.id, item.variantName, item.qty);
            
            if (result && result.success) {
                items.push({ ...item, content: result.data });
                msgLog += `✅ ${item.name} (x${item.qty}): TERKIRIM (Auto)\n`;
            } else {
                // Stok Kosong / Kurang
                items.push({ ...item, content: null });
                needsRev = true;
                msgLog += `⚠️ ${item.name} (x${item.qty}): STOK KURANG/KOSONG\n`;
                revisionBtns.push([Markup.button.callback(`🔧 ISI MANUAL (${item.qty} Baris): ${item.name}`, `rev_${orderId}_${i}`)]);
            }
        } catch (e) {
            console.error(e);
            items.push({ ...item, content: null });
            needsRev = true;
            msgLog += `❌ ${item.name}: ERROR DB\n`;
        }
    }

    // Update Order
    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    if (needsRev) {
        bot.telegram.sendMessage(ADMIN_ID, 
            `⚠️ *ORDER ${orderId} BUTUH REVISI*\nUser beli Qty banyak/Stok habis.\n\n${msgLog}`, 
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revisionBtns) }
        );
    } else {
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\nSemua stok terambil otomatis.\n\n${msgLog}`);
    }
};

// --- 6. ROUTE API (WEBHOOK) ---
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    
    bot.telegram.sendMessage(ADMIN_ID, 
        `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('⚡ PROSES (AUTO STOK)', `acc_${orderId}`)],
            [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
        ])
    );
    res.json({ status: 'ok' });
});

app.get('/', (req,res)=>res.send('SERVER JSN-02 READY'));

// --- 7. BOT BRAIN (PANEL ADMIN & SMART SEARCH) ---
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod'), Markup.button.callback('💰 PENJUALAN HARI INI', 'sales_today')],
    [Markup.button.callback('📦 TRACKING ORDER', 'track_order'), Markup.button.callback('⏳ RIWAYAT PENDING', 'list_pending')],
    [Markup.button.callback('📂 DAFTAR PRODUK (EDIT)', 'list_prod')]
]);

// A. COMMANDS
bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JSN-02*", { parse_mode: 'Markdown', ...mainMenu }));
bot.action('back_home', (ctx) => ctx.editMessageText("🛠 *PANEL ADMIN JSN-02*", { parse_mode: 'Markdown', ...mainMenu }));

// B. SMART SEARCH (CARI KODE PRODUK)
bot.on('text', async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;

    // 1. Cek Apakah Sedang Mode Input (Session)
    if (adminSession[userId]) {
        return handleInputSession(ctx, text, userId);
    }

    // 2. Smart Search: Cari Kode Produk di DB
    // Asumsi: Kode produk disimpan di field 'code'
    const snap = await db.collection('products').where('code', '==', text).get();
    
    if (!snap.empty) {
        // PRODUK KETEMU! Tampilkan Menu Edit
        const doc = snap.docs[0];
        const p = doc.data();
        const msg = `🔎 *DITEMUKAN: ${p.name}*\n🏷 Kode: ${p.code}\n💰 Rp ${p.price}\n📦 Stok Utama: ${p.content ? p.content.split('\n').length : 0} Baris`;
        
        ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✏️ Update Stok/Konten', `edit_content_${doc.id}`)],
                [Markup.button.callback('✏️ Edit Harga', `edit_price_${doc.id}`)],
                [Markup.button.callback('❌ Tutup', 'delete_msg')]
            ])
        });
    } else {
        // Jika bukan kode produk, mungkin chat biasa
        next();
    }
});

// C. INPUT HANDLER (WIZARD)
async function handleInputSession(ctx, text, userId) {
    const session = adminSession[userId];
    
    // --- TAMBAH PRODUK ---
    if (session.type === 'ADD_PROD') {
        const d = session.data;
        if (session.step === 'NAME') {
            d.name = text; session.step = 'PRICE';
            ctx.reply("💰 Kirim *HARGA* (Angka):");
        } else if (session.step === 'PRICE') {
            d.price = parseInt(text); session.step = 'CODE';
            ctx.reply("🏷 Kirim *KODE PRODUK* (Unik, cth: FF100):");
        } else if (session.step === 'CODE') {
            d.code = text; session.step = 'IMG';
            ctx.reply("🖼 Kirim *URL GAMBAR*:");
        } else if (session.step === 'IMG') {
            d.image = text; session.step = 'SOLD_VIEW';
            ctx.reply("👁 Kirim *FAKE SOLD & VIEW* (Pisah spasi, cth: 100 5000):");
        } else if (session.step === 'SOLD_VIEW') {
            const [s, v] = text.split(' ');
            d.sold = parseInt(s)||0; d.view = parseInt(v)||0; session.step = 'DESC';
            ctx.reply("📝 Kirim *DESKRIPSI*:");
        } else if (session.step === 'DESC') {
            d.desc = text; session.step = 'CONTENT';
            ctx.reply("📦 Kirim *DATA KONTEN/STOK* (Enter untuk baris baru):\nKetik 'kosong' jika nanti.");
        } else if (session.step === 'CONTENT') {
            d.content = text.toLowerCase()==='kosong'?'':text; session.step = 'VARS';
            ctx.reply("🔀 Kirim *VARIASI* (Format: Nama,Kode,Konten | Nama2,Kode2,Konten2)\nKetik 'skip' jika tidak ada.");
        } else if (session.step === 'VARS') {
            if(text.toLowerCase() !== 'skip') {
                d.variations = text.split('|').map(v => {
                    const [n, c, k] = v.split(',').map(x=>x.trim());
                    return { name: n, code: c, content: k };
                });
            } else { d.variations = []; }
            
            await db.collection('products').add({...d, createdAt: new Date()});
            delete adminSession[userId];
            ctx.reply(`✅ *PRODUK TERSIAPAN!*\n${d.name} (${d.code})`);
        }
    }

    // --- REVISI ORDER (MULTI LINE) ---
    if (session.type === 'REVISI') {
        const { orderId, itemIdx } = session;
        const docRef = db.collection('orders').doc(orderId);
        const snap = await docRef.get();
        const data = snap.data();
        
        if (data.items[itemIdx]) {
            data.items[itemIdx].content = text; // Simpan semua baris yg dikirim admin
            await docRef.update({ items: data.items });
            delete adminSession[userId];
            ctx.reply("✅ Data Tersimpan!");
            // Cek lagi apakah order sudah complete
            processOrderLogic(orderId, data);
        }
    }

    // --- UPDATE PRODUK (SMART SEARCH) ---
    if (session.type === 'UPDATE_PROD') {
        const { prodId, field } = session;
        if (field === 'content') {
            // Append mode atau Replace mode? Kita buat Replace/Update saja biar simpel
            await db.collection('products').doc(prodId).update({ content: text });
            ctx.reply("✅ Stok Utama Diupdate!");
        } else if (field === 'price') {
            await db.collection('products').doc(prodId).update({ price: parseInt(text) });
            ctx.reply("✅ Harga Diupdate!");
        }
        delete adminSession[userId];
    }
}

// D. ACTION HANDLERS
bot.action('add_prod', (ctx) => {
    adminSession[ctx.from.id] = { type: 'ADD_PROD', step: 'NAME', data: {} };
    ctx.reply("➕ *TAMBAH PRODUK BARU*\nKirim Nama Produk:");
});

bot.action('sales_today', async (ctx) => {
    const start = new Date(); start.setHours(0,0,0,0);
    const snap = await db.collection('orders')
        .where('status', '==', 'success')
        .where('createdAt', '>=', start).get();
    
    let total = 0, count = 0;
    snap.forEach(d => { total += d.data().total; count++; });
    ctx.reply(`💰 *PENJUALAN HARI INI*\nTotal: Rp ${total.toLocaleString()}\nJumlah: ${count} Transaksi`);
});

bot.action('list_pending', async (ctx) => {
    const snap = await db.collection('orders').where('status', '==', 'pending').get();
    if(snap.empty) return ctx.reply("Tidak ada order pending.");
    
    const btns = snap.docs.map(d => {
        const o = d.data();
        return [Markup.button.callback(`${o.buyerPhone} - Rp ${o.total}`, `cek_pending_${d.id}`)];
    });
    ctx.reply("⏳ *DAFTAR PENDING*", Markup.inlineKeyboard(btns));
});

bot.action(/^cek_pending_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const d = await db.collection('orders').doc(id).get();
    const o = d.data();
    ctx.reply(`🆔 ${id}\nUser: ${o.buyerPhone}\nTotal: ${o.total}\n\nACC?`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ ACC (PROSES)', `acc_${id}`)],
            [Markup.button.callback('❌ TOLAK', `tolak_${id}`)]
        ])
    );
});

bot.action('list_prod', (ctx) => {
    ctx.reply("ℹ️ Ketik *KODE PRODUK* di chat untuk mencari & mengeditnya langsung.\nContoh: `FF100`");
});

// LOGIKA ACC & REVISI
bot.action(/^acc_(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    ctx.reply(`⚙️ Memproses Order ${id}...`);
    const d = await db.collection('orders').doc(id).get();
    if(d.exists) await processOrderLogic(id, d.data());
});

bot.action(/^rev_(.+)_(.+)$/, (ctx) => {
    const [_, oid, idx] = ctx.match;
    adminSession[ctx.from.id] = { type: 'REVISI', orderId: oid, itemIdx: parseInt(idx) };
    ctx.reply(`🔧 Kirim Data Konten untuk item ini (Bisa Multi Baris/Enter):`);
});

// UPDATE PRODUK FROM SEARCH
bot.action(/^edit_(.+)_(.+)$/, (ctx) => {
    const [_, field, pid] = ctx.match;
    adminSession[ctx.from.id] = { type: 'UPDATE_PROD', prodId: pid, field: field };
    ctx.reply(`✏️ Kirim nilai baru untuk ${field.toUpperCase()}:`);
});

bot.action('delete_msg', (ctx) => ctx.deleteMessage());

// --- 8. STARTUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SERVER RUNNING PORT ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
