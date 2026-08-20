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
        const proxyUrl = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
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

        // Hent Tittel
        let title = extract(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || extract(/<title>([^<]*)<\/title>/i) || 'Ukjent produkt';
        title = title.replace(/\s*[-|]\s*Nosmoke.*/i, '').trim();

        // Hent Bilde
        const image = extract(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);
        
        let desc = '';
        
        // 1. Let etter strukturert data (JSON-LD) - Dette er det Google leser, og her ligger oftest ekte tekst!
        const jsonLds = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
        if (jsonLds) {
            for (let block of jsonLds) {
                try {
                    const inner = block.match(/>([\s\S]*?)<\/script>/i)[1];
                    const data = JSON.parse(inner);
                    const items = Array.isArray(data) ? data : [data];
                    for (let item of items) {
                        if (item['@type'] === 'Product' && item.description) {
                            desc = item.description;
                            break;
                        }
                    }
                } catch(e) {}
                if (desc) break;
            }
        }

        // 2. Fallback til HTML-blokker på nettsiden hvis JSON-LD feiler
        if (!desc || desc.length < 15) {
            const descRegexes = [
                /<div[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i,
                /<div[^>]*id=["']tab-description["'][^>]*>([\s\S]*?)<\/div>/i,
                /<div[^>]*class=["'][^"']*product-description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
                /<div[^>]*class=["'][^"']*description["'][^>]*>([\s\S]*?)<\/div>/i,
                /<div[^>]*id=["']description["'][^>]*>([\s\S]*?)<\/div>/i
            ];
            
            for (let rx of descRegexes) {
                const match = html.match(rx);
                if (match && match[1]) {
                    desc = match[1]
                        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<\/p>/gi, '\n')
                        .replace(/<[^>]+>/g, '') 
                        .replace(/&nbsp;/gi, ' ')
                        .replace(/\s{2,}/g, ' ') 
                        .trim();
                    if (desc.length > 20) break;
                }
            }
        }

        // 3. Siste kriseløsning: Meta-tagger
        if (!desc || desc.length < 15) {
            desc = extract(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || 
                   extract(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
        }

        // 4. Rens opp teksten (Fjern spam og faste advarsler)
        desc = desc.replace(/\|\s*Norsk nettbutikk.*/i, '')
                   .replace(/Alle varer sendes fra Norge.*/i, '')
                   .replace(/Dette produktet har en aldersbegrensning.*/i, '')
                   .replace(/Etter at du har fullført kjøpet.*/i, '')
                   .replace(/vil du bli bedt om å bekrefte.*/i, '')
                   .trim();

        // 5. Unngå dobbelt opp: Tøm beskrivelsen hvis den bare er det samme som tittelen
        if (desc.toLowerCase().includes(title.toLowerCase()) && desc.length < title.length + 15) {
            desc = ''; 
        }

        // 6. Kutt teksten pent hvis den er kjempelang
        if (desc.length > 350) {
            desc = desc.substring(0, 347) + '...';
        }

        // Hent Pris
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
