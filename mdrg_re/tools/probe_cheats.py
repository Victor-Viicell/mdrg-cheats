#!/usr/bin/env python3
"""Spawn (or attach to) MDRG with the cheat-system probe and stream the log.

  probe_cheats.py [--seconds N] [--attach PID] [--log FILE]

Spawn mode makes the game frida's child, so ptrace is allowed without root.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import frida

GAME_DIR = Path.home() / ".config/itch/apps/factorial-omega"
EXE = GAME_DIR / "My Dystopian Robot Girlfriend.x86_64"
HOOK = Path(__file__).with_name("hook_cheats.js")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=0, help="0 = run until Ctrl-C")
    ap.add_argument("--attach", type=int, help="attach to an already running pid")
    ap.add_argument("--log", default=None, help="also append output here")
    ap.add_argument("--set-code", default=None, help="write this cheat code into PlayerPrefs at startup (e.g. 'A~')")
    ap.add_argument("--extra-js", default=None, help="extra frida script to load (defaults to set_code.js with --set-code)")
    ap.add_argument("--drive", action="store_true", help="drive the cheat entry points directly (loads drive_cheats.js)")
    a = ap.parse_args()

    dev = frida.get_local_device()
    if a.attach:
        pid = a.attach
        session = dev.attach(pid)
    else:
        pid = dev.spawn([str(EXE)], cwd=str(GAME_DIR))
        session = dev.attach(pid)
    print(f"# pid {pid} attached", flush=True)

    fh = open(a.log, "a") if a.log else None

    def emit(line: str) -> None:
        print(line, flush=True)
        if fh:
            fh.write(line + "\n")
            fh.flush()

    def on_message(msg, data):
        if msg.get("type") == "send":
            p = msg["payload"]
            tag = p.get("tag", "?")
            if tag == "CALL":
                extra = {k: v for k, v in p.items() if k not in ("tag", "fn")}
                emit(f"[CALL] {p['fn']} {extra if extra else ''}")
            else:
                emit(f"[{tag}] " + str({k: v for k, v in p.items() if k != 'tag'}))
        else:
            emit(f"[frida:{msg.get('type')}] {msg}")

    script = session.create_script(HOOK.read_text())
    script.on("message", on_message)
    script.load()

    extra = a.extra_js
    if not extra and a.drive:
        extra = str(Path(__file__).with_name("drive_cheats.js"))
    if not extra and a.set_code:
        extra = str(Path(__file__).with_name("set_code.js"))
    if extra:
        src = Path(extra).read_text()
        if a.set_code:
            src = f"const CHEAT_CODE = {a.set_code!r};\n" + src
        xs = session.create_script(src)
        xs.on("message", on_message)
        xs.load()
        emit(f"# extra script loaded: {extra}" + (f" (code={a.set_code!r})" if a.set_code else ""))

    if not a.attach:
        dev.resume(pid)
        print("# resumed", flush=True)

    try:
        if a.seconds:
            time.sleep(a.seconds)
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            script.unload()
        except Exception:
            pass
        if not a.attach:
            try:
                dev.kill(pid)
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
