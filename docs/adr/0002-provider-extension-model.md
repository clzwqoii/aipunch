# Provider 扩展模型：L0 声明式 / L1 代码 / L2 凭证发现

- 状态：accepted（2026-10-18）
- 背景：签到应用需要可扩展，用户提出三种接入诉求——自定义配置、插件、本地应用登录态直接获取。参考 yetone/magpie 的「三类来源」设计后裁剪落地。
- 决定：按复杂度分三级扩展（L0/L1/L2），不做通用插件平台；凭证发现限定为已注册 Provider 显式声明的白名单。
- 原因：magpie 的网关、协议转换、路由组、Bun 插件沙箱服务的是「多智能体模型网关」场景；签到是单向后端 HTTP 调用，且 CI 硬约束 Node 运行时，移植这些只会增加依赖链。三级模型覆盖同一复杂度光谱，每级有明确升级路径。

## 三级扩展模型

| 级别 | 形态 | 适用场景 | 状态 |
|---|---|---|---|
| L0 声明式 | `config.json` 描述单个 HTTP 请求（url / method / headers 模板 / body / 结构化成功判定） | 单请求 + 静态头，如 WorkBuddy | 未实现（等第 2 个 Provider 真实样本再抽象） |
| L1 代码 Provider | `providers/*.ts` 实现 Provider 接口 + 一行 register | 多步流程 / HMAC 签名 / token 刷新 / GraphQL | 已实现（workbuddy） |
| L2 凭证发现 | `core/credentials.ts` 按 Provider 声明的路径表读桌面应用登录态 | 桌面壳自动填 token | 未实现（壳阶段） |

升级路径：L0 不够用 → 该应用改写 L1；Provider 数量 >5 且接口稳定 → semver 化后开放 npm 包插件（不做沙箱，自用场景不需要）。

## 凭证发现的白名单边界（2026-10-18 确认）

- 发现范围 = **已注册 Provider 显式声明的凭证规格**（每个 Provider 可选导出 `credential: { paths: { darwin, win32, linux }, extract }`）。没有 Provider 声明的应用**永不扫描**——读了也无法签到，且违反隐私最小化。
- 配套隐私开关：`CHECKIN_NO_DISCOVERY=1` 环境变量 + 壳内开关（参考 magpie 的 `MAGPIE_NO_ACCOUNTS`）。
- 硬边界：**凭证发现仅存在于桌面壳**。CI 运行时不存在用户桌面应用的登录态，CI 侧 token 只能来自 GitHub Secrets。
- 重要事实（2026-10-18 实测）：WorkBuddy 5.6.0+ 客户端将登录态 AtRest 加密（AES-256-GCM envelope，密钥仅在客户端主进程内存、不落盘），公开教程的「读明文文件」方案已失效。L2 落地时须采用社区验证的方案：spawn 客户端自带 Electron 进程代解密（密钥不经过本项目，参见 `Ianzhyh/workbuddy-to-dsh`）。官方插件登录接口成为主凭证通道（见下）。

## 凭证双轨与 token 生命周期

- 凭证获取（2026-10-18 起）：官方插件登录接口 `POST /v2/plugin/login/send-sms` + `POST /v2/plugin/login/token`（手机号 + 验证码直接换 accessToken/refreshToken，端点已探测确认）。CLI 提供 `npm run login` 交互流程；不依赖桌面客户端，CI 与桌面壳通用。取代原「读登录态文件」方案（5.6.0+ 加密后不可行）。
- 桌面壳：L2 客户端进程代解密（便捷导入）或同款交互登录。
- CI：GitHub Secrets（`npm run login` 输出的 refreshToken）。
- 发布流程（本地无需常驻）：本地/壳编辑 `config.json`（零密钥，可提交）→ push → Actions 按 cron 执行，读 Secrets 注入 token。本地只在初始 setup 需要。
- 轮换现实与处理：服务端每次刷新都轮换 refreshToken（旧值作废），离线会话约 30 天。CLI 检测到轮换时：① 结构化透出 `rotatedRefreshToken`；② 写入 `CHECKIN_ROTATED_TOKEN_FILE`；③ workflow 用 `gh secret set` 自动回写（需 Secret `GH_PAT`，仓库管理员权限）；未配 GH_PAT 时 Actions 出 warning 提示手动更新。
- 待真实 token 最终验证：刷新接口成功响应字段形状（扁平 vs `data` 嵌套已做双路径兼容）、登录接口在真实手机号上的行为。

## 参考 magpie 的具体设计

1. 三类来源心智模型（API 密钥预设 / 订阅发现 / 本地兼容 URL）→ 裁剪为 L0/L1/L2。
2. 本地登录态发现订阅 → L2。
3. 隐私开关（`MAGPIE_NO_ACCOUNTS=1`）→ `CHECKIN_NO_DISCOVERY`。
4. 「只显示本机已安装的」UX → 壳只展示检测到的受支持应用。
5. 原子写入保留格式 → 壳改 `config.json` 时保留用户注释（壳落地时评估 JSON5）。

不采纳：协议转换网关、路由组、Bun 插件沙箱、菜单栏常驻形态——均服务网关场景，对签到无收益且破坏 CI 的 Node 约束。
