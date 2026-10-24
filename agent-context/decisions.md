# 决策账本

> 同一主题只有一条当前有效记录；被取代的旧记录压成一行指向新记录。全文 ≤ 400 行。

## 当前有效

### 云端定时调度方式 保存定时 = 自动改 workflow cron，每天只真跑一次
- 状态：生效
- 决定：桌面端「定时执行」保存时由 `ci-checkin --set-schedule <HH> <TZ>` 通过 gh API（PUT contents）把 `checkin.yml` 的 schedule cron 改为对应 UTC 整点，同时写 `AIPUNCH_CHECKIN_TZ` 变量（解释 cron 用）；时区→UTC 换算用 Intl 按当日偏移计算，DST 季节会漂移 1 小时，重新保存即可校正。
- 背景：cron 写死在 workflow 文件、repo 变量无法参与调度；每小时触发+比对变量的方案每天产生 23 条跳过记录，用户拍板换成精确一次。
- 影响：`runners/ci-checkin.ts`（cronHourFor/replaceCronLine/scheduleFromCron、--set-schedule 与 --check 读回）、`.github/workflows/checkin.yml`（cron 行为唯一调度源，gate 移除）。
- 验证：纯函数单测（DST 两季换算、cron 行替换、读回）全绿；真实 PUT 改 cron 待实测（需 gh token 带 workflow 权限，缺失时报错提示 `gh auth refresh -s workflow`）。
- 历史决定：
  - 2026-10-24 每小时整点触发 + repo 变量（HOUR/TZ）时间窗 gate，仅 schedule 事件比对（80915df 上线后因 Actions 记录噪音被取代）
- 修订：
  - 2026-10-24 首次记录

## 已取代

## 建议技能

- `tdd`：改 cron 链路（时区换算、YAML 行替换）先写失败测试再实现。
