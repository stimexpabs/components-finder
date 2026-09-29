const test = require('node:test');
const assert = require('node:assert');
const { viaGoogle, captchaDone, setWaitForTests } = require('../src/captcha');

const blocked = () => Object.assign(new Error('captcha'), { blocked: true, url: 'https://www.google.com/search?q=x' });
const job = () => {
  const events = [];
  return { events, isCancelled: () => false, emit: (type, data) => events.push({ type, ...data }) };
};

test('a CAPTCHA pauses; once solved the request retries and returns results', async () => {
  const j = job();
  let calls = 0;
  const p = viaGoogle(j, async () => {
    calls++;
    if (calls === 1) throw blocked();
    return 'results';
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(j.events, [{ type: 'captcha', url: 'https://www.google.com/search?q=x' }]);
  captchaDone(true);
  assert.strictEqual(await p, 'results');
  assert.strictEqual(calls, 2);
});

test('several requests blocked at once share one CAPTCHA', async () => {
  const j = job();
  const tries = { a: 0, b: 0 };
  const req = (k) => viaGoogle(j, async () => {
    tries[k]++;
    if (tries[k] === 1) throw blocked();
    return k;
  });
  const both = Promise.all([req('a'), req('b')]);
  await new Promise((r) => setTimeout(r, 20));
  captchaDone(true);
  assert.deepStrictEqual(await both, ['a', 'b']);
});

test('skipping the CAPTCHA fails the request as before', async () => {
  const j = job();
  const p = viaGoogle(j, async () => { throw blocked(); });
  await new Promise((r) => setTimeout(r, 20));
  captchaDone(false);
  await assert.rejects(p, (e) => e.blocked);
});

test('not solved in time: gives up', async () => {
  setWaitForTests(50);
  const j = job();
  await assert.rejects(viaGoogle(j, async () => { throw blocked(); }), (e) => e.blocked);
  setWaitForTests(3 * 60 * 1000);
});

test('other errors pass straight through without a CAPTCHA', async () => {
  const j = job();
  await assert.rejects(viaGoogle(j, async () => { throw new Error('offline'); }), /offline/);
  assert.strictEqual(j.events.length, 0);
});
