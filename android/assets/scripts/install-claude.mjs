// ─────────────────────────────────────────────────────────────────────
//  install-claude.mjs —— 下载 Anthropic 官方的 Claude Code（原版二进制，不做任何修改），多个来源互为后备
//
//  用法: node install-claude.mjs [stable|latest|<版本号>]      （install-claude.sh 转过来）
//
//  信任从哪来（两条，至少要满足一条，否则不装）：
//   ① 官方清单 manifest.json：先找 downloads.claude.ai，拿不到就找 cccodroid.net 的镜像。
//      镜像来的必须过 Anthropic 的 PGP 签名（manifest.json.sig，钥匙指纹钉在下面）。
//      有了清单，二进制不管从哪下，解出来的 sha256 都必须与清单里 linux-arm64 那项一致。
//   ② 清单拿不到：用 npm 上 Anthropic 发布的平台包 @anthropic-ai/claude-code-linux-arm64，
//      先验 npm 官方的 ECDSA 签名（公钥钉在下面），再验包的 sha512。这样装上的标记为「待核」，
//      网关以后连得上官方时补核 sha256（见 server.mjs 的 claudeRecheck）。
//  二进制来源依次：官方直链 → npmmirror（阿里）→ 腾讯云 npm → npm 官方。上次成功的来源排最前。
//  每个来源卡住（30 秒低于 20 KB/s）或连着断两次就换下一个；同一种包在不同来源之间断点续传。
//  镜像只是换条线路拿同一份文件，不需要被信任：内容一律由上面的签名和哈希把关。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const OFFICIAL = process.env.CCODROID_CLAUDE_OFFICIAL || "https://downloads.claude.ai/claude-code-releases";   // 两个变量只给测试换地址用
// 清单镜像两条线：cccodroid.net 走 Cloudflare，dl.cccodroid.net 直连服务器（国内有的网络只通其中一条）
const MIRRORS = process.env.CCODROID_CLAUDE_MIRROR ? [["cccodroid.net 镜像", process.env.CCODROID_CLAUDE_MIRROR]]
  : [["cccodroid.net 镜像", "https://cccodroid.net/claude-code"], ["dl.cccodroid.net 镜像", "https://dl.cccodroid.net/claude-code"]];
const PKG = "@anthropic-ai/claude-code-linux-arm64", PLATFORM = "linux-arm64";
const REGISTRIES = [
  ["npmmirror", "https://registry.npmmirror.com"],
  ["tencent", "https://mirrors.cloud.tencent.com/npm"],
  ["npmjs", "https://registry.npmjs.org"],
];
// Anthropic 的发布签名钥（https://downloads.claude.ai/keys/claude-code.asc，与 keys.openpgp.org 上同指纹的一致）
const ANTHROPIC_KEYS = {"31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE":{"kty":"RSA","n":"p28rSV5I8HmK8CK9GixBUZR_gtJxeOCsRXO4EJiej40jzBmQA3cWXGosVO82ZfFsRKVTtMC5iB_HH9sxjncrmYNWGroJNbx29m_FgYQBgkCXT4AfFl6rnnXqRGLZOerj_4AqE4yQ1GZbhBgR55Z7ro0ieKK8RHYUspBKAFHyWRhCCz6THW6YRbf0p_hG_08TOY6Sj3cJ7_AEoTRf9ZmVNX1k0KvbUSiVGpGY9OIHWgxRJUF2pArU4o_hk-sqGAgEUh8Bjvjwvz6-quLXPg-y0Y8Ugb1Fg6BUppam_zydYY_Q_-yNjnuF154gD1jEeeir8R5czs6zUHSbo2yXUpAsIdWYo5End8vGsluVmFExnUWm_fTVMGoM5Wm3v1VRepMydEnJ-atz4oQdmPQcKNAip5GJO2uyk--xFr9CpKvlR5jral92toYV_m-mur3va8ydamWBo_qG7_wt0sdS81IwH6lcu0SQ39rgKD-bdoPLv05EqVMYTFRI2QZEsWGYTMs0DOrfCIJFH50qyD0x4sWw1gEWeG3jDgY8cj2StZz-zjqzUd05CibcCzEAGm1EQg5y9D40tIsAU1OI7bpgQ9V0lC8lrqE7zJY66UK9Z1daA8jrdDi6migNjHFrXfT3V4QvMthCIO05q05SS3x2G3ZpIgmI-CePUPB1pDf-lhPkU1M","e":"AQAB"}};
// npm registry 的签名公钥（https://registry.npmjs.org/-/npm/v1/keys，只留没过期的）
const NPM_KEYS = {"SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g=="};

const PREFIX = process.env.PREFIX || "";
const CURL = PREFIX ? path.join(PREFIX, "bin", "curl") : "curl";
const TAR = PREFIX ? path.join(PREFIX, "bin", "tar") : "tar";
const DEST = path.join(process.env.HOME, ".local/share/cccodroid/claude");
const CHANNEL = process.argv[2] || "stable";
const say = (s) => console.log(s);
const die = (s) => { console.log("✗ " + s); process.exit(1); };

// 极简 OpenPGP：只认 v4 的 RSA 公钥包与 v4 RSA 分离签名（Anthropic 的 manifest.json.sig 就是这种）
function dearmor(t) {
  const body = String(t).replace(/\r/g, "").split("\n\n").slice(1).join("\n\n").split("\n=")[0];
  return Buffer.from(body.replace(/\s/g, ""), "base64");
}
function packets(b) {
  const out = [];
  for (let o = 0; o < b.length;) {
    const h = b[o++]; if (!(h & 0x80)) throw new Error("bad packet");
    let tag, len;
    if (h & 0x40) { tag = h & 63; const l = b[o++]; if (l < 192) len = l; else if (l < 224) len = ((l - 192) << 8) + b[o++] + 192; else if (l === 255) { len = b.readUInt32BE(o); o += 4; } else throw new Error("partial len"); }
    else { tag = (h >> 2) & 15; const lt = h & 3; if (lt === 0) len = b[o++]; else if (lt === 1) { len = b.readUInt16BE(o); o += 2; } else if (lt === 2) { len = b.readUInt32BE(o); o += 4; } else len = b.length - o; }
    out.push({ tag, body: b.subarray(o, o + len) }); o += len;
  }
  return out;
}
const mpi = (b, o) => { const bits = b.readUInt16BE(o), n = (bits + 7) >> 3; return [b.subarray(o + 2, o + 2 + n), o + 2 + n]; };
const b64u = (x) => Buffer.from(x).toString("base64url");
/** 公钥块里所有 RSA 钥（主钥 + 子钥）：[{fpr, jwk}] */
function rsaKeys(armored) {
  const keys = [];
  for (const p of packets(dearmor(armored))) {
    if ((p.tag !== 6 && p.tag !== 14) || p.body[0] !== 4 || p.body[5] !== 1) continue;
    const [n, o1] = mpi(p.body, 6), [e] = mpi(p.body, o1);
    const hdr = Buffer.from([0x99, p.body.length >> 8, p.body.length & 255]);
    keys.push({ fpr: crypto.createHash("sha1").update(hdr).update(p.body).digest("hex").toUpperCase(), primary: p.tag === 6, jwk: { kty: "RSA", n: b64u(n), e: b64u(e) } });
  }
  return keys;
}
/** 验分离签名：data 是被签的原始字节，keys 是 {指纹: jwk}。返回签名用的指纹，不通过抛错 */
function verifyDetached(data, sigArmored, keys) {
  const sp = packets(dearmor(sigArmored)).find((p) => p.tag === 2);
  if (!sp) throw new Error("no signature packet");
  const s = sp.body;
  if (s[0] !== 4 || s[1] !== 0 || s[2] !== 1) throw new Error("unsupported signature (want v4 binary RSA)");
  const hashName = { 8: "sha256", 9: "sha384", 10: "sha512" }[s[3]];
  if (!hashName) throw new Error("unsupported hash " + s[3]);
  const hl = s.readUInt16BE(4), hashed = s.subarray(0, 6 + hl);
  let fpr = "";
  const sub = (buf) => { for (let o = 0; o < buf.length;) { let l = buf[o++]; if (l >= 192 && l < 255) l = ((l - 192) << 8) + buf[o++] + 192; else if (l === 255) { l = buf.readUInt32BE(o); o += 4; } const t = buf[o] & 0x7f; if (t === 33) fpr = buf.subarray(o + 2, o + l).toString("hex").toUpperCase(); o += l; } };
  sub(s.subarray(6, 6 + hl));
  const ul = s.readUInt16BE(6 + hl); if (!fpr) sub(s.subarray(8 + hl, 8 + hl + ul));
  const jwk = keys[fpr];
  if (!jwk) throw new Error("signed by unknown key " + (fpr || "?"));
  const [sig] = mpi(s, 8 + hl + ul + 2);
  const trailer = Buffer.alloc(6); trailer[0] = 4; trailer[1] = 0xff; trailer.writeUInt32BE(hashed.length, 2);
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const nlen = Buffer.from(jwk.n, "base64url").length, sigp = Buffer.concat([Buffer.alloc(Math.max(0, nlen - sig.length)), sig]);
  if (!crypto.verify(hashName, Buffer.concat([data, hashed, trailer]), pub, sigp)) throw new Error("bad signature");
  return fpr;
}


/** 小文件：curl 拿到内存，失败再试一次，还不行返回 null（不抛） */
function small(url, t = 20) {
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(CURL, ["-fsSL", "--connect-timeout", "10", "--max-time", String(t), url], { maxBuffer: 32 << 20 });
    if (r.status === 0) return r.stdout;
  }
  return null;
}
const jsonOf = (b) => { try { return b && JSON.parse(b.toString("utf8")); } catch { return null; } };
const isVer = (v) => /^\d+\.\d+\.\d+/.test(v || "");
const sha = (f, alg = "sha256", enc = "hex") => { const h = crypto.createHash(alg), fd = fs.openSync(f, "r"), b = Buffer.alloc(1 << 20); let n; while ((n = fs.readSync(fd, b, 0, b.length)) > 0) h.update(b.subarray(0, n)); fs.closeSync(fd); return h.digest(enc); };
const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

// ── 补核：npm 签名装上的（.npm-only），连得上官方清单时核 sha256。网关定时调；退出码 3 = 对不上 ──
if (CHANNEL === "--recheck") {
  let bad = 0;
  for (const d of (() => { try { return fs.readdirSync(DEST); } catch { return []; } })()) {
    const dir = path.join(DEST, d), mark = path.join(dir, ".npm-only");
    if (!isVer(d) || !fs.existsSync(mark)) continue;
    const m = officialManifest(d, true);
    if (!m) { say(`${d}：官方清单还拿不到，下次再核`); continue; }
    const got = sha(path.join(dir, "claude"));
    if (got === m.sum) { fs.rmSync(mark, { force: true }); say(`✓ ${d}：与官方清单一致（${m.anchor}）`); }
    else { bad++; fs.writeFileSync(path.join(dir, ".mismatch"), got + "\n"); say(`✗ ${d}：与官方清单不符（期望 ${m.sum.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）`); }
  }
  process.exit(bad ? 3 : 0);
}

// ── 1. 版本号 ───────────────────────────────────────────────
let VER = isVer(CHANNEL) ? CHANNEL : "";
if (!VER) {
  for (const [name, get] of [
    ["官方", () => small(`${OFFICIAL}/${CHANNEL}`)],
    ...MIRRORS.map(([n, u]) => [n, () => small(`${u}/${CHANNEL}`)]),
    ...REGISTRIES.map(([n, u]) => [n, () => { const j = jsonOf(small(`${u}/-/package/${PKG.replace("/", "%2f")}/dist-tags`)); return j && j[CHANNEL] ? Buffer.from(j[CHANNEL]) : null; }]),
  ]) {
    const v = (get() || "").toString().trim();
    if (isVer(v)) { VER = v; say(`版本 ${VER}（${CHANNEL}，来自${name}）`); break; }
    say(`  ${name}取不到版本号，换下一个…`);
  }
  if (!VER) die("所有来源都取不到版本号：检查网络后重试");
} else say(`版本 ${VER}`);

// ── 2. 官方清单（信任锚 ①）──────────────────────────────────
function officialManifest(ver, quiet) {
  // 官方源也要验签（10-25 安全审计 M-2a）：只靠 HTTPS 的话，装了别的根证书的代理能连清单带程序一起换掉。
  // 2.1 之前的老版本官方没有签名文件，会退到下面的 npm 签名这道锚
  for (const [name, base, mustSign] of [["官方", OFFICIAL, true], ...MIRRORS.map(([n, u]) => [n, u, true])]) {
    const m = small(`${base}/${ver}/manifest.json`);
    if (!m) { quiet || say(`  ${name}清单取不到`); continue; }
    const sig = small(`${base}/${ver}/manifest.json.sig`);
    let signed = false;
    if (sig) { try { verifyDetached(m, sig.toString("utf8"), ANTHROPIC_KEYS); signed = true; } catch (e) { say(`  ${name}清单签名不对（${e.message}），不用`); continue; } }
    if (mustSign && !signed) { quiet || say(`  ${name}的签名文件取不到，不用`); continue; }
    const j = jsonOf(m), p = j && j.platforms && j.platforms[PLATFORM];
    if (!j || j.version !== ver || !p || !/^[a-f0-9]{64}$/.test(p.checksum)) { say(`  ${name}清单内容不对，不用`); continue; }
    return { sum: p.checksum, size: p.size, anchor: signed ? `${name}清单（Anthropic 签名已验）` : `${name}清单（HTTPS）` };
  }
  return null;
}
let SUM = "", SIZE = 0, anchor = "";
{ const m = officialManifest(VER); if (m) { ({ sum: SUM, size: SIZE, anchor } = m); say(`✓ ${anchor}`); } }

// ── 3. npm 包信息（信任锚 ②，也是镜像下载地址）───────────────
let NPM = null;
function npmMeta() {
  if (NPM !== null) return NPM;
  NPM = false;
  for (const [n, u] of REGISTRIES) {
    const j = jsonOf(small(`${u}/${PKG.replace("/", "%2f")}/${VER}`));
    const d = j && j.dist;
    if (!d || j.name !== PKG || j.version !== VER || !/^sha512-/.test(d.integrity || "")) { say(`  ${n} 取不到 npm 包信息`); continue; }
    const msg = Buffer.from(`${j.name}@${j.version}:${d.integrity}`);
    const ok = (d.signatures || []).some((s) => NPM_KEYS[s.keyid] && crypto.verify("sha256", msg,
      { key: Buffer.from(NPM_KEYS[s.keyid], "base64"), format: "der", type: "spki" }, Buffer.from(s.sig, "base64")));
    if (!ok) { say(`  ${n} 的 npm 签名验不过，不用`); continue; }
    const file = d.tarball.split("/-/").pop();
    NPM = { integrity: d.integrity, file, via: n };
    break;
  }
  return NPM;
}
if (!SUM) {
  say("官方清单拿不到，改用 npm 上 Anthropic 发布的同一份包（验 npm 签名）");
  if (!npmMeta()) die("官方清单和 npm 包信息都拿不到，没法确认文件是原版：换个网络再试");
  anchor = `npm 签名（经 ${NPM.via}）`;
  say(`✓ ${anchor}`);
}

// ── 4. 下载 ─────────────────────────────────────────────────
const OUT = path.join(DEST, VER);
fs.mkdirSync(OUT, { recursive: true });
const BIN = path.join(OUT, "claude");
const okNow = () => fs.existsSync(BIN) && (SUM ? sha(BIN) === SUM : fs.existsSync(path.join(OUT, ".npm-only")));
if (okNow()) say("已是该版本，校验通过");
else {
  const lastFile = path.join(DEST, ".source");
  const last = (() => { try { return fs.readFileSync(lastFile, "utf8").trim(); } catch { return ""; } })();
  let srcs = [{ id: "official", name: "官方", kind: "raw", url: `${OFFICIAL}/${VER}/${PLATFORM}/claude` },
    ...REGISTRIES.map(([n, u]) => ({ id: n, name: n, kind: "npm", reg: u }))];
  if (!SUM) srcs = srcs.filter((s) => s.kind === "npm");       // 没有官方清单，直链下来的没法核，只走 npm
  srcs.sort((a, b) => (b.id === last) - (a.id === last));
  const raw = path.join(OUT, "claude.part"), tgz = path.join(OUT, "claude.tgz.part");
  const tag = (f, v) => { const t = f + ".for"; let o = ""; try { o = fs.readFileSync(t, "utf8"); } catch {} if (o !== v) { fs.rmSync(f, { force: true }); fs.rmSync(f + ".seg", { force: true }); fs.writeFileSync(t, v); } };
  // 分段并行下载（gw/pget.mjs，随网关一起装在 app/gw/）；找不到就照旧单线 curl -C -
  const PG = await import(new URL("../gw/pget.mjs", import.meta.url).href).catch(() => null);

  const fetchTo = (url, file, total, label, exact) => PG ? PG.pget({ curl: CURL, url, file, total: exact ? total : 0,
    onProgress: (d) => console.log(`@progress ${d} ${total}`) }) : new Promise((resolve) => {
    const c = spawn(CURL, ["-fsSL", "--connect-timeout", "15", "--speed-limit", "20480", "--speed-time", "30", "-C", "-", "-o", file, url], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; c.stderr.on("data", (d) => { err += d; });
    const tick = setInterval(() => console.log(`@progress ${size(file)} ${total}`), 2000);
    c.on("close", (code) => { clearInterval(tick); console.log(`@progress ${size(file)} ${total}`); resolve(code === 0 ? "" : (err.trim().split("\n").pop() || "curl " + code).replace(/^curl: \(\d+\) /, "")); });
  });

  let done = false;
  for (let round = 0; round < 2 && !done; round++) {
   // 第一轮全断了多半是网络整个掉了（切后台、换网络）：等一会儿再来一轮
   if (round) { say("所有来源都没下成功，15 秒后再试一轮…"); await new Promise((ok) => setTimeout(ok, 15000)); }
   for (const s of srcs) {
    let url, file, total;
    if (s.kind === "raw") { url = s.url; file = raw; total = SIZE; tag(raw, SUM); }
    else {
      if (!npmMeta()) continue;
      url = `${s.reg}/${PKG}/-/${NPM.file}`; file = tgz; tag(tgz, NPM.integrity);
      const len = Number((spawnSync(CURL, ["-fsSIL", "--max-time", "15", url]).stdout || "").toString().match(/content-length:\s*(\d+)/gi)?.pop()?.split(":")[1]) || 0;
      total = len || Math.round((SIZE || 250e6) * 0.45); s.exact = !!len;
    }
    say(`从${s.name}下载 ${Math.round(total / 1048576)} MB${size(file) ? `（续传，已有 ${Math.round(size(file) / 1048576)} MB）` : ""}…`);
    let err = "";
    for (let i = 0; i < 2; i++) { err = await fetchTo(url, file, total, s.name, s.kind === "raw" ? SIZE > 0 : s.exact); if (!err) break; say(`  ${s.name}断了（${err}），${i ? "换下一个来源" : "续传重试"}…`); }
    if (err) continue;
    // 校验与落地
    if (s.kind === "raw") {
      const got = sha(raw);
      if (got !== SUM) { say(`  sha256 不符（期望 ${SUM.slice(0, 12)}…，实得 ${got.slice(0, 12)}…），丢掉换来源`); fs.rmSync(raw, { force: true }); continue; }
      fs.renameSync(raw, BIN);
    } else {
      const got = "sha512-" + sha(tgz, "sha512", "base64");
      if (got !== NPM.integrity) { say("  npm 包的 sha512 与签名记录不符，丢掉换来源"); fs.rmSync(tgz, { force: true }); continue; }
      const x = path.join(OUT, "x"); fs.rmSync(x, { recursive: true, force: true }); fs.mkdirSync(x);
      const r = spawnSync(TAR, ["-xzf", tgz, "-C", x, "package/claude"]);
      if (r.status !== 0 || !fs.existsSync(path.join(x, "package/claude"))) { say("  解包失败：" + String(r.stderr || "").trim()); fs.rmSync(tgz, { force: true }); continue; }
      const f = path.join(x, "package/claude");
      if (SUM) { const g = sha(f); if (g !== SUM) { say(`  解出的程序与官方清单不符（实得 ${g.slice(0, 12)}…），丢掉换来源`); fs.rmSync(x, { recursive: true, force: true }); fs.rmSync(tgz, { force: true }); continue; } }
      fs.renameSync(f, BIN); fs.rmSync(x, { recursive: true, force: true }); fs.rmSync(tgz, { force: true });
    }
    for (const f of [raw, tgz]) { fs.rmSync(f, { force: true }); fs.rmSync(f + ".for", { force: true }); fs.rmSync(f + ".seg", { force: true }); }
    fs.rmSync(path.join(OUT, ".mismatch"), { force: true });      // 补核没过、重下成功的，标记一起去掉
    if (SUM) { fs.rmSync(path.join(OUT, ".npm-only"), { force: true }); say("✓ sha256 与官方清单一致"); }
    else { fs.writeFileSync(path.join(OUT, ".npm-only"), VER + "\n"); say("✓ npm 签名与 sha512 一致（官方清单以后连得上时会自动补核）"); }
    try { fs.writeFileSync(lastFile, s.id); } catch {}
    done = true; break;
   }
  }
  if (!done) die("所有来源都没下成功：检查网络后重试（已下的部分会保留，下次接着续传）");
}

// ── 5. 先试跑新版，跑得起来才换上，留一版旧的 ─────────────────────
// 先换 current 再试跑的话，试跑失败会让 current 指着一个跑不起来的版本，旧版明明还在却用不上
fs.chmodSync(BIN, 0o755);
// 经加载器时（targetSdk 36）用 APK 里的 ld.so、多挂 exec-shim.so，并摘掉 bionic 的 LD_PRELOAD（见 Env.java applyLoader）
const PL = process.env.CCAPP_GLIBC_PRELOAD || (process.env.CCAPP_CLAUDE_PRELOAD && fs.existsSync(process.env.CCAPP_CLAUDE_PRELOAD) ? process.env.CCAPP_CLAUDE_PRELOAD : "");
const P = PL ? ["--preload", PL] : [];
const GENV = { ...process.env }; delete GENV.LD_PRELOAD;
const r = spawnSync(process.env.CCAPP_LD || path.join(PREFIX, "glibc/lib/ld-linux-aarch64.so.1"), ["--library-path", path.join(PREFIX, "glibc/lib"), ...P, BIN, "--version"], { stdio: "inherit", env: GENV });
if (r.status !== 0) die("新版本试跑失败（--version 没跑通），没有换上，继续用原来的版本");
const cur = path.join(DEST, "current");
let prev = ""; try { prev = fs.readlinkSync(cur); } catch {}
const tmp = cur + ".new"; fs.rmSync(tmp, { force: true }); fs.symlinkSync(OUT, tmp); fs.renameSync(tmp, cur);
// 只留当前版和上一版（每版约 275 MB）。正在跑的旧 claude 已经映射进内存，删文件不影响它
for (const d of fs.readdirSync(DEST)) {
  const p = path.join(DEST, d);
  if (d.startsWith(".") || d === "current" || p === OUT || p === prev) continue;
  try { if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true }); } catch {}
}
process.exit(0);
