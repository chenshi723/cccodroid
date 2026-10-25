// 旧 WebView（Chrome 104 一类）缺的内置 API。legacy 版 pdf.js 自带的 core-js 没补齐这些，
// 主线程和 worker 都要在 pdf.js 之前加载本文件。只在缺的时候补。
const def = (o, k, v) => { if (!(k in o)) Object.defineProperty(o, k, { value: v, writable: true, configurable: true }); };
def(Promise, "withResolvers", function () {
  let resolve, reject;
  const promise = new this((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
});
def(Promise, "try", function (fn, ...args) { return new this((r) => r(fn(...args))); });
const AP = Array.prototype;
def(AP, "toSorted", function (cmp) { return AP.slice.call(this).sort(cmp); });
def(AP, "toReversed", function () { return AP.slice.call(this).reverse(); });
def(AP, "toSpliced", function (...a) { const c = AP.slice.call(this); c.splice(...a); return c; });
def(AP, "with", function (i, v) { const c = AP.slice.call(this); c[i < 0 ? c.length + i : i] = v; return c; });
def(AP, "findLast", function (f, t) { for (let i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return this[i]; });
def(AP, "findLastIndex", function (f, t) { for (let i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return i; return -1; });
def(Object, "groupBy", (items, f) => { const o = Object.create(null); let i = 0; for (const x of items) (o[f(x, i++)] ||= []).push(x); return o; });
def(Map, "groupBy", (items, f) => { const m = new Map(); let i = 0; for (const x of items) { const k = f(x, i++); m.has(k) ? m.get(k).push(x) : m.set(k, [x]); } return m; });
def(Object, "hasOwn", (o, k) => Object.prototype.hasOwnProperty.call(o, k));
if (typeof URL !== "undefined") {
  def(URL, "parse", (u, b) => { try { return new URL(u, b); } catch { return null; } });
  def(URL, "canParse", (u, b) => { try { new URL(u, b); return true; } catch { return false; } });
}
