# AGENTS.md

AIPunch 协作规则。面向人类贡献者与 AI Agent；改动代码前先读本文件与 `CONTEXT.md`（领域语言）、`docs/adr/`（已定案决策）。

## 项目速览

多个 AI 应用的每日签到：TypeScript 核心（`core/`）+ Provider（`providers/`，每个应用一个文件）+ CLI/CI Runner（`runners/` + `.github/workflows/`）。执行流：调度 → 按 `config.json` 筛选启用账号 → 逐账号调 Provider → 汇总。任一失败退出码 1。

## Provider 接口调研流程（新增签到应用的必经流程）

### 1. 情报来源（按优先级从高到低）

| 优先级 | 来源 | 用途 |
|---|---|---|
| 1 | 社区开源项目（GitHub） | 端点/请求头/判定逻辑的直接证据；看 commits 数与最近更新判断是否活跃 |
| 2 | 论坛抓包帖（52pojie / linux.do / locdd / 官方社区 forum） | 客户端真实请求日志（main.log 等），校验开源项目的字段形状 |
| 3 | 官方文档（活动页 / 帮助中心） | 积分规则、活动起止时间、计费口径——只有官方有 |
| 4 | 生态聚合表（Agent2API / Buddy2api 等网关项目的渠道×签到矩阵） | 快速判断某应用「有没有签到、是什么形态」，不适合作为契约依据 |

### 2. 交叉验证标准

- 同一契约（端点、字段形状、成功判定）须 **≥2 个独立来源**确认才进入实现；单来源只记录不实现。
- 字段形状冲突时（如扁平 vs `data` 嵌套、`token` vs `accessToken` vs `device_token`）做双路径兼容，并在代码注释注明冲突来源。
- 官方文案与实测矛盾时，以实测为准并记录真因（先例：Trae `9074`「参与用户太多」实为设备号非真实注册号）。

### 3. 版本时效性核查（每次调研必做）

- 开源项目：最近 commit / 更新时间；超过 3 个月无更新的项目，其契约降权为「待复核」。
- 上游产品：客户端版本变化（先例：Trae 2026-09 起 `ExchangeToken` 增加设备签名校验；小浣熊 2026-08 品牌统一迁站，旧域名失效）、接口路径版本号（`/v1/` `/v2/`）。
- 官方活动：起止时间必须记录（先例：码道 CodeArts 签到活动 2026-12-31 截止），临近到期的应用在 README 标注截止日。
- 接口形态变化：区分「每日签到」与「每日登录送积分」（小浣熊属后者，自动登录≠签到，风控性质不同，默认不接）。

### 4. 契约记录模板（调研结论落点）

每个候选应用记录：端点清单（方法+路径）/ 请求头（含设备头）/ 成功判定与错误码语义 / 凭证获取链路（冷启动）/ 设备与风控约束 / 社区项目链接与活跃度 / 时效性核查结论。落点：`AGENTS.md` 候选池表 + README「支持的应用」表同步状态。

**形态区分（2026-10-19 用户账本实证后新增）**：签到型（显式签到接口，自动化=调接口）/ 登录触发型（赠送积分由登录或会话建立动作触发，自动化=每日刷新会话，如 AutoClaw「用户登录奖励积分」）/ 自动发放型（服务端到点发放，无动作）。判错形态会找错接口——登录触发型去找「签到接口」会无功而返。

### 5. 实现与上线门禁

- 实现走 TDD：先写失败测试（mock fetch，seam 为 `Provider.checkin(account, ctx)`，参照 `providers/workbuddy.test.ts`），再最小实现。
- 复用优先：`core/types.ts` 的 `rotatedRefreshToken` 轮换回写机制、`core/token-rotation.ts`、workflow 的 Secret 回写——新 Provider 不重复造。
- 设备/风控头（如 Qoder 的 `Cosy-MachineToken`、Trae 的设备密钥）一律走环境变量透传，不在代码里生成或猜测值。
- **真实 token 实跑确认门禁**：接口上线前必须以真实凭证本地实跑一次；未实跑的在 provider 头注与 README 标注「成功路径待真实 token 最终确认」。
- `config.json` 加账号前确认对应环境变量已设置（`resolveAccounts` 对 disabled 账号也强制要求凭证存在，误加会导致 CI 直接失败）。

## 候选池与调研结论（2026-10-19 核验）

| 应用 | 形态 | 结论 | 关键事实 |
|---|---|---|---|
| WorkBuddy | 每日签到 | ✅ 已接入（v0） | 真实 token 实跑确认；单链轮换（单活跃执行端） |
| Qoder CN | 每日签到（活动领取） | ✅ 已接入（L1） | 三来源交叉验证；100 Credits/天，10:00 UTC+8 刷新；旧 refreshToken 不立即失效；冷启动走官方 PAT 兑换（`npm run qoder-login`，全平台通用，绕开 Windows DPAPI 本地解密——macOS 本地解密 3 轮探针无公开实现）；`jrt-`/`drt-` 双刷新端点按前缀分派；PAT 兑换 + 活动查询已真实 token 实跑（`jt-` 令牌无需 Cosy 设备头），领取路径待定时运行覆盖 |
| Trae CN | 每日签到 | ✅ 已接入（L1） | 200 积分/天；`POST api.trae.cn/trae/api/v2/ug/checkin_credits/claim`，`Authorization: Cloud-IDE-JWT <jwt>` + `x-device-id`，body `{"req_source":2}`，`code=0` 成功、`9095` 已签、`9074` 设备号不真实（判失败）、`1001/1002` 自动刷新重试；`ExchangeToken`（api.trae.com.cn）refreshToken 直换 JWT，**真实 token 实跑判决（2026-10-19）**：ClientID 走 IDE 谱系 `ono9krqynydwx5`（SOLO 谱系 `en1oxy7wnw8j9n` 会报 10101，用 `TRAE_CLIENT_ID` 覆盖）、req_source=2 有效、无需设备签名；设备号与凭证经 `npm run trae-extract` 从本机客户端一次性提取（`iCubeAuthInfo://icube-dc:<数字>` 键名取设备号，cloudide blob 解密取 refreshToken）；一设备一天限签一个账号 |
| 商汤小浣熊 | 每日自动发放 + 登录延效 | ❌ 无需自动化 | 完整模型（2026-10-19 用户账本实证）：每日积分 00:00 自动发放 +300、当日 24:00 清零；**当天登录后有效期延长至 7 天**（账本「有效期」字段：未登录日=当日，登录日=7 天后）。契约备忘：`GET xiaohuanxiong.com/api/web/office/v3/setting_info`（桌面客户端头）= 客户端启动时调用；`GET /api/web/points/v1/bills` 查账本；`POST /api/web/auth/v1/refresh` 刷新（轮换容忍）；冷启动 `~/.box-agent/config/auth.json` 明文。**教训**：「窗口内没查到」≠「不存在」——超活跃账号 100 条账单可全是当天消耗，00:00 的赠送条目被挤出窗口，曾据此误判「从未发放」；阴性结果先排查窗口与分页。开放问题：API refresh 是否算「登录」从而延效（可试：某日不碰客户端只跑 refresh，看当日发放条目有效期）；如需验证按 git history 恢复 provider（8abbd00） |
| 码道 CodeArts | 每日签到（官方活动） | ✅ 已接入（L1，实跑确认） | 每日 1000 积分，活动 2026-09-11~2026-12-31；三步签到：`GET snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE`（**必带 Agent-Type: PromptCenter**，漏了报 TM.00001001）→ `POST /v1/ops/claim`（{campaignId:1, idempotentKey, channel:"IDE"}）→ `POST /v1/ops/confirm`（{campaignId:1}）；status：ELIGIBLE+claimable=true 才领、CLAIMED=已领未确认须补、CONFIRMED/CONSUMED=已签；错误信封（error_code/error_msg 无 data）必须判失败，不能误报未开放；签名 SDK-HMAC-SHA256；冷启动 `npm run codearts-login`（OAuth PKCE + DPoP，私钥与 refresh_token 绑定同存）；refreshToken 一次性票（单活跃执行端）；**2026-10-19 真实 token 实跑**：DPoP 换票 + 签名 + delivery 解析全通（真实 campaign：campaignId 1 / 每日签到领1000积分 / type USER_LOGIN），领取路径待定时运行覆盖 |
| AutoClaw 国际版 | 每日签到（任务领取） | ✅ 已接入（L1，实跑确认） | `POST {intl}/autoclaw-proxy/proxy/autoclaw-task-complete {"task_id":"daily_signin"}`，实测 +400 积分/天、按天幂等（2026-10-19 实跑：`already_completed:false, reward_points:400`）；刷新 `/userapi/v1/refresh` body `{refresh_token, source_id:"autoclaw", device_id}`——**device_id 必须与签发时一致（JWT 内有 device_id 声明，解出回传）**，缺失报 400001；官方登录返回 `Bearer <JWT>`，收发都要剥离前缀；凭证主路径 `npm run autoclaw-intl-login -- --oauth [--vendor google]`（本地页跑官方阿里云 SDK，`window.AliyunCaptchaConfig` 必须先于脚本；滑块串原样透传勿序列化；Zai 仅认 localhost 四白名单端口的 `/auth/callback-zai`），兜底 `--from-agent2api` / `--token` |
| AutoClaw 国内版 | 登录触发型（活动制） | 🔬 假说待实验 | CN `autoclaw`（autoglm-acceleration-api.zhipuai.cn，短信登录）；赠分由登录动作触发（账本实证），无常驻签到任务，账号暂未接入 |
| QwenWork / 通义灵码 / iFlow | — | ❌ 无签到证据 | 2026-10-19 调研：无每日签到接口的社区实现，也无官方签到活动记录；额度模型非每日签到形态 |
| CatPaw / Loomy | — | ❌ 无签到 | 生态表确认无签到功能（CatPaw 另无 token 刷新机制） |

## 并发与子进程（桌面壳）

- 共享「唯一实例」资源（运行中的子进程句柄、连接池、客户端、线程池）时，「检查是否空闲」与「登记占用」必须在同一把锁（或同一 await 周期）内完成；中间夹 `spawn`、`await`、I/O 就是竞态窗口。
- 句柄被覆盖 = 进程失控：Rust `Child` 被 drop 不会杀进程。登记前必须确认没有活着的旧句柄，否则「停止」只杀得到最后一个，其余进程继续跑并发 `script-finished`，把前端 `isRunning` 提前复位。
- 前端 `isRunning`、按钮禁用属于 UX 兜底，不能当作后端正确性的前提。
- 这类状态改动按 TDD 补一条能失败的测试；确实无法构造（如需 Tauri `AppHandle`）时，在代码旁注释写明原因与手测路径（例：连点两次「一键签到全部」应得到「已有任务在运行」，再点「停止」应能结束且无残留进程）。

## 安全边界

- token 永不写入 `config.json`，只经 `tokenEnv`/`refreshTokenEnv` 从环境变量 / GitHub Secrets 读取。
- 凭证发现（L2，规划中）仅限桌面壳，仅读已注册 Provider 显式声明的白名单路径，`CHECKIN_NO_DISCOVERY=1` 可完全关闭。
- 逆向接口均非官方公开 API，上游可能随时变更；仅用于自有账号，遵守各平台服务条款。
