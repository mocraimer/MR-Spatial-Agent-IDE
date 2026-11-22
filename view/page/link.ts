/**
 * The page's link to the bridge: one event stream in, requests out. Every request has a
 * timeout, so a silent Wi-Fi drop ends in "lost" and a retry, never in a wait without end.
 */
import { parseEvent, type BridgeEvent } from '../shared/messages.js';

export type LinkState = 'connecting' | 'live' | 'lost' | 'unpaired';

/** Silence after which a live stream counts as lost (the bridge pings every 10 s). */
const SILENCE_MS = 25_000;
const CHECK_MS = 5_000;
const RETRY_MS = 2_000;

export interface Reply { ok: boolean; status: number; body: Record<string, unknown> }

export class BridgeLink {
  state: LinkState = 'connecting';
  /** Why the link is lost, in the owner's words, so a failure can be told apart from another. */
  why = '';
  private source: EventSource | null = null;
  private lastMessage = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onEvent: (event: BridgeEvent) => void, private readonly onChange: () => void) {
    setInterval(() => {
      if (this.state === 'live' && Date.now() - this.lastMessage > SILENCE_MS) { this.set('lost'); void this.connect(); }
    }, 1000);
    addEventListener('online', () => { void this.connect(); });
    addEventListener('offline', () => this.set('lost'));
  }

  /** (Re)opens the event stream; a 401 means this headset is no longer paired. */
  async connect(): Promise<void> {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.source?.close();
    this.source = null;
    let status: number;
    try { status = (await fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(CHECK_MS) })).status; } catch (error) {
      this.why = error instanceof DOMException && error.name === 'TimeoutError' ? `the PC did not answer within ${CHECK_MS / 1000} s` : 'the PC could not be reached';
      this.set('lost');
      this.retry = setTimeout(() => { void this.connect(); }, RETRY_MS);
      return;
    }
    if (status === 401) { this.set('unpaired'); return; }
    if (status !== 200) { this.why = `the PC answered ${status}`; this.set('lost'); this.retry = setTimeout(() => { void this.connect(); }, RETRY_MS); return; }
    // A newer connect may have started while this one waited.
    if (this.source) return;
    const source = new EventSource('/api/events');
    this.source = source;
    source.onopen = () => { if (this.source !== source) return; this.lastMessage = Date.now(); this.set('live'); };
    source.onmessage = e => {
      if (this.source !== source) return;
      this.lastMessage = Date.now();
      const event = parseEvent(String(e.data));
      if (event) this.onEvent(event);
      else if (!String(e.data).includes('"ping"')) console.warn('view: ignored a message from the bridge it could not read', String(e.data).slice(0, 200));
    };
    source.onerror = () => {
      if (this.source !== source) return;
      this.why = 'the stream from the PC was cut';
      this.set('lost');
      if (source.readyState === EventSource.CLOSED) { this.source = null; source.close(); }
      // Either the stream ended or the browser is retrying; a fresh check also tells "unpaired".
      this.retry ??= setTimeout(() => { this.retry = null; if (this.source === null || this.state !== 'live') void this.connect(); }, RETRY_MS);
    };
  }

  /** A JSON or binary POST with a timeout; a 401 marks the headset unpaired. */
  async post(path: string, body: unknown, timeoutMs = 10_000): Promise<Reply> {
    const binary = body instanceof ArrayBuffer;
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
        body: binary ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const value = await r.json().catch(() => ({})) as Record<string, unknown>;
      if (r.status === 401) { this.source?.close(); this.source = null; this.set('unpaired'); }
      return { ok: r.ok && value.ok !== false, status: r.status, body: value };
    } catch {
      this.why = 'a request to the PC failed';
      this.set('lost');
      void this.connect();
      // The bridge may have acted before the reply was lost: say so rather than "not sent".
      return { ok: false, status: 0, body: { error: 'No link to the PC: it may not have arrived. Check the session before repeating it.' } };
    }
  }

  private set(state: LinkState): void {
    if (state === this.state) return;
    this.state = state;
    this.onChange();
  }
}
