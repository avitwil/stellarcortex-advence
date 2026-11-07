import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { applyLang } from './i18n';
import { ConnectScreen } from './screens/Connect';
import { setPlatform } from './platform';
import { browserBridge } from './platform/browser';

beforeEach(() => setPlatform({ ...browserBridge(), canScanQr: true }));

describe('FR-UI-10 runtime language switch', () => {
  it('renders the connect screen in English then Hebrew with mirrored direction', async () => {
    act(() => applyLang('en'));
    const { rerender } = render(<ConnectScreen />);
    expect(screen.getByRole('heading', { name: 'Connect to your server' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('ltr');
    act(() => applyLang('he'));
    rerender(<ConnectScreen />);
    expect(screen.getByRole('heading', { name: 'התחברות לשרת שלך' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('button', { name: /סריקת קוד QR/ })).toBeTruthy();
  });
});
