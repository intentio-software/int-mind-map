import { Injectable, inject } from '@angular/core';
import { MessageService } from 'primeng/api';

@Injectable({ providedIn: 'root' })
export class UpdaterService {
  private messages = inject(MessageService);

  async checkForUpdates(): Promise<void> {
    // Only runs inside the Tauri desktop shell
    if (typeof (window as any).__TAURI_INTERNALS__ === 'undefined') return;

    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update?.available) return;

      this.messages.add({
        severity: 'info',
        summary: `Update available — v${update.version}`,
        detail: 'Click "Update Now" to download and restart.',
        sticky: true,
        data: update,
      });
    } catch (err) {
      console.warn('Update check failed:', err);
    }
  }

  async installUpdate(update: any): Promise<void> {
    try {
      this.messages.clear();
      this.messages.add({
        severity: 'info',
        summary: 'Downloading update…',
        detail: 'The app will restart automatically when ready.',
        sticky: true,
      });

      await update.downloadAndInstall();

      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      console.error('Update failed:', err);
      this.messages.add({
        severity: 'error',
        summary: 'Update failed',
        detail: String(err),
        life: 6000,
      });
    }
  }
}
