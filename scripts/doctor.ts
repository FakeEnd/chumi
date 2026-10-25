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
import { join } from 'node:path';
import { Store } from '../server/db.ts';
import { findAudioHelper, findClaude, REPO_ROOT, WEB_DIST, which } from '../server/paths.ts';
import { isInstalled } from '../server/asr/models.ts';
import { speakerRuntime } from '../server/speakers/runtime.ts';

const BRIEF = process.argv.includes('--brief');
const color = process.stdout.isTTY;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
type Level = 'ok' | 'problem' | 'note';
const results: Array<{ level: Level; text: string; fix?: string }> = [];
const add = (level: Level, text: string, fix?: string) => results.push({ level, text, fix });
/** stdout and stderr together (Codex prints its login status on stderr); null if the command could not run. */
const run = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }); return r.error ? null : `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const versionAtLeast = (v: string, min: number[]) => { const p = v.split('.').map(Number); for (let i = 0; i < min.length; i++) { if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i]; } return true; };

// This Mac
const os = run('/usr/bin/sw_vers', ['-productVersion'])?.trim() ?? '';
if (os && versionAtLeast(os, [14, 4])) add('ok', `macOS ${os}${process.arch === 'arm64' ? ' on Apple Silicon' : ' (Intel: speech recognition is slower)'}`);
else add('problem', `macOS ${os || 'unknown'}: Chumi needs 14.4 or later`, 'System Settings → General → Software Update');
const node = Number(process.versions.node.split('.')[0]);
add(node >= 24 ? 'ok' : 'problem', `Node.js ${process.version}`, node >= 24 ? undefined : 'brew install node   (Chumi needs Node 24 or later)');
add(which('swiftc') ? 'ok' : 'problem', 'Xcode Command Line Tools', which('swiftc') ? undefined : 'xcode-select --install');

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
if (helper) {
  const perms = run(helper, ['--check-permissions']);
  const mic = perms ? (JSON.parse(perms) as { microphone?: string }).microphone : 'unknown';
  if (mic === 'granted') add('ok', 'Microphone allowed');
  else if (mic === 'denied' || mic === 'restricted') add('problem', 'Microphone access is off for Chumi', 'System Settings → Privacy & Security → Microphone');
  else add('note', 'Microphone: macOS asks the first time you listen');
}
const speakers = speakerRuntime();
if (settings.asr.diarization) add(speakers.ready ? 'ok' : 'problem', 'Speaker labels (optional)', speakers.ready ? undefined : speakers.setupCommand);
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
