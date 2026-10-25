import { LIVE } from "./config.mjs";
import { RUNS, runList } from "./runs.mjs";
import { NEXT, sendJson, uiTag } from "./http.mjs";
import { flushPend, snapshot } from "./queue.mjs";

// ── 事件总线 ──────────────────────────────────────────────────────────
// Claude Desktop 的做法：一次生成（run）属于网关，不属于哪个 HTTP 请求。
// 前端只是订阅者 —— 断线、切后台、热替换界面、甚至开两个窗口，都不影响生成本身；
// 连回来时按 Last-Event-ID 从环形缓冲续上，续不上就把当前这一轮从头重放。
//
// 旧版的暗病都出在"生成绑在 /api/chat 那条 SSE 上"：
//   - WebView 一 reload（uiTag 变了、切后台被回收）请求一断，req.on('close') 就把 claude 杀了；
//   - 回来看不到正在跑的那一轮，只能等它（已经被杀的）结束；
//   - 排队在前端内存里，一刷新就丢。
export const BOOT = Date.now().toString(36);
const BUS = { seq: 0, ring: [], clients: new Set() };
const RING_MAX = 4000;
// 进程内订阅者：可选集成（如工作岛）不用再开一条 HTTP SSE，也不占令牌。
const SUBSCRIBERS = new Set();

/** 订阅每个事件；返回取消订阅的函数。订阅者出错不影响主流程。 */
export function onPublish(fn) {
  SUBSCRIBERS.add(fn);
  return () => SUBSCRIBERS.delete(fn);
}

export function publish(ev) {
  const seq = ++BUS.seq;
  const line = `id: ${BOOT}.${seq}\ndata: ${JSON.stringify(ev)}\n\n`;
  BUS.ring.push({ seq, line });
  if (BUS.ring.length > RING_MAX) BUS.ring.splice(0, BUS.ring.length - RING_MAX);
  for (const fn of SUBSCRIBERS) { try { fn(ev); } catch {} }
  for (const c of BUS.clients) busWrite(c, line);
}
function busWrite(res, line) {
  try {
    // 订阅者读得太慢（WebView 在后台被冻住）：别让它把网关内存撑爆，断掉让它重连续传
    if (res.writableLength > 8 * 1024 * 1024) { BUS.clients.delete(res); res.destroy(); return; }
    res.write(line);
  } catch { BUS.clients.delete(res); }
}
if (LIVE) setInterval(() => { for (const c of BUS.clients) busWrite(c, ": hb\n\n"); }, 15000).unref();

// ── 路由：/api/events /api/state ──
export async function routeBus(req, res, u, p) {
  // ── 事件流：所有生成进度都从这里推，前端只订阅 ──
  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay?.(true);
    const lastId = String(req.headers["last-event-id"] || u.searchParams.get("since") || "");
    const m = lastId.match(/^([0-9a-z]+)\.(\d+)$/);
    const since = m && m[1] === BOOT ? Number(m[2]) : -1;
    const first = BUS.ring[0];
    const resume = since >= 0 && since <= BUS.seq && (since === BUS.seq || (first && first.seq <= since + 1));
    for (const r of RUNS.values()) flushPend(r);
    let out = "retry: 1500\n\n";
    out += `data: ${JSON.stringify({ type: "hello", boot: BOOT, resume, uiTag: uiTag(), ...snapshot() })}\n\n`;
    if (resume) {
      for (const r of BUS.ring) if (r.seq > since) out += r.line;
    } else {
      // 续不上（网关重启过 / 断得太久）：把正在跑的每一轮从头重放（前端按会话自己认领）
      for (const r of runList().sort((a, b) => a.startedAt - b.startedAt)) for (const ev of r.log) out += `data: ${JSON.stringify(ev)}\n\n`;
    }
    out += `id: ${BOOT}.${BUS.seq}\ndata: {"type":"sync"}\n\n`;
    res.write(out);
    BUS.clients.add(res);
    req.on("close", () => BUS.clients.delete(res));
    return;
  }
  if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, snapshot());
  return NEXT;
}
