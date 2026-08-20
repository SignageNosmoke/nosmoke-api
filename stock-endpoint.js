/**
 * FERDIG, FORENKLET VERSJON
 *
 * Oppdagelse: produktsidene på nosmoke.no inneholder allerede hele
 * lagerstatusen for ALLE butikker ferdig utfylt i en <script>-tag:
 *
 *   var remote_stock = {stock:{
 *     "nosmokearendal_mystore_no": { "11176": { "store": "Arendal", "qty": 5, "stock": {...} } },
 *     "pgvgosas_mystore_no":       { "11176": { "store": "Os",      "qty": 5, "stock": {...} } },
 *     ...
 *   }};
 *
 * Vi trenger derfor bare ÉTT kall: hent produktsidens HTML, og plukk ut
 * denne JSON-blokken direkte. Ikke noe eget POST-kall mot ajax.php,
 * og ikke noe behov for å finne produkt-ID på forhånd.
 *
 * LIM DETTE INN I stock-endpoint.js på GitHub (erstatt alt), og
 * server.js trenger ingen endring — den bruker allerede
 * require('./stock-endpoint') og registerStockRoute(app).
 */

// ---------------------------------------------------------------------
// 1. Hent produktsiden og plukk ut remote_stock-JSON-blokken.
// ---------------------------------------------------------------------
async function fetchRemoteStockFromProductPage(productUrl) {
  const res = await fetch(productUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NosmokeSignage/1.0)" },
  });
  if (!res.ok) throw new Error("Klarte ikke hente produktsiden (" + res.status + ")");
  const html = await res.text();

  const match = html.match(/var\s+remote_stock\s*=\s*(\{[\s\S]*?\});/);
  if (!match) {
    throw new Error("Fant ikke remote_stock-data på siden " + productUrl);
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (e) {
    throw new Error("Klarte ikke tolke remote_stock-JSON: " + e.message);
  }

  // Strukturen er { stock: { <butikk-subdomene>: { <produktId>: {store, qty, stock} } } }
  return parsed.stock || {};
}

// ---------------------------------------------------------------------
// 2. Finn "Os" (eller hvilken som helst butikk) sitt antall.
//    Vi går gjennom alle butikk-subdomener og alle produkt-ID-er under
//    hver (normalt bare én), og matcher på "store"-navnet.
// ---------------------------------------------------------------------
function findStoreQty(stockData, storeName) {
  for (const subdomainKey of Object.keys(stockData)) {
    const productEntries = stockData[subdomainKey];
    for (const productId of Object.keys(productEntries)) {
      const entry = productEntries[productId];
      if ((entry.store || "").trim().toLowerCase() === storeName.trim().toLowerCase()) {
        const qty = Number(entry.qty ?? 0);
        return {
          store: entry.store,
          qty,
          inStock: qty > 0,
          variants: entry.stock || {},
          found: true,
        };
      }
    }
  }
  return { store: storeName, qty: 0, inStock: false, variants: {}, found: false };
}

// ---------------------------------------------------------------------
// 3. Enkel cache (5 min) — unngår gjentatte kall mot nosmoke.no når
//    flere produkter/kategorier synkes rett etter hverandre.
// ---------------------------------------------------------------------
const cache = new Map(); // key: produktUrl -> { data, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getStockForProduct(productUrl, storeName) {
  let raw = cache.get(productUrl);
  if (!raw || Date.now() - raw.ts > CACHE_TTL_MS) {
    const data = await fetchRemoteStockFromProductPage(productUrl);
    raw = { data, ts: Date.now() };
    cache.set(productUrl, raw);
  }
  return findStoreQty(raw.data, storeName);
}

// ---------------------------------------------------------------------
// 4. Express-route
//    GET /stock?url=<produkt-url>&store=Os
// ---------------------------------------------------------------------
function registerStockRoute(app) {
  app.get("/stock", async (req, res) => {
    const { url, store } = req.query;
    if (!url || !store) {
      return res.status(400).json({ error: "Mangler url eller store" });
    }
    try {
      const result = await getStockForProduct(url, store);
      res.json(result);
    } catch (err) {
      console.error("Lagerstatus-feil:", err.message);
      res.status(500).json({ error: err.message, inStock: null });
    }
  });
}

module.exports = { registerStockRoute };

// I server.js (allerede satt opp, ingen endring nødvendig):
//
//   const { registerStockRoute } = require("./stock-endpoint");
//   registerStockRoute(app);
