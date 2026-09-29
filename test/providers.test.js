const test = require('node:test');
const assert = require('node:assert');
const { WEB, SHOPPING, parsePrice, isListable } = require('../src/providers');

const search = (provider, args) => ({ serpapi: SHOPPING.serpapi })[provider](args);

function stubFetch(body, status = 200) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: status < 400, status, statusText: 'x', json: async () => body };
  };
  return calls;
}

test('parsePrice handles currency formats', () => {
  assert.deepStrictEqual(parsePrice('$1,234.50'), { price: '$1,234.50', priceValue: 1234.5, currency: 'USD' });
  assert.deepStrictEqual(parsePrice('Rs.13.51/-'), { price: 'Rs.13.51', priceValue: 13.51, currency: 'INR' });
  assert.strictEqual(parsePrice('₹ 1,23,456.00').priceValue, 123456);
  assert.strictEqual(parsePrice('Rs 16/-').currency, 'INR');
  assert.strictEqual(parsePrice('USD 3.2').priceValue, 3.2);
  assert.strictEqual(parsePrice('€0.45 each').priceValue, 0.45);
  assert.strictEqual(parsePrice('call for price').priceValue, null);
  assert.strictEqual(parsePrice(null).price, null);
});

test('serpapi normalizes shopping results', async () => {
  const calls = stubFetch({
    shopping_results: [{
      title: 'STM32F103C8T6 MCU', product_link: 'https://g.co/p/1', link: 'https://www.mouser.com/x',
      source: 'Mouser', price: '$4.12', extracted_price: 4.12, thumbnail: 't.png', rating: 4.7, delivery: 'Free delivery',
    }],
    serpapi_pagination: { next: 'n' },
  });
  const res = await search('serpapi', { query: 'stm32', page: 1, settings: { serpapiKey: 'k', country: 'gb' } });
  assert.match(calls[0], /engine=google_shopping/);
  assert.match(calls[0], /start=60/);
  assert.match(calls[0], /gl=gb/);
  assert.strictEqual(res.hasMore, true);
  assert.deepStrictEqual(res.items[0], {
    title: 'STM32F103C8T6 MCU', link: 'https://g.co/p/1', source: 'Mouser', price: '$4.12', priceValue: 4.12,
    currency: 'USD', thumbnail: 't.png', snippet: '', rating: 4.7, delivery: 'Free delivery',
  });
});

test('missing keys and API errors surface as errors', async () => {
  await assert.rejects(search('serpapi', { query: 'x', page: 0, settings: {} }), /SerpAPI key not set/);
  stubFetch({ error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' }, 401);
  await assert.rejects(WEB.serpapi({ query: 'x', page: 0, settings: { serpapiKey: 'bad' } }), /HTTP 401: Invalid API key/);
});

test('serpapi web search reads organic results and rich-snippet prices', async () => {
  const calls = stubFetch({
    organic_results: [
      { title: 'LM7805CT/NOPB Texas Instruments | DigiKey', link: 'https://www.digikey.com/en/products/detail/x', snippet: 'Linear regulator',
        rich_snippet: { top: { extensions: ['$1.03', 'In stock'], detected_extensions: { price: 1.03, currency: '$' } } } },
      { title: 'LM7805 – LCSC', link: 'https://www.lcsc.com/product-detail/y.html', snippet: 'Buy LM7805 at LCSC' },
    ],
  });
  const res = await WEB.serpapi({ query: 'LM7805 buy', page: 2, settings: { serpapiKey: 'k' } });
  assert.match(calls[0], /engine=google&/);
  assert.match(calls[0], /start=20/);
  assert.strictEqual(res.items[0].priceValue, 1.03);
  assert.strictEqual(res.items[0].availability, 'In stock');
  assert.strictEqual(res.items[0].source, 'digikey.com');
  assert.strictEqual(res.items[1].priceValue, null);
  assert.strictEqual(res.hasMore, false);
});

test('isListable drops PDFs, video/social sites and junk', () => {
  assert.ok(isListable('https://www.mouser.com/ProductDetail/511-L7805CV'));
  assert.ok(!isListable('https://www.ti.com/lit/ds/symlink/lm7805.pdf'));
  assert.ok(!isListable('https://www.youtube.com/watch?v=1'));
  assert.ok(!isListable('https://en.wikipedia.org/wiki/78xx'));
  assert.ok(!isListable('javascript:void(0)'));
  assert.ok(!isListable(null));
});
