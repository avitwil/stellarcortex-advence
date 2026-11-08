// Desktop auto-update (D-24, FR-CLI-05): electron-updater against the self-hosted static feed set
// at build time. Nothing is installed until the downloaded installer matches the Ed25519-signed
// release manifest checked against the release key pinned in this build (NFR-SEC-10).
// Windows and Linux: electron-updater downloads, we verify, then we install on quit (or now).
// electron-updater's own install-on-quit stays off: it would install whatever file it downloaded
// last, verified or not. We install only the file we verified, after hashing it again.
// macOS: Squirrel.Mac only accepts Developer ID signed apps (paid, C-04), so the app downloads
// the DMG itself, verifies it the same way, and offers to open it (DL-071).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, net, Notification, shell } from 'electron';
import { compareVersions, fileMatches, verifyRelease } from '@advence/protocol';
import { checkDownloadedUpdate, fetchLimited, installerFor } from './release-check';

export const FEED_URL = (process.env.ADVENCE_FEED_URL_BUILD ?? '').replace(/\/+$/, '');
const KEYS = (process.env.ADVENCE_RELEASE_PUBKEY_BUILD ?? '').split(',').map((k) => k.trim()).filter(Boolean);
const CHECK_EVERY_MS = 6 * 3600_000;

const he = () => app.getLocale().startsWith('he');
const text = {
  ready: (v: string) => (he() ? [`עדכון ${v} מוכן`, 'הוא יותקן כשתצאו מהאפליקציה. לחצו כדי להפעיל מחדש עכשיו.'] : [`Update ${v} is ready`, 'It installs when you quit the app. Click to restart now.']),
  dmg: (v: string) => (he() ? [`עדכון ${v} הורד ונבדק`, 'לחצו כדי לפתוח את קובץ ההתקנה.'] : [`Update ${v} downloaded and verified`, 'Click to open the installer.']),
};

function notify([title, body]: string[], onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title!, body: body! });
  n.on('click', onClick);
  n.show();
}

const fetchBytes = (url: string, max: number, ms?: number) => fetchLimited(net.fetch as typeof fetch, url, max, ms);

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function signedManifest(): Promise<{ manifest: Uint8Array; signature: string }> {
  const [manifest, sig] = await Promise.all([fetchBytes(`${FEED_URL}/desktop-manifest.json`, 256 * 1024), fetchBytes(`${FEED_URL}/desktop-manifest.json.sig`, 1024)]);
  return { manifest, signature: new TextDecoder().decode(sig) };
}

let offered = '';

async function checkMac(): Promise<void> {
  const { manifest, signature } = await signedManifest();
  const m = verifyRelease(manifest, signature, KEYS, 'desktop');
  if (compareVersions(m.version, app.getVersion()) <= 0 || offered === m.version) return;
  const f = installerFor(m.files, 'darwin');
  if (!f) return;
  const bytes = await fetchBytes(`${FEED_URL}/${encodeURIComponent(f.name)}`, f.size, 15 * 60_000);
  if (!fileMatches(f, bytes)) throw new Error('downloaded installer does not match the signed release');
  const out = path.join(app.getPath('downloads'), f.name);
  fs.writeFileSync(out, bytes);
  offered = m.version;
  notify(text.dmg(m.version), () => void shell.openPath(out));
}

async function startElectronUpdater(): Promise<() => void> {
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL });
  autoUpdater.autoDownload = true;
  // Never let electron-updater install by itself (see the top of this file).
  autoUpdater.autoInstallOnAppQuit = false;
  let verified: { file: string; sha256: string; version: string } | null = null;
  let installing = false;
  const install = (): boolean => {
    if (!verified || installing) return false;
    try {
      if (sha256(new Uint8Array(fs.readFileSync(verified.file))) !== verified.sha256) throw new Error('changed after it was verified');
    } catch (e) {
      console.error(`update ${verified.version} not installed: ${(e as Error).message}`);
      verified = null;
      return false;
    }
    installing = true;
    autoUpdater.quitAndInstall();
    return true;
  };
  autoUpdater.on('update-available', () => {
    verified = null;
  });
  autoUpdater.on('update-downloaded', (info) => {
    verified = null;
    void (async () => {
      try {
        const { manifest, signature } = await signedManifest();
        const file = new Uint8Array(await fs.promises.readFile(info.downloadedFile));
        const ok = checkDownloadedUpdate({ manifest, signature, keys: KEYS, version: info.version, current: app.getVersion(), file });
        verified = { file: info.downloadedFile, sha256: sha256(file), version: ok.version };
        // Keep the verified file as the one electron-updater installs until the app restarts.
        autoUpdater.autoDownload = false;
        if (offered !== ok.version) notify(text.ready(ok.version), () => void install());
        offered = ok.version;
      } catch (e) {
        fs.rmSync(info.downloadedFile, { force: true });
        console.error(`update ${info.version} rejected: ${(e as { code?: string }).code ?? (e as Error).message}`);
      }
    })();
  });
  app.on('before-quit', (e) => {
    if (!verified || installing) return;
    e.preventDefault();
    if (!install()) app.quit();
  });
  autoUpdater.on('error', (e) => console.error(`update check failed: ${e.message}`));
  return () => void autoUpdater.checkForUpdates().catch(() => undefined);
}

export function startUpdater(): void {
  if (!app.isPackaged || !FEED_URL.startsWith('https://') || !KEYS.length) return;
  const ready = process.platform === 'darwin' ? Promise.resolve(() => void checkMac().catch((e: Error) => console.error(`update check failed: ${e.message}`))) : startElectronUpdater();
  void ready.then((check) => {
    setTimeout(check, 30_000);
    setInterval(check, CHECK_EVERY_MS);
  });
}
