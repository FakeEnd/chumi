/**
 * DeepSeek Harness (dsh): where its command is, how Chumi's MCP server is added to its configuration, the settings a read
 * check runs with, and opening its desktop app. The agent integration itself is in agents.ts.
 *
 * dsh composes its configuration from YAML patch layers. $DSH_HOME/cordis.patch.yml applies to every profile, the desktop
 * app's included, so Chumi's server goes there, as a block between two marker comments that Chumi alone writes and removes.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR, which } from '../paths.ts';
import { IS_WIN } from '../platform.ts';

/** dsh's home: settings, credentials, sessions and the patch layers. */
export const dshHome = (): string => process.env.DSH_HOME || join(homedir(), '.dsh');
/** The patch layer every dsh profile applies after its own. */
export const dshPatchFile = (): string => join(dshHome(), 'cordis.patch.yml');

const BEGIN = '# >>> chumi';
const END = '# <<< chumi';
/** A chumi server someone added to the patch layer by hand, outside Chumi's block. */
const HAND_WRITTEN = /^\s*serverName:\s*["']?chumi["']?\s*(#.*)?$/m;

export interface DshServer { command: string; args: string[]; env: Record<string, string> }

/**
 * Chumi's entry: one insert patch adding dsh's generic MCP client. Values are written as JSON strings, which YAML reads
 * as double-quoted scalars, so Windows paths and quotes need no YAML escaping and the block can be read back exactly.
 */
export function dshBlock(m: DshServer, eol = '\n'): string {
  const j = JSON.stringify;
  return [
    `${BEGIN} (added by Chumi; Disconnect in Chumi removes this block)`,
    '- insert:',
    '    - id: chumi-mcp',
    `      name: ${j('@deepseek-ai/dsh-mcp-client')}`,
    '      config:',
    '        serverName: chumi',
    '        transport: stdio',
    `        command: ${j(m.command)}`,
    `        args: ${j(m.args)}`,
    ...(Object.keys(m.env).length ? [`        env: ${j(m.env)}`] : []),
    END,
  ].join(eol);
}

/** The file split into Chumi's block and everything else. A begin marker without its end means someone edited the block. */
export function splitDshPatch(text: string): { rest: string; block: string | null; broken: boolean } {
  const lines = text.split('\n');
  const begin = lines.findIndex((l) => l.trimEnd().startsWith(BEGIN));
  if (begin < 0) return { rest: text, block: null, broken: false };
  const end = lines.findIndex((l, i) => i > begin && l.trimEnd() === END);
  if (end < 0) return { rest: text, block: null, broken: true };
  return { rest: [...lines.slice(0, begin), ...lines.slice(end + 1)].join('\n'), block: lines.slice(begin, end + 1).join('\n'), broken: false };
}

/** What Chumi's block says, as the status needs it. */
export function readDshBlock(block: string): Partial<DshServer> {
  const field = (key: string) => {
    const m = block.match(new RegExp(`^\\s*${key}: (.*?)\\r?$`, 'm'));
    try { return m ? JSON.parse(m[1]) : undefined; } catch { return undefined; }
  };
  return { command: field('command'), args: field('args'), env: field('env') };
}

export const handWrittenDsh = (rest: string): boolean => HAND_WRITTEN.test(rest);

/**
 * The patch layer with Chumi's block in it (replacing an earlier one), leaving every other line as it was.
 * The layer is a top-level YAML list: Chumi appends to a block-style list, fills an empty one (`[]`, or only comments),
 * and refuses anything else rather than rewrite YAML it does not understand.
 */
export function withDshBlock(text: string, m: DshServer, file: string): string {
  const { rest, broken } = splitDshPatch(text);
  if (broken) throw new Error(`Chumi did not change ${file}: its "${BEGIN}" block has no "${END}" line. Remove what is left of it, then connect again.`);
  if (handWrittenDsh(rest)) throw new Error(`Chumi did not change ${file}: it already has a server named chumi that Chumi did not add. Remove that entry, or keep using it.`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = dshBlock(m, eol);
  const lines = rest.split('\n');
  const significant = lines.map((l, i) => [l.replace(/\r$/, ''), i] as const).filter(([l]) => l.trim() && !l.trimStart().startsWith('#'));
  if (significant.length === 1 && /^\[\]\s*(#.*)?$/.test(significant[0][0].trim())) {
    lines[significant[0][1]] = block;
    return `${lines.join('\n').trimEnd()}${eol}`;
  }
  if (significant.length && !/^-(\s|$)/.test(significant[0][0])) {
    throw new Error(`Chumi did not change ${file}: it is not a YAML list written one item per line. Add the entry shown below yourself.`);
  }
  const head = rest.trimEnd();
  return `${head ? `${head}${eol}` : ''}${block}${eol}`;
}

/** The patch layer without Chumi's block; null when there was none. With only comments left it is an empty list again. */
export function withoutDshBlock(text: string): string | null {
  const { rest, block } = splitDshPatch(text);
  if (!block) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const head = rest.trimEnd();
  const listed = rest.split('\n').some((l) => l.trim() && !l.trimStart().startsWith('#'));
  return listed ? `${head}${eol}` : `${head ? `${head}${eol}` : ''}[]${eol}`;
}

/**
 * Turned on for the read check only: headless runs leave these plugins off, so without them dsh would see neither the
 * DeepSeek account the desktop app signed in with nor an API key saved in its settings, only DEEPSEEK_API_KEY.
 */
const CHECK_PATCH = `# Written by Chumi for its read check (dsh --profile headless). Chumi rewrites this file before every check.
- id: authorization
  disabled: false
- id: credentials
  disabled: false
- id: deepseek-account
  disabled: false
`;

/**
 * --patch arguments for the read check, so it uses the model and sign-in the user chose in the desktop app: that
 * profile's own layer (entries that only the desktop has are skipped with a warning), then CHECK_PATCH.
 */
export function dshCheckPatches(): string[] {
  const desktop = join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, 'dsh-read-check.cordis.yml');
  writeFileSync(file, CHECK_PATCH);
  return [...(existsSync(desktop) ? ['--patch', desktop] : []), '--patch', file];
}

let windowsInstall: string | null | undefined;
/** Where the Windows desktop app is installed, from its uninstall entry (any folder the user picked), or null. */
function windowsInstallDir(): string | null {
  if (windowsInstall !== undefined) return windowsInstall;
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' -and $_.InstallLocation } | Select-Object -First 1 -ExpandProperty InstallLocation";
  try { windowsInstall = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim() || null; } catch { windowsInstall = null; }
  if (!windowsInstall) {
    const usual = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness');
    windowsInstall = existsSync(usual) ? usual : null;
  }
  return windowsInstall;
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** The dsh command: on PATH (the app's "Manage dsh Command…" puts it there), else the copy inside the desktop app. */
export function findDsh(): string | null {
  const onPath = which('dsh');
  if (onPath) return onPath;
  const inApp = IS_WIN
    ? [windowsInstallDir()].filter((d): d is string => !!d).map((d) => join(d, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    : ['/Applications', join(homedir(), 'Applications')].map((d) => join(d, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'));
  return inApp.find(isFile) ?? null;
}

/**
 * Brings up the desktop app (starting it if needed) through the dsh://open link it registers. The link only shows the
 * window: it cannot choose a folder or fill in a message. explorer.exe exits with 1 even when it opened a link, so on
 * Windows only a failure to start it counts.
 */
export function openDeepSeekHarness(): Promise<void> {
  return new Promise((resolve, reject) => execFile(IS_WIN ? 'explorer.exe' : '/usr/bin/open', ['dsh://open'], { windowsHide: true }, (e) => {
    if (e && !(IS_WIN && typeof e.code === 'number')) reject(e); else resolve();
  }));
}
