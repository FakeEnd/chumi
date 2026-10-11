# AI provider research (checked 2026-10-10)

The brief asked to verify, against current official documentation, what a **personal, local** app may use to reach an existing AI subscription. Summary of what the official pages say and what Chumi does with it.

## OpenAI / ChatGPT plan

| Source | What it says |
|---|---|
| [Sign in with ChatGPT cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) | "ChatGPT plan usage is available to open-source projects, personal projects that run locally, and selected private apps." The user approves the `chatgpt.tokens.use.direct` scope in a browser OAuth (PKCE) flow. Usage is deducted from the Plus/Pro plan. Exact quota numbers aren't exposed; apps should link to ChatGPT Settings → Usage. |
| [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | Responses API only, with `store:false` and `stream:true`. Several fields are rejected. **Audio/video input and the transcription API are not supported.** Speech recognition therefore has to be separate. |
| [Models & inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | Usage-limit errors are `subscription_sharing_usage_limit_exceeded` and `subscription_sharing_usage_unavailable`. |
| [Codex app-server](https://learn.chatgpt.com/docs/app-server) | "Embed Codex into your product with the app-server protocol" (JSON-RPC over stdio). Supports custom base instructions, ephemeral threads, a read-only sandbox, `model/list`, and `account/rateLimits/read`, which returns plan windows with `usedPercent`, `resetsAt`, `ordinaryUsageAllowed` and credits. |
| [Codex pricing](https://learn.chatgpt.com/docs/pricing) | Signed in with ChatGPT, usage draws on the plan's included limits and credits. Signed in with an API key, it's billed at API rates. Plus/Pro users can buy credits after hitting limits. |

**Choice for the MVP: Codex app-server with the user's existing `codex login`.** Codex was already signed in with a ChatGPT plan on the development Mac, so this needs no new sign-in. The protocol is documented for building your own client. It also reports the plan's usage windows, so Chumi can say exactly when included usage is exhausted.

The "Sign in with ChatGPT" devkit (`@siwc/local`) gives per-app OAuth, but it isn't published to npm and is under a noncommercial licence. It also needs a browser sign-in that only the user can complete. It's the natural next adapter if you want Chumi to have its own ChatGPT connection.

**Billing safeguard.** During development the plan's weekly Codex window read **100 % used** while purchased credits were available, which is exactly the case this safeguard exists for. Codex may spend credits once the included usage is gone. Chumi therefore blocks requests whenever any signal shows exhaustion: `usedPercent ≥ 100`, `ordinaryUsageAllowed=false`, `rateLimitReachedType` set, `spendControlReached`, or a `usageLimitExceeded` error. It only spends credits if you tick "Allow spending purchased ChatGPT credits" (off by default). It also strips `OPENAI_API_KEY`/`CODEX_API_KEY` from the child environment, and refuses to run if Codex reports API-key auth.

## Anthropic / Claude plan

| Source | What it says |
|---|---|
| [Use Claude Code with Pro/Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) | Limits are shared across Claude and Claude Code. If `ANTHROPIC_API_KEY` is set, Claude Code uses the key and bills the API instead of the subscription. |
| [Monthly API credits / `claude -p` FAQ](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans) | "When you're signed in with your Claude plan instead, `claude -p` and Agent SDK usage still draw from your plan's usage limits." API credits apply only when using an API key. |
| [Legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) | OAuth is for "ordinary use of Claude Code and other native Anthropic applications". **Developers** building products, including with the Agent SDK, "should use API key authentication", and may not offer Claude.ai login in their apps or handle Claude credentials. It explicitly does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". |

**Chumi's Claude adapter** runs the unmodified `claude` binary in print mode with your own `claude auth login`. It is a personal-use path that draws on your plan limits, and Chumi never sees the credentials. If you ever distribute Chumi to others, use the API-key adapter instead.

Safeguards:

- API-key variables are removed from the child environment.
- `--bare` is not used, because it forces API-key auth.
- The request aborts if the CLI's init message reports an API key source.
- If Claude Code reports overage (paid extra usage), the result is discarded and AI is paused.

This adapter was later verified end to end with a real Claude subscription (see [verification.md](verification.md)).

## Paid API key (optional, off by default)

The Anthropic API adapter uses the official TypeScript SDK with `claude-opus-5-5` and server-side refusal fallbacks (`fallbacks: "default"`). It only works when all of these are true:

1. Paid access is enabled in Settings, after a confirmation dialog.
2. A key is stored in the macOS Keychain.
3. It is selected as the active provider.

There is no automatic switching between providers.
