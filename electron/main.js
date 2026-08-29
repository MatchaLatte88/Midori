import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { TITLEBAR, TITLEBAR_HEIGHT } from './titlebar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = 'http://localhost:5300';
const isDev = !app.isPackaged;

let win = null;

function createWindow() {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: TITLEBAR[theme].color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...TITLEBAR[theme], height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // A renderer error that only appears in DevTools is an error nobody sees when
  // the app is started from a script. Mirror warnings and errors to the terminal.
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : '';
      console.error(`[renderer:${details.level}] ${details.message}${where}`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
  });
  win.webContents.on('render-process-gone', (_e, gone) => {
    console.error(`[renderer] process gone: ${gone.reason} (exit ${gone.exitCode})`);
  });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

/* The renderer owns the theme, because only it knows whether the user chose
 * light, dark, or to follow the system. The window is created with the OS
 * setting as the best guess for the first frame; the renderer corrects it on
 * mount and on every change after that, including a system change while the
 * mode is "system". One source of truth, so the two cannot disagree — which is
 * why there is no nativeTheme listener here. */

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
