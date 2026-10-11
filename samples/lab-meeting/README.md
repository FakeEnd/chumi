# Lab meeting sample (synthetic)

A 20:43 synthetic computational-biology lab meeting for testing Chumi end to end:
transcription (English plus Mandarin with English technical terms), catch-ups,
explanations of unfamiliar terms, and summaries. Every voice is macOS `say`. No real
recording or real person is involved; all names are fictional.

| File | What it is |
| --- | --- |
| `lab-meeting.wav` | 16 kHz, mono, 16-bit PCM WAV, 20:43 (1243.0 s), about 40 MB |
| `manifest.json` | Ground truth: total duration, `tagIndex`, and per line `{index, speaker, startMs, endMs, text, tags}` |
| `script.json` | Source dialogue: speakers, voices, rates, lines, pauses, tags |

Stats: 117 lines, 3,540 words (2,998 English-style tokens plus 542 Chinese characters,
each character counted as one word, the same way Word counts them).

To regenerate (needs macOS `say` and Node 18 or newer, no other dependencies):

```sh
node scripts/make-sample.mjs                      # writes into samples/lab-meeting/
node scripts/make-sample.mjs --out-dir /tmp/x     # write somewhere else
node scripts/make-sample.mjs --cache-dir DIR      # per-line WAV cache (default: $CHUMI_SAMPLE_CACHE or <tmpdir>/chumi-sample-cache)
node scripts/make-sample.mjs --no-cache           # re-render every line
```

Voices can sound slightly different on other macOS versions, which moves the
timestamps. **`manifest.json` is the source of truth.** The times below come from the
current render.

## Speakers

| Speaker | Who | Voice | Rate | Lines |
| --- | --- | --- | --- | --- |
| PI | Prof. Rivera, principal investigator | Daniel (en_GB) | 180 | 45 |
| Maya | PhD student, presenting | Samantha (en_US) | 185 | 43 |
| Wei | Postdoc, mixes Mandarin with English technical terms | Tingting (zh_CN) | 185 | 17 |
| Sam | Rotation student | Reed (English (US)) | 180 | 12 |

## Structure

- **Part 1, 00:00 to 10:46: the enhancer model.** Maya presents a convolution plus attention
  model that predicts enhancer activity in erythroid progenitors. The training label is
  ATAC-seq accessibility, used as a proxy for enhancer activity. The talk covers
  GC-matched negatives and the promoter filter; Pearson 0.68 for the attention model
  versus 0.62 for convolutions only, over five seeds; a data-scaling plot; a noise ceiling
  (replicates correlate at 0.8); random peak-level splits; integrated gradients and in
  silico mutagenesis; the tentative GATA finding; and a motif-count baseline at 0.45.
- **Topic change at 10:46** (line #60).
- **Part 2, 10:46 to 20:43: lentiMPRA validation design and statistics.** The library has
  about 10k sequences: about 6k predicted enhancers spread across the score range, about
  3k motif-disruption variants (including the GATA enhancers), and about 1k controls (500
  scrambled, 500 known enhancers). Other topics: barcodes per variant against cell
  numbers; three biological replicates; RNA over DNA counts; low-count filtering;
  overdispersion, so a negative binomial model; FDR at 5% with test families fixed in
  advance; scrambled controls as an empirical null; chromosome-level held-out splits to
  avoid leakage; and Sam's tangent about the name "negative binomial".

## Tagged events (from `manifest.json`)

| Tag | Time (start to end) | Line | What happens |
| --- | --- | --- | --- |
| `unfamiliar_term` | 00:30 to 00:52 | #3 | Maya first says "lenti MPRA" with no explanation. "MPRA" then comes up again and again (01:34, 01:43, 10:56, 11:37, 17:20, 17:38, 18:47). The full name, "massively parallel reporter assay", is **never spoken**. |
| `unseen_visual` | 04:01 to 04:19 | #21 | "As you can see in this plot, the curve flattens after about fifty thousand training sequences." |
| `unseen_visual` | 04:23 to 04:32 | #23 | "The blue one. Orange is the convolution-only baseline." |
| `tentative_finding` | 06:48 to 07:09 | #40 | Attribution maps suggest the model relies on a GATA motif in about 15% of the top 2,000 enhancers. |
| `tentative_finding` | 07:14 to 07:34 | #42 | The pattern appears in only two of three replicates and might be a batch effect: "I wouldn't claim this yet." |
| `tentative_finding`, `disagreement`, `mandarin` | 07:35 to 07:54 | #43 | Wei (Mandarin): it may be real, because GATA1 is the key regulator in erythroid cells, but the third replicate needs checking. |
| `disagreement`, `tentative_finding` | 07:55 to 08:16 | #44 | PI: a result that matches expectations makes him nervous; he assumes a batch artifact until the third replicate is checked. |
| `disagreement`, `mandarin` | 08:17 to 08:30 | #45 | Wei (Mandarin): batch effects are usually global (GC content, fragment length) and would not produce a motif this specific. |
| `disagreement` | 08:30 to 08:45 | #46 | PI: lower library complexity in run three could drop the weaker GATA peaks. "I'm saying we don't know yet." |
| `tentative_finding` | 08:46 to 08:53 | #47 | Maya: plausible, but it stays off posters until replicate three is understood. |
| `tentative_finding` | 09:13 to 09:25 | #50 | PI, for the record: "interesting, it is not confirmed", and no slides outside the lab. |
| `disagreement`, `mandarin` | 09:25 to 09:30 | #51 | Wei agrees to hold off on conclusions but still bets the result is real. |
| `topic_change` | 10:46 to 10:55 | #60 | "OK, let's switch gears and talk about the validation experiment and the statistics for the new screen." |
| `tangent` | 14:37 to 15:33 | #79 to #83 | Sam asks why it is called "negative binomial". The PI gives a brief answer, Wei adds the gamma-Poisson view, Sam asks about beta binomial, and the PI says "a tangent for another day". |
| `action_item_no_deadline` | 17:44 to 17:52 | #95 | PI: "Maya, can you rerun the model with the chromosome-level holdout split? No rush, whenever you get to it." |
| `action_item_with_deadline`, `mandarin` | 18:51 to 19:04 | #103 | Wei (Mandarin): sends the barcode design spreadsheet "by Friday" (这个星期五之前). |
| `action_item_with_deadline` | 19:05 to 19:13 | #104 | PI repeats it in English: "Wei sends the barcode design spreadsheet by Friday. That's the one hard deadline we have." |
| `open_question` | 19:29 to 20:00 | #107 to #109 | 100 or 200 barcodes per variant. Wei leans toward 200 (statistical power); Maya leans toward 100 (enough cells for three replicates). PI: "Let's leave that open." |
| `open_question` | 20:20 to 20:35 | #114 | PI's closing line: "the barcode number is still an open question." |

Mandarin-mixed lines (`mandarin`, all Wei, Tingting voice): 01:43, 04:54, 07:35,
08:17, 09:02, 09:25, 10:33, 11:51, 12:14, 13:27, 15:08, 16:08, 17:06, 18:35, 18:51,
19:29, 20:17 (lines #8, 26, 43, 45, 49, 51, 58, 65, 67, 73, 81, 87, 92, 101, 103, 107, 113).

## What a correct app should do

**Summary and minutes**

1. **GATA is tentative.** Describe the GATA-motif result as tentative, preliminary, or
   unconfirmed. Seen in 2 of 3 replicates; possible batch effect, because replicates 1 and 2
   were sequenced together. It must **not** be stated as a finding. Ideally, present the
   disagreement: Wei leans toward it being real (GATA1 is expected in erythroid cells), the PI
   leans toward a batch artifact until the third replicate is checked, and Maya is in
   between. The GATA1 CUT and Tag data has one replicate only and is "supporting evidence"
   at best.
2. **Action item without a deadline.** "Rerun the model with the chromosome-level holdout
   split", owner **Maya**, deadline **not stated** ("no rush, whenever you get to it"). The
   app must not invent a date. Follow-up detail: start with the performance numbers and the
   scaling curve, and redo attribution only if the attention advantage survives.
3. **Action item with a deadline.** "Send the barcode design spreadsheet", owner **Wei**,
   deadline **Friday**. The sheet lists the cell numbers and sequencing depth needed for
   each barcode count. Wei commits in Mandarin (18:51), the PI restates it in English
   (19:05), and the PI confirms it again at 20:12.
4. **Unseen visual.** Acknowledge that Maya referred to a plot that is not in the audio
   (04:01). The app may repeat what was said about it: the curve plateaus after about 50k
   training sequences, blue is the attention model, orange is convolution only, and the gap
   stays constant. It must not invent other details of the plot.
5. **Open question.** List 100 versus 200 barcodes per variant as **unresolved**. Whether
   to run a small pilot with both was not decided either.
6. **Decisions actually made** (useful for contrast): three biological replicates (the PI
   would prefer four; revisit if the first replicate is noisy); FDR at 5%, with test
   families (enhancers versus variant-vs-reference) defined before seeing the data;
   scrambled controls used to calibrate the null; the MPRA library drawn mostly from
   held-out chromosomes; generalization across cell types is out of scope.
7. **Lower-priority items** a thorough summary may also list, all without deadlines: Maya
   adds a noise ceiling to the scaling plot (05:21, "Will do"); Maya may add a gapped
   k-mer baseline "if I have time" (10:33 to 10:45).
8. **The tangent** (14:37 to 15:33) should be skipped or marked as a side discussion, not
   turned into a decision or action item.

**Explanations**

9. **MPRA.** Asked "what is MPRA?", the app should explain a massively parallel reporter
   assay: thousands of candidate sequences cloned into reporter constructs, each tagged with
   barcodes, with activity read out as RNA barcode counts over DNA barcode counts. lentiMPRA
   means the constructs are delivered by lentivirus and integrate into the genome. The
   meeting itself never gives this explanation.
10. Other terms a deep-learning listener may want explained: ATAC-seq, GATA / GATA1,
    erythroid, CUT and Tag, transduction, barcode association, overdispersion and the
    negative binomial, noise ceiling.

**Catch-ups**

11. A catch-up requested after 10:46 should mention that the topic changed from model
    results to MPRA validation design and statistics. One requested between 07:00 and
    09:30 should mention the ongoing GATA disagreement. One requested around 17:50 should
    mention Maya's new rerun task.

**Transcription**

12. Wei's lines should be transcribed in Chinese, with the English technical terms kept in
    English (for example "GATA motif", "replicate", "batch effect", "barcode").

## Known TTS and ASR artifacts (checked with whisper.cpp large-v3-turbo)

- **Running Whisper once over the whole file with auto language detection locks onto
  English and loses most of Wei's Mandarin.** On the current render, 12 of the 17 Mandarin
  lines were dropped or came out as English translations, including the main GATA
  argument (#43, 07:35). The decoder also fell into a repetition loop ("that's real
  evidence" repeated) around 11:51, and the results change from run to run. Transcribing
  each segment separately (chunked by VAD, with language detected per chunk) gives correct
  Chinese plus English output. This is a deliberate stress test: an app that runs one pass
  with a fixed language will lose Wei's contributions. The PI's English restatements of the
  GATA argument and of the Friday deadline are a partial safety net.
- Tingting reads "GATA" like "get-ta", so Whisper may write "Getter" or "get to". Passing
  an initial prompt or glossary such as "GATA motif, GATA1, MPRA, lentiMPRA, ATAC-seq,
  replicate, erythroid" fixes it; this was verified on line #43. The English voices say
  GATA correctly.
- "Wei" may be transcribed as "way". "a lenti MPRA" may come out as "Alenti MPRA". The
  spoken text says "ATAC seq" and "CUT and Tag", spelled for TTS.
- Speaker turns have no overlap. Each line is followed by 150 to 900 ms of silence.
  Line #17 (03:31) is cut off mid-sentence ("it's not, um,") with a 150 ms gap before the PI
  interrupts.
