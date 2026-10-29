import type { ProviderStatus } from './types.ts';

/** Installation must come before sign-in; prose hints can mention both. */
export function providerSetupCommand(provider: ProviderStatus | null, platform: string): string | undefined {
  if (!provider || provider.state === 'ready') return;
  if (provider.state === 'not_installed') {
    if (platform === 'win32') return;
    if (provider.id === 'codex') return platform === 'darwin' ? 'brew install codex' : 'npm install -g @openai/codex';
    if (provider.id === 'claude-cli') return 'npm install -g @anthropic-ai/claude-code';
    return provider.setupHint?.match(/(brew install [\w-]+|npm install -g [\w@/-]+)/)?.[1];
  }
  if (provider.state === 'error') return provider.setupHint?.match(/(codex (?:logout|login)|claude auth (?:logout|login))/g)?.join('\n');
  if (provider.state === 'signed_out' && provider.id === 'claude-cli') return 'claude auth login';
}
