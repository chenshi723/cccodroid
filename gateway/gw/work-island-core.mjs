// ── 工作岛核心：事件 → 状态文案 → 完成判定 ────────────────────────────────
// 纯逻辑，不碰进程、不读设置、不订阅总线；方便单元测试。
// 外面的 work-island.mjs 负责把它接到真实总线、runs 和 am 上。
//
// 设计要点：
//  · 更新最多 1.5 秒一次，只保留最后一条；到时补发最后那条。
//  · 收工看 runs（所有活跃轮次），不看 run；run_end 后仍要等 3 秒宽限。
//  · error 只显示「出错了」，不转发 message（可能含路径/命令输出）；子任务也只显示「子任务…」。
//  · 关掉开关 / 网关退出时，只要岛上还挂着（含「任务完成」那 8 秒）就发 IDLE 收起。
//  · 文案跟随 LAST_LANG：zh 开头用中文，否则英文。

const ZH = {
  working: "正在干活",
  done: "任务完成",
  waiting: "等你确认",
  start: "正在处理…",
  wait: "等模型回复…",
  think: "正在想…",
  text: "正在写回复…",
  tool: (n) => `用 ${n}…`,
  perm: (n) => `需要你确认：${n}`,
  resume: "继续…",
  compact: "整理上下文…",
  sub: "子任务…",
  bg: "后台任务还在跑…",
  error: "出错了",
  aborted: "已中止",
  idleTitle: "工作岛",
  idleText: "在后台等下一轮",
  took: (s) => `用时 ${s}`,
  toolName: (n) => ({
    Bash: "执行命令", Read: "读文件", Write: "写文件", Edit: "改文件",
    Glob: "找文件", Grep: "搜代码", WebSearch: "查资料", WebFetch: "读网页",
    Task: "子任务", Agent: "子任务", TodoWrite: "整理清单", NotebookEdit: "改笔记",
    Skill: "调用技能", KillShell: "收尾命令",
  })[n] || n || "工具",
};

const EN = {
  working: "Working",
  done: "Done",
  waiting: "Waiting for you",
  start: "Processing…",
  wait: "Waiting for the model…",
  think: "Thinking…",
  text: "Writing…",
  tool: (n) => `Using ${n}…`,
  perm: (n) => `Waiting for approval: ${n}`,
  resume: "Continuing…",
  compact: "Compacting context…",
  sub: "Subtask…",
  bg: "Background task still running…",
  error: "Error",
  aborted: "aborted",
  idleTitle: "Work Island",
  idleText: "Waiting for the next run",
  took: (s) => `Took ${s}`,
  toolName: (n) => ({
    Bash: "a command", Read: "a file", Write: "a file", Edit: "a file",
    Glob: "files", Grep: "code", WebSearch: "the web", WebFetch: "a page",
    Task: "a subtask", Agent: "a subtask", TodoWrite: "the list",
    NotebookEdit: "a notebook", Skill: "a skill", KillShell: "a command",
  })[n] || n || "a tool",
};

function humanDuration(sec, zh) {
  if (zh) return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/**
 * @param {object} opts
 * @param {(action:string,title:string,text:string,since:number)=>void} opts.send  发通知
 * @param {()=>Array} [opts.runs]     读活跃轮次（默认空）
 * @param {()=>string} [opts.lang]    最近界面语言
 * @param {()=>number} [opts.clock]   当前时间（测试可替换）
 * @param {number} [opts.graceMs]     收工宽限，默认 3000
 * @param {number} [opts.idleMs]      完成后收起，默认 8000
 * @param {number} [opts.throttleMs]  更新最小间隔，默认 1500
 */
export function createWorkIsland(opts = {}) {
  const send = opts.send || (() => {});
  const sendSync = opts.sendSync || send;
  const runs = opts.runs || (() => []);
  const lang = opts.lang || (() => "zh");
  const clock = opts.clock || Date.now;
  const graceMs = opts.graceMs ?? 3000;
  const idleMs = opts.idleMs ?? 8000;
  const throttleMs = opts.throttleMs ?? 1500;

  const L = () => (String(lang() || "zh").startsWith("zh") ? ZH : EN);
  const liveRuns = () => (runs() || []).filter((r) => r && !r.ended);

  let active = null;        // { id, startedAt, last }
  let shown = false;        // 岛上还挂着东西（干活中，或「任务完成」还没收起）
  let doneTimer = null;
  let idleTimer = null;
  let lastSent = 0;
  let pending = null;       // 节流时保留的最后一条
  let pendingTimer = null;

  const emit = (action, title, text, since) => {
    try { send(action, title, text, since); } catch {}
  };
  const emitSync = (action, title, text, since) => {
    try { sendSync(action, title, text, since); } catch {}
  };

  function clearPending() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    pending = null;
  }

  function sendUpdate(title, text, since) {
    const t = clock();
    if (t - lastSent >= throttleMs) {
      lastSent = t;
      shown = true;
      emit("UPDATE", title, text, since);
      return;
    }
    pending = { title, text, since };
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (!active || !pending) { pending = null; return; }
      const p = pending;
      pending = null;
      lastSent = clock();
      shown = true;
      emit("UPDATE", p.title, p.text, p.since);
    }, Math.max(0, throttleMs - (t - lastSent)));
  }

  function update(text, title) {
    if (!active) return;
    const t = title || L().working;
    const x = text || "";
    const key = t + "|" + x;
    if (key === active.last) return;
    active.last = key;
    sendUpdate(t, x, active.startedAt);
  }

  function start(run, text) {
    if (active) {
      if (run && run.id) active.id = run.id;
      return update(text);
    }
    clearPending();
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    active = {
      id: (run && run.id) || "",
      startedAt: Number(run && run.startedAt) || clock(),
      last: "",
    };
    update(text || L().start, L().working);
  }

  function finish(reason) {
    if (!active) return;
    const ms = Math.max(0, clock() - active.startedAt);
    active = null;
    clearPending();
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      doneTimer = null;
      if (active) return;
      const live = liveRuns();
      if (live.length) { start(live[0]); return; }   // 宽限期内又跑起来了
      const sec = Math.round(ms / 1000);
      const human = humanDuration(sec, L() === ZH);
      const text = L().took(human) + (reason ? ` · ${reason}` : "");
      shown = true;
      emit("DONE", L().done, text, 0);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!active) { shown = false; emit("IDLE", L().idleTitle, L().idleText, 0); }
      }, idleMs);
    }, graceMs);
  }

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case "run_start":
        start(ev);
        break;
      case "state":
        if (ev.run) start(ev.run);
        else if (active && !liveRuns().length) finish("");
        break;
      case "run_busy":
        update(L().resume, L().working);
        break;
      case "phase":
        if (ev.phase === "wait") update(L().wait);
        else if (ev.phase === "think") update(L().think);
        else if (ev.phase === "text") update(L().text);
        else if (ev.phase === "tool") update(L().tool(L().toolName(ev.name)));
        else if (ev.phase === "retry") update(L().wait);
        break;
      case "tool_use":
        update(L().tool(L().toolName(ev.name)));
        break;
      case "perm_request":
        update(L().perm(L().toolName(ev.tool || ev.name)), L().waiting);
        break;
      case "perm_resolved":
        update(L().resume, L().working);
        break;
      case "compacting":
        update(L().compact);
        break;
      case "sub_progress":
        update(L().sub);           // 不转发子任务描述：是模型写的原文，可能带路径、用户内容
        break;
      case "run_idle":
        if (ev.bg > 0) update(L().bg);
        break;
      case "error":
        update(L().error);          // 不转发 message：可能带路径/命令输出
        break;
      case "run_end":
        if (!active) break;
        if (liveRuns().length) break;   // 还有别的轮次在跑
        finish(ev.aborted ? L().aborted : "");
        break;
    }
  }

  function stop(sync = false) {
    const had = active || shown;
    active = null;
    shown = false;
    clearPending();
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (had) {
      const fn = sync ? emitSync : emit;
      fn("IDLE", L().idleTitle, L().idleText, 0);
    }
  }

  return {
    handleEvent,
    start,
    stop,
    get active() { return active; },
  };
}
