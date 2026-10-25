import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishShutdown } from '../server/shutdown.ts';

test('shutdown awaits saving, bounds a stuck worker, then still closes the remaining services', async () => {
  const order: string[] = [], issues: string[] = [];
  let saved = false;
  await finishShutdown([
    { name: 'save', timeoutMs: 1000, run: async () => { await new Promise((resolve) => setTimeout(resolve, 40)); saved = true; order.push('saved'); } },
    { name: 'worker', timeoutMs: 10, run: () => { assert.ok(saved); order.push('worker'); return new Promise(() => {}); } },
    { name: 'services', timeoutMs: 1000, run: () => { order.push('services'); } },
  ], 2000, (name) => issues.push(name));
  assert.deepEqual(order, ['saved', 'worker', 'services']);
  assert.deepEqual(issues, ['worker']);
});

test('shutdown continues after a cleanup failure and respects the overall deadline', async () => {
  const issues: string[] = [], ran: string[] = [];
  await finishShutdown([
    { name: 'failure', timeoutMs: 1000, run: () => { throw new Error('Synthetic cleanup failure'); } },
    { name: 'stuck', timeoutMs: 1000, run: () => new Promise(() => {}) },
    { name: 'too late', timeoutMs: 1000, run: () => { ran.push('late'); } },
  ], 20, (name) => issues.push(name));
  assert.deepEqual(issues, ['failure', 'stuck', 'too late']);
  assert.deepEqual(ran, []);
});
