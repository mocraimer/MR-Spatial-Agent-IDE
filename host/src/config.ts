import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isIP } from 'node:net';
import type { ExecutionScope } from './execution.js';
import type { RuntimeProfile } from './runtime-adapters.js';
import type { OpenAiSpeechOptions } from './speech.js';

export const DEFAULT_HOST_ROOT = join(homedir(), '.local/share/spatial-agent-workspace/host');
export interface ScopeRegistration {
  projectId: string; spaceId: string; receiver: 'space' | 'task'; runtime: RuntimeProfile['runtime']; scope: ExecutionScope;
}
export interface RuntimeAccountRegistration { runtime: 'claude-local'; orgId: string; email: string }
export interface HostConfig {
  root: string; nativeHost: string; nativePort: number; consolePort: number;
  telemetry: { enabled: boolean; maxBytes: number };
  coordinator: { buildDirectory: string; stateRoot: string; operator: string; activationEvidence: string } | null;
  profiles: RuntimeProfile[]; scopes: ScopeRegistration[]; runtimeAccounts: RuntimeAccountRegistration[];
  /** Speech-owned options are parsed by its service, never passed to models. */
  speechConfig: string | null;
}
function invalid(field: string): never { throw new Error(`Invalid private host configuration: ${field}. See docs/HOST-SETUP.md.`); }
function object(value: unknown, fields: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(name);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !fields.includes(key))) invalid(name);
  return record;
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || [...value].some(character => character.charCodeAt(0) < 32)) invalid(name);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(name);
  return value as number;
}
function absolute(value: unknown, name: string): string {
  const path = text(value, name, 4096); if (!isAbsolute(path) || resolve(path) !== path) invalid(name); return path;
}
function child(value: unknown, root: string, name: string): string {
  const path = absolute(value, name), part = relative(root, path);
  if (!part || part.startsWith('..') || isAbsolute(part)) invalid(name); return path;
}
function array(value: unknown, name: string, max = 256): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(name); return value;
}
function runtime(value: unknown): RuntimeProfile['runtime'] {
  if (value !== 'pi-local' && value !== 'claude-local') invalid('profile.runtime'); return value;
}
function strings(value: unknown, name: string): string[] {
  const result = array(value, name).map(item => text(item, name));
  if (!result.length || new Set(result).size !== result.length) invalid(name); return result;
}
/** Reject links and public permissions without reading secret file contents. */
export function assertPrivatePath(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || realpathSync(path) !== resolve(path)) invalid('private path ownership/mode');
}
export function readPrivateJson(path: string): unknown {
  assertPrivatePath(path);
  if (lstatSync(path).size > 131072) invalid('configuration size');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
export function prepareHostRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Never chmod through a link or adopt someone else's root.
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || realpathSync(root) !== root || (process.getuid && stat.uid !== process.getuid())) invalid('root ownership');
  chmodSync(root, 0o700);
  for (const name of ['auth', 'tls', 'environments', 'logs', 'evidence']) {
    const path = join(root, name); mkdirSync(path, { recursive: true, mode: 0o700 }); assertPrivatePath(path, true);
  }
}
export function parseHostConfig(value: unknown, root = DEFAULT_HOST_ROOT): HostConfig {
  root = absolute(root, 'root');
  const b = object(value, ['nativeHost', 'nativePort', 'consolePort', 'telemetry', 'coordinator', 'profiles', 'scopes', 'runtimeAccounts', 'speechConfig'], 'host');
  const nativeHost = b.nativeHost === undefined ? '127.0.0.1' : text(b.nativeHost, 'nativeHost');
  if (!isIP(nativeHost)) invalid('nativeHost must be an explicit IP address');
  const nativePort = integer(b.nativePort ?? 47843, 'nativePort', 0, 65535), consolePort = integer(b.consolePort ?? 47844, 'consolePort', 0, 65535);
  if (nativePort !== 0 && nativePort === consolePort) invalid('distinct ports');
  const telemetry = object(b.telemetry ?? {}, ['enabled', 'maxBytes'], 'telemetry');
  if (telemetry.enabled !== undefined && typeof telemetry.enabled !== 'boolean') invalid('telemetry.enabled');
  let coordinator: HostConfig['coordinator'] = null;
  if (b.coordinator !== undefined) {
    const c = object(b.coordinator, ['buildDirectory', 'stateRoot', 'operator', 'activationEvidence'], 'coordinator');
    coordinator = { buildDirectory: absolute(c.buildDirectory, 'coordinator.buildDirectory'), stateRoot: absolute(c.stateRoot, 'coordinator.stateRoot'), operator: text(c.operator, 'coordinator.operator'), activationEvidence: child(c.activationEvidence, root, 'coordinator.activationEvidence') };
    if (relative(root, coordinator.stateRoot) === '' || coordinator.stateRoot.startsWith(`${root}/`)) invalid('coordinator state must remain separate from product data');
  }
  const profiles = array(b.profiles ?? [], 'profiles', 2).map(value => {
    const p = object(value, ['runtime', 'bin', 'configDirectory', 'dataDirectory', 'scriptDirectory', 'models', 'subscriptionId'], 'profile');
    const kind = runtime(p.runtime);
    const models = array(p.models, 'profile.models', 64).map(value => {
      const m = object(value, ['id', 'efforts'], 'model');
      const id = text(m.id, 'model.id'); if (kind === 'pi-local' && !/^[^/\s]+\/[^\s]+$/.test(id)) invalid('exact Pi provider/model');
      return { id, efforts: strings(m.efforts, 'model.efforts') };
    });
    if (!models.length || new Set(models.map(m => m.id)).size !== models.length) invalid('explicit unique model catalogue');
    return { runtime: kind, bin: absolute(p.bin, 'profile.bin'), configDirectory: child(p.configDirectory, root, 'profile.configDirectory'), dataDirectory: child(p.dataDirectory, root, 'profile.dataDirectory'), scriptDirectory: absolute(p.scriptDirectory, 'profile.scriptDirectory'), models, subscriptionId: text(p.subscriptionId, 'profile.subscriptionId') };
  });
  if (new Set(profiles.map(p => p.runtime)).size !== profiles.length) invalid('one profile per runtime');
  for (const profile of profiles) {
    if (profile.configDirectory === profile.dataDirectory || profile.configDirectory.startsWith(`${profile.dataDirectory}/`) || profile.dataDirectory.startsWith(`${profile.configDirectory}/`)) invalid('separate CLI config and runtime history directories');
    if (['auth', 'tls', 'environments', 'logs', 'evidence'].some(name => [profile.configDirectory, profile.dataDirectory].some(path => path === join(root, name) || path.startsWith(`${join(root, name)}/`)))) invalid('runtime directories must not contain host secrets/state');
  }
  const directories = profiles.flatMap(profile => [profile.configDirectory, profile.dataDirectory]);
  if (directories.some((path, index) => directories.some((other, j) => index !== j && (path === other || path.startsWith(`${other}/`))))) invalid('runtime profiles must not share config/history directories');
  const scopes = array(b.scopes ?? [], 'scopes').map(value => {
    const s = object(value, ['projectId', 'spaceId', 'receiver', 'runtime', 'scope'], 'scope registration');
    if (s.receiver !== 'space' && s.receiver !== 'task') invalid('scope receiver');
    const c = object(s.scope, ['repo', 'workClass', 'profile', 'actions', 'approvalId', 'triggerSource', 'estimate', 'timeoutMs'], 'scope');
    const actions = strings(c.actions, 'scope.actions');
    if (!actions.includes('conversation') || actions.some(action => !['conversation', 'task-tools', 'delegate-task'].includes(action)) || (s.receiver === 'space' && actions.includes('task-tools') && !actions.includes('delegate-task'))) invalid('bounded interactive actions');
    const e = object(c.estimate, ['basis', 'detail', 'fiveHourPercent', 'weeklyPercent', 'uncertaintyPercent'], 'scope.estimate');
    if (!['operator-bound', 'comparable-history', 'calibration-approval', 'none'].includes(String(e.basis))) invalid('estimate basis');
    const percent = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) invalid('estimate percentage'); return value; };
    const scope: ExecutionScope = { repo: text(c.repo, 'scope.repo'), workClass: text(c.workClass, 'scope.workClass'), profile: text(c.profile, 'scope.profile'), actions: actions as ExecutionScope['actions'], estimate: { basis: e.basis as ExecutionScope['estimate']['basis'], detail: text(e.detail, 'estimate.detail', 4096), fiveHourPercent: percent(e.fiveHourPercent), weeklyPercent: percent(e.weeklyPercent), uncertaintyPercent: percent(e.uncertaintyPercent) }, timeoutMs: integer(c.timeoutMs, 'scope.timeoutMs', 1000, 3600000), ...(c.approvalId === undefined ? {} : { approvalId: text(c.approvalId, 'scope.approvalId') }), ...(c.triggerSource === undefined ? {} : { triggerSource: text(c.triggerSource, 'scope.triggerSource') }) };
    const kind = runtime(s.runtime); if (!profiles.some(p => p.runtime === kind)) invalid('scope runtime lacks owner profile');
    return { projectId: text(s.projectId, 'scope.projectId'), spaceId: text(s.spaceId, 'scope.spaceId'), receiver: s.receiver, runtime: kind, scope } as ScopeRegistration;
  });
  if (new Set(scopes.map(s => JSON.stringify([s.projectId, s.spaceId, s.receiver, s.runtime]))).size !== scopes.length) invalid('duplicate receiver scope');
  if ((profiles.length || scopes.length) && !coordinator) invalid('profiles/scopes require explicit coordinator');
  const runtimeAccounts = array(b.runtimeAccounts ?? [], 'runtimeAccounts', 1).map(value => {
    const a = object(value, ['runtime', 'orgId', 'email'], 'runtime account');
    if (a.runtime !== 'claude-local' || !profiles.some(p => p.runtime === a.runtime)) invalid('only Claude currently exposes comparable reader identity');
    const email = text(a.email, 'runtime account email'); if (!/^[^\s@]+@[^\s@]+$/.test(email)) invalid('runtime account email');
    return { runtime: a.runtime, orgId: text(a.orgId, 'runtime account orgId'), email } as RuntimeAccountRegistration;
  });
  return { root, nativeHost, nativePort, consolePort, runtimeAccounts, telemetry: { enabled: telemetry.enabled === true, maxBytes: integer(telemetry.maxBytes ?? 8388608, 'telemetry.maxBytes', 16384, 16777216) }, coordinator, profiles, scopes, speechConfig: b.speechConfig === undefined ? null : child(b.speechConfig, root, 'speechConfig') };
}
export function loadSpeechOptions(path: string, root: string): OpenAiSpeechOptions {
  const s = object(readPrivateJson(path), ['journalPath', 'approvedPerCallUsd', 'approvedDailyUsd', 'pricing', 'voice', 'timeoutMs', 'audioCacheBytes'], 'speech');
  const options: OpenAiSpeechOptions = { journalPath: s.journalPath === undefined ? join(root, 'speech.sqlite') : child(s.journalPath, root, 'speech.journalPath') };
  const usd = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000) invalid('speech cost'); return value; };
  if (s.approvedPerCallUsd !== undefined) options.approvedPerCallUsd = usd(s.approvedPerCallUsd);
  if (s.approvedDailyUsd !== undefined) options.approvedDailyUsd = usd(s.approvedDailyUsd);
  if (s.pricing !== undefined) {
    const p = object(s.pricing, ['whisperUsdPerMinute', 'ttsUsdPerMillionCharacters', 'verifiedAt'], 'speech.pricing');
    options.pricing = { whisperUsdPerMinute: usd(p.whisperUsdPerMinute), ttsUsdPerMillionCharacters: usd(p.ttsUsdPerMillionCharacters), verifiedAt: text(p.verifiedAt, 'speech.pricing.verifiedAt') };
  }
  if (s.voice !== undefined) { if (!['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(String(s.voice))) invalid('speech.voice'); options.voice = s.voice as OpenAiSpeechOptions['voice'] & string; }
  if (s.timeoutMs !== undefined) options.timeoutMs = integer(s.timeoutMs, 'speech.timeoutMs', 1, 25000);
  if (s.audioCacheBytes !== undefined) options.audioCacheBytes = integer(s.audioCacheBytes, 'speech.audioCacheBytes', 0, 64000000);
  return options;
}
/** No ambient AGENTSYS_STATE, model login or harness settings become product defaults. */
export function loadHostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const root = env.SPATIAL_HOST_ROOT ?? DEFAULT_HOST_ROOT;
  const path = env.SPATIAL_HOST_CONFIG;
  return parseHostConfig(path ? readPrivateJson(absolute(path, 'SPATIAL_HOST_CONFIG')) : {}, root);
}
