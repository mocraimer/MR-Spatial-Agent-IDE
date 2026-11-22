using Newtonsoft.Json;

namespace Spatial.Native
{
    // Unity's JsonUtility turns wire null records into zero-filled inline objects. That breaks nullable
    // task layout/receiver identities and can hide a window at scale zero. Use the supported Unity JSON package.
    public static class WireJson
    {
        private static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            TypeNameHandling = TypeNameHandling.None,
            MetadataPropertyHandling = MetadataPropertyHandling.Ignore,
            MaxDepth = 32,
            NullValueHandling = NullValueHandling.Include
        };
        public static T FromJson<T>(string json) => JsonConvert.DeserializeObject<T>(json, Settings);
        public static string ToJson(object value) => JsonConvert.SerializeObject(value, Settings);
    }
}
