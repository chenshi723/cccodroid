import fs from "node:fs";
import { execFileSync } from "node:child_process";

// ── 设备信息：给 Claude 一份读准的硬件底子 ──
// 不给的话模型会拿型号去猜（群友的天玑 700 被说成骁龙 888）。芯片以系统属性和内核为准：
// ro.soc.*（安卓 12 起才有）→ ro.board.platform / ro.hardware（联发科是 mt6833 这种代号，高通是 taro 这种平台名）。
// 只在网关启动后第一次用到时读一遍，之后复用
let cached = null;
export function deviceFacts() {
  if (cached !== null) return cached;
  cached = "";
  const p = {};
  try {
    const out = execFileSync("/system/bin/getprop", [], { encoding: "utf8", timeout: 3000, maxBuffer: 4 << 20 });
    for (const m of out.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)) p[m[1]] = m[2].trim();
  } catch { return cached; }
  const g = (...ks) => { for (const k of ks) if (p[k]) return p[k]; return ""; };
  const lines = [];
  const maker = g("ro.product.manufacturer"), brand = g("ro.product.brand"), model = g("ro.product.model");
  const market = g("ro.product.marketname", "ro.product.vendor.marketname", "ro.vendor.product.marketname", "ro.vivo.market.name",
    "ro.vendor.oplus.market.name", "ro.config.marketing_name", "ro.product.odm.marketname");
  lines.push(`- 机型：${maker}${brand && brand.toLowerCase() !== maker.toLowerCase() ? `（${brand}）` : ""} ${model}${market ? `，商品名「${market}」` : ""}`);
  lines.push(`- 系统：Android ${g("ro.build.version.release")}（SDK ${g("ro.build.version.sdk")}），${g("ro.product.cpu.abi")}`);
  const soc = [g("ro.soc.manufacturer"), g("ro.soc.model")].filter(Boolean).join(" ");
  const plat = [["ro.board.platform", g("ro.board.platform")], ["ro.hardware", g("ro.hardware")], ["ro.hardware.chipname", g("ro.hardware.chipname", "ro.chipname")]]
    .filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("，");
  let hw = ""; try { hw = (fs.readFileSync("/proc/cpuinfo", "utf8").match(/^Hardware\s*:\s*(.+)$/m) || [])[1] || ""; } catch {}
  lines.push(`- 芯片：${soc || "（系统未提供 ro.soc.model）"}${plat ? `；${plat}` : ""}${hw ? `；/proc/cpuinfo Hardware=${hw.trim()}` : ""}`);
  // CPU：按最高频率分簇，如 4×2.02 GHz + 3×2.75 GHz + 1×3.19 GHz
  try {
    const fq = {};
    for (const d of fs.readdirSync("/sys/devices/system/cpu").filter((x) => /^cpu\d+$/.test(x))) {
      let f = 0; try { f = Number(fs.readFileSync(`/sys/devices/system/cpu/${d}/cpufreq/cpuinfo_max_freq`, "utf8")); } catch {}
      fq[f] = (fq[f] || 0) + 1;
    }
    const n = Object.values(fq).reduce((a, b) => a + b, 0);
    const parts = Object.keys(fq).map(Number).sort((a, b) => a - b).filter((f) => f > 0).map((f) => `${fq[f]}×${(f / 1e6).toFixed(2)} GHz`);
    if (n) lines.push(`- CPU：${n} 核${parts.length ? `（${parts.join(" + ")}）` : ""}`);
  } catch {}
  let gpu = "";
  try { gpu = fs.readFileSync("/sys/class/kgsl/kgsl-3d0/gpu_model", "utf8").trim(); } catch {}
  if (!gpu && fs.existsSync("/dev/kgsl-3d0")) gpu = "Adreno";
  if (!gpu && fs.existsSync("/dev/mali0")) gpu = "Mali";
  if (gpu) lines.push(`- GPU：${gpu}`);
  try {
    const kb = Number((fs.readFileSync("/proc/meminfo", "utf8").match(/^MemTotal:\s*(\d+)/m) || [])[1]);
    if (kb) lines.push(`- 内存：${(kb / 1048576).toFixed(1)} GB`);
  } catch {}
  lines.push("- 说到这台设备的芯片、型号时以上面的读数为准，不要按机型编号去推测；平台代号（如 mt6833、taro）对应的商品名拿不准就照实说代号");
  cached = lines.join("\n");
  return cached;
}
