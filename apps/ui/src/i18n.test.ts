import { describe, it, expect } from 'vitest';
import { en } from './i18n/en';
import { he } from './i18n/he';
import { dirOf } from './i18n';

function keys(o: unknown, p = ''): string[] {
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'object' && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
}
function values(o: unknown): string[] {
  return Object.values(o as Record<string, unknown>).flatMap((v) => (typeof v === 'object' && v ? values(v) : [String(v)]));
}

describe('FR-UI-10 i18n and RTL', () => {
  it('Hebrew and English have exactly the same keys', () => {
    expect(keys(he).sort()).toEqual(keys(en).sort());
  });
  it('every Hebrew string is filled and keeps interpolation variables', () => {
    const enMap = Object.fromEntries(keys(en).map((k, i) => [k, values(en)[i]]));
    const heMap = Object.fromEntries(keys(he).map((k, i) => [k, values(he)[i]]));
    for (const k of Object.keys(enMap)) {
      expect(heMap[k], k).toBeTruthy();
      const vars = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort();
      expect(vars(heMap[k]!), k).toEqual(vars(enMap[k]!));
    }
  });
  it('Hebrew is RTL and English is LTR', () => {
    expect(dirOf('he')).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
  });
  it('NFR-SEC-06 the security wording claims no more than server-side encryption', () => {
    expect(en.security.honest).toMatch(/your server runs the bots and can read/i);
    for (const s of [...values(en), ...values(he)]) expect(s.toLowerCase()).not.toMatch(/end-to-end|zero.knowledge|even we can.t read/);
  });
});
