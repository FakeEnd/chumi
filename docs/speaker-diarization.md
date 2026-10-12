# Speaker labeling: development implementation

This first version groups voices **after a meeting ends**. Live Whisper transcription remains independent. Users may name the anonymous speakers and correct individual transcript lines. Those annotations accompany subsequent AI context and the evidence read by Claude Code/Codex; no paid AI request is needed to analyze or edit speakers.

## Try it

1. Check out `codex/speaker-diarization` and run `npm run setup:speakers` once. Setup installs an isolated Python environment and downloads verified model assets under the ignored `build/speakers` directory. See [model provenance and requirements](speaker-models.md).
2. Run `npm run build:web` and `npm start` (or the existing development server workflow).
3. Enable **Settings → Transcription → Speaker labels** before recording. The setting defaults off and cannot change during a meeting.
4. End the meeting. Speaker analysis runs in a single local worker; the automatic final summary waits for it to settle. A failure still permits the summary. The UI shows analysis state and cancellation.
5. Open **Speakers** above the transcript, name A/B/C, and correct any line's assignment. Select **Unknown** to keep attribution uncertain, or **Use automatic assignment** to undo a manual override.
6. Regenerate any stale summary or handoff explicitly. Confirmed handoffs are never silently rewritten. Speaker names do not authorize the downstream coding agent to act.

## Audio and identity rules

- Opting in writes app-owned PCM copies locally. Temporary copies and packed worker files are removed after success, failure, cancellation, shutdown, and startup recovery. Keeping raw audio is a separate opt-in; retained takes can be analyzed again. Original imported files are never deleted.
- Each take has a random filename and an explicit sample-to-session timestamp manifest. Pauses, capture gaps, and helper restarts retain their original session positions. Worker input packs all available takes for **one source** with short silence separators; output is mapped back through the manifest.
- Microphone and computer audio are independent sources, not identities. Cross-source matching and cross-meeting voice recognition are outside this version.
- Clustering integers never serve as permanent identities. Durable speaker IDs are matched to previous results only through overlapping audio. Resuming a meeting after its temporary audio was deleted can produce additional letters for the same person. Earlier labels are preserved, and manual corrections remain authoritative.
- A transcript line spanning significant speech from several speakers is **Mixed speakers**. A line goes to one speaker when that voice covers at least half of it, or, if the whole line was analyzed, at least one second with no other voice. Whisper lines often run over pauses or music. Anything less is **Unknown**. Lines that were never analyzed carry no speaker state, and no tag is sent to the AI. The original Whisper text, IDs, and timestamps are never rewritten to manufacture speaker boundaries.
- There is a two-hour source-audio limit. The whole-source model needs memory proportional to recording length. Automatic speaker counts and attribution remain estimates, particularly with short turns, similar voices, overlap, noise, or audio leaking between sources.
- Older recordings without the new timestamp manifests cannot be retroactively analyzed by this version. Keeping an old raw WAV alone is insufficient to recover its capture gaps safely.

## Integration contract

`shared/speakers.ts` defines the shared DTOs. Migration 2 adds speaker identities, automatic turns, per-segment overrides, job status, and output staleness without altering raw transcript rows. Effective annotation changes increment the meeting revision and record `speaker_labels_changed`. Existing AI outputs remain visible with a warning; stale digests and overviews are excluded from future context. Lines that only gain their first labels don't make earlier output stale. Renames, corrections, and reruns that change a label do. In-flight digest generation cannot reintroduce outdated names.

`server/speakers/audio.ts` owns capture manifests and packing. `runtime.ts` validates and cancels the Python worker. `service.ts` serializes jobs, persists their state, prevents cancelled results from being applied, and cleans temporary audio. Session resume and deletion await cancellation; shutdown stops worker jobs before closing the database.

HTTP endpoints:

- `GET /api/speakers/runtime`
- `GET /api/sessions/:id/speakers`
- `POST /api/sessions/:id/speakers/analyze`
- `POST /api/sessions/:id/speakers/cancel`
- `PATCH /api/sessions/:id/speakers/:speakerId` with `{name: string | null}`
- `PATCH /api/sessions/:id/segments/:segmentId/speaker` with `{mode: 'automatic' | 'unknown'}` or `{mode: 'speaker', speakerId}`

Mutations and the `speakers` SSE event carry current annotations, session revision, outputs, and handoff freshness. The UI updates these without resetting the selected transcript passage. Names are limited to 80 characters; speaker and segment ownership are checked against both meeting and audio source.

## Review and validation

Run `npm run check` and `npm run build:web`. Speaker tests cover migration/reopening, source separation, mixed attribution, manual overrides, stable IDs, partial coverage after resume, ownership validation, generation guards, export/MCP propagation, stale derived context, timestamp gaps, temporary cleanup, worker cancellation, and deferred summaries.

Use `node scripts/acceptance-speakers.ts /absolute/public-test.wav` after model setup for an isolated real-model smoke test. It creates synthetic transcript fixtures in a temporary database, runs local speaker analysis on the supplied recording, verifies naming and export propagation, and deletes its temporary copies. It does not perform or evaluate speech recognition. Recordings are never uploaded and no subscription/API model is invoked.

Representative real meetings still need acceptance testing. Correct speaker counts on short public examples are smoke tests, not an accuracy benchmark; review actual attribution, mixed turns, Chinese/English switching, and long-session resource use before shipping this as a default feature.

### Development validation, 2026-10-11

- `npm run check`: TypeScript checks and all 121 tests passed.
- `npm run build:web`: passed; Vite still reports a bundle-size advisory above 500 kB.
- Real-model acceptance: public English two-speaker fixture, 16 seconds, 2 speaker groups, 833 ms; public Chinese four-speaker fixture, 56.9 seconds, 4 groups, 3,631 ms. Times include packing, local worker startup/inference, persistence, and temporary cleanup in this run. The transcript boundaries in the acceptance harness are synthetic.
- Isolated local app/browser check: saved a speaker name, saw the corresponding transcript labels update, corrected an individual line, reran inference, and verified names/manual corrections survived. The old summary displayed the speaker-change warning. No microphone capture, user meeting database, or paid AI provider was used for these checks.
- Test runtime/models are installed in `build/speakers`; screenshot: `build/speakers/verification.png`. These generated files are ignored by Git.
