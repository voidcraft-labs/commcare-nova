# Authoring pilot: write content, bind identities in Nova

Native tools are the selected direction for the next implementation slice.
Agents supply authored wording and expressions; Nova resolves their references
before the existing canonical tools prepare mutations. This removes storage
encoding from the model's task without weakening identity or validation.

The client pilot establishes feasibility. It does not establish general quality,
complete feature coverage, or an optimal prompt. The production SA, executor,
and MCP remain unchanged in this slice. The [delivery plan](../plans/agent-authoring-quality.md)
continues with the complete shared authoring boundary.

## What ran

Nine bounded trials used GPT-5.6 Luna at `xhigh`, `store: false`, with at most
12 model steps, 12 requests, 12,000 output tokens per request, no HTTP retries,
and a five-minute abort. Each used a disposable local app with an existing
Survey. The task added registration, age validation, conditional phone capture,
an answer-bearing thank-you note, name Search, and a follow-up phone update.
A fresh edit turn then clarified that the adult-only phone rule applied in both
forms, requested an age-field rename, and required preserving unrelated content.

The baseline used the actual current editor prompt and its 94 tool definitions.
Native and hosted JavaScript candidates shared the same eight-operation pilot
interface and 115-token orientation. Both candidates used the existing canonical
workspace, mutation preparation, commit gate, and actual local Postgres writes.
The JavaScript candidate used OpenAI's hosted programmatic tool, with the native
functions available to its program. No custom JavaScript runtime was built.

The [sanitized results](agent-authoring-2026-09-12/pilot-results.json) include
every attempt, reported usage, termination, conservative cost, and observations.
Exact request bodies, tool definitions, replies, before/after documents, and
archives remain in private local artifacts. Capture happens at the provider
fetch boundary and excludes headers. Later trials also snapshot the interface
source. The saved request and definitions are authoritative where early version
labels were not advanced between edits.

| Trial | Model steps | First request input tokens | Outcome |
| --- | ---: | ---: | --- |
| Native creation 1 | 9 | 4,069 | Built after a record declaration repair; Search unavailable |
| JavaScript creation | 12 | 4,378 | Built, then reached the limit without a final reply; Search unavailable |
| Native creation 2 | 8 | 3,531 | Built after a case-write repair; Search unavailable |
| Current creation | 5 | 200,859 | Built with name Search after a creation repair |
| Native repair 1 | 12 | 3,707 | Failed at the limit; name binding and selected-record context were incomplete |
| Native creation 3 | 8 | 3,760 | Built with name Search after a column-kind repair |
| Native repair 2 | 5 | 3,767 | Completed; all four edits committed without rejection |
| Current repair | 4 | 201,606 | Completed |
| JavaScript repair | 9 | 4,592 | Completed |

These are provider-reported input counts for whole requests, not isolated tool
counts. Local tokenizer estimates are a separate series. The baseline starts
with the production app-state message; the candidates inspect the app. This is
a comparison of complete interfaces, not a controlled prompt ablation.

Conservative generation spend across all nine trials was **$0.6252**. The ledger
prices every input token as uncached and adds 25%; actual billing may be lower.
Unknown request outcomes retain their reservation. Seven earlier official
input-token counting probes did not generate model output. No broad paid schema
sweep ran.

Independent review found two guard defects after the trials: concurrent runners
could overwrite the shared ledger, and missing usage could release a reservation.
The evaluator now takes an exclusive ledger lock, saves reservations atomically,
and retains the charge for completed responses with incomplete or invalid usage.
The recorded trials were sequential and all supplied usage, so these findings
do not change their reported spend. A crashed owner's lock requires inspection
before another run; it is not automatically treated as stale.

## What changed because of the failures

The first interface proposal still asked models to construct protected prose
parts. That was unnecessary author work. Wording now uses ordinary Markdown,
with answer interpolation in the string. Expressions use Nova's existing
XPath grammar and named references. Those small syntax rules live beside their
arguments, not in the orientation. Canonical typed references remain internal.

Creation allocates field identities before binding the whole operation, so a
condition can refer to another field in that call. An edit that renames `age`
to `age_years` can use either path during that operation; both resolve to the
same UUID. Ambiguous paths reject. A selected-record reference binds to the
actual case type, rather than storing a contextual alias. Bare unresolved names
reject before a mutation can commit. The failed first repair exposed these
missing capabilities; adding more instructions would not have fixed them.

Record declarations lost form-only validation slots. Capture-only write mode
was removed from ordinary field writes. Search was added when the early trials
showed that a visible name column did not fulfill the requested search behavior.
Read results now use the same content shapes accepted by edits, including
validation messages and close conditions. Choice-label edits preserve option
identities; unsupported media replacement refuses rather than losing content.

Preparation failures return concise paths and causes. Authoritative commit
errors still reach the workspace's reload and concurrency handling. The pilot
retains legacy success messages when they carry real side effects; replacing
those with structured effects belongs to the complete shared-boundary slice.
Blindly deleting such messages could hide an implicit default or data removal.

## What the resulting apps demonstrate

The final repaired current, native, and JavaScript apps all passed the same
production Preview observations with persisted local case rows:

- Registration rejects ages -1 and 121 and accepts 0, 17, 18, and 120. Name and
  age stay required. Phone is hidden at 17 and visible at 18.
- The thank-you note resolves the entered name without claiming an unsubmitted
  form has already saved its data.
- Follow-up phone is optional, hidden at 17, and visible at 18. Blank submission
  remains valid. Its projected update touches only the phone property.
- The original Survey remains structurally unchanged. The renamed age field
  keeps its UUID, requiredness, bounds, and dependent phone condition.

All three also compile to CommCare archives. An independent ZIP/XML reader
parsed every XML document and checked the age binding and the selected-case
reference emitted for follow-up. This is compilation and structural evidence,
not device execution or an HQ deployment test. Name Search was inspected in the
canonical configuration; this pilot did not exercise the live Search UI.

An observation error was caught during review: the initial follow-up harness
provided preloads but omitted the structural case database snapshot used when
a real row has `case_id`. This made age 18 appear hidden for both compared apps.
The harness now passes the actual persisted rows to Preview; reruns passed.
The incomplete observations remain labeled in private artifacts and are not
counted as app failures. Similarly, an XML diagnostic initially expected an
absolute age path in every constraint; the baseline correctly used XPath `.`.
The diagnostic now checks structure while runtime scenarios prove bounds.

## Decision and remaining limits

Use native tools for the production redesign. The model completed the corrected
task through ordinary calls, and authored strings preserved the canonical
identity guarantees. Hosted JavaScript also succeeded but did not demonstrate
better app behavior here. It adds program execution, output shaping, and durable
replay responsibilities. The local adapter remains only as reproducible research
until the experiment is retired, never as a parallel production interface.

The experiment is intentionally incomplete: only eight operations, a subset of
field kinds and sources, plain Results columns, and scalar Search are exposed.
Advanced XPath instance/attribute paths, media-aware option replacement, repeat
variants, lookup-backed choices, localization, Connect, and the rest of Nova's
capabilities require explicit coverage before any production switch. The current
baseline's external-resource operations were also restricted to the local
fixture; its attempted menu-media call was refused. Do not attribute that refusal
to model quality.

Trials were sequential and the interface changed between them. The creation
task's adult-only follow-up expectation needed clarification. Follow-up trials
start a fresh model turn on each candidate's saved app, not a replay of the
previous conversation. JavaScript had no explicit result schemas. There were
no blinded reviewers, repeated final-version samples, held-out tasks, Astra
comparison, process-recovery test, or full feature study yet. These limitations
preclude a claim that the short prompt produces better apps in general.

The next slice must make the chosen interface complete and coherent across SA,
build, MCP, inspection, and guidance. Keep stable identity, canonical admission,
tenant authority, and durable recovery below that interface. Then evaluate the
integrated design and editing workflows on broader and held-out cases.
