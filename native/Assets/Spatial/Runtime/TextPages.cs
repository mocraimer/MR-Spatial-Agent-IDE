using System.Collections.Generic;

namespace Spatial.Native
{
    /// <summary>Conservative pages fit the retained-detail panel, including newline-heavy evidence.</summary>
    public static class TextPages
    {
        public static string[] Split(string text)
        {
            text=text??"";
            var pages=new List<string>();int start=0,column=0,lines=1;
            for(int i=0;i<text.Length;i++)
            {
                char c=text[i];
                if(c=='\n'){lines++;column=0;}
                else if(++column>38){lines++;column=1;}
                if(lines>16)
                {
                    pages.Add(text.Substring(start,i-start));start=i;lines=1;column=c=='\n'?0:1;
                }
            }
            pages.Add(text.Substring(start));return pages.ToArray();
        }
    }
}
