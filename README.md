# mdrg-cheats

Version-proof cheat enabler for **!Omega Factorial Omega: My Dystopian Robot Girlfriend** (IL2CPP builds).

## Why this survives game updates

Every piece of cheat functionality funnels through ONE generated method, `Options.GetCheatTier()`,
which returns a `CheatTierEnum` value (0 / 10 / 20 / 30 in 0.97.12 — basic / advanced / debug ladder).

Everything else is derived from it. Verified by disassembling all 8 call sites in 0.97.12:

| wrapper | meaning |
| --- | --- |
| four `cmp eax,0x14; setge` | tier >= advanced |
| one `test eax,eax; setg` | AnyCheatsEnabled: tier > 0 |
| one `cmp eax,0x1e; sete` | DebugEnabled: tier == debug |

No caller compares the tier with `==` against the advanced value, so returning the advanced value
unlocks basic + advanced cheats, and neutralising the debug wrapper unlocks debug features too.

Nothing is hardcoded: no addresses, no enum values, no metadata parsing, no strings, no external tools.
The script finds the gate structurally from the call graph (it is the callee shared by a
`<call>; cmp eax,K; sete al` wrapper and a `<call>; test eax,eax; setg al` wrapper), then *reads the
tier values out of the callers' own comparisons*. A new game version, a new Unity version, or a
different metadata version therefore changes nothing. If the developer ever rewrites the cheat system,
the script refuses to touch the binary instead of corrupting it.

## Usage

```sh
mdrg-cheats                 # auto-find the game and patch it
mdrg-cheats --status        # report state, change nothing
mdrg-cheats --dry-run       # show the exact patches, change nothing
mdrg-cheats --revert        # restore the pristine GameAssembly.so
mdrg-cheats --game-dir DIR  # point at a specific install
```

## Layout

```
mdrg-cheats     # the tool (single-file Python 3, stdlib only)
```

Installed as `~/.local/bin/mdrg-cheats`, a symlink back to this repo's `mdrg-cheats`.

Runtime state lives outside the repo:

- `~/.local/share/mdrg-cheats/GameAssembly.so.<version>.orig` — pristine backup made on first patch
- game install: `~/.config/itch/apps/factorial-omega`
