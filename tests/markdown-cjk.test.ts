import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMd } from '../web/src/util.ts';

test('bold ending in full-width punctuation closes before Chinese text', () => {
  assert.match(renderMd('**简短回答：**之前的 agent 发现了三个问题。'), /<strong>简短回答：<\/strong>之前的 agent/);
  assert.match(renderMd('**简短版：**KV cache 是缓存。'), /<strong>简短版：<\/strong>KV cache/);
  assert.match(renderMd('结论：**暂不写入论文**。'), /<strong>暂不写入论文<\/strong>。/);
});

test('other emphasis keeps CommonMark’s rules', () => {
  assert.match(renderMd('a **bold** word'), /a <strong>bold<\/strong> word/);
  assert.match(renderMd('**bold with *em* inside**'), /<strong>bold with <em>em<\/em> inside<\/strong>/);
  assert.match(renderMd('`**not bold**`'), /<code>\*\*not bold\*\*<\/code>/);
  assert.doesNotMatch(renderMd('2 ** 3 ** 4'), /<strong>/);
  assert.doesNotMatch(renderMd('**<img src=x onerror=alert(1)>**'), /<img/);
});
