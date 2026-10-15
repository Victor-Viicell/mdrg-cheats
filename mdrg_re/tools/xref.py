#!/usr/bin/env python3
"""Xref: find every direct call to a vaddr in GameAssembly.so, name the caller.

Usage: xref.py 0x2efb410 [--so PATH] [--ctx 24]
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from il2dis import name_at, next_func, ENTRIES, ADDRS  # noqa: E402
import bisect


def enclosing(addr: int) -> str:
    i = bisect.bisect_right(ADDRS, addr) - 1
    if i < 0:
        return "?"
    start = ADDRS[i]
    if addr >= next_func(start) and addr != start:
        return f"{name_at(start)}?+{addr - start:#x} (outside)"
    return f"{name_at(start)}+{addr - start:#x}" if addr != start else name_at(start)


def load_segments(path: Path):
    data = path.read_bytes()
    phoff = struct.unpack_from("<Q", data, 0x20)[0]
    phentsize = struct.unpack_from("<H", data, 0x36)[0]
    phnum = struct.unpack_from("<H", data, 0x38)[0]
    segs = []
    for i in range(phnum):
        off = phoff + i * phentsize
        if struct.unpack_from("<I", data, off)[0] != 1:
            continue
        p_offset = struct.unpack_from("<Q", data, off + 8)[0]
        p_vaddr = struct.unpack_from("<Q", data, off + 16)[0]
        p_filesz = struct.unpack_from("<Q", data, off + 32)[0]
        p_flags = struct.unpack_from("<I", data, off + 4)[0]
        segs.append((p_vaddr, p_offset, p_filesz, p_flags))
    return data, segs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--so", default=str(Path.home() / ".config/itch/apps/factorial-omega/GameAssembly.so"))
    ap.add_argument("--orig", action="store_true")
    a = ap.parse_args()
    if a.orig:
        a.so = str(Path.home() / "mdrg_re/GameAssembly.so.orig")
    target = int(a.target, 16)
    data, segs = load_segments(Path(a.so))
    hits = []
    for vaddr, off, size, flags in segs:
        if not flags & 1:
            continue
        code = data[off:off + size]
        for i in range(len(code) - 5):
            if code[i] not in (0xE8, 0xE9):
                continue
            rel = struct.unpack_from("<i", code, i + 1)[0]
            if vaddr + i + 5 + rel == target:
                hits.append(vaddr + i)
    print(f"{len(hits)} reference(s) to {target:#x}")
    for h in sorted(hits):
        print(f"  caller {h:#x}  in {enclosing(h)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
