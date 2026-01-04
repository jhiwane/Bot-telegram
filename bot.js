// bot.js - LOGIKA UTAMA BOT & CLOUDINARY
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

module.exports = (bot, db, admin) => {
    const adminSession = {};
    const ADMIN_ID = process.env.ADMIN_ID;

    // --- HELPER CLOUDINARY ---
    const uploadToCloudinary = async (fileUrl, account) => {
        try {
            const formData = new URLSearchParams();
            formData.append('file', fileUrl);
            formData.append('upload_preset', account.preset); // Preset Unsigned
            const cloudName = account.cloudName;
            
            const res = await axios.post(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, formData);
            return res.data.secure_url;
        } catch (e) {
            throw new Error(`Gagal Upload: ${e.response?.data?.error?.message || e.message}`);
        }
    };

    // --- MENU UTAMA ---
    const mainMenu = Markup.inlineKeyboard([
        [Markup.button.callback('☁️ UPLOAD FILE (CLOUDINARY)', 'menu_cloud_upload')],
        [Markup.button.callback('➕ PRODUK', 'add_prod'), Markup.button.callback('📢 ATUR NOTIF', 'menu_notif')],
        [Markup.button.callback('📺 ATUR KONTEN', 'menu_content'), Markup.button.callback('📦 GUDANG', 'list_all_stock')],
        [Markup.button.callback('📄 UPLOAD STOK', 'restock_sheet_ask'), Markup.button.callback('👥 USER', 'manage_users')],
        [Markup.button.callback('⚙️ SETTING CLOUD', 'menu_cloud_set'), Markup.button.callback('☢️ DANGER ZONE', 'menu_danger')]
    ]);

    bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN JIE STORE*", { parse_mode: 'Markdown', ...mainMenu }));
    bot.command('upload', (ctx) => ctx.reply("☁️ Klik tombol di bawah untuk upload:", Markup.inlineKeyboard([[Markup.button.callback('☁️ PILIH AKUN CLOUD', 'menu_cloud_upload')]])));

    // --- LOGIKA PESAN & FILE ---
    bot.on(['text', 'photo', 'document'], async (ctx, next) => {
        if (String(ctx.from.id) !== ADMIN_ID) return next();
        let text = ctx.message.text || ctx.message.caption || '';
        const session = adminSession[ctx.from.id];

        // 1. HANDLER UPLOAD FILE KE CLOUDINARY
        if ((ctx.message.document || ctx.message.photo) && session && session.type === 'WAIT_CLOUD_FILE') {
            ctx.reply("⏳ Sedang mengupload ke Cloudinary...");
            try {
                // Ambil Link File Telegram
                const fileId = ctx.message.document ? ctx.message.document.file_id : ctx.message.photo[ctx.message.photo.length - 1].file_id;
                const fileLink = await ctx.telegram.getFileLink(fileId);
                
                // Upload ke Akun yang dipilih
                const url = await uploadToCloudinary(fileLink.href, session.account);
                
                delete adminSession[ctx.from.id];
                return ctx.reply(`✅ *UPLOAD SUKSES!*\n\n🔗 URL: \`${url}\`\n\n(Copy link di atas untuk produk/konten)`, { parse_mode: 'Markdown' });
            } catch (e) {
                return ctx.reply(`❌ Error: ${e.message}`);
            }
        }

        // 2. HANDLER SETUP AKUN CLOUDINARY BARU
        if (session && session.type === 'ADD_CLOUD_ACC') {
            const [name, cloudName, preset] = text.split('|').map(s=>s.trim());
            if (!name || !cloudName || !preset) return ctx.reply("❌ Format Salah. Ketik: NAMA_AKUN | CLOUD_NAME | PRESET_NAME");
            
            await db.collection('cloudinary_accounts').add({ name, cloudName, preset, createdAt: new Date() });
            delete adminSession[ctx.from.id];
            return ctx.reply(`✅ Akun Cloudinary "${name}" Disimpan!`);
        }

        // 3. HANDLER NUKE DB (HAPUS SEMUA) - PERLU KONFIRMASI TEXT
        if (session && session.type === 'NUKE_CONFIRM') {
            if (text === 'SAYA YAKIN HAPUS SEMUA') {
                ctx.reply("☢️ MEMULAI PENGHAPUSAN MASSAL... (JANGAN DIMATIKAN)");
                const collections = ['products', 'orders', 'users', 'vouchers', 'contents', 'settings'];
                let count = 0;
                for (const col of collections) {
                    const snap = await db.collection(col).get();
                    const batch = db.batch();
                    snap.docs.forEach(doc => batch.delete(doc.ref));
                    await batch.commit();
                    count += snap.size;
                }
                delete adminSession[ctx.from.id];
                return ctx.reply(`💀 **DATABASE RESET SELESAI.**\nTotal ${count} data dihapus selamanya.`);
            } else {
                delete adminSession[ctx.from.id];
                return ctx.reply("❌ Konfirmasi salah. Batal.");
            }
        }

        // ... (LOGIKA PRODUK, VOUCHER, DLL DARI KODE LAMA TETAP DISINI) ...
        // Agar tidak kepanjangan, paste logika session lama Anda di sini
    });

    // --- ACTIONS BARU ---

    // 1. Menu Danger Zone
    bot.action('menu_danger', (ctx) => {
        ctx.reply("⚠️ **DANGER ZONE** ⚠️\n\nHati-hati! Tombol ini berbahaya.", Markup.inlineKeyboard([
            [Markup.button.callback('💀 HAPUS SEMUA DATA (NUKE)', 'ask_nuke')],
            [Markup.button.callback('🔙 KEMBALI', 'cancel_action')]
        ]));
    });

    // 2. Aksi Nuke
    bot.action('ask_nuke', (ctx) => {
        adminSession[ctx.from.id] = { type: 'NUKE_CONFIRM' };
        ctx.reply("⚠️ **PERINGATAN KERAS!** ⚠️\n\nSemua data Produk, User, Order, dan Setting akan HILANG PERMANEN.\n\nJika yakin, ketik:\n`SAYA YAKIN HAPUS SEMUA`", { parse_mode: 'Markdown' });
    });

    // 3. Menu Cloudinary Setting
    bot.action('menu_cloud_set', async (ctx) => {
        const snap = await db.collection('cloudinary_accounts').get();
        let msg = "☁️ **AKUN CLOUDINARY TERDAFTAR:**\n";
        snap.forEach(d => msg += `- ${d.data().name} (${d.data().cloudName})\n`);
        
        ctx.reply(msg, Markup.inlineKeyboard([
            [Markup.button.callback('➕ TAMBAH AKUN BARU', 'add_cloud_acc')],
            [Markup.button.callback('🔙 KEMBALI', 'cancel_action')]
        ]));
    });

    bot.action('add_cloud_acc', (ctx) => {
        adminSession[ctx.from.id] = { type: 'ADD_CLOUD_ACC' };
        ctx.reply("✍️ Masukkan Data Akun (Mode Unsigned):\n\nFormat: `NAMA_AKUN | CLOUD_NAME | UPLOAD_PRESET`\n\n_Contoh: Akun1 | dyximage | my_unsigned_preset_", { parse_mode: 'Markdown' });
    });

    // 4. Menu Upload (Pilih Akun)
    bot.action('menu_cloud_upload', async (ctx) => {
        const snap = await db.collection('cloudinary_accounts').get();
        if (snap.empty) return ctx.reply("❌ Belum ada akun Cloudinary. Tambahkan di menu Setting dulu.");
        
        const buttons = snap.docs.map(doc => [Markup.button.callback(`📤 Pakai: ${doc.data().name}`, `use_cloud_${doc.id}`)]);
        ctx.reply("☁️ **PILIH AKUN UNTUK UPLOAD:**", Markup.inlineKeyboard(buttons));
    });

    // 5. Tangkap Pilihan Akun & Minta File
    bot.action(/^use_cloud_(.+)$/, async (ctx) => {
        const accId = ctx.match[1];
        const docSnap = await db.collection('cloudinary_accounts').doc(accId).get();
        if (!docSnap.exists) return ctx.reply("Akun tidak ditemukan.");
        
        adminSession[ctx.from.id] = { type: 'WAIT_CLOUD_FILE', account: docSnap.data() };
        ctx.reply(`📂 Oke, pakai akun *${docSnap.data().name}*.\n\n👉 **SEKARANG KIRIM GAMBAR/FILE** yang mau diupload!`, { parse_mode: 'Markdown' });
    });
};
