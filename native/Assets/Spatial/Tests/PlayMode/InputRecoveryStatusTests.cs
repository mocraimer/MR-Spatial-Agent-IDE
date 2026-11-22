using System.Collections;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UI;

namespace Spatial.Native.Tests
{
    public sealed class InputRecoveryStatusTests
    {
        private static SpatialInputVisual Visual(Transform parent, bool left)
        {
            var root = new GameObject(left ? "Left status seam" : "Right status seam"); root.SetActive(false); root.transform.SetParent(parent);
            var controller = new GameObject("Inactive controller"); controller.transform.SetParent(root.transform); controller.SetActive(false);
            var helper = controller.AddComponent<OVRControllerHelper>(); controller.AddComponent<MeshRenderer>();
            var template = new GameObject("Dormant hand"); template.transform.SetParent(root.transform); template.SetActive(false);
            var hand = template.AddComponent<OVRHand>(); template.AddComponent<OVRSkeleton>(); template.AddComponent<OVRMesh>(); template.AddComponent<OVRMeshRenderer>(); template.AddComponent<SkinnedMeshRenderer>();
            var visual = root.AddComponent<SpatialInputVisual>(); visual.Controller = helper; visual.HandTemplate = hand; visual.Left = left;
            root.SetActive(true); visual.enabled = false;
            return visual;
        }
        private static void Exhaust(SpatialInputVisual visual)
        {
            visual.UpdateHandLoad(true, false, 0); visual.UpdateHandLoad(true, false, 1); visual.UpdateHandLoad(true, false, 2); visual.UpdateHandLoad(true, false, 3);
            Assert.That(visual.HandLoadUnavailable, Is.True);
        }
        [UnityTest] public IEnumerator ExhaustedSidesShowBeforePairingWithoutReplacingOwnerFeedbackAndClearOnRetry()
        {
            var root = new GameObject("Recovery status workspace"); var head = new GameObject("Recovery status head");
            var workspace = root.AddComponent<SpatialWorkspace>(); workspace.enabled = false; workspace.ViewCamera = head.AddComponent<Camera>(); workspace.Start(); workspace.Voice.enabled = false;
            try
            {
                workspace.Host.Forget(); // Explicit unpaired setup, independent of editor's saved pairing.
                var left = Visual(root.transform, true); var right = Visual(root.transform, false);
                var flags = BindingFlags.Instance | BindingFlags.NonPublic;
                typeof(SpatialWorkspace).GetField("inputVisuals", flags).SetValue(workspace, new[] { left, right });
                typeof(SpatialWorkspace).GetField("notice", flags).SetValue(workspace, "Owner action remains unresolved");
                workspace.Render(); workspace.InspectText("Owner feedback", "Retain this owner dialog");
                var setup = GameObject.Find("Trusted pairing"); var dialog = GameObject.Find("Retained detail");
                var receiver = workspace.State.Receiver; var headPosition = head.transform.position;
                left.UpdateHandLoad(false, false, 0); right.UpdateHandLoad(false, false, 0); workspace.RefreshInputStatus();
                Assert.That(GameObject.Find("Input recovery"), Is.Null, "Ordinary untracked hiding is not a load failure");
                Exhaust(left); workspace.RefreshInputStatus();
                var panel = GameObject.Find("Input recovery"); Assert.That(panel, Is.Not.Null);
                var label = panel.GetComponentInChildren<Text>();
                Assert.That(label.text, Does.StartWith("Left hand model failed to load."));
                Assert.That(label.text, Does.Contain("Use controllers").And.Contain("out of tracking").And.Contain("raise/reacquire to retry"));
                for (int i = 0; i < 3; i++) { workspace.RefreshInputStatus(); yield return null; }
                Assert.That(GameObject.Find("Input recovery"), Is.SameAs(panel)); Assert.That(GameObject.Find("Trusted pairing"), Is.SameAs(setup), "Status does not rebuild setup");
                Assert.That(GameObject.Find("Retained detail"), Is.SameAs(dialog)); Assert.That(dialog.activeSelf, Is.True);
                Assert.That(typeof(SpatialWorkspace).GetField("notice", flags).GetValue(workspace), Is.EqualTo("Owner action remains unresolved"));
                Assert.That(panel.GetComponentsInChildren<SpatialTarget>(), Is.Empty, "Recovery status never takes input/focus");
                Exhaust(right); workspace.RefreshInputStatus(); Assert.That(label.text, Does.StartWith("Left and right hand models failed to load."));
                left.UpdateHandLoad(false, false, 4); workspace.RefreshInputStatus(); Assert.That(label.text, Does.StartWith("Right hand model failed to load."));
                right.UpdateHandLoad(false, false, 4); workspace.RefreshInputStatus(); Assert.That(panel.activeSelf, Is.False);
                left.UpdateHandLoad(true, false, 5); workspace.RefreshInputStatus(); Assert.That(panel.activeSelf, Is.False, "Retry availability clears exhaustion, not fake success");
                left.UpdateHandLoad(true, true, 6); workspace.RefreshInputStatus(); Assert.That(panel.activeSelf, Is.False);
                Assert.That(workspace.State.Receiver, Is.SameAs(receiver)); Assert.That(head.transform.position, Is.EqualTo(headPosition));
                Assert.That(workspace.Voice.Gate.Enabled, Is.False); Assert.That(workspace.Voice.Gate.Captured, Is.Null); Assert.That(workspace.Voice.SpokenReplies, Is.False);
            }
            finally { Object.Destroy(root); Object.Destroy(head); }
            yield return null;
        }
    }
}
