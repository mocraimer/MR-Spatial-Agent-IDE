import type { PendingClose } from '../shared/messages.js';

/** What the owner is asked, and what happens on their answer. */
export type Slot =
  /** A close the helper asked for: the helper's tool waits on the answer. */
  | { kind: 'close'; sessionId: string; name: string; settle: (yes: boolean) => void }
  /** A command heard while listening is off: done only after a "yes". */
  | { kind: 'command'; label: string; run: () => Promise<{ ok: boolean; outcome: string }> };

/**
 * The one question that can wait for the owner's "yes" or "no". A yes answers exactly the question
 * that waits, so a close and a command heard while listening is off can never wait together: while
 * one waits, `put` refuses another. A question not answered in time lapses.
 */
export class Questions {
  private held: { slot: Slot; timer: NodeJS.Timeout } | null = null;

  /** `changed` is called whenever a question starts or ends. */
  constructor(private readonly changed: () => void) {}

  get waiting(): boolean { return this.held !== null; }
  get kind(): Slot['kind'] | null { return this.held?.slot.kind ?? null; }

  /** The close that waits, as the page shows it. */
  closeView(): PendingClose | null {
    const slot = this.held?.slot;
    return slot?.kind === 'close' ? { sessionId: slot.sessionId, name: slot.name } : null;
  }

  /** The command that waits, as the page shows it. */
  commandView(): { label: string } | null {
    const slot = this.held?.slot;
    return slot?.kind === 'command' ? { label: slot.label } : null;
  }

  /** Asks `slot` unless another question waits; false then. `lapse` runs if no answer comes in `ms`. */
  put(slot: Slot, ms: number, lapse: () => void): boolean {
    if (this.held) return false;
    const timer = setTimeout(() => { this.held = null; this.changed(); lapse(); }, ms);
    this.held = { slot, timer };
    this.changed();
    return true;
  }

  /** Takes the waiting question away, for the caller to answer or drop; null when none waits. */
  take(): Slot | null {
    const held = this.held;
    if (!held) return null;
    clearTimeout(held.timer);
    this.held = null;
    this.changed();
    return held.slot;
  }
}
