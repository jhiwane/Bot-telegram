// services/newsService.js
const axios = require('axios');

// Mengambil API Key dari file .env
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const NEWS_API_URL = 'https://newsapi.org/v2/top-headlines';

/**
 * Mengambil berita terkini dari NewsAPI.org berdasarkan kategori.
 * @param {string} category - Kategori berita (misal: technology, sports).
 * @returns {Promise<Array|null>} - Sebuah array berisi artikel atau null jika gagal.
 */
async function getTopHeadlines(category) {
    if (!NEWS_API_KEY) {
        console.error("Error: Kunci API Berita (NEWS_API_KEY) tidak ditemukan di file .env");
        return null;
    }

    try {
        const response = await axios.get(NEWS_API_URL, {
            params: {
                country: 'id', // Mengambil berita dari Indonesia
                category: category,
                pageSize: 5, // Mengambil 5 berita teratas
                apiKey: NEWS_API_KEY,
            },
        });

        if (response.data.articles && response.data.articles.length > 0) {
            return response.data.articles;
        } else {
            return [];
        }
    } catch (error) {
        console.error("Gagal mengambil berita dari NewsAPI:", error.message);
        return null;
    }
}

// Ekspor fungsi agar bisa digunakan di file lain
module.exports = {
    getTopHeadlines,
};
