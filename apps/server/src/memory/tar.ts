// Minimal tar reader for GitHub source tarballs (ustar, pax and GNU long names). Only regular
// files come out; links and devices are reported as skipped. Limits keep a hostile archive small.
import { gunzipSync } from 'node:zlib';

export interface TarEntry { path: string; data: Buffer }
export interface TarResult { files: TarEntry[]; skipped: string[] }

const MAX_UNPACKED = 64 * 1024 * 1024;

function str(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}

function octal(b: Buffer, start: number, len: number): number {
  const s = str(b, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString(), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function readTarGz(gz: Buffer): TarResult {
  const buf = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED });
  const files: TarEntry[] = [];
  const skipped: string[] = [];
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      paxPath = pax(data).path ?? null;
      continue;
    }
    if (type === 'g') continue;
    const prefix = str(h, 345, 155);
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    paxPath = null;
    longName = null;
    if (type === '0' || type === '\0' || type === '7') files.push({ path: name, data: Buffer.from(data) });
    else if (type !== '5') skipped.push(name);
  }
  return { files, skipped };
}
