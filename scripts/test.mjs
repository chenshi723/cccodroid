#!/usr/bin/env node
// 网关测试：node scripts/test.mjs [文件名片段 …]
//
// 每次在一个新建的临时目录里跑：CCAPP_HOME / HOME 指过去，假 $PREFIX 里只放一个指向系统 curl 的 bin/curl，
// CCAPP_TEST=1 让网关模块导入时不做任何启动动作（见 gw/config.mjs 的 LIVE）。所以在开发机上跑也碰不到真数据。
// 临时目录要能建软链：安卓上别放 /sdcard（没设 TMPDIR 时自动用 ~/.cache）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "gateway", "tests");
const want = process.argv.slice(2);
const files = fs.readdirSync(TESTS).filter((f) => f.endsWith(".test.mjs") && (!want.length || want.some((w) => f.includes(w)))).sort();
if (!files.length) { console.error("没有匹配的测试文件"); process.exit(1); }

const curl = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
if (!curl) { console.error("找不到 curl"); process.exit(1); }

// 安卓上 /tmp 应用写不进：没设 TMPDIR 又写不进系统临时目录时，用 ~/.cache
const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
const base = process.env.TMPDIR || (writable(os.tmpdir()) ? os.tmpdir() : path.join(os.homedir(), ".cache"));
fs.mkdirSync(base, { recursive: true });
const tmp = fs.mkdtempSync(path.join(base, "cccodroid-test-"));
const home = path.join(tmp, "home"), prefix = path.join(tmp, "usr");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
fs.symlinkSync(curl, path.join(prefix, "bin", "curl"));

const env = { ...process.env, CCAPP_TEST: "1", CCAPP_HOME: home, HOME: home, CCAPP_PREFIX: prefix, CCAPP_PORT: "8799", CCAPP_LOG: path.join(tmp, "gateway.log"), CCAPP_TMP: tmp };
for (const k of ["CCAPP_SHARED", "CCAPP_TOKEN_FILE", "CCAPP_COMPONENTS_INDEX", "CCAPP_COMPONENTS_COMMUNITY_INDEX"]) delete env[k];

const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.map((f) => path.join(TESTS, f))], { env, stdio: "inherit", cwd: ROOT });
if (!process.env.KEEP_TEST_TMP) fs.rmSync(tmp, { recursive: true, force: true });
else console.log("临时目录留着：" + tmp);
process.exit(r.status ?? 1);
