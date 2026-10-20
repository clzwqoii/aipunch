# AIPunch 桌面外壳 v1 开发交接文档 (Handoff)

**项目地址**: [clzwqoii/aipunch](https://github.com/clzwqoii/aipunch)  
**当前状态**: 公开开源 (Public) · 145 项核心测试通过 · 7 项 Rust 单元测试通过 · 前端构建正常 (90ms)  
**文档生成时间**: 2026-10-20  

---

## 1. 核心架构与设计决策

- **定位 (ADR 0001)**: Tauri 2.12 桌面外壳仅作为轻量包装 (Thin Shell)，所有签到业务逻辑、凭据轮换、校验全部留在 TypeScript 核心 (`core/`, `providers/`, `runners/`)，避免维护双份实现。
- **目录划分**:
  - `shell/`: 独立桌面外壳，Vite 5 + TypeScript + 原生 CSS (磨砂 Bento 方案 A)。
  - `shell/src-tauri/`: Rust 桥接层与 Tauri 核心 (窗口管理、原生动画、自动更新、环境变量安全读写)。
  - `tool/release.sh`: 本地一键打包发版脚本 (完全对标 `Sites/stock` 的极简哲学)。
  - `.github/workflows/`: `checkin.yml` (日常定时签到) + `release.yml` (云端 Actions 构建兜底)。

---

## 2. 本阶段完成的重大进展

### A. 桌面外壳交互与窗口体验深度修复
1. **窗口自由拖拽与区域击穿修复**:
   - 彻底排查 Tauri 2 原生拖拽机制，在 `default.json` 显式开启 `core:window:allow-start-dragging` 权限。
   - 移除 WebKit 私有 `-webkit-app-region` 冲突样式，全量统一使用 `data-tauri-drag-region="deep"`。
   - 在主工作区顶部增加物理拖拽条 `.main-top-drag-bar`，顶栏浮层提升至 `z-index: 90`（避让 76px 原生交通灯）。
   - 在 `main.ts` 中通过 `@tauri-apps/api/window` 的 `appWindow.startDragging()` 进行底层系统级原生拖拽激活。
2. **双击铺满全屏的原生平滑动画**:
   - 解决 tao 原生 `zoom:` 瞬间跳变无动画问题，引入 `objc2-app-kit` 与 `objc2-foundation`。
   - 在 `lib.rs` 的 `toggle_maximize` 中实现原生 Cocoa 帧动画：`setFrame_display_animate(target_rect, true, true)`，展开与收缩自带 0.25s 减速曲线。
   - 并在 `main.ts` 捕获阶段拦截双击 `mouseup`，防止触发 Tauri 内部无动画的 `internal_toggle_maximize`。
3. **消除 Tao TRACE 日志噪音**:
   - 在 `lib.rs` 中为 `tauri_plugin_log` 配置 `.level(log::LevelFilter::Info)`，彻底屏蔽底层生命周期日志刷屏。
4. **根目录自动探测与 Finder 启动适配**:
   - 完善 `lib.rs` 的 `find_project_root` 多级判定（`AIPUNCH_ROOT` -> `project-root.txt` -> 祖先路径探测），解决 Finder 双击启动时工作目录变成 `/` 的问题。
   - 引入文件锁与原子写入（`ENV_LOCK` + `atomic_write`），杜绝 `.env` 并发读写冲突。

### B. 自动更新与一键发版完整链路 (对标 stock)
1. **GitHub Releases 与本地一键发版 (`tool/release.sh`)**:
   - `tool/release.sh` 负责版本号同步与本地签名构建；发布动作交给 GitHub Actions（`release.yml` 推 tag 触发）。
   - 终端一行命令 `npm run release <版本号>` 即可完成：版本号同步（4 个文件）-> 本地编译 DMG & Updater 包 -> Ed25519 签名 -> 提交并推 tag；CI 再上传 DMG、Updater 包与 `latest.json`。
   - 脚本有前置门禁：必须在 `main` 分支、且 tag 从未存在过，拒绝覆盖已发布版本。
2. **应用内自动更新器 (@tauri-apps/plugin-updater)**:
   - 公钥已配置在 `tauri.conf.json`，私钥通过本地 `gh secret set` 自动同步到了 GitHub Actions Secret (`TAURI_SIGNING_PRIVATE_KEY`)。
   - 侧边栏底部展示当前版本号与「检查更新」按钮，支持静默启动检测、下载进度百分比反馈、下载完成点击重启。
3. **开源公共属性变更**:
   - 已通过 `gh repo edit` 正式将 `clzwqoii/aipunch` 转为 Public 开源仓库，安全排查确认零 Token 泄露历史。

---

## 3. 当前验证状态 (基线)

- **Rust 单元测试**: `cargo test --manifest-path shell/src-tauri/Cargo.toml` -> **7/7 passed**
- **核心单元测试**: `npm test` -> **145/145 passed (100%)**
- **前端打包编译**: `npm --prefix shell run build` -> **通过 (90ms, 47KB)**
- **代码仓库**: [clzwqoii/aipunch](https://github.com/clzwqoii/aipunch) (Public)

---

## 4. 下一阶段推荐工作 (Next Steps)

1. **首次发版验证 (Smoke Release)**:
   - 执行 `npm run release 0.1.0` 跑通第一次正式发布。
   - 验证 GitHub Releases 上是否生成 DMG、Updater 包和 `latest.json`。
   - 运行桌面外壳验证「检查更新」是否能成功识别版本。
2. **UI 细节与交互补全**:
   - 检查「隐私设置」页面与 Rust 新增的 `get_project_root` / `set_project_root` 的 UI 输入绑定。
   - 检查 WorkBuddy 和 AutoClaw 国内版短信登录向导弹窗的实际调起表现。
3. **多平台打包矩阵 (可选)**:
   - 如需分发 Windows/Linux，可在 `.github/workflows/release.yml` 开启对应 target 构建。

---

## 5. Suggested Skills (接手 Agent 推荐技能)

- `karpathy-guidelines`: 严格遵守最小必要修改，避免过度设计。
- `tdd`: 针对 `core/`、`runners/` 及 `lib.rs` 的新增功能必须先写失败测试再最小实现。
- `ponytail`: 坚持最懒最简单有效路径，复用标准库和成熟生态，避免自造轮子。
- `i-have-adhd`: 输出以可执行行动开头，带步骤编号，无题外话，给预估时间。
