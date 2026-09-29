// API search providers. Each returns { items: Listing[], hasMore: boolean }.
// Listing = { title, link, source, price, priceValue, currency, thumbnail, snippet, rating, delivery, availability }

const PRICE_RE = /([$€£¥₹]|\bRs\.?|\bINR|USD|EUR|GBP|CAD|AUD)\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?)/i;

// "₹", "Rs.", "INR 12" -> "INR"; "$" -> "USD" … ; null when unknown.
function currencyCode(text) {
  const t = String(text ?? '');
  if (/₹|\bRs\.?|\bINR\b/i.test(t)) return 'INR';
  if (/€|\bEUR\b/i.test(t)) return 'EUR';
  if (/£|\bGBP\b/i.test(t)) return 'GBP';
  if (/¥|\bJPY\b|\bCNY\b/i.test(t)) return 'JPY';
  if (/\$|\bUSD\b/i.test(t)) return 'USD';
  const code = t.trim().match(/^[A-Z]{3}\b/);
  return code ? code[0] : null;
}

function parsePrice(text) {
  if (text == null) return { price: null, priceValue: null, currency: null };
  if (typeof text === 'number') return { price: String(text), priceValue: text, currency: null };
  const m = String(text).match(PRICE_RE);
  if (!m) return { price: String(text), priceValue: null, currency: null };
  const value = parseFloat(m[2].replace(/[,\s]/g, ''));
  return { price: m[0], priceValue: Number.isFinite(value) ? value : null, currency: currencyCode(m[1]) };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || res.statusText;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return body;
}

// Sites that never sell parts (or aren't listings) — dropped from web results.
const NON_SHOP = /(^|\.)(youtube\.com|youtu\.be|wikipedia\.org|reddit\.com|facebook\.com|instagram\.com|pinterest\.[a-z.]+|x\.com|twitter\.com|tiktok\.com|quora\.com|stackexchange\.com|stackoverflow\.com)$/i;

function isListable(url) {
  if (!url || !/^https?:\/\//.test(url)) return false;
  try {
    const u = new URL(url);
    return !NON_SHOP.test(u.hostname) && !/\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

// --- SerpAPI: Google web results ("All" tab) ---
async function serpapiWeb({ query, page, settings }) {
  if (!settings.serpapiKey) throw new Error('SerpAPI key not set. Open Settings.');
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    api_key: settings.serpapiKey,
    gl: settings.country || 'us',
    hl: 'en',
    start: String(page * 10),
  });
  const data = await getJson(`https://serpapi.com/search.json?${params}`);
  if (data.error) throw new Error(data.error);
  const items = (data.organic_results || []).map((r) => {
    const rich = r.rich_snippet?.top || r.rich_snippet?.bottom || {};
    const ext = rich.detected_extensions || {};
    const extText = (rich.extensions || []).join(' · ');
    const p = ext.price != null
      ? { price: `${ext.currency || '$'}${ext.price}`, priceValue: ext.price, currency: currencyCode(ext.currency || '$') }
      : parsePrice(extText.match(PRICE_RE)?.[0] ?? null);
    return {
      title: r.title,
      link: r.link,
      source: r.source || hostOf(r.link),
      ...p,
      thumbnail: r.thumbnail || null,
      snippet: [extText, r.snippet].filter(Boolean).join(' · '),
      rating: ext.rating ?? null,
      delivery: null,
      availability: /out of stock/i.test(extText) ? 'Out of stock' : /in stock/i.test(extText) ? 'In stock' : null,
    };
  });
  return { items, hasMore: Boolean(data.serpapi_pagination?.next) };
}

// --- SerpAPI: Google Shopping ---
async function serpapiShopping({ query, page, settings }) {
  if (!settings.serpapiKey) throw new Error('SerpAPI key not set. Open Settings.');
  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: query,
    api_key: settings.serpapiKey,
    gl: settings.country || 'us',
    hl: 'en',
    num: '60',
    start: String(page * 60),
  });
  const data = await getJson(`https://serpapi.com/search.json?${params}`);
  if (data.error) throw new Error(data.error);
  const raw = [...(data.shopping_results || []), ...(data.inline_shopping_results || [])];
  const items = raw.map((r) => {
    const p = r.extracted_price != null
      ? { price: r.price, priceValue: r.extracted_price, currency: parsePrice(r.price).currency }
      : parsePrice(r.price);
    return {
      title: r.title,
      link: r.product_link || r.link,
      source: r.source || hostOf(r.link),
      ...p,
      thumbnail: r.thumbnail || null,
      snippet: r.snippet || (r.extensions || []).join(' · '),
      rating: r.rating ?? null,
      delivery: r.delivery || null,
    };
  });
  return { items, hasMore: Boolean(data.serpapi_pagination?.next) };
}

// Web ("All") results per provider, and Google Shopping where the provider has it.
const WEB = { serpapi: serpapiWeb };
const SHOPPING = { serpapi: serpapiShopping };

module.exports = { WEB, SHOPPING, parsePrice, currencyCode, hostOf, isListable };
