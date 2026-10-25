// Shared by scripts/demo-shoot.ts (README screenshots) and scripts/record-footage.ts (the promo videos' live footage):
// the fictional profile, the questions, the vocabulary and the app-window look, so both show the same meeting.
import { spawnSync } from 'node:child_process';

/** Everything the run types or asks, per language. */
export const DEMO = {
  en: {
    title: 'Lab meeting: citation model',
    project: 'Citation model',
    pcQ: 'What did the agent find in our judge code, and what does it need before the length-matched rerun?',
    q1: 'Why does the PI think the DPO gain might be judge bias?',
    slideQ: 'Explain what is shown on this slide and how it relates to what the speakers are saying.',
    explanation: 'English',
    profile: {
      background: 'Linguistics undergraduate, now a first-year PhD student in NLP.',
      researchInterests: 'Grounded question answering; how language models use evidence.',
      domains: [
        { name: 'Linguistics', level: 4 }, { name: 'Programming', level: 3 }, { name: 'Statistics', level: 3 },
        { name: 'Machine learning', level: 2 }, { name: 'LLM training', level: 1 }, { name: 'GPU systems', level: 0, notes: 'Do not assume any hardware knowledge.' },
      ],
      knownConcepts: ['tokenization', 'embeddings', 'cross-validation'],
      needsBackground: ['preference optimization', 'GPU memory'],
      style: 'Concise. Intuition first, then the mechanism.',
    },
  },
  zh: {
    title: '组会：引用模型',
    project: '引用模型',
    pcQ: '之前的 agent 在我们的 judge 代码里发现了什么问题？做 length matching 重跑之前还需要什么？',
    q1: '为什么 PI 觉得 DPO 的提升可能是 judge 的偏差？',
    slideQ: '解释这张幻灯片上的内容，以及它和发言内容的关系。',
    explanation: 'Simplified Chinese',
    profile: {
      background: '语言学本科，现在是 NLP 方向一年级博士生。',
      researchInterests: '有依据的问答；语言模型如何使用证据。',
      domains: [
        { name: '语言学', level: 4 }, { name: '编程', level: 3 }, { name: '统计学', level: 3 },
        { name: '机器学习', level: 2 }, { name: '大模型训练', level: 1 }, { name: 'GPU 系统', level: 0, notes: '不要假设我了解任何硬件知识。' },
      ],
      knownConcepts: ['tokenization', 'embeddings', 'cross-validation'],
      needsBackground: ['偏好优化', '显存'],
      style: '简洁。先讲直觉，再讲机制。',
    },
  },
};

/** Inside Chumi.app the top bar is the window's title bar; the screenshots show it the same way. */
export const APP_SHELL = `(() => {
  const h = document.documentElement;
  h.dataset.shell = 'mac';
  h.style.setProperty('--traffic-inset', '94px');
  if (!document.body) return false;
  if (document.getElementById('demo-traffic')) return true;
  const d = document.createElement('div');
  d.id = 'demo-traffic';
  d.innerHTML = '<i></i><i></i><i></i>';
  Object.assign(d.style, { position: 'fixed', left: '18px', top: '0', height: '55px', display: 'flex', alignItems: 'center', gap: '10px', zIndex: '9999', pointerEvents: 'none' });
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => Object.assign(d.children[i].style, { width: '13px', height: '13px', borderRadius: '50%', display: 'block', background: c, boxShadow: 'inset 0 0 0 .5px rgba(0,0,0,.18)' }));
  document.body.appendChild(d);
  const fit = () => { const b = document.querySelector('.topbar'); if (b) d.style.height = b.offsetHeight + 'px'; };
  fit(); setInterval(fit, 200);
  return true;
})()`;

// Vocabulary hints for this meeting's jargon (Settings → Transcription), as a user would add them.
export const GLOSSARY = ['DPO', 'LLM judge', 'KV cache', 'citation precision', 'citation recall', 'preference pairs', 'self-preference', 'length bias', 'paired bootstrap', "Cohen's kappa", 'n-gram overlap', 'preprint', 'annotation guidelines'];

/** Builds web/dist from the current source: the throwaway server serves it, and a stale build would show an old UI. */
export function buildWeb(root: string): void {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm run build:web failed:\n${r.stdout}${r.stderr}`);
}
