// 用真实生产前端走完整托管流程并截图（说明书配图）。
// 浏览器：本机 chromium-headless；页面：演示服务提供的生产资源；数据：演示剧本。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(here, "../session-hosting/remote-list/.pw-browsers");
const require = createRequire(path.join(here, "../session-hosting/remote-list/.tools/package.json"));
const { chromium } = require("playwright-core");
const shots = path.join(here, "shots"); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB = "http://127.0.0.1:17800";
const status = await (await fetch(HUB + "/api/demo/status")).json();
const T = "http://127.0.0.1:" + status.ports.tablet + "/", P = "http://127.0.0.1:" + status.ports.phone + "/";
const errors = { tablet: [], phone: [] };
const browser = await chromium.launch({ executablePath: process.env.PREFIX + "/bin/chromium-browser", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--disable-background-networking"] });
async function device(name, viewport, isMobile) {
  const ctx = await browser.newContext({ viewport, isMobile, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  // 远程批准计划 / 停止会话有原生二次确认（真实用户会看到并点确认）；无头浏览器默认 dismiss，这里代为接受
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors[name].push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors[name].push("console: " + m.text().slice(0, 200)); });
  return { ctx, page };
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(shots, name + ".png") }); console.log("SHOT", name); };
const waitFresh = (page) => page.waitForFunction(() => window.__cc?.chatSource?.current?.fresh, null, { timeout: 20000 });
const waitIdle = (page) => page.waitForFunction(() => !document.querySelector("#btn-send")?.classList.contains("busy"), null, { timeout: 30000 });
const send = async (page, text) => { await page.locator("#input").fill(text); await page.locator("#btn-send").click(); };
const openHosting = async (page) => {
  await page.evaluate(() => window.__cc?.closeDrawer?.());
  await sleep(250);
  await page.locator("#btn-more").click({ timeout: 5000 }).catch(() =>
    page.evaluate(() => document.documentElement.classList.add("tb-open")));
  await sleep(350);
  await page.locator("#btn-hosting").click({ timeout: 8000 });
  await page.waitForSelector("#cch-panel:not(.hidden)", { timeout: 8000 });
};
try {
  // ── 平板：主机 ──
  const tab = await device("tablet", { width: 1280, height: 800 }, false);
  const t = tab.page;
  await t.goto(T); await t.waitForFunction(() => !!window.__cc?.openDrawer && !!window.CCHosting, null, { timeout: 20000 });
  await t.waitForSelector("#hist .msg, #live .msg", { timeout: 15000 }).catch(() => {});
  await sleep(800);
  await shot(t, "t01-tablet-chat");
  await openHosting(t);
  await t.waitForSelector("#cch-panel input[type='url']", { timeout: 8000 });
  await shot(t, "t02-host-form");
  await t.locator("#cch-panel input[type='url']").fill(status.relay.url);
  await t.locator("#cch-panel input[type='password']").fill(status.relay.enrollToken);
  await t.locator("#cch-panel input[type='text']").first().fill("演示平板");
  await t.locator("#cch-panel button", { hasText: "建立主机" }).click();
  await t.waitForFunction(() => document.querySelector("#cch-panel")?.textContent.includes("托管哪些会话"), null, { timeout: 15000 });
  // 托管当前会话（平板默认打开演示会话）；不行就用选择器
  const cur = t.locator("#cch-panel button", { hasText: "托管当前会话" });
  if (await cur.count() && await cur.isEnabled()) await cur.click();
  else {
    await t.locator("#cch-panel button", { hasText: "选择其他本地会话" }).click();
    await t.waitForSelector("#cch-panel select", { timeout: 8000 });
    await t.locator("#cch-panel select").selectOption({ index: 0 });
    await t.locator("#cch-panel button", { hasText: "开启托管" }).click();
  }
  await t.waitForFunction(() => document.querySelector("#cch-panel")?.textContent.includes("取消托管"), null, { timeout: 10000 });
  // 主机首个长轮询返回后状态才变绿（最长约20秒），等真实状态再截
  await t.waitForFunction(() => document.querySelector("#cch-panel")?.textContent.includes("中转连接正常"), null, { timeout: 30000 });
  await t.locator("#cch-panel button", { hasText: "显示配对码" }).click();
  await t.waitForSelector("#cch-panel textarea", { timeout: 8000 });
  await sleep(400);
  await shot(t, "t03-host-shared");
  const code = await t.locator("#cch-panel textarea").inputValue();
  if (!code.startsWith("CCH1.")) throw new Error("配对码格式不对");

  // ── 手机：控制端 ──
  const ph = await device("phone", { width: 412, height: 960 }, true);
  const p = ph.page;
  await p.goto(P); await p.waitForFunction(() => !!window.__cc?.openDrawer && !!window.CCHosting, null, { timeout: 20000 });
  await sleep(600);
  await openHosting(p);
  await p.locator("#cch-panel button", { hasText: "连接其他设备" }).click();
  await p.waitForSelector("#cch-panel textarea", { timeout: 8000 });
  await shot(p, "p01-pair-form");
  await p.locator("#cch-panel input[type='text']").first().fill("演示平板");
  await p.locator("#cch-panel textarea").fill(code);
  await p.locator("#cch-panel button", { hasText: "保存配对" }).click();
  await p.waitForFunction(() => document.querySelector("#cch-panel")?.textContent.includes("已配对设备"), null, { timeout: 8000 });
  await p.locator("#cch-panel button", { hasText: /^连接$/ }).click();
  await p.waitForFunction(() => document.querySelector("#cch-connection")?.textContent.includes("主机在线"), null, { timeout: 20000 });
  await sleep(400);
  await shot(p, "p02-remote-list");
  await p.locator("#cch-panel .cch-session").first().click();
  await waitFresh(p);
  await sleep(600);
  await shot(p, "p03-remote-chat");

  // 发送 → 授权卡
  await send(p, "运行 ls 看看目录");
  await p.waitForFunction(() => document.querySelector("#live .run-phase")?.textContent.includes("发送到主机"), null, { timeout: 8000 }).catch(() => {});
  await shot(p, "p04-sending");
  await p.waitForSelector(".pa-allow", { timeout: 20000 });
  await sleep(400);
  await shot(p, "p05-perm-card");
  await shot(t, "t04-tablet-running");
  await p.locator(".pa-allow").first().click();
  await waitIdle(p);
  await sleep(500);
  await shot(p, "p06-after-allow");

  // 选择题
  await send(p, "问我一个问题");
  await p.waitForSelector(".perm-opt input", { timeout: 25000 });
  await sleep(400);
  await shot(p, "p07-question");
  await p.locator(".perm-opt input").first().check();
  await p.locator(".pa-answer, .pa-allow").first().click();
  await waitIdle(p);

  // 计划卡
  await send(p, "给我一个计划");
  await p.waitForFunction(() => document.querySelector(".perm-card, .perm")?.textContent.includes("计划") || document.body.textContent.includes("计划待批准"), null, { timeout: 25000 });
  await sleep(400);
  await shot(p, "p08-plan");
  await p.locator(".pa-allow").first().click();
  await waitIdle(p);

  // 停止与继续
  await send(p, "写一篇长文");
  await sleep(3000);
  await p.locator("#btn-send").click();
  await p.waitForFunction(() => document.body.textContent.includes("继续") && !document.querySelector("#btn-send")?.classList.contains("busy"), null, { timeout: 15000 });
  await sleep(400);
  await shot(p, "p09-stopped");
  await send(p, "继续");
  await waitIdle(p);

  // 侧栏远程分组：返回本机后开侧栏（远程页打开期间后台索引不刷新，首次需返回一次）
  await p.evaluate(() => window.__ccBack?.());
  await sleep(800);
  await p.evaluate(() => window.__cc?.openDrawer?.());
  await p.waitForSelector(".cch-remote-group .cch-rs-item", { timeout: 15000 });
  await sleep(500);
  await shot(p, "p10-sidebar-remote");
  // 从侧栏分组点回远程会话
  await p.locator(".cch-rs-item").first().click();
  await waitFresh(p);
  await sleep(500);
  await shot(p, "p11-sidebar-reenter");

  console.log("ERRORS", JSON.stringify(errors));
  console.log("CAPTURE DONE");
} finally { await browser.close(); }