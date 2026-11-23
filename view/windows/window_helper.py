"""
The view's helper on Windows: lists the PC's windows, captures the ones mirrored into the headset,
passes the owner's clicks, scrolls and keys to them, and opens pages in a browser window.

The bridge in WSL starts this through WSL interop and speaks JSON lines over stdin and stdout; it
listens on no port. Requests carry an "id" and get one reply with the same id. Captures also send
{"frame": hwnd, ...} and {"window": hwnd, "problem": ...} lines on their own.

It never closes, minimizes or kills a window: it only reads pictures and sends input.

Needs Windows Python 3.12 with the open-source `windows-capture` package (and opencv-python,
numpy, pywin32): `py -3.12 -m pip install --user windows-capture pywin32`.
"""
import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import threading
import time

import cv2
import win32api
import win32con
import win32gui
import win32process
from windows_capture import WindowsCapture

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
kernel32 = ctypes.windll.kernel32

# The largest picture sent: wider windows are scaled down to this width (a texture the headset holds well).
MAX_WIDTH = 2560
JPEG_QUALITY = 82

out_lock = threading.Lock()


def emit(message):
    line = json.dumps(message, separators=(',', ':'))
    with out_lock:
        sys.stdout.write(line + '\n')
        sys.stdout.flush()


# ---- Windows -------------------------------------------------------------------------------------

def app_name(hwnd):
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ''
    try:
        size = wt.DWORD(1024)
        buf = ctypes.create_unicode_buffer(1024)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return ''
    finally:
        kernel32.CloseHandle(handle)


def cloaked(hwnd):
    value = ctypes.c_int(0)
    dwmapi.DwmGetWindowAttribute(wt.HWND(hwnd), 14, ctypes.byref(value), ctypes.sizeof(value))  # DWMWA_CLOAKED
    return value.value != 0


def listable(hwnd):
    if not win32gui.IsWindowVisible(hwnd) or win32gui.GetWindow(hwnd, win32con.GW_OWNER):
        return False
    title = win32gui.GetWindowText(hwnd)
    if not title or title in ('Program Manager', 'PopupHost'):
        return False
    if win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE) & win32con.WS_EX_TOOLWINDOW:
        return False
    return not cloaked(hwnd)


def windows():
    found = []
    win32gui.EnumWindows(lambda h, _: found.append(h) if listable(h) else None, None)
    return [{'hwnd': h, 'title': win32gui.GetWindowText(h), 'app': app_name(h)} for h in found]


def problem_of(hwnd):
    if not win32gui.IsWindow(hwnd):
        return 'gone'
    if win32gui.IsIconic(hwnd):
        return 'minimized'
    if not win32gui.IsWindowVisible(hwnd):
        return 'hidden'
    return None


# ---- Captures ------------------------------------------------------------------------------------

class Capture:
    def __init__(self, hwnd, fps):
        self.hwnd = hwnd
        self.problem = None
        self.control = None
        self.lock = threading.Lock()
        self.fps = max(1, min(30, int(fps)))
        self.start()

    def start(self):
        capture = WindowsCapture(cursor_capture=False, draw_border=False, window_hwnd=self.hwnd,
                                 minimum_update_interval=int(1000 / self.fps))

        @capture.event
        def on_frame_arrived(frame, control):
            buffer = frame.frame_buffer[:, :, :3]
            h, w = buffer.shape[:2]
            if w > MAX_WIDTH:
                h = int(h * MAX_WIDTH / w)
                w = MAX_WIDTH
                buffer = cv2.resize(buffer, (w, h), interpolation=cv2.INTER_AREA)
            ok, jpeg = cv2.imencode('.jpg', buffer, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                emit({'frame': self.hwnd, 'w': w, 'h': h, 'mime': 'image/jpeg', 'data': base64.b64encode(jpeg.tobytes()).decode('ascii')})

        @capture.event
        def on_closed():
            pass

        try:
            self.control = capture.start_free_threaded()
        except Exception as error:  # a window that cannot be captured now; the watchdog retries
            self.control = None
            self.set_problem(f'capture-failed: {error}')

    def set_problem(self, problem):
        if problem != self.problem:
            self.problem = problem
            emit({'window': self.hwnd, 'problem': problem})

    def check(self):
        problem = problem_of(self.hwnd)
        if problem is None and self.control is None:
            self.start()
            if self.control is None:
                return
        self.set_problem(problem)
        if problem == 'gone':
            self.stop()

    def stop(self):
        with self.lock:
            control, self.control = self.control, None
        if control is not None:
            try:
                control.stop()
            except Exception:
                pass


captures = {}
captures_lock = threading.Lock()


def watchdog():
    while True:
        time.sleep(1)
        with captures_lock:
            current = list(captures.values())
        for c in current:
            c.check()


# ---- Input ---------------------------------------------------------------------------------------

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', ctypes.c_ushort), ('wScan', ctypes.c_ushort), ('dwFlags', ctypes.c_ulong), ('time', ctypes.c_ulong), ('dwExtraInfo', ctypes.c_size_t)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', ctypes.c_long), ('dy', ctypes.c_long), ('mouseData', ctypes.c_ulong), ('dwFlags', ctypes.c_ulong), ('time', ctypes.c_ulong), ('dwExtraInfo', ctypes.c_size_t)]


class _U(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT), ('mi', MOUSEINPUT), ('pad', ctypes.c_byte * 32)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', ctypes.c_ulong), ('u', _U)]


def send(*inputs):
    array = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))


def key_input(vk=0, scan=0, flags=0):
    i = INPUT(type=1)
    i.u.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return i


def mouse_input(flags, data=0):
    i = INPUT(type=0)
    i.u.mi = MOUSEINPUT(0, 0, data, flags, 0, 0)
    return i


KEYS = {
    'enter': win32con.VK_RETURN, 'backspace': win32con.VK_BACK, 'tab': win32con.VK_TAB, 'escape': win32con.VK_ESCAPE,
    'up': win32con.VK_UP, 'down': win32con.VK_DOWN, 'left': win32con.VK_LEFT, 'right': win32con.VK_RIGHT,
    'home': win32con.VK_HOME, 'end': win32con.VK_END, 'pageup': win32con.VK_PRIOR, 'pagedown': win32con.VK_NEXT,
    'delete': win32con.VK_DELETE, 'space': win32con.VK_SPACE,
}
MODS = {'ctrl': win32con.VK_CONTROL, 'alt': win32con.VK_MENU, 'shift': win32con.VK_SHIFT}
EXTENDED = {win32con.VK_UP, win32con.VK_DOWN, win32con.VK_LEFT, win32con.VK_RIGHT, win32con.VK_HOME, win32con.VK_END,
            win32con.VK_PRIOR, win32con.VK_NEXT, win32con.VK_DELETE}


def bring_forward(hwnd):
    """Makes the window the one Windows sends input to. A tap of Alt lets a background process do it."""
    if user32.GetForegroundWindow() == hwnd:
        return True
    win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
    win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    for _ in range(20):
        if user32.GetForegroundWindow() == hwnd:
            return True
        time.sleep(0.01)
    return False


def screen_point(hwnd, x, y):
    left, top, right, bottom = win32gui.GetClientRect(hwnd)
    px = int(left + min(max(x, 0.0), 1.0) * max(1, right - left - 1))
    py = int(top + min(max(y, 0.0), 1.0) * max(1, bottom - top - 1))
    return win32gui.ClientToScreen(hwnd, (px, py))


input_lock = threading.Lock()


def do_input(hwnd, events):
    with input_lock:
        return _do_input(hwnd, events)


def _do_input(hwnd, events):
    problem = problem_of(hwnd)
    if problem:
        return problem
    previous = user32.GetForegroundWindow()
    cursor = win32api.GetCursorPos()
    if not bring_forward(hwnd):
        return 'not-forward'
    # Windows routes input to the window in front when it processes it, not when it is sent:
    # short pauses keep each event on this window, and the previous one comes back only after.
    time.sleep(0.03)
    try:
        for e in events:
            kind = e.get('type')
            if kind in ('click', 'wheel'):
                win32api.SetCursorPos(screen_point(hwnd, float(e.get('x', 0.5)), float(e.get('y', 0.5))))
                time.sleep(0.02)
                if kind == 'click':
                    send(mouse_input(0x0002), mouse_input(0x0004))  # left down, left up
                else:
                    send(mouse_input(0x0800, ctypes.c_ulong(int(e.get('delta', 0)) * 120).value))
            elif kind == 'text':
                inputs = []
                for ch in str(e.get('text', '')):
                    if ch == '\n':
                        inputs += [key_input(win32con.VK_RETURN), key_input(win32con.VK_RETURN, 0, 2)]
                        continue
                    data = ch.encode('utf-16-le')
                    for i in range(0, len(data), 2):
                        code = int.from_bytes(data[i:i + 2], 'little')
                        inputs += [key_input(0, code, 4), key_input(0, code, 4 | 2)]
                if inputs:
                    send(*inputs)
            elif kind == 'key':
                vk = KEYS.get(e.get('key'))
                if vk is None and len(str(e.get('key', ''))) == 1:
                    vk = win32api.VkKeyScan(str(e['key'])) & 0xFF
                if vk is None:
                    continue
                mods = [MODS[m] for m in e.get('mods', []) if m in MODS]
                ext = 1 if vk in EXTENDED else 0
                send(*[key_input(m) for m in mods], key_input(vk, 0, ext), key_input(vk, 0, ext | 2), *[key_input(m, 0, 2) for m in reversed(mods)])
            time.sleep(0.02)
        time.sleep(0.15)
    finally:
        win32api.SetCursorPos(cursor)
        if previous and previous != hwnd and win32gui.IsWindow(previous):
            bring_forward(previous)
    return None


# ---- Opening a page ------------------------------------------------------------------------------

def browser():
    for path in (os.path.expandvars(r'%ProgramFiles%\Google\Chrome\Application\chrome.exe'),
                 os.path.expandvars(r'%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe'),
                 os.path.expandvars(r'%LocalAppData%\Google\Chrome\Application\chrome.exe'),
                 os.path.expandvars(r'%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe')):
        if os.path.exists(path):
            return path
    return None


def open_page(url, extra):
    exe = browser()
    if not exe:
        raise RuntimeError('No Chrome or Edge found on this PC.')
    before = {w['hwnd'] for w in windows()}
    subprocess.Popen([exe, *extra, '--new-window', url], close_fds=True)
    deadline = time.time() + 10
    while time.time() < deadline:
        time.sleep(0.25)
        fresh = [w for w in windows() if w['hwnd'] not in before and w['app'].lower() in ('chrome.exe', 'msedge.exe')]
        if fresh:
            # The page's own title arrives once it loads; give it a moment, so the session is named for it.
            hwnd = fresh[0]['hwnd']
            settle = time.time() + 3
            while time.time() < settle and win32gui.GetWindowText(hwnd).startswith('Untitled'):
                time.sleep(0.2)
            return {**fresh[0], 'title': win32gui.GetWindowText(hwnd) or fresh[0]['title']}
    raise RuntimeError('The browser window did not appear within 10 seconds.')


# ---- Window rect and maximized state -------------------------------------------------------------

WINDOWPLACEMENT = None  # resolved lazily below


def get_rect_and_maximized(hwnd):
    """Returns the window's rect (left, top, right, bottom) and whether it is maximized."""
    placement = win32gui.GetWindowPlacement(hwnd)
    # placement[1] is showCmd; SW_SHOWMAXIMIZED = 3
    maximized = placement[1] == win32con.SW_SHOWMAXIMIZED
    if maximized:
        # Use the normal (restore) rect so the caller can put the window back there.
        normal = placement[4]  # (left, top, right, bottom)
        return {'left': normal[0], 'top': normal[1], 'right': normal[2], 'bottom': normal[3]}, True
    rect = win32gui.GetWindowRect(hwnd)
    return {'left': rect[0], 'top': rect[1], 'right': rect[2], 'bottom': rect[3]}, False


def set_rect(hwnd, left, top, right, bottom):
    """Resizes the window to the given rect (restoring from maximized first)."""
    placement = win32gui.GetWindowPlacement(hwnd)
    if placement[1] == win32con.SW_SHOWMAXIMIZED:
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.1)
    win32gui.SetWindowPos(hwnd, 0, left, top, right - left, bottom - top,
                         win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)


def find_terminal_window(workspace_label):
    """
    Finds the Windows Terminal (or ConHost) window that is running Herdr for the given workspace.
    Matches windows whose app is WindowsTerminal.exe and whose title ends with ': <workspace_label>'.
    Returns the first match, or None.
    """
    suffix = f': {workspace_label}'
    for w in windows():
        if w['app'].lower() == 'windowsterminal.exe' and w['title'].endswith(suffix):
            return w
    return None


# ---- The loop ------------------------------------------------------------------------------------

def handle(request):
    op = request.get('op')
    if op == 'list':
        return {'windows': windows()}
    if op == 'capture':
        hwnd = int(request['hwnd'])
        with captures_lock:
            if hwnd not in captures:
                captures[hwnd] = Capture(hwnd, request.get('fps', 15))
            c = captures[hwnd]
        c.check()
        return {'problem': c.problem}
    if op == 'stop':
        with captures_lock:
            c = captures.pop(int(request['hwnd']), None)
        if c:
            c.stop()
        return {}
    if op == 'input':
        problem = do_input(int(request['hwnd']), request.get('events', []))
        return {'problem': problem}
    if op == 'open':
        extra = [a for a in os.environ.get('SPATIAL_BROWSER_ARGS', '').split('|') if a]
        return {'window': open_page(str(request['url']), extra)}
    if op == 'find-window':
        w = find_terminal_window(str(request['workspaceLabel']))
        if not w:
            return {'window': None}
        rect, maximized = get_rect_and_maximized(int(w['hwnd']))
        return {'window': {**w, 'rect': rect, 'maximized': maximized}}
    if op == 'get-rect':
        hwnd = int(request['hwnd'])
        rect, maximized = get_rect_and_maximized(hwnd)
        return {'rect': rect, 'maximized': maximized}
    if op == 'set-rect':
        hwnd = int(request['hwnd'])
        r = request['rect']
        set_rect(hwnd, int(r['left']), int(r['top']), int(r['right']), int(r['bottom']))
        return {}
    if op == 'maximize':
        hwnd = int(request['hwnd'])
        win32gui.ShowWindow(hwnd, win32con.SW_SHOWMAXIMIZED)
        return {}
    raise ValueError(f'unknown op {op!r}')


def serve(request):
    try:
        emit({'id': request.get('id'), 'ok': True, **handle(request)})
    except Exception as error:
        emit({'id': request.get('id'), 'ok': False, 'error': str(error)})


def main():
    threading.Thread(target=watchdog, daemon=True).start()
    emit({'ready': True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        # Input waits on the foreground; captures and lists must not wait behind it.
        threading.Thread(target=serve, args=(request,), daemon=True).start()
    with captures_lock:
        for c in captures.values():
            c.stop()
    os._exit(0)


if __name__ == '__main__':
    main()
