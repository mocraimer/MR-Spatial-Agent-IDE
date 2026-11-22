using System.Linq;
using System.IO;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Spatial.Native.Tests
{
    public sealed class InputModelTests
    {
        [Test] public void BuiltSceneContainsBothSdkVisualsInOneTrackingSpaceWithValidAssets()
        {
            var scene = EditorSceneManager.OpenScene(Editor.QuestBuild.Scene, OpenSceneMode.Additive);
            try
            {
                var rig = scene.GetRootGameObjects().SelectMany(x => x.GetComponentsInChildren<OVRCameraRig>(true)).Single();
                var inputs = rig.GetComponentsInChildren<SpatialInputVisual>(true);
                Assert.That(inputs.Length, Is.EqualTo(2));
                Assert.That(inputs.Count(x => x.Left), Is.EqualTo(1));
                foreach (var visual in inputs)
                {
                    Assert.That(visual.Rig, Is.SameAs(rig));
                    Assert.That(visual.transform.parent, Is.SameAs(rig.trackingSpace));
                    Assert.That(visual.Controller.transform.parent, Is.SameAs(visual.Left ? rig.leftControllerAnchor : rig.rightControllerAnchor));
                    Assert.That(visual.Controller.m_controller, Is.EqualTo(visual.Left ? OVRInput.Controller.LTouch : OVRInput.Controller.RTouch));
                    var hand = visual.HandTemplate;
                    Assert.That(hand.transform.parent, Is.SameAs(rig.trackingSpace));
                    var provider = new SerializedObject(hand);
                    Assert.That(provider.FindProperty("HandType").intValue, Is.EqualTo((int)(visual.Left ? OVRHand.Hand.HandLeft : OVRHand.Hand.HandRight)));
                    Assert.That(provider.FindProperty("_pointerPoseRoot").objectReferenceValue, Is.SameAs(rig.trackingSpace));
                    Assert.That(visual.Controller.gameObject.activeSelf, Is.False, "No untracked first-frame controller");
                    Assert.That(hand.gameObject.activeSelf, Is.False, "Never activate the configured template");
                    Assert.That(hand.GetComponent<OVRMesh>(), Is.Not.Null);
                    Assert.That(hand.GetComponent<OVRMeshRenderer>(), Is.Not.Null);
                    var skeleton = hand.GetComponent<OVRSkeleton>();
                    Assert.That(new SerializedObject(skeleton).FindProperty("_updateRootPose").boolValue, Is.True);
                    Assert.That(skeleton.GetSkeletonType(), Is.EqualTo(((OVRSkeleton.IOVRSkeletonDataProvider)hand).GetSkeletonType()));
                    Assert.That(visual.Controller.m_modelMetaTouchPlusLeftController, Is.Not.Null);
                    Assert.That(visual.Controller.m_modelMetaTouchPlusRightController, Is.Not.Null);
                    var renderers = visual.Controller.GetComponentsInChildren<Renderer>(true).Concat(hand.GetComponents<Renderer>()).ToArray();
                    Assert.That(renderers.Length, Is.GreaterThan(2));
                    foreach (var renderer in renderers)
                    {
                        foreach (var material in renderer.sharedMaterials)
                        {
                            Assert.That(material, Is.Not.Null, renderer.name);
                            Assert.That(material.shader, Is.Not.Null, material.name);
                            Assert.That(ShaderUtil.ShaderHasError(material.shader), Is.False, material.shader.name);
                            Assert.That(AssetDatabase.GetAssetPath(material), Does.StartWith("Packages/com.meta.xr.sdk.core/"));
                        }
                    }
                    foreach (var mesh in visual.Controller.GetComponentsInChildren<MeshFilter>(true)) Assert.That(mesh.sharedMesh, Is.Not.Null);
                }
            }
            finally { EditorSceneManager.CloseScene(scene, true); }
        }
        [Test] public void SavedPrefabOverridesExplicitlyPersistBothOpenXRHandTypesWithoutEditorRepair()
        {
            var raw = File.ReadAllText(Editor.QuestBuild.Scene);
            var blocks = Regex.Split(raw, @"(?m)^--- !u!");
            foreach (var side in new[] { new { Name = "Left articulated hand", Type = 4 }, new { Name = "Right articulated hand", Type = 5 } })
            {
                var block = blocks.Single(b => b.Contains("value: " + side.Name + "\n"));
                foreach (string property in new[] { "_skeletonType", "_meshType" })
                    Assert.That(Regex.IsMatch(block, "propertyPath: " + property + @"\r?\n\s+value: " + side.Type + @"\r?\n"), Is.True, side.Name + " persisted " + property);
            }
        }
        [Test] public void FailedHandMeshLoadsAreBoundedAndLaterTrackingAcquisitionCanRecover()
        {
            var load = new SpatialHandLoadPolicy();
            Assert.That(load.Step(false, false, 0), Is.EqualTo(SpatialHandLoadAction.Wait));
            Assert.That(load.Step(true, false, 0), Is.EqualTo(SpatialHandLoadAction.Replace));
            Assert.That(load.Step(true, false, .5f), Is.EqualTo(SpatialHandLoadAction.Wait));
            Assert.That(load.Step(true, false, 1), Is.EqualTo(SpatialHandLoadAction.Replace));
            Assert.That(load.Step(true, false, 2), Is.EqualTo(SpatialHandLoadAction.Replace));
            Assert.That(load.Step(true, false, 3), Is.EqualTo(SpatialHandLoadAction.Unavailable));
            Assert.That(load.Step(true, false, 30), Is.EqualTo(SpatialHandLoadAction.Unavailable));
            Assert.That(load.Attempts, Is.EqualTo(3));
            load.Step(false, false, 31);
            Assert.That(load.Step(true, false, 32), Is.EqualTo(SpatialHandLoadAction.Replace));
            Assert.That(load.Step(true, true, 33), Is.EqualTo(SpatialHandLoadAction.Ready));
            Assert.That(load.Step(true, true, 40), Is.EqualTo(SpatialHandLoadAction.Ready));
            Assert.That(load.Unavailable, Is.False);
        }
        [TestCase(false,false,false,false,SpatialInputMode.None)]
        [TestCase(true,true,false,false,SpatialInputMode.Controller)]
        [TestCase(true,false,true,false,SpatialInputMode.Hand)]
        [TestCase(true,true,true,false,SpatialInputMode.Hand)]
        [TestCase(true,true,true,true,SpatialInputMode.Controller)]
        [TestCase(false,true,true,true,SpatialInputMode.None)]
        public void VisibilityRequiresTrackingAndFocus(bool focus, bool controller, bool hand, bool held, SpatialInputMode expected)
            => Assert.That(SpatialInputPolicy.Resolve(focus, controller, hand, held), Is.EqualTo(expected));
        [Test] public void ControllerHandControllerAndLossAllRequireReleaseBeforeNewSelection()
        {
            var policy = new SpatialInputPolicy();
            foreach (var mode in new[] { SpatialInputMode.Controller, SpatialInputMode.Hand, SpatialInputMode.Controller, SpatialInputMode.None, SpatialInputMode.Hand })
            {
                Assert.That(policy.Step(mode, true), Is.False);
                Assert.That(policy.Step(mode, true), Is.False);
                Assert.That(policy.Step(mode, false), Is.False);
                Assert.That(policy.Step(mode, true), Is.EqualTo(mode != SpatialInputMode.None));
                Assert.That(policy.Step(mode, true), Is.False);
            }
        }
    }
}
