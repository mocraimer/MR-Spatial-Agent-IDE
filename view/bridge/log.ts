import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The log file in the view's data directory; the one before it sits beside it as `view.log.1`. */
export const LOG_FILE = 'view.log';
/** The file is kept under this size: past it, it becomes `view.log.1` and a new one starts. */
export const LOG_MAX_BYTES = 1_000_000;

/**
 * The view's one log: each line goes to the terminal (through `print`) and, dated, to the log
 * file, which outlasts the terminal. Lines name sessions and projects and say what happened in
 * the view's own words; the bridge never passes it a pairing code, session text or heard speech.
 */
export function fileLog(directory: string, print: (line: string) => void, maxBytes = LOG_MAX_BYTES): (line: string) => void {
  const file = join(directory, LOG_FILE);
  let broken = false;
  return line => {
    print(line);
    const text = `${new Date().toISOString().slice(0, 19)}Z ${line.replace(/[\r\n]+/g, ' ')}\n`;
    try {
      mkdirSync(directory, { recursive: true });
      let size = 0;
      try { size = statSync(file).size; } catch { /* no file yet */ }
      if (size + text.length > maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, text);
      broken = false;
    } catch (error) {
      // Said once, not on every line: the terminal still has everything.
      if (!broken) print(`the log file ${file} cannot be written (${(error as Error).message}); lines still show here`);
      broken = true;
    }
  };
}
