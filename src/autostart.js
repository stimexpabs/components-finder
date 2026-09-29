// Start at login, straight into the tray (--hidden).
// Linux: an XDG autostart entry (~/.config/autostart). macOS/Windows: Electron's login items.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HIDDEN_FLAG = '--hidden';
const isLinux = process.platform === 'linux';

const desktopFile = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'components-finder.desktop');

// The command that relaunches this app: the AppImage file itself (its contents are mounted at
// a new temporary path every run), the packaged binary, or electron + project folder in dev.
const launchArgs = () => {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  return app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
};

// An icon path that outlives this run (packaged files live in a temporary mount / asar).
function stableIcon() {
  const src = path.join(__dirname, '..', 'assets', 'icon.png');
  if (!app.isPackaged) return src;
  const dest = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'icons', 'components-finder.png');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(src));
    return dest;
  } catch {
    return 'components-finder';
  }
}

// Desktop Entry Exec quoting: wrap in double quotes, escape " ` $ \
const quote = (arg) => `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;

function isEnabled() {
  if (isLinux) {
    try {
      return !/^Hidden=true/m.test(fs.readFileSync(desktopFile(), 'utf8'));
    } catch {
      return false;
    }
  }
  return app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin;
}

function setEnabled(on) {
  if (!isLinux) {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: on, args: [HIDDEN_FLAG] });
    return isEnabled();
  }
  if (!on) {
    fs.rmSync(desktopFile(), { force: true });
    return false;
  }
  fs.mkdirSync(path.dirname(desktopFile()), { recursive: true });
  fs.writeFileSync(desktopFile(), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Components Finder',
    'Comment=Tracks price and stock of the components in your cart',
    `Exec=${[...launchArgs(), HIDDEN_FLAG].map(quote).join(' ')}`,
    `Icon=${stableIcon()}`,
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n'));
  return true;
}

// Launched by the login entry (or asked to start in the tray).
const startedHidden = () => process.argv.includes(HIDDEN_FLAG) ||
  (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);

module.exports = { isEnabled, setEnabled, startedHidden };
