# Step 3, part 04: Emission: the wire tree, the lowerings, instances, Vellum and HQ JSON

Part of [step 3's plan](../3-expressions.md), which holds the decisions, the stack and the exit.
This part decides how a stored `Expression` (part 01) becomes the bytes CommCare reads: one wire
XPath tree in `lib/commcare/xpath/wire`, one serializer that prints it for every target, instance
declarations derived from what that tree reads, finding 56's instant lowering, and every other
emission change the model brings. It ends with the byte-change census over the corpus, the tests
and proofs, and where it lands in the stack. The checker, the parser, Preview's evaluator, the
typed CSQL composition and the session datum projection are their own parts (03, 02, 07, 06, 05);
where this part depends on one of them it names the dependency.

Citations are `path::symbol` for Nova at `main` `5cf6e327` and `file::symbol` for CommCare at the
pins `proof/pins.json` names: commcare-core `8e9ba8d908e9` (paths under `src/main/java`),
commcare-hq `d6c6e16d8ae1` (paths relative to `corehq/apps/app_manager` unless another app is
named), formplayer `24383ac71bfb`, commcare-android `7a5584475580`, and Vellum `01215f251c57`, the
submodule HQ's pin holds (paths under `src`). A citation says where a behavior lives. Where an
execution decides a fact, the text names it, and "Executed during planning" at the end describes
each run.

## Decisions in brief

1. **One wire XPath tree, `WireExpr`, and one serializer, `serializeWire`, in
   `lib/commcare/xpath/wire/`.** Every XPath byte Nova emits, authored or generated (case blocks,
   meta block, columns, guards, wrappers), is built as a tree and printed by the serializer. No
   emitter assembles XPath in a template literal, and no emitter parses XPath text. The XML and
   HQ JSON models take a tree at every XPath-valued slot, so a string there is a type error.
2. **`toWire(expression, context)` is the one emitter from the union to the tree,** for every
   target a device evaluates (XForm, suite, the runtime segments of CSQL) and for HQ JSON and
   Preview. It replaces `lib/commcare/expression/onDeviceEmitter.ts`, `lib/commcare/predicate/caseListFilterEmitter.ts`,
   the device half of `termEmitter.ts`, `relationPresenceEmitter.ts`, the hashtag expansion of
   `lib/commcare/hashtags/formContext.ts` and `hashtags.ts`, and the text passes
   `xpath/javaRosaLowering.ts::lowerXPathForJavaRosa` and `xpath/selfSteps.ts::spellPredicateSelf`.
   Its context is complete or it does not run: every operand's two-axis type (part 01 §3) comes
   from the checker's typed tree, so "unknown" never silently means "emit bare".
3. **The serializer prints canonically everywhere** (part 01 §2.5): one space after every comma
   and one either side of every binary operator, numbers in shortest round-trip form, and a right
   operand of the same precedence keeps its parentheses unless parent and child are the same n-ary
   `and` or `or`. The round-trip law `parse(print(e)) = e` is the test. The spacing is Vellum's own
   normal form: two form builder saves rewrote only spacing in lowered text, adding exactly these
   spaces, and left canonically written text byte-identical (§3.7, the spellings witness run).
   Each target is a mode of the same printer: `xform`, `vellum` (the shadow), `suite`, `hq-json`
   (with HQ's interpolation per slot) and `preview`. A mode changes spelling, never structure.
   Preview's one structural difference, the query-bound repeat's flattened rows (part 07 §1.2), is
   `toWire`'s field resolution for the `preview` target, not a serializer mode.
4. **Instance declarations are the instances the printed tree reads**, returned by the serializer
   with the text. The XForm `InstanceTracker` substring scans, the suite collectors of
   `predicate/instances.ts`, and `xform/instanceRefs.ts` leave production; the oracles keep their
   own independent Lezer reading. A declaration nothing reads is no longer written (24 of the
   corpus's 500 HQ-upload forms lose one; §5.2).
5. **CSQL stays a segment IR over the wire tree.** CSQL text is built as a `CsqlNode` tree and
   printed by its own printer into constant segments; a runtime segment holds a `WireExpr`; the
   `_xpath_query` value (`if(<obligations>, 'match-none()', concat(...))`) is a `WireExpr` printed
   by `serializeWire`. No CSQL text is assembled by hand, and no on-device lowering enters CSQL
   text (part 06 decision 2).
6. **Finding 56 is lowered per operand, inline, by the zone-free instant parse in integer
   microseconds** (`instantMicros`, §3.1), the native lowering run's parse with the guarded offset,
   printed canonically. Each operand's instant text is chosen from its data type and what Core
   holds (§3.2). It applies to `<`, `<=`, `>`, `>=` and `between` with a date-and-time operand, and
   to `=`, `!=`, `in` and `switch` between two date-and-time operands, in every position a device
   evaluates, form logic and CSQL runtime segments included, and never in CSQL text. An equality
   with an operand that is not a date and time, such as the blank test `x = ''`, stays bare: every
   date-and-time equality production holds is such a blank test (§3.3).
7. **A literal instant folds at emission** to its integer microseconds; **`now()` is not
   hoisted.** XPath has no binding form, and a generated node would read the clock at a different
   time than the expression that reads it. Measured in the native lowering run, per 1,000 rows:
   37 to 52 ms against `now()`, 17.6 to 18.6 ms against a folded literal, 2.2 to 3.5 ms bare.
8. **Inline, never a generated node.** One shape in forms, suites, runtime segments and Preview;
   no submitted data added; the shadow carries the same lowering. Sizes in §3.9 (about 5.4 KB per
   typed-against-text comparison after a form builder save) and §5.3. A person who opens such a
   form in HQ's form builder sees the lowered comparison in its logic field (the witness's "Visit
   instants" form grows from 1,442 to 19,050 bytes), because the shadow must carry the same meaning
   or an HQ save reverts it; step 6 recognises the shape on import (§3.7).
9. **`datetime-coerce` never emits `date()` on a device.** Its operand enters the lowering as an
   instant: a date as its UTC midnight, date and time text as itself, a typed instant through
   `format-date`. Outside a comparison it prints the instant as text. Today's `date(x)` rounds a
   typed `Date` to the device's day (`org/javarosa/xpath/expr/FunctionUtils.java::toDate`).
10. **`date_opened` and `last_modified` read from `casedb` compare by day on a device.** Core holds
    them as `DateData` (`org/commcare/cases/instance/CaseChildElement.java`: `new
    DateData(c.getDateOpened())`), so no instant exists there. Ordered against a day-aligned
    `datetime` operand (a `datetime-coerce` of a date) the comparison is by day with today's bytes;
    ordered against any other `datetime` operand, and compared by `=` or `!=` with any `datetime`
    operand, day-aligned included, it is refused in a device-evaluated slot (part 03 §3.2 carries
    the rule, reason `day-only-on-device`); against a `date` operand it is part 03's `date-datetime`.
    Read from `results` or `results:inline`, `last_modified` is HQ's instant text and lowers
    normally, while `date_opened` is the UTC day and takes the same day rule (it lands with pull
    request 9, instances and session). Production compares neither on any slot (§3.4).
11. **Shadows print from the same tree in `vellum` mode,** so a lowering is in the shadow as in the
    real attribute. A shadow exists where it exists today and nowhere else: the tree reads a form
    field by its `#form/` spelling, and holds no read today's shadow rule withholds (a case, worker
    or search read, a `#form/` read with a predicate or heading a longer path). No shadow carries
    `#case/`, as step 2 left it (defect 3; Departures). **Implementation correction, 2026-10-20
    (pull request 5):** the lift keeps a stored `/data/...` read as a field read spelled
    `absolute`, so printing round-trips, and `wire/formReads.ts::formReadToWire` first gave it the
    `absolute` form root, which the serializer never spells `#form`. Today's text path printed such
    a read as `#form/`, so its shadow vanished and a filtered one stopped withholding the bind's
    shadow. An authored read spelled `absolute` now takes the `hashtag` root as an unspelled read
    does; generated paths keep `w.form`'s `absolute` default. The root prints `/data` outside
    `vellum` mode, so runtime, Preview and HQ JSON bytes are unchanged, and authoring still shows
    `/data/` where the author wrote it.
12. **HQ's text rewrites are serializer properties.** In HQ-bound modes a string literal is spelled
    so HQ's instance regex (`suite_xml/post_process/instances.py::instance_re`) finds nothing in
    it; in a slot HQ passes through `xpath.py::interpolate_xpath`, a literal is spelled so no
    replaced substring appears and no backslash run closes it, and the tree holds no `.` or `..`
    step.
13. **A Hidden Value's bind keeps today's type rule** (`lib/domain/fieldValueType.ts`, writer
    destination), as part 01 §3.2 states: binding a date-and-time Hidden Value as
    `xsd:dateTime` would make Core cast its case text at form open, which refuses malformed text and
    stops the form (finding 73's failure). The lowering reads the held representation that bind
    gives. **Implementation correction, 2026-10-19:** that representation is bind × source slot ×
    result (part 03 §5.1), and a date and time whose clock may be gone (a `Date` under an
    `xsd:string` bind, or a copy of one through any Hidden Value, branch or bind, which an
    `xsd:dateTime` bind cannot restore) is `clockLost`. Pull request 6 refuses it written into a
    date-and-time property; pull request 8 refuses an implicit instant comparison with a clock-lost
    operand (`incompatible-values`, reason `clock-lost`), since its instant text would be the day's
    and read NaN, while an explicit `date()` on both sides stays admitted. The bind keeps today's
    rule (`fieldValueType`), unchanged.
14. **Bytes move once, for named reasons only** (§5): canonical printing (105 of the 366 corpus
    documents that send HQ XPath; 243 of 371 in any target; in production some authored
    expressions, and Nova's own scaffolding in every app with a case list, which the dry run
    counts), unread declarations (24 HQ-upload forms), finding 56 (2 corpus documents; a few
    orderings in production, all in form logic), `datetime-coerce` (1 corpus document; none in
    production), the first-row lift of a structural repeat read (a few in production), the binds
    step 3's inference moves through `fieldValueType` (a property newly typed `datetime` gives its
    Hidden Value writers an `xsd:dateTime` bind and a `nova_datetime_<question>` sibling; the dry
    run counts them, §5.4), and part 06's CSQL `today()` and datetime equality range (none in
    production). Every other byte stays.

---

## 1. Emission today

Two families cross the boundary differently:

- **Record family** (`Predicate` / `ValueExpression`): three template-literal emitters. On device,
  `predicate/caseListFilterEmitter.ts::emitCaseListFilter`, `expression/onDeviceEmitter.ts::emitOnDeviceExpression`
  and `predicate/termEmitter.ts::emitTerm`; CSQL, `predicate/csqlEmitter.ts::emitCsql` with
  `expression/csqlEmitter.ts` over the `predicate/csqlSegment.ts::CsqlSegment` IR; Postgres in
  `lib/case-store/sql`. Callers: `suite/case-list/nodesetFilter.ts::emitNodesetFilter`,
  `suite/case-list/orderPlanOptions.ts`, `suite/case-list/shortDetail.ts`,
  `suite/displayConditions.ts`, `suite/case-search/searchPrompts.ts`, `caseOptions.ts`,
  `xform/caseOps.ts`, `xform/builder.ts::buildLookupItemset`, `hqJson/caseList.ts`,
  `expression/csqlRuntimeExpression.ts`, and Preview's `lib/preview/engine/displayConditionEvaluation.ts`,
  `lookupEvaluation.ts`, `searchExpressionEvaluation.ts`, which evaluate the emitted strings.
- **Form logic** (`XPathExpression`, text runs with leaves): print, then
  `hashtags/formContext.ts::expandHashtagsInContext` (or `::expandHashtagsForDefaultValue`, or
  `::expandHashtagsForSessionStack` for form links), then `xpath/javaRosaLowering.ts::lowerXPathForJavaRosa`,
  then `xpath/selfSteps.ts::spellPredicateSelf`, assembled in `xform/builder.ts` (`expand`,
  `expandDefault`, `computed`, `shorthand`), `formLinkProjection.ts::formLinkWireProjector` and
  `xform/constraintMessage.ts`. No step knows an operand's type.
- **Generated XPath** is written by hand in about 300 template literals across some 40 files (a
  count of template literals holding an XPath call or operator in `lib/commcare`, outside tests and
  docs: `csqlEmitter.ts` 55, `termEmitter.ts` 54,
  `onDeviceEmitter.ts` 40, `suite/case-list/columns.ts` 34, `xform/caseOps.ts` 25,
  `caseListFilterEmitter.ts` 25, `xform/caseBlocks.ts` 23, `nodesetFilter.ts` 15,
  `relationPresenceEmitter.ts` 14, `searchPrompts.ts` 13, `session.ts` 13, and fewer in
  `metaBlock.ts`, `usercaseWire.ts`, `claim.ts`, `entryPointSuite.ts`, `datetimeCaseValue.ts`,
  `captureUrlNode.ts`, `displayConditions.ts`).
- **Instances.** XForm: `xform/builder.ts::InstanceTracker` (`scanXPath`'s substring tests for
  `#user/` and `#<type>/` before a Lezer `instance()` scan, `requireFixture`,
  `requireSelectedCases`, `requireSearchInput`, and `casedb` implying `commcaresession`), plus
  `xform/caseBlocks.ts::addCaseBlocks` after the scan. Suite: `predicate/instances.ts::collectPredicateInstances`
  and `::collectExpressionInstances`, an AST walk apart from emission, plus
  `xform/instanceRefs.ts::collectInstanceRefs` over emitted strings, assembled in
  `session.ts::deriveEntryDefinition`, `::deriveCaseListEntryDefinition`,
  `::accumulateCaseLoadingInstances`, `suite/case-search/searchSession.ts`, `remoteRequest.ts`,
  `searchPrompts.ts` and `compiler.ts`.

---

## 2. The wire tree and its one serializer

### 2.1 The tree

```ts
// lib/commcare/xpath/wire/tree.ts
type WireExpr =
  | { k: "str"; value: string }
  | { k: "num"; value: number }                       // finite; printed shortest, no exponent
  | { k: "cmp"; op: "=" | "!=" | "<" | "<=" | ">" | ">="; left: WireExpr; right: WireExpr }
  | { k: "arith"; op: "+" | "-" | "*" | "div" | "mod"; left: WireExpr; right: WireExpr }
  | { k: "and" | "or"; items: [WireExpr, WireExpr, ...WireExpr[]] }
  | { k: "neg"; value: WireExpr }
  | { k: "call"; fn: WireFunction; args: WireExpr[] }
  | { k: "path"; root: WireRoot; steps: WireStep[] }
  | { k: "expansion"; of: "case" | "worker" | "search"; expr: WireExpr }
  | { k: "case-id-var" | "next-input-var" | "calculated-property-var" }
  | { k: "enum-label-var" | "hq-enum-var"; index: number }
  | { k: "image-alt-var"; value: string }
  | { k: "endpoint-argument-var"; name: string };      // generated endpoint selection id only

type WireFunction = JavaRosaFunction | "jr:itext" | "jr:choice-name" | "here";
//   JavaRosaFunction: the 76 names of ASTNodeFunctionCall.java::buildFuncExpr, the same closed
//   list as lib/commcare/xpath/functionCapabilities.ts::JAVAROSA_NATIVE_FUNCTIONS. Nova's two
//   lowered names (is-blank, normalize-space) are not in it: toWire lowers them.

type WireRoot =
  | { k: "form"; spelling: "hashtag" | "absolute" }   // /data/… on the wire; #form/… in a shadow when "hashtag"
  | { k: "context" }                                  // relative: the slot's context node
  | { k: "current" }                                  // current()/…
  | { k: "instance"; decl: InstanceDecl }             // instance('<id>')/…
  | { k: "hq-case" };                                 // #case: HQ JSON form_filter only

type WireStep = {
  axis: "child" | "attribute" | "self" | "parent" | "wildcard";
  name?: string;                                      // a wire name; wildcard is a separate axis
  predicates: WireExpr[];
};

type InstanceDecl = { id: string; src: string };     // from part 05 §2.1's table, per target
```

- The tree is post-identity: every name in it is a current wire name (a field id path, a property,
  a datum id, a lookup tag or column, a level code), resolved by `toWire` from the identity the
  stored union holds. So a rename never touches a tree; the next emission builds another.
- There is no grouping node: parentheses are the serializer's.
- `expansion` marks a subtree that today comes from expanding a non-`#form/` hashtag
  (`form-case`, a worker read from the worker's own case, a Search answer). It is transparent in
  every mode except `vellum`, where it withholds the shadow (§2.3).
- `case-id-var` is HQ's `$case_id`, a variable reference Core parses as `XPathVariableReference`
  (`org/javarosa/xpath/expr/XPathVariableReference.java`). Nova writes it in two generated slots
  today, both as HQ writes them: the multiple-selection claim's `relevant`, `$case_id != ''`
  (`suite/case-search/claim.ts::CLAIM_MULTI_RELEVANT`, `entryPointSuite.ts`; HQ
  `xpath.py::CaseClaimXpath.multi_case_relevant`), and an entry point's scalar query hydration,
  `<data key="case_id" ref="$case_id"/>` (`entryPointSuite.ts`; HQ
  `suite_xml/post_process/workflow.py::WorkflowQueryMeta.to_stack_datum`, `is_endpoint`). It
  prints `$case_id` in `suite` mode and throws in every other mode, so a string stays out of the
  tree and the name stays out of every authored arm (no `Expression` builds it). It reads no
  instance.
- Subtrees are shared objects. The instant lowering refers to one operand subtree about 40 times
  (§3.1); the serializer memoises each node's print in a `WeakMap`, so printing is linear in the
  output and building is constant per reference.

The implementation audit found existing generated variable sites beyond `$case_id`: detail
auto-launch's `$next_input`, calculated-column and label variables, image-alt variables, HQ enum
placeholders, and endpoint arguments named by the required selection datum. They have the closed
arms above, with suite-only or HQ-only serialization as their owning consumers require. None is
an authored variable arm. Parent selection also already emits `index/*`; `w.wildcard` represents
that child step explicitly while a named step still refuses `*`. These additions preserve the
existing scaffolding rather than adding authored syntax.

`lib/commcare/xpath/wire/builders.ts` exports the constructors every generated site uses
(`w.str`, `w.num`, `w.eq` … `w.gte`, `w.and`, `w.or`, `w.not`, `w.call`, `w.path`, `w.step`,
`w.attr`, `w.self`, `w.parent`, `w.wildcard`, `w.instance`, `w.current`, `w.form`, `w.caseIdVar`), so
`count(/data/nova_url_scan) > 0` is `w.gt(w.call("count", [w.form(["nova_url_scan"])]), w.num(0))`.

### 2.2 `toWire`: the one emitter

```ts
// lib/commcare/xpath/wire/fromExpression.ts
function toWire(expression: Expression, ctx: WireBuildContext): WireExpr;

interface WireBuildContext {
  readonly target: "xform" | "suite" | "csql-runtime" | "hq-json" | "preview";
  readonly slot: SlotId;                              // part 01 §4: the slot's profile
  readonly types: TypedTree;                          // the checker's NodeType per node (part 03)
  readonly fields: FieldPathResolver;                 // uuid → FormPath, and the slot's context node
  readonly rows: RowScope;                            // the row stack: casedb | results | results:inline | table | location
  readonly datumId: (ref: DatumRef) => string;        // part 05 §1.3, §1.4: the id formLinkProjection.ts::entryDatumIds gives the ref (its chainId in HQ JSON's case list filter)
  readonly lookups: LookupWireNaming;                 // lib/commcare/lookup/naming.ts
  readonly names: WireNames;                          // worker property slugs, search input names and instance, level codes, location property slugs
}
```

- Every arm maps to one tree shape: part 01 §2.4's "Form XPath" column is the print of
  `toWire(arm)` in `xform` mode, and record arms emit what their on-device emitters emit today
  (§4), now as trees.
- Today's lowerings move here unchanged in meaning: `is-blank` to `string-length(string(x)) = 0`;
  `normalize-space` to the two `replace()` calls; `quotient` (part 01 decision 5) to today's integer
  division `if(r = 0, l div r, (l - l mod r) div r)`; `switch` to the right-nested `if`; `in` to
  an `or` of equalities; `date-add`; the `count`, `exists` and `missing` relation forms
  (`relationPresenceEmitter.ts::emitImmediateRelationPresence`); `within-distance`;
  `when-input-present`; `table-lookup`; `owner-location-at-level`; the unanswered-input
  substitution of `nodesetFilter.ts::emitNodesetFilter`. Each keeps its native evidence,
  re-observed by the families of §6.
- `ctx.types` is required. Where an operand of a comparison is `datetime` (§3), `toWire` reads its
  held representation; a missing `NodeType` throws (`"Nova was asked to emit a comparison it has
  not typed. The commit gate types every expression before emission."`), because the gate types
  every stored expression (part 03) and a fallback would emit the defect.
- Field reads (`lib/commcare/xpath/wire/formReads.ts`, from `formContext.ts`): a `field` leaf with
  no `spelling` is a `form` root with `spelling: "hashtag"`; `"absolute"` likewise with
  `"absolute"`; `"relative"` and `"current"` print through the context node (part 01 §2.6). In a
  `default_value` slot a hashtag read prints as today's `current()`-relative path to the target
  (`expandHashtagsForDefaultValue`, because Core evaluates a setvalue in its target's context and
  HQ's form builder refuses `#form/` there). A `form-case` leaf builds today's casedb walk
  (`hashtags.ts::expandCaseToWire`, from the form's case id reference or the registration form's
  own new-case datum) inside an `expansion { of: "case" }`.
- `ctx.datumId` is built by the caller from `entryDatumIds` rows, and it is the one place a target's
  datum ids differ. Every slot takes a row's `id`, the datum's id after root alignment, but one: HQ
  JSON's `case_details.short.filter`, which HQ's build writes into each chain datum's nodeset and then
  renames through root alignment (`suite_xml/sections/entries.py::EntriesHelper.get_case_datums_basic_module`,
  which builds the chain with `get_datum_meta_module(module, use_filter=True)` and hands it to
  `add_parent_datums`, whose `set_id` calls `_update_refs`, a plain
  `xpath.replace(session_var(old_id), session_var(new_id))` over every datum's `nodeset` and
  `function`). So `hqJson/caseList.ts::projectCaseListFilter` builds its `datumId` from each row's
  `chainId`, the id `selectableDatums` gave the datum before `alignWithRootMenu` (part 05 §1.3), from
  the module's first entry that runs its list, which any entry would give alike (part 05, "One id
  per slot"); HQ's rename then yields the aligned id the local suite prints. The same filter's CSQL
  copy in `search_config.default_properties` takes `id`, because HQ copies a default property into
  the remote request's `<data ref>` verbatim (`post_process/remote_requests.py::RemoteRequestFactory._remote_request_query_datums`)
  and adds an inline search's query datum after alignment (`entries.py::EntriesHelper.configure_entry_module_form`,
  `add_remote_query_datums` after `get_case_datums_basic_module`), as do `form_filter` and the
  suite. One stored filter therefore prints two id sets in HQ JSON, each the one HQ's build reads.
- `target: "preview"` is part 07's `spelling: "preview"` (part 07 §1.2). It changes one thing in
  `toWire`: `ctx.fields` resolves a field inside a query-bound repeat without the wire's `item`
  step and a `repeat-row` read as `@id` / `@index` on the flattened row, because Preview's
  `DataInstance` has no `item` step. Every other node, every lowering and every instance root is the
  wire's, so Preview evaluates the device's text. Nothing in this part hoists an operand into a
  generated node (§3.6), so Preview has no generated node to inline.

### 2.3 The serializer

```ts
// lib/commcare/xpath/wire/serialize.ts
type WireMode =
  | { target: "xform"; constraint: boolean }          // constraint: `.` is the candidate answer
  | { target: "vellum"; constraint: boolean }
  | { target: "suite" }
  | { target: "hq-json"; interpolation: "none" | "case" | "no-case" | "no-dots" | "enum-key" }
  | { target: "preview" };

function serializeWire(expr: WireExpr, mode: WireMode):
  { text: string; instances: ReadonlySet<InstanceDecl> } | undefined;   // undefined: vellum withholds
```

Properties, each held by a test of §6:

| Property | Modes | Rule |
|---|---|---|
| Canonical print | all | One space after every comma (`f(a, b)`) and one either side of every binary operator, none inside a path or next to a step predicate's brackets; parentheses only where the tree needs them: lower precedence than the parent on either side, and a right operand of the same precedence unless parent and child are the same `and` or `or`; single quotes unless the value holds `'`; shortest round-trip number, no exponent (`5`, never `5.0` or `5.`). This spacing is what Vellum's save writes (§3.7), so canonical text is a fixed point of an HQ form builder save. |
| Self step in a predicate | `xform`, `vellum`, unless `constraint` | `./.` (today's `spellPredicateSelf`; Vellum `logic.js::LogicExpression.analyze` flags a one-step self path). |
| `#form/` spelling | `vellum` | a `form` root with `spelling: "hashtag"` prints `#form/<path>`; every other node prints as in `xform`. |
| Shadow withheld | `vellum` | returns `undefined` when the tree holds an `expansion` (a case, worker or search read), or a `hashtag` form root whose steps carry a predicate or a `self`, `parent` or `attribute` step (a `#form/` read that is the base of a predicate or heads a longer path, `formContext.ts::hashtagHeadsAPath` today), or a `hq-case` root. Vellum prefers the shadow on load (`parser.js::parseVellumAttrs`: `form.richText && vellumAttr ? vellumAttr : xmlAttr`), so a shadow is either complete or absent. So no shadow carries `#case/` (step 2's rule, defect 3): with the raw casedb path in the real attribute, the form builder turns a listed property into its own `#case/<property>` on save, as the spellings witness run's save did (§3.7), and that is HQ's editor's own spelling, which proof 4 erases. |
| No instance id in a literal | `xform`, `vellum`, `hq-json` | HQ reads instance ids by `instance_re = instance\(\s*['"]([\w\-:]+)['"]\s*\)` over the html-unescaped text (`post_process/instances.py::get_instance_names`), in the whole rendered XForm (`xform.py::XForm.add_missing_instances`: unknown ids raise, known ones are added) and in every suite XPath. A literal whose value holds `instance(` followed by optional space and a quote is printed as `concat()` of pieces split after `instance`, so the regex finds nothing and Core reads the same value. |
| Interpolation-safe literals | `hq-json`, `interpolation` `case`, `no-case` or `no-dots` | `interpolate_xpath` replaces `#user`, `#session/`, and with a case `#case`, `#parent`, `#host`, by `str.replace` regardless of quotes. A literal holding one is printed as `concat()` of pieces split after its `#`. `dot_interpolate` treats `\` as an escape of the next character inside and outside quotes, so a literal whose value ends in an odd run of backslashes would be read as unclosed: its last backslash prints as `substr('\\', 0, 1)` (HQ pairs `\\`, Core's `substr` returns one backslash). |
| No dot steps | `hq-json`, `interpolation` `case` or `no-case` | `dot_interpolate` replaces every unquoted `.` with no digit beside it (`(i == 0 or re.match(r'\D', string[i - 1]))` and the same after); without a case `_ensure_no_case_references` raises on one. `serializeWire` throws on a `self` or `parent` step in these modes; `toWire` never builds one for these slots (row reads are named, relations are `index/<identifier>`). |
| Image mapping conditions | `hq-json`, `enum-key` | `MappingItem.key_as_condition` calls `dot_interpolate` directly. Its generated `selected(., <value>)` preserves the self placeholder for the column's property, protects odd trailing backslashes in every final literal fragment and HQ instance discovery, and leaves literal hashtags unchanged. Parent steps and the HQ case root are refused. The local image-alt variable hashes this same printed key. |
| `#case` shortcut | `hq-json` `case` | a `hq-case` root prints `#case/<property>` (`displayConditions.ts::emitFormDisplayConditionForHq` today); any other mode throws. |
| Instances | all | the set of `instance` roots printed. |

The modes per slot: XForm binds, setvalues, outputs, itemsets and `jr:count` are `xform` (the
real attribute) and `vellum` (the shadow, where the slot carries one today: bind `calculate`,
`relevant`, `constraint`, `requiredCondition`, label `<output>`; never a setvalue default, never a
generated node's bind). Suite attributes are `suite`. HQ JSON: `case_details.short.filter` is
`case` (`suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`, `case_xpath =
current()`); `form_filter` is `case` when the form requires a case, else `no-case`
(`sections/menus.py`); `module_filter` and `search_config.properties[].required.test` are
`no-case` (`menus.py`, `post_process/remote_requests.py`); `validations[].test` is `no-dots`
(`interpolate_dots=False`); image mapping `enum[].key` is `enum-key`; every other HQ JSON XPath (calculated columns, `persistent_case_context_xml`, `default_value`,
`form_links[].xpath`, `datums[].xpath`, `default_properties[].defaultValue`,
`search_button_display_condition`, `blacklisted_owner_ids_expression`) is `none`. Preview's
`preview` mode prints as `xform` does, with the instance ids the wire declares: from step 3 Preview
supplies the instance the wire reads (part 07 §1.2, §3), so it needs no spelling table of its own.

The corpus holds none of the hazards (Executed during planning, the interpolation probe: 147
strings in the four interpolated slots, no dot step, no literal with a replaced substring, an odd
trailing backslash run or an instance id), and neither does production (the third production shape
scan: no form-logic or record-slot string literal in a live app holds an interpolation token, an
`instance(` call with a quote, or an odd trailing backslash run). So the literal spellings change
no corpus or production byte; they are what keeps the serializer total over literals an author
can write (`notes = '#case'`).

### 2.4 Instance declarations

Pull request 4 keeps the existing form-authored print/expand/lower pipeline until pull request 5.
Its output therefore crosses the XML/HQ boundary in two separate symbol-branded values,
`LegacyAuthoredXPath` and `LegacyFormLinkXPath` (`xform/legacyAuthoredXPath.ts`). Only the old
authored projection creates them. `xel` restricts them to the authored XForm attributes and
form-link guard/manual-datum attributes that still use that pipeline. Finite mixed-expression
builders retain the brand only when an authored operand is present; generated-only operands
remain wire trees. The old Lezer instance scan runs only on these branded outputs, never on a
generated expression. Pull request 5 deletes this whole bridge with the old text pipeline.

`serializeWire` returns the instances its text reads; each emitter unions them into the scope Core
evaluates in:

- **XForm** (`xform/builder.ts`): every attribute it prints, case blocks (`addCaseBlocks`) and the
  meta block (`metaBlock.ts::addMetaBlock`) included, adds to one `InstanceSink`; the `<instance>`
  elements are the sink's set, in today's order (`casedb`, `commcaresession`, then the rest by
  id). `InstanceTracker`, its `casedb`-implies-`commcaresession` rule, and the unconditional
  `requireSelectedCases` for every multiple-selection form leave.
- **Suite**: per entry, remote request and menu, from the trees of its datums, details it
  references, prompts, stack frames, assertions and command conditions, in
  `session.ts::deriveEntryDefinition`, `::deriveCaseListEntryDefinition`,
  `searchSession.ts`, `remoteRequest.ts` and `compiler.ts`. The separate authored-AST instance
  collector is removed; the compiler joins each datum's actual referenced detail ids to the sets
  those rendered details returned. From pull request 4 until pull request 10 moves CSQL onto
  `CsqlNode` (§2.5), a CSQL runtime segment, rejection, and wrapper carry wire trees. Their final
  printed attributes contribute the remote request's exact reads.
- **HQ JSON** declares nothing (HQ adds what it reads); the derived set still feeds
  `lib/commcare/locations/readsLocationsFixture.ts::formsReadingLocationsFixture` and
  `planPrivileges.ts` (part 05 §2.4).
- `InstanceDecl` comes from part 05 §2.1's table when `toWire` builds the root, so the id and src
  are decided once, at the arm. A lookup root is `<tag>` with `jr://fixture/item-list:<tag>` in an
  XForm slot and `item-list:<tag>` in a suite or form-link slot (part 05 §2.3).
- Two declarations for one id with two srcs throw: the table cannot produce them, and Core would
  read only one.

### 2.5 CSQL over the wire tree (with part 06)

Part 06 §2.3 places the CSQL emitter in `lib/commcare/csql/`. This part fixes the boundary between
the two dialects: the CSQL emitter builds a `CsqlNode` tree (comparison, query call, `and`, `or`,
`not`, step, literal, number, value call, and a runtime hole holding a `WireExpr`), and
`printCsql(tree)` yields today's `CsqlSegment[]` (constant text and runtime segments). The
wrapper is then a wire tree: `if(<or of obligations>, 'match-none()', concat(<constants as str>,
<runtime trees>…))`, today's `csqlEmitter.ts::wrapClause` and `::buildQuoteCascade` as
constructors. So the only string assembly of CSQL is `printCsql`, which is a printer, and the
remote request's instances are the union of its runtime trees' instances (part 06 §2.2).

### 2.6 Where every current emitter goes

| Today | From step 3 | Pull request |
|---|---|---|
| `expression/onDeviceEmitter.ts`, `predicate/caseListFilterEmitter.ts`, `predicate/relationPresenceEmitter.ts`, and the device half of `predicate/termEmitter.ts` (`emitTerm`, `emitOnDevicePropertyRef`, `emitOnDeviceLiteralValue`, `buildAncestorJoinNodeset`, `buildSubcaseJoinNodeset`, `clearLookupRowScope`, `instanceRootPath`, `DEFAULT_INSTANCE_ROOT`, `InstanceRoot`, `OnDeviceExpressionBindings`, `OnDeviceLookupEmissionContext`, `OnDeviceTermEmissionContext`) | `xpath/wire/fromExpression.ts` (and `instant.ts`, `formReads.ts`); the case-anchor model (`OnDeviceCaseAnchor`, `ROOT_ON_DEVICE_CASE_ANCHOR`, `descendOnDeviceCaseAnchor`, `onDeviceAnchorCaseId`) moves to `xpath/wire/rowScope.ts` (new), the row stack `toWire` reads | 4 |
| the CSQL half of `predicate/termEmitter.ts` (`emitTermSegment`, the `TermEmission` types, `emitCsqlPropertyRefText`, `emitCsqlPropertyRefSegment`, `emitCsqlLiteralSegment`, `wrapTermAsSegmentList`, `quoteFreeRuntimeCsqlValue`, `quoteRuntimeCsqlValue`, `serializeAncestorPath`, `STANDALONE_SEARCH_INPUT_INSTANCE_ID`, and the three runtime readers `emitSearchInputXPath`, `emitSessionUserXPath`, `emitSessionContextXPath`) | stays in `termEmitter.ts`; from pull request 4 the three runtime readers return their arm's `toWire` tree instead of a template literal, and `emitSearchInputXPath`'s parameter, today a `Pick` of the deleted `OnDeviceTermEmissionContext`, is `CsqlSearchInputContext` (`searchInputNames`, `searchInputInstanceId`), defined in `termEmitter.ts`, so `predicate/csqlEmitter.ts` and `runtimeCsqlNumericSafety.ts` compile with their imports unchanged; pull request 10 moves the rest into `lib/commcare/csql/` (part 06 §2.3) | 4, then 10 |
| `predicate/geopoint.ts`: the device builders `normalizeOnDeviceGeopoint` and `validOnDeviceGeopointCenter` | trees in `xpath/wire/geopoint.ts` (new), which the `within-distance` arm builds; the old string-returning wrappers leave, and `predicate/csqlEmitter.ts` builds its runtime guard from the shared `normalizeGeopoint` and `validGeopointCenter` trees; the patterns, `normalizeStaticGeopoint`, `isValidStaticGeopointCenter` and the two input-name collectors stay, and pull request 10 moves them (part 06 §2.3) | 4, then 10 |
| `predicate/stringQuoting.ts`: `quoteLiteral`'s device arm (dialects `case-list-filter` and `search-filter`) and `::formatNumeric`; `xpath/stringLiteral.ts::xpathStringLiteral` | the serializer's literal and number print. `formatNumeric` stays in `stringQuoting.ts` with the CSQL half until pull request 10, and the serializer's number print calls it, so `lookup/cellText.ts`, `predicate/csqlEmitter.ts` and `termEmitter.ts`'s CSQL half keep their import and `lookupFixtureCellText` writes a numeric cell with the spelling every literal prints; pull request 10 moves it into `xpath/wire/serialize.ts` as the number print, where `cellText.ts` and the CSQL printer read it (part 06 §2.3). `quoteLiteral` keeps its `csql` arm and `isCsqlStringLiteralRepresentable` stays, for the CSQL emitters and `csqlRepresentability.ts`; pull request 10 moves both into `lib/commcare/csql/` (part 06 §2.3) | 4, then 10 |
| `predicate/instances.ts` (`instanceSourceFor`, `collectPredicateInstances`, `collectExpressionInstances`, `isSelectedCasesInstanceId`), `builder.ts::InstanceTracker` | `xpath/wire/instances.ts` (the arm table) and the serializer's instance set; until pull request 10 a CSQL runtime segment carries its wire tree, whose final print contributes the remote request's reads (§2.4) | 4 |
| `xform/instanceRefs.ts` | the oracles' private reader in `suiteOracle.ts` (§2.7); it feeds the text path's printed attributes into the `InstanceSink` through pull request 4 | 5 |
| `xform/pathExpression.ts` | stays: its only importers are `xformOracle.ts` and `suiteOracle.ts`, which keep their own reading of emitted text | none |
| `predicate/matchModes.ts` | stays: the table of which match modes run on a device, read by `validator/rules/displayConditions.ts`, `caseOptionsSource.ts`, `case-list/matchModeOnDeviceCompatibility.ts` and `lib/doc/commitVerdicts.ts`; pull request 10 moves it under `lib/commcare/csql/` (part 06 §2.3) | 10 |
| `hashtags/formContext.ts` (`expandHashtagsInContext`, `expandHashtagsForDefaultValue`, `expandHashtagsForSessionStack`, `vellumShorthandInContext`, `searchAnswerWireRef`), `hashtags.ts` (`expandCaseToWire`, `rewriteHashtags`, `expandFlatHashtags`, `referencesSearchAnswer`, `extractHashtags`) | `xpath/wire/formReads.ts` and `vellum` mode. `hashtags.ts::hqLoadReference` and `VELLUM_HASHTAG_TRANSFORMS` stay: they write HQ's `case_references_data.load` strings, which are not XPath any reader evaluates | 5 |
| `xpath/javaRosaLowering.ts`, `xpath/selfSteps.ts`, `xpath/wireSource.ts::printWireXPathSource` | arms in `toWire`; a self step's spelling in the serializer; "is this a path" is the tree's kind | 5 |
| `formLinkProjection.ts::formLinkWireProjector` (print, expand, lower, trim) | `toWire` with the source entry's session context (part 05 §1.4) | 5 |
| `suite/case-list/orderPlanOptions.ts::hqExpressionFieldText`, and the ancestor-property text it takes from `suite/case-search/relatedCaseProjection.ts::emitHqContextRelativeAncestorProperty` | `serializeWire(toWire(column.expression, { target: "hq-json", … }), { target: "hq-json", interpolation: "none" })`, its lookup roots spelled as in a suite slot (`item-list:<tag>`), because HQ copies a calculated column's `field` into its suite detail verbatim (`detail_screen.py::FormattedDetailColumn.xpath`). So a calculated column's HQ `field` and the order plan's join text (`lib/domain/caseListOrder.ts`, rules 2 and 5) are one canonical text, `caseListOrderOptions` stays their one source, and the census counts the change once (§5.1). The `unprintableExpressionText` fallback for a document the validator refuses stays: the order plan is total, and an export re-runs the validator first | 4 |
| `suite/case-list/columns.ts` (`plainSelectDisplayXpath`, `intervalColumnDisplayXpath`, `idMappingDisplayXpath`, `linkColumnDisplayXpath`), `sortKeys.ts`, `keyVariable.ts`, `tileGroup.ts`, `nodesetFilter.ts`, `shortDetail.ts`, `suite/displayConditions.ts`, `suite/case-search/searchPrompts.ts`, `searchSession.ts`, `remoteRequest.ts`, `relatedCaseProjection.ts`, `caseOptions.ts`, `hqJson/caseList.ts` | the same shapes from `w.*` constructors and `toWire` | 4 |
| `xform/caseBlocks.ts`, `metaBlock.ts`, `caseOps.ts` (`caseScalarTextValueGuard`, `caseScalarTextValueCalculation`, `authoredCaseIdCalculation` among them), `captureUrlNode.ts`, `datetimeCaseValue.ts::datetimeCaseValueExpression`, `constraintMessage.ts`, `constraintCollections.ts`, `usercaseWire.ts`, `subcaseWire.ts`, `suite/case-search/claim.ts`, `entryPointSuite.ts` | the same shapes from `w.*` constructors | 4 |
| `predicate/csqlEmitter.ts`, `expression/csqlEmitter.ts`, `csqlSegment.ts`, `expression/csqlRuntimeExpression.ts` | `lib/commcare/csql/` (part 06) over `CsqlNode` and `WireExpr` (§2.5); from pull request 4 `csqlRuntimeExpression.ts` returns its runtime value as `toWire(…)`, and only the final XML/HQ field prints it | 4, then 10 |

`lib/commcare/predicate/` and `lib/commcare/expression/` are removed in the stack, pull request 4
deleting their device halves and pull request 10 moving what remains; no re-export stays.
`lib/commcare/xpath/index.ts` exports the wire tree, the constructors and `serializeWire`, and stops
exporting `xpathStringLiteral`. `biome.json` needs no change: its allowlist for `lib/commcare`
consumers admits `lib/preview/engine/**` and `lib/preview/xpath/**`, where the `preview` mode's
consumers sit, and no other new consumer reaches `lib/commcare/xpath/wire`.

**Pull request 4's deletions and every importer it re-points.** Pull request 4 deletes
`expression/onDeviceEmitter.ts`, `predicate/caseListFilterEmitter.ts`,
`predicate/relationPresenceEmitter.ts`, `predicate/instances.ts` and `xpath/stringLiteral.ts`, and
the device halves of `predicate/termEmitter.ts`, `geopoint.ts` and `stringQuoting.ts` above. The
importers come from `rg -l` over each module's path, tests included, with relative and barrel
imports resolved (`predicate/index.ts` re-exports `emitCaseListFilter`, the three instance
functions, `formatNumeric` and `quoteLiteral`), plus a search for each path as a string; at `main`
`5cf6e327` they are:

- **Emitters re-pointed to `toWire`, `w.*` and the serializer's instance set:**
  `lib/commcare/caseOptions.ts`, `compiler.ts`, `session.ts`, `hqJson/caseList.ts`,
  `xform/builder.ts`, `caseOps.ts`, `caseBlocks.ts`, `captureUrlNode.ts`, `constraintMessage.ts`,
  `suite/case-list/columns.ts`, `nodesetFilter.ts`, `orderPlanOptions.ts`, `shortDetail.ts`,
  `sortKeys.ts`, `suite/displayConditions.ts`, `suite/case-search/searchPrompts.ts`,
  `searchSession.ts`, `remoteRequest.ts`, `relatedCaseProjection.ts`, and the barrels
  `predicate/index.ts`, `expression/index.ts` and `xpath/index.ts`.
- **The CSQL half, which keeps its files:** `predicate/csqlEmitter.ts` (`formatNumeric` still from
  `stringQuoting.ts`; its geopoint guard and runtime readers print trees), `expression/csqlEmitter.ts`,
  `expression/csqlRuntimeExpression.ts` (its `emitOnDeviceExpression` call becomes `toWire`), and
  `lib/commcare/lookup/cellText.ts` (`formatNumeric`, unchanged until pull request 10).
- **Validator rules that run an emitter or read the anchor model:**
  `validator/rules/caseOperations.ts`, whose two probe emissions behind
  `CASE_OPERATION_EXPRESSION_TYPE` (`validateOnDeviceExpression`, `validateOnDevicePredicate`) call
  `toWire` with the same inert lookup naming until part 03's checker replaces the probe in pull
  request 5 (part 03 §2.2); and `validator/rules/case-list/onDeviceExpressionCompatibility.ts`, which
  imports the anchor model from `xpath/wire/rowScope.ts`.
- **Preview's three record evaluators:** `lib/preview/engine/displayConditionEvaluation.ts`,
  `lookupEvaluation.ts`, `searchExpressionEvaluation.ts` (the device mode's print until pull
  request 7, §8.2).
- **The lane:** `proof/corpus/footprint.ts` (its instance ids from the serializer's set);
  `proof/native/producers/emit-predicate-evidence.ts` (`emitCaseListFilter`; its
  `lib/domain/predicate` imports switch in pull request 5) and `emit-arithmetic-evidence.ts`
  (`emitOnDeviceExpression`), both printing `serializeWire(toWire(…))`; and
  `emit-lookup-evidence.ts`, whose `sourceHashes` list reads `onDeviceEmitter.ts` and
  `termEmitter.ts` with `readFileSync` and would throw `ENOENT`: it names
  `lib/commcare/xpath/wire/fromExpression.ts`, `serialize.ts` and `instances.ts` in their place.
- **Tests beside a deleted source**, which leave with it:
  `expression/__tests__/onDeviceEmitter.test.ts` and `predicate/__tests__/caseListFilterEmitter.test.ts`
  (byte shapes, which this part does not write, §6; each refusal they hold that is not a byte shape
  moves to `fromExpression.test.ts`); `predicate/__tests__/instances.test.ts` (its refusal of
  absent lookup naming and its no-manufactured-case-dependency case move to
  `xpath/wire/__tests__/instances.test.ts`); and `predicate/__tests__/stringQuoting.test.ts`'s
  number and device-literal cases, which move to `serialize.test.ts`, its `csql` cases staying.
- **Tests not beside a deleted source**, re-pointed to `serializeWire(toWire(…))`:
  `lib/commcare/__tests__/lookupLowering.test.ts`, `reservedInstanceTags.test.ts`,
  `lib/commcare/lookup/__tests__/nativeLookupRelations.ts` (also in `emit-lookup-evidence.ts`'s hash
  list), `lib/case-store/sql/__tests__/compileExpression.harness.postgres.test.ts`,
  `lib/preview/engine/__tests__/lookupEvaluation.test.ts` and
  `lib/preview/xpath/__tests__/dateAddLowering.integration.test.ts`.
- **Comments that name a deleted file**, rewritten to name its successor:
  `lib/case-store/sql/compileLiteral.ts`, `suite/case-list/columns.ts`, `lib/export/boundaryValidation.ts`,
  `lib/deployment/locationResourcePlan.ts` and `lib/commcare/locations/readsLocationsFixture.ts`
  (whose header also cites a `predicate/instances.ts::collectAstInstances` that is no function of
  that file).

`lib/preview/xpath/generatedJavaRosaFunctions.ts`, its test, `lib/preview/xpath/__tests__/evaluator.test.ts`,
`validator/rules/displayConditions.ts` and `onDeviceExpressionCompatibility.ts` import
`geopoint.ts`'s patterns or `isValidStaticGeopointCenter`, which pull request 4 keeps, so they are
pull request 10's to re-point when it moves them.

In pull request 4 `toWire` reads its operand types from today's `TypeContext`
(`lib/domain/predicate/typeChecker.ts`), as the deleted emitters do; `ctx.types` from the checker's
typed tree replaces it in pull request 5.

### 2.7 Totality and the oracles

`toWire` and `serializeWire` are total over what the gate admits: each arm has one constructor, a
tree has no unprintable node, and the only throws are invariants the gate has already decided
(an untyped comparison, a dot step in an interpolated slot, two srcs for one id, a `hq-case`
root outside `form_filter`, a `case-id-var` outside `suite` mode). The validator's oracles stay
independent readers of the bytes and never the emitter's gate
(`lib/commcare/validator/xformOracle.ts`, `suiteOracle.ts`, `bindingResolutionOracle.ts`): each
keeps its own Lezer scan of emitted text (today's `collectInstanceRefs` moves into
`suiteOracle.ts` as the oracle's private reader), and gains one check, `XFORM_UNREAD_INSTANCE` /
`SUITE_UNREAD_INSTANCE` (class `oracle`), a declared instance no XPath of its scope reads, so the
derivation is held exact from both sides.

---

## 3. Finding 56: the instant lowering

### 3.1 The parse

`lib/commcare/xpath/wire/instant.ts::instantMicros(t: WireExpr): WireExpr` builds the tree whose
canonical print, for an operand printed `T`, is exactly:

```
((floor((number(substr(T, 0, 4)) - (number(substr(T, 5, 7)) <= 2)) div 400) * 146097 + ((number(substr(T, 0, 4)) - (number(substr(T, 5, 7)) <= 2) - floor((number(substr(T, 0, 4)) - (number(substr(T, 5, 7)) <= 2)) div 400) * 400) * 365 + floor((number(substr(T, 0, 4)) - (number(substr(T, 5, 7)) <= 2) - floor((number(substr(T, 0, 4)) - (number(substr(T, 5, 7)) <= 2)) div 400) * 400) div 4) - floor((number(substr(T, 0, 4)) - (number(substr(T, 5, 7)) <= 2) - floor((number(substr(T, 0, 4)) - (number(substr(T, 5, 7)) <= 2)) div 400) * 400) div 100) + (floor((153 * ((number(substr(T, 5, 7)) + 9) mod 12) + 2) div 5) + number(substr(T, 8, 10)) - 1)) - 719468) * 86400 + number(substr(T, 11, 13)) * 3600 + number(substr(T, 14, 16)) * 60 + number(substr(T, 17, 19)) - if(if(contains(translate(substr(T, 19), 'Z+-', '|||'), '|'), substring-after(translate(substr(T, 19), 'Z+-', '|||'), '|'), '') = '', 0, if(contains(substr(T, 19), '-'), -1, 1) * (number(substr(if(contains(translate(substr(T, 19), 'Z+-', '|||'), '|'), substring-after(translate(substr(T, 19), 'Z+-', '|||'), '|'), ''), 0, 2)) * 3600 + if(string-length(if(contains(translate(substr(T, 19), 'Z+-', '|||'), '|'), substring-after(translate(substr(T, 19), 'Z+-', '|||'), '|'), '')) > 2, number(substr(if(contains(translate(substr(T, 19), 'Z+-', '|||'), '|'), substring-after(translate(substr(T, 19), 'Z+-', '|||'), '|'), ''), 3, 5)) * 60, 0)))) * 1000000 + if(starts-with(substr(T, 19), '.'), round(number(concat('0', substring-before(concat(translate(substr(T, 19), 'Z+-', '|||'), '|'), '|'))) * 1000000), 0)
```

This is the native lowering run's `instantMicros` with the guarded offset,
`if(contains(tr, '|'), substring-after(tr, '|'), '')`, printed canonically (Executed during
planning: the lowering probe reproduces the run's Java text character for character and prints it
canonically, and the canonical text parses with Nova's grammar). It is days from the civil date
(era arithmetic) times 86,400, plus the clock, minus the written offset, in whole seconds, then
microseconds plus the rounded fraction: an integer below 2^53 until the year 2255, so equal
instants are equal doubles.

Why this one and not `instantDays` (the same parse in fractional days): in the native lowering run
both ordered 131 of 131 rows and passed 91 of 91 checks in every zone setup, both found no wrong
pair among 3,000 same-instant spelling pairs, 3,000 distinct pairs and 1,500 six-digit pairs a
microsecond apart, and their sizes differ by 1.5 %: 1,838 against 1,811 bytes per text operand
`/data/t0_0` in the canonical print (the run's unspaced Java texts are 1,755 and 1,730 bytes).
Integer microseconds make `=` exact by construction rather than by the measured absence of
rounding error, and the folded literal is an integer HQ's six-digit spelling round-trips into.

What it reads (the run's `malformed` and `value` rows): `Z`, `±HH`, `±HH:MM`, no offset (read as
UTC: Nova and HQ never write one, and HQ's receiver rewrites every received date and time to
`…Z`, `corehq/form_processor/utils/xform.py::adjust_datetimes`, as the Elasticsearch offset run
showed), and 0, 3 or 6 fraction digits. Blank text is NaN, so an ordering is false and `!=` true.
It never throws: Core's `substring-after` returns the whole string when the separator is absent
and `substr` returns `''` past the end (`org/javarosa/xpath/expr/XPathSubstringAfterFunc.java::substringAfter`,
`XPathSubstrFunc.java::substring`), which is what the guard is for. Of the 28 other spellings the
run tried, 20 are NaN and eight give a number: a nine-digit fraction, which reads correctly, and
seven malformed shapes (`2026-01-02 04:30:00Z`, `2026-13-45T99:99:99Z`, a bare trailing `+`, `-`
or `.`, `T-4:30:00Z`, `04:30:00e5Z`). None of the seven is a spelling Nova, HQ or a device writes,
so the lowering's answer for them is defined (a number, no throw) and not a claim of validity.

### 3.2 The instant text of each operand

The lowering is chosen per operand from its `NodeType` (part 01 §3.1), never by wrapping the
comparison. `T` is the operand's instant text:

| Operand: data type, held | `T` | Why |
|---|---|---|
| `datetime`, held `string` (a case property row in `casedb` or `results`, a Hidden Value under an `xsd:string` bind, a lookup column, a worker or session value, a Search answer, `last_modified` in `results`) | the operand itself | the text is the instant; bare it is NaN to `FunctionUtils.java::toNumeric` |
| `datetime`, held `date` (a date-and-time question, a Hidden Value bound `xsd:dateTime`, `now()`) | `format-date(coalesce(x, ''), '%Y-%m-%dT%H:%M:%S.%3%Z')` | `coalesce` unpacks the node first, so Core's `format-date` does not round it (`datetimeCaseValue.ts::datetimeCaseValueExpression`'s own comment; in the Preview parity run, Preview's row `o2d` agrees and rows `o2a` to `o2c` do not round, which this shape never relies on); the text carries the device's offset, so the parse is zone-free (native lowering run: `fmt(/data/dt0)` differs per zone, its instant does not) |
| `datetime`, a literal | folded at emission (§3.5) | |
| `datetime-coerce` of a `date` held `date` (a date question, `today()`) | `concat(format-date(coalesce(x, ''), '%Y-%m-%d'), 'T00:00:00Z')` | the date's UTC midnight (outline requirement 4; `lib/domain/predicate/CLAUDE.md`, the UTC-day rule); native lowering run: `20455` for the typed date `d1` in every zone |
| `datetime-coerce` of a `date` held `string` | `concat(x, 'T00:00:00Z')` | native lowering run: `20455` for `2026-01-02` in every zone; blank gives `T00:00:00Z`, NaN |
| `datetime-coerce` of a `datetime` | that operand's own row | the coercion is the identity on an instant |
| `datetime-coerce` of an `int` (epoch days, part 06 §3.5) | no parse: `x * 86400000000` | part 06 refuses a non-integer operand on a device |
| `if`, `coalesce`, `switch` whose result is `datetime` | each branch's `T` in the same arm: `if(c, T1, T2)` | one parse over the chosen text; branches with different held representations each take their own row |
| `date_opened`, `last_modified` in `casedb` (data type `datetime`), held `date` (day only) | none: §3.4 | |
| `last_modified` in a `results` or `results:inline` row, held `string` | the operand itself | HQ's six-digit `…Z` text (`corehq/ex-submodules/casexml/apps/case/xml/generator.py::CaseDBXMLGenerator.add_base_properties`, `datetime_to_xml_string`); the row stack carries its root (part 01 §3.2) |
| `date_opened` in a `results` or `results:inline` row (data type `datetime`), held `string`, a UTC day | none: §3.4's day rule | HQ writes the UTC day only (`V2CaseXMLGenerator.add_custom_properties` → `date_to_xml_string` → `json_format_date`), so its instant text would be NaN and every comparison false |
| the other side of `=`, `!=`, `in` or `switch` when it is not `datetime` (the blank literal `''`, text, a number) | none: the comparison stays bare (§3.3) | an equality is lowered only between two instants |

Where one operand is `datetime` and the other's data type is unknown (a Hidden Value in a type
cycle, part 01 §3.2), the unknown side takes the row of its held representation, which is always
known from its bind or leaf. Two unknown operands stay bare: Core's coercion is then the
expression's meaning. A `date` against a `date` stays bare (requirement 3), and a `time` ordering
and a `date` against a `datetime` without a coercion never reach emission (part 03 §3.1, §3.2).

**Implementation correction, 2026-10-19:** the first row's "a Hidden Value under an `xsd:string`
bind" holds `string` only when its result is text. A `Date` result there (`now()`, a date-and-time
question, an `xsd:dateTime` Hidden Value copied) is held `date` with its clock lost (`DateData`,
`Recalculate.java::wrapData`), and a `default_value` of a `Date` under `xsd:string` holds its day's text
(`SetValueAction.java::processAction`); neither has an instant text, so the checker refuses such an
operand (decision 13) and `instant.ts` takes no row for it. A Hidden Value copying date-and-time
text is held `string`, never lost, and keeps the first row.

### 3.3 Which comparisons

`toWire` lowers both operands of `lt`, `lte`, `gt`, `gte` when either is `datetime` (the checker
has already refused an ordering of a date and time against anything that is not one, part 03 §3.2,
so the other side is a date and time too, or unknown by §3.2's cycle rule); `between` as its two
comparisons; `eq` and `neq` when both operands are `datetime`; `in` as its `or` of equalities,
each lowered when the value is `datetime`, with each literal value folded; `switch` on a
`datetime` as its `if` chain, each equality lowered when the case value is `datetime`. Lowered
equality is Core's numeric equality of two integers
(`org/javarosa/xpath/expr/XPathEqExpr.java::testEquality`: two `Double`s are equal when
`Math.abs(fa - fb) < 1.0e-12`), so two instants are equal exactly when their microseconds are, and
NaN equals nothing. The equality lowering covers form logic as well as record slots, because a
device that compared two dates and times by text would disagree with HQ's search and Postgres on
the same values.

An equality whose other side is not `datetime` stays bare. Its commonest form is the blank test
`x = ''` (or `!=`): `''` names no instant, so lowering it would make every blank test false, and
bare it is Core's text equality, which is the test's meaning today (`testEquality`'s last arm).
Every date-and-time equality production holds is such a blank test, `= ''` against a Hidden Value
typed `datetime` (the third production shape scan: against a value of `if(…, now(), …)`, against
`now()`, and against a Hidden Value that writes a date-and-time property), and production holds no
equality between two dates and times in either rule set. So the equality lowering changes no
production byte; it is what makes `seen = <instant>` true on a device for every spelling of that
instant (finding 75's device half, part 06 §3.13).

It applies in every target a device evaluates: XForm binds, setvalues, outputs, itemset filters
and repeat counts; suite datum filters, detail calculations, display conditions, search prompt
defaults, required and validation tests and itemsets; form-link conditions and datums; case
operation conditions; and every runtime segment of `_xpath_query` (a runtime choice's condition, a
runtime value, part 06 §3.10). It never applies in CSQL text: a node in a `query`, `anchor`,
`server-value` or `raw` position is printed by `printCsql`, and HQ compares instants itself
(`corehq/apps/case_search/xpath_functions/comparison.py::_create_system_datetime_query`,
`::case_property_range_query`). Postgres compiles instants natively (`lib/case-store/sql`),
unchanged.

`=` between two blank date-and-time answers was true and is false from step 3 (NaN equals
nothing); `!=` between them was false and is true. An instant comparison is about instants and a
blank has none, as an ordering already treats it; `is-blank` or `= ''` is the test for a blank, and
stays bare. This is a change of meaning on blanks only (Departures). Production holds no equality
between two dates and times, so it changes no stored app's answer today.

### 3.4 `date_opened` and `last_modified` on a device

Core puts them in `casedb` as `DateData` (`CaseChildElement.java`, the lines building
`date_opened` and `last_modified`), which unpacks to a `Date` rounded to the device's day, so no
instant exists on the device. HQ's search and Postgres hold the instant.

- **Ordered against a day-aligned operand** (a `datetime-coerce` of a `date`): a comparison by
  day, with today's bytes: `<prop> <op> date(<date operand>)` (Core's `FunctionUtils.java::toNumeric` of both
  is the day count). The corpus's one case is `targeted-search-hq-compile` (`date_opened >=
  datetime-coerce('2026-01-01')`, `proof/targeted/documents/searchApps.ts`), whose suite nodeset
  `date_opened >= date('2026-01-01')` is byte-stable. HQ's search compiles the same filter as an
  instant against UTC midnight; the two can differ only for a case opened on the boundary day,
  which is the device's day-only data, stated in the public docs.
- **Ordered against any other `datetime` operand** in a slot whose targets include `XF` or `SU`,
  and **compared by `=` or `!=` with any `datetime` operand**, day-aligned included (a day is never
  equal to a moment): refused. Against a `date` operand the comparison is part 03's `date-datetime`
  instead (part 03 §3.2). Part 03 carries the rule:
  form logic `XPATH_INCOMPATIBLE_VALUES` with `details.reason: "day-only-on-device"`, record slots
  their `*_TYPE_ERROR`. Copy: `"<slot>" compares when the case was opened with a moment. On a
  device CommCare keeps only the day a case was opened, so it can't tell. You can compare it with a
  date instead.` (and "last changed" for `last_modified`). The corpus has none that this refuses.
- **Two system dates** against each other compare by day, bare.
- **Read from `results` or `results:inline`**, `last_modified` is text in HQ's six-digit spelling
  (`casexml/apps/case/xml/generator.py::CaseDBXMLGenerator.add_base_properties`) and lowers by the
  first row of §3.2. `date_opened` is the UTC day as `YYYY-MM-DD` text there (`CaseDBXMLGenerator`
  inherits `V2CaseXMLGenerator.add_custom_properties`, which writes `date_to_xml_string(opened_on)`,
  `corehq/ex-submodules/dimagi/utils/parsing.py::json_format_date`), a day again: ordered
  against a day-aligned operand it compares bare, by day, because Core's `toNumeric` turns
  date-only text into its day count (`FunctionUtils.java::toNumeric`, `attemptDateConversion`);
  ordered against any other `datetime` operand, and compared by `=` or `!=` with any `datetime`
  operand, day-aligned included, it is refused with the same reason. A lowered comparison of it
  with a moment would read NaN and always be false. The rule lands with pull request 9, instances and session, which makes the read authorable; no stored
  document can hold such a read today, since production holds no `results*` read (part 05 §2.8).
  Their held representation therefore depends on the row's instance root (part 01 §3.2; part 07
  agrees).

Production compares neither property anywhere (the third production shape scan: no comparison or
ordering with `date_opened` or `last_modified` on either side, in form logic or in a record slot).
The few raw `casedb` reads of a system date production holds sit in no comparison. So the refusal
meets no stored app; the dry run counts it again, and a non-zero count is a `target-gate` blocker
the author resolves before the window (§5.5; part 09 §11).

### 3.5 Folding, and `now()`

- A `datetime` literal operand, and a `datetime-coerce` of a `date` literal, fold at emission in
  `instant.ts::foldInstant` to the integer microseconds, so the comparison carries one parse:
  `2026-01-01T00:00:00Z` is `1767225600000000`, and `2026-01-02T10:00:00.000+05:30` and
  `2026-01-02T04:30:00.000000Z` are both `1767328200000000` (Executed during planning, the
  lowering probe; the same integers the native lowering run's `micros` column holds). The checker
  has already refused a literal no instant spelling reads (part 03 §3.2, the literal typing of
  part 01 §3.2).
- `now()` is not hoisted. A form bind evaluates once per trigger, so the per-row cost appears only
  where a row is iterated: a casedb predicate in a form, a suite datum filter, a detail column.
  There the native lowering run measured, per 1,000 cases in each of its ten zone setups, 37 to
  52 ms against `now()` re-formatted per row, 17.6 to 18.6 ms against a folded literal, 22.0 to
  25.2 ms with both sides parsed, and 2.2 to 3.5 ms for the bare comparison that answers nothing.
  A generated node holding the lowered `now()` would read the clock when that node recalculates,
  not when the comparison does; XPath has no binding form in a suite.

### 3.6 Inline, and the generated-node alternative

The lowering is printed inline in every position. A generated Hidden Value per operand
(`lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`, a `nova_instant_<question>` purpose)
was the alternative in forms. Inline is decided because:

- one shape serves forms, suites, runtime segments and Preview, so import recognises one shape and
  Preview evaluates the same text the device does;
- a generated node adds an element to every submission and to HQ's form builder's tree, and
  carries no meaning an author chose;
- the suite and the runtime segments have no node to hold it, so forms would be a second shape;
- `now()` read in a node changes when it is read (§3.5).

Because nothing is hoisted, part 07's constraint on a hoisted operand (it may hold only a String or
a number, since Preview inlines it) constrains nothing here; it binds any later step that adds a
generated operand.

The existing `nova_datetime_<question>` sibling (step 2, `datetimeCaseValue.ts`) is not reused as
the operand: it exists only for a date-and-time question that writes a case
(`builder.ts`, the `"caseWrite" in field` guard), and using it would make the operand's spelling
depend on whether the question writes.

### 3.7 Vellum, HQ JSON, the runtime segment, Preview, import

- **Vellum.** The shadow is printed from the same tree (decision 11), so `vellum:calculate` holds
  the lowering with `#form/` operands and the real `calculate` the same with `/data/` operands.
  Vellum's parser is js-xpath (`xpath.js::createParser`), which parses any function call, and its
  analysis checks only `/`-rooted paths and hashtags (`logic.js`). **Executed (the spellings
  witness run, GitHub Actions runs 39060796573 and 39061476968, lane without served readers over a
  planning witness document):** a lowered comparison in a Hidden Value's `calculate` and
  `vellum:calculate` went through HQ's import and build and proof 4's two form builder saves, and
  both saves of each form left one source (4 save records per form, 1 distinct saved text,
  identical in both runs). What Vellum rewrote decides three things here:
  - **The lowering survives a save, structure intact.** In each lowered attribute, real and shadow
    alike, the save changed whitespace only: it added a space after every comma (166 in a
    typed-against-text comparison, 83 in a text-against-folded one) and either side of every `*`
    the author had written tight (8 and 4), and nothing else. So an HQ save does not revert the
    lowering, which is what the shadow is for.
  - **Canonical text is a fixed point.** The witness's canonically written Hidden Value
    (`if(#form/n + 1 - 2 > 5 and #form/n < 9 and #form/n != 5, 'big', 'small')`) came back
    byte-identical, while its author-spelled twin was respelled (`((/data/n+1)) - 2 > 5.0 and (…)`
    became `(/data/n + 1) - 2 > 5. and (…)`: one redundant pair dropped, spaces round `+`, `5.0`
    written `5.`, the double-quoted `"big"` and the parenthesised `and` kept). Vellum's spacing is
    therefore the canonical spacing (decision 3), and its own number and parenthesis spellings are
    not canonical ones, which is why the canonical print takes Vellum's spacing and nothing else of
    its spelling. Core and HQ answered both spellings `big` on every export (the intent check).
  - **`#case/` on a selected-case projection.** The Check form's Hidden Value
    `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/case_name`,
    emitted with no shadow, came back with `vellum:calculate="#case/case_name"` and the head elements
    `<vellum:hashtags>` and `<vellum:hashtagTransforms>`. That is HQ's editor writing its own
    `#case/` on save, as `lib/commcare/CLAUDE.md` ("Vellum dual-attribute pattern") says it does for a
    listed property, and proof 4 erases it; Nova writes no such shadow (decision 11, Departures).
    The save also added shadows to Nova's generated nodes (`vellum:calculate`, `vellum:nodeset` and
    `vellum:relevant` on `nova_datetime_stamp`, `nova_trimmed_name` and `nova_count_visits`, and a
    `nodeset` pair on the repeat's bind); those follow step 2's generated-node rule, which this
    part does not change, and proof 4 held with them.

  The witness carried the planning `instantDays` text with the author's spacing, not
  `instantMicros` printed canonically (§3.1); what it shows about Vellum is about spacing and
  structure, which the two share. With every reader the witness's bytes held (run 39064333759,
  part 08 §6.4): Formplayer, the Web Apps client and Android read the lowered text in UTC as Core
  does, and proof 4's served saves keep it; the shipped `instantMicros` bytes are pull request 8's
  reader dispatch (§6). The consequence for a person is plain: opening such a form in HQ's form builder shows the lowered
  comparison in the question's logic field, a long arithmetic expression where the author wrote
  `#form/start < #form/end` (the "Visit instants" form's HQ upload grows from 1,442 to 19,050
  bytes, §5.3). The shadow has to carry the lowering: Vellum prefers the shadow on load
  (`parser.js::parseVellumAttrs`, §2.3), so the expression an HQ save writes back is the one the
  shadow held, and a shadow holding the bare ordering would put the defect back at the next HQ
  save. Step 6 recognises the shape on import (below), so a round trip shows the author's
  comparison again.
- **HQ JSON.** The lowering holds no dot step, no replaced substring and no instance id; its
  literals are `'Z+-'`, `'|||'`, `'|'`, `'0'`, `'-'`, `'.'`, `'%Y-%m-%dT%H:%M:%S.%3%Z'`,
  `'%Y-%m-%d'` and `'T00:00:00Z'`, each quoted, so `dot_interpolate` keeps them (§2.3).
- **Runtime segments.** A segment is a wire tree; the lowering is inside it before quoting, and
  part 06's quote cascade wraps the segment's value, never the lowering's text.
- **Preview.** Preview evaluates the `preview` print of the same tree. The Preview parity run found
  Preview's evaluator equal to Core's for every text operand in four zones, and for typed operands
  except inside a repeated DST hour, where Preview's held typed value differs; part 07 fixes that
  difference and Preview's non-rounding `format-date(node)` and `date(node)` before any lowering
  relies on Preview (part 07 §2.1, §2.2, decision 3), and the lowering's shape relies on neither:
  its `format-date` reads `coalesce(x, '')`, which unpacks first.
- **Import (step 6).** The lowered shape is recognisable and invertible: the template of §3.1 with
  one operand subtree `T` repeated, carrying the constants `719468`, `146097`, `'Z+-'` and `'|||'`;
  `T` is the operand, or `format-date(coalesce(x, ''), '%Y-%m-%dT%H:%M:%S.%3%Z')` around a typed
  operand `x`, or `concat(<date>, 'T00:00:00Z')` around a coerced date; an integer opposite a
  lowered operand is a folded literal, lifted back as its `…Z` spelling. This plan's own pull
  request writes this recognition rule into `docs/plans/hq-round-trip/6-import.md`, so a Vellum
  save that keeps the shadow round-trips to the ordering. The function that recognises it is step
  6's: in step 3 nothing reads lowered text back.

### 3.8 `datetime-coerce` on a device

Today `onDeviceEmitter.ts` writes `date(x)` for both coercions, and Core's `toDate` of a `Date`
rounds it to the device's day (`FunctionUtils.java::toDate`), so `datetime-coerce(now())` is
midnight and every ordering over it is a day comparison. From step 3:

- inside a comparison, the operand enters the lowering by §3.2's rows;
- as a value (a case operation write, a calculated column, a `format-date` operand), it prints the
  instant as text: a date as `concat(<Y-M-D text>, 'T00:00:00.000Z')` under a blank guard
  (`if(<x> = '', '', …)`), date-and-time text as itself, a typed instant in
  `datetimeCaseValue.ts::datetimeCaseValueExpression`'s shape, an epoch day as the date of
  `date(<int>)` at midnight UTC;
- `date-coerce` is unchanged: `date(x)`. Its day of a typed instant is the device's day, as Core's
  `date(now())` is today's `today()`; its day of date-and-time text is the text's written day, and
  Core throws on malformed text there as it does today (`FunctionUtils.java::toDate`), which is
  the author's `date()`, not a lowering Nova adds (requirement 5 is about the lowering, which never
  applies `date()`). Part 03 §3.2's copy, "You can wrap the date and time in date() to compare
  days.", stands; the public docs line in §7 says which day each gives.

The corpus's device-side `datetime-coerce` reads are `targeted-search-hq-compile` (§3.4, stable)
and `function-nested-lookup`, whose suite nodeset `last_seen = date(<lookup time_text>)`
(`lib/commcare/__tests__/csqlFunctionFixture.ts`, `eq(prop("patient", "last_seen"),
datetimeCoerce(value("time_text")))`) becomes the lowered equality of two texts. The native family
`function` re-observes it (§6).

Production holds no `datetime-coerce` in any record slot (the second production shape scan's
record value census holds `date-coerce` and no `datetime-coerce`), and form logic has no spelling
of it, so decision 9 and the coerced-date departure change no stored app's bytes.

### 3.9 Size, and the cost of the gate

**Executed (the spellings witness run, 39061476968: the bytes HQ received and the bytes its form
builder saved).** Each comparison sits in the witness's `if(<comparison>, 'ordered', 'not
ordered')` Hidden Value calculate, in the planning `instantDays` text at the author's spacing
(§3.7):

| Comparison (witness) | In the form (attribute text) | In Nova's XForm file (XML-escaped) | After a form builder save (text) |
|---|---|---|---|
| typed against text (`stamp_after_before`) | 5,173 | 6,564 | 5,355 |
| typed against text, the other way (`stamp_before_after`) | 5,143 | 6,534 | 5,325 |
| text against the clock folded (`before_folded`) | 1,833 | 2,240 | 1,924 |

The save's growth is its added spaces alone (§3.7). Its own file escapes fewer characters than
Nova's (5,406 bytes for the first row's attribute: Vellum escapes `<` and `>`, Nova's serializer
escapes every `'` as well, 268 of them there), which changes nothing a reader parses. **Plan on
about 5.4 KB per typed-against-text comparison in a form, 6.8 KB in Nova's file**, as the rows
below confirm for the shipped text.

**The shipped text, printed canonically** (Executed during planning, the lowering and
recanonicalisation probes, over `instantMicros` and the canonical print of decision 3; bytes):

| Comparison | Text | XML-escaped |
|---|---|---|
| bare `/data/seen < /data/due` | 22 | 25 |
| text against text | 3,649 | 4,420 |
| text against a folded literal | 1,707 | 2,094 |
| typed against text | 5,269 | 6,640 |
| text against `now()` | 4,969 | 6,340 |
| a coerced date against text | 5,389 | 7,060 |
| typed against typed | 6,859 | 8,830 |
| the witness's typed-against-text Hidden Value, `instantMicros`, canonical | 5,389 | 6,780 |
| the witness's text-against-folded Hidden Value, `instantMicros`, canonical | 1,947 | 2,354 |

The canonical print of the witness's uploaded texts is 5,335, 5,305 and 1,914 bytes, and the
canonical print of what the save wrote back is the same three texts, so the save changed no
structure; the canonical print is 20 bytes shorter than the saved text (10 for the folded one)
because it drops the redundant parentheses the author wrote and Vellum keeps. With
`instantMicros`, the witness's two Hidden Values print 5,389 and 1,947 bytes (the last two rows),
0.6 % and 1.2 % above what the save wrote, so the witness's measured sizes stand for the shipped
text. Every size in this part is of canonically spaced text: the probes join arguments with `", "`
and space every binary operator, and no canonical print they made holds a comma without its space.

Core's parser has no length limit, and in the native lowering run parsed ten lowered comparisons
or-ed together, 50,266 bytes of unspaced `instantDays` text, in 17.5 to 20.1 ms; the same ten in
`instantMicros` printed canonically are 52,426 bytes, 4 % longer, which the run did not time.

The emitter runs inside the deep validator's compile on every gated batch
(`builder.ts`, the `shorthandMemo` docblock); the memoised print keeps each comparison linear in
its bytes, and only date-and-time comparisons pay it (2 in the corpus's 1,314 fields, part 03's
shape scan; in production a few orderings, each `now()` against a date-and-time question read
relatively, and no equality between two dates and times).

---

## 4. The other emission changes the model brings

Each row is `toWire`'s print of a new or widened arm (part 01 §1.3–1.4), and its declaration from
part 05 §2.1.

| Arm | Wire (`xform` / `suite`) | Declares | Bytes today |
|---|---|---|---|
| `cases { source: "casedb" }`, `project`, row `prop`, `case-row-type`, `case-index`, `case-type` | `instance('casedb')/casedb/case[<p1>][<p2>]/<value>`, `@case_type`, `index/<id>`, `'visit'` | `casedb` | text today, the same path at canonical spacing (production holds such queries, read as text) |
| `cases` whose custom property read is bound to its one declaring case type (no `@case_type` literal and no `@case_id` from a known source, part 05 §2.2) | the stored where-clause only: the bound type prints no predicate | `casedb` | unchanged. Production's queries with no row type are, by part 09's probe, standard reads that need no type, reads that bind to one type, reads that match several (cutover blockers), and reads typed by `@case_id` from a known source after all (declarations). Printing `[@case_type = '<type>']` would change which rows match, since a case of another type can hold an undeclared property of that name; the bound type is the reader's type and rename identity, not a filter |
| `cases` or `table-rows` used as one value (admitted) | the path as stored, with no `[1]` added | its root's | unchanged: Core throws at run time on more than one node, as today, and `[1]` stays the author's spelling for the first |
| a read of a repeat's answer from outside the repeat, used as one value (refused from pull request 6; the cutover step `repeat-read-first-row`, written in pull request 13, lifts each stored one to its first row, reason `repeat-read-takes-first-row`) | `/data/<repeat>[1]/<field>` (the `[1]` a filter on the repeat step, which the printer prints from pull request 5) in the real attribute; the slot's shadow is withheld, because a `#form/` read with a predicate is one of §2.3's withheld shapes | none | changed at the cutover: production's few such reads (in `concat` and `selected`) gain `[1]`, the one value Core reads from them without failing |
| `cases { source: "search-results" }` in an inline-search module's forms | `instance('results:inline')/results/case[…]/<value>`, the row typed by the module's searched case type (part 05 §2.8) | `results:inline`, `jr://instance/remote/results:inline` (`session.ts::INLINE_SEARCH_RESULTS_SRC`; HQ `post_process/instances.py::remote_instances` and `suite_xml/utils.py::is_valid_results_instance_name` give the same) | new (production holds no `results*` read); a row's `date_opened` takes §3.4's day rule and its `last_modified` lowers by §3.2 |
| `table-lookup`, `table-rows`, `table-column` in form logic | XForm `instance('<tag>')/<tag>_list/<tag>[<where>][1]/<col>`; form link `instance('item-list:<tag>')/…` | XForm `<tag>`, `jr://fixture/item-list:<tag>`; suite `item-list:<tag>` | new (form logic cannot name a table today) |
| `locations`, `location-field`, `location-level` | `instance('locations')/locations/location[@type = '<code>'][…]/<value>`, `@<code>_id`, `location_data/<slug>` | `locations`, `jr://fixture/locations` | new in form logic; `owner-location-at-level` unchanged |
| `selected-cases { module }` | `instance('<datum id>')/results/value` | `<datum id>`, `jr://instance/selected-entities/<datum id>` | the batch blocks' read, unchanged; used as one value it is refused (`XPATH_MANY_VALUES`), so it prints only under a node-set consumer |
| `term session-datum` (form logic and form links from pull request 5; from pull request 10 a `selected-case` datum in three record slots, part 05 §1.4) | `instance('commcaresession')/session/data/<id>`, `<id>` from `ctx.datumId` (part 05 §1.4; in HQ JSON's case list filter the id before root alignment, §2.2) | `commcaresession` | unchanged ids (part 05 decision 3 keeps the case block's id); production's session datum reads are all `selected-case` |
| the chosen case's property in a record slot (from pull request 10: `project` over `cases { casedb }` keyed on a `selected-case` datum, part 01 §4) | `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/<id>]/<property>`, as every `project` prints, in `suite` mode in a case-list filter and a form's display condition, and inside a CSQL runtime segment (part 06 §3.9); HQ JSON's `case_details.short.filter` and `form_filter` print the same text, which holds no token `interpolate_xpath` replaces and no dot step (§2.3) | `casedb`, `commcaresession` | new; production holds no datum read in a record slot |
| `term session-context` (seven fields stored; `drift`, `window_width` and `applanguage` authored from step 4) | `instance('commcaresession')/session/context/<f>` | `commcaresession` | unchanged for the four |
| `session-user(-property)`, `source: "worker-record"` | today's `#user/` casedb walk in an `expansion { of: "worker" }` | `casedb`, `commcaresession` | unchanged |
| `itext { unit }` | `jr:itext('<itext id>')`, the id from `lib/commcare/xform/itextIds.ts::itextIdFor(doc, unit)` (new; the `itextKey + "-label"`, `-hint`, `-help`, `-constraintMsg`, `-opt<i>-label` spellings `builder.ts` writes today) | none | new; `constraintMessage.ts`'s `jr:itext('<id>;__nova_mode')` is the same call |
| `choice-name { field, value }` | `jr:choice-name(<value>, '/data/<generic path>')`: Core resolves the second argument with `RestoreUtils.ref` and `FormDef.findQuestionByRef` (`org/javarosa/core/model/FormDef.java::initEvalContext`), so it is the absolute path without positions | none | new |
| `here` | `here()` in suite detail and menu slots only | none | unchanged |
| `choice { field, options }` | the options' current values, space-joined for several, as one string literal | none | unchanged: production's many literals that match an option lift to `choice` and print the same value until an option's value is edited, when they reprint; those that match none stay text literals |
| `arith div` / `quotient` | `a div b` / `if(r = 0, l div r, (l - l mod r) div r)` | none | unchanged meaning; part 01 decision 5 stands as the model's rule, and the cutover lifts nothing to `quotient`, because production's record slots hold no `div` |
| `call` | `<fn>(<args>)`; `is-selected` prints `selected` and `concat()` the literal `''` (part 01 §2.1) | none | none in the corpus (census §5.1) or in production (no `is-selected`, no `concat()`) |
| `negate` | `-x`, `-(a + b)` | none | none in the corpus or in production |
| catalog `properties[].required`, `.validation`, `.validation_msg` | none: the slots retire (decided with the person, 2026-10-17) and `carriers.ts::authoredXPathCarriers` loses the `wire-catalog` profile | none | no emitter writes them today, so the retiring values production holds move no byte |
| `value-list` | CSQL only (part 06 §3.6); an item may be a node-set, flattened by `join` (part 06) | none | none: no step authors it; it is held for step 6's import (part 06 §3.6) |
| `groups`, `group-field`, search `input` in an inline-search module's ordinary forms, `device-query` datums | none in step 3 (deferred: step 7 group 2, step 4, step 4) | none | none |

The dependency on Preview for each new read (the instance Preview builds) is part 07's; `preview`
mode prints the same tree.

---

## 5. The byte-change census

### 5.1 Canonical printing

Executed during planning: a prototype of the serializer's canonical print over today's emitted
XPath text (Lezer parse with Nova's grammar, then the §2.3 rule), run over every XPath attribute of
the fresh host emission of the corpus (371 documents): each local archive's XForms and
`suite.xml`, each HQ upload's XForm attachments, and the XPath strings of each HQ app JSON
(`filter`, `module_filter`, `form_filter`, `xpath`, `default_value`, `test`, `defaultValue`,
`search_button_display_condition`, `blacklisted_owner_ids_expression`, and a column's `field` when
`useXpathExpression`). Seven suite `value` attributes did not parse; all seven are the `<query
value>` URL, which is not XPath.

| Target | Attributes | Changed | Spacing only | Fewer parentheses | Documents carrying / changed | Bytes before → after |
|---|---|---|---|---|---|---|
| HQ upload XForms (with shadows) | 8,757 | 92 | 51 | 41 | 364 / 45 | 254,171 → 254,269 |
| HQ app JSON XPath | 458 | 148 | 84 | 64 | 121 / 67 | 75,656 → 76,470 |
| local archive XForms | 19,763 | 247 | 206 | 41 | 364 / 142 | 591,106 → 591,514 |
| local archive suite | 4,244 | 637 | 583 | 54 | 261 / 236 | 202,989 → 205,757 |

- Documents whose HQ-bound bytes change (XForm or HQ JSON): **105 of the 366** that send HQ
  XPath. In any target: 243 of 371.
- Per changed document: HQ XForms 1–2 attributes in 31 documents, 3–5 in 14; HQ JSON 1–2 in 50,
  3–5 in 14, 6–10 in 3.
- No shadow changed, and no requoted literal, respelled number, `is-selected` or `concat()`
  occurs: the corpus's authored form logic is already spaced canonically. What changes is Nova's
  own scaffolding: `[@case_type='patient'][@status='open']` (the suite's datum filters, most of
  the 583), `@case_id=instance(…)` in preload setvalues and in HQ JSON calculated columns
  (`current()/../case[@case_id=current()/index/parent and @case_type='household']/rank`), the
  integer-division lowering's parentheses, and the parenthesised `and` inside `or` of the capture
  and guard conditions.
- Production's authored expressions (the second production shape scan, the canonical print of
  every stored expression): a small share print differently, in a minority of apps. By class, the
  most are redundant parentheses, then double-quoted literals that need no double quotes, then
  number spellings, spacing only, and a relative path re-derived; by slot, `calculate`,
  `validate`, `relevant`, `default_value` and Connect. No `is-selected`, no `concat()`, and no
  stored expression of the shape where a looser parenthesis rule would have printed another value
  (`a = (b = c)`, `a * (b mod c)`). The scan's printer drops the parentheses of a same-precedence
  right operand when the value is unchanged (`a + (b - c)`, `a * (b div c)`), which decision 3
  keeps because the tree is not, so its count is an upper bound. The scan reads stored
  expressions, not emitted bytes, so Nova's scaffolding (the datum filters, preload setvalues,
  calculated columns and integer-division and guard parentheses above) is not in it. Every app
  with a case list carries some of that scaffolding, so far more production apps change bytes than
  the scan's authored count shows; the dry run's emission at base and head gives the number (§5.5).

### 5.2 Instance declarations

Executed during planning: a probe compared each emitted XForm's declared instances with the
instances its XPath reads (Lezer: an `Invoke` of `instance` with one `StringLiteral`). Of 500
HQ-upload forms, 24 declare an instance nothing reads: `commcaresession` in 14 (the
`casedb`-implies-session rule over forms whose casedb reads name no datum), `selected_cases` in 8
(multiple-selection forms with no operation that reads the selection, such as
`endpoint-multiple`), `casedb` in 2 (`container-registration`,
`expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0`). The local archives show the
same 10 `selected_cases` and `casedb` cases. Derived declarations drop them. No read is
undeclared in any form. The suite comparison is not reported: a detail's XPath is evaluated in the
instances of the entry that names it, which the probe's per-element scoping does not model; the
pull request's snapshot diff lists the suite's changes, and `SUITE_UNREAD_INSTANCE` holds them.

The implementation census covers every archive and multipart body at both heads, including each
entry's referenced detail and restricted-menu scope. It also finds declarations left by the old
parallel collectors outside the planning probe's HQ-form scope. Each removed declaration must
have no read in that complete owning scope; no new or changed declaration is allowed by this
exception. Secondary declarations take the instance table's order (`casedb`, `commcaresession`,
then other ids lexically), with the primary instance and all other children unchanged. The frozen
emission normalizer stays unchanged; a separate comparison records these order-only differences.

### 5.3 The lowering on `targeted-datetime-ordering`

Executed during planning (the lowering probe): the witness's two orderings lowered, the typed pair
(`start`, `end`) through `format-date` and the text pair (`seen`, `due`, Hidden Values under an
`xsd:string` bind) directly, each printed canonically (§3.9).

| Form | Local archive bytes | HQ upload bytes (real attribute and shadow) |
|---|---|---|
| "Visit instants" (typed against typed) | 2,554 → 11,358 | 1,442 → 19,050 |
| "Check" (text against text) | 3,493 → 7,888 | 1,841 → 10,631 |
| "Book" (no ordering) | 4,470 → 4,470 | 2,261 → 2,261 |

The HQ app JSON grows by the same XForm bytes inside `_attachments` (18,206 bytes today).

### 5.4 Which documents' bytes change, and why

Once, at the next publish, for these reasons only:

1. Canonical print: §5.1 (every target), in pull request 4, the wire tree (the record family and
   the scaffolding), and for form logic in pull request 5, the shape (§8).
2. Unread declarations: §5.2.
3. Finding 56: documents with a date-and-time ordering, or an equality between two dates and
   times, on a device. Corpus: `targeted-datetime-ordering` (form logic) and
   `function-nested-lookup` (a suite nodeset). Production: a few orderings, in form logic; no
   equality.
4. `datetime-coerce` on a device: `function-nested-lookup`; `targeted-search-hq-compile` is
   byte-stable (§3.4). Production: none (§3.8).
5. The first-row lift of a structural repeat read (§4), which the cutover step
   `repeat-read-first-row` writes (pull request 13): production's few.
6. Part 06's CSQL changes: `today()` as a runtime segment (part 06 §3.4) and `eq` / `neq` / `in`
   on a `datetime` anchor as a closed instant range (part 06 §3.13). Among production's searching
   modules none uses `today()` and none compares a date-and-time property by equality, so neither
   notice reason (`search-today-is-workers-day`, `search-date-time-equality-matches`) names an app
   today.
7. New reads (lookups, locations, results, `jr:itext`, `jr:choice-name`) appear only in documents
   that author them from step 3.
8. **Binds that step 3's inference moves** (part 03 §5.2). A Hidden Value's bind keeps today's
   rule (decision 13): `fieldValueType` gives the destination property's type from the effective
   catalog, which from step 3 is `expressionFacts(doc).caseTypes` (part 03 §5.2), so a destination
   that today's catalog leaves untyped and step 3's inference types changes what `fieldValueType`
   returns. Of the types it can return, only `datetime` reaches a byte, because a Hidden Value's
   bind is `xsd:string` for every other destination (`xform/builder.ts`, the `bindType` choice
   over `BIND_TYPE_BY_KIND.hidden`). A destination newly typed `datetime` makes, for each Hidden
   Value that writes it:
   - its bind `type="xsd:dateTime"` in place of `xsd:string` (`builder.ts`, `bindType`);
   - a `nova_datetime_<question>` sibling, its bind `type="xsd:string"` (`builder.ts`) whose calculate is
     `datetimeCaseValue.ts`'s `if(x = '', '', format-date(coalesce(x, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`
     and whose `relevant` is `count(x) > 0`, named by `xform/generatedNodes.ts::planGeneratedNodes`
     (its `fieldValueType` site), with its data element (`builder.ts`, the `caseWrite` and
     `datetime` guard);
   - the case update naming that sibling, in `FormActions` (`formActions.ts`, both
     `fieldValueType` sites: an ordinary write and a `usercase_update` write), and a case name or
     external id write reading its trimmed node from the sibling (`builder.ts`, the scalar guard);
   - Preview holding the value as typed (`lib/preview/engine/formEngine.ts::computedFieldValue`).

   A property whose type moves to a conflict is a `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` finding (part
   03 §5.3 class 2), which blocks the lift, so it reaches no byte. The `xsd:dateTime` bind is also
   the one under which Core casts the value at form open, which is what finding 73's writer
   agreement holds (part 03 §4.3). Corpus and production counts need the inference itself, so the
   dry run's emission at base and head counts them (§5.5).

What the production scans show for each count this part needs:

| Count | Production | Consequence |
|---|---|---|
| date-and-time `=` / `!=` / `in` between two dates and times in a device slot | none; the equalities with a date-and-time side are all `= ''` blank tests, which stay bare | the blank-equality departure changes no stored answer |
| `date_opened` / `last_modified` compared on a device | none, in form logic or in record slots | the day rule blocks nothing today |
| date-and-time orderings (finding 56's bytes) | a few in form logic, each `now()` against a question read relatively; none among the record orderings | the few apps that hold one grow by the lowering at their next publish |
| string literals holding an interpolation token, `instance(` with a quote, or an odd trailing backslash run (§2.3) | none, in form logic or in record slots | the literal spellings move no byte |
| canonical print of authored expressions (§5.1) | a small share, in a minority of apps (an upper bound) | each moves once at its next publish; no meaning changes |
| `datetime-coerce` in a record slot (§3.8) | none | none |
| structural repeat reads used as one value | a few | lifted to the first row, notice reason `repeat-read-takes-first-row` |
| CSQL `today()`, CSQL datetime equality | none, none | no notice entry today |
| `app_changes` after the step 2 horizon | none | every count above is the state the cutover's fold starts from, until edits accrue |

### 5.5 What remains for the cutover's dry run

The dry run lifts every production document at the stack's head, read-only. Every count below
that can stop the cutover does so by rule, decided now; none waits for a decision at the window.
For this part it adds:

1. **The emitted byte census.** Emit every lifted document at base and head (the shape scans read
   stored expressions, not emitted bytes) and count, per target, the documents whose HQ-bound bytes
   change and why: canonical scaffolding (§5.1, which the authored count understates), unread
   declarations (§5.2, including multiple-selection forms with no operation that reads the
   selection, which no scan counted because they are an emission fact), finding 56, the first-row
   lift, the binds inference moves (§5.4 item 8: per app, the Hidden Values whose bind becomes
   `xsd:dateTime` and the `nova_datetime_` siblings added, beside part 03 §5.4 item 2's count of
   the properties step 3 types `datetime`), and part 06's CSQL changes. The base half runs at pull
   request 2's head, the cutover skeleton, whose base emitter's `lib` equals production's, and the
   head half at the stack's head. The census is a gate on unexplained differences: an app whose
   head bytes differ from its base bytes for no reason this list names stops the cutover, because
   that is a defect of the stack, fixed in the pull request that owns the emission and never by an
   author (part 09 §7, verdict `unexplained`). The named differences stop nothing; the notice states each app's count.
2. **The re-counts at the window.** Every count of §5.4's table is re-run over the lifted
   documents, because edits after the step 2 horizon (none at planning) accrue until the window.
   A non-zero day-rule count (`day-only-on-device`) is a `target-gate` blocker the author resolves
   in the app before the window (part 09 §11, expected none or few). A non-zero count of equalities
   between two dates and times blocks nothing: each such slot gets its
   `date-time-comparison-compares-moments` line in the notice (part 09 §6), because its change of
   meaning is on blank answers only (Departures). A non-zero hazard count blocks nothing either:
   the serializer spells each hazard safely (§2.3).
3. **The gate over the lowered documents.** Every lifted document's deep validation at the head
   emits its date-and-time comparisons through `toWire`, so a missing `NodeType` (§2.2's invariant)
   shows as a dry-run failure, a defect of the stack, never in a publish.

---

## 6. Tests and proofs

Each boundary is the smallest that can tell the failure apart (`docs/testing.md`).

| Test | Boundary | Failure it distinguishes |
|---|---|---|
| `lib/commcare/xpath/wire/__tests__/serialize.test.ts` | pure; Nova's Lezer grammar as the oracle of structure | a print that does not parse; a print whose parse is another tree (the right-operand rule: `a + (b - c)`, `a = (b = c)`, `-(a + b)`); idempotence over every tree the corpus's emission builds; a comma or binary operator printed without its space; `./.` outside `constraint` only; `#form/` only in `vellum`; a withheld shadow for each of today's withheld shapes, a selected-case projection among them (no shadow carries `#case/`); `case-id-var` printed `$case_id` in `suite` mode and throwing in every other; and, moved from `predicate/__tests__/stringQuoting.test.ts` in pull request 4, the number print's round trip of every finite double with no exponent and the device literal's `concat()` spelling of a quote |
| `lib/commcare/xpath/wire/__tests__/instances.test.ts` | pure, over part 05 §2.1's table | an arm declaring the wrong src for its target; a lookup root with the suite id in an XForm; and, moved from `predicate/__tests__/instances.test.ts`, a lookup read with absent naming refused and a self relation with constant operands declaring no `casedb` |
| `lib/commcare/xpath/wire/__tests__/instant.test.ts` (part 08 §2.3's requirements 1 to 3 and 6, at this boundary) | pure; the tree read structurally, never its text | a row of §3.2 choosing the wrong `T` (requirement 1: per operand, never a wrapper); a `date` call over `now()` or a typed answer (requirement 2); a date against a date not bare (requirement 3); an equality lowered when one side is not `datetime`, `x = ''` above all; an equality between two `datetime` operands left bare; a fold that disagrees with `Date.UTC` for each of the native lowering run's 13 offset spellings; a lowering inside a CSQL text position (requirement 6, with part 06's `positions.test.ts`) |
| `lib/commcare/xpath/wire/__tests__/fromExpression.test.ts` (new) | pure; the tree read structurally | each invariant throw of §2.7 (a `hq-case` root outside `form_filter`, a `case-id-var` outside `suite` mode, an untyped comparison from pull request 5), and each refusal that `onDeviceEmitter.test.ts` and `caseListFilterEmitter.test.ts` hold and that is not a byte shape, moved here when pull request 4 deletes those files |
| `lib/commcare/__tests__/xformOracle.test.ts`, `suiteOracle.test.ts` (extended) | the oracles over the expander corpus (`lib/commcare/__tests__/expander.test.ts`) | a read undeclared (`SUITE_MISSING_INSTANCE`) or a declaration unread (`XFORM_UNREAD_INSTANCE`, `SUITE_UNREAD_INSTANCE`) |
| `lib/mcp/__tests__/servedSchemas.test.ts` | unchanged by this part | none: this part changes no tool schema |

Byte-shape assertions on emitted XPath are not written: the parse oracle, Core, HQ and Vellum
reading the bytes are the proof.

**Native: part 08's family `expression`** (part 08 §2.1, §2.2). Its pieces are part 08's: the
operand table `lib/commcare/__tests__/instantOrderingTable.ts`, the producer
`proof/native/producers/emit-expression-evidence.ts`, the zoned Core class
`proof/native/core/InstantOrderingRuntimeTest.java` run in part 08's seven `ZONES` (four device
zones and three Formplayer-like setups), each in a test JVM of its own through
`native-proof.init.gradle`'s `-PnovaProofZones` and `test.systemProperty('user.timezone', zone)`,
because `GRADLE_OPTS` does not reach the test JVM (the native lowering run). The family builds no
app. What this part owns in it is the lowered half: from pull request 8, the lowering, the producer
writes, for every pair, the comparison exactly as `serializeWire(toWire(…), { target: "xform" })`
prints it over a typing context built with `lib/__tests__/docHelpers.ts::buildDoc`, never
hand-written XPath, for `<`, `<=`, `>`, `>=`, `=` and `!=`, and Core's answer is the instant order
in every setup with no throw on any malformed value (part 08 §2.2, requirements 5 and 7). The
cross-path half, a form's XForm through HQ's rebuild and the local archive and a case list filter
through HQ's interpolation and Nova's suite, is the lane's (below).

**HQ native, new** `proof/native/test_hq_interpolation.py`, in pull request 4, the wire tree (§8):
HQ's own `app_manager/xpath.py::interpolate_xpath` (with a case, without one, and with
`interpolate_dots=False`) and `post_process/instances.py::get_instance_names` over
`native/expression/interpolation.json`, which `emit-expression-evidence.ts` also writes: the
`hq-json` prints, in each interpolation mode, of record expressions holding the hazardous literals
(`'#case'`, `'#user'`, `'#session/x'`, a value ending `\`, `"instance('x')"`). Each interpolated
text equals its input wherever no shortcut is meant, and no instance id is found inside a literal.
The image mapping rows also call `dot_interpolate` and `MappingItem.key_as_condition` directly:
intentional self placeholders resolve to the property while dots, hashtags, quotes, backslashes
and instance-looking text inside each literal retain their value. HQ's one HTML-unescape pass,
including Python's omitted numeric character references, must not assemble an instance read.
The boundary is HQ's code, which is what decides; it builds no app either.

**Existing families re-observed** where bytes move: `function` (`function-nested-lookup`, §3.8),
`arithmetic` (`quotient`), `xpath` (`XPathCarrierCompatibilityTest::executesCurrentProductionLoweringsAndClassifiesActualNativePaths`
reads the lowerings from `toWire` instead of `lowerXPathForJavaRosa`), `predicate`, `case-list`,
`navigation`, `prompt`, `search`, `lookup`, `location`, `relation-instance`, `expander` and
`hq-oracle`. Their expected answers do not change; their emitted bytes do (§5.1).

**The lane.** Proof 2 (HQ's build of every document) and proof 4 (every form saved twice in
Vellum, and every app section saved) hold the canonical bytes and the shadows; proof 3's Core and
Formplayer sessions and the Android and Web Apps readers hold the lowered answers.

Pull request 1, lane mechanics, registers finding 56's live entries beyond the ones the register
holds today and gives the manifest check its type reader: `targeted-datetime-operands` with its
control and three intent entries (`d56-datetime-ordering-literal`, `d56-datetime-ordering-clock`,
`d56-datetime-ordering-case-list`; the literal row is a case-list filter, `lt(prop(visit, seen),
term(datetimeLiteral(…)))`, since form logic already refuses a literal ordering), the manifest's
`refused/time-operand` classes on `local*.ccz/suite.xml` under finding 56
(`d56-datetime-ordering-suite-cmp-time-operand`, `d56-datetime-ordering-suite-lt-time-operand`),
and `proof/checks/manifest_value_classes.py::_time_kind` a reader of a property's type, an
optional `caseTypes` key in a control's derived layout, read from the declared `data_type` at pull
request 1 and from `document.json`'s `catalog` from pull request 5 (part 08 §5.2), so a
property-against-property ordering is decided.

In pull request 8, the lowering, the intent and manifest checks, which run Core and need no served
reader, move finding 56's seven entries to `proof/fixed-defects.json` with their controls retained
(part 08 §3.1), five intent and two manifest: `d56-datetime-ordering-evaluate-answers` and
`d56-datetime-ordering-evaluate-case-text` on `targeted-datetime-ordering` (`order` is "start
before end" and "seen before due"), the three intent entries on `targeted-datetime-operands`, and
the two manifest entries, every entry under finding 56 that the lowered bytes no longer reproduce,
which the strict register names (`proof/checks/test_registers.py`). `OPEN_DEFECTS` loses `56: 3`
there; its values are steps, not entry counts.

Finding 75's device half is observed the same way. `targeted-datetime-equality` (part 06 §3.13)
carries Core `evaluate` expectations of its case lists on the device, and pull request 1 registers,
as live entries on its retained control, the two the executed verdict shows (the operands run,
39061011794, over the scratch branch's version of the document, whose "Visits" and "Other visits"
are the plan's; the plan's document held them with every reader in run 39078199859, part 08 §6.4):
the equality and inequality case-list rows (`equal-visits-listed`,
`other-visits-listed`), because today's device filter compares the restored
`…T04:30:00.000000Z` with the filter's literal by text, and `OPEN_DEFECTS` gains `75: 3`. "Opened
visits" (`date_opened`) sits in an advanced Search input (part 06), so no device evaluates it, and
"Log visit" writes its date and time through a Hidden Value with `now()`, so finding 74's stop
never meets it. The equality lowering of §3.3 is what lists the cases, so those entries move to
`proof/fixed-defects.json` in pull request 8. Finding 75's HQ half is not this part's: its search
error on "Opened visits", which pull request 1 holds in four entries and a walk stop, and `75: 3`
leave in pull request 10, CSQL, whose `csql` family scenario `datetime-equality` holds the HQ half
(part 06 §3.13, part 08 §3.2).

No served reader runs on a local machine (part 08 §6.4). Pull request 8's reader run is a dispatch
on GitHub's runners, started by the person:
`gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f
mechanics=targeted-datetime-ordering,targeted-datetime-operands,targeted-datetime-equality,function-nested-lookup,targeted-search-hq-compile`.
It shows Formplayer's, Web Apps' and Android's answers before the merge; the merge does not wait on
it, since the night after the merge reads every document with every reader. The first planning
dispatches with readers (runs 39058712962, 39058666752, 39058667355) died in the Android reader
runtime job, which fails main's own nightly the same way since 2026-10-14 (issue 768); the runs
without served readers held (the operands run, 39061011794: nothing unregistered but the manifest
classes above; the spellings witness run, 39061476968: clean). With issue 768's fix beneath (#771), the second
dispatches pass that job, and the spellings witness held with every reader (run 39064333759):
Formplayer, the Web Apps client and Android read the planning lowering's text in UTC as Core does.
The operands run's dispatches with every reader (39064331941 and 39078199859), which give the
readers' pre-fix values on `targeted-datetime-operands` and `targeted-datetime-equality`, are part
08 §6.4's to report. What no run has read with every reader is the shipped `instantMicros` text,
which this pull request's dispatch reads (part 08 §6.4, R2's row).

---

## 7. Files

| File | Change |
|---|---|
| `lib/commcare/xpath/wire/tree.ts`, `builders.ts`, `serialize.ts` (its number print calls `predicate/stringQuoting.ts::formatNumeric`, which pull request 10 moves into it), `instances.ts`, `fromExpression.ts`, `rowScope.ts` (the case-anchor model), `geopoint.ts` (the `within-distance` trees), `formReads.ts`, `instant.ts`, `CLAUDE.md` | new (§2, §3); all but `formReads.ts` and `instant.ts` in pull request 4, those in 5 and 8 |
| `lib/commcare/xform/itextIds.ts` | new: `itextIdFor(doc, unit)`, also read by `builder.ts`'s label emission (pull request 9) |
| `lib/commcare/elementBuilders.ts` | typed element specs for the XPath-bearing elements (`bind`, `setvalue`, `output`, `itemset`, `repeat`; suite `datum`, `command`, `menu`, `xpath`, `data`, `prompt`, `required`, `validation`, `action`, `create`, `push`, `assertion`) taking `WireExpr` and an `InstanceSink` |
| `lib/commcare/hqJson/xpath.ts`, `lib/commcare/types.ts` (the HQ JSON XPath fields: `calc_xpath`, `filter_xpath`, `search_button_display_condition` and the rest), `hqShells.ts` (the shells that seed them) and `hqJson/caseList.ts` | XPath fields hold `HqXPath` (a `WireExpr` and its interpolation mode) until the complete JSON is serialized; `lib/commcare/hq/` is the REST client and holds no XPath |
| `lib/commcare/xform/builder.ts`, `caseBlocks.ts`, `caseOps.ts`, `metaBlock.ts`, `constraintMessage.ts`, `constraintCollections.ts`, `datetimeCaseValue.ts`, `captureUrlNode.ts` | trees and the sink; `InstanceTracker` removed (pull request 4) |
| `lib/commcare/session.ts`, `compiler.ts`, `formLinkProjection.ts`, `entryPointSuite.ts`, `usercaseWire.ts`, `subcaseWire.ts`, `caseOptions.ts`, `suite/**` (`suite/case-list/orderPlanOptions.ts::hqExpressionFieldText` and `suite/case-search/relatedCaseProjection.ts` among them, §2.6) | trees; declarations from the serializer; `claim.ts::CLAIM_MULTI_RELEVANT` and `entryPointSuite.ts`'s scalar hydration build `$case_id` as `w.caseIdVar()` (§2.1) |
| `lib/commcare/expression/onDeviceEmitter.ts`, `predicate/caseListFilterEmitter.ts`, `predicate/relationPresenceEmitter.ts`, `predicate/instances.ts`, `xpath/stringLiteral.ts`, and the device halves of `predicate/termEmitter.ts`, `geopoint.ts` and `stringQuoting.ts`, with the tests beside them | removed in pull request 4; every importer is re-pointed in the same pull request (§2.6 lists them) |
| `hashtags/formContext.ts`, `xpath/javaRosaLowering.ts`, `xpath/selfSteps.ts`, `xpath/wireSource.ts`, `xform/instanceRefs.ts` | removed in pull request 5 with the rest of form logic's text path, every importer re-pointed there: `emissionPlan.ts`, `formActions.ts`, `formLinkProjection.ts` and `xform/builder.ts` (`formContext.ts`; `formActions.ts` also `hashtags.ts::extractHashtags`); `xpath/index.ts`, `formLinkProjection.ts`, `xform/builder.ts` and `proof/native/producers/emit-xpath-evidence.ts` (`lowerXPathForJavaRosa`, which `suite/case-list/columns.ts` and `nodesetFilter.ts` stop calling in pull request 4); `xform/builder.ts`, `caseOps.ts` and `constraintCollections.ts` (`selfSteps.ts`); `connectDefaults.ts`, `fieldProps.ts` and `constraintCollections.ts` (`wireSource.ts`); `session.ts` and `xform/builder.ts` (`instanceRefs.ts`, whose reader moves into `suiteOracle.ts`); the tests `formContext.test.ts`, `hashtagProjection.test.ts`, `expander.test.ts`, `editableEnvelope.test.ts`, `constraintCollections.test.ts`, `javaRosaLowering.test.ts` and `selfSteps.test.ts` |
| what remains of `lib/commcare/predicate/` and `lib/commcare/expression/` | moved in pull request 10: the CSQL parts to `lib/commcare/csql/`, `onDeviceCompatibility.ts` whole to `lib/commcare/validator/onDeviceCompatibility.ts`, a target rule outside the checker (part 03 §1.4, part 06 §2.3) |
| `lib/commcare/xform/pathExpression.ts` | unchanged: the oracles' own reader of emitted text |
| `lib/commcare/lookup/cellText.ts`, `lib/commcare/validator/rules/caseOperations.ts`, `rules/case-list/onDeviceExpressionCompatibility.ts`, `proof/corpus/footprint.ts`, `proof/native/producers/emit-predicate-evidence.ts`, `emit-arithmetic-evidence.ts`, `emit-lookup-evidence.ts`, `lib/case-store/sql/compileLiteral.ts` (a comment) | re-pointed in pull request 4 (§2.6) |
| `lib/commcare/hashtags.ts` | keeps `hqLoadReference` and `VELLUM_HASHTAG_TRANSFORMS` only |
| `lib/commcare/validator/xformOracle.ts`, `suiteOracle.ts` | the private instance reader; the two unread-instance checks |
| `lib/commcare/xpath/carriers.ts` | yields typed slots with their profiles (part 02), no `wire-catalog` |
| `lib/commcare/xpath/functionCapabilities.ts` | header evidence SHAs re-cited at the pins (only commcare-core's `8e9ba8d908e9` matches its pin today) |
| `lib/preview/engine/displayConditionEvaluation.ts`, `lookupEvaluation.ts`, `searchExpressionEvaluation.ts` | evaluate `serializeWire(toWire(…), preview)` (part 07 plans the rest) |
| `proof/native/producers/emit-expression-evidence.ts`, `core/InstantOrderingRuntimeTest.java` | the `expression` family's lowered half (§6); the family, its zones and its control half are pull request 1's, lane mechanics (part 08 §7) |
| `proof/native/test_hq_interpolation.py`, and `emit-expression-evidence.ts`'s `interpolation.json` | new HQ check (§6) |
| `proof/native/test_search_emission.py` | in pull request 4: it asserts present, and sets aside, one unread collection-instance declaration (`remote-multiple`'s selected cases) that §5.2 stops writing; that recorded difference leaves |
| `proof/native/hq_support.py`, `xpath_instances.mjs`, `test_xpath_shapes.py`, `test_search_emission.py`, `test_no_matches_emission.py`, `test_endpoint_emission.py`, `test_nested_menu_emission.py`, `test_tile_emission.py`, `test_case_emission.py` | pull request 4 compares known XPath carriers through the pinned HQ parser's model; all other attributes, meaningful text, child order and instance declarations remain exact, and the existing nested-menu unread-declaration exception stays bounded to its original scope |
| `lib/commcare/entryPointSignature.ts`, `lib/deployment/entryPointLinks.ts` | pull request 4 keeps stored signature bytes and compares the known XPath slots structurally; unknown or malformed signature shapes fail closed, and instance declarations remain exact |
| `proof/known-defects.json`, `proof/fixed-defects.json`, `proof/checks/registers.py` (`OPEN_DEFECTS`) | finding 56's seven entries and finding 75's device half's two move; `OPEN_DEFECTS` loses `56: 3` (§6; part 08 §3.1); `75: 3` and `proof/checks/test_registers.py`'s `step > 3` are pull request 10's |
| `proof/targeted/documents/datetimeOrdering.ts` | header comment: the document is the fix's witness (part 08 §3.1) |
| `lib/commcare/CLAUDE.md`, `lib/commcare/xpath/CLAUDE.md` | rewritten: one tree, one serializer, the modes, the canonical spacing and why it is Vellum's, the lowering, derived instances; "Vellum dual-attribute pattern" keeps "No shadow carries `#case/`" and its reasons, now as `vellum` mode's rule over the tree |
| `content/docs/building-with-nova.mdx` | "XPath that will run in CommCare": comparing two dates and times compares the moments on every device; on a device a case's opened and last-changed dates are days, and in search results the opened date is a day; checking a date and time against `''` still asks whether it is blank; `date()` of a date and time gives the device's day for an answer and the written day for text; if you open such a form in CommCare HQ's form builder, a comparison of two dates and times shows as a longer formula that compares the moments, and it keeps its meaning if you leave it as it is (Nova reads the lowered shape back only from step 6). Each sentence lands in the pull request whose behavior it describes, as part 10's "Public docs that change" gives them: the dates paragraph in 8, the search-results day in 9, the standard spelling in 5 |
| `docs/plans/hq-round-trip/6-import.md` | the lowered shape's recognition rule (§3.7) and the note on prose holding `instance('…')` ("Left outside step 3"), written by this plan's own pull request |
| `docs/plans/hq-round-trip/7-rest-of-model.md` | group 4: sorting by a date and time, and the `date()` guard in interval and late-flag columns ("Left outside step 3"), written by this plan's own pull request |

---

## 8. How this part lands in the stack

The stack is fifteen pull requests in one `gh stack` chain, merged together in one deploy (part 10
holds it in full). This part lands in four of them (4, 5, 8 and 9), rides two (7, Preview, and
10, CSQL) and needs two below it (1 and 2). The wire tree lands below the shape so the emitter
restructure is reviewed apart from the stored shape; the number of fresh lanes the stack runs is
the same in either order.

No pull request bumps `lib/models.ts::MODEL_CONTEXT_VERSION` for this part's own work: it changes
no tool schema and no model-facing prose. The bumps are in pull requests 3, 5, 9, 10 and 12, each
for what the model is served or told there (part 10, checklist item 13): 5's for the parser that
pull request carries, 9's for part 05's guide rows, 10's for part 06's. None adds an `/api` route.
Every lane run they need is the pull request lane on GitHub's runners or a reader dispatch the
person starts; none runs on a local machine.

### 8.1 Below this part: pull requests 1 and 2

- **Pull request 1, lane mechanics** (part 08 §7, the stack's bottom): the zoned harness and the
  `expression` family's control half (Core's bare comparisons asserted per zone);
  `targeted-datetime-operands` with its control and five finding-56 entries (three intent, two
  manifest), its literal row a case-list filter; the manifest's `refused/time-operand` classes on
  `local*.ccz/suite.xml` registered under finding 56, and `manifest_value_classes.py::_time_kind`'s
  reader of a property's type (the declared `data_type` at pull request 1, `catalog` from pull
  request 5); `targeted-datetime-equality` with its control and finding 75's device-half entries,
  the equality and inequality case-list rows (§6), and part 06's four entries and walk stop for
  its search error on a system date; eleven live entries in all, and `OPEN_DEFECTS` gains `75: 3`.
  No product byte moves. This part contributes nothing to it beyond §3's
  requirements.
- **Pull request 2, the cutover skeleton** (part 09): the frozen pre-step fixtures, the frozen
  printer, the emission normalizer and the base emitter, whose `lib` still equals production's. The
  emission census's base half (§5.5 item 1) runs at its head. This part adds no code to it.

### 8.2 Pull request 4, the wire tree for the record family and the scaffolding

`xpath/wire/` (the tree, the builders, `serializeWire` in its `xform`, `vellum`, `suite` and
`hq-json` modes, the instance table) with `toWire` over today's `Predicate` / `ValueExpression`;
every generated site on `w.*` (§2.6's scaffolding rows); derived declarations and the oracles'
unread-instance checks (§2.4, §2.7); `test_hq_interpolation.py` and the native comparisons' parsed
XPath boundary (§6, §7); `case-id-var` for HQ's `$case_id` (§2.1); `hqExpressionFieldText` through `toWire`
in `hq-json` mode (§2.6). It deletes only the device halves of `lib/commcare/predicate/` and
`lib/commcare/expression/` and re-points every importer §2.6 lists, the lane producers that read
source files among them; `toWire` reads today's `TypeContext` until pull request 5. Form logic keeps
today's print, expand and lower path for one more pull request. Today's CSQL emitter and its segment
IR stay until pull request 10 (part 06), their runtime segments now printed by `serializeWire` and
carrying the instance set that print returned (§2.4), so `lib/commcare/predicate/` and
`lib/commcare/expression/` finish leaving there. Preview's three record
evaluators (`displayConditionEvaluation.ts`, `lookupEvaluation.ts`, `searchExpressionEvaluation.ts`)
evaluate the device mode's print, which is today's text at canonical spacing, until pull request 7.
Bytes move by §5.1 (record and scaffolding) and §5.2; the lane re-observes every document.

### 8.3 Pull request 5, the shape (and pull request 7, Preview)

Pull request 5 (parts 01 and 02, and part 03's core) replaces form logic's text path with `toWire`
over the union. Form logic's canonical bytes (§5.1) move here, inside the pull request that
already moves every document's key, and the printer prints a repeat step's `[1]` filter (§4) from
here; the `many-values` refusal of a structural repeat read lands in pull request 6 (part 03 §3.4)
and the cutover step that writes the filter into stored documents, `repeat-read-first-row`, in pull
request 13 (part 09 §5), so stored bytes gain the `[1]` at the cutover. Session datum identity lands
here too: the `session-datum` arm's `toWire` row, which prints `ctx.datumId(ref)`, the id
`lib/commcare/formLinkProjection.ts::entryDatumIds` gives each ref `lib/domain/entryDatumSupplies.ts` lists
(part 05 §1.3, §1.4; §2.2, §4), and a form link's datum names, because the corpus already holds a
form link reading a new case's datum and production holds `selected-case` reads, which pull request
5's parser must resolve. The targeted document `targeted-session-reads` (part 05 §5) lands with it,
with the session-read scenarios of `FormLinkRuntimeTest`, `NestedMenuRuntimeTest` and
`TileGroupingRuntimeTest`, so datum reads have lane evidence from the pull request that changes
them; pull request 9 adds the batch form's `selected_cases` read to that document, with the new
instance reads' scenarios and documents. The binds inference
moves (§5.4 item 8) arrive with the inference, which is part 03's in pull request 6, through
`fieldValueType` and no code of this part.

Pull request 7, Preview (part 07 §8), carries this part's `target: "preview"`: `toWire`'s field
resolution for a query-bound repeat's flattened rows and the `preview` mode of `serializeWire`
(§2.2, §2.3), which Preview's evaluators read from there, with protocol 8. It lands before the
lowering, so Preview's date fixes (part 07 §2.1, §2.2) are in place before any lowering relies on
Preview (§3.7).

### 8.4 Pull request 8, the lowering

Finding 56, its equality half and `datetime-coerce`: `instant.ts`, §3.2 to §3.8, the day rule's
checker finding with part 03 (part 03 §3.2) over `casedb` rows, the family's lowered half (§6),
finding 56's seven entries and finding 75's device half's two moved, nine in all, and
`OPEN_DEFECTS` losing `56: 3` (§6). Its reader dispatch is §6's, over the shipped `instantMicros` bytes.

### 8.5 Pull request 9, the new reads with part 05

The new reads (lookups and locations in form logic, `results:inline`, `selected-cases`, `jr:itext`,
`jr:choice-name`) get their arm's `toWire` row and declaration here, with Preview's supplies for
them (part 07 §8), with part 05 and the builder and authoring rows part 02 §9 assigns to this pull
request; their slots' profiles admit them from here (part 02 §9, part 03 §1.4). The day rule over
a results row's `date_opened` (§3.4) lands here too, because this pull request makes the read
authorable.

### 8.6 Pull request 10, CSQL (part 06)

Part 06 moves the CSQL emitter onto `CsqlNode` and `WireExpr` (§2.5) and finishes the removal of
`lib/commcare/predicate/` and `lib/commcare/expression/` (§2.6), re-pointing the importers of what
it moves, `geopoint.ts`'s patterns and `isValidStaticGeopointCenter` among them. It admits the
chosen case in three record slots (part 01 §4); its `session-datum` and keyed `project` print through
pull request 5's `toWire` rows (§4), so this part adds no code there.

---

## Departures

Each is a decision of this part, with its reason.

- **Unread instance declarations go** (§5.2): the planning probe found 24 of 500 HQ-upload forms; the implementation census also covers every local form and suite owner. An unread declaration has
  no meaning, and Core initialises every declared instance when a form opens, so dropping one
  removes a way to fail. Keeping them would need a declaration source other than the tree.
- **The whole wire is canonical, not only form logic** (§5.1). Canonical spacing is decided for
  stored text (part 01 §2.5); one serializer cannot print Nova's scaffolding one way and authored text
  another without a second print rule, and the scaffolding is most of what changes.
- **Shadows keep today's rule** (decision 11). The tree could give a shadow to every slot that
  today has none (case reads printed as casedb paths); that is a change HQ's form builder would
  have to be proven on, so it is not made. In particular no shadow carries `#case/`, even on a
  selected-case projection where a form builder save writes one itself (§3.7): step 2 fixed defect
  3 by writing no `#case/` hashtag in any form (`proof/README.md`, defect row 3: HQ's form builder
  warns "Unknown question: #case/<property>" for a property only a Save to Case block writes, and a
  `#case/` over `case_id`, `owner_id` or `status` is saved as a child element the case database
  does not have), and the fixed entries on `targeted-save-to-case-read` rest on that sentence. A
  Vellum save that adds `#case/` itself is what HQ's editor does for a property it lists, and proof
  4 already erases it, so Nova gains nothing by writing it first.
- **Blank date-and-time answers are not equal** (§3.3) when both sides are dates and times; the
  blank test `x = ''` keeps today's meaning. Production holds no equality between two dates and
  times, so no stored answer changes.
- **A naive date-and-time text reads as UTC** (§3.1), where Core's own `date()` reads it in the
  device's zone. No writer Nova serves produces one.
- **`datetime-coerce` of a date as a value prints `…T00:00:00.000Z`** (§3.8), where today it
  printed `date(x)`, which Core wrote as a date. A date-and-time property then holds an instant.
  Production holds no `datetime-coerce`.
- **Equality between two dates and times compares instants in form logic too** (§3.3), where Core
  compares their text today, so two spellings of one moment become equal. The alternative, keeping
  text equality where Preview's text equality matches Core's, would leave a device disagreeing
  with HQ's search and Postgres on the same values. Production holds none.

## Left outside step 3

Three behaviors this part found and does not change, because none is an expression comparison
step 3 owns. Each goes to the later step that owns its surface, and this plan's own pull request
writes each, with its reason, into that step's outline file (part 10, "Written by this plan's own
pull request"):

- **Sorting by a date and time.** Case list sort keys over a date-and-time property sort the text
  (`suite/case-list/sortKeys.ts`). HQ's stored text is all `…Z` (`adjust_datetimes`, as the
  Elasticsearch offset run showed), so synced cases sort right; a case a device wrote before it
  synced carries its offset and can misorder. The lowering can serve as the sort's `double` key
  (the native lowering run evaluated it as a detail sort key, `1.772630805845E15`). **Step 7,
  group 4** (case list and detail), in `docs/plans/hq-round-trip/7-rest-of-model.md`: its sort
  settings own the sort key's HQ spelling.
- **`date()` of case text in generated columns.** `columns.ts`'s interval and late-flag columns
  write `today() - date(x)` with only a blank guard, and Core's `date()` throws on malformed text
  (`FunctionUtils.java::toDate`), which a detail shows as an invalid cell. Kept byte-stable.
  **Step 7, group 4**, in `7-rest-of-model.md`: its column kinds own the interval and late-flag
  columns' HQ spelling.
- **Prose holding `instance('…')`.** HQ's `add_missing_instances` scans the whole rendered XForm,
  labels included (§2.3), so a label whose text holds `instance('x')` makes HQ add or refuse an
  instance. It is not XPath, so it is outside the serializer. **Step 6** (import), in
  `docs/plans/hq-round-trip/6-import.md`, with arbitrary `<output value>` expressions in prose: both
  are about which text in a form's prose CommCare reads as XPath, which import owns.

## Executed during planning

Nothing here was a paid call, and no served reader ran on a local machine. The local probes are
planning scripts, run from the repo root at `5cf6e327` with `npx tsx` or `python3 -I`, with the
working tree left clean; they are not committed. The lane runs were dispatched on GitHub's runners.

- **The native lowering run** (local, Core at its pin under Gradle in Docker): a Core probe test,
  `InstantOrderingProbeTest`, evaluating the planning `instantDays` and `instantMicros` parses and
  their controls in ten zone setups: four device zones (UTC, New York, Kolkata, Kiritimati), three
  Formplayer-like setups, and three variants of how the zone reaches the JVM. After the one-line
  guard on the offset (`offStr = if(contains(tr, '|'), substring-after(tr, '|'), '')`), both parses
  ordered by instant identically in every setup: 131 of 131 rows and 91 of 91 checks each, the DST
  fall-back pair right, 13 offset spellings equal, and no wrong pair among 3,000 same-instant
  spelling pairs, 3,000 distinct pairs and 1,500 six-digit pairs a microsecond apart. Malformed
  text never throws but is not always NaN (§3.1). Cost per 1,000 cases: 37 to 52 ms against
  `now()` re-formatted per row, 17.6 to 18.6 ms against a folded literal, 22.0 to 25.2 ms with both
  sides parsed, 2.2 to 3.5 ms bare; ten lowered comparisons or-ed together (50,266 bytes) parsed in
  17.5 to 20.1 ms, and Core's parser has no length limit. The zone reaches a test JVM only through
  an init-script test task per zone with `test.systemProperty('user.timezone', zone)` (or
  `environment('TZ')`); `GRADLE_OPTS` does not reach it. Docker Desktop's VirtioFS can serve a
  stale or truncated bind-mounted file, so each run copied its sources fresh. §3.1, §3.2, §3.5 and
  §3.9 rely on it.
- **The Preview parity run** (local): Preview's evaluator against Core's over the same operands.
  Equal for every text operand in every zone; typed operands equal except inside a repeated DST
  hour, where Preview's held typed value differs; Preview's `format-date(node)` and `date(node)` do
  not round. §3.2 and §3.7 rely on it.
- **The Elasticsearch offset run** (local, a planning test in the lane's image, HQ at its pin and
  Elasticsearch 6.8): every date-and-time spelling reaches
  HQ's index normalised to `…T04:30:00.000000Z`, because HQ's receiver rewrites datetime-shaped
  strings before saving (`corehq/form_processor/utils/xform.py::adjust_datetimes`). §3.1 and "Left
  outside step 3" rely on it.
- **The canonical-print prototype and census**: a prototype of §2.3's canonical print over Nova's
  Lezer grammar (`lib/commcare/xpath/parser.ts`), run over every XPath attribute of the corpus's
  fresh host emission (371 documents, 5 s), with the seven unparsed suite attributes checked to be
  `<query value>` URLs. §5.1.
- **The instance probe**: declared against read instances in 500 local and 500 HQ-upload forms.
  §5.2.
- **The interpolation probe**: §2.3's hazards in the four interpolated HQ JSON slots of the corpus
  (147 strings, none).
- **The lowering probe**: §3.1's canonical text (reproducing the native run's Java text character
  for character), §3.5's folds, §3.9's shipped sizes and §5.3's witness bytes, over
  `targeted-datetime-ordering`'s local archive and HQ upload.
- **The recanonicalisation probes**: one read the spellings witness's three lowered attributes from
  the HQ upload and the saved form (text and in-file bytes: 5,173 / 6,564, 5,143 / 6,534, 1,833 /
  2,240; saved 5,355 / 5,406, 5,325 / 5,376, 1,924 / 1,951); another printed them canonically
  (5,335, 5,305 and 1,914, the same before and after the save), printed the witness's two Hidden
  Values with `instantMicros` (5,389 / 6,780 and 1,947 / 2,354), reproduced the native run's Java
  lengths (1,730 and 1,755 per text operand, 50,266 for the ten or-ed comparisons), printed them
  canonically (1,811, 1,838, 52,426), and found no comma without a following space in any
  canonical print. §3.1 and §3.9.
- **The corpus shape scan**: the shape scanner over the corpus (371 documents, no failures): 2
  date-and-time equalities in form logic, both `= ''`; 2 in record slots,
  `function-nested-lookup`'s and a search predicate's; 1 system-date ordering,
  `targeted-search-hq-compile`'s; no hazards.
- **The production shape scans** (three passes, 2026-10-17, read-only under the person's standing
  permission for read-only production reads: the first run by the person, the second and third by
  planning; each through `scripts/lib/prodDb.ts::targetProdDb` in one `REPEATABLE READ, READ ONLY`
  transaction of plain SELECTs, emitting closed labels and counts only, no ids, names, text or
  values; every app read, none unreadable, no scan failure, every app with its fold baseline). The
  first two give the date-and-time orderings, the canonical-print classes, the `choice` literals,
  the structural repeat reads, the untyped case queries, the session reads, record `div`, CSQL
  `today()` and datetime equality, `is-selected` and `concat()`, and `app_changes` after the step 2
  horizon. The third added a content-free pass: date-and-time equalities by operand kind (a string
  literal classed blank, instant-shaped or other), comparisons with `date_opened` or
  `last_modified` on either side, and literals holding an HQ interpolation token, an `instance(`
  call or an odd trailing backslash run. What each showed is stated where it decides something,
  without its count (§2.3, §3.3, §3.4, §3.8, §3.9, §4, §5.1, §5.4).
- **The spellings witness run** (GitHub Actions runs 39060796573 and 39061476968, on a scratch
  branch never merged): the lane without served readers (HQ's import and build, Core, the form
  builder's saves) over a planning witness document, `targeted-expression-spellings`, and
  `navigation-conditions`. The first run's one failed item was the intent check, which stopped on
  the witness itself: its Stamp request opened no session, so Core's evaluate raised
  `XPathTypeMismatchException` on the registration form's `session/data/case_id_new_visit_0` read.
  The second run's request opens the session with that datum: 303 items, every check held, proof 4
  over two form builder saves held, and each form's four save records hold one saved text, the same
  in both runs. Vellum rewrote whitespace only in the three lowered attributes and their shadows
  (a space after each of 166, 166 and 83 commas, either side of each of 8, 8 and 4 `*`), respelled
  the author-spelled value and left the canonical one unchanged, added `#case/case_name` with its
  two head elements to the Check form's selected-case projection, and added shadows to Nova's
  generated nodes. Form sizes, upload to saved: Stamp 33,571 → 28,814, Spellings 3,440 → 3,804,
  Check 1,220 → 1,669. Core and HQ answered both spellings `big`, the lowered orderings by instant
  under the lane's clock and under clocks two minutes either side, and the bare ordering `not
  ordered` (finding 56 itself). Decision 3, §3.7 and §3.9 rely on it.
- **The operands run** (GitHub Actions run 39061011794, on a scratch branch, lane without served
  readers over `targeted-datetime-ordering` and the planning drafts of `targeted-datetime-operands`
  and `targeted-datetime-equality`): nothing unregistered but the
  manifest's `refused/time-operand` classes, which pull request 1 registers, and the verdict that
  names finding 75's two device-half rows (§6).
- **The readers' verdict.** The first with-readers dispatches (39058712962, 39058666752,
  39058667355) died in the Android reader runtime job, as main's nightly has since 2026-10-14
  (issue 768). With that issue's fix beneath (part 08 §6.4), the spellings witness's second
  dispatch, run 39064333759, held with every reader: Formplayer, the Web Apps client and Android
  read the planning `instantDays` text as Core does. Not run: the readers over the shipped
  `instantMicros` text, which pull request 8's dispatch reads (§6; part 08 §6.4, R2's row).

Read for this part (Nova): `lib/commcare/xform/builder.ts` (`InstanceTracker`, `expand`,
`expandDefault`, `shorthand`, the datetime sibling guard), `hashtags/formContext.ts`
(`vellumShorthandInContext`, `hashtagHeadsAPath`), `xform/datetimeCaseValue.ts`,
`xform/generatedNodes.ts`, `expression/onDeviceEmitter.ts` (header and entry),
`suite/displayConditions.ts::emitFormDisplayConditionForHq`, `elementBuilders.ts`,
`suite/case-search/claim.ts`, `entryPointSuite.ts`,
`lib/case-store/sql/compileExpression.ts::compileCast`, `lib/commcare/__tests__/csqlFunctionFixture.ts`,
`proof/targeted/documents/datetimeOrdering.ts` and `searchApps.ts`,
`proof/native/core/native-proof.init.gradle`.

Read at the pins: HQ `app_manager/xpath.py::interpolate_xpath`, `::dot_interpolate`,
`::_ensure_no_case_references`, `DOT_INTERPOLATE_PATTERN`, `::CaseClaimXpath.multi_case_relevant`;
every caller of `interpolate_xpath` (`suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`,
`sections/menus.py` module and form filters, `sections/details.py` tab `nodeset_filter`,
`post_process/remote_requests.py` required and validation tests); `detail_screen.py`
(`_calculated_property`, `evaluate_template`: calculated columns are not interpolated);
`post_process/instances.py::instance_re`, `::get_instance_names`,
`::get_all_instances_referenced_in_xpaths`, `::remote_instances`, `::search_input_instances`;
`suite_xml/post_process/workflow.py::WorkflowQueryMeta.to_stack_datum` (`is_endpoint`);
`suite_xml/utils.py::is_valid_results_instance_name`; `xform.py::XForm.add_missing_instances`;
`corehq/apps/case_search/xpath_functions/comparison.py::_create_system_datetime_query`,
`::case_property_range_query`; `corehq/ex-submodules/casexml/apps/case/xml/generator.py`
(`CaseDBXMLGenerator.add_base_properties`: `last_modified` by `datetime_to_xml_string`;
`V2CaseXMLGenerator.add_custom_properties`, inherited: `date_opened` by `date_to_xml_string`,
`json_format_date`). Core `org/javarosa/core/model/condition/Recalculate.java::wrapData` (an
integral `Double` beyond `int` becomes `LongData`), `org/commcare/cases/instance/CaseChildElement.java`
(`date_opened`, `last_modified` as `DateData`), `org/javarosa/xpath/expr/FunctionUtils.java::toNumeric`
(date-only text becomes its day count through `attemptDateConversion`), `::toDate`,
`XPathSubstringAfterFunc.java::substringAfter`, `XPathSubstrFunc.java::substring`,
`XPathVariableReference.java`, `org/javarosa/core/model/FormDef.java` (`jr:choice-name` handler),
`org/javarosa/xpath/expr/XPathEqExpr.java::testEquality` (two `Double`s equal within `1.0e-12`;
otherwise text equality). Vellum `parser.js::parseVellumAttrs`, `xpath.js`, `logic.js`.
