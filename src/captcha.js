// Google CAPTCHA pause (pure: no Electron).
// When Google asks for a CAPTCHA, the search pauses: the CAPTCHA opens in the browser pane
// (same session as the hidden windows), the user solves it, and every Google request that hit
// it retries. One CAPTCHA at a time, shared by all waiting requests. Skipped or not solved
// within CAPTCHA_WAIT_MS: those requests fail as before (DuckDuckGo fallback for stores).
let CAPTCHA_WAIT_MS = 3 * 60 * 1000;
let captchaGate = null; // { promise, resolve, url, timer }

function captchaDone(solved) {
  const gate = captchaGate;
  captchaGate = null;
  if (!gate) return;
  clearTimeout(gate.timer);
  gate.resolve(Boolean(solved));
}

async function viaGoogle(job, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.blocked || attempt >= 2 || job.isCancelled()) throw err;
      if (!captchaGate) {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        const gate = { promise, resolve, url: err.url };
        captchaGate = gate;
        gate.timer = setTimeout(() => captchaGate === gate && captchaDone(false), CAPTCHA_WAIT_MS);
      }
      job.emit('captcha', { url: captchaGate.url });
      const solved = await captchaGate.promise;
      if (!solved || job.isCancelled()) throw err;
    }
  }
}

const setWaitForTests = (ms) => { CAPTCHA_WAIT_MS = ms; };

module.exports = { viaGoogle, captchaDone, setWaitForTests };
