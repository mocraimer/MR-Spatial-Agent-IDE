using System;
using System.IO;
using System.Linq;
using Meta.XR;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEditor.XR.Management;
using UnityEditor.XR.Management.Metadata;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.XR.Hands.OpenXR;
using UnityEngine.XR.Management;
using UnityEngine.XR.OpenXR;
using UnityEngine.XR.OpenXR.Features.Interactions;

namespace Spatial.Native.Editor
{
    public static class QuestBuild
    {
        public const string Scene = "Assets/Spatial/Scenes/Workspace.unity";
        [MenuItem("Spatial/Configure Quest project")]
        public static void Configure()
        {
            Directory.CreateDirectory("Assets/Spatial/Scenes"); Directory.CreateDirectory("Assets/XR/Settings"); AssetDatabase.Refresh();
            PlayerSettings.companyName="Personal Workspace";PlayerSettings.productName="Spatial Agent Workspace";PlayerSettings.bundleVersion="0.1.0";
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android,"local.spatial.workspace");PlayerSettings.Android.bundleVersionCode=1;
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android,ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures=AndroidArchitecture.ARM64;PlayerSettings.Android.minSdkVersion=AndroidSdkVersions.AndroidApiLevel32;
            PlayerSettings.Android.targetSdkVersion=AndroidSdkVersions.AndroidApiLevel36;PlayerSettings.Android.forceInternetPermission=true;
            PlayerSettings.Android.forceSDCardPermission=false;PlayerSettings.Android.useCustomKeystore=false;
            PlayerSettings.Android.applicationEntry=AndroidApplicationEntry.GameActivity;PlayerSettings.SplashScreen.show=false;
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android,false);PlayerSettings.SetGraphicsAPIs(BuildTarget.Android,new[]{GraphicsDeviceType.Vulkan});
            PlayerSettings.colorSpace=ColorSpace.Linear;PlayerSettings.runInBackground=false;PlayerSettings.enableFrameTimingStats=true;
            PlayerSettings.defaultInterfaceOrientation=UIOrientation.LandscapeLeft;QualitySettings.vSyncCount=0;QualitySettings.antiAliasing=4;
            var player=new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset")[0]);
            player.FindProperty("activeInputHandler").intValue=1;player.ApplyModifiedPropertiesWithoutUndo();
            RetainMaterials(); PackagePrivacy.Scrub(); ConfigureXR();
            var meta=OVRProjectConfig.CachedProjectConfig;meta.insightPassthroughSupport=OVRProjectConfig.FeatureSupport.Supported;
            meta.handTrackingSupport=OVRProjectConfig.HandTrackingSupport.ControllersAndHands;
            meta.targetDeviceTypes=new System.Collections.Generic.List<OVRProjectConfig.DeviceType>{OVRProjectConfig.DeviceType.Quest3};meta.disableBackups=true;
            meta.requiresSystemKeyboard=true;meta.systemLoadingScreenBackground=OVRProjectConfig.SystemLoadingScreenBackground.ContextualPassthrough;
            OVRProjectConfig.CommitProjectConfig(meta);
            CreateScene(); EditorBuildSettings.scenes=new[]{new EditorBuildSettingsScene(Scene,true)};
            AssetDatabase.SaveAssets();Debug.Log("Spatial native configured: Quest 3, ARM64 IL2CPP, OpenXR controller/hand input, optional MR, no ambient microphone.");
        }
        private static void RetainMaterials()
        {
            Directory.CreateDirectory("Assets/Resources");
            foreach(var pair in new[]{new[]{"SpatialNode","Standard"},new[]{"SpatialRay","Unlit/Color"}})
            {
                string path="Assets/Resources/"+pair[0]+".mat";
                if(AssetDatabase.LoadAssetAtPath<Material>(path)!=null)continue;
                var shader=Shader.Find(pair[1]);if(shader==null)throw new InvalidOperationException("Required native shader missing: "+pair[1]);
                AssetDatabase.CreateAsset(new Material(shader){name=pair[0]},path);
            }
        }
        private static void ConfigureXR()
        {
            if(!EditorBuildSettings.TryGetConfigObject(XRGeneralSettings.settingsKey,out XRGeneralSettingsPerBuildTarget all))
            {all=ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();AssetDatabase.CreateAsset(all,"Assets/XR/Settings/XRGeneralSettingsPerBuildTarget.asset");EditorBuildSettings.AddConfigObject(XRGeneralSettings.settingsKey,all,true);}
            if(!all.HasSettingsForBuildTarget(BuildTargetGroup.Android))all.CreateDefaultSettingsForBuildTarget(BuildTargetGroup.Android);
            if(all.ManagerSettingsForBuildTarget(BuildTargetGroup.Android)==null)all.CreateDefaultManagerSettingsForBuildTarget(BuildTargetGroup.Android);
            var general=all.SettingsForBuildTarget(BuildTargetGroup.Android);general.InitManagerOnStart=true;
            if(!XRPackageMetadataStore.AssignLoader(general.AssignedSettings,"UnityEngine.XR.OpenXR.OpenXRLoader",BuildTargetGroup.Android))throw new InvalidOperationException("OpenXR Android loader not assigned.");
            var xr=OpenXRSettings.GetSettingsForBuildTargetGroup(BuildTargetGroup.Android);if(xr==null)throw new InvalidOperationException("Missing Android OpenXR settings.");
            xr.renderMode=OpenXRSettings.RenderMode.SinglePassInstanced;
            var meta=xr.GetFeature<MetaXRFeature>();var touch=xr.GetFeature<OculusTouchControllerProfile>();var plus=xr.GetFeature<MetaQuestTouchPlusControllerProfile>();var hand=xr.GetFeature<HandTracking>();
            if(meta==null||touch==null||plus==null||hand==null)throw new InvalidOperationException("Required Meta/controller/hand OpenXR feature missing.");
            meta.enabled=touch.enabled=plus.enabled=hand.enabled=true;
            EditorUtility.SetDirty(meta);EditorUtility.SetDirty(touch);EditorUtility.SetDirty(plus);EditorUtility.SetDirty(hand);EditorUtility.SetDirty(xr);EditorUtility.SetDirty(general);EditorUtility.SetDirty(all);
        }
        public static void CreateScene()
        {
            var scene=EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            var prefab=AssetDatabase.LoadAssetAtPath<GameObject>("Packages/com.meta.xr.sdk.core/Prefabs/OVRCameraRig.prefab");if(prefab==null)throw new InvalidOperationException("Meta SDK camera rig prefab missing.");
            var rigObject=(GameObject)PrefabUtility.InstantiatePrefab(prefab);var rig=rigObject.GetComponent<OVRCameraRig>();var manager=rigObject.GetComponent<OVRManager>();
            manager.isInsightPassthroughEnabled=true;manager.trackingOriginType=OVRManager.TrackingOrigin.FloorLevel;
            var passthrough=rigObject.AddComponent<OVRPassthroughLayer>();passthrough.overlayType=OVROverlay.OverlayType.Underlay;passthrough.enabled=false;
            var camera=rigObject.GetComponentsInChildren<Camera>(true).First(c=>c.name=="CenterEyeAnchor");camera.tag="MainCamera";camera.nearClipPlane=.05f;camera.farClipPlane=40;
            camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.055f,.09f,.12f);
            CreateInputVisual(rig,true);CreateInputVisual(rig,false);
            var workspace=new GameObject("Spatial workspace").AddComponent<SpatialWorkspace>();workspace.Rig=rig;workspace.ViewCamera=camera;workspace.Passthrough=passthrough;
            var light=new GameObject("Context light").AddComponent<Light>();light.type=LightType.Directional;light.intensity=.75f;light.shadows=LightShadows.None;light.transform.rotation=Quaternion.Euler(45,-30,0);RenderSettings.ambientLight=new Color(.55f,.65f,.7f);
            EditorSceneManager.SaveScene(scene,Scene);
        }
        private static void CreateInputVisual(OVRCameraRig rig,bool left)
        {
            const string root="Packages/com.meta.xr.sdk.core/Prefabs/";
            var controllerPrefab=AssetDatabase.LoadAssetAtPath<GameObject>(root+"OVRControllerPrefab.prefab");
            var handPrefab=AssetDatabase.LoadAssetAtPath<GameObject>(root+"OVRHandPrefab.prefab");
            if(controllerPrefab==null||handPrefab==null)throw new InvalidOperationException("Required SDK tracked input prefabs missing.");
            var controller=(GameObject)PrefabUtility.InstantiatePrefab(controllerPrefab,left?rig.leftControllerAnchor:rig.rightControllerAnchor);
            controller.name=left?"Left tracked controller":"Right tracked controller";
            controller.transform.localPosition=Vector3.zero;controller.transform.localRotation=Quaternion.identity;
            var helper=controller.GetComponent<OVRControllerHelper>();helper.m_controller=left?OVRInput.Controller.LTouch:OVRInput.Controller.RTouch;
            var hand=(GameObject)PrefabUtility.InstantiatePrefab(handPrefab,rig.trackingSpace);
            hand.name=left?"Left articulated hand":"Right articulated hand";
            hand.transform.localPosition=Vector3.zero;hand.transform.localRotation=Quaternion.identity;
            var provider=hand.GetComponent<OVRHand>();var data=new SerializedObject(provider);
            data.FindProperty("HandType").intValue=(int)(left?OVRHand.Hand.HandLeft:OVRHand.Hand.HandRight);
            data.FindProperty("_pointerPoseRoot").objectReferenceValue=rig.trackingSpace;
            data.ApplyModifiedPropertiesWithoutUndo();
            // Explicit overrides are essential: Editor OnValidate can repair only the loaded instance,
            // masking an inherited OVR skeleton type in the saved scene's OpenXR hand.
            var skeletonComponent=hand.GetComponent<OVRSkeleton>();var meshComponent=hand.GetComponent<OVRMesh>();
            int skeletonType=(int)((OVRSkeleton.IOVRSkeletonDataProvider)provider).GetSkeletonType();
            int meshType=(int)((OVRMesh.IOVRMeshDataProvider)provider).GetMeshType();
            var skeleton=new SerializedObject(skeletonComponent);skeleton.FindProperty("_skeletonType").intValue=skeletonType;
            skeleton.FindProperty("_updateRootPose").boolValue=true;skeleton.ApplyModifiedPropertiesWithoutUndo();
            var mesh=new SerializedObject(meshComponent);mesh.FindProperty("_meshType").intValue=meshType;mesh.ApplyModifiedPropertiesWithoutUndo();
            foreach(var renderer in controller.GetComponentsInChildren<Renderer>(true))renderer.forceRenderingOff=true;
            hand.GetComponent<SkinnedMeshRenderer>().forceRenderingOff=true;
            controller.SetActive(false); // No first-frame model before tracking and SDK initialization.
            hand.SetActive(false); // Android SDK mesh Awake must wait for a live runtime hand.
            var visual=new GameObject(left?"Left tracked input":"Right tracked input").AddComponent<SpatialInputVisual>();
            visual.transform.SetParent(rig.trackingSpace,false);visual.Rig=rig;visual.Left=left;visual.Controller=helper;visual.HandTemplate=provider;
            PrefabUtility.RecordPrefabInstancePropertyModifications(helper);PrefabUtility.RecordPrefabInstancePropertyModifications(provider);
            PrefabUtility.RecordPrefabInstancePropertyModifications(hand);PrefabUtility.RecordPrefabInstancePropertyModifications(hand.transform);
            PrefabUtility.RecordPrefabInstancePropertyModifications(skeletonComponent);PrefabUtility.RecordPrefabInstancePropertyModifications(meshComponent);
            PersistHandType(hand,skeletonComponent,"_skeletonType",skeletonType);
            PersistHandType(hand,meshComponent,"_meshType",meshType);
        }
        private static void PersistHandType(GameObject hand,Component component,string property,int value)
        {
            var source=PrefabUtility.GetCorrespondingObjectFromSource(component);
            var mods=(PrefabUtility.GetPropertyModifications(hand)??Array.Empty<PropertyModification>())
                .Where(m=>m.target!=source||m.propertyPath!=property).ToList();
            mods.Add(new PropertyModification{target=source,propertyPath=property,value=value.ToString(System.Globalization.CultureInfo.InvariantCulture)});
            PrefabUtility.SetPropertyModifications(hand,mods.ToArray());
        }
        public static void CompileCheck()=>Debug.Log("Spatial native scripts compiled.");
        public static void BuildAndroid()
        {
            Configure();Directory.CreateDirectory("artifacts");
            var report=BuildPipeline.BuildPlayer(new BuildPlayerOptions{scenes=new[]{Scene},locationPathName="artifacts/spatial-workspace.apk",target=BuildTarget.Android,options=BuildOptions.None});
            File.WriteAllText("artifacts/build-summary.json",JsonUtility.ToJson(new Summary{unity=Application.unityVersion,result=report.summary.result.ToString(),errors=report.summary.totalErrors,warnings=report.summary.totalWarnings,bytes=report.summary.totalSize,seconds=report.summary.totalTime.TotalSeconds},true));
            if(report.summary.result!=BuildResult.Succeeded)throw new BuildFailedException("Spatial APK failed; inspect artifacts/build.log.");
        }
        [Serializable]private sealed class Summary{public string unity,result;public int errors,warnings;public ulong bytes;public double seconds;}
    }
}
