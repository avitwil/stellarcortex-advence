// Cron-like schedules for routines (FR-PRO-02): five fields (minute hour day-of-month month
// day-of-week) with `*`, lists, ranges and steps, evaluated in the user's time zone.
const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;
const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export interface Cron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

export class CronError extends Error {}

function field(text: string, i: number): Set<number> {
  const { min, max }: { min: number; max: number } = FIELDS[i]!;
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part.trim());
    if (!m) throw new CronError(`bad field "${text}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new CronError('bad step');
    const num = (s: string) => {
      const v = /^\d+$/.test(s) ? Number(s) : NAMES[s.toLowerCase()];
      if (v === undefined || v < min || v > max) throw new CronError(`"${s}" is out of range`);
      return v;
    };
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-');
      lo = num(a!);
      hi = b !== undefined ? num(b) : m[2] ? max : lo;
      if (hi < lo) throw new CronError('bad range');
    }
    for (let v = lo; v <= hi; v += step) out.add(i === 4 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('a schedule has five fields: minute hour day month weekday');
  const [mi, h, dom, mo, dow] = parts.map((p, i) => field(p, i)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return { minute: mi, hour: h, dom, month: mo, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(t: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(t)) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), dow: NAMES[p.weekday!.toLowerCase().slice(0, 3)]! };
}

function matchesDay(c: Cron, p: { mo: number; d: number; dow: number }): boolean {
  if (!c.month.has(p.mo)) return false;
  // As in cron: when both day fields are restricted, either one matching is enough.
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return c.dow.has(p.dow);
  if (c.dowAny) return c.dom.has(p.d);
  return c.dom.has(p.d) || c.dow.has(p.dow);
}

/** The first minute after `from` that matches, or null when none falls within about four years. */
export function nextRun(c: Cron, tz: string, from: number): number | null {
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const end = from + 4 * 366 * 86_400_000;
  while (t < end) {
    const p = parts(t, tz);
    if (!matchesDay(c, p)) {
      // Skip to the next local midnight (time zones move in at least 15-minute steps).
      t += ((23 - p.h) * 60 + (60 - p.mi)) * 60_000;
      continue;
    }
    if (!c.hour.has(p.h)) {
      t += (60 - p.mi) * 60_000;
      continue;
    }
    if (!c.minute.has(p.mi)) {
      t += 60_000;
      continue;
    }
    return t;
  }
  return null;
}
