// 通过真实 HTTP 接口（与前端完全相同的路径）验证演示全链路
const HUB = "http://127.0.0.1:17800", PHONE = "http://127.0.0.1:17802";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (url, b) => { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; };
const get = async (url) => (await fetch(url)).json();
const uid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, "0")).join("");
let checks = 0; const ok = (s) => { checks++; console.log("PASS", s); };

const st0 = await post(HUB + "/api/demo/setup");
if (!st0.setup.hostCreated || !st0.setup.shared || !st0.setup.paired) throw new Error("setup 失败");
ok("一键建立主机＋托管＋配对");

const rpc = async (op, extra = {}) => {
  const st = await get(PHONE + "/api/hosting/status");
  const remoteId = st.remotes[0].id;
  return (await post(PHONE + "/api/hosting/rpc", { remoteId, id: uid(), op, ...extra })).result;
};
const list = await rpc("list");
if (list.sessions.length !== 1 || list.sessions[0].id !== "demo-hosting-session") throw new Error("list 应只含托管会话");
ok("远端列表只有托管会话（私人会话不可见）");
const auth = { sessionId: list.sessions[0].id, boot: list.boot, grant: list.sessions[0].grant };
const page0 = await rpc("session", auth);
if (page0.items.length < 4) throw new Error("历史为空");
ok("历史读取 " + page0.items.length + " 条");

// 触发授权卡
await rpc("send", { ...auth, args: { message: "运行 ls 看看目录" } });
let page, waited = 0;
do { await sleep(500); waited += 500; page = await rpc("session", auth); } while (!page.perms?.length && waited < 15000);
if (!page.perms?.length) throw new Error("授权卡未出现");
const perm = page.perms[0];
if (perm.tool !== "Bash") throw new Error("授权卡工具不对: " + perm.tool);
ok("Bash 授权卡出现（" + waited + "ms）");

// watch 增量：回答后应收到增量帧
const w1 = await rpc("watch", { ...auth, args: {} });
await rpc("answer", { ...auth, args: { runId: page.run.id, id: perm.id, behavior: "allow" } });
let sawDelta = false, sawDone = false;
for (let i = 0; i < 30; i++) {
  const w = await rpc("watch", { ...auth, args: { revision: w1.revision } });
  if (w.delta) sawDelta = true;
  if (w.delta?.run === null || (w.reset && !w.snapshot.run)) { sawDone = true; break; }
  if (w.reset && w.snapshot) { /* 新快照 */ }
  await sleep(200);
}
if (!sawDelta) throw new Error("未收到增量帧");
ok("watch 增量同步正常");
await sleep(1500);
const page2 = await rpc("session", auth);
if (page2.items.length <= page0.items.length) throw new Error("历史未增长");
ok("本轮落盘，历史增长到 " + page2.items.length + " 条");

// 停止：发长文，运行中停止
await rpc("send", { ...auth, args: { message: "写一篇长文" } });
await sleep(2500);
const pageRun = await rpc("session", auth);
if (!pageRun.run) throw new Error("长文轮未运行");
const stopRes = await rpc("stop", { ...auth, args: { runId: pageRun.run.id } });
if (!stopRes.killed) throw new Error("停止未生效");
ok("停止本轮 killed=" + stopRes.killed);
await sleep(800);
const pageStopped = await rpc("session", auth);
if (!pageStopped.interrupted) throw new Error("中断标记未出现");
ok("中断卡出现，可发「继续」");
await rpc("send", { ...auth, args: { message: "继续" } });
await sleep(6000);

// 取消托管立即拒绝
await post(HUB + "/api/demo/share", { enabled: false });
let denied = false;
try { await rpc("session", auth); } catch (e) { denied = /托管/.test(e.message); }
if (!denied) throw new Error("取消托管后仍可读取");
ok("取消托管立即撤销访问");
await post(HUB + "/api/demo/share", { enabled: true });

// 中转视角：只有密文
const st = await get(HUB + "/api/demo/status");
if (!st.wire.length) throw new Error("wire 为空");
if (st.wire.some((w) => /运行|继续|ls/.test(w.head))) throw new Error("wire 泄露明文");
const room = Object.values(st.relayState.rooms)[0];
ok("中转视角 " + st.wire.length + " 条密文记录；落盘字段: " + Object.keys(room || {}).join(","));
console.log("ALL PASS", checks);