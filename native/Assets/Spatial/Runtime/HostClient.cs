using System;
using System.Collections;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace Spatial.Native
{
    public static class PinPolicy
    {
        public static string Normalize(string value) => (value ?? "").Replace(":", "").Replace("-", "").Replace(" ", "").ToLowerInvariant();
        public static bool Valid(string value) { var pin = Normalize(value); if (pin.Length != 64) return false; foreach (var c in pin) if (!Uri.IsHexDigit(c)) return false; return true; }
        public static bool Matches(byte[] certificate, string pin)
        {
            if (certificate == null || !Valid(pin)) return false;
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(certificate); var expected = Normalize(pin); int difference = 0;
                for (int i = 0; i < hash.Length; i++) difference |= hash[i] ^ Convert.ToByte(expected.Substring(i * 2, 2), 16);
                return difference == 0;
            }
        }
        public static string Host(string value)
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/")
                throw new ArgumentException("Enter the HTTPS host origin only, such as https://host:7443. Get its SHA-256 certificate fingerprint from trusted host setup.");
            return uri.GetLeftPart(UriPartial.Authority);
        }
    }
    public sealed class PinnedCertificate : CertificateHandler
    {
        private readonly string pin;
        public PinnedCertificate(string fingerprint) { if (!PinPolicy.Valid(fingerprint)) throw new ArgumentException("Invalid SHA-256 certificate pin."); pin = fingerprint; }
        protected override bool ValidateCertificate(byte[] certificateData) => PinPolicy.Matches(certificateData, pin);
    }
    public sealed class HostReply
    {
        public bool ok; public long status; public byte[] bytes; public string text, frame, contentType, problem;
    }
    public sealed class HostClient : MonoBehaviour
    {
        public Pairing Pairing { get; private set; }
        public bool Connected { get; private set; }
        public event Action<Snapshot> SnapshotReceived;
        public event Action<string> StatusChanged;
        public event Action PairingChanged;
        private Coroutine polling; private int connectionEpoch;
        private long observedRevision = -1;
        internal int ConnectionEpoch => connectionEpoch;
        internal bool Deliver(int epoch, HostReply reply, Action<HostReply> receive)
        {
            if (epoch != connectionEpoch) return false;
            receive(reply); return true;
        }
        internal void ReplacePairing(Pairing candidate)
        {
            bool changed = Pairing?.host != candidate?.host || Pairing?.fingerprint != candidate?.fingerprint ||
                Pairing?.clientId != candidate?.clientId || Pairing?.token != candidate?.token;
            Suspend(); Pairing = candidate;
            if (changed) { observedRevision = -1; PairingChanged?.Invoke(); }
        }
        internal bool Observe(int epoch, Snapshot snapshot)
        {
            if (epoch != connectionEpoch || Pairing == null || snapshot.revision < observedRevision) return false;
            observedRevision = snapshot.revision; Connected = true;
            SetStatus("Connected · observed host revision " + observedRevision); SnapshotReceived?.Invoke(snapshot); return true;
        }
        public string Status { get; private set; } = "Not paired. Open trusted host setup for an HTTPS origin, certificate fingerprint and one-time code.";
        public void SetStatus(string status) { if(Status==status)return;Status = status; StatusChanged?.Invoke(status); }
        public void Initialize()
        {
            try { var json = PrivateStore.Load(); if (!string.IsNullOrEmpty(json)) Pairing = WireJson.FromJson<Pairing>(json); }
            catch { SetStatus("Device pairing storage is unavailable. Remove pairing and pair again; no insecure storage fallback."); }
            if (Pairing != null) Reconnect();
        }
        public IEnumerator Pair(string host, string fingerprint, string code)
        {
            string origin;
            try { origin = PinPolicy.Host(host); if (!PinPolicy.Valid(fingerprint) || string.IsNullOrWhiteSpace(code)) throw new ArgumentException("Enter the trusted host fingerprint and unused pairing code."); }
            catch (ArgumentException error) { SetStatus(error.Message); yield break; }
            Suspend(); SetStatus("Pairing with trusted host…");
            int epoch = connectionEpoch;
            var candidate = new Pairing { host = origin, fingerprint = PinPolicy.Normalize(fingerprint) };
            HostReply reply = null;
            yield return SendWith(candidate, epoch, "POST", "/v1/pair", WireJson.ToJson(new PairRequest { code = code, label = "Quest 3 native" }), r => reply = r);
            if (reply == null) yield break;
            if (!reply.ok) { SetStatus(reply.problem); yield break; }
            var result = WireJson.FromJson<PairResponse>(reply.text);
            if (result == null || result.protocolVersion != 1 || string.IsNullOrEmpty(result.token)) { SetStatus("Host returned incompatible pairing. Update host/client and generate another code."); yield break; }
            candidate.token = result.token; candidate.clientId = result.clientId;
            try { PrivateStore.Save(WireJson.ToJson(candidate)); }
            catch { SetStatus("Could not protect pairing with device Keystore. Pairing was not saved. Check device storage; generate a new code."); yield break; }
            ReplacePairing(candidate); Reconnect();
        }
        public void Forget()
        {
            ReplacePairing(null); PrivateStore.Clear(); SetStatus("Pairing removed from device. Revoke this client on host setup too.");
        }
        public void Suspend() { Connected = false; connectionEpoch++; if (polling != null) StopCoroutine(polling); polling = null; }
        public void Reconnect() { Suspend(); if (Pairing != null) polling = StartCoroutine(Poll(connectionEpoch)); }
        private IEnumerator Poll(int epoch)
        {
            long revision = -1;
            while (epoch == connectionEpoch && Pairing != null)
            {
                HostReply reply = null;
                yield return Send("GET", revision < 0 ? "/v1/snapshot" : "/v1/events?after=" + revision, null, r => reply = r);
                if (epoch != connectionEpoch) yield break;
                if (!reply.ok)
                {
                    Connected = false; SetStatus(reply.problem); revision = -1;
                    if (reply.status == 401 || reply.status == 403) { SetStatus("Pairing expired or revoked. Remove pairing and pair using trusted host setup."); yield break; }
                    yield return new WaitForSecondsRealtime(3); continue;
                }
                Snapshot snapshot = null;
                try { snapshot = WireJson.FromJson<Snapshot>(reply.text); if (snapshot == null || snapshot.protocolVersion != 1) throw new InvalidOperationException(); }
                catch { Connected = false; SetStatus("Host protocol is incompatible. Update host and headset client together."); yield break; }
                if (!Observe(epoch, snapshot)) { SetStatus("Older host snapshot ignored. Reconnect or check host recovery; observed revision is retained."); }
                revision = observedRevision;
                yield return new WaitForSecondsRealtime(0.15f);
            }
        }
        public IEnumerator Send(string method, string route, string body, Action<HostReply> receive)
        {
            if (Pairing == null) { receive(new HostReply { problem = "Not paired. Use trusted host setup." }); yield break; }
            yield return SendWith(Pairing, connectionEpoch, method, route, body, receive);
        }
        private IEnumerator SendWith(Pairing pairing, int epoch, string method, string route, string body, Action<HostReply> receive)
        {
            if (!route.StartsWith("/v1/", StringComparison.Ordinal)) throw new ArgumentException("Only product API routes are allowed.");
            using (var request = new UnityWebRequest(PinPolicy.Host(pairing.host) + route, method))
            {
                request.downloadHandler = new DownloadHandlerBuffer(); request.certificateHandler = new PinnedCertificate(pairing.fingerprint);
                request.redirectLimit = 0; request.timeout = 40;
                if (!string.IsNullOrEmpty(pairing.token)) request.SetRequestHeader("Authorization", "Bearer " + pairing.token);
                if (body != null) { request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body)); request.SetRequestHeader("Content-Type", "application/json"); }
                yield return request.SendWebRequest();
                string mime=request.GetResponseHeader("Content-Type")??"";
                bool isText=mime.StartsWith("text/",StringComparison.OrdinalIgnoreCase)||mime.IndexOf("json",StringComparison.OrdinalIgnoreCase)>=0||request.result!=UnityWebRequest.Result.Success;
                var reply = new HostReply { ok = request.result == UnityWebRequest.Result.Success, status = request.responseCode,
                    bytes = request.downloadHandler.data, text = isText?request.downloadHandler.text:null,
                    frame = request.GetResponseHeader("X-Frame-Identity"), contentType = mime };
                if (!reply.ok)
                {
                    ApiError error = null; try { error = WireJson.FromJson<ApiError>(reply.text); } catch { }
                    reply.problem = !string.IsNullOrEmpty(error?.recovery) ? error.detail + "\n" + error.recovery :
                        "Host request failed (" + reply.status + "). Check host availability, HTTPS origin and trusted certificate fingerprint, then reconnect. No operation is assumed complete.";
                }
                Deliver(epoch, reply, receive);
            }
        }
        private void OnDestroy() => Suspend();
        public static string Id(string value) => Uri.EscapeDataString(value ?? "");
    }
    public static class PrivateStore
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        private static AndroidJavaObject Context { get { using (var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer")) return player.GetStatic<AndroidJavaObject>("currentActivity"); } }
        public static string Load() { using (var api = new AndroidJavaClass("local.spatial.workspace.PairingVault")) using (var context = Context) return api.CallStatic<string>("load", context); }
        public static void Save(string json) { using (var api = new AndroidJavaClass("local.spatial.workspace.PairingVault")) using (var context = Context) api.CallStatic("save", context, json); }
        public static void Clear() { using (var api = new AndroidJavaClass("local.spatial.workspace.PairingVault")) using (var context = Context) api.CallStatic("clear", context); }
#else
        private static string memory;
        public static string Load() => memory;
        public static void Save(string json) => memory = json;
        public static void Clear() => memory = null;
#endif
    }
}
