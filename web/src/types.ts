import type { SessionTypeOption } from '../../shared/session-types.ts';
import type { CompatibleSettings } from '../../shared/compatible-provider.ts';
import type { SpeakerAnnotation, SpeakerView } from '../../shared/speakers.ts';
import type { AgentId } from '../../shared/agents.ts';
import type { Tag, Topic } from './pet/tags.ts';

/** server/asr/engines.ts: 'qwen3', 'sensevoice' and 'whisper' run on this computer; the others are speech services. */
export type SpeechEngineId = 'qwen3' | 'sensevoice' | 'whisper' | 'elevenlabs' | 'qwen-cloud' | 'qwen-local';

export type Depth = 'quick' | 'standard' | 'deep';
export type Effort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SessionType = string;

export interface StartDraft {
  title: string;
  type: string;
  source: string;
  file: string;
  speed: number;
  capture: boolean;
  win: WindowInfo | null;
  projectId: string | null;
  record: boolean;
}

export interface Settings {
  audio: { source: 'mic' | 'system' | 'both'; micDeviceUid: string | null; aec: boolean; saveRawAudio: boolean };
  asr: {
    engine: SpeechEngineId; qwenCloud: { baseUrl: string; model: string }; qwenLocal: { baseUrl: string; model: string };
    model: string; modelBaseUrl: string; language: 'auto' | 'en' | 'zh'; threads: number; glossary: string[]; chineseScript: 'simplified' | 'original'; diarization: boolean;
  };
  ai: {
    provider: 'codex' | 'claude-cli' | 'anthropic-api' | 'compatible' | 'mock';
    effort: Effort;
    backgroundEffort: 'low' | 'medium' | 'high';
    codex: { model: string | null; allowCredits: boolean };
    claudeCli: { model: string };
    anthropicApi: { enabled: boolean; model: string };
    compatible: CompatibleSettings;
  };
  assist: { autoExplain: boolean; autoExplainFrequency: 'low' | 'medium' | 'high'; defaultDepth: Depth; autoOverview: boolean };
  sessionTypes: SessionTypeOption[];
  quickStart: { hotkey: string; source: 'default' | 'mic' | 'system' | 'both'; type: SessionType; notify: boolean };
  integrations: { mybot: { enabled: boolean; exportDir: string; shareWithTeam: boolean; serverUrl: string } };
  screen: { sendImagesToAI: boolean; intervalSec: number };
  ui: { language: 'auto' | 'en' | 'zh'; setupDismissed: boolean };
  pet: { enabled: boolean; size: number; toolbar: boolean; cards: 'none' | 'latest' | 'recent'; tags: Tag[]; say: Topic[]; inRecordings: boolean; lowKey: boolean };
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
  overageBlocked?: boolean;
  account?: string | null; plan?: string | null; model?: string | null; models?: Array<{ id: string; name: string }>;
  quota: { known: boolean; summary: string; windows?: QuotaWindow[]; exhausted?: boolean; credits?: { hasCredits: boolean; balance: string | null; willUse: boolean } | null; note?: string };
  message?: string; setupHint?: string; checkedAt: number;
}

export interface Session {
  id: string; title: string; type: SessionType; status: 'recording' | 'paused' | 'ended' | 'interrupted';
  created_at: number; started_at: number | null; ended_at: number | null; last_activity_at: number | null;
  audio_source: string | null; duration_ms: number; segment_count?: number; snippet?: string;
  project_id: string | null; revision: number;
  /** 1 = this meeting's audio is kept on this computer. */
  record_audio?: number;
  /** Session lists only: audio of this session is kept. */
  has_audio?: boolean;
}
export interface Segment extends SpeakerAnnotation { id: number; session_id: string; t_start: number; t_end: number; text: string; lang: string | null; source: string | null; run: number }
export interface TimelineEvent { id: number; session_id: string; t: number; kind: string; wall: number; detail: string | null }
export interface Output {
  id: string; session_id: string; kind: string; status: string; question: string | null; selection: { fromT: number; toT: number; text: string } | null;
  scope: string | null; depth: string | null; covered_from: number | null; covered_to: number | null; content: string | null;
  data: Record<string, any> | null; error: string | null; provider: string | null; model: string | null; billing: string | null;
  auto_epoch: number | null; parent_id: string | null; created_at: number; completed_at: number | null;
  stale_reason?: string | null;
}

export interface LiveState {
  status: 'idle' | 'starting' | 'recording' | 'paused' | 'ending';
  session: Session | null; source: string; nowT: number; serverTime: number;
  levels: Record<string, { rms: number; peak: number; at: number }>;
  partials: Record<string, { uttId: number; t: number; text: string }>;
  captureHealth?: Record<string, { state: 'ok' | 'silent' | 'restarting' | 'failed'; code?: string; message?: string; vars?: Record<string, string | number> }>;
  warnings: Array<{ code: string; message: string; at: number }>;
  asr: { state: string; message: string | null; latencyMs: number; backlogSec: number; pending: number; retrying?: boolean };
  file: { path: string; speed: number; posSec: number } | null;
  screen: { windowId: number; title: string; app: string; status: string; frames: number; capped?: boolean; lastCaptureAt: number } | null;
}

export interface Frame { id: number; session_id: string; t: number; width: number | null; height: number | null; kind: string; window_title: string | null; app: string | null; created_at: number }
export interface WindowInfo { id: number; app: string; bundleId: string; pid: number; title: string; width: number; height: number; onScreen: boolean }

export interface SessionData { session: Session; segments: Segment[]; timeline: TimelineEvent[]; outputs: Output[]; frames: Frame[]; live: boolean; handoff: Handoff | null; speakerView?: SpeakerView; hasAudio?: boolean }
/** Annotations of analysed lines and every output's staleness; clients merge them into what they already have. */
export interface SpeakerUpdate { sessionId: string; speakerView: SpeakerView; session: Session; handoff: Handoff | null; annotations: Array<SpeakerAnnotation & { id: number }>; stale: Record<string, string | null> }

export interface Project {
  id: string; name: string; workspace: string; repo: { root: string; remote: string | null; branch: string | null } | null;
  workspace_exists: boolean; meeting_count: number; created_at: number; updated_at: number; archived_at: number | null;
}
export type EvidenceRef = { kind: 'transcript'; segment_ids: number[]; from_ms: number; to_ms: number } | { kind: 'frame'; frame_id: number; t: number };
export interface HandoffItem {
  id: string; project_id: string | null; kind: 'decision' | 'action' | 'question'; text: string; rationale: string | null;
  origin: 'agreed' | 'suggested' | 'chumi' | 'user'; owner: string | null; due: string | null;
  conditions: string[]; acceptance: string[]; evidence: EvidenceRef[]; review: 'pending' | 'confirmed' | 'rejected'; edited: boolean; position: number;
  progress?: import('../../shared/project-work.ts').ActionProgress | null;
}
export interface Handoff {
  output_id?: string | null;
  id: string; session_id: string; project_id: string | null; status: 'generating' | 'draft' | 'confirmed' | 'error';
  source_revision: number | null; confirmed_revision: number | null; confirmed_at: number | null;
  delivered_at: number | null; delivered_via: string | null; error: string | null; created_at: number; updated_at: number;
  project: { id: string; name: string; workspace: string } | null; meeting_project_id: string | null; project_mismatch: boolean;
  items: HandoffItem[];
  freshness: { current_revision: number | null; reviewed_revision: number | null; stale: boolean; detail: { new_transcript_lines: number; new_outputs: number; summary_regenerated: boolean; new_frames: number; resumed: boolean; reassigned: boolean; meeting_deleted: boolean; speaker_labels_changed?: boolean } };
  last_agent_read: { at: number; client: string | null; revision: number | null } | null;
}
export interface AgentStatus {
  agent: AgentId; name: string; billing: 'plan' | 'unknown'; cli: string | null; registered: boolean | null; outdated: boolean; outdatedReasons: string[];
  clientHealth: 'connected' | 'failed' | 'unknown'; lastRead: { at: number; tool: string } | null; verifiedAt: number | null; detail: string | null;
  /** DeepSeek Harness only: its desktop app was found (the dsh command alone can come from npm). */
  appFound?: boolean;
}
export interface Notice { id: number; level: 'info' | 'warning' | 'error'; code: string; message: string; vars?: Record<string, string | number>; at: number }
