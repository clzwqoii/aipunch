import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGh, configRepo, dispatchArgs, exitCodeFor, filterResultLogs, mergeRunResults, parseCiArgs, pickRun } from './ci-checkin.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parseCiArgs 解析 provider/account 与 --check', () => {
  assert.deepEqual(parseCiArgs([]), {});
  assert.deepEqual(parseCiArgs(['--provider', 'trae']), { provider: 'trae' });
  assert.deepEqual(parseCiArgs(['--provider', 'trae', '--account', 'main']), { provider: 'trae', account: 'main' });
  assert.deepEqual(parseCiArgs(['--check']), { check: true });
  assert.throws(() => parseCiArgs(['--provider']), /缺少值/);
});

test('checkGh 未安装时给出安装与登录指引', async () => {
  const run = async () => {
    throw new Error('gh --version 失败: spawn gh ENOENT');
  };
  await assert.rejects(checkGh(run, 'o/r'), /brew install gh/);
});

test('checkGh 未登录时提示 gh auth login', async () => {
  const run = async (args: string[]) => {
    if (args[0] === '--version') return 'gh version 2.60.0 (2026-01-01)';
    throw new Error('gh auth status 失败: not logged in');
  };
  await assert.rejects(checkGh(run, 'o/r'), /gh auth login/);
});

test('checkGh 目录不是 GitHub 仓库时提示检查 remote 与权限', async () => {
  const run = async (args: string[]) => {
    if (args[0] === '--version') return 'gh version 2.60.0';
    if (args[0] === 'auth') return 'Logged in to github.com';
    throw new Error('gh repo view 失败: not a git repository');
  };
  await assert.rejects(checkGh(run, 'o/r'), /仓库|权限/);
});

test('checkGh 通过时返回版本与仓库', async () => {
  const run = async (args: string[]) => {
    if (args[0] === '--version') return 'gh version 2.60.0 (2026-01-01)\nhttps://github.com/cli/cli';
    if (args[0] === 'auth') return 'Logged in to github.com account clzwqoii';
    return '{"nameWithOwner":"clzwqoii/aipunch"}';
  };
  assert.deepEqual(await checkGh(run, 'clzwqoii/aipunch'), { version: 'gh version 2.60.0 (2026-01-01)', repo: 'clzwqoii/aipunch' });
});

test('dispatchArgs 带仓库与过滤器', () => {
  assert.deepEqual(dispatchArgs({}, 'o/r'), ['workflow', 'run', 'checkin.yml', '--repo', 'o/r']);
  assert.deepEqual(dispatchArgs({ provider: 'trae' }, 'o/r'), [
    'workflow',
    'run',
    'checkin.yml',
    '--repo',
    'o/r',
    '-f',
    'provider=trae',
  ]);
});

test('pickRun 只认触发时间之后的 workflow_dispatch 运行', () => {
  const since = Date.parse('2026-10-23T04:00:00Z');
  const runs = [
    { databaseId: 1, event: 'schedule', createdAt: '2026-10-23T04:00:05Z' },
    { databaseId: 2, event: 'workflow_dispatch', createdAt: '2026-10-23T03:59:00Z' },
    { databaseId: 3, event: 'workflow_dispatch', createdAt: '2026-10-23T04:00:02Z' },
    { databaseId: 4, event: 'workflow_dispatch', createdAt: '2026-10-23T04:00:03Z' },
  ];
  assert.equal(pickRun(runs, since)?.databaseId, 4);
  assert.equal(pickRun(runs.slice(0, 2), since), null);
});

test('filterResultLogs 提取签到结果并去掉 job/step/时间戳前缀', () => {
  const raw = [
    'checkin\tSet up job\t2026-10-23T04:00:00.0000000Z Secret source: Actions',
    'checkin\t执行签到\t2026-10-23T04:00:10.0000000Z [OK] trae/main: 签到成功 (300ms)',
    'checkin\t执行签到\t2026-10-23T04:00:11.0000000Z [FAIL] qoder/main: 401',
    'checkin\t执行签到\t2026-10-23T04:00:12.0000000Z 完成: 1/2 成功',
    'checkin\t执行签到\t2026-10-23T04:00:13.0000000Z ^[[36;1m    echo "检测到 refreshToken 轮换，回写 Secret"^[[0m',
    'checkin\t执行签到\t2026-10-23T04:00:14.0000000Z 随机日志行',
  ].join('\n');
  assert.deepEqual(filterResultLogs(raw), [
    '[OK] trae/main: 签到成功 (300ms)',
    '[FAIL] qoder/main: 401',
    '完成: 1/2 成功',
  ]);
});

test('exitCodeFor 按结论给退出码', () => {
  assert.equal(exitCodeFor('success'), 0);
  assert.equal(exitCodeFor('failure'), 1);
  assert.equal(exitCodeFor(null), 1);
});

test('configRepo 从 config.json 读取 repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aipunch-repo-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ repo: 'o/r', accounts: [] }));
  assert.equal(configRepo(dir), 'o/r');
  rmSync(dir, { recursive: true, force: true });
});

test('mergeRunResults 过滤运行保留其余账号，完整运行整体替换', () => {
  const entry = (provider: string, ok: boolean) => ({ provider, account: 'main', ok, message: '', balance: null });
  const prev = {
    finishedAt: '2026-10-24T03:00:00Z',
    total: 2,
    succeeded: 2,
    results: [entry('a', true), entry('b', true)],
  };
  const next = { finishedAt: '2026-10-24T04:00:00Z', total: 1, succeeded: 1, results: [entry('a', true)] };
  const merged = mergeRunResults(prev, next, true);
  assert.equal(merged.total, 2);
  assert.equal(merged.results.length, 2);
  assert.equal(merged.runUrl, undefined);
  const replaced = mergeRunResults(prev, next, false);
  assert.equal(replaced.total, 1);
  assert.equal(replaced.results.length, 1);
});
