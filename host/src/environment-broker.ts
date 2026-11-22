import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, createReadStream, createWriteStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import type { ControlLease, FrameIdentity, ReadinessItem, TaskInput, ToolView } from './protocol.js';
import { acquireFileLease } from './file-lease.js';

const PRODUCT = 'task-environment';
const LABEL = 'com.spatial.workspace';
const LIMITATION = 'Offline Linux baseline only. Reset kills ALL workload processes and loses unsaved app/process state; durable /workspace files survive. External research requires a separately bounded proxy and is unavailable.';
const IMAGE = 'spatial-workspace-task:offline-v1';
type ViewKind = 'browser' | 'terminal' | 'desktop';
type Role = 'agent' | 'owner';
type Lifecycle = 'starting' | 'running' | 'stopped' | 'archived' | 'uncertain' | 'destroyed';
export interface ManagedEnvironment {
  taskId: string;
  environmentId: string;
  rootId: string;
  containerId: string | null;
  volume: string;
  generation: number;
  epoch: number;
  owner: ControlLease['owner'];
  state: Lifecycle;
  detail: string;
}
export interface ShellResult { output: string; exitCode: number }
export interface TaskFrame { identity: FrameIdentity; png: Buffer }
export interface EnvironmentSnapshot { taskId: string; environmentId: string; state: Lifecycle; lease: ControlLease; views: ToolView[]; detail: string }
/** Only trusted host composition can install an engine. Never expose this interface to task code. */
export interface EnvironmentEngine {
  readiness(): Promise<ReadinessItem>;
  create(environment: ManagedEnvironment): Promise<string>;
  start(environment: ManagedEnvironment): Promise<void>;
  stopAndVerify(environment: ManagedEnvironment): Promise<void>;
  remove(environment: ManagedEnvironment): Promise<void>;
  removeVolume(environment: ManagedEnvironment): Promise<void>;
  /** Trusted engine streams a complete, uncompressed workspace tar to this already-private fd. */
  captureWorkspace?(environment: ManagedEnvironment, archiveFd: number): Promise<void>;
  verifyWorkspace?(environment: ManagedEnvironment): Promise<void>;
  tool(environment: ManagedEnvironment, operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export class EnvironmentError extends Error {
  constructor(public readonly code: string, detail: string, public readonly recovery = 'Refresh environment state and use its current epoch; do not automatically replay uncertain effects.', public readonly effectState: 'not-sent' | 'uncertain' = 'not-sent') { super(detail); }
}

/** CLI transport is host-trusted; stdin/arguments never enter a host shell. */
function docker(args: string[], input = '', timeout = 30_000): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/nonexistent' } });
    let output = ''; let error = ''; let settled = false;
    const finish = (failure: Error | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (failure) reject(failure); else accept(output);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Docker acknowledgement timed out; process state may be uncertain')); }, timeout);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 16_000_000) { child.kill('SIGKILL'); finish(new Error('Docker output exceeds limit')); } });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4096); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? null : new Error(`Docker operation failed (${code}): ${error}`)));
    child.stdin.on('error', () => { /* close event reports the operation failure */ });
    child.stdin.end(input);
  });
}
function syncArchiveDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
async function streamWorkspaceTar(containerId: string, fd: number): Promise<void> {
  const child = spawn('docker', ['cp', `${containerId}:/workspace/.`, '-'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/nonexistent' } });
  let error = '';
  child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4096); });
  const completion = new Promise<void>((accept, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? accept() : reject(new EnvironmentError('export-failed', `Docker workspace capture failed (${code}): ${error}`)));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
  const output = createWriteStream('', { fd, autoClose: false });
  try {
    await Promise.all([completion, pipeline(child.stdout, output)]);
  } catch (failure) {
    child.kill('SIGKILL'); await completion.catch(() => undefined);
    throw failure;
  } finally { clearTimeout(timer); }
}
// stdlib only; READS tar metadata and bytes. Never extracts names onto the host or follows links.
const TAR_INVENTORY = String.raw`
import hashlib, json, os, stat, sys, tarfile
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077 or st.st_nlink != 1:
 raise ValueError('archive is not a private regular file')
with os.fdopen(fd, 'rb') as source:
 raw = hashlib.sha256()
 while True:
  data = source.read(1048576)
  if not data: break
  raw.update(data)
 source.seek(0)
 seen = {}; members = []
 with tarfile.open(fileobj=source, mode='r:') as archive:
  for member in archive:
   name = member.name
   if name.startswith('/'): raise ValueError('absolute archive path')
   name.encode('utf-8', 'strict')
   if name.startswith('./'): name = name[2:]
   if member.isdir() and name.endswith('/'): name = name[:-1]
   if name == '.': name = ''
   if not member.isdir() and not member.isreg(): raise ValueError('links and special files are unsupported')
   if member.sparse is not None or any('sparse' in key.lower() or key in ['linkpath', 'SCHILY.filetype'] for key in member.pax_headers): raise ValueError('sparse or linked archive member')
   if any(key not in ['path', 'size', 'uid', 'gid', 'uname', 'gname', 'mtime', 'atime', 'ctime', 'SCHILY.xattr.user.mime_type'] and not key.startswith('SCHILY.xattr.') for key in member.pax_headers): raise ValueError('unsupported archive metadata')
   if '\\' in name or '\x00' in name or name.startswith('/') or any(part in ['', '.', '..'] for part in name.split('/')) and name != '': raise ValueError('non-canonical archive path')
   if name in seen or (name == '' and not member.isdir()): raise ValueError('duplicate or invalid root member')
   if member.size < 0 or member.size > 9007199254740991 or member.offset_data + member.size > st.st_size: raise ValueError('invalid or truncated member size')
   if len(seen) >= 100000: raise ValueError('archive inventory exceeds supported 100000 entries; no partial archive accepted')
   seen[name] = 'directory' if member.isdir() else 'file'
   h = hashlib.sha256()
   if member.isreg():
    content = archive.extractfile(member)
    remaining = member.size
    while remaining:
     data = content.read(min(1048576, remaining))
     if not data: raise ValueError('truncated member')
     h.update(data); remaining -= len(data)
    content.close()
   elif member.size != 0: raise ValueError('directory contains data')
   members.append(dict(path=name, kind=seen[name], bytes=member.size, offset=member.offset_data, sha256=h.hexdigest()))
  end = archive.offset
 source.seek(end)
 trailer = source.read(1024)
 if len(trailer) != 1024 or any(trailer): raise ValueError('missing tar end marker')
 while True:
  tail = source.read(1048576)
  if not tail: break
  if any(tail): raise ValueError('unparsed trailing tar data')
 if st.st_size % 512: raise ValueError('unaligned tar')
 for name in seen:
  pieces = name.split('/')
  for index in range(1, len(pieces)):
   if seen.get('/'.join(pieces[:index])) == 'file': raise ValueError('file used as parent directory')
 after = os.fstat(source.fileno())
 if (st.st_size, st.st_mtime_ns, st.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns): raise ValueError('archive changed during verification')
 print(json.dumps(dict(bytes=st.st_size, sha256=raw.hexdigest(), members=members), ensure_ascii=True))
`;
async function verifyWorkspaceTar(path: string): Promise<VerifiedArchive> {
  return new Promise((accept, reject) => {
    const child = spawn('python3', ['-I', '-c', TAR_INVENTORY, path], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    let output = ''; let error = ''; let failure: Error | null = null;
    const timer = setTimeout(() => { failure = new EnvironmentError('archive-invalid', 'Archive inventory timed out; no cleanup allowed.'); child.kill('SIGKILL'); }, 300_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 64_000_000) { failure = new EnvironmentError('archive-invalid', 'Archive inventory too large; no partial export accepted.'); child.kill('SIGKILL'); } });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4096); });
    child.on('error', problem => { clearTimeout(timer); reject(problem); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) { reject(failure ?? new EnvironmentError('archive-invalid', `Full archive validation refused: ${error}`)); return; }
      try { accept(JSON.parse(output) as VerifiedArchive); } catch (problem) { reject(problem); }
    });
  });
}
interface DockerInspection {
  Id: string;
  Config: { User: string; Image: string; Labels: Record<string, string>; Env: string[] };
  State: { Running: boolean; Pid: number; Status: string; Paused: boolean; Restarting: boolean; Dead: boolean };
  HostConfig: { Privileged: boolean; ReadonlyRootfs: boolean; NetworkMode: string; CapDrop: string[]; CapAdd: string[] | null; SecurityOpt: string[]; Binds: string[] | null; PidMode: string; IpcMode: string; CgroupnsMode: string; Devices: unknown[]; Tmpfs: Record<string, string> };
  Mounts: { Type: string; Name?: string; Destination: string }[];
}
function labels(environment: ManagedEnvironment): string[] {
  return [`${LABEL}.product=${PRODUCT}`, `${LABEL}.root=${environment.rootId}`, `${LABEL}.environment=${environment.environmentId}`, `${LABEL}.task=${environment.taskId}`];
}
function validateManaged(environment: ManagedEnvironment): void {
  if (!/^[a-f0-9-]{36}$/.test(environment.rootId) || !/^[a-f0-9-]{36}$/.test(environment.environmentId) || !/^[a-f0-9]{64}$/.test(environment.containerId ?? '0'.repeat(64)) || environment.volume !== `spatial-task-${environment.rootId}-${environment.environmentId}`) throw new EnvironmentError('unmanaged-environment', 'Refusing an unmanaged container or volume.');
}
export class DockerEnvironmentEngine implements EnvironmentEngine {
  async readiness(): Promise<ReadinessItem> {
    try {
      const cgroup = (await docker(['info', '--format', '{{.CgroupVersion}}'])).trim();
      if (cgroup !== '2') throw new Error('cgroup-v2 is required');
      const image = JSON.parse(await docker(['image', 'inspect', IMAGE])) as { Config: { Labels: Record<string, string>; User: string } }[];
      if (image[0]?.Config.Labels[`${LABEL}.product`] !== PRODUCT || image[0]?.Config.User !== '1000:1000') throw new Error('app-owned non-root baseline image is missing');
      return { id: 'task-environment', state: 'ready', detail: LIMITATION };
    } catch (error) { return { id: 'task-environment', state: 'blocked', detail: `${String(error)}. Build with node scripts/environment-build.mjs. ${LIMITATION}` }; }
  }
  private async inspect(environment: ManagedEnvironment): Promise<DockerInspection> {
    validateManaged(environment);
    if (!environment.containerId) throw new EnvironmentError('container-missing', 'No managed container exists.');
    const result = JSON.parse(await docker(['inspect', '--type', 'container', environment.containerId])) as DockerInspection[];
    const item = result[0];
    if (!item || item.Id !== environment.containerId || labels(environment).some(label => { const at = label.indexOf('='); return item.Config.Labels[label.slice(0, at)] !== label.slice(at + 1); })) throw new EnvironmentError('unmanaged-environment', 'Container labels do not match this logical task.');
    const h = item.HostConfig;
    if (item.Config.Image !== IMAGE || item.Config.User !== '1000:1000' || item.Mounts.length !== 1 || h.Privileged || !h.ReadonlyRootfs || h.NetworkMode !== 'none' || !h.CapDrop?.includes('ALL') || (h.CapAdd?.length ?? 0) !== 0 || !h.SecurityOpt?.includes('no-new-privileges') || h.SecurityOpt.some(option => /unconfined/.test(option)) || (h.Binds?.length ?? 0) !== 0 || h.PidMode !== '' || h.IpcMode !== 'private' || h.CgroupnsMode !== 'private' || h.Devices.length !== 0 || item.Mounts.some(mount => mount.Type !== 'volume' || mount.Name !== environment.volume || mount.Destination !== '/workspace')) throw new EnvironmentError('unsafe-container', 'Managed container configuration differs from the confined baseline.');
    return item;
  }
  private async volume(environment: ManagedEnvironment): Promise<void> {
    validateManaged(environment);
    const volume = (JSON.parse(await docker(['volume', 'inspect', environment.volume])) as { Labels: Record<string, string>; Driver: string; Options: Record<string, unknown> | null }[])[0];
    if (!volume || volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length || labels(environment).some(label => { const at = label.indexOf('='); return volume.Labels[label.slice(0, at)] !== label.slice(at + 1); })) throw new EnvironmentError('unsafe-volume', 'Workspace volume ownership or driver does not match the task.');
  }
  async create(environment: ManagedEnvironment): Promise<string> {
    validateManaged(environment);
    if ((await this.readiness()).state !== 'ready') throw new EnvironmentError('environment-unavailable', 'Docker cgroup-v2 and the app-owned image are required.', 'Run node scripts/environment-build.mjs and check Docker readiness.');
    const labelArgs = labels(environment).flatMap(label => ['--label', label]);
    await docker(['volume', 'create', ...labelArgs, environment.volume]);
    await this.volume(environment);
    const id = (await docker(['create', ...labelArgs, '--name', `spatial-task-${environment.environmentId}-${randomUUID()}`, '--user', '1000:1000', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cgroupns', 'private', '--ipc', 'private', '--pids-limit', '256', '--memory', '1536m', '--cpus', '2', '--ulimit', 'nofile=4096:4096', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777', '--tmpfs', '/home/task:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=700', '--mount', `type=volume,src=${environment.volume},dst=/workspace`, IMAGE])).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker returned an invalid managed identity');
    return id;
  }
  async start(environment: ManagedEnvironment): Promise<void> {
    await this.inspect(environment);
    await docker(['start', environment.containerId!]);
    const limit = Date.now() + 25_000;
    while (Date.now() < limit) {
      try { const probe = await this.tool(environment, 'probe', {}); if (probe.ready === true) return; } catch { /* actual apps may still be starting */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Browser, terminal PTY and GTK app did not demonstrate readiness');
  }
  private async exists(environment: ManagedEnvironment): Promise<boolean> {
    validateManaged(environment);
    if (!environment.containerId) return false;
    const ids = (await docker(['ps', '-a', '--no-trunc', '--filter', `id=${environment.containerId}`, '--format', '{{.ID}}'])).trim();
    if (ids !== '' && ids !== environment.containerId) throw new Error('Managed container lookup returned an unexpected identity');
    return ids !== '';
  }
  async stopAndVerify(environment: ManagedEnvironment): Promise<void> {
    if (!await this.exists(environment)) return; // successful engine lookup proves absence, not a swallowed transport error
    const before = await this.inspect(environment);
    if (before.State.Running) await docker(['kill', '--signal', 'KILL', environment.containerId!]);
    const after = await this.inspect(environment);
    if (after.State.Running || after.State.Pid !== 0) throw new Error('Full-container stop could not be verified');
  }
  async remove(environment: ManagedEnvironment): Promise<void> {
    if (!await this.exists(environment)) return;
    const item = await this.inspect(environment);
    if (item.State.Running || item.State.Pid !== 0) throw new EnvironmentError('active-environment', 'Container must be verifiably stopped before removal.');
    await docker(['rm', environment.containerId!]);
  }
  async removeVolume(environment: ManagedEnvironment): Promise<void> {
    validateManaged(environment);
    const names = (await docker(['volume', 'ls', '--filter', `name=${environment.volume}`, '--format', '{{.Name}}'])).trim().split('\n');
    if (!names.includes(environment.volume)) return;
    await this.volume(environment); await docker(['volume', 'rm', environment.volume]);
  }
  private async verifyExportSource(environment: ManagedEnvironment): Promise<void> {
    const item = await this.inspect(environment);
    if (item.State.Running || item.State.Pid !== 0 || item.State.Paused || item.State.Restarting || item.State.Dead || !['created', 'exited'].includes(item.State.Status)) throw new EnvironmentError('active-environment', 'Export requires a known fully stopped workload, without stopping it implicitly.');
    await this.volume(environment);
    const consumers = (await docker(['ps', '-a', '--no-trunc', '--filter', `volume=${environment.volume}`, '--format', '{{.ID}}'])).trim();
    if (consumers !== environment.containerId) throw new EnvironmentError('unsafe-volume', 'Workspace has missing or additional container consumers; export is not a quiescence proof.');
  }
  async verifyWorkspace(environment: ManagedEnvironment): Promise<void> { await this.verifyExportSource(environment); }
  async captureWorkspace(environment: ManagedEnvironment, archiveFd: number): Promise<void> {
    await this.verifyExportSource(environment);
    // Fixed source, no -L, no host extraction, no helper container or exec into task code.
    await streamWorkspaceTar(environment.containerId!, archiveFd);
    await this.verifyExportSource(environment);
  }
  async tool(environment: ManagedEnvironment, operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!['probe', 'frame', 'input', 'exec', 'output', 'read', 'write'].includes(operation)) throw new EnvironmentError('unsupported-tool', 'Unsupported task tool.');
    const item = await this.inspect(environment);
    if (!item.State.Running) throw new EnvironmentError('environment-stopped', 'Task container is not running.');
    const result: unknown = JSON.parse(await docker(['exec', '-i', '--user', '1000:1000', environment.containerId!, 'python3', '/opt/spatial/tool.py', operation], JSON.stringify(payload), 35_000));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid task tool response');
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string') throw new EnvironmentError('task-tool-failed', record.error);
    return record;
  }
}

export interface TaskTools {
  exec(taskId: string, expectedEpoch: number, command: string): Promise<ShellResult>;
  read(taskId: string, path: string): Promise<Buffer>;
  write(taskId: string, expectedEpoch: number, path: string, content: Buffer | string): Promise<void>;
  input(input: TaskInput): Promise<void>;
}
export interface ArchiveStream { bytes: number; sha256: string; open(): Readable }
export interface ExportArtifact {
  taskId: string; environmentId: string; epoch: number;
  files: (ArchiveStream & { path: string })[];
  /** Owner-only raw tar preserves directories, mode/uid/gid/mtime and all supported metadata. */
  rawArchive: ArchiveStream;
}
interface ArchiveMember { path: string; kind: 'file' | 'directory'; bytes: number; offset: number; sha256: string }
interface VerifiedArchive { bytes: number; sha256: string; members: ArchiveMember[] }
interface CapturedArchive { epoch: number; generation: number; containerId: string | null; path: string; inventory: VerifiedArchive }
export interface OwnerTaskTools extends TaskTools {
  exportArchive(taskId: string, expectedEpoch: number): Promise<ExportArtifact>;
  takeControl(taskId: string, expectedEpoch: number, confirmRestart?: boolean): Promise<ControlLease>;
  resume(taskId: string, expectedEpoch: number, confirmRestart?: boolean): Promise<ControlLease>;
  stop(taskId: string, expectedEpoch: number, confirmReset?: boolean): Promise<ControlLease>;
  archive(taskId: string, expectedEpoch: number): Promise<EnvironmentSnapshot>;
  destroy(taskId: string, expectedEpoch: number): Promise<void>;
}
/** Host-only authority ports. A model tool schema must NEVER contain a role or these owner methods. */
export class EnvironmentBroker {
  private readonly engine: EnvironmentEngine;
  private readonly directory: string;
  private readonly rootId: string;
  private readonly environments = new Map<string, ManagedEnvironment>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly controls = new Set<string>();
  private readonly sequences = new Map<string, number>();
  private readonly archives = new Map<string, CapturedArchive>();
  private readonly releaseLease: () => void;
  private closed = false;
  constructor(directory: string, engine: EnvironmentEngine = new DockerEnvironmentEngine()) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (realpathSync(this.directory) !== this.directory) throw new EnvironmentError('unsafe-data-root', 'Environment data root must not resolve through symlinks.');
    chmodSync(this.directory, 0o700);
    try { this.releaseLease = acquireFileLease(join(this.directory, 'broker.lock')); }
    catch (error) { throw new EnvironmentError('broker-locked', String(error), 'Stop the competing app-owned broker. Do not remove its lock file; crash recovery releases the kernel lease, not uncertain task work.'); }
    this.engine = engine;
    try {
      const rootFile = join(this.directory, 'root-id');
      if (!existsSync(rootFile)) { const root = openSync(rootFile, 'wx', 0o600); try { writeFileSync(root, randomUUID()); fsyncSync(root); } finally { closeSync(root); } }
      this.rootId = readFileSync(rootFile, 'utf8');
      if (!/^[a-f0-9-]{36}$/.test(this.rootId)) throw new Error('Invalid private root identity');
      const stateFile = join(this.directory, 'environments.json');
      if (existsSync(stateFile)) {
        const rows = JSON.parse(readFileSync(stateFile, 'utf8')) as ManagedEnvironment[];
        for (const row of rows) {
          validateManaged(row);
          if (row.rootId !== this.rootId || !Number.isSafeInteger(row.epoch) || !Number.isSafeInteger(row.generation) || typeof row.taskId !== 'string') throw new Error('Invalid persisted task environment');
          // No automatic replay/restart on host recovery. Unknown in-flight work remains visible.
          if (row.state !== 'stopped' && row.state !== 'archived' && row.state !== 'destroyed') { row.state = 'uncertain'; row.owner = 'uncertain'; row.detail = 'Host broker restarted; reconcile by an explicitly confirmed full reset. ' + LIMITATION; }
          row.epoch++; row.generation++;
          this.environments.set(row.taskId, row);
        }
        this.persist();
      }
    } catch (error) { this.releaseLease(); throw error; }
  }
  private persist(): void {
    const temporary = join(this.directory, 'environments.json.tmp');
    const file = openSync(temporary, 'w', 0o600);
    try { writeFileSync(file, JSON.stringify([...this.environments.values()])); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, join(this.directory, 'environments.json'));
    const directory = openSync(this.directory, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  private get(taskId: string): ManagedEnvironment {
    if (this.closed) throw new EnvironmentError('broker-closed', 'Environment broker is closed.');
    const item = this.environments.get(taskId);
    if (!item || item.state === 'destroyed') throw new EnvironmentError('environment-missing', 'Task has no live environment.');
    return item;
  }
  private lease(item: ManagedEnvironment): ControlLease { return { taskId: item.taskId, owner: item.owner, epoch: item.epoch, detail: item.detail }; }
  snapshot(taskId: string): EnvironmentSnapshot {
    const item = this.get(taskId);
    return { taskId, environmentId: item.environmentId, state: item.state, lease: this.lease(item), views: this.taskViews(item), detail: item.detail };
  }
  snapshots(): EnvironmentSnapshot[] { return [...this.environments.values()].filter(item => item.state !== 'destroyed').map(item => this.snapshot(item.taskId)); }
  views(): ToolView[] { return this.snapshots().flatMap(snapshot => snapshot.views); }
  private taskViews(item: ManagedEnvironment): ToolView[] {
    return (['browser', 'terminal', 'desktop'] as ViewKind[]).map(kind => ({ id: `${item.environmentId}:${kind}`, taskId: item.taskId, environmentId: item.environmentId, kind, title: { browser: 'Offline Chromium', terminal: 'Task PTY terminal', desktop: 'Mousepad Linux desktop' }[kind], available: item.state === 'running', generation: item.generation, detail: item.detail }));
  }
  readiness(): Promise<ReadinessItem> { return this.engine.readiness(); }
  async create(taskId: string): Promise<EnvironmentSnapshot> {
    if (this.closed) throw new EnvironmentError('broker-closed', 'Environment broker is closed.');
    if (typeof taskId !== 'string' || !taskId || taskId.length > 256 || [...taskId].some(character => character.charCodeAt(0) < 32)) throw new EnvironmentError('invalid-task', 'A bounded logical task ID is required.');
    if (this.environments.get(taskId)?.state === 'destroyed') throw new EnvironmentError('environment-destroyed', 'This logical task environment was destroyed. Use a new logical task ID; old leases must never become valid again.');
    if (this.environments.has(taskId)) return this.snapshot(taskId);
    const environmentId = randomUUID();
    const item: ManagedEnvironment = { taskId, environmentId, rootId: this.rootId, containerId: null, volume: `spatial-task-${this.rootId}-${environmentId}`, generation: 1, epoch: 1, owner: 'handoff', state: 'starting', detail: LIMITATION };
    this.environments.set(taskId, item); this.controls.add(taskId);
    try {
      this.persist();
      item.containerId = await this.engine.create({ ...item }); this.persist();
      await this.engine.start({ ...item });
      item.state = 'running'; item.owner = 'agent'; this.persist();
    } catch (error) { this.uncertain(item, error); throw error; }
    finally { this.controls.delete(taskId); }
    return this.snapshot(taskId);
  }
  /** Call when the view transport reconnects/replaces its subscriptions, not for every snapshot. */
  reconnect(taskId: string): EnvironmentSnapshot { const item = this.get(taskId); item.generation++; this.persist(); return this.snapshot(taskId); }
  private view(item: ManagedEnvironment, viewId: string): ViewKind {
    const view = this.taskViews(item).find(view => view.id === viewId);
    if (!view) throw new EnvironmentError('stale-view', 'View does not belong to this task environment.');
    return view.kind as ViewKind;
  }
  async frame(taskId: string, viewId: string, preflight?: (taskId: string) => void): Promise<TaskFrame> {
    const item = this.get(taskId); const view = this.view(item, viewId); const captured = { ...item };
    if (item.state !== 'running') throw new EnvironmentError('environment-unavailable', item.detail);
    preflight?.(taskId);
    const result = await this.engine.tool(captured, 'frame', { view });
    if (item.generation !== captured.generation || item.epoch !== captured.epoch || item.state !== 'running') throw new EnvironmentError('stale-frame', 'Environment changed during frame capture.');
    preflight?.(taskId);
    if (typeof result.pngBase64 !== 'string' || result.width !== 1280 || result.height !== 800) throw new Error('Invalid actual frame dimensions');
    const png = Buffer.from(result.pngBase64, 'base64');
    if (png.length < 32 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Task frame is not PNG');
    const sequence = (this.sequences.get(viewId) ?? 0) + 1; this.sequences.set(viewId, sequence);
    return { png, identity: { environmentId: item.environmentId, viewId, generation: item.generation, sequence, capturedAt: new Date().toISOString(), width: 1280, height: 800, leaseEpoch: item.epoch } };
  }
  async terminal(taskId: string): Promise<string> {
    const item = this.getRunning(taskId); const captured = { ...item };
    const result = await this.engine.tool(captured, 'output', {});
    if (item.epoch !== captured.epoch || item.generation !== captured.generation || item.state !== 'running') throw new EnvironmentError('stale-terminal', 'Terminal workload changed during capture.');
    if (typeof result.output !== 'string') throw new Error('Invalid PTY output'); return result.output;
  }
  private getRunning(taskId: string): ManagedEnvironment { const item = this.get(taskId); if (item.state !== 'running') throw new EnvironmentError('environment-unavailable', item.detail); return item; }
  private check(item: ManagedEnvironment, role: Role, epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch !== item.epoch) throw new EnvironmentError('stale-epoch', 'Task-wide mutation epoch is stale.');
    if (item.state !== 'running' || item.owner !== role || this.controls.has(item.taskId)) throw new EnvironmentError('control-unavailable', `Mutations blocked: ${item.owner}/${item.state}. ${item.detail}`);
  }
  private uncertain(item: ManagedEnvironment, error: unknown): void { item.state = 'uncertain'; item.owner = 'uncertain'; item.epoch++; item.generation++; item.detail = `Workload state is uncertain: ${String(error)}. Explicit verified reset required. ${LIMITATION}`; this.persist(); }
  private mutate<T>(taskId: string, role: Role, epoch: number, operation: (environment: ManagedEnvironment) => Promise<T>, preflight?: (environment: ManagedEnvironment) => void): Promise<T> {
    const item = this.get(taskId); this.check(item, role, epoch);
    const prior = this.queues.get(taskId) ?? Promise.resolve();
    const pending = prior.catch(() => undefined).then(async () => {
      const captured = { ...item };
      try {
        this.check(item, role, epoch); // queued callers cannot survive an epoch change
        preflight?.(captured);
      } catch (error) {
        throw new EnvironmentError(error instanceof EnvironmentError ? error.code : 'mutation-not-admitted', String(error), undefined, 'not-sent');
      }
      let result: T;
      try {
        result = await operation(captured);
      } catch (error) {
        // An old workload failure after reset must not poison the replacement's lease.
        if (item.epoch === epoch && item.containerId === captured.containerId) this.uncertain(item, error);
        throw new EnvironmentError(error instanceof EnvironmentError ? error.code : 'mutation-uncertain', String(error), undefined, 'uncertain');
      }
      try {
        this.check(item, role, epoch); // do not acknowledge effects from a superseded workload
        preflight?.(captured); // changed authority can withhold an already-sent effect's acknowledgement
      } catch (error) {
        throw new EnvironmentError(error instanceof EnvironmentError ? error.code : 'mutation-unacknowledged', String(error), undefined, 'uncertain');
      }
      return result;
    });
    this.queues.set(taskId, pending);
    void pending.finally(() => { if (this.queues.get(taskId) === pending) this.queues.delete(taskId); }).catch(() => undefined);
    return pending;
  }
  private port(role: Role, preflight?: (taskId: string) => void): TaskTools {
    return Object.freeze({
      exec: (taskId: string, epoch: number, command: string) => {
        if (typeof command !== 'string' || !command || Buffer.byteLength(command) > 65536) throw new EnvironmentError('invalid-command', 'Command must be 1–65536 bytes.');
        return this.mutate(taskId, role, epoch, async item => { const result = await this.engine.tool(item, 'exec', { command, timeout: 20 }); if (typeof result.output !== 'string' || !Number.isInteger(result.exitCode)) throw new Error('Invalid shell result'); return { output: result.output, exitCode: result.exitCode as number }; }, () => preflight?.(taskId));
      },
      read: async (taskId: string, path: string) => {
        this.validatePath(path);
        const item = this.getRunning(taskId); const captured = { ...item };
        preflight?.(taskId);
        const result = await this.engine.tool(captured, 'read', { path });
        if (item.epoch !== captured.epoch || item.generation !== captured.generation || item.state !== 'running') throw new EnvironmentError('stale-read', 'Workspace workload changed during read; no content is acknowledged.');
        preflight?.(taskId);
        if (typeof result.contentBase64 !== 'string') throw new Error('Invalid workspace file');
        return Buffer.from(result.contentBase64, 'base64');
      },
      write: (taskId: string, epoch: number, path: string, content: Buffer | string) => {
        this.validatePath(path); const data = Buffer.from(content);
        if (data.length > 1048576) throw new EnvironmentError('file-too-large', 'Workspace file API supports up to 1 MiB.');
        return this.mutate(taskId, role, epoch, async item => { await this.engine.tool(item, 'write', { path, contentBase64: data.toString('base64') }); }, () => preflight?.(taskId));
      },
      input: (request: TaskInput) => {
        const input = { ...request }; // caller mutation must not rewrite a queued identity
        const item = this.get(input.taskId); const view = this.view(item, input.viewId);
        if (input.environmentId !== item.environmentId || input.generation !== item.generation) throw new EnvironmentError('stale-view', 'Input environment or frame generation is stale.');
        if (!['pointer', 'key', 'text'].includes(input.kind) || !Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.x >= 1280 || input.y < 0 || input.y >= 800 || !['left', 'middle', 'right', ''].includes(input.button) || (input.kind === 'pointer' && input.button === '') || typeof input.text !== 'string' || input.text.length > 65536 || typeof input.key !== 'string' || (input.kind === 'key' && !/^[A-Za-z0-9_+]{1,80}$/.test(input.key))) throw new EnvironmentError('invalid-input', 'Input is outside the demonstrated desktop bounds.');
        return this.mutate(item.taskId, role, input.leaseEpoch, async captured => {
          await this.engine.tool(captured, 'input', { view, kind: input.kind, x: Math.floor(input.x), y: Math.floor(input.y), button: input.button, key: input.key, text: input.text });
        }, () => { if (input.generation !== item.generation) throw new EnvironmentError('stale-view', 'Queued frame generation changed.'); preflight?.(item.taskId); });
      }
    });
  }
  private validatePath(path: string): void { if (typeof path !== 'string' || path.length > 4096 || path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\0')) throw new EnvironmentError('invalid-workspace-path', 'Only relative private workspace files are accepted.'); }
  /** Guard runs inside the queue at tool admission, not only before awaiting it. */
  agent(preflight?: (taskId: string) => void): Readonly<TaskTools> { return this.port('agent', preflight); }
  owner(preflight?: (taskId: string) => void): OwnerTaskTools {
    const transition = (taskId: string, epoch: number, target: Role | 'stopped', confirm: boolean) => {
      preflight?.(taskId);
      return this.transition(taskId, epoch, target, confirm);
    };
    return Object.freeze({ ...this.port('owner', preflight),
      takeControl: (taskId: string, epoch: number, confirm = false) => transition(taskId, epoch, 'owner', confirm),
      resume: (taskId: string, epoch: number, confirm = false) => transition(taskId, epoch, 'agent', confirm),
      stop: (taskId: string, epoch: number, confirm = false) => transition(taskId, epoch, 'stopped', confirm),
      exportArchive: (taskId: string, epoch: number) => this.exportArchive(taskId, epoch),
      archive: (taskId: string, epoch: number) => this.archive(taskId, epoch),
      destroy: (taskId: string, epoch: number) => this.destroy(taskId, epoch)
    });
  }
  private async transition(taskId: string, expectedEpoch: number, target: Role | 'stopped', confirmed: boolean): Promise<ControlLease> {
    const item = this.get(taskId);
    if (expectedEpoch !== item.epoch) throw new EnvironmentError('stale-epoch', 'Control request must use the current task epoch.');
    if (this.controls.has(taskId) || item.state === 'archived') throw new EnvironmentError('control-unavailable', 'Control transition is already in progress or task is archived.');
    if (item.state === 'running' && item.owner === target) return this.lease(item);
    if (target === 'stopped' && item.state === 'stopped') return this.lease(item);
    if (confirmed !== true) {
      const current = item.state === 'running' ? `Current workload is NOT stopped; ${item.owner} retains its existing control.` : item.state === 'stopped' ? 'Workload is already verifiably stopped; reopening still requires explicit confirmation.' : 'Workload stop status is uncertain; all tool mutations remain blocked.';
      return { taskId, owner: 'handoff', epoch: item.epoch, detail: `confirmation-required: ${LIMITATION} ${current} Explicitly confirm restart/reset before proceeding.` };
    }
    this.controls.add(taskId); item.epoch++; item.generation++; item.owner = 'handoff'; item.detail = `Verifying complete workload teardown before ${target}. ${LIMITATION}`;
    try {
      this.persist();
      if (item.containerId) await this.engine.stopAndVerify({ ...item });
      // Replace the physical container, not just restart its ID. A delayed old Docker exec
      // must never land in the fresh workload after its prior stop was verified.
      if (target === 'stopped') { item.state = 'stopped'; item.owner = 'handoff'; }
      else {
        if (item.containerId) { await this.engine.remove({ ...item }); item.containerId = null; this.persist(); }
        item.state = 'starting'; this.persist();
        item.containerId = await this.engine.create({ ...item }); this.persist();
        await this.engine.start({ ...item });
        item.state = 'running'; item.owner = target;
      }
      item.detail = (target === 'stopped' ? 'Full workload stop verified. ' : `Exclusive ${target} control acknowledged after verified reset. `) + LIMITATION;
      this.persist(); return this.lease(item);
    } catch (error) { this.uncertain(item, error); return this.lease(item); }
    finally { this.controls.delete(taskId); }
  }
  private inactive(taskId: string, epoch: number): ManagedEnvironment {
    const item = this.get(taskId);
    if (epoch !== item.epoch) throw new EnvironmentError('stale-epoch', 'Cleanup epoch is stale.');
    if (!['stopped', 'archived'].includes(item.state) || this.controls.has(taskId) || this.queues.has(taskId)) throw new EnvironmentError('active-environment', 'Cleanup refuses active, queued or uncertain work. Explicitly stop and verify it first.');
    return item;
  }
  /** Trusted host-only history fence. Retains volumes; never captures, stops or destroys work. */
  async withInactive<T>(tasks: readonly { taskId: string; epoch: number }[], callback: (assertCurrent: () => void) => T): Promise<T> {
    if (new Set(tasks.map(task => task.taskId)).size !== tasks.length) throw new EnvironmentError('invalid-task', 'Inactive proof needs unique task identities.');
    if (callback.constructor.name === 'AsyncFunction') throw new EnvironmentError('invalid-callback', 'History commit must be synchronous.');
    // Prove every task before adding any controls; otherwise a refused sibling leaks a fence.
    const items = tasks.map(task => this.inactive(task.taskId, task.epoch));
    if (items.length && !this.engine.verifyWorkspace) throw new EnvironmentError('verification-unavailable', 'Actual stopped workspace verification is required for history archive.');
    const captures = items.map(item => ({ ...item }));
    const assertCurrent = () => {
      if (this.closed) throw new EnvironmentError('broker-closed', 'Environment broker is closed.');
      for (const captured of captures) {
        const item = this.get(captured.taskId);
        if (!this.controls.has(item.taskId) || this.queues.has(item.taskId) || item.environmentId !== captured.environmentId ||
          item.containerId !== captured.containerId || item.volume !== captured.volume || item.generation !== captured.generation ||
          item.epoch !== captured.epoch || item.state !== captured.state || !['stopped', 'archived'].includes(item.state)) {
          throw new EnvironmentError('stale-archive-proof', 'Task identity or inactivity changed during the held history proof.');
        }
      }
    };
    items.forEach(item => this.controls.add(item.taskId));
    try {
      for (const captured of captures) { await this.engine.verifyWorkspace!({ ...captured }); assertCurrent(); }
      assertCurrent();
      const result = callback(assertCurrent);
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        void Promise.resolve(result).catch(() => undefined);
        throw new EnvironmentError('invalid-callback', 'History commit returned a promise.');
      }
      return result;
    } finally { items.forEach(item => this.controls.delete(item.taskId)); }
  }
  private captureCurrent(item: ManagedEnvironment, capture: CapturedArchive): void {
    if (item.epoch !== capture.epoch || item.generation !== capture.generation || item.containerId !== capture.containerId || !['stopped', 'archived'].includes(item.state)) throw new EnvironmentError('stale-export', 'Workspace identity changed during archive capture or consumption.');
  }
  private async capture(item: ManagedEnvironment): Promise<CapturedArchive> {
    if (!this.engine.captureWorkspace) throw new EnvironmentError('export-unavailable', 'This engine cannot prove a full workspace export. No cleanup is allowed.');
    const archives = join(this.directory, 'archives');
    mkdirSync(archives, { recursive: true, mode: 0o700 }); syncArchiveDirectory(this.directory);
    if (realpathSync(archives) !== archives || (lstatSync(archives).mode & 0o077)) throw new EnvironmentError('private-output-required', 'Archive storage must be a real OS-private directory.');
    const directory = join(archives, randomUUID()); mkdirSync(directory, { mode: 0o700 }); syncArchiveDirectory(archives);
    if ((lstatSync(directory).mode & 0o077)) throw new EnvironmentError('private-output-required', 'Archive storage permissions are not an access boundary on this filesystem.');
    const pending = join(directory, 'workspace.pending.tar');
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const capture: CapturedArchive = { epoch: item.epoch, generation: item.generation, containerId: item.containerId, path: pending, inventory: { bytes: 0, sha256: '', members: [] } };
    try {
      if ((fstatSync(fd).mode & 0o077)) throw new EnvironmentError('private-output-required', 'Archive file is not private.');
      await this.engine.captureWorkspace({ ...item }, fd); fsyncSync(fd);
    } finally { closeSync(fd); syncArchiveDirectory(directory); }
    this.captureCurrent(item, capture);
    capture.inventory = await verifyWorkspaceTar(pending);
    this.captureCurrent(item, capture);
    const inventoryFd = openSync(join(directory, 'inventory.json'), 'wx', 0o600);
    try { writeFileSync(inventoryFd, JSON.stringify(capture.inventory)); fsyncSync(inventoryFd); } finally { closeSync(inventoryFd); }
    const committed = join(directory, 'workspace.tar'); renameSync(pending, committed); syncArchiveDirectory(directory);
    capture.path = committed; this.archives.set(item.taskId, capture); return capture;
  }
  private async verifyCapture(item: ManagedEnvironment, capture: CapturedArchive): Promise<void> {
    this.captureCurrent(item, capture);
    const inventory = await verifyWorkspaceTar(capture.path);
    if (JSON.stringify(inventory) !== JSON.stringify(capture.inventory)) throw new EnvironmentError('archive-corrupt', 'Durable archive bytes or inventory changed. Workspace retained.');
    this.captureCurrent(item, capture);
  }
  private async exportArchive(taskId: string, epoch: number): Promise<ExportArtifact> {
    const item = this.inactive(taskId, epoch); this.controls.add(taskId);
    try {
      const capture = await this.capture(item);
      const stream = (offset: number, bytes: number, sha256: string): ArchiveStream => ({ bytes, sha256, open: () => {
        this.get(taskId); this.captureCurrent(item, capture);
        if (bytes === 0) return Readable.from([]);
        const fd = openSync(capture.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size !== capture.inventory.bytes || (stat.mode & 0o077)) { closeSync(fd); throw new EnvironmentError('archive-corrupt', 'Private archive was replaced or changed.'); }
        const source = createReadStream('', { fd, autoClose: true, start: offset, end: offset + bytes - 1 });
        const guard = () => { this.get(taskId); this.captureCurrent(item, capture); };
        return Readable.from((async function* () {
          for await (const chunk of source) { guard(); yield chunk; }
          guard();
        })());
      } });
      return { taskId, environmentId: item.environmentId, epoch,
        files: capture.inventory.members.filter(member => member.kind === 'file').map(member => ({ path: member.path, ...stream(member.offset, member.bytes, member.sha256) })),
        rawArchive: stream(0, capture.inventory.bytes, capture.inventory.sha256) };
    } finally { this.controls.delete(taskId); }
  }
  private async archive(taskId: string, epoch: number): Promise<EnvironmentSnapshot> {
    const item = this.inactive(taskId, epoch); this.controls.add(taskId);
    try {
      await this.engine.verifyWorkspace?.({ ...item });
      const previous = this.archives.get(taskId);
      if (previous) await this.verifyCapture(item, previous); else await this.capture(item);
      item.state = 'archived'; item.detail = 'Archived with verified complete durable workspace tar and file inventory. ' + LIMITATION; this.persist(); return this.snapshot(taskId);
    } finally { this.controls.delete(taskId); }
  }
  private async destroy(taskId: string, epoch: number): Promise<void> {
    const item = this.inactive(taskId, epoch);
    const capture = this.archives.get(taskId);
    if (item.state !== 'archived' || !capture) throw new EnvironmentError('archive-required', 'Destruction requires a verified full durable archive at this epoch.');
    this.controls.add(taskId);
    try {
      await this.verifyCapture(item, capture);
      await this.engine.verifyWorkspace?.({ ...item }); this.captureCurrent(item, capture);
      if (item.containerId) { await this.engine.remove({ ...item }); this.captureCurrent(item, capture); item.containerId = null; this.persist(); }
      if (item.epoch !== capture.epoch || item.generation !== capture.generation) throw new EnvironmentError('stale-export', 'Cleanup identity changed before volume removal.');
      await this.engine.removeVolume({ ...item });
      if (item.epoch !== capture.epoch || item.generation !== capture.generation) throw new EnvironmentError('stale-export', 'Cleanup identity changed during volume removal.');
      item.state = 'destroyed'; item.owner = 'handoff'; item.epoch++; item.generation++; item.detail = 'Destroyed after verified full archive; this task ID cannot be reused with a reset mutation epoch.'; this.persist();
    } catch (error) { this.uncertain(item, error); throw error; }
    finally { this.controls.delete(taskId); }
  }
  /** Releases the host lock, not task processes. Reopening reports running work uncertain. */
  close(): void {
    if (this.controls.size || this.queues.size) throw new EnvironmentError('broker-busy', 'Cannot close while operations are pending.');
    if (!this.closed) { this.closed = true; this.releaseLease(); }
  }
}
