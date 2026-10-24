import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultFile } from '../core/result.ts';

// 桌面端「一键签到」= 触发 GitHub Actions 并展示结果：签到只在 CI 跑（单执行端），
// 避免本地/CI 共用单次轮换票互踢。依赖 gh CLI 已登录（gh auth login）。
// 用法：npm run ci-checkin [-- --provider trae] [-- --account main]
const WORKFLOW = 'checkin.yml';
const WORKFLOW_PATH = '.github/workflows/checkin.yml';
let currentRepo = '';
const POLL_MS = 3000;
const FIND_TIMEOUT_MS = 90_000;
const RUN_TIMEOUT_MS = 20 * 60_000;

export interface CiArgs {
  provider?: string;
  account?: string;
  check?: boolean;
  // 平台切换联动（ADR 0004 单执行端）：local 时停掉仓库定时 CI，github-actions 时恢复
  workflowAction?: 'enable' | 'disable';
  // 定时调度（保存即改 workflow 的 cron 行，每天只真跑一次）：小时两位 00-23，时区 IANA 名
  scheduleHour?: string;
  scheduleTz?: string;
}

export function parseCiArgs(argv: string[]): CiArgs {
  const out: CiArgs = {};
  if (argv.includes('--check')) out.check = true;
  if (argv.includes('--workflow-disable')) out.workflowAction = 'disable';
  if (argv.includes('--workflow-enable')) out.workflowAction = 'enable';
  const schedIdx = argv.indexOf('--set-schedule');
  if (schedIdx !== -1) {
    const raw = argv[schedIdx + 1]?.trim();
    if (!raw || raw.startsWith('--')) throw new Error('--set-schedule 后缺少小时（0-23）');
    if (!/^(?:[01]?\d|2[0-3])$/.test(raw)) throw new Error('--set-schedule 小时须为 0-23');
    // 归一为两位（与 gate 侧 date +%H 的带零输出一致，避免 '9'≠'09' 永不匹配）
    out.scheduleHour = String(Number(raw)).padStart(2, '0');
    const tz = argv[schedIdx + 2]?.trim();
    out.scheduleTz = tz && !tz.startsWith('--') ? tz : 'Asia/Shanghai';
  }
  for (const flag of ['provider', 'account'] as const) {
    const idx = argv.indexOf(`--${flag}`);
    if (idx === -1) continue;
    const value = argv[idx + 1]?.trim();
    if (!value || value.startsWith('--')) throw new Error(`--${flag} 后缺少值`);
    out[flag] = value;
  }
  return out;
}

export interface GhInfo {
  version: string;
  repo: string;
}

// 仓库来自 config.json（内置引擎模式下 cwd 不是 git 仓库，gh 无法自行推断）
export function configRepo(cwd: string = process.cwd()): string {
  if (process.env.CHECKIN_REPO) return process.env.CHECKIN_REPO;
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8')) as { repo?: unknown };
    return typeof cfg.repo === 'string' ? cfg.repo : '';
  } catch {
    return '';
  }
}

// 预检：没装 gh / 没登录 / 当前目录不是仓库，都给出可执行的下一步
export async function checkGh(run: (args: string[]) => Promise<string>, repo: string): Promise<GhInfo> {
  if (!repo) {
    throw new Error('缺少仓库信息：config.json 需包含 "repo": "owner/name"（或设置 CHECKIN_REPO）');
  }
  let version: string;
  try {
    version = (await run(['--version'])).split('\n')[0].trim();
  } catch (err) {
    if (/ENOENT/i.test((err as Error).message)) {
      throw new Error(
        '未检测到 gh CLI。macOS 安装：brew install gh（Windows：winget install GitHub.cli），装完运行 gh auth login',
      );
    }
    throw err;
  }
  try {
    await run(['auth', 'status']);
  } catch (err) {
    // 网络抖动时 gh auth status 也会非零退出，带上原因而不是一口咬定未登录
    const reason = (err as Error).message.replace(/^gh auth status 失败:\s*/, '').slice(0, 120);
    throw new Error(`gh 未登录或校验失败（${reason}）：运行 gh auth login 后重试`);
  }
  try {
    const info = JSON.parse(await run(['repo', 'view', repo, '--json', 'nameWithOwner'])) as { nameWithOwner: string };
    return { version, repo: info.nameWithOwner };
  } catch {
    throw new Error(`仓库 ${repo} 不可访问或 gh 账号无权限：运行 gh auth login 并确认账号有该仓库权限`);
  }
}

export function dispatchArgs(args: CiArgs, repo: string): string[] {
  const out = ['workflow', 'run', WORKFLOW, '--repo', repo];
  if (args.provider) out.push('-f', `provider=${args.provider}`);
  if (args.account) out.push('-f', `account=${args.account}`);
  return out;
}

export function workflowToggleArgs(action: 'enable' | 'disable', repo: string): string[] {
  return ['workflow', action, WORKFLOW, '--repo', repo];
}

// `gh workflow view checkin.yml --yaml` 的输出形如 "- name: ...\n  state: active|disabled\n"
export function workflowStateFromView(yaml: string): string {
  return /^\s*-?\s*state:\s*(\w+)\s*$/m.exec(yaml)?.[1] ?? 'unknown';
}

// 时区在指定时刻的 UTC 偏移（小时，东八区=8）：当地时刻 = UTC + offset
function tzOffsetHours(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return (asUTC - at.getTime()) / 3_600_000;
}

// 当地 HH:00 对应的 UTC cron 小时。cron 固定 UTC，DST 时区随季节漂移 1 小时，换季后重新保存定时即校正
export function cronHourFor(hour: string, tz: string, at: Date = new Date()): string {
  return String((Number(hour) - Math.round(tzOffsetHours(tz, at)) + 48) % 24).padStart(2, '0');
}

// 只替换 schedule 块的 cron 行（UTC 整点，每天一次）；无 cron 行时原样返回
export function replaceCronLine(yaml: string, utcHour: string): string {
  return yaml.replace(/- cron: '[^']*'/, `- cron: '0 ${utcHour} * * *'`);
}

// 从 workflow 文件内容读回定时：cron 的 UTC 小时 + 时区反算当地小时
export function scheduleFromCron(content: string, tz: string, at: Date = new Date()): { hour: string; tz: string } {
  const utcHour = Number(/- cron:\s*'0 (\d{2}) \* \* \*'/.exec(content)?.[1] ?? 3);
  return { hour: String((utcHour + Math.round(tzOffsetHours(tz, at)) + 48) % 24).padStart(2, '0'), tz };
}

interface RunSummary {
  databaseId: number;
  event: string;
  createdAt: string;
  status?: string;
  conclusion?: string | null;
  url?: string;
}

export function pickRun<T extends RunSummary>(runs: T[], sinceMs: number): T | null {
  const candidates = runs.filter(
    (r) => r.event === 'workflow_dispatch' && Date.parse(r.createdAt) >= sinceMs,
  );
  return candidates.sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;
}

export function filterResultLogs(text: string): string[] {
  const markers = /\[(OK|FAIL)\]|完成:|\[DONE\]|回写 Secret|::error::/;
  return text
    .split('\n')
    .filter((line) => markers.test(line) && !line.includes('^[[')) // 排除 workflow 脚本源码回显
    .map((line) => line.replace(/^[^\t]*\t[^\t]*\t[0-9T:.Z-]+\s?/, '').trim())
    .filter(Boolean);
}

export function exitCodeFor(conclusion: string | null | undefined): number {
  return conclusion === 'success' ? 0 : 1;
}

// gh CLI 封装：ci-sync 复用同一执行通道（超时与错误包装保持一致）
export function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr).trim() || err.message;
        reject(new Error(`gh ${args.slice(0, 2).join(' ')} 失败: ${message}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function findRun(sinceMs: number): Promise<RunSummary> {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await gh([
      'run',
      'list',
      '--repo',
      currentRepo,
      '--workflow',
      WORKFLOW,
      '--limit',
      '10',
      '--json',
      'databaseId,event,createdAt,status,conclusion,url',
    ]);
    const run = pickRun(JSON.parse(raw) as RunSummary[], sinceMs);
    if (run) return run;
    await sleep(POLL_MS);
  }
  throw new Error('未找到刚触发的运行，请到 Actions 页面确认');
}

async function waitForRun(run: RunSummary): Promise<RunSummary> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let lastLine = '';
  while (Date.now() < deadline) {
    const raw = await gh([
      'run',
      'view',
      String(run.databaseId),
      '--repo',
      currentRepo,
      '--json',
      'status,conclusion,url,jobs',
    ]);
    const current = JSON.parse(raw) as RunSummary & {
      jobs?: Array<{ name: string; status: string; steps?: Array<{ name: string; status: string }> }>;
    };
    const step = (current.jobs ?? [])
      .flatMap((j) => j.steps ?? [])
      .find((s) => s.status === 'in_progress');
    const line = `[CI] ${current.status}${step ? ` · ${step.name}` : ''}`;
    if (line !== lastLine) {
      console.log(line);
      lastLine = line;
    }
    if (current.status === 'completed') return current;
    await sleep(POLL_MS);
  }
  throw new Error('等待运行超时（20 分钟）');
}

async function main(): Promise<void> {
  const args = parseCiArgs(process.argv.slice(2));
  const repo = configRepo();
  currentRepo = repo;
  const info = await checkGh(gh, repo);
  if (args.workflowAction) {
    await gh(workflowToggleArgs(args.workflowAction, repo));
    console.log(`[CI] 已${args.workflowAction === 'disable' ? '禁用' : '启用'}仓库签到 workflow（${info.repo} · ${WORKFLOW}）`);
    return;
  }
  if (args.scheduleHour !== undefined) {
    const tz = args.scheduleTz ?? 'Asia/Shanghai';
    const utcHour = cronHourFor(args.scheduleHour, tz);
    const endpoint = `repos/${repo}/contents/${WORKFLOW_PATH}`;
    // 定时调度源是 workflow 的 cron 行：读文件 → 换 cron → PUT 提交（每天只真跑一次）
    try {
      const file = JSON.parse(await gh(['api', endpoint])) as { content: string; sha: string };
      const content = Buffer.from(file.content, 'base64').toString('utf8');
      if (!/- cron: '/.test(content)) throw new Error(`${WORKFLOW_PATH} 中未找到 schedule cron 行`);
      await gh([
        'api',
        '-X',
        'PUT',
        endpoint,
        '-f',
        `message=ci: 定时改为 ${tz} ${args.scheduleHour}:00（UTC ${utcHour}:00）`,
        '-f',
        `content=${Buffer.from(replaceCronLine(content, utcHour)).toString('base64')}`,
        '-f',
        `sha=${file.sha}`,
      ]);
    } catch (err) {
      // GitHub 对权限不足的写操作常伪装 404（避免泄漏资源存在性），同样指向 workflow scope 缺失
      const hint = /workflow|422|403|404/i.test((err as Error).message)
        ? '；修改 workflow 文件需要 gh 登录带 workflow 权限：gh auth refresh -s workflow 后重试'
        : '';
      throw new Error(`设置定时失败：${(err as Error).message}${hint}`);
    }
    // 时区变量仅用于「检查配置」读回显示，调度以 cron 为准
    await gh(['variable', 'set', 'AIPUNCH_CHECKIN_TZ', '--body', tz]);
    console.log(`[CI] 定时已设为 ${tz} ${args.scheduleHour}:00：workflow cron 改为 UTC ${utcHour}:00（每天只跑一次）`);
    return;
  }
  if (args.check) {
    let state = 'unknown';
    try {
      state = workflowStateFromView(await gh(['workflow', 'view', WORKFLOW, '--repo', repo, '--yaml']));
    } catch {
      /* workflow 尚未出现在 Actions 列表等场景不阻塞环境检查 */
    }
    let schedule = '';
    try {
      const vars = JSON.parse(await gh(['variable', 'list', '--repo', repo, '--json', 'name,value'])) as Array<{
        name: string;
        value: string;
      }>;
      const tz = vars.find((v) => v.name === 'AIPUNCH_CHECKIN_TZ' && v.value.trim())?.value.trim() || 'Asia/Shanghai';
      const file = JSON.parse(await gh(['api', `repos/${repo}/contents/${WORKFLOW_PATH}`])) as { content: string };
      const s = scheduleFromCron(Buffer.from(file.content, 'base64').toString('utf8'), tz);
      schedule = ` · 定时 ${s.tz} ${s.hour}:00`;
    } catch {
      /* 定时读回失败不阻塞环境检查 */
    }
    const stateLabel = state === 'active' ? '定时运行中' : state.startsWith('disabled') ? '已禁用（云端不执行）' : '状态未知';
    console.log(`[CI] 环境正常：${info.version} · ${info.repo} · 已登录 · ${stateLabel}${schedule}`);
    return;
  }
  const since = Date.now() - 60_000; // 容忍时钟偏差
  await gh(dispatchArgs(args, repo));
  const run = await findRun(since);
  console.log(`[CI] 已触发运行：${run.url ?? run.databaseId}`);
  const finished = await waitForRun(run);
  const logs = filterResultLogs(await gh(['run', 'view', String(run.databaseId), '--repo', currentRepo, '--log']));
  for (const line of logs) console.log(line);
  await saveLastRun(run.databaseId, run.url, Boolean(args.provider || args.account));
  console.log(`[CI] 运行结束：${finished.conclusion ?? 'unknown'} ${finished.url ?? ''}`.trim());
  process.exitCode = exitCodeFor(finished.conclusion);
}

// 过滤运行只覆盖对应账号，其余账号沿用上次结果；完整运行则整体替换
export function mergeRunResults(prev: ResultFile | null, entry: ResultFile, filtered: boolean): ResultFile {
  if (!filtered || !prev) return entry;
  const map = new Map((prev.results ?? []).map((r) => [`${r.provider}/${r.account}`, r]));
  for (const r of entry.results ?? []) map.set(`${r.provider}/${r.account}`, r);
  const results = [...map.values()];
  return {
    runId: entry.runId,
    finishedAt: entry.finishedAt,
    runUrl: entry.runUrl,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    results,
  };
}

// 下载 CI 产物并写入本地结构化结果，桌面端据此在卡片展示余额；失败不影响退出码
async function saveLastRun(runId: number, runUrl: string | undefined, filtered: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aipunch-result-'));
  try {
    await gh(['run', 'download', String(runId), '--repo', currentRepo, '-n', 'checkin-result', '-D', dir]);
    const data = JSON.parse(readFileSync(join(dir, 'checkin-result.json'), 'utf8')) as ResultFile;
    const entry = { ...data, runId, runUrl };
    // 单账号/单平台运行只覆盖对应账号，其余账号保留上一次结果（卡片与「今日签到」总数不丢）
    const lastPath = join(process.cwd(), '.aipunch-last-run.json');
    let prev: ResultFile | null = null;
    if (filtered && existsSync(lastPath)) {
      try {
        prev = JSON.parse(readFileSync(lastPath, 'utf8')) as ResultFile;
      } catch {
        prev = null; // 旧文件损坏时直接用本次结果
      }
    }
    writeFileSync(lastPath, JSON.stringify(mergeRunResults(prev, entry, filtered), null, 1));
    // 历史记录：保留最近 50 次原始运行，供桌面端「执行记录」页面展示
    const historyPath = join(process.cwd(), '.aipunch-runs.json');
    const history = existsSync(historyPath)
      ? (JSON.parse(readFileSync(historyPath, 'utf8')) as unknown[])
      : [];
    writeFileSync(historyPath, JSON.stringify([entry, ...history].slice(0, 50), null, 1));
  } catch {
    /* artifact 缺失（旧运行/上传失败）时跳过 */
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 仅直接执行时运行；被测试 import 时不能触发真实 CI
if (/ci-checkin\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  main().catch((err: unknown) => {
    console.error(`[CI] ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
