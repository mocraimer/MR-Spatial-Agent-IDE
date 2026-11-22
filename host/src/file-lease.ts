import { closeSync, ftruncateSync, openSync, writeFileSync } from 'node:fs';
import { tryLock, unlock } from 'fs-native-extensions';

/** Host-only lifetime lease. Never unlink its stable inode, even after a crash. */
export function acquireFileLease(path: string): () => void {
  const fd = openSync(path, 'a+', 0o600);
  try {
    if (!tryLock(fd)) throw new Error('Another process holds the private app-data lease.');
    // Diagnostic PID is not ownership proof; only the descriptor-held lock is.
    ftruncateSync(fd, 0); writeFileSync(fd, String(process.pid));
  } catch (error) { closeSync(fd); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlock(fd); } finally { closeSync(fd); }
  };
}
