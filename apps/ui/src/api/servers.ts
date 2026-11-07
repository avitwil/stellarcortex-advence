// Saved servers (FR-CLI-03): several saved, one active at a time. Not secret: host + pin.
import { decodePairingLink, type PairingLink } from '@advence/protocol';

export interface SavedServer {
  id: string;
  name: string;
  host: string;
  pin: string;
  deviceId?: string;
  pairingId?: string;
  pairingCode?: string;
  state: 'pairing' | 'paired';
  addedAt: number;
}

const KEY = 'advence.servers';
const ACTIVE = 'advence.activeServer';

export function loadServers(): SavedServer[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedServer[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveServers(list: SavedServer[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function activeServerId(): string | null {
  return localStorage.getItem(ACTIVE);
}

export function setActiveServerId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE, id);
  else localStorage.removeItem(ACTIVE);
}

export function parseLink(text: string): PairingLink | null {
  try {
    return decodePairingLink(text);
  } catch {
    return null;
  }
}

export function serverFromLink(l: PairingLink): SavedServer {
  const id = `${l.host}#${l.pin.slice(0, 12)}`;
  return { id, name: l.name, host: l.host, pin: l.pin, state: 'pairing', addedAt: Date.now() };
}
