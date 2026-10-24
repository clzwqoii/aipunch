import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, Update } from "@tauri-apps/plugin-updater";
import { t, getCurrentLang, setLanguage, Lang, translations } from "./i18n";
import { escapeHtml } from "./html";

const appWindow = getCurrentWindow();

interface AccountConfig {
  provider: string;
  name: string;
  tokenEnv?: string;
  refreshTokenEnv?: string;
  enabled: boolean;
  [key: string]: unknown;
}

interface AppConfig {
  accounts: AccountConfig[];
  // GitHub Actions 执行仓库（"owner/name"），ci-checkin/ci-sync 经 gh --repo 使用
  repo?: string;
  // 执行平台单选（ADR 0004）：'local'=内置引擎本地执行；'github-actions'=云端执行（默认，向后兼容）；
  // 'cloudflare-workers' 为 P2 预留，UI 中禁用
  platform?: string;
}

const PROVIDER_METAS: Record<
  string,
  { name: string; iconBg: string; brandChar: string; hintKey: keyof typeof translations.zh }
> = {
  trae: {
    name: "Trae",
    iconBg: "linear-gradient(135deg, #0052d9 0%, #00f2fe 100%)",
    brandChar: "T",
    hintKey: "traeHint",
  },
  qoder: {
    name: "Qoder",
    iconBg: "linear-gradient(135deg, #7928ca 0%, #ff0080 100%)",
    brandChar: "Q",
    hintKey: "qoderHint",
  },
  codearts: {
    name: "CodeArts",
    iconBg: "linear-gradient(135deg, #c7000b 0%, #ff6b6b 100%)",
    brandChar: "C",
    hintKey: "codeartsHint",
  },
  workbuddy: {
    name: "WorkBuddy",
    iconBg: "linear-gradient(135deg, #2b7fff 0%, #10b981 100%)",
    brandChar: "W",
    hintKey: "workbuddyHint",
  },
  "autoclaw-intl": {
    name: "AutoClaw",
    iconBg: "linear-gradient(135deg, #0f172a 0%, #06b6d4 100%)",
    brandChar: "A",
    hintKey: "autoclawHint",
  },
  autoclaw: {
    name: "AutoClaw CN",
    iconBg: "linear-gradient(135deg, #0f172a 0%, #f59e0b 100%)",
    brandChar: "A",
    hintKey: "autoclawCnHint",
  },
  "autoclaw-cn": {
    name: "AutoClaw CN",
    iconBg: "linear-gradient(135deg, #0f172a 0%, #f59e0b 100%)",
    brandChar: "A",
    hintKey: "autoclawCnHint",
  },
};

let currentConfig: AppConfig = { accounts: [] };
let configuredEnvKeys: string[] = [];
let isRunning = false;
let runnerResolve: ((code: number) => void) | null = null;
let lastExitCode: number | null = null;
let currentScriptName = "";

// 凭证导入类 runner：结束时弹成功/失败提醒（用户不该盯终端才知道授权结果）
const CREDENTIAL_RUNNERS = new Set([
  "trae-login",
  "codearts-login",
  "qoder-login",
  "autoclaw-login",
  "autoclaw-intl-login",
  "login",
  "trae-extract",
]);

const CREDENTIAL_LABELS: Record<string, string> = {
  "trae-login": "Trae 浏览器授权",
  "codearts-login": "CodeArts OAuth 授权",
  "qoder-login": "Qoder PAT 兑换",
  "autoclaw-login": "AutoClaw 授权",
  "autoclaw-intl-login": "AutoClaw 国际版授权",
  login: "凭证登录",
  "trae-extract": "Trae 本地凭证提取",
};

// 轻量 toast：右上角出现，成功绿失败红，4 秒自动消失
function showToast(ok: boolean, message: string): void {
  const box = document.createElement("div");
  box.className = `app-toast ${ok ? "toast-ok" : "toast-fail"}`;
  box.textContent = `${ok ? "✓" : "✕"} ${message}`;
  document.body.appendChild(box);
  setTimeout(() => box.classList.add("toast-show"), 30);
  setTimeout(() => {
    box.classList.remove("toast-show");
    setTimeout(() => box.remove(), 300);
  }, 4000);
}

// 初始化
async function init() {
  setupLanguage();
  setupTheme();
  setupNavigation();
  setupWindowControls();
  setupTerminalControls();
  setupUpdaterControls();
  setupCloudControls();
  renderInitialTerminalLogs();
  await setupEventListeners();
  await loadPrivacyMode();
  await setupProjectRoot();
  await loadConfigAndState();
  // 启动静默同步 + 每 30 分钟拉一次云端结果（ADR 0004：定时 cron 的结果桌面端可见）
  setTimeout(() => void runCiSync(true), 3000);
  setInterval(() => void runCiSync(true), 30 * 60 * 1000);
  // 启动顺带查一次云端平台可达性（国内网络选型参考），结果更新网络状态行
  setTimeout(() => void startRunner("netcheck", [], undefined, { silent: true }), 5000);
}

// 0. 窗口控制：双击执行 Cocoa 原生平滑动画铺满/还原，mousedown 启动系统级原生拖拽
function setupWindowControls() {
  // 原生拖拽启动
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // 仅左键
    if (e.detail > 1) return; // 双击手势由 mouseup 动画接管，不打断

    const target = e.target as HTMLElement | null;
    if (!target) return;

    // 交互控件不拖拽
    if (
      target.closest(
        "button, input, select, textarea, label, .slider, .nav-item, .pill-btn, .term-btn, .modal-backdrop, .account-toggle"
      )
    ) {
      return;
    }

    // 在拖拽区域激活系统级流畅移动
    if (
      target.closest("[data-tauri-drag-region]") ||
      target.closest(".window-titlebar") ||
      target.closest(".traffic-lights-spacer") ||
      target.closest(".main-top-drag-bar") ||
      target.closest(".terminal-header")
    ) {
      appWindow.startDragging().catch((err) => {
        console.warn("startDragging skipped:", err);
      });
    }
  });

  // 捕获阶段拦截双击 mouseup，由 Rust 端带有 Cocoa 动画的 toggle_maximize 接管
  window.addEventListener(
    "mouseup",
    async (e) => {
      if (e.button !== 0 || e.detail !== 2) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest(
          "button, input, select, textarea, label, .slider, .nav-item, .pill-btn, .term-btn, .modal-backdrop, .account-toggle"
        )
      ) {
        return;
      }
      // 双击全屏只在顶部拖拽区生效；终端 header 双击不放大（拖拽移动窗口保留在 mousedown 分支）
      if (
        target.closest("[data-tauri-drag-region]") ||
        target.closest(".window-titlebar") ||
        target.closest(".traffic-lights-spacer") ||
        target.closest(".main-top-drag-bar")
      ) {
        e.stopImmediatePropagation();
        try {
          await invoke("toggle_maximize");
        } catch (err) {
          console.warn("Animated toggle_maximize failed:", err);
        }
      }
    },
    true
  );
}

// 1. 多语言系统
function setupLanguage() {
  applyLanguage(getCurrentLang());

  document.getElementById("lang-btn-zh")?.addEventListener("click", () => {
    applyLanguage("zh");
  });

  document.getElementById("lang-btn-en")?.addEventListener("click", () => {
    applyLanguage("en");
  });
}

function applyLanguage(lang: Lang) {
  setLanguage(lang);

  // 更新切换按钮高亮
  const btnZh = document.getElementById("lang-btn-zh");
  const btnEn = document.getElementById("lang-btn-en");
  if (lang === "zh") {
    btnZh?.classList.add("active");
    btnEn?.classList.remove("active");
  } else {
    btnEn?.classList.add("active");
    btnZh?.classList.remove("active");
  }

  // 更新所有 data-i18n 元素
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n as keyof typeof translations.zh;
    if (key && translations[lang][key]) {
      el.textContent = translations[lang][key];
    }
  });

  // 更新搜索 placeholder
  const searchInput = document.getElementById("account-search") as HTMLInputElement;
  if (searchInput) {
    searchInput.placeholder = t("searchPlaceholder");
  }

  // 重新渲染卡片
  renderProviderCards();
  updateActiveBadge();
  syncStateTexts();
}

// 状态类文案由 JS 按运行/折叠状态维护，切语言后要重刷，否则会退回 data-i18n 的默认文案
function syncStateTexts() {
  setRunButton(isRunning);

  const drawer = document.getElementById("terminal-drawer");
  const toggle = document.getElementById("btn-toggle-terminal");
  if (toggle) {
    toggle.textContent = drawer?.classList.contains("collapsed") ? t("termExpand") : t("termCollapse");
  }

  renderStatusText();
  renderPlatformCards();
  renderSyncBar();
}

function renderStatusText() {
  const statusText = document.getElementById("status-summary-text");
  if (!statusText) return;
  if (lastExitCode === null) {
    statusText.textContent = t("heroReady");
    return;
  }
  statusText.textContent =
    lastExitCode === 0 ? t("heroFinished") : t("heroFinishedCode", { code: lastExitCode });
}

// 2. 主题切换
function setupTheme() {
  const savedTheme = localStorage.getItem("aipunch_theme") || "dark";
  applyTheme(savedTheme);

  document.getElementById("theme-btn-light")?.addEventListener("click", () => {
    applyTheme("light");
  });

  document.getElementById("theme-btn-dark")?.addEventListener("click", () => {
    applyTheme("dark");
  });
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("aipunch_theme", theme);

  const btnLight = document.getElementById("theme-btn-light");
  const btnDark = document.getElementById("theme-btn-dark");

  if (theme === "light") {
    btnLight?.classList.add("active");
    btnDark?.classList.remove("active");
  } else {
    btnDark?.classList.add("active");
    btnLight?.classList.remove("active");
  }
}

// 3. 导航切换与搜索
function setupNavigation() {
  const navItems = document.querySelectorAll<HTMLButtonElement>(".nav-item");
  navItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      if (!tabId) return;

      navItems.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      document.querySelectorAll(".tab-pane").forEach((pane) => {
        pane.classList.remove("active");
      });
      document.getElementById(`tab-${tabId}`)?.classList.add("active");
    });
  });

  // 搜索过滤
  const searchInput = document.getElementById("account-search") as HTMLInputElement;
  searchInput?.addEventListener("input", (e) => {
    const val = (e.target as HTMLInputElement).value.toLowerCase();
    const cards = document.querySelectorAll<HTMLElement>(".provider-card");
    cards.forEach((card) => {
      const name = card.dataset.name?.toLowerCase() || "";
      const account = card.dataset.account?.toLowerCase() || "";
      const provider = card.dataset.provider?.toLowerCase() || "";
      if (name.includes(val) || account.includes(val) || provider.includes(val)) {
        card.style.display = "flex";
      } else {
        card.style.display = "none";
      }
    });
  });
}

// 4. 终端控制与初始日志流（对齐设计图）
function renderInitialTerminalLogs() {
  const term = document.getElementById("terminal-output");
  if (!term || term.children.length > 0) return;

  const initialLogs = [
    { text: t("termInit"), cls: "info" },
    { text: t("termReady"), cls: "info" },
  ];

  initialLogs.forEach((item) => {
    const lineEl = document.createElement("div");
    lineEl.className = `log-line ${item.cls}`;
    lineEl.textContent = item.text;
    term.appendChild(lineEl);
  });
}

function setupTerminalControls() {
  const btnClear = document.getElementById("btn-clear-terminal");
  btnClear?.addEventListener("click", () => {
    const term = document.getElementById("terminal-output");
    if (term) term.innerHTML = "";
  });

  // 常驻脚本（OAuth 等待回调等）可能永不退出，必须能手动终止
  const btnStop = document.getElementById("btn-stop-script");
  btnStop?.addEventListener("click", async () => {
    try {
      await invoke("stop_script");
      appendTerminalLog("[STOP] 已请求终止当前任务");
    } catch (e) {
      appendTerminalLog(`[ERROR] Failed to stop script: ${e}`);
    }
  });

  const btnToggle = document.getElementById("btn-toggle-terminal");
  const drawer = document.getElementById("terminal-drawer");
  btnToggle?.addEventListener("click", () => {
    drawer?.classList.toggle("collapsed");
    btnToggle.textContent = drawer?.classList.contains("collapsed") ? t("termExpand") : t("termCollapse");
  });
}

// [NET] 行（netcheck runner 输出）同步更新云端 CI 页的网络状态 chip：
// [NET] GitHub: ok 230ms HTTP 200 / [NET] Cloudflare: fail 超时
function handleNetLine(line: string): void {
  const m = /^\[NET\] (GitHub|Cloudflare): (ok|fail) (.+)$/.exec(line);
  if (!m) return;
  const [, name, state, rest] = m;
  const el = document.getElementById(name === "GitHub" ? "net-github" : "net-cloudflare");
  if (!el) return;
  el.classList.remove("net-ok", "net-fail");
  if (state === "ok") {
    el.classList.add("net-ok");
    el.textContent = `${name} ${t("netOk")} ${rest.split(" ")[0]}`;
  } else {
    el.classList.add("net-fail");
    el.textContent = `${name} ${t("netFail")}（${rest}）`;
  }
}

// 最近一条 CF 错误行：部署失败时在弹框横幅里给出具体原因（而不是只让用户翻终端）
let lastCfError = "";

function handleNetAndCfLines(line: string): void {
  handleNetLine(line);
  if (line.startsWith("[CF] ") && /失败|错误/.test(line)) {
    lastCfError = line.replace(/^\[CF\] /, "").slice(0, 300);
  }
}

function appendTerminalLog(line: string) {
  handleNetAndCfLines(line);
  const term = document.getElementById("terminal-output");
  if (!term) return;

  const lineEl = document.createElement("div");
  lineEl.className = "log-line";

  // 签到结果按状态着色：此前只有含 "Token" 的行碰巧变蓝，其他结果全是默认色
  if (line.includes("[OK]") || line.includes("[DONE]") || line.includes("200 OK") || line.includes("✔") || line.includes("[CI] 运行结束：success")) {
    lineEl.classList.add("success");
  } else if (line.includes("[FAIL]") || line.includes("ERROR") || line.includes("Failed") || line.includes("::error::")) {
    lineEl.classList.add("error");
  } else if (line.includes("[CI]")) {
    lineEl.classList.add("info");
  } else if (line.includes("WARN") || line.includes("Skip") || line.includes("已轮换")) {
    lineEl.classList.add("warn");
  } else if (line.startsWith("[START]") || line.startsWith("[RUNNER]")) {
    lineEl.classList.add("info");
  }

  lineEl.textContent = line;
  term.appendChild(lineEl);
  term.scrollTop = term.scrollHeight;
}

// 5. 事件监听
async function setupEventListeners() {
  await listen<string>("console-log", (event) => {
    appendTerminalLog(event.payload);
  });

  await listen<number>("script-finished", (event) => {
    isRunning = false;
    setRunButton(false);
    const resolve = runnerResolve;
    runnerResolve = null;
    resolve?.(event.payload);
    lastExitCode = event.payload;
    if (CREDENTIAL_RUNNERS.has(currentScriptName)) {
      const label = CREDENTIAL_LABELS[currentScriptName] ?? currentScriptName;
      showToast(event.payload === 0, `${label} ${event.payload === 0 ? "成功，凭证已保存" : `失败（代码 ${event.payload}），详情见终端日志`}`);
    }
    currentScriptName = "";
    renderStatusText();
    loadConfigAndState();
  });

  document.getElementById("btn-run-all")?.addEventListener("click", () => {
    runCheckinAll();
  });

  document.getElementById("ci-status-ring")?.addEventListener("click", () => {
    const url = lastRun?.runUrl;
    if (url && /^https:\/\//.test(url)) void invoke("open_external", { target: url });
  });

  setupCredentialButtons();
}

// 6. 配置加载与卡片渲染（严格对齐设计图两列排版与按钮）
interface LastRunBalance {
  remain: number;
  limit?: number;
  unlimited?: boolean;
}

interface LastRunEntry {
  provider: string;
  account: string;
  ok: boolean;
  message: string;
  balance: LastRunBalance | null;
  skipped?: boolean; // 今日已签的幂等跳过（本轮无新领取），仍计入已签
}

let lastRunEntries: LastRunEntry[] = [];
let lastRun: { succeeded?: number; total?: number; finishedAt?: string; runUrl?: string } | null = null;
interface RunRecord {
  finishedAt?: string;
  succeeded?: number;
  total?: number;
  runUrl?: string;
  results?: LastRunEntry[];
}
let runHistory: RunRecord[] = [];

// 结构化结果由 ci-checkin 从 CI artifact 写入，卡片余额只读这份数据
// 内置引擎模式：显示数据目录并禁止修改（执行引擎随安装包提供）
async function loadRuntimeInfo(): Promise<void> {
  try {
    const info = await invoke<{ bundled: boolean; workDir: string }>("get_runtime_info");
    const input = document.getElementById("input-project-root") as HTMLInputElement | null;
    const save = document.getElementById("btn-save-project-root") as HTMLButtonElement | null;
    if (!info.bundled) return;
    if (input) {
      input.value = info.workDir;
      input.disabled = true;
    }
    if (save) save.disabled = true;
    const title = document.getElementById("root-title");
    const desc = document.getElementById("root-desc");
    if (title) title.textContent = t("rootDataTitle");
    if (desc) desc.textContent = t("rootDataDesc");
  } catch {
    /* 旧版后端无该命令时保持原有行为 */
  }
}

async function loadLastRun(): Promise<void> {
  try {
    const data = await invoke<{ results?: LastRunEntry[]; succeeded?: number; total?: number; finishedAt?: string; runUrl?: string } | null>(
      "get_last_run",
    );
    lastRun = data ?? null;
    lastRunEntries = Array.isArray(data?.results) ? data.results : [];
    const history = await invoke<RunRecord[] | null>("get_run_history");
    runHistory = Array.isArray(history) ? history : [];
  } catch {
    lastRun = null;
    lastRunEntries = [];
    runHistory = [];
  }
  applyBalances();
  renderHistory();
  applyCredentialState();
  renderSyncBar();
}

function formatBalance(b: LastRunBalance): string {
  if (b.unlimited) return "∞";
  // 只展示余额整数：小数与「/额度」不展示（用户口径）
  return `${Math.round(b.remain)}`;
}

function applyBalances(): void {
  document.querySelectorAll<HTMLElement>(".provider-card").forEach((card) => {
    const el = card.querySelector<HTMLElement>("[data-balance]");
    if (!el) return;
    const entry = lastRunEntries.find(
      (r) => r.provider === card.dataset.provider && r.account === card.dataset.account,
    );
    if (!entry?.balance) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.textContent = `${t("cardBalance")} ${formatBalance(entry.balance)}`;
    el.hidden = false;
  });
  applyDoneState();
  renderTotalBalance();
}

const CRED_BRAND_PROVIDER: Record<string, string> = {
  qoder: "qoder",
  trae: "trae",
  codearts: "codearts",
  autoclaw: "autoclaw-intl",
  workbuddy: "workbuddy",
  "autoclaw-cn": "autoclaw",
};

// 最近一次运行成功即视为凭证有效，禁用重复导入
function applyCredentialState(): void {
  document.querySelectorAll<HTMLElement>(".wizard-card[data-brand]").forEach((card) => {
    const provider = CRED_BRAND_PROVIDER[card.dataset.brand ?? ""];
    const valid = !!provider && lastRunEntries.some((r) => r.provider === provider && r.ok);
    const btn = card.querySelector<HTMLButtonElement>(".wizard-action-btn");
    if (btn) {
      btn.disabled = valid;
      btn.title = valid ? t("credValid") : "";
    }
    const badge = card.querySelector<HTMLElement>(".cred-valid");
    if (valid && !badge) {
      const span = document.createElement("span");
      span.className = "cred-valid";
      span.textContent = `✓ ${t("credValid")}`;
      card.querySelector(".wizard-header")?.appendChild(span);
    } else if (!valid && badge) {
      badge.remove();
    }
  });
}

function renderHistory(): void {
  const container = document.getElementById("history-container");
  if (!container) return;
  if (runHistory.length === 0) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t("historyEmpty"))}</div>`;
    return;
  }
  container.innerHTML = "";
  for (const run of runHistory.slice(0, 20)) {
    const item = document.createElement("div");
    item.className = "history-item";
    const when = run.finishedAt ? new Date(run.finishedAt).toLocaleString("zh-CN") : "";
    const head = document.createElement("div");
    head.className = "history-head";
    head.innerHTML = `<strong>${escapeHtml(when)}</strong><span>${run.succeeded ?? 0}/${run.total ?? 0} 成功</span>`;
    if (run.runUrl) {
      const link = document.createElement("button");
      link.className = "history-link";
      link.textContent = "查看运行 →";
      link.addEventListener("click", () => void invoke("open_external", { target: run.runUrl }));
      head.appendChild(link);
    }
    item.appendChild(head);
    const rows = document.createElement("div");
    rows.className = "history-rows";
    for (const r of run.results ?? []) {
      const row = document.createElement("div");
      // ok+skipped=今日已签的幂等跳过（无新领取），与真签到区分展示
      row.className = `history-row ${r.ok ? (r.skipped ? "ok skip" : "ok") : "fail"}`;
      const skipTag = r.ok && r.skipped ? `<span class="history-skip-tag">⊘ ${escapeHtml(t("historySkipped"))}</span>` : "";
      row.innerHTML = `<span class="history-acct">${escapeHtml(r.provider)}/${escapeHtml(r.account)}</span>${skipTag}<span class="history-msg">${escapeHtml(r.message)}</span>`;
      rows.appendChild(row);
    }
    item.appendChild(rows);
    container.appendChild(item);
  }
}

function isTodayRun(): boolean {
  if (!lastRun?.finishedAt) return false;
  const then = new Date(lastRun.finishedAt);
  const now = new Date();
  return then.toDateString() === now.toDateString();
}

// 今日已签的供应商：禁用单跑按钮并标注状态
function applyDoneState(): void {
  const done = isTodayRun();
  document.querySelectorAll<HTMLElement>(".provider-card").forEach((card) => {
    const entry = done
      ? lastRunEntries.find((r) => r.provider === card.dataset.provider && r.account === card.dataset.account)
      : undefined;
    const isDone = !!entry?.ok;
    const tag = card.querySelector<HTMLElement>(".status-tag");
    if (tag) {
      const original = tag.dataset.statusLabel || tag.textContent || "";
      tag.textContent = isDone ? t("cardDone") : original;
      tag.classList.toggle("done", isDone);
    }
    const play = card.querySelector<HTMLButtonElement>(".btn-icon-single");
    if (play) {
      play.disabled = isDone;
      play.title = isDone ? t("cardDone") : t("cardRunSingle");
    }
  });

  const allDone = allDoneToday() && activePlatform() !== "cloudflare-workers";
  const btnRunAll = document.getElementById("btn-run-all") as HTMLButtonElement | null;
  const btnRunAllText = document.getElementById("btn-run-all-text");
  if (btnRunAll && !isRunning) {
    btnRunAll.disabled = allDone;
    if (btnRunAllText) btnRunAllText.textContent = allDone ? t("heroAllDone") : t("heroRunAll");
  }
}

function renderTotalBalance(): void {
  const el = document.getElementById("total-claimed-pts");
  const ring = document.getElementById("ci-status-ring");
  if (!el || !ring) return;
  if (!lastRun || typeof lastRun.succeeded !== "number" || typeof lastRun.total !== "number") {
    el.textContent = "—";
    ring.title = "最近 CI 运行状态";
    ring.classList.remove("clickable");
    return;
  }
  el.textContent = `${lastRun.succeeded}/${lastRun.total}`;
  const when = lastRun.finishedAt ? new Date(lastRun.finishedAt).toLocaleString("zh-CN") : "";
  ring.title = `最近 CI 运行：${lastRun.succeeded}/${lastRun.total}${when ? ` · ${when}` : ""}`;
  ring.classList.toggle("clickable", !!lastRun.runUrl);
}

async function loadConfigAndState() {
  try {
    const configStr = await invoke<string>("get_config");
    currentConfig = JSON.parse(configStr);
    // 凭证既可能在 .env，也可能由进程环境提供；把候选键交给后端一起判定
    // （CF_KV_NAMESPACE 随部署成功写回，作为 CF 卡「已部署」状态的事实源）
    const envKeys = [
      ...currentConfig.accounts.flatMap((acc) => [acc.tokenEnv, acc.refreshTokenEnv]),
      "CF_KV_NAMESPACE",
    ].filter((key): key is string => !!key);
    configuredEnvKeys = await invoke<string[]>("get_env_status", { keys: envKeys });

    renderProviderCards();
    renderPlatformCards();
    renderCloudConfig();
    void loadLastRun();
    void loadRuntimeInfo();
    updateActiveBadge();
  } catch (e) {
    appendTerminalLog(`[ERROR] Failed to load config: ${e}`);
  }
}

function updateActiveBadge() {
  const activeCount = currentConfig.accounts.filter((a) => a.enabled !== false).length;
  const badge = document.getElementById("active-count-badge");
  if (badge) {
    badge.textContent = `${activeCount} ${t("activeBadge")}`;
  }
}

function renderProviderCards() {
  const container = document.getElementById("provider-cards-container");
  if (!container) return;

  container.innerHTML = "";

  currentConfig.accounts.forEach((acc, idx) => {
    const meta = PROVIDER_METAS[acc.provider] || {
      name: acc.provider,
      iconBg: "linear-gradient(135deg, #64748b 0%, #475569 100%)",
      brandChar: acc.provider.charAt(0).toUpperCase(),
      hintKey: "unknownHint" as const,
    };

    const hasCreds =
      (acc.refreshTokenEnv && configuredEnvKeys.includes(acc.refreshTokenEnv)) ||
      (acc.tokenEnv && configuredEnvKeys.includes(acc.tokenEnv));

    const isEnabled = acc.enabled !== false;
    const statusClass = hasCreds ? (isEnabled ? "ready" : "linked") : "unconfigured";
    const statusLabel = hasCreds ? (isEnabled ? t("cardReady") : t("cardLinked")) : t("cardUnset");
    const pointsHintText = t(meta.hintKey);

    const card = document.createElement("div");
    card.className = "provider-card";
    card.dataset.name = meta.name;
    card.dataset.account = acc.name;
    card.dataset.provider = acc.provider;

    // config.json 可被外部编辑，所有落入 innerHTML 的值一律转义
    const safeName = escapeHtml(meta.name);
    const safeAccount = escapeHtml(acc.name);
    const safeProvider = escapeHtml(acc.provider);

    // 对齐设计图：第一行 Logo + Title + Switch；第二行 Status Badge + Points Hint；第三行通栏 1-Click Auth 按钮
    card.innerHTML = `
      <div class="card-top">
        <div class="provider-brand">
          <div class="provider-icon-badge" style="background: ${escapeHtml(meta.iconBg)}">
            ${escapeHtml(meta.brandChar)}
          </div>
          <div class="brand-text">
            <h4>${safeName}</h4>
            <div class="provider-id">${safeAccount}</div>
          </div>
        </div>
        <label class="switch">
          <input type="checkbox" class="account-toggle" data-index="${idx}" ${isEnabled ? "checked" : ""} />
          <span class="slider round"></span>
        </label>
      </div>

      <div class="card-middle">
        <span class="status-tag ${statusClass}" data-status-label="${statusLabel}">${statusLabel}</span>
        <span class="points-hint">
          <span class="balance-line" data-balance hidden></span>
          <span class="hint-line">${pointsHintText}</span>
        </span>
      </div>

      <div class="card-bottom">
        <button class="btn-auth-full" data-provider="${safeProvider}">${t("cardAuthBtn")}</button>
        <button class="btn-icon-single" data-name="${safeAccount}" data-provider="${safeProvider}" title="${t("cardRunSingle")}">▶</button>
      </div>
    `;

    container.appendChild(card);
  });

  // 绑定开关保存
  container.querySelectorAll<HTMLInputElement>(".account-toggle").forEach((toggle) => {
    toggle.addEventListener("change", async (e) => {
      const idx = parseInt((e.target as HTMLInputElement).dataset.index || "0", 10);
      currentConfig.accounts[idx].enabled = (e.target as HTMLInputElement).checked;
      await saveCurrentConfig();
      updateActiveBadge();
    });
  });

  // 绑定单跑（按当前平台分流：本地引擎 / 触发 CI）
  container.querySelectorAll<HTMLButtonElement>(".btn-icon-single").forEach((btn) => {
    btn.addEventListener("click", () => {
      const provider = btn.dataset.provider;
      const name = btn.dataset.name;
      if (!provider || !name) return;
      const runner = activePlatform() === "local" ? "checkin" : "ci-checkin";
      appendTerminalLog(`[ACTION] ${activePlatform() === "local" ? "本地" : "触发 CI"}签到：${provider}/${name}...`);
      void startRunner(runner, ["--provider", provider, "--account", name]);
    });
  });

  // 绑定 1-Click Auth
  container.querySelectorAll<HTMLButtonElement>(".btn-auth-full").forEach((btn) => {
    btn.addEventListener("click", () => {
      const provider = btn.dataset.provider;
      if (provider) openAuthModal(provider);
    });
  });
}

async function saveCurrentConfig() {
  try {
    await invoke("save_config", { content: JSON.stringify(currentConfig, null, 2) });
    appendTerminalLog("[CONFIG] Saved config.json successfully.");
  } catch (e) {
    appendTerminalLog(`[ERROR] Failed to save config: ${e}`);
  }
}

// 7. 执行签到：所有 runner 共用同一把锁，script-finished 时解锁并回传退出码
function setRunButton(running: boolean) {
  const btnStop = document.getElementById("btn-stop-script") as HTMLButtonElement | null;
  if (btnStop) btnStop.disabled = !running;
  const btnRunAll = document.getElementById("btn-run-all") as HTMLButtonElement | null;
  const btnRunAllText = document.getElementById("btn-run-all-text");
  const spinner = document.getElementById("btn-run-all-spinner");
  if (!btnRunAll || !btnRunAllText) return;
  btnRunAll.disabled = running;
  // 执行中只切加载动画，按钮文案保持「一键签到」不变
  btnRunAllText.hidden = running;
  if (spinner) spinner.hidden = !running;
}

async function startRunner(
  scriptName: string,
  args: string[],
  env?: Record<string, string>,
  opts?: { silent?: boolean },
): Promise<number> {
  // 静默模式（后台同步）不与用户主动操作抢锁：有任务在跑就放弃，下次定时再试
  if (isRunning) {
    if (!opts?.silent) {
      // 撞执行锁：把 WARN 送到用户眼前（终端收起时根本看不到，表现为「点了没反应」）
      document.getElementById("terminal-drawer")?.classList.remove("collapsed");
      appendTerminalLog("[WARN] 已有任务在运行，请等待结束后再试（启动后的自动同步会占用几秒）");
    }
    return -1;
  }
  isRunning = true;
  currentScriptName = scriptName;
  setRunButton(true);
  if (!opts?.silent) {
    document.getElementById("terminal-drawer")?.classList.remove("collapsed");
    appendTerminalLog(`[RUNNER] Launching ${scriptName}...`);
  }

  return new Promise<number>((resolve) => {
    runnerResolve = resolve;
    invoke("run_script_stream", { scriptName, args, env: env ?? {} }).catch((e) => {
      if (runnerResolve === resolve) runnerResolve = null;
      isRunning = false;
      setRunButton(false);
      appendTerminalLog(`[ERROR] Runner failed to start: ${e}`);
      resolve(-1);
    });
  });
}

function runCheckinAll() {
  // 今日已全部签到：不再触发执行，避免无意义的请求与风控。
  // CF 平台例外放行：worker 可能从未跑过（KV 无结果），首跑验证依赖手动触发；providers 幂等跳过，重复安全
  if (allDoneToday() && activePlatform() !== "cloudflare-workers") {
    appendTerminalLog("[跳过] 今日已全部签到，无需重复执行");
    return;
  }
  // 平台单选（ADR 0004）：本地走内置引擎；GitHub 走 ci-checkin；CF 临时改 cron 到下一分钟触发（ADR 不走 workers.dev）
  const platform = activePlatform();
  if (platform === "local") {
    void startRunner("checkin", []);
  } else if (platform === "cloudflare-workers") {
    void startRunner("cf-deploy", ["--trigger-now"]);
  } else {
    void startRunner("ci-checkin", []);
  }
}

function allDoneToday(): boolean {
  if (!isTodayRun()) return false;
  const enabled = currentConfig.accounts.filter((a) => a.enabled !== false);
  if (enabled.length === 0) return false;
  return enabled.every((a) =>
    lastRunEntries.some((r) => r.provider === a.provider && r.account === a.name && r.ok),
  );
}

// 9. 云端 CI：平台单选（ADR 0004）与拉取式同步
function activePlatform(): "local" | "github-actions" | "cloudflare-workers" {
  const p = currentConfig.platform;
  return p === "local" || p === "cloudflare-workers" ? p : "github-actions";
}

function renderPlatformCards(): void {
  const active = activePlatform();
  document.querySelectorAll<HTMLButtonElement>("#cloud-platform-grid .platform-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.platform === active);
  });
  // 配置状态行：GitHub 看 config.repo；CF 看部署时写回 .env 的 CF_KV_NAMESPACE
  const gh = document.getElementById("gh-config-state");
  if (gh) {
    const ok = !!currentConfig.repo?.trim();
    gh.textContent = ok ? t("ghStateReady") : t("ghStateMissing");
    gh.classList.toggle("state-ok", ok);
  }
  const cf = document.getElementById("cf-deploy-state");
  if (cf) {
    const ok = configuredEnvKeys.includes("CF_KV_NAMESPACE");
    cf.textContent = ok ? t("cfStateDeployed") : t("cfStateNotDeployed");
    cf.classList.toggle("state-ok", ok);
  }
}

// GitHub Actions 配置状态：repo 是否已配置 + 最近一次「检查配置」结果（检查复用 ci-checkin --check）
function renderCloudConfig(state?: "ok" | "fail"): void {
  const el = document.getElementById("cloud-config-status");
  if (!el) return;
  el.classList.remove("config-ok", "config-warn", "config-fail");
  const repo = currentConfig.repo?.trim();
  if (!repo) {
    el.textContent = t("cloudConfigRepoMissing");
    el.classList.add("config-warn");
    return;
  }
  if (state === "ok") {
    el.textContent = t("cloudConfigOk", { repo });
    el.classList.add("config-ok");
  } else if (state === "fail") {
    el.textContent = t("cloudConfigFail");
    el.classList.add("config-fail");
  } else {
    el.textContent = t("cloudConfigRepoReady", { repo });
    el.classList.add("config-warn");
  }
}

let lastSyncAt: Date | null = null;

// 同步状态条：最后同步时间 + 今日已签进度（合并本地与云端结果后的视图）
function renderSyncBar(): void {
  const el = document.getElementById("cloud-sync-status");
  if (!el) return;
  if (!lastSyncAt) {
    el.textContent = t("cloudSyncNever");
    return;
  }
  const enabled = currentConfig.accounts.filter((a) => a.enabled !== false);
  const done = isTodayRun()
    ? enabled.filter((a) => lastRunEntries.some((r) => r.provider === a.provider && r.account === a.name && r.ok)).length
    : 0;
  el.textContent = t("cloudSyncedAt", {
    time: lastSyncAt.toLocaleString("zh-CN"),
    done: String(done),
    total: String(enabled.length),
  });
}

// 拉取云端结果（只读不触发）；silent=启动/定时的后台同步，不展开终端、不抢执行锁
async function runCiSync(silent: boolean): Promise<void> {
  // 本地模式下没有云端事实源可拉取；GitHub 走 artifact、Cloudflare Workers 走 KV（ci-sync 内部分流）
  if (activePlatform() === "local") return;
  const code = await startRunner("ci-sync", [], undefined, { silent });
  if (code >= 0) {
    lastSyncAt = new Date();
    renderSyncBar();
  }
}

function setupCloudControls(): void {
  document.querySelectorAll<HTMLButtonElement>("#cloud-platform-grid .platform-card").forEach((card) => {
    card.addEventListener("click", async () => {
      const platform = card.dataset.platform;
      if (!platform || platform === activePlatform()) return;
      currentConfig.platform = platform;
      await saveCurrentConfig();
      renderPlatformCards();
      const switchKey = platform === "local" ? "cloudSwitchToLocal" : platform === "cloudflare-workers" ? "cloudSwitchToCf" : "cloudSwitchToCloud";
      appendTerminalLog(`[CLOUD] ${t(switchKey)}`);
      // 单执行端联动（ADR 0004）：只有 github-actions 平台保留仓库定时 CI，切走（local/CF）即停
      void startRunner("ci-checkin", [platform === "github-actions" ? "--workflow-enable" : "--workflow-disable"]);
      // 切平台即自动同步新平台结果 + 复查网络可达性（不需要手动按钮）
      void runCiSync(false);
      void startRunner("netcheck", [], undefined, { silent: true });
    });
  });

  // Cloudflare 部署弹框：粘贴 Token/Account → cf-deploy 代部署（定时沿用定时行的小时/时区）
  const cfModal = document.getElementById("cf-deploy-modal");
  // 部署结果横幅（进行中/成功/失败/缺项警告四态）
  const showCfResult = (state: "running" | "ok" | "fail" | "warn", desc?: string): void => {
    const box = document.getElementById("cf-deploy-result");
    const icon = document.getElementById("cf-deploy-result-icon");
    const title = document.getElementById("cf-deploy-result-title");
    const descEl = document.getElementById("cf-deploy-result-desc");
    if (!box || !icon || !title || !descEl) return;
    box.className = `cf-result ${state}`;
    const key =
      state === "running" ? "cfResultRunningTitle" : state === "ok" ? "cfResultOkTitle" : state === "fail" ? "cfResultFailTitle" : "cfResultMissing";
    icon.textContent = state === "ok" ? "✓" : state === "fail" ? "✕" : state === "warn" ? "⚠" : "⟳";
    title.textContent = state === "warn" ? t("cfResultMissing") : t(key);
    descEl.textContent = desc ?? (state === "running" ? t("cfResultRunningDesc") : state === "ok" ? t("cfResultOkDesc") : t("cfResultFailDesc"));
    descEl.hidden = !descEl.textContent;
    // 弹框内容可能已被滚到底部：横幅在顶部，出现时滚回去让用户看见
    box.closest(".modal-body")?.scrollTo({ top: 0 });
  };
  document.getElementById("cf-deploy-open")?.addEventListener("click", (e) => {
    e.stopPropagation();
    lastCfError = "";
    document.getElementById("cf-deploy-result")?.classList.add("hidden");
    cfModal?.classList.remove("hidden");
  });
  document.getElementById("btn-cf-deploy-close")?.addEventListener("click", () => cfModal?.classList.add("hidden"));
  // 直达 Cloudflare 令牌创建页（模板列表里的「Edit Cloudflare Workers」即所需权限集）
  document.getElementById("btn-cf-open-token-page")?.addEventListener("click", () => {
    void invoke("open_external", { target: "https://dash.cloudflare.com/profile/api-tokens" });
  });
  document.getElementById("btn-cf-deploy-close")?.addEventListener("click", () => cfModal?.classList.add("hidden"));
  // 部署按钮生命周期：一键幂等（凭证/配置/定时每次刷新；脚本指纹相同跳过上传，无频控），
  // 部署中禁用并保持弹框 → 按退出码给结果；成功才关闭并刷新卡片状态，失败留在弹框内修正重试
  document.getElementById("btn-cf-deploy-run")?.addEventListener("click", async () => {
    const runBtn = document.getElementById("btn-cf-deploy-run") as HTMLButtonElement | null;
    const token = (document.getElementById("cf-token-input") as HTMLInputElement | null)?.value.trim();
    const account = (document.getElementById("cf-account-input") as HTMLInputElement | null)?.value.trim();
    const hour = (document.getElementById("schedule-hour") as HTMLSelectElement | null)?.value;
    const tz = (document.getElementById("schedule-tz") as HTMLSelectElement | null)?.value;
    if (!token || !account || !hour || !tz) {
      showCfResult("warn");
      return;
    }
    lastCfError = "";
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = t("cfDeployRunning");
    }
    showCfResult("running");
    const code = await startRunner("cf-deploy", ["--token", token, "--account", account, "--hour", hour, "--tz", tz]);
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = t("cfDeployBtn");
    }
    if (code === 0) {
      showCfResult("ok");
      // 部署成功：.env 已写入 CF_*，重查环境键让 CF 卡点亮「已部署」
      await loadConfigAndState();
      setTimeout(() => cfModal?.classList.add("hidden"), 2000);
    } else {
      // 失败横幅带具体错误行（cf-deploy 的 [CF] …失败 输出），比「见终端」可操作
      showCfResult("fail", lastCfError || undefined);
    }
  });

  // 配置教程弹框：GitHub 卡片上的 ⚙ 标识（stopPropagation 避免触发平台切换）
  const helpModal = document.getElementById("config-help-modal");
  document.getElementById("cloud-config-open")?.addEventListener("click", (e) => {
    e.stopPropagation();
    renderCloudConfig();
    helpModal?.classList.remove("hidden");
  });
  document.getElementById("btn-config-help-close")?.addEventListener("click", () => helpModal?.classList.add("hidden"));
  // GitHub 教程便利入口：Fork 直达页 + PAT 创建页（预选 repo+workflow，Secret 回写与改定时所需）
  document.getElementById("btn-cloud-open-fork")?.addEventListener("click", () => {
    void invoke("open_external", { target: "https://github.com/clzwqoii/aipunch/fork" });
  });
  document.getElementById("btn-cloud-open-token")?.addEventListener("click", () => {
    void invoke("open_external", { target: "https://github.com/settings/tokens/new?scopes=repo,workflow&description=AIPunch" });
  });

  // 同步与网络检查已自动化（启动/定时/切平台触发），无手动按钮

  // 定时窗口：小时 00-23 + 时区下拉，保存后 ci-checkin --set-schedule 自动把仓库 workflow 的
  // cron 改成对应 UTC 整点（每天只真跑一次）；localStorage 只记忆 UI 选择，事实源是 cron
  const hourSelect = document.getElementById("schedule-hour") as HTMLSelectElement | null;
  const tzSelect = document.getElementById("schedule-tz") as HTMLSelectElement | null;
  if (hourSelect && !hourSelect.options.length) {
    for (let h = 0; h < 24; h++) {
      const value = String(h).padStart(2, "0");
      hourSelect.add(new Option(`${value}:00`, value));
    }
    let saved: { hour?: string; tz?: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem("aipunch_schedule") ?? "null");
    } catch {
      saved = null;
    }
    hourSelect.value = saved?.hour ?? "11";
    if (tzSelect && saved?.tz) tzSelect.value = saved.tz;
  }
  document.getElementById("btn-schedule-save")?.addEventListener("click", () => {
    const hour = hourSelect?.value;
    const tz = tzSelect?.value;
    if (!hour || !tz) return;
    localStorage.setItem("aipunch_schedule", JSON.stringify({ hour, tz }));
    // 平台分流：GitHub 改仓库 workflow 的 cron，CF 改 worker 的 cron 触发器（runner 内各自换算 UTC）
    if (activePlatform() === "cloudflare-workers") {
      void startRunner("cf-deploy", ["--cron-only", "--hour", hour, "--tz", tz]);
    } else {
      void startRunner("ci-checkin", ["--set-schedule", hour, tz]);
    }
  });

  // 可用性自检复用 ci-checkin --check（gh 版本/登录/仓库权限逐项验证，结果在终端展示）
  document.getElementById("btn-cloud-check")?.addEventListener("click", async () => {
    if (!currentConfig.repo?.trim()) {
      renderCloudConfig();
      appendTerminalLog(`[CLOUD] ${t("cloudConfigRepoMissing")}`);
      return;
    }
    const code = await startRunner("ci-checkin", ["--check"]);
    renderCloudConfig(code === 0 ? "ok" : "fail");
  });
}

// 8. 隐私开关
async function loadPrivacyState() {
  try {
    const isPrivate = await invoke<boolean>("get_privacy_mode");
    const heroSwitch = document.getElementById("hero-privacy-switch") as HTMLInputElement | null;
    const fullSwitch = document.getElementById("full-privacy-switch") as HTMLInputElement | null;
    if (heroSwitch) heroSwitch.checked = isPrivate;
    if (fullSwitch) fullSwitch.checked = isPrivate;
  } catch (e) {
    console.error("Failed to load privacy mode:", e);
  }
}

async function loadPrivacyMode() {
  await loadPrivacyState();

  const heroSwitch = document.getElementById("hero-privacy-switch") as HTMLInputElement | null;
  const fullSwitch = document.getElementById("full-privacy-switch") as HTMLInputElement | null;

  const onPrivacyChange = async (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked;
    if (heroSwitch) heroSwitch.checked = checked;
    if (fullSwitch) fullSwitch.checked = checked;
    try {
      await invoke("set_privacy_mode", { enabled: checked });
      appendTerminalLog(`[PRIVACY] CHECKIN_NO_DISCOVERY set to ${checked}`);
    } catch (err) {
      appendTerminalLog(`[ERROR] Failed to save privacy mode: ${err}`);
    }
  };

  heroSwitch?.addEventListener("change", onPrivacyChange);
  fullSwitch?.addEventListener("change", onPrivacyChange);
}

// 8.1 项目根目录：打包后运行位置可能不在仓库内，需要显式指定 config.json / .env 所在目录
async function setupProjectRoot() {
  const input = document.getElementById("input-project-root") as HTMLInputElement | null;
  const saveBtn = document.getElementById("btn-save-project-root");
  if (!input || !saveBtn) return;

  try {
    input.value = await invoke<string>("get_project_root");
  } catch (e) {
    console.warn("Failed to read project root:", e);
  }

  saveBtn.addEventListener("click", async () => {
    const path = input.value.trim();
    if (!path) return;
    try {
      await invoke("set_project_root", { path });
      appendTerminalLog(`[CONFIG] 项目根目录已设为 ${path}`);
      await loadConfigAndState();
      await loadPrivacyState();
    } catch (e) {
      appendTerminalLog(`[ERROR] 项目根目录无效: ${e}`);
    }
  });
}

// 9. 凭据向导绑定与执行
function setupCredentialButtons() {
  document.getElementById("btn-import-qoder")?.addEventListener("click", () => openAuthModal("qoder"));
  document.getElementById("btn-import-trae")?.addEventListener("click", () => startRunner("trae-extract", []));
  document.getElementById("btn-import-codearts")?.addEventListener("click", () => startRunner("codearts-login", []));
  document.getElementById("btn-import-autoclaw")?.addEventListener("click", () => openAuthModal("autoclaw-intl"));
  document.getElementById("btn-import-workbuddy")?.addEventListener("click", () => openAuthModal("workbuddy"));
  document.getElementById("btn-import-autoclaw-cn")?.addEventListener("click", () => openAuthModal("autoclaw-cn"));

  document.getElementById("btn-modal-close")?.addEventListener("click", closeModal);
  document.getElementById("btn-modal-cancel")?.addEventListener("click", closeModal);
}

interface ProviderAuthMeta {
  name: string;
  webUrl: string;
  localApp?: string;
  envKey: string;
}

const AUTH_DETAILS: Record<string, ProviderAuthMeta> = {
  qoder: {
    name: "Qoder",
    webUrl: "https://qoder.cn",
    localApp: "Qoder",
    envKey: "QODER_REFRESH_TOKEN",
  },
  trae: {
    name: "Trae",
    webUrl: "https://trae.cn",
    localApp: "Trae",
    envKey: "TRAE_REFRESH_TOKEN",
  },
  codearts: {
    name: "CodeArts",
    webUrl: "https://auth.huaweicloud.com",
    envKey: "CODEARTS_REFRESH_TOKEN",
  },
  "autoclaw-intl": {
    name: "AutoClaw Intl",
    webUrl: "https://autoclaw.ai",
    localApp: "AutoClaw",
    envKey: "AUTOCLAW_INTL_REFRESH_TOKEN",
  },
  workbuddy: {
    name: "WorkBuddy",
    webUrl: "https://workbuddy.cn",
    localApp: "WorkBuddy",
    envKey: "WORKBUDDY_REFRESH_TOKEN",
  },
  "autoclaw-cn": {
    name: "AutoClaw CN",
    webUrl: "https://autoglm.cn",
    localApp: "AutoClaw",
    envKey: "AUTOCLAW_REFRESH_TOKEN",
  },
  autoclaw: {
    name: "AutoClaw CN",
    webUrl: "https://autoglm.cn",
    localApp: "AutoClaw",
    envKey: "AUTOCLAW_REFRESH_TOKEN",
  },
};

function openAuthModal(provider: string) {
  const modal = document.getElementById("modal-container");
  const title = document.getElementById("modal-title");
  const body = document.getElementById("modal-body");
  const confirmBtn = document.getElementById("btn-modal-confirm");

  if (!modal || !title || !body || !confirmBtn) return;

  const meta = AUTH_DETAILS[provider] || {
    name: provider,
    webUrl: "https://google.com",
    envKey: `${provider.toUpperCase()}_TOKEN`,
  };

  title.textContent = `${meta.name} - ${getCurrentLang() === "zh" ? "官方授权与凭证导入" : "Auth & Credentials"}`;

  // provider 可能来自外部编辑的 config.json，回退值需转义后再进 innerHTML
  const safeMetaName = escapeHtml(meta.localApp || meta.name);
  const safeEnvKey = escapeHtml(meta.envKey);

  // 渲染多模态卡片列表
  body.innerHTML = `
    <div class="auth-modal-modes">
      <!-- 途径 1：官方网页 / 浏览器登录（无手动 token 入口的 provider 渲染后移除：登录完无凭证回传） -->
      <div class="auth-option-card" data-auth-web-card>
        <div class="auth-option-header">
          <span>${t("tabBrowser")}</span>
          <span class="badge" style="background: rgba(14, 165, 233, 0.15); color: #0284c7;">Web</span>
        </div>
        <p class="auth-option-desc">
          ${getCurrentLang() === "zh" ? "在系统浏览器打开官方登录页，支持微信扫码、账号密码、第三方 SSO 等任意官方登录方式。" : "Open the official login portal in your default browser. Supports QR scan, password, SSO, and any official sign-in method."}
        </p>
        <div class="auth-option-action">
          <button id="btn-open-web" class="btn-secondary" style="flex: 1;">${t("btnOpenOfficialWeb")}</button>
        </div>
      </div>

      <!-- 途径 2：调起本地客户端 / 本地提取（无 localApp 的 provider 渲染后移除） -->
      <div class="auth-option-card" data-auth-app-card>
        <div class="auth-option-header">
          <span>${t("tabLocalApp")}</span>
          <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #10b981;">App</span>
        </div>
        <p class="auth-option-desc">
          ${provider === "trae" 
            ? (getCurrentLang() === "zh" ? "直接解密读取本机 Trae 桌面客户端已登录数据，免手动输入。" : "Directly decrypt and extract credentials from local Trae client storage.") 
            : (getCurrentLang() === "zh" ? `调起本机已安装的 ${safeMetaName} 桌面客户端进行登录。` : `Launch installed ${safeMetaName} desktop app.`)}
        </p>
        <div class="auth-option-action">
          ${provider === "trae" 
            ? `<button id="btn-run-trae-extract" class="btn-secondary" style="flex: 1;">一键解密本地凭证</button>` 
            : `<button id="btn-launch-app" class="btn-secondary" style="flex: 1;">${t("btnOpenLocalApp")} (${safeMetaName})</button>`}
        </div>
      </div>

      <!-- 途径 3：快捷验证或专属流 -->
      ${getProviderSpecificWizardHtml(provider)}

      <!-- 途径 4：手动粘贴 Token -->
      ${getManualTokenCardHtml(provider, safeEnvKey)}
    </div>
  `;

  // 无 localApp 的 provider（如 CodeArts：凭证只能走 OAuth PKCE，客户端调起无意义）不显示本机卡片；
  // trae/codearts 无手动 token 入口，官方网页登录也不会回传凭证——同样隐藏，避免「登录完没反应」
  if (provider !== "trae" && !meta.localApp) {
    modal.querySelector("[data-auth-app-card]")?.remove();
  }
  if (MANUAL_TOKEN_UNSUPPORTED.has(provider)) {
    modal.querySelector("[data-auth-web-card]")?.remove();
  }

  // 隐藏全局确认按钮，由卡片内各自的具体动作驱动
  confirmBtn.style.display = "none";

  // 事件绑定：打开官方网页
  document.getElementById("btn-open-web")?.addEventListener("click", async () => {
    try {
      await invoke("open_external", { target: meta.webUrl });
      appendTerminalLog(`[BROWSER] Opened official web portal: ${meta.webUrl}`);
    } catch (e) {
      appendTerminalLog(`[ERROR] Failed to open URL: ${e}`);
    }
  });

  // 事件绑定：打开本地 APP
  document.getElementById("btn-launch-app")?.addEventListener("click", async () => {
    const appName = meta.localApp || meta.name;
    try {
      await invoke("open_external", { target: appName });
      appendTerminalLog(`[APP] Launched local application: ${appName}`);
    } catch (e) {
      appendTerminalLog(`[ERROR] Failed to launch application: ${e}`);
    }
  });

  // 事件绑定：Trae 一键解密
  document.getElementById("btn-run-trae-extract")?.addEventListener("click", () => {
    closeModal();
    startRunner("trae-extract", []);
  });

  // 事件绑定：手动保存 Token
  document.getElementById("btn-save-manual-token")?.addEventListener("click", async () => {
    const token = (document.getElementById("input-manual-token") as HTMLInputElement)?.value.trim();
    if (!token) return;
    try {
      await invoke("set_env_variable", { key: meta.envKey, value: token });
      appendTerminalLog(`[OK] Saved ${meta.envKey} successfully.`);
      closeModal();
      loadConfigAndState();
    } catch (e) {
      appendTerminalLog(`[ERROR] Failed to save token: ${e}`);
    }
  });

  // 绑定专属向导事件
  bindProviderSpecificEvents(provider);

  modal.classList.remove("hidden");
}

// Trae 必须同时有设备号（TRAE_DEVICE_ID）、CodeArts 必须同时有 DPoP 私钥（CODEARTS_DPOP_KEY），
// 只粘贴 refreshToken 存不出能用的凭证，这两个平台只能走专属向导，不给手填入口
const MANUAL_TOKEN_UNSUPPORTED = new Set(["trae", "codearts"]);

function getManualTokenCardHtml(provider: string, safeEnvKey: string): string {
  if (MANUAL_TOKEN_UNSUPPORTED.has(provider)) return "";
  return `
      <div class="auth-option-card">
        <div class="auth-option-header">
          <span>${t("tabManual")} (${safeEnvKey})</span>
        </div>
        <p class="auth-option-desc">
          ${t("manualTokenDesc")}
        </p>
        <div style="display: flex; gap: 8px; margin-top: 4px;">
          <input type="password" id="input-manual-token" class="form-input" placeholder="${t("manualTokenPlaceholder")}" />
          <button id="btn-save-manual-token" class="btn-secondary" style="white-space: nowrap;">${t("btnSaveManualToken")}</button>
        </div>
      </div>`;
}

function getProviderSpecificWizardHtml(provider: string): string {
  if (provider === "qoder") {
    return `
      <div class="auth-option-card">
        <div class="auth-option-header">
          <span>${t("wizardQoderTitle")}</span>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 4px;">
          <input type="text" id="input-qoder-pat" class="form-input" placeholder="${t("wizardQoderPlaceholder")}" />
          <button id="btn-exchange-pat" class="btn-primary" style="white-space: nowrap;">${t("wizardQoderBtn")}</button>
        </div>
      </div>
    `;
  } else if (provider === "codearts") {
    return `
      <div class="auth-option-card">
        <div class="auth-option-header">
          <span>${t("wizardCodeartsTitle")}</span>
        </div>
        <p class="auth-option-desc">${t("wizardCodeartsDesc")}</p>
        <div class="auth-option-action">
          <button id="btn-run-codearts-oauth" class="btn-primary" style="flex: 1;">${t("wizardCodeartsBtn")}</button>
        </div>
      </div>
    `;
  } else if (provider === "trae") {
    return `
      <div class="auth-option-card">
        <div class="auth-option-header">
          <span>${getCurrentLang() === "zh" ? "🌐 浏览器授权（推荐 · 独立会话）" : "🌐 Browser Auth (recommended · isolated session)"}</span>
        </div>
        <p class="auth-option-desc">${getCurrentLang() === "zh" ? "打开 Trae 官方授权页登录，签发独立会话与设备号；与桌面客户端互不影响。" : "Opens the Trae authorize page and issues an isolated session & device ID; does not affect the desktop client."}</p>
        <div class="auth-option-action">
          <button id="btn-run-trae-login" class="btn-primary" style="flex: 1;">${getCurrentLang() === "zh" ? "启动浏览器授权" : "Start Browser Auth"}</button>
        </div>
      </div>
    `;
  } else if (provider === "autoclaw-intl") {
    return `
      <div class="auth-option-card">
        <div class="auth-option-header">
          <span>${t("wizardAutoclawTitle")}</span>
        </div>
        <p class="auth-option-desc">${t("wizardAutoclawDesc")}</p>
        <div class="auth-option-action">
          <button id="btn-run-autoclaw-intl" class="btn-primary" style="flex: 1;">${t("wizardAutoclawBtn")}</button>
        </div>
      </div>
    `;
  } else if (provider === "workbuddy" || provider === "autoclaw-cn" || provider === "autoclaw") {
    const isWb = provider === "workbuddy";
    return `
      <div class="auth-option-card">
        <div class="auth-option-header">
          <span>${t(isWb ? "wizardSmsTitleWorkbuddy" : "wizardSmsTitleAutoclaw")}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px;">
          <div style="display: flex; gap: 8px;">
            <input type="text" id="input-phone" class="form-input" placeholder="${t("wizardPhonePlaceholder")}" maxlength="11" />
            <button id="btn-send-sms" class="btn-secondary" style="white-space: nowrap; width: 120px;">${t("modalSendSms")}</button>
          </div>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="input-sms-code" class="form-input" placeholder="${t("wizardCodePlaceholder")}" maxlength="8" />
            <button id="btn-verify-sms" class="btn-primary" style="white-space: nowrap; width: 120px;">${t("wizardSmsLoginBtn")}</button>
          </div>
        </div>
      </div>
    `;
  }
  return "";
}

function bindProviderSpecificEvents(provider: string) {
  if (provider === "qoder") {
    document.getElementById("btn-exchange-pat")?.addEventListener("click", () => {
      const pat = (document.getElementById("input-qoder-pat") as HTMLInputElement)?.value.trim();
      if (!pat) return;
      closeModal();
      startRunner("qoder-login", [], { QODER_PAT: pat });
    });
  } else if (provider === "codearts") {
    document.getElementById("btn-run-codearts-oauth")?.addEventListener("click", () => {
      closeModal();
      startRunner("codearts-login", []);
    });
  } else if (provider === "trae") {
    document.getElementById("btn-run-trae-login")?.addEventListener("click", () => {
      closeModal();
      startRunner("trae-login", []);
    });
  } else if (provider === "autoclaw-intl") {
    document.getElementById("btn-run-autoclaw-intl")?.addEventListener("click", () => {
      closeModal();
      startRunner("autoclaw-intl-login", ["--oauth"]);
    });
  } else if (provider === "workbuddy" || provider === "autoclaw-cn" || provider === "autoclaw") {
    const isWb = provider === "workbuddy";
    const sendBtn = document.getElementById("btn-send-sms") as HTMLButtonElement;
    sendBtn?.addEventListener("click", async () => {
      const phone = (document.getElementById("input-phone") as HTMLInputElement)?.value.trim();
      if (!/^\d{11}$/.test(phone)) {
        appendTerminalLog("[ERROR] 手机号必须为 11 位数字");
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = t("modalSending");
      const scriptName = isWb ? "login" : "autoclaw-login";
      // 手机号/验证码走环境变量，避免出现在 ps 的命令行里
      const exitCode = await startRunner(scriptName, ["--send-sms"], { AIPUNCH_LOGIN_PHONE: phone });
      if (exitCode !== 0) {
        sendBtn.disabled = false;
        sendBtn.textContent = t("modalSendSms");
        return;
      }

      let countdown = 60;
      const timer = setInterval(() => {
        countdown--;
        if (countdown > 0) {
          sendBtn.textContent = t("modalSent", { seconds: countdown });
        } else {
          clearInterval(timer);
          sendBtn.disabled = false;
          sendBtn.textContent = t("modalSendSms");
        }
      }, 1000);
    });

    document.getElementById("btn-verify-sms")?.addEventListener("click", () => {
      const phone = (document.getElementById("input-phone") as HTMLInputElement)?.value.trim();
      const code = (document.getElementById("input-sms-code") as HTMLInputElement)?.value.trim();
      if (!phone || !code) return;
      closeModal();
      const scriptName = isWb ? "login" : "autoclaw-login";
      startRunner(scriptName, ["--phone", "--code"], {
        AIPUNCH_LOGIN_PHONE: phone,
        AIPUNCH_LOGIN_CODE: code,
      });
    });
  }
}

function closeModal() {
  document.getElementById("modal-container")?.classList.add("hidden");
}


// 自动更新控制
let pendingUpdate: Update | null = null;
let isUpdating = false;

function setupUpdaterControls() {
  const checkBtn = document.getElementById("btn-check-update");
  const btnText = document.getElementById("update-btn-text");
  const statusMsg = document.getElementById("update-status-msg");
  const modal = document.getElementById("update-modal");

  const closeModal = (): void => modal?.classList.add("hidden");

  function openUpdateModal(): void {
    if (!pendingUpdate) return;
    const versionEl = document.getElementById("update-modal-version");
    const notesEl = document.getElementById("update-modal-notes");
    const titleEl = document.getElementById("update-modal-title");
    const installBtn = document.getElementById("btn-update-install");
    if (titleEl) titleEl.textContent = t("updateDialogTitle");
    if (versionEl) versionEl.textContent = `v${pendingUpdate.version}`;
    if (notesEl) notesEl.textContent = pendingUpdate.body?.trim() || t("updateFound", { version: pendingUpdate.version });
    if (installBtn) installBtn.textContent = t("updateInstall", { version: pendingUpdate.version });
    modal?.classList.remove("hidden");
  }

  async function performCheck(manual = false): Promise<void> {
    if (isUpdating) return;
    if (manual) {
      checkBtn?.classList.add("loading");
      if (btnText) btnText.textContent = t("checkingUpdate");
      if (statusMsg) {
        statusMsg.className = "update-status-msg";
        statusMsg.textContent = t("checkingUpdate");
        statusMsg.classList.remove("hidden");
      }
    }

    try {
      const update = await check();
      if (update && update.available) {
        pendingUpdate = update;
        if (btnText) btnText.textContent = t("updateInstall", { version: update.version });
        if (statusMsg) {
          statusMsg.className = "update-status-msg success";
          statusMsg.textContent = t("updateFound", { version: update.version });
          statusMsg.classList.remove("hidden");
        }
        if (manual) openUpdateModal();
      } else {
        pendingUpdate = null;
        if (manual) {
          if (btnText) btnText.textContent = t("updateLatest");
          if (statusMsg) {
            statusMsg.className = "update-status-msg success";
            statusMsg.textContent = t("updateLatest");
            statusMsg.classList.remove("hidden");
            setTimeout(() => {
              statusMsg?.classList.add("hidden");
              if (btnText) btnText.textContent = t("checkUpdate");
            }, 3000);
          }
        }
      }
    } catch (err) {
      console.warn("Update check failed:", err);
      if (manual) {
        const reason = String((err as Error).message || err).slice(0, 120);
        if (btnText) btnText.textContent = t("checkUpdate");
        if (statusMsg) {
          statusMsg.className = "update-status-msg error";
          statusMsg.textContent = `${t("updateFailed")}：${reason}`;
          statusMsg.classList.remove("hidden");
          setTimeout(() => statusMsg?.classList.add("hidden"), 6000);
        }
      }
    } finally {
      checkBtn?.classList.remove("loading");
    }
  }

  async function startInstall(): Promise<void> {
    if (!pendingUpdate || isUpdating) return;
    isUpdating = true;
    closeModal();
    if (btnText) btnText.textContent = t("updateDownloading", { percent: "0" });
    if (statusMsg) {
      statusMsg.className = "update-status-msg";
      statusMsg.textContent = t("updateDownloading", { percent: "0" });
      statusMsg.classList.remove("hidden");
    }

    let downloaded = 0;
    let contentLength = 0;

    try {
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength || 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const pct = contentLength ? Math.round((downloaded / contentLength) * 100) : 50;
          if (btnText) btnText.textContent = t("updateDownloading", { percent: String(pct) });
          if (statusMsg) statusMsg.textContent = t("updateDownloading", { percent: String(pct) });
        } else if (event.event === "Finished") {
          if (btnText) btnText.textContent = t("updateReady");
          if (statusMsg) {
            statusMsg.className = "update-status-msg success";
            statusMsg.textContent = t("updateReady");
          }
        }
      });

      if (statusMsg) statusMsg.textContent = "重启中 / Restarting...";
      await invoke("restart_app");
    } catch (err) {
      console.error("Failed to install update:", err);
      isUpdating = false;
      if (statusMsg) {
        statusMsg.className = "update-status-msg error";
        statusMsg.textContent = `更新失败: ${err}`;
        statusMsg.classList.remove("hidden");
      }
    }
  }

  checkBtn?.addEventListener("click", () => {
    if (pendingUpdate && pendingUpdate.available) void startInstall();
    else void performCheck(true);
  });

  document.getElementById("btn-update-install")?.addEventListener("click", () => void startInstall());
  document.getElementById("btn-update-later")?.addEventListener("click", closeModal);
  document.getElementById("btn-update-modal-close")?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });

  // 静默启动检查（延迟 3 秒，避免阻塞应用初始化）
  setTimeout(() => {
    performCheck(false).catch(() => {});
  }, 3000);
}

window.addEventListener("DOMContentLoaded", init);
