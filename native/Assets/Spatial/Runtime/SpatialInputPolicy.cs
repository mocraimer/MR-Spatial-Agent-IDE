namespace Spatial.Native
{
    public enum SpatialInputMode { None, Controller, Hand }

    // A held button/pinch at acquisition is not a new owner action.
    public sealed class SpatialInputPolicy
    {
        public SpatialInputMode Mode { get; private set; }
        public bool Armed { get; private set; }
        private bool held;
        public bool Step(SpatialInputMode mode, bool pressed)
        {
            if (mode != Mode || mode == SpatialInputMode.None)
            { Mode = mode; Armed = false; held = pressed; }
            if (mode == SpatialInputMode.None) return false;
            if (!pressed) Armed = true;
            bool select = Armed && pressed && !held;
            held = pressed;
            return select;
        }
        public static SpatialInputMode Resolve(bool focus, bool controllerTracked, bool handTracked, bool controllerHeld)
        {
            if (!focus) return SpatialInputMode.None;
            if (controllerTracked && (controllerHeld || !handTracked)) return SpatialInputMode.Controller;
            return handTracked ? SpatialInputMode.Hand : SpatialInputMode.None;
        }
    }
}
