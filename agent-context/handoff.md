# 交接账本

> 每项任务一条主记录；修改更新主记录并在「修订」追加一行。全文 ≤ 250 行。

## 本轮焦点

- P1 已提交上线（80915df）并实测验证：dispatch 运行 #40077506929 gate 输出「手动触发，不校验时间窗口」、签到 5/5 成功，workflow 新语法在 GitHub 合法。下一步 P2（Cloudflare Workers 全链路）。

## 进行中

### P2 Cloudflare Workers 全链路（ADR 0004）
- 状态：代码完成（2026-10-24），226/226 绿 + 双 tsc + cargo check + build:engine（11 bundles 含 worker.mjs/cf-deploy.mjs）+ 浏览器冒烟；**待真实 CF 账号部署实测**
- 已落地分层：
  - `cloudflare/worker.ts`：scheduled 入口（KV 读 config → resolveAccounts(注入 env) → runCheckins → 结果写 KV `result` → 轮换票 CF API 自回写 Secrets，KV 不落敏感 token）；打包产物零 node:fs、仅 node:crypto（nodejs_compat）
  - `cloudflare/cf-api.ts`：REST 封装（cronHourFor 换算在 ci-checkin）——ensureKvNamespace 幂等、deployWorkerRequest multipart（KV 绑定+CF_* Secret 占位+cron）、putSecret/putSchedules/putKvValue、readKvValue、runRequest 信封解析
  - `runners/ci-sync.ts`：platformFromConfig 分流，CF 平台走 mainKv（planKvSync：无结果/已同步/不新/放行四态，合并复用 mergeRunResults）
  - `runners/cf-deploy.ts`：--token/--account（env 兜底）代部署全流程（KV→config→worker→Secrets→.env 回写 CF_ACCOUNT_ID/API_TOKEN/KV_NAMESPACE）；`--trigger-now`=临时 cron 下一分钟→轮询 KV result→恢复；`--cron-only`=只改定时
  - 桌面端：CF 卡解禁+⚙ 部署弹框（token/account 表单，定时沿用定时行值）；activePlatform 三态；一键签到 CF 分流 --trigger-now；切 CF 时 GitHub workflow 自动 disable；「保存定时」CF 分流 --cron-only
- 实测进度（2026-10-24 深夜全链路）：**部署一键幂等已真实验证**——worker 上传成功、二跑按指纹跳过上传、cron 5 字段通过、Secrets/KV/凭证写回全通，数据目录 ci-sync 输出「KV 暂无结果」（待首跑）。实测暴露并修复四个 CF API 兼容点：multipart 不声明 secret_text、module MIME 需 application/javascript+module、cron 为 5 字段、脚本须先于 Secrets/Schedules 上传（7250940）
- 待最后验证：「一键签到」（trigger-now 首轮）→ 五账号结果（CodeArts 10ms CPU）→ KV 同步回卡片
- UX 反馈修复（部署状态反馈）：部署弹框点「部署」后按钮禁用变「部署中…」、弹框保持，退出码成功才显示「✓ 部署成功」并 1.5s 后关闭、失败留在弹框内可重试；平台卡新增配置状态行（CF=.env CF_KV_NAMESPACE 判定「● 已部署」绿；GitHub=config.repo 判定「● 已配置仓库」）
- 关联（2533c84）：云端 CI 页新增网络状态行（GitHub/Cloudflare API 域可达性 chip，启动 5s 自查 + 手动「网络检查」，netcheck runner 输出 [NET] 行单点解析）——国内可达性是平台选型依据（ADR 0003）；两平台弹框均含一键打开 Fork/令牌创建页
- 修订：
  - 2026-10-24 首次记录

### P1 云端 CI 菜单与状态同步（ADR 0004）
- 状态：✅ 已提交上线（80915df，2026-10-24）；四轮手测反馈修完，207/207 绿
- 决策口径：平台单选（local / cloudflare-workers(P2) / github-actions，可零选）；同步=拉取式（ci-sync 拉最新完成运行合并）；providers 幂等路径显式 skipped；原「执行记录」tab 并入新菜单后移除；CF Workers 为 P2（worker 自我回写轮换票、立即执行=临时改 cron）。
- 已完成与验证：
  - skipped 显式化：CheckinResult/AccountResult/ResultEntry 全链透传；五家 provider 七处幂等分支标 skipped，autoclaw「真签到无奖励」守恒测试防误标（TDD，201/201 绿）
  - ci-sync runner：pickLatestCompleted（不限触发来源）/shouldSync（远端新才覆盖）/isSynced（runId 防重复）；ResultFile 加 runId，ci-checkin 补写；真实链路已验证（拉取 #40064641867 合并 5/5 不丢、二跑防重复命中）
  - 「云端 CI」菜单：nav 替换原执行记录 tab；同步状态条+立即刷新、平台三选一卡（CF 禁用标 P2）、运行记录含 ⊘ 已签跳过标签
  - 平台分流：config.platform（缺省=github-actions 向后兼容）；local 模式一键签到/单跑走内置引擎 cli.mjs（轮换票自动写回 .env 已有实现）
  - 同步触发：启动 3s 静默 + 每 30 分钟 + 手动按钮；startRunner 加 silent 选项（不展开终端、冲突让位）
  - typecheck（根+shell）、cargo check、build:engine（10 bundles 含 ci-sync.mjs）全过；AGENTS.md 执行端条目已改平台单选口径
- 手测路径（UI 层与真实票未自动化）：npm run shell → 云端 CI tab 看 GitHub 卡高亮 → 立即刷新出 [SYNC] → 切本地执行后一键签到走本地 cli → 切回云端；下次真实签到后已签账号显示 ⊘ 已签跳过。local 模式真实签到涉及轮换本机票，留给用户择机手测。
- 下一步：手测通过后提交；P2 Cloudflare Workers 全链路（worker 打包入口、存储抽象、部署 UI、KV 拉取合并进 runCiSync）。
- 修订：
  - 2026-10-24 首次记录并同日代码完成：方案四项拍板落 ADR 0004；A→E 全部实现（skipped 显式化、ci-sync、云端 CI 菜单、同步触发、平台单选分流），201/201 绿 + ci-sync 真实拉取验证；UI 手测待做
  - 2026-10-24 手测反馈修复（三项）：深色主题平台名看不清（`.platform-card` 是 button 不吃继承色，补 `color: var(--text-primary)`）；新增「GitHub Actions 配置」区块（repo 状态三色显示 + 5 步配置流程 + 「检查配置」按钮复用 `ci-checkin --check`，退出码判定 ok/fail）；页头补自动执行说明（云端定时无需启动本应用）。shell tsc + 3/3 测试过，vite 浏览器冒烟截图确认深色可读、布局无异常；真实 app 内「检查配置」按钮待手测
  - 2026-10-24 二轮反馈（两项）：① 配置区块收进 GitHub 卡片右上角「⚙ 配置」标识（span+stopPropagation，card 是 button 嵌套交互元素违规）点击弹框显示教程+状态+检查配置；② 平台切换联动仓库 CI 启停（ADR 0004 单执行端落地）：切 local 自动 `gh workflow disable checkin.yml`、切回云端 enable（ci-checkin 新增 `--workflow-disable/enable`，TDD 三纯函数 workflowToggleArgs/workflowStateFromView/parseCiArgs 扩展；`--check` 输出加 workflow 启停状态）。204/204 绿 + build:engine 重打包；待真实 app 手测：切平台看终端 [CI] 已禁用/已启用、⚙ 弹框交互
  - 2026-10-24 三轮反馈（布局密度）：#tab-cloud 板块间距 20→12px、pane-header padding 压缩，执行记录回到首屏；同步状态条与平台卡背景 recessed→card（浅色下=纯白），状态条 padding 10/14→5/12、内部按钮 4px 10px 紧凑；cloudPlatformSub 副标题加「云端平台无需启动本应用也按时自动签到」。浅色主题整页截图验证四项到位；深色走主题变量自动适配
  - 2026-10-24 五轮（定时方案切换，决策账本已记）：每小时 gate 被「改 cron 只跑一次」取代——`--set-schedule` 经 gh API 读改 checkin.yml 的 cron 行并 PUT 提交，时区→UTC 用 Intl 按当日偏移换算（DST 漂移 1 小时重存即校正），`AIPUNCH_CHECKIN_TZ` 变量仅供检查配置读回；gate/每小时 cron 全部移除。**真实链路已实测全通**（用户补 workflow scope 后）：PUT 改 cron 成 commit b5774f4、`--check` 显示「定时运行中 · 定时 Asia/Shanghai 11:00」；顺带修正 workflow 状态读取（`gh workflow view --yaml` 输出的是文件内容不含 state，改读 REST `actions/workflows/:file` 的 state 字段）。208/208 绿

### 桌面端 v0.2.2 上线确认
- 状态：待确认
- 当前逻辑：v0.2.2 已发布（内置 Node 引擎版）；本机 `/Applications` 已是 0.2.2（2026-10-24 经 app 内更新升级，含内置引擎资源，非本地构建）。Windows 包已在 CI 冒烟验证引擎可运行，但未在真实 Windows 桌面启动过 GUI。
- 关键位置：shell/src-tauri/src/lib.rs（bundled_engine_root / work_dir / run_script_stream）、tool/build-engine.mjs、.github/workflows/release.yml（Windows 冒烟步骤）
- 验证：`gh release view v0.2.2` 资产齐全（dmg / exe+sig / app.tar.gz+sig / latest.json）；Windows CI 冒烟执行包内 `resources\node.exe resources\engine\cli.mjs --dry-run`，输出 5 个账号且 exit 0。
- 下一步：在真实 Windows 机器安装 0.2.2，确认 GUI 启动并能用内置引擎跑一次签到/检查更新（本机升级已完成）。
- 修订：
  - 2026-10-24 首次记录

## 关键约束

- 凭证是单次轮换票，CI 为唯一执行端；本地 `.env` 会落后于 Secrets，不要用本地 token 跑 `npm run checkin`。
- Trae 同日重复 claim 会触发设备级 `9074`（状态接口 checked_in=false 但 claim 被拒）；重走 `npm run trae-login` 换新设备可恢复，勿同日连刷。
- 内置引擎模式的数据目录：`~/Library/Application Support/com.aipunch.app/engine-data`（`.env`、`config.json`、`.aipunch-*.json`）。
- `config.json` 顶层 `repo` 字段供 ci-checkin 显式 `--repo`（数据目录不是 git 仓库）；Secrets 仍为五家 token + `GH_PAT`。

## 已归档

- 2026-10-24 CI 签到失败排查 — 单次轮换票 + workflow 回写被 `bash -e` 跳过；改为失败也无条件回写 Secret（.github/workflows/checkin.yml）
- 2026-10-24 Trae 凭证与 9074 — 浏览器授权独立会话 + 完整设备指纹头；9074 真因为设备风控，重登换设备可恢复（core/trae-auth.ts、providers/trae.ts、runners/trae-login.ts）
- 2026-10-24 网络兜底 — 代理残留 fake-IP/死解析器自动走 DoH；单请求 30s 超时 + 逐账号输出（core/dns-fallback.ts、core/http.ts、runners/cli.ts）
- 2026-10-24 桌面端触发 CI — 一键签到走 `ci-checkin`（gh workflow_dispatch + 轮询 + artifact 下载），桌面端不再本地执行（runners/ci-checkin.ts、shell/src/main.ts）
- 2026-10-24 余额与结构化结果 — 五家余额接口打通；卡片余额、顶部 CI 状态环、执行记录均读 CI 结构化结果；今日已签禁用单跑与主按钮（providers/*.ts、core/result.ts、shell/src/main.ts）
- 2026-10-24 更新检查 UX — 发现新版本弹框展示 Release 说明，按钮「下载并安装 vX.Y.Z」，失败显示原因（shell/src/main.ts setupUpdaterControls）
- 2026-10-24 凭证导入去重 — 最近一次签到成功的供应商禁用重复导入并标注「凭证有效」（shell/src/main.ts applyCredentialState）
- 2026-10-24 内置引擎 — 安装包内置 Node + esbuild 打包的 runner；数据目录存凭证与记录，首次启动迁移旧仓库数据；安装包 5MB→43MB（tool/build-engine.mjs、shell/src-tauri/src/lib.rs、tauri.conf.json resources）
- 2026-10-24 发版 — v0.2.0、v0.2.1、v0.2.2 均按发版门禁发布，产物齐全；latest.json 可被 app 内更新读取

## 建议技能

- `tdd`：P2 的 CF Workers 入口/存储抽象与 adapter 改动先写失败测试；providers 业务代码不动
- `diagnosing-bugs`：手测或 CI 运行失败先复现取证（日志/gh run view/KV）再改代码
- `ponytail`：默认启用；P2 部署链路优先复用 ci-sync/mergeRunResults，不提前抽象多平台层
