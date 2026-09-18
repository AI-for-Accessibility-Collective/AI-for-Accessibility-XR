# Working-memory-aware instruction adaptation for the audio task guide

## Short answer

Dependency Locality Theory is the wrong primary yardstick for instruction load, but one piece of it (cost counted in *new discourse referents*) is exactly right and should survive. Measure instructions in **units the listener must hold** (new objects, values, conditions, pending actions) and in **how long the verb is delayed**, not in dependency distance. Estimate the person's spare capacity from repeats, clarifying questions, time-to-done relative to the physical step, and camera-verified inaction, with a ~30 s decay. Put both on one scale (a "working-memory budget"), let a controller pick the prompt directives for the next turn, and gate the model's reply against the budget before it is spoken. The gate is the part that makes this honest: prompting alone cannot guarantee a limit, scoring the output can.

## 1. What ProMemAssist actually does (and does not do)

ProMemAssist (Pu, Zhang, Sendhilnathan, Freitag, Sodhi, Jonker; UIST 2025, Meta Reality Labs internship) — https://arxiv.org/abs/2507.21378, https://dl.acm.org/doi/10.1145/3746059.3747770.

- **Representation**: a *perception memory* of up to 7 MemoryItems (visuospatial = YOLOv11 object detections; phonological = Whisper transcripts; both CLIP-embedded) and an *episodic buffer* of 4 MemoryChunks (Cowan's chunk limit). Updated every 1 s from RGB camera + 7-mic array on prototype glasses; no gaze, no IMU.
- **Dynamics**: Recency = 1 − t/T with T = 30 s; when capacity is exceeded, the lowest `0.3·Recency + 0.4·Relevance + 0.3·Importance` item is displaced. Interference is same-modality dissimilarity to the candidate message.
- **Use**: a utility `0.6·Importance + 0.4·Relevance − (displacement cost + interference cost)`; deliver if > 0.75, defer if 0–0.75, drop if ≤ 0. So the WM model is used only to decide *whether/when* to speak, never *how*.
- **Results**: N = 12 (mean age 36), four tabletop tasks. Fewer messages than the LLM baseline (130 vs 332), higher positive engagement (24.6% vs 9.3%), lower frustration (2.32 vs 3.14, p < .05); **no** difference in completion time or other TLX items. Authors flag that the WM model is "a simplified and operational approximation", that timing and message quality were confounded, and they say nothing about older adults or individual capacity.

**What transfers to you**: the "items + 30 s recency + chunk limit" bookkeeping and the idea of scoring a *candidate message* against the current memory state. **What does not**: their load is the load of the *environment* on the user (objects seen, speech heard); it never scores the assistant's own sentence, and it never adapts form. Your problem is closer to the inverse: the guide's speech is the main thing being held.

## 2. Is Gibson's DLT the right measure of instruction load?

**Verdict: no as a metric, yes as a lesson.**

DLT (Gibson 1998, https://tedlab.mit.edu/tedlab_website/researchpapers/Gibson_1998_Cogn.pdf; 2000) puts the cost of a sentence in (a) *integration cost* — the number of new discourse referents crossed between a word and the head it attaches to — and (b) *storage cost* of open syntactic predictions. It was built to explain nested relative clauses and center embedding in reading. Three problems for your use:

1. **No variance in the population of sentences you emit.** "Turn the big dial to forty" has dependency lengths of 1–2. Nearly every well-formed imperative scores the same, so DLT cannot discriminate the sentences you want to discriminate. The load in an instruction is in *what must be held* (object, value, place, condition, the unexecuted action) and in *how many of those you stack*, not in the syntactic distance between them.
2. **The field has moved on even for the syntax it was built for.** Cue-based retrieval (Lewis & Vasishth 2005; Vasishth & Lewis 2006, https://www.ling.uni-potsdam.de/~vasishth/pdfs/Vasishth-Lewis-Language2006.pdf) puts difficulty in *similarity interference* between items competing for retrieval, and predicts anti-locality that DLT gets wrong. Gibson's own newer account, lossy-context surprisal (Futrell, Gibson & Levy 2020, https://onlinelibrary.wiley.com/doi/10.1111/cogs.12814), derives locality effects as a special case of "information locality" under a noisy memory of context. Neither of these gives you a sentence-level number you can compute cheaply on device, but the *interference* idea matters: two similar referents in one step ("the left dial and the right dial") cost more than two dissimilar ones.
3. **The evidence on older adults points at different features.** Kemper (1987, https://www.tandfonline.com/doi/abs/10.1080/03610738708259299): older adults recalled 60% of propositions from right-branching sentences but only 22% from *left-branching* ones (subordinate material before the main clause). That is "words before the verb", not dependency length. Stine-Morrow and colleagues repeatedly find older adults are hurt specifically by *propositional density* (https://pmc.ncbi.nlm.nih.gov/articles/PMC2246038/). Kemper & Harden (1999, https://www.researchgate.net/publication/12682502): shorter, simpler sentences and semantic elaboration (repetition, comprehension checks) each improved map-route following; exaggerated prosody (high pitch, slow rate, long vowels) did not, and *cancelled* the gains when added. Wingfield et al. (1999, https://www.ovid.com/journals/psyag/abstract/00002004-199909000-00003): extra time helps older listeners only when the pauses fall at clause boundaries, not when speech is uniformly slower.

**The piece of DLT to keep**: Gibson's cost unit is the *new discourse referent* (nouns and tensed verbs; pronouns and already-given entities are free). That is a direct justification for "one new referent per sentence" and for making *re-anchoring* an already-introduced object cheap ("that dial" costs ~0, "the temperature dial next to the door" costs 2).

### What to measure instead, ranked

| Rank | Feature | Why (one line) | Cost to compute |
|---|---|---|---|
| 1 | **New referents** (content nouns not yet mentioned in this task) | Gibson's own cost unit; Cowan's 4±1 chunk limit is a count of items, not words (https://philpapers.org/rec/COWTMN) | noun list + task-scoped seen-set, no parser |
| 2 | **Pending actions** (imperative verbs in this utterance + steps said but not yet "done") | Following-instructions research: accuracy falls with number of commands held before acting (Jaroslawska & Gathercole, https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6204648/) | imperative-verb lexicon |
| 3 | **Conditions / branches** (if, when, unless, until, "or") | Dixon: plans are built action-first; conditional/organizational material before the action slows plan construction (https://www.sciencedirect.com/science/article/abs/pii/0749596X8790060X; Dixon, Faries & Gabrys 1988, https://www.sciencedirect.com/science/article/abs/pii/0749596X88900137 — explicit action first read faster on an unfamiliar knob-setting task) | keyword count |
| 4 | **Words before the main verb** | Kemper's left-branching finding; imperative should start the sentence | position of first imperative verb |
| 5 | **Numbers, settings, named values** | Each is an unchunkable item ("40", "cotton", "half a cup") | regex |
| 6 | **Propositional density** (ideas per 10 words, Kintsch & Keenan; CPIDR-style POS approximation, https://pmc.ncbi.nlm.nih.gov/articles/PMC2423207/) | Best-validated aging predictor; adjectives/adverbs/PPs each add a proposition | POS tagger or cheap approximation (count verbs + adjectives + adverbs + prepositions) |
| 7 | **Similar-referent interference** (two referents sharing a head noun: "left dial / right dial") | Lewis & Vasishth | string match |
| 8 | **Spoken duration** (words ÷ rate) | Baddeley's ~2 s articulatory loop (https://www.sciencedirect.com/topics/psychology/phonological-loop) — a weak, floor-level check the current 18-word cap already approximates | trivial |

Dependency length would rank below all of these. If you want one Gibson-derived number, count referents crossed *before the verb*, which collapses ranks 1 and 4.

## 3. A unified working-memory budget

One scale, in "items" (roughly Cowan chunks), spoken by both sides.

### (i) Load score per utterance (starting guesses, to be fit later)

```
load(u) = 1.0·newReferents
        + 0.3·oldReferents          (re-anchored, cheap but not free)
        + 1.5·(imperativeVerbs − 1)  (every extra action beyond the first)
        + 1.0·conditions             (if/when/unless/until/or)
        + 0.7·numbersAndValues
        + 0.6·(wordsBeforeVerb / 5)
        + 0.5·(propositions − imperativeVerbs) / 2   (descriptive extras)
        + 0.8·similarReferentPairs
```

A good step ("Turn the big dial to forty.") scores about 1.0 + 0.7 ≈ 1.7. A bad one ("Once the door clicks shut, if the light is green, turn the left dial and the right dial to forty and press start.") scores ~2 conditions + 3 new referents + 2 extra actions + 1 number + 5 words before verb ≈ 9. That spread is what DLT lacks.

### (ii) Spare capacity of the person

`spare = span − pressure`, where `span` is a per-person baseline (3–4 items for most older adults, from the profile) and `pressure` is an accumulator with a 30 s half-life (ProMemAssist's T; your own logs can retune it).

| Signal | Source in this app | Increment | Measurable with this hardware? |
|---|---|---|---|
| "repeat" | `REPEAT_RE` in session.ts, already per-step counted by the speaker | +1.0 (second repeat of same step +1.5) | Yes, today |
| Clarifying question mid-step ("which one?", "where?", "what was I doing?") | `guide.ask()` path | +0.7 | Yes, today (regex on utterance) |
| Time-to-done ≫ expected for this step | timestamp between `say` resolve and `DONE_RE` | +0.5 if > 2× expected | Yes, but only if the brief carries an expected duration per step (a physical-step prior); without it, this is the main false-alarm source |
| Camera: hand not near the target object / no change after N s | one extra 1-frame vision call reusing `visionVerify` ("Is the wearer's hand on the dial? yes/no/unclear") | +0.8 on "no" | Yes, cheap; 'unclear' must count as nothing |
| Verify 'no' (wrong result on camera) | existing `runVerify` | +1.0 | Yes, today (currently silent) |
| Disfluency / restarts in the transcript ("um… the… wait") | STT text | +0.3 | Weakly; the Interspeech 2014 cognitive-load challenge found rate/F0/energy shifts are strongly task-dependent (https://www.isca-archive.org/interspeech_2014/schuller14_interspeech.html) — treat as a tie-breaker, not a detector |
| Fast, unprompted "done" | timestamp | −0.3 | Yes |
| IMU head-search (repeated large yaw sweeps) | not wired; phone/glasses IMU | +0.3 | Possible later; skip for v1 |

Not available: pupillometry, gaze, HRV. Do not pretend a 12-word transcript can classify load from voice quality.

### (iii) Controller: budget → directives

`budget = clamp(spare, 1, span)`. Three tiers of prompt directives, chosen per turn and inserted alongside the existing profile block:

- **Tier A (budget ≥ 3)**: today's directives.
- **Tier B (budget 2–3)**: "Start with the verb. One object per sentence. No 'if' or 'when' — ask a yes/no question instead ('Is the light green?'). ≤ 12 words. Name where we are: 'Next, step 3 of 5.'"
- **Tier C (budget < 2)**: everything in B plus "Refer to the object as you already did ('that dial'); one sentence only; then wait." Delivery side: re-repeat the current step unprompted after ~10 s of silence with no camera change; 900 ms pause becomes a pause *before the value* ("Turn the big dial… to forty").

### (iv) Output gate (the important part)

Score the reply before `say`. If `load(reply) > budget`: ask the engine once to rewrite ("Give only the first action, one object, under 12 words"); if it still exceeds, split deterministically at the first sentence boundary after the first imperative, speak that, and hold the remainder as the next step (the guide must know the step count grew). Baseline and static-profile modes never go through the gate, so the A/B stays clean.

### The loop (≤ 10 steps)

1. Task starts; `span` read from profile; `pressure = 0`. *(measurement)*
2. Controller computes `budget`, picks a tier, appends its directives to the turn prompt. *(prompt-side)*
3. Engine replies. *(unchanged)*
4. Load scorer scores the reply. *(measurement)*
5. Gate: over budget → rewrite once → else deterministic split. *(prompt-side then delivery-side)*
6. Paced delivery speaks it; timestamp recorded; a silence timer starts. *(delivery-side)*
7. Signals arrive: repeat / question / done latency / verify result / hand-on-object frame. Each bumps `pressure`. *(measurement)*
8. Silence timer fires with no signal → one gentle re-repeat, then nothing. *(delivery-side)*
9. "done" → `pressure` decays with time; the seen-referent set is updated so old objects become cheap. *(measurement)*
10. Back to 2. At task end, session emits a summary (repeats, mean latency, tier history) to the panel, never to the profile.

**Honesty rules**: the live budget and `pressure` are session state and are shown in the HUD/panel with the reason for each tier change; the profile holds only `span` (and only a person or the panel editor writes it); the scorer's features are logged per utterance so any adaptation can be audited afterwards.

## 4. Mapping onto the toolkit layers

| Piece | Layer | Notes |
|---|---|---|
| `span` (baseline items, e.g. 2–5) | **Profile dimension**, new need e.g. `holdLoad` / `workingMemorySpan` | Refines rather than replaces `pacing: 'stepwise'`; stepwise becomes "span ≤ 4" behaviour. Generic: any modality could honour it (visual UIs = items per screen). |
| `renderXRAudioSettings` | Surface | Adds `delivery.budgetItems` (from span) and `delivery.reRepeatAfterMs`. |
| Load scorer | **New adapter** `adapters/load-score.ts` (pure function text → features + score) | Generic and upstream-worthy: no engine, no speech, no parser. Same function scores a screen-reader string or a caption. |
| Tiered directives | `prompt-directives.ts` gets a second export `budgetPromptBlock(budget, stepIndex, stepTotal)` | Keeps the profile block static (auditable) and the live block separate. |
| Controller + pressure accumulator | **Session state** in `session.ts` / `task-guide.ts` | App-specific: it knows about "done", verify results and the step timeline. |
| Output gate | `task-guide.ts` `speakTurn` (between `engine.turn` and `say`) | App-specific; the rewrite prompt is one line. |
| Re-repeat timer, pause-before-value | `paced-delivery.ts` | Generic delivery behaviour; contribute upstream with the scorer. |
| Hand-on-object check | reuses `visionVerify` | App-specific. |

Contribute upstream: the profile dimension, the scorer, the budget-aware chunking. Keep local: signal weights, tier wording, the gate's rewrite prompt.

## 5. Risks and how to check them

- **Elderspeak drift.** Tier C wording ("that dial", short sentences) is exactly what Kemper & Harden showed *helps*; what backfires is prosody (pitch, drawl) and endearments. So the controller may only change *structure*, never rate or pitch, and the existing elderspeak guard stays in every tier. Check: rate a sample of Tier C lines blind on a patronising scale.
- **Over-fragmentation.** Splitting every step into sub-actions lengthens the task and can itself confuse ("was that the whole step?"). Cap: the gate may split at most once per step; re-anchoring ("step 3 of 5") is mandatory whenever a split happened.
- **False overload from slow physical steps.** Filling a drawer takes longer than turning a dial. Mitigations: per-step expected duration in the brief (the model can estimate it when writing the brief), and require *two* signals (latency + hand-not-on-object, or latency + repeat) before rising a tier; a single slow "done" never changes the tier.
- **Oscillation.** Tier can go up on a single turn but comes down only after two clean steps.
- **Scorer disagreeing with humans.** Before trusting it, have two people rate ~50 generated steps for "how much do I have to hold?" and fit the weights by regression; the numbers above are priors.

**Evaluation with the existing A/B film structure**: three arms on the same brief — baseline (raw), static profile (today's directives), live-adaptive (tiers + gate). Same wearer, counterbalanced tasks. Metrics: repeats per step; clarifying questions per step; time-to-done variance (mean is confounded by the physical step, variance is not); camera-verified errors; number of gate interventions; and a 4-item subjective scale after each run ("I knew what to do next", "I had to hold too much in mind", "It talked down to me", "It took too long"). Add the per-utterance load log so you can show *which* sentence triggered *which* adaptation.

## 6. What to build first

**Minimal version (1–2 days)**, learns the most per hour:

1. `load-score.ts`: the formula above with lexicon-based features (imperative verbs, condition words, numbers, nouns via a tiny stoplist heuristic), plus a seen-referent set per task. Unit tests on ten hand-written steps.
2. Score every reply in `speakTurn` and log it to the panel next to the text, with no behaviour change. Run the three existing films; look at whether high scores co-occur with repeats. This alone answers "is the measure any good".
3. Pressure accumulator from repeats + clarifying questions only (both already parsed), 30 s half-life, shown in the HUD.
4. The gate in its cheapest form: deterministic first-sentence split when `load > budget`, no rewrite call yet.

**Full version** adds: the profile `span` dimension and surface field; tiered prompt directives with the rewrite-once call; time-to-done against brief-estimated durations; the hand-on-object vision check; re-repeat-on-silence in paced delivery; weight fitting from human ratings; and the three-arm study.

Build the scorer and the log first. If the load score does not predict repeats in your existing footage, no controller on top of it will help, and you will have learned that in a day.
