// commands/game.js

// Menyimpan state game sederhana (nomor yang harus ditebak) untuk setiap chat.
const gameSessions = new Map();

// Fungsi ini menangani semua interaksi game tebak angka.
const handleGameCommand = (bot) => {
    bot.on('callback_query', (callbackQuery) => {
        const msg = callbackQuery.message;
        const data = callbackQuery.data;

        if (data === 'game_menu') {
            const randomNumber = Math.floor(Math.random() * 100) + 1;
            gameSessions.set(msg.chat.id, randomNumber);

            const gameText = '🎮 *Game Tebak Angka* 🎮\n\nSaya telah memilih sebuah angka rahasia antara 1 dan 100.\n\nCoba tebak angka tersebut dengan mengirimkan angka ke saya!';
            bot.editMessageText(gameText, { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'Markdown' });
        }
    });

    // Mendengarkan semua pesan angka yang masuk untuk menebak
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const guess = parseInt(msg.text, 10);

        // Cek apakah ada sesi game yang aktif untuk chat ini
        if (gameSessions.has(chatId)) {
            // Cek apakah input adalah angka
            if (isNaN(guess)) {
                // Abaikan jika bukan angka, kecuali itu adalah perintah
                if (!msg.text.startsWith('/')) {
                    bot.sendMessage(chatId, 'Itu bukan angka. Coba kirimkan angka antara 1 dan 100.');
                }
                return;
            }

            const correctNumber = gameSessions.get(chatId);

            if (guess === correctNumber) {
                bot.sendMessage(chatId, `🎉 TEPAT! Angka rahasianya adalah *${correctNumber}*. Anda hebat! 🎉`, { parse_mode: 'Markdown' });
                gameSessions.delete(chatId); // Hapus sesi game setelah berhasil
            } else if (guess < correctNumber) {
                bot.sendMessage(chatId, 'Angka tebakanmu terlalu *rendah*. Coba lagi!', { parse_mode: 'Markdown' });
            } else if (guess > correctNumber) {
                bot.sendMessage(chatId, 'Angka tebakanmu terlalu *tinggi*. Coba lagi!', { parse_mode: 'Markdown' });
            }
        }
    });
};

module.exports = handleGameCommand;
