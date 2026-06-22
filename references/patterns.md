# Scraping Patterns Reference

Production-proven patterns from Chinese e-commerce platforms (DeltaForce-Monitor project).

## Pattern 1: API Interception (Fastest)

**When:** Site loads data via XHR/fetch returning JSON.

```js
const apiResponses = [];
page.on('response', async (response) => {
  const ct = response.headers()['content-type'] || '';
  if (ct.includes('json')) {
    apiResponses.push(
      response.json().then(json => ({ url: response.url(), json })).catch(() => null)
    );
  }
});

await page.goto(url);
await page.waitForTimeout(2000); // Wait for async API calls to complete
const resolved = (await Promise.all(apiResponses)).filter(Boolean);
```

**Why:** Modern SPAs load data via API calls. Intercepting JSON gives you the cleanest
structured data without any HTML parsing.

## Pattern 2: SSR Data Extraction

**When:** Nuxt.js, Next.js, or Vue SSR framework.

```js
const data = await page.evaluate(() => {
  for (const key of ['__NUXT__', '__NEXT_DATA__', '__INITIAL_STATE__']) {
    try { if (window[key]) return JSON.parse(JSON.stringify(window[key])); } catch {}
  }
  return null;
});
```

**Vue/Nuxt:** `window.__NUXT__` contains the entire page state.
**React/Next:** `window.__NEXT_DATA__` contains `props.pageProps`.
**Generic:** `window.__INITIAL_STATE__` used by some Vue SSR setups.

## Pattern 3: Recursive JSON Mining

**When:** You have a big JSON object but don't know where the data arrays are.

**Key insight:** Walk nested JSON looking for arrays whose first element has
id+title/price fields. Only recurse into keys that look like data containers.

```js
function searchForItems(data, config, depth = 0) {
  if (depth > 10 || !data || typeof data !== 'object') return [];

  if (Array.isArray(data)) {
    // Check if this array looks like data items
    if (data.length > 0 && data[0] && typeof data[0] === 'object') {
      const first = data[0];
      const hasId = config.idFields.some(f => first[f] != null);
      const hasTitle = config.titleFields.some(f => first[f] != null);
      const hasPrice = config.priceFields.some(f => first[f] !== undefined);
      if (hasId && (hasTitle || hasPrice)) {
        return data.map(item => extractItem(item, config)).filter(item => item.id);
      }
    }
    // Not a data array — recurse into each element
    return data.flatMap(el => searchForItems(el, config, depth + 1));
  }

  // Object: only recurse into data-container keys
  const DATA_KEYS = ['list', 'items', 'data', 'product', 'goods',
                     'result', 'records', 'rows', 'state'];
  const results = [];
  for (const key of Object.keys(data)) {
    if (DATA_KEYS.some(k => key.toLowerCase().includes(k))) {
      results.push(...searchForItems(data[key], config, depth + 1));
    }
  }
  return results;
}
```

## Pattern 4: DOM Fallback (Last Resort)

Three tiers, from specific to broad. Only use when API/SSR returned nothing.

**Tier 1 — Attribute selectors (most specific):**
```js
document.querySelectorAll('[productid], [data-id], [data-product]').forEach(card => {
  const pid = card.getAttribute('productid') || card.getAttribute('data-id');
  const text = card.textContent.replace(/\s+/g, ' ').trim();
  // extract price from text, ID from attribute...
});
```

**Tier 2 — Link extraction (broad):**
```js
document.querySelectorAll('a[href*="product"], a[href*="detail"], a[href*="goods"]').forEach(a => {
  const href = a.href;
  const text = a.innerText.replace(/\s+/g, ' ').trim();
  if (text.length < 20) return; // skip short/noise links
  const priceMatch = text.match(/[¥￥$]\s*([\d,.]+)/);
  const idMatch = href.match(/\/([A-Za-z0-9_-]+)(?:\/|\?|$)/);
  // ...
});
```

**Tier 3 — Fallback ID generation (last resort):**
```js
// When no clear ID exists in URL, hash the URL + text
const hash = (href + text).split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) >>> 0, 0);
const id = 'ID' + (hash % 1000000).toString(36);
```

## Pattern 5: Blocked Page Detection

Filter out pages that are login walls, WAF blocks, or captcha challenges:

```js
function isBlocked(title, description, url) {
  const text = `${title || ''} ${description || ''} ${url || ''}`;
  const patterns = [
    /微信登录/, /微信扫码/, /weixin.*login/i,
    /请输入验证码/, /人机验证/, /安全验证/, /滑块验证/,
    /访问被阻/, /您的访问被阻断/, /WAF/i,
    /请先登录/, /请登录/, /立即登录/, /登录后查看/,
    /授权登录/, /oauth/i, /authorize/i,
    /captcha/i, /verify/i, /challenge/i,
  ];
  return patterns.some(p => p.test(text));
}
```

## Pattern 6: Parallel Multi-Source

Run multiple scrapers concurrently, merge results:

```js
async function scrapeAll(browser, sources) {
  const tasks = sources.map(source => (async () => {
    const t0 = Date.now();
    try {
      const result = await scrapeSource(browser, source);
      console.log(`[${source.name}] ${result.length} items in ${Date.now() - t0}ms`);
      return result;
    } catch (err) {
      console.error(`[${source.name}] Failed:`, err.message);
      return [];
    }
  })());
  return (await Promise.all(tasks)).flat();
}
```

## Pattern 7: Price Normalization

Handle different price formats across platforms:

```js
function normalizePrice(price) {
  let num = parseFloat(String(price).replace(/[,，]/g, ''));
  if (!isFinite(num) || num <= 0) return 0;
  // If suspiciously high (>500k), it's probably in cents/fen
  if (num > 500000) num = num / 100;
  // Filter out unrealistic prices
  if (num < 50 || num > 50000) return 0;
  return Math.round(num * 100) / 100;
}
```

## Pattern 8: Deduplication + Lowest Price

When the same item appears from multiple sources (API + SSR), keep the cheapest:

```js
const seen = new Map();
for (const item of allItems) {
  if (!item.id) continue;
  if (item.price < minPrice || item.price > maxPrice) continue;
  const prev = seen.get(item.id);
  if (!prev || item.price < prev.price) {
    seen.set(item.id, item);
  }
}
```

## Pattern 9: Content-Based Filtering

Include only items matching a keyword, exclude items from other categories:

```js
function matchesContent(item, includePattern, excludePattern) {
  const text = `${item.title || ''} ${item.description || ''}`;
  if (includePattern && !includePattern.test(text)) return false;
  if (excludePattern && excludePattern.test(text)) return false;
  return true;
}

// Example: only include "三角洲行动" items, exclude other games
const config = {
  contentFilter: /三角洲|哈夫|烽火/,
  contentExclude: /穿越火线|王者荣耀|和平精英|原神|崩坏/,
};
```

This pattern is critical for marketplaces that list multiple product categories
— without it you'll get irrelevant items mixed in.

## Pattern 10: Media Extraction (Video/Audio/Image)

**When:** Site returns media content (Douyin, YouTube, image galleries).

Unlike product data, media items have `video`, `play_addr`, `cover`, `music` fields.
Extract both metadata AND media URLs in a single pass.

```js
function extractMediaFields(raw, config) {
  const id = String(config.idFields.reduce((v, f) => v || raw[f], null) || '');
  const title = String(config.titleFields.reduce((v, f) => v || raw[f], null) || '');

  // Media URLs: try all known field paths
  const media = {};
  const urlFields = [
    ['video_url',  ['video', 'download_addr', 'url_list', 0],
                   ['video', 'play_addr', 'url_list', 0]],
    ['cover_url',  ['video', 'cover', 'url_list', 0],
                   ['cover', 'url_list', 0]],
    ['music_url',  ['music', 'play_url', 'url_list', 0]],
  ];
  for (const [key, ...paths] of urlFields) {
    for (const path of paths) {
      let val = raw;
      for (const p of path) { val = val?.[p]; if (!val) break; }
      if (typeof val === 'string') { media[key] = val; break; }
    }
  }

  // Stats
  const stats = raw.statistics || raw.stats || {};
  return {
    id, title,
    duration: raw.duration || raw.video?.duration || 0,
    author: raw.author?.nickname || raw.author_name || '',
    likes: stats.digg_count || stats.like_count || 0,
    plays: stats.play_count || stats.view_count || 0,
    ...media,
  };
}
```

## Pattern 11: SPA Click Chain (Navigate → Click → Wait → Extract)

**When:** Site is a SPA where data loads only after user interaction (click, scroll).
Most modern sites (Douyin, Twitter, Instagram) work this way.

```js
// Step 1: Load the SPA shell
await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Step 2: Click triggers a client-side route / API call
const clicked = await page.evaluate(() => {
  // Try attribute selectors first, then generic
  for (const sel of ['[data-e2e="video-card"]', '[class*="card"]', 'a[href*="video"]']) {
    const el = document.querySelector(sel);
    if (el) { el.click(); return sel; }
  }
  return null;
});
if (!clicked) throw new Error('No clickable element found');

// Step 3: Wait for the new data to arrive
// Option A: Wait for URL change (for route-based SPAs)
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(200);
  if (page.url() !== homeUrl) break;
}

// Option B: Wait for specific API response (for modal/overlay SPAs)
await page.waitForTimeout(3000); // Let API responses settle

// Step 4: Extract data from the new state
const apiData = (await Promise.all(apiResponses)).filter(Boolean);
// ... mine apiData with searchForItems ...
```

**Key insight:** SPAs don't reload the page. Data arrives via API calls AFTER user interaction.
The API interceptor must be registered BEFORE Step 1, and you must wait for responses AFTER Step 2.

## Pattern 12: Binary File Download (Video/Image/Audio)

**When:** You have media URLs and need to save files locally.

CDN URLs from Chinese platforms are short-lived (2-5 minutes) and require Referer headers.

```js
const https = require('https');
const http = require('http');
const fs = require('fs');

function downloadFile(url, filePath, referer = '') {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124',
    };
    if (referer) headers['Referer'] = referer;

    const doRequest = (targetUrl) => {
      mod.get(targetUrl, { headers }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const rmod = res.headers.location.startsWith('https') ? https : http;
          rmod.get(res.headers.location, { headers }, (r2) => {
            const file = fs.createWriteStream(filePath);
            r2.pipe(file);
            file.on('finish', () => resolve(filePath));
            file.on('error', reject);
          }).on('error', reject);
          return;
        }
        const file = fs.createWriteStream(filePath);
        res.pipe(file);
        file.on('finish', () => resolve(filePath));
        file.on('error', reject);
      }).on('error', reject);
    };
    doRequest(url);
  });
}
```

**Critical:** CDN URLs from Douyin, Kuaishou, etc. expire within minutes. Download immediately
after extraction. Do NOT store URLs for later use.

## Pattern 13: Session Management (Break Login Walls)

**When:** Site requires login to access content (Xiaohongshu, Zhihu, Taobao, JD).

The same approach as DeltaForce-Monitor's `session.js`: save browser state after
manual login, reuse for headless scraping, monitor expiry, auto re-login.

### Step 1: Manual Login + Save State

```js
// Launch VISIBLE browser — user scans QR code or enters password
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: {width:1280,height:900}, locale:'zh-CN' });
const page = await ctx.newPage();
await page.goto('https://www.xiaohongshu.com/explore');

// Wait for login by polling page content
for (let i = 0; i < 90; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const body = await page.evaluate(() => document.body?.innerText || '');
  if (body.length > 500 && !body.includes('登录后') && !body.includes('扫码')) {
    // Login detected — save state
    const state = await ctx.storageState();
    fs.writeFileSync('./xiaohongshu-state.json', JSON.stringify(state, null, 2));
    console.log('✅ Saved', state.cookies.length, 'cookies');
    break;
  }
}
await ctx.close();
await browser.close();
```

### Step 2: Headless Access with Saved State

```js
const state = JSON.parse(fs.readFileSync('./xiaohongshu-state.json', 'utf-8'));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: state, viewport: {width:1920,height:1080}, locale:'zh-CN' });
const page = await ctx.newPage();
// Now navigate as logged-in user
await page.goto('https://www.xiaohongshu.com/search_result?keyword=关键词');
```

### Step 3: Session Health Check

```js
function isSessionValid(state) {
  // Check if cookies exist and aren't too old
  if (!state.cookies || state.cookies.length === 0) return false;
  // Many platforms use web_session cookie — check it
  const sessionCookie = state.cookies.find(c => c.name.includes('web_session') || c.name.includes('session'));
  if (!sessionCookie) return false;
  // Cookie expires field
  if (sessionCookie.expires && sessionCookie.expires * 1000 < Date.now()) return false;
  return true;
}
```

### Step 4: Keep-Alive (monitor + auto re-login)

```js
// Check session every 10 minutes
setInterval(async () => {
  const state = loadState();
  if (!isSessionValid(state)) {
    console.log('Session expired — needs re-login');
    await doManualLogin(); // Step 1 again
  }
}, 10 * 60 * 1000);
```

### Quick Reference: Login Detection Per Platform

| Platform | Check for | After Login |
|----------|-----------|-------------|
| 小红书 | body has `登录后` or `扫码` | body has `我` (profile) |
| 知乎 | body has `验证码登录` | body has hot topics |
| 淘宝 | body has `亲，请登录` | body has search results |
| 京东 | body has `欢迎登录` | body has product listing |

### Concrete Example: Xiaohongshu Search with Session

Once logged in (state saved), search is straightforward:

```js
const state = JSON.parse(fs.readFileSync('./xiaohongshu-state.json', 'utf-8'));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: state });

// Intercept search API
let searchData = null;
page.on('response', async (r) => {
  if (r.url().includes('search/notes') && (r.headers()['content-type']||'').includes('json')) {
    const j = await r.json().catch(()=>null);
    if (j?.data?.items) searchData = j;
  }
});

// Search + scroll to trigger lazy load
await page.goto('https://www.xiaohongshu.com/search_result?keyword=关键词&source=web_search_result_notes');
await page.waitForTimeout(3000);
await page.evaluate(() => window.scrollTo(0, 2000));

// Extract results: title, author, likes, note_id, type (video/text)
for (const item of searchData.data.items) {
  console.log(item.type, item.display_title, item.user?.nickname, item.interact_info?.liked_count);
}
```

**Known limitation:** Video stream URLs (mp4/m3u8) on Xiaohongshu are not available through any
public API or HTML source. They are fetched by a proprietary player SDK with client-side
signatures. Metadata (title, author, likes, note_id, type) is fully accessible.
