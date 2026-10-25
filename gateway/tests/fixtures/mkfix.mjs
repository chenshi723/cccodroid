// 把真机抓的 stream-json 精简成测试样本（node mkfix.mjs 原始.jsonl 样本.jsonl）：
//   去 thinking_tokens；同一块里连续的逐字增量合并成一条（本机路径常被拆在几条增量里，合并后才换得掉）；
//   流式事件只留 type/event/parent_tool_use_id；init 只留几个字段；本机路径换成 /home/test
import fs from "node:fs";
const [src, dst] = process.argv.slice(2);
const HOME_RE = /\/data\/user\/0\/[\w.]+\/files\/home/g;
const clean = (s) => s.replace(HOME_RE, "/home/test").replace(/li\.dsh\.claudecli/g, "test.app");
const out = [];
for (const l of fs.readFileSync(src, "utf8").trim().split("\n")) {
  let e = JSON.parse(l);
  if (e.type === "system" && e.subtype === "thinking_tokens") continue;
  if (e.type === "system" && e.subtype === "init") e = { type: "system", subtype: "init", session_id: e.session_id, model: e.model, cwd: e.cwd, claude_code_version: e.claude_code_version, permissionMode: e.permissionMode };
  if (e.type === "stream_event") {
    e = { type: e.type, event: e.event, parent_tool_use_id: e.parent_tool_use_id ?? null };
    const d = e.event.type === "content_block_delta" && e.event.delta, prev = out[out.length - 1];
    const pd = prev && prev.type === "stream_event" && prev.event.type === "content_block_delta" && prev.event.delta;
    if (d && pd && d.type === pd.type && prev.parent_tool_use_id === e.parent_tool_use_id && prev.event.index === e.event.index) {
      const k = { text_delta: "text", thinking_delta: "thinking", input_json_delta: "partial_json" }[d.type];
      if (k) { pd[k] += d[k]; continue; }
    }
  }
  out.push(e);
}
fs.writeFileSync(dst, out.map((e) => clean(JSON.stringify(e))).join("\n") + "\n");
console.log(dst, out.length, fs.statSync(dst).size);
