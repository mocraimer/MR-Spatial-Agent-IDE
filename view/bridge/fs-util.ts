/**
 * Shared filesystem utilities.
 */
import { writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Writes `content` to `path` atomically using a temp-file + rename.
 * Creates parent directories as needed. Throws on failure after cleaning up the temp file.
 */
export function atomicWriteText(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, content, { encoding: 'utf8' });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}
