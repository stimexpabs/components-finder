const test = require('node:test');
const assert = require('node:assert');
const { parseTrusted, isTrusted, byPrice, byTrustThenPrice } = require('../src/renderer/trust');

const entries = parseTrusted(`
# my trusted sellers
robu.in
https://www.evelta.com/
digikey.in
DigiKey
Mouser
`);

test('parseTrusted splits domains from seller names and skips comments', () => {
  assert.deepStrictEqual(entries, [
    { kind: 'domain', value: 'robu.in' },
    { kind: 'domain', value: 'evelta.com' },
    { kind: 'domain', value: 'digikey.in' },
    { kind: 'name', value: 'DigiKey' },
    { kind: 'name', value: 'Mouser' },
  ]);
});

test('isTrusted matches by site, subdomain, seller name and Google redirect display URL', () => {
  const t = (item) => isTrusted(item, entries);
  assert.ok(t({ link: 'https://robu.in/product/x/', source: 'Robu.in' }));
  assert.ok(t({ link: 'https://www.evelta.com/y', source: 'Evelta' }));
  assert.ok(t({ link: null, source: 'DigiKey India', kind: 'shopping' })); // Google Shopping seller
  assert.ok(t({ link: null, source: 'Mouser India', kind: 'shopping' }));
  assert.ok(t({ link: 'https://www.google.com/goto?url=abc', displayUrl: 'https://robu.in/product/z', source: 'robu.in' }));
  // Google Shopping sellers by name, trusted through the domain entry.
  const more = parseTrusted('robocraze.com\nquartzcomponents.com\nprobots.co.in');
  assert.ok(isTrusted({ link: null, source: 'Robocraze', kind: 'shopping' }, more));
  assert.ok(isTrusted({ link: null, source: 'Quartz Components', kind: 'shopping' }, more));
  assert.ok(isTrusted({ link: null, source: 'Probots India', kind: 'shopping' }, more));
  assert.ok(!isTrusted({ link: 'https://robocrazy.example/x', source: 'Robocraze copy' }, more)); // has a site: judged by it
  assert.ok(!t({ link: 'https://notrobu.in/x', source: 'notrobu.in' }));
  assert.ok(!t({ link: 'https://www.amazon.in/x', source: 'amazon.in' }));
  assert.ok(!t({ link: null, source: 'eBay - seller123', kind: 'shopping' }));
});

test('trusted first, then cheapest, in stock before out of stock, unpriced last', () => {
  const items = [
    { id: 'a', source: 'random.in', link: 'https://random.in/a', priceValue: 50 },
    { id: 'b', source: 'Robu.in', link: 'https://robu.in/b', priceValue: 300 },
    { id: 'c', source: 'Robu.in', link: 'https://robu.in/c', priceValue: 120, availability: 'Out of stock' },
    { id: 'd', source: 'Evelta', link: 'https://evelta.com/d', priceValue: 120, availability: 'In stock' },
    { id: 'e', source: 'Evelta', link: 'https://evelta.com/e', priceValue: null },
    { id: 'f', source: 'cheap.in', link: 'https://cheap.in/f', priceValue: 10 },
  ];
  const trusted = (i) => isTrusted(i, entries);
  assert.deepStrictEqual([...items].sort(byTrustThenPrice(trusted)).map((i) => i.id), ['d', 'c', 'b', 'e', 'f', 'a']);
  assert.deepStrictEqual([...items].sort(byPrice(1, trusted)).map((i) => i.id), ['f', 'a', 'd', 'c', 'b', 'e']);
  assert.deepStrictEqual([...items].sort(byPrice(-1, trusted)).map((i) => i.id), ['b', 'd', 'c', 'a', 'f', 'e']);
});
