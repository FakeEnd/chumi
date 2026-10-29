export type MessageVars = Record<string, string | number>;

/** Older service adapters return formatted text. Recognize only these known message templates. */
export const SERVER_MESSAGE_TEMPLATES = [
  'Add your {engine} API key in Settings → Transcription.',
  'Speech recognition is not ready: {error}',
  '{engine} failed ({error}). Chumi is transcribing with local speech recognition until it works again.',
  '{error} Using {engine}.',
  'Speech engine stopped unexpectedly (code {code}); restarting…',
  'Could not register {key} (error {code}); another app may already use it.',
  'Shortcut helper exited (code {code}); restarting…',
  'Claude Code is authenticated with "{method}", which is billed per request. Chumi only uses this adapter with a Claude plan sign-in.',
  'Could not run Claude Code: {error}',
  'Claude plan limit reached: {error}',
  'Claude Code authentication problem: {error}. Run "claude auth login".',
  'Claude Code exited (code {code}) without a result. {error}',
  'The model server returned HTTP {status}. No retry was sent.',
  'The model "{model}" is not downloaded in Ollama. Downloaded: {models}. Pick one of these, or run: ollama pull {model}',
  'The model "{model}" is not downloaded in Ollama. In Terminal run: ollama pull {model}',
  "Last reported {limit} limit status: {status} ({percent}% used), resets {date}.",
  "Last reported {limit} limit status: {status} ({percent}% used).",
  "Last reported {limit} limit status: {status}, resets {date}.",
  "Last reported {limit} limit status: {status}.",
  'Simulated {kind} failure',
  "Loading {engine}…",
  "Invalid shortcut \"{key}\"; use e.g. ctrl+opt+cmd+L",
  "Chumi's MCP server starts and reads {n} meeting(s).",
  "The MCP server could not start: {error}",
  "{name} is not installed (the `{command}` command was not found).",
  "{name} read Chumi's data through MCP (client \"{client}\").",
  "No read was recorded. The agent said: {error}",
  "Copying to the clipboard failed (exit {code}).",
  "Audio could not be saved: {error}. Transcription continues.",
  "Audio {source} device changed to {device}.",
  "Audio {source} device changed.",
  "Waiting for macOS permission for: {permissions}. Look for a permission dialog and allow it.",
  "Audio capture stopped unexpectedly ({error}). Trying to restart…",
  "Audio capture keeps stopping ({error}), so the session is paused. Everything captured so far is saved. Check the audio device, then resume.",
  "Audio could not be saved: {error}",
  "The session was saved, but its summary could not be started: {error}",
  "Audio capture failed to start: {error}",
  "{service} rejected the API key (HTTP {status}). {error}",
  "{service} rejected the API key (HTTP {status}).",
  "{service} HTTP {status}: {error}",
  "{service} HTTP {status}",
  "{service} returned a response Chumi could not read.",
  "{service} did not answer within {seconds} s.",
  "Cannot reach {service} at {host} ({error}).",
  "HTTP {status}",
  "Cannot reach the Qwen3-ASR server at {url} ({error}). Start it with qwen-asr-serve, or check the address.",
  "{path} does not match its published SHA-256 checksum",
  "{engine} worker exited ({code}).",
  "whisper-server: {error}",
  "Chumi did not change {file}: it has comments or is not a plain JSON object, and rewriting it would lose them. Edit the \"{entry}\" entry yourself (shown below).",
  "{error} Could not restore Claude Code's previous registration.",
  "An entry in {file} is yours to edit; Chumi only changes opencode.json.",
  "Remove the \"{entry}\" entry from {file} yourself; Chumi does not edit commented config files.",
  "DeepSeek Harness did not accept the new entry, so {file} was restored. {error}",
  "{name} is not installed.",
  "{name} has no terminal session to start. Continue in its app instead.",
  "The project folder is not available: {path}. Choose its new location in Projects.",
  "Choose an absolute project folder in Projects before opening {app}.",
  "The handoff is empty. Generate and confirm it before opening {app}.",
  "Chumi did not change {file}: its \"{begin}\" block has no \"{end}\" line. Remove what is left of it, then connect again.",
  "Chumi did not change {file}: it already has a server named chumi that Chumi did not add. Remove that entry, or keep using it.",
  "Chumi did not change {file}: it is not a YAML list written one item per line. Add the entry shown below yourself.",
  "Review every item first: {n} still need a decision (confirm or reject).",
  "Anthropic API error {status}: {error}",
  "{error} Transcription continues and nothing captured is lost.",
  "Subscription — Claude {plan} plan",
  "Subscription — ChatGPT {plan} plan",
  "Claude Code is using an API key ({source}); request aborted to avoid API billing.",
  "Claude Code sent nothing for {duration}; the request was stopped.",
  "Claude Code did not finish within {duration}; the request was stopped.",
  "Codex app-server stopped (code {code}).",
  "Codex {method} timed out",
  "Codex: {error}",
  "Turn {status}",
  "ChatGPT is rate-limiting requests ({error}). Try again shortly.",
  "Network problem reaching ChatGPT: {error}",
  "Ollama is running, but no models are downloaded yet. In Terminal run: ollama pull {model}",
  "{limit}: {percent}% used, resets {date}",
  "{limit}: {percent}% used",
  "Window capture stopped: “{title}” is no longer available.",
  "mybot answered {status}",
  "helper exited (code {code}, {signal})",
  "helper exited (code {code})",
  "Not transcribed ({from}–{to}): {error}. Any saved recording is still available.",
  "{n} min",
  "{n}-week limit",
  "{n}-day limit",
  "{n}-hour limit",
  "{n}-minute limit",
] as const;

// Only these provider hints may be appended to a status message. Arbitrary error text stays intact.
export const SERVER_SETUP_HINTS = [
  'Install Claude Code, then run: claude auth login',
  'In Terminal run: claude auth login  (sign in with your Claude Pro/Max account). Chumi never sees your credentials.',
  'Run "claude auth logout" then "claude auth login" with your Claude subscription.',
  'In Terminal run: codex login  → choose "Sign in with ChatGPT". Chumi never sees your credentials.',
  'Run "codex logout" then "codex login" and choose Sign in with ChatGPT.',
  'In Terminal run: claude auth status',
];

const templates = SERVER_MESSAGE_TEMPLATES.map((key) => {
  const names: string[] = [];
  const pattern = key.split(/(\{\w+\})/).map((part) => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { key, names, pattern: new RegExp(`^${pattern}$`) };
});

export function matchServerMessage(en: string): { key: string; vars: MessageVars } | undefined {
  for (const hint of SERVER_SETUP_HINTS) {
    if (en.endsWith(' ' + hint)) return { key: '{error} {hint}', vars: { error: en.slice(0, -hint.length - 1), hint } };
  }
  for (const { key, names, pattern } of templates) {
    const match = pattern.exec(en);
    if (match) return { key, vars: Object.fromEntries(names.map((name, i) => [name, match[i + 1]])) };
  }
}

const hasTranslations = new WeakMap<Record<string, string>, boolean>();
export function translateMessage(en: string, dictionary: Record<string, string>, vars?: MessageVars, depth = 0): string {
  if (depth > 5) return en;
  let translated = hasTranslations.get(dictionary);
  if (translated === undefined) { translated = Object.keys(dictionary).length > 0; hasTranslations.set(dictionary, translated); }
  if (!translated) return vars ? en.replace(/\{(\w+)\}/g, (placeholder, key: string) => key in vars ? String(vars[key]) : placeholder) : en;
  if (!vars && !(en in dictionary)) {
    // Codex joins quota windows with a middle dot; translate each complete window separately.
    if (en.includes(' · ')) {
      const parts = en.split(' · ');
      if (parts.every((part) => part in dictionary || matchServerMessage(part))) return parts.map((part) => translateMessage(part, dictionary, undefined, depth + 1)).join(' · ');
    }
    const match = matchServerMessage(en);
    if (match) return translateMessage(match.key, dictionary, match.vars, depth + 1);
  }
  const text = dictionary[en] ?? en;
  return vars ? text.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    if (!(key in vars)) return placeholder;
    const value = String(vars[key]);
    if (key === 'permissions') return value.split(', ').map((part) => translateMessage(part, dictionary, undefined, depth + 1)).join('、');
    return ['error', 'source', 'limit', 'status', 'hint', 'detail', 'duration'].includes(key) ? translateMessage(value, dictionary, undefined, depth + 1) : value;
  }) : text;
}
