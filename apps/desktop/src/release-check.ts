// Release signature check for desktop updates (FR-CLI-05, NFR-SEC-10). electron-updater only
// checks the hash in latest.yml, which anyone who controls the feed can rewrite; this checks the
// downloaded installer against the Ed25519-signed release manifest before it may be installed.
import { createHash } from 'node:crypto';
import { compareVersions, ReleaseError, verifyRelease, type ReleaseFile } from '@advence/protocol';

export interface CheckedUpdate { version: string; file: ReleaseFile }

/**
 * Returns the manifest entry of the downloaded file, or throws ReleaseError. The manifest must
 * be signed by a pinned key, name the version electron-updater downloaded, be newer than the
 * running app, and list a file with exactly the downloaded bytes.
 */
export function checkDownloadedUpdate(o: { manifest: Uint8Array; signature: string; keys: string[]; version: string; current: string; file: Uint8Array }): CheckedUpdate {
  const m = verifyRelease(o.manifest, o.signature, o.keys, 'desktop');
  if (m.version !== o.version) throw new ReleaseError('bad_manifest', `signed release is ${m.version}, download is ${o.version}`);
  if (compareVersions(m.version, o.current) <= 0) throw new ReleaseError('bad_manifest', 'not newer than this app');
  const sha = createHash('sha256').update(o.file).digest('hex');
  const f = m.files.find((x) => x.sha256 === sha && x.size === o.file.length);
  if (!f) throw new ReleaseError('bad_hash');
  return { version: m.version, file: f };
}

/** The installer for this platform in a signed manifest (macOS: the DMG, opened by the user). */
export function installerFor(files: ReleaseFile[], platform: NodeJS.Platform): ReleaseFile | undefined {
  const ext = platform === 'darwin' ? '.dmg' : platform === 'win32' ? '.exe' : '.AppImage';
  return files.find((f) => f.name.endsWith(ext));
}
