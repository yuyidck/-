// Scrapling — Universal Web Scraper Template
// Copy this file and customize CONFIG for your target site.
// Run: node scraper-template.js
//
// Extracted from production patterns (DeltaForce-Monitor project).
// Uses api-interceptor.js for shared JSON mining + dedup logic.

// Lazy-load playwright — only required when scrape() is called.
// This lets the module be loaded for inspection/utility functions without playwright installed.
let _chromium = null;
function getChromium() {
  if (!_chromium) {
    _chromium = require('playwright').chromium;
    // For tougher sites, replace with: require('rebrowser-playwright').chromium;
  }
  return _chromium;
}

const {
  interceptApi,
  searchForItems,
  deduplicateAndFilter,
} = require('./api-interceptor');

// ═══════════════════════════════════════════════════════════
// CONFIGURATION — customize for your target site
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  targetUrl: 'https://example.com/listings',
  platform: 'example',

  // Realistic user agent (match your target region)
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // ── JSON Mining ──
  // Keys that indicate data containers (will be recursed into)
  dataKeys: ['list', 'items', 'data', 'product', 'goods', 'result', 'records', 'rows', 'aweme_list', 'feed', 'content'],
  // Field name variants for item detection (add your target site's names)
  idFields: ['productId', 'product_id', 'id', 'goodsId', 'goodsNo', 'aweme_id', 'awemeId'],
  titleFields: ['title', 'name', 'productName', 'goodsTitle', 'desc', 'aweme_desc'],
  priceFields: ['price', 'sellingPrice', 'sell_price', 'currentPrice'],
  descFields: ['description', 'desc', 'summary', 'text'],
  // Media extraction (set to false for e-commerce, true for video/audio sites)
  extractMedia: false,

  // ── Price Filter (ignored if extractMedia=true) ──
  minPrice: 50,
  maxPrice: 50000,

  // ── SPA Interaction (optional) ──
  // Click this CSS selector after page load to trigger data fetch
  clickSelector: null,  // e.g. '[class*=\"video-card\"]'
  // Wait this many ms after click for API responses
  clickWaitMs: 3000,

  // ── SSR Data ──
  ssrKeys: ['__NUXT__', '__NEXT_DATA__', '__INITIAL_STATE__'],

  // ── Blocked Page Detection ──
  blockedPatterns: [
    /登录/, /login/i, /验证码/, /captcha/i, /WAF/i,
    /访问被阻/, /人机验证/, /安全验证/,
  ],

  // ── Content Filter (optional) ──
  // Include only items matching this regex on title+description
  // Example: /三角洲|哈夫|烽火/
  contentFilter: null,
  // Exclude items matching this regex (other categories/games)
  // Example: /穿越火线|王者荣耀|和平精英/
  contentExclude: null,

  // ── DOM Fallback Selectors (customize for your site) ──
  // Attribute selectors tried before link extraction
  domSelectors: ['[productid]', '[data-id]', '[data-product]'],
};

// ═══════════════════════════════════════════════════════════
// ANTI-DETECTION
// ═══════════════════════════════════════════════════════════

async function setupAntiDetection(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });
}

// ═══════════════════════════════════════════════════════════
// SSR EXTRACTION
// ═══════════════════════════════════════════════════════════

async function extractSsrData(page, ssrKeys) {
  return await page.evaluate((keys) => {
    for (const key of keys) {
      try {
        if (window[key]) {
          const data = window[key];
          return typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : data;
        }
      } catch {}
    }
    return null;
  }, ssrKeys);
}

// ═══════════════════════════════════════════════════════════
// CONTENT FILTERING
// ═══════════════════════════════════════════════════════════

function matchesContentFilter(item, include, exclude) {
  const text = `${item.title || ''} ${item.description || ''}`;
  if (include && !include.test(text)) return false;
  if (exclude && exclude.test(text)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════
// DOM FALLBACK — Three tiers from specific to broad
// ═══════════════════════════════════════════════════════════

async function domFallback(page, config) {
  return await page.evaluate((cfg) => {
    const items = [];
    const seen = new Set();

    // ── Tier 1: Attribute selectors (most specific) ──
    for (const sel of cfg.domSelectors) {
      document.querySelectorAll(sel).forEach(card => {
        const pid = card.getAttribute(sel.replace(/[\[\]]/g, '')) || '';
        if (!pid || seen.has(pid)) return;
        seen.add(pid);

        let text = (card.textContent || '').replace(/\s+/g, ' ').trim();
        // Clean noise: coupon text, ad banners, etc.
        text = text.replace(/￥0\.00满.*?(?=￥|$)/g, '');
        text = text.replace(/可膨胀券\d+张/g, '');
        text = text.replace(/适用于:.*?到期/g, '');
        text = text.replace(/\s+/g, ' ').trim();

        const allPrices = [...text.matchAll(/￥(\d+[\d,.]*)/g)]
          .map(m => parseFloat(m[1].replace(/,/g, '')));
        const price = allPrices.length > 0 ? Math.max(...allPrices) : 0;
        if (price < cfg.minPrice || price > cfg.maxPrice) return;

        items.push({
          id: String(pid),
          title: text.slice(0, 300),
          price,
          description: text.slice(0, 500),
          url: `https://example.com/product/${pid}`,
        });
      });
      if (items.length > 0) return; // Found data, stop
    }

    // ── Tier 2: Link extraction (broad) ──
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href || '';
      const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length < 20) return;
      if (seen.has(href)) return;
      seen.add(href);

      const priceMatch = text.match(/[¥￥$]\s*([\d,.]+)/);
      const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;
      if (price < cfg.minPrice || price > cfg.maxPrice) return;

      // Extract ID from URL
      let id = '';
      const idMatch = href.match(/product\/([A-Za-z0-9_-]+)/)
                   || href.match(/detail\/([A-Za-z0-9_-]+)/)
                   || href.match(/\/([A-Za-z0-9_-]+)(?:\/|\?|$)/);
      if (idMatch) {
        id = idMatch[1];
      } else {
        // Tier 3: Fallback ID generation — hash URL + text
        const hash = (href + text).split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) >>> 0, 0);
        id = 'ID' + (hash % 1000000).toString(36);
      }

      items.push({
        id: String(id),
        title: text.slice(0, 300),
        price,
        description: text.slice(0, 500),
        url: href.startsWith('http') ? href : `https://${href}`,
      });
    });

    return items;
  }, config);
}

// ═══════════════════════════════════════════════════════════
// MAIN SCRAPER
// ═══════════════════════════════════════════════════════════

/**
 * Scrape a single website.
 *
 * @param {Object} config - See CONFIG above for all fields.
 * @param {import('playwright').Browser} [sharedBrowser] - Optional pre-launched browser
 *   for multi-source scraping. If omitted, creates and destroys its own browser.
 * @returns {Array<Object>} Array of {id, title, price, description, url, platform}
 */
async function scrape(config, sharedBrowser) {
  const t0 = Date.now();
  const ownsBrowser = !sharedBrowser;

  let browser = sharedBrowser;
  if (ownsBrowser) {
    browser = await getChromium().launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
      ],
    });
  }

  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();
  await setupAntiDetection(page);

  // Register API interceptor BEFORE navigation
  const collector = interceptApi(page);

  try {
    // Navigate
    await page.goto(config.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // ── SPA Click Chain (Pattern 11) ──
    if (config.clickSelector) {
      const clicked = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.click(); return sel; }
        return null;
      }, config.clickSelector);
      if (clicked) {
        console.log('[Scrapling] Clicked:', clicked);
        await page.waitForTimeout(config.clickWaitMs || 3000);
      }
    }

    // Extract SSR data
    const ssrData = await extractSsrData(page, config.ssrKeys);

    // Wait for API responses to settle
    await page.waitForTimeout(2000);
    const apiResponses = await collector.wait(0);
    const filtered = apiResponses.filter(r => r.json);

    console.log(`[Scrapling] SSR: ${ssrData ? 'found' : 'none'}, API responses: ${filtered.length}`);

    // Collect items from all sources
    let allItems = [];

    // Source 1: SSR data
    if (ssrData) {
      allItems = searchForItems(ssrData, config);
    }

    // Source 2: API JSON responses
    for (const { json } of filtered) {
      allItems.push(...searchForItems(json, config));
    }

    // Source 3: DOM fallback (only if nothing found from API/SSR)
    if (allItems.length === 0) {
      console.log('[Scrapling] No API/SSR data — trying DOM fallback...');
      allItems = await domFallback(page, config);
    }

    // Deduplicate + filter
    let results;
    if (config.extractMedia) {
      // Media mode: dedup by id, no price filtering
      const seen = new Set();
      results = allItems.filter(item => {
        if (!item.id || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    } else {
      // Product mode: dedup by id, keep lowest price, filter by price range
      results = deduplicateAndFilter(allItems, {
        minPrice: config.minPrice,
        maxPrice: config.maxPrice,
        blockedPatterns: config.blockedPatterns,
      });
    }

    // Content filter
    results = results.filter(item =>
      matchesContentFilter(item, config.contentFilter, config.contentExclude)
    );

    // Add platform tag
    results = results.map(item => ({ platform: config.platform, ...item }));

    const elapsed = Date.now() - t0;
    console.log(`[${config.platform}] ${results.length} items in ${elapsed}ms`);

    return results;
  } catch (err) {
    console.error(`[${config.platform}] Error:`, err.message);
    return [];
  } finally {
    await context.close();
    if (ownsBrowser) {
      await browser.close();
    }
  }
}

// ═══════════════════════════════════════════════════════════
// MEDIA EXTRACTION (Pattern 10)
// ═══════════════════════════════════════════════════════════

/**
 * Extract media URLs (video/cover/music) from deeply nested JSON.
 * Works on Douyin, Kuaishou, YouTube API responses.
 */
function extractMedia(raw, config = {}) {
  const {
    idFields = ['aweme_id', 'awemeId', 'video_id', 'id'],
    titleFields = ['desc', 'title', 'aweme_desc', 'name'],
  } = config;

  const id = String(idFields.reduce((v, f) => v || raw[f], null) || '');
  const title = String(titleFields.reduce((v, f) => v || raw[f], null) || '');

  // Navigate nested paths to find media URLs
  let videoUrl = '';
  let coverUrl = '';
  let musicUrl = '';
  let duration = 0;
  let author = '';
  let likes = 0;
  let plays = 0;
  let comments = 0;

  // Walk: raw → video → download_addr/play_addr → url_list[0]
  const v = raw.video || {};
  if (v.download_addr?.url_list?.[0]) videoUrl = v.download_addr.url_list[0];
  else if (v.play_addr?.url_list?.[0]) videoUrl = v.play_addr.url_list[0];
  if (v.cover?.url_list?.[0]) coverUrl = v.cover.url_list[0];
  if (v.duration) duration = v.duration;

  const m = raw.music || {};
  if (m.play_url?.url_list?.[0]) musicUrl = m.play_url.url_list[0];

  if (raw.author?.nickname) author = raw.author.nickname;
  else if (raw.author_name) author = raw.author_name;

  const s = raw.statistics || raw.stats || {};
  likes = s.digg_count || s.like_count || 0;
  plays = s.play_count || s.view_count || 0;
  comments = s.comment_count || 0;

  return { id, title, duration, author, likes, plays, comments, videoUrl, coverUrl, musicUrl };
}

// ═══════════════════════════════════════════════════════════
// FILE DOWNLOAD (Pattern 12)
// ═══════════════════════════════════════════════════════════

/**
 * Download a binary file from a URL with Referer header support.
 * CDN URLs from Chinese platforms expire quickly — call this immediately.
 *
 * @param {string} url - The URL to download
 * @param {string} filePath - Where to save
 * @param {string} referer - Referer header (required for Douyin CDN)
 * @returns {Promise<string>} Resolves with filePath on success
 */
function downloadFile(url, filePath, referer = '') {
  const https = require('https');
  const http = require('http');
  const fs = require('fs');

  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124',
    };
    if (referer) headers['Referer'] = referer;

    const doRequest = (targetUrl) => {
      mod.get(targetUrl, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect (CDN common pattern)
          const rmod = res.headers.location.startsWith('https') ? https : http;
          rmod.get(res.headers.location, { headers }, (r2) => {
            const file = fs.createWriteStream(filePath);
            r2.pipe(file);
            file.on('finish', () => {
              const size = fs.statSync(filePath).size;
              console.log(`[Download] ${(size / 1024 / 1024).toFixed(1)}MB → ${filePath}`);
              resolve(filePath);
            });
            file.on('error', reject);
          }).on('error', reject);
          return;
        }
        const file = fs.createWriteStream(filePath);
        res.pipe(file);
        file.on('finish', () => {
          const size = fs.statSync(filePath).size;
          console.log(`[Download] ${(size / 1024 / 1024).toFixed(1)}MB → ${filePath}`);
          resolve(filePath);
        });
        file.on('error', reject);
      }).on('error', reject);
    };
    doRequest(url);
  });
}

// ═══════════════════════════════════════════════════════════
// RUN STANDALONE
// ═══════════════════════════════════════════════════════════

if (require.main === module) {
  scrape(CONFIG)
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { scrape, setupAntiDetection, extractSsrData, domFallback, extractMedia, downloadFile };
