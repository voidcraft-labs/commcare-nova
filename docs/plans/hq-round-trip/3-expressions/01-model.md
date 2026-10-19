# Step 3, part 01: The typed expression model

Part of [step 3's plan](../3-expressions.md), which holds the baseline, the decisions, the stack and
the exit. This part holds the model itself: the one `Expression` union and every arm of it, the
mapping from every JavaRosa construct to the arm that means it, the canonical print of each arm in
each authoring grammar, the two-axis types, the profile of every stored expression slot, what each
identity does on a rename, move or removal, and the Zod and registry layout with its consequences
for the served tool schemas. Lowering, emission, Preview and Postgres compilation, the authoring
surfaces and the cutover are planned in their own parts; where this part fixes a fact they depend
on, it says so and names what they decide. A construct that leaves step 3 is not removed silently:
it stays in the tables as a **held by step N** row with its reason, and §1.6 collects them.

**Where it lands.** Stack references use the fifteen pull requests by number and name (part 10
holds the stack in full). This part lands in pull request 5, the shape: the union, both grammars
and printers, Zod and profiles, the index and renames, the retired catalog fields (with the
retype gate's requirement arm, §4), and session datum identity (`DatumRef`, `FormLinkDatumName`,
`lib/domain/entryDatumSupplies.ts::entryDatumSupplies`, `unknown-datum` and the other datum parse
refusals, `SESSION_DATUM_NOT_SUPPLIED` over identity) with the `datum` family (§6.3) and the lane
document `targeted-session-reads` (pull request 9 adds its several-case form's `selected_cases`
read), so datum reads have lane evidence from the pull request that changes them. The printer's
`[1]` on a repeat step (`FieldStepFilter`) exists from pull request 5. Five things land elsewhere:

- the projection change of §6.3 and the catalog's three removed tool inputs (§4) land below it, in
  pull request 3, the projection;
- the rest of the form-logic rules land in pull request 6, the checker: `incompatible-values`
  with the reasons `date-datetime`, `datetime-ordering` and `boolean`, `many-values` (structural
  reads only), `here()` outside a row, the `jr:itext` and `jr:choice-name` rules, the target facts
  `format-date-pattern-not-fixed`, `number-of-date` and `datetime-literal-precision` (§1.5), and
  Hidden Value inference with writer agreement (§3.2);
- `day-only-on-device` over `casedb` rows lands with finding 56's lowering in pull request 8, the
  lowering;
- the profile admission of part 05's new instance reads (`cases { source: "search-results" }`,
  lookups in form logic, `locations`, `selected-cases`, `itext`, `choice-name`) lands with their
  declarations in pull request 9, instances and session (part 03 §3.8), with
  `SEARCH_RESULTS_READ_INVALID` and the day rule over results rows;
- `closed-on-not-on-device`, the search-only table of §1.4 and the chosen case in record slots
  (§4, "Chosen case") land in pull request 10, CSQL.

**Citations** are `path::symbol` for Nova at `main` `5cf6e327` and `file::symbol` for CommCare at
the pins `proof/pins.json` names: commcare-core `8e9ba8d908e9` (paths under `src/main/java`),
commcare-hq `d6c6e16d8ae1` (paths relative to `corehq/apps` unless named), Vellum
`01215f251c57`, formplayer `24383ac71bfb`, commcare-android `7a5584475580`. js-xpath, which
Vellum's `package.json` names as `dimagi/js-xpath#v0.0.10`, is cited at that tag. "The research
inventory" is `docs/research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md`.

## Decisions in brief

1. **One stored union, `Expression`, in `lib/domain/expression`.** Every record arm of today's
   `Predicate`, `ValueExpression` and `Term` (`lib/domain/predicate/types.ts`) is an arm of it
   with its stored bytes unchanged; operand slots that held a `Predicate` or a
   `ValueExpression` hold an `Expression`. Form logic, today `XPathExpression` text runs with
   seven leaf kinds (`lib/domain/xpath/ast.ts`), parses into the same union. `lib/domain/predicate`
   and `lib/domain/xpath` are removed in pull request 5, the shape; no re-export shim stays.
2. **Every leaf enters an expression through the `term` arm,** as every record leaf does today.
   Form-logic leaves are new or widened `Term` arms, so a leaf has one representation in every
   slot and every existing record expression keeps its bytes.
3. **The parser maps by shape, never by idiom.** A JavaRosa spelling maps to the one arm whose
   canonical form-XPath print is that spelling. Two spellings that mean the same value on a
   device but differ in shape (`x div y` and `quotient(x, y)` aside) stay two shapes; the parser
   does not recognise an equivalent idiom and canonical print never rewrites one into the other.
4. **`call` holds only the 60 JavaRosa functions no arm means,** plus Nova's lowered
   `normalize-space`. Sixteen function names map to record arms (§2.1); `true()` and `false()` are
   `match-all` / `match-none` in form logic and in record condition positions, and the literals
   `true` / `false` in record value positions.
5. **`arith` `div` means XPath's real division everywhere.** Integer division, which a record
   `div` over two integers means today, becomes the new operator `quotient` (§1.4). Production
   holds no record `div`, so the cutover's lift meets none.
6. **A type at every node on two axes:** the data type (Nova's lattice plus `boolean` and
   `nodes<T, cardinality>`) and the representation Core holds at run time (`boolean`, `number`,
   `string`, `date`, or a node-set and what its nodes unpack to). A Hidden Value's data type is
   inferred from its value expression; a Hidden Value that writes a case property takes its
   destination's type where the expression agrees or is unknown. Inference reads an untyped
   property as unknown, never as `text`. Its held representation follows its emitted bind, and the
   bind keeps today's rule, `fieldValueType`'s writer destination (part 04, decision 13). A case
   row's held system dates follow the row's instance root, which the row stack carries (§3.2).
7. **One checker, two rule sets chosen by the slot's profile.** Record slots keep today's rules
   exactly (`lib/domain/predicate/typeChecker.ts::typesCompatible`, `ORDERED_TYPES`, the
   per-arm rules) and keep today's condition and value positions as a rule (`record-position`), so
   `true()` and `false()` print by position. Form-logic slots take Core's coercions and refuse only
   what Core refuses or what can never be right (§1.5), including a date and time ordered against
   an operand known not to be one.
8. **Every stored slot has one profile** (admitted arms, scope, evaluation targets, authoring
   family). The profiles are code in `lib/domain/expression/profiles.ts`, not Zod variants.
9. **Identity leaves for every reference.** Fields by UUID with the author's spelling kept;
   case properties and case types by name (sanctioned); session datums by what supplies them
   (five kinds; a form link's datum name is a `selected-case` only); lookup tables, columns, worker
   properties, search inputs, location levels and properties, static choice options and
   translation units by UUID; relation identifiers by name. A `casedb` query's row type comes from
   a `@case_type` literal, else a `@case_id` of known `caseIdOf`; with neither, a custom property
   read binds to the one case type of the effective catalog that declares it and stores it, and
   attributes and standard properties read with no stored type (§1.3). A `search-results` row is
   the searched case type.
10. **Form-logic text keeps CommCare's spellings** for case queries, session reads, lookup
    and location reads (`instance('casedb')/casedb/case[...]`), and gains no Nova spelling for
    them. The typed tree carries identity, so the spelling no longer limits renames. A lookup
    root prints per target: the bare tag in XForm slots, `item-list:<tag>` in suite and
    form-link slots (§2.3). Record-dialect prints stay today's (`user('<slug>')`), and the record
    dialect gains no CommCare vocabulary such as `datum(…)`. From pull request 10 it reads a case
    chosen in an earlier menu in Nova's vocabulary, `chosen-case('<menu name>')` for its id and
    `chosen-case-property('<menu name>', '<property>')` for a property, in the record slots
    evaluated after that menu's datum is supplied (§4, "Chosen case").
11. **The catalog's `required` / `validation` (and `validation_msg`) XPath slots retire**:
    decided with the person (2026-10-17). The cutover removes stored values and the notice names
    each; `generateSchema` and `updateCaseProperty` lose the inputs in pull request 3, the
    projection, and the stored fields leave in pull request 5, the shape, with the retype gate's
    requirement arm, since no catalog property is required any more (§4).
12. **The served tool schemas change once.** Executed during planning: keeping the family names,
    descriptions and the registry ids `Predicate` / `ValueExpression` does not keep the served
    bytes, because the positional `__schemaN` definition names count the reused nodes inside the
    canonical subtree. From step 3 the authoring projection replaces each family position before
    Zod walks it (pull request 3, the projection), so the canonical model never moves served
    bytes again. `MODEL_CONTEXT_VERSION` moves in each pull request that changes model-facing
    schema or prose: pull requests 3, the projection, 5, the shape, 9, instances and session, 10,
    CSQL, and 12, authoring (part 02 §3.3; part 10's checklist item 13), and the billed
    `npm run test:schema` over the changed tools is asked once, at the stack head. The changed
    set is found by hashing every tool's served schema at base and head (part 02 §3.6), not by a
    snapshot.
13. **Absence is the only empty spelling.** The union has no empty expression; a slot with no
    expression is absent. The cutover lifts today's `{ parts: [] }` to absence where the slot is
    optional and states each slot where it is not (§4, "Required slots and absence").
14. **Step 3's union holds what step 3 can author and Preview can show truthfully.** Held by later
    steps, each with its reason (§1.6): `project-day` (step 6), `groups` / `group-field` (step 7,
    group 2), the `device-query` datum kind (step 4), search inputs read in an inline-search
    module's ordinary forms (step 4), and the authoring of the session context fields `drift`,
    `window_width`, `applanguage` (step 4; the stored enum holds all seven). Search results read
    in the forms of an inline-search module stay in step 3 (`cases.source: "search-results"`).
15. **Integral functions are `int`.** The calls `int`, `round`, `floor`,
    `ceiling`, `string-length`, `count-selected` and `position`, like the `count` arm, return
    `int`, because Core stores an integral `Double` as `IntegerData`. **Implementation correction,
    2026-10-19:** Core's `round` has one argument (`XPathRoundFunc`'s `EXPECTED_ARG_COUNT`), so
    "(one argument)" named no other form; `index-of` is not integral: `XPathIndexOfFunc.java::evalBody` returns `''` when nothing matches, so its result is text or a number by data.
16. **`many-values` is structural only.** A node-set used as one value is refused only where its
    plurality is the app's shape: a repeat's answer read from outside that repeat, and a
    several-case module's `selected-cases`. A `cases`, `table-rows` or `locations` query used as
    one value is admitted, since only its data decides how many rows match.
17. **Canonical form XPath is Vellum's normal form** (executed during planning, GitHub Actions run
    39061476968): one space after every comma and either side of every binary operator, a
    same-precedence right operand parenthesised unless both are the same `and` or `or`, and numbers
    in shortest round-trip form, so an HQ form-builder save leaves canonical text byte-identical
    (§2.5). A number below 0.000001 is the one exception, and Nova records it and refuses nothing.

---

## 1. The `Expression` union

### 1.1 Shape principles

- **One union, many slots.** `expressionSchema` is the one recursive Zod union. A slot stores an
  `Expression`; what a slot admits is its profile (§4), checked by the checker, never by a
  narrower Zod schema. Today's predicate slots already work this way: every one stores
  `predicateSchema` and the validator owns contextual legality
  (`lib/domain/CLAUDE.md`, "Modules and forms each carry an optional typed `displayCondition`").
- **Boolean-ness is a type, not a family.** Today's split between `Predicate` and
  `ValueExpression` becomes the data type `boolean`. A slot that wants a condition requires the
  `boolean` type (with the coercion rule of its profile); `and.clauses`, `not.clause`,
  `if.cond`, `exists.where`, `count.where` and `table-lookup.where` hold any `Expression` typed
  `boolean`. The record rule set still keeps today's condition and value positions as a rule
  (`record-position`, §3.4; part 02 §2.2), because the record dialect's round-trip law rests on
  them; the Zod schema does not.
- **Leaves under `term`.** `{ kind: "term", term: Term }` stays the one way a leaf enters. Arms
  that hold a leaf directly keep doing so (`within-distance.property: PropertyRef`,
  `when-input-present.input: SearchInputRef`, `in.values: Literal[]`, `switch.cases[].when`).
- **A literal is stored one way per position.** Where a position widens from a bare literal to
  "literal or computed value", the literal stays bare and the computed value is an
  `Expression`; a refinement refuses an `Expression` that is a `term` holding a literal there
  ("Write a literal value directly"). This keeps today's bytes and one representation.
- **Row scope is lexical.** A row leaf (`prop`, `case-index`, `case-row-type`, `table-column`,
  `location-field`) reads the row of the nearest enclosing row-scoped construct:
  the case list's row in a list slot, the candidate in a case-choice filter, the row of a
  `cases`, `table-rows` or `locations` predicate, the table row in `table-lookup.where`.
  A row leaf with no row in scope is a checker finding (`row-scope`), never a separate arm.
  Each row on the stack carries its instance root (`casedb`, `results:inline`, a table, the
  locations, the form's repeat), because the held class of a case row's system dates depends on it
  (§3.2; part 03 §1.3's `RowScope.root`).
  (`group-field` and the `groups` row are held by step 7, group 2; §1.6.)
- **Absence is the only empty spelling.** No arm means "no expression": a slot with
  nothing in it is absent (an optional slot's `null` clear, `lib/doc/CLAUDE.md`, "Clearing an
  optional slot uses an explicit `null`"). Empty or whitespace text parses to absence. Readers
  that test emptiness today (`lib/doc/formLinkMutations.ts::formLinkIsConditionalIn`, "prints to
  non-empty XPath"; `lib/commcare/CLAUDE.md`, "A condition that prints to empty XPath is
  unconditional") test presence from step 3.

### 1.2 Supporting shapes

```ts
type Uuid = string;                         // lib/domain/uuid.ts
type CaseTypeName = string;                 // CASE_TYPE_PATTERN, unchanged
type DataType = CasePropertyDataType;       // text int decimal date time datetime single_select multi_select geopoint

// Where a field read stands in the slot's own text. Absent = `#form/…` (hashtag), so every
// record `field { uuid }` and every lifted XPath `field-ref` keeps its bytes.
type FieldSpelling = "absolute" | "relative" | "current";

// A predicate on one step of a field path: `/data/rep[2]/x`, `#form/rep[age > 5]/name`.
type FieldStepFilter = { step: Uuid; where: [Expression, ...Expression[]] };

// What supplies a session datum. Printed through the entry's derived datum id (§5).
// Five kinds in step 3; `device-query` (stringquery, fingerprintquery) is held by step 4 (§1.6).
// The trailing note is each kind's `caseIdOf` (§3.1; part 05 §1.3's column).
type DatumRef =
  | { kind: "selected-case"; module: Uuid }            // case_id, case_id_<type>, parent selections; caseIdOf: module's case type
  | { kind: "new-case" }                               // newCaseIdDatumId(<module type>): the datum the case block reads; caseIdOf: the module's case type
  | { kind: "new-child-case"; caseType: CaseTypeName } // subcaseSessionDatumId: a non-repeat child bucket's datum; caseIdOf: caseType
  | { kind: "worker-record" }                          // usercase_id; caseIdOf: commcare-user (USERCASE_CASE_TYPE)
  | { kind: "tile-group-parents"; module: Uuid };      // <case datum>_parent_ids; caseIdOf: none (a space-separated list of ids)

// A form link's datum name: the target entry's selected case only (part 05 §1.5), so a link never
// hands a target's create or function datum an id of the source's choosing.
type FormLinkDatumName = { kind: "selected-case"; module: Uuid };

// The translation unit `jr:itext('<id>')` names: owner identity plus slot.
type ItextUnit =
  | { field: Uuid; role: "field-label" | "field-hint" | "field-help" | "field-validation-message" }
  | { field: Uuid; option: Uuid; role: "select-option-label" };

// One value of a flat location row (HQ `locations/fixtures.py::FlatLocationSerializer`).
type LocationRowField =
  | "id" | "type" | "name" | "site_code" | "external_id" | "latitude" | "longitude"
  | { level: Uuid }        // @<level code>_id lineage attribute
  | { property: Uuid };    // location_data/<property slug>

type SessionContextField =                       // all seven of Core's, stored
  "deviceid" | "appversion" | "username" | "userid" | "drift" | "window_width" | "applanguage";
```

`SessionContextField` is the closed set `lib/commcare/sessionContext.ts::COMMCARE_SESSION_CONTEXT_FIELDS`
already holds, which Core writes in `org/commcare/session/SessionInstanceBuilder.java::addMetadata`.
Today's `SESSION_CONTEXT_FIELDS` narrows it to four by an authoring choice
(`lib/domain/predicate/types.ts::SESSION_CONTEXT_FIELDS` docblock); from step 3 the **stored**
enum is the seven, so the parser reads all seven and an imported or lifted read of any is
representable. The **authoring** of `drift`, `window_width` and `applanguage` is held by
step 4, because their values differ per platform (the research inventory, "Secondary instances"):
the builder's session list shows the seven read-only and offers today's four (part 02 §4.5), and
their manifest entries stay HELD-NEW (part 05 §3).

`DatumRef` prints through the entry's derived datum id, and for `new-case` and `new-child-case`
that id is the datum the case block reads (`lib/commcare/session.ts::newCaseIdDatumId`,
`lib/commcare/subcaseWire.ts::subcaseSessionDatumId`), which under root-menu alignment is the datum
copied from the root, not the form's own renamed datum (part 05 §1.3).
Which `DatumRef`s an entry supplies is domain knowledge:
`lib/domain/entryDatumSupplies.ts::entryDatumSupplies` (new, part 05 §1.3) computes it from the
session structure the domain already holds and is passed into `ExpressionContext` (§3.5), so the
builder and the checker read it without reaching `lib/commcare`. The datum id each ref prints as
stays in `lib/commcare/formLinkProjection.ts`, which hands the printer its resolver (part 05 §1.4).
The two together are the one projection between datum id and ref. A form link names only a
selected case (`FormLinkDatumName`), not
any `DatumRef` of the target entry, so a link never hands a target's create an id of the source's
choosing.

### 1.3 Leaves: `Term`

Kept arms are unchanged unless the "Change" column names a widening. Every widening admits every
value stored today, so no kept leaf is lifted.

| Arm | Shape | Change from step 3 | Means |
|---|---|---|---|
| `literal` | `{ value: string \| number \| boolean \| null; data_type?: DataType }` | none | a constant; the `null` literal is the `_any` type |
| `prop` | `{ caseType?; property; via?: RelationPath }` | `caseType` optional, absent only on a standard property read in an untyped `casedb` row (below); now also the row of a `cases` query | a property (or standard property, `case_id`/`owner_id`/`status` printed as attributes) of the row in scope, or of a case reached from it along `via` |
| `form-case` | `{ caseType; property }` | none; now also the form-logic `#<type>/<prop>` read | a property of the form's loaded case or a readable ancestor |
| `input` | `{ searchInputUuid }` | none; now also the form-logic `#search/<name>` read | a Search answer |
| `session-user` | `{ field; source?: "worker-record" }` | `source` added | a CommCare-provided or external worker field; absent `source` reads session user data, `"worker-record"` the worker's own case |
| `session-user-property` | `{ userPropertyUuid; source?: "worker-record" }` | `source` added | a Nova worker property, the same two sources |
| `session-context` | `{ field: SessionContextField }` | stored enum widened to seven; authoring of `drift`, `window_width`, `applanguage` held by step 4 | `session/context/<field>` |
| `field` | `{ uuid; spelling?: FieldSpelling; climb?: Uuid; filters?: FieldStepFilter[] }` | `spelling`, `climb`, `filters` added | a form answer (or container node), as the author spelled the path |
| `table-column` | `{ tableId; columnId }` | none | a lookup column of the table row in scope |
| `fixed-location` | `{ locationUuid }` | none | one place (owner slots only) |
| `owner-location-at-level` | `{ levelUuid; ownerCaseType }` | none | the owner's place at a level (owner slots only) |
| **`choice`** | `{ field: Uuid; options: [Uuid, ...Uuid[]] }` | new | one or more static options of a select, printed as their current value (space-joined for several) |
| **`case-type`** | `{ caseType }` | new | a case type named as a value (`'visit'` opposite `@case_type`) |
| **`case-row-type`** | `{}` | new | `@case_type` of the row in scope |
| **`case-index`** | `{ caseType?; identifier }` | new; `caseType` absent only in an untyped `casedb` row (below) | `index/<identifier>` of the case row in scope: the related case's id, present even when that case is not on the device |
| **`session-datum`** | `{ datum: DatumRef }` | new; from pull request 10 also a `selected-case` read in the record slots of §4's "Chosen case" | `session/data/<derived id>` |
| **`repeat-row`** | `{ repeat: Uuid; attribute: "id" \| "index"; spelling?: FieldSpelling }` | new | a query-bound repeat iteration's `@id` (the row's case id) or `@index` |
| **`location-level`** | `{ levelUuid }` | new | a level named as a value (`'district'` opposite `@type`) |
| **`location-field`** | `{ field: LocationRowField }` | new | a value of the location row in scope |
| `group-field` | none | **held by step 7, group 2** (§1.6): not in step 3's union | a value of the case-sharing group row in scope |

**A `casedb` query's row type.** `prop.caseType` is stored, so a row leaf inside
`cases { source: "casedb" }` needs its type before the parser builds it. It comes from, in order:

1. a predicate `@case_type = '<type>'` (either side), which also makes `'<type>'` a `case-type`
   leaf;
2. else a predicate `@case_id = <e>` whose `e` has a known `caseIdOf T` (§3.1: a session datum of
   a kind that has one, `form-case case_id`, `case-index`, `repeat-row id`, `id-of`, a cases-sourced
   select's answer), which types the row `T`;
3. else the row is **untyped**. In it `@case_id`, `@case_type`, `@status`, `@owner_id`,
   `index/<identifier>` and the standard properties every case holds
   (`lib/domain/standardCaseProperties.ts::STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`) are readable,
   since every case type holds them. A custom property read binds to the one case type of the
   effective catalog (`lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes`) that declares that
   property, and the parser stores that type on the `prop`; each custom read binds on its own.
   Where no type or several types declare it, the read is refused at parse
   (`case-query-untyped`, part 02 §1.4): "You can add `[@case_type = '<type>']` so CommCare knows which
   records to read." A query whose predicates read no row value
   (`count(instance('casedb')/casedb/case)`) stays admitted.

**The stored shape of an untyped row.** A standard property read and a `case-index` in an untyped
row store no `caseType`: `prop { property: "case_name" }`, `case-index { identifier: "parent" }`.
Absence is the honest value, because no predicate names a type, no catalog fact gives one, and
every type holds the read. A Zod refinement admits an absent `caseType` on `prop` only when
`property` is a standard property name; the checker admits it only in the row of an untyped
`cases { source: "casedb" }` query, and anywhere else it is `row-scope`. In a typed row every leaf
stores its row's type, as today. The leaf prints the same either way (`case_name`, `index/parent`).
**Index edges:** an absent-type standard read has no `(caseType, property)` edge and no case-type
edge: a standard property is never renamed and belongs to every type, and case-type retirement
(`lib/doc/caseTypeRetirement.ts`) counts only reads that name the type. An absent-type
`case-index` reads its relation identifier name-backed, as every identifier is (§5), and its
`caseIdOf` is unknown, since no relation hint gives the destination. A bound custom read stores its
type and has the ordinary `(caseType, property)` edge, so a rename of that property on that type
reaches it and the rename review counts it (§5).

**The read-back binding hint.** The stored tree holds the bound case type and the printer prints no
predicate, so Core reads exactly what the author wrote. A later second declaration of the property
would make that text ambiguous under rule 3, so a re-parse of an edited slot takes the slot's
current tree as its binding hint (`FormParseScope.current`, part 02 §1.2): an untyped read of `p`
that the current tree binds to `T` keeps `T` while `T` declares `p`. New text with no hint (a new
slot, an empty slot, the cutover's lift) binds by rule 3. An SA or MCP read sent back unchanged, a
builder save of untouched text and an edit elsewhere in the expression each store the tree they
read, so the read/edit law holds whatever the catalog declares later. Part 02 §1.3 holds the
matching rule (one `T` per property in the hint).

**What production holds** (two read-only production scans, executed during planning). Most `casedb`
queries are typed by a `@case_type` literal, and many by a `@case_id` from a known source (a
cases-sourced select's answer, a query-bound repeat's row id, the selected-case datum). Some, in a
few apps, are untyped and read a row value (the case id from a Hidden Value, `selected-at`, a nested
`casedb` read, a relative path). The cutover probe's reading of those reads (part 09, "Executed
during planning", with the shape scanner's catalog index) finds standard property reads, which take
the absent-type shape; custom reads that bind to one case type; custom reads that several types
declare, each a `case-query-untyped` blocker the author resolves before the window; and none that no
type declares. The cutover's dry run replaces the probe's reading with the production binder's
(part 02, "What remains for the cutover's dry run"). The lane's corpus holds both untyped shapes: a
predicate with no `@case_type` literal (5 in 5 documents) and a query with no predicate (6 in 5),
all fuzz.

**A `search-results` row** is typed by the searched case type of the module whose inline query the
evaluating entry carries (`EntryDatumSupplies.searchResults.module`, part 05 §1.3), never by the three
rules above: HQ's primary results are open cases of the requested type only
(`case_search/utils.py::CaseSearchQueryBuilder._get_initial_search_es`, `.case_type`,
`.is_closed(False)`), and the arm's print always excludes the related cases HQ appends (§2.4).
Every row leaf in it stores that type. A `@case_type` predicate naming another type is the finding
`search-results-other-type` (`SEARCH_RESULTS_READ_INVALID`, `details.reason` `other-type`): "This
search only finds <type> cases, so no result is a <other> case." Part 05 §2.8 and part 07 §3.2 plan
the instance and Preview's supply.

`field.spelling` and `field.climb` are the only stored spelling in the model, because they carry
meaning: inside a repeat a relative read means the same iteration, and a path that climbs above
the lowest common ancestor through a repeat (`../../rep/x` from inside `rep`) reads every
iteration where `../x` reads one. `climb` is present only in that case; otherwise canonical print
derives the shortest path through the lowest common ancestor (§2.6). `absolute` and the hashtag
spelling mean the same node (Core contextualises an absolute reference against the context node,
`org/javarosa/xpath/expr/XPathPathExpr.java::evalRaw`), and the author's choice is kept as part of
the node.

`session-user` / `session-user-property` gain `source` because the two runtime sources differ:
in form logic `#user/<p>` reads the worker's own case through `casedb`
(HQ `app_manager/app_schemas/casedb_schema.py::get_casedb_schema`; `lib/domain/CLAUDE.md`,
"`#user/` resolves against `casedb` on the wire"), while
`instance('commcaresession')/session/user/data/<p>` reads session user data
(`SessionInstanceBuilder.java::addUserProperties`). Absent `source` is the session, which
every record node holds today; a lifted form-logic `user-property-ref` / `user-ref` takes
`"worker-record"`.

### 1.4 Arms: `Expression`

Kept record arms, with each operand slot as it stands from step 3 (`E` is `Expression`):

| Arm | Shape | Change from step 3 |
|---|---|---|
| `term` | `{ term: Term }` | none |
| `today`, `now` | `{}` | none |
| `id-of` | `{ opUuid }` | none |
| `acting-user`, `unowned` | `{}` | none |
| `table-lookup` | `{ tableId; resultColumnId; where: E }` | `where` widened to `E` (boolean) |
| `date-add` | `{ date: E; interval: DateAddInterval; quantity: E }` | none |
| `date-coerce`, `datetime-coerce` | `{ value: E }` | none in shape; numeric operands admitted (epoch days, the CSQL construct `date(<int>)` / `datetime(<number>)`, and Core's `toDate(Double)`) |
| `double` | `{ value: E }` | none; of a date or date and time refused in a profile with a Postgres target (`number-of-date`, part 07 §5.1) |
| `arith` | `{ op: "+" \| "-" \| "*" \| "div" \| "mod" \| "quotient"; left: E; right: E }` | `quotient` added; `div` is real division |
| `concat` | `{ parts: [E, ...E[]] }` | none |
| `coalesce` | `{ values: [E, ...E[]] }` | none |
| `if` | `{ cond: E; then: E; else: E }` | `cond` widened to `E` (boolean) |
| `switch` | `{ on: E; cases: [{ when: Literal \| Choice; then: E }, ...]; fallback: E }` | `when` admits `choice` |
| `count` | `{ via: RelationPath \| E; where?: E }` | `via` admits a node-set `E`; `where` only with a `RelationPath` |
| `format-date` | `{ date: E; pattern: FormatDatePreset \| string \| E }` | a computed pattern admitted, except in a profile with a Postgres target (`format-date-pattern-not-fixed`, part 07 §5.1) |
| `eq` `neq` `gt` `gte` `lt` `lte` | `{ left: E; right: E }` | none in shape |
| `in` | `{ left: E; values: [Literal \| Choice, ...] }` | `values` admits `choice` |
| `within-distance` | `{ property: PropertyRef; center: E; distance: number \| E; unit: DistanceUnit \| E }` | runtime distance and unit; `DistanceUnit` widened to HQ's nine (HQ `es/queries.py::DISTANCE_UNITS`) |
| `match` | `{ property: E; value: E; mode: MatchMode }` | `property` widened from `PropertyRef` to `E` |
| `multi-select-contains` | `{ property: E; values: [Literal \| Choice \| E, ...]; quantifier }` | `property` widened; runtime values admitted |
| `match-all`, `match-none` | `{}` | none |
| `is-blank` | `{ left: E }` | none |
| `matches-pattern` | `{ left: E; pattern: string \| E }` | a computed pattern admitted |
| `between` | `{ left: E; lower?: E; upper?: E; lowerInclusive; upperInclusive }` | none |
| `and`, `or` | `{ clauses: [E, ...E[]] }` | clauses widened to `E` (boolean) |
| `not` | `{ clause: E }` | widened to `E` |
| `when-input-present` | `{ input: SearchInputRef; clause: E }` | widened to `E` |
| `exists`, `missing` | `{ via: RelationPath; where?: E }` | `where` widened to `E` |

New arms:

| Arm | Shape | Means |
|---|---|---|
| `negate` | `{ value: E }` | unary minus on a non-literal (`-x`); `-5` stays the literal `-5` |
| `call` | `{ fn: CallFunction; args: E[] }` | one of the 61 functions in §2.1 marked `call`; arity from `FUNCTION_REGISTRY` |
| `cases` | `{ source: "casedb" \| "search-results"; where: E[] }` | the node-set of case rows, one `E` per predicate step; `"search-results"` reads the cases the inline search found, admitted where the evaluating entry carries the inline query, a search-first module's menu forms (part 05 §2.8). Its `where` never holds the related-case exclusion, which is the print's own (§2.4) |
| `table-rows` | `{ tableId; where: E[] }` | the node-set of a lookup table's rows |
| `groups` | none | **held by step 7, group 2** (§1.6): the worker's case-sharing groups (`instance('groups')`) |
| `locations` | `{ where: E[] }` | the flat location rows (`instance('locations')`) |
| `selected-cases` | `{ module: Uuid }` | `instance('<multi-select datum id>')/results/value`, the ids a module's multiple selection chose; several by declaration, so `many-values` refuses it as one value (§3.4) |
| `project` | `{ of: E; value: Term }` | the node-set of one row value over a row node-set (`…/case[...]/name`, `…/@case_id`, `…/index/parent`, `…/<col>`, `…/@id`); a `prop` over the `casedb` row keyed on a `selected-case` datum is the chosen case's property, the one `project` shape record slots admit (§4, "Chosen case") |
| `itext` | `{ unit: ItextUnit }` | `jr:itext('<itext id>')` |
| `choice-name` | `{ field: Uuid; value: E }` | `jr:choice-name(<value>, '<path of field>')` |
| `here` | `{}` | `here()`, the viewer's location in a row context; Preview binds the browser's location into the Postgres read of a calculated column, which reads `''` until a position arrives (part 07 §3.4) |
| `project-day` | none | **held by step 6** (§1.6, decided with the person): not in step 3's union. A date compared as the project-timezone day (the CSQL construct on `date_opened`, `closed_on`, `last_modified`) |
| `value-list` | `{ items: [E, ...E[]] }` | `unwrap-list('[…]')`, a list value in CSQL; CSQL only. An item is a scalar of the item type or a node-set of it (`{ nodes: T, many }`), flattened into the list (part 06 §3.6's `join`), so `many-values` never reads an item. Held for import: representable, emitted, compiled and proven, and authored by no step (§7, "Nova does not author HQ's escape hatches"); a fixed list is authored as `in`, step 6's import reads a runtime one, and the builder renders a stored one with a display-only card (part 02 §4.5) |

`project.value` must be a row leaf readable as one relative step from the row (`prop`,
`case-row-type`, `case-index`, `table-column`, `location-field`); any other `Term`
is a schema refinement failure. `count.where` with a node-set `via` is refused by refinement:
an XPath predicate belongs in the node-set's own `where`.

**`div` and `quotient`.** Today a record `div` over two integers truncates (`lib/domain/CLAUDE.md`,
"Typed ValueExpression arithmetic"), while XPath `div` and the record grammar's authored `div`
(`lib/agent/authoring/queryExpressions.ts`, which inserts `double`) are real division: one operator,
two meanings. From step 3 `div` is real division everywhere and Postgres compiles it so. The
cutover lifts each record `div` whose operands resolve to `int` and `int` to `quotient` (same
emission, the remainder lowering in `lib/commcare/expression/onDeviceEmitter.ts`) and strips the
`double` the record grammar inserted under a real `div`, so the read-back is `(a div b)`. The rule
is the model's whatever production holds; production holds no record `div`, so the lift meets none.

The typed CSQL part owns the lowering of `value-list`, `case-type`, `case-row-type`, `today` in a
CSQL position, runtime `distance`/`unit`, runtime `multi-select-contains` values, `if` / `switch`
in a query position (part 06 §3.10) and the numeric operands of the coercions; this part only gives
them arms, so the outline's CSQL concept list (`docs/plans/hq-round-trip/3-expressions.md`, item 2)
is representable except project-timezone days, which step 6 holds. CSQL `today()` is the worker's
day everywhere (decided with the person, 2026-10-17): the `today` arm needs no new arm or flag, and
the CSQL emitter writes it as Core's `today()` in a runtime segment (part 06 §3.4); production holds
no search that reads `today()`, so no published search's bytes change for it.
`closed_on` is not an arm and not an entry of the effective catalog (part 06 §3.1): it is a
search-only system property, `datetime`, in a separate table
`lib/domain/standardCaseProperties.ts::SEARCH_ONLY_CASE_PROPERTY_DATA_TYPES` (new, pull request 10),
which the checker reads only for a slot whose targets exclude SU and XF. Putting it in
`STANDARD_CASE_LIST_PROPERTY_DATA_TYPES` would make every surface the effective catalog feeds offer
a value no device holds.

### 1.5 What is refused, and how

A construct the union cannot hold is **unrepresentable**: the parser refuses it with an
`AuthoringInputError` (SA and MCP) or a parse issue (builder), and no document can contain it. A
construct the union holds but a slot's profile or the type rules refuse is a **checker finding**:
the commit gate refuses the batch that introduces it, on every editor alike.

| Construct | Class | Source |
|---|---|---|
| union `a \| b` | unrepresentable | `org/javarosa/xpath/expr/XPathUnionExpr.java` throws "nodeset union operation" |
| filter expression on a root other than `instance()` / `current()` (`(x)[1]`, `f()[1]`) | unrepresentable | `XPathPathExpr.java::getReference` throws "filter expression" |
| `//`, and any axis but child name, `attribute::` name, `self::node()`, `parent::node()` | unrepresentable | `getReference`, "step other than 'child::name', '.', '..'" |
| `..` after a named step (`/data/a/../b`, `instance('x')/..`) | unrepresentable | `getReference`, `parentsAllowed` false after a name or `instance()` |
| a wildcard step `*` | unrepresentable (§7) | Core admits it (`getReference`, `TEST_NAME_WILDCARD`); it names no identity |
| `$var` | unrepresentable | the research inventory's `$var` row: form contexts define no variables |
| a function name outside the 76, Nova's two lowered names, `jr:itext`, `jr:choice-name`, `here` | unrepresentable | `org/javarosa/xpath/expr/XPathCustomRuntimeFunc.java::evalBody` throws at evaluation |
| an `instance()` id outside `casedb`, `commcaresession`, a lookup tag (bare or `item-list:`), `locations`, `results`, `results:inline`, `search-input:results`, `search-input:results:inline`, a selected-cases datum id | unrepresentable | the research inventory's REFUSED instance rows (`ledgerdb`, `commtrack:*`, `schedule:*`, `indicators:*`, reports, `registry`, `case-search-fixture:*`, legacy `search-input`, inline instances) |
| `instance('groups')` | unrepresentable in step 3, **held by step 7, group 2** | §1.6; parse copy in part 05 §2.6 |
| `session/data/stringquery`, `session/data/fingerprintquery` | unrepresentable in step 3, **held by step 4** | §1.6 |
| an empty expression (empty or whitespace text, a stored `{ parts: [] }`) | unrepresentable: it is absence | a required slot refuses absence with its existing message (§4, "Required slots and absence") |
| a custom property read in an untyped `casedb` query that no case type, or more than one, declares | parse refusal `case-query-untyped` | §1.3 (attributes and standard properties stay readable) |
| `instance('results:inline')/results/case[…]` whose first predicate is not `not(commcare_is_related_case = true())` | parse refusal `search-results-unexcluded` | part 05 §2.8: the related cases HQ appends depend on HQ's reading of the app's details |
| `instance('results')`, the remote search's instance | parse refusal `search-results-remote` | the research inventory's REFUSED row: the `<rewind>` drops the step that carries it (part 05 §2.8) |
| `instance()` with a non-literal argument | unrepresentable | `getReference` requires one string literal |
| the form root `/data` alone | unrepresentable | finding 71 (`lib/preview/xpath/dependencies.ts::formRootReadPositions`) |
| a path step after a row value (`…/case[...]/index/parent/@case_type`), attributes other than `case_id`, `case_type`, `owner_id`, `status` on a case row | unrepresentable (§7) | no identity; Core holds them (`org/commcare/cases/instance/CaseChildElement.java::buildAndCacheInternalTree`) |
| the query-repeat wrapper attributes `@ids`, `@count`, `@current_index` | unrepresentable | generated scaffolding (`lib/commcare/CLAUDE.md`, "Repeat modes") |
| `here()` outside a case-list row or detail context | checker finding | no form-context handler: Core's abstract `org/javarosa/core/model/condition/HereFunctionHandler.java` is implemented by Formplayer's `FormplayerHereFunctionHandler` and Android's `AndroidHereFunctionHandler`, registered only in menu, list and detail contexts |
| `jr:choice-name` on a field whose choices are a lookup or cases source | checker finding | "error in evaluation of xpath function [choice-name]" on both runtimes (the research inventory) |
| `<`, `<=`, `>`, `>=` with a time on either side | checker finding `time-ordering` | `org/javarosa/xpath/expr/FunctionUtils.java::toNumeric` makes a time NaN; step 2's two refusals become this one rule |
| a date against a datetime without an explicit coercion | checker finding `incompatible-values` (`details.reason: "date-datetime"`) | the outline, finding 56's fourth requirement; record slots refuse it today |
| in form logic, a datetime ordered against an operand known not to be a datetime (a number, text, a select, a `boolean`) | checker finding `incompatible-values` (`details.reason: "datetime-ordering"`) | part 03 §3.2: finding 56's lowering is defined only for an instant against an instant, and `now() > 20000` orders days; record slots refuse it today (`typesCompatible`) |
| a node-set that holds several nodes by the app's shape, used where one value is needed: a `field` or `repeat-row` read crossing a repeat the context node is not inside, or `selected-cases` | checker finding `many-values` (`XPATH_MANY_VALUES`) | `org/javarosa/xpath/XPathNodeset.java::unpack` throws on more than one node; §3.4 rule 4 (structural only); a `cases`, `table-rows` or `locations` query used as one value is admitted, and a `value-list` item is exempt (part 06 §3.6) |
| a `casedb` system date (`date_opened`, `last_modified`, or a `form-case` read of either) or a `search-results` row's `date_opened`, against a `datetime` operand: ordered against one that is not day-aligned, or under `=` / `!=` against any, day-aligned included, in a slot whose targets include XF or SU (against a `date` operand it is `date-datetime`, the row above) | checker finding `incompatible-values`, reason `day-only-on-device` (record slots their `*_TYPE_ERROR`) | part 04 §3.4, part 03 §3.10: Core holds the casedb pair as `DateData` (`CaseChildElement.java::buildAndCacheInternalTree`) and HQ writes a result's `date_opened` as the UTC day (`casexml/apps/case/xml/generator.py::V2CaseXMLGenerator.add_custom_properties`, `date_to_xml_string`) |
| `jr:itext` of a unit, or `jr:choice-name` of an option, whose text in any language holds a reference | checker finding `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, reason `itext-reference` | part 07 §3.3: Core returns its `${n}` placeholder, never the value |
| a computed `format-date` pattern, or a record `number()` of a date or date and time, in a profile with a Postgres target | checker findings `format-date-pattern-not-fixed`, `number-of-date`, from pull request 6, the checker | part 07 §5.1, part 03 §3.10: Postgres compiles neither; form logic keeps both |
| a CSQL date-and-time literal finer than milliseconds | checker finding `datetime-literal-precision`, from pull request 6, the checker | part 06 §3.13: the closed instant range is millisecond-exact |
| a boolean arm in a record value position, or a value arm in a record condition position | checker finding `record-position` (record rule set only) | part 02 §2.2: the record dialect has no spelling for either (`concat((a = b))` is refused by `queryExpressions.ts::compiler`'s `value()`), so admitting it would break `parse(print(e)) = e` |
| `input` (`#search/…`, `search-input:*`) outside a no-matches form | checker finding (`INVALID_SEARCH_REF`, unchanged) | the research inventory's REFUSED rows: the `<rewind>` drops the step that carries them; in an inline-search module's ordinary forms the read is **held by step 4** (§1.6) |
| `cases { source: "search-results" }` where the evaluating entry carries no inline query (the no-matches form included) | checker finding `SEARCH_RESULTS_NOT_SUPPLIED` | part 05 §2.8: only that entry's frame holds the results instance (`org/commcare/session/CommCareSession.java::setQueryDatum`) |
| a `search-results` row's `@case_type` compared with another type; an order-dependent read of search results (a positional step, `position()` in the query, `join` or `distinct-values` over it) | checker finding `SEARCH_RESULTS_READ_INVALID`, `details.reason` `other-type` or `order` | part 05 §2.8: HQ returns the searched type only, ordered by relevance score; the two rules share one code |
| a session datum id the form's entry does not supply, in text | parse refusal `unknown-datum` | part 02 §1.4, part 05 §1.3: no `DatumRef` can be built from it |
| a stored `DatumRef` (or `selected-cases`) the entry no longer supplies | checker finding `SESSION_DATUM_NOT_SUPPLIED`, rewritten over identity | finding 68 (`lib/commcare/validator/rules/sessionData.ts`, today over ids); part 05 §1.6. Entry supply is checker admission, reading `lib/domain/entryDatumSupplies.ts::entryDatumSupplies`, and `rules/sessionData.ts` leaves. The same rule checks a record slot's chosen case (§4): the menu must be one the evaluating entry passes through, its datum supplied before the slot evaluates |
| a literal default on a static-choice question that is not one of its options, `''` excepted | checker finding `default-not-a-choice` (`SELECT_DEFAULT_NOT_AN_OPTION`) | finding 72 (`org/javarosa/core/model/data/helper/Selection.java::attachChoice`, which returns early for dynamic choices); `''` is no starting value (`org/javarosa/core/model/condition/Recalculate.java::wrapData` makes it no value, so `attachChoice` never runs; part 03 §3.5) |
| a literal a Hidden Value or a case operation writes into a property that a static-choice question preloads, when it is not one of that question's options | checker finding in `SELECT_DEFAULT_NOT_AN_OPTION`'s family (part 03 §4.3 names the code and copy); a computed write stays admitted, as a computed default does | finding 72's runtime twin: the preload reaches `Selection.java::attachChoice` as a default does (part 03 §4.3) |
| every rule today's record slots apply (unknown property, scope, ordered types, relation rules, CSQL representability, on-device portability) | checker finding | unchanged |

A refusal message follows `design/readme.md`, "Content fundamentals": it says what was written,
why CommCare cannot run it, and what to write instead (the existing messages of
`lib/commcare/xpath/compatibility.ts` and `lib/domain/predicate/typeChecker.ts` are the starting
copy). Part 02 §1.4 holds the parse copy and part 03 §2 the validation codes and copy.

### 1.6 Held by later steps

A construct leaves step 3 only when it depends on a model concept a later step owns (a data source
or setting Nova does not hold yet) or on the platform declaration (step 4); decided with the person
(2026-10-17), who asked that work that logically belongs now be done now. Each row below is held,
not dropped: this plan's own pull request writes it into the receiving step's outline file
(`docs/plans/hq-round-trip/4-platforms.md`, `6-import.md`, `7-rest-of-model.md`), and the parser
refuses the text with the copy named. Production holds no stored read of any of them (no `groups`,
`search-input*` or results read, no `stringquery` or `fingerprintquery`, and its `session/context`
reads are `userid` and `username`, both authorable; part 05 §6.1), so no deferral strands a stored
expression.

| Construct | Held by | Reason | In step 3 |
|---|---|---|---|
| `project-day` arm | step 6 (import) | No API-key route returns a project space's `default_timezone`, so no step-3 surface can author it with a meaning Preview evaluates as HQ does, and the cutover lifts nothing to it (part 06 §3.3; decided with the person, 2026-10-17). | not in the union; its manifest entry stays HELD-NEW, owned by step 6 |
| `groups` arm, `group-field` leaf | step 7, group 2 (case sharing) | The read means the worker's case-sharing groups, a concept Nova holds only from `caseSharing`, and HQ's own groups are target state Preview cannot show (part 05 §2.6; `users/fixturegenerators.py::UserGroupsFixtureProvider.__call__`). | `instance('groups')` is a parse refusal: "Reading the worker's case-sharing groups isn't available yet. You can read the places the worker is assigned to with `instance('locations')` instead." |
| `device-query` datum kind (`stringquery`, `fingerprintquery`) | step 4 (platforms) | Each exists in `session/data` only when an Android entity step carries its last query or callout extra (`SessionInstanceBuilder.java::addUserQueryData`, `::getStringQuery`; part 05 §2.6); Web Apps never has it and Preview has no value. | not a `DatumRef` kind; text naming either id is `unknown-datum` |
| search inputs read in an inline-search module's ordinary forms | step 4 (platforms) | Formplayer keeps the inputs on the query step and Android does not, so a read there throws on Android (the research inventory, `search-input:*` in inline-search forms, RUNS / UNAVAILABLE; part 05 §2.6). | `INVALID_SEARCH_REF`; the no-matches form keeps its `#search/` read |
| authoring of session context `drift`, `window_width`, `applanguage` | step 4 (platforms) | Their values differ per platform (the research inventory, "Secondary instances"). | stored and parsed (the enum holds all seven, §1.2); the builder shows them read-only and offers four |

Search results read in the forms of an inline-search module stay in step 3. Nova already emits
inline search, the search-first inline shape and `results:inline`, so no later concept is needed;
`cases.source` keeps `"search-results"`, and part 05 §2.8 and part 07 §3.2 plan it in full, Preview
supplying the results set the search returned to that form.

The chosen case in record slots stays in step 3 too (§4, "Chosen case"). `DatumRef` and
`entryDatumSupplies` land in pull request 5 and Preview's `entrySessionData` already serves the
Search screen (part 07), so it needs nothing a later step owns.

---

## 2. The mapping

### 2.1 JavaRosa's 76 function names

The 76 names are the `case` labels of `org/javarosa/xpath/parser/ast/ASTNodeFunctionCall.java::buildFuncExpr`
(counted at the pin: 76), identical to `lib/commcare/xpath/functionCapabilities.ts::JAVAROSA_NATIVE_FUNCTIONS`.

| Function | Arm | Why that arm |
|---|---|---|
| `if` | `if` | the record arm emits `if(c, a, b)` (`lib/commcare/expression/onDeviceEmitter.ts`, `if` arm) |
| `coalesce` | `coalesce` | emits `coalesce(...)` |
| `concat` | `concat` | emits `concat(...)`; `concat()` with no argument parses to the literal `''` (§2.5) |
| `true` | `match-all` | the record grammar maps `true()` to it in a condition position (`lib/agent/authoring/queryExpressions.ts`, `predicate()`); in a record value position `true()` stays the literal `true`. Form logic has no positions, so form-logic `true()` is always `match-all`, typed `boolean` |
| `false` | `match-none` | likewise, the literal `false` in a record value position |
| `not` | `not` | emits `not(...)` |
| `today` | `today` | emits `today()` |
| `now` | `now` | emits `now()` |
| `date` | `date-coerce` | emits `date(x)` |
| `double` | `double` | emits `double(x)` |
| `format-date` | `format-date` | emits `format-date(d, p)` |
| `count` | `count` (`via` a node-set) | the record arm emits `count(<case node-set>)` |
| `regex` | `matches-pattern` | "is JavaRosa's `regex(str, re)` and nothing else" (`types.ts`, pattern block) |
| `selected` | `multi-select-contains`, one value, `any` | the record arm emits one `selected(p, 'v')` per value |
| `is-selected` | `multi-select-contains` | Core builds the same `XPathSelectedFunc` for both names (`ASTNodeFunctionCall.java::buildFuncExpr`, `case "selected"` falls through to `is-selected`); canonical print is `selected` (§2.5) |
| `starts-with` | `match`, mode `starts-with` | the record arm emits `starts-with(p, v)` on the device |
| `abs` `acos` `asin` `atan` `atan2` `boolean` `boolean-from-string` `ceiling` `checklist` `checksum` `closest-point-on-polygon` `cond` `contains` `cos` `count-selected` `decrypt-string` `depend` `distance` `distinct-values` `encrypt-string` `ends-with` `exp` `floor` `format-date-for-calendar` `id-compress` `index-of` `int` `is-point-inside-polygon` `join` `join-chunked` `json-property` `log` `log10` `lower-case` `max` `min` `number` `pi` `position` `pow` `random` `replace` `round` `selected-at` `sin` `sleep` `sort` `sort-by` `sqrt` `string` `string-length` `substr` `substring-after` `substring-before` `sum` `tan` `translate` `upper-case` `uuid` `weighted-checklist` | `call` | no arm means it |

That is 16 names on arms and 60 on `call`, because each of those 16 arms emits exactly that function
today. `number` is not `double`: Core's `number` is `FunctionUtils.java::toNumeric` and `double` is
`::toDouble`, which differ on a `Date`. `cond` is not `switch`: `switch` compares one value to
literals, `cond` tests conditions. `distance` is not `within-distance`: that arm is a predicate.
The widened operand slots (`match.property`, `multi-select-contains.property` and `values`,
`matches-pattern.pattern`) follow from these mappings, and the record-only rules attached to them
(non-empty match value, multi-select property type, `patternMatching`) apply only in the profiles
that had them.

Nova's names and the forms' handlers:

| Name | Arm |
|---|---|
| `is-blank` (Nova, lowered) | `is-blank` |
| `normalize-space` (Nova, lowered) | `call` |
| `instance('…')` | the instance arms of §2.3 |
| `current()` | `field` with `spelling: "current"` (or `repeat-row`) |
| `jr:itext` | `itext` |
| `jr:choice-name` | `choice-name` |
| `here` | `here` |

`CallFunction` is the closed enum of the 60 plus `normalize-space`; a `call` to a name outside it
is unrepresentable.

### 2.2 Operators

| XPath | Arm |
|---|---|
| `=` `!=` `<` `<=` `>` `>=` | `eq` `neq` `lt` `lte` `gt` `gte` |
| `and`, `or` | `and`, `or`; a same-operator chain is one node (`a and b and c` is three clauses) |
| `+` `-` `*` `div` `mod` | `arith` with that `op` |
| unary `-` | the literal `-n` on a number literal, else `negate` |
| `\|` | unrepresentable |
| `( … )` | no node (grouping) |

### 2.3 Path shapes and instance roots

| Shape | Arm |
|---|---|
| `#form/a/b` | `term field { uuid }` |
| `/data/a/b` | `term field { uuid, spelling: "absolute" }` |
| `../b`, `b`, `./b`, `.` | `term field { uuid, spelling: "relative" [, climb] }` |
| `current()/../b`, `current()` | `term field { uuid, spelling: "current" [, climb] }` |
| a predicate on a step (`/data/rep[2]/x`) | `field.filters` |
| `current()/../@id`, `../@index` in a query-bound repeat | `term repeat-row` |
| `#<type>/<prop>` | `term form-case` |
| `#case/<prop>` (SA and MCP, a selected case type in scope) | `term form-case`, storing the actual type |
| `#user/<slug>` | `term session-user-property { source: "worker-record" }` for a unique Nova property, else `session-user { source: "worker-record" }` (today's rule, `lib/commcare/xpath/expressionAst.ts::classifyHashtag`) |
| `#search/<name>`, `instance('search-input:results[:inline]')/input/field[@name='<name>']` | `term input` (admitted in a no-matches form; held by step 4 in an inline-search module's ordinary forms, §1.6) |
| `instance('casedb')/casedb/case[p1][p2]…` | `cases { source: "casedb", where: [p1, p2, …] }`, its row typed by §1.3's three rules |
| `instance('results:inline')/results/case[not(commcare_is_related_case = true())][p1]…` | `cases { source: "search-results", where: [p1, …] }` (the exclusion is not stored), its row the searched case type (§1.3); without the exclusion `search-results-unexcluded`; `instance('results')` is `search-results-remote` (§1.5) |
| `…/case[…]/<prop>`, `/@case_id`, `/@owner_id`, `/@status` | `project { value: prop }` |
| `…/case[…]/@case_type` | `project { value: case-row-type }` |
| `…/case[…]/index/<id>` | `project { value: case-index }` |
| inside a case predicate: `<prop>`, `@case_id`, `@case_type`, `index/<id>` | `prop`, `case-row-type`, `case-index` (no `caseType` stored on a standard read or `case-index` in an untyped row, §1.3) |
| `instance('<tag>' \| 'item-list:<tag>')/<tag>_list/<tag>[w][1]/<col>` with exactly one predicate before `[1]` | `table-lookup` |
| any other lookup path | `table-rows` (+ `project { value: table-column }`) |
| `instance('groups')/groups/group[…]/@id`, `/name` | parse refusal in step 3; **held by step 7, group 2** (§1.6) |
| `instance('locations')/locations/location[…]/<value>` | `locations` (+ `project { value: location-field }`); `@type = 'code'` compares `location-field type` with `location-level` |
| `instance('<multi-select datum id>')/results/value` | `selected-cases` |
| `instance('commcaresession')/session/data/<id>` | `term session-datum`, `<id>` resolved through `entryDatumSupplies`; an id the entry does not supply is `unknown-datum`; a multi-select datum's value is a storage guid, so it is refused there and `selected-cases` reads the ids; `stringquery` / `fingerprintquery` are held by step 4 (§1.6) |
| `instance('commcaresession')/session/context/<f>` | `term session-context` (all seven) |
| `instance('commcaresession')/session/user/data/<slug>` | `term session-user-property` (unique Nova slug) or `session-user`, `source` absent |
| a string literal opposite `case-row-type` | `term case-type` |
| a string literal opposite a static-choice `field` (comparison, `selected`, `in`, `switch`) or as that field's default, equal to its options' values | `term choice` |

Form-logic text keeps these CommCare spellings and gains no Nova spelling for them, because the
grammar is CommCare XPath, the authoring guide already teaches these paths
(`lib/agent/authoring/reference.ts`, "expressions"), and identity no longer depends on spelling. SA
and MCP admit relative paths (part 02 §1.6): today strict mode refuses bare relative names
(`expressionAst.ts::hasExplicitPathContext`); from step 3 they are identity, and a relative path
that reaches no field is `relative-unknown`.

The XForm instance id of a lookup table is its bare tag, which is what HQ's form builder data
sources use (`fixtures/fixturegenerators.py::item_lists_by_domain`, `namespace_ids=False` from
`app_manager/views/formdesigner.py`); the suite id is `item-list:<tag>`. Both spellings parse
to the same arms. **Canonical print follows the slot's target** (part 05 §2.3): the bare tag in
XForm slots (field logic, repeat queries, Connect), `item-list:<tag>` in suite and form-link slots
(`condition`, `datums[].xpath`), because HQ's suite build refuses a bare tag there as an unknown
instance (`app_manager/suite_xml/post_process/instances.py::get_instance_factory` finds no factory
for a scheme-less name and falls to `::null_factory`, then `::assert_no_unknown_instances` raises
`UnknownInstanceError`; `item-list:<tag>` is served by `::generic_fixture_instances`, registered
for the `item-list` scheme). The profile (§4) names each slot's target, so the printer takes
the spelling from it.

The `[1]` rule for `table-lookup` is the shape-directed principle: the arm's form-XPath print is
the on-device emitter's spelling (`lib/commcare/predicate/termEmitter.ts`, `table-lookup` lowering
in `lib/commcare/CLAUDE.md`, "Lookup wire"); a path with two predicates before `[1]` is a
different shape and stays `table-rows`.

### 2.4 Canonical print of every arm

Two authoring grammars exist and both stay: **form XPath** (the `xpath` family; parser
`lib/doc/expressionText.ts::parseAuthoredXPath` over `lib/commcare/xpath/expressionAst.ts`) and
the **record dialect** (`condition`, `value`, `reference`, `relationship` families; parser
`lib/agent/authoring/queryExpressions.ts`, printer `printQueryExpression.ts::queryPrinter`). Each
slot is authored in exactly one of them (§4), so the round-trip law (`print(parse(s))` is
canonical and `parse(print(e)) = e`) holds per grammar over the arms that grammar's slots admit.
"none" means no slot authored in that grammar admits the arm; a builder or tool read never prints it
there.

| Arm | Form XPath | Record dialect |
|---|---|---|
| `literal` | `'text'` (`"text"` if it holds `'`), `12`, `-1.5`; form-logic `true()`/`false()` parse to `match-all`/`match-none`, so a boolean literal never prints here | unchanged: `'text'`, `12`, `literal(v, 'type')` for a typed literal; `true()` / `false()` in a value position |
| `prop` (row) | `<prop>` (in a predicate), `@case_id` `@owner_id` `@status` | unchanged: `#case/p`, `#record/T/p`, `property('T', 'p'[, rel])` |
| `form-case` | `#<type>/<prop>` | unchanged (`#case/p`, `#T/p` in a choice filter) |
| `input` | `#search/<name>` | unchanged: `#search/<name>` / `search('…')` |
| `session-user` | `#user/<field>` (worker-record) or `instance('commcaresession')/session/user/data/<field>` | unchanged: `external-user('…')` |
| `session-user-property` | `#user/<slug>` or `instance('commcaresession')/session/user/data/<slug>` | unchanged: `user('<slug>')` through `AuthoringScope.printReference` (the parser also accepts `#user/<slug>`) |
| `session-context` | `instance('commcaresession')/session/context/<f>` | unchanged: `session('<f>')` |
| `field` | `#form/<path>`, `/data/<path>`, `../x`, `current()/../x`, filters as `[…]` | unchanged: `#form/<path>` |
| `table-column` | `<col>` (in a row predicate) | unchanged: `#row/<col>`, `table-column('T', 'c')` |
| `fixed-location`, `owner-location-at-level` | none | unchanged |
| `choice` | `'value'`, `'v1 v2'` | `'value'` |
| `case-type` | `'visit'` | `'visit'` |
| `case-row-type` | `@case_type` | `record-type()` |
| `case-index` | `index/<id>` | none |
| `session-datum` | `instance('commcaresession')/session/data/<derived id>` | `selected-case` only, from pull request 10: `chosen-case('<menu name>')`, the menu resolved to its module's identity through `AuthoringScope` like every record spelling (§4, "Chosen case") |
| `project` keyed on a chosen case | `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/<derived id>]/<prop>`, as every `project` | `chosen-case-property('<menu name>', '<property>')`, from pull request 10 |
| `repeat-row` | `current()/../@id`, `../@index` | none |
| `location-level`, `location-field` | `'code'`, `@id`, `name`, `location_data/<slug>`, `@<code>_id` | none |
| `today`, `now` | `today()`, `now()` | unchanged |
| `id-of`, `acting-user`, `unowned` | none | unchanged |
| `table-lookup` | `instance('<tag>')/<tag>_list/<tag>[<where>][1]/<col>` in XForm slots, `instance('item-list:<tag>')/…` in form-link slots (§2.3) | unchanged: `lookup('T', 'c', <cond>)` |
| `date-add`, `datetime-coerce` | none | unchanged |
| `date-coerce` | `date(x)` | unchanged: `date(x)` |
| `double` | `double(x)` | unchanged: `number(x)` |
| `arith` | `a + b`, `a div b`, `a mod b`; `quotient` none | unchanged: `(a + b)`; `quotient(a, b)` |
| `negate` | `-x` | `-x` |
| `concat`, `coalesce`, `if` | `concat(…)`, `coalesce(…)`, `if(c, a, b)` | unchanged |
| `switch`, `in`, `between`, `within-distance`, `when-input-present`, `exists`, `missing` | none | unchanged |
| `count` | `count(<node-set>)` | unchanged: `count(<rel>[, <cond>])` |
| `format-date` | `format-date(d, '<pattern>')`; a preset prints its resolved JavaRosa pattern (`lib/domain/dateFormats.ts`) | unchanged: `format-date(d, 'short')` |
| comparisons | `a = b`, `a != b`, `a < b` … | unchanged: `(a = b)` … |
| `match` | `starts-with(a, b)`; the other modes none | unchanged: `fuzzy(p, v)` … |
| `multi-select-contains` | `selected(a, b)` (one value, `any`); other shapes none | unchanged: `selected-any(p, …)` |
| `match-all`, `match-none` | `true()`, `false()` | unchanged |
| `is-blank` | `is-blank(x)` | unchanged |
| `matches-pattern` | `regex(x, '<pattern>')` | unchanged: `matches-pattern(x, '…')` |
| `and`, `or`, `not` | `a and b`, `a or b`, `not(a)` | unchanged: `all(…)`, `any(…)`, `not(…)` |
| `call` | `<fn>(a, b)` | none (§7, "Nova does not author HQ's escape hatches") |
| `cases`, `project` | `instance('casedb')/casedb/case[…]/<value>`; `"search-results"` prints `instance('results:inline')/results/case[not(commcare_is_related_case = true())][…]`, the instance Nova's inline search declares (`lib/commcare/compiler.ts`, `caseSource`; `lib/commcare/session.ts`, `storageInstance`), its first predicate the print's own exclusion of HQ's related cases (part 05 §2.8); part 05 §2.8 and part 07 §3.2 plan it | none, except the chosen case's property above |
| `table-rows` (lookup root per target, §2.3), `locations`, `selected-cases` | as §2.3 | none |
| `itext` | `jr:itext('<itext id>')` | none |
| `choice-name` | `jr:choice-name(x, '/data/<path>')` | none |
| `here` | `here()` | `here()` |
| `value-list` | none | none (held for import: no step authors it and no stored expression lifts to it; §7, part 06 §3.6) |
| `group-field`, `groups`, `project-day` | none (held, §1.6) | none (held, §1.6) |

"Unchanged" means `printQueryExpression.ts::queryPrinter`'s current output byte for byte, so a
record read-back does not change except where an arm's stored value changes in the cutover (the
`quotient` lift and the `double` wrapper strip, §1.4).

**Each grammar keeps its spellings.** The record dialect spells `double` as `number()` and form
XPath spells `call number` as `number()`; changing either would change what the model is taught
(`lib/agent/authoring/reference.ts`) for no change in meaning. Record prints are today's byte for
byte, `session-user-property` included (`user('<slug>')`, part 02 §2.2), and the record dialect
gains no CommCare vocabulary such as `datum(…)`: a chosen case reads in Nova's own words,
`chosen-case('<menu name>')` and `chosen-case-property('<menu name>', '<property>')`, and part 02
§2.2 holds their grammar.

### 2.5 Canonical form-XPath print rules

The stored tree holds no source trivia. Its print is:

- **spacing:** one space after every comma (`f(a, b)`, `if(c, a, b)`) and one space either side of
  every binary operator (`a = b`, `a and b`, `a div b`), inside a step predicate too
  (`case[@case_type = 'visit']`); no space inside a path, between a function name and its `(`, or
  just inside brackets and parentheses; unary minus takes none (`-x`, `-1`);
- **parentheses** only where the tree needs them: the grammar's precedence
  (`lib/commcare/xpath/grammar.lezer.grammar`, `@precedence`) and left associativity, so a left
  operand of the same precedence never takes them, and a **right operand of the same precedence
  always does, unless parent and child are the same n-ary `and` or `or`** (part 04 §2.2):
  `a + (b - c)`, `a * (b div c)`, `a = (b = c)` keep theirs, `a and b and c` is one node. The test
  is the round-trip law `parse(print(e)) = e`;
- a string literal in single quotes, double quotes when it holds `'` (a form-logic literal never
  holds both, because the parser cannot read one);
- a **number** in shortest round-trip form with no exponent: JavaScript's `String(n)` with any
  exponent expanded, which the record printer's `printQueryExpression.ts::numeric` already does and
  shares (`5`, `0.5`, `-1.5`, `20468.4375`, `0.0000001`); never `5.0` or `.5`;
- function names exactly as Core's table spells them;
- a lookup root by the slot's target (§2.3): bare tag in XForm slots, `item-list:<tag>` in suite
  and form-link slots;
- an absent slot prints nothing; there is no empty expression to print (§1.1).

**Why this spacing and these numbers.** It is Vellum's own normal form, so an HQ form-builder save
leaves canonical text, the lowering included, byte-identical. Executed during planning: a lane run
without the served readers on a scratch branch (GitHub Actions run 39061476968, the lane clean)
uploaded forms holding finding 56's lowering and today's non-canonical text, saved each in Vellum,
and compared the saved forms bind by bind. Vellum rewrote only whitespace in the lowering's text:
one space after each comma and around each operator (`substr(#form/before,0,4)` became
`substr(#form/before, 0, 4)`, `*3600` became `* 3600`), the two typed-against-text comparisons
growing from 5,173 to 5,355 bytes and from 5,143 to 5,325, and the folded-literal one from 1,833 to
1,924; every number it held (`86400`, `719468`, `20468.4375`, `-1`) survived. On today's admissible
non-canonical text it also wrote `5.0` as `5.` and `((#form/n+1))` as `(#form/n + 1)`, and kept
`"big"` double-quoted: Vellum keeps one pair of the author's parentheses and adds none (js-xpath's
grammar marks a parenthesised expression with `parens = true`, `src/jison/xpath.jison`, `base_expr`,
and `src/models.js::printBinOp` prints a pair only for that mark, spacing every operator; a call
joins its arguments with `", "`), so canonical minimal parentheses are a fixed point too. A
predicate's operators are already spaced in what Nova emits and Vellum left them unchanged
(`case[@case_id = instance('commcaresession')/session/data/case_id]`). The other changes were the
`vellum:*` shadow attributes Vellum adds. Plan on about 5.4 KB per typed-against-text comparison
after a save (the executed 5,355 B; part 04 §3.9 sizes the lowering).

**Vellum's numbers**, executed during planning by running js-xpath's
`src/models.js::XPathNumericLiteral.toXPath` at `v0.0.10` with plain `node` over 22 spellings:
`5`, `0.5`, `1.5`, `-1.5`, `0.25`, `0.000001`, `0.0000005`, `20468.4375`, `86400` and
`1000000000000000000000` print as themselves; `5.0` prints `5.`, `.5` prints `0.5` and `0.0000010`
prints `0.000001`; and numbers below 0.000001, where JavaScript's own `toString` turns to an
exponent, can change value: `0.0000001` prints `0.00000009999999999999999`, `0.0000009` prints
`0.0000008999999999999999`, and `0.000000000001` changes too (`0.0000005` and `0.00000123`
survive), because `toXPath` rescales the exponent spelling in floating point (`toFixed`). So the
byte-identity holds for every number at or above 0.000001; below it a save can rewrite an author's
literal to a nearby value whatever spelling Nova writes. That is what HQ's editor does itself, so
Nova records it and refuses nothing: Nova keeps the value the author meant, and only an HQ save
alters it. The lowering emits no such number (none in part 04's lowering output or in the forms of
run 39061476968).

This changes more than spacing in some stored texts: redundant parentheses, double-quoted literals
that need none, `1.0`/`.5` spellings, `is-selected`, and `concat()`. Each is the same value on every
reader (§7). **What production holds** (part 04's prototype printer over the read-only production
scan, executed during planning): a small share of stored expressions print differently, in a
minority of apps. The classes are redundant parentheses (most of them), double-quoted literals that
need none, number spellings, spacing only, and a relative path re-derived; by slot most are
`calculate`, then `validate` and `relevant`, with some `default_value`s and Connect slots. None is
`is-selected` or `concat()`, and the scan's parenthesis rule and this one disagree on none. The
cutover's dry run counts per app with the production printer for the notice (part 02, "What remains
for the cutover's dry run"). The per-target lookup root moves no stored byte: today no stored form
logic can name a table (`lib/commcare/xpath/carriers.ts::xpathCarrierAllowedInstanceIds`; part 05
§2.3).

### 2.6 Field-path print

A `field` prints from current identity and the slot's context node (§4, the "Scope and context node" column):

- hashtag: `#form/` + the target's id path from the form root (`lib/domain/xpath/print.ts`, today);
- absolute: `/data/` + that path;
- relative and current: `..` once for each level from the context node up to the lowest common
  ancestor (or up to `climb` when present), then the target's path down; `.` for the context
  node itself; `current()/` prefixed for `current`;
- `filters` print as `[…]` after their step.

A relative path whose `climb` container is no longer an ancestor of both ends cannot print; the
projection returns the repair marker and the gate refuses the batch that caused it (§5).

---

## 3. Types

### 3.1 Two axes

```ts
type ScalarType = CasePropertyDataType | "boolean" | "_any";
type RowKind = "case" | "table" | "location" | "repeat";   // "group" held by step 7, group 2
type ExpressionType =
  | ScalarType
  | { nodes: ScalarType | RowKind; cardinality: "one" | "many"; structural?: true }
  | "sequence";                                // distinct-values
// `structural`: several nodes by the app's shape, not its data (§3.4 rule 4): a `field` or
// `repeat-row` read crossing a repeat the context node is not inside, `selected-cases`, and a
// `project` or `if` / `coalesce` branch that carries one of them. Never set on `cases`,
// `table-rows` or `locations`, whose row count only data decides.
// Implementation correction, 2026-10-19: a group, section, form root or Connect block, which the
// pull request 5 checker marked `structural`, is marked `container`; and `NodeType` carries
// `clockLost?: true`, a date and time whose clock may be gone (part 03 §5.1).

type Held =                                    // what Core holds at run time
  | "boolean" | "number" | "string" | "date"
  | { nodes: "boolean" | "number" | "string" | "date" }   // a lazy node-set and what one node unpacks to
  | "sequence";

type NodeType = { data: ExpressionType; held: Held; caseIdOf?: CaseTypeName };
```

- **Data type** is Nova's meaning: the lattice `lib/domain/casePropertyTypes.ts::casePropertyDataTypes`
  plus `boolean` and node-sets of a type or of rows. `caseIdOf` marks a text value that is the id
  of a case of a known type, which is how a `cases` query by `@case_id` knows its row type (§1.3),
  so `instance('casedb')/casedb/case[@case_id = #form/member]/name` is typed. Its sources:
  - a `session-datum`, by kind (part 05 §1.3's column): `selected-case { module }` the module's
    case type; `new-case` the owning module's case type; `new-child-case { caseType }` that
    `caseType`; `worker-record` `commcare-user` (`lib/domain/usercase.ts::USERCASE_CASE_TYPE`);
    `tile-group-parents` none, because its value is a space-separated list of ids (HQ's
    `join(' ', distinct-values(…))`, part 05 §1.2);
  - `form-case case_id` (the form's case type or the ancestor's), `case-index` with a stored
    `caseType` (the relation's destination; none in an untyped row, §1.3), `repeat-row id` (the
    repeat's query type), `id-of` (the operation's case type);
  - the answer of a select whose options come from a `cases` source, whose "values are always exact
    case IDs" (`lib/domain/fields/selectOptionsSource.ts::caseOptionsSourceSchema`).
- **Held** is Core's runtime value. A node unpacks by its answer's class
  (`org/javarosa/xpath/expr/XPathPathExpr.java::unpackValue`): `DateData` and `DateTimeData`
  to a `Date`, `IntegerData`, `LongData`, `DecimalData` to a `Double`, `BooleanData` to a
  `Boolean`, and `UncastData`, `StringData`, selects, `GeoPointData` and a time (no `TimeData`
  arm, so its string) to a `String`. A calculated value is wrapped by its result's class and its
  bind type (`org/javarosa/core/model/condition/Recalculate.java::wrapData`): a `Date` under any
  bind but `xsd:dateTime` (a Hidden Value's `xsd:string` among them) becomes `DateData`, losing the
  clock, and only a `DATATYPE_DATE_TIME` bind keeps `DateTimeData`. **Implementation correction,
  2026-10-19:** that is a `calculate`; a `default_value` is a setvalue, which casts the wrapped
  value's text through the bind's answer class (`SetValueAction.java::processAction`), so under
  `xsd:string` a starting value holds text, a `Date` as its `YYYY-MM-DD` day. A Hidden Value's held
  class is bind × source slot × result (part 03 §5.1).

Finding 56's per-operand lowering reads both: a Hidden Value copying a datetime property is
`{ data: "datetime", held: { nodes: "string" } }`, a datetime question `{ data: "datetime",
held: { nodes: "date" } }`, `now()` `{ data: "datetime", held: "date" }`. Part 04 §3 chooses the
lowering from that pair.

### 3.2 How each leaf gets its type

| Leaf | Data type | Held |
|---|---|---|
| `field`, visible question | `lib/domain/caseTypes.ts::caseDataTypeForFieldKind(kind)` | nodes of the bind's class (date and datetime `date`; int, decimal `number`; everything else `string`) |
| `field`, Hidden Value | the type of its value expression (`calculate` or `default_value`); `undefined` when it has neither. A Hidden Value that writes a case property takes the destination's type when its expression's type is assignable to it or unknown (part 03 §4.3, §5.1), so `if(c, #form/dt, '')` writing a date and time property keeps its `xsd:dateTime` bind; a disagreeing writer is `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` (part 03 §4.3) | nodes of the class its emitted bind and result give. The bind keeps today's rule, `lib/domain/fieldValueType.ts::fieldValueType`'s writer destination, not the inferred type (part 04, decision 13); an `xsd:string` bind holds a `Date` result as `DateData` (`Recalculate.java::wrapData`) |
| `field`, group / repeat / section | `{ nodes: "repeat" }` for a repeat, `text` for a group | nodes `string` |
| `field`, cases-sourced select | its select type, with `caseIdOf` the source's case type | nodes `string` |
| `field`, cardinality | `many` and `structural` when the path crosses a repeat the context node is not inside; else `one` (a positional filter such as `[1]` on the repeat step makes it `one`). **Implementation correction, 2026-10-19:** any filter on the crossed step makes the read not structural (another filter leaves the count to the data); the context is the source node for `current()`, else the lexical context node, which inside a step predicate is the step; a case operation with `forEach` evaluates in its repeat's iteration, and a slot with no context node crosses every repeat; `repeat-row` and `form-node` leaves count the same way | none |
| `repeat-row` | `text`, `caseIdOf` the repeat's query type for `id`; `int` for `index` | nodes `string` |
| `form-case`, `prop` | the effective catalog (`lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes`); standard properties from `standardCaseProperties.ts` (`date_opened`, `last_modified` `datetime` in every row; an absent-type standard read in an untyped row takes the same table, §1.3); `closed_on` from the search-only table in server-only slots (§1.4). An untyped property reads as `text` for comparison verdicts and as **unknown** for Hidden Value inference and writer agreement (part 03 §5.1) | by the row's instance root, which the row stack carries: nodes `string`, except `date_opened` and `last_modified` read from `casedb` (a `casedb` row or a `form-case` read), which Core holds as `DateData` (`CaseChildElement.java::buildAndCacheInternalTree`): nodes `date`, the day only. In a `search-results` row (`results:inline`) both are text, nodes `string`: `last_modified` HQ's instant text (`%Y-%m-%dT%H:%M:%S.%fZ`), which the lowering orders as an instant; `date_opened` the **UTC day**, `YYYY-MM-DD` (`V2CaseXMLGenerator.add_custom_properties`, `date_to_xml_string`), which takes `day-only-on-device` by the same rule as the `casedb` pair (§1.5; part 04 §3.4) |
| `case-index` | `text`, `caseIdOf` the relation's destination (none when `caseType` is absent, §1.3) | nodes `string` |
| `case-row-type`, `case-type`, `location-level` | `text` | `string` |
| `table-column`, `table-lookup` | the column's `LookupDataType` (`lib/lookup/constants.ts::LOOKUP_DATA_TYPES`) | `string` (fixture text) |
| `session-user`, `session-user-property` | `text` (worker properties carry no data type, `lib/domain/users.ts`) | `string` |
| `session-context`, `session-datum` | `text`; a datum carries its kind's `caseIdOf` (§3.1: `selected-case` the module's type, `new-case` the module's type, `new-child-case` its `caseType`, `worker-record` `commcare-user`, `tile-group-parents` none; part 05 §1.3) | `string` (`UncastData`, `SessionInstanceBuilder.java::addDatums`) |
| `input` | `lib/domain/modules.ts::searchInputRuntimeValueType` | `string` |
| `location-field` | `text`; `latitude`/`longitude` `decimal` | `string` |
| `choice` | the field's select type | `string` |
| `literal` | `data_type`, else by JavaScript type; in form-logic profiles a string literal opposite a typed operand reads by its shape: ISO date `date`, ISO datetime `datetime`, `HH:MM[:SS]` `time` (not stored) | `string`, `number`, or `boolean` for `match-all`/`match-none` |
| `today` / `now` | `date` / `datetime` | `date` |

The Hidden Value rule replaces `lib/domain/fieldValueType.ts::fieldValueType`, which today types a
hidden only through its case write. Hidden types form a graph through the hiddens and case
properties they read (`h` copies `#visit/seen`, `seen`'s type comes from its writers, one of which
may be `h`). The checker computes them as a least fixpoint per document, memoised like
`effectiveCaseTypes`; a cycle leaves its members `undefined`, which compatibility treats as no
opinion (`lib/domain/CLAUDE.md`, "Unknown is honest"). `effectiveCaseTypes`'s structural hidden
inference (`WHOLE_EXPRESSION_TYPES`, "nothing parsed") is replaced by this typed inference, so a
property a Hidden Value writes from `#visit/seen` takes `seen`'s type. **Implementation correction,
2026-10-19:** pull request 5 had already replaced `WHOLE_EXPRESSION_TYPES` with the closed
`effectiveCaseTypes.ts::inferHiddenWriterType` / `inferExpressionType`, which pull request 6
deletes; `effectiveCaseTypes`, `materializableCaseTypes` and `concreteCasePropertyWriterTypes` are
projections of `lib/domain/expression/inference.ts::inferExpressionTypes`.

Inference and writer agreement read **concrete** types only (part 03 §5.1), as
`lib/domain/effectiveCaseTypes.ts::concreteInferenceCaseTypes` does today: a property no writer
types is unknown to them, not `text`, so a Hidden copy of an untyped property never refuses a date
writer, and a chain resolves once a real writer's opinion arrives. Comparison verdicts still read
it as `text`. A writer's own type is its destination's where its expression agrees or is unknown
(part 03 §4.3): the expression's type is the writer's opinion, the destination's the value it holds.

**A Hidden Value can hold less than its type says.** With inferred types, a Hidden Value whose
calculate is `now()` is `datetime`, but under its `xsd:string` bind Core holds `DateData` and the
clock is gone (`Recalculate.java::wrapData`). The model reports both axes. Binds keep today's rule,
the writer destination `fieldValueType` gives, not the inferred type, so the two axes may differ,
the lowering reads the held representation that bind gives, and finding 73's failure is not
widened. A Hidden Value that writes a case property takes its destination's type where its
expression agrees or is unknown, which keeps every admitted writer's bind as it is today. Because
`fieldValueType` reads the effective catalog, a property this inference types for the first time
(say `datetime`) gives its Hidden writers that bind type; part 04 §5.4's census names each such bind
change, and the cutover's dry run counts them at base and head.

**Implementation correction, 2026-10-19: clock provenance.** The `field`, Hidden Value row's held
class is bind × source slot × result (part 03 §5.1): a `calculate`'s text holds `string` under any
bind, its number `number`, its `Date` `date`; a `default_value` under `xsd:string` holds `string`.
A date and time whose clock may be gone (a `Date` of datetime or unknown data under an `xsd:string`
bind, or a copy of one through any Hidden Value, branch or bind, since an `xsd:dateTime` bind cannot
restore it) is `clockLost`, which `date-coerce` clears. Pull request 6 refuses it written into a
date-and-time property; pull request 8 refuses it in an implicit instant comparison
(`incompatible-values`, reason `clock-lost`). The bind keeps today's rule.

### 3.3 Operators

| Arms | Result | Operand rule |
|---|---|---|
| comparisons, `in`, `between`, `match`, `multi-select-contains`, `matches-pattern`, `is-blank`, `and`, `or`, `not`, `exists`, `missing`, `match-all`, `match-none`, `when-input-present` | `boolean`, held `boolean` | per §3.4 |
| `arith` | `int` when both are `int` and `op` is not `div`; else `decimal`; held `number` | numeric (form profiles coerce text) |
| `quotient` | `int` | both `int` |
| `negate` | the operand's numeric type | numeric |
| `concat`, `format-date`, `itext`, `choice-name` | `text`, held `string` | any |
| `coalesce`, `if`, `switch` | the agreed branch type (`accumulateBranchType`); `coalesce` held is its values' unpacked class for every argument but the last, which keeps its node-set, unpacked by the caller (`org/javarosa/xpath/expr/XpathCoalesceFunc.java::evalBody` unpacks the arguments before the last and returns the last one's value as it evaluates), and `if` and `switch` likewise keep a branch's node-set unpacked by the caller (`XPathIfFunc.java::evalBody` returns the branch's value without unpacking it) | branches agree |
| `count` | `int` (form logic and record) | a node-set or relation |
| `date-coerce` / `datetime-coerce` | `date` / `datetime`; held `date` (`FunctionUtils.java::toDate` of a `Date` rounds it, of text keeps the clock) | text, date, datetime, number |
| `double` | `decimal`, held `number` | text, numeric, or a `Date` |
| `table-lookup` | the column type | none |
| `cases`, `table-rows`, `locations` | `{ nodes: <row kind>, cardinality }` (`one` when a predicate fixes `@case_id`, or a `[1]` closes it), never `structural`; a `cases` row typed by §1.3 | predicates `boolean` |
| `project` | `{ nodes: <value type>, cardinality and structural of of }` | a row node-set |
| `selected-cases` | `{ nodes: "text", many, structural }`, `caseIdOf` the module's type | none |
| `call` | the function's declared return (`lib/domain/expressionFunctions.ts::FUNCTION_REGISTRY`, and each Core function class's `evalBody` under `org/javarosa/xpath/expr/`) lifted onto the lattice: Boolean `boolean`, Double `decimal` except an integral function `int`, String `text`, Date `date`, `distinct-values` `sequence`; held likewise. The integral functions are `int`, `round`, `floor`, `ceiling`, `string-length`, `count-selected` and `position` (**implementation correction, 2026-10-19:** Core's `round` has one argument, and `index-of` is not integral: `XPathIndexOfFunc.java::evalBody` returns `''` when nothing matches, so its result is text or a number by data, decision 15), marked `integral: true` in `FUNCTION_REGISTRY`: Core stores an integral `Double` as `IntegerData` (`Recalculate.java::wrapData`, `isIntegral`), and step 2's manifest reader already types `count`, `count-selected` and `int` as integers (step 2 part 09, "Corpus changes") | the registry's `paramTypes`, with form coercions |
| `here` | `geopoint`, held `string` | none |
| `project-day` | held by step 6 (§1.6) | none |
| `value-list` | `{ nodes: <item type>, many }` | items agree; an item is a scalar or a `many` node-set of the item type, flattened (part 06 §3.6) |

### 3.4 Compatibility and ordering

**Record profiles** apply today's rules unchanged: `typesCompatible` (null with anything, a type
with itself, int with decimal, selects with text), `ORDERED_TYPES` (`int`, `decimal`, `date`,
`datetime`), `time-ordering` ahead of the ordered test, `isValueStorageAssignable` for case
writes, and every per-arm rule. Three additions: `boolean` compares only with `boolean`; a
`choice` is compatible with its field's select type and with `text`; and **`record-position`**:
today the Zod families keep conditions and values apart, and from step 3 the rule does, because
boolean-ness becomes a type in the union while the record dialect's positions are what keep its
round-trip law. Condition positions are a `condition`-family slot root, `and.clauses`,
`or.clauses`, `not.clause`, `if.cond`, `when-input-present.clause` and every `where` (`exists`,
`missing`, `count`, `table-lookup`); every other operand is a value position (part 02 §2.2). A
boolean arm in a value position or a value arm in a condition position is a finding. Under it
`true()` reads back by position (`match-all` in a condition, the literal `true` in a value), and
`parse(print(e)) = e` holds. `if` and `switch` take the position they stand in: in a condition
position their branches are condition positions (`if.cond` always is), in a value position value
positions, so the record dialect's `if(…)` between conditions (part 06 §7) has one reading. Which
slots admit a conditional clause is part 06's (part 06 §3.10); in a CSQL query position it is
lowered there. The form-logic rule set has no position rule: there boolean-ness is only a type.

**Form-logic profiles** apply Core's coercions (`XPathEqExpr.java::evalRaw`,
`XPathCmpExpr.java::evalRaw`, `XPathArithExpr.java::evalRaw`, through `FunctionUtils.java`) and
refuse exactly:

1. an ordering with a `time` operand (`time-ordering`);
2. an ordering or equality between `date` and `datetime` with no `date-coerce` /
   `datetime-coerce` on one side (`incompatible-values`, reason `date-datetime`), and a `datetime`
   ordered against an operand known not to be a `datetime` (a number, text, a select, a `boolean`;
   `incompatible-values`, reason `datetime-ordering`; part 03 §3.2). Finding 56's lowering is
   defined for an instant against an instant, and a bare `now() > 20000` orders whole days, the
   defect itself. An operand of unknown type has no opinion and is admitted;
3. a provably non-numeric string literal in a numeric position (today's `TYPE_ERROR`,
   `lib/commcare/validator/typeChecker.ts::checkTypes`);
4. a **structural** `many` node-set where one value is needed (`many-values`; today form logic
   admits it): a comparison operand, an arithmetic operand, a scalar function argument, a slot
   result. Structural means several by the app's shape (§3.1): a `field` or `repeat-row` read
   crossing a repeat the context node is not inside, and `selected-cases`, which a several-case
   module fills with several cases by declaration, as a repeat holds several rows (part 05 §2.5).
   A `cases` query (either source), `table-rows`, `locations`, and a `project` over any of them,
   used as one value, are admitted: only their data decides how many rows match, an author
   filtering by a unique property gets one, Core throws at run time on more than one as it does
   today, and `[1]` remains the author's way to take the first (except over search results, where
   the `order` reason of `SEARCH_RESULTS_READ_INVALID` refuses it, §1.5). Exempt even when
   structural: a node-set argument of a function that takes one (`count`, `sum`, `join`, `max` and
   the rest of part 03 §3.4's `manyArguments` table), a step predicate's own content, an `if`
   branch (its caller decides), the `count` arm's `via`, a slot whose profile expects a node-set
   (`ids_query`), and a `value-list` item, which the list flattens (part 06 §3.6).
   **Implementation correction, 2026-10-19:** the table adds `index-of`'s first argument and
   `depend`'s second and later, and admits `weighted-checklist`'s third and fourth only jointly; the
   pass-through positions (`if` and `switch` branches, `coalesce`'s last argument, `depend`'s first,
   `sleep`'s second, `cond`'s branches) carry the mark to their caller rather than exempting it; a
   step predicate's content is admitted because the step is its context node, not by a blanket
   exemption (part 03 §3.4);
5. `boolean` compared with anything but `boolean` (`incompatible-values`, reason `boolean`);
6. the literal-default rule of finding 72 (§4, "Defaults"), which admits `''` (part 03 §3.5);
7. the target facts of the slot's profile (part 03 §3.10): `day-only-on-device` where the targets
   include XF or SU (§1.5; part 04 §3.4), and, where the profile has a Postgres or CSQL target,
   `format-date-pattern-not-fixed`, `number-of-date` (part 07 §5.1) and `datetime-literal-precision`
   (part 06 §3.13).

Part 03 §2 gives the codes: `XPATH_INCOMPATIBLE_VALUES` with `details.reason`, `XPATH_MANY_VALUES`
and `SELECT_DEFAULT_NOT_AN_OPTION` in form logic, the slot's `*_TYPE_ERROR` in record slots.

Everything else coerces as Core does: text orders and adds as a number, a date-only text orders
by day, a node-set unpacks its one node. Ordering two datetimes, and comparing them with `=`,
`!=`, `in` or `switch`, is admitted and lowered (finding 56; part 04 §3.3, part 06 §3.13).

The first two rules are the outline's (the `datetime-ordering` half of rule 2 widens it, §7); the
third exists today; the fourth, fifth and seventh are new for form logic.

**What production holds** (the two read-only production scans, executed during planning; part 03
§3.2 to §3.4 hold the same reading). A few date-and-time orderings, all a date and time against a date and
time (`now()` against a relatively read date-and-time question), admitted and lowered;
no date against a date and time, no date and time against a known non-date-and-time, no `boolean`
compared with a non-`boolean`. A few structural repeat reads used as one value, in a few apps (a
`concat` in a `calculate`, a `selected` in a `relevant`), which the cutover lifts to their first
row (`[1]` on the repeat step, the only value Core reads without failing; notice reason
`repeat-read-takes-first-row`); every other structural read sits in `count`, `join`, `sum` or `max`.
`casedb` queries used as one value (mostly a slot result, the rest under `=` or `div`) are
now admitted. No `selected-cases` read (no `selected_cases` instance in stored text, part 05 §6.1),
so the cutover lifts none, and a stored one used as one value would be a `target-gate` blocker
(part 09, "The blockers"). The raw `casedb` reads of a system date production holds, and form-logic
`=` / `!=` between a date and a date and time, are the dry run's (part 03 §5.4); a `day-only-on-device` it finds
is a `target-gate` blocker. The lane's corpus
holds no mixed date against date and time and two date-and-time orderings, both date and time
against date and time (part 03 §3.2).

### 3.5 What the checker needs

`ExpressionContext` replaces `TypeContext` (`typeChecker.ts::TypeContext`). Everything it holds is
derived from the document or a rows-free Project snapshot, built once per validation pass:

- the effective catalog and its standard properties;
- form field types, the inferred Hidden Value types, field cardinality relative to the context
  node, each select's static options;
- the slot's profile (§4): admitted arms, rule set, scope and context node, row-scope stack
  (each row with its instance root and stored case type, part 03 §1.3's `RowScope`), evaluation
  targets, `patternMatching`, `ownerValues`, `operationIds` (today's flags, now profile facts);
- search inputs of the owning module, and whether the form is a no-matches form (where `input`
  is admitted) or a form whose evaluating entry carries the inline query (where
  `cases { search-results }` is, typed by that search's module; `EntryDatumSupplies.searchResults`,
  part 05 §1.3);
- each Hidden Value writer's destination type, for the writer rule of §3.2;
- worker properties (slug by UUID), organization levels and location properties;
- the rows-free lookup definition index (`lookupTables`, today's);
- the datum supplies of the owning entry and of a link's target entry, from
  `lib/domain/entryDatumSupplies.ts::entryDatumSupplies` (part 05 §1.3), passed in as a value, so
  the builder's live verdicts and the checker read the same domain half; the datum id each ref
  prints as is `lib/commcare/formLinkProjection.ts`'s and reaches the printer as its resolver
  (part 05 §1.4), because `lib/domain` cannot import `lib/commcare`;
- the translation units of the owning form (`lib/domain/translationUnits.ts::collectTranslationUnits`).

---

## 4. Slot profiles

Every stored expression slot, from `lib/domain/referenceSlots.ts` (`FIELD_REFERENCE_SLOTS`,
`FORM_REFERENCE_SLOTS`, `MODULE_REFERENCE_SLOTS`) and
`lib/commcare/xpath/carriers.ts::authoredXPathCarriers`. Arm groups:

- **Core**: `literal`, `choice`, `today`, `now`, `arith`, `negate`, comparisons, `and`, `or`,
  `not`, `if`, `coalesce`, `concat`, `format-date`, `date-coerce`, `double`, `is-blank`,
  `matches-pattern`, `match` (`starts-with`), `multi-select-contains` (`selected`), `count`,
  `call`, `match-all`, `match-none`.
- **Form reads**: `field`, `repeat-row`, `form-case`, `session-user(-property)` (both sources),
  `session-context` (all seven parse; the builder offers four until step 4, §1.6),
  `session-datum` (five kinds), `itext`, `choice-name`.
- **Instance reads**: `cases` (`casedb`, row typed by §1.3), `project`, `table-lookup`,
  `table-rows`, `table-column` (in a table row), `locations` and its row leaves,
  `selected-cases`, `prop`, `case-row-type`, `case-index`, `case-type` (in a case row). (`groups`
  is held by step 7, group 2.)
- **Inline search**: `input` in a no-matches form only (an inline-search module's ordinary forms
  are held by step 4, §1.6); `cases { source: "search-results" }` and its row leaves where the
  evaluating entry carries the inline query, a search-first module's menu forms and that session's
  link slots after the form (part 05 §2.8), Preview supplying the results set the search
  returned to that form (part 07 §3.2). Admitted from pull request 9, instances and
  session, which emits its declaration (part 03 §3.8).
- **Record (R)**: the slot's arms and leaves exactly as admitted today, plus the step-3 widenings
  a slot's targets can run (the typed CSQL part decides which CSQL slots take which), under the
  record rule set with `record-position` (§3.4).
- **Chosen case** (from pull request 10, CSQL): `term session-datum` of the `selected-case` kind,
  and that case's property, the one `project` shape a record slot admits:
  `project { of: cases { source: "casedb", where: [eq(prop { caseType: T, property: "case_id" }, session-datum { selected-case, module })] }, value: prop { caseType: T, property } }`,
  `T` the module's case type (the datum's `caseIdOf`, §1.3 rule 2). Admitted in the three record
  slots evaluated after an earlier menu's datum is supplied: a form's `displayCondition`, the
  `caseListConfig.filter` (on the device, in Preview's Postgres read and in its CSQL runtime
  segments) and an advanced search input's `predicate` (in its CSQL runtime segments, part 06
  §3.9). The record dialect spells them `chosen-case('<menu name>')` and
  `chosen-case-property('<menu name>', '<property>')` (§2.4; part 02 §2.2), and the card editor's
  value source menu offers "The case chosen in <menu>" and its properties (part 02 §4.5). The
  entry-supply rule checks each read: the menu is one the evaluating entry passes through and
  its datum is supplied before the slot evaluates, else `SESSION_DATUM_NOT_SUPPLIED` over identity
  (§1.5; part 05 §1.6). A case list's filter and an advanced search input are evaluated at the
  module's case list step, which HQ writes into every entry the list runs in, so a read there is
  refused where the datum's id differs between those entries (`details.reason` `differs`) and where
  the menu's case is chosen at or after that step (`not-before`) (part 05 §1.3, "One id per slot";
  part 06 §3.9). Only `selected-case` is admitted, because what a person narrows a search,
  a list or a display condition by is a case chosen earlier; the other four kinds name a form's own
  creates, the worker's record and a tile group's parents. A module's `displayCondition` admits
  neither: its scope is global, before selection (the table below), when no menu's datum is
  supplied yet. Preview supplies the
  datum from `entrySessionData`, which already serves the Search screen (part 07), and part 08 adds
  a scenario to `targeted-csql-composition`.

Targets: **XF** XForm (Core in form entry), **SU** suite XML (Core's session and entity code),
**HQ** HQ JSON (HQ's build, `interpolate_xpath` where named), **CS** CSQL (HQ's case search),
**PG** Postgres (`lib/case-store/sql`), **PV** Preview's engines. Family is the authoring wire
family (`lib/agent/authoring/schema.ts`).

| Slot | Family | Arms | Scope and context node | Targets | Rule set |
|---|---|---|---|---|---|
| field `relevant` | xpath | Core, form reads, instance reads, inline search | form; the field's node | XF, PV | form |
| field `validate` | xpath | same; `.` is the answer | form; the field (Core substitutes the candidate answer) | XF, PV | form |
| field `calculate` (hidden) | xpath | same | form; the field | XF, PV | form |
| field `default_value` | xpath | same; a literal on a static select is a `choice` | form; the target field (setvalue context) | XF, PV | form + defaults rule |
| field `required` | xpath | same | form; the field | XF, PV | form |
| repeat `repeat_count` (required on a count-bound repeat) | xpath | same | form; the repeat's parent | XF, PV | form |
| repeat `data_source.ids_query` (required on a query-bound repeat) | xpath | same; result a node-set of case ids | form; the repeat wrapper | XF, PV | form |
| prose parts (`label`, `hint`, `help`, `validate_msg`, `option_label`, catalog prose) | text | the four prose reference kinds only (§7) | form; the question | XF (`<output>`), PV | form |
| lookup select `optionsSource.filter` | condition | R + `table-column`, earlier fields | table row; the question | XF itemset, PV | record |
| cases select `optionsSource.filter` | condition | R (`prop` the candidate, `form-case`, earlier fields) | case row (candidate); the question | XF itemset, PV | record |
| form `displayCondition` | condition | R + chosen case | session; the selected case as row when `isCaseFirstModule` | SU `<command relevant>`, HQ `form_filter` (interpolated), PV | record |
| form link `condition` | xpath | Core, `form-case`, `session-*`, `session-datum`, instance reads (lookup root `item-list:<tag>`), `cases { search-results }` when the source form's entry carries the inline query (part 05 §2.8); no `field`, no `selected-cases` | session after the form; no context node | SU `<create if>`, HQ `form_links[].xpath`, PV | form |
| form link `datums[].xpath` (required) | xpath | same | same | SU, HQ, PV | form |
| form link `datums[].name` | `datum` (part 02 §3.6) | a `FormLinkDatumName`: a `selected-case` of the **target** entry only (part 05 §1.5) | target entry | SU, HQ | none |
| Connect `user_score`, `entity_id`, `entity_name` | xpath | Core, form reads, instance reads | form; the Connect block node | XF | form |
| case operation `condition`, `writes[].condition` | condition | R + submission (`field`, `id-of`, `table-lookup`) | form at submission; the operation's iteration | XF case blocks, PG submission | record |
| case operation `writes[].value`, `name`, `rename` | value | same | same | XF, PG | record (storage assignment) |
| case operation `owner` | value | same + owner leaves | same | XF, PG | record |
| case operation `target.expr`, `links[].target.expr` | value | same, no `id-of` | same | XF, PG | record |
| module `displayCondition` | condition | R, no case data, no `input` | global, before selection | SU `<menu relevant>`, HQ `module_filter`, PV | record |
| `caseListConfig.filter` | condition | R + chosen case; in CS, `if` / `switch` with clause branches per part 06 §3.10 and `today` as a runtime segment (part 06 §3.4) | case row (`casedb` or `results`) | SU nodeset, HQ short filter (interpolated), CS `_xpath_query` when Search is effective, PG | record |
| calculated column `expression` | value | R + `here` | case row | SU detail, HQ calculated column, PG, PV | record |
| `searchInputs[].via` | relationship | `RelationPath` | none | CS, PG | none |
| `searchInputs[].default`, hidden `value` | value | R, global (no case data; `value` no `input`) | global, screen open | SU `<prompt default>`, HQ `default_value`, PV | record |
| `searchInputs[advanced].predicate` | condition | R + CSQL additions (part 06), the chosen case in its runtime segments, `closed_on` from the search-only table (the only slot whose targets exclude SU and XF today), `if` / `switch` per part 06 §3.10 | case row (server) | CS, PG | record |
| `searchInputs[select].options.filter` | condition | R, table row | table row | SU itemset, PV | record |
| `searchInputs[].required.when`, `validation.rule` | condition | R, `input` of itself and siblings, `matches-pattern` | Search screen | SU (Web Apps), HQ (interpolated), PV | record |
| `caseSearchConfig.searchButtonDisplayCondition` | condition | R, global | global | SU `<action relevant>`, HQ, PV | record |
| `caseSearchConfig.excludedOwnerIds` | value | R, global + `input` | global | SU nodeset, CS data value, PG | record |
| catalog `properties[].required`, `.validation` (and `validation_msg`) | none | none | none | none | retired: decided with the person, 2026-10-17 (below) |

"Form" scope admits the inline-search group's `input` only in a no-matches form and its
`cases { search-results }` only where the evaluating entry carries the inline query; elsewhere a
read of either is the refusal of §1.5 (`INVALID_SEARCH_REF`, `SEARCH_RESULTS_NOT_SUPPLIED`). A
lookup root prints by the slot's target (§2.3): the bare tag in XF slots, `item-list:<tag>` in SU
and form-link slots. HQ JSON slots marked "interpolated" pass through HQ
`app_manager/xpath.py::interpolate_xpath`, which replaces `#user`, `#session/`, `#case`, `#parent`,
`#host` as substrings and every unquoted non-decimal `.`; the emission part owns that the wire
serializer never writes either, as today's emitters avoid them by shape.

**Defaults (finding 72).** In a `default_value` of a select whose choices are inline options, a
string literal must equal the value of one option (single select) or be space-separated values of
options (multi select); it parses to a `choice` leaf, and a literal that matches none is
`default-not-a-choice`. `''` is admitted: it is no starting value, because
`Recalculate.java::wrapData` turns `''` into no value and `attachChoice` never runs (part 03 §3.5).
A computed default stays admitted, and a select whose choices come from a lookup table or cases
takes any default, because Core returns before matching for dynamic choices
(`Selection.java::attachChoice`). The same `choice` binding applies to a literal opposite a static
select in a comparison, `selected`, `in` or `switch`; there a literal that matches no option stays a
text literal with no finding, because Core runs it and it is simply never true. A literal a Hidden
Value or a case operation writes into a property that a static select preloads is held to that
select's options the same way (§1.5; part 03 §4.3), and a computed write stays admitted; the
cutover's dry run counts what production holds, and any is a `target-gate` blocker the author
resolves (part 09, "The blockers"). Production (the two
read-only scans) holds no literal default outside its options; many literals opposite a static
select match an option and lift to `choice`, and some match none and stay text literals, in record
slots as in form logic. The lane's corpus holds 40 literal select defaults in 19 fuzz documents,
every one the drawn `'a'`, and 20 of them in 12 documents are none of their options; pull request
5's generator map rewrites them (part 08 §3.3).

**Catalog `required` / `validation`: retire (decided with the person, 2026-10-17).** They are
stored XPath with no runtime: no emitter writes them, no field is seeded from them
(`lib/agent/contentProcessing.ts::applyDefaults` docblock: "Hint, requiredness, and validation stay
on each contextual form field"), and their readers are their own gates
(`lib/commcare/validator/rules/app.ts::catalogXPathCompatible`, `catalogTimeOrdering`), the
rename cascade (`lib/doc/casePropertyRenames.ts`) and the retype gate:
`lib/domain/caseRetype.ts::isRequiredCaseProperty` treats a property with any non-empty
`required` as required, `planCaseRetype` lists such destination properties the operation does not
unconditionally write in `missingRequired` and marks the plan not `safe`, and
`lib/commcare/validator/rules/caseOperations.ts` refuses that retype under
`CASE_OPERATION_RETYPE_UNSAFE`. Keeping them typed would give a fourth profile
(no context node, no target) that exists only to check text no reader runs, and a rule a person
sets that never takes effect is a promise Nova does not keep; the alternative, a typed slot with no
target, was rejected for that reason. From step 3 `casePropertySchema` drops both and
`validation_msg`; the cutover removes stored values, which production holds in many apps, and
names each in the app's notice. `generateSchema` and `updateCaseProperty` lose the three inputs in
pull request 3, the projection, which changes their served schemas there (both already in that pull
request's changed set, §6.3; part 02 §3.6); the stored fields, their two rules and their rename
branches leave in pull request 5, the shape, so between the two a stored value is still validated
and simply cannot be authored. With the slots gone, `catalogXPathCompatible`, `catalogTimeOrdering`
and `CASE_PROPERTY_XPATH_INCOMPATIBLE` leave with them (part 03 §2.3), and no `catalog` profile
exists.

**The retype gate loses its requirement arm** in pull request 5. From step 3 no catalog property is
required, so `isRequiredCaseProperty`, `CaseRetypePlan.missingRequired` and `planCaseRetype`'s
`writtenProperties` argument (which exists only to satisfy a requirement) leave, and `safe` is
"both case types are known". A retype that only an unwritten required destination property refused
is admitted from step 3, because that requirement was a rule no form or device ever enforced.
`CASE_OPERATION_RETYPE_UNSAFE` keeps its other arms: the deterministic-key create, an unknown
source or destination type (its message names the unknown schema, no longer missing values), and a
retype that is not wire-portable. Pull request 5 changes `lib/domain/caseRetype.ts`,
`lib/commcare/validator/rules/caseOperations.ts` (the conditional-write filter that fed
`writtenProperties` leaves with it), `lib/domain/__tests__/caseOperations.test.ts` (the
`missingRequired` expectations leave; the parked and converted ones stay) and
`lib/commcare/validator/__tests__/caseOperations.test.ts` ("admits only wire-portable retypes after
destination requirements are met" loses its fixture's catalog `required` and its conditional-write
case, and keeps its parked-value refusals and its portable retype), and
rewrites the "missing requirements" clause of `lib/case-store/CLAUDE.md`'s retype paragraph.

**Required slots and absence** (§1.1). Absence is the only way a slot holds no expression. Today
form logic stores an empty value as `{ parts: [] }` (executed during planning by part 02:
`relevant: ""` is stored as `{"parts":[]}` and admitted) and readers test emptiness; from step 3
they test presence. Three slots require an expression: a form link's `datums[].xpath`, a
count-bound repeat's `repeat_count` and a query-bound repeat's `ids_query`; each refuses absence
with its existing message (`EMPTY_REPEAT_COUNT`, `EMPTY_IDS_QUERY` read the slot's absence, part 03
§2). Every other slot is optional: absence is its clear, and an absent Connect slot takes its
default, so `CONNECT_EMPTY_XPATH` leaves (part 03 §2.3). The cutover lifts every stored
`{ parts: [] }` to absence in an optional slot. For the required slots it states each: the two
repeat slots already refuse an empty value today (`EMPTY_REPEAT_COUNT`, `EMPTY_IDS_QUERY` in
`lib/commcare/validator/errors.ts`), while a link datum's `xpath` has no such rule today
(`lib/domain/forms.ts::formLinkDatumSchema` holds any `xpathExpressionSchema`). Production holds an
empty expression only in an optional slot (a `relevant`), which lifts to absence, and none in a
required slot: its form links hold no manual datum, so the lift refuses nothing.

---

## 5. Identity, renames, moves and removals

| Identity | Stored as | Rename | Move | Removal |
|---|---|---|---|---|
| field | `field.uuid` | reprint; nothing rewritten | reprint; relative paths re-derive from the new positions; a path whose `climb` is no longer a common ancestor cannot print, so the move is refused naming the read | refused while referenced (today's dangling-identity rule, `lib/commcare/validator/index.ts`) |
| query repeat row | `repeat-row.repeat` | reprint | reprint | refused while referenced |
| case property | `(caseType, property)` on `prop`, `form-case`, `project` values, case-query row leaves | `renameCaseProperties` rewrites every leaf by its destination type (`lib/doc/casePropertyRenames.ts`), now including case-query predicates and selections (each typed by §1.3, so a case-query read has its row's type, a bound untyped read its stored bound type; an absent-type standard read has no edge, since standard properties are never renamed); a read whose destination the checker resolves to several types is renamed when the batch renames that property on each, else the batch is refused naming the read (today such a read is skipped, `lib/domain/predicate/rewrite.ts` docblock) | none | the existing retirement and removal rules |
| case type | name on `prop.caseType`, `form-case.caseType`, `case-type`, relation hints | **none from step 3** (§7): a case type's name is also every stored case's `case_type` on devices, in HQ and in Postgres, so renaming it is a data migration, not a reprint | none | retirement refused while referenced (`lib/doc/caseTypeRetirement.ts`), now counting case-query reads, a bound untyped read included; an absent-type read names no type and blocks none |
| relation identifier | `RelationStep.identifier`, `subcase.identifier`, `case-index.identifier`, link and tile-grouping identifiers | none (name-backed, as today) | none | none |
| session datum | `DatumRef` (five kinds) | reprint: the derived id follows the entry (`case_id` becomes `case_id_<type>` under root alignment; `new-case` / `new-child-case` follow the datum the case block reads, §1.2); a menu rename reprints a record slot's `chosen-case('<menu name>')`, and a property rename its `chosen-case-property` through the `prop`'s `(caseType, property)` edge | reprint; when the entry no longer supplies a stored ref, the checker refuses the batch (`SESSION_DATUM_NOT_SUPPLIED` over identity, finding 68), naming the read; text naming an unsupplied id never becomes a ref (`unknown-datum`, part 02 §1.4) | the source module's or form's removal refused while read |
| form-link datum name | `FormLinkDatumName` (`selected-case` of the target entry) | reprint | reprint | as above |
| worker property | UUID | reprint (`#user/<slug>`, `session/user/data/<slug>`) | none | refused while referenced (`userMutations.ts`, today) |
| external worker field | name | none (no entity) | none | none |
| search input | UUID | reprint (`#search/<name>`, the instance field name) | none | refused while referenced |
| lookup table / column | UUIDs | reprint: a tag rename reprints the root (bare or `item-list:` by the slot's target, §2.3) and `/<tag>_list/<tag>`, a column rename its step | none | refused while referenced (`lib/doc/lookupReferences.ts`, with part 05's four form-logic extractors) |
| location level / property / place | UUIDs | a level code is create-once; a property slug rename reprints `location_data/<slug>` | none | refused while referenced |
| static choice option | `choice.options` (option UUID) | a value edit reprints every `choice` | none | refused while a `choice` or a default reads it, as every other identity; a source replacement or kind conversion turns each `choice` into a text literal of its current value (part 02 §4.6) |
| translation unit | `itext.unit` | reprint (the itext id is a projection) | reprint | the owner's removal refused while read |
| `jr:choice-name` field | `choice-name.field` | reprint the path | reprint | refused while referenced |
| case operation | `id-of.opUuid` | unchanged | none | unchanged |

The reference index (`lib/doc/referenceIndex.ts`) indexes every identity above; the keys it lacks
today (datum, option, translation unit, location property) are the index part's (part 02 §5.1;
datum keys per part 05 §1.7). A standard read with no stored `caseType` (§1.3) adds no case
property or case type key. Held constructs (§1.6) add no key in step 3. The rename review
(`lib/doc/casePropertyRenameImpact.ts`) counts case-query reads under `typed-reads`, so a person
renaming a property is told about them.

---

## 6. Zod, registry and the authoring projection

### 6.1 Package layout

`lib/domain/expression/` replaces `lib/domain/predicate/` and `lib/domain/xpath/`:

| File | Holds |
|---|---|
| `types.ts` | `termSchema` (every leaf), `expressionSchema` (the union), the supporting shapes, the three slot-family schemas (§6.2), the drift guard, the registry ids |
| `typeChecker.ts` | `checkExpression` over both rule sets |
| `ruleSets.ts` | the two rule sets: `typesCompatible`, `ORDERED_TYPES`, the coercion tables and the inverse rules the card editor reads (part 03 §1.1) |
| `context.ts` | `ExpressionContext`, its one builder `slotContext(doc, slot, lookupTables)` and the per-document facts `expressionFacts(doc)` (part 03 §1.3) |
| `profiles.ts` | the slot profiles of §4, keyed by `referenceSlots.ts` slot id |
| `inference.ts` | `inferExpressionTypes(doc)`, Hidden Value and effective-catalog type inference (the fixpoint of §3.2), which `expressionFacts` calls |
| `print.ts` | the form-XPath printer (today `lib/domain/xpath/print.ts`) with its print context |
| `walk.ts`, `mapAst.ts`, `rewrite.ts`, `simplify.ts`, `reduction.ts`, `builders.ts`, `normalizeRelation*.ts`, `slotConstraints.ts`, `dateSearch.ts`, `distance.ts`, `numericType.ts`, `temporalType.ts`, `jsonSchema.ts`, `errors.ts` | today's modules, moved and widened |
| `CLAUDE.md` | rewritten for the model (the outline, "Contracts"; part 10 gives each sentence), its carried headings written "Blank semantics: a locked invariant" and "`matches-pattern`: one leaf, one runtime" |

The form-XPath parser stays in `lib/commcare/xpath/expressionAst.ts` (it needs the Lezer grammar,
which lives in `lib/commcare`); the record dialect stays in `lib/agent/authoring`. The TypeScript
type is `Expression`; `ConditionArm` / `ValueArm` / `InstanceArm` are named subsets of its arms
for narrowing in the card editor and emitters, not stored distinctions.

### 6.2 Zod mechanics

- `expressionSchema: z.ZodType<Expression>` is a `z.discriminatedUnion("kind", …)` whose
  recursive slots are `z.lazy(() => expressionSchema)`, with hand-declared TypeScript arms and a
  drift guard, exactly as `types.ts` does today and for the same two reasons (Zod issues #4264,
  #5035, cited there).
- The comparison arm keeps `kind: z.enum(COMPARISON_KINDS)` in one object schema.
- Three slot-family schemas, each a distinct `z.lazy(() => expressionSchema)` (so each has its
  own definition object for the family map, `lib/agent/authoring/schema.ts::families`):
  `formLogicSchema` (replaces every `xpathExpressionSchema` position), `conditionSchema`
  (every `predicateSchema` position) and `valueSchema` (every `valueExpressionSchema` position).
  They parse the same language; the family decides only the authoring grammar and the served
  description.
- The leaf schemas the family map names today (`termSchema`, `propertyRefSchema`, … ,
  `relationPathSchema`, `tableLookupExpressionSchema`, `idOfSchema`, `actingUserSchema`,
  `unownedSchema`) stay distinct schema objects, so positions that use one directly keep their
  family.

### 6.3 Registry ids and the served schemas

Today `z.globalRegistry.add` names nineteen schemas at the end of `types.ts` (`Predicate`,
`ValueExpression`, `Term`, `RelationPath`, …). `authoringJsonSchema` runs `z.toJSONSchema(…,
{ reused: "ref" })` and its `override` replaces each family position's JSON with the family's
string schema; `pruneDefinitions` drops what nothing reaches.

Executed during planning, with scripts run by `npx tsx --conditions=react-server` from the repo root
over Nova's own modules at `5cf6e327` (no network, no paid call):

- Over the shared tool registry: of 103 shared tools, 20 carry expression families. The definition
  names they serve are `Predicate` and `ValueExpression` (in `configureCaseList`,
  `addCaseOperations`, `updateCaseOperation`, `addSearchInputs`, `updateSearchInput`), positional
  `__schemaN` names for the `xpath` family (`addFields` `__schema18`, `editField` `__schema16`,
  `updateForm` `__schema3`, `generateSchema` `__schema17`, `updateCaseProperty` `__schema10`,
  `configureConnect` `__schema12`), and inline family schemas elsewhere. No tool serves a
  `reference` position.
- Over seven carrying tools' definition names: the surviving `__schemaN` numbers have gaps
  (`addFields`: `__schema0`, `__schema8`, `__schema18`; `configureCaseList` up to `__schema62`),
  the numbers pruned nodes took.
- On Zod itself: an overridden node's subtree still numbers its reused unnamed nodes, shifting
  every later `__schemaN`; a registered node inside it takes its name and no number.
- Through the real `authoringJsonSchema`: today the `xpath` subtree takes one number and the
  `Predicate` and `ValueExpression` subtrees eighteen each.

So the served bytes depend on how many reused unnamed nodes the canonical subtree holds, in
traversal order. Any change to the canonical model, the step-3 union included, renumbers the
`__schemaN` definitions after the first family position in every carrying tool, even with the
family names, descriptions and registry ids kept. Byte identity is not reachable by naming alone
(§7).

**Decision.** `authoringJsonSchema` replaces family positions *before* Zod walks the schema: it
maps the input Zod schema once, substituting each family node with that family's string schema
(the same identity test, `familyOf`), and runs `z.toJSONSchema` on the result. From then on the
served bytes depend only on the authored surface. The registry ids `Predicate` and
`ValueExpression` move onto `conditionSchema` and `valueSchema`, so those two definition names and
every family description stay; the `xpath` family stays unregistered. The canonical union's own
leaves stay registered for any other `z.toJSONSchema` caller.

**What changes the served schemas, exactly:** the one-time renumbering of `__schemaN` names in
the tools whose surviving unnamed definitions follow a family position (at most the 20 carrying
tools), and the three retired catalog inputs of `generateSchema` and `updateCaseProperty` (§4). The
set is found by hashing every shared tool's served schema
(`authoringToolSchema(name, schema).inputSchema.jsonSchema`) at each pull request's base and head
with `scripts/inspect-tool-schema-hashes.ts` (all 103 shared tools, not only the 20 that carry a
family, so it shows when a change moved no other tool), recorded in the pull request's description
(part 02 §3.6). No snapshot is committed: `lib/mcp/__tests__/servedSchemas.test.ts` holds none (it
compiles every served schema with Ajv and every pattern with the Rust engine), and
`lib/doc/CLAUDE.md` says schema inventories and their snapshots are not behavior evidence. Executed
during planning, the same hash over all 103 shared tools at `main` `5cf6e327` gave the set hash
`331dbe9a23e7`, identical on two runs, so the projection is deterministic and a base/head comparison
is meaningful.

**Where it lands** (part 02 §3.3, §3.6, §3.7). The projection change is pull request 3, the
projection, below pull request 5, the shape, so it renumbers the `__schemaN` definitions once
against today's model and pull request 5 shows no hash moved. Pull request 3 also carries the three
removed catalog inputs and adds `scripts/inspect-tool-schema-hashes.ts` as a repository tool (part
10). The `datum` family on the form-link datum name (part 02 §3.6) lands with session datum identity
in pull request 5, serving the bytes `datumInputSchema.name` serves today; nothing else in this part
changes a family's name or description. `lib/models.ts::MODEL_CONTEXT_VERSION` moves in each pull
request that changes model-facing schema or prose: pull request 3 here, 5 (the parser refuses
authored text today's decoder keeps as text), 9 and 10 (guide sentences of their reads) and 12,
authoring, for the rest of the guide (part 02 §3.3). Pull request 3 registers in
`scripts/test-schema.ts` the carrying tools it lacks whose hash moves there
(`setFieldOptionsSource`, `updateCaseProperty`, `addCaseOperations`, `updateCaseOperation`;
`updateCaseProperty` moves by the retired inputs whatever the renumbering does), and a later pull
request registers any it first moves. `npm run test:schema` bills one request per schema; it is
asked once, at the stack head after the last tool change, naming exactly the registered tools whose
hash moved across the whole stack (part 02 §3.7). `../nova-plugin` teaches no expression syntax, so
it needs no bump for this.

---

## 7. Departures

Each is a deliberate departure from the outline (`docs/plans/hq-round-trip/3-expressions.md`), the
research, or a decision made with the person, with its reason.

- **The served schemas change once** (§6.3). The decision made with the person (2026-10-17) kept the
  SA and MCP authoring wire byte-identical where the slot families keep their names and
  descriptions; the runs of §6.3 show the positional definition names cannot survive a change of the
  canonical subtree. The projection makes this change the last one.
- **Canonical print changes more than spacing** (§2.5): redundant parentheses, unneeded double
  quotes, number spellings, `is-selected`, `concat()`. The decision made with the person
  (2026-10-17) names spacing; these are trivia by that decision's own rule ("No source trivia is
  stored"), each the same value to every reader, and the notice names each app's count. The spacing
  is Vellum's own, so the change lands once and an HQ form-builder save never undoes it.
- **Wildcard steps are unrepresentable** (§1.5), against the outline's "total over what CommCare
  evaluates". Core admits `*`, but a wildcard read names no identity and changes meaning silently
  when a field is added; step 6 meets it on import.
- **Case attributes beyond `case_id`, `case_type`, `owner_id`, `status`, index-node attributes and
  steps after a row value are unrepresentable** in step 3 (§1.5), for the same reason; Core holds
  `external_id`, `category`, `state` as attributes when set
  (`CaseChildElement.java::buildAndCacheInternalTree`, `::setCaseProperties`).
- **Prose keeps its stored shape** (§4). Its four reference part kinds already hold identity and
  are the `field`, `form-case` and worker leaves with a fixed spelling; changing their shape would
  re-fingerprint every translation (`lib/domain/CLAUDE.md`, "Each target entry fingerprints the
  current source") and mark every app's translations out of date. Arbitrary `<output value>`
  expressions, which HQ's editors allow, go to step 6 (import), because only an imported app holds
  them; this plan's own pull request writes that into `docs/plans/hq-round-trip/6-import.md`.
- **Nova does not author HQ's escape hatches** (§1.4, §2.4), against the outline's totality for
  record slots: runtime lists (`value-list`, HQ's `unwrap-list`), `casedb`, lookup-row and
  location reads inside a record CSQL value other than the chosen case's property (part 06 §3.9),
  and `call` in record slots exist in HQ's own editors as escape hatches, and Nova's authoring has
  its own arms for what a person builds (a fixed list is `in`; a calculated column has its arms),
  so Nova does not reproduce an escape hatch because HQ has one. These are not deferrals.
  `value-list` and those reads are held in the union (emitted, folded, compiled to Postgres where a
  profile admits them, natively proven), so step 6's import keeps them. `call` stays a form-logic arm, and step 6 admits it in record slots for import,
  owning the Postgres compilation of the functions an imported calculated column uses (Postgres
  compiles none of the 60 today); this plan's own pull request writes both into `6-import.md`.
- **A date and time ordered against a known non-date-and-time is refused in form logic** (§3.4
  rule 2; part 03 §3.2), wider than the outline's date-against-datetime requirement, because the
  lowering has nothing to lower it to and the bare comparison orders days.
- **Held constructs** (§1.6): `project-day` (step 6), `groups` / `group-field` (step 7, group 2),
  `device-query` (step 4), search inputs in an inline-search module's ordinary forms (step 4),
  authoring of three session context fields (step 4).
  The outline's items 1 to 3 name user groups, project-timezone dates and search inputs; each held
  construct depends on a model concept a later step owns or on the platform declaration, with the
  reason in §1.6, and this plan's own pull request writes each into the receiving step's outline
  file. Production holds no stored read of any of them.
- **No case-type rename** (§5), against the outline's "renames reach every reference by identity":
  a case type's name is also every stored case's `case_type` on devices, in HQ and in Postgres, so
  renaming one is a data migration, not a reprint.

### Beyond step 3

- **Close conditions.** `Form.closeCondition.answer` is a literal compared with a field, not an
  expression slot, and step 3 leaves it a literal, so an option value edit does not reprint it.
  Holding it as a `choice` would make the edit reprint it. Step 5 (case writes) takes it as a
  `choice`, because a close condition is a case-write concept that step owns; this plan's own pull
  request writes that into `docs/plans/hq-round-trip/5-case-writes-forms-navigation.md`.

---

## Executed during planning

**Nova scripts** (§6.3), run with `npx tsx --conditions=react-server` from the repo root over Nova's
own modules at `5cf6e327`, no network and no paid call: the expression families, definition names
and a hash of each of the 20 carrying tools' projected schemas; the definition names of seven
carrying tools, showing the pruned-number gaps; Zod's numbering of reused nodes inside an overridden
subtree, with and without registered ids; how many numbers today's `xpath`, `Predicate`,
`ValueExpression`, `RelationPath` and `Term` subtrees take under the real `authoringJsonSchema`; and
the per-tool served-schema hash over all 103 shared tools that every step-3 pull request records at
base and head, which pull request 3 adds as `scripts/inspect-tool-schema-hashes.ts` (set hash
`331dbe9a23e7`, identical on two runs).

**Vellum's save of canonical and lowered text** (§2.5): a lane run without the served readers on a
scratch branch, GitHub Actions run 39061476968, the lane clean. Each bind Vellum's save changed was
classed as spaces only or beyond: the three lowered comparisons changed spaces only (1,833 to 1,924,
5,173 to 5,355 and 5,143 to 5,325 bytes); the one bind beyond spaces was today's non-canonical text
(`5.0` to `5.`, `((…))` to `(…)`); the other changes were the `vellum:*` shadow attributes Vellum
adds. The first with-readers dispatches died in the Android reader runtime job, which fails main's
own nightly the same way (issue 768); the second, with that issue's fix beneath, pass that job, and
part 08 §6.4 holds their verdicts (the fix is #771).

**Vellum's numbers** (§2.5): js-xpath's `XPathNumericLiteral.toXPath` at `v0.0.10` (the version
Vellum `01215f251c57`'s `package.json` names), with HQ's `biginteger` dependency, run with plain
`node` over 22 spellings. Every shortest round-trip spelling at or above 0.000001 prints as itself;
`5.0` prints `5.`, `.5` `0.5`, `0.0000010` `0.000001`; `0.0000001`, `0.0000009` and
`0.000000000001` change value.

**Empty form logic** (§4, executed by part 02): `relevant: ""` is stored as `{"parts":[]}` and
admitted today.

**Production** (§1.3, §1.6, §2.5, §3.4, §4): two read-only, content-free scans of Nova's stored
documents, each in one `REPEATABLE READ READ ONLY` transaction, every app read, none unreadable and
no scan failure; the first run by the person, the second by planning under the person's standing
permission for read-only production reads (decided with the person, 2026-10-17). They informed the
decisions of this part without any count entering it. Part 09's content-free cutover probe
(part 09, "Executed during planning") read the untyped `casedb` reads against the catalog index and
is cited, not rerun (§1.3). What the scans cannot decide is the cutover's dry run, run at the stack
head with the production parser, printer and checker (part 02, "What remains for the cutover's dry
run"; part 03 §5.4; part 09): each untyped read's binding, every parse refusal by code, `CYCLE`
findings over lifted documents, the per-app canonical-print and `choice` counts, the bind changes
inference causes, the raw `casedb` system-date reads and the literal writes into a
select-preloaded property. Each count that can block (`case-query-untyped`, `CYCLE`, a record
verdict inference moves, `HIDDEN_VALUE_WRITER_TYPE_MISMATCH`, the select-preload writer rule,
`selected-cases` as one value, `day-only-on-device`) is a `target-gate` blocker by rule, expected
none or few, which the author resolves in the app before the window (part 09, "The blockers").

**The lane's corpus** (§1.3, §3.4, §4): a planning scan of the corpus found both untyped `casedb`
shapes (a predicate with no `@case_type` literal in 5 documents, a query with no predicate 6 times
in 5, all fuzz), no mixed date against date and time, two date-and-time orderings (both date and
time against date and time), and 40 literal select defaults in 19 fuzz documents, 20 of them in 12
documents none of their options (part 08 §3.3).

**Read at the pins:** `ASTNodeFunctionCall.java::buildFuncExpr` (76 labels),
`XPathPathExpr.java::getReference`, `::evalRaw` and `::unpackValue`, `XPathNodeset.java::unpack`,
`XPathUnionExpr`, `XPathEqExpr.java::evalRaw`, `XPathCmpExpr.java::evalRaw`,
`XPathArithExpr.java::evalRaw`, `XPathIfFunc.java::evalBody`, `XpathCoalesceFunc.java::evalBody`,
`XPathCustomRuntimeFunc.java::evalBody`, `FunctionUtils.java::toNumeric`, `::toDouble` and
`::toDate`, `Recalculate.java::wrapData` (an integral `Double`, `isIntegral`, becomes
`IntegerData`), `Selection.java::attachChoice`, `CaseChildElement.java::buildAndCacheInternalTree`,
`SessionInstanceBuilder.java::addMetadata`, `::addDatums`, `::addUserProperties` and
`::addUserQueryData`, `CommCareSession.java::setQueryDatum`, `HereFunctionHandler.java`,
`FormDef.java::initEvalContext` (`jr:itext`, `jr:choice-name`); HQ's
`fixtures/fixturegenerators.py::item_lists_by_domain` with its caller in
`app_manager/views/formdesigner.py`, `app_manager/suite_xml/post_process/instances.py::get_instance_factory`,
`::null_factory`, `::generic_fixture_instances` (registered for `item-list`) and
`::assert_no_unknown_instances`, `app_manager/xpath.py::interpolate_xpath`,
`app_manager/app_schemas/casedb_schema.py::get_casedb_schema`, `es/queries.py::DISTANCE_UNITS`,
`locations/fixtures.py::FlatLocationSerializer`,
`users/fixturegenerators.py::UserGroupsFixtureProvider.__call__`; Vellum `src/xpath.js` (imports
`xpath/dist/js-xpath` and builds its models with `makeXPathModels`) and `package.json`
(`"xpath": "dimagi/js-xpath#v0.0.10"`); js-xpath at `v0.0.10`: `src/jison/xpath.jison`
(`base_expr` sets `parens = true`), `src/models.js::printBinOp` (one space either side of every
operator, a pair of parentheses only for that mark), the function-call print (`args.join(", ")`)
and `XPathNumericLiteral.toXPath`.

**Read in Nova at `5cf6e327`:** `lib/domain/fields/selectOptionsSource.ts::caseOptionsSourceSchema`,
`lib/domain/effectiveCaseTypes.ts::concreteInferenceCaseTypes`,
`lib/domain/expressionFunctions.ts::FUNCTION_REGISTRY`, `lib/commcare/session.ts::newCaseIdDatumId`,
`lib/commcare/subcaseWire.ts::subcaseSessionDatumId`, `lib/commcare/compiler.ts` (`results:inline`),
`lib/domain/forms.ts::formLinkDatumSchema` (a datum's `xpath` has no non-empty rule),
`lib/commcare/validator/errors.ts` (`EMPTY_REPEAT_COUNT`, `EMPTY_IDS_QUERY`),
`lib/agent/authoring/printQueryExpression.ts::numeric` (`String(n)` with any exponent expanded),
`lib/domain/standardCaseProperties.ts` (the seven standard properties, `date_opened` and
`last_modified` typed `datetime`), `lib/domain/caseRetype.ts::isRequiredCaseProperty` and
`::planCaseRetype` with `lib/commcare/validator/rules/caseOperations.ts`'s three
`CASE_OPERATION_RETYPE_UNSAFE` arms, and `lib/doc/CLAUDE.md` (schema snapshots are not behavior
evidence).
