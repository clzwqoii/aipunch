#!/bin/bash
# AIPunch 一键发版脚本：本地同步版本号并构建校验，推 tag 后由 GitHub Actions 发布（仅 arm64）
# 用法：npm run release 0.1.0 [-- --dry-run]
set -euo pipefail

cd "$(dirname "$0")/.."

RAW_VERSION="${1:-}"
DRY_RUN=0
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=1

if [[ -z "$RAW_VERSION" ]]; then
  echo "用法: npm run release <版本号 如 0.1.0> [-- --dry-run]" >&2
  exit 1
fi

VERSION="${RAW_VERSION#v}"
TAG="v$VERSION"
GH_REPO="clzwqoii/aipunch"

# 版本号会注入 node -e / sed 与 tag 名，先做格式校验
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "错误：版本号必须是 x.y.z（可带 -beta.1 后缀），收到 $RAW_VERSION" >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "错误：请在 main 分支发版（当前分支 $BRANCH）" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "错误：tag $TAG 已存在，已发布的版本不允许覆盖，请换新版本号" >&2
  exit 1
fi

step() { echo; echo "=== $* ==="; }

step "1/4 同步更新版本号为 $VERSION"
# 更新根目录 package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 更新 shell/package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('shell/package.json', 'utf8'));
pkg.version = '$VERSION';
fs.writeFileSync('shell/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 更新 tauri.conf.json
node -e "
const fs = require('fs');
const conf = JSON.parse(fs.readFileSync('shell/src-tauri/tauri.conf.json', 'utf8'));
conf.version = '$VERSION';
fs.writeFileSync('shell/src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n');
"

# 更新 Cargo.toml（bundle 版本以 tauri.conf.json 为准，这里只保持 crate 版本一致）
node -e "
const fs = require('fs');
const p = 'shell/src-tauri/Cargo.toml';
const src = fs.readFileSync(p, 'utf8');
fs.writeFileSync(p, src.replace(/^version = \"[^\"]+\"/m, 'version = \"$VERSION\"'));
"

# 更新前端界面显示的默认版本标签
sed -i '' -E "s/id=\"app-version-label\">v[^<]+/id=\"app-version-label\">v$VERSION/" shell/index.html

echo "版本号已同步到 package.json, shell/package.json, tauri.conf.json, Cargo.toml, index.html"

step "2/4 本地构建校验（签名打包）"
KEY_FILE="shell/src-tauri/aipunch-updater.key"
if [[ -f "$KEY_FILE" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
fi

npm --prefix shell run tauri build

BUNDLE_DIR="shell/src-tauri/target/release/bundle"
DMG_FILE=$(find "$BUNDLE_DIR/dmg" -name "*.dmg" -maxdepth 1 2>/dev/null | head -n 1 || true)

if [[ -z "$DMG_FILE" || ! -f "$DMG_FILE" ]]; then
  echo "错误：未找到构建出的 DMG 安装包！" >&2
  exit 1
fi

echo "本地构建产物: $DMG_FILE"

if [[ $DRY_RUN == 1 ]]; then
  step "dry-run 结束：仅本地构建验证，未推送 Git 和创建 GitHub Release"
  exit 0
fi

step "3/4 提交并推送 tag（发布由 CI 完成）"
FILES=(package.json shell/package.json shell/src-tauri/tauri.conf.json shell/index.html shell/src-tauri/Cargo.toml)
if [[ -f shell/src-tauri/Cargo.lock ]]; then
  FILES+=(shell/src-tauri/Cargo.lock)
fi
git add "${FILES[@]}"
if git diff --cached --quiet; then
  echo "版本号已是最新，跳过提交"
else
  # 提交失败（如 hook 拒绝）必须中止：否则 tag 会打在不含版本号的提交上，CI 版本校验才报错
  git commit -m "release: $TAG"
fi
git tag "$TAG"
git push origin main
git push origin "$TAG"

step "4/4 已推送 tag，等待 Actions 发布"
echo "发布流程: https://github.com/$GH_REPO/actions/workflows/release.yml"
echo "发布页面: https://github.com/$GH_REPO/releases/tag/$TAG"
