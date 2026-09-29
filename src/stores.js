// Indian component stores searched directly (their own site search), so results don't
// depend on Google indexing them. `{q}` is replaced with the URL-encoded query.
// Users can add more in Settings as "Name | https://shop.example/search?q={q}".
const DEFAULT_STORES = [
  { name: 'Robu.in', search: 'https://robu.in/?s={q}&post_type=product' },
  { name: 'Evelta', search: 'https://evelta.com/search.php?search_query={q}' },
  { name: 'KTRON', search: 'https://www.ktron.in/?s={q}&post_type=product' },
  { name: 'Sunrom', search: 'https://www.sunrom.com/search/index?q={q}' },
  { name: 'Campus Component', search: 'https://www.campuscomponent.com/search-products?q={q}' },
  { name: 'Robocraze', search: 'https://robocraze.com/search?q={q}&type=product' },
  { name: 'Semikart', search: 'https://www.semikart.com/search/{q}' },
  { name: 'ElectronicsComp', search: 'https://www.electronicscomp.com/index.php?route=product/search&search={q}' },
  { name: 'Robokits India', search: 'https://robokits.co.in/index.php?main_page=advanced_search_result&keyword={q}' },
  { name: 'rhydoLABZ', search: 'https://www.rhydolabz.com/index.php?route=product/search&search={q}' },
  { name: 'Think Robotics', search: 'https://thinkrobotics.com/search?q={q}&type=product' },
  { name: 'FactoryForward', search: 'https://www.factoryforward.com/?s={q}&post_type=product' },
  { name: 'Probots', search: 'https://probots.co.in/catalogsearch/result/?q={q}' },
  { name: 'Quartz Components', search: 'https://quartzcomponents.com/search?q={q}&type=product' },
  { name: 'Hubtronics', search: 'https://hubtronics.in/index.php?route=product/search&search={q}' },
  { name: 'Robomart', search: 'https://robomart.com/?s={q}&post_type=product' },
  { name: 'Thingbits', search: 'https://www.thingbits.in/?q={q}' },
  { name: 'FlyRobo', search: 'https://www.flyrobo.in/index.php?route=product/search&search={q}' },
  { name: 'Zbotic', search: 'https://zbotic.in/?s={q}&post_type=product' },
];

// Store list lines <-> store objects. A line is "Name | URL", where URL is either
//  - a search URL with {q}  -> { name, search }   (searched directly), or
//  - just the site address  -> { name, home }     (the app finds the site's search box and types).
function parseStores(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [a, b] = line.includes('|') ? line.split('|').map((x) => x.trim()) : [null, line];
    let url = b;
    if (!/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(url)) url = `https://${url}`;
    let host;
    try {
      host = new URL(url.replace('{q}', 'x')).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
    const name = a || host;
    return url.includes('{q}') ? { name, search: url } : { name, home: url };
  }).filter(Boolean);
}

const formatStores = (stores) => stores.map((s) => `${s.name} | ${s.search || s.home}`).join('\n');

const storeHost = (store) => new URL((store.search || store.home).replace('{q}', 'x')).hostname.replace(/^www\./, '');

const storeSearchUrl = (store, query) => store.search.replace('{q}', encodeURIComponent(query));

// After typing `query` into a site's search box and landing on `url`, turn that URL into a
// reusable template ("…?s={q}&post_type=product"), or null if the query isn't in it.
function templateFrom(url, query) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const want = query.trim().toLowerCase();
  for (const [k, v] of u.searchParams) {
    if (v.trim().toLowerCase() === want) {
      u.searchParams.set(k, '__CFQ__');
      return u.toString().replace('__CFQ__', '{q}');
    }
  }
  // Path style: /search/LM7805 or /search/lm7805
  const parts = u.pathname.split('/');
  const i = parts.findIndex((seg) => decodeURIComponent(seg).toLowerCase() === want);
  if (i > 0) {
    parts[i] = '__CFQ__';
    u.pathname = parts.join('/');
    return u.toString().replace('__CFQ__', '{q}');
  }
  return null;
}

module.exports = { DEFAULT_STORES, parseStores, formatStores, storeSearchUrl, storeHost, templateFrom };
