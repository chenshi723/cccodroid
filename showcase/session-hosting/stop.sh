#!/bin/sh
# 停止演示服务：优先走 shutdown 接口；找不到就按工作目录定位进程
if curl -s -m 2 -X POST http://127.0.0.1:17800/api/demo/shutdown >/dev/null 2>&1; then
  sleep 1
fi
for p in $(pgrep node 2>/dev/null); do
  if [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "/data/data/cc.fork.v4/files/home/workspace/hosting-demo" ]; then
    kill "$p" 2>/dev/null
  fi
done
sleep 1
echo stopped