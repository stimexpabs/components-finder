const { app, BrowserWindow, ipcMain, shell, dialog, session, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startSearch, addExtracted, searchOneStore, captchaDone } = require('./search');
const { PARTITION } = require('./crawler');
const { DEFAULT_STORES, formatStores } = require('./stores');

// Trusted sellers: your stores plus authorised distributors (names match Google Shopping sellers).
const DEFAULT_TRUSTED = [
  '# Domains (the listing\'s site) or seller names, one per line',
  ...DEFAULT_STORES.map((s) => new URL(s.search.replace('{q}', 'x')).hostname.replace(/^www\./, '')),
  'digikey.in', 'mouser.in', 'in.element14.com', 'in.rsdelivers.com',
  'DigiKey', 'Mouser', 'element14', 'RS India',
].join('\n');
const cart = require('./cart');
const tray = require('./tray');
const autostart = require('./autostart');

// Keep the data folder ~/.config/components-finder whether run from source or packaged
// (a packaged app would otherwise name it after the product name, "Components Finder").
if (path.basename(app.getPath('userData')) === 'Components Finder') {
  app.setPath('userData', path.join(app.getPath('appData'), 'components-finder'));
}

let mainWindow = null;
const TOPBAR_HEIGHT = 52; // keep in sync with .topbar height in styles.css
let quitting = false;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  provider: 'browser',
  serpapiKey: '',
  country: 'in',
  inrOnly: true, // keep only listings priced in INR; searches Google as India
  useStores: true, // search the stores below directly, via their own site search
  stores: formatStores(DEFAULT_STORES),
  trustedSites: DEFAULT_TRUSTED, // sellers you trust: "Trusted first" sort, ✓ badge, "Trusted only" filter
  webSuffix: 'buy', // extra words for the Google web search, to favour shop pages over datasheets
  webPages: 3, // Google result pages per search in browser mode
  includeShopping: true,
  maxChecks: 40, // listing pages opened per search to read price/stock
  storePages: 3, // result pages read per store (follows its "next page" links)
  siteSearchFallback: true, // store search blocked -> find its products via DuckDuckGo/Google site: search
  trackEveryMinutes: 60, // how often cart items are re-checked
  keepInTray: true, // closing the window hides it to the tray; cart checks keep running
  trayHintShown: false,
};

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch { /* first run */ }
  // Google Custom Search (closed to new customers) was removed; drop its leftovers.
  const { googleKey, googleCx, ...rest } = saved;
  const settings = { ...DEFAULT_SETTINGS, ...rest };
  if (!['browser', 'serpapi'].includes(settings.provider)) settings.provider = DEFAULT_SETTINGS.provider;
  return settings;
}

function saveSettings(s) {
  const { startAtLogin, ...merged } = { ...loadSettings(), ...s };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

function createWindow({ show = true } = {}) {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show,
    title: 'Components Finder',
    // No system title bar: the app's top bar takes its place, with the window buttons
    // (minimize / maximize / close) drawn over its right end.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#161a21', symbolColor: '#e6e9ef', height: TOPBAR_HEIGHT - 1 }, // -1: keep the bar's bottom border visible
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Close = hide to tray, so the hourly cart checks keep running. Quit from the tray menu.
  win.on('close', (e) => {
    if (quitting || !tray.exists() || !loadSettings().keepInTray) return;
    e.preventDefault();
    win.hide();
    if (!loadSettings().trayHintShown && Notification.isSupported()) {
      new Notification({
        title: 'Components Finder is still running',
        body: 'Cart items keep being checked in the background. Quit from the tray icon.',
      }).show();
      saveSettings({ trayHintShown: true });
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function showWindow() {
  const win = mainWindow || createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit() {
  quitting = true;
  app.quit();
}

// Lock down the embedded browser: no node, no preload injected by pages.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_ev, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
  // Links that open a new window (target=_blank) load in the same webview instead — but
  // only right after a click or key press, so a page's own pop-ups can't take over the pane.
  if (contents.getType() === 'webview') {
    let lastInput = 0;
    contents.on('input-event', (_ev, input) => {
      if (/mouseDown|mouseUp|keyDown|rawKeyDown|gestureTap/i.test(input.type)) lastInput = Date.now();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (Date.now() - lastInput < 2000 && /^https?:/.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
  }
});

// "Start at login" lives in the OS (autostart entry / login items), not in settings.json.
ipcMain.handle('settings:get', () => ({ ...loadSettings(), startAtLogin: autostart.isEnabled() }));
ipcMain.handle('settings:set', (_e, { startAtLogin, ...s }) => {
  const saved = saveSettings(s);
  if (startAtLogin !== undefined && startAtLogin !== autostart.isEnabled()) autostart.setEnabled(startAtLogin);
  cart.schedule(); // the check interval may have changed
  tray.update();
  return { ...saved, startAtLogin: autostart.isEnabled() };
});

ipcMain.handle('cart:get', () => cart.snapshot());
ipcMain.handle('cart:add', (_e, listing) => cart.add(listing));
ipcMain.handle('cart:remove', (_e, id) => cart.remove(id));
ipcMain.handle('cart:qty', (_e, id, qty) => cart.setQty(id, qty));
ipcMain.handle('cart:check', (_e, id) => {
  cart.checkNow(id);
});

ipcMain.handle('search', (e, { query, page = 0 }) => startSearch(e.sender, { query, page }, loadSettings()));
ipcMain.handle('add-extracted', (e, items) => addExtracted(e.sender, items, loadSettings()));
ipcMain.handle('captcha:done', (_e, solved) => captchaDone(solved));
ipcMain.handle('search-store', (e, store, query) => searchOneStore(e.sender, store, query, loadSettings()));

ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle('export-csv', async (_e, csv) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: 'components.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, csv);
  return filePath;
});

// One instance only: launching again (e.g. from the menu while it sits in the tray) shows it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });

  app.whenReady().then(() => {
    // Present as plain Chrome (drop the Electron/app tokens) so sites serve their normal pages.
    const ses = session.fromPartition(PARTITION);
    // Drops the "Electron/…" token and the app's own name/version (whatever the product name is).
    ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/(\(KHTML, like Gecko\)) .*?(Chrome\/)/, '$1 $2'));
    try {
      tray.create({ showWindow, checkNow: () => cart.checkNow(), getCart: cart.snapshot, autostart, quit });
    } catch (err) {
      console.error('Tray unavailable, closing the window will quit:', err.message);
    }
    // Started at login: stay in the tray (only if there is a tray to come back from).
    createWindow({ show: !(autostart.startedHidden() && tray.exists()) });
    cart.onChange(() => tray.update());
    cart.init(loadSettings);
    app.on('activate', showWindow);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
