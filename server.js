const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');

const app = express();
app.use(cors());

let isScraping = false;
const scrapeQueue = [];

async function processQueue() {
    if (isScraping || scrapeQueue.length === 0) return;
    
    isScraping = true;
    const { targetUrl, res } = scrapeQueue.shift();
    
    console.log("----------------------------------");
    console.log(`[DØRVAKT] Slipper inn: ${targetUrl}`);
    console.log(`[DØRVAKT] Personer som fortsatt står i kø: ${scrapeQueue.length}`);
    
    let browser;
    try {
        console.log("2. Starter usynlig nettleser...");
        browser = await puppeteer.launch({
            headless: "new",
            protocolTimeout: 60000,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-gpu'
            ] 
        });
        
        console.log("3. Åpner fane...");
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(30000);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log("4. Laster nettsiden...");
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        console.log("5. Håndterer menyer raskt...");
        await page.evaluate(() => {
            try {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const ageBtn = btns.find(b => b.textContent.toLowerCase().includes('18') || b.textContent.toLowerCase().includes('bekreft'));
                if (ageBtn) ageBtn.click();
                
                setTimeout(() => {
                    const elements = Array.from(document.querySelectorAll('div, span, button'));
                    const drop = elements.find(el => el.textContent.toLowerCase().includes('lagerstatus i butikk'));
                    if (drop) drop.click();
                }, 500);
            } catch(e) {}
        }).catch(() => {});
        
        await new Promise(resolve => setTimeout(resolve, 1500));

        console.log("6. Skanner skjermen...");
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

            const osTags = Array.from(document.querySelectorAll('div, span, td, th, p, li'));
            const osElement = osTags.find(el => el.textContent.trim() === 'Os');
            
            if (osElement) {
                let container = osElement.parentElement;
                let levels = 0;
                let fullText = "";

                while (container && levels < 3) {
                    fullText = container.textContent.toLowerCase();
                    if (fullText.includes('ikke på lager') || fullText.includes('utsolgt') || fullText.includes('0 på lager')) {
                        inStock = false;
                        stockQty = "0";
                        syncFailed = false;
                        break;
                    }
                    container = container.parentElement;
                    levels++;
                }

                if (inStock && fullText && syncFailed) {
                    const numMatch = fullText.match(/os[\s\D]*(\d+)/i) || fullText.match(/(\d+)\s*(?:på lager|stk)/i);
                    if (numMatch) {
                        stockQty = numMatch[1];
                        syncFailed = false;
                    } else {
                        stockQty = "Ja";
                        syncFailed = false;
                    }
                }
            }

            if (syncFailed) {
                let productId = document.body.getAttribute('data-product-id')
                    || document.querySelector('[data-product-id]')?.getAttribute('data-product-id')
                    || document.querySelector('input[name="products_id"]')?.value;

                if (productId) {
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 3000); 
                        
                        const apiRes = await fetch(window.location.origin + '/ajax.php?action=ajax&ajaxfunc=get_remote_stock&products_id=' + productId, {
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);
                        
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
                            }
                        }
                    } catch (e) {}
                }
            }

            return { title, image, desc, price, inStock, stockQty, syncFailed };
        });

        console.log(`8. FERDIG! Resultat: ${productData.stockQty} på lager (Feilet: ${productData.syncFailed})`);
        await browser.close();
        res.json(productData);

    } catch (error) {
        console.error('FEIL under skraping:', error.message);
        if (browser) {
            await browser.close().catch(() => console.log("Kunne ikke lukke nettleser"));
        }
        res.json({ title: 'Tidsavbrudd', price: '0,-', inStock: true, syncFailed: true, error: error.message });
    }

    isScraping = false;
    processQueue();
}

app.get('/scrape', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    scrapeQueue.push({ targetUrl, res });
    console.log(`[NY LENKE MOTATT] Lagt i kø. Total kølengde: ${scrapeQueue.length}`);
    processQueue();
});

cron.schedule('0 4 * * *', () => console.log('Nattlig automatisk sjekk starter...'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
