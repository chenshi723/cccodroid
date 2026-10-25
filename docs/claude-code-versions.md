# Claude Code versions: on-device verification and known issues

[中文](claude-code-versions.zh-CN.md) | English

cccodroid runs the official Claude Code binary, unmodified. Every new Anthropic release can reach cccodroid users, and a release that works on a desktop can still break on Android. For example, if it starts using a newer system call, Android's seccomp filter blocks it. cccodroid's shim turns that into an ENOSYS return so the process survives, but if that release has no fallback, the feature that needed the call breaks.

So the maintainer verifies new releases on a real device and publishes the results, signed, to every user.

## What you see

In **Settings → Updates → Claude Code version**:

| Mark | Meaning |
|---|---|
| **Verified** | The maintainer ran this version on a real device; the device and Android version follow the mark ("(N devices)" if several) |
| **not verified yet** | Only on the stable / latest rows: nobody has checked this version yet. It doesn't mean it's broken |
| **Known issue: …** | Confirmed broken on cccodroid, with the reason and a workaround; once a fixed release exists it says "fixed in x.y.z". You're asked to confirm before switching to it |

Auto-update: if the channel (stable or latest) moves to a version with a known issue, it isn't installed automatically, even on Wi-Fi, and the update status says why. You can still install it yourself with "Update" or from the version picker. Pinned versions aren't affected.

The record is fetched every 3 hours. If it can't be fetched (offline, or both cccodroid.net and GitHub unreachable) the last copy is used. The picker works as usual either way, just without marks if no copy was ever fetched.

## What's checked, and what isn't

`scripts/verify-claude.mjs` runs in cccodroid's terminal. It installs the version into a temporary directory without touching the one you use, checked against the official manifest sha256 (or npm signature) as usual. Then it runs three steps under the seccomp supervisor (`enosys-run -v -f`):

1. **version**: `claude --version` reports that version
2. **tools**: one model call that uses the Bash tool to write a file and read it back. This covers spawning processes, file I/O and streaming output
3. **resume**: one more turn with `--resume`, which covers reading and writing the session transcript

Every system call blocked by Android's seccomp is recorded. Known ones that Claude Code falls back from (`epoll_pwait2`, `faccessat2` on Android 14) are marked as such. Any new one is flagged, and the maintainer checks nothing is missing before publishing.

Not checked: every UI feature, every third-party provider, every device and ROM. "Verified" means "the core path works on this device", not "nothing can break". Please keep reporting problems; once confirmed, the version gets marked as having a known issue.

## Maintainers: verifying and publishing

On the phone, in cccodroid's terminal (uses your own login; the three steps cost very little):

```sh
node /sdcard/…/cccodroid/scripts/verify-claude.mjs latest      # or stable, or a version number
```

The result is written to `claude-verify-<version>.json` in the current directory. Ideally run it once with the targetSdk 28 package and once with the 36 package, since they execute binaries differently.

On the release machine:

```sh
node scripts/claude-verified.mjs add claude-verify-2.1.310.json …
node scripts/claude-verified.mjs bad 2.1.311 --zh "终端里粘贴会卡住，先固定到 2.1.310" --en "Pasting in the terminal hangs; pin 2.1.310 for now"
node scripts/claude-verified.mjs bad 2.1.311 --zh "…" --en "…" --fixed 2.1.312
node scripts/claude-verified.mjs unbad 2.1.311
node scripts/claude-verified.mjs list
```

Each command signs with the component-index key, verifies against the public key shipped in the app, commits and pushes `claude-code/verified.json(.sig)`, then waits for cccodroid.net to pick it up (the site generator also checks the signature before mirroring). Set `PUB_DRY=1` to see what would be signed without writing or pushing anything.

`add` refuses results that didn't pass, and results that weren't produced in cccodroid's terminal (no app version or package type).

## Where the code lives

| Path | What it does |
|---|---|
| `scripts/verify-claude.mjs` | On-device verification (runs on the phone) |
| `scripts/claude-verified.mjs`, `scripts/signed-pub.mjs` | Maintaining the record and publishing it signed (publishing shared with `notice.mjs`) |
| `gateway/gw/ccverified.mjs` | Fetching, signature check, saving to `home/.cache/cccodroid/claude-verified.json` |
| `gateway/web/app/10-settings-device.js` | Marks and confirmation in the version picker |
| `android/java/cc/codroid/Updater.java` (`knownBad`) | Auto-update skips versions with known issues |
| `gateway/tests/ccverified.test.mjs` | Signature check, newer-only replacement, malformed input |
