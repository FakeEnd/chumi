import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../server/platform.ts';

test('command output preserves UTF-8 across stdout and stderr chunks', async () => {
  const result = await runCommand(process.execPath, ['-e', `
    const bytes = Buffer.from('你好🌱'.repeat(10000));
    process.stdout.write(bytes.subarray(0, 1)); process.stderr.write(bytes.subarray(0, 2));
    setTimeout(() => { process.stdout.write(bytes.subarray(1)); process.stderr.write(bytes.subarray(2)); }, 30);
  `]);
  assert.equal(result.code, 0);
  assert.equal(result.out, '你好🌱'.repeat(10000));
  assert.equal(result.err, result.out);
});
