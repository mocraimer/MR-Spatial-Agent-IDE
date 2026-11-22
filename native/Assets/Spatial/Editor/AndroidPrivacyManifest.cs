using System.IO;
using System.Xml;
using UnityEditor.Android;

namespace Spatial.Native.Editor
{
    // Patch only this build's generated manifest; never device/global Android settings.
    public sealed class AndroidPrivacyManifest : IPostGenerateGradleAndroidProject
    {
        public int callbackOrder => 1000;
        public void OnPostGenerateGradleAndroidProject(string path)
        {
            var manifest=Path.Combine(path,"src/main/AndroidManifest.xml");var xml=new XmlDocument();xml.Load(manifest);
            var application=(XmlElement)xml.SelectSingleNode("/manifest/application");
            const string android="http://schemas.android.com/apk/res/android";
            application.SetAttribute("allowBackup",android,"false");
            application.SetAttribute("fullBackupContent",android,"false");
            application.SetAttribute("usesCleartextTraffic",android,"false");
            var metadata=(XmlElement)xml.SelectSingleNode("/manifest/application/meta-data[@*[local-name()='name']='unityplayer.SkipPermissionsDialog']");
            if(metadata==null){metadata=xml.CreateElement("meta-data");application.AppendChild(metadata);}
            metadata.SetAttribute("name",android,"unityplayer.SkipPermissionsDialog");metadata.SetAttribute("value",android,"true");
            xml.Save(manifest);
        }
    }
}
