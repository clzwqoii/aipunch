# AI 签到脚本

多个 AI 应用的每日签到自动化工具：TypeScript 核心 + GitHub Actions 定时执行，Tauri 2.0 桌面壳规划中。

## 特性

- GitHub Actions 定时签到，默认北京时间每天 11:00，改一行 cron 即可自定义
- 一次运行签到 `config.json` 中**全部已配置账号**（支持多应用 × 多账号，按 `provider` 字段路由）
- WorkBuddy 签到附带积分到账对比（`积分 100→200`）与连登管家（自动兑换 7/14/28 天档位 + 抽完抽奖次数，单项失败自动降级不影响签到）
- 本地 CLI 手动签到 / `--dry-run` 预检（不发任何请求）
- 新增签到应用 = 新增一个 Provider 文件 + 一行注册
- 零密钥配置：token 只走环境变量 / GitHub Secrets，配置文件可安全提交
- 16 个单元测试覆盖核心逻辑（注册表 / 执行器 / 配置校验 / Provider）

## 快速开始

### 1. 获取 WorkBuddy 凭证（交互式登录）

> WorkBuddy 5.6.0+ 客户端已把登录态加密存储（AES-256-GCM，密钥不落盘），读文件拿 token 的路已断。本项目走**官方插件登录接口**：手机号 + 短信验证码直接换取长期凭证，不依赖桌面客户端。

```bash
npm install
npm run login
# 输入手机号 → 输入收到的验证码 → 终端打印 refreshToken
```

把打印出来的 refreshToken 设为环境变量或 GitHub Secret（名称 `WORKBUDDY_REFRESH_TOKEN`）。

> 凭证等于账号钥匙：不要发给任何人，不要提交到仓库。

### 2. 本地运行

把凭证写进 `.env`（已在 `.gitignore`，不会提交），之后命令不用再带环境变量：

```bash
cp .env.example .env
# 编辑 .env，填入 npm run login 输出的 refreshToken

npm run dry-run   # 预检：确认账号与凭证就绪
npm run checkin   # 立即签到
```

> 每次运行服务端都会轮换 refreshToken（旧值即作废）：本地运行时 CLI 会**自动把新值写回 `.env`**，无需手动操作；CI 中自动回写 Secret（需 `GH_PAT`）。排查问题可加 `--verbose` 查看每个账号的原始响应。

## 登录与凭证生命周期

- `npm run login`（手机号 + 验证码）是**冷启动**凭证获取，与浏览器/App 首次登录同理
- 之后每次签到自动用 refreshToken 换 accessToken；服务端每次刷新会轮换 refreshToken（旧值作废）
- 轮换出的新值**自动写回**：本地写 `.env`，CI 写 GitHub Secret（需 `GH_PAT`）——与桌面客户端把新登录态写回本地同思路，因此登录一次即可长期有效
- 需要重新登录的情况：refreshToken 自然到期（约 30 天）、主动退出登录/修改密码

> CI 场景不使用 `.env`，token 走 GitHub Secret；若同时存在，环境变量优先。

### 3. 配置 GitHub Actions 自动签到

1. 仓库 Settings → Secrets and variables → Actions → New repository secret，名称 `WORKBUDDY_REFRESH_TOKEN`，值填 `npm run login` 输出的 refreshToken
2. push 本仓库（`config.json` 不含密钥，可直接提交）
3. Actions 页面 → 左侧「每日签到」→ Run workflow，手动验证一次
4. （可选）轮换自动回写：服务端每次刷新都会轮换 refreshToken（旧值作废）。建一个对仓库有管理员权限的 PAT，存为 Secret `GH_PAT`，CI 会自动把新 token 写回 `WORKBUDDY_REFRESH_TOKEN`；不配则轮换时 Actions 出 warning 提示手动更新

之后每天定时自动执行，**本地无需开机、无需常驻任何程序**。定时规则在 `.github/workflows/checkin.yml`：

| 北京时间 | UTC cron |
|---|---|
| 08:00 | `0 0 * * *` |
| 09:00 | `0 1 * * *` |
| **11:00（默认）** | **`0 3 * * *`** |
| 21:00 | `0 13 * * *` |

GitHub Actions 的 cron 使用 UTC（= 北京时间 - 8 小时），最小间隔 5 分钟；仓库 60 天无活动时定时流会被停用，偶尔手动触发一次即可保活。

## 支持的应用

| 应用 | 状态 | 说明 |
|---|---|---|
| WorkBuddy | 可用 | 每日签到 + 积分到账对比 + 连登管家（兑换/抽奖）；接口经多个公开来源交叉验证，成功路径待真实 token 最终确认 |
| 商汤小浣熊 / Qoder / Trae / 码道 CodeArts | 规划中 | 接口待调研 |

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
- [x] refreshToken 自动续期（CI 无人值守的前提；端点待真实 token 最终验证）
- [ ] L0 声明式 Provider（零代码接入单请求类应用）
- [ ] L2 凭证发现（桌面壳自动填 token + 隐私开关）
- [ ] Tauri 2.0 桌面壳（配置管理 / 手动触发 / 执行记录）
- [ ] 云端执行环境适配（Runner）：壳内一键部署到 GitHub Actions、导出青龙面板等，见 `docs/adr/0003`

## 设计参考与致谢

- [yetone/magpie](https://github.com/yetone/magpie)（MIT）：参考了其「三类来源」心智模型（API 密钥 / 订阅发现 / 本地兼容 URL）、本地登录态发现思路、隐私开关设计（`MAGPIE_NO_ACCOUNTS` → `CHECKIN_NO_DISCOVERY`）以及「只展示已检测到应用」的 UX 思路；未采纳其网关协议转换、路由组与 Bun 插件沙箱，理由见 `docs/adr/0002-provider-extension-model.md`

## License

[MIT](LICENSE)
