using System;
using UnityEngine;
using UnityEngine.UI;

namespace Spatial.Native
{
    public sealed class WorldSurface
    {
        public readonly GameObject Root;
        public readonly RectTransform Content;
        private static Font font;
        public const float Unit = .002f;
        public WorldSurface(Transform parent, string name, Vector3 position, float yaw, float width, float height, bool background = true)
        {
            Root = new GameObject(name, typeof(RectTransform), typeof(Canvas)); Root.transform.SetParent(parent, false);
            Root.transform.localPosition = position; Root.transform.localRotation = Quaternion.Euler(0, yaw, 0); Root.transform.localScale = Vector3.one * Unit;
            var canvas = Root.GetComponent<Canvas>(); canvas.renderMode = RenderMode.WorldSpace;
            Content = Root.GetComponent<RectTransform>(); Content.sizeDelta = new Vector2(width, height);
            if (background) Root.AddComponent<Image>().color = new Color(.075f, .13f, .17f, .97f);
            if (font == null) font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        }
        private RectTransform Rect(string name, float x, float y, float width, float height)
        {
            var obj = new GameObject(name, typeof(RectTransform)); var rect = obj.GetComponent<RectTransform>(); rect.SetParent(Content, false);
            rect.anchorMin = rect.anchorMax = new Vector2(0, 1); rect.pivot = new Vector2(0, 1); rect.anchoredPosition = new Vector2(x, -y); rect.sizeDelta = new Vector2(width, height); return rect;
        }
        public Text Label(string text, float x, float y, float width, float height, int size = 22, Color? color = null)
        {
            var label = Rect("Text", x, y, width, height).gameObject.AddComponent<Text>(); label.font = font; label.fontSize = size; label.supportRichText = false; label.text = text ?? "";
            label.color = color ?? new Color(.9f, .94f, .95f); label.alignment = TextAnchor.UpperLeft; label.horizontalOverflow = HorizontalWrapMode.Wrap; label.verticalOverflow = VerticalWrapMode.Truncate; return label;
        }
        public void Button(string text, float x, float y, float width, Action action, bool enabled = true)
        {
            var rect = Rect("Owner action", x, y, width, 42); rect.gameObject.AddComponent<Image>().color = enabled ? new Color(.15f,.27f,.32f) : new Color(.12f,.16f,.19f);
            var label = new GameObject("Label", typeof(RectTransform)).GetComponent<RectTransform>(); label.SetParent(rect, false); label.anchorMin = Vector2.zero; label.anchorMax = Vector2.one; label.offsetMin = new Vector2(9, 0); label.offsetMax = new Vector2(-5, 0);
            var t = label.gameObject.AddComponent<Text>(); t.font = font; t.fontSize = 19; t.supportRichText = false; t.text = text; t.color = enabled ? Color.white : Color.gray; t.alignment = TextAnchor.MiddleLeft;
            if (enabled) { var collider = rect.gameObject.AddComponent<BoxCollider>(); collider.center = new Vector3(width / 2, -21, 0); collider.size = new Vector3(width,42,5); rect.gameObject.AddComponent<SpatialTarget>().Activate = action; }
        }
        public RawImage Frame(Texture texture, float x, float y, float width, float height, Action<Vector2> click)
        {
            var rect = Rect("Actual task frame", x, y, width, height); rect.pivot = new Vector2(.5f,.5f); rect.anchoredPosition = new Vector2(x+width/2,-y-height/2);
            var image = rect.gameObject.AddComponent<RawImage>(); image.texture = texture; image.color = Color.white;
            if (click != null) { var collider = rect.gameObject.AddComponent<BoxCollider>(); collider.size = new Vector3(width,height,5); var target = rect.gameObject.AddComponent<SpatialTarget>(); target.Width = width; target.Height = height; target.Point = click; }
            return image;
        }
    }
}
