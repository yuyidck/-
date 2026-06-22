---
name: scrapling
description: >-
  Scrapes data from websites using Playwright browser automation with API interception,
  SSR data extraction, and DOM fallback strategies. Use when the user asks to "scrape",
  "crawl", "extract data from", "爬取", "抓取", or needs to collect structured data from
  any website. Handles anti-detection, recursive JSON mining, deduplication, and
  blocked-page filtering. Works across Claude Code, Codex CLI, and Gemini CLI.
license: MIT
compatibility: Requires Playwright (npm install playwright). Node.js 18+.
allowed-tools:
  - Bash(npm:*)
  - Bash(node:*)
  - Write
  - Edit
  - Read
  - Glob
  - Grep
tags: [scraping, web-scraping, playwright, data-extraction, automation, crawler]
metadata:
  author: DeltaForce Monitor Team
  version: 1.0.0
---

# Scrapling — Universal Web Scraper

Scrapes structured data from any website by prioritizing the fastest reliable method:
**API interception > SSR data > DOM fallback**. Battle-tested on production Chinese
e-commerce platforms with aggressive anti-bot detection.

## Core Principle

```
API first ──► SSR second ──► DOM last
Intercept      Extract        Parse
JSON responses window.__*     HTML/DOM
(fastest)      (fast)         (slow fallback)
```

## When to Use

- User asks to scrape/crawl/extract data from any website
- Need structured data (products, listings, accounts, prices)
- Site uses JavaScript rendering (SPA/Vue/React/Nuxt)
- Site has anti-bot protection (Cloudflare, WAF, captcha)
- Need to collect data from multiple sources in parallel

**Do NOT use for:**
- Simple static HTML pages → `fetch` + `cheerio` (lighter weight)
- Sites with paid APIs → use their API directly
- One-off single-page screenshots → use Playwright directly

## Quick Start

```bash
npm install playwright
```

Then describe what you want to scrape. The skill handles everything else.

## Workflow

### Step 1: Analyze the Target

Before any code, identify data sources:

1. Browser DevTools → Network tab → filter `json`
2. Navigate to the target page
3. Look for API responses containing listing data
4. Check `window.__NUXT__` or `window.__NEXT_DATA__` in Console

API responses found → use **API Interception**.
SSR data found → use **SSR Extraction**.
Neither → use **DOM Fallback**.

### Step 2: Anti-Detection (ALWAYS first)

See `references/anti-detection.md` for the complete guide.

Minimum required (apply BEFORE navigation):
```js
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  window.chrome = { runtime: {} };
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
});
```

### Step 3: Browser Context

Always use a realistic user agent and viewport:
```js
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'zh-CN',
});
```

### Step 4: API Interception

Register the response listener BEFORE navigation (see `references/patterns.md`):

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
```

### Step 5: Navigate + Collect

```js
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

// Extract SSR data (Nuxt/Next/Vue)
const ssr = await page.evaluate(() => {
  for (const k of ['__NUXT__', '__NEXT_DATA__', '__INITIAL_STATE__']) {
    try { if (window[k]) return JSON.parse(JSON.stringify(window[k])); } catch {}
  }
  return null;
});

// Wait for API responses to settle
await page.waitForTimeout(2000);
const apiData = (await Promise.all(apiResponses)).filter(Boolean);
```

### Step 6: Recursive Data Mining

Use `scripts/api-interceptor.js`. It walks nested JSON objects looking for data
arrays by key pattern matching (`list`, `items`, `data`, `product`, `goods`,
`result`, `records`, `rows`).

### Step 7: Deduplicate + Filter

```js
const seen = new Map();
for (const item of allItems) {
  if (!item.id) continue;
  const prev = seen.get(item.id);
  if (!prev || item.price < prev.price) seen.set(item.id, item);
}
```

Filter blocked content (login pages, WAF, captcha patterns). See `references/patterns.md`
Pattern 5 for the complete blocklist.

### Step 8: Clean Up

```js
finally {
  await context.close();
}
```

## Output Format

```json
[{
  "id": "unique_identifier",
  "title": "item title (max 300 chars)",
  "price": 999.00,
  "description": "item description (max 500 chars)",
  "url": "https://site.com/item/123",
  "source": "platform_name"
}]
```

## Error Handling

| Scenario | Action |
|----------|--------|
| API interception returns nothing | Fall back to SSR extraction |
| SSR data not found | Fall back to DOM parsing |
| DOM parsing returns nothing | Try broader selectors + link extraction |
| Site requires login | Report to user, return empty |
| WAF/CAPTCHA detected | Filter blocked content, return partial results |
| Navigation timeout | Retry once, then return empty array |
| Browser crash | Close context, return empty array |

## Quick Reference

| Task | Pattern |
|------|---------|
| Anti-detection | `addInitScript` before navigation |
| API interception | `page.on('response',...)` before `goto` |
| SSR extraction | `__NUXT__`, `__NEXT_DATA__`, `__INITIAL_STATE__` |
| Recursive mining | Walk objects by key patterns (depth ≤ 10) |
| Deduplication | `Map<string, item>` keyed by ID, keep lowest price |
| Blocked filter | Regex patterns for login/WAF/captcha text |
| Price normalization | If > 500000, divide by 100 (cents→yuan) |
| Content filtering | Regex include/exclude on title+description |
| Parallel scraping | `Promise.all(tasks).flat()` |
| Clean exit | `context.close()` in `finally` block |
| SPA click chain | Navigate → click selector → wait → extract |
| Media extraction | Nested path walking for video/cover/music URLs |
| File download | HTTP redirect-follow + Referer + stream-to-file |
| Session management | Manual login → save state → headless reuse → keep-alive |

## Real-World Examples

`references/patterns.md` contains three production examples:
- **Nuxt.js SPA (pzds.com)** — `window.__NUXT__` + API interception
- **API-heavy SPA (pxb7.com)** — Nested JSON parsing + DOM fallback
- **Douyin video scraping** — SPA click chain → API → media → download
- **Xiaohongshu search** — login session → API interception → 22 notes with metadata

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting anti-detection | Always `addInitScript` BEFORE `page.goto` |
| Not waiting for API responses | `waitForTimeout(2000)` after navigation |
| Parsing HTML when API data exists | Check API interception results first |
| Not deduplicating | Use `Map` with unique ID as key |
| Not filtering blocked pages | Check for login/WAF/captcha text patterns |
| Leaking browser contexts | Always close in `finally` block |
| Too shallow mining depth | Default depth limit 8-10 levels |
| Hardcoded selectors | Try multiple patterns, fall back to broader matches |
