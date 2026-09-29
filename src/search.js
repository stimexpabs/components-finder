// Search pipeline. A search streams events to the renderer as it goes:
//   results {items}      new listings (your stores, Google web results, Google Shopping)
//   update  {id, patch}  price/stock read from a listing's own page
//   remove  {id}         listing turned out not to be priced in INR (INR-only mode)
//   status  {message}    progress text
//   blocked {url}        Google wants a CAPTCHA/consent — show it in the browser pane
//   store-blocked {name, url}  a store showed a bot check
//   error   {message}
//   searched {hasMore}   searching finished (page checks may still be running)
//   done                 everything finished
const { WEB, SHOPPING, hostOf, parsePrice, currencyCode } = require('./providers');
const { parseStores, storeHost } = require('./stores');
const learned = require('./learned');
const { isGoogleRedirect, listable, isRelevant, inrVerdict } = require('./filters');
const crawler = require('./crawler');
const { viaGoogle, captchaDone } = require('./captcha');

let currentJob = 0;
let lastJob = null;
let idSeq = 0;

function makeJob(sender, settings) {
  const id = ++currentJob;
  const stores = settings.useStores ? parseStores(settings.stores) : [];
  return lastJob = {
    id,
    settings,
    stores,
    storeHosts: new Set(stores.map(storeHost)),
    pending: [],
    checked: 0,
    isCancelled: () => id !== currentJob,
    emit(type, data = {}) {
      if (id === currentJob && !sender.isDestroyed()) sender.send('search:event', { jobId: id, type, ...data });
    },
    // Emit listings, dropping non-INR ones in INR-only mode.
    emitResults(items) {
      const keep = settings.inrOnly ? items.filter((i) => inrVerdict(i, this.storeHosts) !== false) : items;
      if (keep.length) this.emit('results', { items: keep });
    },
  };
}

function normalize(raw, kind) {
  const p = raw.priceValue != null ? {} : parsePrice(raw.price);
  return {
    ...raw,
    ...p,
    price: raw.price ?? p.price ?? null,
    currency: currencyCode(raw.currency) || currencyCode(raw.price) || p.currency || null,
    id: `${kind[0]}${++idSeq}`,
    kind,
    source: raw.source || hostOf(raw.link),
  };
}

// Open each web result's page and read price / stock / MPN from it.
// `viaEngine` items (a blocked store's products found through a search engine) are always
// checked, outside the maxChecks budget: the page is where their price comes from.
function checkPages(job, items) {
  const { settings } = job;
  const web = items.filter((i) => i.link && i.kind === 'web').slice(0, Math.max(0, settings.maxChecks - job.pending.length));
  const toCheck = [...items.filter((i) => i.link && i.viaEngine), ...web];
  for (const item of toCheck) {
    item.checking = true;
    job.pending.push(
      crawler.productInfo(item.link, job.isCancelled)
        .then((info) => {
          const patch = { checking: false };
          if (info?.finalUrl && isGoogleRedirect(item.link) && /^https?:/.test(info.finalUrl) && !isGoogleRedirect(info.finalUrl)) {
            patch.link = info.finalUrl;
            patch.source = hostOf(info.finalUrl);
          }
          if (info && !info.blocked) {
            if (item.viaEngine && info.title) patch.title = info.title; // the page's own name, not "Buy … | Robu.in"
            if (item.priceValue == null && info.priceValue != null) {
              Object.assign(patch, { price: info.price, priceValue: info.priceValue, currency: currencyCode(info.currency) || currencyCode(info.price) });
            }
            if (info.availability) patch.availability = info.availability;
            if (info.stockQty != null) patch.stockQty = info.stockQty;
            if (info.mpn) patch.mpn = info.mpn;
          } else if (info?.blocked) {
            patch.note = 'site blocked the page check';
          }
          return patch;
        })
        .catch(() => ({ checking: false, note: 'page failed to load' }))
        .then((patch) => {
          job.checked++;
          Object.assign(item, patch);
          // A search-engine hit with no price or stock wasn't a product page (category, blog…).
          const notProduct = item.viaEngine && item.priceValue == null && !item.availability;
          if (notProduct || (settings.inrOnly && inrVerdict(item, job.storeHosts) === false)) job.emit('remove', { id: item.id });
          else job.emit('update', { id: item.id, patch });
          job.emit('progress', { checked: job.checked, total: job.pending.length });
        }),
    );
  }
}

// One store: via its search URL (given, or learned earlier), else by typing into its
// search box — then remember the URL that produced, for next time.
async function searchStore(job, store, query) {
  const host = storeHost(store);
  const known = store.search || learned.get(host);
  const res = await crawler.storeSearch(known ? { ...store, search: known } : store, query, job.isCancelled, { maxPages: job.settings.storePages });
  if (!known && res.template) learned.set(host, res.template);
  if (res.blocked) return searchStoreViaEngine(job, store, host, query, res.url);
  const items = res.items
    .filter((r) => isRelevant(r.title, query))
    .map((r) => normalize({ ...r, source: store.name, currency: currencyCode(r.price) || 'INR' }, 'store'));
  job.emitResults(items);
  return { found: items.length, blocked: res.blocked, error: res.error };
}

// The store's own search blocked the app (e.g. Robu's Cloudflare): find its product pages
// through a search engine instead ("site:robu.in esp32 s3"), then read each page.
async function searchStoreViaEngine(job, store, host, query, blockedUrl) {
  if (job.settings.siteSearchFallback === false) {
    job.emit('store-blocked', { name: store.name, url: blockedUrl });
    return { found: 0, blocked: true };
  }
  // Google (2 pages; a CAPTCHA pauses for the user to solve) and DuckDuckGo side by side,
  // merged: each finds products the other misses. Duplicates also collapse once a Google
  // redirect resolves to its product page.
  const found = new Map();
  const engines = [];
  const google = (async () => {
    const items = [];
    try {
      for (let p = 0; p < 2; p++) {
        const g = await viaGoogle(job, () => crawler.googleSiteSearch(host, query, p, job.isCancelled));
        items.push(...g.items);
        if (!g.hasMore || !g.items.length) break;
      }
    } catch { /* CAPTCHA skipped / timed out: DuckDuckGo only */ }
    return items;
  })();
  const [gItems, dItems] = await Promise.all([google, crawler.ddgSiteSearch(host, query, job.isCancelled, 2)]);
  for (const i of gItems) found.set(i.displayUrl || i.link, i);
  const have = [...found.keys()].map((k) => k.replace(/[.…]+$/, ''));
  for (const i of dItems) if (!have.some((k) => i.link.startsWith(k) || k.startsWith(i.link))) found.set(i.link, i);
  if (gItems.length) engines.push('Google');
  if (dItems.length) engines.push('DuckDuckGo');
  const alt = { items: [...found.values()], engine: engines.join(' + ') };
  const items = alt.items
    .filter((r) => isRelevant(`${r.title} ${r.link}`, query))
    .map((r) => normalize({ ...r, source: store.name, currency: currencyCode(r.price) || 'INR', viaEngine: alt.engine,
      snippet: `Found via ${alt.engine} (${store.name}'s own search blocked the app)` }, 'store'));
  if (!items.length) {
    job.emit('store-blocked', { name: store.name, url: blockedUrl });
    return { found: 0, blocked: true };
  }
  job.emit('store-fallback', { name: store.name, engine: alt.engine, count: items.length, url: blockedUrl });
  checkPages(job, items);
  job.emitResults(items);
  return { found: items.length, blocked: false, via: alt.engine };
}

async function run(job, { query, page }) {
  const { settings } = job;
  const browser = settings.provider === 'browser';
  const webQuery = [query, settings.webSuffix, settings.inrOnly && !/india/i.test(settings.webSuffix || '') ? 'India' : '']
    .filter(Boolean).join(' ');
  let hasMore = false;

  // Your stores, searched directly (first page only).
  const storeSearches = page === 0 ? job.stores.map((store) => searchStore(job, store, query)) : [];

  const web = (async () => {
    // Browser mode fetches several Google pages per request (each is ~10 results).
    const perRequest = browser ? Math.max(1, settings.webPages) : 1;
    for (let i = 0; i < perRequest && !job.isCancelled(); i++) {
      const p = page * perRequest + i;
      job.emit('status', { message: `Searching your stores and Google (page ${p + 1})…` });
      const res = browser
        ? await viaGoogle(job, () => crawler.googleWeb(webQuery, p, settings, job.isCancelled))
        : await WEB[settings.provider]({ query: webQuery, page: p, settings });
      const items = res.items.filter(listable).map((r) => normalize(r, 'web'))
        // Google already shows a non-INR price: no need to open the page.
        .filter((i) => !settings.inrOnly || !i.currency || i.currency === 'INR');
      checkPages(job, items);
      job.emitResults(items);
      hasMore = res.hasMore;
      if (!res.hasMore) break;
    }
  })();

  const shoppingFn = browser ? (q) => viaGoogle(job, () => crawler.googleShopping(q, settings, job.isCancelled))
    : SHOPPING[settings.provider] && ((q) => SHOPPING[settings.provider]({ query: q, page: 0, settings }));
  const shopping = settings.includeShopping && page === 0 && shoppingFn
    ? shoppingFn(query).then((res) => job.emitResults(res.items.map((r) => normalize(r, 'shopping'))))
    : Promise.resolve();

  const outcomes = await Promise.allSettled([web, shopping, ...storeSearches]);
  let blockedUrl = null;
  for (const o of outcomes) {
    if (o.status !== 'rejected') continue;
    if (o.reason?.blocked) blockedUrl ||= o.reason.url;
    else job.emit('error', { message: o.reason?.message || String(o.reason) });
  }
  if (blockedUrl) job.emit('blocked', { url: blockedUrl });
  job.emit('searched', { hasMore });

  // New pages may be queued while we wait, so drain until stable.
  for (let n = 0; n !== job.pending.length;) {
    n = job.pending.length;
    await Promise.allSettled(job.pending);
  }
  job.emit('done');
}

// INR-only mode searches Google as India.
const effective = (settings) => (settings.inrOnly ? { ...settings, country: 'in' } : settings);

function startSearch(sender, args, settings) {
  const job = makeJob(sender, effective(settings));
  run(job, args).catch((err) => {
    job.emit('error', { message: err.message });
    job.emit('done');
  });
  return job.id;
}

// Listings the user pulled from the browser pane themselves: added to the current search,
// and web ones get their pages checked like search results.
function addExtracted(sender, items, settings) {
  const job = lastJob && !lastJob.isCancelled() ? lastJob : makeJob(sender, effective(settings));
  const normalized = items
    .filter((r) => (r.kind === 'shopping' && !r.link) || listable(r))
    .map((r) => normalize(r, r.kind || 'web'));
  const before = job.pending.length;
  checkPages(job, normalized);
  job.emitResults(normalized);
  Promise.allSettled(job.pending.slice(before)).then(() => job.emit('done'));
  return job.id;
}

// A store just added from the browser pane: search it for the current query, adding to
// the current results.
function searchOneStore(sender, store, query, settings) {
  const job = lastJob && !lastJob.isCancelled() ? lastJob : makeJob(sender, effective(settings));
  job.storeHosts.add(storeHost(store));
  return searchStore(job, store, query);
}

module.exports = { startSearch, addExtracted, searchOneStore, captchaDone };
