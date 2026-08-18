const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');

const app = express();
app.use(cors());

// Hjelpefunksjon for selve skrapingen
async function scrapeProduct(targetUrl) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote']
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(resolve => setTimeout(resolve, 3000));

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

            // FORBEDRET METODE FOR Å FINNE PRODUKT-ID
            let productId = null;
            const hiddenInput = document.querySelector('input[name="products_id"], input[name="product_id"]');
            
            if (hiddenInput && hiddenInput.value) {
                productId = hiddenInput.value;
            } else {
                const htmlContent = document.documentElement.innerHTML;
                const idRegexes = [
                    /name=["']products_id["'][^>]*value=["'](\d+)["']/i,
                    /value=["'](\d+)["'][^>]*name=["']products_id["']/i,
                    /data-product-id=["'](\d+)["']/i,
                    /["']?product_id["']?\s*:\s*["']?(\d+)["']?/i,
                    /['"]id['"]\s*:\s*['"](\d{4,8})['"]/i
                ];
                for (let rx of idRegexes) {
                    const match = htmlContent.match(rx);
                    if (match && match[1] && match[1].length < 10) {
                        productId = match[1];
                        break;
                    }
                }
            }

            let inStock = true;
            let stockQty = 'Ja';
            let syncFailed = false;

            if (productId) {
                try {
                    const apiRes = await fetch('/ajax.php?action=ajax&ajaxfunc=get_remote_stock&products_id=' + productId);
                    if (apiRes.ok) {
                        const stockJson = await apiRes.json();
                        let osFound = false;
                        
                        // FIKSET LOOP: Sjekker samtlige butikker i listen for å finne 'Os'
                        for (let key in stockJson) {
                            const storeArray = stockJson[key];
                            if (Array.isArray(storeArray)) {
                                for (let i = 0; i < storeArray.length; i++) {
                                    const details = storeArray[i];
                                    if (details && details.store && details.store.toLowerCase() === 'os') {
                                        const qty = parseInt(details.qty);
                                        inStock = qty > 0;
                                        stockQty = qty.toString();
                                        osFound = true;
                                        break;
                                    }
                                }
                            }
                            if (osFound) break;
                        }
                        
                        if (!osFound) {
                            inStock = false;
                            stockQty = "0";
                        }
                    } else {
                        syncFailed = true;
                    }
                } catch (e) {
                    syncFailed = true;
                }
            } else {
                syncFailed = true;
            }

            return { title, image, desc, price, inStock, stockQty, syncFailed };
        });

        await browser.close();
        return productData;

    } catch (error) {
        if (browser) await browser.close();
        console.error('Skrapefeil:', error.message);
        return { title: 'Feil ved henting', price: '0,-', inStock: true, syncFailed: true, error: error.message };
    }
}

// API-endepunktet du bruker fra dashbordet
app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });
    const data = await scrapeProduct(targetUrl);
    res.json(data);
});

// Nattlig automatisk sjekk for tidsstyrt lagerstyring
cron.schedule('0 4 * * *', async () => {
    console.log('Nattlig automatisk sjekk starter...');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
