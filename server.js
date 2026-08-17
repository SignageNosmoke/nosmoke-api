const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());
const app = express();
app.use(cors());

app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Mangler URL' });

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        // Går til Nosmoke og venter til alt av Javascript (og lagerstatus) er lastet inn
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        const productData = await page.evaluate(() => {
            let title = document.querySelector("h1")?.innerText || "Nytt produkt";
            title = title.replace(/\s*[-|]\s*Nosmoke.*/i, "").trim();
            
            let image = document.querySelector("meta[property='og:image']")?.content || "";
            let desc = document.querySelector("meta[property='og:description']")?.content || "";
            
            let price = "0,-";
            const priceEl = document.querySelector(".price, .product-price");
            if (priceEl) {
                const match = priceEl.innerText.match(/(\d+[\s\.,]?\d*)/);
                if (match) price = match[0].replace(/\s/g, '').replace('.', '') + ",-";
            }

            let inStock = true;
            let stockQty = "Ja";
            
            // Leter etter "Os" og graver ut tallet
            const osTag = Array.from(document.querySelectorAll('b, span, div')).find(el => el.textContent.trim() === 'Os');
            if (osTag) {
                let container = osTag.parentElement;
                let levels = 0;
                let fullText = "";
                
                while (container && levels < 4) {
                    fullText = container.textContent.toLowerCase();
                    if (fullText.includes('utsolgt') || fullText.includes('0 på lager') || fullText.includes('ikke på lager')) {
                        inStock = false;
                        stockQty = "0";
                        break;
                    }
                    container = container.parentElement;
                    levels++;
                }
                if (inStock && fullText) {
                    const numMatch = fullText.match(/(\d+)\s*(?:på lager|stk)/i);
                    if (numMatch) stockQty = numMatch[1];
                }
            }
            return { title, image, desc, price, inStock, stockQty, syncFailed: false };
        });

        await browser.close();
        res.json(productData);

    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ title: "Feil ved henting", price: "0,-", inStock: true, syncFailed: true });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
