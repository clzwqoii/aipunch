import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchArgs, exitCodeFor, filterResultLogs, parseCiArgs, pickRun } from './ci-checkin.ts';

test('parseCiArgs 解析 provider/account', () => {
  assert.deepEqual(parseCiArgs([]), {});
  assert.deepEqual(parseCiArgs(['--provider', 'trae']), { provider: 'trae' });
  assert.deepEqual(parseCiArgs(['--provider', 'trae', '--account', 'main']), { provider: 'trae', account: 'main' });
  assert.throws(() => parseCiArgs(['--provider']), /缺少值/);
});

test('dispatchArgs 只带非空过滤器', () => {
  assert.deepEqual(dispatchArgs({}), ['workflow', 'run', 'checkin.yml']);
  assert.deepEqual(dispatchArgs({ provider: 'trae' }), [
    'workflow',
    'run',
    'checkin.yml',
    '-f',
    'provider=trae',
  ]);
  assert.deepEqual(dispatchArgs({ account: 'main' }), ['workflow', 'run', 'checkin.yml', '-f', 'account=main']);
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
