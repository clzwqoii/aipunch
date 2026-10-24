import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunResult } from '../core/types.ts';
import { kvResultEntry, secretsView } from './worker.ts';

function fakeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    startedAt: '2026-10-24T03:00:00.000Z',
    finishedAt: '2026-10-24T03:00:05.000Z',
    total: 1,
    succeeded: 1,
    results: [
      {
        account: 'main',
        provider: 'trae',
        ok: true,
        message: '签到成功',
        durationMs: 300,
        refreshTokenEnv: 'TRAE_REFRESH_TOKEN',
      },
    ],
    ...overrides,
  };
}

test('kvResultEntry 产出 KV 结果条目：时间戳 runId + ISO finishedAt + 结构化结果', () => {
  const now = new Date('2026-10-24T03:00:05.000Z');
  const entry = kvResultEntry(fakeRun(), now);
  assert.equal(entry.runId, now.getTime());
  assert.equal(entry.finishedAt, now.toISOString());
  assert.equal(entry.total, 1);
  assert.equal(entry.succeeded, 1);
  assert.equal(entry.results[0].provider, 'trae');
});

test('secretsView 只取字符串值的绑定（剥离 KV namespace 等非 Secret 对象）', () => {
  const env = {
    TRAE_REFRESH_TOKEN: 'tok',
    CF_ACCOUNT_ID: 'acct',
    AIPUNCH_KV: { get: async () => null, put: async () => {} },
  } as unknown as Record<string, unknown>;
  assert.deepEqual(secretsView(env), { TRAE_REFRESH_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' });
});
