using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.UI;

namespace Spatial.Native
{
    public sealed class SpatialWorkspace : MonoBehaviour
    {
        public OVRCameraRig Rig; public Camera ViewCamera; public OVRPassthroughLayer Passthrough;
        public WorkspaceState State { get; private set; } = new WorkspaceState();
        public HostClient Host { get; private set; } public VoiceSession Voice { get; private set; }
        private SpatialPointer pointer; private Transform anchor, surfaces, modalSurfaces; private GameObject floor;
        private Material nodeMaterial, floorMaterial; private bool dirty = true, setup, mr, foreground = true, focused = true, paused;
        private string notice, hostOrigin = "", fingerprint = "", pairCode = "", frameProblem, snapshotContent;
        private int nodePage, taskPage, inboxPage; private FrameIdentity frame; private Texture2D texture; private RawImage frameImage;
        private Text frameStatusLabel, inputStatusLabel;
        private GameObject inputStatusSurface;
        private SpatialInputVisual[] inputVisuals;
        private ControlLease lease; private string streamView, pendingControlAction; private Coroutine streaming; private bool keyboardOwnsInput, controlPending;
        private Space placementSpace;
        private TurnRequest failedTurn; private HistoryPage history; private string historyConversation;
        private SpatialTextEntry textEntry;
        private SpatialKeyboard keyboard;
        private Action<string> acceptText;
        private readonly List<Collider> editorBlockedColliders = new List<Collider>();
        private readonly HashSet<string> heard = new HashSet<string>();
        private readonly Dictionary<string,int> defaultTaskSlots = new Dictionary<string,int>();
        private readonly NativeMetrics metrics=new NativeMetrics();
        private const string NavKey = "spatial.navigation.v1";
        [Serializable] private sealed class SavedNavigation { public Location current, origin; }
        public void Start()
        {
            Application.targetFrameRate = 72;
            anchor = new GameObject("Stable workspace origin").transform; surfaces = new GameObject("Entered space").transform; surfaces.SetParent(anchor, false);
            modalSurfaces=new GameObject("Owner dialogs").transform;modalSurfaces.SetParent(anchor,false);
            nodeMaterial = new Material(Resources.Load<Material>("SpatialNode")) { color = new Color(.28f,.52f,.58f) };
            floorMaterial = new Material(Resources.Load<Material>("SpatialNode")) { color = new Color(.035f,.065f,.09f) };
            floor = GameObject.CreatePrimitive(PrimitiveType.Plane); floor.name = "VR context ground"; floor.transform.localScale = Vector3.one * 4; floor.GetComponent<Renderer>().material = floorMaterial; Destroy(floor.GetComponent<Collider>());
            Host = gameObject.AddComponent<HostClient>(); Voice = gameObject.AddComponent<VoiceSession>(); Voice.Initialize();
            Voice.CurrentReceiver = () => State.Receiver; Voice.Submit = request => StartCoroutine(SubmitVoice(request)); Voice.Changed = _ => dirty = true;
            pointer = gameObject.AddComponent<SpatialPointer>(); pointer.Rig = Rig; pointer.ViewCamera = ViewCamera; pointer.InboxShortcut = () => Navigate(State.OpenInbox); pointer.PushToTalk = down => Voice.PushToTalk(down); pointer.CancelPushToTalk = Voice.CancelPushToTalk; pointer.PlaceWindow = PlaceWindow;
            Host.StatusChanged += _ => { Voice.SetConnected(Host.Connected); if(!Host.Connected)lease=null; dirty = true; };
            Host.SnapshotReceived += OnSnapshot;
            Host.PairingChanged += ResetHostState;
            try { var saved = WireJson.FromJson<SavedNavigation>(PlayerPrefs.GetString(NavKey, "")); if (saved != null) State.Restore(saved.current, saved.origin); } catch { notice = "Saved navigation is unreadable. Choose Overview."; }
            Recenter(); Host.Initialize(); StartCoroutine(Telemetry());
#if UNITY_ANDROID && !UNITY_EDITOR
            StartCoroutine(DisplayRefresh());
#endif
            if (Passthrough != null) Passthrough.enabled = false;
        }
        public void Recenter()
        {
            if (anchor == null || ViewCamera == null) return;
            var cameraPosition = ViewCamera.transform.position;
            anchor.position = new Vector3(cameraPosition.x, 0, cameraPosition.z);
            anchor.rotation = Quaternion.Euler(0, ViewCamera.transform.eulerAngles.y, 0);
            dirty = true;
        }
        internal void ResetHostState()
        {
            // Cancel old host operations and their captured UI callbacks, not host/product records or permission.
            StopAllCoroutines();
            CancelEdit();
            Voice.SetConnected(false); Voice.SetSession(OwnsListeningSession());
            StopStream(); CloseModal();
            State.Reset(); SaveNavigation();
            history = null; historyConversation = null; failedTurn = null; snapshotContent = null;
            heard.Clear(); defaultTaskSlots.Clear(); nodePage = taskPage = inboxPage = 0;
            lease = null; pendingControlAction = null; controlPending = false;
            placementSpace = null; pointer.PlacementMode = false; frameProblem = null;
            frameImage = null; frameStatusLabel = null; notice = null;
            dirty = true; StartCoroutine(Telemetry());
        }
        private void OnSnapshot(Snapshot snapshot)
        {
            if(snapshot!=null&&snapshot.revision<State.Snapshot.revision)return;
            var prior = State.Receiver;var previousSpace=State.Current.spaceId;
            var previousTask=State.Current.taskId;var previousView=State.Current.viewId;
            try { State.Apply(snapshot); }
            catch (InvalidOperationException error) { notice = error.Message; dirty = true; return; }
            foreach(var task in snapshot.tasks)TaskPosition(task);
            if(previousSpace!=State.Current.spaceId)SaveNavigation();
            var content=WireJson.ToJson(new {snapshot.protocolVersion,snapshot.revision,snapshot.projects,snapshot.spaces,snapshot.links,snapshot.conversations,snapshot.tasks,snapshot.views,snapshot.inbox,snapshot.readiness});
            bool changed=content!=snapshotContent;snapshotContent=content;
            var receiver = State.Receiver;
            if (previousSpace!=State.Current.spaceId || previousTask!=State.Current.taskId || previousView!=State.Current.viewId || (prior!=null&&!prior.Same(receiver))) CancelEdit();
            if (prior != null && !prior.Same(receiver)) Voice.StopOutput();
            // Arrival/background messages do not select a task or trigger audio.
            foreach (var conversation in snapshot.conversations)
            {
                foreach (var message in conversation.messages)
                {
                    if (!MessagePresentation.IsReply(message) || heard.Contains(message.id)) continue;
                    heard.Add(message.id);
                    if (Voice.SpokenReplies && receiver != null && message.conversationId == receiver.conversationId)
                        StartCoroutine(ReplySpeech(message.id, receiver.Copy()));
                }
            }
            if (heard.Count > 4096) { heard.Clear(); foreach (var c in snapshot.conversations) foreach (var m in c.messages) heard.Add(m.id); }
            if(changed)dirty = true;
        }
        private void SaveNavigation() { PlayerPrefs.SetString(NavKey, WireJson.ToJson(new SavedNavigation { current = State.Current, origin = State.Origin })); PlayerPrefs.Save(); }
        private void Navigate(Action action)
        {
            var previousTask=State.Current.taskId;
            CloseModal(); placementSpace=null;pointer.PlacementMode=false;
            action(); if(previousTask!=State.Current.taskId){lease=null;pendingControlAction=null;}
            SaveNavigation(); Voice.StopOutput(); history = null; historyConversation = null; nodePage = taskPage = inboxPage = 0;
            if(!string.IsNullOrEmpty(State.Current.taskId)){var tasks=State.Snapshot.tasks.Where(t=>t.spaceId==State.Current.spaceId).ToArray();int index=Array.FindIndex(tasks,t=>t.id==State.Current.taskId);if(index>=0)taskPage=index/6;}
            dirty = true;
        }
        private IEnumerator DisplayRefresh()
        {
            yield return new WaitForSecondsRealtime(1);
            if(OVRManager.display!=null&&OVRManager.display.displayFrequenciesAvailable.Any(hz=>Math.Abs(hz-72)<.1f))OVRManager.display.displayFrequency=72;
            else{notice="72 Hz display mode was not advertised by this active XR session. Check device OpenXR readiness; performance acceptance is not established.";dirty=true;}
        }
        private bool OwnsListeningSession()
        {
            bool active=foreground&&!keyboardOwnsInput;
#if UNITY_ANDROID && !UNITY_EDITOR
            active=active&&OVRManager.instance!=null&&OVRManager.instance.isUserPresent&&OVRManager.hasVrFocus&&OVRManager.hasInputFocus;
#endif
            return active;
        }
        private void Update()
        {
            metrics.Capture();
#if UNITY_ANDROID && !UNITY_EDITOR
            if (keyboardOwnsInput && (!OVRManager.hasVrFocus || !OVRManager.hasInputFocus)) CancelEdit();
#endif
            RefreshInputStatus();
            if (dirty && anchor != null) { dirty = false; Render(); }
            if (Voice != null)
            {
                Voice.SetSession(OwnsListeningSession());Voice.SetConnected(Host.Connected&&foreground);
            }
        }
        internal void RefreshInputStatus()
        {
            if (anchor == null) return;
            if (inputVisuals == null && Rig != null) inputVisuals = Rig.GetComponentsInChildren<SpatialInputVisual>(true);
            bool left = false, right = false;
            if (inputVisuals != null) foreach (var visual in inputVisuals)
                if (visual != null && visual.HandLoadUnavailable) { if (visual.Left) left = true; else right = true; }
            if (!left && !right) { if (inputStatusSurface != null) inputStatusSurface.SetActive(false); return; }
            if (inputStatusSurface == null)
            {
                // Separate from action feedback and owner dialogs; also visible before pairing.
                var panel = new WorldSurface(anchor, "Input recovery", new Vector3(-1.85f,2.15f,2.7f), -30,640,240);
                inputStatusSurface = panel.Root;
                inputStatusLabel = panel.Label("",18,18,604,204,22);
            }
            var sides = left && right ? "Left and right hand models" : left ? "Left hand model" : "Right hand model";
            var message = sides + " failed to load. Use controllers, or lower/move " +
                (left && right ? "each hand" : "that hand") + " out of tracking, then raise/reacquire to retry.";
            if (inputStatusLabel.text != message) inputStatusLabel.text = message;
            if (!inputStatusSurface.activeSelf) inputStatusSurface.SetActive(true);
        }
        internal void Render()
        {
            try { RenderWorkspace(); }
            finally { if (keyboardOwnsInput) BlockEditorBackground(); }
        }
        private void RenderWorkspace()
        {
            foreach (Transform child in surfaces) { child.gameObject.SetActive(false); Destroy(child.gameObject); }
            frameImage = null; frameStatusLabel = null;
            if (Host.Pairing == null || setup) { RenderSetup(); return; }
            var space = State.Snapshot.spaces.FirstOrDefault(s => s.id == State.Current.spaceId);
            var receiver = State.Receiver;
            var nav = new WorldSurface(surfaces, "Context and navigation", new Vector3(0,2.05f,2.55f), 0, 980,170);
            nav.Label(space?.name ?? "Workspace unavailable", 18,12,750,40,30);
            nav.Button("Parent Back",18,60,150,()=>Navigate(()=>State.Back()));
            nav.Button("Overview",176,60,145,()=>Navigate(()=>{ var overview = State.Snapshot.spaces.FirstOrDefault(s=>string.IsNullOrEmpty(s.parentId)&&string.IsNullOrEmpty(s.projectId)); if(overview!=null) State.Enter(overview.id); }));
            nav.Button("All projects Inbox",329,60,220,()=>Navigate(State.OpenInbox));
            nav.Button("Return to origin",557,60,195,()=>Navigate(()=>State.Return()),State.Origin!=null);
            nav.Button("Recenter",760,60,130,Recenter);
            nav.Label(Host.Status + " · Inbox: left app Menu / keyboard F1 · " + State.Snapshot.capturedAt,18,115,930,43,18,new Color(.63f,.78f,.82f));
            RenderReceiver(receiver, space);
            if (State.InboxOpen) { RenderInbox(); StopStream(); return; }
            if (space == null) { RenderBlocked("No current space", State.Notice ?? "Host has no Overview. Register a project/space in host setup and refresh."); StopStream(); return; }
            RenderNodes(space); RenderTasks(space); RenderConversation(receiver);
            var task = State.Snapshot.tasks.FirstOrDefault(t=>t.id==State.Current.taskId);
            if(task!=null) RenderTools(task); else { StopStream(); RenderSpaceActions(space); }
            if(!string.IsNullOrEmpty(State.Notice) || !string.IsNullOrEmpty(notice))
            { var alert = new WorldSurface(surfaces,"Recovery",new Vector3(-1.85f,1.1f,2.7f),-30,560,190); alert.Label(State.Notice??notice,18,18,520,115,20); alert.Button("Dismiss local notice",18,138,285,()=>{notice=null;dirty=true;}); }
        }
        private void RenderSetup()
        {
            StopStream(); var panel = new WorldSurface(surfaces,"Trusted pairing",new Vector3(0,1.35f,2.2f),0,840,700);
            panel.Label("Spatial Agent Workspace",24,20,790,55,34);
            panel.Label("Pair with your host · no agents or microphone start automatically",24,80,790,75,22);
            panel.Button("HTTPS origin: " + hostOrigin,24,164,790,()=>Edit("HTTPS host origin",hostOrigin,value=>hostOrigin=value));
            panel.Button("Trusted SHA-256 fingerprint: " + (fingerprint.Length>12?fingerprint.Substring(0,12)+"…":fingerprint),24,218,790,()=>Edit("Fingerprint from trusted setup",fingerprint,value=>fingerprint=value));
            panel.Button("One-time code: " + (pairCode.Length>0?"entered":"not entered"),24,272,790,()=>Edit("Pairing code",pairCode,value=>pairCode=value,true));
            panel.Button("Pair this Quest",24,326,240,()=>{CloseModal();StartCoroutine(Host.Pair(hostOrigin,fingerprint,pairCode));});
            panel.Button("Reconnect",275,326,190,()=>Host.Reconnect(),Host.Pairing!=null);
            panel.Button("Back",476,326,140,()=>{CloseModal();setup=false;dirty=true;},Host.Pairing!=null);
            panel.Label(Host.Status+(string.IsNullOrEmpty(notice)?"":"\n"+notice),24,391,790,145,22);
            panel.Label("Use the host's trusted setup screen. Never copy a fingerprint from an untrusted pairing endpoint. Tokens are encrypted with Android Keystore; raw audio retention is off.",24,548,790,100,19);
            panel.Button("Remove private pairing",24,645,300,()=>{CloseModal();Host.Forget();pairCode="";fingerprint="";dirty=true;},Host.Pairing!=null);
        }
        private void RenderReceiver(Receiver receiver, Space space)
        {
            var task=State.Snapshot.tasks.FirstOrDefault(t=>t.id==receiver?.taskId);
            var captured=Voice.Gate.Captured; var shown=captured??receiver;
            var shownTask=State.Snapshot.tasks.FirstOrDefault(t=>t.id==shown?.taskId); var shownSpace=State.Snapshot.spaces.FirstOrDefault(s=>s.id==shown?.spaceId);
            var panel=new WorldSurface(surfaces,"Visible receiver and speech controls",new Vector3(0,.62f,2.05f),0,1080,205);
            panel.Label((captured==null?"Receiver · ":"Recording receiver LOCKED · ") + (shown==null?"UNAVAILABLE — no turns will be routed":shownTask?.title ?? shownSpace?.name ?? shown.conversationId) + (shownTask==null?" · space conversation":" · task agent"),16,12,1040,37,24,new Color(.64f,.87f,.88f));
            panel.Label(Voice.Status + " · " + (Voice.Gate.CanCapture ? "ready" : "capture suppressed/off")+(captured==null?"":" · current selection "+(task?.title??space?.name)),16,51,1040,30,18);
            panel.Button("Mic off",16,88,112,Voice.Disable);
            panel.Button("Enable hands-free",136,88,215,()=>Voice.Enable(true),Host.Connected);
            panel.Button("Enable PTT",359,88,155,()=>Voice.Enable(false),Host.Connected);
            panel.Button("PTT: hold A",522,88,160,()=>{notice="Hold right-controller A after enabling PTT. Release to send. Hand users can use hands-free or Text.";dirty=true;});
            panel.Button("Text",690,88,95,()=>WriteTurn(),receiver!=null&&Host.Connected);
            panel.Button(Voice.SpokenReplies?"Replies off":"Enable spoken replies",793,88,265,()=>Voice.EnableSpokenReplies(!Voice.SpokenReplies),Host.Connected);
            panel.Button("Stop output",16,144,155,Voice.StopOutput);
            panel.Button("Clear task selection",179,144,225,()=>Navigate(State.ClearTask),task!=null);
            panel.Button(mr?"Switch to VR":"Switch to MR",412,144,200,SwitchMode,Passthrough!=null);
            panel.Button("Host setup",620,144,155,()=>{CloseModal();setup=true;dirty=true;});
            panel.Button("Refresh",783,144,140,()=>Host.Reconnect());
        }
        private void SwitchMode()
        {
            if(!mr&&!OVRManager.IsInsightPassthroughInitialized()){notice="Passthrough is unavailable or not initialized. Stay in VR; check device/OpenXR passthrough readiness, then retry MR.";dirty=true;return;}
            mr=!mr;Passthrough.enabled=mr;floor.SetActive(!mr);ViewCamera.backgroundColor=mr?Color.clear:new Color(.055f,.09f,.12f);dirty=true;
        }
        private void RenderBlocked(string title,string detail)
        { var panel=new WorldSurface(surfaces,title,new Vector3(0,1.35f,2.5f),0,740,330); panel.Label(title,20,20,700,50,30);panel.Label(detail,20,85,700,200); }
        internal void RenderNodes(Space space)
        {
            var children=State.Snapshot.spaces.Where(s=>s.parentId==space.id).ToArray();
            // Project roots may be linked to the Overview rather than assigned its parent.
            if(string.IsNullOrEmpty(space.projectId)) children=children.Concat(State.Snapshot.projects.Select(p=>State.Snapshot.spaces.FirstOrDefault(s=>s.id==p.rootSpaceId)).Where(s=>s!=null)).GroupBy(s=>s.id).Select(g=>g.First()).ToArray();
            var linked=State.Snapshot.links.Where(l=>l.fromId==space.id).Select(l=>State.Snapshot.spaces.FirstOrDefault(s=>s.id==l.toId)).Where(s=>s!=null);
            children=children.Concat(linked).GroupBy(s=>s.id).Select(g=>g.First()).ToArray();
            const int visible=50;
            for(int i=nodePage*visible;i<Math.Min(children.Length,(nodePage+1)*visible);i++)
            {
                var child=children[i];int local=i%visible,ring=local/20;float angle=((local%20)-9.5f)*18*Mathf.Deg2Rad;
                float radius=4.8f+ring*.8f;
                Vector3 position=new Vector3(Mathf.Sin(angle)*radius,2.05f+ring*.4f,Mathf.Cos(angle)*radius);
                if(child.position!=null && new Vector3(child.position.x,child.position.y,child.position.z).sqrMagnitude>.1f) position=new Vector3(child.position.x,child.position.y,child.position.z);
                var node=GameObject.CreatePrimitive(PrimitiveType.Sphere);node.name="Enter "+child.id;node.transform.SetParent(surfaces,false);node.transform.localPosition=position;node.transform.localScale=Vector3.one*.32f;node.GetComponent<Renderer>().sharedMaterial=nodeMaterial;
                node.AddComponent<SpatialTarget>().Activate=()=>Navigate(()=>State.Enter(child.id));
                var label=new WorldSurface(surfaces,"Open space identity",position+Vector3.down*.35f,Mathf.Atan2(position.x,position.z)*Mathf.Rad2Deg,300,110,false);
                label.Label(child.name,8,2,285,52,25);label.Button("Enter →",8,60,164,()=>Navigate(()=>State.Enter(child.id)));
                label.Button("Place",180,60,108,()=>{placementSpace=child;pointer.PlacementMode=true;notice="Aim and select this space's new position. Viewpoint will not move.";dirty=true;},Host.Connected);
            }
            if(children.Length>visible) {var page=new WorldSurface(surfaces,"Node pages",new Vector3(0,2.47f,3.2f),0,490,65);page.Button("Previous spaces",8,10,220,()=>{nodePage=Math.Max(0,nodePage-1);dirty=true;});page.Button("More spaces",240,10,220,()=>{nodePage=(nodePage+1)%((children.Length+visible-1)/visible);dirty=true;});}
        }
        internal void RenderTasks(Space space)
        {
            var tasks=State.Snapshot.tasks.Where(t=>t.spaceId==space.id).ToArray();
            var panel=new WorldSurface(surfaces,"Task window controls",new Vector3(-1.65f,.9f,2.45f),-32,540,200);
            panel.Label("Task windows · "+tasks.Length,16,16,510,40,26);
            panel.Button("Previous",16,73,165,()=>{taskPage=Math.Max(0,taskPage-1);dirty=true;});panel.Button("More",190,73,125,()=>{taskPage=(taskPage+1)%Math.Max(1,(tasks.Length+5)/6);dirty=true;});
            panel.Button("New task",324,73,200,CreateTask,Host.Connected);
            panel.Label(tasks.Length==0?"No tasks here. Request work deliberately in this space.":"Select a task window, not an application agent.",16,134,510,57,20);
            for(int i=taskPage*6;i<Math.Min(tasks.Length,(taskPage+1)*6);i++)
            {
                var task=tasks[i];if(task.id==State.Current.taskId)continue;
                var position=TaskPosition(task);var preview=new WorldSurface(surfaces,"Retained task window "+task.id,position,TaskYaw(task,position),470,260);
                preview.Root.transform.localRotation=TaskRotation(task,position);
                if(task.layout?.scale!=null)preview.Root.transform.localScale=Vector3.Scale(preview.Root.transform.localScale,new Vector3(task.layout.scale.x,task.layout.scale.y,task.layout.scale.z));
                preview.Label(task.title,16,16,436,55,27);preview.Label(task.state+" · "+(task.runId??"not admitted"),16,76,436,33,18,new Color(.64f,.87f,.88f));
                var message=MessagePresentation.Preview(State.Snapshot.conversations.FirstOrDefault(c=>c.id==task.conversationId)?.messages);
                preview.Label(message==null?task.detail:message.role+" · "+message.text,16,118,436,80,20);
                preview.Button("Activate task conversation →",16,204,436,()=>Navigate(()=>State.SelectTask(task.id)));
            }
        }
        private Vector3 TaskPosition(TaskWindow task)
        {
            if(task.layout?.position!=null)return new Vector3(task.layout.position.x,task.layout.position.y,task.layout.position.z);
            if(!defaultTaskSlots.TryGetValue(task.id,out int slot))
            {var used=new HashSet<int>(defaultTaskSlots.Where(pair=>State.Snapshot.tasks.Any(t=>t.id==pair.Key&&t.spaceId==task.spaceId)).Select(pair=>pair.Value));slot=0;while(used.Contains(slot))slot++;defaultTaskSlots[task.id]=slot;}
            float angle=((slot%6)-2.5f)*35*Mathf.Deg2Rad;float radius=3.8f+(slot/6)*.9f;
            return new Vector3(Mathf.Sin(angle)*radius,1.45f+(slot%2)*.12f,Mathf.Cos(angle)*radius);
        }
        private static float TaskYaw(TaskWindow task,Vector3 position)=>task.layout?.rotation!=null?task.layout.rotation.y:Mathf.Atan2(position.x,position.z)*Mathf.Rad2Deg;
        private static Quaternion TaskRotation(TaskWindow task,Vector3 position)=>task.layout?.rotation!=null?Quaternion.Euler(task.layout.rotation.x,task.layout.rotation.y,task.layout.rotation.z):Quaternion.Euler(0,TaskYaw(task,position),0);
        private void RenderConversation(Receiver receiver)
        {
            var task=State.Snapshot.tasks.FirstOrDefault(t=>t.id==receiver?.taskId);
            Vector3 position=new Vector3(0,1.37f,2.4f);float yaw=0;Vector3 scale=Vector3.one;
            if(task!=null){position=TaskPosition(task);yaw=TaskYaw(task,position);}
            if(task?.layout?.scale!=null)scale=new Vector3(task.layout.scale.x,task.layout.scale.y,task.layout.scale.z);
            var panel=new WorldSurface(surfaces,"Task-owned conversation",position,yaw,790,530);panel.Root.transform.localScale=Vector3.Scale(panel.Root.transform.localScale,scale);
            if(task!=null)panel.Root.transform.localRotation=TaskRotation(task,position);
            var conversation=State.Snapshot.conversations.FirstOrDefault(c=>c.id==receiver?.conversationId);
            panel.Label(task?.title??"Space conversation",18,16,750,45,28);
            panel.Label(task==null?(conversation==null?"Conversation unavailable":conversation.runtime+" · "+conversation.model+" · "+conversation.effort):task.state+" · run "+(task.runId??"not admitted")+"\n"+task.detail,18,66,750,65,18);
            var messages=history!=null&&historyConversation==receiver?.conversationId?history.messages:conversation?.messages;
            string transcript=messages==null?"No retained conversation loaded. Refresh or check host readiness.":messages.Length==0?"No messages yet. Entering a space does not start agent work.":string.Join("\n\n",messages.TakeLast(6).Select(m=>MessagePresentation.Author(m)+" · "+m.state+"\n"+m.text));
            panel.Label(transcript,18,139,750,273,21);
            panel.Button("Write turn",18,431,160,WriteTurn,receiver!=null&&Host.Connected);
            panel.Button("Older history",186,431,175,LoadHistory,receiver!=null&&Host.Connected);
            panel.Button("Model settings",369,431,190,ModelSettings,receiver!=null&&Host.Connected);
            panel.Button(task==null?"Readiness":"Place window",567,431,200,task==null?(Action)ShowReadiness:()=>{placementSpace=null;pointer.PlacementMode=true;notice="Aim and select a place for this task conversation. Viewpoint will not move.";dirty=true;});
            panel.Button("Retry failed turn",18,482,220,RetryTurn,failedTurn!=null);
            panel.Button("Read full retained text",250,482,290,()=>InspectText("Retained conversation",messages==null?"No retained messages loaded.":string.Join("\n\n",messages.Select(m=>MessagePresentation.Author(m)+" · "+m.state+" · "+m.createdAt+"\n"+m.text))));
            panel.Button("Latest history",552,482,215,()=>{history=null;historyConversation=null;dirty=true;});
        }
        private void RenderSpaceActions(Space space)
        {
            var panel=new WorldSurface(surfaces,"Space organization",new Vector3(1.85f,1.5f,2.55f),32,600,420);
            panel.Label("This space",18,18,565,40,26);panel.Label(space.purpose,18,68,565,100,21);
            panel.Button("Create child space",18,180,275,()=>CreateSpace(space));panel.Button("Edit name / purpose",305,180,277,()=>EditSpace(space));
            panel.Button("Move to another space",18,236,275,()=>ChooseDestination(space,true));
            panel.Button("Connect another space",305,236,277,()=>ChooseDestination(space,false));
            panel.Button("Register project",18,292,275,CreateProject);panel.Button("Host readiness",305,292,277,ShowReadiness);
            panel.Button("Registered context sources",18,350,335,()=>StartCoroutine(ReadSources(space.id)),Host.Connected);
            panel.Button("Connections",365,350,217,()=>InspectConnections(space));
        }
        private void ChooseDestination(Space space,bool move,int page=0)
        {
            var choices=Organization.Destinations(State.Snapshot,space,move);int pages=Math.Max(1,(choices.Length+5)/6);page=Mathf.Clamp(page,0,pages-1);
            CloseModal();var modal=new WorldSurface(modalSurfaces,"Choose observed destination",new Vector3(0,1.4f,1.65f),0,880,550);
            modal.Label((move?"Move ":"Connect ")+space.name+" · "+(page+1)+" / "+pages,20,18,840,65,28);
            if(choices.Length==0)modal.Label(move?"No valid parent here. Overview and project roots stay fixed; child spaces can move within their project, never into their descendants.":"No other spaces are registered. Create a project or child space first.",20,110,840,210);
            for(int i=page*6;i<Math.Min(choices.Length,(page+1)*6);i++)
            {
                var destination=choices[i];
                modal.Button(destination.name+" · "+destination.id,20,100+(i%6)*55,840,()=>{
                    Destroy(modal.Root);
                    if(move)Command("PATCH","/v1/spaces/"+HostClient.Id(space.id),new Dictionary<string,object>{{"parentId",destination.id}});
                    else Command("POST","/v1/links",new LinkRequest{fromId=space.id,toId=destination.id,label=""});
                },Host.Connected);
            }
            modal.Button("Previous",20,455,200,()=>{Destroy(modal.Root);ChooseDestination(space,move,page-1);},page>0);
            modal.Button("Next",234,455,200,()=>{Destroy(modal.Root);ChooseDestination(space,move,page+1);},page<pages-1);
            modal.Button("Cancel",448,455,200,CloseModal);
        }
        private void InspectConnections(Space space,int page=0)
        {
            var links=State.Snapshot.links.Where(l=>l.fromId==space.id).ToArray();int pages=Math.Max(1,(links.Length+4)/5);page=Mathf.Clamp(page,0,pages-1);
            CloseModal();var modal=new WorldSurface(modalSurfaces,"Observed connections",new Vector3(0,1.4f,1.65f),0,900,570);
            modal.Label("Connections · "+space.name,20,18,860,65,28);
            if(links.Length==0)modal.Label("No connections. Connect another registered space without moving it.",20,108,860,100);
            for(int i=page*5;i<Math.Min(links.Length,(page+1)*5);i++)
            {
                var link=links[i];var destination=State.Snapshot.spaces.FirstOrDefault(s=>s.id==link.toId);
                modal.Label(destination?.name??link.toId,20,100+(i%5)*65,600,60);
                modal.Button("Disconnect",635,100+(i%5)*65,240,()=>Command("POST","/v1/archive/link/"+HostClient.Id(link.id),new Dictionary<string,object>()),Host.Connected);
            }
            modal.Button("Previous",20,470,200,()=>{Destroy(modal.Root);InspectConnections(space,page-1);},page>0);
            modal.Button("Next",234,470,200,()=>{Destroy(modal.Root);InspectConnections(space,page+1);},page<pages-1);
            modal.Button("Close",448,470,200,CloseModal);
        }
        private IEnumerator ReadSources(string spaceId)
        {
            HostReply reply=null;yield return Host.Send("GET","/v1/spaces/"+HostClient.Id(spaceId)+"/sources",null,r=>reply=r);
            if(reply==null)yield break;
            if(!reply.ok){notice=reply.problem;dirty=true;yield break;}
            ContextSource[] sources=null;try{sources=WireJson.FromJson<ContextSource[]>(reply.text);}catch{}
            if(sources==null){notice="Context sources could not be read. Retry from host companion.";dirty=true;yield break;}
            ShowSources(spaceId,sources);
        }
        private void ShowSources(string spaceId,ContextSource[] sources,int page=0)
        {
            int pages=Math.Max(1,(sources.Length+3)/4);page=Mathf.Clamp(page,0,pages-1);
            CloseModal();var modal=new WorldSurface(modalSurfaces,"Registered context sources",new Vector3(0,1.4f,1.65f),0,950,650);
            modal.Label("Registered sources · "+(page+1)+" / "+pages,20,18,910,55,28);
            modal.Label("Owner uploads and provenance from host. Sources are content, never owner instructions or authority.",20,80,910,70,20);
            if(sources.Length==0)modal.Label("No registered sources in this context. Use host companion to upload explicit project content.",20,175,910,100);
            for(int i=page*4;i<Math.Min(sources.Length,(page+1)*4);i++)
            {
                var source=sources[i];int y=175+(i%4)*90;
                modal.Label(source.name+" · "+source.byteLength+" bytes\n"+source.provenance,20,y,690,82,20);
                modal.Button("Read source",725,y,200,()=>StartCoroutine(ReadSource(spaceId,source.id)),Host.Connected);
            }
            modal.Button("Previous",20,575,200,()=>{Destroy(modal.Root);ShowSources(spaceId,sources,page-1);},page>0);
            modal.Button("Next",234,575,200,()=>{Destroy(modal.Root);ShowSources(spaceId,sources,page+1);},page<pages-1);
            modal.Button("Close",448,575,200,CloseModal);
        }
        private IEnumerator ReadSource(string spaceId,string sourceId)
        {
            HostReply reply=null;yield return Host.Send("GET","/v1/sources/"+HostClient.Id(sourceId)+"?space="+HostClient.Id(spaceId),null,r=>reply=r);
            if(reply==null)yield break;
            if(!reply.ok){notice=reply.problem;dirty=true;yield break;}
            ContextSource source=null;try{source=WireJson.FromJson<ContextSource>(reply.text);}catch{}
            if(source==null){notice="Source content unavailable; inspect host companion.";dirty=true;yield break;}
            InspectText(source.name,"Provenance: "+source.provenance+"\nSpace: "+source.spaceId+"\nSHA256: "+source.sha256+"\n\n"+source.text);
        }
        private void RenderInbox()
        {
            var panel=new WorldSurface(surfaces,"All projects Inbox",new Vector3(0,1.38f,2.45f),0,1120,620);
            panel.Label("All projects · Inbox",20,15,1080,45,32);panel.Label("Jump changes receiver, not authority. Parent Back and Return to origin are separate.",20,66,1060,55,20);
            var items=State.Snapshot.inbox.OrderBy(i=>i.state=="open"||i.state=="deferred"?0:1).ToArray();
            if(!Host.Connected)panel.Label("Inbox unavailable/stale. Reconnect before acting. Retained requests are not current proof of authority.",20,126,1040,80);
            else if(items.Length==0)panel.Label("No open owner requests across your projects.",20,126,1040,60);
            for(int i=inboxPage*4;i<Math.Min(items.Length,(inboxPage+1)*4);i++)
            {
                var item=items[i];int y=128+(i%4)*97;
                panel.Label(item.kind+" · "+item.state+" · "+item.title+"\n"+item.spaceId+(string.IsNullOrEmpty(item.taskId)?"":" / "+item.taskId)+" · version "+item.version,20,y,820,85,22);
                panel.Button("Jump →",870,y,220,()=>Navigate(()=>State.Jump(item)),Host.Connected&&(item.state=="open"||item.state=="deferred"));
                panel.Button("Inspect / respond",870,y+47,220,()=>InspectInbox(item));
            }
            panel.Button("Previous",20,546,165,()=>{inboxPage=Math.Max(0,inboxPage-1);dirty=true;});panel.Button("More",196,546,130,()=>{inboxPage=(inboxPage+1)%Math.Max(1,(items.Length+3)/4);dirty=true;});panel.Button("Close Inbox",340,546,180,()=>Navigate(State.CloseInbox));
        }
        internal void InspectInbox(InboxRequest item)
        {
            InspectText(item.kind+" · version "+item.version,
                "Request: "+item.id+"\nState: "+item.state+"\nDestination: "+item.spaceId+" / "+item.taskId+"\nTitle: "+item.title+"\n\n"+item.detail+"\n\nEvidence:\n"+string.Join("\n\n",item.evidence)+(item.disposition==null?"":"\n\nOwner choice:\n"+WireJson.ToJson(item.disposition)),
                0,item.state=="open"||item.state=="deferred"?(Action)(()=>InboxDecision(item)):null);
        }
        [Serializable] private sealed class ReviewEvidence { public string source; public ReviewDisposition disposition; }
        [Serializable] private sealed class ReviewDisposition { public string state, reason; }
        private static string ObsoleteReviewReason(InboxRequest item)
        {
            if(item.kind!="review")return null;
            foreach(var value in item.evidence)try{var source=WireJson.FromJson<ReviewEvidence>(value);if(source?.source=="coordinator-interactive"&&source.disposition?.state=="obsolete")return source.disposition.reason??"A newer attempt superseded this review.";}catch{}
            return null;
        }
        private void InboxDecision(InboxRequest item)
        {
            CloseModal();var modal=new WorldSurface(modalSurfaces,"Current request decision",new Vector3(.2f,1.4f,1.7f),0,900,650);
            modal.Label("Request "+item.id+" · version "+item.version,20,16,860,70,22);
            var obsolete=ObsoleteReviewReason(item);
            modal.Label(obsolete==null?"Answer/review retains your choice; no new execution starts. Confirm existing authority is not a grant. Jump to the task and send a new follow-up when ready.":"Obsolete review: "+obsolete,20,105,860,150,22);
            modal.Button("Read complete evidence",20,290,320,()=>InspectInbox(item));
            string action=item.kind=="approval"?"approve":item.kind=="review"?"review":"answer";
            modal.Button(item.kind=="approval"?"Confirm existing authority":"Explicitly "+action,20,380,360,()=>{if(item.kind=="approval")Edit("Existing authority receipt ID","",receipt=>Edit("Exact receipt version","",value=>{if(!int.TryParse(value,out var version)||version<1){notice="Enter the current existing receipt version; nothing was confirmed.";dirty=true;return;}Command("POST","/v1/inbox/"+HostClient.Id(item.id)+"/respond",new InboxResponse{version=item.version,action=action,text="",authorityId=receipt,authorityVersion=version});}));else Edit("Owner response / reason","",value=>Command("POST","/v1/inbox/"+HostClient.Id(item.id)+"/respond",new InboxResponse{version=item.version,action=action,text=value}));},Host.Connected&&obsolete==null);
            modal.Button("Defer",395,380,180,()=>Command("POST","/v1/inbox/"+HostClient.Id(item.id)+"/respond",new InboxResponse{version=item.version,action="defer",text=""}));
            modal.Button("Dismiss / obsolete",20,447,280,()=>Edit("Why this request is obsolete / withdrawn","",value=>Command("POST","/v1/inbox/"+HostClient.Id(item.id)+"/respond",new InboxResponse{version=item.version,action="dismiss",text=value})));
            modal.Label("Dismiss only closes this request. It never grants, cancels work, releases reservations or marks an attempt reviewed.",20,501,860,75,19);
            modal.Button("Close",590,380,170,CloseModal);
        }
        private void RenderTools(TaskWindow task)
        {
            var taskPosition=TaskPosition(task);float taskYaw=TaskYaw(task,taskPosition);
            var panel=new WorldSurface(surfaces,"Task application views",taskPosition+TaskRotation(task,taskPosition)*new Vector3(1.75f,.05f,.45f),taskYaw+25,900,680);
            panel.Root.transform.localRotation=TaskRotation(task,taskPosition)*Quaternion.Euler(0,25,0);
            if(task.layout?.scale!=null)panel.Root.transform.localScale=Vector3.Scale(panel.Root.transform.localScale,new Vector3(task.layout.scale.x,task.layout.scale.y,task.layout.scale.z));
            panel.Label("Applications · same task agent",18,14,865,40,26);
            var views=State.Snapshot.views.Where(v=>v.taskId==task.id).ToArray();
            for(int i=0;i<Math.Min(views.Length,4);i++){var view=views[i];panel.Button(view.title+(view.available?"":" · unavailable"),18+i*218,66,208,()=>{CloseModal();State.SelectView(view.id);dirty=true;});}
            var active=views.FirstOrDefault(v=>v.id==State.Current.viewId);
            if(active==null){panel.Label(views.Length==0?"No tool views published. Host needs a bounded task environment; personal desktop is never used as a fallback.":"Select an application view. Selection keeps this task's receiver.",18,137,865,200);StopStream();}
            else if(!active.available){panel.Label("Unavailable · "+active.detail+"\nConfigure the supported environment on host setup.",18,137,865,200);StopStream();}
            else
            {
                if(streamView!=active.id){StopStream();streamView=active.id;frame=null;frameProblem=null;streaming=StartCoroutine(Stream(task.id,active.id));}
                if(texture!=null&&FrameFence.Matches(task,active,frame))
                {
                    float width=864,height=Math.Min(330,864f*texture.height/texture.width); width=height*texture.width/texture.height;
                    frameImage=panel.Frame(texture,18,136,width,height,FrameFence.CanInput(task,active,frame,lease)?(Action<Vector2>)(point=>SendPointer(point)):null);
                }
                else panel.Label(frameProblem??"Waiting for actual generation-bound frame. No placeholder input is enabled.",18,136,865,300,22);
                string age=frame==null?"no frame": "frame "+frame.sequence+" · generation "+frame.generation+" · captured "+frame.capturedAt;
                frameStatusLabel=panel.Label(age+"\n"+(lease==null?"No acknowledged owner control":lease.owner+" · epoch "+lease.epoch+" · "+lease.detail),18,477,865,75,18);
            }
            bool needsReset=lease?.taskId==task.id&&FrameFence.RequiresConfirmation(lease);
            panel.Button(needsReset?"Review restart…":"Take control",18,565,175,()=>{if(needsReset)ConfirmTakeover(task,pendingControlAction??"take",lease.epoch);else Control(task,"take");},Host.Connected&&!controlPending);
            panel.Button("Resume agent",201,565,180,()=>Control(task,"resume"),Host.Connected&&!controlPending);
            panel.Button("Tool text input",389,565,180,WriteToolText,active!=null&&FrameFence.CanInput(task,active,frame,lease));
            panel.Button("Interrupt turn",577,565,145,()=>Command("POST","/v1/tasks/"+HostClient.Id(task.id)+"/interrupt",new InterruptRequest{mode="turn"}));
            panel.Button("Cancel task",730,565,148,()=>Command("POST","/v1/tasks/"+HostClient.Id(task.id)+"/interrupt",new InterruptRequest{mode="task"}));
            bool inputAllowed=active!=null&&FrameFence.CanInput(task,active,frame,lease)&&Host.Connected;
            panel.Button("Enter key",18,615,135,()=>ToolInput("key",Vector2.zero,"","Return"),inputAllowed);
            panel.Button("Backspace",161,615,145,()=>ToolInput("key",Vector2.zero,"","BackSpace"),inputAllowed);
            panel.Button("Esc",314,615,85,()=>ToolInput("key",Vector2.zero,"","Escape"),inputAllowed);
            panel.Button("Terminal text",407,615,200,()=>ReadTerminal(task.id),active?.kind=="terminal"&&Host.Connected);
            panel.Button("Frame / control identity",616,615,264,()=>InspectText("Observed task / frame / control",WireJson.ToJson(new { taskId=task.id,environmentId=task.environmentId,view=active,frame,lease }) ));
        }
        private IEnumerator Stream(string taskId,string viewId)
        {
            while(streamView==viewId&&foreground)
            {
                var task=State.Snapshot.tasks.FirstOrDefault(t=>t.id==taskId);var view=State.Snapshot.views.FirstOrDefault(v=>v.id==viewId&&v.taskId==taskId);
                if(task==null||view==null||!view.available)yield break;
                HostReply reply=null;yield return Host.Send("GET","/v1/tasks/"+HostClient.Id(taskId)+"/frame?view="+HostClient.Id(viewId),null,r=>reply=r);
                if(reply==null||streamView!=viewId)yield break;
                if(!reply.ok){frameProblem=reply.problem;frame=null;dirty=true;yield return new WaitForSecondsRealtime(2);continue;}
                {
                    FrameIdentity candidate=null;try{candidate=WireJson.FromJson<FrameIdentity>(reply.frame??"");}catch{}
                    // Recheck against the latest snapshot, not the one before the request.
                    task=State.Snapshot.tasks.FirstOrDefault(t=>t.id==taskId);view=State.Snapshot.views.FirstOrDefault(v=>v.id==viewId&&v.taskId==taskId);
                    if(!FrameFence.Matches(task,view,candidate)||(frame!=null&&candidate.sequence<=frame.sequence)){frameProblem="Frame identity missing, changed or stale. Refresh this view; input stays disabled.";frame=null;dirty=true;}
                    else
                    {
                        var next=new Texture2D(2,2,TextureFormat.RGB24,false);
                        if(!next.LoadImage(reply.bytes)||next.width!=candidate.width||next.height!=candidate.height){Destroy(next);frame=null;frameProblem="Frame bytes do not match identity. Check host stream.";dirty=true;}
                        else
                        {
                            bool rebuild=frameImage==null||frame==null||frame.leaseEpoch!=candidate.leaseEpoch||frame.generation!=candidate.generation||frame.width!=candidate.width||frame.height!=candidate.height;
                            if(texture!=null)Destroy(texture);texture=next;frame=candidate;frameProblem=null;if(frameImage!=null)frameImage.texture=texture;
                            if(frameStatusLabel!=null)frameStatusLabel.text="frame "+frame.sequence+" · generation "+frame.generation+" · captured "+frame.capturedAt+"\n"+(lease==null?"No acknowledged owner control":lease.owner+" · epoch "+lease.epoch+" · "+lease.detail);
                            if(rebuild)dirty=true;
                        }
                    }
                }
                yield return new WaitForSecondsRealtime(.35f);
            }
        }
        private void StopStream(){if(streaming!=null)StopCoroutine(streaming);streaming=null;streamView=null;frame=null;if(texture!=null)Destroy(texture);texture=null;}
        private void SendPointer(Vector2 point) => ToolInput("pointer",point,"","");
        private void WriteToolText()
        {
            var task=State.Snapshot.tasks.FirstOrDefault(t=>t.id==State.Current.taskId);var view=State.Snapshot.views.FirstOrDefault(v=>v.id==State.Current.viewId);
            if(!FrameFence.CanInput(task,view,frame,lease))return;
            var input=new TaskInput{taskId=task.id,environmentId=frame.environmentId,viewId=frame.viewId,generation=frame.generation,leaseEpoch=lease.epoch,kind="text",button="",key=""};
            Edit("Input to captured task / view","",value=>{input.text=value;Command("POST","/v1/tasks/"+HostClient.Id(input.taskId)+"/input",input);});
        }
        private void ToolInput(string kind,Vector2 point,string text,string key)
        {
            var task=State.Snapshot.tasks.FirstOrDefault(t=>t.id==State.Current.taskId);var view=State.Snapshot.views.FirstOrDefault(v=>v.id==State.Current.viewId);
            if(!Host.Connected||!FrameFence.CanInput(task,view,frame,lease)){notice="Input blocked: current frame and acknowledged control lease must match this task/environment.";dirty=true;return;}
            Command("POST","/v1/tasks/"+HostClient.Id(task.id)+"/input",new TaskInput{taskId=task.id,environmentId=frame.environmentId,viewId=frame.viewId,generation=frame.generation,leaseEpoch=lease.epoch,kind=kind,x=kind=="pointer"?FrameFence.Pixel(point.x,frame.width):0,y=kind=="pointer"?FrameFence.Pixel(point.y,frame.height):0,button=kind=="pointer"?"left":"",text=text,key=key});
        }
        private void Control(TaskWindow task,string action)=>StartCoroutine(ControlRoutine(task,action));
        private void ConfirmTakeover(TaskWindow task,string action,long epoch)
        {
            CloseModal();var modal=new WorldSurface(modalSurfaces,"Explicit workload restart confirmation",new Vector3(0,1.4f,1.65f),0,950,440);
            modal.Label("Restart workload to "+(action=="resume"?"resume agent?":"take control?"),20,18,910,65,30);
            modal.Label("This closes this task's applications, terminals and workload processes. UNSAVED CHANGES MAY BE LOST.\n\nNo owner input is enabled yet. Cancel leaves takeover unconfirmed; use host recovery/save/export before choosing restart if needed.",20,100,910,205,23);
            modal.Button("Confirm restart and "+(action=="resume"?"resume agent":"take control"),20,340,510,()=>StartCoroutine(ControlRoutine(task,action,true,epoch)));
            modal.Button("Cancel — do not restart",545,340,370,()=>{CloseModal();notice="Takeover restart was not confirmed. Input remains blocked until a truthful host acknowledgment.";dirty=true;});
        }
        private IEnumerator ControlRoutine(TaskWindow task,string action,bool confirmReset=false,long? expectedEpoch=null)
        {
            if(controlPending||!Host.Connected)yield break;
            CloseModal();controlPending=true;lease=null;pendingControlAction=action;dirty=true;
            try
            {
                long epoch;
                if(confirmReset&&expectedEpoch.HasValue)epoch=expectedEpoch.Value;
                else
                {
                    HostReply current=null;
                    yield return Host.Send("GET","/v1/tasks/"+HostClient.Id(task.id)+"/control",null,r=>current=r);
                    if(current==null)yield break;
                    ControlLease observed=null;
                    if(current.ok)try{observed=WireJson.FromJson<ControlLease>(current.text);}catch{}
                    if(!current.ok||!ControlRecovery.Valid(task.id,observed))
                    {notice=current.ok?"No valid current lease was returned. Check host environment recovery; no control request was sent.":current.problem;yield break;}
                    epoch=observed.epoch;
                    if(State.Current.taskId!=task.id){notice="Task selection changed while reading its lease. No control request was sent.";yield break;}
                }
                HostReply reply=null;yield return Host.Send("POST","/v1/tasks/"+HostClient.Id(task.id)+"/control",WireJson.ToJson(new ControlRequest{action=action,expectedEpoch=epoch,confirmReset=confirmReset}),r=>reply=r);
                if(reply==null)yield break;
                if(!reply.ok)notice=reply.problem;
                else
                {
                    ControlLease observed=null;try{observed=WireJson.FromJson<ControlLease>(reply.text);}catch{}
                    if(State.Current.taskId==task.id&&ControlRecovery.Valid(task.id,observed))lease=observed;
                    notice=ControlRecovery.Valid(task.id,observed)?observed.detail:"No valid control acknowledgment. Input remains blocked.";
                    StartCoroutine(RefreshObservedSnapshot());
                }
            }
            finally{controlPending=false;dirty=true;}
        }
        private IEnumerator RefreshObservedSnapshot()
        {
            HostReply reply=null;yield return Host.Send("GET","/v1/snapshot",null,r=>reply=r);
            if(reply==null)yield break;
            if(!reply.ok){notice=reply.problem;dirty=true;yield break;}
            try{OnSnapshot(WireJson.FromJson<Snapshot>(reply.text));}
            catch{notice="Could not refresh current environment/view generation. Input remains fenced; reconnect host setup.";dirty=true;}
        }
        private void PlaceWindow(Vector3 world)
        {
            var task=State.Snapshot.tasks.FirstOrDefault(t=>t.id==State.Current.taskId);
            if(task==null&&placementSpace==null)return;
            var position=anchor.InverseTransformPoint(world);if(position.magnitude<.7f){notice="Window is too close. Select a place at least 0.7 m away.";dirty=true;return;}
            if(placementSpace!=null){var space=placementSpace;placementSpace=null;Command("PATCH","/v1/spaces/"+HostClient.Id(space.id),new Dictionary<string,object>{{"position",new Point{x=position.x,y=position.y,z=position.z}}});return;}
            var yaw=Mathf.Atan2(position.x,position.z)*Mathf.Rad2Deg;
            Command("PATCH","/v1/tasks/"+HostClient.Id(task.id)+"/layout",new WindowLayout{position=new Point{x=position.x,y=position.y,z=position.z},rotation=new Point{y=yaw},scale=new Point{x=1,y=1,z=1}});
        }
        private void WriteTurn()
        {
            var receiver=State.Receiver?.Copy();if(receiver==null)return;
            Edit("Message to captured receiver","",text=>{if(OwnerIntent.OpenGlobalInbox(text)){Navigate(State.OpenInbox);return;}if(!string.IsNullOrWhiteSpace(text))StartCoroutine(SubmitTurn(new TurnRequest{idempotencyKey=Guid.NewGuid().ToString("N"),receiver=receiver,text=text}));});
        }
        private IEnumerator SubmitTurn(TurnRequest request)
        {
            failedTurn=request;HostReply reply=null;yield return Host.Send("POST","/v1/turns",WireJson.ToJson(request),r=>reply=r);
            if(reply==null)yield break;
            if(reply.ok)
            {
                var ack=WireJson.FromJson<TurnAck>(reply.text);
                if(ack==null||ack.conversationId!=request.receiver.conversationId||ack.taskId!=request.receiver.taskId||string.IsNullOrEmpty(ack.requestId))notice="Host acknowledgment does not match the captured receiver. Do not repeat uncertain work; inspect host recovery records.";
                else{if(failedTurn==request)failedTurn=null;notice=ack.state+" · "+ack.detail+"\nRequest "+ack.requestId+" · conversation "+ack.conversationId;}
            }
            else notice=reply.problem;dirty=true;
        }
        private IEnumerator SubmitVoice(VoiceRequest request)
        {
            HostReply reply=null;yield return Host.Send("POST","/v1/voice",WireJson.ToJson(request),r=>reply=r);
            // Raw audio is not retained on disk or across failed operations.
            request.wavBase64=null;
            if(reply==null)yield break;
            if(reply.ok)ObserveVoiceAck(request,WireJson.FromJson<TurnAck>(reply.text));
            else{notice=reply.problem+"\nAudio was discarded. Use Text for a deliberate recovery turn; do not blindly repeat uncertain work.";}dirty=true;
        }
        internal void ObserveVoiceAck(VoiceRequest request,TurnAck ack)
        {
            bool sameReceiver=ack!=null&&ack.conversationId==request.receiver.conversationId&&ack.taskId==request.receiver.taskId;
            notice=!sameReceiver?"Speech acknowledgment has a different receiver. Inspect host recovery; do not repeat uncertain work.":ack.state+" · "+ack.detail+"\n"+(string.IsNullOrEmpty(ack.transcript)?"":"Transcript: "+ack.transcript+"\n")+"Request "+ack.requestId;
            if(sameReceiver&&ack.state=="local-command"&&ack.detail=="open-global-inbox")Navigate(State.OpenInbox);
        }
        private void RetryTurn(){if(failedTurn!=null)StartCoroutine(SubmitTurn(failedTurn));}
        private IEnumerator ReplySpeech(string messageId,Receiver receiver)
        {
            if(!Voice.SpokenReplies||!receiver.Same(State.Receiver))yield break;
            HostReply reply=null;yield return Host.Send("GET","/v1/speech/"+HostClient.Id(messageId),null,r=>reply=r);
            if(reply==null)yield break;
            if(reply.ok)Voice.Play(reply.bytes,receiver);else{notice=reply.problem+"\nRead the retained text reply.";dirty=true;}
        }
        private void ReadTerminal(string taskId)=>StartCoroutine(TerminalRoutine(taskId));
        private IEnumerator TerminalRoutine(string taskId)
        {
            HostReply reply=null;yield return Host.Send("GET","/v1/tasks/"+HostClient.Id(taskId)+"/terminal",null,r=>reply=r);
            if(reply==null)yield break;
            if(reply.ok)InspectText("Actual task terminal output",reply.text??"No terminal text returned.");else{notice=reply.problem;dirty=true;}
        }
        private void LoadHistory()
        {
            var id=State.Receiver?.conversationId;if(id==null)return;StartCoroutine(HistoryRoutine(id));
        }
        private IEnumerator HistoryRoutine(string id)
        {
            string before=historyConversation==id?history?.nextBefore:null;
            if(historyConversation==id&&history!=null&&string.IsNullOrEmpty(before)){notice="You reached the oldest retained messages. Choose Latest history to return.";dirty=true;yield break;}
            if(before==null)before=State.Snapshot.conversations.FirstOrDefault(c=>c.id==id)?.messages.FirstOrDefault()?.id;
            HostReply reply=null;
            yield return Host.Send("GET","/v1/conversations/"+HostClient.Id(id)+"/messages"+(string.IsNullOrEmpty(before)?"":"?before="+HostClient.Id(before)),null,r=>reply=r);
            if(reply==null)yield break;
            if(reply.ok){history=WireJson.FromJson<HistoryPage>(reply.text);historyConversation=id;}else notice=reply.problem;dirty=true;
        }
        private void ModelSettings()
        {
            var receiver=State.Receiver?.Copy();if(receiver==null)return;var current=State.Snapshot.conversations.FirstOrDefault(c=>c.id==receiver.conversationId);
            Edit("Runtime ID",current?.runtime,runtime=>Edit("Model ID",current?.model,model=>Edit("Effort",current?.effort,effort=>Command("PATCH","/v1/conversations/"+HostClient.Id(receiver.conversationId)+"/settings",new ConversationSettings{runtime=runtime,model=model,effort=effort}))));
        }
        private void CreateTask()
        {
            var receiver=State.Receiver?.Copy();if(receiver==null)return;var conversation=State.Snapshot.conversations.FirstOrDefault(c=>c.id==receiver.conversationId);
            Edit("Task title","",title=>Edit("Task prompt","",prompt=>Command("POST","/v1/tasks",new TaskRequest{idempotencyKey=Guid.NewGuid().ToString("N"),spaceId=receiver.spaceId,title=title,prompt=prompt,runtime=conversation?.runtime,model=conversation?.model,effort=conversation?.effort})));
        }
        private void CreateProject()=>Edit("Project name","",name=>Edit("Purpose","",purpose=>Command("POST","/v1/projects",new ProjectRequest{name=name,purpose=purpose})));
        private void CreateSpace(Space parent)=>Edit("Child space name","",name=>Edit("Purpose","",purpose=>Command("POST","/v1/spaces",new SpaceRequest{projectId=parent.projectId,parentId=parent.id,name=name,purpose=purpose,position=new Point()})));
        private void EditSpace(Space space)=>Edit("Name",space.name,name=>Edit("Purpose",space.purpose,purpose=>Command("PATCH",Organization.EditRoute(State.Snapshot,space),new Dictionary<string,object>{{"name",name},{"purpose",purpose}})));
        private void ShowReadiness()=>InspectText("Host readiness",State.Snapshot.readiness.Length==0?"Host has not published readiness. Check host setup.":string.Join("\n\n",State.Snapshot.readiness.Select(r=>r.id+" · "+r.state+"\n"+r.detail)));
        internal void InspectText(string title,string text,int page=0,Action continuation=null)
        {
            var chunks=TextPages.Split(text);int pages=chunks.Length;page=Mathf.Clamp(page,0,pages-1);
            CloseModal();var modal=new WorldSurface(modalSurfaces,"Retained detail",new Vector3(0,1.4f,1.65f),0,940,670);
            modal.Label(title+" · page "+(page+1)+" / "+pages,20,18,900,60,27);
            modal.Label(chunks[page],20,92,900,470,22);
            modal.Button("Previous",20,590,200,()=>InspectText(title,text,page-1,continuation),page>0);
            modal.Button("Next",234,590,200,()=>InspectText(title,text,page+1,continuation),page<pages-1);
            modal.Button("Close",448,590,200,CloseModal);
            if(continuation!=null)modal.Button("Decision",662,590,200,continuation,page==pages-1);
        }
        internal void CloseModal()
        {
            CancelEdit();
            if(modalSurfaces==null)return;
            foreach(Transform child in modalSurfaces){child.gameObject.SetActive(false);Destroy(child.gameObject);}
        }
        private void Edit(string prompt,string initial,Action<string> accept,bool secure=false)
        {
            CloseModal(); placementSpace=null;pointer.PlacementMode=false;
            textEntry=new SpatialTextEntry(initial,secure);acceptText=accept;keyboardOwnsInput=true;
            Voice.SetSession(false);
            keyboard=new SpatialKeyboard(modalSurfaces,prompt,textEntry,()=>FinishEdit(prompt),CloseModal);
            BlockEditorBackground();
        }
        private void BlockEditorBackground()
        {
            // A snapshot may replace the workspace surfaces while the separate editor stays alive.
            editorBlockedColliders.RemoveAll(collider=>collider==null);
            foreach(var collider in surfaces.GetComponentsInChildren<Collider>())
                if(collider.enabled){editorBlockedColliders.Add(collider);collider.enabled=false;}
        }
        private void FinishEdit(string prompt)
        {
            if(textEntry==null||!textEntry.Finish(out var value))return;
            var accept=acceptText;
            // Release the old draft, targets and callback before a chained field can open.
            CancelEdit();notice="Updated · "+prompt;dirty=true;
            accept?.Invoke(value);
        }
        private void CancelEdit()
        {
            textEntry?.Cancel();textEntry=null;acceptText=null;
            keyboard?.Dispose();keyboard=null;keyboardOwnsInput=false;
            foreach(var collider in editorBlockedColliders)if(collider!=null)collider.enabled=true;
            editorBlockedColliders.Clear();
            if(Voice!=null)Voice.SetSession(OwnsListeningSession());
        }
        private void Command(string method,string route,object body){CloseModal();StartCoroutine(CommandRoutine(method,route,WireJson.ToJson(body)));}
        private IEnumerator CommandRoutine(string method,string route,string body)
        {
            HostReply reply=null;yield return Host.Send(method,route,body,r=>reply=r);if(reply==null)yield break;notice=reply.ok?(route.Contains("/inbox/")&&body.Contains("\"action\":\"answer\"")?"Answer retained; no new execution started. Jump to the task and send a follow-up.":"Host acknowledged the request. Observed task/Inbox state remains authoritative."):reply.problem;dirty=true;
        }
        private IEnumerator Telemetry()
        {
            while(true){yield return new WaitForSecondsRealtime(30);if(!Host.Connected||!foreground)continue;
                HostReply reply=null;yield return Host.Send("POST","/v1/telemetry",WireJson.ToJson(new NativeTelemetry{sessionId=sessionId,unity=Application.unityVersion,mode=mr?"MR":"VR",frameCount=Time.frameCount,unscaledFrameSeconds=Time.unscaledDeltaTime,spaceId=State.Current.spaceId,taskId=State.Current.taskId,viewId=State.Current.viewId,microphoneEnabled=Voice.Gate.Enabled,captureAllowed=Voice.Gate.CanCapture,metrics=metrics.Snapshot()}),r=>reply=r);
                if(reply==null)continue;
                if(!reply.ok){notice="Native telemetry unavailable. Local operation continues; check host evidence support.";dirty=true;}
            }
        }
        private readonly string sessionId=Guid.NewGuid().ToString("N");
        [Serializable] private sealed class NativeTelemetry { public string sessionId,unity,mode,spaceId,taskId,viewId;public int frameCount;public float unscaledFrameSeconds;public bool microphoneEnabled,captureAllowed;public MetricSnapshot metrics; }
        private void Session(bool active){foreground=active;if(!active)CancelEdit();if(Host==null)return;Voice.SetSession(OwnsListeningSession());if(active)Host.Reconnect();else{Host.Suspend();StopStream();}dirty=true;}
        private void OnApplicationPause(bool value){paused=value;Session(focused&&!paused);}
        private void OnApplicationFocus(bool value){focused=value;Session(focused&&!paused);}
        private void OnDestroy(){CancelEdit();if(anchor!=null)Destroy(anchor.gameObject);if(floor!=null)Destroy(floor);if(nodeMaterial!=null)Destroy(nodeMaterial);if(floorMaterial!=null)Destroy(floorMaterial);if(texture!=null)Destroy(texture);}
    }
}
