/**
 * Claude Code and Codex: register Chumi's MCP server with each client, report what is verified, run an
 * explicit read check, and open a project session that starts from a confirmed handoff.
 * Nothing here runs an agent on its own: registration, the read check and continuation are user actions.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Store } from '../db.ts';
import { DATA_DIR, REPO_ROOT, which } from '../paths.ts';
import { uid } from '../util.ts';

export type AgentId = 'claude-code' | 'codex';
export const AGENTS: AgentId[] = ['claude-code', 'codex'];
const NAME = 'chumi';
const CLI: Record<AgentId, string> = { 'claude-code': 'claude', codex: 'codex' };
/** MCP clientInfo names contain these (Claude Code: "claude-code"; Codex: "codex-mcp-client"). */
const CLIENT_MATCH: Record<AgentId, string> = { 'claude-code': 'claude', codex: 'codex' };
// Same safety rule as the AI providers: never let an API key in the environment turn a plan into paid usage.
const STRIP_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'OPENAI_API_KEY'];

export const MCP_SCRIPT = join(REPO_ROOT, 'server', 'mcp', 'main.ts');
/** Prefer a stable link (e.g. /opt/homebrew/bin/node) over a versioned Cellar path that breaks on upgrade. */
function stableNode(): string {
  const link = which('node');
  try { if (link && realpathSync(link) === realpathSync(process.execPath)) return link; } catch { /* fall through */ }
  return process.execPath;
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function run(bin: string, args: string[], o: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: o.timeoutMs ?? 30_000, cwd: o.cwd, env: o.env ?? childEnv(), maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => {
      resolve({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, out: String(out ?? ''), err: String(err ?? '') });
    });
    // These commands receive all input as arguments. Codex exec also reads piped stdin and waits
    // for EOF even with a prompt argument, so leaving execFile's default pipe open hangs the check.
    child.stdin?.end();
  });
}
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return env;
}

export interface AgentStatus {
  agent: AgentId;
  cli: string | null;
  /** Chumi's MCP server is registered in this client's configuration. null = could not tell. */
  registered: boolean | null;
  /** Registered with a different Chumi location or data folder (re-connect to fix). */
  outdated: boolean;
  /** Health reported by the client itself (Claude Code checks servers in `mcp get`); unknown for Codex. */
  clientHealth: 'connected' | 'failed' | 'unknown';
  /** A real agent read through this client, recorded by the MCP server. */
  lastRead: { at: number; tool: string } | null;
  verifiedAt: number | null;
  detail: string | null;
}

export class AgentIntegration {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /** The command each client should run. CHUMI_DATA_DIR is passed only when it differs from the default. */
  mcpServer(): { command: string; args: string[]; env: Record<string, string> } {
    return { command: stableNode(), args: [MCP_SCRIPT], env: process.env.CHUMI_DATA_DIR ? { CHUMI_DATA_DIR: DATA_DIR } : {} };
  }
  cli(agent: AgentId): string | null { return which(CLI[agent]); }

  /** Copyable commands for manual setup. */
  setupCommands(): Record<AgentId, string> {
    const m = this.mcpServer();
    const envC = Object.entries(m.env).map(([k, v]) => `-e ${k}=${q(v)} `).join('');
    const envX = Object.entries(m.env).map(([k, v]) => `--env ${k}=${q(v)} `).join('');
    return {
      'claude-code': `claude mcp add --scope user ${envC}${NAME} -- ${q(m.command)} ${q(m.args[0])}`,
      codex: `codex mcp add ${envX}${NAME} -- ${q(m.command)} ${q(m.args[0])}`,
    };
  }

  /** Local availability: start the MCP server the way a client would and call its check tool. */
  async localCheck(): Promise<{ ok: boolean; detail: string; schemaVersion?: number }> {
    const m = this.mcpServer();
    const client = new Client({ name: 'chumi-self-check', version: '1' });
    const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The MCP server did not answer within 15 s.')), 15_000));
    try {
      await Promise.race([client.connect(new StdioClientTransport({ command: m.command, args: m.args, env: { ...childEnv(), ...m.env } as Record<string, string>, stderr: 'ignore' })), timer]);
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
    const cli = this.cli(agent);
    const reads = this.store.agentReads({ client: CLIENT_MATCH[agent], limit: 50 });
    const verified = reads.find((r) => r.tool === 'connection_check' && r.token);
    const base: AgentStatus = { agent, cli, registered: null, outdated: false, clientHealth: 'unknown', lastRead: reads[0] ? { at: reads[0].at, tool: reads[0].tool } : null, verifiedAt: verified?.at ?? null, detail: null };
    if (!cli) return { ...base, registered: false, detail: agent === 'claude-code' ? 'Claude Code is not installed (the `claude` command was not found).' : 'Codex is not installed (the `codex` command was not found).' };
    if (agent === 'claude-code') {
      const r = await run(cli, ['mcp', 'get', NAME], { timeoutMs: 45_000 });
      if (r.code !== 0) return { ...base, registered: false };
      const health = /Status:\s*✔/.test(r.out) ? 'connected' : /Status:\s*(✘|✗|failed)/i.test(r.out) ? 'failed' : 'unknown';
      const outdated = !r.out.includes(MCP_SCRIPT) || (process.env.CHUMI_DATA_DIR ? !r.out.includes(DATA_DIR) : /CHUMI_DATA_DIR=/.test(r.out));
      return { ...base, registered: true, clientHealth: health, outdated };
    }
    const r = await run(cli, ['mcp', 'get', NAME, '--json']);
    if (r.code !== 0) return { ...base, registered: false };
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{'))) as { enabled?: boolean; transport?: { args?: string[]; env?: Record<string, string> | null } };
      const outdated = !(j.transport?.args ?? []).includes(MCP_SCRIPT) || (process.env.CHUMI_DATA_DIR ? j.transport?.env?.CHUMI_DATA_DIR !== DATA_DIR : !!j.transport?.env?.CHUMI_DATA_DIR);
      return { ...base, registered: true, outdated, detail: j.enabled === false ? 'Registered but disabled in Codex.' : null };
    } catch {
      return { ...base, registered: true };
    }
  }

  /** Register (or re-register) Chumi in the client's user-level configuration. */
  async connect(agent: AgentId): Promise<void> {
    const cli = this.cli(agent);
    if (!cli) throw new Error(`${agent === 'claude-code' ? 'Claude Code' : 'Codex'} is not installed.`);
    const m = this.mcpServer();
    if (agent === 'claude-code') {
      await run(cli, ['mcp', 'remove', NAME, '-s', 'user']);
      const r = await run(cli, ['mcp', 'add', '--scope', 'user', ...Object.entries(m.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), NAME, '--', m.command, ...m.args]);
      if (r.code !== 0) throw new Error((r.err || r.out).trim() || 'claude mcp add failed');
    } else {
      await run(cli, ['mcp', 'remove', NAME]);
      const r = await run(cli, ['mcp', 'add', ...Object.entries(m.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), NAME, '--', m.command, ...m.args]);
      if (r.code !== 0) throw new Error((r.err || r.out).replace(/WARNING:[^\n]*\n?/g, '').trim() || 'codex mcp add failed');
    }
  }

  async disconnect(agent: AgentId): Promise<void> {
    const cli = this.cli(agent);
    if (!cli) return;
    await run(cli, agent === 'claude-code' ? ['mcp', 'remove', NAME, '-s', 'user'] : ['mcp', 'remove', NAME]);
  }

  /**
   * INT-01: ask the agent itself to call Chumi's check tool through its registered configuration, then confirm
   * the MCP server recorded that exact read. Uses one small request on the user's plan.
   */
  /** extraArgs: only for tests (e.g. a per-run --mcp-config instead of the registered server). */
  async verify(agent: AgentId, extraArgs: string[] = []): Promise<{ ok: boolean; detail: string }> {
    const cli = this.cli(agent);
    if (!cli) return { ok: false, detail: 'Not installed.' };
    const token = uid('chk_');
    const prompt = `Call the MCP tool chumi_connection_check from the "chumi" server with token "${token}". Then reply with one line: OK if the tool returned ok true, otherwise the error.`;
    mkdirSync(DATA_DIR, { recursive: true });
    const r = agent === 'claude-code'
      ? await run(cli, ['-p', prompt, '--model', 'haiku', '--allowedTools', `mcp__${NAME}__chumi_connection_check`, '--output-format', 'text', ...extraArgs], { timeoutMs: 180_000, cwd: DATA_DIR })
      : await run(cli, ['exec', '--skip-git-repo-check', '-s', 'read-only', ...extraArgs, prompt], { timeoutMs: 180_000, cwd: DATA_DIR });
    const read = this.store.agentReads({ token, limit: 1 })[0];
    if (read) return { ok: true, detail: `${agent === 'claude-code' ? 'Claude Code' : 'Codex'} read Chumi's data through MCP (client "${read.client ?? 'unknown'}").` };
    const why = (r.err || r.out).replace(/WARNING:[^\n]*\n?/g, '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    return { ok: false, detail: why ? `No read was recorded. The agent said: ${why}` : 'No read was recorded. Connect the agent first, then try again.' };
  }

  /**
   * Open a Terminal window in the project folder running the agent with the handoff as its first message.
   * The agent then works under its own permission prompts; Chumi does not treat launching as completion.
   */
  launch(agent: AgentId, handoffId: string, workspace: string, prompt: string): { script: string } {
    const cli = this.cli(agent);
    if (!cli) throw new Error(`${agent === 'claude-code' ? 'Claude Code' : 'Codex'} is not installed.`);
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`The project folder is not available: ${workspace}. Choose its new location in Projects.`);
    const dir = join(DATA_DIR, 'handoffs');
    mkdirSync(dir, { recursive: true });
    const promptFile = join(dir, `${handoffId}-${agent}.md`);
    const script = join(dir, `${handoffId}-${agent}.command`);
    writeFileSync(promptFile, prompt);
    const start = agent === 'claude-code' ? `${q(cli)} "$(cat ${q(promptFile)})"` : `${q(cli)} -C ${q(workspace)} "$(cat ${q(promptFile)})"`;
    writeFileSync(script, `#!/bin/zsh\n# Opened by Chumi: continue a confirmed meeting handoff in ${agent === 'claude-code' ? 'Claude Code' : 'Codex'}.\ncd ${q(workspace)} || { echo "Project folder not found: ${workspace.replace(/"/g, '')}"; read; exit 1; }\n${start}\n`);
    chmodSync(script, 0o755);
    execFile('/usr/bin/open', [script]);
    return { script };
  }
}
