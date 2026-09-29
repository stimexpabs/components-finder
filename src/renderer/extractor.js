// Page scripts. They run INSIDE a web page (the browser pane, or a hidden crawler
// window in the main process), so each must be self-contained: no outer-scope closures.

// Product listings on a results page: Google Shopping, or a store's own search page.
// 1. Known product-card layouts (WooCommerce, Shopify, OpenCart, BigCommerce, Magento…).
// 2. Otherwise: find price elements and climb to the smallest "card" around each.
// Sidebars, menus, carts and "related products" blocks are ignored.
function extractListings() {
  const PRICE_RE = /(?:[$€£¥₹]|\bRs\.?|\bINR|USD|EUR|GBP|CAD|AUD)\s*\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:INR|USD|EUR|GBP|€)/i;
  const CARD_SEL = 'li.product, .type-product, .product-item, .product-thumb, .product-card, .product-grid-item, .product-miniature, ' +
    '.productitem, .grid-product, .card-wrapper, article.card, .product-layout, .product-block, .product-box, [data-product-id]';
  const EXCLUDE_ALWAYS = 'header, footer, nav, [role="navigation"], [role="banner"], [role="contentinfo"], ' +
    '[class*="related" i], [class*="recently" i], [class*="upsell" i], [class*="cross-sell" i], [class*="crosssell" i], [class*="megamenu" i]';
  // Only when narrow: page wrappers are often named "has-sidebar", "left-sidebar"…
  const EXCLUDE_NARROW = 'aside, .widget, [class*="sidebar" i], [id*="sidebar" i], [class*="mini-cart" i], [class*="minicart" i], ' +
    '[class*="cart-drawer" i], [id*="cart" i]';
  // <body>/<html> carry theme classes ("has-megamenu", "left-sidebar"…), so they never count.
  const excluded = (el) => {
    for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (a.matches(EXCLUDE_ALWAYS)) return true;
      if (a.matches(EXCLUDE_NARROW) && a.getBoundingClientRect().width < window.innerWidth * 0.45) return true;
    }
    return false;
  };
  const OLD_PRICE = 'del, s, strike, [class*="compare" i], [class*="regular" i], [class*="old" i], [class*="mrp" i], [class*="was" i], [class*="before" i]';
  const norm = (t) => (t || '').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const unwrapGoogle = (href) => {
    try {
      const u = new URL(href, document.baseURI);
      if (/google\./.test(u.hostname) && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url') || u.href;
      return u.href;
    } catch {
      return null;
    }
  };
  const lines = (el) => (el.innerText || '').split('\n').map(norm).filter(Boolean);
  const isPrice = (t) => {
    const n = norm(t);
    if (!n || n.length > 40 || !PRICE_RE.test(n)) return false;
    // A lone price, not a range/filter like "$4 - $10", "Under $4" or "Save Rs 3".
    const count = (n.match(new RegExp(PRICE_RE.source, 'gi')) || []).length;
    return count === 1 && !/under|over|between|save|off\b|discount|free (shipping|delivery)|orders? (above|over)/i.test(n);
  };
  // Deepest visible elements whose text is a price (handles "<span>₹</span>90.80").
  const priceEls = (root) => [...root.querySelectorAll('*')].filter((el) =>
    !/^(SCRIPT|STYLE|NOSCRIPT|OPTION|SELECT)$/.test(el.tagName) && isPrice(el.textContent) &&
    ![...el.children].some((c) => isPrice(c.textContent)) && visible(el));
  const pickPrice = (card) => {
    const els = priceEls(card);
    const cur = els.find((e) => e.closest('ins')) || els.find((e) => !e.closest(OLD_PRICE)) || els[0];
    return cur ? norm(cur.textContent).match(PRICE_RE)[0] : null;
  };
  const productLink = (card) => {
    const links = [...card.querySelectorAll('a[href]'), card.closest('a[href]')].filter(Boolean)
      .filter((a) => !/^(#|javascript:)/.test(a.getAttribute('href')) && !/cart|wishlist|compare|login|account|review/i.test(a.getAttribute('href')));
    return links.find((a) => a.querySelector('img, h1, h2, h3, h4') || /title|name/i.test(a.className + a.parentElement.className)) || links[0] || null;
  };

  // Pass 1: known product cards.
  let cards = [...document.querySelectorAll(CARD_SEL)]
    .filter((c) => visible(c) && !excluded(c) && priceEls(c).length && productLink(c));
  cards = cards.filter((c) => !cards.some((o) => o !== c && c.contains(o))); // innermost only

  // Pass 2: climb from each price to the smallest ancestor holding a title and a link/image.
  if (!cards.length) {
    for (const pEl of priceEls(document.body)) {
      if (excluded(pEl)) continue;
      let card = pEl;
      for (let i = 0; i < 9 && card && card !== document.body; i++, card = card.parentElement) {
        if ((card.innerText || '').length > 900 || card.querySelector('input, select, textarea')) {
          card = null;
          break;
        }
        const hasTitle = lines(card).some((l) => l.length >= 12 && !PRICE_RE.test(l));
        if (hasTitle && (productLink(card) || card.querySelector('img'))) break;
      }
      if (!card || card === document.body || cards.some((c) => c.contains(card) || card.contains(c))) continue;
      cards.push(card);
    }
  }

  const out = [];
  for (const c of cards) {
    const ls = lines(c);
    const link = productLink(c);
    const heading = c.querySelector('h1, h2, h3, h4, [role="heading"], [class*="title" i] a, [class*="name" i] a, .woocommerce-loop-product__title');
    const img = c.querySelector('img');
    const title = norm(heading?.innerText) ||
      ls.filter((l) => !PRICE_RE.test(l)).sort((a, b) => b.length - a.length)[0] || norm(img?.alt);
    if (!title) continue;
    const price = pickPrice(c);
    const priceLine = ls.find((l) => price && l.includes(price)) || '';
    const pIdx = ls.indexOf(priceLine);
    // Google Shopping: the merchant is a short line right after the price.
    const source = /google\./.test(location.hostname)
      ? ls.slice(pIdx + 1, pIdx + 4).find((l) => l.length > 1 && l.length < 40 && !PRICE_RE.test(l) &&
        !/^\d|rating|review|delivery|shipping|free|stars?$/i.test(l)) || ''
      : location.hostname.replace(/^www\./, '');
    const text = ls.join(' ');
    const src = img && (img.currentSrc || img.src || img.dataset.src || '');
    // Tag the card so the app can click it later (link-less Google Shopping tiles).
    c.setAttribute('data-cf-idx', String(out.length));
    out.push({
      cardIndex: out.length,
      pageUrl: location.href,
      title: title.slice(0, 200),
      link: link ? unwrapGoogle(link.getAttribute('href')) : null,
      source,
      price,
      thumbnail: src && /^(https?:|data:image)/.test(src) && src.length < 200000 ? src : null,
      snippet: ls.filter((l) => l !== title && !/^& more$/.test(l) && l !== priceLine && l !== source).slice(0, 3).join(' · ').slice(0, 240),
      availability: /out of stock|sold out|unavailable|notify me/i.test(text) ? 'Out of stock'
        : /in stock|add to cart|add to basket|buy now/i.test(text) ? 'In stock' : null,
      stockQty: (() => {
        const m = text.match(/(\d{1,3}(?:,\d{2,3})+|\d+)\s*(?:pcs\.?\s*)?(?:stock available|in stock|available)/i);
        const n = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
        return n > 0 && !/out of stock|sold out/i.test(text) ? n : null;
      })(),
      delivery: ls.find((l) => /delivery|shipping/i.test(l)) || null,
    });
  }
  return out;
}

// Reads a regular Google web results page ("All" tab): every organic result with its
// link, title and snippet (plus a price/stock if Google shows one in the snippet).
// Google's result hrefs are opaque redirects (/goto?url=…), so the real site is read from
// the displayed URL line ("https://www.digikey.com › en › products") into `displayUrl`.
function extractGoogleWeb() {
  const blocked = /\/sorry\//.test(location.pathname) ||
    !!document.querySelector('#captcha-form, form[action*="sorry"], iframe[src*="recaptcha"]');
  if (blocked) return { blocked: true, items: [], hasNext: false };

  const PRICE_RE = /(?:[$€£¥₹]|\bRs\.?|\bINR|USD|EUR|GBP|CAD|AUD)\s*\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:INR|USD|EUR|GBP|€)/i;
  const unwrap = (href) => {
    try {
      const u = new URL(href, document.baseURI);
      if (/google\./.test(u.hostname) && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url');
      return u.href;
    } catch {
      return null;
    }
  };
  const root = document.querySelector('#rso') || document.querySelector('#search') || document.body;
  const seen = new Set();
  const items = [];
  for (const h of root.querySelectorAll('a h3, a [role="heading"][aria-level="3"]')) {
    const a = h.closest('a[href]');
    const link = a && unwrap(a.getAttribute('href'));
    if (!link || !/^https?:/.test(link) || seen.has(link)) continue;
    seen.add(link);

    // Grow from the link to the whole result block, stopping before we swallow a neighbour.
    let box = a;
    while (box.parentElement && box.parentElement !== root &&
      box.parentElement.querySelectorAll('h3').length <= 1 &&
      (box.parentElement.innerText || '').length < 1200) box = box.parentElement;

    // "https://www.digikey.com › en › products" -> "https://www.digikey.com/en/products"
    const cite = [...box.querySelectorAll('cite')].map((c) => c.innerText.trim()).find((t) => /^https?:\/\//.test(t));
    const displayUrl = cite ? cite.split('›').map((x) => x.trim()).filter((x) => x && x !== '...').join('/') : null;
    let host = null;
    try {
      host = new URL(displayUrl || link).hostname;
    } catch { /* no usable URL */ }
    if (!host || /(^|\.)google\.[a-z.]+$/.test(host) && !displayUrl) continue;
    // PDFs (datasheets) are labelled next to the title.
    if (/^PDF$/m.test(box.innerText || '')) continue;

    const title = h.innerText.trim();
    const lines = (box.innerText || '').split('\n').map((l) => l.trim())
      .filter((l) => l && l !== title && !l.includes('›') && !/^https?:\/\//.test(l));
    const snippet = lines.filter((l) => l.length > 3).slice(1, 5).join(' · ');
    const img = box.querySelector('img[src^="http"], img[src^="data:image"]');
    items.push({
      title,
      link,
      displayUrl,
      source: host.replace(/^www\./, ''),
      siteName: lines[0] && lines[0].length < 40 ? lines[0] : null,
      snippet: snippet.slice(0, 300),
      price: snippet.match(PRICE_RE)?.[0] || null,
      availability: /out of stock|sold out/i.test(snippet) ? 'Out of stock' : /in stock/i.test(snippet) ? 'In stock' : null,
      thumbnail: img && img.src.length < 50000 ? img.src : null,
    });
  }
  const hasNext = !!document.querySelector('#pnnext, a[aria-label="Next page"], a[aria-label="More results"]');
  return { blocked: false, items, hasNext };
}

// Reads price / stock / part number from any product page. Structured data first
// (JSON-LD, meta tags, microdata), then visible-text heuristics.
function extractProductInfo() {
  const PRICE_RE = /(?:[$€£¥₹]|\bRs\.?|\bINR|USD|EUR|GBP|CAD|AUD)\s*\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:INR|USD|EUR|GBP|€)/i;
  const toNum = (v) => {
    const m = String(v ?? '').match(/\d[\d,]*(?:\.\d+)?/); // "Rs.13.51/-" -> 13.51, "1,23,456" -> 123456
    const n = m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const out = { title: null, price: null, priceValue: null, currency: null, availability: null, stockQty: null, mpn: null, seller: null,
    image: null, canonical: null, blocked: false };
  if (/access denied|just a moment|attention required|captcha|are you a robot|pardon our interruption/i.test(document.title)) {
    out.blocked = true;
    return out;
  }

  const products = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if ([].concat(o['@type'] || []).some((t) => /Product/i.test(t))) products.push(o);
    if (o['@graph']) walk(o['@graph']);
    if (o.mainEntity) walk(o.mainEntity);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walk(JSON.parse(s.textContent));
    } catch { /* invalid JSON-LD */ }
  }
  for (const p of products) {
    out.title ||= p.name || null;
    const img = [].concat(p.image || [])[0];
    out.image ||= (typeof img === 'string' ? img : img?.url) || null;
    out.mpn ||= p.mpn || p.sku || null;
    const offers = [].concat(p.offers || []).flatMap((o) => (o && o.offers ? [o, ...[].concat(o.offers)] : [o]));
    for (const o of offers) {
      if (!o) continue;
      const spec = [].concat(o.priceSpecification || [])[0] || {};
      const price = toNum(o.price ?? o.lowPrice ?? spec.price);
      if (out.priceValue == null && price != null) {
        out.priceValue = price;
        out.currency = o.priceCurrency || spec.priceCurrency || null;
      }
      if (!out.availability && o.availability) out.availability = String(o.availability);
      if (out.stockQty == null && o.inventoryLevel) out.stockQty = toNum(o.inventoryLevel.value ?? o.inventoryLevel);
      if (!out.seller && o.seller?.name) out.seller = o.seller.name;
    }
  }

  const meta = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`)?.getAttribute('content');
  if (out.priceValue == null) {
    out.priceValue = toNum(meta('product:price:amount') || meta('og:price:amount'));
    out.currency ||= meta('product:price:currency') || meta('og:price:currency') || null;
  }
  if (out.priceValue == null) {
    const el = document.querySelector('[itemprop="price"]');
    if (el) {
      out.priceValue = toNum(el.getAttribute('content') || el.textContent);
      out.currency ||= document.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content') || null;
    }
  }
  if (!out.availability) {
    const el = document.querySelector('[itemprop="availability"]');
    out.availability = (el && (el.getAttribute('href') || el.getAttribute('content') || el.textContent)) ||
      meta('product:availability') || meta('og:availability') || null;
  }
  if (out.priceValue == null) {
    // Visible price inside something named like a price.
    for (const el of document.querySelectorAll('[class*="price" i], [id*="price" i]')) {
      const t = (el.innerText || '').trim();
      const m = t.length < 60 && t.match(PRICE_RE);
      if (m) {
        out.price = m[0];
        out.priceValue = toNum(m[0]);
        break;
      }
    }
  }

  const text = (document.body?.innerText || '').slice(0, 30000);
  if (out.stockQty == null) {
    const m = text.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*(?:pcs\.?|pieces|units)?\s*(?:in stock|available|on hand|can ship)/i) ||
      text.match(/(?:in stock|stock|available|quantity available)\s*[:\-]?\s*(\d{1,3}(?:,\d{3})+|\d+)/i);
    if (m) out.stockQty = toNum(m[1]);
  }
  if (!out.availability) {
    if (/out of stock|sold out|currently unavailable|no longer available|discontinued|obsolete/i.test(text)) out.availability = 'OutOfStock';
    else if (out.stockQty || /in stock|ships today|add to cart|add to basket|buy now/i.test(text)) out.availability = 'InStock';
  }
  if (out.availability) {
    const a = String(out.availability).trim().split('/').pop();
    const map = { instock: 'In stock', onlineonly: 'In stock', instoreonly: 'In stock', limitedavailability: 'Limited stock',
      outofstock: 'Out of stock', soldout: 'Out of stock', discontinued: 'Discontinued', preorder: 'Pre-order', backorder: 'Backorder' };
    out.availability = map[a.toLowerCase().replace(/[\s_-]/g, '')] || a.slice(0, 30);
  }
  // A quantity next to "out of stock" is some other number on the page.
  if (/out of stock|discontinued/i.test(out.availability || '')) out.stockQty = null;
  if (!out.currency && out.price && /₹|Rs\.?|INR/i.test(out.price)) out.currency = 'INR';
  if (out.priceValue != null && !out.price) out.price = `${out.currency || ''} ${out.priceValue}`.trim();
  out.title ||= document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.querySelector('h1')?.innerText.trim() || null;
  out.image ||= meta('og:image') || document.querySelector('[itemprop="image"]')?.getAttribute('src') || null;
  if (out.image) {
    try {
      out.image = new URL(out.image, location.href).href;
    } catch {
      out.image = null;
    }
  }
  // The page's own address without tracking parameters, when it declares one on the same site.
  const canon = document.querySelector('link[rel="canonical"]')?.href;
  try {
    if (canon && new URL(canon).hostname === location.hostname) out.canonical = canon;
  } catch { /* ignore */ }
  return out;
}

if (typeof module !== 'undefined') module.exports = { extractListings, extractGoogleWeb, extractProductInfo };
