// 工作岛核心：状态映射、换轮不误报、中止、确认、节流、中英文
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkIsland } from "../gw/work-island-core.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(opts = {}) {
  const sent = [];
  let runs = [];
  const core = createWorkIsland({
    send: (action, title, text, since) => sent.push({ action, title, text, since }),
    runs: () => runs,
    lang: () => "zh",
    graceMs: 20,
    idleMs: 30,
    throttleMs: 0,
    ...opts,
  });
  return { core, sent, setRuns: (r) => { runs = r; } };
}

test("开始与工具：先「正在干活」，再跟着 tool_use 变", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  assert.equal(sent.at(-1).action, "UPDATE");
  assert.equal(sent.at(-1).title, "正在干活");
  assert.equal(sent.at(-1).text, "正在处理…");
  core.handleEvent({ type: "tool_use", name: "Read" });
  assert.equal(sent.at(-1).text, "用 读文件…");
});

test("完成：任务完成 + 用时，8 秒后收起", async () => {
  const { core, sent, setRuns } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([]);
  core.handleEvent({ type: "run_end" });
  await sleep(40);
  const done = sent.find((x) => x.action === "DONE");
  assert.ok(done, "应发 DONE");
  assert.equal(done.title, "任务完成");
  assert.match(done.text, /^用时 /);
  await sleep(50);
  assert.ok(sent.some((x) => x.action === "IDLE"), "应发 IDLE");
});

test("换轮：另一个轮次还在跑，不报完成", async () => {
  const { core, sent, setRuns } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([{ id: "r2", startedAt: Date.now() }]);
  core.handleEvent({ type: "run_end", runId: "r1" });
  await sleep(40);
  assert.ok(!sent.some((x) => x.action === "DONE"));
});

test("宽限期内来了新的一轮：取消完成", async () => {
  const { core, sent, setRuns } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([]);
  core.handleEvent({ type: "run_end" });
  await sleep(5);
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  await sleep(50);
  assert.ok(!sent.some((x) => x.action === "DONE"));
});

test("中止：完成文案带「已中止」", async () => {
  const { core, sent, setRuns } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([]);
  core.handleEvent({ type: "run_end", aborted: true });
  await sleep(40);
  assert.match(sent.find((x) => x.action === "DONE").text, /已中止/);
});

test("等确认：标题变「等你确认」，文案带工具名", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "perm_request", tool: "Bash" });
  assert.equal(sent.at(-1).title, "等你确认");
  assert.match(sent.at(-1).text, /执行命令/);
});

test("错误：只显示「出错了」，不转发 message", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "error", message: "/secret/path token=abc" });
  assert.equal(sent.at(-1).text, "出错了");
  assert.ok(!sent.at(-1).text.includes("secret"));
});

test("英文：Working / Using a command…", () => {
  const { core, sent } = make({ lang: () => "en" });
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  assert.equal(sent.at(-1).title, "Working");
  core.handleEvent({ type: "tool_use", name: "Bash" });
  assert.equal(sent.at(-1).text, "Using a command…");
});

test("节流：一秒半内只发一条，补发最后那条", async () => {
  const { core, sent } = make({ throttleMs: 50 });
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  sent.length = 0;                       // 忽略 start 那一条
  core.handleEvent({ type: "phase", phase: "think" });
  core.handleEvent({ type: "phase", phase: "text" });
  assert.equal(sent.length, 0, "节流窗口内不应发");
  await sleep(70);
  assert.equal(sent.length, 1, "应补发一条");
  assert.equal(sent[0].text, "正在写回复…", "补发的是最后那条");
});

test("关掉开关：有活动时发一次 IDLE", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  sent.length = 0;
  core.stop();
  assert.equal(sent.at(-1).action, "IDLE");
});

test("关掉开关：没有活动时不发", () => {
  const { core, sent } = make();
  core.stop();
  assert.equal(sent.length, 0);
});

test("关掉开关：「任务完成」还挂着（没到收起时间）也发 IDLE，收起后不再发", async () => {
  const { core, sent, setRuns } = make({ idleMs: 200 });
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([]);
  core.handleEvent({ type: "run_end" });
  await sleep(40);
  assert.equal(sent.at(-1).action, "DONE");
  core.stop();
  assert.equal(sent.at(-1).action, "IDLE", "DONE 还在岛上时关掉应收起");
  sent.length = 0;
  core.stop();
  assert.equal(sent.length, 0, "已经收起就不重复发");
});

test("子任务：不转发描述原文", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "sub_progress", desc: "读 /sdcard/私密/日记.md" });
  assert.equal(sent.at(-1).text, "子任务…");
  assert.ok(!sent.some((x) => String(x.text).includes("日记")));
});
