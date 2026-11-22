/**
 * Which sessions hold a draft: spoken words typed into the session's input and not yet sent.
 * The bridge's one record of that; "go" sends the draft of the session in front, "scratch that"
 * clears it. Typing at the desk is not seen here: the draft shows in the session's own window.
 */
export class Drafts {
  private readonly held = new Set<string>();

  has(id: string): boolean { return this.held.has(id); }
  mark(id: string): void { this.held.add(id); }
  clear(id: string): void { this.held.delete(id); }
  ids(): string[] { return [...this.held]; }

  /** Forgets the drafts of sessions that are no longer open; true when any was. */
  prune(open: ReadonlySet<string>): boolean {
    let changed = false;
    for (const id of this.held) if (!open.has(id)) { this.held.delete(id); changed = true; }
    return changed;
  }
}

/** Every control character: none may reach a session as typed text. */
// eslint-disable-next-line no-control-regex -- the point is to match control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Spoken text as it may be typed: no control character reaches a session, so words can never press Enter or any other key. */
export function typeable(text: string): string {
  return text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}
