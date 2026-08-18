const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');

const app = express();
app.use(cors());

app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    console.log("----------------------------------");
    console.log("1. MOTTATT FORESPØRSEL: Starter skraping av: " + targetUrl);
    let browser;

    try {
        console.log("2. Starter nettleser...");
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-gpu'
                // Fjernet --single-process for å unngå at serveren fryser!
            ] 
        });
        
        console.log("3. Åpner fane...");
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log("4. Laster nettsiden til Nosmoke...");
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        console.log("5. Leter etter 18-års knapp...");
        try {
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const ageBtn = btns.find(b => b.textContent.toLowerCase().includes('18') || b.textContent.toLowerCase().includes('bekreft'));
                if (ageBtn) ageBtn.click();
            });
        } catch(e) { console.log("Fant ingen aldersknapp."); }
        await new Promise(resolve => setTimeout(resolve, 1500));

        console.log("6. Trekker ned lager-gardin...");
        try {
            await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('div, span, button'));
                const drop = elements.find(el => el.textContent.toLowerCase().includes('lagerstatus i butikk'));
                if (drop) drop.click();
            });
        } catch(e) { console.log("Fant ikke gardinen."); }
        await new Promise(resolve => setTimeout(resolve, 1500));

        console.log("7. Analyserer innholdet på skjermen...");
        const productData = await page.evaluate(() => {
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

            // Leser rullegardinen visuelt
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

            return { title, image, desc, price, inStock, stockQty, syncFailed };
        });

        console.log("8. FERDIG! Resultat for Os: " + productData.stockQty + " på lager.");
        await browser.close();
        res.json(productData);

    } catch (error) {
        console.error('FEIL:', error.message);
        if (browser) await browser.close();
        res.status(500).json({ title: 'Feil ved henting', price: '0,-', inStock: true, syncFailed: true, error: error.message });
    }
});

cron.schedule('0 4 * * *', async () => {
    console.log('Nattlig automatisk sjekk starter...');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
