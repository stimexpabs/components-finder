// Cart tracking rules (pure, no Electron): fold a fresh page snapshot into a cart item,
// keep its history, and describe what changed.
//
// Snapshot = { ok, error?, price, priceValue, currency, availability, stockQty, mpn }
// Item.current = last known state (+ checkedAt, error); item.history = [{ t, priceValue, availability, stockQty }]

const MAX_HISTORY = 24 * 90; // ~90 days of hourly points
const MAX_EVENTS = 200;

function stockState(availability, stockQty) {
  if (/out of stock|sold out|discontinued|unavailable|backorder/i.test(availability || '')) return false;
  if (stockQty > 0 || /in stock|limited|available/i.test(availability || '')) return true;
  return null;
}

const money = (value, currency) => `${!currency || currency === 'INR' ? '₹' : `${currency} `}${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// What changed between two tracked states. The first successful check only sets the
// baseline: a product page's price can differ from the search-listing price (e.g. ex/incl GST).
function diff(prev, next, wantedQty = 1) {
  const events = [];
  if (!prev?.checkedAt) return events;
  if (prev.priceValue != null && next.priceValue != null && prev.currency === next.currency) {
    const change = next.priceValue - prev.priceValue;
    if (Math.abs(change) > 0.005 && Math.abs(change) / prev.priceValue > 0.001) {
      const pct = Math.round((change / prev.priceValue) * 1000) / 10;
      events.push({
        type: change < 0 ? 'price-drop' : 'price-rise',
        text: `Price ${change < 0 ? 'dropped' : 'rose'} ${money(prev.priceValue, prev.currency)} → ${money(next.priceValue, next.currency)} (${pct > 0 ? '+' : ''}${pct}%)`,
        notify: change < 0,
      });
    }
  }
  const was = stockState(prev.availability, prev.stockQty);
  const now = stockState(next.availability, next.stockQty);
  if (was === false && now === true) events.push({ type: 'back-in-stock', text: 'Back in stock', notify: true });
  if (was === true && now === false) events.push({ type: 'out-of-stock', text: `Out of stock (${next.availability || 'no stock'})`, notify: true });
  const wasLow = was === true && prev.stockQty != null && prev.stockQty < wantedQty;
  if (now === true && next.stockQty != null && next.stockQty < wantedQty && !wasLow) {
    events.push({ type: 'low-stock', text: `Only ${next.stockQty} left — you need ${wantedQty}`, notify: true });
  }
  return events;
}

// Mutates `item`; returns the change events (already appended to item.events).
function applySnapshot(item, snap, now = Date.now()) {
  const prev = item.current || {};
  if (!snap.ok) {
    item.current = { ...prev, lastError: snap.error || 'check failed', lastErrorAt: now };
    item.failures = (item.failures || 0) + 1;
    const events = item.failures === 3 ? [{ type: 'unreachable', text: `Could not check 3 times in a row: ${snap.error}`, notify: false }] : [];
    record(item, events, now);
    return events;
  }
  item.failures = 0;
  const out = /out of stock|sold out/i.test(snap.availability || '');
  const next = {
    price: snap.priceValue != null ? snap.price : prev.price,
    priceValue: snap.priceValue ?? prev.priceValue ?? null,
    currency: snap.currency || prev.currency || null,
    availability: snap.availability || prev.availability || null,
    stockQty: snap.stockQty ?? (out ? 0 : snap.availability ? null : prev.stockQty ?? null),
    checkedAt: now,
    lastError: null,
  };
  if (snap.mpn && !item.mpn) item.mpn = snap.mpn;
  const events = diff(prev, next, item.qty || 1);
  item.current = next;
  item.history = [...(item.history || []), { t: now, priceValue: next.priceValue, availability: next.availability, stockQty: next.stockQty }]
    .slice(-MAX_HISTORY);
  record(item, events, now);
  return events;
}

function record(item, events, now) {
  if (!events.length) return;
  item.events = [...(item.events || []), ...events.map((e) => ({ t: now, type: e.type, text: e.text }))].slice(-MAX_EVENTS);
}

// Price change since tracking began (first successful check), as a fraction.
function changeSinceStart(item) {
  const first = (item.history || []).find((h) => h.priceValue != null);
  const cur = item.current?.priceValue;
  return first && cur != null && first.priceValue ? (cur - first.priceValue) / first.priceValue : null;
}

module.exports = { applySnapshot, diff, stockState, changeSinceStart, money };
