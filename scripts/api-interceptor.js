// Scrapling — Universal API Response Interceptor
// Standalone: intercepts + mines JSON API responses from any Playwright page.
// Shared by scraper-template.js to avoid code duplication.
//
// Usage:
//   const { interceptApi, mineResponses, deduplicateAndFilter } = require('./api-interceptor');
//   const collector = interceptApi(page);
//   await page.goto(targetUrl);
//   const items = await mineResponses(await collector.wait(), config);
//   const results = deduplicateAndFilter(items);

// ═══════════════════════════════════════════════════════════
// API Response Collector
// ═══════════════════════════════════════════════════════════

/**
 * Set up API response interception on a Playwright page.
 * Returns a collector with .responses array, .wait(), and .clear().
 *
 * @param {import('playwright').Page} page
 * @param {Object} options
 * @param {string[]} options.contentTypes - Content types to intercept (default: ['json', 'javascript'])
 * @param {number} options.maxSize - Max response size in bytes (default: 100000)
 */
function interceptApi(page, options = {}) {
  const { contentTypes = ['json', 'javascript'], maxSize = 100000 } = options;
  const responses = [];

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || '';
      if (!contentTypes.some(t => ct.includes(t))) return;

      // Skip large responses (binary mistakenly served as json)
      const cl = response.headers()['content-length'];
      if (cl && parseInt(cl) > maxSize) return;

      const json = await response.json().catch(() => null);
      if (json) {
        responses.push({
          url: response.url(),
          status: response.status(),
          json,
        });
      }
    } catch {}
  });

  return {
    responses,
    /** Wait for pending responses, then return the collected array */
    async wait(timeoutMs = 3000) {
      await new Promise(r => setTimeout(r, timeoutMs));
      return responses;
    },
    /** Clear collected responses */
    clear() {
      responses.length = 0;
    },
  };
}

// ═══════════════════════════════════════════════════════════
// JSON Mining Engine
// ═══════════════════════════════════════════════════════════

/**
 * Mine structured items from API response JSON objects.
 * Recursively walks nested objects looking for data arrays.
 *
 * @param {Array<{url:string, json:Object}>} apiResponses
 * @param {Object} config
 * @param {string[]} config.idFields - Field names for unique ID
 * @param {string[]} config.titleFields - Field names for title
 * @param {string[]} config.priceFields - Field names for price
 * @param {string[]} config.descFields - Field names for description
 * @param {string[]} config.dataKeys - Key names indicating data containers
 */
function mineResponses(apiResponses, config = {}) {
  const {
    idFields = ['productId', 'product_id', 'id', 'goodsId', 'goodsNo'],
    titleFields = ['title', 'name', 'productName', 'goodsTitle'],
    priceFields = ['price', 'sellingPrice', 'sell_price', 'currentPrice'],
    descFields = ['description', 'desc', 'summary'],
    dataKeys = ['list', 'items', 'data', 'product', 'goods', 'result', 'records', 'rows'],
  } = config;

  const allItems = [];
  for (const { json } of apiResponses) {
    if (!json) continue;
    allItems.push(...searchForItems(json, { idFields, titleFields, priceFields, descFields, dataKeys }));
  }
  return allItems;
}

/**
 * Recursively walk nested JSON, returning any data arrays found.
 * Depth-limited to 10 levels. Only recurses into data-container keys.
 */
function searchForItems(data, config, depth = 0) {
  if (depth > 10 || !data || typeof data !== 'object') return [];

  if (Array.isArray(data)) {
    if (data.length > 0 && data[0] && typeof data[0] === 'object') {
      const first = data[0];
      const hasId = config.idFields.some(f => first[f] != null);
      const hasTitle = config.titleFields.some(f => first[f] != null);
      const hasPrice = config.priceFields.some(f => first[f] !== undefined);

      if (hasId && (hasTitle || hasPrice)) {
        return data.map(item => ({
          id: String(config.idFields.reduce((v, f) => v || item[f], null) || ''),
          title: String(config.titleFields.reduce((v, f) => v || item[f], null) || '').slice(0, 300),
          price: normalizePrice(config.priceFields.reduce((v, f) => v !== undefined ? v : item[f], undefined)),
          description: String(config.descFields.reduce((v, f) => v || item[f], null) || '').slice(0, 500),
          url: item.url || item.link || item.productUrl || '',
        })).filter(item => item.id);
      }
    }
    return data.flatMap(el => searchForItems(el, config, depth + 1));
  }

  const results = [];
  for (const key of Object.keys(data)) {
    if (config.dataKeys.some(k => key.toLowerCase().includes(k))) {
      results.push(...searchForItems(data[key], config, depth + 1));
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════

function normalizePrice(raw) {
  let price = parseFloat(raw || 0);
  if (!isFinite(price) || price <= 0) return 0;
  if (price > 500000) price = price / 100; // cents/fen → yuan
  return Math.round(price * 100) / 100;
}

/**
 * Deduplicate items by ID (keep lowest price), then filter by price range
 * and blocked patterns.
 *
 * @param {Array} items
 * @param {Object} options
 * @param {number} options.minPrice
 * @param {number} options.maxPrice
 * @param {RegExp[]} options.blockedPatterns - Patterns for fake/blocked content
 */
function deduplicateAndFilter(items, options = {}) {
  const { minPrice = 50, maxPrice = 50000, blockedPatterns = [] } = options;

  // Deduplicate (keep lowest price)
  const seen = new Map();
  for (const item of items) {
    if (!item.id) continue;
    if (item.price < minPrice || item.price > maxPrice) continue;
    const prev = seen.get(item.id);
    if (!prev || item.price < prev.price) {
      seen.set(item.id, item);
    }
  }

  // Filter blocked content
  return [...seen.values()].filter(item => {
    if (blockedPatterns.length === 0) return true;
    const text = `${item.title || ''} ${item.description || ''} ${item.url || ''}`;
    return !blockedPatterns.some(p => p.test(text));
  });
}

module.exports = {
  interceptApi,
  mineResponses,
  searchForItems,
  deduplicateAndFilter,
  normalizePrice,
};
