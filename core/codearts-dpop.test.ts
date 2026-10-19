import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { newDpopKeyPair, publicJwkOf, signProof, privateKeyFromJwk } from './codearts-dpop.ts';

const subtle = webcrypto.subtle;

async function importVerifyKey(jwk: { kty: string; crv: string; x: string; y: string }) {
  return subtle.importKey('jwk', { ...jwk, alg: 'ES256', ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

test('newDpopKeyPair：生成合法 EC P-256 JWK（x/y/d）', () => {
  const jwk = newDpopKeyPair();
  assert.equal(jwk.kty, 'EC');
  assert.equal(jwk.crv, 'P-256');
  for (const field of ['x', 'y', 'd'] as const) {
    assert.match(jwk[field], /^[A-Za-z0-9_-]+$/); // base64url 无填充
    assert.equal(Buffer.from(jwk[field], 'base64url').length, 32);
  }
});

test('signProof：三段 JWT，头带 dpop+jwt/ES256/公钥 JWK，载荷四字段，可验签', async () => {
  const jwk = newDpopKeyPair();
  const proof = signProof(jwk, 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens', {
    htm: 'POST',
    iat: 1790000000,
    jti: 'fixed-jti-001',
  });
  const parts = proof.split('.');
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  assert.equal(header.alg, 'ES256');
  assert.equal(header.typ, 'dpop+jwt');
  assert.deepEqual(Object.keys(header.jwk).sort(), ['crv', 'kty', 'x', 'y']);
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.deepEqual(payload, {
    htm: 'POST',
    htu: 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens',
    iat: 1790000000,
    jti: 'fixed-jti-001',
  });
  // 公钥验签（raw R||S，64 字节）
  // 公钥验签（raw R‖S，64 字节）。用 WebCrypto 而非 Node createVerify+ieee-p1363：
  // 后者对同一条 raw 签名实测验不过（Node 该路径有坑），WebCrypto 是独立实现可作裁判。
  const key = await importVerifyKey(publicJwkOf(jwk));
  assert.ok(
    await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(parts[2], 'base64url'), Buffer.from(`${parts[0]}.${parts[1]}`)),
  );
});

test('signProof：低-S 归一化（s 恒 ≤ 阶的一半）', () => {
  const jwk = newDpopKeyPair();
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  for (let i = 0; i < 20; i += 1) {
    const proof = signProof(jwk, 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens', { htm: 'POST', iat: 1790000000 + i, jti: `jti-${i}` });
    const sig = Buffer.from(proof.split('.')[2], 'base64url');
    assert.equal(sig.length, 64);
    const s = BigInt('0x' + sig.subarray(32).toString('hex'));
    assert.ok(s <= n >> 1n, `第 ${i} 次签名 s 超过 n/2`);
  }
});

test('publicJwkOf：剥离私钥 d', () => {
  const jwk = newDpopKeyPair();
  const pub = publicJwkOf(jwk);
  assert.deepEqual(Object.keys(pub).sort(), ['crv', 'kty', 'x', 'y']);
});
