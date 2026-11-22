import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

export type WireRecord = Record<string, unknown>;
/** Private typed-by-caller subprocess wire. Never export this object through client APIs. */
export class RuntimeProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(record: WireRecord) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private readonly pending = new Map<string, { resolve(value: WireRecord): void; reject(error: Error): void }>();
  private sequence = 0;
  private exited = false;
  private spawnFailed = false;
  private closing: Promise<void> | null = null;
  private failure: Error | null = null;
  constructor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let buffer = Buffer.alloc(0);
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > 20_000_000) { this.fail(new Error('Runtime protocol bound exceeded.')); this.signal('SIGKILL'); return; }
      buffer = Buffer.concat([buffer, chunk]);
      // Decode only complete newline-framed records; EOF never completes a partial record.
      for (let end; (end = buffer.indexOf(10)) >= 0;) {
        const line = buffer.subarray(0, end).toString('utf8').replace(/\r$/, ''); buffer = buffer.subarray(end + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line) as WireRecord); } catch { this.fail(new Error('Runtime returned an invalid private protocol record.')); this.signal('SIGKILL'); }
      }
    });
    // Provider diagnostics may contain credentials. Drain, never retain or forward.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new Error('Runtime input closed; request acknowledgement is uncertain.')));
    this.child.once('error', () => { this.spawnFailed = true; this.fail(new Error('Runtime failed to start. Check the installed CLI.')); });
    this.child.once('close', () => { this.exited = true; this.fail(new Error('Runtime process exited. Reconcile retained outcome before retrying.')); });
  }
  private receive(record: WireRecord): void {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid record.');
    const response = record.type === 'control_response' ? record.response as WireRecord : record;
    const id = record.type === 'control_response' ? response.request_id : record.id;
    const pending = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (pending) {
      this.pending.delete(id as string);
      if (record.success === false || response.subtype === 'error') pending.reject(new Error('Runtime rejected a trusted control request.'));
      else pending.resolve(record);
    }
    for (const listener of this.listeners) listener(record);
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.failures) listener(error);
  }
  subscribe(listener: (record: WireRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** The Pi raw bash command bypasses tool selection: only these host-owned commands exist. */
  async pi(type: 'get_state' | 'get_available_models' | 'get_available_thinking_levels' | 'get_commands' | 'set_auto_retry' | 'set_auto_compaction' | 'prompt' | 'clear_queue' | 'abort', fields: WireRecord = {}): Promise<WireRecord> {
    if (!['get_state', 'get_available_models', 'get_available_thinking_levels', 'get_commands', 'set_auto_retry', 'set_auto_compaction', 'prompt', 'clear_queue', 'abort'].includes(type)) throw new Error('Denied private RPC command.');
    return this.request({ ...fields, type }, false);
  }
  async claude(subtype: 'initialize' | 'mcp_status' | 'interrupt', fields: WireRecord = {}): Promise<WireRecord> {
    if (!['initialize', 'mcp_status', 'interrupt'].includes(subtype)) throw new Error('Denied private Claude control command.');
    return this.request({ type: 'control_request', request: { ...fields, subtype } }, true);
  }
  private async request(record: WireRecord, claude: boolean): Promise<WireRecord> {
    if (this.failure) throw this.failure;
    const id = `host-${++this.sequence}`;
    const result = new Promise<WireRecord>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    void result.catch(() => undefined);
    await this.write({ ...record, ...(claude ? { request_id: id } : { id }) });
    const timer = setTimeout(() => { this.pending.get(id)?.reject(new Error('Runtime control acknowledgement timed out.')); this.pending.delete(id); }, 20000);
    try { return await result; } finally { clearTimeout(timer); }
  }
  async write(record: WireRecord): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.child.stdin.write(JSON.stringify(record) + '\n')) await once(this.child.stdin, 'drain');
  }
  waitFor(predicate: (record: WireRecord) => boolean, duration: number): Promise<WireRecord> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, record?: WireRecord): void => { clearTimeout(timer); unsubscribe(); this.failures.delete(onFailure); if (error) reject(error); else resolve(record!); };
      const onFailure = (error: Error) => finish(error);
      const unsubscribe = this.subscribe(record => { if (predicate(record)) finish(null, record); });
      const timer = setTimeout(() => finish(new Error('Bounded runtime turn timed out; effects may be uncertain.')), duration);
      this.failures.add(onFailure);
    });
  }
  get processId(): number | undefined { return this.child.pid; }
  get liveLeader(): boolean { return !this.exited && !this.spawnFailed; }
  /** Leader/stdio close does not prove children stopped. Probe/signals always target the PGID. */
  private groupAbsent(): boolean {
    if (!this.child.pid) return this.spawnFailed;
    try { process.kill(-this.child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  close(): Promise<void> {
    this.closing ??= this.quiesceGroup();
    return this.closing;
  }
  private async quiesceGroup(): Promise<void> {
    if (!this.exited) this.child.stdin.end();
    const started = performance.now(); let terminated = false, killed = false;
    while (performance.now() - started < 8000) {
      if (this.groupAbsent() && (this.exited || this.spawnFailed)) return;
      const elapsed = performance.now() - started;
      if (elapsed >= 2000 && !terminated) { terminated = true; this.signal('SIGTERM'); }
      if (elapsed >= 4000 && !killed) { killed = true; this.signal('SIGKILL'); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Runtime process group ${this.child.pid ?? 'unknown'} could not be proven absent. Effects/process state remain uncertain; reconcile before continuing.`);
  }
}
