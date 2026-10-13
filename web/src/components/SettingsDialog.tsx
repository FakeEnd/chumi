import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { refreshProvider, saveProfile, saveSettings } from '../actions.ts';
import { api } from '../api.ts';
import { locale, msg, plural, t, tn } from '../i18n.ts';
import { SessionTypeSelect, SessionTypesTab } from './SessionTypes.tsx';
import { sourceLabel } from '../util.ts';
import { Dialog } from './Dialog.tsx';
import { TranscriptionTab } from './TranscriptionTab.tsx';
import { AgentsTab, ProjectsTab } from './Projects.tsx';
import { MybotServerSettings } from './ProjectContext.tsx';
import { CompatibleProviderSettings } from './CompatibleProviderSettings.tsx';
import type { ProviderStatus } from '../types.ts';
import { IconBolt, IconBulb, IconFolder, IconGlobe, IconLink, IconMic, IconShield, IconSpark, IconTerminal, IconWave, IconWindow } from './icons.tsx';

/** Sections in the sidebar, grouped. */
const GROUPS = [
  { label: msg('General'), tabs: [['language', msg('Language'), IconGlobe], ['audio', msg('Audio'), IconMic], ['session-types', msg('Session types'), IconFolder], ['quick', msg('Quick start'), IconBolt], ['screen', msg('Screen'), IconWindow], ['asr', msg('Transcription'), IconWave]] },
  { label: msg('AI'), tabs: [['ai', msg('AI provider'), IconSpark], ['assist', msg('Assistance'), IconBulb]] },
  { label: msg('Projects'), tabs: [['projects', msg('Projects'), IconFolder], ['agents', msg('Coding agents'), IconTerminal], ['integrations', msg('Integrations'), IconLink]] },
  { label: msg('Data'), tabs: [['privacy', msg('Privacy & data'), IconShield]] },
] as const;
const TAB_LABEL: Record<string, string> = Object.fromEntries(GROUPS.flatMap((g) => g.tabs.map(([k, l]) => [k, l])));

function QuotaView({ p }: { p: ProviderStatus }) {
  return (
    <div className="quota">
      <div><b>{t('Billing:')}</b> {t(p.billingLabel)}</div>
      {p.account && <div><b>{t('Account:')}</b> {p.account}{p.plan ? ` (${p.plan})` : ''}</div>}
      {p.model && <div><b>{t('Model:')}</b> {p.model}</div>}
      <div className="quota-windows">
        {p.quota.windows?.map((w, i) => (
          <div key={i} className="quota-row">
            <span>{t(w.label)}</span>
            <span className="quota-bar"><span style={{ width: `${Math.min(100, w.usedPercent)}%` }} className={w.usedPercent >= 100 ? 'full' : w.usedPercent > 80 ? 'high' : ''} /></span>
            <span>{t('{n}% used', { n: Math.round(w.usedPercent) })}{w.resetsAt ? ` · ${t('resets {date}', { date: new Date(w.resetsAt).toLocaleString(locale()) })}` : ''}</span>
          </div>
        ))}
        {!p.quota.windows?.length && <div className="muted">{t(p.quota.summary)}</div>}
      </div>
      {p.quota.note && <div className={p.ready ? 'muted small' : 'warn-text small'}>{t(p.quota.note)}</div>}
      {p.message && p.message !== p.quota.note && <div className={p.ready ? 'muted small' : 'warn-text small'}>{t(p.message)}</div>}
      {p.setupHint && <div className="hint"><b>{t('Setup:')}</b> <code>{p.setupHint}</code></div>}
    </div>
  );
}

export function SettingsDialog() {
  const settings = useStore((s) => s.settings)!;
  const profile = useStore((s) => s.profile);
  const provider = useStore((s) => s.provider);
  const tab = useStore((s) => s.settingsTab);
  const hotkey = useStore((s) => s.hotkey);
  const devMode = useStore((s) => s.devMode);
  const dataDir = useStore((s) => s.dataDir);
  const systemLanguage = useStore((s) => s.systemLanguage);
  const windows = useStore((s) => s.platform) === 'win32';
  const compatibleProfile = settings.ai.compatible.profiles[settings.ai.compatible.preset];
  const [devices, setDevices] = useState<Array<{ uid: string; name: string; isDefault: boolean }>>([]);
  const [perm, setPerm] = useState<Record<string, string>>({});
  const [apiKey, setApiKey] = useState('');
  const [mybot, setMybot] = useState<{ enabled: boolean; dir: string; files: number; shareWithTeam: boolean } | null>(null);
  const [exportDir, setExportDir] = useState(settings.integrations.mybot.exportDir);
  const loadMybot = () => void api('/api/integrations/mybot').then(setMybot).catch(() => {});
  useEffect(() => {
    if (tab === 'audio') {
      void api('/api/audio/devices').then((d) => setDevices(d.devices ?? [])).catch(() => {});
      void api('/api/audio/permissions').then(setPerm).catch(() => {});
    }
    if (tab === 'ai') void refreshProvider();
    if (tab === 'integrations') loadMybot();
  }, [tab]);
  const S = saveSettings;
  const PERM: Record<string, string> = { granted: msg('granted'), denied: msg('denied'), restricted: msg('restricted'), undetermined: msg('not asked yet') };

  return (
    <Dialog title={t('Settings')} wide className="settings">
      <div className="settings-layout">
      <nav className="settings-nav" aria-label={t('Settings sections')}>
        {GROUPS.map((g) => (
          <div key={g.label} className="settings-group">
            <div className="settings-group-label">{t(g.label)}</div>
            {g.tabs.map(([k, l, Icon]) => (
              <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setState({ settingsTab: k })}><Icon width={15} height={15} />{t(l)}</button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-content" key={tab}>
      <h2 className="settings-title">{t(TAB_LABEL[tab] ?? 'Settings')}</h2>

      {tab === 'language' && (
        <section>
          <label className="field"><span>{t('Interface language')}</span>
            <select value={settings.ui.language} onChange={(e) => S({ ui: { language: e.target.value } })}>
              <option value="auto">{t('Auto: follow the system ({lang})', { lang: systemLanguage === 'zh' ? '中文' : 'English' })}</option>
              <option value="en">English</option>
              <option value="zh">中文（简体）</option>
            </select>
          </label>
          {profile && (
            <>
              <label className="field"><span>{t('AI answer language: explanations, catch-ups and summaries')}</span>
                <select value={profile.explanationLanguage} onChange={(e) => void saveProfile({ ...profile, explanationLanguage: e.target.value }, true)}>
                  <option value="Simplified Chinese">中文（简体）</option>
                  <option value="English">English</option>
                </select>
              </label>
              {profile.explanationLanguage !== 'English' && (
                <label className="field check"><input type="checkbox" checked={profile.keepEnglishTerms} onChange={(e) => void saveProfile({ ...profile, keepEnglishTerms: e.target.checked }, true)} /> {t('Keep important English technical terms in English')}</label>
              )}
            </>
          )}
          <ul className="small muted">
            <li>{t('The interface language changes the buttons and menus only. AI answers follow the AI answer language, which you can also switch in the session toolbar.')}</li>
            <li>{t('The language people speak in a meeting is set in Transcription. Mixed English and Mandarin works by default.')}</li>
          </ul>
          <label className="field check"><input type="checkbox" checked={!settings.ui.setupDismissed} onChange={(e) => void S({ ui: { setupDismissed: !e.target.checked } })} /> {t('Show the Get Chumi ready checklist on Home until everything is set up')}</label>
        </section>
      )}

      {tab === 'session-types' && <SessionTypesTab />}

      {tab === 'audio' && (
        <section>
          <label className="field"><span>{t('Default audio source')}</span>
            <select value={settings.audio.source} onChange={(e) => S({ audio: { source: e.target.value } })}>
              <option value="mic">{t('Microphone')}</option><option value="system">{t('Computer audio')}</option><option value="both">{t('Microphone + computer audio')}</option>
            </select>
          </label>
          <label className="field"><span>{t('Microphone')}</span>
            <select value={settings.audio.micDeviceUid ?? ''} onChange={(e) => S({ audio: { micDeviceUid: e.target.value || null } })}>
              <option value="">{t('System default')}</option>
              {devices.map((d) => <option key={d.uid} value={d.uid}>{d.name}{d.isDefault ? ` ${t('(default)')}` : ''}</option>)}
            </select>
          </label>
          {windows ? <p className="small muted">{t('Use headphones for hybrid meetings. Chumi filters duplicate microphone and computer-audio text.')}</p>
            : <label className="field check"><input type="checkbox" checked={settings.audio.aec} onChange={(e) => S({ audio: { aec: e.target.checked } })} /> {t('Echo cancellation on the microphone in “Both” mode (prevents duplicate text when using speakers)')}</label>}
          <label className="field check"><input type="checkbox" checked={settings.audio.saveRawAudio} onChange={(e) => S({ audio: { saveRawAudio: e.target.checked } })} /> {t('Save raw audio to disk (off by default; about 115 MB per hour per source, stored only on this computer)')}</label>
          <h3>{t('Permissions')}</h3>
          <p className="small">{tn('Microphone: {state}.', { state: <b>{perm.microphone ? t(PERM[perm.microphone] ?? perm.microphone) : '…'}</b> })} {windows ? t('Computer audio uses the current Windows output device and needs no extra recording permission.') : t('Computer audio: macOS gives apps no way to check this permission. If computer audio stays silent while something is playing, permission is missing.')}</p>
          <div className="btn-row">
            <button className="btn small" onClick={() => void api('/api/audio/request-mic', { body: {} }).then(setPerm)}>{t('Request microphone access')}</button>
            <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: 'microphone' } })}>{t('Open Microphone settings')}</button>
            {!windows && <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: 'audio-capture' } })}>{t('Open System Audio Recording settings')}</button>}
          </div>
          <p className="muted small">{windows ? t('Windows controls microphone access for desktop apps. After changing it, restart the session.') : tn('Permissions belong to Chumi.app when launched as an app, or to your terminal app when run with {cmd}. After changing a permission, end and restart the session.', { cmd: <code>npm start</code> })}</p>
        </section>
      )}

      {tab === 'quick' && (
        <section>
          <p className="small">{t('For a conversation that starts suddenly: one press starts listening at once, with an automatic title. Rename the session and set its type in the top bar afterwards.')}</p>
          <label className="field"><span>{t('Global shortcut: works from any app, even when Chumi is in the background')}</span>
            <select value={settings.quickStart.hotkey} onChange={(e) => S({ quickStart: { hotkey: e.target.value } })}>
              <option value="ctrl+opt+cmd+L">⌃⌥⌘L (Control-Option-Command-L)</option>
              <option value="opt+cmd+L">⌥⌘L (Option-Command-L)</option>
              <option value="ctrl+opt+cmd+R">⌃⌥⌘R (Control-Option-Command-R)</option>
              <option value="ctrl+shift+SPACE">⌃⇧Space (Control-Shift-Space)</option>
              <option value="off">{t('Off')}</option>
            </select>
          </label>
          <p className="small">{t('Status:')} {hotkey?.state === 'ready' ? <b className="ok-text">{t('{key} is active', { key: hotkey.shortcut })}</b> : hotkey?.state === 'off' ? t('off') : <span className="warn-text">{hotkey?.message ? t(hotkey.message) : hotkey?.state ?? t('unknown')}</span>}</p>
          <ul className="small muted">
            <li>{t("First press starts listening. Pressing again pauses, and a third press resumes. End the session in Chumi when you're done.")}</li>
            <li>{t('The shortcut needs no extra macOS permission. If another app already uses the combination, pick a different one.')}</li>
          </ul>
          <label className="field"><span>{t('Audio source for quick start')}</span>
            <select value={settings.quickStart.source} onChange={(e) => S({ quickStart: { source: e.target.value } })}>
              <option value="default">{t('Same as the default audio source ({source})', { source: sourceLabel(settings.audio.source) })}</option>
              <option value="mic">{t('Microphone: in-person conversations')}</option>
              <option value="system">{t('Computer audio: online meetings and videos')}</option>
              <option value="both">{t('Both')}</option>
            </select>
          </label>
          <label className="field"><span>{t('Session type for quick start')}</span>
            <SessionTypeSelect value={settings.quickStart.type} onChange={(type) => void S({ quickStart: { type } })} />
          </label>
          <label className="field check"><input type="checkbox" checked={settings.quickStart.notify} onChange={(e) => S({ quickStart: { notify: e.target.checked } })} /> {t('Show a system notification when the shortcut starts, pauses or resumes listening')}</label>
        </section>
      )}

      {tab === 'screen' && (
        <section>
          <p className="small">{tn('Window capture saves a picture of one chosen window (a Zoom/Teams screen share, a browser playing a lecture video, a slide deck) whenever it changes. Answers can then explain slides and figures instead of saying the visual is unavailable. Choose the window when starting a session, or with {btn} in the session toolbar.', { btn: <b>▣ {t('Capture window')}</b> })}</p>
          <label className="field check"><input type="checkbox" checked={settings.screen.sendImagesToAI} onChange={(e) => S({ screen: { sendImagesToAI: e.target.checked } })} /> {t('Send screen captures to the AI provider with questions, catch-ups and the final summary. When off, captures stay on this computer only.')}</label>
          <label className="field"><span>{t('Check the window for changes every')}</span>
            <select value={settings.screen.intervalSec} onChange={(e) => S({ screen: { intervalSec: Number(e.target.value) } })}>
              {[2, 3, 5, 10].map((x) => <option key={x} value={x}>{t('{n} seconds', { n: x })}</option>)}
            </select>
          </label>
          {!windows && <div className="btn-row">
            <button className="btn small" onClick={() => void api('/api/screen/request', { body: {} })}>{t('Ask macOS for Screen Recording permission')}</button>
            <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: 'screen' } })}>{t('Open Screen Recording settings')}</button>
          </div>}
          <ul className="small muted">
            {!windows && <li>{t('Needs Screen Recording permission for Chumi. macOS may ask you to confirm it again from time to time.')}</li>}
            <li>{t('Protected (DRM) video and minimized windows capture as black. Chumi warns you when that happens.')}</li>
            <li>{t('Only images are captured, never video. Typically one picture per slide, at about 150–300 KB each.')}</li>
            <li>{t('Image input depends on the selected provider and model. For other local or API models, enable image support in AI provider settings only if the model and endpoint accept images.')}</li>
            {settings.ai.provider === 'compatible' && !compatibleProfile.supportsImages && <li className="warn-text">{t('Your selected model is configured for text only. Screen captures will not be sent to it.')}</li>}
            <li>{t("Respect meeting norms: tell participants if you capture shared screens, and follow your institution's rules.")}</li>
          </ul>
        </section>
      )}

      {tab === 'asr' && <TranscriptionTab />}
      {tab === 'projects' && <ProjectsTab />}
      {tab === 'agents' && <AgentsTab />}

      {tab === 'ai' && (
        <section>
          <p className="small">{t('Chumi uses exactly one provider: the one you select. It never switches to another provider on its own, so a limit or outage cannot turn into a paid fallback.')}</p>
          <div className="radio-list">
            <label><input type="radio" checked={settings.ai.provider === 'codex'} onChange={() => S({ ai: { provider: 'codex' } })} /> {tn('{name} (subscription, recommended). Uses OpenAI\'s documented Codex app-server and your existing {cmd}.', { name: <b>{t('ChatGPT plan via Codex sign-in')}</b>, cmd: <code>codex login</code> })}</label>
            <label><input type="radio" checked={settings.ai.provider === 'claude-cli'} onChange={() => S({ ai: { provider: 'claude-cli' } })} /> {tn('{name} (subscription, personal use). Runs {cmd} with your own {login}.', { name: <b>{t('Claude plan via the Claude Code CLI')}</b>, cmd: <code>claude -p</code>, login: <code>claude auth login</code> })}</label>
            <label className={settings.ai.anthropicApi.enabled ? '' : 'disabled'}><input type="radio" disabled={!settings.ai.anthropicApi.enabled} checked={settings.ai.provider === 'anthropic-api'} onChange={() => S({ ai: { provider: 'anthropic-api' } })} /> {tn('{name} (paid, billed per request). Disabled until you enable it below.', { name: <b>{t('Anthropic API key')}</b> })}</label>
            <label><input type="radio" checked={settings.ai.provider === 'compatible'} onChange={() => S({ ai: { provider: 'compatible' } })} /> <b>{t('Other models: local or API')}</b> {t('Choose an available local model or configure an API.')}</label>
            {devMode && <label><input type="radio" checked={settings.ai.provider === 'mock'} onChange={() => S({ ai: { provider: 'mock' } })} /> {tn('{name}: placeholder text, not AI (developer mode).', { name: <b>{t('Offline test provider')}</b> })}</label>}
          </div>
          {settings.ai.provider === 'compatible' && <CompatibleProviderSettings />}
          {settings.ai.provider !== 'compatible' && <>
          <h3>{t('Reasoning effort')}</h3>
          <label className="field"><span>{t('For your questions, explanations, catch-ups and the final summary. You can also change it for one question in the Ask box.')}</span>
            <select value={settings.ai.effort} onChange={(e) => S({ ai: { effort: e.target.value } })}>
              <option value="auto">{t('Auto (recommended): fast for catch-ups and quick answers, medium for others')}</option>
              <option value="low">{t('Low: fastest, lightest on your plan')}</option>
              <option value="medium">{t('Medium')}</option>
              <option value="high">{t('High: more careful reasoning')}</option>
              <option value="xhigh">{t('Extra high')}</option>
              <option value="max">{t('Max: most thorough; slowest, uses the most of your plan')}</option>
            </select>
          </label>
          <label className="field"><span>{t('For automatic background work (running overview, auto-explain, notes on older parts)')}</span>
            <select value={settings.ai.backgroundEffort} onChange={(e) => S({ ai: { backgroundEffort: e.target.value } })}>
              <option value="low">{t('Low (recommended): runs often, so keep it light')}</option>
              <option value="medium">{t('Medium')}</option>
              <option value="high">{t('High: noticeably more usage over a long session')}</option>
            </select>
          </label>
          <p className="muted small">{t("Higher effort makes the model think longer before answering. Answers usually get better on hard questions, but they take longer and use more of your plan's limit. If the model doesn't support a level, Chumi uses the closest lower one it does support. Claude Haiku has no effort setting.")}</p>
          </>}
          {provider && <><h3>{t('Status: {name}', { name: t(provider.label) })} <button className="btn small" onClick={() => void refreshProvider()}>{t('Refresh')}</button></h3><QuotaView p={provider} /></>}
          {windows && settings.ai.provider === 'codex' && provider?.state === 'signed_out' && <div className="btn-row">
            <button className="btn primary" onClick={() => void api('/api/provider/codex/login', { body: {} })}>{t('Sign in with ChatGPT')}</button>
            <span className="muted small">{t('Sign-in opens in your browser. Return here when it is complete.')}</span>
          </div>}
          {settings.ai.provider === 'codex' && (
            <>
              {provider?.models?.length ? (
                <label className="field"><span>{t('Model')}</span>
                  <select value={settings.ai.codex.model ?? ''} onChange={(e) => S({ ai: { codex: { model: e.target.value || null } } })}>
                    <option value="">{t('Plan default')}</option>{provider.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
              ) : null}
              <label className="field check warn-box"><input type="checkbox" checked={settings.ai.codex.allowCredits} onChange={(e) => { if (!e.target.checked || confirm(t('Allow Chumi to keep working by spending purchased ChatGPT credits after your plan’s included usage runs out? This can cost money.'))) void S({ ai: { codex: { allowCredits: e.target.checked } } }); }} /> {t('Allow spending purchased ChatGPT credits when included plan usage is exhausted (off by default)')}</label>
            </>
          )}
          {settings.ai.provider === 'claude-cli' && (
            <label className="field"><span>{t('Claude model alias')}</span>
              <select value={settings.ai.claudeCli.model} onChange={(e) => S({ ai: { claudeCli: { model: e.target.value } } })}>
                <option value="sonnet">sonnet</option><option value="opus">opus</option><option value="haiku">haiku</option>
              </select>
            </label>
          )}
          <h3>{t('Paid API access (optional)')}</h3>
          <label className="field check"><input type="checkbox" checked={settings.ai.anthropicApi.enabled} onChange={(e) => { if (!e.target.checked || confirm(t('Enable paid Anthropic API access? Requests made with this provider are billed per token to your API account.'))) void S({ ai: { anthropicApi: { enabled: e.target.checked }, ...(e.target.checked ? {} : { provider: settings.ai.provider === 'anthropic-api' ? 'codex' : settings.ai.provider }) } }); }} /> {t('Enable the Anthropic API key provider (billed per request)')}</label>
          {settings.ai.anthropicApi.enabled && (
            <div className="field-row">
              <input type="password" placeholder={windows ? t('sk-ant-… (encrypted for your Windows account)') : t('sk-ant-… (stored in macOS Keychain)')} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
              <button className="btn small" onClick={() => void api('/api/provider/anthropic-key', { body: { key: apiKey } }).then(() => setApiKey(''))}>{t('Save key')}</button>
              <button className="btn small" onClick={() => void api('/api/provider/anthropic-key', { method: 'DELETE' })}>{t('Remove key')}</button>
            </div>
          )}
        </section>
      )}

      {tab === 'assist' && (
        <section>
          <label className="field check"><input type="checkbox" checked={settings.assist.autoExplain} onChange={(e) => S({ assist: { autoExplain: e.target.checked } })} /> {t('Auto-explain background (unsolicited cards for unfamiliar concepts)')}</label>
          <label className="field"><span>{t('Auto-explain frequency: how often cards may appear. It does not affect how detailed they are.')}</span>
            <select value={settings.assist.autoExplainFrequency} onChange={(e) => S({ assist: { autoExplainFrequency: e.target.value } })}>
              <option value="low">{t('Low: at most 2 cards per 10 min, checks every 3 min')}</option>
              <option value="medium">{t('Medium: at most 4 cards per 10 min, checks every 90 s')}</option>
              <option value="high">{t('High: at most 6 cards per 10 min, checks every 45 s')}</option>
            </select>
          </label>
          <label className="field"><span>{t('Default explanation depth')}</span>
            <select value={settings.assist.defaultDepth} onChange={(e) => S({ assist: { defaultDepth: e.target.value } })}>
              <option value="quick">{t('Quick: definition, intuition, why it matters')}</option>
              <option value="standard">{t('Standard: mechanism, assumptions, example')}</option>
              <option value="deep">{t('Deep: technical detail, equations/statistics, limitations')}</option>
            </select>
          </label>
          <label className="field check"><input type="checkbox" checked={settings.assist.autoOverview} onChange={(e) => S({ assist: { autoOverview: e.target.checked } })} /> {t('Keep the running overview updated automatically at pauses and topic changes')}</label>
          <label className="field check"><input type="checkbox" checked={settings.devMode} onChange={(e) => S({ devMode: e.target.checked })} /> {t('Developer mode (audio-file test source, offline test provider)')}</label>
        </section>
      )}

      {tab === 'integrations' && (
        <section>
          <h3>{t('mybot: searchable memory across meetings and agent sessions')}</h3>
          <p className="small">{tn('{link} indexes your Claude Code and Codex conversations into one local, searchable memory. With this on, Chumi also exports your finished meetings, so mybot can answer questions like “what did my advisor say about the holdout split?” with the date and a link to the moment.', { link: <a href="https://github.com/jzhoulab/mybot" target="_blank" rel="noreferrer">mybot</a> })}</p>
          <label className="field check"><input type="checkbox" checked={settings.integrations.mybot.enabled} onChange={(e) => void S({ integrations: { mybot: { enabled: e.target.checked } } }).then(loadMybot)} /> {t("Export finished sessions for mybot (transcript, summary, and your questions with Chumi's answers)")}</label>
          <label className="field"><span>{tn("Export folder (mybot's {src} source reads this)", { src: <code>chumi</code> })}</span>
            <div className="field-row" style={{ marginBottom: 0 }}>
              <input value={exportDir} onChange={(e) => setExportDir(e.target.value)} />
              <button className="btn small" disabled={exportDir === settings.integrations.mybot.exportDir} onClick={() => void S({ integrations: { mybot: { exportDir } } }).then(loadMybot)}>{t('Save')}</button>
            </div>
          </label>
          <label className="field check warn-box"><input type="checkbox" checked={settings.integrations.mybot.shareWithTeam} onChange={(e) => { if (!e.target.checked || confirm(t("Let mybot use your meeting transcripts when answering teammates? Meetings contain other people's words, so only do this if everyone is comfortable with it."))) void S({ integrations: { mybot: { shareWithTeam: e.target.checked } } }).then(loadMybot); }} /> {tn('Let mybot share meeting content with teammates (off: meetings are owner-only, marked {tag})', { tag: <code>visibility: private</code> })}</label>
          <div className="btn-row">
            <button className="btn small" onClick={() => void api('/api/integrations/mybot/export-all', { body: {} }).then(loadMybot)}>{t('Export all sessions now')}</button>
            {mybot && <span className="muted small">{tn('{count} in {dir}', { count: plural(mybot.files, '{n} session file', '{n} session files'), dir: <code>{mybot.dir}</code> })}</span>}
          </div>
          <p className="muted small">{tn("One-time mybot setup: run {cmd} from the Chumi folder, add {src} to {var} in mybot's {env}, then restart mybot. Details: docs/mybot.md.", { cmd: <code>bash integrations/mybot/install.sh ~/Code/mybot</code>, src: <code>chumi</code>, var: <code>TRAJECTORY_SOURCES</code>, env: <code>.env</code> })}</p>
          <MybotServerSettings />
        </section>
      )}

      {tab === 'privacy' && (
        <section className="prose small">
          <h3>{t('What stays on this computer')}</h3>
          <ul>
            <li>{t('Audio is captured and transcribed locally by whisper.cpp. Audio is never uploaded.')}</li>
            <li>{tn('Sessions, transcripts, AI answers, your profile and settings live in a local SQLite database: {dir}.', { dir: <code>{dataDir}</code> })}</li>
            <li>{t('Raw audio is retained only when “Save raw audio” is on. Optional speaker labeling also writes temporary local audio, which is deleted after analysis, failure or cancellation unless raw audio retention is enabled.')}</li>
            <li>{t('Window captures (if you choose a window) are stored as JPEG images in the same folder.')}</li>
            <li>{t('If you enable the mybot integration, finished sessions are also written as JSONL files to the export folder you choose. They stay on this computer.')}</li>
            <li>{windows ? t('Credentials: Codex and Claude Code manage their own sign-in. API keys are encrypted for your Windows account.') : t('Credentials: Codex and Claude Code keep their own sign-in and Chumi never reads it. An optional API key is stored in the macOS Keychain.')}</li>
          </ul>
          <h3>{t('What is sent to the AI provider')}</h3>
          <ul>
            <li>{t('Only when you ask a question, request a catch-up or summary, or have auto-overview or auto-explain turned on.')}</li>
            <li>{t('Each request contains transcript excerpts: recent lines, your selected passage, a few keyword-matched earlier lines, and short AI-written notes on older parts. It also contains your knowledge profile and your question.')}</li>
            <li>{t('Speaker labels and names you enter accompany transcript excerpts used in new answers, summaries and handoffs. Speaker audio analysis stays on this computer.')}</li>
            <li>{t('If you capture a window, “Send screen captures” is on, and your model supports images, up to 2 recent captures go with questions and catch-ups, and up to 6 with the final summary. Overview and auto-explain never send images.')}</li>
            <li>{t('Long sessions are summarized into rolling notes, so the full transcript is not sent again with every request.')}</li>
            <li>{t('Requests go to the provider you select: OpenAI, Anthropic, or your configured model server. Remote services process them under your provider account’s terms. A local server may itself forward requests externally; check its routing settings.')}</li>
          </ul>
          <p>{t('Turn off auto-overview and auto-explain if you want nothing sent unless you click something.')}</p>
        </section>
      )}
      </div>
      </div>
    </Dialog>
  );
}
