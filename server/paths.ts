import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.CHUMI_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Chumi');
export const MODELS_DIR = process.env.CHUMI_MODELS_DIR || join(homedir(), 'Library', 'Application Support', 'Chumi', 'models');
export const AUDIO_DIR = join(DATA_DIR, 'audio');
export const FRAMES_DIR = join(DATA_DIR, 'frames');
export const DB_PATH = join(DATA_DIR, 'chumi.db');
export const CODEX_WORKDIR = join(DATA_DIR, 'ai-workdir');
export const WEB_DIST = join(REPO_ROOT, 'web', 'dist');
export const LOG_DIR = join(homedir(), 'Library', 'Logs', 'Chumi');

export function ensureDirs(): void {
  for (const d of [DATA_DIR, MODELS_DIR, AUDIO_DIR, FRAMES_DIR, CODEX_WORKDIR, LOG_DIR]) mkdirSync(d, { recursive: true });
}

/** Locate the native audio helper: explicit env (set by Chumi.app), then the dev build. */
export function findAudioHelper(): string | null {
  const candidates = [
    process.env.CHUMI_AUDIO_HELPER,
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

/** Find an executable on PATH plus common Homebrew locations (apps launched from Finder have a minimal PATH). */
export function which(cmd: string): string | null {
  const dirs = [
    ...(process.env.PATH || '').split(':'),
    '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin',
  ];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}
