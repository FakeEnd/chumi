export const SHUTDOWN_GRACE_MS = 15_000;

interface ShutdownStep { name: string; timeoutMs: number; run(): void | Promise<void> }

/** A stalled worker must not prevent the other services from being closed before the shell exits. */
export async function finishShutdown(
  steps: ShutdownStep[], budgetMs: number,
  report: (name: string, error: Error) => void,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (const step of steps) {
    const remaining = Math.min(step.timeoutMs, deadline - Date.now());
    if (remaining <= 0) { report(step.name, new Error('Shutdown deadline reached.')); break; }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Shutdown step timed out.')), remaining);
        }),
      ]);
    } catch (error) { report(step.name, error instanceof Error ? error : new Error(String(error))); }
    finally { clearTimeout(timer); }
  }
}
