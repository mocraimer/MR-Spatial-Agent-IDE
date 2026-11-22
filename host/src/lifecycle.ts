import { createHash } from 'node:crypto';
import type { Actor, CoordinatorCommands } from './runtime-coordinator.js';
import type { EnvironmentBroker } from './environment-broker.js';
import type { Receiver } from './protocol.js';
import type { HostOwner, HostServices } from './server.js';
import { StoreError, type ArchiveRecord, type ArchiveReference, WorkspaceStore } from './store.js';

export type ArchiveProduct = ArchiveReference['product'];
// Derive the seam from the prepared, source-verified public coordinator declarations.
export type ArchiveInput = Parameters<CoordinatorCommands['interactiveArchive']>[1];
export type ArchiveReceipt = ReturnType<CoordinatorCommands['interactiveArchive']>;
type Commit = Parameters<CoordinatorCommands['interactiveArchive']>[2];
export type ArchiveCommands = Pick<CoordinatorCommands, 'interactiveLookup' | 'interactiveArchive' | 'interactiveArchiveLookup' | 'interactiveArchiveReconcile'>;
export function hasArchiveCommands(commands: CoordinatorCommands): boolean {
  return typeof commands.interactiveArchive === 'function' && typeof commands.interactiveArchiveLookup === 'function' && typeof commands.interactiveArchiveReconcile === 'function';
}
export function productArchiveId(product: ArchiveProduct): string {
  return 'spatial-archive-' + createHash('sha256').update(JSON.stringify([product.kind, product.id])).digest('hex');
}
function conflict(detail: string): never { throw new StoreError('conflict', detail); }
const receiverKey = (receiver: Receiver): string => JSON.stringify([receiver.spaceId, receiver.conversationId, receiver.taskId]);
const receiverKeys = (receivers: readonly Receiver[]): string => JSON.stringify(receivers.map(receiverKey).sort());
const inputKey = (input: ArchiveInput): string => JSON.stringify([input.archiveId, input.product.kind, input.product.id,
  receiverKeys(input.receivers), [...input.taskIds].sort(), [...input.runIds].sort()]);

/** Full retained scope, including already archived delegated children in sibling spaces. */
export function archiveReceivers(store: WorkspaceStore, product: ArchiveProduct): Receiver[] {
  const history = store.exportHistory(), spaces = new Set<string>(), tasks = new Set<string>();
  if (product.kind === 'project') { store.getProject(product.id); history.spaces.filter(space => space.projectId === product.id).forEach(space => spaces.add(space.id)); }
  if (product.kind === 'space') {
    const space = store.getSpace(product.id);
    if (space.id === 'overview') throw new StoreError('invalid', 'Overview cannot be archived');
    if (space.projectId && store.getProject(space.projectId).rootSpaceId === space.id) throw new StoreError('invalid', 'Archive the project instead of its root space');
    spaces.add(product.id);
    for (let changed = true; changed;) { changed = false; for (const space of history.spaces) if (space.parentId && spaces.has(space.parentId) && !spaces.has(space.id)) { spaces.add(space.id); changed = true; } }
  }
  if (product.kind === 'task') { store.getTask(product.id); tasks.add(product.id); }
  history.tasks.filter(task => spaces.has(task.spaceId)).forEach(task => tasks.add(task.id));
  for (let changed = true; changed;) { changed = false; for (const task of history.tasks) if (task.parentTaskId && tasks.has(task.parentTaskId) && !tasks.has(task.id)) { tasks.add(task.id); changed = true; } }
  return [...history.spaces.filter(space => spaces.has(space.id)).map(space => ({ spaceId: space.id, conversationId: space.conversationId, taskId: null })),
    ...history.tasks.filter(task => tasks.has(task.id)).map(task => ({ spaceId: task.spaceId, conversationId: task.conversationId, taskId: task.id }))];
}
export interface LifecycleOptions {
  store: WorkspaceStore;
  broker: Pick<EnvironmentBroker, 'snapshots' | 'withInactive'>;
  commands: ArchiveCommands;
  authenticateOwner(owner: HostOwner): Actor;
  /** Fresh existing reviewed activation; this service never creates one. */
  activated(): boolean;
  /** Existing registered operator for read-only ingress checks, never supplied by a browser. */
  actor(): Actor;
}
/** One ingress rule for HTTP and owner broker; missing verification closes only retained families. */
export function assertArchiveDestinationAvailable(store: WorkspaceStore, receiver: Receiver, reader?: Pick<NonNullable<HostServices['lifecycle']>, 'assertDestinationAvailable'>): void {
  store.assertDestinationAvailable(receiver.spaceId, receiver.taskId);
  if (reader) { reader.assertDestinationAvailable(receiver); return; }
  assertUnavailableReaderScope(store, receiver);
}
function assertUnavailableReaderScope(store: WorkspaceStore, receiver: Receiver): void {
  const history = store.exportHistory();
  const retained = [...history.tasks.map(task => ({ spaceId: task.spaceId, conversationId: task.conversationId, taskId: task.id })),
    ...history.submissions.map(submission => submission.receiver)];
  if (store.receiversAffectDestination(retained, receiver.spaceId, receiver.taskId)) {
    conflict('Current coordinator archive cutoff reader is unavailable for this retained history family; no new effects are allowed.');
  }
}
export function createArchiveLifecycle(options: LifecycleOptions): NonNullable<HostServices['lifecycle']> {
  const { store, broker, commands } = options;
  const requireActivation = () => { if (!options.activated()) conflict('Archive coordinator activation cannot be proved current; no new effects are allowed.'); };
  const reference = (receipt: Readonly<ArchiveReceipt>): ArchiveReference => ({ archiveId: receipt.archiveId, fingerprint: receipt.fingerprint, product: receipt.input.product });
  function input(product: ArchiveProduct, receivers: readonly Receiver[]): ArchiveInput {
    if (receiverKeys(archiveReceivers(store, product)) !== receiverKeys(receivers)) conflict('Archive receiver scope changed; refresh the full retained product family.');
    const history = store.exportHistory(), conversations = new Set(receivers.map(receiver => receiver.conversationId));
    const taskIds = new Set<string>(), runIds = new Set<string>();
    const submissions = history.submissions.filter(submission => conversations.has(submission.receiver.conversationId));
    for (const submission of submissions) {
      if (!['settled', 'blocked'].includes(submission.state)) conflict('Archive refuses queued, active or uncertain product submissions.');
      if (submission.detail === 'open-global-inbox' && !submission.coordinatorTaskId && !submission.runId) continue;
      const actual = commands.interactiveLookup(submission.id);
      if (!actual && submission.state === 'blocked' && !submission.coordinatorTaskId && !submission.runId) continue;
      if (!actual || actual.state !== 'settled' || actual.conversationId !== submission.receiver.conversationId ||
        (submission.coordinatorTaskId !== null && actual.taskId !== submission.coordinatorTaskId)) conflict('Retained submission lacks exact settled coordinator provenance; recover before archiving.');
      taskIds.add(actual.taskId);
      const runs = [actual.run, actual.result?.run].filter(run => run !== undefined);
      for (const run of runs) {
        if (run.taskId !== actual.taskId || run.interactive?.conversationId !== submission.receiver.conversationId || run.interactive.requestId !== submission.id) conflict('Linked coordinator run differs from the product receiver.');
        runIds.add(run.id);
      }
      if (submission.runId && !runs.some(run => run.id === submission.runId)) conflict('Known product run is missing from coordinator lookup.');
    }
    for (const task of history.tasks.filter(task => receivers.some(receiver => receiver.taskId === task.id))) {
      if ((task.coordinatorTaskId && !taskIds.has(task.coordinatorTaskId)) || (task.runId && !runIds.has(task.runId))) conflict('Known task history lacks exact coordinator/run mapping; archive never omits a linked execution.');
    }
    return { archiveId: productArchiveId(product), product, receivers: [...receivers], taskIds: [...taskIds].sort(), runIds: [...runIds].sort() };
  }
  return {
    readiness() {
      try { requireActivation(); options.actor(); return { id: 'history-archive', state: 'ready', detail: 'Verified owner/coordinator archive port. Each archive still requires fresh terminal history and actual stopped workspace proofs.' }; }
      catch { return { id: 'history-archive', state: 'blocked', detail: 'Existing reviewed activation and registered archive owner cannot be proved current.' }; }
    },
    assertDestinationAvailable(receiver: Receiver): void {
      store.assertDestinationAvailable(receiver.spaceId, receiver.taskId);
      let receipts: ArchiveReceipt[];
      try {
        requireActivation();
        // Include all possible roots: delegated children may live outside their parent's project.
        const history = store.exportHistory();
        const products: ArchiveProduct[] = [...history.projects.map(item => ({ kind: 'project' as const, id: item.id })),
          ...history.spaces.map(item => ({ kind: 'space' as const, id: item.id })), ...history.tasks.map(item => ({ kind: 'task' as const, id: item.id }))];
        const actor = options.actor();
        receipts = products.map(product => commands.interactiveArchiveLookup(actor, productArchiveId(product))).filter(receipt => receipt !== undefined);
      } catch {
        assertUnavailableReaderScope(store, receiver); return;
      }
      for (const receipt of receipts) {
        const sql = store.observeCoordinatedArchive(reference(receipt));
        if (receipt.fence.conversationIds.includes(receiver.conversationId) ||
          (sql.state !== 'archived' && store.receiversAffectDestination(receipt.input.receivers, receiver.spaceId, receiver.taskId))) conflict('Destination has a prepared or committed coordinator archive cutoff; history remains read-only.');
      }
    },
    async archive(receivers, owner, commit, product): Promise<ArchiveRecord> {
      requireActivation(); const actor = options.authenticateOwner(owner);
      const binding = store.getArchiveBinding(product.kind, product.id);
      if (binding && store.isArchived(product.kind, product.id)) {
        const bound = commands.interactiveArchiveLookup(actor, binding.archiveId);
        if (!bound || bound.fingerprint !== binding.fingerprint || bound.input.product.kind !== binding.product.kind || bound.input.product.id !== binding.product.id) conflict('Retained archive binding has no matching coordinator cutoff; history stays closed.');
        commands.interactiveArchiveReconcile(actor, bound.archiveId, receipt => store.observeCoordinatedArchive(reference(receipt)));
        return store.listArchives().find(record => record.kind === product.kind && record.entityId === product.id)!;
      }
      const prior = commands.interactiveArchiveLookup(actor, productArchiveId(product));
      if (prior && receiverKeys(prior.input.receivers) !== receiverKeys(receivers)) conflict('Archive retry must retain the original exact receiver identities.');
      if (prior && store.observeCoordinatedArchive(reference(prior)).state === 'archived') {
        commands.interactiveArchiveReconcile(actor, prior.archiveId, receipt => store.observeCoordinatedArchive(reference(receipt)));
        return store.listArchives().find(record => record.kind === product.kind && record.entityId === product.id)!;
      }
      const preparedInput = input(product, receivers);
      if (prior && inputKey(prior.input) !== inputKey(preparedInput)) conflict('Uncommitted archive retry must keep the original input fingerprint.');
      const history = store.exportHistory(), environments = broker.snapshots();
      const tasks = history.tasks.filter(task => receivers.some(receiver => receiver.taskId === task.id));
      const proofs: { taskId: string; epoch: number }[] = [];
      for (const task of tasks) {
        const environment = environments.find(item => item.taskId === task.id);
        if (task.environmentId && (!environment || environment.environmentId !== task.environmentId)) conflict('Retained environment identity is missing or changed; actual inactivity cannot be proved.');
        if (environment) proofs.push({ taskId: task.id, epoch: environment.lease.epoch });
      }
      return broker.withInactive(proofs, assertCurrent => {
        // This separate FULL-synchronous SQL transaction survives callback failure or process death.
        // Never remove it on an unavailable reader, client confirmation or ambiguous coordinator ACK.
        store.retainArchiveIntent(preparedInput);
        const guardedCommit: Commit = receipt => {
          requireActivation(); options.authenticateOwner(owner); assertCurrent();
          if (inputKey(input(product, receivers)) !== inputKey(preparedInput)) conflict('Product/coordinator provenance changed during archive preflight.');
          if (inputKey(receipt.input) !== inputKey(preparedInput)) conflict('Coordinator receipt differs from the exact retained archive attempt.');
          store.commitCoordinatedArchive(reference(receipt), () => { assertCurrent(); return commit(); }, receipt.input);
          return store.observeCoordinatedArchive(reference(receipt));
        };
        if (prior) commands.interactiveArchiveReconcile(actor, prior.archiveId, receipt => store.observeCoordinatedArchive(reference(receipt)), guardedCommit);
        else commands.interactiveArchive(actor, preparedInput, guardedCommit);
        return store.listArchives().find(record => record.kind === product.kind && record.entityId === product.id)!;
      });
    },
  };
}
