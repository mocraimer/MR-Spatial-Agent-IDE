using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace Spatial.Native.Tests
{
    public sealed class InputVisualTests
    {
        [UnityTest] public IEnumerator BeforeRenderRayFollowsTheMovedModelAnchorWithoutDispatchingActions()
        {
            var root = new GameObject("Late pose seam"); root.SetActive(false);
            var controller = new GameObject("Controller model anchor"); controller.transform.SetParent(root.transform); controller.SetActive(false);
            var helper = controller.AddComponent<OVRControllerHelper>(); controller.AddComponent<MeshRenderer>();
            var hand = new GameObject("Inactive SDK hand"); hand.transform.SetParent(root.transform); hand.SetActive(false);
            var provider = hand.AddComponent<OVRHand>(); hand.AddComponent<OVRSkeleton>(); hand.AddComponent<OVRMesh>(); hand.AddComponent<OVRMeshRenderer>(); hand.AddComponent<SkinnedMeshRenderer>();
            var visual = root.AddComponent<SpatialInputVisual>(); visual.Controller = helper; visual.HandTemplate = provider;
            root.SetActive(true); visual.enabled = false; visual.BindHand(provider);
            var pointer = root.AddComponent<SpatialPointer>(); pointer.enabled = false;
            var flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
            typeof(SpatialPointer).GetField("visuals", flags).SetValue(pointer, new[] { visual });
            var beams = (LineRenderer[])typeof(SpatialPointer).GetField("beams", flags).GetValue(pointer);
            var refresh = typeof(SpatialPointer).GetMethod("RefreshBeams", flags);
            int actions = 0; pointer.PlacementMode = true; pointer.PlaceWindow = _ => actions++;
            root.transform.SetPositionAndRotation(new Vector3(3, 1, -4), Quaternion.Euler(0, 75, 0));
            foreach (bool left in new[] { true, false })
            {
                visual.Left = left; visual.ApplyTracking(true, true, false, true);
                controller.transform.localPosition = new Vector3(left ? -.25f : .25f, 1.2f, .3f);
                controller.transform.localRotation = Quaternion.Euler(-20, left ? -30 : 30, 0);
                refresh.Invoke(pointer, null);
                var beam = beams[left ? 0 : 1];
                Assert.That(beam.GetPosition(0), Is.EqualTo(controller.transform.position));
                Assert.That(Vector3.Dot((beam.GetPosition(1) - beam.GetPosition(0)).normalized, controller.transform.forward), Is.GreaterThan(.999f));
                controller.transform.localPosition += new Vector3(.1f, .1f, .1f);
                refresh.Invoke(pointer, null);
                Assert.That(beam.GetPosition(0), Is.EqualTo(controller.transform.position), "Follow the late-updated model pose");
                visual.ApplyTracking(false, true, false, true); refresh.Invoke(pointer, null);
                Assert.That(beam.enabled, Is.False);
            }
            Assert.That(actions, Is.Zero); Assert.That(pointer.PlacementMode, Is.True);
            Object.Destroy(root); yield return null;
        }
        [UnityTest] public IEnumerator ActualRendererGatesHideLossAndSwitchWithoutAcquisitionActionsOnEitherSide()
        {
            foreach (bool left in new[] { true, false })
            {
                var root = new GameObject("Input visibility seam"); root.SetActive(false);
                var controller = new GameObject("SDK controller seam"); controller.transform.SetParent(root.transform); controller.SetActive(false);
                var helper = controller.AddComponent<OVRControllerHelper>();
                var controllerRenderer = controller.AddComponent<MeshRenderer>();
                var hand = new GameObject("SDK hand seam"); hand.transform.SetParent(root.transform); hand.SetActive(false);
                var provider = hand.AddComponent<OVRHand>(); hand.AddComponent<OVRSkeleton>(); hand.AddComponent<OVRMesh>(); hand.AddComponent<OVRMeshRenderer>();
                var handRenderer = hand.AddComponent<SkinnedMeshRenderer>();
                var visual = root.AddComponent<SpatialInputVisual>(); visual.Controller = helper; visual.HandTemplate = provider; visual.Left = left;
                root.SetActive(true); visual.enabled = false; visual.BindHand(provider);
                var policy = new SpatialInputPolicy(); int actions = 0;
                var target = root.AddComponent<SpatialTarget>(); target.Activate = () => actions++;
                foreach (var mode in new[] { SpatialInputMode.Controller, SpatialInputMode.Hand, SpatialInputMode.None, SpatialInputMode.Hand, SpatialInputMode.Controller })
                {
                    visual.ApplyTracking(true, mode == SpatialInputMode.Controller, mode == SpatialInputMode.Hand, mode == SpatialInputMode.Controller);
                    Assert.That(visual.Mode, Is.EqualTo(mode));
                    Assert.That(controllerRenderer.forceRenderingOff, Is.EqualTo(mode != SpatialInputMode.Controller));
                    Assert.That(handRenderer.forceRenderingOff, Is.EqualTo(mode != SpatialInputMode.Hand));
                    int before = actions;
                    if (policy.Step(visual.Mode, true)) target.Press(root.transform.position);
                    Assert.That(actions, Is.EqualTo(before), "Held input at acquisition must not act");
                    policy.Step(visual.Mode, false);
                    if (policy.Step(visual.Mode, true)) target.Press(root.transform.position);
                    Assert.That(actions, Is.EqualTo(before + (mode == SpatialInputMode.None ? 0 : 1)));
                }
                visual.ApplyTracking(false, true, true, true);
                Assert.That(visual.Mode, Is.EqualTo(SpatialInputMode.None));
                Assert.That(controllerRenderer.forceRenderingOff && handRenderer.forceRenderingOff, Is.True);
                Object.Destroy(root); yield return null;
            }
        }
    }
}
