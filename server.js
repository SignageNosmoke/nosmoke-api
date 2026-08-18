const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');

const app = express();
app.use(cors());

// Kø-system for å beskytte serveren
let isScraping = false;
const scrapeQueue = [];

async function processQueue() {
    if (isScraping || scrapeQueue.length === 0) return;
    
    isScraping = true;
    const { targetUrl, res } = scrapeQueue.shift();
    
    console.log("----------------------------------");
    console.log(`[KØ] Sjekker: ${targetUrl}`);
    
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        
        const page = await browser.newPage();

        // MAGIEN: Blokkerer alt av bilder, design og unødvendige skript for ekstrem hastighet og null RAM-krasj!
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Laster siden
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 1. Klikker bort 18-års grense
        try {
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const ageBtn = btns.find(b => b.textContent.toLowerCase().includes('18') || b.textContent.toLowerCase().includes('bekreft'));
                if (ageBtn) ageBtn.click();
            });
        } catch(e) {}
        await new Promise(resolve => setTimeout(resolve, 500));

        // 2. Trekker ned "Lagerstatus i butikk"-gardinen
        try {
            await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('div, span, button'));
                const drop = elements.find(el => el.textContent.toLowerCase().includes('lagerstatus i butikk'));
                if (drop) drop.click();
            });
        } catch(e) {}
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 3. Analyserer innholdet
        const productData = await page.evaluate(async () => {
            let title = document.querySelector("meta[property='og:title']")?.content || document.querySelector('h1')?.innerText || 'Nytt produkt';
            title = title.replace(/\s*[-|]\s*Nosmoke.*/i, '').trim();
            
            let image = document.querySelector("meta[property='og:image']")?.content || '';
            let desc = document.querySelector("meta[property='og:description']")?.content || '';
            
            let price = '0,-';
            const priceMeta = document.querySelector("meta[property='product:price:amount']") || document.querySelector("meta[property='og:price:amount']");
            if (priceMeta && priceMeta.content) {
                price = Math.round(parseFloat(priceMeta.content)) + ',-';
            } else {
                const priceEl = document.querySelector('.price, .product-price');
                if (priceEl) {
                    const match = priceEl.innerText.match(/(\d+[\s\.,]?\d*)/);
                    if (match) price = match[0].replace(/\s/g, '').replace('.', '') + ',-';
                }
            }

            let inStock = true;
            let stockQty = 'Ja';
            let syncFailed = true;

            // Leser skjermen etter "Os"
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split('\n').map(l => l.trim());

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line === 'Os' || line.startsWith('Os ')) {
                    const textToInspect = line + " " + (lines[i+1] || "");
                    if (textToInspect.toLowerCase().includes('ikke på lager') || textToInspect.toLowerCase().includes('utsolgt')) {
                        inStock = false;
                        stockQty = "0";
                        syncFailed = false;
                        break;
                    } else {
                        const match = textToInspect.match(/Os\s+(\d+)/i);
                        if (match) {
                            inStock = true;
                            stockQty = match[1];
                            syncFailed = false;
                            break;
                        }
                    }
                }
            }

            // Reservemetode (API) hvis den ikke fant rullegardinen
            if (syncFailed) {
                let productId = document.body.getAttribute('data-product-id')
                    || document.querySelector('[data-product-id]')?.getAttribute('data-product-id')
                    || document.querySelector('input[name="products_id"]')?.value;

                if (productId) {
                    try {
                        const apiRes = await fetch(window.location.origin + '/ajax.php?action=ajax&ajaxfunc=get_remote_stock&products_id=' + productId);
                        if (apiRes.ok) {
                            const stockJson = await apiRes.json();
                            const rawStr = JSON.stringify(stockJson).toLowerCase();

                            const osMatch = rawStr.match(/store"[^}]*os[^}]*qty"\s*:\s*"?(\d+)"?/);
                            if (osMatch) {
                                inStock = parseInt(osMatch[1]) > 0;
                                stockQty = inStock ? osMatch[1] : "0";
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
                    } catch (e) {}
                }
            }

            return { title, image, desc, price, inStock, stockQty, syncFailed };
        });

        console.log(`[SUKSESS] ${productData.title} | Lager: ${productData.stockQty}`);
        await browser.close();
        res.json(productData);

    } catch (error) {
        console.error('[FEIL]', error.message);
        if (browser) await browser.close().catch(()=>{});
        res.status(500).json({ title: 'Feil ved henting', price: '0,-', inStock: true, syncFailed: true, error: error.message });
    }

    isScraping = false;
    processQueue();
}

app.get('/scrape', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    scrapeQueue.push({ targetUrl, res });
    processQueue();
});

cron.schedule('0 4 * * *', () => console.log('Nattlig sjekk starter...'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
