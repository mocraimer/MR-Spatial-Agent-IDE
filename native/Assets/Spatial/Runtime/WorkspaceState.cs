using System;
using System.Linq;

namespace Spatial.Native
{
    [Serializable] public sealed class Location { public string spaceId, taskId, viewId; public Location Copy() => new Location { spaceId = spaceId, taskId = taskId, viewId = viewId }; }

    // Observed snapshots never execute work or select newly arrived windows.
    public sealed class WorkspaceState
    {
        public Snapshot Snapshot { get; private set; } = new Snapshot();
        public Location Current { get; private set; } = new Location();
        public Location Origin { get; private set; }
        public bool InboxOpen { get; private set; }
        public string Notice { get; private set; }
        public Receiver Receiver
        {
            get
            {
                var space = Snapshot.spaces.FirstOrDefault(s => s.id == Current.spaceId);
                if (space == null) return null;
                var task = Snapshot.tasks.FirstOrDefault(t => t.id == Current.taskId && t.spaceId == space.id);
                if (!string.IsNullOrEmpty(Current.taskId) && task == null) return null;
                return new Receiver { spaceId = space.id, conversationId = task?.conversationId ?? space.conversationId, taskId = task?.id };
            }
        }
        public void Reset()
        {
            Snapshot = new Snapshot(); Current = new Location(); Origin = null; InboxOpen = false; Notice = null;
        }
        public void Restore(Location location, Location origin) { Current = location?.Copy() ?? new Location(); Origin = origin?.Copy(); }
        public void Apply(Snapshot snapshot)
        {
            if (snapshot == null || snapshot.protocolVersion != 1) throw new InvalidOperationException("Unsupported host protocol. Update host and client together.");
            if (snapshot.revision < Snapshot.revision) return;
            Snapshot = snapshot;
            if (string.IsNullOrEmpty(Current.spaceId)) Current.spaceId = snapshot.spaces.FirstOrDefault(s => string.IsNullOrEmpty(s.parentId) && string.IsNullOrEmpty(s.projectId))?.id;
            if (Receiver == null) Notice = "This destination is missing. Open All projects Inbox or choose Overview.";
            else if (!string.IsNullOrEmpty(Current.taskId) && !snapshot.tasks.Any(t => t.id == Current.taskId && t.spaceId == Current.spaceId))
                Notice = "Selected task is no longer available. Clear task selection to address this space.";
        }
        public bool Enter(string spaceId)
        {
            if (!Snapshot.spaces.Any(s => s.id == spaceId)) { Notice = "Space no longer exists. Refresh and choose a current destination."; return false; }
            Current = new Location { spaceId = spaceId }; InboxOpen = false; Notice = null; return true;
        }
        public bool SelectTask(string taskId)
        {
            var task = Snapshot.tasks.FirstOrDefault(t => t.id == taskId && t.spaceId == Current.spaceId);
            if (task == null) { Notice = "Task is not in this space. Refresh its destination."; return false; }
            Current.taskId = task.id; Current.viewId = null; Notice = null; return true;
        }
        public bool SelectView(string viewId)
        {
            var view = Snapshot.views.FirstOrDefault(v => v.id == viewId && v.taskId == Current.taskId);
            if (view == null) return false;
            Current.viewId = view.id; return true;
        }
        public void ClearTask() { Current.taskId = null; Current.viewId = null; Notice = null; }
        public void OpenInbox() => InboxOpen = true;
        public void CloseInbox() => InboxOpen = false;
        public bool Jump(InboxRequest request)
        {
            var actual = Snapshot.inbox.FirstOrDefault(i => i.id == request.id && i.version == request.version && (i.state == "open" || i.state == "deferred"));
            if (actual == null) { Notice = "Request changed. Refresh All projects Inbox before acting."; return false; }
            if (!Snapshot.spaces.Any(s => s.id == actual.spaceId) || (!string.IsNullOrEmpty(actual.taskId) && !Snapshot.tasks.Any(t => t.id == actual.taskId && t.spaceId == actual.spaceId)))
            { Notice = "Inbox destination is unavailable. Request remains intact; refresh or use host recovery."; return false; }
            if (Origin == null) Origin = Current.Copy();
            Current = new Location { spaceId = actual.spaceId, taskId = actual.taskId }; InboxOpen = false; Notice = null; return true;
        }
        public bool Return()
        {
            if (Origin == null) return false;
            if (!Snapshot.spaces.Any(s => s.id == Origin.spaceId) || (!string.IsNullOrEmpty(Origin.taskId) && !Snapshot.tasks.Any(t => t.id == Origin.taskId && t.spaceId == Origin.spaceId)))
            { Notice = "Return destination was removed. Return point is retained; choose Overview or recover it on host."; return false; }
            Current = Origin.Copy(); Origin = null; InboxOpen = false; Notice = null; return true;
        }
        public bool Back()
        {
            var parent = Snapshot.spaces.FirstOrDefault(s => s.id == Current.spaceId)?.parentId;
            return !string.IsNullOrEmpty(parent) && Enter(parent);
        }
    }

    public static class MessagePresentation
    {
        public static bool IsReply(Message message) => message != null && message.role == "agent" && message.state == "complete" && message.origin == null;
        public static Message Preview(Message[] messages) => messages?.LastOrDefault(message => message.origin == null);
        public static string Author(Message message) => message.origin == null ? message.role :
            "Delegated instruction · parent conversation " + message.origin.parentConversationId +
            " · parent task " + (message.origin.parentTaskId ?? "none") + " · parent run " + message.origin.coordinatorParentRunId;
    }

    public static class Organization
    {
        public static string EditRoute(Snapshot snapshot,Space space)
        {
            var project=snapshot.projects.FirstOrDefault(p=>p.rootSpaceId==space.id);
            return project==null?"/v1/spaces/"+HostClient.Id(space.id):"/v1/projects/"+HostClient.Id(project.id);
        }
        public static Space[] Destinations(Snapshot snapshot,Space space,bool move)
        {
            if(move&&(string.IsNullOrEmpty(space.parentId)||snapshot.projects.Any(p=>p.rootSpaceId==space.id)))return Array.Empty<Space>();
            return snapshot.spaces.Where(candidate=>candidate.id!=space.id&&(!move||(candidate.projectId==space.projectId&&candidate.id!=space.parentId&&!Descendant(snapshot,candidate,space.id)))).ToArray();
        }
        private static bool Descendant(Snapshot snapshot,Space candidate,string ancestor)
        {
            for(int i=0;i<snapshot.spaces.Length&&candidate!=null;i++)
            {if(candidate.parentId==ancestor)return true;candidate=snapshot.spaces.FirstOrDefault(s=>s.id==candidate.parentId);}
            return false;
        }
    }
    public static class ControlRecovery
    {
        public static bool Valid(string taskId,ControlLease lease)=>lease!=null&&lease.taskId==taskId&&lease.epoch>0&&
            (lease.owner=="owner"||lease.owner=="agent"||lease.owner=="handoff"||lease.owner=="uncertain");
    }
    public static class FrameFence
    {
        public static int Pixel(float normalized,int size)=>Math.Max(0,Math.Min(size-1,(int)(Math.Max(0,Math.Min(1,normalized))*size)));
        public static bool RequiresConfirmation(ControlLease lease)=>lease!=null&&lease.owner=="handoff"&&
            (!string.IsNullOrEmpty(lease.detail)&&(lease.detail.IndexOf("confirmation-required:",StringComparison.OrdinalIgnoreCase)>=0||lease.detail.IndexOf("explicit restart confirmation required",StringComparison.OrdinalIgnoreCase)>=0));
        public static bool Matches(TaskWindow task, ToolView view, FrameIdentity frame) => task != null && view != null && frame != null && view.available &&
            view.taskId == task.id && task.environmentId == view.environmentId && frame.environmentId == view.environmentId && frame.viewId == view.id && frame.generation == view.generation && frame.width > 0 && frame.height > 0;
        public static bool CanInput(TaskWindow task, ToolView view, FrameIdentity frame, ControlLease lease) => Matches(task, view, frame) &&
            lease != null && lease.taskId == task.id && lease.owner == "owner" && lease.epoch == frame.leaseEpoch;
    }

    public sealed class VoiceGate
    {
        public bool Enabled, Permission, Session, Connected, Speaking;
        public Receiver Captured { get; private set; }
        public bool CanCapture => Enabled && Permission && Session && Connected && !Speaking;
        public bool Begin(Receiver receiver) { if (!CanCapture || receiver == null || Captured != null) return false; Captured = receiver.Copy(); return true; }
        public Receiver End() { var receiver = Captured; Captured = null; return receiver; }
        public void Suppress() => Captured = null;
    }
}
