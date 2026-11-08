import type { PlatformBridge } from './types';
import { browserBridge } from './browser';
import { electronBridge } from './electron';
import { androidBridge, isAndroidNative } from './android';

let bridge: PlatformBridge | null = null;

export function platform(): PlatformBridge {
  if (bridge) return bridge;
  if (typeof window !== 'undefined' && window.advenceDesktop) bridge = electronBridge(window.advenceDesktop);
  else if (typeof window !== 'undefined' && isAndroidNative()) bridge = androidBridge();
  else bridge = browserBridge();
  return bridge;
}

/** Tests and stories inject a fake bridge. */
export function setPlatform(b: PlatformBridge | null): void {
  bridge = b;
}

export type { PlatformBridge } from './types';
