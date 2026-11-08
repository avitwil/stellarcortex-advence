// NFR-SEC-08: Bot computers must not reach this server's API. Rootless Podman's user-mode
// networking (pasta, slirp4netns) opens a container's outbound connections from sockets on the
// host, so a container that dials the host's own LAN address arrives here as a local peer. On
// Linux the server finds the process that owns the peer socket and refuses the connection when
// it is one of the container network helpers. Remote peers and other local processes are not
// affected. (Windows and macOS run containers in a Podman machine VM: see docs/manual-checks.md.)
import fs from 'node:fs';
import os from 'node:os';
import type { Socket } from 'node:net';

const HELPERS = /^(pasta|pasta\.avx2|passt|passt\.avx2|slirp4netns|gvproxy|vpnkit)$/;

/** Canonical text form of an IPv4 or IPv6 address (IPv4-mapped IPv6 becomes IPv4). */
export function canonicalIp(a: string): string {
  const s = a.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!s.includes(':')) return s;
  let c: string;
  try {
    c = new URL(`http://[${s}]`).hostname.slice(1, -1);
  } catch {
    return s;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(c);
  if (!m) return c;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** Decodes an address from /proc/net/tcp{,6} ("0100007F:1F90"). */
export function procAddr(hex: string): { ip: string; port: number } {
  const [h, p] = hex.split(':') as [string, string];
  const bytes: number[] = [];
  for (let w = 0; w < h.length; w += 8) {
    const word = h.slice(w, w + 8);
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(word.slice(i, i + 2), 16));
  }
  let ip: string;
  if (bytes.length === 4) ip = bytes.join('.');
  else {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
    ip = groups.join(':');
  }
  return { ip: canonicalIp(ip), port: parseInt(p, 16) };
}

function localAddresses(): Set<string> {
  const s = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) s.add(canonicalIp(i.address));
  return s;
}

function isLocal(ip: string): boolean {
  return ip.startsWith('127.') || localAddresses().has(ip);
}

/** Socket inode of the peer end (the client's socket) of one of our TCP connections. */
function peerInode(remote: string, remotePort: number, local: string, localPort: number): string | null {
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10) continue;
      const l = procAddr(c[1]!);
      const r = procAddr(c[2]!);
      if (l.ip === remote && l.port === remotePort && r.ip === local && r.port === localPort) return c[9]!;
    }
  }
  return null;
}

function ownedByHelper(inode: string): boolean {
  const target = `socket:[${inode}]`;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let comm: string;
    try {
      comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {
      continue;
    }
    if (!HELPERS.test(comm)) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === target) return true;
      } catch {
        // the fd closed meanwhile
      }
    }
  }
  return false;
}

/** True when this connection was opened by a container network helper on this host. */
export function fromContainerNetwork(s: Pick<Socket, 'remoteAddress' | 'remotePort' | 'localAddress' | 'localPort'>, platform = process.platform): boolean {
  if (platform !== 'linux' || !s.remoteAddress || !s.localAddress || !s.remotePort || !s.localPort) return false;
  const remote = canonicalIp(s.remoteAddress);
  if (!isLocal(remote)) return false;
  try {
    const inode = peerInode(remote, s.remotePort, canonicalIp(s.localAddress), s.localPort);
    return inode !== null && inode !== '0' && ownedByHelper(inode);
  } catch {
    return false;
  }
}

/** Refuses connections from Bot computers before any request or upgrade is handled. */
export function guardContainerPeers(server: import('node:events').EventEmitter, onRefused: () => void): void {
  server.prependListener('secureConnection', (sock: Socket) => {
    if (fromContainerNetwork(sock)) {
      onRefused();
      sock.destroy();
    }
  });
}
