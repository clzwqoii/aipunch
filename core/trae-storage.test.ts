import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TRAE_STORAGE_SALTS,
  deriveKeyIv,
  decryptStorageValue,
  extractDeviceId,
  extractCredentials,
  locateStorageJson,
} from './trae-storage.ts';

// 按社区实现的密文结构构造测试夹具：6 字节头 + 32 字节 rb + AES-128-CBC 密文；
// 明文 = 64 字节头（解密后丢弃）+ 真实 JSON。rb 固定保证可重复。
function buildBlob(rb: Buffer, json: string): string {
  const { key, iv } = deriveKeyIv(rb);
  const header = Buffer.alloc(64, 0x41);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.concat([header, Buffer.from(json, 'utf8')])), cipher.final()]);
  return Buffer.concat([Buffer.alloc(6, 0), rb, enc]).toString('base64');
}

test('按 spec 解出 storage 值：跳过 6 字节头、rb 派生 key/iv、丢弃明文前 64 字节', async () => {
  const json = JSON.stringify({ refreshToken: 'tr-1', token: 'at-1', userId: '10001' });
  const blob = buildBlob(Buffer.alloc(32, 7), json);
  assert.equal(decryptStorageValue(blob), json);
});

test('密文损坏时返回 null 不抛错', async () => {
  assert.equal(decryptStorageValue(Buffer.from('garbage-not-base64-json').toString('base64')), null);
});

test('deriveKeyIv：sha512(rb) 再 sha512(h||saltXor)，前 16 为 key 次 16 为 iv', async () => {
  const rb = Buffer.alloc(32, 3);
  const { key, iv } = deriveKeyIv(rb);
  const h = crypto.createHash('sha512').update(rb).digest();
  const saltXor = Buffer.from(TRAE_STORAGE_SALTS.a.map((b, i) => b ^ TRAE_STORAGE_SALTS.b[i]));
  const fh = crypto.createHash('sha512').update(Buffer.concat([h, saltXor])).digest();
  assert.deepEqual(key, fh.subarray(0, 16));
  assert.deepEqual(iv, fh.subarray(16, 32));
});

test('设备号取 icube-dc 键的十进制部分，拒绝 UUID 与杂键', async () => {
  const keys = [
    'iCubeAuthInfo://usertag',
    'iCubeAuthInfo://icube.cloudide',
    'iCubeAuthInfo://icube-dc:626064396416234',
    'iCubeAuthInfo://icube-dc:3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  ];
  assert.equal(extractDeviceId(keys), '626064396416234');
});

test('从解密 JSON 提取 refreshToken/token/userId', async () => {
  const json = '{"x":1,"refreshToken":"tr-abc","token":"at-def","userId":"778899"}';
  const creds = extractCredentials(json);
  assert.equal(creds.refreshToken, 'tr-abc');
  assert.equal(creds.token, 'at-def');
  assert.equal(creds.userId, '778899');
});

test('locateStorageJson：按产品变体目录定位，缺失返回 null', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trae-home-'));
  assert.equal(locateStorageJson({ homeDir: home, platform: 'darwin' }), null);
  const dir = join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'storage.json'), '{}');
  const found = locateStorageJson({ homeDir: home, platform: 'darwin' });
  assert.equal(found, join(dir, 'storage.json'));
});
