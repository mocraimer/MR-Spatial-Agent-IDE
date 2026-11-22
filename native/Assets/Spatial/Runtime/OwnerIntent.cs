using System;
using System.Text.RegularExpressions;

namespace Spatial.Native
{
    public static class OwnerIntent
    {
        // Called only for owner text entry, never agent/content text. Voice uses the trusted acknowledgment identity.
        public static bool OpenGlobalInbox(string text)
        {
            string value=Regex.Replace((text??"").Trim().TrimEnd('.', '!', '?').Trim(),@"\s+"," ");
            return value.Equals("open my global inbox",StringComparison.OrdinalIgnoreCase)||
                value.Equals("open global inbox",StringComparison.OrdinalIgnoreCase)||
                value.Equals("open all projects inbox",StringComparison.OrdinalIgnoreCase);
        }
    }
}
