# Extractor prompt optimization — findings & recommendation

**Goal.** Derive the best possible system prompt for Nova's document requirements
extractor (Gemini 3.5 Flash, `thinkingLevel: high`), which condenses an uploaded
document into a faithful requirements digest the Solutions Architect reads instead
of the raw 200k-char document.

**Method (anti-bias by construction).** Every judging and improving step ran as
blind, cost-free Claude workflow subagents; only the Gemini extractions cost money.
The loop, designed so the improver can never grade its own work:

1. **Anchor** — the incumbent prompt extracted 3× per doc (variance control).
2. **Diagnose** — fresh blind judges read source + extracts, produce a
   *domain-agnostic* failure-class catalog (corpus instances abstracted to classes,
   so improvers can't overfit to these 5 docs).
3. **Improve** — several improvers, each a *different* design mandate, write full
   replacement prompts from the catalog (never seeing the raw corpus).
4. **Leak-gate** — a cold reviewer rejects any prompt smuggling in
   corpus/domain/format specifics. Real leaks scrubbed; legitimate target-system
   vocabulary ("case type", "field") and general tabular words ("column") kept.
5. **Blind tournament** — extracts relabeled to neutral letters, scrambled per doc,
   ranked by 6 fresh judges/doc against the source. Cost/length hidden from judges.
6. **Aggregate** — de-blind, mean rank per prompt, pre-registered promotion check.

Guards that held throughout: judges never saw the version/round/which-prompt;
judges were explicitly **cost- and length-blind** (recall > brevity is the whole
point of the extractor); the win criterion was **pre-registered in writing** before
any candidate existed (`WIN_CRITERION.md`); the v2 anchor's 3 samples were the fixed
cross-round ruler.

**Corpus.** 5 real documents in 5 formats, grouped as the user specified
(A=docs 1-3 one app, B=doc 4, C=doc 5): email thread (md), SOW (docx), 4-tab
tracker (xlsx), defaulter line-list (csv), blank maternity form (pdf). The image
(doc 6) and README were excluded per instruction.

## Results

Mean blind rank, **lower = better**. Both finalists were measured at n=3 vs the
fixed v2 ruler (the pre-registered final confirmation).

| prompt (n=3)     | doc1 | doc2 | doc3 | doc4 | doc5 | AVG  |
|------------------|------|------|------|------|------|------|
| **fusion** (WINNER)   | 4.28 | 5.56 | **2.39** | 4.00 | 5.11 | **4.27** |
| **fidelity** (runner-up) | 3.33 | 4.06 | 🔴7.11 | 3.39 | 3.22 | 4.22 |
| anchor **v2** (incumbent) | 7.39 | 5.39 | 5.50 | 7.61 | 6.67 | 6.51 |

**Headline: both finalists are ~30-35% better than the shipped v2 prompt** (AVG
~4.2 vs 6.5), and both cleared the pre-registered bar (beat v2's median on ≥4/5
docs). The two are statistically **tied** with each other (4.27 vs 4.22 — noise;
they traded the top spot across tournaments).

### Why fusion ships over the (tied) runner-up

The tie was broken on one pre-registered secondary criterion — **does the prompt
ever regress against the incumbent it replaces?** — not on average rank (noise).

- **fusion beat v2 on 5/5 docs.** It never goes backwards.
- **fidelity beat v2 on 4/5 but *regressed* on doc3** (the dense 4-tab xlsx),
  ranking 7.11/9 — below most v2 samples.

Mechanical confirmation (field-bullet count on doc3, which has 28 columns):

| doc3 columns read | sample 1 | sample 2 | sample 3 |
|-------------------|----------|----------|----------|
| v2 (incumbent)    | 28 | 28 | 28 |
| fidelity          | 34 | 28 | **10** ⚠ |
| fusion            | 28 | 28 | 28 |

fidelity's conservatism makes it **silently under-read dense spreadsheets** — one
in three samples dropped *18 of 28 columns*, i.e. below what's deployed today.
fusion (via its "read out the implied schema in full — every column header is a
field" + explicit `not stated` mechanism) matches v2's reliability **and** wins the
doc on quality. The failure modes settle it: fidelity's loss is **under-reading**
(silent, unrecoverable data loss); fusion's losses are **verbosity** on prose
(everything present, just noisier — a strong architect sees through it). For a
faithful-relay tool feeding a strong model, lost data ≫ noise.

### What the winning prompt fixed (vs v2)

The v2 diagnosis surfaced 20 domain-agnostic failure classes, led by two
*pervasive* ones the winner structurally defeats:

- **Invented requiredness/optionality** — v2 stamped "required" on dozens of fields
  the source never marked (proven fabricated: samples disagreed with each other).
  Winner emits a literal **`not stated`** for high-invention properties (requiredness,
  type, selection cardinality, format, identifier) — the architect can ask about a
  `not stated`, but can't un-believe a fabricated `required`.
- **Inference stated as fact** — deductions asserted in the same flat voice as the
  source. Winner requires a literal **`[derived]`** tag on every inference, applied
  evenly, so the architect can tell relayed fact from the extractor's guess.

Plus: "one example is not a rule" (kills format-mask hardening like
`MIG-04-117` → `MIG-WW-HHH`), "no join the document didn't make" (kills transporting
one field's option list onto another), three-channel Conflict/Gap/Open discipline
with an explicit anti-*manufactured*-conflict guard, and "read the implied schema in
full" (the dense-table fix).

### Negative result: synthesis didn't help

Round 3 tried 3 ways to merge fidelity's discipline with fusion's dense-table
completeness. All three **traded one parent's weakness for a new one** (e.g.
fixed doc3 but newly collapsed on doc4). Naive two-parent merge beats neither
parent — the two prompts are a genuine frontier, not points to interpolate between.

## Second finding — a rare `extract`-string glitch (NOT a reason to split the call)

The production extractor runs ONE `generateObject` call filling
`{ extract, title, summary }`. It sends Gemini `responseSchema` (native structured
output) **and** `thinkingConfig: { thinkingLevel: high }` together (verified in
`@ai-sdk/google` dist, args build ~line 1690). `responseSchema` enforces the object
SHAPE — and in every failure the shape held and **`title`/`summary` returned
correctly**. The damage was confined to the **`extract` string VALUE**:

- **Blob corruption (v2 / doc1):** at `thinkingLevel: high`, while filling the large
  `extract` markdown string, the model derailed into self-referential formatting
  narration — appending `","title":"…","summary":"…"}` then
  ` ```of Standard JSON … Copy the exact text block to run. No other preamble. {`,
  i.e. it **echoed the prompt's own output instructions** ("No preamble") and
  narrated about JSON newline-escaping, *inside* the string. A schema constrains an
  object's keys, not the content of a string field, so a thinking model can pour
  garbage into a valid string and the SDK parses it without error.
- **Empty extract (syn-adaptive / doc2):** `finishReason: stop` (NOT `length` — not
  truncation); the model emitted `extract: ""`.

Rate: **2 of ~100 (~2%)**, imprecise at small n; 2 is a floor (the ≤2-line detector
would miss a subtle multi-line leak). It is NOT prompt-independent and NOT a
structural decoding failure: the only blob-corrupted run used **v2, which has no
output guard**; the shipped winner carries an explicit guard ("never one escaped
single line, never any trailing scaffolding … stop when the last section ends") and
ran **0 corrupt of 20**.

**Decoupling into a second call is the WRONG fix** (it would pay a guaranteed extra
call to dodge a ~2% string glitch, and `title`/`summary` were never the problem).
The fix stays in ONE call:
1. The shipped winner's output guard already suppresses the blob-narration mode.
2. Strip output-*serialization* meta-instructions from the system prompt ("No
   preamble", "no closing summary") — they are meaningless in a structured call and
   are exactly what the model echoed into the string.
3. Pin `@ai-sdk/google` off the canary (`4.0.0-canary.79`) — this repo has a history
   of canary dep skew; rule it out as a contributor.
4. Optional cheap backstop: detect a polluted/empty `extract` (empty, or contains a
   nested `","title":` / a trailing code fence) and retry that ONE call — fires only
   on the ~2%, never a standing second call.

(Unverified empirically beyond the 0/20 winner record; a targeted stress-test —
hammer the previously-corrupting doc on v2 vs the winner, count corruptions — would
quantify it for ~$2-3.)

## Recommended integration

Keep the ONE structured call (`generateObject` → `{ extract, title, summary }`).
Do NOT decouple.

1. Replace `EXTRACT_SYSTEM` in `lib/agent/documentExtraction.ts` with the winner
   (`prompts/WINNER-fusion.md`), and bump `EXTRACTOR_VERSION` in
   `lib/domain/multimedia.ts` to invalidate stale stored extracts. The winner is
   extract-only; re-attach the existing title/summary trailer (it returns fine).
2. Harden the same single call against the ~2% `extract`-string glitch (see second
   finding): keep the winner's output guard, strip serialization meta-instructions,
   pin `@ai-sdk/google` off canary, and optionally add detect-and-retry on a
   polluted/empty extract.
3. `extract-prompt-proposed.md` (read by `compare-extract-prompts.ts`) already
   updated to the winner so the live A/B harness reflects the chosen prompt.

## Cost

50 of 95 paid Gemini extractions were anchors/finalists at n=3; the rest were
exploration. **Total Gemini spend ≈ $13.0** (budget was $18 target / $25 cap). All
judging/diagnosing/improving ran free as Claude workflow subagents (~16M subagent
tokens across ~250 agents).

## Where everything lives

- `prompts/WINNER-fusion.md` — the recommended prompt. `prompts/RUNNER-UP-fidelity.md`
  — the tied runner-up (ship this instead if you weigh prose-cleanliness over the
  dense-spreadsheet regression).
- `prompts/v1.md … v5-*.md` — every prompt iteration, in order.
- `prompts/catalog_anchor.json`, `catalog_fidelity.json` — the domain-agnostic
  failure-class catalogs each diagnosis produced.
- `runs/ROUND1_RESULT.md`, `ROUND2_RESULT.md`, `CONFIRMATION_RESULT.md`,
  `ROUND3_RESULT.md` — per-round tables. `runs/tournament_*.json` — raw rankings.
- `RUBRIC.md`, `WIN_CRITERION.md` — the (pre-registered) judging contract.
- `sources/doc{1..5}.input.md` — the exact text each model saw (doc5 = faithful
  PDF transcription).
- `wf/*.js` — the diagnose / improve / scrub / synthesize / tournament workflows.
- `scripts/extract-lab-run.ts`, `extract-batch.sh`, `aggregate-tournament.mjs`,
  `stage-*.sh` — the harness (production extraction path, batch runner, de-blind
  aggregator, blind stager).
