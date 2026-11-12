# Step 6, part 08: The reader: expressions

Part of step 6's plan, "Bringing an app in from CommCare HQ". This part plans how the reader turns every
expression an HQ app holds into Nova's typed `Expression`: the one recognition method and its closed
equivalence table, the hook that lets the form parser read HQ's spellings, the folds from wire spellings
to identity leaves and from Nova's lowerings back to the arms that write them, the port of HQ's text
interpolation, the reading of record slots, the reader of search filter rows (CSQL), what happens to
functions in record slots, the type check of every imported expression, and the finding each failure
becomes. It plans pull request B6 in full, and three files pull request B2 carries because the readers
of B3 to B5 call them before B6 lands: `syntaxCompare.ts`, `hqInterpolation.ts` and
`pendingExpressions.ts`. B6 also lands the code of three other parts that names a B6 export: part
06's `bindExpressions` and `expressionEnvOf`, part 07's search row files and part 11's
`worldEntities.ts` ("Files by pull request").

Other parts are cited by number, with the pull request beside the citation. Their files: part 01
(`01-the-bar-and-the-manifest.md`; A2, A3), part 03 (`03-questions-and-text.md`; A6 to A8), part 04
(`04-names.md`; A9), part 06 (`06-the-reader-forms.md`; B2, B3), part 07
(`07-the-reader-cases-menus-lists.md`; B4, B5), part 09 (`09-acceptance-and-the-first-publish.md`; B7),
part 10 (`10-identity-and-the-ledger.md`; B8), part 11 (`11-project-data.md`; B9), part 12
(`12-the-reading-and-the-birth.md`; B10), part 13 (`13-the-experience.md`; B11, B12), part 14
(`14-proof.md`; A1, B13) and part 15 (`15-stack-contracts-and-exit.md`; A10, A11, B14, B15). Every
seam with another part is stated under "What this part needs of other
parts", as that part writes it.

Citations are `path::symbol`. Nova is read at `main` `15a00a97`; the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every
CommCare fact below was read at those commits for this part. HQ paths are relative to
`corehq/apps/app_manager/` unless they start with another app's name; Core paths are relative to
`src/main/java/org/javarosa/xpath/`.

Versions at `15a00a97`: `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.14"` and
`lib/db/appTests.ts::RUNTIME_VERSION` is `18`. B6 lets the record dialect print and keep one spelling
it could not show (section 8.3), and the guide gains the sentence that says what it is, so B6 sets
`MODEL_CONTEXT_VERSION` to `"v7-hq-round-trip-bring-in.b6"`, from the value stack A deploys: the
literal moves in each pull request that changes a served tool or the guide, each to its own pull
request id (`../6-bring-in.md`, "What changed from the outline, and why", item 26; part 15, section
1.3), and no pull request of B1 to B5 moves it. No tool input schema changes, so B6 adds no
`scripts/test-schema.ts` entry; stack B's one billed check is part 13's run E1, asked once at B12's
head. B6 does not move `RUNTIME_VERSION`, which A9 leaves at `19` (part 04, section 3.4): no stored
document changes shape.

| Section | Owns | Pull request |
|---|---|---|
| 2 | the recognition method, its two acceptance levels, the order of work over a whole app | B6 |
| 3 | the closed equivalence table and the local-name maps | B2 (the file, rows L1 to L6), B6 (S1, S2, run E1) |
| 4 | the reading hook in `parseFormExpression`: what the parser needs and how the reader supplies it | B6 |
| 5 | the folds: identity leaves, and every lowering read back | B6 |
| 6 | HQ's interpolation as a lexer, and the reading of record slots | B2 (the port), B6 |
| 7 | search filter rows: the CSQL reader, the day rules, rows as one conjunction | B6 |
| 8 | functions in record slots, row by row; the one record spelling kept; the dialect round trip | B6 |
| 9 | types: `checkExpression` over every slot, and the entry each refusal claims | B6 |
| 10 | what this part supplies to the form and list readers, and what stays theirs | B2, B6 |
| 11 | manifest edits by entry id | B6 |

---

## Decisions in brief

1. **One method recognizes everything: bind, print with the production printer, compare syntax trees**
   (2.1). The reader binds HQ's text to a candidate `Expression`, prints the candidate for that slot with
   `toWire` and `serializeWire`, reads the print back with `readFormSyntax`, and holds the candidate only
   when the two syntax trees are equal under the table of section 3. No recognizer matches text.
2. **No text to `WireExpr` path is built** (2.2). Both sides of the comparison are text at the boundary,
   so both go through the one grammar. This puts the serializer (literal protection, `./.`, grouping,
   number spelling) inside the proof, which a `WireExpr` comparison would leave out.
3. **Two acceptance levels** (2.3). Exact: Nova's print equals the source. Up to named rewrites: Nova's
   print equals the source once the emitter withholds a closed set of rewrites (the expression entries
   of `EMISSION_REWRITES`), and each one that changes behavior is reported for the first-publish
   register. Anything else is the circumstance `unrecognized`.
4. **Folds are proposals, withdrawn where they do not re-emit** (2.4). Every fold is tried first. Where
   the print differs, the fold whose source span holds the first differing node is withdrawn and the app
   is bound again, until the print is equal or no fold is left there.
5. **Expressions are read last, over the whole app at once** (2.5). The structure, case management and
   menu readers register each expression as text; B6 binds them all against the finished structure,
   because one Hidden Value's type decides how another slot's comparison prints. Every round of the
   work builds a new document object, since every typing fact is cached per document.
6. **The equivalence table is closed at eight rows** (3): whitespace, parentheses, quote marks, number
   spelling, the three axis abbreviations, `./.` for `.` in a predicate, `cond` as nested `if` in a
   record slot, and `name` for `case_name` on a case row (the last decided by run E1). Each has a native
   vector.
7. **Three local names are mapped, not compared** (3.3): a form's instance ids by the source each
   declares, its itext ids by the text unit each names, and a form node by the name its own source
   gave it, under which Nova's side is printed too.
8. **The form parser gains one optional hook, `FormParseScope.reading`** (4). With it the parser admits
   only the functions Core answers, refuses every hashtag, resolves HQ's itext ids, instance ids and
   generated nodes, and asks the reader's folds before it binds a node. Without it the parser is
   unchanged.
9. **A casedb read keyed on the form's own case is `form-case`, and a default that is exactly one is a
   preload** (5.2). The usercase selector is the worker-record leaf. Both are folds accepted by print.
10. **Every lowering Nova's emitter writes is read back as the arm that writes it** (5.3): the instant
    comparison and each operand form, the count guards, the search text arm, the empty-row guards in
    each of their three shapes, `is-blank`, `normalize-space`, and in record slots `quotient`,
    `date-add`, `in`, `between`, `switch`, `when-input-present`, `cond` as `if`, and the relation arms.
    A date or a date and time written as a string in a record slot reads as the typed literal Nova
    stores (5.1), since both print the same bytes and only the typed one passes the checker.
11. **HQ's interpolation is ported as the string replacement and character scanner it is** (6.1), run
    on HQ's text and on Nova's own HQ print before either is parsed. It is no regex over XPath: it finds
    no structure, and the grammar reads its output.
12. **Record slots are read by the same parser under the slot's own context** (6.2). There is no second
    binder: a record slot differs in its context (a case, table or no row), in `current()` naming the
    row, and in the folds it is offered.
13. **`#parent` reads as a relation read; `#host` stays not-yet** (6.3). The casedb join HQ writes for
    `#parent` is what `prop` with an `ancestor` path prints, so the fold is accepted by print. Nova's
    own print of any other index adds a case type test HQ's `#host` does not have, and the checker
    refuses the step without a type, so `#host/p` claims the slot's HELD-NEW entry.
14. **A search filter row is read through its CSQL skeleton** (7.1 to 7.3): the on-device wrapper is
    reduced to CSQL text with holes, the text is parsed with the same grammar, and the candidate is held
    when Nova's wrapper equals the source, or when the CSQL and its holes are equal and only Nova's
    guards differ (the rewrite `search-value-guards`).
15. **A date compared with `date_opened`, `closed_on` or `last_modified` in a search stays not-yet**
    (7.5). HQ reads it as the project space's day; no read gives Nova that time zone, so Preview and
    Postgres could not evaluate what the document would hold.
16. **HQ's server-side `today()` reads as Nova's `today`, and the first publish says so** (7.5). Nova's
    search sends the worker's day; the rewrite `search-today-device-day` declares the change.
17. **Several `_xpath_query` rows are one conjunction** (7.6). B6 holds the reader of one row and the
    matcher of a proposed case list against the rows; part 07's `settleSearches`, which lands in B6
    with them, places each conjunct. The case list filter's own text is compared with the
    production filter projection, which drops boolean identities and every clause that reads a
    Search field (2.1, 5.5).
18. **`call` stays out of record slots in step 6, for every function** (8.1). A record arm needs a
    builder card, a record spelling and, for a list's filter and columns, a Postgres compilation proven
    against Core. `cond` alone is read, as the nested `if` it equals.
19. **`value-list` gains a record spelling that is read and kept, `list(...)`; the other held reads
    become not-yet** (8.3). `printQueryExpression.ts::queryPrinter` throws on them today, so an app
    holding one would break every agent read of it. No editor authors a new list: the builder's card is
    display only, so the dialect admits `list(...)` only where the slot already stores that list.
20. **No record slot is held that the record dialect cannot print and read back** (2.5, step 6). The
    reader is handed the dialect's round trip as a function and makes a slot that fails it not-yet.
21. **Every imported expression passes `checkExpression` under its slot's profile** (9.1), over the final
    document, with the two display-condition rules the validator holds outside the checker. A refusal
    is a finding at the slot, under the entry section 9.2 gives for its code.
22. **Three new REFUSED entries and four new HELD-NEW entries name what no entry named** (11): a session
    value the entry does not supply, an expression that reads what is not there, a search test that
    reads the case; a form expression outside what Nova types, a search value that queries cases, a
    table or places, a search test outside what Nova types, and a search filter outside what Nova types.
    Where no entry already names a refusal, what CommCare runs and Nova's checker narrows is not-yet,
    never "fix in CommCare HQ"; the manifest's own REFUSED rows (a time ordered, which Core answers
    false every time) keep their standing.
23. **The `vellum:` shadow check and the whitespace outputs are part 06's** (10.1, 10.2). B3 compares a
    shadow with its real attribute and reads Nova's literal outputs as text, by its own sections 14 and
    12.3; B6 reads the real attribute.
24. **B6 mints no entity.** Expressions hold identities other modules minted; the catalog entries B6
    adds for case properties an app only reads are keyed by name. The worker properties and location
    properties an app reads are learned from a first run of the reader and minted by the frame with
    part 11's `worldEntitiesFromReads` (`lib/commcare/reader/worldEntities.ts`, which B6 lands) before
    the run that counts (2.5).

---

## Executed during planning

Read, by `file::symbol` group. Nothing was run but `rg`, file reads and three `python3` passes over the
manifest JSON and over the four apps under CommCare HQ's `template_apps/`: its three starter apps
and `wash_before_cond_case_update`, a second copy of `wash` that part 14 counts as no base.

**Nova, expressions.** `lib/domain/expression/types.ts` (whole); `profiles.ts` (whole);
`context.ts::slotContext`, `::ExpressionContext`, `::RowScope`, `::ExpressionFacts`;
`ruleSets.ts::typesCompatible`, `::isValueStorageAssignable`, `::ORDERED_TYPES`;
`typeChecker.ts::CheckErrorCode`, `::CheckError`, the arm admission block (`arm-unavailable`), the
`arith` and `negate` typing, `HELD_SEARCH_READ_KINDS`, `::chosenCaseCarrier`;
`csqlPositions.ts` (header and exports); `searchRuntimeValues.ts` (whole); `CLAUDE.md` of
`lib/domain` and `lib/domain/expression`. `typeChecker.ts`, `inference.ts` and `instantOperand.ts` were
read only in the symbols cited.

**Nova, the parser and the wire.** `lib/commcare/xpath/grammar.lezer.grammar` (whole); `formSyntax.ts`
(whole); `expressionAst.ts::parseFormExpression` (whole); `formPathBinding.ts::bindFormPath`,
`::instancePath`, `::rowValue` (whole); `formParseScope.ts`; `formPrintContext.ts`; `formParseIssues.ts`;
`referenceBindings.ts::formUserProperty`; `formNodeProjection.ts::formNodeProjection`;
`functionCapabilities.ts` (exports); `wire/tree.ts`; `wire/fromExpression.ts::toWire`, `::term`,
`::lowerExpression`, `::emitCall`, `::compareSides`, `::count`, `::metersBound`;
`wire/emptyRows.ts::emptiableRows`, `::guardRead`, `::guardAbsentNode`, `::guardValue`;
`wire/serialize.ts::literalPieces`, `::literalTokens`, `::printLiteral`;
`wire/__tests__/instantParse.ts`; `xform/formCaseRead.ts::formCasePropertyRead`; `usercaseWire.ts`;
`hashtags.ts`; `hqJson/xpath.ts`; the `hqXPath` call sites of `hqJson/caseList.ts` and `expander.ts`;
`CLAUDE.md` of `lib/commcare`, `lib/commcare/xpath` and `lib/commcare/xpath/wire`.

**Nova, CSQL and its consumers.** `lib/commcare/csql/tree.ts` (whole); `print.ts` (whole);
`emitter.ts::membership`, `::valueList`, `::runtimeHole` and its exports;
`suite/case-search/xpathQuery.ts::composeXPathQueryEmission`, `::composeXPathQueryClauses`,
`::xpathQueryRequestValues`; `lib/agent/authoring/printQueryExpression.ts::queryPrinter` (the value and
predicate switches); `queryExpressions.ts` (exports); `lib/case-store/sql/compileExpression.ts` (the arms
it throws on); `components/builder/shared/expressionEditorSchemas.ts::CardValueKind`,
`::isAuthorableExpressionKind`; `components/builder/CLAUDE.md`, "Cards dispatch on syntax".

**The manifest.** `lib/commcare/surface/entries/expressions-and-data.json` (all 183 entries listed, the
cells of the 50 this part claims read); `case-search.json` (all listed, 30 cells read); the
expression-bearing entries of `menus-and-case-lists.json`, `forms-and-case-writes.json` and
`questions.json`.

**CommCare HQ.** `xpath.py::interpolate_xpath`, `::dot_interpolate`, `::_ensure_no_case_references`,
`::session_var`, `::XPath`, `::CaseSelectionXPath`, `::CaseIDXPath`, `::CaseTypeXpath`,
`::UsercaseXPath`, `::CaseXPath`, `DOT_INTERPOLATE_PATTERN`; every caller of the two functions:
`suite_xml/sections/menus.py::MenuContributor._get_commands` and the menu relevancy block above it,
`suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`,
`suite_xml/post_process/remote_requests.py` (the `required` and `validations` tests),
`suite_xml/sections/details.py` (the tab nodeset filter), `models/modules.py` (the module filter),
`models/case_list.py::MappingItem.key_as_condition`, `helpers/validators.py` (the form filter check);
`app_schemas/casedb_schema.py::get_casedb_schema`, `::_get_case_schema_subsets`;
`corehq/apps/case_search/xpath_functions/__init__.py` (`XPATH_VALUE_FUNCTIONS`,
`XPATH_QUERY_FUNCTIONS`); `xpath_functions/comparison.py` (whole);
`xpath_functions/value_functions.py::today`, `::unwrap_list`, `::_get_timedelta`;
`case_search/dsl_utils.py::unwrap_value`; `case_search/const.py::INDEXED_METADATA_BY_KEY`;
`static/app_manager/template_apps/*/app.json` (every filter, calculated column, sort calculation, display
condition, link condition and search row of the four apps, and every function their forms call).
Lifecycle of the HQ fields this part couples to: `module_filter`, `form_filter`,
`case_details.short.filter`, `DetailColumn.field` with `useXpathExpression`,
`search_config.default_properties[]`, `properties[].required.test`, `properties[].validations[].test`:
all alive. `fixture_select` (the `$fixture_value` replacement) is retiring and its entry is refused.

**Commcare Core.** `parser/Lexer.java::lex`, `::matchNumeric`, `::matchNCName`;
`expr/FunctionUtils.java::toBoolean`, `::toDouble`, `::toNumeric`, `::toInt`, `::toString`,
`::normalizeCase`; `expr/XPathCondFunc.java::evalBody`; `expr/XPathSubstrFunc.java::substring`; the
`evalBody` of `XPathIntFunc`, `XPathRoundFunc`, `XPathStringLengthFunc`, `XPathLowerCaseFunc`,
`XPathContainsFunc`, `XPathEndsWithFunc`, `XPathJoinFunc`, `XPathCountSelectedFunc`.

**Vellum.** `src/form.js` (the default hashtag transforms and `inferHashtags`); `src/datasources.js`
(`builders.hashtags`, `builders.hashtagTransforms`); `src/writer.js` (the head elements
`vellum:hashtags` and `vellum:hashtagTransforms`); `src/parser.js` (`initHashtags`'s call).

**Read again at source, for the lowerings, the literal rules, the dialect and HQ's entry datums.**
`wire/formReads.ts` (whole); `wire/emptyRows.ts` (whole);
`wire/instant.ts::leafText`, `::operandText`, `::typedDateMidnight`, `::coercedTextInstant`,
`::epochDayMidnight`, `::datetimeCoerceValue`; `wire/rowScope.ts::caseById`,
`::buildAncestorJoinNodeset`; `wire/serialize.ts::literalPieces`, `::literalTokens`, `::printLiteral`;
`fromExpression.ts::WireBuildContext`, `::emitCall`, `NODE_SET_ARGUMENT`;
`hqJson/caseList.ts::projectCaseListFilter`; `suite/case-list/nodesetFilter.ts` (whole);
`lib/domain/expression/walk.ts::substituteUnansweredSearchInputs`; `simplify.ts` (exports);
`ruleSets.ts::literalType`, `::literalShape`; `typeChecker.ts::formLiteralsShaped` and the record
comparison and `between` checks; `relationDestination.ts` (the `ancestor` arm);
`instantOperand.ts::literalInstantMicros`, `::literalInstantText`;
`lib/domain/referenceSlots.ts::rewriteExpressionSlotValues`; `formPathBinding.ts` (the hashtag branch,
the `self` and `parent` axis branch, `name`); `formSyntax.ts` (`AttrSpecified`, `AxisSpecified`);
`formParseIssues.ts` (whole); `referenceBindings.ts::formUserProperty`;
`lib/commcare/csql/emitter.ts::runtimeHole`, `::termValue`; `csql/print.ts::hole`;
`csql/representability.ts` (`value-list-placement`);
`lib/commcare/validator/rules/displayConditions.ts` (the two rules beside the checker);
`lib/agent/authoring/printQueryExpression.ts` (every throw), `queryExpressions.ts::QueryBindings`,
`reference.ts` (the record functions); `biome.json` (the consumers of `lib/commcare`);
`docs/testing.md` ("Read coverage follows the app"); `proof/native/test_hq_interpolation.py` (whole);
HQ's `suite_xml/sections/entries.py::EntriesHelper.get_case_session_var_for_form`,
`::get_case_datums_meta_for_form`, and `case_search/xpath_functions/value_functions.py::today` again.
Parts 06, 07, 11 and 12 as written, in the sections that name this part.

**Read at source for the seams with the other parts.** Parts 01, 03, 04, 06, 07, 09, 11, 12, 13 and 14
as written, in the sections this part cites. `lib/domain/expression/types.ts::SlotContextRef` (every
slot name of 9.2's code); `hqJson/caseList.ts::projectCaseListFilter` (private today);
`csql/emitter.ts::CsqlEmissionContext` (`Omit<WireBuildContext, "target">`);
`hqJson/xpath.ts::HqInterpolation`; `expressionAst.ts::parseFormExpression` (the `true` and `false`
calls bind to `match-all` and `match-none`); HQ's `models/case_list.py::MappingItem.key_as_condition`
(its one call is `dot_interpolate(self.key, property)`); and, in
`lib/commcare/surface/entries/*.json`, every entry id this part names (each exists but M1 to M7 and
part 04's N7), every `jr-fn:`, `jr-handler:`, `session-path:`, `instance-scheme:` and `csql-` key
with the entries and value classes that hold it, and the two entries of
`xform:model/bind@required`.

Claims of the outline and of Nova's code found false or unproven, and facts verified at source that
this part rests on:

- **Verified at source (a parsed text has no `WireExpr`).** `readFormSyntax` gives a
  `FormSyntax`, and `WireExpr` holds what no text states (an `expansion` wrapper, an `InstanceDecl`
  object, shared nodes, suite-only variable arms). So the method is not parse, candidate, `toWire`
  and structural equality with a parsed `WireExpr`: the comparison is made between two `FormSyntax`
  trees, the source's and the reparsed print (2.2).
- **Claim corrected (outline item 8, "the union holds `value-list` and those reads, and
  the checker, the emitter, Preview's fold and Postgres handle them").** One reader of the union does
  not: `lib/agent/authoring/printQueryExpression.ts::queryPrinter` throws "The saved … tree has no record
  value spelling" for `value-list`, `cases`, `table-rows`, `locations`, `selected-cases`, `call` and a
  `project` that is not a chosen case's property, and its comment sends their read-back to this step.
  `lib/agent/authoring/output.ts` prints every expression of a module for the Solutions Architect and
  MCP, so a document holding one could not be read by an agent (8.3).
- **Claim corrected (outline item 8, fourth bullet, "Postgres compiles none of `call`'s functions in
  step 3" as the whole cost of `call` in a record slot).** The checker also refuses the arm in every
  record slot (`typeChecker.ts`, `arm-unavailable` with the arm's kind as its reason), the builder has
  no card for it (`expressionEditorSchemas.ts::CardValueKind` excludes `call`), and the record dialect
  has no spelling. It is an authoring feature, not a compiler addition (8.1).
- **Verified at source (what `#case/` expands to).** The forms HQ's form builder writes with its data
  sources loaded expand `#case/` over the case path
  `app_schemas/casedb_schema.py::get_casedb_schema` gives, `/casedb/case`. Vellum's own default
  transforms (`form.js`, used only to guess a hashtag for a form saved before head metadata existed)
  spell the root `/cases/case`, so they are not what such a form holds. The reader expands a shadow
  only from the form's own head metadata (10.1) and never from those defaults.
- **Verified at source (HQ's `today()` in a search, which outline item 8 does not name).** HQ's
  search has its own `today` (`XPATH_VALUE_FUNCTIONS`, `value_functions.py::today`), the project
  space's day, beside the device's. Nova's union has one `today` and its search sends the device's
  (`lib/domain/expression/searchRuntimeValues.ts`). The two differ, and section 7.5 decides what the
  reader does.
- **Claim corrected (lib/commcare/xpath/formPathBinding.ts::rowValue).** The binder reads a case row's
  `name` step as the property `case_name` and prints `case_name`. Whether Core's casedb answers `name`
  was not established at source; run E1 decides the row.
- **Claim corrected (outline item 8, "an integer opposite a lowered operand is … read back as
  its `…Z` spelling" through `literalInstantText`).** `instantOperand.ts::literalInstantText(text)`
  reprints a literal's own text and takes no microseconds; nothing turns microseconds into text today.
  B6 adds that inverse (5.3).
- **Verified at source (`proof/native/test_hq_interpolation.py`).** That test holds that HQ's helpers
  leave Nova's protected literals unchanged; its own `limits` line says so. It does not yet hold that
  Nova's HQ print interpolates to Nova's suite print: run E2 gains the case (6.1).
- **Verified at source (a hashtag in a real attribute).** `formPathBinding.ts::bindFormPath` binds
  `#form/<path>` with no authoring scope, so the parser as it stands does not refuse a hashtag in a
  real attribute. The reading hook refuses it (4.2).
- **Verified at source (`self::node()` and `parent::node()`).** `bindFormPath` binds both in a form
  path (its `self` and `parent` axis branch, over the call `node()`), and Nova prints `.` and `..`, so
  those two pairs of row L5 are live and reach the comparison. `formSyntax.ts` reads `@a` and
  `attribute::a` as one node, and a row's path (`formPathBinding.ts::name`) refuses every axis but
  `child` and `attribute` (3.2, 9.2).

---

## Written and not yet run

Each run names where it runs, every outcome, and exactly what lands. None runs on the laptop: the native
runs are the proof lane's, on hosted runners, in B6's own CI run (the `expression` and `csql` families
run with the new tests); the Vitest runs are ordinary CI.

**E1: the equivalence table, natively.** Where: the lane's native family `expression`, new test
`proof/native/core/ReaderSpellingRuntimeTest.java` (registered in `proof/native/families.py` under
`expression`), fed by `lib/commcare/reader/expressions/__tests__/spellingVectors.ts` (section 3.2
lists the vectors). The test and its vectors land in B6 for all eight rows; from B2 to B6 rows L1 to
L6 are held by `syntaxCompare.test.ts` alone, and nothing calls the reader in production before
B10. For each row it parses both spellings with Core's `XPathParseTool.parseXPath` and evaluates
both over the row's instance, in every device zone the family runs.
- A, every row agrees: the table stands as written.
- B, a lexical row (L1 to L6) differs for a vector: that vector's class leaves the row's rule in
  `syntaxCompare.ts` (the rule is narrowed to what agreed), the vector is kept as a negative control, and
  an expression using the spelling reads as `unrecognized`. B6 records the row and the finding in the
  closing paragraph "Gated runs that write here" under "Found while planning step 6" in
  `docs/research/2026-09-26-hq-round-trip/harness-findings.md`.
- C, `cond` and nested `if` differ (S1): the row and the `cond` fold of 5.3 are removed, a record slot
  holding `cond` then binds as a `call` and claims the slot's HELD-NEW entry of section 9.2 with
  `detail.reason` `"call:cond"`, and section 8.2's sentence about `cond` leaves the docs edit. B6
  writes the outcome into the bullet "A function call in a record slot is more than a Postgres
  compiler" under the same heading, which names this run.
- D, the casedb `name` step: where it reads the case's name on Core, S2 stands; where it reads blank or
  throws, S2 is removed, `rowValue`'s alias is switched off under the reading hook (section 4.2, the
  option `caseNameAlias: false`), and a `name` step binds the property named `name`. Where it reads
  blank or throws, B6 records it in "Gated runs that write here" with what the reader then binds.

Outcome A writes nothing there, and no other run of this part does (part 15,
`15-stack-contracts-and-exit.md`, sections 1.4 and 8.1).

**E2: HQ's interpolation, by HQ.** Where: the lane's native proofs,
`proof/native/test_hq_interpolation.py`, which already calls the pinned
`xpath.py::interpolate_xpath` and `::dot_interpolate` over Nova's prints. It gains two cases, in B6
(the port itself lands in B2, held until then by `hqInterpolation.test.ts` over HQ's retained
answers). The first runs both helpers over the reader's vectors, which the producer
`proof/native/producers/emit-expression-evidence.ts` writes from
`lib/commcare/reader/__tests__/interpolationVectors.ts` together with the port's own answer for
each. The second takes, for each interpolating slot of the table in 6.1, Nova's `hq-json` print of
one corpus expression that reads the case (a property of it, and a property of its parent) with the
`caseXPath` the emitter's entry gives, runs HQ's helper over it, and requires the tree of the answer
to equal the tree of Nova's `suite` print of the same expression. The test's `limits` line is
rewritten to say what it then holds.
- A, the port answers every vector as HQ does, and every interpolated print equals its suite print:
  nothing more lands.
- B, a vector differs: the port in `hqInterpolation.ts` is corrected to HQ's bytes in B6 and the vector
  kept. No other file changes.
- C, an interpolated print differs from its suite print: the two emitters disagree, which is a defect
  of the emitter and no reader's. It is fixed in `hqJson/` or `suite/` in B6 with the vector kept, and
  B6 does not merge with it open, because step 4 of the method compares in the suite's terms.

**E3: CSQL read by HQ's parser.** Where: the lane's native family `csql`, new test
`proof/native/test_csql_reader_parity.py`: each CSQL text of
`lib/commcare/reader/expressions/__tests__/csqlVectors.ts` is parsed by HQ's `eulxml` parser and built by
`case_search/filter_dsl.py::build_filter_from_xpath`, and the outcome (built, or the error class) is
compared with what `csqlRead.ts::readSearchFilterRow` answers for the same text.
- A, every text HQ builds is one the reader holds or refuses under a manifest entry, and every text HQ
  refuses is refused by the reader under a REFUSED entry: nothing more lands.
- B, HQ refuses a text the reader holds: the reader gains the refusal under
  `case-search/a-function-on-the-left-side-a-property-on-the-right-side` (or the unparenthesized entry
  where the text is that shape), in B6, with the vector kept.
- C, HQ builds a text the reader refuses as unreadable: where an arm of the union holds the shape, the
  binder of section 7.3 gains it in B6; where none does, the row claims `unrecognized`, which is logged
  for classification, and the vector is kept with that expectation.

**E4: a default's absolute read and its `current()` spelling.** Where: the native family `expression`,
new cases in `proof/native/core/RowPredicateCurrentRuntimeTest.java`: a setvalue at `xforms-ready` and
one at `jr-insert` inside a repeat, each reading another question once by absolute path and once by
`current()/…`, over one, two and three repeat entries.
- A, both spellings read the same value in every case: `EMISSION_REWRITES["default-reads-current"]`
  carries `behavior: "none"` and the first-publish register leaves it out.
- B, they differ in some case: the entry carries `behavior: "changes"` and `touchesWorkers: true`, the
  sentence C5 of the Copy section ships, and B7's register declares it.

The same file already holds the row-predicate case behind `row-predicate-current`: an absolute read
inside a row predicate, in a repeat, is refused by Core or read as the entry its reference cache
resolved first (`lib/commcare/xpath/wire/CLAUDE.md`, "Reads of rows that may be empty", last
paragraph). C4's "before" clause states those two outcomes.

**E5: the read-back property over Nova's own fuzz corpora.** Where: ordinary CI, Vitest,
`lib/commcare/reader/expressions/__tests__/expressionReadBack.fuzz.test.ts` (section "Tests").
- A, every sampled slot reads back as its canonical tree: nothing more lands.
- B, a slot reads back as a different tree whose print is byte-equal: the difference is a print
  collision, and its pair joins `PRINT_COLLISIONS` (section 5.5) with a case in
  `printCollisions.test.ts` that prints both trees and requires equal bytes.
- C, a slot's print is not reproduced (the reader reports `unrecognized` for Nova's own emission): the
  emitter writes a lowering no fold reads. The fold is added to `folds.ts` in B6; B6 does not merge with
  this outcome open.
- D, a slot Nova emits is read and then refused by the checker or by the dialect round trip (2.5, steps
  5 and 6): the reader lost a fact the stored tree held (a literal's type, an identity). The fold or
  the canonical row that keeps it is added in B6; B6 does not merge with this outcome open.
- E, the document `readExpressions` returns raises a validator finding located at an expression slot
  B6 filled, which no claim reported (`gateCoverage.test.ts`, over the same corpora and the starter
  bases): the rule behind the finding is added to section 9.1 with the claim it makes, by 9.1's rule
  for a refusal outside the checker (the slot is not held and claims its default of 9.2 with
  `detail.reason` `validator:<code>`), in B6; B6 does not merge with this outcome open.

**E6: the starter apps' expressions.** Where: the proof lane, B13's HQ-authored bases `starter-health`,
`starter-agriculture` and `starter-wash` (part 14, section 6.2), on hosted runners, inside part 14's
P2 dispatch on B13's branch. This part predicts, from the apps' source:
the health app's case list filter `(referral ='Yes' or referral_anyway = 'yes_refer_now') and
had_referral_checkup != 1` is held (its property is written by two Hidden Values that give whole
numbers); the wash app's two calculated columns are read by the `cond` fold (5.3) as nested `if`,
compared under S1, and then judged by the checker, where `cut_water = 1` compares a property a choice
question and a Hidden Value both write.
- A, a base's expressions all read: its `expected.json` holds no expression finding.
- B, an expression is refused by the checker: stack B does not merge with it. B6 widens the record
  rule set to that expression, with the starter as the widened class's exhibit, and E6 runs again
  inside P2. Where the expression needs a domain concept no stack A pull request built, nothing
  merges and the person is told, with the finding and the starter's place (part 14, P2 outcome D).
  No rule is loosened to make a base read: a widening is the rule set's own, for every author, and
  never a leniency of the reader (8.1).

**E7: the billed schema check.** B6 changes no tool input schema, so nothing is sent for it. Stack B's
one billed check is part 13's run E1 (B12), asked of the person once at B12's head; this part runs
nothing.

---
## 1. What Nova does today

**One stored tree, three printers, one text parser.** Every expression slot stores the `Expression`
union (`lib/domain/expression/types.ts::expressionSchema`). `lib/domain/expression/context.ts::slotContext`
gives each slot its profile: the rule set (`form` or `record`), the targets that evaluate it, the row in
scope and what the entry supplies. The form rule set covers a question's `relevant`, `validate`,
`required`, `calculate`, `default_value`, `repeat_count` and `ids_query`, a form's open and close
conditions, its link conditions and carried values, and its Connect expressions. The record rule set
covers a choice list's row filter, a form's and a menu's display condition, every case operation slot,
the case list filter, a calculated column, and every search slot.

**The wire.** `lib/commcare/xpath/wire/fromExpression.ts::toWire` lowers a tree to a `WireExpr` under
the slot's context, and `wire/serialize.ts::serializeWire` prints it in one of five modes (`xform`,
`vellum`, `suite`, `hq-json`, `preview`). HQ JSON carries an interpolation mode per slot
(`hqJson/xpath.ts::hqXPath`): `case` for the case list filter and a case-loading form's display
condition, `no-case` for a menu's display condition, any other form's and a search field's required
test, `no-dots` for a search field's validation test, `enum-key` for an image map's key, and `none`
elsewhere. The printer protects a literal from HQ's replacements by splitting it into `concat` pieces
(`serialize.ts::literalPieces`, `::literalTokens`).

**Lowerings.** `toWire` writes, with no stored trace: a comparison of two dates and times as integer
microseconds (`wire/instant.ts::instantMicros`, chosen by
`lib/domain/expression/instantOperand.ts::comparisonPlan`); a value read of a data-built instance under
`if(count(<rows>) > 0, <read>, '')` (`wire/emptyRows.ts::guardValue`); `window_width`, `applanguage` and
the case list's search text under a count guard (`::guardAbsentNode`); a form read inside a row
predicate as `current()/<relative>` (`wire/formReads.ts::formReadToWire`); `is-blank` as
`string-length(string(x)) = 0`; `normalize-space` as two `replace` calls; `quotient` as an `if`;
`date-add` as `date(floor(base + scaled))`; `in` as an `or` of equalities; `between` as an `and` of
orderings; `switch` as nested `if`; `when-input-present` as `if(count(<input>), <clause>, true())`; a
relation's presence as a guarded `selected(join(...))` (`wire/rowScope.ts::immediateRelationPresence`);
the form's own case as a casedb walk keyed on a session datum
(`xform/formCaseRead.ts::formCasePropertyRead`); the worker's record as the usercase selector
(`usercaseWire.ts::USERCASE_CASE_SELECTOR`).

**Search rows.** A search's `_xpath_query` rows are built as a `CsqlNode` tree
(`lib/commcare/csql/emitter.ts::emitCsql`) and wrapped as on-device XPath that evaluates to the CSQL
string (`csql/print.ts::csqlClauseWrapper`): a constant string, the flat quote cascade for one quoted
value, or `if(<obligations>, 'match-none()', concat(…))`, under `if(count(<input>), …, 'match-all()')`
for a clause an input gates. `suite/case-search/xpathQuery.ts::composeXPathQueryClauses` writes one row
per top-level conjunct of the case list filter, of each advanced Search field's condition, and of each
simple field whose match a bare prompt cannot state.

**What reads text back.** One function: `lib/commcare/xpath/expressionAst.ts::parseFormExpression`. It
reads source through the Lezer grammar (`formSyntax.ts::readFormSyntax`), needs a real slot of a real
document (`formPrintContext.ts::formScopeContext` calls `slotContext`), and binds every reference to an
identity or refuses with a `FormParseIssue`. It binds wire paths: absolute, relative and `current()`
paths through the form-node graph, the session's `context`, `user/data` and `data/<datum>` (a datum id
against `formLinkProjection.ts::entryDatumIds`), `casedb` and `results:inline` queries, lookup tables by
tag, the flat place list, and `jr:itext` by Nova's own derived id (`xform/itextIds.ts::itextUnitForId`).
It reverses no lowering and recognizes no HQ spelling: the own-case walk binds as a `project` over
`cases`, never `form-case`; the usercase selector as a `cases` query; a guard as an `if`; an instant
comparison as arithmetic over `substr`. Its function table is Nova's
(`lib/domain/expressionFunctions.ts::FUNCTION_REGISTRY`), which holds two names Core does not answer,
`normalize-space` and `is-blank`. Record slots are authored through the Solutions Architect's own
dialect (`lib/agent/authoring/queryExpressions.ts::parseQueryPredicate`, `::parseQueryValue`), which
reads no suite XPath and no CSQL. CSQL has a printer and no reader. HQ's `interpolate_xpath` exists in
Nova only as the printer's knowledge of what it replaces.

**The checker.** `lib/domain/expression/typeChecker.ts::checkExpression` is the one admission and type
walk. In a record slot it refuses `call`, `cases`, `table-rows`, a `project` that is not a chosen
case's property and a node-set `count` (`arm-unavailable`), except, in a slot only CommCare's server
search reads, the reads a device works out before the search runs. Nothing runs it over text that did
not come from an author.

---

## 2. The recognition method

### 2.1 The method

For one expression of one slot, with HQ's text `T`:

1. **Prepare.** Where the slot is one HQ interpolates (section 6.1), `T` becomes HQ's interpolated
   text. A refusal of that step is a finding (9.2).
2. **Parse.** `readFormSyntax(T)` gives the source tree `S`. A syntax error is a finding under the
   entry 9.2 gives for the slot, or the circumstance `unrecognized` where 9.2 names none.
3. **Bind.** `parseFormExpression(T, scope)` with the reading hook of section 4 gives the candidate
   `C`. Every fold of section 5 the slot's rule set offers is on. A parse refusal is a finding (9.2).
4. **Print.** `toWire(C, context)` and `serializeWire` in the slot's own mode give Nova's text `N`:
   the mode the production emitter uses for that slot, with the slot's own build context
   (`xform/formExpressions.ts` for a form slot, the suite and HQ JSON emitters' contexts for a module
   slot, `emitCsql` for a search row). Where the slot is one HQ interpolates, `N` is taken through the
   same port of HQ's interpolation.
5. **Compare.** `readFormSyntax(N)` gives `P`. `sameSyntax(S, P)` (section 3) decides.

Step 4 uses no reader-only emitter. The context is built by the same functions `expandDoc` and the
suite compiler call, exported where they are private today (section "Files by pull request"). Two
things about that context are the reader's choice, and each leaves the emitter's own code in charge:

- **Form reads print under the source's own names.** `WireBuildContext.form` is the projection the
  binder read the text with (`FormParseScope.sourceProjection`, built from part 06's `ReadSourceNames`,
  section 3.3). A generated node the source names `nova_count_r_1` and Nova's allocator would name
  `nova_count_r` is therefore the same step on both sides, and a name Nova would write differently is
  part 06's fact for the register (its section 13.4), never a difference between two expressions. For
  Nova's own emission the source's names are the allocator's, so nothing changes.
- **The case list filter prints through its own projection.** That slot's bytes are no plain
  `toWire(filter)`: `hqJson/caseList.ts::projectCaseListFilter` prints
  `effectiveFilterForEmission(substituteUnansweredSearchInputs(filter))`, which drops every boolean
  identity (`lib/domain/expression/simplify.ts::simplifyForEmission`), turns a clause that waits for a
  Search field into `match-all` and a bare Search field read into `''`
  (`walk.ts::substituteUnansweredSearchInputs`), and then conjoins the excluded-owners clause
  (`suite/case-list/nodesetFilter.ts::emitExcludedOwnerFilterExpression`) where the search config
  holds one. B5 removes the owners clause before it registers the filter's text (part 07, section
  12.4, by its own re-emission), so B6 calls `projectCaseListFilter` with the candidate as the filter
  and no excluded owners, and compares that print. The function is private today; B6 exports it,
  since B6 edits it to take `rewrites` and is its one caller outside the file. What follows for the
  stored tree is in 2.3 (the rewrite `filter-identities-dropped`), 5.5 (the row `filter-identities`)
  and 7.6 (a clause that reads a Search field is in no detail filter, only in a search row).

### 2.2 Why two syntax trees and no text to `WireExpr` path

A `WireExpr` is what the emitter builds before any spelling is chosen. Reading text into one would need
a second parser total over a tree that holds what text cannot state (`wire/tree.ts`: `expansion`
wrappers, `InstanceDecl` objects with their row names, the suite's generated variable arms), and it
would compare trees before the serializer has run. The serializer is where three of Nova's rewrites
live: the literal protection of `serialize.ts::literalTokens`, the `./.` spelling of a predicate's own
node, and grouping. Comparing after the print means equality here is equality of what Core's parser
reads from the bytes a publish writes, which is clause (b) of the bar for this expression.

`lib/commcare/xpath/wire/__tests__/instantParse.ts::instantMicrosOperand` stays a test helper. It
recognizes the lowering on a `WireExpr` the test itself built; the reader has no `WireExpr` of HQ's text.

### 2.3 Two acceptance levels

`EMISSION_REWRITES` (new, `lib/commcare/emissionRewrites.ts`) is the plan's one registry of the
rewrites Nova's emitter makes (part 09, section 10, which completes it in B7).
B6 creates it with the rewrites Nova's emitter makes to an expression; B7 appends the others (the
required stamp, the conjoined guards and the rest of that list) and adds no second entry for an
empty-rows guard. Its eight expression entries:

| Id | Site | What changes | `behavior` |
|---|---|---|---|
| `instant-comparison` | `fromExpression.ts::compareSides`, plan `lowered` | two dates and times compare as moments | `changes` |
| `empty-rows-guard` | `fromExpression.ts::emitExpression`, `::operand`, `::emitCall` through `emptyRows.ts::guardValue`, `::guardNodeSetConsumer`, `::guardChecklistPair` | a read of a table, the place list, the chosen cases or the search answers reads blank where there are no rows | `changes` |
| `absent-session-value-guard` | `fromExpression.ts::term` (`session-context`), `::lowerExpression` (`case-list-search-text`) | `window_width`, `applanguage` and the search text read blank where the node is absent | `changes` |
| `row-predicate-current` | `formReads.ts::formReadToWire`, the relocation into `current()/…` | a row filter inside a repeat reads this entry's answer | `changes` |
| `default-reads-current` | `formReads.ts::formReadToWire`, the `default_value` slot | a default's read of another question is spelled from `current()` | `none`, unless run E4 gives outcome B |
| `search-value-guards` | `csql/print.ts::hole`, `::wrapSegments`, `::quoteCascade` | a search value picks its quote mark and fails closed | `changes` |
| `search-today-device-day` | `csql/emitter.ts::runtimeHole` (`today`) | a search's `today()` is the worker's day | `changes` |
| `filter-identities-dropped` | `hqJson/caseList.ts::projectCaseListFilter`, `suite/case-list/nodesetFilter.ts::emitNodesetFilter`, through `effectiveFilterForEmission` | the case list filter is written without `true() and`, `or false()` and the other boolean identities | `none` |

```ts
// lib/publish/emissionRewriteIds.ts: the ids alone, so `lib/publish` can key copy by them.
// `lib/publish` may not import `lib/commcare` (biome.json); `lib/commcare` already imports `lib/publish`.
export const EMISSION_REWRITE_IDS = [ /* the eight ids above; B7 appends its own */ ] as const;
export type EmissionRewriteId = (typeof EMISSION_REWRITE_IDS)[number];

// lib/commcare/emissionRewrites.ts
export interface EmissionRewrite {
	readonly behavior: "changes" | "none";
	/** Whether a worker meets the change. False for every `behavior: "none"` entry. */
	readonly touchesWorkers: boolean;
}
export const EMISSION_REWRITES: Readonly<Record<EmissionRewriteId, EmissionRewrite>>;
export interface RewriteControl {
	/** Rewrites the print leaves out, so the reader can compare with text that never had them. */
	readonly withhold: ReadonlySet<EmissionRewriteId>;
	/** Called once per site a print reaches, whether it applied the rewrite or withheld it. */
	readonly reached?: (id: EmissionRewriteId) => void;
}
```

Each entry's sentence is copy, and copy lives where the account's own does:
`lib/publish/firstPublishCopy.ts::REWRITE_SENTENCES: Readonly<Record<EmissionRewriteId, string | null>>`
(null for an entry whose `behavior` is `none`). Both records are total over the id type, so an id
without an entry or without a sentence fails `tsc`, and a test holds that exactly the `changes` entries
have a sentence. Every expression entry whose `behavior` is `changes` has `touchesWorkers: true`. The
record and that test live from B6 to B7: B7 moves the sentences, unchanged, into the register's copy
(`FIRST_PUBLISH_SENTENCES`, part 09, section 10.2) and deletes this record and its test.

`WireBuildContext` (`fromExpression.ts`) gains `rewrites?: RewriteControl`. `CsqlEmissionContext` is
`Omit<WireBuildContext, "target">` (`csql/emitter.ts`), so it carries the same member with no edit to
the type, and the emitter hands it to the `toWire` call of each runtime value;
`projectCaseListFilter` and `emitNodesetFilter` take `rewrites?: RewriteControl` as an optional last
argument. Absent, the emitter prints as today, so no production caller changes. Withheld, each
site prints what it printed before the rewrite existed: `compareSides` takes the `bare` plan; the three
guards return the read; the search text prints its bare path; the filter projection skips
`simplifyForEmission` and prints the filter as stored; and `formReadToWire`, at one of its two
relocation sites (a `default_value` slot, or `crossesSourceRepeatInRowPredicate`), prints a read that
stores no spelling, `absolute` or `current` as its absolute path (a `relative` read is never relocated
and prints as it does today). `formReadToWire` calls `reached` at a relocation site
whenever the print it would make unwithheld is `current()/…`, whether the tree stores `current` or
the site relocated an absolute read: the reader stores `current` there (5.2), so "applied" cannot be
read off a change of spelling. The two search rewrites, `search-value-guards` and
`search-today-device-day`, have no switch and no site calls `reached` for them: section 7.4 compares
CSQL instead, and a row held at its guards level reports them.

- **Exact.** `sameSyntax(S, P)` with no rewrite withheld. The slot is held and reports nothing.
- **Up to named rewrites.** Not exact, and `sameSyntax(S, P')` where `P'` is the print with
  `withhold` holding every id of `EMISSION_REWRITE_IDS`: every rewrite that has a switch is left
  out, a site with none prints as it does today, and an id B7 appends with a switch joins the level
  with no change to this code (part 09, section 10.2). The slot is held. The reader reports each id
  the withheld print reached whose `behavior` is `changes`, with the slot's place:
  `{ id, place, key }`. B7's `FIRST_PUBLISH_CHANGES` draws its expression entries from these
  reports.
- **Neither.** The slot is the circumstance `unrecognized` (9.2).

**What is stored is what the unwithheld print reads back as.** Acceptance check 3 re-reads Nova's
emission of D and requires D. So at the second level the tree B6 writes into the slot is the one a read
of `P` gives, which the first level then finds exact: a read at a relocation site is spelled `current`
(5.2); the case list filter is `effectiveFilterForEmission` of the candidate, absent where that is
all-true (5.5); every other rewrite leaves the tree alone, since the fold that reads the rewritten
print gives the same arm (5.3). `expressionReadBack.fixedPoint.test.ts` holds
`read(emit(read(A))) = read(A)` for an HQ-authored text at each of the eight ids.

Nova prints a whole expression at once, so an expression Nova wrote is exact and one an HQ author wrote
carries no rewrite. An expression that mixes the two (a person edited Nova's lowered formula in HQ's
form builder and left a bare date-and-time comparison beside a lowered one) is neither, and is
`unrecognized`: the two comparisons cannot both be what one stored tree prints.

### 2.4 Folds are proposals

A fold (section 5) proposes a typed arm for a syntax shape: `form-case` for a casedb walk, `in` for an
`or` of equalities. A proposal can be wrong in a way only the print shows: a guard at a position where
Nova writes none, an `if` chain that is not a `switch` the slot's types admit. So:

1. Bind with every fold on. Compare.
2. On a mismatch, `firstDifference(S, P)` gives the source node where the trees first differ, in
   document order. The innermost fold site whose source span holds that node is withdrawn: that node
   binds plainly from then on. Bind again and compare.
3. Repeat until the trees are equal or the difference lies in no fold site. Then try the withheld
   print, once, with the folds as they stand; a mismatch there is `unrecognized`.

A fold site is `(slot key, fold id, from, to)`. The loop ends: each turn withdraws one site, and a slot
has finitely many.

### 2.5 The order of work over an app

Expression typing is a fact of the whole document: `expressionFacts` infers each Hidden Value's type
from its calculation, and `comparisonPlan` reads those types to decide whether a comparison lowers. So
B6 runs over the whole app at once, in the frame's expression stage (part 06, section 2.3, stage 7:
after the forms, a menu's own shape, case management, the minted fields, case lists and search, and
part 07's two calls that close stage 6, `compareEntryFacts` and `registerLinkExpressions`; before
part 07's settle steps, text, the form verdicts that read bound trees, and assembly). The stage is
`reader/provisional.ts::bindExpressions`, which lands in B6: in B2 to B5 stage 7 builds the
provisional document and binds nothing. The structure readers register each expression:

```ts
// lib/commcare/reader/pendingExpressions.ts (B2 carries the file; this part is its author)
export type ReadMode =
	/** `constraint`: the attribute is a validation condition, where the printer writes a
	 *  predicate's own node as `.` and elsewhere as `./.` (`xpath/wire/CLAUDE.md`, "Printing"). */
	| { readonly target: "xform"; readonly constraint: boolean }
	| {
			readonly target: "hq-json";
			readonly interpolation: HqInterpolation; // lib/commcare/hqJson/xpath.ts
	  }
	| { readonly target: "search-row" };

export interface PendingExpression {
	/** The slot the expression belongs to, which exists in the document. */
	readonly ref: SlotContextRef;
	/** HQ's text, as the source holds it. */
	readonly text: string;
	readonly mode: ReadMode;
	readonly place: HqPlace;
	/** The surface key the claim is logged under: `xform:model/bind@relevant`, `schema:Detail.filter`. */
	readonly key: string;
}

/** What a slot that must hold a tree holds until B6 fills it. */
export function pendingPlaceholder(expectation: "condition" | "value"): Expression;
```

The record holds no `vellum:` shadow: part 06 judges a shadow itself (10.1), and its registry in the
same file (`PendingRegistry`, its section 11.1) keeps the node an expression was read from and a
default's event. Every reader registers through `ctx.pending.register(expression, at)`, which returns
the registration's index `i`. Part 07 builds the record the same way: a mode it names by a string is
the `interpolation` of `{ target: "hq-json", interpolation }`, an `_xpath_query` value is
`{ target: "search-row" }`, and `key` is the surface key it claims the value under. A settle function
reads a registration's result through the registry's `ctx.pending.outcome(i)` (part 06, section 11.1):
`.expression` is `ExpressionReading.bound[i]` and `.claim` the slot's own claim, the one whose
`source` is `i` and whose `key` is the registration's `key` (the surface uses of 9.3 share the
`source` under their own keys), below; both are undefined before B6 lands and for a registration
nothing bound.

`pendingPlaceholder` gives `{ kind: "match-all" }` for a condition and the empty string literal for a
value. A structure reader writes it into a slot whose schema requires an expression (a calculated
column, an advanced Search field's condition, a link's carried value, a case write's value) and leaves
an optional slot absent; either way it registers the text.

**What the document must hold before B6 runs.** Binding and printing read a real document
(`slotContext`, `expressionFacts`, `entryDatumIds`, the emitters' build contexts): the frame's
provisional document (part 06, section 2.3), built in every reading whether or not a finding stands.
It must hold, for every form: its type; its menu with case type, kind, parent selection and held
placements; its case operations with their targets and placements; every link with its target and the
selection each carried value names; and the organization levels by code (from B9 on, the structure
stage puts them on the draft through part 11's `levelsFromHq`; before B9 the draft holds none).
These are what `entryDatumSupplies` and `entryDatumIds` read, and what `owner-at-level` binds
against. Part 07's passes before this stage write all of them (its section 2.1, steps 2 to 4): the
last, `menus/afterSubmit.ts::registerLinkExpressions`, resolves the selection each carried value
names, takes the emitter's held-case guards off each link's `xpath` and only then registers the
link's condition and carried values (its section 9.4). Part 07's settle steps read bound trees and
run after: the preload order, a form's after-submit comparison, the hidden spelling of a display
condition, the classification of search rows. A registration whose slot the provisional document
lacks, because a structure finding left its owner out, gets no tree and no claim from
`readExpressions`, which lists its index in `ExpressionReading.ownerless`. The frame claims its node
under the finding that stands at or above its place, since that finding is the account's line; where
none stands, the frame throws the invariant C10.

**A form whose entry facts differ.** Part 07's `caseManagement/index.ts::compareEntryFacts` runs
before this stage and lists each form whose entry HQ builds otherwise than Nova's projection in
`ReadFacts.entryFactsRefused`, with its own finding at the form (its section 6.3).
`expressionEnvOf(ctx)` hands that list in as `env.entryFactsRefused`. In a form of that set a
`session/data/<id>` read the projection does not give raises no M1: a registration whose slot belongs
to such a form (the form's own slot, or a field's) and whose claim would be M1 (9.2) gets no tree and
no claim, its index is listed in `ExpressionReading.ownerless`, and the frame claims its node under
part 07's finding at the form, by the rule above. One cause is one line of the account.

**Worker properties and location properties are learned by a first run** (part 11, section 11.5). A
read binds to one by UUID only where the document already holds it
(`referenceBindings.ts::formUserProperty` gives `session-user-property` only for a slug the document
has, else the name-backed `session-user` leaf; a `location_data` step for a slug the document lacks
is `unknown-location-property`). So the frame calls `readExpressions` twice. The first run is kept
only for `worldReads`; the frame mints the entities from it with part 11's
`worldEntitiesFromReads(worldReads, ctx.resolver)` (`lib/commcare/reader/worldEntities.ts`, which part
11 authors and B6 lands with this stage), writes them onto the draft (`DraftApp.userProperties`,
`DraftApp.locationProperties`) inside `ctx.writeDraft(() => { … })`, part 06's one writer of a draft
(its section 2.3), so the provisional document built next holds them, and the second run is the
reading. B6 writes a draft nowhere else: `readExpressions` takes a document and returns one.
`readExpressions` is pure, so the two runs and a re-read of Nova's emission of the result learn the
same slugs.

```ts
// lib/commcare/reader/expressions/index.ts
// Types of other modules used below and in the other blocks of this part: `HqPlace` and
// `FindingDetail` are `lib/publish/hqFindings.ts`'s (part 01, section 8.1); `ReadSourceNames` is
// `lib/commcare/reader/xform/index.ts`'s (part 06, section 17.2); `SlotContextRef`, `ProseSlotRef`
// and `ItextUnit` are `lib/domain/expression/types.ts`'s; `LookupDefinitionIndex` is
// `lib/domain/expression/context.ts`'s; `RuleSet` is `lib/domain/expression/profiles.ts`'s;
// `FormNodeProjection` is `lib/commcare/xpath/formNodeProjection.ts`'s.
export interface ExpressionReadEnv {
	readonly lookup: LookupDefinitionIndex; // `ReaderLookupCatalog.definitions` (parts 06 and 11)
	/** Per form: the source's own names, from which the binding projection is built (3.3). */
	readonly sourceNames: ReadonlyMap<Uuid, ReadSourceNames>;
	/** Per form: HQ's itext id to the unit the form reader read it as. */
	readonly itextUnits: ReadonlyMap<Uuid, ReadonlyMap<string, ItextUnit>>;
	/** Per form: each declared instance id to its `src`. */
	readonly instanceSources: ReadonlyMap<Uuid, ReadonlyMap<string, string>>;
	/** Per form: a generated sibling the form reader set aside, by absolute path, with its calculate. */
	readonly generatedValues: ReadonlyMap<Uuid, ReadonlyMap<string, GeneratedValue>>;
	/** Per form: the case id path of each Save to Case create, to its operation (part 07). */
	readonly operationIdPaths: ReadonlyMap<Uuid, ReadonlyMap<string, Uuid>>;
	/** `ReaderInput.recordDialect`: undefined where the record dialect prints the tree and reads the
	 *  print back to it, else the kind it cannot spell or `"round-trip"` (8.4). */
	readonly recordDialect: RecordDialectJudge;
	/** The forms whose entry facts part 07 found differing, from `ctx.facts.entryFactsRefused`: a
	 *  datum read the projection does not give raises no M1 there (above). */
	readonly entryFactsRefused: ReadonlySet<Uuid>;
}
export interface GeneratedValue { readonly purpose: "constraint-count"; readonly calculate: string }
export type RecordDialectJudge = (
	doc: BlueprintDoc,
	ref: SlotContextRef,
	expression: Expression,
) => string | undefined;

export interface ExpressionClaim {
	/** The index of the registration the claim is for, in `pending`; -1 for a claim of a form's
	 *  own declaration (9.3). */
	readonly source: number;
	readonly entryId: string;
	readonly place: HqPlace;
	readonly key: string;
	readonly detail: FindingDetail;
}
export interface ExpressionReading {
	/** The document with every held expression in its slot, and the properties step 1 declared. */
	readonly doc: BlueprintDoc;
	/** Per registration, in order: the held tree, or undefined where the slot is not held. */
	readonly bound: readonly (Expression | undefined)[];
	/** One claim per expression and per surface use (9.3), held or not, in registration order. */
	readonly claims: readonly ExpressionClaim[];
	readonly circumstances: readonly {
		readonly source: number;
		readonly code: "unrecognized";
		readonly place: HqPlace;
		readonly detail: FindingDetail;
	}[];
	readonly rewrites: readonly {
		readonly id: EmissionRewriteId;
		readonly place: HqPlace;
		readonly key: string;
	}[];
	/** Case properties the app reads and nothing in it writes, which step 1 declared. */
	readonly declaredProperties: readonly { readonly caseType: string; readonly property: string }[];
	/** What the expressions read of the worker and of places that the document does not hold yet
	 *  (part 11, 11.5): the `field` of every name-backed `session-user` leaf a held tree holds, and
	 *  the slug of every `location_data/<slug>` step the texts name, each distinct, in code-unit order. */
	readonly worldReads: {
		readonly userFields: readonly string[];
		readonly locationDataSlugs: readonly string[];
	};
	/** Tags an expression reads that the catalog does not hold (joins `ReadFacts.unreadTables`). */
	readonly unreadTables: readonly string[];
	/** Registrations with no tree and no claim: those whose slot the document does not hold, and
	 *  those of a form in `env.entryFactsRefused` whose claim would be M1. In ascending order. */
	readonly ownerless: readonly number[];
	/** How many bind-and-compare rounds ran (step 3). */
	readonly rounds: number;
}
export function readExpressions(
	doc: BlueprintDoc,
	pending: readonly PendingExpression[],
	env: ExpressionReadEnv,
): ExpressionReading;
```

`readExpressions` is pure and never throws for an app's content. It never writes into a document it
was given or one it has read: `expressionFacts`, `effectiveCaseTypes` and
`xform/generatedNodes.ts::planGeneratedNodes` each memoize per document object ("documents are
replaced, never changed in place"), and `rewriteExpressionSlotValues` assigns in place. So every step
that changes content clones first (`structuredClone` of `lib/doc/fieldParent.ts::toPersistableDoc`'s
answer, rewritten, then `::hydratePersistedBlueprint`), so the clone is whole before anything reads it.
`documentFacts.test.ts` holds the reason: a Hidden Value whose calculation binds to a date and time
changes how another slot's comparison prints, which a document mutated after its facts were read would
miss. Its steps:

1. **Scan.** `scanReads(pending, doc, env)` parses each text once (after HQ's interpolation, 6.1) and
   collects, from syntax alone, each list distinct and in code-unit order:

   ```ts
   // lib/commcare/reader/expressions/scanReads.ts
   export interface ScannedReads {
   	readonly caseProperties: readonly { readonly caseType: string; readonly property: string }[];
   	readonly locationDataSlugs: readonly string[];
   	readonly lookupTags: readonly string[];
   }
   export function scanReads(
   	pending: readonly PendingExpression[],
   	doc: BlueprintDoc,
   	env: ExpressionReadEnv,
   ): ScannedReads;
   ```

   - **Case properties**, each with a case type the syntax fixes: a `[@case_type = '<literal>']`
     predicate on a casedb or results query, an own-case walk (the form's reachable types by depth,
     `lib/domain/caseTypes.ts::reachableCaseTypes`), a row-relative step in a slot whose context holds
     a case row. Each `(caseType, property)` the effective catalog lacks is declared in a clone of the
     document by the one rule for the catalog's properties, part 07's
     `caseManagement/catalog.ts::noteProperty(caseTypes, caseType, name)` (its section 7: it owns
     their order and leaves the standard properties out, and it is a function of a catalog, so the
     scan applies it to its clone), with no `data_type` (unknown is honest: `lib/domain/CLAUDE.md`,
     "Property types are derived facts"), and
     listed in `declaredProperties`. A property name outside `AUTHORED_CASE_PROPERTY_NAME_PATTERN` is
     not declared; its expression then fails to bind and claims part 04's entry for the name (9.2).
   - **Location property slugs**: every `location_data/<slug>` step under
     `instance('locations')/locations/location[…]`, for `worldReads.locationDataSlugs`, whether or not
     the document holds the property yet.
   - **Lookup tags**: each `instance('item-list:<tag>')` and each instance id a form declares with
     `jr://fixture/item-list:<tag>`. A tag `env.lookup` does not hold joins `unreadTables`.
   B6 mints nothing here. A worker property or a location property the document lacks stays lacking
   for this run; the frame's second run finds it (above).
2. **Bind** every registration against that document, folds on, and write each candidate into its
   slot of a fresh clone, giving `D1`. A prose slot holds several values: the i-th registration under
   one `ProseSlotRef` belongs to that slot's i-th pending `value` part of the provisional document
   (part 06, section 17.2), and is written at that part's place in the template as
   `lib/domain/proseExpression.ts::canonicalProseAtom(candidate)` (part 03, section 4.1; A7): the
   reference part where the tree is a plain read of one answer, which the template's schema refuses
   as a `value` part, and a `value` part holding the tree otherwise. One atom takes the place of
   one atom, so the place of the i-th registration is the same in every round.
3. **Compare** every slot against `D1` (2.1 steps 4 and 5). Each mismatching slot withdraws one fold
   site (2.4). The next round rebinds the slots that withdrew one, writes them into a fresh clone, and
   compares **every** slot again against it, because a withdrawn fold can change a Hidden Value's
   inferred type and with it another slot's print. The loop ends when a round withdraws nothing. A
   slot has finitely many fold sites, so it ends; `EXPRESSION_ROUND_LIMIT = 64` bounds it all the same,
   and slots still unequal at the limit go to step 4 as they stand. `rounds` is returned for the
   reading's log: the frame keeps it as `ReadFacts.expressionRounds` (part 06, sections 2.3 and
   17.3), and this part asks part 12 to put it on the read step's log line ("What this part needs
   of other parts").
4. **Level.** Each slot still unequal is compared with the withheld print (2.3), and a slot held at
   that level is rewritten to the tree the unwithheld print reads back as (2.3, last paragraph), in a
   fresh clone. A slot unequal at both levels is `unrecognized`.
5. **Check** every held slot with `checkExpression` over that document (9.1).
6. **Dialect.** Every held slot of the record rule set is given to `env.recordDialect`. An answer
   makes the slot not held: it claims the slot's default of 9.2 (the column "Refused, by default",
   which is a HELD-NEW entry for every record slot) with `detail.reason` `dialect:<answer>`.
   `lib/agent/authoring/output.ts` prints every record slot of a module through
   `queryPrinter` for `get_module`, `get_form`, `get_case_operations` and every Solutions Architect
   turn, and one slot it cannot print fails the whole read, so this is what keeps an adopted app
   readable. The judge is handed in because `lib/commcare` imports nothing of `lib/agent`: the reading
   service (part 12, B10) passes `lib/agent/authoring/recordRoundTrip.ts::recordDialectRoundTrip` as
   `ReaderInput.recordDialect` (8.4).
7. **Report.** A slot that is not held keeps its placeholder or stays absent, in a last clone that
   also drops any declared case property no held slot reads. `worldReads.userFields` is read off
   every bound candidate, held or not: the `field` of each name-backed `session-user` leaf, from
   session data or the worker's record alike (part 11 decides which become worker properties).
   The frame turns a claim of a HELD-NEW or REFUSED entry into a finding, so the reading has an
   account and never reaches the gate.

Steps 2 to 4 print every slot of the app once per round. That is pure computation with no I/O. A pure
function has no clock, so the bound is the round limit, never a deadline; the reading's own step
deadline is the reading service's, around the whole check (part 12, sections 3.3 and 3.6,
`HQ_READING_CHECK_BUDGET_MS`; B10), and `expressionRounds.test.ts` holds that the largest
corpus document and the three starter bases finish in at most four rounds.

---

## 3. The closed equivalence table

### 3.1 The comparison

```ts
// lib/commcare/reader/syntaxCompare.ts (B2 carries the file; this part is its author)
export interface CompareOptions {
	/** `record` applies S1 and S2; `form` applies neither. */
	readonly ruleSet: RuleSet;
	/** Section 3.3: maps over the source tree's local names. */
	readonly instanceId?: (id: string) => string;
	readonly itextId?: (id: string) => string;
}
/** `options` defaults to `{ ruleSet: "record" }`, the comparison parts 07's two-argument calls mean. */
export function sameSyntax(source: FormSyntax, print: FormSyntax, options?: CompareOptions): boolean;
/** The source node at which the two trees first differ, in document order. */
export function firstDifference(
	source: FormSyntax,
	print: FormSyntax,
	options: CompareOptions,
): FormSyntax | undefined;
/** Two texts that parse to the same tree. Used by the list and menu readers (section 10). */
export function sameXPathText(a: string, b: string, options?: CompareOptions): boolean;
```

The file imports `formSyntax.ts` and nothing of the reader, and lands in B2 with its Vitest file and
the lexical rows L1 to L6, because B3 to B5 call `sameSyntax` and `sameXPathText` (parts 06 and 07) and
land beneath B6. B6 adds the two record rows, S1 and S2, and run E1, and nothing else to the file
but a rule that run narrows. `syntaxOf`, the tree of HQ's text after interpolation, which part 07 also
calls, is beside the port of that interpolation (6.1), in B2 too.

Both trees are normalized by one function, `comparable(node, options)`, and then compared node for
node: kinds equal, operator and function names equal as exact strings, names equal as exact strings,
string values equal as exact strings, numbers equal as IEEE doubles, children pairwise equal. Source
spans are not compared. Nothing else is erased: `a and (b and c)` and `a and b and c` are different
trees, as are `a != b` and `not(a = b)`, and each binds to a different candidate that prints itself.

### 3.2 The rows

Every row is a rule of `comparable`. Run E1 holds each against Core with the vectors named.

| Row | Counts as the same | Rule | Core, read | E1 vectors |
|---|---|---|---|---|
| L1 | any run of spaces, tabs, carriage returns, line feeds and form feeds between tokens, and none | the grammar's `@skip` (`grammar.lezer.grammar`, `whitespace`); the trees never hold it | `parser/Lexer.java::lex` | `1+1` and `1 + 1`; `a  =\n'x'`; a tab and a form feed between an operator and a name; `selected( a ,'x' )` |
| L2 | parentheses that group an operand | a `group` node is replaced by its `value` | `parser/Parser.java::parseParens` folds a grouping into the operand it holds | `(1 + 2) * 3` against its tree; `((a))` and `a`; `(a = b)` and `a = b` |
| L3 | `"x"` and `'x'` | `string` nodes compare by `value` | `Lexer.java::lex`, the `STR` token takes the text between matching marks | `'a'` and `"a"`; `"it's"`; a value holding the other mark |
| L4 | `1`, `1.0` and `01`; `.5` and `0.5` | `number` nodes compare by value | `Lexer.java::matchNumeric`, `Double.valueOf` | each pair, and `1.` |
| L5 | `child::a` and `a`; `self::node()` and `.`; `parent::node()` and `..` | an `axis` node named `child` is replaced by its value; `self` and `parent` over the call `node()` become `self` and `parent`. `attribute::a` and `@a` need no rule: `formSyntax.ts` reads both as one `axis` node (`AttrSpecified`, `AxisSpecified`) | `expr/XPathStep.java` holds one axis and test for either spelling | each of the three pairs, and `attribute::a` with `@a` as a control, in a path over a small instance |
| L6 | `./.` and `.` as the whole of a path inside a predicate | a `child` node whose left and step are both `self` becomes `self` | Core contextualizes `./.` to the same node | `x[. = 'a']` and `x[./. = 'a']` over three nodes |
| S1 | in a record slot, `cond(c1, v1, …, cn, vn, d)` and `if(c1, v1, if(…, if(cn, vn, d)))` | with `ruleSet: "record"`, a `call` named `cond` with an odd count of three or more arguments is rewritten to nested `if` calls before the comparison, on the source tree | `expr/XPathCondFunc.java::evalBody` evaluates the pairs in order and stops at the first true one | three and five arguments, a true first, a true second, none true, a branch that would throw when evaluated |
| S2 | on a case row, the step `name` and the step `case_name` | with `ruleSet: "record"` or inside a casedb or results row predicate, a `name` node spelled `name` that is a row's own step compares as `case_name` | decided by E1, outcome D | a case named `Asha` read as `name` and as `case_name` from `casedb` and from `results:inline` |

S1 is applied in a record slot only. In form logic `cond` is a `call` the union holds, prints as written
and needs no row. S1 is a rule of the comparison alone: what makes the candidate an `if` is the `cond`
fold of 5.3, since the plain binder reads `cond(…)` as a `call`, which a record slot refuses.

The two axis pairs of L5 are live in a form's own paths, where `formPathBinding.ts::bindFormPath`
binds `self::node()` and `parent::node()` as `.` and `..` and Nova prints the short form. In a case,
table or place row's path the binder refuses every axis but `child` and `attribute`
(`formPathBinding.ts::name`), so those spellings never reach a comparison there (9.2 says what they
claim).

### 3.3 Local names

Three kinds of name are local to one form's source. The reader maps them and the lane's own checks hold
the mapping, so they have no native vector.

- **An instance id.** A form's `instance('<id>')` names whatever `<instance id="<id>" src="…">`
  declares. The reader binds an id by its declared `src` (section 4.2) and Nova prints the id it derives
  from the source (`wire/instances.ts`: `casedb`, `commcaresession`, `locations`, a table's tag, a
  chosen-cases datum id). `CompareOptions.instanceId` maps each source id to Nova's id for the same
  `src` before the trees are compared. A suite or HQ JSON slot has no declarations: HQ derives the
  source from the id (`suite_xml/post_process/instances.py::get_instance_names`), so ids there compare
  as written.
- **An itext id.** HQ's forms name itext entries as their author or Vellum chose; Nova derives each id
  from its text unit (`xform/itextIds.ts::itextIdFor`). `CompareOptions.itextId` maps the argument of a
  `jr:itext` call in the source tree from HQ's id to Nova's id for the unit the form reader read it as.
- **A form node's name.** The binder resolves a path through `FormParseScope.sourceProjection`, a
  `FormNodeProjection` B6 builds from part 06's `ReadSourceNames` (its section 17.2): each field under
  the name and path the source gave it, and each generated node part 06 folded under the source's name
  for it, as the node role it stands for. A count placement's `nova_query_ids_<repeat>` and its
  siblings, and a count repeat's `nova_count_<repeat>`, bind to the same identities their authoring
  spellings do (`@ids`, `item/@id`, the count result). Step 4 prints through the same projection
  (2.1), so a node Nova's allocator would name differently
  (`xform/queryRepeatNames.ts::planQueryRepeatNames`, `xform/repeatCountNames.ts::planRepeatCountNames`,
  `xform/generatedNodes.ts::planGeneratedNodes`) is one step on both sides; the changed name is part
  06's fact for the register. This is outline item 10's "count-placement spelling read back into the
  one authoring spelling".

---

## 4. The reading hook in the form parser

### 4.1 What `parseFormExpression` needs, and where the reader gets it

| Need | Why | The reader supplies |
|---|---|---|
| a real slot in a real document | `formScopeContext` calls `slotContext(doc, slot, …)`, which returns nothing for a missing owner, member or configuration | the structure readers of B3 to B5 create every owner before B6 runs, with `pendingPlaceholder` in a required slot (2.5) |
| the form's node graph under the names the source uses | relative paths, `current()` and generated nodes resolve through `binder.projection` | `sourceProjection`, built from part 06's `ReadSourceNames` (3.3) |
| the worker properties, by slug | `referenceBindings.ts::formUserProperty` gives the identity leaf only for a slug the document holds | the frame's first run returns `worldReads`; the entities are in the document for the second (2.5) |
| the location properties and levels, by slug and code | `unknown-location-property` and `unknown-level` refuse a read of one the document lacks | the same two runs for properties; the levels are in the document before either, put on the draft by the structure stage through part 11's `levelsFromHq` (its section 11.2; from B9) |
| datum ids | `instancePath` resolves `session/data/<id>` against `entryDatumIds(doc, …)` for the slot's form | the document holds the menus, parent selections, case operations and placements B4 read, so the projection gives HQ's ids. An id it does not give is a finding (9.2, entry M1) |
| the lookup catalog | `scope.lookup`; `"unavailable"` refuses every table read | `env.lookup`, the `definitions` of part 06's `ReaderLookupCatalog`, which part 11's `readerLookupCatalog` builds before the reader runs with the ids minted at the reading step (its section 5.5; every column `text`, its section 5.2) |
| itext ids | `itextUnitForId` knows only Nova's derived ids | `reading.itextUnit` over `env.itextUnits` |
| instance ids | `instancePath` matches `casedb`, `commcaresession`, `locations`, `results:inline`, `search-input:results[:inline]`, a chosen-cases datum id and a table's tag or `item-list:<tag>` | `reading.instanceSource` over `env.instanceSources`, so an id is read by its `src` |
| Core's function names | `FUNCTION_REGISTRY` also holds Nova's own `normalize-space` and `is-blank`, and the parser's special forms hold `capture-link` | `reading.functions` |
| the case types a property belongs to | `rowValue` resolves an untyped row's custom property against `context.facts.caseTypes` | the scan's declarations (2.5 step 1) |

### 4.2 The hook

```ts
// lib/commcare/xpath/formParseScope.ts
export interface FormReadingHooks {
	/** The function names the text may call. Any other is `unknown-function`. */
	readonly functions: ReadonlySet<string>;
	/** HQ's itext id to the unit it names in this form. */
	itextUnit(id: string): ItextUnit | undefined;
	/** A declared instance id to its `src`; undefined where the form declares none. */
	instanceSource(id: string): string | undefined;
	/** The calculate of a generated sibling the form reader set aside, by absolute path. */
	generatedValue(path: string): string | undefined;
	/** A fold's proposal for this node, or undefined to bind it plainly. */
	fold(node: FormSyntax, context: ExpressionContext, api: FoldApi): Expression | undefined;
	/** False where run E1 gives outcome D: a case row's `name` step is the property `name`. */
	readonly caseNameAlias: boolean;
}
export interface FoldApi {
	bind(node: FormSyntax, context: ExpressionContext): Expression;
	term(value: Term, node: FormSyntax): Expression;
	remember<T extends Expression | Term>(value: T, node: FormSyntax): T;
}
export interface FormParseScope {
	// …today's keys…
	readonly reading?: FormReadingHooks;
}
```

Edits, each inert without `scope.reading`:

- `expressionAst.ts::parseFormExpression`, `bind`: before its `switch`, `scope.reading?.fold(node, ctx,
  api)`; a defined answer is returned.
- `expressionAst.ts`, `call`: with a hook, a name outside `reading.functions` is refused
  `unknown-function` before the registry is read. `reading.functions` is
  `JAVAROSA_NATIVE_FUNCTIONS` (`functionCapabilities.ts`) with `jr:itext`, `jr:choice-name`, `here`,
  `instance` and `current`. So `normalize-space(x)`, `is-blank(x)` and `capture-link(x)` in HQ's text
  are unknown functions, which Core would not run.
- `expressionAst.ts`, the `hashtag` node, and `formPathBinding.ts::bindFormPath`, its hashtag branch:
  with a hook, every hashtag is refused `unknown-hashtag`. Without this `bindFormPath` binds
  `#form/<path>` by the field order, prints `/data/<path>` and leaves the slot `unrecognized`, though
  the text is one Core's lexer refuses outright (`parser/Lexer.java::lex` has no token for `#`). The
  hook sees a hashtag in a real XForm attribute and in an HQ JSON slot HQ does not interpolate (a
  calculated column), where it reaches Core as written; an interpolated slot's hashtags are replaced
  before the parse (6.1).
- `expressionAst.ts`, `jr:itext`: with a hook, the unit is `reading.itextUnit(id.value)`.
- `formPathBinding.ts::instancePath`: with a hook, the id is first replaced by the canonical id of its
  declared source: `jr://instance/casedb` gives `casedb`, `jr://instance/session` gives
  `commcaresession`, `jr://fixture/locations` gives `locations`, `jr://fixture/item-list:<tag>` gives
  `item-list:<tag>`, `jr://instance/selected-entities/<id>` gives `<id>`,
  `jr://instance/search-input/results[:inline]` gives `search-input:results[:inline]`,
  `jr://instance/remote/results[:inline]` gives `results[:inline]`, and `jr://fixture/user-groups`
  gives `groups`, so the binder's own `groups-held` refusal answers and the claim is the HELD-NEW
  `expressions-and-data/groups-jr-fixture-user-groups`, never the REFUSED entry for an unrecognized
  source. An id the form does not declare is read as written, which is what a suite slot needs. A
  declared source outside this list is refused `instance-unknown`.
- `formPathBinding.ts::bindFormPath`: with a hook, an absolute path that resolves to no node and equals
  a path `reading.generatedValue` knows binds that calculate's syntax in its place, under the same
  context. This is the inverse of `xform/constraintCollections.ts`, which lifts a count out of a
  validation condition into the sibling `nova_constraint_<question>_<n>`; the print lifts it again, and
  the form reader compares the sibling's own calculate with what Nova emits for it (section 10.3). The
  reader answers `generatedValue` from `env.generatedValues`, which part 06 fills (its sections 11.1
  and 17.2): the calculate is no slot of the document and is never registered on its own.
- `formPathBinding.ts::rowValue`: the `name` to `case_name` alias applies unless
  `reading.caseNameAlias === false`.
- `formPathBinding.ts::bindFormPath`: in a slot whose context has no form and whose top row is a case
  row (the case list filter, a calculated column), a path rooted at `current()` binds its steps as that
  row's, as a path with no root does. HQ writes `current()` for the listed case there
  (`suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`). Without a hook such a path keeps
  today's `relative-no-context` refusal.

### 4.3 The scope the reader builds

```ts
// lib/commcare/reader/expressions/readExpression.ts
export function readingScope(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	/** Fold sites withdrawn so far in this slot, as `foldId:from:to` (2.4). */
	withdrawn: ReadonlySet<string>,
): FormParseScope {
	// `form`: the form of the slot, where its context reads the form's answers; else undefined.
	const names = form && env.sourceNames.get(form);
	return {
		doc,
		slot: pending.ref,
		lookup: env.lookup,
		sourceProjection: names && sourceNodeProjection(doc, form, names),
		reading: { functions, itextUnit, instanceSource, generatedValue, fold, caseNameAlias },
	};
}
/** The projection that names each node of `form` as the source named it (3.3). */
export function sourceNodeProjection(
	doc: BlueprintDoc,
	form: Uuid,
	names: ReadSourceNames,
): FormNodeProjection;

/** One slot judged on its own, against a document that holds the app's other expressions: bind
 *  `pending.text` with every fold on but the `withdrawn` sites, print the candidate in
 *  `slotReadMode(doc, pending.ref)` with `rewrites` (absent: no rewrite withheld), compare (2.1).
 *  `readExpressions` runs the same three steps for every slot of a round (2.5); a reader that
 *  needs one slot judged again calls this. */
export function readExpression(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env: ExpressionReadEnv,
	options?: { readonly withdrawn?: ReadonlySet<string>; readonly rewrites?: RewriteControl },
): SlotJudgment;
export type SlotJudgment =
	/** The interpolation, the parse or the binder refused: the entry of 9.2, or `unrecognized`
	 *  where `entryId` is undefined. */
	| { readonly kind: "refused"; readonly entryId: string | undefined; readonly detail: FindingDetail }
	| {
			readonly kind: "bound";
			readonly candidate: Expression;
			/** `S` and `P` of 2.1. */
			readonly source: FormSyntax;
			readonly print: FormSyntax;
			readonly equal: boolean;
			/** The fold sites the bind used, as `foldId:from:to` of the source, outermost first. */
			readonly foldSites: readonly string[];
	  };
```

A form the env holds no names for (its source did not parse, so it registered no form slot) gets no
`sourceProjection`, and the binder reads the document's own names. No `current`, no `authoring` and
no prepared `form`: the document B6 is handed is whole (2.5), `#case`
has no meaning in a real attribute, and no identity hint exists for text Nova never saw. The document
is part 06's provisional one, so the structure a slot is bound against is the one its print and the
checker read (`expressionFacts`, `entryDatumIds`). A hashtag in a real attribute
(`#form/x` left in `relevant` by a hand edit) is refused `unknown-hashtag` by the hook (4.2) and claims
`expressions-and-data/an-invalid-xpath-in-a-bind-attribute` (9.2), since Core's lexer refuses `#`.

`parseFormExpression` takes an `ExpressionSlotRef` today. Part 03 (A7) widens the slot of a parse to a
`SlotContextRef` for a prose value; B6 uses that widened type and adds nothing to it.

---
## 5. Folds

A fold is `{ id, ruleSets, propose }` in `lib/commcare/reader/expressions/folds.ts`:

```ts
export interface Fold {
	readonly id: FoldId;
	/** The rule sets whose slots are offered the fold. */
	readonly ruleSets: readonly RuleSet[];
	propose(node: FormSyntax, context: ExpressionContext, api: FoldApi, env: FoldEnv): Expression | undefined;
}
export interface FoldEnv {
	readonly doc: BlueprintDoc;
	/** The slot's form: each Save to Case create's case id path, to its operation. */
	readonly operationIdPaths: ReadonlyMap<string, Uuid>;
	/** Fold sites withdrawn so far, as `foldId:from:to` of this slot's source. */
	readonly withdrawn: ReadonlySet<string>;
}
export const EXPRESSION_FOLDS: readonly Fold[]; // in the order of the tables below
/** One member per fold of 5.1, 5.2 and 5.3, in table order. */
export type FoldId =
	| "protected-literal" | "typed-literal"
	| "form-read" | "own-case-read" | "worker-record-read" | "operation-id" | "acting-user"
	| "unowned" | "owner-at-level"
	| "absent-node-guard" | "search-text" | "empty-rows-guard" | "handed-on-rows-guard" | "cond"
	| "checklist-guard" | "instant-comparison" | "is-blank" | "normalize-space" | "quotient"
	| "date-add" | "datetime-value" | "when-input-present" | "in" | "between" | "switch"
	| "relation-property" | "relation-presence" | "relation-count";
```

`ruleSets` names rule sets alone. Where a table below narrows a fold to some slots of a rule set (a
case operation slot, the owner slot), `propose` reads the slot from `context` and answers undefined
outside them. `own-case-read` is one fold offered to both rule sets, whose two rows are its two
answers: `form-case` in a form slot, and `prop` in a case operation slot.

`reading.fold` asks each fold of the slot's rule set in table order and takes the first proposal, unless
the site is withdrawn (2.4). A proposer reads the syntax node's shape only as far as it needs to build a
proposal; it proves nothing. The print does (2.1). A proposer never looks at a name to decide: a
question called `nova_trimmed_x` is a question.

### 5.1 The literal folds

| Id | Rule sets | Shape | Proposal |
|---|---|---|---|
| `protected-literal` | both, every slot and every mode | in a `concat` call, a maximal run of two or more adjacent arguments that are each a string literal or `substr('\\', 0, 1)` | the run joined into one literal (each `substr('\\', 0, 1)` as one backslash); a `concat` left with one part is that part. Each run is its own fold site |
| `typed-literal` | record | an untyped string literal that is one side of a comparison, a bound of a `between`, a value of an `in` or a case of a `switch`, whose text `ruleSets.ts::literalShape` reads as a date or a date and time, where the operand it is compared with has the type `date` or `datetime`, or, in an ordering or a `between`, no known type | the same literal with `data_type` the shape's own type (`date` or `datetime`) |

**`protected-literal`.** Nova splits a literal in every mode: one holding both quote marks is split at
every `'` whatever the target (`serialize.ts::literalTokens`), and in the `xform`, `vellum` and
`hq-json` modes, `none` included, after `#` before `user`, `session/`, `case`, `parent` and `host`,
after `instance` before a bracket and at an ampersand that could unescape into one
(`::literalPieces`); an odd trailing backslash is written `substr('\\', 0, 1)` (`::literalTokens`). So
the fold is offered everywhere and proves nothing itself: the joined literal is printed, and where its
print is not exactly the run, the site is withdrawn and the run stays the separate arguments the
author wrote. `concat('a', 'b')` joins to `'ab'`, which prints `'ab'`, differs, and is withdrawn. A run
is joined whole or not at all, so `concat('x', <a literal holding both quote marks>)`, which Nova
prints as four literals in a row, reads back as four parts: nothing in the bytes says where one
literal ended. The row `literal-pieces` of 5.5 makes that the canonical tree, by the same rule over
the printer's own split.

**`typed-literal`.** Nova stores a date in a record slot as a typed literal
(`lib/agent/authoring/queryExpressions.ts`, `literal('2000-01-01', 'date')`), and every printer writes
a typed and an untyped string literal as the same bytes (`fromExpression.ts::term`, `case "literal"`;
`csql/emitter.ts::termValue`). The binder gives the untyped one, which the record rule set types as
text (`ruleSets.ts::literalType`): `dob > '2000-01-01'` is then `ordered-values` and
`dob = '2000-01-01'` is `incompatible-values`, for an HQ author's filter and for Nova's own emission
alike. Only form logic shapes a literal by itself (`typeChecker.ts::formLiteralsShaped`). The print
cannot choose between the two trees, so the rule in the table does, and it is deliberately the form
rule set's own rule narrowed to dates: a literal is typed by its own shape, never by the operand's
type, so a date against a date-and-time property is still the checker's `date-datetime` refusal (7.5).
A literal against a text, choice or number operand stays untyped. A number needs no fold: an untyped
number literal already types as `int` or `decimal`. A time-shaped literal is left as text, since
`time-ordering` refuses every ordering of a time in both rule sets. The fold is used by the CSQL
binder too (7.3). The row `literal-type` of 5.5 is the same rule over a stored tree.

### 5.2 Identity leaves

| Id | Rule sets | Shape | Proposal |
|---|---|---|---|
| `form-read` | both | an absolute path `/data/…` to a question or a repeat row's attribute | the same read with no stored spelling, the hashtag an author sees as `#form/…`; at one of `formReadToWire`'s two relocation sites (a `default_value` slot, or a row predicate that crosses a repeat the slot is in, `formReads.ts::crossesSourceRepeatInRowPredicate`), the same read spelled `current` |
| `own-case-read` | form | a path `instance('casedb')/casedb/case[@case_id = X]/<step>` where `X` is a session datum read, or the same shape again ending `/index/parent`, nested to any depth | `form-case { caseType, property }`: `caseType` the form's reachable type at the nesting depth (`reachableCaseTypes`: own 0, parent 1), `property` the step (`@case_id`, `@owner_id`, `@status` as the standard properties `rowValue` gives) |
| `own-case-read` | record, case operation slots | the same shape at depth 0 | `prop { caseType: <the module's>, property }` with no `via`, which the operation context prints anchored on the own-case datum |
| `worker-record-read` | both | `instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/<step>` | `formUserProperty(scope, <step>, "worker-record")`: the app's worker property of that slug by UUID, else the name-backed `session-user` leaf |
| `operation-id` | record, case operation slots | a path that, resolved from the slot's node, equals a key of `env.operationIdPaths` | `id-of { opUuid }` |
| `acting-user` | record, the owner slot | the absolute path `/data/meta/userID` | `acting-user` |
| `unowned` | record, the owner slot | the string literal `'-'` as the whole expression | `unowned` |
| `owner-at-level` | record, the owner slot | `instance('locations')/locations/location[@type = '<code>'][@<code2>_id = <owner read>]/@id` | `owner-location-at-level { levelUuid, ownerCaseType }`, the level whose code is `<code>` and the case type the owner read names |

What the plain binder already gives as identities needs no fold: a field by UUID with its spelling, a
session datum as the `DatumRef` that supplies the id, `session-context`, `session-user-property`, a
table read as `table-rows`, `table-lookup` and `table-column` by table and column id, the place list as
`locations` and `location-field`, a static choice as `choice` (`expressionAst.ts::choiceFor`), a
several-case datum as `selected-cases`, `jr:itext` as its unit and `jr:choice-name` as its question.

**Preloads.** `lib/domain/casePreload.ts::fieldPreload` reads a question's `default_value` as a preload
when it is exactly a `form-case` read. The `own-case-read` fold gives that leaf, so a default HQ's form
builder wrote from `#case/<property>` reads as the preload it is. HQ's other spelling of a preload, the
`case_preload` action map, is B4's: it writes the question's default as the `form-case` leaf directly and
registers no text.

**A read spelled `current()`** in the source binds with the spelling `current` and prints so. That is
how outline item 9's relocated reads, and a default's reads, come back: Nova printed them from
`current()`, and the tree read back says so (5.5, rows `default-current` and `row-predicate-current`).

**At a relocation site every read is stored `current`.** `formReadToWire` prints a read with no
spelling, or spelled `absolute`, as `current()/…` there. If the reader stored an HQ author's
`/data/q1` in a default as the hashtag, Nova would print `current()/../q1`, the re-read of that print
would bind `current`, and the document would differ from its own re-read, which acceptance check 3
refuses for every app with a default that reads a question. So the fold's proposal at those two sites
is already `current`: the exact print is `current()/…`; against an HQ author's absolute path it is
unequal, the withheld print writes the absolute path (2.3), and the slot is held at the second level
under `default-reads-current` or `row-predicate-current`. Read, emit and read again give one tree.

**A registration's own id** (`instance('commcaresession')/session/data/case_id_new_<type>_0`) stays the
`session-datum { new-case }` the binder gives. Both that and `form-case { <own>, case_id }` print the
same bytes; the datum is what the text says and it is already an identity. In a record slot (a case
operation's value or condition) that datum has no spelling in the record dialect
(`printQueryExpression.ts::queryPrinter` prints a `session-datum` only where
`chosenCase.ts::readChosenCaseId` reads it), so step 6 of 2.5 makes the slot not-yet with
`detail.reason` `dialect:session-datum`. A create's id is read there through `id-of` (the
`operation-id` fold), which is how Nova's own operations name it.

**A case another menu chose.** `casedb/case[@case_id = <datum of another menu's selection>]/p` is no
own-case walk: the proposal prints the own datum, differs, and is withdrawn. It stays a `project` over
`cases`, which in a record slot evaluated after that choice is the read
`lib/domain/expression/chosenCase.ts` builds and the checker admits.

### 5.3 Lowerings read back

| Id | Rule sets | Shape | Proposal |
|---|---|---|---|
| `absent-node-guard` | both | `if(count(P) > 0, P, '')` with `P` a session context path | the bound `P` |
| `search-text` | form | `if(count(P) > 0, P[1], '')` with `P` the path `instance('commcaresession')/session/data/stringquery` | `case-list-search-text` |
| `empty-rows-guard` | both | `if(count(R) > 0, X, E)` where `R` is `instance(<id>)/<root>/<row>` with no predicate, and `E` is `''` or `0` (`emptyRows.ts::guardRead`) | the bound `X` |
| `handed-on-rows-guard` | form | `if(count(R) = 0 and string(coalesce(<earlier>, '')) = '', 0, X)`, the inverted guard `emptyRows.ts::guardNodeSetConsumer` writes for a `sum` behind a `coalesce` (`::allBlank`); several `string(coalesce(…)) = ''` tests where the set passes through more than one `coalesce` | the bound `X` |
| `cond` | record | a call `cond(c1, v1, …, cn, vn, d)` with an odd count of three or more arguments | `if(c1, v1, if(…, if(cn, vn, d)))`, each `c` bound as a condition and each `v` and `d` as a value. It prints `if`, which S1 compares with the source's `cond` |
| `checklist-guard` | form | each shape `emptyRows.ts::guardChecklistPair` writes around a `weighted-checklist` (the call moved into the branches of an `if` or `cond`, and the joint guard over two paths) | the bound call |
| `instant-comparison` | both | a comparison whose two sides are each a sum ending in the fraction term `instantMicros` writes, or one such side against an integer literal | the same comparison over the unwrapped operands (below) |
| `is-blank` | both | `string-length(string(X)) = 0` | `is-blank { left: X }` |
| `normalize-space` | both | `replace(replace(X, '[ \t\r\n]+', ' '), '^ \| $', '')` | `call normalize-space [X]` |
| `quotient` | record | `if(R = 0, L div R, (L - L mod R) div R)` | `arith quotient L R` |
| `date-add` | record | `date(floor(B + Q))`, `date(floor(B + Q * 7))`, `date(floor(B + Q div 24))`, `div 1440`, `div 86400` | `date-add { date: B, interval, quantity: Q }` with the interval of the scale: `days`, `weeks`, `hours`, `minutes`, `seconds` |
| `datetime-value` | record | the value spellings of `instant.ts::datetimeCoerceValue`: a date's UTC midnight under a blank guard, `typedInstantValue`, a day number's midnight | `datetime-coerce { value }` |
| `when-input-present` | record | `if(count(I), X, true())` with `I` a search answer read | `when-input-present { input, clause: X }` |
| `in` | record | an `or` chain of two or more `=` comparisons that share one left operand, each right a literal | `in { left, values }` |
| `between` | record | an `and` of a `>=` or `>` and a `<=` or `<` that share one left operand | `between` with the two bounds and their inclusiveness |
| `switch` | record | `if(O = c1, t1, if(O = c2, t2, … f))` with two or more tests that share `O`, each `c` a literal | `switch { on: O, cases, fallback: f }` |
| `relation-property` | record | `instance('casedb')/casedb/case[@case_id = <ctx>/index/<id>]/p`, or the same with `and @case_type = '<T>'` in the predicate, nested for further hops, where `<ctx>` is the row (`current()` or the context) | `prop { property: p, via: { kind: "ancestor", via: [{ identifier: id }, …] } }`, a step taking `throughCaseType: T` exactly where the source holds the type test. A step whose identifier is not `parent` and whose source holds no type test gets no proposal (6.3) |
| `relation-presence` | record | `count(index/<id>) > 0 and selected(join(' ', <ids>), index/<id>)`, and its `not(…)` | `exists` or `missing` with the `via` and `where` the join's filter binds to |
| `relation-count` | record | `count(instance('casedb')/casedb/case[index/<id> = <anchor>][…])` and `if(<presence>, 1, 0)` | `count { via, where }` |

**The instant comparison, operand by operand.** `instantMicros(T)` reads one operand text `T`
throughout its tree; the proposer takes the first argument of the `substr` inside the fraction term as
`T` (the place `instantParse.ts::instantMicrosOperand` reads it) and unwraps `T` by the classes of
`instantOperand.ts`, one row per spelling `instant.ts::leafText` and `::operandText` write:

| `T` in the source | Written by | Operand proposed |
|---|---|---|
| `format-date(coalesce(X, ''), '%Y-%m-%dT%H:%M:%S.%3%Z')` | `typedInstantText`: the class `typed`, and `unknown` where Core holds a date | `X` |
| `concat(format-date(coalesce(X, ''), '%Y-%m-%d'), 'T00:00:00Z')`, bare, and as the last argument of `if(X = '', '', …)` inside a `coalesce` | `typedDateMidnight`, with `blankGuard`: the class `coerced-date-typed` | `datetime-coerce` of the typed date `X` |
| `concat(X, 'T00:00:00Z')`, bare, and under the same `if(X = '', '', …)` inside a `coalesce` | the class `coerced-date-text` | `datetime-coerce` of the date text `X` |
| `if(string-length(X) = 10, concat(X, 'T00:00:00Z'), X)` | `coercedTextInstant`: the class `coerced-text` | `datetime-coerce` of the text `X` |
| `concat(format-date(date(X), '%Y-%m-%d'), 'T00:00:00Z')`, bare, and under the same `if(X = '', '', …)` | `epochDayMidnight`: the class `epoch-days` inside a branch | `datetime-coerce` of the day number `X` |
| `X * 86400000000` in place of the whole parse | the class `epoch-days` as a direct operand | `datetime-coerce` of the day number `X` |
| `if(C, T1, T2)`; `coalesce(T1, …)`; the nested `if` chain of a `switch` | `operandText` | the `if`, `coalesce` or `switch` over the unwrapped branches |
| a string literal as a branch | `literalText` (`instantOperand.ts::literalInstantText`) | that literal, as written |
| any other `X` | the classes `text`, `not-instant`, and `unknown` holding text | `X` |

`datetime-coerce` is a record arm, and form logic has no spelling of it
(`lib/domain/expression/CLAUDE.md`, "The clock-keeping date"), so the five rows that propose it are
offered in the record rule set alone; in a form slot those spellings are text Nova's emitter never
writes, and they bind plainly as the calls they are. Every proposal is judged by the print: one whose
class the print does not reproduce is withdrawn like any fold, and run E5 (outcome C) names any
spelling the emitter writes that no row reads.

An integer literal opposite a lowered side is a folded literal. No function turns microseconds into
text today (`literalInstantText` reprints a literal's own text), so B6 adds its inverse beside it:

```ts
// lib/domain/expression/instantOperand.ts
/** The canonical literal text of a moment: UTC, `YYYY-MM-DDTHH:MM:SS.fffZ`, with three fraction
 *  digits where the microseconds are whole milliseconds and six otherwise. Where the UTC year is past
 *  9999, the same moment in the smallest whole-hour offset behind UTC that keeps a four-digit year
 *  (`-01:00` to `-99:00`, the two digits `literalInstantMicros` reads). Undefined where neither
 *  spelling has a four-digit year, or for a count that is not a safe integer. */
export function instantTextOfMicros(micros: number): string | undefined;
```

Its law, held by `instantTextOfMicros.test.ts` over generated moments and the edges of the years 0000
and 9999: `literalInstantMicros(instantTextOfMicros(m)) === m`, and
`literalInstantText(instantTextOfMicros(m)) === instantTextOfMicros(m)`. The proposer writes the
integer back as that text (typed `datetime` in a record slot, by 5.1's rule); the print folds it again
to the same integer. So Nova's `'9999-12-31T23:59:59-05:00'`, whose UTC moment is in the year 10000,
reads back as `'9999-12-31T23:59:59.000-05:00'`, and the row `instant-literal` of 5.5 makes that text
canonical for every literal of the moment. Where the function answers undefined the proposal is not
made and the comparison stays the integer arithmetic it is in the text, held exact; no literal Nova's
checker admits folds to such a moment (`literalInstantMicros` reads a four-digit year and a two-digit
offset).

A comparison by day (`date_opened >= date(X)`) is bare in Nova's print and binds plainly.

**Where a proposal is right only in one position.** Nova guards a value read and leaves a node-set read
bare (`fromExpression.ts::emitExpression`, the `use`). A guard the source holds where Nova writes none
(inside `count`) proposes the bare read, prints without the guard, differs, and is withdrawn: it stays
the `if` the author wrote. The same holds for a `switch` whose literals the slot's types do not admit
as cases: the print (or, later, the checker) decides, never the proposer.

**The three shapes of the empty-rows guard.** `emptyRows.ts` writes the guard three ways, and each
reads back:

- Around a value read or a consumer: `if(count(R) > 0, X, E)`, the `empty-rows-guard` row.
- Behind a `coalesce`: `sum(coalesce(e, A))` over rows `R` prints
  `if(count(R) = 0 and string(coalesce(e, '')) = '', 0, sum(coalesce(e, A)))`, the
  `handed-on-rows-guard` row.
- Moved into the branches of a lazy call: `sum(if(c, A, B))` prints
  `if(c, if(count(RA) > 0, sum(A), 0), if(count(RB) > 0, sum(B), 0))`
  (`guardNodeSetConsumer`, the `evaluation: "lazy"` arm), and over reads that need no guard
  `if(c, sum(A), sum(B))`. No fold moves the consumer back out: the `empty-rows-guard` row reads each
  branch, and the tree read is `if(c, sum(A), sum(B))`, which prints those same bytes. That is a
  print collision between two Nova trees, and 5.5's row `consumer-in-branches` makes the one the
  reader gives canonical. `weighted-checklist` has its own row because its guard is joint.

### 5.4 What the folds do to an HQ author's own text

An `or` of equalities an HQ author typed reads as `in`; a nested `if` on one subject as `switch`; a
bounded pair of orderings as `between`. Each prints the bytes the author wrote, so nothing changes at
CommCare HQ, and the builder shows the one card Nova has for the meaning ("is any of", a lookup of
cases, a range). This is the reader reading "each spelling of one meaning into Nova's one concept" in
the one place it costs nothing.

### 5.5 The canonical tree of a Nova document

Two Nova trees can print the same bytes: an author can build `or(eq(a, 'x'), eq(a, 'y'))` where
another builds `in(a, ['x', 'y'])`. The reader returns the folded one. So proof 6 compares a read of
Nova's own export with the canonical form of the document, and that form is defined independently of
the reader, or the proof would hold nothing:

```ts
// lib/commcare/reader/expressions/canonical.ts
/** One row: a tree shape and the canonical tree that prints the same bytes in this slot. */
export interface PrintCollision {
	readonly id: string;
	rewrite(node: Expression, context: ExpressionContext): Expression | undefined;
}
export const PRINT_COLLISIONS: readonly PrintCollision[];
/** Every collision applied bottom-up until none applies. It never parses and never prints. */
export function canonicalExpression(expression: Expression, context: ExpressionContext): Expression;
```

Each row is a rewrite over the typed tree. A test prints both trees of every row in a real slot and
requires equal bytes, so a canonicalization can never hide a difference a runtime reads. Part 09's
`lib/commcare/reader/canon.ts` (B7, its section 9) wraps `canonicalExpression` as the canonicalization
`expression-print-collisions`, and proof 6 (part 14, section 5.5, B13) reaches it through that file's
`canonDocument`; this part adds no row to part 06's `READER_CANONICAL_CHOICES` (its section 16.2).
The reader's own answer is always canonical: `canonicalExpression(read(A)) = read(A)` for every held
slot, which `expressionReadBack.fixedPoint.test.ts` holds over HQ-authored texts and E5 over Nova's.

A row that depends on how the slot prints reads the mode from
`readExpression.ts::slotReadMode(doc, ref): ReadMode`, the mode the production emitter prints that slot
in (the table of 6.1 read from Nova's side; `xform` with `constraint` for a `validate` slot). It is the
function step 4 of the method prints with, and `slotMode.test.ts` holds it to the emitter: for every
expression slot of the corpora, the `HqXPath` `expandDoc` builds for it carries that interpolation. A
registration's own `mode` says how HQ rewrites the text of the key it came from; step 1 of the method
uses that for HQ's text and step 4 uses `slotReadMode` for Nova's print, and where the two differ the
trees do, so the slot is `unrecognized`, which is the truth: Nova would write that slot another way.

| Row | Canonical | Also prints the same |
|---|---|---|
| `field-spelling` | a question read with no stored spelling (the hashtag) | the same read spelled `absolute`, outside the two relocation sites below |
| `default-current` | in a `default_value` slot, a question read spelled `current` | the same read with no spelling or spelled `absolute` (a `relative` read prints relative and is no part of this row) |
| `row-predicate-current` | a question read spelled `current`, where `formReads.ts::crossesSourceRepeatInRowPredicate` holds | the same read with no spelling or spelled `absolute` |
| `literal-type` | in a record slot, a date-shaped or date-and-time-shaped string literal typed by its own shape, under 5.1's rule for `typed-literal` | the same literal untyped |
| `instant-literal` | a literal that is a direct operand of a comparison `comparisonPlan` lowers, spelled `instantTextOfMicros(literalInstantMicros(text))`; a literal branch of such an operand, spelled `literalInstantText(text)` | any other literal of the same moment (a direct operand); the same date, clock and offset written with fewer digits (a branch) |
| `consumer-in-branches` | `if(c, sum(A), sum(B))`, and the same for `cond` | `sum(if(c, A, B))`, `sum(cond(…))`: `emptyRows.ts::guardNodeSetConsumer` moves the call into each branch |
| `filter-identities` | the case list filter as `effectiveFilterForEmission` gives it, absent where that is all-true | the same filter holding `match-all` in an `and`, `match-none` in an `or`, or any other identity `simplifyForEmission` drops |
| `membership` | `in` | an `or` of equalities on one operand, in a record slot |
| `range` | `between` | an `and` of two orderings on one operand, in a record slot |
| `switch` | `switch` | a nested `if` of equalities on one operand, two or more deep, in a record slot |
| `blank` | `is-blank(x)` | `eq(call string-length [call string [x]], 0)` |
| `normalize-space` | `call normalize-space [x]` | the two nested `replace` calls |
| `quotient` | `arith quotient` | the `if` over `div` and `mod`, in a record slot |
| `date-add` | `date-add` | `date-coerce` of `call floor` of a sum, in a record slot |
| `own-case` | `form-case` | a `project` over a `cases` query keyed on the own-case datum, in form logic |
| `worker-record` | the worker-record leaf | a `project` over the usercase `cases` query |
| `session-guard` | a session context read, the search text arm | its own count guard built as an `if` |
| `rows-guard` | a value read or a consumer of a data-built instance | its own guard built as an `if`, in either the plain or the handed-on shape |
| `literal-pieces` | a literal outside a `concat`: itself. Inside a `concat`: each literal argument replaced by the pieces `serialize.ts::literalTokens(value, mode, true)` splits it into, then each maximal run of adjacent literal arguments joined into one literal exactly where `literalTokens` of the joined text is that run, and left as the separate pieces otherwise; a `concat` left with one part is that part. `serialize.ts` exports `literalTokens` for this row alone | a `concat` of the pieces the printer would split a literal into; in a `concat`, two adjacent literals, or a literal beside a literal the printer splits |
| `input-presence` | `when-input-present` | `if(count(input), clause, match-all)`, in a record slot |
| `instant` | a comparison of two dates and times | the lowered arithmetic built from calls |

Run E5 holds `read(print(D)) = canonicalExpression(D)` slot by slot. A pair this table lacks is that
run's outcome B, which says what lands.

---

## 6. Record slots

### 6.1 HQ's interpolation, as a lexer in front of the grammar

HQ does not parse these slots. `xpath.py::interpolate_xpath` replaces five substrings wherever they
occur, inside string literals too, and `::dot_interpolate` then walks the characters, tracking only
whether it is inside a quoted string, and replaces a bare dot. The device runs the result. So the text a
runtime reads is a function of HQ's text that only this exact procedure computes: a literal holding
`#case` is not a literal by the time Core sees it, and Nova's own emitter splits such literals for that
reason. The port reproduces the procedure. It is not a regex over XPath and it is not a parser: it
recognizes no expression structure, makes no decision about meaning, and hands its output to the Lezer
grammar, which is the only thing that reads XPath.

```ts
// lib/commcare/reader/hqInterpolation.ts
export interface HqInterpolationSlot {
	/** HQ's `case_xpath`; absent where HQ passes none. */
	readonly caseXPath?: string;
	/** False for a search field's validation test. */
	readonly interpolateDots: boolean;
}
export type HqInterpolated =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly reason: "case-reference" | "fixture-value" };
export function interpolateHqXPath(text: string, slot: HqInterpolationSlot): HqInterpolated;
export function dotInterpolate(text: string, replacement: string): string;
export const HQ_USERCASE_XPATH =
	"instance('casedb')/casedb/case[@case_type='commcare-user']" +
	"[hq_user_id=instance('commcaresession')/session/context/userid]";
export function hqCaseByIdXPath(id: string): string; // `instance('casedb')/casedb/case[@case_id=${id}]`
/** HQ's text as a runtime reads it: interpolated for the slot, then parsed. `text` is the
 *  interpolated text the tree's spans index. `slot` undefined: a slot HQ does not interpolate. */
export function syntaxOf(
	text: string,
	slot: HqInterpolationSlot | undefined,
):
	| { readonly ok: true; readonly syntax: FormSyntax; readonly text: string }
	| { readonly ok: false; readonly reason: "syntax" | "case-reference" | "fixture-value" };
/** The slot of the table below for a registration whose mode HQ interpolates. Undefined in one
 *  case: mode `case` on a form Nova's projection gives no case-selecting datum. A registration of
 *  mode `none` passes undefined to `syntaxOf` without calling this, and an image map's key
 *  (`enum-key`) is dot-interpolated by its own reader (the table's row). */
export function hqInterpolationSlot(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	interpolation: Exclude<HqInterpolation, "none" | "enum-key">, // lib/commcare/hqJson/xpath.ts
): HqInterpolationSlot | undefined;
```

The file lands in B2 with its Vitest file, since B4 and B5 call `syntaxOf`, `dotInterpolate` and
`hqInterpolationSlot`. It imports `formSyntax.ts`, and for `hqInterpolationSlot` the document's types,
`hqJson/xpath.ts::HqInterpolation` and `formLinkProjection.ts::entrySessionDatums` and
`::entryDatumIds`; it imports nothing of the reader. B6 adds nothing to it but what run E2 corrects.

`interpolateHqXPath`, step for step as `interpolate_xpath`:

1. Where the text contains `$fixture_value`: `{ ok: false, reason: "fixture-value" }`. HQ replaces it
   only for a menu with `fixture_select` on, which the manifest refuses
   (`forms-and-case-writes/form-filter-using-fixture-value`).
2. Where `caseXPath` is absent (`_ensure_no_case_references`): `{ ok: false, reason:
   "case-reference" }` when the text contains `#case`, `#parent` or `#host`, or when
   `interpolateDots` holds, the text has a dot whose neighbors are not decimal digits, and
   `dotInterpolate(text, "") !== text`.
3. Replace, in this order, every occurrence, each over the result of the one before, with
   `String.prototype.replaceAll` given a string, never a `RegExp`: `#user` by `HQ_USERCASE_XPATH`;
   `#session/` by `instance('commcaresession')/session/`; and, where `caseXPath` is present, `#case` by
   `caseXPath`, `#parent` by `hqCaseByIdXPath(caseXPath + "/index/parent")`, `#host` by
   `hqCaseByIdXPath(caseXPath + "/index/host")`.
4. Where `caseXPath` is present, `dotInterpolate(result, caseXPath)`.

`dotInterpolate(text, replacement)`, as `dot_interpolate`, over the text's code points (Python indexes a
string by code point, so the port iterates `Array.from(text)`):

- a state `quote`, empty at the start;
- at a backslash: copy it and the next code point, and move two on;
- inside a quote: copy the code point, and leave the quote when it equals `quote`;
- outside a quote, at `'` or `"`: enter that quote and copy it;
- outside a quote, at `.`: when the code point before it is absent or is not a decimal digit, and the
  one after it is absent or is not a decimal digit, append `replacement`; otherwise copy the dot;
- otherwise copy.

"Decimal digit" is Unicode category Nd, what Python's `\D` excludes for a string: `/^\p{Nd}$/u` on the
one code point, the only pattern in the file. The neighbors are the raw code points beside the dot, as
`string[i - 1]` and `string[i + 1]` are, whatever the scanner's state.

Which slot gets which call, read from every caller of the two functions:

| HQ slot | Call | `caseXPath` | Dots | Nova's mode |
|---|---|---|---|---|
| `module_filter` | `suite_xml/sections/menus.py`, the relevancy block | none | checked | `no-case` |
| `form_filter`, a form that requires a case | `menus.py::MenuContributor._get_commands` | `hqCaseByIdXPath("instance('commcaresession')/session/data/<id>")`, `<id>` the datum of the case chosen last (`suite_xml/sections/entries.py::EntriesHelper.get_case_session_var_for_form`: the last of `get_case_datums_meta_for_form`, the datums that hold a case type and need a selection, so no generated one). The reader takes the last entry of `formLinkProjection.ts::entrySessionDatums` for the form that selects a case, and its id from `entryDatumIds`. On a form whose last chosen case is not its menu's (an advanced form's later load), that is the later case, as in HQ | replaced | `case` |
| `form_filter`, any other form | the same | none | checked | `no-case` |
| `case_details.short.filter` | `suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath` | `current()` | replaced | `case` |
| a search field's `required.test` | `suite_xml/post_process/remote_requests.py` | none | checked | `no-case` |
| a search field's `validations[].test` | the same | none | not read | `no-dots` |
| an image map's key | `models/case_list.py::MappingItem.key_as_condition`, whose one call is `dot_interpolate(key, <property>)`: no `interpolate_xpath`, so no slot of this type. Its reader calls `dotInterpolate(key, <the column's property path>)` (part 07, section 11.2) | none | replaced by the property | `enum-key` |
| every other expression slot of the JSON | none | | | `none` |

The comparison applies the same call to Nova's HQ print and to HQ's text, so the two trees compared are
the two suite expressions. `hqInterpolation.ts::hqInterpolationSlot(doc, ref, interpolation)` builds
the `HqInterpolationSlot` of a slot from this table. Where a registration's mode is `case` and Nova's
projection gives its form no case-selecting datum, HQ's text cannot be interpolated as HQ would: the
function answers undefined, the slot is `unrecognized` with `detail.reason` `no-case-datum`, and the
frame records C12 beside C9 (Copy). That Nova's HQ print interpolates to Nova's suite print is held
by HQ's own build in lane proofs 2 and 3 for the documents of the corpus, and, slot by slot, by the
second case run E2 adds to `proof/native/test_hq_interpolation.py`, which today holds only that
HQ's helpers leave Nova's protected literals unchanged.

### 6.2 Reading a record slot

A record slot is read by `parseFormExpression` with the reading hook, like a form slot. What differs is
what `slotContext` gives:

| Slot | Row in scope | Form answers | What a relative step names |
|---|---|---|---|
| a menu's display condition, a search's button condition, excluded owners, a field's starting value, required and validation tests, a hidden value | none | no | nothing: a bare name is refused `relative-no-context` |
| a form's display condition, on a menu that chooses a case first | the module's case, `casedb` | no | a property of that case |
| the case list filter, a calculated column | the module's case, `casedb` | no | a property of the listed case; `current()` is that case |
| an advanced Search field's condition | the module's case, `results` | no | (read through CSQL, section 7) |
| a choice list's row filter | the table's row, or the candidate case | yes | a column of the table, or a property of the candidate |
| a Search field's choices filter | the table's row | no | a column of the table |
| a case operation's value, condition, name, owner, target | the module's case, `casedb` | yes | a question, through the form graph |

The folds a record slot is offered are those whose `ruleSets` hold `record` (5.2, 5.3). The arms a
record slot's text can bind to are therefore: literals; `prop` with and without `via`; `term`s for
session context, session user data, session datums, search answers, table columns and place fields;
`and`, `or`, `not`, the six comparisons, `in`, `between`, `is-blank`; `if`, `switch`, `coalesce`,
`concat`, `arith` with `quotient`, `negate`; `today`, `now`, `date-coerce`, `datetime-coerce`, `double`,
`date-add`, `format-date`; `match` in `starts-with` mode; `multi-select-contains`; `count`, `exists` and
`missing` over a relation; `table-lookup`; `when-input-present`; `here`; the chosen case's `project`;
and in a case operation slot `field`, `id-of`, `acting-user`, `unowned` and the owner's place.
`match-all` and `match-none` bind from `true()` and `false()`.

A literal is untyped as bound, and typed by the `typed-literal` fold where it stands against a date or
a date and time (5.1). `cond` binds to `if` through its fold (5.3). Any other function call that binds
to none of these binds as `call`, which the record checker refuses (8.1), or is unknown to Core and
refused by the hook (4.2).

### 6.3 `#parent`, `#host` and relation walks

After interpolation, `#parent/p` in the case list filter is
`instance('casedb')/casedb/case[@case_id=current()/index/parent]/p`, and in a form's display condition
the same with the own-case path in place of `current()`. That is the tree
`wire/rowScope.ts::buildAncestorJoinNodeset` builds for `prop { property: p, via: { kind: "ancestor",
via: [{ identifier: "parent" }] } }`, so the `relation-property` fold is accepted by print.

`#host/p` is not held in step 6. It interpolates to the same text with `index/host`
(`xpath.py::interpolate_xpath`: `CaseIDXPath(case_xpath + '/index/host').case()`), with no case type
test. Nova cannot write that text for a `host` step: the checker refuses a step other than `parent`
that names no type (`relationDestination.ts`, `relation-destination`: "`parent` is the only relation
identifier the `CaseType.parent_type` graph can infer", `lib/domain/expression/CLAUDE.md`), and a step
that names one prints the test `and @case_type = '<T>'` (`rowScope.ts::caseById`), which narrows the
read to hosts of that type and is not what the app does today. So the fold makes no proposal for an
untyped step that is not `parent`, the read stays the binder's `project` over `cases`, the record
checker refuses that arm, and the slot claims its HELD-NEW entry with `detail.reason` `relation:host`
(9.2), owner as the slot's. The form's display condition names exactly this class in its id
(`forms-and-case-writes/form-filter-outside-predicate-parent-host-user-usercase-reads`). Nova's own
emission of a typed custom step carries the type test and reads back through the same fold with its
`throughCaseType`. Holding `#host` waits on an index whose case type the catalog knows, which is the
relation work of step 7's `case-list-and-detail` and `menus` groups.

A bare dot becomes the case path, so `. = 'x'` reads as a comparison of the case node itself. No arm
holds a case node as a value; it fails to bind (`row-step-after-value`) and claims the slot's HELD-NEW
entry (9.2).

`#user/p` in a record slot becomes the usercase selector and folds to the worker-record leaf. Whether a
record slot admits that leaf is the checker's verdict; where it refuses, the claim is
`forms-and-case-writes/user-prop-in-module-filter-form-filter-case-list-slots-the` (9.2).

`#session/…` becomes the session path and binds as the binder binds it.

---

## 7. Search filter rows

### 7.1 What a row is

A `search_config.default_properties[]` row keyed `_xpath_query` holds on-device XPath whose value at run
time is one CSQL string. HQ interpolates nothing in it (no caller of `interpolate_xpath` reads
`defaultValue`). Reading one is three steps: reduce the wrapper to CSQL text with holes, parse that text
with the same grammar, bind it under the row's slot context.

```ts
// lib/commcare/reader/expressions/csqlRead.ts
export type SearchRowReading =
	| { readonly ok: true; readonly predicate: Expression; readonly level: "exact" | "guards";
			readonly rewrites: readonly EmissionRewriteId[] }
	| { readonly ok: false; readonly claim: { readonly entryId: string; readonly detail: FindingDetail } }
	| { readonly ok: false; readonly unrecognized: true };
export interface SearchRowEnv {
	readonly doc: BlueprintDoc;
	readonly lookup: LookupDefinitionIndex;
}
export function readSearchFilterRow(
	text: string,
	context: ExpressionContext, // of the slot the caller proposes: the filter's or an advanced field's
	env: SearchRowEnv,
): SearchRowReading;
```

### 7.2 The skeleton

`skeleton(S)` walks the wrapper's syntax tree and gives a sequence of constant text and holes. It is a
proposer in the sense of section 5: it drops what Nova's printer re-derives, and the print proves it.

| Wrapper node | Skeleton |
|---|---|
| a string literal | its text |
| `concat(a1, …, an)` | the skeletons of the arguments, in order |
| `if(count(I), X, 'match-all()')` at the row's root, `I` a search answer read | `presence(I, skeleton(X))` |
| `if(G, 'match-none()', X)` | `skeleton(X)`: the guard is an obligation Nova derives again |
| `if(contains(V, '"'), if(contains(V, "'"), 'match-none()', A), B)` where `A` and `B` are concats that differ only in the quote mark beside `V` | `B`'s skeleton with `V` as a quoted hole |
| `if(contains(V, '"'), concat("'", V, "'"), concat('"', V, '"'))` | a quoted hole `V` |
| `if(C, A, B)`, any other | `choice(C, skeleton(A), skeleton(B))` |
| anything else | a bare hole holding the node |

The text is assembled with each hole as a marker. The marker is `__nova_hole_<n>__` with as many extra
leading underscores as it takes for no constant text of the row to contain it, so it lexes as a name
outside a string and is a substring inside one. A quoted hole is written between double quotes.

Both functions are private to `csqlRead.ts`:

```ts
type SkeletonPart =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "hole"; readonly node: FormSyntax; readonly quoted: boolean }
	| { readonly kind: "presence"; readonly input: FormSyntax; readonly body: readonly SkeletonPart[] }
	| {
			readonly kind: "choice";
			readonly condition: FormSyntax;
			readonly then: readonly SkeletonPart[];
			readonly otherwise: readonly SkeletonPart[];
	  };
/** The table above, over the wrapper's syntax tree. */
function skeleton(wrapper: FormSyntax): readonly SkeletonPart[];
/** Section 7.3: assembles each run of text and holes, parses it with `readFormSyntax` and binds it
 *  under `context`; a `presence` or `choice` part binds its bodies by the same call. */
function bindCsql(
	parts: readonly SkeletonPart[],
	context: ExpressionContext,
	env: SearchRowEnv,
): Expression | { readonly entryId: string; readonly detail: FindingDetail };
```

### 7.3 Binding CSQL

CSQL is XPath syntax: HQ parses it with `eulxml` and reads the tree in
`case_search/filter_dsl.py::build_filter_from_ast`. `readFormSyntax` parses the assembled text, and
`bindCsql` binds it to the record arms. The function set is HQ's two tables at the pin
(`xpath_functions/__init__.py`), which `functionCapabilities.ts::CSQL_VALUE_FUNCTIONS` and
`::CSQL_QUERY_FUNCTIONS` already hold.

| CSQL | Arm |
|---|---|
| `a and b`, `a or b`, `not(a)` | `and`, `or`, `not`; a `not` of a relation function proposes `missing` first |
| `match-all()`, `match-none()` | `match-all`, `match-none` |
| `<anchor> OP <value>` | the comparison; `(p >= v and p <= v)` on a date-and-time property proposes `eq` first, and `p = ''` proposes `is-blank` first |
| an anchor: a name; `@case_id`, `@owner_id`, `@status`; `@case_type`; `a/b/p`; `a/@case_id` | `prop` of the row; the standard properties; `case-row-type`; `prop` with an `ancestor` path of the leading steps; the ancestor's id |
| a value: a string or a number, `-n` | a literal; a date-shaped or date-and-time-shaped string against a `date` or `datetime` anchor, or in an ordering against an anchor of no known type, is typed by the `typed-literal` rule of 5.1 |
| a value: a string that is one hole | the hole's wrapper node, bound as device XPath under the same context (the bind `readExpression` makes, over the node's own source text, with the reading hook of 4.2, no form's maps, and the suite mode for its print), which is a runtime value |
| a value: a string holding text and holes | `concat` of the text and the bound holes |
| `date(v)`, `datetime(v)`, `double(v)`, `now()` | `date-coerce`, `datetime-coerce`, `double`, `now` |
| `today()` in the constant text | `today`, and the rewrite `search-today-device-day` (7.4, 7.5) |
| `date-add(d, '<interval>', n)`, `datetime-add(…)` | `date-add` with that interval, over a date or a date and time |
| `unwrap-list('<json>')` | `value-list`: the JSON array's strings as literals, a hole inside the array as a runtime item |
| `selected(p, v)`, `selected-any(p, v)`, `selected-all(p, v)` | `multi-select-contains`, `any` or `all`; a literal `v` proposes its whitespace-separated tokens as the values first, then the one value |
| `starts-with`, `fuzzy-match`, `phonetic-match`, `fuzzy-date` | `match` with that mode |
| `within-distance(p, center, distance, '<unit>')` | `within-distance` |
| `subcase-exists('<id>'[, q])`, `ancestor-exists(<path>, q)` | `exists` over a `subcase` or `ancestor` path |
| `subcase-count('<id>'[, q]) OP n` | a comparison of `count` over the `subcase` path |
| a `choice` segment | `if` whose condition is the bound device node and whose branches are the bound texts |
| `presence(I, X)` | `when-input-present { input, clause }` |

What does not bind, and the entry it claims:

| CSQL | Entry |
|---|---|
| a marker where a property name, an operator or a function name stands, or text that parses only with a hole outside a value position | `case-search/property-names-operators-or-function-names-computed-at-runtime` |
| a function call as the second or a later argument with no parentheses around it | `case-search/a-function-call-written-unparenthesized-as-the-2nd-or-later` |
| a function on the left, a property on the right, arithmetic, a union, a variable, an absolute path, a function outside HQ's two tables, a step with no operator | `case-search/a-function-on-the-left-side-a-property-on-the-right-side` |
| a hole whose device node is a casedb, table or place query other than the chosen case's property | `case-search/a-search-value-that-queries-cases-a-table-or-places` (new, section 11) |

### 7.4 Acceptance

- **Exact.** `emitCsql(predicate, context).wrapper`, printed in HQ JSON mode `none`, is the same tree as
  the source row (section 3). Every row Nova wrote is exact: its quote cascades, its blank-comparand
  guards on the three system dates, its `'match-none()'` for a value holding both quote marks, its
  presence cascade.
- **Guards.** Otherwise, the candidate's own CSQL (`printCsql` of its tree, as text with the same
  markers) and the source's skeleton text parse to the same tree, and hole for hole the device values
  are the same tree, where a candidate hole whose value is a `concat` is spread into its parts. Then the
  CSQL HQ receives for every value the original could send is the same, and what differs is the wrapper:
  Nova's choice of quote mark and its obligations. The row is held with the rewrite
  `search-value-guards`.

  One difference of shape is admitted at this level, and it is the whole of `search-today-device-day`.
  Nova sends the day as a value the device works out, so its own CSQL holds a quoted hole where HQ's
  text holds the call (`csql/emitter.ts::runtimeHole` gives `today` the `quote-free` quoting, and
  `print.ts::hole` writes `"`, the value, `"`): the candidate's text is `p > "<hole>"` and the source's
  is `p > today()`. A candidate hole whose device value is exactly the call `today()` equals a source
  call `today()` with no arguments in the same position. HQ answers that call with a date as text
  (`value_functions.py::today`: `strftime(ISO_DATE_FORMAT)`), so both sides compare the property with
  a date string; the day is the project space's on one side and the worker's on the other, which is
  what the rewrite declares. The row is then held with `search-today-device-day`, and with
  `search-value-guards` only where another hole differs in its wrapper.
- **Neither.** `unrecognized`.

An HQ author's `concat('name = "', instance('search-input:results')/input/field[@name = 'name'], '"')`
is held at the second level: the same CSQL, with Nova's quote cascade around it on publish.

### 7.5 Days

**A date against a system date stays not-yet.** HQ reads `date_opened`, `closed_on` and `last_modified`
against a date as the project space's day (`xpath_functions/comparison.py::_create_system_datetime_query`,
`::adjust_input_date_by_timezone`, `get_timezone_for_domain`). Nova's search has no arm for a project
space's day, and no read an API key opens gives the time zone, so neither Preview nor Postgres could
evaluate what the document would hold. Reading it as the UTC day Nova's own searches use would move
which cases match by the project space's offset, for every project space off UTC. The reader needs no
rule of its own for this: the `typed-literal` fold types the date string as a date (5.1; without it
the literal would be text and the refusal would be `ordered-values` or a bare `incompatible-values`,
which names nothing), the bound comparison is then a date against a date-and-time property, the record
checker refuses it (`incompatible-values`, reason `date-datetime`, under `=` and under an ordering
alike), and section 9.2 maps that refusal on one of the three properties in a search row to
`case-search/date-only-comparison-on-date-opened-closed-on-last-modified`, which stays HELD-NEW with
owner `case-search`. Its cell is re-worded (section 11). Step 7 holds it once a project space's time
zone is a fact Nova can read or a person states.

**`today()` in the search's text is read as `today`.** HQ's `today()` is the project space's day
(`value_functions.py::today`); Nova's `today` in a search is the worker's
(`searchRuntimeValues.ts`). They differ only for a worker whose device is not on the project space's
day. The reader holds the comparison, the candidate prints the device's `today()` as a runtime value
between quote marks, the guards level of 7.4 equates that hole with HQ's call, and the reading reports
`search-today-device-day`. Where the anchor is one of the three system dates the rule above already
refuses it.

### 7.6 Rows as one conjunction

HQ joins every `_xpath_query` value with `and` (`case_search/utils.py::_apply_filter`). Nova writes its
rows from three sources (`composeXPathQueryClauses`): the case list filter, each advanced Search field's
condition, and each simple field's derived match, one row per top-level conjunct. Part 07 reads the
search config in B5 and proposes those sources in its `settleSearches` step, which lands in B6 with
the two functions it calls ("Files by pull request"):

```ts
// lib/commcare/reader/expressions/searchRows.ts
/** The proposed case list's own rows against the source's, as trees, order kept. */
export function matchSearchRows(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	sourceRows: readonly string[],
	env: SearchRowEnv,
): {
	/** Source row indexes Nova's emission of this module reproduces, exact or up to guards, each
	 *  with the source of the emitted row: the list filter, a field's condition, a derived match. */
	readonly matched: readonly {
		readonly source: number;
		readonly level: "exact" | "guards";
		readonly from: "filter" | "field" | "derived";
	}[];
	/** Source rows no emitted row equals. */
	readonly unmatched: readonly number[];
	/** Emitted rows no source row equals. */
	readonly extra: readonly number[];
};
/** A row read on its own, for part 07 to place: its top-level conjuncts, each a predicate. */
export function readSearchRowConjuncts(text: string, context: ExpressionContext, env: SearchRowEnv):
	| {
			readonly ok: true;
			readonly conjuncts: readonly Expression[];
			readonly rewrites: readonly EmissionRewriteId[];
	  }
	| Extract<SearchRowReading, { ok: false }>;
```

`matchSearchRows` is the recognition method one level up: it runs `composeXPathQueryEmission` over the
proposed module and compares row trees. A row whose own root is an `and` reads as its conjuncts and is
written back as that many rows, which finds the same cases; part 07 reports that with the register
entry `search-filter-rows-recut` (part 01, section 3.5; part 07, section 13.3). Which Nova slot a
conjunct lives in, and the finding for a conjunct no slot holds, are part 07's (its section 12.3).
B6 flips nothing for `case-search/several-xpath-query-rows`; B5 does.

**A filter clause that reads a Search field lives only in a row.** Nova's case list filter may hold
`when-input-present` and Search field reads. The detail filter never shows them
(`projectCaseListFilter` substitutes the unanswered reading and the simplifier then drops the clause,
2.1), and `composeXPathQueryClauses` writes each as its own row. So B6's reading of the detail
filter's text is the filter less those clauses, and the clause itself reaches B5 as a row whose
conjunct reads a Search field. `matchSearchRows` says for each matched row which source of the
proposed module emitted it (`"filter" | "field" | "derived"`, added to each `matched` entry as
`from`), so part 07 can propose such a conjunct as a clause of the list filter and see it accepted.
Its row classification holds exactly that: the second candidate of its kind D is a clause of the
case list filter that waits for its fields, kept where `matchSearchRows` reports the row
`from: "filter"` (part 07, section 12.3), so Nova's own filter reads back as the same filter.

**A row the checker refuses** is no defect of the reading. Where a row binds (7.3) and
`checkExpression` or `checkCsqlRepresentability` refuses the predicate for a reason no row of 9.2
names, `readSearchFilterRow` answers `{ ok: false, claim }` with the new HELD-NEW entry M7,
`case-search/xpath-query-condition-outside-what-nova-types` (section 11), and the checker's reason.
`unrecognized` is left for what is Nova's to explain: a row that binds, passes the checker, and
prints back unequal at both levels of 7.4; and, only under run E3's outcome C, a text HQ builds whose
shape no arm of the union holds.

---

## 8. Functions in record slots

### 8.1 `call` stays out of record slots in step 6

Outline item 8 gave this step `call` in record slots and its Postgres compilation, to decide. The
decision is **not-yet, for every function**, and the reasons are three facts of the code, not effort:

- The checker refuses the arm in every record slot
  (`typeChecker.ts`, `arm-unavailable` with reason `call`), so admitting it is a change to the gate for
  every author, not for imported apps alone. The bar forbids a reader-only leniency.
- A record arm is an authoring concept. Every kind a record profile admits has a builder card
  (`components/builder/CLAUDE.md`), and `expressionEditorSchemas.ts::CardValueKind` excludes `call`; the
  record dialect the Solutions Architect and MCP read and write has no spelling for it and its printer
  throws. A function in a record slot is therefore a complete feature (card, spelling, guide, checker
  rule, Preview, docs), which is stack A's kind of work and which no pull request of either stack
  builds.
- For the two slots where HQ's authors most use functions, the case list filter and a calculated column,
  the slot's targets include Postgres, which decides which rows a list holds and orders them. Core's
  coercions are not Postgres's: `FunctionUtils.toNumeric` reads date text as a day number,
  `XPathStringLengthFunc` counts UTF-16 units, `FunctionUtils.normalizeCase` lowers in the device's
  locale. Each function needs a typed admission rule and a proof against Core before a list may depend
  on it.

Row by row, what an expression that calls each function in a record slot claims, and why it waits:

| Functions | In a record slot | What step 7 must build |
|---|---|---|
| `cond` | read, as nested `if` (the `cond` fold of 5.3, compared under S1) | nothing |
| `if`, `coalesce`, `concat`, `date`, `double`, `today`, `now`, `not`, `true`, `false`, `selected`, `starts-with`, `format-date`, `count` over a relation, `here` | read: each binds to its own arm, not to `call` | nothing |
| `int`, `round`, `floor`, `ceiling`, `abs`, `number`, `pow`, `min`, `max`, `sqrt`, `exp`, `log`, `log10`, the trigonometric six, `atan2`, `pi` | not-yet | a typed numeric rule (a number in, never text: `toNumeric` reads date text), and for a list's filter and columns the Postgres spelling of each with Core's NaN and rounding (`XPathRoundFunc`: `floor(x + 0.5)`; `FunctionUtils.toInt`: truncation that keeps `-0`) |
| `string-length`, `substr`, `substring-before`, `substring-after`, `contains`, `ends-with`, `translate`, `replace`, `regex`, `lower-case`, `upper-case`, `string`, `join` and `join-chunked` over scalars, `selected-at`, `is-selected`, `count-selected`, `index-of`, `distinct-values`, `sort`, `sort-by` | not-yet | UTF-16 lengths and offsets in Postgres (`XPathSubstrFunc::substring` indexes Java `char`s), Java's regex dialect, and a decision on `normalizeCase`, which follows the device's locale |
| `format-date-for-calendar`, `id-compress`, `checksum`, `json-property`, `boolean`, `boolean-from-string`, `checklist`, `weighted-checklist`, `distance`, `closest-point-on-polygon`, `is-point-inside-polygon`, `encrypt-string`, `decrypt-string` | not-yet | the same, function by function |
| `uuid`, `random`, `sleep`, `depend`, `position`, `sum` and `join` over a node-set | not-yet | a meaning in a slot that evaluates once per listed case: none of these has one today |

The owner of each not-yet is the slot's own HELD-NEW entry (9.2): `case-list-and-detail` for the filter,
a calculated column and a sort calculation; `menus` for the two display conditions; `case-search` for
the search slots; `xform` for a choice list's filter. Date arithmetic in a calculated column
(`int((today() - date(dob)) div 365.25)`) waits for two reasons: `int` is a call, and record arithmetic
admits numbers alone (`typeChecker.ts`, `number-value`).

### 8.2 What this costs a person, said plainly

An HQ app whose case list has a calculated column built from `concat`, `if`, `cond`, comparisons and
case properties comes in. One whose column calls `int`, `substr` or `format-date` over arithmetic gets
a line in its account under "Nova can't hold this yet", at the case list, with the checker's reason.
The census the reading stores (part 12, section 8; B10) counts these by entry, which is how step 7
learns which functions to build first. Form logic is not affected: every function Core answers is
held there.

### 8.3 The reads only a search holds

From step 3 the checker admits, in a slot only CommCare's server search reads, a list of values
(`value-list`) and queries of the device's data (`cases`, `table-rows`, `locations`, `project`, a
node-set `count`) inside a value a device works out first. The builder renders them
(`cards/expression/GeneralValueCards.tsx::ValueListCard`, display only). The record dialect does not:
`printQueryExpression.ts::queryPrinter` throws on each, and `lib/agent/authoring/output.ts` prints every
expression of a module, so the first imported app holding one would fail every `get_module` and every
turn of the Solutions Architect on it.

- **`value-list` gains a spelling that is read and kept.** `list(<value>, …)` in the record dialect,
  printed by `queryPrinter` (the value switch gains `case "value-list": return call("list",
  ...value.items.map(expression))`) and read by `queryExpressions.ts::parseQueryValue` (a call named
  `list` with one or more arguments compiles to `{ kind: "value-list", items }`). Where it may stand
  is already judged twice and the parser adds no third rule: the checker admits the arm only in a slot
  CommCare's server search alone reads, and `csql/representability.ts::checkCsqlRepresentability`
  refuses it anywhere but opposite `=` or `!=` (`value-list-placement`).
- **No editor authors a new list.** The builder's `ValueListCard` is display only and no verb menu
  offers it (`components/builder/CLAUDE.md`, "Cards dispatch on syntax"), so a list the Solutions
  Architect or an MCP client could write would be content one editor makes and another cannot. The
  dialect therefore keeps what is stored and adds nothing: `QueryBindings` gains
  `heldValueLists?: readonly Expression[]`, the `value-list` subtrees of the stored tree of the slot
  being written, which `lib/agent/authoring/bindings.ts` fills from the stored slot (none for a new
  slot). A `list(…)` whose compiled tree deep-equals one of them is admitted; any other is refused
  with C7b. An agent that edits the rest of such a condition sends the list back as it read it. The
  guide gains the one sentence that says what the spelling is and that it is kept (Copy, C7), and
  `content/docs/mcp/tools.mdx` gains the same fact for MCP clients, in B14 with stack B's other
  public docs ("Contracts and docs these changes make false"). The sibling `nova-plugin` repository
  was searched for `unwrap-list`, "value list" and `list(`: it holds no claim about record value
  lists, so its skills do not change and its `plugin.json` does not move for B6.
- **The device-data queries become not-yet.** A search value that queries `casedb`, a table or the
  place list, other than the chosen case's property (which `chosen-case-property` spells), claims the
  new entry `case-search/a-search-value-that-queries-cases-a-table-or-places` (section 11). The arms
  stay in the union and the checker; no document holds one, as today.
- The comment in `printQueryExpression.ts` that names this plan's top-level file by its path
  (`docs/plans/hq-round-trip/6-bring-in.md`; the plan's own pull request changed that one path from
  the outline's file, which it removes, and nothing else of the comment) is replaced by C8, which
  says what is true and names no plan file. B6 changes the code under the comment, so the rewrite
  is B6's, and it is what lets B15 remove the plan with no file left naming it.

`MODEL_CONTEXT_VERSION` moves for the guide sentence. `list` is no escape hatch added because HQ has
one: the arm, its checker rule, its emitter and its card ship today, and the dialect was the one surface
that could not show it. Making the card an editor (items through the value picker, offered where the
profile admits the arm) is the authoring feature; it belongs to step 7's `case-search` group with the
other search work, and until then all three editors show a brought-in list and none writes one.

### 8.4 The dialect round trip

The record dialect's law is that parsing a print gives back the stored tree
(`lib/agent/authoring/CLAUDE.md`). Authoring keeps it because every stored tree came through the
parser. A read tree did not: it can hold an arm the dialect cannot print (a `session-datum` that is
no chosen case, 5.2; a `project` that is no chosen case's property, where a slot's checker admits it)
or a shape its parser reads back differently. `output.ts` prints every record slot of a module for
each agent read, so one such slot fails the whole read with `ReadProjectionError`.

```ts
// lib/agent/authoring/recordRoundTrip.ts (B6)
/** Undefined where `queryPrinter` prints the slot's tree under the slot's own authoring scope and
 *  `parseQueryPredicate` or `parseQueryValue` reads the print back to a tree deep-equal to it.
 *  Otherwise the kind the printer has no spelling for, or `"round-trip"` where the trees differ. */
export const recordDialectRoundTrip: RecordDialectJudge;
```

It catches the printer's own errors and reads the kind from the tree, never from an error's text. The
reader takes it as `ReaderInput.recordDialect`, a member B6 adds to part 06's type (its section 2.2)
beside `appStrings`, which is handed in for the same reason: `lib/commcare` imports nothing of
`lib/agent`. It is used in step 6 of 2.5. The reading service (part 12, B10), the fixed-point re-read
(part 09, B7) and the proof lane's reader bundle (part 14, section 5.2, B13) pass the production
function; a test of the reader passes it too. `dialectReadBack.test.ts` holds, over E5's corpora and
the three starter bases, that every record slot `readExpressions` holds prints and reads back to
itself, so the judge refuses nothing Nova itself wrote.

---
## 9. Types, and what each refusal becomes

### 9.1 The check

Every held slot is checked with `checkExpression(expression, slotContext(doc, ref, lookupTypes))` over
the document that holds every bound candidate, refused ones included, so one refusal does not change
the type another slot is judged under. `lookupTypes` is `env.lookup`'s column types, as
`formPrintContext.ts::formScopeContext` builds them. A slot whose targets hold `CS` is also judged by
`lib/commcare/csql/representability.ts::checkCsqlRepresentability`, the same judge the module validator
runs.

Two rules judge an expression outside the checker, both in
`lib/commcare/validator/rules/displayConditions.ts`, and B6 runs both over a held display condition by
calling the rule's own exports (`moduleDisplayCondition`, `formDisplayCondition`) for the slot's owner:

- `DISPLAY_CONDITION_NOT_ON_DEVICE` (`firstPortabilityIssue`): a condition a device cannot evaluate.
  The slot is not held and claims its default of 9.2 (HELD-NEW for both display conditions) with
  `detail.reason` `validator:DISPLAY_CONDITION_NOT_ON_DEVICE`.
- `displayConditionStartsWithNever`: a condition that is `match-none`, or an `and` led by it, prints
  the hidden spelling. That is how Nova's `hiddenFromMenu` arrives in HQ's text (`false()`, or
  `false() and (<rest>)`), and `false()` binds to `match-none`. B6 holds the tree as bound and makes
  no claim from this rule; B4's `settleMenus` reads the shape off the registration's outcome, sets
  `hiddenFromMenu` and keeps the remaining clauses as the condition (part 07, section 8.3).

Two more rules of the gate exist only under an outcome of a run part 03 (A7) owns
(`03-questions-and-text.md`, "Written and not yet run", G1 and G3). Each judges a calculated value
in prose, each is a property of the bound value, which only binding knows, and each has one
exported predicate in `lib/commcare/validator/rules/field.ts` that A7's rule and B6 both call. Where
the outcome landed in A7, B6 claims by it; under every other outcome the predicate and its entry do
not exist and B6 lands no line for them.

- **Under part 03's G1 outcome B**, `proseValueNotKeptByFormBuilder(printed)`, with `printed` the
  `N` of 2.1's step 4 for a `value` part: a value whose XForm text holds a character CommCare HQ's
  form builder changes or drops on a save. The part is not held and claims
  `questions/output-value-holding-text-the-form-builder-rewrites` (REFUSED, `not-hq-editable`) with
  `detail.reason` `validator:PROSE_VALUE_NOT_KEPT_BY_FORM_BUILDER`.
- **Under part 03's G3 outcome C, its second case**, `proseValueBreaksValidationMessage(C)`, with `C`
  the bound tree of a `value` part whose slot is a validation message: a call Core cannot work out
  while it composes the message. The part is not held and claims
  `questions/output-value-in-a-validation-message-core-cannot-compose` (REFUSED,
  `broken-at-runtime`) with `detail.reason` `validator:PROSE_VALUE_BREAKS_VALIDATION_MESSAGE`.

Both are tested ahead of `questions/output-value-any-other-expression` (9.2), and a reference part
meets neither: the rule reads `value` parts alone.

The absolute gate runs whole at acceptance (part 09, section 4, check 2; B7). What B6 guarantees is
that no refusal of the checker, of representability, of the rules above or of the dialect round trip
reaches it unreported, and `gateCoverage.test.ts` holds the rest: over E5's corpora and the starter
bases, the document `readExpressions` returns raises no validator finding located at an expression
slot B6 filled. A rule that test finds is run E5's outcome E, which says what lands.

One reason is not a refusal at this point: `arm-unavailable` with reason `platform-unavailable`. The
provisional document declares both platforms, and which declarations the content allows is decided at
assembly, after this stage, by part 06 (its section 16.3: `planDeclarationChoices` over the assembled
document, which narrows the choices by every use one platform lacks and raises
`no-platform-runs-everything` where none is left; part 12 offers those choices and proposes nothing of
its own). That count and the checker's reason read one table (`lib/domain/platforms.ts`, through
`platformUses.ts`: "a use a declared platform cannot run is refused at the commit gate on two channels
from this one source", `lib/domain/CLAUDE.md`), so a leaf the checker would refuse under a declaration
is a use that declaration is not offered for. B6 therefore drops that reason and reports the slot held,
and needs to hand nothing on: the uses are found again from the document.

A refusal's finding is `{ code: <entry id>, standing, place, subject, owner?, detail }` (part 01,
section 8.1), built by the frame from the claim B6 returns: `place` is the pending expression's;
`detail.reason` is the checker's `code`, or `code:reason` where the error holds a reason
(`incompatible-values:date-datetime`), or `parse:<issue code>` for a parse refusal, or `call:<name>` for
a function, or `relation:<identifier>` for an untyped relation step (6.3), or `name:<grammar>` for a
name outside a grammar (9.2), or `dialect:<kind>` (2.5, step 6), or `validator:<code>` (above);
`detail.name` is the attribute or key the expression sits in (`relevant`, `module_filter`,
a column's header in the app's first language, a search field's name), at most 200 characters. The
expression's text is never put in a finding or a log line: it is app content.

A row of `ExpressionReading.circumstances` carries the same two members another way, since its
code is `unrecognized`: `detail.name` is the registration's `key`, the surface key part 01's
section 8.3 asks of that circumstance, and `detail.reason` is `no-case-datum` (6.1), the
`parse:<issue code>` of a row of 9.2's "By parse issue" that answers `unrecognized`, or
`differs:<kind>`, the `kind` of the source node `firstDifference(S, P)` gives for the exact print
(for a search row, of the row's wrapper against Nova's own wrapper). C9's `{reason}` is that
`detail.reason` as it stands; its line holds no `detail.name`.

### 9.2 The entry each outcome claims

**By slot.** The entry claimed when the expression is held, and the entry a refusal claims when no row
of the tables below names a more specific one:

| Slot | Held | Refused, by default |
|---|---|---|
| `relevant` | `questions/bind-relevant` | M2 or M3 (below) |
| `validate` | `questions/bind-constraint` | M2 or M3 |
| `required` | `questions/bind-required-true` where the bound tree is `match-all` (the text `true()`); else `questions/bind-required-expr`, a `false()` among them, held as the `match-none` it binds to | M2 or M3 |
| `calculate` | `questions/bind-calculate-on-a-hidden-value` | M2 or M3 |
| `default_value` | `questions/a-default-value-that-reads-form-nodes` where the bound value reads a form node; else the entry part 06 took for the setvalue (its section 11.2), by where the question sits: `questions/setvalue-event-jr-insert-default-inside-a-repeat-not-reading` inside a repeat, `questions/setvalue-event-xforms-ready-default-on-a-question-outside` outside one | M2 or M3 |
| `repeat_count` | the entry part 06 took for the repeat (its section 10.3), by what the bound count is: a read of a whole-number question, `questions/repeat-with-jr-count-naming-an-integer-question-of-the-form-s`; a read of a single select, `questions/jr-count-naming-a-single-select-question-whose-every-choice`; a read of a Hidden Value, or the calculation of a generated count node, `questions/jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in` | by the count's source: `questions/jr-count-naming-a-decimal-question`, `questions/jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer`, `questions/jr-count-naming-any-other-question-kind-text-barcode-multi` |
| `ids_query` | by the repeat's stored `placement`: `questions/repeat-model-iteration-vellum-role-repeat-ids-count-current` for `model-iteration`, `questions/count-repeat-whose-count-and-row-ids-come-from-one-query-a` for `count` | M2 or M3 |
| a prose value (part 03) | by the part step 2 of 2.5 wrote: `questions/output-value-of-a-question-case-or-user-reference` for a reference part, `questions/output-value-any-other-expression` for a `value` part (part 06, section 12.3). A `value` part is first put to the two predicates of 9.1 where part 03's run landed them, and one that answers is refused under its own entry and never held | where 9.1's predicate answers, in this order: `questions/output-value-holding-text-the-form-builder-rewrites` (only under part 03's G1 outcome B), then `questions/output-value-in-a-validation-message-core-cannot-compose` (only under its G3 outcome C, second case, and only in a validation message); else M2 or M3 |
| a choice list's filter | `questions/itemset-filter-lifting-into-predicate` | `questions/itemset-filter-outside-predicate` |
| a link's condition and carried value | `forms-and-case-writes/form-links-xpath` | M2 or M3 |
| a form's Connect expressions | `questions/connect-assessment` for `assessment_user_score`; `questions/connect-deliver-unit` for `deliver_entity_id` and `deliver_entity_name` (the entries part 06 took for the blocks, its section 15) | M2 or M3 |
| a case operation's expressions | by slot, the entry part 07 took for the block's part (its section 5.2): `case_operation_name`, `questions/savetocase-create-case-type-literal-case-name-owner-id-uuid-case`; `case_operation_owner`, `questions/savetocase-owner`; `case_operation_rename`, `case_operation_write_value` and `case_operation_write_condition`, `questions/savetocase-property-rows-calculation-condition-lifting-into`; `case_operation_condition`, `questions/savetocase-open-case-condition` on a create and `questions/savetocase-inside-a-group-whose-display-condition-gates-it` on an update or a close; `case_operation_target_expression`, `questions/savetocase-update-case-id-xpath`; `case_operation_link_target_expression`, `questions/savetocase-link-index-name-child-extension-and-unlink-empty` | `questions/savetocase-expressions-outside-nova-s-typed-vocabularies-case-id` |
| a form's display condition | `forms-and-case-writes/form-filter-lifting-into-predicate-a-direct-own-case-property-in` | `forms-and-case-writes/form-filter-outside-predicate-parent-host-user-usercase-reads` |
| a menu's display condition | `menus-and-case-lists/module-filter-value-lifts-into-predicate` | `menus-and-case-lists/module-filter-value-outside-predicate-any-xpath-hq-s-validator` |
| the case list filter | `menus-and-case-lists/detail-filter-value-lifts-into-predicate` | `menus-and-case-lists/detail-filter-value-outside-predicate` |
| a calculated column, and a sort calculation equal to one | `menus-and-case-lists/usexpathexpression-field-xpath-lifting-into-valueexpression` | `menus-and-case-lists/usexpathexpression-field-xpath-outside-valueexpression` |
| a search's button condition | `case-search/search-button-display-condition-lifting-into-predicate` | `case-search/search-button-display-condition-outside-predicate` |
| excluded owners | `case-search/blacklisted-owner-ids-expression-lifting-into-valueexpression` | `case-search/blacklisted-owner-ids-expression-outside-valueexpression` |
| a Search field's choices filter | `case-search/itemset-nodeset-filter-predicate-lifting-into-predicate` | `case-search/itemset-nodeset-filter-predicate-outside-predicate` |
| a Search field's starting value, a hidden value | `case-search/default-value-lifting-into-valueexpression` | `case-search/default-value-outside-valueexpression` |
| a Search field's required and validation tests | `case-search/required-test-text`, `case-search/validations-0-test-text` | M6 (section 11) |
| a search filter row | no slot entry of its own: `case-search/several-xpath-query-rows` holds the key (B5), and each operator, function and metadata name the row's CSQL uses is claimed as a surface use (9.3) | the row's entry of section 7.3; for a checker or representability refusal no row below names, M7 (7.6) |

A form's open and close conditions are in no row: part 07 builds both from HQ's structured action
condition (its section 3.3) and registers no text for them. Nor is the `required` of a question that
names a case the form creates: part 07 claims that attribute itself, as INERT, and the draft
question holds no condition (its section 3; 10.3). In code the table is `SLOT_ENTRIES`, and the
three mappings of this section are three functions:

```ts
// lib/commcare/reader/expressions/findings.ts
type SlotName = SlotContextRef["slot"]; // lib/domain/expression/types.ts
/** The "Held" and "Refused, by default" columns, by slot name. `held` and `refused` take the
 *  document because a row can choose by the slot's owner (a repeat's placement, a question in a
 *  repeat, an operation's action) or by the bound tree. `held` answers undefined for the row that
 *  has no slot entry; `refused` answers `"form-default"` where the column reads "M2 or M3". */
export const SLOT_ENTRIES: Readonly<
	Record<
		SlotName,
		{
			held(doc: BlueprintDoc, ref: SlotContextRef, bound: Expression): string | undefined;
			refused(doc: BlueprintDoc, ref: SlotContextRef): string | "form-default";
		}
	>
>;
/** "By parse issue", from its second row down: the entry, `"unrecognized"`, or `"slot-default"`,
 *  with the `detail.reason` of 9.1. The two refusals of HQ's interpolation (6.1) are judged here
 *  too. An exhaustive `switch` over `FormParseIssueCode`. */
export function parseIssueEntry(
	issue: FormParseIssue | { readonly code: "case-reference" | "fixture-value" },
	doc: BlueprintDoc,
	pending: PendingExpression,
): { readonly entryId: string | "unrecognized" | "slot-default"; readonly reason: string };
/** "By checker code": the entry, or `"slot-default"`, with the `detail.reason` of 9.1. */
export function checkErrorEntry(
	error: CheckError, // lib/domain/expression/typeChecker.ts
	doc: BlueprintDoc,
	pending: PendingExpression,
): { readonly entryId: string | "slot-default"; readonly reason: string };
/** A form slot's default: M2 or M3, by the code (below). */
export function formRefusalEntry(code: CheckErrorCode): string;
```

`"slot-default"` resolves through `SLOT_ENTRIES[slot].refused`, and its `"form-default"` through
`formRefusalEntry` for a checker code and to M3 for a parse issue the table sends to the slot's
default. The slot `search_input_predicate` and the case list filter's own rows take the row "a
search filter row": both are read from `_xpath_query` rows by `readSearchFilterRow`, which answers
its claim itself (7.1). The first row of "By parse issue" is no parse issue: `readExpression` tests
it on the raw text before it interpolates or binds.

**Every entry id is a declared claim.** The frame applies an `ExpressionClaim` through
`Accounting.claimEntry`, which takes the entry by id and treats an id no registered claim holds as
a defect of the reader (part 06, section 4.3; its defect D9). So every entry id B6 can answer is
written once, as a member of one `defineClaims` call (part 06, section 4.2,
`reader/claims.ts`):

```ts
// lib/commcare/reader/expressions/findings.ts
/** Every entry `SLOT_ENTRIES`, the three functions above, the refusals of 7.3 and
 *  `SURFACE_USE_ENTRIES` (9.3) can answer. */
export const EXPRESSION_CLAIMS = defineClaims("expressions", { /* one member per entry and key */ });
```

Those tables answer `EXPRESSION_CLAIMS.<member>.entry` and never a string literal, so an id cannot
be answered without being registered. A member is named as part 06 names the form reader's (its
section 8.1, `xform/claims.ts`): the entry's id less its area, followed by `@<key>` where the entry
is registered under more than one surface key. Its `key` is the surface key the table answers the
entry under where the entry's own `surfaceKeys` hold it (a key of `SURFACE_USE_ENTRIES`, a slot's
own key), else the first of the entry's `surfaceKeys`, and null for M2 and M3, which hold
`noSurfaceKey`. Its use is the one `claimEntry` gives the entry's standing: `take` for a HELD
entry, `drop` for an INERT one, `refuse` for a HELD-NEW or REFUSED one. Part 06's
`claimsBindManifest.test.ts` then holds every member to the manifest, and it passes at B6's head
because the entries of section 11 land in the same pull request.

M1 to M7 are the new entries of section 11. In a form slot the default is **M2** for the codes that
say the expression reads what the form does not hold, which stops the form or reads blank on a device
(`form-answer-unavailable`, `case-data-unavailable`, `many-values`), and **M3** for every other code.
The line between them is who has something to change. M2 is REFUSED, `broken-at-runtime`, so its
sentence tells a person to change the app in CommCare HQ, and that is right only where the app is
broken there. A comparison the checker refuses (`incompatible-values`, `ordered-values`), a row leaf
with no row (`row-scope`) and every narrowing of what Nova types (`default-not-a-choice`,
`datetime-literal-precision`, `branch-values`, `expected-value`, `constraint-value` and the rest) are
expressions CommCare runs today: Core answers a comparison by turning one side into a number or a yes
or no (`expr/XPathEqExpr.java`, `FunctionUtils.toNumeric`, `::toBoolean`), deterministically, whether
or not that is what its author meant. Nothing in CommCare HQ needs changing for Nova to hold them
later, so they are M3, HELD-NEW: "Nova can't hold this yet". The split is one exhaustive `switch` over
`CheckErrorCode` in `findings.ts::formRefusalEntry`, so a code added to the checker fails the build
until it is placed.

**Names outside a grammar Nova keeps as it is.** Part 04 leaves three grammars an expression can name
unchanged and asks each reader to state its standing for the wider class (its "What other parts read
from this one", "Unchanged, and so findings where HQ holds more"). None has an entry of part 04's
section 11.2, so each claims the slot's own default, with the grammar in `detail.reason`:

| Name | Grammar | What the reader does | `detail.reason` |
|---|---|---|---|
| a relation's index identifier (`index/<id>`) | `lib/domain/expression/types.ts::XML_ELEMENT_NAME_PATTERN` | the relation folds make no proposal; the read stays a `project` over `cases`, refused in a record slot | `name:index-identifier` |
| a worker property's slug | `USER_PROPERTY_SLUG_PATTERN`, less `BUILT_IN_USER_PROPERTY_SLUGS` | part 11 mints no worker property for it (its section 11.5); the read binds to the name-backed `session-user` leaf, held where the slot's checker admits that leaf and refused with the checker's own code where it does not | the checker's code |
| a level's code (`@type = '<code>'`) | `LEVEL_CODE_PATTERN` | the draft holds no such level (part 11 gives the circumstance `place-not-holdable` for the level itself); the read fails to bind, `unknown-level` | no second finding where part 11 raised `place-not-holdable` for that code; otherwise M2 |

**One cause, one line.** Part 07 compares a form's entry facts with Nova's projection before this
stage (its section 6.3, `compareEntryFacts`: the loads, the tag or the menu kind HQ's entry has and
Nova's projection lacks) and raises its finding at the form. In such a form a datum read the
projection does not give has that cause, so it raises no M1: the registration is listed in
`ExpressionReading.ownerless` and the frame claims its node under part 07's finding (2.5). In a form
whose entry facts agree, an M1's `detail.reason` is `parse:unknown-datum` (or the other two issue
codes of its row below) or `datum-not-supplied`.

**By parse issue.** `FormParseIssueCode` to entry, first match:

| Issue | Entry |
|---|---|
| in a form's display condition, the raw text (before interpolation) read by `readFormSyntax` holds a `#case` hashtag with no segments as the left of a step on the `attribute` axis (`#case/@status`, `#case/@case_id`, `#case/@case_type`, `#case/@owner_id`) | `forms-and-case-writes/form-filter-reading-case-status-case-id-case-type-owner-id` (REFUSED, not HQ-buildable: after interpolation the text would bind to a standard property, so this row is tested first, on the raw text) |
| `syntax`, `unknown-hashtag`, `arity`, in a bind attribute, over ASCII text | `expressions-and-data/an-invalid-xpath-in-a-bind-attribute` (`arity` is a parse refusal in Core too: `expr/XPathFuncExpr.java::validateArgCount`, and `XPathCondFunc`'s override of it, throw `XPathSyntaxException`) |
| `arity` anywhere else | M2: CommCare cannot run the call |
| `syntax` in a menu's display condition | `menus-and-case-lists/module-filter-failing-hq-s-validate-xpath` |
| `syntax` in the case list filter | `menus-and-case-lists/detail-filter-failing-etree-xpath-dummy-filter` |
| `syntax` anywhere else, or over text holding a non-ASCII character outside a string literal | `unrecognized` (Nova's grammar and Core's lexer differ on which letters start a name: part 04, row N4) |
| interpolation refused `case-reference`, a menu's display condition | `menus-and-case-lists/module-filter-referencing-case-parent-host-or-a-bare` |
| interpolation refused `case-reference`, a form's display condition | `forms-and-case-writes/form-filter-referencing-the-case-database-other-than-through` |
| interpolation refused `case-reference`, a search test | M5 (section 11) |
| interpolation refused `fixture-value` | `forms-and-case-writes/form-filter-using-fixture-value` |
| `unknown-function`, `capture-link-not-a-question` (`capture-link` is Nova's own name and no function of Core's; the hook refuses it as unknown before this issue can arise, and the row is here so the mapping is total) | `expressions-and-data/any-other-function-name` |
| `union` | `expressions-and-data/union-a-b` |
| `filter-root` | `expressions-and-data/filter-expression-expr-root-other-than-instance-current` |
| `axis`, on `//` or an axis other than `child`, `attribute`, `self::node()` and `parent::node()` | `expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node` |
| `axis`, on `self::node()` or `parent::node()` in a case, table or place row's path, where `formPathBinding.ts::name` refuses what Core runs (the entry above leaves both spellings out of what it refuses) | the slot's default (a form slot: M3) |
| `parent-after-name` | `expressions-and-data/after-a-named-step-data-a-b` |
| `variable`, a form slot | `expressions-and-data/var-in-a-form-expression` |
| `groups-held` | `expressions-and-data/groups-jr-fixture-user-groups` |
| `search-results-remote` | `expressions-and-data/results-read-in-form-expressions-reached-through-a-search-that` |
| `unknown-datum`, `placeholder-datum`, `multi-select-datum-value` | M1, or no claim in a form of `env.entryFactsRefused` (2.5); where the id is `supply_point_id`, `expressions-and-data/session-data-supply-point-id-in-an-advanced-form-whose-computed` in an advanced form whose computed datum has that id and `expressions-and-data/session-data-supply-point-id-anywhere-except-in-an-advanced-form` anywhere else; `fingerprintquery`, `expressions-and-data/session-data-fingerprintquery` |
| `unknown-itext` | `questions/itext-entry-referenced-only-from-jr-itext-in-an-expression` |
| `choice-name-not-a-select`, the question's choices come from a table or cases | `expressions-and-data/jr-choice-name-on-a-lookup-itemset-select` |
| `instance-unknown`, by the id's scheme or declared source | `ledgerdb-vellum-id-ledger`, `commtrack-locations-hierarchical`, `reports-commcare-reports-commcare-reports-commcare-reports`, `registry-jr-instance-remote-registry`, `schedule-m-p-f`, `indicators-call-center-indicators`, `commtrack-products-commtrack-programs`, `case-search-fixture`; a declared source outside every scheme, `declared-and-referenced-instance-with-an-unrecognized-src`; an undeclared id, `referenced-undeclared-instance-id-with-no-known-scheme-or-one` (all in `expressions-and-data/`) |
| `unknown-table`, `lookup-unavailable`: a table tag the bound catalog lacks | the tag joins `ExpressionReading.unreadTables`. No second finding where part 11 reported the table (one it could not bring in, or one CommCare HQ's list lacks, which it raises under M2 at the table's place, its section 5.1); otherwise M2 |
| `unknown-field`, `relative-unknown`, a path under `/data/meta`, `/data/case`, `/data/commcare_usercase` or a `subcase_<n>` | M3: a block HQ's build adds, which no Nova leaf reads but the owner's `acting-user` |
| `unknown-field`, `relative-unknown`, `relative-above-form`, `form-root`, `unknown-level`, `unknown-location-property`, `unknown-column`, `table-path-mismatch`, any other path | M2: it reads what is not there |
| a property name outside `AUTHORED_CASE_PROPERTY_NAME_PATTERN` | part 04's entry for the name: `forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character` (N7) where it is one, else the slot's default |
| every other issue (`wildcard`, `ambiguous-field`, `case-alias-unbound`, `case-query-untyped`, `case-row-attribute`, `row-step-after-value`, `row-leaves-record`, `relative-no-context`, `instance-argument`, `search-results-unexcluded`, `unknown-search-input`, `unknown-hashtag` outside a bind attribute, `variable` outside a form slot, and `choice-name-not-a-select` on a question that is no select) | the slot's default (a form slot: M3) |

The table places every member of `FormParseIssueCode` (`formParseIssues.ts`), and
`findings.ts::parseIssueEntry` is an exhaustive `switch` over it, so a code added to the parser fails
the build until it is placed.

**By checker code**, before the slot's default, first match:

| Code and reason | Entry |
|---|---|
| `time-ordering` | `expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string` |
| `arm-unavailable`, `here` | `expressions-and-data/here-in-a-form` |
| `arm-unavailable`, `window-width-in-form` | `expressions-and-data/session-context-window-width-in-form-logic` |
| `arm-unavailable`, `choice-name-dynamic` | `expressions-and-data/jr-choice-name-on-a-lookup-itemset-select` |
| `search-answer-unavailable` | `expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search` |
| `search-results-not-supplied` | `expressions-and-data/results-read-in-form-expressions-reached-through-a-search-that` |
| `datum-not-supplied` | M1, or no claim in a form of `env.entryFactsRefused` (2.5) |
| `incompatible-values:date-datetime` in a search row, the anchor `date_opened`, `closed_on` or `last_modified` (the date literal typed by the `typed-literal` fold, 5.1, under `=`, `!=` or an ordering) | `case-search/date-only-comparison-on-date-opened-closed-on-last-modified` |
| any code whose path ends at a worker-record leaf, in a record slot | `forms-and-case-writes/user-prop-in-module-filter-form-filter-case-list-slots-the` |
| `arm-unavailable`, reason `project`, where the refused read is the shape of 5.3's `relation-property` with a step that is not `parent` and holds no type test | the slot's default, `detail.reason` `relation:<identifier>` (6.3) |
| `arm-unavailable`, reason `call`, `cases`, `table-rows`, `project`, `count` | the slot's default, `detail.reason` `call:<name>` or the arm |
| any other code, in a search filter row | M7 |

A slot with several errors makes one claim, the first by this order, so one expression is one line of
the account. A reading still reports every slot's finding in one pass.

### 9.3 Claims in the lane's vocabulary

The frame's claim log holds, for each claim, its place, surface key, entry id and standing (part 06,
section 4.5, which spells the row `(artifact, where, key, entry, standing)`; B2), and
parity with the lane's own standings is required where the lane's Python decides a use
(`proof/checks/manifest_usage.py`, `manifest_value_classes.py`). So for every expression, held or not,
B6 also returns the uses its syntax makes, each claimed against the entry whose value class takes it:

```ts
// lib/commcare/reader/expressions/surfaceUses.ts
/** The surface keys an expression's syntax uses, with the entry that takes each use. */
export function expressionSurfaceUses(
	source: FormSyntax,
	candidate: Expression | undefined,
	context: ExpressionContext,
	mode: ReadMode,
): readonly { readonly key: string; readonly entryId: string }[];
```

| Key family | Entry |
|---|---|
| `jr-fn:<name>` | `expressions-and-data/<name>`: at `15a00a97` every `jr-fn:` key of the manifest is held by the one entry of that name |
| `jr-handler:<name>` | `jr:itext`, `expressions-and-data/jr-itext-id`; `jr:choice-name` by the select's source, `expressions-and-data/jr-choice-name-value-path-on-a-static-choice-select` (`static-choice-select`) or `expressions-and-data/jr-choice-name-on-a-lookup-itemset-select` (`lookup-itemset-select`); `here` by the slot, `expressions-and-data/here-in-a-form` (`in-a-form`) or `expressions-and-data/here-in-a-case-list-calculated-column-or-sort` (`case-list-row-context`) |
| `instance-scheme:<scheme>`, `instance-source:<src>` | the entry whose `surfaceKeys` hold the key; `item-list` by carrier (`item-list-tag-read-through-nova-s-typed-lookup-carriers`, `typed-lookup-carrier`, for a choice list's source; `item-list-tag-read-in-any-other-expression`, `other-expression`, otherwise); `results` by where the slot runs: `results-results-inline-results-name-in-search-details` (`search-detail`), `results-read-in-form-expressions-of-an-inline-search-module` (`inline-search-form`), `results-read-in-form-expressions-reached-through-a-search-that` (`non-inline-search-form`); `search-input` the same way: `search-input-results-and-legacy-search-input-read-while-the` (`query-build`), `search-input-results-read-in-the-search-results-detail` (`results-detail`), `search-input-results-read-in-the-case-list-of-an-inline-search` (`inline-search-list`), `legacy-search-input-read-after-the-query-in-the-results-detail` (`legacy-after-query`), `search-input-read-in-form-expressions-of-an-inline-search-module` (`inline-search-form`), `search-input-read-in-form-expressions-reached-through-a-search` (`non-inline-search-form`) |
| `session-path:session/data/*` | `session-data-datum` (`supplied`), M1 (`not-supplied`), `session-data-stringquery`, `session-data-fingerprintquery`, and for `supply_point_id` the two entries 9.2 names |
| `session-path:session/context/*`, `session/user/data/*` | by the step: `session-context-userid-context-username`, `session-context-deviceid`, `session-context-appversion`, `session-context-drift`, `session-context-applanguage`, `session-user-data-field`; `window_width` by rule set, `session-context-window-width` (`outside-form-logic`) in a record slot and `session-context-window-width-in-form-logic` (`in-form-logic`) in form logic |
| `xpath-expr:*`, `xpath-axis:*`, `xpath-test:*`, `xpath-token:*` | `xpath-location-paths`, `xpath-operators-and-literals`, `relative-paths-q-current-x`, `instance-id-current-path-roots`, or the REFUSED entry the parse issue names |
| `hashtag:#session/` | `session-hq-shorthand-in-navigation-slots-for-the-context-and` or `session-data-datum-hq-shorthand-in-navigation-slots`, by the path after it |
| `hashtag:#case`, `#parent`, `#host`, `#user` in an HQ JSON slot | `case-prop-case-parent-prop-case-grandparent-prop` for `#case`; the slot's own entry for the others, which the slot table gives |
| `csql-op:*`, `csql-fn:*`, `csql-metadata:*`, `csql-unit:*`, `csql-key:_xpath_query` | the `case-search/` entry whose `surfaceKeys` hold the key. A key several entries share goes by the value class the use has, in the manifest's own words: a comparison's right side (`typed-right-side`, `untyped-right-side`, `blank-on-property` for `p = ''`, `relation-arms-with-typed-right-sides` under a relation function); `date` and `datetime` (`string-or-date-argument`, `epoch-number-argument`); `selected`, `selected-any` and `selected-all` (`literal-value`, `runtime-value`); `within-distance` (`static-miles-or-kilometers`, `other-unit`, `runtime-radius-or-unit`); `date_opened`, `closed_on` and `last_modified` (`non-date-value`, `project-timezone-date`, or the class of the HELD metadata entry that holds the name); `csql-key:_xpath_query` (`input-presence-choice`, `xpath-query-rows`, M7's `outside-the-record-rule-set`, and the classes of the entries part 07 adds on the key) |

An id written without its area in this table is in `expressions-and-data/`. The table in code is
`SURFACE_USE_ENTRIES`, keyed by surface key, each key with the entries that share it by value class:

```ts
// lib/commcare/reader/expressions/surfaceUses.ts
export const SURFACE_USE_ENTRIES: Readonly<
	Record<string, readonly { readonly valueClass: string | undefined; readonly entryId: string }[]>
>;
```

A key one entry holds has one row with `valueClass` undefined, and each `entryId` is a member of
`EXPRESSION_CLAIMS` (9.2). `expressionSurfaceUses` picks the row of a shared key by the rule of the
table above, which is the manifest's own class for the use: the lane's Python reads the same classes
(`proof/checks/manifest_value_classes.py`), and part 14's parity (its section 8) holds the two to
each other. `findings.test.ts` holds every key and every entry id the record names to
`lib/commcare/surface/entries` (section "Tests").

One use is of a form, not of an expression. A form's `<instance>` declaration that no held expression
of the form reads is claimed once the form's registrations are bound, from `env.instanceSources`:
`expressions-and-data/declared-unreferenced-fixture-instance-item-list-locations-user` (INERT) for an
`item-list:<tag>`, `locations` or `user-groups` source, and
`expressions-and-data/declared-unreferenced-instance-whose-source-loads-no-data-casedb` (INERT) for
any other. Those claims carry the form's place and the key `instance-source:<src>`, and `source` is
`-1`: they belong to no registration. Nova writes a form's declarations from what its printed
expressions read (`xform/builder.ts`, the `InstanceSink`), so an unread declaration is not written
back, which is what INERT says. This is the claim parts 06 and 11 leave to B6.

---

## 10. What this part supplies to the form and list readers

### 10.1 A real attribute and its `vellum:` shadow

HQ's form builder prefers a `vellum:` attribute over the real one on load and writes the real one from
it on save (`Vellum/src/parser.js`, the `vellum:` attributes; `lib/commcare/CLAUDE.md`, "Vellum
dual-attribute pattern"). The device runs the real one, and B6 reads the real one.

Whether a save in HQ would change it is part 06's check, in B3 (its section 14):
`reader/xform/shadow.ts::shadowAgrees(real, shadow, metadata, base)` expands each hashtag of the shadow
from the form's own head metadata (`readHashtagMetadata`: `vellum:hashtags` and
`vellum:hashtagTransforms`), compares the two syntax trees, and raises the circumstance
`shadow-disagrees` at the question. There is one such check, and it is B3's, because a shadow is a
fact of the form's source and needs no bound tree; B6 runs none. What this part
found at source stands as that check's premise and is in part 06's rule already: Vellum's built-in
default transforms are never consulted (`Vellum/src/form.js` spells the case root `/cases/case`, a
guess for forms saved before the head carried the map), so a hashtag the head does not expand
disagrees. Where the real attribute does not parse, part 06 drops the shadow and B6's finding for the
real attribute stands alone (9.2).

### 10.2 Output values

Part 03 (A7) holds a calculated value in prose and reads an `<output value>` through
`canonicalProseAtom`. B3 registers each output's text under the prose slot's `ProseSlotRef`, one
registration per `value` part (part 06, sections 11.1 and 17.2), with mode
`{ target: "xform", constraint: false }`, and B6 binds it under the prose slot like any form
expression. Two outputs are text, not values, and B3 reads both itself before anything is registered
(part 06, section 12.3, `reader/xform/prose.ts::literalOutputText`): a quoted string, and
`json-property(<string literal>, 'v')` whose literal is JSON holding one string member `v`, the two
spellings `xform/builder.ts::whitespaceOutput` writes for a whitespace-only run. That function is
part 06's, and B6 exports nothing for it.

### 10.3 Generated expressions other readers recognize

Each of these is a pattern another part owns: the emitter writes it into an attribute or a JSON value
B6 would otherwise read as the author's, so its owner takes it out, by the method, before the text is
registered (or, where the pattern is only visible in a bound tree, after the expression stage). B4 and
B5 compare with `sameSyntax` and `sameXPathText` (3.1), which is why that file lands in B2. B3
compares a generated node's attribute with part 06's own `reader/xform/generated.ts::sameTree`, which
requires equal `formSyntaxKey`s of the source and of the emitter's print and so is stricter than the
table of section 3; no rule here widens it.

| Pattern | Owner | Proposal | Compared with |
|---|---|---|---|
| the scalar check conjoined to a case name's or an external id's question: `<authored> and <guard>`, or the guard alone, on the question's `constraint` (`xform/builder.ts::buildFieldParts`) | B3 (part 06, section 13.2) | the pending `validate` is the left operand's source text, or none | `xform/caseOps.ts::caseScalarTextValueGuard(caseScalarTextValueCalculation(.), …)`, both of its trees |
| `required="true()"` on the question a create's name reads, in place of an authored required condition | B4 (part 07, section 3; its row `create-name-required-is-absent` of part 06's `READER_CANONICAL_CHOICES`) | the draft question holds no `required` condition, and the bind's own `required`, whatever its value, is claimed under the INERT `questions/bind-required-on-the-question-that-names-a-created-case`, which B4 adds; nothing is registered for it | `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards` |
| a Save to Case value written to a date-and-time property: `if(E = '', '', format-date(coalesce(E, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))` | B4 (part 07, section 5) | the write's value is `E`, registered as text | `xform/datetimeCaseValue.ts::datetimeCaseValueExpression` of the proposal, inside the block's re-emission (`blockTreesEqual`) |
| an authored operation's name, rename, owner or external id: the `replace(E, …)` trim of leading and trailing control characters and spaces (`xform/caseOps.ts::caseScalarTextValueCalculation`), and its `nova_guard_<operation>_text` block | B4 (part 07, section 5) | the value is `E`, registered as text; the guard is derived | the same re-emission |
| the excluded-owners clause of the case list filter: `<authored> and (<E> = '' or not(selected(<E>, @owner_id)))`, or the clause alone | B5 (part 07, section 12.4) | `excludedOwnerIds` is `E`, registered as text under the slot `excluded_owner_ids` less the `normalize-space` wrapper; the filter's pending text is the authored operand, or none | `nodesetFilter.ts::emitExcludedOwnerFilterExpression`, over the filter of the short detail `hqJson/caseList.ts::projectCaseListForHq` gives (`projectCaseListFilter` is private until B6 exports it, and B5 does not call it) |
| a validation message that shows an answer: `jr:constraintMsg="if(jr:itext('<id>;__nova_mode') = 'media', jr:itext('<id>'), <composed>)"` and its `__nova_*` itext forms | B3 | the message's prose, read from the ordinary value of the itext id | `xform/constraintMessage.ts::protectConstraintMessage`'s attribute for that prose |
| `nova_constraint_<question>_<n>`: a sibling whose calculate is a count | B3 | the count inlined into the question's `validate` (4.2, `generatedValue`) | the sibling's calculate and the question's constraint as `xform/constraintCollections.ts` emits them |
| `nova_trimmed_`, `nova_datetime_`, `nova_url_` siblings | B4 | the question the action reads, or its `capture-link` | each sibling's `calculate` and `relevant` as the emitter writes them |
| `nova_count_<repeat>` | B3 | the repeat's count expression, registered as text | the sibling's calculate |
| a query repeat's count placement | B3 | one query repeat, its `ids_query` registered as text | the wrapper's four generated binds |
| a link column: `markdown` over `concat('[', <text>, '](', <value>, ')')` | B5 | the link column's text and value | `hqJson/caseList.ts::projectColumnToDetail`'s `field` |
| an interval column and a choice property's label column: `translatable-enum` over a generated expression | B5 | the column kind | the generated expression |
| an after-submit link's held-case conjuncts and the otherwise link's negations | B4, before the expression stage, in `menus/afterSubmit.ts::registerLinkExpressions` (part 07, sections 9.3 and 9.4) | the trailing conjuncts of the stored `xpath` that are `sameSyntax` to the guards the emitter would add are taken off, and what is left is registered as the link's condition; a last link whose tree is the negation of the others' is the otherwise link | the guards `formLinkProjection.ts::formLinkCarriedCaseGuards` gives, built with `rowScope.ts::caseById`; after the stage `settleAfterSubmit` compares `projectAfterSubmit`'s print (its section 9.5) |
| `module_filter` and `form_filter` of `false()` or `false() and (<rest>)` | B4, after the expression stage (9.1; part 07, section 8.3) | the whole text is registered and bound; a tree that is `match-none`, or an `and` led by it, is `hiddenFromMenu` with the remaining clauses as the display condition | `suite/displayConditions.ts`'s print |
| the zero-input `'match-all()'` row, the related-case exclusion, a parent-select module's added row | part 07's `settleSearches`, which lands in B6 | derived | `matchSearchRows` (7.6) |

Markdown itself is no expression: a label's `<value form="markdown">` is read as `plainLabel` and
`plainHelp` by B3 under part 03's rules.

---

## 11. Manifest edits

All in B6, each with its row in the inventory file of its area in the same pull request.

**New entries.**

| Id | Disposition | Keys and class | `item` | `dispositionCell` | Subject, owner |
|---|---|---|---|---|---|
| M1 `expressions-and-data/session-data-datum-the-entry-does-not-supply` | REFUSED, `broken-at-runtime` | `session-path:session/data/*`, `valueClass: "not-supplied"` | "session `data/<datum>` naming a value the form's entry does not supply, a placeholder, or several chosen cases read as one value" | "**REFUSED**: broken at runtime: the entry writes no such node, and a scalar read of a missing session leaf can stop the form (`lib/commcare/CLAUDE.md`, the binding-resolution oracle)" | `expressions` |
| M2 `expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant` | REFUSED, `broken-at-runtime` | `noSurfaceKey`: "a relation between a read and what the form, the catalog and the project space hold, which no surface item states" | "an expression that reads a question, table, column, level or place property that is not there, reads the form's answers or a case where there is none to read, reads several answers where one is needed, or calls a function with a count of arguments it does not take" | "**REFUSED**: broken at runtime: the read stops the form or is blank on a device, and Core refuses the call when it parses the expression" | `expressions` |
| M3 `expressions-and-data/a-form-expression-outside-what-nova-types` | HELD-NEW | `noSurfaceKey`: "the checker's own narrowing of the form rule set, which no surface item states" | "a form expression CommCare runs and Nova's checker refuses for a reason of its own: a comparison CommCare answers by turning one side into a number or a yes or no (a date with a date and time, a yes or no with text, text ordered), a `*` step, a read of a block CommCare HQ's build adds (`meta`, `case`), a default outside a question's choices, a date and time finer than a millisecond" | "**HELD-NEW**: the form rule set's wider vocabulary. Nothing in CommCare HQ needs changing: Core runs the expression today (`XPathEqExpr`, `FunctionUtils.toNumeric`, `::toBoolean`)" | `expressions`, `xform` |
| M4 `case-search/a-search-value-that-queries-cases-a-table-or-places` | HELD-NEW | `schema:DefaultCaseSearchProperty.defaultValue`, `valueClass: "device-data-query"` | "a runtime value read from a `casedb`, lookup table or place query, other than a property of the case chosen in a menu" | "**HELD-NEW**: the union and the checker hold the read; the record dialect has no spelling for it, so no agent could read the app" | `search-expressions`, `case-search` |
| M5 `case-search/required-or-validation-test-reading-the-case` | REFUSED, `not-hq-buildable` | `schema:Assertion.test`, `valueClass: "references-the-case"` | "a Search field's required or validation test holding `#case`, `#parent`, `#host`, or (required) a bare dot" | "**REFUSED**: not HQ-buildable: `xpath.py::_ensure_no_case_references` raises `CaseXPathValidationError`" | `search-expressions` |
| M6 `case-search/required-or-validation-test-outside-what-nova-types` | HELD-NEW | `schema:Assertion.test`, `valueClass: "outside-the-screen-rule-set"` | "a Search field's required or validation test CommCare HQ builds and Nova's checker refuses in that slot" | "**HELD-NEW**: a test over more than the field, its siblings, the session and the worker" | `search-expressions`, `case-search` |
| M7 `case-search/xpath-query-condition-outside-what-nova-types` | HELD-NEW | `csql-key:_xpath_query`, `valueClass: "outside-the-record-rule-set"` | "a search filter CommCare HQ builds and Nova's checker or its CSQL representability rule refuses, by its reason: text ordered, a time ordered, a date-and-time property against text" | "**HELD-NEW**: the record rule set's wider vocabulary in a search filter" | `search-expressions`, `case-search` |

**Edited entries.**

| Entry | Edit |
|---|---|
| `expressions-and-data/session-data-datum` | gains `valueClass: "supplied"`; its cell drops "a placeholder, and a several-case datum read as one value, are refused when the text is read", which M1 now states |
| `case-search/runtime-values-read-from-casedb-or-session-datums` | `valueClass` stays `case-or-datum-terms`; `item` becomes "runtime values read from session datums, the session, the worker, a Search answer, or a property of the case chosen in a menu"; cell "**HELD**: session, worker, answer and chosen-case terms in CSQL values"; M4 takes the rest |
| `case-search/unwrap-list` | cell becomes "**HELD**: `value-list`, with literal and runtime items; read and kept as `list(…)` in the record dialect, which no editor authors anew" |
| `case-search/double-v-today-now` | cell becomes "**HELD**: `double`, `today`, `now`. HQ's `today()` is the project space's day and Nova's is the worker's: a first publish sends the worker's day and says so (`search-today-device-day`)" |
| `case-search/date-only-comparison-on-date-opened-closed-on-last-modified` | stays HELD-NEW; cell becomes "**HELD-NEW**: HQ reads the date as the project space's day (`comparison.py::_create_system_datetime_query`); no read gives Nova that time zone, so neither Preview nor Postgres can evaluate it. Held once a project space's time zone is a fact Nova has" |
| `expressions-and-data/instance-id-current-path-roots` | cell's "`groups` and search inputs wait for later steps, and any other id is refused when the text is read" becomes "`groups` waits for a later step; an id is read by the source its form declares, and any other is refused when the text is read" |
| `expressions-and-data/casedb-jr-instance-casedb` | cell becomes "**HELD**: casedb reads: `form-case` for the form's own case and the cases above it, `cases` queries with `project`, and relation reads in record slots" |

The ten "outside" pairs of part 01's section 3.4 keep the wording A2 gave them. B6 makes that wording
the reader's fact: the HELD class is what `checkExpression` admits, the HELD-NEW class what it refuses.

B6 adds neither of the two entries part 03 writes under a run's outcome: each is A7's, with its
subject and reason (part 03, section 10), and B6 only claims it (9.1, 9.2).

`lib/commcare/surface/__tests__/manifest.test.ts`'s coverage line moves by seven entries: three
`fix-in-hq` (M1, M2, M5) and four `not-yet` (M3, M4, M6, M7). The two HELD entries that share
`schema:Assertion.test` with M5 and M6 keep their value classes, and M7 shares `csql-key:_xpath_query`
with `case-search/several-xpath-query-rows` and with the entries part 07 adds on that key, each under
its own value class. Part 01's copy model holds every sentence these need. One of them lands in B6:
M3 is the first `not-yet` entry of the subject `expressions`, and part 01's section 9.2 holds its
sentence with B6 as the pull request that adds the row to `FINDING_COPY` (Copy, below). Part 01's
Appendix A takes M1 to M7 from this section at B6.

---
## Copy

Every string B6 adds, as it ships. Person-facing strings follow `design/readme.md`, "Content
fundamentals". A finding's own sentence is part 01's (`lib/publish/hqFindingCopy.ts`); B6 adds one
row to its `FINDING_COPY`, which part 01's section 9.2 words:

- subject `expressions`, standing `not-yet`: "An expression here is more than Nova can read yet." Its
  next step is the standing's own, `FINDING_NEXT_STEPS["not-yet"]`. M3 is the entry that needs it;
  M4, M6 and M7 use the `search-expressions` sentence part 01 already holds.

**What the first publish changes** (`lib/publish/firstPublishCopy.ts::REWRITE_SENTENCES`, keyed by
`EmissionRewriteId`; copy lives in `lib/publish` because the review and the publish screen, which may
not import `lib/commcare`, read it; B7 moves these sentences, unchanged, into its register's
`FIRST_PUBLISH_SENTENCES` under the same ids, and the register shows the ones that apply to an app:
part 09, section 10.2). A person reads "expression" for what this part reads, the word part 01's
subject labels use, in every sentence below and in the public docs:

| Id | Sentence | Touches workers |
|---|---|---|
| C1 `instant-comparison` | "An expression that compares two dates and times is now written so it compares the same moment in every time zone. In CommCare HQ's form builder these expressions will look longer." | yes |
| C2 `empty-rows-guard` | "An expression that reads a lookup table, your places or a search answer now reads blank when there is nothing to read. Before, it stopped the form." | yes |
| C3 `absent-session-value-guard` | "An expression that reads the screen width or the app's language now reads blank where CommCare has none to give. Before, it stopped the form." | yes |
| C4 `row-predicate-current` | "Inside a repeat, a choice filter that names another question of that repeat now reads this entry's answer. Before, CommCare stopped on it or used one entry's answer for every entry." | yes |
| C5 `default-reads-current` (only under run E4, outcome B) | "Inside a repeat, a starting value that reads another question of the repeat now reads it from the same entry." | yes |
| C6 `search-value-guards` | "A search value that holds a quote mark is now matched as typed, and a value CommCare HQ can't search by finds no cases. Before, the search failed." | yes |
| C6b `search-today-device-day` | "A search filter that uses today's date now uses the worker's day. In CommCare HQ it used the project space's day, which differs for a worker in another time zone." | yes |
| `filter-identities-dropped` | none: `behavior` is `none`, and the register never shows it | no |

**The guide** (`lib/agent/authoring/reference.ts`, the `expressions` guide, record values):

- C7: "`list(<value>, ...)` can appear in a search condition of an app brought in from CommCare HQ. It
  is several values at once, opposite `=` or `!=`: a case matches when its property equals any one of
  them. Keep it as you read it. You can't add one or change its values here; `in(value, 'a', 'b')`
  matches any of several fixed values."

**A refusal** (`lib/agent/authoring/queryExpressions.ts`, an `AuthoringInputError`):

- C7b, a `list(…)` the slot does not already store: "list() holds several values in a search condition
  of an app brought in from CommCare HQ, and it can be kept as it is but not added or changed here. You
  can use in(value, 'a', 'b') to match any of several fixed values."

**Comments.**

- C8, `lib/agent/authoring/printQueryExpression.ts`, in place of the comment that names the plan's
  top-level file by its path: "The device-data reads (`cases`, `table-rows`, `locations`,
  `selected-cases`, a `project` that is no chosen case's property) have no record spelling. No authoring
  surface stores one and the reader of CommCare HQ's apps refuses the search values that hold one
  (`lib/commcare/reader/expressions/csqlRead.ts`), so none reaches this printer."

**Log lines** (no word of an app: no expression text, no name, no path). The reader holds no logger:
the frame records each line as the `why` of a `ReaderDefect` (part 06, "Copy", defects D11 and D12,
which land in B6), and the reading service logs every defect with `log.error` and the reading's id
when it stores the account (part 12, B10). Each line is the template of one constructor of part
06's `reader/defects.ts::readerDefect` (its 5.1), which fills its two slots from closed sets and
takes nothing else:

- C9, an `unrecognized` expression (`readerDefect.expressionNotWrittenBack(place, reason)`): "Nova read
  an expression from CommCare HQ and could not write the same expression back, at {place}: {reason}. Nova
  treats the spellings in `lib/commcare/reader/syntaxCompare.ts` as one; this one needs a row there with
  a native vector, or a manifest entry that names it." `{place}` is the place by position alone, part
  06's `reader/place.ts::placeKey` (`form[2,0]`, `case-list[1]`: never a menu's, a form's or a question's
  name, and never a path). `{reason}` is the row's `detail.reason` (9.1): `differs:<kind>`, the kind of
  grammar node where the two trees first differ, `parse:<issue code>`, or `no-case-datum`. Each is a code
  of Nova's own. The line holds neither the surface key nor the reading's id: part 12's log line carries
  the first as its log key and the second as the `appId` tag.
- C12, recorded beside C9 (defect D12, `readerDefect.noCaseDatum(place)`) for an `unrecognized`
  slot whose `detail.reason` is `no-case-datum`: "Nova couldn't find the session value that holds
  the case this form opens with, at {place}, so it can't read the form's display condition as
  CommCare HQ builds it. CommCare HQ treats the form as one that opens on a case and Nova's reading
  of its menu and case operations does not; check what the case management reader made of this
  form." `{place}` is `placeKey`'s, as in C9.

**Errors thrown** (invariants, developer-facing; `readHqApp` throws both, part 06, section 2.2):

- C10, thrown by the frame for a registration `readExpressions` lists as `ownerless` where no finding
  stands at or above its place: "Nova was asked to read an expression for a slot the document doesn't
  hold ({slot} of {uuid}), and no finding explains why. The structure readers create every owner before
  expressions are read; check the reader that registered this one."
- C11, a fold that returns a tree for a rule set it is not offered to: "The fold {id} proposed a tree in
  a {ruleSet} slot it isn't offered to. Check `EXPRESSION_FOLDS`: a fold names the rule sets whose slots
  can hold its arm."

**Parse issues.** B6 adds no `FormParseIssueCode` and no message. A reading never shows a parse message
to a person; `detail.reason` carries the code.

**Public docs** (land in B14; the sentences are fixed here). C13 and C14 are on the bring-in page,
`content/docs/bringing-in-from-commcare-hq.mdx`, which part 13 plans (its section 17.1: C13 in item 5,
"When Nova can bring it in", and C14 in item 6, "When Nova can't bring it in yet", each verbatim). The
`list(...)` sentence of `content/docs/mcp/tools.mdx` is in "Contracts and docs these changes make
false" and lands in B14 too.

- C13, under what comes in: "Nova brings in the expressions of your app: display conditions,
  validation, calculations, case list filters and search filters. It keeps the questions, case
  properties and tables they name as links, so renaming one later updates every expression that reads
  it."
- C14, under what Nova can't hold yet: "A case list column, a filter, a display condition or a search
  setting that calls a function such as `int()` or `substr()` can't come in yet. Expressions inside
  forms can use every function CommCare runs."

---

## Tests

B6 has no database write and no screen, so it has no `*.postgres.test.ts` and no Playwright spec. Every
test below builds its document through production models (the fixture builders the emitter's own tests
use, `lib/commcare/__tests__/` and `lib/__tests__/docHelpers`), prints with the production emitter, and
reads with `readExpressions`. No test asserts on a helper's output alone.

| Test | Boundary | The failure it would catch |
|---|---|---|
| `reader/__tests__/syntaxCompare.test.ts` (lands in B2 with the file and rows L1 to L6; B6 adds the S1 and S2 cases) | pure, over `readFormSyntax` | an equivalence wider than its row: `a and (b and c)` equal to `a and b and c`, `a != b` equal to `not(a = b)`, `1` equal to `'1'`, `child::*` equal to a name, `self::a` equal to `.`, S1 applied in a form slot |
| `__tests__/spellingVectors.ts` with `proof/native/core/ReaderSpellingRuntimeTest.java` | Core's parser and evaluator, in the lane (run E1) | a row Core reads as two meanings |
| `reader/__tests__/hqInterpolation.test.ts` (lands in B2 with the file) | pure, over HQ's retained answers; `hqInterpolationSlot` over a real document | drift from `interpolate_xpath`: a literal holding `#case`, `#session/` inside a string, `1.5`, `.5`, `5.`, a dot beside a non-ASCII digit, an astral code point before a dot, a backslash before a quote, each refusal; `syntaxOf` giving spans that do not index the interpolated text; `hqInterpolationSlot` giving the menu's case path for a `case` slot of a form whose last chosen case is not its menu's, or answering a slot where the form has no case-selecting datum |
| the two new cases of `proof/native/test_hq_interpolation.py` | HQ's own helpers, in the lane (run E2) | a vector the port answers differently; a `case` or `no-case` print of a case read that HQ's helper does not turn into the suite print |
| `__tests__/readExpression.form.test.ts` | the parser, the emitter and the checker over a real document | an own-case walk at depth 0, 1 and 2 not read as `form-case`; in a child menu whose own datum is `case_id_<type>`, a walk keyed on `case_id` read as the form's own case; the usercase selector; a default read as no preload; an instance declared under another id; an itext id of HQ's; a count placement's generated names, and a generated node the source names with another suffix; a question named `nova_trimmed_x` taken for a generated node; `normalize-space(` in HQ's text accepted; `#form/x` in a real attribute held or left `unrecognized`, where it claims the invalid-XPath entry; an instance declared from `jr://fixture/user-groups` claiming the REFUSED unrecognized-source entry, where it claims `groups-jr-fixture-user-groups`; `self::node()` in a form path refused; a datum read the projection does not give, in a form listed in `env.entryFactsRefused`, claiming M1, where its index is in `ownerless` and it makes no claim; the same read in a form that is not listed making no claim, where it claims M1; `required="true()"` claimed under `bind-required-expr`, where it claims `bind-required-true`; an `<output>` that reads one answer left a `value` part or claimed under `output-value-any-other-expression`, where it is the reference part and claims `output-value-of-a-question-case-or-user-reference` |
| `__tests__/readExpression.record.test.ts` | the same, over HQ JSON slots | a case list filter with `#parent/p`, with a bare dot, with `current()`; a form's display condition with `#case/p` and `#user/p`; a menu's display condition that names the case; the health starter's filter text; `cond` in a column refused as `call:cond`, where it is held as `if`; `in`, `between` and `switch` not folded, or folded where the print differs; `dob > '2000-01-01'` on a date property refused, where it is held with the literal typed `date`; `name = '2000-01-01'` on a text property typed and refused; `#host/p` held, or refused as anything but the slot's HELD-NEW entry with `relation:host`; a case list filter `true() and p = 1` left `unrecognized`, where it is held as `p = 1`; a filter Nova wrote with a `when-input-present` clause read from the detail text with that clause, or refused |
| `__tests__/folds.withdrawal.test.ts` | the fold loop | a guard inside `count`, and a nested `if` the slot's types refuse as a `switch`, held as anything but the tree the author wrote; a loop that does not end |
| `__tests__/rewrites.test.ts` | `toWire`, `serializeWire` and the filter projection | a rewrite that has a switch withheld and still printed; a site reached and not reported; a relocation site that reports only when the tree stores `absolute`; any byte of today's print changed while `rewrites` is absent (held over the fuzz corpora) |
| `lib/commcare/__tests__/rewriteSentences.test.ts` (B6; B7 deletes it with `REWRITE_SENTENCES`; it sits in `lib/commcare`, which may import `lib/publish`) | the two records | an id of `EMISSION_REWRITE_IDS` with `behavior: "changes"` and no sentence, or `"none"` with one |
| `__tests__/expressionReadBack.fuzz.test.ts` | the emitter and the reader, over `expressionDocArbitrary`, `blueprintDocArbitrary` (`xformDocArbitrary.ts`), `suiteDocArbitrary`, `advancedDocArbitrary` and part 04's `namesDocArbitrary` (run E5) | a slot Nova writes and the reader does not read back; a read that is not `canonicalExpression` of what was written; a second read that differs from the first; a slot Nova wrote that the checker or the dialect judge refuses once read |
| `__tests__/expressionReadBack.fixedPoint.test.ts` | the reader, the emitter and the reader again, over hand-written HQ texts | `read(emit(read(A)))` differing from `read(A)`: an absolute read in a default, an absolute read in a row predicate inside a repeat, a bare date-and-time comparison, an unguarded table read, a filter with `true() and`, a hand-written search row with fixed quotes, a search row calling `today()`; `canonicalExpression(read(A))` differing from `read(A)` |
| `__tests__/documentFacts.test.ts` | `readExpressions` over one document | a Hidden Value whose calculation binds to a date and time leaving another slot's comparison printed bare, which is what a document changed in place after its facts were read gives; the input document changed by the call |
| `__tests__/expressionRounds.test.ts` | `readExpressions` over the largest corpus document and the three starter bases | a slot judged equal in one round and left unchecked after a later round changed a Hidden Value's type; more than four rounds; a loop that reaches `EXPRESSION_ROUND_LIMIT` |
| `__tests__/scanReads.test.ts` | the scan and the binder over a real document | a case property declared twice, or in another order than `noteProperty` gives; a declared property no held slot reads left in the document; a `location_data` slug missing from `worldReads`; a tag the catalog lacks missing from `unreadTables` |
| `__tests__/worldReads.test.ts` | `readExpressions` run twice, with the entities `worldEntitiesFromReads` gives for the first run's `worldReads` added between | `#user/role` and `session/user/data/role` still bound to the name-backed `session-user` leaf on the second run; a built-in slug missing from `userFields` (it stays name-backed by part 11's rule, and must be listed for that rule to see it); a third run that differs from the second |
| `__tests__/slotMode.test.ts` | `expandDoc` over the corpora | a slot whose `HqXPath` carries another interpolation than `slotReadMode` gives; the case path of a form whose last chosen case is not its menu's taken from the menu |
| `__tests__/gateCoverage.test.ts` | the validator over the documents `readExpressions` returns, for the corpora and the starter bases | a validator finding located at an expression slot B6 filled that no claim reported |
| `__tests__/proseValueRules.test.ts` (only where part 03's G1 gave outcome B or its G3 gave outcome C's second case; one group of cases for each rule that landed) | `readExpressions` over a real document whose label and validation message hold outputs | a `value` part the gate's rule refuses held under `questions/output-value-any-other-expression`, which acceptance's gate would then stop with no finding; a value outside the class, or a reference part, refused; the validation message rule applied to a label; the claim made by a test of the reader's own in place of the rule's exported predicate |
| `lib/domain/expression/__tests__/instantTextOfMicros.test.ts` | pure | `instantTextOfMicros` breaking either law of 5.3; year 9999's last second in UTC, the first moment past it, and a moment 100 hours past it |
| `__tests__/printCollisions.test.ts` | the emitter | a row of `PRINT_COLLISIONS` whose two trees print different bytes |
| `__tests__/csqlRead.test.ts` | the CSQL emitter and the reader | HQ's documented `concat('p = "', <answer>, '"')` in double and in single quotes not held at the guards level; a constant `p > today()` left `unrecognized`, where it is held with `search-today-device-day` and no `search-value-guards`; `unwrap-list` with a fixed and with a calculated item; a presence cascade; `dob > '2000-01-01'` refused; `date_opened > '2023-01-01'` and `date_opened = '2023-01-01'` held, or claimed as `unrecognized`, where each claims the system-date HELD-NEW entry; a text property ordered claimed as `unrecognized`, where it claims M7; a property name built at run time held; an unparenthesized second argument held |
| `proof/native/test_csql_reader_parity.py` | HQ's `eulxml` parser and filter builder, in the lane (run E3) | a text HQ refuses and the reader holds |
| `__tests__/searchRows.test.ts` | `composeXPathQueryEmission` over a real module | Nova's own rows not matched exact; a row whose root is `and` not read as its conjuncts; a row a filter clause emitted reported as a field's |
| `__tests__/findings.test.ts` | the manifest | a `FormParseIssueCode` or `CheckErrorCode` with no entry; an entry id that is not in `lib/commcare/surface/entries`; a claim whose entry is HELD for a refusal; a key of `SURFACE_USE_ENTRIES` no entry names; an entry a table answers that is no member of `EXPRESSION_CLAIMS` |
| `__tests__/everyFinding.test.ts` | `readExpressions` over one document | two refused expressions in one app reported as one (the plan's rule that a reading reports every finding in one pass: `../6-bring-in.md`, "The experience in brief"; part 06, decision 1) |
| `lib/agent/authoring/__tests__/readContract.test.ts` (extended; `docs/testing.md`: a stored value a read must print extends the read sweep, not a test of one tool) | every registered read over an app whose search condition holds a `value-list` | a `value-list` that still throws on print, in any read |
| `lib/agent/__tests__/` on `makeAuthoringHarness` (a new case in the search-condition suite) | production's one call body | a condition holding the stored `list(…)` sent back unchanged and refused; a `list(…)` the slot does not store accepted, or refused without C7b; a kept list parsed to a tree other than the stored one |
| `lib/agent/authoring/__tests__/dialectReadBack.test.ts` | `recordDialectRoundTrip` over the record slots `readExpressions` holds, for E5's corpora and the three starter bases | a held record slot the dialect cannot print or reads back differently; the judge reading a kind from an error's text |
| `lib/commcare/surface/__tests__/manifest.test.ts` (existing) | the manifest | the seven new entries breaking a rule: a shared key with no value class, a subject with no sentence |
| `lib/commcare/reader/__tests__/provisional.test.ts` (part 06's file, in B2 with the `provisionalDocument` cases; B6 adds the `bindExpressions` cases) | `bindExpressions` over a draft, with a hand-written `ExpressionReading` and with the real reader | a claim applied to the wrong node; `PendingRegistry.outcome(i)` not giving `bound[i]` and the slot's own claim whose `source` is `i`, or giving a surface use's claim in its place; an `ownerless` registration with a finding at or above its place throwing C10, or one with none not throwing; the first run's trees or findings kept; a tag of `unreadTables` appended twice |
| `lib/commcare/reader/__tests__/claimsBindManifest.test.ts` (part 06's file, in B2; B6 adds the import of `expressions/findings.ts`, so its claims register) | every member of `EXPRESSION_CLAIMS` against the manifest index | a claim under an entry that is gone or renamed; a key the entry does not hold; a use the entry's standing does not permit |
| `lib/commcare/reader/__tests__/defects.test.ts` (part 06's file, in B2; B6 adds the cases of its defects D11 and D12, and joins their two constructors to its closure case) | the frame over an app with an `unrecognized` expression, and with one whose reason is `no-case-datum`, every name, path and expression of the app a marker string | C9 or C12 missing from `ReadOutcome.defects`, or holding a marker: the expression's text, a menu's or a form's name, a question's path; either sentence in `detail.name`, where a person would read it |
| `lib/commcare/reader/__tests__/worldEntities.test.ts` (part 11's, landing in B6 with `worldEntitiesFromReads`) | as part 11's "Tests" writes its `worldEntitiesFromReads` cases | as part 11 writes them |
| `lib/commcare/reader/search/__tests__/rows.test.ts` (part 07's, landing in B6 with `search/rows.ts` and `settleSearches`) | as part 07's "Tests" writes it | as part 07 writes it |

---

## Contracts and docs these changes make false

| Where | Old | New | PR |
|---|---|---|---|
| `lib/commcare/xpath/CLAUDE.md`, "Parsing and identity" | "`sourceProjection` exists only for the raw-snapshot lift's old physical names; normal authoring always uses the current declared structure." | "`sourceProjection` is passed by the raw-snapshot lift, for its old physical names, and by the reader of CommCare HQ's apps, which passes the names the form's own source gave each node and prints through the same projection, so a path binds to the node it names whatever Nova would call it; normal authoring always uses the current declared structure." | B6 |
| the same file, after "Every surface parses through `parseFormExpression`…" | (none) | "The reader of CommCare HQ's apps parses through it too, with `FormParseScope.reading`: the function names Core answers in place of Nova's registry, HQ's own itext and instance ids, every hashtag refused (Core's lexer has no `#`), and the folds of `lib/commcare/reader/expressions/folds.ts`, asked before a node binds. Without the hook the parser is as described here." | B6 |
| the same file, "The tests' `instantParse.ts` recognises the parse structurally, so they read the tree rather than its text." | (stays) | adds: "The reader recognizes the lowering another way, by printing its proposal and comparing syntax trees (`lib/commcare/reader/expressions/`)." | B6 |
| `lib/commcare/xpath/wire/CLAUDE.md`, after the first paragraph | (none) | "A caller may pass `rewrites`: the rewrites of `lib/commcare/emissionRewrites.ts` to leave out of the print, and a callback for each site the print reaches. Only the reader of CommCare HQ's apps passes it, to compare with text that never had them and to say what a first publish changes. Absent, every print is as described here." | B6 |
| `lib/commcare/CLAUDE.md`, opening | "The only package in `lib/` that imports CommCare's vocabulary" (true); no mention of reading expressions | a new subsection "Reading expressions", three sentences: the method of section 2.1, the two levels, and the pointer to `lib/commcare/reader/expressions/` | B6 |
| `lib/agent/authoring/CLAUDE.md`, the record dialect's value spellings | no `list` | "`list(<value>, …)` is `value-list`. It is printed for a tree that holds one, which only an app brought in from CommCare HQ does, and parsed only where the slot being written already stores that same list (`QueryBindings.heldValueLists`): the builder's card for it is display only, so no editor authors one. `recordRoundTrip.ts::recordDialectRoundTrip` is the dialect's own law as a function, which the reader of CommCare HQ's apps is handed so it holds no record tree this dialect cannot print and read back." | B6 |
| `content/docs/mcp/tools.mdx`, the paragraph "Record queries use expressions such as…" | no `list` | adds: "An app brought in from CommCare HQ can hold `list(...)` in a search condition: several values, any one of which matches. It reads back as written and can be kept, not added or changed." | B14 |
| `lib/domain/expression/CLAUDE.md`, "The semantic authority", where it names `literalInstantText` | no inverse | adds: "`instantTextOfMicros` is its inverse for a count of microseconds: the canonical UTC text, or an offset behind UTC where the UTC year is past 9999. The reader of CommCare HQ's apps writes a folded literal back with it." | B6 |
| `lib/commcare/xpath/wire/CLAUDE.md`, "Printing" | `literalTokens` private | adds: "`serialize.ts` exports `literalTokens` for one reader, the canonical form of a `concat` of literals (`lib/commcare/reader/expressions/canonical.ts`); no emitter calls it." | B6 |
| `lib/agent/authoring/printQueryExpression.ts`, the default arm's comment | names the plan's top-level file by its path, `docs/plans/hq-round-trip/6-bring-in.md` (the plan's own pull request changed the path there from the outline's file, which it removed), a file B15 removes | C8 | B6 |
| `lib/models.ts::MODEL_CONTEXT_VERSION` | the value stack A deploys (`"v7-hq-round-trip-bring-in.a9"`, or `.a10` where A10 wrote one) | `"v7-hq-round-trip-bring-in.b6"` | B6 |
| `proof/README.md`, "Native proofs" | the families' tests | adds `ReaderSpellingRuntimeTest` (family `expression`), the two new cases of `test_hq_interpolation.py` with its rewritten `limits` line, and `test_csql_reader_parity.py` (family `csql`), each with one sentence of what it holds | B6 |
| `docs/research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md`, `case-search.md` | the rows of the seven edited entries | the cells of section 11, and the seven new rows beside the rows they split from | B6 |
| `docs/architecture/complex-apps.md` | no account of HQ's interpolation | a subsection "How CommCare HQ rewrites a display condition and a filter": the table of section 6.1 (slot, call, case path, dots), and "HQ replaces these as text, inside string literals too, so Nova splits a literal that holds one and reads HQ's text through the same replacement before parsing it." | B14 |
| `docs/architecture/complex-apps.md`, case search, after the sentence that begins "A search reads `today()` as the worker's day: Nova sends Core's `today()` in a" | (none) | adds: "CommCare HQ's own `today()` in a search is the project space's day. An app brought in that uses it reads as Nova's `today`, and its first publish says the day is now the worker's." | B14 |
| the outline, items 8, 9 (guarded and `current()` reads) and 10 (query repeats' spelling) | the outline's text | replaced by this part and removed with the whole outline by the plan's own pull request, before either stack; no stack pull request edits it | the plan's own pull request |
| `content/docs/bringing-in-from-commcare-hq.mdx` | (new page, part 13, section 17.1) | C13 in its item 5 and C14 in its item 6 | B14 |

`lib/domain/expression/CLAUDE.md` stays true but for the one sentence above: the checker, the rule sets
and the union do not change in B6. `components/builder/CLAUDE.md`'s sentence on `ValueListCard` stays
true, and is the reason the dialect only keeps a list. `design/` does not change: B6 has no screen.
The sibling `nova-plugin` repository holds no claim B6 changes (8.3).

---

## Departures

Departures from the outline, and the decisions this part took where an alternative was weighed and
not taken. Each keeps its number, which other parts cite.

1. **From outline item 8 ("the reader reads `unwrap-list` into `value-list` and each read into its
   arm", both HELD from step 3).** `value-list` is read, and gains a record spelling, `list(…)`, that
   is printed and kept and that no editor writes anew (8.3): the builder's card for the arm is display
   only, and a spelling the Solutions Architect could author would be content one editor makes and
   another cannot. A search value that queries `casedb`, a table or the place list is not read: it
   is not-yet under the new entry M4. Evidence:
   `lib/agent/authoring/printQueryExpression.ts::queryPrinter` throws on those arms and `output.ts`
   prints every expression of a module, so such an app could not be read by the Solutions Architect
   or over MCP. A query sublanguage in the record dialect is an authoring feature no pull request
   of either stack builds.
2. **From outline item 8, fourth bullet (this step admits `call` in record slots and compiles the
   functions an imported calculated column uses).** Not-yet for every function (8.1), with `cond` read
   as nested `if`. Evidence: the checker refuses the arm for every author
   (`typeChecker.ts`, `arm-unavailable`), `CardValueKind` has no card for it, the dialect has no
   spelling, and Core's coercions (`FunctionUtils.toNumeric`, `XPathSubstrFunc::substring`,
   `FunctionUtils.normalizeCase`) are not Postgres's. HQ's own starter apps call no function in a record
   slot but `cond` and `concat`.
3. **From outline item 8, first bullet, and beyond it.** The date-only comparison on a system date
   stays HELD-NEW, as the outline allowed. HQ's server-side `today()`, which the outline does not name,
   is read as Nova's `today` with a declared first-publish change.
4. **The folds run inside the binder, and the trees compared are syntax trees.** The binder asks the
   folds through `FormParseScope.reading` before it binds a node (4.2, 5). Not done:
   `parseFormExpression` as it stands and then one fold-back pass over the bound tree. Evidence:
   `formPathBinding.ts::instancePath` refuses a predicate on a session path, so `…/stringquery[1]`
   has no bound tree for a later pass to fold; and a parsed text has no `WireExpr` (2.2).
5. **There is no second binder for record slots.** `bindFormPath` already binds a row-relative step
   by `activeRowScope`, and a record slot is the same parser under its own context with record folds
   (6.2). Not done: a record-rule text reader of its own (a `recordBinder.ts` beside the form
   parser), for that reason. The CSQL binder is new, since CSQL's vocabulary is not device XPath's.
6. **B6 creates the `EMISSION_REWRITES` registry, and its sentences live in `lib/publish`.** B6
   creates the one registry, under that name, with its eight expression entries and the switch the
   emitter reads, because the reader's second acceptance level needs it and B6 lands beneath B7. B7
   appends the other rewrites to the same const and builds the register (part 09, section 10). Not
   done: a registry B7 creates, or one whose entries each carry their sentence. The sentences live in
   `lib/publish/firstPublishCopy.ts`, keyed by the same id type, because `biome.json` keeps
   `lib/publish` and `components/` from importing `lib/commcare` and the review screen reads them;
   B7 moves them into the register's own record in that file, `FIRST_PUBLISH_SENTENCES`, and
   deletes `REWRITE_SENTENCES` (part 09, Departure 18).
7. **A datum id is bound against Nova's projection; HQ's entry datums are not compared.** HQ's entry
   datums are no part of an app's source: its build computes them. The reader can only bind each id
   an expression names against Nova's projection; an id the projection does not give is M1. Not
   done: requiring HQ's entry datums for a form to equal `entryDatumIds` before its expressions bind,
   and refusing on a difference by naming the datum, because the source holds none to compare. That
   the projection equals HQ's build is proof 3's over the bases.
8. **The scan is B6's first step, and it is narrow.** It declares only case properties an expression
   reads and nothing writes. Not done: a scan stage of its own, ahead of the structure readers, that
   gathers everything binding needs (lookup tags, worker and location slugs, case types, level
   codes). Lookup tables, levels and case types are in the provisional document before B6 runs, from
   the readers and inputs that own them (parts 07 and 11). Worker properties and location properties
   are learned from a first run and minted by the frame before the second (part 11, section 11.5),
   because the binder gives the identity leaf only for a slug the document holds
   (`referenceBindings.ts::formUserProperty`).
9. **A changed printed itext id is accepted.** An imported form's itext ids are regenerated on emit,
   so a `jr:itext('<id>')` in form logic prints Nova's derived id after a bring-in. An itext id is
   local to a form's source (3.3); the unit it names is what an expression holds.
10. **Beyond the outline.** Seven manifest entries (section 11), `MODEL_CONTEXT_VERSION` moving in B6
    for the guide's one sentence, the rewrite `filter-identities-dropped`, and one new function of
    `lib/domain/expression` (`instantTextOfMicros`).
11. **A real attribute and its `vellum:` shadow that disagree are B3's to find, not B6's.** The
    check is part 06's (its section 14), because a shadow is a fact of the form's source and needs
    no bound tree. Not done: a second check in B6, beside the reading of expressions (10.1).
12. **`#parent` is read; `#host` is not-yet (6.3).** `#host` is a spelling of a relation read Nova
    holds only with a case type on the step, and HQ's text names none. Not done: reading `#host` as
    one more of HQ's spellings of what Nova holds.
    Evidence: `relationDestination.ts` refuses a step other than `parent` that names no case type, and
    `rowScope.ts::caseById` prints a type test for one that does, which HQ's interpolation of `#host`
    does not write (`xpath.py::interpolate_xpath`).
13. **The expression step has no wall-clock bound.** Not done: a wall-clock bound on the expression
    step that raises `too-large`, because `readExpressions` is pure and has no clock, and a finding
    that depends on the machine's speed would make one app read two ways. The loop is bounded by
    rounds (`EXPRESSION_ROUND_LIMIT`), `rounds` is returned for the log, and the reading's deadline
    stays the reading service's, around the whole check (2.5; part 12, section 3.6).
14. **The guide gains one sentence for `list(…)`, and `MODEL_CONTEXT_VERSION` moves for it.** The
    spelling is kept for read-back and not authored. Not done: leaving the guide without the
    sentence so the version does not move, because the Solutions Architect will read `list(...)` in
    an adopted app and must know to keep it; that sentence moves the version (part 15, section 1.3).
15. **No departure on migration.** No stored document changes shape: the union, the schema and the
    checker are untouched, and every slot B6 fills is one that exists today.

---

## Files by pull request

B6, except the three files marked B2: they import nothing of the reader, and B3 to B5 call them, so
they land with the frame. This part is their author, and part 06 lists all three in B2 (its section
2.1 and its "Files by pull request"). B6 also lands code that parts 06, 07 and 11 author, because
each piece names a B6 export (a declaration lands in the lowest pull request that names it, and a
call in the pull request that creates its callee): part 11's `worldEntities.ts` and part 07's search
row files under "New", and part 06's `bindExpressions` and `expressionEnvOf` under "Edited". The docs
rows marked B14 and B15 in "Contracts and docs these changes make false" land there (part 15).

**New.**

| File | Exports | PR |
|---|---|---|
| `lib/commcare/reader/pendingExpressions.ts` | `ReadMode`, `PendingExpression`, `pendingPlaceholder` (2.5); part 06 adds its `PendingRegistry` | B2 |
| `lib/commcare/reader/syntaxCompare.ts` | `sameSyntax`, `firstDifference`, `sameXPathText`, `CompareOptions`, with rows L1 to L6; B6 adds S1 and S2 | B2, B6 |
| `lib/commcare/reader/hqInterpolation.ts` | `interpolateHqXPath`, `dotInterpolate`, `syntaxOf`, `hqInterpolationSlot`, `HqInterpolationSlot`, `HqInterpolated`, `HQ_USERCASE_XPATH`, `hqCaseByIdXPath` | B2 |
| `lib/publish/emissionRewriteIds.ts` | `EMISSION_REWRITE_IDS`, `EmissionRewriteId` | B6 |
| `lib/publish/firstPublishCopy.ts` | `REWRITE_SENTENCES` (B7 moves it into the register's copy (`FIRST_PUBLISH_SENTENCES`) and deletes this record and its test) | B6 |
| `lib/commcare/emissionRewrites.ts` | `EMISSION_REWRITES`, `EmissionRewrite`, `RewriteControl` | B6 |
| `lib/commcare/reader/expressions/index.ts` | `readExpressions`, `ExpressionReadEnv`, `ExpressionReading`, `ExpressionClaim`, `GeneratedValue`, `RecordDialectJudge`, `EXPRESSION_ROUND_LIMIT` | B6 |
| `lib/commcare/reader/expressions/readExpression.ts` | `readExpression` (one slot: bind, print, compare), `SlotJudgment`, `readingScope`, `sourceNodeProjection`, `slotReadMode` | B6 |
| `lib/commcare/reader/expressions/folds.ts` | `EXPRESSION_FOLDS`, `Fold`, `FoldId`, `FoldEnv` | B6 |
| `lib/commcare/reader/expressions/canonical.ts` | `PRINT_COLLISIONS`, `PrintCollision`, `canonicalExpression` | B6 |
| `lib/commcare/reader/expressions/csqlRead.ts` | `readSearchFilterRow`, `SearchRowReading`, `SearchRowEnv` | B6 |
| `lib/commcare/reader/expressions/searchRows.ts` | `matchSearchRows`, `readSearchRowConjuncts` | B6 |
| `lib/commcare/reader/expressions/scanReads.ts` | `scanReads`, `ScannedReads` | B6 |
| `lib/commcare/reader/expressions/findings.ts` | `EXPRESSION_CLAIMS`, `SLOT_ENTRIES`, `parseIssueEntry`, `checkErrorEntry`, `formRefusalEntry`; under part 03's G1 outcome B or G3 outcome C (second case), the prose row's call of that rule's predicate and one more member of `EXPRESSION_CLAIMS` for its entry (9.1) | B6 |
| `lib/commcare/reader/expressions/surfaceUses.ts` | `expressionSurfaceUses`, `SURFACE_USE_ENTRIES` | B6 |
| `lib/agent/authoring/recordRoundTrip.ts` | `recordDialectRoundTrip` | B6 |
| `lib/commcare/reader/__tests__/syntaxCompare.test.ts`, `lib/commcare/reader/__tests__/hqInterpolation.test.ts`, `lib/commcare/reader/__tests__/interpolationVectors.ts` | the tests and the vector file of the B2 files ("Tests"); B6 adds the S1 and S2 cases to the first | B2, B6 |
| `lib/commcare/reader/expressions/__tests__/*`, `lib/commcare/__tests__/rewriteSentences.test.ts`, `lib/agent/authoring/__tests__/dialectReadBack.test.ts`, `lib/domain/expression/__tests__/instantTextOfMicros.test.ts` | the tests and vector files of "Tests" | B6 |
| `proof/native/core/ReaderSpellingRuntimeTest.java` | run E1 | B6 |
| `proof/native/test_csql_reader_parity.py` | run E3 | B6 |
| `lib/commcare/reader/worldEntities.ts`, `lib/commcare/reader/__tests__/worldEntities.test.ts` | part 11's file, exactly as its section 11.5 writes it: `worldEntitiesFromReads`, with its test. `levelsFromHq` joins the same file in B9 | B6 |
| `lib/commcare/reader/search/rows.ts`, `lib/commcare/reader/search/__tests__/rows.test.ts`, and the function `settleSearches` of `lib/commcare/reader/search/index.ts` (the file is B5's) | part 07's, exactly as its section 12.3 writes them: `classifySearchRows`, `settleSearches` | B6 |

Part 07's `settleSearches` and `search/rows.ts` call `csqlRead.ts` and `searchRows.ts`, so they land
in B6 with them; in B5 a menu holding an `_xpath_query` row has that key unclaimed and reads to an
account.

**Edited.**

| File | Edit |
|---|---|
| `lib/commcare/xpath/formParseScope.ts` | `FormReadingHooks`, `FoldApi`, `FormParseScope.reading` |
| `lib/commcare/xpath/expressionAst.ts` | the hook in `bind`, `call`, the `hashtag` node and `jr:itext` (4.2) |
| `lib/commcare/xpath/formPathBinding.ts` | `instancePath`: the declared source; `bindFormPath`: the hashtag refusal, generated values and `current()` on a case row; `rowValue`: the alias switch |
| `lib/commcare/xpath/wire/fromExpression.ts` | `WireBuildContext.rewrites`; the three guard sites, `compareSides` and the search text read it |
| `lib/commcare/xpath/wire/formReads.ts` | `formReadToWire` reads `rewrites` at its two relocation sites and calls `reached` there |
| `lib/commcare/xpath/wire/serialize.ts` | exports `literalTokens` (for `canonical.ts`) |
| `lib/commcare/hqJson/caseList.ts`, `lib/commcare/suite/case-list/nodesetFilter.ts` | `projectCaseListFilter` (exported by B6) and `emitNodesetFilter` take `rewrites?: RewriteControl` as an optional last argument and skip `effectiveFilterForEmission`'s simplification under `filter-identities-dropped` |
| `lib/commcare/csql/emitter.ts` | no change to `CsqlEmissionContext`, which is `Omit<WireBuildContext, "target">` and so holds `rewrites`; the emitter hands it to the `toWire` call of each runtime value (2.3) |
| `lib/commcare/reader/provisional.ts` (part 06's file, B2) | `bindExpressions`, as part 06's section 2.3 writes it: the two runs of `readExpressions` with `worldEntitiesFromReads(worldReads, ctx.resolver)` between, the second run's answer applied (the document, the claims by `source` through `Accounting.claimEntry`, the circumstances, `rewrites`, `declaredProperties`, each `unreadTables` tag, `rounds` as `ReadFacts.expressionRounds`), `readsLocations` set, `PendingRegistry.outcome` filled from `bound` and each slot's own claim, each `ownerless` index covered by the finding at or above its place or C10 thrown, and C9 and C12 recorded as the defects D11 and D12 |
| `lib/commcare/reader/types.ts` (part 06's file, B2) | `ReadFacts.rewrites`, `ReadFacts.declaredProperties`, `ReadFacts.expressionRounds` and `ReaderInput.recordDialect`, each as part 06's sections 2.2 and 17.3 type them |
| `lib/commcare/reader/xform/index.ts` (part 06's file, B3) | `expressionEnvOf(ctx)` (part 06, section 17.2), building `sourceNames`, `recordDialect` and `entryFactsRefused` among the members of `ExpressionReadEnv` |
| `lib/commcare/reader/index.ts` (part 06's file, B2) | `STAGES` gains `settleSearches` in stage 8; stage 7 runs `bindExpressions` after `provisionalDocument` (part 06, section 2.3, row 7) |
| `lib/commcare/xform/formExpressions.ts`, `lib/commcare/expressionContext.ts`, `lib/commcare/suite/case-search/xpathQuery.ts` | export the slot build contexts the emitters use, so the reader prints with the same one |
| `lib/domain/expression/instantOperand.ts` | `instantTextOfMicros` (5.3) |
| `lib/agent/authoring/printQueryExpression.ts`, `queryExpressions.ts`, `bindings.ts`, `reference.ts` | `list(…)`: print; parse under `QueryBindings.heldValueLists`, which `bindings.ts` fills from the stored slot; the refusal C7b; the guide sentence C7; the comment C8 |
| `lib/models.ts` | `MODEL_CONTEXT_VERSION` |
| `lib/commcare/surface/entries/expressions-and-data.json`, `case-search.json`, `lib/commcare/surface/__tests__/manifest.test.ts` | section 11: the seven new entries, the seven edited ones, and the test's coverage line |
| `lib/commcare/reader/defects.ts` (part 06's file, B2) | the two constructors `readerDefect.expressionNotWrittenBack` and `readerDefect.noCaseDatum`, whose templates are C9 and C12 ("Copy"; part 06, section 5.1) |
| `lib/commcare/reader/__tests__/provisional.test.ts`, `claimsBindManifest.test.ts`, `defects.test.ts` (part 06's files, B2) | the `bindExpressions` cases, the import of `expressions/findings.ts`, and the cases of D11 and D12 with the two constructors joined to the closure case ("Tests") |
| `lib/agent/authoring/__tests__/readContract.test.ts`, the search-condition suite of `lib/agent/__tests__/` | the `value-list` read and the kept `list(…)` cases ("Tests") |
| `lib/publish/hqFindingCopy.ts` (part 01's) | the one `FINDING_COPY` row of "Copy": `expressions` at `not-yet` (part 01, section 9.2) |
| `proof/native/families.py`, `proof/native/producers/emit-expression-evidence.ts`, `proof/native/producers/emit-csql-evidence.ts`, `proof/native/test_hq_interpolation.py`, `proof/native/core/RowPredicateCurrentRuntimeTest.java` | the vectors and cases of runs E1 to E4 |
| `biome.json` | nothing: the reader lives inside `lib/commcare`; `lib/commcare` imports `lib/publish` as it does today (`planPrivileges.ts`, `projectSpaceCompatibility.ts`); `lib/agent`, an allowed consumer, imports the reader's types for `recordRoundTrip.ts`; nothing of `lib/commcare` imports `lib/agent` |
| the docs of "Contracts and docs these changes make false" marked B6 | as written there |

---

## What this part needs of other parts

Each bullet below states the seam as the other part writes it; part 15's is
what this part hands the stack. Nothing here is asked of a part that no section of that part names: part
06's 11.1 holds a `required` of `false()` as this part does, and part 12's log line carries the round
count.

- **Part 06 (`06-the-reader-forms.md`; B2, the reader's frame).**
  - B2 carries the three files this part authors (its section 2.1 and its "Files by pull request",
    B2): `pendingExpressions.ts`, `syntaxCompare.ts`, and `hqInterpolation.ts` with
    `__tests__/hqInterpolation.test.ts` and `__tests__/interpolationVectors.ts`. B6 adds rows S1 and
    S2 to `syntaxCompare.ts` and nothing else to either of the other two.
  - `PendingExpression` has no `shadow` member (its section 11.1).
  - `PendingRegistry.register(...)` returns the registration's index, and `outcome(index)` answers
    `{ expression, claim }` (its section 11.1): `bindExpressions` fills it from
    `ExpressionReading.bound[index]` and the slot's own claim, the one whose `source` is `index` and
    whose `key` is the registration's `key`. Before B6, and for a registration nothing bound, both
    are undefined.
  - `provisional.ts::bindExpressions` lands in B6, in this part's file list, as its section 2.3
    writes it. It calls `readExpressions` twice: the first run is kept only for `worldReads`,
    `worldEntitiesFromReads(worldReads, ctx.resolver)` gives the worker and location properties,
    which are added to the provisional document, and the second run is the reading. It applies
    `ExpressionReading.doc`, the claims by their `source` index through `Accounting.claimEntry`
    (a claim whose `source` is `-1` to the form's `instance` element its key names), the
    circumstances, `rewrites` and `declaredProperties`; appends each tag of `unreadTables` to
    `ReadFacts.unreadTables` as `{ tag, place: { kind: "lookup-table", tag } }`, a tag already
    listed left as it is; keeps `rounds` as `ReadFacts.expressionRounds`; and sets the outcome's
    `readsLocations` from `worldReads.locationDataSlugs` and the bound trees (its section 2.3). In
    B2 to B5 stage 7 is `provisionalDocument` alone.
  - `Accounting.claimEntry` takes an entry by id, and an id no registered claim holds is its defect
    D9 (its section 4.3). So B6 registers every entry id it can answer with
    `defineClaims("expressions", …)`, as `EXPRESSION_CLAIMS` in `expressions/findings.ts` (9.2), and
    adds that file's import to its `claimsBindManifest.test.ts`.
  - `xform/index.ts::expressionEnvOf(ctx)` lands in B6 too (its section 17.2). It builds, beside the
    maps that section lists, `sourceNames` (`ReadXForm.sourceNames`), `recordDialect`
    (`input.recordDialect`) and `entryFactsRefused` (the set of `ctx.facts.entryFactsRefused`); it
    builds no `hashtags`. `ReaderInput.recordDialect` is typed by this part's `RecordDialectJudge`
    and added to its section 2.2 type by B6, as are `ReadFacts.rewrites`,
    `ReadFacts.declaredProperties` and `ReadFacts.expressionRounds` (its section 17.3).
  - Each index of `ExpressionReading.ownerless` is claimed under the finding that stands at or above
    its place, else the frame throws C10 (its section 2.3; this part's 2.5). Its stand-in fields
    keep a read of a refused question binding.
  - It turns each `ExpressionClaim` whose entry is HELD-NEW or REFUSED into a finding (standing,
    cause, subject and owner from the entry), raises `unrecognized` for each `circumstances` row, and
    records C9 and C12 as this part words them, through its `readerDefect.expressionNotWrittenBack`
    and `readerDefect.noCaseDatum` with the place printed by its `placeKey`, as the defects D11 and
    D12 of its "Copy", which land in B6. The reader holds no logger (its section
    2.2); part 12 logs each defect at error.
  - The platform declaration is its assembly's (its section 16.3); B6 hands it nothing (9.1).
  - This part adds no row to its `assemble.ts::READER_CANONICAL_CHOICES` (its section 16.2):
    `expression-print-collisions` is `canonicalExpression`, which part 09's `canon.ts` wraps.
- **Part 06 (`06-the-reader-forms.md`; B3, the form reader).**
  - It registers its section 11.1's slots with `mode` `{ target: "xform", constraint }`, `constraint`
    true for a `validate` alone, and gives `itextUnits`, `instanceSources`, `generatedValues` and
    `sourceNames` through `env`.
  - `required` is one slot whatever the attribute holds (its section 11.1). B6 claims
    `questions/bind-required-true` where the text binds to `match-all` and
    `questions/bind-required-expr` otherwise (9.2). B6 holds a `required` of `false()` as the
    `match-none` it binds to: a Nova document can store `match-none` there, it prints `false()`,
    and run E5 requires the read of Nova's own print to be the tree that printed it. Part 06's
    section 11.1 says the same.
  - An `<output>` it registers under a prose slot is one registration per pending `value` part, in
    part order (its sections 12.3 and 17.2). B6 writes each bound tree at that part's place as
    `canonicalProseAtom` gives it (2.5, step 2), and claims the output under
    `questions/output-value-of-a-question-case-or-user-reference` for a reference part and
    `questions/output-value-any-other-expression` for a `value` part (9.2). Its stage 9
    (`finishText`) reads the parts from `ctx.doc`.
  - The shadow check and the literal outputs are its own (`reader/xform/shadow.ts`,
    `reader/xform/prose.ts::literalOutputText`; its sections 14 and 12.3), and this part's 10.1 and
    10.2 say the same.
  - The scalar check on a question's `constraint` and a row guard's left operand are registered by
    their left operand's source text (its 11.1 table), which is the first row of 10.3.
  - It takes the entry of a default's setvalue (its 11.2), of a repeat (its 10.3) and of a Connect
    block (its 15); B6 claims the registered attribute under the same entry, by the slot table of
    9.2.
  - B6 claims each instance declaration once it has bound the form's expressions: the entry of the
    key for one a held expression reads, and the INERT
    `expressions-and-data/declared-unreferenced-fixture-instance-item-list-locations-user` or
    `expressions-and-data/declared-unreferenced-instance-whose-source-loads-no-data-casedb` for one
    no held expression of the form reads, through `expressionSurfaceUses` (9.3).
- **Part 07 (`07-the-reader-cases-menus-lists.md`; B4 and B5).**
  - It registers with `ctx.pending.register(expression, at)` and this part's `PendingExpression`
    (`ref`, `text`, `mode`, `place`, `key`), which returns the registration's index `i`. A settle
    function reads `ctx.pending.outcome(i)`: `outcome(i).expression` is
    `ExpressionReading.bound[i]`, and `outcome(i).claim` the slot's own claim whose `source` is `i`,
    the entry this part claimed and why.
  - `sameSyntax(a, b)` with two arguments is the record comparison (3.1). `syntaxOf(text, slot)`
    takes the slot's `HqInterpolationSlot`, built by `hqInterpolationSlot(doc, ref, interpolation)`,
    or undefined for a slot HQ does not interpolate (6.1), since a `case` slot's text cannot be
    interpolated from a mode name alone. `sameSyntax` in `syntaxCompare.ts`, and `syntaxOf`,
    `dotInterpolate` and `hqInterpolationSlot` in `hqInterpolation.ts`, all land in B2.
  - **Before the expression stage** (its section 2.1, steps 2 to 4): everything 2.5 lists as what the
    document must hold. `caseManagement/index.ts::compareEntryFacts` then records each form whose
    entry facts differ in `ReadFacts.entryFactsRefused`, typed `readonly Uuid[]`, with its finding
    at the form (its section 6.3); this part takes the list as `env.entryFactsRefused` and raises no
    M1 for a datum read of such a form, whose registration it lists in `ownerless` (2.5, 9.2). Last,
    `menus/afterSubmit.ts::registerLinkExpressions` resolves the selection each carried value names,
    takes the emitter's held-case guards off each link's `xpath`, and registers the link's condition
    and carried values (its section 9.4), so no guard is in a condition this part binds.
  - **After the expression stage, over the registrations' outcomes**: the preload order; a form's
    after-submit comparison (its section 9.5); the row classification; and the hidden spelling of a
    display condition, where its section 8.3 registers a `module_filter` or a `form_filter` whole
    and `settleMenus` reads `match-none`, or an `and` led by it, off the outcome (9.1, 10.3).
  - It gives B6 `operationIdPaths` (its section 5.2). It writes a `case_preload` entry as the
    question's `form-case` default itself. Its
    `caseManagement/catalog.ts::noteProperty(caseTypes, caseType, name)` is a function of a catalog
    (its section 7), which B6's scan applies to its clone of the document (2.5 step 1).
  - B5 removes the excluded-owners clause from the case list filter's text before registering it
    (its section 12.4), comparing through `projectCaseListForHq`. The private
    `hqJson/caseList.ts::projectCaseListFilter` is exported by B6, which edits it to take
    `rewrites`, is its only caller outside the file, and prints the filter through it (2.1).
  - Its `search/rows.ts`, its `settleSearches` and `search/__tests__/rows.test.ts` call
    `readSearchRowConjuncts` and `matchSearchRows`, so they land in B6 ("Files by pull request"),
    and `settleSearches` joins `STAGES` in B6. A B5 test that needs a bound expression fills the
    registry's outcome by hand.
  - Its row classification (its section 12.3) holds a clause of the case list filter that waits for
    its Search fields as the second candidate of its kind D, kept where `matchSearchRows` reports
    the row `from: "filter"` (7.6). Without it Nova's own filter holding `when-input-present` would
    read back as a field's condition or a finding, and proof 6 would fail on the emitter's own
    documents.
  - Neither B4 nor B5 claims a `…-outside-…` entry of the ten pairs of part 01's section 3.4: B6
    does, from the checker's verdict, by the column "Refused, by default" of 9.2. B6 also claims
    `forms-and-case-writes/form-filter-reading-case-status-case-id-case-type-owner-id`, as its
    section 8.3 assigns (9.2).
  - It dot-interpolates an image map's key with `dotInterpolate(key, <the column's property path>)`
    (its section 11.2; 6.1).
  - It claims the `required` of a question that names a case the form creates itself, under the
    INERT `questions/bind-required-on-the-question-that-names-a-created-case` it adds in B4, and
    nothing is registered for that attribute (its section 3); B6 claims neither
    `questions/bind-required-true` nor `questions/bind-required-expr` there.
- **Part 09 (`09-acceptance-and-the-first-publish.md`; B7, acceptance and the register).**
  - `FIRST_PUBLISH_CHANGES` takes one entry per expression id of `EMISSION_REWRITES` whose `behavior`
    is `changes`, under the same id, with the sentence of that id, the entry's `touchesWorkers`, and
    as its predicate "the reading's `rewrites` hold the id" (its section 11.2, rows 7 to 12). B7
    appends its own rewrites to `EMISSION_REWRITE_IDS` and `EMISSION_REWRITES`, renames none of
    B6's, and adds no second id for an empty-rows guard (`empty-rows-guard` is the one). It adds
    `sites`, `what`, `withholdable` and `declaredBy` to `EmissionRewrite` and fills them for B6's
    eight entries from the table of 2.3 (its section 10.1).
  - B7 moves `REWRITE_SENTENCES` into the register's copy (`FIRST_PUBLISH_SENTENCES`) and deletes
    this record and its test, `lib/commcare/__tests__/rewriteSentences.test.ts` (its Departure 18):
    seven sentences, C1 to C6b, of which C5 lands only on run E4's outcome B.
  - Acceptance check 3 (its section 5) holds for expressions because what B6 stores is what the
    unwithheld print reads back as (2.3): a re-read of Nova's emission is exact at every slot.
  - Its fixed-point re-read passes the same `recordDialect`, lookup catalog and organization as the
    reading, and runs the reader's two runs as the reading did (its section 5.2).
  - Its `lib/commcare/reader/canon.ts` wraps `canonicalExpression` as the canonicalization
    `expression-print-collisions`, held by this part's `printCollisions.test.ts` (its section 9).
  - A gate finding located at an expression slot that still reaches acceptance check 2 (its section
    4) is one `gateCoverage.test.ts` did not foresee. How acceptance words a gate failure is part
    09's; this part's share is run E5's outcome E, before B6 merges.
- **Part 11 (`11-project-data.md`; B9, project data).**
  - `env.lookup` is `ReaderLookupCatalog.definitions` (its section 5.5). A table it could not bring
    in is absent from it; B6 lists the tag in `unreadTables` and makes no second finding (9.2), and
    part 11 raises M2 at the table's place for a tag CommCare HQ's list lacks (its section 5.1).
  - `ExpressionReading.worldReads` has exactly the shape its section 11.5 writes
    (`userFields`, `locationDataSlugs`), and `readExpressions` is run twice by the frame as it orders.
    `worldEntitiesFromReads` lives in `lib/commcare/reader/worldEntities.ts`, which part 11 authors
    and B6 lands with this stage; `levelsFromHq` joins the same file in B9. Before B9, a test that
    needs levels in the provisional document puts them on the draft by hand.
  - M2 keeps its id, and its item begins "an expression that reads a question, table, column, level
    or place property that is not there" (11), which is the class its section 5.1 uses it for.
- **Part 12 (`12-the-reading-and-the-birth.md`; B10, the reading).** Its worker's `readHqApp` call
  passes `recordDialect: recordDialectRoundTrip` (its section 3.3, step 7.1, and its 3.6). It logs
  each `ReaderDefect` at error with the reading's id when it stores the account, C9 and C12 among
  them. It proposes no platform declaration of its own after `readExpressions`: part 06's assembly
  decides the choices (9.1), and part 12 offers the ones acceptance passed (its "What this part needs
  of other parts", parts 07 and 08). Its `[reading] step` log line
  (its section 10) carries, where `operation` is `read` and the reader gave a draft,
  `expressionRounds`, the count the frame keeps as `ReadFacts.expressionRounds`, beside the
  `elapsedMs` it writes; `expressionRounds.test.ts` holds the bound.
- **Part 13 (`13-the-experience.md`; B11, B12).** Its bring-in page carries C13 and C14 verbatim
  (its section 17.1, items 5 and 6). Its section 15.1 counts C7 among the guide sentences stack B
  has added before B12. Its run E1, asked once at B12's head, is stack B's one billed check, and it
  covers B6, which changes no tool input schema.
- **Part 14 (`14-proof.md`; A1 and B13, proof).** Proof 6 reaches `expression-print-collisions`
  through part 09's `canonDocument` (its section 5.5). The bases `starter-health`,
  `starter-agriculture` and `starter-wash` run E6, inside its P2 dispatch on B13's branch. One
  variant per new entry M1 to M7, each with `expected.json` naming the entry and its standing (its
  section 7.2). `hq-expressions` and `hq-search` hold a bare date-and-time comparison, an unguarded
  table read, an absolute read in a default and a search row calling `today()` as base content,
  each shown by its register entry (a variant never publishes); the search row with fixed quotes is
  a variant on `hq-search`; `#host/p` in a case list filter is a variant on `hq-case-lists`,
  expecting the filter's HELD-NEW entry of 9.2; a base with a date filter (`dob > '2000-01-01'`) is
  `hq-case-lists`, the positive control of the `typed-literal` fold (its sections 6.2 and 6.4).
  Runs E1 to E4 run in B6's own CI (its section 11.2).
- **Part 15 (`15-stack-contracts-and-exit.md`; B14, B15).** B14 lands the two
  `complex-apps.md` texts, C13 and C14 on part 13's page, and the `list(...)` sentence of
  `content/docs/mcp/tools.mdx`. The outline is already gone when stack B opens: the plan's own pull
  request removes it. `7-rest-of-model.md` takes the list at
  the end of this part.
- **Part 01 (`01-the-bar-and-the-manifest.md`; A2): the copy row.** Its section 9.2 holds
  `expressions` at `not-yet`, "An expression here is more than Nova can read yet.", with the
  standing's own next step (`FINDING_NEXT_STEPS["not-yet"]`) and B6 as the pull request that lands
  it, and its section 2.6 lists the line. B6 adds the row to `lib/publish/hqFindingCopy.ts` with
  entry M3, and part 01's completeness test then holds it. M4, M6 and M7 use the
  `search-expressions` sentence it already has. Its Appendix A takes M1 to M7 from section 11.
- **Part 01 (A2): its section 3.4.** It reads as this part found at source
  (`lib/domain/expression/context.ts::slotContext`): all ten slots take the `record` rule set, a
  choice list's filter and every case operation slot among them, and B5 registers the text of the
  four search pairs while this part's binder claims them in B6.
- **Part 01 (A2): the word.** This part's person-facing sentences say "expression", the word of
  part 01's subject labels (`expressions`, `search-expressions`). No label changes.
- **Part 03 (`03-questions-and-text.md`; A7).** `parseFormExpression` accepts a `SlotContextRef` for
  a prose value (its section 4.7, "The scope"), which the reading scope of section 4.3 relies on.
  `lib/domain/proseExpression.ts::canonicalProseAtom` (its section 4.1) builds the part B6 writes
  for a bound output (2.5, step 2), as its section 4.8 asks of the reader. Its need of B6
  ("any walker of `expressionSlotValues` now meets prose values and reads them as field form
  logic") is met: `readExpressions` treats a prose value as a form slot with mode `xform`,
  `constraint: false`. Its two entries that exist only under a run's outcome
  (`questions/output-value-holding-text-the-form-builder-rewrites`, G1 outcome B;
  `questions/output-value-in-a-validation-message-core-cannot-compose`, G3 outcome C, second case)
  are claimed here, in the prose slot row of 9.2, by the predicate A7 exports from
  `lib/commcare/validator/rules/field.ts` for each (9.1). B6 needs A7's description to say which
  outcome each run gave, and lands the claim, its member of `EXPRESSION_CLAIMS` and its test cases
  only for a rule that landed.
- **Part 04 (`04-names.md`; A9).** A name outside one of its grammars is claimed under its section
  11.2 entry (9.2, the property name row). For the three grammars it leaves unchanged and an
  expression can name (a relation's index identifier, a worker property's slug, a level's code),
  this part states its standing in 9.2, as its "What other parts read from this one" asks
  ("Unchanged, and so findings where HQ holds more"). Its asks of B6 (the `#case/` fold
  binds to a `form-case` term and never prints one of the five formerly reserved type names as a
  namespace) hold: the fold builds the term from the form's reachable types and prints nothing.
- **Part 10 (`10-identity-and-the-ledger.md`; B8).** Nothing: B6 mints no entity. The catalog
  properties it declares are keyed by `(caseType, name)`, which is their identity
  (`lib/domain/CLAUDE.md`).

## What other parts read from this one

- **The method** (2.1, 2.3): any reader that recognizes a generated expression proposes a value, prints
  it with the production emitter, and compares trees. No reader matches expression text.
- **In B2, for B3 to B5**: `PendingExpression` (`ref`, `text`, `mode`, `place`, `key`), `ReadMode`,
  `pendingPlaceholder` (`lib/commcare/reader/pendingExpressions.ts`); `sameSyntax` (options default to
  the record comparison), `sameXPathText`, `firstDifference`, `CompareOptions`
  (`lib/commcare/reader/syntaxCompare.ts`, rows L1 to L6 in B2, S1 and S2 in B6);
  `interpolateHqXPath`, `dotInterpolate`, `syntaxOf`, `hqInterpolationSlot`, `HqInterpolationSlot`,
  `HqInterpolated`, `HQ_USERCASE_XPATH`, `hqCaseByIdXPath` and the slot table of 6.1
  (`lib/commcare/reader/hqInterpolation.ts`).
- **`readExpressions(doc, pending, env)`**, pure and run twice by the frame, with `ExpressionReadEnv`
  (`lookup`, `sourceNames`, `itextUnits`, `instanceSources`, `generatedValues`, `operationIdPaths`,
  `recordDialect`, `entryFactsRefused`), `GeneratedValue`, `RecordDialectJudge`, `ExpressionReading`
  (`doc`, `bound`, `claims`, `circumstances`, `rewrites`, `declaredProperties`, `worldReads`,
  `unreadTables`, `ownerless`, `rounds`), `ExpressionClaim` (with `source`) and
  `EXPRESSION_ROUND_LIMIT`: part 06's `bindExpressions` and `expressionEnvOf` (B6), and through the
  registry's `outcome(i)` every settle function of parts 06 and 07.
- **`EMISSION_REWRITES`, `EmissionRewrite`, `RewriteControl`, `WireBuildContext.rewrites`**
  (`lib/commcare/emissionRewrites.ts`); **`EMISSION_REWRITE_IDS`, `EmissionRewriteId`**
  (`lib/publish/emissionRewriteIds.ts`); **`REWRITE_SENTENCES`** (`lib/publish/firstPublishCopy.ts`,
  from B6 until B7 moves it into `FIRST_PUBLISH_SENTENCES`): part 09's register and its own rewrite
  sites (B7), and part 14's coverage rule (B13). The eight expression ids: `instant-comparison`,
  `empty-rows-guard`, `absent-session-value-guard`, `row-predicate-current`, `default-reads-current`,
  `search-value-guards`, `search-today-device-day`, `filter-identities-dropped`.
- **`readSearchFilterRow`, `readSearchRowConjuncts`, `matchSearchRows`** (with `from` on each matched
  row): part 07's `settleSearches` and `search/rows.ts`, which land in B6.
- **`readExpression`, `SlotJudgment`, `slotReadMode`, `sourceNodeProjection`**: a reader that needs one
  slot judged again, or the mode Nova prints a slot with.
- **`canonicalExpression`, `PRINT_COLLISIONS`**: part 09's `canon.ts` (B7), through it part 14's
  proof 6 (B13), and step 7's comparison of two readings.
- **`recordDialectRoundTrip`** (`lib/agent/authoring/recordRoundTrip.ts`) and
  `ReaderInput.recordDialect`: parts 06 (the type's member), 09 (the re-read), 12 (the worker's
  call) and 14 (the lane's reader bundle).
- **`projectCaseListFilter`**, exported from `hqJson/caseList.ts` by B6.
- **`instantTextOfMicros`** (`lib/domain/expression/instantOperand.ts`).
- **`FormParseScope.reading`, `FormReadingHooks`**: nothing outside the reader passes it.
- **The entries M1 to M7** and the edits of section 11; **the mapping of 9.2**
  (`parseIssueEntry`, `checkErrorEntry`, `formRefusalEntry`, `SLOT_ENTRIES`), which step 7 narrows as
  it widens a rule set; **`EXPRESSION_CLAIMS`**, the `defineClaims("expressions", …)` table part
  06's `claimsBindManifest.test.ts` holds (B6), and `SURFACE_USE_ENTRIES` (9.3), whose claims reach
  part 14's parity through the frame's claim log (B13).
- **The record spelling `list(…)`**, read and kept and never authored anew, with
  `QueryBindings.heldValueLists`, and `MODEL_CONTEXT_VERSION` `"v7-hq-round-trip-bring-in.b6"`, the
  value B9 moves on from (part 11): part 13's guide and billed check (B12).
- **Names and seams as they stand, each the one spelling the plan uses**: the registry and its id
  type are `EMISSION_REWRITES` and `EmissionRewriteId`; `RewriteControl`'s callback is `reached`;
  `PendingExpression` holds no `shadow`, `ExpressionReadEnv` no `hashtags`, and there is no
  `FormHashtags` type; `shadowAgrees`
  and `literalOutputText` are part 06's own (B3); `syntaxCompare.ts` and `hqInterpolation.ts` sit in
  `lib/commcare/reader/` and land in B2, `hqInterpolationSlot` with them; a registration's result is
  read through `PendingRegistry.outcome(i)`; a form whose entry facts differ raises no M1;
  `ExpressionReading.circumstances` holds `unrecognized` alone; C9 and C12 are recorded as part
  06's defects D11 and D12 and logged by part 12; a bound output is written through
  `canonicalProseAtom`; `required="true()"` claims `questions/bind-required-true`.
- **Gated runs E1 to E7**: E1 to E4 in B6's own CI, E5 in ordinary CI, E6 inside part 14's P2
  dispatch (B13), E7 answered by part 13's run E1 (B12).
- **What is not-yet after B6, by owner**, which `../7-rest-of-model.md` lists: functions in record
  slots (`case-list-and-detail`, `menus`, `case-search`, `xform`); a relation read through an index
  other than `parent` that names no case type, `#host` among them (`case-list-and-detail`, `menus`); a
  project space's day in a search (`case-search`); a search value that queries device data
  (`case-search`); a search filter the record rule set refuses (`case-search`); an editable card for a
  list of values (`case-search`); a record slot that reads a session value the dialect cannot spell
  (`forms-and-case-management`); the form rule set's wider vocabulary: comparisons Core coerces, `*`
  steps and reads of the blocks HQ's build adds (`xform`).
