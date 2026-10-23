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

// Dekoder svaret med riktig tegnsett (header, deretter <meta charset>, ellers UTF-8).
// res.text() antar alltid UTF-8, og da blir æ/ø/å til rare tegn hvis siden eller
// en mellomliggende proxy bruker ISO-8859-1.
async function readBody(res) {
    const buf = Buffer.from(await res.arrayBuffer());
    let cs = ((res.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i) || [])[1];
    if (!cs) {
        const head = buf.subarray(0, 4096).toString('latin1');
        cs = ((head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1]) || 'utf-8';
    }
    try { return new TextDecoder(cs.toLowerCase()).decode(buf); }
    catch (e) { return buf.toString('utf8'); }
}

async function fetchHtml(url) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (res.ok) return await readBody(res);
    } catch (e) {
        console.log("Første forsøk feilet");
    }

    try {
        // Cache-Buster! Dette tvinger nettsiden til å glemme det gamle svaret.
        const proxyUrl = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url) + "&nocache=" + Date.now();
        const proxyRes = await fetch(proxyUrl);
        if (proxyRes.ok) return await readBody(proxyRes);
    } catch(e) {
        console.log("Proxy feilet");
    }

    throw new Error("Klarte ikke laste siden");
}

const NAMED = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ',
    oslash:'ø', Oslash:'Ø', aring:'å', Aring:'Å', aelig:'æ', AElig:'Æ',
    eacute:'é', Eacute:'É', egrave:'è', agrave:'à', aacute:'á', oacute:'ó', uuml:'ü', ouml:'ö', auml:'ä',
    ndash:'–', mdash:'—', hellip:'…', laquo:'«', raquo:'»', copy:'©', reg:'®', trade:'™', deg:'°', middot:'·' };

function decodeEntities(str) {
    if (!str) return str;
    // Én runde av gangen, så "&amp;#248;" blir "&#248;" og ikke dobbeltdekodet feil.
    // Gjøres to ganger fordi noen sider dobbeltkoder (&amp;oslash;).
    const once = t => t
        .replace(/&#x([0-9a-f]+);/gi, (m, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return m; } })
        .replace(/&#(\d+);/g, (m, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return m; } })
        .replace(/&([a-z]+);/gi, (m, n) => (n in NAMED ? NAMED[n] : m));
    return once(once(str));
}

function cleanHtmlBlock(raw) {
    return decodeEntities(
        raw
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<li[^>]*>/gi, ' • ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s{3,}/g, '\n\n')
            .trim()
    );
}

// SIKKERHET: uten dette godtok /scrape, /links og /debug-find en HVILKEN
// SOM HELST url-parameter og hentet den rått - dvs. at hvem som helst kunne
// bruke denne serveren som en åpen, anonym proxy mot en vilkårlig nettside
// (kostnad/misbruk på VÅR Render-konto, og risiko for at IP-en vår
// svartelistes av tredjeparter). Nå avvises alt som ikke peker til
// nosmoke.no FØR vi i det hele tatt gjør et fetch-kall.
function isAllowedTargetUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        return host === 'nosmoke.no' || host === 'www.nosmoke.no';
    } catch (e) {
        return false;
    }
}

app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });
    if (!isAllowedTargetUrl(targetUrl)) return res.status(400).json({ error: 'Kun lenker til nosmoke.no er tillatt' });

    console.log("Henter data raskt for:", targetUrl);

    try {
        const html = await fetchHtml(targetUrl);

        const extract = (regex, fallback = '') => {
            const m = html.match(regex);
            return m && m[1] ? m[1].trim() : fallback;
        };

        let title = extract(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || extract(/<title>([^<]*)<\/title>/i) || 'Ukjent produkt';
        title = decodeEntities(title).replace(/\s*[-|]\s*Nosmoke.*/i, '').trim();

        const image = decodeEntities(extract(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i));

        let desc = '';

        // PRESIS METODE (verifisert mot faktisk HTML fra nosmoke.no):
        // UUID-en Mystore genererer for fane-widgeten dukker opp flere
        // steder (href, id, aria-controls, aria-labelledby) - vi plukker
        // den ut av mønsteret "pp_tabs<UUID>__pp_tabs-1".
        const uuidMatch = html.match(/pp_tabs([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__pp_tabs-1/i);

        if (uuidMatch) {
            const uuid = uuidMatch[1];
            const startRegex = new RegExp(
                'id=["\']panel-block--pp_tabs' + uuid + '__pp_tabs-1["\'][\\s\\S]*?<div class=["\']card-body["\']>',
                'i'
            );
            const startMatchResult = html.match(startRegex);

            if (startMatchResult) {
                const afterStart = html.slice(startMatchResult.index + startMatchResult[0].length);

                // Stopp ved FØRSTE tegn av "manufacturer_tab" (dukker opp
                // enten som mobil-accordion-overskrift eller selve
                // Produsent-panelet - uansett hva som kommer først i
                // koden, skal vi stoppe der). Hvis produktet ikke har en
                // Produsent-fane i det hele tatt, faller vi tilbake på et
                // fast tak på 2000 tegn.
                const stopIdx = afterStart.search(/manufacturer_tab/i);
                const rawSection = stopIdx !== -1 ? afterStart.slice(0, stopIdx) : afterStart.slice(0, 2000);
                desc = cleanHtmlBlock(rawSection);
            }
        }

        // FALLBACK: hvis siden ikke bruker denne fane-widgeten i det hele
        // tatt, bruk de gamle, mer generiske mønstrene.
        if (!desc || desc.length < 15) {
            const descBlock = html.match(/(?:id=["'](?:tab-)?description["']|itemprop=["']description["']|class=["'][^"']*product-description[^"']*["'])[^>]*>([\s\S]{50,3000})/i);
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

        // NYTT: les smak og styrke FØR beskrivelsen kuttes til 250 tegn.
        // "Styrke: 14mg/gram" står ofte lenger ned på siden og ble ellers klippet bort.
        // Brukes av etikettsiden (etiketter.html) til å fylle ut E-ink-lappene.
        let smak = '', styrke = '';
        const smakMatch = desc.match(/Smak:\s*([^\n•]+)/i);
        if (smakMatch) smak = smakMatch[1].trim();
        const styrkeMatch = desc.match(/Styrke[^:\n]*:\s*([^\n•]+)/i);
        if (styrkeMatch) styrke = styrkeMatch[1].trim();

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

        res.json({ title, image, desc, price, smak, styrke });

    } catch (error) {
        console.error('FEIL:', error.message);
        res.json({ title: 'Feil ved henting', price: '0,-', error: error.message });
    }
});

app.get('/links', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });
    if (!isAllowedTargetUrl(targetUrl)) return res.status(400).json({ error: 'Kun lenker til nosmoke.no er tillatt' });

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

// =====================================================================
// TØRRKJØRING / SIKKER PRISSJEKK (skriver ingenting, endrer ingenting)
// Beskyttelse mot å bli utestengt av Mystore:
//  - all trafikk mot nosmoke.no går gjennom EN kø med minst GAP_MS mellom hver forespørsel
//  - ingen proxy-omvei her (en blokkering skal synes, ikke skjules)
//  - ved 403/429/5xx stenges ALL utgående trafikk i 6 timer (strømbryter)
//  - svar mellomlagres (sitemap 24 t, produkter 12 t), så samme side hentes ikke to ganger
//  - tak på DAILY_CAP forespørsler per døgn
// =====================================================================
const SITEMAP_URL = process.env.SITEMAP_URL || 'https://www.nosmoke.no/sitemap.xml';
const GAP_MS = 2500;
const DAILY_CAP = 300;
const BLOCK_MS = 6 * 60 * 60 * 1000;
const SITEMAP_TTL = 24 * 60 * 60 * 1000;
const PRODUCT_TTL = 12 * 60 * 60 * 1000;
const MAX_DRYRUN = 5;

let outChain = Promise.resolve();
let lastOut = 0, blockedUntil = 0, blockReason = '';
let dayKey = '', dayCount = 0;
const cache = new Map();

function politeGet(url) {
    const task = async () => {
        if (Date.now() < blockedUntil) throw new Error('Pauset til ' + new Date(blockedUntil).toISOString() + ' (' + blockReason + ')');
        const today = new Date().toISOString().slice(0, 10);
        if (today !== dayKey) { dayKey = today; dayCount = 0; }
        if (dayCount >= DAILY_CAP) throw new Error('Døgngrensen på ' + DAILY_CAP + ' forespørsler er nådd');
        const wait = lastOut + GAP_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastOut = Date.now(); dayCount++;
        const res = await fetch(url, { headers: HEADERS });
        if (res.status === 403 || res.status === 429 || res.status >= 500) {
            blockedUntil = Date.now() + BLOCK_MS; blockReason = 'HTTP ' + res.status;
            throw new Error('Nettstedet svarte HTTP ' + res.status + '. All henting er satt på pause i 6 timer.');
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return readBody(res);
    };
    const p = outChain.then(task);
    outChain = p.catch(() => {});
    return p;
}

async function cachedGet(url, ttl) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < ttl) return { html: hit.html, cached: true, t: hit.t };
    const html = await politeGet(url);
    cache.set(url, { t: Date.now(), html });
    return { html, cached: false, t: Date.now() };
}

function parseLocs(xml) {
    const out = [];
    const re = /<url>([\s\S]*?)<\/url>/gi; let m;
    while ((m = re.exec(xml)) !== null) {
        const loc = (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1];
        const lm = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1] || '';
        if (loc) out.push({ url: decodeEntities(loc), lastmod: lm });
    }
    return out;
}

async function getSitemap() {
    const first = await cachedGet(SITEMAP_URL, SITEMAP_TTL);
    let products = [];
    if (/<sitemapindex/i.test(first.html)) {
        const subs = [...first.html.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(x => decodeEntities(x[1])).slice(0, 10);
        for (const u of subs) {
            if (!isAllowedTargetUrl(u)) continue;
            const sub = await cachedGet(u, SITEMAP_TTL);
            products = products.concat(parseLocs(sub.html));
        }
    } else {
        products = parseLocs(first.html);
    }
    products = products.filter(p => /\/products\//i.test(p.url) && isAllowedTargetUrl(p.url));
    return { products, cached: first.cached, fetchedAt: new Date(first.t).toISOString() };
}

function readPrice(html) {
    const meta = (html.match(/<meta[^>]*property=["'](?:product|og):price:amount["'][^>]*content=["']([^"']*)["']/i) || [])[1];
    if (meta && isFinite(parseFloat(meta))) return Math.round(parseFloat(meta));
    const m = html.match(/class=["'][^"']*(?:price|product-price)[^"']*["'][^>]*>\s*([\d\s\.,]+)/i);
    if (m) { const n = parseFloat(m[1].replace(/\s/g, '').replace('.', '').replace(',', '.')); if (isFinite(n)) return Math.round(n); }
    return null;
}

function readTitle(html) {
    let t = (html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || [])[1]
         || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    return decodeEntities(t).replace(/\s*[-|]\s*Nosmoke.*/i, '').trim();
}

// Åpne i nettleser: /dryrun            -> sitemap (1 forespørsel) + 5 LD-produkter
//                   /dryrun?q=snus&n=3 -> filtrer på tekst i adressen
//                   /dryrun?urls=<url1>,<url2>  -> bestemte produkter (maks 5)
app.get('/dryrun', async (req, res) => {
    const out = { modus: 'TØRRKJØRING - ingenting lagres eller endres', results: [] };
    try {
        const n = Math.min(MAX_DRYRUN, Math.max(1, parseInt(req.query.n, 10) || MAX_DRYRUN));
        const sm = await getSitemap();
        out.sitemap = { produkter: sm.products.length, hentetFraCache: sm.cached, hentet: sm.fetchedAt };
        const lm = new Map(sm.products.map(p => [p.url, p.lastmod]));
        let urls;
        if (req.query.urls) {
            urls = String(req.query.urls).split(',').map(x => x.trim()).filter(Boolean);
        } else {
            const q = String(req.query.q || 'ld-').toLowerCase();
            urls = sm.products.map(p => p.url).filter(u => u.toLowerCase().includes(q));
        }
        urls = urls.filter(u => isAllowedTargetUrl(u) && /\/products\//i.test(u)).slice(0, n);
        out.valgt = urls.length;
        let stopped = false;
        for (const u of urls) {
            if (stopped) { out.results.push({ url: u, ok: false, feil: 'Hoppet over fordi en tidligere henting feilet' }); continue; }
            try {
                const g = await cachedGet(u, PRODUCT_TTL);
                const price = readPrice(g.html), title = readTitle(g.html);
                const flags = [];
                if (price === null) flags.push('fant ikke pris');
                else if (price <= 0) flags.push('pris er 0');
                if (!title) flags.push('fant ikke navn');
                out.results.push({ url: u, ok: flags.length === 0, navn: title, pris: price, sistEndretISitemap: lm.get(u) || '', fraCache: g.cached, advarsler: flags });
            } catch (e) {
                stopped = true;
                out.results.push({ url: u, ok: false, feil: e.message });
            }
        }
        out.forbrukIDag = dayCount + ' av ' + DAILY_CAP;
    } catch (e) {
        out.feil = e.message;
    }
    res.type('json').send(JSON.stringify(out, null, 2));
});

app.get('/status', (req, res) => {
    res.json({
        pauset: Date.now() < blockedUntil, grunn: blockReason,
        pausetTil: blockedUntil ? new Date(blockedUntil).toISOString() : null,
        forbrukIDag: dayCount, dognTak: DAILY_CAP, cacheStorrelse: cache.size
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lynrask server kjører på port ${PORT}`));
