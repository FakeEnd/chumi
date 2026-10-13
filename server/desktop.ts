import { randomUUID } from 'node:crypto';

export const DESKTOP = process.env.CHUMI_DESKTOP === 'electron' && !!process.send;

/** Private parent/child IPC. The React page cannot invoke Electron APIs directly. */
export function desktopRequest<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!DESKTOP) return Promise.reject(new Error('The desktop app is not connected.'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const onMessage = (message: any) => {
      if (message?.type !== 'desktop-result' || message.id !== id) return;
      clearTimeout(timer); process.off('message', onMessage);
      if (message.error) reject(new Error(message.error)); else resolve(message.value as T);
    };
    const timer = setTimeout(() => { process.off('message', onMessage); reject(new Error('The desktop request timed out.')); }, action === 'choose-folder' ? 600_000 : 30_000);
    process.on('message', onMessage);
    process.send!({ type: 'desktop-request', id, action, payload });
  });
}
