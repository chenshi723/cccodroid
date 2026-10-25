#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
#  release-test.sh —— 把 dist/cccodroid-test.apk 和 cccodroid-test-36.apk 发成预发布 test-v<版本>（主仓库 greyoak111/cccodroid）
#
#  预发布不会变成 GitHub 的 Latest；正式版的更新检查只认 v* 标签，cccodroid.net 也只镜像 v*，所以测试版不会混进去。
#  测试版自己的更新检查只认 test-v* 里的 cccodroid-test.apk（见 mktest.mjs）。
#  要 gh 已登录（开发端有）。用法：先 sh scripts/build-test.sh，再 sh scripts/release-test.sh
# ─────────────────────────────────────────────────────────────────────
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APK="$ROOT/dist/cccodroid-test.apk"
APK36="$ROOT/dist/cccodroid-test-36.apk"
[ -s "$APK" ] && [ -s "$APK36" ] || { echo "✗ 没有 $APK 或 $APK36，先跑 build-test.sh"; exit 1; }
VER=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$ROOT/android/AndroidManifest.xml")
TAG="test-v$VER"
COMMIT=$(git -C "$ROOT" rev-parse HEAD)
git -C "$ROOT" fetch -q origin 2>/dev/null || true
git -C "$ROOT" branch -r --contains "$COMMIT" | grep -q . || { echo "✗ 提交 $COMMIT 还没推到 GitHub，先 git push"; exit 1; }
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
SHA36=$(sha256sum "$APK36" | cut -d' ' -f1)
N="$ROOT/dist/test-notes.md"
cat > "$N" <<EOF
**测试版，不是正式版。** 包名 \`cc.codtest\`、签名和正式版不同，可以和 cccodroid 同时装，互不影响。

用途：像开发者那样「双应用测试」——在正式版 cccodroid 里让 Claude 测这个测试版。
- **网页调试（CDP）默认开**：正式版里的 Claude 可以连进测试版的页面，看界面、点按钮、跑脚本。代价是连上 adb 的电脑也能读它的页面（包括网关令牌），所以别在测试版里放重要的密钥和资料。
- 网关端口 8792（正式版 8791），工具包单独一份（\`testkit-*\`，首次打开先勾模块，默认约 350 MB）。
- 不能装组件市场的组件。
- 只会更新到新的测试版，不会被推去装正式版。
- 联想平板首次安装后如果提示「不支持分屏」，是系统把它误记进了分屏黑名单：重启一次，或再覆盖安装一遍就好。

两套包和正式版一样：一般装 \`cccodroid-test.apk\`，系统不让装时换 \`cccodroid-test-36.apk\`。

对应正式版 v$VER 的代码。
- \`cccodroid-test.apk\` sha256：\`$SHA\`
- \`cccodroid-test-36.apk\`（targetSdk 36）sha256：\`$SHA36\`

---

## English

**A test build, not a release.** Package \`cc.codtest\` with a different signature, so it installs next to cccodroid without touching it.

It's for two-app testing the way the developers do it: have Claude in your regular cccodroid test this build.
- **Web debugging (CDP) is on by default**, so Claude in the regular app can connect to this build's page, inspect the UI, tap buttons and run scripts. The cost is that a computer connected over adb can also read its page (gateway token included), so keep important keys and data out of the test build.
- Gateway port 8792 (the regular app uses 8791) and its own toolchain (\`testkit-*\`; on first launch you pick modules, about 350 MB by default).
- Components from the component market can't be installed.
- It only updates to newer test builds, never to the regular app.
- On Lenovo tablets, if a fresh install says it "doesn’t support split screen", the system has wrongly put it on its split-screen blocklist. Reboot once, or install the same APK over it again.

Two APKs, as with the regular app: install \`cccodroid-test.apk\`, or \`cccodroid-test-36.apk\` if Android refuses it.

Same code as release v$VER.
- \`cccodroid-test.apk\` sha256: \`$SHA\`
- \`cccodroid-test-36.apk\` (targetSdk 36) sha256: \`$SHA36\`
EOF
mkdir -p "$ROOT/dist/test-upload"; cp "$APK" "$ROOT/dist/test-upload/cccodroid-test.apk"; cp "$APK36" "$ROOT/dist/test-upload/cccodroid-test-36.apk"
gh release create "$TAG" -R greyoak111/cccodroid --prerelease --target "$COMMIT" --title "$TAG（测试版 / test build）" \
  --notes-file "$N" "$ROOT/dist/test-upload/cccodroid-test.apk" "$ROOT/dist/test-upload/cccodroid-test-36.apk"
rm -rf "$ROOT/dist/test-upload"
echo "✓ https://github.com/greyoak111/cccodroid/releases/tag/$TAG"
