import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResultFile } from '../core/result.ts';

// 桌面端「一键签到」= 触发 GitHub Actions 并展示结果：签到只在 CI 跑（单执行端），
// 避免本地/CI 共用单次轮换票互踢。依赖 gh CLI 已登录（gh auth login）。
// 用法：npm run ci-checkin [-- --provider trae] [-- --account main]
const WORKFLOW = 'checkin.yml';
const POLL_MS = 3000;
const FIND_TIMEOUT_MS = 90_000;
const RUN_TIMEOUT_MS = 20 * 60_000;

export interface CiArgs {
  provider?: string;
  account?: string;
  check?: boolean;
}

export function parseCiArgs(argv: string[]): CiArgs {
  const out: CiArgs = {};
  if (argv.includes('--check')) out.check = true;
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

// 预检：没装 gh / 没登录 / 当前目录不是仓库，都给出可执行的下一步
export async function checkGh(run: (args: string[]) => Promise<string>): Promise<GhInfo> {
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
    const repo = JSON.parse(await run(['repo', 'view', '--json', 'nameWithOwner'])) as { nameWithOwner: string };
    return { version, repo: repo.nameWithOwner };
  } catch {
    throw new Error('当前项目不是 GitHub 仓库或 gh 账号无权限：检查 git remote 指向，并用该账号 gh auth login');
  }
}

export function dispatchArgs(args: CiArgs): string[] {
  const out = ['workflow', 'run', WORKFLOW];
  if (args.provider) out.push('-f', `provider=${args.provider}`);
  if (args.account) out.push('-f', `account=${args.account}`);
  return out;
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

function gh(args: string[]): Promise<string> {
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
  const info = await checkGh(gh);
  if (args.check) {
    console.log(`[CI] 环境正常：${info.version} · ${info.repo} · 已登录`);
    return;
  }
  const since = Date.now() - 60_000; // 容忍时钟偏差
  await gh(dispatchArgs(args));
  const run = await findRun(since);
  console.log(`[CI] 已触发运行：${run.url ?? run.databaseId}`);
  const finished = await waitForRun(run);
  const logs = filterResultLogs(await gh(['run', 'view', String(run.databaseId), '--log']));
  for (const line of logs) console.log(line);
  await saveLastRun(run.databaseId);
  console.log(`[CI] 运行结束：${finished.conclusion ?? 'unknown'} ${finished.url ?? ''}`.trim());
  process.exitCode = exitCodeFor(finished.conclusion);
}

// 下载 CI 产物并写入本地结构化结果，桌面端据此在卡片展示余额；失败不影响退出码
async function saveLastRun(runId: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aipunch-result-'));
  try {
    await gh(['run', 'download', String(runId), '-n', 'checkin-result', '-D', dir]);
    const data = JSON.parse(readFileSync(join(dir, 'checkin-result.json'), 'utf8')) as ResultFile;
    writeFileSync(join(process.cwd(), '.aipunch-last-run.json'), JSON.stringify(data, null, 1));
  } catch {
    /* artifact 缺失（旧运行/上传失败）时跳过 */
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 仅直接执行时运行；被测试 import 时不能触发真实 CI
if (process.argv[1]?.endsWith('ci-checkin.ts')) {
  main().catch((err: unknown) => {
    console.error(`[CI] ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
