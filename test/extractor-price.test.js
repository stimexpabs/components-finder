// The page scripts' price pattern (they run inside web pages, so they carry their own copy).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'extractor.js'), 'utf8');
const patterns = [...src.matchAll(/const PRICE_RE = (\/.*\/i);/g)].map((m) => eval(m[1]));

test('every page-script price pattern reads whole prices', () => {
  assert.strictEqual(patterns.length, 3);
  for (const re of patterns) {
    for (const [text, want] of [['₹ 1209', '₹ 1209'], ['₹1209.00', '₹1209.00'], ['Rs.13.51/-', 'Rs.13.51'], ['₹1,23,456', '₹1,23,456'],
      ['₹ 2,720.00', '₹ 2,720.00'], ['Rs 16/-', 'Rs 16'], ['1500 INR', '1500 INR']]) {
      assert.strictEqual(text.match(re)?.[0], want, `${re} on ${text}`);
    }
  }
});
