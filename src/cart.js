// The cart: saved components, re-checked on a timer (hourly by default) while the app runs.
// Stored in <userData>/cart.json. Every change is pushed to the windows as 'cart:changed'.
const { app, BrowserWindow, Notification, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crawler = require('./crawler');
const { applySnapshot } = require('./tracker');
const { parsePrice, currencyCode } = require('./providers');
const { isGoogleRedirect } = require('./filters');

const file = () => path.join(app.getPath('userData'), 'cart.json');
let cart = { items: [], lastRun: 0 };
let running = false;
let nextRun = 0;
let timer = null;
let getSettings = () => ({});
let seq = 0;
const listeners = [];

const intervalMs = () => Math.max(5, Number(getSettings().trackEveryMinutes) || 60) * 60 * 1000;

function load() {
  try {
    cart = { items: [], lastRun: 0, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cart = { items: [], lastRun: 0 };
  }
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cart));
  fs.renameSync(tmp, file()); // atomic: never leaves a half-written cart
}

function snapshot() {
  return { items: cart.items, lastRun: cart.lastRun, running, nextRun, intervalMin: intervalMs() / 60000 };
}

function broadcast() {
  const snap = snapshot();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('cart:changed', snap);
  for (const fn of listeners) fn(snap);
}

function notify(item, events) {
  if (!Notification.isSupported()) return;
  for (const e of events.filter((ev) => ev.notify)) {
    const n = new Notification({ title: `${item.source}: ${e.text}`, body: item.title });
    n.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) return;
      w.show();
      w.webContents.send('cart:focus', item.id);
    });
    n.show();
  }
}

// Google rewords listing titles now and then: match by word overlap, same seller first.
function bestShoppingMatch(item, listings) {
  const words = (t) => new Set(String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const want = words(item.title);
  const score = (l) => {
    const got = words(l.title);
    const common = [...want].filter((w) => got.has(w)).length;
    return common / (want.size + got.size - common || 1);
  };
  const sameSeller = (l) => String(l.source || '').toLowerCase() === String(item.source || '').toLowerCase();
  let best = null;
  for (const l of listings) {
    const s = score(l);
    // A different seller needs a near-identical title to count as the same listing.
    if (s >= (sameSeller(l) ? 0.5 : 0.85) && (!best || s + sameSeller(l) > best.s + sameSeller(best.l))) best = { l, s };
  }
  return best?.l || null;
}

// Read the item's current state from the web.
async function fetchSnapshot(item) {
  try {
    if (item.link) {
      const info = await crawler.productInfo(item.link);
      if (!info) return { ok: false, error: 'page did not load' };
      if (info.finalUrl && isGoogleRedirect(item.link) && !isGoogleRedirect(info.finalUrl)) item.link = info.finalUrl;
      if (info.blocked) return { ok: false, error: 'site blocked the check' };
      if (info.priceValue == null && !info.availability) return { ok: false, error: 'no price or stock found on the page' };
      return {
        ok: true,
        price: info.price,
        priceValue: info.priceValue,
        currency: currencyCode(info.currency) || currencyCode(info.price),
        availability: info.availability,
        stockQty: info.stockQty,
        mpn: info.mpn,
      };
    }
    // Google Shopping tile without a link: find the same product (title + seller) again.
    const res = await crawler.googleShopping(item.title, { country: 'in' }, () => false);
    const match = bestShoppingMatch(item, res.items);
    if (!match) return { ok: false, error: 'no longer listed on Google Shopping' };
    const p = parsePrice(match.price);
    return { ok: true, price: match.price, priceValue: p.priceValue, currency: p.currency, availability: match.availability, stockQty: null };
  } catch (err) {
    return { ok: false, error: err.blocked ? 'Google asked for a CAPTCHA' : err.message };
  }
}

async function checkItem(item) {
  item.checking = true;
  broadcast();
  const snap = await fetchSnapshot(item);
  item.checking = false;
  // The item may have been removed while its page was loading.
  if (!cart.items.includes(item)) return;
  const events = applySnapshot(item, snap);
  notify(item, events);
  save();
  broadcast();
}

async function checkAll() {
  if (running) return;
  running = true;
  clearTimeout(timer);
  broadcast();
  try {
    await Promise.all(cart.items.map(checkItem));
    cart.lastRun = Date.now();
    save();
  } finally {
    running = false;
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  const due = cart.lastRun + intervalMs();
  // Overdue (app was closed or asleep): catch up shortly after start, not instantly.
  nextRun = Math.max(due, Date.now() + 30 * 1000);
  timer = setTimeout(checkAll, nextRun - Date.now());
  broadcast();
}

const sameListing = (a, b) => (a.link && b.link ? a.link === b.link : a.title === b.title && a.source === b.source);

function add(listing) {
  const existing = cart.items.find((i) => sameListing(i, listing));
  if (existing) return snapshot();
  const now = Date.now();
  const item = {
    id: `c${now.toString(36)}${++seq}`,
    addedAt: now,
    title: listing.title,
    link: listing.link || null,
    pageUrl: listing.pageUrl || null,
    source: listing.source,
    kind: listing.kind,
    thumbnail: listing.thumbnail || null,
    mpn: listing.mpn || null,
    qty: 1,
    // What the search showed when added; tracking compares against the first page check.
    added: { price: listing.price, priceValue: listing.priceValue, currency: listing.currency, availability: listing.availability, stockQty: listing.stockQty },
    current: null,
    history: [],
    events: [{ t: now, type: 'added', text: `Added at ${listing.price || 'no price'}` }],
  };
  cart.items.unshift(item);
  save();
  broadcast();
  checkItem(item); // baseline right away
  return snapshot();
}

function remove(id) {
  cart.items = cart.items.filter((i) => i.id !== id);
  save();
  broadcast();
  return snapshot();
}

function setQty(id, qty) {
  const item = cart.items.find((i) => i.id === id);
  if (item) item.qty = Math.max(1, Math.min(1e6, Math.floor(Number(qty)) || 1));
  save();
  broadcast();
  return snapshot();
}

function checkNow(id) {
  if (!id) return checkAll();
  const item = cart.items.find((i) => i.id === id);
  return item && !item.checking ? checkItem(item) : undefined;
}

function init(settingsGetter) {
  getSettings = settingsGetter;
  load();
  for (const i of cart.items) i.checking = false;
  schedule();
  powerMonitor.on('resume', schedule); // timers don't run while asleep
}

const onChange = (fn) => listeners.push(fn);

module.exports = { init, add, remove, setQty, checkNow, snapshot, schedule, onChange };
