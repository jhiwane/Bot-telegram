const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const cors = require('cors'); 
const axios = require('axios');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require("@google/generative-ai"); // Import Gemini
require('dotenv').config();

// ==========================================
// KONFIGURASI KUNCI API (DARI ENV RAILWAY)
// ==========================================
const KEYS = {
    VIP: { id: process.env.VIP_ID, key: process.env.VIP_KEY },
    DIGI: { user: process.env.DIGI_USER, key: process.env.DIGI_KEY },
    // Tambahkan provider lain di sini jika ada
};

const ADMIN_ID = process.env.ADMIN_ID;
const VIP_ID = process.env.VIP_ID; 
const VIP_KEY = process.env.VIP_KEY;

// Init Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// FUNGSI PINTAR: DETEKSI CREDENTIALS DARI URL
// ==========================================
const getCredentialsByUrl = (url) => {
    const u = url.toLowerCase();
    if (u.includes('vip-reseller')) {
        return { id: KEYS.VIP.id, key: KEYS.VIP.key, type: 'VIP' };
    }
    if (u.includes('api-digi') || u.includes('digiflazz')) {
        return { id: KEYS.DIGI.user, key: KEYS.DIGI.key, type: 'DIGI' };
    }
    return null; 
};

// ==========================================
// FUNGSI TEMBAK API (GENERIC & SMART)
// ==========================================
const beliGeneric = async (apiUrl, serviceCode, target) => {
    try {
        const creds = getCredentialsByUrl(apiUrl);
        
        // SKENARIO 1: API RESMI (VIP / DIGI)
        if (creds) {
            let payload = {};
            
            // LOGIKA VIP
            if (creds.type === 'VIP') {
                const sign = crypto.createHash('md5').update(creds.id + creds.key).digest("hex");
                payload = { 
                    key: creds.key, 
                    sign: sign, 
                    type: 'order', 
                    service: serviceCode, 
                    data_no: target 
                };
            } 
            // LOGIKA DIGI
            else if (creds.type === 'DIGI') {
                const sign = crypto.createHash('md5').update(creds.id + creds.key + "depo").digest("hex"); 
                payload = { 
                    username: creds.id, 
                    buyer_sku_code: serviceCode, 
                    customer_no: target, 
                    sign: sign 
                };
            }
            // UMUM
            else {
                const sign = crypto.createHash('md5').update(creds.id + creds.key).digest("hex");
                payload = { key: creds.key, sign: sign, service: serviceCode, target: target };
            }

            const response = await axios.post(apiUrl, payload);
            const res = response.data;

            // Normalisasi Response
            if (res.result === true || (res.data && (res.data.status === 'Pending' || res.data.status === 'Success'))) {
                return { sukses: true, sn: res.data?.trx_id || res.data?.sn || "Diproses", msg: res.message || "Sukses" };
            } 
            else if (res.data && res.data.rc === '00') {
                 return { sukses: true, sn: res.data.sn, msg: "Sukses" };
            }
            
            return { sukses: false, msg: res.message || res.data?.message || "Gagal dari Pusat" };
        } 
        
        // SKENARIO 2: URL BEBAS / GRATISAN / SUNTIK (GET REQUEST)
        else {
            const separator = apiUrl.includes('?') ? '&' : '?';
            const fullUrl = `${apiUrl}${separator}service=${serviceCode}&target=${target}`;
            const response = await axios.get(fullUrl);
            const res = response.data;

            if (res) {
                if (typeof res === 'object') {
                    if (res.status === true || res.success === true || res.code === 200) {
                        return { sukses: true, sn: res.data || res.content || "Berhasil", msg: "Sukses" };
                    }
                } else if (typeof res === 'string') {
                    // Logic Google Sheet
                    if (res.includes('STOK_HABIS')) return { sukses: false, msg: "Stok Habis di Database Sheet" };
                    if (res.includes('ERROR')) return { sukses: false, msg: "Error Script Google" };
                    
                    if (res.length > 2) return { sukses: true, sn: res, msg: "Sukses" };
                }
            }
            return { sukses: false, msg: "Gagal ambil data URL Bebas" };
        }

    } catch (error) {
        console.error("API Error:", error.message);
        return { sukses: false, msg: `Error Jaringan: ${error.message}` };
    }
};

const cekSaldoVip = async () => {
    if (!VIP_ID || !VIP_KEY) return 0;
    try {
        const sign = crypto.createHash('md5').update(VIP_ID + VIP_KEY).digest("hex");
        const response = await axios.post('https://vip-reseller.co.id/api/profile', { key: VIP_KEY, sign: sign });
        return parseInt(response.data.data.balance) || 0;
    } catch (e) { return 0; }
};

// ==========================================
// 1. SETUP SERVER & CONFIG
// ==========================================
const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;
const adminSession = {}; 

// --- FIREBASE SETUP ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) { console.error("❌ Firebase Error:", error.message); }
const db = admin.firestore();

// --- TELEGRAM BOT SETUP ---
const bot = new Telegraf(process.env.BOT_TOKEN);
// ==========================================
// 🛡️ SECURITY MIDDLEWARE (SATPAM GALAK)
// ==========================================
bot.use(async (ctx, next) => {
    // Cek apakah ada pengirim pesan
    if (ctx.from) {
        // Jika ID pengirim TIDAK SAMA dengan ADMIN_ID
        if (String(ctx.from.id) !== process.env.ADMIN_ID) {
            return; 
        }
    }
    // Jika aman (Admin), lanjut ke fungsi berikutnya
    return next();
});
const cancelBtn = Markup.inlineKeyboard([Markup.button.callback('❌ BATAL', 'cancel_action')]);

// ==========================================
// FUNGSI BANTUAN
// ==========================================
const notifyUser = async (targetId, message) => {
    if (!targetId || isNaN(targetId)) return; 
    try {
        await bot.telegram.sendMessage(targetId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.log(`⚠️ Gagal kirim notif ke user ${targetId}`);
    }
};

// [BAGIAN 1: FUNGSI OTAK AI DENGAN MEMORI]
const askGeminiChat = async (newMessage, historyDB = []) => {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        
        // 1. Konversi data database ke format yang dimengerti Gemini
        let historyGemini = historyDB.map(h => ({
            role: h.role,
            parts: [{ text: h.parts }]
        }));

        // 2. Mulai sesi chat dengan membawa riwayat sebelumnya
        const chat = model.startChat({
            history: historyGemini,
            generationConfig: { 
                maxOutputTokens: 500, // Jawaban bisa lebih panjang dikit biar jelas
                temperature: 0.7 // Kreativitas sedang (biar ga kaku/static)
            },
        });

        // 3. Instruksi Sistem (Persona CS)
        const systemInstruction = `
        Bertindaklah sebagai 'Admin Jie Store' (Manusia, bukan Robot).
        Tugasmu: Melayani komplain pelanggan dengan santai, akrab, tapi tetap sopan.
        
        Panduan Jawaban:
        - Jangan kaku seperti robot. Gunakan bahasa Indonesia yang luwes.
        - Jika user marah, tenangkan. Jika user bertanya, jelaskan.
        - Jangan berjanji palsu (misal: "dana sudah balik"), tapi bilang "sedang dicek admin pusat".
        - Jawablah secara langsung menanggapi kalimat user di bawah ini.
        
        User berkata: "${newMessage}"
        `;

        const result = await chat.sendMessage(systemInstruction);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.log("Gemini Error:", error.message);
        // Fallback jika AI error/limit habis
        return "Halo kak, pesan kakak sudah masuk. Mohon tunggu sebentar ya, admin sedang mengecek antrian 🙏";
    }
};

// ==========================================
// 2. SECURITY CHECK
// ==========================================
const validateOrderSecurity = async (orderId, orderData) => {
    let calculatedTotal = 0;
    
    for (const item of orderData.items) {
        const prodRef = db.collection('products').doc(item.id);
        const prodSnap = await prodRef.get();
        
        if (!prodSnap.exists) continue; 
        
        const p = prodSnap.data();
        let realPrice = p.price; 

        if (item.variantName && item.variantName !== 'Regular' && p.variations) {
            const variant = p.variations.find(v => v.name === item.variantName);
            if (variant) realPrice = parseInt(variant.price);
        }

        calculatedTotal += (realPrice * item.qty);
    }

    if (orderData.voucherCode) {
        const vRef = db.collection('vouchers').doc(orderData.voucherCode);
        const vSnap = await vRef.get();
        if (vSnap.exists && vSnap.data().active) {
            calculatedTotal -= vSnap.data().amount;
        }
    }

    calculatedTotal = Math.max(0, calculatedTotal);

    if (orderData.total < (calculatedTotal - 500)) {
        return { isSafe: false, realTotal: calculatedTotal };
    }
    
    return { isSafe: true };
};

// [UPDATE]: processStock mendukung forceHunterMode & Deteksi Auto Hunter
const processStock = async (productId, variantName, qtyNeeded, forceHunterMode = false) => {
    const docRef = db.collection('products').doc(productId);
    return await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        if (!doc.exists) return null;
        const data = doc.data();
        let contentPool = "", isVariant = false, variantIndex = -1, isPermanent = false;

        if (variantName && data.variations) {
            variantIndex = data.variations.findIndex(v => v.name === variantName);
            if (variantIndex !== -1) {
                contentPool = data.variations[variantIndex].content || "";
                isPermanent = data.variations[variantIndex].isPermanent === true;
                isVariant = true;
            }
        } else {
            contentPool = data.content || "";
            isPermanent = data.isPermanent === true;
        }

        if (contentPool.startsWith('MULTI_API:')) {
            isPermanent = true;
        }

        // Cek Backup Config (Hunter) di baris mana saja
        let lines = contentPool.split('\n').filter(s => s.trim().length > 0);
        let backupConfig = lines.find(l => l.startsWith('AUTO_BACKUP:'));

        // [LOGIKA FORCE]: Jika mode paksa, return stok 0 biar masuk ke hunter
        if (forceHunterMode) {
             return { 
                success: false, 
                currentStock: 0, 
                backupConfig: backupConfig ? backupConfig.replace('AUTO_BACKUP:', '').trim() : null 
            };
        }

        // FIX: Pastikan sold dihitung sebagai integer
        const currentSold = parseInt(data.sold) || 0;
        const inc = parseInt(qtyNeeded);

        // [UPDATE]: Cek apakah konten murni permanen (tanpa hunter)
        if (isPermanent && !contentPool.includes('AUTO_BACKUP:')) {
            t.update(docRef, { sold: currentSold + inc });
            return { success: true, data: contentPool, currentStock: 999999 }; 
        } else {
            // Pisahkan stok asli dan config backup
            let stocks = lines.filter(l => !l.startsWith('AUTO_BACKUP:'));

            if (stocks.length >= qtyNeeded) {
                const taken = stocks.slice(0, qtyNeeded); 
                const remaining = stocks.slice(qtyNeeded);
                if(backupConfig) remaining.push(backupConfig); // Kembalikan config ke DB

                const finalContent = remaining.join('\n');
                
                if (isVariant) {
                    data.variations[variantIndex].content = finalContent;
                    t.update(docRef, { variations: data.variations, sold: currentSold + inc });
                } else {
                    t.update(docRef, { content: finalContent, sold: currentSold + inc });
                }
                return { success: true, data: taken.join('\n'), currentStock: stocks.length };
            } else {
                return { 
                    success: false, 
                    currentStock: stocks.length,
                    backupConfig: backupConfig ? backupConfig.replace('AUTO_BACKUP:', '').trim() : null
                };
            }
        }
    });
};

// [UPDATE]: processOrderLogic mendukung Force Hunter & Fix Bug Qty
const processOrderLogic = async (orderId, orderData, forceHunter = false) => {
    let items = [], allComplete = true, msgLog = "", revBtns = [];

    for (let i = 0; i < orderData.items.length; i++) {
        const item = orderData.items[i];

        // --- [PERBAIKAN LOGIKA PERMANEN] ---
        let isItemPermanent = false;
        let sourceContent = "";
        try {
            const prodRef = await db.collection('products').doc(item.id).get();
            if (prodRef.exists) {
                const prodData = prodRef.data();
                sourceContent = prodData.content || "";
                
                // Cek Variasi
                if (item.variantName && item.variantName !== 'Regular' && prodData.variations) {
                    const v = prodData.variations.find(va => va.name === item.variantName);
                    if (v) {
                        sourceContent = v.content || "";
                        if (v.isPermanent) isItemPermanent = true;
                    }
                } else {
                    // Produk Utama
                    if (prodData.isPermanent) isItemPermanent = true;
                }
            }
        } catch (err) { console.log("DB Err:", err); }

        // Cek flag Multi API
        if (sourceContent.startsWith('MULTI_API:')) isItemPermanent = true;

        // --- JIKA PERMANEN: LANGSUNG EKSEKUSI SUKSES ---
        if (isItemPermanent) {
            // Panggil processStock untuk update 'sold' saja
            const res = await processStock(item.id, item.variantName, item.qty, false);
            items.push({ ...item, content: res.data });
            msgLog += `✅ ${item.name}: PERMANEN (Auto)\n`;
            continue; // Lanjut ke item berikutnya
        }
        // ----------------------------------------

        // ============================================================
        // TAHAP 1: CEK TIPE PRODUK (MULTI-API SMART)
        // ============================================================
        if (sourceContent.startsWith('MULTI_API:')) {
            const apiEntries = sourceContent.replace('MULTI_API:', '').split('#').filter(x => x.trim().length > 5);
            
            let providerList = apiEntries.map(entry => {
                const [url, sku, buyPrice] = entry.split('|');
                return { 
                    url: url?.trim(), 
                    sku: sku?.trim(), 
                    price: parseInt(buyPrice || 9999999) 
                };
            });

            providerList.sort((a, b) => a.price - b.price);

            let successBuy = false;
            let finalSn = "";
            let errMessage = "";
            
            console.log(`🤖 Smart Buy: Mencari termurah untuk ${item.name}...`);

            for (const prov of providerList) {
                if(!prov.url) continue;
                
                const hasil = await beliGeneric(prov.url, prov.sku, orderData.buyerPhone);
                
                if (hasil.sukses) {
                    successBuy = true;
                    finalSn = hasil.sn;
                    console.log(`✅ SUKSES di ${prov.url}`);
                    break;
                } else {
                    errMessage = hasil.msg;
                    console.log(`❌ GAGAL di ${prov.url}: ${hasil.msg}`);
                }
            }

            if (successBuy) {
                items.push({ 
                    ...item, 
                    content: `✅ SUKSES DIKIRIM!\nSN/TrxID: ${finalSn}\n\nTerima kasih sudah order!` 
                });
                msgLog += `✅ ${item.name}: AUTO SUCCESS (SMART API)\n`;

                try {
                    await db.collection('products').doc(item.id).update({
                        sold: admin.firestore.FieldValue.increment(parseInt(item.qty))
                    });
                } catch(e) { console.log("Gagal update sold count API:", e.message); }

            } else {
                items.push({ 
                    ...item, 
                    content: `[...MENUNGGU PROSES ADMIN...]\n(Semua Jalur Gagal: ${errMessage})` 
                });
                allComplete = false;
                msgLog += `❌ ${item.name}: GAGAL SEMUA API\n`;
                revBtns.push([Markup.button.callback(`🔧 PROSES MANUAL: ${item.name}`, `rev_${orderId}_${i}`)]);
            }
            continue; 
        }

        // ============================================================
        // TAHAP 2: STOK MANUAL (LAMA + AUTO HUNTER + FORCE MODE)
        // ============================================================
        
        const isContentFull = item.content && !item.content.includes('[...MENUNGGU');
        if (isContentFull && !forceHunter) { items.push(item); msgLog += `✅ ${item.name}: OK\n`; continue; }

        let currentContentLines = item.content ? item.content.split('\n') : [];
        if (forceHunter) currentContentLines = []; // Reset jika dipaksa

        let validLines = currentContentLines.filter(l => !l.includes('[...MENUNGGU'));
        let validLinesCount = validLines.length;
        let qtyButuh = item.qty - validLinesCount;
        if (qtyButuh <= 0) { items.push(item); continue; }

        try {
            const result = await processStock(item.id, item.variantName, qtyButuh, forceHunter);
            
            if (result && result.success) {
                // STOK CUKUP
                const validLines = currentContentLines.filter(l => !l.includes('[...MENUNGGU'));
                let newContent = result.data;
                const finalContent = result.currentStock === 999999 ? newContent : [...validLines, ...newContent.split('\n')].join('\n');
                items.push({ ...item, content: finalContent });
                msgLog += `✅ ${item.name}: SUKSES\n`;

            } else if (result && !result.success) {
                // STOK KURANG -> CEK HUNTER
                let stockFromDB = [];
                
                if(result.currentStock > 0 && !forceHunter) {
                    const partialRes = await processStock(item.id, item.variantName, result.currentStock);
                    stockFromDB = partialRes.data.split('\n');
                }

                const currentHave = (forceHunter ? 0 : validLinesCount) + stockFromDB.length;
                const stillNeed = item.qty - currentHave;
                let hunterContent = [];
                
                // [FIX SOLD]: Hitung sukses hunter
                let hunterSuccessCount = 0;

                // LOGIKA HUNTER (AUTO_BACKUP)
                if (result.backupConfig && stillNeed > 0) {
                    const [url, sku] = result.backupConfig.split('|');
                    if(url && sku) {
                        console.log(`🤖 Hunter Active: Mencari ${stillNeed} via Backup...`);
                        for(let k=0; k<stillNeed; k++) {
                            const hasil = await beliGeneric(url, sku, orderData.buyerPhone);
                            if(hasil.sukses) {
                                hunterContent.push(`${hasil.sn}`);
                                hunterSuccessCount++;
                            }
                            else hunterContent.push(`[...MENUNGGU PROSES (API Gagal)...]`);
                        }
                    }
                }
                
                // [FIX SOLD]: Update Sold jika hunter sukses
                if(hunterSuccessCount > 0) {
                    try {
                        await db.collection('products').doc(item.id).update({
                            sold: admin.firestore.FieldValue.increment(hunterSuccessCount)
                        });
                    } catch(e) { console.log("Gagal update sold hunter:", e); }
                }

                // [FIX]: Gabungkan semua sumber dengan benar
                let prevLines = forceHunter ? [] : validLines;
                let finalLines = [...prevLines, ...stockFromDB, ...hunterContent];
                
                // Isi sisa dengan placeholder MENUNGGU
                const totalSekarang = finalLines.length;
                const totalKurang = item.qty - totalSekarang;

                if (totalKurang > 0) {
                    for(let k=0; k<totalKurang; k++) finalLines.push(`[...MENUNGGU ${totalKurang} LAGI...]`);
                    allComplete = false;
                    msgLog += `⚠️ ${item.name}: PARTIAL (Kurang ${totalKurang})\n`;
                    revBtns.push([Markup.button.callback(`🔧 ISI SISA: ${item.name}`, `rev_${orderId}_${i}`)]);
                } else {
                    msgLog += `✅ ${item.name}: SUKSES (Hybrid)\n`;
                }

                items.push({ ...item, content: finalLines.join('\n') });
            }
        } catch (e) { items.push(item); allComplete = false; msgLog += `❌ ${item.name}: ERROR DB\n`; }
    }
    
    // ============================================================
    // TAHAP 4: FINALISASI & NOTIFIKASI
    // ============================================================
    
    // [UPDATE]: Status selalu success agar muncul di web, walau isi "Menunggu"
    await db.collection('orders').doc(orderId).update({ items, status: 'success', processed: true });

    if (!allComplete) {
        // [UPDATE]: Jika belum lengkap, kasih tombol Force Send juga
        revBtns.push([Markup.button.callback('⚡ PROSES PAKSA (REVISI)', `force_send_${orderId}`)]);
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ *PERHATIAN: ORDER ${orderId} BELUM LENGKAP*\nWeb User sudah menampilkan status "Menunggu".\n\n${msgLog}\nSegera isi manual!`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(revBtns) });
    } else {
        bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER ${orderId} SELESAI*\n${msgLog}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🛠 MENU EDIT', `menu_edit_ord_${orderId}`)]]) });
    }

    let userMsg = `✅ *PESANAN SELESAI!*\n🆔 Order: \`${orderId}\`\n\n`;
    items.forEach(item => {
        let clean = item.content.replace('MULTI_API:', '').replace(/AUTO_BACKUP:.*?\|.*?\|.*?/g, '');
        // Bersihkan tanda MENUNGGU agar di chat WA user tidak aneh
        let contentClean = clean.replace(/\[\.\.\.MENUNGGU.*?\]/g, '_(Sedang diproses/Menunggu Pembayaran)_').replace(/\n/g, '\n'); 
        userMsg += `📦 *${item.name}*\n\`${contentClean}\`\n\n`;
    });
    userMsg += `_Terima kasih sudah belanja!_`;

    if (typeof notifyUser === 'function') {
        await notifyUser(orderData.buyerPhone, userMsg);
    }
};

// [BARU]: Fungsi Helper Force Fulfill
const forceFulfillOrder = async (orderId) => {
    try {
        const docRef = db.collection('orders').doc(orderId);
        const docSnap = await docRef.get();
        if (!docSnap.exists) return { success: false, msg: "Order 404" };
        
        // Panggil dengan parameter TRUE (Force Mode)
        await processOrderLogic(orderId, docSnap.data(), true);
        return { success: true, msg: "✅ Order dipaksa proses ulang ke Supplier/Sheet!" };
    } catch (e) { return { success: false, msg: "Err: " + e.message }; }
};

// ==========================================
// 3. API WEBHOOKS
// ==========================================
app.post('/api/confirm-manual', async (req, res) => {
    try {
        const { orderId, buyerPhone, total, items } = req.body;
        let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
        
        // [UPDATE]: Tombol Force Send
        await bot.telegram.sendMessage(ADMIN_ID, 
            `🔔 *ORDER MASUK (MANUAL)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}\n\n_Jika uang sudah masuk, klik Proses Paksa._`, 
            Markup.inlineKeyboard([
                [Markup.button.callback('⚡ PROSES PAKSA', `force_send_${orderId}`)],
                [Markup.button.callback('❌ TOLAK', `tolak_${orderId}`)]
            ])
        );
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// [BAGIAN 2: HANDLER KOMPLAIN AUTO-PILOT]
app.post('/api/complain', async (req, res) => {
    const { orderId, message } = req.body;
    
    // 1. Ambil History Chat dari Database (Agar AI Nyambung)
    const orderRef = db.collection('orders').doc(orderId);
    const docSnap = await orderRef.get();
    
    let chatHistory = [];
    let buyerPhone = "";

    if (docSnap.exists) {
        const d = docSnap.data();
        chatHistory = d.chatHistory || []; // Ambil riwayat chat sebelumnya jika ada
        buyerPhone = d.buyerPhone;
    }

    // 2. AI Berpikir (Mengirim pesan baru + history lama)
    const aiReply = await askGeminiChat(message, chatHistory);

    // 3. Simpan Riwayat Baru ke Database
    const newHistory = [
        ...chatHistory,
        { role: 'user', parts: message }, // Apa yang user bilang
        { role: 'model', parts: aiReply } // Apa yang AI jawab
    ];

    await orderRef.update({ 
        complain: true, 
        complainResolved: true, // Dianggap tertangani sementara oleh AI
        userComplainText: message,
        adminReply: `[AI]: ${aiReply}`,
        chatHistory: newHistory // Update memori
    });

    // 4. Notifikasi ke Admin
    await bot.telegram.sendMessage(ADMIN_ID, 
        `🤖 *KOMPLAIN MASUK (AI MODE)*\n\n🆔 Order: \`${orderId}\`\n💬 *User:* "${message}"\n🧠 *Jawab AI:* "${aiReply}"\n\n_Bot sudah membalas otomatis. Jika jawaban salah, klik tombol di bawah untuk ambil alih._`, 
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📩 Ambil Alih Manual', `reply_comp_${orderId}`)]]) }
    );

    // 5. Kirim Jawaban AI ke User
    if (buyerPhone) {
        await notifyUser(buyerPhone, `🤖 *CS Jie Store*\n\n${aiReply}`);
    }

    res.json({ status: 'ok', reply: aiReply });
});

app.post('/api/notify-order', async (req, res) => {
    const { orderId, buyerPhone, total, items, voucherCode } = req.body; 
    const docRef = db.collection('orders').doc(orderId);
    const docSnap = await docRef.get();
    
    if (docSnap.exists) {
        const orderData = docSnap.data();
        const security = await validateOrderSecurity(orderId, orderData);
        
        if (!security.isSafe) {
            await docRef.update({ status: 'FRAUD', adminReply: 'BANNED: CHEATING.' });
            
            if (orderData.uid) {
                const userRef = db.collection('users').doc(orderData.uid);
                const userSnap = await userRef.get();
                if (userSnap.exists) {
                    await db.collection('banned_users').doc(orderData.uid).set({
                        ...userSnap.data(),
                        bannedAt: new Date(),
                        reason: `Fraud Order ${orderId}`,
                        lastBalance: userSnap.data().balance || 0
                    });
                    await userRef.delete(); 
                }
            }
            
            await bot.telegram.sendMessage(ADMIN_ID, `🚨 *MALING DITANGKAP!* \nOrder: \`${orderId}\` \nUser: ${buyerPhone}\nUID: \`${orderData.uid}\`\n\n🛡 *Tindakan:* User dipindah ke BANNED LIST (Saldo Aman).`);
            return res.json({ status: 'fraud' });
        }
        
        let txt = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
        await bot.telegram.sendMessage(ADMIN_ID, `✅ *ORDER LUNAS (SALDO)*\n🆔 \`${orderId}\`\n👤 ${buyerPhone}\n💰 Rp ${parseInt(total).toLocaleString()}\n\n${txt}`, { parse_mode: 'Markdown' });
        await processOrderLogic(orderId, orderData);
    }
    res.json({ status: 'ok' });
});

// [BARU] HANDLER ORDER GRATIS (AUTO KLAIM)
app.post('/api/claim-free', async (req, res) => {
    const { orderId, buyerPhone, itemId, variantName } = req.body;
    
    // 1. Buat Data Order Dummy
    const itemData = { id: itemId, variantName: variantName || 'Regular', qty: 1, name: 'FREE ITEM' };
    
    // Ambil detail nama produk asli untuk log
    try {
        const pRef = await db.collection('products').doc(itemId).get();
        if(pRef.exists) itemData.name = pRef.data().name;
    } catch(e){}

    // 2. Simpan Order Status SUCCESS Langsung
    await db.collection('orders').doc(orderId).set({
        items: [itemData],
        total: 0,
        buyerPhone: buyerPhone,
        status: 'success', // Langsung sukses
        method: 'free',
        createdAt: new Date(),
        processed: false
    });

    // 3. Trigger Logika Pengiriman Barang (Otomatis)
    await processOrderLogic(orderId, { items: [itemData], buyerPhone }, false);

    bot.telegram.sendMessage(ADMIN_ID, `🎁 *KLAIM GRATIS!* \nUser: ${buyerPhone}\nItem: ${itemData.name}`);
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => res.send('JSN-02 READY'));

// ==========================================
// 4. BOT BRAIN (UNIVERSAL SEARCH)
// ==========================================
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('➕ TAMBAH PRODUK', 'add_prod')],
    [Markup.button.callback('⏳ LIST PENDING', 'list_pending'), Markup.button.callback('📦 CEK SEMUA STOK', 'list_all_stock')],
    [Markup.button.callback('📄 ISI STOK (UPLOAD)', 'restock_sheet_ask')],
    [Markup.button.callback('👥 PANDUAN USER', 'manage_users'), Markup.button.callback('💳 PAYMENT', 'set_payment')],
    [Markup.button.callback('🎨 GANTI BACKGROUND', 'set_bg')],
    [Markup.button.callback('📢 ATUR NOTIF', 'menu_notif'), Markup.button.callback('📺 ATUR KONTEN', 'menu_content')], // [BARU]
    [Markup.button.callback('💰 SALES', 'sales_today'), Markup.button.callback('🚨 KOMPLAIN', 'list_complain')],
    [Markup.button.callback('📂 BACKUP DB', 'backup_db'), Markup.button.callback('📥 IMPORT DB', 'import_db_ask')]
]);

bot.command('admin', (ctx) => ctx.reply("🛠 *PANEL ADMIN*\nKetik 'help' untuk bantuan.\nKetik APAPUN untuk mencari.", mainMenu));

// --- FITUR TAMBAHAN (NOTIF & KONTEN) ---

// 1. Set Notifikasi Web: /setnotif Pesan.. | Link..
bot.command('setnotif', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1).join(' ');
    if(!args) return ctx.reply("Format: /setnotif PESAN PENTING | LINK_TOMBOL (Opsional)");
    
    const [msg, link] = args.split('|');
    await db.collection('settings').doc('announcement').set({
        text: msg.trim(),
        link: link ? link.trim() : '',
        active: true,
        updatedAt: new Date()
    });
    ctx.reply("✅ Notifikasi Web Diupdate!");
});

// 2. Hapus Notifikasi: /delnotif
bot.command('delnotif', async (ctx) => {
    await db.collection('settings').doc('announcement').update({ active: false });
    ctx.reply("✅ Notifikasi Dimatikan.");
});

// 3. Tambah Konten Slider (YouTube/Link): /addcontent tipe | judul | url | gambar
bot.command('addcontent', async (ctx) => {
    const content = ctx.message.text.replace('/addcontent ', '');
    const [type, title, url, thumb] = content.split('|').map(s=>s.trim());
    
    if(!type || !title || !url) return ctx.reply("Format: /addcontent youtube|Judul Video|ID_VIDEO|URL_THUMBNAIL");

    await db.collection('contents').add({
        type, title, url, 
        thumbnail: thumb || "https://placehold.co/600x400/000/FFF?text=No+Image",
        createdAt: new Date()
    });
    ctx.reply("✅ Konten Slider Ditambahkan!");
});

// 4. Hapus Semua Konten: /clearcontent
bot.command('clearcontent', async (ctx) => {
    const snap = await db.collection('contents').get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    ctx.reply("✅ Semua konten slider dihapus.");
});

// 5. Tambah Konten HTML (Mini Apps): /addhtml JUDUL
bot.command('addhtml', (ctx) => {
    const title = ctx.message.text.replace('/addhtml', '').trim();
    if(!title) return ctx.reply("❌ Format Salah. Ketik: /addhtml JUDUL_KONTEN_GAMEMU");
    
    adminSession[ctx.from.id] = { type: 'UPLOAD_HTML', title };
    ctx.reply(`📂 Oke! Sekarang KIRIM FILE .html untuk konten "${title}" ke sini.`);
});

// ==========================================
// 4. BOT BRAIN (OTAK BOT - VERSI BARU)
// ==========================================
bot.on(['text', 'photo', 'document'], async (ctx, next) => {
    // 1. Cek apakah yang chat adalah ADMIN
    if (String(ctx.from.id) !== ADMIN_ID) return next();
    
    // 2. Ambil teks pesan
    let text = "";
    const session = adminSession[ctx.from.id];

    // LOGIKA IMPORT DB & UPLOAD STOK SHEET & UPLOAD HTML
    if (ctx.message.document) {
        try { 
            const docFile = ctx.message.document;
            const fileLink = await ctx.telegram.getFileLink(docFile.file_id);
            const response = await axios.get(fileLink.href, { responseType: 'text' }); // Baca sebagai text

            // [BARU] LOGIKA UPLOAD HTML TOOLS/GAME
            if (session && session.type === 'UPLOAD_HTML') {
                if (!docFile.file_name.endsWith('.html') && !docFile.file_name.endsWith('.htm')) {
                    return ctx.reply("❌ Harus file .html kawan!");
                }
                
                await db.collection('contents').add({
                    type: 'html_app',
                    title: session.title,
                    htmlContent: response.data,
                    thumbnail: 'https://placehold.co/600x400/000/FFF?text=HTML+TOOL',
                    createdAt: new Date()
                });
                
                delete adminSession[ctx.from.id];
                return ctx.reply(`✅ Konten HTML "${session.title}" Berhasil Disimpan!`);
            }

            if (session && session.type === 'IMPORT_DB') {
                ctx.reply("⏳ Sedang memproses file backup...");
                const data = JSON.parse(response.data);
                if (!data || typeof data !== 'object') throw new Error("Format JSON salah.");
                const batchLimit = 400; let batch = db.batch(); let opCount = 0;
                for (const [collectionName, items] of Object.entries(data)) {
                    if (!Array.isArray(items)) continue;
                    for (const item of items) {
                        const docRef = db.collection(collectionName).doc(item.id);
                        const { id, ...docData } = item; 
                        batch.set(docRef, docData, { merge: true });
                        opCount++;
                        if (opCount >= batchLimit) { await batch.commit(); batch = db.batch(); opCount = 0; }
                    }
                }
                if (opCount > 0) await batch.commit();
                delete adminSession[ctx.from.id];
                return ctx.reply("✅ **IMPORT SUKSES!**\nSemua data telah dikembalikan.");
            } 
            // [UPDATE]: LOGIKA UPLOAD STOK KE GOOGLE SHEET
            else if (session && session.type === 'RESTOCK_SHEET') {
                ctx.reply("⏳ Membaca file & Upload ke Sheet...");
                const rawData = response.data; 
                let stockArray = [];
                if (typeof rawData === 'string') {
                    stockArray = rawData.split('\n').map(s => s.trim()).filter(s => s.length > 0);
                }
                if (stockArray.length === 0) return ctx.reply("❌ File kosong atau bukan text.");

                // Kirim ke Script
                try {
                    const resGoogle = await axios.post(session.targetUrl, { data: stockArray }, { headers: { 'Content-Type': 'application/json' } });
                    if (String(resGoogle.data).includes('BERHASIL')) {
                        delete adminSession[ctx.from.id];
                        return ctx.reply(`✅ **SUKSES UPLOAD!**\n\n📊 Total: ${stockArray.length} baris\n📥 Masuk ke Google Sheet.`);
                    } else { return ctx.reply(`⚠️ Gagal Script: ${resGoogle.data}`); }
                } catch(err) { return ctx.reply("❌ Gagal Tembak Script: " + err.message); }
            }
            else {
                ctx.reply("📂 File diterima (Tapi tidak sedang dalam mode Import/Restock/HTML).");
            }
        } catch(e) { return ctx.reply("❌ Gagal Baca File: " + e.message); }
    } else if (ctx.message.photo) {
        text = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else {
        text = ctx.message.text ? ctx.message.text.trim() : '';
    }

    const textLower = text.toLowerCase();
    const userId = ctx.from.id;

    // ===============================================
    // 🔥 BAGIAN PERINTAH "TANPA SLASH" (DIPANDU) 🔥
    // ===============================================

    // A. FITUR HELP (PANDUAN)
    if (textLower === 'help' || textLower === 'bantuan') {
        const msg = `
📘 **PANDUAN ADMIN JIE STORE**

Ketik kata kunci di bawah ini (Tanpa garis miring):

🔹 **MENU**
Membuka tombol menu utama.

🔹 **VOUCHER**
Membuat kode diskon baru secara bertahap.

🔹 **UNBAN**
Membebaskan user yang terblokir.

🔹 **PENCARIAN (LANGSUNG KETIK)**
- Ketik *Nama/Kode Produk* untuk edit stok.
- Ketik *Email/UID User* untuk isi saldo.
- Ketik *ID Order* untuk revisi/cek order.

`;
        return ctx.reply(msg, {parse_mode: 'Markdown'});
    }

    // B. FITUR MENU
    if (textLower === 'menu' || textLower === 'admin') {
        return ctx.reply("🛠 *PANEL ADMIN*", mainMenu);
    }

    // C. FITUR BUAT VOUCHER (WIZARD)
    if (textLower === 'voucher') {
        adminSession[userId] = { type: 'MAKE_VOUCHER', step: 'CODE', data: {} };
        return ctx.reply("🎫 **BUAT VOUCHER BARU**\n\nSilakan ketik KODE VOUCHER yang diinginkan (Misal: PROMO10K):", cancelBtn);
    }

    // D. FITUR UNBAN USER (WIZARD)
    if (textLower === 'unban') {
        adminSession[userId] = { type: 'DO_UNBAN', step: 'UID' };
        return ctx.reply("🔓 **UNBAN USER**\n\nSilakan kirim/paste **UID USER** yang mau dibebaskan:", cancelBtn);
    }
    // --- FITUR HAPUS VOUCHER MANUAL (PAKAI SLASH) ---
    if (text.startsWith('/delvoucher ')) {
        const parts = text.split(' ');
        if (parts.length > 1) {
            const code = parts[1].toUpperCase();
            await db.collection('vouchers').doc(code).delete();
            return ctx.reply(`🗑 Voucher \`${code}\` berhasil dihapus.`);
        } else {
            return ctx.reply("❌ Format salah. Ketik: `/delvoucher KODE`");
        }
    }
    // ===============================================
    // 🧠 LOGIKA SESI (JAWABAN DARI PERTANYAAN BOT)
    // ===============================================
    if (session) {
        // [BARU] LOGIKA SET NOTIFIKASI
        if (session.type === 'SET_NOTIF') {
            await db.collection('settings').doc('announcement').set({ text: text, link: '', active: true, updatedAt: new Date() });
            delete adminSession[ctx.from.id]; return ctx.reply("✅ Notifikasi Web Diupdate!");
        }
        // [BARU] LOGIKA SET KONTEN SLIDER
        if (session.type === 'ADD_CONTENT') {
            const [type, title, url] = text.split('|').map(s=>s.trim());
            if(!url) return ctx.reply("Format Salah. Coba lagi: TIPE | JUDUL | URL");
            await db.collection('contents').add({ type: type.toLowerCase(), title, url, thumbnail: `https://img.youtube.com/vi/${url}/mqdefault.jpg`, createdAt: new Date() });
            delete adminSession[ctx.from.id]; return ctx.reply("✅ Konten Slider Ditambah!");
        }

        // [UPDATE]: SESI UPLOAD STOK SHEET
        if (session.type === 'ASK_SHEET_URL') {
            if (!text.includes('script.google.com')) return ctx.reply("❌ URL Salah. Harus link Google Script.", cancelBtn);
            session.type = 'RESTOCK_SHEET'; session.targetUrl = text;
            ctx.reply("📂 Oke. Sekarang **Kirim File .txt** (Format: KODE|DATA).", cancelBtn); return;
        }

        // --- FITUR BARU: ADD VARIATION TO EXISTING PRODUCT ---
        else if (session.type === 'ADD_VAR_EXISTING') {
            const prodRef = db.collection('products').doc(session.prodId);
            const docSnap = await prodRef.get();
            const prodData = docSnap.data();
            let variations = prodData.variations || [];

            if (session.step === 'NAME') { 
                session.tempVar = { name: text, apiList: [] }; 
                session.step = 'CODE'; 
                ctx.reply("Kode Variasi:", cancelBtn); 
            }
            else if (session.step === 'CODE') { 
                session.tempVar.code = text; 
                session.step = 'PRICE'; 
                ctx.reply("Harga Variasi:", cancelBtn); 
            }
            else if (session.step === 'PRICE') { 
                session.tempVar.price = parseInt(text); 
                session.step = 'ASK_API'; 
                ctx.reply("Pakai API? (ya/tidak)", cancelBtn); 
            }
            else if (session.step === 'ASK_API') {
                if (text.toLowerCase() === 'ya') { 
                    session.step = 'INPUT_API'; 
                    ctx.reply("Format: `URL|KODE|MODAL`", cancelBtn); 
                } else { 
                    session.step = 'CONTENT'; 
                    ctx.reply("Stok Manual (Bisa + AUTO_BACKUP:):", cancelBtn); 
                }
            }
            else if (session.step === 'INPUT_API') {
                if(text.includes('|')) {
                    session.tempVar.apiList.push(text);
                    session.tempVar.content = 'MULTI_API:' + session.tempVar.apiList.join('#');
                    session.tempVar.isPermanent = true;
                    variations.push(session.tempVar);
                    await prodRef.update({ variations });
                    delete adminSession[userId];
                    ctx.reply("✅ Variasi API Ditambahkan!");
                } else { 
                    ctx.reply("Format Salah.", cancelBtn); 
                }
            }
            else if (session.step === 'CONTENT') {
                session.tempVar.content = text; 
                session.step = 'PERM'; 
                ctx.reply("Permanen? (ya/tidak)", cancelBtn);
            }
            else if (session.step === 'PERM') {
                session.tempVar.isPermanent = text.toLowerCase() === 'ya';
                variations.push(session.tempVar);
                await prodRef.update({ variations });
                delete adminSession[userId];
                ctx.reply("✅ Variasi Manual Ditambahkan!");
            }
            return;
        }

        // --- PROSES PEMBUATAN VOUCHER (DIPANDU) ---
        else if (session.type === 'MAKE_VOUCHER') {
            if (session.step === 'CODE') {
                session.data.code = text.toUpperCase().replace(/\s/g, ''); // Hapus spasi & kapital
                session.step = 'AMOUNT';
                return ctx.reply(`✅ Kode: **${session.data.code}**\n\nSekarang masukkan **NOMINAL DISKON** (Angka saja, misal: 5000):`, cancelBtn);
            } 
            else if (session.step === 'AMOUNT') {
                const amount = parseInt(text);
                if (isNaN(amount)) return ctx.reply("⚠️ Harap masukkan angka saja!", cancelBtn);
                
                // Simpan ke Database
                await db.collection('vouchers').doc(session.data.code).set({ 
                    amount: amount, 
                    active: true, 
                    createdAt: new Date() 
                });
                
                delete adminSession[userId];
                return ctx.reply(`🎉 **SUKSES!**\n\nVoucher \`${session.data.code}\` berhasil dibuat.\nNilai: Rp ${amount.toLocaleString()}`);
            }
        }

        // --- PROSES UNBAN (DIPANDU) ---
        else if (session.type === 'DO_UNBAN') {
            const targetUid = text.trim();
            const jailRef = db.collection('banned_users').doc(targetUid);
            const jailSnap = await jailRef.get();
            
            if (jailSnap.exists) {
                const savedData = jailSnap.data();
                // Kembalikan ke table users
                await db.collection('users').doc(targetUid).set({ 
                    ...savedData, 
                    restoredAt: new Date() 
                });
                // Hapus dari penjara
                await jailRef.delete();
                delete adminSession[userId];
                return ctx.reply(`✅ **USER DI-UNBAN!**\nUID: \`${targetUid}\`\n💰 Saldo Kembali: Rp ${savedData.balance?.toLocaleString()}`);
            } else {
                return ctx.reply("❌ User tidak ditemukan di daftar Banned. Coba UID lain atau batalkan.", cancelBtn);
            }
        }

        // --- LOGIKA SESI LAMA (ADD PRODUK, REVISI, DLL) ---
        // [FIX 1: Logika Edit Manual nambah Sold Count]
        else if (session.type === 'REVISI') {
            if (!isNaN(text) && parseInt(text) > 0 && text.length < 5) {
                session.targetLine = parseInt(text) - 1; session.type = 'REVISI_LINE_INPUT'; ctx.reply(`🔧 Kirim data baru baris #${text}:`, cancelBtn);
            } else {
                const d = await db.collection('orders').doc(session.orderId).get(); const data = d.data(); const item = data.items[session.itemIdx];
                
                // Cek apakah User memasukkan format API (Ada '|' dan 'http')
                if(text.includes('|') && text.includes('http')) {
                    item.content = 'MULTI_API:' + text; // Paksa format API
                    ctx.reply("✅ Diubah menjadi Format API.");
                } else {
                    let ex = item.content?item.content.split('\n'):[]; let inp = text.split('\n').filter(x=>x.trim());
                    let fill=0; let newC=[...ex];
                    
                    // Logic Smart Fill: Ganti 'MENUNGGU' dengan input admin
                    for(let i=0;i<newC.length;i++){ 
                        if(newC[i].includes('[...MENUNGGU') && inp.length>0){
                            newC[i]=inp.shift();
                            fill++;
                        } 
                    }
                    
                    // Jika masih ada sisa input, tambahkan ke bawah
                    if (inp.length > 0) {
                        newC = [...newC, ...inp];
                        fill += inp.length;
                    }

                    // Update Konten
                    item.content = newC.join('\n');
                    
                    // [PERBAIKAN PENTING]: Tambah Counter Sold jika admin mengisi data
                    if (fill > 0) {
                         try {
                            await db.collection('products').doc(item.id).update({
                                sold: admin.firestore.FieldValue.increment(fill)
                            });
                         } catch(e) { console.log("Gagal update sold manual:", e); }
                    }

                    ctx.reply(`✅ Terisi ${fill} slot baru & Sold bertambah.`);
                }

                await db.collection('orders').doc(session.orderId).update({ items: data.items }); delete adminSession[userId]; processOrderLogic(session.orderId, data);
            }
            return;
        }
        else if (session.type === 'REVISI_LINE_INPUT') {
            const d = await db.collection('orders').doc(session.orderId).get(); const data = d.data(); const item = data.items[session.itemIdx];
            let lines = item.content?item.content.split('\n'):[];
            // FIX: Handle baris kosong
            if(session.targetLine >= lines.length) lines[session.targetLine] = text; 
            else lines[session.targetLine] = text;
            
            item.content=lines.join('\n'); 
            await db.collection('orders').doc(session.orderId).update({items:data.items}); delete adminSession[userId]; ctx.reply("✅ Updated."); 
            return;
        }
        else if (session.type === 'ADD_PROD') {
            const d = session.data;
            if (session.step === 'NAME') { d.name = text; session.step = 'CODE'; ctx.reply("🏷 Kode Produk:", cancelBtn); }
            else if (session.step === 'CODE') { d.code = text; session.step = 'PRICE'; ctx.reply("💰 Harga:", cancelBtn); }
            else if (session.step === 'PRICE') { d.price = parseInt(text); session.step = 'IMG'; ctx.reply("🖼 Gambar/URL (Multi pisah koma/enter):", cancelBtn); }
            else if (session.step === 'IMG') { 
                const rawText = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : text;
                d.images = rawText.split(/[\n,]+/).map(s => s.trim()).filter(s => s.length > 0);
                d.image = d.images[0] || ""; 
                d.sold=0; d.view=0; session.step='STATS'; 
                // Skip stats manual, langsung ke API check
                d.apiList = [];
                session.step = 'ASK_IF_API';
                ctx.reply("🔗 Produk Utama pakai API? (ya/tidak)", cancelBtn); 
            }
            else if (session.step === 'ASK_IF_API') {
                if(text.toLowerCase() === 'ya') {
                    session.step = 'INPUT_API_DATA';
                    ctx.reply("📝 Format: `URL|KODE|MODAL`", cancelBtn);
                } else {
                    if (d.apiList.length > 0) {
                        d.content = 'MULTI_API:' + d.apiList.join('#');
                        d.isPermanent = true;
                        session.step = 'DESC';
                        ctx.reply("✅ API Utama Saved. Deskripsi:", cancelBtn);
                    } else {
                        session.step = 'STATS'; 
                        ctx.reply("📊 Sold View (Contoh: 100 500):", cancelBtn);
                    }
                }
            }
            else if (session.step === 'INPUT_API_DATA') {
                if (text.includes('|')) {
                    d.apiList.push(text);
                    session.step = 'ASK_IF_API';
                    ctx.reply("✅ Saved. Ada API Lain/Backup? (ya/tidak)", cancelBtn);
                } else {
                    ctx.reply("⚠️ Format Salah. Gunakan `URL|KODE|MODAL`", cancelBtn);
                }
            }

            else if (session.step === 'STATS') { const [s,v] = text.split(' '); d.sold=parseInt(s)||0; d.view=parseInt(v)||0; session.step='DESC'; ctx.reply("📝 Deskripsi:", cancelBtn); }
            else if (session.step === 'DESC') { 
                d.desc = text; 
                if(d.apiList && d.apiList.length > 0) {
                     await db.collection('products').add({...d, createdAt:new Date()}); delete adminSession[userId]; ctx.reply("✅ Produk Smart API Saved.");
                } else {
                    session.step = 'CONTENT'; ctx.reply("📦 STOK MANUAL (Bisa + AUTO_BACKUP:):", cancelBtn); 
                }
            }
            else if (session.step === 'CONTENT') { d.content = text==='skip'?'':text; if (d.content) { session.step = 'IS_PERM'; ctx.reply("♾️ PERMANEN? (YA/TIDAK):", cancelBtn); } else { session.step = 'VARS'; ctx.reply("🔀 Ada Variasi? (ya/tidak):", cancelBtn); } }
            else if (session.step === 'IS_PERM') { d.isPermanent = text.toLowerCase() === 'ya'; session.step = 'VARS'; ctx.reply("🔀 Ada Variasi? (ya/tidak):", cancelBtn); }
            else if (session.step === 'VARS') {
                if(text.toLowerCase()==='ya'){ session.step='VAR_NAME'; ctx.reply("Nama Variasi:", cancelBtn); }
                else { await db.collection('products').add({...d, createdAt:new Date()}); delete adminSession[userId]; ctx.reply("✅ Saved."); }
            }
            else if (session.step === 'VAR_NAME') { if(!d.variations)d.variations=[]; session.tempVar={name:text, apiList:[]}; session.step='VAR_CODE'; ctx.reply("Kode Var:", cancelBtn); }
            else if (session.step === 'VAR_CODE') { session.tempVar.code=text; session.step='VAR_PRICE'; ctx.reply("Harga Var:", cancelBtn); }
            else if (session.step === 'VAR_PRICE') { session.tempVar.price=parseInt(text); session.step='VAR_ASK_API'; ctx.reply("API Var? (ya/tidak)", cancelBtn); }
            else if (session.step === 'VAR_ASK_API') {
                if(text.toLowerCase() === 'ya') { session.step = 'VAR_INPUT_API'; ctx.reply("Format: URL|KODE|MODAL", cancelBtn); }
                else { 
                    if(session.tempVar.apiList.length>0) { session.tempVar.content = 'MULTI_API:' + session.tempVar.apiList.join('#'); session.tempVar.isPermanent = true; d.variations.push(session.tempVar); session.step='VARS'; ctx.reply("Var Lain? (ya/tidak)", cancelBtn); }
                    else { session.step='VAR_CONTENT'; ctx.reply("Stok Manual:", cancelBtn); }
                }
            }
            else if (session.step === 'VAR_INPUT_API') { session.tempVar.apiList.push(text); session.step='VAR_ASK_API'; ctx.reply("API Lain? (ya/tidak)", cancelBtn); }
            else if (session.step === 'VAR_CONTENT') { session.tempVar.content=text; session.step='VAR_PERM'; ctx.reply("♾️ Variasi PERMANEN? (YA/TIDAK):", cancelBtn); }
            else if (session.step === 'VAR_PERM') { session.tempVar.isPermanent = text.toLowerCase() === 'ya'; d.variations.push(session.tempVar); session.step='VARS'; ctx.reply("✅ Lanjut? (ya/tidak)", cancelBtn); }
            return;
        }
        else if (session.type === 'TOPUP_USER') { 
            const amount = parseInt(text);
            await db.collection('users').doc(session.targetUid).update({balance:admin.firestore.FieldValue.increment(amount)}); 
            await notifyUser(session.targetUid, `💰 *SALDO MASUK*\nJumlah: Rp ${amount.toLocaleString()}`); // Notif ke User
            delete adminSession[userId]; 
            ctx.reply("✅ Saldo Ditambah & Notif dikirim."); 
            return;
        }
        else if (session.type === 'DEDUCT_USER') { await db.collection('users').doc(session.targetUid).update({balance:admin.firestore.FieldValue.increment(-parseInt(text))}); delete adminSession[userId]; ctx.reply("✅ Saldo Dipotong."); return;}
        else if (session.type === 'SET_PAYMENT') {
            if(session.step === 'BANK') { session.data.bank=text; session.step='NO'; ctx.reply("Nomor:", cancelBtn); }
            else if(session.step === 'NO') { session.data.no=text; session.step='AN'; ctx.reply("Atas Nama:", cancelBtn); }
            else if(session.step === 'AN') { session.data.an=text; session.step='QR'; ctx.reply("QRIS:", cancelBtn); }
            else if(session.step === 'QR') { await db.collection('settings').doc('payment').set({info:`🏦 ${session.data.bank}\n🔢 ${session.data.no}\n👤 ${session.data.an}`, qris: text==='skip'?'':text}); delete adminSession[userId]; ctx.reply("✅ Saved."); }
            return;
        }
        else if (session.type === 'SET_BG') { 
            const raw = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : text;
            const urls = raw.split(/[\n,]+/).map(u=>u.trim()).filter(u=>u);
            await db.collection('settings').doc('layout').set({ backgroundUrls: urls }, { merge: true }); 
            delete adminSession[userId]; ctx.reply(`✅ Background Diupdate (${urls.length} gambar).`); return; 
        }
        else if (session.type === 'EDIT_MAIN') { 
            if (session.field === 'images') {
                const urls = text.split(/[\n,]+/).map(u=>u.trim()).filter(u=>u);
                await db.collection('products').doc(session.prodId).update({ images: urls, image: urls[0] || "" });
            } else {
                await db.collection('products').doc(session.prodId).update({[session.field]:(session.field.includes('price')||session.field.includes('sold'))?parseInt(text):text}); 
            }
            delete adminSession[userId]; ctx.reply("Updated."); return; 
        }
        // [FIX] BALAS KOMPLAIN MANUAL (UPDATE HISTORY JUGA)
        else if (session.type === 'REPLY_COMPLAIN') { 
            const orderRef = db.collection('orders').doc(session.orderId);
            const docSnap = await orderRef.get();
            
            if (docSnap.exists) {
                const data = docSnap.data();
                const currentHistory = data.chatHistory || [];
                
                // Tambahkan balasan Admin ke History agar muncul di Web User
                const newHistory = [
                    ...currentHistory,
                    { role: 'model', parts: text } // 'model' berarti sisi Admin/AI
                ];

                await orderRef.update({
                    adminReply: text, 
                    complainResolved: true,
                    chatHistory: newHistory // <--- INI KUNCINYA
                }); 
                
                // Notif ke User
                await notifyUser(data.buyerPhone, `👤 *Admin Jie Store Membalas:*\n\n"${text}"`);
            }
            
            delete adminSession[ctx.from.id]; 
            ctx.reply("✅ Balasan terkirim & masuk history chat."); 
            return; 
        }
    }

    // ===============================================
    // 🔍 UNIVERSAL SEARCH (JIKA TIDAK ADA SESI)
    // ===============================================
    if (text) {
        ctx.reply("🔍 Sedang mencari...");

        // A. CEK ORDER ID [UPDATE: Tombol Force Send]
        try {
            const orderSnap = await db.collection('orders').doc(text).get();
            if (orderSnap.exists) {
                const o = orderSnap.data();
                return ctx.reply(
                    `📦 *ORDER ${orderSnap.id}*\nStatus: ${o.status}\nItems: ${o.items.length}\nUser: ${o.buyerPhone}`, 
                    {
                        parse_mode:'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('⚡ PROSES DATA (REVISI OTOMATIS)', `force_send_${orderSnap.id}`)],
                            [Markup.button.callback('🛠 MENU EDIT', `menu_edit_ord_${orderSnap.id}`)],
                            [Markup.button.callback('🗑 HAPUS', `del_order_${orderSnap.id}`)]
                        ])
                    }
                );
            }
        } catch(e){}

        // B. CEK PRODUK
        try {
            const allProds = await db.collection('products').get();
            let found = null;
            allProds.forEach(doc => { 
                const p = doc.data(); 
                if ((p.code && p.code.toLowerCase() === textLower) || (p.name && p.name.toLowerCase().includes(textLower)) || (p.variations && p.variations.some(v => v.code && v.code.toLowerCase() === textLower))) {
                    found = { id: doc.id, ...p };
                }
            });
            if (found) {
                return ctx.reply(`🔎 *${found.name}*\n🏷 Kode: ${found.code}\n💰 Rp ${found.price}`, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✏️ Edit Utama', `menu_edit_main_${found.id}`)],
                        [Markup.button.callback('🔀 ATUR VARIASI', `menu_vars_${found.id}`)],
                        [Markup.button.callback('🗑️ Hapus', `del_prod_${found.id}`)]
                    ])
                });
            }
        } catch(e){}

        // C. CEK USER
        try {
            let foundUser = null;
            let targetUid = null;
            const cleanText = text.trim();

            let userSnap = await db.collection('users').where('email', '==', cleanText).get();
            if (userSnap.empty) userSnap = await db.collection('users').where('email', '==', cleanText.toLowerCase()).get();
            
            if (!userSnap.empty) {
                foundUser = userSnap.docs[0].data();
                targetUid = userSnap.docs[0].id;
            } else {
                const uidDoc = await db.collection('users').doc(cleanText).get();
                if (uidDoc.exists) {
                    foundUser = uidDoc.data();
                    targetUid = uidDoc.id;
                }
            }

            if (foundUser) {
                return ctx.reply(
                    `👤 *USER DITEMUKAN*\n🆔 \`${targetUid}\`\n📧 ${foundUser.email||'Anon'}\n💰 Saldo: Rp ${foundUser.balance?.toLocaleString() || 0}`, 
                    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                        [Markup.button.callback('💵 TAMBAH SALDO', `topup_${targetUid}`)],
                        [Markup.button.callback('💸 POTONG SALDO', `deduct_${targetUid}`)],
                        [Markup.button.callback('🚫 BANNED AKUN', `ban_user_${targetUid}`)]
                    ])}
                );
            }
        } catch(e){}

        ctx.reply("❌ Tidak ditemukan. Ketik 'help' untuk panduan.");
    }
});

// --- ACTION HANDLERS ---
// [BARU] HANDLER TOMBOL MENU BARU
bot.action('menu_notif', (ctx) => { adminSession[ctx.from.id] = {type:'SET_NOTIF'}; ctx.reply("✍️ Kirim Pesan Notifikasi:", cancelBtn); });
bot.action('menu_content', (ctx) => { adminSession[ctx.from.id] = {type:'ADD_CONTENT'}; ctx.reply("✍️ Format: youtube | JUDUL | ID_VIDEO", cancelBtn); });

// [UPDATE]: Handler Upload Stok
bot.action('restock_sheet_ask', (ctx) => { adminSession[ctx.from.id] = { type: 'ASK_SHEET_URL' }; ctx.reply("🔗 Kirim **URL Google Apps Script**:", cancelBtn); });

bot.action('list_pending', async (ctx) => {
    const s = await db.collection('orders').where('status', '==', 'pending').get();
    if (s.empty) return ctx.reply("✅ Aman.");
    const btns = s.docs.map(d => [Markup.button.callback(`🆔 ${d.id.slice(0,5)}... | Rp ${d.data().total}`, `acc_${d.id}`)]);
    ctx.reply("⏳ **PENDING:**", Markup.inlineKeyboard(btns));
});
bot.action('list_all_stock', async (ctx) => {
    ctx.reply("📦 Mendata...");
    const snap = await db.collection('products').get();
    let msg = "📊 **STOK GUDANG**\n\n";
    snap.forEach(doc => {
        const p = doc.data(); msg += `🔹 *${p.name}* (${p.code})\n`;
        if (p.variations) { p.variations.forEach(v => { const c = v.isPermanent?"♾️": (v.content?v.content.split('\n').filter(x=>x.trim()).length:0); msg += `   - ${v.name}: ${c}\n`; }); } 
        else { const c = p.isPermanent?"♾️": (p.content?p.content.split('\n').filter(x=>x.trim()).length:0); msg += `   - Stok: ${c}\n`; }
        msg += "\n";
    });
    if (msg.length > 4000) { const chunks = msg.match(/.{1,4000}/g); for (const c of chunks) await ctx.reply(c, {parse_mode:'Markdown'}); } 
    else ctx.reply(msg, {parse_mode:'Markdown'});
});
bot.action('set_bg', (ctx) => { adminSession[ctx.from.id] = { type: 'SET_BG' }; ctx.reply("🖼 Kirim **URL/GAMBAR (Multi):**", cancelBtn); });
bot.action('manage_users', (ctx) => { ctx.reply("🔍 Ketik langsung **EMAIL** atau **UID** di chat untuk mencari user."); });
bot.action(/^topup_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'TOPUP_USER', targetUid:ctx.match[1]}; ctx.reply("Nominal:", cancelBtn); });
bot.action(/^deduct_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'DEDUCT_USER', targetUid:ctx.match[1]}; ctx.reply("Nominal:", cancelBtn); });
bot.action(/^ban_user_(.+)$/, async (ctx)=>{ await db.collection('users').doc(ctx.match[1]).delete(); ctx.editMessageText("Banned."); });
bot.action('sales_today', async (ctx)=>{ try { ctx.reply("⏳ Hitung..."); const now=new Date(); const start=new Date(now.getFullYear(),now.getMonth(),now.getDate()); const s=await db.collection('orders').orderBy('createdAt','desc').limit(200).get(); let t=0,c=0,i=0; s.forEach(d=>{const dt=d.data(); if(dt.status==='success'){const tm=dt.createdAt.toDate?dt.createdAt.toDate():new Date(dt.createdAt); if(tm>=start){t+=dt.total;c++;dt.items.forEach(x=>i+=x.qty)}}}); ctx.reply(`💰 *HARI INI*\nOmset: ${t.toLocaleString()}\nTrx: ${c}\nItem: ${i}`); } catch(e){ctx.reply("Error.");} }); 
bot.action(/^acc_(.+)$/, async (ctx) => { ctx.reply("Proses..."); const d = await db.collection('orders').doc(ctx.match[1]).get(); if(d.exists) processOrderLogic(ctx.match[1], d.data()); });
bot.action(/^tolak_(.+)$/, async (ctx)=>{ 
    const orderId = ctx.match[1];
    const docRef = db.collection('orders').doc(orderId);
    const snap = await docRef.get();
    
    await docRef.update({status:'failed'}); 
    
    // --- NOTIF BALIK KE USER (DITOLAK) ---
    if(snap.exists) {
        const data = snap.data();
        await notifyUser(data.buyerPhone, `❌ *PESANAN DITOLAK*\n🆔 Order: \`${orderId}\`\nMaaf, pembayaranmu tidak valid atau stok habis.`);
    }
    // ---------------------

    ctx.editMessageText("Ditolak & User dinotifikasi."); 
});
bot.action('list_complain', async (ctx)=>{ const s=await db.collection('orders').where('complain','==',true).where('complainResolved','==',false).get(); if(s.empty)return ctx.reply("Aman"); const b=s.docs.map(d=>[Markup.button.callback(d.id.slice(0,5),`view_comp_${d.id}`)]); ctx.reply("Komplain",Markup.inlineKeyboard(b)); });
bot.action(/^view_comp_(.+)$/, async (ctx)=>{ const d = await db.collection('orders').doc(ctx.match[1]).get(); ctx.reply(`Msg: ${d.data().userComplainText}`, Markup.inlineKeyboard([[Markup.button.callback('BALAS', `reply_comp_${d.id}`), Markup.button.callback('SELESAI', `solve_${d.id}`)]])); });
bot.action(/^reply_comp_(.+)$/, (ctx)=>{ adminSession[ctx.from.id]={type:'REPLY_COMPLAIN', orderId:ctx.match[1]}; ctx.reply("Balasan:", cancelBtn); });
bot.action(/^solve_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).update({complainResolved:true}); ctx.editMessageText("Done."); });
bot.action(/^back_prod_(.+)$/, async (ctx) => { const d = await db.collection('products').doc(ctx.match[1]).get(); const p = d.data(); ctx.editMessageText(`🔎 *${p.name}*`, Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Utama', `menu_edit_main_${d.id}`)],[Markup.button.callback('🔀 ATUR VARIASI', `menu_vars_${d.id}`)],[Markup.button.callback('🗑️ Hapus PRODUK', `del_prod_${d.id}`)]])); });
bot.action(/^del_prod_(.+)$/, async (ctx)=>{ await db.collection('products').doc(ctx.match[1]).delete(); ctx.editMessageText("Dihapus."); });
bot.action(/^del_order_(.+)$/, async (ctx)=>{ await db.collection('orders').doc(ctx.match[1]).delete(); ctx.editMessageText("Dihapus."); });
bot.action('cancel_action', (ctx)=>{ delete adminSession[ctx.from.id]; ctx.reply("Batal."); });
bot.action('add_prod', (ctx)=>{ adminSession[ctx.from.id]={type:'ADD_PROD', step:'NAME', data:{}}; ctx.reply("Nama Produk:", cancelBtn); });
bot.action('set_payment', (ctx)=>{ adminSession[ctx.from.id]={type:'SET_PAYMENT', step:'BANK', data:{}}; ctx.reply("Nama Bank:", cancelBtn); });
// UPDATE EDIT MENU (MULTI IMAGE)
bot.action(/^menu_edit_main_(.+)$/, (ctx) => { const pid = ctx.match[1]; ctx.editMessageText("✏️ *EDIT UTAMA*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ [Markup.button.callback('Nama', `ed_main_name_${pid}`), Markup.button.callback('Harga', `ed_main_price_${pid}`)], [Markup.button.callback('Kode', `ed_main_code_${pid}`), Markup.button.callback('Stok', `ed_main_content_${pid}`)], [Markup.button.callback('Fake Sold', `ed_main_sold_${pid}`), Markup.button.callback('Fake View', `ed_main_view_${pid}`)], [Markup.button.callback('🖼 Gambar (Multi)', `ed_main_images_${pid}`)], [Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)] ])}); });
bot.action(/^ed_main_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_MAIN', prodId: ctx.match[2], field: ctx.match[1] }; ctx.reply(`Nilai Baru:`, cancelBtn); });
// UPDATE VARIASI (ADD BUTTON)
bot.action(/^menu_vars_(.+)$/, async (ctx) => { const pid = ctx.match[1]; const d = await db.collection('products').doc(pid).get(); const vars = d.data().variations || []; const btns = vars.map((v, i) => [Markup.button.callback(`${v.name}`, `sel_var_${pid}_${i}`)]); btns.push([Markup.button.callback('➕ TAMBAH VARIASI', `add_var_${pid}`)]); btns.push([Markup.button.callback('🔙 Kembali', `back_prod_${pid}`)]); ctx.editMessageText("🔀 *VARIASI:*", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) }); });
bot.action(/^add_var_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'ADD_VAR_EXISTING', prodId: ctx.match[1], step: 'NAME' }; ctx.reply("Nama Variasi Baru:", cancelBtn); });
bot.action(/^sel_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const d = await db.collection('products').doc(pid).get(); const v = d.data().variations[idx]; ctx.editMessageText(`🔀 ${v.name}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([ [Markup.button.callback('Nama', `ed_var_name_${pid}_${idx}`), Markup.button.callback('Harga', `ed_var_price_${pid}_${idx}`)], [Markup.button.callback('Stok', `ed_var_content_${pid}_${idx}`)], [Markup.button.callback('🗑️ Hapus', `del_var_${pid}_${idx}`), Markup.button.callback('🔙 List', `menu_vars_${pid}`)] ])}); });
bot.action(/^ed_var_(.+)_(.+)_(.+)$/, (ctx) => { adminSession[ctx.from.id] = { type: 'EDIT_VAR', prodId: ctx.match[2], varIdx: parseInt(ctx.match[3]), field: ctx.match[1] }; ctx.reply(`Nilai Baru:`, cancelBtn); });
bot.action(/^del_var_(.+)_(.+)$/, async (ctx) => { const [_, pid, idx] = ctx.match; const ref = db.collection('products').doc(pid); const s = await ref.get(); let v = s.data().variations; v.splice(parseInt(idx), 1); await ref.update({ variations: v }); ctx.reply("🗑️ Dihapus."); });
// [UPDATE]: Menu Edit Order + Tombol Force Send
bot.action(/^menu_edit_ord_(.+)$/, async (ctx) => { const oid = ctx.match[1]; const doc = await db.collection('orders').doc(oid).get(); const items = doc.data().items; 
    let btns = items.map((item, idx) => [Markup.button.callback(`✏️ EDIT: ${item.name}`, `rev_${oid}_${idx}`)]); 
    btns.push([Markup.button.callback('⚡ PROSES DATA (REVISI OTOMATIS)', `force_send_${oid}`)]);
    ctx.reply(`🛠 Pilih item:`, Markup.inlineKeyboard(btns)); 
});

// [FIX 3]: Handler Tombol Edit (Revisi) dengan Force Reply
bot.action(/^rev_(.+)_(.+)$/, async (ctx)=>{ 
    const orderId = ctx.match[1]; 
    const itemIdx = parseInt(ctx.match[2]); 
    const d = await db.collection('orders').doc(orderId).get(); 
    const item = d.data().items[itemIdx]; 
    const content = item.content || ""; 
    
    let msg = `🔧 *EDIT: ${item.name}*\n\n`; 
    if (content.length > 2000) msg += "👉 Data terlalu panjang (Cek file).\n"; 
    else msg += `Data:\n\`${content}\`\n`;
    
    msg += `\n👉 **SILAKAN REPLY PESAN INI** dengan data akun baru.\nBot akan menimpa slot 'MENUNGGU' dan menambah counter SOLD.`;
    
    adminSession[ctx.from.id] = {type:'REVISI', orderId, itemIdx}; 
    // Force Reply agar keyboard ngetik muncul
    ctx.reply(msg, {parse_mode:'Markdown', reply_markup: { force_reply: true }}); 
});

// [BARU]: HANDLER TOMBOL PAKSA PROSES
bot.action(/^force_send_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.reply(`⏳ Memproses paksa order ${orderId} ke Supplier/Sheet...`);
    const hasil = await forceFulfillOrder(orderId);
    if (hasil.success) await ctx.reply(hasil.msg);
    else await ctx.reply(`❌ GAGAL: ${hasil.msg}`);
});

// BACKUP & IMPORT HANDLER
bot.action('backup_db', async (ctx) => {
    ctx.reply("⏳ Creating backup...");
    const collections = ['products', 'users', 'orders', 'vouchers', 'settings'];
    let backupData = {};
    for (const colName of collections) {
        const snap = await db.collection(colName).get();
        backupData[colName] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    const buffer = Buffer.from(JSON.stringify(backupData, null, 2), 'utf-8');
    ctx.replyWithDocument({ source: buffer, filename: `BACKUP_JIESTORE_${Date.now()}.json` });
});
bot.action('import_db_ask', (ctx) => {
    adminSession[ctx.from.id] = { type: 'IMPORT_DB' };
    ctx.reply("📥 Kirim File JSON Backup:", cancelBtn);
});

app.listen(PORT, () => {
    console.log(`SERVER RUNNING ${PORT}`);
    bot.telegram.deleteWebhook({drop_pending_updates:true}).then(()=>bot.launch());
});
