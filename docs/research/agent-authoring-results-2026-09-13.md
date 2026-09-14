# Agent authoring: integrated measurements

Nova's authoring boundary now accepts wording, expressions, and recognizable
names; canonical storage keeps typed expressions and stable identities. Creation
allocates identities and binds the complete addition before canonical admission.
The construction runner also supplies accepted form and module facts, so the
executor can concentrate on the questions and behavior it is building.

Tools report outcomes and consequential effects without repeated encouragement.
Design tools and construction tools have separate jobs. Construction discovery
uses the same workflow policy as dispatch, and the brief does not repeat its tool
inventory. Brief references use readable names without changing stored lineage
or literal source text. Large reused schema structures remain shared; scalar
indirection and single-use definitions are inlined without removing constraints.

These changes are intended to make correct work easier to express. Token counts
measure the interface, not app quality.

## Comparable local counts

The baseline and current measurements use the production `/agents` compositions
and the same o200k_base tokenizer. These are the complete catalogs, including
operations deferred until discovery. They are not opening request sizes.

| Role | Original prompt | Current prompt | Original tools | Current tools |
| --- | ---: | ---: | ---: | ---: |
| Editor | 16,934 | 623 | 148,191 | 63,349 |
| Construction executor | 6,277 | 377 | 176,393 | 57,254 |
| Design author, including capabilities | 8,638 | 3,424 | 27,812 | 20,771 |
| Design reviewer | 2,279 | 1,387 | 0 | 0 |
| Document extractor | 5,672 | 1,344 | 0 | 0 |
| Executor helper | 195 | 214 | 0 | 0 |
| Translator | 196 | 196 | 0 | 0 |
| MCP guidance and catalog | 19,003 | 831 | 206,617 | 69,330 |

The largest editor definition is now about 4,400 local tokens. Complete editor,
executor, and MCP catalogs remain above the aspirational 20,000 tokens. Deferral
makes loading selective; it does not make a large definition free or clear.
These counts exclude app-specific messages and one-shot response schemas.

## Provider serialization

On September 13, current tool mounts were serialized through the actual AI SDK
and sent to OpenAI's [input-token counting endpoint](https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count).
Each count includes the role's static instructions and the same short synthetic
request. No generation was requested. The full-catalog comparison removes hosted
search and deferral from the same serialized functions. The executor figure is
the entire construction inventory; a live workflow exposes its permitted subset.

| Role | Original full catalog request | Current full catalog request | Current deferred request | No tools |
| --- | ---: | ---: | ---: | ---: |
| Editor | 200,604 | 60,727 | 7,461 | 638 |
| Construction executor | 221,882 | 55,654 | 6,246 | 392 |
| Design author | 29,953 | 19,564 | 4,900 | 3,439 |

Deferred requests still incur discovery metadata. The local count of nondeferred
function schemas alone would substantially understate these requests. Actual
loaded tools and growing working context must be inspected in recorded runs.
The largest current editor/executor function adds 4,495 provider tokens beyond
instructions and input; the largest design function adds 4,084.

## Document extraction

The extractor now separates source requirements from decisions the architect can
make. It preserves exact labels, conditions, formulas, contradictory statements,
uncertainty, and figure provenance without declaring every unstated implementation
detail a problem. One global convention covers unstated field attributes.

A bounded comparison used three synthetic sources: an intake form with conflicting
requiredness and an unresolved access question; a real XLSX with formulas, dirty
choice values, and missing coordinates; and provisional referral notes with an
unreadable handoff figure and a missing indicator annex. Sol at medium effort and
Luna at high effort both returned usable extracts with the final prompt.

| Source | Sol medium | Luna high |
| --- | ---: | ---: |
| Intake | 16.9 s | 16.6 s |
| Workbook | 34.9 s | 65.0 s |
| Referral notes | 11.1 s | 17.5 s |

Sol preserved the core requirements with fewer invented design questions and
less repeated uncertainty. It is the selected extraction role. Neither model was
perfectly concise: some field uncertainty and layout punctuation remained. This
small, unblinded sample does not establish performance on long PDFs or difficult
images; existing converter and figure-admission tests cover those deterministic
boundaries, not extraction quality.

Earlier baseline attempts remain part of the evidence: one old-prompt Luna xhigh
request failed during SDK stream decoding and another exhausted its 8,000-token
cap without an extract; a 32,000-token attempt
reached the five-minute watchdog. An intermediate new prompt completed but
invented unnecessary design questions, which prompted the final rewrite. The
three unmetered baseline attempts retain their full dollar reservations. They
are not counted as free requests or successful comparisons.

## Validation boundaries

Independent JSON Schema admission checks cover constraints and recursion through
schema simplification. Real workspace and Postgres tests cover mutation refusal,
accepted writes, scoped construction, and recovery. Tests of authored identity
projection check that references remain connected, duplicate names stay distinct,
and identity-shaped source text stays literal. Native SDK transport tests retain
provider serialization, cancellation, and request capture.

Prompt hashes, frozen tool orders, text-presence inventories, and source-file
existence sweeps were removed. They could require fixture updates after edits
without demonstrating useful behavior. The retired native/JavaScript prototype
implementations and their tests were also removed; Git history retains the
research, while the evaluator now uses production prompts and tools.
