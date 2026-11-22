using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace Spatial.Native.Editor
{
    public sealed class PackagePrivacy : IPreprocessBuildWithReport, IPostprocessBuildWithReport
    {
        // Meta SDK's order-1 callback injects editor bridge credentials even when its dev agent is off.
        // Scrub after that callback, before player asset collection, and again after SDK restoration.
        public int callbackOrder=>10000;
        [InitializeOnLoadMethod]private static void Watch(){EditorApplication.update-=Tick;EditorApplication.update+=Tick;}
        private static void Tick(){if(!EditorApplication.isCompiling&&!EditorApplication.isUpdating)Scrub();}
        public static void Scrub()
        {
            Clear("Assets/Resources/DevAgentSettings.asset",new[]{"enabled"},new[]{"accessToken","serverAddress","witClientAccessToken"});
            Clear("Assets/Resources/ImmersiveDebuggerSettings.asset",new[]{"immersiveDebuggerEnabled","immersiveDebuggerDisplayAtStartup"},System.Array.Empty<string>());
        }
        private static void Clear(string path,string[] flags,string[] secrets)
        {
            var asset=AssetDatabase.LoadAssetAtPath<Object>(path);if(asset==null)return;
            var record=new SerializedObject(asset);bool changed=false;
            foreach(string name in flags){var field=record.FindProperty(name);if(field==null)throw new BuildFailedException("SDK privacy field changed: "+name);if(field.boolValue){field.boolValue=false;changed=true;}}
            foreach(string name in secrets){var field=record.FindProperty(name);if(field==null)throw new BuildFailedException("SDK privacy field changed: "+name);if(!string.IsNullOrEmpty(field.stringValue)){field.stringValue="";changed=true;}}
            if(changed){record.ApplyModifiedPropertiesWithoutUndo();AssetDatabase.SaveAssetIfDirty(asset);}
        }
        public void OnPreprocessBuild(BuildReport report){Scrub();Debug.Log("Native SDK privacy: developer assistant/debugger off; editor bridge credential/address fields cleared before packaging.");}
        public void OnPostprocessBuild(BuildReport report)=>Scrub();
    }
}
