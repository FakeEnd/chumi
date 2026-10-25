import { useEffect } from 'react';
import { getState, useStore } from './store.ts';
import { connectEvents, setCompact } from './actions.ts';
import { isCompactShortcut } from './compactMode.ts';
import { CompactBar, SessionToolbar, TopBar } from './components/TopBar.tsx';
import { Home } from './components/Home.tsx';
import { Transcript } from './components/Transcript.tsx';
import { Overview } from './components/Overview.tsx';
import { AssistantPanel } from './components/Assistant.tsx';
import { StartDialog } from './components/StartDialog.tsx';
import { ProfileDialog } from './components/ProfileDialog.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { HistoryDialog } from './components/HistoryDialog.tsx';
import { Notices } from './components/Notices.tsx';
import { FrameViewer, SlideStrip, WindowDialog } from './components/Slides.tsx';
import { HandoffDialog } from './components/Handoff.tsx';
import { SessionColumns } from './components/SessionColumns.tsx';
import { resolveLang, setLang, t } from './i18n.ts';

export function App() {
  const loaded = useStore((s) => s.loaded);
  const dialog = useStore((s) => s.dialog);
  const data = useStore((s) => s.data);
  const pref = useStore((s) => s.settings?.ui?.language);
  const system = useStore((s) => s.systemLanguage);
  const compact = useStore((s) => s.compact) && !!data;
  const lang = resolveLang(pref, system);
  setLang(lang); // before children render; the key below re-renders everything when it changes
  useEffect(() => connectEvents(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isCompactShortcut(e) || !getState().data) return;
      e.preventDefault();
      setCompact(!getState().compact);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!loaded) return <div className="boot">{t('Connecting to Chumi…')}</div>;
  return (
    <div className={`app ${compact ? 'compact' : ''}`} key={lang}>
      {compact ? <CompactBar /> : <TopBar />}
      <Notices />
      {data ? (
        <>
          <SessionToolbar hidden={compact} />
          <SessionColumns
            left={
              <section className="left">
                <Overview />
                <SlideStrip />
                <Transcript />
              </section>
            }
            right={<AssistantPanel />}
          />
        </>
      ) : <main className="home-wrap"><Home /></main>}
      {dialog === 'start' && <StartDialog />}
      {dialog === 'profile' && <ProfileDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'history' && <HistoryDialog />}
      {dialog === 'window' && <WindowDialog />}
      {dialog === 'frame' && <FrameViewer />}
      {dialog === 'handoff' && <HandoffDialog />}
    </div>
  );
}
