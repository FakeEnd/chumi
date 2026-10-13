import os from 'node:os';
import { DEFAULT_SESSION_TYPES, type SessionTypeOption } from '../shared/session-types.ts';
import { recommendModel } from './asr/models.ts';
import { defaultCompatibleSettings, type CompatibleSettings } from '../shared/compatible-provider.ts';
export type AudioSourceMode = 'mic' | 'system' | 'both';
export type Depth = 'quick' | 'standard' | 'deep';
export type SessionType = string;
export const PROVIDER_IDS = ['codex', 'claude-cli', 'anthropic-api', 'compatible', 'mock'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface Settings {
  audio: {
    source: AudioSourceMode;
    micDeviceUid: string | null;
    /** Echo cancellation on the mic when capturing both sources (avoids duplicate text when using speakers). */
    aec: boolean;
    /** Off by default: raw audio is only written to disk when the user turns this on. */
    saveRawAudio: boolean;
  };
  asr: {
    model: string;
    /** 'auto' handles English, Mandarin and code-switching; force a language if detection misbehaves. */
    language: 'auto' | 'en' | 'zh';
    threads: number;
    /** Extra vocabulary that biases Whisper towards correct spellings of technical terms. */
    glossary: string[];
    /** Whisper sometimes emits Traditional characters for Mandarin; convert to Simplified by default. */
    chineseScript: 'simplified' | 'original';
    /** Opt-in local speaker labeling after a meeting; temporary PCM is deleted after processing. */
    diarization: boolean;
  };
  ai: {
    provider: ProviderId;
    /** Reasoning effort for requests you make (questions, explanations, catch-ups, summary). 'auto' = fast per-task defaults. */
    effort: 'auto' | Effort;
    /** Reasoning effort for automatic background work (overview, auto-explain, notes). Kept low to save usage. */
    backgroundEffort: 'low' | 'medium' | 'high';
    codex: { model: string | null; allowCredits: boolean };
    claudeCli: { model: string };
    anthropicApi: { enabled: boolean; model: string };
    compatible: CompatibleSettings;
  };
  assist: {
    autoExplain: boolean;
    /** How often unsolicited cards may appear. Independent of explanation depth. */
    autoExplainFrequency: 'low' | 'medium' | 'high';
    /** Default depth for explanations; can be overridden per request without touching the profile. */
    defaultDepth: Depth;
    autoOverview: boolean;
  };
  sessionTypes: SessionTypeOption[];
  quickStart: {
    /** System-wide shortcut: start listening immediately (press again to pause / resume). 'off' disables it. */
    hotkey: string;
    /** 'default' = the default audio source from the Audio settings. */
    source: 'default' | AudioSourceMode;
    type: SessionType;
    /** Show a macOS notification when the shortcut starts/pauses/resumes, since Chumi may be in the background. */
    notify: boolean;
  };
  integrations: {
    /** Export finished sessions as JSONL for mybot (github.com/jzhoulab/mybot) to index. Off by default. */
    /** `serverUrl`: a running mybot server, searched for project context when you turn it on for a meeting. */
    mybot: { enabled: boolean; exportDir: string; shareWithTeam: boolean; serverUrl: string };
  };
  screen: {
    /** Attach captured slides/screens to AI questions, catch-ups and summaries (images go to the AI provider). */
    sendImagesToAI: boolean;
    /** How often the selected window is checked for changes. */
    intervalSec: number;
  };
  /** Interface language ('auto' follows the system). Explanation language is separate (profile).
   *  setupDismissed: the user hid the getting-started checklist on Home. */
  ui: { language: 'auto' | 'en' | 'zh'; setupDismissed: boolean };
  devMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  audio: { source: 'mic', micDeviceUid: null, aec: true, saveRawAudio: false },
  asr: {
    model: recommendModel(), // Large v3 Turbo on Apple Silicon with 16 GB+, smaller models elsewhere
    language: 'auto',
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)), // leave cores for audio, UI and the AI client
    glossary: ['ATAC-seq', 'ChIP-seq', 'RNA-seq', 'scRNA-seq', 'enhancer', 'promoter', 'motif', 'transcription factor', 'chromatin accessibility', 'gene regulation', 'CRISPR', 'GWAS', 'eQTL', 'transformer', 'convolutional'],
    chineseScript: 'simplified',
    diarization: false,
  },
  ai: {
    provider: 'codex',
    effort: 'auto',
    backgroundEffort: 'low',
    codex: { model: null, allowCredits: false },
    claudeCli: { model: 'sonnet' },
    anthropicApi: { enabled: false, model: 'claude-opus-5-5' },
    compatible: defaultCompatibleSettings(),
  },
  assist: {
    autoExplain: false,
    autoExplainFrequency: 'medium',
    defaultDepth: 'standard',
    autoOverview: true,
  },
  sessionTypes: DEFAULT_SESSION_TYPES,
  quickStart: { hotkey: process.platform === 'win32' ? 'ctrl+alt+L' : 'ctrl+opt+cmd+L', source: 'default', type: 'other', notify: true },
  integrations: { mybot: { enabled: false, exportDir: '~/Library/Application Support/Chumi/exports/mybot', shareWithTeam: false, serverUrl: 'http://127.0.0.1:8788' } },
  screen: { sendImagesToAI: true, intervalSec: 3 },
  ui: { language: 'auto', setupDismissed: false },
  devMode: false,
};

/** 0 = new to it, 1 = introductory, 2 = working knowledge, 3 = strong, 4 = expert */
export interface DomainFamiliarity { name: string; level: 0 | 1 | 2 | 3 | 4; notes?: string }

export interface Profile {
  background: string;
  researchInterests: string;
  domains: DomainFamiliarity[];
  knownConcepts: string[];
  needsBackground: string[];
  explanationLanguage: string;
  keepEnglishTerms: boolean;
  style: string;
}

export const SOURCE_NAMES: Record<string, string> = { mic: 'microphone', system: 'computer audio', both: 'microphone + computer audio', file: 'audio file' };

export const EXPLANATION_LANGUAGES = ['Simplified Chinese', 'English'] as const;
/** Explanations are offered in Chinese (Simplified) or English. */
export function normalizeLanguage(v: unknown): string {
  return /chinese|中文|汉语|普通话|^zh/i.test(String(v ?? '')) ? 'Simplified Chinese' : 'English';
}

export const LEVEL_LABELS = ['new to this', 'introductory', 'working knowledge', 'strong', 'expert'] as const;

/**
 * A new install starts with an empty profile: the setup checklist asks for the user's own background.
 * (Until October 2026 the built-in profile below was the default; installs that never saved a profile keep it.)
 */
export const DEFAULT_PROFILE: Profile = {
  background: '', researchInterests: '', domains: [], knownConcepts: [], needsBackground: [],
  explanationLanguage: 'English', keepEnglishTerms: true, style: '',
};

/** The earlier built-in profile, kept for installs that have been using it without saving their own. */
export const LEGACY_DEFAULT_PROFILE: Profile = {
  background:
    'Software engineering background (professional experience). Now a PhD student in computational biology.',
  researchInterests: 'Deep learning for genomics; gene regulation; regulatory sequence models.',
  domains: [
    { name: 'Software engineering', level: 4 },
    { name: 'Machine learning / deep learning', level: 3, notes: 'Comfortable with architectures, training, evaluation.' },
    { name: 'Statistics', level: 2, notes: 'Explain assumptions of specific tests and models.' },
    { name: 'Genomics & gene regulation', level: 2, notes: 'Research area, but still learning many details.' },
    { name: 'Sequencing assays (ATAC-seq, ChIP-seq, RNA-seq)', level: 2 },
    { name: 'Wet-lab experimental techniques', level: 1, notes: 'Do not assume familiarity with specific protocols.' },
    { name: 'Molecular & cell biology', level: 1 },
    { name: 'Immunology', level: 0 },
    { name: 'Biochemistry & structural biology', level: 1 },
    { name: 'Clinical / medical genetics', level: 1 },
  ],
  knownConcepts: ['convolutional neural network', 'transformer', 'attention', 'cross-validation', 'gradient descent', 'p-value'],
  needsBackground: ['experimental assay design', 'biology-specific statistical models'],
  explanationLanguage: 'Simplified Chinese',
  keepEnglishTerms: true,
  style: 'Concise. Start with the intuition, then the mechanism. Use software/ML analogies when helpful.',
};
