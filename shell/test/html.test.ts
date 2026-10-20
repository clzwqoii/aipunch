import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml } from '../src/html.ts';

test('escapeHtml 转义标签与属性边界字符', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')">`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
  );
});

test('escapeHtml 先转义 & 避免二次实体', () => {
  assert.equal(escapeHtml('a & b < c'), 'a &amp; b &lt; c');
});

test('escapeHtml 对非字符串输入输出空串或字符串化', () => {
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});
