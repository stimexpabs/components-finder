// Loads pages in hidden windows that share the embedded browser's session, so a Google
// consent/CAPTCHA solved in the browser pane also clears it here.
const { BrowserWindow, session } = require('electron');
const { extractGoogleWeb, extractListings, extractProductInfo } = require('./renderer/extractor');
const { storeSearchUrl, templateFrom } = require('./stores');
const { isRelevant } = require('./filters');

const PARTITION = 'persist:finder';
const MAX_WINDOWS = 6;

let active = 0;
const waiting = [];

async function acquire() {
  if (active < MAX_WINDOWS) return void active++;
  await new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (fn) => (typeof fn === 'string' ? fn : `(${fn.toString()})()`);

const BOT_CHECK = /not (a )?bot|just a moment|attention required|captcha|access denied|are you a robot|checking your browser/i;

// Store search page: its product grid, or — when the store jumped straight to a single
// product (one exact match) — that product page. Also reports bot-check pages.
const STORE_SCRIPT = `(() => {
  const extractListings = ${extractListings.toString()};
  const extractProductInfo = ${extractProductInfo.toString()};
  if (${BOT_CHECK}.test(document.title)) return { blocked: true, items: [] };
  // Next results page, when the store links one.
  const nextEl = document.querySelector('link[rel="next"], a[rel="next"], a.next.page-numbers, .pagination .next a, li.next a, ' +
    'a.pagination__next, a.action.next, a[aria-label="Next page" i], a[aria-label="Next" i], a[title="Next" i], a[title="Next Page" i]') ||
    [...document.querySelectorAll('[class*="pagination" i] a, [class*="pager" i] a, nav a')].find((a) => /^\\s*(next|›|»|>)\\s*$/i.test(a.textContent));
  const next = nextEl && /^https?:/.test(nextEl.href) && nextEl.href !== location.href ? nextEl.href : null;
  // No link: a script-driven "next page" / "load more" button (clicked by the crawler).
  const nextBtn = !next && [...document.querySelectorAll('button, [role="button"], a:not([href]), a[href="#"], a[href^="javascript"]')].find((b) =>
    !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.getBoundingClientRect().width > 0 &&
    /^\\s*(next( page)?|load more|show more|view more|›|»)\\s*$/i.test(b.getAttribute('aria-label') || b.textContent || ''));
  document.querySelectorAll('[data-cf-next]').forEach((b) => b.removeAttribute('data-cf-next'));
  if (nextBtn) nextBtn.setAttribute('data-cf-next', '1');
  const items = extractListings();
  if (items.length) return { blocked: false, items, next, nextButton: Boolean(nextBtn) };
  const info = extractProductInfo();
  if (info.priceValue == null) return { blocked: false, items: [] };
  return { blocked: false, items: [{ title: info.title || document.title, link: location.href, price: info.price,
    priceValue: info.priceValue, currency: info.currency, availability: info.availability, stockQty: info.stockQty, mpn: info.mpn }] };
})()`;

// Page scripts for using a site's own search box.
function findSearchBox() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 20 && r.height > 8 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const SEL = 'input[type="search"], input[name="q"], input[name="s"], input[name="search"], input[name="keyword"], ' +
    'input[name="keywords"], input[name="query"], input[name="k"], input[name="search_query"], input[name*="search" i], ' +
    'input[id*="search" i], input[class*="search" i], input[placeholder*="search" i], input[aria-label*="search" i], ' +
    'input[placeholder*="looking for" i], input[placeholder*="shopping for" i], input[placeholder*="find" i]';
  const score = (el) => (el.type === 'search' ? 3 : 0) +
    (/search|find|looking/i.test(`${el.placeholder} ${el.getAttribute('aria-label')}`) ? 2 : 0) +
    (el.closest('header, [role="banner"], [class*="header" i]') ? 1 : 0) - (el.closest('footer') ? 3 : 0);
  const box = [...document.querySelectorAll(SEL)]
    .filter((el) => !el.disabled && !el.readOnly && /^(search|text|)$/i.test(el.getAttribute('type') || '') && visible(el))
    .sort((a, b) => score(b) - score(a))[0];
  if (!box) return false;
  box.setAttribute('data-cf-search', '1');
  box.scrollIntoView({ block: 'center' });
  box.focus();
  box.click();
  box.select?.(); // typing replaces any prefilled text
  return true;
}

// Some sites only show the box after clicking a magnifier icon.
function openSearchToggle() {
  const t = [...document.querySelectorAll('button, a, [role="button"], [class*="search" i]')].find((el) =>
    !el.matches('input, form') && el.getBoundingClientRect().width > 0 &&
    /search/i.test(`${el.getAttribute('aria-label') || ''} ${el.title || ''} ${el.className || ''}`));
  if (!t) return false;
  t.click();
  return true;
}

// Enter did nothing: submit the box's form, or click the button beside it.
function submitSearchBox() {
  const box = document.querySelector('[data-cf-search]');
  if (!box) return false;
  const scope = box.form || box.parentElement?.parentElement || document;
  const btn = scope.querySelector('button[type="submit"], input[type="submit"], button:not([type]), [class*="search" i] button');
  if (btn) btn.click();
  else if (box.form) box.form.requestSubmit ? box.form.requestSubmit() : box.form.submit();
  else return false;
  return true;
}

class BlockedError extends Error {
  constructor(url) {
    super('Google is asking to verify you are not a robot.');
    this.blocked = true;
    this.url = url;
  }
}

function hiddenWindow(images) {
  watchChallenges();
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, images, backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const id = win.webContents.id;
  win.on('closed', () => challengedWindows.delete(id));
  return win;
}

// Read the store's result grid, waiting for script-rendered grids to fill in. An empty
// grid behind a Cloudflare challenge is retried once (like pressing reload), then reported.
async function readStoreResults(win, { retried = false } = {}) {
  const wc = win.webContents;
  let res = await wc.executeJavaScript(STORE_SCRIPT);
  for (let waited = 0; waited < 12000 && !res.blocked && !res.items.length; waited += 2000) {
    await delay(2000);
    res = await wc.executeJavaScript(STORE_SCRIPT);
  }
  if (!res.items.length && challengedWindows.has(wc.id)) {
    if (retried) return { ...res, blocked: true };
    challengedWindows.delete(wc.id);
    wc.reload();
    await delay(1000);
    for (let u = 0; u < 15000 && wc.isLoading(); u += 250) await delay(250);
    await delay(2500);
    return readStoreResults(win, { retried: true });
  }
  return res;
}

// Follow the store's "next page" links: up to `maxPages`, stopping once a page brings
// nothing matching the query (store results drift off-topic further down).
async function readMorePages(win, first, query, maxPages) {
  const wc = win.webContents;
  const key = (i) => i.link || i.title;
  const byKey = new Map(first.items.map((i) => [key(i), i]));
  const seenUrls = new Set([wc.getURL()]);
  let res = first;
  for (let p = 2; p <= maxPages; p++) {
    if (res.next && !seenUrls.has(res.next)) {
      seenUrls.add(res.next);
      await load(win, res.next, 20000);
      await waitOutBotCheck(wc);
      await delay(2000);
    } else if (res.nextButton) {
      // Click it and wait for products we haven't seen ("load more" keeps the old ones).
      await wc.executeJavaScript(`document.querySelector('[data-cf-next]')?.click()`);
      let changed = false;
      for (let t = 0; t < 10000 && !changed; t += 1000) {
        await delay(1000);
        const probe = await wc.executeJavaScript(STORE_SCRIPT);
        changed = probe.items.some((i) => !byKey.has(key(i)));
      }
      if (!changed) break;
      await delay(1000);
    } else {
      break;
    }
    res = await readStoreResults(win, { retried: true });
    const fresh = res.items.filter((i) => !byKey.has(key(i)));
    if (!fresh.length) break;
    for (const i of fresh) byKey.set(key(i), i);
    if (!fresh.some((i) => isRelevant(i.title, query))) break;
  }
  return [...byKey.values()];
}

// Requests Cloudflare answered with a challenge, per window. Some stores (e.g. Robu) load
// their results through a background request that Cloudflare's bot protection may block
// for automated windows: the page then shows "0 results" although the store has many.
// We report that as a bot check for the user to pass in the pane — we don't try to evade it.
const challengedWindows = new Set();
let watchingChallenges = false;
function watchChallenges() {
  if (watchingChallenges) return;
  watchingChallenges = true;
  session.fromPartition(PARTITION).webRequest.onHeadersReceived((d, cb) => {
    if (d.webContentsId && Object.keys(d.responseHeaders || {}).some((k) => k.toLowerCase() === 'cf-mitigated')) {
      challengedWindows.add(d.webContentsId);
    }
    cb({});
  });
}

// Cloudflare-style "Just a moment…" pages usually clear by themselves within a few seconds.
async function waitOutBotCheck(wc, ms = 15000) {
  for (let t = 0; t < ms && BOT_CHECK.test(wc.getTitle()); t += 500) await delay(500);
  for (let u = 0; u < 10000 && wc.isLoading(); u += 250) await delay(250);
}

// Load, but stop waiting at the timeout (slow pages) and carry on with what has rendered.
async function load(win, url, timeout) {
  const loaded = win.loadURL(url).catch((err) => {
    if (!/ERR_ABORTED/.test(err.message)) throw err;
  });
  await Promise.race([loaded, delay(timeout)]);
}

// Load `url` in a throwaway hidden window, wait for it to settle, run `script` in it.
// `isCancelled` lets queued work for an abandoned search be dropped before it starts.
// `retryEmpty`: while the script finds no `items`, re-read the page every 2 s for up to
// this long (slow, script-rendered result grids).
async function runOnPage(url, script, { images = false, settle = 1200, timeout = 20000, retryEmpty = 0, isCancelled = () => false } = {}) {
  await acquire();
  if (isCancelled()) {
    release();
    return null;
  }
  const win = hiddenWindow(images);
  try {
    await load(win, url, timeout);
    await waitOutBotCheck(win.webContents);
    await delay(settle);
    let result = await win.webContents.executeJavaScript(call(script));
    for (let waited = 0; waited < retryEmpty && result && !result.blocked && result.items?.length === 0; waited += 2000) {
      await delay(2000);
      result = await win.webContents.executeJavaScript(call(script));
    }
    // Where redirects (e.g. Google's /goto links) finally landed.
    if (result && typeof result === 'object' && !Array.isArray(result)) result.finalUrl = win.webContents.getURL();
    return result;
  } finally {
    win.destroy();
    release();
  }
}

function googleUrl(query, { page = 0, shopping = false, country = 'us' } = {}) {
  const p = new URLSearchParams({ q: query, hl: 'en', gl: country });
  if (shopping) p.set('udm', '28');
  if (page) p.set('start', String(page * 10));
  return `https://www.google.com/search?${p}`;
}

async function googleWeb(query, page, settings, isCancelled) {
  const url = googleUrl(query, { page, country: settings.country });
  const res = await runOnPage(url, extractGoogleWeb, { settle: 800, isCancelled });
  if (!res) return { items: [], hasMore: false };
  if (res.blocked) throw new BlockedError(url);
  return { items: res.items, hasMore: res.hasNext };
}

async function googleShopping(query, settings, isCancelled) {
  const url = googleUrl(query, { shopping: true, country: settings.country });
  const items = await runOnPage(url, extractListings, { images: true, settle: 2500, isCancelled });
  if (!items) return { items: [], hasMore: false };
  if (!items.length && (await runOnPage(url, extractGoogleWeb, { settle: 0 }))?.blocked) throw new BlockedError(url);
  return { items, hasMore: false };
}

// Search a store: via its search URL when known, otherwise the way a person would —
// open the site, type into its search box, press Enter. Then read the result pages.
// Returns { url, blocked, items, template? } — `template` is the search URL learned from typing.
async function storeSearch(store, query, isCancelled = () => false, { maxPages = 3 } = {}) {
  if (!store.search) return searchViaBox(store.home, query, isCancelled, maxPages);
  const url = storeSearchUrl(store, query);
  await acquire();
  if (isCancelled()) {
    release();
    return { url, blocked: false, items: [] };
  }
  const win = hiddenWindow(true);
  try {
    await load(win, url, 20000);
    await waitOutBotCheck(win.webContents);
    await delay(3000);
    const first = await readStoreResults(win);
    if (first.blocked) return { url, blocked: true, items: [] };
    return { url, blocked: false, items: await readMorePages(win, first, query, maxPages) };
  } finally {
    win.destroy();
    release();
  }
}

async function waitForNavigation(wc, fromUrl, ms) {
  for (let t = 0; t < ms; t += 250) {
    if (wc.getURL() !== fromUrl) {
      for (let u = 0; u < 15000 && wc.isLoading(); u += 250) await delay(250);
      return true;
    }
    await delay(250);
  }
  return false;
}

async function searchViaBox(home, query, isCancelled = () => false, maxPages = 3) {
  await acquire();
  if (isCancelled()) {
    release();
    return { url: home, blocked: false, items: [] };
  }
  const win = hiddenWindow(true);
  const wc = win.webContents;
  const run = (fn) => wc.executeJavaScript(call(fn));
  try {
    await load(win, home, 20000);
    await waitOutBotCheck(wc);
    await delay(2500);
    if (BOT_CHECK.test(wc.getTitle())) {
      return { url: home, blocked: true, items: [] };
    }
    let found = await run(findSearchBox);
    if (!found && (await run(openSearchToggle))) {
      await delay(1000);
      found = await run(findSearchBox);
    }
    if (!found) return { url: home, blocked: false, items: [], error: 'no search box found' };

    // Type it like a person, so sites with script-driven search boxes react.
    const startUrl = wc.getURL();
    for (const ch of query) wc.sendInputEvent({ type: 'char', keyCode: ch });
    await delay(300);
    const typed = await wc.executeJavaScript(`document.querySelector('[data-cf-search]')?.value || ''`);
    if (typed.trim() !== query.trim()) {
      await wc.executeJavaScript(`(() => { const b = document.querySelector('[data-cf-search]'); b.value = ${JSON.stringify(query)};
        b.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    if (!(await waitForNavigation(wc, startUrl, 6000)) && (await run(submitSearchBox))) {
      await waitForNavigation(wc, startUrl, 8000);
    }
    await waitOutBotCheck(wc);
    await delay(2500);
    const url = wc.getURL();
    const template = templateFrom(url, query);
    const first = await readStoreResults(win);
    if (first.blocked) return { url, blocked: true, items: [], template };
    return { url, blocked: false, items: await readMorePages(win, first, query, maxPages), template };
  } finally {
    win.destroy();
    release();
  }
}

function productInfo(url, isCancelled) {
  return runOnPage(url, extractProductInfo, { settle: 1500, timeout: 15000, isCancelled });
}

// Results from a search engine's page that point to `host` (DuckDuckGo's HTML version, or a
// generic fallback), plus whether there's a "Next" button. Runs in the page.
const ENGINE_SCRIPT = (host) => `(() => {
  const host = ${JSON.stringify(host)};
  const unwrap = (h) => {
    try {
      const u = new URL(h, location.href);
      return u.searchParams.get('uddg') || u.href;
    } catch { return null; }
  };
  const onSite = (url) => { try { return new URL(url).hostname.replace(/^www\\./, '').endsWith(host); } catch { return false; } };
  const out = [];
  const seen = new Set();
  const links = document.querySelectorAll('a.result__a').length ? document.querySelectorAll('a.result__a') : document.querySelectorAll('a[href]');
  for (const a of links) {
    const link = unwrap(a.getAttribute('href'));
    const title = (a.innerText || '').trim().split('\\n')[0];
    if (!link || !onSite(link) || seen.has(link) || title.length < 8) continue;
    seen.add(link);
    const box = a.closest('.result, .result__body') || a.parentElement;
    const snippet = (box?.querySelector('.result__snippet')?.innerText || '').trim().slice(0, 240);
    out.push({ title: title.slice(0, 160), link, snippet });
  }
  const next = [...document.querySelectorAll('input[type="submit"], button')].find((b) => /^\\s*next\\s*$/i.test(b.value || b.textContent));
  document.querySelectorAll('[data-cf-next]').forEach((b) => b.removeAttribute('data-cf-next'));
  if (next) next.setAttribute('data-cf-next', '1');
  return { items: out, hasNext: Boolean(next) };
})()`;

// Find a store's product pages on DuckDuckGo ("site:robu.in esp32 s3") — the fallback when
// Google is unavailable (CAPTCHA skipped) or found little.
async function ddgSiteSearch(host, query, isCancelled = () => false, maxPages = 2) {
  const q = `site:${host} ${query}`;
  const byLink = new Map();
  await acquire();
  if (isCancelled()) {
    release();
    return [];
  }
  const win = hiddenWindow(false);
  const wc = win.webContents;
  try {
    await load(win, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en`, 15000);
    await delay(1500);
    for (let p = 1; p <= maxPages; p++) {
      const res = await wc.executeJavaScript(ENGINE_SCRIPT(host));
      for (const i of res.items) if (!byLink.has(i.link)) byLink.set(i.link, i);
      if (!res.hasNext || p === maxPages) break;
      const before = wc.getURL();
      await wc.executeJavaScript(`document.querySelector('[data-cf-next]')?.click()`);
      if (!(await waitForNavigation(wc, before, 8000))) break;
      await delay(1500);
    }
  } catch { /* no results */ } finally {
    win.destroy();
    release();
  }
  return [...byLink.values()];
}

// The same on Google (throws BlockedError on a CAPTCHA). Asks "esp32 s3 robu.in" rather than
// "site:robu.in esp32 s3": Google ignores site: for the app's windows (it returned Amazon S3
// pages), while naming the site ranks its product pages first. Only on-site results are kept.
async function googleSiteSearch(host, query, page, isCancelled) {
  const res = await googleWeb(`${query} ${host}`, page, { country: 'in' }, isCancelled);
  const onSite = (i) => {
    try {
      return new URL(i.displayUrl || i.link).hostname.replace(/^www\./, '').endsWith(host);
    } catch {
      return false;
    }
  };
  return {
    items: res.items.filter(onSite).map((i) => ({ title: i.title, link: i.link, displayUrl: i.displayUrl, snippet: i.snippet, price: i.price })),
    hasMore: res.hasMore,
  };
}

module.exports = { googleWeb, googleShopping, storeSearch, ddgSiteSearch, googleSiteSearch, productInfo, googleUrl, PARTITION };
