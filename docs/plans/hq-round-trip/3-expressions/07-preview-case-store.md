# Step 3, part 07: Preview and the case store

Part of [step 3's plan](../3-expressions.md), which holds the baseline, the decisions, the stack and
the exit. Part 01 fixes the `Expression` union, its types and its slot profiles; part 05 fixes the
session datums and instance reads; part 06 fixes CSQL composition and the fold; part 04 builds the
wire XPath tree, its one serializer and finding 56's per-operand lowering; part 08 holds the proofs.
This part fixes how Preview evaluates every slot under the union, the Core mismatches Preview must
correct first, what Preview supplies for every new read, which cases a search reads in Preview and
how choosing one plays HQ's claim, Preview's behaviour for finding 73, and how `lib/case-store/sql`
compiles the union's record arms, with the tests at each boundary.

Citations are `path::symbol` for Nova at `main` `5cf6e327`, and `file::symbol` for CommCare at the
pins `proof/pins.json` names: commcare-core `8e9ba8d908e9` (paths under `src/main/java` unless
named), commcare-hq `d6c6e16d8ae1` (paths relative to `corehq/apps` unless named), formplayer
`24383ac71bfb` (paths under `src/main/java/org/commcare/formplayer`), commcare-android
`7a5584475580`. Every CommCare fact was read at the pin. "Executed" names a run recorded under
"Executed during planning". Pull requests are the stack's fifteen, by number and name (the plan,
"The stack").

The catalog's `required` and `validation` slots retire (decided with the person, 2026-10-17; part
01). Neither Preview nor the case store evaluates them today (no reader of either in `lib/preview`
or `lib/case-store`), so nothing in this part changes for it.

## Decisions in brief

1. **Preview evaluates the device's own XPath.** From step 3 every Preview surface builds its slot's
   wire tree with part 04's one emitter, `toWire(expression, { target: "preview", … })`, prints it with
   `serializeWire(tree, { target: "preview" })`, and evaluates the printed text with Preview's
   evaluator. The Preview target differs from the wire in exactly one addressing rule, the
   query-bound repeat's flattened rows (§1.2). Every lowering, finding 56's included, is therefore the
   same code in Preview and on the wire. Today's Nova-dialect printing of form logic, the hashtag
   resolvers, the lookup folds and the AST-level Search answer bindings retire.
2. **Dependencies come from identity.** The trigger graph reads field UUIDs from the stored tree;
   `lib/preview/xpath/dependencies.ts::extractPathRefs` and `countDependencies.ts` are deleted. A
   relative read gets its edge (today it gets none).
3. **Preview's dates match Core before any lowering relies on them.** `format-date` and `date` over a
   node round as Core's do; an answer's held value follows Core by provenance, which fixes the
   repeated-hour divergence the parity run found; Preview's day numbers follow Core's zone-history
   formula, which is off by one in five Pacific zones (Kiritimati included), and Preview mirrors it.
4. **Every new read has a Preview supply,** listed in §3: the entry's session datums, casedb queries
   over the device snapshot, lookup tables, flat locations, selected cases, the inline search's
   results (part 05 §2.8's snapshot), `jr:itext`, `jr:choice-name`, `here()` from the browser's
   location as a bound parameter of the Postgres read, re-read by CommCare Android's rule (a move of
   more than 30 metres; the watch stops at a fix of 1,600 metres or better), and, from pull request
   10, the case chosen in an earlier menu wherever a record slot reads it.
5. **Preview refuses a form Core refuses at a setvalue** (finding 73): a preload or starting value
   whose text does not cast to the question's type stops the entry with a sentence naming the case,
   the property and the value, and a way back. Production holds no case row it refuses.
6. **The Postgres compiler dispatches over the union's record arms,** compiling each arm a
   Postgres-target profile admits and refusing every other arm with a compiler invariant that names
   why no admitted slot reaches it (§5.1).
7. **Predicates compile two-valued.** A comparison over a missing value is false, never SQL NULL, so
   `not`, `!=` and `= ''` agree with Core and with HQ. Executed: today Postgres drops a case missing
   the property from `not(p = 'x')`, `p != 'x'`, `p = ''`, `not(n < 5)` and even
   `not(p = 'x') or p = 'x'`, which every CommCare reader keeps. Production holds some record atoms,
   in a few apps, that answer differently for a case that lacks the property, and every case row of
   the case types they read holds it, so no Preview result changes today.
8. **One reading switch replaces `portableCaseDates`.** Each compile site states whether the rows it
   reads stand for a device's casedb, a device's search results instance, or HQ's search
   (`CaseReading`), which decides system dates, day numbers, the `closed_on` column and, for HQ's
   search, the population (§3.5).
9. **Datetime comparisons compile as instants and agree with the device lowering.** Naive datetime
   text pins to UTC everywhere, property reads included; an explicit `datetime-coerce` of a date is
   UTC midnight; a casedb `date_opened` or `last_modified` is the worker's midnight because that is
   the Date Core holds. Equality of two datetimes is instant equality, which is what part 06 §3.13's
   closed range asks HQ and part 04's lowering asks Core. One agreement test runs part 08's finding 56
   operand table through Postgres in four viewer zones.
10. **`lib/case-store/sql` stays the only evaluator of case rows;** Preview's XPath evaluator runs
    form logic over the device snapshot as Core runs it over its casedb. The two never substitute
    for each other (§5.9).
11. **A search reads HQ's population, and choosing a case plays the claim.** Results after a
    completed or submitted search, and the snapshot a form of an inline-search module reads, hold the
    Project's open cases of the searched type with the owner exclusion and filters, not the worker's
    restore. Choosing a case the worker does not hold seeds that worker's restore with it, as HQ's
    claim extension does, so its form opens with the case as on a device, and Preview plays the claim
    where CommCare posts it: on choosing a search action's result, and in a search-first module once
    a form is chosen, so the form menu shows before it (§3.5). No claim row is
    written. Preview's claims live in `lib/session`; an App Test journey's claims live in its own
    persisted session state (`AppTestSessionState.claimedCaseIds`), because journeys run on the
    server; the non-writing `evaluateForm` capture sends none (§3.5).

---

## 1. Preview's evaluation route under the union

### 1.1 Today

Preview has two routes:

- **Form logic** (field `relevant`, `validate`, `calculate`, `default_value`, `required`,
  `repeat_count`, `data_source.ids_query`, prose outputs, Connect) is printed to **Nova's dialect**
  (`lib/domain/expressionSource.ts::expressionSource` → `printXPath`: `#form/…`, `#<type>/<prop>`,
  `#user/…`, `#search/…`) and evaluated by `lib/preview/xpath/evaluator.ts::evaluateRuntime`, which
  re-parses the text with Lezer on every call. Hashtags resolve in
  `lib/preview/engine/formEngine.ts::createEvalContext` (`resolveHashtag`, a regex over
  `#<namespace>/<prop>`, and `resolveHashtagValue` → `xpathInstances.ts::previewHashtagNodeSet`).
  In the browser the text goes to the XPath worker (`engineController.ts`,
  `lib/preview/xpath/workerProtocol.ts`, protocol 7), with hashtag values serialized beside it
  (`XPathWorkerInstances.hashtagValues`).
- **Typed carriers** (navigation display conditions, Search defaults and hidden values, Search
  `required.when` / `validation.rule`, lookup filters, case-backed choices) are rewritten at the AST
  (`runtimeBindings.ts::bindSearchInputValuesInExpression` / `…InPredicate` substitute Search answers;
  `lookupEvaluation.ts::foldTableLookupsInPredicate` / `…InExpression` fold `table-lookup` to a text
  literal), printed by the on-device emitters (`lib/commcare/expression/onDeviceEmitter.ts::emitOnDeviceExpression`,
  `lib/commcare/predicate/caseListFilterEmitter.ts::emitCaseListFilter`, with a private
  `#case/<prop>` self token in `displayConditionEvaluation.ts`), and evaluated by the same evaluator.

So form logic never runs the wire's spelling: a lowering the wire applies to form logic (finding 56,
the datetime siblings, the trim nodes) would have to be re-implemented in Preview's dialect, and the
typed family's doctrine ("every surface prints the authored AST through the SAME on-device predicate
emitter the wire uses", `lib/preview/CLAUDE.md`, "Lookup carriers") holds for half of Preview.

### 1.2 Decision: one device emitter, one Preview target

From step 3 every Preview surface builds the slot's tree with `toWire(expression, ctx)` at
`ctx.target: "preview"` and prints it with `serializeWire(tree, { target: "preview" })` (part 04 §2.2,
§2.3); the wire calls the same two functions at its own targets. Everything a lowering decides
(finding 56 per operand, `date-add`, the multi-select and trim lowerings, the instance declarations)
is target-independent code. The Preview target differs from the wire where Preview's evaluation world
is shaped differently from the device's, and that is one rule, which lives in `toWire`'s field
resolution and not in a serializer mode (part 04 decision 3):

| Construct | Wire | Preview | Why Preview differs |
|---|---|---|---|
| a field inside a query-bound repeat, and `repeat-row` | `…/<repeat>/item[…]/<child>`, `current()/../@id` on the `item` | `…/<repeat>[…]/<child>`, `@id` / `@index` on the flattened row | Preview's `DataInstance` flattens query repeats with `@id` / `@index` on the row and has no `item` step (`lib/preview/CLAUDE.md`, query-bound repeats; for the wire, `lib/commcare/xform/formPath.ts::FormPath.queryBoundIteration` adds the `item` step) |

Part 04 hoists nothing into a generated node (its §3.6 and decision 8: the lowering is inline in
every position), so no read of a generated node (`nova_<purpose>_…`,
`lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`) reaches Preview in step 3. A later step
that adds a generated operand is bound by this fact: Preview's main instance holds authored fields
only, and inlining a calculate is value-equal only for a String or a number, because Core recomputes
a calculate whenever its inputs change and wraps a String or a number without loss, while a
Date-valued node is rounded into `DateData` (`org/javarosa/core/model/condition/Recalculate.java::wrapData`).

Every other read prints exactly as the wire prints it, because from step 3 Preview supplies the
instance the wire reads (§3; part 04 §2.3: the `preview` mode "prints as `xform` does, with the
instance ids the wire declares"): `#<type>/<prop>` prints the wire's casedb walk
(`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/<datum>]/…`)
over the device snapshot, `#user/<prop>` the walk to the worker's `commcare-user` row, lookup reads
`instance('<tag>')/<tag>_list/<tag>[…]` over the fixture instances, Search answers
`instance('search-input:results[:inline]')/input/field[@name='<name>']`, session reads
`instance('commcaresession')/session/…`, and `jr:itext`, `jr:choice-name` and `here()` their own
calls. Text crosses the worker boundary as today: the evaluator is text-in, so one evaluator serves
every surface and Preview evaluates exactly the bytes Core parses, parentheses and all.

The printed text is cached per tree and target (the emitter memoizes per document, like
`planGeneratedNodes`, and the serializer per node, part 04 §2.1), and
`lib/preview/xpath/evaluator.ts::evaluateRuntime` memoizes its parse per source text in a bounded LRU
(2,048 entries per evaluator instance). Executed during planning: a 3,881-character lowered datetime
comparison costs 0.30 ms to parse and 0.07 ms to evaluate, so the cache removes four fifths of its
cost; the parity run's 0.65 ms per typed-against-text comparison falls accordingly.

### 1.3 Every Preview evaluation surface, from step 3

| File | Today | From step 3 |
|---|---|---|
| `lib/preview/engine/formEngine.ts` | `expressionSource(field, slot, printDoc)` prints Nova text; `createEvalContext` resolves hashtags; `computeDefault`, `initializeScope`, `initStatesInto` compare printed text with `"true()"` | `formLogicSource(field, slot)` (new, `lib/preview/engine/formLogicSource.ts`) returns `serializeWire(toWire(…, { target: "preview" }), { target: "preview" }).text`, memoized per document and slot; `createEvalContext` keeps `getValue`, `mainInstance`, `contextNode`, `resolveXPathInstance` and loses `resolveHashtag`, `resolveHashtagValue` and the `#case/` throw; requiredness reads the tree (`match-all`), never text |
| `lib/preview/engine/triggerDag.ts` | `extractPathRefs` / `countDependencies` over printed text; prose references printed then re-extracted | structural dependencies (§1.4) |
| `lib/preview/xpath/dependencies.ts`, `countDependencies.ts` | text walks | deleted; `formRootReadPositions` too (a form-root read is unrepresentable, part 01 §1.5) |
| `lib/preview/engine/xpathInstances.ts` | `casedb`, `commcaresession` (no `data/*`), lookups, `search-input:results:inline`; `previewHashtagNodeSet` | adds `session/data/*` (part 05 §1.8), `locations` (part 05 §2.4), the selected-entities instance (§3.1), `results:inline` through part 05 §2.8's `searchResultsXPathInstance(rows, catalog)` (§3.2), `search-input:results` for the Search screen; `previewHashtagNodeSet` deleted |
| `lib/preview/engine/engineController.ts` | `activateForm` mints the entry key; the Search screen's `evaluateSearchScreenXPath` sends text with `commcaresession` only | `activateForm` also builds `entrySessionData` (part 05 §1.8), the form text table (§3.3) and, for a form that reads search results, loads the search's snapshot (§3.2); the Search screen request carries `search-input:results` and the session's datums so far, which part 06 §3.9's runtime segments read |
| `lib/preview/xpath/workerProtocol.ts` | protocol 7 | protocol 8 (§1.5) |
| `lib/preview/engine/formLinkEvaluation.ts` | `printXPath` of the condition and datum xpaths; `/session/data/<id>` from `sourceSessionDatums` | the `preview` print, through the source entry (part 05 §1.4); session data from the entry map; `#<type>/` reads walk the patched device casedb captured at entry, as today; `sourceSessionDatums` retires into `entrySessionData` |
| `lib/preview/engine/displayConditionEvaluation.ts` | lookups folded, `emitCaseListFilter` with a private `#case/<prop>` token resolved from the selected row's projection | the `preview` print over the device snapshot and the fixture instances; a condition that reads case data is `pending` until the snapshot covers it (the three-valued visibility it already has); `navigationEvalContext`'s regex resolver retires; from pull request 10 the context serves `session/data/<id>` from the menu case map for a form display condition's chosen-case read (part 01 §4, "Chosen case") |
| `lib/preview/engine/searchExpressionEvaluation.ts` | Search answers substituted into the AST, lookups folded, then emitted | the `preview` print; the draft answers enter as the `search-input:results` instance the device's query screen holds (`withSeededHiddenValues` keeps seeding hidden inputs, as Core's `src/cli/java/org/commcare/util/screen/QueryScreen.java::init` does) |
| `lib/preview/engine/lookupEvaluation.ts` | per-row evaluation of a printed filter; `table-lookup` folded bottom-up | the filter evaluates as the itemset Core evaluates, over the fixture instance; `foldTableLookupsIn*` and `evaluateTableLookup` are deleted; the coverage predicates (`predicateLookupsCovered`, `expressionLookupsCovered`, `lookupOptionsSourceCovered`) stay, widened to form-logic and form-link carriers through the extractor registry (part 05 §2.3) |
| `lib/preview/engine/searchInputConstraints.ts` | sync path skips a `matches-pattern` leaf, worker path judges it | unchanged split; both evaluate the `preview` print |
| `lib/preview/engine/searchInputValidation.ts` | reads `composeXPathQueryEmission(...).runtimeRejections` | part 06 §4, step 1: composes the same emission and evaluates, over the search answers, the session (from `entrySessionData`), the device snapshot and the fixture and location instances, each runtime segment's value, each runtime choice's condition and each obligation of the segment IR (`lib/commcare/csql/segment.ts`), part 06's new kinds included; `searchFindsNothing` covers every kind; the results go to the server as plain JSON (`{ segments, choices }`), where `lib/commcare/csql/fold.ts::foldCsqlRuntime` folds them |
| `lib/preview/engine/runtimeBindings.ts` | `bindSearchInputValuesIn*`, `composeRuntimeFilter`, `previewCaseStoreBindings` | the two AST binders are deleted: device surfaces read the instance, and the CSQL path folds (part 06 §4); `composeRuntimeFilter` (simple-arm clauses) and `previewCaseStoreBindings` stay for the Postgres read |
| `lib/preview/engine/useCaseDatabaseSnapshot.tsx` | loads the device snapshot when printed text names `instance('casedb')` or a hashtag | loads it when any slot's tree holds `form-case`, a `worker-record` source, `cases`, `project`, `case-index` or `repeat-row` over a query repeat, or a navigation condition reads case data (one walk, `lib/domain/expression/walk.ts::readsDeviceCases`); the request carries the worker's claims (§3.5) |
| `lib/preview/engine/caseDataBinding.ts` | `loadCasesAction` binds `context.restoreScope` for every Results read; `loadCaseDataAction` and `loadCaseDatabaseSnapshotAction` bind it when device-scoped | a Results read in the `search` reading binds no restore scope (§3.5); every device-scoped read takes the worker's `claimedCaseIds`; `loadSearchResultsSnapshotAction` is new (part 05 §2.8; §3.2 above); from pull request 10 `loadCasesAction` and the reads that share a list's filter take `chosenCaseIds` (module UUID to case id, plain JSON) for a browse list's chosen-case reads (§5.1) |

The doctrine sentence in `lib/preview/CLAUDE.md` ("Lookup carriers") becomes the rule for every
surface: Preview prints through the device emitter and evaluates the printed XPath over instances
shaped like the device's; it never rewrites an expression into a value before printing it.

**Implementation correction, 2026-10-19:** the Preview target already existed at pull request 7's
base (pull request 5): form logic, form links and the trigger graph printed through
`toWire` / `serializeWire` at `preview` and read the stored tree structurally. Item 4 of §8 shrank
to the session map, moving navigation conditions, the Search screen and lookup filters off the
`suite` print, private tokens and folds, deleting the dead hashtag machinery, protocol 8, the parse
cache and a per-runtime text cache. So:

- `lib/preview/engine/formLogicSource.ts` is not created. A form runtime
  (`formExpressionRuntime.ts::formExpressionRuntime`) prints each slot once and holds the text for
  its own life, because the text depends on the runtime's bindings (a worker read with no
  `commcare-user` row prints the identity's literal), so the memo belongs to the runtime, never to
  the document. Requiredness already read the tree.
- `lib/domain/expression/walk.ts::fieldReads` and `::readsDeviceCases` are not added. Field reads
  come from `lib/commcare/xpath/wire/formReads.ts`, and the casedb load signal is
  `lib/preview/engine/expressionCaseReads.ts::expressionReadsCaseDatabase`, widened for `project`,
  a query-bound repeat's `repeat-row`, the worker-record and grouped-tile `session-datum`s, and,
  through `useCaseDatabaseSnapshot.tsx`, a navigation display condition that reads case data.
- The query-repeat flattened-row rule is not `toWire`'s: Preview passes its own form-node
  projection, `formExpressionRuntime.ts::previewFormNodeProjection`, in which a field of a
  query-bound repeat resolves without the `item` step.
- `emitSelfProperty` stays on the wire (the suite's form display conditions). Preview stops using
  its private self token and prints the shared suite emitters (`lib/commcare/suite/displayConditions.ts`)
  at `preview` over the device snapshot, reading the chosen case through the suite's casedb walk
  keyed on `session/data/<datum>`; `useNavigationDeviceCases.ts` hands the menus the controller's
  device snapshot.
- A lookup-backed choice list prints `lib/commcare/lookupOptions.ts::lookupOptionsNodeset` (new),
  the one nodeset the XForm itemset and the Search prompt also print, and `lookupEvaluation.ts`
  reads each selected row node back as its row; the folds and the per-row evaluation are deleted.
- A label or hint reference prints through the Preview target as the XForm's `<output>` for it
  reads (`labelRefs.ts`), so no prose surface keeps a second printing path.
- A `#<type>/<prop>` read prints `lib/commcare/xform/formCaseRead.ts::formCasePropertyRead` (new),
  the one casedb walk the XForm emitter and Preview share, keyed on the datum that holds the form's
  case (`session/data/case_id_new_<type>_0` for a registration's own case).
- `lib/preview/engine/xpathInstanceReferences.ts` is deleted with the hashtag machinery.
- `formText.ts` (§3.3) is pull request 9's, with its readers.

### 1.4 Dependencies from identity

`lib/domain/expression/walk.ts::fieldReads(expression)` (new) returns each `field` and `repeat-row`
leaf with its spelling and `climb`, and marks a read that only counts (a `count` over a repeat
container, `count-selected` aside, which reads a value). `TriggerDag.registerExpressions` resolves
each UUID through the `fieldPaths` map it already builds (`collectFieldPaths`) into the generic path
and adds the edge: a value edge, or a cardinality edge for a counted repeat (today's `countProof`).
Prose atoms already hold UUIDs, so `proseReferenceExpressions` stops printing them and the walk reads
the parts. A relative read inside a repeat resolves to the same iteration's path, so the edge
materializes per iteration exactly as an absolute read through `rebaseOntoContext` does.

Non-field reads (case, worker, session, lookup, location, selected-case, result rows) are constant
within an entry: the snapshot, the identity, the session map and the fixture capture are taken at
activation, and their change already rebuilds the entry (`lib/preview/CLAUDE.md`, the rebuild
rules). They need no graph edge.

**Container edges.** `fieldReads` yields the field a read names, never the containers on its path.
Today a container-prefix edge arises only from a `/data/…` spelling: `extractPathRefs`
(`lib/preview/xpath/dependencies.ts`) adds every `/data/` sub-path its walk builds, while a `#form/`
hashtag adds its full path alone. Nothing is lost by dropping it: `reportCycles` always adds the
container-to-descendant cascade edges (`lib/preview/engine/triggerDag.ts::collectRelevanceCascadeDependencies`),
so a loop a prefix edge closes is also closed through the cascade edge to the field read, and
`reportGraphCycles`' last filter, which keeps the cascade report and drops a twin over a subset of
its nodes, keeps the same one report and finds no twin to drop.

**Consequence for the gate.** The same `TriggerDag` proves the absence of cycles at commit
(`reportCycles`). A cycle that runs through a relative read is invisible today and is found from
step 3, as Core finds it (Core contextualises every reference into its triggerable graph,
`org/javarosa/core/model/FormDef.java::finalizeTriggerables`). Production holds relative reads in
many apps; the ones that can close a loop between two fields are `..` field reads and `current()/…`
field reads, which a few apps hold (the `.` reads in `validate` read the answer itself, and Core
orders no constraint, so they close none). The cutover's dry run runs the cycle rule over every
lifted document and counts the findings; any is a `target-gate` blocker the author resolves in the
app before the window ("Production and the cutover's dry run", part 09 §11).

### 1.5 Worker protocol 8

`XPATH_WORKER_PROTOCOL_VERSION` moves from 7 to 8 in pull request 7, Preview, which switches form
logic to the Preview target (§8). The changes:

- `SerializedXPathDate` becomes `{ kind: "date"; calendarDays: number; timeMilliseconds: number | null }`
  (§2.3 separates the calendar date from Core's day number).
- `XPathWorkerInstances.hashtagValues` and the two hashtag value interfaces are removed: no printed
  source holds a hashtag.
- The world's first request carries `formText` (§3.3) beside `main` and `secondary`; `secondary`
  carries the new instances of §1.3 as ordinary snapshots.
- `XPathWorkerProfile` keeps its five profiles.

A host and worker of different versions already refuse each other's messages, and
`XPATH_WORKER_BUILD_ID` already forces a fresh worker per deployment, so no tab mixes them.

### 1.6 What retires

`previewHashtagNodeSet`, `xpathWorkerHashtagReferences`, `serializeXPathWorkerHashtagValue`,
`resolveHashtag` / `resolveHashtagValue` in every `EvalContext` builder, `navigationEvalContext`'s
regex, the `emitSelfProperty` hook, `foldTableLookupsInPredicate`, `foldTableLookupsInExpression`,
`evaluateTableLookup`, `bindSearchInputValuesInExpression`, `bindSearchInputValuesInPredicate`,
`extractPathRefs`, `countDependencies`, `formRootReadPositions`, and Preview's uses of
`expressionSource`. `lib/domain/expressionSource.ts` keeps its display accessors for the two
consumers part 02 §6 names.

---

## 2. Preview's Core mismatches, fixed first

These land in pull request 7, Preview, below pull request 8's lowering, before any lowering relies on
Preview, and change nothing on the wire (§8). The parity run named here is under "Executed during
planning": a table of expressions (rows `r*`, `o2*`, `d*`, `n*`) evaluated by Core in four device-zone
JVMs and by Preview's evaluator in the same four zones.

### 2.1 `format-date`, `date` and `format-date-for-calendar` over a node

**Core.** `org/javarosa/xpath/expr/FunctionUtils.java::toDate` unpacks its argument and sends a
`Date` through `DateUtils.roundDate` (local midnight); `::expandDateSafe` returns a direct `Date`
unrounded and sends anything else (a node-set) through `toDate`. `XPathDateFunc.evalBody` calls
`toDate`; `XPathFormatDateFunc` and `XPathFormatDateForCalendarFunc` call `expandDateSafe`. So
`date(now())`, `date(/data/dt)` and `format-date(/data/dt, …)` round; `format-date(now(), …)` and
`format-date(coalesce(/data/dt, ''), …)` keep the clock.

**Preview today.** `lib/preview/xpath/coerce.ts::toDate` unpacks and returns the `XPathDate`
unrounded; `functions.ts` `date` rounds only a direct `XPathDate`, `format-date` and
`format-date-for-calendar` call `toDate`. Executed (the parity run): rows `o2a`
`format-date(dt node, '%H')`, `o2b` `format-date(date(dt node), '%H')` and `o2c`
`double(date(dt node))` differ from Core in all four zones (Core `00`; Preview the real hour), while
`o2d` (through `coalesce`) agrees.

**From step 3.** `coerce.ts` gains `toDateRounding(input)` (Core's `toDate`: unpack, then a
`XPathDate` with a clock becomes its local date) and `expandDateSafe(input)` (a direct `XPathDate`
unchanged, anything else through `toDateRounding`); `date` calls the first, `format-date` and
`format-date-for-calendar` the second. `toDate` keeps its name for the callers that read stored text
and must not round, `lib/preview/columnDisplay.ts::formatDateForPreview` and
`::formatIntervalForPreview`. Part 04's lowering relies on neither: its `format-date`
reads `coalesce(x, '')`, which unpacks first (part 04 §3.7).

### 2.2 Held answer values and the repeated hour

**Core.** A datetime answer entered through the widget is `DateTimeData` of the instant. Text that
enters a typed node through a setvalue (a preload, a starting value, a repeat insert) is cast:
`org/javarosa/core/model/actions/SetValueAction.java::processAction` calls
`AnswerDataFactory.templateByDataType(type).cast(val.uncast())`, and `DateTimeData.cast` is
`DateUtils.parseDateTime`, whose `parseTimeAndStore` converts the written clock into the device's
zone, keeps the written date, and re-resolves the wall time through `java.util.Calendar`
(`DateUtils.getDate(DateFields, String)`). Executed (the parity run's Core cast probe in
`America/New_York`): `2026-11-01T01:45:00.000-04:00` (05:45Z) is held as 01:45 EST (06:45Z), Java
resolving the repeated hour to its later occurrence; `2026-01-02T04:30:00.000Z` is held as
`2026-01-02T23:30-05`, a day late, because the written date is kept.

**Preview today.** Every datetime answer is re-read from its stored text by
`lib/preview/engine/dataInstance.ts::formAnswerXPathValue` → `XPathDate.parse`, which mirrors Core's
cast but re-resolves the wall time with JavaScript's `setHours` (`types.ts::localDate`), which takes
the earlier occurrence (executed: 01:15 and 01:45 on 1 November 2026 resolve to 05:15Z and 05:45Z).
So an answer the person entered at 01:15 EST (06:15Z, stamped `-05:00`) is held at 05:15Z: rows `d5`,
`d7`, `d8` of the parity table differ from Core (Preview prints `-04`, orders the pair backwards).

**From step 3, Preview holds what Core holds, by provenance:**

- **Reading an answer.** The instance holds each typed answer as Nova's canonical storage text
  (`lib/domain/temporalValues.ts`), which always carries the offset of its own instant in the viewer's
  zone. `formAnswerXPathValue` reads a datetime by that explicit offset, exactly (no wall-clock
  re-resolution), which is the instant Core's `DateTimeData` holds. This fixes `d5`, `d7`, `d8`.
- **Text entering a typed node through a setvalue** (preload, starting value, repeat insert) goes
  through `lib/preview/engine/answerCast.ts::castAnswerText(bindType, text)` (new), Core's cast for
  each bind type (§4.1), whose datetime arm is `XPathDate.parse` with the wall time resolved as Java
  resolves it: among the instants whose local fields equal the parsed fields, the latest
  (`types.ts::localDate` gains the rule; a skipped wall time moves forward by the gap in both
  runtimes, a native row checks it). The engine then stores the canonical text of the held instant
  (`temporalValues.ts::instantDatetimeValue(instant, zone)`, new), so the next read returns exactly
  that held value, Core's day-late quirk included, as the device shows it.
- **A calculate** keeps today's rule: a Date result into a datetime bind keeps its instant
  (`lib/preview/CLAUDE.md`), a String result stays text, as `Recalculate.wrapData` does.
- A same-entry rebuild keeps held values; it is Preview's own memory, not a save and resume.

The server's close-condition evaluation reads the submitted text through the same
`formAnswerXPathValue`, which is right because a submitted answer is that canonical text.

A picked time in the repeated hour is a separate question: Nova stamps a naive wall clock at its
earlier occurrence (`lib/domain/CLAUDE.md`, temporal values), and which occurrence each platform's
widget picks is step 4's.

### 2.3 Day numbers in five Pacific zones

**Core.** `org/javarosa/core/model/utils/DateUtils.java::daysSinceEpoch` is
`(roundDate(d) - EPOCH_TIME + DAY_IN_MS / 2) div DAY_IN_MS`, with `EPOCH_TIME` the device-zone midnight
of 1 January 1970; `toDate(Double)` is `dateAdd(getDate(1970, 1, 1), n)`, the same epoch plus `n`
fixed days and half a day, rounded. Where a zone's offset today differs from its 1970 offset by more
than twelve hours, both shift by a day and still round-trip. Executed (the parity run, in
`Pacific/Kiritimati`): Core gives `double(dt)` 20454 and `number(date('2026-01-01'))` 20453 where the
calendar gives 20455 and 20454. Executed (Core's formula against the calendar over all 418 zones of
Node's tz data): exactly five zones shift, each by −1 for every 2026 date: `Pacific/Apia`,
`Pacific/Enderbury`, `Pacific/Fakaofo`, `Pacific/Kiritimati`, `Pacific/Kwajalein`.

**Decision: Preview mirrors it.** Preview plays the device in the viewer's zone, and the quirk is
Core's own, self-consistent, and observable (a shown day number, `date(n)` from an epoch count).
`XPathDate` stores `calendarDays` (the local calendar date as UTC-epoch days) and exposes `coreDays`
through `lib/preview/xpath/coreDays.ts::coreDaysSinceEpoch(calendarDays)` and its inverse
`coreDateAdd(n)`, both computed as Core computes them from the browser's zone history
(`new Date(1970, 0, 1)` local midnight, fixed 24-hour days, half-day rounding). `toNumber`, `toDouble`
and `date(<number>)` use them; `toISOString` keeps the calendar date. Fractional days already agree
(`toDouble`, row `r4` equal in all four zones). Postgres mirrors it in the casedb and results readings
(§5.6). Formplayer computes these from a fixed offset in a UTC JVM; its reading in these zones is
step 4's, with its per-platform Preview.

**Implementation correction, 2026-10-19:** `XPathDate` is `{ calendarDays, timeMilliseconds }`
(the held instant, or `null` for a date). `coreDays` serves the numeric coercion of a Date through
`toNumeric` and `date(<number>)`, which truncates the number toward zero as Core's `toInt` does and
refuses one outside the `int` range; a direct Date in `toDouble` keeps
`DateUtils.fractionalDaysSinceEpoch`, the wall clock, as Core does, so `toDouble` does not use the
day number. `coerce.ts::toDateRounding` is Core's `toDate` exactly: a parsed string keeps its
clock, and `''` and NaN pass through, so a blank node in `date()` or `format-date()` gives `''` (a
Preview bug this fixed). Java's wall-clock resolution (the later occurrence in an overlap, forward by
the gap) lives in `coreDays.ts::javaWallInstant`, not `types.ts::localDate`. Day arithmetic is
Java's: `GregorianCalendar`'s Julian calendar before 1582-10-15, integer days past JavaScript's date
range, and `DateUtils.roundDate`'s round trip wherever Core rounds, which folds a BC day to AD (the
year is read without its era) and has no date for a Julian-only 29 February (`DateFields.check`),
so `date()` there gives Core's null and reading it throws as Core does; the parity rows name Core's
exception (`CORE_DATE_PARITY` schema version 2). The zone offset is Java's too, not the IANA
history: `java.util.TimeZone` keeps transitions only from 1900-01-01T00:00Z and reads every earlier
instant at the zone's current standard offset, never its local mean time, so Kiritimati counts
Julian 1500-01-01 as day -171656 and its clock steps back a day at the cutoff
(`lib/domain/javaZoneOffset.ts`, the `cutoff-*` parity rows). The parse cache is one
module LRU per JavaScript realm (`evaluator.ts::parseAdmittedXPath`, 2,048 entries), shared by
`evaluateRuntime` and `evaluateRuntimeAsync`, not one per evaluator instance. A calculated Date is
held as the node's runtime value (`DataInstance`'s calculated scalars widen to `XPathDate`): a
datetime bind keeps the instant, any other bind its date (`rounded()`), so a datetime Hidden Value
reads as Core holds it. The engine reads an answer by its bind type, not its field kind.

### 2.4 Tests for this section

`lib/preview/xpath/__tests__/coreDateParity.test.ts` (new, pure): the parity run's rows that touch
§2.1 to §2.3, plus `date(20453)` and a skipped-hour cast, each evaluated under `America/New_York`,
`Asia/Kolkata`, `Pacific/Kiritimati` and `UTC` by assigning `process.env.TZ` inside the test and
restoring it in `finally` (Node re-reads the zone on assignment; executed during planning). Expected
values live in `lib/preview/xpath/__tests__/fixtures/coreDateParity.ts`.

`proof/native/core/CoreDateParityRuntimeTest.java` (new) evaluates the same rows with Core and asserts
the same expected column, so the fixture is held to Core in the lane and to Preview in Vitest. It joins
part 08's `expression` family as a zoned class (part 08 §2.1): `families.py` gains
`ZONED_CLASSES["CoreDateParityRuntimeTest"]`, the four device-zone setups of `ZONES` (`utc`,
`new-york`, `kolkata`, `kiritimati`), and `CORE_CLASSES["CoreDateParityRuntimeTest"] = "expression"`;
the family's producer (`proof/native/producers/emit-expression-evidence.ts`) writes the fixture's rows
for it. Each zone runs in its own test JVM through part 08's `novaZone_<label>` tasks (`user.timezone`
per test task; `GRADLE_OPTS` does not reach the test JVM, part 08 §2.1), and the class's first
assertion is its own zone, as every zoned class's is. The Formplayer-like setups are not listed:
Formplayer's day numbers are step 4's. The failure it distinguishes: a Preview date path that stops
matching Core in one zone.

---

## 3. What Preview supplies for every new read

| Read (part 01 arm) | Preview supplies | Where | Gate while absent |
|---|---|---|---|
| `session-datum` in form logic and links | `entrySessionData` (part 05 §1.8): selections from the menu's case map, minted ids for created cases, `usercase_id` and `<datum>_parent_ids` evaluated over the snapshot | `commcareSessionXPathInstance` `data/*`; `sessionInstancePathValue` | the entry waits for its selections, as today |
| `cases` / `project` / row leaves (casedb) | the device-scoped snapshot (`CaseStore.readDeviceCaseDatabase`), unchanged shape, its restore seeded with the worker's claims (§3.5) | `caseDatabaseXPathInstance` | the snapshot's loading state |
| `form-case`, `#user/` (worker record) | the same snapshot, through the wire's walk (§1.2) | same | same |
| `table-lookup`, `table-rows`, `table-column` | the captured Project fixture snapshot | `lookupXPathInstances` under each table's XForm id (bare tag); form-link slots also under `item-list:<tag>` (`includeFixtureAliases`, part 05 §2.3) | coverage predicates, widened to form logic (part 05 §2.3) |
| `locations`, `location-field`, `location-level` | HQ's flat fixture shape from the persona's footprint | `locationsXPathInstance` (part 05 §2.4) | travels with the device snapshot |
| `selected-cases` | the batch form's ordered selection | §3.1 | the batch target is required before activation, as today |
| `cases { source: "search-results" }` in an inline-search module's forms | the completed search's open matches, up to 500, in HQ's results shape (part 05 §2.8) | §3.2 | no completed search: the refusal panel with **Go to Search**; a pending activation keeps its answers and waits for the snapshot |
| `input` in a no-matches form | the launching search's answers | `searchInputXPathInstance` (unchanged) | none |
| `itext` | the form's translation projection | §3.3 | none |
| `choice-name` | the field's static options and their labels | §3.3 | none |
| `here` (calculated columns) | the browser's location, bound into the Postgres read | §3.4 | the column reads `''` until a position arrives |
| day numbers | Core's formula in the viewer's zone | §2.3 | none |
| the chosen case (`session-datum` of a `selected-case` and its `project` over `casedb`) in a record slot, from pull request 10 | its id from Preview's menu case map (`previewMenuCaseContext`, the selection the navigation holds) and its properties from that case's row | a CSQL runtime segment: part 06 §4's fold over the session part 05 §1.8 builds for the module's case list step; a browse list's filter: bound into the Postgres read (§5.1); a form's display condition: `session/data` in the navigation's evaluation context (`displayConditionEvaluation.ts`) | the list or the form menu is reached only after the selection, as today; in a search-first module the form menu shows before the claim posts (§3.5), so a property of a searched case the worker's restore does not hold reads blank there, on a device and in Preview alike |

Two rules reach Preview through the printed text alone. A `cases` or `table-rows` query used as one
value is admitted (`many-values` is refused only for a structural read, part 03 §3.4), and Preview
already does what Core does when such a query matches more than one row: it throws
(`lib/preview/xpath/runtimeValues.ts::unpackXPathRuntimeValue`, `XPathNodesetCardinalityError`,
"Mirrors XPathNodeset.unpack()"), which the form shows through its existing runtime error boundary. A
custom property read in a query with no `@case_type` binds to its one declaring case type and prints
no predicate (part 04 §4), so Preview's casedb read returns the rows the device's does.

**Implementation correction, 2026-10-19: the table's lookup and places rows, as built (pull request
9).**

- Lookups: form-link evaluation already printed with `includeFixtureAliases` before this pull
  request, so what remained was coverage. `lookupEvaluation.ts::formLogicLookupsCovered(doc,
  formUuid, data)` asks `expressionLookupsCovered` of every expression slot of the form and its
  questions (`expressionSlotValues`, Connect and links included; a choice source keeps its own
  loading state), and `formEngine.ts::lookupDataCoversForm` adds it. Printing a table read needs the
  table's naming, so `toWire` threw while the engine was built; `EngineController` now holds back an
  entry whose logic reads a table the snapshot does not cover (`lookupWait`) and `setLookupData`
  starts it once a covering snapshot arrives. A same-entry rebuild that has to wait (an edit added an
  uncovered read mid-entry) keeps its entry key and the checkpoint it began with, and the covering
  snapshot resumes that same entry with its answers; a later rebuild while it waits keeps the first
  checkpoint, and opening the form again starts a fresh entry instead
  (`engineControllerLookupWait.test.ts`).
- Places: `lib/organization/footprint.ts::personaFootprint` had no production caller.
  `loadCaseDatabaseSnapshotAction` now returns `locations`, rows of
  `footprint.ts::locationFixtureRows` (the footprint, each place with its ancestor at every level)
  over `lib/organization/service.ts::readOrganizationPlaces` (the whole tree, archived places
  included), as plain JSON, so they follow the snapshot's restore-scope key.
  `xpathInstances.ts::locationsXPathInstance(rows, organization)` writes HQ's flat shape: ordered by
  site code; `@type`, `@id` and an `@<code>_id` for every level, the place's own id first and then
  its parents', so an ancestor at the same level wins; the fixed children in HQ's order, with
  `location_type` the level's name and coordinates at ten decimal places; `location_data` with one
  child per property, empty where unset. `expressionCaseReads.ts` loads the snapshot for a read of
  places, and `caseDatabasePatch.ts` keeps the places through a submission's patch. App Tests give
  form evaluations the worker's places the same way, and their after-submit links too; the form
  check (`evaluate_form`) loads them through `engine/workerLocationFixture.ts`, which the snapshot
  action shares. No module display condition, case list or form display condition reads places:
  each is a record rule, and `typeChecker.ts::admission` refuses `locations` in every record rule, so
  menus and case lists need no place instance.
- `secondaryXPathInstances` serves the selected cases, the search results, the places and the
  table aliases, for the form engine and link evaluation alike.

**Implementation correction, 2026-10-19 (pull request 9 review):**

- The lookup wait has its failure and exit paths. `EngineEntryState.lookupWait` reports `loading`,
  `error` (the lookup load failed; `FormScreen` offers to try again through
  `useLookupPreviewData.tsx::usePreviewLookupReload`) or `unavailable` (a snapshot read for exactly
  the tables the document references still lacks one; `FormScreen` returns to Edit). While it waits
  the controller watches the document, so an edit that removes the uncovered read opens the form,
  and a waiting same-entry rebuild resumes with its answers. The lookup provider now tells snapshots
  apart by Project revision and the tables read: an edit that reads one more unchanged table reads a
  snapshot at the same revision, which the revision alone kept from ever reaching the controller.
- Places load only for an app that reads them. `expressionCaseReads.ts::appReadsPlaces` (a
  `locations` read or an `owner-location-at-level` owner in any form, question or link) decides for
  Preview's snapshot (the builder's document passes `includePlaces`, part of the snapshot's reload
  key, since an edit reaches the builder before its save), for App Tests and for `evaluate_form`.
  `footprint.ts::LocationFixtureRow` is the one row type; `PreviewLocationRow` is gone.
- Site-code order is not HQ's in every case. HQ sorts the flat fixture with
  `order_by('site_code')`, and `SQLLocation.site_code` declares no `db_collation`, so the order is
  the HQ database's default collation, which the deployment sets (the HQ checkout pins none) and
  Nova cannot read. Preview sorts by code point. Nova's site codes are lowercase letters, digits,
  `_` and `-`; codes of letters and digits alone sort alike under code point, `C` and the usual
  libc and ICU collations, while codes that differ at a `_` or `-` can sort differently on an HQ
  database that collates punctuation by language rules. That difference stays open.

### 3.1 Selected cases

`xpathInstances.ts::selectedCasesXPathInstance(datumId, caseIds)` (new) builds
`<results><value>id</value>…</results>` under the instance id the form declares (the multi-select
datum id, part 05 §2.5), from `previewCaseTarget.cases` in selection order. Core builds the same
(`org/commcare/core/process/CommCareInstanceInitializer.java::setupSelectedEntitiesInstance`).

**Implementation correction, 2026-10-19 (pull request 9):** `entrySessionData` builds the
selection into the entry session (`selectedCases`, keyed by the datum id), and the controller hands
it to the engine with the session's datums on every rebuild of the entry
(`EngineController.entryRuntimeOptions`). Android has no several-case selection, so the read runs
where the module does; step 4's platform declaration governs both.

### 3.2 The inline search's results

Search results read in the forms of an inline-search module stay in step 3, with Preview supplying
the results set the search returned to that form. Part 05 §2.8 plans the read in full, Preview's
supply included; this section states the HQ facts Preview's half rests on and uses part 05's design
and names. The snapshot is its own Server Action, not a read behind `loadCaseDataAction`, because that
action is the one-case identity read (positional arguments, a single `caseId`), and the snapshot reads
no related rows, because the arm never reads them.

On a device the read is the `results:inline` instance the query step filled
(`lib/commcare/session.ts::INLINE_SEARCH_RESULTS_INSTANCE`); HQ builds it from its search:

- open cases of the module's case types, at most `case_search/const.py::CASE_SEARCH_MAX_RESULTS` (500)
  rows, sorted by the request's sort or by score (`case_search/utils.py::CaseSearchQueryBuilder._get_initial_search_es`,
  `::_apply_sort`); 1,500 under the `INCREASED_MAX_SEARCH_RESULTS` toggle, which no API key reads;
- each row a `case` element with `case_id`, `case_type`, `owner_id`, `status` attributes, `case_name`,
  `last_modified` (`json_format_datetime`: UTC, six fraction digits, `Z`), `external_id` and
  `location_id` when set, `date_opened` (`date_to_xml_string` → `json_format_date`: the UTC calendar
  date), the custom properties as text, and the indices
  (`corehq/ex-submodules/casexml/apps/case/xml/generator.py::CaseDBXMLGenerator.get_root_element`,
  `::add_base_properties`, `V2CaseXMLGenerator.add_custom_properties`, `::datetime_to_xml_string`,
  `::date_to_xml_string`; `corehq/ex-submodules/dimagi/utils/parsing.py::json_format_datetime`,
  `::json_format_date`);
- related cases appended when Nova's search asks for them (`include_all_related_cases`), marked
  `commcare_is_related_case`, as `lib/commcare/suite/case-search/relatedCaseProjection.ts` decides.
  The arm's canonical print always excludes them (part 05 §2.8), so Preview loads none.

Because HQ writes `date_opened` there as the UTC day alone, a form reading it from a results row meets
the day rule as a casedb read does (part 03 §3.2, part 04 §3.4): compared with a moment that is not
day-aligned, or for equality with any date and time, it is refused (`day-only-on-device`); against a
day it stays a bare comparison, and Preview's held text compares it as the device does.
`last_modified` there is datetime text and lowers normally. The rule lands in pull request 9 with the
read (part 03 §10).

**From step 3 (part 05 §2.8).** `lib/preview/engine/searchResultsSnapshot.ts` and the Server Action
`lib/preview/engine/caseDataBinding.ts::loadSearchResultsSnapshotAction({ appId, moduleUuid, attempt,
inputValues, personaUuid, viewerTimeZone })` (plain JSON, `lib/preview/CLAUDE.md`, "Case-data Server
Action wire shape") run the read Results runs for the module's completed attempt
(`lib/session/previewSearchState.ts`), in the `search` reading (§5.2), with HQ's population (§3.5),
without a page window, in the Results order plan, limited to `SEARCH_RESULTS_CAP = 500`
(`lib/commcare/session.ts`, beside `INLINE_SEARCH_RESULTS_INSTANCE`, part 05 §2.8), and return `{ rows, totalMatches }`.
`xpathInstances.ts::searchResultsXPathInstance(rows, catalog)` builds HQ's element shape with HQ's text
spellings above, each stored custom property printed as HQ stores it (a `datetime` as
`json_format_datetime` of its instant, part 06 §3.13; a multi-select's tokens space-joined).
`EngineController` loads the snapshot at `activateForm` for a form the reference index lists as reading
search results, keyed by its entry key, so a same-entry rebuild keeps it and **Clear form** reads it
again; App Tests, `engine/evaluateForm.ts` and the after-submit link evaluation read the same snapshot.
A form reached with no completed search shows the no-matches form's refusal panel with **Go to
Search** ("This form reads what the search found. You can run the search, then choose the case
again."), and a search of more than 500 shows part 05's cap line. Preview uses 500 whatever the
toggle, because no API key reads a project space's toggles. The tests are part 05 §5's
`searchResultsXPathInstance.test.ts` and `searchResultsSnapshot.postgres.test.ts`.

**Implementation correction, 2026-10-19: the snapshot, as built (pull request 9).**

- The action takes the Results read's own arguments (`appId`, `caseType`, `moduleUuid`, the
  candidate document, `caseListConfig`, the owner exclusion, the attempt's answers or, after a
  no-matches registration, that one case id, the parent selection, the catalog, language, persona
  and viewer zone). `loadCasesAction`'s body moved into `prepareRunningCaseRead`, so Results and
  the snapshot share one read. `caseDataBindingHelpers.ts::readCases` gains a `cap` for unpaged
  reads that still counts every match. `readSearchResultsSnapshot` then reads each row's direct
  indices through `readCaseDatabasePatch`.
- `searchResultsXPathInstance` writes every row `status="open"`, `last_modified` with
  `json_format_datetime`, `date_opened` as the UTC day, `external_id` only when set, a date-and-time
  property in HQ's spelling, and `index` only when the case has indices, sorted by identifier, with
  `@relationship` only for an extension.
- Who loads it: not `EngineController` at `activateForm`. `lib/preview/hooks/useSearchResultsSnapshot.ts`
  loads it for `FormScreen`, keyed by the attempt, its answers, a registered case, the worker and
  the parent selection; neither claims (a search reads the Project's open cases, and in a
  search-first module the claim posts when the form opens, so keying on it would reload mid-
  activation) nor the document's identity is in the key. The engine waits for the snapshot
  (`FormEngineRuntimeOptions.searchResults`, carried by `entrySessionData.searchResults`). Which
  forms read it is a walk of the form's expression slots (`xpathInstances.ts::formReadsSearchResults`),
  not the reference index.
- **Clear form keeps the entry's snapshot** rather than reading the search again; a new search
  attempt reads again. This follows a device, whose session keeps its query step for the form.
- `FormScreen` shows a loading line and a failed line with try again beside the refusal panel and
  the cap line (`runtimeMessages.ts`, English and Spanish). `evaluateFormSnapshot` refuses a form
  that reads search results when its caller supplies no snapshot, with the panel's sentence. App
  Tests (`app-tests/run.ts`) read the session's latest search of the module again, unpaged and
  capped, with each row's indices: `appTestNamespace.ts::AppTestCaseStore` exposes
  `readCaseDatabasePatch`, which now joins the step's transaction (`PostgresCaseStore.dataTransaction`)
  instead of opening its own, which Kysely refuses inside one. Their paged Results read and this one
  share `engine/serverSearchRead.ts::serverRecordsRead`, and `app-tests/submission.ts` hands
  `evaluatePostSubmission` the form's evaluation context, its places and search results included.
  The MCP `evaluate_form` runs the module's search with the call's `searchAnswers` (as a completed
  search's values) or, without them, presses Search with its defaults, over the Project's open
  records through the same composition and cap, and reports `searchResults: { matched, held }`; a
  search that fails its checks, a scenario (whose test records give a search nothing to run over),
  and a search inside a parent chosen before the form are refused with a sentence naming the next
  step. An unpublished workspace has no records, so its search finds none. The tool's input schema
  and description are unchanged.

**Implementation correction, 2026-10-19 (pull request 9 review):** an App Test reads the search
results once per entry, at its first evaluation, and the form screen holds them (`searchResults`)
for every later step and the submission, as Preview's form keeps the snapshot it opened with; Back
to a form, a linked form and another search start a new entry that reads again
(`app-tests/__tests__/searchResultsEntry.test.ts`). `FormScreen` shows an `invalid-search` refusal's
own message with **Go to Search**, not the failed line with try again, because the same search fails
again. `evaluate_form` runs the search screen first and names a hidden Search action (its display
condition false for the worker) as the reason the form cannot open, rather than asking for
`searchAnswers` (`authoring/__tests__/formSearchResults.test.ts`).

### 3.3 `jr:itext` and `jr:choice-name`

**Core.** `org/javarosa/core/model/FormDef.java::initEvalContext` installs both handlers.
`jr:itext(id)` returns `Localizer.getText(id)` in the current locale (with the default locale's
fallback), `[itext:<id>]` when none is found. `jr:choice-name(value, path)` finds the select question
by absolute path, returns `''` unless it is a select, compares `value` to each static choice's value
exactly, and returns that choice's itext text (or inner text), `''` when none matches; an itemset
question has no static choices and throws inside the handler. An itext value holding an `<output>` is
stored as `${n}`, `n` the output's index in the form's fragment table
(`org/javarosa/xform/parse/XFormParser.java::recurseForOutput`, `::parseOutput`), so `jr:itext` of
such a text returns the placeholder, not the value.

**From step 3.** `engineController.ts::activateForm` builds the form's text table
(`lib/preview/engine/formText.ts::previewFormText(doc, formUuid, language)`, new) from the same
projection the XForm itext emitter writes for that language
(`lib/commcare/xform/itextIds.ts::itextIdFor`, part 02; `lib/domain/translationFill.ts::filledProse`
for the fill a worker reads): itext id → text, and question path → `[value, text]` of each static
option. `functions.ts` registers `jr:itext` and `jr:choice-name` reading `EvalContext.formText`, with
Core's exact-equality and empty results. A language change already rebuilds the entry, so the table
follows it.

**Implementation correction, 2026-10-19: the table, as built (pull request 9).** The form engine
builds the table (cached per document) and sends it to the worker only for a form that reads its
wording (`formText.ts::formReadsFormText`), rather than `activateForm` building it. `previewFormText`
leaves out the entries the XForm leaves out (`builder.ts::addItext`'s skip rule), so `jr:itext` of
one returns `[itext:<id>]`; a select whose choices come from a table or cases maps to `null`, and
`jr:choice-name` over it fails as Core's does. A language the app doesn't hold reads the default.
`xpath/functions.ts::invokeFormTextFunction`, called from `evaluator.ts` and `asyncEvaluator.ts`,
holds both functions; outside a form neither exists. `EvalContext.formText` and
`XPathWorkerInstances.formText` carry the table, the worker runtime keeps it with the world and
takes a newer one, and the protocol stays 8.

Text whose source, in any language, holds a reference is refused by the checker
(`XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, reason `itext-reference`; part 03 §3.7), because Core would
return its `${n}` placeholder, never the value. The copy: "`<question>` reads the wording of
`<owner>`, which includes an answer. CommCare would show a placeholder there instead of the answer.
You can read the answer itself instead." So Preview never needs Core's `${n}`.

### 3.4 `here()` in a calculated column

**Core and the runtimes.** `here()` has a handler only in list and detail contexts (part 03 §3.6).
Formplayer's `util/FormplayerHereFunctionHandler.java::eval` returns `''` when the browser sent no
location and otherwise `GeoPointData([lat, lon]).getDisplayText()`, two Java doubles joined by a
space; Android's `app/src/org/commcare/utils/AndroidHereFunctionHandler.java::eval` returns `''` until
a fix and then four values (latitude, longitude, altitude, accuracy).

In Preview a calculated column runs in Postgres (§5), so `here()` is a bound parameter:
`TermBindings.viewerLocation: string | null`, the Formplayer spelling (Preview plays Web Apps' browser
here; Android's four values are step 4's, with its per-platform Preview), built on the server from the
plain `{ latitude, longitude } | null` the client sends, formatted by Java's double text
(`lib/domain/expression/openJdk17DoubleString.ts`). `null` compiles to `''`, as both runtimes give
without a fix. Not refusing it keeps a working affordance working; a refusal would leave every
distance column blank in Preview while it works on a device.

The browser asks for a position only when a list or detail on screen runs a column whose tree holds
`here` (`caseListColumnRuns`), once per running session. While such a list is on screen Preview
watches the position and follows CommCare Android's rule (read at the android pin):

- **Refresh.** The first position re-reads the list; a later one re-reads it only when it is more
  than 30 metres from the position the list last showed
  (`app/src/org/commcare/utils/AndroidHereFunctionHandler.java::REFRESH_METER_DELTA = 30`,
  `::shouldRefreshEntityList`, which compares `lastDisplayedLocation.distanceTo(location)` and
  refreshes when there is no last position).
- **Stop.** The watch stops once a position of 1,600 metres accuracy or better is in hand
  (`::onLocationChanged` calls `forbidGpsUse()` when `getAccuracy() <=
  GeoUtils.DEFAULT_ACCEPTABLE_ACCURACY`, and `app/src/org/commcare/utils/GeoUtils.java::DEFAULT_ACCEPTABLE_ACCURACY = 1600`),
  so the list then keeps that position.

Formplayer reads the location the browser sends with each request and has no watch of its own, so
Android's handler is the one CommCare rule for a moving position, and it bounds the re-reads a moving
browser causes. The watch is `components/preview/form/fields/geopoint/geolocation.ts::watchGeolocation`
(new, beside the one-shot `requestGeolocation`, with the same typed `GeolocationFailureReason`s, and
returning the browser's reported accuracy in metres); the rule is
`lib/preview/engine/viewerLocation.ts` (new, pure): `shouldReReadForPosition(lastShown, next)`
measures the move with `lib/preview/xpath/javaRosaGeo.ts::javaRosaDistance`, Core's spherical
haversine (Android's `Location.distanceTo` is ellipsoidal, which at 30 metres differs by a fraction
of a metre), and `positionSettles(accuracy)` is `accuracy <= 1600`. The worker-facing copy lives in
`lib/preview/runtimeMessages.ts`. The position the list shows joins the Results read's request
identity, so each re-read is a new request. The position travels in the request and the query's
bound parameters only; Nova stores and logs neither. Copy, beside the list:

- while no position: "Columns that use your location stay blank until your browser shares it." with
  the action **Share my location**;
- after a refusal: "Your browser isn't sharing your location, so columns that use it stay blank. You
  can allow location for this site in your browser's settings."

**Implementation correction, 2026-10-19:** `distance()` cannot appear in a record column (part 03
§3.6), so the computable uses are a raw `here()` column and `within-distance(…, here(), …)` inside
an `if`; "every distance column" and the smoke's distance column become a raw `here()` column. At
the HQ pin Web Apps sends no position and its list rows never read the worker's location, so
Preview's moving-position rule is Android's, not Web Apps': a list that reads the position and
reads again after more than 30 metres. The spelling stays the one a CommCare handler given a
browser position returns, Formplayer's two `Double.toString` values
(`lib/preview/engine/runtimeBindings.ts::viewerLocationText`, which refuses a position that is no
place on Earth). The browser is asked once per session; each list that mounts starts its own watch
(`lib/preview/hooks/useViewerPosition.ts`), which settles per mount, as Android clears its "good
enough" on every fresh list; a read uses the latest fix and records it as shown; Details and the
tile send the latest fix without recording it. The trigger is a Results-field predicate,
`viewerLocation.ts::columnsReadHere(config, "list")` (and `"detail"` for Details), not
`caseListColumnRuns`. The position state is its own module store in `lib/session`,
`viewerPosition.ts` (`unasked`, `waiting`, `sharing`, `refused`, `unavailable`, `unsupported`). A
`within-distance` center accepts Java's E-notation (`5.0E-4`), the spelling such a handler gives a
small coordinate. The action is **Share your location** (Nova says "you", never "my"), and the note
has two more states: "Your browser couldn't find your location, so columns that use it stay blank.
You can try again." with **Try again**, and "This browser can't share your location, so columns
that use it stay blank.", each in English and Spanish.

### 3.5 A search's population and the claim

**What the device reads.** A search, whether the module opens on it (search-first, the inline shape)
or offers it as an action (the remote request), asks HQ's case search, which reads the project
space's open cases of the type, not the worker's restore
(`case_search/utils.py::CaseSearchQueryBuilder._get_initial_search_es`). Choosing a result posts a
claim (`lib/commcare/suite/case-search/claim.ts`, `buildInlineClaimPost` for the inline shape;
`lib/commcare/CLAUDE.md`, "Search and claim"). HQ's claim creates an open case of type
`commcare-case-claim` owned by the worker, with an extension index to the chosen case
(`corehq/ex-submodules/casexml/apps/case/cleanup.py::claim_case`: "Creates an extension case so that
the claimed case is synced to the claimant's device"; `case_search/models.py::CLAIM_CASE_TYPE`), and a
new claim makes the device restore before the form opens (`ota/views.py::claim` returns 201 for a new
claim; `lib/commcare/CLAUDE.md`). The claim lasts on HQ after the task ends.

**Preview today.** Every Results read binds the device's restore scope
(`caseDataBinding.ts::loadCasesAction` passes `context.restoreScope`), so a search finds only cases the
worker already holds, and `RestoreScopeNote` counts the rest as cases the worker "would not have".
Preview does not claim (`lib/commcare/CLAUDE.md`: "Nova does not reproduce that restore lifecycle in
Preview").

**Where App Test journeys run.** An App Test journey runs on the server, not in the browser:
`lib/preview/app-tests/service.ts` and `run.ts` execute each action inside one transaction over the
journey's isolated case-store namespace (`lib/case-store/appTestNamespace.ts`), with the restore scope
built per worker session by `lib/preview/app-tests/context.ts::contextFor`, and
`lib/db/appTests.ts` persists the journey's state (`AppTestState`, one `AppTestSessionState` per
retained worker session, with its identity, navigation, selections and `deviceCases`) as the
`app_test_sessions.state` JSONB it commits with each call's observations, and resets to `{}` when the
journey finishes. Nothing of a journey lives in `lib/session`, the browser's session store.

**From step 3, applied to every search:**

- **The population.** A Results read in the `search` reading (§5.2), which is a completed search of a
  search-first module or a submitted search of a module whose Search is an action, binds no restore
  scope: it reads the Project's open cases of the module's case type, with the module's owner
  exclusion and filters, the population HQ's search reads. §3.2's snapshot is that read, and so is an
  App Test journey's search Results (`lib/preview/app-tests/records.ts::appTestRecords`, whose
  `readCases` drops `restoreScope` in the `search` reading). A browse list (a module before its
  search, or one with no Search) keeps the restore scope and its `RestoreScopeNote`; a search's
  Results shows no such note, because HQ's search is not a restore. Both search shapes ask the same HQ
  search and both claim, so limiting the population to search-first modules would leave a Search
  action finding fewer cases in Preview than on its device.
- **Preview plays the claim when CommCare posts it.** Core posts an entry's `<post>` at the
  entry's sync request, which `CommCareSession.getNeededData` returns only once the current command
  names that entry (`getEntryForCommand(currentCmd)`, in the `entriesForCurrentCommand.size() == 1`
  branch) and every datum it needs is chosen. A search action's claim is its remote request's own
  `<post>`, the only entry of its command, so it posts as soon as a result is chosen. A search-first
  module's claim sits in each form's entry (`claim.ts::buildInlineClaimPost`), and through the
  module's menu the current command stays the module after the case is chosen, even when the module
  offers one form (`getEntryForCommand` of a menu id is null, so Core asks for the command): the
  claim posts once a form is chosen, and the form menu, with every form's display condition, is
  evaluated before it. A form link or an entry point whose frame names the form's command reaches
  the claim right after the selection. Preview posts at the same points: choosing the result of a
  search action, choosing the form of a search-first module (`components/preview/screens/CaseListScreen.tsx`,
  `FormScreen.tsx`), and opening a form from a link or an entry point; an App Test journey's
  `run.ts` the same. So a form display condition reading a searched case the worker's restore does
  not hold reads blank in Preview, as on a device; it stays admitted, as today's `#case/` reads of
  the selected case behave the same, and part 02's guide sentence says a chosen case's property is
  read after the case is claimed.
- **A claim adds the chosen case to the worker's claims.** Posting a claim for a search result (one
  case, or each case of a several-case selection) that the worker's restore does not hold adds its id
  to that worker's claims, an ordered set. In Preview the set is `previewClaims` in `lib/session` (new, keyed by app and the
  identity's `ownerId`), and every device-scoped read of that worker sends it as plain JSON
  `claimedCaseIds`: the device snapshot (`loadCaseDatabaseSnapshotAction`), the form's preload
  (`loadCaseDataAction` with `deviceScoped`) and the persistent tile. The server checks the whole set
  in one read (the app, its Project, a case type of the app), as the several-case Continue does, and
  `lib/case-store/sql/compileRestoreScope.ts` seeds the fixpoint for each claimed case as the claim's
  owned open extension would: the claimed case is live, and the fixpoint walks on from it as from any
  live case. The snapshot is read again when the set grows, as the device restores after a 201, so
  the form opens with the case preloaded and its `#<type>/` reads find it.
- **An App Test journey's claims live with the journey's session state.** `AppTestSessionState`
  gains `claimedCaseIds: readonly string[]` (`lib/preview/app-tests/types.ts`), so each retained worker
  session holds its own claims, as each holds its own identity and device snapshot. Posting a claim,
  at the points above, for a search result the session's restore does not hold appends its id there and re-reads the session's
  `deviceCases` with it, as the device restores after a 201; `contextFor` adds the session's claims to
  the `restoreScope` it builds, so the session's Results, Details, preloads and **Sync** all read the
  restore closure with them. `lib/db/appTests.ts` commits them with the rest of the state, so they
  survive between calls, and they clear when the journey finishes, as the whole state does. Another
  session of the same journey does not hold them, a session never reads the browser's
  `previewClaims`, and a journey leaves none behind in Preview. The search population and the claim
  change what a journey executes, and `lib/db/appTests.ts::RUNTIME_VERSION` fences them with the one
  move the stack makes, 15 to 16 in pull request 13, the cutover, whose `lib/preview/app-tests/CLAUDE.md`
  sentence names a search's population and claims (part 09, part 10). The stack deploys once, so no
  journey runs between pull request 7 and that move.
- **The non-writing form evaluator holds no claims.** The authoring tool's `evaluateForm` capture
  (`lib/agent/authoring/evaluationContext.ts`, `engine/evaluateForm.ts`) belongs to no running
  worker, so it reads the restore closure alone. It runs a search only for a form that reads what
  its module's search found, and posts no claim from it (§3.2's correction).
- **Lifetime in Preview.** The claims last while the worker, the app's Project and the page stay;
  Home keeps them, because a claim on HQ outlives the task, and so do **Clear form** and an engine
  `reset()`, which end no session. A change of worker drops that worker's claims, and leaving Preview
  is one, since it clears the persona selector. Preview writes no claim row: the case store holds the
  app's own case types, materialized from the blueprint, and a `commcare-case-claim` row would be a
  case type no author declared, which every tenant-wide surface would then show. A durable claim
  (a place in the case store for a case type Nova does not author, and a way to release it) belongs
  to the search workflow setting's step, step 5 (defect 21), and this plan's own pull request writes
  that into `docs/plans/hq-round-trip/5-case-writes-forms-navigation.md`.

**Implementation correction, 2026-10-19:** Preview's claims are one slot, `previewClaims { appId,
worker, caseIds }`, `worker` the persona's uuid or `"me"` for the signed-in member
(`lib/session/previewClaims.ts`), not keyed by the identity's `ownerId`; a key other than the
current app and worker reads none. Every restore-bound action takes `claimedCaseIds` through
`resolveAuthorizedPreviewContext`, which checks its shape (`previewAuthorization.ts::previewClaimedCaseIds`:
at most 1,000 distinct ids of 1 to 255 characters) and puts it in `RestoreScope.claimedCaseIds`. The client
keeps the 1,000 latest claims, a re-claimed id moving to the latest place, so a read never exceeds
the bound.
The store does not check the whole set in one read: each claimed id seeds the fixpoint only if it is
a case of this app in the bound Project, id by id in SQL (`compileRestoreScope.ts`, carrying the
case's own openness), so an id of another app or Project, or of no case, seeds nothing and refuses
nothing else. The search population is `QueryArgs.searchPopulation { heldBy }` (never together with
`restoreScope`): open cases only, and each returned row carries `heldOnDevice`, whether `heldBy`
holds it, computed in the same statement, so only an unheld choice is claimable
(`lib/preview/searchClaims.ts`). It covers Results, the several-case Continue check, Details opened
from Results, and App Tests' records and details (`app-tests/records.ts::recordsReadSearch`). A
search-first module's claim also posts at Preview's single-form auto-advance, and under a selected
parent it offers the entry's other case datums too (`searchClaims.ts::parentSelectClaimChoices`,
`buildInlineClaimPost`'s `parentSelect`). App Tests post at the same points
(`app-tests/run.ts::postAppTestClaims`) and keep the claims in `AppTestSessionState.claimedCaseIds`.
Leaving Preview, a confirmed Project change and `reset()` drop Preview's claims beside a change of
worker; the docs sentence reads "until you change the worker, leave Preview or reload the page".
- **Unchanged.** An entry point still opens only cases the worker's restore holds
  (`lib/preview/entryPointLaunch.ts`; a launch is not a search). A claimed case is held: the launch's
  device snapshot is a device-scoped read and sends the claims like every other, as the device holds
  a claimed case from its restore after the claim.
- **The device read's contract.** `CaseStore.readDeviceCaseDatabase` now takes the claimed ids, so
  `lib/case-store/CLAUDE.md`'s sentence "It never accepts a caller-supplied case-id list; both
  endpoints of every edge are re-fenced by app and bound Project in SQL." becomes, in pull request 7
  (part 10, "Contract sentences", `lib/case-store/CLAUDE.md`): "Its only caller-supplied ids are the
  worker's claims (`claimedCaseIds`: searched cases the worker chose that its restore did not hold).
  The store checks the whole set in one read (this app, its Project, a case type of the app) before
  any of them seeds the fixpoint, and both endpoints of every edge are re-fenced by app and bound
  Project in SQL." The case workspace, sample data and the rename preflight still read the tenant.
- **Production.** Production holds search-first modules and modules with a Search action, and case
  rows in a few apps, all open. No document or published byte changes.
- **Docs.** `content/docs/case-workspace.mdx`, "Preview without starting over", gains, in pull request
  7 (part 10, "Public docs that change"):
  "A search in Preview finds every open case in the project that matches, as CommCare's search does,
  including cases the worker doesn't have yet. When you choose one, it's added to the worker's cases,
  as it would be on a device, until you change the worker or reload the page."

---

## 4. Finding 73 in Preview

### 4.1 What Core refuses

`SetValueAction.processAction` evaluates the value, wraps it (`Recalculate.wrapData`), and casts it to
the target's bind type with `AnswerDataFactory.templateByDataType(dataType).cast(val.uncast())`; an
`IllegalArgumentException` becomes `XPathTypeMismatchException("Invalid data type in setvalue event
targetting |<ref>|…")` and the form does not open (or, for a repeat insert's setvalue, the insert
fails). Blank text never reaches the cast (`wrapData` returns `null`). The casts:

| Bind type | Cast | Refuses |
|---|---|---|
| `xsd:date` | `DateData.cast` → `DateUtils.parseDate` | anything but `Y-M-D` with integer parts and a real date, including a datetime's `T…` tail |
| `xsd:dateTime` | `DateTimeData.cast` → `parseDateTime` | no real date, a bad clock or offset |
| `xsd:time` | `TimeData.cast` → `parseTime(s, true)` | a bad clock |
| `xsd:int` | `IntegerData.cast` → `Integer.parseInt` | a fraction, surrounding space, out of `int` range |
| `xsd:decimal` | `DecimalData.cast` → `Double.parseDouble` | text Java's double grammar rejects |
| `geopoint` | `GeoPointData.cast` | fewer than two space-separated numbers |
| choices, `xsd:string`, untyped | `SelectOneData`, `SelectMultiData`, `StringData`, `UncastData` | never |

A `calculate` never casts (`Recalculate.apply` sets the wrapped value), so a calculate cannot refuse a
form this way.

### 4.2 Decision: Preview mirrors the refusal

Preview opens such a form today: `formEngine.ts::initializeScope` writes the raw case text
(`this.instance.set(path, own?.get(writer.property) ?? "")`), and the shape error surfaces only on
blur or submit (`answerShapeError`). From step 3, every setvalue Preview performs goes through
`answerCast.ts::castAnswerText(bindType, text)`, which ports the table above (a Java `Double.parseDouble`
grammar port, `lib/preview/xpath/javaDouble.ts`, beside `javaInteger.ts`, differential-tested like the
other Java ports), with `bindType` from the XForm emitter's own bind-type function, so the two cannot
disagree about which questions are typed (a Hidden Value binds by its writer destination,
`lib/domain/fieldValueType.ts`, part 04 decision 13). The setvalues are the preload in
`initializeScope` and `preloadCaseDataTracked`, the starting value (`computeDefault`,
`computeDefaultAsync`), and a repeat insert's defaults. A cast that succeeds stores the canonical text
of the held value (§2.2); one that fails refuses:

- at activation (preload, starting value): the entry becomes `refused`, a terminal state beside the
  existing "missing selected record" state, with no controls and a route back;
- at a repeat insert: the insert is not applied and the repeat shows the refusal in place.

App Tests and the non-writing evaluator (`engine/evaluateForm.ts`) report the same refusal as their
result (`form-refused`, with the sentence), so an agent learns why a form does not open.

Nova's own writers cannot create such a row once part 03 §4.3's writer agreement holds, and
production holds none: no case row fails a typed preload's cast, over the typed preloads from
declared-typed properties and the few from undeclared properties, whose rows hold no value. The
refusal covers rows from before a type change, a starting value computed from text, and the imported
data step 6 brings. The cutover's dry run counts the failing rows again at the window.

### 4.3 Copy

Content fundamentals: say what was tried and what went wrong, then offer the next step; sentence case;
no em dashes. `<type>` is "a date", "a time", "a date and time", "a whole number", "a number" or "a
location".

| Case | Heading | Body | Actions |
|---|---|---|---|
| preload | This form can't open for <case name> | <Case name>'s <property label> is "<value>", which isn't <type>, so CommCare won't open this form for it. You can correct the value in Case data, then open the form again. | **Open Case data** (for an editor of the Project), **Back to the list** |
| starting value | This form can't open yet | The starting value of "<question>" works out to "<value>", which isn't <type>, so CommCare won't open the form. You can change the question's starting value so it gives <type>. | **Back** |
| repeat insert | (inline, no heading) | A new <repeat label> can't be added: the starting value of "<question>" works out to "<value>", which isn't <type>. You can change the question's starting value so it gives <type>. | none |

The property label is the catalog label in the Preview language; a value longer than 60 characters is
shortened with "…" inside the quotes.

**Implementation correction, 2026-10-19, the casts:** the bind-type function is extracted from the
XForm builder into `lib/commcare/xform/bindType.ts::fieldBindType(field, caseTypes)`, which the
builder and Preview both call. `answerCast.ts` holds `coreAnswerType(bindType, kind)`,
`setvalueText(result, type)` (`Recalculate.wrapData(...).uncast()`) and
`castAnswerText(type, text, zone)`. `javaDouble.ts` moves out of `javaRosaGeo.ts`, and its grammar
refuses `NaNf` and `Infinityd`, which `FloatingDecimal.readJavaFormatString` accepts only as the
exact rest of the text. After a successful cast Preview stores Core's held text for the temporal
arms only: a date its normalized date, a date and time the held instant's canonical text, and a time
its written clock, because Nova's stored time carries a `Z` storage tag that means UTC and holding
Core's clock converted into the device's zone would move a saved time by the viewer's offset on every
save. A whole number and a number hold Core's uncast text (`IntegerData` and `DecimalData`, so
`007` holds `7` and a number `5` holds `5.0`), because that text is what the submission carries; a
location keeps the written text, as Nova's case store holds four-token locations. The refusal paths: an
activation preload or starting value makes the entry `refused`
(`EngineController.recordRefusal`); a person's repeat insert, and a row Preview materializes, is not
applied and the repeat shows the refusal in place; a refusal from a live default edit, a re-preload
or a schema heal also makes the entry `refused`, cleared on the next document or case-data change.
None reaches `faultReporter`. `FormRefusedError extends FormEvaluationInputError` carries
`form-refused` for `evaluateForm` and App Tests; no served enum changes. After a document edit, Preview tries each refused insert again under an atomic revision, so an
answer is never written while the probe's checkpoint is open.

**Implementation correction, 2026-10-19, the copy:** no per-value case editor exists, so the preload
refusal offers no **Open Case data** action and promises no correction in Case data. Its body ends
"You can choose another record.", and its actions are **Choose another record** and **Back to the
list**; the starting value keeps **Back**. English and Spanish ship together
(`lib/preview/runtimeMessages.ts`, `refusal*`, `answerType*`, `chooseAnotherRecord`,
`backToList`), and `refusalValueText` shortens a value over 60 characters with "…" inside the
quotes.

---

## 5. The Postgres compiler

### 5.1 Dispatch over the union's record arms

`compilePredicate.ts::compilePredicate`, `compileExpression.ts::compileExpression` and
`compileTerm.ts::compileTerm` become one exhaustive dispatch over `Expression` and `Term`
(`compileExpression` for every arm, boolean-typed arms through the predicate helpers); the
`never`-typed default and `unhandledKindMessage` stay. Arms by Postgres-target profile (part 01 §4:
case-list filter, calculated columns, sort keys, Search predicates, operations, excluded owners):

| Arm | From step 3 |
|---|---|
| kept record arms (`term`, `today`, `now`, `id-of`, `acting-user`, `unowned`, `table-lookup`, `date-add`, `concat`, `coalesce`, `if`, `switch`, `count` via a relation, `format-date` with a fixed pattern, comparisons, `in`, `between`, `match`, `multi-select-contains`, `within-distance`, `match-all`, `match-none`, `is-blank`, `and`, `or`, `not`, `when-input-present`, `exists`, `missing`) | unchanged compilation except the two-valued rule (§5.5), the readings (§5.2) and §5.3's naive pin and instant equality. `today` is the viewer's day (`compileToday`); in a CSQL slot the fold has already replaced it by the day Core's `today()` gives in the viewer's zone (part 06 §3.4), the same day |
| `arith` `div` | real division over `numeric` (today's `int`/`int` truncation moves to `quotient`, part 01's `quotient` rule; production holds no record `div`) |
| `arith` `quotient` | `trunc(a / b)` over `numeric`, today's integer division |
| `negate` | `-(numeric operand)` |
| `term choice` | refused with an invariant: the operation program builder (`buildCaseOperationProgramFromDoc`) resolves each `choice` to the text literal the XForm prints, from the committed document, before the program reaches the store; a static-select field is read only in the form-scoped slots that program carries (the cutover's lift turns production's literals opposite a static select into `choice`, in form logic and in record slots, part 09) |
| `term case-type` | its name as a text literal |
| `term case-row-type` | the anchor's (or the related row's) `case_type` column |
| `prop closed_on` | the `closed_on` column, only in the `search` reading; any other reading is an invariant (the checker refuses it there through part 06's search-only standard table, part 06 §3.1) |
| `date-coerce` / `datetime-coerce` of a number | epoch arithmetic (§5.3, §5.6) |
| `within-distance` with a runtime radius or unit | `CASE` over the nine units' meter factors (`lib/domain/expression/distance.ts::METERS_PER_DISTANCE_UNIT`, part 06 §3.8), an unknown unit or a radius not above zero giving no match; in CSQL slots the fold has made both literal (part 06 §4) |
| `multi-select-contains` with a runtime value | in device slots the checker admits only a single-choice value (part 06 §3.7), compiled `properties->'p' ? <value>`; in CSQL slots the fold has split it into literal tokens |
| `match` / `multi-select-contains` with a computed `property` | the compiled expression read as device text (`compileDeviceTextExpression`) |
| `if`, `switch` with clause branches | `CASE WHEN`, a null condition taking the else branch (part 06 §3.10) |
| `value-list` | `= any(<array>)`; `!=` its two-valued negation (part 06 §3.6); a node-set item (part 06 §3.6) reaches a Postgres slot only inside a runtime segment, which the fold has made a literal list |
| `here` | the bound `viewerLocation` text, `''` when null (§3.4) |
| `term session-user` / `session-user-property` with `source: "worker-record"` | a correlated read of the worker's `commcare-user` row (same app and Project, `hq_user_id` the bound owner id), the row Preview's `#user/` reads |
| `term session-context` (seven fields) | `TermBindings.sessionContext`; a field the identity does not supply binds `''`, as Core's absent node unpacks |
| `term session-datum` | from pull request 10, a `selected-case` (the chosen case's id) in a browse list's `caseListConfig.filter`: the bound text `TermBindings.chosenCaseIds[<module uuid>]`, which the Results read carries as plain JSON `chosenCaseIds` (module UUID to case id) from Preview's menu case map; in a CSQL slot the fold has already replaced it (part 06 §4); every other kind, and a `selected-case` the read does not carry, is an invariant, since the checker admits only a datum supplied before the module's case list step (part 06 §3.9) |
| `project` keyed on a chosen case (part 01 §4, "Chosen case") | from pull request 10, in the same filter: a correlated read of that case's row (same app and Project, the module's case type `T`, `case_id` the bound id), the shape the worker-record read takes, under the slot's reading; an id of any other case reads no row, so the property compiles as absent |
| `cases`, `project`, `table-rows`, `locations`, `selected-cases` (but the chosen case's `project` above) | refused with an invariant: in step 3 they reach a Postgres slot only inside a CSQL runtime segment, which the fold evaluates in the browser first (part 06 §4) |
| `call`, `itext`, `choice-name`, `repeat-row`, `case-index`, `field` with `filters`, `count` over a node-set, `format-date` with a computed pattern, `number()` of a date or a date and time, `matches-pattern` | refused with an invariant naming the profile rule that keeps them out (part 01 §4); the computed pattern and the record `number()` of a temporal value are the checker's `format-date-pattern-not-fixed` and `number-of-date` in every profile with a Postgres target, because Postgres cannot compile a computed pattern and a record `number()` of a temporal value has no meaning the record dialect teaches (part 03 §3.10; they stay admitted in form logic, part 02 §1.4 and §2.2) |

**Implementation correction, 2026-10-19** (pull request 10): the browse list's `chosenCaseIds` come
from `lib/preview/engine/entrySessionData.ts::caseListStepSession`, which builds the session at a
module's case list step (the datums before the module's own selection) from Preview's menu case map
and the device's cases; the Search screen reads its `data` as `session/data`. The Results read
checks the bag's shape (at most 64 menus, ids of 1 to 255 characters). A form's display condition
reads the same map with the form's own datum, through a `datumId` resolver on
`suite/displayConditions.ts::emitFormDisplayConditionForSuite` and `::emitFormDisplayConditionForHq`:
the form entry's ids after root alignment (`entryDatumIdResolver`), which Preview, the local suite's
command `relevant` (`compiler.ts`) and HQ JSON's `form_filter` (`expander.ts`, which HQ copies into
the command as written, so never `chainId`) all pass.

Every invariant's message is `lib/domain/expression/errors.ts::compilerBugMessage`'s (the formatter
`lib/domain/predicate/errors.ts` holds today, moved by pull request 5: "Internal bug: `<where>`:
<invariant>."), naming the profile rule that keeps the arm out. Today's `matches-pattern` arm
(`compilePredicate.ts`), which throws a plain `Error`, moves to it in the same pull request.

### 5.2 Readings: one switch for what a row stands for

Today `TermCompileContext.portableCaseDates` (calculated Results/Details values only) reads
`date_opened` and `last_modified` as the viewer's date, matching Core's casedb `DateData`; every other
compile site reads instants. That is right for calculated columns of a browse list and wrong in three
places: a browse list's filter (the device filters its casedb, where those two are `DateData`), the
columns of a search's results (the device reads HQ's results instance, where they are text), and case
operations (the form evaluates them over casedb).

From step 3 `TermCompileContext.reading: CaseReading` is required at every compile site, replacing
`portableCaseDates`:

```ts
type CaseReading = "casedb" | "results" | "search";
```

| Reading | Stands for | `date_opened`, `last_modified` | `closed_on` | Day numbers (§5.6) | Population | Compile sites |
|---|---|---|---|---|---|---|
| `casedb` | a device evaluating over its casedb | the viewer's date of the stored instant (`DateData`); against an instant, that date's midnight in the viewer's zone | not readable | Core's, viewer zone | the worker's restore with its claims (§3.5) | browse-list filter, calculated columns and sort keys (`readCases`, `readGroupedCases`, `readFilterPreview` for a module without effective Search); case operations (`submissionEnvelope.ts`) |
| `results` | a device evaluating over HQ's search results instance | `date_opened` the UTC calendar date of `opened_on` (HQ's `json_format_date`), `last_modified` the instant (HQ's UTC text) | not readable | Core's, viewer zone | the rows the search returned | calculated columns and sort keys of an effective Search's results |
| `search` | HQ's search | instants (`_create_system_datetime_query`, part 06) | the instant | HQ's calendar | the Project's open cases of the type, no restore scope (§3.5) | the composed search query of an effective Search (filter, simple-arm clauses, advanced predicates), and `searchResultsSnapshot.ts` (§3.2) |

`lib/preview/engine/caseDataBindingHelpers.ts` chooses the reading from the module's effective Search
(`lib/commcare/suite/case-search/xpathQuery.ts` already decides it for the wire, through the same
domain projection), and `lib/case-store/store.ts::SortKey` replaces `portableCaseDates?: true` with
`reading`. Authoring surfaces that read the whole tenant (case workspace, sample data, the rename
preflight) take `search`, the stored truth, as they show stored rows rather than a device's view.

In a device-evaluated slot a casedb `date_opened` or `last_modified` compared with a moment that is
not day-aligned, or for equality with any date and time, is refused (the day rule, part 03 §3.2 and
part 04 §3.4: `day-only-on-device`), so the `casedb` reading's promotion meets only day-aligned
operands from step 3. The same rule covers `date_opened` in the `results` reading: HQ writes it as
the UTC day, so it meets only days, and the reading compiles it as that date, never as an instant.
`last_modified` under `results` is HQ's datetime text, compiled as its instant, and the device lowers
it normally. The data type of both stays `datetime`; a reading decides only the class a row holds
them in (`DateData` in a `casedb` row, text in a `results` row, `date_opened` the UTC day there). A
plain `date_opened` column of an effective Search's Results takes the same reading, so
`lib/preview/columnDisplay.ts` shows HQ's UTC date there, as the device shows the results row's text,
and the plain and the calculated column show one day; in a browse list both show the viewer's date.
Production reads neither property in a case-list filter, a calculated column, a Search predicate or a
case operation of any live app, so the switch changes no Preview result today.

**Implementation correction, 2026-10-19:** one case-list read can hold two readings when its
module's Search is effective (HQ's query chooses the rows, the results instance holds the columns),
so `QueryArgs.reading` is `CaseQueryReading { filter: "casedb" | "search"; columns: "casedb" |
"results" }` (`lib/domain/expression/temporalType.ts`, with `CASEDB_READING`, `SEARCH_READING` and
`caseQueryReadingFor(module)`), and a count takes `CaseFilterReading` alone.
`TermCompileContext.reading: CaseReading` stays the per-compile value. `SortKey` loses its flag and
gains no field: sort keys and calculated columns compile under the read's `columns` half
(`postgres/store.ts::query`). `resolveCaseListTemporalType` takes the reading, and so does
`columnDisplay.ts`. The viewer-midnight promotion applies only under `casedb`. The `closed_on`
column is readable only under `search` (`compileTerm.ts::reservedColumnFor`), an invariant
elsewhere, and every invariant of §5.1 throws `compilerBugMessage`'s sentence.

### 5.3 Datetime comparisons

From step 3 every comparison of two datetimes compiles as an instant comparison, with these leaf
rules:

| Leaf | Compiles to |
|---|---|
| custom `datetime` property | `compilePinnedInstant(read, "UTC")`: an offset-bearing value by its offset, a naive one as UTC. Today the read is a bare `::timestamptz`, so a naive value follows the session `TimeZone` (executed: `2026-01-02T04:30:00 > 2026-01-02T06:00:00Z` true under `America/New_York`, false under UTC). No stored row holds one today (the schema's `date-time` format refuses a naive value; production's datetime properties hold few values, none without an offset), so nothing changes now; imported rows will |
| datetime literal | unchanged: a naive literal pinned to UTC (`compileLiteral`); a literal holds at most milliseconds (`datetime-literal-precision`, part 06's rule, landing in pull request 6, the checker) |
| `now` | the transaction instant, unchanged |
| `datetime-coerce` of text or a date | `compilePinnedInstant(value, "UTC")`: a date is **UTC midnight**, as HQ's CSQL means it (part 06 §3.4, `lib/case-store/sql/CLAUDE.md`), unchanged |
| `datetime-coerce` of a number | epoch days as an instant, `timestamptz '1970-01-01 00:00:00+00' + n * interval '24 hours'` (part 06 §3.5, which cites this rule): an interval of hours adds elapsed time, where `'1 day'` follows the session time zone's daylight-saving changes; in a device-evaluated slot the operand is `int` (part 06 `epoch-fraction-on-device`) |
| system date under `casedb` | the viewer-day `DateData`, promoted to that day's midnight **in the viewer's zone**: the Date Core holds is local midnight, so the device lowering reads exactly that instant (`format-date(coalesce(date_opened, ''), …)` formats a `Date` at local midnight with its offset) |
| system date under `results` | `date_opened` the UTC date, which the device holds as date-only text, and part 04's lowering reads that held class (part 01 §3.2's row stack carries the root, so the instant lowering never reads a date-only results value as an instant); it meets only day operands, since the day rule refuses it against a moment and for equality with a date and time; `last_modified` its instant |
| system date under `search` | the stored instant |

**Viewer midnight against UTC midnight.** The two rules are not in conflict once the operand is
named: the outline's UTC rule governs an **explicit** coercion of a date operand, which is Nova's
meaning and HQ's; the viewer-midnight promotion governs a casedb system date compared with an
instant, which is not a coercion but the instant of the `DateData` the device holds. Part 03 §3.2
refuses an uncoerced date against a datetime in every profile, so no other implicit promotion
remains: `temporalBranchPromotions` keeps its viewer-midnight promotion for the `casedb` system dates
and mixed branches only, and its comment says why. The device agrees with the explicit rule from step
3: `datetime-coerce` never emits `date()` on a device, and a date enters the lowering as its UTC
midnight (part 04 decision 9, §3.8), which today's on-device `date(x)` does not give.

**Equality of datetimes** compiles as instant equality, and from step 3 HQ and the device answer the
same question. Part 06 §3.13 emits `eq`, `neq` and `in` on a `datetime` anchor as a closed instant
range, which HQ answers by instant for every spelling its parser reads, and adds
`datetime-literal-precision`, so a literal names one millisecond in Elasticsearch and in Postgres
alike; part 04 lowers `=`, `!=`, `in` and `switch` between two datetimes to instant equality on the
device (part 04 decision 6, §3.3). `neq` is two-valued by §5.5. Production holds no such equality in
a CSQL slot.

**Implementation correction, 2026-10-19:** a custom `datetime` property read is a strict
stored-instant read (`compileTerm.ts::compileStoredInstant`), not `compilePinnedInstant`: its text
names an instant only in the shape a writer stores (`yyyy-MM-ddTHH:mm:ss`, any fraction, then `Z`,
`±HH`, `±HH:MM` or no offset) and where `pg_input_is_valid` reads it, a naive value as UTC, and any
other text, padded text included, reads `NULL`, so the two-valued rule gives the device lowering's
NaN answers and the query never fails. `datetime-coerce` keeps `compilePinnedInstant`, and a
`datetime-coerce` of a number is `coreDayNumber.ts::compileEpochDayInstant`.

### 5.4 The agreement test over the native fixture

`lib/case-store/sql/__tests__/instantOrdering.postgres.test.ts` (new) reads part 08's operand and pair
table, `lib/commcare/__tests__/instantOrderingTable.ts` (operand rows: an instant and how it is held,
text in each writer zone and fixed spelling, a typed date, `now()` under a fixed clock, malformed text;
pair rows with their operator, the DST pairs; equality pairs, part 04 §3.3). The table holds no
expected value: as `InstantOrderingRuntimeTest` computes each pair's verdict from `java.time`, this
test computes it from the rows' instants. It seeds each operand as a custom datetime property
(inserted through the `db` fixture, the schema's format check being the writer's, not the compiler's),
compiles each comparison with `compilePredicate` under each reading, with `viewerTimeZone` and the
session `TimeZone` set to each of `UTC`, `America/New_York`, `Asia/Kolkata` and `Pacific/Kiritimati`
(session and viewer zones chosen apart, so neither can decide a result), and asserts the verdicts: the
meaning Core is held to in part 08's `expression` family and Preview's evaluator is held to in
`lib/preview/xpath/__tests__/instantLowering.test.ts` (new, pure, the `preview` print of part 04's
lowering evaluated per zone as §2.4 does). The failure it distinguishes: any of the three runtimes
ordering or equating a pair differently from the other two in any zone.

### 5.5 Missing values: two-valued predicates

**What the readers do.** On a device an absent case property is an empty node-set, which unpacks to
`''` (`org/javarosa/xpath/XPathNodeset.java::unpack` → `XPathPathExpr.unpackValue(null)`), and `!=` is
the negation of equality (`XPathEqExpr.evalRaw`: `isEqOp == testEquality(a, b)`). HQ writes `!=` as
`filters.NOT` of `=` (`case_search/xpath_functions/comparison.py::_create_query`), `not()` as
`filters.NOT` (`case_search/xpath_functions/query_functions.py::not_`), `NOT` as a `must_not`
(`es/filters.py::NOT`), and `= ''` as "not set or empty" (`es/case_search.py::case_property_query` →
`::case_property_missing`). So for a case missing `p`, both keep it under `not(p = 'x')`, `p != 'x'`,
`p = ''` and `not(n < 5)`.

**Postgres today (executed, against the local dev Postgres 18.3 through Nova's own
`compilePredicate`, rows from a `VALUES` list in a read-only transaction):**

| Predicate | Postgres matches (of absent, blank, x, y) | Device and HQ |
|---|---|---|
| `not(p = 'x')` | blank, y | absent, blank, y |
| `p != 'x'` | blank, y | absent, blank, y |
| `p = ''` | blank | absent, blank |
| `not(n < 5)` | y | absent, blank, y |
| `not(in(p, 'x', 'y'))` | blank | absent, blank |
| `not(between(n, 1, 5))` | y | absent, blank, y |
| `not(p = 'x') or p = 'x'` | blank, x, y | all four |

The cause is SQL's third value: `properties->>'p'` is `NULL` for an absent key, and `NOT (NULL = 'x')`
is `NULL`. Today's tests pin it (`compilePredicate.harness.postgres.test.ts`: `not(alice)` → `c, d`;
`neq` → `20, 40`; `eq(name, '')` → `blank`); they are redesigned, since they assert the divergence.

**From step 3** the predicate compiler is two-valued, by polarity, so positive comparisons keep their
index use:

- `PredicateCompileContext.polarity: "positive" | "negative"` flips under `not` (and is restored inside
  `exists` / `missing`, whose `where` selects rows positively). An atom (comparison, `match`,
  `multi-select-contains`, `within-distance`, `matches` of a lookup row) compiles bare in positive
  polarity, where `NULL` and false both exclude the row, and `coalesce(<atom>, false)` in negative
  polarity.
- `!=` compiles as `not` of the `=` atom, so it is two-valued by the same rule; `in` and `between`
  compose atoms.
- A comparison of a property with the literal `''` compiles as the absence check (`= ''` as `is-blank`,
  `!= ''` as its negation), whatever the property's type: on a device both sides unpack to strings and
  compare as `''`.
- An equality with a bound runtime comparand compiles as "blank comparand: the absence check;
  otherwise the typed comparison", which is the device's `'' = ''` and HQ's `case_property_missing`
  (the CSQL path has folded its comparands, part 06 §4).
- `exists`, `missing`, `is-blank`, `match-all`, `match-none` are already two-valued; `if` in a predicate
  is `CASE WHEN`, its branches compiled in the enclosing polarity.

This is the general rule: part 06's `closed_on`, `neq` and `value-list` rules are cases of it and
cite it (part 06 decision 17). It changes Preview for existing apps where a negated or `!=` condition
meets a case that lacks the property: Results, counts and operation conditions keep that case, as the
device and HQ do.

**Implementation correction, 2026-10-19:** there is no `polarity` field. The compiler maps unknown
to false at each negation point, `NOT coalesce(<clause>, false)`: under `not`, under
`missing(self, where)`, and for `neq`, which is the negation of the `=` atom at the leaf, after
relation normalization (rewriting first would turn `exists(R, p != x)` into
`not(exists(R, p = x))` and flip the empty relation); a condition read in value position is
`coalesce(<condition>, false)`. A literal null comparand is the blank comparand `''`, as the wire
and CSQL both print it. A positive atom stays bare, and `and`, `or` and `CASE` are monotone,
so mapping at the leaves equals mapping the whole. `= ''` and `!= ''` are the absence check; a bound
comparand that is blank is decided in JavaScript (`compileTerm.ts::boundComparandValue`), so the
positive comparison keeps its index; two operands read per row that both read as device text are
equal when both are blank, as `'' = ''` is on a device; an ordering against a decided blank is false;
and `is-blank` is `coalesce(text, '') = ''`, so a JSON `null` reads blank.

**Production.** In the slots Postgres compiles, production holds some record atoms, in a few live
apps, that answer differently for a case that lacks the property: in case-list filters, calculated
columns and case operation write conditions, shaped `p != 'x'`, `not(p = 'x')`, `not(in(p, …))` and
`p = ''`. Every one reads a property of the row itself, through no relation, and every case row of
the case types and properties they read holds the property, none of them blank. So no Preview list,
count or operation changes today; the dry run counts again at the window.

### 5.6 Day numbers

`lib/case-store/sql/coreDayNumber.ts` (new) compiles, for the `casedb` and `results` readings, Core's
formula in the viewer's zone `z` (bound, validated by `resolveViewerTimeZone`):

- `date-coerce(n)`: `timezone(z, E + n * interval '24 hours' + interval '12 hours')::date`, with
  `E = timezone(z, timestamp '1970-01-01 00:00:00')` (Core's `dateAdd(getDate(1970, 1, 1), n)`: fixed
  days, half-day rounding, local rounding);
- a date read as a number, where a profile admits it: `floor(extract(epoch from (timezone(z, d::timestamp) - E + interval '12 hours')) / 86400)`.

The `search` reading compiles HQ's calendar arithmetic (`date '1970-01-01' + n`, part 06 §3.5, which
states the same Postgres form). In 413 of 418 zones the two agree; in the five of §2.3 the device's
list and HQ's search disagree by a day, and Preview shows each one as its runtime does.

**Implementation correction, 2026-10-19:** `coreDayNumber.ts::compileCoreDayNumber` truncates `n`
toward zero first, as Core's `toInt` does, and casts it to `integer`, which refuses a day outside
the `int` range as Core does; the `search` arm is `date '1970-01-01' + trunc(n)::integer`. No
formula for a date read as a number is compiled, because no slot with a Postgres target reaches one.

### 5.7 Sort keys

`caseDataBindingHelpers.ts::buildCaseStoreSortKeys` builds `Expression`s from
`lib/domain/caseListOrder.ts::caseListOrderPlan` exactly as today, with each key's `reading` from §5.2;
`lib/case-store/store.ts::SortKey` keeps its three kinds (`expression`, `interval-text`,
`mapping-position`), and `compileIntervalText.ts` and `store.ts::compileMappingPosition` are unchanged.
The comparator rules (`lib/case-store/sql/CLAUDE.md`, "Case-list sort keys") are unchanged.
`lib/commcare/suite/case-list/orderPlanOptions.ts::caseListOrderOptions` stays the one source of a
calculated column's type and printed text. From pull request 4 that text, the HQ `field` and the
sort element's join text, is printed by `orderPlanOptions.ts::hqExpressionFieldText` through `toWire`
in `hq-json` mode (part 04 §2.6), so a calculated column's `field` and its sort element take the
same canonical text; whether it moves any app's bytes at the cutover is part 04's census (§5).

### 5.8 `here()` and the location parameter

`TermBindings.viewerLocation` (§3.4) is bound as one text parameter wherever a compiled column holds
`here`; it is never interpolated (`lib/case-store/CLAUDE.md`). A column that holds `here` makes the
Results read's request identity include the position, so the cached read follows it.

**Implementation correction, 2026-10-19:** `TermBindings.here` is renamed `viewerLocation?: string |
null`; null or absent compiles to `''`, bound as text. The Results read does not key on the
position itself: it keys on the position state's move counter (`lib/session/viewerPosition.ts`,
`moves`), which advances on the first position, on each move of more than 30 metres from the
position last shown, and on a refusal that takes a shown position away, and the read sends the
latest fix and records it as shown.

### 5.9 The evaluator contract

`lib/case-store/CLAUDE.md` says the AST compiler "is the only evaluator… no in-memory variant, no
parallel JS evaluator". From step 3 it says, precisely:

- **Rows.** Which case rows a list, a count, a page, a group, a search result set, an operation target
  or a results instance holds is decided only by `lib/case-store/sql` in Postgres. No JavaScript code
  filters, sorts, counts or pages rows of the store.
- **The device snapshot.** `CaseStore.readDeviceCaseDatabase` is the store's one read of what a
  worker's device holds (the restore closure, seeded also by the worker's claims, §3.5). Preview's
  XPath evaluator evaluates XPath over that snapshot, and over the other instances of §3, exactly as
  Core evaluates over its casedb: form logic, case-backed choice itemsets, `#<type>/` and `#user/`
  reads, display conditions, CSQL runtime segments and obligations. It never decides which rows a list
  shows.
- **No substitution.** A list's rows never come from the snapshot, and a form's casedb read never
  queries Postgres.
- **Agreement** is held where one expression reaches both: §5.4 for datetimes, §5.5's absent and blank
  rows for every atom, and part 06 §8's `csqlComposition.postgres.test.ts` for CSQL.

---

## 6. Tests

| Test | Boundary | Failure it distinguishes |
|---|---|---|
| `lib/preview/xpath/__tests__/coreDateParity.test.ts` + `proof/native/core/CoreDateParityRuntimeTest.java` | pure evaluator per zone; Core in four zoned JVMs of part 08's `expression` family over the same fixture | a Preview date path off Core in one zone (§2.4) |
| `lib/preview/xpath/__tests__/instantLowering.test.ts` | pure: the `preview` print of part 04's lowering evaluated per zone over part 08's operand table | the lowering behaving differently in Preview than on Core |
| `lib/preview/xpath/__tests__/evaluator.test.ts` (extended) | pure | the parse cache returning a tree for different text (keyed on the exact source) |
| `lib/preview/engine/__tests__/formEngine.test.ts` (extended) | the production `FormEngine`, no React | held instants by provenance (a widget answer in the repeated hour, a preloaded `Z` text a day late as Core holds it); a relative read re-running its calculate when its target changes; session data, itext, choice-name, locations, selected cases and results read by form logic; a `cases` query used as one value throwing on two rows; each refusal of §4 with its details |
| `lib/preview/engine/__tests__/answerCast.test.ts` (new) | pure: every bind type's cast against a table of Java outcomes (the same table `CoreDateParityRuntimeTest` checks for the temporal arms, `javaDouble.ts`'s differential suite for decimals) | a value Preview casts that Core refuses, or the reverse |
| `lib/preview/engine/__tests__/triggerDag.test.ts` (new) | pure over `buildDoc` fixtures | a relative or `current()` read with no edge; a cycle through a relative read not reported |
| `lib/preview/engine/__tests__/xpathInstances.test.ts` (extended) | pure | the selected-cases instance off Core's shape (the results instance is part 05's `searchResultsXPathInstance.test.ts`) |
| `lib/preview/xpath/__tests__/workerRuntime.test.ts` (extended) | the real worker runtime in process | a protocol 7 message accepted by an 8 runtime; a world without hashtag values evaluating a case read |
| `lib/case-store/sql/__tests__/instantOrdering.postgres.test.ts` (new) | real Postgres, four viewer and session zones | §5.4 |
| `lib/case-store/sql/__tests__/compilePredicate.harness.postgres.test.ts` (redesigned blocks) | real Postgres | absent and blank rows kept under every negated atom, `!=`, `= ''`, runtime blank comparands; a positive comparison still using its expression index (`EXPLAIN` over the compiled AST, as the existing index-plan checks do) |
| `lib/case-store/sql/__tests__/readings.postgres.test.ts` (new) | real Postgres | each reading's system dates, `closed_on` refused outside `search`, a casedb `date_opened` against an instant at the viewer's midnight |
| `lib/case-store/sql/__tests__/coreDayNumber.postgres.test.ts` (new) | real Postgres, `Pacific/Kiritimati` and `America/New_York` | `date(20453)` and a date's number by reading |
| `lib/case-store/sql/__tests__/compileExpression.harness.postgres.test.ts` (extended) | real Postgres | `div` against `quotient`, `negate`, `here` bound and null, `case-row-type`, the worker-record read; from pull request 10, a browse list's filter reading a chosen case's id and property (the bound id and the correlated read), and an id of another app's or Project's case reading no row |
| `lib/preview/engine/__tests__/viewerLocation.test.ts` (new) | pure | Android's refresh rule off by a step: a first position not re-reading the list, a move of 29 metres re-reading it or one of 31 metres not, a fix of 1,600 metres accuracy not stopping the watch or one of 1,601 metres stopping it |
| `lib/case-store/sql/__tests__/restoreScopeClaims.postgres.test.ts` (new) | real Postgres through `compileRestoreScope.ts`, over graphs of HQ's `case_relationship_tests.json` (the existing oracle) with a claim added | a claimed case outside the worker's ownership entering the scope without what an owned extension of it brings (its parents, its open extensions), or a claimed id of another app or Project entering at all |
| `lib/preview/engine/__tests__/searchPopulation.postgres.test.ts` (new) | real Postgres through `loadCasesAction`'s helper (`readCases`) | a search's Results bound to the restore (a Project case another worker owns missing), or a browse list read without it (the case present) |
| `lib/session/__tests__/previewClaims.test.ts` (new) | pure, the production session store | claims lost on Home, or kept across a change of worker, Project or app |
| `lib/preview/app-tests/__tests__/journey.postgres.test.ts` (extended) | real Postgres through the production journey service, two retained sessions | a session's search finding only its restore; a chosen case another worker owns failing to open its form with its case data; a session's claim reaching the other session; a claim surviving finish; a search-first module's claim posting before its form is chosen, so its form menu's display condition reads a property of a case the worker does not own (a search action's claim posting at the result, beside it) |
| part 05 §5's `searchResultsXPathInstance.test.ts` and `searchResultsSnapshot.postgres.test.ts` | pure; real Postgres | §3.2 |
| `e2e/tests/app/preview-form-refused.spec.ts` (new Playwright smoke) | the production build, seeded no-LLM fixture | the preload refusal screen and its route back |
| `e2e/tests/app/preview-here-column.spec.ts` (new Playwright smoke, location granted and denied through the browser context) | the production build | the location note, and a distance column filled after a grant; a move of a few metres leaving the list as it is and one past 30 metres re-reading it, at an accuracy coarser than 1,600 metres so the watch keeps running (`setGeolocation` on the context) |
| `e2e/tests/app/preview-search-claim.spec.ts` (new Playwright smoke) | the production build, seeded fixture with a case another persona owns | a searched case the persona does not own failing to open its form with its case data |

**Implementation correction, 2026-10-19: the tests pull request 9 adds for §3.2 and the lookup wait.**

| Test | Boundary | Failure it distinguishes |
|---|---|---|
| `lib/preview/engine/__tests__/engineControllerLookupWait.test.ts` (new) | the production `EngineController` over a doc store, both runtime paths | a waiting same-entry rebuild resuming as a fresh entry (a new key, the answers gone), or opening the form again while it waits resuming the old entry |
| `lib/case-store/__tests__/appTestNamespace.postgres.test.ts` (extended) | real Postgres through `withAppTestNamespace` | a namespace's direct-index read opening its own transaction, reading another namespace's rows, or reading the live tables |
| `e2e/tests/app/preview-search-results.spec.ts` (new Playwright smoke, `@seed:search-results`) | the production build, seeded fixture with one searchable case the member owns | a form reading search results failing to open after a search, or opening without one after a reloaded record link instead of offering **Go to Search** |

The cap line is proved at the read (`searchResultsSnapshot.postgres.test.ts`, which seeds 503
matches): seeding past the cap through the browser smoke costs more than the gate should, and the
line's condition is `totalMatches > rows.length` over that snapshot.

Existing suites removed with their code: `lib/preview/xpath/__tests__/formRootRead.test.ts`, the
`extractPathRefs` and `countDependencies` cases, and the fold and binding cases of
`lookupEvaluation.test.ts`, `searchExpressionEvaluation.test.ts` and `displayConditionEvaluation.test.ts`
(re-expressed through the printed Preview target where the behaviour stays).

---

## 7. Files

New: `lib/preview/engine/formLogicSource.ts`, `answerCast.ts`, `formText.ts`, `viewerLocation.ts`;
`components/preview/form/fields/geopoint/geolocation.ts::watchGeolocation`;
`lib/preview/xpath/coreDays.ts`, `javaDouble.ts`; `lib/domain/expression/walk.ts::fieldReads`,
`::readsDeviceCases`; `lib/domain/temporalValues.ts::instantDatetimeValue`;
`lib/case-store/sql/coreDayNumber.ts`; the `previewClaims` slice of `lib/session`;
`proof/native/core/CoreDateParityRuntimeTest.java`; the tests of §6. Part 05's
`lib/preview/engine/entrySessionData.ts` and `lib/domain/entryCaseIdentity.ts`, with
`lib/case-store/postgres/store.ts`'s minted ids, land here in pull request 7 (§8); part 05's
`lib/preview/engine/searchResultsSnapshot.ts` and `loadSearchResultsSnapshotAction` (§3.2) land in pull
request 9, with the sites that load and read the snapshot: `engineController.ts` (`activateForm`),
`evaluateForm.ts`, `formLinkEvaluation.ts`, `postSubmissionEvaluation.ts`, the App Tests' `run.ts`, and
`components/preview/screens/FormScreen.tsx` (the refusal panel with **Go to Search** and the cap line);
`SEARCH_RESULTS_CAP` sits in `lib/commcare/session.ts`. In pull request 7 the callers of
`sourceSessionDatums`, which `entrySessionData` replaces, read the entry's map instead:
`components/preview/screens/FormScreen.tsx` and `lib/preview/engine/postSubmissionEvaluation.ts`, with
the tests `formLinkEvaluation.test.ts` and `lib/agent/tools/__tests__/navigationRead.test.ts`.

Rewritten: `lib/preview/engine/formEngine.ts`, `triggerDag.ts`, `xpathInstances.ts`,
`engineController.ts`, `formLinkEvaluation.ts`, `displayConditionEvaluation.ts`,
`searchExpressionEvaluation.ts`, `lookupEvaluation.ts`, `searchInputConstraints.ts`,
`searchInputValidation.ts`, `runtimeBindings.ts`, `dataInstance.ts`, `useCaseDatabaseSnapshot.tsx`,
`caseDataBindingHelpers.ts`, `caseDataBinding.ts`, `evaluateForm.ts`; `lib/preview/columnDisplay.ts` (the
reading, §5.2); `lib/session/` (claims per Preview worker, §3.5); `lib/preview/app-tests/types.ts`
(`AppTestSessionState.claimedCaseIds`), `context.ts` (the session's claims in its `restoreScope`),
`records.ts` (the `search` reading's population) and `run.ts` (a claimed result appended to the
session's claims at the point CommCare posts the claim, its `deviceCases` re-read);
`components/preview/screens/CaseListScreen.tsx` and `FormScreen.tsx` (the two points Preview posts a
claim, §3.5);
`lib/preview/xpath/types.ts`, `coerce.ts`, `functions.ts`, `evaluator.ts`, `workerProtocol.ts`,
`workerProjection.ts`; `lib/case-store/sql/compilePredicate.ts`, `compileExpression.ts`,
`compileTerm.ts`, `compileLiteral.ts`, `compileRestoreScope.ts` (claims), `dataTypeTokens.ts`,
`index.ts`; `lib/case-store/store.ts` (`SortKey.reading`, `QueryArgs.restoreScope` claims),
`postgres/store.ts`, `postgres/submissionEnvelope.ts`; `proof/native/families.py` (the zoned class).
From pull request 10, for the chosen case (§3, §5.1): `lib/case-store/sql/compileTerm.ts` and
`compileExpression.ts` (the bound id and the correlated read), `TermBindings.chosenCaseIds`,
`caseDataBinding.ts` and `caseDataBindingHelpers.ts` (`chosenCaseIds` from the menu case map) and
`displayConditionEvaluation.ts` (`session/data` from the menu case map).

Deleted: `lib/preview/xpath/dependencies.ts`, `countDependencies.ts`, the retired functions of §1.6.

`CLAUDE.md` files rewritten in the pull request that changes each: `lib/preview/CLAUDE.md` ("Lookup
carriers" becomes the one printing path for every surface; "First-class date type" gains §2; the
casedb load signal; the worker world without hashtag values; a search's population and the claims of
§3.5 beside "The running app reads what the worker's device would hold"), `lib/case-store/CLAUDE.md`
(§5.9's contract; the restore scope's claim seeds; `readDeviceCaseDatabase`'s caller-supplied list
sentence, replaced by the text §3.5 quotes, which is part 10's row), `lib/case-store/sql/CLAUDE.md` ("Portable case-list column
reads" becomes "Readings"; two-valued predicates; the naive pin on property reads),
`lib/preview/app-tests/CLAUDE.md` (a journey's search reads HQ's population; each retained session
holds its own claims in the persisted journey state, seeding its restore scope, and they clear when
the journey finishes; the `RUNTIME_VERSION` sentence itself moves in pull request 13 with the
version), `lib/session/CLAUDE.md` (the Preview claims
slice), `lib/commcare/CLAUDE.md` ("Search and claim": Preview now plays the claim's restore, §3.5);
each in pull request 7. Public docs, each row in the pull request whose behaviour it describes (part
10, "Public docs that change"), all of this part's in pull request 7: `building-with-nova.mdx` ("Try
the app in Preview": the refusal of §4), `case-workspace.mdx` (the `here()` paragraph of §3.4 and the
search paragraph of §3.5) and `mcp/tools.mdx` (`here()` in a calculated case-list column). The
session-values row of `building-with-nova.mdx` ("Preview supplies them as a device does") describes
the session map, which lands here, so it belongs in pull request 7 as well; its sentence on the
formula editor's list rides pull request 9 with the completion source (part 10).

## 8. How this part lands in the stack

This part lands in pull requests 5, 7 and 9, with one test in 8 and three pieces in 10.

**Pull request 5, the shape: dispatch over `Expression`** (§5.1). The dispatch lands with the union's
record arms, so no pull request compiles a stored tree the compiler cannot read. It compiles each arm
pull request 5's profiles admit by its row of §5.1, keeping today's rule wherever pull request 7
changes one: `portableCaseDates`, three-valued atoms, the bare `::timestamptz` property read. `here`
compiles as the bound `viewerLocation` with no position supplied, `''`, which is what both runtimes
give before a fix (§3.4). The arms part 06 admits (`closed_on`, numeric coercions, runtime distance
and unit, `value-list`, clause-valued `if` and `switch`; part 06 §3.1, §3.5 to §3.10, §6) stay
invariants until pull request 10 admits them and gives their rows of §5.1. The reads part 05 admits
(`cases`, `table-rows`, `locations`, `selected-cases`) reach a Postgres slot only inside a CSQL runtime
segment and stay invariants in step 3, but for the chosen case's `project`, which compiles from pull
request 10 (§5.1).

**Pull request 5 also owns the structural dependency adaptation** (§1.4). Its removal of
`XPathExpression`, `expressionSource`, `expressionInspectionSource` and the old predicate walkers
removes `triggerDag.ts`'s inputs, so its form reads come directly from the canonical tree through
`wire/formReads.ts` and the form-node projection. The corresponding `dependencies.ts` and
`countDependencies.ts` text walkers leave here. This is the dependency-forced ownership change;
the Preview target, protocol, date semantics and new runtime supplies still land in pull request 7.

**Pull request 5 also owns finite numeric select-answer conversion.** With static-choice default
admission, `formEngine.ts::computedFieldValue` converts a finite numeric result for a single- or
multi-select through the shared `lib/domain/expression/numberLiteral.ts::numericAnswerText`, so
Preview stores the same answer text that admission checks. The full bind-type and `SetValueAction`
cast infrastructure of §4 remains in pull request 7.

**Pull request 7, Preview**, above pull request 4, the wire tree, and pull request 5, the shape, and
below pull request 8, the lowering:

1. **Preview dates** (§2) and the parse cache (§1.2). They need no union and change no wire byte.
   They sit below the lowering because the lowering relies on Preview's dates matching Core
   (decision 3). `CoreDateParityRuntimeTest` rides this pull request as a zoned class of the
   `expression` family (`ZONED_CLASSES["CoreDateParityRuntimeTest"] = DEVICE_ZONES`, part 08 §2.1);
   the zone mechanism and `InstantOrderingRuntimeTest` land in pull request 1, the lane mechanics.
2. **Setvalue casts and refusals** (§4, finding 73 in Preview). No union needed.
3. **Postgres readings, two-valued predicates, the naive pin, Core day numbers, a search's population
   and the claim** (§5.2, §5.3, §5.5, §5.6, §3.5, with the App Test journey's claims), now over the union through pull request 5's dispatch. They replace pull request 5's
   carried-over rules in every arm pull request 5 admits. Part 06 cites §5.5 (its decision 17) from
   pull request 10, and part 05's snapshot reads §3.5's population from pull request 9, both above.
   `instantOrdering.postgres.test.ts` (§5.4) lands here: it reads
   `lib/commcare/__tests__/instantOrderingTable.ts`, which pull request 1 adds.
4. **The Preview target and protocol 8** (§1): every slot printed through
   `toWire(…, { target: "preview" })`, which needs pull request 4's wire tree and pull request 5's form
   logic through `toWire`; worker protocol 8 (§1.5); the retirements
   of §1.6 except the structural dependency walkers already removed in pull request 5 and the CSQL path's;
   and the supplies of the reads pull request 5 makes printable: the
   device snapshot behind `form-case` and `#user/` reads (`cases` queries in form logic print from pull
   request 9), today's lookup and Search answer instances, `search-input:results` for the Search
   screen, `here()`'s browser position with Android's refresh rule (§3.4), and part 05 §1.8's session
   map (below). The target sits
   below the lowering, so pull request 8's lowering reaches Preview through the same `toWire` with no
   Preview change.

Three pieces cannot land in pull request 7, and one piece of part 05 must:

- **The supplies of the reads pull request 9 makes printable ride pull request 9, instances and
  session.** Part 04 §8.5's `toWire` rows and their declarations, and part 05's profile admissions,
  land there (part 03 §10, item 2: their gate cases join in pull request 9, where profiles admit the
  reads). Before them no stored tree holds a read of `locations`, `selected-cases`, `itext`,
  `choice-name`, a lookup table in form logic or `item-list:<tag>` in a form-link slot, so a supply
  landed in pull request 7 would have no reader to prove it. They are §3.1's selected-cases instance,
  §3.3's form text table, part 05 §2.4's locations instance, part 05 §2.3's widened coverage
  predicates and fixture aliases, and §3.2's snapshot, each with its `formEngine.test.ts` and
  `xpathInstances.test.ts` cases (§6). Protocol 8's `formText` member joins with §3.3 there without a
  second protocol bump: the stack deploys once, so no deployed host or worker speaks the version
  without it.
- **The CSQL path's half of the Search answer binders rides pull request 10, CSQL.** In pull request
  7 the device surfaces read the Search answers as instances, so
  `bindSearchInputValuesInExpression` and `…InPredicate` lose those callers; the CSQL path still
  binds through them until part 06 §4's fold replaces them in pull request 10, which deletes them.
  `searchInputValidation.ts`'s rewrite (§1.3) is part 06 §4's step 1 and rides pull request 10 with
  it.
- **The chosen case rides pull request 10, CSQL**, where record slots admit it (part 06 §3.9, part
  01 §4): its Preview supply (§3's row), the `session-datum` and `project` rows of §5.1 with
  `chosenCaseIds`, the navigation context's `session/data` for a form display condition, and their
  `compileExpression.harness.postgres.test.ts` cases. The session the fold reads for it is part 05
  §1.8's map for the module's case list step, which lands in pull request 7, so nothing in pull
  request 10 builds a second session.
- **Part 05 §1.8's session map (`entrySessionData`) lands in pull request 7, not 9.** The Preview
  target prints `#<type>/<prop>` as the wire's casedb walk keyed on
  `instance('commcaresession')/session/data/<datum>` (§1.2), and a registration form's own
  `case_id` as `session/data/case_id_new_<type>_0`; today Preview has no `session/data` (part 05
  §1.8), so without the map every case read of a follow-up form would read blank from pull request
  7. The map needs only `entryDatumIds` (pull request 5, the shape: the ids, over `entryDatumSupplies`'s refs), today's menu case
  map, and the new `entryCaseIdentity.ts`; the submission's minted ids and the after-submit map ride
  with it. Session datum identity itself (`DatumRef`, `entryDatumSupplies`, the datum parse refusals,
  `SESSION_DATUM_NOT_SUPPLIED`) lands in pull request 5, where the production session reads lift.

**Pull request 9, instances and session**: §3.2's snapshot, the supplies above, and the day rule over
a results row's `date_opened` (part 04 §8.5, §5.2), which the `results` reading already compiles as
the UTC day from pull request 7.

**Elsewhere.** `lib/preview/xpath/__tests__/instantLowering.test.ts` (§5.4) evaluates the `preview`
print of part 04's lowering, so it lands in pull request 8 with the lowering. The `CLAUDE.md` and
public-docs changes of §7 ride the pull request that changes each behaviour (pull request 7 for
every row of this part's); this plan's own pull request writes §3.5's durable-claim deferral into
step 5's outline.

No pull request of this part changes a served tool schema or model-facing prose, so none moves
`lib/models.ts::MODEL_CONTEXT_VERSION`, and none adds an `/api` route (the Server Actions are not
routes).

---

## What changes for a person using Preview

Each is a decision above; together they are what the public docs rows of §7 describe.

- **Preview stops rewriting expressions before printing them** (§1.3). The lookup fold and the
  Search answer substitution retire; every surface reads instances shaped like the device's. Reason:
  one emitter with one evaluation world, and lowerings shared.
- **Postgres predicates are two-valued** (§5.5), changing Preview's Results, counts and operation
  conditions for apps whose negated or `!=` conditions meet cases lacking the property. Reason: both
  CommCare readers keep those cases. Production meets none today.
- **Preview mirrors Core's day numbers in five Pacific zones** (§2.3, §5.6), rather than the
  calendar, because Preview plays the device.
- **Preview refuses forms it opens today** (§4), where Core refuses them.
- **`portableCaseDates` becomes a three-valued reading** (§5.2): a browse list's filter and case
  operations read `date_opened` / `last_modified` as the worker's day, and a search's columns read
  HQ's text spellings. Each changes a Preview result near midnight; production reads neither in those
  slots.
- **Datetime property reads pin naive text to UTC** (§5.3); no stored row changes today.
- **A search in Preview finds cases the worker does not hold** (§3.5), where today it finds only the
  restore's. Reason: HQ's search reads the project space, and the claim makes the chosen case the
  worker's.
- **Preview's claims are not stored** (§3.5). HQ's claim is a durable `commcare-case-claim` case;
  Preview's lasts while the worker, the Project and the page stay, and an App Test journey's lasts
  while the journey runs. Reason: a claim row would be a case type no author declared, shown by every
  tenant-wide surface, and the case store holds the app's own case types.

## Production and the cutover's dry run

**What production holds** (the production reads under "Executed during planning", over live apps): a
few apps hold relative reads that can close a dependency loop (`..` and `current()/…` field reads,
§1.4); no case row fails a typed preload's cast (§4.2); some two-valued atoms in a few apps, and no
case row lacking their property (§5.5); no system-date read in a slot the readings change (§5.2); no
stored naive datetime value (§5.3); no datetime equality in a CSQL slot (§5.3); search-first modules
and Search actions over open case rows in a few apps (§3.5).

None of this part's changes writes to a document or changes a published byte, so this part adds no
notice reason: what changes is that Preview shows what the device and HQ already show, and the public
docs say so (§7). **What remains for the cutover's dry run**, each counted at the window over the
lifted documents and the case rows of that moment:

1. `CYCLE` findings (`lib/commcare/validator/runner.ts`, the `cycle` kind) over every lifted document,
   since relative reads become graph edges (§1.4): expected none or few, and each is a `target-gate`
   blocker the author resolves in the app before the window (part 09 §11), since the document would
   fail the gate.
2. Record atoms in the Postgres-compiled slots (`case_list_filter`, `case_list_column_expression`,
   `search_input_predicate` and the case-operation slots) that answer differently for a case lacking
   the property under their polarity, and the case rows of their case types that lack it or hold it
   blank: a non-zero row count is a Preview list that changes for that app, which the dry run reports.
3. Reads of `date_opened` / `last_modified` in a case-list filter, a calculated column, a Search
   predicate or a case operation, by reading (§5.2).
4. Case rows whose value fails Core's cast for a typed preload that reads it (§4.2): each is a form
   Preview refuses to open for that case, as the device already does.
5. Stored datetime property values without an offset (§5.3).

## Executed during planning

All runs from the repo root at `main` `5cf6e327`, tree clean before and after, no Docker, no paid
call. The local runs touch only the local dev Postgres; the production reads are read-only,
content-free (closed labels and counts only) and ran under the person's standing permission for
read-only production reads.

- **Core's day number against the calendar** (`node` v24): Core's `daysSinceEpoch` formula against the
  calendar day for every one of Node's 418 zones at three 2026 dates. Five zones differ, each by −1:
  `Pacific/Apia` (1970 offset −11, now +13), `Pacific/Enderbury` (−12, +13), `Pacific/Fakaofo` (−11,
  +13), `Pacific/Kiritimati` (−10:40, +14), `Pacific/Kwajalein` (−12, +12). Matches the parity run's
  Kiritimati rows `r3` and `r10`.
- **JavaScript's wall-clock resolution**: `setHours` in `America/New_York` resolves 01:15 and 01:45 on
  2026-11-01 to 05:15Z and 05:45Z (the earlier occurrence), 02:30 on 2026-03-08 to 07:30Z (forward by
  the gap). Against the parity run's Core cast probe, which holds 01:45 at 06:45Z (the later
  occurrence).
- **Parse cost** (`npx tsx --conditions=react-server`, `NODE_PATH` set to the repo's `node_modules`):
  a 3,881-character lowered comparison, 1,000 calls each: Lezer parse 0.30 ms, parse plus evaluate
  0.37 ms.
- **Missing values in Postgres** (same runner): Nova's `compilePredicate` over four `VALUES` rows
  (absent, blank, `x`, `y`) against the local dev Postgres (`NOVA_DB_LOCAL_URL`, PostgreSQL 18.3,
  session `TimeZone` UTC), in a `READ ONLY` transaction rolled back, no table read or written. Results
  in §5.5's table, with the compiled `WHERE` text for each.
- **The naive datetime read** (same runner and safeguards): a naive datetime property against a UTC
  literal matches under session `America/New_York` and not under `UTC`; the compiled read is a bare
  `cast(… as timestamptz)`.
- **The Preview–Core parity run**: a table of expressions over datetime answers and text (rows `r*`,
  `o2*`, `d*`, `n*`) evaluated by Core in four device-zone JVMs (`UTC`, `America/New_York`,
  `Asia/Kolkata`, `Pacific/Kiritimati`) and by Preview's evaluator under the same four zones, with a
  viewer-stamped and a `Z`-stamped answer column, plus a Core cast probe of setvalue text in
  `America/New_York`. This part relies on its `o2` rows (§2.1), its DST rows `d5`, `d7`, `d8` and the
  cast probe (§2.2), its Kiritimati rows (§2.3), and its timing (0.65 ms per typed-against-text
  comparison, §1.2). Text operands agree in every zone; typed operands agree except inside a repeated
  DST hour.
- **The production shape scan**, run twice on 2026-10-17 as the operator's gcloud identity
  (`scripts/lib/prodDb.ts::targetProdDb`) in one `REPEATABLE READ, READ ONLY` transaction each. This
  part relies on its relative-read classes (§1.4), its finding 73 rows (no failing case row; typed
  preloads from declared and undeclared properties, §4.2), its `app_changes` suffix, its CSQL rows
  (no `eq` / `neq` / `in` on a datetime property), its record `div` (none), its literals opposite a
  static select, and its slot census, which named the slots the probe below walks.
- **A production probe of this part's readings and predicates**, run on 2026-10-17 in the same
  transaction form, over every live app, none unreadable and none failed; documents read through
  `lib/db/canonicalCommitKernel.ts::loadSchemaAdmittedAppSnapshotFromRowInTransaction`, record slots
  through `lib/domain::MODULE_REFERENCE_SLOTS`, `FORM_REFERENCE_SLOTS` and `readSlotValues` (the
  Postgres-compiled slots: `case_list_filter`, `case_list_column_expression`, `search_input_predicate`
  and the case-operation slots), each atom classified by the device's value for a case lacking the
  property under its polarity. Observed: some atoms that answer differently, in a few apps (§5.5's
  breakdown), none of whose case rows lacks the property or holds it blank; no system-date read in a
  slot the readings change; no stored datetime value without an offset; search-first modules and
  Search actions as §3.5 states; live case rows in a few apps, all open. A first run against the local
  Postgres stopped at its unmigrated `apps.app_settings` column and read nothing.

Read at Nova `5cf6e327`: `lib/preview/xpath/runtimeValues.ts::unpackXPathRuntimeValue`,
`XPathNodesetCardinalityError`; `lib/preview/engine/caseDataBinding.ts` (`loadCasesAction`,
`loadCaseDataAction`'s `deviceScoped`, `loadCaseDatabaseSnapshotAction`); `lib/case-store/CLAUDE.md`
("Restore scope"); `lib/commcare/CLAUDE.md` ("Search and claim", "Search-first inline shape");
`lib/preview/entryPointLaunch.ts` (its no-claim refusal); `lib/domain/referenceSlots.ts` (the slot
names); `lib/preview/engine/formEngine.ts::createEvalContext` (it resolves `#<type>/<prop>` from
per-type case data and builds no `session/data`, the dependency of §8); `lib/commcare/xform/datetimeCaseValue.ts`
and `lib/domain/fieldValueType.ts`; neither `entryDatumSupplies` nor `entryDatumIds` exists in `lib` (the shape adds both); the
absence of any catalog `required` / `validation` reader in `lib/preview` and `lib/case-store`; and,
for where App Test journeys run, `lib/preview/app-tests/CLAUDE.md`, `service.ts`, `run.ts` (the `sync`
action's `readDeviceCaseDatabase`), `context.ts::contextFor` (the per-session `restoreScope`),
`records.ts::appTestRecords` (its `readCases` with `restoreScope`), `types.ts` (`AppTestState`,
`AppTestSessionState`), `lib/db/appTests.ts` (`RUNTIME_VERSION` 15, the `app_test_sessions.state`
JSONB, `state: "{}"` on disposal) and `lib/agent/authoring/evaluationContext.ts` (the authoring
evaluator's restore-scoped read); `lib/case-store/sql/compilePredicate.ts` (its `matches-pattern` arm's
plain `Error`), `lib/domain/predicate/errors.ts::compilerBugMessage`; `lib/preview/columnDisplay.ts`
(`formatDateForPreview`, `formatIntervalForPreview`, the callers of `coerce.ts::toDate`);
`lib/commcare/xform/formPath.ts::FormPath.queryBoundIteration`;
`components/preview/form/fields/geopoint/geolocation.ts` (`requestGeolocation`,
`GeolocationFailureReason`), `lib/preview/runtimeMessages.ts` (the location copy) and
`lib/preview/xpath/javaRosaGeo.ts::javaRosaDistance`; `lib/preview/menuProjection.ts::previewMenuCaseContext`
and `lib/preview/engine/caseDataBinding.ts::loadCasesAction`'s arguments.

Read at the pins: Core `DateUtils.java` (`daysSinceEpoch`, `EPOCH_TIME`, `getDate`, `dateAdd`,
`fractionalDaysSinceEpoch`, `parseDateTime`, `parseDateAndStore`, `parseTimeAndStore`),
`FunctionUtils.java::toDate`, `::expandDateSafe`, `XPathDateFunc`, `XPathFormatDateFunc`,
`XPathFormatDateForCalendarFunc`, `SetValueAction.java::processAction`, `Recalculate.java::wrapData`,
`AnswerDataFactory.java::templateByDataType`, the `cast` of `DateData`, `DateTimeData`, `TimeData`,
`IntegerData`, `DecimalData`, `LongData`, `GeoPointData`, `SelectOneData`, `SelectMultiData`,
`StringData`, `GeoPointData::getDisplayText`, `FormDef.java::initEvalContext`, `::finalizeTriggerables`,
`XFormParser.java::recurseForOutput`, `::parseOutput`, `::parseTextHandle`,
`XPathNodeset.java::unpack`, `XPathPathExpr.java::unpackValue`, `XPathEqExpr.java::evalRaw`,
`HereFunctionHandler.java`, `CommCareInstanceInitializer.java::setupSelectedEntitiesInstance`,
`src/cli/java/org/commcare/util/screen/QueryScreen.java::init`; Formplayer
`util/FormplayerHereFunctionHandler.java`, `services/MenuSessionRunnerService.java` (its `here()`
handler), `session/MenuSession.java`; Android
`app/src/org/commcare/utils/AndroidHereFunctionHandler.java::eval`, `::toGeoPointData`,
`::REFRESH_METER_DELTA`, `::onLocationChanged`, `::shouldRefreshEntityList`,
`app/src/org/commcare/utils/GeoUtils.java::DEFAULT_ACCEPTABLE_ACCURACY`; HQ
`case_search/xpath_functions/comparison.py` (`property_comparison_query`, `_create_query`,
`case_property_range_query`), `case_search/xpath_functions/query_functions.py::not_`,
`es/case_search.py::case_property_query`, `::case_property_missing`, `::_base_property_query`,
`es/filters.py::NOT`, `case_search/const.py::CASE_SEARCH_MAX_RESULTS`,
`case_search/utils.py::CaseSearchQueryBuilder._get_initial_search_es`, `::_apply_sort`,
`::get_and_tag_related_cases`, `case_search/models.py::CLAIM_CASE_TYPE`, `ota/views.py::claim`,
`corehq/ex-submodules/casexml/apps/case/xml/generator.py` (`CaseDBXMLGenerator`,
`V2CaseXMLGenerator`, `datetime_to_xml_string`, `date_to_xml_string`, and the generators'
`date_opened` element, the day of `opened_on`),
`corehq/ex-submodules/dimagi/utils/parsing.py::json_format_datetime`, `::json_format_date`, and
`corehq/ex-submodules/casexml/apps/case/cleanup.py::claim_case`.
