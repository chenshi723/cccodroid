// 演示用「脚本模型」：替换一次性副本里的 startRun，模拟 Claude 的一轮执行。
// 只模拟模型输出本身；排队、插话、停止、授权卡、事件总线、transcript 落盘全部走上游真实代码。
// 本文件只存在于演示进程的一次性 gw 副本中，绝不写入已安装的应用。
import fs from "node:fs";
import crypto from "node:crypto";
import { CFG, PATHS, log } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { PROVIDER } from "./providers.mjs";
import { RUNS, rememberSession, runFlag } from "./runs.mjs";
import { QUEUE, RUN_LANE, RUN_SESSIONS, INTERRUPTED, endRun, holdLane, laneOfItem, permView,
  publishState, runEmit, setInterrupted, clearInterrupted, sidForItem, flushPend } from "./queue.mjs";
import { execIntent, pickProvider } from "./run.mjs";
import { findSessionFile } from "./sessions.mjs";
import { markIncomplete, clearIncomplete } from "./incomplete.mjs";
import { safeModePerm } from "./claude.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => crypto.randomBytes(16).toString("hex");
const now = () => new Date().toISOString();

// ── 剧本：按消息关键词挑场景 ─────────────────────────────────────────
function scenarioOf(message) {
  const m = String(message || "");
  if (/^\s*继续/.test(m)) return { kind: "resume" };
  if (/计划|plan/i.test(m)) return { kind: "plan" };
  if (/问|选择|哪个|ask/i.test(m)) return { kind: "ask" };
  if (/ls|命令|运行|bash|终端|目录/i.test(m)) return { kind: "bash" };
  if (/长文|详细|文章|报告/i.test(m)) return { kind: "long" };
  return { kind: "plain" };
}

const BASH_CMD = "ls -la " + CFG.workspace;
const BASH_OUT = [
  "total 24",
  "drwx------ 3 u0_a403 u0_a403 4096 Nov 18 10:00 .",
  "drwx------ 4 u0_a403 u0_a403 4096 Nov 18 09:58 ..",
  "-rw------- 1 u0_a403 u0_a403  812 Nov 18 10:00 notes.md",
  "-rw------- 1 u0_a403 u0_a403  460 Nov 18 09:59 todo.txt",
  "drwx------ 2 u0_a403 u0_a403 4096 Nov 18 09:58 drafts",
].join("\n");

function replyText(kind, message) {
  const echo = String(message || "").trim().slice(0, 80);
  switch (kind) {
    case "resume": return "接着刚才被打断的地方继续。上一轮已经执行的操作不会回滚，我从确认现场开始往下做。\n\n这一轮会把剩下的步骤补完：先核对已有结果，再给出结论。";
    case "bash": return "收到「" + echo + "」。我先读一下工作区的说明文件，然后用一条 shell 命令列出目录内容。这条命令需要你在授权卡上确认。";
    case "ask": return "收到「" + echo + "」。这件事有两种做法，取舍在你：我把问题和选项列出来，你选一个，我再按选择继续。";
    case "plan": return "收到「" + echo + "」。我先把完整计划写出来给你过目；你确认后我才开始动手。";
    case "long": return "收到「" + echo + "」。下面是一份较长的演示输出，用来观察远程同步的增量传输与滚动阅读。\n\n## 第一节：会话托管做什么\n\n主机继续运行 Claude 会话，另一台设备通过端到端加密的中转查看文字、发送消息、插话、停止本轮，并回答授权卡与选择题。执行环境、终端和工作区文件始终留在主机。\n\n## 第二节：中转看到什么\n\n中转服务器只转发 AES-256-GCM 密文。每个包带随机 12 字节 IV 和 16 字节认证标签，附加认证数据绑定房间号、请求编号和方向。服务器落盘的只有令牌哈希，没有会话正文，也没有密钥。\n\n## 第三节：同步怎样做到省电\n\n控制端不发高频轮询。watch 请求挂在主机的事件总线上，有变化才醒来，合并 80 毫秒内的连续事件，回一帧增量；没有变化就挂满 8 秒回一个心跳。文字增量只传追加的部分，不重发整段。\n\n## 第四节：写操作为什么不怕重发\n\n每个写请求带唯一编号。主机先把编号持久化预占，再调用上游接口；回执丢了、网络重试了，同一个编号只会拿回第一次的结果，不会执行第二遍。编号台账按本次启动和托管授权保存，重启或重新托管后旧编号自然失效。\n\n## 第五节：边界\n\n这不是远程桌面：没有文件同步、没有终端代理、不能远程确认安卓系统弹窗。系统强杀、断网、关机后需要重新打开主机应用。斜杠命令不开放远程发送，配置类操作请在主机进行。";
    default: return "收到「" + echo + "」。这是演示主机的脚本回复：真实部署里，这一段由主机上运行的 Claude 生成，经加密中转逐段同步到这台设备。\n\n我可以继续做几件事，你可以直接发消息试试：\n\n- 发「运行 ls 看看目录」——触发一张 Bash 授权卡；\n- 发「问我一个问题」——触发选择题卡片；\n- 发「给我一个计划」——触发计划确认卡；\n- 发「写一篇长文」——观察长输出的增量同步；\n- 运行中点「停止」——中断本轮并挂起排队消息。";
  }
}

// ── transcript 落盘：与真实 claude 相同的 jsonl 行格式 ────────────────
function appendTranscript(run, blocks) {
  const found = findSessionFile(run.sessionId);
  if (!found) return;
  const lines = [];
  lines.push(JSON.stringify({ type: "user", uuid: crypto.randomUUID(), timestamp: now(), cwd: CFG.workspace,
    message: { role: "user", content: run.text } }));
  let out = 0;
  for (const b of blocks) {
    if (b.role === "assistant") { out += Math.ceil(b.text.length / 4);
      lines.push(JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), timestamp: now(), cwd: CFG.workspace,
        message: { role: "assistant", model: run.exec?.model || "claude-opus-5-5", content: [{ type: "text", text: b.text }],
          usage: { input_tokens: 200000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out } } }));
    } else if (b.role === "tool_use") {
      lines.push(JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), timestamp: now(), cwd: CFG.workspace,
        message: { role: "assistant", model: run.exec?.model || "claude-opus-5-5", content: [{ type: "tool_use", id: b.id, name: b.name, input: b.input }],
          usage: { input_tokens: 200000, output_tokens: out } } }));
    } else if (b.role === "tool_result") {
      lines.push(JSON.stringify({ type: "user", uuid: crypto.randomUUID(), timestamp: now(), cwd: CFG.workspace,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: b.id, content: b.text, is_error: !b.ok }] } }));
    }
  }
  try { fs.appendFileSync(found.file, lines.join("\n") + "\n"); } catch (e) { log("演示落盘失败: " + e.message); }
}

// ── 与上游 startRun 相同的合同：同步占槽、事件、授权、插话、停止 ──────
export async function demoStartRun(item) {
  const { P } = pickProvider(item);
  const intent = execIntent(item);
  const run = {
    id: item.id, text: item.message, sessionId: sidForItem(item), follow: item.follow, cid: item.cid,
    startedAt: Date.now(), child: null, aborted: false, ended: false, preSpawn: false,
    provider: P.id, exec: { provider: P.id, model: intent.model, effort: intent.effort },
    permMode: item.permissionMode || safeModePerm(SETTINGS.permissionMode),
    log: [], pend: null, pendTimer: null, perms: new Map(), bgList: [], inputOpen: true,
    lane: laneOfItem(item), outTok: 0,
  };
  RUNS.set(run.id, run);                    // 同步占槽，中间不许有 await
  RUN_LANE.set(run.id, run.lane);
  runFlag(true);
  if (run.sessionId) { RUN_SESSIONS.set(run.id, run.sessionId); rememberSession(run.sessionId); markIncomplete(run.sessionId, run.id); }
  const emit = (ev) => runEmit(run, ev);
  emit({ type: "run_start", text: run.text, sessionId: run.sessionId, follow: run.follow, cid: run.cid, startedAt: run.startedAt });
  publishState();

  const sc = scenarioOf(run.text);
  const blocks = [];                        // 本轮要落盘的内容
  let permWait = null;                      // 当前授权卡的决议 Promise
  const injected = [];                      // 运行中收到的插话

  run.setMode = (mode) => { run.permMode = safeModePerm(mode); return true; };
  run.readyAbort = new AbortController();
  run.answerPerm = (id, a) => {
    const p = run.perms.get(id);
    if (!p || run.ended || run.aborted) return false;
    run.perms.delete(id);
    emit({ type: "perm_resolved", id, behavior: a.behavior === "allow" ? "allow" : "deny", interrupt: !!a.interrupt });
    if (a.interrupt) { holdLane(run); run.aborted = true; }
    publishState();
    permWait?.({ allow: a.behavior === "allow", answers: a.answers || null, interrupt: !!a.interrupt });
    return true;
  };
  run.inject = (it) => {
    if (run.ended || run.aborted) return false;
    injected.push(it);
    emit({ type: "inject", text: it.message, cid: it.cid, itemId: it.id });
    emit({ type: "run_busy", startedAt: Date.now() }); flushPend(run);
    return true;
  };

  const finishAborted = () => {
    if (run.ended) return;
    for (const id of [...run.perms.keys()]) { run.perms.delete(id); emit({ type: "perm_resolved", id, behavior: "cancel" }); }
    permWait?.({ allow: false, cancel: true });
    setInterrupted([...INTERRUPTED.filter((e) => e.id !== run.id),
      { id: run.id, sessionId: run.sessionId, text: String(run.text).slice(0, 64 << 10), startedAt: run.startedAt, at: Date.now() }]);
    endRun(run, { durationMs: Date.now() - run.startedAt });
  };
  run.readyAbort.signal.addEventListener("abort", finishAborted);

  // 发一张授权卡并等回答（停止/拒绝并停止会经 readyAbort / answerPerm 进来）
  const askPerm = (p) => new Promise((resolve) => {
    permWait = resolve;
    run.perms.set(p.id, p);
    emit({ type: "perm_request", ...permView(p) });
    publishState();
  });
  const stream = async (text, role = "assistant") => {
    blocks.push({ role, text });
    const chunks = text.match(/[\s\S]{1,14}/g) || [];
    for (const c of chunks) {
      if (run.aborted || run.ended) return;
      runEmit(run, { type: role === "thinking" ? "thinking_delta" : "delta", text: c });
      await sleep(34);
    }
    flushPend(run);
  };
  const tool = async (name, input, out, ok = true) => {
    const id = "toolu_" + uid().slice(0, 24);
    emit({ type: "tool_use", id, name, input });
    blocks.push({ role: "tool_use", id, name, input });
    await sleep(650);
    if (run.aborted || run.ended) return;
    emit({ type: "tool_result", id, ok, text: out });
    blocks.push({ role: "tool_result", id, ok, text: out });
  };
  const meter = () => {
    run.outTok += 120;
    runEmit(run, { type: "usage", contextTokens: 208000 + run.outTok, outputTokens: run.outTok });
    runEmit(run, { type: "run_tokens", out: run.outTok });
  };

  try {
    emit({ type: "phase", phase: "connect" }); await sleep(420);
    if (run.aborted) return finishAborted();
    emit({ type: "phase", phase: "wait" }); await sleep(480);
    if (run.aborted) return finishAborted();
    await stream("先核对一下上下文和这条消息的意图，再决定要不要动工具。", "thinking");
    if (run.aborted) return finishAborted();
    meter();
    await stream(replyText(sc.kind, run.text));
    if (run.aborted) return finishAborted();

    if (sc.kind === "bash") {
      await tool("Read", { file_path: CFG.workspace + "/notes.md" }, "工作区笔记：演示数据，不含真实文件。");
      if (run.aborted) return finishAborted();
      const p = { id: "perm-" + uid(), tool: "Bash", input: { command: BASH_CMD, description: "列出演示工作区目录" },
        suggestions: [], reason: null, at: Date.now(), runId: run.id, sessionId: run.sessionId };
      const a = await askPerm(p);
      if (run.aborted || run.ended) return finishAborted();
      if (a.allow) {
        await tool("Bash", p.input, BASH_OUT);
        await stream("目录里是演示用的笔记和草稿。命令已在主机执行，输出同步给你；文件本身没有离开主机。");
      } else {
        await stream("好的，这条命令不执行。需要的话你可以换一条命令，或到主机本机操作。");
      }
    } else if (sc.kind === "ask") {
      const p = { id: "perm-" + uid(), tool: "AskUserQuestion",
        input: { questions: [{ question: "演示笔记要整理成哪种格式？", header: "输出格式", multiSelect: false,
          options: [{ label: "Markdown 清单", description: "按主题分组的待办清单" }, { label: "一段摘要", description: "两百字以内的连贯摘要" },
            { label: "保持原样", description: "只看不改" }] }] },
        suggestions: [], reason: null, at: Date.now(), runId: run.id, sessionId: run.sessionId };
      const a = await askPerm(p);
      if (run.aborted || run.ended) return finishAborted();
      if (a.allow) {
        const picked = a.answers && Object.values(a.answers)[0];
        await stream("你选择了「" + (picked || "第一项") + "」。我按这个选择继续整理；选择结果已经回到主机的这一轮里。");
      } else await stream("好的，先不整理，保持原样。");
    } else if (sc.kind === "plan") {
      const p = { id: "perm-" + uid(), tool: "ExitPlanMode",
        input: { plan: "## 演示计划\n\n1. 读取工作区笔记（只读）\n2. 生成整理后的清单草稿\n3. 把草稿写回 drafts/ 目录（需再次授权）\n\n每一步都在主机执行；远程只看到文字与授权卡。" },
        suggestions: [], reason: null, at: Date.now(), runId: run.id, sessionId: run.sessionId };
      const a = await askPerm(p);
      if (run.aborted || run.ended) return finishAborted();
      if (a.allow) await stream("计划已确认。我先做只读的第一步，写入步骤会再单独征求授权。");
      else await stream("计划未获确认，我停在这里，不做任何改动。");
    } else if (sc.kind === "long") {
      meter();
    } else if (sc.kind === "plain") {
      await tool("Read", { file_path: CFG.workspace + "/todo.txt" }, "演示待办：1. 验证远程同步 2. 验证授权卡 3. 验证停止与继续");
    }
    if (run.aborted || run.ended) return finishAborted();

    // 运行中收到的插话：并进本轮接着答
    while (injected.length) {
      const it = injected.shift();
      await stream("收到插话「" + String(it.message).slice(0, 60) + "」。已并进当前这一轮，不打断正在进行的步骤。");
      if (run.aborted || run.ended) return finishAborted();
    }
    meter();
    await sleep(300);
    if (run.aborted) return finishAborted();
    appendTranscript(run, blocks);
    if (run.sessionId) { clearInterrupted(run.sessionId); clearIncomplete(run.sessionId); }
    endRun(run, { durationMs: Date.now() - run.startedAt, usage: { output_tokens: run.outTok }, costUsd: 0.02 });
  } catch (e) {
    log("演示驱动出错: " + (e.stack || e.message));
    if (!run.ended) { emit({ type: "error", message: "演示驱动出错：" + e.message }); endRun(run, { failed: true }); }
  }
}

// ── 初始演示会话：给历史窗口一点可翻的内容 ───────────────────────────
export function seedDemoSessions(sid, privateSid) {
  const dir = PATHS.projects + "/-demo-workspace";
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 3600e3;
  const line = (o) => JSON.stringify(o);
  const hist = [
    { type: "user", uuid: crypto.randomUUID(), timestamp: new Date(t0).toISOString(), cwd: CFG.workspace,
      message: { role: "user", content: "这个会话用来演示「会话托管」：平板继续跑任务，手机远程看文字、发消息、处理授权。先介绍一下你自己。" } },
    { type: "assistant", uuid: crypto.randomUUID(), timestamp: new Date(t0 + 30e3).toISOString(), cwd: CFG.workspace,
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "我是运行在这台平板上的 Claude 会话。开启托管后，另一台设备可以看到这段文字、给我发消息、在我需要确认时替我回答授权卡。文件和执行环境始终留在这台平板上。" }],
        usage: { input_tokens: 180000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 260 } } },
    { type: "user", uuid: crypto.randomUUID(), timestamp: new Date(t0 + 120e3).toISOString(), cwd: CFG.workspace,
      message: { role: "user", content: "远程能看到我的其他会话吗？" } },
    { type: "assistant", uuid: crypto.randomUUID(), timestamp: new Date(t0 + 150e3).toISOString(), cwd: CFG.workspace,
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "不能。只有我在托管面板里明确开启托管的会话才会出现在远端列表里。其他会话——比如旁边那条私人笔记——对配对设备完全不可见，读取请求会被主机直接拒绝。" }],
        usage: { input_tokens: 182000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 320 } } },
    { type: "user", uuid: crypto.randomUUID(), timestamp: new Date(t0 + 300e3).toISOString(), cwd: CFG.workspace,
      message: { role: "user", content: "中转服务器能看到我们说的话吗？" } },
    { type: "assistant", uuid: crypto.randomUUID(), timestamp: new Date(t0 + 330e3).toISOString(), cwd: CFG.workspace,
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "看不到。两台设备之间的每个包都用 AES-256-GCM 端到端加密，密钥只存在于配对码里，从不经过服务器。服务器只转发不透明密文，落盘的只有令牌哈希。你可以在演示页的「中转视角」里亲眼看到：那里只有密文片段和字节数。" }],
        usage: { input_tokens: 184000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 400 } } },
  ];
  fs.writeFileSync(dir + "/" + sid + ".jsonl", hist.map(line).join("\n") + "\n");
  fs.writeFileSync(dir + "/" + privateSid + ".jsonl", line({ type: "user", uuid: crypto.randomUUID(),
    timestamp: new Date(t0 + 600e3).toISOString(), cwd: CFG.workspace,
    message: { role: "user", content: "私人笔记：这条会话没有开启托管，远端设备看不到它。" } }) + "\n");
  // 工作区里的演示文件（Read 工具剧本会引用）
  fs.writeFileSync(CFG.workspace + "/notes.md", "# 演示笔记\n\n这是演示工作区里的示例文件，不含真实数据。\n");
  fs.writeFileSync(CFG.workspace + "/todo.txt", "演示待办：\n1. 验证远程同步\n2. 验证授权卡\n3. 验证停止与继续\n");
  fs.mkdirSync(CFG.workspace + "/drafts", { recursive: true });
  rememberSession(sid);
}