"""Pure capture rules and separate mocked PTY wiring; no real shell or resources."""
import json
import unittest
from unittest.mock import Mock, patch
import runtime


class CommandCaptureTests(unittest.TestCase):
    token = b'__SPATIAL_' + b'a' * 32 + b'__'
    marker = b'\r\n' + token + b'7\r\n'
    limit = 1048576

    def capture(self):
        return runtime.CommandCapture(self.token, deadline=120)

    def test_fragmented_marker_at_every_byte_boundary(self):
        for split in range(1, len(self.marker)):
            with self.subTest(split=split):
                capture = self.capture()
                self.assertEqual(capture.advance(b'output' + self.marker[:split], 100), 'pending')
                self.assertIsNone(capture.result)
                self.assertEqual(capture.advance(self.marker[split:], 101), 'completed')
                self.assertEqual(capture.result, {'output': 'output', 'exitCode': 7})
        capture = self.capture()
        for byte in self.marker[:-1]:
            self.assertEqual(capture.advance(bytes([byte]), 100), 'pending')
        self.assertEqual(capture.advance(self.marker[-1:], 100), 'completed')

    def test_echoed_command_is_not_a_marker_line(self):
        capture = self.capture()
        echo = b"printf '\\n" + self.token + b"%s\\n'\r\n"
        self.assertEqual(capture.advance(echo, 100), 'pending')
        self.assertEqual(capture.advance(self.marker, 101), 'completed')
        self.assertEqual(capture.result['output'], echo.decode())

    def test_nonnumeric_status_does_not_complete(self):
        capture = self.capture()
        self.assertEqual(capture.advance(b'\r\n' + self.token + b'no\r\n', 100), 'pending')
        self.assertEqual(capture.advance(b'', 121), 'uncertain')

    def test_output_decode_and_real_exit_status(self):
        capture = self.capture()
        self.assertEqual(capture.advance(b'\xff\r\n' + self.token + b' 123\r\n', 100), 'completed')
        self.assertEqual(capture.result, {'output': '\ufffd', 'exitCode': 123})

    def test_completion_below_byte_boundary(self):
        capture = self.capture()
        output = b'x' * (self.limit - len(self.marker) - 1)
        self.assertEqual(capture.advance(output + self.marker, 100), 'completed')
        self.assertEqual(capture.result, {'output': output.decode(), 'exitCode': 7})

    def test_completion_at_byte_boundary_includes_marker(self):
        capture = self.capture()
        output = b'x' * (self.limit - len(self.marker))
        self.assertEqual(capture.advance(output, 100), 'pending')
        self.assertEqual(capture.advance(self.marker, 101), 'completed')
        self.assertEqual(len(capture.captured), self.limit)
        self.assertEqual(capture.result, {'output': output.decode(), 'exitCode': 7})

    def test_final_marker_overflow_never_completes(self):
        capture = self.capture()
        output = b'x' * (self.limit - len(self.marker) + 1)
        self.assertEqual(capture.advance(output, 100), 'pending')
        self.assertEqual(capture.advance(self.marker, 101), 'uncertain')
        self.assertEqual(capture.result, {'error': 'output limit reached; process state uncertain'})
        self.assertLessEqual(len(capture.captured), self.limit)

    def test_bytes_after_marker_still_count_toward_bound(self):
        capture = self.capture()
        data = b'x' * (self.limit - len(self.marker)) + self.marker + b'x'
        self.assertEqual(capture.advance(data, 100), 'uncertain')
        self.assertNotIn('exitCode', capture.result)
        self.assertLessEqual(len(capture.captured), self.limit)

    def test_incomplete_output_at_bound_then_overflow(self):
        capture = self.capture()
        self.assertEqual(capture.advance(b'x' * self.limit, 120), 'pending')
        self.assertEqual(capture.advance(b'x', 121), 'uncertain')
        self.assertEqual(capture.result, {'error': 'output limit reached; process state uncertain'})
        self.assertEqual(len(capture.captured), self.limit)

    def test_deadline_is_strictly_after_not_at(self):
        capture = self.capture()
        self.assertEqual(capture.advance(b'', 119), 'pending')
        self.assertEqual(capture.advance(b'', 120), 'pending')
        self.assertEqual(capture.advance(b'', 120.001), 'uncertain')
        self.assertEqual(capture.result, {'error': 'terminal timeout; process state uncertain'})

    def test_partial_marker_at_expired_deadline_is_uncertain(self):
        capture = self.capture()
        self.assertEqual(capture.advance(self.marker[:-1], 121), 'uncertain')
        self.assertNotIn('exitCode', capture.result)

    def test_valid_completion_precedes_deadline_check(self):
        capture = self.capture()
        self.assertEqual(capture.advance(self.marker, 121), 'completed')
        self.assertEqual(capture.result, {'output': '', 'exitCode': 7})

    def test_final_state_and_result_do_not_change(self):
        for data, now, state in [(self.marker, 100, 'completed'),
                                 (b'', 121, 'uncertain'),
                                 (b'x' * (self.limit + 1), 100, 'uncertain')]:
            with self.subTest(state=state, now=now):
                capture = self.capture()
                self.assertEqual(capture.advance(data, now), state)
                result = capture.result.copy()
                raw = bytes(capture.captured)
                self.assertEqual(capture.advance(self.marker + b'x' * self.limit, 200), state)
                self.assertEqual(capture.result, result)
                self.assertEqual(bytes(capture.captured), raw)

    def test_next_command_has_fresh_bytes_marker_deadline_and_result(self):
        for data, now in [(self.marker, 100), (b'', 121), (b'x' * (self.limit + 1), 100)]:
            previous = self.capture()
            previous.advance(data, now)
            capture = runtime.CommandCapture(b'next', deadline=200)
            self.assertEqual(capture.advance(self.marker, 150), 'pending')
            self.assertIsNone(capture.result)
            self.assertEqual(capture.advance(b'\r\nnext0\r\n', 200), 'completed')
            self.assertEqual(capture.result, {'output': self.marker.decode(), 'exitCode': 0})


class TerminalCompletionTests(unittest.TestCase):
    def exercise(self, first_chunks, expected):
        token = b'__SPATIAL_' + b'a' * 32 + b'__'
        final = b'\r\n' + token + b'0\r\n'
        clients = [Mock(), Mock(), Mock()]
        clients[0].recv.return_value = b'{"op":"exec","command":"fixture first"}\n'
        clients[1].recv.return_value = b'{"op":"exec","command":"fixture next"}\n'
        clients[2].recv.return_value = b'{"op":"output"}\n'
        server = Mock()
        server.accept.side_effect = [(client, None) for client in clients]
        chunks = first_chunks(final) + [b'next-command-output' + final]
        ready = [([server], [], [])] + [([8], [], []) for _ in chunks[:-1]]
        ready += [([server], [], []), ([8], [], []), ([server], [], []), StopIteration]
        writes = []
        with patch.object(runtime.tty, 'setraw'), patch.object(runtime.pty, 'openpty', return_value=(8, 9)), \
                patch.object(runtime.subprocess, 'Popen') as launch, patch.object(runtime.socket, 'socket', return_value=server), \
                patch.object(runtime.os, 'close'), patch.object(runtime.os, 'set_blocking'), \
                patch.object(runtime.os, 'read', side_effect=chunks), \
                patch.object(runtime.os, 'write', side_effect=lambda fd, data: writes.append((fd, data))), \
                patch.object(runtime.select, 'select', side_effect=ready), \
                patch.object(runtime.uuid, 'uuid4', return_value=Mock(hex='a' * 32)), \
                patch.object(runtime.time, 'monotonic', return_value=100), \
                patch.object(runtime.sys, 'stdin', Mock(fileno=lambda: 1)), \
                patch.object(runtime.sys, 'stdout', Mock(fileno=lambda: 2)):
            with self.assertRaises(StopIteration):
                runtime.terminal()
        first = json.loads(clients[0].sendall.call_args.args[0])
        self.assertEqual(first, expected)
        self.assertEqual(clients[0].sendall.call_count, 1, 'no false or second acknowledgement')
        self.assertEqual(json.loads(clients[1].sendall.call_args.args[0]), {'output': 'next-command-output', 'exitCode': 0})
        self.assertEqual(clients[1].sendall.call_count, 1)
        self.assertEqual(len([data for fd, data in writes if fd == 8]), 2, 'exactly the two requested commands')
        self.assertEqual(len([data for fd, data in writes if fd == 2]), len(chunks), 'all PTY chunks remain visible')
        history = json.loads(clients[2].sendall.call_args.args[0])['output']
        self.assertIn('next-command-output', history)
        self.assertLessEqual(len(history.encode()), 131072)
        launch.assert_called_once()

    def test_final_completion_chunk_crosses_byte_bound(self):
        self.exercise(lambda final: [b'x' * 1048500, b'x' * 100 + final],
                      {'error': 'output limit reached; process state uncertain'})

    def test_completion_at_bound_preserves_output_and_next_command(self):
        token = b'\r\n__SPATIAL_' + b'a' * 32 + b'__0\r\n'
        output = b'x' * (1048576 - len(token))
        self.exercise(lambda final: [output[:-50], output[-50:] + final],
                      {'output': output.decode(), 'exitCode': 0})

    def test_incomplete_oversized_output_never_acknowledges_completion(self):
        self.exercise(lambda _final: [b'x' * 1048500, b'x' * 100],
                      {'error': 'output limit reached; process state uncertain'})


if __name__ == '__main__':
    unittest.main()
