using System.Collections;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.TestTools;

namespace Spatial.Native.Tests
{
    public sealed class PushToTalkLossTests
    {
        private static void QueueHeld(Gamepad controller, bool delta, double time)
        {
            if (!delta) { InputSystem.QueueStateEvent(controller, new GamepadState().WithButton(GamepadButton.South), time); return; }
            // QueueDeltaStateEvent rejects bitfields; the SDK event factory includes the button's containing byte.
            using (DeltaStateEvent.From(controller.buttonSouth, out var inputEvent))
            {
                inputEvent.time = time; controller.buttonSouth.WriteValueIntoEvent(1f, inputEvent); InputSystem.QueueEvent(inputEvent);
            }
        }
        [UnityTest] public IEnumerator RejectedOldStateAndDeltaCannotUnlockResetZeroBeforePhysicalRelease()
        {
            var root = new GameObject("PTT rejected timestamp regression");
            var voice = root.AddComponent<VoiceSession>(); voice.enabled = false; voice.Initialize();
            var pointer = root.AddComponent<SpatialPointer>();
            pointer.PushToTalk = voice.PushToTalk; pointer.CancelPushToTalk = voice.CancelPushToTalk;
            var receiver = new Receiver { spaceId = "space", conversationId = "conversation" };
            voice.CurrentReceiver = () => receiver;
            voice.Gate.Enabled = true; voice.Gate.Permission = true; voice.Gate.Connected = true;
            var submissions = new List<VoiceRequest>(); voice.Submit = submissions.Add;
            var flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
            var talk = (InputAction)typeof(SpatialPointer).GetField("talk", flags).GetValue(pointer);
            talk.Disable(); talk.AddBinding("<Gamepad>/buttonSouth"); talk.Enable();
            var background = InputSystem.settings.backgroundBehavior;
            var editorFocus = InputSystem.settings.editorInputBehaviorInPlayMode;
            InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            InputSystem.settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
            var controller = InputSystem.AddDevice<Gamepad>();
            try
            {
                foreach (bool hard in new[] { false, true }) foreach (bool delta in new[] { false, true })
                {
                    int before = submissions.Count;
                    double time = System.Math.Max(controller.lastUpdateTime, Time.realtimeSinceStartupAsDouble) + .01;
                    InputSystem.QueueStateEvent(controller, new GamepadState(), time); InputSystem.Update();
                    pointer.ProcessPushToTalk(true, talk.IsPressed(), talk.WasReleasedThisFrame(), controller);
                    InputSystem.QueueStateEvent(controller, new GamepadState().WithButton(GamepadButton.South), time + .01); InputSystem.Update();
                    pointer.ProcessPushToTalk(true, talk.IsPressed(), talk.WasReleasedThisFrame(), controller);
                    voice.ProcessSamples(new float[3200]); Assert.That(voice.Gate.Captured, Is.Not.Null);
                    var acceptedTime = controller.lastUpdateTime;
                    InputSystem.ResetDevice(controller, hard);
                    Assert.That(voice.Gate.Captured, Is.Null); Assert.That(controller.buttonSouth.isPressed, Is.False);
                    QueueHeld(controller, delta, time);
                    InputSystem.Update();
                    Assert.That(controller.lastUpdateTime, Is.EqualTo(acceptedTime), "Old queued sample was rejected by Input System");
                    Assert.That(controller.buttonSouth.isPressed, Is.False, "Rejected event leaves synthetic reset zero");
                    Assert.That(typeof(SpatialPointer).GetField("resetTalkDevice", flags).GetValue(pointer), Is.SameAs(controller));
                    for (int frame = 0; frame < 2; frame++)
                    {
                        pointer.ProcessPushToTalk(true, talk.IsPressed(), talk.WasReleasedThisFrame(), controller);
                        yield return null;
                        Assert.That(controller.buttonSouth.isPressed, Is.False);
                        Assert.That(voice.Gate.Captured, Is.Null); Assert.That(submissions.Count, Is.EqualTo(before));
                    }
                    // Model LateUpdate seeing the retained zero immediately before the still-held fresh sample.
                    pointer.ProcessPushToTalk(true, talk.IsPressed(), talk.WasReleasedThisFrame(), controller);
                    QueueHeld(controller, delta, acceptedTime + .01);
                    InputSystem.Update();
                    Assert.That(controller.buttonSouth.isPressed, Is.True);
                    pointer.ProcessPushToTalk(true, talk.IsPressed(), talk.WasReleasedThisFrame(), controller);
                    Assert.That(voice.Gate.Captured, Is.Null, "Still physically held after reset cannot begin a turn");
                    InputSystem.QueueStateEvent(controller, new GamepadState(), acceptedTime + .02); InputSystem.Update();
                    pointer.ProcessPushToTalk(true, talk.IsPressed(), talk.WasReleasedThisFrame(), controller);
                    InputSystem.QueueStateEvent(controller, new GamepadState().WithButton(GamepadButton.South), acceptedTime + .03); InputSystem.Update();
                    pointer.ProcessPushToTalk(true, talk.IsPressed(), talk.WasReleasedThisFrame(), controller);
                    Assert.That(voice.Gate.Captured.Same(receiver), Is.True); voice.ProcessSamples(new float[3200]);
                    InputSystem.QueueStateEvent(controller, new GamepadState(), acceptedTime + .04); InputSystem.Update();
                    pointer.ProcessPushToTalk(true, talk.IsPressed(), talk.WasReleasedThisFrame(), controller);
                    pointer.ProcessPushToTalk(true, false, true, controller); voice.Finish();
                    Assert.That(submissions.Count, Is.EqualTo(before + 1)); Assert.That(submissions[before].receiver.Same(receiver), Is.True);
                    Assert.That(voice.Gate.Enabled && voice.Gate.Permission && voice.Gate.Session && voice.Gate.Connected, Is.True);
                    Assert.That(voice.HandsFree, Is.False);
                }
            }
            finally
            {
                InputSystem.RemoveDevice(controller);
                InputSystem.settings.backgroundBehavior = background;
                InputSystem.settings.editorInputBehaviorInPlayMode = editorFocus;
                Object.Destroy(root);
            }
            yield return null;
        }
        [UnityTest] public IEnumerator LossCancelsWithoutSendOrChangingEnableAndRealReleaseStillFinishesExactlyOnce()
        {
            var root = new GameObject("PTT tracking-loss seam");
            var voice = root.AddComponent<VoiceSession>(); voice.enabled = false; voice.Initialize();
            var pointer = root.AddComponent<SpatialPointer>(); pointer.enabled = false;
            pointer.PushToTalk = voice.PushToTalk; pointer.CancelPushToTalk = voice.CancelPushToTalk;
            var receiver = new Receiver { spaceId = "space", conversationId = "conversation", taskId = "task" };
            voice.CurrentReceiver = () => receiver; voice.Gate.Enabled = true; voice.Gate.Permission = true; voice.Gate.Connected = true;
            var submissions = new List<VoiceRequest>(); voice.Submit = submissions.Add;
            pointer.ProcessPushToTalk(true, true, false); Assert.That(voice.Gate.Captured, Is.Null, "Held A on acquisition does not start capture");
            pointer.ProcessPushToTalk(true, false, false); pointer.ProcessPushToTalk(true, true, false);
            voice.ProcessSamples(new float[3200]); Assert.That(voice.Gate.Captured.Same(receiver), Is.True);
            pointer.ProcessPushToTalk(false, false, true); // Device disappearance can also synthesize an Input System release edge.
            Assert.That(submissions, Is.Empty); Assert.That(voice.Gate.Captured, Is.Null);
            Assert.That(voice.Gate.Enabled && voice.Gate.Permission && voice.Gate.Session && voice.Gate.Connected, Is.True);
            Assert.That(voice.HandsFree, Is.False); Assert.That(voice.Status, Does.Contain("canceled"));
            voice.ProcessSamples(new float[VoiceTurnDetector.MaximumSamples]); voice.Finish(); Assert.That(submissions, Is.Empty, "No retained held capture/recipient after loss");
            pointer.ProcessPushToTalk(true, true, false); Assert.That(voice.Gate.Captured, Is.Null);
            pointer.ProcessPushToTalk(true, false, true); pointer.ProcessPushToTalk(true, true, false);
            voice.ProcessSamples(new float[3200]); pointer.ProcessPushToTalk(true, false, true);
            pointer.ProcessPushToTalk(true, false, true); voice.Finish();
            Assert.That(submissions, Has.Count.EqualTo(1)); Assert.That(submissions[0].receiver.Same(receiver), Is.True);
            pointer.ProcessPushToTalk(true, true, false); voice.ProcessSamples(new float[3200]);
            pointer.enabled = true; pointer.enabled = false; // Focus/pause/disable all use the same ResetInput cancellation path.
            Assert.That(voice.Gate.Captured, Is.Null); Assert.That(submissions, Has.Count.EqualTo(1));
            Assert.That(voice.Gate.Enabled && voice.Gate.Permission && voice.Gate.Session, Is.True);
            var talk = (InputAction)typeof(SpatialPointer).GetField("talk", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(pointer);
            talk.Disable(); talk.AddBinding("<Gamepad>/buttonSouth"); talk.Enable(); // Bind a test-only device so real event samples exercise the production fence.
            var background = InputSystem.settings.backgroundBehavior;
            var editorFocus = InputSystem.settings.editorInputBehaviorInPlayMode;
            // Batchmode has no focused Game View. Route only this fixture's queued samples through player state,
            // then restore the exact settings; production focus policy and all headset settings stay unchanged.
            InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            InputSystem.settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
            var controller = InputSystem.AddDevice<Gamepad>();
            try
            {
                pointer.enabled = true;
                Assert.That(talk.controls.Any(c => c.device == controller), Is.True, "Fixture gamepad binding resolves");
                foreach (bool hard in new[] { false, true })
                {
                    Assert.That(voice.Gate.CanCapture, Is.True, "Voice gate before reset test " + hard);
                    pointer.ProcessPushToTalk(true, false, false, controller); pointer.ProcessPushToTalk(true, true, false, controller);
                    voice.ProcessSamples(new float[3200]); Assert.That(voice.Gate.Captured, Is.Not.Null, "Deliberate press before reset " + hard);
                    InputSystem.ResetDevice(controller, hard); // Real Input System reset event, even with our pose-availability seam still true.
                    Assert.That(voice.Gate.Captured, Is.Null); Assert.That(submissions, Has.Count.EqualTo(1));
                    pointer.ProcessPushToTalk(true, false, true, controller); Assert.That(submissions, Has.Count.EqualTo(1), "Reset button-up cannot send");
                    yield return null;
                    pointer.ProcessPushToTalk(true, false, true, controller); // A stale reset zero cannot release-arm on a later frame either.
                    Assert.That(controller.enabled, Is.True, "Fixture device remains enabled for queued events");
                    InputSystem.QueueStateEvent(controller, new GamepadState().WithButton(GamepadButton.South)); InputSystem.Update();
                    Assert.That(controller.buttonSouth.isPressed, Is.True, "Fixture fresh state event actually processed");
                    Assert.That(typeof(SpatialPointer).GetField("resetTalkDevice", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(pointer), Is.Null, "A fresh bound button sample clears the reset fence");
                    pointer.ProcessPushToTalk(true, true, false, controller);
                    Assert.That(voice.Gate.Captured, Is.Null, "Still-held A on the first fresh sample cannot start another turn");
                    InputSystem.QueueStateEvent(controller, new GamepadState()); InputSystem.Update();
                    pointer.ProcessPushToTalk(true, false, true, controller); // Actual fresh release now arms the next owner press.
                }
                pointer.ProcessPushToTalk(true, true, false, controller); voice.ProcessSamples(new float[3200]);
                pointer.ProcessPushToTalk(true, true, true); // Different device identity without an intervening lost-pose frame.
                Assert.That(voice.Gate.Captured, Is.Null); Assert.That(submissions, Has.Count.EqualTo(1));
                pointer.enabled = false;
            }
            finally
            {
                InputSystem.RemoveDevice(controller);
                InputSystem.settings.backgroundBehavior = background;
                InputSystem.settings.editorInputBehaviorInPlayMode = editorFocus;
            }
            voice.Gate.Enabled = false;
            pointer.ProcessPushToTalk(true, false, false); pointer.ProcessPushToTalk(true, true, false); pointer.ProcessPushToTalk(false, false, true);
            Assert.That(voice.Gate.Enabled, Is.False); Assert.That(voice.Gate.Captured, Is.Null); Assert.That(submissions, Has.Count.EqualTo(1));
            Object.Destroy(root); yield return null;
        }
    }
}
