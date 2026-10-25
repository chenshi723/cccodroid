// 从某个工具包 Release 的 devkit.lock.json 摘出 APK 要带的那几项，写成 devkit-pin.json。
// APK 首装（尤其从镜像下）和认本地文件都拿它当准：校验值跟着 APK 走，不靠下载来源。
//   node scripts/pin-devkit.mjs <Release 目录 URL> <输出文件>
// 换工具包版本时：改 devkit-sources.txt，再跑一次这个，两个文件一起提交。build.sh 会核对两者是同一版。
import fs from "node:fs";
const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error("用法: node pin-devkit.mjs <base/> <out.json>"); process.exit(2); }
const r = await fetch(base.replace(/\/?$/, "/") + "devkit.lock.json", { redirect: "follow" });
if (!r.ok) { console.error(`✗ 取不到清单：HTTP ${r.status}`); process.exit(1); }
const lockBuf = Buffer.from(await r.arrayBuffer());
const lock = JSON.parse(lockBuf.toString("utf8"));
const tag = (base.match(/\/download\/([^/]+)\/?$/) || [])[1] || "";
const pick = (o) => o && { file: o.file, sha256: o.sha256, bytes: o.bytes };
const pin = { tag, base: base.replace(/\/?$/, "/"), target: lock.target, compat: lock.compat ?? 1, gz: pick(lock.gz), tar: pick(lock.tar) };
if (!pin.gz || !/^[0-9a-f]{64}$/.test(pin.gz.sha256 || "")) { console.error("✗ 清单里没有 gz 的 sha256"); process.exit(1); }
// 锁文件本身也钉上（审计 M-2c）：build.sh 靠它挑 glibc 包抽 ld.so，不能只靠下载时的 TLS
pin.lock = { file: "devkit.lock.json", sha256: (await import("node:crypto")).createHash("sha256").update(lockBuf).digest("hex"), bytes: lockBuf.length };
// 模块化 Release（0.3.9 起）另有 modules.json：钉它的 sha256，里面又有每块的 sha256，首装勾哪几块都核得上
const mr = await fetch(pin.base + "modules.json", { redirect: "follow" });
if (mr.ok) {
  const b = Buffer.from(await mr.arrayBuffer());
  pin.modules = { file: "modules.json", sha256: (await import("node:crypto")).createHash("sha256").update(b).digest("hex"), bytes: b.length };
}
fs.writeFileSync(out, JSON.stringify(pin, null, 1) + "\n");
console.log(`✓ ${out}：${tag} gz ${pin.gz.sha256.slice(0, 12)}… · lock ${pin.lock.sha256.slice(0, 12)}…${pin.modules ? ` · modules.json ${pin.modules.sha256.slice(0, 12)}…` : "（整包，没有模块）"}`);
