# Step 3, part 03: The type checker and the validator

Part of [step 3's plan](../3-expressions.md) ("Expressions"). This part holds the one checker over the `Expression`
union of part 01, its two rule sets, the context it reads, where each of today's validator rules
over expressions goes, the refusals step 3 adds, finding 73's authoring rule, Hidden Value type
inference and what it changes for existing documents, the gate's cost, and the corpus. Part 01
(the model) is binding here. The lowering of finding 56, emission, Preview, the authoring surfaces,
the reference index and the cutover are planned in their own parts; this part names what each of
them reads from the checker. What only the cutover's dry run can count is listed in §5.4. §10
states how this part lands in the stack's fifteen pull requests.

Citations are `path::symbol` for Nova at `main` `5cf6e327` and `file::symbol` for CommCare at the
pins `proof/pins.json` names: commcare-core `8e9ba8d908e9` (paths under `src/main/java`),
formplayer `24383ac71bfb` (paths under `src/main/java/org/commcare/formplayer`), commcare-android
`7a5584475580` (paths under `app/src`), commcare-hq `d6c6e16d8ae1` (paths from the repository
root). Every CommCare fact this part states was read at its pin during planning; "Executed during
planning" lists the reads.

## Decisions in brief

1. **One checker, `lib/domain/expression/typeChecker.ts::checkExpression`,** replaces
   `lib/domain/predicate/typeChecker.ts::checkPredicate`, `::checkValueExpression`,
   `::checkValueAssignmentExpression` and the form-logic readers in `lib/commcare/validator`
   (`xpathValidator.ts::validateXPath`'s type phase, `typeChecker.ts::checkTypes`,
   `timeOrdering.ts::findTimeOrderingComparisons`, `rules/sessionData.ts::sessionDatumNotSupplied`).
   Entry supply is the checker's, and `rules/sessionData.ts` leaves.
   It walks the stored tree and never parses text: from step 3 the commit gate makes no Lezer parse.
2. **Two rule sets, chosen by the slot's profile.** The record rule set is today's
   `typesCompatible` / `ORDERED_TYPES` / per-arm rules, unchanged, plus the `record-position` rule
   (part 01 §3.4). The form rule set takes Core's coercions and refuses exactly the list in §1.2. One
   rule (time ordering, date against date and time) has one implementation shared by both.
3. **Profile admission is the checker's.** Which arms and leaves a slot reads (case data before
   selection, form answers after the form closed, Search answers, search results, a row) is checked
   from the profile (`lib/domain/expression/profiles.ts`, part 01 §4), so the checker, the card
   editor and the XPath linter read one statement. So are four facts about what a slot's targets
   hold (§3.10): a system date is a day on a device, `closed_on` exists only in HQ's search,
   Postgres needs a fixed `format-date` pattern, and a date-and-time literal names at most a
   millisecond. Every finding keeps the `ValidationErrorCode` a person sees today; a projection
   table per slot maps checker codes onto them.
4. **Syntax and vocabulary refusals leave the validator.** A stored document cannot hold an
   unknown function, a union, a `//` step, an unknown `instance()` id or an unresolved path (part
   01 §1.5), so `XPATH_SYNTAX`, `UNKNOWN_FUNCTION`, `WRONG_ARITY`, the `XPATH_UNSUPPORTED_*` family,
   `XPATH_UNBOUND_VARIABLE`, `XPATH_FUNCTION_UNAVAILABLE`, `XPATH_FUNCTION_SIGNATURE_UNAVAILABLE`,
   `XPATH_INSTANCE_UNAVAILABLE`, `UNQUOTED_STRING_LITERAL` and `CONNECT_UNQUOTED_XPATH` become the
   parse issue codes of part 02 §1.4 (`syntax`, `unknown-function`, `arity`, …; the mapping is §2.3).
5. **New refusals** in form logic, five new validation codes of this part:
   `XPATH_INCOMPATIBLE_VALUES` (a date against a date and time, a date and time ordered against
   anything but a date and time, `true()`/`false()` against an answer, a device's day-only system
   date ordered against a moment that is not a whole day or compared by `=` / `!=` with any
   moment), `XPATH_MANY_VALUES` (a repeat's answer read from outside it, or the cases a several-case
   module selects, used as one value), `SELECT_DEFAULT_NOT_AN_OPTION` (finding 72),
   `SELECT_PRELOAD_WRITE_NOT_AN_OPTION` (its writer twin, §4.3) and
   `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` (finding 73's authoring half). `here()` outside a
   row, `jr:choice-name` on a question whose choices are not written, and `jr:itext` /
   `jr:choice-name` of text that shows an answer reuse `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`; a
   Search answer outside a no-matches form reuses `INVALID_SEARCH_REF`; a search-results read where
   no inline search supplies one is part 05's `SEARCH_RESULTS_NOT_SUPPLIED`, and its row-type and
   order rules share one new code, `SEARCH_RESULTS_READ_INVALID`.
6. **Hidden values join writer agreement.** Executed during planning: today a Hidden Value can
   write text into a property a date question preloads, and the validator admits it (§4.2). From
   step 3 a Hidden Value's inferred type must be storage-assignable to the property's type, the
   rule case operations already meet. A literal a Hidden Value or a case operation writes into a
   property a static choice question preloads must be one of that question's options, as a literal
   default must (§4.3); a computed write stays admitted, as a computed default does.
7. **Hidden Value types are a least fixpoint per document** (part 01 §3.2), computed with the
   effective catalog in one memoised build that replaces `effectiveCaseTypes.ts::WHOLE_EXPRESSION_TYPES`.
   A Hidden Value's bind keeps today's rule (`lib/domain/fieldValueType.ts::fieldValueType`, the
   writer destination; part 04 §5.4), so `fieldValueType` stays.
   **Implementation correction, 2026-10-19:** `WHOLE_EXPRESSION_TYPES` no longer existed at the
   stack's pull request 5 head, which had replaced it with the closed
   `effectiveCaseTypes.ts::inferHiddenWriterType` / `inferExpressionType`; pull request 6 deletes
   those two. `effectiveCaseTypes`, `materializableCaseTypes` and `concreteCasePropertyWriterTypes`
   keep their names and callers as projections of `lib/domain/expression/inference.ts::inferExpressionTypes`.
8. **The gate gets cheaper.** Executed during planning: today's gate makes 12.0 Lezer parses per
   form-logic slot (60,720 on the 3,000-field fixture, 108 ms of its 270 ms); the record checker
   costs 0.07 µs a node. Memoisation is per document and per form, never per slot.
9. **Several values are refused only where they are structural**: a read of a repeat's answer from
   outside that repeat, and a `selected-cases` read, each used as one value. The module selects
   several cases by declaration, as a repeat holds several rows. A `cases`, `table-rows` or
   `locations` node-set used as one value is admitted, because only its data decides how many rows
   match; Core throws at run time on more than one, as it does today. Production holds a few
   structural reads, in very few apps, and no `selected-cases` read; the cutover lifts each
   structural read to its first row (§3.4).
10. **A document valid today that step 3 refuses is a cutover blocker,** counted twice: two
    read-only production scans, executed during planning, count what today's code can decide (every
    class of §3 but writer agreement and inference, §5.3), and the cutover's read-only dry run, under
    the person's standing permission for read-only production reads (given 2026-10-17), runs this
    part's checker over every lifted production document and counts findings by code (§5.4). Every
    non-zero count of the dry run is a `target-gate` blocker (part 09 §11) the author resolves in
    the app before the window; while Nova is dogfooded the person is the fleet's author. The corpus
    half is executed here: none of the new form-logic refusals but finding 72 fires on the corpus,
    and finding 72 fires only on the fuzz sample.
11. **The checker lands in five pull requests of the stack** (§10): its core, today's rules moved,
    the parse-issue codes, entry supply over session datum identity and finding 72 in pull request
    5, the shape; the other new refusals of §3 (with `here()` outside a row,
    `datetime-literal-precision`, `format-date-pattern-not-fixed` and `number-of-date`) but
    `itext-reference`, writer agreement with the select-preload writer rule, and inference in pull
    request 6, the checker; the day rule in pull request 8, the lowering; the day rule over search
    results rows, `SEARCH_RESULTS_READ_INVALID` and `itext-reference` with the `jr:itext` reads in
    pull request 9, instances and session; and
    `closed-on-not-on-device` and the chosen case in record slots in pull request 10, CSQL.

---

## 1. One checker

### 1.1 Where it lives and what it exports

`lib/domain/expression/typeChecker.ts` (part 01 §6.1) holds the walk; the checker's files in
part 01's layout hold:

| File | Holds |
|---|---|
| `typeChecker.ts` | `checkExpression`, `typeOf`, the per-arm rules (today's arms moved verbatim from `lib/domain/predicate/typeChecker.ts`, the new arms added) |
| `ruleSets.ts` | `typesCompatible`, `ORDERED_TYPES`, `isValueStorageAssignable` (moved), the form coercion table, `orderingVerdict` (the one ordering rule, §3.1), the `record-position` rule (§3.11), the target facts (§3.10), and the inverse rules the card editor reads (`compatibleTypesFor`, `comparisonOperatorsFor`, `matchModesFor`, moved) |
| `context.ts` | `ExpressionContext`, `slotContext(doc, slot, lookupTables)` (the one builder of a slot's context), `expressionFacts(doc)` and `formExpressionFacts(doc, formUuid)` (§1.3); `expressionFacts` has this one home |
| `inference.ts` (part 01) | `inferExpressionTypes(doc)`, the Hidden Value and effective-catalog fixpoint (§5) that `expressionFacts` calls |

```ts
export type RuleSet = "record" | "form";

export type Expectation =
  | { readonly kind: "condition" }                                    // a boolean slot
  | { readonly kind: "value"; readonly type?: DataType; readonly many?: true }
  | { readonly kind: "assignment"; readonly destinations: readonly DataType[] };

export interface CheckOutcome {
  readonly type: NodeType | undefined;        // part 01 §3.1, both axes, with caseIdOf
  readonly errors: readonly CheckError[];     // path into the tree, code, reason, message
}

export function checkExpression(expression: Expression, ctx: ExpressionContext): CheckOutcome;
/** The type alone, memoised per (expression object, context); emitters, lowering and the parser's row typing read it. */
export function typeOf(expression: Expression, ctx: ExpressionContext): NodeType | undefined;
```

`checkPredicate(p, ctx)` is `checkExpression` with `{ kind: "condition" }`;
`checkValueExpression(e, ctx, t)` is `{ kind: "value", type: t }`; `checkValueAssignmentExpression(e,
ctx, ds)` is `{ kind: "assignment", destinations: ds }`. The three names leave with
`lib/domain/predicate` (part 01: no shim), and every caller in `lib/commcare/validator/rules`,
`lib/doc` and `components/builder` moves to the one name in pull request 5, the shape, which moves
the package. A `CheckError` keeps today's shape (`path`, `code`, `message`;
`typeChecker.ts::CheckError`) and gains an optional `reason`, a closed string per code that the
projection (§1.5) copies into `details.reason` (`incompatible-values` carries `date-datetime`,
`datetime-ordering`, `boolean` or `day-only-on-device`; **implementation correction, 2026-10-19:**
also `clock-lost` from pull request 8, and `expected-value` carries `clock-lost` from pull request 6,
§5.1). A finding names a node by its path in the
tree, never by a text offset, and the form-XPath printer's span map (part 02 §1.5,
`lib/domain/expression/spans.ts::spanFor`) turns a path into the range the XPath linter underlines.

`typeOf` also answers the parser's row typing: a `@case_id = <e>` predicate types a `cases` row when
`typeOf(e)` carries `caseIdOf T` (part 02 §1.3, part 01 §1.3 rule 2; a selected-case datum,
`form-case case_id`, `case-index`, `repeat-row id`, `id-of`, and a cases-sourced select's answer).
The checker reads the row's stored `prop.caseType` and never re-derives it, so a query the parser
bound to the one declaring case type (§3.4, "Untyped queries") is an ordinary typed query to the
checker.

`CheckErrorCode` keeps all 34 of today's codes and gains sixteen:

| New code | Means |
|---|---|
| `many-values` | a structurally several-valued node-set (a repeat's answer read from outside the repeat, or a `selected-cases` read) where one value is needed (§3.4) |
| `default-not-a-choice` | a literal default on a static-choice question that is none of its choices (§3.5) |
| `arm-unavailable` | an arm or leaf the slot's profile does not admit (`here`, `call` in a record slot, `choice-name` on dynamic choices) |
| `case-data-unavailable` | a case read in a slot that runs before any case is chosen |
| `form-answer-unavailable` | a form read in a slot that runs with no open form (after-submit links, navigation, Search) |
| `search-answer-unavailable` | a Search answer read outside a no-matches form (§3.8) |
| `search-results-not-supplied` | a search-results read where the evaluating entry carries no inline query (§3.8; part 05 §2.8) |
| `search-results-order` | a search-results read whose answer depends on HQ's order (part 05 §2.8) |
| `search-results-other-type` | a search-results `@case_type` predicate naming a type the search cannot return (part 05 §2.8) |
| `row-scope` | a row leaf with no row in scope (part 01 §1.1) |
| `datum-not-supplied` | a session datum, `selected-cases` or chosen-case read the evaluating entry has not supplied when the slot runs (§3.9) |
| `itext-reference` | `jr:itext` / `jr:choice-name` of text that shows an answer in some language (§3.7; part 07 §3.3) |
| `record-position` | a boolean arm in a record value position, or a value arm in a record condition position (§3.11; part 01 §3.4) |
| `closed-on-not-on-device` | `closed_on` read in a slot a device evaluates (§3.10; part 06 §3.1) |
| `datetime-literal-precision` | a date-and-time literal finer than a millisecond (§3.10; part 06 §3.13) |
| `format-date-pattern-not-fixed` | a computed `format-date` pattern in a profile with a Postgres target (§3.10; part 07 §5.1) |

`incompatible-values`, `time-ordering`, `number-value` and `text-or-number-value` are today's codes;
`incompatible-values` gains the reasons above, and `text-or-number-value` is already the record
refusal of `double` over a date or a date and time, which part 07 §5.1 calls `number-of-date`
(§3.10).

`components/builder/shared/checkErrorPresentation.ts::PRESENT_BY_CODE` is a total
`Record<CheckErrorCode, …>`, so each code gets its card-editor line in the same pull request:

| Code | Card editor line |
|---|---|
| `many-values` | Choose one entry, or count or join the entries |
| `default-not-a-choice` | Choose one of this question's choices as its starting value |
| `arm-unavailable` | This isn't available here. You can choose another value |
| `case-data-unavailable` | Case information isn't available here. You can use worker information or a fixed value |
| `form-answer-unavailable` | Form answers aren't available here. You can save the answer to the case and read it there |
| `search-answer-unavailable` | Search answers aren't available here |
| `search-results-not-supplied` | This form doesn't open after a search, so it has no results to read |
| `search-results-order` | Search results come in no fixed order. You can count them instead |
| `search-results-other-type` | This search can't find that kind of case |
| `row-scope` | Choose a value from the row shown here |
| `datum-not-supplied` | Choose a case picked in an earlier menu |
| `itext-reference` | This wording shows an answer, so it can't be read here. You can read the answer itself |
| `record-position` | This spot takes a value, not a yes or no check (reason `value-expected`); This spot takes a yes or no check. You can compare this value with something (reason `condition-expected`) |
| `closed-on-not-on-device` | Date closed is known only to CommCare's server search. Case status shows whether a case is closed |
| `datetime-literal-precision` | Choose a time to the millisecond or coarser |
| `format-date-pattern-not-fixed` | Choose a fixed date format here |

`incompatible-values` keeps its line and gains one for the reason `day-only-on-device`: On a device
CommCare keeps only the day a case was opened or last changed. You can compare it with a date instead.

### 1.2 The two rule sets

The profile names the rule set (part 01 §4, "Rule set" column): every record-dialect slot takes
`record`, every form-XPath slot takes `form`.

| Question | Record rule set (today's, unchanged) | Form rule set (new) |
|---|---|---|
| Compatibility of `=` / `!=` operands | `typesCompatible`: null with anything, equal types, `int`↔`decimal`, selects↔`text`, plus `boolean`↔`boolean` and `choice`↔its select and `text` (part 01 §3.4) | Core's `XPathEqExpr.evalRaw` coercion (both sides unpacked through `FunctionUtils.unpack`, then compared), refused only for rules 2, 5 and 7 below |
| Ordering operands | `ORDERED_TYPES` (`int`, `decimal`, `date`, `datetime`), `time-ordering` first, `ordered-values` otherwise | rules 1, 2 and 7; text, selects and numbers order as Core's `FunctionUtils.toNumeric` does |
| Arithmetic | numeric operands only (`number-value`) | rule 3 only |
| Branch agreement (`if`, `coalesce`, `switch`) | `accumulateBranchType`, `branch-values` | none: Core returns the branch it takes |
| Positions | `record-position` (§3.11; part 01 §3.4): conditions and values keep today's positions | none: boolean-ness is only a type |
| Case writes | `isValueStorageAssignable` per output (`visitAssignmentOutputs`) | the same, for Hidden Value writers (§4.3), with `''` fitting every destination |
| Cardinality | `onDeviceExpressionCompatibility` keeps refusing multi-case scalar reads (unchanged, a separate rule) | rule 4 |
| Target facts (§3.10) | `day-only-on-device`, `closed-on-not-on-device`, `datetime-literal-precision`, `format-date-pattern-not-fixed` where the profile's targets call for them | rule 7 |

The form rule set refuses exactly:

1. an ordering with a `time` operand (`time-ordering`; §3.1);
2. a `date` against a `datetime` with no explicit `date()` on one side, under `=`, `!=` or an
   ordering, and a `datetime` ordered against an operand known not to be a `datetime`
   (`incompatible-values`; §3.2);
3. a provably non-numeric string literal in a numeric position (`number-value`; today's
   `lib/commcare/validator/typeChecker.ts::checkTypes`, whose rule moves unchanged, `''` admitted);
4. a structurally several-valued node-set where one value is needed: a repeat's answer read from
   outside the repeat, or a `selected-cases` read (`many-values`; §3.4);
5. a `boolean` compared by `=` or `!=` with a non-`boolean` (`incompatible-values`; §3.3);
6. a literal default on a static-choice question that is none of its choices
   (`default-not-a-choice`; §3.5);
7. the target facts of §3.10 that a form profile can meet: `date_opened` / `last_modified` read from
   `casedb`, and `date_opened` read from a `results` or `results:inline` row, ordered against a
   `datetime` operand that is not day-aligned, or compared by `=` / `!=` with any `datetime`
   operand, day-aligned included (`incompatible-values`, reason `day-only-on-device`; §3.2, part 04
   §3.4; against a `date` operand it is rule 2's `date-datetime`), `closed_on`
   (`closed-on-not-on-device`), and a date-and-time literal finer than a millisecond
   (`datetime-literal-precision`).

Everything else Core coerces is admitted, including `if(…)` branches of different types, text in
arithmetic, a select compared with any text, a `cases`, `table-rows` or `locations` query used as
one value, and any expression in a `relevant`, `validate` or `required` slot (Core's
`XPathConditional.eval` coerces it through `FunctionUtils.toBoolean`).

Record literals keep today's `literalType`: a JavaScript `boolean` literal is `text`
(`typeChecker.ts::literalType`), so no record verdict moves. Only the arms that yield `boolean`
(`match-all`, `match-none`, comparisons, `and`, `or`, `not`) are `boolean`, and a record slot can
place one in a comparison only through a shape step 3 adds (part 01 §1.1), which `record-position`
then reads by position (§3.11).

### 1.3 `ExpressionContext`

```ts
export interface ExpressionContext {
  readonly ruleSet: RuleSet;
  readonly profile: SlotProfile;            // admitted arms and leaves, scope, targets, expectation
  readonly facts: ExpressionFacts;          // per document, memoised on the doc reference
  readonly form?: FormExpressionFacts;      // per form, memoised on (doc, form uuid)
  readonly contextField?: Uuid;             // the slot's context node (part 01 §4); absent in session and global slots
  readonly rows: readonly RowScope[];       // the lexical row stack: case row, table row, location, repeat item
  readonly lookupTables: LookupTypeIndex;   // today's rows-free table → column → type index
  /** What the evaluating entry has supplied when the slot runs (lib/domain/entryDatumSupplies.ts); [] where nothing is. */
  readonly supplies: EntryDatumSupplies;
  /** A form link's target entry, for its `datums[].name`; absent in every other slot. */
  readonly targetSupplies?: EntryDatumSupplies;
}

export interface RowScope {
  readonly kind: "case" | "table" | "location" | "repeat";
  /** Where the row comes from; a system date's held class reads it (part 01 §3.2). */
  readonly root: "casedb" | "results" | "results:inline" | "table" | "locations" | "form";
  readonly caseType?: string;               // a case row's stored type
}

export interface ExpressionFacts {
  readonly caseTypes: readonly CaseType[];                   // the effective catalog of §5.1, standard properties included
  readonly searchOnlyProperties: Readonly<Record<string, DataType>>; // SEARCH_ONLY_CASE_PROPERTY_DATA_TYPES (part 06 §3.1)
  readonly hiddenTypes: ReadonlyMap<Uuid, DataType>;         // §5, absent = unknown
  readonly options: ReadonlyMap<Uuid, readonly SelectOption[]>; // static choices of every inline select
  readonly userPropertySlugs: ReadonlyMap<Uuid, string>;
  readonly organizationLevels: Readonly<Record<string, OrganizationLevel>>;
  readonly locationProperties: ReadonlyMap<Uuid, LocationProperty>;
}

export interface FormExpressionFacts {
  readonly formType: FormType;
  readonly readableCaseTypes: ReadonlyMap<string, ReadonlySet<string>>; // caseRefAcceptMap(…, formType[, "session"])
  readonly fields: ReadonlyMap<Uuid, { readonly type: DataType | undefined; readonly held: Held; readonly repeats: readonly Uuid[] }>;
  readonly searchInputs: readonly SearchInputDecl[];
  readonly noMatchesForm: boolean;                           // where `input` is admitted (§3.8)
  readonly translationUnits: ReadonlyMap<string, { readonly showsAnswer: boolean }>; // collectTranslationUnits(doc) for this form (§3.7)
}
```

Every member of today's `TypeContext` (`typeChecker.ts::TypeContext`) has one home: `caseTypes`,
`organizationLevels`, `userPropertySlugs` move to `facts`; `knownInputs`, `formFields`,
`formCaseTypes` to `form`; `currentCaseType` and `tableScope` to the row stack; `operationIds`,
`ownerValues` and `patternMatching` become profile facts (part 01 §3.5); `lookupTables` stays.
`searchInputInstanceId` leaves the checker, which never read it ("ignored by type checking", its own
docblock), and becomes an emitter option. A row scope carries its root because the held class of
`date_opened` and `last_modified` depends on it (part 01 §3.2): both have the data type `datetime`
in every row (`standardCaseProperties.ts`), held `date` in a `casedb` row and in a `form-case` read,
text in a `results` or `results:inline` row (`date_opened` date-only there, the UTC day HQ writes).
So `day-only-on-device` (§3.10) applies to both system dates in `casedb` and to `date_opened` alone
in a results row, and `last_modified` in a results row is an instant that lowers normally (part 04
§3.4). No `group` row exists in step 3 (`groups` is held by step 7, group 2; part 01 §1.6).

**Entry supply is domain knowledge, passed in as a value.** Which `DatumRef`s an entry supplies,
and when, is computed in `lib/domain` by `lib/domain/entryDatumSupplies.ts::entryDatumSupplies`
(new in pull request 5; part 05 §1.3 states the set, part 01 §1.2 and §3.5 the boundary), as the
set supplied at one evaluation point, `EntryDatumSupplies = { refs: { ref, scalar }[];
searchResults?: { module }; differs?: DatumRef[] }`: the refs supplied there and whether each is
scalar, whether an inline search's results are, and, at a case list or search point, the refs the
entries the list runs in supply at different datum ids (part 05 §1.3, "One id per slot"). It holds
no datum id. Every input is a document fact the domain already owns, read at `main`:

| What it decides | Read from (`lib/domain` unless named) |
|---|---|
| which modules' selections an entry passes through | the parent-selection chain, `Module.parentCaseModuleUuid` (what `formLinkProjection.ts::parentSelectModuleUuid` reads), the form type (`CASE_LOADING_FORM_TYPES`), each selecting module's `caseType` |
| scalar or several | `caseListConfig.selection` (`modules.ts::caseSelectionCardinality`) |
| a child menu's selections aligned to its root's | menu nesting (`moduleHierarchy.ts::moduleParent`, `projectedModulePreorder`), the root's first form (`BlueprintDoc.formOrder`), case type and `modules.ts::caseSelectionCanFlowBetweenModules`, the same-case rule `formLinkProjection.ts::alignWithRootMenu` applies |
| `new-case`, `new-child-case { caseType }`, `worker-record` | the form's case-write inventory, `caseWriteInventory.ts::deriveCaseWriteInventory` (a registration form's create, its non-repeat child buckets, its usercase bucket), the same inventory `lib/commcare/formActions.ts::buildFormActions` turns into `open_case`, `subcases` and `usercase_update` |
| `tile-group-parents { module }` | `caseListConfig.tile.grouping` of the owning module or the root it is carried from |
| `searchResults { module }` | `modules.ts::moduleOpensOnSearch`, which `suite/case-search/inlineSearch.ts::moduleIsSearchFirst` wraps |

The datum id each ref prints as stays in `lib/commcare/formLinkProjection.ts::entryDatumIds`, which
reads the domain half and attaches ids, and a test holds that the two halves agree (part 05 §1.3).
`context.ts::slotContext(doc, slot, lookupTables)` puts the set at the slot's point into the
context and derives no supply of its own: for field logic and Connect slots, the set at the form's
point; for a form link's `condition` and `datums[].xpath`, the same set (the source form's entry,
after the form closes) and, for its `datums[].name`, the target form's set as `targetSupplies`; for
the record slots that read a chosen case from pull request 10 (§3.9), the set at the slot's
`case-list`, `search` or `form-menu` point (part 05 §1.3, "Evaluation points"). The validator, the XPath linter (through
`checkFormLogicSlot`, §1.5), the card editor's live verdicts and the builder's move verdicts
(`lib/doc/formSectionVerdicts.ts::fieldPlacementVerdict`) all build their
contexts through `slotContext` (**implementation correction, 2026-10-19:** `lib/doc/navigation.ts`
holds no verdict and builds no context; `fieldPlacementVerdict` is the one move verdict, §3.4). The card editor and the move verdicts need nothing beyond
`lib/domain`, so neither reaches `lib/commcare`, and no `biome.json` line changes: the builder
readers that do reach it, for datum ids and the form-logic parse, are the XPath editor's linter and
field (`lib/codemirror`, `components/builder/XPathField.tsx`), both allowlisted today.
Entry supply is the checker's: profile admission reads `ctx.supplies`, `rules/sessionData.ts`
leaves, and no `rules/case-search/searchResultsRead.ts` rule file is added.

### 1.4 Profile admission

For each node the checker asks the profile whether the arm, and for a leaf its scope, is admitted
before it types the node, and on a refusal it reports the profile code (`arm-unavailable`,
`case-data-unavailable`, `form-answer-unavailable`, `search-answer-unavailable`,
`search-results-not-supplied`, `row-scope`, `datum-not-supplied`) and skips typing that subtree,
which is today's precedence: a scope rule returns before the slot's type check runs
(`rules/case-search/searchButtonDisplayConditionTypeCheck.ts`, `predicateReadsCaseData` first;
`rules/lookupOptionsSource.ts`, the term walk before `checkPredicate`).

The scope walkers that today stand in front of the checker become this admission:
`lib/domain/predicate/walk.ts::predicateReadsCaseData` / `::expressionReadsCaseData` (read by
`rules/case-list/searchInputDefaultTypeCheck.ts`,
`rules/case-list/searchInputScreenPredicateTypeCheck.ts`,
`rules/case-search/excludedOwnerIdsTypeCheck.ts`, `rules/case-search/searchButtonDisplayConditionTypeCheck.ts`,
`rules/lookupOptionsSource.ts`, `rules/multiSelect.ts`), `rules/displayConditions.ts`'s own walk
`hasUnavailableCaseRead` (a module display condition reads no case data; a form display condition
reads only its case-first module's own case type through `self`, `propertyAllowedOnForm`; `count`,
`exists` and `missing` read case data in both), the table-row walk of
`rules/lookupOptionsSource.ts` (`LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED`, `_FIELD_NOT_EARLIER`,
`_FIELD_REPEAT_SCOPE`) and the candidate scope of `rules/caseOptionsSource.ts`
(`CASE_SELECT_FILTER_INVALID`). Each rule keeps its file, its location and its code; it calls
`checkExpression` with its slot's context and maps the admission codes onto its own codes (§1.5).
Outside the validator the two `walk.ts` guards have two kinds of reader. The SA/MCP boundary
schemas (`lib/agent/tools/case-list-config/shared.ts`, `lib/agent/tools/case-search-config/shared.ts`)
and the builder's global-scope pickers (`components/builder/shared/editorSchemas.ts`, whose rule
`components/builder/case-operations/editorScope.ts`'s docblock restates; `lib/domain/CLAUDE.md`)
read the profile's admission instead from pull request 5. `lib/commcare/session.ts`'s form-command
instance collection asks `predicateReadsCaseData` whether to declare `casedb` and `commcaresession`
for a form display condition; that is a question about what the emitted text reads, not about
admission, and from step 3 the serializer's own instance set answers it (part 04 §2.4), so that
read leaves with part 04's re-point of `session.ts`. Profile scope moving into the checker changes
no code a person sees; unchanged rule suites and an equal finding multiset over the corpus prove it
(§7, §9).

Target representability stays out of the checker: `rules/case-list/csqlPredicateRepresentability.ts`,
`onDeviceExpressionCompatibility.ts`, `dateAddOnDeviceCompatibility.ts`,
`matchModeOnDeviceCompatibility.ts`, `matchModeWhitespaceInValue.ts`,
`ancestorExistsCannotNestSubcase.ts`, `searchInputRefUsesWhenInputPresent.ts`
(`CASE_LIST_BARE_SEARCH_INPUT_REF`) and `case-search/searchRelatedCalculationCompatibility.ts` are
facts about what a target can run, owned by the typed CSQL part and the emission part. They read
`typeOf` where they need a type (today they call `checkExpression` themselves, for example
`expression/onDeviceCompatibility.ts`, the date-add and scalar-relation decisions these rules and
`lib/doc/commitVerdicts.ts` share, which pull request 10 moves whole to
`lib/commcare/validator/onDeviceCompatibility.ts` when `lib/commcare/expression/` leaves, part 06 §2.3). The four target facts of §3.10 are the exception, and are
the checker's: each is a fact about what a value is in a target (a day, an absent property, a
millisecond, a fixed pattern) rather than whether a target can run a shape, and each needs the
node's type. The checker reads them from `profile.targets` (part 01 §4's Targets column).

### 1.5 Where a finding goes

A checker finding becomes a `ValidationError` through one projection per slot family, so the code a
person sees is today's:

- **Record slots:** each rule keeps wrapping the checker's errors in its slot code
  (`CASE_LIST_FILTER_TYPE_ERROR`, `MODULE_DISPLAY_CONDITION_TYPE_ERROR`, …) after
  `lib/commcare/validator/lookupTypeContext.ts::semanticCheckErrors` drops the structural lookup
  codes the lookup validator owns, as today, and maps the admission codes onto its
  `*_CASE_DATA_UNAVAILABLE` / `*_SCOPE` / `LOOKUP_SELECT_FILTER_*` codes. `record-position`,
  `format-date-pattern-not-fixed`, `datetime-literal-precision` and `incompatible-values` with reason
  `day-only-on-device` go under the slot's `*_TYPE_ERROR` like every other type code;
  `closed-on-not-on-device` is `CASE_LIST_CLOSED_ON_NOT_ON_DEVICE` in every slot (part 06 §3.1);
  `datum-not-supplied` on a chosen case (§3.9, from pull request 10) is `SESSION_DATUM_NOT_SUPPLIED`
  in every slot, the same code form logic uses for the same fact. **Every record type error names
  its checker code**, from pull request 5: today only `rules/lookupOptionsSource.ts` and
  `rules/case-list/searchInputScreenPredicateTypeCheck.ts` put `checkCode` in `details`, and the
  other rules put `{ path }` alone (`rules/case-list/filterTypeCheck.ts`). One helper beside
  `semanticCheckErrors`, `lookupTypeContext.ts::checkErrorDetails(error)` (new), gives every rule
  `{ path, checkCode, checkReason? }`, `checkReason` being the `CheckError`'s reason where it has
  one, so the dry run can count `day-only-on-device` and `record-position` in record slots (§5.4).
  The reason is `checkReason`, not `reason`, because `details.reason` already names target
  findings under the same codes (`rules/caseOperations.ts::onDeviceDateAddOperationError` puts
  `reason: "datetime-base"` under `CASE_OPERATION_EXPRESSION_TYPE`). No existing assertion reads a
  record type error's `details` whole (searched: `lib/commcare/validator`), so the rule suites stay
  unchanged.
- **Form-logic slots:** `lib/commcare/validator/formLogicFindings.ts::formLogicFindings` (new,
  replacing `validateBlueprintDeep`'s per-slot body) projects as below. Its per-slot body is
  exported as `::checkFormLogicSlot(doc, slot, expression): readonly ValidationError[]`, which the
  XPath linter runs on a parsed draft (part 02 §4.1), so the editor and the gate project one way:

| Checker code (and arm at its path) | `ValidationErrorCode` | Class |
|---|---|---|
| `unknown-form-field`, a `choice` option or translation unit or datum source that no longer exists | `INVALID_REF`, `details.storedRef: "dangling-identity"` | soundness |
| `form-answer-unavailable` (a `field` or `repeat-row` in a session profile) | `INVALID_REF`, `SESSION_FORM_READ_MESSAGE` | soundness |
| `row-scope` | `INVALID_REF` | soundness |
| `unknown-property` / `unknown-case-type` on `form-case`, or on a `prop` of a `cases` row | `INVALID_CASE_REF` (message from `xpathValidator.ts::checkCaseHashtag`, moved; a row read names its query) | soundness |
| the same on a registration form for the own type's property | `CASE_HASHTAG_ON_CREATE_FORM` alone | soundness |
| `search-answer-unavailable` | `INVALID_SEARCH_REF` | soundness |
| `search-results-not-supplied` | `SEARCH_RESULTS_NOT_SUPPLIED` (part 05 §2.8; `details: { slot, carrier, reason }`, reason `not-search-first`, `no-matches-form` or `link-source`) | soundness |
| `search-results-order`, `search-results-other-type` | `SEARCH_RESULTS_READ_INVALID` (new), `details.reason` `order` or `other-type` | soundness |
| `arm-unavailable` on `here` or `choice-name` | `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, `details.reason` `here` or `choice-name-dynamic` | soundness |
| `itext-reference` | `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, `details.reason: "itext-reference"` (part 07 §3.3) | soundness |
| `arm-unavailable` on `field { spelling: "current" }` or a zero-argument `position()` outside a predicate in a session profile | `XPATH_CARRIER_CONTEXT_UNAVAILABLE` | soundness |
| `datum-not-supplied` | `SESSION_DATUM_NOT_SUPPLIED` (part 05 §1.6's `details`: `ref`, `slot`, `carrier`, `reason`) | soundness |
| `number-value` | `TYPE_ERROR` | soundness |
| `datetime-literal-precision` | `TYPE_ERROR`, `details.reason: "datetime-literal-precision"` | soundness |
| `time-ordering` | `XPATH_TIME_ORDERING` | soundness |
| `incompatible-values` | `XPATH_INCOMPATIBLE_VALUES` (new), `details.reason` `date-datetime`, `datetime-ordering`, `boolean` or `day-only-on-device` | soundness |
| `closed-on-not-on-device` | `CASE_LIST_CLOSED_ON_NOT_ON_DEVICE` (part 06 §3.1) | soundness |
| `many-values` | `XPATH_MANY_VALUES` (new), `details.reason` `repeat` or `selected-cases` | soundness |
| `default-not-a-choice` | `SELECT_DEFAULT_NOT_AN_OPTION` (new), located at the field, slot `default_value` | soundness |

A case read on a registration form gives one finding from step 3, `CASE_HASHTAG_ON_CREATE_FORM`.
Today `INVALID_CASE_REF` and `CASE_HASHTAG_ON_CREATE_FORM` both fire for the one read (executed
during planning: the Hidden-writer documents); the batch is refused
either way.

The five new codes of this part (`XPATH_INCOMPATIBLE_VALUES`, `XPATH_MANY_VALUES`,
`SELECT_DEFAULT_NOT_AN_OPTION`, `SELECT_PRELOAD_WRITE_NOT_AN_OPTION`,
`HIDDEN_VALUE_WRITER_TYPE_MISMATCH`), and `SEARCH_RESULTS_READ_INVALID` for part 05's row-type and
order rules, are codes rather than reasons under `TYPE_ERROR`, so that `userFacingErrors.ts`'s typed
table forces each its own copy. Each new code gets a row in `gate.ts::VALIDITY_CLASS_BY_CODE` (the
table is typed-total, so the pull request does not compile without it) and an entry in
`lib/doc/userFacingErrors.ts` (typed-total over non-oracle codes), in the pull request that adds it
(§10): `SELECT_DEFAULT_NOT_AN_OPTION` in pull request 5; `XPATH_INCOMPATIBLE_VALUES`,
`XPATH_MANY_VALUES`, `SELECT_PRELOAD_WRITE_NOT_AN_OPTION` and `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` in
pull request 6 (the reason `day-only-on-device` joins `XPATH_INCOMPATIBLE_VALUES` in pull request
8); `SEARCH_RESULTS_READ_INVALID` with the reads it governs in pull request 9, beside part 05's
`SEARCH_RESULTS_NOT_SUPPLIED` and `LOCATIONS_READ_NEEDS_ORGANIZATION`; part 06's
`CASE_LIST_CLOSED_ON_NOT_ON_DEVICE` with `closed_on` in pull request 10, which also lists
`errors.ts`, `gate.ts`, `userFacingErrors.ts` and `checkErrorPresentation.ts`. The reasons
`datetime-literal-precision`, `format-date-pattern-not-fixed` and `number-of-date` (§3.10) join
their codes in pull request 6. Where one code carries several reasons the `userFacingErrors.ts`
entry picks its sentence by `details.reason`, as `INVALID_REF` picks by `details.storedRef` today.
`DeepValidationError` (`lib/commcare/validator/index.ts`) keeps its five kinds; `field-xpath`,
`connect-xpath` and `form-link-xpath` carry a `CheckError` path where they carry an `XPathError`
position today.

---

## 2. Every rule over expressions today, and where it goes

### 2.1 Form logic

`lib/commcare/validator/index.ts::validateBlueprintDeep` runs, for every form-logic slot (field
slots through `expressionSurfaceReads(field, "xpath")`, form-link slots, Connect slots), four
passes: `canonicalXPathError` (dangling identity, then a parse of the printed text and a print of
the parse, compared with the stored tree), `xpathValidator.ts::validateXPath` (phases 1 to 3),
`timeOrderingErrors`, and, outside the deep walk, `rules/sessionData.ts`,
`runner.ts::validateXPathCarrierInstances` and `rules/app.ts`'s two catalog rules.

| Today | What it refuses | From step 3 |
|---|---|---|
| `canonicalXPathError`, dangling leaf | a `field-ref` / `path-ref` whose field is gone | checker, `unknown-form-field` → `INVALID_REF` (dangling) |
| `canonicalXPathError`, round trip | a stored AST that does not survive print and parse | removed: the tree is the stored form, the round-trip law is a property test of the parser and printer (part 02), not a gate |
| `validateXPath` phase 1 | Lezer error nodes (`XPATH_SYNTAX`) | parse issue `syntax` (part 02 §1.4) |
| phase 2a | unknown function, arity, `instance()` with a non-literal, `current()`/`instance()` not at a path root | parse issues `unknown-function`, `arity`, `instance-argument`, `filter-root` (`call.fn` is a closed enum and its arity a refinement of the `call` schema, part 01 §1.4) |
| phase 2b | `#<type>/<prop>` not readable (`INVALID_CASE_REF`); `#form/` in session scope | checker (§1.5) |
| `analyzeXPathCompatibility` | unions, `//`, filters, axes, node tests, `$var` (`XPATH_UNSUPPORTED_*`, `XPATH_UNBOUND_VARIABLE`); functions Core lacks (`XPATH_FUNCTION_UNAVAILABLE`, `_SIGNATURE_UNAVAILABLE`) | parse issues (§2.3's mapping) |
| same, context | `current()` and bare `position()` in session scope (`XPATH_CARRIER_CONTEXT_UNAVAILABLE`); context handlers (`here`) | checker admission (§1.5) |
| phase 2c | unknown `/data/…` path, the form root `/data`, form paths in session scope | parse issues `unknown-field`, `form-root` (part 01 §1.5); the session case is the checker's |
| phase 2d | unknown bare relative name; any relative name in session scope | parse issues `relative-unknown`, `relative-no-context` |
| phase 3, `checkTypes` | non-numeric string literal in a numeric position (`TYPE_ERROR`) | checker, form rule 3 |
| `searchAnswerRefError` | `#search/` outside a no-matches form, or naming a removed prompt (`INVALID_SEARCH_REF`) | text naming no Search input of the form's module: part 02's parse refusal `unknown-search-input`; a resolved `input` outside a no-matches form, typed or stranded by a later batch: checker admission (§3.8, `INVALID_SEARCH_REF`, as part 02 §1.4 lists it); a removed prompt: dangling identity |
| `timeOrderingErrors` | an ordering on a time (`XPATH_TIME_ORDERING`) | checker, the one ordering rule (§3.1); `timeOrdering.ts` is deleted |
| `rules/sessionData.ts` | an exact `session/data/<id>` the entry does not declare (`SESSION_DATUM_NOT_SUPPLIED`) | text naming an id no ref resolves to, a placeholder or a multi-select datum: part 02's parse refusals `unknown-datum` and `multi-select-datum-value` (part 05 §1.6); a stored ref the entry stops supplying: checker admission over `session-datum` and `selected-cases` (§3.9), and the file is deleted |
| `runner.ts::validateXPathCarrierInstances` | `instance()` ids other than `casedb` and `commcaresession` (`XPATH_INSTANCE_UNAVAILABLE`) | parse issue `instance-unknown`: an id outside part 01 §1.5's list has no arm |
| `rules/field.ts::unquotedStringLiteral`, `rules/form.ts` (`CONNECT_UNQUOTED_XPATH`) | a bare word that looks like text | parse issue `relative-unknown`, whose message keeps the "put it in quotes" hint (`xpath/detectUnquotedStringLiteral.ts` moves to the parser's issue builder) |
| `rules/form.ts` (`CONNECT_EMPTY_XPATH`), `rules/field.ts` (`EMPTY_REPEAT_COUNT`, `EMPTY_IDS_QUERY`) | an empty expression | `EMPTY_REPEAT_COUNT` and `EMPTY_IDS_QUERY` stay and read the slot's absence; `CONNECT_EMPTY_XPATH` leaves, since the union has no empty expression and an absent Connect slot takes its default (part 01 §1.1; production holds an empty expression in no required slot, and the cutover lifts each to absence) |
| `rules/field.ts` (`REPEAT_COUNT_TYPE`) | a count that reads a non-integer question directly | stays, reading the stored tree (`term field` at the root) |
| `rules/form.ts::caseHashtagOnCreateForm` (`CASE_HASHTAG_ON_CREATE_FORM`) | a case read on a registration form | checker admission, one finding per read (§1.5) |
| `rules/app.ts::catalogXPathCompatible`, `::catalogTimeOrdering` | catalog `required` / `validation` | retired with the slots (part 01 §4, decided with the person, 2026-10-17): both rules and `CASE_PROPERTY_XPATH_INCOMPATIBLE` are deleted, and no `catalog` profile exists. Production holds retiring values (`required`, `validation` and `validation_msg`); the cutover removes each and the notice names it |
| `TriggerDag.reportCycles` (`CYCLE`) | dependency cycles | stays; its dependency extraction reads the tree (part 07 §1.4), which gives relative reads the edges they lack today, so the dry run counts `CYCLE` over lifted documents (§5.4) |
| `validateTreeProse` (`INVALID_REF`, `INVALID_CASE_REF`, `PROSE_EDITOR_ROUND_TRIP_LOSS`) | prose reference parts | stays for the round-trip rule; prose `field` / `form-case` / worker leaves (part 01 §4, prose parts) are checked by the checker with the field's form profile, so a prose read of a repeat answer from outside the repeat is `XPATH_MANY_VALUES` too (§3.4) |
| `rules/form.ts` (`FORM_LINK_DATUM_UNUSED`, `FORM_LINK_DATUMS_INCOMPLETE`) | link datums | stay; `datums[].name` is a `FormLinkDatumName`, a `selected-case` of the target entry (part 01 §4, part 05 §1.5), which the rule reads instead of a name |

Beside the checker, part 05 adds two rules that read stored expressions without typing them:
`LOCATIONS_READ_NEEDS_ORGANIZATION` (a `locations` read in an app with no organization levels, part
05 §2.4) and `LOOKUP_TAG_RESERVED_BY_RUNTIME` (part 05 §2.3); both are part 05's, and neither is a
checker code.

### 2.2 The record family

Every rule keeps its file, its code, its location and its details; each moves from
`checkPredicate` / `checkValueExpression` / `checkValueAssignmentExpression` to `checkExpression`
with its slot's profile.

| Rule file | Codes | From step 3 |
|---|---|---|
| `case-list/filterTypeCheck.ts` | `CASE_LIST_FILTER_TYPE_ERROR` | checker, record rule set |
| `case-list/calculatedColumnTypeCheck.ts` | `CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR` | checker; `here` admitted by the profile |
| `case-list/searchInputDefaultTypeCheck.ts` | `…_DEFAULT_TYPE_ERROR`, `…_DEFAULT_CASE_DATA_UNAVAILABLE` | checker; the second through admission |
| `case-list/searchInputPredicateTypeCheck.ts` | `…_PREDICATE_TYPE_ERROR` | checker |
| `case-list/searchInputScreenPredicateTypeCheck.ts` | `…_REQUIRED_CONDITION_*`, `…_VALIDATION_RULE_*`, `…_HIDDEN_VALUE_*`, `…_OPTIONS_FILTER_*` | checker; the `CASE_DATA_UNAVAILABLE` and `SCOPE` codes through admission; `…_OPTIONS_FILTER_NOT_ON_DEVICE` stays a target rule |
| `case-search/excludedOwnerIdsTypeCheck.ts` | `CASE_SEARCH_EXCLUDED_OWNER_IDS_*` | checker; admission |
| `case-search/searchButtonDisplayConditionTypeCheck.ts` | `CASE_SEARCH_BUTTON_DISPLAY_CONDITION_*` | checker; admission |
| `displayConditions.ts` | `MODULE_/FORM_DISPLAY_CONDITION_TYPE_ERROR`, `_CASE_DATA_UNAVAILABLE`, `DISPLAY_CONDITION_SEARCH_INPUT_UNAVAILABLE` | checker; admission, which replaces the file's own `hasUnavailableCaseRead` (§1.4); from pull request 10 a form display condition also admits a chosen case (§3.9), and a module display condition refuses one under `MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE` |
| same | `DISPLAY_CONDITION_NOT_ON_DEVICE`, `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU` | stay: a target rule and a shape rule. The shape rule keeps its verdict over the union: `displayConditionStartsWithNever` moves with `simplify.ts` to `lib/domain/expression/simplify.ts` (part 01 §6.1) and still reads `match-none` or an `and` whose first clause is `match-none`, the two spellings that print what `hiddenFromMenu` prints |
| `caseOptionsSource.ts` | `CASE_SELECT_FILTER_INVALID`, `CASE_SELECT_SOURCE_INVALID` | checker; admission for the first |
| same | `CASE_SELECT_FILTER_NOT_ON_DEVICE` | stays a target rule |
| `lookupOptionsSource.ts` | `LOOKUP_SELECT_FILTER_TYPE_ERROR`, `_TERM_NOT_ALLOWED`, `_FIELD_NOT_EARLIER`, `_FIELD_REPEAT_SCOPE` | checker; the last three through admission (the profile's table-row scope and its "earlier field in the same or an enclosing repeat" rule) |
| same | `LOOKUP_SELECT_FILTER_NOT_ON_DEVICE` | stays a target rule |
| `caseOperations.ts` | `CASE_OPERATION_EXPRESSION_TYPE` | checker, `assignment` expectation for values; `CASE_OPERATION_SESSION_UNAVAILABLE` and the order / correlation / retype codes stay the rule's own |
| `case-list/csqlPredicateRepresentability.ts` and the five portability rules of §1.4 | their codes | stay; the typed CSQL and emission parts |
| `fieldKindMatchesPropertyType.ts` | `FIELD_KIND_PROPERTY_TYPE_MISMATCH`, `FIELD_KIND_WRITERS_DISAGREE` | stay for visible writers; Hidden Value writers get their own rule (§4.3) |
| `lib/commcare/validator/lookupReferences.ts` (structural) | `LOOKUP_TABLE_NOT_AVAILABLE`, `LOOKUP_COLUMN_NOT_AVAILABLE`, `LOOKUP_COLUMN_TYPE_MISMATCH` | stay the sole owner; their extractors gain the form-logic `table-lookup`, `table-rows` and `table-column` leaves (part 05 §2.3's four extractors in `lib/doc/lookupReferences.ts::PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS`), and the checker's `unknown-lookup-*` codes stay filtered from every slot's type error, as today (`lib/domain/predicate/CLAUDE.md`, "Lookup-aware callers") |

### 2.3 Codes that leave `ValidationErrorCode`

`XPATH_SYNTAX`, `UNKNOWN_FUNCTION`, `WRONG_ARITY`, `XPATH_UNBOUND_VARIABLE`,
`XPATH_UNSUPPORTED_UNION`, `_DESCENDANT`, `_FILTER`, `_AXIS`, `_NODE_TEST`, `_PATH`,
`XPATH_FUNCTION_UNAVAILABLE`, `XPATH_FUNCTION_SIGNATURE_UNAVAILABLE`, `XPATH_INSTANCE_UNAVAILABLE`,
`UNQUOTED_STRING_LITERAL`, `CONNECT_UNQUOTED_XPATH`, `CONNECT_EMPTY_XPATH`, and with the catalog
slots' retirement (part 01 §4) `CASE_PROPERTY_XPATH_INCOMPATIBLE` and `CASE_PROPERTY_REFERENCE_INVALID`.
The last is raised only by `rules/app.ts::canonicalCasePropertyDefaults`, which reads nothing but a
catalog property's `required` and `validation` (a form read in either, an unresolved reference, the
form root), so the rule leaves with those slots in pull request 5, beside `catalogXPathCompatible` and
`catalogTimeOrdering`; `lib/commcare/validator/__tests__/formRootRead.test.ts`, which asserts its
catalog case and imports `SESSION_FORM_READ_MESSAGE` from `xpathValidator.ts` and
`formRootReadPositions` from `lib/preview/xpath/dependencies.ts`, is rewritten in the same pull request:
the form root read alone is the parse issue `form-root` in every carrier, its catalog case leaves,
and it imports the message from `formLogicFindings.ts`. Each leaves
`lib/commcare/validator/errors.ts`, its row in `gate.ts::VALIDITY_CLASS_BY_CODE`, its entry in
`runner.ts::SCOPE_EXEMPT_CODES` where it has one (`XPATH_INSTANCE_UNAVAILABLE`,
`CASE_PROPERTY_XPATH_INCOMPATIBLE`), and its line in `lib/doc/userFacingErrors.ts`. The first
fifteen become part 02 §1.4's closed parse issue codes of `lib/commcare/xpath/expressionAst.ts`
(which today carries only `"syntax"` and `"unresolved-reference"`). Part 02 owns that vocabulary,
its messages and its one presenter for the builder's linter, the SA and MCP `AuthoringInputError`
and the cutover's lift report; their `userFacingErrors.ts` copy moves to the linter's presenter. A
person sees the same refusals, in the editor instead of at commit. Each leaving code maps onto the
issue that refuses the same construct (today's triggers:
`lib/commcare/xpath/compatibility.ts::analyzeXPathCompatibility`):

| Leaving code | Part 02 parse issue |
|---|---|
| `XPATH_SYNTAX` | `syntax` |
| `UNKNOWN_FUNCTION`, `XPATH_FUNCTION_UNAVAILABLE` | `unknown-function` |
| `WRONG_ARITY`, `XPATH_FUNCTION_SIGNATURE_UNAVAILABLE` | `arity` |
| `XPATH_UNBOUND_VARIABLE` | `variable` |
| `XPATH_UNSUPPORTED_UNION` | `union` |
| `XPATH_UNSUPPORTED_DESCENDANT`, `XPATH_UNSUPPORTED_AXIS` | `axis` |
| `XPATH_UNSUPPORTED_FILTER` | `filter-root` |
| `XPATH_UNSUPPORTED_NODE_TEST` | `wildcard` (a `*` step), `axis` (another node test on a kept axis) |
| `XPATH_UNSUPPORTED_PATH` | `filter-root` (a path rooted at a function other than `current()` or `instance()`), `parent-after-name` (`..` after a named step) |
| `XPATH_INSTANCE_UNAVAILABLE` | `instance-unknown` |
| `UNQUOTED_STRING_LITERAL`, `CONNECT_UNQUOTED_XPATH` | `relative-unknown` |

Why they leave rather than stay as `shape` backstops: a `shape` row exists for a value that reaches a
document through a lenient path (`gate.ts`, the `shape` docblock), and none does here. The stored
schema has no arm for any of them, hydration and replay re-admit only committed states
(`lib/doc/CLAUDE.md`, `commitDoc`), and the cutover's lift parses every stored text with the
production parser, so a rule for them could never fire and its copy could never be read. Production
holds no stored text the parser refuses, so the lift meets none of them.

The SA and MCP read no code (`commitVerdicts.ts::describeCommitFindings` renders messages only);
the builder reads codes through `userFacingErrors.ts` and `checkErrorPresentation.ts`, both typed
total, and `proof/README.md` names `XPATH_TIME_ORDERING`, which stays. Outside tests (searched:
`lib`, `components`, `proof`, `scripts`, `app`, `e2e`, `content`, `docs`), the leaving codes are
named only by the validator files that raise and classify them (`errors.ts`, `gate.ts`,
`runner.ts`, `index.ts`, `xpathValidator.ts`, `rules/field.ts`, `rules/form.ts`, `rules/app.ts`),
by `lib/commcare/xpath/compatibility.ts` (its trigger table, which part 02 replaces with the parse
issues), by `lib/doc/userFacingErrors.ts`, and by four builder comments that say why an editor
clears a Connect slot rather than writing `""`, naming `CONNECT_EMPTY_XPATH`:
`components/builder/detail/appSettings/connectDraft.ts::xpathOverride`'s docblock,
`components/builder/detail/formSettings/LearnConfig.tsx` (the user-score save) and
`components/builder/detail/formSettings/DeliverConfig.tsx` (`clearDeliverField`'s docblock and the
entity-id save). Pull request 5 rewrites those four to give today's reason, which still holds: the
union has no empty expression, and an absent slot takes the wire default (part 01 §1.1). The frozen
copy in `lib/case-store/migrations/20260728000000_canonical_identity_foundation/` is a migration's
own snapshot, which no code change touches.

### 2.4 Copy changes for existing codes

| Code | `userFacingErrors.ts` from step 3 |
|---|---|
| `INVALID_SEARCH_REF` | `"X" in "F" reads a search answer this form can't get to. A form can read Search answers only when it opens after a search finds no matches.` |
| `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, reason `here` | `A formula on "X" in "F" uses here(), which is where the worker is. A case list knows that and a form doesn't. You can add a location question instead.` |
| same, reason `choice-name-dynamic` | `A formula on "X" in "F" asks for the label of a choice of "Q", whose choices come from a Project data table or from cases, so there is no label to read. You can read the label from where the choices come from instead.` (**Implementation correction, 2026-10-19:** the earlier "from the same table" did not fit a case-backed select) |
| same, reason `itext-reference` | `A formula on "X" in "F" reads the wording of "Q", which shows an answer. CommCare would show a placeholder there instead of the answer. You can read the answer itself instead.` |
| `INVALID_REF`, `details.identity: "choice"` | `A formula on "X" in "F" uses a choice that "Q" no longer has. You can choose one of its current choices.` |
| `SESSION_DATUM_NOT_SUPPLIED` | part 05 §1.6's sentence for the `details.reason` kind, with step 2's carrier wording for links and Connect |

The validator `message` (the agent-facing voice) for each is written in the same pull request; the
messages of §3 follow the same pattern: what was written, why CommCare can't run it, what to write
instead (`lib/commcare/validator/timeOrdering.ts::TIME_ORDERING_MESSAGE` and
`typeChecker.ts::TIME_ORDERING_MESSAGE` are the starting copy).

---

## 3. New refusals

Each refusal is soundness (`gate.ts`: "a wrong thing EXISTS … rejected on every commit"), so the
commit gate refuses the batch that introduces it on all three editors. What each editor shows:

- **Builder, form logic.** The XPath editor's linter shows the checker's finding as the person
  types (part 02 wires `checkExpression` into `lib/codemirror/xpath-lint.ts`, which reads
  `validateXPath` and `TIME_ORDERING_MESSAGE` today), and its save gate holds the edit. A batch
  that makes an untouched slot invalid (a field moved into a repeat, an option removed, a label
  given an answer while a `jr:itext` reads it) is refused with `userFacingErrors.ts`'s line in the
  error toast (`notifyRejectedCommit`).
- **Builder, record slots.** The card editor shows the `checkErrorPresentation.ts` line at the
  node's path, and its pickers withhold what the inverse rules refuse (`ruleSets.ts`).
- **SA and MCP.** `lib/agent/tools/common.ts::guardedMutate` returns
  `describeCommitFindings`, the validator `message` of each finding, and the change is not applied.

### 3.1 Time ordering: one rule for both vocabularies

**Today.** Two implementations: `typeChecker.ts::checkComparison` and `::checkBetween` push
`time-ordering` when an operand's resolved type is `time`; form logic runs
`timeOrdering.ts::findTimeOrderingComparisons`, a reader over the printed text that calls an operand
a time when it is a time question, a Hidden Value whose calculate is a time, a `time` case property,
`if`/`coalesce` with a time branch, or any string literal holding `:` (which catches a date and time
written as text).

**From step 3.** `ruleSets.ts::orderingVerdict(left: NodeType, right: NodeType, ruleSet)` is the one
rule; the comparison arms (`gt`, `gte`, `lt`, `lte`) and `between` call it in both rule sets. A
`time` on either side is `time-ordering`, ahead of every other ordering test, whatever the rule set.
In the form rule set a string literal ordered against anything takes its type by shape (part 01
§3.2): `HH:MM[:SS]` is `time` (refused here), an ISO date is `date`, an ISO date and time is
`datetime` (§3.2 decides it), and any other literal with a non-numeric character is rule 3
(`TYPE_ERROR`). So every shape today's reader refuses stays refused: a time question, a time-typed
Hidden Value (now through §5's inference, which covers a `default_value` and any expression, where
the reader read only a calculate), a time property, a time branch of `if` / `coalesce` (the branch
type), and a colon literal, under the rule that fits it.

Code: `XPATH_TIME_ORDERING` in form logic, the slot's code in record slots (unchanged). Message:
today's `TIME_ORDERING_MESSAGE` (form logic) and the checker's (record).

Tests (pure, `lib/domain/expression/__tests__/typeChecker.test.ts`): in each rule set, `time <
time`, `time >= literal`, `between` anchored on a time, refused; `time = time` and `date < date`
accepted. In the form rule set: `#form/t < '10:00'` refused, `#form/n < '10'` accepted, `#form/n <
'a:b'` refused under `number-value`, a Hidden Value whose `default_value` is a time refused (the
neighbour `#form/h < 5` with `h` an integer accepted). Through `runValidation`
(`lib/commcare/validator/__tests__/formLogicFindings.test.ts`): one ordering on a time in a field
slot, a form-link condition and a Connect slot, each refused under `XPATH_TIME_ORDERING` at its
carrier. `lib/commcare/validator/__tests__/timeOrdering.test.ts` is deleted with its module; its
cases move to these two files, each keeping its accepted neighbour.

### 3.2 A date against a date and time

**Today.** Record slots refuse it (`typesCompatible` has no `date`↔`datetime` arm; executed during
step 2's planning on `date_opened`). Form logic admits it: no reader types a reference.

**Evidence.** A comparison or ordering applies `FunctionUtils.toNumeric` to both sides
(`org/javarosa/xpath/expr/XPathCmpExpr.java::evalRaw`; `FunctionUtils.java::toNumeric`, which
unpacks first), which turns a `Date` into whole days and a date-and-time held as text into NaN.
Neither orders instants, which is finding 56; its requirement 4 is that "a date against a datetime
is refused by the type checker, so a date operand meets a datetime only through an explicit
coercion" (`docs/plans/hq-round-trip/3-expressions.md`, "Carried from step 2").

**From step 3, both rule sets:**

- `date` against `datetime` under `=`, `!=`, `<`, `<=`, `>`, `>=` or `between`, with neither side
  a `date-coerce` (form XPath `date(…)`) or `datetime-coerce` (record only), is
  `incompatible-values`, `details.reason: "date-datetime"`.
- In the form rule set, a `datetime` ordered against an operand known not to be a `datetime` (a
  number, text, a select, a `boolean`) is `incompatible-values`, `details.reason: "datetime-ordering"`.
  An operand of unknown type has no opinion and is admitted (part 01 §3.4 rule 2). The record rule
  set already refuses these (`typesCompatible`). This widens finding 56's requirement 4 (see
  "Departures"): the lowering is defined for an instant against an instant, and a bare
  `now() > 20000` orders days, the defect itself.
- Two `datetime` operands are admitted, under an ordering, `between`, `=`, `!=`, `in` and `switch`
  alike; the lowering part lowers each of them, form logic included (part 04 §3.3).

**Implementation correction, 2026-10-19:** the exemption is a `date()` on the date-and-time side, which makes both sides dates (in a record slot a `datetime-coerce` on the date side likewise makes both dates and times). A `date()` on the date side leaves the pair a date against a date and time, and it is refused: `date(#form/dt) < now()` is refused, `date(#form/dt) < date(now())` is admitted (`typeChecker.ts::dateDatetimeReason` reads the two operand types alone).

Code: `XPATH_INCOMPATIBLE_VALUES` (form logic), the slot's `*_TYPE_ERROR` (record). Validator
message, `date-datetime`: `"<field>" compares a date with a date and time in its <slot>. CommCare
compares a date by its day and a date and time by its moment, so the two don't line up. You can wrap
the date and time in date() to compare days.` `datetime-ordering`: `"<field>" orders a date and time
against <a number | text | …> in its <slot>. CommCare can only order two dates and times by their
moment. You can compare it with another date and time, or wrap it in date() to compare days.`
Builder line: `A formula on "X" in "F" compares a date with a date and time. You can wrap the date
and time in date() to compare days.` (and `… orders a date and time against something that isn't
one. You can compare it with another date and time, or wrap it in date() to compare days.`)

The copy's "wrap … in date()" stands: it is exact for a typed answer, whose `date()` is the device's
day, while for date-and-time text Core's `date()` keeps the written day and throws on text that is
no date (`org/javarosa/xpath/expr/XPathDateFunc.java::evalBody` → `FunctionUtils.java::toDate`,
which parses with `DateUtils.parseDateTime` and throws `XPathTypeMismatchException`); the public
docs line part 04 §7 writes says which day each gives.

**A system date on a device** (part 04 §3.4 holds the bytes). Core builds `date_opened` and
`last_modified` in `casedb` as `DateData`
(`org/commcare/cases/instance/CaseChildElement.java::buildAndCacheInternalTree`: both set with
`new DateData(…)`), which unpacks to a `Date` rounded to the device's day, so no instant exists on
the device, while HQ's search and Postgres hold the instant. From step 3, in a slot whose profile
targets include `XF` or `SU`, a `prop` or `form-case` read of `date_opened` or `last_modified` whose
row root is `casedb` (§1.3; a `form-case` read is one) is `incompatible-values`, reason
`day-only-on-device`, when it is:

- ordered (an ordering or `between`) against a `datetime` operand that is not day-aligned, where
  day-aligned means a `datetime-coerce` of a `date` (record) or the other system date (in form
  logic, `date(…)` on either side makes the comparison one between dates, which this rule does not
  reach); or
- compared by `=` or `!=` (or `in`, `switch`) against any `datetime` operand, day-aligned included,
  since a day is never equal to a moment.

Today's record checker admits both. Admitted from step 3: an ordering against a day-aligned operand
(a comparison by day, part 04 §3.4, step 2's witness `targeted-search-hq-compile`,
`date_opened >= datetime-coerce('2026-01-01')`), two system dates against each other, and a
`last_modified` read from a `results` or `results:inline` row, where the value is HQ's instant text
and the lowering orders it as an instant. A comparison of a system date with a `date` operand is
already `date-datetime` above.

**`date_opened` in a search results row.** In a `results` or `results:inline` row HQ writes
`date_opened` as the UTC day alone, `YYYY-MM-DD`
(`corehq/ex-submodules/casexml/apps/case/xml/generator.py::CaseDBXMLGenerator` inherits
`V2CaseXMLGenerator.add_custom_properties`, which appends `date_to_xml_string(self.case.opened_on)`,
and `::date_to_xml_string` returns `corehq/ex-submodules/dimagi/utils/parsing.py::json_format_date`,
`strftime('%Y-%m-%d')`; part 04 §3.4), so a lowered comparison with a moment reads NaN and is always
false, while a bare one compares days, because Core's `toNumeric` turns date-only text into its day
count (`org/javarosa/xpath/expr/FunctionUtils.java::toNumeric`, `attemptDateConversion`). From
step 3 the same rule holds for it: a `prop date_opened` whose row root is `results` or
`results:inline` is `incompatible-values`, reason `day-only-on-device`, when ordered against a
`datetime` operand that is not day-aligned, or compared by `=` / `!=` (or `in`, `switch`) against any
`datetime`; against a day-aligned operand it stays admitted and emits bare (part 04 §3.4). The rule
reads `RowScope.root` (§1.3). `last_modified` in a results row is a full instant and is unaffected.
The validator message and builder line are the casedb ones below, "when the case was opened". No
stored document can hold such a read today (production holds no `results*` read), so this is a rule
for new authoring only.

The casedb half of the day rule lands in pull request 8, the lowering, with finding 56's lowering;
the results-row half lands in pull request 9, instances and session, where results rows first exist
(§10). Validator message (part 04 §3.4's copy): `"<slot>" compares when the case was opened with a
moment. On a device CommCare keeps only the day a case was opened, so it can't tell. You can compare
it with a date instead.` ("last changed" for `last_modified`); for `=` / `!=`: `"<slot>" checks
whether the case was opened at an exact moment. On a device CommCare keeps only the day a case was
opened, so the two never match. You can compare it with a date, or check a range of days.` Builder
line (both): `"X" compares when the case was opened with a moment, and a device keeps only the day.
You can compare it with a date instead.`

**Production** (both scans, executed during planning). Form logic: every date-and-time ordering
production holds is a date and time against a date and time (`now()` against a relatively read
date-and-time question), admitted and lowered; none is a date against a date and
time, a date and time against a known non-date-and-time or against an unknown operand, and none
orders `date_opened` / `last_modified`. Record slots: production holds orderings, none
date-and-time-typed, no `=` / `!=` between a date and a date and time, and no read of a system date.
Not counted by either scan, and so the dry run's (§5.4): form-logic `=` / `!=` between a date and a
date and time, and the raw `casedb` reads of a system date production holds, which sit outside every
ordering and may meet `date-datetime` or `day-only-on-device` under an equality.

Corpus (the corpus shape scan, executed during planning): no mixed date against date and time in
either family; the two date-and-time orderings in form logic are both the witness
`targeted-datetime-ordering`, date and time against date and time, admitted; no date and time
against a known non-date-and-time; the one system-date ordering is `targeted-search-hq-compile`,
against a day-aligned operand, admitted.

Tests (pure): `#form/d = now()` refused, `date(now()) = #form/d` accepted; `#form/dt < 5` refused,
`#form/dt < now()` accepted; `#form/d < '2026-01-01'` accepted (the literal is a date);
`#form/dt < '2026-01-01'` refused (`date-datetime`). Record: today's `date_opened` cases kept, with
`datetime(<date>)` accepted (step 2's witness shape). `day-only-on-device`: a case list filter
`date_opened >= now()` refused, `date_opened >= datetime-coerce('2026-01-01')` accepted;
`date_opened = datetime-coerce('2026-01-01')` refused; in form logic `#case/last_modified > now()`
refused beside `#case/last_modified > #case/date_opened` accepted; the same filter in a search-only
slot (no `SU`, no `XF`) accepted. Results rows (with pull request 9): a results-row `date_opened`
against `now()` refused and under `=` against `datetime-coerce('2026-01-01')` refused, against
`datetime-coerce('2026-01-01')` under `>=` accepted, and a results-row `last_modified > now()`
accepted.

**Implementation correction, 2026-10-19: the instant refusals, as built.** The day rule cannot be
read from `NodeType`: a casedb `date_opened` and a date-and-time question are both `datetime` held
`date`. The checker and the on-device emitter therefore share one structural classifier,
`lib/domain/expression/instantOperand.ts` (part 04 §3.2's correction), which recurses into `if`,
`coalesce` and `switch` branches, so `if(c, #case/date_opened, now()) < now()` is caught; a
day-only leaf is a `prop`, `form-case` or `project` read of `date_opened` or `last_modified` held
`date`. `typeChecker.ts::checkInstantComparison` runs in `checkFormComparison` (through
`comparisonOperands`, so a date-and-time-shaped form literal counts as one), `checkComparison`,
`checkIn` (each member), `checkBetween` (each bound) and the record `switch` (each case against
its subject). It refuses only where three things hold: `comparisonPlan` is `lowered` (so an
ordering against a day-aligned operand, two system dates under any operator, and an equality with
a side that is neither a moment nor of unknown type never reach it), the slot's targets include `XF` or `SU` (every slot's
comparisons that reach `toWire`; `search_input_predicate`, targets `CS` and `PG`, is the only slot
without them, and prints through CSQL), and the comparison holds no other error, so
`#form/missing < now()` keeps its one finding. It gives one finding per comparison, the most
specific leaf first:

| Leaf | Reason |
|---|---|
| a casedb system date | `day-only-on-device`, with the ordering or the equality copy |
| a value whose clock is lost | `clock-lost` (§5.1's correction) |
| a date | `date-datetime` |
| a literal no spelling reads (`literalInstantMicros`, the fold's grammar) | `unreadable-datetime` (new) |
| a branch of another known kind (`if(c, #form/n, now()) < now()`), or of unknown type holding neither text nor a typed date | `datetime-ordering`, or `datetime-equality` (new) under `=` / `!=` |

The other-kind row is stricter than the emitter, which would print such a branch as itself and read
NaN; it matches the direct operand's `datetime-ordering`, and record slots already refuse it through
`branch-values`. `CheckError` gains `instant?: { comparison: "ordering" | "equality", property?,
field? }`. Copy: the validator messages are this section's, worded "This compares when the case was
opened with a moment…" in the checker and with the slot's owner in `formLogicFindings.ts`, whose
details carry `comparison` and `systemDate`; `unreadable-datetime`: `<owner> compares a moment with a
date and time CommCare can't read<slot>. You can write it like 2026-01-02T10:30:00Z.`;
`datetime-equality`: `<owner> compares a date and time with a value that isn't one<slot>, so the two
never match. You can compare it with another date and time, or check whether it's blank.` The
builder lines (`checkErrorPresentation.ts`, whose presenter now receives the error, so it names
"opened" or "last changed"): `A device keeps only the day a case was opened. You can compare it with
a date instead` and, for an equality, `A device keeps only the day a case was opened, so it never
matches a moment. You can compare it with a date, or check a range of days`. Record slots'
`*_TYPE_ERROR` copy was generic; `userFacingErrors.ts::instantComparisonCopy` gives the day-only and
clock-lost sentences in twelve renderers (the display conditions, the calculated column, the filter,
the Search inputs' required, check, hidden and row rules, the excluded owners, the Search button,
`LOOKUP_SELECT_FILTER_TYPE_ERROR` and `CASE_SELECT_FILTER_INVALID`). A record finding carries the
checker's reason as `details.checkReason` beside `checkCode` (`lookupTypeContext.ts::checkErrorDetails`),
not as `details.reason`, so the copy reads `checkReason`, falls back to `reason`, and applies only when
`checkCode` is `incompatible-values`. Corpus: no new finding over the base or the head emission (732
documents validated, none refused); swapping `targeted-search-hq-compile`'s day-aligned operand for
`now()` gives `CASE_LIST_FILTER_TYPE_ERROR` with `checkReason: day-only-on-device`.

Closed in the same pull request (**implementation correction, 2026-10-19**):

- `lookupTypeContext.ts::checkErrorDetails(error, ctx?)` carries `error.instant` as
  `details.comparison`, `details.systemDate` and, resolved in the slot's form, `details.clockSource`,
  so record copy takes the equality or the ordering sentence and names "opened" or "last changed"
  (and the value whose clock is lost, in a form's choice filter).
- `rules/caseOperations.ts::validateExpressionSlot` gives `CASE_OPERATION_EXPRESSION_TYPE` the
  checker's `checkCode` and `checkReason` (a refused comparison of moments first) whenever the
  finding is not a write's lost clock, whose `reason: "clock-lost"` keeps its own sentence;
  `userFacingErrors.ts` gives the case operation the day-only and clock-lost sentences
  ("This case operation compares when a case was opened with a moment…").
- An unknown operand against a moment under `=` / `!=` (each `in` member, each `switch` case) takes
  the row of its held representation and the equality is lowered, as an ordering already is (part
  04 §3.2's cycle rule), so `#form/probe = now()` over an untyped Hidden Value compares moments; two
  unknown operands, and an unknown against a value that names no moment, stay bare. Lowered, such
  an equality meets the refusals an ordering does: `#case/date_opened = #form/probe` is
  `day-only-on-device`, and an unknown holding neither text nor a typed date is
  `datetime-equality`.
- `checkBetween`'s `range-order` orders two date-and-time literal bounds by their folded instants
  (`literalInstantMicros`), and leaves the order alone when either names no moment.
- `lib/commcare/xpath/wire/__tests__/instantAgreement.test.ts` holds the checker and `toWire` to
  one verdict over every leaf class, operator and slot kind (part 04 §6's correction).

**Implementation correction, 2026-10-19: five gaps between the checker and the print, closed.**
Review found five places where the checker admitted what `toWire` could not print as a moment, or
printed wrongly, each now closed at its root and held by `instantAgreement.test.ts`, which also
asserts that every literal an instant parse can read is printed as canonical text:

- **A. Extreme years.** `literalInstantMicros`, the one grammar, names no moment for a literal
  whose UTC moment falls outside 0000-01-01T00:00:00Z to the last microsecond of 9999, since a
  device's text has a four-digit year (`DateUtils.parseDateTime`): `9999-12-31T23:00:00-05:00` is
  `unreadable-datetime` everywhere it is compared or coerced, and `instantCanonicalText` never meets
  one.
- **B. Literal branches.** A form literal branch of an `if`, `coalesce` or `switch` is typed as a
  direct literal of its comparison (`typeChecker.ts::formLiteralsShaped`, which
  `formComparisonOperandTypes` and `comparisonOperands` share), so `#form/dt < if(c,
  '2026-01-02T10:00Z', now())` folds the branch to its canonical text, and a date-shaped branch
  (`date-datetime`), an unreadable one (`unreadable-datetime`), one finer than a millisecond
  (`datetime-literal-precision`) and a non-blank literal of another kind (`'nope'`:
  `datetime-ordering`, or `datetime-equality` under `=` / `!=`) are refused as a direct operand is;
  a blank literal names no moment and is admitted. `instantOperand.ts::unlowerableLeaves` holds the
  other-kind literal, so the emitter throws on one rather than printing it into the parse.
- **C. `datetime-coerce` as a value.** Wherever `toWire` prints the expression, a `datetime-coerce`
  of a literal that names no moment (`is-blank(datetime-coerce('2026-02-30'))`) is
  `unreadable-datetime`, at the coercion's `value`; before, only a comparison refused one.
- **D. A Search field's condition.** Its slot names `CS` and `PG` only, yet each value its server
  comparison does not work out itself is printed by `toWire({ target: "csql-runtime" })`. The walk
  that picks those values is now one, `lib/domain/expression/searchRuntimeValues.ts` (the
  emitter's `isNativeCsqlValueExpression` and `csqlRuntimeWalk.ts` read it), and
  `checkExpression` infers each such value again with `ExpressionContext.runsOnDevice`, adding the
  findings that adds, so `note = if(seen < datetime '2026-02-30T10:00:00', 'a', 'b')` is
  `unreadable-datetime` at `["right", "if", "cond"]` while the server's own `seen < …` stays
  admitted.
- **E. The day-only next step.** "You can compare it with a date instead" suggested a rewrite the
  checker refuses (`date-datetime`), and the equality's a refused day-aligned one. Every surface now
  assembles `typeChecker.ts::dayOnlyRefusalCopy` around its subject, with one next step the checker
  admits, "You can wrap both sides in date() to compare days."; `systemDateWhen` replaces the four
  copies of "opened" / "last changed", and every surface says "the case". `unreadable-datetime`
  reads "uses a date and time CommCare can't read", true of a comparison and of a coercion.

`checkFormComparison` takes its finding count before its operands are read, as `checkComparison`
does; each comparison's inference has its own accumulator, so no sibling's finding reached it
before either. Corpus: the head emission is byte-identical to the previous head (388 documents,
14,083 files, only `timings.json` differs), and the base corpus's 732 documents validate with no
finding.

Left open: the classifier reads the held class, not the row's root, and the standard-property
fallback in `typeChecker.ts` (no known case type) holds a system date as `date` whatever the root,
so a results-row `last_modified` would be read as day-only; pull request 9 fixes the fallback by
root with the results-row half of the rule.

### 3.3 A boolean against an answer

**Evidence.** `XPathEqExpr.evalRaw` unpacks both sides and calls `testEquality`, which compares as
booleans when either side is a `Boolean`, turning the other through `toBoolean`
(`FunctionUtils.toBoolean`: any non-empty string is true). So `#form/consent = true()` is true for
`'no'` as well as `'yes'`.

**From step 3.** `boolean` against a non-`boolean` under `=` or `!=` is `incompatible-values`,
`details.reason: "boolean"` (form rule 5, part 01 §3.4). `boolean` in arithmetic and as an argument
stays admitted (Core counts it 1 or 0, `toNumeric`).

Validator message: `"<field>" compares true() or false() with an answer in its <slot>. CommCare reads
any answer that isn't blank as true, so "no" would count as true too. You can compare the answer with
the choice's value instead, like #form/consent = 'yes'.` Builder line: `A formula on "X" in "F"
compares true or false with an answer, so any answer counts as true. You can compare it with the
choice's value instead.`

Corpus (executed during planning): no such comparison, and none between two booleans, in the 606
form-logic slots of the 371 documents. Production: no comparison of a boolean with a non-boolean and
none between two booleans, so the cutover meets none.

Tests (pure): `#form/consent = true()` refused, `#form/consent = 'yes'` and `(#form/a > 1) =
true()` accepted, `true() + 1` accepted.

### 3.4 Several values where one is needed

**Evidence.** `XPathNodeset.unpack` throws "XPath nodeset has more than one node … cannot convert
multiple nodes to a raw value" for more than one node. Every scalar use unpacks first:
`XPathEqExpr.evalRaw` (`FunctionUtils.unpack`), `XPathCmpExpr.evalRaw`, `XPathArithExpr.evalRaw`
and `XPathBoolExpr.evalRaw` through `toNumeric` / `toBoolean`, `FunctionUtils.toString` and
`::toDate`; a slot's result through `XPathConditional.evalRaw` (`FunctionUtils.unpack`) and a
setvalue through `SetValueAction.processAction` (`FunctionUtils.unpack`, line 129); a label output
through `XPathConditional.evalReadable` (`FormDef.fillTemplateString`). Only these arguments read
a node-set: `XPathCountFunc` (its argument), `XPathSumFunc`, `XPathPositionFunc`,
`XPathDistinctValuesFunc` (through `FunctionUtils.getSequence`), `XPathMinFunc`, `XPathMaxFunc`
and `XPathConcatFunc` with one argument, `XPathJoinFunc`'s second of two, `XPathJoinChunkFunc`'s
and `XPathChecklistFunc`'s third of three, and `XPathWeightedChecklistFunc`'s third and fourth of
four (each an `instanceof XPathNodeset` test).

**From step 3.** `many-values` is refused only where several nodes are **structural**: a `field` or
`repeat-row` read whose path crosses a repeat its slot's context node is not inside (part 01 §3.2,
"field, cardinality"), and so has one value for every iteration whatever the data, used as one
value. The checker marks such a node-set `structural` when it types the leaf, and rule 4 (both rule
sets) reads only that mark. Exempt even then: the node-set arguments above, a step predicate's own
content, an `if` branch (whose caller decides), the `count` arm's `via`, a slot whose profile expects
a node-set (`ids_query`, part 01 §4), and a `value-list` item, which the list flattens (part 06
§3.6). `FUNCTION_REGISTRY` (`lib/domain/expressionFunctions.ts`) gains
`manyArguments(argumentCount): ReadonlySet<number>` per function, the table above, each entry citing
its Core class. Prose parts are covered too: a label that shows `#form/visits/date` from outside
`visits` is refused.

**Implementation correction, 2026-10-19.** Crossing is decided by the context node
(`typeChecker.ts::structuralSeveral`): the repeats on the leaf's path that the context node's path
does not hold, the context being the slot's source node for `current()` and its lexical context node
otherwise. Inside a step predicate the step is the context, which is what the "step predicate's own
content" exemption above amounts to; it is no blanket exemption, since Core's `XPathEqExpr.evalRaw`
unpacks inside a predicate too. A case operation with `forEach` evaluates in its repeat's iteration
(`context.ts::slotContext`), and a slot with no context node (a form link's slots, an operation
without `forEach`) crosses every repeat. Any filter on the crossed step makes the read not
structural: a positional `[1]` gives one, another filter leaves the count to the data. `form-node`
leaves count as `field` and `repeat-row` do. The node-set arguments add `index-of`'s first of two
(`XPathIndexOfFunc.java::evalBody`, through `FunctionUtils.getSequence`) and `depend`'s second and
later (`XPathDependFunc.java::evalBody` never reads them); `weighted-checklist`'s third and fourth
are admitted only jointly (`manyArgumentsJointly`: with one node-set Core unpacks both). The
pass-through positions carry the mark to their caller rather than exempting it: `if` and `switch`
branches, `coalesce`'s last argument, `depend`'s first, `sleep`'s second and `cond`'s branches
(`FunctionSpec.passThrough`). The old `structural` mark on groups, sections, the form root and
Connect blocks is renamed `container`, so `structural` means only several by shape.

**`selected-cases`** (part 05 §2.5). A several-case form's `instance('<datum id>')/results/value`
holds every case the worker chose in the module, and the module selects several cases by
declaration, as a repeat holds several rows: its shape decides that there are several, not its
data. So a `selected-cases` node used as one value is `many-values` too, marked structural when the
checker types the leaf, with the same exemptions (the node-set arguments above, a step predicate, an
`if` branch, a node-set slot). Core reads one chosen case without failing, but the form is declared
to run over several, so a read that works only when one is chosen is a defect of the form, not of
the data.

Admitted in a scalar position: a `cases` query (either source), `table-rows`, `locations`, and a
`project` over any of them. Only their data decides how many rows match (an author filtering by a
unique property gets one); Core throws at run time on more than one, as it does today, and `[1]`
remains the author's way to take the first. So a lookup read without `[1]`
(`instance('t')/t_list/t[code = x]/name`) is admitted. A search-results read keeps part 05's order
rule (`search-results-order`, §3.8), which refuses the positional step, `position()` and `join` /
`distinct-values` there, because HQ's order is its relevance score.

Validator message: `"<field>"'s <slot> reads <#form/visits/date>, which has one value for every
entry of the repeat "visits", in a place that needs one value. CommCare stops the form when there's
more than one. You can count the entries, join them, or read one entry, like #form/visits[1]/date.`
Builder line: `A formula on "X" in "F" reads an answer from every entry of a repeat where it needs
one value. You can count or join the entries, or read just one of them.` For `selected-cases`
(`details.reason: "selected-cases"`): validator message `"<field>"'s <slot> reads the cases chosen in
"<module>" in a place that needs one value. This form works on several cases at once, so CommCare
stops the form when more than one is chosen. You can count them with
count(instance('<id>')/results/value), or join them.`; builder line `A formula on "X" in "F" reads
every case chosen in "<module>" where it needs one value. You can count or join them.`


**Implementation correction, 2026-10-19: a form read inside a row predicate.** Inside a `cases`,
`table-rows`, `locations` or `table-lookup` predicate, a form read other than `current()` is
checked against the slot's own context node. Core evaluates such a predicate one of two ways. Where
its predicate index answers the comparison (`org/commcare/cases/util/StorageBackedTreeRoot.java::collectNativePredicateProfiles`,
`org/javarosa/core/model/instance/utils/TreeUtilities.java::tryBatchChildFetch`, for example an
`@case_id` comparison), the right-hand side is evaluated in the outer, form context, so a read of
the current entry of the slot's repeat names one node, as the checker says. Where Core evaluates
the predicate row by row (`EvaluationContext.java::expandReferenceAccumulator`), the context is the
row on another instance, `TreeReference.java::contextualize` copies no repeat position, and the read
names every entry. Refusing every such read would refuse the indexed spelling Core runs; refusing
only the row-by-row ones would tie the gate to Core's index choice. The checker keeps the first
reading, and choosing between Core's two evaluations by construction is held for step 4, which owns
platform evaluation differences. `current()/…` names the entry in both.

Moves. Moving a field into a repeat, or a reader out of one, can make a stored read structural; the
gate refuses the move naming the read (part 01 §5, "Move"), and the builder's move verdicts
(`lib/doc/navigation.ts`, `formSectionVerdicts.ts::fieldPlacementVerdict`) ask the same checker
before offering the move (part 02).
**Implementation correction, 2026-10-19:** `lib/doc/navigation.ts` holds no verdict. The move
verdict is `fieldPlacementVerdict`, which the drag gate (`landingGuards.ts`) and the SA's
`add_fields` and `move_field` ask; a keyboard or inspector move builds its batch directly and the
gate refuses it. The preflight reads the candidate document's expressions, checks prose references
too (`expressionSource.ts::prosePartTerm`, shared with the gate, and `proseReadSlotRef`), refuses a
slot that loses its context, keys its before/after diff on code, reason and path, and refuses a
structural many with reason `expression-many-values`.

Corpus (executed during planning): 22 reads of a repeat answer from outside its repeat in 6
documents, every one in an admitted position (count 10, join 6, inside a step predicate 6); none in a
scalar position, in a prose part or as a slot result.

Production (executed during planning). Structural reads of a repeat answer from outside the repeat
sit in admitted positions (`count`, `join`, `max`, `sum`, and absolute reads under `count`), except
**a few used as one value, in very few apps** (`concat` in a `calculate`, `selected` in a
`relevant`). The cutover lifts each of those to its first row, a `FieldStepFilter` `[1]` on the
repeat's step, the only value Core reads without failing, and the notice names each (reason
`repeat-read-takes-first-row`). Node-sets whose count only data decides, now admitted: production
holds `casedb` queries that may return several nodes used as one value (mostly as a slot result),
and every other several-node read sits in `count`, `sum`, `join`, `max` or an `ids_query` result.
`selected-cases` reads: none (production's `instance()` calls are case-database queries and session
reads only), so the refusal meets no stored app; no stored form logic can hold one today, since only
`casedb` and `commcaresession` commit as instance ids
(`lib/commcare/xpath/carriers.ts::xpathCarrierAllowedInstanceIds`, part 02 §1.3), so neither can the
corpus. Not counted by the scans: prose parts, which the dry run counts (§5.4).

**Untyped queries** (part 02's parse, recorded here because the checker reads its result). A custom
property read in a `cases` query with no `@case_type` literal and no `@case_id` from a known source
binds, at parse, to the one case type of the effective catalog that declares it; where none or
several do, the parser refuses it (`case-query-untyped`: "You can add `[@case_type = '<type>']` so CommCare
knows which records to read."), because no case type gives the read a type or a rename. `@case_id`,
`@case_type`, `@status`, `@owner_id`, `index/<x>` and the standard properties stay readable in an
untyped query. The bound type is stored in `prop.caseType` and the printer prints no predicate, so
the checker types the row like any other and a later second declaration changes nothing stored; a
re-parse of an edited slot takes the slot's current tree as its binding hint (`FormParseScope`, part
02 §1.3), so the bound read keeps its type while that type declares the property; removing the
property from that type is the ordinary `unknown-property` (`INVALID_CASE_REF`, §1.5). Production
holds untyped queries that read a row value, in a few apps (with a case id from a Hidden Value, from
`selected-at`, from a nested `casedb` read or from a relative path). Part 09 §11 splits them into
standard reads, reads that bind to one type, reads that several types declare, and reads typed by
`@case_id` from a known source, which become declarations; the dry run reports each that binds to no
type or to several, a blocker the author resolves before the window (§5.4).

Tests (pure): `#form/rep/q = 'yes'` outside `rep` refused; the same inside `rep` accepted;
`count(#form/rep/q)`, `join(' ', #form/rep/q)`, `sum(#form/rep/q)`, `concat(#form/rep/q)` accepted;
`concat(#form/rep/q, 'x')` refused; `#form/rep[1]/q = 'yes'` accepted; a label part `#form/rep/q`
outside `rep` refused; `ids_query` reading `instance('casedb')/casedb/case[…]/@case_id` accepted;
`instance('casedb')/casedb/case[@case_type = 'visit']/name = 'x'` and
`instance('t')/t_list/t[code = #form/c]/name` as a `calculate` accepted (data decides);
`instance('selected_cases')/results/value = 'x'` refused beside
`count(instance('selected_cases')/results/value)` and `join(' ', instance('selected_cases')/results/value)`
accepted. Through `runValidation`: a move batch that puts a reader's target into a repeat refused at
the reader.

### 3.5 A literal default that is none of its choices (finding 72)

**Evidence.** `Selection.attachChoice(QuestionDef)` returns at once when
`q.getDynamicChoices() != null`, and otherwise throws `XPathTypeMismatchException("value … could
not be loaded into question …")` when neither the index nor `QuestionDef.getChoiceForValue` (exact
`String.equals`) finds a choice. Its readers: formplayer `api/json/PromptToJson.java::parseQuestionAnswer`
for every single and multiple answer (lines 186 and 196), `FormEntryPrompt::getSelectItemText` and
`::getSpecialFormSelectItemText` when the selection has no index, and
`FormDef.attachControlsToInstanceData`. A single default's text is one selection
(`SelectOneData.cast`); a multiple's is split on spaces into one selection each
(`SelectMultiData.cast`, `DataUtil.splitOnSpaces`). A blank result is no answer at all
(`Recalculate.wrapData` returns null for `""`). A number reaches a select as the answer text
chosen by `Recalculate.wrapData`, then `SetValueAction`'s cast: a value within `1e-9` of its
truncated, saturating Java `long` becomes `IntegerData` or `LongData`; other numbers become
`DecimalData` and use OpenJDK 17's `Double.toString` spelling. This is not JavaScript's
`String(number)`: `0.0001` becomes `1.0E-4`, and `1.0000000005` becomes `1`.
`numericAnswerText` shares that conversion between admission and finding details.

**From step 3** (part 01 §4, "Defaults"). In the `default_value` of a single or multiple select whose
`optionsSource` is `inline`, a whole-slot string literal, or a number literal, whose text is not one
option value (single) or whose space-separated tokens are not all option values (multiple) is
`default-not-a-choice`. A matching string literal is a `choice` leaf, which later option edits reprint and
whose option cannot be removed while it is read (part 01 §5, part 02 §4.6). Admitted: `''` (no
starting value, since `Recalculate.wrapData` turns `''` into no value and `attachChoice` never runs),
any computed default, and any default on a lookup- or case-backed select. Code:
`SELECT_DEFAULT_NOT_AN_OPTION`, soundness, field-located (`location.field: "default_value"`,
`details.value`, `details.options`).

Validator message: `"<field>" starts on "<value>", which isn't one of its choices (<a, b, c>).
CommCare's Web Apps can't open a form whose choice question starts on a value it doesn't offer. You
can start it on one of its choices, like '<a>', or leave the starting value empty.` Builder line:
`"X" starts on a value that isn't one of its choices. You can pick one of its choices as its starting
value, or clear it.`

Builder, SA and MCP. The default's editor offers the question's choices; text typed there parses to a
`choice` or is held by the linter. A refused edit through the SA or MCP reads the message above.

Corpus (executed during planning): 40 literal select defaults in 19 fuzz documents, every one the
drawn `'a'` (part 08 §3.3), of which 20 in 12 documents are none of their options (11 single in 6
documents, 9 multiple in 9); none in the fixed corpus; no computed select default. §7 maps the
generator.

Production (executed during planning): **no** literal select default outside its options. The
literal defaults production holds (single selects, in a few apps) all name an option and lift to
`choice` leaves with the cutover's `choice` lift, which turns every literal opposite a static select
into an option identity, in form logic and record slots alike; a literal matching no option stays a
literal with no finding (part 01 §4). The computed defaults (on inline single selects, a
lookup-backed select, and case-backed multiple selects) are admitted. The cutover meets no finding
72 refusal.

Tests (in `lib/commcare/validator/__tests__/selectDefault.test.ts` through `runValidation`, since the
refusal is located at the field): single `'z'` refused beside `'a'` accepted; multiple `'a z'`
refused beside `'a b'` accepted; `''` accepted; `1` against an option `1` accepted and against none
refused; `#form/other` accepted; a lookup-backed select's `'z'` accepted.

### 3.6 `here()` outside a row

**Evidence.** `here()` has a handler only where a menu, list or detail adds one: Formplayer's
`session/MenuSession.java::getEvalContextWithHereFuncHandler` and
`services/MenuSessionRunnerService.java::addHereFuncHandler` (an `EntityScreen`'s context), and
Android's `tasks/EntityLoaderHelper.kt`, `fragments/EntityDetailFragment.java` and
`gis/EntityMapUtils.kt` (`EntitySelectActivity.getHereFunctionHandler`). No form context adds one.

**From step 3.** The `here` arm is admitted only by the calculated-column profile (part 01 §4); in
every other slot it is `arm-unavailable`, projected to `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, reason
`here`, in form logic and to the slot's type code in a record slot. Today form logic refuses it as
`XPATH_FUNCTION_UNAVAILABLE` (`compatibility.ts`, `context-handler`), so the verdict holds and only
its code and copy move. Preview supplies `here()` in a calculated column from the browser's location
(part 07 §3.4). Production holds no `here()` read.

It lands in pull request 6, the checker: the `here` arm's admission (the calculated-column profile
admits it, every other profile refuses it as above), its projection and §2.4's copy. Until then the
stack keeps today's verdict: no profile admits the arm, so a record `here()` is `arm-unavailable`
under the slot's type code, and the form parser of pull request 5 reads `here()` as no function of
form logic, the parse issue `unknown-function` that today's `XPATH_FUNCTION_UNAVAILABLE` trigger
maps onto (§2.3); pull request 6 parses it into the arm and refuses it in admission.

**Implementation correction, 2026-10-19.** On Web Apps a case list's rows and sorts are evaluated
with Core's placeholder handler in `EntityScreen`, and the detail with the browser's location, as
the surface entry's platform cell says; `addHereFuncHandler` is not the rows' handler. Pull request 6
also gives the record dialect `here()`, parse and print (`lib/agent/authoring/queryExpressions.ts`,
`printQueryExpression.ts`, `here: [0, 0]` in `QUERY_FUNCTIONS`), because the calculated-column
profile admits the arm and every stored arm must print; it does not bump `MODEL_CONTEXT_VERSION`,
because the stack deploys once at pull request 12's value (part 02 §3.3). The surface entry
`expressions-and-data/here-in-a-case-list-calculated-column-or-sort` and its inventory row flip to
`HELD` in pull request 6. The builder's `here` card and focus title read "Worker's location".

Tests (pure): `here()` in a calculated column accepted; in a field `calculate` and in a module
display condition refused.

### 3.7 `jr:choice-name` and `jr:itext`

**`jr:choice-name` on a question whose choices are not written. Evidence.** The handler
`FormDef.initEvalContext` installs reads `q.getChoices()`, which is null for an itemset question
(`QuestionDef::getChoices` returns the static vector; only `addSelectChoice` fills it), so the loop
throws inside the handler's `try` and surfaces as "error in evaluation of xpath function
[choice-name]"; on a field that is no select it returns `''`.

**From step 3.** `choice-name.field` must name a select whose `optionsSource` is `inline`; otherwise
`arm-unavailable` → `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, reason `choice-name-dynamic`. A field that
is no select at all cannot be named (the parser binds `jr:choice-name`'s path to a select or refuses
it, part 02). Changing a select's choices to a lookup or case source while a `choice-name` reads it
is refused at the source change, naming the read.

**Text that shows an answer** (part 07 §3.3). An itext value holding an `<output>` is stored as
`${n}`, `n` the output's index in the form's fragment table
(`org/javarosa/xform/parse/XFormParser.java::recurseForOutput`: `"${" + parseOutput(kid) + "}"`;
`::parseOutput`), so `jr:itext` of such a text, and `jr:choice-name` of an option whose label holds
one, return the placeholder, never the value. From step 3 an `itext` read of a unit, or a
`choice-name` read whose field has an option label, that holds a reference in any of the form's
languages is `itext-reference` → `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, reason `itext-reference`.
`FormExpressionFacts.translationUnits` carries `showsAnswer` per unit, computed from the prose parts
of every language's text (`lib/domain/translationUnits.ts::collectTranslationUnits`). A batch that
adds a reference to such text while a read names it is refused at the read, which the reference index
reaches through the unit's owner (part 01 §5). Validator message (part 07 §3.3's copy):
`"<question>" reads the wording of "<owner>", which includes an answer. CommCare would show a
placeholder there instead of the answer. You can read the answer itself instead.` Preview then never
needs Core's `${n}` (part 07 §3.3).

Production holds no `jr:itext` and no `jr:choice-name` read; the corpus none either.

**Implementation correction, 2026-10-19:** accepting an inline `choice-name` is pull request 9's,
where profiles admit the read. Until then the arm stays refused over an inline select, reason
`choice-name`, and pull request 6 tests the `choice-name-dynamic` refusal with a case-backed select
beside it; the inline acceptance below joins in pull request 9.

Tests (pure): `choice-name` over an inline select accepted; over a lookup-backed and a case-backed
select refused; `itext` of a unit whose text is plain accepted beside the same unit with a
`#form/name` part in its French text refused; `choice-name` of a select whose option label shows an
answer refused.

### 3.8 Search answers and search results

**Today.** `index.ts::searchAnswerRefError` admits `#search/<name>` only in a no-matches form
(`INVALID_SEARCH_REF`); no form logic reads `results`.

**From step 3** (part 05 §2.8 plans the read in full).

- **`input`** (`#search/…`) is admitted in a no-matches form only, as today. Text naming no Search
  input of the module is part 02's parse refusal `unknown-search-input`; a resolved `input` outside
  a no-matches form, typed there or stranded by a later batch (the form moved out of the no-matches
  role), is `search-answer-unavailable` → `INVALID_SEARCH_REF` (part 02 §1.4 lists it among the
  checker's), and a removed prompt is a dangling identity. A read in an inline-search module's
  ordinary forms is held by step 4, because it throws on Android (part 01 §1.6).
- **`cases { source: "search-results" }`** is admitted in every field form-logic slot and Connect
  slot of a form whose evaluating entry carries the inline query, and in a form link's `condition` and
  `datums[].xpath` when the link's source entry carries it (they evaluate in the source session); the
  checker asks whether `ctx.supplies.searchResults` names the module
  (`lib/domain/entryDatumSupplies.ts::entryDatumSupplies`, §1.3; part 05 §1.3). Elsewhere it is
  `search-results-not-supplied` → `SEARCH_RESULTS_NOT_SUPPLIED`, with part 05's `details` and its three
  reasons and sentences (`not-search-first`, `no-matches-form`, `link-source`, part 05 §2.8). The
  no-matches form is refused because its entry has no query and every read would be empty.
- **Row type**: the module's searched case type (part 05 §2.8); a `@case_type` predicate naming
  another type is `search-results-other-type` ("This search only finds <type> cases, so no result is
  a <other> case."). A read whose answer depends on HQ's order (a positional step, `position()`
  inside the query, `join` or `distinct-values` over its node-set) is `search-results-order` (part
  05 §2.8, its copy there). Both share one new validation code, `SEARCH_RESULTS_READ_INVALID`, with
  `details.reason` `other-type` or `order`, while supply keeps `SEARCH_RESULTS_NOT_SUPPLIED`; the
  `userFacingErrors.ts` sentences are part 05's copy. `count`, `sum`, `min`, `max`, a `@case_id`
  predicate and a node-set used as a condition are order-free and admitted, and a results read used
  as one value is admitted like any `cases` query (§3.4).
- **`date_opened` in a results row** is the UTC day HQ writes, so the day rule applies to it (§3.2,
  §3.10). `last_modified` there is an instant and lowers normally.

All three rules run in the checker's admission and typing; no `rules/case-search/searchResultsRead.ts`
rule file is added. The checker admits `search-results` in the pull request that emits its
declaration (`results:inline`, part 05 §2.8): pull request 9, instances and session (§10), not
before, and the row-type and order rules land with it: the checker codes `search-results-order` and
`search-results-other-type`, their card-editor lines, `SEARCH_RESULTS_READ_INVALID` with its
`gate.ts` row and its `userFacingErrors.ts` sentences, and the cases below, all in
`formLogicFindings.test.ts` (no `searchResultsRead.test.ts` is added). Production holds no `#search/` read and no results read in form logic (its `instance()`
calls are case-database queries and session reads), so the cutover meets neither rule.

Tests (pure): `#search/name` in a no-matches form accepted, in an ordinary follow-up of a remote-search
module refused, and in a form of an inline-search module refused; a removed prompt refused as
dangling. The search-results cases are part 05's, through `runValidation` in
`lib/commcare/validator/__tests__/formLogicFindings.test.ts`, since no rule file of their own
exists: a count read accepted in a search-first module's follow-up and its link condition;
`SEARCH_RESULTS_NOT_SUPPLIED` with each reason; `SEARCH_RESULTS_READ_INVALID` for `[1]` over results
and for another `@case_type`, beside `count` and a `@case_id` predicate accepted; a results-query
predicate `[date_opened >= now()]` refused (`day-only-on-device`) beside
`[date(date_opened) >= today()]` and `[last_modified > now()]` accepted.

### 3.9 Session datums

**Today.** `rules/sessionData.ts::sessionDatumNotSupplied` prints each XPath slot and reads each exact
`session/data/<id>` through `bindingResolutionOracle.ts::sessionDataAccessInXPath`, against
`entrySessionDatums`.

**From step 3** (part 05 §1.6). A read is a `session-datum { datum: DatumRef }` leaf with one of five
kinds (`selected-case`, `new-case`, `new-child-case`, `worker-record`, `tile-group-parents`; part 01
§1.3, part 05 §1.2), or a `selected-cases` node. Text naming an id no ref resolves to, a placeholder
datum or a multi-select datum's value is refused at parse (part 02's `unknown-datum`,
`placeholder-datum`, `multi-select-datum-value`, with part 05 §1.6's sentences). A stored ref the
entry stops supplying is the checker's: admission asks whether `ctx.supplies.refs` lists the
ref (`lib/domain/entryDatumSupplies.ts::entryDatumSupplies`, §1.3): the owning form's entry and, for
a form link's `condition` and `datums[].xpath`, the source entry after the form closes; a link's
`datums[].name` is checked against `ctx.targetSupplies`.
`rules/sessionData.ts` is deleted. `datum-not-supplied` → `SESSION_DATUM_NOT_SUPPLIED`, with part 05
§1.6's `details` (`{ ref, slot, carrier, reason }`). A batch that removes or moves the module or form
that supplies a read datum, turns off parent selection or tile grouping, or switches to several-case
selection is refused here (part 01 §5, part 05 §1.7).

The copy is part 05 §1.6's, one sentence per kind, which `lib/doc/userFacingErrors.ts` picks by
`details.reason` and `details.carrier`:

| `details.reason` | Sentence (part 05 §1.6) |
|---|---|
| `selected-case` | "`<question>` reads the case chosen in <module>, but `<form>` no longer opens with that choice, so CommCare can't open the form. You can choose the case before this form, or read a question or a case property instead." |
| `new-case` | "`<question>` reads the id of the case `<form>` registers, but the form no longer registers one. You can read a question or a case property instead." |
| `new-child-case` | "`<question>` reads the id of the new <type> case `<form>` creates, but the form no longer creates one outside a repeat. You can read a question instead." |
| `new-child-case`, several-case form | "`<question>` reads the id of a new <type> case, but in a form that works on several cases each chosen case gets its own, so this value names none of them. You can read a question instead." |
| `worker-record` | "`<question>` reads the id of the worker's own record, but `<form>` no longer saves to it. You can read `#user/` values instead." |
| `tile-group-parents` | "`<question>` reads the grouped cases' connections, but <module>'s case list no longer groups its tiles. You can group the tiles again, or read a case property instead." |

The link and Connect variants keep step 2's carrier wording ("A link from …", "A CommCare Connect
setting of …"). The validator `message` (the agent-facing voice) uses the same sentence per kind. A
`selected-cases` read the entry stops supplying (a switch away from several-case selection) takes the
`selected-case` sentence with "the cases chosen in <module>".

Production's `session/data` reads are all of a selected case (`case_id`), with
no placeholder, multi-select, query or unsupplied datum read, so the cutover meets no refusal here;
they lift onto identity in pull request 5 (§10).

**The chosen case in record slots** (from pull request 10, CSQL; part 01 §4, "Chosen case"). Three
record slots evaluate after an earlier menu's datum is supplied: a form's `displayCondition`, a
module's `caseListConfig.filter` (on the device, in Preview's Postgres read and in its CSQL runtime
segments) and an advanced search input's `predicate` (in its CSQL runtime segments, part 06 §3.9).
Their profiles admit `term session-datum` of the `selected-case` kind and the one `project` shape
keyed on it, the chosen case's property; the record dialect spells them `chosen-case('<menu name>')`
and `chosen-case-property('<menu name>', '<property>')` (part 02 §2.2). The checker reads them as it
reads form logic's datum reads, under the record rule set:

- **Supply.** The ref must be listed, scalar, in `ctx.supplies.refs`, which for these slots is the
  set at the slot's point (§1.3; part 05 §1.3, "Evaluation points"). Otherwise it is
  `datum-not-supplied` → `SESSION_DATUM_NOT_SUPPLIED` with `details.carrier` `case-list`, `search`
  or `form-display-condition` and `details.reason` `differs` where `ctx.supplies.differs` lists the
  ref (a case list or search that runs in entries holding the chosen case at different datum ids,
  part 05 §1.3, "One id per slot"), else `not-before`, each with part 05 §1.6's sentence. So a batch that turns
  off the parent selection a filter reads through, moves the module out from under the menu it
  reads, or switches that menu to several-case selection is refused at the read, as in form logic.
  Text naming a several-case menu is part 02's parse refusal.
- **Type.** The `session-datum` read carries `caseIdOf` the menu's case type (part 01 §1.3 rule 2),
  so the `project` row is typed by that case type and its property by the effective catalog: an
  undeclared property is `unknown-property` and a mismatched comparison is the ordinary type code,
  both under the slot's `*_TYPE_ERROR`.
- **A module's `displayCondition`** admits neither, because a menu shows before any datum of its
  entries is supplied: `case-data-unavailable` → `MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`,
  whose copy already says the module "is shown before a case is chosen". Every other record slot
  refuses the two arms as `arm-unavailable` under its type code.

Only `selected-case` is admitted in record slots; the other four kinds name a form's own creates,
the worker's record and a tile group's parents, none of which a person narrows a list or a search
by. No stored document can hold a chosen-case read today (record slots have no datum arm), so the
cutover meets none.

Tests: `lib/commcare/validator/__tests__/sessionData.test.ts` keeps its cases, through
`runValidation` now that its rule file is gone, re-pointed at stored `session-datum` leaves (each
refusal beside a supplied datum accepted, each kind's sentence asserted), plus a move of the
supplying module refused, plus a `selected-cases` read after a switch away from several-case
selection refused. With pull request 10 it adds the chosen case: a child module's case list filter
`village = chosen-case-property('Households', 'village')` accepted while its parent selection
passes through Households, refused under `SESSION_DATUM_NOT_SUPPLIED` with `not-before` once that
parent selection is turned off; `chosen-case('Villages')` in the filter of a Households module that
picks its parent village accepted, and refused with `differs` once another module selects through
Households' list; the same read in an advanced search input's predicate accepted; a form display
condition reading its own case-first module's chosen case accepted; a module display condition
reading it refused under `MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`; a chosen menu switched to
several-case selection refused. Pure, in `typeChecker.test.ts`: `chosen-case-property` of a `date`
property ordered against a text literal refused (`ordered-values`) beside the same against a date
accepted, and of an undeclared property refused.

### 3.10 What a slot's targets hold

Four rules read the profile's targets (§1.4):

- **`day-only-on-device`**: §3.2. It reads two facts at once, the profile's targets (`XF` or `SU`)
  and the row's root (§1.3): `date_opened` and `last_modified` in `casedb` (Core's `DateData`,
  `CaseChildElement.java::buildAndCacheInternalTree`), and `date_opened` in a `results` or
  `results:inline` row (HQ's UTC day,
  `corehq/ex-submodules/casexml/apps/case/xml/generator.py::V2CaseXMLGenerator.add_custom_properties`
  → `::date_to_xml_string` → `corehq/ex-submodules/dimagi/utils/parsing.py::json_format_date`,
  §3.2). The casedb half lands in pull request 8, the results-row half in pull request 9 (§10).
- **`closed_on`** (part 06 §3.1). `closed_on` is a search-only system property, `datetime`, in
  `lib/domain/standardCaseProperties.ts::SEARCH_ONLY_CASE_PROPERTY_DATA_TYPES` (new), not in the
  effective catalog. The checker resolves `prop closed_on` to `datetime` only in a slot whose targets
  exclude `SU` and `XF` (today the advanced Search predicate alone, part 01 §4); the existing
  ordering, `system-datetime-value` and `blank-comparand` rules then apply unchanged. Anywhere else it
  is `closed-on-not-on-device` → `CASE_LIST_CLOSED_ON_NOT_ON_DEVICE`, part 06's copy ("Date closed is
  known only to CommCare's server search, so it can't be read here. Case status shows whether a case
  is closed."). A relation `where` inherits its slot's targets. No stored expression reads
  `closed_on` today, because it is no catalog property and the record checker refuses an unknown
  property. It lands in pull request 10, CSQL, with part 06's search-only table.
- **`datetime-literal-precision`** (part 06 §3.13). A date-and-time literal admits at most three
  fraction digits in every slot, so a literal names one millisecond in Elasticsearch, Postgres and on
  a device alike; part 06's copy ("Choose a time to the millisecond or coarser. CommCare compares
  dates and times to the millisecond."). The builder's picker writes minutes, which pass. Corpus:
  none (executed during planning: no `document.json` holds a date-and-time spelling with four or more
  fraction digits; its four date-and-time spellings carry none). Production: part 06 §10's count
  (expected none), confirmed by the dry run (§5.4). It lands in pull request 6, the checker, not with
  CSQL's closed instant range in pull request 10: the rule holds in every slot, and no slot reads the
  literal differently between the two heads.
- **A fixed `format-date` pattern, and no `number()` of a date, where Postgres compiles** (part 07
  §5.1). Part 01 §1.4 widens `format-date.pattern` to a computed `Expression`; Postgres cannot
  compile one, so in every profile with a `PG` target (all record profiles that target it: case list
  filters and calculated columns, case operation slots, the Search predicate, `excludedOwnerIds`) a
  computed pattern is `format-date-pattern-not-fixed`. A record `double` of a `date` or `datetime` is
  refused there by today's `text-or-number-value` (`typeChecker.ts`, the `double` arm: "Coordinates /
  dates / datetimes / times are rejected"), which is part 07's `number-of-date` under its existing
  name: one concept, one code. Form logic admits both (Core's `toNumeric` of a `Date` is its day
  count; `format-date` takes any pattern). No stored document holds a computed pattern (today's
  schema has none) or a record `double` of a date (today's gate refuses it). Both land in pull
  request 6, the checker.

Tests (pure, `typeChecker.test.ts`): the day rule's cases are §3.2's, the results-row ones
included; `closed_on >= datetime-coerce('2026-01-01')` in the Search predicate accepted, the same in
a case list filter refused; a microsecond literal refused beside a millisecond and a minute literal
accepted (part 06 §9's row); a computed `format-date` pattern in a calculated column refused and in a
field `calculate` accepted; record `double(date_opened)` refused (today's case, kept).

### 3.11 Record positions

Part 01 §3.4 keeps the record dialect's condition and value positions as a rule of the record rule
set, because the record grammar's round-trip law rests on them. Condition positions are a
`condition`-family slot root, `and.clauses`, `or.clauses`, `not.clause`, `if.cond`,
`when-input-present.clause` and every `where`; every other operand is a value position; `if` and
`switch` take the position they stand in (part 01 §3.4). A boolean arm in a value position is
`record-position`, reason `value-expected`; a value arm in a condition position, reason
`condition-expected`; each goes under the slot's `*_TYPE_ERROR`. No stored document can hold either
today, since the Zod families keep them apart (`Predicate` and `ValueExpression`), so the cutover
meets none; the rule holds what the families held.

Tests (pure): `concat(eq(a, b))` in a calculated column refused beside `concat(a, b)` accepted;
`if(c, match-all, …)` in a value position refused; `true()` read back as `match-all` in a condition and
as the literal `true` in a value, each accepted.

---

## 4. Finding 73 and writer agreement

### 4.1 What Nova types today

`effectiveCaseTypes.ts::effectiveCaseTypes` fills an untyped declared property from its writers'
kinds (`writerTypeResolver`, `caseDataTypeForFieldKind`), so the property finding 73's document
writes from two `date` questions is `date` in Nova's view. Executed during planning (the
Hidden-writer documents, case D): a property declared without a type, written by a date question
that preloads it, is effective `date`. The lane's case generator reads the declared type only
(`proof/observe/casedata.py::_type_values`); from step 3 it reads the effective catalog that
`document.json` carries (part 08 §4.4).

Today's writer agreement: `FIELD_KIND_PROPERTY_TYPE_MISMATCH` (a visible writer against the declared
type), `FIELD_KIND_WRITERS_DISAGREE` (two visible writers), and `CASE_OPERATION_EXPRESSION_TYPE`
(an operation write against `lib/doc/caseOperationWriteTypes.ts::caseOperationWriteValueType`: the
declared type, else another writer's, by `isValueStorageAssignable`). Hidden Value writers are skipped
(`fieldKindMatchesPropertyType.ts`, "`hidden` … skipped"), and their structural inference gives a type
only to a lone `today()`, `now()` or case-property copy (`effectiveCaseTypes.ts::inferExpressionType`).
**Implementation correction, 2026-10-19:** the validator compares an operation write against the
declared type ∪ the concrete writer opinions (`concreteCasePropertyWriterTypes`, read in
`context.ts::slotContext`'s operation branch), not against `caseOperationWriteValueType`, which is a
builder helper (`lib/doc/hooks/useCaseOperations.ts`). Those opinions already held the closed Hidden
opinions above, so an operation co-writer was the one route by which a Hidden Value writer met a
finding.

### 4.2 Nova's own writers can put text where a typed question reads it back

Executed during planning (the Hidden-writer documents), a `patient` type whose `visit_date` is
written by a follow-up `date` question that preloads it
(`casePreload.ts::writerPreloadsFromLoadedCase` true in every case):

| Second writer of `visit_date` | Effective type | Findings |
|---|---|---|
| A. registration Hidden Value, calculate `concat('not', '-a-date')` | `date` | none |
| B. registration text question (the neighbour) | unknown | `FIELD_KIND_WRITERS_DISAGREE` |
| C. follow-up Hidden Value copying the text property `#patient/note` | unknown | none |
| D. follow-up Hidden Value `today()` | `date` | none |

A and C are admitted today, and each writes text a date question then casts at `xforms-ready`
(`org/javarosa/core/model/actions/SetValueAction.java::processAction`, which casts through
`AnswerDataFactory.templateByDataType(dataType).cast`, `DateData.java::cast` for a date), so the
follow-up form opens on no reader: finding 73 reached by Nova's own authoring, not only by foreign
data. C also silently drops the property's type to unknown, which `materializableCaseTypes` hands
the case store as text.

Production (both scans): no case row fails its preload's cast; the typed preloads from properties no
declaration types read rows that hold no value of them. Many Hidden Values, across many apps, write a
property a follow-up form preloads; whether each agrees needs step 3's inference, so the dry run
counts §4.3's refusals (§5.4).

### 4.3 Decision: Hidden Value writers join writer agreement

From step 3 a Hidden Value that writes a case property is a typed writer, judged as a case operation
write is:

- Its opinion is its inferred value type (§5), output by output (`visitAssignmentOutputs`'s walk of
  `if` / `coalesce` / `switch` branches), with `''` fitting every destination (Core writes no value
  for it, `Recalculate.wrapData`). An unknown output (a cycle, a read of an untyped property) holds no
  opinion: unknown is honest (`lib/domain/CLAUDE.md`).
- The property's type is its declared type, else the agreed type of its visible and operation writers
  (today's consensus), else, when only Hidden Values hold opinions, their one type, with `int` and
  `decimal` agreeing on `decimal`.
- A Hidden Value output that is not `isValueStorageAssignable` to that type is
  `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` (new, soundness, app rule in
  `lib/commcare/validator/rules/hiddenValueWriterAgreement.ts`, scope-exempt like the two field-kind
  codes in `runner.ts::SCOPE_EXEMPT_CODES`), one finding per writer, field-located; Hidden-only
  disagreement reports each Hidden writer.

**Implementation correction, 2026-10-19** (`inference.ts::hiddenWriterVerdicts`,
`rules/hiddenValueWriterAgreement.ts`). The opinion is taken output by output: a blank `''` output
and a yes/no output hold none, as an unknown one does, and the writer's opinion is the agreed type of
its typed outputs. A starting value with no calculation that its own form preloads holds no opinion
at all, since the preload overwrites it (the order this section's select-preload rule cites below),
and it is never a finding. A writer whose output's clock may be gone (§5.1) and whose property is a
date and time is `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` with `details.reason: "clock-lost"`; a case
operation's write of such a value into a date-and-time destination is `CASE_OPERATION_EXPRESSION_TYPE`
with the same reason (the checker's `expected-value`, reason `clock-lost`). Writer agreement already
refuses `datetime` into `date` or `text`, so only a copy chain reaches this rule: a Hidden Value
`now()` that writes nothing, copied by one that writes a date-and-time property, would save
midnight.

Integral functions type `int` (part 01 §3.3): `int`, `round`, `floor`, `ceiling`,
`string-length`, `count-selected` and `position` carry `integral: true` in `FUNCTION_REGISTRY`,
because Core stores an integral `Double` as `IntegerData` (`Recalculate.wrapData`: `isIntegral` →
`IntegerData`) and step 2's manifest reader already types `count`, `count-selected` and `int` as
integers. So a Hidden Value `int(#form/n div 2)` can write an `int` property under this rule, and a
`repeat_count` of `round(…)` is an integer. **Implementation correction, 2026-10-19:** Core's
`round` has one argument (`XPathRoundFunc`'s `EXPECTED_ARG_COUNT`), so the plan's "(one argument)"
named no other form; `index-of` is not integral: `XPathIndexOfFunc.java::evalBody` returns `''` when nothing matches, so its result is text or a number by data. **Implementation correction, 2026-10-20 (pull request 6):**
`number`, `sum`, `min` and `max` over `int` or yes/no arguments are `int` too (part 01 §3.3), so a
Hidden Value `sum(#form/visit/count)` can write an `int` property.

**Implementation correction, 2026-10-20 (pull request 6):** Hidden Value writers that alone type a
property also agree when they split between `text` and `single_select`, on `text`
(`inference.ts::mergeHiddenOpinions`, which a writer's own outputs and the property's agreement
share). A choice's value and a text literal share storage (`isValueStorageAssignable` already
interchanges the two), so a select-answer copy beside a text literal is one text property, not a
disagreement; the user decided it. The merged `text` is the property's inferred type wherever the
single type was, and each writer then projects onto it in `writerOpinions`, so
`concreteCasePropertyWriterTypes` holds `text` alone and the case operation check sees no conflict.
`multi_select` stays apart: Nova stores it as a list, which storage keeps text out of (the checker's
`multi-select value cannot flow through scalar` refusal), so it is not the same storage. Every other
pair stays strict, and visible writers and preloading readers keep their own rules.

**Implementation correction, 2026-10-20 (pull request 6):** a `format-date` whose pattern is fixed to
`%Y-%m-%d` (the `iso` preset prints as it) is a valid write into a `date` property. Core formats it as
`YYYY-MM-DD` (`XPathFormatDateFunc.java:28-34`, `DateUtils.java:419-432`) or `''` for no date, and a
date question reads the saved text back through `DateData.java:88-89` (`cast` →
`DateUtils.parseDate`, `DateUtils.java:484-512`, three dash-separated integers that `df.check()`
accepts), reached from `SetValueAction.java:140`. The allowance is writer compatibility only
(`ruleSets.ts::isWriteAssignable`, recognised from the tree by `datePattern.ts::isIsoDateText`, never
from text): `HIDDEN_VALUE_WRITER_TYPE_MISMATCH`'s `type` reason, the checker's assignment rule for a
case operation write (`CASE_OPERATION_EXPRESSION_TYPE`), and a case operation's writer opinion, which
takes the date destination when every branch is such a `format-date`. The value's own type stays
`text` everywhere else, so the record rule set still refuses ordering it against a date, and a
Hidden-only pair of a date and such text still disagrees. A `datetime` property stays strict:
`DateTimeData.cast` would take the day (`DateUtils.parseDateTime` parses a string without `T` as a
date, `DateUtils.java:469-481`), but it would save midnight, which writer agreement already refuses
for a `date` value. The user decided it.

Validator message: `Hidden value "<field>" in "<form>" saves <text> to "<property>" on "<type>",
which holds <a date> (<declared | saved by "<writer>" in "<form>">). A form that fills a question from
"<property>" would stop on a value that isn't <a date>. You can change the calculation so it gives
<a date>, or save it to another property.` Builder line: `"X" saves text to "visit_date", which holds
dates. You can change its calculation to give a date, or save it somewhere else.`

Consequences:

- `fieldKindMatchesPropertyType.ts` keeps its kind-equality rule for visible writers (a question's
  kind is its type), and its docblock stops calling Hidden Values exempt.
- `lib/doc/kindConversionCascade.ts` calls a conversion to `hidden` "agreement-exempt" and pins an
  undeclared property to the source kind's type; the pin stays (a Hidden Value with no value source
  holds no opinion), and the comment says why.
- `effectiveCaseTypes.ts::concreteCasePropertyWriterTypes` gains the Hidden opinions, so the
  validators that read it (`caseOperations.ts`) see them. **Implementation correction,
  2026-10-19:** it already held the closed Hidden opinions (§4.1); from pull request 6 it is a
  projection of `inference.ts::inferExpressionTypes`'s `writerOpinions`, the fixpoint's opinions
  of every writer kind, a preloaded starting value excluded.
- A typed read now refuses what it admitted: a Hidden Value read in a record slot (a case operation
  value, a lookup or case choice filter) has its inferred type where today it is unknown
  (`effectiveCaseTypes.ts::collectFormFieldTypes` maps a Hidden Value to `undefined`).

No rule narrower than this is needed for the question that preloads: every Nova writer of the
property, visible, operation and Hidden, is now held to its type, and a question is held to it by the
kind rule. Two further authoring cases remain:

- **A select that preloads from a property another writer fills with free text.** A text Hidden Value
  or operation write is storage-assignable to `single_select` (`isValueStorageAssignable`: text and
  single select share storage), so a follow-up single select can preload a value none of its choices
  holds, and `PromptToJson.parseQuestionAnswer` → `attachChoice` refuses the form in Web Apps (§3.5's
  evidence). This is finding 72's runtime twin, and step 3 holds it as finding 72 is held, below.
  Production (field writers only; operation writers not counted): of the static selects that preload
  from a property, some, in a few apps, share the property with a Hidden Value writer, and some
  share it with a static select whose choices are not within theirs; more share it only with
  selects within their choices, and most have no other field writer.
- **A property whose type a person changes.** `lib/doc/kindConversionCascade.ts` re-types the property
  and the case store casts its rows (`applySchemaChange`), but cases already on devices and in HQ keep
  their text.

**Decision: a literal written into a property a static select preloads is one of its options.** A
Nova writer that writes a literal, a Hidden Value whose `calculate` (or, with none, `default_value`)
is a whole-slot string or number literal, or a case operation write whose value is a literal, into a
property that a single or multiple select whose `optionsSource` is `inline` preloads
(`lib/domain/casePreload.ts::writerPreloadsFromLoadedCase`), must write one of that select's option
values (single), or space-separated tokens that are all option values (multiple), by finding 72's
rule (§3.5): a number uses its native answer text, and `''` writes no value and is
admitted. Otherwise it is `SELECT_PRELOAD_WRITE_NOT_AN_OPTION` (new, in finding 72's family:
soundness, app rule in `lib/commcare/validator/rules/selectPreloadWriterOptions.ts`, scope-exempt in
`runner.ts::SCOPE_EXEMPT_CODES` like `HIDDEN_VALUE_WRITER_TYPE_MISMATCH`, since writer and reader sit
in different forms), one finding per writer and reading select, located at the writer (a Hidden
Value field-located at its value slot; a case operation operation-located, as
`rules/caseOperations.ts::opError` locates), `details` `{ value, caseType, property, readerField,
readerForm, options }`. Admitted: any computed write (an `if` with literal branches included, as a
computed default is admitted); a Hidden Value with no `calculate` that itself preloads its property
(`writerPreloadsFromLoadedCase` holds for the writer: a follow-up writing its own module's case
type), because the preload setvalue runs after the default's and overwrites it, so the form saves
the loaded value back and never the literal (`xform/builder.ts` writes the default during the field
walk and `xform/caseBlocks.ts::addCaseBlocks` appends the preload setvalues after it;
`lib/agent/authoring/fieldBehavior.ts` reports such a default as `configuredDefaultIsOverridden`); a
write into a property only a lookup- or case-backed select
preloads, and a select that does not preload (a registration form, a several-case form). A visible
select co-writer whose choices are wider than the reader's is not a literal write: its value is the
worker's answer, so it stays admitted, and Preview refuses its run-time value as Core does (part 07
§4).

Validator message (a Hidden Value): `Hidden value "<writer>" in "<form>" saves "<value>" to
"<property>" on "<type>", which "<question>" in "<reader form>" starts on, and "<value>" isn't one of
its choices (<a, b, c>). CommCare's Web Apps can't open a form whose choice question starts on a
value it doesn't offer. You can save one of its choices, like '<a>', or save to another property.`
(a case operation: `Case operation "<id>" in "<form>" saves …`). Builder line (`userFacingErrors.ts`):
`"X" saves "<value>" to "<property>", which "Q" in "F" starts on, but "<value>" isn't one of its
choices. You can save one of its choices instead, or save it somewhere else.` It is a validator rule,
not a checker code, so it has no card-editor line.

It lands in pull request 6, the checker, with writer agreement, which reads the same case-write
inventory and preload rule. Its corpus effect is decided by that pull request's base-and-head run, as
§4.3's is (§7). The cutover's dry run counts what production holds (§5.4); any is a blocker the author
resolves before the window.

Tests (`lib/commcare/validator/__tests__/selectPreloadWriterOptions.test.ts`, through
`runValidation`): a registration Hidden Value `'z'` into a property a follow-up inline single select
with options `a`, `b` preloads refused beside `'a'` accepted; `''` accepted; `concat('a', '')`
accepted (computed); a case operation's literal `'z'` refused beside `'b'` accepted; a multiple
select reader, `'a z'` refused beside `'a b'` accepted; `1` against an option `1` accepted; the same
`'z'` with a lookup-backed reader, and with a reader on a several-case form, accepted; a follow-up
Hidden Value with no `calculate` and the starting value `'z'` that preloads the same property
accepted (the preload overwrites it), beside the same writer with `calculate` `'z'` refused.

**Implementation correction, 2026-10-19.** The rule counts typed and untyped literals alike (a
`literal('z', 'single_select')` write is a literal write) and is independent of storage
assignability, which is writer agreement's question. So the `1` into an option `"1"` and the `'a b'`
into a multiple cases above assert only this rule's absence: storage refuses an untyped number into a
`single_select` property and untyped text into a `multi_select` one, under
`HIDDEN_VALUE_WRITER_TYPE_MISMATCH` or `CASE_OPERATION_EXPRESSION_TYPE`. A multiple's tokens split
as Core's `DataUtil.splitOnSpaces` does, on runs of U+0020 with empty tokens dropped
(`expression/choiceValue.ts::selectAnswerTokens`, which `checkChoiceDefault` shares), so a tab is
part of a token. A case operation finding is located through `rules/caseOperations.ts::caseOperationError`,
the shared form of `opError`. Its corpus effect is read as §7 corrects.

### 4.4 Beyond authoring

A case written by another app, an import, a case update rule, HQ's case API or an HQ edit, or by this
app before a type change, can hold text that does not cast, and the form still stops at the preload
(`SetValueAction.processAction`). No authoring rule reaches it. Preview mirrors Core's refusal (part 07
§4): a preload or starting value whose text does not cast to the question's bind type stops the entry
with a sentence naming the case, the property and the value, and a way back, through
`lib/preview/engine/answerCast.ts::castAnswerText`, whose bind type comes from the XForm emitter's own
bind-type function. Part 07 records that Nova's own writers cannot create such a row once §4.3 holds.

Tests (`lib/commcare/validator/__tests__/hiddenValueWriterAgreement.test.ts`, through `runValidation`,
the four Hidden-writer documents of §4.2 as fixtures): A and C refused at the Hidden Value; B refused
under `FIELD_KIND_WRITERS_DISAGREE` (unchanged); D accepted; a Hidden Value `if(c, '', #form/d)`
writing a date property accepted; `#form/a + 1` (integers) writing an `int` property accepted and
`#form/a * 1.5` refused; a Hidden-only pair `int` and `decimal` accepted as `decimal`; a cycle (a
Hidden Value copying the property it writes) accepted with the property unknown; `int(#form/n div 2)`
writing an `int` property accepted.

---

## 5. Hidden Value type inference

### 5.1 The fixpoint

`lib/domain/expression/inference.ts::inferExpressionTypes(doc)` computes three vectors together, and
`context.ts::expressionFacts(doc)` (§1.3), the one home of the per-document facts, calls it once per
document object (a `WeakMap`, as `effectiveCaseTypes` does) and holds its result as `caseTypes` and
`hiddenTypes`. In pull request 5, before the fixpoint exists, `expressionFacts` takes both from
today's `effectiveCaseTypes`; pull request 6 swaps in `inferExpressionTypes`. The vectors:

- `H`: each Hidden Value's type, the `typeOf` of its `calculate`, else its `default_value`, under
  its form's context, with property reads typed from the current `P` and Hidden reads from the
  current `H`;
- `P`: each `(caseType, property)` type, declared ?? the consensus of §4.3 over visible kinds, `O`
  and `H`;
- `O`: each case-operation write's type (today's `effectiveCaseTypes.ts::buildWriterIndex` loop,
  `inferOperationWriteType`).

Iteration starts with every unknown and recomputes `H`, then `P`, then `O`, until none changes.
Inference reads only concrete opinions: a property with no type yet is unknown, never text (today's
`concreteInferenceCaseTypes` rule, kept). Part 01 §3.2's leaf table types an untyped `prop` /
`form-case` as `text` for comparison verdicts; inference and agreement do not, because a text
opinion invented from no writer fact would make a Hidden copy of an untyped property refuse a date
writer. So a chain resolves once a real writer's opinion arrives and a cycle stays unknown (part 01
§3.2). A type moves only from unknown to one type to conflict, so the loop ends within
`|H| + |O| + 2` passes; today's oscillation guard (`typeSignature`, keeping only the opinions stable
across a cycle) stays as the backstop.

A Hidden Value's data type, the one the checker, the lowering and Preview's evaluator read: its `H`
when it writes no property; when it writes one, the property's agreed `P` where `H` is unknown or
assignable to it. The expression's type is the writer's opinion; the destination's is the value it
holds, so `if(c, #form/dt, '')` writing a date and time property keeps its `xsd:dateTime` bind. Its
**bind** is a separate fact and keeps today's rule (part 04 §5.4; part 01 §3.2):
`lib/commcare/xform/builder.ts` writes `xsd:dateTime` when
`lib/domain/fieldValueType.ts::fieldValueType`, the writer destination's type, is `datetime`, and
`BIND_TYPE_BY_KIND.hidden`, `xsd:string`, otherwise. So a Hidden Value that writes nothing keeps its
`xsd:string` bind whatever its inferred type, and its held class is the one that bind and its result
give (`Recalculate.java::wrapData`: text is `StringData`, a `Date` is `DateData` under any bind but
`xsd:dateTime`; part 01 §3.2), which the lowering reads.

**Implementation correction, 2026-10-19:** an analysis whose expression reads a generated node (a
repeat's count, a Connect value) is never reused across passes: such a node is typed through another
slot's expression, which can read any Hidden Value, so the site counts as reading every one
(`inference.ts`, `siteReads`, and `namedByInference` for the incremental gate).

**Implementation correction, 2026-10-19: clock provenance.** The fixpoint computes a fourth vector,
`C`, beside `H`, `P` and `O`, and a held class per Hidden Value (`ExpressionInference.hiddenHeld`,
`clockLost`; `expressionFacts` carries both beside `hiddenTypes`). The held class comes from bind ×
source slot × result: a `calculate` is stored through `Recalculate.java::wrapData`, so text holds
`string` under any bind, a number `number`, and a `Date` `date` (`DateTimeData` under
`xsd:dateTime`, otherwise `DateData`, rounded to the day); a `default_value` is a setvalue, whose
`SetValueAction.java::processAction` casts the wrapped value's text through the bind's answer class,
so a starting value under `xsd:string` holds text (`YYYY-MM-DD` for a `Date`) and one under
`xsd:dateTime` holds `date`. A date and time whose clock may be gone is `clockLost`: a `Date` result
of datetime or unknown data under an `xsd:string` bind, from either slot, and anything that copies
such a value through any Hidden Value, `if` / `coalesce` / `switch` branch or bind, since an
`xsd:dateTime` bind cannot restore a lost clock. `date-coerce` clears the mark (an explicit `date()`
is a day by request), `datetime-coerce` and `date-add` keep it, and text results carry none;
`today()`, `date()` and date questions are days by meaning, never `clockLost`. The checker's
`NodeType` carries it (`clockLost?: true`). Pull request 6 refuses a clock-lost value written into a
date-and-time property (§4.3, reason `clock-lost`); pull request 8, the lowering, refuses an implicit
instant comparison with a clock-lost operand (`incompatible-values`, reason `clock-lost`), because a
bare comparison before the lowering compares days and the lowering would read the day's text as NaN;
an explicit `date()` on both sides stays admitted. The bind keeps today's rule (`fieldValueType`),
unchanged, and a Hidden Value that writes nothing keeps `xsd:string` whatever `H` is. An untyped
Hidden Value's field leaf is `_any` with its held class, so it holds no opinion yet keeps its held
representation. Inference types over its own concrete catalog and an empty lookup index (data tables
are no document fact), so `#case/p + 1` writing an untyped `p` stays unknown. The type passes keep
the `|H| + |O| + 2` bound; held classes and `C` then settle over the settled types in a fixpoint of
their own (`Inference.finish`, at most `|H| + 1` passes), so neither moves a data type.

**Implementation correction, 2026-10-19: the clock-lost comparison, as built.** A leaf is
`clock-lost` when its `NodeType` carries `clockLost` and its data is `datetime`, `_any` or unknown,
or when it is any `clockLost` operand of a `datetime-coerce`. Refused by §3.2's correction's rule
(after a system date, before a date) wherever the comparison lowers, so `date()` on both sides stays
admitted (two dates, bare). Copy, in Nova's voice: the checker's `This compares a value that has
kept only the day of a date and time with a moment, so CommCare can't line the two up. You can
compare the date and time from the question or value that first recorded it, or wrap both sides in
date() to compare days.`; the validator's names the Hidden Value (`details.clockSource`, its id):
`<owner> compares "<id>", which has kept only the day of a date and time, with a moment<slot>, so
CommCare can't line the two up. …`; the builder line `This value has kept only the day of a date and
time. You can compare the date and time that first recorded it, or wrap both sides in date() to
compare days`; and record slots `<subject> compares a value that has kept only the day of a date
and time with a moment, so the two can't line up. …` (`instantComparisonCopy`). Tests: a copy of
`now()` under `xsd:string` refused against `now()`, admitted with `date()` on both sides.

### 5.2 What it replaces

- `lib/domain/fieldValueType.ts::fieldValueType` stays, with its seven callers
  (`lib/commcare/formActions.ts`, two sites; `lib/commcare/xform/generatedNodes.ts`;
  `lib/commcare/xform/builder.ts`, three sites; `lib/preview/engine/formEngine.ts::computedFieldValue`),
  because it is the bind's rule (§5.1). It reads the destination's type from
  `expressionFacts(doc).caseTypes`, so the bind follows the one effective catalog. Where step 3's
  inference types a property that today is unknown, its Hidden writers' binds follow it; a property
  newly typed `datetime` gives its Hidden writers an `xsd:dateTime` bind, and since the writers now
  agree (§4.3), Nova's own text casts. Part 04's census (part 04 §5.4) names the bind changes inference
  causes through `fieldValueType`, and the dry run's base-and-head emission counts them (§5.4 item
  2). The bind keeps reading the one effective catalog; no pre-inference type is kept beside it,
  because that would give one property two types.
- `effectiveCaseTypes.ts::WHOLE_EXPRESSION_TYPES`, `inferHiddenWriterType` and `inferExpressionType`
  are deleted; `writerTypeResolver` reads `H`. `effectiveCaseTypes` and `materializableCaseTypes`
  keep their names and callers and become projections of `expressionFacts(doc).caseTypes`.
  **Implementation correction, 2026-10-19:** at pull request 5's head only `inferHiddenWriterType`
  and `inferExpressionType` remained, and pull request 6 deletes them with `writerTypeResolver`'s
  index. `effectiveCaseTypes`, `materializableCaseTypes` and `concreteCasePropertyWriterTypes` are
  projections of `inference.ts::inferExpressionTypes` (its `caseTypes` and `writerOpinions`), which
  `expressionFacts` also reads; the build lives in `inference.ts`, so `effectiveCaseTypes.ts` imports
  inference and no cycle runs back through `context.ts`.
- `timeOrdering.ts::TimeReader.leafIsTime`'s recursion into a calculate is the same inference, now
  shared.

### 5.3 What changes for existing documents

Inference types properties and Hidden reads that today are unknown, so documents valid today can
change in three ways:

1. **A property gains a type.** A property whose only writers are Hidden Values with an inferable
   expression (`#form/a + 1`, `concat(…)`) is unknown today and typed from step 3. The case store's
   schema and indexes are materialised from `materializableCaseTypes` (`lib/case-store`), so its JSON
   schema and index expressions change; rows that do not cast are parked by the schema change, which
   the cutover part runs and names in the notice. Such a property's Hidden writers' binds follow it
   (§5.2).
2. **A type moves.** A property typed by a visible writer and also written by a Hidden Value whose
   inference disagrees becomes a `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` finding (§4.3); one written only
   by disagreeing Hidden Values does too.
3. **A verdict moves.** A record slot comparing a newly typed property or a Hidden read
   (`CASE_LIST_FILTER_TYPE_ERROR`, `CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH`,
   `CASE_OPERATION_EXPRESSION_TYPE`, `LOOKUP_SELECT_FILTER_TYPE_ERROR`, …), and every form-logic
   refusal of §3 that a newly typed operand meets.

Each such document is a cutover blocker, and the plan counts them in two halves:

- **The production scans** (read-only, one `REPEATABLE READ READ ONLY` transaction, closed labels
  and counts only; executed during planning with the person's permission) counted what today's code
  can decide, over every live app, with no app unreadable and no scan failure. Every class of §3
  they could reach is recorded in its section: date against date and time and date-and-time
  orderings (§3.2, none refused), boolean comparisons (§3.3, none), structural several-value reads
  (§3.4, a few, lifted to their first row), untyped queries (§3.4, some, split by part 09 §11),
  literal select defaults (§3.5, none refused), `here`, `jr:itext`, `jr:choice-name` (§3.6, §3.7, no
  reads), Search answers and results (§3.8, no reads), session datums (§3.9, every read supplied),
  finding 73's rows (§4.2, none failing). Nothing has been committed after any app's step 2 fold
  baseline, so the step 3 horizon's opaque suffix is whatever accrues until the window.
- **The dry run** is the cutover part's, and §5.4 lists what it must count.

### 5.4 What remains for the cutover's dry run

At the stack's head the dry run lifts every production document with the frozen printer and the
step 3 parser, as the cutover itself does, runs `evaluateCommit` on the result, and reports counts by
`ValidationErrorCode` and `details.reason` (and, under a record slot's type code, by
`details.checkCode` and `details.checkReason`, §1.5), with no content. It runs read-only through
`scripts/lib/prodDb.ts::targetProdDb` under the person's standing permission for read-only production
reads, so no further yes is needed. **Every non-zero count of a refusal below is a blocker by rule:**
a `target-gate` blocker (part 09 §11, which lists each with its expected count) that the author
resolves in the app before the window, the lift neither fixing it nor naming it in a notice; while
Nova is dogfooded the person is the fleet's author. Item 2 counts changes, not refusals. It must
count:

1. `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` (§4.3) and the moved verdicts of §5.3 class 3, which need
   step 3's inference and so no scan could count (expected none or few; blockers).
2. Properties typed by step 3's inference that are unknown today (§5.3 class 1), by type, with their
   case store schema changes and parked rows; and the bind changes inference causes through
   `fieldValueType`, which part 04's census names, counted by the dry run's emission at base and head
   (those typed `datetime` separately, since their Hidden writers gain an `xsd:dateTime` bind).
3. `XPATH_INCOMPATIBLE_VALUES`, reasons `date-datetime` (form-logic `=` / `!=` were not counted) and
   `day-only-on-device` (production's raw `casedb` reads of a system date sit outside every ordering
   and were not classified by use; a results row's `date_opened`, expected none: no `results*` read
   is stored), and the slot type codes carrying the same reasons in record slots (expected none: the
   scans found no record read of a system date). Expected none or few; blockers.
4. `XPATH_MANY_VALUES` after the lift's `[1]` on the structural reads (expected none), including
   prose parts, which the scans did not read, and `selected-cases` used as one value (expected none:
   no such read is stored, so none lifts). Blockers.
5. `case-query-untyped` over production's untyped queries that read a row value: each that binds to
   no declaring case type or to several is a blocker. Part 09 §11 expects such blockers among the
   reads several types declare, beside standard reads, reads that bind to one type and reads typed
   by `@case_id` from a known source; those last read a property no catalog declares and become
   declarations, with the typed-query reads of a property outside the catalog, so `INVALID_CASE_REF`
   over them is expected to clear once the lift declares the read properties.
6. `CYCLE` over lifted documents, since relative reads gain dependency edges (part 07 §1.4).
   Expected none or few; blockers.
7. `SELECT_PRELOAD_WRITE_NOT_AN_OPTION` (§4.3): production's static selects that share a preloaded
   property with a Hidden Value writer were counted, but not whether that writer writes a literal,
   and operation writers were not counted. Expected none or few; blockers.
8. `SESSION_DATUM_NOT_SUPPLIED` over identity (expected none: every stored read is of a selected
   case), `SELECT_DEFAULT_NOT_AN_OPTION` after the `choice` lift (expected none),
   `XPATH_FUNCTION_CONTEXT_UNAVAILABLE` with every reason (expected none: no reads),
   `INVALID_SEARCH_REF`, `SEARCH_RESULTS_NOT_SUPPLIED` and `SEARCH_RESULTS_READ_INVALID` (expected
   none: no reads), `record-position` (expected none: the Zod families hold it today). Blockers.
9. `TYPE_ERROR` with reason `datetime-literal-precision` and its record slot equivalent (part 06 §10
   counts stored literals; expected none). Blockers.
10. The full finding multiset of the lifted documents against the same documents at the base, so that
    a code no row above names still surfaces; a finding the base does not hold is a blocker too.

**Implementation correction, 2026-10-19:** the dry run also counts clock-lost writes (§5.1) as
blockers: `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` and `CASE_OPERATION_EXPRESSION_TYPE` with
`details.reason: "clock-lost"` (item 1's codes, counted apart by reason), and, from pull request 8,
`XPATH_INCOMPATIBLE_VALUES` with reason `clock-lost` (item 3's). Production's blank tests `= ''`
against an `if(…, now(), …)` Hidden Value stay bare and admitted. Expected none or few; blockers.

---

## 6. The gate's cost

**Today** (executed during planning, the gate-cost runs):

| Document set | Form-logic slots | Gate (`runValidation`) | Deep walk | Lezer parses in the gate |
|---|---|---|---|---|
| the corpus, 371 documents | 606 | 137 ms in all; the slowest document 3.1 ms | 39 ms | 7,425, 12.2 per slot, 2.0 µs each |
| `gateScale.test.ts`'s fixture, 3,000 fields | 5,040 | 270 ms (min of 3) | 160 ms | 60,720, 12.0 per slot, 108 ms |

The twelve parses per slot are `canonicalXPathError`'s parse, `validateXPath`'s, the compatibility
analyser's, `checkTypes`', the path-ref and root-read extractors', the time-ordering reader's, the
session-datum reader's, the instance analyser's and the unquoted-literal detector's, each over text
printed again from the stored AST.

**The checker** (executed during planning): today's record checker over the corpus's case-list
filters and calculated columns, with a prebuilt context, costs 0.07 µs a node (0.5 µs a slot, 560
nodes in 86 slots). `effectiveCaseTypes` cold costs 0.9 ms on the 3,000-field fixture and 4.8 ms
over all 371 corpus documents.

**From step 3** the gate prints and parses nothing: the tree is typed where it is stored. Typing every
form-logic slot of the 3,000-field fixture is about 5,040 slots × a few nodes × well under a
microsecond, a few milliseconds, against 108 ms of parsing today; the per-document facts (§5.1) cost
the order of `effectiveCaseTypes`, which they replace.

Memoisation, decided:

- `expressionFacts(doc)`: a `WeakMap` on the document object, as `effectiveCaseTypes` and
  `timeOrdering.ts::TIME_READERS` are; documents are replaced, never mutated (`lib/domain/CLAUDE.md`),
  so a hit is never stale.
- `formExpressionFacts(doc, formUuid)`: a `WeakMap<doc, Map<formUuid, …>>`, built on first use, so a
  scoped commit (`lib/doc/incrementalValidationScope.ts`) builds only the touched forms'.
  **Implementation correction, 2026-10-19:** a scoped commit is sound only while inference moves
  nothing outside its footprint, since `expressionFacts` is document-wide. So
  `incrementalValidationScope(prevDoc, mutations, nextDoc)` falls back to the absolute gate when
  `inference.ts::inferenceFingerprint` (catalog types by name, Hidden data types, held classes,
  clock loss, writer opinions; memoised per document) differs between the two documents, and
  `lib/doc/commitVerdicts.ts::mutationCommitVerdictWithPrevalidation` passes the candidate.
  `updateSearchInput` adds the module's no-matches form, whose reads the input's kind types. A
  batch that leaves the fingerprint unchanged keeps its footprint.
- `typeOf(expression, ctx)`: a `WeakMap` on the expression node inside one context object, for
  emitters and the lowering, which ask the same node more than once in one run.
- No cross-commit, per-slot verdict cache. A slot's verdict depends on document-wide facts (Hidden
  inference crosses forms through case properties), so a cache would need a dependency fingerprint per
  slot, and the work it saves is under a microsecond a node.

`gateScale.test.ts` stays the regression boundary: it builds the fixture, asserts the clean verdict and
the one broken reference, and its broken-reference case becomes a dangling field leaf
(`INVALID_REF`, dangling) because `#form/missing` no longer parses.

---

## 7. The corpus

`proof/corpus/emitCorpus.ts::admittedDoc` stops the emission on a document the gate refuses, so each
pull request that narrows the validator follows step 2's rule (step 2 part 09, "Corpus changes"): it
runs the emission with no Docker at its base and its head,

```bash
node --conditions=react-server --import ./proof/corpus/entropy.mts \
  --import tsx proof/corpus/emit.ts --out <dir>
```

and reads the stop, the boundary census and the diff of `index.json`'s document ids, and it runs
`runValidation` over both corpora and compares the multiset of `(document, code, location)` findings,
which is how it proves that moving a rule into the checker (§1.4, §2.2) moved no verdict (part 08
§4.1 runs the same comparison in pull request 5, the shape, and pull request 6, the checker, runs it
again for its narrowings). Executed during planning, the emission at `main`: 371 documents, none
refused.

**Implementation correction, 2026-10-19.** Every admission point refuses on the first finding
(`emitCorpus.ts::admittedDoc`, `fuzzSample.ts::admitted`, `editBatches.ts::hydrateAdmittedDocument`),
so a base-and-head multiset over two emitted corpora is empty by construction and shows no moved
verdict. The comparison that does is head code validating the base corpus: a read-only runner, kept
outside the repository, runs the head's `runValidation` (with `publishFindings`) over every base
document D and its edit D′ and lists each finding by document, variant, code, location and reason;
then `index.json`'s census (each kind's `landed`, `refused` by code) and each `edit/batch.json` are
diffed at base and head, since one edit candidate the head refuses can reorder other documents'
batches; then the head emission, which must not stop. A finding the runner lists is a document to
rewrite in its producer or a fuzz draw to map (part 08 §4.2).

What each narrowing of this part does to the corpus at `main`:

| Narrowing | Corpus documents it refuses (executed) | Change |
|---|---|---|
| finding 72, `SELECT_DEFAULT_NOT_AN_OPTION` | 20 defaults in 12 fuzz documents (of 40 select defaults in 19, part 08 §3.3), the five that hold finding 72's walk stops among them | `lib/commcare/__tests__/xformDocArbitrary.ts::buildField`'s select branch writes the default as the quoted value of the select's first drawn option (`options[0].value`) in place of `DEFAULT_VALUE_BY_KIND[kind]`, after the draw, with no new `fc` call; the random stream, every other draw and every fuzz id stay, and only those documents' bytes move. Every select has at least two options (`selectOptionsSchema`'s `.min(2)`). The narrowing rides pull request 5, the shape, which rewrites the generator anyway (part 08 §3.3), and part 08 §3.3 removes the five walk stops in it, with no control; `proof/corpus/__tests__/fuzzSample.test.ts` (new, part 08) holds the mapping |
| §3.2 (date and time, including `day-only-on-device`), §3.3, §3.4 (structural reads only) | none (the one system-date ordering, `targeted-search-hq-compile`, is against a day-aligned operand; the 22 repeat reads from outside sit in admitted positions) | none |
| §4.3 Hidden Value writer agreement | unknown: needs step 3's inference | pull request 6's base-and-head run decides; a refused fixture document is rewritten in its producer test (a named uuid for any entity it gains, step 2's rule), a refused fuzz draw is mapped |
| §4.3 a literal written into a property a static select preloads, `SELECT_PRELOAD_WRITE_NOT_AN_OPTION` | not counted: pull request 6's base-and-head run counts it | as the row above |
| §3.6 to §3.9 | none (no corpus document holds `here`, `jr:itext`, `jr:choice-name`, a Search answer outside a no-matches form, a search-results read, or an unsupplied datum) | none |
| §3.10, §3.11 | none (`closed_on`, a computed `format-date` pattern and a record position swap cannot be stored today; no date-and-time literal finer than a millisecond) | none |

From step 3 the fuzz generator's form logic is no longer `opaqueXPathExpression` text runs but the
union; the generator draws text as today and parses it with the production parser against the built
document (`lib/__tests__/docHelpers.ts::xpIn`'s binding), so a drawn default that equals an option
parses to a `choice` leaf. The mapping of finding 72 happens on the drawn text, before the parse
(part 08 §4.2). The corpus's untyped queries (11 in 9 fuzz documents, each projecting `@case_id`,
which an untyped query may read, and 5 of them reading a row value in another predicate) are part
02's parse (bind or refuse) and part 08's census, not a checker refusal.

---

## 8. Files

- Domain: `lib/domain/expression/typeChecker.ts`, `ruleSets.ts`, `context.ts`, `inference.ts`
  (part 01's layout plus `ruleSets.ts` and `context.ts`); `lib/domain/expression/profiles.ts` (the
  calculated-column profile admits the `here` arm in pull request 6, §3.6, and the new reads in pull
  request 9); `lib/domain/expressionFunctions.ts`
  (`manyArguments`, §3.4; integral returns, §4.3 and part 01 §3.3); `lib/domain/effectiveCaseTypes.ts`
  (§5.2); `lib/domain/fieldValueType.ts` (kept, reads the one effective catalog, §5.2);
  `lib/domain/standardCaseProperties.ts` (`SEARCH_ONLY_CASE_PROPERTY_DATA_TYPES`, part 06, read by
  §3.10); `lib/domain/translationUnits.ts` (`showsAnswer`, §3.7).
- Validator: `lib/commcare/validator/formLogicFindings.ts` (new); `index.ts` (the deep walk keeps the
  form loop, prose round trip and cycles); `xpathValidator.ts`, `typeChecker.ts`, `timeOrdering.ts`
  deleted, and `rules/sessionData.ts` deleted (entry supply is checker admission;
  `checkCaseHashtag`'s messages and `SESSION_FORM_READ_MESSAGE` move to `formLogicFindings.ts`); no
  `rules/case-search/searchResultsRead.ts` is added; `runner.ts` (`validateXPathCarrierInstances`
  deleted; `SCOPE_EXEMPT_CODES` gains `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` and
  `SELECT_PRELOAD_WRITE_NOT_AN_OPTION`); `errors.ts`, `gate.ts` (this part's five codes and `SEARCH_RESULTS_READ_INVALID`);
  `lookupTypeContext.ts` (`checkErrorDetails`, §1.5); `rules/hiddenValueWriterAgreement.ts` (new);
  `rules/selectPreloadWriterOptions.ts` (new, §4.3);
  `rules/fieldKindMatchesPropertyType.ts` (docblock); `rules/field.ts`
  (`SELECT_DEFAULT_NOT_AN_OPTION` wiring, `unquotedStringLiteral` deleted); `rules/form.ts`
  (`CONNECT_UNQUOTED_XPATH`, `CONNECT_EMPTY_XPATH` deleted); `rules/app.ts` (`catalogXPathCompatible`,
  `catalogTimeOrdering` and `canonicalCasePropertyDefaults` deleted with the catalog slots, §2.3); every rule file of §2.2, `rules/displayConditions.ts`
  among them (its `hasUnavailableCaseRead` becomes admission, its shape rule reads the moved
  `displayConditionStartsWithNever`).
- Doc and copy: `lib/doc/userFacingErrors.ts`; `lib/doc/kindConversionCascade.ts` (comment);
  `lib/doc/caseOperationWriteTypes.ts` (reads Hidden opinions).
- Builder: `components/builder/shared/checkErrorPresentation.ts`; the four `CONNECT_EMPTY_XPATH`
  comments of §2.3 (`detail/appSettings/connectDraft.ts`, `detail/formSettings/LearnConfig.tsx`,
  `detail/formSettings/DeliverConfig.tsx`), rewritten in pull request 5. No `biome.json` change: the
  checker, its context and the entry supplies are all `lib/domain` (§1.3).
- Entry supplies: `lib/domain/entryDatumSupplies.ts` (part 05 §1.3), read through
  `context.ts::slotContext`.
- Parser: `lib/commcare/xpath/expressionAst.ts`, where pull request 6 parses `here()` into its arm
  in place of pull request 5's `unknown-function` issue (§3.6), with its cases in
  `lib/commcare/xpath/__tests__/`.
- Fuzz: `lib/commcare/__tests__/xformDocArbitrary.ts`.
- `CLAUDE.md`: `lib/domain/CLAUDE.md` ("Property types are derived facts": Hidden writers are typed
  writers; the `fieldValueType` paragraph, which now says the bind follows the destination and the
  data type follows inference), `lib/commcare/CLAUDE.md` (the validator's XPath sections, "Hidden
  fields carry one value source"), `lib/domain/expression/CLAUDE.md` (part 01), and
  `lib/codemirror/CLAUDE.md` (the linter's source, part 02). A contract sentence moves with the
  behaviour that makes it false: each `lib/codemirror/CLAUDE.md` sentence the linter's re-point onto
  `checkExpression` falsifies is rewritten in pull request 5, the shape, and the rest in pull request
  11, the builder.
- Public docs: `content/docs/` pages that list what a formula may compare (part 02 sweeps them for the
  new refusals: date and time, true or false, a repeat read from outside, a choice default, a device's
  day-only system dates). Each row lands with its rule (part 10, "Public docs that change"): the
  choice default in pull request 5, the true-or-false, repeat-read and hidden-value rows in pull
  request 6 (the hidden-value row also says that a fixed value saved into a property a choice
  question starts on must be one of its choices), the date-and-time and system-date rows in pull request 8, the results-row day in pull
  request 9. Wording that shows an answer stays out of the public docs: no surface offers `jr:itext`
  (part 02 §4.2; part 10).
- **Implementation correction, 2026-10-19**, files pull request 6 also changes:
  `lib/domain/expression/choiceValue.ts` (`selectAnswerTokens`, §4.3); `lib/domain/expressionSource.ts`
  (`prosePartTerm`, which the gate and the move preflight share, and `proseReadSlotRef`, §3.4);
  `lib/domain/expression/CLAUDE.md` (the rule sets and inference as they are);
  `lib/doc/incrementalValidationScope.ts` and `lib/doc/commitVerdicts.ts` (§6);
  `lib/doc/formSectionVerdicts.ts` (§3.4); `lib/commcare/validator/rules/caseOperations.ts`
  (`caseOperationError`, the `clock-lost` reason) and `rules/app.ts` (`APP_RULES` runs both writer
  rules under every scope); `lib/commcare/validator/index.ts` (the shared prose mapping);
  `lib/agent/authoring/queryExpressions.ts` and `printQueryExpression.ts` (the record dialect's
  `here()`, §3.6); `components/builder/shared/RuleFocusContext.tsx` and `expressionEditorSchemas.ts`
  (the `here` label); `components/preview/form/virtual/landingGuards.ts` (header);
  `lib/commcare/surface/entries/expressions-and-data.json` and
  `docs/research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md` (the `here` flip).

---

## 9. Tests

The boundary for a rule is the checker (pure, `lib/domain/expression/__tests__/typeChecker.test.ts`)
when the rule is a function of a tree and a context, and `runValidation` (pure,
`lib/commcare/validator/__tests__/`) when it is located at a carrier or crosses forms. Every refusal
sits beside the accepted neighbour that differs from it in one fact.

| Rule | File | Refusal | Accepted neighbour |
|---|---|---|---|
| time ordering | `typeChecker.test.ts`; `formLogicFindings.test.ts` | §3.1 | §3.1 |
| date against date and time | `typeChecker.test.ts` | `#form/d = now()`, `#form/dt < 5` | `date(now()) = #form/d`, `#form/dt < now()` |
| system date on a device | `typeChecker.test.ts` | a list filter `date_opened >= now()`; `date_opened = datetime-coerce('2026-01-01')`; a results row's `date_opened` against `now()` (pull request 9) | `date_opened >= datetime-coerce('2026-01-01')`; the same in a search-only slot; a results row's `last_modified > now()` |
| boolean against an answer | `typeChecker.test.ts` | `#form/consent = true()` | `#form/consent = 'yes'` |
| several values | `typeChecker.test.ts`; `formLogicFindings.test.ts` (a move) | `#form/rep/q = 'yes'` outside `rep`; `instance('selected_cases')/results/value = 'x'` | the same inside `rep`, `count(#form/rep/q)`, a `casedb` query used as one value, `count(instance('selected_cases')/results/value)` |
| finding 72 | `selectDefault.test.ts` | `'z'`, `'a z'` | `'a'`, `'a b'`, `''`, a lookup select's `'z'` |
| a literal written into a preloaded select's property | `selectPreloadWriterOptions.test.ts` | a Hidden Value's `'z'`, a case operation's `'z'`, `'a z'` into a multiple | `'a'`, `''`, `concat('a', '')`, `'a b'`, a lookup-backed or several-case-form reader |
| `here()` | `typeChecker.test.ts` | in a `calculate` | in a calculated column |
| `jr:choice-name`, `jr:itext` | `typeChecker.test.ts` | over a lookup select; a unit whose French text shows an answer | over an inline select; the same unit with plain text |
| Search answers | `formLogicFindings.test.ts` | `#search/x` in a follow-up | in the no-matches form |
| search results | `formLogicFindings.test.ts`, part 05's cases (through `runValidation`) | `SEARCH_RESULTS_NOT_SUPPLIED` with each reason; `SEARCH_RESULTS_READ_INVALID` for `[1]` over results and another `@case_type` | a count read in a search-first module's follow-up |
| datums | `sessionData.test.ts` (kept, re-pointed, through `runValidation`) | an unsupplied datum of each kind, with part 05 §1.6's sentence | a supplied one |
| the chosen case in record slots (pull request 10) | `sessionData.test.ts`; `typeChecker.test.ts` | a filter's chosen case after its parent selection is turned off; a module display condition reading one; a several-case menu | the filter while the selection passes through the menu; an advanced search input's predicate; a form display condition |
| record type-error details | `rules/case-list/__tests__/filterTypeCheck.test.ts` (extended) | a filter type error carries `checkCode` and, for `day-only-on-device`, `checkReason` | a type error with no reason carries no `checkReason` |
| target facts | `typeChecker.test.ts` | `closed_on` in a list filter; a microsecond literal; a computed pattern in a column | `closed_on` in the Search predicate; a millisecond literal; a computed pattern in a `calculate` |
| record positions | `typeChecker.test.ts` | `concat(eq(a, b))` | `concat(a, b)` |
| Hidden writer agreement | `hiddenValueWriterAgreement.test.ts` | A, C, `#form/a * 1.5` to `int` | D, `''` branch, `#form/a + 1` and `int(#form/n div 2)` to `int` |
| Hidden inference | `lib/domain/expression/__tests__/inference.test.ts` | a disagreement left unknown | a chain resolved, a cycle unknown, a writer's data type its destination's, a non-writer's `fieldValueType` `undefined` whatever its inferred type (so its bind stays `xsd:string`) |
| projections and classes | `lib/commcare/validator/__tests__/gate.test.ts` (exists) | each new code gates a commit | an unchanged document passes |
| copy | `components/builder/shared/__tests__/checkErrorPresentation.test.ts`, `lib/doc/__tests__/userFacingErrors.test.ts` (exist) | each new code and reason renders its own line | each existing code keeps its line |
| scale | `gateScale.test.ts` (kept) | the dangling leaf in the last form | the 3,000-field fixture clean |

**Implementation correction, 2026-10-19:** the `jr:choice-name` row's inline acceptance is pull
request 9's (§3.7); pull request 6's neighbour is the same read over an inline select refused with
reason `choice-name`. The select-preload row's `'a b'` and `1` neighbours assert only that rule's
absence (§4.3). Hidden inference adds clock loss (a copy of `now()` through Hidden Values, a branch
and a cycle lost, a text copy kept) and Hidden writer agreement its `clock-lost` refusal beside a
writer of `now()` itself admitted. The move rows run through `fieldPlacementVerdict` and
`mutationCommitVerdict` in `lib/doc/__tests__/formSectionVerdicts.test.ts`, and the inference
fallback through `lib/doc/__tests__/incrementalValidationScope.test.ts`'s scoped-against-absolute
parity.

The existing suites of every record rule (`rules/case-list/__tests__`, `rules/case-search/__tests__`,
`lookupOptionsSource.test.ts`, `caseOperations.test.ts`, `lib/domain/predicate/__tests__/typeChecker.test.ts`
moved to `expression/__tests__`) keep their assertions unchanged; that they pass unchanged, with the
corpus's finding multiset equal at base and head, is the proof that §1.4 and §2.2 moved no verdict.

---

## 10. How this part lands in the stack

The stack is fifteen pull requests in one `gh stack` chain, merged together in one deploy (part 10
holds it in full). The checker lands in five of them; the fifth, pull request 10, carries
`closed-on-not-on-device` and the chosen case in record slots (below). Each keeps the gate's
verdicts total at its head: an arm or operand step 3 adds or widens is admitted by a slot's profile
only in the pull request that also adds the rule narrowing it, so no intermediate head admits what
the stack head refuses.

1. **Pull request 5, the shape.** The checker's core: the one walk (`checkExpression`, `typeOf`),
   `ruleSets.ts` with the record rule set moved verbatim and the form rule set's rules 1 and 3,
   `context.ts` (`slotContext`, and `expressionFacts` over today's `effectiveCaseTypes`, §5.1),
   profile admission (§1.4) including entry supply (`datum-not-supplied` over identity, §3.9, so
   `rules/sessionData.ts` leaves here, with `DatumRef`, `lib/domain/entryDatumSupplies.ts`, the
   datum ids in `formLinkProjection.ts` and part 02's datum parse refusals; production's session
   reads lift onto identity at this head, and `targeted-session-reads` lands here too, so datum
   reads have lane evidence from the pull request that changes them, part 08 §4.5, the batch form's
   `selected_cases` read joining it in pull request 9; `input` outside a no-matches form, §3.8),
   the per-slot projection (§1.5) with `checkFormLogicSlot` and every record rule's `checkCode`
   (`checkErrorDetails`), and `record-position` (§3.11), which holds what the Zod families held.
   Today's rules moved (§2.1, §2.2): every record rule file on the one checker with its code
   (`rules/displayConditions.ts` among them), the time ordering's one rule (§3.1), `checkTypes`'
   rule, the catalog rules deleted with the catalog slots. The parse-issue codes (§2.3): the fifteen
   codes leave for part 02 §1.4's issues, with `CONNECT_EMPTY_XPATH` (and its four builder comments)
   and `CASE_PROPERTY_XPATH_INCOMPATIBLE`. `here()` keeps today's verdict through the parse (§3.6).
   Finding 72 (§3.5): `SELECT_DEFAULT_NOT_AN_OPTION`, its fuzz mapping (§7), and part 08's removal of
   its five walk stops. The proof that the move moved no verdict is the record rule suites passing
   unchanged and the corpus's finding multiset equal at base and head (§7, §9; part 08 §4.1).
2. **Pull request 6, the checker.** The other new refusals of §3, but the day rule and the
   search-results rules: §3.2's `date-datetime` and `datetime-ordering`, §3.3's `boolean`, §3.4's
   structural `many-values` (the repeat read and `selected-cases`), `here()` outside a row (§3.6,
   reason `here`, with the parse of `here()` into its arm in `expressionAst.ts` and the
   calculated-column profile's admission of it), §3.7's `choice-name-dynamic`, and §3.10's
   `datetime-literal-precision`, `format-date-pattern-not-fixed` and `number-of-date`. Writer
   agreement (§4, `HIDDEN_VALUE_WRITER_TYPE_MISMATCH`) with the select-preload writer rule (§4.3,
   `SELECT_PRELOAD_WRITE_NOT_AN_OPTION`), and inference (§5, `inference.ts::inferExpressionTypes`,
   replacing `WHOLE_EXPRESSION_TYPES`). Its corpus run at base and head (§7) decides §4.3's refused
   documents, and part 04's census names the bind changes inference causes (§5.2). The rules over
   reads that part 05 makes authorable (`selected-cases`, `jr:choice-name`) are pure
   `typeChecker.test.ts` cases here; their gate cases join in pull request 9, where profiles admit the
   reads.
   **Implementation correction, 2026-10-19:** inference replaces `inferHiddenWriterType` and
   `inferExpressionType`, `WHOLE_EXPRESSION_TYPES` having left in pull request 5 (decision 7), and
   computes held classes and clock loss (§5.1); writer agreement refuses a clock-lost write
   (`clock-lost`, §4.3); the record dialect gains `here()` with no `MODEL_CONTEXT_VERSION` bump and
   the surface flips `here` to `HELD` (§3.6); inline `choice-name` stays refused until pull request 9
   (§3.7); the scoped commit falls back on an inference change (§6); the move preflight checks prose
   and refuses with `expression-many-values` (§3.4). Its corpus run is §7's head-over-base runner,
   not a multiset of two emitted corpora.
3. **Pull request 8, the lowering**: the day rule, `day-only-on-device` over `date_opened` and
   `last_modified` read from `casedb` (§3.2, §3.10), beside finding 56's lowering, which is what makes
   a comparison of two moments sound, and whose day-aligned comparisons stay bare (part 04 §3.4).
   **Implementation correction, 2026-10-19:** with it, `incompatible-values` reason `clock-lost`, an
   implicit instant comparison with a clock-lost operand (§5.1), since the lowering is what makes
   such a comparison read NaN.
4. **Pull request 9, instances and session**: the day rule over search results rows (§3.2), where
   results rows first exist; the admission of `search-results` with part 05's
   `SEARCH_RESULTS_NOT_SUPPLIED` and this part's `SEARCH_RESULTS_READ_INVALID` with its two checker
   codes, its cases in `formLogicFindings.test.ts` (§3.8); and the other reads part 05 makes
   authorable, each with its declaration (part 04 §8.5); and §3.7's `itext-reference`, a new
   checker code whose rule reads `translationUnits.ts`'s `showsAnswer`, which lands with the
   `jr:itext` reads it governs, with its card-editor line (`checkErrorPresentation.ts` is a total
   `Record<CheckErrorCode, …>`, so the code and its line land together) and its
   `typeChecker.test.ts` cases.
5. **Pull request 10, CSQL**: `closed-on-not-on-device` (§3.10), with part 06's search-only table
   and its code, since no slot can read `closed_on` before that table exists (the record checker
   refuses it today as an unknown property); and the chosen case in record slots (§3.9): the
   admission of `chosen-case` and `chosen-case-property` in a form display condition, a case list
   filter and an advanced search input's predicate, checked against the rows supplied before each
   evaluates, with its `sessionData.test.ts` and `typeChecker.test.ts` cases.

The builder's card-editor lines (`checkErrorPresentation.ts`, §1.1) land with each code, because the
table is typed-total.

---

## Departures

- **A date and time ordered against what is not one is refused in form logic** (§3.2). Finding 56's
  requirement 4 in the outline refuses a date against a date and time; this part also refuses a date
  and time ordered against an operand known not to be one, because the lowering is defined only for
  an instant against an instant, and a bare `now() > 20000` orders days, the defect itself.
- **Every Hidden Value writer is held to its property's type** (§4.3). The outline holds a property a
  date field writes and reads back to the date type; this part holds every Hidden Value that writes a
  property to that property's type, whatever the type, because a typed question that preloads the
  property casts at form open for every bind type alike.

## Executed during planning

Five probes ran from the repo root with `node --conditions=react-server --import tsx`, reading Nova's
own modules at `main` `5cf6e327`, with no network, no paid call, no Docker and no repo file changed.
The corpus they read is the one the lane's emission writes at `main` (`proof/README.md`'s command):
371 documents, none refused.

- **Gate cost over the corpus**: `runValidation` and `validateBlueprintDeep` over every corpus
  document (min of three runs, fresh hydration each), with `parser.parse` wrapped to count Lezer
  parses. Result: 137 ms gate, 39 ms deep walk, 7,425 parses (12.2 per non-empty form-logic slot,
  2.0 µs each), slowest document `fuzz-suite-20260930-2` 3.1 ms (§6).
- **Gate cost at scale**: the same on `gateScale.test.ts`'s 3,000-field fixture (copied verbatim):
  5,040 slots, no findings, 270 ms gate, about 160 ms deep walk, 60,720 parses (12.0 per slot,
  108 ms); `effectiveCaseTypes` cold 0.9 ms (§6).
- **Checker cost per node**: today's `checkPredicate` / `checkValueExpression` over the corpus's 86
  case-list filters and calculated columns, 200 repetitions with a prebuilt context: 0.07 µs a node,
  0.5 µs a slot; `effectiveCaseTypes` cold over all documents 4.8 ms (§6).
- **Several values and booleans over the corpus** (with a check of the Lezer node names it relies
  on): reads of a repeat answer from outside its repeat in form-logic slots and prose parts,
  classified by position through the grammar, and `=` / `!=` between a boolean and a non-boolean.
  Result: 22 reads in 6 documents, all admitted (count 10, join 6, inside a predicate 6), none scalar,
  none in prose; no boolean comparison (§3.3, §3.4).
- **The Hidden-writer documents**: four documents built with `lib/__tests__/docHelpers.ts::buildDoc`,
  each run through `runValidation` and `effectiveCaseTypes`: a text Hidden writer and a Hidden copy of
  a text property, beside a date question that preloads the property, are admitted (§4.2); case C also
  shows `INVALID_CASE_REF` and `CASE_HASHTAG_ON_CREATE_FORM` firing together for one read on a
  registration form (§1.5).
- **Two production shape scans**, run with the person's permission: one read-only
  `REPEATABLE READ READ ONLY` transaction each, closed labels and counts only, every live app read,
  none unreadable, no scan failure. This part relies on their classes for date-and-time comparisons
  (§3.2), boolean comparisons (§3.3), several-value reads, case queries and uncatalogued reads (§3.4,
  §5.4), select defaults and option literals (§3.5), function reads (§3.6, §3.7), Search answers and
  `instance()` reads (§3.8), session datum reads (§3.9), writers and preloads (§4.2, §4.3), catalog
  XPath values (§2.1), empty expression slots (§2.1), and the `app_changes` suffix after the step 2
  fold baseline (§5.3). A class the scanner did not emit is a count of none; the scanner emits every
  class it meets.
- **The corpus shape scan**: the same classifier over the 371 corpus documents, for the one
  system-date ordering (§3.2, §7), the select defaults (§3.5, §7) and the untyped queries (§7).
- **Date-and-time literal precision over the corpus**: a text search of every `document.json` of the
  emitted corpus for an ISO date-and-time spelling with four or more fraction digits. Result: no
  document; the corpus holds four date-and-time spellings (`2026-04-17T14:23:41+03:00`,
  `2024-02-28T10:30:00Z`, twice each), none with a fraction (§3.10, §7). A search of stored text for a
  timestamp's spelling, not a reading of XPath structure.

Read at the pins for this part: commcare-core `Selection.java::attachChoice` (both overloads),
`QuestionDef.java::getChoiceForValue`, `::getChoices`, `FormEntryPrompt.java::getSelectItemText`,
`::getSpecialFormSelectItemText`, `FormDef.java::attachControlsToInstanceData` (the `attachChoice`
loop), `FormDef.java`'s `jr:choice-name` handler, `SelectOneData.java::cast`,
`SelectMultiData.java::cast`, `DateData.java::cast`, `Recalculate.java::wrapData`,
`SetValueAction.java::processAction` (the unpack and the cast), `XPathNodeset.java::unpack`,
`FunctionUtils.java::unpack`, `::toBoolean`, `::toNumeric`, `::toString`, `::toDate`,
`XPathDateFunc.java::evalBody`, `XPathEqExpr.java::evalRaw`, `XPathCmpExpr.java::evalRaw`,
`XPathArithExpr.java::evalRaw`, `XPathBoolExpr.java::evalRaw`, `XPathConditional.java::evalRaw`,
`::evalReadable`, and the node-set handling of `XPathCountFunc`, `XPathSumFunc`, `XPathMinFunc`,
`XPathMaxFunc`, `XPathConcatFunc`, `XPathJoinFunc`, `XPathJoinChunkFunc`, `XPathChecklistFunc`,
`XPathWeightedChecklistFunc`, `XPathPositionFunc`, `XPathDistinctValuesFunc`;
`org/commcare/cases/instance/CaseChildElement.java::buildAndCacheInternalTree` (`date_opened` and
`last_modified` set as `new DateData(…)`) and `org/javarosa/xform/parse/XFormParser.java::recurseForOutput`
and `::parseOutput` (an `<output>` stored as `"${" + parseOutput(kid) + "}"`); formplayer
`api/json/PromptToJson.java::parseQuestionAnswer`, `session/MenuSession.java::getEvalContextWithHereFuncHandler`,
`services/MenuSessionRunnerService.java::addHereFuncHandler`; commcare-android every
`HereFunctionHandler` registration (`tasks/EntityLoaderHelper.kt`, `fragments/EntityDetailFragment.java`,
`gis/EntityMapUtils.kt`, `activities/EntitySelectActivity.java`); commcare-hq
`corehq/ex-submodules/casexml/apps/case/xml/generator.py::CaseDBXMLGenerator` (inherits
`V2CaseXMLGenerator`), `::V2CaseXMLGenerator.add_custom_properties` (appends `date_opened` as
`date_to_xml_string(self.case.opened_on)`), `::date_to_xml_string` (returns `json_format_date`), and
`corehq/ex-submodules/dimagi/utils/parsing.py::json_format_date` (`ISO_DATE_FORMAT = '%Y-%m-%d'`).
Every checkout was searched for `attachChoice` and `HereFunctionHandler` readers; none was switched.
Read in Nova: `lib/commcare/xpath/compatibility.ts::analyzeXPathCompatibility` (which construct
raises each leaving code, §2.3), `lib/domain/predicate/typeChecker.ts`'s `double` arm
(`text-or-number-value`, §3.10), `lib/domain/standardCaseProperties.ts` (`date_opened`,
`last_modified` typed `datetime`).
