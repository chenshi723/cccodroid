// 签名发布的公共部分（notice.mjs、claude-verified.mjs 共用）：
// PUB_DRY=1 只签名自验、把内容打出来（演练用）；PUB_LOCAL=1 签名写文件并本地提交、不推送。正常：用组件索引那把 ed25519 钥匙签名 → 用 App 里的公钥自验 → 写文件与 .sig → 提交推送 main → 触发官网生成器 → 等 cccodroid.net 上的副本与本地逐字节一致
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const KEYFILE = process.env.INDEX_SIGNING_KEY_FILE || "/data/user/0/li.dsh.claudecli/files/bldtools/index-signing-ed25519.pem";
export const die = (s) => { console.error("✗ " + s); process.exit(1); };
const git = (...a) => execFileSync("git", ["-c", "safe.directory=*", "-c", "user.name=greyoak111", "-c", "user.email=suny96636@gmail.com", "-C", ROOT, ...a], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param file 仓库里的相对路径  @param data 要发布的对象  @param msg 提交说明  @param site cccodroid.net 上的地址 */
export async function signAndPublish({ file, data, msg, site }) {
  const F = path.join(ROOT, file);
  const body = Buffer.from(JSON.stringify(data, null, 1) + "\n");
  const key = crypto.createPrivateKey(fs.readFileSync(KEYFILE, "utf8"));
  const sig = crypto.sign(null, body, key).toString("base64");
  // 用 App 里那把公钥验一遍：签错钥匙的话，所有用户都会丢弃这份
  const pubPem = /-----BEGIN PUBLIC KEY-----\\n([A-Za-z0-9+/=]+)\\n/.exec(fs.readFileSync(path.join(ROOT, "gateway/gw/notices.mjs"), "utf8"))?.[1];
  const pub = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----\n${pubPem}\n-----END PUBLIC KEY-----\n`);
  if (!crypto.verify(null, body, pub, Buffer.from(sig, "base64"))) die("签出来的和 App 里的公钥对不上");
  if (process.env.PUB_DRY) { console.log(body.toString("utf8") + `✓ 签名、自验都过了（PUB_DRY：不写文件、不推送）\n  提交说明：${msg}`); return; }
  fs.mkdirSync(path.dirname(F), { recursive: true });
  fs.rmSync(F, { force: true }); fs.writeFileSync(F, body);
  fs.rmSync(F + ".sig", { force: true }); fs.writeFileSync(F + ".sig", sig + "\n");
  for (const f of [F, F + ".sig"]) if (fs.statSync(f).size !== fs.readFileSync(f).length) die(`${f} 大小对不上（/sdcard FUSE），再跑一次 publish`);
  console.log(`✓ 已签名 ${file}`);

  git("add", file, file + ".sig");
  git("commit", "-q", "-m", `${msg}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
  // PUB_LOCAL=1：只提交不推送（要随下一次发版一起推，比如新版 App 才读的文件）
  if (process.env.PUB_LOCAL) { console.log(`✓ 已在本地提交 ${git("rev-parse", "--short", "HEAD")}（PUB_LOCAL：没推送，随下次推送 main 一起上）`); return; }
  git("push", "-q", "origin", "HEAD:main");
  console.log(`✓ 已推送 ${git("rev-parse", "--short", "HEAD")}`);

  if (!process.env.SITE_KICK) console.log("  没给 SITE_KICK：等官网 30 分钟的定时同步");
  for (let i = 0; i < 40; i++) {
    // 生成器从 raw.githubusercontent.com 取，那边缓存几分钟：第一次触发可能还拿到旧的，每 5 分钟再触发一次
    if (process.env.SITE_KICK && i % 10 === 0) execFileSync("sh", [process.env.SITE_KICK], { stdio: "inherit" });
    try {
      const r = await fetch(`${site}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok && Buffer.from(await r.arrayBuffer()).equals(body)) { console.log(`✓ ${site} 已是这一版。App 最迟 3 小时内取到`); return; }
    } catch {}
    await sleep(30000);
  }
  die(`20 分钟官网还没同步到这一版（看 cccodroid-site.service 的日志）`);
}
