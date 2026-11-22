using NUnit.Framework;

namespace Spatial.Native.Tests
{
    public sealed class SpatialTextEntryTests
    {
        [Test] public void AppendCaseSymbolsSpaceAndBackspaceAreExact()
        {
            var entry=new SpatialTextEntry("https://例.test/");
            entry.Letter("a");entry.Shift();entry.Letter("f");entry.Append("09 :/-._?=&%#@+[]\\");
            Assert.That(entry.Value,Is.EqualTo("https://例.test/aF09 :/-._?=&%#@+[]\\"));
            entry.ToggleSymbols();Assert.That(entry.Symbols,Is.True);entry.ToggleSymbols();Assert.That(entry.Symbols,Is.False);
            entry.Shift();entry.Letter("Z");entry.Backspace();
            Assert.That(entry.Value,Is.EqualTo("https://例.test/aF09 :/-._?=&%#@+[]\\"));
            entry.Clear();entry.Backspace();Assert.That(entry.Value,Is.Empty);
        }
        [Test] public void UnicodeSurrogatesAndCombiningMarksStayIntact()
        {
            var entry=new SpatialTextEntry("日本語😀e\u0301");
            Assert.That(entry.Length,Is.EqualTo(5));Assert.That(entry.Page(0,4),Is.EqualTo("日本語😀"));
            entry.Backspace();Assert.That(entry.Value,Is.EqualTo("日本語😀"));
            entry.Backspace();Assert.That(entry.Value,Is.EqualTo("日本語"));
            entry.Append("é\n\t");Assert.That(entry.Finish(out var text),Is.True);Assert.That(text,Is.EqualTo("日本語é\n\t"));
        }
        [Test] public void SecurePagesMaskAllValuesAndLongValuesAreNotTruncated()
        {
            var initial=new string('f',256)+"😀";
            var entry=new SpatialTextEntry(initial,true);
            Assert.That(entry.Page(0,80),Is.EqualTo(new string('*',80)));
            Assert.That(entry.Page(3,80),Is.EqualTo(new string('*',17)));
            Assert.That(entry.Page(4,80),Is.Empty);Assert.That(entry.Value,Is.EqualTo(initial));
            Assert.That(entry.Finish(out var exact),Is.True);Assert.That(exact,Is.EqualTo(initial));Assert.That(entry.Value,Is.Empty);
        }
        [Test] public void FinishOnceReleasesDraftAndRejectsFurtherEditing()
        {
            var entry=new SpatialTextEntry(" value \n");
            Assert.That(entry.Finish(out var exact),Is.True);Assert.That(exact,Is.EqualTo(" value \n"));
            Assert.That(entry.Finish(out var duplicate),Is.False);Assert.That(duplicate,Is.Null);
            entry.Append("ignored");entry.Letter("a");entry.Shift();entry.ToggleSymbols();entry.Backspace();
            Assert.That(entry.Active,Is.False);Assert.That(entry.Value,Is.Empty);Assert.That(entry.Uppercase||entry.Symbols,Is.False);
        }
        [Test] public void CancelReleasesSecureDraftWithoutFinish()
        {
            var entry=new SpatialTextEntry("private-code",true);entry.Shift();entry.ToggleSymbols();entry.Cancel();entry.Cancel();
            Assert.That(entry.Value,Is.Empty);Assert.That(entry.Finish(out var text),Is.False);Assert.That(text,Is.Null);
            Assert.That(entry.Uppercase||entry.Symbols,Is.False);
        }
        [Test] public void NullInitialAndEmptyDoneAreSupported()
        {
            var entry=new SpatialTextEntry(null);Assert.That(entry.Page(0,80),Is.Empty);
            Assert.That(entry.Finish(out var text),Is.True);Assert.That(text,Is.Empty);
        }
    }
}
