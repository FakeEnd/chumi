import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { refreshProvider, saveSettings } from '../actions.ts';
import { api } from '../api.ts';
import { Dialog } from './Dialog.tsx';
import type { ProviderStatus } from '../types.ts';

const TABS = [['audio', 'Audio'], ['quick', 'Quick start'], ['screen', 'Screen'], ['asr', 'Transcription'], ['ai', 'AI provider'], ['assist', 'Assistance'], ['privacy', 'Privacy & data']] as const;

function QuotaView({ p }: { p: ProviderStatus }) {
  return (
    <div className="quota">
      <div><b>Billing:</b> {p.billingLabel}</div>
      {p.account && <div><b>Account:</b> {p.account}{p.plan ? ` (${p.plan})` : ''}</div>}
      {p.model && <div><b>Model:</b> {p.model}</div>}
      <div className="quota-windows">
        {p.quota.windows?.map((w, i) => (
          <div key={i} className="quota-row">
            <span>{w.label}</span>
            <span className="quota-bar"><span style={{ width: `${Math.min(100, w.usedPercent)}%` }} className={w.usedPercent >= 100 ? 'full' : w.usedPercent > 80 ? 'high' : ''} /></span>
            <span>{Math.round(w.usedPercent)}% used{w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString()}` : ''}</span>
          </div>
        ))}
        {!p.quota.windows?.length && <div className="muted">{p.quota.summary}</div>}
      </div>
      {p.quota.note && <div className={p.ready ? 'muted small' : 'warn-text small'}>{p.quota.note}</div>}
      {p.message && p.message !== p.quota.note && <div className={p.ready ? 'muted small' : 'warn-text small'}>{p.message}</div>}
      {p.setupHint && <div className="hint"><b>Setup:</b> <code>{p.setupHint}</code></div>}
    </div>
  );
}

export function SettingsDialog() {
  const settings = useStore((s) => s.settings)!;
  const provider = useStore((s) => s.provider);
  const tab = useStore((s) => s.settingsTab);
  const hotkey = useStore((s) => s.hotkey);
  const devMode = useStore((s) => s.devMode);
  const dataDir = useStore((s) => s.dataDir);
  const [devices, setDevices] = useState<Array<{ uid: string; name: string; isDefault: boolean }>>([]);
  const [perm, setPerm] = useState<Record<string, string>>({});
  const [glossary, setGlossary] = useState(settings.asr.glossary.join(', '));
  const [apiKey, setApiKey] = useState('');
  useEffect(() => {
    if (tab === 'audio') {
      void api('/api/audio/devices').then((d) => setDevices(d.devices ?? [])).catch(() => {});
      void api('/api/audio/permissions').then(setPerm).catch(() => {});
    }
    if (tab === 'ai') void refreshProvider();
  }, [tab]);
  const S = saveSettings;

  return (
    <Dialog title="Settings" wide>
      <nav className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setState({ settingsTab: k })}>{l}</button>)}</nav>

      {tab === 'audio' && (
        <section>
          <label className="field"><span>Default audio source</span>
            <select value={settings.audio.source} onChange={(e) => S({ audio: { source: e.target.value } })}>
              <option value="mic">Microphone</option><option value="system">Computer audio</option><option value="both">Microphone + computer audio</option>
            </select>
          </label>
          <label className="field"><span>Microphone</span>
            <select value={settings.audio.micDeviceUid ?? ''} onChange={(e) => S({ audio: { micDeviceUid: e.target.value || null } })}>
              <option value="">System default</option>
              {devices.map((d) => <option key={d.uid} value={d.uid}>{d.name}{d.isDefault ? ' (default)' : ''}</option>)}
            </select>
          </label>
          <label className="field check"><input type="checkbox" checked={settings.audio.aec} onChange={(e) => S({ audio: { aec: e.target.checked } })} /> Echo cancellation on the microphone in “Both” mode (prevents duplicate text when using speakers)</label>
          <label className="field check"><input type="checkbox" checked={settings.audio.saveRawAudio} onChange={(e) => S({ audio: { saveRawAudio: e.target.checked } })} /> Save raw audio to disk (off by default; about 115 MB per hour per source, stored only on this Mac)</label>
          <h3>Permissions</h3>
          <p className="small">Microphone: <b>{perm.microphone ?? '…'}</b>. Computer audio: macOS gives apps no way to check this permission. If computer audio stays silent while something is playing, permission is missing.</p>
          <div className="btn-row">
            <button className="btn small" onClick={() => void api('/api/audio/request-mic', { body: {} }).then(setPerm)}>Request microphone access</button>
            <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: 'microphone' } })}>Open Microphone settings</button>
            <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: 'audio-capture' } })}>Open System Audio Recording settings</button>
          </div>
          <p className="muted small">Permissions belong to Chumi.app when launched as an app, or to your terminal app when run with <code>npm start</code>. After changing a permission, end and restart the session.</p>
        </section>
      )}

      {tab === 'quick' && (
        <section>
          <p className="small">For a conversation that starts suddenly: one press starts listening at once, with an automatic title. Rename the session and set its type in the top bar afterwards.</p>
          <label className="field"><span>Global shortcut: works from any app, even when Chumi is in the background</span>
            <select value={settings.quickStart.hotkey} onChange={(e) => S({ quickStart: { hotkey: e.target.value } })}>
              <option value="ctrl+opt+cmd+L">⌃⌥⌘L (Control-Option-Command-L)</option>
              <option value="opt+cmd+L">⌥⌘L (Option-Command-L)</option>
              <option value="ctrl+opt+cmd+R">⌃⌥⌘R (Control-Option-Command-R)</option>
              <option value="ctrl+shift+SPACE">⌃⇧Space (Control-Shift-Space)</option>
              <option value="off">Off</option>
            </select>
          </label>
          <p className="small">Status: {hotkey?.state === 'ready' ? <b className="ok-text">{hotkey.shortcut} is active</b> : hotkey?.state === 'off' ? 'off' : <span className="warn-text">{hotkey?.message ?? hotkey?.state ?? 'unknown'}</span>}</p>
          <ul className="small muted">
            <li>First press starts listening. Pressing again pauses, and a third press resumes. End the session in Chumi when you're done.</li>
            <li>The shortcut needs no extra macOS permission. If another app already uses the combination, pick a different one.</li>
          </ul>
          <label className="field"><span>Audio source for quick start</span>
            <select value={settings.quickStart.source} onChange={(e) => S({ quickStart: { source: e.target.value } })}>
              <option value="default">Same as the default audio source ({settings.audio.source === 'mic' ? 'Microphone' : settings.audio.source === 'system' ? 'Computer audio' : 'Both'})</option>
              <option value="mic">Microphone: in-person conversations</option>
              <option value="system">Computer audio: online meetings and videos</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label className="field"><span>Session type for quick start</span>
            <select value={settings.quickStart.type} onChange={(e) => S({ quickStart: { type: e.target.value } })}>
              <option value="other">Other / general</option><option value="lab_meeting">Lab meeting</option><option value="advisor">Advisor 1:1</option><option value="lecture">Lecture</option><option value="wip">WIP / seminar</option>
            </select>
          </label>
          <label className="field check"><input type="checkbox" checked={settings.quickStart.notify} onChange={(e) => S({ quickStart: { notify: e.target.checked } })} /> Show a macOS notification when the shortcut starts, pauses or resumes listening</label>
        </section>
      )}

      {tab === 'screen' && (
        <section>
          <p className="small">Window capture saves a picture of one chosen window (a Zoom/Teams screen share, a browser playing a lecture video, a slide deck) whenever it changes. Answers can then explain slides and figures instead of saying the visual is unavailable. Choose the window when starting a session, or with <b>▣ Capture window</b> in the top bar.</p>
          <label className="field check"><input type="checkbox" checked={settings.screen.sendImagesToAI} onChange={(e) => S({ screen: { sendImagesToAI: e.target.checked } })} /> Send screen captures to the AI provider with questions, catch-ups and the final summary. When off, captures stay on this Mac only.</label>
          <label className="field"><span>Check the window for changes every</span>
            <select value={settings.screen.intervalSec} onChange={(e) => S({ screen: { intervalSec: Number(e.target.value) } })}>
              {[2, 3, 5, 10].map((x) => <option key={x} value={x}>{x} seconds</option>)}
            </select>
          </label>
          <div className="btn-row">
            <button className="btn small" onClick={() => void api('/api/screen/request', { body: {} })}>Ask macOS for Screen Recording permission</button>
            <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: 'screen' } })}>Open Screen Recording settings</button>
          </div>
          <ul className="small muted">
            <li>Needs Screen Recording permission for Chumi. macOS may ask you to confirm it again from time to time.</li>
            <li>Protected (DRM) video and minimized windows capture as black. Chumi warns you when that happens.</li>
            <li>Only images are captured, never video. Typically one picture per slide, at about 150–300 KB each.</li>
            <li>All three providers can receive images: ChatGPT via Codex, Claude via Claude Code, and the Anthropic API.</li>
            <li>Respect meeting norms: tell participants if you capture shared screens, and follow your institution's rules.</li>
          </ul>
        </section>
      )}

      {tab === 'asr' && (
        <section>
          <p className="small">Speech recognition runs locally with whisper.cpp (<code>{settings.asr.model}</code>). It is free, needs no network, and keeps running when the AI provider is unavailable.</p>
          <label className="field"><span>Spoken language</span>
            <select value={settings.asr.language} onChange={(e) => S({ asr: { language: e.target.value } })}>
              <option value="auto">Auto: English, Mandarin and mixed (recommended)</option><option value="en">English only</option><option value="zh">Mandarin only (English terms kept)</option>
            </select>
          </label>
          <label className="field"><span>Chinese characters</span>
            <select value={settings.asr.chineseScript} onChange={(e) => S({ asr: { chineseScript: e.target.value } })}>
              <option value="simplified">Convert to Simplified</option><option value="original">Keep Whisper's output</option>
            </select>
          </label>
          <label className="field"><span>Vocabulary hints (comma separated): improves spelling of technical terms and names</span>
            <textarea rows={3} value={glossary} onChange={(e) => setGlossary(e.target.value)} onBlur={() => S({ asr: { glossary: glossary.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean) } })} />
          </label>
          <label className="field"><span>CPU threads</span><input type="number" min={2} max={16} value={settings.asr.threads} onChange={(e) => S({ asr: { threads: Number(e.target.value) } })} /></label>
        </section>
      )}

      {tab === 'ai' && (
        <section>
          <p className="small">Chumi uses exactly one provider: the one you select. It never switches to another provider on its own, so a limit or outage cannot turn into a paid fallback.</p>
          <div className="radio-list">
            <label><input type="radio" checked={settings.ai.provider === 'codex'} onChange={() => S({ ai: { provider: 'codex' } })} /> <b>ChatGPT plan via Codex sign-in</b> (subscription, recommended). Uses OpenAI's documented Codex app-server and your existing <code>codex login</code>.</label>
            <label><input type="radio" checked={settings.ai.provider === 'claude-cli'} onChange={() => S({ ai: { provider: 'claude-cli' } })} /> <b>Claude plan via the Claude Code CLI</b> (subscription, personal use). Runs <code>claude -p</code> with your own <code>claude auth login</code>.</label>
            <label className={settings.ai.anthropicApi.enabled ? '' : 'disabled'}><input type="radio" disabled={!settings.ai.anthropicApi.enabled} checked={settings.ai.provider === 'anthropic-api'} onChange={() => S({ ai: { provider: 'anthropic-api' } })} /> <b>Anthropic API key</b> (paid, billed per request). Disabled until you enable it below.</label>
            {devMode && <label><input type="radio" checked={settings.ai.provider === 'mock'} onChange={() => S({ ai: { provider: 'mock' } })} /> <b>Offline test provider</b>: placeholder text, not AI (developer mode).</label>}
          </div>
          <h3>Reasoning effort</h3>
          <label className="field"><span>For your questions, explanations, catch-ups and the final summary. You can also change it for one question in the Ask box.</span>
            <select value={settings.ai.effort} onChange={(e) => S({ ai: { effort: e.target.value } })}>
              <option value="auto">Auto (recommended): fast for catch-ups and quick answers, medium for others</option>
              <option value="low">Low: fastest, lightest on your plan</option>
              <option value="medium">Medium</option>
              <option value="high">High: more careful reasoning</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Max: most thorough; slowest, uses the most of your plan</option>
            </select>
          </label>
          <label className="field"><span>For automatic background work (running overview, auto-explain, notes on older parts)</span>
            <select value={settings.ai.backgroundEffort} onChange={(e) => S({ ai: { backgroundEffort: e.target.value } })}>
              <option value="low">Low (recommended): runs often, so keep it light</option>
              <option value="medium">Medium</option>
              <option value="high">High: noticeably more usage over a long session</option>
            </select>
          </label>
          <p className="muted small">Higher effort makes the model think longer before answering. Answers usually get better on hard questions, but they take longer and use more of your plan's limit. If the model doesn't support a level, Chumi uses the closest lower one it does support; Claude Haiku has no effort setting.</p>
          {provider && <><h3>Status: {provider.label} <button className="btn small" onClick={() => void refreshProvider()}>Refresh</button></h3><QuotaView p={provider} /></>}
          {settings.ai.provider === 'codex' && (
            <>
              {provider?.models?.length ? (
                <label className="field"><span>Model</span>
                  <select value={settings.ai.codex.model ?? ''} onChange={(e) => S({ ai: { codex: { model: e.target.value || null } } })}>
                    <option value="">Plan default</option>{provider.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
              ) : null}
              <label className="field check warn-box"><input type="checkbox" checked={settings.ai.codex.allowCredits} onChange={(e) => { if (!e.target.checked || confirm('Allow Chumi to keep working by spending purchased ChatGPT credits after your plan’s included usage runs out? This can cost money.')) void S({ ai: { codex: { allowCredits: e.target.checked } } }); }} /> Allow spending purchased ChatGPT credits when included plan usage is exhausted (off by default)</label>
            </>
          )}
          {settings.ai.provider === 'claude-cli' && (
            <label className="field"><span>Claude model alias</span>
              <select value={settings.ai.claudeCli.model} onChange={(e) => S({ ai: { claudeCli: { model: e.target.value } } })}>
                <option value="sonnet">sonnet</option><option value="opus">opus</option><option value="haiku">haiku</option>
              </select>
            </label>
          )}
          <h3>Paid API access (optional)</h3>
          <label className="field check"><input type="checkbox" checked={settings.ai.anthropicApi.enabled} onChange={(e) => { if (!e.target.checked || confirm('Enable paid Anthropic API access? Requests made with this provider are billed per token to your API account.')) void S({ ai: { anthropicApi: { enabled: e.target.checked }, ...(e.target.checked ? {} : { provider: settings.ai.provider === 'anthropic-api' ? 'codex' : settings.ai.provider }) } }); }} /> Enable the Anthropic API key provider (billed per request)</label>
          {settings.ai.anthropicApi.enabled && (
            <div className="field-row">
              <input type="password" placeholder="sk-ant-… (stored in macOS Keychain)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
              <button className="btn small" onClick={() => void api('/api/provider/anthropic-key', { body: { key: apiKey } }).then(() => setApiKey(''))}>Save key</button>
              <button className="btn small" onClick={() => void api('/api/provider/anthropic-key', { method: 'DELETE' })}>Remove key</button>
            </div>
          )}
        </section>
      )}

      {tab === 'assist' && (
        <section>
          <label className="field check"><input type="checkbox" checked={settings.assist.autoExplain} onChange={(e) => S({ assist: { autoExplain: e.target.checked } })} /> Auto-explain background (unsolicited cards for unfamiliar concepts)</label>
          <label className="field"><span>Auto-explain frequency: how often cards may appear. It does not affect how detailed they are.</span>
            <select value={settings.assist.autoExplainFrequency} onChange={(e) => S({ assist: { autoExplainFrequency: e.target.value } })}>
              <option value="low">Low: at most 2 cards per 10 min, checks every 3 min</option>
              <option value="medium">Medium: at most 4 cards per 10 min, checks every 90 s</option>
              <option value="high">High: at most 6 cards per 10 min, checks every 45 s</option>
            </select>
          </label>
          <label className="field"><span>Default explanation depth</span>
            <select value={settings.assist.defaultDepth} onChange={(e) => S({ assist: { defaultDepth: e.target.value } })}>
              <option value="quick">Quick: definition, intuition, why it matters</option>
              <option value="standard">Standard: mechanism, assumptions, example</option>
              <option value="deep">Deep: technical detail, equations/statistics, limitations</option>
            </select>
          </label>
          <label className="field check"><input type="checkbox" checked={settings.assist.autoOverview} onChange={(e) => S({ assist: { autoOverview: e.target.checked } })} /> Keep the running overview updated automatically at pauses and topic changes</label>
          <label className="field check"><input type="checkbox" checked={settings.devMode} onChange={(e) => S({ devMode: e.target.checked })} /> Developer mode (audio-file test source, offline test provider)</label>
        </section>
      )}

      {tab === 'privacy' && (
        <section className="prose small">
          <h3>What stays on this Mac</h3>
          <ul>
            <li>Audio is captured and transcribed locally by whisper.cpp. Audio is never uploaded.</li>
            <li>Sessions, transcripts, AI answers, your profile and settings live in a local SQLite database: <code>{dataDir}</code>.</li>
            <li>Raw audio is written to disk only if you turn on “Save raw audio”.</li>
            <li>Window captures (if you choose a window) are stored as JPEG images in the same folder.</li>
            <li>Credentials: Codex and Claude Code keep their own sign-in and Chumi never reads it. An optional API key is stored in the macOS Keychain.</li>
          </ul>
          <h3>What is sent to the AI provider</h3>
          <ul>
            <li>Only when you ask a question, request a catch-up or summary, or have auto-overview or auto-explain turned on.</li>
            <li>Each request contains transcript excerpts: recent lines, your selected passage, a few keyword-matched earlier lines, and short AI-written notes on older parts. It also contains your knowledge profile and your question.</li>
            <li>If you capture a window and “Send screen captures” is on, up to 2 recent captures go with questions and catch-ups, and up to 6 with the final summary. Overview and auto-explain never send images.</li>
            <li>Long sessions are summarized into rolling notes, so the full transcript is not sent again with every request.</li>
            <li>The selected provider processes requests under your account's terms: OpenAI for the ChatGPT plan, Anthropic for the Claude plan or API.</li>
          </ul>
          <p>Turn off auto-overview and auto-explain if you want nothing sent unless you click something.</p>
        </section>
      )}
    </Dialog>
  );
}
