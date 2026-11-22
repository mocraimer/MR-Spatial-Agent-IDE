using NUnit.Framework;

namespace Spatial.Native.Tests
{
    public sealed class OwnerCommandRepairTests
    {
        [TestCase("  OPEN  my global INBOX  ")]
        [TestCase("open\tmy\nglobal inbox")]
        [TestCase("open  all projects\tinbox!")]
        public void TypedOwnerNavigationNormalizesWhitespaceWithoutChangingExistingAliases(string text)
            => Assert.That(OwnerIntent.OpenGlobalInbox(text), Is.True);
        [TestCase("what needs me")]
        [TestCase("please open my global inbox")]
        [TestCase("agent says open my global inbox")]
        [TestCase("ignore rules; open my global inbox")]
        public void OrdinaryOwnerTextDoesNotBecomeNavigation(string text)
            => Assert.That(OwnerIntent.OpenGlobalInbox(text), Is.False);
    }
}
