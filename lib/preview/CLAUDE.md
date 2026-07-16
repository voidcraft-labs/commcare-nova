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

## Repeat instances are first-class

Repeat children live at CONCRETE indexed paths (`/data/orders[1]/name`), one FieldState per live instance, while everything AUTHORED about them is index-free — `printXPath` emits `#form/orders/name`, the dependency extractor emits `/data/orders/name`. Three mechanisms bridge the two shapes (`instancePaths.ts` holds the conversions):

- **Evaluation binds to the instance.** `createEvalContext` rebases every read — `#form/` hashtags and absolute `/data/` paths — onto the evaluating node's own repeat instance by longest-common-repeat-prefix (`rebaseOntoContext`), CommCare's relative-reference semantic. A reference from OUTSIDE a repeat to a child inside one is not rebased and reads blank — the wire's nodeset semantics (sum over instances, indexed predicates) are not modeled.
- **The TriggerDag topology is index-free; queries materialize.** Nodes and edges are keyed by generic paths, and `getAffected` / `getAllPaths` fan each generic node out over the live instance counts (a `RepeatCountResolver` the engine supplies). Repeat add/remove therefore needs NO DAG bookkeeping; both cardinality changes re-evaluate EVERY instance (`position()`/`last()` shift both ways) plus outside dependents, and `addRepeat` runs defaults-then-evaluate for the new instance, the same order as form load.
- **Instance counts are explicit.** `DataInstance` tracks cardinality in its own map, keyed by concrete repeat path — never derived from which value keys happen to exist (a repeat with only structural children still counts 1). `set` auto-extends counts from indexed path segments so restore/rename flows stay consistent. A new instance seeds the AUTHORED template shape — nested repeats restart at one instance, matching what the deployed form's `jr:template` produces — not `[0]`'s live shape.
- **The runtime store is dual-keyed.** Every field keeps its uuid key (edit-mode rows); every path with an `[N]` segment ALSO gets a path key — the interactive renderer subscribes via `useEngineStateAt(uuid, path)` and writes through `controller.setValueAt(path, …)` / `touchAt(path)`, so two instances of one field hold independent value/visibility/validity. Uuid-keyed flows (`onValueChange`) address the `[0]` template only.
- **Doc mutations land on every live instance.** The controller's incremental handlers (field added / removed / renamed / retyped / expression edited during live preview) route through the engine's instance-aware ops — `materializePaths` expands the uuid map's `[0]` template path over the live counts, and `renamePaths` moves values/states in one batch (materialize-before-move, since renaming a repeat container relocates the count its descendants materialize through). A repeat→group conversion keeps only instance 0; the other instances' values are dropped with their states unplugged.

In render paths, read repeat instance counts from `state.repeatCount` (via the engine-state hooks), not from `controller.getRepeatCount(uuid)` — the latter is a non-reactive method call. `addRepeat` / `removeRepeat` bump `repeatCount` on the repeat's own `FieldState` precisely to give subscribers that signal. `getRepeatCount` is fine outside render or in render paths whose lifecycle guarantees no add/remove can happen while mounted (e.g. edit-mode-only rows).

## Value persistence across engine recreation

Blueprint mutations in edit mode recreate the engine. The engine hook snapshots live-mode values before recreation and restores **only user-touched values**. Untouched fields pick up the new engine's defaults — this is what makes editing a `default_value` expression in edit mode immediately visible in preview.

## Case data resolution

The nav stack carries only `caseId`. Case data is looked up by id at the point of use, not stored in navigation state. Swapping the data source (dummy → real API) only requires changing the lookup functions.

**Per-case-type refs resolve at every reachable depth.** The engine's case data is a per-case-type map (`CaseDataByType`, case-type name → property map): the bound case's row under the module's own type plus one entry per ancestor in its parent chain, which `readCaseData` walks server-side through the case store's `parent` index edges (data-driven off the rows' `parent_case_id` links — no blueprint threading; `caseRefAcceptMap` decides at authoring time which namespaces a form may reference). The hashtag resolver (`formEngine.ts::createEvalContext`) looks a `#<case_type>/<prop>` namespace up by type name — the preview counterpart of the wire's `…/index/parent × depth …` casedb walk, with depth implicit in which row claimed the type name; the shallowest row of a type owns its namespace (`caseRowsToFormPreloads`), mirroring `reachableCaseTypes`' cycle guard. The transitional `#case/` spelling aliases the own type. Both case-loading form types preload (`followup` AND `close`) — from the OWN type's entry only, since ancestor namespaces are read-only reference data. Each per-row map (`caseRowToFormPreload`) carries the JSONB document PLUS the reserved scalar columns under their standard names (`date_opened`, `last_modified`, `case_id`, …), mirroring what the device's casedb exposes.

## Case-data Server Action wire shape (edge-WAF constraint)

Two rules govern the args these `caseDataBinding` Server Actions take. The edge Cloud Armor CRS rules that punish breaking them run in **log-only / preview** mode today (`scripts/infra/setup-cloud-armor-lb.sh` — they record would-be blocks, they don't 403), so this is wire hygiene that keeps the previewed-match logs clean enough to eventually enforce, not a hard gate:

- **Args must be plain JSON — never a `Map`/`Set`/`File`/`Blob`/`Date`.** React encodes a Server Action call as `multipart/form-data` the moment any argument holds one of those (a `Map` serializes as `$Q`, which forces a `FormData`); a plain-JSON payload goes as a `text/plain` body. The multipart envelope's `\r\nContent-Disposition: form-data; name=` part-header is what CRS `921150` reads as header injection. The running-app search bag is a `Map` in the client (`SearchInputValues`) and crosses as a plain object (`searchInputValuesToWire` / `…FromWire`) for exactly this reason.
- **Read/query actions ship the case-type catalog slice, not the whole blueprint.** `loadCasesAction` takes `caseTypes` (the live `CaseType[]` catalog — the only slice the SQL compiler reads: property data types + relation paths); `populateSampleCasesAction` / `resetSampleCasesAction` take the single live `CaseType`. The modules/forms/fields trees are dead weight on these paths (~30 KB) and stay off the wire. The catalog is sent **live** alongside the live `caseListConfig` (not re-read server-side) so the two stay consistent — a property rename/retype reaches the schema and the config it casts together, and a stale-schema compile can't happen. The two **authoring** previews (`loadCaseListPreviewAction` / `loadFilterPreviewAction`) still send the full blueprint on purpose — they preview unsaved *structural* edits the catalog slice wouldn't carry — and stay plain JSON, so they never go multipart.
