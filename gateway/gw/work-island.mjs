// ── 工作岛（可选集成）──────────────────────────────────────────────────────
// 在网关进程里直接订阅事件总线，把 Claude 的工作状态经 am 送给「工作岛」应用。
//
// 约束：
//  · 不另起进程：没有 detached child、没有 PID 文件、没有看门狗。
//    网关停，订阅和定时器一起没，不会留孤儿。
//  · 默认关闭：SETTINGS.workIsland 为 true 才检测应用、开始送状态。
//  · 只用 Node 内置模块；应用没装就完全不启动。
//  · 文案跟随 LAST_LANG；中文/英文两套。
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { SETTINGS } from "./settings.mjs";
import { runList } from "./runs.mjs";
import { onPublish } from "./bus.mjs";
import { LAST_LANG, log } from "./config.mjs";
import { createWorkIsland } from "./work-island-core.mjs";

const PKG = process.env.WORK_ISLAND_PKG || "com.dafeiyu.workisland";
const SVC = PKG + "/.IslandService";

function amArgs(action, title, text, since) {
  const a = ["start-foreground-service", "--user", "0", "-n", SVC, "-a", PKG + "." + action];
  if (title) a.push("--es", "title", title);
  if (text) a.push("--es", "text", text);
  if (since) a.push("--el", "since", String(since));
  return a;
}

let warned = false;
function amSend(action, title, text, since) {
  execFile("am", amArgs(action, title, text, since), { timeout: 8000 }, (e, out, err) => {
    if (!e || warned) return;
    warned = true;
    log(`[work-island] am 失败（应用没装或服务未就绪？后面不再重复）：${e.message} ${String(err || "").slice(0, 120)}`);
  });
}
function amSendSync(action, title, text, since) {
  try {
    execFileSync("am", amArgs(action, title, text, since), { timeout: 3000, stdio: "ignore" });
  } catch {}
}

let started = false;
let detecting = false;
let unsub = null;
let core = null;

function isAndroid() {
  return fs.existsSync("/system/bin/am");
}

function detectApp(cb) {
  if (process.env.CCAPP_WORK_ISLAND === "1") return cb(true);
  if (process.env.CCAPP_WORK_ISLAND === "0") return cb(false);
  // pm 默认按“当前用户”查；应用 uid 会撞 INTERACT_ACROSS_USERS（asks to run as user 10），
  // 必须显式 --user 0。包可见性由 AndroidManifest 的 <queries> 解决。
  execFile("pm", ["list", "packages", "--user", "0", PKG], { timeout: 3000 }, (e, out) => {
    cb(!e && String(out).includes("package:" + PKG));
  });
}

export function startWorkIsland() {
  if (started || detecting) return;
  if (!SETTINGS.workIsland) return;              // 默认关，用户开了才动
  if (process.env.CCAPP_WORK_ISLAND === "0") return;
  if (!isAndroid()) return;
  started = true;
  detecting = true;
  detectApp((ok) => {
    detecting = false;
    if (!started) return;                        // 检测期间被关掉了
    if (!ok) {
      started = false;
      log("[work-island] 没检测到工作岛应用，跳过（装好后可在设置里重开一次）");
      return;
    }
    core = createWorkIsland({
      send: amSend,
      sendSync: amSendSync,
      runs: runList,
      lang: () => LAST_LANG,
    });
    unsub = onPublish((ev) => {
      try { core.handleEvent(ev); } catch {}
    });
    const live = runList().filter((r) => r && !r.ended);
    if (live.length) core.start(live[0]);        // 开设置时已经有轮次在跑
    log("[work-island] 已订阅网关事件");
  });
}

export function stopWorkIsland(sync = false) {
  started = false;
  detecting = false;
  if (unsub) { try { unsub(); } catch {} unsub = null; }
  if (core) {
    try { core.stop(sync); } catch {}
    core = null;
  }
}

/** 网关 SIGTERM：同步发一次 IDLE，让岛收起，再退出。 */
export function stopWorkIslandSync() {
  stopWorkIsland(true);
}

/** 设置页开关变化时调用。 */
export function applyWorkIslandSetting() {
  if (SETTINGS.workIsland) startWorkIsland();
  else stopWorkIsland();
}
