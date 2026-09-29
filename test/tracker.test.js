const test = require('node:test');
const assert = require('node:assert');
const { applySnapshot, stockState, changeSinceStart } = require('../src/tracker');

const snap = (o) => ({ ok: true, currency: 'INR', ...o });
const types = (events) => events.map((e) => e.type);

test('first check sets the baseline without change events', () => {
  const item = { qty: 1, added: { priceValue: 102.66 } };
  assert.deepStrictEqual(applySnapshot(item, snap({ priceValue: 87, availability: 'In stock' }), 1000), []);
  assert.strictEqual(item.current.priceValue, 87);
  assert.strictEqual(item.history.length, 1);
});

test('price drop and rise are detected; drops notify', () => {
  const item = { qty: 1 };
  applySnapshot(item, snap({ priceValue: 100 }), 1);
  const drop = applySnapshot(item, snap({ priceValue: 90 }), 2);
  assert.deepStrictEqual(types(drop), ['price-drop']);
  assert.ok(drop[0].notify);
  assert.match(drop[0].text, /₹100 → ₹90 \(-10%\)/);
  const rise = applySnapshot(item, snap({ priceValue: 95 }), 3);
  assert.deepStrictEqual(types(rise), ['price-rise']);
  assert.ok(!rise[0].notify);
  assert.deepStrictEqual(types(applySnapshot(item, snap({ priceValue: 95 }), 4)), []);
  assert.strictEqual(Math.round(changeSinceStart(item) * 100), -5);
  assert.strictEqual(item.events.length, 2);
});

test('stock transitions: out, back in, and fewer left than needed', () => {
  const item = { qty: 50 };
  applySnapshot(item, snap({ priceValue: 10, availability: 'In stock', stockQty: 500 }), 1);
  assert.deepStrictEqual(types(applySnapshot(item, snap({ priceValue: 10, availability: 'Out of stock' }), 2)), ['out-of-stock']);
  assert.strictEqual(item.current.stockQty, 0);
  assert.deepStrictEqual(types(applySnapshot(item, snap({ priceValue: 10, availability: 'In stock', stockQty: 20 }), 3)), ['back-in-stock', 'low-stock']);
  // Still low: no repeat alert.
  assert.deepStrictEqual(types(applySnapshot(item, snap({ priceValue: 10, availability: 'In stock', stockQty: 18 }), 4)), []);
});

test('failed checks keep the last good state and flag after 3 in a row', () => {
  const item = { qty: 1 };
  applySnapshot(item, snap({ priceValue: 42 }), 1);
  applySnapshot(item, { ok: false, error: 'site blocked the check' }, 2);
  applySnapshot(item, { ok: false, error: 'site blocked the check' }, 3);
  const third = applySnapshot(item, { ok: false, error: 'site blocked the check' }, 4);
  assert.deepStrictEqual(types(third), ['unreachable']);
  assert.strictEqual(item.current.priceValue, 42);
  assert.strictEqual(item.current.lastError, 'site blocked the check');
  assert.strictEqual(item.history.length, 1);
  applySnapshot(item, snap({ priceValue: 42 }), 5);
  assert.strictEqual(item.failures, 0);
  assert.strictEqual(item.current.lastError, null);
});

test('a page without price keeps the previous price', () => {
  const item = { qty: 1 };
  applySnapshot(item, snap({ priceValue: 30, price: '₹30' }), 1);
  applySnapshot(item, snap({ priceValue: null, availability: 'In stock' }), 2);
  assert.strictEqual(item.current.priceValue, 30);
  assert.strictEqual(item.current.price, '₹30');
});

test('stockState reads availability text and quantity', () => {
  assert.strictEqual(stockState('In stock'), true);
  assert.strictEqual(stockState('Out of stock'), false);
  assert.strictEqual(stockState('Backorder'), false);
  assert.strictEqual(stockState(null, 12), true);
  assert.strictEqual(stockState(null, null), null);
});
