// Our own icon set (FR-UI-09): simple 24px stroke icons drawn for this product.
import type { SVGProps } from 'react';

const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  send: 'M5 12h12M13 6l6 6-6 6',
  attach: 'M8 12.5l6.4-6.4a3 3 0 0 1 4.2 4.2l-8 8a5 5 0 0 1-7-7L11 4',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  bot: 'M7 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM12 5v4M9.5 14h.01M14.5 14h.01',
  group: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19c0-2.8 2.2-5 5-5s5 2.2 5 5M13 16c.8-1.2 1.8-2 3-2 2.8 0 5 2.2 5 5',
  library: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 4.5l3.8 1-4 15.4-3.8-1',
  routine: 'M12 6v6l4 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  close: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  back: 'M15 6l-6 6 6 6',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  device: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  computer: 'M4 5h16v11H4zM9 20h6M12 16v4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  key: 'M14 10a4 4 0 1 0-3.5 4L4 20.5V18h2.5v-2.5H9l1.5-1.5M15.5 8.5h.01',
  server: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01',
  chevron: 'M9 6l6 6-6 6',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  star: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 5l12 7-12 7z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  sparkle: 'M12 3c.9 5 3.1 7.1 8 8-4.9.9-7.1 3-8 8-.9-5-3.1-7.1-8-8 4.9-.9 7.1-3 8-8z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  image: 'M4 5h16v14H4zM8 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 16l-5-5-9 8',
  reply: 'M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1',
  smile: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 14c1 1.3 2.1 2 3.5 2s2.5-.7 3.5-2M9 9.5h.01M15 9.5h.01',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  hand: 'M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.5 14a1.5 1.5 0 0 1 2.5-1.7L8 15',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  mcp: 'M5 12h4M15 12h4M9 8h6v8H9zM12 4v4M12 16v4',
  skill: 'M12 3l2 4 4 .5-3 3 .8 4.5L12 13l-3.8 2 .8-4.5-3-3 4-.5zM6 19h12',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={P[name]} />
    </svg>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="StellarCortex Advence">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b7bff" />
          <stop offset="1" stopColor="#2fd4c0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="var(--logo-bg)" />
      <ellipse cx="32" cy="32" rx="22" ry="9" fill="none" stroke="url(#lg)" strokeWidth="2.5" transform="rotate(-28 32 32)" />
      <path d="M32 13c1.6 9.4 5.6 13.4 15 15-9.4 1.6-13.4 5.6-15 15-1.6-9.4-5.6-13.4-15-15 9.4-1.6 13.4-5.6 15-15z" fill="url(#lg)" />
    </svg>
  );
}
