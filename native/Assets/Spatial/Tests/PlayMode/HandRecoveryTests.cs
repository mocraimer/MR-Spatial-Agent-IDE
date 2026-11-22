using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace Spatial.Native.Tests
{
    public sealed class HandRecoveryTests
    {
        [UnityTest] public IEnumerator RuntimeRetryReplacesFailedSdkInstanceAndKeepsReadyInstanceWithoutDuplicateChildren()
        {
            var root = new GameObject("Hand recovery readiness seam"); root.SetActive(false);
            var controller = new GameObject("Inactive SDK controller seam"); controller.transform.SetParent(root.transform); controller.SetActive(false);
            var helper = controller.AddComponent<OVRControllerHelper>(); controller.AddComponent<MeshRenderer>();
            var template = new GameObject("Dormant configured hand template seam"); template.transform.SetParent(root.transform); template.SetActive(false);
            // None-handed SDK components do not need a physical runtime. Only readiness is supplied by this seam.
            var provider = template.AddComponent<OVRHand>(); template.AddComponent<OVRSkeleton>(); template.AddComponent<OVRMesh>(); template.AddComponent<OVRMeshRenderer>(); template.AddComponent<SkinnedMeshRenderer>();
            var visual = root.AddComponent<SpatialInputVisual>(); visual.Controller = helper; visual.HandTemplate = provider;
            root.SetActive(true); visual.enabled = false;
            Assert.That(visual.UpdateHandLoad(false, false, 0), Is.EqualTo(SpatialHandLoadAction.Wait)); Assert.That(visual.Hand, Is.Null);
            Assert.That(visual.UpdateHandLoad(true, false, 0), Is.EqualTo(SpatialHandLoadAction.Replace));
            var first = visual.Hand; var partialBone = new GameObject("Partial SDK bone seam"); partialBone.transform.SetParent(first.transform);
            Assert.That(first, Is.Not.SameAs(provider)); Assert.That(first.transform.parent, Is.SameAs(template.transform.parent));
            Assert.That(first.GetComponent<SkinnedMeshRenderer>().forceRenderingOff, Is.True); Assert.That(template.activeSelf, Is.False);
            Assert.That(visual.UpdateHandLoad(true, false, .5f), Is.EqualTo(SpatialHandLoadAction.Wait)); Assert.That(visual.Hand, Is.SameAs(first));
            Assert.That(visual.UpdateHandLoad(true, false, 1), Is.EqualTo(SpatialHandLoadAction.Replace)); var second = visual.Hand;
            Assert.That(first.gameObject.activeSelf, Is.False); Assert.That(second, Is.Not.SameAs(first));
            yield return null;
            Assert.That(first == null && partialBone == null, Is.True, "Dispose the failed instance and its partial skeleton children");
            Assert.That(visual.UpdateHandLoad(true, true, 2), Is.EqualTo(SpatialHandLoadAction.Ready)); Assert.That(visual.Hand, Is.SameAs(second));
            Assert.That(visual.UpdateHandLoad(true, true, 20), Is.EqualTo(SpatialHandLoadAction.Ready)); Assert.That(visual.Hand, Is.SameAs(second), "Keep initialized SDK pose/provider data");
            visual.UpdateHandLoad(true, false, 21); visual.UpdateHandLoad(true, false, 22);
            Assert.That(visual.HandLoadUnavailable, Is.True); Assert.That(visual.Hand, Is.Null);
            visual.UpdateHandLoad(false, false, 23); Assert.That(visual.UpdateHandLoad(true, false, 24), Is.EqualTo(SpatialHandLoadAction.Replace));
            Assert.That(visual.Hand, Is.Not.Null); Assert.That(visual.Hand.GetComponent<SkinnedMeshRenderer>().forceRenderingOff, Is.True);
            yield return null;
            Assert.That(root.GetComponentsInChildren<OVRHand>(true).Length, Is.EqualTo(2), "Exactly one dormant template and one runtime instance");
            Object.Destroy(root); yield return null;
        }
    }
}
