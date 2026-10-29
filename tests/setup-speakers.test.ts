import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('speaker setup skips Python 3.13+, tries the system Python, and explains incompatible overrides', () => {
  const source = readFileSync(new URL('../scripts/setup-speakers.sh', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('supported_python()'), source.indexOf('SPEAKER_PYTHON=$(choose'));
  const dir = mkdtempSync(join(tmpdir(), 'chumi-speaker-python-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const python = (name: string, compatible: boolean) => writeFileSync(join(bin, name), `#!/bin/bash\nif [[ $1 == --version ]]; then echo 'Python ${compatible ? '3.12.9' : '3.13.1'}'; else exit ${compatible ? 0 : 1}; fi\n`, { mode: 0o755 });
    for (const name of ['python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3', 'system-python']) python(name, false);
    const run = (override = '') => spawnSync('/bin/bash', ['-c', `${functions.replace('/usr/bin/python3', `${bin}/system-python`)}\nchoose_speaker_python`], { env: { PATH: bin, CHUMI_SPEAKER_SETUP_PYTHON: override }, encoding: 'utf8' });
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Python 3.13.1/);
    assert.match(result.stderr, /brew install python@3.12/);
    assert.doesNotMatch(result.stderr, /Traceback|AssertionError/);
    python('system-python', true);
    assert.equal(run().stdout.trim(), join(bin, 'system-python'));
    python('python3.11', true);
    assert.equal(run().stdout.trim(), join(bin, 'python3.11'));
    assert.equal(run(join(bin, 'system-python')).stdout.trim(), join(bin, 'system-python'));
    result = run(join(bin, 'python3'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHUMI_SPEAKER_SETUP_PYTHON needs Python/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
