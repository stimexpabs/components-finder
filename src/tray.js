// Tray icon: keeps the app (and the hourly cart checks) running with the window closed.
const { Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

let tray = null;
let actions = null;
let lastKey = '';

const money = (v) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function create(opts) {
  actions = opts; // { showWindow, checkNow, getCart, autostart, quit }
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', process.platform === 'darwin' ? 'icon-16.png' : 'icon-32.png'));
  tray = new Tray(icon);
  tray.on('click', actions.showWindow); // Windows/macOS; Linux indicators use the menu
  update();
  return tray;
}

// Rebuild the menu when what it shows changes (cart events arrive in bursts).
function update() {
  if (!tray) return;
  const c = actions.getCart();
  const priced = c.items.map((i) => (i.current?.priceValue != null ? i.current : i.added)).filter((p) => p?.priceValue != null);
  const total = c.items.reduce((sum, i) => {
    const p = i.current?.priceValue ?? i.added?.priceValue;
    return p != null ? sum + p * (i.qty || 1) : sum;
  }, 0);
  const cartLine = c.items.length
    ? `Cart: ${c.items.length} item${c.items.length > 1 ? 's' : ''}${priced.length ? ` · ${money(total)}` : ''}`
    : 'Cart is empty';
  const nextLine = c.running ? 'Checking prices & stock…'
    : c.nextRun ? `Next check ${new Date(c.nextRun).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : '';
  const autostartOn = actions.autostart.isEnabled();
  const key = [cartLine, nextLine, autostartOn, c.running].join('|');
  if (key === lastKey) return;
  lastKey = key;

  tray.setToolTip(`Components Finder\n${cartLine}${nextLine ? `\n${nextLine}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Components Finder', click: actions.showWindow },
    { type: 'separator' },
    { label: cartLine, enabled: false },
    ...(nextLine ? [{ label: nextLine, enabled: false }] : []),
    { label: 'Check cart now', enabled: c.items.length > 0 && !c.running, click: actions.checkNow },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: autostartOn,
      click: (item) => {
        actions.autostart.setEnabled(item.checked);
        lastKey = '';
        update();
      },
    },
    { label: 'Quit', click: actions.quit },
  ]));
}

module.exports = { create, update, exists: () => Boolean(tray) };
