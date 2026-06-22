# Troubleshooting

Common issues when scraping and how to fix them.

## API Interception Returns Nothing

**Symptoms:** `apiResponses` array is empty after navigation.

**Causes:**
- No JSON API calls on the page (static HTML site)
- API calls happened before the response listener was registered
- Content-Type header doesn't include "json" (some APIs use `text/html`)

**Fixes:**
1. Check if data is in SSR state (`window.__NUXT__` / `window.__NEXT_DATA__`)
2. Register the listener earlier (before `context.newPage()` if possible)
3. Broaden content-type: add `'javascript'` and `'html'` to the check
4. Fall back to DOM parsing

## Page Redirects to Login

**Symptoms:** `page.url()` contains `/login` or `/passport` after navigation.

**Causes:**
- Session cookie expired
- Site requires authentication for this endpoint
- Anti-detection failed — site serves captcha disguised as login

**Fixes:**
1. Load saved cookies via `context` storageState option:
   ```js
   const storageState = JSON.parse(fs.readFileSync('cookies.json', 'utf-8'));
   const context = await browser.newContext({ storageState });
   ```
2. Check if the page genuinely needs auth — report to user
3. Strengthen anti-detection (see `references/anti-detection.md`)

## Recursive Mining Finds Nothing

**Symptoms:** `searchForItems()` returns empty array but DevTools shows data.

**Causes:**
- Data is nested under a key not in the `dataKeys` list
- Item structure doesn't match the `hasId + hasTitle/hasPrice` heuristic
- Depth limit (10) reached before finding data

**Fixes:**
1. Dump the top-level keys to see the actual structure:
   ```js
   console.log('Top keys:', Object.keys(data));
   ```
2. Add the missing key to `dataKeys`
3. Broaden the heuristic — check more field name variants in `idFields`/`titleFields`/`priceFields`
4. Increase depth limit (rarely needed; deeper nesting usually means wrong key)

## Browser Context Leak

**Symptoms:** Memory usage grows over time, process list shows many
`chrome-headless-shell` instances.

**Causes:** Browser context not closed in error paths.

**Fix:** Always use try/finally:
```js
let context;
try {
  context = await browser.newContext({...});
  // ... scraping logic ...
} finally {
  if (context) await context.close().catch(() => {});
}
```

## Site Blocks After a Few Requests

**Symptoms:** First few pages work, then HTTP 403 or captcha appears.

**Causes:** Rate limiting or behavioral detection (too fast, too predictable).

**Fixes:**
1. Add random delays between navigations:
   ```js
   await page.waitForTimeout(1000 + Math.random() * 2000);
   ```
2. Rotate user agents
3. Use separate browser contexts per site
4. Reduce concurrent requests

## DOM Parsing Returns Wrong Data

**Symptoms:** Extracted data has wrong prices, empty titles, or wrong items mixed in.

**Causes:**
- Site structure changed since selectors were written
- Noise text (ads, recommendations, coupons) mixed with product data
- Price format changed (added decimals, changed currency symbol)

**Fixes:**
1. Use multiple selector strategies with fallbacks (Tier 1 → Tier 2 → Tier 3)
2. Clean noise text with regex before extraction:
   ```js
   text = text.replace(/￥0\.00满.*?(?=￥|$)/g, '');  // coupon noise
   text = text.replace(/可膨胀券\d+张/g, '');           // ad banners
   ```
3. Make price regex flexible: `/[¥￥$]\s*([\d,.]+)/`
4. Always validate: price in 50-50000 range, title length > 5 chars

## Chinese Encoding Issues

**Symptoms:** Garbled text in extracted data.

**Fix:** Always set locale when creating context:
```js
const context = await browser.newContext({ locale: 'zh-CN' });
```

## Price Field is Suspiciously Large

**Symptom:** All prices are 100x what you expect (e.g., 5000000 instead of 50000).

**Fix:** The platform stores prices in cents/fen. Divide by 100:
```js
if (price > 500000) price = price / 100;
```
This is already handled by `normalizePrice()` in `scripts/api-interceptor.js`.
