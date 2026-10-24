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
    navHistory: "执行记录",
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
    historyEmpty: "执行记录即将上线：每次签到的过程与结果请看右侧实时终端。",

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
    rootTitle: "项目根目录",
    rootDesc: "桌面壳在此目录执行 npm run checkin，并读写 config.json 与 .env。",
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
    navHistory: "Run History",
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
    historyEmpty: "Run history is coming soon — follow each run in the live terminal on the right.",

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
    rootTitle: "Project Root",
    rootDesc: "The shell runs npm run checkin in this directory and reads/writes config.json and .env.",
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
