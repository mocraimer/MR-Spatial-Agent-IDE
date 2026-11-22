using System.Globalization;

namespace Spatial.Native
{
    // A single local draft. Ending releases it before any owner callback runs.
    public sealed class SpatialTextEntry
    {
        public string Value { get; private set; }
        public bool Secure { get; }
        public bool Active { get; private set; } = true;
        public bool Uppercase { get; private set; }
        public bool Symbols { get; private set; }
        public int Length => StringInfo.ParseCombiningCharacters(Value).Length;
        public SpatialTextEntry(string initial, bool secure = false) { Value = initial ?? ""; Secure = secure; }
        public void Append(string text) { if (Active) Value += text; }
        public void Letter(string letter) => Append(Uppercase ? letter.ToUpperInvariant() : letter.ToLowerInvariant());
        public void Shift() { if (Active) Uppercase = !Uppercase; }
        public void ToggleSymbols() { if (Active) Symbols = !Symbols; }
        public void Backspace()
        {
            if (!Active || Value.Length == 0) return;
            var starts = StringInfo.ParseCombiningCharacters(Value);
            Value = Value.Substring(0, starts[starts.Length - 1]);
        }
        public void Clear() { if (Active) Value = ""; }
        public string Page(int page, int size)
        {
            var starts = StringInfo.ParseCombiningCharacters(Value);
            int first = page * size;
            if (first < 0 || first >= starts.Length) return "";
            int count = System.Math.Min(size, starts.Length - first);
            if (Secure) return new string('*', count);
            int end = first + count < starts.Length ? starts[first + count] : Value.Length;
            return Value.Substring(starts[first], end - starts[first]);
        }
        public bool Finish(out string value)
        {
            value = null;
            if (!Active) return false;
            value = Value; Cancel(); return true;
        }
        public void Cancel() { Active = false; Value = ""; Uppercase = Symbols = false; }
    }
}
