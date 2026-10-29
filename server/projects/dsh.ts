/**
 * DeepSeek Harness (dsh): where its command is, how Chumi's MCP server is added to its configuration, the settings a read
 * check runs with, and opening its desktop app. The agent integration itself is in agents.ts.
 *
 * dsh composes its configuration from YAML patch layers. $DSH_HOME/cordis.patch.yml applies to every profile, the desktop
 * app's included, so Chumi's server goes there, as a block between two marker comments that Chumi alone writes and removes.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
/** A chumi server someone added to the patch layer by hand, outside Chumi's block, one entry per line or in {…} form. */
const HAND_WRITTEN = /(^|[\s{,])serverName:\s*["']?chumi["']?(?=\s*([,}#]|$))/m;
/** dsh's YAML reader skips a byte-order mark at the start of the file, so Chumi's line checks do too, and keep it. */
const BOM = '\uFEFF';
/** Lines that hold no list item: blank lines, comments and a `---` document start. */
const filler = (line: string) => { const t = line.trim(); return !t || t.startsWith('#') || t === '---'; };

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
  const bom = text.startsWith(BOM) ? BOM : '';
  const lines = text.slice(bom.length).split('\n');
  const begin = lines.findIndex((l) => l.trimEnd().startsWith(BEGIN));
  if (begin < 0) return { rest: text, block: null, broken: false };
  const end = lines.findIndex((l, i) => i > begin && l.trimEnd() === END);
  if (end < 0) return { rest: text, block: null, broken: true };
  return { rest: bom + [...lines.slice(0, begin), ...lines.slice(end + 1)].join('\n'), block: lines.slice(begin, end + 1).join('\n'), broken: false };
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
  const bom = rest.startsWith(BOM) ? BOM : '';
  const lines = rest.slice(bom.length).split('\n');
  const items = lines.map((l, i) => [l.replace(/\r$/, ''), i] as const).filter(([l]) => !filler(l));
  const empty = items.length === 1 ? items[0][0].trim().match(/^\[\]\s*(#.*)?$/) : null;
  if (empty) {
    // The `[]` line becomes the block (a comment on it stays, on its own line).
    const i = items[0][1];
    lines[i] = `${empty[1] ? `${empty[1]}${eol}` : ''}${block}${lines[i].endsWith('\r') ? '\r' : ''}`;
    return bom + lines.join('\n');
  }
  if (items.length && !/^-(\s|$)/.test(items[0][0])) {
    throw new Error(`Chumi did not change ${file}: it is not a YAML list written one item per line. Add the entry shown below yourself.`);
  }
  return `${rest}${rest.length > bom.length && !rest.endsWith('\n') ? eol : ''}${block}${eol}`;
}

/** The patch layer without Chumi's block; null when there was none. With no list item left it is an empty list again. */
export function withoutDshBlock(text: string): string | null {
  const { rest, block } = splitDshPatch(text);
  if (!block) return null;
  if (rest.split('\n').some((l) => !filler(l.replace(BOM, '')))) return rest;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return `${rest}${rest.replace(BOM, '') && !rest.endsWith('\n') ? eol : ''}[]${eol}`;
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

/** Keep UTF-8 output for non-ASCII install folders without blocking recording or HTTP. */
function queryUninstall(hive: string): Promise<string> {
  const query = `chcp 65001 >nul & reg.exe query "${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s`;
  return new Promise((resolve, reject) => execFile('cmd.exe', ['/d', '/s', '/c', `"${query}"`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: true }, (error, out) => error ? reject(error) : resolve(out)));
}

/**
 * An asynchronous system lookup. A folder found is remembered while it is there; "not found" only for a minute, so
 * installing the app later is noticed. refresh asks again; concurrent callers share one lookup.
 */
function remembered(find: () => Promise<string | null>): (refresh?: boolean) => Promise<string | null> {
  let last: { dir: string | null; at: number } | undefined, pending: Promise<string | null> | undefined;
  return (refresh = false) => {
    if (!refresh && last && (last.dir ? existsSync(last.dir) : Date.now() - last.at < 60_000)) return Promise.resolve(last.dir);
    return pending ??= find().then((dir) => { last = { dir, at: Date.now() }; return dir; }).finally(() => { pending = undefined; });
  };
}

/** Cache misses too; only an explicit Settings refresh should scan again. Concurrent callers share a scan. */
export function createWindowsDshLocator(dependencies: { query?: (hive: string) => Promise<string>; exists?: (path: string) => boolean; usual?: () => string } = {}) {
  const query = dependencies.query ?? queryUninstall, exists = dependencies.exists ?? existsSync;
  const usual = dependencies.usual ?? (() => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness'));
  let cached: Promise<string | null> | undefined, pending = false;
  return (refresh = false): Promise<string | null> => {
    if (cached && (!refresh || pending)) return cached;
    pending = true;
    cached = (async () => {
      const standard = usual();
      if (exists(standard)) return standard;
      const hives = await Promise.all(['HKCU', 'HKLM'].map((hive) => query(hive).catch(() => '')));
      for (const entries of hives) {
        for (const entry of entries.split(/\r?\n(?=HKEY_)/)) {
          if (!/^\s*DisplayName\s+REG_SZ\s+DeepSeek Harness(?:\s|$)/im.test(entry)) continue;
          const dir = entry.match(/^\s*InstallLocation\s+REG_SZ\s+(.+)$/m)?.[1].trim();
          if (dir && exists(dir)) return dir;
        }
      }
      return null;
    })().finally(() => { pending = false; });
    return cached;
  };
}
const windowsInstallDir = createWindowsDshLocator();

const macApps = () => ['/Applications', join(homedir(), 'Applications')].map((d) => join(d, 'DeepSeek Harness.app'));

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** The dsh command inside a desktop install: an .app bundle on a Mac, the folder it was installed to on Windows. */
export const dshCliIn = (dir: string): string => IS_WIN
  ? join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
  : join(dir, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh');

/**
 * Copies of the Mac app that Spotlight found by its bundle id. Skipped: copies on another volume (such as the mounted
 * installer disk image), in the Trash or inside another app, and anything without its dsh command.
 */
export function usableSpotlightApps(paths: string[]): string[] {
  return paths.filter((p) => p.endsWith('.app') && !p.startsWith('/Volumes/') && !p.includes('/.Trash/') && !/\.app\//.test(p) && isFile(dshCliIn(p)));
}

/** The Mac app wherever it was put, from Spotlight's index (about 50 ms, without blocking the server), or null when Spotlight is off or finds none. */
const spotlightApp = remembered(() => new Promise((resolve) => execFile('/usr/bin/mdfind', ["kMDItemCFBundleIdentifier == 'com.deepseek.dsh'"], { encoding: 'utf8', timeout: 5_000 },
  (error, found) => resolve(error ? null : usableSpotlightApps(String(found).split('\n').filter(Boolean))[0] ?? null))));

/** The desktop app the user chose in Settings → Coding agents, because Chumi could not find it. */
const chosenFile = () => join(DATA_DIR, 'deepseek-harness-app.json');
export function chosenDshApp(): string | null {
  try {
    const path = (JSON.parse(readFileSync(chosenFile(), 'utf8')) as { path?: unknown }).path;
    return typeof path === 'string' ? path : null;
  } catch { return null; }
}
/** Remembers the desktop app the user chose. Throws, remembering nothing, when its dsh command is not inside. */
export function rememberDshApp(dir: string): void {
  if (!isFile(dshCliIn(dir))) {
    throw new Error(IS_WIN ? 'That folder has no DeepSeek Harness in it. Choose the folder DeepSeek Harness was installed to.' : 'That is not the DeepSeek Harness app. Choose DeepSeek Harness.app.');
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(chosenFile(), `${JSON.stringify({ path: dir })}\n`);
}

/**
 * Where the desktop app is: the copy the user chose while it is still there, else the usual place, else wherever the
 * system says it was installed (Windows' list of installed programs, Spotlight on a Mac).
 */
export async function dshAppDir(refresh = false): Promise<string | null> {
  const chosen = chosenDshApp();
  if (chosen && isFile(dshCliIn(chosen))) return chosen;
  if (IS_WIN) return windowsInstallDir(refresh);
  return macApps().find((app) => isFile(dshCliIn(app))) ?? spotlightApp(refresh);
}

/** The dsh command: on PATH (the app's "Manage dsh Command…" puts it there), else the copy inside the desktop app. */
export async function findDsh(refresh = false): Promise<string | null> {
  const onPath = which('dsh');
  if (onPath) return onPath;
  const dir = await dshAppDir(refresh);
  return dir && isFile(dshCliIn(dir)) ? dshCliIn(dir) : null;
}

/** The desktop app is installed (the dsh command alone can come from npm, without it). */
export async function dshAppInstalled(refresh = false): Promise<boolean> {
  return (await dshAppDir(refresh)) !== null;
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
