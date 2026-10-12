export type Depth = 'quick' | 'standard' | 'deep';
export type Effort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SessionType = 'lab_meeting' | 'advisor' | 'lecture' | 'wip' | 'other';

export interface Settings {
  audio: { source: 'mic' | 'system' | 'both'; micDeviceUid: string | null; aec: boolean; saveRawAudio: boolean };
  asr: { model: string; language: 'auto' | 'en' | 'zh'; threads: number; glossary: string[]; chineseScript: 'simplified' | 'original' };
  ai: {
    provider: 'codex' | 'claude-cli' | 'anthropic-api' | 'mock';
    effort: Effort;
    backgroundEffort: 'low' | 'medium' | 'high';
    codex: { model: string | null; allowCredits: boolean };
    claudeCli: { model: string };
    anthropicApi: { enabled: boolean; model: string };
  };
  assist: { autoExplain: boolean; autoExplainFrequency: 'low' | 'medium' | 'high'; defaultDepth: Depth; autoOverview: boolean };
  quickStart: { hotkey: string; source: 'default' | 'mic' | 'system' | 'both'; type: SessionType; notify: boolean };
  integrations: { mybot: { enabled: boolean; exportDir: string; shareWithTeam: boolean; serverUrl: string } };
  screen: { sendImagesToAI: boolean; intervalSec: number };
  ui: { language: 'auto' | 'en' | 'zh' };
  devMode: boolean;
}

export interface Domain { name: string; level: number; notes?: string }
export interface Profile {
  background: string; researchInterests: string; domains: Domain[]; knownConcepts: string[]; needsBackground: string[];
  explanationLanguage: string; keepEnglishTerms: boolean; style: string;
}

export interface QuotaWindow { label: string; usedPercent: number; resetsAt: number | null }
export interface ProviderStatus {
  id: string; label: string; billing: 'subscription' | 'credits' | 'api' | 'none'; billingLabel: string;
  state: 'ready' | 'checking' | 'signed_out' | 'quota_blocked' | 'not_installed' | 'disabled' | 'error'; ready: boolean;
  account?: string | null; plan?: string | null; model?: string | null; models?: Array<{ id: string; name: string }>;
  quota: { known: boolean; summary: string; windows?: QuotaWindow[]; exhausted?: boolean; credits?: { hasCredits: boolean; balance: string | null; willUse: boolean } | null; note?: string };
  message?: string; setupHint?: string; checkedAt: number;
}

export interface Session {
  id: string; title: string; type: SessionType; status: 'recording' | 'paused' | 'ended' | 'interrupted';
  created_at: number; started_at: number | null; ended_at: number | null; last_activity_at: number | null;
  audio_source: string | null; duration_ms: number; segment_count?: number; snippet?: string;
  project_id: string | null; revision: number;
}
export interface Segment { id: number; session_id: string; t_start: number; t_end: number; text: string; lang: string | null; source: string | null; run: number }
export interface TimelineEvent { id: number; session_id: string; t: number; kind: string; wall: number; detail: string | null }
export interface Output {
  id: string; session_id: string; kind: string; status: string; question: string | null; selection: { fromT: number; toT: number; text: string } | null;
  scope: string | null; depth: string | null; covered_from: number | null; covered_to: number | null; content: string | null;
  data: Record<string, any> | null; error: string | null; provider: string | null; model: string | null; billing: string | null;
  auto_epoch: number | null; parent_id: string | null; created_at: number; completed_at: number | null;
}

export interface LiveState {
  status: 'idle' | 'starting' | 'recording' | 'paused' | 'ending';
  session: Session | null; source: string; nowT: number; serverTime: number;
  levels: Record<string, { rms: number; peak: number; at: number }>;
  partials: Record<string, { uttId: number; t: number; text: string }>;
  warnings: Array<{ code: string; message: string; at: number }>;
  asr: { state: string; message: string | null; latencyMs: number; backlogSec: number; pending: number };
  file: { path: string; speed: number; posSec: number } | null;
  screen: { windowId: number; title: string; app: string; status: string; frames: number; lastCaptureAt: number } | null;
}

export interface Frame { id: number; session_id: string; t: number; width: number | null; height: number | null; kind: string; window_title: string | null; app: string | null; created_at: number }
export interface WindowInfo { id: number; app: string; bundleId: string; pid: number; title: string; width: number; height: number; onScreen: boolean }

export interface SessionData { session: Session; segments: Segment[]; timeline: TimelineEvent[]; outputs: Output[]; frames: Frame[]; live: boolean; handoff: Handoff | null }

export interface Project {
  id: string; name: string; workspace: string; repo: { root: string; remote: string | null; branch: string | null } | null;
  workspace_exists: boolean; meeting_count: number; created_at: number; updated_at: number; archived_at: number | null;
}
export type EvidenceRef = { kind: 'transcript'; segment_ids: number[]; from_ms: number; to_ms: number } | { kind: 'frame'; frame_id: number; t: number };
export interface HandoffItem {
  id: string; kind: 'decision' | 'action' | 'question'; text: string; rationale: string | null;
  origin: 'agreed' | 'suggested' | 'chumi' | 'user'; owner: string | null; due: string | null;
  conditions: string[]; acceptance: string[]; evidence: EvidenceRef[]; review: 'pending' | 'confirmed' | 'rejected'; edited: boolean; position: number;
}
export interface Handoff {
  id: string; session_id: string; project_id: string | null; status: 'generating' | 'draft' | 'confirmed' | 'error';
  source_revision: number | null; confirmed_revision: number | null; confirmed_at: number | null;
  delivered_at: number | null; delivered_via: string | null; error: string | null; created_at: number; updated_at: number;
  project: { id: string; name: string; workspace: string } | null; meeting_project_id: string | null; project_mismatch: boolean;
  items: HandoffItem[];
  freshness: { current_revision: number | null; reviewed_revision: number | null; stale: boolean; detail: { new_transcript_lines: number; new_outputs: number; summary_regenerated: boolean; new_frames: number; resumed: boolean; reassigned: boolean; meeting_deleted: boolean } };
  last_agent_read: { at: number; client: string | null; revision: number | null } | null;
}
export interface AgentStatus {
  agent: 'claude-code' | 'codex'; cli: string | null; registered: boolean | null; outdated: boolean;
  clientHealth: 'connected' | 'failed' | 'unknown'; lastRead: { at: number; tool: string } | null; verifiedAt: number | null; detail: string | null;
}
export interface Notice { id: number; level: 'info' | 'warning' | 'error'; code: string; message: string; at: number }
