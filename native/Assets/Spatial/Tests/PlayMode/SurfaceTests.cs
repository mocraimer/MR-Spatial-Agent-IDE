using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace Spatial.Native.Tests
{
    public sealed class SurfaceTests
    {
        [UnityTest]public IEnumerator NativeButtonsRequireDeliberatePressAndFrameCoordinatesAreTopLeftNormalized()
        {
            var root=new GameObject("Test entered-space origin");int actions=0;
            var panel=new WorldSurface(root.transform,"Context",new Vector3(0,1,2),0,600,400);
            var untrusted=panel.Label("<size=99>untrusted content</size>",10,290,400,60);Assert.That(untrusted.supportRichText,Is.False);
            panel.Button("Enter",10,10,180,()=>actions++);yield return null;
            Assert.That(actions,Is.Zero);var target=panel.Root.GetComponentInChildren<SpatialTarget>();target.Press(target.transform.position);Assert.That(actions,Is.EqualTo(1));
            Vector2 point=Vector2.zero;var image=panel.Frame(null,10,70,400,250,p=>point=p);var frame=image.GetComponent<SpatialTarget>();frame.Press(frame.transform.TransformPoint(new Vector3(200,125,0)));
            Assert.That(point.x,Is.EqualTo(1).Within(.001));Assert.That(point.y,Is.EqualTo(0).Within(.001));
            Object.Destroy(root);yield return null;
        }
        [UnityTest]public IEnumerator FiftyOpenNodesAndSixRetainedTaskWindowsKeepHeadViewpointAndSpaceReceiver()
        {
            var cameraObject=new GameObject("Test head viewpoint");var camera=cameraObject.AddComponent<Camera>();camera.transform.position=new Vector3(0,1.6f,0);
            var root=new GameObject("Native scene seam");var workspace=root.AddComponent<SpatialWorkspace>();workspace.enabled=false;workspace.ViewCamera=camera;workspace.Start();
            var spaces=new Space[51];spaces[0]=new Space{id="test-overview",conversationId="test-space-conversation"};
            for(int i=1;i<=50;i++)spaces[i]=new Space{id="test-child-"+i,parentId=spaces[0].id,conversationId="test-child-conversation-"+i,name="Test node "+i};
            var tasks=new TaskWindow[6];for(int i=0;i<6;i++)tasks[i]=new TaskWindow{id="test-task-"+i,spaceId=spaces[0].id,conversationId="test-task-conversation-"+i,title="Test task "+i,state="blocked",detail="Test-only observed record; no agent adapter"};
            workspace.State.Apply(new Snapshot{protocolVersion=1,revision=1,spaces=spaces,tasks=tasks});var receiver=workspace.State.Receiver;
            workspace.RenderNodes(spaces[0]);workspace.RenderTasks(spaces[0]);yield return null;
            int nodes=0,windows=0;foreach(var obj in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None)){if(obj.name.StartsWith("Enter test-child-"))nodes++;if(obj.name.StartsWith("Retained task window test-task-"))windows++;}
            Assert.That(nodes,Is.EqualTo(50));Assert.That(windows,Is.EqualTo(6));Assert.That(workspace.State.Receiver.Same(receiver),Is.True);Assert.That(workspace.Voice.Gate.Enabled,Is.False);
            Assert.That(camera.transform.position,Is.EqualTo(new Vector3(0,1.6f,0)));workspace.State.Enter(spaces[1].id);workspace.Recenter();Assert.That(camera.transform.position,Is.EqualTo(new Vector3(0,1.6f,0)));
            Object.Destroy(root);Object.Destroy(cameraObject);yield return null;
        }
        [UnityTest]public IEnumerator SnapshotRedrawDoesNotEraseAnOwnerDialogAndCloseReallyRemovesItsInput()
        {
            var head=new GameObject("Dialog test head");var root=new GameObject("Dialog workspace");
            var workspace=root.AddComponent<SpatialWorkspace>();workspace.enabled=false;workspace.ViewCamera=head.AddComponent<Camera>();workspace.Start();
            workspace.Render();workspace.InspectText("Observed recovery","Host unavailable; no effect is assumed complete.");yield return null;
            var dialog=GameObject.Find("Retained detail");Assert.That(dialog,Is.Not.Null);
            workspace.Render();workspace.Render();yield return null;
            Assert.That(dialog,Is.Not.Null);Assert.That(dialog.activeSelf,Is.True,"Background snapshots cannot dismiss restart confirmation or retained details");
            Assert.That(dialog.GetComponentsInChildren<SpatialTarget>().Length,Is.EqualTo(1),"Only the enabled Close button accepts input on a one-page detail");
            workspace.CloseModal();Assert.That(dialog.activeSelf,Is.False,"Closing disables targets before deferred destruction");
            Object.Destroy(root);Object.Destroy(head);yield return null;
        }
        [UnityTest]public IEnumerator InboxEvidencePagesReachFinalAttemptBeforeDecisionControls()
        {
            var head=new GameObject("Evidence test head");var root=new GameObject("Evidence workspace");
            var workspace=root.AddComponent<SpatialWorkspace>();workspace.enabled=false;workspace.ViewCamera=head.AddComponent<Camera>();workspace.Start();
            workspace.InspectInbox(new InboxRequest{id="current-request",version=7,kind="review",state="deferred",title="Inspect exact old attempt",detail=new string('\n',65),evidence=new[]{"{\"source\":\"coordinator-interactive\",\"disposition\":{\"state\":\"obsolete\",\"reason\":\"Newer attempt exists; dismiss this old review\"},\"runId\":\"final-attempt-ID\"}"}});yield return null;
            var dialog=GameObject.Find("Retained detail");
            Assert.That(dialog.GetComponentsInChildren<UnityEngine.UI.Text>()[0].text,Does.Contain("version 7"));
            Assert.That(System.Array.Exists(dialog.GetComponentsInChildren<UnityEngine.UI.Text>(),t=>t.text=="Explicitly review"),Is.False);
            for(int i=0;i<20;i++)
            {
                var next=System.Array.Find(dialog.GetComponentsInChildren<SpatialTarget>(),t=>t.GetComponentInChildren<UnityEngine.UI.Text>().text=="Next");
                if(next==null)break;next.Press(next.transform.position);yield return null;dialog=GameObject.Find("Retained detail");
            }
            Assert.That(System.Array.Exists(dialog.GetComponentsInChildren<UnityEngine.UI.Text>(),t=>t.text.Contains("final-attempt-ID")),Is.True);
            var decision=System.Array.Find(dialog.GetComponentsInChildren<SpatialTarget>(),t=>t.GetComponentInChildren<UnityEngine.UI.Text>().text=="Decision");Assert.That(decision,Is.Not.Null);
            decision.Press(decision.transform.position);yield return null;
            var choices=GameObject.Find("Current request decision");Assert.That(choices,Is.Not.Null);
            Assert.That(System.Array.Exists(choices.GetComponentsInChildren<UnityEngine.UI.Text>(),t=>t.text.Contains("Obsolete review")),Is.True);
            Assert.That(System.Array.Exists(choices.GetComponentsInChildren<SpatialTarget>(),t=>t.GetComponentInChildren<UnityEngine.UI.Text>().text=="Explicitly review"),Is.False);
            Assert.That(System.Array.Exists(choices.GetComponentsInChildren<SpatialTarget>(),t=>t.GetComponentInChildren<UnityEngine.UI.Text>().text=="Dismiss / obsolete"),Is.True);
            Object.Destroy(root);Object.Destroy(head);yield return null;
        }
        [UnityTest]public IEnumerator RepeatedIdenticalHostStatusDoesNotContinuouslyRebuildTheUi()
        {
            var root=new GameObject("Host status test");var host=root.AddComponent<HostClient>();int notifications=0;host.StatusChanged+=_=>notifications++;
            host.SetStatus("Connected · observed host revision 3");host.SetStatus("Connected · observed host revision 3");
            Assert.That(notifications,Is.EqualTo(1));host.SetStatus("Host unavailable");Assert.That(notifications,Is.EqualTo(2));
            Object.Destroy(root);yield return null;
        }
        [UnityTest]public IEnumerator ActualVoiceFinishSubmitsMinimumRecordingOnceToOnsetReceiverNotCurrentSelection()
        {
            var root=new GameObject("Voice completion without mic IO");var voice=root.AddComponent<VoiceSession>();voice.enabled=false;voice.Initialize();
            var a=new Receiver{spaceId="space-a",conversationId="conversation-a",taskId="task-a"};var b=new Receiver{spaceId="space-b",conversationId="conversation-b",taskId="task-b"};
            var selected=a;voice.CurrentReceiver=()=>selected;voice.Gate.Enabled=true;voice.Gate.Permission=true;voice.Gate.Connected=true;
            var requests=new System.Collections.Generic.List<VoiceRequest>();voice.Submit=requests.Add;
            voice.PushToTalk(true);var samples=new float[3200];samples[0]=.25f;samples[3199]=-.25f;voice.ProcessSamples(samples);selected=b;voice.Finish();
            Assert.That(requests,Has.Count.EqualTo(1));Assert.That(requests[0].receiver.Same(a),Is.True);Assert.That(requests[0].receiver.Same(b),Is.False);
            Assert.That(System.Guid.TryParseExact(requests[0].idempotencyKey,"N",out _),Is.True);
            var wav=System.Convert.FromBase64String(requests[0].wavBase64);Assert.That(wav.Length,Is.EqualTo(44+3200*2));
            var clip=WaveCodec.Decode(wav);var pcm=new float[3200];clip.GetData(pcm,0);Assert.That(clip.frequency,Is.EqualTo(16000));Assert.That(pcm[0],Is.EqualTo(.25f).Within(.001));Assert.That(pcm[3199],Is.EqualTo(-.25f).Within(.001));Object.Destroy(clip);
            voice.Finish();Assert.That(requests,Has.Count.EqualTo(1));
            voice.PushToTalk(true);voice.ProcessSamples(new float[3199]);voice.Finish();voice.Finish();Assert.That(requests,Has.Count.EqualTo(1),"3199 samples is below the actual Finish minimum");
            voice.PushToTalk(true);voice.ProcessSamples(new float[3200]);voice.SetSession(false);voice.Finish();Assert.That(requests,Has.Count.EqualTo(1),"Session loss discards captured audio and receiver");
            Assert.That(voice.Gate.Captured,Is.Null);Object.Destroy(root);yield return null;
        }
        [UnityTest]public IEnumerator ActualHandsFreeOnsetSilenceAndTwentyFiveSecondCapSubmitThroughFinish()
        {
            var root=new GameObject("Voice sample time without mic IO");var voice=root.AddComponent<VoiceSession>();voice.enabled=false;voice.Initialize();voice.HandsFree=true;
            var a=new Receiver{spaceId="s",conversationId="a"};var selected=a;voice.CurrentReceiver=()=>selected;
            voice.Gate.Enabled=true;voice.Gate.Permission=true;voice.Gate.Connected=true;var requests=new System.Collections.Generic.List<VoiceRequest>();voice.Submit=requests.Add;
            voice.ProcessSamples(new[]{.0149f});Assert.That(voice.Gate.Captured,Is.Null);
            voice.ProcessSamples(new[]{-.015f});Assert.That(voice.Gate.Captured.Same(a),Is.True);selected=new Receiver{spaceId="s",conversationId="b"};
            voice.ProcessSamples(new float[12799]);Assert.That(requests,Is.Empty);voice.ProcessSamples(new float[1]);
            Assert.That(requests,Has.Count.EqualTo(1));Assert.That(requests[0].receiver.Same(a),Is.True);Assert.That(voice.Gate.Captured,Is.Null);
            voice.Finish();voice.ProcessSamples(new float[12800]);Assert.That(requests,Has.Count.EqualTo(1),"Silence without new onset cannot submit");
            var longTurn=new float[VoiceTurnDetector.MaximumSamples-1];longTurn[0]=.02f;voice.ProcessSamples(longTurn);Assert.That(requests,Has.Count.EqualTo(1));
            voice.ProcessSamples(new[]{.02f});Assert.That(requests,Has.Count.EqualTo(2));Assert.That(requests[1].receiver.Same(selected),Is.True);
            Assert.That(System.Convert.FromBase64String(requests[1].wavBase64).Length,Is.EqualTo(44+VoiceTurnDetector.MaximumSamples*2));
            voice.Finish();voice.SetSession(false);voice.Finish();Assert.That(requests,Has.Count.EqualTo(2));Object.Destroy(root);yield return null;
        }
        [UnityTest]public IEnumerator PairingBoundaryFencesOldRepliesAndPreservesSameIdentityRevision()
        {
            var root=new GameObject("Pairing boundary");var host=root.AddComponent<HostClient>();int changes=0,snapshots=0,replies=0;
            host.PairingChanged+=()=>changes++;host.SnapshotReceived+=_=>snapshots++;
            var a=new Pairing{host="https://host-a",fingerprint=new string('a',64),clientId="client-a",token="token-a"};
            host.ReplacePairing(a);int oldEpoch=host.ConnectionEpoch;
            Assert.That(host.Observe(oldEpoch,new Snapshot{protocolVersion=1,revision=100}),Is.True);
            host.Suspend();Assert.That(host.Deliver(oldEpoch,new HostReply{ok=true},_=>replies++),Is.False);
            Assert.That(host.Observe(oldEpoch,new Snapshot{protocolVersion=1,revision=200}),Is.False);
            Assert.That(host.Observe(host.ConnectionEpoch,new Snapshot{protocolVersion=1,revision=1}),Is.False,"Same-host reconnect must not regress revision");
            host.ReplacePairing(new Pairing{host=a.host,fingerprint=a.fingerprint,clientId=a.clientId,token=a.token});Assert.That(changes,Is.EqualTo(1));
            Assert.That(host.Observe(host.ConnectionEpoch,new Snapshot{protocolVersion=1,revision=2}),Is.False);
            host.ReplacePairing(new Pairing{host="https://host-b",fingerprint=new string('b',64),clientId="client-b",token="token-b"});
            Assert.That(changes,Is.EqualTo(2));Assert.That(host.Observe(host.ConnectionEpoch,new Snapshot{protocolVersion=1,revision=1}),Is.True);
            Assert.That(host.Deliver(host.ConnectionEpoch,new HostReply{ok=true},_=>replies++),Is.True);
            int removedEpoch=host.ConnectionEpoch;host.Forget();Assert.That(changes,Is.EqualTo(3));Assert.That(host.Pairing,Is.Null);Assert.That(host.Connected,Is.False);
            Assert.That(host.Deliver(removedEpoch,new HostReply{ok=true},_=>replies++),Is.False);Assert.That(host.Observe(removedEpoch,new Snapshot{revision=999}),Is.False);
            Assert.That(snapshots,Is.EqualTo(2));Assert.That(replies,Is.EqualTo(1));Object.Destroy(root);yield return null;
        }
        [UnityTest]public IEnumerator RePairAndForgetClearWorkspaceCachesWithoutClearingPermissionOrHostRecords()
        {
            var head=new GameObject("Pair-reset head");var root=new GameObject("Pair-reset workspace");var workspace=root.AddComponent<SpatialWorkspace>();workspace.enabled=false;
            workspace.ViewCamera=head.AddComponent<Camera>();workspace.Start();workspace.Voice.enabled=false;
            var a=new Pairing{host="https://host-a",fingerprint=new string('a',64),clientId="client",token="token"};workspace.Host.ReplacePairing(a);
            var old=new Snapshot{protocolVersion=1,revision=100,spaces=new[]{new Space{id="old",conversationId="old-conversation"}},tasks=new[]{new TaskWindow{id="old-task",spaceId="old",conversationId="old-task-conversation"}}};
            workspace.Host.Observe(workspace.Host.ConnectionEpoch,old);workspace.State.SelectTask("old-task");workspace.State.Restore(workspace.State.Current,new Location{spaceId="old"});workspace.State.OpenInbox();
            var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;
            typeof(SpatialWorkspace).GetField("failedTurn",flags).SetValue(workspace,new TurnRequest{receiver=workspace.State.Receiver.Copy(),text="Old host pending turn"});
            typeof(SpatialWorkspace).GetField("history",flags).SetValue(workspace,new HistoryPage{messages=new[]{new Message{text="Old host history"}}});
            typeof(SpatialWorkspace).GetField("historyConversation",flags).SetValue(workspace,"old-task-conversation");
            typeof(SpatialWorkspace).GetField("lease",flags).SetValue(workspace,new ControlLease{taskId="old-task",owner="owner",epoch=8});
            workspace.Voice.Gate.Enabled=true;workspace.Voice.Gate.Permission=true;Assert.That(workspace.Voice.Gate.Begin(workspace.State.Receiver),Is.True);
            workspace.InspectText("Old host dialog","Do not retain across pairing");var dialog=GameObject.Find("Retained detail");
            int oldEpoch=workspace.Host.ConnectionEpoch;
            workspace.Host.ReplacePairing(new Pairing{host="https://host-b",fingerprint=new string('b',64),clientId="client-b",token="token-b"});
            Assert.That(workspace.State.Snapshot.spaces,Is.Empty);Assert.That(workspace.State.Origin,Is.Null);Assert.That(workspace.State.InboxOpen,Is.False);
            foreach(var field in new[]{"failedTurn","history","historyConversation","lease","snapshotContent","pendingControlAction"})Assert.That(typeof(SpatialWorkspace).GetField(field,flags).GetValue(workspace),Is.Null,field);
            Assert.That(dialog.activeSelf,Is.False);Assert.That(workspace.Voice.Gate.Captured,Is.Null);Assert.That(workspace.Voice.Gate.Permission,Is.True);Assert.That(workspace.Voice.Gate.Enabled,Is.True);
            Assert.That(workspace.Host.Observe(oldEpoch,old),Is.False);
            Assert.That(workspace.Host.Observe(workspace.Host.ConnectionEpoch,new Snapshot{protocolVersion=1,revision=1,spaces=new[]{new Space{id="new",conversationId="new-conversation"}}}),Is.True);
            Assert.That(workspace.State.Receiver.conversationId,Is.EqualTo("new-conversation"));
            workspace.Host.Forget();Assert.That(workspace.State.Receiver,Is.Null);Assert.That(workspace.State.Current.spaceId,Is.Null);Assert.That(old.tasks[0].id,Is.EqualTo("old-task"));
            Assert.That(PlayerPrefs.GetString("spatial.navigation.v1"),Does.Not.Contain("old-task"));
            workspace.Voice.Gate.Enabled=false;Object.Destroy(root);Object.Destroy(head);yield return null;
        }
        [UnityTest]public IEnumerator DelegatedInitialInstructionStaysInTranscriptButNotPreviewOrAutomaticSpeech()
        {
            var head=new GameObject("Origin head");var root=new GameObject("Origin workspace");var workspace=root.AddComponent<SpatialWorkspace>();workspace.enabled=false;
            workspace.ViewCamera=head.AddComponent<Camera>();workspace.Start();workspace.Voice.enabled=false;
            workspace.Host.ReplacePairing(new Pairing{host="https://host-a",fingerprint=new string('a',64),clientId="client",token="token"});
            workspace.Voice.EnableSpokenReplies(true);
            var instruction=new Message{id="instruction",conversationId="child",role="agent",state="complete",text="Delegated instruction text",origin=new DelegationOrigin{kind="agent-delegation",parentConversationId="parent",parentTaskId="parent-task",coordinatorParentRunId="parent-run"}};
            var data=new Snapshot{protocolVersion=1,revision=1,spaces=new[]{new Space{id="space",conversationId="space-conversation"}},tasks=new[]{new TaskWindow{id="child-task",spaceId="space",conversationId="child",title="Child",detail="No reply yet"}},conversations=new[]{new Conversation{id="child",messages=new[]{instruction}}}};
            workspace.State.Apply(data);workspace.State.SelectTask("child-task");workspace.Host.Observe(workspace.Host.ConnectionEpoch,data);workspace.Render();
            var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;
            var heard=(System.Collections.Generic.HashSet<string>)typeof(SpatialWorkspace).GetField("heard",flags).GetValue(workspace);Assert.That(heard,Does.Not.Contain("instruction"));
            var transcript=GameObject.Find("Task-owned conversation");Assert.That(System.Array.Exists(transcript.GetComponentsInChildren<UnityEngine.UI.Text>(),t=>t.text.Contains("parent-run")&&t.text.Contains(instruction.text)),Is.True);
            workspace.State.ClearTask();workspace.Render();var preview=GameObject.Find("Retained task window child-task");
            Assert.That(System.Array.Exists(preview.GetComponentsInChildren<UnityEngine.UI.Text>(),t=>t.text.Contains(instruction.text)),Is.False);
            workspace.Host.Forget();Object.Destroy(root);Object.Destroy(head);yield return null;
        }
        [UnityTest]public IEnumerator VoiceStartsOffAndSessionLossDropsOnsetRecipientWithoutPlayback()
        {
            var root=new GameObject("Privacy test");var voice=root.AddComponent<VoiceSession>();voice.Initialize();voice.CurrentReceiver=()=>new Receiver{spaceId="s",conversationId="c"};
            Assert.That(voice.Gate.Enabled,Is.False);Assert.That(voice.SpokenReplies,Is.False);Assert.That(voice.Gate.CanCapture,Is.False);
            Assert.That(voice.Play(WaveCodec.Encode(new float[1600],16000),voice.CurrentReceiver()),Is.False);
            voice.Gate.Enabled=true;voice.Gate.Permission=true;voice.Gate.Connected=true;Assert.That(voice.Gate.Begin(voice.CurrentReceiver()),Is.True);
            voice.StopOutput();Assert.That(voice.Gate.Captured.conversationId,Is.EqualTo("c"),"Navigation stopping output must not discard a recording turn");
            voice.EnableSpokenReplies(true);Assert.That(voice.Play(WaveCodec.Encode(new float[1600],16000),voice.CurrentReceiver()),Is.False,"Reply arrival must not cut off a captured owner turn");
            Assert.That(voice.Gate.Captured.conversationId,Is.EqualTo("c"));
            voice.SetSession(false);Assert.That(voice.Gate.Captured,Is.Null);Assert.That(voice.Gate.CanCapture,Is.False);
            voice.Disable();Object.Destroy(root);yield return null;
        }
    }
}
