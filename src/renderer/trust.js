// Trusted sellers and the price/trust ordering. Loaded by the page (script tag) and by the
// tests (require), so no imports.
//
// The list is one entry per line: a domain ("robu.in" — matches the listing's site and its
// subdomains) or a seller name ("DigiKey" — matches Google Shopping sellers like
// "DigiKey India", and store names). Lines starting with # are comments.

function parseTrusted(text) {
  return String(text || '').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => {
    const domain = l.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? { kind: 'domain', value: domain } : { kind: 'name', value: l };
  });
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function listingHost(item) {
  // Google result links can be redirects: use the site Google displayed instead.
  const url = item.link && !/^https:\/\/www\.google\.[a-z.]+\/(goto|url)\?/.test(item.link) ? item.link : item.displayUrl;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isTrusted(item, entries) {
  const host = listingHost(item);
  const source = squash(item.source);
  return entries.some((e) => {
    if (e.kind === 'name') return squash(e.value).length >= 3 && source.includes(squash(e.value));
    if (host === e.value || host.endsWith(`.${e.value}`) || source === squash(e.value)) return true;
    // Google Shopping names sellers without a site: "robocraze.com" also matches "Robocraze",
    // "quartzcomponents.com" matches "Quartz Components", "probots.co.in" matches "Probots India".
    const brand = e.value.split('.')[0];
    return !host && brand.length >= 4 && source.startsWith(brand);
  });
}

// In stock (or unknown) before out of stock.
const stockRank = (i) => (/out of stock|sold out|discontinued|backorder/i.test(i.availability || '') ? 1 : 0);

// Comparators. `trusted` is a function item -> boolean.
function byPrice(dir, trusted) {
  return (a, b) => {
    if (a.priceValue == null || b.priceValue == null) return (a.priceValue == null) - (b.priceValue == null);
    return dir * (a.priceValue - b.priceValue) || stockRank(a) - stockRank(b) || trusted(b) - trusted(a);
  };
}

// Trusted sellers first; within each group: priced before unpriced, cheapest first,
// in stock before out of stock at the same price.
function byTrustThenPrice(trusted) {
  const price = byPrice(1, trusted);
  return (a, b) => trusted(b) - trusted(a) || price(a, b);
}

if (typeof module !== 'undefined') module.exports = { parseTrusted, isTrusted, listingHost, byPrice, byTrustThenPrice };
