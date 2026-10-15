#!/usr/bin/env python3
"""Resolve + disassemble IL2CPP methods in a Unity GameAssembly.so.

Usage:
  il2dis.py <method-substring> [--limit N]        # find methods by name
  il2dis.py --at 0x2C91E60 [--len 0x400]         # disassemble at a vaddr
  il2dis.py --name RoomSheep.RoomCheatsButtonClicked

Call targets are annotated with the IL2CPP method name (from script.json).
Addresses used are the objdump/vaddr space (== script.json "Address").
"""
from __future__ import annotations

import argparse
import bisect
import json
import re
import struct
import subprocess
import sys
from pathlib import Path

RE = Path.home() / "mdrg_re"
DUMP = RE / "out" / "script.json"
DEFAULT_SO = Path.home() / ".config/itch/apps/factorial-omega/GameAssembly.so"
ORIG_SO = RE / "GameAssembly.so.orig"


def load_symbols(dump: Path):
    data = json.loads(dump.read_text())
    methods = data.get("ScriptMethod") or data.get("ScriptMethods")
    by_addr: dict[int, str] = {}
    entries = []
    for m in methods:
        addr = m.get("Address") or m.get("Rva") or m.get("Offset")
        name = m.get("Name", "?")
        by_addr[addr] = name
        entries.append((addr, name, m.get("Signature", "")))
    entries.sort()
    addrs = [e[0] for e in entries]
    return by_addr, entries, addrs


BY_ADDR, ENTRIES, ADDRS = load_symbols(DUMP)


def name_at(addr: int) -> str | None:
    return BY_ADDR.get(addr)


def next_func(addr: int) -> int:
    i = bisect.bisect_right(ADDRS, addr)
    return ADDRS[i] if i < len(ADDRS) else addr + 0x200


def disasm(so: Path, addr: int, length: int) -> list[str]:
    out = subprocess.run(
        ["objdump", "-d", f"--start-address={addr}", f"--stop-address={addr + length}",
         "-M", "intel", "--no-show-raw-insn", str(so)],
        capture_output=True, text=True).stdout
    insns = []
    for ln in out.splitlines():
        if ":\t" not in ln:
            continue
        a, rest = ln.split(":", 1)
        try:
            ia = int(a.strip(), 16)
        except ValueError:
            continue
        insns.append((ia, rest.strip()))
    return insns


CALL = re.compile(r"^call\s+(?:qword ptr )?(?:\*)?([0-9a-f]+)?\s*(?:<([^>]+)>)?\s*$")


def render(so: Path, addr: int, length: int) -> str:
    img = Image(so)
    lines = []
    for ia, ins in insns_annot(so, addr, length, img):
        lines.append(f"{ia:#x}: {ins}")
    return "\n".join(lines)


LEA = re.compile(r"^(lea\s+\w+,\[rip[+-]0x[0-9a-f]+\]\s*#\s*([0-9a-f]+))")


def insns_annot(so: Path, addr: int, length: int, img: "Image | None" = None):
    for ia, ins in disasm(so, addr, length):
        m = CALL.match(ins)
        if m:
            tgt = int(m.group(1), 16) if m.group(1) else None
            label = name_at(tgt) if tgt is not None else None
            if label:
                ins = f"{ins}   ; {label}"
        elif img is not None:
            lm = LEA.match(ins)
            if lm:
                slot = int(lm.group(2), 16)
                txt = img.string_at(slot)
                if txt:
                    ins = f"{ins}   ; \"{txt}\""
        yield ia, ins


def find(pattern: str, limit: int = 40):
    pat = pattern.lower()
    hits = [(a, n, s) for a, n, s in ENTRIES if pat in n.lower()]
    for a, n, s in hits[:limit]:
        print(f"{a:#x}  {n}   ({s})")
    print(f"-- {len(hits)} match(es)")


class Image:
    """vaddr <-> file offset for an ELF, plus IL2CPP string-literal resolution."""

    def __init__(self, path: Path):
        self.data = path.read_bytes()
        self.segs: list[tuple[int, int, int]] = []
        phoff = struct.unpack_from("<Q", self.data, 0x20)[0]
        phentsize = struct.unpack_from("<H", self.data, 0x36)[0]
        phnum = struct.unpack_from("<H", self.data, 0x38)[0]
        for i in range(phnum):
            off = phoff + i * phentsize
            if struct.unpack_from("<I", self.data, off)[0] != 1:
                continue
            p_offset = struct.unpack_from("<Q", self.data, off + 8)[0]
            p_vaddr = struct.unpack_from("<Q", self.data, off + 16)[0]
            p_filesz = struct.unpack_from("<Q", self.data, off + 32)[0]
            self.segs.append((p_vaddr, p_offset, p_filesz))

    def v2o(self, vaddr: int) -> int | None:
        for vaddr0, off0, size in self.segs:
            if vaddr0 <= vaddr < vaddr0 + size:
                return off0 + vaddr - vaddr0
        return None

    def u64(self, vaddr: int) -> int | None:
        off = self.v2o(vaddr)
        if off is None:
            return None
        return struct.unpack_from("<Q", self.data, off)[0]

    def string_at(self, vaddr: int, depth: int = 2) -> str | None:
        """Resolve metadata slot -> Il2CppString -> text (UTF-16 or UTF-8)."""
        cur = vaddr
        for _ in range(depth):
            off = self.v2o(cur)
            if off is None:
                return None
            # Il2CppString: [0x00] klass, [0x08] monitor, [0x10] length, [0x14] utf16
            length = struct.unpack_from("<i", self.data, off + 0x10)[0]
            if 0 <= length < 4096:
                raw = self.data[off + 0x14:off + 0x14 + length * 2]
                try:
                    txt = raw.decode("utf-16-le")
                except UnicodeDecodeError:
                    txt = ""
                if txt and all((c.isprintable() or c in "\t\n") for c in txt):
                    return txt
            nxt = struct.unpack_from("<Q", self.data, off)[0]
            if nxt == cur or self.v2o(nxt) is None:
                # maybe a raw UTF-8 C string at this address
                raw = self.data[off:off + 200].split(b"\x00")[0]
                try:
                    txt = raw.decode("utf-8")
                except UnicodeDecodeError:
                    return None
                return txt if txt.isprintable() else None
            cur = nxt
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pattern", nargs="?")
    ap.add_argument("--at", help="vaddr to disassemble")
    ap.add_argument("--len", default="0x300")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--so", default=str(DEFAULT_SO))
    ap.add_argument("--orig", action="store_true", help="use the pristine backup")
    a = ap.parse_args()
    so = ORIG_SO if a.orig else Path(a.so)
    if a.pattern:
        find(a.pattern, a.limit)
    if a.at:
        start = int(a.at, 16)
        ln = int(a.len, 16)
        nm = name_at(start)
        if nm:
            print(f"; {nm}   (next: {name_at(next_func(start))})")
        print(render(so, start, ln))
    return 0


if __name__ == "__main__":
    sys.exit(main())
