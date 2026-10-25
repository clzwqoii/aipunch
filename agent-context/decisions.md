# 决策账本

> 同一主题只有一条当前有效记录；被取代的旧记录压成一行指向新记录。全文 ≤ 400 行。

## 当前有效

### 小浣熊接入形态 登录延效型 provider，成功判据是 expire_at 延效档位
- 状态：生效
- 决定：小浣熊按「登录触发型（登录延效）」接入（推翻 10-19「无需自动化」）：每日积分 00:00 无条件发放，签到价值在延长有效期——成功判据取最新 `biz_type=daily_grant` 条目的 `expire_at − grant_at` 档位（≥48h 视为延效，实测两档 86399s/604799s），加 48h 新鲜度护栏；纯时长差值判定零时区依赖。执行链 token 直用（与客户端共享会话，401 才 refresh）→ setting_info（桌面头）→ bills 核对。
- 背景：发放闭眼发，「今日有入账」只证明发放存在不证明延效（8abbd00 旧判据之误）；用户要求接入以每日保住 7 天有效期。
- 影响：`providers/raccoon.ts`（判据+token 直用+401 重试）、`providers/raccoon.test.ts`（10 测试）、`runners/raccoon-extract.ts`（双变量）、`providers/index.ts`、`config.json`、`.github/workflows/checkin.yml`（RACCOON_* env）、GitHub secrets。
- 验证：2026-10-24 真实 token 实跑成功（+300 延至 10-30，token 直用 3.1s）；238 测试全绿 + typecheck；无客户端参与的归因实验待验证日观察（全天不碰客户端看 CI 结果）。
- 历史决定：
  - 2026-10-19 判定「无需自动化」；旧判据「今日账本有正积分入账」只验证发放不验证延效
- 修订：
  - 2026-10-24 首次记录

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
