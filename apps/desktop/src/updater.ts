// Desktop auto-update (D-24, FR-CLI-05): electron-updater against a self-hosted static
// feed set at build time. P7 adds the Ed25519 release-signature check before install.
import { app } from 'electron';

export const FEED_URL = process.env.ADVENCE_FEED_URL_BUILD ?? '';

export function startUpdater(): void {
  if (!app.isPackaged || !FEED_URL) return;
  void import('electron-updater').then(({ autoUpdater }) => {
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL });
    autoUpdater.autoDownload = false;
    void autoUpdater.checkForUpdates().catch(() => undefined);
  });
}
