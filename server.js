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

function cleanHtmlBlock(raw) {
    return raw
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

        // PRESIS METODE: Nosmoke.no sin fane-widget bruker et generert
        // UUID som binder sammen fane-knappen og selve innholds-panelet.
        // Vi finner UUID-en via aria-controls-attributtet (som alltid
        // peker på det ekte innholds-panelet, "panel-block--pp_tabs<UUID>__pp_tabs-N"),
        // og fanger deretter alt som ligger MELLOM panel-1 (Informasjon)
        // og panel-2 (Produsent) - aldri selve fane-knappene i menyen.
        const uuidMatch = html.match(/aria-controls=["']panel-block--pp_tabs([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__pp_tabs-\d+["']/i);

        if (uuidMatch) {
            const uuid = uuidMatch[1];
            const panelRegex = new RegExp(
                'id=["\']panel-block--pp_tabs' + uuid + '__pp_tabs-1["\'][^>]*>([\\s\\S]*?)id=["\']panel-block--pp_tabs' + uuid + '__pp_tabs-2["\']',
                'i'
            );
            const panelMatch = html.match(panelRegex);
            if (panelMatch && panelMatch[1]) {
                desc = cleanHtmlBlock(panelMatch[1]);
            }
        }

        // FALLBACK: hvis siden ikke bruker denne fane-widgeten i det hele
        // tatt, bruk de gamle, mer generiske mønstrene.
        if (!desc || desc.length < 15) {
            const descBlock = html.match(/(?:id=["'](?:tab-)?description["']|id=["']tab-1["']|itemprop=["']description["']|class=["'][^"']*product-description[^"']*["'])[^>]*>([\s\S]{50,3000})/i);
            if (descBlock && descBlock[1]) {
                desc = cleanHtmlBlock(descBlock[1]);
            }
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

app.get('/links', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    console.log("Skanner kategori for produkter:", targetUrl);

    try {
        const html = await fetchHtml(targetUrl);
        const links = [];

        const regex = /<a[^>]+href=["']([^"']+)["']/gi;
        let match;
        while ((match = regex.exec(html)) !== null) {
            let href = match[1];
            if (href.includes('/products/') || href.includes('/produkt/')) {
                if (!href.startsWith('http')) {
                    href = 'https://www.nosmoke.no' + (href.startsWith('/') ? href : '/' + href);
                }
                if (!links.includes(href)) {
                    links.push(href);
                }
            }
        }
        res.json({ links });
    } catch (error) {
        res.status(500).json({ error: error.message, links: [] });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lynrask server kjører på port ${PORT}`));

// --- MIDLERTIDIG DIAGNOSE-ROUTE ------------------------------------
// Viser 300 tegn før og 2500 tegn etter første treff av et søkeord i
// den rå HTML-en, slik at vi kan se nøyaktig hvordan fane-strukturen
// er bygget opp uten å måtte laste ned hele siden.
//
// Bruk: /debug-find?url=<produkt-url>&term=panel-block--pp_tabs
// (term er valgfri, defaulter til "panel-block--pp_tabs")
app.get('/debug-find', async (req, res) => {
    const { url, term } = req.query;
    if (!url) return res.status(400).send('Mangler url');
    try {
        const html = await fetchHtml(url);
        const searchTerm = term || 'panel-block--pp_tabs';
        const idx = html.indexOf(searchTerm);
        if (idx === -1) {
            return res.send('Fant ikke "' + searchTerm + '" i HTML-en. Total lengde på siden: ' + html.length + ' tegn.');
        }
        const start = Math.max(0, idx - 300);
        const end = Math.min(html.length, idx + 2500);
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(html.slice(start, end));
    } catch (err) {
        res.status(500).send('Feil: ' + err.message);
    }
});
// ---------------------------------------------------------------------
