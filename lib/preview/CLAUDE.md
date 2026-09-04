# Web Preview Engine

Client-side form preview running entirely from the in-memory blueprint, with no
XForm parsing and no server-side evaluator. Three subsystems own it: the XPath
evaluator, form engine, and preview UI. **Preview is part of valid by
construction.** Every XPath function, signature, path initializer, and instance
namespace Nova admits for a surface must execute faithfully in that surface's
Preview context and must emit faithfully to the owning CommCare runtime. The
capability tables keep independent runtime evidence, but they do not authorize
an authorable Preview subset. Adding an authorable capability therefore adds
its Preview implementation and its CommCare proof in the same change.

`regex()` and `replace()` target Formplayer's OpenJDK 17 `Pattern` contract,
which is the one stable CommCare host runtime. TeaVM compiles the pinned
OpenJDK sources to static JavaScript under `xpath/vendor/`; this is not native
JavaScript `RegExp` and not WebAssembly. User-authored patterns run only in the
bounded XPath worker because Java backtracking can be expensive. The JDK 17
character-name table for `\N{name}` is a separate lazy chunk. The finite,
reviewed patterns Nova generates itself may use the synchronous allowlist in
`generatedJavaRosaFunctions.ts`. The host timeout is a CPU watchdog, not a wall
clock limit on JavaRosa semantics: a worker `sleep()` pauses it while its
worker-owned timer is pending and resumes a fresh watchdog window afterward.
Cancellation terminates the worker generation out of band: a synchronously
backtracking Java Pattern call cannot consume an ordinary cancel message, so
settling its host Promise must never clear the only CPU bound while leaving the
worker alive.

`pow()` uses OpenJDK 17's portable fdlibm computation from that same generated
runtime. Java permits `Math.pow` implementations within one ulp, while TeaVM
normally lowers it to JavaScript `Math.pow`; V8 has produced adjacent doubles
across architectures. The explicit fdlibm path gives Preview one reproducible
result within JavaRosa's contract before OpenJDK 17 number-to-text formatting
sees it.

The provider owns that worker runtime through a re-armable `resume` / `suspend`
lifecycle. Effect cleanup terminates every worker and timer, but it never uses
the one-way terminal `dispose`: React Strict Mode replays cleanup and setup on
the same state-created controller in development, so the second setup must be
able to open a fresh generation.

The Search screen has its OWN worker runtime beside the form's. A runtime
admits one active worker scope `(entryKey, profile)` and retires the active
scope when a different one arrives, so routing a Search prompt's `required` /
`validation` evaluation through the form runtime would retire a form's world
every time a worker typed on the Search screen. The provider therefore creates
a second `createBrowserXPathRuntime` and hands it to the controller as
`searchXPathRuntime`; `engineController.ts::evaluateSearchScreenXPath` requests
under `search:<moduleUuid>` with the `search` profile and only the
`commcaresession` secondary instance. It is needed because a user-authored
`matches-pattern` runs ONLY in the worker (the JDK `Pattern` runtime is
worker-only; the synchronous JavaRosa function table returns `unsupported` for
a user pattern). `engine/searchInputConstraints.ts` is the split:
`searchInputConstraintErrors` is synchronous and leaves a pattern-bearing
constraint unjudged (the server action does the same, so the sync path never
guesses), and `searchInputConstraintErrorsOnDevice` awaits the worker for those
constraints through the `evaluateOnDevice` callback `CaseListScreen` supplies.
Both judge `required.when` and `validation.rule` with the sibling answers
bound, blank for the unanswered, exactly as Core does.

The device-casedb readiness gate is committed in a layout effect. Descendant
form activation runs in passive effects, so the gate still arrives first, but
an interrupted or discarded render can never mutate the long-lived controller
with a snapshot or loading/error posture React did not commit.

An unsupported evaluation reached from a persisted document is an internal
invariant violation, never an ordinary historical-app state or a user repair
flow. Defensive containment must keep the Builder navigable, report the defect
through internal diagnostics, and avoid inventing a plausible result. That
backstop does not relax mutation admission, migration, or runtime parity: Nova
must continue supporting the stored expression or migrate it faithfully before
the old capability can be removed.

Each controller revision owns one worker evaluation world. Its first request
copies the main structure plus the engine-lifetime secondary snapshots; later
expressions reuse that world and carry only changed main-instance scalar
values and their expression-local context. A topology change reinitializes the
world. Repeat cardinality participates explicitly in that topology signature;
a zero-row bound repeat retains one dormant template subtree whose value keys
alone cannot distinguish it from a live row. Never restore recursive
per-expression instance snapshots: a form with many expressions over a large
casedb/fixture set must not clone that entire world once per expression.

Case-type and `#user/` hashtags cross that worker boundary as addresses into
the frozen casedb snapshot, not as pre-coerced strings. They remain nodesets
until the evaluator applies JavaRosa coercion, so `count()`, `boolean()`, and
other node-aware functions observe the same identity and cardinality as the
expanded wire selector. A scalar fallback exists only when Preview has no
structural usercase projection at all.

The casedb projection separates schema from cardinality. Dynamic property and
index names remain valid through template metadata, but an absent property or
index identifier is an empty nodeset and `count(...)` is zero; Preview never
materializes a blank synthetic element. Property text follows the declared
case-property type before it enters XPath, including Java `Double.toString`
lexical output for decimals (`0` is `0.0`). Index `@case_type` comes from the
type captured on the stored edge, not the target case's current type.
The device snapshot carries the stored schema's property types for every row
case type, including a type retired from the current blueprint. Stored types
win property by property while a blueprint retype awaits schema healing;
active materializable declarations fill properties absent from the stored
catalog. This prevents existing decimal/date JSON from silently changing XPath
text during either window.

The casedb load signal is structural too: any admitted `#<case-type>/*` or
`#user/*` carrier needs the same device snapshot as an explicit
`instance('casedb')` reference. Query-bound repeats preserve each selected
node's lexical value across the worker boundary and seed it as the flattened
Preview row's `@id` (plus the zero-based model-iteration `@index`) before child
calculations run. Keeping only nodeset cardinality breaks the canonical
`current()/../@id` expression even though the repeat appears to have the right
number of rows. A scalar ids result follows Core's `DataUtil.splitOnSpaces`
exactly: only U+0020 runs separate ids, a leading empty id survives, and
trailing empty ids do not.

The structural world includes nodes the emitted form supplies even when Nova
has no value for them. The main `/data` root exposes the same `uiVersion`,
`version`, and slugged `name` attributes as the XForm. The
`commcaresession/session/context` template uses the complete Core namespace,
including `drift`, `window_width`, and `applanguage`; an unavailable value is
an absent node, not an unknown path.

Raw answer writes commit synchronously and remain in `pendingValuePaths` until
some current revision settles their cascade. Every successor revision first
reconciles those paths, so blur, validation, repeat changes, and submit cannot
retire an answer calculation and then observe stale state. User-controlled
repeat add/remove revisions are atomic within an entry: later browser events
queue behind topology mutation, defaults/cascade, and compaction publication.
Navigation may still retire the whole entry and discard its engine.

Running navigation preserves the requested leaf across parent-case selection.
A direct Form or Results record that needs one or more case parents first visits
those selectors in case-type order, then replaces the selector with that exact
original location. Selector URLs are replace-driven and their ephemeral request
clears on cancel, browser Back, or unrelated navigation. Menu nesting never
implies case ancestry: the required selector comes from `CaseType.parent_type`
and may be a structurally unrelated module. Once selected, a direct same-type
child Form binds the exact inherited menu case; a different-type child lookup
is constrained by the selected parent and must never fall back to an
unfiltered first row. Direct Results records are checked against that same
parent before their detail is shown.

## First-class date type in the XPath evaluator

XPath values include a `XPathDate` alongside string/number/boolean. `today()` returns a date (days-since-epoch internally, ISO string on coercion), so `today() + 1` yields tomorrow, not `NaN`. CommCare's arithmetic converts dates to day numbers; compatible typed emitters add the required wire coercion themselves. The experimental raw-XPath transpiler is not a production boundary and Preview must never assume that it ran.

Always use the shared XPath-to-string helper when stringifying results. Native `String()` on a date value gives `[object Object]`.

## Two `Child` / `Descendant` node types in the grammar

The Lezer grammar emits TWO distinct `Child` node types (one from the root-step rule, one from the expression rule) and likewise two `Descendant` types. `one('Child')` only finds the first. The evaluator and dependency extractor use `many('Child')` plus a `Set` / `.has()` check to catch both.

## Form engine lifecycle rules

- **Default values apply one-time on init, AFTER one-case case-data preload.** One-case data sets the initial state and defaults only fill unset fields. An authored several-case follow-up or close form never chooses one selected row to preload, even when its runtime selection contains one id. Its defaults therefore fill the initially blank shared answers.
- **Required validation is deferred to submit.** Showing "required" on blur is bad UX because the user may have clicked in and navigated away. The red asterisk communicates requiredness until submission.
- **A temporal answer's SHAPE is checked, and it rides with authored validation, not with required.** A clock is typed, so it is the one answer a person can half-finish into something that is not a value of its type at all — `"abc"` is a legal string, `"2:3"` is not a time. `temporalShapeError` asks `lib/domain`'s `isStorageTemporalValue` and, on a miss, replaces the field's message with one naming what was entered. Riding with authored validation puts it on blur (the moment the answer stopped being half-typed) and again for every field at submit, so a half-typed clock can neither slip past nor be judged by an XPath rule that has nothing useful to say about it. An empty answer is not ill-shaped — that is `required`'s question. Without this the value reaches the case store and returns as a schema rejection naming a property instead of a question.
- **`reset()` is a full reinitialization** — rebuild instance, re-preload, reapply defaults, re-cascade. Returns to the exact initial state.
- **`resetValidation()` clears touched state + errors only** — called when leaving test mode so fields start clean on re-entry.

### Two-state JSONB collapse for form completion

`computeSubmissionMutation` reads each leaf field's value via
`instance.get(fieldPath)` and filters on emptiness only
(`if (raw === undefined || raw === "") continue`); empty fields
are excluded from the emitted mutation, hidden fields with non-
empty values are NOT excluded. Properties whose value is empty
do not appear as keys in the mutation's `properties` object,
which means the case-store write omits them from the JSONB
document.

AJV's strict-mode constraints rule out the alternatives: `null`
fails `integer` / `number` types; `""` fails `format: date` /
`format: time` / `format: date-time` / the geopoint pattern.
Omission is the only shape that passes validation AND aligns
with Postgres missing-value semantics ("absent" ≡ "not present
in the JSONB document").

Case-write collection is not a second Preview model. `FormEngine` derives
`lib/domain/caseWriteInventory.ts` for its active form and immediately crosses
the shared `assertAndProjectCaseWriteInventory` boundary used by CommCare
lowering. That boundary admits the exact own/direct-child bucket membership and
forces every writer/repeat path through the private typed `FormPath` projection
once. Preview then materializes those admitted bucket objects against live
values: it trusts `bucket.kind`, carries the writer's explicit destination
property, and asserts that the runtime's nearest repeat UUID equals the
bucket's nearest repeat UUID before creating a concrete per-iteration child.
It never reclassifies primary/child membership from case-type text, field ids,
or rendered paths. The engine input uses `materializableCaseTypes(doc)`, so
writer-derived properties are typed without inventing a separate unknown-
property admission rule.

The standard writable scalars are a separate, explicit projection:
`case_name` and `external_id` never enter the JSONB `properties` object.
Preview routes them through the primary/child scalar slots that the submission
envelope maps to `cases.case_name` and `cases.external_id`. Both use the shared
Java `String.trim` boundary (only U+0000 through U+0020) and the 255 UTF-16-unit
limit. An active blank `case_name` is invalid; an active blank `external_id` is
a real `""` write that clears the value. A missing or irrelevant writer is no
intent and preserves the existing scalar. The primary destination in an
authored several-case form has one additional safeguard: a normalized blank
`case_name` or `external_id` is also no intent, because one shared blank must
not erase that scalar across every selected case. Child creation keeps the
ordinary scalar rules. When an ordinary field writer and a case operation both
target `external_id`, the ordinary form action runs last and wins, matching the
emitted CommCare transaction.

Form completion produces only 2 of the 3 spec-defined JSONB
states (absent / null / present-and-empty) — the
"present-and-empty" state is unreachable via any form completion
path. Other write paths (sample-data generator, direct API
writes) can still produce it. Consumers of `is-blank` should
read `lib/domain/predicate/CLAUDE.md` § "Null vs blank semantics
— locked invariant".

Every case-bearing submission lands through the case-store's atomic
envelope: `submitFormAction` projects the engine's `SubmissionMutation`
onto `CaseStore.applySubmission` (`submissionEnvelopeArgs` in the
binding helpers), which applies the primary write, every child insert,
and close's lifecycle transition in ONE Postgres transaction — partial
success is unobservable, and the running-app view re-queries one
settled state on resolve. Every mutation arm carries the form UUID,
controller-owned entry UUID, and exact attachment-reference projection
(including an explicit empty list), plus plain-JSON per-scope operation
answer bindings when the committed form has operations
(`computeOperationAnswers` — complete per iteration, parent-major,
multi-select as token arrays). The Server Action validates and normalizes
that final protocol before program, capture-intent, or effect derivation; the
retired name-only projection is rejected. Its authorization transaction locks
the app, proves fresh Project membership, and reads any durable receipt before
loading blueprint topology. Before the request, Preview flushes the reconciler's
human-save barrier and hashes the exact persistable submit-time blueprint over
canonical JSON. The action compares that digest with its locked committed app
before deriving a new submission program; a save or collaborator race returns
the typed `blueprint-changed` refusal. Every newly accepted receipt persists
that exact blueprint digest with its transaction result. An exact retry still
replays its saved effects after later edits, but it returns routeable success
only when the receipt digest matches the client's rendering revision;
historical or mismatched receipts report that the answers were saved and ask
for a reload instead of evaluating today's after-submit topology. The SERVER builds
the case-operation program from the COMMITTED doc
(`buildSubmissionOperationProgram`: the shared `lib/doc/caseOperationOrder.ts`
analyses + `buildCaseTypeMap` + the
identity's session values, `ordinary.caseType` populated for the rolling
proof). Even when the form has no advanced operations, that build projects each
ordinary child's committed case-type relationship; the client never asserts
`child` versus `extension`, and the envelope persists the same `parent` index
relationship the XForm emits. That same authorized boundary retains the `LookupScope`, projects the
canonical production lookup occurrences onto the built program's operation
UUIDs, and loads one rows-free definition snapshot only when those operations
actually carry lookup references. The resulting `lookupTableSchemas` map is
part of the immutable program handed to `applySubmission`, so a schema-heal
retry reuses the exact same compiler context; lookup rows themselves stay
current inside the submission transaction. A committed operation-bearing form
with missing answer bags rejects wholesale rather than silently applying
ordinary-only effects. A survey with a program executes it, and the envelope's
typed `SubmissionRejectedError` surfaces as the
`submission-rejected` result arm with whole-rollback copy in
`FormScreen`. The close transition itself stays the
store's: it atomically owns both `closed_on` and the canonical
built-in `status = "closed"`; the preview must never supply or invent
its own status vocabulary. This keeps the live row aligned with
CommCare's `@status` attribute and makes a close form with no property
writes a complete lifecycle write by itself.

## Attachments are staged per form entry, reserved atomically at submit

A capture question's answer is a server-minted attachment name; the bytes go
straight to GCS on a signed URL (`components/preview/form/fields/attachment`),
never through a Server Action — a `File` argument would make React encode
multipart, which the edge WAF reads as header injection.

`EngineController.entryKey` is the idempotency/reservation scope, minted per
`activateForm`. It lives on the CONTROLLER, not the engine, and survives cold
identity, lookup, case-data rebuilds, and an access refresh confirmed for the
same Project; a key minted by each rebuilt engine or scope epoch would rotate
under already staged bytes. A confirmed app/form/Project change, materially
different worker projection, terminal revoke/upgrade boundary, or **Clear
form** retires the entry and rotates the key. Clear mounts the fresh answer
world synchronously; deletion of the retired entry's staging rows is
best-effort and never delays or later resets the new entry. **There is no form
resume** — nothing persists
runtime answers and `deactivate` wipes the store — so leaving a form starts a
new entry. The controller exposes that identity through `entryStore`; form
lifecycle code must subscribe to it rather than sampling the imperative getter,
because a materially changed worker projection can rotate the entry from a
provider effect without changing the persona UUID or route.

Confirmed row ownership lives at `(app, entryKey, stableSlotKey)` above any one
rendered field. A stable slot is the field UUID plus every enclosing repeat's
stable instance identity; its concrete indexed path is a mutable projection.
Relevance, group/repeat remounts, Preview/Edit flips, and positional repeat
compaction therefore cannot delete or misidentify an answer whose entry is still
live. The same slot retains its filename, recoverable issue, and signature draft
above component lifetime. A real entry teardown/reset best-effort deletes those
unreserved rows immediately; the scheduled row sweep and staging TTL remain the
failure backstop. Every cleanup DELETE — teardown, replacement, remove, repeat
deletion, or post-initiate PUT/confirm compensation — is bounded and detached
from the entry queue. It can leave an expiring orphan but cannot delay an answer
commit, confirmed replacement, or Submit. Initiate, signed PUT, confirm, and
retarget each own a foreground deadline covering the request plus its
success/error response body. Cancel aborts the current slot generation without
changing its prior confirmed owner; a late completion is fenced and cleaned up.
That absence of cross-entry resume is
also why nothing simulates
the runtime's blank-pad-over-live-signature behavior: the state cannot arise
here. A future resume story must carry the entry key forward with the answers,
and must leave the pad blank rather than helpfully restoring it.

`FormEngine.collectAttachmentReferences` carries the exact server-minted name,
field UUID, and concrete repeat-indexed path for every surviving answer, and it
DOES consult effective visibility (the field plus every group/repeat ancestor)
— unlike the case-property collector, whose
visibility-blindness is an AJV storage constraint with nothing to say about
attachments. The server re-derives the committed field/path templates and
rejects stale or mismatched provenance. An irrelevant question's node is
omitted from the submitted instance on the wire, so its attachment is genuinely
not part of the submission. Nova then diverges from the platform by not
shipping it at all, where the real runtime enumerates the session media
directory and uploads orphans anyway.
An empty attachment projection from a committed form that still contains a
capture question nevertheless emits `captureIntent` with `attachments: []`.
That keeps a retry under the same entry key inside the durable receipt/digest
protocol after an earlier accepted request, instead of letting cleared, hidden,
or removed answers bypass replay and repeat case effects. The submission
envelope also carries that receipt identity independently of `captureIntent`.
The action's one authorization transaction reads an existing durable receipt
before current blueprint/form/capture validation; when no receipt exists it
returns the committed app snapshot used for program and capture-authority
derivation. The preparation transaction and entry-locked store reauthorize at
their own mutation boundaries and adjudicate the receipt before effects, so an
exact retry after the form or capture question is deleted still replays and a
changed digest rejects before effects.

Every capture mutation for one entry goes through one form-wide queue. A newer
operation aborts and generation-fences an older operation on the same stable
slot. The control publishes queued intent before it waits behind another slot,
so a second picker/clear/draw gesture cannot silently supersede the first;
signature debounce and `toBlob` encoding enter that queue immediately,
and a dirty/failed encoding keeps the barrier blocked rather than submitting
an older answer. `pointercancel` and `lostpointercapture` settle the ink through
the same path; dirty stable draft state starts an immediate encode after an
ordinary remount. A
signature Clear during queued/active save is itself the newer explicit intent:
it aborts that generation and queues exactly one answer-clear transition. Its
private serialization key carries the real stable slot/path/field target, so
Submit classifies and waits for that active clear rather than mistaking the
synthetic key for a deleted engine path. Dormancy cancels an older signal-aware
upload/retarget but does not cancel this explicit Clear: it runs ahead of Submit
so the old answer cannot revive later.
Submit first classifies every registered, active, not-ready, and retargeting
slot **before** it joins the tail; it continues classification while waiting.
Dormant work is aborted without dropping its draft/issue, removed work is
retired, and only active `notReady` state can reject. Retarget PATCH maintenance
is signal-aware and registered by slot too — otherwise an offline PATCH for a
now-hidden question could starve the barrier it sits ahead of. Submit remains a
barrier behind participating prior work and ahead of later work, and rechecks the
initiating form, entry, persona, case, Project scope, and post-submit
destination before calling the action. Once Submit enters `running`, the
entire answer surface is inert/disabled until the barrier and server action
settle; a post-click text,
picker, signature, repeat, replace, or remove gesture cannot join only one side
of the submission snapshot. Clear form does not use this barrier; it retires the
old entry and synchronously mounts a new idempotency scope.
A confirmed owner whose retarget is cancelled by dormancy keeps a stable
retarget blocker and a suspended marker. If the question becomes active again,
the next barrier mints a newer generation and repairs/converges that owner
before submission; a late cancelled response cannot clear the newer blocker.
A real non-abort retarget failure is marked failed and never auto-retries from
barrier polling — the worker still chooses Retry, replacement, or removal.

`EngineController.removeRepeat` is the ONE compaction owner. It emits the
removed prefix plus every positional move; FormScreen binds that event to the
entry coordinator even when the affected capture is irrelevant/unmounted.
Remove remains visible but disabled without current write authority. Its
imperative boundary requires the exact coordinator authority generation
captured by the handler, then rechecks the controller entry key and target
repeat instance's stable key immediately before compaction. A handler captured
before refresh, viewer downgrade, or authority loss/restoration cannot retire a
successor instance or its capture. The
coordinator updates desired slot paths synchronously, queues server CAS
retargets after any already-running upload/encoding and before Submit, and
cancels/discards only slots belonging to the removed instance. A failed old
retarget NEVER clears the answer or discards the retained row. It preserves the
owned attachment, desired and server paths, filename/signature ink, and a
generation-tagged `notReady` issue. A picked-file save failure also writes that
stable slot issue instead of component-local state, so **Choose file** recovery
survives an ordinary remount. Retarget failure exposes Retry plus
replace/remove for picked files; Signature exposes Retry beside the pad's single
**Clear signature** action, and its message names that exact action. Recovery
controls have question-qualified accessible names. Retry CASes the retained
row; a newer replacement generation supersedes it and clears only the older
issue. A surviving pending signature keeps its draft and `notReady` blocker
until its latest PNG confirms, then the newly owned row—not an older PNG—is
retargeted.

Authored path changes use the same ownership lane. One whole-batch
`EngineController` topology subscription compares the complete pre/post
UUID-to-path projections and moves every retained engine value in one atomic
call before per-field listeners run. It emits one capture-move set by stable
field UUID for simultaneous capture renames, cross-parent leaf/subtree moves,
ancestor renames, and group↔repeat conversion; the coordinator remaps every
concrete instance path synchronously and serializes its row CAS behind any
in-flight upload and ahead of Submit. Each retained/deleted event carries the
pre/post stable identity of every path segment, so retained repeat indices
survive cross-parent and different-depth moves instead of following positional
depth by accident. Projection is tri-state: mapped paths retarget, only a
proven removed repeat instance or an explicit deleted-field variant may clean
up, and malformed/missing identities preserve owner, picked file, signature
ink, and an invariant Submit blocker. The stored old path is only the CAS
coordinate—the destination alone must match the current committed capture
template. When malformed topology leaves no valid rendered path, the form owns
a recovery-only, question-qualified action that can remove the file or clear
the signature without claiming a new path; Submit focuses that action. A stable
UUID's explicit deleted-field event takes precedence over an unusable old-path
projection and retires exactly that slot. A capture-kind change
is incompatible ownership: cancel/fence active work, clean the old row, and
retain a targeted replacement blocker on the stable field UUID. React remounts
recover the existing slot by `(field UUID, desired concrete path)` so a
group↔repeat renderer-key change cannot create a second owner.

Project viewers may inspect capture answers but must never mint or mutate
capture data. Controls disable picker, drawing, clear/remove, and recovery
actions; authority loss aborts and generation-fences work already in flight.
`FormScreen` installs one exact coordinator authority token containing
`appId`, `entryKey`, `formUuid`, `projectId`, `actorUserId`, `ownerId`,
`scopeEpoch`, `accessPhase`, and `canEdit`. Every operation also carries its
exact stable slot key. Missing/stale authority, missing slot identity, missing
response-body methods, and malformed response coordinates reject in production;
tests must supply the real contract rather than activate fallbacks. Form-level
invariant recovery uses the same exact coordinator authority token:
its Remove/Clear control disables during refresh or viewer access, and
imperative discard rejects a missing or stale generation before retiring the
owner, retained File/signature ink, and Submit blocker.
Every event handler re-reads the current session access tuple at its mutation
boundary, just like Submit and Clear form. A transient refresh suspends old
network generations but preserves the controller, entry key, answers, focus,
browser-owned File controls, staged ownership, drafts, ink, diagnostics, and
Submit blockers. If React batches the refresh and same-Project authorization
into one committed render, the authority generation still pauses active file
drafts and rearms dirty signature ink exactly once.

Signature pixels are entry/stable-slot-local across ordinary remounts and reset
on an entry/persona change. Points are normalized to the canvas bounds, so a
successful encoding records CSS width/height, device pixel ratio, and backing
width/height beside the strokes. CSS resize, DPR-only change, and a remount at
different geometry redraw and re-encode the complete signature rather than
clipping old absolute coordinates or submitting stale pixels. `toBlob`
callbacks also carry a generation fence because the browser API cannot itself
be aborted. Encode/upload failure retains the ink plus an actionable
Retry/**Clear signature** slot issue across remounts; Retry re-encodes the
retained strokes.
The DPR watcher is a self-rearming resolution media query, so a density-only
change does not depend on a window resize event. Clear's inverse stroke buffer
is stable-slot state, so Undo survives ordinary remounts until the worker draws
again. A blocked canvas exposes its disabled/read-only state to assistive
technology.

`FormEngine.firstInvalidFieldTarget` returns the first effectively visible
invalid concrete path plus every structural ancestor UUID. On invalid Submit,
`FormScreen` expands those group/repeat ancestors in one layout commit, announces
the failure, then scrolls and focuses the real invalid control (`input`,
signature canvas/custom textbox, button, or the focusable question wrapper
fallback). Collapse toggles carry `aria-expanded` and `aria-controls`; selected
capture questions use the same custom-control-aware focus selector.
`AttachmentNotReadyError` carries stable slot, concrete path, and field UUID;
the same reveal path opens a collapsed blocker and focuses its exact Retry
action. Both paths use immediate scrolling when reduced motion is requested.

## Sections page the preview on Android's rules

A sectioned form (root sections only, `lib/doc/formSectionVerdicts.ts`) previews one page per section, because that is what the wire's `appearance="field-list"` group is on a phone: one screen per section, Next validating the screen before it turns, Back never validating, an empty or all-irrelevant screen skipped. Default Web Apps shows the same form as titled groups on one page; the preview follows the device and the docs say so. A form with no sections is untouched.

- **The engine owns the page model**: `FormEngine.sectionPages()` (root sections in order, each with its `/data/<id>` path and whether anything on it is effectively visible right now, a label counting, a `hidden` never), `validateSection(uuid)` (`validateAll` restricted to the paths under that section, marking them touched) and `firstInvalidFieldTarget({ withinSection })` (the same target, with the section leading `ancestorUuids`). The controller mirrors all three; `hooks/useSectionPages.ts` subscribes through a one-string key so a keystroke does not re-render the pager.
- **The open page is session state**, `activeSectionByForm` (`lib/session`), shared with the edit canvas so a flip keeps the page. `components/preview/form/sections/useSectionPaging.ts` arbitrates: the remembered page while it is visible, re-anchored (`sectionPaging.ts::resolveCurrentPage`) and written back when it empties; `goNext` validates the current page and on failure announces through the form's `role="alert"` node and reveals the first invalid question on that page; a forward `goTo` validates every page between; `showPage` turns with no check, which is what Submit routing (the earliest invalid page, `ancestorUuids[0]`) and Clear form (the first page) use. Enter never advances.
- **`FormScreen` renders `SectionPage`** (the shared `SectionHeading` as a focusable `h2` the page is labelled by, over `InteractiveFormRenderer` rooted at the section, so every question reads and writes the same paths as on one page) in place of `FormRenderer` while paging, and the bottom bar carries the `SectionStepper` (`nav aria-label="Sections"`, `aria-current="step"`, a polite "Section k of n: title" after a user-driven turn) plus Back / Next, with Submit taking Next's place on the last visible page. The invalid-submit and attachment-not-ready arms turn to the question's page before the ordinary two-frame reveal.

## Repeat instances are first-class

Repeat children live at CONCRETE indexed paths (`/data/orders[1]/name`), one FieldState per live instance, while everything AUTHORED about them is index-free — `printXPath` emits `#form/orders/name`, the dependency extractor emits `/data/orders/name`. Three mechanisms bridge the two shapes (`instancePaths.ts` holds the conversions):

- **Evaluation binds to the instance.** `createEvalContext` rebases scalar reads — `#form/` hashtags and absolute `/data/` paths — onto the evaluating node's own repeat instance by longest-common-repeat-prefix (`rebaseOntoContext`), CommCare's relative-reference semantic. A reference from OUTSIDE a repeat to children inside it materializes the complete nodeset for node-aware functions, predicates, and Core-compatible scalar coercion; it must never collapse to one guessed value or blank merely because Preview is evaluating it.
- **The TriggerDag topology is index-free; queries materialize.** Nodes and edges are keyed by generic paths, and `getAffected` / `getAllPaths` fan each generic node out over the live instance counts (a `RepeatCountResolver` the engine supplies). Repeat add/remove therefore needs NO DAG bookkeeping; both cardinality changes re-evaluate EVERY instance (`position()` and renumbered sibling reads can shift on removal) plus outside dependents, and `addRepeat` runs defaults-then-evaluate for the new instance, the same order as form load.
- **Authoring cycle proof is a strict superset of runtime triggers.**
  `TriggerDag.reportCycles` temporarily adds two kinds of authoring-only
  edge: field-DEFAULT dependencies, so validation can reject loops through
  defaults (`build` / `rebuild` exclude them because defaults apply once
  during initialization), and the RELEVANCE CASCADE from a group or repeat
  to every descendant, because the device re-triggers everything inside a
  container when its display condition changes (`commcare-core
  .../FormDef.java::fillTriggeredElements` over
  `Condition.java::isCascadingToChildren`), so a container whose condition
  reads its own contents is "Logic is cyclical" at install and CommCare HQ
  refuses the build. The runtime excludes that edge too: the engine derives
  a descendant's effective visibility from its ancestors at read time.
  Each report names the cascade edge it closed through (`CycleReport.cascade`)
  so the validator can explain the containment, which no authored expression
  spells out; because a reference to a field inside a container also depends
  on the container (`extractPathRefs` yields every path prefix), a cascade
  loop usually has a shorter twin through that prefix edge, and
  `reportCycles` keeps only the cascade report for one authored loop.
  Lookup-choice filter dependencies are RUNTIME edges (the `choices`
  expression below) — the proof sees them through the ordinary collection,
  not the swap. Two runtime edge kinds are deliberately NOT in the proof:
  a field's constraint (`validate`) and its label/hint `<output>` references.
  The device orders only relevant / required / readonly / calculate
  (`XFormParser.java` registers exactly those through `addTriggerable`, and
  `FormDef.java::finalizeTriggerables` ranges only over triggerables), so a
  loop that closes only through a constraint or a label installs and runs.
  The runtime keeps those edges (validation re-runs and labels re-render
  when their inputs change) but adds them LAST and only where they close
  no loop (`addSettleFreeEdges`), so a loop through one of them drops that
  edge and never a calculate or relevance edge.
- **Instance counts are explicit.** `DataInstance` tracks cardinality in its own map, keyed by concrete repeat path — never derived from which value keys happen to exist (a repeat with only structural children still counts 1). `set` auto-extends counts from indexed path segments so restore/rename flows stay consistent. A new instance seeds the AUTHORED template shape — nested repeats restart at one instance, matching what the deployed form's `jr:template` produces — not `[0]`'s live shape.
- **Count-bound repeats follow the emitted carrier.** A count expression that projects directly to a `jr:count` path is read from that node through JavaRosa's `IntegerData.cast`: blank means zero, while every nonblank value must be an exact base-10 Java `int` lexical value (`2.0` and `2.5` are errors, not two rows). A non-path expression is different because the emitter first seeds it into Nova's generated `xsd:int` node; Preview retains that node's numeric coercion before materializing the count. Both synchronous and worker initialization use this same split.
- **The runtime store is dual-keyed.** Every field keeps its uuid key (edit-mode rows); every path with an `[N]` segment ALSO gets a path key — the interactive renderer subscribes via `useEngineStateAt(uuid, path)` and writes through `controller.setValueAt(path, …)` / `touchAt(path)`, so two instances of one field hold independent value/visibility/validity. Uuid-keyed flows (`onValueChange`) address the `[0]` template only.
- **Doc mutations land on every live instance.** The controller's incremental handlers (field added / removed / retyped / expression edited during live preview) route through the engine's instance-aware ops. Authored topology is reconciled once per committed batch from complete pre/post path maps, so two independent renames or a cross-parent subtree move cannot observe a half-updated map. `materializePaths` expands the uuid map's `[0]` template path over the live counts, and `renamePaths` moves all values/states in one call (materialize-before-move, since renaming or moving a repeat container relocates the count its descendants materialize through). A repeat→group conversion keeps only instance 0; the other instances' values are dropped with their states unplugged.

In render paths, read repeat instance counts from `state.repeatCount` (via the engine-state hooks), not from `controller.getRepeatCount(uuid)` — the latter is a non-reactive method call. `addRepeat` / `removeRepeat` bump `repeatCount` on the repeat's own `FieldState` precisely to give subscribers that signal. `getRepeatCount` is fine outside render or in render paths whose lifecycle guarantees no add/remove can happen while mounted (e.g. edit-mode-only rows).

## Lookup carriers — one printing path, one snapshot

Carrier evaluation never grows a second AST interpreter: every surface prints
the authored AST through the SAME on-device predicate emitter the wire uses
and evaluates the printed XPath with the preview evaluator
(`lookupEvaluation.ts`). A lookup-backed select's row filter emits ONCE with
the fixture-row scope — same-table columns print as bare wire names the
per-row `EvalContext` resolves against the row's lexicalized cells — and a
`table-lookup` folds bottom-up to a plain text literal: exact Core parity,
because a string literal and a node read unpack identically under every
scalar operator, and a no-match folds to `""` (Core's empty-node-set unpack;
missing and stored-empty cells both read blank, the fixture boundary's
semantics). The `item-list:` instance vocabulary never enters the browser.

Data is ONE Project fixture snapshot (definitions + complete ordered rows for
the doc's referenced tables): `PreviewLookupDataProvider` fetches it
generation-keyed on the reconciler scope epoch, refreshes per-table on the
Project lookup clock, and installs it on the `EngineController` like the
preview identity. **COVERAGE, not presence, decides evaluability**: the
snapshot covers only the tables referenced at fetch time, so every surface
asks the coverage predicates (`lookupOptionsSourceCovered` /
`predicateLookupsCovered` / `expressionLookupsCovered`) first and treats a
miss as its loading state — a validly committed edit referencing a
new table/column degrades gracefully while the refetch lands, and the
`requireTable`/`requireColumn` throws fire only on a genuinely bypassed
validator. An engine CAPTURES the snapshot at activation — choices stay
stable within a form session (the wire's install/upgrade fixture semantic)
and the next activation picks up the refreshed cache; an arrival rebuilds the
active engine only while its capture fails to COVER the form's carriers
(cold load, or a valid rebind the capture predates), with touched values
restored. Choices are engine values: the DAG's `choices` expression
re-filters on any filter-answer change (the device's prompt-rebuild), and a
selected value the rebuilt choices no longer offer is unselected (token-wise
for multi-select), cascading through the ordinary topo pass.
`FieldState.choices === undefined` is the typed loading state, and each
choice carries its source row id as display identity (lookup rows guarantee
neither unique nor non-blank values).

Navigation display conditions (`displayConditionEvaluation.ts`) evaluate at
render through the same printing path: module conditions gate the home
screen's module list; form conditions gate the case-list screen's
post-selection form menu + single-form auto-continue (against the selected
row's projection, with a private evaluator token for typed self reads) and the module
screen's forms-first list. Raw absent-node semantics hold — absent
string-unpacks to `""`, numeric ordering yields NaN, no presence guards.
Visibility is three-valued: a carrier-bearing condition without loaded data
is `pending` (placeholder, never a guess); hidden items surface through the
ghosted "Hidden items (N)" reveal with `summarizeFilter` summaries; edit
mode never hides.

## Value persistence across engine recreation

Blueprint mutations in edit mode recreate the engine. The engine hook snapshots live-mode values before recreation and restores **only user-touched values**. Untouched fields pick up the new engine's defaults — this is what makes editing a `default_value` expression in edit mode immediately visible in preview.

## Resolved preview identity

`engine/identity.ts` is the ONE identity contract every preview surface speaks — Search/Results session evaluation, form XPath `#user/*`, the SQL compiler's session bindings, and the acting user behind case writes. Providers are the sole constructors of `ResolvedPreviewIdentity`, and every provider must present a persisted user id: `previewAsMe` and `previewAsPersona` both refuse without one, and no session-only pseudo-persona is constructible.

**Two ids, and they are NOT interchangeable.** `actorUserId` is the signed-in member and the ONLY thing that ever authorizes. `ownerId` is the CommCare worker the preview acts as — the `owner_id` stamped on rows it writes and what `session/context/userid` resolves to. Previewing as yourself makes them the same string; previewing as a persona makes `ownerId` that persona's UUID while the member still authorizes. `ownerId` is authored blueprint content, so keying an authorization decision on it would let an app choose whose data a request reads; `resolveAuthorizedPreviewContext` passes `actorUserId` into the locked authorized-app snapshot before resolving any persona and threads `ownerId` through `withProjectContext(projectId, actorUserId, ownerId)` as the worker only, and the consumer tests pin that the two cannot be re-conflated (including Project-scoped lookup reads, which always use the actor). A Server Action accepts a persona SELECTOR (a uuid) and resolves it against the committed document; it never accepts an identity.

**The usercase reading is the ROW, not a second computation.** `commcare-user` is materialized per worker, and `#user/<prop>` on the wire resolves against `casedb` — so once a form can write through `usercase_update` a computed projection and the row diverge the moment a worker answers. They diverge without that too: the sync's never-remove diff keeps a key on the row after the catalog drops the property, while the projection forgets it. The derivation survives as the materializer's INPUT (`lib/domain/usercase.ts`), and `resolveAuthorizedPreviewContext` reads back what the row holds. Do not reintroduce an independently computed usercase here; that is the bug this replaced.

**Two readings, because the wire has two.** `session` is `instance('commcaresession')/session/…` (`SessionInstanceBuilder.addMetadata` + `addUserProperties`); `usercase` is the `commcare-user` case `#user/<prop>` reads (`sync_usercase.py::_get_user_case_fields`). Same authored data, different built-in keys — `first_name` in the usercase, `commcare_first_name` in the session block — so collapsing them would make one of the two lie. The serializable session projection also carries `userPropertySlugs` (custom UUID→CURRENT slug), which is binding metadata rather than worker data; `previewUserPropertySlugMap` turns it into the typed emitter/compiler map. Thus both Predicate `session-user-property` and XPath `user-property-ref` evaluate against the same property after a rename without rewriting their AST, while name-backed built-in/external arms remain literal. Every session/usercase read uses an own-key lookup, so authored `__proto__` and `constructor` values cannot inherit from the object prototype. **The three location keys diverge, and it is easy to get backwards**: `get_user_session_data` writes all three or none, so the session block omits them while nobody is assigned anywhere, but `_get_user_case_fields` takes an `else` branch to `''` for all three, so the usercase always carries them. Values are otherwise honest: `commcare_project` is ABSENT in BOTH projections until a deployment names one (the domain is never empty on a device, so an empty value would be one no worker can hold), and the worker's name rides as `case_name` rather than `name` (HQ pops `name` into the case's name and never writes it as a property), while the session's first/last/phone keys and the usercase's first/last/phone/email keys are PRESENT, derived when possible and empty otherwise, because HQ writes those slots unconditionally. `user_type` IS present and reads `"standard"` — HQ sends the key only for a practice user, but every `commcare-core .../User.java` constructor calls `setUserType(STANDARD)` before `UserXmlParser::parse` applies any `<data key>`, so the device always has it and a condition on it must behave the same here. A DECLARED property with no value is present-and-empty, matching HQ's `UserData.to_dict` seed, while an undeclared key is genuinely absent — the split a `= ''` comparison depends on.

**The running app reads what the worker's device would hold, and it is a
SEPARATE axis from identity.** CommCare does not filter a restore by
ownership; it takes a fixpoint that ownership only seeds, so previewing as a
worker legitimately shows fewer cases than the builder's case data does
(`lib/case-store/CLAUDE.md` § Restore scope is the rule). The owner set is the
persona's own uuid plus every place it receives cases from
(`lib/organization/ownerSets.ts`); previewing as the member is a worker
assigned nowhere, so it is their own id alone.

It rides on `AuthorizedPreviewContext`, NOT on `ResolvedPreviewIdentity`. The
identity is the one contract the browser and the server both speak, and the
browser cannot derive this — expanding a persona's assignments reads the place
tree out of Postgres. A server-only field on the shared identity would make
the client's copy quietly wrong, and `samePreviewIdentity` would then compare
a field only one side can fill.

Running screens opt in; builder chrome does not. Results, the canonical
Details URL read, a case-loading form's preload, and the persistent tile pass
it. The case workspace, sample data, and the rename preflight do not.
`loadCaseDataAction` serves both, which is why it takes an explicit
`deviceScoped` argument rather than deriving one from the context — the
review dialog shares that action, and a derived scope would have silently
stopped it from opening the very rows it exists to inspect.

Fewer rows than the builder shows is not data loss, so `RestoreScopeNote` says
so beside Results: how many cases the same query matches that this worker
would not have, named to the worker. Same doctrine as `HiddenItemsReveal` —
authoring-only inspection sitting BESIDE a runtime-faithful list, never a
blend of the two modes. It cannot list the rows, because the preview never
loaded them, which is the point. That count also OUTRANKS every other empty
state on the screen: the other causes are each read off a tenant-wide count,
so an empty restore over a populated project would otherwise report "no case
data" or blame the worker's Search values, next to a note saying the project
holds hundreds. `restoreScopeEmptyCopy` is the copy that arm renders, and
`PreviewWorkerLabel` is a discriminant rather than a name because previewing
as yourself reads in the second person and as a persona in the third.

`useRestoreScopeKey` is what makes a cached read follow its worker. The scope
is resolved server-side from the persona's assignment, the level catalog, and
the place tree — and the place tree is not in the document, so no doc
subscription can see it move. The hook signs all three (the builder stream's
organization poke covers the Postgres half) and every running surface folds it
into its request identity. Without it the preview keeps serving the previous
worker's rows with nothing on screen to say so, which is the exact failure the
note exists to prevent, arriving through the back door.

Server side, every persona-aware running path — Results/Details reads, sample populate/reset, and submission — calls `resolveAuthorizedPreviewContext` once. It authenticates the member, resolves membership plus the committed blueprint under the same app-row and membership locks, resolves the selector from that one authorized snapshot, and binds the explicit actor/owner pair. A selector naming a missing persona returns `persona-unavailable`; it never silently runs a read or write as the member. The selected owner rides populate/reset and `submitFormAction`, so all rows the persona creates belong to the persona, while the actor remains the authorization and lookup identity. Client side, `useSelectedPreviewIdentityState()` makes selected-but-missing a distinct `persona-unavailable` state rather than collapsing it with signed-out/loading or falling back to the member for one frame. `PreviewShell` replaces the running screens with an explicit unavailable-persona refusal and a **Preview as me** recovery action, while `BuilderFormEngineProvider` marks the `EngineController` blocked so activation cannot execute behind that refusal. Leaving Preview clears the persona selector before edit-only sample/data surfaces become active; the next preview therefore starts as the member unless the author chooses another persona. Visual consumers of the compatibility `useSelectedPreviewIdentity()` keep the server/client hydration render identity-free, while `BuilderFormEngineProvider` opts into a warm cached session and seeds that result on the `EngineController` inside its `useState` initializer — the provider itself renders no identity-dependent markup, and child effects flush before parent effects, so an effect-only install would hand every warm-session form mount an identity-less engine plus an immediate rebuild. A follow-up effect tracks later session changes. Identity is engine-lifetime state: a materially different identity rebuilds any active engine (one evaluation world), a re-derived-but-identical identity is a no-op (`samePreviewIdentity`), a cold session resolving mid-entry restores user-touched values through the engine's shared snapshot/restore (same touched-only contract as blueprint-edit recreation — untouched values may be world-dependent defaults and must re-derive), and replacing a NON-null identity (sign-out, different worker) discards — restoring would leak one worker's entries into another's session. Every suite that mounts `BuilderFormEngineProvider` (directly or transitively) must mock `@/lib/auth/hooks/useAuth`, or the session atom's `setTimeout(0) → fetchSession()` trips the async-leak gate. `#user/<prop>` resolves from the identity's `usercase` projection — the `commcare-user` case the wire's `#user/` hashtag expands to, NOT the session block, whose built-in keys differ (`first_name` there, `commcare_first_name` in the session). An absent key reads blank at evaluation, matching the device's missing property. The signed-out projection (`previewSessionValues(null)`) carries device context only.

## Several-case selection and batch forms

`caseListConfig.selection.kind === "multiple"` changes the running selection
from a scalar row action to an ordered set. `orderedCaseSelection.ts` is the
pure collection model: insertion-order-preserving dedupe, remove, re-add at the
tail, visible-page select-all capped by remaining capacity, and stale-id removal
all live there rather than in React event handlers. Search submissions, page
changes, Details, review, Back, and compatible module navigation reuse that
same set. The quick filter changes only what is visible; it never edits the
selection. Lowering the authored maximum retains the set and disables Continue
until its size fits.

Results never nests controls. The checkbox selects; the row/tile Details action
opens one record without selecting it. The review tray is persistent, keyboard
reachable, and reports zero and over-limit states through both visible text and
an announcement. Select-all considers the current visible window in its stable
row order and reports when capacity left rows untouched. A grouped tile is still
one runtime choice whose id is the group's first case; its body rows remain
display-only even in multiple-selection mode.

Continue validates the whole set in one bounded server read: distinct ids,
Project/app tenancy, declared case type, current availability, and maximum.
Rows return in database order but are restored to the worker's selection order
before use. Missing, held, wrong-type, and newly inaccessible ids are removed
with one concrete notice; no request-per-case waterfall exists. Zero surviving
ids returns to Results rather than opening an empty form.

A batch-consuming follow-up or close form receives the collection as a typed
target, never `caseId[0]` and never N simulated form submissions. Shared form
answers and app-level effects evaluate once. Explicit session-case operations
expand over selected ids in selection order; an authored repeat is the outer
axis and selected cases are the inner axis. Every target is reauthorized and
type-checked server-side, and the ordinary lifecycle effects, expanded
operation program, storage writes, and submission receipt commit in one
transaction. A failed target or effect rolls the complete batch back. Ordinary
primary destinations start without a case preload and apply each nonblank
shared answer to every selected case; blank answers preserve every existing
value. The authored cardinality controls that behavior even when exactly one
case is selected, so the form engine never invents a representative case value.

The submission Server Action is also an open-tab deployment boundary. A
pre-deploy FormScreen may still send its one followup/close target as `caseId`:
the action keeps that raw object for the durable request digest, normalizes it
to canonical `caseIds: [caseId]` before deriving authority or effects, and
returns the old scalar `caseId` plus flat `childCaseIds` aliases alongside the
new result. The scalar alias exists only when the canonical result contains
exactly one primary case. A real several-case result never chooses a
representative. This also lets a response-lost old request match and replay a
receipt committed by either side of the deployment.

The committed form is the authority for the ordinary submission arm. A
client discriminator that disagrees with its committed type is rejected
before capture preparation or case effects. For a conditional close, the
final protocol carries only the relevant submitted nodes for the referenced
field; the server reloads the committed field, operator, and comparison answer,
evaluates one shared boolean, and closes either the complete ordered selection
or none of it. A false close condition still runs the form's ordinary updates,
children, and operation program atomically; it changes only the close lifecycle
transition.

That authority includes the complete ordinary case-write structure, not just
the form discriminator. The server derives the primary case type, writable
standard/custom destinations, and exact ordinary child buckets from the
committed `deriveCaseWriteInventory`. A child answer carries an internal
`(caseType, nearest repeat UUID or root, concrete repeat instance)` identity;
the server matches it to that inventory, refuses duplicate root buckets or
duplicate repeat instances, derives the relationship, and strips the identity
before storage. Registration primary/children and follow-up/close
patch/children therefore contribute answer values only. They cannot add a
schema-valid but unauthored property, standard scalar, child type, or child
bucket. The accepted child array retains form order, so durable
`authoredChildIndex` receipts and post-submit child routing do not change.

## Case tiles in the running app

A `caseListConfig.tile` turns each Results row into a grid. `caseTileLayout.ts`
resolves the geometry and `caseTileRendering.ts` turns it into declarations;
`components/preview/shared/CaseTile.tsx` is the only renderer, shared by the
Results rows and the tile pinned above forms, so the two cannot draw one case
differently. Both files carry the CommCare citations — read them before changing
a number.

Four things the rest of the preview has to know:

- **A tile carries more columns than it shows, and the extra ones hold no
  square.** `tileResultsColumns` selects the set the short detail emits: every
  Results-visible column PLUS every hidden column that still owns a Default-order
  rule. That carrier renders no value (Web Apps' `widthHint === 0` arm puts it in
  a `d-none` wrapper) and it is NOT a cell: `columns.ts::tileStyleChildren`
  refuses a `<style>` for a hidden column, so the device gives it no `grid-area`
  and `grid.scss::.box` gives its wrapper no size. `tileResultsColumns` therefore
  STRIPS the stored placement off a hidden carrier — the cell stays on the
  document so unhiding restores the drawing, but leaving it attached here would
  let an invisible column widen the grid's extent and flip the tile-wide
  border/shading switch in the preview and nowhere else.
- **The grid never reflows.** A tile is the device's own phone-first layout, so
  compact widths change the row's gutters and nothing else; the list holds an
  18rem floor and scrolls horizontally below it rather than crushing 12 columns,
  and from the medium breakpoint up the tile is capped at a 48rem measure instead
  of stretching to an extra-large canvas. The reasoning lives on `ResultsTiles`.
- **A grouped tile draws one card per GROUP, and that card is one choice.**
  `caseListConfig.tile.grouping` puts the tile's top `headerRows` rows on the
  group (drawn once, from the group's first case) and everything below them on
  each member. `caseTileGrouping.ts::splitTileGridByGroupHeader` cuts the
  projection, `components/preview/shared/CaseTileGroup.tsx` stacks the halves,
  and both keep the WHOLE tile's `grid-template-*` because the template draws
  header and every body row as separate divs sharing one `-cell-grid-style`
  block. The split reads a cell's START row only, never its height. **Choosing a
  group opens its FIRST case** — Web Apps clones the group's models and removes
  every non-first one from the rendered collection
  (`views.js::CaseTileGroupedListView.initialize`), so the body rows carry no
  id, no checkbox, and no handler; the running list says so permanently rather
  than inventing a per-row selection the device does not have. Reading side:
  `readCases` branches onto `store.queryGrouped` for a BOUNDED read only (the
  form's unpaged auto-selection read stays flat), `rows` stays the flat page in
  clustered order so every row-reading consumer keeps working, and the extra
  `grouped` slot carries the clustering plus a window whose unit is GROUPS while
  `totalCount` still counts cases. A grouped page is therefore unbounded in rows
  — N groups arrive with however many cases they hold, which is
  `EntityListResponse::getEntitiesForCurrentPage`'s own behaviour, not a bug to
  clamp. Cases carrying no such connection all land in the empty-key group,
  because that is what `string(./index/<id>)` evaluates to for them.
- **The persistent tile is a separate read.** `PersistentCaseTile` loads its own
  row with the display config attached so calculated cells project exactly as in
  Results; the form's case read stays display-free because it feeds the engine.
  It sticks to the preview scroller, which is why `FormScreen`'s frame grows with
  its content (`min-h-full` + a growing frame) rather than being pinned to one
  viewport height — a sticky element can only travel as far as its containing
  block.

## Case data resolution

The nav stack carries only `caseId`. Case data is looked up by id at the point of use, not stored in navigation state. Swapping the data source (dummy → real API) only requires changing the lookup functions.

**Per-case-type refs resolve at every reachable depth, positionally.** The engine's case data is a per-case-type map (`CaseDataByType`, case-type name → property map) built by `caseRowsToFormPreloads` with the WIRE's semantic: each reachable type's namespace binds to the row at that type's blueprint depth — `expandCaseToWire` emits a blueprint-fixed `index/parent × depth` casedb walk with no case-type filter, so when the live parent chain doesn't mirror the blueprint's `parent_type` chain, preview and device read the SAME row at the hop count (and a depth past the chain's end reads blank on both). The rows come from `readCaseData`, which walks the bound case's `parent_case_id` chain server-side through the `parent` index edges, exactly `ancestorDepth` hops (the form's `reachableCaseTypes(...).length - 1`, client-supplied, server-clamped at 64 — any deeper `parent_type` chain is pathological authoring); the chain is ENRICHMENT — a dangling parent or a mid-walk failure degrades to the rows already fetched, never fails the load. The hashtag resolver (`formEngine.ts::createEvalContext`) looks an explicit `#<case_type>/<prop>` namespace up by type name and throws on raw `#case/...`; `caseRefAcceptMap` decides at authoring time which namespaces a form may reference. Both case-loading form types preload (`followup` AND `close`) only in the module's one-case mode — from the OWN type's entry only, since ancestor namespaces are read-only reference data, and only while the engine's supplied-under type still matches the module's (a mid-preview module retype withholds preload rather than seed field values from an ancestor's row — `ownCaseData`). Several-case mode supplies no primary case-data map at all; the complete device casedb snapshot remains available for admitted operations and after-submit evaluation. Each per-row map (`caseRowToFormPreload`) carries the JSONB document PLUS the reserved scalar columns under their canonical Nova names (`date_opened`, `last_modified`, `case_id`, …), mirroring what the device's casedb exposes.

Case-list sorting belongs to the Results composition. Equal authored sort priorities tie-break by Results position (`listColumnOrder`), never by Details; this is shared with the short-detail wire emitter. The confirmation screen independently renders `detailColumnOrder`, so rearranging Details has no effect on row query order. Both are read through `orderedColumns(config, surface)`.

Case-data authoring is builder chrome, never simulated-app UI. `BreadcrumbStrip` owns the single persistent **Case data** manager: `loadCaseCountAction` reports the complete unfiltered population, an empty type may create samples, and replacing a populated type requires an explicit warning that ALL rows (including hand-entered / Preview-entered cases) are deleted. Successful populate/reset hooks and case-bearing form submissions advance `caseDataInvalidation` for each affected materializable `(appId, caseType)`; `useCases`, `useCaseData`, and `useCaseCount` all subscribe to that revision so one write refreshes every real-data representation instead of manually reloading the surface that launched it. Results and Details edit canvases do not query one case for decoration; real values belong to the running Preview.

The Case data manager's app-wide property-rename review uses
`engine/casePropertyRenamePreflight.ts`, not an optimistic client row count.
The action authorizes current Project view access, loads the authoritative
Blueprint and mutation sequence, admits the exact exclusive rename, evaluates
the complete candidate with the current lookup-definition snapshot, and reads
all live and parked storage counts in that same transaction. Its result is
explanatory only: no write token exists. A scope change makes
`hooks/useCasePropertyRenamePreflight.ts` discard the report, and the dialog
compares its returned `mutationSeq` to the reconciler's current base sequence
so any intervening app commit requires Review again. The later save rechecks
every fact under the authoritative write locks.

Case-search scalar prompt defaults run through `engine/searchExpressionEvaluation.ts`: it emits the authored `ValueExpression` to the same XPath shape as the device and evaluates it with the preview XPath evaluator plus the authenticated user's session values. Date range is deliberately excluded: CommCare binds one paired start/end answer, and the final date-range arm has no scalar default slot, so Preview never invents a From-only default. `hooks/useSearchInputRunState.ts` applies supported defaults once per module, refreshes only untouched prompts when a default/session value changes, and resets submitted state on a module switch; the flipbook therefore preserves worker edits without leaking the prior module's query. `caseSearchConfig.excludedOwnerIds` evaluates once at the authenticated Server Action boundary (so `session-context(userid)` is real), before any case row exists; the shared gate rejects property and relationship reads, while literals/session/Search values and pure calculations remain available. The result splits exactly like CCHQ on whitespace and joins `caseListConfig.filter` + submitted prompts as one Postgres predicate — never a client-side post-filter.

Preview derives navigation from the effective Search action, not from the mere presence of the compatibility settings bag. An explicit zero-input Search action with no Results filter renders one functional manual Search action; with an effective Results filter it submits automatically once for that module/config state. An owner-only exclusion still constrains every Results query, but it mounts no Search screen and triggers no automatic transition by itself. For a prompted Search, `searchButtonDisplayCondition` gates the whole combined Search pane from the case-list action's pre-prompt session/global context; it never reacts to the pane's draft, and the pane's single authored-label submit remains available whenever the action is relevant.

A search-first module (`caseSearchConfig.searchFirst`) is a different composition, decided by `components/preview/screens/caseListPhase.ts::caseListStep`: `search` (only the Search pane, no results query runs — `useCases` gets no case type), `results` (a completed search's rows, with a **Search again** ghost action that clears the run and refocuses the first prompt), or `browse` for every other module. A search-first module with no visible prompt is on `results` from the start, mirroring the wire's `default_search`; the automatic zero-input launch therefore fires for it whether or not a Results filter exists. `resultsConstraintContext` reads an unconstrained empty answer on `results` as the worker's search rather than an invitation to add case data, so the empty state and the unfiltered-count probe say "nothing matched" there. Post-submit routing reads `effectivePostSubmit`, so a case form in a search-first module returns to the module (Search) rather than to a previous screen that was the search itself.

Running Results reads at most 50 cases per page. The action clamps every caller to a bounded window, appends a stable case-id sort tie-breaker, and returns the full matching total plus the effective offset (which may move backward after concurrent deletion). The client resets to page one whenever module, case type, authored configuration, submitted Search, assigned-case exclusion, or destructive replacement changes; an ordinary data update may retain the page, and the server's effective offset keeps a shrunken population from producing a false no-data state. Quick Filter is explicitly page-local whenever more matching cases exist. A canonical Details URL loads its case directly by identity when the row is off-page or excluded, but still sends the live display configuration and case-type catalog so that one row receives the same calculated-column projection as Results; the identity read never inherits Results filtering, sorting, or pagination. Empty worker searches carry an authored-only match count, so Preview says Search caused zero matches only when Cases available would otherwise reveal a row. Deterministic input/config failures use `invalid-search`, not a retryable transport error.

## End-of-form links

A form's `formLinks` run in the running app the way they run on a device, through the ONE projection the wire reads (`lib/commcare/formLinkProjection.ts`): which link fires and which case the next form opens with are never re-derived preview-side. `engine/formLinkEvaluation.ts` is the rule, `components/preview/screens/afterSubmitRouting.ts` is the routing table, and `FormScreen`'s `dispatchAfterSubmit` performs the effect once the submission has landed; a form with no links takes its `postSubmit` destination exactly as before.

- **First true wins, evaluated as Nova text after the write.** Each condition prints through `printXPath` (an unresolved reference throws: the commit gate refuses those, so reaching one is a bypass) and the preview evaluator decides it in the entry's post-form scope: `instance('commcaresession')/session/context|user/...` from the identity, `/session/data/<id>` from the source entry's own datums, `#user/<prop>` from the committed usercase row, `#<type>/<prop>` from the case rows AS THEY ARE AFTER THE SUBMISSION, and any read of the closed form (`/data/...`, `#form/...`) throws. Any app with an after-submit link and a case-bearing module loads the complete entry-time device casedb even when no expression names `instance('casedb')`: a link can carry an unchanged existing case or ancestor, while the transaction patch contains only affected rows. `applySubmission` reads every affected row and direct index edge before its transaction commits and persists that exact patch in the durable receipt. Preview applies the patch to the device casedb captured when the entry opened, then derives source and target case preloads from that one world. There is no post-commit case read: it could observe a later writer, and a fresh restore can omit a just-closed case the device still retains locally until sync. Registration-created cases, advanced-operation targets, and the worker usercase all enter through the same patch. A survey with no case or usercase effects contributes an empty patch. A direct linked form carries both its case preload and this patched casedb across navigation so its first render cannot replace a just-closed case with a newer restore. The write is announced to the other running surfaces (`invalidateCaseData`) only once the route is decided: announcing earlier could reload or clear the source binding before routing finishes.
- **The carried case is the wire's match, valued from the complete case session.** `carriedCaseFor` asks `selectedCaseDatumId` for the target's projected own-case selection datum (`case_id` when flat, potentially `case_id_<type>` after root-menu alignment), evaluates a manual datum under that exact id when the link names its datums, and otherwise reads the source datum `matchFrameToSource` picked. `sourceSessionDatums` is the one mapping from source datum ids to values: the projected own-case datum is the case the form loaded; every projected ancestor/inherited selection reads the module-keyed case session that `FormScreen` already resolved through `previewMenuCaseContext`; a registration's `case_id_new_<module type>_0` is the case it created; and a subcase datum is the child case of its type the submission created. `projectTargetCaseSelections` values EVERY matched selection datum in the target frame; the exact `FrameDatum` already carries its stable source-module UUID through root alignment and frame-prefix projection, so Preview never reconstructs ownership from menu shape or display names. `FormScreen` applies that root-to-leaf projection before navigating, so manual parent datums and automatically matched created cases establish the same nested menu session the device frame establishes. Parent changes clear stale descendants before later target selections replace them; a defined blank datum stays installed so Core and Preview both skip a picker, while its empty id still binds no case. A nonblank selection is hydrated from the exact matching row in the transaction-captured post-submit patch before a module menu evaluates case-property conditions. Module landing is decided from that prospective session, including same-type structural inheritance, not from the pre-submit menu snapshot. The created-child mapping comes from the durable structured receipt: every concrete child names its authored child index and selected/generated parent, so `FormScreen` never infers metadata from flat result order. A historical receipt that carries only flat child ids remains replayable, but contributes no created-child metadata because that mapping cannot be proved. A non-repeat child bucket is one per case type (`caseWriteInventory.ts::childBucketKey`); when the form ALSO has a repeat bucket of that type the children cannot be told apart, so the datum stays unvalued rather than guessed. A manual XPath reads the same map, so `instance('commcaresession')/session/data/case_id_new_patient_1` names the created child.
- **A blank carried value binds nothing, visibly.** `previewCaseTarget.caseId === ""` is a case the navigation bound, to nothing; `FormScreen` opens the form without auto-selecting a case, loads nothing, disables Submit, and says the link carried no case. Absent `caseId` keeps meaning "direct preview, auto-select the first case".
- **Running menus use one UUID/topology projection.** `menuProjection.ts` consumes `lib/domain/moduleHierarchy.ts`: Home renders root modules only, while a parent module renders its native Forms (or an explicit **Cases** entry) plus its child-module tiles. `PreviewScreen` carries module/Form UUIDs, and retained component + scroll keys come from those UUIDs, so reorder cannot transfer state to a sibling. Module conditions combine through ancestry with `hidden` winning over `pending`; a child condition previews on its structural parent menu rather than Home.
- **A module target lands where the home screen lands it.** `moduleLanding.ts` reads the module-URL rule (`moduleScreenNavigation.ts`) from the outside: a module with children always lands on its menu so those children remain reachable; a terminal case-first or bare-case-list module opens Results unless its menu already has a selected case. Home tiles and after-submit module targets use the same rule.
- **Menu selection and Form launch are separate session facts.** A case-list/case-first parent selected through its explicit **Cases** entry stores a UUID-keyed ordered case set and returns to the parent menu; it does not seed a Form target. Same-case-type structural children may reuse that complete set only when `caseSelectionCanFlowBetweenModules` proves their authored type, cardinality, and maxima compatible. Different-type modules follow the case-type `parent_type` projection to the first case-active matching selector module in authored order (a bare case list or a module with at least one case form; survey-only modules do not own a case session), independently of structural menu parentage; Preview records an ordered selector/return chain, selects there, then constrains the child's Results query to the union of direct non-extension children of EVERY selected parent before continuing. A direct running Form or Results URL enters through that same module checkpoint while the parent selection is missing, so deep links cannot skip the chain. For a basic registration form, the selected parents remain navigation/session context: the form does not preload them or persist a primary-case index. Never infer case ancestry from `parentModuleUuid`.
- **The submit row stays running until the next screen is pushed**, because the write has landed and a second press must not land it again. A failure after the write (the read-back did not answer a row, the target is not in the document, the evaluation threw) settles an inline error that says the answers were saved and logs through `log.error`; it never throws and never silently goes back.
- **A just-closed case carried into a case-loading form finds no case in Preview.** The target form's own preload stays device-scoped, and the restore scope drops a closed root case, so a close form linking to a followup on the same case opens it bound to a missing row (Submit disabled) where the device, which has not synced yet, would open the closed case.

## Case-data Server Action wire shape (edge-WAF constraint)

Two rules govern the args these `caseDataBinding` Server Actions take. The edge Cloud Armor CRS rules that punish breaking them run in **log-only / preview** mode today (`scripts/infra/setup-cloud-armor-lb.sh` — they record would-be blocks, they don't 403), so this is wire hygiene that keeps the previewed-match logs clean enough to eventually enforce, not a hard gate:

- **Args must be plain JSON — never a `Map`/`Set`/`File`/`Blob`/`Date`.** React encodes a Server Action call as `multipart/form-data` the moment any argument holds one of those (a `Map` serializes as `$Q`, which forces a `FormData`); a plain-JSON payload goes as a `text/plain` body. The multipart envelope's `\r\nContent-Disposition: form-data; name=` part-header is what CRS `921150` reads as header injection. The running-app search bag is a `Map` in the client (`SearchInputValues`) and crosses as a plain object (`searchInputValuesToWire` / `…FromWire`) for exactly this reason.
- **Read/query actions ship the smallest domain slice they need, not the whole blueprint.** `loadCaseCountAction` takes `(appId, caseType)` plus an optional parent selection. `loadCasesAction` and the Details projection arm of `loadCaseDataAction` additionally take `caseTypes` (the live `CaseType[]` catalog — the only slice the SQL compiler reads: property data types + relation paths); a nested parent-select Results or Details request carries one plain-JSON `ParentCaseSelection` with the selected parent type and ordered case-id set. The case store validates the complete set against the app, Project, and type, then constrains both reads through the same union of direct non-extension case-index populations. Raw form loads omit both. `populateSampleCasesAction` / `resetSampleCasesAction` take the single live `CaseType`. The modules/forms/fields trees are dead weight on these paths (~30 KB) and stay off the wire. The catalog is sent **live** alongside the live `caseListConfig` (not re-read server-side) so the two stay consistent — a property rename/retype reaches both together, and a stale-schema compile can't happen. The filter inspector's structural query still accepts the full blueprint because it derives the effective case-type context from that live document; the payload stays plain JSON, so it never goes multipart.

## `commcare_project` comes from the deployment record

Preview names the project space a worker signed into exactly when one
deployment of this app has reached `uploaded` — the app is genuinely on that
project space, so a worker could have signed into it. It stays ABSENT when none
has, and when several have: choosing between two real answers would make a
condition on `commcare_project` pass here and fail for half the workers.
`lib/deployment/previewTarget.ts` is the rule, the builder page resolves it
server-side, and `DeploymentTargetProvider` carries it — durable server state,
so deliberately not the ephemeral session store.

It IS a usercase property in a way it is not a session key —
`callcenter/sync_usercase.py::_get_user_case_fields` ends with an unconditional
`fields.update({... 'commcare_project': domain})`, while
`users/models.py::CouchUser.get_user_session_data` is the sole injector of the
session copy. But **neither projection emits it empty**, and that is the split
from `language` and `phone_number`: HQ genuinely writes those as `''`
(`user.language or ''`), whereas the domain is never empty on a device. An
empty `commcare_project` is a value no worker can hold, so `= ''` would fire
here and never in the field; absent behaves like the device for every
comparison.

**The name key is `case_name`, not `name`.** `_get_user_case_fields` does put
`name` in its dict, but both writers pop it straight back out into the case's
name (`_UserCaseHelper.create_usercase`: `case_name=fields.pop('name', None)`;
`::update_user_case`: `kwargs['case_name'] = fields.pop('name')`), so it never
reaches the case's `<update>`. The device exposes the casedb's own `case_name`
node (`commcare-core .../CaseChildElement.java`), and HQ's
`app_schemas/case_properties.py::get_usercase_properties` lists no `name`
either.

**Every identity resolver threads the project space, not just the client one.**
`useSelectedPreviewIdentity` (browser), `resolveAuthorizedPreviewContext`
(server actions), and `submitFormAction` all pass it, because the
server-resolved identity is what binds `sessionUser` for the SQL compiler. A
client that had it and a server that did not would make one expression answer
two ways depending on which side evaluated it — the hardest kind of difference
to notice, since both halves look right alone. `lib/deployment/previewSpace.ts`
is the one resolver, kept out of the publish lifecycle module so a case-data
action does not import the expander and the HQ client to ask one question of
one table.

**The client copy follows every path that can change it, own-tab and
cross-tab alike.** The builder page resolves it server-side on load, the
publish response carries the server's fresh answer whether the publish
landed or was refused, and every Check status returns `previewProjectSpace`
beside the refreshed record (`RefreshedDeploymentView`); the publish dialog
applies all three to `DeploymentTargetProvider`. Every OTHER tab — a
co-member's open builder, a second tab of your own — converges through the
shared realtime stream: each deployment write pokes the app channel's
deployment lane in its own transaction, the relay re-resolves the rule and
emits a `preview-project-space` frame, and `DeploymentTargetProvider`
subscribes through the reconciler's `subscribePreviewProjectSpace` seam.
Every value on every path is the SERVER's resolution; a client-asserted one
would bypass the ambiguity rule only the server can apply.
