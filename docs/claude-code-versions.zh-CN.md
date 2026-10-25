# Claude Code 版本：真机验证与已知问题

中文 | [English](claude-code-versions.md)

cccodroid 跑的是官方原版 Claude Code，一个字节都不改。Anthropic 每发一版，cccodroid 用户都可能拿到，可这一版在电脑上没问题，不代表在安卓上也没问题。比如它开始用一个新的系统调用，安卓的 seccomp 会把这个调用拦下来。cccodroid 的垫片会把它改成返回 ENOSYS，所以进程不会死；但这一版要是没有退路，相应的功能就会出毛病。

所以维护者会在真机上验新版，把结果签名后发给所有用户。

## 用户看到什么

**设置 → 更新 → Claude Code 版本**的选单里：

| 标记 | 意思 |
|---|---|
| **已验证** | 维护者在真机上跑过这一版，后面写着在哪台设备、哪个 Android 版本上验的（多台时写「等 N 台」） |
| **还没验证** | 只出现在 stable / latest 两个渠道行上：这一版还没人验过，不代表有问题 |
| **有已知问题：……** | 维护者确认这一版在 cccodroid 上有问题，后面写着原因和绕法；修好的版本出来后会注明「x.y.z 已修」。选这一版之前会先问你 |

自动更新：渠道（stable 或 latest）走到一个**有已知问题**的版本时，连着 Wi-Fi 也不会自动装。更新状态里会写明原因。你自己点「更新」或在选单里选它，照样能装。固定了版本的不受影响。

验证记录每 3 小时取一次。取不到时（没网、官网和 GitHub 都连不上）沿用上次的，选单照常能用，只是少了标记。

## 验了什么，没验什么

`scripts/verify-claude.mjs` 在 cccodroid 的终端里跑。要验的版本先装进临时目录，不动当前装的那一版；装的时候照常按官方清单核 sha256（或 npm 签名）。之后套上 seccomp 监督器（`enosys-run -v -f`）跑三步：

1. **version**：`claude --version` 报的是这一版
2. **tools**：调一次模型，让它用 Bash 工具写一个文件再读出来。拉子进程、读写文件、流式输出都走一遍
3. **resume**：用 `--resume` 接着上一轮问一句，检查会话记录能读能写

全程记下被安卓 seccomp 拦下的系统调用。以前见过、Claude Code 自己会退回老调用的（Android 14 上的 `epoll_pwait2`、`faccessat2`）标成已知；出现没见过的会单独提醒，维护者确认功能没缺之后才会发布。

没验的：界面里每一个功能、各家第三方接口、每一种设备和 ROM。「已验证」的意思是「核心链路在这台设备上通了」，不是「什么都不会坏」。遇到问题请照常反馈，确认后这一版会被标成有问题。

## 维护者：怎么验、怎么发

在手机上（cccodroid 的终端，用你自己的登录，三步只花很少的额度）：

```sh
node /sdcard/…/cccodroid/scripts/verify-claude.mjs latest      # 或 stable、或具体版本号
```

结果写成当前目录下的 `claude-verify-<版本>.json`。28 版和 36 版安装包最好各跑一次（执行方式不同）。

在发布机上：

```sh
node scripts/claude-verified.mjs add claude-verify-2.1.310.json …    # 并进验证记录
node scripts/claude-verified.mjs bad 2.1.311 --zh "终端里粘贴会卡住，先固定到 2.1.310" --en "Pasting in the terminal hangs; pin 2.1.310 for now"
node scripts/claude-verified.mjs bad 2.1.311 --zh "…" --en "…" --fixed 2.1.312   # 有修好的版本了
node scripts/claude-verified.mjs unbad 2.1.311     # 撤掉「有问题」
node scripts/claude-verified.mjs list
```

每条命令都会：用组件索引那把钥匙签名 → 用 App 里的公钥自验 → 提交推送 `claude-code/verified.json(.sig)` → 等 cccodroid.net 同步（官网生成器同样先验签才镜像）。想先看签出来的内容，加 `PUB_DRY=1` 演练，不写文件也不推送。

`add` 会拒收没通过的结果，也拒收不是在 cccodroid 终端里跑出来的结果（没有 App 版本或安装包类型的那种）。

## 代码在哪

| 位置 | 做什么 |
|---|---|
| `scripts/verify-claude.mjs` | 真机验证（手机上跑） |
| `scripts/claude-verified.mjs`、`scripts/signed-pub.mjs` | 维护验证记录、签名发布（与 `notice.mjs` 共用发布部分） |
| `gateway/gw/ccverified.mjs` | 取记录、验签、落盘到 `home/.cache/cccodroid/claude-verified.json` |
| `gateway/web/app/10-settings-device.js` | 版本选单里的标记与确认 |
| `android/java/cc/codroid/Updater.java`（`knownBad`） | 自动更新跳过有问题的版本 |
| `gateway/tests/ccverified.test.mjs` | 验签、只往新的换、格式不对时的处理 |
