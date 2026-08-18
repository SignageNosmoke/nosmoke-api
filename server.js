const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// Falske headers så MyStore tror vi er en vanlig nettleser
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'no,en-US;q=0.9,en;q=0.8'
};

app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    try {
        console.log("Henter data for:", targetUrl);
        // 1. Hent HTML som ren tekst (lynraskt)
        const response = await fetch(targetUrl, { headers: HEADERS });
        if (!response.ok) throw new Error(`HTTP feil: ${response.status}`);
        
        const html = await response.text();

        const extract = (regex, fallback = '') => {
            const m = html.match(regex);
            return m && m[1] ? m[1].trim() : fallback;
        };

        // 2. Napp ut tittel, bilde, beskrivelse
        let title = extract(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || extract(/<title>([^<]*)<\/title>/i) || 'Ukjent produkt';
        title = title.replace(/\s*[-|]\s*Nosmoke.*/i, '').trim();

        const image = extract(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);
        const desc = extract(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);

        // 3. Napp ut pris
        let price = '0,-';
        const priceMeta = extract(/<meta[^>]*property=["'](?:product|og):price:amount["'][^>]*content=["']([^"']*)["']/i);
        if (priceMeta) {
            price = Math.round(parseFloat(priceMeta)) + ',-';
        } else {
            const priceMatch = html.match(/class=["'][^"']*(?:price|product-price)[^"']*["'][^>]*>\s*([\d\s\.,]+)/i);
            if (priceMatch) price = priceMatch[1].replace(/\s/g, '').replace('.', '') + ',-';
        }

        // 4. Finn produkt-ID for å sjekke lageret
        let productId = extract(/name=["']products_id["'][^>]*value=["'](\d+)["']/i) 
                     || extract(/data-product-id=["'](\d+)["']/i)
                     || extract(/['"]id['"]\s*:\s*['"](\d{4,8})['"]/i);

        let inStock = true;
        let stockQty = 'Ja';
        let syncFailed = true;

        // 5. Skyt API-et direkte for å få lagerstatus for Os
        if (productId) {
            const apiUrl = `https://www.nosmoke.no/ajax.php?action=ajax&ajaxfunc=get_remote_stock&products_id=${productId}`;
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
                } else if (rawStr.includes('os')) {
                    inStock = true;
                    stockQty = "Ja";
                    syncFailed = false;
                } else {
                    inStock = false;
                    stockQty = "0";
                    syncFailed = false;
                }
            }
        }

        res.json({ title, image, desc, price, inStock, stockQty, syncFailed });

    } catch (error) {
        console.error('FEIL:', error.message);
        res.json({ title: 'Systemfeil', price: '0,-', inStock: true, syncFailed: true, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lyn-Server kjører på port ${PORT}`));
