import { createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

// DPoP proof（RFC 9449，契约来源 RobbsLuo/Coding2API，华为 STS 实测兼容）：
//   header { alg:'ES256', typ:'dpop+jwk', jwk:公钥JWK }；payload { htm, htu, iat, jti }
//   签名 ES256 = P-256 ECDSA-SHA256 的原始 R‖S（各 32 字节大端），**必须低-S 归一化**
//   （cryptography 系约 50% 概率出 high-S，STS 会判 InvalidDPoPHeader）
// 私钥 JWK 与 refresh_token 绑定：刷新必须沿用签发时那一把，否则 STS5.1806。
// 数值字段均为 base64url 无填充。

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type DpopJwk = { kty: string; crv: string; x: string; y: string; d: string };

export function newDpopKeyPair(): DpopJwk {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as unknown as DpopJwk;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
}

export function publicJwkOf(jwk: DpopJwk): { kty: string; crv: string; x: string; y: string } {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export function privateKeyFromJwk(jwk: DpopJwk) {
  return createPrivateKey({ format: 'jwk', key: { ...jwk } });
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function toFixed32(buffer: Buffer): Buffer {
  const stripped = buffer.subarray(buffer.findIndex((b) => b !== 0) === -1 ? 0 : buffer.findIndex((b) => b !== 0));
  if (stripped.length === 32) return stripped;
  if (stripped.length > 32) return stripped.subarray(stripped.length - 32);
  return Buffer.concat([Buffer.alloc(32 - stripped.length, 0), stripped]);
}

// DER SEQUENCE { INTEGER r, INTEGER s } → 定长 32+32
function derToRawRs(der: Buffer): Buffer {
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
  const readInt = (): Buffer => {
    if (der[offset] !== 0x02) throw new Error('bad DER signature');
    const len = der[offset + 1];
    const value = der.subarray(offset + 2, offset + 2 + len);
    offset += 2 + len;
    return value;
  };
  return Buffer.concat([toFixed32(readInt()), toFixed32(readInt())]);
}

function normalizeLowS(raw: Buffer): Buffer {
  const s = BigInt('0x' + raw.subarray(32).toString('hex'));
  if (s <= P256_ORDER >> 1n) return raw;
  const lowS = P256_ORDER - s;
  const lowBuf = Buffer.alloc(32);
  lowBuf.writeBigUInt64BE(0n, 0); // 高 64 位（P-256 阶的高 64 位为 0）
  // 通用写法：逐字节回填（避免依赖 bigint 字宽度假设）
  let remaining = lowS;
  for (let i = 31; i >= 0; i -= 1) {
    lowBuf[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return Buffer.concat([raw.subarray(0, 32), lowBuf]);
}

export interface SignProofOptions {
  htm?: string;
  htu: string;
  iat?: number;
  jti?: string;
}

export function signProof(jwk: DpopJwk, htu: string, options: { htm?: string; iat?: number; jti?: string } = {}): string {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwkOf(jwk) };
  const payload = {
    htm: options.htm ?? 'POST',
    htu,
    iat: options.iat ?? Math.floor(Date.now() / 1000),
    jti: options.jti ?? randomBytes(16).toString('hex'),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const der = createSign('sha256').update(signingInput).sign(privateKeyFromJwk(jwk));
  return `${signingInput}.${normalizeLowS(derToRawRs(der)).toString('base64url')}`;
}
