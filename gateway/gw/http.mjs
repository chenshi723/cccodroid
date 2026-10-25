import fs from "node:fs";
import path from "node:path";
import { PATHS, log, reqLang, tr } from "./config.mjs";

// ── HTTP ──────────────────────────────────────────────────────────────
export const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff": "font/woff", ".woff2": "font/woff2",
  // 读图 / 读文件要用的类型
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".log": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
  ".apk": "application/vnd.android.package-archive", ".zip": "application/zip",
  ".wasm": "application/wasm",
  // HTML 预览里网页会引用的
  ".htm": "text/html; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".ttf": "font/ttf", ".otf": "font/otf", ".gltf": "model/gltf+json", ".glb": "model/gltf-binary",
};

const EXT_KIND = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".heic"],
  video: [".mp4", ".webm", ".mkv", ".mov", ".3gp"],
  audio: [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".opus"],
  // Office：docx、表格在前端渲染；其余交给 LibreOffice 转 PDF
  docx:  [".docx", ".docm", ".dotx"],
  sheet: [".xlsx", ".xlsm", ".xlsb", ".xls", ".ods"],
  office: [".pptx", ".ppt", ".ppsx", ".pps", ".potx", ".odp", ".doc", ".dot", ".odt", ".rtf", ".wps", ".dps", ".et", ".key", ".pages", ".numbers"],
  text:  [".txt", ".md", ".log", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".js", ".mjs",
          ".css", ".c", ".h", ".cpp", ".py", ".sh", ".java", ".kt", ".rs", ".go", ".ts", ".sql",
          ".toml", ".ini", ".conf", ".cfg", ".properties", ".gradle", ".kts", ".tsx", ".jsx", ".cjs",
          ".vue", ".svelte", ".scss", ".less", ".hpp", ".cc", ".cxx", ".rb", ".php", ".lua", ".pl",
          ".swift", ".dart", ".cs", ".zig", ".r", ".tex", ".typ", ".gd", ".tscn", ".tres", ".diff",
          ".patch", ".bash", ".zsh", ".fish", ".bat", ".ps1", ".rst", ".org", ".tsv", ".jsonl", ".svg"],
};
const KIND_OF = new Map();
for (const [k, list] of Object.entries(EXT_KIND)) for (const e of list) KIND_OF.set(e, k);

export function fileKind(name, isDir) {
  if (isDir) return "dir";
  const e = path.extname(name).toLowerCase();
  if (e === ".pdf") return "pdf";
  return KIND_OF.get(e) || "other";
}
export const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || "application/octet-stream";

/** 二进制安全的体读取（readBody 走 utf8，会把图片读坏） */
export function readBodyBuf(req, max = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > max) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── HTTP 小工具：回 JSON、静态文件、读请求体 ───────────────────────────
export function uiTag() {
  let t = 0;
  let files = [];
  try { files = fs.readdirSync(PATHS.web); } catch {}
  files = files.concat(appParts().map((f) => "app/" + f));   // app.js 的分段改了也算
  for (const f of files) {
    try { t = Math.max(t, fs.statSync(path.join(PATHS.web, f)).mtimeMs); } catch {}
  }
  return Math.round(t);
}

// app.js 的源码按功能拆在 web/app/ 下（文件名带序号），这里按文件名顺序原样拼成一个文件下发：
// 浏览器拿到的仍是同一个闭包，和拆之前逐字节相同。报错里的 app.js 行号用 node scripts/appjs.mjs --line N 对回分段
export function appParts() {
  try { return fs.readdirSync(path.join(PATHS.web, "app")).filter((f) => f.endsWith(".js")).sort(); } catch { return []; }
}
let appCache = { key: "", data: null };
export function appJs() {
  const dir = path.join(PATHS.web, "app"), parts = appParts();
  if (!parts.length) return null;
  const st = parts.map((f) => fs.statSync(path.join(dir, f)));
  const key = parts.map((f, i) => `${f}:${st[i].mtimeMs}:${st[i].size}`).join("|");
  if (appCache.key !== key) appCache = { key, data: Buffer.concat(parts.map((f) => fs.readFileSync(path.join(dir, f)))) };
  return appCache.data;
}

export function sendJson(res, code, obj) {
  if (obj && typeof obj.message === "string" && res.req) obj = { ...obj, message: tr(reqLang(res.req), obj.message) };
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length });
  res.end(b);
}

// 界面自己的静态文件：不许别的站点把它套进 frame（界面内部的 iframe 同源，不受影响），不让浏览器猜类型
const STATIC_SAFE = { "x-content-type-options": "nosniff", "content-security-policy": "frame-ancestors 'self'" };
export function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = rel.replace(/^\/+/, "");
  if (rel.includes("..")) return sendJson(res, 403, { error: "forbidden" });
  if (rel === "app.js") {
    const data = appJs();
    if (data) {
      res.writeHead(200, { "content-type": MIME[".js"], "content-length": data.length, "cache-control": "no-store", ...STATIC_SAFE });
      return res.end(data);
    }
  }
  const full = path.join(PATHS.web, rel);
  if (!full.startsWith(PATHS.web) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    log(`404 ${rel}`);
    return sendJson(res, 404, { error: "not found", path: rel });
  }
  const data = fs.readFileSync(full);
  res.writeHead(200, {
    "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
    "content-length": data.length,
    "cache-control": "no-store",
    ...STATIC_SAFE,
  });
  res.end(data);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 16 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 路由函数没认领这个请求时返回它，交给下一个
export const NEXT = Symbol("next");
