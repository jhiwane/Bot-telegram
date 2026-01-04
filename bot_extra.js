// bot_extra.js - FITUR TAMBAHAN (Cloudinary, Nuke, HTML Tool)
const { Markup } = require('telegraf');
const axios = require('axios');

module.exports = (bot, db, adminSession) => {
    const ADMIN_ID = process.env.ADMIN_ID;

    // --- FUNGSI UPLOAD CLOUDINARY ---
    const uploadToCloudinary = async (fileUrl, account) => {
        try {
            const formData = new URLSearchParams();
            formData.append('file', fileUrl);
            formData.append('upload_preset', account.preset); // Preset Unsigned
            const cloudName = account.cloudName;
            const res = await axios.post(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, formData);
            return res.data.secure_url;
        } catch (e) {
            throw new Error(e.response?.data?.error?.message || e.message);
        }
    };

    // --- MENU PANEL KEDUA (SUPER ADMIN) ---
    const extraMenu = Markup.inlineKeyboard([
        [Markup.button.callback('☁️ UPLOAD CLOUD', 'menu_cloud_upload'), Markup.button.callback('⚙️ SET AKUN CLOUD', 'menu_cloud_set')],
        [Markup.button.callback('🎮 UPLOAD HTML GAME', 'ask_html_upload')],
        [Markup.button.callback('☢️ HAPUS DATABASE (NUKE)', 'menu_danger')]
    ]);

    // Command Baru: /superadmin atau /panel2
    bot.command(['superadmin', 'panel2'], (ctx) => {
        if (String(ctx.from.id) !== ADMIN_ID) return;
        ctx.reply("🚀 **PANEL FITUR TAMBAHAN**\n\nFitur khusus Cloudinary & Database Maintenance.", extraMenu);
    });

    // Command Cepat Upload: /upload
    bot.command('upload', (ctx) => {
        if (String(ctx.from.id) !== ADMIN_ID) return;
        ctx.reply("☁️ Pilih akun Cloudinary:", Markup.inlineKeyboard([[Markup.button.callback('☁️ MULAI UPLOAD', 'menu_cloud_upload')]]));
    });

    // --- LOGIKA TEXT & FILE (HANDLING SESSION) ---
    // Kita "numpang" di listener bot.on index.js lewat adminSession yang dishare
    const handleExtraLogic = async (ctx) => {
        if (String(ctx.from.id) !== ADMIN_ID) return false;
        let text = ctx.message.text || ctx.message.caption || '';
        const session = adminSession[ctx.from.id];

        if (!session) return false;

        // 1. LOGIKA NUKE (HAPUS SEMUA)
        if (session.type === 'NUKE_CONFIRM') {
            if (text === 'SAYA YAKIN HAPUS SEMUA') {
                ctx.reply("☢️ MEMULAI PENGHAPUSAN MASSAL... (JANGAN DIMATIKAN)");
                const collections = ['products', 'orders', 'users', 'vouchers', 'contents', 'settings', 'cloudinary_accounts'];
                let count = 0;
                for (const col of collections) {
                    const snap = await db.collection(col).get();
                    const batch = db.batch();
                    snap.docs.forEach(doc => batch.delete(doc.ref));
                    await batch.commit();
                    count += snap.size;
                }
                delete adminSession[ctx.from.id];
                ctx.reply(`💀 **DATABASE RESET SELESAI.**\nTotal ${count} data dihapus selamanya.`);
                return true; // Stop processing in index.js
            }
        }

        // 2. LOGIKA TAMBAH AKUN CLOUD
        if (session.type === 'ADD_CLOUD_ACC') {
            const [name, cloudName, preset] = text.split('|').map(s=>s.trim());
            if (!name || !cloudName || !preset) {
                ctx.reply("❌ Format Salah. Ketik: NAMA_AKUN | CLOUD_NAME | PRESET_NAME");
                return true;
            }
            await db.collection('cloudinary_accounts').add({ name, cloudName, preset, createdAt: new Date() });
            delete adminSession[ctx.from.id];
            ctx.reply(`✅ Akun Cloudinary "${name}" Disimpan!`);
            return true;
        }

        // 3. LOGIKA TERIMA FILE UPLOAD CLOUD
        if ((ctx.message.document || ctx.message.photo) && session.type === 'WAIT_CLOUD_FILE') {
            ctx.reply("⏳ Sedang mengupload ke Cloudinary...");
            try {
                const fileId = ctx.message.document ? ctx.message.document.file_id : ctx.message.photo[ctx.message.photo.length - 1].file_id;
                const fileLink = await ctx.telegram.getFileLink(fileId);
                const url = await uploadToCloudinary(fileLink.href, session.account);
                
                delete adminSession[ctx.from.id];
                ctx.reply(`✅ *UPLOAD SUKSES!*\n\n🔗 URL: \`${url}\`\n\n(Copy link ini untuk produk)`, { parse_mode: 'Markdown' });
                return true;
            } catch (e) {
                ctx.reply(`❌ Gagal Upload: ${e.message}`);
                return true;
            }
        }

        // 4. LOGIKA UPLOAD HTML FILE
        if (ctx.message.document && session.type === 'UPLOAD_HTML_FILE') {
            try {
                const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
                const res = await axios.get(link.href, { responseType: 'text' });
                if (!ctx.message.document.file_name.endsWith('.html')) {
                    ctx.reply("❌ Harus file .html"); return true;
                }
                await db.collection('contents').add({
                    type: 'html_app',
                    title: session.title,
                    htmlContent: res.data,
                    thumbnail: 'https://placehold.co/600x400/000/FFF?text=HTML+GAME',
                    createdAt: new Date()
                });
                delete adminSession[ctx.from.id];
                ctx.reply(`✅ Game HTML "${session.title}" Siap Dimainkan!`);
                return true;
            } catch(e) { ctx.reply("Error: "+e.message); return true; }
        }

        return false; // Jika bukan logic di atas, kembalikan ke index.js
    };

    // Kita inject logic ini ke bot middleware agar dibaca sebelum index.js
    bot.use(async (ctx, next) => {
        if (ctx.message && (ctx.message.text || ctx.message.photo || ctx.message.document)) {
            const handled = await handleExtraLogic(ctx);
            if (handled) return; // Jika sudah dihandle bot_extra, stop.
        }
        return next();
    });

    // --- ACTION BUTTONS (TOMBOL KLIK) ---
    
    // 1. Danger Zone
    bot.action('menu_danger', (ctx) => {
        ctx.reply("⚠️ **DANGER ZONE** ⚠️\n\nHati-hati! Tombol ini menghapus database.", Markup.inlineKeyboard([
            [Markup.button.callback('💀 HAPUS SEMUA (NUKE)', 'ask_nuke')],
            [Markup.button.callback('❌ BATAL', 'cancel_action')]
        ]));
    });
    bot.action('ask_nuke', (ctx) => {
        adminSession[ctx.from.id] = { type: 'NUKE_CONFIRM' };
        ctx.reply("⚠️ **PERINGATAN TERAKHIR!**\nKetik kalimat ini untuk konfirmasi:\n`SAYA YAKIN HAPUS SEMUA`", {parse_mode:'Markdown'});
    });

    // 2. Cloudinary Settings
    bot.action('menu_cloud_set', async (ctx) => {
        const snap = await db.collection('cloudinary_accounts').get();
        let msg = "☁️ **AKUN TERDAFTAR:**\n";
        snap.forEach(d => msg += `- ${d.data().name}\n`);
        ctx.reply(msg || "Belum ada akun.", Markup.inlineKeyboard([
            [Markup.button.callback('➕ TAMBAH AKUN', 'add_cloud_acc')],
            [Markup.button.callback('❌ BATAL', 'cancel_action')]
        ]));
    });
    bot.action('add_cloud_acc', (ctx) => {
        adminSession[ctx.from.id] = { type: 'ADD_CLOUD_ACC' };
        ctx.reply("✍️ Ketik Data Akun:\nFormat: `NAMA | CLOUD_NAME | PRESET_NAME`", {parse_mode:'Markdown'});
    });

    // 3. Upload Flow
    bot.action('menu_cloud_upload', async (ctx) => {
        const snap = await db.collection('cloudinary_accounts').get();
        if (snap.empty) return ctx.reply("❌ Belum ada akun. Set dulu di menu Setting.");
        const btns = snap.docs.map(d => [Markup.button.callback(`📤 Pakai: ${d.data().name}`, `use_cloud_${d.id}`)]);
        ctx.reply("Pilih Akun:", Markup.inlineKeyboard(btns));
    });
    bot.action(/^use_cloud_(.+)$/, async (ctx) => {
        const d = await db.collection('cloudinary_accounts').doc(ctx.match[1]).get();
        adminSession[ctx.from.id] = { type: 'WAIT_CLOUD_FILE', account: d.data() };
        ctx.reply(`📂 Pakai akun ${d.data().name}.\n👉 **Kirim Foto/File sekarang!**`);
    });

    // 4. HTML Upload
    bot.action('ask_html_upload', (ctx) => {
        ctx.reply("Ketik JUDUL GAME/APPS dulu:");
        // Kita pakai listener text di index.js untuk menangkap judul, 
        // tapi biar rapi, kita set session type khusus di sini.
        // Trik: Kita pakai session 'WAIT_HTML_TITLE' yang nanti ditangkap listener bot.js ini
        adminSession[ctx.from.id] = { type: 'WAIT_HTML_TITLE' };
    });
    
    // Listener tambahan khusus text Judul HTML
    bot.on('text', async (ctx, next) => {
        if (adminSession[ctx.from.id]?.type === 'WAIT_HTML_TITLE') {
            const title = ctx.message.text;
            adminSession[ctx.from.id] = { type: 'UPLOAD_HTML_FILE', title };
            ctx.reply(`📂 Oke judul: "${title}".\nSekarang **Kirim File .html** nya!`);
            return; // Stop here
        }
        return next();
    });
};
