# Security policy / 安全问题

English | [中文](#中文)

## Reporting a vulnerability

**Please don't report security problems in public issues, Discussions or the QQ group.** Report them privately instead:

- **[Report a vulnerability](https://github.com/greyoak111/cccodroid/security/advisories/new)** (GitHub private vulnerability reporting). Only you and the maintainer can see it.

Include what you found, how to reproduce it, which version you tested, and what an attacker would need (for example, another app on the same phone, or the gateway token). A rough report is fine; you don't need a polished write-up.

What happens next:

- You'll get a reply within a few days. The project is maintained by one person, so please be patient.
- Once confirmed, the fix goes into the next patch release, usually within days.
- After the release, the advisory is published. You'll be credited in the advisory and the release notes, unless you'd rather not be.

## Supported versions

Only the latest release is supported. Fixes are not backported.

## What counts

cccodroid runs Claude Code on the phone and serves its UI from a local gateway on `127.0.0.1`. Other apps on the same phone can connect to that port, so the gateway requires a per-install token. Things we especially want to hear about:

- getting past the token, Host or Origin checks, or reaching the gateway from a web page or another app;
- code in an HTML preview, a downloaded file or a web page reaching the gateway or the app's native bridge;
- path checks that can be escaped (deleting or reading outside the intended folder);
- anything that undermines the download checks for Claude Code, the toolkit or components (see [docs/download-sources.md](docs/download-sources.md));
- crashing the gateway or wiping data with crafted input.

What the app's permissions are for, and what Claude can reach because of them, is explained in [docs/permissions.md](docs/permissions.md).

Not in scope: anything that already requires running arbitrary code as the app (Claude itself can run commands; that's the point of the app), problems in Claude Code itself (report those to [Anthropic](https://www.anthropic.com/responsible-disclosure-policy)), and issues that need a rooted or already-compromised phone.

Testing tip: use a spare install or a separate test gateway, never the data you actually use. Some of these bugs delete things.

---

## 中文

## 怎么报告

**安全问题请不要发在公开的 Issue、讨论区或 QQ 群里**，请私下报告：

- **[私密报告漏洞](https://github.com/greyoak111/cccodroid/security/advisories/new)**（GitHub 的私密漏洞报告，只有你和维护者看得到）。

写清楚发现了什么、怎么复现、在哪个版本上测的，以及利用它需要什么前提，比如同一台手机上的另一个应用，或者要先拿到网关令牌。写得粗一点也没关系。

之后的流程：

- 几天内会回复。项目只有一个人维护，请多担待。
- 确认后修复会放进下一个补丁版本，一般几天内发。
- 发版后公开这条安全公告。公告和更新说明里会写上你的名字，不想署名可以说一声。

## 支持的版本

只修最新发布的版本，不往旧版本回补。

## 哪些算安全问题

cccodroid 在手机上跑 Claude Code，界面由一个监听 `127.0.0.1` 的本机网关提供。同一台手机上的其他应用也能连上这个端口，所以网关要求每次安装各自生成的令牌。特别想知道的是：

- 绕过令牌、Host、Origin 校验，或者从网页、其他应用碰到网关；
- HTML 预览、下载来的文件或网页里的代码，碰到网关或应用的原生桥；
- 路径检查能被绕过（删到、读到不该碰的目录）；
- 能让 Claude Code、工具包或组件的下载校验失效（见 [docs/download-sources.zh-CN.md](docs/download-sources.zh-CN.md)）；
- 用构造的输入让网关崩溃或者删掉数据。

应用的各项权限拿来干什么、Claude 因此碰得到什么，见 [docs/permissions.zh-CN.md](docs/permissions.zh-CN.md)。

不算的：本来就要以应用身份执行任意代码才能做到的事（Claude 本身就能跑命令，这正是这个应用的用途）；Claude Code 本身的问题（请报告给 [Anthropic](https://www.anthropic.com/responsible-disclosure-policy)）；需要 root 或者手机已经被攻破才能成立的问题。

测试时请用一台测试机或单独的测试网关，别用你真正在用的数据。有些问题一触发就会删东西。
