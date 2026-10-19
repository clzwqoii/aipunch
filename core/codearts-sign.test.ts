import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUri, canonicalQuery, canonicalRequest, stringToSign, signHeaders } from './codearts-sign.ts';

test('canonicalUri：每段编码且末尾补斜杠', () => {
  assert.equal(canonicalUri('/v1/ops/delivery'), '/v1/ops/delivery/');
  assert.equal(canonicalUri('/v1/ops/delivery/'), '/v1/ops/delivery/');
});

test('canonicalQuery：key/value 编码后按字典序排列', () => {
  assert.equal(canonicalQuery('channel=IDE'), 'channel=IDE');
  assert.equal(canonicalQuery('b=2&a=1'), 'a=1&b=2');
});

test('signHeaders：Authorization 格式与确定性（固定向量）', () => {
  const headers = signHeaders(
    { accessKeyId: 'AK-TEST', secretAccessKey: 'SK-TEST', securityToken: 'ST-TOKEN' },
    {
      method: 'GET',
      path: '/v1/ops/delivery',
      rawQuery: 'channel=IDE',
      headers: { Accept: 'application/json', 'X-Language': 'zh-cn' },
      payload: Buffer.from(''),
      xSdkDate: '20261019T061500Z',
    },
  );
  assert.equal(headers['X-Sdk-Date'], '20261019T061500Z');
  assert.equal(headers['X-Security-Token'], 'ST-TOKEN');
  assert.match(headers['X-Sdk-Content-Sha256'], /^[0-9a-f]{64}$/);
  assert.match(
    headers.Authorization,
    /^SDK-HMAC-SHA256 Access=AK-TEST, SignedHeaders=accept;x-language;x-sdk-content-sha256;x-sdk-date;x-security-token, Signature=[0-9a-f]{64}$/,
  );
  // 相同输入必须产生相同签名（纯函数、无内部时钟）
  const again = signHeaders(
    { accessKeyId: 'AK-TEST', secretAccessKey: 'SK-TEST', securityToken: 'ST-TOKEN' },
    {
      method: 'GET',
      path: '/v1/ops/delivery',
      rawQuery: 'channel=IDE',
      headers: { Accept: 'application/json', 'X-Language': 'zh-cn' },
      payload: Buffer.from(''),
      xSdkDate: '20261019T061500Z',
    },
  );
  assert.equal(again.Authorization, headers.Authorization);
});

test('stringToSign：算法 + 日期 + CanonicalRequest 的 sha256', () => {
  const request = canonicalRequest('POST', '/v1/ops/claim', '', { 'Content-Type': 'application/json' }, 'abc123');
  const sts = stringToSign(request, '20261019T061500Z');
  const lines = sts.split('\n');
  assert.equal(lines[0], 'SDK-HMAC-SHA256');
  assert.equal(lines[1], '20261019T061500Z');
  assert.match(lines[2], /^[0-9a-f]{64}$/);
});
