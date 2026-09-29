const test = require('node:test');
const assert = require('node:assert');
const { isRelevant, inrVerdict } = require('../src/filters');
const { currencyCode } = require('../src/providers');
const { parseStores, formatStores, storeSearchUrl, storeHost, templateFrom, DEFAULT_STORES } = require('../src/stores');

test('currencyCode recognises INR spellings', () => {
  for (const t of ['₹90.80', 'Rs.13.51/-', 'Rs 16', 'INR 500', 'INR']) assert.strictEqual(currencyCode(t), 'INR', t);
  assert.strictEqual(currencyCode('$4.12'), 'USD');
  assert.strictEqual(currencyCode('€3'), 'EUR');
  assert.strictEqual(currencyCode('PLN 22.76'), 'PLN');
  assert.strictEqual(currencyCode('12.00'), null);
});

test('isRelevant keeps matching parts and drops store padding', () => {
  assert.ok(isRelevant('LM7805 5V Positive Voltage Regulator IC', 'LM7805'));
  assert.ok(isRelevant('ESP 32 Development Board CP2102', 'ESP32'));
  assert.ok(isRelevant('10K Ohm 0603 SMD Resistor (Pack of 100)', '10k 0603 resistor'));
  assert.ok(!isRelevant('AMS1117 5 Volt SOT223 Voltage Regulator IC', 'LM7805'));
  assert.ok(!isRelevant('M2 x 10mm Female to Female Nylon Hexagonal Spacer', 'LM7805'));
  assert.ok(isRelevant('Arduino Uno R3 Board', 'arduino uno'));
  assert.ok(!isRelevant('Raspberry Pi 5', 'arduino uno'));
});

test('inrVerdict: INR price keeps, other currency drops, unknown judged by site', () => {
  const stores = new Set(['evelta.com']);
  assert.strictEqual(inrVerdict({ currency: 'INR' }, stores), true);
  assert.strictEqual(inrVerdict({ currency: 'USD', link: 'https://robu.in/x' }, stores), false);
  assert.strictEqual(inrVerdict({ checking: true, link: 'https://mouser.com/x' }, stores), null);
  assert.strictEqual(inrVerdict({ link: 'https://www.sunrom.com/x' }, stores), false);
  assert.strictEqual(inrVerdict({ link: 'https://robokits.co.in/x' }, stores), true);
  assert.strictEqual(inrVerdict({ link: 'https://evelta.com/x' }, stores), true);
  // Google redirect link: judge by the displayed URL.
  assert.strictEqual(inrVerdict({ link: 'https://www.google.com/goto?url=abc', displayUrl: 'https://www.ktron.in/p' }, stores), true);
});

test('store list parses, round-trips and builds search URLs', () => {
  const stores = parseStores('Robu.in | https://robu.in/?s={q}&post_type=product\nhttps://shop.example.in/search?q={q}\nbad line\nDNA | https://www.dnatechindia.com/\nstemvolt.in');
  assert.deepStrictEqual(stores.map((s) => s.name), ['Robu.in', 'shop.example.in', 'DNA', 'stemvolt.in']);
  assert.deepStrictEqual(stores[2], { name: 'DNA', home: 'https://www.dnatechindia.com/' });
  assert.deepStrictEqual(stores[3], { name: 'stemvolt.in', home: 'https://stemvolt.in' });
  assert.strictEqual(storeHost(stores[2]), 'dnatechindia.com');
  assert.strictEqual(storeSearchUrl(stores[0], '10k 0603'), 'https://robu.in/?s=10k%200603&post_type=product');
  assert.deepStrictEqual(parseStores(formatStores(DEFAULT_STORES)), DEFAULT_STORES);
  assert.strictEqual(DEFAULT_STORES.length, 19);
});

test('templateFrom learns a reusable search URL from where the search box led', () => {
  assert.strictEqual(templateFrom('https://robu.in/?s=LM7805&post_type=product', 'LM7805'), 'https://robu.in/?s={q}&post_type=product');
  assert.strictEqual(templateFrom('https://probots.co.in/search/LM7805', 'lm7805'), 'https://probots.co.in/search/{q}');
  assert.strictEqual(templateFrom('https://x.in/search?type=product&q=10k+0603', '10k 0603'), 'https://x.in/search?type=product&q={q}');
  assert.strictEqual(templateFrom('https://x.in/products/lm7805-regulator', 'LM7805'), null);
  assert.strictEqual(templateFrom('not a url', 'x'), null);
});
