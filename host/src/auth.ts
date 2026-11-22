import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface PairedClient { id: string; label: string; createdAt: string; revokedAt: string | null }
interface ClientRecord extends PairedClient { tokenHash: string }
interface AuthState { version: 1; clients: ClientRecord[] }
const PERSISTENCE_ERROR = 'Pairing state durability failed. Authentication is disabled until host restart and storage recovery.';
export class AuthenticationError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'AuthenticationError'; } }

/** The code is visible only on the trusted setup surface, never in logs or remote health. */
export class PairingAuthority {
  private readonly statePath: string;
  private state: AuthState;
  private persistenceFailed = false;
  private pairing: { code: string; expiresAt: number } | null = null;
  private failedAttempts: number[] = [];
  private companion: { clientId: string; token: string } | null = null;

  constructor(directory: string, private readonly now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.statePath = join(directory, 'clients.json');
    if (existsSync(this.statePath)) {
      const value = JSON.parse(readFileSync(this.statePath, 'utf8')) as AuthState;
      if (value.version !== 1 || !Array.isArray(value.clients)) throw new Error('Unsupported pairing state. Preserve it and use the documented recovery path.');
      this.state = value;
    } else {
      this.state = { version: 1, clients: [] };
      this.save();
    }
  }

  setupCode(): { code: string; expiresAt: string } {
    this.assertAvailable();
    if (!this.pairing || this.pairing.expiresAt <= this.now()) {
      this.pairing = { code: randomBytes(8).toString('hex').toUpperCase(), expiresAt: this.now() + 10 * 60_000 };
    }
    return { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }

  pair(code: string, label: string): { clientId: string; token: string; protocolVersion: number } {
    this.assertAvailable();
    this.failedAttempts = this.failedAttempts.filter(t => t > this.now() - 60_000);
    if (this.failedAttempts.length >= 15) throw new AuthenticationError('pairing-rate-limited', 'Too many failed pairing attempts. Wait one minute or retry from the trusted setup screen.');
    const expected = this.pairing;
    const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!expected || expected.expiresAt <= this.now() || !equalText(normalized, expected.code)) {
      this.failedAttempts.push(this.now());
      throw new AuthenticationError('invalid-pairing-code', 'Use the current code shown on your host setup screen.');
    }
    if (typeof label !== 'string' || label.trim().length < 1 || label.length > 100) throw new AuthenticationError('invalid-client-label', 'Give this device a short name.');
    const client = this.issue(label.trim());
    this.pairing = null;
    this.failedAttempts = [];
    return { ...client, protocolVersion: 1 };
  }

  /** Only the loopback owner console may obtain this token; the HTTP layer enforces it. */
  companionSession(): { clientId: string; token: string } {
    if (!this.companion || !this.authenticate(`Bearer ${this.companion.token}`)) this.companion = this.issue('Owner companion');
    return this.companion;
  }

  authenticate(authorization: string | undefined): PairedClient | null {
    if (this.persistenceFailed || !authorization || !/^Bearer sw_[a-f0-9]{64}$/.test(authorization)) return null;
    const hash = digest(authorization.slice(7));
    const found = this.state.clients.find(client => !client.revokedAt && equalText(client.tokenHash, hash));
    return found ? { id: found.id, label: found.label, createdAt: found.createdAt, revokedAt: found.revokedAt } : null;
  }

  clients(): PairedClient[] {
    this.assertAvailable();
    return this.state.clients.map(({ id, label, createdAt, revokedAt }) => ({ id, label, createdAt, revokedAt }));
  }

  revoke(clientId: string): void {
    this.assertAvailable();
    const found = this.state.clients.find(client => client.id === clientId);
    if (!found) throw new AuthenticationError('unknown-client', 'This device is not paired.');
    const revokedAt = new Date(this.now()).toISOString();
    this.save({ version: 1, clients: this.state.clients.map(client => client.id === clientId ? { ...client, revokedAt } : client) });
  }

  /** Call before activating restored state: historical tokens cannot become trusted again. */
  revokeAll(): void {
    const revokedAt = new Date(this.now()).toISOString();
    this.save({ version: 1, clients: this.state.clients.map(client => ({ ...client, revokedAt: client.revokedAt ?? revokedAt })) });
    this.companion = null;
    this.pairing = null;
  }

  private issue(label: string): { clientId: string; token: string } {
    const token = `sw_${randomBytes(32).toString('hex')}`;
    const clientId = `client_${randomBytes(12).toString('hex')}`;
    const record: ClientRecord = { id: clientId, label, tokenHash: digest(token), createdAt: new Date(this.now()).toISOString(), revokedAt: null };
    this.save({ version: 1, clients: [...this.state.clients, record] });
    return { clientId, token };
  }

  private assertAvailable(): void {
    if (this.persistenceFailed) throw new Error(PERSISTENCE_ERROR);
  }

  private save(next: AuthState = this.state): void {
    this.assertAvailable();
    const temporary = `${this.statePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let ownsTemporary = false;
    try {
      const file = openSync(temporary, 'wx', 0o600);
      ownsTemporary = true;
      try { writeFileSync(file, JSON.stringify(next)); fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, this.statePath);
      ownsTemporary = false;
      const directory = openSync(dirname(this.statePath), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      // Publish/acknowledge only after both bytes and the replacement name are durable.
      this.state = next;
    } catch {
      // A rename may already have happened. Never continue trusting the old in-memory grants.
      this.persistenceFailed = true;
      this.pairing = null;
      this.companion = null;
      if (ownsTemporary) {
        try { rmSync(temporary, { force: true }); } catch { /* Retain an inaccessible private temp; never remove other files or the host lease. */ }
      }
      throw new Error(PERSISTENCE_ERROR);
    }
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function equalText(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface HostCertificate { key: Buffer; cert: Buffer; fingerprint: string }
/** App-owned certificate files only; no trust-store or machine-wide certificate changes. */
export function ensureHostCertificate(directory: string): HostCertificate {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'host-key.pem'), certPath = join(directory, 'host-cert.pem');
  if (existsSync(keyPath) !== existsSync(certPath)) throw new Error('Host TLS state is incomplete. Preserve both files and use the certificate recovery instructions.');
  if (!existsSync(keyPath)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '365', '-subj', '/CN=Spatial Agent Workspace', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore', timeout: 15_000 });
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath), cert = readFileSync(certPath);
  const certificate = new X509Certificate(cert);
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('The host certificate has expired. Rotate it through trusted setup and re-pair affected devices.');
  return { key, cert, fingerprint: createHash('sha256').update(certificate.raw).digest('hex') };
}

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Reject DNS rebinding and cross-origin access to privileged loopback setup. */
export function trustedConsoleRequest(remoteAddress: string | undefined, host: string | undefined, origin: string | undefined, port: number): boolean {
  if (!isLoopback(remoteAddress)) return false;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!host || !allowed.includes(host.toLowerCase())) return false;
  return origin === undefined || allowed.some(h => origin === `http://${h}`);
}
