using UnityEngine;

namespace Spatial.Native
{
    [DefaultExecutionOrder(100)]
    public sealed class SpatialInputVisual : MonoBehaviour
    {
        public OVRCameraRig Rig;
        public OVRControllerHelper Controller;
        public OVRHand HandTemplate;
        public OVRHand Hand { get; private set; }
        public bool HandLoadUnavailable => handLoad.Unavailable;
        public bool Left;
        public SpatialInputMode Mode { get; private set; }
        private Renderer[] controllers;
        private SkinnedMeshRenderer handRenderer;
        private OVRSkeleton skeleton;
        private OVRMesh mesh;
        private OVRMeshRenderer skin;
        private bool focus = true, paused;
        private readonly SpatialHandLoadPolicy handLoad = new SpatialHandLoadPolicy();
        private int replacementFrame = -1;
        private void Awake()
        {
            controllers = Controller.GetComponentsInChildren<Renderer>(true);
            HandTemplate.GetComponent<SkinnedMeshRenderer>().forceRenderingOff = true;
            ApplyVisibility(false, false);
        }
        private void OnApplicationFocus(bool value) { focus = value; if (!value) LoseTracking(); }
        private void OnApplicationPause(bool value) { paused = value; if (value) LoseTracking(); }
        private void OnDisable() => LoseTracking();
        private void LoseTracking() { Mode = SpatialInputMode.None; ApplyVisibility(false, false); }
        private void LateUpdate()
        {
            bool live = focus && !paused && OVRManager.OVRManagerinitialized && OVRManager.hasInputFocus && OVRManager.isHmdPresent;
            var touch = Left ? OVRInput.Controller.LTouch : OVRInput.Controller.RTouch;
            var handDevice = Left ? OVRInput.Controller.LHand : OVRInput.Controller.RHand;
            var side = Left ? OVRInput.Hand.HandLeft : OVRInput.Hand.HandRight;
            if (live && !Controller.gameObject.activeSelf) Controller.gameObject.SetActive(true);
            bool handTracked = live && OVRInput.IsControllerConnected(handDevice) && OVRInput.GetControllerPositionTracked(handDevice);
            // SDK Android renderer Start can precede skeleton initialization. Bind once both are ready.
            if (Hand != null && mesh.IsInitialized && skeleton.IsInitialized && !skin.IsInitialized) skin.ForceRebind();
            UpdateHandLoad(handTracked, Hand != null && mesh.IsInitialized && skeleton.IsInitialized && skin.IsInitialized, Time.unscaledTime);
            bool controller = live && OVRInput.IsControllerConnected(touch) && Controller.IsActive() &&
                OVRInput.GetControllerPositionTracked(touch) && OVRInput.GetControllerOrientationTracked(touch) &&
                OVRInput.GetControllerPositionValid(touch) && OVRInput.GetControllerOrientationValid(touch);
            bool hand = live && Hand != null && Time.frameCount != replacementFrame && Hand.gameObject.activeSelf && Hand.IsTracked && Hand.IsDataValid && Hand.IsDataHighConfidence &&
                !Hand.PoseSourceInferred && mesh.IsInitialized && skeleton.IsInitialized && skin.IsInitialized;
            ApplyTracking(live, controller, hand,
                OVRInput.GetControllerIsInHandState(side) == OVRInput.ControllerInHandState.ControllerInHand);
        }
        internal SpatialHandLoadAction UpdateHandLoad(bool tracked, bool initialized, float now)
        {
            var action = handLoad.Step(tracked, initialized, now);
            if (action == SpatialHandLoadAction.Replace)
            {
                LoseTracking(); DiscardHand();
                // Never activate the template. Each clone gets one genuine SDK Awake mesh load.
                var instance = Instantiate(HandTemplate.gameObject, Rig != null ? Rig.trackingSpace : HandTemplate.transform.parent);
                instance.name = Left ? "Left runtime articulated hand" : "Right runtime articulated hand";
                BindHand(instance.GetComponent<OVRHand>()); replacementFrame = Time.frameCount;
                instance.SetActive(true);
            }
            else if (action == SpatialHandLoadAction.Unavailable) { LoseTracking(); DiscardHand(); }
            return action;
        }
        internal void BindHand(OVRHand provider)
        {
            Hand = provider; handRenderer = provider.GetComponent<SkinnedMeshRenderer>();
            skeleton = provider.GetComponent<OVRSkeleton>(); mesh = provider.GetComponent<OVRMesh>(); skin = provider.GetComponent<OVRMeshRenderer>();
            handRenderer.forceRenderingOff = true;
        }
        private void DiscardHand()
        {
            if (Hand == null) return;
            // OVRMesh allocates its own Mesh even on GetMesh(false); the SDK has no mesh OnDestroy cleanup.
            var ownedMesh = mesh.Mesh;
            Hand.gameObject.SetActive(false); Destroy(Hand.gameObject);
            if (ownedMesh != null) Destroy(ownedMesh);
            Hand = null; handRenderer = null; skeleton = null; mesh = null; skin = null;
        }
        private void OnDestroy() => DiscardHand();
        public void ApplyTracking(bool live, bool controller, bool hand, bool controllerHeld)
        {
            Mode = SpatialInputPolicy.Resolve(live, controller, hand, controllerHeld);
            ApplyVisibility(Mode == SpatialInputMode.Controller, Mode == SpatialInputMode.Hand);
        }
        // Keep SDK animation/data components alive during loss; only suppress their renderers.
        public void ApplyVisibility(bool controller, bool hand)
        {
            if (controllers != null) foreach (var renderer in controllers) renderer.forceRenderingOff = !controller;
            if (handRenderer != null) handRenderer.forceRenderingOff = !hand;
        }
        public bool TryGetRay(out Ray ray, out bool pressed)
        {
            ray = default; pressed = false;
            if (Mode == SpatialInputMode.Controller)
            {
                ray = new Ray(Controller.transform.position, Controller.transform.forward);
                pressed = OVRInput.Get(OVRInput.Button.PrimaryIndexTrigger, Left ? OVRInput.Controller.LTouch : OVRInput.Controller.RTouch);
                return true;
            }
            if (Mode != SpatialInputMode.Hand || !Hand.IsPointerPoseValid || Hand.IsSystemGestureInProgress ||
                Hand.GetFingerConfidence(OVRHand.HandFinger.Index) != OVRHand.TrackingConfidence.High ||
                Hand.GetFingerConfidence(OVRHand.HandFinger.Thumb) != OVRHand.TrackingConfidence.High) return false;
            ray = new Ray(Hand.PointerPose.position, Hand.PointerPose.forward);
            pressed = Hand.GetFingerIsPinching(OVRHand.HandFinger.Index);
            return true;
        }
    }
}
