import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { DATA_DIR } from '../paths.ts';
import { openExternalUrl } from '../platform.ts';

interface DesktopHandoffDependencies {
  dataDir: string;
  openUrl: (url: string) => Promise<void>;
}

/**
 * Prepare a new Codex desktop conversation. The registered URL handler only prefills its composer:
 * the user still sends the message. Resolving means the OS accepted the open request, not that
 * Codex read the handoff or started a task. No CLI or MCP registration is required.
 */
export async function launchCodexDesktop(
  handoffId: string,
  workspace: string,
  prompt: string,
  dependencies: Partial<DesktopHandoffDependencies> = {},
): Promise<{ url: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(handoffId)) throw new Error('Invalid handoff ID.');
  if (!isAbsolute(workspace)) throw new Error('Choose an absolute project folder in Projects before opening Codex.');
  let available = false;
  try { available = (await stat(workspace)).isDirectory(); } catch { /* missing or inaccessible */ }
  if (!available) throw new Error(`The project folder is not available: ${workspace}. Choose its new location in Projects.`);
  if (!prompt.trim()) throw new Error('The handoff is empty. Generate and confirm it before opening Codex.');

  const dir = resolve(dependencies.dataDir ?? DATA_DIR, 'handoffs');
  // A composer may stay unsent while the handoff changes or moves to another project. Its file
  // must remain the same snapshot, especially because its project directory is already fixed.
  const file = join(dir, `${handoffId}-codex-app-${randomUUID()}.md`);
  const temporary = join(dir, `.${handoffId}-${randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Publish only a complete snapshot. A fresh exclusive file also avoids following an existing
    // destination symlink or retaining its mode.
    await writeFile(temporary, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (cause) {
    throw new Error('Chumi could not save the handoff for Codex. Choose “Copy instructions” to continue.', { cause });
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }

  // Keep large transcripts and instructions out of the URL; only pass an absolute path to the saved text.
  const prefill = `Read the UTF-8 Chumi handoff file at ${JSON.stringify(file)} (handoff ${handoffId}).\n`
    + 'Review the project, then propose a plan and wait for my go-ahead before changing files. '
    + 'Use the response language requested in the handoff.';
  const link = new URL('codex://new');
  link.searchParams.set('path', workspace);
  link.searchParams.set('prompt', prefill);
  const url = link.toString();
  try {
    await (dependencies.openUrl ?? openExternalUrl)(url);
  } catch (cause) {
    throw new Error('Could not open the Codex desktop app. Install or open Codex, then try again, or choose “Copy instructions”.', { cause });
  }
  return { url };
}
