// 流式补尾：给自定义接口（多半是中转站）垫一层本地转发，专治「回答明明说完了，流的结尾却没收好」。
//
// 群友截图（cn:deepseek-v4.1-flash，10-25）：每到最后总结那条，正文出完，中转站没发 message_delta（stop_reason）
// 就断了线 / 塞了个坏事件。claude 把这当「中途掐断」，半截不进记录，补一句 cut off mid-stream 再请求一遍 ——
// 界面上就是「整段撤回、重新输出」，厂商那边记两次调用，最多还会连着来几轮。
//
// 做法：只看 POST /v1/messages 的 SSE。所有内容块都已闭合、且出过正文或工具调用时，上游断线 / 报错 / 结束都算「说完了」，
// 替它补上 message_delta（有工具调用 = tool_use，否则 end_turn）+ message_stop。块还开着就照样断开，交给 claude 自己恢复。
// 非 JSON 的 data（OpenAI 式的 [DONE]）直接丢掉。其它请求原样转发。
//
// 只用于自定义接口：预置厂商没出过这事；官方账户的登录令牌按条款不能经过我们（见 claude.mjs）。
import http from "node:http";
import https from "node:https";
import { log } from "./config.mjs";

export const STREAMFIX = { port: 0 };

/** claude 的 ANTHROPIC_BASE_URL：上游地址编进路径，claude 往后补 /v1/messages */
export function fixedBaseUrl(baseUrl) {
  if (!STREAMFIX.port || !/^https?:\/\//.test(baseUrl || "")) return baseUrl;
  return `http://127.0.0.1:${STREAMFIX.port}/u/${Buffer.from(baseUrl).toString("base64url")}`;
}

/** SSE 修补状态机：feed 进上游原文，吐出要发给 claude 的文本；finish 在上游结束时调用，返回补的尾巴或 null（= 该断就断） */
export function sseRepairer() {
  let buf = "", started = false, gotStop = false, gotMsgStop = false, outTokens = 0;
  const open = new Set(), kinds = new Map();
  let hasOutput = false, hasTool = false;
  const done = () => started && !gotMsgStop && open.size === 0 && hasOutput;
  const stopReason = () => (hasTool ? "tool_use" : "end_turn");
  const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
  const tail = () => {
    let s = "";
    if (!gotStop) s += ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason(), stop_sequence: null }, usage: { output_tokens: outTokens } });
    gotStop = true; gotMsgStop = true;
    return s + ev("message_stop", { type: "message_stop" });
  };
  function block(raw) {
    let event = "", data = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return raw + "\n\n";            // 注释 / 心跳
    let j;
    try { j = JSON.parse(data.join("\n")); } catch { return ""; }   // [DONE] 之类
    const t = j?.type || event;
    if (t === "error") {
      // 说完之后才来的报错：不让它把整条回答作废
      if (done()) { log(`streamfix: 吞掉结尾的 error 事件 ${JSON.stringify(j).slice(0, 200)}`); return tail(); }
      return raw + "\n\n";
    }
    if (gotMsgStop) return "";                        // message_stop 之后的东西一律不要
    if (t === "message_start") { started = true; outTokens = j.message?.usage?.output_tokens || 0; }
    else if (t === "content_block_start") {
      open.add(j.index); kinds.set(j.index, j.content_block?.type);
    } else if (t === "content_block_stop") {
      open.delete(j.index);
      const k = kinds.get(j.index);
      if (k === "tool_use" || k === "server_tool_use") { hasTool = true; hasOutput = true; }
      else if (k === "text") hasOutput = true;
    } else if (t === "message_delta") {
      if (j.usage?.output_tokens) outTokens = j.usage.output_tokens;
      if (j.delta?.stop_reason) gotStop = true;
      else if (done()) {                              // stop_reason 给了 null：按已有内容补上
        j.delta = { ...(j.delta || {}), stop_reason: stopReason() }; gotStop = true;
        return ev("message_delta", j);
      }
    } else if (t === "message_stop") gotMsgStop = true;
    return raw + "\n\n";
  }
  return {
    feed(chunk) {
      buf += chunk.replace(/\r\n?/g, "\n");
      let out = "", i;
      while ((i = buf.indexOf("\n\n")) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); if (raw.trim()) out += block(raw); }
      return out;
    },
    finish() {
      let out = buf.trim() ? block(buf) : ""; buf = "";
      if (gotMsgStop) return out;
      if (done()) { log("streamfix: 上游没收尾，补 message_delta/message_stop"); return out + tail(); }
      return null;
    },
    get complete() { return gotMsgStop; },
  };
}

function handle(req, res) {
  const m = /^\/u\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(req.url || "");
  let base;
  try { base = m && new URL(Buffer.from(m[1], "base64url").toString()); } catch {}
  if (!base || !/^https?:$/.test(base.protocol)) { res.writeHead(404); res.end(); return; }
  const target = new URL(base.href.replace(/\/+$/, "") + (m[2] || "/"));
  const isMsg = req.method === "POST" && /\/v1\/messages(\?|$)/.test(target.pathname + target.search);
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  if (isMsg) headers["accept-encoding"] = "identity";   // 要读 SSE，别让上游压缩
  const mod = target.protocol === "https:" ? https : http;
  const up = mod.request(target, { method: req.method, headers }, (ur) => {
    const sse = isMsg && /text\/event-stream/i.test(String(ur.headers["content-type"] || ""));
    if (!sse) { res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res); return; }
    const h = { ...ur.headers };
    delete h["content-length"]; delete h["content-encoding"]; delete h["transfer-encoding"];
    res.writeHead(ur.statusCode || 200, h);
    const fix = sseRepairer();
    let ended = false;
    const end = () => {
      if (ended) return; ended = true;
      const t = fix.finish();
      if (t === null) { res.destroy(); return; }      // 块还开着：真断了，原样交给 claude
      res.end(t);
    };
    ur.setEncoding("utf8");
    ur.on("data", (d) => { const o = fix.feed(d); if (o) res.write(o); });
    ur.on("end", end);
    ur.on("error", end);
    ur.on("aborted", end);
    ur.on("close", end);
  });
  up.on("error", (e) => {
    if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `upstream: ${e.message}` } })); }
    else res.destroy();
  });
  res.on("close", () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

export function startStreamFix() {
  if (STREAMFIX.server) return;
  const srv = http.createServer(handle);
  srv.on("error", (e) => log(`streamfix: ${e.message}`));
  srv.listen(0, "127.0.0.1", () => { STREAMFIX.server = srv; STREAMFIX.port = srv.address().port; });
}
