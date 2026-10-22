import { ProviderError, type AIProvider, type CompletionRequest, type CompletionResult, type ProviderStatus } from './provider.ts';

/**
 * Offline test provider (NOT an AI model). Produces deterministic, clearly labelled placeholder answers
 * built from the transcript context so the UI and pipeline can be exercised without spending quota.
 * Only selectable in developer mode. Can simulate outages for acceptance tests.
 */
export class MockProvider implements AIProvider {
  readonly id = 'mock';
  readonly label = 'Offline test provider (not AI)';
  readonly supportsImages = true;
  failMode: null | 'quota' | 'network' = null;
  delayMs = 400;
  calls: CompletionRequest[] = [];

  async status(): Promise<ProviderStatus> {
    const failing = this.failMode !== null;
    return {
      id: this.id, label: this.label, billing: 'none', billingLabel: 'Local test stub — no cost', checkedAt: Date.now(),
      state: failing ? (this.failMode === 'quota' ? 'quota_blocked' : 'error') : 'ready', ready: !failing,
      quota: { known: false, summary: 'Not applicable (no model is called).' }, model: 'mock',
      message: failing ? `Simulated ${this.failMode} failure` : undefined,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    await new Promise((r, j) => {
      const t = setTimeout(r, this.delayMs);
      req.signal?.addEventListener('abort', () => { clearTimeout(t); j(new ProviderError('aborted', 'Request cancelled.')); }, { once: true });
    });
    if (this.failMode === 'quota') throw new ProviderError('quota', 'Simulated: plan usage limit reached.');
    if (this.failMode === 'network') throw new ProviderError('network', 'Simulated: network unreachable.', true);
    const lines = req.input.split('\n').filter((l) => /^\[\d+:\d{2}(?::\d{2})?\]/.test(l));
    const first = lines[0]?.match(/^\[([\d:]+)\]/)?.[1] ?? '0:00';
    const last = lines[lines.length - 1]?.match(/^\[([\d:]+)\]/)?.[1] ?? first;
    let text: string;
    if (req.jsonSchema) {
      const props = (req.jsonSchema.properties ?? {}) as Record<string, unknown>;
      if ('actions' in props) {
        // Handoff: the first line that sounds like a decision, one agreed and one tentative action, one question.
        const t = (l?: string) => l?.match(/^\[([\d:]+)\]/)?.[1] ?? first;
        const body = (l?: string) => (l ?? '').replace(/^\[[^\]]+\]\s*(\(computer audio\)\s*)?/, '').slice(0, 90);
        const agreed = lines.find((l) => /\b(let's|we will|we'll|agree|decid|should)\b/i.test(l));
        const tentative = lines.find((l) => l !== agreed && /\b(maybe|might|could|not sure|open)\b/i.test(l));
        const question = lines.find((l) => /\?/.test(l));
        text = JSON.stringify({
          decisions: agreed ? [{ text: `[test stub] ${body(agreed)}`, origin: 'agreed', evidence: [t(agreed)] }] : [],
          actions: [
            ...(agreed ? [{ text: `[test stub] Follow up: ${body(agreed)}`, origin: 'agreed', rationale: '[test stub] stated in the meeting', conditions: [], acceptance_criteria: ['[test stub] proposed check'], owner: null, due: null, evidence: [t(agreed)], captures: [] }] : []),
            ...(tentative ? [{ text: `[test stub] Consider: ${body(tentative)}`, origin: 'suggested', rationale: '[test stub] raised, not agreed', conditions: ['[test stub] not decided'], acceptance_criteria: [], owner: null, due: null, evidence: [t(tentative)], captures: [] }] : []),
          ],
          open_questions: question ? [{ text: `[test stub] ${body(question)}`, evidence: [t(question)] }] : [],
        });
      } else if ('cards' in props) {
        // Pick an acronym or known technical term from the NEW transcript part only.
        const part = req.input.slice(req.input.indexOf('NEW TRANSCRIPT'));
        const known = req.input.match(/ALREADY EXPLAINED OR KNOWN[^:]*:([^\n]*)/)?.[1]?.toLowerCase() ?? '';
        const cands = [...part.matchAll(/\b(MPRA|massively parallel reporter assay|negative binomial|in-silico mutagenesis|[A-Z]{2,}[A-Za-z0-9-]*)\b/g)].map((m) => m[1]).filter((t) => !known.includes(t.toLowerCase()));
        const term = cands[0];
        const line = term ? part.split('\n').find((l) => l.includes(term)) : undefined;
        const at = line?.match(/^\[([\d:]+)\]/)?.[1] ?? first;
        text = JSON.stringify({ cards: term ? [{ term, why_it_matters: `[test stub] "${term}" appears in the discussion.`, importance: 4, explanation_md: `**${term}** — [test stub explanation, not AI]`, evidence_time: at }] : [] });
      } else {
        text = JSON.stringify({
          current_topic: `[test stub] Topic around ${last}`,
          overview: [`[test stub] ${lines.length} transcript lines between [${first}] and [${last}].`],
          topics: [{ title: '[test stub] Discussion', start: first }],
          open_question: null,
          digest: `[test stub] Lines ${first}–${last}.`,
          topic_changed: false,
        });
      }
    } else {
      // Answers start with the question's category (shared/question-category.ts); the stub calls "relate…" questions tangents.
      const category = req.task !== 'answer' ? '' : /\b(relate|in general)\b/i.test(req.input.match(/^USER QUESTION: (.*)$/m)?.[1] ?? '') ? '[[tangent]]\n' : '[[meeting]]\n';
      text = `${category}> Offline test provider — this is not an AI answer.\n\n**Task:** ${req.task}${req.images?.length ? ` · ${req.images.length} screen capture(s) received` : ''}\n\n**Transcript covered:** [${first}]–[${last}] (${lines.length} lines)\n\n${lines.slice(-3).map((l) => `- ${l}`).join('\n')}`;
    }
    for (const chunk of text.match(/.{1,40}/gs) ?? []) req.onDelta?.(chunk);
    return { text, provider: this.id, model: 'mock', billing: 'none', effort: req.effort ?? null };
  }

  async shutdown(): Promise<void> { /* nothing */ }
}
