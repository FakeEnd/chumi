export interface SpeechEndpoint { baseUrl: string; model: string }
export interface EndpointDraft {
  saved: SpeechEndpoint;
  value: SpeechEndpoint;
  submitted: SpeechEndpoint | null;
}
export type EndpointDraftAction =
  | { type: 'edit'; value: SpeechEndpoint }
  | { type: 'saved'; value: SpeechEndpoint }
  | { type: 'submit'; value: SpeechEndpoint }
  | { type: 'settled'; value: SpeechEndpoint | null }
  | { type: 'discard' };

export const newEndpointDraft = (saved: SpeechEndpoint): EndpointDraft => ({ saved, value: saved, submitted: null });
export const endpointDirty = (a: SpeechEndpoint, b: SpeechEndpoint): boolean => a.baseUrl !== b.baseUrl || a.model !== b.model;

// A settings event may arrive before or after the PUT response. Adopt server changes only
// in fields the user has not changed since the baseline; edits made while saving survive.
function mergeDraft(baseline: SpeechEndpoint, draft: SpeechEndpoint, saved: SpeechEndpoint): SpeechEndpoint {
  return {
    baseUrl: draft.baseUrl === baseline.baseUrl ? saved.baseUrl : draft.baseUrl,
    model: draft.model === baseline.model ? saved.model : draft.model,
  };
}

export function endpointDraftReducer(state: EndpointDraft, action: EndpointDraftAction): EndpointDraft {
  switch (action.type) {
    case 'edit': return { ...state, value: action.value };
    case 'saved': return !endpointDirty(state.saved, action.value) ? state
      : { ...state, saved: action.value, value: mergeDraft(state.submitted ?? state.saved, state.value, action.value) };
    case 'submit': return { ...state, submitted: action.value };
    case 'settled': return action.value && state.submitted
      ? { saved: action.value, value: mergeDraft(state.submitted, state.value, action.value), submitted: null }
      : { ...state, submitted: null };
    case 'discard': return { ...state, value: state.saved };
  }
}
