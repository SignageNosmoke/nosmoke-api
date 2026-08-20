/**
 * FERDIG VERSJON — basert på det du fant i DevTools:
 *
 *   POST https://www.nosmoke.no/ajax.php?action=ajax&ajaxfunc=get_remote_stock
 *   Body (form-urlencoded): product_ids=11176
 *
 *   Svar (JSON), én nøkkel per butikk (butikkens mystore-subdomene):
 *   {
 *     "pgvgosas_mystore_no": {
 *       "11176": { "store": "Os", "qty": 5, "stock": {...variant-id: antall...} }
 *     },
 *     "nosmokekrs_mystore_no": {
 *       "11176": { "store": "Kristiansand", "qty": 14, "stock": {...} }
 *     },
 *     ...
 *   }
 *
 * LIM DETTE INN I server.js på Render (nosmoke-api), og kall
 * registerStockRoute(app) der du initialiserer Express-appen din
 * (samme sted du sikkert alt har noe sånt som app.get('/scrape', ...)).
 */

// ---------------------------------------------------------------------
// 1. Finn produkt-ID fra en vanlig nosmoke.no produkt-URL.
//    nosmoke.no sine produktsider inneholder produkt-ID-en i HTML-en
//    (bekreftet: Xros 5-siden inneholder "10958" på denne måten).
// ---------------------------------------------------------------------
async function extractProductId(productUrl) {
  const res = await fetch(productUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NosmokeSignage/1.0)" },
  });
  if (!res.ok) throw new Error("Klarte ikke hente produktsiden (" + res.status + ")");
  const html = await res.text();

  const patterns = [
    /data-product-id=["']?(\d+)["']?/i,
    /"product_id"\s*:\s*(\d+)/i,
    /\bproduct\b[\s\r\n]+(\d+)\b/i, // fallback: fanger mønsteret vi observerte i markdown-dumpen
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  throw new Error("Fant ikke produkt-ID i HTML-en for " + productUrl);
}

// ---------------------------------------------------------------------
// 2. Kall get_remote_stock med POST + form-urlencoded body.
// ---------------------------------------------------------------------
async function fetchRemoteStock(productId) {
  const res = await fetch(
    "https://www.nosmoke.no/ajax.php?action=ajax&ajaxfunc=get_remote_stock",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; NosmokeSignage/1.0)",
        Accept: "application/json",
      },
      body: new URLSearchParams({ product_ids: String(productId) }).toString(),
    }
  );
  if (!res.ok) throw new Error("get_remote_stock svarte " + res.status);
  return res.json();
}

// ---------------------------------------------------------------------
// 3. Finn "Os" (eller hvilken som helst butikk) sitt antall i responsen.
//    Responsen er strukturert som { <mystore-subdomene>: { <productId>: {store, qty, stock} } }
//    så vi går gjennom alle subdomenene og matcher på "store"-navnet,
//    i stedet for å hardkode subdomenenavnet (som kan endres).
// ---------------------------------------------------------------------
function findStoreInResponse(data, productId, storeName) {
  for (const subdomainKey of Object.keys(data)) {
    const entry = data[subdomainKey]?.[productId];
    if (!entry) continue;
    if ((entry.store || "").trim().toLowerCase() === storeName.trim().toLowerCase()) {
      return {
        store: entry.store,
        qty: Number(entry.qty ?? 0),
        inStock: Number(entry.qty ?? 0) > 0,
        variants: entry.stock || {},
        found: true,
      };
    }
  }
  return { store: storeName, qty: 0, inStock: false, variants: {}, found: false };
}

// ---------------------------------------------------------------------
// 4. Enkel cache (5 min) — reduserer antall kall mot nosmoke.no kraftig,
//    siden mange produkter kan synkes samtidig og noen produkter kan
//    stå på skjermen i flere kategorier.
// ---------------------------------------------------------------------
const cache = new Map(); // key: `${productId}` -> { data, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getStockForProduct(productUrl, storeName) {
  const productId = await extractProductId(productUrl);

  let raw = cache.get(productId);
  if (!raw || Date.now() - raw.ts > CACHE_TTL_MS) {
    const data = await fetchRemoteStock(productId);
    raw = { data, ts: Date.now() };
    cache.set(productId, raw);
  }

  return findStoreInResponse(raw.data, productId, storeName);
}

// ---------------------------------------------------------------------
// 5. Express-route
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

// I server.js:
//
//   const { registerStockRoute } = require("./stock-endpoint");
//   registerStockRoute(app);
