// Pure listing filters (no Electron), shared by the search pipeline and tests.
const { isListable, hostOf } = require('./providers');

const isGoogleRedirect = (url) => /^https:\/\/www\.google\.[a-z.]+\/(goto|url)\?/.test(url || '');
// Web results may carry a Google redirect as `link`; judge them by the site they point to.
const listable = (r) => isListable(r.displayUrl || r.link);

// Store search pages often pad results with unrelated products. Part-number-like words
// (anything with a digit) must all appear; otherwise most of the words must.
function isRelevant(title, query) {
  const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const hay = words(title).join(' ');
  const compact = hay.replace(/ /g, '');
  const q = words(query);
  if (!q.length) return true;
  const parts = q.filter((w) => /\d/.test(w));
  if (parts.length) return parts.every((w) => compact.includes(w));
  return q.filter((w) => hay.includes(w)).length >= Math.ceil(q.length * 0.6);
}

// INR-only mode: keep a listing when its price is in INR, or — with no price known — when
// the site is Indian (.in) or one of your stores. `null` = not decided yet (page being checked).
function inrVerdict(item, storeHosts) {
  if (item.currency === 'INR') return true;
  if (item.currency) return false;
  if (item.checking) return null;
  const host = hostOf(item.link && !isGoogleRedirect(item.link) ? item.link : item.displayUrl);
  return /\.in$/i.test(host) || storeHosts.has(host);
}

module.exports = { isGoogleRedirect, listable, isRelevant, inrVerdict };
