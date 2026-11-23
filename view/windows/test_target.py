"""
A window of the Windows-side run's own (`node build/view/bench/windows-run.js`), so the run never
types into or clicks the owner's windows. It records what reaches it, and its colour changes
twice a second so its picture keeps changing.

  py -3.12 test_target.py <record.json> [title]

Writing "minimize" or "restore" into <record.json>.cmd makes it do that; "quit" ends it.
"""
import json
import os
import sys
import tkinter as tk

record_path = sys.argv[1]
title = sys.argv[2] if len(sys.argv) > 2 else 'Spatial mirror test target'
record = {'keys': '', 'clicks': [], 'wheel': 0}

root = tk.Tk()
root.title(title)
root.geometry('900x600+120+120')
text = tk.Text(root, font=('Consolas', 18))
text.pack(fill='both', expand=True)
text.insert('end', 'Spatial mirror test target\n')
text.focus_set()
colours = ['#fff8e0', '#e0f0ff']
tick = [0]


def save():
    record['text'] = text.get('1.0', 'end-1c')
    with open(record_path, 'w', encoding='utf-8') as f:
        json.dump(record, f)


def on_key(event):
    record['keys'] += event.char if event.char and event.char.isprintable() else f'<{event.keysym}>'
    root.after(10, save)


def on_click(event):
    record['clicks'].append([round(event.x / max(1, text.winfo_width()), 3), round(event.y / max(1, text.winfo_height()), 3)])
    root.after(10, save)


def on_wheel(event):
    record['wheel'] += 1 if event.delta > 0 else -1
    root.after(10, save)


def poll():
    tick[0] += 1
    text.configure(background=colours[tick[0] % 2])
    cmd_path = record_path + '.cmd'
    if os.path.exists(cmd_path):
        with open(cmd_path, encoding='utf-8') as f:
            cmd = f.read().strip()
        os.remove(cmd_path)
        if cmd == 'minimize':
            root.iconify()
        elif cmd == 'restore':
            root.deiconify()
        elif cmd == 'quit':
            root.destroy()
            return
    root.after(500, poll)


text.bind('<Key>', on_key)
text.bind('<Button-1>', on_click)
text.bind('<MouseWheel>', on_wheel)
save()
root.after(500, poll)
root.mainloop()
