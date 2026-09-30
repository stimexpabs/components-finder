// extractProductInfo runs inside web pages; here it gets a minimal stand-in for the page.
const test = require('node:test');
const assert = require('node:assert');
const { extractProductInfo } = require('../src/renderer/extractor');

function withPage({ ld, text, title = 'Product' }, fn) {
  const scripts = ld ? [{ textContent: JSON.stringify(ld) }] : [];
  global.document = {
    title,
    body: { innerText: text },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes('ld+json') ? scripts : []),
  };
  global.location = { href: 'https://robu.in/product/x/', hostname: 'robu.in' };
  try {
    return fn();
  } finally {
    delete global.document;
    delete global.location;
  }
}

const product = (availability) => ({
  '@context': 'https://schema.org', '@type': 'Product', name: 'DHT11 Sensor',
  offers: { '@type': 'Offer', price: '59', priceCurrency: 'INR', availability: `https://schema.org/${availability}` },
});

test('the page’s visible availability wins over stale structured data (Robu DHT11: false back-in-stock)', () => {
  const info = withPage({ ld: product('InStock'), text: '₹ 59.00\n(Incl. GST)\nAvailability: Out of Stock\nNotify me' }, extractProductInfo);
  assert.strictEqual(info.availability, 'Out of stock');
  assert.strictEqual(info.priceValue, 59);
});

test('…and the other way round (Robu PM2.5 shown out of stock while the page said in stock)', () => {
  const info = withPage({ ld: product('OutOfStock'), text: '₹ 409.00\nAvailability: In Stock\nAdd to Cart' }, extractProductInfo);
  assert.strictEqual(info.availability, 'In stock');
});

test('without a visible availability line, structured data is used', () => {
  assert.strictEqual(withPage({ ld: product('OutOfStock'), text: '₹ 59.00\nAdd to wishlist' }, extractProductInfo).availability, 'Out of stock');
  assert.strictEqual(withPage({ ld: product('InStock'), text: '₹ 59.00' }, extractProductInfo).availability, 'In stock');
});

test('a stock count line is not mistaken for a status', () => {
  const info = withPage({ ld: product('InStock'), text: 'Stock: 37 units\nAvailability: 37 in stock' }, extractProductInfo);
  assert.strictEqual(info.availability, 'In stock');
  assert.strictEqual(info.stockQty, 37);
});
