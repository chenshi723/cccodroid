# 会话托管 · 真实演示（hosting-demo）

用**真实生产代码**跑通「会话托管」全链路并可视化：真实前端、真实托管引擎/适配器/加密、真实排队/授权/事件总线、真实 Python 中转；唯一模拟的是**模型执行**（脚本剧本）与**公网**（回环中转）。

- 说明书网页（图文并茂 + 内嵌可交互演示）：`hub/index.html`
- Markdown 说明书：`MANUAL.md`
- 配图：`hub/assets/`（无头 Chromium 驱动真实前端截取）

## 本机运行（cccodroid / Android）

```sh
sh start.sh          # 启动，打印 http://127.0.0.1:17800/
sh stop.sh           # 停止
```

打开 `http://127.0.0.1:17800/`：上半是说明书，§11 是两块真实界面（左平板主机、右手机控制端）+ 中转密文视角 + 一键操作按钮。

端口：hub=17800、tablet=17801、phone=17802（被占用自动 +3 扫描）；中转回环端口随机。

## 重新截图

```sh
sh stop.sh && sh start.sh && node capture.mjs
```

`capture.mjs` 用无头 Chromium 走完整流程（建立主机→托管→配对→发送→授权卡→选择题→计划卡→停止→继续→侧栏），输出到 `shots/` 并复制到 `hub/assets/`。需要 playwright-core 与 chromium（本机复用 `../session-hosting/remote-list/.tools`）。

## 全链路自检

```sh
node test-chain.mjs   # 通过真实 HTTP 接口验证 10 项：隔离/历史/授权/增量/落盘/停止/撤销/密文
```

## 上游 / 其它 Linux 机器运行（可移植）

演示不依赖 Android。指向你自己的应用根（含 `gw/`、`web/`）与 relay 即可：

```sh
pip install aiohttp                      # 或 python3 -m venv relay/.venv && relay/.venv/bin/pip install -r relay/requirements.txt
HOSTING_DEMO_APP=/path/to/app \
HOSTING_DEMO_RELAY=/path/to/relay \
HOSTING_DEMO_PYTHON=python3 \
node server.mjs
```

- `HOSTING_DEMO_APP`：应用根，需有 `gw/`（含 hosting/）与 `web/`（含 app/、hosting/、index.html）。
- `HOSTING_DEMO_RELAY`：relay 目录（本包已附 `relay/server.py` 等）；默认回落到 `../session-hosting/relay`。
- `HOSTING_DEMO_PYTHON`：解释器；默认找 relay/.venv，否则 python3。

`server.mjs` 会把 `gw/` 复制到一次性目录、仅把 `startRun` 换成 `src/demo-driver.mjs`（脚本模型），其余模块原样加载；隔离 HOME，不碰真实数据。

## 目录

```
server.mjs          编排：隔离环境 + 一次性 gw 副本 + 真实 relay + 双设备 HTTP + 中控 API + 密文视角
src/demo-driver.mjs 脚本模型（替换 startRun）+ 演示会话种子
hub/index.html      说明书网页 + 内嵌演示
hub/assets/         配图
relay/              中转源码（可移植副本）
capture.mjs         截图脚本
test-chain.mjs      全链路自检
MANUAL.md           Markdown 说明书
start.sh / stop.sh  启停
```

## 安全

一次性 gw 副本 + 隔离 HOME（`demo-home/`、`demo-workspace/`，每次启动清空）；不读真实配对、不联系线上中转、不自动安装 APK、不修改已安装应用。演示令牌仅本机回环有效。