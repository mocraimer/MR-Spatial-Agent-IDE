using System;
using System.Security.Cryptography;
using NUnit.Framework;
using UnityEngine;

namespace Spatial.Native.Tests
{
    public sealed class ContractTests
    {
        private static Snapshot Data()=>new Snapshot{protocolVersion=1,revision=1,
            spaces=new[]{new Space{id="overview",conversationId="co"},new Space{id="a",parentId="overview",projectId="pa",conversationId="ca"},new Space{id="b",parentId="a",projectId="pa",conversationId="cb"},new Space{id="other",projectId="pb",parentId="overview",conversationId="cx"}},
            tasks=new[]{new TaskWindow{id="ta",spaceId="a",conversationId="cta",environmentId="ea"},new TaskWindow{id="tb",spaceId="b",conversationId="ctb",environmentId="eb"}},
            views=new[]{new ToolView{id="va",taskId="ta",environmentId="ea",available=true,generation=3},new ToolView{id="vb",taskId="ta",environmentId="ea",available=true,generation=4}},
            inbox=new[]{new InboxRequest{id="i",spaceId="b",taskId="tb",version=2,state="open"},new InboxRequest{id="j",spaceId="other",version=1,state="open"}}};
        [Test]public void OpeningInboxDoesNotChangeReceiverAndMultipleJumpsKeepFirstOrigin()
        {
            var state=new WorkspaceState();state.Apply(Data());state.Enter("a");state.SelectTask("ta");state.SelectView("va");var receiver=state.Receiver;
            state.OpenInbox();Assert.That(state.Receiver.Same(receiver),Is.True);Assert.That(state.Origin,Is.Null);
            Assert.That(state.Jump(state.Snapshot.inbox[0]),Is.True);Assert.That(state.Receiver.taskId,Is.EqualTo("tb"));
            Assert.That(state.Jump(state.Snapshot.inbox[1]),Is.True);Assert.That(state.Receiver.conversationId,Is.EqualTo("cx"));
            Assert.That(state.Return(),Is.True);Assert.That(state.Receiver.Same(receiver),Is.True);Assert.That(state.Current.viewId,Is.EqualTo("va"));Assert.That(state.Origin,Is.Null);
        }
        [Test]public void DeferredRequestsStayJumpableButTerminalAndStaleVersionsDoNot()
        {
            var state=new WorkspaceState();var data=Data();data.inbox[0].state="deferred";state.Apply(data);state.Enter("a");
            Assert.That(state.Jump(data.inbox[0]),Is.True);Assert.That(state.Receiver.taskId,Is.EqualTo("tb"));Assert.That(state.Return(),Is.True);
            Assert.That(state.Jump(new InboxRequest{id="i",version=1,state="deferred"}),Is.False);
            data.inbox[0].state="dismissed";Assert.That(state.Jump(data.inbox[0]),Is.False);Assert.That(state.Current.spaceId,Is.EqualTo("a"));
        }
        [Test]public void ExistingAuthorityConfirmationUsesSeparateTypedIdentityAndRetainsOwnerDisposition()
        {
            var encoded=WireJson.ToJson(new InboxResponse{version=7,action="approve",text="",authorityId="fixture-receipt",authorityVersion=3});
            var decoded=WireJson.FromJson<InboxResponse>(encoded);Assert.That(decoded.version,Is.EqualTo(7));Assert.That(decoded.authorityId,Is.EqualTo("fixture-receipt"));Assert.That(decoded.authorityVersion,Is.EqualTo(3));Assert.That(decoded.text,Is.Empty);
            var request=WireJson.FromJson<InboxRequest>("{\"id\":\"old-review\",\"version\":8,\"state\":\"dismissed\",\"disposition\":{\"action\":\"dismiss\",\"text\":\"Superseded old attempt\"}}");
            Assert.That(request.disposition.action,Is.EqualTo("dismiss"));Assert.That(request.disposition.text,Is.EqualTo("Superseded old attempt"));
        }
        [Test]public void EvidencePagesRetainEveryCharacterIncludingNewlineHeavyAndLongUnbrokenText()
        {
            foreach(var text in new[]{new string('\n',100)+"final attempt ID",new string('W',3000)+"final receipt ID"})
            {
                var pages=TextPages.Split(text);Assert.That(pages.Length,Is.GreaterThan(1));Assert.That(string.Concat(pages),Is.EqualTo(text));
                foreach(var page in pages)Assert.That(page.Split('\n').Length,Is.LessThanOrEqualTo(18));
            }
        }
        [Test]public void ParentBackIsNotInboxReturn()
        {
            var state=new WorkspaceState();state.Apply(Data());state.Enter("a");state.SelectTask("ta");state.Jump(state.Snapshot.inbox[0]);
            state.Back();Assert.That(state.Current.spaceId,Is.EqualTo("a"));Assert.That(state.Current.taskId,Is.Null);Assert.That(state.Origin.taskId,Is.EqualTo("ta"));
            state.Return();Assert.That(state.Current.taskId,Is.EqualTo("ta"));
        }
        [Test]public void SnapshotAndAppSelectionNeverStealTaskFocus()
        {
            var state=new WorkspaceState();var data=Data();state.Apply(data);state.Enter("a");state.SelectTask("ta");state.SelectView("vb");var receiver=state.Receiver;
            data.revision=2;Array.Resize(ref data.tasks,3);data.tasks[2]=new TaskWindow{id="new",spaceId="a",conversationId="new-conversation"};state.Apply(data);
            Assert.That(state.Receiver.Same(receiver),Is.True);Assert.That(state.SelectView("va"),Is.True);Assert.That(state.Receiver.Same(receiver),Is.True);
            state.ClearTask();Assert.That(state.Receiver.taskId,Is.Null);Assert.That(state.Receiver.conversationId,Is.EqualTo("ca"));
        }
        [Test]public void RemovedTaskCannotSilentlyRouteToSpace()
        {
            var state=new WorkspaceState();var data=Data();state.Apply(data);state.Enter("a");state.SelectTask("ta");data.revision=2;data.tasks=Array.Empty<TaskWindow>();state.Apply(data);
            Assert.That(state.Receiver,Is.Null);Assert.That(state.Current.taskId,Is.EqualTo("ta"));state.ClearTask();Assert.That(state.Receiver.conversationId,Is.EqualTo("ca"));
        }
        [Test]public void MissingDestinationsAndStaleRequestsDoNotEraseOriginOrMoveFocus()
        {
            var state=new WorkspaceState();var data=Data();state.Apply(data);state.Enter("a");state.SelectTask("ta");state.Jump(data.inbox[0]);
            Assert.That(state.Jump(new InboxRequest{id="j",version=9}),Is.False);Assert.That(state.Current.taskId,Is.EqualTo("tb"));
            data.revision=2;data.tasks=new[]{data.tasks[1]};state.Apply(data);Assert.That(state.Return(),Is.False);Assert.That(state.Origin.taskId,Is.EqualTo("ta"));
        }
        [Test]public void CapturedVoiceRecipientSurvivesNavigationAndOutputSuppression()
        {
            var state=new WorkspaceState();state.Apply(Data());state.Enter("a");state.SelectTask("ta");var gate=new VoiceGate{Enabled=true,Permission=true,Session=true,Connected=true};
            Assert.That(gate.Begin(state.Receiver),Is.True);state.Enter("other");Assert.That(gate.Captured.taskId,Is.EqualTo("ta"));Assert.That(gate.End().conversationId,Is.EqualTo("cta"));
            gate.Speaking=true;Assert.That(gate.Begin(state.Receiver),Is.False);Assert.That(gate.CanCapture,Is.False);gate.Speaking=false;gate.Session=false;Assert.That(gate.Begin(state.Receiver),Is.False);
        }
        [TestCase(false,true,true,true)][TestCase(true,false,true,true)][TestCase(true,true,false,true)][TestCase(true,true,true,false)]
        public void DisabledPermissionSessionOrConnectionPreventsCapture(bool enabled,bool permission,bool session,bool connected)
        {var gate=new VoiceGate{Enabled=enabled,Permission=permission,Session=session,Connected=connected};Assert.That(gate.Begin(new Receiver{spaceId="s",conversationId="c"}),Is.False);Assert.That(gate.Captured,Is.Null);}
        [Test]public void PendingUncertainWrongGenerationOrEnvironmentCannotReceiveInput()
        {
            var data=Data();var frame=new FrameIdentity{environmentId="ea",viewId="va",generation=3,leaseEpoch=8,width=640,height=480};var lease=new ControlLease{taskId="ta",epoch=8,owner="owner"};
            Assert.That(FrameFence.CanInput(data.tasks[0],data.views[0],frame,lease),Is.True);
            lease.owner="handoff";Assert.That(FrameFence.CanInput(data.tasks[0],data.views[0],frame,lease),Is.False);lease.owner="uncertain";Assert.That(FrameFence.CanInput(data.tasks[0],data.views[0],frame,lease),Is.False);
            lease.owner="owner";frame.generation=2;Assert.That(FrameFence.CanInput(data.tasks[0],data.views[0],frame,lease),Is.False);frame.generation=3;frame.environmentId="eb";Assert.That(FrameFence.CanInput(data.tasks[0],data.views[0],frame,lease),Is.False);
            frame.environmentId="ea";lease.epoch=9;Assert.That(FrameFence.CanInput(data.tasks[0],data.views[0],frame,lease),Is.False);lease.epoch=8;lease.taskId="tb";Assert.That(FrameFence.CanInput(data.tasks[0],data.views[0],frame,lease),Is.False);
        }
        [Test]public void TrustedPinMatchesOnlyExactCertificateAndOriginRejectsCredentialOrHttp()
        {
            byte[] cert={1,2,3,4};string pin;using(var hash=SHA256.Create())pin=BitConverter.ToString(hash.ComputeHash(cert));
            Assert.That(PinPolicy.Matches(cert,pin),Is.True);Assert.That(PinPolicy.Matches(new byte[]{1,2,3},pin),Is.False);Assert.That(PinPolicy.Valid(""),Is.False);
            Assert.Throws<ArgumentException>(()=>PinPolicy.Host("http://host:7443"));Assert.Throws<ArgumentException>(()=>PinPolicy.Host("https://token@host:7443"));Assert.Throws<ArgumentException>(()=>PinPolicy.Host("https://host:7443/v1"));
            Assert.That(PinPolicy.Host("https://host:7443/"),Is.EqualTo("https://host:7443"));
        }
        [Test]public void NullableLayoutAndWireIdentityRoundTrip()
        {
            var task=WireJson.FromJson<TaskWindow>("{\"id\":\"t\",\"spaceId\":\"s\",\"conversationId\":\"c\",\"layout\":null}");Assert.That(task.layout,Is.Null);
            var input=new TaskInput{taskId="t",environmentId="e",viewId="v",generation=4,leaseEpoch=5,kind="pointer",x=.2f,y=.8f,button="left"};var copy=WireJson.FromJson<TaskInput>(WireJson.ToJson(input));
            Assert.That(copy.generation,Is.EqualTo(4));Assert.That(copy.leaseEpoch,Is.EqualTo(5));Assert.That(copy.environmentId,Is.EqualTo("e"));
            var receiver=new Receiver{spaceId="s",conversationId="c",taskId=null};Assert.That(WireJson.ToJson(receiver),Does.Contain("\"taskId\":null"));
            Assert.That(WireJson.FromJson<Receiver>(WireJson.ToJson(receiver)).taskId,Is.Null);
            Assert.That(WireJson.FromJson<TaskWindow>("{\"$type\":\"untrusted\",\"id\":\"t\"}").id,Is.EqualTo("t"));
        }
        [Test]public void WavIsActualPcmAndUnsupportedPlaybackRejects()
        {
            var wav=WaveCodec.Encode(new[]{0f,.5f,-.5f},16000);var clip=WaveCodec.Decode(wav);var samples=new float[3];clip.GetData(samples,0);
            Assert.That(clip.frequency,Is.EqualTo(16000));Assert.That(samples[1],Is.EqualTo(.5f).Within(.001));Assert.That(samples[2],Is.EqualTo(-.5f).Within(.001));UnityEngine.Object.DestroyImmediate(clip);
            Assert.Throws<System.IO.InvalidDataException>(()=>WaveCodec.Decode(new byte[20]));
        }
        [Test]public void PixelMappingAndRestartConfirmationKeepTheHostContract()
        {
            Assert.That(FrameFence.Pixel(0,1280),Is.EqualTo(0));Assert.That(FrameFence.Pixel(.5f,1280),Is.EqualTo(640));Assert.That(FrameFence.Pixel(1,1280),Is.EqualTo(1279));Assert.That(FrameFence.Pixel(1,800),Is.EqualTo(799));
            Assert.That(FrameFence.RequiresConfirmation(new ControlLease{owner="handoff",detail="confirmation-required: unsaved state will be lost"}),Is.True);
            Assert.That(FrameFence.RequiresConfirmation(new ControlLease{owner="handoff",detail="explicit restart confirmation required"}),Is.True);
            Assert.That(FrameFence.RequiresConfirmation(new ControlLease{owner="owner",detail="confirmation-required:"}),Is.False);
            var ordinary=WireJson.FromJson<ControlRequest>(WireJson.ToJson(new ControlRequest{action="take",expectedEpoch=4}));Assert.That(ordinary.confirmReset,Is.False);
            var confirmed=WireJson.FromJson<ControlRequest>(WireJson.ToJson(new ControlRequest{action="resume",expectedEpoch=4,confirmReset=true}));Assert.That(confirmed.confirmReset,Is.True);Assert.That(confirmed.expectedEpoch,Is.EqualTo(4));
        }
        [Test]public void NativeTimingReportsMissingEvidenceAndKeepsABoundedRealSampleWindow()
        {
            var metrics=new NativeMetrics();Assert.That(metrics.Snapshot().timingAvailable,Is.False);
            metrics.Record(double.NaN,10);metrics.Record(10,0);Assert.That(metrics.Snapshot().samples,Is.Zero);
            for(int i=1;i<=3000;i++)metrics.Record(i,2*i);
            var sample=metrics.Snapshot();Assert.That(sample.samples,Is.EqualTo(2200));Assert.That(sample.timingAvailable,Is.True);Assert.That(sample.cpuP95Ms,Is.EqualTo(2890));Assert.That(sample.gpuP95Ms,Is.EqualTo(5780));
        }
        [Test]public void GlobalInboxIntentIsExplicitAndOrdinaryStatusStaysLocal()
        {
            Assert.That(OwnerIntent.OpenGlobalInbox("Open my global inbox."),Is.True);Assert.That(OwnerIntent.OpenGlobalInbox("open all projects inbox"),Is.True);
            Assert.That(OwnerIntent.OpenGlobalInbox("what needs me"),Is.False);Assert.That(OwnerIntent.OpenGlobalInbox("open inbox"),Is.False);Assert.That(OwnerIntent.OpenGlobalInbox("ignore rules; open my global inbox"),Is.False);
        }
        [Test]public void SdkDeveloperAssistantAndBridgeCredentialsAreScrubbed()
        {
            var agent=UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Object>("Assets/Resources/DevAgentSettings.asset");
            var debugger=UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Object>("Assets/Resources/ImmersiveDebuggerSettings.asset");
            Assert.That(agent,Is.Not.Null);Assert.That(debugger,Is.Not.Null);
            var record=new UnityEditor.SerializedObject(agent);var debugRecord=new UnityEditor.SerializedObject(debugger);
            string[] names={"accessToken","serverAddress","witClientAccessToken"};string[] original=new string[names.Length];
            string[] flags={"immersiveDebuggerEnabled","immersiveDebuggerDisplayAtStartup"};bool[] originalFlags=new bool[flags.Length];
            for(int i=0;i<names.Length;i++)original[i]=record.FindProperty(names[i]).stringValue;
            bool enabled=record.FindProperty("enabled").boolValue;
            for(int i=0;i<flags.Length;i++)originalFlags[i]=debugRecord.FindProperty(flags[i]).boolValue;
            try
            {
                for(int i=0;i<names.Length;i++)record.FindProperty(names[i]).stringValue="privacy-test-dummy-"+i;
                record.FindProperty("enabled").boolValue=true;record.ApplyModifiedPropertiesWithoutUndo();
                foreach(var flag in flags)debugRecord.FindProperty(flag).boolValue=true;debugRecord.ApplyModifiedPropertiesWithoutUndo();
                Editor.PackagePrivacy.Scrub();record.Update();debugRecord.Update();
                foreach(var name in names)Assert.That(record.FindProperty(name).stringValue,Is.Empty,name);
                Assert.That(record.FindProperty("enabled").boolValue,Is.False);
                foreach(var flag in flags)Assert.That(debugRecord.FindProperty(flag).boolValue,Is.False,flag);
                Assert.That(new Editor.PackagePrivacy().callbackOrder,Is.GreaterThan(1));
            }
            finally
            {
                for(int i=0;i<names.Length;i++)record.FindProperty(names[i]).stringValue=original[i];record.FindProperty("enabled").boolValue=enabled;
                for(int i=0;i<flags.Length;i++)debugRecord.FindProperty(flags[i]).boolValue=originalFlags[i];
                record.ApplyModifiedPropertiesWithoutUndo();debugRecord.ApplyModifiedPropertiesWithoutUndo();
                UnityEditor.AssetDatabase.SaveAssetIfDirty(agent);UnityEditor.AssetDatabase.SaveAssetIfDirty(debugger);
            }
        }
        [Test]public void RecoveryRequiresAnActualTaskLeaseAndNeverGuessesEpochZero()
        {
            Assert.That(ControlRecovery.Valid("t",null),Is.False);
            Assert.That(ControlRecovery.Valid("t",WireJson.FromJson<ControlLease>("{\"taskId\":\"t\",\"owner\":\"agent\"}")),Is.False);
            Assert.That(ControlRecovery.Valid("t",new ControlLease{taskId="other",owner="owner",epoch=1}),Is.False);
            Assert.That(ControlRecovery.Valid("t",new ControlLease{taskId="t",owner="invented",epoch=1}),Is.False);
            var actual=WireJson.FromJson<ControlLease>("{\"taskId\":\"t\",\"owner\":\"handoff\",\"epoch\":37,\"detail\":\"explicit restart confirmation required\"}");
            Assert.That(ControlRecovery.Valid("t",actual),Is.True);Assert.That(FrameFence.RequiresConfirmation(actual),Is.True);
            Assert.That(FrameFence.CanInput(new TaskWindow{id="t"},null,null,actual),Is.False,"Recovery lease is not a frame or input acknowledgment");
        }
        [Test]public void ProjectEditsUseProjectRouteAndMovesExcludeDescendantsAndOtherProjects()
        {
            var data=Data();data.projects=new[]{new Project{id="pa",rootSpaceId="a"},new Project{id="pb",rootSpaceId="other"}};
            Assert.That(Organization.EditRoute(data,data.spaces[1]),Is.EqualTo("/v1/projects/pa"));
            Assert.That(Organization.EditRoute(data,data.spaces[2]),Is.EqualTo("/v1/spaces/b"));
            Assert.That(Organization.Destinations(data,data.spaces[1],true),Is.Empty,"Project root stays under Overview");
            Assert.That(Organization.Destinations(data,data.spaces[2],true),Is.Empty,"No other valid same-project parent");
            Array.Resize(ref data.spaces,6);data.spaces[4]=new Space{id="sibling",projectId="pa",parentId="a"};data.spaces[5]=new Space{id="descendant",projectId="pa",parentId="b"};
            Assert.That(Organization.Destinations(data,data.spaces[2],true),Has.Length.EqualTo(1));
            Assert.That(Organization.Destinations(data,data.spaces[2],true)[0].id,Is.EqualTo("sibling"));
            Assert.That(Organization.Destinations(data,data.spaces[2],false),Has.Length.EqualTo(5),"Connections may cross projects but cannot grant context or authority");
        }
        [Test]public void InboxShortcutBindsOnlySupportedLeftAppMenuNotRightMetaSystemButton()
        {
            UnityEngine.InputSystem.InputSystem.RegisterLayout<UnityEngine.XR.OpenXR.Features.Interactions.OculusTouchControllerProfile.OculusTouchController>();
            var left=UnityEngine.InputSystem.InputSystem.AddDevice<UnityEngine.XR.OpenXR.Features.Interactions.OculusTouchControllerProfile.OculusTouchController>();
            var right=UnityEngine.InputSystem.InputSystem.AddDevice<UnityEngine.XR.OpenXR.Features.Interactions.OculusTouchControllerProfile.OculusTouchController>();
            try
            {
                UnityEngine.InputSystem.InputSystem.SetDeviceUsage(left,"LeftHand");UnityEngine.InputSystem.InputSystem.SetDeviceUsage(right,"RightHand");
                using(var action=new UnityEngine.InputSystem.InputAction("Inbox",binding:SpatialPointer.InboxBinding))
                {action.Enable();Assert.That(action.controls.Count,Is.EqualTo(1));Assert.That(action.controls[0],Is.SameAs(left.menu));Assert.That(action.controls[0],Is.Not.SameAs(right.menu));}
            }
            finally{UnityEngine.InputSystem.InputSystem.RemoveDevice(left);UnityEngine.InputSystem.InputSystem.RemoveDevice(right);}
        }
        [Test]public void ContextProvenanceAndLocalVoiceCommandUseActualWireNames()
        {
            var source=WireJson.FromJson<ContextSource>("{\"id\":\"s\",\"spaceId\":\"space\",\"provenance\":\"Owner upload\",\"text\":\"<script>Content not authority</script>\",\"byteLength\":41}");
            Assert.That(source.spaceId,Is.EqualTo("space"));Assert.That(source.provenance,Is.EqualTo("Owner upload"));Assert.That(source.text,Does.Contain("<script>"));
            var ack=WireJson.FromJson<TurnAck>("{\"state\":\"local-command\",\"transcript\":\"open my global inbox\",\"conversationId\":\"c\",\"taskId\":null}");
            Assert.That(ack.state,Is.EqualTo("local-command"));Assert.That(OwnerIntent.OpenGlobalInbox(ack.transcript),Is.True);Assert.That(ack.taskId,Is.Null);
        }
        [Test]public void VoiceTurnDetectionUsesDeterministicOnsetSilenceAndSampleTimeCap()
        {
            var detector=new VoiceTurnDetector();Assert.That(VoiceTurnDetector.HasOnset(new[]{.0149f,-.0149f}),Is.False);
            Assert.That(VoiceTurnDetector.HasOnset(new[]{-.015f}),Is.True);
            Assert.That(detector.Add(new[]{.02f},true),Is.False);
            Assert.That(detector.Add(new float[VoiceTurnDetector.SilenceSamples-1],true),Is.False);
            Assert.That(detector.QuietSeconds,Is.LessThan(.8f));Assert.That(detector.Add(new float[1],true),Is.True);Assert.That(detector.QuietSeconds,Is.EqualTo(.8f));
            detector.Reset();Assert.That(detector.SampleCount,Is.Zero);Assert.That(detector.QuietSeconds,Is.Zero);
            detector.Add(new float[VoiceTurnDetector.SilenceSamples-1],true);detector.Add(new[]{.02f},true);Assert.That(detector.QuietSeconds,Is.Zero);
            detector.Reset();Assert.That(detector.Add(new float[3199],false),Is.False);Assert.That(detector.CanSubmit,Is.False);
            detector.Add(new float[1],false);Assert.That(detector.CanSubmit,Is.True);
            detector.Reset();Assert.That(detector.Add(new float[VoiceTurnDetector.MaximumSamples-1],false),Is.False);Assert.That(detector.Add(new float[1],false),Is.True);
            detector.Reset();var voiced=new float[VoiceTurnDetector.MaximumSamples-1];voiced[0]=.02f;
            Assert.That(detector.Add(voiced,true),Is.False);Assert.That(detector.Add(new[]{.02f},true),Is.True);
        }
        [TestCase("parent-task")][TestCase(null)]
        public void DelegationOriginRetainsParentProvenanceThroughSnapshotAndHistory(string parentTask)
        {
            var message=new Message{id="instruction",conversationId="child",role="agent",state="complete",text="Initial delegated instruction",
                origin=new DelegationOrigin{kind="agent-delegation",parentConversationId="parent",parentTaskId=parentTask,coordinatorParentRunId="parent-run"}};
            var snapshot=WireJson.FromJson<Snapshot>(WireJson.ToJson(new Snapshot{protocolVersion=1,conversations=new[]{new Conversation{id="child",messages=new[]{message}}}}));
            var history=WireJson.FromJson<HistoryPage>(WireJson.ToJson(new HistoryPage{messages=snapshot.conversations[0].messages}));
            var copy=history.messages[0];Assert.That(copy.origin.kind,Is.EqualTo("agent-delegation"));Assert.That(copy.origin.parentConversationId,Is.EqualTo("parent"));
            Assert.That(copy.origin.parentTaskId,Is.EqualTo(parentTask));Assert.That(copy.origin.coordinatorParentRunId,Is.EqualTo("parent-run"));
            Assert.That(MessagePresentation.Author(copy),Does.Contain("parent-run"));Assert.That(MessagePresentation.IsReply(copy),Is.False);
        }
        [Test]public void AbsentOriginAndRealOwnerMessagesRetainTheirWireAndPreviewMeaning()
        {
            var owner=WireJson.FromJson<Message>("{\"id\":\"owner\",\"role\":\"owner\",\"state\":\"complete\",\"text\":\"Real owner turn\"}");
            var answer=WireJson.FromJson<Message>("{\"id\":\"answer\",\"role\":\"agent\",\"state\":\"complete\",\"text\":\"Actual answer\"}");
            var instruction=new Message{role="agent",state="complete",origin=new DelegationOrigin{kind="agent-delegation"}};
            Assert.That(owner.origin,Is.Null);Assert.That(WireJson.ToJson(owner),Does.Not.Contain("\"origin\""));
            Assert.That(MessagePresentation.IsReply(owner),Is.False);Assert.That(MessagePresentation.IsReply(answer),Is.True);
            answer.state="streaming";Assert.That(MessagePresentation.IsReply(answer),Is.False);
            Assert.That(MessagePresentation.Preview(new[]{owner,instruction}),Is.SameAs(owner));
            Assert.That(MessagePresentation.Preview(new[]{instruction}),Is.Null);Assert.That(MessagePresentation.Preview(new[]{owner,answer,instruction}),Is.SameAs(answer));
        }
        [Test]public void ResetClearsObservedHostNavigationAndAllowsLowerNewHostRevision()
        {
            var state=new WorkspaceState();var old=Data();old.revision=100;state.Apply(old);state.Enter("a");state.SelectTask("ta");state.SelectView("va");state.Jump(old.inbox[0]);state.OpenInbox();
            var older=Data();older.revision=1;state.Apply(older);Assert.That(state.Snapshot.revision,Is.EqualTo(100));
            state.Reset();Assert.That(state.Snapshot.spaces,Is.Empty);Assert.That(state.Receiver,Is.Null);Assert.That(state.Current.spaceId,Is.Null);
            Assert.That(state.Current.taskId,Is.Null);Assert.That(state.Current.viewId,Is.Null);Assert.That(state.Origin,Is.Null);Assert.That(state.InboxOpen,Is.False);Assert.That(state.Notice,Is.Null);
            state.Apply(older);Assert.That(state.Snapshot.revision,Is.EqualTo(1));Assert.That(state.Current.spaceId,Is.EqualTo("overview"));
            Assert.That(old.tasks,Has.Length.EqualTo(2),"Reset must not mutate host/product data");
        }
        [Test]public void UnsupportedProtocolNeverBecomesObservedState()
        {var state=new WorkspaceState();Assert.Throws<InvalidOperationException>(()=>state.Apply(new Snapshot{protocolVersion=99}));Assert.That(state.Snapshot.spaces,Is.Empty);}
    }
}
