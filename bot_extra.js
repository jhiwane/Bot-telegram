const { Markup } = require('telegraf');
const axios = require('axios');

module.exports = (bot, db, adminSession) => {
    const ADMIN_ID = process.env.ADMIN_ID;

    // Middleware Security
    const isOwner = (ctx) => {
        return ctx.from && String(ctx.from.id) === ADMIN_ID;
    };

    // --- HELPER CLOUDINARY ---
    const uploadToCloudinary = async (fileUrl, account) => {
        try {
            const formData = new URLSearchParams();
            formData.append('file', fileUrl);
            formData.append('upload_preset', account.preset);
            const res = await axios.post(`https://api.cloudinary.com/v1_1/${account.cloudName}/auto/upload`, formData);
            return res.data; 
        } catch (e) {
            throw new Error(e.response?.data?.error?.message || e.message);
        }
    };

    // --- MENU SUPER ADMIN ---
    const extraMenu = Markup.inlineKeyboard([
        [Markup.button.callback('☁️ UPLOAD FILE', 'menu_cloud_upload'), Markup.button.callback('📂 GALERI (10 DATA)', 'list_my_files')],
        [Markup.button.callback('⚙️ SET AKUN CLOUD', 'menu_cloud_set'), Markup.button.callback('🎮 UPLOAD HTML', 'ask_html_upload')],
        [Markup.button.callback('☢️ HAPUS DATABASE', 'menu_danger')]
    ]);

    bot.command(['superadmin', 'panel2'], (ctx) => {
        if (!isOwner(ctx)) return;
        ctx.reply("🚀 **PANEL EXTRA**\n_Tips: Ketik langsung nama file untuk mencari gambar._", extraMenu);
    });

    bot.command('upload', (ctx) => {
        if (!isOwner(ctx)) return;
        ctx.reply("☁️ Pilih akun:", Markup.inlineKeyboard([[Markup.button.callback('☁️ MULAI UPLOAD', 'menu_cloud_upload')]]));
    });

    // --- FUNGSI PENCARIAN FILE ---
    // Return true jika ketemu, false jika zonk
    const searchFile = async (ctx, keyword, silentIfNotFound = false) => {
        // Cari yang namanya MIRIP atau SAMA (Case Insensitive logic sederhana)
        const snap = await db.collection('file_storage')
            .where('name_lower', '>=', keyword.toLowerCase())
            .where('name_lower', '<=', keyword.toLowerCase() + '\uf8ff')
            .limit(5)
            .get();

        if (snap.empty) {
            if (!silentIfNotFound) ctx.reply("❌ File tidak ditemukan di Galeri.");
            return false; // Tidak ketemu, lempar ke index.js
        }

        if(!silentIfNotFound) ctx.reply(`🔍 Hasil Galeri "${keyword}":`);

        for (const doc of snap.docs) {
            const d = doc.data();
            const caption = `🏷️ **${d.name}**\n🔗 \`${d.url}\``;
            const keyb = Markup.inlineKeyboard([[Markup.button.callback('🗑️ HAPUS FILE', `del_file_${doc.id}`)]]);
            
            try {
                if (d.type === 'image') await ctx.replyWithPhoto(d.url, { caption, parse_mode:'Markdown', ...keyb });
                else if (d.type === 'video') await ctx.replyWithVideo(d.url, { caption, parse_mode:'Markdown', ...keyb });
                else await ctx.reply(`📦 **FILE:**\n${caption}`, { parse_mode:'Markdown', ...keyb });
            } catch (e) {
                await ctx.reply(`📄 ${caption} (Preview Error)`, { parse_mode:'Markdown', ...keyb });
            }
        }
        return true; // Ketemu! Stop di sini.
    };

    // --- LOGIKA UTAMA (TEXT & FILE) ---
    const handleExtraLogic = async (ctx) => {
        if (!isOwner(ctx)) return false;
        
        let text = ctx.message.text || ctx.message.caption || '';
        const session = adminSession[ctx.from.id];

        // 1. INPUT NAMA FILE (SEBELUM UPLOAD)
        if (session && session.type === 'WAIT_FILENAME_UPLOAD') {
            const fileName = text.trim();
            adminSession[ctx.from.id] = { 
                type: 'WAIT_CLOUD_FILE', 
                account: session.account,
                fileName: fileName 
            };
            ctx.reply(`🏷️ Nama: **"${fileName}"**\n\n👉 Sekarang KIRIM FOTO/VIDEO/FILE-nya!`, {parse_mode:'Markdown'});
            return true;
        }

        // 2. PROSES UPLOAD FILE
        if ((ctx.message.document || ctx.message.photo || ctx.message.video || ctx.message.audio) && session && session.type === 'WAIT_CLOUD_FILE') {
            ctx.reply("⏳ Mengupload...");
            try {
                let fileId;
                if (ctx.message.document) fileId = ctx.message.document.file_id;
                else if (ctx.message.video) fileId = ctx.message.video.file_id;
                else if (ctx.message.audio) fileId = ctx.message.audio.file_id;
                else if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

                const fileLink = await ctx.telegram.getFileLink(fileId);
                const result = await uploadToCloudinary(fileLink.href, session.account);
                
                await db.collection('file_storage').add({
                    name: session.fileName,
                    name_lower: session.fileName.toLowerCase(),
                    url: result.secure_url,
                    type: result.resource_type,
                    account: session.account.name,
                    createdAt: new Date()
                });

                delete adminSession[ctx.from.id];
                ctx.reply(`✅ *SUKSES DISIMPAN!*\n\n🏷️ ${session.fileName}\n🔗 \`${result.secure_url}\``, { parse_mode: 'Markdown' });
                return true;
            } catch (e) {
                ctx.reply(`❌ Gagal: ${e.message}`);
                return true;
            }
        }

        // 3. SETTINGS LAIN (HTML, NUKE, AKUN)
        if (session && session.type === 'ADD_CLOUD_ACC') {
            const [name, cloudName, preset] = text.split('|').map(s=>s.trim());
            if (!name) { ctx.reply("❌ Format Salah."); return true; }
            await db.collection('cloudinary_accounts').add({ name, cloudName, preset, createdAt: new Date() });
            delete adminSession[ctx.from.id];
            ctx.reply(`✅ Akun "${name}" Disimpan!`);
            return true;
        }

        if (session && session.type === 'NUKE_CONFIRM' && text === 'SAYA YAKIN HAPUS SEMUA') {
            ctx.reply("☢️ NUKE STARTED...");
            const cols = ['products', 'orders', 'users', 'vouchers', 'contents', 'settings', 'cloudinary_accounts', 'file_storage'];
            const batch = db.batch();
            for (const col of cols) {
                const snap = await db.collection(col).get();
                snap.docs.forEach(doc => batch.delete(doc.ref));
            }
            await batch.commit();
            delete adminSession[ctx.from.id];
            ctx.reply(`💀 **DATABASE BERSIH.**`);
            return true;
        }

        if (ctx.message.document && session && session.type === 'UPLOAD_HTML_FILE') {
            try {
                const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
                const res = await axios.get(link.href, { responseType: 'text' });
                if (!ctx.message.document.file_name.endsWith('.html')) { ctx.reply("❌ Wajib .html"); return true; }
                await db.collection('contents').add({
                    type: 'html_app', title: session.title, htmlContent: res.data,
                    thumbnail: session.thumb || 'https://placehold.co/600x400/000/FFF?text=HTML+GAME', createdAt: new Date()
                });
                delete adminSession[ctx.from.id];
                ctx.reply(`✅ Game HTML "${session.title}" Siap!`);
                return true;
            } catch(e) { ctx.reply("Error: "+e.message); return true; }
        }

        if (session && adminSession[ctx.from.id]?.type === 'WAIT_HTML_TITLE') {
            const [title, thumb] = text.split('|').map(s=>s.trim());
            adminSession[ctx.from.id] = { type: 'UPLOAD_HTML_FILE', title, thumb: thumb||'' };
            ctx.reply(`📂 Judul: "${title}". Kirim File .html!`);
            return true;
        }

        // ============================================================
        // 🔥 FITUR UTAMA: DIRECT SEARCH (JIKA TIDAK ADA SESSION)
        // ============================================================
        if (!session && text && !text.startsWith('/')) {
            // Coba cari di Galeri File dulu
            // Parameter 'true' artinya SILENT jika tidak ketemu (jangan balas "Gak ada")
            // Biarkan index.js yang menangani kalau di sini gak ketemu
            const foundInGallery = await searchFile(ctx, text, true);
            
            if (foundInGallery) {
                return true; // Stop! Jangan lanjut ke index.js karena sudah ketemu gambar
            }
            
            // Jika tidak ketemu di galeri, return false.
            // Biarkan index.js mencari di Produk/Order/User
            return false; 
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
    bot.action('ask_search_file', (ctx) => {
        ctx.reply("🔍 Ketik langsung nama file di chat.");
    });

    bot.action('list_my_files', async (ctx) => {
        const snap = await db.collection('file_storage').orderBy('createdAt', 'desc').limit(10).get();
        if(snap.empty) return ctx.reply("Kosong.");
        ctx.reply("📂 **10 UPLOAD TERAKHIR:**");
        snap.forEach(doc => {
             const d = doc.data();
             const caption = `🏷️ ${d.name}\n🔗 \`${d.url}\``;
             const kb = Markup.inlineKeyboard([[Markup.button.callback('🗑️ HAPUS', `del_file_${doc.id}`)]]);
             // Kirim preview text saja untuk list cepat (biar ga spam gambar)
             ctx.reply(caption, {parse_mode:'Markdown', ...kb});
        });
    });

    bot.action(/^del_file_(.+)$/, async (ctx) => {
        await db.collection('file_storage').doc(ctx.match[1]).delete();
        ctx.deleteMessage();
        ctx.answerCbQuery("Terhapus.");
    });

    // Cloudinary Flow
    bot.action('menu_cloud_upload', async (ctx) => {
        const snap = await db.collection('cloudinary_accounts').get();
        if(snap.empty) return ctx.reply("Set Akun Dulu!");
        const btns = snap.docs.map(d => [Markup.button.callback(`📤 ${d.data().name}`, `use_cloud_${d.id}`)]);
        ctx.reply("Pilih Akun:", Markup.inlineKeyboard(btns));
    });

    // [MODIFIKASI] Pilih Akun -> Minta NAMA FILE dulu
    bot.action(/^use_cloud_(.+)$/, async (ctx) => {
        const d = await db.collection('cloudinary_accounts').doc(ctx.match[1]).get();
        adminSession[ctx.from.id] = { type: 'WAIT_FILENAME_UPLOAD', account: d.data() };
        ctx.reply(`📂 Pakai akun: ${d.data().name}\n\n👉 **Ketik NAMA FILE / KODE** untuk gambar ini (Biar gampang dicari nanti):`);
    });

    // Menu lain
    bot.action('menu_cloud_set', async (ctx) => {
        const snap = await db.collection('cloudinary_accounts').get();
        let msg="Akun:\n"; snap.forEach(d=>msg+=`- ${d.data().name}\n`);
        ctx.reply(msg, Markup.inlineKeyboard([[Markup.button.callback('➕ TAMBAH', 'add_cloud_acc')]]));
    });
    bot.action('add_cloud_acc', (ctx)=>{ adminSession[ctx.from.id]={type:'ADD_CLOUD_ACC'}; ctx.reply("Format: NAMA|CLOUD|PRESET"); });
    
    bot.action('menu_danger', (ctx)=>ctx.reply("Hapus Data?", Markup.inlineKeyboard([[Markup.button.callback('YA NUKE', 'ask_nuke')]])));
    bot.action('ask_nuke', (ctx)=>{ adminSession[ctx.from.id]={type:'NUKE_CONFIRM'}; ctx.reply("Ketik: SAYA YAKIN HAPUS SEMUA"); });
    
    bot.action('ask_html_upload', (ctx)=>{ adminSession[ctx.from.id]={type:'WAIT_HTML_TITLE'}; ctx.reply("Format: JUDUL | URL_THUMB (Opsional)"); });
};
