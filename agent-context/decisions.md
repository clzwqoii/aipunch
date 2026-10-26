# 决策账本

> 同一主题只有一条当前有效记录；被取代的旧记录压成一行指向新记录。全文 ≤ 400 行。

## 当前有效

### 小浣熊接入形态 登录延效型 provider，成功判据是当日发放记录的延效档位
- 状态：生效
- 决定：小浣熊按「登录触发型（登录延效）」接入（推翻 10-19「无需自动化」）：每日积分 00:00 无条件发放，签到价值在延长有效期。成功判据两条同时成立：①最新 `biz_type=daily_grant` 条目的 **`created_at` 北京日期 = 今天**（证明当日发放记录确实存在，不能拿昨天那条顶替）；②该条 `expire_at − grant_at ≥ 48h`（延效档，实测两档 86399s/604799s）。北京日期用 `+8h 后取 UTC 日期` 计算，无 DST、零时区依赖。执行链 token 直用 → setting_info（桌面头，即登录动作）→ bills 核对；401 才 refresh。
- 背景：发放闭眼发，「今日有入账」只证明发放存在不证明延效（8abbd00 旧判据之误）；「grant_at 距今 <48h」的新鲜度护栏有假阳性（昨天的延效记录不足 48h，会把昨天谎报成今天），10-26 实测复现后改按 created_at 日期判定。
- 影响：`providers/raccoon.ts`（判据+token 直用+401 重试）、`providers/raccoon.test.ts`（11 测试，含昨日延效假阳性与 UTC 跨日两例）、`runners/raccoon-extract.ts`（双变量）、`providers/index.ts`、`config.json`、GitHub secrets、CF worker 脚本（选择性部署，不动 secrets）。
- 验证：2026-10-24 真实 token 实跑成功；239 测试全绿 + typecheck；**2026-10-26 归因实验决定性通过**——当天无人触碰客户端，11:00 CF cron 的 provider 调用独自创建当日发放记录（created_at 11:00:30）并延效至 11-01，证明 token 直用 + setting_info 足以构成登录并延效，无需 refresh 也无需客户端；同日重复调用幂等（15:15 再触发未产生新行）。
- 历史决定：
  - 2026-10-19 判定「无需自动化」；旧判据「今日账本有正积分入账」只验证发放不验证延效
- 修订：
  - 2026-10-24 首次记录（当时用 48h 新鲜度护栏）
  - 2026-10-26 护栏改 created_at 北京日期判据（修假阳性）+ 归因实验通过

### 执行平台现状 已切 cloudflare-workers：调度源 = worker cron，GH workflow 禁用是设计态
- 状态：生效
- 决定：桌面端平台卡已选 `cloudflare-workers`（app engine-data/config.json），每日 11:00（北京）由 CF worker cron 执行签到；联动禁用 GitHub `checkin.yml` 是 ADR 0004 单执行端的设计行为，不是故障，不要「修复」它。
- 背景：2026-10-25 误把设计态当故障（enable workflow + 手动 dispatch），与 worker cron 形成双执行端并发轮换，当日靠轮换容忍侥幸无损；已还原禁用态。
- 影响：`shell/src/main.ts`（平台卡联动）、`.github/workflows/checkin.yml`（保持 disabled）、CF worker `aipunch-checkin`（KV config 6 账号含 raccoon，2026-10-25 选择性部署）。
- 验证：2026-10-25 CF worker 实跑 6/6（含 raccoon 延效判定）；GH workflow 已 `gh workflow disable` 还原。
- 修订：
  - 2026-10-25 首次记录

### CF 增量变更走选择性部署 全量 cf-deploy 会覆盖 worker 自轮换票据链
- 状态：生效
- 决定：worker 运行后自轮换的新票只存在 worker secrets 里，本地任何 .env 都是旧链；`npm run cf-deploy` 全量部署会把旧票推上去覆盖新链（此前「重导入 trae/codearts 票」的根因）。增量变更（加账号/换脚本）走选择性更新：`putKvValue('config')` + `deployWorkerRequest`（脚本上传不动 secrets）+ 只推新增账号的 `putSecretRequest`。
- 背景：2026-10-25 给 worker 加 raccoon 时取证确认 buildDeployPlan 无条件推送全部账号凭证。
- 影响：`runners/cf-deploy.ts`（buildDeployPlan）、`cloudflare/cf-api.ts`（选择性部署所用原语）。
- 验证：选择性部署后 worker 立即实跑 6/6 成功，5 个 provider 的既有链未受影响。
- 修订：
  - 2026-10-25 首次记录

### 云端定时调度方式 保存定时 = 自动改 workflow cron，每天只真跑一次
- 状态：生效
- 决定：桌面端「定时执行」保存时由 `ci-checkin --set-schedule <HH> <TZ>` 通过 gh API（PUT contents）把 `checkin.yml` 的 schedule cron 改为对应 UTC 整点，同时写 `AIPUNCH_CHECKIN_TZ` 变量（解释 cron 用）；时区→UTC 换算用 Intl 按当日偏移计算，DST 季节会漂移 1 小时，重新保存即可校正。
- 背景：cron 写死在 workflow 文件、repo 变量无法参与调度；每小时触发+比对变量的方案每天产生 23 条跳过记录，用户拍板换成精确一次。
- 影响：`runners/ci-checkin.ts`（cronHourFor/replaceCronLine/scheduleFromCron、--set-schedule 与 --check 读回）、`.github/workflows/checkin.yml`（cron 行为唯一调度源，gate 移除）。
- 验证：纯函数单测（DST 两季换算、cron 行替换、读回）全绿；真实 PUT 改 cron 待实测（需 gh token 带 workflow 权限，缺失时报错提示 `gh auth refresh -s workflow`）。
- 修订：
  - 2026-10-24 首次记录（当天即以精确一次方案取代每小时 gate 方案，历史口径见上）

## 已取代

## 建议技能

- `tdd`：改 cron 链路（时区换算、YAML 行替换）先写失败测试再实现。
