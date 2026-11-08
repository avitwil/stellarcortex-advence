import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { he } from './he';

export type Lang = 'en' | 'he';
export const RTL_LANGS: ReadonlySet<Lang> = new Set(['he']);

export function dirOf(lang: Lang): 'rtl' | 'ltr' {
  return RTL_LANGS.has(lang) ? 'rtl' : 'ltr';
}

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('advence.lang');
    if (saved === 'en' || saved === 'he') return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('he') ? 'he' : 'en';
}

/** Switches language at runtime and mirrors the document direction (FR-UI-10). */
export function applyLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = dirOf(lang);
  try {
    localStorage.setItem('advence.lang', lang);
  } catch {
    /* ignore */
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, he: { translation: he } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
