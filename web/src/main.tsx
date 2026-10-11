import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { startShellBridge } from './shell.ts';

createRoot(document.getElementById('root')!).render(<App />);
startShellBridge();
