# Step 3, part 02: Authoring surfaces: text grammars, the builder, the SA and MCP, the reference index and renames

Part of [step 3's plan](../3-expressions.md), which holds the baseline, the decisions, the stack and
the exit. Part 01 (`01-model.md`) holds the model: the one `Expression` union, the mapping of every
JavaRosa construct to an arm, the canonical print of each arm, the two-axis types, the slot
profiles, and what each identity does on a rename, move or removal. This part plans everything that
turns text into that union and back, and everything that answers "who reads this?": the form-XPath
parser and its two modes, the record dialect, what the model is taught, the builder's XPath editor
and card editor, the reference index and the rename cascades, and the consumers that re-parse
printed text today. Lowering, emission, Preview and Postgres compilation, typed CSQL and the cutover
are other parts; where this part depends on one, it names the fact it needs and the part that
settles it.

Stack references use the fifteen pull requests by number and name; part 10 holds the stack in full.

Citations are `path::symbol` for Nova at `main` `5cf6e327`. This part rests on no CommCare fact of
its own beyond those parts 01 and 05 cite; where it repeats one, it gives that part's citation.
Every "Executed during planning" observation ran Nova's own modules through
`npx tsx --conditions=react-server` from the repo root, in planning probes that are not part of the
repository (no network, no paid call, no Docker, no lane run), except the two read-only production
scans and the one lane run named under "Executed during planning".

## Decisions in brief

1. **One form-XPath parser, total, into the union.** `lib/commcare/xpath/expressionAst.ts`
   gains `parseFormExpression(source, scope)`, which returns either an `Expression` with a span for
   every node or a list of issues with spans. It replaces `parseXPathExpressionWithIssues`, and
   `lib/doc/expressionText.ts` keeps its role as the doc-aware bridge. Nothing it stores is text.
2. **The two modes differ in two resolvers and in how issues are delivered, nothing else.** SA and
   MCP (`parseAuthoredFormExpression`) add the `#form/` short-name resolver and the `#case/` alias,
   and throw one `AuthoringInputError` listing every issue. The builder (`parseFormExpressionForSlot`)
   resolves exact paths only and hands issues to the linter. Both resolve relative paths.
3. **Relative paths are admitted in SA and MCP.** Today an SA read of a builder-authored `../sib`
   cannot be sent back (executed: strict mode refuses `../sib` and `sib` while storing
   `current()/../sib` as text), and a field rename strands `../a` with no finding (executed). From
   step 3 every relative spelling is field identity in both modes. Every relative path production
   holds resolves to one field or the field itself, so nothing stored is newly refused.
4. **Spans replace the ordinal trick.** Parse and print each return a span per node, keyed by the
   node's path in the stored tree, the same path a checker finding carries. The linter places every
   finding on the text being edited; `buildLintContext.ts::formTimeOrderings` and
   `validator/timeOrdering.ts::orderingSpans` are removed.
5. **The record dialect compiles to the union with its positional families kept as a record rule.**
   Its spellings stay byte for byte, it gains `record-type()` and `here()` (part 01 §2.4), and from
   pull request 10, CSQL, the chosen case: `chosen-case('<menu name>')` reads the id of the case
   chosen in an earlier menu and `chosen-case-property('<menu name>', '<property>')` one of its
   properties, each resolved to module identity (§2.3). None of its spellings uses CommCare
   vocabulary (no `datum(...)`), and it has no `project-day` or list spelling (§2.3). The
   round-trip law holds per grammar and is held by two fast-check suites over the production
   parsers and printers.
6. **Canonical print is what every surface shows back.** The builder shows it, laid out over lines
   past today's width, after every save; SA and MCP reads return it on one line. The builder no
   longer normalizes text before saving (`xpath-format.ts::formatXPath` goes): the parse discards
   trivia and the print is canonical. A small share of the expressions production stores print
   differently; the cutover's notice names them per app.
7. **The builder's chips come from parse spans, not a regex.** `xpath-chips.ts` stops matching
   `lib/references/config.ts::HASHTAG_REF_PATTERN` over XPath text; prose keeps its own matcher.
8. **Draft reconciliation generalizes to every identity**, still failing closed on anything a peer
   changed beyond a spelling.
9. **The card editor changes only where a slot's profile admits a new arm or a widened operand.**
   Two value cards are added (`negate`, `here`), and a display-only card for the held `value-list`
   so every stored kind renders; part 06 adds "Depends on a condition", the case-type value picker
   (`CaseTypeValuePicker.tsx`, new; the existing `CaseTypePicker.tsx` is the module case-type
   picker and stays as it is) and its widened operands. The value source menu gains a choice of a
   question, the record's type and, from pull request 10, "The case chosen in <menu>" with that
   case's properties, offered only for a menu the slot's entry passes through (§4.5). Existing
   cards gain a calculated operand where the profile admits one. The editor's axes derive from the
   slot's profile, so the editor cannot offer what the gate refuses.
10. **The reference index gains edges, not prefixes.** Every new identity keys under an existing
    prefix (`u:`, `t:`, `c:`, `p:`, `l:`), because option, location-property and level UUIDs are
    already in the app-wide authored identity namespace and datums are owned by modules, forms and
    case types (part 05 §1.7). Lookup reads in form logic join `lib/doc/lookupReferences.ts`, never
    the index.
11. **Renames reach everything by identity.** The case-property cascade walks the union, so it
    reaches case-query reads, and the rename review counts them with no change to its grouping. A
    field move whose relative read can no longer print, or whose structural read would become many,
    is refused before the drop. An option's value edit reprints every comparison and default;
    removing an option a comparison or default names is refused while it is read. The cutover lifts
    the literals production compares with a static select to options (part 09), so this reaches
    most apps with a static select.
12. **Every consumer that re-parses printed text reads the tree.** `lib/domain/expressionSource.ts`
    keeps a printed-text accessor for blueprint search and the read-only inspector only.
13. **The stale model-facing residue goes.** `lib/agent/modelAstInput.ts`,
    `lib/agent/expressionReference.ts` and the AST half of `lib/agent/wireSchemas.ts` are deleted;
    `askQuestions` keeps byte-identical wire bytes (executed).
14. **Served schemas change once; the guide changes where each read becomes authorable.** The
    authoring projection's pre-substitution (part 01 §6.3) lands in pull request 3, the projection,
    with the one other served-schema change the model meets, the three catalog inputs
    `generateSchema` and `updateCaseProperty` lose (the catalog's `required` / `validation`
    retirement, decided with the person, 2026-10-17), so the served bytes change once and every
    later pull request shows, by the per-tool hash at its base and head, that it changed none it did
    not mean to. The guide's sentences land with the pull request that makes their read authorable:
    part 05 §4's in pull request 9, part 06 §7's in pull request 10, this part's in pull request 12,
    the authoring. Each pull request that changes a served schema, model-facing prose or what an
    authored text input accepts bumps `lib/models.ts::MODEL_CONTEXT_VERSION`: pull requests 3, 5, 9,
    10 and 12 (§3.3); the billed check is asked once, at the stack head.
15. **An untyped case query binds by the catalog.** A custom property read in a `cases` query with no
    `@case_type` literal and no `@case_id` from a known source binds to the one case type of the
    effective catalog that declares it, and that type is stored; where none or several do, the parse
    refuses (`case-query-untyped`). Attributes and the standard properties every case holds are
    readable in an untyped query. Production holds some untyped queries that read a row value, in a
    few apps; part 09's probe splits them into standard reads, reads that bind to one type, reads
    several types declare (blockers) and reads typed by `@case_id` from a known source
    (declarations). The print adds no predicate, and a re-parse of an edited slot takes that slot's
    current tree as its binding hint, so a bound read keeps its type while that type declares the
    property and the read/edit law holds (§1.3).

---

## 1. The form-XPath parser

### 1.1 Today

`lib/commcare/xpath/expressionAst.ts::parseXPathExpressionWithIssues` walks the Lezer tree for two
shapes only: `HashtagRef` (`classifyHashtag`) and a pure `/data/...` step chain (`classifyDataPath`).
Each becomes one of seven leaves (`lib/domain/xpath/ast.ts`); every other byte is a `text` run, and a
source with any Lezer error is one opaque text run. `requireBoundNames` (strict, SA and MCP) adds one
check: a `NameTest` outside an `instance()`- or `current()`-rooted path is an issue
(`hasExplicitPathContext`). `lib/doc/expressionText.ts::parseAuthoredXPath` turns issues into one
`Error` that `lib/agent/authoring/input.ts::authoringXPath` rethrows as `AuthoringInputError`; the
builder's `parseXPathForField` / `parseXPathForForm` keep unresolved text inert and leave refusal to
the gate, whose text checks are `lib/commcare/validator/xpathValidator.ts::validateXPath`.

Executed during planning (the strict-mode and rename probes under "Executed during planning"):

| Text | Strict (SA, MCP) | Builder |
|---|---|---|
| `../sib` | refused (`sib`) | stored as text |
| `sib` | refused | stored as text; admitted by the gate when any field anywhere in the form is named `sib` |
| `current()/../sib` | stored as text `current()/../sib` | same |
| `. > 0` | stored as text | same |
| `#form/sib`, `/data/g/sib` | `field-ref`, `path-ref` | same |

Three consequences the probes show:

- A field rename strands a relative read with no finding. `../a = 'yes'` in a sibling's relevant,
  then `a` renamed to `c`: the gate admits it, the expression still prints `../a = 'yes'`, and the
  full validator reports nothing for it (it reports `INVALID_REF` only for a bare `zzz` in the same
  form). The read now names nothing and is never true on a device. Today's Phase 2d
  (`xpathValidator.ts`, "Relative-reference validation") skips a `NameTest` inside a `Child` path,
  and checks a bare name only against every field id in the form (`collectKnownNames`).
- A bare sibling name is admitted though it reads nothing: `a = 'yes'` in `b`'s relevant passes the
  gate, but a bind's context node is its own node (part 01 §2.6 and §4, "Scope and context node"),
  so `a` names `b`'s child.
- An SA read of a builder-authored `../sib` prints `../sib` (`output.ts` encodes the text run
  verbatim), and sending that read back is refused. The read/edit law of
  `lib/agent/authoring/CLAUDE.md` ("Read results use the same authored content shapes accepted by
  edits") fails for every builder-authored relative read.

### 1.2 From step 3: one parser, one scope

```ts
// lib/commcare/xpath/expressionAst.ts
export interface FormParseScope {
	readonly doc: BlueprintDoc;
	/** The slot being parsed: its profile and context node come from
	 *  lib/domain/expression/profiles.ts (part 01, §4). */
	readonly slot: ExpressionSlotRef;
	/** Rows-free Project lookup definitions, or "unavailable" in a builder whose
	 *  catalog has not loaded. SA and MCP always pass the invocation's definitions. */
	readonly lookup: LookupDefinitionIndex | "unavailable";
	/** The slot's stored tree when the parse replaces it: the binding hint for
	 *  a bound untyped case query (§1.3). Absent for a new slot, an empty slot,
	 *  and the cutover's lift of stored text. */
	readonly current?: Expression;
	/** SA and MCP only. */
	readonly authoring?: {
		readonly resolveFormShortName: ResolveFieldPath;  // lib/agent/authoring/fieldNames.ts
		readonly selectedCaseType?: CaseTypeName;          // the #case/ alias
	};
}

export type FormParseResult =
	| { ok: true; expression: Expression | undefined; spans: ExpressionSpans }
	| { ok: false; issues: readonly FormParseIssue[] };

export interface FormParseIssue {
	readonly code: FormParseIssueCode;   // §1.4
	readonly message: string;            // person-to-person, §1.4
	readonly from: number;
	readonly to: number;
	readonly suggestion?: string;        // replacement text for the span, when one is certain
}

export function parseFormExpression(source: string, scope: FormParseScope): FormParseResult;
```

`ExpressionSlotRef` is the `(entity, uuid, slot id[, member key])` address the reference-slot
registry already names (`lib/domain/referenceSlots.ts`, `FIELD_REFERENCE_SLOTS`,
`FORM_REFERENCE_SLOTS`); part 01's profiles are keyed by the same slot ids, so the parser reads the
admitted arms, the scope and the context node from the profile, never from a caller's flag.

The parser lives in `lib/commcare`, so it reads two wire projections directly, keeping
`lib/domain` free of wire vocabulary:

- **Session datums.** Which `DatumRef`s the slot's entry supplies is domain knowledge:
  `lib/domain/entryDatumSupplies.ts` (new, part 05 §1.3) derives it from the session structure the
  domain already holds and passes it into `ExpressionContext`, and the builder and the checker read
  that half. The datum id each ref prints as, both ways, stays in
  `lib/commcare/formLinkProjection.ts` (part 05 §1.3), the one projection from datum id to ref,
  which reads `::entrySessionDatums` and `::entrySelectionDatumSources`; no other surface
  re-derives a datum id. "`entryDatumSupplies`" below names the pair. A form link's
  `datums[].name` resolves against the link's target entry, to a `selected-case` only
  (`FormLinkDatumName`, part 05 §1.5); its `condition` and `datums[].xpath` against the source
  entry after the form closes (part 01 §4; part 05 §1.4).
- **Itext ids.** `jr:itext('<id>')` names an id the XForm builder spells inline today
  (`lib/commcare/xform/builder.ts`, `itextKey` and the `-label`, `-hint`, `-help`, `-constraintMsg`,
  `-opt<index>-label` suffixes). From step 3 that spelling is one function pair,
  `lib/commcare/xform/itextIds.ts::itextIdFor(doc, unit)` and `::itextUnitForId(doc, formUuid, id)`,
  which the emitter, the parser and the printer all call (part 04 §7 and part 07 §3.3 use the same
  names). An option's id is positional on the wire, so `ItextUnit` holds the option's UUID and the
  print re-derives its current index.

`lib/doc/expressionText.ts` keeps the doc-aware entry points (it is on the Biome allowlist for
`lib/commcare`, `biome.json`, `noRestrictedImports`):

| Entry point | Replaces | Caller |
|---|---|---|
| `parseFormExpressionForSlot(doc, slot, text, lookup)` | `parseXPathForField`, `parseXPathForForm` | builder hooks (`lib/doc/hooks/useXPathSlots.ts`), the linter (§4.1), Connect dialogs; it reads the slot's stored tree from `doc` as `current` |
| `parseAuthoredFormExpression(scope, text)` | `parseAuthoredXPath` | `lib/agent/authoring/input.ts` decoder `xpath`; an edit of an existing entity (`editField`, `updateFormLink`, `configureConnect`, …) passes that slot's stored tree as `current`, a create passes none |
| `parseProseReference(scope, name)` | the `parseAuthoredXPath` call inside `text.ts::normalizeText` | prose and localized decoders |
| `projectFormExpression(doc, slot, expression, lookup, layout?)` | `printXPathInDoc`, `projectXPath` callers | builder display, SA and MCP reads, review copy |

`parseProseReference` exists because prose keeps its stored shape (part 01): today
`normalizeText` parses `{{name}}` as a whole XPath expression and accepts it only when it is exactly
one leaf part (`text.ts::normalizeText`, "must name one answer or record property"). From step 3 it
resolves the same four reference spellings (`#form/`, `#<type>/`, `#case/`, `#user/`) straight to a
`ProsePart` through the same resolvers, with the same message.

**Empty text means no expression.** Text that is empty or whitespace parses to `expression:
undefined`. In an optional slot that is the clear (the builder sends `null`, as
`lib/doc/CLAUDE.md`, "Clearing an optional slot uses an explicit `null`", requires); in a required
slot (`datums[].xpath`, a count-bound repeat's `repeat_count`, a query-bound repeat's `ids_query`) it
is refused with that slot's existing message. No document stores an empty expression from step 3
(part 01 decision 13). Today a form-logic slot stores `{ parts: [] }` (executed: `relevant: ""` is
stored as `{"parts":[]}` and admitted). Production holds an empty expression only in an optional
slot (a `relevant`) and none in a required slot; the cutover lifts each to absence.

### 1.3 How text becomes arms

The mapping is part 01's (§2.1 to §2.3). What the parser itself decides:

**Field paths.** Every spelling resolves to a field UUID against the form's tree, through
`lib/domain` field paths (`fieldPathResolver`, which reads `fieldOrder`):

- `#form/<path>`: exact id path from the form root; SA and MCP fall back to `resolveFormShortName`
  (exact identity, exact path, then a unique short name, `fieldNames.ts`).
- `/data/<path>`: exact path; spelling `absolute`.
- relative (`..`, `.`, `./x`, `x`, `current()/...`): walked from the slot's context node (part 01
  §4): `..` moves to the parent container or the form root, `.` stays, a name moves to the child of
  that id. Every name step a relative path can name is a question id, and
  `lib/domain/questionId.ts::QUESTION_ID_PATTERN` makes every question id letter-first, so each
  relative step is a Lezer `NameTest` the parser resolves through the grammar to a field UUID,
  never a number or a call; a step that resolves to no field is `relative-unknown` (§1.4), and the
  cutover's lift blocks on one (part 09 §11). Climbing above the form root is an issue. Spelling
  `relative`, or `current` for a `current()` start. The parser computes `climb` exactly as part 01
  §2.6 defines it: when the
  highest node the path reaches is above the lowest common ancestor of context and target and a
  repeat lies between, `climb` is that node's UUID; when no repeat lies between, the longer path
  names the same node and the parser stores no `climb` (the print then shortens it, part 01 §2.5).
- a predicate on a step (`/data/rep[2]/x`, `#form/rep[age > 5]/name`) becomes a `FieldStepFilter`
  on that step's UUID; inside it the context node is that step's node. `[1]` on a repeat step is how
  the cutover prints its lift of a structural many read used as one value (part 09; production
  holds a few, in `concat` and `selected`; notice reason `repeat-read-takes-first-row`), so that
  lift is an ordinary `FieldStepFilter` and reads back unchanged.
- `current()/../@id` and `../@index` from a direct child of a query-bound repeat become `repeat-row`
  (production holds some, in a few apps). `@ids`, `@count` and `@current_index` are refused (§1.4).
- Canonical references never hold the derived `/item` step (`lib/commcare/CLAUDE.md`, "Repeat
  modes"); `/item` in text is an unknown step.

**Case queries.** `instance('casedb')/casedb/case[p1][p2]…` becomes `cases { source: "casedb" }`
with one `where` per predicate (part 01 §2.3). The parser types the row before it builds the row
leaves, because `prop.caseType` is stored (part 01 §1.3):

1. a predicate `@case_type = '<type>'` (either side) types the row and makes `'<type>'` a
   `case-type` leaf;
2. else a predicate `@case_id = <e>` whose `e` the checker types with `caseIdOf T` types the row
   `T` (part 01 §3.1: a selected-case datum, `form-case case_id`, `case-index`, `repeat-row id`,
   `id-of`, and a field whose options come from a `cases` source, whose values are always exact case
   ids, `lib/domain/fields/selectOptionsSource.ts::caseOptionsSourceSchema`; that is how
   `instance('casedb')/casedb/case[@case_id = #form/member]/name` is typed);
3. else the row is untyped. In an untyped row `@case_id`, `@case_type`, `@status`, `@owner_id`,
   `index/<x>` and the standard properties every case holds are readable. A custom property read
   binds to the one case type of the effective catalog
   (`lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes`) that declares that property, and the
   parser stores that type on the `prop`, so a later second declaration changes nothing stored;
   where no type or several types declare it, the read is refused (`case-query-untyped`, §1.4). A
   query whose predicates read no row value (`count(instance('casedb')/casedb/case)`) stays
   admitted.

**The read-back binding hint.** A bound untyped query stores its type on each `prop` and the
printer prints no predicate, so its text reads the same before and after the bind and Core reads
what the author wrote. A later second declaration of the property would make that text ambiguous
under rule 3, so a re-parse of an edited slot takes the slot's current tree
(`FormParseScope.current`) as its binding hint: the parser collects the `(property, caseType)`
pairs of the custom-property reads that `current` holds in untyped queries, and an untyped read of
`p` in the new text binds to the hint's `T` for `p` when the hint holds exactly one `T` for `p` and
`T` still declares `p`. Otherwise, and for text with no hint (a new slot, an empty slot, the
cutover's lift), rule 3 binds it. So an SA or MCP read sent back unchanged, a builder save of
untouched text, and an edit elsewhere in the same expression each store the tree they read, and the
read/edit law of `lib/agent/authoring/CLAUDE.md` holds whatever the catalog declares later. A read
whose hinted `T` no longer declares `p` binds by rule 3 or is refused, as new text would be. The hint
reads identity only from the slot it replaces; no other slot's tree is consulted. Printing the
`[@case_type = …]` predicate instead would change what the author wrote, so it is not done.

Production's case-database queries are mostly typed by a `@case_type` literal or by a `@case_id`
from a known source (a cases-sourced select's answer, a query-bound repeat's row id, the
selected-case datum). The rest are untyped and read a row value (the case id from a Hidden Value,
`selected-at`, a nested casedb read, a relative path), almost all of them a custom property; part
09's probe splits them into standard reads, reads that bind to one type, reads several types declare
(blockers) and reads typed by `@case_id` from a known source (declarations). The cutover's dry run
counts each, and every read it refuses is a `target-gate` blocker the author resolves in the app
before the window (part 09 §11; "What the cutover's dry run counts", below).

A `cases { source: "search-results" }` row is typed by the module's searched case type, never by
these rules (part 05 §2.8): HQ's primary results are open cases of that type only, and the arm's
print always excludes the related cases HQ appends. A `@case_type` predicate naming another type is
the checker's `search-results-other-type` (`SEARCH_RESULTS_READ_INVALID`, reason `other-type`).

Inside a row predicate a bare `<prop>` is `prop { caseType: <row>, property }`, `@case_id`,
`@owner_id`, `@status` are `prop` over those standard properties, `@case_type` is `case-row-type`,
and `index/<id>` is `case-index`. `current()` inside a predicate is the slot's context node, so
`current()/../x` is a field read. `..` from a row is refused (it leaves the record). After the last
predicate, one step projects (`project { value }`); a second step is refused (part 01 §2.3).

**Lookup tables.** `instance('<tag>')` and `instance('item-list:<tag>')` resolve `<tag>` through
`scope.lookup` to a table UUID, and the path `/<tag>_list/<tag>` must repeat the same tag. Column
names (`<col>` in a predicate, the projected step) resolve to column UUIDs of that table by wire
name. Exactly one predicate followed by `[1]` and a column is `table-lookup`; any other shape is
`table-rows` with a `project` (part 01 §2.3). Both instance ids parse to the same arms; the print
follows the slot's target, the bare tag in XForm slots and `item-list:<tag>` in form-link slots
(part 05 §2.3). With `scope.lookup === "unavailable"` every lookup path is the issue
`lookup-unavailable`, which only a builder can meet. No stored form logic names a table today
(`lib/commcare/xpath/carriers.ts::xpathCarrierAllowedInstanceIds`), and production's `instance()`
calls are its case-database queries and session reads, nothing else.

**Session reads.** `instance('commcaresession')/session/data/<id>` resolves `<id>` through
`entryDatumSupplies` to a `DatumRef`; an id the entry does not supply is refused at parse
(`unknown-datum`; part 01 §1.5, part 05 §1.6), and so are `stringquery` and `fingerprintquery`,
whose `device-query` kind is held by step 4 (part 01 §1.6). An id that names a placeholder datum is
refused (`placeholder-datum`), and an id that is a multi-select datum is refused with the
`selected-cases` spelling as the suggestion (part 05 §1.6; both are stricter than step 2's rule).
Production's `session/data` reads all name the selected case's `case_id`; none names a placeholder,
a multi-select datum, a query or an unsupplied datum. `session/context/<f>` admits Core's seven
fields (part 01 §1.2). `session/user/data/<slug>` resolves a unique custom slug to
`session-user-property` (no `source`) and anything else to `session-user`, by today's rule
(`expressionText.ts::resolvableUserPropertySlug`). `#user/<slug>` resolves the same way with
`source: "worker-record"`.

**Other instances.** `locations`, `results:inline`, `search-input:results` and
`search-input:results:inline` map as part 01 §2.3. A level code in `@type = '<code>'` and the
lineage attribute `@<code>_id` resolve against `doc.organizationLevels`; `location_data/<slug>`
against the location property catalog. `instance('<multi-select datum id>')/results/value` is
`selected-cases`; used as one value it is the checker's `many-values`, because the module selects
several cases by declaration, as a repeat holds several rows (part 05 §2.5), and `count(…)` or
`join(…)` reads it. Three shapes are parse refusals:

- `instance('groups')`: `groups` and `group-field` are held by step 7, group 2 (decided with the
  person, 2026-10-17: the read means the worker's case-sharing groups, a concept Nova holds only
  from `caseSharing`; part 01 §1.6, part 05 §2.6), so the text has no arm (`groups-held`);
- `instance('results:inline')/results/case[…]` parses to `cases { source: "search-results" }`
  only when its first predicate is `not(commcare_is_related_case = true())` (part 05 §2.8);
  without it the read is `search-results-unexcluded`;
- `instance('results')`, the remote search's instance, keeps the inventory's REFUSED reading
  (`search-results-remote`, part 05 §2.8).

Where a `search-results` read is admitted (a form whose evaluating entry carries the inline query,
`SEARCH_RESULTS_NOT_SUPPLIED` elsewhere) and where an `input` read is (a no-matches form only,
`INVALID_SEARCH_REF` elsewhere) are the checker's (part 05 §2.8, part 03 §3.8): its profile
admission reads the entry's supplies (§1.2).

**Literals.** A string literal opposite a static-choice `field` read (a comparison, `selected`,
`in`, `switch`) or as that field's `default_value`, whose value is one option's value (or
space-separated values of several, for a multi-select), parses to a `choice` leaf holding the option
UUIDs (part 01 §2.3 and "Defaults"). A literal opposite `case-row-type` is a `case-type` leaf; one
opposite `location-field type` is a `location-level` leaf. The form-XPath parser never writes a
literal's `data_type`: a number is its value, printed in its shortest round-trip form (part 01
§2.5). `true()` and `false()` are `match-all` and `match-none` in every position. Production holds
many literals opposite a static select that match an option, across most apps with one, and the
cutover lifts each to `choice`; some match no option and stay text literals with no finding; record
slots hold both kinds.

**Calls.** A name in `lib/domain/expressionFunctions.ts::FUNCTION_REGISTRY` that an arm means
becomes that arm (part 01 §2.1); any other registry name becomes `call`. Arity is checked here, from
the registry, so `WRONG_ARITY` leaves the text validator and becomes the parse issue `arity`.
`normalize-space`, `is-blank`, `jr:itext`, `jr:choice-name` and `here` map as part 01 §2.1.
`jr:choice-name`'s path argument must name a select; a path to any other field is refused
(`choice-name-not-a-select`, part 03 §3.7), and a select whose choices are not inline is the
checker's. Production holds no function name outside the registry, no `jr:itext`,
`jr:choice-name` or `here()`, and no stored slot that fails to parse.

### 1.4 What the parser refuses, and what it says

One table serves both modes; the builder shows the message under the span, and SA and MCP receive
the messages joined, one per line, in an `AuthoringInputError`. Each message says what was written,
why it cannot run, and what can be written instead (`design/readme.md`, "Content fundamentals").
`{…}` is filled from the text or the document. The copy lives with the issue builder in
`lib/commcare/xpath/expressionAst.ts` and the builder's presenter reads it there; the
`lib/doc/userFacingErrors.ts` lines of the fifteen validation codes these issues replace leave with
the codes (part 03 §2.3: `XPATH_SYNTAX`, `UNKNOWN_FUNCTION`, `WRONG_ARITY`, `XPATH_UNBOUND_VARIABLE`,
the six `XPATH_UNSUPPORTED_*`, `XPATH_FUNCTION_UNAVAILABLE`, `XPATH_FUNCTION_SIGNATURE_UNAVAILABLE`,
`XPATH_INSTANCE_UNAVAILABLE`, `UNQUOTED_STRING_LITERAL`, `CONNECT_UNQUOTED_XPATH`). The "Replaces"
column names which. The codes are this table's kebab-case names, the one closed vocabulary the
linter, the `AuthoringInputError` and the cutover's lift report share, and part 03 §2.3 maps the
fifteen onto them. This table is the one owner of parse copy; the session and inline-search
sentences are part 05's (§1.6, §2.6, §2.8), carried here verbatim.

| Code | Construct | Message | Replaces |
|---|---|---|---|
| `syntax` | any Lezer error | This expression can't be read near character {n}. A bracket, a quote or an operator may be missing there. | `XPATH_SYNTAX` |
| `unknown-function` | a name outside `FUNCTION_REGISTRY`, `jr:itext`, `jr:choice-name` and `here` | CommCare has no function called {name}(). {Did you mean {match}()? / The expressions guide lists the functions you can use.} | `UNKNOWN_FUNCTION`, `XPATH_FUNCTION_UNAVAILABLE` |
| `arity` | wrong argument count | {name}() takes {count}, and this call has {n}. You can change the call to give it {count}. | `WRONG_ARITY`, `XPATH_FUNCTION_SIGNATURE_UNAVAILABLE` |
| `union` | `a \| b` | CommCare can't join two lists with \|. You can test each list on its own and combine the results with or. | `XPATH_UNSUPPORTED_UNION` |
| `filter-root` | `(x)[1]`, `f()[1]`, a path rooted at a function other than `current()` and `instance()` (`f()/x`) | CommCare can filter only a path that starts at a question, a record list or a data table. You can move the [ ] onto that path. | `XPATH_UNSUPPORTED_FILTER`, `XPATH_UNSUPPORTED_PATH` (function root) |
| `axis` | `//`, any axis but child, attribute, self and parent, a node test other than a name (`ns:*`, `@*`, `text()`) | CommCare reads paths one step at a time, so {spelled} isn't available here. You can write each step, such as ../group/question. | `XPATH_UNSUPPORTED_DESCENDANT`, `_AXIS`, `_NODE_TEST` |
| `parent-after-name` | `/data/a/../b`, `instance('x')/..` | This path goes down to {a} and back up again. You can write the path to {b} directly. | `XPATH_UNSUPPORTED_PATH` (parent step) |
| `wildcard` | a `*` step | A * step reads whatever happens to be there, so a new question or a rename could change what it means. You can name the question or property you mean. | none (a bare `*` is admitted today; part 01 §1.5) |
| `variable` | `$x` | Form expressions have no variables like ${x}. You can read the question or property that holds the value. | `XPATH_UNBOUND_VARIABLE` |
| `instance-unknown` | an instance id outside part 01 §1.5 (the sentence names no groups: step 7 holds them) | This form can't read {id}. A form can read records (casedb), the session (commcaresession), the Project's data tables by their tag, and places (locations). | `XPATH_INSTANCE_UNAVAILABLE` |
| `instance-argument` | `instance()` with a non-literal | instance() needs the name of what it reads in quotes, such as instance('casedb'). | phase 2a |
| `groups-held` | `instance('groups')` (held by step 7, group 2; part 01 §1.6, part 05 §2.6) | Reading the worker's case-sharing groups isn't available yet. You can read the places the worker is assigned to with instance('locations') instead. | `XPATH_INSTANCE_UNAVAILABLE` |
| `form-root` | `/data` alone | today's `xpathValidator.ts::FORM_ROOT_READ_MESSAGE`, unchanged | phase 2c |
| `unknown-field` | a `#form/` or `/data/` path no field has | There's no question at {path} in this form. {SA: You can write its full path, such as #form/group/question, or read the form for its questions.} | phase 2c, dangling `INVALID_REF` at parse |
| `ambiguous-field` | SA short name with several matches | {name} matches more than one question in this form. You can write its full path, such as #form/{first match}. | today's `parseAuthoredXPath` issue |
| `relative-unknown` | a relative path that reaches no field | From {context label}, {path} doesn't reach a question. {Did you mean {suggestion}? / If you meant the text {path}, you can put it in quotes.} | phase 2d, `UNQUOTED_STRING_LITERAL`, `CONNECT_UNQUOTED_XPATH` |
| `relative-above-form` | `..` past the form root | This path climbs above the form. You can start it at #form/ instead. | none |
| `relative-no-context` | any relative read in a session slot | today's `xpathValidator.ts::sessionRelativeReadMessage`, unchanged | phase 2d |
| `case-alias-unbound` | `#case/` with no selected record (SA, MCP) | today's `parseAuthoredXPath` message, unchanged | none |
| `case-query-untyped` | a custom property read in an untyped query (§1.3) that no case type, or more than one, declares; `{type}` is each declaring type in turn, joined with "or", where several declare it, and the form's own case type, else `visit`, where none does | You can add [@case_type = '{type}'] so CommCare knows which records to read. | none |
| `case-row-attribute` | `@<name>` on a row other than the four | A record's @case_id, @case_type, @owner_id and @status can be read here, and @{name} can't. If {name} is a property, you can read it without the @. | none |
| `row-step-after-value` | a step after a projected row value | {value} is a single value, so this path can't go past it. You can read the related record with its own query, such as instance('casedb')/casedb/case[@case_id = …]. | none |
| `row-leaves-record` | `..` from a record row | Inside a record query, .. leaves the record. You can write current()/.. to start from this question, or #form/ to name an answer. | none |
| `repeat-wrapper-attribute` | `@ids`, `@count`, `@current_index` | {attr} belongs to how Nova builds this repeat and can change. You can read a row's record with current()/../@id, or count the rows with count(#form/{repeat}). | none |
| `unknown-hashtag` | `#user/a/b`, an unknown namespace, `#<type>/a/b` | today's `parseAuthoredXPath` message, widened to name `#user/<property>` | none |
| `unknown-search-input` | `#search/<name>` naming no Search input of the form's module | This menu's search has no field called {name}. {The fields it asks for are {names}. / This menu has no search.} | dangling `INVALID_SEARCH_REF` at parse |
| `search-results-unexcluded` | `instance('results:inline')/results/case[…]` whose first predicate is not the related-case exclusion (part 05 §2.8) | Search results also hold cases CommCare adds to show related details. You can read the cases the search found with instance('results:inline')/results/case[not(commcare_is_related_case = true())]. | `XPATH_INSTANCE_UNAVAILABLE` |
| `search-results-remote` | `instance('results')` (part 05 §2.8) | This form opens after the worker leaves the search, so its results are gone by then. You can read the case the worker chose with #{type}/ instead. | `XPATH_INSTANCE_UNAVAILABLE` |
| `unknown-table` | a tag no table has | This Project has no data table tagged {tag}. {Builder: You can check the tag in Project data. SA: getLookupTables lists the tags.} | `XPATH_INSTANCE_UNAVAILABLE` |
| `table-path-mismatch` | `instance('t')/u_list/u` | The rows of {tag} are at instance('{tag}')/{tag}_list/{tag}. | none |
| `unknown-column` | a column no column of that table has | The {table} table has no column {col}. You can use one of its columns: {columns}. | none |
| `lookup-unavailable` | builder, catalog not loaded | Project data is still loading, so this read of {tag} can't be checked yet. You can try again in a moment. | none |
| `unknown-level` | `@type = '<code>'`, `@<code>_id` | There's no organization level with the code {code}. You can use one of this app's level codes: {codes}. / This app has no organization levels yet. You can add them in App setup, Organization. | none |
| `unknown-location-property` | `location_data/<slug>` | Places have no property {slug}. You can use one of their properties: {slugs}. / Places have no properties yet. You can add them in App setup, Organization. | none |
| `unknown-datum` | `session/data/<id>` the entry does not supply, `stringquery` and `fingerprintquery` included (part 05 §1.6) | This form doesn't open with a session value named "{id}". Its session values are {ids}. / This form doesn't open with any session values. You can read a question or a case property instead. | `SESSION_DATUM_NOT_SUPPLIED` for text |
| `placeholder-datum` | `session/data/<id>` naming a placeholder datum (part 05 §1.6) | {id} holds no case this form opens with or creates. You can read #{type}/case_id for the case this form opens. | none (admitted today) |
| `multi-select-datum-value` | `session/data/<multi-select datum id>` (part 05 §1.6) | {id} holds the cases chosen in {module} as a list. You can read them as instance('{id}')/results/value. | none (admitted today) |
| `unknown-itext` | `jr:itext('<id>')` with no unit | This form has no translated text with the id {id}. You can check the id against this form's translations. | none |
| `choice-name-not-a-select` | `jr:choice-name(x, '<path>')` whose path names a field that is not a select (part 03 §3.7) | {question} has no choices, so jr:choice-name can't find a label for it. You can show the answer itself instead. | none |

What stays a checker finding (part 01 §1.5) is not repeated here: an identity the parser resolved
but the slot's profile or the type rules refuse, a case type or property that does not exist (case
properties and types are name-backed and resolved by the checker, part 01 decision 9), `here()`
outside a list (from pull request 6; until then the form parser reads `here()` as `unknown-function`,
today's verdict, and pull request 6 parses it into the arm, part 03 §3.6), `jr:choice-name` on a dynamic select, `time-ordering`, `incompatible-values` (its
reasons `date-datetime`, `datetime-ordering`, `boolean`, and `day-only-on-device` for a casedb
system date, or a search results row's `date_opened`, against a moment on a device, part 03 §3.2),
`many-values` (a structural read only, part 03 §3.4: a repeat's answer read from outside that
repeat, and a `selected-cases` read, each used as one value; a `cases`, `table-rows` or `locations`
query used as one value is admitted), `default-not-a-choice`, `record-position` (part 01 §3.4),
`itext-reference` for `jr:itext` or `jr:choice-name` of text that holds a reference (part 03 §3.7,
part 07 §3.3), a computed `format-date` pattern or a record `number()` of a date in a profile with a
Postgres target (part 03 §3.10), `INVALID_SEARCH_REF` for a resolved `input` outside a no-matches
form, `SEARCH_RESULTS_NOT_SUPPLIED` for supply, `SEARCH_RESULTS_READ_INVALID` for
`search-results-order` and `search-results-other-type` (part 03 §3.8, part 05 §2.8),
`SESSION_DATUM_NOT_SUPPLIED` for a stored ref the entry stops supplying (part 03 §3.9), and
`LOCATIONS_READ_NEEDS_ORGANIZATION` (part 05 §2.4). The two never overlap: the parser refuses only
what has no arm or no identity.

Parse refusals that meet text which commits today, and what production holds of each:

| Refusal | Production |
|---|---|
| `case-query-untyped` | some reads, in a few apps: the untyped queries' custom-property reads that no case type or several declare. Part 09's probe finds reads several types declare, each a blocker; the dry run counts them |
| `relative-unknown` for a bare sibling name, or for a relative read a rename stranded (§1.1) | none: every stored relative path resolves to one field or the field itself |
| `placeholder-datum`, `multi-select-datum-value`, `unknown-datum` | none: every `session/data` read names the selected case's `case_id` |
| `groups-held`, `search-results-*`, `unknown-table`, `choice-name-not-a-select`, `unknown-function` | none: the `instance()` calls are case queries and session reads only, and no `jr:choice-name` or unregistered function is stored |
| `wildcard` | none in absolute `/data` paths (the non-pure ones carry predicates only); the scans classed no other path for it, so the dry run counts the rest |

Every other row of the table refuses only text that cannot commit today, because today's text
validator or strict parser already refuses it.

### 1.5 Spans

```ts
// lib/domain/expression/spans.ts
/** Node path → [from, to) in one text: the same path CheckError.path carries. */
export type ExpressionSpans = ReadonlyMap<string, { from: number; to: number }>;
export function spanKey(path: CheckPath): string;
/** The span of a node, or of its nearest ancestor that has one. */
export function spanFor(spans: ExpressionSpans, path: CheckPath): { from: number; to: number } |
undefined;
```

`parseFormExpression` records a span for every node it builds, from the Lezer node that produced it
(a leaf's span is its whole spelling, `instance('casedb')/casedb/case[…]` for a `cases` node). The
printer (`lib/domain/expression/print.ts`, part 01 §6.1) returns `{ text, spans }` from the same
walk. The checker's `CheckError.path` (`lib/domain/predicate/typeChecker.ts::CheckError`, moved by
part 01) is the key.

This generalizes step 2's ordinal trick. Today the linter parses the draft, runs
`findTimeOrderingComparisons` over the stored expression's printed text, and maps each finding back
by its ordinal among the orderings of the typed text (`buildLintContext.ts::formTimeOrderings`),
because a reference can print at another length than it was typed. From step 3 the checker runs on
the tree parsed from the draft itself, so a finding's path is a path in that parse and its span is
the draft's own span: no reprint, no ordinal, every finding kind alike. A stored expression shown
read-only places a stored finding on the printed text through the printer's spans.

### 1.6 Relative paths in SA and MCP: admitted

Decision: strict mode resolves relative paths exactly as the builder does; `hasExplicitPathContext`
is removed. Reasons: the read/edit law fails today for every builder-authored relative read (§1.1);
inside a repeat `../x` means the same row and `#form/rep/x` every row, a distinction the model needs
(part 01 §1.3, `climb`); and the guide already teaches `current()/../@id` (`reference.ts`, fields
guide). A planning scan of the corpus found 50 relative paths in 25 documents, every one resolving,
so nothing the lane writes is newly refused. Every relative path production holds resolves to one
field or the field itself: mostly `.` in a validation (the answer itself), then query-repeat row
reads in the `current()/../@id` style, `..` field reads, `current()/…` field reads, `.` inside a
form predicate, and bare names in form predicates. Production also holds a read that climbs above
the common ancestor with no repeat between, so its print shortens. The catalog's `.` reads retire
with the catalog's `required` / `validation` slots.

### 1.7 Tests

| Test | Boundary | Proves |
|---|---|---|
| `lib/commcare/xpath/__tests__/formExpressionParse.test.ts` | production parser over documents from `lib/__tests__/docHelpers.ts::buildDoc` | every row of §1.4 with its span; relative resolution from each profile's context node, `climb` present only through a repeat; case-query row typing (the two typing rules, the catalog binding with one, none and several declaring types, attributes and standard properties read untyped; the binding hint: a bound read re-parsed with `current` after a second type declares the property keeps its type, the same text with no hint is `case-query-untyped`, and a hint whose type no longer declares the property binds by rule 3); a `search-results` row typed by the searched type, with and without the related-case exclusion; lookup tag, `item-list:` and column resolution, printed per target; datum and itext ids both ways, the placeholder and multi-select refusals; the `choice` binding and its non-binding for an unknown value; `[1]` on a repeat step as a `FieldStepFilter` |
| `lib/commcare/xpath/__tests__/formExpressionRoundTrip.fuzz.test.ts` | fast-check: `blueprintDocArbitrary` plus an expression arbitrary per form-logic profile | `parse(print(e)) = e` and `print(parse(print(e))) = print(e)` (§2.4), and every node has a span in both |
| `lib/doc/__tests__/expressionText.test.ts` (new) | the doc-aware entry points | strict and builder modes differ only in the two resolvers; empty text clears; prose references resolve to the four parts with today's message; `parseFormExpressionForSlot` passes the slot's stored tree as `current`, so a builder save of untouched text holding a bound untyped read stores the same tree after a second declaration |
| `lib/agent/authoring/__tests__/input.test.ts` (extended) | `prepareAuthoringInput` through a shared tool | a read of a relative, case-query, lookup and datum read is accepted back unchanged; a bound untyped read sent back through `editField` after a second declaration stores the same tree, and the same text through `addFields` (no hint) is refused |

The text validator's own tests go with `validateXPath`, and `xpathTimeOrderingLint.test.ts` goes
with `validator/timeOrdering.ts`, both in pull request 5; what it held (an ordering on a time is
underlined where it was typed, including where a reference prints at another length) moves into
`lib/codemirror/__tests__/xpath-lint.test.ts`, rewritten in the same pull request (§4.7).
`buildSessionLintContext.test.ts` is re-pointed in pull request 5 and leaves in pull request 11 with
its module, its session cases moving into `xpath-lint.test.ts`; `xpath-format.test.ts` leaves in
pull request 11 with `xpath-format.ts`, its layout cases held by the printer's tests.

---

## 2. The record dialect

### 2.1 Today

`lib/agent/authoring/expressionSyntax.ts::parseAuthoringExpression` reads the Lezer tree into a
transient `AuthoredExpression` (literal, reference, call, binary, negative) and refuses any path,
predicate or `instance()` ("Use a named reference for …").
`lib/agent/authoring/queryExpressions.ts::compiler` maps it by position: `predicate()` builds
condition arms and refuses a value ("This slot needs a condition, such as #case/age >= 18."),
`value()` builds value arms and refuses a comparison ("This slot needs a value; put a condition
inside if()."), and `true()` is `match-all` in a condition position and the literal `true` in a value
position. `printQueryExpression.ts::queryPrinter` prints each arm; `bindings.ts::AuthoringScope`
binds names and prints a name only when it resolves back to the same identity.

### 2.2 From step 3

The compiler emits `Expression` nodes; its two positional functions stay. Positions are fixed by
the arm: condition positions are a `condition`-family slot root, `and.clauses`, `or.clauses`,
`not.clause`, `if.cond`, `when-input-present.clause`, and every `where` (`exists`, `missing`,
`count`, `table-lookup`); every other operand is a value position. Keeping them is what keeps the
round-trip law: `true()` reads back by position, and a comparison inside `concat` has no record
spelling (`concat((a = b))` is refused by `value()`). With one union, `concat(eq(a, b))` or
`if(c, match-all, …)` in a value position is representable, so the record profiles refuse a boolean
arm in a value position and a value arm in a condition position: the `record-position` rule (part 01
§3.4); the form-logic rule set has no such rule. `if` and `switch` take the position they stand in,
so in a condition position their branches are conditions (part 01 §3.4; part 06 §3.10).

Today's spellings are unchanged except where part 01 changes the stored value:

- `div` is real division. The compiler stops wrapping an integer left operand in `double`
  (`queryExpressions.ts`, `value()`, "Field expressions use real division"), and `quotient(a, b)`
  builds `arith { op: "quotient" }` (part 01 §1.4). The printer prints `quotient` for that op only;
  it no longer infers `quotient` from an integer-typed `div` (`printQueryExpression.ts`, `arith`).
  Production holds no record `div` (its record arithmetic is `+` and `mod`), so the cutover's
  `quotient` lift meets nothing and no stored record read-back changes by it.
- `-x` on a non-literal builds `negate` (part 01 §1.4) instead of `arith(*, -1, x)`. A stored
  `arith(*, -1, x)` keeps its shape and prints `(-1 * x)`, as it does today.
- `match`, `multi-select-contains` and `matches-pattern` take a value expression where they took a
  property or a literal, and `format-date` and `within-distance` take a computed pattern, distance
  and unit, each only where the slot's profile admits it (part 01 §1.4). The compiler builds
  whatever the text says; the checker's record rule set refuses what the profile does not admit,
  with today's messages. A computed `format-date` pattern and a record `number()` of a date or a
  date and time are refused in every profile with a Postgres target (part 03 §3.10).
- `in`, `switch` and the comparisons bind a literal opposite a static-choice `field` to `choice`,
  exactly as form XPath does (§1.3). `AuthoringScope` reads the field's options from the document.
- Part 06 §7's widenings ride the same compiler: `selected-any` / `selected-all` take a value
  argument, `within-distance`'s distance and unit take values, `predicate()` accepts `if` and
  `switch` whose branches are conditions (today it throws "does not produce a condition" for them),
  `date(<number>)` and `datetime(<number>)` are admitted, and `#case/closed_on` parses as any
  property, admitted only where part 06 §3.1's search-only table is read.

### 2.3 New spellings

Part 01 §2.4 gives the record spelling of three new arms, and this section adds the chosen case.
None uses CommCare vocabulary: the model and the builder never speak it (root `CLAUDE.md`, "Domain
in, CommCare wire out"), so `datum(…)` is not a spelling, and `session-user-property` keeps today's
`user('<slug>')` print through `AuthoringScope.printReference` (part 01 §2.4). Each new spelling is
a `QUERY_FUNCTIONS` entry (`lib/domain/expressionFunctions.ts`), printed by `queryPrinter` and
parsed by `compiler`; whether a slot admits it is its profile's (part 01 §4) or the typed CSQL
part's. Because each is a `QUERY_FUNCTIONS` entry, the guide's function lookup
(`reference.ts::expressionFunctionReference`, which the model reaches by asking the guide with
`functionName`) answers its arity with no second inventory.

| Arm | Spelling | Arity | Reads | Admitted in |
|---|---|---|---|---|
| `case-row-type` | `record-type()` | 0 | the type of the record in scope | every record slot that reads a case row (part 06 §3.2); `in(record-type(), 'visit', 'referral')` |
| `case-type` | `'visit'` opposite `record-type()` | literal | a record type named as a value | same |
| `here` | `here()` | 0 | the viewer's location | a calculated column (part 01 §4) |
| `session-datum { selected-case { module } }` | `chosen-case('<menu name>')` | 1 | the id of the case chosen in that menu | from pull request 10, a record slot evaluated after the datum is supplied: a CSQL runtime segment of a search, a case-list filter, a form's display condition (part 06 §3.9), where the entry passes through that menu |
| `project` of that case's property | `chosen-case-property('<menu name>', '<property>')` | 2 | one property of the case chosen in that menu | same |

**The chosen case.** `chosen-case('Households')` stores `session-datum` holding the `DatumRef`
`selected-case { module }` (part 05 §1.3). `chosen-case-property('Households', 'village')` stores
the keyed read part 06 §3.9 compiles: `cases { source: "casedb" }` with one `where`,
`@case_id = session-datum selected-case { module }`, projected by
`project { value: prop { caseType: <the menu's case type>, property: "village" } }`. The property
is name-backed like every case property (part 01 decision 9): it resolves against the menu's case
type in the effective catalog, and a property that type does not declare is the checker's
`unknown-property` with today's message. The printer prints `chosen-case-property(…)` for exactly
that shape (one `where` comparing `@case_id` with a `selected-case` datum, one projection of a
property of that menu's case type) and `chosen-case(…)` for the bare datum; no other `cases` or
`project` shape has a record spelling, so each spelling reads back to the tree it printed.

The menu argument resolves through a new `AuthoringScope` identity kind, `"module"`
(`bindings.ts::identity`, beside `table`, `column`, `operation`, `location` and `level`): the
menu's UUID, its name or its id, matching exactly one module. The print names the menu by its name
when that name resolves back to the same module (`bindings.ts::name`), else by its UUID, the
stable address the compiler also accepts, as every other identity kind does. A menu rename reprints
every read and rewrites nothing. What the compiler refuses, each in an `AuthoringInputError`, with
the copy living in `bindings.ts` and `queryExpressions.ts`:

| Code | Construct | Message |
|---|---|---|
| `unknown-menu` | a name, id or UUID no module has | This app has no menu called {name}. You can use one of its menus: {names}. |
| `ambiguous-menu` | a name several modules share | More than one menu is called {name}. You can name the one you mean by its ID: {uuids}. |
| `menu-chooses-no-case` | a module with no case type, so it never has a chosen case | {name} doesn't ask the worker to choose a case, so there's no chosen case to read. You can use a menu that does, such as {first menu with a case type}. |
| `menu-chooses-several` | a module that selects several cases at once (`entryDatumSupplies` lists its ref with `scalar: false`, part 05 §1.3) | In {name} the worker chooses several cases at once, so there's no one chosen case to read. You can use a menu where one case is chosen. |

Whether the slot runs after a case is chosen in that menu is not the compiler's: it is the
entry-supply rule, profile admission over the entry's supplies (§1.2), so the same read is refused
or admitted identically from every editor. A read of a menu whose case is not chosen before the
slot's point is the checker's `datum-not-supplied`, which projects to `SESSION_DATUM_NOT_SUPPLIED`
(part 03 §3.9) with `details.reason` `not-before`, and a case list filter or search whose entries
hold that case at different datum ids is the same code with `differs` (part 05 §1.3, "One id per
slot"); part 05 §1.6 gives the sentence for each carrier and reason. The card editor never offers such a menu (§4.5), so a person meets the
sentence only after a structural change (a menu moved, its parent selection removed), as the
module-removal and case-selection reviews already report (§5.4). Production stores no record read
of a chosen case, so the cutover lifts none. The two spellings, the `"module"` identity kind, the
four compiler refusals and the record-slot refusal land in pull request 10, CSQL (§9.3), with
part 06 §3.9's positions, emission and fold.

Not authored, and why. The arms below are held in the union (emitted, folded, compiled to Postgres
where a profile admits them, natively proven) so step 6's import keeps them, and the record
dialect has no spelling for them. They are not deferrals: HQ's own editors have the record-slot
ones as escape hatches, Nova's authoring has its own arms for what a person builds, and Nova does
not reproduce an escape hatch because HQ has one.

| Arm or read | Where it stands | Reason |
|---|---|---|
| `session-datum` of kinds `new-case`, `new-child-case`, `worker-record`, `tile-group-parents` | no record slot admits them | a record slot runs while the worker navigates, before a form's own created cases and its worker record exist, and `tile-group-parents` is a list of ids; worker information is read as `user('<slug>')` |
| `project-day` | not in step 3's union; step 6 | no API-key route reads a project space's timezone, so no surface can author it truthfully (decided with the person, 2026-10-17; part 01 §1.6) |
| `value-list` (HQ's `unwrap-list`) | held for import; step 6 reads it | a fixed list is authored as `in`; a runtime list over chosen cases or groups is HQ's escape hatch (part 06 §3.6) |
| `cases`, `table-rows` and `locations` reads inside a record value, other than the chosen case's keyed read above | held for import; step 6 reads them | the card editor's arms (relations, `exists`, `count`, `table-lookup`) cover what a person builds (part 06 §3.6) |
| `call` in a record slot | admitted for import by step 6, which owns compiling the functions an imported calculated column uses to Postgres | a calculated column has its arms (part 01 §2.1) |

This plan's own pull request writes these into `6-import.md` (part 01 §1.6), each with its reason.

### 2.4 The round-trip law, per grammar

For each grammar and each slot authored in it (part 01 §4, "Family"), under the slot's scope:

- **print then parse is identity:** `parse(print(e)) = e` for every `e` the slot's profile admits;
- **parse then print is canonical:** `print(parse(s)) = print(parse(print(parse(s))))`, so a text a
  person or a model wrote reads back as one canonical spelling and never drifts on a second save.

What makes each hold:

- **Form XPath.** Spelling choices that carry meaning are stored (`field.spelling`, `climb`,
  filters); every other choice is trivia the print normalizes (part 01 §2.5). A right operand of the
  same precedence is parenthesised unless parent and child are the same n-ary `and` or `or` (part 01
  §2.5), so `a + (b - c)`, `a * (b div c)` and `a = (b = c)` read back as the trees they are;
  production holds no expression that rule reads differently. The parser never writes `data_type`,
  so the form-logic arbitrary never draws one. A literal holding both quote marks has no form-XPath
  spelling and is never drawn. The scope includes the effective catalog, so with no hint a query
  bound by the catalog (§1.3) reads back to the same tree only while one case type declares its
  property; with the slot's current tree as its hint (§1.3) it reads back to the same tree under any
  later declaration. The fuzz draws catalogs that keep one declaring type for the hint-free law, and
  `readTotality.fuzz.test.ts` adds a second declaration after the read for the hinted law.
- **Record dialect.** Positions are typed by arm (§2.2); a typed literal prints `literal(v, 'type')`
  (`printQueryExpression.ts::literal`); names print only when they resolve back
  (`AuthoringScope.printReference`, `name()`), else the stable address the parser also accepts. The
  arbitrary draws only names the scope can resolve both ways, plus one ambiguous display name per
  run to exercise the address fallback; from pull request 10 that includes a menu name for
  `chosen-case`, drawn only in a profile that admits it, with a menu the drawn entry passes
  through.

Tests:

| Test | Boundary |
|---|---|
| `lib/commcare/xpath/__tests__/formExpressionRoundTrip.fuzz.test.ts` | §1.7 |
| `lib/agent/authoring/__tests__/queryExpressionRoundTrip.fuzz.test.ts` (new) | fast-check over `blueprintDocArbitrary` and a record-profile expression arbitrary, through `parseQueryPredicate` / `parseQueryValue` and `queryPrinter` |
| `lib/agent/authoring/__tests__/queryExpressions.test.ts` (extended) | each new spelling (`record-type()`, `here()`), that no `datum(…)`, `project-day` or `list()` spelling parses, the positional refusals with today's two messages, `div` without `double` and `quotient` as its own op, and part 06 §7's widenings read back unchanged; from pull request 10, `chosen-case('Households')` and `chosen-case-property('Households', 'village')` build the two stored shapes of §2.3 and print back, a menu written by id or UUID prints back as its name, a menu name two modules share prints as the UUID and reads back, the four compiler refusals with their sentences, and `chosen-case(…)` in a condition position refused by `record-position` |
| `lib/agent/authoring/__tests__/bindings.test.ts` (extended, pull request 10) | the `"module"` identity kind: resolution by UUID, name and id, exactly one match, and `name()` falling back to the UUID for a shared name |
| `lib/commcare/validator/__tests__/sessionData.test.ts` (extended, pull request 10) | a case-list filter, a search's CSQL runtime segment and a display condition reading the chosen case of a menu their entry passes through are admitted; the same read where the entry does not pass through it is `SESSION_DATUM_NOT_SUPPLIED` with `not-before` and part 05 §1.6's sentence for its carrier, identically through the commit gate |
| `lib/agent/authoring/__tests__/readTotality.fuzz.test.ts` (generator widened) | every read of an admitted document, sent back as the edit, stores the same tree, including after a drawn second declaration of a property a bound untyped query reads |

The arbitraries draw every arm the profile admits, including the new arms of part 01 §1.4; a new arm
without a draw fails the totality assertion the suite already has for terms
(`readTotality.fuzz.test.ts`).

---

## 3. What the model is taught

### 3.1 The authoring guide (`lib/agent/authoring/reference.ts`)

`AUTHORING_REFERENCE.expressions` changes in the places below and keeps every other sentence. Each
sentence lands with the pull request that makes its read authorable: items 1, 2 and 5, item 4's
`here()` clause, and the fields and forms lines below in pull request 12, the authoring; items 3 and
6, part 05 §4's reads, in pull request 9, instances and session; item 4's `record-type()`, its
chosen-case sentence and part 06 §7's clauses in pull request 10, CSQL. Each of the three bumps
`MODEL_CONTEXT_VERSION` (§3.3).

1. After "Names bind to stable identities; ambiguous names need an exact path or ID.", add: "Inside a
   question, ../name reads the answer in the same group or repeat row; #form/repeat/name reads it
   from every row." (The forms guide already says "In validation, . is the current answer", so this
   part adds no second sentence for it.)
2. The case-query paragraph ("A form can also query other records …") keeps its spellings (part 01
   decision 10) and gains: "Name the record type in every query that reads a property, as
   [@case_type = 'visit'] does: the type is what tells CommCare which records to read, and what lets
   a rename of that property reach the query." (An untyped read binds when one record type declares
   the property, so the sentence teaches the reliable spelling; the refusal's copy, §1.4, says the
   same.) It drops "Use an explicit #form/path inside a predicate rather than . when you mean an
   answer, since . then denotes the queried node." for "Inside a query's [ ], a bare name and . read
   the queried record; current()/.. and #form/ read the form."
3. Add one paragraph for data tables in forms: "A form can read a Project data table by its tag:
   instance('regions')/regions_list/regions[code = #form/region][1]/name reads the name of the first
   row whose code matches. getLookupTables lists each table's tag and column names. Renaming a table
   or column keeps these reads connected." (Today `content/docs/building-with-nova.mdx`, "XPath that
   will run in CommCare", says raw XPath cannot name a lookup table by its tag; from step 3 the tag
   is a projection of the table's identity.)
4. In the record-expression paragraph, `div produces a decimal. Record expressions also offer
   quotient(a,b) for integer division.` stays, and the record paragraph adds `record-type()` (part
   06 §3.2) and `here()` for calculated Results columns (part 01 §4). It adds the chosen case, in
   pull request 10: "A Search rule, a case-list filter or a form's display condition that runs after
   a case is chosen in an earlier menu can read that case: chosen-case('Households') is its ID and
   chosen-case-property('Households', 'village') one of its properties, so
   via(ancestor('parent'), #case/case_id) = chosen-case('Households') keeps the records whose parent
   is the chosen household. Name the menu as the app names it. A property of a case the worker found
   by searching is read once the case is claimed, which in a menu that opens on Search happens when
   a form is chosen, so a form's display condition there reads it blank for a case the worker didn't
   already have." (CommCare posts the claim at the entry's sync request; part 07 §3.5.) No `datum(…)`, `project-day` or
   `list()` function is taught, because none is a record spelling (§2.3). Part 06 §7's clauses join
   the record-filter and Search paragraphs here, one each: Date closed in Search rules, `if(…)`
   between conditions, a value as a distance or a selected value, and that today is the worker's
   day.
5. The operation paragraph's "unclassified XPath text is reported rather than treated as proof of no
   record reads" becomes "reads of queried records are reported as reads of any record of that type"
   (§3.4).
6. Part 05 §4's form-logic paragraphs, each one or two sentences: places ("join(', ',
   instance('locations')/locations/location[@type = 'district']/name) lists the districts in the
   worker's area; a form can read places when the app has organization levels"); the several-case
   form ("count(instance('selected_cases')/results/value) counts the records chosen together"); and
   the search-first menu ("a form opened from a search can count what it found with
   count(instance('results:inline')/results/case[not(commcare_is_related_case = true())])").

The guide names tools as it does today, by the SA's tool names (`getAutomations`), so item 3 writes
`getLookupTables`, not the MCP name `get_lookup_tables`; part 05 §4 follows the same rule.

`AUTHORING_REFERENCE.fields` (repeat): "put a hidden row_id directly inside the repeat with calculate
current()/../@id" stays; its "The @id belongs to the repeat row, so an intervening group changes the
relative path." stays true and is now printed for the author when a group is added (the print
re-derives the path).

`AUTHORING_REFERENCE.forms` gains one sentence after the select-default line: "A select's starting
value is one of its choices, written as its value in quotes, such as 'yes'; changing a choice's value
keeps it selected, and a choice that is a starting value can't be removed until another is chosen."

### 3.2 `lib/agent/authoring/CLAUDE.md`

Rewritten paragraphs, each to say what the code is from step 3. They describe code that reads the
stored shape, so they ride pull request 5, the shape, with that code:

- `queryExpressions.ts` paragraph: "produce canonical `Expression` nodes"; drop "promoted through the
  existing `double` node"; "`quotient()` builds integer division".
- `operationSemantics.ts` sentence "reports unclassified XPath text" becomes "reports reads of
  queried records by record type".
- "Unbound bare names reject rather than becoming opaque text that renames cannot maintain."
  becomes "Every name binds to an identity before preparation; relative paths bind from the slot's
  context node."
- "Conditions use Nova's existing XPath grammar. Instance and current()-rooted paths retain their
  existing XPath semantics." becomes a statement of the two grammars and the round-trip law (§2.4).

### 3.3 `MODEL_CONTEXT_VERSION`

`lib/models.ts::MODEL_CONTEXT_VERSION` (today `v3-hq-round-trip-emission.14`) moves in each pull
request that changes a served tool schema the SA is offered, model-facing prose (`reference.ts`, a
prompt, a tool description) or what an authored text input accepts (`lib/agent/CLAUDE.md`, "Provider
contract"; part 06 §7 follows the same rule). A served-schema change is found by the per-tool hash at
the pull request's base and head (§3.6), never by a snapshot. That is five pull requests of the stack
(part 10's model-addition checklist, item 13, holds the values):

| Pull request | Why it moves | Value |
|---|---|---|
| 3, the projection (§3.6) | the one-time renumbering of `__schemaN` definitions (part 01 §6.3), and the three catalog inputs (`required`, `validation`, `validation_msg`) that `generateSchema` and `updateCaseProperty` lose (decided with the person, 2026-10-17) | `"v4-hq-round-trip-expressions"` |
| 5, the shape | what an authored text input accepts: the form-XPath parser refuses text today's decoder keeps as text (`case-query-untyped`, `unknown-datum`, `instance('groups')`, a wildcard step) and admits relative paths, the kind of narrowing step 2 bumped for | `"v4-hq-round-trip-expressions.5"` |
| 9, instances and session | `reference.ts`: §3.1 items 3 and 6 (part 05 §4's form-logic reads: data tables, places, several-case and search-first sentences) | `"v4-hq-round-trip-expressions.9"` |
| 10, CSQL | `reference.ts`: §3.1 item 4's `record-type()`, its chosen-case sentence and part 06 §7's clauses; what an authored record text accepts (`chosen-case`, `chosen-case-property`, §2.3) | `"v4-hq-round-trip-expressions.10"` |
| 12, the authoring | `reference.ts`: §3.1 items 1, 2 and 5, `here()`, the fields and forms lines, and the prompts | `"v4-hq-round-trip-expressions.12"`, the value the stack deploys |

Any other pull request whose hash run shows a moved tool, or that changes model-facing prose, bumps
too; none is planned to. The three catalog inputs ride the projection pull request so that every
served-schema change the model meets lands in one pull request (part 01 decision 12: "The served tool
schemas change once"), and pull request 5, the shape, shows no hash moved. The stored fields, their
two rules and their rename branches leave in pull request 5 (§5.3; part 03 §2.1); between the two, a
stored value is still validated and simply cannot be authored by the SA or MCP.

### 3.4 `operationSemantics.ts`

Today `operationSemantics` reports `unresolvedReads { reason: "xpath-text-not-inventoried" }` for
every hidden calculate or default holding any non-blank text run
(`lib/agent/authoring/operationSemantics.ts`, the `expression.parts.some(…)` test), which an
expression as plain as `#form/a + 1` triggers. From step 3:

- The form-answer walk reads the tree through the one leaf walker (part 01, `walk.ts`): `field`
  leaves recurse as today, `form-case` reads stay `selectedOrAncestor`, and a `prop` inside a `cases`
  query is a read of `{ kind: "runtime-record" }` of the query's row type (any record of that type).
- `"xpath-text-not-inventoried"` is removed from the reason union; the three other reasons stay.
- `throughFieldUuids` follows hidden values exactly as today.

This change reads the stored shape, so it rides pull request 5, the shape, not the guide's pull
request 12. The output shape changes only by the removed reason, which is a tool result field, so it
does not move `MODEL_CONTEXT_VERSION` by itself (`lib/agent/CLAUDE.md`, "Provider contract": a field
of a read tool's result is no input). `lib/agent/authoring/__tests__/operationSemantics.test.ts`
gains a case-query read and loses the text case.

### 3.5 The stale residue: delete

| Module | Today | From step 3 |
|---|---|---|
| `lib/agent/modelAstInput.ts` | normalizes a "direct-Term shorthand" in model JSON ASTs; only `wireSchemas.ts::wireToolSchema`'s validator calls it | deleted: no client sends an AST |
| `lib/agent/expressionReference.ts` | renders the AST grammar for a system prompt; only `lib/agent/__tests__/lookupAuthorBoundary.test.ts` imports `buildExpressionReference` | deleted with that test case |
| `lib/agent/wireSchemas.ts` | the cycle-free AST projection (`compactAstNode`, `AST_PROJECTIONS`, `addDirectTermShorthand`, `breakDefinitionCycles`, `pruneUnreferencedDefinitions`); production uses `wireToolSchema` for `askQuestions` alone (`solutionsArchitect.ts::wire`), and `scripts/test-schema.ts` for its one non-shared entry, `uploadMediaAsset` | reduced to `providerToolSchema(schema)`: `jsonSchema(z.toJSONSchema(schema, { target: "draft-7", io: "input" }), { validate: safeParse })`. Executed: for both `askQuestions` and `uploadMediaAsset` today's `wireToolSchema` output equals that plain projection byte for byte (595 and 1006 bytes), so neither served schema changes |
| `lib/domain/predicate/CLAUDE.md`, "Named tool-schema definitions" | says the ids keep the term structure off the SA wire; the authoring projection already replaces those positions with strings | goes with the package; `lib/domain/expression/CLAUDE.md` (part 01 §6.1) states what the registry ids do from step 3 |

Tests that check the deleted projection go too, because production serves another schema:
`lib/agent/__tests__/wireSchemas.test.ts`, the `wireToolSchema` Ajv cases in
`lib/agent/tools/__tests__/configureConnect.test.ts`, `renameCaseProperties.test.ts`,
`setFormSections.test.ts`, `lib/agent/tools/form-links/__tests__/formLinkTools.test.ts`,
`lib/agent/tools/case-operations/__tests__/caseOperationTools.test.ts`, and the byte-reduction and
grammar cases of `lookupAuthorBoundary.test.ts`. What they meant to hold, that a served schema
compiles, `lib/mcp/__tests__/servedSchemas.test.ts` already holds over the schemas clients receive.
`lib/agent/strictStructuredOutput.ts`'s comment that names `wireSchemas.ts` is updated.

### 3.6 The served schemas

Part 01 §6.3 decides that `lib/agent/authoring/schema.ts::authoringJsonSchema` substitutes each
family position before Zod walks the schema. This part places it: **that change is pull request 3,
the projection, below pull request 5, the shape**, so it renumbers the `__schemaN` definitions once
against today's model, and pull request 5, which changes the canonical model, can show it changed no
served byte.

What each pull request runs (free), and records in its description:

- `scripts/inspect-tool-schema-hashes.ts` (new in pull request 3; part 10), at its base and head,
  printing the SHA-256 of every shared tool's
  `authoringToolSchema(name, schema).inputSchema.jsonSchema` and the set's hash, the 83 tools that
  carry no family included (`schemaFamilies.ts` skips those, so it cannot show that a change moved
  no other tool). Executed during planning with the same computation at `main` `5cf6e327`: 103
  shared tools, set hash `331dbe9a23e7`, identical on two runs, so the projection is deterministic
  and a base-and-head comparison is meaningful. This per-tool hash at base and head is how a
  served-schema change is found; no snapshot is committed, because
  `lib/mcp/__tests__/servedSchemas.test.ts` holds none (it compiles every served schema with Ajv and
  every pattern with the Rust engine, nothing else) and `lib/doc/CLAUDE.md` says schema inventories
  and their snapshots are not behavior evidence. Pull request 3 lists the tools whose hash moved;
  every later pull request of the stack shows no hash moved except where it changes a tool on
  purpose, and then bumps `MODEL_CONTEXT_VERSION` (§3.3).
- `lib/mcp/__tests__/servedSchemas.test.ts`, in CI as today: every served schema compiles in its
  dialect and every pattern in the Rust engine.

The families map (`schema.ts::families`) keys `formLogicSchema`, `conditionSchema` and `valueSchema`
(part 01 §6.2), and gains one family, `datum`, on `datumRefSchema`, in pull request 5 with session
datum identity. Its authored schema is exactly what `lib/agent/tools/form-links/shared.ts`'s
`datumInputSchema.name` serves today (`z.string().min(1).describe("The session value the target
reads, usually its case id datum such as case_id.")`), and `datumInputSchema.name` becomes that
canonical position, so `addFormLinks` and `updateFormLink` serve the same bytes and their hashes do
not move. Its decoder resolves the string against the link's `target` entry
(the target entry's supplies and their printed ids, §1.2) to a `FormLinkDatumName`, a
`selected-case` of the
target entry only (part 05 §1.5), refusing a string no selection datum of the target carries with
part 05 §1.5's sentence: "`<name>` isn't a case the destination asks for. It asks for <list of
printed ids>." Its encoder prints the target entry's current derived id. The model writes datum ids
as it does today; the document holds identity. Production's form links carry no manual datum, so no
stored name meets the narrowing.

### 3.7 The billed check

`npm run test:schema` bills one live request per schema (root `CLAUDE.md`). Nothing in this part runs
it. `scripts/test-schema.ts` registers 16 of the 20 tools that carry expression families; the four it
lacks, `setFieldOptionsSource`, `updateCaseProperty`, `addCaseOperations` and `updateCaseOperation`,
are registered by pull request 3, the projection, if their hash moves there (the root rule: the pull
request that first changes a tool's projected schema registers it), else by the first pull request
that moves it. `updateCaseProperty` moves there by the catalog inputs' removal whatever the
renumbering does, so it is registered there. The question is asked once, at the stack head after the
last tool change, naming exactly the registered tools whose hash moved across the whole stack, run as
`npm run test:schema -- <name>` per tool, as step 2 did (step 2 plan, part 11, "The model-addition
checklist", item 14).

### 3.8 `../nova-plugin`

Swept at `14af38e` (v2.2.0): no skill teaches expression syntax; `skills/build/SKILL.md` and
`skills/edit/SKILL.md` describe `operationSemantics` as "record targets, condition/value dependencies
and possible read/write overlaps", which stays true; `README.md`, "Authoring guidance", says "Nova
resolves references and preserves stable identities when content is renamed", which is false today
for the text runs of §1.1 and true from step 3. Swept at the same commit for the claims parts 05 §4
and 06 §7 name ("raw XPath cannot read a table", "miles or kilometers", "Search compares a case
property"): none appears; `skills/upload_to_hq/SKILL.md`'s "the lookup tables it reads" stays true,
since form-logic reads join the same extractors (§5.5). Nothing in the plugin changes and
`plugin.json` does not move. The sweep is repeated once, in pull request 12, the stack's last change
to the guide and the tools, against the guide text the stack ships (part 10, "The nova-plugin
check"); pull requests 9 and 10 change the guide but run no sweep of their own, since 12's covers
every sentence they add.

---

## 4. The builder

### 4.1 The form-logic editor

Hosts, unchanged in layout: `components/builder/XPathField.tsx` and its mounts
(`editor/fields/XPathEditor.tsx`, `HiddenValueEditor.tsx`, `RequiredEditor.tsx`,
`PreloadedValueRow.tsx`, `form-links/LinkConditionEditor.tsx`, `form-links/CarryValuesSection.tsx`,
`detail/formSettings/LabeledXPathField.tsx`, `RecordNameSection.tsx`, the Connect dialogs).

Where each step lands: step 2 of the list below (parse issues at their spans and the slot checker
in place of `validateXPath`) lands in pull request 5, the shape, because `validator/xpathValidator.ts`
and `validator/timeOrdering.ts`, which the linter calls today, leave there and every pull request is
green at its own head; the show-back layout, chips, autocomplete, reconciliation and the editor
context's new shape are pull request 11's.

From step 3, for one slot:

1. **Show.** `useExpressionProjection(slot)` (replaces
   `lib/doc/hooks/useXPathSlots.ts::useXPathProjection`)
   prints the stored tree with layout: one line when it fits the width today's
   `xpath-format.ts::prettyPrintXPath` uses (`PRETTY_PRINT_THRESHOLD`, 60), else argument lists broken
   over lines, as that function does. The layout is the printer's (`print.ts`, a `layout` option), so
   one printer exists; the layout only adds whitespace, which the parser discards.
2. **Edit.** The draft is text. On each change the linter parses it with
   `parseFormExpressionForSlot`; parse issues are diagnostics at their spans; with no issue, the
   slot's checker (`checkFormLogicSlot(doc, slot, expression)`, below, the deep validator's per-slot
   rules, part 01 §3.5) runs on the parsed tree and its findings are placed by `spanFor`.
3. **Save.** The save gate is the same two steps, then the field patch through
   `createBlueprintMutations` and the commit gate, as today. A whole-document finding the slot checker
   cannot see (a calculate cycle) arrives as the commit gate's refusal, shown as today
   (`XPathField.tsx`, "The commit gate refused the edit").
4. **Show back.** The editor closes onto the canonical print of what was stored. What the person sees
   change: spacing (`#form/age>=18` becomes `#form/age >= 18`), parentheses that change nothing,
   `"x"` that needs no double quotes, `1.0` becoming `1`, a longer relative path shortened when it
   names the same node, and `is-selected` becoming `selected` (part 01 §2.5). The spelling a
   person chose (`#form/`, `/data/`, `../`, `current()/`) stays. The canonical spacing, one space
   after every comma and one either side of every binary operator, is Vellum's own normal form, so
   an HQ form-builder save of an emitted form leaves the canonical text as it is (executed during
   planning, GitHub Actions run 39061476968; part 01 §2.5 states the rule). The expressions
   production stores that print differently do so by redundant parentheses most often, then
   double-quoted literals that need none, spacing alone and number spellings, and one relative path
   re-derived; none by `is-selected` or `concat()`. They sit in calculate, validation, relevant,
   default and Connect slots.

`xpath-format.ts::formatXPath`, which the save path runs today (`XPathField.tsx`, `onSave`), is
deleted; `prettyPrintXPath` is deleted with it, its layout moving to the printer. Their one other
importer, the dev-only playground `app/(dev-only)/xpath-test/page.tsx`, keeps its syntax
highlighting and samples and loses its Format and Pretty print buttons, which ran those two
functions over text with no document, and `README.md`'s `/xpath-test` line becomes "CodeMirror-backed
XPath playground for testing syntax highlighting." All of it lands in pull request 11.

**The slot checker.** `lib/commcare/validator/formLogicFindings.ts::checkFormLogicSlot(doc, slot,
expression)` is the per-slot body that part 03 §1.5's `formLogicFindings` runs for each stored
form-logic slot, exported for the linter: it runs the checker on the expression under the slot's
profile and context and returns each finding projected as `formLogicFindings` projects it, with the
checker's `path` kept (`{ path: CheckPath; code: ValidationErrorCode; message: string }[]`), so the
linter places it by `spanFor` and the inline lint, the save gate and the commit gate read one rule
set. It lands with `formLogicFindings` in pull request 5. `lib/codemirror` already imports the
validator today (`xpath-lint.ts` imports `validator/xpathValidator.ts`), so no `biome.json` line
changes.

**The editor context in pull request 5.** The linter's re-point needs the slot and the document,
and today's `XPathLintContext` is built per form: `editor/fields/useFormLintContext.ts` (for
`XPathEditor.tsx`, `HiddenValueEditor.tsx`, `RequiredEditor.tsx`) and
`detail/formSettings/useFormLintContext.ts` (for `RecordNameSection.tsx`, `DeliverConfig.tsx`,
`LearnConfig.tsx`, `appSettings/ConnectEnableDialog.tsx`) call `buildLintContext(state, formUuid)`,
and `form-links/LinkConditionEditor.tsx` and `CarryValuesSection.tsx` call
`buildSessionLintContext(state, formUuid)`. One more caller has no slot at all:
`components/builder/BuilderReferenceProvider.tsx` calls `buildLintContext(state, formUuid)` for any
form by UUID to feed `lib/references/provider.ts::ReferenceProvider` (prose chips and the
sidebar's reference labels), and `components/builder/referenceContextChanged.ts` mirrors exactly
the document slices that walk reads, so the provider's cache clears only when they change. So pull
request 5 splits the builder in two:

- `lib/codemirror/formReferenceContext.ts` (new) holds the per-form half, unchanged in what it
  reads: `buildFormReferenceContext(state, formUuid, scope = "form"): FormReferenceContext |
  undefined`, with `FormReferenceContext` the fields `ReferenceProvider` and the field
  autocomplete read (`formUuid`, `validPaths`, `reachableCaseTypes`, `formEntries`,
  `userProperties`, `formType`, `scope`), today's walk moved from `buildLintContext`, and
  `formReachableCaseTypes` moved with it; under `"session"` it returns empty `validPaths` and
  `formEntries`, as `buildSessionLintContext` does today. `ReferenceProvider`'s
  `getContextForForm` returns a `FormReferenceContext`, `BuilderReferenceProvider.tsx` calls
  `buildFormReferenceContext(state, formUuid)`, and `referenceContextChanged.ts` keeps its reads,
  its comment naming `buildFormReferenceContext`. `XPathField.tsx`'s per-editor chip provider keeps
  passing its lint context, which is a `FormReferenceContext`.
- `XPathLintContext` is `FormReferenceContext` plus `check: (text: string) => readonly { from:
  number; to: number; message: string }[]`, and loses `timeOrderings`.
  `buildLintContext(state, formUuid, slot, lookup)` and
  `buildSessionLintContext(state, formUuid, slot, lookup)` spread `buildFormReferenceContext` and
  build `check` over one snapshot: it parses the text with `parseFormExpressionForSlot` (the
  builder's Project lookup definitions, or `"unavailable"` before they load) and, when the text
  parses, runs `checkFormLogicSlot` on the tree and places each finding by `spanFor`. Both
  `useFormLintContext` hooks take the slot address (`useFormLintContext(fieldUuid, slot)`,
  `useFormLintContext(formUuid, slot)`), and each mount above passes its own.

`xpathDiagnostics` returns `check(text)` and calls no validator, so the inline lint and
`XPathField`'s save gate still read one function. `caseTypePropsForValidation` leaves (its one
caller was the `validateXPath` call; `caseRefAcceptMap`'s narrowing is held by
`lib/domain/__tests__/caseTypes.test.ts`), and the `SESSION_FORM_READ_MESSAGE` re-export moves to
`lib/commcare/validator/formLogicFindings.ts` with the constant (part 03 §8).

**The editor context in pull request 11.** `XPathLintContext` becomes
`ExpressionEditorContext { slot, scope: FormParseScope, reference: FormReferenceContext, check }`,
built by `buildExpressionEditorContext(state, slot, lookup)`, which replaces `buildLintContext` and
`buildSessionLintContext` (the session scope is the slot's profile, not a flag; `reference` is
`buildFormReferenceContext` of the slot's form under that scope), and autocomplete reads the same
`FormParseScope` (§4.2). `XPathField.tsx`'s chip provider reads `reference`. The per-form builder
outlives the two lint builders: `formReferenceContext.ts`, `BuilderReferenceProvider.tsx`,
`referenceContextChanged.ts` and `ReferenceProvider` stay as pull request 5 left them, because
prose chips read the same four reference spellings from step 3 as today (§1.2,
`parseProseReference`). `xpath-lint.ts::xpathDiagnostics` keeps its name.
`lib/codemirror/CLAUDE.md`'s "No offer-then-reject" and "Session scope" rules hold unchanged,
because autocomplete, lint and the gate read one scope and one profile.

### 4.2 Autocomplete

`lib/codemirror/xpath-autocomplete.ts` keeps its Lezer-node detection and gains sources, each built
from the same `FormParseScope` the parser resolves against; what each offers and its labels are
part 05 §4's, integrated here. The rows for reads that exist from pull request 5 land in pull
request 11, the builder; the rows for part 05's reads (data tables, places, session datums,
`selected-cases`, `results:inline`, `search-input:results:inline`) land in pull request 9, instances
and session, with the reads themselves (§9):

| Where the cursor is | Offered |
|---|---|
| `instance('` | `casedb`, `commcaresession`, each data table's tag (with its name as detail), `locations` only when the app has organization levels, a several-case module's selection datum id only in its batch form, `results:inline` only in a form whose entry carries the inline query, and `search-input:results:inline` only in a no-matches form; never `groups` (held by step 7, group 2) or `results` |
| a `[` after `instance('casedb')/casedb/case` | `@case_type = '` and, after a typed predicate, that type's properties (the effective catalog, `effectiveCaseTypes`) |
| `@case_type = '` | the readable case types |
| a `[` after `instance('casedb')/casedb/case` inside a row predicate | that row's properties and `index/<identifier>` relations |
| after `instance('results:inline')/results/case` | the related-case exclusion `[not(commcare_is_related_case = true())]` first, then the module's searched type's properties and the row attributes |
| inside `instance('locations')/locations/location[` | `@type = '` with level codes, `@<code>_id`, the row fields and `location_data/<slug>` |
| `instance('commcaresession')/session/data/` | each datum id `entryDatumSupplies` lists for the entry, placeholders excluded, labelled by meaning (part 05 §4: "The case chosen in Households", "This form's new household case") |
| `…/session/context/` | the four fields record editors offer today (`username`, `userid`, `deviceid`, `appversion`); the other three parse but are not offered until step 4 admits them per platform (part 01 §1.2) |
| `…/session/user/data/` | the worker properties |
| `instance('<tag>')/` | `<tag>_list/<tag>`, then that table's columns |
| `../` and `./` | the fields reachable from the context node, as relative steps |
| inside quotes opposite a static select, or in that select's default | its option values, each with its label |

`jr:itext` and `jr:choice-name` parse and are not offered: they are wire spellings a person reaches
only through an import.

Record slots have no text editor in the builder, so their completion is the card editor's value
source menu (§4.5), where the chosen case appears as "The case chosen in {menu}" from pull request
10; the model's is the guide's function lookup, which answers `chosen-case` and
`chosen-case-property` from `QUERY_FUNCTIONS` (§2.3). In form XPath the same case is already a
session datum read, offered above with the same label.

### 4.3 Chips

`lib/codemirror/xpath-chips.ts` stops using `MatchDecorator` over `HASHTAG_REF_PATTERN`. It parses the
editor text with the editor's scope and decorates the spans of identity leaves whose spelling is a
machine name of something the person knows by another name: field reads in every spelling (the
question's label), worker properties, Search answers, a data table's instance path (the table's name)
and its columns, a session datum read (its meaning, as in §4.2), a search-results read ("What the
search found", part 05 §2.8), and a `choice` (the option's label). Every chip, part 05's reads'
included, lands in pull request 11, the builder, since chips come from parse spans there; pull
request 9 carries only those reads' completion sources. Case-property and case-type reads stay as
text: their names are what a person reads. A draft that does not parse has no chips, as a draft
with a Lezer error has none today (`xpath-hashtag-spans.ts::cleanXPathHashtagSpans` returns `null`).
The regex and its divergence test (`lib/commcare/xpath/__tests__/hashtagMatchers.divergence.test.ts`)
stay for prose, their other user (`lib/references/renderLabel.ts`).

### 4.4 Draft reconciliation

`components/builder/xpathDraftReconciliation.ts::reconcileXPathDraft` applies one automatic change
today: one exact `#user/<slug>` token renamed, proven by UUID. From step 3 it applies every spelling
change a peer's rename makes, under one rule:

1. the stored tree is unchanged (`base` and `incoming` are prints of the same `Expression` under the
   old and the new document); otherwise the draft keeps its text and shows today's conflict;
2. the draft parses under the old document's scope; otherwise conflict;
3. each leaf of the draft's parse whose identity prints differently in the new document is replaced
   at its span by the new spelling; a leaf whose identity the new document lacks is a conflict.

This covers field renames and moves (every spelling, relative included), worker-property slug,
Search-answer, data-table and column renames, an option's value edit, and a datum id that changes with
the menu's shape. `components/builder/__tests__/xpathDraftReconciliation.test.ts` holds it as a pure
function over pairs of documents.

### 4.5 The card editor

The card editor (`components/builder/shared/`) reads and writes the stored tree, so it needs no
parser. It changes where a slot's profile admits a new arm or a widened operand, and nowhere else.
The rows part 06 adds (the case-type value picker, "Depends on a condition" and the widened CSQL
cards) and this part's chosen-case value source land in pull request 10, CSQL. The cards for the
kinds a stored tree can hold from pull request 5
(`NegateCard`, `HereCard`, the display-only `ValueListCard`) land there, since "every kind in both
discriminator unions has a card" must hold at that head; the menus that offer them and the rest land
in pull request 11, the builder (§9). What the person sees:

| Card or menu | Change | Shown where the profile admits it |
|---|---|---|
| `termEditorModel.ts`, the value source menu | **A choice of this question**, when the subject is a form answer from a static select: the value picker lists its options by label and stores `choice` | every record slot that admits form answers (`formFields` axis) |
| same | **Case type** (`case-row-type`) as a subject in the property picker, with `components/builder/shared/CaseTypeValuePicker.tsx` (new, part 06 §3.2; `case-type`) as its value picker, offering the relation's possible destination types first. The existing `shared/CaseTypePicker.tsx`, the module case-type picker with create-new that module settings, the add-module popover and the case-operation surfaces use, is not touched | every record slot that reads a case row |
| same | **The case chosen in {menu}**, one source per menu whose case the slot's entry has chosen one at a time before the slot runs (the scalar refs of `ExpressionContext.supplies` at the slot's point, §1.2; part 05 §1.3, "Evaluation points"; a menu its `differs` lists is not offered), labelled by the menu's current name: its value picker lists "The case itself" (stores `chosen-case`'s `session-datum`, for comparing with a relation's case or a case id) and then that menu's case-type properties by label (each stores `chosen-case-property`'s keyed read, §2.3). `termEditorModel.ts` gains the mode, `termModeLabel` returns "The case chosen in {menu}", and the term card shows a stored read as "{property label} of the case chosen in {menu}" or "The case chosen in {menu}". A menu the entry does not pass through, a menu with no case type and a several-case menu are never listed, so the offer set is the gate's accept set | from pull request 10, a CSQL runtime segment of a search, a case-list filter and a form's display condition, where the profile admits it (part 06 §3.9) |
| same | **Session information** lists Core's seven fields read-only and offers today's four (part 01 §1.2) | where `session-context` is admitted today |
| `cards/expression/`, new `NegateCard.tsx` | "Negative of" a value | every value position that admits `arith` |
| `cards/expression/`, new `HereCard.tsx` | "Where you are now" | a calculated column (part 01 §4) |
| `cards/expression/`, new `ValueListCard.tsx` | display only: "Any of these values" with its items, offered by no verb menu, so a `value-list` that reaches a document (step 6's import) renders and re-emits without loss (part 06 §3.6 holds the arm for import) | none: never offered |
| `cards/ConditionChoiceCard.tsx` (part 06 §3.10) | the verb "Depends on a condition": "When [condition], use [clause], otherwise use [clause]", registered in `shared/editorSchemas.ts` | the CSQL query positions part 06 decision 12 names |
| `cards/expression/DateCoerceCard.tsx` (part 06 §3.5) | admits a number operand, with the hint "A number counts days from 1 January 1970." | where the profile admits it |
| `cards/MatchCard.tsx` | the subject becomes `ExpressionPicker` | on-device slots only (CSQL's `starts-with` needs a property, part 01 §1.4) |
| `cards/MultiSelectContainsCard.tsx` | the subject may be calculated, and "Add a value from" (an `ExpressionPicker`) adds a value, offering only single-choice values in a device-evaluated slot (part 06 §3.7) | where the profile admits it |
| `cards/MatchesPatternCard.tsx`, `cards/expression/FormatDateCard.tsx` | **Calculated** pattern | where the profile admits it; for `format-date`, no profile with a Postgres target admits it (part 03 §3.10) |
| `cards/WithinDistanceCard.tsx` | the unit menu lists HQ's nine units ("miles", "yards", "feet", "inches", "kilometers", "meters", "centimeters", "millimeters", "nautical miles"); distance and unit each offer "Use a value" (part 06 §3.8) | wherever `within-distance` is |
| `cards/InCard.tsx`, `cards/expression/SwitchCard.tsx`, `ComparisonCard.tsx` | a value opposite a static-select answer is picked from its options and stored as `choice` | every record slot that admits form answers |
| `cards/LogicalGroupCard.tsx`, `IfCard`, `ExistsCard`, `TableLookupCard` | none visible: their clause slots hold `Expression` typed `boolean` | none |

Every new kind has a card, so a stored tree an SA authored renders and re-emits without loss
(`components/builder/CLAUDE.md`, "Every kind in both discriminator unions has a card"); the held
`value-list` keeps that invariant through its display-only card, though no step-3 surface offers
it. The chosen case renders through the term card above: a bare `session-datum` and the one keyed
`cases`/`project` shape of §2.3 are the only datum and query shapes a record slot admits in step 3.
A form-logic arm that no record profile admits (`call`, `itext`, a `cases` or `project` of any
other shape, …) never reaches a card, because the card editor mounts only on record slots and no
step-3 surface writes one there; step 6's import, which holds them (§2.3), owns their display.

**The axes derive from the profile.** `shared/editorTypeContext.ts::buildEditorTypeContext` becomes
`buildEditorExpressionContext(slot, catalogs)`, returning part 01's `ExpressionContext` for the
mounting slot: `caseDataScope`, `evaluationTarget`, `patternMatching`, `ownerValues` and the table
scope come from `profiles.ts` (via one `editorAxesForSlot(doc, slot)`, since `caseDataScope` follows whether that form opens with a case), and each surface still supplies its
catalogs (form answers in scope, operations in scope, the table). Each of the 25 mounting components
passes its slot address instead of writing axes by hand. So the editor's offer set is the gate's
accept set by construction, the property `components/builder/CLAUDE.md` holds today with two
invariant tests and a per-carrier test (`__tests__/validByConstruction.test.ts`,
`__tests__/verbMenuBuildFuzz.test.ts`,
`case-operations/__tests__/caseOperationValidByConstruction.test.ts`). Those three stay, re-pointed
at `ExpressionContext`; one parity test, `shared/__tests__/editorProfileParity.test.ts`, asserts for
every record slot id that `editorAxesForSlot` and the deep validator's context for that slot (on a
fixture document) build the same `ExpressionContext`.

### 4.6 Options

`components/builder/editor/fields/OptionsEditor.tsx` and `optionsDraftModel.ts`:

- **Value edit.** Committing a choice's new value reprints every `choice` that names it; nothing is
  rewritten (the default `'yes'` prints `'y'` after the edit; today it keeps `'yes'`, executed
  during planning, below).
- **Remove.** The remove control asks the reference index who reads the option
  (`referencingSlotsOf(doc, entityTargetKey(optionUuid))`, §5.1). With readers it is disabled with
  the reason "This choice is the starting value of {question}" or "{question}'s {slot label}
  compares with this choice", and the sentence ends "You can change that first." Today removal is
  admitted and the default keeps a value no option has (executed). The cutover lifts the literals
  production compares with a static select to `choice`, so from step 3 this control is disabled for
  most compared options in those apps, each with its reason; the gate refuses the same removal from
  the SA and MCP with the validator's message.
- **Source replacement and kind conversion.** Replacing a static select's options with a data table
  or cases source, or converting the select to a kind with no options
  (`lib/doc/kindConversionCascade.ts::planKindConversion`), turns each `choice` naming that field into
  a text literal of its current value in the same batch. The comparison keeps its meaning (it still
  compares with that value), and a select-to-select conversion keeps its options and every `choice`.
  The planner reports the count with its existing impact copy. This step lands in pull request 5,
  the shape, with the `choice` leaf; only the options editor's controls wait for pull request 11. A
  `choice-name` that reads the select refuses the source replacement, naming the read (part 03
  §3.7), because Core throws on `jr:choice-name` over a select whose choices are not written;
  production stores none.

A picker of choices in place of the expression editor, for a static select's starting value, is not
planned in step 3: autocomplete offers the option values with their labels (§4.2), and a picker is a
new control.

### 4.7 Tests

The builder's state models are tested as models, and the editor in a browser through Playwright.

| Test | Boundary |
|---|---|
| `lib/codemirror/__tests__/xpath-lint.test.ts` (rewritten in pull request 5, extended in 11) | `xpathDiagnostics` over real documents: a parse issue and a checker finding each underline their own span, in a draft whose spacing differs from the print, an ordering on a time among them (pull request 5); the session cases of `buildSessionLintContext.test.ts`, against `buildExpressionEditorContext` (pull request 11) |
| `lib/codemirror/__tests__/buildSessionLintContext.test.ts` (re-pointed in pull request 5, deleted in 11) | the session context's `check`: a form read and a bare relative name refused with today's two sentences, a readable case property admitted |
| `lib/codemirror/__tests__/xpath-autocomplete.test.ts` (extended) | each source of §4.2 offers exactly what the parser accepts at that position |
| `components/builder/__tests__/xpathDraftReconciliation.test.ts` (rewritten) | §4.4 over document pairs |
| `components/builder/shared/__tests__/editorProfileParity.test.ts` (new) | §4.5 |
| `lib/doc/__tests__/kindConversionCascade.test.ts` (extended) | the `choice` to literal step; a source replacement refused while a `choice-name` reads the select |
| `components/builder/shared/__tests__/validByConstruction.test.ts` (re-pointed) | every stored kind has a card, the display-only `ValueListCard` included; no verb menu offers `value-list`; from pull request 10, the chosen-case source is offered exactly where the slot's profile and the entry's supplies admit it |
| `components/builder/shared/__tests__/termEditorModel.test.ts` (extended, pull request 10) | the chosen-case source lists exactly the menus whose case the entry has chosen one at a time, labelled "The case chosen in {menu}" by the current name, offers "The case itself" and the menu's case-type properties, stores §2.3's two shapes, and lists no unpassed, case-less or several-case menu |
| `components/builder/__tests__/referenceContextChanged.test.ts` (re-pointed in pull request 5) | against `buildFormReferenceContext`: a change the per-form walk reads clears the cache and a change it does not read leaves it |
| `lib/references/__tests__/provider.test.ts` (re-typed in pull request 5) | its contexts are `FormReferenceContext`s; its cases are unchanged |
| `e2e/` smoke (one new flow) | type `../a = 'yes'` in a relevant, rename `a` to `c`, see `../c = 'yes'`; a case query reads a property, the property is renamed, the field shows the new name |

---

## 5. The reference index and renames

### 5.1 Edges

`lib/doc/referenceIndex.ts` extracts every edge with one walker over the union (part 01, `walk.ts`),
replacing `extractAstRefs` (text-run leaves), `predicateEdges`, `expressionEdges` and `termEdges`. No
target-key prefix is added (`lib/domain/referenceIndex.ts`):

| Leaf or arm | Edges |
|---|---|
| `field` | `u:<uuid>`, `u:<climb>`, `u:<filters[].step>` |
| `repeat-row` | `u:<repeat>` |
| `choice` | `u:<field>`, `u:<option>` for each option |
| `choice-name` | `u:<field>` |
| `itext` | `u:<field>`, `u:<option>` for an option label |
| `form-case`, `prop` (row leaves of `cases` included, keyed by the row type: the typed or bound type in `casedb`, the module's searched type in `search-results`) | `t:` and `c:` as `termEdges` does today |
| `case-type` | `t:<type>` |
| `case-index` | `t:<caseType>` |
| `session-datum` (a record slot's `chosen-case` included) | `selected-case`, `tile-group-parents`: `u:<module>`; `new-case`, `worker-record`: `u:<owning form>`; `new-child-case`: `u:<owning form>` and `t:<caseType>` (part 05 §1.7) |
| `selected-cases` | `u:<module>` |
| `session-user-property` | `p:<uuid>` (both sources) |
| `input` | `u:<searchInputUuid>` |
| `location-field { level }`, `location-level` | `u:<levelUuid>` |
| `location-field { property }` | `u:<propertyUuid>` |
| `fixed-location`, `owner-location-at-level`, `id-of` | as today |
| `table-lookup`, `table-rows`, `table-column` | none here: `lib/doc/lookupReferences.ts` (§5.5) |
| `here`, `negate`, `call`, `value-list`, `today`, `now` | none |
| a form link's `datums[].name` (`selected-case` only) | `u:<module>`, under the link's slot (part 05 §1.7) |

The held constructs (`groups`, `group-field`, `project-day`, the `device-query` datum kind) are not in
step 3's union and add no key (part 01 §5).

Why no new prefix: options, levels, location properties and Search inputs are already in the app-wide
authored identity namespace (`lib/domain`, `authoredBlueprintIdentities`;
`lib/doc/mutationIdentityAdmission.ts` admits `selectOption` UUIDs against it), so `u:` is
unambiguous; a datum is owned by a module, a form or a case type, which already key; a translation
unit is owned by its field or option. The index carries what a consumer queries
(`lib/doc/CLAUDE.md`, `referenceIndex.ts`): the option edge's consumer is §4.6's remove control and
the gate's dangling-identity rule; the module edge's is `moduleDependents.ts`; the form and
`(form, caseType)` edges of a `new-case` or `new-child-case` read are the case-operation removal
verdict's, which refuses removing the last writer of a child type outside a repeat while a
`new-child-case` names it (part 05 §1.7); the rest existing consumers already query.

`lib/domain/referenceSlots.ts` collapses `xpath-ast` and `predicate-ast` into one kind, `expression`
(part 01 §6.1); the slot ids stay, so the validator's surface unions and every error location keep
their names. The totality audit (`lib/domain/__tests__/referenceSlots.test.ts`) re-classifies every
slot and fails on any left over.

Maintenance (`planReferenceIndexMaintenance`): no new mutation kind re-extracts a reader, because every
new edge keys on a UUID or a name that a rename does not change. `updateOption` and `removeOption`
touch only the field's own options. A module case-type change already re-extracts its `ctx` bucket;
a datum read prints differently after it but keeps its `u:<module>` edge.

### 5.2 The incremental ≡ rebuild oracle

`lib/doc/__tests__/referenceIndex.fuzz.test.ts` compares the incrementally maintained index with
`buildReferenceIndex` after each raw mutation batch. Both call the one union walker, so parity
follows from the walker; what the fuzz must still prove is that maintenance re-extracts the right
carriers. Its generator gains form-logic slots holding every leaf of §5.1 (drawn from the §2.4
arbitraries), and its mutation draws gain `updateOption`, `removeOption`, `moveField` across a repeat,
`updateModule` changing a case type, and `renameCaseProperties` over a property a case query reads.

### 5.3 Case-property renames

`lib/doc/casePropertyRenames.ts::rewriteCasePropertyCarriers` calls one rewriter over the union
(part 01's `rewrite.ts`, replacing `mapCasePropertiesInXPath`, `mapCasePropertiesInPredicate` and
`mapCasePropertiesInExpression`), which renames every `(caseType, property)` leaf by its destination
type, the row leaves and projections of a `cases` query included. Because every row is typed at parse
(§1.3), a bound untyped read included (its type is stored), a query read is never ambiguous; part
01's several-destination rule (§5) applies to `via` relations only. With the catalog's `required` and
`validation` slots retired (decided with the person, 2026-10-17), their branches of
`rewriteCasePropertyCarriers` go with the slots, in pull request 5, the shape (§3.3).

`lib/doc/casePropertyRenameImpact.ts` needs no change of grouping: it counts every carrier whose
stored leaf changed, from a diff of `casePropertyCarrierNames` before and after, and puts anything not
a writer or a declaration under `typed-reads`. `casePropertyCarrierNames` walks through the same
rewriter's leaf walk, so case-query reads count with no second inventory. The rename review
(`casePropertyRenameReview.ts`) then tells the person about them; today it counts none for them,
because a case query is a text run and `lib/domain/xpath/walk.ts::mapCasePropertiesInXPath` renames
`case-ref` parts only.

### 5.4 Fields, options, modules, case types

- **Field rename.** Nothing is rewritten; every spelling re-derives at print, relative ones included.
  The executed stranding (§1.1) cannot happen.
- **Field move.** A move changes the print of reads of the moved field and of reads inside it.
  Relative paths derive their common ancestor from identity on the moved document; no stored
  `climb` can become stale. A retained filter step can lose its target, and a read that crosses into
  or out of a repeat changes cardinality. `lib/doc/formSectionVerdicts.ts::fieldPlacementVerdict` gains a fifth
  refusal beside its four, computed from the index (`referencingCarrierUuids` for the moved field and
  its descendants) and the printer: "Moving {question} here would leave {reader}'s {slot label}
  without a path to it." The drag gate, the keyboard move, the inspector's move menu and the SA's
  `moveField` pre-check read it, as they read the other four. The same verdict runs the slot checker
  over those readers on the moved document, so a move that makes a structural read many (a reader
  moved out of a repeat, or a field moved into one) is refused before the drop with the checker's
  `many-values` sentence, as part 03 §3.4 asks of the move verdicts (`lib/doc/navigation.ts` and
  `fieldPlacementVerdict`); the gate refuses the same batch from the SA and MCP.
  **Implementation sequencing, 2026-10-18:** pull request 5 installs the candidate-document
  preflight over indexed readers, their paths and the current slot checker. The structural-many
  refusal becomes active in pull request 6, which owns part 03 §3.4, `XPATH_MANY_VALUES` and its
  presentation; that pull request adds both move cases to the same verdict test file. This resolves
  the original stack rows' conflict without duplicating a checker rule in the move preview.
- **Option value edit and removal.** §4.6. The gate's dangling-identity rule
  (`lib/commcare/validator/index.ts`) covers an option UUID like any other.
- **Module removal.** A datum read of a module (`u:<module>`), in form logic or, from pull request
  10, a record slot's chosen case (§2.3), refuses removal through `lib/doc/moduleDependents.ts`,
  named in the person's voice ("{form or menu}'s {slot label} reads the case chosen in this menu.
  You can change that first."). A structural change that leaves a stored ref unsupplied (a parent-select
  change, a move out of a nested menu, a switch to several-case selection, tile grouping turned off)
  is the checker's `SESSION_DATUM_NOT_SUPPLIED` with part 05 §1.6's sentence per kind, and the
  case-selection review lists it among its blockers (part 05 §1.7). Production's datum reads are all
  of a selected case.
- **Case-type retirement.** `lib/doc/caseTypeRetirement.ts` counts every leaf naming the type: the
  `xpath-ast` arm of `collectFieldReferences` reads the union walker's case-type leaves (`form-case`,
  `prop`, `case-type`, `case-index`, `new-child-case`) instead of `case-ref` parts, with the copy
  "field {id} in {where} reads {type} records in its {slot label}". No case-type rename is added
  (part 01 §5).
- **Worker property and Search input removal** reach form-logic reads already (`p:`, `u:`).

### 5.5 Lookup reads in form logic

`lib/doc/lookupReferences.ts::PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS` gains part 05 §2.3's four
extractors, `field_form_logic`, `connect_form_logic`, `form_link_condition` and `form_link_datum`,
walking `table-lookup`, `table-rows` and `table-column`, with the canonical nested subpath of each
occurrence (`canonicalLookupReferenceSubpath`; the field UUID and slot id, the link UUID, and for a
datum the target datum ref). The edge tables hold `(app, table)` and `(app, table, column)` only, so
they need no migration, and no stored form logic names a table today, so the cutover rewrites no
edge (part 05 §2.3). Persisted edges follow from the extractors
(`lib/db/lookupReferenceEdges.ts`), so a data table or column read in form logic refuses its removal
at the Project level as it does today for a record expression, and the structural `LOOKUP_*` findings
cover form logic. The four extractors land in pull request 9, instances and session, where a
form-logic table read becomes admitted, so the publish push and the deletion refusal arrive with
the read (part 10, "Ordering constraints").

### 5.6 Tests

| Test | Boundary |
|---|---|
| `lib/doc/__tests__/referenceIndex.fuzz.test.ts` | §5.2 |
| `lib/doc/__tests__/casePropertyRenames.test.ts`, `casePropertyRenameImpact.test.ts` (extended) | a case-query predicate and projection renamed; the impact's `typed-reads` counts them |
| `lib/doc/__tests__/formSectionVerdicts.test.ts` (extended) | the fifth refusal against the commit gate, as the file does for the other four |
| `lib/commcare/validator/__tests__/gate.test.ts` (extended) | option removal refused while read; value edit admitted and reprinted; the relative-read rename case of §1.1 admitted with the new print |
| `lib/doc/__tests__/caseTypeRetirement.test.ts` (extended) | a case-query read blocks retirement with its sentence, a bound untyped read included |
| `lib/doc/__tests__/formSectionVerdicts.test.ts` (same file) | a reader moved out of a repeat, and a read field moved into one, refused with the `many-values` sentence |
| `lib/doc/__tests__/lookupReferences.test.ts` (extended) | a form-logic table read is an occurrence with its subpath |

---

## 6. Consumers that re-parse printed text

`lib/domain/expressionSource.ts` is the one read accessor for expression slots; today every accessor
prints (`expressionSource`, `formExpressionSource`, `expressionSurfaceReads`) and consumers re-parse
the text. From step 3 it offers `expressionAt(doc, slotRef)` (the tree) and
`expressionDisplayText(expression, formPrintContext)` (the print) for two consumers: blueprint search and the
read-only inspector, which match and show what a person reads. The slot reference names its
actual owner and stable member identities; the form print context comes from that slot and the
lookup snapshot. Prose uses separate `proseSource`, `proseSourceEntries` and `proseSurfaceReads`
accessors. Every other expression consumer reads the tree:

| Consumer | Today | From step 3 | Owner |
|---|---|---|---|
| `lib/commcare/fieldProps.ts::readFieldString`, `xpath/wireSource.ts` | prints, then the emitter scans and lowers text | the wire tree and its one serializer | part 04 |
| `lib/commcare/xpath/carriers.ts::authoredXPathCarriers` | yields printed carriers with a profile | yields trees; profiles from `profiles.ts` | parts 04 and 01 |
| `lib/commcare/xpath/compatibility.ts::analyzeXPathCompatibility` | text capability scan | the profile's admitted arms, in the checker | part 01 |
| `lib/commcare/xpath/javaRosaLowering.ts`, `xform/instanceRefs.ts` | text CST lowering and instance scan | from the wire tree | part 04 |
| `lib/commcare/validator/xpathValidator.ts::validateXPath` and its importers (`lib/codemirror/xpath-lint.ts`, `validator/index.ts`, `validator/runner.ts`) | text checks | the parser (§1.4) and the checker; `validateXPath` is deleted | part 01, this part |
| `lib/commcare/validator/timeOrdering.ts` | prints and re-parses | the checker's `time-ordering`; file deleted | part 01 |
| `lib/codemirror/buildLintContext.ts::formTimeOrderings` | ordinal placement | spans (§1.5); deleted | this part |
| `lib/agent/authoring/operationSemantics.ts` | text-run test | tree walk (§3.4) | this part |
| `lib/doc/caseTypeRetirement.ts` | `case-ref` parts | union leaves (§5.4) | this part |
| `lib/doc/formLinkMutations.ts::formLinkIsConditionalIn` | "prints to non-empty XPath" | the condition is present | this part |
| `lib/doc/hooks/useFormRecordName.ts`, `useFormLinkChoices.ts`, `useXPathSlots.ts` | print | `projectFormExpression` | this part |
| `lib/preview/engine/formEngine.ts`, `triggerDag.ts`, `useCaseDatabaseSnapshot.tsx`, `formLinkEvaluation.ts`, `lib/preview/xpath/dependencies.ts::extractPathRefs` and `::formRootReadPositions` | evaluate and extract dependencies from text | evaluate the emitter's Preview spelling; dependencies from field leaves | part 07 |
| `lib/commcare/formLinkProjection.ts` | prints conditions | the wire tree | part 04 |
| `lib/doc/searchBlueprint.ts` | printed text | printed text (unchanged) | none |

---

## 7. Public docs and contract files

Each public-docs row lands in the pull request whose behavior it describes; part 10, "Public docs
that change", holds the exact sentences and is the one placement. Pull request 14, contracts and
public docs, takes only the contracts, the architecture docs and rows no single pull request owns;
none of this part's rows is such a row.

| Page | Change | Pull request |
|---|---|---|
| `content/docs/building-with-nova.mdx`, "XPath that will run in CommCare" | replace "Raw XPath can use the stable casedb and commcaresession instances, but it cannot name a lookup table by its mutable wire tag." with: a form can read a data table by its tag, and renaming the table or a column keeps the read connected | 9, instances and session |
| same | add: record queries name their record type and follow property renames; a question can be named by `#form/`, `/data/` or a relative path, and each follows renames and moves; after you save, the expression shows in Nova's standard spacing. The `normalize-space(...)` sentence stays: part 04 keeps its lowering to native functions. Part 04 §7 adds this page's lines on comparing dates and times (pull request 8) | 5, the shape |
| same, "Insert an answer or saved value into wording" | unchanged | none |
| `content/docs/case-workspace.mdx`, the rename paragraph near "Changing a search field's internal name" | add that renaming a case property updates record queries in form expressions too, and the review counts them | 5, the shape |
| `content/docs/building-with-nova.mdx`, "Text in your app", the choice paragraph (not `case-changes.mdx`, whose option paragraph is about operations) | a choice that is a starting value or that a formula compares with can't be removed until those change; a value edit keeps them connected; changing where a select's choices come from turns those comparisons into plain text; a fixed starting value is one of the choices or empty | 5, the shape |
| `content/docs/building-with-nova.mdx`, the refusals and hidden-value paragraphs | part 03's new refusals (part 03 §8: incompatible values, many values, a hidden value that disagrees with its property), each said in Nova's voice with what to write instead | 6, the checker |
| `content/docs/mcp/tools.mdx`, "Wording and expressions are authored as text" and the read-tools sentence | relative paths (`../name`) are accepted and read the same row; a record query names its record type; reads return Nova's standard spelling of what was sent | 5, the shape |
| same, the data-table read | a form can read a data table by tag; `get_lookup_tables` lists tags and columns | 9, instances and session |
| same, the record-query paragraph | `record-type()`, part 06 §7's clauses, and the chosen case: a Search rule, a case-list filter or a form's display condition that runs after a case is chosen in an earlier menu reads it as `chosen-case('<menu name>')` and its properties as `chosen-case-property('<menu name>', '<property>')` | 10, CSQL |
| `content/docs/case-workspace.mdx`, "Choose which cases people can find" | add: in a menu opened after a case is chosen in an earlier menu, **Cases available**, a case-list filter and a form's display condition can read that case and its properties ("The case chosen in Households"), so a search can find the members of the chosen household | 10, CSQL |
| same, `here()` | in a calculated case-list column, `here()` reads where the worker is now | 7, Preview |
| `content/docs/users-and-personas.mdx`, "While an XPath editor is open" | a teammate's rename appears live for every identity draft reconciliation follows (worker information, a question, a Search answer, a data table or column, a choice's value), §4.4 | 11, the builder |
| `content/docs/mcp/tools.mdx`, `add_form_links` row | unchanged: datum names are what they are today; a name must be a case the destination asks for | none |

The stack merges as one deploy, so every page ships with the behavior it describes, and each
pull request's page is true at its own head. Part 05 §4's docs rows (session values, places, the
several-case count, "Search first") and part 06's carry their own pull requests in part 10's table;
this table holds the authoring part's.

No `design/` change: no new visual primitive. Each contract sentence moves with the behavior that
makes it false. `lib/doc/CLAUDE.md` (the `expressionText.ts` and `referenceIndex.ts` bullets) and
`lib/agent/authoring/CLAUDE.md` (§3.2) are rewritten in pull request 5. `components/builder/CLAUDE.md`
("Predicate / expression card editor") is rewritten as part 10's table places each sentence: those
naming the deleted `Predicate` / `ValueExpression` vocabulary in pull request 5, the rest in pull
request 11.

`lib/codemirror/CLAUDE.md`, read at `main` `5cf6e327`, sentence by sentence against the pull request
5 linter re-point (§4.1, "The editor context in pull request 5"):

| Section and sentence today | At pull request 5's head | Rewritten in |
|---|---|---|
| opening, "CodeMirror 6 extensions for editing CommCare XPath inside the builder: language binding, autocomplete, linting, hashtag chips, source formatting, theme." | still true (chips and formatting change in pull request 11) | 11 |
| opening, "The grammar + parser live in `lib/commcare/xpath/` (shared with the carrier capability contract, lowerer, and deep validator); this package only consumes `parser` + the term constants it re-exports." | false: the capability scan (`compatibility.ts`), the raw-XPath lowerer (`javaRosaLowering.ts`) and the text validator leave in pull request 5, and the linter's `check` consumes `parseFormExpressionForSlot`. It becomes: "The grammar and the form-XPath parser live in `lib/commcare/xpath/` (shared with the checker and the emitter); this package consumes the Lezer `parser`, the term constants it re-exports, and `lib/doc/expressionText.ts::parseFormExpressionForSlot`." | 5 |
| "No offer-then-reject", whole section | still true: `caseRefAcceptMap` is the accept set the checker's admission enforces (part 03 §1.3, `readableCaseTypes`) | 11 (adds the `FormParseScope` sentence) |
| "Session scope", "`XPathLintContext.scope` says where the expression runs. `"form"` (the default, `buildLintContext`) is a field's slot inside the open form instance. `"session"` (`buildSessionLintContext`) is an after-submit link's condition or carried value, which CommCare evaluates after the form has closed:" | still true: the context keeps `scope` and both builders | 11 (`ExpressionEditorContext`) |
| same, "the context carries the form's readable case types (one derivation, `formReachableCaseTypes`, through `caseRefAcceptMap(index, formType, "session")` exactly as the deep validator's form-link pass reads it … ) and NO form paths …" (the rest of the sentence, on registration forms and the empty `validPaths` and `formEntries`, as it stands) | false in one clause: the deep validator's form-link pass that called `validateXPath` leaves. "exactly as the deep validator's form-link pass reads it" becomes "exactly as the checker reads the form-link profile"; the rest stays | 5 (the clause); 11 (the rest) |
| same, "Under it, autocomplete withholds `#form/` and `/data/` instead of offering what the gate refuses," | still true | none |
| same, "and the validator itself (`validateXPath(…, "session")`) turns a form read or a bare relative name into the author-facing reason (`SESSION_FORM_READ_MESSAGE`) rather than "unknown field" …" (to the end of the sentence) | false: `validateXPath` leaves. It becomes: "and the parser and the checker themselves turn a bare relative name (`relative-no-context`, with today's sentence) and a form read (`SESSION_FORM_READ_MESSAGE`, under the form-link profile) into the author-facing reason rather than "unknown field"; the linter adds no rule of its own." | 5 |
| same, "`xpathDiagnostics` is the pure, testable heart of `xpathLinter`." | still true; pull request 5 adds: "It returns the context's `check` of the draft: each parse issue at its span, then, when the draft parses, the slot checker's findings placed by span, so the inline lint and `XPathField`'s save gate read one function." | 5 (the addition) |
| "Ordering a time of day", whole section | false: `timeOrderings`, `formTimeOrderings`, `findTimeOrderingComparisons` and `orderingSpans` leave. The section becomes "Spans place findings": "Parsing and printing each return a span per node, keyed by the node's path in the stored tree, the same path a checker finding carries, so the linter underlines every finding, `XPATH_TIME_ORDERING` among them, on the text as typed, whatever its spacing. The editor refuses exactly what the commit gate refuses. `check` is a projection of one snapshot, never part of what the reference cache keys on." | 5 |
| none (new sentence, "Session scope") | added: "`formReferenceContext.ts::buildFormReferenceContext` is the per-form half: both lint contexts spread it, and `ReferenceProvider` reads it for any form through `components/builder/BuilderReferenceProvider.tsx`, whose cache `components/builder/referenceContextChanged.ts` clears exactly when a slice that walk reads changes." | 5 |
| "Node type comparisons", "(each consumer builds its own `T` lookup from it, as `xpath-format.ts` does)" | still true (`xpath-format.ts` leaves in pull request 11) | 11 |

---

## 8. Files

New: `lib/domain/expression/spans.ts`; `lib/commcare/xform/itextIds.ts`;
`lib/codemirror/formReferenceContext.ts` (pull request 5, §4.1);
`components/builder/shared/editorAxes.ts`; `components/builder/shared/cards/expression/NegateCard.tsx`,
`HereCard.tsx`, `ValueListCard.tsx` (display only); the tests named above. Part 06's
`ConditionChoiceCard.tsx` and `CaseTypeValuePicker.tsx` are that part's files; the existing
`components/builder/shared/CaseTypePicker.tsx` is not touched. `lib/domain/entryDatumSupplies.ts`
and `lib/commcare/validator/formLogicFindings.ts` (with `checkFormLogicSlot`) are part 05's and
part 03's.

Rewritten: `lib/commcare/xpath/expressionAst.ts`, `lib/doc/expressionText.ts`,
`lib/agent/authoring/queryExpressions.ts`, `printQueryExpression.ts`, `bindings.ts` (from pull
request 10 also the `"module"` identity kind and the menu refusals, §2.3), `text.ts`,
`input.ts` (decoders), `output.ts` (encoders), `schema.ts` (families), `operationSemantics.ts`,
`reference.ts`, `lib/domain/expressionFunctions.ts` (`QUERY_FUNCTIONS`, from pull request 10 also
`chosen-case` and `chosen-case-property`), `lib/codemirror/xpath-lint.ts`,
`xpath-autocomplete.ts`, `xpath-chips.ts`, `lib/doc/hooks/useXPathSlots.ts`,
`components/builder/XPathField.tsx`, `xpathDraftReconciliation.ts`, `shared/editorTypeContext.ts`,
`shared/termEditorModel.ts` (from pull request 10 also the chosen-case source), the cards of §4.5,
`editor/fields/OptionsEditor.tsx`, `lib/doc/referenceIndex.ts`, `lib/domain/referenceSlots.ts`,
`lib/doc/casePropertyRenames.ts`, `caseTypeRetirement.ts`, `formSectionVerdicts.ts`,
`kindConversionCascade.ts`, `lookupReferences.ts`, `formLinkMutations.ts`, `moduleDependents.ts`
(the copy of §5.4), `lib/domain/expressionSource.ts`, `lib/agent/tools/form-links/shared.ts`,
`lib/agent/wireSchemas.ts`.

The linter-context files (§4.1), by pull request:

- **Pull request 5:** `lib/codemirror/buildLintContext.ts` and `buildSessionLintContext.ts` (the
  per-form half moves out to `formReferenceContext.ts`; both gain `slot, lookup` and `check`);
  `components/builder/editor/fields/useFormLintContext.ts` and
  `components/builder/detail/formSettings/useFormLintContext.ts` (the slot address); their mounts
  `editor/fields/XPathEditor.tsx`, `HiddenValueEditor.tsx`, `RequiredEditor.tsx`,
  `detail/formSettings/RecordNameSection.tsx`, `DeliverConfig.tsx`, `LearnConfig.tsx`,
  `detail/appSettings/ConnectEnableDialog.tsx`, `form-links/LinkConditionEditor.tsx` and
  `CarryValuesSection.tsx`; `components/builder/BuilderReferenceProvider.tsx` (calls
  `buildFormReferenceContext`), `components/builder/referenceContextChanged.ts` (its comment; its
  reads are unchanged), `lib/references/provider.ts` and `ReferenceContext.tsx` (typed by
  `FormReferenceContext`); and their tests, `lib/codemirror/__tests__/buildSessionLintContext.test.ts`,
  `components/builder/__tests__/referenceContextChanged.test.ts`,
  `lib/references/__tests__/provider.test.ts`.
- **Pull request 11:** `buildLintContext.ts` and `buildSessionLintContext.ts` are deleted for
  `buildExpressionEditorContext`; both `useFormLintContext` hooks and their mounts build it;
  `XPathField.tsx`'s chip provider reads its `reference`. `formReferenceContext.ts`,
  `BuilderReferenceProvider.tsx`, `referenceContextChanged.ts` and `lib/references/provider.ts`
  are not touched.

For the catalog inputs' removal, in pull request 3, the projection:
`lib/agent/planningSchemas.ts::caseTypesOutputSchema` (which `generateSchema` serves),
`lib/agent/tools/caseProperties.ts` (`updateCaseProperty`), `lib/agent/tools/generateSchema.ts` and
`lib/agent/contentProcessing.ts`.

Deleted: `lib/agent/modelAstInput.ts`, `lib/agent/expressionReference.ts`,
`lib/codemirror/buildLintContext.ts` and `buildSessionLintContext.ts` (in pull request 11),
`xpath-format.ts` (in pull request 11, with its test; `app/(dev-only)/xpath-test/page.tsx` and
`README.md` change with it, §4.1), `xpath-hashtag-spans.ts` (its one use, reconciliation, reads
parse spans), `lib/commcare/validator/xpathValidator.ts`, `timeOrdering.ts`,
`lib/commcare/xpath/detectUnquotedStringLiteral.ts` (its logic moves into the parser's issue
builder as `relative-unknown`'s quote suggestion, part 03 §2.1), and the tests of §1.7 and §3.5.

## 9. How this part lands in the stack

The stack is fifteen pull requests in one `gh stack` chain, merged together in one deploy (part 10
holds it in full; pull request 1, lane mechanics, is its bottom). This part lands in five of them and
rides three more.

### 9.1 Pull request 3, the projection

The `authoringJsonSchema` pre-substitution (part 01 §6.3); the three removed catalog tool inputs
(§3.3); the stale residue of §3.5, whose deletion the executed
byte check shows changes no served schema (`askQuestions` and `uploadMediaAsset`, "Executed
during planning"); `scripts/inspect-tool-schema-hashes.ts` (part 10); the registrations of §3.7
whose hash moves (`updateCaseProperty` at least); `MODEL_CONTEXT_VERSION`. Its description
records the per-tool hash at base and head (§3.6). No stored-shape or guide change. Its lane is
part 08's 10.2-minute row: it has no lane input of its own, but its base's new documents,
controls and register entries are not in main's store (part 08 §6.2).

### 9.2 Pull request 5, the shape

§1 and §2 (both parsers and printers, the binding hint, the
round-trip suites), §3.2's `lib/agent/authoring/CLAUDE.md` paragraphs and §3.4's
`operationSemantics` walk (each reads the stored shape, so it cannot land apart from it), §5
(index, renames, the catalog rename branches the retirement removes; the four form-logic lookup
extractors ride pull request 9) and §6, because a stored shape and its only writers and readers
cannot land apart. With it ride session datum identity (`DatumRef`, `FormLinkDatumName`,
`entryDatumSupplies`, the `datum` family, the datum parse refusals), the builder pieces a stored
kind needs from this head (the linter re-pointed to parse issues at spans and the slot checker in
place of `validateXPath`, through `XPathLintContext.check`, with the per-form half split out to
`formReferenceContext.ts` for `BuilderReferenceProvider.tsx`, §4.1 and §8; the cards `NegateCard`,
`HereCard` and display-only `ValueListCard`; the kind-conversion `choice` step in
`lib/doc/kindConversionCascade.ts`), the `lib/codemirror/CLAUDE.md` sentences §7 marks 5,
`MODEL_CONTEXT_VERSION` `".5"` (§3.3) and §7's rows marked 5. Its description shows no served hash
moved. Part 08's `targeted-expression-renames` and the gate test of §5.6 land here, as defect 17's
witness (part 08 §3.4). The parser in this pull request resolves every read §1.3 lists. The new
reads part 05 makes authorable (data tables, places, `selected-cases`, search results,
`jr:itext`, `jr:choice-name`) get their arm's `toWire` row and declaration in pull request 9
(part 04 §8.5), so their slots' profiles admit them from pull request 9, as part 03 §3.8 states
for search results; until then the checker's admission refuses them, and production holds none
(§1.3).

### 9.3 Pull request 10, CSQL

The chosen case in record slots (§2.3): the `chosen-case` and `chosen-case-property` entries of
`QUERY_FUNCTIONS`, their compile and print in `queryExpressions.ts` and `printQueryExpression.ts`,
the `"module"` identity kind and the four menu refusals in `bindings.ts`, the record-slot sentences
of `SESSION_DATUM_NOT_SUPPLIED` (part 05 §1.6), the card editor's "The case chosen in {menu}" source in
`termEditorModel.ts` (§4.5), the record-dialect arbitrary's draw of it (§2.4), §3.1 item 4's
chosen-case sentence, and the tests §2.4 and §4.7 mark 10; part 06 §3.9 lands its CSQL positions,
emission and fold in the same pull request, part 05 the supply, part 07 Preview, and part 08 a
scenario in `targeted-csql-composition`. With them ride part 06's cards (`ConditionChoiceCard.tsx`,
`CaseTypeValuePicker.tsx` and the widened cards of §4.5), §3.1 item 4's `record-type()` and part 06
§7's clauses, the `".10"` bump (§3.3), and §7's rows marked 10.

### 9.4 Pull request 11, the builder

The rest of §4 for the reads that exist from pull request 5
(canonical show-back, autocomplete, chips from spans, draft reconciliation over every identity,
options controls, `ExpressionEditorContext` and the deletion of the two lint builders, `xpath-format.ts`
with the dev playground's two buttons and its `README.md` line, the card editor's profile-derived
axes and the verb
and value-source menus that offer `negate`, `here` and a static select's choices; the cards
themselves ride 5), the rest of its `CLAUDE.md` sentences (§7), §4.7's tests, including the one
Playwright smoke flow, and §7's row marked 11.

### 9.5 Pull request 12, the authoring

§3.1's items 1, 2 and 5, `here()`, and the fields and forms
lines; `MODEL_CONTEXT_VERSION`; the `../nova-plugin` sweep (§3.8). The billed
`npm run test:schema` is asked once after it, at the stack head, naming every registered tool
whose hash moved across the stack (§3.7).

### 9.6 Rides elsewhere

- **Pull request 9, instances and session**, carries the builder and authoring rows of part 05's
 reads: the four form-logic lookup extractors of §5.5, the completion sources of §4.2 for data
 tables, places, the session's datums, `selected-cases`, `results:inline` and
 `search-input:results:inline` (their chips ride pull request 11's span-based chips, §4.3); §3.1's
 items 3 and 6; its `MODEL_CONTEXT_VERSION` bump; §7's rows marked 9.
- **Pull requests 6 and 7** carry §7's rows marked 6 and 7, with the behavior each describes.

---

## What changes for authors

Each is a deliberate change to what commits or shows today, with its reason.

- **New parse refusals for text that commits today:** `case-query-untyped`, `relative-unknown` for a
  bare sibling name, and part 05's `placeholder-datum` and `multi-select-datum-value`. Each names
  nothing a rename can follow, and the bare sibling name reads nothing on a device (§1.1).
  Production meets only some untyped reads, those no case type or several declare; it holds none of
  the others (§1.4's production table). Each stored occurrence the dry run finds is a
  `target-gate` blocker the author resolves in the app before the window (part 09 §11).
- **Empty text clears the slot** in SA, MCP and the builder (§1.2). Today an SA may send `""` and
  store an empty expression; from step 3 it means the same as `null`.
- **The chosen case is readable in record slots, from pull request 10.** A search, a case-list
  filter or a form's display condition that runs after a case is chosen in an earlier menu reads it
  as `chosen-case('<menu name>')` and its properties as `chosen-case-property('<menu name>',
  '<property>')`, and the card editor offers it as "The case chosen in {menu}" (§2.3, §4.5), so a
  search narrowed to a chosen parent is authorable. The spelling names the menu, as the person
  knows it, never a wire id: there is no `datum(…)` spelling. Form link datum names stay the
  target's datum ids on the SA wire (§3.6), because that wire is unchanged and its description
  already teaches them.
- **The builder no longer normalizes text before saving;** it shows the canonical print with layout
  after saving. A person sees their spacing replaced once per save (part 01 §2.5), and the
  expressions production stores that print differently show their canonical text on first read.
- **XPath chips come from parse spans,** so a chip appears only on an expression that parses.
- **Option removal is refused while a choice or default reads the option,** and a source replacement
  or a conversion to a kind with no options turns each `choice` into a text literal of its value in
  the same batch. With the compared literals lifted to `choice`, this is a visible change in most
  apps with a static select.
- **Session context:** the parser admits all seven fields; editors offer the four they offer today
  until step 4 admits the rest per platform.
- **The `wireSchemas.ts` AST projection, `modelAstInput.ts` and `expressionReference.ts` are
  deleted,** with the tests that held a projection production does not serve.
- **The catalog inputs leave in pull request 3, the projection,** not with the stored fields (§3.3),
  so the model's served-schema changes are one change.
- **`jr:choice-name` over a field that is not a select is a parse refusal**
  (`choice-name-not-a-select`, part 03 §3.7); on a non-select Core returns `''`, which no author
  means.
- **The held `value-list` arm gets a display-only card** (§4.5), so the card editor's totality
  invariant holds for every stored kind while no step-3 surface offers it.

## What the cutover's dry run counts

Part 09 runs the dry run over every live document at the stack head, with the production step 3
parser, printer and checker, read-only, under the person's standing permission for production reads
(2026-10-17). For this part it counts:

1. each untyped-query read of a custom property: whether it binds to exactly one case type of the
   effective catalog, or to none or several, each of the latter a `target-gate` blocker the author
   resolves in the app before the window (part 09 §11);
2. every stored form-logic text parsed against its target document by the production parser (the
   scans used today's grammar and a scanner's resolver): a parse refusal of any §1.4 code, with
   `relative-unknown`, `wildcard` (which the scans classed in absolute paths only) and
   `unknown-search-input` named, since no scan classed them over every path; each refusal is a
   `target-gate` blocker;
3. `CYCLE` findings over the lifted documents, because relative reads become graph edges, each a
   `target-gate` blocker (part 09 §11);
4. the canonical-print difference per app for the notice, by the production printer (the scans used
   part 04's prototype printer);
5. the `choice` lift per app by the production binder (the scans used a scanner's matcher), and the
   structural many reads lifted to `[1]`, each named in the notice;
6. the step 3 horizon's opaque suffix: `app_changes` accrued after each app's greatest fold
   baseline (none at either scan).

## Executed during planning

Planning probes, run from the repo root with `npx tsx --conditions=react-server` (no network, no
paid call, no Docker):

- **The rename probe**, over `lib/__tests__/docHelpers.ts::buildDoc`,
  `lib/doc/mutations::applyMutations` and `lib/commcare/validator/gate.ts::evaluateCommit` with
  `LOOKUP_CONTEXT_UNAVAILABLE`:
  1. `../a = 'yes'` in a sibling's relevant, then `updateField` renaming `a` to `c`: the gate admits,
     and the expression still prints `../a = 'yes'`.
  2. The same with a second field named `a` elsewhere in the form: admitted.
  3. A single select with inline options and the default `'yes'`, then `updateOption` changing the
     value to `y`: admitted, the default still prints `'yes'`; `removeOption` of that option: admitted.
  4. Every finding after case 1's rename, with a bare `zzz` in a third field: one `INVALID_REF`, for
     `zzz`; none for `../a`.
  5. A bare sibling name, `a = 'yes'` in `b`'s relevant: admitted.
  6. `relevant: ""`: stored as `{"parts":[]}` and admitted.
- **The strict-mode probe**, over `lib/commcare/xpath/expressionAst.ts::parseXPathExpressionWithIssues`
  with `requireBoundNames: true`: `../sib` and `sib` refused; `current()/../sib` and `. > 0` stored
  as one text run; `#form/sib` and `/data/g/sib` stored as `field-ref` and `path-ref`.
- **The wire-schema probe**: `lib/agent/wireSchemas.ts::wireToolSchema` of `askQuestionsInputSchema`
  and of `lib/mcp/tools/uploadMediaAsset.ts::uploadMediaAssetInputSchema`, against
  `z.toJSONSchema(…, { target: "draft-7", io: "input" })`: byte-identical (595 and 1006 bytes).
- **The per-tool hash** (§3.6): every shared tool's
  `authoringToolSchema(name, schema).inputSchema.jsonSchema` hashed at `main` `5cf6e327`: 103 shared
  tools, set hash `331dbe9a23e7`, identical on two runs.
- **A planning scan of the corpus**: 50 relative paths in 25 documents, every one resolving; typeless
  case queries, all in the fuzz sample: 5 with no `@case_type` literal in 5 documents, and 6 with no
  predicate in 5.

On GitHub's runners, without the served readers, on a scratch branch cut from `main` and never
merged: a document of every form spelling step 3 reads, through two HQ form-builder saves (runs
39060796573 and 39061476968, the second clean). It showed that the canonical form-XPath spacing is
Vellum's normal form, so an HQ form-builder save leaves canonical text unchanged (§4.1). With every
reader (run 39064333759, part 08 §6.4) Formplayer, the Web Apps client and Android read it as Core
does.

Two read-only production scans over every live app, content-free (closed labels and counts only),
each in one `REPEATABLE READ, READ ONLY` transaction through `scripts/lib/prodDb.ts::targetProdDb`:
the first run by the person, the second under the person's standing permission for read-only
production reads (2026-10-17). They showed what this part states production holds: the relative-path
classes and that every relative path resolves; the case-database queries' typing classes; the
session reads, all of a selected case; the function names, none outside the registry and no
`jr:itext`, `jr:choice-name` or `here()`; no stored slot that fails to parse; the canonical-print
classes, with no gap in the parenthesis rule; the literals opposite a static select; the structural
many reads; the empty expressions, none in a required slot; the form links, with no manual datum;
no record `div`; and no `app_changes` after the step 2 horizon. As in step 2, no count from
production enters this plan.

Read for this part, with no run: `lib/agent/authoring/reference.ts` (the forms guide's "In
validation, . is the current answer"; the guide's tool names, `getAutomations`),
`lib/commcare/xpath/compatibility.ts::analyzeXPathCompatibility` (which construct each
`XPATH_UNSUPPORTED_*` code covers, for §1.4's "Replaces" column), `lib/agent/tools/generateSchema.ts`
(it serves `lib/agent/planningSchemas.ts::caseTypesOutputSchema`, which holds the catalog
`validation` inputs), `content/docs/building-with-nova.mdx` ("XPath that will run in CommCare"),
`lib/codemirror/CLAUDE.md`, `lib/codemirror/xpath-lint.ts`, `buildLintContext.ts`,
`buildSessionLintContext.ts`, the `useFormLintContext.ts` hooks and their mounts,
`components/builder/BuilderReferenceProvider.tsx` (it calls `buildLintContext(state, formUuid)`
with no slot for `ReferenceProvider`), `components/builder/referenceContextChanged.ts`,
`lib/references/provider.ts` (it reads `reachableCaseTypes`, `userProperties`, `formEntries`,
`formType` and `scope`) and every importer of `xpathValidator.ts` and `xpath-format.ts` (for §4.1,
§6, §7 and §8), `lib/agent/authoring/bindings.ts` (the identity kinds and the `name()` fallback to
a stable address, for §2.3), `components/builder/shared/termEditorModel.ts::termModeLabel` (the
value source labels, for §4.5), and `components/builder/shared/CaseTypePicker.tsx` (the existing
module case-type picker with create-new, used by module settings, the add-module popover and the
case-operation surfaces, so part 06's value picker takes another name), all at `main` `5cf6e327`,
and `../nova-plugin` at
`14af38e` (swept with `grep` for the claims parts 05 §4 and 06 §7 name; none found).
