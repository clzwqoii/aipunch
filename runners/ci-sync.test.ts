import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSynced, pickLatestCompleted, planKvSync, platformFromConfig, shouldSync } from './ci-sync.ts';
import type { ResultFile } from '../core/result.ts';

function kvEntry(overrides: Partial<ResultFile> = {}): ResultFile {
  return {
    runId: 1729700400000,
    finishedAt: '2026-10-24T03:00:05Z',
    total: 2,
    succeeded: 2,
    results: [],
    ...overrides,
  };
}

test('planKvSync：无结果/已同步/不比本地新→跳过，新结果→放行（ADR 0004 KV 源）', () => {
  const entry = kvEntry();
  assert.deepEqual(planKvSync(null, null, []), { skip: true, reason: 'KV 暂无结果' });
  assert.deepEqual(planKvSync(JSON.stringify(entry), null, [entry]), { skip: true, reason: '运行 #1729700400000 已同步' });
  const newerLocal = kvEntry({ finishedAt: '2026-10-24T05:00:00Z', runId: 1 });
  assert.deepEqual(
    planKvSync(JSON.stringify(entry), newerLocal, []),
    { skip: true, reason: '本地已是最新' },
  );
  const plan = planKvSync(JSON.stringify(entry), null, []);
  assert.equal((plan as { skip: boolean }).skip, false, '新结果放行');
  assert.equal((plan as { entry: ResultFile }).entry.runId, entry.runId);
});

test('platformFromConfig 从 config.json 读平台，缺失回 github-actions 语义（空串）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aipunch-sync-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ accounts: [], platform: 'cloudflare-workers' }));
  assert.equal(platformFromConfig(dir), 'cloudflare-workers');
  writeFileSync(path, JSON.stringify({ accounts: [] }));
  assert.equal(platformFromConfig(dir), '');
  assert.equal(platformFromConfig(join(dir, 'nope')), '');
});

test('pickLatestCompleted 只认已完成运行并取最新一条（不限触发来源）', () => {
  const runs = [
    { databaseId: 10, event: 'schedule', status: 'completed', updatedAt: '2026-10-24T03:02:00Z' },
    { databaseId: 11, event: 'workflow_dispatch', status: 'in_progress', updatedAt: '2026-10-24T05:00:00Z' },
    { databaseId: 12, event: 'schedule', status: 'completed', updatedAt: '2026-10-24T11:02:00Z' },
    { databaseId: 9, event: 'webhook', status: 'completed', updatedAt: '2026-10-23T03:02:00Z' },
  ];
  // 定时跑完的最新结果（12）必须能被选中——这正是 ci-sync 要补的同步缺口
  assert.equal(pickLatestCompleted(runs)?.databaseId, 12);
  assert.equal(pickLatestCompleted([]), null);
  assert.equal(
    pickLatestCompleted([{ databaseId: 1, status: 'queued' }]),
    null,
    '无已完成运行时返回 null',
  );
});

test('shouldSync 只在远端比本地新时同步', () => {
  assert.equal(shouldSync('2026-10-24T11:02:00Z', '2026-10-24T09:00:00Z'), true, '远端新→同步');
  assert.equal(shouldSync('2026-10-24T03:02:00Z', '2026-10-24T09:00:00Z'), false, '远端旧→不同步，避免覆盖本地更新的单跑结果');
  assert.equal(shouldSync('2026-10-24T09:00:00Z', '2026-10-24T09:00:00Z'), false, '时间相等→不同步');
  assert.equal(shouldSync(undefined, '2026-10-24T09:00:00Z'), false, '远端无时间→不同步');
  assert.equal(shouldSync('2026-10-24T11:02:00Z', undefined), true, '本地无记录→同步');
});

test('isSynced 按 runId 判断该运行是否已拉取过（防重复追加历史）', () => {
  const history = [{ runId: 12 }, { runId: 10 }, {}];
  assert.equal(isSynced(history, 12), true, '已同步过的 run 不再重复拉取');
  assert.equal(isSynced(history, 13), false);
  assert.equal(isSynced([], 12), false);
  // 旧格式历史条目无 runId：视为未同步，重新拉一次幂等合并无害
  assert.equal(isSynced([{}], 12), false);
});
