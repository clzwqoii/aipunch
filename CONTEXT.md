# AI 签到脚本

多个 AI 应用的每日签到工具：TypeScript 核心 + GitHub Actions 定时执行 + Tauri 2.12 桌面外壳。

## Language

**签到程序（Provider）**：
一个 AI 应用的签到实现，导出 id、元信息和 checkin 方法；接入一个新应用等于新增一个 Provider。
_Avoid_: 插件、适配器、脚本、task

**账号（Account）**：
某个 AI 应用的一份登录凭证（token/cookie）及其启用状态。
_Avoid_: 用户、凭证、cookie、配置

**签到（Check-in）**：
对一个账号执行一次其所属应用的每日签到动作，产生一条结果。
_Avoid_: 打卡、任务、job

**调度（Schedule）**：
触发签到的时间规则，CI 侧为 workflow 中的 cron 表达式（UTC），桌面侧为本地时刻。
_Avoid_: 定时器、cron、触发器

**执行记录（Run）**：
一次触发下对全部启用账号执行签到的过程与结果汇总。
_Avoid_: 日志、execution、job run

**核心（Core）**：
与 UI 无关的签到逻辑库（Provider 注册表、账号与调度模型、执行器），CI 与桌面壳共用。
_Avoid_: 引擎、SDK、lib

**桌面壳（Shell）**：
Tauri 2.12 桌面应用，职责限于配置管理、手动触发与执行记录查看。
_Avoid_: 客户端、GUI、面板

**凭证发现（Credential Discovery）**：
桌面壳读取本机受支持应用的登录态文件以自动获取 token 的能力；扫描范围仅限已注册 Provider 显式声明的白名单。
_Avoid_: 自动登录、抓取、扫描

**声明式签到（L0）**：
在配置文件中描述单个 HTTP 请求即完成接入的零代码签到形式，适用于单请求类应用。
_Avoid_: 配置即代码、JSON 脚本

**执行环境（Runner）**：
承载定时签到的运行时；本地 CLI、GitHub Actions 等均为其适配器，与「签哪个应用」（Provider）正交。
_Avoid_: 部署目标、平台、CI
