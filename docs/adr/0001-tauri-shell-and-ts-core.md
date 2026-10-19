# 桌面外壳选型与总体架构：TypeScript 核心 + Tauri 2.12

- 状态：accepted（2026-10-18）
- 背景：为多个 AI 应用（WorkBuddy / Qoder / Trae / 码道 CodeArts / 商汤小浣熊等）做每日签到，主执行通道是 GitHub Actions 定时任务，另配一个桌面外壳做配置与手动触发，且新 AI 应用要能低成本接入。
- 决定：签到核心写成与 UI 无关的 TypeScript（Node）库，一套代码同时服务 CI runner 与桌面壳；桌面外壳选 Tauri 2.12 而非 Electron。
- 原因：核心零 UI 依赖才能在 Actions 里裸跑；桌面壳只承担"配置 + 触发 + 看日志"，Tauri 的体积（<10MB vs 80–150MB）与内存（30–50MB vs 150–300MB）优势对这种轻壳是决定性收益，且不牺牲桌面三端。

## 事实核查（2026-10-18 记录，防口径漂移）

1. **Tauri 2.12 支持 5 个平台，不是 6 端**：Windows / macOS / Linux（桌面）+ Android / iOS（移动）。"一套核心跑 6 端"的说法不准确；若把 Web/PWA 算作第六端，那也不是 Tauri 的构建产物。
2. **"最轻量"在主流的 Web 技术桌面框架里成立**，量级参考（2025 年多方实测口径）：Electron 安装包 80–150MB、常驻内存 150–300MB；Tauri 安装包 <10MB（典型 3–6MB）、常驻内存约 30–50MB。差距来自 Tauri 复用系统 WebView（Windows=WebView2 / macOS=WKWebView / Linux=WebKitGTK），不捆绑 Chromium。代价：Linux 需处理 WebKitGTK 依赖、Windows 需 WebView2 运行时（Win10/11 基本预装）、跨系统渲染一致性略低于 Electron。
3. **当前最新稳定版为 Tauri 2.12.3**（2026-10-10 发布）；2.12 起放弃 Windows 7 支持。
4. **移动端对本项目是伪需求**：签到本质是服务端 HTTP 调用，Android/iOS 壳没有存在意义。核心真正需要复用的两个运行时是 Node（Actions）与桌面 WebView。

## 架构

```
providers/            # 每个 AI 应用一个签到程序（新增接入 = 加一个文件）
  workbuddy.ts
  qoder.ts
core/                 # 纯 TS 库：Provider 注册表、账号/调度模型、执行器
runners/
  cli.ts              # node 入口：CI 里跑（GitHub Actions）
shell/                # Tauri 2.12 桌面壳：复用同一 core，只做配置/触发/日志
```

执行流：调度（Actions cron 或桌面壳手动触发）→ core 执行器按调度筛选启用的账号 → 逐个调用对应 Provider → 汇总执行记录。

Provider 契约（新增 AI 应用的唯一扩展点）：

```ts
interface Provider {
  id: string;                 // 唯一标识，如 'workbuddy'
  name: string;               // 展示名
  checkin(account: Account, ctx: RunContext): Promise<CheckinResult>;
}
```

## 决策明细

1. **核心用 TypeScript 纯 Node 库**（仅 fetch + 文件配置，无 UI 依赖）。CI 与桌面壳共用同一份代码，避免"两套实现漂移"。
2. **桌面外壳选 Tauri 2.12**。壳的职责边界：账号/调度配置 CRUD、手动触发、查看执行记录。不驻留后台、不做系统托盘（v1 已知限制，见 Consequences）。
3. **调度**：CI 侧用 `schedule: cron`（GitHub Actions 的 cron 是 **UTC**，有分钟级延迟，仓库 60 天无活动会停用定时流）；"自定义执行时间"= 改 workflow 里的 cron 表达式，桌面壳负责生成/校验该表达式（例：北京时间每天 09:00 → `0 1 * * *`）。桌面壳本地只提供"立即运行"，不做 OS 级后台调度。
4. **敏感数据边界**：账号 token 严禁入库；CI 侧走 GitHub Secrets，本地走配置文件并加入 `.gitignore`。

## Considered Options（桌面外壳）

| 方案 | 采纳 | 理由 |
|---|---|---|
| Electron | ✗ | 生态成熟、纯 JS 无 Rust 工具链；但体积/内存约 10 倍于 Tauri，对"配置面板 + 日志查看器"这种轻壳代价不成比例 |
| Tauri 2.12 | ✓ | 体积/内存最小；Rust 后端适合本地配置读写；桌面三端齐；前端框架自由 |
| Wails (Go) | ✗ | 同样轻量，但需 Go 工具链，与 TS 核心集成无额外收益，中文社区资料弱于 Tauri |
| 不要壳，纯 CLI + Actions | ✗ | 最省事，但桌面外壳是明确需求，不砍；改为分期：v0 先交付 core + CLI + CI，壳紧随其后 |

## Consequences

- 正：核心可在 CI 裸跑、可单测；新增 AI 应用 = 加一个 provider 文件，核心与两个 runner 零改动。
- 负：构建桌面壳需要 Rust 工具链；Linux 打包要处理 WebKitGTK 依赖；WebView 跨系统渲染有差异；桌面壳无后台驻留（需要时再接 launchd / 任务计划程序）。
- 部署注意：Actions 定时流在无活动仓库会休眠；token 全部走 Secrets / 本地配置。

## 分期建议

- v0：core + Provider 契约 + CLI + GitHub Actions workflow + 1–2 个真实 Provider，跑通 CI 签到。
- v1：Tauri 2.12 桌面壳（配置 CRUD、cron 生成、手动触发、执行记录）。
