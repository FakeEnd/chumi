import { useEffect } from 'react';
import { useStore } from './store.ts';
import { connectEvents } from './actions.ts';
import { TopBar } from './components/TopBar.tsx';
import { Transcript } from './components/Transcript.tsx';
import { Overview } from './components/Overview.tsx';
import { AssistantPanel } from './components/Assistant.tsx';
import { StartDialog } from './components/StartDialog.tsx';
import { ProfileDialog } from './components/ProfileDialog.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { HistoryDialog } from './components/HistoryDialog.tsx';
import { Notices } from './components/Notices.tsx';
import { FrameViewer, SlideStrip, WindowDialog } from './components/Slides.tsx';
import { fmtDate, fmtT } from './util.ts';
import { openSession } from './actions.ts';

function SavedBanner() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  if (!data || live?.session?.id === data.session.id) return null;
  const s = data.session;
  return (
    <div className="saved-banner">
      Viewing saved session · {fmtDate(s.started_at ?? s.created_at)} · {fmtT(s.duration_ms)}{s.status === 'interrupted' ? ' · recording was interrupted (see gap markers)' : ''}
      {live?.session && <button className="btn small" onClick={() => void openSession(live.session!.id)}>Back to live session</button>}
    </div>
  );
}

export function App() {
  const loaded = useStore((s) => s.loaded);
  const dialog = useStore((s) => s.dialog);
  useEffect(() => connectEvents(), []);
  if (!loaded) return <div className="boot">Connecting to Chumi…</div>;
  return (
    <div className="app">
      <TopBar />
      <Notices />
      <SavedBanner />
      <main className="main">
        <section className="left">
          <Overview />
          <SlideStrip />
          <Transcript />
        </section>
        <AssistantPanel />
      </main>
      {dialog === 'start' && <StartDialog />}
      {dialog === 'profile' && <ProfileDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'history' && <HistoryDialog />}
      {dialog === 'window' && <WindowDialog />}
      {dialog === 'frame' && <FrameViewer />}
    </div>
  );
}
