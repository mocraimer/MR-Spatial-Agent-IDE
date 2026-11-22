import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingAuthority, AuthenticationError, ensureHostCertificate, trustedConsoleRequest } from '../src/auth.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'spatial-auth-')); });
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); });

describe('owner device pairing', () => {
  it('requires the trusted setup code and consumes it exactly once', () => {
    const authority = new PairingAuthority(directory);
    assert.throws(() => authority.pair('not-a-code', 'Quest'), AuthenticationError);
    const code = authority.setupCode().code;
    const paired = authority.pair(code, 'Quest');
    assert.equal(authority.authenticate(`Bearer ${paired.token}`)?.id, paired.clientId);
    assert.throws(() => authority.pair(code, 'second device'), AuthenticationError);
    assert.equal(authority.authenticate('Bearer forged'), null);
    assert.equal(authority.authenticate(undefined), null);
  });

  it('retains valid pairing across host restart without storing raw tokens', () => {
    const authority = new PairingAuthority(directory);
    const code = authority.setupCode().code;
    const paired = authority.pair(code, 'Quest');
    const persisted = readFileSync(join(directory, 'clients.json'), 'utf8');
    assert.equal(persisted.includes(paired.token), false);
    assert.equal(persisted.includes(code), false);
    const reopened = new PairingAuthority(directory);
    assert.equal(reopened.authenticate(`Bearer ${paired.token}`)?.label, 'Quest');
    assert.equal(JSON.stringify(reopened.clients()).includes('tokenHash'), false);
  });

  it('expires codes and limits repeated failures', () => {
    let clock = 10_000;
    const authority = new PairingAuthority(directory, () => clock);
    const expired = authority.setupCode().code;
    clock += 10 * 60_000 + 1;
    assert.throws(() => authority.pair(expired, 'Quest'), AuthenticationError);
    for (let i = 0; i < 14; i++) assert.throws(() => authority.pair('bad', 'Quest'), AuthenticationError);
    assert.throws(() => authority.pair(authority.setupCode().code, 'Quest'), (err: unknown) => err instanceof AuthenticationError && err.code === 'pairing-rate-limited');
    clock += 60_001;
    assert.ok(authority.pair(authority.setupCode().code, 'Quest').clientId);
  });

  it('persists revocation and invalidates restored historical clients', () => {
    const authority = new PairingAuthority(directory);
    const first = authority.pair(authority.setupCode().code, 'Quest');
    const second = authority.pair(authority.setupCode().code, 'Companion device');
    authority.revoke(first.clientId);
    assert.equal(authority.authenticate(`Bearer ${first.token}`), null);
    assert.ok(authority.authenticate(`Bearer ${second.token}`));
    const restarted = new PairingAuthority(directory);
    assert.equal(restarted.authenticate(`Bearer ${first.token}`), null);
    assert.ok(restarted.authenticate(`Bearer ${second.token}`));
    restarted.revokeAll();
    const restored = new PairingAuthority(directory);
    assert.equal(restored.authenticate(`Bearer ${first.token}`), null);
    assert.equal(restored.authenticate(`Bearer ${second.token}`), null);
  });

  it('exposes neither hashed nor plaintext credentials in device listings', () => {
    const authority = new PairingAuthority(directory);
    const session = authority.companionSession();
    assert.deepEqual(authority.companionSession(), session);
    const view = JSON.stringify(authority.clients());
    assert.equal(view.includes(session.token), false);
    assert.equal(view.includes('tokenHash'), false);
    authority.revoke(session.clientId);
    assert.notEqual(authority.companionSession().token, session.token);
  });
});

describe('durable private pairing state', () => {
  it('syncs a private temp fd before rename and the parent directory before accepting revocation', () => {
    const authority = new PairingAuthority(directory);
    const paired = authority.pair(authority.setupCode().code, 'Quest');
    const events: string[] = [];
    const actual = { open: fs.openSync, write: fs.writeFileSync, sync: fs.fsyncSync, close: fs.closeSync, rename: fs.renameSync };
    mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const parent = args[0] === directory;
      if (!parent) { assert.equal(args[1], 'wx'); assert.equal(args[2], 0o600); }
      events.push(parent ? 'open-directory' : 'open-temp');
      return actual.open(...args);
    });
    mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      assert.equal(typeof args[0], 'number');
      assert.equal(fstatSync(args[0] as number).mode & 0o777, 0o600);
      events.push('write'); return actual.write(...args);
    });
    mock.method(fs, 'fsyncSync', (fd: number) => {
      const parent = fstatSync(fd).isDirectory();
      events.push(parent ? 'sync-directory' : 'sync-file');
      if (parent) assert.ok(JSON.parse(readFileSync(join(directory, 'clients.json'), 'utf8')).clients[0].revokedAt);
      return actual.sync(fd);
    });
    mock.method(fs, 'closeSync', (fd: number) => {
      events.push(fstatSync(fd).isDirectory() ? 'close-directory' : 'close-file'); return actual.close(fd);
    });
    mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      events.push('rename'); return actual.rename(...args);
    });
    syncBuiltinESMExports();
    authority.revoke(paired.clientId); events.push('ack');
    assert.deepEqual(events, ['open-temp', 'write', 'sync-file', 'close-file', 'rename', 'open-directory', 'sync-directory', 'close-directory', 'ack']);
    assert.equal(authority.authenticate(`Bearer ${paired.token}`), null);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, 'clients.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(directory), ['clients.json']);
  });

  for (const stage of ['file', 'directory'] as const) {
    it(`refuses revocation acknowledgement and all authentication after ${stage} sync failure`, () => {
      const authority = new PairingAuthority(directory);
      const first = authority.pair(authority.setupCode().code, 'Quest');
      const second = authority.pair(authority.setupCode().code, 'Other device');
      const companion = authority.companionSession();
      const code = authority.setupCode().code;
      const previous = readFileSync(join(directory, 'clients.json'), 'utf8');
      const lease = join(directory, 'host.lock');
      writeFileSync(lease, 'disposable stable lease fixture', { mode: 0o600 });
      const leaseFd = openSync(lease, 'r');
      const inode = fstatSync(leaseFd).ino;
      const actualSync = fs.fsyncSync, actualClose = fs.closeSync, actualRename = fs.renameSync;
      const closed: number[] = [];
      let failedFd = -1, renames = 0;
      mock.method(fs, 'fsyncSync', (fd: number) => {
        if (fstatSync(fd).isDirectory() === (stage === 'directory')) {
          failedFd = fd;
          throw new Error(`injected ${stage} sync failure containing a private token ${first.token}`);
        }
        return actualSync(fd);
      });
      mock.method(fs, 'closeSync', (fd: number) => { closed.push(fd); return actualClose(fd); });
      mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => { renames++; return actualRename(...args); });
      syncBuiltinESMExports();
      try {
        assert.throws(() => authority.revoke(first.clientId), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /durability failed/);
          assert.equal(error.message.includes(first.token), false);
          assert.equal(error.message.includes(directory), false);
          return true;
        });
        assert.ok(closed.includes(failedFd));
        assert.throws(() => fstatSync(failedFd), { code: 'EBADF' });
        assert.equal(renames, stage === 'file' ? 0 : 1);
        const persisted = readFileSync(join(directory, 'clients.json'), 'utf8');
        if (stage === 'file') assert.equal(persisted, previous);
        else assert.ok(JSON.parse(persisted).clients.find((client: { id: string }) => client.id === first.clientId).revokedAt);
        for (const paired of [first, second, companion]) assert.equal(authority.authenticate(`Bearer ${paired.token}`), null);
        for (const operation of [() => authority.revoke(first.clientId), () => authority.revokeAll(), () => authority.pair(code, 'Another Quest'), () => authority.setupCode(), () => authority.companionSession(), () => authority.clients()]) {
          assert.throws(operation, /durability failed/);
        }
        assert.deepEqual(readdirSync(directory).sort(), ['clients.json', 'host.lock']);
        assert.equal(statSync(lease).ino, inode);
        assert.equal(fstatSync(leaseFd).ino, inode);
        assert.equal(readFileSync(lease, 'utf8'), 'disposable stable lease fixture');
      } finally { closeSync(leaseFd); }
    });

    it(`does not issue a pairing token when ${stage} sync fails`, () => {
      const authority = new PairingAuthority(directory);
      const code = authority.setupCode().code;
      const actualSync = fs.fsyncSync;
      mock.method(fs, 'fsyncSync', (fd: number) => {
        if (fstatSync(fd).isDirectory() === (stage === 'directory')) throw new Error('injected sync failure');
        return actualSync(fd);
      });
      syncBuiltinESMExports();
      assert.throws(() => authority.pair(code, 'Quest'), /durability failed/);
      assert.throws(() => authority.pair(code, 'Second Quest'), /durability failed/);
      assert.deepEqual(readdirSync(directory), ['clients.json']);
      assert.equal(JSON.parse(readFileSync(join(directory, 'clients.json'), 'utf8')).clients.length, stage === 'file' ? 0 : 1);
    });

    it(`fails closed for revoke-all when ${stage} sync fails`, () => {
      const authority = new PairingAuthority(directory);
      const paired = authority.pair(authority.setupCode().code, 'Quest');
      const companion = authority.companionSession();
      const actualSync = fs.fsyncSync;
      mock.method(fs, 'fsyncSync', (fd: number) => {
        if (fstatSync(fd).isDirectory() === (stage === 'directory')) throw new Error('injected sync failure');
        return actualSync(fd);
      });
      syncBuiltinESMExports();
      assert.throws(() => authority.revokeAll(), /durability failed/);
      assert.equal(authority.authenticate(`Bearer ${paired.token}`), null);
      assert.equal(authority.authenticate(`Bearer ${companion.token}`), null);
      assert.throws(() => authority.companionSession(), /durability failed/);
      assert.deepEqual(readdirSync(directory), ['clients.json']);
    });
  }
});

describe('private transport setup', () => {
  it('reuses its app-owned TLS certificate and pin across restart', () => {
    const first = ensureHostCertificate(directory);
    const second = ensureHostCertificate(directory);
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.deepEqual(first.cert, second.cert);
    assert.deepEqual(first.key, second.key);
  });

  it('refuses external, rebound and cross-origin owner-console requests', () => {
    assert.equal(trustedConsoleRequest('127.0.0.1', '127.0.0.1:7330', undefined, 7330), true);
    assert.equal(trustedConsoleRequest('::1', '[::1]:7330', 'http://[::1]:7330', 7330), true);
    assert.equal(trustedConsoleRequest('192.168.1.12', '127.0.0.1:7330', undefined, 7330), false);
    assert.equal(trustedConsoleRequest('127.0.0.1', 'attacker.example:7330', undefined, 7330), false);
    assert.equal(trustedConsoleRequest('127.0.0.1', '127.0.0.1:7330', 'https://attacker.example', 7330), false);
    assert.equal(trustedConsoleRequest('127.0.0.1', '127.0.0.1:7443', undefined, 7330), false);
  });
});
