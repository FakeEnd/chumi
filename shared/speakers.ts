/** Speaker identities are local to one meeting and one audio source, never inferred real names. */
export interface Speaker {
  id: string;
  session_id: string;
  source: string;
  label: string;
  name: string | null;
}

export interface SpeakerAnnotation {
  speaker_id?: string | null;
  speaker_label?: string | null;
  /** null: the line has not been analysed. */
  speaker_state?: 'assigned' | 'mixed' | 'unknown' | null;
  speaker_origin?: 'automatic' | 'manual' | null;
}

export interface SpeakerTurn {
  source: string;
  speaker: string;
  start_ms: number;
  end_ms: number;
}

export type SpeakerAnalysisStatus = 'not_run' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface SpeakerAnalysis {
  status: SpeakerAnalysisStatus;
  generation: string | null;
  error: string | null;
  updated_at: number | null;
}

export interface SpeakerRuntime {
  ready: boolean;
  reason: string | null;
  setupCommand: string;
}

export interface SpeakerView {
  speakers: Speaker[];
  analysis: SpeakerAnalysis;
  runtime: SpeakerRuntime;
  canRun: boolean;
  audioAvailable: boolean;
}

export type SpeakerCorrection = { mode: 'automatic' | 'unknown' } | { mode: 'speaker'; speakerId: string };
