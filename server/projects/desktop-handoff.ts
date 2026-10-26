import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { DATA_DIR } from '../paths.ts';
import { copyText, openExternalUrl } from '../platform.ts';
import { openDeepSeekHarness } from './dsh.ts';

interface DesktopHandoffDependencies {
  dataDir: string;
  openUrl: (url: string) => Promise<void>;
}

/** The checks both desktop destinations share before anything is saved or opened. */
async function checkHandoff(handoffId: string, workspace: string, prompt: string, app: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(handoffId)) throw new Error('Invalid handoff ID.');
  if (!isAbsolute(workspace)) throw new Error(`Choose an absolute project folder in Projects before opening ${app}.`);
  let available = false;
  try { available = (await stat(workspace)).isDirectory(); } catch { /* missing or inaccessible */ }
  if (!available) throw new Error(`The project folder is not available: ${workspace}. Choose its new location in Projects.`);
  if (!prompt.trim()) throw new Error(`The handoff is empty. Generate and confirm it before opening ${app}.`);
}

/**
 * Save the handoff as a new snapshot file for one app conversation. A conversation may start long after it was prepared,
 * while the handoff changes or moves to another project. Its file must remain the same snapshot, especially because
 * its project directory is already fixed.
 */
async function saveSnapshot(dataDir: string, handoffId: string, tag: string, prompt: string): Promise<string> {
  const dir = resolve(dataDir, 'handoffs');
  const file = join(dir, `${handoffId}-${tag}-${randomUUID()}.md`);
  const temporary = join(dir, `.${handoffId}-${randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Publish only a complete snapshot. A fresh exclusive file also avoids following an existing
    // destination symlink or retaining its mode.
    await writeFile(temporary, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return file;
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
  await checkHandoff(handoffId, workspace, prompt, 'Codex');
  let file: string;
  try {
    file = await saveSnapshot(dependencies.dataDir ?? DATA_DIR, handoffId, 'codex-app', prompt);
  } catch (cause) {
    throw new Error('Chumi could not save the handoff for Codex. Choose “Copy instructions” to continue.', { cause });
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

interface DeepSeekHarnessDependencies {
  dataDir: string;
  copy: (text: string) => Promise<void>;
  open: () => Promise<void>;
}

/**
 * Continue in the DeepSeek Harness desktop app. Its only link (dsh://open) shows the window and cannot choose a folder or
 * fill in a message, so Chumi saves a snapshot, puts a one-line instruction that points at it on the clipboard, and then
 * brings up the app: the user opens the project folder there and pastes. Copying comes first because Chumi's window
 * loses focus once the app opens, and it happens here rather than in the page so that the desktop pet can do it too.
 * `copied` is false when the clipboard could not be written: the dialog then shows the instruction to copy by hand.
 */
export async function continueInDeepSeekHarness(
  handoffId: string,
  workspace: string,
  prompt: string,
  dependencies: Partial<DeepSeekHarnessDependencies> = {},
): Promise<{ instruction: string; copied: boolean }> {
  await checkHandoff(handoffId, workspace, prompt, 'DeepSeek Harness');
  let file: string;
  try {
    file = await saveSnapshot(dependencies.dataDir ?? DATA_DIR, handoffId, 'dsh', prompt);
  } catch (cause) {
    throw new Error('Chumi could not save the handoff for DeepSeek Harness. Choose “Copy instructions” to continue.', { cause });
  }
  const instruction = `Read the UTF-8 Chumi handoff file at ${JSON.stringify(file)} (handoff ${handoffId}). `
    + `The project folder is ${JSON.stringify(workspace)}; if this session's workspace is another folder, stop and ask me to open that one. `
    + 'Review the project, then propose a plan and wait for my go-ahead before changing files. '
    + 'Use the response language requested in the handoff.';
  let copied = true;
  try { await (dependencies.copy ?? copyText)(instruction); } catch { copied = false; }
  try {
    await (dependencies.open ?? openDeepSeekHarness)();
  } catch (cause) {
    throw new Error('Could not open the DeepSeek Harness app. Install or open it, then try again, or choose “Copy instructions”.', { cause });
  }
  return { instruction, copied };
}
