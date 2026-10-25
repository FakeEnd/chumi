# NLP lab meeting sample (synthetic)

An 8:52 synthetic NLP lab meeting for testing Chumi end to end, and the source of the Chinese README screenshots and
promo video: transcription (English plus Mandarin with English technical terms), catch-ups, explanations, summaries,
recordings and handoffs. Every voice is macOS `say`. No real recording or real person is involved; all names are fictional.
[`../llm-meeting-en`](../llm-meeting-en/README.md) is the same meeting with Wei's lines in English.

| File | What it is |
| --- | --- |
| `llm-meeting.wav` | 16 kHz, mono, 16-bit PCM WAV, 8:52, about 17 MB (git-ignored; generate it as below) |
| `manifest.json` | Ground truth: total duration, `tagIndex`, and per line `{index, speaker, startMs, endMs, text, tags}` |
| `script.json` | Source dialogue: speakers, voices, rates, lines, pauses, tags |

Stats: 66 lines, 1,533 words (1,280 English-style tokens plus 253 Chinese characters).

```sh
node scripts/make-sample.mjs --script samples/llm-meeting/script.json
```

Voices can sound slightly different on other macOS versions, which moves the timestamps. **`manifest.json` is the
source of truth.** The times below come from the current render.

## Speakers

| Speaker | Who | Voice | Lines |
| --- | --- | --- | --- |
| PI | Prof. Adler, principal investigator | Daniel (en_GB) | 23 |
| Maya | PhD student, presenting | Samantha (en_US) | 26 |
| Wei | Postdoc, mixes Mandarin with English technical terms | Tingting (zh_CN) | 10 |
| Sam | Rotation student | Reed (English (US)) | 7 |

## Structure

- **Part 1, 00:00 to 04:51: the citation model.** A 7B open model answers questions about a paper from eight retrieved
  passages and must cite a passage for every claim. Supervised fine-tuning on about 40k examples, then DPO on about 60k
  judge-labeled preference pairs (margin-filtered). Citation precision 61% (SFT) to 74% (DPO) over three seeds; recall
  55% to 63%; accuracy flat (68 vs 69). A plot that flattens after about 20k pairs. The DPO answers are about 30% longer,
  and the same kind of LLM judge labeled the pairs and scores the test set, so the lab argues about judge bias.
  Sixteen passages instead of eight: slightly better, much slower (the KV cache).
- **Topic change at 04:51** (line #33).
- **Part 2, 04:51 to 08:52: the evaluation plan.** About 1,000 new questions from papers at least three months after the
  model's training cutoff, plus an n-gram overlap check against preprints; three raters per answer with Cohen's kappa
  and majority vote; a paired bootstrap with the comparisons fixed in advance; the LLM judge as a secondary metric;
  eight passages for the main results and sixteen as an ablation. Sam's tangent about the name "bootstrap".

## Tagged events (from `manifest.json`)

| Tag | Time | Line | What happens |
| --- | --- | --- | --- |
| `unfamiliar_term` | 00:30 | #3 | Maya says "DPO" without explaining it. The full name, "direct preference optimization", is **never spoken**. |
| `unseen_visual` | 02:06, 02:14 | #13, #14 | "As you can see in this plot, precision keeps climbing until about twenty thousand preference pairs." "The blue line is DPO. Orange is…" |
| `tentative_finding` | 02:29 to 02:50 | #17, #18 | DPO answers are 30% longer with more citations per sentence; a 50-answer human check agrees with the judge on 41. "I wouldn't claim it yet." |
| `disagreement`, `mandarin` | 02:51 | #19 | Wei: the gain is real; 82% agreement is about what two human raters reach, and recall rose too. |
| `disagreement` | 03:06 | #20 | PI: the judge is the same model family that created the pairs, so assume partly judge bias until another judge checks. |
| `disagreement`, `mandarin` | 03:23 | #21 | Wei: self-preference is a style preference; it wouldn't make individual citations check out. |
| `disagreement` | 03:33 | #22 | PI: longer answers give the judge more chances to say yes, and 50 answers is a small sample. "We don't know yet." |
| `tentative_finding` | 03:48 to 04:08 | #23 to #25 | Maya keeps it out of the paper draft; Wei still bets it holds up; PI: "interesting, not confirmed", no slides outside the lab. |
| `topic_change` | 04:51 | #33 | "OK, let's switch gears and talk about the evaluation plan for the paper." |
| `tangent` | 06:34 to 07:04 | #46 to #50 | Why "bootstrap"? Pulling yourself up by your bootstraps; Wei compares it to cross-validation; random forests; "a tangent for another day". |
| `action_item_no_deadline` | 07:23 | #53 | PI: "Maya, can you rerun the judge with the answers matched for length? No rush, whenever you get to it." |
| `action_item_with_deadline`, `mandarin` | 07:37 | #55 | Wei (Mandarin): sends the annotation guidelines "by Friday" (这个星期五之前). |
| `action_item_with_deadline` | 07:43 | #56 | PI repeats it in English: the one hard deadline, because the raters start the week after. |
| `open_question` | 07:51 to 08:18 | #57 to #60 | 500 or 1,000 questions for the human study. Wei: 1,000 (power); Maya: 500 and a pilot first. PI: "Let's leave that open." |
| `open_question` | 08:25 | #63 | The PI's summary ends with the study size still open. |

Mandarin lines (all Wei, Tingting): 01:06, 02:51, 03:23, 03:55, 04:28, 05:31, 06:03, 06:49, 07:37, 07:58.

## What a correct app should do

1. **The DPO gain is tentative.** 61% to 74% citation precision must not be stated as established: it was measured by the
   same kind of judge that labeled the training pairs, the answers got longer, and the human check was 50 answers.
   Ideally the summary keeps the disagreement: Wei thinks it is real, the PI assumes partly judge bias, Maya is in between.
2. **Action item without a deadline:** rerun the judge on length-matched answers, owner Maya, starting with the 50
   hand-checked answers. No deadline ("no rush").
3. **Action item with a deadline:** annotation guidelines, owner Wei, by **Friday** (said in Mandarin, repeated in English).
4. **Unseen visual:** acknowledge the plot was not visible; repeat only what was said (flattens after about 20k pairs;
   blue is DPO, orange is longer SFT).
5. **Open question:** 500 versus 1,000 questions for the human study, unresolved; a pilot was suggested, not decided.
6. **Decisions actually made:** new post-cutoff test set with an n-gram overlap check; three raters, Cohen's kappa,
   majority vote; paired bootstrap with precision, recall and accuracy fixed in advance; eight passages for the main
   results, sixteen as an ablation on a subset; the 74% stays off slides outside the lab.
7. **The tangent** (06:34 to 07:04) is a side discussion, not a decision or task.
8. **Explanations:** "DPO" (never expanded in the meeting), "KV cache" (why sixteen passages shrink the batch size),
   LLM-as-a-judge and self-preference bias, citation precision versus recall, paired bootstrap, Cohen's kappa, contamination.
9. **Catch-ups:** one after 04:51 should mention the switch from results to the evaluation plan; one between 02:30 and
   04:10 should mention the judge-bias disagreement.
10. **Transcription:** Wei's lines in Chinese, with English terms kept in English ("agreement", "self-preference",
    "KV cache", "n-gram overlap", "annotation guidelines").
