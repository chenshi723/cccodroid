import fs from "node:fs";
import path from "node:path";
import { CFG, LIVE } from "./config.mjs";
import { findSessionFile } from "./sessions.mjs";
import { RUNS } from "./runs.mjs";
import { publish } from "./bus.mjs";

// ── /goal 目标（上游 2.1.x：设一个完成条件，Claude 跨轮一直干到满足为止）──
// -p 模式下目标状态不进事件流，只记在会话记录里：attachment.type === "goal_status"
//   设定 → {met:false, sentinel:true, condition}；没达成 → {met:false, condition, reason}；
//   达成 → {met:true, iterations, durationMs, tokens}；做不到 → {failed:true, reason}
// 「/goal clear」（stop/off/reset/none/cancel 同义）只留一条命令记录，没有 goal_status，要自己认。
const GOAL_CLEAR = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
export function goalStateOf(file) {
  let txt = "";
  try {
    const st = fs.statSync(file), n = Math.min(st.size, 512 * 1024), fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); txt = b.toString("utf8"); } finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = txt.split("\n");
  let last = null, lastAt = 0, setAt = null, checks = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes("goal")) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!last && e.type === "user" && typeof e.message?.content === "string") {
      const m = e.message.content.match(/<command-name>\/goal<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
      if (m && GOAL_CLEAR.has(m[1].trim().toLowerCase())) return null;   // 最近一次是清除
    }
    const a = e.type === "attachment" && e.attachment?.type === "goal_status" ? e.attachment : null;
    if (!a) continue;
    if (!last) { last = a; lastAt = Date.parse(e.timestamp) || 0; if (a.met || a.failed) break; }
    if (a.condition !== last.condition) break;
    if (a.sentinel) { setAt = Date.parse(e.timestamp) || null; break; }
    if (!a.met) checks++;
  }
  if (!last) return null;
  const base = { condition: String(last.condition || "").slice(0, 600), at: lastAt };
  if (last.met || last.failed) return { ...base, done: true, met: !!last.met, failed: !!last.failed, reason: String(last.reason || "").slice(0, 600),
    iterations: last.iterations ?? null, durationMs: last.durationMs ?? null, tokens: last.tokens ?? null };
  return { ...base, active: true, setAt, checks, reason: last.sentinel ? "" : String(last.reason || "").slice(0, 600) };
}
// 跑着的时候每 4 秒看一眼（只看有会话号的轮），变了才推；每轮结束再补看一次（见 endRun），最后那次达成不会漏
const GOAL_SEEN = new Map();   // 会话号 → 上次推出去的 JSON
export function goalCheck(sid) {
  const f = sid && findSessionFile(sid);
  if (!f) return;
  const g = goalStateOf(f.file), j = JSON.stringify(g);
  if (GOAL_SEEN.get(sid) === j) return;
  GOAL_SEEN.set(sid, j);
  if (GOAL_SEEN.size > 200) GOAL_SEEN.delete(GOAL_SEEN.keys().next().value);
  publish({ type: "goal", sessionId: sid, goal: g });
}
if (LIVE) setInterval(() => { for (const r of RUNS.values()) { goalCheck(r.sessionId); tasksCheck(r.sessionId); } }, 4000).unref?.();

// 任务清单（TaskCreate / TaskUpdate）：claude 存在 ~/.claude/tasks/<会话号>/<编号>.json，--resume 沿用同一会话号，所以每轮换进程也接得上
const TASKS_DIR = path.join(CFG.home, ".claude", "tasks");
export function tasksOf(sid) {
  if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) return null;
  const d = path.join(TASKS_DIR, sid);
  let names; try { names = fs.readdirSync(d).filter((n) => /^\d+\.json$/.test(n)); } catch { return null; }
  const list = [];
  for (const n of names) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(d, n), "utf8"));
      if (!t || t.status === "deleted") continue;
      list.push({ id: String(t.id || n.replace(".json", "")), subject: String(t.subject || "").slice(0, 200),
        status: t.status || "pending", active: t.activeForm ? String(t.activeForm).slice(0, 200) : "",
        blocked: Array.isArray(t.blockedBy) && t.blockedBy.length ? t.blockedBy.map(String) : undefined });
    } catch {}
  }
  if (!list.length) return null;
  list.sort((x, y) => (Number(x.id) || 0) - (Number(y.id) || 0));
  return list.slice(0, 60);
}
const TASKS_SEEN = new Map();
export function tasksCheck(sid) {
  if (!sid) return;
  const t = tasksOf(sid), j = JSON.stringify(t);
  if ((TASKS_SEEN.get(sid) ?? "null") === j) return;
  TASKS_SEEN.set(sid, j);
  if (TASKS_SEEN.size > 200) TASKS_SEEN.delete(TASKS_SEEN.keys().next().value);
  publish({ type: "tasks", sessionId: sid, tasks: t });
}
