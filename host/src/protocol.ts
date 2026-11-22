/** Versioned wire records shared with the native client; all snapshots are observed state. */
export const PROTOCOL_VERSION = 1;
export interface Receiver { spaceId: string; conversationId: string; taskId: string | null }
export interface Point { x: number; y: number; z: number }
export interface Project { id: string; name: string; purpose: string; rootSpaceId: string }
export interface Space { id: string; projectId: string | null; parentId: string | null; name: string; purpose: string; conversationId: string; position: Point }
export interface SpaceLink { id: string; fromId: string; toId: string; label: string }
/** Authorship of an initial delegated instruction, not an authority or an agent answer. */
export interface DelegationOrigin { kind: 'agent-delegation'; parentConversationId: string; parentTaskId: string | null; coordinatorParentRunId: string }
export interface Message { id: string; conversationId: string; requestId: string | null; role: 'owner' | 'agent' | 'system'; origin?: DelegationOrigin; text: string; createdAt: string; state: 'pending' | 'streaming' | 'complete' | 'failed' | 'uncertain' }
export interface Conversation { id: string; spaceId: string; taskId: string | null; runtime: string; model: string; effort: string; messages: Message[] }
export interface WindowLayout { position: Point; rotation: Point; scale: Point }
export interface TaskWindow { id: string; spaceId: string; conversationId: string; title: string; state: string; coordinatorTaskId: string | null; runId: string | null; environmentId: string | null; parentTaskId: string | null; layout: WindowLayout | null; detail: string; updatedAt: string }
export interface InboxDisposition { action: string; text: string; decidedAt: string; receiptId?: string; authority?: { type: 'approval' | 'grant'; id: string; version: number } }
export interface InboxRequest { id: string; version: number; spaceId: string; taskId: string | null; kind: 'question' | 'approval' | 'blocker' | 'review'; title: string; detail: string; state: 'open' | 'answered' | 'deferred' | 'dismissed'; disposition?: InboxDisposition; evidence: string[]; createdAt: string }
export interface ReadinessItem { id: string; state: 'ready' | 'missing' | 'blocked' | 'unknown'; detail: string }
export interface ToolView { id: string; taskId: string; environmentId: string; kind: 'browser' | 'terminal' | 'desktop' | 'artifact'; title: string; available: boolean; generation: number; detail: string }
export interface Snapshot { protocolVersion: number; revision: number; capturedAt: string; projects: Project[]; spaces: Space[]; links: SpaceLink[]; conversations: Conversation[]; tasks: TaskWindow[]; views: ToolView[]; inbox: InboxRequest[]; readiness: ReadinessItem[] }
export interface TaskInput { taskId: string; environmentId: string; viewId: string; generation: number; leaseEpoch: number; kind: 'pointer' | 'key' | 'text'; x: number; y: number; button: string; key: string; text: string }
export interface FrameIdentity { environmentId: string; viewId: string; generation: number; sequence: number; capturedAt: string; width: number; height: number; leaseEpoch: number }
export interface ControlLease { taskId: string; owner: 'agent' | 'owner' | 'handoff' | 'uncertain'; epoch: number; detail: string }
export interface ApiError { error: string; detail: string; recovery: string }
