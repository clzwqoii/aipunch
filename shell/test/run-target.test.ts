import assert from 'node:assert/strict';
import { test } from 'node:test';
import { singleRunTarget } from '../src/run-target.ts';

// CF worker 只由 cron 触发，没有「只跑一个账号」的入口；单账号按钮必须退回整轮执行，
// 否则会落回 ci-checkin 打 GitHub，而 GitHub workflow 在 CF 平台下是禁用的（HTTP 422）
test('CF 平台单账号触发退回整轮 trigger-now，并在日志说明', () => {
  const target = singleRunTarget('cloudflare-workers', 'codearts', 'main');
  assert.equal(target.runner, 'cf-deploy');
  assert.deepEqual(target.args, ['--trigger-now']);
  assert.match(target.log, /全量/);
});

test('本地平台单账号精确到 provider/account', () => {
  const target = singleRunTarget('local', 'qoder-intl', 'main');
  assert.equal(target.runner, 'checkin');
  assert.deepEqual(target.args, ['--provider', 'qoder-intl', '--account', 'main']);
});

test('GitHub 平台单账号走 ci-checkin', () => {
  const target = singleRunTarget('github-actions', 'trae', 'main');
  assert.equal(target.runner, 'ci-checkin');
  assert.deepEqual(target.args, ['--provider', 'trae', '--account', 'main']);
});
