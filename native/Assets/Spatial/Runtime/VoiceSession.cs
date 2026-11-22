using System;
using System.Collections;
using System.IO;
using UnityEngine;
#if UNITY_ANDROID
using UnityEngine.Android;
#endif

namespace Spatial.Native
{
    public sealed class VoiceSession : MonoBehaviour
    {
        public readonly VoiceGate Gate = new VoiceGate();
        public Func<Receiver> CurrentReceiver;
        public Action<VoiceRequest> Submit;
        public Action<string> Changed;
        public bool HandsFree { get; internal set; }
        public bool SpokenReplies { get; private set; }
        public string Status { get; private set; } = "Microphone off · spoken replies off";
        private AudioClip capture; private string device; private int cursor;
        private readonly VoiceTurnDetector turn = new VoiceTurnDetector();
        private float speakingTail; private bool ptt; private AudioSource output;
        private const int Rate = VoiceTurnDetector.Rate;
        public void Initialize() { output = gameObject.AddComponent<AudioSource>(); output.playOnAwake = false; output.spatialBlend = 0; Gate.Session = true; }
        private void Report(string status) { Status = status; Changed?.Invoke(status); }
        public void Enable(bool handsFree)
        {
            StopCapture(); Gate.Enabled = true; HandsFree = handsFree;
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                Gate.Permission = false; Report("Microphone permission needed. Accept the device prompt or use Text.");
                var callbacks = new PermissionCallbacks();
                callbacks.PermissionGranted += _ => { if (!Gate.Enabled) return; Gate.Permission = true; Report("Microphone enabled · " + (HandsFree ? "hands-free" : "push to talk")); };
                callbacks.PermissionDenied += _ => { Gate.Enabled = false; Report("Microphone denied. Enable permission in app settings or use Text."); };
                Permission.RequestUserPermission(Permission.Microphone, callbacks); return;
            }
#endif
            Gate.Permission = true; Report("Microphone enabled · " + (handsFree ? "hands-free" : "push to talk"));
        }
        public void Disable() { Gate.Enabled = false; ptt = false; StopCapture(); Report("Microphone off"); }
        public void EnableSpokenReplies(bool enabled) { SpokenReplies = enabled; if (!enabled) StopOutput(); Report(enabled ? "Spoken replies enabled for this receiver only" : "Spoken replies off"); }
        public void SetSession(bool active) { Gate.Session = active; if (!active) { StopCapture(); StopOutput(); } }
        public void SetConnected(bool connected) { Gate.Connected = connected; if (!connected) { StopCapture(); StopOutput(); } }
        public void PushToTalk(bool down)
        {
            if (!Gate.CanCapture || HandsFree) return;
            ptt = down;
            if (down) { if (Gate.Begin(CurrentReceiver?.Invoke())) { turn.Reset(); Report("Recording · receiver fixed at onset"); } }
            else Finish();
        }
        public void CancelPushToTalk()
        {
            if (!ptt) return;
            StopCapture(); // Discard the turn, not Finish/Submit. Leave enable, permission and session unchanged.
            Report("Push to talk canceled · controller tracking or app focus lost. Press A again to start a new turn.");
        }
        private void Update()
        {
            if (output != null && !output.isPlaying && Gate.Speaking)
            {
                speakingTail -= Time.unscaledDeltaTime;
                if (speakingTail <= 0) { Gate.Speaking = false; if (output.clip != null) Destroy(output.clip); output.clip = null; Report("Reply stopped · microphone may resume"); }
            }
            if (!Gate.CanCapture || (!HandsFree && !ptt)) { if (capture != null) StopMicrophone(); return; }
            if (capture == null)
            {
                if (Microphone.devices.Length == 0) { Disable(); Report("No microphone available. Reconnect device or use Text."); return; }
                device = Microphone.devices[0]; capture = Microphone.Start(device, true, 2, Rate); cursor = 0;
                if (capture == null) { Disable(); Report("Microphone capture failed. Check permission or use Text."); return; }
            }
            int position = Microphone.GetPosition(device); if (position < 0) { Disable(); Report("Microphone session lost. Enable again or use Text."); return; }
            int count = (position - cursor + capture.samples) % capture.samples; if (count == 0) return;
            var data = new float[count]; capture.GetData(data, cursor); cursor = position;
            ProcessSamples(data);
        }
        internal void ProcessSamples(float[] data)
        {
            if (!Gate.CanCapture || (!HandsFree && !ptt)) return;
            if (HandsFree && Gate.Captured == null && VoiceTurnDetector.HasOnset(data))
            { if (Gate.Begin(CurrentReceiver?.Invoke())) { turn.Reset(); Report("Listening turn · receiver fixed at onset"); } }
            if (Gate.Captured == null) return;
            if (turn.Add(data, HandsFree)) Finish();
        }
        internal void Finish()
        {
            var recipient = Gate.End(); ptt = false;
            if (recipient != null && Gate.CanCapture && turn.CanSubmit)
            {
                var wav = WaveCodec.Encode(turn.CopySamples(), Rate);
                Submit?.Invoke(new VoiceRequest { idempotencyKey = Guid.NewGuid().ToString("N"), receiver = recipient, wavBase64 = Convert.ToBase64String(wav) });
                Array.Clear(wav, 0, wav.Length); Report("Turn sent · captured receiver retained");
            }
            else Report("No speech sent. Use Push to talk or Text.");
            turn.Reset(); StopMicrophone();
        }
        private void StopMicrophone() { if (capture != null) { Microphone.End(device); Destroy(capture); capture = null; cursor = 0; } }
        private void StopCapture() { Gate.Suppress(); turn.Reset(); ptt = false; StopMicrophone(); }
        public bool Play(byte[] wav, Receiver receiver)
        {
            if (!SpokenReplies || !Gate.Session || !Gate.Connected || receiver == null || !receiver.Same(CurrentReceiver?.Invoke())) return false;
            if (Gate.Captured != null) { Report("Reply retained as text while your captured turn is recording"); return false; }
            AudioClip clip;
            try { clip = WaveCodec.Decode(wav); }
            catch { Report("Reply audio format unavailable. Read the conversation; check host speech provider."); return false; }
            StopOutput(); StopCapture(); Gate.Speaking = true; speakingTail = 0.6f; output.clip = clip; output.Play(); Report("Speaking · microphone suppressed"); return true;
        }
        public void StopOutput()
        {
            if (output == null) return;
            bool hadOutput = Gate.Speaking || (output.clip != null && output.isPlaying);
            output.Stop(); if (output.clip != null) Destroy(output.clip); output.clip = null;
            // A navigation/stop action must not discard an input turn already captured for another receiver.
            if (hadOutput) { StopCapture(); Gate.Speaking = true; speakingTail = .6f; }
        }
        private void OnDestroy() { StopCapture(); StopOutput(); }
    }
    public static class WaveCodec
    {
        public static byte[] Encode(float[] samples, int rate)
        {
            using (var stream = new MemoryStream()) using (var writer = new BinaryWriter(stream))
            {
                writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + samples.Length * 2);
                writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16); writer.Write((short)1); writer.Write((short)1);
                writer.Write(rate); writer.Write(rate * 2); writer.Write((short)2); writer.Write((short)16);
                writer.Write(System.Text.Encoding.ASCII.GetBytes("data")); writer.Write(samples.Length * 2);
                foreach (float value in samples) writer.Write((short)(Mathf.Clamp(value, -1, 1) * 32767));
                return stream.ToArray();
            }
        }
        public static AudioClip Decode(byte[] wav)
        {
            using (var stream = new MemoryStream(wav)) using (var reader = new BinaryReader(stream))
            {
                if (new string(reader.ReadChars(4)) != "RIFF") throw new InvalidDataException(); reader.ReadInt32();
                if (new string(reader.ReadChars(4)) != "WAVE") throw new InvalidDataException();
                int rate = 0, channels = 0; byte[] data = null;
                while (stream.Position + 8 <= stream.Length)
                {
                    string id = new string(reader.ReadChars(4)); int size = reader.ReadInt32(); long end = stream.Position + size;
                    if (size < 0 || end > stream.Length) throw new InvalidDataException();
                    if (id == "fmt ") { if (size < 16 || reader.ReadInt16() != 1) throw new InvalidDataException(); channels = reader.ReadInt16(); rate = reader.ReadInt32(); reader.ReadInt32(); reader.ReadInt16(); if (reader.ReadInt16() != 16) throw new InvalidDataException(); }
                    if (id == "data") data = reader.ReadBytes(size);
                    stream.Position = end + (size & 1);
                }
                if (channels < 1 || channels > 2 || rate < 8000 || rate > 96000 || data == null || data.Length == 0 || data.Length % (channels * 2) != 0) throw new InvalidDataException();
                var values = new float[data.Length / 2]; for (int i = 0; i < values.Length; i++) values[i] = BitConverter.ToInt16(data, i * 2) / 32768f;
                var clip = AudioClip.Create("Host reply", values.Length / channels, channels, rate, false); clip.SetData(values, 0); return clip;
            }
        }
    }
}
