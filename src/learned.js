// Search URLs learned by typing into a store's search box, per host, so the next search of
// that store can go straight to its results page. Stored in <userData>/learned-searches.json.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const file = () => path.join(app.getPath('userData'), 'learned-searches.json');
let cache = null;

function all() {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      cache = {};
    }
  }
  return cache;
}

const get = (host) => all()[host] || null;

function set(host, template) {
  if (all()[host] === template) return;
  cache[host] = template;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function forget(host) {
  if (!(host in all())) return;
  delete cache[host];
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

module.exports = { get, set, forget };
