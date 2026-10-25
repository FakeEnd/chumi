import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './styles.css';
import { startShellBridge } from './shell.ts';

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
startShellBridge();
