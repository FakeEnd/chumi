import { homedir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** macOS: ~/Library/Application Support/Chumi. Windows: %LOCALAPPDATA%\Chumi (models are large, so not the roaming profile). */
const APP_DIR = WIN ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Chumi') : join(homedir(), 'Library', 'Application Support', 'Chumi');
export const DATA_DIR = process.env.CHUMI_DATA_DIR || APP_DIR;
export const MODELS_DIR = process.env.CHUMI_MODELS_DIR || join(APP_DIR, 'models');
export const AUDIO_DIR = join(DATA_DIR, 'audio');
export const FRAMES_DIR = join(DATA_DIR, 'frames');
export const DB_PATH = join(DATA_DIR, 'chumi.db');
export const CODEX_WORKDIR = join(DATA_DIR, 'ai-workdir');
export const WEB_DIST = join(REPO_ROOT, 'web', 'dist');
export const LOG_DIR = WIN ? join(APP_DIR, 'logs') : join(homedir(), 'Library', 'Logs', 'Chumi');

export function ensureDirs(): void {
  for (const d of [DATA_DIR, MODELS_DIR, AUDIO_DIR, FRAMES_DIR, CODEX_WORKDIR, LOG_DIR]) mkdirSync(d, { recursive: true });
}

/** The folder Claude Code and Codex run in, created if missing: a spawn whose cwd doesn't exist fails with ENOENT, as if the CLI weren't installed. */
export function aiWorkdir(): string {
  mkdirSync(CODEX_WORKDIR, { recursive: true });
  return CODEX_WORKDIR;
}

/** Locate the native audio helper: explicit env (set by Chumi.app), then the dev build. */
export function findAudioHelper(): string | null {
  const candidates = [
    process.env.CHUMI_AUDIO_HELPER,
    ...(WIN ? [join(REPO_ROOT, 'build', 'chumi-audio.exe')] : []),
    join(REPO_ROOT, 'build', 'Chumi.app', 'Contents', 'MacOS', 'chumi-audio'),
    join(REPO_ROOT, 'build', 'chumi-audio'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Window-capture tool (ScreenCaptureKit), built by native/build.sh. */
export function findScreenTool(): string | null {
  const candidates = [process.env.CHUMI_SCREEN_TOOL, join(REPO_ROOT, 'build', 'chumi-screen')].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Global quick-start shortcut listener, built by native/build.sh. */
export function findHotkeyTool(): string | null {
  const candidates = [process.env.CHUMI_HOTKEY_TOOL, join(REPO_ROOT, 'build', 'chumi-hotkey')].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Find an executable on PATH plus common install locations (apps launched from Finder have a minimal PATH).
 * On Windows only names with a PATHEXT extension count: npm also writes an extensionless shell script next to
 * each .cmd shim, which Windows cannot run. build/whisper holds whisper.cpp from scripts/setup.ps1.
 */
export function which(cmd: string): string | null {
  const dirs = [
    ...(process.env.PATH || '').split(delimiter),
    ...(WIN
      ? [join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm'), join(homedir(), '.local', 'bin'), join(REPO_ROOT, 'build', 'whisper')]
      : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin']),
  ];
  const names = WIN ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => cmd + ext.toLowerCase()) : [cmd];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      const p = join(d, n);
      try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** The Claude desktop app keeps the Claude Code builds it installs here, as <version>/<hash>/claude.app/Contents/MacOS/claude. */
export const DESKTOP_CLAUDE_CODE_DIR = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');

/** Numeric order of dotted versions, so 2.1.304 comes after 2.1.95. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

/**
 * The newest runnable Claude Code the Claude desktop app installed. ~/.local/bin/claude usually links into one of these
 * folders, and the link dangles once the app updates Claude Code and deletes the version it pointed to.
 */
export function desktopClaudeCode(root = DESKTOP_CLAUDE_CODE_DIR): string | null {
  const list = (d: string) => { try { return readdirSync(d).sort(); } catch { return []; } };
  const versions = list(root).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => compareVersions(b, a));
  for (const v of versions) {
    for (const h of list(join(root, v))) {
      const bin = join(root, v, h, 'claude.app', 'Contents', 'MacOS', 'claude');
      try { if (statSync(bin).isFile()) { accessSync(bin, constants.X_OK); return bin; } } catch { /* broken link, missing or not executable */ }
    }
  }
  return null;
}

/** The Claude Code CLI: PATH and the usual install folders first, so the user's own install wins, then the Claude app's copy. */
export function findClaude(): string | null {
  return which('claude') ?? (WIN ? null : desktopClaudeCode());
}
