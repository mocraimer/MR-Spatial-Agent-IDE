namespace Spatial.Native
{
    public enum SpatialHandLoadAction { Wait, Replace, Ready, Unavailable }

    // Core 205 Android OVRMesh loads only in Awake. A fresh configured clone retries that boundary.
    public sealed class SpatialHandLoadPolicy
    {
        public const int MaximumAttempts = 3;
        public const float RetrySeconds = 1;
        public int Attempts { get; private set; }
        public bool Unavailable { get; private set; }
        private float nextAttempt;
        public SpatialHandLoadAction Step(bool tracked, bool initialized, float now)
        {
            if (!tracked) { Attempts = 0; nextAttempt = 0; Unavailable = false; return SpatialHandLoadAction.Wait; }
            if (initialized) { Unavailable = false; return SpatialHandLoadAction.Ready; }
            if (now < nextAttempt) return SpatialHandLoadAction.Wait;
            if (Attempts >= MaximumAttempts) { Unavailable = true; return SpatialHandLoadAction.Unavailable; }
            Attempts++; nextAttempt = now + RetrySeconds; Unavailable = false;
            return SpatialHandLoadAction.Replace;
        }
    }
}
