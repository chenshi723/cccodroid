// 网关访问控制（gw/access.mjs）：令牌、Host、Origin。端口由 scripts/test.mjs 固定为 8799
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COOKIE, TOKEN, denyReason, tokenOk } from "../gw/access.mjs";

const req = (headers) => ({ headers });
const url = (p) => new URL("http://127.0.0.1:8799" + p);
const HOST = "127.0.0.1:8799";

test("令牌：生成在 CCAPP_HOME 里，64 位十六进制、文件只有自己能读", () => {
  assert.match(TOKEN, /^[0-9a-f]{64}$/);
  const f = path.join(process.env.CCAPP_HOME, ".gateway-token");
  assert.equal(fs.readFileSync(f, "utf8").trim(), TOKEN);
  assert.equal(fs.statSync(f).mode & 0o077, 0);
});

test("tokenOk：对的放行，错的、空的、非字符串都不放", () => {
  assert.equal(tokenOk(TOKEN), true);
  assert.equal(tokenOk(TOKEN.replace(/.$/, (c) => (c === "0" ? "1" : "0"))), false);
  assert.equal(tokenOk(""), false);
  assert.equal(tokenOk(undefined), false);
  assert.equal(tokenOk(123), false);
});

test("tokenOk：字符数相同、字节数不同的非 ASCII 输入不会抛错", () => {
  assert.doesNotThrow(() => tokenOk("é".repeat(64)));
  assert.equal(tokenOk("é".repeat(64)), false);
  assert.equal(tokenOk("é".repeat(32)), false);
});

test("Host 不对：421", () => {
  assert.equal(denyReason(req({ host: "evil.example" }), url("/")), 421);
  assert.equal(denyReason(req({ host: "127.0.0.1:1234" }), url("/")), 421);
  assert.equal(denyReason(req({}), url("/")), 421);
});

test("Origin 不对：403（没有 Origin 的同源请求不拦）", () => {
  assert.equal(denyReason(req({ host: HOST, origin: "http://evil.example" }), url("/")), 403);
  assert.equal(denyReason(req({ host: HOST, origin: "null" }), url("/")), 403);
  assert.equal(denyReason(req({ host: HOST, origin: "http://127.0.0.1:8799" }), url("/")), null);
  assert.equal(denyReason(req({ host: "LOCALHOST:8799" }), url("/")), null);
});

test("静态页不要令牌，/api/ 要", () => {
  assert.equal(denyReason(req({ host: HOST }), url("/index.html")), null);
  assert.equal(denyReason(req({ host: HOST }), url("/api/state")), 403);
});

test("/api/ 认请求头 X-CC-Token 或带端口的 Cookie", () => {
  assert.equal(denyReason(req({ host: HOST, "x-cc-token": TOKEN }), url("/api/state")), null);
  assert.equal(denyReason(req({ host: HOST, cookie: `a=1; ${COOKIE}=${TOKEN}` }), url("/api/state")), null);
  assert.equal(denyReason(req({ host: HOST, cookie: `cc_t_8790=${TOKEN}` }), url("/api/state")), 403);   // 别的端口的 Cookie
  assert.equal(denyReason(req({ host: HOST, "x-cc-token": "x".repeat(64) }), url("/api/state")), 403);
});
