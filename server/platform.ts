/**
 * What differs between macOS and Windows: starting command-line tools, notifications, the folder picker,
 * privacy settings, the system language and opening an agent terminal.
 */
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { DESKTOP, desktopRequest } from './desktop.ts';

export const IS_WIN = process.platform === 'win32';

/** npm installs CLIs on Windows as .cmd shims, which Node can start only through cmd.exe, with careful quoting. */
export function spawnCommand(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  return IS_WIN && /\.(cmd|bat)$/i.test(bin) ? crossSpawn(bin, args, opts) : spawn(bin, args, opts);
}

/** Stops a process. On Windows also the processes it started: a .cmd shim runs the real CLI as a grandchild. */
export function stopProcess(p: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (IS_WIN && p.pid && p.exitCode === null) { execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], () => {}); return; }
  try { p.kill(signal); } catch { /* already gone */ }
}

/** execFile for CLIs that may be .cmd shims: exit code and output, stdin closed, the whole process tree stopped on timeout. */
export function runCommand(bin: string, args: string[], o: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (code: number) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err }); };
    let child: ChildProcess;
    try { child = spawnCommand(bin, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { err = (e as Error).message; finish(1); return; }
    const cap = (s: string, d: Buffer) => (s.length < 4 * 1024 * 1024 ? s + d.toString('utf8') : s);
    child.stdout!.on('data', (d: Buffer) => { out = cap(out, d); });
    child.stderr!.on('data', (d: Buffer) => { err = cap(err, d); });
    child.on('error', (e) => { err += e.message; finish(1); });
    child.on('close', (code) => finish(code ?? 1));
    const timer = setTimeout(() => { stopProcess(child, 'SIGKILL'); finish(1); }, o.timeoutMs ?? 30_000);
    // These commands receive all input as arguments. Codex exec also reads piped stdin and waits
    // for EOF even with a prompt argument, so leaving the pipe open hangs it.
    child.stdin!.end();
  });
}

/** A system notification when a meeting starts from the global shortcut. */
export function notify(text: string): void {
  if (DESKTOP) { void desktopRequest('notify', { text }).catch(() => {}); return; }
  if (IS_WIN) return;
  const esc = (x: string) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('/usr/bin/osascript', ['-e', `display notification "${esc(text)}" with title "Chumi"`], () => {});
}

/** The system folder picker. Resolves null when cancelled. */
export function chooseFolder(prompt: string): Promise<string | null> {
  if (DESKTOP) return desktopRequest<string | null>('choose-folder', { prompt });
  if (IS_WIN) {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = ${psString(prompt)}; $d.ShowNewFolderButton = $true; `
      + `$top = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }; if ($d.ShowDialog($top) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath }`;
    return new Promise((r) => execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 600_000, windowsHide: true }, (e, so) => r(e ? null : String(so).trim() || null)));
  }
  return new Promise((r) => execFile('/usr/bin/osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`], { timeout: 600_000 }, (e, so) => {
    const p = e ? '' : String(so).trim();
    r(p ? p.replace(/\/+$/, '') || '/' : null);
  }));
}
const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function openExternalUrl(url: string): Promise<void> {
  if (DESKTOP) return desktopRequest<void>('open-url', { url });
  return new Promise((resolve, reject) => execFile(IS_WIN ? 'explorer.exe' : '/usr/bin/open', [url], { windowsHide: true }, (e) => e ? reject(e) : resolve()));
}

/** Opens the privacy settings for the microphone, computer audio or screen recording. */
export function openPrivacySettings(pane: 'microphone' | 'audio-capture' | 'screen'): void {
  if (IS_WIN) { execFile('explorer.exe', [pane === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy'], () => {}); return; }
  const anchor = pane === 'audio-capture' ? 'Privacy_AudioCapture' : pane === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Microphone';
  execFile('/usr/bin/open', [`x-apple.systempreferences:com.apple.preference.security?${anchor}`]);
}

/** The user's preferred language tag, e.g. "zh-Hans-CN" or "en-US" ('' when unknown). */
export function preferredLanguage(): string {
  if (process.env.CHUMI_SYSTEM_LANGUAGE) return process.env.CHUMI_SYSTEM_LANGUAGE;
  if (IS_WIN) {
    try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-UICulture).Name'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim(); } catch { return Intl.DateTimeFormat().resolvedOptions().locale; }
  }
  // WKWebView's navigator.language reflects the app bundle, not the user's choice.
  try { return execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000 }).match(/"?([A-Za-z]{2,3}[-_A-Za-z]*)"?/)?.[1] ?? ''; } catch { return ''; }
}

/**
 * Opens a terminal window running a script written by openInTerminal's caller: a zsh .command file on macOS
 * (Terminal), a .cmd file on Windows (a new console window that stays open when the agent exits).
 */
export function openInTerminal(script: string): void {
  if (IS_WIN) { spawn('cmd.exe', ['/d', '/s', '/c', `start "Chumi" cmd /k "${script}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref(); return; }
  execFile('/usr/bin/open', [script]);
}
