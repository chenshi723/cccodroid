# cc-host/v1 独立密文中转

此目录只负责中转，不包含平板文件操作、终端执行、会话解密或 APK 代码。客户端与主机网关负责 AES-256-GCM 与授权校验。

## 接入

`server.py` 导出 `create_app(config)`，`config` 可为 `Config` 或对应字段的 dict。适配 Python 3.12+，依赖固定为 aiohttp 3.14.5。生产入口读取以下环境变量：

| 变量 | 用途 |
|---|---|
| `CC_HOST_ENROLL_TOKEN` | `secrets.token_urlsafe(32)` 生成的 43 字符 token，仅建房间使用 |
| `CC_HOST_STATE` | 状态文件绝对路径，默认 `/var/lib/cc-host-relay/rooms.json` |
| `CC_HOST_BIND` | 默认 `127.0.0.1`，不要暴露到公网 |
| `CC_HOST_PORT` | 默认 `7865` |

HTTP 路径全部保留 `/cc-host/v1` 前缀。方法、形状及角色遵循 `/data/user/0/cc.fork.v4/files/home/workspace/session-hosting/PROTOCOL.md`。健康接口 `/cc-host/v1/health` 不鉴权，其余只接受 `Authorization: Bearer ...`。拒绝任何 Origin 或查询串，不提供 CORS、重定向或匿名建房间。

为防止误用，还拒绝非 UTF-8 JSON、重复 JSON 键、非 base64url packet、额外 packet 字段和压缩请求体。主机回复尚未被 poll 取出的请求返回 409。poll 每次最多取 4 条，空 poll 最长 20 秒，RPC 最长 25 秒。

## 存储和资源边界

- 持久状态只有房间 ID、hostToken/clientToken 的 SHA-256；不存 token 原文、secret、packet、明文会话。
- 新增/吊销先原子写盘（临时文件 + 文件 fsync + rename + 父目录 fsync），成功才返回；文件 mode 0600。损坏状态拒绝启动，不悄悄创建一个新服务。
- 最多 32 房间、16 个未完成 RPC/房间、全局 64 个，另有全局 48 MiB 在途 packet 上限；超限返回 429。
- JSON 最大 4 MiB，packet 字符串最大 3 MiB；请求体最多读 10 秒。
- 不记录访问日志、认证头、body、配对码；异常日志只有固定短句。
- 客户端断开，待答 RPC 和排队 id 都会清理；主机断开，poll 名额立即释放。已经交给主机的请求不会重新投递，25 秒后超时。重试是否执行由主机的持久幂等账本决定，服务端不冒充“恰好执行一次”。
- 吊销房间取消排队和等候，重启只恢复房间凭据，不恢复 RPC 密文。
- 生产只运行 **一个进程**；状态和未完成请求不能被多个 worker 共享。不要启动多个同状态路径的实例。
- 这是个人私有服务，不是公开多租户入口。没有 enrollment token 的请求不能建房；token 泄露时应轮换并吊销受影响房间。

## 部署模板（本目录未执行部署）

1. 单独服务用户 `cc-host-relay`，将源码放 `/opt/cc-host-relay`；root 拥有源码，服务用户不可写。
2. Ubuntu 安装 `python3-venv`，用 `/opt/cc-host-relay/venv` 建独立环境并从 requirements 安装。不复用 workbuddy 的 venv。
3. 依据示例创建 `/etc/cc-host-relay.env`，root 拥有、0600。生成强随机 enrollment token，不能把占位符当真实配置；token 不放命令行或仓库。
4. 安装 `/etc/systemd/system/cc-host-relay.service`；模板以非 root 身份运行，`StateDirectory` 自动创建私有状态目录，内存上限 256 MiB。启用前先检查模板路径与依赖是否正确。
5. 验证本机 `http://127.0.0.1:7865/cc-host/v1/health` 返回 `{"ok":true,"protocol":1}`。
6. 将 `caddy-route.json` 的路由对象插入现有 HTTPS server routes 的 workbuddy catch-all **前面**。这是一个路由对象，**不能覆盖整个 Caddy 配置**；保持原有 TLS/IP 证书、80 跳转与 workbuddy 路由。代理 read timeout 必须大于 25 秒，模板用 35 秒。
7. 先备份配置并运行 Caddy validate，成功再重载。不要新开公网 7865，不修改其他服务端口或认证。
8. HTTPS 接口成功后才能把地址与 enrollment token 交给主机配置。配对码由主机生成；中转服务从来不知道端到端 secret。

Caddy 模板的 Host 为当前服务器 `117.72.43.36`；迁移时改成真实 Host。Caddy 不要对本路径启用含请求头或正文的日志。测试日志也不应打印 token。

## 本机验证

执行命令：

```sh
/data/user/0/cc.fork.v4/files/home/workspace/session-hosting/relay/.venv/bin/python -W error::ResourceWarning -m unittest discover -s /data/user/0/cc.fork.v4/files/home/workspace/session-hosting/relay -v
```

测试使用随机回环端口和独立临时状态目录，不连外网、不操作真实会话。覆盖：凭据角色与跨房间隔离、正常不透明密文往返、poll 唤醒/FIFO/四条批次、重复 ID、请求/主机断线、超时、删除时唤醒、上传途中吊销、限量/内存上限、超大及 chunked 请求、无重定向/无 query auth、非法输入、压缩 body、持久化失败与损坏文件拒绝启动、文件权限、重启恢复、关闭清理。

额外 Node fetch 互通检查：

```sh
/data/user/0/cc.fork.v4/files/home/workspace/session-hosting/relay/.venv/bin/python /data/user/0/cc.fork.v4/files/home/workspace/session-hosting/relay/check_node.py
```

该脚本临时启动服务、用 Node fetch 完成建房→RPC→poll→reply→撤销的闭环，不向输出打印 token。

当前实测：37 项全部通过（包括全局 64 个同时在途请求及释放后继续使用），启用 `-W error::ResourceWarning`，未发现资源警告；Node fetch 互通检查通过。两个 `Relay request failed` 日志来自刻意注入的持久化失败测试。`pip check` 无依赖冲突，所有 Python 文件通过 Python 3.12 语法兼容检查，Caddy 模板通过 JSON 语法检查。

实测平台：Android aarch64、Python 3.14.8、aiohttp 3.14.5。Python 3.12 是目标兼容版本，未在本环境实跑；服务器 TLS/Caddy/systemd、两台实际设备的组合链路也不在这份本地测试覆盖范围。部署者需如实区分。
