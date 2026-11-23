import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file in the view's data directory that keeps the owner's settings across a restart. */
export const SETTINGS_FILE = 'settings.json';

interface Saved { direct: boolean; voice: boolean; readReplies: boolean }

/**
 * The owner's settings. Direct sending is off until the owner turns it on: by default a spoken
 * prompt waits as a draft until the owner says "go". Spoken feedback for commands is on until the
 * owner turns it off; reading each finished reply aloud is off until turned on. Kept in a file so
 * a restart keeps them; with no directory, in memory only.
 */
export class Settings {
  private saved: Saved = { direct: false, voice: true, readReplies: false };

  constructor(private readonly directory?: string) {
    if (!directory) return;
    try {
      const value = JSON.parse(readFileSync(join(directory, SETTINGS_FILE), 'utf8')) as Partial<Record<keyof Saved, unknown>> | null;
      if (typeof value !== 'object' || value === null) return;
      this.saved = {
        direct: value.direct === true,
        voice: value.voice !== false,
        readReplies: value.readReplies === true,
      };
    } catch { /* no file yet, or one that cannot be read: the defaults hold */ }
  }

  get direct(): boolean { return this.saved.direct; }
  get voice(): boolean { return this.saved.voice; }
  get readReplies(): boolean { return this.saved.readReplies; }

  /** Each setter throws when the file cannot be written; the setting still holds until the bridge stops. */
  setDirect(on: boolean): void { this.set({ direct: on }); }
  setVoice(on: boolean): void { this.set({ voice: on }); }
  setReadReplies(on: boolean): void { this.set({ readReplies: on }); }

  private set(change: Partial<Saved>): void {
    this.saved = { ...this.saved, ...change };
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(join(this.directory, SETTINGS_FILE), `${JSON.stringify(this.saved)}\n`);
  }
}
