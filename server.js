const express = require('express');
const cors = require('cors');
const { registerStockRoute } = require('./stock-endpoint'); 

const app = express();
app.use(cors());

registerStockRoute(app); 

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'no,en-US;q=0.9,en;q=0.8'
};

async function fetchHtml(url) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (res.ok) return await res.text();
    } catch (e) {
        console.log("Første forsøk feilet");
    }
    
    try {
        // Cache-Buster! Dette tvinger nettsiden til å glemme det gamle svaret.
        const proxyUrl = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url) + "&nocache=" + Date.now();
        const proxyRes = await fetch(proxyUrl);
        if (proxyRes.ok) return await proxyRes.text();
    } catch(e) {
        console.log("Proxy feilet");
    }
    
    throw new Error("Klarte ikke laste siden");
}

app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    console.log("Henter data raskt for:", targetUrl);

    try {
        const html = await fetchHtml(targetUrl);

        const extract = (regex, fallback = '') => {
            const m = html.match(regex);
            return m && m[1] ? m[1].trim() : fallback;
        };

        let title = extract(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || extract(/<title>([^<]*)<\/title>/i) || 'Ukjent produkt';
        title = title.replace(/\s*[-|]\s*Nosmoke.*/i, '').trim();

        const image = extract(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);
        
        let desc = '';
        
        const descBlock = html.match(/(?:id=["'](?:tab-)?description["']|id=["']tab-1["']|itemprop=["']description["']|class=["'][^"']*product-description[^"']*["'])[^>]*>([\s\S]{50,3000})/i);
        
        if (descBlock && descBlock[1]) {
            desc = descBlock[1]
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ') 
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ') 
                .replace(/<li[^>]*>/gi, ' • ') 
                .replace(/<br\s*\/?>/gi, '\n') 
                .replace(/<\/p>/gi, '\n\n') 
                .replace(/<[^>]+>/g, '') 
                .replace(/&nbsp;/gi, ' ')
                .replace(/\s{3,}/g, '\n\n') 
                .trim();
        }

        if (desc.toLowerCase().startsWith(title.toLowerCase())) {
            desc = desc.substring(title.length).trim();
        }
        
        desc = desc.replace(/^Produktinformasjon:?\s*/i, '').trim();

        if (!desc || desc.length < 15) {
            desc = extract(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || 
                   extract(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i) || '';
        }

        desc = desc.replace(/\|\s*Norsk nettbutikk.*/i, '')
                   .replace(/Alle varer sendes fra Norge.*/i, '')
                   .replace(/Dette produktet har en aldersbegrensning.*/i, '')
                   .trim();

        if (desc.toLowerCase() === title.toLowerCase()) {
            desc = '';
        }

        if (desc.length > 250) {
            desc = desc.substring(0, 247) + '...';
        }

        let price = '0,-';
        const priceMeta = extract(/<meta[^>]*property=["'](?:product|og):price:amount["'][^>]*content=["']([^"']*)["']/i);
        if (priceMeta) {
            price = Math.round(parseFloat(priceMeta)) + ',-';
        } else {
            const priceMatch = html.match(/class=["'][^"']*(?:price|product-price)[^"']*["'][^>]*>\s*([\d\s\.,]+)/i);
            if (priceMatch) price = priceMatch[1].replace(/\s/g, '').replace('.', '') + ',-';
        }

        res.json({ title, image, desc, price });

    } catch (error) {
        console.error('FEIL:', error.message);
        res.json({ title: 'Feil ved henting', price: '0,-', error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lynrask server kjører på port ${PORT}`));
