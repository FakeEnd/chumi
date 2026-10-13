# Local speech benchmark

`en.wav` and `zh.wav` are 16 kHz mono PCM excerpts from Chumi's synthetic lab meeting, generated with macOS system voices. Their exact script is in `references.json`.

- English: `samples/lab-meeting/manifest.json`, line index 0, 0.6–16.817 seconds.
- Mandarin with English terms: line index 8, 103.798–118.271 seconds.

These clips let an installed Windows app check transcription speed and accuracy without relying on installed speech voices or downloading test audio. They contain fictional meeting content, not a recorded private meeting.
