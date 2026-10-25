import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSplit, DEFAULT_SPLIT, MIN_LEFT, MIN_RIGHT } from '../web/src/columnSplit.ts';

test('the column split keeps both columns at their minimum width', () => {
  const total = 1000;
  assert.equal(clampSplit(0.5, total), 0.5);
  assert.equal(clampSplit(0.1, total), MIN_LEFT / total);
  assert.equal(clampSplit(0.9, total), 1 - MIN_RIGHT / total);
  assert.equal(clampSplit(Number.NaN, total), DEFAULT_SPLIT);
});
