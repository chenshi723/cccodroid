// worker 入口：先补旧 WebView 缺的 API，再加载真正的 worker
import "./compat.mjs";
export * from "./pdf.worker.min.mjs";
