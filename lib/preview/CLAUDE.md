# Web Preview Engine

Client-side form preview running entirely from the in-memory blueprint — no XForm parsing, no server calls. Three subsystems: XPath evaluator, form engine, preview UI.

## First-class date type in the XPath evaluator

XPath values include a `XPathDate` alongside string/number/boolean. `today()` returns a date (days-since-epoch internally, ISO string on coercion), so `today() + 1` yields tomorrow, not `NaN`. CommCare's runtime doesn't do this — it returns a raw day-number — so the transpiler wraps date-producing arithmetic in `date()` at export time.

Always use the shared XPath-to-string helper when stringifying results. Native `String()` on a date value gives `[object Object]`.

## Two `Child` / `Descendant` node types in the grammar

The Lezer grammar emits TWO distinct `Child` node types (one from the root-step rule, one from the expression rule) and likewise two `Descendant` types. `one('Child')` only finds the first. The evaluator and dependency extractor use `many('Child')` plus a `Set` / `.has()` check to catch both.

## Form engine lifecycle rules

- **Default values apply one-time on init, AFTER case-data preload** — so the preloaded case data sets the initial state and defaults only fill unset fields.
- **Required validation is deferred to submit.** Showing "required" on blur is bad UX because the user may have clicked in and navigated away. The red asterisk communicates requiredness until submission.
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
with Postgres-strict `is-null` semantics ("absent" ≡ "not
present in the JSONB document").

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
settled state on resolve. Since S07b the mutation also carries the
form's uuid plus plain-JSON per-scope operation answer bindings
(`computeOperationAnswers` — complete per iteration, parent-major,
multi-select as token arrays), and the SERVER builds the case-operation
program from the COMMITTED doc (`buildCaseOperationProgramFromDoc`:
S04 analyses + `buildCaseTypeMap` + the identity's session values,
`ordinary.caseType` populated for the rolling proof) — a survey with a
program executes it, and the envelope's typed `SubmissionRejectedError` surfaces as the
`submission-rejected` result arm with whole-rollback copy in
`FormScreen`. The close transition itself stays the
store's: it atomically owns both `closed_on` and the canonical
built-in `status = "closed"`; the preview must never supply or invent
its own status vocabulary. This keeps the live row aligned with
CommCare's `@status` attribute and makes a close form with no property
writes a complete lifecycle write by itself.

## Repeat instances are first-class

Repeat children live at CONCRETE indexed paths (`/data/orders[1]/name`), one FieldState per live instance, while everything AUTHORED about them is index-free — `printXPath` emits `#form/orders/name`, the dependency extractor emits `/data/orders/name`. Three mechanisms bridge the two shapes (`instancePaths.ts` holds the conversions):

- **Evaluation binds to the instance.** `createEvalContext` rebases every read — `#form/` hashtags and absolute `/data/` paths — onto the evaluating node's own repeat instance by longest-common-repeat-prefix (`rebaseOntoContext`), CommCare's relative-reference semantic. A reference from OUTSIDE a repeat to a child inside one is not rebased and reads blank — the wire's nodeset semantics (sum over instances, indexed predicates) are not modeled.
- **The TriggerDag topology is index-free; queries materialize.** Nodes and edges are keyed by generic paths, and `getAffected` / `getAllPaths` fan each generic node out over the live instance counts (a `RepeatCountResolver` the engine supplies). Repeat add/remove therefore needs NO DAG bookkeeping; both cardinality changes re-evaluate EVERY instance (`position()`/`last()` shift both ways) plus outside dependents, and `addRepeat` runs defaults-then-evaluate for the new instance, the same order as form load.
- **Authoring cycle proof is a strict superset of runtime triggers.**
  `TriggerDag.reportCycles` temporarily adds field-DEFAULT dependencies so
  validation can reject loops through defaults; `build` / `rebuild` exclude
  them because defaults apply once during initialization. Lookup-choice
  filter dependencies are RUNTIME edges (the `choices` expression below) —
  the proof sees them through the ordinary collection, not the swap.
- **Instance counts are explicit.** `DataInstance` tracks cardinality in its own map, keyed by concrete repeat path — never derived from which value keys happen to exist (a repeat with only structural children still counts 1). `set` auto-extends counts from indexed path segments so restore/rename flows stay consistent. A new instance seeds the AUTHORED template shape — nested repeats restart at one instance, matching what the deployed form's `jr:template` produces — not `[0]`'s live shape.
- **The runtime store is dual-keyed.** Every field keeps its uuid key (edit-mode rows); every path with an `[N]` segment ALSO gets a path key — the interactive renderer subscribes via `useEngineStateAt(uuid, path)` and writes through `controller.setValueAt(path, …)` / `touchAt(path)`, so two instances of one field hold independent value/visibility/validity. Uuid-keyed flows (`onValueChange`) address the `[0]` template only.
- **Doc mutations land on every live instance.** The controller's incremental handlers (field added / removed / renamed / retyped / expression edited during live preview) route through the engine's instance-aware ops — `materializePaths` expands the uuid map's `[0]` template path over the live counts, and `renamePaths` moves values/states in one batch (materialize-before-move, since renaming a repeat container relocates the count its descendants materialize through). A repeat→group conversion keeps only instance 0; the other instances' values are dropped with their states unplugged.

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
row's projection, self reads printed as `#case/` hashtags) and the module
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

**Two projections, because the wire has two.** `session` is `instance('commcaresession')/session/…` (`SessionInstanceBuilder.addMetadata` + `addUserProperties`); `usercase` is the `commcare-user` case `#user/<prop>` reads (`sync_usercase.py::_get_user_case_fields`). Same authored data, different built-in keys — `first_name` in the usercase, `commcare_first_name` in the session block — so collapsing them would make one of the two lie. The serializable session projection also carries `userPropertySlugs` (custom UUID→CURRENT slug), which is binding metadata rather than worker data; `previewUserPropertySlugMap` turns it into the typed emitter/compiler map. Thus both Predicate `session-user-property` and XPath `user-property-ref` evaluate against the same property after a rename without rewriting their AST, while name-backed built-in/external arms remain literal. Every session/usercase read uses an own-key lookup, so authored `__proto__` and `constructor` values cannot inherit from the object prototype. **The three location keys diverge, and it is easy to get backwards**: `get_user_session_data` writes all three or none, so the session block omits them while nobody is assigned anywhere, but `_get_user_case_fields` takes an `else` branch to `''` for all three, so the usercase always carries them. Values are otherwise honest: `commcare_project` is ABSENT (no deployment target), while the session's first/last/phone keys and the usercase's first/last/phone/email keys are PRESENT, derived when possible and empty otherwise, because HQ writes those slots unconditionally. `user_type` IS present and reads `"standard"` — HQ sends the key only for a practice user, but every `commcare-core .../User.java` constructor calls `setUserType(STANDARD)` before `UserXmlParser::parse` applies any `<data key>`, so the device always has it and a condition on it must behave the same here. A DECLARED property with no value is present-and-empty, matching HQ's `UserData.to_dict` seed, while an undeclared key is genuinely absent — the split a `= ''` comparison depends on.

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

**Per-case-type refs resolve at every reachable depth, positionally.** The engine's case data is a per-case-type map (`CaseDataByType`, case-type name → property map) built by `caseRowsToFormPreloads` with the WIRE's semantic: each reachable type's namespace binds to the row at that type's blueprint depth — `expandCaseToWire` emits a blueprint-fixed `index/parent × depth` casedb walk with no case-type filter, so when the live parent chain doesn't mirror the blueprint's `parent_type` chain, preview and device read the SAME row at the hop count (and a depth past the chain's end reads blank on both). The rows come from `readCaseData`, which walks the bound case's `parent_case_id` chain server-side through the `parent` index edges, exactly `ancestorDepth` hops (the form's `reachableCaseTypes(...).length - 1`, client-supplied, server-clamped at 64 — any deeper `parent_type` chain is pathological authoring); the chain is ENRICHMENT — a dangling parent or a mid-walk failure degrades to the rows already fetched, never fails the load. The hashtag resolver (`formEngine.ts::createEvalContext`) looks a `#<case_type>/<prop>` namespace up by type name; the transitional `#case/` spelling aliases the own type; `caseRefAcceptMap` decides at authoring time which namespaces a form may reference. Both case-loading form types preload (`followup` AND `close`) — from the OWN type's entry only, since ancestor namespaces are read-only reference data, and only while the engine's supplied-under type still matches the module's (a mid-preview module retype withholds preload rather than seed field values from an ancestor's row — `ownCaseData`). Each per-row map (`caseRowToFormPreload`) carries the JSONB document PLUS the reserved scalar columns under their standard names (`date_opened`, `last_modified`, `case_id`, …), mirroring what the device's casedb exposes.

Case-list sorting belongs to the Results composition. Equal authored sort priorities tie-break by `listOrder ?? order`, never by `detailOrder`; this is shared with the short-detail wire emitter. The confirmation screen independently renders `detailOrder ?? order`, so rearranging Details has no effect on row query order.

Case-data authoring is builder chrome, never simulated-app UI. `BreadcrumbStrip` owns the single persistent **Case data** manager: `loadCaseCountAction` reports the complete unfiltered population, an empty type may create samples, and replacing a populated type requires an explicit warning that ALL rows (including hand-entered / Preview-entered cases) are deleted. Successful populate/reset hooks advance `caseDataInvalidation` for `(appId, caseType)`; `useCases`, `useCaseData`, and `useCaseCount` all subscribe to that revision so one write refreshes every real-data representation instead of manually reloading the surface that launched it. Results and Details edit canvases do not query one case for decoration; real values belong to the running Preview.

Case-search scalar prompt defaults run through `engine/searchExpressionEvaluation.ts`: it emits the authored `ValueExpression` to the same XPath shape as the device and evaluates it with the preview XPath evaluator plus the authenticated user's session values. Date range is deliberately excluded: CommCare binds one paired start/end answer, while the historical domain slot can store only one scalar, so Preview never invents a From-only default. `hooks/useSearchInputRunState.ts` applies supported defaults once per module, refreshes only untouched prompts when a default/session value changes, and resets submitted state on a module switch; the flipbook therefore preserves worker edits without leaking the prior module's query. `caseSearchConfig.excludedOwnerIds` evaluates once at the authenticated Server Action boundary (so `session-context(userid)` is real), before any case row exists; the shared gate rejects property and relationship reads, while literals/session/Search values and pure calculations remain available. The result splits exactly like CCHQ on whitespace and joins `caseListConfig.filter` + submitted prompts as one Postgres predicate — never a client-side post-filter.

Preview derives navigation from the effective Search action, not from the mere presence of the compatibility settings bag. An explicit zero-input Search action with no Results filter renders one functional manual Search action; with an effective Results filter it submits automatically once for that module/config state. An owner-only exclusion still constrains every Results query, but it mounts no Search screen and triggers no automatic transition by itself. For a prompted Search, `searchButtonDisplayCondition` gates the whole combined Search pane from the case-list action's pre-prompt session/global context; it never reacts to the pane's draft, and the pane's single authored-label submit remains available whenever the action is relevant.

Running Results reads at most 50 cases per page. The action clamps every caller to a bounded window, appends a stable case-id sort tie-breaker, and returns the full matching total plus the effective offset (which may move backward after concurrent deletion). The client resets to page one whenever module, case type, authored configuration, submitted Search, assigned-case exclusion, or destructive replacement changes; an ordinary data update may retain the page, and the server's effective offset keeps a shrunken population from producing a false no-data state. Quick Filter is explicitly page-local whenever more matching cases exist. A canonical Details URL loads its case directly by identity when the row is off-page or excluded, but still sends the live display configuration and case-type catalog so that one row receives the same calculated-column projection as Results; the identity read never inherits Results filtering, sorting, or pagination. Empty worker searches carry an authored-only match count, so Preview says Search caused zero matches only when Cases available would otherwise reveal a row. Deterministic input/config failures use `invalid-search`, not a retryable transport error.

## Case-data Server Action wire shape (edge-WAF constraint)

Two rules govern the args these `caseDataBinding` Server Actions take. The edge Cloud Armor CRS rules that punish breaking them run in **log-only / preview** mode today (`scripts/infra/setup-cloud-armor-lb.sh` — they record would-be blocks, they don't 403), so this is wire hygiene that keeps the previewed-match logs clean enough to eventually enforce, not a hard gate:

- **Args must be plain JSON — never a `Map`/`Set`/`File`/`Blob`/`Date`.** React encodes a Server Action call as `multipart/form-data` the moment any argument holds one of those (a `Map` serializes as `$Q`, which forces a `FormData`); a plain-JSON payload goes as a `text/plain` body. The multipart envelope's `\r\nContent-Disposition: form-data; name=` part-header is what CRS `921150` reads as header injection. The running-app search bag is a `Map` in the client (`SearchInputValues`) and crosses as a plain object (`searchInputValuesToWire` / `…FromWire`) for exactly this reason.
- **Read/query actions ship the smallest domain slice they need, not the whole blueprint.** `loadCaseCountAction` needs only `(appId, caseType)`. `loadCasesAction` and the Details projection arm of `loadCaseDataAction` additionally take `caseTypes` (the live `CaseType[]` catalog — the only slice the SQL compiler reads: property data types + relation paths); raw form loads omit it. `populateSampleCasesAction` / `resetSampleCasesAction` take the single live `CaseType`. The modules/forms/fields trees are dead weight on these paths (~30 KB) and stay off the wire. The catalog is sent **live** alongside the live `caseListConfig` (not re-read server-side) so the two stay consistent — a property rename/retype reaches both together, and a stale-schema compile can't happen. The filter inspector's structural query still accepts the full blueprint because it derives the effective case-type context from that live document; the payload stays plain JSON, so it never goes multipart.
