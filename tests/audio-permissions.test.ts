import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audioHelperArgs } from '../server/audio/capture.ts';

test('permission checks, microphone requests and capture share the terminal helper identity', () => {
  for (const mode of [['--source', 'mic'], ['--check-permissions'], ['--request-mic']]) {
    assert.deepEqual(audioHelperArgs(mode, 'darwin', false), [...mode, '--self-responsible']);
    assert.deepEqual(audioHelperArgs(mode, 'darwin', true), mode);
    assert.deepEqual(audioHelperArgs(mode, 'win32', false), mode);
  }
  const capture = readFileSync(new URL('../server/audio/capture.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
  assert.match(capture, /execFile\(helper, audioHelperArgs\(\['--check-permissions'\]\), \{ timeout: 5000/);
  assert.match(main, /execFile\(helper, audioHelperArgs\(\['--request-mic'\]\), \{ timeout: 60000/);
});
