import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingAuthority, ensureHostCertificate } from '../src/auth.js';
import { WorkspaceStore } from '../src/store.js';
import { createHostServer, HostApiError, type HostServices, type HostOwner } from '../src/server.js';

// Every server/auth/SQLite path is real. Execution adapters here are test fixtures,
// not evidence of working agents, provider transcription, Docker apps or live grants.
async function boot(execution = false) {
  const directory = mkdtempSync(join(tmpdir(), 'spatial-companion-e2e-'));
  const store = new WorkspaceStore(join(directory, 'workspace.sqlite'));
  const auth = new PairingAuthority(join(directory, 'pairing'));
  const certificate = ensureHostCertificate(join(directory, 'tls'));
  const owners: HostOwner[] = [];
  const services: HostServices = execution ? {
    // Trusted absence fixture only, not archive/coordinator acceptance evidence.
    lifecycle: { readiness: () => ({ id: 'archive-reader-fixture', state: 'ready', detail: 'Fixture: no coordinator cutoffs exist' }), assertDestinationAvailable() {}, archive: async () => { throw new Error('This ingress fixture has no archive writer'); } },
    execution: {
      readiness: async () => [{ id: 'fixture-runtime', state: 'ready', detail: 'Test fixture only; no actual agent proof' }],
      validateSettings: async () => { /* no model/provider calls */ },
      queue: async (submission, owner) => {
        owners.push(owner); store.updateSubmission(submission.id, { state: 'settled', detail: 'Test adapter completed' });
        store.updateMessage(submission.messageId, { state: 'complete' });
        store.appendMessage({ conversationId: submission.receiver.conversationId, requestId: submission.id, role: 'agent', text: '<script>window.injected=true</script> Fixture retained reply' });
        if (submission.receiver.taskId) store.updateTask(submission.receiver.taskId, { state: 'blocked', detail: 'No real environment configured in this fixture' });
      },
      interrupt: async () => ({ state: 'uncertain', detail: 'No cancellation acknowledgement in this fixture' }),
      decide: async (_request, _decision, owner) => { owners.push(owner); },
    },
  } : {};
  const host = createHostServer({ store, auth, certificate, services });
  const ports = await host.listen();
  return { directory, store, auth, owners, services, host, base: `http://127.0.0.1:${ports.consolePort}`, close: async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('owner setup and real project/space persistence show missing capabilities honestly without opening microphone', async ({ page }) => {
  const f = await boot();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(f.base);
    await expect(page.locator('#connection')).toContainText('Connected');
    await expect(page.locator('#receiver')).toContainText('Listening off');
    await page.getByRole('button', { name: 'Host setup', exact: true }).click();
    await expect(page.locator('#pin')).toHaveText(/^[a-f0-9]{64}$/);
    await expect(page.locator('#pair-code')).toHaveText(/^[A-F0-9]{16}$/);
    await expect(page.locator('#readiness')).toContainText('execution · missing');
    await expect(page.locator('#environments')).toContainText('Task environment is not configured');
    const client = f.auth.pair((await page.locator('#pair-code').textContent())!, 'Private test Quest');
    await page.getByRole('button', { name: 'Refresh pairing setup' }).click();
    await page.getByRole('button', { name: 'Revoke Private test Quest' }).click();
    await expect(page.locator('#clients')).toContainText('Revoked'); assertNoSecrets(await page.content(), client.token);
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByText('Add project', { exact: true }).click();
    await page.locator('#project-form input[name=name]').fill('Owner fixture project');
    await page.locator('#project-form textarea[name=purpose]').fill('Durable private test project');
    await page.locator('#project-form button').click();
    await page.locator('#spaces').getByRole('button', { name: 'Owner fixture project', exact: true }).click();
    await expect(page.locator('#context-name')).toHaveText('Owner fixture project');
    await page.getByText('Add child space', { exact: true }).click();
    await page.locator('#space-form input[name=name]').fill('Child fixture space');
    await page.locator('#space-form textarea[name=purpose]').fill('Test subtree');
    await page.locator('#space-form button').click();
    await page.locator('#spaces').getByRole('button', { name: 'Child fixture space', exact: true }).click();
    await expect(page.locator('#context-name')).toHaveText('Child fixture space');
    await page.locator('#turn-form textarea').fill('Try a turn without execution provider');
    await page.locator('#turn-form button').click();
    await expect(page.locator('#notice')).toContainText('Coordinator execution is not configured');
    expect(f.store.pendingSubmissions()).toHaveLength(0);
    await page.getByRole('button', { name: 'Parent Back' }).click();
    await expect(page.locator('#context-name')).toHaveText('Owner fixture project');
    await page.reload();
    await expect(page.locator('#spaces')).toContainText('Owner fixture project');
    expect(await page.evaluate(() => ({ microphones: performance.getEntriesByType('resource').filter(r => /speech|voice/.test(r.name)).length, injected: 'injected' in window }))).toEqual({ microphones: 0, injected: false });
    expect(errors).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

test('delayed first/older history never crosses receivers, rapid task navigation or reconnect generations', async ({ page }) => {
  const f = await boot(); const suffix = randomUUID();
  const pending: { release(): void; done: Promise<void>; url: string }[] = [];
  let delayHistory = false; let failPoll = false;
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const a = f.store.createProject({ name: 'History A ' + suffix, purpose: '' });
    const b = f.store.createProject({ name: 'History B ' + suffix, purpose: '' });
    const aConversation = f.store.getSpace(a.rootSpaceId).conversationId;
    const bConversation = f.store.getSpace(b.rootSpaceId).conversationId;
    const tasks = ['Task A ', 'Task B '].map(title => f.store.createTask({ spaceId: b.rootSpaceId, title: title + suffix, prompt: 'Private delayed-response fixture', idempotencyKey: randomUUID(), runtime: 'fixture', model: '', effort: '' }));
    for (const [conversationId, label] of [[aConversation, 'space-A'], [bConversation, 'space-B'], [tasks[0]!.conversationId, 'task-A'], [tasks[1]!.conversationId, 'task-B']]) {
      for (let i = 0; i < 260; i++) f.store.appendMessage({ conversationId: conversationId!, role: 'agent', text: label + '-' + suffix + '-' + String(i).padStart(3, '0') });
    }
    await page.route('**/v1/conversations/*/messages*', async route => {
      const response = await route.fetch();
      if (!delayHistory) { await route.fulfill({ response }); return; }
      let release!: () => void; let done!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const finished = new Promise<void>(resolve => { done = resolve; });
      pending.push({ release, done: finished, url: route.request().url() });
      await hold; await route.fulfill({ response }); done();
    });
    await page.route('**/v1/events?*', async route => { if (failPoll) { failPoll = false; await route.abort(); } else await route.continue(); });
    await page.goto(f.base); await expect(page.locator('#connection')).toContainText('Connected');
    await page.locator('#spaces').getByRole('button', { name: a.name, exact: true }).click();
    delayHistory = true; await page.locator('#older').click(); await expect.poll(() => pending.length).toBe(1);
    await page.locator('#spaces').getByRole('button', { name: b.name, exact: true }).click();
    pending[0]!.release(); await pending[0]!.done;
    await expect(page.locator('#messages')).not.toContainText('space-A-' + suffix);
    delayHistory = false; const bResponse = page.waitForResponse(r => r.url().includes('/' + bConversation + '/messages'));
    await page.locator('#older').click(); expect((await bResponse).status()).toBe(200);
    await expect(page.locator('#messages')).toContainText('space-B-' + suffix + '-110');
    // The stale A cursor must not become B's before= anchor; the real server rejects cross-conversation cursors.
    const bOlder = page.waitForResponse(r => r.url().includes('/' + bConversation + '/messages'));
    await page.locator('#older').click(); expect((await bOlder).status()).toBe(200);
    await expect(page.locator('#messages')).toContainText('space-B-' + suffix + '-010');
    await page.locator('#tasks .row').filter({ hasText: tasks[0]!.title }).getByRole('button', { name: 'Select task agent' }).click();
    delayHistory = true; await page.locator('#older').click(); await expect.poll(() => pending.length).toBe(2);
    await page.locator('#tasks .row').filter({ hasText: tasks[1]!.title }).getByRole('button', { name: 'Select task agent' }).click();
    await page.locator('#tasks .row').filter({ hasText: tasks[0]!.title }).getByRole('button', { name: 'Select task agent' }).click();
    pending[1]!.release(); await pending[1]!.done;
    await expect(page.locator('#messages')).not.toContainText('task-A-' + suffix + '-110');
    // Same receiver, newer history request: release out of order and preserve only the newest response.
    await page.locator('#older').click(); await expect.poll(() => pending.length).toBe(3);
    delayHistory = false; await page.locator('#older').click();
    await expect(page.locator('#messages')).toContainText('task-A-' + suffix + '-110');
    await page.locator('#older').click(); await expect(page.locator('#messages')).toContainText('task-A-' + suffix + '-010');
    pending[2]!.release(); await pending[2]!.done;
    await expect(page.locator('#messages .message')).toHaveCount(250);
    delayHistory = true; await page.locator('#older').click(); await expect.poll(() => pending.length).toBe(4);
    failPoll = true; f.store.appendMessage({ conversationId: aConversation, role: 'agent', text: 'poll-wake-' + suffix });
    await expect(page.locator('#connection')).toContainText('Disconnected');
    pending[3]!.release(); await pending[3]!.done;
    f.store.appendMessage({ conversationId: aConversation, role: 'agent', text: 'reconnect-wake-' + suffix });
    await expect(page.locator('#connection')).toContainText('Connected');
    await expect(page.locator('#messages')).not.toContainText('task-A-' + suffix + '-000');
    expect(errors).toEqual([]);
  } finally { for (const item of pending) item.release(); await page.close(); await f.close(); }
});

function assertNoSecrets(html: string, token: string) { expect(html).not.toContain(token); expect(html).not.toContain('Bearer sw_'); }

test('actual companion conversation/task/Inbox jump-return loop uses current versions and text-only untrusted content (test execution adapter)', async ({ page }) => {
  const f = await boot(true);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const project = f.store.createProject({ name: '<img src=x onerror="window.injected=true">', purpose: 'Untrusted fixture content, not owner business data' });
    const space = f.store.getSpace(project.rootSpaceId);
    const request = f.store.createInboxRequest({ spaceId: space.id, taskId: null, kind: 'question', title: 'Fixture question', detail: '<script>window.injected=true</script>', evidence: ['Untrusted evidence stays literal'] });
    await page.goto(f.base);
    await expect(page.locator('#connection')).toContainText('Connected');
    const initialReceiver = await page.locator('#receiver').textContent();
    await page.getByRole('button', { name: 'Inbox · All projects' }).click();
    await expect(page.locator('#requests')).toContainText('<script>window.injected=true</script>');
    await page.getByRole('button', { name: 'Jump to destination' }).click();
    await expect(page.locator('#context-name')).toHaveText(project.name);
    await page.getByText('Runtime settings', { exact: true }).click();
    await page.locator('#settings-form input[name=runtime]').fill('fixture-runtime');
    await page.locator('#settings-form button').click();
    await page.locator('#turn-form textarea').fill('Captured owner turn');
    await page.locator('#turn-form button').click();
    await expect(page.locator('#messages')).toContainText('Fixture retained reply');
    expect(f.store.getConversation(space.conversationId).messages[0]?.text).toBe('Captured owner turn');
    await page.getByText('Request a task', { exact: true }).click();
    await page.locator('#task-form input[name=title]').fill('Fixture task');
    await page.locator('#task-form textarea[name=prompt]').fill('A fixture-only task, no provider call');
    const priorReceiver = await page.locator('#receiver').textContent();
    await page.locator('#task-form button').click();
    await expect(page.locator('#tasks')).toContainText('No real environment configured');
    await expect(page.locator('#receiver')).toHaveText(priorReceiver!);
    await page.getByRole('button', { name: 'Select task agent' }).click();
    await expect(page.locator('#receiver')).toContainText('task ');
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Task environment is not configured');
    await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('uncertain');
    await page.getByRole('button', { name: 'Inbox Return', exact: true }).click();
    await expect(page.locator('#receiver')).toHaveText(initialReceiver!);
    await page.getByRole('button', { name: 'Inbox · All projects' }).click();
    const actionResponse = page.waitForResponse(r => r.url().includes('/v1/inbox/' + request.id + '/respond'));
    await page.getByLabel('Decision for Fixture question').fill('Owner answer, not a grant');
    await page.getByRole('button', { name: 'answer', exact: true }).click();
    expect((await actionResponse).status()).toBe(200);
    await expect(page.locator('#requests')).toContainText('No open requests');
    expect(f.store.getInboxRequest(request.id).state).toBe('answered');
    expect(f.owners.every(owner => owner.surface === 'console' && !('token' in owner))).toBe(true);
    expect(await page.evaluate(() => 'injected' in window)).toBe(false);
    expect(await page.locator('img[src="x"],script:not([src])').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

test('unchanged failed turn retries retain one durable idempotency identity after lost acknowledgement (adapter fixture)', async ({ page }) => {
  const f = await boot(true);
  try {
    const actualQueue = f.services.execution!.queue;
    f.services.execution!.queue = async (submission, owner) => { await actualQueue(submission, owner); throw new HostApiError(504, 'fixture-lost-ack', 'Test acknowledgement was lost after recording.', 'Refresh retained history; retry only with the same identity.'); };
    const sent: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/v1/turns')) sent.push((request.postDataJSON() as { idempotencyKey: string }).idempotencyKey); });
    await page.goto(f.base);
    await expect(page.locator('#connection')).toContainText('Connected');
    await page.locator('#turn-form textarea').fill('Retain the same request identity');
    await page.locator('#turn-form button').click();
    await expect(page.locator('#notice')).toContainText('acknowledgement was lost');
    await expect(page.locator('#messages')).toContainText('Fixture retained reply');
    await page.locator('#turn-form button').click();
    await expect(page.locator('#notice')).toContainText('settled');
    expect(sent).toHaveLength(2); expect(sent[0]).toBe(sent[1]);
    expect(f.owners).toHaveLength(1);
    expect(f.store.getConversation('conversation-overview').messages.filter(m => m.role === 'owner')).toHaveLength(1);
  } finally { await page.close(); await f.close(); }
});

test('stale Inbox action refuses coordinator effects and reconnects to changed evidence', async ({ page }) => {
  const f = await boot(true);
  try {
    const item = f.store.createInboxRequest({ spaceId: 'overview', taskId: null, kind: 'approval', title: 'Current evidence required', detail: 'First evidence', evidence: [] });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    // Delay polling transport, not route bodies: the real HTTP server still handles every call.
    await page.route('**/v1/events?*', async route => { await hold; await route.continue(); });
    await page.goto(f.base);
    await page.getByRole('button', { name: 'Inbox · All projects' }).click();
    await expect(page.locator('#requests')).toContainText('version 1');
    const other = new WorkspaceStore(join(f.directory, 'workspace.sqlite'));
    other.updateInboxRequest(item.id, 1, { detail: 'Changed evidence; owner must inspect again' }); other.close();
    const rejected = page.waitForResponse(r => r.url().endsWith('/v1/inbox/' + item.id + '/respond'));
    await page.getByRole('button', { name: 'Confirm existing authority', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(page.locator('#notice')).toContainText('changed');
    expect(f.owners).toHaveLength(0);
    expect(f.store.getInboxRequest(item.id).state).toBe('open');
    release();
    await expect(page.locator('#requests')).toContainText('version 2');
    await expect(page.locator('#requests')).toContainText('Changed evidence');
  } finally { await page.close(); await f.close(); }
});

test('deferred requests jump deliberately and dismissed requests retain read-only evidence (fixture owner service)', async ({ page }) => {
  const f = await boot(true);
  try {
    const project = f.store.createProject({ name: 'Deferred destination fixture', purpose: '' });
    const item = f.store.createInboxRequest({ spaceId: project.rootSpaceId, taskId: null, kind: 'review', title: 'Obsolete attempt fixture', detail: 'A newer attempt superseded this review; retain the old pin.', evidence: [JSON.stringify({ source: 'coordinator-interactive', runId: 'old-run-ID', disposition: { state: 'obsolete', reason: 'A newer attempt superseded this review' } }), 'exact retained owner evidence'] });
    f.store.respondInbox(item.id, item.version, 'defer', 'owner will inspect later');
    await page.goto(f.base); await expect(page.locator('#connection')).toContainText('Connected');
    await page.getByRole('button', { name: 'Inbox · All projects' }).click();
    await expect(page.locator('#requests')).toContainText('deferred · version 2');
    await expect(page.getByRole('button', { name: 'review', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'defer', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Jump to destination' }).click();
    await expect(page.locator('#context-name')).toHaveText(project.name);
    await page.getByRole('button', { name: 'Inbox · All projects' }).click();
    await page.getByLabel('Decision for Obsolete attempt fixture').fill('Withdraw the superseded review, not its attempt');
    await page.getByRole('button', { name: 'Dismiss / obsolete', exact: true }).click();
    await expect(page.locator('#requests')).toContainText('dismissed');
    await expect(page.locator('#requests')).toContainText('old-run-ID');
    await expect(page.locator('#requests')).toContainText('Retained read-only');
    await expect(page.getByRole('button', { name: 'Jump to destination' })).toHaveCount(0);
    expect(f.store.listInboxVersions(item.id)[0]!.evidence).toEqual(item.evidence);
    expect(f.store.listInboxDecisions(item.id).at(-1)!.action).toBe('dismiss');
  } finally { await page.close(); await f.close(); }
});

test('registered sources stay literal and scope follows navigation; safe archive requires deliberate confirmation and retains export', async ({ page }) => {
  const f = await boot();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const project = f.store.createProject({ name: 'Source journey fixture', purpose: '' });
    const other = f.store.createProject({ name: 'Different project fixture', purpose: '' });
    await page.goto(f.base); await expect(page.locator('#connection')).toContainText('Connected');
    await page.locator('#spaces').getByRole('button', { name: project.name, exact: true }).click();
    await page.getByText('Registered context sources', { exact: true }).click();
    await page.locator('#source-form input[name=name]').fill('Literal source');
    await page.locator('#source-form input[name=provenance]').fill('Explicit private owner fixture');
    await page.locator('#source-form textarea[name=text]').fill('<script>window.injected=true</script> Owner data, not a command.');
    await page.locator('#source-form button').click();
    await expect(page.locator('#sources')).toContainText('Literal source');
    await page.getByRole('button', { name: 'Read Literal source', exact: true }).click();
    await expect(page.locator('#sources pre')).toContainText('<script>window.injected=true</script>');
    expect(await page.evaluate(() => 'injected' in window)).toBe(false);
    await page.locator('#spaces').getByRole('button', { name: other.name, exact: true }).click();
    await expect(page.locator('#sources')).toBeEmpty();
    await page.getByRole('button', { name: 'Refresh sources', exact: true }).click();
    await expect(page.locator('#sources')).toContainText('No registered text sources');
    await page.locator('#spaces').getByRole('button', { name: project.name, exact: true }).click();
    await page.getByText('Archive current context', { exact: true }).click();
    await page.getByRole('button', { name: 'Archive context', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Explicitly confirm archive first');
    expect(f.store.snapshot().projects.some(p => p.id === project.id)).toBe(true);
    await page.locator('#confirm-archive').check();
    await page.getByRole('button', { name: 'Archive context', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('History stays retained');
    expect(f.store.snapshot().projects.some(p => p.id === project.id)).toBe(false);
    expect(f.store.exportHistory().sources[0]?.text).toContain('<script>');
    await expect(page.locator('#context-name')).toHaveText('Archived context');
    await expect(page.locator('#receiver')).toContainText('No available receiver');
    await expect(page.locator('#turn-form button')).toBeDisabled();
    await expect(page.locator('#sources')).toBeEmpty();
    // A fresh real poll must retain both the acknowledgement and the recovery route.
    f.store.appendMessage({ conversationId: 'conversation-overview', role: 'agent', text: 'Archive poll fixture' });
    await expect(page.locator('#connection')).toHaveText('Connected · observed revision ' + f.store.revision);
    await expect(page.locator('#notice')).toContainText('History stays retained');
    await expect(page.locator('#notice')).toContainText('Choose Overview');
    const download = page.waitForEvent('download');
    await page.locator('#export-history').click();
    const exported = JSON.parse(readFileSync((await (await download).path())!, 'utf8')) as { sources: { text: string }[] };
    expect(exported.sources[0]?.text).toContain('<script>');
    // Recovery is deliberate; archive closes input instead of silently changing the receiver.
    await page.locator('#spaces').getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.locator('#context-name')).toHaveText('Overview');
    await expect(page.locator('#receiver')).toContainText('conversation-overview');
    await expect(page.locator('#turn-form button')).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

for (const kind of ['space', 'task'] as const) {
  test('explicit ' + kind + ' archive closes the receiver across polls and retains readable history (SQL fixture)', async ({ page }) => {
    const f = await boot(true); const suffix = randomUUID();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    // Only a stopped SQL fixture: no coordinator, applications, authority or real execution.
    f.services.lifecycle!.archive = async (_receivers, _owner, commit) => commit();
    try {
      const project = f.store.createProject({ name: 'Archive parent fixture ' + suffix, purpose: '' });
      const child = f.store.createSpace({ projectId: project.id, parentId: project.rootSpaceId, name: 'Archive child fixture ' + suffix, purpose: '' });
      const task = kind === 'task' ? f.store.createTask({ spaceId: child.id, title: 'Stopped archive fixture ' + suffix, prompt: 'SQL fixture only', runtime: 'fixture', model: '', effort: '', idempotencyKey: randomUUID() }) : null;
      if (task) {
        f.store.updateTask(task.id, { state: 'stopped', detail: 'Fixture has no workload' });
        const submission = f.store.pendingSubmissions().find(s => s.receiver.taskId === task.id)!;
        f.store.updateSubmission(submission.id, { state: 'settled' }); f.store.updateMessage(submission.messageId, { state: 'complete' });
      }
      const conversationId = task?.conversationId ?? child.conversationId;
      const retained = 'Archive history fixture ' + suffix;
      for (let i = 0; i < 70; i++) f.store.appendMessage({ conversationId, role: 'agent', text: retained + '-' + i });
      await page.goto(f.base); await expect(page.locator('#connection')).toContainText('Connected');
      await page.locator('#spaces').getByRole('button', { name: project.name, exact: true }).click();
      await page.locator('#spaces').getByRole('button', { name: child.name, exact: true }).click();
      if (task) await page.getByRole('button', { name: 'Select task agent', exact: true }).click();
      await page.locator('#older').click(); await expect(page.locator('#messages')).toContainText(retained + '-0');
      await page.getByText('Archive current context', { exact: true }).click();
      await page.locator('#confirm-archive').check(); await page.locator('#archive-context').click();
      await expect(page.locator('#notice')).toContainText('History stays retained');
      await expect(page.locator('#context-name')).toHaveText('Archived context');
      await expect(page.locator('#receiver')).toContainText('No available receiver');
      await expect(page.locator('#messages')).toBeEmpty(); await expect(page.locator('#tools')).toBeHidden();
      await expect(page.locator('#turn-form textarea')).toBeDisabled(); await expect(page.locator('#task-form button')).toBeDisabled();
      await expect(page.locator('#older')).toBeDisabled(); await expect(page.locator('#archive-context')).toBeDisabled();
      for (let i = 0; i < 2; i++) {
        f.store.appendMessage({ conversationId: 'conversation-overview', role: 'agent', text: 'Poll fixture ' + suffix + '-' + i });
        await expect(page.locator('#connection')).toHaveText('Connected · observed revision ' + f.store.revision);
        await expect(page.locator('#notice')).toContainText('History stays retained');
        await expect(page.locator('#notice')).toContainText('Choose Overview');
        await expect(page.locator('#receiver')).toContainText('No available receiver');
      }
      const history = await page.request.get(f.base + '/v1/conversations/' + conversationId + '/messages');
      expect(history.status()).toBe(200); expect(await history.text()).toContain(retained);
      const download = page.waitForEvent('download'); await page.locator('#export-history').click();
      const exported = JSON.parse(readFileSync((await (await download).path())!, 'utf8')) as { messages: { conversationId: string; text: string }[] };
      expect(exported.messages.filter(m => m.conversationId === conversationId && m.text.startsWith(retained))).toHaveLength(70);
      expect(exported.messages.some(m => m.text === retained + '-0')).toBe(true);
      await page.getByRole('button', { name: task ? 'Space conversation' : 'Parent Back', exact: true }).click();
      await expect(page.locator('#receiver')).toContainText(task ? child.conversationId : f.store.getSpace(project.rootSpaceId).conversationId);
      await expect(page.locator('#turn-form button')).toBeEnabled(); await expect(page.locator('#messages')).not.toContainText(retained);
      await expect(page.locator('#notice')).toBeEmpty();
      expect(errors).toEqual([]);
    } finally { await page.close(); await f.close(); }
  });
}

for (const revisit of [false, true]) {
  test('late archive acknowledgement cannot reset ' + (revisit ? 'a newly revisited original' : 'an unrelated') + ' receiver or loaded history', async ({ page }) => {
    const f = await boot(); const suffix = randomUUID();
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let responseHeld = false;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      // In the revisit case, retain the pre-archive snapshot long enough to navigate A -> B -> A.
      if (revisit) await page.route('**/v1/events?*', async route => { await hold; await route.continue(); });
      const a = f.store.createProject({ name: 'Delayed archive fixture ' + suffix, purpose: '' });
      const b = f.store.createProject({ name: 'Unrelated history fixture ' + suffix, purpose: '' });
      const bConversation = f.store.getSpace(b.rootSpaceId).conversationId;
      for (let i = 0; i < 70; i++) f.store.appendMessage({ conversationId: bConversation, role: 'agent', text: 'Unrelated fixture ' + suffix + '-' + i });
      // Hold the real HTTP/SQL response after commit, not a fabricated archive body.
      await page.route('**/v1/archive/project/*', async route => { const response = await route.fetch(); responseHeld = true; await hold; await route.fulfill({ response }); });
      await page.goto(f.base); await expect(page.locator('#connection')).toContainText('Connected');
      await page.locator('#spaces').getByRole('button', { name: a.name, exact: true }).click();
      await page.getByText('Archive current context', { exact: true }).click();
      await page.locator('#confirm-archive').check(); await page.locator('#archive-context').click();
      await expect.poll(() => responseHeld).toBe(true);
      await page.locator('#spaces').getByRole('button', { name: b.name, exact: true }).click();
      if (revisit) {
        await page.locator('#spaces').getByRole('button', { name: a.name, exact: true }).click();
      } else {
        await page.locator('#older').click(); await expect(page.locator('#messages')).toContainText('Unrelated fixture ' + suffix + '-0');
        await page.locator('#confirm-archive').check();
      }
      const refreshed = page.waitForResponse(r => r.url().endsWith('/v1/snapshot')); release(); await refreshed;
      await expect(page.locator('#connection')).toHaveText('Connected · observed revision ' + f.store.revision);
      if (revisit) {
        // The archive belongs to the previous A selection, not this new generation of A.
        await expect(page.locator('#context-name')).toHaveText('Unavailable context');
        await expect(page.locator('#notice')).toContainText('Current destination is unavailable');
        await expect(page.locator('#receiver')).toContainText('No available receiver');
        await expect(page.locator('#turn-form button')).toBeDisabled();
        await page.locator('#spaces').getByRole('button', { name: 'Overview', exact: true }).click();
        await expect(page.locator('#receiver')).toContainText('conversation-overview');
      } else {
        await expect(page.locator('#receiver')).toContainText(bConversation);
        await expect(page.locator('#messages')).toContainText('Unrelated fixture ' + suffix + '-0');
        await expect(page.locator('#confirm-archive')).toBeChecked();
      }
      await expect(page.locator('#notice')).not.toContainText('Context archived');
      expect(f.store.listArchives().some(record => record.entityId === a.id)).toBe(true);
      expect(f.store.snapshot().projects.some(p => p.id === b.id)).toBe(true);
      expect(errors).toEqual([]);
    } finally { release(); await page.close(); await f.close(); }
  });
}

for (const kind of ['project', 'task'] as const) {
  test('externally archived ' + kind + ' shows real missing-destination recovery without an owner acknowledgement', async ({ page }) => {
    const f = await boot(); const suffix = randomUUID();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      const project = f.store.createProject({ name: 'External archive fixture ' + suffix, purpose: '' });
      const task = kind === 'task' ? f.store.createTask({ spaceId: project.rootSpaceId, title: 'External stopped task ' + suffix, prompt: 'SQL fixture only', runtime: 'fixture', model: '', effort: '', idempotencyKey: randomUUID() }) : null;
      if (task) {
        f.store.updateTask(task.id, { state: 'stopped', detail: 'Fixture has no workload' });
        const submission = f.store.pendingSubmissions().find(s => s.receiver.taskId === task.id)!;
        f.store.updateSubmission(submission.id, { state: 'settled' }); f.store.updateMessage(submission.messageId, { state: 'complete' });
      }
      const conversationId = task?.conversationId ?? f.store.getSpace(project.rootSpaceId).conversationId;
      f.store.appendMessage({ conversationId, role: 'agent', text: 'External history fixture ' + suffix });
      await page.goto(f.base); await expect(page.locator('#connection')).toContainText('Connected');
      await page.locator('#spaces').getByRole('button', { name: project.name, exact: true }).click();
      if (task) await page.getByRole('button', { name: 'Select task agent', exact: true }).click();
      if (task) f.store.archiveTask(task.id); else f.store.archiveProject(project.id);
      await expect(page.locator('#context-name')).toHaveText('Unavailable context');
      await expect(page.locator('#notice')).toContainText('Current destination is unavailable');
      await expect(page.locator('#notice')).not.toContainText('Context archived');
      await expect(page.locator('#receiver')).toContainText('No available receiver');
      await expect(page.locator('#messages')).toBeEmpty(); await expect(page.locator('#tools')).toBeHidden();
      await expect(page.locator('#turn-form button')).toBeDisabled();
      f.store.appendMessage({ conversationId: 'conversation-overview', role: 'agent', text: 'External poll fixture ' + suffix });
      await expect(page.locator('#connection')).toHaveText('Connected · observed revision ' + f.store.revision);
      await expect(page.locator('#notice')).toContainText('Choose Overview');
      const retained = await page.request.get(f.base + '/v1/conversations/' + conversationId + '/messages');
      expect(retained.status()).toBe(200); expect(await retained.text()).toContain('External history fixture ' + suffix);
      await page.locator('#spaces').getByRole('button', { name: 'Overview', exact: true }).click();
      await expect(page.locator('#receiver')).toContainText('conversation-overview'); await expect(page.locator('#turn-form button')).toBeEnabled();
      await expect(page.locator('#notice')).toBeEmpty(); expect(errors).toEqual([]);
    } finally { await page.close(); await f.close(); }
  });
}

