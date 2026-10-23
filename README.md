# AIPunch

> 给 AI 应用自动打卡

多个 AI 应用的每日签到工具：TypeScript 核心 + GitHub Actions 定时执行 + Tauri 2.12 桌面壳。

**桌面壳是主推使用方式**（配置管理 / 手动触发 / 执行记录，v1 开发中）；当前版本可经命令行与 GitHub Actions 使用，三者共用同一签到核心。

## 特性

- 桌面壳（v1，开发中）：账号与调度配置、手动触发、执行记录查看；凭证自动发现（仅读已注册 Provider 声明的白名单，隐私开关可完全关闭）
- GitHub Actions 定时签到，默认北京时间每天 11:00，改一行 cron 即可自定义
- 一次运行签到 `config.json` 中**全部已配置账号**（支持多应用 × 多账号，按 `provider` 字段路由）
- WorkBuddy 签到附带积分到账对比（`积分 100→200`）与连登管家（自动兑换 7/14/28 天档位 + 抽完抽奖次数，单项失败自动降级不影响签到）
- 本地 CLI 手动签到 / `--dry-run` 预检（不发任何请求）
- 新增签到应用 = 新增一个 Provider 文件 + 一行注册
- 零密钥配置：token 只走环境变量 / GitHub Secrets，配置文件可安全提交
- 78 个单元测试覆盖核心逻辑（注册表 / 执行器 / 配置校验 / Provider）

## 支持的应用

| 应用 | 官网 | 积分形态 | 状态 | 说明 |
|---|---|---|---|---|
| WorkBuddy | [workbuddy.cn](https://www.workbuddy.cn) | 每日签到 | 可用 | 每日签到 + 积分到账对比 + 连登管家（兑换/抽奖）；真实 token 实跑确认 |
| Qoder CN | [qoder.com.cn](https://qoder.com.cn) | 每日签到（活动领取） | 可用 | CLAIM_BENEFIT 活动领取，100 Credits/天，10:00（UTC+8）刷新；PAT 兑换 + 活动查询已真实 token 实跑确认，领取路径待定时运行覆盖 |
| Trae CN | [trae.cn](https://www.trae.cn) | 每日签到 | 可用 | 200 积分/天；`npm run trae-login` 浏览器授权（独立会话，与本机客户端互不影响）；`npm run trae-extract` 提取客户端登录态（备选，与客户端共享会话） |
| AutoClaw 国际版 | [autoclaw.z.ai](https://autoclaw.z.ai) | 每日签到（任务领取） | 可用 | `daily_signin` 任务，实测 +400 积分/天；`npm run autoclaw-intl-login -- --oauth` 浏览器官方授权（阿里云滑块 + 本地回调）；真实 token 实跑确认 |
| AutoClaw 国内版 | [autoclaw.zhipuai.cn](https://autoclaw.zhipuai.cn) | 登录触发（活动制） | 🔬 待验证 | 赠送积分由登录动作触发（用户账本实证），无常驻签到任务；Provider 每日刷新会话即登录动作，账号暂未接入 |
| 码道 CodeArts | [huaweicloud.com/codearts](https://www.huaweicloud.com/product/codearts.html) | 每日签到（官方活动） | 可用 | 每日 1000 积分，2026-12-31 截止；三步签到（delivery→claim→confirm）；`npm run codearts-login` 浏览器授权；DPoP 换票 + HMAC 签名链路实跑确认，领取路径待定时运行覆盖 |
| 商汤小浣熊 | [xiaohuanxiong.com](https://www.xiaohuanxiong.com) | 每日自动发放 | 无需自动化 | 每日积分每天 00:00 自动发放 +300，默认当日 24:00 清零；当天登录后有效期延长至 7 天（用户账本实证：未登录日「有效期至当日」，登录日「延至 7 天后」）。发放无需动作，登录延效非签到形态，不接 |

## 桌面壳（主推使用方式）

Tauri 2.12 桌面应用是主推形态：把「配账号、看记录、手动跑一次」做成图形界面，凭证自动发现从本机已安装客户端直接导入 token。安装包 <10MB、常驻内存约 30–50MB，覆盖桌面三端。选型理由与职责边界见 [`docs/adr/0001-tauri-shell-and-ts-core.md`](docs/adr/0001-tauri-shell-and-ts-core.md)。

> 「一键签到」触发 GitHub Actions 执行并实时回显结果（`npm run ci-checkin`）：凭证是单次轮换票，执行端必须唯一，桌面端只做触发与展示。使用前需安装并登录 `gh` CLI（`brew install gh && gh auth login`）；环境自检：`npm run ci-checkin -- --check`（未装/未登录/无仓库权限都会给出下一步）。

> 状态：**v1 开发中，尚未发布**。当前请先用下面的命令行方式——核心逻辑（`core/`）与桌面壳完全共用，壳发布后零迁移成本。

## 命令行使用

### 1. 获取凭证

#### WorkBuddy（交互式登录）

> WorkBuddy 5.6.0+ 客户端已把登录态加密存储（AES-256-GCM，密钥不落盘），读文件拿 token 的路已断。本项目走**官方插件登录接口**：手机号 + 短信验证码直接换取长期凭证，不依赖桌面客户端。

```bash
npm install
npm run login
# 输入手机号 → 输入收到的验证码 → refreshToken 自动写入本地 .env
```

登录成功后 `WORKBUDDY_REFRESH_TOKEN` 已写入 `.env`，无需手动复制。要放进 GitHub Secret 时用
`npm run login -- --print`：只打印 token，不落盘。

> 凭证等于账号钥匙：不要发给任何人，不要提交到仓库。

#### Trae（浏览器授权，推荐）

```bash
npm run trae-login
# 打开 www.trae.cn/authorization → 登录并允许授权 → 本地回调自动收取凭证
# 写入 .env（TRAE_REFRESH_TOKEN / TRAE_DEVICE_ID / TRAE_MACHINE_ID / TRAE_USER_ID），终端只显示掩码
# 放进 GitHub Secret 用 `npm run trae-login -- --print`
```

浏览器授权签发独立会话（新设备指纹：deviceId + machineId），与本机 Trae 客户端各有一条
refreshToken 轮换链，**互不影响**：客户端随便用，CI 不会因此掉线。设备号一天限签一个账号。
签到请求会带齐 IDE 的设备指纹头（`x-device-id`/`x-machine-id`/`x-uid`/app-id/版本/品牌）——
缺了会被判 `9074`（2026-10-23 实跑确认的真因）。

#### Trae（客户端登录态提取，备选）

```bash
npm run trae-extract
# 自动定位本机 Trae CN / SOLO / TraeWork 的 storage.json，
# 解出设备号（键名，无需解密）与 refreshToken（AES-128-CBC + SHA-512 派生解密），
# 写入 .env（TRAE_REFRESH_TOKEN / TRAE_DEVICE_ID / TRAE_USER_ID），终端只显示掩码
```

只读、不联网、不修改客户端文件。设备号 = 客户端真实注册号（纯十进制 12–20 位），UUID 形态会被服务端拒绝（`9074`）；一个设备号一天限签一个账号。**注意：这条路与客户端共享同一会话**——客户端一刷新，提取出来的 refreshToken 即作废，CI 会掉线；需要与客户端共存时用上面的 `trae-login`。这条路不产出 `TRAE_MACHINE_ID`，签到仍会因设备指纹不全被判 `9074`，仅作应急兜底。

#### Qoder（PAT 兑换）

Qoder CN 有官方 PAT 通道，无需本地解密，全平台通用（与 WorkBuddy 插件登录同定位）：

```bash
QODER_PAT=pt-xxx npm run qoder-login
# PAT 在 Qoder 控制台 → 设置 → API 令牌创建（pt- 前缀，仅显示一次，注意保密）
# 兑换出 jrt- 刷新令牌写入 .env（QODER_REFRESH_TOKEN / QODER_TOKEN）
```

`config.json` 加账号：`{ "provider": "qoder", "name": "main", "refreshTokenEnv": "QODER_REFRESH_TOKEN", "enabled": true }`

奖励规则：每天 10:00（UTC+8）刷新，100 Credits/天，服务端幂等（重复领取返回 `replayed`，不重复到账）；刷新时轮换 refreshToken 但**旧值不立即失效**，两端可短暂并存。若活动列表为空（服务端设备识别），可设 `QODER_COSY_MACHINE_TOKEN` 等设备头环境变量（见 `providers/qoder.ts` 的 `MACHINE_HEADERS` 映射）。

#### AutoClaw（短信登录）

```bash
npm run autoclaw-login
# 手机号 + 短信验证码 → 写入 .env（AUTOCLAW_REFRESH_TOKEN）
```

登录响应不带 expiresAt，按约 28 天估算，期间每次签到自动刷新续期。

**国际版（autoclaw.z.ai）**：API 契约与国内版同构，Provider 为独立的 `autoclaw-intl`（两账号可并存）。但国际版登录是 Zai/Google OAuth 且带阿里云风控验证码（`zai-oauth-url` 强制校验 `ali_captcha_verify_param`，实测不可绕过），纯 CLI 无法自动化，凭证需手工获取后注入：

**获取 refreshToken（浏览器官方授权）**

```bash
npm run autoclaw-intl-login -- --oauth                 # Zai 授权（默认）
npm run autoclaw-intl-login -- --oauth --vendor google # Google 授权
```

流程：本地起验证码页（官方阿里云 SDK）→ 你点「开始验证」拖滑块 → 自动打开官方登录页 → 登录后回调本地 → 换 refreshToken 写入 `.env`。**账号密码只输入在官方页面**，本工具不接触；回调走 Zai 登记的 loopback 端口（19654/19723/53699/18432，自动挑空闲的）。

兜底（已有 token 或不想走浏览器时）：`--from-agent2api`（从 Agent2API 账号库只读导入）、`--token <rt>`、无参数粘贴。

> 刷新时 refreshToken 会轮换（一次性），与 WorkBuddy/码道相同的单活跃执行端约束：CI 为唯一执行端，本地只跑 `dry-run`。刷新必须回传 token 内声明的 `device_id`，否则报 `400001`（Provider 已自动处理）。

产物写入 `.env` 的 `AUTOCLAW_INTL_REFRESH_TOKEN`（`--print` 只打印不落盘）。仅有 access token 时可改用 `tokenEnv`（适合本地单次，到期需重取）。可选 `AUTOCLAW_INTL_USERAPI_BASE_URL` 覆盖基础地址。

`config.json` 加账号（二选一）：

```json
{ "provider": "autoclaw-intl", "name": "main", "refreshTokenEnv": "AUTOCLAW_INTL_REFRESH_TOKEN", "enabled": true }
{ "provider": "autoclaw-intl", "name": "main", "tokenEnv": "AUTOCLAW_INTL_TOKEN", "enabled": true }
```

#### 码道 CodeArts（浏览器授权登录）

```bash
npm run codearts-login
# 自动打开华为云授权页 → 登录并授权 → 换 STS 临时凭据写入 .env
# （CODEARTS_REFRESH_TOKEN / CODEARTS_DPOP_KEY / CODEARTS_CODE_VERIFIER）
```

DPoP 私钥与 refreshToken 绑定，三个值必须一起配置（CI 侧对应三个 Secret）。`config.json` 加账号：`{ "provider": "codearts", "name": "main", "refreshTokenEnv": "CODEARTS_REFRESH_TOKEN", "enabled": true }`

> refreshToken 是**一次性票**（每次刷新轮换、旧值作废）：与 WorkBuddy 相同的单活跃执行端约束，CI 为唯一执行端，本地只跑 `dry-run`。

### 2. 本地运行

把凭证写进 `.env`（已在 `.gitignore`，不会提交），之后命令不用再带环境变量：

```bash
cp .env.example .env
# npm run login 已自动把 WORKBUDDY_REFRESH_TOKEN 写入 .env，其余凭证按上文各应用说明填入

npm run dry-run   # 预检：确认账号与凭证就绪
npm run checkin   # 立即签到
```

> 每次运行服务端都会轮换 refreshToken（旧值即作废）：本地运行时 CLI 会**自动把新值写回 `.env`**（只改对应行，其他 Provider 的值不动），无需手动操作；CI 中自动回写 Secret（需 `GH_PAT`）。排查问题可加 `--verbose` 查看每个账号的原始响应。

### 3. 登录与凭证生命周期

- `npm run login`（手机号 + 验证码）是**冷启动**凭证获取，与浏览器/App 首次登录同理
- 之后每次签到自动用 refreshToken 换 accessToken；服务端每次刷新会轮换 refreshToken（旧值作废）
- 轮换出的新值**自动写回**：本地写 `.env`，CI 写 GitHub Secret（需 `GH_PAT`）——与桌面客户端把新登录态写回本地同思路，因此登录一次即可长期有效
- **单活跃执行端约束**：轮换是单链式的（旧值立即作废），同一账号同时只能有一个执行端持有有效 token。推荐 CI 为唯一执行端；本地跑过一次签到后，需把 `.env` 的新值同步到 Secret（或反之），否则另一端下次运行会失败
- 需要重新登录的情况：refreshToken 自然到期（约 30 天）、主动退出登录/修改密码

> CI 场景不使用 `.env`，token 走 GitHub Secret；若同时存在，环境变量优先。

### 4. 配置 GitHub Actions 自动签到

1. 仓库 Settings → Secrets and variables → Actions → New repository secret，按上面各应用的凭证说明添加对应 Secret（如 `WORKBUDDY_REFRESH_TOKEN`、`TRAE_REFRESH_TOKEN` + `TRAE_DEVICE_ID` + `TRAE_MACHINE_ID` + `TRAE_USER_ID`）
2. push 本仓库（`config.json` 不含密钥，可直接提交）
3. Actions 页面 → 左侧「每日签到」→ Run workflow，手动验证一次
4. **轮换自动回写（必配）**：服务端每次刷新都会轮换 refreshToken（旧值即作废），CI 靠 `GH_PAT` 自动把新值写回对应 Secret。创建方法：
   1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
   2. Token name 随意（如 `aipunch-gh-pat`）；Resource owner 保持自己的账号；Expiration 选 1 year（到期前换新的）
   3. Repository access 选 **Only select repositories** → 只勾本仓库（不要选 All repositories）
   4. Permissions → Repository permissions：只把 **Secrets** 改为 **Read and write**，其他全部保持默认（Contents 等不用给，`gh secret set` 只需要 Secrets 写权限）
   5. Generate token → 复制 `github_pat_` 开头的串 → 仓库 Settings → Secrets → New repository secret，Name 填 `GH_PAT`

   验证闭环：手动触发一次工作流，日志出现「检测到 refreshToken 轮换，回写 Secret」且 Secret 的更新时间戳变新，即成立。

   **不配的后果**：轮换出的新值只存在于 CI 临时文件（日志不打印 token），Secret 中的旧值已作废——下一次定时运行会全部刷新失败，只能重新 `npm run login` 并手动更新 Secret

之后每天定时自动执行，**本地无需开机、无需常驻任何程序**。定时规则在 `.github/workflows/checkin.yml`：

| 北京时间 | UTC cron |
|---|---|
| 08:00 | `0 0 * * *` |
| 09:00 | `0 1 * * *` |
| **11:00（默认）** | **`0 3 * * *`** |
| 21:00 | `0 13 * * *` |

GitHub Actions 的 cron 使用 UTC（= 北京时间 - 8 小时），最小间隔 5 分钟；仓库 60 天无活动时定时流会被停用，偶尔手动触发一次即可保活。

## 架构

```
core/       纯 TS 库：类型 / Provider 注册表 / 执行器 / 配置加载（CI 与桌面壳共用）
providers/  每个 AI 应用一个签到程序；providers/index.ts 统一注册
runners/    CLI 入口（GitHub Actions 与本地共用同一份代码）
.github/    Actions 定时工作流
```

执行流：调度（cron 或手动触发）→ 按 `config.json` 筛选启用的账号 → 逐账号调用对应 Provider → 汇总结果，任一失败则退出码 1（CI 标记失败）。

核心接口：

```ts
interface Provider {
  id: string;
  name: string;
  checkin(account: Account, ctx: RunContext): Promise<CheckinResult>;
}
```

新增账号：编辑 `config.json` 的 `accounts` 数组，`tokenEnv` 指向环境变量名（与 Secret 名一致）。

## 如何新增一个签到应用

1. 在 `providers/` 新建 `yourapp.ts`，实现 `Provider` 接口（参考 `workbuddy.ts`）
2. 在 `providers/index.ts` 加一行 `register(yourapp)`
3. 在 `providers/yourapp.test.ts` 用 mock fetch 写测试（先 RED 后 GREEN）
4. `config.json` 的 `accounts` 里加账号，`tokenEnv` 指向新 Secret 名
5. `.github/workflows/checkin.yml` 的 env 里加一行 Secret 注入

复杂应用（多步请求 / 签名 / token 刷新）直接使用 L1 代码 Provider；更轻的单请求类应用后续支持 L0 纯配置声明式接入（见路线图）。

## 安全说明

- token 永不写入 `config.json`，只经 `tokenEnv` 从环境变量 / GitHub Secrets 读取，缺失时启动即报错
- 凭证发现（规划中，仅桌面壳）只读**已注册 Provider 显式声明**的登录态文件白名单，可用 `CHECKIN_NO_DISCOVERY=1` 完全关闭
- 请遵守各平台服务条款，仅用于自己的账号

## 路线图

- [x] v0：核心 + CLI + GitHub Actions + WorkBuddy Provider
- [x] refreshToken 自动续期（CI 无人值守的前提；已真实 token 验证）
- [x] 第 2 个 Provider：Qoder CN（L1；PAT 兑换 + 活动查询实跑确认，领取路径待定时运行覆盖）
- [x] 第 3 个 Provider：Trae CN（L1；真实 token 实跑确认）
- [x] 第 4 个 Provider：AutoClaw（L1；契约双来源，登录路径待真实 token 确认）
- [ ] L0 声明式 Provider（零代码接入单请求类应用；等单请求类应用真实样本）
- [ ] L2 凭证发现（桌面壳自动填 token + 隐私开关）
- [ ] Tauri 2.12 桌面壳（配置管理 / 手动触发 / 执行记录）
- [ ] 云端执行环境适配（Runner）：壳内一键部署到 GitHub Actions、导出青龙面板等，见 `docs/adr/0003`

## 设计参考与致谢

- [yetone/magpie](https://github.com/yetone/magpie)（MIT）：参考了其「三类来源」心智模型（API 密钥 / 订阅发现 / 本地兼容 URL）、本地登录态发现思路、隐私开关设计（`MAGPIE_NO_ACCOUNTS` → `CHECKIN_NO_DISCOVERY`）以及「只展示已检测到应用」的 UX 思路；未采纳其网关协议转换、路由组与 Bun 插件沙箱，理由见 `docs/adr/0002-provider-extension-model.md`

## License

[MIT](LICENSE)
