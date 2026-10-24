// ========================================================
// AIPunch Desktop Shell i18n Dictionary
// 支持简体中文 (zh-CN) 与英文 (en-US)，默认简体中文
// ========================================================

export type Lang = "zh" | "en";

export const translations = {
  zh: {
    brandSub: "多平台自动签到中枢",
    navGroupTitle: "工作台导航",
    searchPlaceholder: "搜索账号或平台...",
    navAccounts: "账号管理",
    navCloud: "云端 CI",
    navCredentials: "凭证导入",
    navPrivacy: "隐私设置",
    activeBadge: "个已启用",
    themeSwitcher: "主题外观",
    themeLight: "浅色",
    themeDark: "深色",

    heroTitle: "每日签到总览",
    heroDesc: "TypeScript Core 原生驱动 · 多平台定时自动签到与凭据轮换",
    heroPtsLabel: "今日签到",
    heroRunAll: "一键签到全部",
    heroAllDone: "今日已全部签到",
    heroRunning: "正在执行签到...",
    heroPrivacy: "本地发现防护",
    heroReady: "就绪待运行",
    heroFinished: "执行完成 (0)",
    heroFinishedCode: "执行结束 (代码 {code})",

    sectionProvidersTitle: "已接入平台矩阵",
    sectionProvidersSub: "独立开关控制与单平台即时签到调试",

    cardReady: "已就绪",
    cardBalance: "余额",
    cardDone: "今日已签",
    cardLinked: "已连接",
    cardUnset: "未配置凭证",
    cardAuthBtn: "一键授权向导",
    cardRunSingle: "单跑",

    traeHint: "+200 积分/天",
    qoderHint: "100 Credits/天",
    codeartsHint: "+1000 积分/天",
    workbuddyHint: "每日连续签到",
    autoclawHint: "+400 积分/天",
    autoclawCnHint: "国内版待验证",
    unknownHint: "待确认",

    termTitle: "实时开发者控制台",
    termClear: "清屏",
    termStop: "停止",
    termCollapse: "收起 ✕",
    termExpand: "控制台 ↗",
    termInit: "[系统] AIPunch 桌面外壳就绪，Core 引擎已连接。",
    termReady: "[就绪] 点击「一键签到全部」或单项「一键授权」开始执行。",

    historyTitle: "执行记录",
    historySub: "历史签到汇总、收益到账与耗时明细",
    historyEmpty: "暂无执行记录：点击「一键签到全部」或等待定时任务。",
    historySkipped: "已签跳过",
    credValid: "凭证有效",

    cloudTitle: "云端 CI",
    cloudSub: "平台绑定、状态同步与运行记录（单执行端单选）",
    cloudRefresh: "立即刷新",
    cloudSyncNever: "尚未同步，点击「立即刷新」拉取云端结果",
    cloudSyncedAt: "最后同步 {time} · 今日已签 {done}/{total}",
    cloudSyncing: "正在同步云端结果...",
    cloudPlatformTitle: "执行平台",
    cloudScheduleLabel: "定时执行",
    cloudScheduleSave: "保存定时",
    cloudPlatformSub: "云端平台无需启动本应用也按时自动签到 · 凭证是单次轮换票，同一时间只能有一个执行端",
    cloudPlatformLocal: "本地执行",
    cloudPlatformLocalDesc: "内置引擎在本机签到，轮换票自动写回本地；app 不开则不签",
    cloudPlatformGithubDesc: "云端定时+触发执行，结果自动拉取同步到本地",
    cloudPlatformCfDesc: "零仓库云端执行端：粘贴 API Token 即部署，无需 GitHub；每日定时自动执行",
    cloudSwitchToLocal: "已切换为本地执行：签到将在本机运行并自动回写轮换票；云端定时产生的结果下次同步可见",
    cloudSwitchToCloud: "已切换为 GitHub Actions：签到回到云端执行；若本地曾轮换凭证，云端 Secrets 可能已落后，失败时请重新导入",
    cloudSwitchToCf: "已切换为 Cloudflare Workers：签到在 CF 定时执行（未部署时先点卡片上的 ⚙ 部署）",
    cfDeployBadge: "⚙ 部署",
    cfDeployTitle: "部署到 Cloudflare Workers",
    cfDeploySub: "粘贴 Cloudflare 凭证即可代部署（KV + 脚本 + Secrets + 定时），无需安装 wrangler",
    cfTokenLabel: "API Token",
    cfAccountLabel: "Account ID",
    cfTokenPlaceholder: "Workers Scripts:Edit + Workers KV Storage:Edit 权限",
    cfAccountPlaceholder: "控制台右侧栏 Account ID",
    cfDeployBtn: "部署",
    cfDeployNote: "定时沿用上方「定时执行」的小时与时区；凭证在本机 .env 留存，部署后重复操作无需重贴。",
    cloudAutoNote: "云端 CI 由 GitHub Actions 按仓库 workflow 每日定时自动执行，无需启动本应用；本页用于切换执行端、查看状态与手动触发。",
    cloudConfigTitle: "GitHub Actions 配置",
    cloudConfigSub: "云端执行端所需，配置一次即可",
    cloudConfigBadge: "⚙ 配置",
    cloudConfigCheck: "检查配置",
    cloudConfigRepoMissing: "⚠ 仓库未配置：请在数据目录 config.json 顶层添加 \"repo\": \"owner/name\"",
    cloudConfigRepoReady: "仓库 {repo} · 点击「检查配置」验证 gh 登录与仓库权限",
    cloudConfigOk: "✓ 环境正常：gh 已登录，仓库 {repo} 可访问",
    cloudConfigFail: "✗ 检查未通过：详情见终端日志",
    cloudConfigStep1: "GitHub 上 Fork 或使用本仓库，在 Settings → Secrets and variables → Actions 添加各平台 token 与 GH_PAT（轮换票回写用）",
    cloudConfigStep2: "启用 Actions：checkin.yml 每日定时自动签到，无需启动本应用，结果由本页「立即刷新」拉取",
    cloudConfigStep3: "本应用数据目录的 config.json 设置 \"repo\": \"owner/name\"（当前生效的执行仓库）",
    cloudConfigStep4: "本机安装 gh CLI 并运行 gh auth login（手动触发与同步需要；macOS：brew install gh）",
    cloudConfigStep5: "点击「检查配置」逐项验证",

    credTitle: "凭证一键导入向导",
    credSub: "六大官方授权向导，零手动抓包配置",
    credQoderTitle: "Qoder PAT 官方兑换",
    credQoderDesc: "输入开发者个人访问令牌（PAT），一键兑换并自动回写凭证。",
    credQoderBtn: "启动 PAT 兑换向导",

    credTraeTitle: "Trae 本地凭证提取",
    credTraeDesc: "从本机客户端已登录存储直接解密读取设备号与 Refresh Token。",
    credTraeBtn: "一键提取本机凭证",

    credCodeartsTitle: "码道 CodeArts 授权",
    credCodeartsDesc: "调起浏览器完成 OAuth PKCE 授权，自动生成与绑定 DPoP 密钥对。",
    credCodeartsBtn: "启动 OAuth 授权向导",

    credAutoclawTitle: "AutoClaw 国际版授权",
    credAutoclawDesc: "调起官方安全验证并绑定设备 ID，自动保存刷新令牌。",
    credAutoclawBtn: "启动授权向导",

    credWorkbuddyTitle: "WorkBuddy 短信登录",
    credWorkbuddyDesc: "输入手机号获取短信验证码，一键获取并保存刷新令牌。",
    credWorkbuddyBtn: "启动短信登录向导",

    credAutoclawCnTitle: "AutoClaw 国内版登录",
    credAutoclawCnDesc: "智谱 AutoGLM 国内版短信验证码登录，支持自动回写凭据。",
    credAutoclawCnBtn: "启动国内版登录向导",

    modalPhoneLabel: "手机号（11 位）",
    modalCodeLabel: "短信验证码",
    modalSendSms: "发送验证码",
    modalSending: "正在发送...",
    modalSent: "已发送 ({seconds}s)",

    wizardQoderTitle: "⚡ Qoder PAT 官方自动兑换",
    wizardQoderPlaceholder: "输入从控制台复制的 PAT",
    wizardQoderBtn: "官方兑换",
    wizardCodeartsTitle: "⚡ 浏览器 OAuth PKCE 授权",
    wizardCodeartsDesc: "启动华为云官方 OAuth 流程，支持华为账号扫码并自动签发 DPoP 私钥。",
    wizardCodeartsBtn: "启动 OAuth 授权向导",
    wizardAutoclawTitle: "⚡ AutoClaw 国际版 OAuth / Google 授权",
    wizardAutoclawDesc: "启动国际版验证服务，支持 Google 账号登录并绑定设备凭据。",
    wizardAutoclawBtn: "启动国际版向导",
    wizardSmsTitleWorkbuddy: "📱 WorkBuddy 短信快捷登录",
    wizardSmsTitleAutoclaw: "📱 AutoClaw 国内版短信快捷登录",
    wizardPhonePlaceholder: "11 位手机号",
    wizardCodePlaceholder: "6 位验证码",
    wizardSmsLoginBtn: "登录并保存",
    manualTokenDesc: "已有 Token？直接粘贴下方文本框，一键保存至本地 .env 环境。",

    privacyTitle: "隐私与本地发现",
    privacySub: "安全边界与本机登录态探测策略",
    privacyItemTitle: "禁止本地凭证扫描 (CHECKIN_NO_DISCOVERY)",
    privacyItemDesc: "开启后，完全禁止桌面壳探测本机其他桌面应用的登录文件，仅依赖显式配置的环境变量。",
    rootTitle: "执行引擎目录",
    rootDataTitle: "数据目录",
    rootDataDesc: "内置引擎已随安装包提供；此处保存凭证（.env）、config.json 与运行记录。",
    rootDesc: "签到由该目录下的 Node 脚本执行，需包含 config.json 与 package.json。安装包只含界面，不含执行引擎。",
    rootSave: "保存并重载",

    tabBrowser: "🌐 官方网页/浏览器登录",
    tabLocalApp: "💻 本地客户端 / 一键提取",
    tabManual: "🔑 快捷验证 / 手动填入",
    btnOpenOfficialWeb: "打开官方网页登录",
    btnOpenLocalApp: "调起本机客户端应用",
    manualTokenPlaceholder: "直接粘贴 Refresh Token 或凭据字符串",
    btnSaveManualToken: "保存凭据到本地环境",
    tokenSavedSuccess: "[成功] 凭据已写入本地环境 (.env)",

    modalCancel: "取消",
    modalConfirm: "确认并执行",

    checkUpdate: "检查更新",
    checkingUpdate: "检查中...",
    updateLatest: "已是最新版",
    updateFound: "发现新版 {version}",
    updateInstall: "下载并安装 v{version}",
    updateDialogTitle: "发现新版本",
    updateLater: "稍后",
    updateDownloading: "下载中 {percent}%",
    updateReady: "就绪，点击重启",
    updateFailed: "检查失败",
  },
  en: {
    brandSub: "Automated Check-in Hub",
    navGroupTitle: "WORKSPACE",
    searchPlaceholder: "Search accounts or providers...",
    navAccounts: "Accounts",
    navCloud: "Cloud CI",
    navCredentials: "Credentials Import",
    navPrivacy: "Privacy Settings",
    activeBadge: "Active",
    themeSwitcher: "Theme Switcher",
    themeLight: "Light",
    themeDark: "Dark",

    heroTitle: "Daily Check-in Summary",
    heroDesc: "Powered by TypeScript Core · Multi-platform automated check-in & token rotation",
    heroPtsLabel: "check-ins",
    heroRunAll: "Run All Check-Ins",
    heroAllDone: "All checked in",
    heroRunning: "Running Check-Ins...",
    heroPrivacy: "Privacy Protection",
    heroReady: "Ready to run",
    heroFinished: "Execution completed (0)",
    heroFinishedCode: "Finished with code {code}",

    sectionProvidersTitle: "Connected Providers",
    sectionProvidersSub: "Per-account toggle and instant single-provider check-in",

    cardReady: "Ready",
    cardBalance: "Balance",
    cardDone: "Checked in",
    cardLinked: "Linked",
    cardUnset: "Unconfigured",
    cardAuthBtn: "1-Click Auth",
    cardRunSingle: "Run",

    traeHint: "+200 pts/day",
    qoderHint: "100 Credits/day",
    codeartsHint: "+1000 pts/day",
    workbuddyHint: "Daily Check-in",
    autoclawHint: "+400 pts/day",
    autoclawCnHint: "CN version pending",
    unknownHint: "Unknown",

    termTitle: "Live Developer Terminal",
    termClear: "Clear",
    termStop: "Stop",
    termCollapse: "Collapse ✕",
    termExpand: "Terminal ↗",
    termInit: "[SYSTEM] AIPunch Desktop Shell ready, Core engine connected.",
    termReady: "[READY] Click 'Run All Check-Ins' or '1-Click Auth' to start.",

    historyTitle: "Run History",
    historySub: "Execution summaries, credit records, and duration details",
    historyEmpty: "No runs yet — click Run All or wait for the scheduled run.",
    historySkipped: "Skipped (already checked in)",
    credValid: "Valid",

    cloudTitle: "Cloud CI",
    cloudSub: "Platform binding, state sync, and run history (single executor)",
    cloudRefresh: "Refresh Now",
    cloudSyncNever: "Not synced yet — click Refresh to pull cloud results",
    cloudSyncedAt: "Last sync {time} · checked in {done}/{total} today",
    cloudSyncing: "Syncing cloud results...",
    cloudPlatformTitle: "Executor Platform",
    cloudScheduleLabel: "Schedule",
    cloudScheduleSave: "Save",
    cloudPlatformSub: "Cloud executors check in on schedule without this app · refresh tokens are single-use; only one executor at a time",
    cloudPlatformLocal: "Local Engine",
    cloudPlatformLocalDesc: "Runs check-ins on this machine; rotated tokens written back locally. No runs while the app is closed",
    cloudPlatformGithubDesc: "Scheduled & triggered in the cloud; results pulled back automatically",
    cloudPlatformCfDesc: "Repository-free cloud executor: paste an API Token to deploy, no GitHub needed; runs daily on schedule",
    cloudSwitchToLocal: "Switched to local execution: check-ins now run on this machine with automatic token write-back; scheduled cloud results appear after the next sync",
    cloudSwitchToCloud: "Switched to GitHub Actions: check-ins run in the cloud again; if tokens were rotated locally, cloud Secrets may be stale — re-import if failures occur",
    cloudSwitchToCf: "Switched to Cloudflare Workers: check-ins run on CF schedules (deploy first via ⚙ on the card if not yet deployed)",
    cfDeployBadge: "⚙ Deploy",
    cfDeployTitle: "Deploy to Cloudflare Workers",
    cfDeploySub: "Paste Cloudflare credentials for a full deploy (KV + script + Secrets + schedule); no wrangler needed",
    cfTokenLabel: "API Token",
    cfAccountLabel: "Account ID",
    cfTokenPlaceholder: "Needs Workers Scripts:Edit + Workers KV Storage:Edit",
    cfAccountPlaceholder: "Account ID from the dashboard sidebar",
    cfDeployBtn: "Deploy",
    cfDeployNote: "Schedule follows the hour/timezone above; credentials persist in local .env — no need to re-paste after the first deploy.",
    cloudAutoNote: "Cloud CI runs automatically on schedule via GitHub Actions — no need to keep this app open. Use this page to switch executor, view status, or trigger runs manually.",
    cloudConfigTitle: "GitHub Actions Setup",
    cloudConfigSub: "Required for the cloud executor; configure once",
    cloudConfigBadge: "⚙ Setup",
    cloudConfigCheck: "Check Setup",
    cloudConfigRepoMissing: "⚠ Repository not configured: add \"repo\": \"owner/name\" to config.json in the data directory",
    cloudConfigRepoReady: "Repository {repo} · click \"Check Setup\" to verify gh login and repo access",
    cloudConfigOk: "✓ Environment OK: gh logged in, repository {repo} accessible",
    cloudConfigFail: "✗ Check failed: see terminal log for details",
    cloudConfigStep1: "Fork or use this repository on GitHub; add platform tokens and GH_PAT under Settings → Secrets and variables → Actions (for token write-back)",
    cloudConfigStep2: "Enable Actions: checkin.yml runs daily on schedule without this app; results are pulled in via \"Refresh Now\"",
    cloudConfigStep3: "Set \"repo\": \"owner/name\" in config.json under the app's data directory (the repository check-ins run against)",
    cloudConfigStep4: "Install the gh CLI and run gh auth login locally (needed for manual triggers and sync; macOS: brew install gh)",
    cloudConfigStep5: "Click \"Check Setup\" to verify each item",

    credTitle: "Credentials Import",
    credSub: "Six official authentication wizards, zero manual packet inspection",
    credQoderTitle: "Qoder PAT Exchange",
    credQoderDesc: "Enter your Personal Access Token to exchange and save credentials automatically.",
    credQoderBtn: "Start PAT Wizard",

    credTraeTitle: "Trae Local Extract",
    credTraeDesc: "Decrypt and extract device ID and refresh token from local client storage.",
    credTraeBtn: "Extract Local Credentials",

    credCodeartsTitle: "CodeArts PKCE Auth",
    credCodeartsDesc: "Launch browser for OAuth PKCE flow and generate bound DPoP key pair.",
    credCodeartsBtn: "Launch OAuth Wizard",

    credAutoclawTitle: "AutoClaw Intl Auth",
    credAutoclawDesc: "Trigger official captcha verification, bind device ID, and save refresh token.",
    credAutoclawBtn: "Launch Auth Wizard",

    credWorkbuddyTitle: "WorkBuddy SMS Login",
    credWorkbuddyDesc: "Enter phone number to receive SMS code and automatically save refresh token.",
    credWorkbuddyBtn: "Launch SMS Wizard",

    credAutoclawCnTitle: "AutoClaw CN SMS Login",
    credAutoclawCnDesc: "Zhipu AutoGLM SMS login with automatic credential saving.",
    credAutoclawCnBtn: "Launch CN Wizard",

    modalPhoneLabel: "Phone Number (11 digits)",
    modalCodeLabel: "SMS Verification Code",
    modalSendSms: "Send Code",
    modalSending: "Sending...",
    modalSent: "Sent ({seconds}s)",

    wizardQoderTitle: "⚡ Qoder PAT Auto Exchange",
    wizardQoderPlaceholder: "Paste the PAT copied from the console",
    wizardQoderBtn: "Exchange",
    wizardCodeartsTitle: "⚡ Browser OAuth PKCE",
    wizardCodeartsDesc: "Launch the Huawei Cloud OAuth flow, supporting Huawei ID QR sign-in and automatic DPoP key issuance.",
    wizardCodeartsBtn: "Launch OAuth Wizard",
    wizardAutoclawTitle: "⚡ AutoClaw Intl OAuth / Google",
    wizardAutoclawDesc: "Start the international verification service, sign in with Google and bind the device credential.",
    wizardAutoclawBtn: "Launch Intl Wizard",
    wizardSmsTitleWorkbuddy: "📱 WorkBuddy SMS Quick Login",
    wizardSmsTitleAutoclaw: "📱 AutoClaw CN SMS Quick Login",
    wizardPhonePlaceholder: "11-digit phone number",
    wizardCodePlaceholder: "6-digit SMS code",
    wizardSmsLoginBtn: "Sign in & Save",
    manualTokenDesc: "Already have a token? Paste it below to save it to your local .env.",

    privacyTitle: "Privacy & Security",
    privacySub: "Security boundary and credential discovery control",
    privacyItemTitle: "Disable Credential Discovery (CHECKIN_NO_DISCOVERY)",
    privacyItemDesc: "When enabled, disables local disk discovery of desktop client session files, strictly relying on environment variables.",
    rootTitle: "Engine directory",
    rootDataTitle: "Data directory",
    rootDataDesc: "The engine ships with the app; credentials (.env), config.json and run history live here.",
    rootDesc: "Check-ins run via the Node scripts in this directory (must contain config.json and package.json). The app bundle only ships the UI, not the engine.",
    rootSave: "Save & Reload",

    tabBrowser: "🌐 Official Web / Browser",
    tabLocalApp: "💻 Local App / Extract",
    tabManual: "🔑 Direct Token / SMS",
    btnOpenOfficialWeb: "Open Official Web Login",
    btnOpenLocalApp: "Launch Local App",
    manualTokenPlaceholder: "Paste Refresh Token or credential string here",
    btnSaveManualToken: "Save Token to Local (.env)",
    tokenSavedSuccess: "[SUCCESS] Token saved to local environment (.env)",

    modalCancel: "Cancel",
    modalConfirm: "Confirm & Execute",

    checkUpdate: "Check Updates",
    checkingUpdate: "Checking...",
    updateLatest: "Up to date",
    updateFound: "New v{version}",
    updateInstall: "Download v{version}",
    updateDialogTitle: "Update available",
    updateLater: "Later",
    updateDownloading: "Downloading {percent}%",
    updateReady: "Ready, restart",
    updateFailed: "Check failed",
  },
};

export function getDeviceLanguage(): Lang {
  const saved = localStorage.getItem("aipunch_lang");
  if (saved === "zh" || saved === "en") return saved;

  const navLang = (navigator.language || (navigator as { userLanguage?: string }).userLanguage || "").toLowerCase();
  if (navLang.startsWith("zh")) {
    return "zh";
  }
  if (navLang.startsWith("en")) {
    return "en";
  }
  // 默认简体中文
  return "zh";
}

let currentLang: Lang = getDeviceLanguage();

export function setLanguage(lang: Lang) {
  currentLang = lang;
  localStorage.setItem("aipunch_lang", lang);
}

export function getCurrentLang(): Lang {
  return currentLang;
}

export function t(key: keyof typeof translations.zh, params?: Record<string, string | number>): string {
  let val = translations[currentLang][key] || translations.zh[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(`{${k}}`, String(v));
    }
  }
  return val;
}
