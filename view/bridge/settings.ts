import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file in the view's data directory that keeps the owner's settings across a restart. */
export const SETTINGS_FILE = 'settings.json';

/**
 * The owner's settings. Direct sending is off until the owner turns it on: by default a spoken
 * prompt waits as a draft until the owner says "go". Kept in a file so a restart keeps it; with no
 * directory, in memory only.
 */
export class Settings {
  private on = false;

  constructor(private readonly directory?: string) {
    if (!directory) return;
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, SETTINGS_FILE), 'utf8'));
      this.on = typeof value === 'object' && value !== null && (value as { direct?: unknown }).direct === true;
    } catch { /* no file yet, or one that cannot be read: the default holds */ }
  }

  get direct(): boolean { return this.on; }

  /** Throws when the file cannot be written; the setting still holds until the bridge stops. */
  setDirect(on: boolean): void {
    this.on = on;
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(join(this.directory, SETTINGS_FILE), `${JSON.stringify({ direct: on })}\n`);
  }
}
