// commands/news.js

const { getTopHeadlines } = require('../services/newsService');

// Fungsi ini menangani semua interaksi terkait fitur berita.
const handleNewsCommand = (bot) => {
    // Menangani callback saat tombol "Berita Terkini" ditekan
    bot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const data = callbackQuery.data;

        if (data === 'news_menu') {
            const newsMenuText = 'Silakan pilih kategori berita yang Anda inginkan:';
            const options = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Teknologi', callback_data: 'get_news_technology' }, { text: 'Olahraga', callback_data: 'get_news_sports' }],
                        [{ text: 'Bisnis', callback_data: 'get_news_business' }, { text: 'Kesehatan', callback_data: 'get_news_health' }],
                        [{ text: '<< Kembali ke Menu', callback_data: 'main_menu' }]
                    ]
                }
            };
            bot.editMessageText(newsMenuText, { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: options.reply_markup });
        }

        if (data.startsWith('get_news_')) {
            const category = data.split('_')[2];
            bot.sendMessage(msg.chat.id, `Mencari 5 berita teratas kategori *${category}*...`, { parse_mode: 'Markdown' });

            const articles = await getTopHeadlines(category);

            if (articles && articles.length > 0) {
                let replyText = `Berikut adalah 5 berita teratas dari kategori *${category}*:\n\n`;
                articles.forEach((article, index) => {
                    replyText += `${index + 1}. <a href="${article.url}">${article.title}</a>\n`;
                });
                bot.sendMessage(msg.chat.id, replyText, { parse_mode: 'HTML', disable_web_page_preview: true });
            } else {
                bot.sendMessage(msg.chat.id, `Maaf, saya tidak bisa menemukan berita untuk kategori *${category}* saat ini.`, { parse_mode: 'Markdown' });
            }
        }
    });
};

module.exports = handleNewsCommand;
