# Sample lab meeting (all English)

The same synthetic lab meeting as [`../lab-meeting`](../lab-meeting/README.md), with Wei's Mandarin lines translated to English and voiced by an English macOS voice. Everyone in it is fictional, and the audio is macOS text-to-speech read from `script.json`; nothing comes from a real meeting.

It is used for the English README screenshots and the English promo video (`node scripts/demo-shoot.ts`). The bilingual original is used for the Chinese ones (`--lang zh`) and for the acceptance tests.

Generate the audio (about 20 minutes, git-ignored) with:

```bash
node scripts/make-sample.mjs --script samples/lab-meeting-en/script.json
```
