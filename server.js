const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');

const app = express();
app.use(cors());

// --- DØRVAKT / KØ-SYSTEM ---
// Dette sikrer at Render-serveren aldri krasjer (OOM) selv om dashbordet sender mange forespørsler samtidig.
let isScraping = false;
const scrapeQueue = [];

async function processQueue() {
    if (isScraping || scrapeQueue.length === 0) return;
    
    isScraping = true;
    const { targetUrl, res } = scrapeQueue.shift(); // Henter den første i køen
    
    console.log("----------------------------------");
    console.log(`[DØRVAKT] Slipper inn: ${targetUrl}`);
    console.log(`[DØRVAKT] Personer som fortsatt står i kø: ${scrapeQueue.length}`);
    
    let browser;
    try {
        console.log("2. Starter usynlig nettleser...");
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-gpu'
            ] 
        });
        
        console.log("3. Åpner fane...");
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log("4. Laster nettsiden til Nosmoke (Max 45 sek)...");
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        console.log("5. Sjekker 18-års knapp...");
        try {
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const ageBtn = btns.find(b => b.textContent.toLowerCase().includes('18') || b.textContent.toLowerCase().includes('bekreft'));
                if (ageBtn) ageBtn.click();
            });
        } catch(e) {}
        await new Promise(resolve => setTimeout(resolve, 1500));

        console.log("6. Trekker ned lager-gardin...");
        try {
            await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('div, span, button'));
                const drop = elements.find(el => el.textContent.toLowerCase().includes('lagerstatus i butikk'));
                if (drop) drop.click();
            });
        } catch(e) {}
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log("7. Skanner skjermen etter tall...");
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

            // METODE A: Visuell lesing av rullegardinen
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

            // METODE B: Backup API (Hvis gardinen feilet)
            if (syncFailed) {
                let productId = document.body.getAttribute('data-product-id')
                    || document.querySelector('[data-product-id]')?.getAttribute('data-product-id')
                    || document.querySelector('input[name="products_id"]')?.value;

                if (!productId) {
                    const htmlContent = document.documentElement.innerHTML;
                    const idRegexes = [ /products_id["'][^>]*value=["'](\d+)["']/i, /['"]id['"]\s*:\s*['"](\d{4,8})['"]/i ];
                    for (let rx of idRegexes) {
                        const match = htmlContent.match(rx);
                        if (match && match[1]) { productId = match[1]; break; }
                    }
                }

                if (productId) {
                    try {
                        const apiRes = await fetch(window.location.origin + '/ajax.php?action=ajax&ajaxfunc=get_remote_stock&products_id=' + productId);
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
                    } catch (e) {}
                }
            }

            return { title, image, desc, price, inStock, stockQty, syncFailed };
        });

        console.log(`8. FERDIG! Resultat for Os: ${productData.stockQty} på lager (Feilet: ${productData.syncFailed})`);
        await browser.close();
        res.json(productData);

    } catch (error) {
        console.error('FEIL under skraping:', error.message);
        if (browser) await browser.close();
        res.status(500).json({ title: 'Feil ved henting', price: '0,-', inStock: true, syncFailed: true, error: error.message });
    }

    // Når den er helt ferdig med denne lenken, gå videre til neste person i køen
    isScraping = false;
    processQueue();
}

app.get('/scrape', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    // Legger URL-en pent i køen i stedet for å starte med en gang
    scrapeQueue.push({ targetUrl, res });
    console.log(`[NY LENKE MOTATT] Lagt i kø: ${targetUrl}. Total kølengde: ${scrapeQueue.length}`);
    
    // Ber dørvakten sjekke om det er klart til å starte
    processQueue();
});

cron.schedule('0 4 * * *', async () => {
    console.log('Nattlig automatisk sjekk starter...');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
