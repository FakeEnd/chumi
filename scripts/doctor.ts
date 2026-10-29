/**
 * Checks a Chumi install and says how to fix what is missing.
 *
 *   npm run doctor            every check
 *   npm run doctor -- --brief only problems (used at the end of setup)
 *
 * Read-only: it never installs, downloads or signs in to anything.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Store } from '../server/db.ts';
import { findAudioHelper, findClaude, findHotkeyTool, findScreenTool, REPO_ROOT, WEB_DIST, which } from '../server/paths.ts';
import { appleSiliconHardware, isInstalled } from '../server/asr/models.ts';
import { commandLineTools, javascriptPackages } from './doctor-checks.ts';

const BRIEF = process.argv.includes('--brief');
const color = process.stdout.isTTY;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
type Level = 'ok' | 'problem' | 'note';
const results: Array<{ level: Level; text: string; fix?: string }> = [];
const add = (level: Level, text: string, fix?: string) => results.push({ level, text, fix });
/** stdout and stderr together (Codex prints its login status on stderr); null if the command could not run. */
const run = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }); return r.error ? null : `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const versionAtLeast = (v: string, min: number[]) => { const p = v.split('.').map(Number); for (let i = 0; i < min.length; i++) { if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i]; } return true; };

const packagesReady = javascriptPackages(REPO_ROOT);
add(packagesReady ? 'ok' : 'problem', 'JavaScript packages installed and up to date', packagesReady ? undefined : 'bash scripts/setup.sh   (or npm ci)');

// This Mac
const appleSilicon = appleSiliconHardware();
const os = run('/usr/bin/sw_vers', ['-productVersion'])?.trim() ?? '';
if (os && versionAtLeast(os, [14, 4])) add('ok', `macOS ${os}${appleSilicon ? ' on Apple Silicon' : ' (Intel: speech recognition is slower)'}`);
else add('problem', `macOS ${os || 'unknown'}: Chumi needs 14.4 or later`, 'System Settings → General → Software Update');
const node = Number(process.versions.node.split('.')[0]);
add(node >= 24 ? 'ok' : 'problem', `Node.js ${process.version}`, node >= 24 ? undefined : 'brew install node   (Chumi needs Node 24 or later)');
if (appleSilicon && process.arch !== 'arm64') add('problem', 'Node.js is running under Rosetta on Apple Silicon', 'Use arm64 Homebrew: /opt/homebrew/bin/brew install node; put /opt/homebrew/bin first on PATH, then rerun setup');
const tools = commandLineTools();
add(tools.ready ? 'ok' : 'problem', 'Xcode Command Line Tools', tools.fix);

// Speech recognition and the app
const store = new Store();
const settings = store.getSettings();
add(which('whisper-server') ? 'ok' : 'problem', 'whisper.cpp (local speech recognition)', which('whisper-server') ? undefined : 'brew install whisper-cpp');
add(isInstalled(settings.asr.model) ? 'ok' : 'problem', `Speech model ${settings.asr.model}`, isInstalled(settings.asr.model) ? undefined : 'bash scripts/setup.sh   (or Settings → Transcription → Download)');
add(existsSync(join(WEB_DIST, 'index.html')) ? 'ok' : 'problem', 'Interface built', existsSync(join(WEB_DIST, 'index.html')) ? undefined : 'npm run build:web');
const helper = findAudioHelper();
add(helper ? 'ok' : 'problem', 'Audio helper built', helper ? undefined : 'bash native/build.sh');
const app = join(REPO_ROOT, 'build', 'Chumi.app');
add(existsSync(app) ? 'ok' : 'problem', 'Chumi.app built', existsSync(app) ? undefined : 'bash native/build.sh');
// A binary built for the other CPU fails with "Bad CPU type" (hw.optional.arm64 is 1 on Apple Silicon, even under Rosetta).
const cpu = appleSilicon ? 'arm64' : 'x86_64';
const archsOf = (b: string) => [...(run('/usr/bin/file', ['-b', b]) ?? '').matchAll(/executable (\w+)/g)].map((m) => m[1]);
const wrongCpu = [join(app, 'Contents', 'MacOS', 'Chumi'), helper, findHotkeyTool(), findScreenTool()]
  .filter((b): b is string => !!b && existsSync(b))
  .filter((b) => { const archs = archsOf(b); return archs.length > 0 && !archs.some((a) => a.startsWith(cpu)); });
if (wrongCpu.length) add('problem', `Built for another CPU (this Mac is ${cpu}): ${wrongCpu.map((b) => basename(b)).join(', ')}`, `CHUMI_TARGET=${cpu}-apple-macos14.4 bash native/build.sh`);

const whisperServer = which('whisper-server');
if (appleSilicon && whisperServer) {
  const archs = archsOf(whisperServer);
  if (archs.length && !archs.some((a) => a.startsWith('arm64'))) add('problem', 'whisper.cpp is running under Rosetta on Apple Silicon', 'Use arm64 Homebrew: /opt/homebrew/bin/brew install whisper-cpp; put /opt/homebrew/bin first on PATH, then rerun setup');
}

// AI
const provider = settings.ai.provider;
if (provider === 'codex') {
  const status = which('codex') ? run('codex', ['login', 'status']) : null;
  if (!which('codex')) add('problem', 'AI: ChatGPT plan selected, but Codex is not installed', 'brew install codex && codex login');
  else if (!status?.includes('ChatGPT')) add('problem', 'AI: Codex is not signed in with ChatGPT', 'codex login   (choose "Sign in with ChatGPT")');
  else add('ok', 'AI: ChatGPT plan through Codex, signed in');
} else if (provider === 'claude-cli') {
  const claude = findClaude();
  // Found only in the Claude app's folder: Chumi can use it, but `claude` in Terminal does not reach it.
  const cmd = claude && !which('claude') ? `'${claude}'` : 'claude';
  const status = claude ? run(claude, ['auth', 'status']) : null;
  if (!claude) add('problem', 'AI: Claude plan selected, but Claude Code is not installed', 'npm install -g @anthropic-ai/claude-code && claude auth login');
  else if (!/"loggedIn":\s*true/.test(status ?? '')) add('problem', 'AI: Claude Code is not signed in', `${cmd} auth login`);
  else add('ok', 'AI: Claude plan through Claude Code, signed in');
  if (claude && cmd !== 'claude') add('note', `Claude Code found in the Claude app: ${claude}. The claude command in Terminal does not reach it`, `ln -sf ${cmd} ~/.local/bin/claude`);
} else if (provider === 'compatible') {
  const c = settings.ai.compatible, profile = c.profiles[c.preset];
  add(profile.enabled && profile.model ? 'ok' : 'problem', `AI: ${c.preset} model ${profile.model || '(none chosen)'}`, profile.enabled && profile.model ? undefined : 'Open Chumi → Settings → AI provider → Other models, choose a model, and save');
} else add('note', `AI: ${provider}`);

// Profile, permissions and optional features
const p = store.getProfile();
add(p.background.trim() || p.domains.length ? 'ok' : 'note', 'Your background', p.background.trim() || p.domains.length ? undefined : 'Open Chumi and click Describe your background (explanations are pitched to it)');
add('note', 'Microphone: Chumi checks its own permission the first time you listen. Terminal access does not tell us whether Chumi.app has access.');
if (settings.asr.diarization && packagesReady) {
  try {
    const { speakerRuntime } = await import('../server/speakers/runtime.ts');
    const speakers = speakerRuntime();
    add(speakers.ready ? 'ok' : 'problem', 'Speaker labels (optional)', speakers.ready ? undefined : speakers.setupCommand);
  } catch { add('problem', 'Could not check speaker labels: JavaScript packages may be incomplete', 'npm ci'); }
}
store.close();

// Report
const problems = results.filter((r) => r.level === 'problem');
if (!BRIEF) console.log(paint('1', 'Chumi doctor'));
for (const r of results) {
  if (BRIEF && r.level !== 'problem') continue;
  const mark = r.level === 'ok' ? paint('32', '✓') : r.level === 'problem' ? paint('31', '✗') : paint('33', '•');
  console.log(`  ${mark} ${r.text}`);
  if (r.fix) console.log(`      ${paint('2', 'Fix:')} ${r.fix}`);
}
console.log(problems.length ? paint('31', `  ${problems.length} thing${problems.length === 1 ? '' : 's'} to fix before Chumi can listen and answer.`) : paint('32', '  Everything Chumi needs is ready.'));
process.exitCode = problems.length ? 1 : 0;
