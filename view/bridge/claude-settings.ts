/**
 * Reads and restores the owner's Claude Code settings file so that /model and /effort do not
 * change the defaults for new sessions. The file path is configurable for tests.
 *
 * Usage:
 *   const token = saveDefaults(settingsPath);
 *   // ... type the command, wait for session confirmation ...
 *   restoreDefaults(token);
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Resolves the Claude settings file path, respecting CLAUDE_CONFIG_DIR. */
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(dir, 'settings.json');
}

type JsonObject = { [key: string]: unknown };

/** Reads and parses the settings file; returns {} when it does not exist or cannot be parsed. */
function readJson(path: string): JsonObject {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
  } catch {
    return {};
  }
}

/** Atomically writes `content` to `path` using a temp file in the same directory. Preserves file mode. */
function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  let mode: number | undefined;
  try { mode = statSync(path).mode & 0o777; } catch { /* file does not exist yet */ }
  const tmp = join(dir, `.settings-${randomUUID()}.tmp`);
  writeFileSync(tmp, content, { encoding: 'utf8' });
  if (mode !== undefined) {
    try { chmodSync(tmp, mode); } catch { /* best effort */ }
  }
  renameSync(tmp, path);
}

export interface SaveToken {
  path: string;
  /** The original top-level "model" value (undefined means absent). */
  model: string | undefined;
  /** The original top-level "effortLevel" value. */
  effortLevel: string | undefined;
  /** A snapshot of the entire original modelSettings object (JSON), to restore exactly. */
  modelSettingsJson: string;
}

/**
 * Saves the current default model and effort values from the settings file.
 * Call before typing /model or /effort. The returned token is passed to restoreDefaults().
 */
export function saveDefaults(path: string): SaveToken {
  const data = readJson(path);
  return {
    path,
    model: typeof data.model === 'string' ? data.model : undefined,
    effortLevel: typeof data.effortLevel === 'string' ? data.effortLevel : undefined,
    modelSettingsJson: JSON.stringify(data.modelSettings ?? null),
  };
}

/**
 * Writes back only the keys tracked by the token, restoring them to what they were.
 * The rest of the file (as Claude Code wrote it) is preserved.
 */
export function restoreDefaults(token: SaveToken): void {
  const data = readJson(token.path);

  // Restore top-level model.
  if (token.model !== undefined) data.model = token.model;
  else delete data.model;

  // Restore top-level effortLevel.
  if (token.effortLevel !== undefined) data.effortLevel = token.effortLevel;
  else delete data.effortLevel;

  // Restore entire modelSettings (the only key /effort touches).
  const originalModelSettings = JSON.parse(token.modelSettingsJson) as unknown;
  if (originalModelSettings === null) delete data.modelSettings;
  else data.modelSettings = originalModelSettings;

  atomicWrite(token.path, `${JSON.stringify(data, null, 2)}\n`);
}
