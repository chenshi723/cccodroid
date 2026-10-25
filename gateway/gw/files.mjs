import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, HERE, PREFIX, log, tz } from "./config.mjs";
import { SETTINGS } from "./settings.mjs";
import { SEED_FILE } from "./providers.mjs";
import { claudeEnv } from "./claude.mjs";
import { NEXT, fileKind, mimeOf, readBody, readBodyBuf, sendJson } from "./http.mjs";
import { toFront } from "./local.mjs";

// ── 文件收发：读图 / 读文件 / 把东西递进来 ────────────────────────────
// /api/file   把磁盘上的文件流给界面（消息里的图片靠它显示）
// /api/upload 把界面拿到的东西（粘贴/拖放/选择）落盘成 claude 能读的路径
export const UPLOAD_DIR = path.join(CFG.workspace, "uploads");

/** 绝不外发的路径：密钥所在的应用私有目录、运行时、以及几个具名的凭据文件。
 *  说明：这台网关本就只监听 127.0.0.1，且 /api/chat 等于本机任意命令执行 ——
 *  这一层是「别让取文件接口顺手把密钥递出去」的防呆，不是完整的鉴权边界。 */
const SECRET_NAMES = new Set([
  "ccapp-providers.json", "ccapp-config.json", "ccapp-seed.json",
  "keystore.json", "debug.keystore", "id_ed25519", "id_rsa", "id_ecdsa",
]);
const SECRET_RE = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud)(\/|$)/;

/** 在不在工作区里（按真实路径）。cccodroid 的工作区就在 home 下面（files/home/workspace）——
 *  只按 home 拦，工作区里的文件（附件、Claude 生成的图）就全成了 403，缩略图和查看器都打不开 */
function inWorkspace(real) {
  let ws; try { ws = fs.realpathSync(CFG.workspace); } catch { ws = CFG.workspace; }
  return real === ws || real.startsWith(ws + path.sep);
}

export function safeFilePath(p) {
  if (!p) return { error: "path required" };
  let full = String(p).trim();
  if (full.startsWith("file://")) { try { full = fileURLToPath(full); } catch {} }
  if (!path.isAbsolute(full)) full = path.join(CFG.workspace, full);

  let real;
  try { real = fs.realpathSync(full); } catch (e) { return { error: "not found", detail: e.message }; }

  for (const root of inWorkspace(real) ? [SEED_FILE] : [CFG.home, CFG.runtime, SEED_FILE]) {
    if (!root) continue;
    let rr; try { rr = fs.realpathSync(root); } catch { rr = root; }
    if (real === rr || real.startsWith(rr + path.sep)) return { error: "forbidden", status: 403 };
  }
  if (SECRET_NAMES.has(path.basename(real)) || SECRET_RE.test(real)) {
    return { error: "forbidden", status: 403 };
  }

  let st; try { st = fs.statSync(real); } catch (e) { return { error: e.message }; }
  if (st.isDirectory()) return { error: "is a directory", status: 400 };
  return { file: real, size: st.size, mtime: st.mtimeMs };
}

/** 写文件前的同一套防呆：已有文件走 safeFilePath；新文件看父目录 */
function safeWritePath(p) {
  if (!p || !path.isAbsolute(String(p))) return { error: "absolute path required", status: 400 };
  const full = String(p);
  if (fs.existsSync(full)) return safeFilePath(full);
  let dir;
  try { dir = fs.realpathSync(path.dirname(full)); } catch (e) { return { error: "no such directory", status: 400 }; }
  for (const root of inWorkspace(dir) ? [] : [CFG.home, CFG.runtime]) {
    let rr; try { rr = fs.realpathSync(root); } catch { rr = root; }
    if (dir === rr || dir.startsWith(rr + path.sep)) return { error: "forbidden", status: 403 };
  }
  const name = path.basename(full);
  if (SECRET_NAMES.has(name) || SECRET_RE.test(path.join(dir, name))) return { error: "forbidden", status: 403 };
  return { file: path.join(dir, name), size: 0, mtime: 0, fresh: true };
}

/** 供文件面板用的快捷入口 */
export function fileRoots() {
  const out = [];
  const seen = new Set();
  const add = (x) => {
    if (!x || seen.has(x)) return;
    seen.add(x);
    try { if (fs.statSync(x).isDirectory()) out.push(x); } catch {}
  };
  add(UPLOAD_DIR);
  add(CFG.workspace);
  add(process.env.CCAPP_SHARED);
  add("/sdcard/DeepSeekHarness");
  add("/sdcard/Pictures"); add("/sdcard/DCIM/Camera"); add("/sdcard/Download"); add("/sdcard/Documents");
  add("/sdcard");
  for (const d of SETTINGS.addDirs || []) add(d);
  return out;
}

// ── 截屏 ──────────────────────────────────────────────────────────────
/** 整屏截图（PNG）。cccodroid：priv 的 stdout 是干净的二进制通道，直接收；
 *  开发端的 rish 会把输出随机拆到 stdout / stderr，二进制会坏 —— 先写到共享存储再读回来 */
async function screencap() {
  let last = "";
  for (let i = 0; i < 2; i++) {
    const r = await screencapOnce();
    // 完整的 PNG 以 IEND 块收尾；只看开头的魔数会把截断的文件当成好的（界面上就是一张坏图）
    if (r.buf && r.buf.length > 64 && r.buf.readUInt32BE(0) === 0x89504e47 && r.buf.subarray(-8, -4).toString("latin1") === "IEND") return r.buf;
    last = `${r.buf ? r.buf.length : 0} B${r.code != null ? " rc=" + r.code : ""}${r.err ? " " + r.err : ""}`;
    log(`[screenshot] 第 ${i + 1} 次不完整：${last}`);
  }
  throw new Error(tz("截屏失败（Shizuku 可用吗？设置 → Shizuku）") + " · " + last);
}
function screencapOnce() {
  return new Promise((resolve) => {
    if (PREFIX) {
      // 去掉 CCAPP_RUN：特权命令记录按这个标记认「Claude 发起的」，截屏是用户在界面上点的
      const env = claudeEnv(); delete env.CCAPP_RUN;
      const c = spawn(process.execPath, [path.join(process.env.CCAPP_BIN || HERE, "priv.mjs"), "screencap -p"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const out = [], err = [];
      c.stdout.on("data", (d) => out.push(d));
      c.stderr.on("data", (d) => err.push(d));
      const t = setTimeout(() => c.kill("SIGKILL"), 20000);
      c.on("close", (code) => { clearTimeout(t); resolve({ buf: Buffer.concat(out), code, err: Buffer.concat(err).toString().trim().slice(0, 160) }); });
      c.on("error", (e) => { clearTimeout(t); resolve({ buf: null, err: e.message }); });
      return;
    }
    const tmp = "/sdcard/Download/.ccapp-screen.png";
    execFile("priv", [`screencap -p ${tmp}`], { timeout: 20000, env: process.env }, (e) => {
      let buf = null; try { buf = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); } catch {}
      resolve({ buf, err: e ? e.message.slice(0, 160) : "" });
    });
  });
}

// ── 路由：/api/file /api/file/stat /api/file/save /api/file/new /api/file/rename /api/upload /api/screenshot /api/files ──
export async function routeFiles(req, res, u, p) {
  // ── 取文件内容（消息里的图片、文件预览、下载都走这里）──
  if (req.method === "GET" && p === "/api/file") {
    const r = safeFilePath(u.searchParams.get("path"));
    if (r.error) return sendJson(res, r.status || 404, { error: r.error, detail: r.detail });
    const head = {
      "content-type": mimeOf(r.file),
      "content-length": r.size,
      "cache-control": "no-store",
      "x-mtime": String(r.mtime),     // 编辑器保存时带回来做冲突检测
      // 文件内容不可信（Claude 写的、别处下的）：哪怕被整页打开，也只当不透明源、不跑脚本，碰不到网关的 Cookie 和 /api
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    };
    if (u.searchParams.get("download") === "1") {
      head["content-disposition"] =
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(r.file))}`;
    }
    res.writeHead(200, head);
    const st = fs.createReadStream(r.file);
    st.on("error", () => { try { res.destroy(); } catch {} });
    st.pipe(res);
    return;
  }
  if (req.method === "GET" && p === "/api/file/stat") {
    let q = String(u.searchParams.get("path") || "").trim();
    if (!path.isAbsolute(q)) return sendJson(res, 400, { error: "absolute path required" });
    let real;
    try { real = fs.realpathSync(q); } catch { return sendJson(res, 404, { error: "not found", path: q }); }
    let st; try { st = fs.statSync(real); } catch (e) { return sendJson(res, 404, { error: e.message }); }
    if (st.isDirectory()) return sendJson(res, 200, { path: real, dir: true });
    const r = safeFilePath(real);
    if (r.error) return sendJson(res, r.status || 404, { error: r.error });
    return sendJson(res, 200, { path: r.file, dir: false, size: r.size, mtime: r.mtime, kind: fileKind(r.file, false) });
  }
  // ── 文件编辑器保存：带上打开时的 mtime，磁盘上的已经被别人（多半是 Claude）改过就拒绝，免得互相覆盖 ──
  if (req.method === "POST" && p === "/api/file/save") {
    const r = safeWritePath(u.searchParams.get("path"));
    if (r.error) return sendJson(res, r.status || 400, { error: r.error });
    const base = Number(u.searchParams.get("mtime") || 0);
    // 先收完请求体再比 mtime：收的过程中磁盘上的文件也可能被改
    const buf = await readBodyBuf(req, 16 * 1024 * 1024);
    let cur = null; try { cur = fs.statSync(r.file); } catch {}
    if (cur && base && Math.abs(cur.mtimeMs - base) > 1 && u.searchParams.get("force") !== "1") {
      return sendJson(res, 409, { error: "changed on disk", mtime: cur.mtimeMs, size: cur.size });
    }
    try { fs.writeFileSync(r.file, buf); } catch (e) { return sendJson(res, 500, { error: e.message }); }
    const st = fs.statSync(r.file);
    log(`[file] 保存 ${r.file} ${buf.length}B`);
    return sendJson(res, 200, { ok: true, path: r.file, size: st.size, mtime: st.mtimeMs });
  }
  // ── 文件面板：新建文件 / 新建文件夹 / 重命名。都不覆盖已有的东西，防呆规则同保存 ──
  if (req.method === "POST" && (p === "/api/file/new" || p === "/api/file/mkdir")) {
    const r = safeWritePath(u.searchParams.get("path"));
    if (r.error) return sendJson(res, r.status || 400, { error: r.error });
    if (!r.fresh) return sendJson(res, 409, { error: "exists" });
    try {
      if (p === "/api/file/mkdir") fs.mkdirSync(r.file);
      else fs.writeFileSync(r.file, "", { flag: "wx" });
    } catch (e) { return sendJson(res, e.code === "EEXIST" ? 409 : 500, { error: e.code === "EEXIST" ? "exists" : e.message }); }
    const st = fs.statSync(r.file);
    log(`[file] 新建${p === "/api/file/mkdir" ? "目录" : ""} ${r.file}`);
    return sendJson(res, 200, { ok: true, path: r.file, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, kind: fileKind(r.file, st.isDirectory()) });
  }
  if (req.method === "POST" && p === "/api/file/rename") {
    const from = String(u.searchParams.get("from") || "");
    const name = String(u.searchParams.get("name") || "").trim();
    if (!path.isAbsolute(from)) return sendJson(res, 400, { error: "absolute path required" });
    if (!name || name === "." || name === ".." || /[\/\0]/.test(name)) return sendJson(res, 400, { error: "bad name" });
    let st; try { st = fs.lstatSync(from); } catch { return sendJson(res, 404, { error: "not found" }); }
    // 源：文件走 safeFilePath；目录借它父目录下的一个虚拟子路径过一遍 safeWritePath 的根目录检查
    const src = st.isDirectory() ? safeWritePath(path.join(from, ".probe-" + Date.now())) : safeFilePath(from);
    if (src.error) return sendJson(res, src.status || 400, { error: src.error });
    if (st.isDirectory()) {      // 也别把装着应用私有目录的上级挪走
      let rf; try { rf = fs.realpathSync(from); } catch { rf = from; }
      for (const root of [CFG.home, CFG.runtime]) {
        let rr; try { rr = fs.realpathSync(root); } catch { rr = root; }
        if (rr && rr.startsWith(rf + path.sep)) return sendJson(res, 403, { error: "forbidden" });
      }
    }
    const dst = safeWritePath(path.join(path.dirname(from), name));
    if (dst.error) return sendJson(res, dst.status || 400, { error: dst.error });
    if (!dst.fresh) return sendJson(res, 409, { error: "exists" });
    try { fs.renameSync(from, dst.file); } catch (e) { return sendJson(res, 500, { error: e.message }); }
    log(`[file] 重命名 ${from} → ${dst.file}`);
    return sendJson(res, 200, { ok: true, path: dst.file, kind: fileKind(dst.file, st.isDirectory()) });
  }
  // ── 把界面拿到的东西落盘（粘贴 / 拖放 / 选择文件共用）──
  if (req.method === "POST" && p === "/api/upload") {
    const rawName = u.searchParams.get("name") || "";
    const safe = path.basename(rawName)
      .replace(/[^\w.\-()一-鿿]+/g, "_")   // 空格也换成 _：路径带空格在提示词里很难引用
      .replace(/^[.\s]+/, "")
      .slice(0, 120);
    const buf = await readBodyBuf(req);
    if (!buf.length) return sendJson(res, 400, { error: "empty body" });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    // 同一秒同名的（一次附加两个同名文件）别互相覆盖：撞了就加 -2、-3
    const nm = safe || "upload.bin", dot = nm.lastIndexOf("."), stem = dot > 0 ? nm.slice(0, dot) : nm, ext = dot > 0 ? nm.slice(dot) : "";
    let out = "";
    for (let i = 1; i < 1000 && !out; i++) {
      const cand = path.join(UPLOAD_DIR, `${stamp}-${i === 1 ? nm : stem + "-" + i + ext}`);
      try { fs.writeFileSync(cand, buf, { flag: "wx" }); out = cand; }
      catch (e) { if (e.code !== "EEXIST") return sendJson(res, 500, { error: e.message }); }
    }
    if (!out) return sendJson(res, 500, { error: "name taken" });
    const kind = fileKind(out, false);
    log(`[upload] ${safe || "upload.bin"} ${buf.length}B → ${out}`);
    return sendJson(res, 200, {
      ok: true, path: out, name: path.basename(out),
      size: buf.length, mime: mimeOf(out), kind,
    });
  }
  // ── 截屏给 Claude：经 priv 以 shell 身份 screencap，存进 uploads 当附件。delay 秒后再截（先切到要截的应用），截完叫回前台 ──
  if (req.method === "POST" && p === "/api/screenshot") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const delay = Math.max(0, Math.min(30, Number(b.delay) || 0));
    if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
    let png;
    try { png = await screencap(); } catch (e) { return sendJson(res, 500, { ok: false, message: e.message }); }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const out = path.join(UPLOAD_DIR, `${stamp}-screen.png`);
    fs.writeFileSync(out, png);
    log(`[screenshot] ${png.length}B → ${out}`);
    if (delay) toFront(tz("截好了")).catch(() => {});
    return sendJson(res, 200, { ok: true, path: out, name: path.basename(out), size: png.length, mime: "image/png", kind: "image" });
  }
  // ── 目录浏览（@ 引用文件 + 文件面板共用）──
  if (req.method === "GET" && p === "/api/files") {
    const dir = u.searchParams.get("path") || CFG.workspace;
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const showHidden = u.searchParams.get("hidden") === "1";
    const out = { path: dir, parent: path.dirname(dir), entries: [], roots: fileRoots() };
    try {
      const real = fs.realpathSync(dir);
      out.path = real;
      if (real !== dir) out.parent = path.dirname(real);
      const items = fs.readdirSync(real, { withFileTypes: true });
      for (const it of items) {
        if (!showHidden && it.name.startsWith(".")) continue;
        if (q && !it.name.toLowerCase().includes(q)) continue;
        const isDir = it.isDirectory();
        let size = 0, mtime = 0;
        try { const st = fs.statSync(path.join(real, it.name)); size = isDir ? 0 : st.size; mtime = st.mtimeMs; } catch {}
        out.entries.push({ name: it.name, dir: isDir, size, mtime, kind: fileKind(it.name, isDir) });
        if (out.entries.length >= 1000) break;
      }
      out.entries.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        if (a.dir) return a.name.localeCompare(b.name);
        if (a.kind === "image" && b.kind !== "image") return -1;
        if (b.kind === "image" && a.kind !== "image") return 1;
        return b.mtime - a.mtime || a.name.localeCompare(b.name);
      });
    } catch (e) { out.error = e.message; }
    return sendJson(res, 200, out);
  }
  return NEXT;
}
