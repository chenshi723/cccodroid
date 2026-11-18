// 会话托管 · 真实演示服务
// 真：上游网关模块（queue/runs/bus/sessions/bookmarks/adapter）、HostingEngine、Python 中转、前端全部生产资源。
// 假：模型执行（脚本驱动）、公网（回环中转）、会话数据（演示剧本）。
// 一次性副本 + 隔离 HOME，绝不触碰已安装应用、真实配对或线上中转。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 可移植：上游/其它机器用环境变量指向自己的应用根与 relay；默认回落到本机安装树
const APP = process.env.HOSTING_DEMO_APP || "/data/user/0/cc.fork.v4/files/app";
const RELAY = process.env.HOSTING_DEMO_RELAY ||
  (fs.existsSync(path.join(here, "../session-hosting/relay/server.py")) ? path.join(here, "../session-hosting/relay") : path.join(here, "relay"));
const PYTHON = process.env.HOSTING_DEMO_PYTHON ||
  (fs.existsSync(path.join(RELAY, ".venv/bin/python")) ? path.join(RELAY, ".venv/bin/python") : "python3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 隔离环境（必须在导入任何 gw 模块之前）────────────────────────────
// 固定目录、每次启动清空：截图里的路径有语义，且不与真实应用数据混放
const home = path.join(here, "demo-home");
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
for (const k of Object.keys(process.env)) if (k.startsWith("CCAPP_")) delete process.env[k];
Object.assign(process.env, { HOME: home, CCAPP_TEST: "1", CCAPP_HOME: home,
  CCAPP_PREFIX: path.join(home, "prefix"), CCAPP_WORKSPACE: path.join(here, "demo-workspace"),
  CCAPP_SEED: path.join(home, "no-seed.json") });
fs.rmSync(process.env.CCAPP_WORKSPACE, { recursive: true, force: true });
fs.mkdirSync(process.env.CCAPP_WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(home, "ccapp-billing.json"),
  JSON.stringify({ deepseek: { tok: [[Math.floor(Date.now() / 3600e3) * 3600e3, 100, 200, 300]] } }));

// ── 一次性 gw 副本：只把 startRun 换成脚本模型 ───────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-demo-gw-"));
for (const name of ["gw", "lib", "bin"])
  if (fs.existsSync(path.join(APP, name))) fs.cpSync(path.join(APP, name), path.join(root, name), { recursive: true });
const runFile = path.join(root, "gw/run.mjs");
const runSrc = fs.readFileSync(runFile, "utf8");
const anchor = "export async function startRun(item) {";
if (runSrc.split(anchor).length !== 2) throw new Error("startRun 锚点不唯一，拒绝打补丁");
fs.writeFileSync(runFile, runSrc.replace(anchor, "async function startRunReal(item) {") +
  '\nimport { demoStartRun } from "./demo-driver.mjs";\nexport async function startRun(item) { return demoStartRun(item); }\n');
fs.copyFileSync(path.join(here, "src/demo-driver.mjs"), path.join(root, "gw/demo-driver.mjs"));
const gw = (name) => import(pathToFileURL(path.join(root, "gw", name)).href);

const { NEXT } = await gw("http.mjs");
const { CFG, PATHS } = await gw("config.mjs");
const { PROVIDER } = await gw("providers.mjs");
const { SETTINGS } = await gw("settings-store.mjs");
const { setSessModel } = await gw("sessmodel.mjs");
const { RUNS, runList } = await gw("runs.mjs");
const { QUEUE, routeQueue, publishState, snapshot } = await gw("queue.mjs");
const { routeRun, execIntent } = await gw("run.mjs");
const { routeBus } = await gw("bus.mjs");
const { routeSessions, listSessions } = await gw("sessions.mjs");
const { routeModels } = await gw("models.mjs");
const { routeProviders } = await gw("providers.mjs");
const { routeBookmarks } = await gw("bookmarks.mjs");
const { adapter } = await gw("hosting/adapter.mjs");
const { HostingEngine } = await gw("hosting/engine.mjs");
const { token, uid, ROOT } = await gw("hosting/core.mjs");
const { seedDemoSessions } = await gw("demo-driver.mjs");

Object.assign(PROVIDER, { id: "deepseek", label: "演示接口（模拟执行）", labelEn: "Demo provider (simulated)",
  defaultModel: "claude-opus-5-5", nativeModels: true, modelsUrl: "", login: true,
  fallbackModels: [{ id: "claude-opus-5-5", context_window: 1000000 }] });
SETTINGS.model = "claude-opus-5-5"; SETTINGS.autoCompactWindow = 396000; SETTINGS.permissionMode = "default";

const SID = "demo-hosting-session", PRIVATE_SID = "private-notes-session";
seedDemoSessions(SID, PRIVATE_SID);
setSessModel(SID, { model: "claude-opus-5-5", effort: "high" });

// ── 中转视角：在 fetch 层记录经过的密文（这一层本来就没有明文）────────
const wire = []; let wireN = 0;
const realFetch = globalThis.fetch;
let relayOrigin = "";
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const res = await realFetch(input, init);
  if (relayOrigin && url.startsWith(relayOrigin + ROOT)) {
    try {
      const p = new URL(url).pathname.slice(ROOT.length);
      const push = (kind, id, packet) => {
        if (typeof packet !== "string") return;
        wire.push({ n: ++wireN, at: Date.now(), kind, id: String(id || "").slice(0, 8), bytes: packet.length, head: packet.slice(0, 36) });
        if (wire.length > 400) wire.splice(0, wire.length - 400);
      };
      if (p.endsWith("/rpc") && init?.body) { const b = JSON.parse(init.body); push("控制端 → 中转", b.id, b.packet); }
      else if (p.endsWith("/reply") && init?.body) { const b = JSON.parse(init.body); push("主机 → 中转", b.id, b.packet); }
      else if (p.endsWith("/poll")) { const b = await res.clone().json(); for (const r of b.requests || []) push("中转 → 主机", r.id, r.packet); }
      else if (p === "/rooms" && init?.method === "POST") wire.push({ n: ++wireN, at: Date.now(), kind: "建房（令牌哈希落盘）", id: "", bytes: 0, head: "" });
    } catch {}
  }
  return res;
};

// ── 本地隔离中转（真实 relay/server.py）──────────────────────────────
async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; await new Promise((r) => s.close(r)); return p;
}
const relayPort = await freePort();
relayOrigin = `http://127.0.0.1:${relayPort}`;
const enroll = token();
const relay = spawn(PYTHON, [path.join(RELAY, "server.py")],
  { env: { ...process.env, CC_HOST_BIND: "127.0.0.1", CC_HOST_PORT: String(relayPort),
    CC_HOST_STATE: path.join(home, "relay.json"), CC_HOST_ENROLL_TOKEN: enroll }, stdio: ["ignore", "pipe", "pipe"] });
let relayErr = ""; relay.stderr.on("data", (c) => { relayErr += c; });
for (let i = 0; ; i++) {
  try { if ((await realFetch(relayOrigin + ROOT + "/health")).ok) break; } catch {}
  if (i > 100 || relay.exitCode != null) throw new Error("中转未启动: " + relayErr);
  await sleep(40);
}

// ── 两台设备的托管引擎（生产代码）────────────────────────────────────
const host = new HostingEngine({ home: path.join(home, "host"), adapter, test: true });
const client = new HostingEngine({ home: path.join(home, "client"), adapter: {}, test: true });

// ── 前端资源：全部来自已安装应用的生产文件 ───────────────────────────
const WEB = path.join(APP, "web");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".mp3": "audio/mpeg", ".wasm": "application/wasm" };
let appJsCache = null;
function appJs() {
  if (!appJsCache) appJsCache = Buffer.concat(fs.readdirSync(path.join(WEB, "app")).filter((f) => f.endsWith(".js")).sort()
    .map((f) => fs.readFileSync(path.join(WEB, "app", f))));
  return appJsCache;
}
const SHIM = `<script>try{localStorage.setItem("ccapp.lang","zh");if(!localStorage.getItem("ccapp.theme"))localStorage.setItem("ccapp.theme","gc-light");localStorage.setItem("ccapp.uifont","system");localStorage.setItem("ccapp.readfont","sans");if(!localStorage.getItem("cc.ui"))localStorage.setItem("cc.ui",JSON.stringify({gcPaper:0,accent:"#2b6fd6"}));}catch(e){}</script>`;
function serveAsset(res, p, hubPort) {
  const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
  if (rel.includes("..")) { res.writeHead(403); return res.end(); }
  let data, type;
  if (rel === "app.js") { data = appJs(); type = MIME[".js"]; }
  else {
    const full = path.join(WEB, rel);
    if (!full.startsWith(WEB + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    data = fs.readFileSync(full); type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
    if (rel === "index.html") data = Buffer.from(data.toString("utf8").replace("</head>", SHIM + "</head>"));
  }
  res.writeHead(200, { "content-type": type, "content-length": data.length, "cache-control": "no-store",
    "content-security-policy": `frame-ancestors http://127.0.0.1:${hubPort}; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:` });
  res.end(data);
}
const json = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length, "cache-control": "no-store" }); res.end(b); };
const readJson = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; } };

// 控制端的本地事件流：空快照 + 心跳（远程会话不走 SSE，走真实 watch 长轮询）
function phoneEvents(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const empty = { run: null, runs: [], maxParallel: 1, tamper: [], queue: [], provider: "", model: null, lastSessionId: null, interrupted: [], recoverWarns: [] };
  res.write(`retry: 1500\n\ndata: ${JSON.stringify({ type: "hello", boot: "phone-demo", resume: false, uiTag: "demo", ...empty })}\n\n`);
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 15000);
  req.on("close", () => clearInterval(hb));
}

function deviceServer(engine, role, hubPort) {
  return http.createServer(async (req, res) => {
    let u; try { u = new URL(req.url, "http://127.0.0.1"); } catch { return json(res, 400, { error: "bad request" }); }
    const p = u.pathname;
    try {
      if (p.startsWith("/api/hosting/")) {
        const action = p.slice("/api/hosting/".length);
        if (req.method === "GET") {
          if (action === "status") return json(res, 200, engine.status());
          if (action === "local-sessions") return json(res, 200, { sessions: role === "host" ? adapter.localList() : [] });
        }
        if (req.method === "POST") {
          const b = await readJson(req);
          let out;
          switch (action) {
            case "host": out = await engine.createHost(b); break;
            case "host-toggle": out = engine.toggle(b); break;
            case "host-remove": out = await engine.removeHost(); break;
            case "pair-code": out = engine.pairCode(); break;
            case "share": out = engine.share(b); break;
            case "pair": out = engine.pair(b); break;
            case "forget": out = engine.forget(b); break;
            case "rpc": {
              const c = new AbortController();
              const cancel = () => { if (!res.writableEnded) c.abort(); };
              res.once("close", cancel); req.once("aborted", cancel);
              try { out = { result: await engine.rpc(b, c.signal) }; } finally { res.off("close", cancel); req.off("aborted", cancel); }
              break;
            }
            default: return json(res, 404, { error: "没有这个托管接口" });
          }
          if (!res.destroyed) return json(res, 200, out);
        }
        return json(res, 404, { error: "没有这个托管接口" });
      }
      if (role === "host") {
        // 主机侧：真实事件总线 / 排队 / 授权 / 会话 / 书签路由
        for (const r of [routeBus, routeQueue, routeRun, routeSessions, routeBookmarks, routeModels, routeProviders])
          if ((await r(req, res, u, p)) !== NEXT) return;
        if (p === "/api/status") return json(res, 200, { ...snapshot(), connected: true, version: "0.7.7-demo",
          cli: { installed: true }, cwd: CFG.workspace, busy: RUNS.size > 0 || QUEUE.some((q) => !q.held), running: RUNS.size, queued: QUEUE.length, sessions: [] });
        if (p === "/api/settings") return json(res, 200, { settings: { ...SETTINGS } });
      } else {
        if (p === "/api/events") return phoneEvents(req, res);
        if (p === "/api/state" || p === "/api/status") return json(res, 200, { busy: false, running: 0, queued: 0, sessions: [], runs: [], queue: [],
          connected: true, version: "0.7.7-demo", cli: { installed: true }, cwd: "/workspace", interrupted: [], recoverWarns: [], tamper: [], maxParallel: 1, provider: "", model: null, lastSessionId: null });
        if (p === "/api/sessions") return json(res, 200, { sessions: [], total: 0 });
        if (p === "/api/settings") return json(res, 200, { settings: { model: "" } });
        if (p === "/api/providers") return json(res, 200, { providers: [], current: null });
      }
      if (p.startsWith("/api/")) {
        if (p === "/api/fonts") return json(res, 200, { items: [], max: 0, count: 0 });
        if (p === "/api/notices") return json(res, 200, { notices: [] });
        if (p === "/api/billing") return json(res, 200, {});
        return json(res, 200, {});
      }
      if (req.method === "GET" || req.method === "HEAD") return serveAsset(res, p, hubPort);
      return json(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: String(e.message || e).slice(0, 300) });
      else res.end();
    }
  });
}

// ── 中控页 API ───────────────────────────────────────────────────────
async function clientSend(message, inject = false) {
  const remoteId = client.status().remotes[0]?.id;
  if (!remoteId) throw new Error("控制端尚未配对");
  const list = await client.rpc({ remoteId, id: uid(), op: "list" });
  const s = list.sessions.find((x) => x.id === SID);
  if (!s) throw new Error("演示会话未托管");
  return client.rpc({ remoteId, id: uid(), op: "send", sessionId: SID, boot: list.boot, grant: s.grant, args: { message, inject } });
}
function relayState() {
  try { return JSON.parse(fs.readFileSync(path.join(home, "relay.json"), "utf8")); } catch { return { v: 1, rooms: {} }; }
}
async function demoStatus() {
  let health = false;
  try { health = (await realFetch(relayOrigin + ROOT + "/health", { signal: AbortSignal.timeout(1500) })).ok; } catch {}
  return { ok: true, ports: PORTS, relay: { url: relayOrigin, enrollToken: enroll, health },
    host: host.status(), client: client.status(), demo: { sid: SID, privateSid: PRIVATE_SID },
    setup: { hostCreated: !!host.store.value.host, shared: !!host.store.value.host?.shares?.[SID], paired: client.status().remotes.length > 0 },
    wire: wire.slice(-120), relayState: relayState() };
}
const hubServer = http.createServer(async (req, res) => {
  let u; try { u = new URL(req.url, "http://127.0.0.1"); } catch { return json(res, 400, { error: "bad" }); }
  const p = u.pathname;
  try {
    if (p === "/api/demo/status") return json(res, 200, await demoStatus());
    if (p === "/api/demo/shutdown" && req.method === "POST") { json(res, 200, { ok: true }); return setTimeout(shutdown, 50); }
    if (p === "/api/demo/wire") return json(res, 200, { wire: wire.slice(-(Number(u.searchParams.get("n")) || 120)) });
    if (req.method === "POST") {
      const b = await readJson(req);
      if (p === "/api/demo/setup") {
        if (!host.store.value.host) await host.createHost({ url: relayOrigin, enrollToken: enroll, name: "演示平板" });
        if (!host.store.value.host.shares[SID]) host.share({ sessionId: SID, enabled: true });
        if (!client.status().remotes.length) client.pair({ code: host.pairCode().code, name: "演示平板" });
        return json(res, 200, await demoStatus());
      }
      if (p === "/api/demo/pair-code") return json(res, 200, host.pairCode());
      if (p === "/api/demo/transfer") { client.pair({ code: host.pairCode().code, name: "演示平板" }); return json(res, 200, await demoStatus()); }
      if (p === "/api/demo/send") return json(res, 200, { result: await clientSend(String(b.message || ""), !!b.inject) });
      if (p === "/api/demo/share") { host.share({ sessionId: SID, enabled: !!b.enabled }); return json(res, 200, await demoStatus()); }
      if (p === "/api/demo/host-toggle") { host.toggle({ enabled: !!b.enabled }); return json(res, 200, await demoStatus()); }
      if (p === "/api/demo/stop") {
        const remoteId = client.status().remotes[0]?.id;
        const list = await client.rpc({ remoteId, id: uid(), op: "list" });
        const s = list.sessions.find((x) => x.id === SID);
        const page = await client.rpc({ remoteId, id: uid(), op: "session", sessionId: SID, boot: list.boot, grant: s.grant });
        if (!page.run) throw new Error("当前没有正在运行的轮次");
        return json(res, 200, { result: await client.rpc({ remoteId, id: uid(), op: "stop", sessionId: SID, boot: list.boot, grant: s.grant, args: { runId: page.run.id } }) });
      }
    }
    if (p.startsWith("/api/")) return json(res, 404, { error: "not found" });
    const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    if (rel.includes("..")) { res.writeHead(403); return res.end(); }
    const full = path.join(here, "hub", rel);
    if (!full.startsWith(path.join(here, "hub") + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    const data = fs.readFileSync(full);
    res.writeHead(200, { "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream", "content-length": data.length, "cache-control": "no-store" });
    return res.end(data);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: String(e.message || e).slice(0, 300) }); else res.end();
  }
});

// ── 端口与启动 ───────────────────────────────────────────────────────
async function portFree(p) { const s = net.createServer(); try { s.listen(p, "127.0.0.1"); await once(s, "listening"); await new Promise((r) => s.close(r)); return true; } catch { return false; } }
let base = 17800;
while (!(await portFree(base) && await portFree(base + 1) && await portFree(base + 2))) base += 3;
const PORTS = { hub: base, tablet: base + 1, phone: base + 2 };
const tabletSrv = deviceServer(host, "host", PORTS.hub);
const phoneSrv = deviceServer(client, "client", PORTS.hub);
await new Promise((r) => hubServer.listen(PORTS.hub, "127.0.0.1", r));
await new Promise((r) => tabletSrv.listen(PORTS.tablet, "127.0.0.1", r));
await new Promise((r) => phoneSrv.listen(PORTS.phone, "127.0.0.1", r));
console.log("DEMO READY " + JSON.stringify({ ...PORTS, relay: relayPort, home }));

let shutting = false;
async function shutdown() {
  if (shutting) return; shutting = true;
  try { host.stop(); client.stop(); } catch {}
  for (const s of [hubServer, tabletSrv, phoneSrv]) try { s.close(); } catch {}
  relay.kill("SIGTERM");
  await Promise.race([once(relay, "exit"), sleep(2000)]);
  if (relay.exitCode == null) relay.kill("SIGKILL");
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);