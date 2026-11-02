# Step 5, part 04: Questions

Part of [step 5's plan](../5-case-writes-forms-navigation.md), which holds the decisions, the stack
and the exit. This part covers four defects of the research's "Questions" chapter:

- **A.** Defect 25: a query repeat has a placement. Model iteration is written exactly as HQ's form
  builder writes it, and a query repeat model iteration cannot run takes the count placement, which
  keeps the wrapper and its `item` rows. A publish holds the placement, and an edit that strands a
  held model iteration moves it as a stated identity edit (§1).
- **B.** Defect 30: a repeat count is a whole number in Nova's types, a direct count needs no copy,
  and the cutover writes `int(...)` around a stored count that is not one (§2).
- **C.** Defect 27: `group.fieldList`, the rule that keeps a repeat workers add entries to off a
  shared screen, and Android's pager in Preview (§3).
- **D.** Defect 28's markdown half: `plainLabel` on question labels, container labels and inline
  choices (§4). Defect 28's preload half is part 01's.

`holdPlacements`, `publish-placement` and the kernel rule that decides who records a hold are part
03's. The held placements of case operations, `HELD_PLACEMENT_INEXPRESSIBLE` and the operations'
move planner are part 01's. `withIdentityMoves`, the one dialog and the SA and MCP result field are
part 07's. The register, the targeted documents and the native families are part 08's, and the
cutover's steps and notice table are part 09's. This part gives each of them what it needs from
query repeats, counts, field lists and plain labels, and names each pull request it changes.

Citations are `path::symbol` for Nova at `main` `2f985ed6` (#825), and `file::symbol` for CommCare
at the pins `proof/pins.json` names: commcare-hq `d6c6e16d8ae1` (paths relative to `corehq/apps`
unless named), commcare-core `8e9ba8d908e9` (paths under `src/main/java`), formplayer
`24383ac71bfb` (paths under `src/main/java/org/commcare/formplayer`), commcare-android
`7a5584475580` (paths under `app/src/org/commcare`), commcare-connect `046c7fd78081`, and Vellum
`01215f251c57`, the build HQ vendors at that pin. At `2f985ed6`,
`lib/models.ts::MODEL_CONTEXT_VERSION` is `"v5-hq-round-trip-platforms.12"`,
`lib/db/appTests.ts::RUNTIME_VERSION` is `17`, and `scripts/test-schema.ts` registers 55 entries,
`addFields` and `editField` among them. Where an execution decides a fact, the text names the
execution and writes every outcome; "Written and not yet run" at the end lists them.

## Decisions in brief

1. **A query repeat's placement is model iteration or count, decided by one structural rule.**
   `lib/domain/queryRepeatPlacement.ts::queryRepeatPlacementNeeds` lists what model iteration
   cannot run: the repeat sits inside another repeat, its query reads a form answer, or a group
   around it shows on a condition that can change while the form is filled in. With no need, the
   repeat is model iteration; with any, the count placement (§1.3).
2. **Model iteration is written exactly as HQ's form builder writes it**
   (`Vellum/src/modeliteration.js`): `@ids` and `@count` set at `xforms-ready`, `@index` and `@id`
   at `jr-insert`, an absolute `@current_index` calculate, the repeat's condition on the row, and
   `vellum:nodeset` and `vellum:jr__count` on the repeat. A form-builder save is a fixed point
   (§1.4).
3. **The count placement keeps the wrapper and its `item` rows.** The wrapper holds
   `nova_query_ids_<repeat>` and `nova_query_count_<repeat>`, each row holds
   `nova_query_id_<repeat>`, and a row past the end of the current result is not relevant, so it is
   hidden, not submitted and writes no case. No authored answer path moves between placements; only
   Nova's generated nodes do (§1.5).
4. **Text spells both placements as model iteration does.** `formNodeProjection` gains a surface:
   the parser, the printers and Preview read `"authoring"`, the emitters `"wire"`. So
   `current()/../@id`, which the SA is taught, reads a row's record id in both placements, and a
   placement move rewrites no text anyone reads (§1.6).
5. **A publish holds the placement, and only a stranded model iteration moves.** From pull request
   3 a query repeat stores `placement`, which every export reads first; from pull request 5 it is
   written only by `holdPlacements`, and before then only test fixtures and specs hold one. A held
   model iteration the candidate leaves out of shape is `QUERY_REPEAT_MODEL_ITERATION_SHAPE`, and
   `lib/doc/queryRepeatPlacement.ts::planQueryRepeatPlacementMoves`, composed by
   `withIdentityMoves`, appends the move to `count` with its stated sentence. A held count never
   moves (§1.7).
6. **Preview plays each placement.** Model iteration keeps today's snapshot with the condition
   evaluated per row; the count placement is live, its rows following the query by position, a row
   past the end hidden with its answers kept (§1.8).
7. **A repeat count is a whole number.** The `repeat_count` slot's expectation becomes
   `{ kind: "repeat-count" }`: the checker admits a count whose type is exactly `int`, or a read of
   a single select whose inline choices are all whole numbers. `REPEAT_COUNT_TYPE` becomes the
   checker's finding on every surface, and `count-result` types as `int` (§2.3).
8. **A direct count needs no copy.** `jr:count` names an integer question, an integer single select,
   or a Hidden Value calculated as a whole number directly; every other count, and every relative
   or current spelling, keeps `nova_count_<repeat>` (§2.4).
9. **`group.fieldList?: true` decides `appearance="field-list"`,** not the label. A group is born
   with it when its label has text and nothing in it is a repeat workers add entries to;
   `FIELD_LIST_USER_REPEAT` refuses such a repeat at any depth inside one, and the placement verdict
   refuses it before a batch is built (§3).
10. **`plainLabel?: true` turns a label's markdown form off** on a question, a group, a repeat, a
    section and an inline choice. Hints, help and validation messages carry no flag and keep their
    markdown form: no runtime reads a hint's or a validation message's, and Android reads a help
    text's, which Nova always writes, so Android always renders help as markdown (§4).
11. **A new platform feature, `plain-text`,** reads Web Apps `different` (a tag in a plain label
    shows as formatting, and every choice keeps its formatting) and Android `runs`. Preview plays
    the choices and states the tags: it renders no author HTML (§4.6, §4.7).
12. **Versions.** Pull request 3 sets `RUNTIME_VERSION` 17 → 18 (the first change to what an App
    Test evaluates) and `MODEL_CONTEXT_VERSION` `"v6-hq-round-trip-case-writes.3"` (the repeat
    descriptions it makes false). Pull request 9 changes no served tool text.
13. **Pull requests.** Query placement, the held `placement` slot it reads and whole-number counts
    land in pull request 3; the writer of holds (`holdPlacements`' query-repeat target), the held
    model iteration's rule and the move planner in pull request 5 beside part 01's held operations;
    field lists and plain labels in pull request 9. The builder controls and tool parameters are
    part 07's pull requests 12 and 13, and the billed schema check of the descriptions pull request
    3 changes is asked once, at pull request 13's head (§11, §12).

---

## 1. Query repeats and their placement (defect 25)

### 1.1 Today

`lib/domain/fields/repeat.ts::queryBoundRepeatSchema` is `repeat_mode: "query_bound"` with
`data_source: { ids_query: formLogicSchema }`. No query repeat stores a placement.

The form-node identities a query repeat owns (`lib/domain/expression/types.ts::formNodeRefSchema`,
`lib/domain/expression/formNodes.ts::formNodeGraph`): `{kind:"field", uuid, role:"query-wrapper"}`
(the wrapper `/data/r`), `{kind:"field", uuid}` (the row, projected as `item`), `{kind:"repeat",
repeat, role:"query-ids" | "query-count" | "query-position"}` (the wrapper's `@ids`, `@count`,
`@current_index`) and `{kind:"repeat-row", repeat, attribute:"id" | "index"}` (`item/@id`,
`item/@index`). `lib/commcare/xpath/formNodeProjection.ts::formNodeProjection` is the one projection
to physical names, read alike by the parser's binder (`lib/commcare/xpath/expressionAst.ts`),
`lib/commcare/xpath/formPrintContext.ts::formPrintContext`, the emitter
(`lib/commcare/xform/formExpressions.ts`), `lib/commcare/formLinkProjection.ts`, two validator rules
(`rules/caseOperations.ts`, `rules/caseOptionsSource.ts`), the editor
(`lib/codemirror/expressionEditorContext.ts`), Preview (`lib/preview/engine/formExpressionRuntime.ts::previewFormNodeProjection`,
`lib/preview/engine/triggerDag.ts`) and the native evidence producer
(`proof/native/producers/emit-expression-evidence.ts`).

`lib/domain/expression/context.ts::slotContext` evaluates a query repeat's `relevant` at the
wrapper, `ids_query` at `query-ids` with profile `{kind:"value", many:true}`.

`lib/commcare/xform/builder.ts::buildContainer` and `::buildRepeatBody` write every query repeat in
one shape: data `<r ids="" count="" current_index="" vellum:role="Repeat"><item id="" index=""
jr:template="">`; `<repeat nodeset="/data/r/item" jr:count="/data/r/@count" jr:noAddRemove="true()">`
with no `vellum:nodeset` and no `vellum:jr__count`; a calculate bind on `@count`
(`count-selected(../@ids)`, typed `xsd:int`) and one on `@current_index` (`count(../item)`); a
setvalue of `@ids` at `xforms-ready` (`jr-insert` when nested), and of `item/@index` and `item/@id`
at `jr-insert`. The repeat's `relevant` binds the wrapper.

Preview (`lib/preview/engine/formEngine.ts`, `initializeScope`'s `query_bound` branch) takes a
snapshot of the ids when the form starts, a parent row is added or a root section's page is
entered, seeds each row's `@id` and `@index` before its children, and never refreshes membership
(`lib/preview/CLAUDE.md`, "Initialization actions run in authored scope and order").
`previewFormNodeProjection` flattens the row into the repeat's own name.

The register holds 101 defect 25 entries (§6.1). A form-builder save rewrites today's shape: it
drops the `@count` calculate and the wrapper's bind and writes an absolute `@current_index`, which
breaks a nested query repeat and one under a later-relevant group, and changes every other.

### 1.2 What CommCare does

- **The form builder's model iteration** (`Vellum/src/modeliteration.js`): `setvalueData` lists, in
  document order, `ids` (`xforms-ready`, `join(' ', <query>)`), `count` (`xforms-ready`,
  `count-selected(<path>/@ids)`), `index` (`jr-insert`, `<path>/item/@index` =
  `int(<path>/@current_index)`) and `id` (`jr-insert`, `<path>/item/@id` =
  `selected-at(<path>/@ids, ../@index)`); every event is `jr-insert` when
  `mug.parentMug.isInRepeat()`. `getBindList` puts `<bind nodeset="<path>/@current_index"
  calculate="count(<absolute path>/item)">` first and writes no bind on `@count`.
  `getExtraDataAttributes` writes `ids="" count="" current_index="" vellum:role="Repeat"`, and the
  row `item` carries `id="" index="" jr:template=""` (`dataChildFilter`). `controlChildFilter`
  writes `jr:count` and `nodeset` through `util.writeHashtags` (so `vellum:jr__count` and
  `vellum:nodeset` with HQ's `rich_text: True`, `app_manager/views/formdesigner.py::_get_vellum_features`)
  and `jr:noAddRemove="true()"`. The Repeat mug's path is `…/item` (`getPathName`), so its
  `relevant` binds the row; a bind on the wrapper has no mug and is discarded on parse. On parse
  (`handleMugParseFinish`, `parseBindElement`) the four setvalues and the `@current_index` bind are
  recognized and rebuilt on save.
- **Core runs it** (`core/model/FormDef.java::createNewRepeat`): the template is copied, `jr-insert`
  actions fire before any calculate, then the new node's triggerables, so the `@index` setvalue
  reads `@current_index` before it is recomputed (0 for the first row).
  `SetValueAction.processAction` evaluates with the target contextualized to the inserted row. An
  absolute `@current_index` counts the rows under every outer row, which is what breaks a nested
  model iteration (`xpath/expr/XPathSelectedAtFunc.java` throws "Attempting to select element N of a
  list with only M elements").
- **Counts** (`form/api/FormEntryModel.java::createModelForGroup`, `core/model/FormDef.java::canCreateRepeat`):
  a count is read as `IntegerData().cast(count.uncast())`, so a count node must hold integer text;
  a blank count makes no rows; lowering a count removes none. `XFormParser` resolves `jr:count`
  through `getAbsRef`, and an absolute count path inside a repeat resolves within the current outer
  row, as Nova's nested `nova_count_` carriers rely on today.
- **`position(node)`** (`xpath/expr/XPathPositionFunc.java::evalBody`) returns
  `refAt.getMultLast()`, the 0-based multiplicity of its argument's node; HQ's own fixture writes
  `ordinal(position(..) + 1)` (`app_manager/tests/data/xform_builder/repeat_group.xml`).
- **Relevance and submission.** `FormDef.isRepeatRelevant` reads the repeat target's own condition
  and its parent's relevance; a non-relevant node is left out of the submitted instance, with any
  case block inside it.

### 1.3 From step 5: the rule (pull request 3)

`lib/domain/queryRepeatPlacement.ts` (new, a domain leaf):

```ts
export const QUERY_REPEAT_PLACEMENTS = ["model-iteration", "count"] as const;
export type QueryRepeatPlacement = (typeof QUERY_REPEAT_PLACEMENTS)[number];
export const queryRepeatPlacementSchema = z.enum(QUERY_REPEAT_PLACEMENTS);

export type QueryRepeatNeed =
	| { readonly kind: "nested"; readonly repeatUuid: Uuid }            // nearest enclosing repeat, any mode
	| { readonly kind: "query-reads-answers" }
	| { readonly kind: "ancestor-condition-changes"; readonly groupUuid: Uuid }; // nearest such group

/** What model iteration cannot run for this query repeat, nearest first. */
export function queryRepeatPlacementNeeds(form: FormStructure, uuid: Uuid): readonly QueryRepeatNeed[];

/** The placement every export, Preview and the gate read: the held one where the repeat holds
 *  one (the slot of §1.7, in this pull request), else model iteration with no need and the count
 *  placement with any. */
export function effectiveQueryRepeatPlacement(form: FormStructure, uuid: Uuid): QueryRepeatPlacement;

/** Whether `placement` can express this repeat as `form` holds it (part 03's kernel and §1.7's rule). */
export function queryRepeatPlacementExpresses(
	form: FormStructure, uuid: Uuid, placement: QueryRepeatPlacement,
): boolean; // "count" always; "model-iteration" exactly when the needs are empty
```

- **A form answer** is a term of kind `field`, `form-node` or `repeat-row`
  (`lib/domain/expression/walk.ts::expressionReadsFormAnswers`, new, over `walkExpression`). A read
  of the case the form opens on (`form-case`), a case query, a session value, a Search answer, a
  lookup table, a place or a worker property is not an answer. The test runs over the stored
  `ids_query` tree and each ancestor group's `relevant`, read through `form.expressionAt`.
- **A condition that can change while the form is filled in** reads a form answer or calls `now()`.
  `today()` is fixed for a form's entry in practice and does not count. In the query itself neither
  `today()` nor `now()` counts: model iteration takes the moment the form opens, as Vellum's
  spelling does on HQ.
- **Ancestors** are the fields from the repeat's parent up to the form root. A repeat of any mode
  among them is `nested`; a `group` whose `relevant` changes is `ancestor-condition-changes`. A
  section has no condition.
- Both functions are memoized per `FormStructure` object (a `WeakMap`, as
  `lib/commcare/xform/repeatCountNames.ts::planRepeatCountNames` memoizes) and are called only over
  a complete form: the emitters, the validator, Preview and the move planner. The parser and the
  checker never call them, because the authoring surface (§1.6) spells both placements alike.
- `lib/domain/expression/context.ts::slotContext`: the `relevant` slot of a query repeat evaluates
  at the row (`{kind:"field", uuid}`) in both placements, so a stored condition prints relative to
  the row. Identities are unchanged; only the printed path and the evaluation node move (§7.1).

Why model iteration at all, when the count placement runs everywhere: it is the spelling HQ's form
builder offers for a repeat over a query, so an HQ author sees HQ's own control, and in the shapes
the rule admits its rows are the count placement's rows, since nothing its query reads changes
during entry. Rejected: the count placement for every query repeat (an HQ author would see Nova's
generated nodes where HQ's own control exists) and model iteration everywhere with Nova's live
`@count` (today's shape, which a save rewrites).

**Departure from the research:** the research admits model iteration in the shapes import admits,
by the load-time analysis of "Load-time values". Step 5 has no import, and every model-iteration
repeat it holds is born or migrated under the structural rule, so the structural rule is step 5's
admission. Step 6 widens it to the load-time rule for imported repeats ("What other parts read from this one", for the outlines).
**Departure from the questions brief:** `now()` in an ancestor's condition counts as a change, since
a group can turn relevant mid-entry on it and leave a model-iteration repeat empty
(`questions/model-iteration-repeat-under-an-ancestor-that-core-s-load-can`).

### 1.4 Model-iteration emission (pull request 3)

For a query repeat `r` at `/data/r` whose effective placement is `"model-iteration"`
(`buildRepeatBody`), every expression built as a wire tree (`w.call`, `FormPath`), never text:

| Piece | Written |
|---|---|
| data | `<r ids="" count="" current_index="" vellum:role="Repeat"><item id="" index="" jr:template="">…</item></r>` (unchanged) |
| binds | `<bind nodeset="/data/r/@current_index" calculate="count(/data/r/item)"/>`, first among the repeat's binds, absolute as Vellum writes it; no bind on `@count` |
| the condition | `<bind vellum:nodeset="#form/r/item" nodeset="/data/r/item" relevant="…" vellum:relevant="…"/>`, the condition printed from the row, when the repeat has one |
| setvalues | in this order: `xforms-ready` `ref="/data/r/@ids" value="join(' ', <query>)"`; `xforms-ready` `ref="/data/r/@count" value="count-selected(/data/r/@ids)"`; `jr-insert` `ref="/data/r/item/@index" value="int(/data/r/@current_index)"`; `jr-insert` `ref="/data/r/item/@id" value="selected-at(/data/r/@ids, ../@index)"` |
| body | `<group>[<label/>]<repeat nodeset="/data/r/item" vellum:nodeset="#form/r/item" jr:count="/data/r/@count" vellum:jr__count="#form/r/@count" jr:noAddRemove="true()">…</repeat></group>` |

The query is printed from `@ids` (`query-ids`), as today. Every event is `xforms-ready` or
`jr-insert` as listed: a model-iteration repeat is never nested (§1.3).
`builder.ts::inDataTreeOrder` is a stable sort, so the four setvalues keep this order (wrapper
attributes, then row attributes). Gated run G1 holds the bytes against two form-builder saves.

### 1.5 Count-placement emission (pull request 3)

For `r` whose effective placement is `"count"`:

```
<r>
  <nova_query_ids_r/>
  <nova_query_count_r/>
  [<nova_query_position_r/>]          only while an expression reads query-position
  <item jr:template="">
    <nova_query_id_r/>
    [<nova_query_index_r/>]           only while an expression reads the row's index
    …authored children…
  </item>
</r>
```

| Piece | Written |
|---|---|
| `nova_query_ids_r` | `<bind nodeset="/data/r/nova_query_ids_r" vellum:nodeset="#form/r/nova_query_ids_r" calculate="join(' ', <query>)"/>`, the query printed from this node, a child of the wrapper as `@ids` is, so a relative read prints as in model iteration |
| `nova_query_count_r` | `<bind … type="xsd:int" calculate="count-selected(../nova_query_ids_r)"/>` |
| `nova_query_id_r` | `<bind nodeset="/data/r/item/nova_query_id_r" … calculate="if(position(..) &lt; ../../nova_query_count_r, selected-at(../../nova_query_ids_r, position(..)), '')"/>` |
| the row's condition | `<bind vellum:nodeset="#form/r/item" nodeset="/data/r/item" relevant="(<authored>) and position(.) &lt; ../nova_query_count_r" vellum:relevant="…"/>`; with no authored condition, the guard alone. The bind is built as today's container bind is, `relevant` and `vellum:relevant` from one wire tree |
| `nova_query_position_r` (read only) | `<bind … calculate="count(../item)"/>`, model iteration's `@current_index` after insertion |
| `nova_query_index_r` (read only) | `<bind … calculate="position(..)"/>`, equal to model iteration's 0-based `@index` |
| body | `<group ref="/data/r"><group>[<label/>]<repeat nodeset="/data/r/item" vellum:nodeset="#form/r/item" jr:count="/data/r/nova_query_count_r" vellum:jr__count="#form/r/nova_query_count_r" jr:noAddRemove="true()">…</repeat></group></group>` |

- The outer group has no label, no appearance and no bind. HQ's form builder reads it as a plain
  Group whose child is a Repeat named `item`, and no runtime draws an unlabelled group
  (`questions/group-group-ref-with-no-label-and-no-appearance-outside-a`). The modeliteration
  plugin adapts only a repeat whose parent mug is itself a Repeat, so it leaves this Group alone.
- No generated bind carries `vellum:calculate`: generated calculations never request a shadow
  (`lib/commcare/CLAUDE.md`, "Vellum dual-attribute pattern"), as the `nova_count_` carriers don't.
  Each carries `vellum:nodeset`, as the `nova_count_` carrier does today.
- **A row past the end of the current result** is not relevant: hidden, left out of the
  submission, its case blocks with it (they sit inside the row, part 02), and Preview gives it no
  operation iteration. Its answers stay in the form and show again if the result grows back to it.
  A row keeps its position: when the result changes, its answers stay with that position and its
  case operations write to the record now at that position. Lowering the count removes no row
  (§1.2). Gated run G2 holds each of these in Core, with every outcome written.
- **Names.** `lib/commcare/xform/queryRepeatNames.ts::planQueryRepeatNames(form)` (new) reserves,
  for every query repeat whatever its placement, from structure alone and before any expression is
  read, in the wrapper's namespace `nova_query_ids_<id>`, `nova_query_count_<id>`,
  `nova_query_position_<id>` and in the row's namespace `nova_query_id_<id>`,
  `nova_query_index_<id>`, each through `Namespace.allocate` after the scope's authored names are
  taken (a taken base becomes `<base>_<n>`). The wrapper's only authored name is `item`; the row's
  are the repeat's children. `lib/commcare/xform/generatedNodes.ts::GeneratedNodePurpose` gains
  `"query-ids" | "query-count" | "query-position" | "query-id" | "query-index"`,
  `GeneratedNodePlan` gains `queryIds`, `queryCount`, `queryPosition`, `queryId` and `queryIndex`
  (each by repeat uuid), and the plan's header gains the order: in a wrapper, `ids`, `count`,
  `position`; in a row, `id`, `index`, before any node an authored child of the row owns.
  Reserving in both placements keeps every generated name of a form independent of what its
  expressions read.
- **Case blocks inside a row** stay where part 02 puts them: a single repeat subcase's `<case>` is
  the row's first child (`xform/domSplice.ts::prependChildren`), so it precedes `nova_query_id_r`
  in the bytes, as HQ's build splices it.

**Departure from the research, three times.** (a) The research's count repeat has no wrapper, so a
move between placements would move every answer path; with the wrapper and the `item` row kept, no
authored answer path moves, the case blocks inside rows keep their paths, and
`lib/domain/caseWriteInventory.ts`'s "query-bound iteration follows this segment" stays true in
both. Only Nova's generated nodes differ, which is what a move states (§1.7). (b) The research keeps
rows past the end relevant with a blank case id and guards each operation on it, so a worker would
answer questions about no record; relevance hides those rows and drops their case blocks in one
place. (c) The questions brief wrote `nova_query_ids_r` only when read and evaluated the query in
every row's id calculate; Core recomputes a calculate once per triggering change, so a query in
each row would run the case query once per row on every change, where one ids node runs it once.

### 1.6 One authoring spelling, two surfaces (pull request 3)

`formNodeProjection(doc, form, { surface })`, with `surface: "authoring" | "wire"` required (no
default, so every caller names its surface):

| Identity | `authoring` (both placements) and `wire` model iteration | `wire` count placement |
|---|---|---|
| wrapper, row | `r`, `item` | `r`, `item` |
| `query-ids` | `@ids` | `nova_query_ids_r` |
| `query-count` | `@count` | `nova_query_count_r` |
| `query-position` | `@current_index` | `nova_query_position_r` |
| `repeat-row id` | `item/@id` | `item/nova_query_id_r` |
| `repeat-row index` | `item/@index` | `item/nova_query_index_r` |

Callers: `"authoring"` in `expressionAst.ts` (the binder), `formPrintContext.ts`,
`expressionEditorContext.ts` and `previewFormNodeProjection` (which keeps its flattened rows over
the authoring surface, so Preview's addressing is one for both placements); `"wire"` in
`formExpressions.ts`, `formLinkProjection.ts`, `rules/caseOperations.ts`,
`rules/caseOptionsSource.ts`, `triggerDag.ts`'s native graph (§1.8) and
`emit-expression-evidence.ts`. The wire surface reads `effectiveQueryRepeatPlacement` and
`planQueryRepeatNames`; the authoring surface reads neither, so parsing never depends on a
placement.

So `current()/../@id`, which the SA is taught (`lib/agent/toolSchemaGenerator.ts::FIELD_DOCS.ids_query`,
`lib/agent/authoring/reference.ts`), means the row's record id whatever the placement, and the
emitter prints `current()/../nova_query_id_r` in the count placement. Rejected: authoring text that
follows the wire (a placement move would change the text of every expression reading a row id,
which no author asked for).

### 1.7 Held placements and the move (pull requests 3 and 5)

**The stored slot (pull request 3).** `queryBoundRepeatSchema` gains:

```ts
/** Held once a publish first carries the repeat (`publish-placement`) or the step 5 cutover
 *  records it. Absent: every export takes the effective placement (§1.3). */
placement: queryRepeatPlacementSchema.optional(),
```

The slot lands with the concept it holds. In pull request 3 every export, Preview and the gate
read it through `effectiveQueryRepeatPlacement`, and no mutation writes it: until pull request 5
lands `holdPlacements`, only test fixtures and the targeted specs' documents hold one (part 08 sets
it directly in a spec's document). Pull request 5 adds the writer.

- An identity no author chooses: no builder control, no SA or MCP parameter. From pull request 3,
  `lib/domain/fields/index.ts::fieldPatchSchemaByKind` omits `placement` (a new
  `HELD_FIELD_KEYS = ["placement"] as const`, read by the patch builder and by `addField`'s
  payload schema), so neither `addField` nor `updateField` can carry it, and a duplicated field
  (`lib/doc/duplicateFieldMutations.ts`) starts unheld (part 03 §2.4). From pull request 5,
  `holdPlacements` (part 03's envelope, decision 4 of step 5's decisions) is its only writer, with
  the entry `{ target: "query-repeat", fieldUuid: Uuid, placement: QueryRepeatPlacement | null }`
  (part 03's `placementHoldSchema`, typed `PlacementHoldEntry`). Part 03's target admission
  (`lib/doc/mutationTargetAdmission.ts`, pull request 5) refuses a field that is not a
  `query_bound` repeat. Query repeats' own flows never write `null`; a repeat that stops being
  `query_bound` (a mode change, a kind conversion, removal) drops `placement` with its variant,
  which part 03's kernel reads as the target leaving, not as a hold changed.
- `lib/domain/expression/formStructure.ts::FormStructureField` gains `heldQueryPlacement?:
  QueryRepeatPlacement` (pull request 3), filled from the stored slot, and
  `effectiveQueryRepeatPlacement` returns it first.
- Part 03's diff writer (`lib/doc/diffDocsToMutations.ts`, pull request 5) emits a `placement`
  difference as `holdPlacements`, never as `updateField`, so `applyMany(diffDocsToMutations(prev,
  next))` reaches `next`. Before pull request 5 no document an editor reaches holds one.
- Part 03's scope (`lib/doc/incrementalValidationScope.ts`, pull request 5) gives a `query-repeat`
  hold the whole module of the field's form.

**Who holds it.** Part 03's `lib/commcare/placementHolds.ts::placementsToHold(doc)` (pull request 6)
returns, beside the operations, a hold of the effective placement for every query repeat that holds
none; holding it changes no emitted byte (part 03's property test covers query repeats). The
cutover's holds are §7.1. Part 03's kernel rule (`lib/db/placementAuthority.ts::placementChangeRefusal`,
its editor half in pull request 5) reads `queryRepeatPlacementExpresses` for this target: a held
count always expresses its repeat, and a held model iteration expresses it exactly when its needs
are empty.

**The rule (pull request 5, with the writer).** `QUERY_REPEAT_MODEL_ITERATION_SHAPE` (soundness,
located at the field, `lib/commcare/validator/rules/field.ts`): a query repeat whose `placement` is
`"model-iteration"` while `queryRepeatPlacementNeeds` is not empty. Details: `reason` (`nested`,
`query-reads-answers` or `ancestor-condition-changes`, the first need), `repeatUuid` for `nested`,
`groupUuid` and `groupId` for the condition. Messages:

| Reason | Message |
|---|---|
| `nested` | `"{repeat}" takes its rows once, when the form opens, as your published app does, and inside "{outer}" that would give its rows the wrong records. You can let its rows follow its query as the form is filled in, which moves where CommCare HQ keeps each row's record id, or keep it outside "{outer}".` |
| `query-reads-answers` | `"{repeat}" takes its rows once, when the form opens, as your published app does, so its query would run before any answer it reads is given. You can let its rows follow its query as the form is filled in, which moves where CommCare HQ keeps each row's record id, or have its query read no answers.` |
| `ancestor-condition-changes` | `"{repeat}" takes its rows once, when the form opens, as your published app does, and "{group}" around it shows on a condition that can change while the form is filled in, so its rows could stay empty. You can let its rows follow its query as the form is filled in, which moves where CommCare HQ keeps each row's record id, or show "{group}" on a condition that doesn't change.` |

In ordinary editing an author never meets this finding: the move planner appends the move before
the gate runs. It reaches a person only where a batch was built without the planner (a stale
queued batch after a publish recorded the hold, which part 03's reconciler (`PLACEMENT_CONFLICT_CODES`) classifies as a
conflict among the identity codes, and a forged autosave).

**The move planner (pull request 5).** `lib/doc/queryRepeatPlacement.ts` (new):

```ts
/** Over the candidate the batch produces: every held model iteration the candidate leaves out of
 *  shape, its hold to `count`, in document order. A held count never moves; an unheld repeat is
 *  never stated, since it takes the effective placement freely. */
export function planQueryRepeatPlacementMoves(candidate: BlueprintDoc): {
	readonly holds: readonly Extract<PlacementHoldEntry, { target: "query-repeat" }>[];
	readonly moves: readonly IdentityMove[];
};
```

Each move is `{ subject: { kind: "query-repeat", formUuid, fieldUuid }, from: "rows-set-when-opened",
to: "rows-follow-query", reason: { source: "query-repeat", reason: <the first QueryRepeatNeed> } }`
(part 07 §2.2), the need carrying the outer repeat or the group its sentence names.

`lib/doc/identityMoves.ts::withIdentityMoves` (part 07, decision 3 of step 5's decisions; pull
request 5) composes it with the other move sources over the one candidate the commit already
prepares, in this order: part 02's one source `lib/doc/moduleKindMoves.ts::planModuleKindMoves` (from
pull request 7; first, because a module's kind decides which placements part 01 then moves), part 01's
`lib/doc/placementMoves.ts::planOperationPlacementMoves` (case operations, the own close), then this
planner. It appends one `holdPlacements` carrying every hold the planners return. Part 03's rule admits that hold change by its first arm:
the batch moves a hold the same batch makes inexpressible.
The move is recorded as held at once: the repeat was published at its old shape, so the move changes
where its record ids sit in every project space it publishes to, and the new place is what Nova then
keeps. The builder states it in the one `IdentityMoveDialog` before it commits, the SA and MCP
results carry it in `identityMoves`, and `saveWork` repeats it (part 07). The facts each sentence
states, which part 07's `lib/doc/identityMoveCopy.ts` words:

- the subject: the repeat, by its label (its id where it has no label);
- from and to: "rows set when the form opens" and "rows that follow the cases found";
- the reason, one per need, by the need kinds `nested`, `query-reads-answers` and
  `ancestor-condition-changes`, which part 07's `IdentityMoveReason` takes by these names:
  `It now sits inside "{outer}".`, `Its query now reads an answer.`,
  `"{group}" around it now shows on a condition that can change while the form is filled in.` (a
  condition calling `now()` is one, §1.3, so the third sentence does not say "when answers say so");
- the consequence: each row's record id moves to a new place in the submission, so from the next
  publish CommCare HQ's exports read it from a new column. **No answer moves**: the wrapper and the
  `item` rows keep their paths (§1.5). The authoring brief's row "its answers move to a new place
  in the submission" is replaced by this sentence.

**Undo and redo.** An undo is an edit like any other: its candidate runs through
`withIdentityMoves`, and part 07's `BlueprintDocState.applyHistoryStep` derives each inverse so it
carries only the hold changes part 03's rule admits. The undo of a batch that moved a repeat
restores the old structure and the old hold, `model-iteration`, which then expresses the repeat
again. A held `count` always expresses its repeat, so the undo is not a move of a stranded hold;
part 03's rule (`placementChangeRefusal`, step 5's decisions) admits an editor batch's hold change
exactly when it (a) moves a hold the same batch makes inexpressible, or (b) restores, for a target
uuid, exactly the hold the latest recording for that uuid wrote: the latest `publish-placement` or
`blueprint-migration` row, else the greatest fold baseline's snapshot. Everything else is refused.
The undo restores the `model-iteration` a publish or the cutover recorded, so it commits by arm (b)
with no statement (it moves nothing a publish recorded), and a redo moves it again by arm (a) with
the statement. Arm (b) also admits re-creating a removed held query repeat with its hold, the undo
of its removal. An editor batch that sets a hold to `count` while model iteration still expresses
the repeat is refused by the same rule.

### 1.8 Preview (pull request 3)

- **Model iteration** keeps today's snapshot path (`formEngine.ts`, `initializeScope`'s
  `query_bound` branch): membership is taken when the form starts, a root section's page is
  entered, or (never, from step 5, since model iteration is never nested) a parent row is added.
  The repeat's condition is evaluated per row, in the same relevance cascade as a count-bound row's.
- **The count placement** takes the live path. A new `FormEngine.refreshQueryRepeat(path)`
  evaluates the query at the wrapper through the one emitter (`toWire(…, { target: "preview" })`,
  as every Preview read is lowered) whenever a dependency of the query changes, as
  `readLiveRepeatCount` reads a count. It sets the wrapper's `@ids`, `@count` (the ids' length) and
  `@current_index`, grows rows up to the count through `materializeInitializedRepeat` (never
  removing one), and sets each existing row's `@id` to the id at its position, blank past the end.
  A row whose position is at or past the count is not relevant (a new
  `FormEngine.queryRowBeyondResult(path)`, read by the relevance cascade beside the row's authored
  condition), so its answers are kept and not submitted, and it has no case operation iteration
  (`lib/preview/CLAUDE.md`'s opening paragraph). In a root section the refresh waits for the page
  to be entered, as a count-bound repeat's does.
- `previewFormNodeProjection` keeps its flattened rows (`@id`, `@index` on the row, `@ids`,
  `@count`, `@current_index` on the wrapper) over the authoring surface for both placements.
- `triggerDag.ts::collectNativeDependencies` uses the wire surface and, for a count-placement
  repeat, adds edges from every dependency of the query to `nova_query_ids_r`, from it to
  `nova_query_count_r` and to each row's `nova_query_id_r`, and from the count to each row's
  relevance and id. So a query that reads answers inside its own rows is refused by `CYCLE`, as a
  count that reads its own rows is today. A model-iteration repeat's edges are today's.
- App Tests and `lib/preview/engine/evaluateForm.ts` share the engine, so `RUNTIME_VERSION`
  becomes 18 in pull request 3.
- `lib/case-store` changes nothing: the query reads the device snapshot
  (`CaseStore.readDeviceCaseDatabase`), and `lib/case-store/sql/compileTerm.ts` keeps refusing form
  nodes.

### 1.9 Edge cases, all decided

- A model-iteration repeat inside a root section: admitted (a section is not a repeat and has no
  condition).
- A query repeat inside a group shown on one screen: admitted in both placements (§3.5).
- A count-placement repeat inside a repeat of any mode: each outer row has its own wrapper, ids,
  count and rows; `position(..)`, `../../nova_query_ids_r` and the absolute `jr:count` resolve within
  the outer row (§1.2).
- A model-iteration repeat holding a nested query repeat: the inner one is the count placement; the
  outer stays model iteration.
- A query reading `today()` or `now()`: not an answer; model iteration takes the moment the form
  opens.
- A query repeat converted to `count_bound` or `user_controlled`: `placement` leaves with the
  variant, and the data path loses `item`, the existing conversion identity change, stated as today.
- Converting a query repeat to a group stays refused while an expression reads its row id or index
  (`lib/doc/CLAUDE.md`).
- A held `count` whose needs become empty (the author un-nests it) stays `count`: a held count never
  moves, so a published app's record-id columns stay where they are.

---

## 2. Repeat counts as whole numbers (defect 30)

### 2.1 Today

- `lib/domain/expression/context.ts::slotContext` gives `repeat_count` the profile `{kind:"value"}`
  with no type, at the `count-result` node.
- `lib/commcare/validator/rules/field.ts::emptyRepeatXPath` raises `REPEAT_COUNT_TYPE` only when
  `lib/domain/repeatCount.ts::directRepeatCountReference` finds a bare absolute or hashtag `field`
  term to a non-`hidden` field whose kind is not `int`: "The count for "x" needs an integer question
  or an explicit numeric expression, such as int(number(...))." An expression, a Hidden Value or a
  relative read is never checked as a whole number.
- `directRepeatCountReference` returns a field only for a bare term to a non-`hidden` field; a Hidden
  Value read, any expression and every relative or current spelling go through
  `nova_count_<repeat>` (`planRepeatCountCarriers`), a sibling with `type="xsd:int"` and the count
  as its calculate.
- `typeChecker.ts` types a `count-result` read with the count's type, falling back to `"decimal"`.
- The checker already has the integer type since step 3 (`lib/domain/expressionFunctions.ts` marks
  `int`, `round`, `floor`, `ceiling`, `string-length`, `count`, `count-selected`, `position` as
  `integral`, and integer arithmetic types `int`), so step 5 adds only the count's expectation. The
  outline's "with the integer type added to Nova's expression types" is corrected (finding, §10).
- Preview reads a direct count by `IntegerData.cast`'s lexical rule and a carrier with Core's
  numeric narrowing (`formEngine.ts::materializedRepeatCount`).

### 2.2 What CommCare does

- A count is read as `IntegerData().cast(count.uncast())` (`FormEntryModel.createModelForGroup`,
  `FormDef.canCreateRepeat`); `IntegerData.cast` is `Integer.parseInt`, and anything else throws
  `XPathTypeMismatchException` "… must be a number!". A blank count makes no rows.
- `core/model/condition/Recalculate.java::wrapData`: a calculate's `Double` that is integral and
  within `int` range becomes `IntegerData` whatever the bind type; a fraction becomes `DecimalData`
  unless the bind is `xsd:int`, which truncates; a `String` result is `StringData` even under
  `xsd:int`.
- A setvalue casts into the node's bind type (`SetValueAction`), so an integer default into a decimal
  node is `DecimalData`, uncast as `3.0`, which stops a direct count; a calculate never does.
- A single select's chosen value uncasts as its value text, which `Integer.parseInt` reads when it
  is integer text (`questions/jr-count-naming-a-single-select-question-whose-every-choice`).
- `xpath/expr/FunctionUtils.java::toInt` truncates toward zero; NaN and values beyond `long` pass
  through.

### 2.3 From step 5: the expectation (pull request 3)

- `lib/domain/expression/profiles.ts::Expectation` gains `{ readonly kind: "repeat-count" }`, and
  `slotContext` gives it to `repeat_count`.
- `typeChecker.ts::checkExpression`, for that expectation, admits the expression when either:
  - the result's scalar data is exactly `int` (`scalarDataType(outcome.type?.data) === "int"`); or
  - the whole expression is a `field` term with no filters and no role, in any spelling, naming a
    `single_select` whose choices are inline (`FormStructureField.choices.kind === "inline"`) and
    whose every value matches `^[+-]?[0-9]+$` and lies in [-2147483648, 2147483647], the subset of
    what `Integer.parseInt` reads that Nova admits (ASCII digits only).
- Anything else is `expected-value` with one of three reasons:
  - `whole-number-count`: any other type, including `decimal`, `text`, a multi-select, a date, and a
    Hidden Value whose type is unknown (`_any`);
  - `count-choice-not-whole`: a read of an inline single select with a value outside the subset
    (details `select`, the select's id, and `value`, the first such value);
  - `count-choices-unknown`: a read of a single select whose choices come from a lookup table or
    cases, whose values Nova's types cannot prove.
  An expression whose type is unresolved because of an earlier error raises nothing more.
- `typeChecker.ts`'s `count-result` read types as `int`: the `"decimal"` fallback goes, since every
  admitted count is one.
- Unchanged: a count that reads its own rows stays refused (`CYCLE`), a blank count makes no rows,
  `EMPTY_REPEAT_COUNT` stays.

**Departure from the questions brief:** an integer select read is admitted in any spelling, not only
the hashtag or absolute one. A relative read goes through the carrier, whose calculate leaves the
select's text as `StringData` under `xsd:int` (§2.2), which `jr:count` parses as it parses the
select directly.

### 2.4 A direct count needs no copy (pull request 3)

`directRepeatCountReference(expression, form: FormStructure, facts: Pick<ExpressionFacts,
"hiddenTypes">)` returns the field's uuid for a `field` term with no filters, no role and the
hashtag or absolute spelling, naming:

- an `int` question;
- a `single_select` admitted by §2.3;
- a `hidden` value whose value source is `calculate` and whose inferred type is `int`
  (`facts.hiddenTypes`; `FormStructureField` gains `hiddenValueSource?: "calculate" | "default_value"`
  to tell the source).

A Hidden Value holding only a `default_value`, or a calculate that is not `int`, keeps the carrier:
a setvalue casts into its bind type (§2.2), so an integer default into a decimal node stops a direct
count, while a carrier calculate reading it is always whole. A relative or current spelling keeps
the carrier (its evaluation context, as today). Every other count §2.3 admits is an expression and
takes `nova_count_<repeat>` with `xsd:int`, unchanged. Vellum writes a count as entered
(`Vellum/src/mugs/types/group.js`), so a direct count is the shape an HQ author builds.
`planRepeatCountCarriers` keeps materializing a direct count's carrier when another expression reads
its `count-result`. Callers: `planRepeatCountCarriers`, `formEngine.ts::readLiveRepeatCount`, and
the validator, whose direct-reference branch in `emptyRepeatXPath` is removed.

### 2.5 The finding (pull request 3)

`lib/commcare/validator/formLogicFindings.ts::formLogicFinding` maps `expected-value` with the three
reasons to `REPEAT_COUNT_TYPE` (kept code; `FormLogicFinding.code`'s union gains it), located at the
repeat's `repeat_count` slot. Messages, with `{words}` from a new `repeatCountTypeWords(type)`
(`decimal` "a decimal number", `text` "text", `multi_select` "a list of choices", `date` "a date",
`datetime` "a date and time", `time` "a time", `boolean` "true or false", `geopoint` "a location",
`_any` "any kind of value", every other type "a value that isn't a whole number"):

| Reason | Message |
|---|---|
| `whole-number-count` | `The count for "{repeat}" can be {words}, and a repeat needs a whole number of rows. CommCare stops the form at a count that isn't whole. You can wrap the count in int(...) to keep its whole part.` |
| `count-choice-not-whole` | `"{repeat}" counts its rows from "{select}", and the choice "{value}" isn't a whole number, so CommCare would stop the form when a worker picks it. You can give that choice a whole-number value, or wrap the count in int(...).` |
| `count-choices-unknown` | `"{repeat}" counts its rows from "{select}", whose choices come from {a data table \| the worker's cases}, so Nova can't tell that each one is a whole number. You can wrap the count in int(...) to keep its whole part.` |

Every surface meets it through the one gate: the builder's XPath editor lints through the checker,
the SA and MCP through `parseAuthoredFormExpression` and `guardedMutate`, and the options editor's
commit meets `count-choice-not-whole` when a choice edit breaks an integer select a count reads (a
choice change re-checks its own form, `incrementalValidationScope.ts`). The builder's count editor,
its lint action and its copy are part 07's (pull request 12).

### 2.6 Preview (pull request 3)

`readLiveRepeatCount` asks the new `directRepeatCountReference`; a direct integer select or Hidden
Value is read by the lexical rule as a direct integer question is (`materializedRepeatCount(true,
…)`), and every carrier keeps its numeric narrowing. `lib/preview/CLAUDE.md`'s "Count-bound repeats
follow the emitted carrier" gains the two direct kinds.

### 2.7 Edge cases, all decided

- A count reading another count repeat's `count-result`: `int`, through the carrier.
- A Hidden Value with both sources stays refused (`HIDDEN_VALUE_BOTH_SOURCES`).
- `round(x)` beyond 32 bits is typed `int` and stops the form at runtime, as every count in the
  billions does; not refused.
- `number(#form/n)` over an `int` question is `int` (`integralOverIntegers`); over text it is
  `decimal` and refused.
- A literal `2.0` is `decimal` and refused; `2` is `int`.

---

## 3. A group shown on one screen (defect 27)

### 3.1 Today

`lib/domain/fields/group.ts::groupFieldSchema` is `containerFieldBase` + `relevant?`, with no field
list slot. `builder.ts::buildContainer` writes `appearance="field-list"` on every section and on
every group whose label registers in some language (`if (field.kind === "section" || hasLabel)`),
none on an unlabelled group. `lib/commcare/validator/rules/form.ts::formSections` refuses a
user-controlled repeat at any depth inside a section (`FORM_SECTION_USER_REPEAT`); nothing refuses
one inside a labelled group, which the emitter makes a field list, so a worker on Android can never
add an entry there (`targeted-labelled-group-repeat`, defect 27's three entries).
`lib/doc/formSectionVerdicts.ts::fieldPlacementVerdict` refuses the section case alone.
`lib/domain/platformUses.ts::fieldUses` detects `question-pages` on a section or a group whose
label shows (`groupLabelShows`). Preview's Android pager draws a screen per labelled group
(`formEngine.ts::groupDrawsAsFieldList` returns `Boolean(field.label)`). A builder group is born
labelled (`components/preview/form/newFieldDefaults.ts`, `group`), and a repeat born on a page is
count-bound at 1 (`newPageRepeat`, chosen in `FieldTypePicker.tsx` through `landingSectionOf`).

### 3.2 What CommCare does

- `form/api/FormEntryController.java::isHostWithAppearance` reads a non-repeat group whose
  appearance equals `field-list` ignoring case; `getQuestionPrompts` collects questions only and
  skips `EVENT_PROMPT_NEW_REPEAT` inside one, so a worker can't add an entry there. A nested field
  list is collected by the outer host. commcare-android pages by Core
  (`activities/FormEntryActivityUIController.java`).
- `Vellum/src/mugs/types/group.js`: `FieldList` sets `appearance="field-list"`; the Repeat's
  `repeat_count.validationFunc` returns "Repeat Count is required." when the count is blank and any
  ancestor mug is a `FieldList`. `Vellum/src/parser.js` reads exactly `field-list` as `FieldList`.
  A FieldList holds groups only with `group_in_field_list`, which HQ sets from
  `app_manager/feature_support.py::enable_group_in_field_list` (2.16 and later, above Nova's 2.57
  floor).

### 3.3 From step 5: the stored shape (pull request 9)

```ts
export const groupFieldSchema = containerFieldBase.extend({
	kind: z.literal("group"),
	relevant: formLogicSchema.optional(),
	/** Shows the group's questions together on one screen on Android. Absent: one per screen. */
	fieldList: z.literal(true).optional(),
});
```

One spelling, `true` or absent, as `hiddenFromMenu`; `updateField` clears it with `null` (the patch
schema derives it). A section stays a field list by its kind, with no slot.

### 3.4 Emission (pull request 9)

`buildContainer` writes `appearance="field-list"` exactly when the field is a section or a group
holding `fieldList`; a label no longer decides it. An unlabelled field-list group is an unlabelled
Question List (`questions/question-list-unlabelled-anywhere-else`), and a labelled group without the
flag is a plain group (`questions/group-group-ref-label-no-appearance`). The comment above the gate
is rewritten to say so.

### 3.5 The rule and the placement verdict (pull request 9)

**`FIELD_LIST_USER_REPEAT`** (soundness, located at the repeat): `formSections`' walk carries the
nearest group holding `fieldList` beside the nearest section, and a user-controlled repeat at any
depth under such a group raises it. Details `groupUuid`, `groupId`. Message:

`"{form}" has repeat "{repeat}" inside "{group}", which shows its questions on one screen, and that
repeat lets the worker add entries. The CommCare app can't add entries on a shared screen. You can
let "{group}" show one question per screen, or give the repeat a fixed count.`

Under a section the existing `FORM_SECTION_USER_REPEAT` still speaks; a repeat under both raises
only the section's. Count and query repeats inside a field list stay admitted.

**The placement verdict.** `fieldPlacementVerdict` gains the refusal
`user-repeat-in-field-list`, raised when a user-controlled repeat, or a subtree holding one, would
land under a group holding `fieldList` at any depth (`landingFieldListOf(doc, parentUuid)`, new: the
nearest section or field-list group at or above the parent, replacing `landingSectionOf` in the
verdict). `FIELD_PLACEMENT_MESSAGES["user-repeat-in-field-list"]`: `This group shows its questions
on one screen, and the CommCare app can't add repeat entries there. You can let the group show one
question per screen, or give this repeat a fixed count.` The canvas drag gate
(`landingGuards.ts::landingAllowed`) and the SA's `add_fields` and `move_field` pre-checks read it,
so the refusal comes before a batch is built.

**The builder's repeat starter.** `FieldTypePicker.tsx` chooses `newPageRepeat` (count-bound at 1)
wherever `landingFieldListOf` finds a one-screen container, so a repeat born there is admitted by
construction, as one born on a page is today.

### 3.6 Births and conversions (pull request 9)

`lib/domain/fields/group.ts::groupBornFieldList(input: { label?: ProseTemplate;
holdsUserRepeat: boolean }): true | undefined` returns `true` when the label has text
(`!proseTemplateIsEmpty(label)`) and `holdsUserRepeat` is false. It is read by:

- the builder's `newFieldDefaults.ts` group (born labelled, with no children: `fieldList: true`);
- the SA and MCP field assembly (`lib/agent/contentProcessing.ts`, where a flat batch's group is
  built), with `holdsUserRepeat` from the batch's own subtree; an explicit `field_list` (part 07,
  pull request 13) wins over it;
- `convertField` to `group` (`lib/domain/fields/index.ts::reconcileFieldForKind` stays pure; the
  `convertField` reducer in `lib/doc/mutations/fields.ts` sets `fieldList: true` on the converted
  group when its label has text and `formSectionVerdicts.ts::subtreeHasUserRepeat` is false over its
  children). A group converted to a repeat drops the flag, since a repeat holds none.

Later edits never change the flag implicitly: a label edit, a child added or removed. A user repeat
dragged into a field-list group is refused by the verdict with the sentence above.

**Departure from the questions brief:** the brief gave every new group the flag unless it held a
user repeat, labelled or not, which would turn a new unlabelled group into a one-screen page. A
group with no label stays a transparent wrapper, as today, and the birth rule is the cutover's rule
(§7.1), so a new group behaves as an old one. The authoring brief's rule (born with a label) is
adopted with the user-repeat condition added, so no surface builds a refused state.

### 3.7 The platform table (pull request 9)

- `platformUses.ts::fieldUses` detects `question-pages` on `field.kind === "section" ||
  (field.kind === "group" && field.fieldList === true)`; `groupLabelShows` is removed (its only
  reader). The cutover keeps a frozen copy of it (§7.1).
- `lib/commcare/__tests__/platformQuestionPages.test.ts` holds the detector to the builder's new
  rule: `appearance="field-list"` in the built XForm exactly where the detector reports a use, over
  a labelled group without the flag, an unlabelled group with it, a section, and a group with the
  flag nested in a section.
- `lib/commcare/surface/platformFeatureEntries.ts`: `question-pages` gains
  `questions/question-list-unlabelled-anywhere-else`.
- `lib/domain/__tests__/platformFeatureFixtures.ts["question-pages"]`: `with` a labelled group
  holding `fieldList`, `without` the same group without it.
- `lib/preview/__tests__/platformCells.ts` gains
  `"questions/question-list-unlabelled-anywhere-else@web-apps": model("form-one-screen-web-apps")`.
- No feature reads `unavailable`, so no refusal copy, picker line or cause word changes.

### 3.8 Preview (pull request 9)

`groupDrawsAsFieldList` returns `field.fieldList === true`. Running as Android, a form with no
sections pages one screen per group shown on one screen and per question outside one; a nested
field-list group joins the outer host's screen (§3.2). `FormEngine.repeatPromptPoints()` reads
"outside a group shown on one screen" where it read "outside a labeled group". Running as Web Apps
nothing changes: groups draw as cards on one page.

---

## 4. Plain labels (defect 28's markdown half)

### 4.1 Today

`builder.ts`'s `addItext` writes `<value>` and `<value form="markdown">` with the same content for
every entry: labels, hints, help, validation messages, choice labels and container labels
(`lib/commcare/CLAUDE.md`, "Markdown itext"). `lib/commcare/xform/constraintMessage.ts` writes its
own internal markdown forms beside a protected validation message. No slot stores markdown on or
off, and `ProseTemplate` (`lib/domain/prose.ts`) holds no flag. Preview renders every label through
`lib/markdown.tsx::PreviewMarkdown` with the platform's `labelMarkdown` rule
(`lib/preview/platform.ts`), hints by `rules.hint`, validation messages as plain text, and raw HTML
inert everywhere.

### 4.2 What CommCare does

- **Vellum holds markdown per itext item, for all its languages at once** (`Vellum/src/javaRosa/plugin.js`:
  loading a `markdown` form sets `hasMarkdown`; the writer writes one markdown value per language
  from the default form when it is set). Its editor offers the toggle on choices and container
  labels only with `markdown_in_groups` (`javaRosa/itextBlock.js::NO_MARKDOWN_MUGS`), on above 2.23
  (`app_manager/feature_support.py::enable_markdown_in_groups`).
- **Who reads a markdown form.** A question label: Core `FormEntryCaption.getMarkdownText`;
  Formplayer sends `caption_markdown` (`api/json/PromptToJson.java::parseCaption`); the Web Apps
  client renders `caption_markdown` through `markdown.render`, else `caption` through
  `DOMPurify.sanitize(text.replace(/\n/g, '<br/>'))` (`cloudcare/static/cloudcare/js/form_entry/form_ui.js`,
  `cloudcare/templates/cloudcare/partials/form_entry/question.html`); Android sets the markdown
  through `MarkupUtil.setMarkdown`, else the long text as written
  (`views/widgets/QuestionWidget.java::setTextFromPrompt`). A group and repeat label: the same
  through `parseCaption` and `sub_group.html`, and Android's `views/QuestionsView.java::deriveGroupText`.
  A choice label: Android `getSelectItemMarkdownText` (`QuestionWidget::setChoiceText`,
  `SelectOneWidget`, `SelectMultiWidget`); the Web Apps client renders every choice through
  `renderMarkdown` (`entry_select.html`, `entry_choice_label.html`) whatever forms exist. A hint,
  help text and validation message: Core reads the default form only (`FormEntryPrompt.getHintText`,
  `getHelpText`, `getConstraintText`); the client renders hint and help through `markdown.render`
  whatever forms exist. Android shows a hint and a validation message as written, and renders a help
  text's markdown form where it exists (`QuestionWidget.java::createHelpLayout`,
  `getHelpMultimedia(FormEntryCaption.TEXT_FORM_MARKDOWN)` → `MarkupUtil.returnMarkdown`), else its
  default form as written.
- So the markdown form changes what a worker sees only on question labels, container labels (both
  platforms), choice labels and help text (Android).

### 4.3 From step 5: the stored shape (pull request 9)

```ts
// lib/domain/fields/base.ts: fieldBaseSchema, containerFieldBase; lib/domain/fields/section.ts: sectionFieldSchema
/** The label shows exactly as written, with no markdown form on the wire. Absent: markdown. */
plainLabel: z.literal(true).optional(),
// lib/domain/fields/base.ts: selectOptionSchema, and the SelectOption type
plainLabel: z.literal(true).optional(),
```

- Every visible question kind (through `fieldBaseSchema`, the `label` kind included), `group` and
  `repeat` (through `containerFieldBase`), `section`, and an inline choice. A Hidden Value has no
  label and no flag.
- Absent means markdown, which is every stored label today, so no migration and no wire change for
  existing apps.
- A sibling slot, not a flag inside `ProseTemplate`: a text edit replaces the template, so a flag
  inside it would ride on every editor's rebuilt template, and translation entries are
  `ProseTemplate`s that must not carry a per-language flag, since CommCare holds markdown per item
  across every language (`questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk`,
  REFUSED). Rejected: `ProseTemplate.markdown: false`, the inventory's spelling.
- `updateField`'s patch carries `plainLabel: true | null` (derived). Choices are edited by replacing
  the inline options, as today, and each option carries its own flag.
- `reconcileFieldForKind` carries `plainLabel` across a conversion between kinds that both declare
  it (the per-kind key sets hold it).

### 4.4 Emission (pull request 9)

`AddItext` gains a `markdown: boolean` parameter, default `true`. The label registration of a
question, group, repeat and section passes `field.plainLabel !== true`, and each inline choice's
`option.plainLabel !== true`. With `false`, no `<value form="markdown">` is written in any language;
`<value>` and media values are unchanged. Hints, help, validation messages and the protected
message's internal forms keep their markdown form (§4.5). A label holding references keeps its
`<output>` elements in `<value>`.

### 4.5 Why hints, help and validation messages carry no flag

No runtime reads a hint's or a validation message's markdown form (§4.2): Web Apps renders a hint
as markdown and Android as written whatever the form says, and neither renders a validation
message's. A flag there would change only what HQ's form builder shows beside its markdown toggle.
A help text's markdown form is read on Android, and Nova always writes it, so Android always
renders help as markdown, as Web Apps does whatever the form says; help gets no flag either. Step 5
gives them none and keeps writing their markdown form, so nothing changes on the wire (decision 2 of
step 5's decisions). **Departure from the research**, which lists hints, help, validation messages
and options among the texts markdown is a property of. An imported hint or validation message
without a markdown form gains one on republish unless step 6 holds it. An imported help text
without one must be held, because republishing it adds markdown rendering on Android. Both are
written into step 6's outline ("What other parts read from this one").

### 4.6 The platform feature `plain-text` (pull request 9)

The surface manifest's rule is that an entry differing by platform which an author's choice reaches
is a feature's, and `plainLabel` is an author's choice, so the entries it reaches leave the ambient
list for a new feature in `lib/domain/platforms.ts`:

```ts
"plain-text": {
	label: "Text shown as typed",
	channel: "structure",
	webApps: {
		reading: "different",
		note: "a tag in the text shows as formatting, and a choice still shows its formatting",
	},
	android: { reading: "runs" },
},
```

- `PLATFORM_FEATURE_IDS` gains `"plain-text"` after `"question-pages"`.
- `platformFeatureEntries.ts`: `"plain-text": ["questions/plain-label-containing-html-text",
  "questions/choice-label-with-no-markdown-form"]`, and `questions/plain-label-containing-html-text`
  leaves `AMBIENT_PLATFORM_ENTRIES`.
- Detector (`platformUses.ts::fieldUses`): a field holding `plainLabel` gives
  `slotUse("plain-text", owner, "plainLabel")`; each inline choice holding it gives
  `slotUse("plain-text", { ...owner, kind: "option", optionUuid }, "plainLabel")`, as `choice-media`
  is detected.
- `platformFeatureFixtures.ts["plain-text"]`: `with` a text question with `plainLabel: true`,
  `without` the same question without it, `use` the field's slot.
- The field inspector's platform note row states the Web Apps difference wherever the author turns
  formatting off (`components/builder/CLAUDE.md`, the note row reads every feature of the owner's
  uses), so the builder states it with no new copy.
- The agent's guide calls no `platformSentence("plain-text")`, so the guide is unchanged.

**Departure from the questions brief**, which kept `plain-label-containing-html-text` ambient with a
rewritten reason: the ambient list holds entries no author choice reaches
(`platformFeatureEntries.ts`'s header), which stops being true here.

### 4.7 Preview (pull request 9)

- A plain question or container label renders as written, its line breaks kept and its references
  shown as chips, on both platforms (`lib/references/LabelContent.tsx` renders the text through
  `withChipInjection` over plain text instead of `PreviewMarkdown` when the owner holds
  `plainLabel`). That is what Android and the Web Apps client show for every plain label without a
  tag.
- A tag in a plain label is not played: the Web Apps client would draw sanitized HTML, and Preview
  renders no author HTML in Nova's own origin, where a Project's collaborators' sessions live, as
  `lib/markdown.tsx` keeps raw HTML inert everywhere. The difference is stated by the feature's note
  (§4.6) and the public docs (§8.3). **Departure from the questions brief**, which drew the tags
  through a new `dompurify` dependency pinned to HQ's `3.4.16`; step 5 adds no dependency.
- A choice: `PreviewPlatformRules` (`lib/preview/platform.ts`) gains `plainChoice: "markdown" |
  "literal"`, Web Apps `"markdown"` (the client formats every choice) and Android `"literal"`.
  `components/preview/form/fields/SelectOneField.tsx` and `SelectMultiField.tsx` render a choice
  holding `plainLabel` as written where the rule reads `"literal"` and through `PreviewMarkdown`
  otherwise.
- Cells (`platformCells.ts`): `"questions/plain-label-containing-html-text@web-apps":
  stated("plain-text")`; `"questions/choice-label-with-no-markdown-form@web-apps":
  browser("choice-label-plain-web-apps")`, a new scenario in `e2e/lib/previewPlatformScenarios.ts`
  played by `e2e/tests/browser/preview-platforms.spec.ts`. The two `outside(...)` rows of
  `plain-label-containing-html-text` go: its Android reading becomes `runs` (§5).

### 4.8 Authoring surfaces (part 07)

The builder's **Format text** toggle on question, group, repeat and section labels and on each
choice row, and the SA and MCP parameter `plain_label: true | null` on fields and on inline
choices, are part 07's (decision 2 of step 5's decisions; pull requests 12 and 13). Each writes
`plainLabel`; no other text carries the toggle.

---

## 5. Manifest entries and inventory rows

`lib/commcare/surface/entries/questions.json`, and the matching rows of
`docs/research/2026-09-26-hq-round-trip/inventory/questions.md` in the same pull request:

| Entry | Today | From step 5 | Pull request |
|---|---|---|---|
| `questions/count-repeat-whose-count-and-row-ids-come-from-one-query-a` | HELD-NEW | HELD (RUNS / RUNS). `item` gains "a hidden value `nova_query_ids_<repeat id>` holding the query's ids, inside the query's own group, the rows staying `item`"; `dispositionCell` "**HELD**: `repeat` `query_bound` in its count placement (§1.5's shape: the wrapper group, `nova_query_ids_`, `nova_query_count_`, `nova_query_id_`, the guard condition on `item`, and the position and index nodes only when read)"; `emission.cell` the same shape, "for a query repeat nested in another, whose query reads a form answer, or under a group whose condition can change during entry" | 3 |
| `questions/repeat-model-iteration-vellum-role-repeat-ids-count-current` | HELD, marker `save-breaking` | HELD, no marker; `emission.cell` "Vellum's canonical shape: `@ids` and `@count` setvalues at `xforms-ready`, `@index` and `@id` at `jr-insert`, absolute `@current_index`, the condition on `…/item`, only where §1.3's rule gives model iteration" | 3 |
| `questions/jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in` | HELD, cell names the copy | HELD; `dispositionCell` without "(Nova writes a `nova_count_<repeat>` copy of it today: defect 30)" | 3 |
| `questions/jr-count-naming-a-single-select-question-whose-every-choice` | HELD, `slotChanges` widen | HELD, `slotChanges` `[]`, `dispositionCell` "**HELD**: `repeat` `count_bound` naming the question directly (`REPEAT_COUNT_TYPE` admits a single select whose inline choices are whole numbers)" | 3 |
| `questions/model-iteration-repeat-nested-in-another-repeat-of-any-kind`, `…-under-an-ancestor-that-core-s-load-can`, `…-whose-query-reads-a-form-answer-that-is` | REFUSED | REFUSED, each `dispositionCell` gaining "Nova writes the count placement there (§1.3)" | 3 |
| `questions/group-group-ref-label-no-appearance` | HELD-NEW | HELD (RUNS / RUNS one question per screen), `dispositionCell` "**HELD**: a labelled `group` without `fieldList`" | 9 |
| `questions/question-list-unlabelled-anywhere-else` | HELD-NEW | HELD, `dispositionCell` "**HELD**: a `group` holding `fieldList` with no label"; joins `question-pages` | 9 |
| `questions/question-list-group-appearance-field-list-labelled` | HELD | HELD; `dispositionCell`'s "otherwise a labelled `group`" becomes "otherwise a labelled `group` holding `fieldList`" | 9 |
| `questions/user-controlled-repeat-inside-a-question-list-a-group-whose` | REFUSED | REFUSED, `dispositionCell` gaining "`FIELD_LIST_USER_REPEAT` and `FORM_SECTION_USER_REPEAT` refuse it" | 9 |
| `questions/label-with-no-markdown-form` | HELD-NEW, cell `ProseTemplate.markdown: false` | HELD (RUNS / RUNS as written), `dispositionCell` "**HELD**: `plainLabel` on a question, group, repeat or section label" | 9 |
| new `questions/choice-label-with-no-markdown-form` (split from `choice-label-text-markdown`, value class `choice-without-markdown-form`, surface keys `xform:select/item/label`, `xform:select1/item/label`, their `@ref`, `itext-form:android/markdown`) | none | HELD, DIFFERENT ("the choice still shows as formatted text") / RUNS, `dispositionCell` "**HELD**: `plainLabel` on an inline choice"; `plain-text` | 9 |
| `questions/plain-label-containing-html-text` | HELD, DIFFERENT (sanitized HTML) / DIFFERENT (literal), ambient | HELD, DIFFERENT ("a tag shows as formatting, sanitized") / RUNS ("as written", which is what a label without formatting means); `plain-text` | 9 |
| `questions/choice-label-text-markdown`, `questions/group-repeat-label-text-markdown` | HELD, cells "(markdown off is HELD-NEW `ProseTemplate.markdown`)" | HELD, cells "(markdown off is `plainLabel`)" | 9 |
| `questions/help-text-markdown-form` | HELD, cell "(markdown off is HELD-NEW `ProseTemplate.markdown`)" | HELD, cell "(Nova always writes the markdown form, so Android always renders help as markdown)" | 9 |

`questions/markdown-form-equal-to-the-default-text` (HELD, ambient) and
`questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable` (HELD-NEW `Form.plainText`)
are unchanged; the second is step 6's ("What other parts read from this one"). Each HELD-NEW entry flips in the pull request that first
emits it, on a document part 08 names ("What other parts read from this one", part 08).

---

## 6. The register

### 6.1 Entries that move (all to `proof/fixed-defects.json`, each held on its retained control)

Read from `proof/known-defects.json` at `2f985ed6`:

| Defect | Part | Check | Document → control | Entries | Pull request | Why it stops showing |
|---|---|---|---|---|---|---|
| 25 | nested query repeat | manifest | `container-nested-query` → same | 1 | 3 | the nested repeat is the count placement: no `vellum:role` |
| 25 | query repeat rewritten into model iteration (all five part names) | proof4 | `container-nested-query` → same | 27 (15, 3, 4, 4, 1) | 3 | the count placement is a fixed point of the save |
| 25 | query repeat rewritten into model iteration | proof4 | `case-operation-query` → same | 7 | 3 | canonical model iteration |
| 25 | query repeat rewritten into model iteration | proof4 | `container-query-conditional-relative` → `container-query-conditional` | 2 | 3 | the condition binds the row |
| 25 | query repeat under late relevance | manifest | `container-query-conditional-parent` → same | 1 | 3 | the count placement |
| 25 | query repeat rewritten into model iteration | proof4 | `targeted-query-repeat-places` → same | 1 | 3 | the count placement (its groups' conditions read `#form/visited`) |
| 25 | saved query repeat | proof4 | `container-query-conditional` → `container-query-conditional-after-13` | 62 | 3 | the save is a fixed point |
| 27 | user repeat in a labelled group | manifest 1, proof4 2 | `targeted-labelled-group-repeat` → same | 3 | 9 | the group holding the user repeat has no `fieldList` (§7.1's rule, applied to the document's source) |
| 30 | repeat count copy | intent | `targeted-repeat-count-copy` → same | 1 | 3 | the Hidden Value's calculate `2` is `int`, so the count is direct and the submission holds the nodes the intent expects |
| 30 | repeat count copy | manifest | `container-live-count-entry` → same | 3 | 3 | its `computed` count becomes `int(#form/second/items/size + 0.7)` in `lib/preview/engine/__tests__/fixtures/sectionEntry.ts`, the migration's rewrite |

Defect 25's 101 and defect 30's 4 move in pull request 3, defect 27's 3 in pull request 9.
`OPEN_DEFECTS` loses 25 and 30 in pull request 3 and 27 in pull request 9
(`proof/checks/registers.py`). Defect 28's three entries are part 01's (pull request 4).

### 6.2 Walk stops

None of these entries is a walk stop: the nested query repeat's Android stop is a register entry
above.

---

## 7. Migration

### 7.1 The classes this part gives the one cutover (part 09's steps)

All read and write `BlueprintDoc` only; no case-store SQL.

| Class | Source | Target | Notice (part 09's table) |
|---|---|---|---|
| Q1, query placement (step `query-repeat-placement`) | every `query_bound` repeat, no `placement` | In an app with a published deployment (part 03's definition): `placement: "model-iteration"` held where §1.3's rule gives model iteration and a `readable` baseline carries the model-iteration data shape at the repeat's `item` path (part 09 §8.3), or the app's published deployment has an `unread` baseline (decision 5 of step 5's decisions). Where the rule gives the count placement the repeat is **not** held: it takes the count placement, and the next publish records it. In an unpublished app, nothing is held. | `repeat-rows-follow-query` per repeat whose effective placement is the count placement, in any app; the deployment line `form-data-paths-move` with cause `repeat-rows-follow-query` where a published deployment's baseline held its model-iteration attributes |
| Q1′, the condition's context | a query repeat's `relevant` evaluated at the wrapper | evaluated at the row; no stored change (identities) | none |
| Q2, count wrap (step `repeat-counts`) | a `count_bound` repeat whose count §2.3 refuses | `repeat_count` = `{ kind: "call", fn: "int", args: [<old>] }` | `repeat-count-whole-number` per wrapped count |
| Q3, direct count (step `repeat-counts`) | a count that is a bare absolute or hashtag read of a Hidden Value calculated as `int`, whose `count-result` nothing reads | no stored change; the wire loses `nova_count_<repeat>` | `repeat-count-node-removed` per such repeat in an app with a published deployment; the deployment line `form-data-paths-move` with cause `count-node-removed` |
| Q4, field lists (step `field-list-flags`) | every `group` | `fieldList: true` where the frozen predicate of today's label gate (`platformUses.ts::groupLabelShows` at `2f985ed6`, which the cutover brief names `containerLabelRegisters`: a label with text in some language, translations included) holds and no user-controlled repeat is a descendant at any depth; absent otherwise. Sections are unchanged. | `group-shows-one-per-screen` per labelled group left without the flag |
| plain labels | none | none (absent `plainLabel` is today's wire) | none |

**Decision 5 and query repeats.** Decision 5 keeps every operation's and query repeat's placement
in an app whose published deployment has an `unread` baseline. For a query repeat whose rule gives
model iteration, that is the hold above. For one whose rule gives the count placement, keeping model
iteration would hold a shape `QUERY_REPEAT_MODEL_ITERATION_SHAPE` refuses and a migrated document
must pass the gate; it is also defect 25 itself, the shape whose rows are wrong. So such a repeat
moves, with its notice line and its deployment line. Step 5's decisions confirm this as decision
5's one exception, and part 09 §8.5 lists it among the units never held. Production holds a
published deployment whose baseline is `unread` (the planning scan), so decision 5's rule and this
exception both meet apps at the window.

What production holds, from the planning scan (part 09 runs it; its findings enter the repo in
words only):

- **Q1 applies.** Production holds query repeats, some of them in published apps, and some the rule
  gives the count placement: nested ones and ones whose query reads a form answer (none sits under a
  group whose condition reads an answer). Each of those gets `repeat-rows-follow-query`, each
  published one the deployment cause of it in `form-data-paths-move`, and each published query
  repeat the rule gives model iteration is held there.
- **Q2 ships with nothing to wrap today.** Every stored count already types as a whole number, so no
  `int(...)` wrap is written and no `repeat-count-whole-number` line arises. The dry run counts it;
  production holds none today. An author can still store such a count before the window (`main`'s
  `REPEAT_COUNT_TYPE` checks only a direct read), so the class and its line ship, and no blocker can
  arise from the wrap itself, since `int(...)` types `int` over every argument.
- **Q3 applies.** Production holds a count naming a Hidden Value whose calculate is a whole number,
  so `repeat-count-node-removed` is written for it where its app has a published deployment, with
  the deployment cause `count-node-removed`.
- **Q4 applies.** Labelled groups take `fieldList`, and production holds labelled groups with a user
  repeat at some depth, so each of those gets `group-shows-one-per-screen`; they are exactly the
  groups defect 27 left unusable on Android. No section holds a user repeat, so the section guard
  meets nothing.

**Two shapes that become refusals.** The planning scan did not count either, so both outcomes stay
written and the cutover's advisory dry run decides them before the window. (a) A query repeat whose
query reads answers inside its own rows is a `CYCLE` once it takes the count placement (§1.8).
Under today's model iteration such a query read blank answers at load, so no rewrite keeps its
meaning. If the dry run finds none, nothing follows; if it finds some, each is the author's
`target-gate` blocker before the window (part 09 §16), named in the evidence archive and never in
the repo, as step 4's blockers by rule were. (b) A query repeat whose stored `relevant` stops
type-checking at the row (§1.3): if the dry run finds none, nothing follows; if it finds some, the
class functions gain the rewrite that keeps each such read's identity at the row (a wrapper
attribute read keeps its identity, so only a new kind of read could fail), the dry run runs again,
and an app still refused is the author's blocker as in (a).

The class functions are production modules part 09's tooling calls, so the fuzz mapping and the
cutover read one rule. They are pure and deterministic, part 08 lists them by these names, and they
stay in `lib/doc` after pull request 16 removes the cutover tooling, because the fuzz mapping keeps
calling them:

- `lib/doc/repeatCountWraps.ts::planRepeatCountWraps(doc): Mutation[]` (pull request 3): one
  `updateField` per count §2.3 refuses, carrying Q2's wrap.
- `lib/doc/groupFieldLists.ts::planGroupFieldLists(doc, labelShows: (doc, groupUuid) => boolean):
  Mutation[]` (pull request 9): one `updateField` per group Q4 sets, the label predicate passed in,
  so the cutover passes its frozen copy and the fuzz mapping passes the same copy from part 08's
  tooling.
- Q1's holds are computed by part 09's `placements` step (its §8.3) over part 03's
  `lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks` with `effectiveQueryRepeatPlacement`
  (pull request 3), and applied as one `holdPlacements` through the reducer, so they are part of the
  document the cutover writes and of its fold baseline's snapshot (decision 12 of step 5's
  decisions).
- Q3 needs no function: emission decides it.

### 7.2 Copy this part gives part 09's notice table

- `repeat-count-node-removed` (field; `detail.form`, `detail.hidden`): "{form}, {Repeat}: it now
  reads its count straight from {hidden}, so its submissions no longer carry a copy of that count.
  CommCare HQ's form exports stop filling that column from your next publish."
- `repeat-count-whole-number`: the cutover brief's copy says the wrap "counts the same rows as
  before", which is false for a count that was text or beyond 32 bits: there `int(...)` counts
  where the old carrier stopped the form (§10, finding 2). The copy becomes: "{form}, {Repeat}: its
  count is now written as int(...), so it always counts a whole number of rows. Workers see the
  same rows wherever the count was already whole."

---

## 8. Contracts and docs that move

### 8.1 Subtree docs, in the pull request that makes them true

**Pull request 3.**

- `lib/commcare/CLAUDE.md`, "### Repeat modes", `count_bound`: "`jr:count` points directly at a bare
  integer question reference. A hidden-value reference or any other expression uses a sibling
  `nova_count_<repeatId>` hidden value with an `xsd:int` calculate." becomes "A count is a whole
  number in Nova's types (`REPEAT_COUNT_TYPE`, from the checker). `jr:count` names an integer
  question, an integer single select or a Hidden Value calculated as a whole number directly; any
  other count, and every relative or current spelling, takes a sibling `nova_count_<repeatId>` with
  an `xsd:int` calculate." and "Direct decimal and text question counts are refused; use an integer
  question or explicit numeric conversion." becomes "A count that is not a whole number is refused;
  `int(...)` keeps its whole part."
- The same section, `query_bound`, is replaced by: "A query repeat has a placement, held once a
  publish carries it (`placement`, `publish-placement`): model iteration, Vellum's shape exactly
  (`@ids` and `@count` set at `xforms-ready`, `@index` and `@id` at `jr-insert`, an absolute
  `@current_index`, the condition on the row), whose rows are the records found when the form
  opens, only where the repeat is in no repeat, its query reads no answer and no group around it
  shows on a condition that can change during entry; otherwise the count placement: the wrapper
  `r` holds `nova_query_ids_r` and `nova_query_count_r` and the `item` rows, each row holds
  `nova_query_id_r`, and a row past the end of the result is not relevant. The position and index
  nodes are written only when read. Text spells both placements as model iteration does
  (`formNodeProjection`'s `authoring` surface)."
- "Vellum dual-attribute pattern": "Query-repeat shadow behavior is unchanged." becomes "A
  model-iteration repeat writes `vellum:nodeset` and `vellum:jr__count` as the form builder does;
  a count-placement repeat names its count node in both."
- "Typed form expression emission": "Query-repeat insertion bookkeeping counts `../item` from its
  wrapper attribute. An absolute count can include another parent's rows during dependency
  recalculation when an outside expression reads nested iterations." becomes "A model-iteration
  repeat's `@current_index` counts its rows by absolute path, which is right because it is never
  nested; a nested query repeat is in the count placement."
- `lib/commcare/xform/generatedNodes.ts`'s header (the collision rule's order), and
  `lib/domain/fields/repeat.ts`'s header (mode 3).
- `lib/domain/expression/CLAUDE.md`, "Non-obvious arm facts" gains: "A repeat count's expectation is
  a whole number: `int`, or a read of a single select whose inline choices are whole numbers."
- `lib/preview/CLAUDE.md`: the "Initialization actions" bullet's "Root-section query repeats retain
  their form-start membership" gains "A count-placement query repeat's rows follow its query; one
  past the end is not relevant and keeps its answers."; "Count-bound repeats follow the emitted
  carrier" gains the integer select and the Hidden Value read directly.

**Pull request 5.**

- `lib/doc/CLAUDE.md` gains a bullet for `queryRepeatPlacement.ts`: "the query-repeat move planner,
  composed by `withIdentityMoves`: a held model iteration a candidate leaves out of shape moves to
  the count placement, stated as an identity edit; a held count never moves."
- `lib/domain/CLAUDE.md`, "Fields are a registry": "A query repeat's `placement` is an identity no
  author chooses (`queryRepeatPlacement.ts`), written only by `holdPlacements`."

**Pull request 9.**

- `lib/commcare/CLAUDE.md`, "### Markdown itext": "All itext entries (labels, hints, option labels)
  emit both `<value>` and `<value form="markdown">`. Safe for plain text: identical rendering when
  no markdown syntax is present." becomes "A question's, group's, repeat's or section's label and an
  inline choice's label write `<value form="markdown">` in every language unless the field or choice
  holds `plainLabel`; a hint, a help text and a validation message always write it. No runtime reads
  a hint's or a validation message's; Android reads a help text's, so Android always renders help as
  markdown. CommCare holds markdown per text across every language, so the flag is never per
  language."
- "### Sections are data groups that are always field-lists": "a LABELLED group carries the
  attribute as Nova's default and a transparent (no-label) group never does" becomes "a group
  carries it exactly when it holds `fieldList`, labelled or not, and the validator refuses a repeat
  workers add entries to anywhere inside one (`FIELD_LIST_USER_REPEAT`)".
- `lib/domain/CLAUDE.md`, "Fields are a registry", after "is always `appearance="field-list"` on the
  wire": "A group shows on one screen on Android only when it holds `fieldList`; a new group takes
  it when its label has text and it holds no repeat workers add entries to. A question's,
  container's or choice's `plainLabel` turns its markdown off."
- `lib/doc/CLAUDE.md`, the `formSectionVerdicts.ts` bullet: "Four section refusals" becomes "Five
  refusals", adding "an add-entries repeat under a group shown on one screen".
- `lib/preview/CLAUDE.md`: "screen per labeled group (a field-list, as Nova emits it)" becomes
  "screen per group shown on one screen (`fieldList`)"; "pages one screen per labeled group" becomes
  "pages one screen per group shown on one screen"; "outside a labeled group" (the repeat prompt
  points) becomes "outside a group shown on one screen"; the label rendering section gains `plainLabel`
  (as written on both platforms, choices formatted on Web Apps, tags stated).
- `components/builder/CLAUDE.md` is part 07's (pull request 12).

### 8.2 Architecture docs (pull request 15, part 10)

`docs/architecture/complex-apps.md`, "### Live counted repeats": "A direct reference requires an
integer question; other sources use an explicit numeric expression. … Query-bound membership
remains a separate initialization snapshot." becomes "A count is a whole number: an integer
question, an integer single select or a Hidden Value calculated as one is read directly, and
anything else is a formula Nova keeps in `nova_count_*`. A query repeat's rows are a snapshot taken
when the form opens only in its model-iteration placement; in the count placement they follow the
query, and a row past the end of the result is not relevant." "### Form sections" gains
`FIELD_LIST_USER_REPEAT`. The research README's sentences stay, and §10's findings go to
`docs/research/2026-09-26-hq-round-trip/harness-findings.md`, "Found while planning step 5".

### 8.3 Public docs (pull request 15, part 10)

- `content/docs/building-with-nova.mdx`, "Try the app in Preview": "A repeating section can let
  workers add entries, follow a count from an integer question or formula, or show one entry per
  matching record. … A list of matching records is captured when the form opens, or when the
  enclosing entry is created for a nested section." becomes "A repeating section can let workers
  add entries, follow a count that is a whole number, or show one entry per matching record. … A
  list of matching records is taken when the form opens when its search reads no answer, sits in no
  other repeating section and no group around it can change while the form is filled in; otherwise
  its entries follow the search as the form is filled in, and an entry past the end of the results
  is hidden and not submitted."
- The same page, "Edit wording and formatting", gains: "You can turn off **Format text** on a label
  or a choice to show it exactly as written, so `*`, `#` and numbered lines stay as you typed them."
- The same page's Preview paragraph, "A few differences Preview can't play", gains: "a label without
  formatting shows a tag in its text as formatting in Web Apps and as written on Android". Its
  "one labeled group or question at a time" becomes "one group shown on one screen, or one question,
  at a time".
- `content/docs/form-sections.mdx`: "A record-query repeat outside another repeat captures its record
  selection when the form opens. … Nested record-query repeats select their records when their
  enclosing row is created, so they can use answers from an earlier page." becomes the rule of the
  first bullet, with "Nested record-query repeats follow their search, so they can use answers from
  an earlier page."; "Two more rules come from the device" gains "a repeat that people add entries
  to can't sit in a group shown on one screen either".

### 8.4 The guide and tool text (pull request 3)

Part 07 owns the served text and holds it verbatim (its §4.2, §4.5 and §4.6); the text below is the
facts pull request 3's text states, in this part's words, and part 07's verbatim text states each of
them. Where the fact is this part's (the rule for when rows are set, the whole-number count kinds,
and what a row keeps when the result changes), its wording follows this part: a row keeps its place,
so its answers stay with that place (step 5's decisions adopt this sentence for the Rows editor and
the guide, §1.5).

`FIELD_DOCS` in `lib/agent/toolSchemaGenerator.ts`:

- `repeat_mode`: "Worker-added rows, a number of rows from a whole-number question or expression,
  or one row per case a query finds. Counts grow live during entry; lowering a count keeps created
  rows, answers and case operations. A query's rows are set when the form opens where it reads no
  answer, sits in no other repeat and no group around it shows on a condition that can change
  during entry; otherwise its rows follow the query as answers change, each row keeping its place."
- `repeat_count`: "Row count for a count-bound repeat: a whole number, from an integer question, a
  single choice whose values are whole numbers, a hidden value calculated as a whole number, or a
  formula such as int(#form/size div 2)."
- `ids_query`: unchanged.

`lib/agent/authoring/reference.ts`, `fields()`'s repeat description: "A direct count needs an
integer question; convert other sources explicitly. Query record IDs outside another repeat are
captured when the form opens; nested query repeats capture theirs when the enclosing row is
created." becomes "A count must be a whole number: an integer question, a single choice whose values
are whole numbers, a hidden value whose calculation is a whole number, or an expression wrapped in
int(...). A query repeat's rows are set when the form opens where its query reads no answer, it sits
in no other repeat and no group around it shows on a condition that can change during entry;
otherwise its rows follow the query as answers change, and a row keeps its place, so its answers
stay with that place when the result changes. A row past the end of the current result is hidden and
writes no case."

`lib/domain/fields/repeat.ts`'s `saDocs`: "\"count_bound\" for a live count from an integer question
or expression" becomes "\"count_bound\" for a live count from a whole-number question or
expression", and "query_bound snapshots its query when the enclosing instance initializes; changing
dependencies does not rebuild those rows. A new enclosing repeat instance initializes its own query
snapshot." becomes "query_bound rows are set when the form opens or follow the query as answers
change; the repeat description says which." (part 07 §4.6's text).

`MODEL_CONTEXT_VERSION` becomes `"v6-hq-round-trip-case-writes.3"`.
`lib/mcp/__tests__/servedSchemas.test.ts` holds the new descriptions. Part 07 writes the sentence
that a published query repeat keeps how its rows come and that an edit changing it says so in
`identityMoves`, with its own version, and in pull request 13 the `field_list` and `plain_label`
parameters and their sentences. The billed schema check of `addFields` and `editField`, whose
descriptions this pull request changes, runs once at pull request 13's head with every other changed
entry (§11, G5). The `../nova-plugin` sweep (part 07) looks for the
claims "a query is captured at form load", "query record IDs … are captured", "every labelled group"
and "Form wording is Markdown" (the last stays true by default).

---

## 9. Tests

Each test names the production contract it proves and the boundary it earns
(`docs/testing.md`). Nothing here reaches Postgres but part 09's cutover tests, which call this
part's class functions.

**Pull request 3, query placement and whole-number counts**

- `lib/domain/__tests__/queryRepeatPlacement.test.ts` (new; pure domain model over
  `formStructure` of built documents): each need and its absence; a query reading `today()`, `now()`,
  a case query, the form's case, a Search answer and a lookup read gives model iteration; a field,
  `form-node` or `repeat-row` read gives `query-reads-answers`; a group whose condition calls
  `now()` gives `ancestor-condition-changes`; a section ancestor gives none; the nearest outer repeat
  is the one named; a repeat holding `placement` (set directly in the built document, as a spec's
  document holds it) has that placement returned by `effectiveQueryRepeatPlacement` against the
  rule's answer. Plausible failure: a rule that admits a nested model iteration.
- `lib/domain/__tests__/fieldPatchSchema.test.ts` (new): `updateField` and `addField` refuse
  `placement` (`HELD_FIELD_KEYS`), and a duplicated query repeat starts unheld. Plausible failure: a
  hold written by an ordinary edit before `holdPlacements` exists.
- `lib/domain/expression/__tests__/repeatCountExpectation.test.ts` (new; the checker, the semantic
  authority): paired admits and refusals for `2`, `int(...)`, `count(...)`, an `int` question,
  `#form/n + 1`, `#form/n div 2`, `2.0`, a decimal, a text, a multi-select, an `_any` Hidden Value,
  a lookup select, a cases select, and an integer select whose choices are `1`, `+5`, `007`,
  `-3` (admitted) and `2147483648`, `1.0`, `٣` (refused, each with its reason); a relative read of an
  integer select admitted; `count-result` typed `int`.
- `lib/commcare/validator/__tests__/repeatCountType.test.ts` (new; the gate): each reason's message
  and location through `mutationCommitVerdict`; a choice edit that breaks an integer select a count
  reads is refused at its commit. Rewritten for the new rule: the count cases of
  `lib/commcare/__tests__/validationRules.test.ts` and `lib/commcare/__tests__/deepValidation.test.ts`
  (`number(../target)` and `number(#form/target)` become `int` counts over integer questions or are
  refused, each asserted).
- `lib/commcare/__tests__/countReference.test.ts` (rewritten): `directRepeatCountReference` over the
  three direct kinds; a default-only Hidden Value, a non-`int` calculate and a relative spelling
  each keep the carrier; a read `count-result` keeps its carrier materialized.
- `lib/commcare/__tests__/repeatEmission.test.ts` (new; structure through the wire tree, not text):
  model iteration's four setvalues in order with their events, its `@current_index` bind first and
  absolute, no `@count` bind, the condition on `item`, the repeat's shadows; the count placement's
  data order, binds, guard condition with and without an authored one, the outer group with no
  label, the position and index nodes only while read, a collision suffix on each name; a nested
  count placement's paths per outer row; direct counts for the three kinds. The bytes are held by
  independent consumers, the native family (G2) and the lane's editor saves (G1); this test holds
  the decisions.
- `lib/commcare/xpath/wire/__tests__/formReads.test.ts` (extended, `formNodeProjection`): each identity on both
  surfaces in both placements; a parse of `current()/../@id` binds `repeat-row id` in both
  placements, and the wire prints `current()/../nova_query_id_r` in the count placement.
- `lib/preview/engine/__tests__/queryRepeatPlacement.test.ts` (new; the production engine): a
  count-placement repeat's rows follow an answer; a shrink hides the rows past the end with their
  answers kept and no operation iteration (through the existing operation-answers path); growth back
  restores them with their answers; a row's id follows its position when the result reorders; a
  model-iteration repeat's condition hides one row and not another; a root section's count placement
  refreshes when its page is entered. The `TriggerDag` refuses a query reading its own rows.
- `lib/preview/engine/__tests__/formEngine.test.ts` (extended): a direct integer select and a direct
  Hidden Value read by the lexical rule.
- `lib/doc/__tests__/repeatCountWraps.test.ts` (new; production planner through the real gate): each
  refused count wrapped and then admitted; an admitted count untouched; a second run changes nothing.
- `lib/commcare/__tests__/xformOracle.fuzz.test.ts` and `compilerEvidence.ts` keep admitting every
  draw through part 08's fuzz mapping ("What other parts read from this one", part 08).

**Pull request 5, the held placement**

- `lib/doc/__tests__/queryRepeatPlacement.test.ts` (new; the planner over candidates through the
  real commit gate): a held model iteration moved by nesting it, by an answer added to its query and
  by an ancestor's condition reading an answer, each returning the hold to `count` and its move; a
  held count and an unheld repeat never stated; the candidate without the planner's hold refused
  with `QUERY_REPEAT_MODEL_ITERATION_SHAPE` and the reason's message; the undo of a move replayed
  through the store and admitted by part 03's restoring arm, and its redo restating the move; the
  undo of a held query repeat's removal re-creating it with its hold, admitted; an editor batch
  setting a hold to `count` while model iteration still expresses the repeat refused (§1.7).
- Part 03's `lib/doc/__tests__/diffDocsToMutations.placementHolds.test.ts` (new) holds a
  query-repeat `placement` difference replayed as `holdPlacements`.

**Pull request 9, field lists and plain labels**

- `lib/commcare/validator/__tests__/fieldListUserRepeat.test.ts` (new; the gate): a user repeat two
  levels down in a field-list group refused with the message; a count and a query repeat admitted;
  under a section and a field-list group, only the section's finding; turning `fieldList` on over a
  user repeat refused.
- `lib/doc/__tests__/formSectionVerdicts.test.ts` (extended): a user repeat, or a group holding one,
  dropped into a field-list group refused before the batch, and every `ok` verdict replayed through
  the gate admitted.
- `lib/domain/__tests__/groupBornFieldList.test.ts` (new; pure): the four cases of label and user
  repeat. `lib/doc/__tests__/mutations-fields-convertField.test.ts` (extended): a repeat converted to
  a group takes the flag by the rule; a group converted to a repeat drops it; undo restores both.
- `lib/agent/__tests__/contentProcessing.test.ts` (extended): a batch group holding a user repeat is
  built without the flag, a labelled one with it.
- `lib/commcare/__tests__/platformQuestionPages.test.ts` (rewritten, §3.7).
- `lib/doc/__tests__/groupFieldLists.test.ts` (new): Q4 over a translation-only label, a group
  holding a user repeat two levels down, an unlabelled group, a section; a second run changes
  nothing.
- `lib/commcare/__tests__/plainLabelEmission.test.ts` (new; the built XForm through the wire
  serializer): a plain label writes no markdown form in two languages, a plain choice the same, a
  hint and a help text keep theirs, a protected validation message's internal forms unchanged, a
  plain label with a reference keeps its `<output>`.
- `lib/preview/engine/__tests__/formEngineSections.test.ts` (extended): Android screens per field-list group
  and per question, a nested field-list group in its host's screen, Web Apps one page.
- `lib/references/__tests__/LabelContent.test.tsx` is not added: rendering is verified in
  Playwright. `e2e/tests/browser/preview-platforms.spec.ts` plays `choice-label-plain-web-apps`, run
  alone locally.
- `lib/preview/__tests__/platformCells.test.ts`, `lib/commcare/surface/__tests__/platformFeatures.test.ts`
  and `lib/domain/__tests__/platformUses.test.ts` (existing) hold the new rows, the feature and the
  detector.

**Lane tests (part 08, named here for what they hold of this part):**
`proof/native/core/ContainerRuntimeTest.java` (count-placement scenarios, G2),
`RepeatCountRuntimeTest.java` (direct and wrapped counts counting the same rows, G2), and the
targeted documents of the part 08 line of "What other parts read from this one".

---

## 10. Executed during planning

Nothing this part's own planning ran was a paid call, a build, a test run, a lane run or a
production read; the one production read is the scan below, which part 09 owns. Planning read
Nova at `2f985ed6` with `rg`, `sed` and a JSON read of `proof/known-defects.json` and
`lib/commcare/surface/entries/questions.json` (§5, §6.1's counts), and the Dimagi checkouts at the
pins with `rg`: `Vellum/src/modeliteration.js` (setvalues, the bind, the data attributes, the
hashtag writes), `Vellum/src/mugs/types/group.js` ("Repeat Count is required."),
`Vellum/src/javaRosa/itextBlock.js` (`NO_MARKDOWN_MUGS`), `core/.../XPathPositionFunc.java`
(`getMultLast`), `FormEntryController.java`, `FormEntryModel.java`, `FormDef.java`,
`Recalculate.java`, formplayer's `PromptToJson.java`, HQ's `form_ui.js`, `question.html`,
`sub_group.html`, `entry_select.html` and `package.json`, and Android's `QuestionWidget.java`.

The production scan ran during planning, with the person's yes, as part 09's gated run G1: read-only,
content-free, one snapshot of the ledger and every app, live and soft-deleted. It counted Q1 to Q4 and
the published direct Hidden Value counts, and §7.1 states what it found in words; no count enters
the repo. It did not count the two shapes that become refusals (§7.1 (a) and (b)), which the
advisory dry run decides (§11, G4).

Findings for `harness-findings.md`, "Found while planning step 5":

1. The research's defect 30 names an integer type "Nova's expression types know a number but not
   an integer" in `lib/commcare/validator/typeChecker.ts`; at `2f985ed6` the file is gone and the
   integer type has existed since step 3. Step 5 adds only the count's expectation, and the outline's
   "with the integer type added" is corrected.
2. The research's defect 30 migration says `int(…)` truncates exactly as the `xsd:int` node does.
   That holds for every finite number within 32 bits, NaN and blank; not for text (`'3'` in the
   carrier is `StringData` and parses, `'3.5'` stops the form, where `int('3.5')` is 3) and not
   beyond 32 bits (the carrier saturates, `int(...)` stops the form). Each difference turns a form
   that stopped into one that counts, or one that tried to make two billion rows into one that
   stops.
3. The research's contracts row says step 5 removes the repeat-count snapshots. None remains at
   `2f985ed6` (`lib/commcare/CLAUDE.md`, "No count setvalues or count snapshots remain").
4. The research makes markdown a property of hints, help and validation messages too; no runtime
   reads a hint's or a validation message's markdown form, and Android reads a help text's, which
   Nova always writes, so Android always renders help as markdown and help needs no flag (§4.2).
5. The research's count placement "moves its answer paths"; step 5's keeps the wrapper and the row,
   so only generated nodes move (§1.5).
6. `questions/jr-count-naming-a-single-select-question-whose-every-choice` reads HELD while
   `REPEAT_COUNT_TYPE` refuses it at `2f985ed6`; step 5 makes it true.
7. The proof brief's census of defect 25 counts 26 proof4 entries on `container-nested-query` and 3
   on `container-query-conditional-relative`; the register holds 27 and 2 (the total, 101, agrees).
8. The proof brief's gated run on a count-placement row that keeps "its answers with its case id"
   assumes rows matched by id. Core's repeat rows are positional, and step 5's count placement keeps
   a row's answers with its position by design (§1.5); G2 asserts that.
9. The authoring brief's identity-move row for a query repeat says "its answers move to a new place
   in the submission"; with the wrapper kept, only each row's record id moves (§1.7).

---

## 11. Written and not yet run

**G1. The editor saves and the served readers over query repeats and counts.** At pull request 3's
head, by hand before the merge, part 08's by-hand reader run for pull request 3 (its §8.4 row for head
3, under its G2), with the count documents and `case-operation-query` beside its query documents: `gh workflow run
proof-audit.yml --ref <branch> -f nightly=false -f
mechanics=container-query-conditional,container-nested-query,targeted-query-repeat-places,targeted-query-repeat-placements,targeted-migration-query-repeats,case-operation-query,targeted-repeat-count-whole,targeted-migration-repeat-counts,control:container-query-conditional-after-13,control:container-nested-query,control:targeted-query-repeat-places
-f mechanics_shards=auto -f mechanics_readers=true`, holding proof 4's two form-builder saves and every served reader.

- *Outcome A:* every save writes Nova's bytes but for proven spelling rules, and every moved entry's
  class shows on its control and not on its document: §1.4, §1.5 and §6.1 stand.
- *Outcome B:* a save rewrites a piece Nova writes differently (an attribute order, a bind order,
  a `vellum:` shadow on a generated bind, the `position(..)` spelling, the `count-selected`
  argument): the emitter writes what the save writes for that piece, in pull request 3, and the run
  is repeated until outcome A. The piece's row of §1.4 or §1.5 is rewritten to the save's spelling.
- *Outcome C:* the form builder cannot keep the count placement's outer Group (it drops it,
  flattens it or rebuilds it as something else): the count placement drops the wrapper and takes
  the research's shape (rows at `/data/r`, `nova_query_ids_r` and `nova_query_count_r` beside them in
  the repeat's parent), which moves answer paths between placements. Then §1.5's departure (a) is
  withdrawn, Q1's notice line and the deployment cause name the moved answer columns, §1.7's
  sentence states moved answer columns, `targeted-migration-query-repeats` expects the moved answer
  paths (part 08), and §8.1's `query_bound` sentence says the rows sit beside the count.
- *Outcome D:* a served reader still shows a moved entry's class on its document: the emission is
  incomplete for that reader and is fixed in pull request 3, never registered again.

**G2. Core's reading of the count placement and of direct counts.** In pull request 3's own lane,
`ContainerRuntimeTest` (new scenarios, local and HQ-regenerated forms) and `RepeatCountRuntimeTest`
(part 08). The scenarios: rows are created up to the count; `position(..)` reads 0-based in the row
id calculate on the first evaluation of each new row; a shrink hides rows past the end and leaves
them out of the serialized instance with their case blocks; growth back restores them with their
answers; a reorder of the result moves ids by position; each outer row of a nested count placement
has its own ids; a count from an integer select, from an `int` Hidden Value and from `int(expr)`
count the same rows as the old carrier did on whole counts.

- *Outcome A:* every scenario holds: §1.5 and §2.4 stand, and the copy "a row keeps its place"
  (§1.7, §8.4) stands.
- *Outcome B1:* `position(..)` misreads on a new row's first evaluation (for instance against the
  template): the row's index becomes a `jr-insert` setvalue, `nova_query_index_r` =
  `count(../../item) - 1`, written always, and the row id calculate and the guard read it in place of
  `position(..)` and `position(.)`; §1.5's table and `repeatEmission.test.ts` change with it, in
  pull request 3.
- *Outcome B2:* the guard condition does not hide rows or does not leave them out of the
  submission: rows past the end stay relevant with a blank `nova_query_id_r`, as the research
  designs; every case operation whose scope is such a row carries the conjunct
  `nova_query_id_r != ''` (part 01 adds it to the operation's condition, part 02 emits it); Preview
  keeps those rows visible with their questions; §1.5's departure (b) is withdrawn; and §8.3's
  sentence says "an entry past the end of the results stays, with no record behind it".
- *Outcome C:* an existing row's `nova_query_id_r` is not recomputed when the query's result changes:
  the row id becomes a `jr-insert` setvalue `selected-at(../../nova_query_ids_r, count(../../item) -
  1)`, so each row keeps the record it was made for; the guard compares the row's id with the
  current ids (`selected(../nova_query_ids_r, nova_query_id_r)`) so a row whose record left the
  result is hidden; Preview fixes each row's id at insertion; and the copy (§1.7, §8.3, §8.4) says "a
  row keeps the record it was made for, and hides when that record leaves the result".
- *Outcome D (direct counts):* a direct Hidden Value count does not count as its carrier did: §2.4's
  Hidden Value arm is withdrawn, it keeps the carrier, Q3 has no members, and the manifest's
  `jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in` cell keeps its copy clause with
  the run as evidence.

**G3. Field lists and plain labels on every reader.** At pull request 9's head, by hand, part 08's
by-hand reader run for pull request 9 (its §8.4 row for head 9): `gh workflow run proof-audit.yml --ref <branch> -f
nightly=false -f
mechanics=targeted-field-list-flags,targeted-plain-labels,targeted-labelled-group-repeat,targeted-migration-groups-preloads
-f mechanics_shards=auto -f mechanics_readers=true`, with part 08's G5 slice
(`-f slice='proof/android/test_form_reads.py -k markdown' -f slice_readers=android`) over the plain
label and choice of `targeted-plain-labels`.

- *Outcome A:* Formplayer, the Web Apps client and Android show what the cells state (Android pages
  one screen per field-list group and per question outside one; a plain label shows as written on
  Android and, without tags, in Web Apps; a plain choice shows as written on Android and formatted
  in Web Apps); both form-builder saves keep a field-list group, an unlabelled one, and an item
  without `hasMarkdown`: §3, §4 and §5 stand, and defect 27's entries move.
- *Outcome B:* Android renders a plain label's `*`, `#` or `1. ` as formatting: the manifest reading
  of `label-with-no-markdown-form` becomes DIFFERENT with the run as evidence, `plain-text`'s Android
  reading becomes `different` with the note "a label still shows formatting", a Preview cell is added
  for it, and the builder's Format text line (part 07) says so.
- *Outcome C1:* an unedited form-builder save adds a markdown form back to a plain item of some
  kind (question label, container label or choice): a plain label of that kind cannot survive HQ's
  editor, so pull request 9 does not add `plainLabel` to that kind (its schema slot, its emission
  arm, its detector arm and part 07's toggle there all go), the matching entry
  (`label-with-no-markdown-form` or `choice-label-with-no-markdown-form`) stays HELD-NEW with the
  run as evidence, and the kinds the save keeps carry the flag as written. No register entry is made:
  Nova never emits the shape the save breaks.
- *Outcome C2:* an unedited save drops the appearance from an unlabelled field-list group: a new
  soundness rule `FIELD_LIST_UNLABELLED` (located at the group) refuses `fieldList` on a group whose
  label is empty in every language, with the message `"{group}" has no label, and CommCare HQ's
  form builder would stop showing its questions on one screen the next time the form is saved
  there. You can give "{group}" a label, or let it show one question per screen.`;
  `question-list-unlabelled-anywhere-else` stays HELD-NEW with the run as evidence and leaves
  `question-pages`' entries; the birth rule and Q4 already give no unlabelled group the flag.
- *Outcome D:* a reader differs from a cell in any other way: the cell's evidence and Preview's rule
  change to the reader's reading in pull request 9; a difference that is Nova's wrong emission is
  fixed, never registered.

**G4. The two uncounted shapes, in the cutover's advisory dry run** (part 09's G8, before the
window). The planning scan counted Q1 to Q4 and the published direct Hidden Value counts (§10, §7.1
states the findings); it did not count query repeats whose query reads answers inside their own rows
or query repeats whose stored `relevant` stops type-checking at the row. The dry run counts both.

- *Outcome A:* neither is found: nothing follows, and §7.1's classes run as written.
- *Outcome B:* a query repeat reads its own rows: it is the author's `target-gate` blocker (§7.1 (a);
  part 09 §16's remedy), and the dry run repeats until it is resolved.
- *Outcome C:* a stored `relevant` stops type-checking at the row: the class functions gain the
  rewrite of §7.1 (b), the cutover image is rebuilt with it, the dry run repeats, and an app still refused is the
  author's blocker with part 09 §16's remedy.

**G5. The schema check, which bills.** Not run in pull request 3: step 5's decisions ask the paid
`npm run test:schema` once, at pull request 13's head, over every registered entry any pull request
of the stack added or changed (part 07's G-A1). `addFields` and `editField` are among them, since
pull request 3 changes their descriptions (§8.4); each is one live call, asked first.

- *Outcome A:* both accepted: the descriptions stand.
- *Outcome B:* a description is refused: the refusal is read from the response, the description is
  rewritten in pull request 13 within the provider's limit it names (part 07's G-A1 outcome B),
  `servedSchemas.test.ts` follows, and the one entry is run again after asking again.

---

## 12. Files by pull request

Stack numbers are step 5's decisions'. A held slot lands with the stored concept it holds, so the
query repeat's `placement` slot and its reading land in pull request 3; the writer of holds lands in
pull request 5, so this part also joins pull request 5 (with parts 01, 03, 07 and 08) for the
query-repeat target, the held model iteration's rule and the move planner. Part 10's stack table
records both.

**Pull request 3, Repeats: query placement and whole-number counts (parts 04, 07, 08)**

- New: `lib/domain/queryRepeatPlacement.ts`; `lib/commcare/xform/queryRepeatNames.ts`;
  `lib/doc/repeatCountWraps.ts`; the tests of §9's first group.
- Changed: `lib/domain/expression/walk.ts` (`expressionReadsFormAnswers`),
  `lib/domain/expression/profiles.ts` (`repeat-count`), `lib/domain/expression/context.ts`
  (`relevant` at the row, `repeat_count`'s expectation), `lib/domain/expression/typeChecker.ts`
  (the expectation, `count-result` as `int`), `lib/domain/expression/formStructure.ts`
  (`hiddenValueSource`, `heldQueryPlacement`), `lib/domain/repeatCount.ts`,
  `lib/domain/fields/repeat.ts` (header, `saDocs`, the `placement` slot), `lib/domain/fields/index.ts`
  (`HELD_FIELD_KEYS`, read by the patch builder and `addField`'s payload),
  `lib/doc/duplicateFieldMutations.ts` (a duplicate starts unheld),
  `lib/commcare/xpath/formNodeProjection.ts` (surfaces) and every caller named in §1.6,
  `lib/commcare/xform/builder.ts`, `lib/commcare/xform/generatedNodes.ts`,
  `lib/commcare/validator/formLogicFindings.ts`, `lib/commcare/validator/rules/field.ts`
  (`emptyRepeatXPath`'s branch removed), `lib/preview/engine/formEngine.ts`,
  `lib/preview/engine/triggerDag.ts`, `lib/preview/engine/formExpressionRuntime.ts`,
  `lib/db/appTests.ts` (`RUNTIME_VERSION` 18), `lib/agent/toolSchemaGenerator.ts`,
  `lib/agent/authoring/reference.ts`, `lib/models.ts` (`"v6-hq-round-trip-case-writes.3"`),
  `lib/mcp/__tests__/servedSchemas.test.ts`, `lib/preview/engine/__tests__/fixtures/sectionEntry.ts`
  (the `int(...)` wrap), `lib/commcare/__tests__/validationRules.test.ts`,
  `lib/commcare/__tests__/deepValidation.test.ts`, `lib/commcare/surface/entries/questions.json`
  (§5's pull request 3 rows), `docs/research/2026-09-26-hq-round-trip/inventory/questions.md`,
  `proof/known-defects.json`, `proof/fixed-defects.json`, `proof/checks/registers.py`
  (`OPEN_DEFECTS`), the subtree docs of §8.1's pull request 3 list, and part 08's files for this pull
  request (the native scenarios, the targeted documents, the fuzz mapping's items for defects 25 and
  30, the migration witnesses' identity moves).

**Pull request 5, Held placements and identity moves (parts 01, 03, 04, 07, 08)**

- New: `lib/doc/queryRepeatPlacement.ts`; the tests of §9's second group.
- Changed: `lib/commcare/validator/errors.ts` and `rules/field.ts`
  (`QUERY_REPEAT_MODEL_ITERATION_SHAPE`), and, with their owners, `holdPlacements`' query-repeat
  target (part 03's `lib/doc/types.ts` envelope, `lib/doc/mutationTargetAdmission.ts`,
  `lib/doc/diffDocsToMutations.ts`, `lib/doc/incrementalValidationScope.ts`), the editor half of
  `placementChangeRefusal` with its restoring arm (part 03), `withIdentityMoves`' composition and
  `applyHistoryStep` (part 07); the subtree docs of §8.1's pull request 5 list.

**Pull request 6, Publish placements (part 03):** `placementsToHold` reads
`effectiveQueryRepeatPlacement`; `placementChangeRefusal`'s `publish-placement` arm joins the
editor half, which reads `queryRepeatPlacementExpresses` from pull request 5.

**Pull request 9, Groups and labels: field lists and plain labels (parts 04, 08)**

- New: `lib/doc/groupFieldLists.ts`; the tests of §9's third group; the scenario
  `choice-label-plain-web-apps`.
- Changed: `lib/domain/fields/group.ts` (`fieldList`, `groupBornFieldList`), `lib/domain/fields/base.ts`
  (`plainLabel` on `fieldBaseSchema`, `containerFieldBase`, `selectOptionSchema`, `SelectOption`),
  `lib/domain/fields/section.ts`, `lib/domain/platforms.ts` (`plain-text`),
  `lib/domain/platformUses.ts`, `lib/commcare/xform/builder.ts` (the field-list gate, `addItext`'s
  `markdown`), `lib/commcare/validator/errors.ts` and `rules/form.ts` (`FIELD_LIST_USER_REPEAT`),
  `lib/doc/formSectionVerdicts.ts`, `lib/doc/mutations/fields.ts` (`convertField`),
  `lib/agent/contentProcessing.ts` (the birth rule), `components/preview/form/newFieldDefaults.ts`,
  `components/preview/form/FieldTypePicker.tsx`, `lib/preview/engine/formEngine.ts`
  (`groupDrawsAsFieldList`, prompt points), `lib/preview/platform.ts` (`plainChoice`),
  `lib/references/LabelContent.tsx`, `components/preview/form/fields/SelectOneField.tsx`,
  `SelectMultiField.tsx`, `lib/commcare/surface/platformFeatureEntries.ts`,
  `lib/commcare/surface/entries/questions.json` (§5's pull request 9 rows),
  `lib/preview/__tests__/platformCells.ts`, `lib/domain/__tests__/platformFeatureFixtures.ts`,
  `lib/commcare/__tests__/platformQuestionPages.test.ts`, `e2e/lib/previewPlatformScenarios.ts`,
  `e2e/tests/browser/preview-platforms.spec.ts`, the inventory rows, `proof/known-defects.json`,
  `proof/fixed-defects.json`, `proof/checks/registers.py`, the subtree docs of §8.1's pull request 9
  list, and part 08's files (the corpus sources' labelled groups taking `fieldList`, the targeted
  documents, the fuzz mapping's item for defect 27).

**Pull requests 12 and 13 (part 07):** the Rows editor, the Show on one screen switch, the Format
text toggle; `field_list` and `plain_label` with their descriptions; `get_field`'s `fieldList`,
`plainLabel`, `rows` and `rowsKept`; `summarizeBlueprint`'s `[one screen]`, `[rows set when opened]`
and `[rows follow query]`. At pull request 13's head, the one billed schema check covers
`addFields` and `editField` for pull request 3's descriptions (G5).

**Pull request 14 (part 09):** Q1 to Q4 through `effectiveQueryRepeatPlacement`,
`planRepeatCountWraps`, `planGroupFieldLists` and the frozen label predicate; §7.2's copy.

**Pull request 15 (part 10):** §8.2 and §8.3.

---

## Departures

Each departs from the research, the outline or a brief, with its reason.

- **Model iteration is admitted by a structural rule,** not the research's load-time analysis: step 5
  has no import (§1.3).
- **`now()` in an ancestor's condition needs the count placement:** a group can turn relevant on it
  mid-entry (§1.3).
- **The count placement keeps the wrapper and the `item` rows**, so no answer path moves; **rows
  past the end are not relevant** instead of carrying a blank id with a guard per operation; and
  **`nova_query_ids_r` is always written**, so the query runs once per change (§1.5).
- **The query repeat's writer of holds, its rule and its planner land in pull request 5,** not 3,
  with the other held placements; pull request 3 lands the `placement` slot with the concept it
  holds and emits the held or effective placement, and nothing writes a hold before
  `holdPlacements` (§1.7, §12).
- **No `setQueryRepeatPlacement` mutation:** `holdPlacements` carries the query-repeat target
  (decision 4 of step 5's decisions).
- **The SA and MCP state a move and ask no confirmation** (decision 3 of step 5's decisions).
- **The outline's "integer type added to Nova's expression types"** exists since step 3; step 5 adds
  the expectation (§2.1).
- **An integer select read is admitted in any spelling** (§2.3).
- **A literal `2.0` is admitted, not refused** (§2.7, §9): the form parser stores a number literal
  as its value (`lib/commcare/xpath/formSyntax.ts`, `Number(text)`), so `2.0` is the stored number
  `2`, typed `int` (`ruleSets.ts::literalType`) and printed `2`, which `Integer.parseInt` reads.
  `repeatCountExpectation.test.ts` holds it admitted.
- **The checker's finding carries its details on `CheckError.repeatCount`** (`type`, `select` uuid,
  `selectId`, `value`, `source`), and `typeChecker.ts::repeatCountTypeWords` holds §2.5's words, so
  the validator's message reads them rather than a second table.
- **A new group takes `fieldList` when its label has text and it holds no user repeat:** the
  questions brief's unlabelled arm and the authoring brief's missing user-repeat arm are both
  dropped (§3.6).
- **Markdown is a flag of labels and choices only** (§4.5; decision 2 of step 5's decisions).
- **`plain-text` is a feature, not ambient** (§4.6), and **Preview renders no author HTML**, with no
  `dompurify` dependency (§4.7).
- **A row keeps its position, not its record,** when the result reorders (§1.5; finding 8).
- **`addField`'s payload refusal lives in `lib/doc/types.ts`** (pull request 3), which part 10 §2
  does not list: `addField`'s `field` is `addFieldFieldSchema`, `fieldSchema` refined to refuse an
  own key of `HELD_FIELD_KEYS` (`lib/domain/fields/index.ts::fieldHoldsHeldKey`). A refinement, not
  an omitted variant, keeps the `Mutation` type's `field: Field`, so every planner that re-adds a
  stored field (`diffDocsToMutations`, the scaffolds) still type-checks, and the refusal is the
  envelope's at runtime. `addField` is the one mutation arm that embeds a field. The type-level
  `FieldPatchFor` omits `HELD_FIELD_KEYS` beside the runtime patch schema.
- **`placement` is classified `config` in `lib/domain/referenceSlots.ts::NON_REFERENCE_FIELD_PATHS`**
  (pull request 3), which part 10 §2 does not list: the schema-key audit
  (`lib/domain/__tests__/referenceSlots.test.ts`) refuses an unclassified stored key.
- **The needs are ordered nearest first with the query's own need first** (§1.3): the query is the
  repeat's own slot, then the nearest repeat and the nearest changing group around it in the order
  they enclose it. So the rule's first need, which pull request 5's finding reports, is the query's
  where its query reads an answer.
- **A model-iteration repeat writes no `vellum:jr__count`** (pull request 3), where §1.4's body
  row and §8.1's "Vellum dual-attribute pattern" sentence write `vellum:jr__count="#form/r/@count"`.
  The form builder's own fixture writes `jr:count="/data/group/@count"` and no shadow
  (`Vellum/tests/static/modeliteration/case-list-iteration-with-questions.xml`): `util.writeHashtags`
  writes a `vellum:` attribute only where `toHashtag` differs from the XPath, and `toHashtag`
  (`src/xpath.js`) reads `invertedHashtagMap`, which holds mug paths alone (`form.js::_fixMugState`),
  so `/data/r/@count` has none. The serializer already withholds a shadow for a hashtag path with an
  attribute step (`xpath/wire/serialize.ts::shadowEligibility`). `lib/commcare/CLAUDE.md` says so
  in the sentence §8.1 gives it. The same fixture writes `vellum:calculate="count(#form/group/item)"`
  on the `@current_index` bind, which §1.4's row and Nova's rule that generated calculations request
  no shadow leave out; G1 decides that piece (its outcome B).
- **Preview's row relevance lives on the repeat's own state** (pull request 3), in
  `lib/preview/engine/types.ts` and `lib/preview/engine/formPresentation.ts`, which part 10 §2 does
  not list. The engine's store holds one state per container and none per row, so §1.8's per-row
  condition and the count placement's result are `FieldState.rowConditions` and
  `FieldState.queryResultCount` on the query repeat, read by `effectivelyVisiblePaths`,
  `computeOperationAnswers`, the attachment and invalid-answer walks, and
  `formPresentation.ts::visibleRepeatInstances` through `repeatRowRelevantInState`, so the running
  form hides a row past the end as the engine does. Without the presentation filter the builder
  would draw a row the submission leaves out.
- **`lib/preview/app-tests/CLAUDE.md` moves in pull request 3** (its version 18 sentence), which
  part 10 §2's pull request 3 list leaves out and §7.9 marks 3: the sentence is true when
  `RUNTIME_VERSION` becomes 18.
- **Two Preview tests change their expectation, not only their fixture** (pull request 3):
  `formEngine.test.ts`'s "captures query membership at its action" and "captures nested membership
  on page entry" read answers (or sit in a repeat), so their repeats now take the count placement
  and follow the query; they are renamed and assert the rows the query gives, with the answered row
  kept. Four more tests outside part 10 §2's list pinned the snapshot for a query that reads an
  answer and now assert that the rows follow it, a row past the end leaving the form with its
  answer kept: `lib/agent/authoring/__tests__/repeatContext.test.ts` (renamed, and it now turns
  the zone back to show the row's answer return), `lib/preview/engine/__tests__/evaluateForm.test.ts`'s
  continued entry (renamed), `lib/preview/app-tests/__tests__/journey.postgres.test.ts`'s section
  pages and `e2e/tests/browser/preview-form-lifecycle-audit.spec.ts`'s page entry, the last two over
  `sectionEntryDoc`, whose nested query now gives the north area's second row on return.
- **The form-node projection's re-pointing reaches a wire test fixture** (pull request 3):
  `formNodeProjection` now takes the surface it projects for (§1.6), and
  `lib/commcare/xpath/wire/__tests__/instantFixture.ts`, which part 10 §2 does not list among "every
  caller part 04 §1.6 names", builds its projection as the XForm emitter does, so it passes
  `{ surface: "wire" }`. Without it the fixture would print the authoring surface's paths where the
  wire tests compare emitted ones.
- **`saDocs` says "the fields guide says which"** (pull request 3), part 07 §4.6's row, where §8.4
  says "the repeat description says which". The sentence is itself the repeat's description, so
  pointing at the repeat description would point the model at the sentence it is reading; the
  fields guide (`lib/agent/authoring/reference.ts`) is where §1.6's rule is written for the SA.
- **The two witnesses' identity moves are written after the push** (pull request 3):
  `proof/identity-moves.json` gains no entry for `targeted-migration-query-repeats` or
  `targeted-migration-repeat-counts` before the lane has run. `proof/CLAUDE.md` ("A republish after
  a migration is observed on its witness") has a move written from its witness's proof 1 evidence and
  never by hand, so each is written from the first lane's proof 1 records of the two witnesses, in a
  commit of this pull request after its first push.
- **The suite generator takes the fuzz mapping too** (pull request 3):
  `lib/commcare/__tests__/suiteDocArbitrary.ts::lowerToDoc` applies
  `xformDocArbitrary.ts::mappedAsTheCutoverMaps` before `declaredForContent`, beside the XForm and
  expression generators part 10 §2 lists, since the suite oracle's draws hold repeats and counts too
  and part 08 §4.3 maps every generator's draw.
- **`planRepeatCountWraps` takes the lookup definitions beside the document** (pull request 3):
  `planRepeatCountWraps(doc, lookupTables = new Map())`, where §2 names `(doc)`. The planner asks
  the gate's own checker which counts it refuses, and a count reading a data table's column types
  only with that table's definitions, so a caller holding a lookup context (the cutover) passes
  `lookupTypeIndex(context)`; the fuzz mapping's draws read no table and pass none.
- **The manifest cells spell out the shape** (pull request 3): the `questions` entries' cells in
  `lib/commcare/surface/entries/questions.json` and the inventory say what the shape is (for
  example, a `repeat` `count_bound` naming the question directly) where §5 cites this part's
  sections, since pull request 16 removes the plan files and a cell must still read. Wording only;
  every disposition is §5's.
- **One count source changes, and no other** (pull request 3): part 08 §4.2 has every count source
  the checker no longer admits write `int(…)` around its count. The only such source is
  `lib/preview/engine/__tests__/fixtures/sectionEntry.ts` (`container-live-count-entry`'s
  `computed`, §6.1): with it rewritten, every other document of the 406 the corpus held at the base
  is admitted at the head with no `REPEAT_COUNT_TYPE` finding, so `proof/corpus/producers.ts` and
  `lib/commcare/__tests__/compilerEvidence.ts` are untouched. The corpus at the head holds 408
  documents, the base's and the two targeted documents of §9.

## What other parts read from this one

- **Part 01 (case writes):** an operation over a query repeat's rows keeps `/data/r/item/…` paths
  in both placements; a row past the end is not relevant, so its operations write nothing (G2's
  outcome B2 adds the conjunct `nova_query_id_r != ''` to such operations' conditions); the preload
  half's "later reader" walk includes model iteration's `@ids` setvalue; the query repeat's held
  slot lands in pull request 3, ahead of the operations' slots, and both are written only by
  `holdPlacements` from pull request 5.
- **Part 02 (emission):** query-repeat rows have the same paths in both placements; the row id node
  per placement (§1.6); case blocks stay the row's first child, so
  `lib/commcare/casePlacementPlan.ts::planFormCaseWire` places a row's case blocks alike in both
  placements and reads a row's record id through `formNodeProjection`'s `wire` surface.
- **Part 03 (publish and ledger):** the target `{ target: "query-repeat", fieldUuid, placement }`
  (pull request 5), over a slot that exists from pull request 3 and that `addField`,
  `updateField` and a duplicate never carry; `queryRepeatPlacementExpresses` for
  `placementChangeRefusal`; `placementsToHold` holds every unheld query repeat's effective
  placement; a target that leaves (mode change, conversion, removal) is no hold change; the rule's
  restoring arm, which admits §1.7's undo and the re-creation of a removed held query repeat; the
  cutover's query-repeat holds and decision 5's exception (§7.1); `QUERY_REPEAT_MODEL_ITERATION_SHAPE`
  among the codes the reconciler reads as a conflict.
- **Part 07 (authoring):** the move's facts and corrected consequence (§1.7); the reasons
  `planQueryRepeatPlacementMoves` returns, `nested`, `query-reads-answers` and
  `ancestor-condition-changes` (this part's need kinds, which `IdentityMoveReason` takes by these
  names, the third's sentence covering a condition that calls `now()`); the count refusal's messages
  (§2.5); `field_list`, `plain_label` and the stored slots they write; the birth rule
  `lib/domain/fields/group.ts::groupBornFieldList` (§3.6), which fills an omitted `field_list` on
  add; the verdict sentence (§3.5); the feature note row that states `plain-text`; the facts of pull
  request 3's guide and tool text (§8.4), with this part's row sentence (a row keeps its place, so
  its answers stay with that place) in the Rows editor and the guide, so pull request 13 does not
  rewrite it; the one billed schema check at pull request 13's head covering `addFields` and
  `editField` (G5); the claims for the `../nova-plugin` sweep (§8.4).
- **Part 08 (proof):** §6.1's moves by pull request, with the corrected counts (finding 7); the
  manifest rows of §5; `targeted-query-repeat-placements` holds a model iteration at the root, a
  nested repeat, one reading an answer, and one whose result shrinks with a case operation per row,
  and a query repeat under a later-relevant group is held by `container-query-conditional-parent`
  and the witness's `later`; `targeted-repeat-count-whole` holds counts from an `int` question, an
  integer single select (`1`, `2`, `3`), a Hidden Value calculated `2`, and
  `int(#form/weight div 2)`; `targeted-field-list-flags` holds a labelled group with and without
  `fieldList`, an unlabelled one with it, a count repeat inside one, and a user repeat in a group
  without; `targeted-plain-labels` (part 08's pull request 9 split of the markdown half) holds a
  plain question label, a plain group label and a plain choice with `*not bold*`, `# 5`, `1. first`
  and `<b>tag</b>`, and the same texts with markdown; ContainerRuntimeTest asserts a row's answers
  stay at its position (G2), and no row-identity run exists; a spec's document sets a query
  repeat's held `placement` directly from pull request 3; `targeted-migration-query-repeats`'s
  migrated spec holds `model-iteration` on its root repeat and leaves its nested and conditioned
  repeats unheld in the count placement (Q1, part 09 §8.5), and expects, under G1's outcome A, for
  those count-placed repeats the removed attribute leaves (`@ids`, `@count`, `@current_index`,
  `item/@id`, `item/@index`) and the added `nova_query_ids_r`, `nova_query_count_r` and
  `item/nova_query_id_r`, and no answer path;
  `targeted-migration-repeat-counts` expects the removed `nova_count_<repeat>`; the fuzz mapping's
  defect 25 item is empty (an unpublished draw holds no placement, and emission derives it), its
  defect 30 item calls `lib/doc/repeatCountWraps.ts::planRepeatCountWraps` (today's draws `3`, `1 + 2`, `int(3)` and
  `int(abs(...))` are all `int`, so it changes none), and its defect 27 item calls
  `lib/doc/groupFieldLists.ts::planGroupFieldLists` with the frozen label predicate, both kept in
  `lib/doc` after pull request 16; the corpus sources' labelled groups take
  `fieldList` in pull request 9 so their bytes stay, `targeted-labelled-group-repeat`'s `household`
  takes none; the `+` of integers is `int`, so `container-expression`, `container-nested-count` and
  the live-count documents' field-plus-literal counts need no wrap unless a summand is decimal (the
  `+ 0.7` one is wrapped); documents whose wire moves in pull request 3: every query-repeat document
  and every count document whose count becomes direct (`targeted-repeat-count-copy`,
  `container-hidden-count` where its Hidden Value's calculate is `int`); G1 at pull request 3's head
  with the count documents and `case-operation-query` beside part 08's query list, G2, and G3 over
  part 08's pull request 9 list with its G5 slice, as written.
- **Part 09 (cutover):** §7.1's classes, functions and copy; the frozen label predicate is
  `platformUses.ts::groupLabelShows` at `2f985ed6`; a group without the flag is absent, never
  `false`; a section takes no flag (the cutover brief's step 3 writes `false` and a section `true`,
  which this part's schema does not hold, and part 09 §7.11 follows the schema); decision 5's
  query-repeat exception; §7.1's scan findings, and the two shapes its advisory dry run decides
  (G4).
- **Part 10 (stack and contracts):** the query repeat's `placement` slot in pull request 3 and its
  writer, rule and move planner in pull request 5 (§12); the contract rows
  "the `__nova_` count container, `count_bound`, `query_bound`" read: `nova_count_<repeat>` only for
  a count that is not a direct read, the two query placements with their nodes, and "markdown itext"
  as §8.1's pull request 9 sentence; `RUNTIME_VERSION` 18 and `MODEL_CONTEXT_VERSION`
  `"v6-hq-round-trip-case-writes.3"` in pull request 3.
- **For the outlines (written by the plan's own pull request):**
  - `6-import.md`: recognizing the count placement at import (the wrapper Group, `nova_query_ids_`,
    `nova_query_count_`, `nova_query_id_`, the guard condition, the position and index nodes) as one
    query repeat with its placement held; the authoring spelling of both placements; widening model
    iteration's admission to the research's load-time rule for imported repeats, since step 5 has no
    import to need it; holding a hint or validation message imported without a markdown form, since
    step 5 always writes one and no runtime reads it; holding a help text imported without a markdown
    form, because republishing it adds markdown rendering on Android; `Form.plainText` for
    `vellum:ignore="markdown"` (`questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable`,
    HELD-NEW), which only an imported form holds; reading `plainLabel` from an item's `hasMarkdown`,
    including the one Vellum turns on when an HQ author types text that looks like markdown
    (`javaRosa/util.js::looksLikeMarkdown`); a field-list appearance spelled in another case, which
    Core reads and Vellum loads as a plain group.
  - `7-rest-of-model.md`: nothing from this part.
