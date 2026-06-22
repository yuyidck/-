# Anti-Detection Reference

Techniques to prevent websites from detecting browser automation.
Battle-tested on Chinese platforms with aggressive WAF (Web Application Firewall).

## Minimum Required

Apply BEFORE any navigation. This must be the first thing you do after creating the page:

```js
async function setupAntiDetection(page) {
  await page.addInitScript(() => {
    // 1. Hide webdriver flag (most common detection vector)
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // 2. Fake Chrome runtime (some sites check for this)
    window.chrome = { runtime: {} };

    // 3. Fake plugins array (real browsers have plugins)
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });

    // 4. Fake languages (match your target locale)
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });
}
```

## Browser Launch Arguments

```js
const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',  // Critical
    '--disable-infobars',
    '--disable-dev-shm-usage',
  ],
});
```

Additional flags for tough sites:
```js
'--disable-features=IsolateOrigins,site-per-process',  // Cross-origin iframes
'--disable-web-security',                               // CORS bypass (use with caution)
```

## Context Configuration

Always use a realistic user agent and viewport. The default Playwright UA
contains "HeadlessChrome" which is an instant red flag:

```js
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'zh-CN',
});
```

## Advanced: rebrowser-playwright

For sites with Cloudflare Turnstile, DataDome, or other advanced detection,
use `rebrowser-playwright` instead of vanilla Playwright. It patches detection
at the CDP protocol level — no StealthPlugin needed:

```bash
npm install rebrowser-playwright
```

```js
const { chromium } = require('rebrowser-playwright');
// Built-in CDP patches handle Runtime.enable leaks, navigator overrides, etc.
```

## Detection Symptoms

If you see any of these in the page content, your anti-detection has failed:

| Symptom | Meaning |
|---------|---------|
| `访问被阻` / `您的访问被阻断` | WAF blocked you |
| `人机验证` / `安全验证` / `滑块验证` | CAPTCHA triggered |
| `请输入验证码` | Verification code required |
| HTTP 403 with empty body | Server rejected the request |
| Redirect to `/login` unexpectedly | Session invalid or detection triggered |
| Page loads but has no real content | Shadow-ban (hardest to detect) |

## What NOT to Do

| Don't | Why |
|-------|-----|
| Use default Playwright user agent | Contains "HeadlessChrome" — instant detection |
| Skip `addInitScript` | #1 cause of detection failures |
| Use tiny viewport sizes (e.g., 800x600) | Real users have larger screens |
| Navigate without delays between requests | Bot-like request patterns trigger rate limits |
| Forget `locale: 'zh-CN'` for Chinese sites | Wrong locale = mismatched content, possible redirect |
