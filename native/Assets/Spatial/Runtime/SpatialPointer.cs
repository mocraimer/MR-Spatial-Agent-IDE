using System;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.InputSystem.LowLevel;

namespace Spatial.Native
{
    public sealed class SpatialTarget : MonoBehaviour
    {
        public Action Activate; public Action<Vector2> Point;
        public float Width = 1, Height = 1;
        public void Press(Vector3 world)
        {
            if (!isActiveAndEnabled) return;
            if (Point != null) { var local = transform.InverseTransformPoint(world); Point(new Vector2(Mathf.Clamp01(local.x / Width + .5f), Mathf.Clamp01(.5f - local.y / Height))); }
            else Activate?.Invoke();
        }
    }
    [DefaultExecutionOrder(200)]
    public sealed class SpatialPointer : MonoBehaviour
    {
        public OVRCameraRig Rig; public Camera ViewCamera; public Action InboxShortcut; public Action<bool> PushToTalk; public Action CancelPushToTalk;
        public const string InboxBinding="<XRController>{LeftHand}/menuButton";
        public Action<Vector3> PlaceWindow; public bool PlacementMode;
        private InputAction menu, talk;
        private SpatialInputVisual[] visuals;
        private readonly SpatialInputPolicy[] policies = { new SpatialInputPolicy(), new SpatialInputPolicy() };
        private readonly SpatialInputPolicy talkPolicy = new SpatialInputPolicy();
        private readonly LineRenderer[] beams = new LineRenderer[2];
        private Material beamMaterial;
        private bool focus = true, paused, talking;
        private InputDevice talkDevice, resetTalkDevice;
        private void Awake()
        {
            menu = new InputAction("All projects Inbox", binding: InboxBinding);
            talk = new InputAction("PTT", binding: "<XRController>{RightHand}/primaryButton");
            menu.Enable(); talk.Enable();
            beamMaterial = new Material(Resources.Load<Material>("SpatialRay")) { color = new Color(.64f,.87f,.88f) };
            for (int i = 0; i < beams.Length; i++)
            {
                var beam = new GameObject(i == 0 ? "Left deliberate pointer" : "Right deliberate pointer").AddComponent<LineRenderer>();
                beam.positionCount = 2; beam.startWidth = .004f; beam.endWidth = .001f; beam.material = beamMaterial; beam.enabled = false;
                beams[i] = beam;
            }
        }
        private void LateUpdate()
        {
            if (!focus || paused || (Rig != null && !OVRManager.hasInputFocus)) { ResetInput(); return; }
            if (visuals == null && Rig != null) visuals = Rig.GetComponentsInChildren<SpatialInputVisual>(true);
            if (menu.WasPressedThisFrame()||Keyboard.current?.f1Key.wasPressedThisFrame==true) InboxShortcut?.Invoke();
            if(Mouse.current?.leftButton.wasPressedThisFrame==true)ScreenSelect(Mouse.current.position.ReadValue());
            if(Touchscreen.current?.primaryTouch.press.wasPressedThisFrame==true)ScreenSelect(Touchscreen.current.primaryTouch.position.ReadValue());
            bool rightController = false;
            if (visuals != null) foreach (var visual in visuals)
            {
                int index = visual.Left ? 0 : 1;
                bool available = visual.TryGetRay(out var ray, out var pressed);
                var mode = available ? visual.Mode : SpatialInputMode.None;
                bool select = policies[index].Step(mode, pressed);
                beams[index].enabled = available;
                if (available) Trace(beams[index], ray, select);
                if (!visual.Left) rightController = mode == SpatialInputMode.Controller;
            }
            var device = talk.activeControl?.device ?? (talk.controls.Count == 1 ? talk.controls[0].device : null);
            ProcessPushToTalk(rightController, talk.IsPressed(), talk.WasReleasedThisFrame(), device);
        }
        internal void ProcessPushToTalk(bool rightController, bool held, bool released, InputDevice device = null)
        {
            if (device != null && device == resetTalkDevice) rightController = false;
            if (talking && (!rightController || device != talkDevice)) CancelTalk();
            if (talkPolicy.Step(rightController ? SpatialInputMode.Controller : SpatialInputMode.None, held))
            { talking = true; talkDevice = device; PushToTalk?.Invoke(true); }
            // Only an A-release from the same, still-tracked acquisition can finish/send a PTT turn.
            if (talking && released) { talking = false; talkDevice = null; PushToTalk?.Invoke(false); }
        }
        private void CancelTalk()
        {
            talkPolicy.Step(SpatialInputMode.None, false); talkDevice = null;
            if (talking) { talking = false; CancelPushToTalk?.Invoke(); }
        }
        internal void InputDeviceChanged(InputDevice device, InputDeviceChange change)
        {
            bool right = device == talkDevice;
            foreach (var control in talk.controls) if (control.device == device) right = true;
            if (!right) return;
            if (change != InputDeviceChange.SoftReset && change != InputDeviceChange.HardReset && change != InputDeviceChange.Disabled &&
                change != InputDeviceChange.Disconnected && change != InputDeviceChange.Removed) return;
            // A reset can synthesize button-up even if a pose control survives; it is not an owner release.
            resetTalkDevice = device;
            CancelTalk(); policies[1].Step(SpatialInputMode.None, false);
            if (beams[1] != null) beams[1].enabled = false;
        }
        private void InputEvent(InputEventPtr inputEvent, InputDevice device)
        {
            if (device != resetTalkDevice || (!inputEvent.IsA<StateEvent>() && !inputEvent.IsA<DeltaStateEvent>())) return;
            // onEvent precedes timestamp rejection. Both public times use realtimeSinceStartup seconds.
            // An old event leaves reset's synthetic zero intact and must not unlock release-arming.
            if (inputEvent.time < device.lastUpdateTime) return;
            // Do not release-arm against synthetic reset state, even if tracked pose controls survive.
            foreach (var control in talk.controls)
                if (control.device == device && control is ButtonControl button && button.ReadValueFromEvent(inputEvent, out _))
                { resetTalkDevice = null; break; }
        }
        private void Trace(LineRenderer beam, Ray ray, bool select)
        {
            var origin = ray.origin; var direction = ray.direction;
            var end = origin + direction * 6;
            if (Physics.Raycast(origin, direction, out var hit, 6))
            {
                end = hit.point;
                if (select)
                {
                    if (PlacementMode) { PlacementMode = false; PlaceWindow?.Invoke(hit.point); }
                    else hit.collider.GetComponent<SpatialTarget>()?.Press(hit.point);
                }
            }
            else if (select && PlacementMode) { PlacementMode = false; PlaceWindow?.Invoke(origin + direction * 2.4f); }
            beam.SetPosition(0, origin); beam.SetPosition(1, end);
        }
        private void OnEnable() { Application.onBeforeRender += RefreshBeams; InputSystem.onDeviceChange += InputDeviceChanged; InputSystem.onEvent += InputEvent; }
        [BeforeRenderOrder(100)]
        private void RefreshBeams()
        {
            // The SDK late-updates controller/model anchors before rendering. Follow those exact poses,
            // but never dispatch an action from the render callback.
            if (!focus || paused || (Rig != null && !OVRManager.hasInputFocus)) { ResetInput(); return; }
            if (visuals == null) return;
            foreach (var visual in visuals)
            {
                int index = visual.Left ? 0 : 1;
                bool available = visual.TryGetRay(out var ray, out _);
                beams[index].enabled = available;
                if (available) Trace(beams[index], ray, false);
                else policies[index].Step(SpatialInputMode.None, false);
            }
        }
        private void OnApplicationFocus(bool value) { focus = value; if (!value) ResetInput(); }
        private void OnApplicationPause(bool value) { paused = value; if (value) ResetInput(); }
        private void OnDisable() { Application.onBeforeRender -= RefreshBeams; InputSystem.onDeviceChange -= InputDeviceChanged; InputSystem.onEvent -= InputEvent; ResetInput(); }
        private void ResetInput()
        {
            foreach (var policy in policies) policy.Step(SpatialInputMode.None, false);
            CancelTalk();
            foreach (var beam in beams) if (beam != null) beam.enabled = false;
        }
        private void ScreenSelect(Vector2 screen)
        {
            if(ViewCamera==null)return;
            var ray=ViewCamera.ScreenPointToRay(screen);
            if(Physics.Raycast(ray,out var hit,6))
            {
                if(PlacementMode){PlacementMode=false;PlaceWindow?.Invoke(hit.point);}
                else hit.collider.GetComponent<SpatialTarget>()?.Press(hit.point);
            }
        }
        private void OnDestroy()
        {
            menu?.Dispose(); talk?.Dispose();
            foreach (var beam in beams) if (beam != null) Destroy(beam.gameObject);
            if (beamMaterial != null) Destroy(beamMaterial);
        }
    }
}
