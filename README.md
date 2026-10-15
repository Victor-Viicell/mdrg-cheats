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

## The second gate: the cheat key

The tier alone is not enough. Every cheat handler (`RoomSheep::RoomCheatsButtonClicked`,
`ItemStatsSheep::…`, `CheatWebsite::GetMoney`) first checks the **stored cheat key** — it must carry a
tier marker (`"A~"` advanced / `"B~"` basic) and be at least 10 characters long — otherwise it returns
silently: the buttons are there, the clicks fire, nothing happens.

The key is written by the in-game *enter cheat code* button, whose coroutine runs the typed string
through the game's RSA-backed checker (`Sheep::CheckIfSheepIsHappy`) three times: once with the key you
typed, twice with embedded self-test keys. The typed key must come back positive or the coroutine takes
the reject branch and never stores it — which is why a hand-typed key never enables anything.

Two patches fix that, both located structurally (the checker is the one function called once by the
tier function and three times in a row by the enter-code path):

1. **The checker itself** gets an entry stub: a non-empty key string returns the *top* tier the
   callers know about (the debug tier — one above advanced, so the debug-gated item/quality/colour
   cheats unlock too), an empty key returns 0.
2. **The reject branches** of the enter-code coroutine are removed, so the store block is reached and
   the key is written.
3. **The handlers' marker checks** on the stored key are forced true. Each cheat button re-reads the
   stored key and tests it for a tier marker on *every* click; an in-game entry saves the bare payload,
   so those tests failed and the menus never opened. The tool finds them structurally — a boolean call
   right after a read of the stored key, set up with `mov rsi,rax` (a freshly decrypted marker) — and
   rewrites each call as `mov eax,1` (22 sites in 0.97.12, all inside real cheat handlers).

The tier function is left untouched, so the game's own state machine still drives everything: no key =
"cheats disabled" with the key field offered, any key = cheats on, *disable cheats* = off again.
`mdrg-cheats --clear-key` clears a stored key if you want the field back; `--set-key [KEY]` writes a
canonical one.

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
