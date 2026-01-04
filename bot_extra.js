// bot_extra.js - FITUR EXTRA (Support Semua File & Custom Thumb HTML)
const { Markup } = require('telegraf');
const axios = require('axios');

module.exports = (bot, db, adminSession) => {
    const ADMIN_ID = process.env.ADMIN_ID;

    // --- HELPER CLOUDINARY (SMART AUTO DETECT) ---
    const uploadToCloudinary = async (fileUrl, account) => {
        try {
            const formData = new URLSearchParams();
            formData.append('file', fileUrl);
            formData.append('upload_preset', account.preset);
            
            // PENTING: Pakai 'auto' agar bisa terima APK, PDF, MP3, ZIP
            const res = await axios.post(`https://api.cloudinary.com/v1_1/${account.cloudName}/auto/upload`, formData);
            return res.data.secure_url;
        } catch (e) {
            throw new Error(e.response?.data?.error?.message || e.message);
        }
    };

    // --- MENU SUPER ADMIN ---
    const extraMenu = Markup.inlineKeyboard([
        [Markup.button.callback('☁️ UPLOAD FILE (ALL TYPE)', 'menu_cloud_upload'), Markup.button.callback('📂 GALERI SAYA', 'list_my_files')],
        [Markup.button.callback('⚙️ SET AKUN CLOUD', 'menu_cloud_set'), Markup.button.callback('🎮 UPLOAD HTML APP', 'ask_html_upload')],
        [Markup.button.callback('☢️ HAPUS DATABASE', 'menu_danger')]
    ]);

    bot.command(['superadmin', 'panel2'], (ctx) => {
        if (String(ctx.from.id) !== ADMIN_ID) return;
        ctx.reply("🚀 **PANEL EXTRA (ALL FILES)**", extraMenu);
    });

    bot.command('upload', (ctx) => {
        if (String(ctx.from.id) !== ADMIN_ID) return;
        ctx.reply("☁️ Pilih akun:", Markup.inlineKeyboard([[Markup.button.callback('☁️ MULAI UPLOAD', 'menu_cloud_upload')]]));
    });

    // --- LOGIKA PESAN ---
    const handleExtraLogic = async (ctx) => {
        if (String(ctx.from.id) !== ADMIN_ID) return false;
        let text = ctx.message.text || ctx.message.caption || '';
        const session = adminSession[ctx.from.id];

        if (!session) return false;

        // 1. NUKE DB
        if (session.type === 'NUKE_CONFIRM') {
            if (text === 'SAYA YAKIN HAPUS SEMUA') {
                ctx.reply("☢️ MEMPROSES NUKE...");
                const cols = ['products', 'orders', 'users', 'vouchers', 'contents', 'settings', 'cloudinary_accounts', 'file_storage'];
                let count = 0;
                const batch = db.batch();
                for (const col of cols) {
                    const snap = await db.collection(col).get();
                    snap.docs.forEach(doc => batch.delete(doc.ref));
                    count += snap.size;
                }
                await batch.commit();
                delete adminSession[ctx.from.id];
                ctx.reply(`💀 **RESET SELESAI.** ${count} data dihapus.`);
                return true;
            }
        }

        // 2. SET AKUN CLOUD
        if (session.type === 'ADD_CLOUD_ACC') {
            const [name, cloudName, preset] = text.split('|').map(s=>s.trim());
            if (!name || !cloudName || !preset) { ctx.reply("❌ Format Salah."); return true; }
            await db.collection('cloudinary_accounts').add({ name, cloudName, preset, createdAt: new Date() });
            delete adminSession[ctx.from.id];
            ctx.reply(`✅ Akun Cloudinary "${name}" Disimpan!`);
            return true;
        }

        // 3. PROSES UPLOAD FILE (MP3/APK/PDF/IMG)
        if ((ctx.message.document || ctx.message.photo || ctx.message.video || ctx.message.audio) && session.type === 'WAIT_CLOUD_FILE') {
            ctx.reply("⏳ Mengupload (Auto Detect)...");
            try {
                let fileId;
                // Deteksi jenis file dari Telegram
                if (ctx.message.document) fileId = ctx.message.document.file_id;
                else if (ctx.message.video) fileId = ctx.message.video.file_id;
                else if (ctx.message.audio) fileId = ctx.message.audio.file_id;
                else if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

                const fileLink = await ctx.telegram.getFileLink(fileId);
                const url = await uploadToCloudinary(fileLink.href, session.account);
                
                // Simpan ke Galeri Riwayat
                await db.collection('file_storage').add({
                    url: url,
                    account: session.account.name,
                    createdAt: new Date()
                });

                delete adminSession[ctx.from.id];
                ctx.reply(`✅ *UPLOAD SUKSES!*\n\n🔗 URL: \`${url}\`\n\n(Bisa untuk Produk/Slider)`, { parse_mode: 'Markdown' });
                return true;
            } catch (e) {
                ctx.reply(`❌ Gagal: ${e.message}`);
                return true;
            }
        }

        // 4. UPLOAD HTML (DENGAN CUSTOM THUMBNAIL)
        if (ctx.message.document && session.type === 'UPLOAD_HTML_FILE') {
            try {
                const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
                const res = await axios.get(link.href, { responseType: 'text' });
                
                if (!ctx.message.document.file_name.endsWith('.html')) { 
                    ctx.reply("❌ Wajib file .html"); return true; 
                }

                await db.collection('contents').add({
                    type: 'html_app', 
                    title: session.title, 
                    htmlContent: res.data,
                    // Gunakan thumbnail user atau default jika kosong
                    thumbnail: session.thumb || 'https://placehold.co/600x400/000/FFF?text=HTML+GAME', 
                    createdAt: new Date()
                });
                delete adminSession[ctx.from.id];
                ctx.reply(`✅ Game HTML "${session.title}" Siap Dimainkan!`);
                return true;
            } catch(e) { ctx.reply("Error: "+e.message); return true; }
        }

        return false;
    };

    bot.use(async (ctx, next) => {
        if (ctx.message) {
            const handled = await handleExtraLogic(ctx);
            if (handled) return;
        }
        return next();
    });

    // --- ACTIONS ---
    
    bot.action('list_my_files', async (ctx) => {
        const snap = await db.collection('file_storage').orderBy('createdAt', 'desc').limit(5).get();
        if (snap.empty) return ctx.reply("📭 Galeri kosong.");
        ctx.reply("📂 **5 FILE TERAKHIR:**");
        for (const doc of snap.docs) {
            const d = doc.data();
            ctx.reply(`🔗 \`${d.url}\`\n📅 ${d.createdAt.toDate().toLocaleDateString()}`, { parse_mode: 'Markdown' });
        }
    });

    bot.action('menu_danger', (ctx) => {
        ctx.reply("⚠️ **HAPUS DATA**", Markup.inlineKeyboard([ [Markup.button.callback('💀 NUKE SEMUA', 'ask_nuke')], [Markup.button.callback('❌ BATAL', 'cancel_action')] ]));
    });
    bot.action('ask_nuke', (ctx) => {
        adminSession[ctx.from.id] = { type: 'NUKE_CONFIRM' };
        ctx.reply("⚠️ Ketik: `SAYA YAKIN HAPUS SEMUA`", {parse_mode:'Markdown'});
    });

    bot.action('menu_cloud_set', async (ctx) => {
        const snap = await db.collection('cloudinary_accounts').get();
        let msg = "☁️ **AKUN:**\n"; snap.forEach(d => msg += `- ${d.data().name}\n`);
        ctx.reply(msg, Markup.inlineKeyboard([ [Markup.button.callback('➕ TAMBAH', 'add_cloud_acc')], [Markup.button.callback('🔙', 'cancel_action')] ]));
    });
    bot.action('add_cloud_acc', (ctx) => {
        adminSession[ctx.from.id] = { type: 'ADD_CLOUD_ACC' };
        ctx.reply("✍️ Format: `NAMA | CLOUD_NAME | PRESET`", {parse_mode:'Markdown'});
    });

    bot.action('menu_cloud_upload', async (ctx) => {
        const snap = await db.collection('cloudinary_accounts').get();
        if (snap.empty) return ctx.reply("❌ Set Akun Dulu!");
        const btns = snap.docs.map(d => [Markup.button.callback(`📤 ${d.data().name}`, `use_cloud_${d.id}`)]);
        ctx.reply("Pilih Akun:", Markup.inlineKeyboard(btns));
    });
    bot.action(/^use_cloud_(.+)$/, async (ctx) => {
        const d = await db.collection('cloudinary_accounts').doc(ctx.match[1]).get();
        adminSession[ctx.from.id] = { type: 'WAIT_CLOUD_FILE', account: d.data() };
        ctx.reply(`📂 Akun: ${d.data().name}\n👉 Kirim File (APK/PDF/MP3/IMG)!`);
    });

    // UPLOAD HTML (DENGAN INPUT THUMBNAIL)
    bot.action('ask_html_upload', (ctx) => {
        ctx.reply("✍️ Format:\n`JUDUL GAME | URL_GAMBAR_THUMBNAIL`\n\n(Jika tanpa gambar, cukup ketik Judul saja)", {parse_mode:'Markdown'});
        adminSession[ctx.from.id] = { type: 'WAIT_HTML_TITLE' };
    });
    bot.on('text', async (ctx, next) => {
        if (adminSession[ctx.from.id]?.type === 'WAIT_HTML_TITLE') {
            const raw = ctx.message.text;
            const [title, thumb] = raw.split('|').map(s=>s.trim());
            
            adminSession[ctx.from.id] = { 
                type: 'UPLOAD_HTML_FILE', 
                title: title,
                thumb: thumb || '' // Simpan URL thumb jika ada
            };
            ctx.reply(`📂 Judul: "${title}"\n🖼 Thumb: ${thumb ? '✅ Ada' : '❌ Default'}\n\n👉 **Sekarang Kirim File .html!**`);
            return;
        }
        return next();
    });
};
