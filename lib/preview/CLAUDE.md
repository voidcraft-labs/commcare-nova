# Web Preview Engine

Client-side form preview running entirely from the in-memory blueprint — no XForm parsing, no server calls. Three subsystems: XPath evaluator, form engine, preview UI. Preview's function table is an explicit implementation contract, not an alias for JavaRosa's table: an unsupported function throws visibly instead of silently evaluating as blank. `instance('…')/...` is the one supported path initializer because session and fixture namespaces have concrete resolvers; `current()` is rejected until Preview can preserve its captured-context semantics.

## First-class date type in the XPath evaluator

XPath values include a `XPathDate` alongside string/number/boolean. `today()` returns a date (days-since-epoch internally, ISO string on coercion), so `today() + 1` yields tomorrow, not `NaN`. CommCare's arithmetic converts dates to day numbers; compatible typed emitters add the required wire coercion themselves. The experimental raw-XPath transpiler is not a production boundary and Preview must never assume that it ran.

Always use the shared XPath-to-string helper when stringifying results. Native `String()` on a date value gives `[object Object]`.

## Two `Child` / `Descendant` node types in the grammar

The Lezer grammar emits TWO distinct `Child` node types (one from the root-step rule, one from the expression rule) and likewise two `Descendant` types. `one('Child')` only finds the first. The evaluator and dependency extractor use `many('Child')` plus a `Set` / `.has()` check to catch both.

## Form engine lifecycle rules

- **Default values apply one-time on init, AFTER case-data preload** — so the preloaded case data sets the initial state and defaults only fill unset fields.
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
intent and preserves the existing scalar. When an ordinary field writer and a
case operation both target `external_id`, the ordinary form action runs last
and wins, matching the emitted CommCare transaction.

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
loading blueprint topology. The SERVER builds
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

## Repeat instances are first-class

Repeat children live at CONCRETE indexed paths (`/data/orders[1]/name`), one FieldState per live instance, while everything AUTHORED about them is index-free — `printXPath` emits `#form/orders/name`, the dependency extractor emits `/data/orders/name`. Three mechanisms bridge the two shapes (`instancePaths.ts` holds the conversions):

- **Evaluation binds to the instance.** `createEvalContext` rebases every read — `#form/` hashtags and absolute `/data/` paths — onto the evaluating node's own repeat instance by longest-common-repeat-prefix (`rebaseOntoContext`), CommCare's relative-reference semantic. A reference from OUTSIDE a repeat to a child inside one is not rebased and reads blank — the wire's nodeset semantics (sum over instances, indexed predicates) are not modeled.
- **The TriggerDag topology is index-free; queries materialize.** Nodes and edges are keyed by generic paths, and `getAffected` / `getAllPaths` fan each generic node out over the live instance counts (a `RepeatCountResolver` the engine supplies). Repeat add/remove therefore needs NO DAG bookkeeping; both cardinality changes re-evaluate EVERY instance (`position()` and renumbered sibling reads can shift on removal) plus outside dependents, and `addRepeat` runs defaults-then-evaluate for the new instance, the same order as form load.
- **Authoring cycle proof is a strict superset of runtime triggers.**
  `TriggerDag.reportCycles` temporarily adds field-DEFAULT dependencies so
  validation can reject loops through defaults; `build` / `rebuild` exclude
  them because defaults apply once during initialization. Lookup-choice
  filter dependencies are RUNTIME edges (the `choices` expression below) —
  the proof sees them through the ordinary collection, not the swap.
- **Instance counts are explicit.** `DataInstance` tracks cardinality in its own map, keyed by concrete repeat path — never derived from which value keys happen to exist (a repeat with only structural children still counts 1). `set` auto-extends counts from indexed path segments so restore/rename flows stay consistent. A new instance seeds the AUTHORED template shape — nested repeats restart at one instance, matching what the deployed form's `jr:template` produces — not `[0]`'s live shape.
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

**Two projections, because the wire has two.** `session` is `instance('commcaresession')/session/…` (`SessionInstanceBuilder.addMetadata` + `addUserProperties`); `usercase` is the `commcare-user` case `#user/<prop>` reads (`sync_usercase.py::_get_user_case_fields`). Same authored data, different built-in keys — `first_name` in the usercase, `commcare_first_name` in the session block — so collapsing them would make one of the two lie. The serializable session projection also carries `userPropertySlugs` (custom UUID→CURRENT slug), which is binding metadata rather than worker data; `previewUserPropertySlugMap` turns it into the typed emitter/compiler map. Thus both Predicate `session-user-property` and XPath `user-property-ref` evaluate against the same property after a rename without rewriting their AST, while name-backed built-in/external arms remain literal. Every session/usercase read uses an own-key lookup, so authored `__proto__` and `constructor` values cannot inherit from the object prototype. **The three location keys diverge, and it is easy to get backwards**: `get_user_session_data` writes all three or none, so the session block omits them while nobody is assigned anywhere, but `_get_user_case_fields` takes an `else` branch to `''` for all three, so the usercase always carries them. Values are otherwise honest: `commcare_project` is ABSENT in BOTH projections until a deployment names one (the domain is never empty on a device, so an empty value would be one no worker can hold), and the worker's name rides as `case_name` rather than `name` (HQ pops `name` into the case's name and never writes it as a property), while the session's first/last/phone keys and the usercase's first/last/phone/email keys are PRESENT, derived when possible and empty otherwise, because HQ writes those slots unconditionally. `user_type` IS present and reads `"standard"` — HQ sends the key only for a practice user, but every `commcare-core .../User.java` constructor calls `setUserType(STANDARD)` before `UserXmlParser::parse` applies any `<data key>`, so the device always has it and a condition on it must behave the same here. A DECLARED property with no value is present-and-empty, matching HQ's `UserData.to_dict` seed, while an undeclared key is genuinely absent — the split a `= ''` comparison depends on.

Server side, every persona-aware running path — Results/Details reads, sample populate/reset, and submission — calls `resolveAuthorizedPreviewContext` once. It authenticates the member, resolves membership plus the committed blueprint under the same app-row and membership locks, resolves the selector from that one authorized snapshot, and binds the explicit actor/owner pair. A selector naming a missing persona returns `persona-unavailable`; it never silently runs a read or write as the member. The selected owner rides populate/reset and `submitFormAction`, so all rows the persona creates belong to the persona, while the actor remains the authorization and lookup identity. Client side, `useSelectedPreviewIdentityState()` makes selected-but-missing a distinct `persona-unavailable` state rather than collapsing it with signed-out/loading or falling back to the member for one frame. `PreviewShell` replaces the running screens with an explicit unavailable-persona refusal and a **Preview as me** recovery action, while `BuilderFormEngineProvider` marks the `EngineController` blocked so activation cannot execute behind that refusal. Leaving Preview clears the persona selector before edit-only sample/data surfaces become active; the next preview therefore starts as the member unless the author chooses another persona. Visual consumers of the compatibility `useSelectedPreviewIdentity()` keep the server/client hydration render identity-free, while `BuilderFormEngineProvider` opts into a warm cached session and seeds that result on the `EngineController` inside its `useState` initializer — the provider itself renders no identity-dependent markup, and child effects flush before parent effects, so an effect-only install would hand every warm-session form mount an identity-less engine plus an immediate rebuild. A follow-up effect tracks later session changes. Identity is engine-lifetime state: a materially different identity rebuilds any active engine (one evaluation world), a re-derived-but-identical identity is a no-op (`samePreviewIdentity`), a cold session resolving mid-entry restores user-touched values through the engine's shared snapshot/restore (same touched-only contract as blueprint-edit recreation — untouched values may be world-dependent defaults and must re-derive), and replacing a NON-null identity (sign-out, different worker) discards — restoring would leak one worker's entries into another's session. Every suite that mounts `BuilderFormEngineProvider` (directly or transitively) must mock `@/lib/auth/hooks/useAuth`, or the session atom's `setTimeout(0) → fetchSession()` trips the async-leak gate. `#user/<prop>` resolves from the identity's `usercase` projection — the `commcare-user` case the wire's `#user/` hashtag expands to, NOT the session block, whose built-in keys differ (`first_name` there, `commcare_first_name` in the session). An absent key reads blank at evaluation, matching the device's missing property. The signed-out projection (`previewSessionValues(null)`) carries device context only.

## Case tiles in the running app

A `caseListConfig.tile` turns each Results row into a grid. `caseTileLayout.ts`
resolves the geometry and `caseTileRendering.ts` turns it into declarations;
`components/preview/shared/CaseTile.tsx` is the only renderer, shared by the
Results rows and the tile pinned above forms, so the two cannot draw one case
differently. Both files carry the CommCare citations — read them before changing
a number.

Three things the rest of the preview has to know:

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
- **The persistent tile is a separate read.** `PersistentCaseTile` loads its own
  row with the display config attached so calculated cells project exactly as in
  Results; the form's case read stays display-free because it feeds the engine.
  It sticks to the preview scroller, which is why `FormScreen`'s frame grows with
  its content (`min-h-full` + a growing frame) rather than being pinned to one
  viewport height — a sticky element can only travel as far as its containing
  block.

## Case data resolution

The nav stack carries only `caseId`. Case data is looked up by id at the point of use, not stored in navigation state. Swapping the data source (dummy → real API) only requires changing the lookup functions.

**Per-case-type refs resolve at every reachable depth, positionally.** The engine's case data is a per-case-type map (`CaseDataByType`, case-type name → property map) built by `caseRowsToFormPreloads` with the WIRE's semantic: each reachable type's namespace binds to the row at that type's blueprint depth — `expandCaseToWire` emits a blueprint-fixed `index/parent × depth` casedb walk with no case-type filter, so when the live parent chain doesn't mirror the blueprint's `parent_type` chain, preview and device read the SAME row at the hop count (and a depth past the chain's end reads blank on both). The rows come from `readCaseData`, which walks the bound case's `parent_case_id` chain server-side through the `parent` index edges, exactly `ancestorDepth` hops (the form's `reachableCaseTypes(...).length - 1`, client-supplied, server-clamped at 64 — any deeper `parent_type` chain is pathological authoring); the chain is ENRICHMENT — a dangling parent or a mid-walk failure degrades to the rows already fetched, never fails the load. The hashtag resolver (`formEngine.ts::createEvalContext`) looks an explicit `#<case_type>/<prop>` namespace up by type name and throws on raw `#case/...`; `caseRefAcceptMap` decides at authoring time which namespaces a form may reference. Both case-loading form types preload (`followup` AND `close`) — from the OWN type's entry only, since ancestor namespaces are read-only reference data, and only while the engine's supplied-under type still matches the module's (a mid-preview module retype withholds preload rather than seed field values from an ancestor's row — `ownCaseData`). Each per-row map (`caseRowToFormPreload`) carries the JSONB document PLUS the reserved scalar columns under their canonical Nova names (`date_opened`, `last_modified`, `case_id`, …), mirroring what the device's casedb exposes.

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

Running Results reads at most 50 cases per page. The action clamps every caller to a bounded window, appends a stable case-id sort tie-breaker, and returns the full matching total plus the effective offset (which may move backward after concurrent deletion). The client resets to page one whenever module, case type, authored configuration, submitted Search, assigned-case exclusion, or destructive replacement changes; an ordinary data update may retain the page, and the server's effective offset keeps a shrunken population from producing a false no-data state. Quick Filter is explicitly page-local whenever more matching cases exist. A canonical Details URL loads its case directly by identity when the row is off-page or excluded, but still sends the live display configuration and case-type catalog so that one row receives the same calculated-column projection as Results; the identity read never inherits Results filtering, sorting, or pagination. Empty worker searches carry an authored-only match count, so Preview says Search caused zero matches only when Cases available would otherwise reveal a row. Deterministic input/config failures use `invalid-search`, not a retryable transport error.

## Case-data Server Action wire shape (edge-WAF constraint)

Two rules govern the args these `caseDataBinding` Server Actions take. The edge Cloud Armor CRS rules that punish breaking them run in **log-only / preview** mode today (`scripts/infra/setup-cloud-armor-lb.sh` — they record would-be blocks, they don't 403), so this is wire hygiene that keeps the previewed-match logs clean enough to eventually enforce, not a hard gate:

- **Args must be plain JSON — never a `Map`/`Set`/`File`/`Blob`/`Date`.** React encodes a Server Action call as `multipart/form-data` the moment any argument holds one of those (a `Map` serializes as `$Q`, which forces a `FormData`); a plain-JSON payload goes as a `text/plain` body. The multipart envelope's `\r\nContent-Disposition: form-data; name=` part-header is what CRS `921150` reads as header injection. The running-app search bag is a `Map` in the client (`SearchInputValues`) and crosses as a plain object (`searchInputValuesToWire` / `…FromWire`) for exactly this reason.
- **Read/query actions ship the smallest domain slice they need, not the whole blueprint.** `loadCaseCountAction` needs only `(appId, caseType)`. `loadCasesAction` and the Details projection arm of `loadCaseDataAction` additionally take `caseTypes` (the live `CaseType[]` catalog — the only slice the SQL compiler reads: property data types + relation paths); raw form loads omit it. `populateSampleCasesAction` / `resetSampleCasesAction` take the single live `CaseType`. The modules/forms/fields trees are dead weight on these paths (~30 KB) and stay off the wire. The catalog is sent **live** alongside the live `caseListConfig` (not re-read server-side) so the two stay consistent — a property rename/retype reaches both together, and a stale-schema compile can't happen. The filter inspector's structural query still accepts the full blueprint because it derives the effective case-type context from that live document; the payload stays plain JSON, so it never goes multipart.

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
