/**
 * Coding agents (Claude Code, Codex, opencode, Qwen Code): register Chumi's MCP server with each client, report
 * what is verified, run an explicit read check, and open a project session that starts from a confirmed handoff.
 * Nothing here runs an agent on its own: registration, the read check and continuation are user actions.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Store } from '../db.ts';
import { DATA_DIR, REPO_ROOT, which } from '../paths.ts';
import { uid } from '../util.ts';
import { IS_WIN, openInTerminal, runCommand as run } from '../platform.ts';
import { AGENT_BILLING, AGENT_NAMES, AGENTS, type AgentId } from '../../shared/agents.ts';

export { AGENTS, type AgentId };
const NAME = 'chumi';
// Same safety rule as the AI providers: never let an API key in the environment turn a plan into paid usage.
// Agents billed through the user's own model account (opencode, Qwen Code) keep their keys: that is how they work.
const PLAN_STRIP_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'OPENAI_API_KEY'];

export const MCP_SCRIPT = join(REPO_ROOT, 'server', 'mcp', 'main.ts');
/** Prefer a stable link (e.g. /opt/homebrew/bin/node) over a versioned Cellar path that breaks on upgrade. */
function stableNode(): string {
  const link = which('node');
  try { if (link && realpathSync(link) === realpathSync(process.execPath)) return link; } catch { /* fall through */ }
  return process.execPath;
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ansi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function childEnv(strip: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const k of strip) delete env[k];
  return env;
}

/** JSON with comments and trailing commas, as opencode.jsonc and Qwen Code's settings allow (read-only use). */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0, str = false; i < text.length; i++) {
    const c = text[i];
    if (str) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') str = false; }
    else if (c === '"') { str = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; }
    else if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; }
    else if (c === ',' && /^\s*[}\]]/.test(rest(text, i + 1))) { /* trailing comma, outside any string */ }
    else out += c;
  }
  return JSON.parse(out);
}
/** The text after a position with comments removed, enough to see the next significant character. */
function rest(text: string, from: number): string {
  let s = text.slice(from, from + 4096);
  for (;;) {
    const t = s.trimStart();
    if (t.startsWith('//')) { const nl = t.indexOf('\n'); s = nl < 0 ? '' : t.slice(nl + 1); }
    else if (t.startsWith('/*')) { const end = t.indexOf('*/'); s = end < 0 ? '' : t.slice(end + 2); }
    else return t;
  }
}

/**
 * Edit a JSON config file in place only when it is plain JSON (comments would be lost by rewriting it).
 * Writes atomically next to the real file, keeps its mode, and leaves the previous version as <file>.bak.
 */
function editJsonFile(file: string, edit: (cfg: Record<string, any>) => boolean, fresh: Record<string, any> | null): void {
  let cfg: Record<string, any>;
  const target = existsSync(file) ? realpathSync(file) : file;
  if (existsSync(target)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(target, 'utf8')); } catch { parsed = undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Chumi did not change ${file}: it has comments or is not a plain JSON object, and rewriting it would lose them. Edit the "${NAME}" entry yourself (shown below).`);
    }
    cfg = parsed as Record<string, any>;
  } else if (fresh) cfg = fresh;
  else return;
  if (!edit(cfg)) return;
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const tmp = `${target}.chumi-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode });
    chmodSync(tmp, mode);
    if (existsSync(target)) { copyFileSync(target, `${target}.bak`); chmodSync(`${target}.bak`, mode); }
    renameSync(tmp, target);
  } finally { rmSync(tmp, { force: true }); }
}
function readJsonc(file: string): Record<string, any> | null {
  if (!existsSync(file)) return null;
  try { return parseJsonc(readFileSync(file, 'utf8')) as Record<string, any>; } catch { return null; }
}

export interface AgentStatus {
  agent: AgentId;
  name: string;
  billing: 'plan' | 'unknown';
  cli: string | null;
  /** Chumi's MCP server is registered in this client's configuration. null = could not tell. */
  registered: boolean | null;
  /** Registered with a different Chumi location or data folder (re-connect to fix). */
  outdated: boolean;
  /** Health reported by the client itself (Claude Code, opencode and Qwen Code start the server to list it); unknown for Codex. */
  clientHealth: 'connected' | 'failed' | 'unknown';
  /** A real agent read through this client, recorded by the MCP server. */
  lastRead: { at: number; tool: string } | null;
  verifiedAt: number | null;
  detail: string | null;
}

interface McpServer { command: string; args: string[]; env: Record<string, string> }
type Registration = Pick<AgentStatus, 'registered'> & Partial<Pick<AgentStatus, 'outdated' | 'clientHealth' | 'detail'>>;

/** Registered for another copy of Chumi or another data folder. */
const outdated = (args: string[] | undefined, env: Record<string, string> | null | undefined) =>
  !(args ?? []).includes(MCP_SCRIPT) || (process.env.CHUMI_DATA_DIR ? env?.CHUMI_DATA_DIR !== DATA_DIR : !!env?.CHUMI_DATA_DIR);

/** What Chumi needs to know about one agent. */
interface Adapter {
  bin: string;
  /** Part of the MCP clientInfo name it sends (Claude Code "claude-code", Codex "codex-mcp-client", opencode "opencode", Qwen Code "qwen-cli-mcp-client-chumi"). */
  client: string;
  /** Removed from the environment of commands Chumi runs. */
  strip: string[];
  /** Copyable manual setup: a command, or the configuration entry to add. */
  setup(m: McpServer): string;
  registration(cli: string): Promise<Registration>;
  connect(cli: string, m: McpServer): Promise<void>;
  disconnect(cli: string): Promise<void>;
  /** The read check: one non-interactive run, in an empty folder, asked to call only Chumi's check tool. */
  check(prompt: string, extraArgs: string[]): { args: string[]; env?: Record<string, string> };
  /** The command line that starts an interactive session in the project folder, with the handoff where MESSAGE is. */
  start(cli: string, workspace: string): Array<string | typeof MESSAGE>;
}

/** Stands for the first message in Adapter.start. */
const MESSAGE = Symbol('first message');
const opencodeFile = (ext: 'json' | 'jsonc') => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', `opencode.${ext}`);
const qwenSettings = () => join(homedir(), '.qwen', 'settings.json');

const ADAPTERS: Record<AgentId, Adapter> = {
  'claude-code': {
    bin: 'claude', client: 'claude', strip: PLAN_STRIP_ENV,
    setup: (m) => `claude mcp add --scope user ${Object.entries(m.env).map(([k, v]) => `-e ${k}=${q(v)} `).join('')}${NAME} -- ${q(m.command)} ${q(m.args[0])}`,
    async registration(cli) {
      const r = await run(cli, ['mcp', 'get', NAME], { timeoutMs: 45_000, env: childEnv(PLAN_STRIP_ENV) });
      if (r.code !== 0) return { registered: false };
      const health = /Status:\s*✔/.test(r.out) ? 'connected' : /Status:\s*(✘|✗|failed)/i.test(r.out) ? 'failed' : 'unknown';
      const old = !r.out.includes(MCP_SCRIPT) || (process.env.CHUMI_DATA_DIR ? !r.out.includes(DATA_DIR) : /CHUMI_DATA_DIR=/.test(r.out));
      return { registered: true, clientHealth: health, outdated: old };
    },
    async connect(cli, m) {
      await run(cli, ['mcp', 'remove', NAME, '-s', 'user'], { env: childEnv(PLAN_STRIP_ENV) });
      const r = await run(cli, ['mcp', 'add', '--scope', 'user', ...Object.entries(m.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), NAME, '--', m.command, ...m.args], { env: childEnv(PLAN_STRIP_ENV) });
      if (r.code !== 0) throw new Error((r.err || r.out).trim() || 'claude mcp add failed');
    },
    async disconnect(cli) { await run(cli, ['mcp', 'remove', NAME, '-s', 'user'], { env: childEnv(PLAN_STRIP_ENV) }); },
    check: (prompt, extra) => ({ args: ['-p', prompt, '--model', 'haiku', '--allowedTools', `mcp__${NAME}__chumi_connection_check`, '--output-format', 'text', ...extra] }),
    start: (cli) => [cli, MESSAGE],
  },
  codex: {
    bin: 'codex', client: 'codex', strip: PLAN_STRIP_ENV,
    setup: (m) => `codex mcp add ${Object.entries(m.env).map(([k, v]) => `--env ${k}=${q(v)} `).join('')}${NAME} -- ${q(m.command)} ${q(m.args[0])}`,
    async registration(cli) {
      const r = await run(cli, ['mcp', 'get', NAME, '--json'], { env: childEnv(PLAN_STRIP_ENV) });
      if (r.code !== 0) return { registered: false };
      try {
        const j = JSON.parse(r.out.slice(r.out.indexOf('{'))) as { enabled?: boolean; transport?: { args?: string[]; env?: Record<string, string> | null } };
        return { registered: true, outdated: outdated(j.transport?.args, j.transport?.env), detail: j.enabled === false ? 'Registered but disabled in Codex.' : null };
      } catch {
        return { registered: true };
      }
    },
    async connect(cli, m) {
      await run(cli, ['mcp', 'remove', NAME], { env: childEnv(PLAN_STRIP_ENV) });
      const r = await run(cli, ['mcp', 'add', ...Object.entries(m.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), NAME, '--', m.command, ...m.args], { env: childEnv(PLAN_STRIP_ENV) });
      if (r.code !== 0) throw new Error((r.err || r.out).replace(/WARNING:[^\n]*\n?/g, '').trim() || 'codex mcp add failed');
    },
    async disconnect(cli) { await run(cli, ['mcp', 'remove', NAME], { env: childEnv(PLAN_STRIP_ENV) }); },
    check: (prompt, extra) => ({ args: ['exec', '--skip-git-repo-check', '-s', 'read-only', ...extra, prompt] }),
    start: (cli, ws) => [cli, '-C', ws, MESSAGE],
  },
  // opencode has no command for adding a local MCP server, so Chumi edits ~/.config/opencode/opencode.json.
  // opencode merges it with opencode.jsonc, so a commented opencode.jsonc stays untouched.
  opencode: {
    bin: 'opencode', client: 'opencode', strip: [],
    setup: (m) => `${opencodeFile('json')}\n${JSON.stringify({ mcp: { [NAME]: opencodeEntry(m) } }, null, 2)}`,
    async registration(cli) {
      type Entry = { command?: string[]; environment?: Record<string, string>; enabled?: boolean };
      const inJsonc = readJsonc(opencodeFile('jsonc'))?.mcp?.[NAME] as Entry | undefined;
      const entry = (readJsonc(opencodeFile('json'))?.mcp?.[NAME] ?? inJsonc) as Entry | undefined;
      if (!entry) return { registered: false };
      const r = await run(cli, ['mcp', 'list'], { timeoutMs: 45_000 });
      const line = ansi(`${r.out}\n${r.err}`).split('\n').find((l) => new RegExp(`\\b${NAME}\\b`).test(l)) ?? '';
      const health = /\bconnected\b/i.test(line) ? 'connected' : /\b(failed|error)\b/i.test(line) ? 'failed' : 'unknown';
      const detail = entry.enabled === false ? 'Registered but disabled in opencode.'
        : inJsonc ? `An entry in ${opencodeFile('jsonc')} is yours to edit; Chumi only changes opencode.json.` : null;
      return { registered: true, clientHealth: health, outdated: outdated(entry.command, entry.environment), detail };
    },
    async connect(_cli, m) {
      editJsonFile(opencodeFile('json'), (cfg) => { cfg.mcp = { ...cfg.mcp, [NAME]: opencodeEntry(m) }; return true; }, { $schema: 'https://opencode.ai/config.json' });
    },
    async disconnect() {
      editJsonFile(opencodeFile('json'), (cfg) => {
        if (!cfg.mcp?.[NAME]) return false;
        delete cfg.mcp[NAME];
        if (!Object.keys(cfg.mcp).length) delete cfg.mcp;
        return true;
      }, null);
      if (readJsonc(opencodeFile('jsonc'))?.mcp?.[NAME]) throw new Error(`Remove the "${NAME}" entry from ${opencodeFile('jsonc')} yourself; Chumi does not edit commented config files.`);
    },
    // For this run only: no tools except Chumi's, and no edits, shell or web access.
    check: (prompt, extra) => ({ args: ['run', ...extra, prompt], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ tools: { '*': false, [`${NAME}_*`]: true }, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' } }) } }),
    start: (cli, ws) => [cli, ws, '--prompt', MESSAGE],
  },
  'qwen-code': {
    bin: 'qwen', client: 'qwen', strip: [],
    setup: (m) => `qwen mcp add --scope user ${Object.entries(m.env).map(([k, v]) => `-e ${k}=${q(v)} `).join('')}${NAME} ${q(m.command)} ${q(m.args[0])}`,
    async registration(cli) {
      const entry = readJsonc(qwenSettings())?.mcpServers?.[NAME] as { args?: string[]; env?: Record<string, string> } | undefined;
      if (!entry) return { registered: false };
      const r = await run(cli, ['mcp', 'list'], { timeoutMs: 45_000 });
      const line = ansi(`${r.out}\n${r.err}`).split('\n').find((l) => l.includes(`${NAME}:`)) ?? '';
      const health = /-\s*Connected\b/i.test(line) ? 'connected' : /-\s*(Disconnected|Failed)\b/i.test(line) ? 'failed' : 'unknown';
      return { registered: true, clientHealth: health, outdated: outdated(entry.args, entry.env) };
    },
    async connect(cli, m) {
      await run(cli, ['mcp', 'remove', '--scope', 'user', NAME]);
      const r = await run(cli, ['mcp', 'add', '--scope', 'user', ...Object.entries(m.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), NAME, m.command, ...m.args]);
      if (r.code !== 0) throw new Error((r.err || r.out).trim() || 'qwen mcp add failed');
    },
    async disconnect(cli) { await run(cli, ['mcp', 'remove', '--scope', 'user', NAME]); },
    // The prompt goes first: the list options after it would otherwise swallow it.
    check: (prompt, extra) => ({ args: [prompt, ...extra, '--allowed-mcp-server-names', NAME, '--allowed-tools', `mcp__${NAME}__chumi_connection_check`] }),
    start: (cli) => [cli, '-i', MESSAGE],
  },
};
function opencodeEntry(m: McpServer) {
  return { type: 'local', command: [m.command, ...m.args], enabled: true, ...(Object.keys(m.env).length ? { environment: m.env } : {}) };
}

/** Where read checks run: an empty folder, so an agent's own file tools see nothing of Chumi's data. */
function emptyCheckDir(): string {
  const dir = join(DATA_DIR, 'agent-check');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
  return dir;
}

export class AgentIntegration {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /** The command each client should run. CHUMI_DATA_DIR is passed only when it differs from the default. */
  mcpServer(): McpServer {
    return { command: stableNode(), args: [MCP_SCRIPT], env: process.env.CHUMI_DATA_DIR ? { CHUMI_DATA_DIR: DATA_DIR } : {} };
  }
  cli(agent: AgentId): string | null { return which(ADAPTERS[agent].bin); }

  /** Copyable commands (or configuration) for manual setup. */
  setupCommands(): Record<AgentId, string> {
    const m = this.mcpServer();
    return Object.fromEntries(AGENTS.map((a) => [a, ADAPTERS[a].setup(m)])) as Record<AgentId, string>;
  }

  /** Local availability: start the MCP server the way a client would and call its check tool. */
  async localCheck(): Promise<{ ok: boolean; detail: string; schemaVersion?: number }> {
    const m = this.mcpServer();
    const client = new Client({ name: 'chumi-self-check', version: '1' });
    const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The MCP server did not answer within 15 s.')), 15_000));
    try {
      await Promise.race([client.connect(new StdioClientTransport({ command: m.command, args: m.args, env: { ...childEnv(PLAN_STRIP_ENV), ...m.env } as Record<string, string>, stderr: 'ignore' })), timer]);
      const r = await Promise.race([client.callTool({ name: 'chumi_connection_check', arguments: {} }), timer]) as { content: Array<{ type: string; text?: string }> };
      const data = JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}') as { ok?: boolean; schema_version?: number; meetings?: number };
      return { ok: !!data.ok, detail: data.ok ? `Chumi's MCP server starts and reads ${data.meetings} meeting(s).` : 'The MCP server answered without data.', schemaVersion: data.schema_version };
    } catch (e) {
      return { ok: false, detail: `The MCP server could not start: ${(e as Error).message}` };
    } finally {
      await client.close().catch(() => {});
    }
  }

  async status(agent: AgentId): Promise<AgentStatus> {
    const a = ADAPTERS[agent];
    const cli = this.cli(agent);
    const reads = this.store.agentReads({ client: a.client, limit: 50 });
    const verified = reads.find((r) => r.tool === 'connection_check' && r.token);
    const base: AgentStatus = { agent, name: AGENT_NAMES[agent], billing: AGENT_BILLING[agent], cli, registered: null, outdated: false, clientHealth: 'unknown', lastRead: reads[0] ? { at: reads[0].at, tool: reads[0].tool } : null, verifiedAt: verified?.at ?? null, detail: null };
    if (!cli) return { ...base, registered: false, detail: `${AGENT_NAMES[agent]} is not installed (the \`${a.bin}\` command was not found).` };
    return { ...base, ...await a.registration(cli) };
  }

  /** Register (or re-register) Chumi in the client's user-level configuration. */
  async connect(agent: AgentId): Promise<void> {
    const cli = this.cli(agent);
    if (!cli) throw new Error(`${AGENT_NAMES[agent]} is not installed.`);
    await ADAPTERS[agent].connect(cli, this.mcpServer());
  }

  async disconnect(agent: AgentId): Promise<void> {
    const cli = this.cli(agent);
    if (cli) await ADAPTERS[agent].disconnect(cli);
  }

  /**
   * INT-01: ask the agent itself to call Chumi's check tool through its registered configuration, then confirm
   * the MCP server recorded that exact read. Uses one small model request.
   */
  /** extraArgs: only for tests (e.g. a per-run --mcp-config or a stand-in model instead of the user's). */
  async verify(agent: AgentId, extraArgs: string[] = []): Promise<{ ok: boolean; detail: string }> {
    const a = ADAPTERS[agent];
    const cli = this.cli(agent);
    if (!cli) return { ok: false, detail: 'Not installed.' };
    const token = uid('chk_');
    const prompt = `Call the MCP tool chumi_connection_check from the "chumi" server with token "${token}". Then reply with one line: OK if the tool returned ok true, otherwise the error.`;
    const c = a.check(prompt, extraArgs);
    const r = await run(cli, c.args, { timeoutMs: 180_000, cwd: emptyCheckDir(), env: childEnv(a.strip, c.env) });
    const read = this.store.agentReads({ token, limit: 1 })[0];
    if (read) return { ok: true, detail: `${AGENT_NAMES[agent]} read Chumi's data through MCP (client "${read.client ?? 'unknown'}").` };
    const why = ansi(r.err || r.out).replace(/WARNING:[^\n]*\n?/g, '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    return { ok: false, detail: why ? `No read was recorded. The agent said: ${why}` : 'No read was recorded. Connect the agent first, then try again.' };
  }

  /**
   * Open a Terminal window in the project folder running the agent with the handoff as its first message.
   * The agent then works under its own permission prompts; Chumi does not treat launching as completion.
   */
  launch(agent: AgentId, handoffId: string, workspace: string, prompt: string): { script: string } {
    const script = this.launchScript(agent, handoffId, workspace, prompt);
    openInTerminal(script);
    return { script };
  }

  /** Writes the handoff and a script that starts the agent in the project folder with it as the first message. */
  launchScript(agent: AgentId, handoffId: string, workspace: string, prompt: string): string {
    const cli = this.cli(agent);
    if (!cli) throw new Error(`${AGENT_NAMES[agent]} is not installed.`);
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`The project folder is not available: ${workspace}. Choose its new location in Projects.`);
    const dir = join(DATA_DIR, 'handoffs');
    mkdirSync(dir, { recursive: true });
    const promptFile = join(dir, `${handoffId}-${agent}.md`);
    writeFileSync(promptFile, prompt);
    const words = ADAPTERS[agent].start(cli, workspace);
    if (IS_WIN) {
      // cmd.exe cannot pass a multi-line argument, so the agent starts with a one-line pointer to the handoff file.
      const message = `Read the file ${promptFile} and follow the instructions in it.`;
      const cmd = (w: string) => `"${w.replace(/"/g, '')}"`;
      const script = join(dir, `${handoffId}-${agent}.cmd`);
      writeFileSync(script, `@echo off\r\nrem Opened by Chumi: continue a confirmed meeting handoff in ${AGENT_NAMES[agent]}.\r\nchcp 65001 >nul\r\ncd /d ${cmd(workspace)} || (echo Project folder not found: ${workspace.replace(/[\r\n"%]/g, '')} & pause & exit /b 1)\r\ncall ${words.map((w) => cmd(w === MESSAGE ? message : w)).join(' ')}\r\n`);
      return script;
    }
    const script = join(dir, `${handoffId}-${agent}.command`);
    writeFileSync(script, `#!/bin/zsh\n# Opened by Chumi: continue a confirmed meeting handoff in ${AGENT_NAMES[agent]}.\ncd ${q(workspace)} || { echo ${q(`Project folder not found: ${workspace}`)}; read; exit 1; }\n${words.map((w) => (w === MESSAGE ? `"$(cat ${q(promptFile)})"` : q(w))).join(' ')}\n`);
    chmodSync(script, 0o755);
    return script;
  }
}
