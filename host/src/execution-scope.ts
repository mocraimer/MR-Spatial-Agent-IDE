import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HostConfig } from './config.js';
import type { ExecutionScope } from './execution.js';
import type { CoordinatorCommands, DispatchTaskInput } from './runtime-coordinator.js';
import type { Submission, WorkspaceStore } from './store.js';

export type ScopeCoordinator = Pick<CoordinatorCommands, 'currentAuthoritySettings' | 'interactiveLookup'>;
function envelope(input: DispatchTaskInput): ExecutionScope {
  return { repo: input.repo, workClass: input.workClass, profile: input.profile, actions: input.actions,
    estimate: input.estimate!, timeoutMs: input.timeoutMs!,
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    ...(input.triggerSource === undefined ? {} : { triggerSource: input.triggerSource }) };
}
/** This is registration/provenance validation, not permission admission. Core remains authoritative. */
export function registeredExecutionScope(config: HostConfig, store: WorkspaceStore, submission: Submission, coordinator?: ScopeCoordinator, seen = new Set<string>()): ExecutionScope | null {
  if (seen.has(submission.id)) return null;
  seen.add(submission.id);
  store.assertDestinationAvailable(submission.receiver.spaceId, submission.receiver.taskId);
  const space = store.getSpace(submission.receiver.spaceId), conversation = store.getConversation(submission.receiver.conversationId);
  if (conversation.spaceId !== space.id || conversation.taskId !== submission.receiver.taskId) return null;
  const kind = submission.receiver.taskId === null ? 'space' : 'task';
  const registration = config.scopes.find(item => item.projectId === space.projectId && item.spaceId === space.id && item.receiver === kind && item.runtime === submission.runtime);
  let scope = registration?.scope;
  if (submission.receiver.taskId !== null) {
    const task = store.getTask(submission.receiver.taskId);
    if (task.spaceId !== space.id || task.conversationId !== conversation.id) return null;
    const origin = store.getTaskOrigin(task.id);
    if (origin) {
      if (!coordinator || space.projectId === null || origin.parentTaskId !== task.parentTaskId) return null;
      const parent = coordinator.currentAuthoritySettings(origin.coordinatorParentRunId, 'delegate-task', false);
      if (!parent.allowed || !parent.run.interactive || !parent.run.evidenceDir) return null;
      const parentSubmission = store.getSubmission(parent.run.interactive.requestId);
      if (coordinator.interactiveLookup(parentSubmission.id)?.run?.id !== parent.run.id || parentSubmission.receiver.conversationId !== origin.parentConversationId
        || parent.run.interactive.conversationId !== origin.parentConversationId || parentSubmission.receiver.taskId !== origin.parentTaskId
        || parentSubmission.receiver.spaceId !== space.id || store.getSpace(parentSubmission.receiver.spaceId).projectId !== space.projectId) return null;
      // Never derive model/effort/runtime from a child follow-up or a parent task's latest run.
      if (submission.runtime !== parent.run.runtime || submission.model !== parent.request.settings?.model || submission.effort !== parent.request.settings?.effort) return null;
      const parentScope = registeredExecutionScope(config, store, parentSubmission, coordinator, seen);
      if (!parentScope) return null;
      // Retained coordinator evidence includes resource estimates/timeout omitted by its authority request.
      // The directory comes only from the current public core run, never from model/content input.
      const admitted = JSON.parse(readFileSync(join(parent.run.evidenceDir, 'dispatch-request.json'), 'utf8')) as DispatchTaskInput;
      if (!isDeepStrictEqual(parentScope, envelope(admitted)) || (scope && !isDeepStrictEqual(scope, parentScope))) return null;
      scope = parentScope;
    }
  }
  if (!scope) return null;
  // Changed/reloaded registrations cannot silently retarget a previously admitted segment.
  if (submission.runId && coordinator) {
    const current = coordinator.currentAuthoritySettings(submission.runId, 'conversation', false);
    if (!current.allowed || current.run.interactive?.requestId !== submission.id || !current.run.evidenceDir) return null;
    const admitted = JSON.parse(readFileSync(join(current.run.evidenceDir, 'dispatch-request.json'), 'utf8')) as DispatchTaskInput;
    if (!isDeepStrictEqual(scope, envelope(admitted))) return null;
  }
  return structuredClone(scope);
}
