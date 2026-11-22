using System.Collections;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace Spatial.Native.Tests
{
    public sealed class VoiceAckRepairTests
    {
        [UnityTest] public IEnumerator TrustedVoiceCommandUsesAckIdentityOnlyAfterReceiverAndStateValidation()
        {
            var head = new GameObject("Voice acknowledgment head"); var root = new GameObject("Voice acknowledgment workspace");
            var workspace = root.AddComponent<SpatialWorkspace>(); workspace.enabled = false; workspace.ViewCamera = head.AddComponent<Camera>(); workspace.Start(); workspace.Voice.enabled = false;
            workspace.State.Apply(new Snapshot { protocolVersion = 1, revision = 1, spaces = new[] { new Space { id = "space", conversationId = "conversation" } },
                tasks = new[] { new TaskWindow { id = "task", spaceId = "space", conversationId = "task-conversation" } } });
            workspace.State.SelectTask("task"); var receiver = workspace.State.Receiver.Copy(); var request = new VoiceRequest { receiver = receiver };
            foreach (var ack in new[] {
                new TurnAck { conversationId = receiver.conversationId, taskId = "other", state = "local-command", detail = "open-global-inbox" },
                new TurnAck { conversationId = "other", taskId = receiver.taskId, state = "local-command", detail = "open-global-inbox" },
                new TurnAck { conversationId = receiver.conversationId, taskId = receiver.taskId, state = "queued", detail = "open-global-inbox", transcript = "open my global inbox" },
                new TurnAck { conversationId = receiver.conversationId, taskId = receiver.taskId, state = "local-command", detail = "unknown-command", transcript = "open my global inbox" } })
            {
                workspace.ObserveVoiceAck(request, ack); Assert.That(workspace.State.InboxOpen, Is.False); Assert.That(workspace.State.Receiver.Same(receiver), Is.True);
            }
            string transcript = "  OPEN  my global INBOX  ";
            workspace.ObserveVoiceAck(request, new TurnAck { conversationId = receiver.conversationId, taskId = receiver.taskId, state = "local-command", detail = "open-global-inbox", transcript = transcript, requestId = "accepted-command" });
            Assert.That(workspace.State.InboxOpen, Is.True); Assert.That(workspace.State.Receiver.Same(receiver), Is.True);
            var notice = (string)typeof(SpatialWorkspace).GetField("notice", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(workspace);
            Assert.That(notice, Does.Contain("Transcript: " + transcript + "\n"), "Preserve the actual transcription verbatim");
            workspace.State.CloseInbox();
            workspace.ObserveVoiceAck(request, new TurnAck { conversationId = receiver.conversationId, taskId = receiver.taskId, state = "local-command", detail = "open-global-inbox", transcript = "accepted by host, not reparsed here" });
            Assert.That(workspace.State.InboxOpen, Is.True);
            Object.Destroy(root); Object.Destroy(head); yield return null;
        }
    }
}
