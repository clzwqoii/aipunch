import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeployPlan, parseDeployArgs } from './cf-deploy.ts';
import type { ConfigFile } from '../core/config.ts';

test('parseDeployArgs：token/account 必填（可从 env 兜底，重复部署/触发不必重贴），hour/tz 有默认，triggerNow 可选', () => {
  assert.deepEqual(parseDeployArgs(['--token', 't1', '--account', 'a1']), {
    token: 't1',
    account: 'a1',
    hour: '11',
    tz: 'Asia/Shanghai',
    cronOnly: false,
    triggerNow: false,
  });
  assert.deepEqual(parseDeployArgs(['--token', 't1', '--account', 'a1', '--hour', '9', '--tz', 'Asia/Tokyo', '--trigger-now']), {
    token: 't1',
    account: 'a1',
    hour: '09',
    tz: 'Asia/Tokyo',
    cronOnly: false,
    triggerNow: true,
  });
  // env 兜底：部署时写回 .env 的 CF_ACCOUNT_ID / CF_API_TOKEN
  assert.deepEqual(parseDeployArgs([], { CF_API_TOKEN: 'env-tok', CF_ACCOUNT_ID: 'env-acct' }).token, 'env-tok');
  assert.throws(() => parseDeployArgs(['--account', 'a1']), /--token/);
  assert.throws(() => parseDeployArgs(['--token', 't1']), /--account/);
  assert.throws(() => parseDeployArgs([], {}), /--token/);
});

test('buildDeployPlan：KV config 只含 accounts，Secrets 含 CF 管理凭证与各账号凭证', () => {
  const config: ConfigFile = {
    accounts: [{ provider: 'trae', name: 'main', refreshTokenEnv: 'TRAE_REFRESH_TOKEN' }],
  };
  const plan = buildDeployPlan({ ...config, platform: 'cloudflare-workers' } as ConfigFile & { platform: string }, {
    TRAE_REFRESH_TOKEN: 'tok-trae',
  }, { token: 'cf-tok', account: 'acct', hour: '11', tz: 'Asia/Shanghai' });
  assert.deepEqual(JSON.parse(plan.kvConfig), { accounts: config.accounts });
  assert.deepEqual(
    plan.secrets,
    [
      { name: 'CF_ACCOUNT_ID', value: 'acct' },
      { name: 'CF_API_TOKEN', value: 'cf-tok' },
      { name: 'TRAE_REFRESH_TOKEN', value: 'tok-trae' },
    ],
  );
  assert.equal(plan.crons.length, 1); // 北京 11:00 = UTC 3 点
  assert.equal(plan.crons[0], '0 0 03 * * *');
});

test('buildDeployPlan：账号凭证缺失时部署前整体报错（避免半部署）', () => {
  const config: ConfigFile = {
    accounts: [
      { provider: 'trae', name: 'main', refreshTokenEnv: 'TRAE_REFRESH_TOKEN' },
      { provider: 'qoder', name: 'main', refreshTokenEnv: 'QODER_REFRESH_TOKEN' },
    ],
  };
  assert.throws(() => buildDeployPlan(config, { TRAE_REFRESH_TOKEN: 'x' }, { token: 't', account: 'a', hour: '11', tz: 'Asia/Shanghai' }), /QODER_REFRESH_TOKEN/);
});
