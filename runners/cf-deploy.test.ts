import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeployPlan, parseDeployArgs, workerSha } from './cf-deploy.ts';
import type { ConfigFile } from '../core/config.ts';

test('parseDeployArgs：token/account 必填（可从 env 兜底，重复部署/触发不必重贴），hour/tz 有默认，triggerNow 可选', () => {
  assert.deepEqual(parseDeployArgs(['--token', 't1', '--account', 'a1']), {
    token: 't1',
    account: 'a1',
    hour: '11',
    tz: 'Asia/Shanghai',
    cronOnly: false,
    triggerNow: false,
    onlySecrets: [],
  });
  assert.deepEqual(parseDeployArgs(['--token', 't1', '--account', 'a1', '--hour', '9', '--tz', 'Asia/Tokyo', '--trigger-now']), {
    token: 't1',
    account: 'a1',
    hour: '09',
    tz: 'Asia/Tokyo',
    cronOnly: false,
    triggerNow: true,
    onlySecrets: [],
  });
  // env 兜底：部署时写回 .env 的 CF_ACCOUNT_ID / CF_API_TOKEN
  assert.deepEqual(parseDeployArgs([], { CF_API_TOKEN: 'env-tok', CF_ACCOUNT_ID: 'env-acct' }).token, 'env-tok');
  assert.throws(() => parseDeployArgs(['--account', 'a1']), /--token/);
  assert.throws(() => parseDeployArgs(['--token', 't1']), /--account/);
  assert.throws(() => parseDeployArgs([], {}), /--token/);
});

test('workerSha 对脚本内容取稳定指纹（决定是否跳过重复上传）', () => {
  assert.equal(workerSha('export default {}'), workerSha('export default {}'));
  assert.notEqual(workerSha('export default {}'), workerSha('export default { /* v2 */ }'));
  assert.match(workerSha('x'), /^[0-9a-f]{64}$/);
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
  assert.equal(plan.crons[0], '0 03 * * *');
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

// 全量部署会用本地 .env 旧票覆盖 worker 自轮换的新链（ADR 0004 实测：重导入 trae/codearts 票）
test('parseDeployArgs：--only-secrets 收集名字列表，缺省为空（全量部署）', () => {
  assert.deepEqual(
    parseDeployArgs(['--token', 't', '--account', 'a', '--only-secrets', 'QODER_INTL_REFRESH_TOKEN', 'QODER_INTL_COSY_MACHINE_TOKEN']).onlySecrets,
    ['QODER_INTL_REFRESH_TOKEN', 'QODER_INTL_COSY_MACHINE_TOKEN'],
  );
  assert.deepEqual(parseDeployArgs(['--token', 't', '--account', 'a']).onlySecrets, []);
  // 列表在遇到下一个 flag 时结束
  assert.deepEqual(
    parseDeployArgs(['--token', 't', '--account', 'a', '--only-secrets', 'A', '--trigger-now']).onlySecrets,
    ['A'],
  );
});

test('buildDeployPlan：--only-secrets 只推指定凭证，其他账号旧票不覆盖', () => {
  const config: ConfigFile = {
    accounts: [
      { provider: 'trae', name: 'main', refreshTokenEnv: 'TRAE_REFRESH_TOKEN' },
      { provider: 'qoder-intl', name: 'main', refreshTokenEnv: 'QODER_INTL_REFRESH_TOKEN' },
    ],
  };
  const plan = buildDeployPlan(
    config,
    { TRAE_REFRESH_TOKEN: 'old-token', QODER_INTL_REFRESH_TOKEN: 'new-token' },
    { token: 'cf-tok', account: 'acct', hour: '11', tz: 'Asia/Shanghai', onlySecrets: ['QODER_INTL_REFRESH_TOKEN'] },
  );
  assert.deepEqual(plan.secrets.map((s) => s.name), ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'QODER_INTL_REFRESH_TOKEN']);
  // KV config 仍按全量写（账号清单要包含新 provider）
  assert.equal(JSON.parse(plan.kvConfig).accounts.length, 2);
});

test('buildDeployPlan：--only-secrets 名字不在凭证清单时报错（防拼错静默跳过）', () => {
  const config: ConfigFile = { accounts: [{ provider: 'qoder-intl', name: 'main', refreshTokenEnv: 'QODER_INTL_REFRESH_TOKEN' }] };
  assert.throws(
    () =>
      buildDeployPlan(config, { QODER_INTL_REFRESH_TOKEN: 'x' }, {
        token: 't',
        account: 'a',
        hour: '11',
        tz: 'Asia/Shanghai',
        onlySecrets: ['QODER_INTL_TYPO'],
      }),
    /QODER_INTL_TYPO/,
  );
});
