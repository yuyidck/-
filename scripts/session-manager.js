// Scrapling — Session Manager (Pattern 13)
// Manual login → save state → headless reuse → health check → auto re-login.
//
// Usage:
//   node session-manager.js login --site xiaohongshu
//   node session-manager.js check --site xiaohongshu
//   node session-manager.js scrape --site xiaohongshu --search "关键词"

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════
// Platform Configs
// ═══════════════════════════════════════════════════════════

const PLATFORMS = {
  xiaohongshu: {
    name: '小红书',
    loginUrl: 'https://www.xiaohongshu.com/explore',
    blockedText: ['登录后推荐', '登录后查看', '扫码'],
    loggedInText: [],
    // Check: body exists, has navigation items, no login prompt
  },
  zhihu: {
    name: '知乎',
    loginUrl: 'https://www.zhihu.com',
    blockedText: ['验证码登录', '密码登录', '登录/注册'],
  },
  taobao: {
    name: '淘宝',
    loginUrl: 'https://www.taobao.com',
    blockedText: ['亲，请登录'],
  },
  jd: {
    name: '京东',
    loginUrl: 'https://www.jd.com',
    blockedText: ['欢迎登录'],
  },
};

// ═══════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════

function statePath(site) {
  return path.join(__dirname, '..', `${site}-state.json`);
}

function loadState(site) {
  const p = statePath(site);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return null;
}

function saveState(site, state) {
  fs.writeFileSync(statePath(site), JSON.stringify(state, null, 2));
  console.log(`✅ State saved: ${state.cookies.length} cookies`);
}

function isSessionValid(state) {
  if (!state?.cookies?.length) return false;
  // Check if any session cookie has expired
  const now = Date.now();
  for (const cookie of state.cookies) {
    if (cookie.expires && cookie.expires * 1000 < now) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// Login Flow
// ═══════════════════════════════════════════════════════════

async function doLogin(site) {
  const config = PLATFORMS[site];
  if (!config) throw new Error(`Unknown site: ${site}. Available: ${Object.keys(PLATFORMS).join(', ')}`);

  console.log(`\n🔑 Opening ${config.name} for login...`);
  console.log('   Scan QR code or enter credentials in the browser window.');
  console.log('   The script will auto-detect when you are logged in.\n');

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Poll for login success
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const body = await page.evaluate(() => (document.body?.innerText || ''));
      const blocked = config.blockedText.some(t => body.includes(t));
      if (!blocked && body.length > 300) {
        const state = await ctx.storageState();
        saveState(site, state);
        await ctx.close();
        await browser.close();
        return state;
      }
    } catch (e) {
      // Browser closed or page crashed
      if (i > 5) break; // Give it a few retries
    }
    if (i % 10 === 0) console.log(`   Waiting... ${i * 2}s`);
  }

  // Timeout — save whatever we have
  console.log('⚠️  Login timeout — saving partial state');
  try {
    const state = await ctx.storageState();
    saveState(site, state + '.partial');
  } catch {}
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  return null;
}

// ═══════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════

async function doCheck(site) {
  const config = PLATFORMS[site] || {};
  const state = loadState(site);
  if (!state) {
    console.log(`❌ ${config.name || site}: No saved state — run login first`);
    return false;
  }

  const valid = isSessionValid(state);
  if (!valid) {
    console.log(`⚠️  ${config.name || site}: Session expired — needs re-login`);
    return false;
  }

  // Verify by accessing the page headlessly
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); window.chrome = { runtime: {} }; });

  try {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const body = await page.evaluate(() => (document.body?.innerText || ''));
    const blocked = config.blockedText.some(t => body.includes(t));
    await ctx.close();
    await browser.close();

    if (blocked) {
      console.log(`⚠️  ${config.name || site}: Not logged in — needs re-login`);
      return false;
    }
    console.log(`✅ ${config.name || site}: Session healthy (${state.cookies.length} cookies)`);
    return true;
  } catch (e) {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log(`❌ ${config.name || site}: Health check failed — ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// Scrape with Session
// ═══════════════════════════════════════════════════════════

async function doScrape(site, searchKeyword) {
  const state = loadState(site);
  if (!state) { console.log('No saved state — run login first'); return []; }
  if (!isSessionValid(state)) { console.log('Session expired — re-login needed'); return []; }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); window.chrome = { runtime: {} }; });

  // Intercept API
  let apiData = null;
  page.on('response', async (r) => {
    try {
      const ct = r.headers()['content-type'] || '';
      if (ct.includes('json') && (r.url().includes('search') || r.url().includes('feed'))) {
        const j = await r.json().catch(() => null);
        if (j?.data?.items && !apiData) apiData = j.data;
      }
    } catch {}
  });

  try {
    // Platform-specific search URLs
    const searchUrls = {
      xiaohongshu: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(searchKeyword)}&source=web_search_result_notes`,
    };
    const url = searchUrls[site] || `https://www.${site}.com/search?q=${encodeURIComponent(searchKeyword)}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(2000);

    if (apiData?.items) {
      console.log(`\n📋 ${searchKeyword}: ${apiData.items.length} results (has_more: ${apiData.has_more})`);
      apiData.items.slice(0, 10).forEach((n, i) => {
        const card = n.note_card || n;
        console.log(`${i + 1}. ${card.display_title?.slice(0, 60) || '(no title)'}`);
        console.log(`   👤 ${card.user?.nickname || '?'} | ❤️ ${card.interact_info?.liked_count || '?'}`);
      });
    }

    // DOM fallback
    const domItems = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('[class*="note"], [class*="card"], [class*="item"]').forEach(e => {
        const t = (e.innerText || '').replace(/\n/g, ' | ').slice(0, 200);
        if (t.length > 30 && !items.includes(t)) items.push(t);
      });
      return items.slice(0, 5);
    });
    if (domItems.length && !apiData) {
      console.log(`\n📋 DOM fallback: ${domItems.length} items`);
      domItems.forEach(t => console.log('  ', t.slice(0, 120)));
    }

    return apiData?.items || domItems;
  } catch (e) {
    console.error('Scrape error:', e.message);
    return [];
  } finally {
    await ctx.close();
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════

if (require.main === module) {
  const [,, cmd, site, ...args] = process.argv;
  (async () => {
    switch (cmd) {
      case 'login':
        await doLogin(site || 'xiaohongshu');
        break;
      case 'check':
        await doCheck(site || 'xiaohongshu');
        break;
      case 'scrape':
        await doScrape(site || 'xiaohongshu', args.join(' ') || '三角洲行动');
        break;
      default:
        console.log('Usage:');
        console.log('  node session-manager.js login --site xiaohongshu');
        console.log('  node session-manager.js check --site xiaohongshu');
        console.log('  node session-manager.js scrape --site xiaohongshu --search "关键词"');
        console.log('');
        console.log('Sites:', Object.keys(PLATFORMS).join(', '));
    }
  })();
}

module.exports = { doLogin, doCheck, doScrape, loadState, saveState, isSessionValid, PLATFORMS };
