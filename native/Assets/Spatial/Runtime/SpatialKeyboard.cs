using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace Spatial.Native
{
    // Built once per edit; shift and symbols change existing keys, not collider trees.
    public sealed class SpatialKeyboard
    {
        public readonly GameObject Root;
        private readonly SpatialTextEntry entry;
        private readonly Text value, status;
        private readonly List<Text> letters = new List<Text>();
        private readonly List<GameObject> letterKeys = new List<GameObject>(), symbolKeys = new List<GameObject>();
        private readonly Text shiftLabel, symbolsLabel;
        private readonly SpatialTarget previous, next;
        private int page;
        private const int PageSize = 80;
        public SpatialKeyboard(Transform parent, string prompt, SpatialTextEntry entry, Action done, Action cancel)
        {
            this.entry = entry;
            var panel = new WorldSurface(parent, "Text entry", new Vector3(0,1.4f,1.45f), 0, 900, 670);
            Root = panel.Root;
            // Keys sit in front of this blocker. Blank panel regions never hit the workspace.
            var blocker = Root.AddComponent<BoxCollider>(); blocker.center = new Vector3(0,0,8); blocker.size = new Vector3(900,670,5);
            panel.Label(prompt,20,16,860,62,27);
            value = panel.Label("",20,85,860,108,22);
            status = panel.Label("",20,200,860,35,18,new Color(.64f,.87f,.88f));
            for (int i = 0; i < 10; i++)
            {
                string digit = "1234567890".Substring(i,1);
                Key(panel,digit,20+i*86,246,78,()=>Change(()=>entry.Append(digit)));
            }
            const string alphabet = "qwertyuiopasdfghjklzxcvbnm";
            for (int i = 0; i < alphabet.Length; i++)
            {
                string letter = alphabet.Substring(i,1);
                var key = Key(panel,letter,20+(i%10)*86,296+(i/10)*50,78,()=>Change(()=>entry.Letter(letter)));
                letterKeys.Add(key.gameObject); letters.Add(key.GetComponentInChildren<Text>());
            }
            const string symbols = ":/._-?=&%#@+~!$'\"()[]{}\\,;<>|`^*";
            for (int i = 0; i < symbols.Length; i++)
            {
                string symbol = symbols.Substring(i,1);
                var key = Key(panel,symbol,20+(i%10)*86,296+(i/10)*50,78,()=>Change(()=>entry.Append(symbol)));
                symbolKeys.Add(key.gameObject);
            }
            // Fourth row only on the symbols page; actions stay below it.
            shiftLabel = Key(panel,"Shift: off",20,506,155,()=>{entry.Shift();Refresh();}).GetComponentInChildren<Text>();
            symbolsLabel = Key(panel,"Symbols",185,506,145,()=>{entry.ToggleSymbols();Refresh();}).GetComponentInChildren<Text>();
            Key(panel,"Space",340,506,145,()=>Change(()=>entry.Append(" ")));
            Key(panel,"Backspace",495,506,190,()=>Change(entry.Backspace));
            Key(panel,"Clear",695,506,185,()=>Change(entry.Clear));
            previous = Key(panel,"Previous text",20,563,195,()=>{page--;Refresh();});
            next = Key(panel,"Next text",225,563,195,()=>{page++;Refresh();});
            Key(panel,"Done",430,563,215,done); Key(panel,"Cancel",655,563,225,cancel);
            panel.Label("Edits append at the end. Done confirms this field; Cancel discards it.",20,622,860,36,18);
            page = Pages - 1; Refresh();
        }
        private static SpatialTarget Key(WorldSurface panel,string label,float x,float y,float width,Action action)
        {
            panel.Button(label,x,y,width,action);
            return panel.Content.GetChild(panel.Content.childCount-1).GetComponent<SpatialTarget>();
        }
        private int Pages => Math.Max(1,(entry.Length+PageSize-1)/PageSize);
        private void Change(Action action) { action(); page = Pages-1; Refresh(); }
        private void Refresh()
        {
            page = Math.Max(0,Math.Min(page,Pages-1));
            value.text = entry.Page(page,PageSize).Replace("\n","↵").Replace("\r","↵").Replace("\t","⇥");
            status.text = (entry.Secure ? "Masked value" : "Value")+" · "+entry.Length+" characters · page "+(page+1)+" / "+Pages+" · editing at end";
            for (int i=0;i<letters.Count;i++) letters[i].text = entry.Uppercase ? letters[i].text.ToUpperInvariant() : letters[i].text.ToLowerInvariant();
            foreach (var key in letterKeys) key.SetActive(!entry.Symbols);
            foreach (var key in symbolKeys) key.SetActive(entry.Symbols);
            shiftLabel.text = entry.Uppercase ? "Shift: ON" : "Shift: off";
            symbolsLabel.text = entry.Symbols ? "Letters" : "Symbols";
            EnablePage(previous,page>0); EnablePage(next,page<Pages-1);
        }
        private static void EnablePage(SpatialTarget target,bool enabled)
        {
            target.enabled = enabled; target.GetComponent<Collider>().enabled = enabled;
            target.GetComponent<Image>().color = enabled ? new Color(.15f,.27f,.32f) : new Color(.12f,.16f,.19f);
            target.GetComponentInChildren<Text>().color = enabled ? Color.white : Color.gray;
        }
        public void Dispose()
        {
            Root.SetActive(false);
            foreach (var collider in Root.GetComponentsInChildren<Collider>(true)) collider.enabled = false;
            // Deferred Destroy must leave no live callback or secure draft visible/retained.
            foreach (var target in Root.GetComponentsInChildren<SpatialTarget>(true)) { target.Activate = null; target.Point = null; }
            foreach (var label in Root.GetComponentsInChildren<Text>(true)) label.text = "";
            UnityEngine.Object.Destroy(Root);
        }
    }
}
