# 云端执行环境策略：Runner 适配器 + 复用生态，不做托管服务

- 状态：accepted（2026-10-18）
- 背景：核心代码已可在 CI 无人值守运行，但「终端用户下载桌面壳后如何零门槛获得云端自动签到」没有答案。候选：壳内授权一键部署到 CI 平台 / 项目方托管服务 / 导出到既有生态（青龙面板等）。
- 决定：引入 Runner（执行环境）适配器层，与 Provider 分层同构；先落地本地执行与 GitHub Actions 手动配置，壳阶段做「一键部署到 GitHub」；明确不做项目方托管服务。
- 原因：托管服务意味着项目方保管全部用户 token——受托责任、隐私合规、服务器成本、被滥用风险，与开源项目形态不匹配。复用用户自己的 CI 账号或既有生态，项目方零服务器成本、零 token 托管责任，用户凭证始终在自己账户内。

## 方案对比

| 方案 | 用户门槛 | 项目方成本 | 结论 |
|---|---|---|---|
| 壳内 OAuth 一键部署到用户 GitHub | 低（有 GitHub 账号 + 2-3 次点击） | 中（GitHub App/device flow + 模板仓库 + secrets API，约 2-3 天） | ✅ 主路径 |
| 多 CI 平台适配（GitLab / Cloudflare Workers / 国内云函数） | 中（需各平台账号） | 高（每平台一套授权与部署 API） | 适配器留口子，按用户地域排期 |
| 导出青龙面板配置 | 中（有青龙或愿意自建） | 极低（生成配置文本，零 API 对接） | ✅ 国内签到圈事实标准，低成本高覆盖 |
| 项目方托管服务 | 最低 | 最高（服务器 + 安全 + 合规 + 滥用风险） | ❌ 明确不做 |
| 桌面壳本地常驻调度 | 零 | 零 | 已有，但关机漏签，不满足「自动」诉求 |

## Runner 适配器接口（壳阶段落地）

```ts
interface CiRunner {
  id: string;                       // 'github-actions' | 'gitlab-ci' | ...
  name: string;
  deploy(config: ConfigFile): Promise<{ url: string }>;  // 创建/更新远端仓库、Secret、workflow
  status(): Promise<'active' | 'missing' | 'error'>;
  remove(): Promise<void>;          // 解除托管：删远端 workflow/仓库
}
```

- `LocalRunner`：壳内「一键全部签到」，直接调 core 执行器。
- GitHub 适配器授权设计：GitHub App（细粒度权限：仅 Contents + Secrets + Actions，且仅限壳创建的仓库）或 OAuth device flow；全程在用户自己账号下创建仓库，用户可随时在 GitHub 侧撤销，壳提供「解除托管」按钮。
- 「支持多平台」的真实理由是**国内可达性**（GitHub 访问不稳），不是功能洁癖。优先级：GitHub（全球/开发者）→ 青龙导出（国内零成本）→ GitLab / 国内云函数（按反馈排期）。

## 与 Provider 分层的关系

同构分层：Provider 抽象「签哪个应用」，Runner 抽象「在哪运行」。`config.json` 是两者共同的事实源——壳改一次配置，本地执行与云端执行语义一致。
