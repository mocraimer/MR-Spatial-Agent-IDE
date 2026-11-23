/**
 * Reads and restores the owner's Claude Code settings file so that /model and /effort do not
 * change the defaults for new sessions. The file path is configurable for tests.
 *
 * Usage:
 *   const token = saveDefaults(settingsPath);    // throws on read/parse error
 *   // ... type the command, wait for session confirmation ...
 *   restoreDefaults(token);                      // throws on read/parse/write error
 *
 * restoreDefaults only writes when a tracked value actually changed; byte style (indent, trailing
 * newline) is preserved so only the restored keys differ.
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, chmodSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Resolves the Claude settings file path, respecting CLAUDE_CONFIG_DIR. */
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(dir, 'settings.json');
}

type JsonObject = { [key: string]: unknown };

/**
 * Reads and parses the settings file. Throws when the file cannot be read or parsed
 * (so we never accidentally write a near-empty object over the owner's settings).
 * Returns {} when the file does not exist (that is a valid starting state).
 */
function readJson(path: string): { data: JsonObject; raw: string } {
  if (!existsSync(path)) return { data: {}, raw: '{}' };
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw) as JsonObject;   // throws SyntaxError on bad JSON
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SyntaxError(`${path}: top-level value is not an object`);
  }
  return { data, raw };
}

/** Detects the indent style used in a JSON string (spaces or tab). Falls back to 2 spaces. */
function detectIndent(raw: string): string | number {
  const m = /^\{\n([ \t]+)/.exec(raw);
  if (!m) return 2;
  if (m[1]!.startsWith('\t')) return '\t';
  return m[1]!.length;
}

/** Whether the raw string ends with a newline character. */
function hasTrailingNewline(raw: string): boolean {
  return raw.endsWith('\n');
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
  /** The original top-level "effortLevel" value (undefined means absent). */
  effortLevel: string | undefined;
  /**
   * Per-model effort snapshot: maps model id → original effortLevel (undefined = key was absent).
   * Only model ids present in modelSettings at save time are included.
   */
  modelEfforts: Record<string, string | undefined>;
  /** Whether modelSettings existed at all in the saved file. */
  hadModelSettings: boolean;
}

/**
 * Saves the current default model and effort values from the settings file.
 * Throws when the file exists but cannot be read or parsed — in that case the caller must
 * NOT type the command (the outcome must say why).
 */
export function saveDefaults(path: string): SaveToken {
  const { data } = readJson(path);
  const ms = data.modelSettings;
  const modelEfforts: Record<string, string | undefined> = {};
  if (typeof ms === 'object' && ms !== null && !Array.isArray(ms)) {
    for (const [id, entry] of Object.entries(ms as Record<string, unknown>)) {
      const eff = (entry as Record<string, unknown>)?.effortLevel;
      modelEfforts[id] = typeof eff === 'string' ? eff : undefined;
    }
  }
  return {
    path,
    model: typeof data.model === 'string' ? data.model : undefined,
    effortLevel: typeof data.effortLevel === 'string' ? data.effortLevel : undefined,
    modelEfforts,
    hadModelSettings: typeof ms === 'object' && ms !== null && !Array.isArray(ms),
  };
}

/**
 * Restores only the tracked keys to the values they had at save time.
 * Preserves every other key and the file's byte style (indent, trailing newline).
 * Does nothing when no tracked value actually differs from the saved one.
 * Throws when the file cannot be read, parsed, or written.
 */
export function restoreDefaults(token: SaveToken): void {
  const { data, raw } = readJson(token.path);
  let changed = false;

  // Restore top-level model.
  const currentModel = typeof data.model === 'string' ? data.model : undefined;
  if (currentModel !== token.model) {
    if (token.model !== undefined) data.model = token.model;
    else delete data.model;
    changed = true;
  }

  // Restore top-level effortLevel.
  const currentEL = typeof data.effortLevel === 'string' ? data.effortLevel : undefined;
  if (currentEL !== token.effortLevel) {
    if (token.effortLevel !== undefined) data.effortLevel = token.effortLevel;
    else delete data.effortLevel;
    changed = true;
  }

  // Per-model effort: patch only the model ids tracked at save time.
  const ms = (typeof data.modelSettings === 'object' && data.modelSettings !== null && !Array.isArray(data.modelSettings))
    ? { ...data.modelSettings as Record<string, unknown> }
    : {} as Record<string, unknown>;

  for (const [id, savedEff] of Object.entries(token.modelEfforts)) {
    const entry = (typeof ms[id] === 'object' && ms[id] !== null) ? { ...ms[id] as Record<string, unknown> } : {} as Record<string, unknown>;
    const currentEff = typeof entry.effortLevel === 'string' ? entry.effortLevel : undefined;
    if (currentEff === savedEff) continue;
    changed = true;
    if (savedEff !== undefined) {
      entry.effortLevel = savedEff;
      ms[id] = entry;
    } else {
      delete entry.effortLevel;
      if (Object.keys(entry).length === 0) delete ms[id];
      else ms[id] = entry;
    }
  }

  // If modelSettings did not exist at save time but now does due to /effort, we don't touch it
  // (the per-model loop above already handles the specific ids that were absent).
  if (changed) {
    if (Object.keys(ms).length > 0 || token.hadModelSettings) {
      data.modelSettings = ms;
    } else {
      delete data.modelSettings;
    }
    const indent = detectIndent(raw);
    const newRaw = JSON.stringify(data, null, indent);
    atomicWrite(token.path, hasTrailingNewline(raw) ? `${newRaw}\n` : newRaw);
  }
}
