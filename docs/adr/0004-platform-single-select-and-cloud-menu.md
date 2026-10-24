# 云端执行端单选模型与「云端 CI」菜单：本地 / Cloudflare Workers / GitHub Actions

- 状态：accepted（2026-10-24）
- 背景：ADR 0003 确立 Runner 适配器方向后，需求进一步收敛：桌面端要统一的云端管理菜单（平台绑定、token 输入、执行状态日志、运行记录）；目标用户大量是非开发者，「注册账号 → 建仓库 → 传代码 → 配 workflow/Secrets」的仓库型 CI 路径对其不成立；且桌面端与云端签到状态需要双向同步（桌面端签了云端跳过、云端签了桌面端展示跳过）。
- 决定（2026-10-24 用户确认）：
  1. **平台枚举单选，可零选**：`local`（本地模式）/ `cloudflare-workers`（P2 实现）/ `github-actions`（现状）。不支持多平台并存——凭证是单次轮换票，同时只能有一个活跃执行端；此前方案的「多平台绑定 + 主备约束 + 跨平台 Secrets 对齐」全部不做。
  2. **零仓库云端执行端主推 Cloudflare Workers**：桌面端粘贴 API Token + Account ID 后 API 代部署（上传脚本、创建 KV、写 Secrets、设 cron 全 REST，无需 wrangler/git）；结果写 KV、桌面端 API 读；轮换票由 worker 持受限管理 Token **自我回写 Secrets**（KV 不落敏感 token）；「立即执行」不走 workers.dev HTTP 入口（国内被墙），改为临时把 cron 改到下一分钟触发、完成后改回。
  3. **GitHub Actions 保留**为开发者/存量用户选项；P3 切 REST + PAT 摆脱 gh CLI 安装与登录依赖。
  4. **Gitee Go、极狐 GitLab 不做**：Gitee Go 是国内唯一大众托管 CI，但 API 覆盖弱（定时依赖触发器、产物/日志回传不完整）、免费层受限，且仍要建仓库；极狐能力完整但同样绕不开建仓库，不符合非开发者定位。
  5. **Vercel / Deno Deploy 不做**：Vercel 无托管 KV（结果回传须再注册第三方存储，普通用户多一个账号）；Deno Deploy 的 KV 桌面端读取链路成熟度待验证；Cloudflare 四项（代部署/定时/凭证/结果回传）全绿。
  6. **状态同步 = 拉取式**：新增 `ci-sync` runner 拉取最新完成运行（不限触发来源）的结果 artifact，按 provider/account 取最新合并进本地 `.aipunch-last-run.json`；providers 幂等路径显式返回 `skipped: true`（真签到与「今日已签跳过」在结果层区分，均计为已签）。桌面端无公网入站、本地无长期凭证，推送式与供应商实时查询均不可行。
  7. **桌面端新增「云端 CI」菜单**（区块：同步状态条 / 平台绑定 / 运行控制 / 运行记录 / 凭证同步）；原「执行记录」tab 的数据源与新菜单运行记录相同，合并后移除原 tab。
- 原因与事实核查（2026-10-24 取证）：
  - 签到引擎 Node 依赖面：providers/core 无 `child_process`；HTTP 层纯 `fetch` + `AbortSignal.timeout`（Web 标准，Workers 原生）；`node:crypto`（HMAC/哈希）在 Workers `nodejs_compat` 支持范围；`node:fs` 集中在 config/dotenv/token-rotation/trae-storage，worker 化时换存储抽象；`dns-fallback` 的本地代理 fake-IP 问题在 CF 环境不存在，云端构建不打包。
  - workers.dev 域名国内被墙，但部署/管理/触发全走 api.cloudflare.com（一般可直连），用户与桌面端都不需要访问 workers.dev。
  - Workers 免费版 CPU 10ms/次（网络等待不计）：签到计算量微秒级，大概率安全；CodeArts DPoP 等路径 P2 真实环境实测后再放行。
  - 本地模式自洽性：`runners/cli.ts` 已实现轮换票自动写回 `.env`（`setEnvValue` 原子写），本地单执行端成立；代价是 app 不开不签，切换到云端平台前需确认凭证未在本地轮换。
  - 桌面端现状缺口：`.aipunch-last-run.json` 只在桌面端自己触发的运行结束时写入，定时 cron 的结果桌面端不可见——这正是 `ci-sync` 要补的环。
- 分期：P1 同步闭环（`ci-sync` + skipped 显式化 + 「云端 CI」菜单骨架 + 平台配置模型与本地模式）；P2 Cloudflare Workers 全链路（worker 打包入口、存储抽象、部署/绑定 UI、KV 拉取合并）；P3 GitHub Actions PAT 化（备选：极狐 GitLab）。
