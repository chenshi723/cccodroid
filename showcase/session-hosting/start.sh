#!/bin/sh
# 启动会话托管真实演示（生产代码 + 本地回环中转 + 脚本模型）
cd "$(dirname "$0")" || exit 1
if curl -s -m 1 http://127.0.0.1:17800/api/demo/status >/dev/null 2>&1; then
  echo "演示已在运行：http://127.0.0.1:17800/"
  exit 0
fi
nohup node server.mjs > server.log 2>&1 &
i=0
while [ $i -lt 60 ]; do
  grep -q "DEMO READY" server.log 2>/dev/null && break
  i=$((i + 1)); sleep 0.5
done
if grep "DEMO READY" server.log; then
  echo "演示页：http://127.0.0.1:17800/"
else
  echo "启动失败：" >&2; cat server.log >&2; exit 1
fi