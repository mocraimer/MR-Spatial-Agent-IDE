using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UI;
using Object = UnityEngine.Object;

namespace Spatial.Native.Tests
{
    public sealed class SpatialKeyboardTests
    {
        private GameObject root, head;
        private SpatialWorkspace workspace;
        private const BindingFlags Private=BindingFlags.Instance|BindingFlags.NonPublic;
        [SetUp] public void SetUp()
        {
            PlayerPrefs.DeleteKey("spatial.navigation.v1");
            head=new GameObject("Keyboard head");root=new GameObject("Keyboard workspace");
            workspace=root.AddComponent<SpatialWorkspace>();workspace.enabled=false;workspace.ViewCamera=head.AddComponent<Camera>();workspace.Start();
            workspace.Voice.enabled=false;workspace.Host.enabled=false;workspace.Render();
        }
        [UnityTearDown] public IEnumerator TearDown()
        {
            workspace.Voice.Gate.Enabled=false;Object.Destroy(root);Object.Destroy(head);PlayerPrefs.DeleteKey("spatial.navigation.v1");yield return null;
        }
        private object Field(string name)=>typeof(SpatialWorkspace).GetField(name,Private).GetValue(workspace);
        private void Set(string name,object value)=>typeof(SpatialWorkspace).GetField(name,Private).SetValue(workspace,value);
        private void Call(string name,params object[] args)=>typeof(SpatialWorkspace).GetMethod(name,Private).Invoke(workspace,args);
        private GameObject Editor=>GameObject.Find("Text entry");
        private SpatialTextEntry Draft=>(SpatialTextEntry)Field("textEntry");
        private static SpatialTarget Target(GameObject panel,string label)=>panel.GetComponentsInChildren<SpatialTarget>().Single(t=>t.GetComponentInChildren<Text>()?.text==label);
        private static void Press(GameObject panel,string label) { var target=Target(panel,label);target.Press(target.transform.position); }
        private void Key(string label)=>Press(Editor,label);
        private void Begin(string prompt,string initial,Action<string> accept,bool secure=false)=>Call("Edit",prompt,initial,accept,secure);
        private GameObject Setup=>GameObject.Find("Trusted pairing");

        [UnityTest] public IEnumerator ActualUnpairedSetupFieldsOpenAndConfirmVerbatimUsingSpatialTargets()
        {
            Assert.That(workspace.Host.Pairing,Is.Null);Assert.That(workspace.Voice.Gate.Enabled,Is.False);
            Press(Setup,"HTTPS origin: ");Assert.That(Editor,Is.Not.Null,"Editor opens synchronously, before pairing");
            foreach(var key in new[]{"h","t","t","p","s","Symbols",":","/","/","Letters","h","o","s","t","Symbols",":","7","4","4","3"})Key(key);
            Key("Done");Assert.That(Field("hostOrigin"),Is.EqualTo("https://host:7443"));Assert.That(Editor,Is.Null);
            workspace.Render();Assert.That(Setup.GetComponentsInChildren<Text>().Any(t=>t.text.Contains("Updated · HTTPS host origin")),Is.True);
            Press(Setup,"Trusted SHA-256 fingerprint: ");
            for(int i=0;i<64;i++)Key("a");Key("Backspace");Key("f");Key("Done");
            Assert.That(Field("fingerprint"),Is.EqualTo(new string('a',63)+"f"));workspace.Render();
            Press(Setup,"One-time code: not entered");Key("Shift: off");Key("C");Key("1");Key("2");
            Assert.That(Editor.GetComponentsInChildren<Text>().Any(t=>t.text=="***"),Is.True);
            Assert.That(Editor.GetComponentsInChildren<Text>().Any(t=>t.text.Contains("C12")),Is.False);
            var old=Editor;var draft=Draft;Key("Done");Assert.That(Field("pairCode"),Is.EqualTo("C12"));
            Assert.That(draft.Value,Is.Empty);Assert.That(old.activeSelf,Is.False);Assert.That(old.GetComponentsInChildren<Collider>(true).All(c=>!c.enabled),Is.True);
            Assert.That(old.GetComponentsInChildren<Text>(true).All(t=>t.text==""),Is.True);
            workspace.Render();Press(Setup,"One-time code: entered");Key("Clear");Key("9");Key("Cancel");Assert.That(Field("pairCode"),Is.EqualTo("C12"));
            Assert.That(workspace.Host.Pairing,Is.Null,"Editing never pairs automatically");yield return null;
        }
        [UnityTest] public IEnumerator RedrawPersistsEditorAndNoBackgroundOrBlankRegionCanSelect()
        {
            Press(Setup,"HTTPS origin: ");var editor=Editor;Key("a");
            int colliders=editor.GetComponentsInChildren<Collider>(true).Length;
            for(int i=0;i<20;i++){Key(i%2==0?"Symbols":"Letters");Key(i%2==0?"Shift: off":"Shift: ON");workspace.Render();}
            yield return null;workspace.Render();Physics.SyncTransforms();
            Assert.That(Editor,Is.SameAs(editor));Assert.That(Draft.Value,Is.EqualTo("a"));
            Assert.That(editor.GetComponentsInChildren<Collider>(true).Length,Is.EqualTo(colliders));
            var surfaces=(Transform)Field("surfaces");Assert.That(surfaces.GetComponentsInChildren<Collider>().All(c=>!c.enabled),Is.True);
            var blank=editor.transform.TransformPoint(new Vector3(0,280,0));
            Assert.That(Physics.Raycast(blank-Vector3.forward,Vector3.forward,out var hit,4),Is.True);
            Assert.That(hit.collider.gameObject,Is.SameAs(editor));Assert.That(hit.collider.GetComponent<SpatialTarget>(),Is.Null);
            workspace.CloseModal();Assert.That(editor.activeSelf,Is.False);
            Assert.That(surfaces.GetComponentsInChildren<Collider>().All(c=>c.enabled),Is.True);
            yield return null;Assert.That(Object.FindObjectsByType<Transform>(FindObjectsSortMode.None).Count(t=>t.name=="Text entry"),Is.Zero);
        }
        [UnityTest] public IEnumerator OpeningClearsArmedPlacementAndRestoresOnlyOriginallyEnabledColliders()
        {
            var disabled=Target(Setup,"Trusted SHA-256 fingerprint: ").GetComponent<Collider>();disabled.enabled=false;
            var pointer=(SpatialPointer)Field("pointer");pointer.PlacementMode=true;Set("placementSpace",new Space{id="placing"});
            Press(Setup,"HTTPS origin: ");Assert.That(pointer.PlacementMode,Is.False);Assert.That(Field("placementSpace"),Is.Null);
            Key("a");Assert.That(Draft.Value,Is.EqualTo("a"));Key("Cancel");
            Assert.That(disabled.enabled,Is.False);Assert.That(Target(Setup,"HTTPS origin: ").GetComponent<Collider>().enabled,Is.True);yield return null;
        }
        [UnityTest] public IEnumerator ActualProjectAndModelChainsReleaseOldEditorBeforeNextField()
        {
            Call("CreateProject");var old=Editor;var draft=Draft;var oldDone=Target(old,"Done");Key("Shift: off");Key("P");Key("Done");
            Assert.That(Editor,Is.Not.SameAs(old));Assert.That(Editor.GetComponentsInChildren<Text>()[0].text,Is.EqualTo("Purpose"));
            Assert.That(old.activeSelf,Is.False);Assert.That(draft.Value,Is.Empty);oldDone.Press(oldDone.transform.position);
            Assert.That(Editor.GetComponentsInChildren<Text>()[0].text,Is.EqualTo("Purpose"));Key("Cancel");
            workspace.State.Apply(new Snapshot{protocolVersion=1,revision=1,spaces=new[]{new Space{id="s",conversationId="c"}},conversations=new[]{new Conversation{id="c",runtime="日本語",model="model😀",effort="high"}}});
            Call("ModelSettings");Assert.That(Draft.Value,Is.EqualTo("日本語"));Key("Done");Assert.That(Draft.Value,Is.EqualTo("model😀"));
            Key("Done");Assert.That(Draft.Value,Is.EqualTo("high"));Key("Cancel");yield return null;
        }
        [UnityTest] public IEnumerator LongUnicodeInitialValuesArePagedAndEditedAtEndWithoutTruncation()
        {
            string initial=new string('a',256)+"😀e\u0301";string accepted=null;
            Begin("Long fingerprint",initial,v=>accepted=v);Assert.That(Editor.GetComponentsInChildren<Text>().Any(t=>t.text.Contains("page 4 / 4")),Is.True);
            Key("Previous text");Assert.That(Editor.GetComponentsInChildren<Text>().Any(t=>t.text.Contains("page 3 / 4")),Is.True);
            Key("Backspace");Key("Shift: off");Key("F");Key("Symbols");Key(":");Key("Space");Key("Done");
            Assert.That(accepted,Is.EqualTo(new string('a',256)+"😀F: "));yield return null;
        }
        [UnityTest] public IEnumerator EditorSuppressesCaptureImmediatelyAndKeepsVoicePreferences()
        {
            workspace.Voice.Gate.Enabled=true;workspace.Voice.Gate.Permission=true;workspace.Voice.Gate.Connected=true;workspace.Voice.HandsFree=true;workspace.Voice.EnableSpokenReplies(true);
            var captured=new Receiver{spaceId="s",conversationId="c"};Assert.That(workspace.Voice.Gate.Begin(captured),Is.True);
            Begin("Text","",_=>{});Assert.That(workspace.Voice.Gate.CanCapture,Is.False);Assert.That(workspace.Voice.Gate.Captured,Is.Null);
            workspace.Voice.ProcessSamples(new[]{.5f});workspace.Voice.PushToTalk(true);
            Assert.That(workspace.Voice.Gate.Captured,Is.Null);Assert.That(workspace.Voice.Gate.Enabled&&workspace.Voice.Gate.Permission&&workspace.Voice.HandsFree&&workspace.Voice.SpokenReplies,Is.True);
            workspace.Render();Assert.That(workspace.Voice.Gate.Session,Is.False);Key("Done");Assert.That(workspace.Voice.Gate.Session,Is.True);
            Begin("Again","",_=>{});Key("Cancel");Assert.That(workspace.Voice.Gate.Session,Is.True);
            Assert.That(workspace.Voice.Gate.Enabled&&workspace.Voice.Gate.Permission&&workspace.Voice.HandsFree&&workspace.Voice.SpokenReplies,Is.True);
            Begin("Focus draft","",_=>Assert.Fail("Focus loss cannot accept"));Call("OnApplicationFocus",false);
            Assert.That(workspace.Voice.Gate.Session,Is.False);Assert.That(workspace.Voice.Gate.CanCapture,Is.False);
            Call("OnApplicationFocus",true);Begin("Pause draft","",_=>Assert.Fail("Pause cannot accept"));Call("OnApplicationPause",true);
            Assert.That(workspace.Voice.Gate.Session,Is.False);Assert.That(workspace.Voice.Gate.CanCapture,Is.False);
            Assert.That(workspace.Voice.Gate.Enabled&&workspace.Voice.Gate.Permission&&workspace.Voice.HandsFree&&workspace.Voice.SpokenReplies,Is.True);yield return null;
        }
        [UnityTest] public IEnumerator CloseNavigationReplacementHostResetPauseAndFocusDiscardWithoutAcceptance()
        {
            int accepted=0;
            Action[] cancellations={workspace.CloseModal,()=>Call("Navigate",(Action)workspace.State.OpenInbox),()=>Begin("Replacement","",_=>accepted++),workspace.ResetHostState,()=>Call("OnApplicationPause",true),()=>Call("OnApplicationFocus",false),()=>workspace.Host.ReplacePairing(new Pairing{host="https://test.invalid",fingerprint=new string('a',64),clientId="c",token="t"}),()=>workspace.Host.Forget()};
            for(int i=0;i<cancellations.Length;i++)
            {
                if(i==cancellations.Length-1)workspace.Host.ReplacePairing(new Pairing{host="https://test.invalid",fingerprint=new string('a',64),clientId="c",token="t"});
                var cancel=cancellations[i];
                Begin("Discard secure draft","secret",_=>accepted++,true);var old=Editor;var draft=Draft;var done=Target(old,"Done");cancel();
                Assert.That(old.activeSelf,Is.False);Assert.That(draft.Active,Is.False);Assert.That(draft.Value,Is.Empty);done.Press(done.transform.position);Assert.That(accepted,Is.Zero);
                workspace.CloseModal();workspace.Host.ReplacePairing(null);
                Call("OnApplicationPause",false);Call("OnApplicationFocus",true);
            }
            yield return null;
        }
        [UnityTest] public IEnumerator ActualTypedTurnRetainsCapturedReceiverAndNavigationCancelsNextTurn()
        {
            workspace.State.Apply(new Snapshot{protocolVersion=1,revision=1,spaces=new[]{new Space{id="s",conversationId="space-c"}},tasks=new[]{new TaskWindow{id="a",spaceId="s",conversationId="a-c"},new TaskWindow{id="b",spaceId="s",conversationId="b-c"}}});
            workspace.State.SelectTask("a");Call("WriteTurn");Key("h");Key("i");
            // Bypass disabled background only to prove the callback retains A, never redirects to B.
            workspace.State.SelectTask("b");Key("Done");var request=(TurnRequest)Field("failedTurn");
            Assert.That(request.receiver.taskId,Is.EqualTo("a"));Assert.That(request.receiver.conversationId,Is.EqualTo("a-c"));Assert.That(request.text,Is.EqualTo("hi"));
            Call("WriteTurn");var old=Editor;Key("q");Call("Navigate",(Action)(()=>workspace.State.SelectTask("a")));
            Assert.That(old.activeSelf,Is.False);Assert.That(Field("failedTurn"),Is.SameAs(request));yield return null;
        }
        [UnityTest] public IEnumerator ActualToolEditorPreservesTaskViewGenerationAndLeaseEpoch()
        {
            workspace.State.Apply(new Snapshot{protocolVersion=1,revision=1,spaces=new[]{new Space{id="s",conversationId="c"}},tasks=new[]{new TaskWindow{id="a",spaceId="s",conversationId="a-c",environmentId="env"}},views=new[]{new ToolView{id="v",taskId="a",environmentId="env",generation=3,available=true}}});
            workspace.State.SelectTask("a");workspace.State.SelectView("v");
            Set("frame",new FrameIdentity{environmentId="env",viewId="v",generation=3,leaseEpoch=7,width=800,height=600,sequence=1});
            Set("lease",new ControlLease{taskId="a",owner="owner",epoch=7});
            Call("WriteToolText");Assert.That(Editor,Is.Not.Null);
            var callback=(Action<string>)Field("acceptText");
            var input=(TaskInput)callback.Target.GetType().GetFields(BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic).Single(f=>f.FieldType==typeof(TaskInput)).GetValue(callback.Target);
            Set("frame",null);Set("lease",null);Key("x");Key("Done");
            Assert.That(input.taskId,Is.EqualTo("a"));Assert.That(input.viewId,Is.EqualTo("v"));Assert.That(input.environmentId,Is.EqualTo("env"));
            Assert.That(input.generation,Is.EqualTo(3));Assert.That(input.leaseEpoch,Is.EqualTo(7));Assert.That(input.text,Is.EqualTo("x"));yield return null;
        }
        [UnityTest] public IEnumerator ActualAuthorityReceiptChainRequiresExplicitVersionAndCancelNeverConfirms()
        {
            // Local connection eligibility seam only; Pairing remains null and no host route can run.
            typeof(HostClient).GetField("<Connected>k__BackingField",Private).SetValue(workspace.Host,true);
            workspace.InspectInbox(new InboxRequest{id="approval-a",version=4,kind="approval",state="open",evidence=new string[0]});
            Press(GameObject.Find("Retained detail"),"Decision");Press(GameObject.Find("Current request decision"),"Confirm existing authority");
            Assert.That(Editor.GetComponentsInChildren<Text>()[0].text,Is.EqualTo("Existing authority receipt ID"));
            var old=Editor;Key("r");Key("1");Key("Done");Assert.That(old.activeSelf,Is.False);
            Assert.That(Editor.GetComponentsInChildren<Text>()[0].text,Is.EqualTo("Exact receipt version"));Key("1");Key("Cancel");
            Assert.That(Editor,Is.Null);Assert.That(workspace.Host.Pairing,Is.Null);Assert.That(Field("notice"),Does.Not.Contain("acknowledged"));yield return null;
        }
        [UnityTest] public IEnumerator OrdinarySnapshotKeepsDraftButReceiverRemovalDiscardsIt()
        {
            var snapshot=new Snapshot{protocolVersion=1,revision=1,spaces=new[]{new Space{id="s",conversationId="c"}},tasks=new[]{new TaskWindow{id="a",spaceId="s",conversationId="a-c"}}};
            Call("OnSnapshot",snapshot);workspace.State.SelectTask("a");int accepted=0;Begin("Captured task","draft",_=>accepted++);var old=Editor;var draft=Draft;
            Call("OnSnapshot",snapshot);workspace.Render();Assert.That(Editor,Is.SameAs(old));Assert.That(Draft.Value,Is.EqualTo("draft"));
            Call("OnSnapshot",new Snapshot{protocolVersion=1,revision=2,spaces=snapshot.spaces});Assert.That(old.activeSelf,Is.False);Assert.That(draft.Value,Is.Empty);Assert.That(accepted,Is.Zero);yield return null;
        }
    }
}
