// commands/start.js

// Fungsi ini menangani perintah /start dan /help, serta menampilkan menu utama.
const handleStartCommand = (bot) => {
    bot.onText(/\/start|\/help/, (msg) => {
        const chatId = msg.chat.id;
        const namaDepan = msg.from.first_name;

        const welcomeMessage = `
Halo, *${namaDepan}*! 👋

Selamat datang di *Bot Serbaguna Modern*. Saya adalah bot demonstrasi dengan berbagai fitur canggih.

Silakan pilih salah satu menu di bawah ini untuk berinteraksi dengan saya.
        `;

        // Opsi keyboard interaktif di bawah pesan
        const options = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📰 Berita Terkini', callback_data: 'news_menu' },
                        { text: '🎮 Main Game', callback_data: 'game_menu' },
                    ],
                    [
                        { text: 'ℹ️ Tentang Bot', callback_data: 'about_bot' },
                    ]
                ]
            }
        };

        // Mengirim foto sampul bersamaan dengan pesan selamat datang
        bot.sendPhoto(chatId, 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=500', {
            caption: welcomeMessage,
            parse_mode: 'Markdown',
            reply_markup: options.reply_markup
        });
    });
};

module.exports = handleStartCommand;
