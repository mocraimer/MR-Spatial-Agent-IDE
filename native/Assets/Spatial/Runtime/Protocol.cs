using System;

namespace Spatial.Native
{
    [Serializable] public sealed class Receiver
    {
        public string spaceId, conversationId, taskId;
        public Receiver Copy() => new Receiver { spaceId = spaceId, conversationId = conversationId, taskId = taskId };
        public bool Same(Receiver other) => other != null && spaceId == other.spaceId && conversationId == other.conversationId && taskId == other.taskId;
    }
    [Serializable] public sealed class Point { public float x, y, z; }
    [Serializable] public sealed class Project { public string id, name, purpose, rootSpaceId; }
    [Serializable] public sealed class Space { public string id, projectId, parentId, name, purpose, conversationId; public Point position; }
    [Serializable] public sealed class SpaceLink { public string id, fromId, toId, label; }
    // Authorship of a delegated instruction, not an owner instruction or an agent answer.
    [Serializable] public sealed class DelegationOrigin { public string kind, parentConversationId, parentTaskId, coordinatorParentRunId; }
    [Serializable] public sealed class Message { public string id, conversationId, requestId, role, text, createdAt, state; [Newtonsoft.Json.JsonProperty(NullValueHandling = Newtonsoft.Json.NullValueHandling.Ignore)] public DelegationOrigin origin; }
    [Serializable] public sealed class Conversation { public string id, spaceId, taskId, runtime, model, effort; public Message[] messages = Array.Empty<Message>(); }
    [Serializable] public sealed class WindowLayout { public Point position, rotation, scale; }
    [Serializable] public sealed class TaskWindow { public string id, spaceId, conversationId, title, state, coordinatorTaskId, runId, environmentId, parentTaskId, detail, updatedAt; public WindowLayout layout; }
    [Serializable] public sealed class HistoryPage { public Message[] messages = Array.Empty<Message>(); public string nextBefore; }
    [Serializable] public sealed class ConversationSettings { public string runtime, model, effort; }
    [Serializable] public sealed class InboxDisposition { public string action, text, decidedAt, receiptId; public AuthorityReference authority; }
    [Serializable] public sealed class AuthorityReference { public string type, id; public int version; }
    [Serializable] public sealed class InboxRequest { public InboxDisposition disposition; public string id, spaceId, taskId, kind, title, detail, state, createdAt; public int version; public string[] evidence = Array.Empty<string>(); }
    [Serializable] public sealed class ReadinessItem { public string id, state, detail; }
    [Serializable] public sealed class ToolView { public string id, taskId, environmentId, kind, title, detail; public bool available; public long generation; }
    [Serializable] public sealed class Snapshot
    {
        public int protocolVersion; public long revision; public string capturedAt;
        public Project[] projects = Array.Empty<Project>(); public Space[] spaces = Array.Empty<Space>();
        public SpaceLink[] links = Array.Empty<SpaceLink>(); public Conversation[] conversations = Array.Empty<Conversation>();
        public TaskWindow[] tasks = Array.Empty<TaskWindow>(); public ToolView[] views = Array.Empty<ToolView>();
        public InboxRequest[] inbox = Array.Empty<InboxRequest>(); public ReadinessItem[] readiness = Array.Empty<ReadinessItem>();
    }
    [Serializable] public sealed class FrameIdentity { public string environmentId, viewId, capturedAt; public long generation, sequence, leaseEpoch; public int width, height; }
    [Serializable] public sealed class ControlLease { public string taskId, owner, detail; public long epoch; }
    [Serializable] public sealed class TaskInput { public string taskId, environmentId, viewId, kind, button, key, text; public long generation, leaseEpoch; public float x, y; }
    [Serializable] public sealed class ApiError { public string error, detail, recovery; }
    [Serializable] public sealed class PairRequest { public string code, label; }
    [Serializable] public sealed class PairResponse { public string clientId, token; public int protocolVersion; }
    [Serializable] public sealed class Pairing { public string host, fingerprint, token, clientId; }
    [Serializable] public sealed class TurnRequest { public string idempotencyKey, text; public Receiver receiver; }
    [Serializable] public sealed class VoiceRequest { public string idempotencyKey, wavBase64; public Receiver receiver; }
    [Serializable] public sealed class TaskRequest { public string idempotencyKey, spaceId, title, prompt, runtime, model, effort; }
    [Serializable] public sealed class ControlRequest { public string action; public long expectedEpoch; public bool confirmReset; }
    [Serializable] public sealed class TurnAck { public string requestId, conversationId, taskId, state, detail, transcript; }
    [Serializable] public sealed class InterruptRequest { public string mode; }
    [Serializable] public sealed class InboxResponse { public int version, authorityVersion; public string action, text, authorityId; }
    [Serializable] public sealed class SpaceRequest { public string projectId, parentId, name, purpose; public Point position; }
    [Serializable] public sealed class ProjectRequest { public string name, purpose; }
    [Serializable] public sealed class ContextSource { public string id,spaceId,name,provenance,sha256,text,createdAt; public long byteLength; }
    [Serializable] public sealed class LinkRequest { public string fromId, toId, label; }
}
