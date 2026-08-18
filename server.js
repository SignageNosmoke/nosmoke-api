const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
app.use(cors());

// Felles "falske" headers slik at nettbutikken tror vi er en vanlig nettleser
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'no,en-US;q=0.9,en;q=0.8'
};

app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    console.log("----------------------------------");
    console.log("🚀 LYN-SKRAPING STARTET: " + targetUrl);

    try {
        // 1. Hent HTML koden direkte (INGEN NETTLESER = LYNKJAPT!)
        const htmlRes = await fetch(targetUrl, { headers: HEADERS });
        if (!htmlRes.ok) throw new Error(`Fikk HTTP ${htmlRes.status} fra serveren`);
        const html = await htmlRes.text();

        // 2. Hjelpefunksjon for å nappe ut informasjon fra kildekoden
        const extract = (regex, fallback = '') => {
            const match = html.match(regex);
            return match && match[1] ? match[1].trim() : fallback;
        };

        // Finn tittel, bilde og beskrivelse via meta-tags
        let title = extract(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || extract(/<title>([^<]*)<\/title>/i) || 'Nytt produkt';
        title = title.replace(/\s*[-|]\s*Nosmoke.*/i, '').trim();

        const image = extract(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);
        const desc = extract(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);

        // Finn Pris
        let price = '0,-';
        const priceMeta = extract(/<meta[^>]*property=["'](?:product|og):price:amount["'][^>]*content=["']([^"']*)["']/i);
        if (priceMeta) {
            price = Math.round(parseFloat(priceMeta)) + ',-';
        } else {
            const priceMatch = html.match(/class=["'][^"']*(?:price|product-price)[^"']*["'][^>]*>([^<]+)/i);
            if (priceMatch) price = priceMatch[1].replace(/\s/g, '').replace('.', '') + ',-';
        }

        // 3. FINN PRODUKT ID
        const productId = extract(/name=["']products_id["'][^>]*value=["'](\d+)["']/i) 
                       || extract(/data-product-id=["'](\d+)["']/i)
                       || extract(/['"]id['"]\s*:\s*['"](\d{4,8})['"]/i);

        let inStock = true;
        let stockQty = 'Ja';
        let syncFailed = true;

        // 4. DEN MAGISKE LØSNINGEN: Skyt det interne MyStore-API-et direkte fra Node!
        if (productId) {
            console.log("🎯 Fant Produkt-ID: " + productId + " - Kaller skjult API...");
            const apiUrl = new URL('/ajax.php?action=ajax&ajaxfunc=get_remote_stock&products_id=' + productId, targetUrl).href;
            
            const apiRes = await fetch(apiUrl, { headers: HEADERS });
            if (apiRes.ok) {
                const stockJson = await apiRes.json();
                const rawStr = JSON.stringify(stockJson).toLowerCase();

                const osMatch = rawStr.match(/store"[^}]*os[^}]*qty"\s*:\s*"?(\d+)"?/);
                if (osMatch) {
                    const qty = parseInt(osMatch[1]);
                    inStock = qty > 0;
                    stockQty = qty.toString();
                    syncFailed = false;
                    console.log("✅ Lager Os: " + stockQty);
                } else if (rawStr.includes('os')) {
                    inStock = true;
                    stockQty = "Ja";
                    syncFailed = false;
                    console.log("✅ Lager Os: Funnet, men uten tall");
                } else {
                    inStock = false;
                    stockQty = "0";
                    syncFailed = false;
                    console.log("❌ Ikke på lager i Os");
                }
            }
        } else {
            console.log("⚠️ Fant ingen Produkt-ID i kildekoden.");
        }

        res.json({ title, image, desc, price, inStock, stockQty, syncFailed });

    } catch (error) {
        console.error('FEIL:', error.message);
        res.status(500).json({ title: 'Feil ved henting', price: '0,-', inStock: true, syncFailed: true, error: error.message });
    }
});

cron.schedule('0 4 * * *', () => {
    console.log('Nattlig automatisk sjekk starter...');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Lyn-Server kjører på port ${PORT}`));
