import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunResult } from '../core/types.ts';
import { applyRotations, kvResultEntry, persistRotations, pushRunHistory, secretsView, shouldSelfHealCron } from './worker.ts';

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

function rotatedRun(): RunResult {
  return fakeRun({
    results: [
      {
        account: 'main',
        provider: 'codearts',
        ok: true,
        message: '签到成功',
        durationMs: 300,
        refreshTokenEnv: 'CODEARTS_REFRESH_TOKEN',
        rotatedRefreshToken: 'rt-new',
      },
    ],
  });
}

test('轮换票回写瞬时失败会重试一次，成功则不算失败', async () => {
  let attempts = 0;
  const failures = await persistRotations({} as never, rotatedRun(), async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('HTTP 429');
  });
  assert.deepEqual(failures, []);
  assert.equal(attempts, 2);
});

test('轮换票回写持续失败必须透出失败项，不能静默', async () => {
  const failures = await persistRotations({} as never, rotatedRun(), async () => {
    throw new Error('HTTP 500');
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /CODEARTS_REFRESH_TOKEN.*HTTP 500/);
});

test('pushRunHistory 去重、按新到旧、限制条数', () => {
  const entry = (id: number) => ({ runId: id, total: 1, succeeded: 1 });
  const prev = [entry(3), entry(2), entry(1)];
  assert.deepEqual(pushRunHistory(JSON.stringify(prev), entry(4)), [entry(4), entry(3), entry(2), entry(1)]);
  // 同 runId 覆盖而不是重复
  assert.deepEqual(pushRunHistory(JSON.stringify(prev), entry(3)), [entry(3), entry(2), entry(1)]);
  // 超限截断
  const many = Array.from({ length: 5 }, (_, i) => entry(i + 1));
  assert.equal(pushRunHistory(JSON.stringify(many), entry(9), 3).length, 3);
  // 损坏历史按空处理
  assert.deepEqual(pushRunHistory('not-json', entry(1)), [entry(1)]);
});

// 热 isolate 会缓存旧 Secrets（部署/回写后 env 仍是旧值）：运行时轮换票必须自己记住，
// 否则同一 isolate 的下一轮执行拿已作废的旧票刷新（实测 12:20 成功、12:31 起连续 400）
test('applyRotations：运行时轮换票覆盖 Secrets 旧值，且不修改入参', () => {
  const view = { CODEARTS_REFRESH_TOKEN: 'old', OTHER: 'x' };
  const merged = applyRotations(view, new Map([['CODEARTS_REFRESH_TOKEN', 'new']]));
  assert.equal(merged.CODEARTS_REFRESH_TOKEN, 'new');
  assert.equal(merged.OTHER, 'x');
  assert.equal(view.CODEARTS_REFRESH_TOKEN, 'old');
});

test('applyRotations：无缓存时原样返回（零开销路径）', () => {
  const view = { A: '1' };
  assert.equal(applyRotations(view, new Map()), view);
});

// trigger-now 会把 cron 临时改成每分钟，中断时恢复步骤不会执行（进程被杀/网络失败）。
// worker 自己发现「每分钟 cron 且触发标记已过期」时必须恢复每日 cron，否则每天烧掉 4 倍 KV 写配额。
test('shouldSelfHealCron：每分钟 cron 且标记超过宽限才自愈', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  const grace = 10 * 60_000;
  assert.equal(shouldSelfHealCron('* * * * *', String(now.getTime() - 11 * 60_000), now, grace), true);
  assert.equal(shouldSelfHealCron('* * * * *', String(now.getTime() - 5 * 60_000), now, grace), false);
  assert.equal(shouldSelfHealCron('0 03 * * *', String(now.getTime() - 11 * 60_000), now, grace), false);
  assert.equal(shouldSelfHealCron('* * * * *', undefined, now, grace), false);
  assert.equal(shouldSelfHealCron('* * * * *', 'junk', now, grace), false);
  assert.equal(shouldSelfHealCron('* * * * *', '0', now, grace), false);
});
