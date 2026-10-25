# cccodroid help

cccodroid runs the **official, unmodified Claude Code** on your phone, wraps it in a graphical interface and ships a full developer toolchain. Claude can read and write files, run commands and start local servers, just as it would in a terminal on a computer.

## Getting started

1. **Install the toolkit**: on first launch, tick the modules you want. The default set is about 330 MB and resumes if interrupted.
2. **Sign in or add a key**: authorize your Claude account once in the browser, or enter a key for Anthropic, DeepSeek, Qwen or another compatible endpoint.
3. **Start a conversation**: tap ＋ in the top bar, or New chat in the sidebar.
4. **Put it to work**: Claude asks before editing files or running commands; switch the permission mode under the input bar.

## The screen

The right end of the top bar normally shows just ⋯. Tap it and the shortcuts you use most slide out to its left; tap it again (it is now ›) to tuck them away. The app remembers which way you left it.

| Button | What it does |
|---|---|
| 📁 | Files: browse, edit and preview files in the workspace |
| >_ | Terminal: the same toolchain Claude uses |
| 🌐 | Browser: local servers and links from replies; docks on the right on a tablet |
| ‹› | Command palette: slash commands, skills and common actions |
| ＋ | New conversation |
| ⋯ | Show or hide the buttons above |

The menu button at the top left opens the sidebar: places to go at the top (Chats, Projects, Scheduled tasks, with Extensions, Capabilities, Usage and Help under More), recent chats in the middle, and the account row at the bottom, which opens Settings.

The thin line under the top bar shows **context usage**; the further right, the fuller. Its second half shows what is left on the current provider: the share of the 5-hour and weekly limits used when you sign in with a Claude account, or the balance for DeepSeek, Kimi and similar. Tap the line for details; every provider’s quota and spending, plus low-quota reminders, are under **Quota and spending** at the top of the Usage page. In the input area, ＋ attaches files and opens common actions. The row below shows the model, thinking effort and permission mode; tap any of them to change it.

## Conversations

- **Enter sends.** Sending while Claude is busy queues the message; ⚡ interjects into the running turn without stopping it.
- `/` opens slash commands and `@` references a file. Use Share → cccodroid in other apps to attach files directly.
- The top row of ＋ next to the input box: Attach file, Take photo, Screenshot, Browse files. Photos are scaled to 2048 px on the long side before they're attached. **Long-press Screenshot to take it in 5 seconds**: switch to the app you want to capture in the meantime, and you'll be brought back afterwards.
- Tool calls collapse into one line such as "3 steps · done"; tap to see each step. Steps that need you, or that failed, open on their own.
- Paths in replies open in the viewer; web links open in the in-app browser.
- Every message has four buttons. Yours: copy, resend, rewind to here, delete. Claude's: copy, share, fork from here, delete.
- **Rewind to here** first lists the files changed since, then lets you undo just the code, or the code and the conversation. Files changed by shell commands are not restored.
- `/goal <condition>` keeps Claude working turn after turn until the condition is met. Background tasks and the task list appear above the input box, and each can be stopped; several background tasks fold into one line, tap it to expand.
- The Chats page searches message content, filters, and exports or imports zips. Deleted chats stay in the trash for 30 days.

## Permissions and safety

| Mode | Behaviour |
|---|---|
| Ask me (default) | Reads freely; asks before editing files, running commands or going online |
| Accept edits | Edits without asking; still asks before commands |
| Plan | Reads and plans only, and acts once you approve |
| Auto | Claude's classifier decides what needs asking (experimental) |
| Deny unasked | Anything that would need approval is refused; for unattended runs |
| Allow everything | Never asks; only when you trust the task completely |

- Approval cards appear under the tool that needs them, and a bar above the input box keeps them in view. Allow, always allow, or deny with an optional reason.
- In the background you are notified when a turn ends or needs you. Notifications can only deny; to allow, come back and read the full command.
- Keys stay in the app's private directory. Account sign-in is handled by Claude Code itself; the app never touches your credentials.

## Projects and scheduled tasks

A **project** is a working folder with its own instructions (CLAUDE.md) and default model, effort and permissions. Conversations started in a project run in that folder and pick up its instructions automatically.

- Sidebar → Projects → New project: create a folder in the workspace, use an existing folder, or clone from git. With an existing folder, conversations you started there before are added automatically.
- The welcome screen of a new conversation lets you pick a project; a project tag then appears under the input box.
- Long-press an existing conversation (or tap ⋯) and choose Move to project; its record moves along.
- The filter bar on the Chats page can show one project, or only conversations created by scheduled tasks (marked with a clock).

A **scheduled task** runs Claude once on this device at the set time. Nobody is there to ask, so anything that needs your approval is denied. Start with read-only for a few days before giving it more.

- Daily, weekly, monthly, every few hours, once, or a cron expression. The form shows the next two run times as you edit.
- For "don't bother me unless something's up": have it reply with one fixed phrase when nothing is found (e.g. "All green") and set notifications to Only when something is found.
- You can limit runs to Wi-Fi or charging, cap cost and duration per run, and set a daily total. Most third-party APIs don't report cost, so cost caps don't apply to them.
- The timer lives in the gateway: tasks run on time while the app is open or in the background. If the system kills it or the device is off, the run is missed and handled by the task's If missed setting next time you open the app; it's never made up silently.

## Files, terminal, browser

- **Files and viewer**: edit and save code in place; if the file changed on disk, you are asked before saving. Markdown, images, PDF and HTML preview directly, and HTML reloads when it changes. Word and Excel open as is; PPT and old .doc need LibreOffice, installed on first use.
- **Terminal**: multiple tabs, plus a row of Esc, Tab, Ctrl and arrow keys. It keeps running when the panel is closed.
- **Browser**: type `127.0.0.1:port` to open a local server. ↗ hands the page to the system browser; sign-in pages always open there.

## Large screens and split screen

Layout follows the window width, not orientation:

- Narrow: one column; files, terminal and browser cover the screen.
- Wide (≥ 840): chat plus a workspace on the right; drag the divider, double-tap to reset.
- Wider (≥ 1000): the sidebar stays docked on the left, and its edge can be dragged too.

## Extensions

- **Toolkit modules**: install and remove as needed; each shows what it is for, its size and what uses it. Typing a missing command in the terminal tells you which module has it.
- **Components**: large tools such as Chromium, Blender, Godot, LibreOffice, llama.cpp and GPU drivers, installed when you need them. Signatures are checked first, and each component ships a skill so Claude knows how to use it.
- **Plugins, skills, MCP**: add and manage them on the Extensions page; changes apply from the next message. More → Capabilities shows everything Claude can use this turn.
- **pkg**: in the terminal, `pkg install rust` installs packages from the Termux repository; `pkg verified` lists the ones tested on device.

## Shizuku and system permissions

- Settings → Device & permissions → Install and activate. It activates over wireless debugging with no computer, and reactivates itself after a reboot.
- Once active, the terminal and Claude can run `priv '<command>'` as the shell user; every call is kept in the Privileged command log.
- **Device tools** (off by default): let Claude post notifications, use the clipboard and share files. Reading and tapping the screen needs accessibility, which can switch on only while in use.
- **Memory manager** (off by default): stops background apps outside your allow list before heavy jobs. In the terminal, use `cc-mem run -- <command>`.

## Updates and repair

- **Auto-update** (on by default): Claude Code updates silently; a new app version is signature-checked, then offered for install; toolkit updates download on Wi‑Fi and are applied the next time you open the app.
- The toolkit can come from GitHub, the cccodroid.net mirror or a local file. If one source stalls, the other takes over and resumes; everything is checked against hashes shipped in the APK.
- Updates are verified against the release manifest before anything is replaced. If one is interrupted, it finishes or rolls back on the next launch.
- The Repair ledger under Settings → Troubleshooting records every install, check and repair.
- **Two install packages**: the usual `cccodroid.apk` targets SDK 28 and runs on the widest range of devices; `cccodroid-36.apk` targets SDK 36 for newer phones whose system refuses apps with an old target SDK. Both have the same features and share data, and you can switch at any time under Settings → Updates → Install package. If the system ever refuses the 28 build, the app remembers it and only updates to 36 from then on; choosing 28 is then blocked. In the 36 build, toolkit programs are started through the system loader, so the odd program that locates its data relative to its own path may misbehave — please report it if you hit one.

## Known issues

- Fixed · All · **Pinyin input not reaching the box on first launch**: fixed in 0.3.7. On older versions, tap outside the input box and back.
- Workaround · All · **Nothing scrolls anywhere**: a bug in the system WebView. The app detects it and recovers in about a second, restoring unsent text; if it does not, press and hold the title in the top bar (the conversation name) for about a second; the title fades, the phone gives a short buzz and recovery starts.
- Workaround · Red Magic / Nubia · **Frozen after about 90 s in the background**: App info → Battery usage → allow background activity, and allow auto-start.
- Workaround · Xiaomi / OPPO / vivo / Huawei · **Aggressive background cleaning**: set battery saving to unrestricted, allow auto-start and lock the card in recents. Per-brand steps are on the website's Known issues page.
- Workaround · ZUI · **"Split screen not supported"**: the system's split-screen blocklist is stale. Reinstall over the top or reboot.
- Investigating · All · **Top bar shows "UI script error: Script error."**: when code the Android shell runs in the page fails, WebView only gives this line, so you can't tell where it came from. From 0.3.13 it reads "<entry point>: <reason>", so a screenshot is enough to track it down. The app usually keeps working.
- Investigating · Non-Snapdragon · **GPU components unavailable**: most need Snapdragon. Mali GPUs such as MediaTek can use gpu-driver-mali; Exynos and Kirin are not supported yet.

## Troubleshooting

Start with Settings → Troubleshooting → Check records, then the Repair ledger. If that does not help, send a Diagnostics bundle to whoever is helping you, or use Report on GitHub: the device, system and self-test results are filled in, and keys and your messages are left out.

If a hook, plugin or CLAUDE.md breaks things, turn on **Safe mode** under Settings → Claude behavior. Nothing custom is loaded until you turn it off again.
