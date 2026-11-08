// A stand-in for GitHub's commit API and codeload tarballs (FR-SKL-01/04 tests): repos are maps
// of files per commit; HEAD can move to a new commit to test update checks.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export interface SkillRepoMock { url: string; requests: string[]; push(repo: string, files: Record<string, string>): string; close(): Promise<void> }

function header(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

export function tarGz(files: Record<string, string | { link: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const [p, c] of Object.entries(files)) {
    if (typeof c === 'object') {
      const h = header(p, 0, '2');
      h.write(c.link, 157);
      let sum = 0;
      h.write('        ', 148);
      for (const b of h) sum += b;
      h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
      parts.push(h);
      continue;
    }
    const d = Buffer.from(c, 'utf8');
    parts.push(header(p, d.length), d, Buffer.alloc((512 - (d.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export async function startSkillRepo(): Promise<SkillRepoMock> {
  const heads = new Map<string, string>();
  const commits = new Map<string, Record<string, string>>();
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push(u.pathname);
    let m = /^\/api\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const repo = `${m[1]}/${m[2]}`;
      const ref = decodeURIComponent(m[3]!);
      const sha = ref === 'HEAD' || ref === 'main' ? heads.get(repo) : commits.has(ref) ? ref : undefined;
      if (!sha) {
        res.statusCode = 404;
        return res.end('{}');
      }
      return res.end(sha);
    }
    m = /^\/codeload\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(u.pathname);
    if (m && commits.has(m[3]!)) {
      const files = commits.get(m[3]!)!;
      const prefixed: Record<string, string> = {};
      for (const [p, c] of Object.entries(files)) prefixed[`${m[2]}-${m[3]!.slice(0, 7)}/${p}`] = c;
      return res.end(tarGz(prefixed));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    requests,
    push(repo, files) {
      const sha = createHash('sha1').update(JSON.stringify([repo, files, commits.size])).digest('hex');
      commits.set(sha, files);
      heads.set(repo, sha);
      return sha;
    },
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
