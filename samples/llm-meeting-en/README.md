# NLP lab meeting sample (all English)

The same synthetic NLP lab meeting as [`../llm-meeting`](../llm-meeting/README.md), with Wei's Mandarin lines in English
and voiced by an English macOS voice (Karen, en_AU). Everyone in it is fictional, and the audio is macOS text-to-speech
read from `script.json`; nothing comes from a real meeting.

It is used for the English README screenshots and the English promo video (`node scripts/demo-shoot.ts`). The bilingual
original is used for the Chinese ones (`--lang zh`). The structure, tagged events and the checklist of what a correct
app should do are in the [bilingual sample's README](../llm-meeting/README.md); times here are a few seconds earlier
(8:42 in total, topic change at 04:44, the Friday deadline at 07:27).

Generate the audio (git-ignored) with:

```bash
node scripts/make-sample.mjs --script samples/llm-meeting-en/script.json
```
