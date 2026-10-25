/** Coding agents Chumi can hand meeting work to (server/projects/agents.ts). Order is the order shown in Settings. */
export const AGENTS = ['claude-code', 'codex', 'opencode', 'qwen-code', 'antigravity'] as const;
export type AgentId = typeof AGENTS[number];

export const AGENT_NAMES: Record<AgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'opencode', 'qwen-code': 'Qwen Code', antigravity: 'Antigravity' };

/**
 * How a read check is paid for. 'plan': Chumi checks the ChatGPT or Claude plan first and runs the check only within
 * its included usage. 'unknown': the agent uses whatever model account the user configured, so the user confirms first.
 */
export const AGENT_BILLING: Record<AgentId, 'plan' | 'unknown'> = { 'claude-code': 'plan', codex: 'plan', opencode: 'unknown', 'qwen-code': 'unknown', antigravity: 'unknown' };

export const isAgent = (a: string): a is AgentId => (AGENTS as readonly string[]).includes(a);
