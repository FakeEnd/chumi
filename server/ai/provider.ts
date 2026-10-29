export type BillingMode = 'subscription' | 'credits' | 'api' | 'none';

export interface QuotaWindow { label: string; usedPercent: number; resetsAt: number | null }
export interface QuotaInfo {
  /** false = the provider does not expose remaining allowance; never invent a number. */
  known: boolean;
  summary: string;
  windows?: QuotaWindow[];
  exhausted?: boolean;
  credits?: { hasCredits: boolean; balance: string | null; willUse: boolean } | null;
  note?: string;
}

export interface ProviderStatus {
  id: string;
  label: string;
  billing: BillingMode;
  billingLabel: string;
  state: 'ready' | 'checking' | 'signed_out' | 'quota_blocked' | 'not_installed' | 'disabled' | 'error';
  ready: boolean;
  account?: string | null;
  plan?: string | null;
  model?: string | null;
  models?: Array<{ id: string; name: string }>;
  quota: QuotaInfo;
  overageBlocked?: boolean;
  message?: string;
  setupHint?: string;
  checkedAt: number;
}

export interface CompletionRequest {
  /** Short task label for logs (catchup, ask, overview, …). */
  task: string;
  /** Higher values run first; background work is below 8. */
  priority?: number;
  /** System-level instructions. */
  instructions: string;
  /** User content: transcript context + question. */
  input: string;
  /** If set, the provider should return JSON matching this schema (as text). */
  jsonSchema?: Record<string, unknown>;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Screen captures (JPEG files) to show the model, in the order they are described in `input`. */
  images?: Array<{ path: string; label: string }>;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface CompletionResult { text: string; provider: string; model: string | null; billing: BillingMode; effort?: string | null }

export type ProviderErrorKind = 'auth' | 'quota' | 'quota_gate' | 'rate_limit' | 'network' | 'unavailable' | 'aborted' | 'bad_response' | 'disabled' | 'billing_safety';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  retryable: boolean;
  /** Background work yielded to an interactive request. */
  preempted = false;
  constructor(kind: ProviderErrorKind, message: string, retryable = false) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
  }
}

export interface InputBudget { tokens: number; estimate: (text: string) => number }

export interface AIProvider {
  readonly id: string;
  readonly label: string;
  /** Whether screen-capture images can be sent with requests. */
  readonly supportsImages: boolean;
  status(refresh?: boolean): Promise<ProviderStatus>;
  /** Let interactive work release local resources before it enters the assistant queue. */
  prioritize?(priority: number): void;
  /** Remaining text budget after instructions, schema, images and answer space. */
  inputBudget?(req: Pick<CompletionRequest, 'instructions' | 'jsonSchema' | 'images'>): InputBudget | null;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  shutdown(): Promise<void>;
}

export function windowLabel(mins: number | null): string {
  if (!mins) return 'Usage window';
  if (mins % 10080 === 0) return mins === 10080 ? 'Weekly limit' : `${mins / 10080}-week limit`;
  if (mins % 1440 === 0) return `${mins / 1440}-day limit`;
  if (mins % 60 === 0) return `${mins / 60}-hour limit`;
  return `${mins}-minute limit`;
}

/** Extract the first JSON object from model text (tolerates ```json fences and prose). */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)) as T; } catch { /* try next */ }
  }
  return null;
}
