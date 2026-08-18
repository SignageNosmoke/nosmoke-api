const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');

const app = express();
app.use(cors());

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
        await new Promise(resolve => setTimeout(resolve, 4000));

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
            let syncFailed = true; // Starter som 'true' frem til vi garantert finner et tall

            // METODE 1: Det skjulte API-et
            if (productId) {
                try {
                    const fetchUrl = window.location.origin + '/ajax.php?action=ajax&ajaxfunc=get_remote_stock&products_id=' + productId + '&product_id=' + productId;
                    const apiRes = await fetch(fetchUrl);
                    if (apiRes.ok) {
                        const stockJson = await apiRes.json();
                        const rawStr = JSON.stringify(stockJson).toLowerCase();
                        
                        // Søker etter 'os' uansett hvordan MyStore formaterer koden
                        if (rawStr.includes('"os"')) {
                            const match = rawStr.match(/"os"[^}]*"qty"\s*:\s*"?(\d+)"?/);
                            if (match) {
                                const qty = parseInt(match[1]);
                                inStock = qty > 0;
                                stockQty = qty.toString();
                                syncFailed = false; // Suksess!
                            } else {
                                inStock = true;
                                stockQty = "Ja";
                                syncFailed = false;
                            }
                        }
                    }
                } catch (e) {
                    // Ignorer og gå videre til Metode 2
                }
            }

            // METODE 2: Visuell skraping (Hvis API-et feilet eller manglet ID)
            if (syncFailed) {
                // Robot-øynene leter spesifikt etter ordet "Os" på skjermen
                const osTag = Array.from(document.querySelectorAll('b, span, div, td, th, li')).find(el => el.textContent.trim().toLowerCase() === 'os');
                if (osTag) {
                    let container = osTag.parentElement;
                    let levels = 0;
                    let fullText = "";

                    while (container && levels < 5) {
                        fullText = container.textContent.toLowerCase();
                        if (fullText.includes('utsolgt') || fullText.includes('0 på lager') || fullText.includes('ikke på lager')) {
                            inStock = false;
                            stockQty = "0";
                            syncFailed = false;
                            break;
                        }
                        container = container.parentElement;
                        levels++;
                    }

                    if (inStock && fullText) {
                        const numMatch = fullText.match(/(\d+)\s*(?:på lager|stk)/i);
                        if (numMatch) {
                            stockQty = numMatch[1];
                            syncFailed = false;
                        } else if (fullText.includes('på lager')) {
                            stockQty = "Ja";
                            syncFailed = false;
                        }
                    }
                } 
                // Siste utvei: Sjekk om hele varen generelt er utsolgt
                else {
                    const outOfStockEl = document.querySelector('.out-of-stock, .sold-out, [disabled="disabled"]');
                    if (outOfStockEl && outOfStockEl.innerText && outOfStockEl.innerText.toLowerCase().includes('utsolgt')) {
                        inStock = false;
                        stockQty = "0";
                        syncFailed = false;
                    } else {
                        const stockTextEl = Array.from(document.querySelectorAll('div, span, p')).find(el => el.textContent.match(/(\d+)\s*På lager/i));
                        if (stockTextEl) {
                            const m = stockTextEl.textContent.match(/(\d+)\s*På lager/i);
                            inStock = true;
                            stockQty = m[1];
                            syncFailed = false;
                        }
                    }
                }
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

app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });
    const data = await scrapeProduct(targetUrl);
    res.json(data);
});

cron.schedule('0 4 * * *', async () => {
    console.log('Nattlig automatisk sjekk starter...');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
