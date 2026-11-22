import { createHash } from 'node:crypto';
import { HostApiError, type OwnerDecision } from './server.js';
import type { InboxRequest, Receiver } from './protocol.js';
import type { WorkspaceStore, Submission } from './store.js';
import type { Actor, AuthorityRef, CoordinatorCommands, DispatchTaskInput } from './runtime-coordinator.js';

interface AuthorityHandoff {
  source: 'coordinator-awaiting-approval';
  original: DispatchTaskInput;
  receiver: Receiver;
  submissionFingerprint: string;
  refusal: string;
  taskRunId: string | null;
  parentAuthority?: AuthorityRef;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function stale(detail: string): never { throw new HostApiError(409, 'stale-authority-handoff', detail, 'Inspect the exact current request, selected existing receipt/version and private scope registration. No grant or inference occurred. Send a new deliberate turn after resolving setup.'); }

/** Only actual coordinator refusals with the exact host-built received envelope produce approvals. */
export function produceAuthorityHandoff(store: WorkspaceStore, coordinator: CoordinatorCommands, submission: Submission, original: DispatchTaskInput): InboxRequest | undefined {
  const received = coordinator.interactiveLookup(submission.id);
  if (!received || received.fingerprint !== digest(original) || received.run || received.state !== 'settled' || received.result?.outcome.kind !== 'awaiting-approval' || received.result.runtimeDispatched) return undefined;
  let parentAuthority: AuthorityRef | undefined;
  if (original.interactive?.parentRunId) {
    const parent = coordinator.currentAuthoritySettings(original.interactive.parentRunId, 'delegate-task', false);
    if (!parent.allowed) return undefined;
    parentAuthority = parent.authority;
  }
  const handoff: AuthorityHandoff = { source: 'coordinator-awaiting-approval', original: structuredClone(original), receiver: { ...submission.receiver }, submissionFingerprint: received.fingerprint,
    refusal: received.result.outcome.summary, taskRunId: submission.receiver.taskId ? store.getTask(submission.receiver.taskId).runId : null, ...(parentAuthority ? { parentAuthority } : {}) };
  const id = `authority-handoff-${digest(submission.id)}`;
  const existing = store.listInboxRequests().find(request => request.id === id);
  if (existing) return existing;
  return store.createInboxRequest({ id, ...{ spaceId: submission.receiver.spaceId, taskId: submission.receiver.taskId }, kind: 'approval', title: 'Confirm existing coordinator authority',
    detail: 'The coordinator refused this exact request awaiting approval. Use the selected coordinator CLI and private state to issue explicit owner-chosen scope and budgets. Register/reload an approval ID if needed, then confirm the matching existing receipt ID/version here. Confirmation proves scope coverage only, not capacity or permission to replay this turn. Send a new deliberate follow-up for fresh admission. See docs/HOST-SETUP.md.', evidence: [JSON.stringify(handoff)] });
}

/** The coordinator fence encloses SQL current-version validation and both exact owner receipts. */
export function confirmAuthorityHandoff(store: WorkspaceStore, coordinator: CoordinatorCommands, actor: Actor, request: InboxRequest, decision: OwnerDecision, currentInput: (submission: Submission) => DispatchTaskInput) {
  const current = store.getInboxRequest(request.id);
  if (current.kind !== 'approval' || current.version !== request.version || !['open', 'deferred'].includes(current.state)) stale('The owner request changed or closed.');
  let handoff: AuthorityHandoff;
  try { handoff = JSON.parse(current.evidence[0]!) as AuthorityHandoff; } catch { stale('An Inbox text approval is not a coordinator grant or a pinned handoff.'); }
  if (current.evidence.length !== 1 || handoff.source !== 'coordinator-awaiting-approval' || !handoff.original?.interactive || !decision.authorityId || !decision.authorityVersion) stale('An Inbox text approval is not a coordinator grant. Use an exact pinned refusal and existing receipt ID/version.');
  const submission = store.getSubmission(handoff.original.interactive.requestId);
  const validateProduct = (): DispatchTaskInput => {
    const pending = store.getSubmission(submission.id);
    if (pending.state !== 'blocked' || digest(pending.receiver) !== digest(handoff.receiver) || current.spaceId !== pending.receiver.spaceId || current.taskId !== pending.receiver.taskId) stale('The received request or destination changed.');
    if (pending.receiver.taskId && store.getTask(pending.receiver.taskId).runId !== handoff.taskRunId) stale('A newer attempt superseded this handoff.');
    const conversation = store.getConversation(pending.receiver.conversationId);
    if (conversation.runtime !== pending.runtime || conversation.model !== pending.model || conversation.effort !== pending.effort) stale('Runtime/model/effort changed since the refused turn.');
    return currentInput(pending);
  };
  const fresh = validateProduct();
  const { approvalId: oldApproval, ...originalScope } = handoff.original;
  const { approvalId: selectedApproval, ...currentScope } = fresh;
  if (digest(originalScope) !== digest(currentScope) || (oldApproval !== undefined && selectedApproval !== oldApproval)) stale('The immutable dispatch scope, resource estimate or parent changed.');
  const received = coordinator.interactiveLookup(submission.id);
  if (received?.fingerprint !== handoff.submissionFingerprint) stale('The retained coordinator refusal fingerprint changed.');
  const approval = coordinator.approvalGet(decision.authorityId);
  const expectedAuthority: AuthorityRef = { type: approval ? 'approval' : 'grant', id: decision.authorityId, version: decision.authorityVersion };
  if (approval && selectedApproval !== decision.authorityId) stale('The selected existing approval ID is not explicitly bound in the private receiver scope. Register it and reload the host safely first.');
  try {
    return coordinator.authorityConfirmationRecord(actor, { original: handoff.original, decisionId: decision.idempotencyKey, requestId: current.id, requestVersion: current.version, handoffDigest: digest(handoff), expectedAuthority,
      ...(approval ? { binding: { approvalId: decision.authorityId } } : {}), ...(handoff.parentAuthority ? { parentAuthority: handoff.parentAuthority } : {}) }, persist =>
      store.respondInbox(current.id, current.version, 'approve', decision.text, () => {
        if (digest(store.getInboxRequest(current.id).evidence) !== digest(current.evidence) || digest(validateProduct()) !== digest(fresh)) stale('Request evidence or scope changed before confirmation.');
        return persist();
      }));
  } catch (error) {
    if (error instanceof HostApiError) throw error;
    if (error instanceof Error && error.name === 'AuthorityConfirmationError') stale('Coordinator refused confirmation: original request, existing authority/version or parent scope is no longer current.');
    throw new HostApiError(503, 'confirmation-not-acknowledged', 'The owner confirmation could not be acknowledged. Its exact coordinator receipt may already be retained; no execution was started.', 'Refresh retained state. If the same request/version is still open, retry only the same receipt ID/version and decision identity. Never issue another grant to repair an acknowledgement.');
  }
}
