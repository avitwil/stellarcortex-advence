// Electron main process (D-04, NFR-SEC-07). The UI is always bundled inside the app and
// loaded from app://advence; it is never fetched from a server.
import { app, BrowserWindow, protocol, session, ipcMain, safeStorage, shell, Notification, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PinStore } from './pin';
import { PinnedNet } from './net';
import { waitForOAuthCode } from './oauth';
import { startUpdater } from './updater';

const APP_ORIGIN = 'app://advence';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const pins = new PinStore();
const pnet = new PinnedNet(pins);

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.enableSandbox();

function uiRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.resolve(__dirname, '../../ui/dist');
}

function secretsDir(): string {
  const d = path.join(app.getPath('userData'), 'secrets');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function secretFile(name: string): string {
  if (!/^[A-Za-z0-9:#._\-[\]]{1,200}$/.test(name)) throw new Error('bad secret name');
  return path.join(secretsDir(), Buffer.from(name).toString('base64url') + '.bin');
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'StellarCortex Advence',
    backgroundColor: '#0b0c10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      webviewTag: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  // The renderer has no direct network access to servers: pinned traffic goes through
  // PinnedNet in this process. Any other certificate is verified normally by Chromium.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications' || permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'notifications' || permission === 'clipboard-sanitized-write');

  protocol.handle('app', async (request) => {
    const u = new URL(request.url);
    const root = uiRoot();
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, rel);
    if (u.host !== 'advence' || !file.startsWith(root + path.sep)) return new Response('not found', { status: 404 });
    const target = fs.existsSync(file) ? file : path.join(root, 'index.html');
    const res = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(res.headers);
    headers.set('content-security-policy', CSP);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });

  ipcMain.handle('trustServer', (_e, host: string, pin: string) => {
    if (pins.set(String(host), String(pin))) pnet.closeAll();
  });
  ipcMain.handle('http', (_e, req: { url: string; method: string; headers: Record<string, string>; body?: string }) => pnet.request(req));
  ipcMain.handle('wsOpen', (e, id: string, url: string) => pnet.wsOpen(String(id), String(url), (ev) => !e.sender.isDestroyed() && e.sender.send('wsEvent', ev)));
  ipcMain.on('wsSend', (_e, id: string, data: string) => pnet.wsSend(String(id), String(data)));
  ipcMain.on('wsClose', (_e, id: string) => pnet.wsClose(String(id)));
  // Device keys are encrypted by the OS keystore (DPAPI, Keychain, libsecret/kwallet).
  // On a Linux desktop with no keyring the file falls back to owner-only permissions (DL-018).
  ipcMain.handle('loadSecret', async (_e, name: string) => {
    const f = secretFile(String(name));
    if (fs.existsSync(f)) {
      const r = await safeStorage.decryptStringAsync(fs.readFileSync(f));
      return typeof r === 'string' ? r : r.result;
    }
    if (fs.existsSync(f + '.plain')) return fs.readFileSync(f + '.plain', 'utf8');
    return null;
  });
  ipcMain.handle('saveSecret', async (_e, name: string, value: string) => {
    const f = secretFile(String(name));
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
    if ((await safeStorage.isAsyncEncryptionAvailable()) && backend !== 'basic_text') {
      fs.writeFileSync(f, await safeStorage.encryptStringAsync(String(value)), { mode: 0o600 });
    } else {
      fs.writeFileSync(f + '.plain', String(value), { mode: 0o600 });
    }
  });
  ipcMain.handle('deleteSecret', (_e, name: string) => {
    const f = secretFile(String(name));
    fs.rmSync(f, { force: true });
    fs.rmSync(f + '.plain', { force: true });
  });
  ipcMain.handle('oauthLoopback', async (_e, authUrl: string) => {
    const u = new URL(String(authUrl));
    if (u.protocol !== 'https:') throw new Error('auth url must be https');
    const w = waitForOAuthCode();
    await w.ready;
    // If no browser can be opened, the receiver still times out after 5 minutes.
    shell.openExternal(u.toString()).catch(() => undefined);
    return w.result;
  });
  ipcMain.handle('openExternal', (_e, url: string) => {
    const u = new URL(String(url));
    if (u.protocol === 'https:') return shell.openExternal(u.toString());
  });
  ipcMain.on('notify', (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 500) }).show();
  });

  createWindow();
  startUpdater();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
});
