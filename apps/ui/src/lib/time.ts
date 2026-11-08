import type { TFunction } from 'i18next';

export function ago(t: TFunction, ts: number | null, now = Date.now()): string {
  if (!ts) return t('settings.devices.never');
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return t('time.justNow');
  if (s < 3600) return t('time.minutesAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.hoursAgo', { n: Math.floor(s / 3600) });
  return t('time.daysAgo', { n: Math.floor(s / 86400) });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
