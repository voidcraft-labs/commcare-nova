# Step 3, part 06: Typed CSQL composition

Part of [step 3's plan](../3-expressions.md), which holds the baseline, the decisions, the stack and
the exit. This part plans every CSQL construct the outline's item 2 and the inventory
(`docs/research/2026-09-26-hq-round-trip/inventory/case-search.md`, "CSQL in `_xpath_query` values and
ancestor-path criteria") name: for each, the arms of part 01 it uses, the checker rules, the CSQL
emission and its runtime obligations, the Postgres compilation that keeps Preview in agreement, the
card editor, the record dialect the SA and MCP write, and the proofs. It also decides which of them
the builder, the SA and MCP author in step 3 and which the model holds for import.

Citations are `path::symbol` for Nova at `main` `5cf6e327` and `file::symbol` for CommCare at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1` (paths relative to `corehq/apps` unless named),
commcare-core `8e9ba8d908e9` (paths under `src/main/java`), formplayer `24383ac71bfb`. Every HQ, Core
and Formplayer fact below was read at the pin. Pull requests are the stack's fifteen, by number and
name (the plan, "The stack"): this part is pull request 10, CSQL, and its builder cards ride it.

## Decisions in brief

1. **One position model decides every CSQL emission.** Each node of an expression in a CSQL slot
   holds one of five positions: `query`, `anchor`, `server-value`, `raw` or `runtime` (§2). The
   checker assigns them, the emitter is a function of (arm, position), and Preview's fold reads
   the same assignment. It replaces the two-valued `RuntimeValueDialect` of
   `lib/commcare/predicate/csqlRepresentability.ts::checkRuntimeValue` and the operand-position
   flags spread across `csqlEmitter.ts`.
2. **No on-device wrapper ever enters CSQL text; every runtime segment is on-device XPath and takes
   the on-device lowering.** A runtime segment is printed by the one on-device emitter (the wire
   XPath tree of part 04), so finding 56's per-operand lowering applies to every ordering Core
   evaluates inside the `_xpath_query` concat, and to none HQ evaluates.
3. **`closed_on` is readable only in slots no device evaluates.** It is a search-only system
   property (`datetime`), admitted where a slot's targets are HQ's search and Postgres alone (today
   only `searchInputs[advanced].predicate`). Neither Core's casedb nor HQ's search results carry it.
   It lives in a search-only standard table read by slot targets, not in the effective catalog.
4. **`@case_type` is authorable** as the `case-row-type` leaf compared with `case-type` leaves, in
   every record slot that reads a case row.
5. **Project-timezone day comparisons do not enter step 3** (decided with the person, 2026-10-17).
   Nova cannot learn a project space's timezone (no API-key route returns it), so no step-3 surface
   can author the construct truthfully and Preview cannot evaluate it as HQ does. `project-day` is
   not in step 3's union; step 6 decides it on import. Its manifest entry stays HELD-NEW, owned by
   step 6.
6. **CSQL `today()` is the worker's day everywhere** (decided with the person, 2026-10-17). The
   `today` arm in a CSQL position emits Core's `today()` as a runtime segment, so HQ never evaluates
   `today()` in its project timezone. The device list filter, the server search and Preview (the
   viewer's zone) read the same day. Search bytes change once at the next publish, and the step 3
   notice names each app the cutover finds with the document reason `search-today-is-workers-day`
   (§3.4).
7. **Epoch coercions are authorable.** `date-coerce` and `datetime-coerce` take numeric operands
   (days since 1970-01-01). In CSQL a `date` epoch must be whole: HQ refuses a float
   (`case_search/xpath_functions/value_functions.py::value_to_date`).
8. **`value-list` (HQ's `unwrap-list`) is held for import, and no step authors it.** It is
   representable, emitted, compiled to Postgres and proven natively, so step 6's import keeps an
   imported one; a fixed list is authored as `in`. An item may be a node-set, flattened into the
   list. A runtime list is one of HQ's escape hatches, which Nova does not reproduce (§3.6).
9. **Runtime values in raw arguments are evaluated on the device and concatenated as literals**
   with the quote cascade and the `'match-none()'` sentinel of step 2. Runtime `selected*` values are
   authorable in server-only slots, and on device-evaluated slots only when single-choice typed.
10. **All nine distance units, and runtime radius and unit, are authorable** wherever
    `within-distance` is.
11. **Session context, worker values and the chosen case are authorable in CSQL runtime segments
    and in the case list filter.** From pull request 10 a search or a case list may read the case
    chosen in a menu its entry passes through: its id (a `selected-case` datum) and its properties
    (a `project` over `casedb` keyed on that datum), spelled `chosen-case('<menu name>')` and
    `chosen-case-property('<menu name>', '<property>')` in the record dialect (part 02 §2.2) and
    offered as "The case chosen in <menu>" by the card editor. The entry-supply rule checks each
    read against the module's own case list step (§3.9). General casedb, lookup-row and location
    reads in CSQL values are held for import and authored by no step (union, emitter, fold,
    Postgres, native proof): they are HQ escape hatches, and Nova's own arms cover what a person
    builds (§3.9). `groups` is not in step 3's union (step 7, group 2).
12. **Runtime choice among clauses is authorable**: `if` and `switch` with clause branches, and any
    clause that reads no case row, in a query position. `when-input-present` stays its own arm.
13. **`_xpath_query` rows keep today's composition.** Nova-authored sources carry no row identity, so
    the split at top-level conjuncts stays; an imported row list, which needs its own slot, is step
    6's (manifest entry stays HELD-NEW).
14. **An ancestor case-id equality is written in HQ's flag-free spelling** (`parent/@case_id = v`)
    when the comparand provably names a case of the step's destination type, so a search that only
    narrows to a chosen parent needs no `CASE_SEARCH_RELATED_LOOKUPS`. Its common case, a search
    narrowed to the case chosen in an earlier menu (decision 11), lands with it in pull request 10
    (§3.12).
15. **Equality on a date and time is an instant range in CSQL** (§3.13, finding 75). Today `eq`,
    `neq` and `in` on a `datetime` anchor emit `p = '<v>'`, which HQ answers by text equality on a
    custom property and by an exact term on a system date: a value spelled any other way than HQ
    stores it finds nothing on HQ, while Preview's Postgres compares instants. From step 3 each emits
    the closed range `(p >= v and p <= v)` (negated for `neq`, an `or` of ranges for `in`), which HQ
    answers by instant on every datetime anchor and every spelling its parser reads. Refusing the
    comparison would remove an affordance the builder offers today, and normalising the literal
    cannot reach a runtime value or a native value function. A custom `datetime` anchor takes the
    range in both CSQL slots; `date_opened`, `last_modified` and `closed_on` take it only in
    `searchInputs[advanced].predicate`, because in a device-evaluated slot a system date compared for
    equality with a date and time is refused (the day rule, part 03 §3.2 and part 04 §3.4, reason
    `day-only-on-device`). The device half is the lowering's: `=`, `!=`, `in` and `switch` between two
    `datetime` operands lower to instant equality wherever orderings lower (part 04 §3.3).
    `datetime-literal-precision` (milliseconds) is new. The lane observes finding 75 as it observes
    finding 56: pull request 1, the lane mechanics, registers the two case-list entries the executed
    run shows (equality and inequality), and pull request 8, the lowering, moves them; with every
    reader it also shows HQ's search failing on the raw minute-precision term, which pull request 1
    holds in four entries and a walk stop and this part's range moves to the control (§3.13,
    "Register").
16. **CSQL text is a tree with one printer.** The emitter builds a `CsqlNode` tree and `printCsql` is
    the only place CSQL text is assembled; the `_xpath_query` wrapper is a `WireExpr` (part 04 §2.5).
17. **Postgres predicates are two-valued over a missing value** (part 07 §5.5). This part's
    `closed_on`, `neq` and `value-list` rules are cases of that one rule and cite it.
18. **Production meets nothing whose bytes this part changes.** No `_xpath_query` a live app sends
    reads `today` or `now`, none holds an equality on a `datetime` anchor, a `within-distance`, a
    `match` or a `multi-select-contains`; no CSQL slot holds an ancestor case-id equality; and no
    document holds a typed datetime literal (the production reads under "Executed during planning").
    The two notice reasons stay, because an app can gain either construct before the window; the
    cutover's dry run counts them again (§10).
19. **This part lands as pull request 10, CSQL**, above the shape (pull request 5), the checker (6),
    Preview (7), the lowering (8) and instances and session (9), each of which it needs: the union and
    profiles it types against, the checker's walk its findings join, part 07's Postgres readings and
    two-valued predicates (§4), the lowering every runtime segment takes (§2.2), and the instance
    reads its runtime segments hold. It carries the position model, the emitter and `printCsql`, this
    part's CSQL findings (`closed-on-not-on-device` with the search-only standard table,
    `case-type-ordering`, and the epoch, runtime-selected, raw-argument, `value-list` and distance
    findings of §10's walk 5), the chosen case in CSQL runtime segments and the case list filter
    (§3.9: positions, emission, the two supply carriers, the session the fold reads) with the flag-free ancestor
    spelling's common case (§3.12), the fold, the `csql` native family with its `datetime-equality`
    and `chosen-case` scenarios, `targeted-csql-composition`, the record-dialect parse and print
    widening (§7), the move of the files left in `lib/commcare/expression/` and
    `lib/commcare/predicate/` (§2.3), and its builder cards and pickers (`DateCoerceCard`,
    `MultiSelectContainsCard`, `WithinDistanceCard`, `ConditionChoiceCard`, the new
    `CaseTypeValuePicker`, and the picker rows of §3.1 and §3.9), so pull request 11, the builder,
    carries none of this part's cards, and it moves finding 75's four search entries and its walk
    stop to the control and removes `proof/checks/registers.py::OPEN_DEFECTS` value `75: 3` (an
    `OPEN_DEFECTS` value is the step that fixes a finding, whatever its entry count). Three pieces
    land elsewhere: finding 75's document, control, six live entries, walk stop and `75: 3` in pull
    request 1, the lane mechanics; the device half's two entries' move in pull request 8, the
    lowering; and the three type-checker findings this part relies on in every slot,
    `datetime-literal-precision`, `format-date-pattern-not-fixed` and `number-of-date`, which are part
    03 §3.10's and land in pull request 6, the checker (part 03 §10). §7's `reference.ts` sentences
    ride pull request 10 itself, with its `MODEL_CONTEXT_VERSION` bump to
    `"v4-hq-round-trip-expressions.10"`, as do this part's public docs rows (part 10, "Public docs that
    change": `case-workspace.mdx`'s `today()`, number-to-date and date-comparison rows,
    `mcp/tools.mdx`'s record-query paragraph). The notes this part names in step 6's outline
    (`6-import.md`: project-timezone days, §3.3; `value-list` and the other CSQL values Nova does
    not author, held for import, §3.6 and §3.9; an imported list of `_xpath_query` rows, §3.11) are
    written by this plan's own pull request.

---

## 1. CSQL in Nova today

**Slots.** Three slots reach CSQL (part 01 §4): `caseListConfig.filter` (device nodeset, HQ short
filter, and `_xpath_query` when Search is effective), `searchInputs[advanced].predicate` (CSQL and
Postgres only), and the clause each simple-arm input derives
(`lib/commcare/suite/case-search/simpleArmDerivation.ts::deriveSimpleArmPredicate`, gated by
`simpleArmNeedsXPathQueryEmission`). `caseSearchConfig.excludedOwnerIds` reaches HQ as a data value,
not CSQL.

**Pipeline.** `lib/commcare/suite/case-search/xpathQuery.ts::composeXPathQueryPredicate` AND-composes
the sources and simplifies them (`effectiveFilterForEmission`); `composeXPathQueryEmission` emits one
wrapper per top-level conjunct through `lib/commcare/predicate/csqlEmitter.ts::emitCsql`. The local
suite writes one `<data key="_xpath_query">` per wrapper (`searchSession.ts`), the HQ JSON one
`default_properties[]` row per wrapper (`lib/commcare/hqJson/caseList.ts::projectDefaultProperties`),
both from `xpathQueryRequestValues`. A wrapper is a bare XPath string literal when constant, the flat
quote cascade when its only runtime value is one string (`csqlEmitter.ts::buildQuoteCascade`), and
otherwise `if(<obligations>, 'match-none()', concat(...))` (`wrapClause`).

**Segments and obligations.** `lib/commcare/predicate/csqlSegment.ts::CsqlSegment` holds constant CSQL
text and runtime on-device XPath strings. A runtime segment may carry `rejectWhen` and a
`RuntimeCsqlRejectionKind` (`quote`, `whole-number`, `nonnegative-whole-number`, `geopoint`,
`blank-comparand`). Prompt validation reads them (`xpathQuery.ts::buildRuntimeCsqlPromptValidations`,
skipping `blank-comparand`), and so does Preview (`lib/preview/engine/searchInputValidation.ts::searchInputRuntimeQuoteErrors`,
`::searchFindsNothing`). Runtime values reach CSQL through `lib/commcare/predicate/termEmitter.ts::quoteRuntimeCsqlValue`
(delimiter chosen on device), `::quoteFreeRuntimeCsqlValue` (date-widget inputs) and
`lib/commcare/expression/csqlRuntimeExpression.ts::emitCsqlRuntimeExpression` (the on-device emitter
for non-native arms).

**Executed during planning**, what today's code does with the constructs this part covers (two
local scripts over today's emitter and checker, under "Executed during planning"):

| Construct | Today |
|---|---|
| `prop(case_id via parent) = <worker field>` | `ancestor-exists(parent, (@case_type = 'household' and (@case_id = "…")))` inside the quote cascade; records `ancestor-exists` (`collectRelatedCaseQueries`), so the search needs the related-lookups flag. The normalizer adds the inferred `@case_type` hop qualifier |
| `dob >= today()` | `'dob >= today()'`: HQ evaluates `today()` |
| an `and` filter of two clauses | two `_xpath_query` rows |
| a comparison reading no case row, as a clause | refused: `comparison-needs-case-property` |
| `closed_on`, `case_type` | refused by the type checker: `unknown-property` |
| `date-coerce` of a number | refused: `text-or-date-value` |
| `starts-with` with a `date-coerce` value | refused only because its type is not text (`typeChecker.ts::MATCH_PROPERTY_TYPES_BY_MODE`); nothing positional stops a native value function in a raw argument |
| `within-distance` | literal radius, `miles` or `kilometers` only (`lib/domain/predicate/distance.ts::DISTANCE_UNITS`) |
| `multi-select-contains` | literal values only, one `selected(p, 'v')` per value |

---

## 2. The position model

### 2.1 Positions

HQ's compiler reads a CSQL string in four ways, and the device adds a fifth:

| Position | What reads it | HQ at the pin | Nodes |
|---|---|---|---|
| `query` | HQ builds a filter from it | `case_search/filter_dsl.py::build_filter_from_ast` visits function calls of `XPATH_QUERY_FUNCTIONS`, `and`/`or`, comparisons, ancestor comparisons and `subcase-count` comparisons; anything else raises | the slot root; `and`/`or` clauses; `not.clause`; `exists`/`missing`/subcase `count` `where`; `when-input-present.clause`; a runtime choice's branches |
| `anchor` | the left side of a comparison | `xpath_functions/comparison.py::property_comparison_query` raises unless the left is a `Step`; `_is_subcase_count` admits `subcase-count(…)` on the left | `prop` (custom, standard, `closed_on`), `case-row-type`, subcase `count` |
| `server-value` | HQ evaluates it | `dsl_utils.py::unwrap_value` applies `XPATH_VALUE_FUNCTIONS` and refuses a `Step`; it runs on a comparison's right side, `fuzzy-match` and `fuzzy-date` argument 2 (`query_functions.py::fuzzy_match`, `::fuzzy_date`), and every argument of `date`, `datetime`, `double`, `date-add`, `datetime-add` (`value_functions.py`) | comparison right sides, `in` values, `between` bounds, `match.value` in `fuzzy` and `fuzzy-date`, value-function operands |
| `raw` | HQ reads the argument as written | `query_functions.py::_selected_query`, `::starts_with`, `::phonetic_match`, `::within_distance` take `node.args` unevaluated; `value_functions.py::unwrap_list` is `json.loads(node.args[0])` | `multi-select-contains` values, `match.value` in `starts-with` and `phonetic`, `within-distance` center, distance and unit, `value-list` items |
| `runtime` | Core evaluates it inside the concat, before HQ sees the text | the `<data ref>` of the remote request (`lib/commcare/suite/case-search/searchSession.ts`) | the maximal subtree below a `server-value` or `raw` position that is neither a literal nor (in `server-value` only) a native value function over server-known operands; a runtime choice's condition; a query-position clause that reads no case row |

A node's position comes from its parent's position and slot (the table's last column), top-down
from the slot root, which is `query`. In a slot that is not CSQL, no node has a position. A
`runtime` node's descendants are all `runtime`.

### 2.2 Emission by position

| Arm | `query` | `anchor` | `server-value` | `raw` | `runtime` |
|---|---|---|---|---|---|
| comparisons, `in`, `between`, `is-blank`, `match`, `multi-select-contains`, `within-distance`, `exists`, `missing`, `not`, `and`, `or`, `match-all`, `match-none` | today's CSQL forms (`csqlEmitter.ts`), with §3's additions | none | none | none | the on-device form |
| `when-input-present` | `if(count(<input>), <clause>, 'match-all()')`, today's | none | none | none | on device |
| `if`, `switch` with clause branches; a clause that reads no row | runtime choice (§3.10) | none | none | none | on device |
| `term prop`, `case-row-type` | none | the CSQL name (`termEmitter.ts::emitCsqlPropertyRefText`), `@case_type` | refused (`case-property-on-value-side`) | refused | the on-device read (a row of `cases` only) |
| `term literal`, `choice`, `case-type` | none | none | CSQL literal (`termEmitter.ts::emitCsqlLiteralSegment`) | CSQL literal | XPath literal |
| `now`, `date-coerce`, `datetime-coerce`, `double`, `date-add` | none | none | native call when every operand is `server-value`-emittable; else, for a runtime operand, the native call with that operand interpolated (§3.5) | refused unless Core computes it (then `runtime`) | on device |
| `today` | none | none | runtime segment `today()`, quote-free (§3.4) | runtime | on device |
| `value-list` | none | none | `unwrap-list('<json>')` (§3.6) | none | none |
| every other value arm and leaf (`concat`, `if`, `coalesce`, `arith`, `format-date`, `table-lookup`, `input`, `session-*`, `session-datum` and `project` (the chosen case's id and property, §3.9), …) | none | none | runtime segment, quote cascade | runtime segment, quote cascade | on device |

"On device" is the one on-device emitter: today `lib/commcare/expression/onDeviceEmitter.ts` and
`lib/commcare/predicate/caseListFilterEmitter.ts`, from step 3 `lib/commcare/xpath/wire/fromExpression.ts`
building a `WireExpr` that `serializeWire` prints (part 04 §2.6). It is the only printer of a runtime
segment, so:

- finding 56's lowering, chosen per operand by part 04 §3, applies to an ordering Core evaluates
  inside a runtime segment (a runtime choice's condition `#search/since < now()`, a runtime `if`
  value comparing two datetimes);
- no node in `query`, `anchor`, `server-value` or `raw` position is ever lowered: HQ compares instants
  (`comparison.py::_create_system_datetime_query`, `case_property_range_query`), and a lowering there
  would be CSQL text HQ cannot parse;
- the instance declarations of the remote request derive from the runtime segments' wire trees,
  replacing the parallel AST walk of `lib/commcare/predicate/instances.ts`; this holds from pull
  request 4, the wire tree, where `serializeWire` already prints every runtime segment and returns
  its instances (part 04 §2.4).

A runtime segment carries, besides its printed wire tree, its **value XPath** (the raw read before
quoting, today's `stringValueXPath` generalized to every segment) and a **segment key**, the
expression path of the subtree it evaluates. Preview's fold (§4) evaluates the value XPath and
substitutes by key.

**Two refusals hold in both CSQL slots whatever the position**: a computed `format-date` pattern
(`format-date-pattern-not-fixed`) and a record `number()` of a date or datetime (`number-of-date`).
Both slots' targets include Postgres, and the rule is the profile's, not the position's: a runtime
segment holding either is refused although the fold would evaluate it in the browser, so a slot's
admissions do not depend on where in the clause a value sits. Both findings are part 03 §3.10's and
land in pull request 6, the checker; this part's CSQL tests of them run from pull request 10.

### 2.3 Where it lives

| File | Holds |
|---|---|
| `lib/commcare/csql/positions.ts` (new) | `csqlPositions(expression, profile)`: the position of every node, by path |
| `lib/commcare/csql/representability.ts` (from `lib/commcare/predicate/csqlRepresentability.ts`) | the CSQL checker rules, now one switch over (arm, position); `CsqlRepresentabilityReason` keeps every existing reason and gains §3's |
| `lib/commcare/csql/emitter.ts` (from `lib/commcare/predicate/csqlEmitter.ts` and `lib/commcare/expression/csqlEmitter.ts`) | one emitter over (arm, position) that builds a `CsqlNode` tree (part 04 §2.5: comparison, query call, `and`, `or`, `not`, step, literal, number, value call, and a runtime hole holding a `WireExpr`); `collectRelatedCaseQueries` and `writeRelatedCaseQuery` unchanged |
| `lib/commcare/csql/print.ts` (new) | `printCsql(tree)`, the only assembler of CSQL text, yielding the `CsqlSegment[]`; the wrapper (today's `wrapClause` and `buildQuoteCascade`) is built as a wire tree, `if(<or of obligations>, 'match-none()', concat(…))` |
| `lib/commcare/csql/segment.ts` (from `csqlSegment.ts`) | the IR `printCsql` yields, with runtime segments holding a wire tree, a value XPath and a segment key; `RuntimeCsqlRejectionKind` widened (§5) |
| `lib/commcare/csql/fold.ts` (new) | `foldCsqlRuntime(expression, values)`, the pure rewrite Preview uses (§4) |
| `lib/commcare/predicate/runtimeCsql*Safety.ts` | moved under `lib/commcare/csql/`, unchanged in meaning |
| `lib/commcare/expression/csqlCapabilities.ts`, `lib/commcare/predicate/csqlRuntimeWalk.ts`, the mode table of `lib/commcare/predicate/matchModes.ts` | moved under `lib/commcare/csql/` in pull request 10, where both directories finish leaving |
| `lib/commcare/expression/onDeviceCompatibility.ts` | moved whole to `lib/commcare/validator/onDeviceCompatibility.ts` in pull request 10: it has no CSQL half, and its date-add and scalar-relation decisions are facts about what a device can run, which stay target rules outside the checker (part 03 §1.4). Its callers re-point there: `lib/doc/commitVerdicts.ts` and the validator rules `caseOperations.ts`, `lookupOptionsSource.ts`, `caseOptionsSource.ts`, `displayConditions.ts`, `case-list/searchInputScreenPredicateTypeCheck.ts`, `case-list/dateAddOnDeviceCompatibility.ts` and `case-list/onDeviceExpressionCompatibility.ts` |
| `lib/domain/expression/geopoint.ts` (new, from the CSQL half of `lib/commcare/predicate/geopoint.ts`) | the geopoint text contract every reader shares: `GEOPOINT_NUMBER_PATTERN`, `GEOPOINT_PROPERTY_PATTERN`, `GEOPOINT_CENTER_PATTERN`, `GEOPOINT_RAW_CENTER_PATTERN`, `normalizeStaticGeopoint`, `isValidStaticGeopointCenter` |

**The CSQL halves between pull requests 4 and 10.** Pull request 4, the wire tree, deletes only the
on-device halves of `lib/commcare/predicate/` and `lib/commcare/expression/` (part 04 §2.6). What the
CSQL code imports from them stays where it is, so `predicate/csqlEmitter.ts`,
`expression/csqlEmitter.ts`, `csqlRepresentability.ts` and the `runtimeCsql*Safety.ts` files compile
unchanged in their imports from pull request 4 to pull request 10, and pull request 10 moves each
piece. Pull request 5, the shape, re-points all of them from `Predicate` to `Expression`, as it does
every importer of `lib/domain/predicate`.

| File | Stays from pull request 4 to 10 | Leaves in pull request 4 (part 04 §2.6) | Pull request 10 moves it to |
|---|---|---|---|
| `predicate/termEmitter.ts` | `emitTermSegment`, `emitCsqlPropertyRefText`, `emitCsqlPropertyRefSegment`, `serializeAncestorPath`; `emitCsqlLiteralSegment`; `wrapTermAsSegmentList`, `quoteRuntimeCsqlValue`, `quoteFreeRuntimeCsqlValue`; the types `TermEmission`, `ConstantTermEmission`, `RuntimeTermEmission`, `RuntimeCsqlQuoteStyle`; and the CSQL-facing runtime reads `emitSearchInputXPath`, `emitSessionUserXPath`, `emitSessionContextXPath` and `STANDALONE_SEARCH_INPUT_INSTANCE_ID` (part 04 §2.6), each reader returning the `suite` print of its arm's `toWire` row from pull request 4, and `emitSearchInputXPath` typed by `CsqlSearchInputContext` (`searchInputNames`, `searchInputInstanceId`), defined in the file in place of the deleted `OnDeviceTermEmissionContext`, so `csqlEmitter.ts` (which imports `emitSearchInputXPath`) and `runtimeCsqlNumericSafety.ts` (which imports `STANDALONE_SEARCH_INPUT_INSTANCE_ID`) keep their imports | the on-device term emitter (`emitTerm`, `emitOnDevicePropertyRef`, `emitOnDeviceLiteralValue`, the join nodesets, `instanceRootPath`, the `OnDevice*` contexts) | `csql/emitter.ts` for the anchor, step and term nodes (`emitTermSegment` and the property and ancestor-path prints become `CsqlNode` constructors, and a runtime read is a runtime hole holding its arm's `toWire` tree, so the three readers and `CsqlSearchInputContext` leave); `csql/print.ts` for `emitCsqlLiteralSegment` (the literal and number print) and the three quoting functions (a runtime hole's quoting, built as wire trees); the four types are replaced by `CsqlNode`'s literal and runtime-hole nodes and leave; `STANDALONE_SEARCH_INPUT_INSTANCE_ID` moves to the instance table (`xpath/wire/instances.ts`), where `csql/runtimeCsqlNumericSafety.ts` reads it |
| `predicate/stringQuoting.ts` | `isCsqlStringLiteralRepresentable`, the `csql` arm of `quoteLiteral`, `formatNumeric` | the on-device arms of `quoteLiteral` (the serializer's literal print) and `WireDialect`'s two device dialects | `csql/print.ts`: `isCsqlStringLiteralRepresentable` (exported, read by `representability.ts`) and the CSQL literal quote; a CSQL number prints through the wire serializer's number print (part 04 §2.3: shortest round trip, no exponent), so a number reads one way in CSQL and XPath: `formatNumeric` moves into `xpath/wire/serialize.ts` as that number print, and `lookup/cellText.ts` re-points to it |
| `predicate/geopoint.ts` | the four `GEOPOINT_*_PATTERN` constants, `normalizeStaticGeopoint`, `isValidStaticGeopointCenter`, `collectRuntimeGeopointInputNames`, `collectGeopointCenterInputNames` | the device builders inside `normalizeOnDeviceGeopoint` and `validOnDeviceGeopointCenter`, whose trees move to `xpath/wire/geopoint.ts` (new), which the `within-distance` arm builds; the two functions keep their signatures and print those trees in `suite` mode, so the CSQL emitter's runtime center and the center's `geopoint` obligation print through `serializeWire` (part 04 §2.6) | `lib/domain/expression/geopoint.ts` (the table above) for the patterns and the static checks, read by the CSQL emitter, by the checker's literal-center rule and by `lib/preview/xpath/generatedJavaRosaFunctions.ts`, which re-point to it in pull request 10, as do its tests `generatedJavaRosaFunctions.test.ts` and `evaluator.test.ts` and the validator rules `rules/displayConditions.ts` and `case-list/onDeviceExpressionCompatibility.ts`; `csql/emitter.ts` for the two input walks, which name the inputs a `geopoint` obligation blames |
| `predicate/csqlRepresentability.ts` | the whole file (`checkCsqlRepresentability`, `normalizeCsqlPredicate`, the reasons); its one import from `stringQuoting.ts` survives there | nothing | `csql/representability.ts` (the table above), `normalizeCsqlPredicate` with it |
| `expression/csqlEmitter.ts`, `expression/csqlRuntimeExpression.ts`, `expression/csqlCapabilities.ts` | the whole files; `emitCsqlRuntimeExpression` prints through `serializeWire(toWire(…))` from pull request 4, since `onDeviceEmitter.ts` leaves there | nothing | `csql/emitter.ts` (the runtime hole) and `csql/` as the table above says |
| `predicate/matchModes.ts` | the whole file: the mode table, `ON_DEVICE_MATCH_MODES` and `matchModeRunsOnDevice`, read by `validator/rules/displayConditions.ts`, `caseOptionsSource.ts`, `case-list/matchModeOnDeviceCompatibility.ts`, `lib/doc/commitVerdicts.ts` and `toWire` | nothing | `csql/`, its importers re-pointed there |
| `predicate/index.ts`, `expression/index.ts` | re-export only what stays | the re-exports of what leaves | deleted with their directories |

`lib/commcare/validator/rules/case-list/csqlPredicateRepresentability.ts` stays the commit-gate entry
(`CASE_LIST_CSQL_NOT_REPRESENTABLE`), and `lib/doc/commitVerdicts.ts::predicateExpressionRuntimeEditVerdict`
the builder's pre-dispatch verdict, both reading `representability.ts`. The client-safe barrel export
of `lib/commcare` gains `positions.ts` and `fold.ts`. Their consumers are
`lib/preview/engine/searchInputValidation.ts` and the Results Server Actions in
`lib/preview/engine/caseDataBinding.ts`, and `biome.json`'s `lib/commcare` allowlist already admits
`lib/preview/engine/**` and `lib/preview/xpath/**`, so it needs no change while they stay there.

**Implementation correction, 2026-10-19** (the emitter, pull request 10):

- The position function's core is `lib/domain/expression/csqlPositions.ts` (decision D1: the checker
  in `lib/domain` reads it and cannot import `lib/commcare`); `lib/commcare/csql/positions.ts`
  re-exports it. It takes the root alone, `csqlPositions(root): CsqlPositionMap`, keyed by
  `csqlPositionKey(path)` over the checker's `CheckPath` (`children.ts::expressionChildren`'s paths,
  the key spans and child types use; a `term` expression and its term share one), with
  `csqlRuntimeRoots(root)` (each maximal runtime subtree and the position it sits in),
  `isRuntimeSubtreeRoot`, `isCsqlQueryAnchor` (a property, `case-row-type`, a child-case count),
  `isCsqlServerValueFunction` (`now`, `date-coerce`, `datetime-coerce`, `double`, `date-add`,
  `value-list`) and `readsSearchRow` (a property, `case-row-type`, `case-index` or a relation,
  outside a `cases`, `table-rows`, `locations` or `project` of its own). A comparison is read by its
  query side, so the authored tree and its `normalizeCsqlPredicate` form agree. Rules the table
  leaves open: `and`, `or`, `not` and `when-input-present` never become a runtime clause (each clause
  decides); `match-all`, `match-none` and `is-blank` of a literal stay `query`; a `switch`'s `on` and
  `when` values are `runtime`; a property or `case-row-type` in a value position keeps that position,
  so representability names it (`case-property-on-value-side`); `value-list`'s items are `raw`.
- `CsqlNode` lives in `lib/commcare/csql/tree.ts` (new) with its constructors (`c`), beside
  `xpath/wire/tree.ts`'s shape. `print.ts` holds `printCsql` and `csqlClauseWrapper` (the presence
  cascade, the flat quote cascade and the general guard, built from `w.*`). `termEmitter.ts`,
  `valueEmitter.ts` and `runtimeExpression.ts` are deleted: their prints are `emitter.ts`'s nodes, a
  runtime read is a hole holding its `toWire` tree, and `CsqlEmissionContext` is exported from
  `emitter.ts`. `emitter.ts::prepareCsqlClause` is the clause the emitter reads (choices
  materialized, `normalizeCsqlPredicate`, relation scopes, the CSQL lift); segment keys are checker
  paths in it, so the fold prepares a clause the same way before it substitutes. A choice's key is
  its `if` path, a `switch` case's its `when` path, a `when-input-present`'s its own path.
- A runtime segment carries `value` (the raw read) and `key`; `stringValueXPath` stays for the quote
  cascade. `segment.ts::isSilentRuntimeCsqlRejection` names the kinds with no worker message
  (`blank-comparand`, `list-item`).
- `formatNumeric` stays `lib/domain/expression/numberLiteral.ts`'s, which the CSQL printer, the wire
  serializer and `lookup/cellText.ts` all read (decision D9).
- Dead halves removed with the move: `runtimeCsqlQuoteSafety.ts::collectRuntimeCsqlStringInputNames`
  (each quoted hole names its own prompts), `runtimeCsqlNumericSafety.ts::collectRuntimeCsqlNumericInputConstraints`
  and `::promptWholeNumberTest`, and `collectRuntimeGeopointInputNames`, none of which had a caller.
- Composition (decision D7): `suite/case-search/xpathQuery.ts::composeXPathQueryClauses` returns each
  clause with its source's context (the filter's, each advanced input's own
  `search_input_predicate`, and the filter's for a simple input's derived clause, which has no slot
  of its own); each source is simplified alone, a `match-none()` source makes the search
  `match-none()`, and `composeXPathQueryEmission` accepts either `ModuleExpressionContexts` or one
  shared context. The bare-input assertion skips an input inside a runtime subtree in `query`
  position, as the gate rule does (§3.10's correction).

---

## 3. The constructs

Each block: HQ at the pin, arms, checker, emission and obligations, Postgres and Preview, builder,
record dialect, proofs. "Server-only slot" means a slot whose targets are CS and PG only (part 01
§4): in step 3 that is `searchInputs[advanced].predicate`. "Device-evaluated slot" means one with SU
or XF among its targets.

### 3.1 `closed_on`

**HQ and Core.** HQ indexes `closed_on` as a system datetime (`case_search/const.py::INDEXED_METADATA_BY_KEY`,
`key='closed_on'`, `is_datetime=True`), so every comparison goes to `comparison.py::_create_system_datetime_query`:
a datetime value orders as an instant and `=` is an exact term; `!=` is `filters.NOT` of `=`; `''` or a
non-date raises (step 2's guard holds, `lib/domain/standardCaseProperties.ts::SYSTEM_DATETIME_CASE_PROPERTIES`
already lists it). An open case has no `closed_on`, so a range misses it and `NOT` matches it. Core's
casedb has no `closed_on` (`org/commcare/cases/instance/CaseChildElement.java::buildAndCacheInternalTree`
sets `status`, `date_opened`, `last_modified` and no closed date), and HQ's search results carry
none either (`casexml/apps/case/xml/generator.py::CaseDBXMLGenerator.get_root_element`,
`::add_base_properties`, with `V2CaseXMLGenerator.add_custom_properties`: `case_name`,
`last_modified`, `external_id`, `location_id`, `date_opened` and the custom properties).

**Arms.** `term prop { caseType, property: "closed_on" }`. Not an entry of
`STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`: that table feeds the effective catalog every surface reads
(columns, form reads, case-choice filters), and none of them can read a value no device holds. A new
`SEARCH_ONLY_CASE_PROPERTY_DATA_TYPES = { closed_on: "datetime" }` in
`lib/domain/standardCaseProperties.ts`, with its label ("Date closed") and description, is consulted
by the checker only for a slot whose profile targets exclude SU and XF. Part 01 calls it a
search-only system property.

**Checker.** In a server-only slot `closed_on` resolves to `datetime` (the existing ordering,
`system-datetime-value` and blank-comparand rules apply unchanged). Anywhere else it is the finding
`closed-on-not-on-device` (`CASE_LIST_CLOSED_ON_NOT_ON_DEVICE` in the validator), copy: "Date closed is
known only to CommCare's server search, so it can't be read here. Case status shows whether a case
is closed." A relation `where` inherits its slot's targets.

**Emission.** `closed_on` as the anchor, as today's other system dates. No obligation is new.

**Postgres and Preview.** `lib/case-store/sql/dataTypeTokens.ts::RESERVED_SCALAR_COLUMN_BY_PROPERTY`
maps `closed_on` to the `closed_on` column (`blankable: false`). A comparison with `closed_on` as
anchor is an atom of part 07 §5.5's two-valued rule: bare in positive polarity,
`coalesce(<comparison>, false)` in negative polarity, so `not` and `neq` match HQ's `NOT` (an open
case's NULL makes the comparison false, and its negation true), where today's three-valued `not`
(`compilePredicate.ts::compileNot`) drops it. This part adds no rule of its own for it.

**Builder.** `components/builder/shared/primitives/PropertyRefPicker.tsx` lists "Date closed" among
the case's system values when the slot's `ExpressionEvaluationTarget` (`lib/doc/commitVerdicts.ts`) is
`case-search`, with the description "When the case was closed. Only CommCare's server search knows
it."

**Record dialect.** `#case/closed_on` and `property('T', 'closed_on')`, as any property; the parser
admits it and the checker decides the slot.

**Proofs.** New native family `csql` (§8): `closed_on >= datetime('2026-01-01')`, `closed_on != …`
and `not(closed_on < …)` compiled by HQ in a case-search context and run by HQ's case search over an
open and a closed case; the same rows from Postgres. Already executed in the lane:
`closed_on = '2026-01-01'` compiles and `closed_on = ''` raises
(`proof/hq/test_case_search.py::test_a_blank_or_numeric_date_comparison_is_refused`).

**Implementation correction, 2026-10-19** (the checker, pull request 10):

- `closed_on` resolves only where no device holds the row it reads as well as in a slot whose
  targets exclude SU and XF: a `casedb` row (the chosen case's `project`, a held `cases` read), a
  `results:inline` row and a value the device works out first (`runsOnDevice`) answer
  `closed-on-not-on-device` even in `searchInputs[advanced].predicate`. A case store query (no slot)
  reads it as `datetime`, the gate having decided the slot.
- The table is `SEARCH_ONLY_CASE_PROPERTY_DATA_TYPES` with `SEARCH_ONLY_CASE_PROPERTY_LABELS`
  ("Date closed") and `SEARCH_ONLY_CASE_PROPERTY_DESCRIPTIONS` ("When the case was closed. Only
  CommCare's server search knows it. Case status shows whether a case is closed.").
- Every record rule wraps the finding in its slot code as before; `runValidation` re-codes it to
  `CASE_LIST_CLOSED_ON_NOT_ON_DEVICE` once, in `lib/commcare/validator/recordFindings.ts::sharedRecordFinding`,
  keeping the rule's code as `details.slotCode`, so no rule needs its own mapping and a new rule
  inherits it. Form logic maps it in `formLogicFindings.ts`. The person sentence is "<setting> reads
  Date closed. Date closed is known only to CommCare's server search, so it can't be read here.
  Case status shows whether a case is closed."

### 3.2 Case-type terms

**HQ.** `@case_type` is metadata compared as `type.exact` (`INDEXED_METADATA_BY_KEY`), through
`comparison.py::_create_system_query`: `=` a term, `!=` its `NOT`, `''` `filters.empty`.

**Arms.** `term case-row-type {}` (part 01 §1.3) on the left, `term case-type { caseType }` on the
right (a literal opposite `case-row-type` parses to it). Admitted in every record slot that has a case
row in scope, CSQL or not; most useful inside an `exists`/`count` `where` over a relation whose
destination is not one type (`any-relation`, or an identifier several types use).

**Checker.** `case-row-type` is `text`. A `case-type` leaf must name a case type of the catalog
(`unknown-case-type`); an ordering on `case-row-type` is refused (`case-type-ordering`, "Case types
can be compared only as equal or not equal."). A comparison that can never be true for the row's
fixed type is no finding, as part 01 §4 treats a literal matching no option.

**Emission.** CSQL `@case_type = 'visit'` (anchor), on device `@case_type = 'visit'` on the casedb or
results row (`CaseDBXMLGenerator.get_root_element` writes `case_type`). The hop qualifier Nova already
writes (`csqlEmitter.ts::prependCaseTypeFilter`) is the same text; the import step decides whether it
parses back to the qualifier or to an authored term.

**Postgres.** `case_type` is already a mapped column; `case-row-type` compiles to it, in relation
subqueries on the related row (`compileRelationPath.ts`).

**Builder.** The property picker offers "Case type" in case-row slots; the comparison card's value
side becomes `components/builder/shared/CaseTypeValuePicker.tsx` (new), offering the relation's
possible destination types first. It is a value picker over the catalog's case types and is
separate from `components/builder/shared/CaseTypePicker.tsx`, the module case-type picker with
create-new, which it neither reuses nor changes: a comparison names an existing type and never
creates one.

**Record dialect.** `record-type() = 'visit'` (part 01 §2.4), `in(record-type(), 'visit', 'referral')`.

**Proofs.** Family `csql`: `subcase-exists('parent', @case_type = 'visit')` and `@case_type != 'x'`
compiled and run; device: `NavigationRuntimeTest`-style evaluation of the on-device filter over a
casedb holding two types.

**Implementation correction, 2026-10-19** (the checker): a text literal opposite `case-row-type`
in `eq` or `neq`, and each `in` value with `case-row-type` on the left, must name a catalog case
type (`unknown-case-type`, "This app has no case type '<name>'. Choose one of its case types."),
as decision D5 keeps `in.values` literal. `case-row-type` and `case-type` stay refused
(`arm-unavailable`) in a record slot with no case row in scope. `case-type-ordering` covers `between`
too.

### 3.3 Project-timezone day comparisons

**HQ.** A date (not datetime) compared with `date_opened`, `closed_on` or `last_modified` means the
project's day: `comparison.py::_create_system_datetime_query` converts it by
`adjust_input_date_by_timezone` (adding a day for `>` and `<=`) in `corehq/util/timezones/utils.py::get_timezone_for_domain`,
which is `Domain.default_timezone`.

**Nova cannot learn that zone.** No route an API key opens returns it: the domain settings views
read it for session-authenticated pages (`domain/views/settings.py`), and the one API resource that
reports it does so for a feature-flagged audit feed (`api/resources/v0_5.py::NavigationEventAuditResource`,
`ACTION_TIMES_API`). So Preview cannot evaluate the construct before or after a publish, and an
authored "project timezone" in Nova would be a setting Nova cannot keep equal to HQ's.

**Decision** (decided with the person, 2026-10-17). Step 3 neither authors nor holds it: no API-key
route reads a project space's timezone, so no step-3 surface can author it truthfully. No step-3
document can hold it either: a date against a system date is refused today, so the cutover lifts
nothing to it, and an arm every profile refused would be dead schema surface in the served tool
schemas and an emitter branch nothing exercises. Nova's own meaning stays the worker's day (§3.4)
and the UTC day for an explicit `datetime-coerce` of a date (`lib/domain/predicate/CLAUDE.md`, "Exact
calendar-day search"), and the checker keeps refusing a date against a datetime without a coercion
(`incompatible-values`). `project-day` is not in step 3's union; step 6 decides it on import,
including how an imported app's project day is evaluated in Preview. The manifest entry
`case-search/date-only-comparison-on-date-opened-closed-on-last-modified` stays HELD-NEW, owned by
step 6, and this plan's own pull request writes the deferral and its reason into
`docs/plans/hq-round-trip/6-import.md`.

### 3.4 CSQL `today()`

**HQ and Core.** HQ's `today()` is the project's default-timezone date
(`value_functions.py::today`, `Domain.get_default_timezone()`); Core's is the device's
(`org/javarosa/xpath/expr/XPathTodayFunc.java::evalBody`, `DateUtils.roundDate(new Date())`), and on
Formplayer the browser's, because every request carries the browser offset into Core's timezone
provider (`formplayer/aspects/SetBrowserValuesAspect.java::setValues`). Today a case list filter on
`today()` is applied twice in different zones: by the device to the list, by HQ to the search.

**Decision** (decided with the person, 2026-10-17: the worker's day everywhere). The `today` arm in a
`server-value` position emits a runtime segment `today()`, printed
quote-free (Core prints a `Date` as `yyyy-MM-dd`, `org/javarosa/xpath/expr/FunctionUtils.java::toString`),
so `dob >= today()` becomes `concat('dob >= "', today(), '"')`, and `datetime(today())` becomes
`concat('… datetime("', today(), '")')`. HQ reads a date string, which its range query and its
value functions parse (`comparison.py::case_property_range_query`, `value_functions.py::value_to_date`).
The segment is never blank, so it carries no blank-comparand guard. `now()` stays native: HQ's and
Core's are both the instant.

Neither refusing (it would remove a working affordance) nor holding HQ's project day (the case list
filter would keep disagreeing with itself) gives one meaning. With the lowering, device, server and
Preview (which evaluates `today` in the viewer's zone, `lib/case-store/sql/compileExpression.ts::compileToday`)
read one day.

**Changes at the next publish.** Every `_xpath_query` that holds `today()` changes bytes once; a
search a worker runs in a zone other than the project's may return a different set near midnight,
which is the fix. Production holds none: no `_xpath_query` a live app sends reads `today` or `now`,
from the case list filter or from an advanced input, so no module's bytes move for this. The notice
reason stays, since an app edited before the window can gain such a filter, and the step 3 cutover
writes one document notice entry per module whose effective `_xpath_query` reads `today` at the
window (a `today` arm in a CSQL position of `caseListConfig.filter` with Search effective, or of a
`searchInputs[advanced].predicate`); the dry run reports the count (§10):

- reason `search-today-is-workers-day`, entity type `module`, joining
  `lib/notices/migrationNotice.ts::DOCUMENT_NOTICE_REASONS` among the reasons for changes that write
  nothing, after `case-list-search-matches-hidden-fields`;
- renderer in `lib/notices/migrationNoticeCopy.ts::MIGRATION_NOTICE_COPY`: "From the next publish,
  the search in <module> reads "today" as the worker's own date, the date its case list already uses.
  Near midnight, a worker in a different time zone from the project space may find different cases
  than before."

The cutover writes nothing to the document for it; the entry is computed by the cutover's notice
pass from the same predicate walk the dry run counts (`walkExpressionTerms` over the CSQL slots).

**Proofs.** Family `csql`: the Core class builds the query under two JVM default zones (UTC+14 and
UTC−8) at one instant whose local dates differ, and HQ's compiler, with the domain's
`default_timezone` set to a third, compiles each to the device's date.

### 3.5 Epoch coercions

**HQ and Core.** `date(x)`: an `int` is days since 1970-01-01, a string is `parse_date`, anything else
raises, a float included (`value_functions.py::value_to_date`). `datetime(x)`: an `int` or `float` is
days since 1970 as a naive datetime, then `.astimezone(pytz.UTC)` (`::_value_to_datetime`), which
reads the naive value in the process zone; HQ sets `settings.py::TIME_ZONE = "UTC"`, which Django
applies to the process (Django is not in the checkouts; the native HQ run settles it). A negative
literal reaches HQ as `-1 * n` (`dsl_utils.py::unwrap_value`, `UnaryExpression`). Core's `date(n)` is
1970-01-01 plus `toInt(n)` days (`org/javarosa/xpath/expr/XPathDateFunc.java::evalBody`,
`FunctionUtils.java::toDate`).

**Arms.** `date-coerce { value }` and `datetime-coerce { value }` with an `int` or `decimal` operand
(part 01 §1.4).

**Checker.** In a CSQL `server-value` position a `date-coerce` operand must be `int`; a literal that is
not whole, or a `decimal` value, is `epoch-days-not-whole` ("CommCare's search counts days in whole
numbers. Use a whole number of days."). A `datetime-coerce` of a number in a device-evaluated slot is
refused unless the operand is `int`, because the device's `date(n)` drops the fraction
(`epoch-fraction-on-device`).

**Emission.** A literal operand: native `date(19000)`, `datetime(19000.5)`. A runtime operand: Core's
`number(<x>)` as a runtime segment interpolated **unquoted** (a quoted digit string reaches HQ's
`parse_date` and is refused), which Core prints as an integer when integral
(`FunctionUtils.java::toString`): `date(` + `number(x)` + `)`, with a `whole-number` obligation for
`date` and a new `decimal-number` obligation for `datetime` (`not(number(x) = number(x)) or
contains(string(number(x)), 'E')`), because Core prints a very small or very large double with an
exponent HQ's lexer cannot read.

**Postgres.** `date '1970-01-01' + n` for `date-coerce`, `timestamptz '1970-01-01 00:00:00+00' + n *
interval '24 hours'` for `datetime-coerce` (`compileExpression.ts::compileCast` gains the numeric arm),
as part 07 §5.3 states it: an interval of hours adds elapsed time, where `'1 day'` added to a
`timestamptz` follows the session time zone's daylight-saving changes. The compiler is part 07's.

**Production.** A numeric coercion is refused today (`text-or-date-value`, §1), so no stored
expression holds one and the cutover lifts nothing to it.

**Builder.** `components/builder/shared/cards/expression/DateCoerceCard.tsx` admits a number operand
(its `ExpressionPicker` constraint widens), with the hint "A number counts days from 1 January 1970."

**Record dialect.** `date(#case/day_count)`, `datetime(19000.5)`: today's spellings, now admitted.

**Proofs.** Family `csql`: `date(19000)`, `date(-1)`, a runtime `date(number(…))`, `datetime(19000.5)`
compiled by HQ to their dates; a runtime `1.5` answers `match-none()`.

**Implementation correction, 2026-10-19** (the checker): the record `date-coerce` and
`datetime-coerce` admit `int` and `decimal` operands in every record slot. `epoch-days-not-whole` is
`lib/commcare/csql/representability.ts`'s reason (a position fact), under
`CASE_LIST_CSQL_NOT_REPRESENTABLE` with this section's sentence. `epoch-fraction-on-device` (a `decimal` operand of `datetime-coerce`
wherever a device evaluates it, including a search value the device works out first) has the copy
"This turns a number with a fraction into a date and time, but on a device CommCare counts only
whole days, so the time of day would be lost. You can use a whole number of days."

**Implementation correction, 2026-10-19** (the representability rule, pull request 10): the
checker paragraph's "a `decimal` value" means a value HQ itself evaluates. A `decimal` operand of
`date-coerce` the device works out first (a `runtime` position, such as arithmetic over an answer)
is admitted, its print carrying the `whole-number` obligation, so a fraction sends `match-none()`;
a non-whole literal, and a `decimal` value in a `server-value` position (HQ's own `double()` over a
literal or an answer), stay `epoch-days-not-whole`. HQ evaluates `double()` itself, so
`date(double(<answer>))` is a server value; the `csql` family's runtime form is
`date(18990 + double(<answer>))`.

### 3.6 List values (`unwrap-list`)

**HQ.** `unwrap-list(x)` is a value function whose argument is a raw string literal holding JSON
(`value_functions.py::unwrap_list`); a value that is not JSON raises `JSONDecodeError`, which neither
`unwrap_value` nor `filter_dsl.py::build_filter_from_xpath` catches. On a custom property `p =
unwrap-list(…)` is an exact any-of (`es/case_search.py::case_property_query` →
`exact_case_property_text_query`, `es/filters.py::term` turning a list into `terms`); on
`@case_id`, `@owner_id`, `@case_type`, `name`, `external_id` the system term takes the list too
(`comparison.py::_create_system_query`), but `@status` compares the list with `'closed'` and is wrong;
a system datetime and any ordering raise. On an ancestor `@case_id` the list is HQ's own spelling of a
multi-value ancestor criterion (`case_search/utils.py::_get_query`, `ancestor_functions.py::_get_case_ids_from_ast_filter`).

**Decision: what Nova does not author, and why.** No step authors `value-list`. A list literal
and a list assembled at run time exist in HQ's own editors as an escape hatch, a way to write raw
CSQL where the editor has no construct; Nova's authoring has its own arm for what a person builds
with one, a fixed list of values, which is `in` and which every surface already authors. Nova does
not reproduce an escape hatch because HQ has one. It is held for import all the same: the union
holds `value-list` (part 01 §1.4), the checker, emitter, fold and Postgres handle it, and the native
family proves it, so step 6's import keeps an imported search that uses one, runtime-assembled lists
included. The builder renders a stored one with a display-only card (part 02 §4.5), and the record
dialect has no list spelling. This plan's own pull request writes into
`docs/plans/hq-round-trip/6-import.md` that step 6 reads `unwrap-list` into `value-list` and that no
step authors it.

**Checker.** `value-list` only as the right side of `eq`/`neq` whose anchor is a custom property,
`@case_id`, `@owner_id`, `case-row-type`, `case_name` or `external_id`, or an ancestor `case_id`
(`value-list-placement`, "A list of values can be compared only as equal or not equal to a case
value."). Items share one type with the anchor.

**Items that are node-sets.** An item is a scalar of the item type or a `many` node-set of it,
flattened into the list. HQ's runtime-assembled lists (the inventory's "runtime-assembled lists
included") are node-sets of unknown length, such as the chosen cases' ids, which a fixed number of
scalar items cannot hold. The checker's `many-values` rule (part 03 §3.4: refused only for a repeat's
answer read from outside that repeat as one value) never reads a `value-list` item.

**Emission.** `<anchor> = unwrap-list('<json>')`. Literal items are JSON-encoded with `'` written
`'`, so the single-quoted CSQL literal never holds `'` and `json.loads` restores it. A runtime
item is interpolated inside the JSON string between `"` delimiters; a node-set item is
`join('","', <node-set>)`. Each runtime item carries a new `list-item` obligation, `regex(<v>,
'["\\\p{Cntrl}]') or contains(<v>, "'")` (for a node-set, `count(<node-set>[…]) > 0`): Core's `regex`
is `Matcher.find` (`org/javarosa/xpath/expr/XPathRegexFunc.java`), so this rejects a value holding a
double quote, a backslash, a control character or a single quote.

**Postgres.** `= any(<array>)`; `neq` is its two-valued negation by part 07 §5.5's rule, `not
coalesce(= any(…), false)`, matching HQ's `NOT(terms)`.

**Proofs.** Family `csql`: a literal list with a `'` item, a runtime list of two session values, an
item holding `"` answering `match-none()`.

**Implementation correction, 2026-10-19** (the checker): `value-list` is admitted only in a slot
whose targets are CS and PG alone (`searchInputs[advanced].predicate`); in every other slot it stays
`arm-unavailable`, since no on-device print exists. `value-list-placement` is
`lib/commcare/csql/representability.ts`'s reason; the checker holds the type fact, an item of another
kind than the anchor being `incompatible-values` at the item's path.

**Implementation correction, 2026-10-19** (the review of pull request 10): Postgres compiles
`p in (<item>, …)`, each item a bound literal of the anchor's type as an ordinary comparison binds
one (`compilePredicate.ts::compileValueListEquality`), not one untyped array: an item that can't be
read as that type (`'abc'` or `''` against a number, a day the calendar lacks) matches nothing and
is left out, and a list with no readable item is false, as HQ's `terms` finds no stored value equal
to it. A literal `null` stays the blank item. A node-set item that reads no node is the one blank
item the device sends (`[""]`), never an unfolded node.

**Implementation correction, 2026-10-19** (the review of pull request 10): `value-list-placement`
also refuses a list whose anchor is a custom date-and-time property ("A list of values can't be
compared with a date and time…"), as it refuses a system date. HQ answers `p = unwrap-list(…)` on a
custom property with exact text terms (`es/case_search.py::case_property_query`,
`es/filters.py::term`), finding 75's text equality, so a list can't mean the moments its items
name. Value lists are held for import only, so no authored document is affected; step 6 decides
what an imported one becomes. A date and every other type keep the typed comparison above.

**Implementation correction, 2026-10-19** (the second review of pull request 10; supersedes the
typed comparison two corrections above): Postgres compiles a list as exact text equality with the
text the case holds, for every anchor the placement admits, because HQ compares that text
exactly. On a custom property HQ's `p = unwrap-list(…)` is `terms` on the stored text
(`corehq/apps/es/case_search.py::exact_case_property_text_query` given a list,
`corehq/apps/es/filters.py::term`); on `@case_id`, `@owner_id`, `@case_type`, `case_name` and
`external_id` it is `terms` on the system field (`corehq/apps/case_search/xpath_functions/comparison.py::_create_system_query`).
Neither reads an item as a number, date or time, so `'5.0'`, `'05'`, `' 5'` and `'5e0'` do not
find a stored `'5'`, and `'10:00'` does not find a stored `'10:00:00'`. The store reads
`properties->>'p'` uncast, a system anchor its column's text, and a multi-select its stored
choices joined by single spaces, the text a device stores (`compileTerm.ts::compileStoredText`);
`compilePredicate.ts::compileValueListEquality` binds each item's text as the device sends it
(a number in `formatNumeric`'s spelling, a literal `null` as `''`) and drops none. A `''` item
matches a blank value: HQ indexes every property a case holds, blank ones included
(`corehq/pillows/case_search.py::_get_case_properties`), so `terms ['']` finds a case holding the
property as `''`, which is what a device's blank answer writes; Nova stores that blank as the
key's absence (`submissionEnvelope.ts::storageValueFromEvaluation`), so the item matches the
property absent or empty, on any type. `neq` stays the two-valued negation.

### 3.7 Runtime values in raw arguments

**HQ and Core.** `selected`/`selected-any` and `selected-all` pass the value argument unevaluated to
`case_property_query(…, multivalue_mode='or' | 'and')`, an analysed `match` on the value's tokens
(`query_functions.py::_selected_query`, `es/case_search.py::case_property_text_query`); a `''` value is
`case_property_missing` (`case_property_query`). `starts-with` and `phonetic-match` also take the value
raw (`::starts_with`, `::phonetic_match`). Core's `selected(p, v)` is a space-bounded substring test
of one value (`org/javarosa/xpath/expr/XPathSelectedFunc.java::multiSelected`).

**Arms.** `multi-select-contains { property, values: [Literal | Choice | E, …], quantifier }`;
`match { property, value: E, mode }` (part 01 §1.4).

**Meaning.** A runtime value of `multi-select-contains` is a space-separated list of option values:
`any` is true when the property holds at least one token of any value, `all` when it holds every
token of every value. Literal values keep today's meaning (each is one token, `matchModeWhitespaceInValue`).
This is a meaning a literal value never had, chosen because it is what HQ's analysed match does with
a multi-token value and the only meaning both HQ and Postgres can hold.

**Checker.**

- A runtime value is `text`, `single_select` or `multi_select` typed (`runtime-selected-value-type`).
- In a device-evaluated slot a runtime value must be `single_select`, one token by
  `lib/domain/selectOptionValue.ts::SELECT_OPTION_VALUE_PATTERN`, because the device cannot split a
  runtime string into tokens (`runtime-selected-value-on-device`, "This value can hold several
  choices, which the device reads differently from the server. Choose a single-choice value here, or
  use it in a search field's condition.").
- In a `raw` position every non-literal is a runtime subtree; one that only HQ can compute (a
  `datetime-coerce`, a calendar `date-add`) is `raw-argument-not-evaluated` ("CommCare's search uses
  this value as written and won't calculate it. Choose a fixed value or one the device can work
  out."). A runtime subtree passes the on-device rules (today `lib/commcare/expression/onDeviceCompatibility.ts`;
  from pull request 10 the same file at `lib/commcare/validator/onDeviceCompatibility.ts`, §2.3).

**Emission.** Each literal value as today; each runtime value its own call, `selected-any(p, "<v>")`
for `any` and `selected-all(p, "<v>")` for `all`, through the quote cascade
(`quoteRuntimeCsqlValue`), joined with today's `or`/`and`. A runtime value also carries the
`blank-comparand` guard (`lib/commcare/predicate/runtimeCsqlDateSafety.ts::blankComparandGuard`), since
HQ reads `''` as "is blank", where Nova's meaning is "holds no token". `starts-with` and `phonetic`
keep today's emission; the position rule now guarantees a native value function never lands there.

**Postgres and Preview.** The fold (§4) splits a runtime value on ASCII whitespace into literal
tokens before compilation, so `compilePredicate.ts::compileMultiSelectContains` stays a literal-token
compiler.

**Builder.** `components/builder/shared/cards/MultiSelectContainsCard.tsx` gains "Add a value from"
(an `ExpressionPicker`) in slots that admit it, offering only single-choice values in a
device-evaluated slot.

**Record dialect.** `selected-any(#case/tags, 'a', #search/tags)`: a value argument is a literal or a
value (`queryExpressions.ts`, the `selected-any`/`selected-all` branch, which today maps every argument
through `literal`).

**Proofs.** Family `csql`: a runtime `a b` under `any` and `all`, a value holding `"`, and a blank
value compiled and run; Core's evaluation of the single-choice form on device.

**Production.** No effective `_xpath_query` holds a `match` or a `multi-select-contains` at all, so
none holds a native value function under `starts-with` or `phonetic`, and none a runtime `selected*`
value; nothing lifts.

**Implementation correction, 2026-10-19** (the checker): both runtime-`selected*` rules hold in every
record slot, not only the CSQL ones (a device-evaluated slot is one with XF or SU among its targets,
or a value a device works out first). `raw-argument-not-evaluated` is
`lib/commcare/csql/representability.ts`'s reason (a position fact). Copy written
where this section gives none: `runtime-selected-value-type`, "A value that names choices needs to be
text or a choice, and this value is <kind>. You can choose a text value or a choice question's
answer."

### 3.8 Distance units and runtime distance operands

**HQ.** `within-distance(prop, coords, distance, unit)`: `float(distance)` (a string `"5"` reads, a
bare word raises `TypeError`, which `build_filter_from_xpath` reports as "Malformed search query"),
and `unit` must be one of `es/queries.py::DISTANCE_UNITS` (`miles`, `yards`, `feet`, `inch`,
`kilometers`, `meters`, `centimeters`, `millimeters`, `nauticalmiles`), all raw
(`query_functions.py::within_distance`); HQ sends `"<distance><unit>"` to Elasticsearch
(`es/queries.py::geo_distance`).

**Arms.** `within-distance { property, center, distance: number | E, unit: DistanceUnit | E }` with
`DistanceUnit` the nine (part 01 §1.4).

**Meters.** `lib/domain/expression/distance.ts::METERS_PER_DISTANCE_UNIT` (today's `lib/domain/predicate/distance.ts`, moved by pull request 5) gains yard `0.9144`, foot
`0.3048`, inch `0.0254`, meter `1`, centimeter `0.01`, millimeter `0.001`, nautical mile `1852`, the
international definitions Elasticsearch's distance units use. Elasticsearch is not in the checkouts,
so the `csql` family's run over the lane's Elasticsearch 6.8.23 (`proof/hq/elasticsearch.py`) settles
each factor, not a reading.

**Checker.** A runtime distance is numeric (`distance-not-numeric`); a runtime unit is `text` or
`single_select` (`distance-unit-type`); a literal unit is one of the nine (the schema's enum).

**Emission.** CSQL: a literal radius and unit as today; a runtime radius as a runtime segment between
fixed `"` delimiters with a new `positive-number` obligation (`not(number(<d>) > 0)`), a runtime unit
the same with a new `distance-unit` obligation (`not(<u> = 'miles' or … or <u> = 'nauticalmiles')`);
both are quote-free once their obligation passes. On device (today
`caseListFilterEmitter.ts::emitOnDeviceWithinDistance`, from step 3 its constructor in
`xpath/wire/fromExpression.ts`, part 04 §2.6): the meters bound becomes
`number(<d>) * <factor>`, the factor a nested `if` over the nine units ending in `0 div 0` (NaN), so an
invalid radius or unit makes the comparison false where HQ answers `'match-none()'`: both find nothing.

**Postgres.** The fold supplies literals; `compileWithinDistance` reads the widened table.

**Builder.** `WithinDistanceCard.tsx`: the unit menu lists the nine as "miles", "yards", "feet",
"inches", "kilometers", "meters", "centimeters", "millimeters", "nautical miles" (`UNIT_LABELS`), and
the distance and unit each offer "Use a value" (an `ExpressionPicker` constrained to a number, and to
text).

**Record dialect.** `within-distance(#case/gps, #search/here, #search/radius, 'meters')`; the third
argument a number or value, the fourth a unit name (today's aliases `km`, `kilometer`, `mi`, `mile`
kept) or a value.

**Worker messages.** `positive-number`: "Enter a distance greater than zero"; global "This search's
current distance needs to be a number greater than zero". `distance-unit`: "Choose a distance unit";
global "This search's current distance unit isn't one CommCare recognizes".

**Proofs.** Family `csql`: each unit compiled and run over cases at known separations; a runtime
radius `0`, `abc`, and a unit `parsecs` answering `match-none()`; Core's device form in the same
geometry.

**Production.** No effective `_xpath_query` holds a `within-distance`; nothing lifts and no byte
moves.

**Implementation correction, 2026-10-19** (the checker): copy where this section gives none:
`distance-not-numeric`, "The distance needs to be a number, and this value is <kind>. You can
choose a number value."; `distance-unit-type`, "The distance unit needs to be text naming a unit,
like miles or meters, and this value is <kind>. You can choose a text value or a single choice."
The three worker messages are in `lib/domain/searchRuntimeValidationMessages.ts` with §5's
`decimal-number`; a combined message now starts with a capital letter whatever its first kind.

**Implementation correction, 2026-10-19** (the HQ-side type): on HQ a `within-distance` finds a
case only when its property is typed there. HQ queries `case_properties.geopoint_value`
(`corehq/apps/es/case_search.py::case_property_geo_distance`), which the case search pillow fills
only for the project's geo case property (`geospatial/utils.py::get_geo_case_property`,
`GeoConfig.case_location_property_name`, default `gps_point` in `geospatial/const.py`) and, where
the domain has `DATA_DICTIONARY`, for the properties its Data Dictionary types GPS
(`corehq/pillows/case_search.py::_add_smart_types`, `data_dictionary/util.py::get_gps_properties`).
The type is target-owned and set only in a browser session
(`data_dictionary/views.py::update_case_property`), the page's Data Type column needs
`DATA_DICT_TYPES` too, and both privileges are first in `accounting/bootstrap/features.py::advanced_v0`.
So the construct needs the HQ-side type and Nova names the step:
`lib/commcare/distanceSearches.ts::distanceSearchProperties` derives each `(case type, property)` a
search's clauses measure, and the setup artifact's `distance-search` section and the HQ import
file's guide list each one for a person to set, always, since no API key reads the project's geo
property. The plan requirement is a caveat of that step, not a plan-feature confirmation, because
`upload_app_to_hq`'s `confirm_plan_features` is a served enum.

### 3.9 The chosen case, worker and context values in runtime segments and the case list filter

**What reaches the device.** A remote request's `<data ref>` is evaluated by Core in the session at
the query step, with the instances the request declares (`searchSession.ts`); session datums supplied
before that step are in `instance('commcaresession')/session/data`
(`org/commcare/session/SessionInstanceBuilder.java::addDatums`). A case list filter is part of the
nodeset of the module's own selection datum (`lib/commcare/formLinkProjection.ts::selectableDatums`,
its `caseListFilter`), evaluated when the session reaches that datum, so it reads the same earlier
datums. The datums before a module's own selection are its parent selections and the root menu's
(`formLinkProjection.ts::parentSelectChain`, `::alignWithRootMenu`), which belong to the module, not
to a form: every entry of the module that selects its case holds them, under the same ids. The
same selection datum, with the same filter, also appears in the entries of a module that selects
this one as its parent, where the datums before it can differ. The
search-first inline query sits immediately before the module's own selection datum
(`formLinkProjection.ts::withInlineSearchQueries`), and a Search action's remote request runs from
that selection's case list, so in both shapes the search sees exactly the datums before the
module's own selection. This point, the module's **case list step**, is where every read below is
checked and evaluated.

**Arms.** In a `runtime` position: `session-context` (all seven parse; the builder offers four until
step 4, part 01 §1.6), `session-user` and `session-user-property` (today's), and, from pull request
10, **the chosen case** (part 01 §4, "Chosen case"): its id, `term session-datum { datum:
selected-case { module } }`, and its property, the one `project` shape a record slot admits,
`project { of: cases { source: "casedb", where: [eq(prop { caseType: T, property: "case_id" },
session-datum { selected-case, module })] }, value: prop { caseType: T, property } }` with `T` that
module's case type. `caseListConfig.filter` admits the same two in its device form, in Preview's
Postgres read and in its CSQL runtime segments. Held, and authored by no step: any other `cases`
query, and `table-rows`, `locations` and `selected-cases` reads. `groups` is step 7, group 2's.

**What Nova does not author, and why.** A raw casedb query, a lookup-row query or a location read
inside a CSQL value is how HQ's own editors let a search default reach any instance: an escape
hatch, not a construct. Nova's authoring has its own arm for each thing a person narrows a search
or a list by: a search input, the worker's data and the session context, a lookup value
(`table-lookup`), and the case chosen in an earlier menu. Nova does not reproduce an escape hatch
because HQ has one. These reads are held all the same (union, checker, emitter, fold, Postgres where
a profile admits them, native proof), so step 6's import keeps an imported search that uses one;
this plan's own pull request writes that into `docs/plans/hq-round-trip/6-import.md`.

**Checker.**

- A runtime read of case data must not read the search's own row (`case-property-on-value-side`).
- A held `cases` read is typed as every case query is (part 01 §1.3): by a `@case_type` literal, else
  a `@case_id` compared with a value of known `caseIdOf`, else a custom property read binds to the
  one case type of the effective catalog that declares it, the type then stored; where none or
  several declare it the read is `case-query-untyped`. Used as one value, a `cases` query is
  admitted (part 03 §3.4: only its data decides how many rows match; Core throws at run time on more
  than one, as today).
- The chosen case's id is `text` with `caseIdOf` `T` (part 01 §3.1), and its property has `T`'s
  effective catalog type, so a comparison with it is typed as any property comparison is.
- **The chosen case's supply.** Each chosen-case read in `caseListConfig.filter`, or in a CSQL
  runtime segment of the module's search (the filter with Search effective, a
  `searchInputs[advanced].predicate`, a simple-arm clause), is checked by the entry-supply rule
  (part 05 §1.6: `SESSION_DATUM_NOT_SUPPLIED` over identity) at the module's case list step. In
  every entry whose session reaches that case list (the module's own entries that select its case,
  and the entries of a module that selects it as a parent), a
  `lib/domain/entryDatumSupplies.ts::entryDatumSupplies` row before the row of the module's
  selection datum must list the ref, and those rows must print one datum id, because the filter,
  the detail and the remote request are each one text per module. The checker reads
  it from `ExpressionContext.supplies`, the domain half's set at the module's `case-list` or
  `search` point (part 03 §1.3; part 05 §1.3, "Evaluation points"), whose `differs` lists a ref
  those entries supply at different ids; the domain half decides that from the ref's place in each
  session without spelling an id, and `lib/commcare/formLinkProjection.ts::entryDatumIds` prints
  the one id. So the
  module's own case is refused (the list chooses it and the search finds it), and so is a case
  chosen in a several-case menu (its row is `scalar: false`, part 05 §1.3).
  The rule matters in a real shape: when "Households" picks its parent village and "Visits" picks
  its household from the "Households" list, the village is `parent_id` in the Households entries
  and `parent_parent_id` in the Visits entries, so a Households filter reading the chosen village
  could print the right id for only one of them: HQ builds both from the one filter text, and in
  the Visits entries `parent_id` is the household being chosen at that very step, which holds no
  value yet. `details.carrier` is `case-list` or `search` and
  `details.reason` `not-before` or `differs`, with these sentences in part 05 §1.6's table (`<list>`
  is "The case list of <module>" for `case-list` and "The search in <module>" for `search`):
  - `not-before`: "<list> reads the case chosen in <menu>, but <module> no longer opens after
    <menu>, so CommCare has no chosen case to read there. You can open <module> from <menu> again,
    or remove that read."
  - `differs`: "<list> reads the case chosen in <menu>, but <other module> also shows this list,
    and there CommCare keeps that choice in another place, so the read would not find that case.
    You can remove the read, or give <other module> its own list to choose from."

  A rename or a reorder that keeps the menu before the module reprints and rewrites nothing (part
  05 §1.7); a move that takes it away is refused by this rule, naming the read.

**Held representation.** `date_opened` and `last_modified` have the data type `datetime`, held `date`
in `casedb` rows and text in `results` / `results:inline` rows (`date_opened` a UTC day there; part 01
§3.2). No CSQL position reads a held value (HQ reads its index), so only runtime segments meet it,
through the one on-device emitter. A chosen case's `date_opened` is a casedb row's, so the day rule
meets it as any casedb read (part 03 §3.2).

**Emission.** A runtime segment through the quote cascade; the request declares `casedb` and
`commcaresession` because the segment's wire tree reads them. The chosen case prints as the device
reads it (part 01 §2.4): its id `instance('commcaresession')/session/data/<id>` and a property
`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/<id>]/<property>`,
`<id>` the datum id the module's case list step prints for the ref
(`lib/commcare/formLinkProjection.ts`, part 05 §1.4), one id in every entry that reaches it (the
supply rule above). So `household_id = chosen-case('Households')` in a child module's search is the flat quote cascade
over `instance('commcaresession')/session/data/parent_id`, and in its case list filter the same read
prints inside the selection datum's nodeset (part 04's `toWire` rows for `session-datum` and
`project`) and in HQ JSON's `case_details.short.filter`, whose `case` interpolation finds no token in
it.

HQ JSON's `case_details.short.filter` is the one place that prints a different id: the datum's id
before root alignment (`EntryDatumId.chainId`, part 05 §1.3, "The case list filter's two prints"),
because HQ's build writes the filter into each chain datum's nodeset and then renames session
variables through root alignment (`suite_xml/sections/entries.py::EntriesHelper.get_case_datums_basic_module`,
which builds the chain with `get_datum_meta_module(module, use_filter=True)` and passes it to
`add_parent_datums`, whose `set_id` calls `_update_refs`, a `str.replace` of
`session_var(old_id)` by `session_var(new_id)` over every datum's `nodeset` and `function`). With
Households a root, case-first module and Members its child with parent-select Households, a Members
filter reading the chosen household holds `parent_id` in HQ JSON, which HQ renames to the root's
`case_id`, the id the local suite and every other carrier print. Written with `case_id`, HQ's first
rename (the colliding own datum to `case_id_member`) would turn the read into the datum being chosen
at that step. The rest of the same filter's HQ JSON takes the aligned id: its CSQL copy in
`search_config.default_properties`, which HQ copies into the remote request's `<data ref>` verbatim
(`post_process/remote_requests.py::RemoteRequestFactory._remote_request_query_datums`) and into the
inline query datum it adds after alignment (`entries.py::EntriesHelper.configure_entry_module_form`
calls `add_remote_query_datums` after `get_case_datums_basic_module`), an advanced search input's
predicate, and `form_filter`, which HQ never rewrites. `hqJson/caseList.ts::projectCaseListFilter`
therefore prints the short filter through a `datumId` built from `chainId`, and every other slot
through one built from `id` (part 04 §2.2). The two ids are each one id across the list's entries
wherever the read is admitted, since `differs` refuses a read whose place counted back from the
entry's last selection or whose root alignment differs between them.

**Preview.** The fold evaluates the segment over Preview's session at the module's case list step,
which part 05 §1.8 builds for the Search screen (`entrySessionData` for the query step: the parent
selections and the copied root datums, from Preview's menu case map) and its device casedb snapshot
(`lib/preview/CLAUDE.md`), so a chosen case's id is the selection the navigation holds and its
property the snapshot's row. A browse list's filter (no effective Search) compiles in Postgres with
the chosen case bound (part 07 §5.1). Which cases the folded search itself reads is part 07 §3.5's:
the Project's open cases of the searched type, without the device's restore scope, with the
module's owner exclusion and filters, as HQ's case search reads them.

**Builder.** The `ExpressionPicker` offers the worker's values and the four session context values
it offers elsewhere and, from pull request 10, in the case list filter and the module's Search
slots, a "The case chosen in <menu>" group for each menu before the module's case list step, holding
the case and its properties (part 02 §4.5). The group reads `lib/domain/entryDatumSupplies.ts`, the
domain half of the projection, so it needs no `biome.json` change.

**Record dialect.** Today's `#user/…` and `session-context` spellings, and from pull request 10
`chosen-case('<menu name>')` and `chosen-case-property('<menu name>', '<property>')`, the menu
resolved to its module's identity like every record spelling (part 02 §2.2). The dialect has no
spelling for the held reads, nor for the other four datum kinds.

**Proofs.** Family `csql`: a search narrowed by a worker field and by `session-context(userid)`, with
Core building the query from a session holding them; scenario `chosen-case`, a child module whose
entry passes through a "Households" case list, its search narrowed by the chosen household in the
flag-free ancestor spelling (§3.12) and by `chosen-case-property('Households', 'village')`, with Core
building the query from a session holding the parent datum and a casedb holding the household, HQ
compiling it with `CASE_SEARCH_RELATED_LOOKUPS` off and returning that household's children, and
Postgres over the folded values returning the same; and the held `cases` read in a runtime segment,
built by the fixture directly. The lane: `targeted-csql-composition` (§8).

**Production.** No record slot can hold a datum read today (the record `Predicate` has no such
term), so nothing lifts and no byte moves; the reads serve searches and lists authored from pull
request 10.

**Implementation correction, 2026-10-19** (the checker and `entryDatumSupplies`):

- Held `cases`, `table-rows`, `locations`, `project` and non-relation `count` reads are admitted only
  in `searchInputs[advanced].predicate`, and there only in a `runtime` position (the checker's
  position pass refuses one elsewhere, `arm-unavailable`). `caseListConfig.filter` with Search
  effective admits none: its device nodeset and Preview's Postgres read evaluate the same node, which
  no fold reaches. The chosen case's own `project` shape is admitted in all three record slots.
- A simple-arm clause carries no supply set: it is derived from the input's property and reads no
  chosen case.
- A ref listed at the point but held as several cases is refused with a third reason,
  `several-cases`: "<list> reads the case chosen in <menu>, but <menu> now lets workers choose
  several cases, so there is no one chosen case to read. You can let <menu> choose one case, or
  remove that read." (for a form's display condition: "`<form>` shows only when the case chosen in
  <menu> matches, but <menu> now lets workers choose several cases, so there is no one chosen case
  to read. You can let <menu> choose one case, or base the condition on the worker instead.").
- `EntryDatumSupplies.differs` entries are `{ ref, module }`, `module` naming an entry's module that
  holds the choice in another place or not at all, so the `differs` sentence can name
  <other module>. A ref the module's own entries supply before the list and another entry holds
  nowhere is `differs`, not `not-before`.
- The checker's refusal carries `CheckError.chosen` (`carrier`, `module`, `otherModule`), which
  `checkErrorDetails` writes as `carrier`, `datumModule` and `otherModule`; `runValidation` re-codes a
  record slot's finding to `SESSION_DATUM_NOT_SUPPLIED` (`recordFindings.ts::sharedRecordFinding`),
  with the sentence above as both the validator message and the person's line.

**Implementation correction, 2026-10-19** (the emitter, decision D8): every carrier prints the chosen
case through a datum resolver. `formLinkProjection.ts::caseListStepDatumId(doc, module, "id" |
"chainId")` maps each ref to the id the rows before the module's own selection datum hold in its
case-list entry, built lazily over its own metadata-only projection so a carrier printed while the
session projection runs never re-enters it: `"id"` (after root alignment) for the remote request
(`buildRemoteRequest`, `inlineSearchFor`), HQ JSON's `default_properties` and the project-space
check, `"chainId"` for HQ JSON's `case_details.short.filter`. The local suite's case list filter
reads a per-chain resolver in `selectableDatums` over the datums before it in that entry, read when
`deriveCaseSelectionDatum`'s `renderNodeset` runs, which now prints the filter on every render, so the
render after `alignWithRootMenu` names the aligned id. `suite/case-search/moduleXPathQuery.ts::composeModuleXPathQueryEmission(doc,
module, options)` composes a module's search with both, the entry point Preview's
`searchInputValidation.ts` calls.

### 3.10 Runtime choice among clauses

**Arms.** `if { cond, then, else }` and `switch` whose branches are `boolean` clauses, and any clause
that reads no case row (a comparison of worker data, a lookup, an input), in a `query` position.
`when-input-present` stays its own arm: it also gates the input reads inside it
(`searchInputRefUsesWhenInputPresent.ts`). Part 01 §4's profile row for CSQL slots names this
section as the rule for `if` with boolean branches in a query position.

**Checker.** A runtime condition is a control read: a search input in it needs no
`when-input-present` gate (an unanswered input reads `''` on device, a defined value), and the rule
that requires one is narrowed to inputs interpolated into CSQL, so an input read only in a runtime
condition is admitted ungated. Branches are `query`-position clauses under every CSQL rule. A clause
that reads the row on one side and none on the other stays an ordinary anchored comparison.

**Emission.**

- `if(c, A, B)` with `c` row-free: the runtime segment `if(<c>, <A>, <B>)`, each branch rendered like
  a nested `when-input-present` (`csqlEmitter.ts::emitWhenInputPresentSegments`, `buildConcatExpression`).
  A's obligations travel out prefixed `(<c>) and (…)`, B's `not(<c>) and (…)`, so the outermost wrapper
  still fail-closes the whole row and a guard never broadens a `not`/`or`.
- `switch`: the on-device `switch` print with clause branches.
- A row-free clause `c` in a query position: `if(<c>, 'match-all()', 'match-none()')`.
- `if(c, A, B)` whose `c` reads the row: native `((<c>) and (<A>)) or (not(<c>) and (<B>))`.

**Postgres and Preview.** The fold evaluates a row-free condition and keeps the chosen branch; a
row-reading `if` compiles as `CASE WHEN`, NULL taking the else branch as Core's `if` and HQ's `NOT`
do.

**Builder.** A new `components/builder/shared/cards/ConditionChoiceCard.tsx`, registered in
`components/builder/shared/editorSchemas.ts` as the verb "Depends on a condition": "When [condition],
use [clause], otherwise use [clause]". The comparison card stops withholding worker, lookup and input
values on the left of a clause in CSQL slots.

**Record dialect.** `if(#user/role = 'supervisor', true(), #case/owner_id = #user/id)` in a condition
slot: the record compiler's `predicate` accepts `if` and `switch` with condition branches
(`queryExpressions.ts` throws "does not produce a condition" for them today).

**Proofs.** Family `csql`: both branches chosen by a worker value, an obligation inside the unchosen
branch not rejecting the search, and a datetime ordering in the condition evaluated in two device
zones with the value written in a third (finding 56's seventh requirement, through part 04's
lowering).

**Implementation correction, 2026-10-19** (the checker and the gate rule): `if` and `switch` in a
condition position are admitted in every slot whose targets include CS, since every condition
position there is `query` or `runtime`. `CASE_LIST_BARE_SEARCH_INPUT_REF`
(`searchInputRefUsesWhenInputPresent.ts`) skips an input inside a `runtime` subtree in `query`
position (a choice's condition, a clause that reads no case) in an advanced predicate and in the
case list filter while Search is effective; without Search the filter keeps the gate everywhere.
`searchRuntimeValues.ts::walkSearchRuntimeValues` visits `csqlRuntimeRoots` and passes each root's
`within`, and the checker infers a `query` root as a condition.

**Implementation correction, 2026-10-19** (the review of pull request 10): a `switch` whose `on`
reads the row is native as a row-reading `if` is, case by case: each case's condition is the
comparison `on = when` (`on` its query side, `when` its value), emitted `((on = when) and (then)) or
(not(on = when) and (<the cases after>))`, so it is the emission of the nested `if` it stands for.
A selector HQ can't compare (`concat` of a property, say) is refused as
`comparison-needs-case-property` at `on`. A choice's branches print at the precedence the choice
sits at, so the text the device splices groups as the branch written in place (an `or` branch under
an `and` is parenthesised, `eulxml/xpath/parserules.py::precedence`).

**Implementation correction, 2026-10-19** (the second review of pull request 10): each case of a
row-reading `switch` is checked as the authored `eq` of `on` and `when` is
(`representability.ts::checkComparison`: the subcase count bound, the system date's null value, two
cases' properties, a value list's placement), each finding at that case's `when` path, so no case
reaches the emitter unchecked. A row-reading `if` or `switch` prints its condition twice from one
node (CSQL can't name a clause and read it again); `fold.ts::csqlRuntimeReads` lists each runtime
piece once by key, and the wrapper's obligations were already collapsed on their identity.

### 3.11 Several `_xpath_query` rows

HQ ANDs every `_xpath_query` value (`case_search/utils.py::CaseSearchQueryBuilder._apply_filter`), so
one row per top-level conjunct and one row per source find the same cases; and a fail-closed row
answers `'match-none()'` either way, so the search finds nothing either way. Nova's own sources have
no row identity to keep. Step 3 changes nothing here: no byte moves. The inventory's requirement is
about an imported list of rows, each a typed default filter emitted as its own unsplit row; it needs
a slot that holds a list, which no step-3 surface produces, so it is step 6's together with where an
imported row lives (it may read what no device holds, like `closed_on`, so it is not
`caseListConfig.filter`). The manifest entry `case-search/several-xpath-query-rows` stays HELD-NEW.

### 3.12 Ancestor case-id comparisons

**HQ.** An ancestor comparison whose last step is `@case_id` passes the related-lookups gate
(`filter_dsl.py::build_filter_from_ast`, `serialize(node.left.right) != '@case_id'`); with `=` it reads
the ids from the right side without an index query (`ancestor_functions.py::_get_case_ids_from_ast_filter`)
and returns `reverse_index_case_query` (`::walk_ancestor_hierarchy`). `ancestor-exists` always asks
the flag (`_require_related_lookups_flag`, which checks only in a case-search context,
`utils.py::_get_helper`). Executed already in the lane: `parent/@case_id = 'abc'` compiles in a case
search with the flag off (`proof/hq/test_case_search.py::test_a_related_case_filter_needs_the_flag_in_a_case_search_context`).

**Decision.** The emitter writes `<path>/@case_id = <v>` (and an `in` as an `or` of them) for an
`exists(ancestor …, where: eq(prop case_id, v))` when, after `normalizeRelationEvaluationScopes`:

- `v` is in a `server-value` position;
- the path's steps carry no qualifier, or every qualifier equals the type `v` is a case id of
  (`caseIdOf`, part 01 §3.1), so the qualifier the normalizer inferred adds nothing. Two comparands
  qualify: a `case-index` of the row's own relation and, the common case, the chosen case's id
  (`chosen-case('<menu name>')`, a `selected-case` datum whose `caseIdOf` is that menu's case type,
  §3.9), which lands with this rule in pull request 10. A search in "Visits" narrowed to the
  household chosen in "Households" is then `parent/@case_id = "<id>"`, the id interpolated from
  `instance('commcaresession')/session/data/parent_id` through the flat quote cascade, where today's
  emitter would write `ancestor-exists(parent, …)`.

Every other case-id comparison keeps `ancestor-exists`. A literal id keeps it, because the qualifier
the normalizer inferred then filters. `!=` keeps it too: HQ's
`parent/@case_id != x` runs an unbounded index query that can raise `TooManyRelatedCasesError`.

**Effect.** `collectRelatedCaseQueries` records nothing for the flag-free form, so
`xpathQueryUsesRelatedLookup` and `lib/commcare/projectSpaceCompatibility.ts::relatedCaseSearchReasons`
stop asking the flag for such a search with no code of their own. From pull request 10 a project
space without `CASE_SEARCH_RELATED_LOOKUPS` can run a search narrowed to the case chosen in an
earlier menu.

**Postgres.** Unchanged: both spellings are one `exists`.

**Production.** No CSQL slot holds an ancestor case-id equality. Production holds some, in a few
apps, all of them `exists(ancestor …, where: eq(prop case_id, <form case>))` in the filter of a select
whose choices are cases (`lookup_options_source(cases).filter`), a device-evaluated slot this rule
does not touch. So no search's bytes move and no target's flag requirement changes at the next
publish; the rule serves searches authored from step 3.

**Proofs.** Family `csql`: the flag-free form compiled with the flag off and on, and run over a parent
with two children and another parent's child, its comparand a `case-index` and, in the
`chosen-case` scenario (§3.9), the chosen parent's id; the lane's `csql@A` shows no refusal for it
under a configuration without the flag (`targeted-csql-composition`, §8).

**Implementation correction, 2026-10-19** (the emitter): the comparand qualifies when it is no
literal, reads no case row (`readsSearchRow`), sits in a `server-value` or `runtime` position, and
its type names a case id (`caseIdOf`) that every step's qualifier names, if one has a qualifier. A
`case-index` reads the row, which HQ has none of where it evaluates a value, so it is no comparand
here: the flag-free form's common and only step-3 case is the chosen case's id.
`lib/commcare/csql/__tests__/ancestorCaseId.test.ts` holds it over the `chosen-case` scenario.

### 3.13 Equality on a date and time (finding 75)

**What HQ stores.** HQ's receiver rewrites every datetime-shaped string of a submission before
saving it: `form_processor/parsers/form.py::_create_new_xform` calls
`form_processor/utils/xform.py::adjust_datetimes` on the form's JSON, which matches each string
against `RE_DATETIME_MATCH` (date, `T` or space, hour and minute, optional seconds, an optional 3 to
6 digit fraction, an optional `Z` or `±HH[:MM]` offset) and replaces it with
`dimagi/utils/parsing.py::json_format_datetime(adjust_text_to_datetime(s))`, the UTC instant printed
`ISO_DATETIME_FORMAT = '%Y-%m-%dT%H:%M:%S.%fZ'` with six fraction digits; `adjust_text_to_datetime`
is `iso8601.parse_date(text)` (a naive value read as UTC) converted to UTC. Case processing reads the
update from that JSON, so the case property, its case search index entry and a device's restore all
hold that spelling. It holds for every writer that submits:

| Writer | Path to `adjust_datetimes` | Stored |
|---|---|---|
| Nova's form, the `nova_datetime_<question>` sibling (step 2; `lib/commcare/xform/datetimeCaseValue.ts::datetimeCaseValueExpression`, `format-date(…, '%Y-%m-%dT%H:%M:%S.%3%Z')`, e.g. `2026-01-02T10:00:00.000+05:30`) | the device's or Formplayer's submission to HQ's receiver | `2026-01-02T04:30:00.000000Z` |
| HQ's case API (`hqcase/api/updates.py::handle_case_update` → `::_submit_case_blocks` → `hqcase/utils.py::submit_case_blocks`) | `SubmissionPost` → `_create_new_xform` | the same |
| HQ's case importer (`case_importer/do_import.py`, `submit_case_blocks`) | the same | the same |

Executed during planning (the stored-spellings run, under "Executed during planning": cases saved
through HQ's receiver with `submit_case_blocks`): all twelve datetime spellings of one instant (`Z`,
`+05:30`, `-05`, `+05`, `+14`, `-05:00`, `+0530`, no fraction, six digits with an offset, naive) are
stored, in the case's `case_json` and in the index's `case_properties.value`, as
`2026-01-02T04:30:00.000000Z`; a date-only value is stored as written.

**How HQ compares.** `case_search/xpath_functions/comparison.py::property_comparison_query`:

- a custom property with `=` goes to `_create_query` → `es/case_search.py::case_property_query`, an
  exact term on `case_properties.value.exact`: text equality. `!=` is `filters.NOT` of it;
- a custom property with an ordering goes to `case_property_range_query`, which parses the value
  (`_parse_date_or_datetime`, Django's `parse_date`, then `parse_datetime`) and ranges
  `case_properties.value.date` through `es/filters.py::date_range` →
  `es/utils.py::es_format_datetime` (an aware value with microseconds is sent as naive UTC, since
  the index's formats hold no six-digit fraction with an offset): an instant comparison;
- a system date (`date_opened`, `last_modified`, `closed_on`; `const.py::INDEXED_METADATA_BY_KEY`,
  `is_datetime`) goes to `_create_system_datetime_query`: with a datetime value `=` is
  `filters.term(<field>, value)` with the raw string, which Elasticsearch must parse against the
  field's formats; an ordering is `filters.date_range` with the parsed value.

Executed (the same run): `dt = '2026-01-02T09:30:00.000+05'` finds none of the twelve cases that hold
that instant and `dt = '2026-01-02T04:30:00.000000Z'` finds all twelve; every ordering in every Core
spelling finds by instant; `date_opened = '2026-01-01T20:01:00Z'` finds its case; the bound
`2026-01-02T09:30:00.000000+05:30` is refused by Elasticsearch's parse (`parse_exception`, the
mapping's formats); a date-only bound on a datetime property compares the UTC day. The case search
index's date fields (`opened_on`, `modified_on`, `closed_on`, `case_properties.value.date`) carry
`corehq/pillows/core.py::DATE_FORMATS_STRING` (`es/mappings/case_search_mapping.py`; the list the
run's error prints), every pattern of which with a time requires seconds, so a minute-precision raw
term (`date_opened = '2026-01-02T09:30'`, the spelling the builder's date-and-time picker writes) is
a parse failure, and the search fails. That was read here and then observed with every reader on
`targeted-datetime-equality` (run 39078199859, "What the served readers showed", below): HQ's search
answers it with a 500.

**What Nova does today** (executed during planning, a local script over today's checker and
emitter): `lib/commcare/predicate/csqlEmitter.ts::emitComparisonSegments` emits every comparison as
`<anchor> <op> <operand>` with no regard to the anchor's type, and
`lib/commcare/predicate/termEmitter.ts::emitCsqlLiteralSegment` prints a literal as written. So
`seen = <datetime literal 2026-01-02T09:30>` (the builder's `LiteralValueInput.tsx`,
`datetime-local`), `seen = now()`, `seen = datetime('…Z')`, `in(seen, …)` and a runtime value all
reach HQ as text equality, and none can equal `…T04:30:00.000000Z`: HQ's `now()` and `datetime()`
return `isoformat()` (`value_functions.py::now`, `::datetime_`, `+00:00`, never `Z`), and a Core
value prints the device's offset with milliseconds. `needsBlankComparandGuard` guards no `eq`/`neq`
on a custom property. Preview compiles the same predicate in Postgres, where a `datetime` property
reads `(properties->>'seen')::timestamptz` (`lib/case-store/sql/dataTypeTokens.ts::POSTGRES_CAST_FOR_DATA_TYPE`)
and a naive literal is pinned to UTC (`compileLiteral`), so it compares instants and finds the case.
The device's case list filter compares text too (`org/javarosa/xpath/expr/XPathEqExpr.java::testEquality`:
neither side a `Boolean` or `Double`, so `FunctionUtils.toString` of both and `equals`), over the
restored spelling.

**Finding 75: a search or case list filter that asks for a date and time "equal to" a value finds
nothing on CommCare, and Preview finds the cases.** *Harm:* a worker's search for visits at a given
time finds none on HQ while Preview shows them; `!=` finds every case on HQ; on a system date a
minute-precision value makes the search fail; the device's case list filter, comparing text, shows
none of them either. *Reproduction (a targeted document):*
`proof/targeted/documents/datetimeEquality.ts`, id `targeted-datetime-equality`, rows `["75"]`,
explicit identities, app name "Visit times": case type `visit` with a `datetime` property `seen`;
a module "Visits" whose registration form "Log visit" writes `case_name` from a text question `name`
and `seen` from a Hidden Value `seen_at` whose calculate is `now()`, and whose follow-up form "Review
visit" holds one text question; "Visits" has Search effective, one visible text prompt on
`case_name`, and `caseListConfig.filter` = `eq(prop(visit, seen),
term(datetimeLiteral("2026-01-02T04:30:00")))`; a second module "Other visits" with the same prompt,
`neq` of the same, and its own "Review visit"; a third, "Opened visits", with Search effective, no
case list filter, and an advanced Search input whose predicate holds `eq(prop(visit, date_opened),
term(datetimeLiteral("2026-01-02T09:30")))`, and its own "Review visit".

Two choices keep the document's evidence on finding 75 alone:

- *"Log visit" writes through a Hidden Value, not a date and time question.* A Hidden Value with a
  `datetime` destination is typed by it (`lib/domain/fieldValueType.ts::fieldValueType`), so the
  emitter gives it the same `nova_datetime_seen_at` sibling a question would get
  (`lib/commcare/xform/builder.ts`, the `fieldValueType(…) === "datetime"` branch;
  `datetimeCaseValue.ts::datetimeCaseValueExpression`) and the case write is the same. A date and
  time question would meet finding 74 (no widget, Formplayer refuses the submission; part 08 §3.2),
  a step-4 stop on the document's walk that says nothing about equality.
- *"Opened visits" sits in an advanced Search input, not the case list filter.* In the case list
  filter the comparison is refused from pull request 8, the lowering, which brings the day rule
  (part 03 §3.2, part 04 §3.4: a casedb `date_opened` is a day on the device, reason
  `day-only-on-device`), so the document would stop being admitted there. In an advanced input's
  predicate only HQ's search and Postgres read it, no device evaluates it, and it stays admitted at
  every pull request of the stack.

The document's fixed restore (`restore.xml`, built with `proof/targeted/restore.ts::restoreXml` as
`datetimeOrdering.ts` builds one) holds three `visit` cases in HQ's stored spelling (above), the
values the executed run used: `targeted-visit-amina` (`seen` `2026-01-02T04:30:00.000000Z`,
`date_opened` `2026-01-01`), `targeted-visit-baraka` (`seen` `2026-01-02T05:30:00.000000Z`,
`date_opened` `2026-01-01`) and `targeted-visit-chidi` (no `seen`, `date_opened` `2026-01-02`; HQ's
restore writes `date_opened` as the day: `casexml/apps/case/xml/generator.py::date_to_xml_string`
returns `json_format_date` of `opened_on`). Its `intent` expectations are Core `evaluate` case-list
reads over that restore from the local archive: `equal-visits-listed-local` (session command `m0-f1`,
"Visits"'s "Review visit") expects Amina alone, and `other-visits-listed-local` (`m1-f0`) expects
Baraka then Chidi. "Opened visits" carries no `intent` expectation: no device reads its comparison.

Its native scenario (family `csql`, below) saves through HQ's receiver a case whose `seen` is
`2026-01-02T10:00:00.000+05:30`, one at another instant, and one opened at exactly
`2026-01-02T09:30:00Z`. Expected from the stored-spellings run and the reading above: HQ's search over
today's emission returns no case for "Visits", every case for "Other visits", and an error for
"Opened visits", where Postgres over the same rows returns the first case, the other two, and the
case opened at that instant. The error is Elasticsearch's, at search time: HQ's compiler accepts all
three queries (`csql@A` compiled `seen = '2026-01-02T04:30:00'`, `seen != '2026-01-02T04:30:00'` and
`date_opened = '2026-01-02T09:30'` in GitHub Actions run 39061011794), and the raw minute-precision
term then meets the index's date formats, which refuse it (run 39078199859, below).

**Decision.** From step 3, in a `query` position, a comparison `eq`, `neq` or `in` whose anchor
resolves to `datetime` emits as a closed instant range. The anchors
(`lib/domain/predicate/temporalType.ts::resolveCaseListTemporalType`):

- a custom property of effective type `datetime`, in both CSQL slots;
- `date_opened`, `last_modified` and `closed_on`, in `searchInputs[advanced].predicate` only. In
  `caseListConfig.filter`, whose targets include SU, an equality of `date_opened` or `last_modified`
  with a date and time is refused by the checker, against a day-aligned operand too (the day rule,
  part 03 §3.2; record slots answer `*_TYPE_ERROR`, reason `day-only-on-device`), and `closed_on` is
  unreadable there (§3.1).

| Arm | CSQL |
|---|---|
| `eq(p, v)` | `(p >= v and p <= v)` |
| `neq(p, v)` | `not(p >= v and p <= v)` |
| `in(p, v1, v2)` | `((p >= v1 and p <= v1) or (p >= v2 and p <= v2))` |

`v` is emitted twice by the ordinary value rules (§2.2: a literal as written, a native value function
natively, a runtime value through the quote cascade with its obligations); a runtime `v` also carries
`blank-comparand` (§5), since HQ's range raises on `''` (the REFUSED manifest entry
`case-search/date-opened-closed-on-or-last-modified-compared-with-any`, class `non-date-value`, which
the guard keeps every search away from). The comparison sits inside the row scope
`normalizeRelationEvaluationScopes` already gave it, so both bounds read the same related row
(`subcase-exists('x', seen >= v and seen <= v)`, `ancestor-exists(parent, …)`). A literal is not
rewritten: HQ's range parser reads every spelling the type checker admits, including the picker's
minute precision, which a raw term would refuse. Each range is a `CsqlNode` subtree printed by
`printCsql` (decision 16).

Why this and not the alternatives. *Refusing* the comparison would remove the builder's
date-and-time equality, which Preview and (after the lowering) the device can answer truthfully.
*Normalising the literal to HQ's stored spelling* (`%Y-%m-%dT%H:%M:%S.%fZ`) fixes a literal only: a
runtime value is printed by Core with the device's offset, and `now()`, `datetime()`, `datetime-add()`
are evaluated by HQ into `isoformat()`, so neither can be put in HQ's spelling; text equality would
also stay wrong for any value a non-receiver path stored (a date-only value in a datetime property).
The range is one rule over every operand.

**Executed: the closed range itself** (GitHub Actions run 39315022018, the gate run with the `csql`
family's `datetime-equality` scenario, `native/csql/csql-payload.evidence.json`). HQ at the pin answered
as the reading says: `(p >= v and p <= v)` finds exactly the three cases at the instant for `v` naive,
`Z`, `+05`, `+05:30`, minute precision, minute with `+05:30`, millisecond `Z`, millisecond naive, HQ's
stored spelling, `datetime("…+05")` and `datetime("…Z")`; one millisecond later it finds none;
`not(…)` finds the case at another instant, the case without the property and the opened case; `in`
as ORed ranges finds the three and the other instant; and the `date_opened` / `last_modified` ranges
with minute, `Z`, `+05` and millisecond bounds find the opened case alone, a millisecond later none.
Today's text equality found none (`!=` every case), and `date_opened = '…T09:30'` /
`last_modified = '…T09:30'` failed with Elasticsearch's 400. So Django's parse reads the picker's
minute-precision literal, and the emitter change was written.

**Implementation correction, 2026-10-19** (the emitter): `emitter.ts::readsInstantByRange` decides the
anchor by its typed data (`typeOf`, `datetime`): a custom property in every CSQL slot, and
`date_opened`, `last_modified` and `closed_on` where the slot's targets hold neither SU nor XF. `v` is
one value node printed in both bounds, so a runtime `v`'s quote obligation is deduplicated and the
clause takes the general guard, not the flat quote cascade; every runtime `v` carries
`blank-comparand`. `proof/native/test_csql_payload.py` holds every emitted query to the fixture's
expected ids (`EMITTER_WRITES_RANGES = True`), the pre-range `TODAY_EMITTED` table removed.

Resolution. Elasticsearch 6.8 indexes a date at millisecond resolution; HQ's stored text holds
microseconds that Nova's writer fills with `000`. Postgres compares at microseconds. A datetime
literal therefore admits at most three fraction digits (`datetime-literal-precision`, a type-checker
finding in every slot: "Choose a time to the millisecond or coarser. CommCare compares dates and
times to the millisecond."; part 03 §3.10's, landing in pull request 6, the checker), so a literal
names one millisecond in both. A runtime value carries at most Core's milliseconds. Production holds
no typed datetime literal in any slot of any live app, so the finding refuses no stored document.

**Postgres and Preview.** Equality of two datetimes compiles as instant equality (part 07 §5.3;
`compilePredicate.ts::compileOrderedComparison` already compares instants). `neq` on a `datetime`
anchor is two-valued by part 07 §5.5's rule, `not coalesce(p = v, false)`, so a case without the
property matches as HQ's `NOT` and the device's `'' != v` both make it match.

**Device.** The case list filter's on-device form is the lowering's (part 04 §3.3): `=`, `!=`, `in`
and `switch` between two `datetime` operands lower to instant equality with finding 56's zone-free
instant wherever orderings lower, form logic included. Core compares two strings by text
(`XPathEqExpr.java::testEquality`), and a casedb or results row holds HQ's `…T04:30:00.000000Z`, which
a Nova literal, a form answer or `now()` never spells, so without the lowering the device's case list
for `seen = <v>` is empty where Preview and, from this section, HQ's search are not. Part 04 §3.2's
instant text gives each of the thirteen offset spellings its native run proved one instant value, so
equality is the same arithmetic as ordering, `instant(a) = instant(b)`, over integer microseconds
(part 04 §3.1, `instantMicros`). Core compares two `Double`s as equal when `Math.abs(fa - fb) <
1.0e-12` (`XPathEqExpr.java::testEquality`), so two instants are equal exactly when their
microseconds are (part 04 §3.3). So the device, HQ and Preview agree.

**Checker, builder, record dialect.** No new admission; `datetime-literal-precision` is new (pull
request 6), and the system-date equality of the day rule is refused in device-evaluated slots. The
builder's picker writes minutes, which pass. The record dialect is unchanged.

**Register.** The device half is the lane's: `targeted-datetime-equality`'s `intent` case-list
expectations differ on today's emission. So is the search error on a system date: the served
readers meet HQ's 500 for "Opened visits", which stops Formplayer's walk and differs between the
states proofs 3 and 4 compare (below).

*What the run showed* (GitHub Actions run 39061011794, the lane without readers on a scratch branch
holding the document). The scratch document is the one above with two differences: "Log visit" wrote
`seen` from a date and time question, and the third module ("Opened at") held the `date_opened`
comparison in its case list filter with a third `intent` read (`opened-at-listed-local`, `m2-f0`,
expecting Chidi). On today's emission the document was admitted, its archives were emitted
(`local.ccz`, `local-again.ccz`, `local-empty-list-text.ccz`, `import-file.zip`), its control was
retained, and its group `corpus:targeted-datetime-equality` held: bar, manifest and proofs 1 to 3
found no difference, proof 4's 110 differences (an HQ editor save turning on each module's search
`auto_launch`, and the session traces and case blocks that follow from it) and sensitivity's 6 (the
`sync_cases_on_form_entry` claim post) failed no check, and its stops check held with every stop left
to the run with readers. The intent check found four differences, the same on document and control
(each `kind` `changed`, path `/caseList/rows/*/caseId`):

| Artifact | Pointer | Expected (Nova's meaning) | Core on today's emission |
|---|---|---|---|
| `evaluate:equal-visits-listed-local@local` | `/caseList/rows/0/caseId` | `targeted-visit-amina` | absent ("Core's result holds nothing at this pointer.") |
| `evaluate:other-visits-listed-local@local` | `/caseList/rows/0/caseId` | `targeted-visit-baraka` | `targeted-visit-amina` |
| `evaluate:other-visits-listed-local@local` | `/caseList/rows/1/caseId` | `targeted-visit-chidi` | `targeted-visit-baraka` |
| `evaluate:opened-at-listed-local@local` | `/caseList/rows/0/caseId` | `targeted-visit-chidi` | absent |

So Core's text equality lists no visit in "Visits" and every visit, Amina first, in "Other visits",
as the reading above predicts. The fourth row is the scratch document's own third module; the plan's
"Opened visits" has no case list filter and no `intent` read, so no entry is registered for it. The
group failing in the run is `targeted-datetime-operands`'s manifest classes, part 08's, not this
document.

*What the served readers showed* (GitHub Actions run 39078199859, every served reader, on the
scratch branch `proof/plan-step3-operands` at `1a6ccfa9`: `main`, issue 768's fix and the two new
documents as this plan writes them; `mechanics` `navigation-conditions,targeted-datetime-equality,targeted-datetime-ordering`).
On the plan's document and its control the intent check shows exactly the differences of the two
entries below, and no walk meets finding 74's stop. The served readers show the device half too:
on the Web Apps client and on Android the "Visits" list holds none of the lane's cases, though one
holds the filter's instant, and "Other visits" holds all four; HQ's own search for each agrees.
Proof 3 compares the readers with each other, and all are wrong alike, so no check reports it and
no entry is needed beside the `intent` entries. "Opened visits" is new: its search sends
`_xpath_query` `date_opened = '2026-01-02T09:30'`, the minute-precision literal as written, and HQ's
case search answers 500, an `ESError` around Elasticsearch's `RequestError(400)`, "failed to parse
date field [2026-01-02T09:30] with format [yyyy-MM-dd||…'T'HH:mm:ss…]". Formplayer's walk stops
there with `notification:n-internal-server-error` on 8 runs across all four states (`minimum` and
`maximum`, A and B), on document and control; the Web Apps client shows HQ's error alert and Android
"Server-side error (code 500)". From that one error the gate showed differences no entry holds:
proof 3, 8 in 2 classes, the HQ error record on `formplayer@A`
(`/hq/app_aware_remote_search/500/corehq.apps.es.exceptions.ESError`, kind `error`, 4) and
Formplayer's response on the local archive (`formplayer@local.ccz`,
`/runs/*/steps/*/response/exception`, `changed`, 4); proof 4, 12 in 4 classes, Formplayer's
response after HQ's App Settings save (`formplayer@app settings@B@maximum` and `@minimum`, 2 each)
and after its Case List save (`formplayer@case list@B@maximum` and `@minimum`, 4 each), each at
`/runs/*/steps/*/response/exception`, `changed`: the text of HQ's 500 page differs between the two
states each compares. The other differences of proof 4 (HQ's Case List save turning on the search's
`auto_launch`, and what follows from it) are held by the base's entries. So pull request 1 holds the
HQ half's search error on the document: a walk stop, and live entries for the four classes.

*What pull request 1, the lane mechanics, carries* beside the document (part 08 §7):

1. its control, retained before any fix, from the corpus emitted on the host at that pull request's
   head, for every check an entry of it names:
   `python3 -m proof.checks.controls <corpus> targeted-datetime-equality intent,proof3,proof4`;
2. two live entries in `proof/known-defects.json` for the device half, each defect 75, part
   "datetime equality", check `intent`, path `/caseList/rows/*/caseId`, kind `changed`, document and
   control `targeted-datetime-equality`, as the run's register held them:
   - `d75-datetime-equality-case-list`, artifact `evaluate:equal-visits-listed-*`, values
     `{"before": "targeted-visit-amina", "after": {"absent": "Core's result holds nothing at this
     pointer."}}`;
   - `d75-datetime-inequality-case-list`, artifact `evaluate:other-visits-listed-*`, with no
     `values` pin, because its two differences carry different values (the table's second and third
     rows) and one pin cannot name both;

   inserted after finding 56's entries, as the run's register inserted them. Together they hold
   every `intent` difference the plan's document shows, which no other entry holds on it;
3. four live entries for the search error, inserted after those two, each defect 75, part "search
   on a system date", document and control `targeted-datetime-equality`, no `values` (HQ's 500 page
   is not one value), holding exactly the run's four classes:

   | Entry | Check | Artifact | Path | Kind |
   |---|---|---|---|---|
   | `d75-system-date-search-formplayer-a-app-aware-remote-search-500-eserror` | `proof3` | `formplayer@A` | `/hq/app_aware_remote_search/500/corehq.apps.es.exceptions.ESError` | `error` |
   | `d75-system-date-search-formplayer-local-runs-steps-response-exception` | `proof3` | `formplayer@local.ccz` | `/runs/*/steps/*/response/exception` | `changed` |
   | `d75-system-date-search-formplayer-app-settings-runs-steps-response-exception` | `proof4` | `formplayer@app settings@*` | `/runs/*/steps/*/response/exception` | `changed` |
   | `d75-system-date-search-formplayer-case-list-runs-steps-response-exception` | `proof4` | `formplayer@case list@*` | `/runs/*/steps/*/response/exception` | `changed` |

   Each is a served reader's, so the pull request lane leaves it to the run with every reader;
4. one walk stop in `proof/walk-stops.json`, the document's (`proof/README.md`, "Walk stops"; a
   `document` entry also holds the control of the same name, which shows the same stop):
   `{"document": "targeted-datetime-equality", "reader": "formplayer", "cause":
   "notification:n-internal-server-error", "reason": "HQ's case search answers the Opened visits
   search with a 500: its date_opened equality reaches Elasticsearch as a raw minute-precision term
   (case_search/xpath_functions/comparison.py::_create_system_datetime_query), which the index's date
   formats refuse, each with a time requiring seconds (corehq/pillows/core.py::DATE_FORMATS_STRING;
   finding 75), so Formplayer answers with its internal-server-error notification on every state."}`.
   A worker at that screen cannot get past it: every way the walk sends the search carries the
   advanced input's predicate;
5. `proof/checks/registers.py::OPEN_DEFECTS` gains `75: 3`;
6. finding 75 in `docs/research/2026-09-26-hq-round-trip/harness-findings.md` (below) and its row in
   `proof/README.md`, "The defect rows".

No walk meets finding 74: "Log visit" asks no date and time question, and run 39078199859 showed
none. For "Visits" and "Other visits" an empty or longer list is no stop.

Pull request 8, the lowering, which lowers device equality, moves the device half's two entries
unchanged to `proof/fixed-defects.json` (`document` dropped), where they keep showing on the
control; the pull request lane holds the move without a reader, as it does finding 56's (the intent
check runs Core, no served reader). The four search entries and the stop stay, and so does `75: 3`,
because HQ's search still meets the raw term.

Pull request 10, CSQL, fixes the search error: the equality becomes the closed range
`(date_opened >= '2026-01-02T09:30' and date_opened <= '2026-01-02T09:30')`, which HQ's range query
parses (`filters.date_range`) rather than sending as a raw term. In the same pull request the four
entries move unchanged to `proof/fixed-defects.json`, held on the control, which keeps the pre-fix
upload bodies and archives and so keeps meeting the 500; the stop's entry becomes
`{"control": "targeted-datetime-equality", …}` with reader and cause unchanged and a reason saying
the control keeps the pre-fix search, so the control keeps showing it while the document's walks
reach their end; and `OPEN_DEFECTS` loses `75: 3`. The move is a served reader's, so the pull
request lane leaves it to the run with every reader: pull request 10's reader dispatch, started by
the person on GitHub's runners (`gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f
mechanics=targeted-datetime-equality,navigation-conditions`), or the first night after the merge.

The text-equality half no lane check compares. `csql@A` (`proof/checks/intent.py::search_compiles`)
is a refusal check, and it compiled all three queries (`seen = '2026-01-02T04:30:00'`,
`seen != '2026-01-02T04:30:00'`, `date_opened = '2026-01-02T09:30'`, each `compiled: true` over case
type `visit`, the `csql` records of run 39061011794's stored observations); what HQ's search finds
for "Visits" and "Other visits" is the same on every state and reader, so proofs 3 and 4 see no
difference. So that half is held by the `csql` family's `datetime-equality` scenario, which lands
with this part's emitter change in pull request 10, CSQL, fails on today's emitter and passes on the
fix.

**Harness findings.** Pull request 1, the lane mechanics, adds finding 75 to
`docs/research/2026-09-26-hq-round-trip/harness-findings.md` under a new "Found while planning step 3"
heading, in the form of finding 74: the shape, HQ's text equality at `case_property_query`, the
receiver's rewrite, the raw term on a system date and the 500 it meets, the device's text equality,
the harm, and the document `targeted-datetime-equality`. Pull request 8, the lowering, records the device half fixed; pull
request 10, CSQL, records the finding fixed and names the `csql` family's scenario.

**Changes at the next publish.** A search whose effective `_xpath_query` holds such a comparison
changes bytes once. Production holds none: no `_xpath_query` of a live app holds `eq`, `neq` or `in`
on a `datetime` anchor, and no case list filter or advanced predicate holds one, with Search
effective or not, so neither the CSQL bytes nor the device lowering of such a filter moves for any
app. The reason stays for documents edited before the window: the cutover's notice pass writes one
document entry per module, reason `search-date-time-equality-matches` (entity `module`, after
`search-today-is-workers-day`): "From the next publish, the search in <module> finds cases whose date
and time matches the one it names. Until now CommCare's search found none of them, though Preview
did." The dry run reports the count (§10).

**Proofs.** Family `csql`, scenario `datetime-equality`: cases saved through HQ's receiver with
`seen` in the `+05:30`, `-05` and `Z` spellings of one instant, one other instant and one without
`seen`; `eq` with a naive literal, a `Z` literal, a minute literal, `now()`-free runtime values in a
`+05` and a `Z` spelling, `neq`, `in`, and `date_opened` / `last_modified` equality with a minute
literal in an advanced predicate; HQ's search returns the fixture's expected ids, and
`csqlComposition.postgres.test.ts` returns the same. The lane: from pull request 10,
`targeted-datetime-equality` passes proofs 1 to 5 with no entry and every walk reaching its end, and
its control shows finding 75's six fixed entries and holds its one stop.

---

## 4. Preview and Postgres: the fold

Preview evaluates what the device evaluates. For a CSQL slot:

1. Client-side, Preview composes the same emission (`composeXPathQueryEmission`, as
   `searchInputRuntimeQuoteErrors` does today) and evaluates, with Preview's XPath evaluator over the
   search answers, the session at the module's case list step (context, user data, and the datums
   supplied before it, among them a chosen case's id: part 05 §1.8, and §3.9 above), the device casedb
   snapshot (a chosen case's properties) and the lookup and location instances: each runtime
   segment's value XPath, each runtime choice's condition, and each obligation.
2. It sends the results as plain JSON (`{ segments: Record<segmentKey, string>, choices:
   Record<segmentKey, boolean> }`; plain objects only, since a `Map`, `Set` or `File` argument makes
   React encode a Server Action's arguments as multipart) with the search answers.
3. The server action applies `lib/commcare/csql/fold.ts::foldCsqlRuntime`: each runtime subtree
   becomes a literal of its node's type (a `selected*` runtime value becomes its tokens), each runtime
   choice its chosen branch, and each row whose obligation holds `match-none` (today's
   `searchFindsNothing`, now for every kind).
4. `lib/case-store/sql` compiles the folded expression, which holds only server-side arms: no runtime
   leaf reaches the compiler, so `TermBindings.sessionContext` and the search-input binding of
   `lib/preview/engine/runtimeBindings.ts::bindSearchInputValuesInPredicate` leave the CSQL path.

A chosen-case read in a browse list's `caseListConfig.filter` (no effective Search) is no runtime
segment, so nothing folds it: Postgres compiles it with the chosen case's id bound and its property
read from that case's row (part 07 §5.1).

Values arrive as bound parameters, never interpolated (`lib/case-store/CLAUDE.md`). Compiler additions:
`closed_on` (§3.1), epoch casts (§3.5), `value-list` (§3.6), the nine units (§3.8), the row-reading
`if` (§3.10); every atom compiles two-valued by part 07 §5.5, and datetime equality by instant by
part 07 §5.3 (§3.13). Part 07 owns the transport, the evaluator's instances and which cases the
search reads (§3.9); this part fixes what is folded and by whose print.

**Implementation correction, 2026-10-19** (the fold, pull request 10):

- `fold.ts::foldCsqlRuntime(expression, values, { types })` takes the row's slot context beside the
  values, since it prepares the clause as the emitter does (`prepareCsqlClause`) and types each
  literal by its node (`typeOf`: a number for a numeric node whose text is one, a typed date, date
  and time or time where the text has that shape, text otherwise). `CsqlRuntimeValues` is
  `{ segments, choices, rejected? }` for one row; a key it lacks leaves its node unfolded.
  `csqlRuntimeReads(tree)` lists what the device evaluates in a row (a segment inside a choice's
  branch included; a `when-input-present` is the choice `count(<input>)`), and `csqlRuntimeRow`
  adds the row's obligations. A runtime `selected*` value with no token is `match-none`; a node-set
  list item splits on `","`, as the device splices it, and one that reads no node is the one blank
  item `[""]` the device sends.
- The wire is one `{ segments, choices }` for the whole search, keyed `<row>:<segment key>`, the row
  its index among `composeXPathQueryClauses`' clauses; a row whose obligations hold is the choice
  `<row>`, its own choice of `match-none()`. The rows Preview folds are the case list filter's and
  the advanced inputs' (`lib/preview/engine/searchCsqlRuntime.ts`, composed without the simple-arm
  derivation): a simple input's answer reaches Postgres as the literal it binds
  (`runtimeBindings.ts::composeRuntimeFilter`), so nothing of it is left to fold. A rejected row
  makes the Results read `empty`, except that the first obligation that holds with no prompt and a
  worker message (every kind but `blank-comparand` and `list-item`) travels as the wire's
  `refusal`, and the read is then `invalid-search` with that kind's global message, as the server's
  own pass answers one it judges itself.
- Every obligation is judged as the emitter wrote it, its guards and its own reads included: the
  `list-item` pattern joins the fixed Java patterns Preview's synchronous evaluator runs
  (`generatedJavaRosaFunctions.ts`, checked against the compiled OpenJDK runtime). Preview also
  evaluates each row's whole wrapper, untaken branches left alone as Core leaves them.
- `evaluateSearchCsqlRuntime` is asynchronous: a piece the synchronous evaluator can't run (a
  pattern the author wrote, encryption) runs in the Search screen's XPath worker over the same
  instances (`engineController.ts::evaluateSearchScreenXPath`). Only where the worker can't either
  does the wire carry `unevaluated`, and the Results read answers `invalid-search` saying Preview
  can't work out the search, never a list without that row. App Tests' server reads hold no Java
  Pattern engine, so there such a piece is `unevaluated`, and `serverRecordsRead` answers the
  same refusal (an App Test step's Results, a form check's search). No worker request carries an
  abort signal: cancelling one terminates the worker and every other request on it, so a
  superseded evaluation stops sending pieces and its result is dropped.
- The values are worked out once per submission, as a device evaluates the request when it sends
  it and keeps it for the query step (`useSubmittedSearchDeviceValues`), once the device's cases
  have loaded and no lookup is still loading; Results wait for them. A search-first module keeps
  them on its search (`PreviewSearchState.deviceValues`, the first value for an attempt standing),
  so its forms' snapshot reads the same value and a claim posted mid-entry reads nothing again; a
  search action keeps them per Search press.
- The server composes the rows with the lookup naming of its own definitions snapshot, as the
  browser composes them with `world.lookup.naming`, so a lookup value folds to the literal of its
  column's type on both sides.
- A read keyed by case ids (the case the no-matches form registered) applies neither the search's
  checks nor its rows: the device shows that case by its id. A row that still holds a read of what
  only the device holds (its cases, chosen cases, places, a projection other than the chosen
  case's property) because no value arrived for it answers the same `invalid-search` refusal
  rather than reach the compiler.
- The server's pass of a search's obligations judges only those whose reads it holds (answers and
  the session context); one reading the device's cases, places, a lookup or a session datum is the
  browser's, through the row it reports. App Tests evaluate the same values on the server over the
  session's device (`serverSearchRead.ts`).

---

## 5. Obligations and worker messages

`RuntimeCsqlRejectionKind` from step 3:

| Kind | Raised by | Condition | Worker message (prompt / computed) |
|---|---|---|---|
| `quote` | quoted runtime strings | today's | today's |
| `whole-number` | calendar `date-add` quantity, runtime `date` epoch | today's | today's |
| `nonnegative-whole-number` | `subcase-count` bound | today's | today's |
| `geopoint` | runtime center | today's | today's |
| `blank-comparand` | system dates, orderings, runtime `selected*` values, a runtime value in a `datetime` equality's range (§3.13) | today's | none: the search finds nothing |
| `decimal-number` (new) | runtime `datetime` epoch | `not(number(x) = number(x)) or contains(string(number(x)), 'E')` | "Enter a number" / "This search's current value needs to be a number" |
| `positive-number` (new) | runtime radius | `not(number(d) > 0)` | §3.8 |
| `distance-unit` (new) | runtime unit | not one of the nine | §3.8 |
| `list-item` (new) | runtime `value-list` item | §3.6 | none: the search finds nothing (no step-3 prompt reaches one) |

`lib/domain/searchRuntimeValidationMessages.ts::searchRuntimeValidationKinds` gains the three with
messages; their strings join the app's translation inventory as the existing four do. One sentinel
and one scope stay: every obligation answers the whole row `'match-none()'`
(`wrapClause`), and `dedupeRuntimeRejections` keys them as today.

**Implementation correction, 2026-10-19** (the emitter): the obligations as written. `decimal-number`
is `not(number(x) = number(x)) or contains(string(number(x)), 'E')` over the raw read, spliced
unquoted as `number(x)`; `whole-number` for a runtime `date` epoch is the calendar quantity's
`not(number(x) = floor(number(x)))`. `positive-number` is `not(number(d) > 0)` and `distance-unit`
`not(u = 'miles' or … or u = 'nauticalmiles')`, each on its own value between fixed double quotes,
blaming the prompts whose bytes reach it. `list-item` is `regex(v, '["\\\p{Cntrl}]') or contains(v,
"'")`, and for a node-set item whose wire tree is a path, `count(<path>[regex(., …) or contains(.,
"'")]) > 0` with the item printed `join('","', <path>)`. A choice's obligations travel out as
`<condition> and (…)` for the branch it takes and `not(<condition>) and (…)` for the other; a runtime
`selected-any`/`selected-all` call carries its own `blank-comparand` guard; `today()` is never
blank, so no guard reads it. `lib/commcare/csql/__tests__/obligations.test.ts` evaluates each with
Preview's evaluator over fixed answers.

---

## 6. Scope: authored in step 3 or held

Every entry id below is `case-search/<id>` in `lib/commcare/surface/entries/case-search.json`.

| Construct | Builder, SA, MCP author it | Held (union, checker, emission, Postgres, native proof) | Manifest entry |
|---|---|---|---|
| `closed_on` | yes, server-only slots | yes | `metadata-closed-on`: HELD |
| `@case_type` terms | yes | yes | `authored-case-type-comparisons-other-than-a-hop-qualifier`: HELD |
| project-timezone day | no | no (step 6) | `date-only-comparison-on-date-opened-closed-on-last-modified`: stays HELD-NEW, owned by step 6 |
| `today()` as the worker's day | (emission change) | yes | `double-v-today-now`: HELD today, unchanged |
| epoch coercions | yes | yes | `date-int-datetime-number-epoch-days`: HELD |
| `unwrap-list` | no, in no step (§3.6) | yes | `unwrap-list`: HELD |
| runtime `selected*` values | yes (single-choice on device) | yes | `selected-with-a-runtime-assembled-v`: HELD |
| nine units | yes | yes | `within-distance-in-yards-feet-inch-meters-centimeters`: HELD |
| runtime radius and unit | yes | yes | `within-distance-with-a-runtime-radius-or-unit`: HELD |
| the four session context values step 3 authors, and worker values | yes | yes | no `case-search` entry of their own: they are today's CSQL runtime values |
| session context `drift`, `window_width`, `applanguage` in CSQL values | no (step 4) | parsed and stored (part 01 §1.6); not offered | `runtime-values-read-from-the-session-context-drift-window-width`: stays HELD-NEW, owned by step 4 (the entry names only those three, so it is not a flip for the four step 3 authors) |
| the chosen case, its id and its properties, in the case list filter and CSQL runtime segments (§3.9) | yes | yes | `runtime-values-read-from-casedb-or-session-datums`: HELD (the entry's case and datum terms are this row and the next) |
| other casedb, lookup-row, location reads in runtime segments | no, in no step (§3.9) | yes | the same entry |
| runtime choice | yes | yes | `clause-chosen-at-runtime-by-a-condition-over-session-worker`: HELD |
| several rows | no | no (step 6) | `several-xpath-query-rows`: stays HELD-NEW |
| flag-free ancestor case id | (emission change) | yes | none (the shape is HQ's ordinary ancestor comparison) |
| `datetime` equality as an instant range (§3.13, finding 75) | (emission change; `datetime-literal-precision` new) | yes | none (the shape is HQ's ordinary comparison); `date-opened-closed-on-or-last-modified-compared-with-any` stays REFUSED, and the range's `blank-comparand` guard keeps a runtime value from reaching it |

A flip edits `lib/commcare/surface/entries/case-search.json` (`disposition`, `dispositionCell`) in the
pull request that makes the construct emittable; the manifest-usage check counts HELD and HELD-NEW
alike as allowed (`proof/checks/manifest_usage.py::_standing_plan`), so no lane run moves. The usage
record already carries the keys these entries name: `proof/checks/manifest_usage.py::csql_keys`
records `csql-metadata:<name>` for every step naming a member of the `csql-metadata` family
(`closed_on` among them) and `csql-unit:<unit>` through `CSQL_FAMILIES`, so pull request 10 adds no
recording. The table's nine flips (every row whose entry moves from HELD-NEW to HELD) land in pull
request 10, which makes every construct here emittable.

---

## 7. SA and MCP

- `lib/agent/authoring/queryExpressions.ts`: `selected-any`/`selected-all` values and
  `within-distance`'s distance and unit admit values; `if`/`switch` produce conditions; `record-type()`
  joins the terms; `#case/closed_on` parses as any property; `chosen-case('<menu name>')` and
  `chosen-case-property('<menu name>', '<property>')` parse in the case list filter and the Search
  slots, resolved to module identity (part 02 §2.2). The record dialect has no list spelling, and
  no spelling for a raw casedb, lookup-row or location read or for the other four datum kinds
  (§3.6, §3.9).
- `lib/agent/authoring/printQueryExpression.ts::queryPrinter` prints each widened arm by the same
  call shape, so read-back is unchanged for every stored expression.
- `lib/agent/authoring/reference.ts` (the record-filter and Search paragraphs) teaches, one clause
  each: Date closed in Search rules, `record-type()`, `if(…)` between conditions, a value as a distance
  or a selected value, that today is the worker's day, and the case chosen in an earlier menu
  (`chosen-case`, `chosen-case-property`, part 02 §3.1). These sentences land in pull request 10,
  CSQL, the pull request whose behavior they teach, not in pull request 12, the authoring.
- Served schemas. Families keep their names, and the parse and print widening above changes no
  served schema byte: the record dialect is text inside the same schema positions. Pull request 10
  runs part 02 §3.6's per-tool hash (every shared tool's
  `authoringToolSchema(name, schema).inputSchema.jsonSchema`) at its base and head and records in its
  description that no hash moved. `lib/models.ts::MODEL_CONTEXT_VERSION` moves in each pull request
  that changes a served schema or model-facing prose (pull requests 3, 5, 9, 10 and 12; part 02
  §3.3): the `reference.ts` sentences move it in pull request 10 to
  `"v4-hq-round-trip-expressions.10"`, which also covers any CSQL tool description its hash run shows
  moved. A tool whose hash moves is registered in `scripts/test-schema.ts` by the pull request that
  moves it, and the one billed `npm run test:schema` question is asked at the stack head (part 02
  §3.7), never run by this part. `lib/mcp/__tests__/servedSchemas.test.ts` stays in CI as the compile
  check it is.
- The `../nova-plugin` sweep looks for the claims "miles or kilometers" and "Search compares a case
  property" in its skills.
- Refusals reach the SA and MCP as `AuthoringInputError` or the gate's finding, with §3's copy.

**Implementation correction, 2026-10-19 (pull request 10, the record dialect):**

- `MODEL_CONTEXT_VERSION` is not bumped here (decision 19 and the bullet above): the stack deploys
  once, and pull request 12 sets the value it deploys, which retires every model context made
  before it, as part 02's pull request 9 correction records. The served schemas and descriptions are
  unchanged: the widening is text inside the same schema positions.
- A value in `within-distance`'s distance is any argument but a number written as one; a value in its
  unit is any argument but quoted text, which must be one of the nine units or an alias of one
  (`km`, `kilometer`, `mi`, `mile`), else `AuthoringInputError` "CommCare doesn't measure distance in
  {name}. Use one of miles, yards, feet, inch, kilometers, meters, centimeters, millimeters,
  nauticalmiles." A `selected-any` / `selected-all` value is a literal when `literal()` reads it as one
  (quoted text, a number, `true()`, `null()`, `literal(…)`, a `concat` of quoted text) and a value
  otherwise. A quoted name compared with `record-type()` parses to a `case-type` leaf only when it is
  a valid case-type name; `literal('…')` there, and every value of `in(record-type(), …)`, stays a
  literal (decision D5). The printer keeps each round trip: a stored text literal opposite
  `record-type()` prints as `literal('…')`, and a computed unit that is text naming no unit prints as
  `literal('…')`.
- The held arms (`value-list`, and `cases`, `table-rows`, `locations`, `selected-cases` and any
  `project` but the chosen case's) have no record spelling, and `queryPrinter` refuses to print them
  rather than print a spelling the parser cannot read back. No step-3 surface stores one, so no
  read meets the refusal in step 3; step 6, which imports them, decides how a read presents them.
- One recognizer serves the record printer, the checker and Postgres:
  `lib/domain/expression/chosenCase.ts` (`chosenCaseId`, `chosenCaseProperty`,
  `readChosenCaseProperty`), so each reads exactly the shape the parser builds.

**Implementation correction, 2026-10-19 (pull request 10, Postgres):** a runtime radius or unit
reaches Postgres unfolded where no fold runs: a browse list's filter (Search not effective) may read a
worker value as the distance or the unit. So `compilePredicate.ts::compileWithinDistance` compiles a
runtime radius as Core's `number()` of plain decimal text kept only above zero, and a runtime unit as
a `CASE` over the nine names (`METERS_PER_DISTANCE_UNIT`), as part 07 §5.1 states; a CSQL slot still
arrives with both folded to literals. `TermBindings.chosenCaseIds` is a plain object (module UUID to
case id), the shape the Results read carries; a `value-list` item must be decided before the query
runs (a literal or a bound value), as the fold leaves it.

---

## 8. Proofs

**New native family `csql`** (registered in `proof/native/families.py::FAMILIES`):

- fixture `lib/commcare/__tests__/csqlCompositionFixture.ts`: one document per §3 block, each with its
  search answers, session values, datums (the chosen household of §3.9's `chosen-case` scenario
  among them), cases (ids, types, properties, open or closed, indices, geopoints) and, per
  scenario, the expected matching case ids;
- producer `proof/native/producers/emit-csql-evidence.ts` (the HQ JSON and the local suite, as
  `emit-function-evidence.ts`);
- Core class `proof/native/core/CsqlCompositionRuntimeTest.java`: Core builds each query from both
  suites under each scenario's session, in two JVM zones for §3.4 and §3.10;
- HQ check `proof/native/test_csql_payload.py`: HQ's compiler in a case-search context
  (`proof/hq/operations.py::compile_case_search`) under configurations with and without
  `CASE_SEARCH_RELATED_LOOKUPS` and with the domain's `default_timezone` set; for each scenario the
  filter compiles, and HQ's case search over the fixture's cases, written by HQ's case processing into
  the unit's Elasticsearch (`proof/hq/elasticsearch.py`), returns the expected ids.

The existing families keep their payloads: `function` and `navigation`
(`proof/native/test_search_payload.py`) change only where `today()` or a `datetime` equality appears,
and `quote` and `static-quote` not at all.

The family's HQ check saves each scenario's cases through HQ's receiver
(`hqcase/utils.py::submit_case_blocks`, as the stored-spellings run during planning did), so every
stored datetime is HQ's own spelling and the `datetime-equality` scenario (§3.13) tests what a
worker's search meets.

**Preview agreement.** `lib/case-store/sql/__tests__/csqlComposition.postgres.test.ts` seeds the same
fixture's cases into the local Postgres, folds each scenario with its runtime values and asserts the
expected ids: the same ids HQ's search returned. The fixture is the one statement of meaning both
sides answer to.

**Lane.** A targeted document `proof/targeted/documents/csqlComposition.ts`
(`targeted-csql-composition`) holds one search per authorable construct, so proof 3's sessions send
its CSQL and `csql@A` (`proof/checks/intent.py::search_compiles`) compiles each under every
configuration; the expected count of differences is zero, including the configuration without the
flag for §3.12. Among them is the chosen case (part 08 §2.6): a "Visits" menu whose entry passes
through a "Households" case list, its search narrowed by the chosen household in the flag-free
ancestor spelling (§3.12) and by `chosen-case-property('Households', 'village')`, and its case list
filter reading the chosen household's property, so bar, proofs 1 to 5 and every walk hold the
datum read in the suite, in HQ JSON's short filter and in the remote request; and a "Members" child
module nested in a root, case-first "Households" menu, with parent-select Households, whose case list
filter reads the chosen household, so HQ's build renames the short filter's `parent_id` to the
root's `case_id` through root alignment and proof 3 compares that nodeset with the local suite's. `csql@A` stays a refusal check; meaning is the native family's. The
`csql-metadata:closed_on` and `csql-unit:<unit>` items appear in the usage record (already recorded,
§6) and are held. A second targeted document, `targeted-datetime-equality` (§3.13), lands in pull
request 1, the lane mechanics, with its retained control, its six live entries under defect 75 (the
device half's `d75-datetime-equality-case-list` and `d75-datetime-inequality-case-list`, and the four
`d75-system-date-search-…` entries of "Opened visits"' search error) and that error's walk stop;
pull request 8, the lowering, moves the first two to `fixed-defects.json`, and pull request 10 moves
the four and turns the stop into its control's. `csqlComposition.ts` lands in pull request 10. Both
documents are written with explicit identities and admitted through the production gates at every
pull request of the stack.

**Finding 56.** Its register entries are part 04's and part 08's (pull request 8); §3.10's zone run is
this part's contribution to the seventh requirement inside CSQL runtime segments.

**Finding 75.** Its device half is the lane's (two entries, §3.13), and so is its HQ half's search
error on a system date (four entries and a walk stop, seen by the served readers); its HQ half's text
equality is the `csql` family's `datetime-equality` scenario, in pull request 10.

---

## 9. Nova tests

| Test | Boundary | Failure it distinguishes |
|---|---|---|
| `lib/commcare/csql/__tests__/positions.test.ts` | pure: positions of a table of expressions | a native value function placed in a raw argument; a runtime choice's condition not `runtime` |
| `lib/commcare/csql/__tests__/representability.test.ts` | pure: each new finding and its absence | `closed_on` admitted in the case list filter; a single-choice runtime value refused on device |
| `lib/commcare/csql/__tests__/fold.test.ts` | pure: folded expression per scenario | a runtime value left for the compiler; the unchosen branch kept; a chosen case's id or property left unfolded |
| `lib/commcare/csql/__tests__/ancestorCaseId.test.ts` (new) | pure: the emitter's `CsqlNode` tree and `collectRelatedCaseQueries` for `exists(ancestor …, where: eq(prop case_id, v))`, `v` a chosen case's id, a `case-index`, a literal and a worker field, and its `neq` | the flag-free form written for a literal, a worker field or `!=`; `ancestor-exists`, and with it the flag, kept for a chosen case |
| the checker's entry-supply cases (part 03 §9, part 05 §5), extended | pure, over built documents | a case list filter or a search reading a household chosen before the module refused; the same read admitted after a move takes "Households" away, or when it reads the module's own case, a several-case menu's case, or a datum that another entry reaching the case list prints under another id (each must be `SESSION_DATUM_NOT_SUPPLIED`, carrier `case-list` or `search`, reason `differs` for the other id and `not-before` for the rest) |
| `lib/commcare/csql/__tests__/obligations.test.ts` | the emitter's `runtimeRejections` against the Preview evaluator on fixed values | a branch's obligation rejecting a search whose branch was not chosen |
| `csqlComposition.postgres.test.ts` | real Postgres | `closed_on` lost by `not`; a unit factor wrong |
| `lib/agent/authoring/__tests__/queryExpressions.test.ts` (extended) | parse and print round trip | a widened argument printed differently from how it parses |
| one Playwright smoke in `e2e/` | the builder: author "Depends on a condition" and a runtime distance in a search field's condition, see Preview's results change | the card committing a shape the gate refuses |
| `lib/commcare/csql/__tests__/datetimeEquality.test.ts` | pure: the emitter over `eq`/`neq`/`in` on a custom `datetime`, `date_opened` in an advanced predicate, a `date` and a `text` anchor, with literal, native and runtime values | a `datetime` anchor left as `=`; a `date` or `text` anchor turned into a range; a runtime value without `blank-comparand` |
| `lib/commcare/csql/__tests__/representability.test.ts` (the same file) | pure: `date_opened = <datetime>` in `caseListConfig.filter` and in an advanced predicate; a computed `format-date` pattern in a runtime segment of each CSQL slot | the system-date equality admitted on a device slot or refused in a server-only one (the day rule, part 03 §3.2); the computed pattern admitted because the fold would evaluate it (part 03 §3.10) |
| `lib/domain/expression/__tests__/typeChecker.test.ts` (extended, in pull request 6, the checker) | pure: `datetime-literal-precision` | a microsecond literal admitted, or a minute or a millisecond literal refused. **Implementation correction, 2026-10-19:** the test asserts part 03 §3.10's verdicts, the microsecond literal refused beside the millisecond and the minute literal accepted; this column names the failures that would break it |

Byte-shape assertions on emitted CSQL are not written: Core and HQ reading the bytes are the proof.

---

## 10. Production and the cutover's dry run

The cutover lifts nothing for this part (every construct is new, or an emission change). What the
production reads during planning show, over every live app (none unreadable, no read failed):

| What | Production | Consequence |
|---|---|---|
| modules with an effective Search | some; nearly all of them send an `_xpath_query` | the population every row below is counted over |
| `_xpath_query` reading `today` / `now` (§3.4) | none / none | no search's bytes move for `today()`; `search-today-is-workers-day` names no module today |
| `eq` / `neq` / `in` on a `datetime` anchor in `_xpath_query` (§3.13) | none | `search-date-time-equality-matches` names no module today |
| the same in any case list filter or advanced predicate, Search effective or not | none | the device lowering of datetime equality moves no case list filter |
| orderings of `date_opened` / `last_modified` in a case list filter | none | the day rule meets no case list filter |
| typed datetime literals, any slot | none | `datetime-literal-precision` refuses no stored document |
| `within-distance`, `match`, `multi-select-contains` in `_xpath_query` (§3.7, §3.8) | none | nothing to lift; the unit table and runtime values serve new searches |
| ancestor case-id equality in a CSQL slot (§3.12) | none (some, in a few apps, all in cases-sourced select filters, a device slot) | no target's flag requirement changes |
| `app_changes` after the step 2 horizon | none | the window's opaque suffix is whatever accrues until then |

`closed_on`, `case_type` and numeric coercions are refused by today's checker (§1), and no record
slot can hold a datum read today, so no admitted document holds one; a record `div` (production holds none; part 01's `quotient` rule) and the
catalog's retiring `required` and `validation` slots (decided with the person, 2026-10-17; part 01)
are other parts'.

**What remains for the cutover's dry run.** Each is counted over the lifted documents at the window,
from the same walks the notice pass uses (`walkExpressionTerms` over the CSQL slots of
`composeXPathQueryPredicate`, and the predicate walk over every `caseListConfig.filter` and
`searchInputs[advanced].predicate`):

1. modules whose effective `_xpath_query` reads `today`: the `search-today-is-workers-day` entries;
2. modules whose effective `_xpath_query` holds `eq`, `neq` or `in` on a `datetime` anchor, by anchor
   (custom, system) and value kind (literal, native, runtime): the `search-date-time-equality-matches`
   entries;
3. `date_opened` / `last_modified` compared with a date and time in a case list filter (an ordering
   against a moment that is not day-aligned, or any equality): each would be refused by the day rule
   (`day-only-on-device`), so a non-zero count is a `target-gate` blocker the author resolves in the
   app before the window (part 09 §11);
4. typed datetime literals with more than three fraction digits: a non-zero count is a `target-gate`
   blocker of the same kind for `datetime-literal-precision`;
5. any document refused by this part's new findings (`closed-on-not-on-device`, `case-type-ordering`,
   `epoch-days-not-whole`, `epoch-fraction-on-device`, `runtime-selected-value-type`,
   `runtime-selected-value-on-device`, `raw-argument-not-evaluated`, `value-list-placement`,
   `distance-not-numeric`, `distance-unit-type`, `format-date-pattern-not-fixed` and `number-of-date`
   in CSQL slots): expected zero, since each guards a construct today's model cannot hold; a
   non-zero count is a `target-gate` blocker of the same kind.

No stored record expression can hold a chosen-case read (§3.9), so the chosen case's supply rule
refuses no lifted document.

The two notice reasons are written from walks 1 and 2.

---

## Departures

- **Project-timezone dates leave step 3** (§3.3; decided with the person, 2026-10-17), against the
  outline's item 2 list. Reason: no API-key route reads the zone, so no surface can author it
  truthfully; the alternative, Preview in the viewer's zone, would show different results from HQ's
  for every viewer outside the project's zone. Step 6 decides it on import.
- **CSQL `today()` is the worker's day everywhere** (§3.4; decided with the person, 2026-10-17),
  where the research holds `today()` as HQ evaluates it. Reason: HQ's meaning leaves the case list
  filter evaluating "today" in two zones. Notice reason `search-today-is-workers-day`.
- **`unwrap-list` and raw casedb, lookup-row and location reads in CSQL values are held, and no step
  authors them** (§3.6, §3.9), against the outline's item 2 list (list literals; case value terms).
  Reason: each is an escape hatch HQ's editors offer, and Nova's authoring has its own arm for what
  a person builds with one (a fixed list is `in`; a case value is the case chosen in an earlier
  menu, which step 3 authors); Nova does not reproduce an escape hatch because HQ has one. Step 6's
  import keeps them.
- **Several rows stay as they are** (§3.11), against the inventory's "kept as its own row". Reason:
  Nova-authored sources have no row identity; the identity belongs to an imported list, step 6's.

## Executed during planning

Local runs with `npx tsx --conditions=react-server` from the repo root over Nova's own modules (no
network, no paid call, no Docker), a lane run on GitHub Actions, a planning HQ check in the lane's
pinned image, and read-only production reads (no paid call, no write, no repo file changed;
`git status` clean after each).

- **The production shape scan**, run twice on 2026-10-17 (the second version with keys written for
  this part's CSQL constructs), as the operator's gcloud identity (`scripts/lib/prodDb.ts::targetProdDb`)
  in one `REPEATABLE READ, READ ONLY` transaction, writing closed labels and counts only, no app
  unreadable and no scan failure. This part relies on its inventory of modules with an effective
  Search and the `_xpath_query` they send; on finding no `_xpath_query` that reads `today` or `now`,
  holds `eq` or `in` on a datetime property, or holds a `within-distance`, a `match` or a
  `multi-select-contains`; on finding ancestor case-id equalities only in the filter of a cases-sourced
  select against the form's case; on no record `div`; and on no `app_changes` row after the step 2
  horizon. Read from the raw output, not only the summary.
- **A production datetime probe**, run on 2026-10-17 under the person's standing permission for
  read-only production reads (the same identity and transaction form, `transaction_read_only`
  confirmed `on`), over every live app, none unreadable and none failed, writing closed labels and
  counts only. It walks every module, form and field for typed datetime literals
  (`{ kind: "literal", data_type: "datetime" }`) by fraction-digit class, and every
  `caseListConfig.filter` and advanced Search predicate for `eq` / `neq` / `in` on a `datetime` anchor
  (custom by the effective catalog, or `date_opened` / `last_modified`) by slot and by whether Search
  is effective, and for orderings of `date_opened` / `last_modified` in a case list filter. Observed:
  none of any (no typed datetime literal in any live app). Its walk was first run over the 371
  documents of the lane's corpus (no network), where it finds what the shape scan finds there (an `eq`
  on a custom datetime in one case list filter and one advanced predicate, one system-date ordering,
  two typed datetime literals without a fraction), so the zero is the fleet's, not the walk's.
- **Today's CSQL emission**: a local script running today's `emitCsql` and
  `composeXPathQueryEmission` over seven constructs. Observed: an ancestor case-id comparison against
  a worker field is written `ancestor-exists(parent, (@case_type = 'household' and (@case_id =
  "…")))` inside the quote cascade and records `ancestor-exists` (the inferred qualifier is why §3.12
  needs `caseIdOf`); `dob >= today()` and `date_opened >= datetime(today())` send `today()` to HQ; a
  `when-input-present` ordering carries `quote` and `blank-comparand` obligations prefixed by
  `count(<input>) and`; literal `within-distance` and `selected` emit as constants; an `and` filter of
  two clauses emits two rows.
- **Today's representability**: a local script running today's checker and representability over
  five constructs. Observed: a row-free comparison as a clause is `comparison-needs-case-property`;
  `closed_on` and `case_type` are `unknown-property`; `date-coerce` of a number is
  `text-or-date-value`; a `date-coerce` value under `starts-with` is refused only by `match-value`
  typing.
- **Today's datetime equality**: a local script running today's type checker, CSQL representability
  and `emitCsql` over equality on a `datetime` property. Observed: every admitted shape emits text
  equality: `seen = '2026-01-02T04:30:00'` (naive typed literal), `seen = '2026-01-02T09:30:00.000+05'`,
  `seen != '…'`, `(seen = '…' or seen = '…')` for `in`, `seen = now()`,
  `seen = datetime('2026-01-02T04:30:00Z')`, the builder's minute literal `seen = '2026-01-02T09:30'`,
  `date_opened = '2026-01-02T09:30'` (a catalog that declares it), and a runtime value (a synthetic
  `datetime` search input) through the quote cascade with no `blank-comparand` obligation; none is
  refused by the checker or by `checkCsqlRepresentability`. An untyped text literal and an untyped
  worker field against `seen` are `incompatible-values` today.
- **The stored-spellings run**: a planning HQ check in the lane's pinned image (`npm run proof`),
  which saves cases through HQ's own receiver (`submit_case_blocks`), lets HQ's pillow write them to
  the case search index, and queries them with HQ's CSQL compiler
  (`proof/hq/operations.py::compile_case_search`) and `CaseSearchES`. Observed, as §3.13 quotes it:
  the stored value of each of the twelve spellings, twenty queries and their hits, the bound parses
  Elasticsearch accepts and refuses, and `date_opened` under UTC and Asia/Kolkata; every datetime
  spelling reaches HQ's index normalised to `…T04:30:00.000000Z`; Elasticsearch 6.8 parses Core's
  `+05` itself; CSQL `=` on a custom datetime property is text equality on `value.exact`; a date-only
  bound on a datetime property compares the UTC day.
- **The `targeted-datetime-equality` lane slice without readers**: GitHub Actions run 39061011794 on
  a scratch branch that carried its version of the document (the two differences above; the plan's
  document ran with every reader in run 39078199859, below), its retained control, three predicted `d75-…` entries,
  `OPEN_DEFECTS` `75: 3` and a predicted finding 74 walk stop, beside part 08's
  `targeted-datetime-operands`; documents run: `navigation-conditions`, `targeted-datetime-equality`,
  `targeted-datetime-operands`, `targeted-datetime-ordering`; `PROOF_READERS=0`. Its verdict holds
  339 items, 1 failed: `test_manifest` on `targeted-datetime-operands`, part 08's manifest classes.
  Per check: the equality document's four `intent` differences on document and control (§3.13's
  table); bar, manifest and proofs 1 to 3 at zero; proof 4's 110 and sensitivity's 6, which failed
  nothing. Its stored `csql` observations hold the three query strings, each `compiled: true` for
  case type `visit`. The scratch document differs from the plan's in "Log visit"'s date and time
  question and the third module's case list filter (§3.13); the two case-list entries the plan
  registers are the run's equality and inequality entries unchanged. Of the dispatches with every
  reader, the first died in the Android reader runtime job (issue 768) and the second (run
  39064331941, part 08 §6.4) passed it but lost the shard that held this document.
- **The `targeted-datetime-equality` run with every reader**: GitHub Actions run 39078199859 on the
  scratch branch `proof/plan-step3-operands` at `1a6ccfa9` (`main`, issue 768's fix, and the two new
  documents as this plan writes them), `mechanics`
  `navigation-conditions,targeted-datetime-equality,targeted-datetime-ordering`, read from its shard
  outputs and its gate's verdict. The two `d75-…` intent entries held on document and control; no
  finding 74 stop; the Web Apps client's and Android's lists and HQ's own search showed the device
  half alike; and "Opened visits"' search met HQ's 500 (`ESError`, Elasticsearch's
  `RequestError(400)` "failed to parse date field [2026-01-02T09:30]"), which stopped Formplayer's
  walk (`notification:n-internal-server-error`, 8 runs, all four states, document and control) and
  gave proof 3 8 differences in 2 classes and proof 4 12 in 4, each class named in §3.13's table of
  pull request 1's entries. `targeted-datetime-ordering`'s two `d56-…` entries and its finding 74
  stop held, and `navigation-conditions` was clean.

Read at the pins: HQ `case_search/filter_dsl.py` (whole), `xpath_functions/comparison.py` (whole),
`xpath_functions/value_functions.py` (whole, with `::now`, `::datetime_`, `::_value_to_datetime`),
`xpath_functions/query_functions.py` (whole), `xpath_functions/ancestor_functions.py` (whole),
`xpath_functions/__init__.py`, `dsl_utils.py::unwrap_value`, `const.py::INDEXED_METADATA_BY_KEY`,
`utils.py::_get_query`, `::_get_helper`, `QueryHelper.__init__`,
`CaseSearchQueryBuilder._apply_filter`, `es/case_search.py::case_property_query`,
`::case_property_text_query`, `::case_property_starts_with`, `::case_property_missing`,
`::case_property_date_range`, `es/filters.py::term`, `::date_range`, `es/utils.py::es_format_datetime`,
`es/queries.py::DISTANCE_UNITS`, `::geo_distance`, `pillows/core.py::DATE_FORMATS_ARR`,
`es/mappings/case_search_mapping.py`, `casexml/apps/case/xml/generator.py::CaseDBXMLGenerator`,
`::date_to_xml_string` and the generators' `date_opened` element (the day of `opened_on`),
`casexml/apps/case/fixtures.py::CaseDBFixture`, `form_processor/utils/xform.py::adjust_datetimes`,
`::adjust_text_to_datetime`, `RE_DATETIME_MATCH`, `form_processor/parsers/form.py::_create_new_xform`,
`form_processor/models/forms.py` (the second `adjust_datetimes` caller),
`ex-submodules/dimagi/utils/parsing.py::json_format_datetime`, `ISO_DATETIME_FORMAT`,
`hqcase/api/updates.py::handle_case_update`, `::_submit_case_blocks`,
`hqcase/utils.py::submit_case_blocks`, `case_importer/do_import.py` (its `submit_case_blocks`),
`corehq/util/timezones/utils.py::get_timezone_for_domain`, `domain/models.py::Domain.get_default_timezone`,
`api/resources/v0_5.py::NavigationEventAuditResource`, `settings.py::TIME_ZONE`, and `pyproject.toml`
(Django `~=5.2.17`); Core `XPathTodayFunc.java::evalBody`, `XPathDateFunc.java::evalBody`,
`FunctionUtils.java::toString`, `::toDate`, `XPathSelectedFunc.java::multiSelected`,
`XPathRegexFunc.java`, `XPathEqExpr.java::testEquality`, `CaseChildElement.java`,
`org/commcare/session/SessionInstanceBuilder.java::addDatums`; Formplayer
`aspects/SetBrowserValuesAspect.java::setValues`. Nova `lib/commcare/predicate/csqlEmitter.ts::emitComparisonSegments`,
`::emitOperandSegments`, `::inlineAsRuntimeOperand`; `termEmitter.ts::emitCsqlLiteralSegment`,
`::wrapTermAsSegmentList`; `runtimeCsqlDateSafety.ts::needsBlankComparandGuard`;
`lib/commcare/xform/datetimeCaseValue.ts`; `lib/domain/fieldValueType.ts::fieldValueType`;
`lib/commcare/xform/builder.ts` (the datetime sibling of a field whose value type is `datetime`);
`lib/commcare/xform/caseOps.ts` (a datetime write's `datetimeCaseValueExpression`);
`lib/case-store/sql/dataTypeTokens.ts::POSTGRES_CAST_FOR_DATA_TYPE`, `compilePredicate.ts::compileComparison`,
`::compileOrderedComparison`; `components/builder/shared/primitives/LiteralValueInput.tsx`;
`lib/notices/migrationNotice.ts::DOCUMENT_NOTICE_REASONS`; `lib/domain/predicate/types.ts::literalSchema`;
`lib/commcare/suite/case-search/searchPrompts.ts::getAdvancedArmPredicates`;
`lib/commcare/surface/entries/case-search.json` (every entry §6 names, and
`date-opened-closed-on-or-last-modified-compared-with-any`); `proof/checks/manifest_usage.py::csql_keys`,
`CSQL_FAMILIES`, `::read_csql`; `proof/checks/registers.py::OPEN_DEFECTS`;
`proof/checks/test_registers.py::test_every_live_defect_is_a_later_steps`;
`proof/targeted/documents/datetimeOrdering.ts` (its restore and `intent` expectations, the precedent
for `targeted-datetime-equality`); for §2.3, the exports of `lib/commcare/predicate/termEmitter.ts`,
`stringQuoting.ts` and `geopoint.ts` and every importer of each (`rg` over `lib`, `components`,
`proof`, `app`, `scripts` and `e2e`), and the imports of `predicate/csqlEmitter.ts`,
`csqlRepresentability.ts`, `expression/csqlEmitter.ts` and `expression/csqlRuntimeExpression.ts`
(`biome.json`'s `lib/commcare` allowlist read beside them); for §3.9,
`lib/commcare/formLinkProjection.ts::entrySessionDatums`, `::selectableDatums`,
`::parentSelectChain`, `::alignWithRootMenu` and `::withInlineSearchQueries`.
