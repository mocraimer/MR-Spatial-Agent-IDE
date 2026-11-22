using System;
using System.Collections.Generic;

namespace Spatial.Native
{
    // Turn time comes from the explicit PCM sample count, not frame timing or microphone IO.
    public sealed class VoiceTurnDetector
    {
        public const int Rate = 16000, MinimumSamples = Rate / 5, MaximumSamples = Rate * 25, SilenceSamples = Rate * 4 / 5;
        public const float Threshold = .015f;
        private readonly List<float> samples = new List<float>();
        private int quietSamples;
        public int SampleCount => samples.Count;
        public float QuietSeconds => (float)quietSamples / Rate;
        public bool CanSubmit => SampleCount >= MinimumSamples;
        public static bool HasOnset(float[] data)
        {
            foreach (float value in data) if (Math.Abs(value) >= Threshold) return true;
            return false;
        }
        public bool Add(float[] data, bool handsFree)
        {
            samples.AddRange(data); quietSamples = HasOnset(data) ? 0 : quietSamples + data.Length;
            return SampleCount >= MaximumSamples || (handsFree && quietSamples >= SilenceSamples);
        }
        public float[] CopySamples() => samples.ToArray();
        public void Reset() { samples.Clear(); quietSamples = 0; }
    }
}
