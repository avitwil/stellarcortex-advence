// Values fixed at build time (FR-GGL-01, D-24). A release bundle carries `build-info.json` next
// to its `server/` folder; a development checkout has none and falls back to the environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANDROID_PACKAGE = 'com.stellarcortex.advence';

export interface BuildInfo {
  version: string;
  /** pinned Ed25519 release public keys, base64url (NFR-SEC-10) */
  releaseKeys: string[];
  /** self-hosted static update feed (D-24); empty disables update checks */
  feedUrl: string;
  /** SHA-1 of the release APK signing certificate */
  androidSha1: string;
  /** true when running from an installed release bundle */
  bundled: boolean;
}

const DEV_VERSION = '0.1.0';

/** <bundle>/server/{dist,src}/build-info.js -> <bundle>/build-info.json */
export function bundleRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

export function loadBuildInfo(file = path.join(bundleRoot(), 'build-info.json'), env = process.env): BuildInfo {
  let raw: Partial<BuildInfo> = {};
  let bundled = false;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BuildInfo>;
    bundled = true;
  } catch {
    /* development checkout */
  }
  const keys = raw.releaseKeys?.length ? raw.releaseKeys : (env.ADVENCE_RELEASE_PUBKEY ?? '').split(',');
  return {
    version: typeof raw.version === 'string' ? raw.version : DEV_VERSION,
    releaseKeys: keys.map((k) => k.trim()).filter(Boolean),
    feedUrl: (raw.feedUrl ?? env.ADVENCE_FEED_URL ?? '').replace(/\/+$/, ''),
    androidSha1: raw.androidSha1 || env.ADVENCE_ANDROID_SHA1 || 'set-by-release-build',
    bundled,
  };
}

export const BUILD = loadBuildInfo();
export const ANDROID_SIGNING_SHA1 = BUILD.androidSha1;
