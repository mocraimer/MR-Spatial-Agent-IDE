"""Offline task desktop. No host service, secrets, or network connector runs here."""
import base64
import json
import os
import pty
import select
import socket
import subprocess
import sys
import time
import tty
import uuid


class CommandCapture:
    """Pure per-command framing: bytes first, then the explicit deadline check."""
    BYTE_LIMIT = 1048576

    def __init__(self, token, deadline):
        self.marker = b'\r\n' + token
        self.deadline = deadline
        self.captured = bytearray()
        self.state = 'pending'
        self.result = None

    def advance(self, data, now):
        if self.state != 'pending':
            return self.state
        # Bound the whole raw chunk, including the marker, before parsing completion.
        if len(self.captured) + len(data) > self.BYTE_LIMIT:
            self.state = 'uncertain'
            self.result = {'error': 'output limit reached; process state uncertain'}
            return self.state
        self.captured.extend(data)
        # Match an output line, not the shell's echoed command containing the marker.
        start = self.captured.find(self.marker)
        if start >= 0 and b'\n' in self.captured[start + len(self.marker):]:
            status = self.captured[start + len(self.marker):].split(b'\n', 1)[0].strip()
            if status.isdigit():
                self.state = 'completed'
                self.result = {'output': self.captured[:start].decode(errors='replace'),
                               'exitCode': int(status)}
                return self.state
        if now > self.deadline:
            self.state = 'uncertain'
            self.result = {'error': 'terminal timeout; process state uncertain'}
        return self.state


def terminal():
    tty.setraw(sys.stdin.fileno())
    master, slave = pty.openpty()
    subprocess.Popen(['/bin/bash', '--noprofile', '--norc'], stdin=slave, stdout=slave,
                     stderr=slave, start_new_session=True, cwd='/workspace')
    os.close(slave)
    server = socket.socket(socket.AF_UNIX)
    server.bind('/tmp/spatial-terminal.sock')
    server.listen(8)
    os.set_blocking(master, False)
    active = None
    capture = None
    history = bytearray()
    while True:
        capture_data = b''
        ready, _, _ = select.select([master, server, sys.stdin], [], [], 0.1)
        if server in ready:
            client, _ = server.accept()
            client.settimeout(2)
            data = bytearray()
            while not data.endswith(b'\n') and len(data) < 262144:
                data.extend(client.recv(65536))
            request = json.loads(data)
            if request['op'] == 'output':
                client.sendall(json.dumps({'output': history.decode(errors='replace')}).encode())
                client.close()
            elif active:
                client.sendall(b'{"error":"terminal busy"}')
                client.close()
            else:
                active = client
                token = ('__SPATIAL_' + uuid.uuid4().hex + '__').encode()
                # The payload is code, never a host command. The random marker frames its real exit.
                code = base64.b64encode(request['command'].encode()).decode()
                command = "bash -c \"$(printf '%s' '" + code + "' | base64 -d)\"; printf '\\n" + token.decode() + "%s\\n' \"$?\"\n"
                os.write(master, command.encode())
                capture = CommandCapture(token, time.monotonic() + request.get('timeout', 20))
        if sys.stdin in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if data:
                os.write(master, data)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except BlockingIOError:
                data = b''
            if data:
                os.write(sys.stdout.fileno(), data)
                history.extend(data)
                del history[:-131072]
                if active:
                    capture_data = data
        if active and capture.advance(capture_data, time.monotonic()) != 'pending':
            active.sendall(json.dumps(capture.result).encode())
            active.close()
            active = None


def launch():
    os.makedirs('/home/task', exist_ok=True)
    for number in (10, 11, 12):
        display = ':' + str(number)
        subprocess.Popen(['Xvfb', display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'])
        for _ in range(100):
            if os.path.exists('/tmp/.X11-unix/X' + str(number)):
                break
            time.sleep(0.05)
        env = dict(os.environ, DISPLAY=display)
        subprocess.Popen(['openbox'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.Popen(['chromium', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
                      '--no-first-run', '--no-default-browser-check', '--user-data-dir=/home/task/chromium',
                      '--window-size=1280,800', '--start-maximized', 'file:///opt/spatial/offline.html'],
                     env=dict(os.environ, DISPLAY=':10'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.Popen(['xterm', '-maximized', '-fa', 'DejaVu Sans Mono', '-fs', '12', '-e',
                      'python3', '/opt/spatial/runtime.py', 'terminal'], env=dict(os.environ, DISPLAY=':11'))
    subprocess.Popen(['dbus-run-session', '--', 'mousepad', '/workspace/notes.txt'],
                     env=dict(os.environ, DISPLAY=':12'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    while True:
        time.sleep(60)


if __name__ == '__main__':
    if len(sys.argv) > 1:
        terminal()
    else:
        launch()
