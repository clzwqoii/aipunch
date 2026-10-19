import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captchaPageHtml,
  callbackPath,
  pinnedPorts,
  normalizeCaptchaConfig,
  parseCallbackQuery,
  oauthUrlPath,
  oauthLoginPath,
} from './autoclaw-oauth.ts';

test('captchaPageHtml：必须先设 AliyunCaptchaConfig 再加载 SDK，且带 SceneId/prefix', () => {
  const html = captchaPageHtml({ region: 'ga', prefix: 'abc123', sceneId: 'scene_1', postPath: '/captcha-param' });
  const configIndex = html.indexOf('AliyunCaptchaConfig');
  const scriptIndex = html.indexOf('o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js');
  assert.ok(configIndex > 0 && scriptIndex > configIndex, 'AliyunCaptchaConfig 必须先于 SDK 脚本');
  assert.match(html, /SceneId: "scene_1"/);
  assert.match(html, /region: "ga"/);
  assert.match(html, /prefix: "abc123"/);
  assert.match(html, /\/captcha-param/);
  assert.match(html, /captchaVerifyCallback/);
});

test('callbackPath：zai/google 各自的固定路径', () => {
  assert.equal(callbackPath('zai'), '/auth/callback-zai');
  assert.equal(callbackPath('google'), '/auth/callback-google');
});

test('pinnedPorts：Zai 四个白名单端口齐全，且不把 18432（客户端常占）排在首位', () => {
  const ports = pinnedPorts();
  assert.deepEqual([...ports].sort((a, b) => a - b), [18432, 19654, 19723, 53699]);
  assert.notEqual(ports[0], 18432);
});

test('normalizeCaptchaConfig：兼容 snake/camel，缺省 enabled=false', () => {
  assert.deepEqual(normalizeCaptchaConfig({ enabled: true, region: 'ga', prefix: 'p', scene_id: 's' }), {
    enabled: true,
    region: 'ga',
    prefix: 'p',
    sceneId: 's',
  });
  assert.deepEqual(normalizeCaptchaConfig({ data: { enabled: true, region: 'ga', prefix: 'p', sceneId: 's2' } }), {
    enabled: true,
    region: 'ga',
    prefix: 'p',
    sceneId: 's2',
  });
  assert.equal(normalizeCaptchaConfig({}).enabled, false);
});

test('parseCallbackQuery：从回调 URL 取 code/state，缺 code 返回 null', () => {
  assert.deepEqual(parseCallbackQuery('/auth/callback-zai?code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
  assert.equal(parseCallbackQuery('/auth/callback-zai?state=xyz'), null);
});

test('oauthUrlPath/oauthLoginPath：两家端点路径', () => {
  assert.equal(oauthUrlPath('zai'), '/userapi/overseasv1/zai-oauth-url');
  assert.equal(oauthUrlPath('google'), '/userapi/overseasv1/google-oauth-url');
  assert.equal(oauthLoginPath('zai'), '/userapi/overseasv1/zai-oauth-login');
  assert.equal(oauthLoginPath('google'), '/userapi/overseasv1/google-oauth-login');
});
