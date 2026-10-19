import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pkcePair, newTicketIdentity, buildAuthorizeUrl, redirectUri, hasCredentials, LOGIN_CONFIG } from './codearts-auth.ts';

test('pkcePair：challenge = base64url(sha256(verifier)) 无填充', () => {
  const [verifier, challenge] = pkcePair('fixed-verifier');
  const expected = createHash('sha256').update('fixed-verifier').digest('base64url');
  assert.equal(verifier, 'fixed-verifier');
  assert.equal(challenge, expected);
  assert.doesNotMatch(challenge, /=/);
});

test('newTicketIdentity：ticket_id/secret 各 32 位十六进制且不重复', () => {
  const a = newTicketIdentity();
  const b = newTicketIdentity();
  assert.match(a.ticketId, /^[0-9a-f]{32}$/);
  assert.match(a.secret, /^[0-9a-f]{32}$/);
  assert.notEqual(a.ticketId, b.ticketId);
  assert.notEqual(a.secret, b.secret);
});

test('buildAuthorizeUrl：参数集与官方插件逐项对齐', () => {
  const url = buildAuthorizeUrl(LOGIN_CONFIG, { ticketId: 'tid', codeChallenge: 'chal', port: 17388 });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://codearts.huaweicloud.com/portal/authorize');
  const q = parsed.searchParams;
  assert.equal(q.get('client_id'), 'codearts-agent');
  assert.equal(q.get('code_challenge'), 'chal');
  assert.equal(q.get('code_challenge_method'), 'SHA-256'); // 官方只认这个，S256 被拒
  assert.equal(q.get('ticket_id'), 'tid');
  assert.equal(q.get('plugin-name'), 'huaweicloud.authentication');
  assert.equal(q.get('plugin-version'), '1.0.0');
  assert.equal(q.get('port'), '17388');
});

test('redirectUri：本地回调地址', () => {
  assert.equal(redirectUri(LOGIN_CONFIG, 17388), 'http://127.0.0.1:17388/oauth/callback');
});

test('hasCredentials：新旧两种凭证形态都认', () => {
  assert.ok(hasCredentials({ credentials: { security_token: 'st' } }));
  assert.ok(hasCredentials({ credential: { securitytoken: 'st' } }));
  assert.ok(!hasCredentials({}));
  assert.ok(!hasCredentials({ credentials: {} }));
});
