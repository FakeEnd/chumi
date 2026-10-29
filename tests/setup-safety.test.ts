import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const script of ['setup.sh', 'install.sh']) {
  const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
  const guard = source.slice(source.indexOf('check_chumi_stopped()'), source.indexOf('\n}', source.indexOf('check_chumi_stopped()')) + 2);
  test(`${script} identifies the blocking process and distinguishes checkouts`, () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chumi-setup-safety-')));
    const root = join(dir, 'My Chumi'), other = join(dir, 'Other Chumi');
    mkdirSync(root); mkdirSync(other);
    try {
      writeFileSync(join(dir, 'ps'), '#!/bin/bash\nprintf "%s\\n" "$PROCESSES"\n', { mode: 0o755 });
      writeFileSync(join(dir, 'lsof'), '#!/bin/bash\n[[ -n $PROCESS_CWD ]] && printf "n%s\\n" "$PROCESS_CWD"\n', { mode: 0o755 });
      const run = (command: string, cwd: string) => spawnSync('bash', ['-c', `${guard}\ncheck_chumi_stopped "$CHECKOUT"`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CHECKOUT: root, PROCESSES: `123 ${command}`, PROCESS_CWD: cwd }, encoding: 'utf8' });
      for (const command of [`${root}/build/Chumi.app/Contents/MacOS/Chumi`, `/opt/homebrew/bin/node ${root}/server/main.ts`, 'node --watch server/main.ts', 'node server/main.ts', 'node --watch ./server/main.ts']) {
        const result = run(command, root);
        assert.equal(result.status, 1, command);
        assert.match(result.stderr, /Finish any active meeting, quit Chumi/);
        assert.ok(result.stderr.includes(`PID 123: ${command}`), result.stderr);
      }
      for (const command of [`${other}/build/Chumi.app/Contents/MacOS/Chumi`, `node ${other}/server/main.ts`, 'node server/main.ts']) assert.equal(run(command, other).status, 0, command);
      assert.equal(run('node scripts/doctor.ts', root).status, 0);
      assert.match(run('node server/main.ts', '').stderr, /Could not determine the working directory of PID 123/);
      if (script === 'setup.sh') {
        assert.match(source, /check_chumi_stopped "\$ROOT"\nstep "Building Chumi"/);
        assert.ok(source.indexOf('[[ "$(uname -s)"') < source.indexOf('check_chumi_stopped "'));
      } else assert.ok(source.indexOf('check_chumi_stopped "') < source.indexOf('git -C "$DIR" pull'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a failed installer pull tells the user to inspect their checkout and does not run setup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-install-pull-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(dir, '.git'), 'stand-in checkout');
    for (const [name, command] of [['uname', 'echo Darwin'], ['xcode-select', 'exit 0'], ['ps', 'exit 0'], ['git', 'echo "Not possible to fast-forward" >&2; exit 1']]) {
      writeFileSync(join(bin, name), `#!/bin/bash\n${command}\n`, { mode: 0o755 });
    }
    const result = spawnSync('bash', ['scripts/install.sh'], { env: { ...process.env, CHUMI_DIR: dir, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Chumi was not updated/, result.stderr);
    assert.ok(result.stdout.includes(`git -C "${dir}" status`));
    assert.doesNotMatch(result.stderr, /setup.sh.*No such file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native builds target the hardware under Rosetta and respect an explicit target', () => {
  const source = readFileSync(new URL('../native/build.sh', import.meta.url), 'utf8');
  const snippet = source.slice(source.indexOf('TARGET_ARCH='), source.indexOf('\nSIGN_IDENTITY='));
  for (const [arm64, override, expected] of [['1', '', 'arm64-apple-macos14.4'], ['0', '', 'x86_64-apple-macos14.4'], ['1', 'x86_64-apple-macos14.4', 'x86_64-apple-macos14.4']]) {
    const run = spawnSync('bash', ['-c', `set -euo pipefail\nuname() { echo x86_64; }\nsysctl() { echo "$ARM64_HARDWARE"; }\n${snippet}\nprintf '%s' "$TARGET"`], { env: { ...process.env, ARM64_HARDWARE: arm64, CHUMI_TARGET: override }, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, expected);
  }
});


test('setup gives the Windows pointer before trying a macOS process check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-setup-platform-'));
  try {
    writeFileSync(join(dir, 'uname'), '#!/bin/bash\necho MINGW64_NT-10.0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'ps'), '#!/bin/bash\necho unexpected-process-check >&2; exit 1\n', { mode: 0o755 });
    const result = spawnSync('bash', ['scripts/setup.sh', '--yes'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /On Windows, use the desktop app or scripts\/setup.ps1/);
    assert.doesNotMatch(result.stdout + result.stderr, /unexpected-process-check|Could not check whether Chumi/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
