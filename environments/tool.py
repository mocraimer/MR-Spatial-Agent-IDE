"""Container-only tool transport. All paths are relative to the private /workspace."""
import base64
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
from PIL import Image

DISPLAYS = {'browser': ':10', 'terminal': ':11', 'desktop': ':12'}


def workspace_file(path, flags):
    parts = path.split('/')
    if not parts or any(p in ('', '.', '..') for p in parts) or len(path) > 4096:
        raise ValueError('file path must be workspace-relative without dot components')
    directory = os.open('/workspace', os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_fd
        return os.open(parts[-1], flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
    finally:
        os.close(directory)


def terminal(request):
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(request.get('timeout', 20) + 5)
    connection.connect('/tmp/spatial-terminal.sock')
    connection.sendall(json.dumps(request).encode() + b'\n')
    data = bytearray()
    while True:
        chunk = connection.recv(65536)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > 2000000:
            raise ValueError('tool response exceeds limit')
    connection.close()
    return json.loads(data)


def main(op, request):
    if op == 'probe':
        for kind, display in DISPLAYS.items():
            application = {'browser': 'chromium', 'terminal': 'XTerm', 'desktop': 'Mousepad'}[kind]
            windows = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--class', application], env=dict(os.environ, DISPLAY=display))
            if not windows.strip():
                raise ValueError(kind + ' has no actual window')
        if not os.path.exists('/tmp/spatial-terminal.sock'):
            raise ValueError('PTY not ready')
        return {'ready': True}
    if op in ('exec', 'output'):
        return terminal(dict(request, op=op))
    if op in ('read', 'write'):
        fd = workspace_file(request['path'], os.O_RDONLY if op == 'read' else os.O_WRONLY | os.O_CREAT)
        try:
            import stat
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError('only regular workspace files are supported')
            if op == 'read':
                content = os.read(fd, 1048577)
                if len(content) > 1048576:
                    raise ValueError('file exceeds 1 MiB limit')
                return {'contentBase64': base64.b64encode(content).decode()}
            data = base64.b64decode(request['contentBase64'], validate=True)
            if len(data) > 1048576:
                raise ValueError('file exceeds 1 MiB limit')
            os.ftruncate(fd, 0)
            with os.fdopen(os.dup(fd), 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            return {'written': len(data)}
        finally:
            os.close(fd)
    display = DISPLAYS[request['view']]
    env = dict(os.environ, DISPLAY=display)
    if op == 'frame':
        fd, path = tempfile.mkstemp(suffix='.png')
        os.close(fd)
        try:
            subprocess.run(['scrot', '-z', '-o', path], env=env, check=True, timeout=10)
            with Image.open(path) as image:
                output = io.BytesIO()
                image.save(output, format='PNG')
                return {'pngBase64': base64.b64encode(output.getvalue()).decode(), 'width': image.width, 'height': image.height}
        finally:
            os.unlink(path)
    if op == 'input':
        kind = request['kind']
        if kind == 'pointer':
            button = {'left': '1', 'middle': '2', 'right': '3'}[request['button']]
            args = ['mousemove', str(request['x']), str(request['y']), 'click', button]
        elif kind == 'key':
            args = ['key', '--clearmodifiers', request['key']]
        else:
            args = ['type', '--clearmodifiers', '--delay', '0', '--', request['text']]
        subprocess.run(['xdotool'] + args, env=env, check=True, timeout=10)
        return {'accepted': True}
    raise ValueError('unsupported operation')


try:
    result = main(sys.argv[1], json.load(sys.stdin))
except Exception as error:
    result = {'error': str(error)}
print(json.dumps(result))
