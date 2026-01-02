const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
require('dotenv').config();

// ==========================================
// 1. SETUP SERVER & CONFIG
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_ID = process.env.ADMIN_ID;
const adminSession = {}; // OTAK SEMENTARA BOT

// --- FIREBASE ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) { console.error("❌ Firebase Error:", error.message); }
const db = admin.firestore();

// --- BOT TELEGRAM ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// Tombol Batal Umum
const cancelBtn = Markup.inlineKeyboard([Markup.button.callback('❌ BATAL', 'cancel_action')]);

// ==========================================
// 2. LOGIKA STOK & ORDER (BACKEND BRAIN)
// ==========================================

const processStock = async (productId, variantName, qtyNeeded) => {
    const docRef = db.collection('products').doc(productId);
    
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        
        const data = doc.data();
        let contentPool = "";
        let isVariant = false;
        let variantIndex = -1;

        // Cek Variasi
        if (variantName && data.variations) {
            variantIndex = data.variations.findIndex(v => v.name === variantName);
            if (variantIndex !== -1) {
                contentPool = data.variations[variantIndex].content || "";
                isVariant = true;
            }
        } else {
            contentPool = data.content || "";
        }

        // LOGIKA POTONG BARIS
        let stocks = contentPool.split('\n').filter(s => s.trim().length > 0);
        
        if (stocks.length >= qtyNeeded) {
            const taken = stocks.slice(0, qtyNeeded); 
            const remaining = stocks.slice(qtyNeeded).join('\n');
            const inc = parseInt(qtyNeeded);

            if (isVariant) {
                data.variations[variantIndex].content = remaining;
                t.update(docRef, { variations: data.variations, sold: (data.sold || 0) + inc });
            } else {
                t.update(docRef, { content: remaining, sold: (data.sold || 0) + inc });
            }
            return { success: true, data: taken.join('\n') };
        } else {
            return { success: false, currentStock: stocks.length };
        }
    });
};

const processOrderLogic = async (orderId, orderData) => {
    let items = [], needsRev = false, msgLog = "", revBtns = [];

    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];
        if (item.content) {
            items.push(item);
            msgLog += `✅ ${item.name}: OK (Manual)\n`;
            continue;
        }

        try {
            const result = await processStock(item.id, item.variantName, item.qty);
            if (result && result.success) {
                items.push({ ...item, content: result.data });
                msgLog += `✅ ${item.name}: SUKSES\n`;
            } else {
                items.push({ ...item, content: null });
                needsRev = true;
                msgLog += `⚠️ ${item.name}: STOK KURANG\n`;
                revBtns.push([Markup.button.callback(`🔧 ISI: ${item.name}`, `rev_${orderId}_${i}`)]);
            }
        } catch (e) {
            items.push({ ...item, content: null });
            needsRev = true;
            msgLog += `❌ ${item.name}: ERROR DB\n`;
        }
    }

    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    if (needsRev) {
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ *REVISI ORDER ${orderId}*\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) });
    } else {
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\n${msgLog}`);
    }
};

// ==========================================
// 3. API WEBHOOK
// ==========================================
app.post('/api/confirm-manual', async (req, res) => {
    const { orderId, buyerPhone, total, items } = req.body;
    let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
    bot.telegram.sendMessage(ADMIN_ID, 
        `🔔 *ORDER MASUK*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, 
        Markup.inlineKeyboard([[Markup.button.callback('⚡ PROSES', `acc_${orderId}`), Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]])
    );
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('SERVER JSN-02 READY'));

// ==========================================
// 4. BOT LISTENER (THE BRAIN)
// ==========================================

// --- MENU UTAMA ---
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('💰 PENJUALAN HARI INI', 'sales_today'), Markup.button.callback('⏳ PENDING', 'list_pending')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JSN-02*\nKetik Kode Produk untuk Edit/Hapus.", mainMenu));

// --- LISTENER TEXT (WIZARD & SEARCH) ---
bot.on('text', async (ctx, next) => {
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;
    const session = adminSession[userId];

    // A. JIKA SEDANG DALAM SESI (WIZARD)
    if (session) {
        // 1. TAMBAH PRODUK BARU
        if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') {
                d.name = text; session.step = 'CODE';
                ctx.reply("🏷 Masukkan *KODE PRODUK* (Unik, misal: FF100):", cancelBtn);
            } else if (session.step === 'CODE') {
                // Cek unik
                const cek = await db.collection('products').where('code', '==', text).get();
                if(!cek.empty) return ctx.reply("⛔ Kode sudah ada! Ganti kode:", cancelBtn);
                d.code = text; session.step = 'PRICE';
                ctx.reply("💰 Masukkan *HARGA UTAMA* (Angka):", cancelBtn);
            } else if (session.step === 'PRICE') {
                if(isNaN(text)) return ctx.reply("Harus Angka!");
                d.price = parseInt(text); session.step = 'IMG';
                ctx.reply("🖼 Masukkan *URL GAMBAR*:", cancelBtn);
            } else if (session.step === 'IMG') {
                d.image = text; session.step = 'STATS';
                ctx.reply("📊 Masukkan *FAKE SOLD & VIEW* (Pisah spasi, cth: 50 1000):", cancelBtn);
            } else if (session.step === 'STATS') {
                const [s, v] = text.split(' ');
                d.sold = parseInt(s)||0; d.view = parseInt(v)||0; session.step = 'DESC';
                ctx.reply("📝 Masukkan *DESKRIPSI*:", cancelBtn);
            } else if (session.step === 'DESC') {
                d.desc = text; session.step = 'CONTENT';
                ctx.reply("📦 Masukkan *STOK UTAMA* (Enter untuk baris baru).\nKetik 'skip' jika produk ini hanya variasi.", cancelBtn);
            } else if (session.step === 'CONTENT') {
                d.content = text.toLowerCase() === 'skip' ? '' : text; 
                session.step = 'VARS';
                ctx.reply("🔀 Masukkan *VARIASI* (Jika ada).\nFormat: Nama,Harga,Konten\n(Gunakan | untuk pemisah antar variasi)\n\nContoh:\n1 Minggu,20000,Akun1\nAkun2|1 Bulan,50000,AkunA\n\nKetik 'skip' jika tidak ada.", cancelBtn);
            } else if (session.step === 'VARS') {
                if(text.toLowerCase() !== 'skip') {
                    // Parser Variasi
                    d.variations = text.split('|').map(v => {
                        const lines = v.split('\n');
                        const [name, price, ...c] = lines[0].split(',');
                        const content = [c.join(','), ...lines.slice(1)].join('\n').trim();
                        return { name: name?.trim(), price: parseInt(price)||0, content };
                    });
                } else { d.variations = []; }
                
                await db.collection('products').add({...d, createdAt: new Date()});
                delete adminSession[userId];
                ctx.reply(`✅ *PRODUK TERSIMPAN!*\n📦 ${d.name} (${d.code})`);
            }
        }

        // 2. EDIT PRODUK (SINGLE FIELD)
        else if (session.type === 'EDIT_PROD') {
            const { prodId, field, varName } = session;
            const docRef = db.collection('products').doc(prodId);

            if (field === 'price') {
                await docRef.update({ price: parseInt(text) });
                ctx.reply("✅ Harga Utama Diupdate!");
            } else if (field === 'name') {
                await docRef.update({ name: text });
                ctx.reply("✅ Nama Produk Diupdate!");
            } else if (field === 'content') {
                // Replace Content
                await docRef.update({ content: text });
                ctx.reply("✅ Stok Utama Diupdate!");
            } else if (field === 'var_content') {
                // Update Stok Variasi Spesifik
                const snap = await docRef.get();
                let vars = snap.data().variations;
                const idx = vars.findIndex(v => v.name === varName);
                if(idx !== -1) {
                    vars[idx].content = text; // Replace stok
                    await docRef.update({ variations: vars });
                    ctx.reply(`✅ Stok Variasi ${varName} Diupdate!`);
                }
            }
            delete adminSession[userId];
        }

        // 3. REVISI ORDER
        else if (session.type === 'REVISI') {
            const { orderId, itemIdx } = session;
            const docRef = db.collection('orders').doc(orderId);
            const snap = await docRef.get();
            const data = snap.data();
            if(data.items[itemIdx]) {
                data.items[itemIdx].content = text;
                await docRef.update({ items: data.items });
                delete adminSession[userId];
                ctx.reply("✅ Data Revisi Tersimpan!");
                processOrderLogic(orderId, data);
            }
        }
        return;
    }

    // B. SMART SEARCH (CAR KODE PRODUK)
    const snap = await db.collection('products').where('code', '==', text).get();
    if (!snap.empty) {
        const doc = snap.docs[0];
        const p = doc.data();
        const stokUtama = p.content ? p.content.split('\n').filter(x=>x.trim()).length : 0;
        
        // Menu Edit Dinamis
        let buttons = [
            [Markup.button.callback('✏️ Edit Nama', `ed_name_${doc.id}`), Markup.button.callback('💰 Edit Harga', `ed_price_${doc.id}`)],
            [Markup.button.callback(`📦 Edit Stok Utama (${stokUtama})`, `ed_stok_${doc.id}`)],
            [Markup.button.callback('🗑️ HAPUS PRODUK INI', `del_prod_${doc.id}`)]
        ];

        // Jika ada variasi, tambah tombol edit variasi
        if (p.variations && p.variations.length > 0) {
            p.variations.forEach((v, idx) => {
                const vStok = v.content ? v.content.split('\n').filter(x=>x.trim()).length : 0;
                buttons.push([Markup.button.callback(`📦 Edit Stok: ${v.name} (${vStok})`, `ed_var_${doc.id}_${idx}`)]);
            });
        }

        ctx.reply(`🔎 *${p.name}*\n🏷 Kode: ${p.code}\n💰 Rp ${p.price}`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        });
    }
});

// ==========================================
// 5. ACTION HANDLERS (KLIK TOMBOL)
// ==========================================

// --- WIZARD START ---
bot.action('add_prod', (ctx) => {
    adminSession[ctx.from.id] = { type: 'ADD_PROD', step: 'NAME', data: {} };
    ctx.reply("➕ *TAMBAH PRODUK BARU*\nKirim Nama Produk:", cancelBtn);
});

// --- EDIT HANDLERS ---
bot.action(/^ed_name_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'EDIT_PROD', prodId: ctx.match[1], field: 'name' };
    ctx.reply("✏️ Kirim *NAMA BARU*:", cancelBtn);
});

bot.action(/^ed_price_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'EDIT_PROD', prodId: ctx.match[1], field: 'price' };
    ctx.reply("💰 Kirim *HARGA BARU* (Angka):", cancelBtn);
});

bot.action(/^ed_stok_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'EDIT_PROD', prodId: ctx.match[1], field: 'content' };
    ctx.reply("📦 Kirim *DATA STOK UTAMA BARU* (Isi ulang/Timpa semua):", cancelBtn);
});

// Edit Stok Variasi
bot.action(/^ed_var_(.+)_(.+)$/, async (ctx) => {
    const prodId = ctx.match[1];
    const idx = parseInt(ctx.match[2]);
    const doc = await db.collection('products').doc(prodId).get();
    const varName = doc.data().variations[idx].name;
    
    adminSession[ctx.from.id] = { type: 'EDIT_PROD', prodId, field: 'var_content', varName };
    ctx.reply(`📦 Kirim Stok Baru untuk variasi *${varName}*:`, cancelBtn);
});

// --- HAPUS HANDLER ---
bot.action(/^del_prod_(.+)$/, async (ctx) => {
    await db.collection('products').doc(ctx.match[1]).delete();
    ctx.editMessageText("🗑️ Produk telah dihapus permanen dari Database.");
});

// --- ORDER HANDLERS ---
bot.action('sales_today', async (ctx) => {
    const start = new Date(); start.setHours(0,0,0,0);
    const snap = await db.collection('orders').where('status','==','success').where('createdAt','>=',start).get();
    let total=0, count=0;
    snap.forEach(d=>{ total+=d.data().total; count++; });
    ctx.reply(`💰 *SALES HARI INI*\nTotal: Rp ${total.toLocaleString()}\nTrx: ${count}`);
});

bot.action('list_pending', async (ctx) => {
    const snap = await db.collection('orders').where('status','==','pending').get();
    if(snap.empty) return ctx.reply("Nihil.");
    const btns = snap.docs.map(d=>[Markup.button.callback(`${d.data().buyerPhone} - Rp ${d.data().total}`, `cek_${d.id}`)]);
    ctx.reply("⏳ PENDING:", Markup.inlineKeyboard(btns));
});

bot.action(/^cek_(.+)$/, async (ctx) => {
    const d = await db.collection('orders').doc(ctx.match[1]).get();
    const i = d.data().items.map(x=>`${x.name} x${x.qty}`).join(', ');
    ctx.reply(`Item: ${i}`, Markup.inlineKeyboard([[Markup.button.callback('PROSES', `acc_${d.id}`), Markup.button.callback('TOLAK', `tolak_${d.id}`)]]));
});

bot.action(/^acc_(.+)$/, async (ctx) => {
    ctx.reply("⚙️ Proses...");
    const d = await db.collection('orders').doc(ctx.match[1]).get();
    if(d.exists) processOrderLogic(ctx.match[1], d.data());
});

bot.action(/^tolak_(.+)$/, async (ctx) => {
    await db.collection('orders').doc(ctx.match[1]).update({status:'failed'});
    ctx.editMessageText("🚫 Ditolak.");
});

bot.action(/^rev_(.+)_(.+)$/, (ctx) => {
    adminSession[ctx.from.id] = { type: 'REVISI', orderId: ctx.match[1], itemIdx: parseInt(ctx.match[2]) };
    ctx.reply("🔧 Kirim data manual:", cancelBtn);
});

bot.action('cancel_action', (ctx) => {
    delete adminSession[ctx.from.id];
    ctx.reply("Batal.");
});

// --- START ---
app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
