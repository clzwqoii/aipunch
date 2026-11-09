import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PROVIDER_METAS, CRED_BRAND_PROVIDER } from '../src/provider-registry.ts';

// 规则：账号管理卡片（PROVIDER_METAS）与凭证导入卡（index.html 的 data-brand）必须覆盖同一批供应商。
// 新增/删除 Provider 时两处同批改；本文件是防漂移门禁，不是可选项。
// i18n.ts 顶层会读 localStorage，不能在 node 里 import，文案校验改为扫源码。
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const i18nSource = readFileSync(new URL('../src/i18n.ts', import.meta.url), 'utf8');

function cardBrands(): string[] {
  return [...html.matchAll(/data-brand="([^"]+)"/g)].map((m) => m[1]);
}

test('凭证导入卡与账号管理的供应商清单完全一致', () => {
  assert.deepEqual([...new Set(cardBrands())].sort(), Object.keys(CRED_BRAND_PROVIDER).sort());
});

test('每张导入卡都有绑定的导入按钮（data-brand 与 btn-import-<brand> 成对）', () => {
  for (const brand of cardBrands()) {
    assert.ok(html.includes(`id="btn-import-${brand}"`), `缺少按钮 btn-import-${brand}`);
  }
});

test('导入卡映射的 provider 都有账号管理元信息', () => {
  for (const [brand, provider] of Object.entries(CRED_BRAND_PROVIDER)) {
    assert.ok(PROVIDER_METAS[provider], `${brand} 映射到 ${provider}，但 PROVIDER_METAS 没有该条目`);
  }
});

test('每个 provider 的提示文案在中英文案里都存在', () => {
  for (const [id, meta] of Object.entries(PROVIDER_METAS)) {
    const count = (i18nSource.match(new RegExp(`\\b${meta.hintKey}:`, 'g')) ?? []).length;
    assert.ok(count >= 2, `${id} 的 ${meta.hintKey} 在中英文案中缺一份（当前命中 ${count} 处）`);
  }
});
