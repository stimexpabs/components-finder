/* global extractListings, extractGoogleWeb, extractProductInfo, parseTrusted, isTrusted, listingHost, byPrice, byTrustThenPrice */
const $ = (id) => document.getElementById(id);
const view = $('view');

const state = {
  settings: null,
  query: '',
  page: 0,
  jobId: null,
  hasMore: false,
  searching: false,
  items: [], // in arrival order (= relevance)
  progress: null, // { checked, total }
  blockedStores: [], // [{ name, url }] stores that showed a bot check
  fallbackStores: [], // [{ name, engine, count }] blocked stores searched via a search engine instead
  googleBlocked: null, // Google CAPTCHA url, if Google asked for one
  pendingClickTitle: null,
};

const PROVIDER_LABEL = { browser: 'Browser mode', serpapi: 'SerpAPI' };

// ---------- helpers ----------
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

const isBuyable = (i) => i.priceValue != null || /in stock|limited/i.test(i.availability || '') || i.stockQty > 0;

// ---------- trusted sellers ----------
let trustedEntries = [];
const trusted = (i) => isTrusted(i, trustedEntries);
const loadTrusted = () => { trustedEntries = parseTrusted(state.settings?.trustedSites); };

// ☆ on a result: trust / untrust its seller (by site, or by seller name for Shopping tiles).
async function toggleTrusted(item) {
  const lines = String(state.settings.trustedSites || '').split('\n');
  const host = listingHost(item);
  const entry = host || item.source;
  let next;
  if (trusted(item)) {
    // Remove whatever entries make it trusted.
    next = lines.filter((l) => {
      const one = parseTrusted(l);
      return !(one.length && isTrusted(item, one));
    });
    flashStatus(`${item.source || host} is no longer trusted.`);
  } else {
    next = [...lines, entry];
    flashStatus(`Trusting ${entry}.`);
  }
  state.settings = await window.api.setSettings({ trustedSites: next.join('\n') });
  loadTrusted();
  render();
}

// ---------- rendering ----------
function visibleItems() {
  const f = $('filter').value.trim().toLowerCase();
  const src = $('sourceFilter').value;
  const type = $('typeFilter').value;
  const buyableOnly = $('buyableOnly').checked;
  const trustedOnly = $('trustedOnly').checked;
  let list = state.items.filter((i) =>
    (!src || i.source === src) &&
    (!type || i.kind === type) &&
    (!buyableOnly || i.checking || isBuyable(i)) &&
    (!trustedOnly || trusted(i)) &&
    (!f || `${i.title} ${i.source} ${i.snippet || ''} ${i.mpn || ''}`.toLowerCase().includes(f)));
  const sort = $('sort').value;
  if (sort === 'trusted-price') list = [...list].sort(byTrustThenPrice(trusted));
  if (sort === 'price-asc') list = [...list].sort(byPrice(1, trusted));
  if (sort === 'price-desc') list = [...list].sort(byPrice(-1, trusted));
  if (sort === 'source') list = [...list].sort((a, b) => a.source.localeCompare(b.source));
  if (sort === 'stock') list = [...list].sort((a, b) => (b.stockQty || (isBuyable(b) ? 0.5 : 0)) - (a.stockQty || (isBuyable(a) ? 0.5 : 0)));
  return list;
}

function renderSourceFilter() {
  const sel = $('sourceFilter');
  const current = sel.value;
  const counts = {};
  for (const i of state.items) counts[i.source] = (counts[i.source] || 0) + 1;
  sel.replaceChildren(new Option(`All sellers (${Object.keys(counts).length})`, ''));
  for (const [s, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    sel.add(new Option(`${s || '(unknown)'} (${n})`, s));
  }
  sel.value = counts[current] ? current : '';
}

let renderQueued = false;
function render() {
  // Updates arrive in bursts while pages are checked; coalesce them into one paint.
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function renderNow() {
  renderSourceFilter();
  const list = visibleItems();
  const activeId = document.querySelector('.item.active')?.dataset.id;
  const ul = $('results');
  const scroll = ul.scrollTop;
  ul.replaceChildren(...list.map((item) => {
    const li = renderItem(item);
    if (item.id === activeId) li.classList.add('active');
    return li;
  }));
  ul.scrollTop = scroll;
  $('exportBtn').disabled = state.items.length === 0;
  $('moreBtn').hidden = !state.hasMore || state.searching;
  renderStatus(list);
}

// A message that should stay up for a while instead of being replaced by the counts.
function flashStatus(msg, kind = '', ms = 6000) {
  state.flashUntil = Date.now() + ms;
  setStatus(msg, kind);
  setTimeout(() => Date.now() >= state.flashUntil && renderStatus(), ms + 50);
}

function renderStatus(list = visibleItems()) {
  if (!state.items.length || Date.now() < (state.flashUntil || 0)) return;
  const count = (k) => state.items.filter((i) => i.kind === k).length;
  const sellers = new Set(state.items.map((i) => i.source)).size;
  const inr = state.settings.inrOnly ? ' · ₹ INR only' : '';
  const parts = [`${list.length} of ${state.items.length} listings (${count('store')} stores, ${count('web')} web, ` +
    `${count('shopping')} shopping) from ${sellers} sellers${inr}`];
  if (state.searching) parts.push('searching Google…');
  if (state.progress && state.progress.checked < state.progress.total) {
    parts.push(`checking pages ${state.progress.checked}/${state.progress.total}…`);
  }
  setStatus(parts.join(' · '), parts.length > 1 ? 'busy' : '');
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.id = item.id;
  li.title = item.link || 'Opens this product in Google Shopping';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (item.thumbnail) {
    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    thumb.append(img);
  } else {
    thumb.textContent = (item.source || '?').slice(0, 2).toUpperCase();
  }

  const body = document.createElement('div');
  body.className = 'body';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.title;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const tag = (text, cls = '') => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    meta.append(s);
  };
  tag({ shopping: 'Shopping', store: 'Store', web: 'Web' }[item.kind] || item.kind, `kind ${item.kind}`);
  const isT = trusted(item);
  const star = document.createElement('button');
  star.className = `star ${isT ? 'on' : ''}`;
  star.textContent = isT ? '★' : '☆';
  star.title = isT ? 'Trusted seller — click to untrust' : 'Trust this seller';
  star.onclick = (e) => {
    e.stopPropagation();
    toggleTrusted(item);
  };
  meta.append(star);
  tag(item.source || '—', 'source');
  if (isT) tag('✓ Trusted', 'trusted');
  if (item.availability || item.stockQty) {
    const out = /out of stock|discontinued/i.test(item.availability || '');
    const qty = item.stockQty ? `${item.stockQty.toLocaleString()} ` : '';
    tag(`${qty}${item.availability || 'in stock'}`.trim(), out ? 'stock out' : 'stock in');
  }
  if (item.mpn) tag(`MPN ${item.mpn}`);
  if (item.rating != null) tag(`★ ${item.rating}`);
  if (item.delivery) tag(item.delivery);
  if (item.note) tag(item.note, 'note');

  const snip = document.createElement('div');
  snip.className = 'snippet';
  snip.textContent = item.snippet || item.link || '';
  body.append(title, meta, snip);

  const price = document.createElement('div');
  price.className = `price ${item.price ? '' : 'none'}`;
  price.textContent = item.price || (item.checking ? 'checking…' : 'see site');
  const add = document.createElement('button');
  const inCart = cartHas(item);
  add.className = `add ${inCart ? 'in' : ''}`;
  add.textContent = inCart ? '✓ In cart' : '+ Cart';
  add.title = inCart ? 'Tracked in your cart' : 'Add to cart and track price & stock';
  add.disabled = inCart;
  add.onclick = (e) => {
    e.stopPropagation();
    addToCart(item);
  };
  const pricecol = document.createElement('div');
  pricecol.className = 'pricecol';
  pricecol.append(price, add);

  li.append(thumb, body, pricecol);
  li.addEventListener('click', () => {
    document.querySelectorAll('.item.active').forEach((e) => e.classList.remove('active'));
    li.classList.add('active');
    openItem(item);
  });
  return li;
}

async function openItem(item) {
  if (item.link) return navigate(item.link);
  // Link-less Google Shopping tile: open its results page and click the tile, which shows
  // Google's panel with the sellers for that product.
  if (item.pageUrl && view.getURL() === item.pageUrl && (await clickTileByTitle(item.title))) return;
  state.pendingClickTitle = item.title;
  navigate(item.pageUrl || googleUrl(item.title, true));
}

function clickTileByTitle(title) {
  return view.executeJavaScript(`((want) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.trim() !== want) continue;
      const el = walker.currentNode.parentElement;
      el.scrollIntoView({ block: 'center' });
      (el.closest('[jsaction*="click"]') || el).click();
      return true;
    }
    return false;
  })(${JSON.stringify(title)})`).catch(() => false);
}

// ---------- search ----------
function googleUrl(query, shopping = false) {
  const p = new URLSearchParams({ q: query, hl: 'en', gl: state.settings.inrOnly ? 'in' : state.settings.country || 'us' });
  if (shopping) p.set('udm', '28');
  return `https://www.google.com/search?${p}`;
}

async function runSearch(query, { more = false } = {}) {
  if (!query) return;
  if (!more) {
    state.query = query;
    state.page = 0;
    state.items = [];
    state.progress = null;
    state.blockedStores = [];
    state.fallbackStores = [];
    state.googleBlocked = null;
    renderNotes();
  }
  state.hasMore = false;
  state.searching = true;
  render();
  setStatus(more ? 'Loading more Google results…' : `Searching Google for “${query}”…`, 'busy');
  state.jobId = await window.api.search(query, state.page);
}

// Same product page reached via a store search and via Google: keep one.
const itemKey = (i) => {
  if (!i.link) return `${i.pageUrl}|${i.title}`;
  try {
    const u = new URL(i.link);
    if (/google\./.test(u.hostname)) return i.link;
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return i.link;
  }
};

function addItems(items) {
  const seen = new Set(state.items.map(itemKey));
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    state.items.push(item);
  }
}

window.api.onSearchEvent((ev) => {
  // Ignore stragglers from an earlier search.
  if (state.jobId != null && ev.jobId < state.jobId) return;
  state.jobId = ev.jobId;
  switch (ev.type) {
    case 'results':
      addItems(ev.items);
      render();
      break;
    case 'update': {
      const item = state.items.find((i) => i.id === ev.id);
      if (!item) break;
      Object.assign(item, ev.patch);
      // A Google redirect resolved to a page that's already listed: drop the duplicate.
      if (ev.patch.link && state.items.some((i) => i !== item && itemKey(i) === itemKey(item))) {
        state.items = state.items.filter((i) => i !== item);
      }
      render();
      break;
    }
    case 'remove':
      state.items = state.items.filter((i) => i.id !== ev.id);
      render();
      break;
    case 'store-fallback':
      state.fallbackStores.push({ name: ev.name, engine: ev.engine, count: ev.count, url: ev.url });
      renderNotes();
      break;
    case 'store-blocked':
      state.blockedStores.push({ name: ev.name, url: ev.url });
      renderNotes();
      break;
    case 'progress':
      state.progress = { checked: ev.checked, total: ev.total };
      renderStatus();
      break;
    case 'status':
      if (!state.items.length) setStatus(ev.message, 'busy');
      break;
    case 'captcha':
      showCaptcha(ev.url);
      break;
    case 'blocked':
      // The CAPTCHA was skipped or not solved in time (it was already shown in the pane).
      state.googleBlocked = ev.url;
      renderNotes();
      break;
    case 'error':
      setStatus(ev.message, 'error');
      break;
    case 'searched':
      state.searching = false;
      state.hasMore = ev.hasMore;
      render();
      if (!state.items.length) setTimeout(() => !state.items.length && setStatus(`No listings found for “${state.query}”.`), 0);
      break;
    case 'done':
      state.progress = null;
      render();
      break;
  }
});

// Stores that showed a bot check: open one in the pane, pass the check, search again.
function renderNotes() {
  const el = $('notes');
  el.replaceChildren();
  el.hidden = !state.blockedStores.length && !state.googleBlocked && !state.fallbackStores.length;
  if (state.fallbackStores.length) {
    const line = document.createElement('div');
    line.textContent = state.fallbackStores.map((s) => `${s.name} blocked the app’s search — found ${s.count} of its products via ${s.engine} instead`).join('; ');
    el.append(line);
  }
  if (state.googleBlocked) {
    const line = document.createElement('div');
    line.textContent = 'Google’s CAPTCHA wasn’t solved, so some Google results are missing. Search again to get another chance.';
    el.append(line);
  }
  if (!state.blockedStores.length) return;
  el.append('Bot check blocked these stores (open one, complete the check or search there once, then search again): ');
  state.blockedStores.forEach((s, n) => {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = s.name;
    a.onclick = (e) => {
      e.preventDefault();
      navigate(s.url);
    };
    el.append(...(n ? [', ', a] : [a]));
  });
}

// "Extract listings": pull listings from whatever page the browser pane shows.
async function extractFromPage() {
  const url = view.getURL();
  let items = [];
  try {
    const isGoogle = /^https:\/\/www\.google\.[a-z.]+\/search/.test(url);
    const isShopping = isGoogle && /[?&](udm=28|tbm=shop)/.test(url);
    if (isGoogle && !isShopping) {
      const res = await view.executeJavaScript(`(${extractGoogleWeb.toString()})()`);
      items = res.items.map((i) => ({ ...i, kind: 'web' }));
    } else {
      items = (await view.executeJavaScript(`(${extractListings.toString()})()`))
        .map((i) => ({ ...i, kind: i.link && !isShopping ? 'web' : 'shopping' }));
      if (!isGoogle) {
        // A single product page: take its own price/stock too.
        const info = await view.executeJavaScript(`(${extractProductInfo.toString()})()`);
        if (info.priceValue != null || info.availability) {
          items.unshift({ ...info, title: info.title || view.getTitle(), link: url, kind: 'web' });
        }
      }
    }
  } catch (err) {
    setStatus(`Extraction failed: ${err.message}`, 'error');
    return;
  }
  if (!items.length) {
    setStatus('No listings found on this page. Scroll or open a results page, then press “Extract listings”.', 'error');
    return;
  }
  if (!state.query) state.query = view.getTitle() || hostOf(url);
  state.jobId = await window.api.addExtracted(items);
}

// "＋ Add to stores": the site shown in the pane becomes one of your stores. The app will open
// it, type into its search box and read the results — on every search from now on.
async function addCurrentSiteToStores() {
  let u;
  try {
    u = new URL(view.getURL());
  } catch {
    u = null;
  }
  if (!u || !/^https?:$/.test(u.protocol) || /(^|\.)google\./.test(u.hostname)) {
    setStatus('Open a shop’s website in the browser pane first, then press “＋ Add to stores”.', 'error');
    return;
  }
  const host = u.hostname.replace(/^www\./, '');
  const lines = String(state.settings.stores || '').split('\n').filter((l) => l.trim());
  if (lines.some((l) => {
    const m = l.match(/https?:\/\/([^/?#|\s]+)/i);
    return m && m[1].replace(/^www\./, '').toLowerCase() === host.toLowerCase();
  })) {
    flashStatus(`${host} is already one of your stores.`);
    return;
  }
  // Store name: the site's declared name, or the part of the title that looks like the brand, else the domain.
  const siteName = await view.executeJavaScript(`document.querySelector('meta[property="og:site_name"]')?.content || ''`).catch(() => '');
  const brand = host.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const name = (siteName.trim().length <= 40 && siteName.trim()) || view.getTitle().split(/\s[|–—-]\s|\s:\s/).map((t) => t.trim())
    .find((t) => t.length <= 40 && t.toLowerCase().replace(/[^a-z0-9]/g, '').includes(brand)) || host;
  const store = { name, home: `${u.origin}/` };
  state.settings = await window.api.setSettings({ stores: [...lines, `${store.name} | ${store.home}`].join('\n'), useStores: true });
  if (!state.query) {
    flashStatus(`Added ${name} to your stores. It will be searched with every search.`);
    return;
  }
  flashStatus(`Added ${name} — searching it for “${state.query}”…`, 'busy', 60000);
  const res = await window.api.searchStore(store, state.query);
  flashStatus(res.blocked ? `Added ${name}. It shows a bot check — complete it in the pane, then search again.`
    : res.error ? `Added ${name}, but couldn’t find its search box (${res.error}). Add “Name | search URL with {q}” in Settings instead.`
      : `Added ${name}: ${res.found} matching listing${res.found === 1 ? '' : 's'} for “${state.query}”.`, res.error ? 'error' : '');
}

// ---------- "🛒 Add to cart" for the page in the browser pane ----------
// For products found by browsing manually: reads the page's own name, price, stock, part
// number and image, then adds it to the cart, where it's tracked hourly like any other item.
const paneUrl = () => {
  try {
    const u = new URL(view.getURL());
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
};

// The name you gave this site in "My stores", if it's one of them.
function storeNameFor(host) {
  for (const line of String(state.settings?.stores || '').split('\n')) {
    const [name, url] = line.includes('|') ? line.split('|').map((x) => x.trim()) : [null, line.trim()];
    try {
      if (name && new URL(url.replace('{q}', 'x')).hostname.replace(/^www\./, '') === host) return name;
    } catch { /* not a URL */ }
  }
  return null;
}

function syncCartPageBtn() {
  const u = paneUrl();
  const page = (x) => String(x).split('#')[0].split('?')[0].replace(/\/$/, '').toLowerCase();
  const inCart = Boolean(u) && cart.items.some((c) => c.link && page(c.link) === page(u.href));
  $('cartPageBtn').classList.toggle('in', inCart);
  $('cartPageBtn').textContent = inCart ? '✓ In cart' : '🛒 Add to cart';
  $('cartPageBtn').disabled = !u;
}

async function addPageToCart() {
  const u = paneUrl();
  if (!u) return;
  if (/(^|\.)google\./.test(u.hostname)) {
    flashStatus('Open the product’s own page first (click through from Google), then press 🛒 Add to cart.', 'error');
    return;
  }
  const run = (fn) => view.executeJavaScript(`(${fn.toString()})()`);
  let info;
  try {
    info = await run(extractProductInfo);
  } catch (err) {
    flashStatus(`Couldn’t read this page: ${err.message}`, 'error');
    return;
  }
  if (info.blocked) {
    flashStatus('This page is a bot check — complete it first, then press 🛒 Add to cart.', 'error');
    return;
  }
  // A page of many products (search results, a category): pick one instead.
  if (info.priceValue == null) {
    const cards = await run(extractListings).catch(() => []);
    if (cards.length >= 2) {
      flashStatus(`This page lists ${cards.length} products. Open the one you want, or press “Extract listings” and use “+ Cart” on it.`, 'error', 9000);
      return;
    }
  }
  const host = u.hostname.replace(/^www\./, '');
  const siteName = await view.executeJavaScript(`document.querySelector('meta[property="og:site_name"]')?.content || ''`).catch(() => '');
  const link = info.canonical || u.href;
  const item = {
    kind: 'web',
    title: (info.title || view.getTitle() || host).trim().slice(0, 200),
    link,
    source: storeNameFor(host) || (siteName.trim().length <= 40 && siteName.trim()) || host,
    price: info.price,
    priceValue: info.priceValue,
    currency: info.currency || (info.price && /₹|Rs|INR/i.test(info.price) ? 'INR' : null),
    availability: info.availability,
    stockQty: info.stockQty,
    mpn: info.mpn,
    thumbnail: info.image,
  };
  if (cartHas(item)) {
    flashStatus('This product is already in your cart.');
    return;
  }
  await addToCart(item);
  syncCartPageBtn();
  flashStatus(item.priceValue != null
    ? `Added to cart: ${item.title.slice(0, 60)} — ${item.price}${item.availability ? `, ${item.availability}` : ''}. Tracked hourly.`
    : `Added to cart: ${item.title.slice(0, 60)} — no price found on this page yet; the hourly checks will keep trying.`, '', 7000);
}

$('cartPageBtn').onclick = () => addPageToCart();
for (const ev of ['did-navigate', 'did-navigate-in-page']) view.addEventListener(ev, syncCartPageBtn);

// ---------- Google CAPTCHA: solved by the user in the pane, then the search continues ----------
let captchaOpen = false;
const onSorryPage = () => /^https:\/\/(www\.)?google\.[a-z.]+\/sorry\//.test(view.getURL());

function showCaptcha(url) {
  if (captchaOpen) return;
  captchaOpen = true;
  $('captchaBanner').hidden = false;
  if (!onSorryPage()) navigate(url);
  flashStatus('Paused: Google wants a CAPTCHA — solve it in the browser pane and the search continues.', 'busy', 60000);
}

function captchaFinished(solved) {
  if (!captchaOpen) return;
  captchaOpen = false;
  $('captchaBanner').hidden = true;
  state.flashUntil = 0;
  window.api.captchaDone(solved);
  flashStatus(solved ? 'CAPTCHA solved — continuing the search with Google…' : 'Skipped Google’s CAPTCHA — continuing without Google.', 'busy', 5000);
}

$('captchaSkipBtn').onclick = () => captchaFinished(false);
// Solving it sends Google on to the results page: the pane leaves /sorry/.
for (const ev of ['did-navigate', 'did-navigate-in-page']) {
  view.addEventListener(ev, () => {
    if (captchaOpen && !onSorryPage() && /^https:\/\/(www\.)?google\./.test(view.getURL())) captchaFinished(true);
  });
}

// ---------- embedded browser ----------
function navigate(url) {
  if (!/^[a-z]+:/i.test(url)) {
    url = /^[\w-]+(\.[\w-]+)+(\/|$)/.test(url) ? `https://${url}` : googleUrl(url);
  }
  view.loadURL(url).catch(() => {}); // aborted navigations reject; the view reports its own errors
}

view.addEventListener('did-start-loading', () => $('progressBar').classList.add('loading'));
view.addEventListener('did-stop-loading', () => {
  $('progressBar').classList.remove('loading');
  if (state.pendingClickTitle) {
    const title = state.pendingClickTitle;
    state.pendingClickTitle = null;
    setTimeout(() => clickTileByTitle(title), 1500); // Shopping tiles render after load
  }
});
const syncNav = () => {
  $('urlBar').value = view.getURL() === 'about:blank' ? '' : view.getURL();
  $('backBtn').disabled = !view.canGoBack();
  $('fwdBtn').disabled = !view.canGoForward();
};
view.addEventListener('did-navigate', syncNav);
view.addEventListener('did-navigate-in-page', syncNav);
view.addEventListener('dom-ready', syncNav);

$('backBtn').onclick = () => view.canGoBack() && view.goBack();
$('fwdBtn').onclick = () => view.canGoForward() && view.goForward();
$('reloadBtn').onclick = () => view.reload();
$('externalBtn').onclick = () => $('urlBar').value && window.api.openExternal($('urlBar').value);
$('extractBtn').onclick = () => extractFromPage();
$('addStoreBtn').onclick = () => addCurrentSiteToStores();
$('urlBar').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate($('urlBar').value.trim());
});

// ---------- toolbar ----------
$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch($('query').value.trim());
});
$('moreBtn').onclick = () => {
  state.page += 1;
  runSearch(state.query, { more: true });
};
for (const id of ['filter', 'sort', 'sourceFilter', 'typeFilter', 'buyableOnly', 'trustedOnly']) {
  $(id).addEventListener(id === 'filter' ? 'input' : 'change', render);
}
// Remember the sort and "Trusted only" choice (per computer; fine if storage is unavailable).
try {
  const saved = JSON.parse(localStorage.getItem('view') || '{}');
  if (saved.sort && [...$('sort').options].some((o) => o.value === saved.sort)) $('sort').value = saved.sort;
  $('trustedOnly').checked = Boolean(saved.trustedOnly);
} catch { /* no storage */ }
for (const id of ['sort', 'trustedOnly']) {
  $(id).addEventListener('change', () => {
    try {
      localStorage.setItem('view', JSON.stringify({ sort: $('sort').value, trustedOnly: $('trustedOnly').checked }));
    } catch { /* no storage */ }
  });
}

$('exportBtn').onclick = async () => {
  const cols = ['title', 'kind', 'source', 'trusted', 'price', 'priceValue', 'currency', 'availability', 'stockQty', 'mpn', 'link', 'pageUrl'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...visibleItems().map((i) => cols.map((c) => esc(c === 'trusted' ? (trusted(i) ? 'yes' : '') : i[c])).join(','))].join('\n');
  const saved = await window.api.exportCsv(csv);
  if (saved) setStatus(`Exported to ${saved}`);
};

// ---------- settings ----------
const dlg = $('settingsDlg');
const form = $('settingsForm');

function syncSettingsVisibility() {
  const p = form.provider.value;
  form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(p); });
}
form.provider.addEventListener('change', syncSettingsVisibility);

$('settingsBtn').onclick = () => {
  for (const [k, v] of Object.entries(state.settings)) {
    if (!form[k]) continue;
    if (form[k].type === 'checkbox') form[k].checked = Boolean(v);
    else form[k].value = v;
  }
  syncSettingsVisibility();
  dlg.showModal();
};
dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save') return;
  const data = Object.fromEntries(new FormData(form));
  data.country = (data.country || 'us').toLowerCase();
  data.includeShopping = form.includeShopping.checked;
  data.inrOnly = form.inrOnly.checked;
  data.useStores = form.useStores.checked;
  data.siteSearchFallback = form.siteSearchFallback.checked;
  data.keepInTray = form.keepInTray.checked;
  data.startAtLogin = form.startAtLogin.checked;
  data.webPages = Math.min(10, Math.max(1, parseInt(data.webPages, 10) || 3));
  data.maxChecks = Math.min(100, Math.max(0, parseInt(data.maxChecks, 10) || 0));
  data.storePages = Math.min(10, Math.max(1, parseInt(data.storePages, 10) || 3));
  data.trackEveryMinutes = Math.min(1440, Math.max(5, parseInt(data.trackEveryMinutes, 10) || 60));
  data.webSuffix = (data.webSuffix || '').trim();
  state.settings = await window.api.setSettings(data);
  loadTrusted();
  render();
  $('providerBadge').textContent = PROVIDER_LABEL[state.settings.provider];
});

// ---------- splitter ----------
$('splitter').addEventListener('mousedown', (e) => {
  e.preventDefault();
  view.style.pointerEvents = 'none';
  const move = (ev) => {
    const w = Math.min(Math.max(ev.clientX, 320), window.innerWidth - 320);
    document.documentElement.style.setProperty('--results-width', `${w}px`);
  };
  const up = () => {
    view.style.pointerEvents = '';
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---------- cart ----------
const cart = { items: [], lastRun: 0, running: false, nextRun: 0, intervalMin: 60, open: new Set() };

const sameListing = (a, b) => (a.link && b.link ? a.link === b.link : a.title === b.title && a.source === b.source);
const cartHas = (item) => cart.items.some((c) => sameListing(c, item));

async function addToCart(item) {
  const { checking, id, ...listing } = item;
  applyCart(await window.api.cart.add(listing));
  render();
}

function applyCart(c) {
  Object.assign(cart, c);
  $('cartCount').textContent = cart.items.length || '';
  syncCartPageBtn();
  if (!$('cartView').hidden) renderCart();
}

function ago(t) {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const fmtTime = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const money = (v, cur) => `${!cur || cur === 'INR' ? '₹' : `${cur} `}${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function sparkline(history) {
  const pts = history.filter((h) => h.priceValue != null).slice(-96);
  if (pts.length < 2) return null;
  const w = 160;
  const h = 26;
  const vals = pts.map((p) => p.priceValue);
  const min = Math.min(...vals);
  const span = Math.max(...vals) - min || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 2 - ((p.priceValue - min) / span) * (h - 4)).toFixed(1)}`).join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.innerHTML = `<title>${money(min, null)} – ${money(min + span, null)} over ${pts.length} checks</title><path d="${d}"/>`;
  return svg;
}

function renderCart() {
  // Totals per currency (INR-only mode keeps this to one).
  const totals = {};
  let unpriced = 0;
  for (const i of cart.items) {
    const c = i.current?.priceValue != null ? i.current : i.added;
    if (c?.priceValue == null) unpriced++;
    else totals[c.currency || 'INR'] = (totals[c.currency || 'INR'] || 0) + c.priceValue * (i.qty || 1);
  }
  const sum = $('cartSummary');
  sum.replaceChildren();
  if (!cart.items.length) {
    sum.textContent = 'Your cart is empty — use “+ Cart” on any result to track it.';
  } else {
    const b = document.createElement('b');
    b.textContent = Object.entries(totals).map(([cur, v]) => money(v, cur)).join(' + ') || '—';
    sum.append(`${cart.items.length} item${cart.items.length > 1 ? 's' : ''} · total `, b, unpriced ? ` (+${unpriced} without price)` : '');
  }
  const next = cart.running ? 'checking now…' : `next check ${cart.nextRun ? new Date(cart.nextRun).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}`;
  $('cartStatus').textContent = `Checks every ${cart.intervalMin >= 60 ? `${cart.intervalMin / 60} h` : `${cart.intervalMin} min`} while running (also in the tray) · last ${ago(cart.lastRun)} · ${next}`;
  $('cartStatus').className = `status ${cart.running ? 'busy' : ''}`;
  $('cartCheckBtn').disabled = cart.running || !cart.items.length;
  $('cartCsvBtn').disabled = !cart.items.length;
  const list = $('cartList');
  const scroll = list.scrollTop;
  list.replaceChildren(...cart.items.map(renderCartItem));
  list.scrollTop = scroll;
}

function renderCartItem(item) {
  const cur = item.current?.checkedAt ? item.current : { ...item.added };
  const li = document.createElement('li');
  li.className = 'item citem';
  li.dataset.id = item.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (item.thumbnail) {
    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.onerror = () => img.remove();
    thumb.append(img);
  } else {
    thumb.textContent = (item.source || '?').slice(0, 2).toUpperCase();
  }

  const body = document.createElement('div');
  body.className = 'body';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.title;
  title.title = 'Open in the browser pane';
  title.onclick = () => openItem(item);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const tag = (text, cls = '') => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    meta.append(s);
  };
  tag(item.source || '—', 'source');
  if (cur.availability || cur.stockQty != null) {
    const out = /out of stock|sold out|discontinued|backorder/i.test(cur.availability || '') || cur.stockQty === 0;
    tag(`${cur.stockQty ? `${cur.stockQty.toLocaleString('en-IN')} ` : ''}${cur.availability || (out ? 'out of stock' : 'in stock')}`, out ? 'stock out' : 'stock in');
  }
  if (item.mpn) tag(`MPN ${item.mpn}`);
  tag(item.checking ? 'checking…' : `checked ${ago(item.current?.checkedAt)}`);
  if (item.current?.lastError) tag(`⚠ ${item.current.lastError}`, 'note');

  const spark = sparkline(item.history || []);
  const controls = document.createElement('div');
  controls.className = 'controls';
  const qty = document.createElement('input');
  qty.type = 'number';
  qty.min = 1;
  qty.value = item.qty || 1;
  qty.title = 'Quantity you need';
  qty.onchange = async () => applyCart(await window.api.cart.setQty(item.id, qty.value));
  const btn = (text, titleText, fn) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = titleText;
    b.onclick = fn;
    return b;
  };
  const open = cart.open.has(item.id);
  controls.append('Qty', qty,
    btn(open ? 'Hide history' : `History (${(item.events || []).length})`, 'Price & stock changes', () => {
      if (open) cart.open.delete(item.id);
      else cart.open.add(item.id);
      renderCart();
    }),
    btn('⟳', 'Check this item now', () => window.api.cart.check(item.id)),
    btn('✕', 'Remove from cart', async () => applyCart(await window.api.cart.remove(item.id))));
  body.append(title, meta, ...(spark ? [spark] : []), controls);

  if (open) {
    const ul = document.createElement('ul');
    ul.className = 'events';
    for (const e of [...(item.events || [])].reverse()) {
      const row = document.createElement('li');
      row.className = e.type;
      const time = document.createElement('time');
      time.textContent = fmtTime(e.t);
      row.append(time, e.text);
      ul.append(row);
    }
    const checks = (item.history || []).length;
    const note = document.createElement('li');
    note.textContent = `${checks} check${checks === 1 ? '' : 's'} recorded since ${fmtTime(item.addedAt)}`;
    ul.append(note);
    body.append(ul);
  }

  const pricecol = document.createElement('div');
  pricecol.className = 'pricecol';
  const price = document.createElement('div');
  price.className = `price ${cur.priceValue != null ? '' : 'none'}`;
  price.textContent = cur.priceValue != null ? money(cur.priceValue, cur.currency) : 'no price';
  pricecol.append(price);
  const first = (item.history || []).find((h) => h.priceValue != null);
  if (first && cur.priceValue != null && first.priceValue && cur.priceValue !== first.priceValue) {
    const pct = ((cur.priceValue - first.priceValue) / first.priceValue) * 100;
    const ch = document.createElement('div');
    ch.className = `change ${pct < 0 ? 'down' : 'up'}`;
    ch.textContent = `${pct < 0 ? '▼' : '▲'} ${Math.abs(pct).toFixed(1)}%`;
    ch.title = `since first check (${money(first.priceValue, cur.currency)})`;
    pricecol.append(ch);
  }
  if ((item.qty || 1) > 1 && cur.priceValue != null) {
    const line = document.createElement('div');
    line.className = 'change';
    line.textContent = `× ${item.qty} = ${money(cur.priceValue * item.qty, cur.currency)}`;
    pricecol.append(line);
  }

  li.append(thumb, body, pricecol);
  return li;
}

function showTab(which) {
  const isCart = which === 'cart';
  $('resultsView').hidden = isCart;
  $('cartView').hidden = !isCart;
  $('tabResults').classList.toggle('active', !isCart);
  $('tabCart').classList.toggle('active', isCart);
  if (isCart) renderCart();
  else render();
}

$('tabResults').onclick = () => showTab('results');
$('tabCart').onclick = () => showTab('cart');
$('cartCheckBtn').onclick = () => window.api.cart.check();
$('cartCsvBtn').onclick = async () => {
  const cols = ['title', 'source', 'qty', 'price', 'currency', 'availability', 'stockQty', 'firstPrice', 'lastChecked', 'mpn', 'link'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = cart.items.map((i) => {
    const c = i.current?.checkedAt ? i.current : i.added;
    const first = (i.history || []).find((h) => h.priceValue != null);
    return { title: i.title, source: i.source, qty: i.qty, price: c.priceValue, currency: c.currency, availability: c.availability, stockQty: c.stockQty,
      firstPrice: first?.priceValue, lastChecked: i.current?.checkedAt ? new Date(i.current.checkedAt).toISOString() : '', mpn: i.mpn, link: i.link || i.pageUrl };
  });
  const saved = await window.api.exportCsv([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
  if (saved) $('cartStatus').textContent = `Exported to ${saved}`;
};

window.api.cart.onChange((c) => {
  const before = cart.items.length;
  applyCart(c);
  if (cart.items.length !== before && !$('resultsView').hidden) render(); // refresh "In cart" buttons
});
window.api.cart.onFocus((id) => {
  showTab('cart');
  cart.open.add(id);
  renderCart();
  const el = document.querySelector(`.citem[data-id="${id}"]`);
  el?.scrollIntoView({ block: 'center' });
  el?.classList.add('flash');
});
// Keep "checked N min ago" fresh.
setInterval(() => !$('cartView').hidden && renderCart(), 60 * 1000);

// ---------- init ----------
(async () => {
  state.settings = await window.api.getSettings();
  loadTrusted();
  $('providerBadge').textContent = PROVIDER_LABEL[state.settings.provider];
  applyCart(await window.api.cart.get());
})();
