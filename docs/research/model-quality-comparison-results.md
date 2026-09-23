# First-delivery model comparison results

September 23, 2026. The bounded comparison is complete with an incomplete final
GPT-6 trial at the shared budget guard. The production default remains GPT-5.6.
GPT-6 improved cost and some writing, but completed role-based trials did not
establish equal or better first-delivery quality. The all-role upgrade remains
a draft. Infrastructure corrections do not retrospectively pass failed apps.

The method is in [model-quality-comparison-method.md](model-quality-comparison-method.md).
Requests, source documents, generated app names, identifiers and full transcripts
remain private. The complete role set is compared at unchanged reasoning efforts:
Sol medium for architect, peer, extraction and translation; Luna xhigh for editing.

## Completed comparisons

| Task and model | Requests | Token-derived cost | Returned tool errors | Independent result |
| --- | ---: | ---: | ---: | --- |
| Document-led bilingual build, GPT-5.6 | 80 | $3.742340 | 0 | Tested browser and native boundaries passed |
| Same source and request, GPT-6 | 79 | $1.275410 | 2 | Tested browser and native boundaries passed |
| Separate edit, GPT-5.6 | 32 | $0.037822 | 1 | Browser, persisted values and native submission passed |
| Same edit request and starting app, GPT-6 | 19 | $0.013097 | 1 | Browser, persisted values and native submission passed |
| Initial related-record build, GPT-5.6 | 208 | $6.699490 | 11 | Tested role, return and retained-history journeys passed, with stated limits |
| Initial related-record build, GPT-6 | 159 | $1.912602 | 5 plus terminal failure | Failed before handoff; missing test discovery and wrong error classification |
| Corrected matched related-record build, GPT-5.6 | 212 | $7.287828 | 9 | Tested serial workflow passed, with completion-wording and concurrency limits |
| Corrected matched related-record build, GPT-6 | 224 | $3.362590 | 9 | Failed full acceptance: duplicate prevention unresolved and overdue highlighting removed |
| Fresh role-based visit/history build, GPT-5.6 | 147 | $4.793439 | 5 | Browser, persisted history and stored-answer native checks passed, with stated limits |
| Same request and production tools, GPT-6 | 234 | $3.677731 | 7 | Failed first entry: required prerequisite records absent, no creation path |
| Repeated-record task, GPT-5.6 | 190 completed; one charge uncertain | $7.555687 known | 20 | Core workflow omitted; final review timed out |
| Same task, GPT-6, including ordinary clarification | 296 | $6.147800 | 29 unique | Core workflow omitted despite useful ordinary answers |
| Final simpler related-record task, GPT-5.6 | 165 | $5.261829 | 8 | Main entry/sharing/history journey passed; unrequested positive-only count fails the zero-count criterion |
| Same final task, GPT-6, including ordinary clarification | 49 | $0.610479 | 4 unique | Budget-limited before saved-app review or handoff; no ordinary Preview entry |

The bilingual pair's captured runner, prompt, orchestrator, loop, authoring tools,
session and translation source hashes match; model-role configuration differs.
Each family extracted the same source independently, and that extract was used
in its build. The editor comparison is a separate task, not a substitute for an
initial build. No run received expert corrective edit instructions.

The GPT-6 bilingual output used conditional requiredness on a dependent question,
with a visible marker and an error at the missing answer. GPT-5.6 enforced the
same requirement through a constraint on the earlier choice; it rejected an
incomplete form but presented the error less clearly. GPT-6's extract retained
the consequential source facts in 3,189 characters versus 4,713, with fewer
unnecessary qualifications about obvious field types. Its final handoff more
directly described entry, tested behavior and remaining deployment work.

GPT-6 still made mistakes: an incomplete answer path and an invalid translation
cursor in the bilingual build, and a mistyped form identity in the edit. All
recovered. GPT-5.6's edit omitted a required field-kind argument and recovered.
These observations do not establish a lower hallucination rate.

The editor's call reduction partly reflects different verification choices:
GPT-5.6 ran isolated submission journeys; GPT-6 used narrower form evaluations.
Independent browser/Postgres and CommCare Core checks established the actual
saved effects for both. Fewer calls alone are not evidence of better review.
Both generated edit reviews had a minor wording weakness when a required answer
was still blank.

## Corrected related-record comparison

After the test-discovery correction, the new matched pair reached handoff without
operator corrections. GPT-6's peer independently reproduced duplicate creation
and a due-today record incorrectly highlighted as overdue. It also found ambiguous
record labels, which the architect corrected. The architect left duplicate
prevention as a manual search instruction and removed overdue highlighting. A
candid handoff does not fulfill those requirements. GPT-5.6 implemented the local
uniqueness check and overdue display more completely.

The date finding exposed a shared runtime defect: SQL used the database day while
form expressions used the worker runtime's day. PR #674 corrects that contract;
it does not retrospectively pass either app near the boundary. The missing query
guidance and a Details/Continue observation gap are addressed separately. Browser
inspection found an already-completed task could be entered again and accept
answers while its guarded operations saved no new record. Earlier app tests
skipped Details and therefore observed a different return destination.

The corrected pair used 212 versus 224 requests and cost $7.287828 versus
$3.362590. GPT-6 was cheaper but did not deliver the better app on this task.
GPT-5.6's handoff also incorrectly described ordinary Preview records as
disposable; only isolated app tests have that property.

## Fresh role-based visit/history comparison

The next pair used the same request and matching production prompts, tools and
runtime after PR #675. Neither asked a clarification question or received an
operator correction. GPT-5.6 produced two custom record types and three modules.
Independent browser checks created the first records, switched saved roles,
recorded later and backdated visits, rejected incomplete and future-dated entries,
and resolved an older problem while retaining a newer unresolved one. Postgres
confirmed the distinct retained records. The current summary is explicitly
last-entered rather than latest by visit date; the handoff also honestly explains
that list filtering is not a confidentiality boundary.

GPT-6 produced five custom record types and seven modules. Its peer reproduced
ownership that hid newly created records from volunteers, ambiguous same-day
labels and a history route blocked after resolution. Those findings caused real
corrections without operator help. However, the ownership redesign introduced
prerequisite parent records, no in-app route to create them, and an unagreed
external provisioning task. The peer tested only with supplied prerequisites
and accepted that dependency. Ordinary browser entry reached an empty required
selector. No prerequisite data was supplied to rescue it. This first delivery
failed despite its useful internal review and candid setup notes.

GPT-5.6 used 92 architect and 55 peer requests; GPT-6 used 104 and 130. Current
plans grew from 5,989 to 10,489 and 4,847 to 10,576 characters respectively.
GPT-6 was cheaper again, but did more review without delivering a usable start.
The release remains held. General first-use readiness guidance and input
provenance shipped in PR #676; this failed task informed development and cannot
serve as untouched acceptance for that correction.

The GPT-5.6 export passed local HQ generation and Core execution of direct and
HQ-regenerated forms, including stored-answer duplicate validation, owner/group
writes, date bounds and isolated history updates. Candidate-answer validation
before storing the answer did not detect the duplicate in Core: nested query
context reads the existing form value. The actual Core `FormController` completion check now rejects the stored
duplicate in both exports. The inspected Android save path calls that check
before completing the form; this supports the inference that completion blocks
the duplicate, while immediate feedback differs. Actual Android UI and remote
WebApps submission remain unobserved. An immediate browser Details transition also
briefly showed an older summary; a fresh read and storage showed the last-entered
value. Persistent staleness was not established. The app-test/browser return-screen gap informed PR #675, and selection lifetime
was corrected in PR #677. These changes do not alter the earlier outcome.

## Later trials and the release decision

Both models failed a subsequent repeated-record task: they removed the central
workflow after failing to discover or use available row identity. GPT-6's peer
reproduced real failures, and the architect asked ordinary design questions.
Helpful answers did not restore the requested workflow. GPT-5.6's final review
hit the time bound. Neither output received an expert repair prompt. This task
informed generic repeat-context and section-entry corrections in PRs #678/#679;
those corrections are excluded from both measured outputs.

The final simpler pair used the same frozen request and PR #679 runtime. Both
used a 32,000-token output limit including reasoning, below the earlier 128,000
ceiling. GPT-5.6 completed with three saved worker identities, a usable empty
start, shared parent records, independent child submissions and retained history.
Ordinary browser actions, real Postgres and exact-export Core execution confirmed
the main journey. Its peer corrected a missing history filter and unclear first
entry. However, an unrequested minimum of one excludes zero-count entries, so
the full frozen criteria did not pass without qualification. The architect
repeated a broad journey after correction despite the peer's narrower reuse of
earlier evidence. Its plan grew from 7,041 to 10,967 characters and largest input
reached 87,678 tokens.

The same run exposed a real product defect: form admission rejected built-in
record ownership and suggested a custom property. PR #680 fixes admission and
attribute/child projection across Preview and native export, with independent
Core evidence. It is excluded from both final trials, not credited as a model
correction.

GPT-6 asked a useful question about offline uniqueness, and the ordinary answer
accepted its recommended sync-first process and coordinator review with honest
limits. After 17 first-turn calls and 32 continuation calls, the shared guard
refused another dispatch. The saved app had no ordinary Preview entry and no
final app review or handoff. This is an incomplete budget-limited result, not
proof that GPT-6 could not complete with more budget. Its draft allowed zero;
that isolated improvement does not establish a better delivered app.

The shared conservative ledger ended at $97.683844175 of the $100 authorization,
including a retained $12.0060125 uncertain-charge reservation. A further request's
worst-case allowance exceeded the remaining amount. Reported token costs are
lower than this ledger because it includes margins and unknown charges. No new
paid trials are authorized by an apparent gap between those amounts.

The release decision is to keep GPT-5.6 defaults and retain the all-role GPT-6
upgrade for a future quality decision. Extraction, translation and editing were
exercised alongside architect/peer behavior; no partial model switch is claimed.
Useful bounded first deliveries exist, but broad autonomous quality remains
unfinished in the active plan. The private comparison preserves full extracts,
completion messages, concrete better/worse examples and independent evidence.

## Context and cost

| Bilingual build metric | GPT-5.6 | GPT-6 |
| --- | ---: | ---: |
| Input tokens, including cache | 4,163,009 | 3,049,579 |
| Output tokens, including reasoning | 27,603 | 18,643 |
| Cache-read tokens | 3,801,552 | 2,831,115 |
| Cache-write tokens | 223,831 | 171,658 |
| Largest call input | 109,606 | 74,758 |
| Current-plan characters, first to last | 7,887 to 9,145 | 3,724 to 5,216 |
| Identical read calls beyond the first | 10 | 12 |

The bilingual run cost about 66% less with GPT-6 at the measured rate card.
That combines changed token use with changed prices; it is not a claim that each
model price fell by that percentage. The separate GPT-6 edit emitted more output
tokens despite using fewer calls and less total input. Repeated reads can be
justified by independence or corrections and must be inspected before calling
them waste.

| Corrected related-record metric | GPT-5.6 | GPT-6 |
| --- | ---: | ---: |
| Input tokens, including cache | 12,199,531 | 11,757,625 |
| Output tokens, including reasoning | 36,065 | 32,367 |
| Cache-read tokens | 11,792,285 | 11,429,686 |
| Cache-write tokens | 220,630 | 194,210 |
| Largest call input | 108,860 | 89,827 |
| Current-plan characters, first to last | 8,409 to 11,360 | 4,919 to 9,013 |
| Identical read calls beyond the first | 11 | 9 |

Final architect requests contained 113 function definitions: 11 initially loaded
and 102 deferred. Ordinary editor requests contained 103: one initially loaded
and 102 deferred. Serialized requests still contain the complete definitions.
Deferral is not removal. Per-request evidence retains definition counts, request
bytes, evolving messages and actual usage; `/agents` distinguishes current code,
recorded history, initial loading and the full catalog.

Costs use reported usage and the September 22 published rate card, including
cache reads/writes and GPT-5.6 Sol's published promotion. Historical stored costs
are not rewritten. The separate shared budget ledger reserves before dispatch,
settles known usage with a 25% margin and retains uncertain charges.

## Evidence limits

Independent browser checks started at ordinary app entry and used saved identities.
Related-record checks inspected real local Postgres effects and later visits.
Native checks parsed suites, initialized exported forms in CommCare Core and
processed case transactions. The bilingual forms also passed Core execution after
regeneration through actual local HQ classes with network access refused. The corrected GPT-5.6 related-record export also passed the full local HQ suite
check and Core execution of regenerated forms. The GPT-6 local HQ suite check
encountered a dependency incompatibility; its directly exported forms passed
Core, but that does not establish the full HQ route.

A separate Core session execution applies the related-record export's actual
post-entry stack. It retains the selected record and next requests a form
command. This does not establish the Android screen or autoselection behavior.
PR #675 lets the peer observe the browser's distinct Details screen and its
Continue/Back actions; it does not silently treat native previous navigation as
a return to record selection.

Preview survey receipts do not archive complete report answers. Deployed report
retrieval, physical-device behavior, GPS capture and offline sync remain unproved.
The related-record output states limits around manual duplicate checking and
simultaneously open stale forms. Earlier development failures remain recorded in
[ordinary-authoring-first-delivery-audit.md](ordinary-authoring-first-delivery-audit.md).
The delivered production app's repair remains supervised evidence. Missing real
deployment accounts and places were not fabricated to make acceptance appear complete.

This small set supports bounded improvements in usability, writing and cost. It
does not establish universal reliability or a general model ranking.
