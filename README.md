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

The script locates that coroutine structurally too: the checker is the one function called once by the
tier function and three times in a row by the enter-code path. It then neutralises exactly one 6-byte
branch — the verdict on *your* key — so the store block is reached no matter what you typed. The two
self-test keys, the RSA check and the tier/disable logic are left untouched, so the game's own
enable/disable flow keeps working.

`mdrg-cheats --status` also repairs the key slot: the stored key is written into the game's own
PlayerPrefs (`<persistentDataPath>/Saves/PlayerPrefs.pp`), located via the game's `app.info`.

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
