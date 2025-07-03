// bot.js

// 1. Inisialisasi & Setup
// Memuat variabel dari file .env
require('dotenv').config(); 
const TelegramBot = require('node-telegram-bot-api');

// Mengambil token dari variabel lingkungan
const token = process.env.TELEGRAM_BOT_TOKEN;

// Cek apakah token ada
if (!token) {
    console.error("Error: Token bot Telegram tidak ditemukan! Pastikan Anda sudah membuat file .env dan mengisinya.");
    process.exit(1);
}

// Membuat instance bot
const bot = new TelegramBot(token, { polling: true });

// 2. Impor Modul Perintah
const handleStartCommand = require('./commands/start');
const handleNewsCommand = require('./commands/news');
const handleGameCommand = require('./commands/game');
const handleAdminCommand = require('./commands/admin');

// 3. Penyimpanan Data Sederhana
// Menyimpan ID unik setiap pengguna yang berinteraksi dengan bot
const userIds = new Set();

// 4. Registrasi Handler
handleStartCommand(bot);
handleNewsCommand(bot);
handleGameCommand(bot);
handleAdminCommand(bot, userIds); // Berikan akses ke daftar userIds

// 5. Handler Global
// Menangani semua pesan untuk menyimpan ID pengguna
bot.on('message', (msg) => {
    userIds.add(msg.chat.id);
});

// Menangani callback untuk kembali ke menu utama
bot.on('callback_query', (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;

    if (data === 'main_menu' || data === 'about_bot') {
        const namaDepan = msg.chat.first_name;
        let text;
        if (data === 'main_menu') {
            text = `Selamat datang kembali, *${namaDepan}*! Silakan pilih menu lain.`;
        } else { // about_bot
            text = `
*Tentang Bot Ini*

🤖 Bot ini adalah contoh bot modern yang dibuat untuk demonstrasi.
✨ Ditenagai oleh Node.js dan pustaka ` + "`node-telegram-bot-api`" + `.
📰 Terhubung dengan NewsAPI.org untuk berita real-time.

Anda bisa melihat kode sumber bot ini dan mengembangkannya sendiri!
            `;
        }
        
        const options = {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📰 Berita Terkini', callback_data: 'news_menu' }, { text: '🎮 Main Game', callback_data: 'game_menu' }],
                    [{ text: 'ℹ️ Tentang Bot', callback_data: 'about_bot' }]
                ]
            }
        };
        bot.editMessageText(text, options);
    }
});


console.log('✅ Bot Telegram Modern berhasil dijalankan!');
