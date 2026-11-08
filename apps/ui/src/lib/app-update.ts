// Android app updates (D-24, FR-CLI-05): the signed manifest comes from the build's feed through
// the AppUpdate plugin, its Ed25519 signature is checked here against the key pinned in the APK,
// and only a verified entry (name, SHA-256, size) is passed to the plugin, which downloads the APK,
// checks those values natively and opens the system installer.
import { compareVersions, verifyRelease, type ReleaseFile } from '@advence/protocol';

const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export interface AppUpdate { version: string; notes: string; file: ReleaseFile }

export interface AppUpdatePluginApi {
  info(): Promise<{ feedUrl: string; releaseKeys: string; versionCode: number; versionName: string }>;
  fetchManifest(o: { file: 'manifest.json' | 'manifest.json.sig' }): Promise<{ base64: string }>;
  install(o: { name: string; sha256: string; size: number }): Promise<void>;
}

/** Returns the newer signed release, null when up to date or not set up; throws ReleaseError. */
export async function checkAppUpdate(p: AppUpdatePluginApi): Promise<AppUpdate | null> {
  const info = await p.info();
  const keys = info.releaseKeys.split(',').map((k) => k.trim()).filter(Boolean);
  if (!info.feedUrl.startsWith('https://') || !keys.length) return null;
  const [m, s] = await Promise.all([p.fetchManifest({ file: 'manifest.json' }), p.fetchManifest({ file: 'manifest.json.sig' })]);
  const manifest = verifyRelease(fromB64(m.base64), new TextDecoder().decode(fromB64(s.base64)), keys, 'android');
  const newer = manifest.versionCode !== undefined ? manifest.versionCode > info.versionCode : compareVersions(manifest.version, info.versionName) > 0;
  if (!newer) return null;
  const apks = manifest.files.filter((f) => f.name.endsWith('.apk'));
  const file = apks.find((f) => f.name.includes('universal')) ?? apks[0];
  return file ? { version: manifest.version, notes: manifest.notes, file } : null;
}

export function installAppUpdate(p: AppUpdatePluginApi, u: AppUpdate): Promise<void> {
  return p.install({ name: u.file.name, sha256: u.file.sha256, size: u.file.size });
}
