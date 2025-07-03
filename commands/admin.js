// commands/admin.js

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Fungsi ini menangani perintah khusus untuk admin bot.
const handleAdminCommand = (bot, userIds) => {
    // Perintah /broadcast [pesan]
    bot.onText(/\/broadcast (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const pesan = match[1];

        // Cek apakah pengirim adalah admin
        if (String(chatId) !== ADMIN_CHAT_ID) {
            bot.sendMessage(chatId, 'Maaf, Anda tidak memiliki izin untuk menggunakan perintah ini.');
            return;
        }

        bot.sendMessage(chatId, `Mengirim pesan siaran ke *${userIds.size}* pengguna...`, { parse_mode: 'Markdown' });
        
        // Kirim pesan ke semua pengguna yang pernah berinteraksi dengan bot
        userIds.forEach(id => {
            // Kita tidak perlu mengirim ke diri sendiri (admin)
            if (String(id) !== ADMIN_CHAT_ID) {
                bot.sendMessage(id, pesan);
            }
        });
    });
};

module.exports = handleAdminCommand;
