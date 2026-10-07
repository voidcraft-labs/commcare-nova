# Step 2, part 05: Work item D, part 2: XForms inside HQ's editable envelope (defect 13; findings 33, 37, 45, 46, 47, 55)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part makes every form Nova exports one that HQ's form builder (Vellum) opens, saves and writes back unchanged in meaning. It owns defect 13 in all its parts, findings 33, 37, 45, 46, 47 and 55, and defect 14's data node name, which is one change with finding 46. It moves 210 register entries to `proof/fixed-defects.json` (212 where pull request 1 registered work item H's two): 176 for defect 13, 16 for finding 33, 2 for finding 37, 3 each for findings 45, 46 and 55, 4 for finding 47, and defect 14's 3 data node name entries.

Conventions for this part:

- HQ paths are relative to `corehq/apps/app_manager`. Vellum paths are relative to Vellum `src`. Core, Android and Connect are named by repo.
- "Executed during planning" marks a fact that was run against Core or Vellum's XPath library at the pins. Every other upstream fact rests on reading the source, and the pull request's proof 4 run (HQ's build, then two Vellum saves) is its confirmation. The rule for a reading-only fact the lane contradicts is in "Facts that rest on reading".
- `proof/identity-moves.json` gains no entry from this part. Proof 1 compares two exports of one document by one revision of Nova, so an emitter rename or a migration moves both sides alike. What moves once in HQ is listed under each block's **Identity** and held by the cutover's tests over the frozen pre-step fixtures.
- No pull request in this part adds an `/api` route. Two change a tool's input schema or its description (the root create id and the reserved-name removal); for each, the implementer asks the person before running `npm run test:schema`, which bills one live request per schema. Each is a change to the tool catalog, so pull requests 6 and 7 each bump `lib/models.ts::MODEL_CONTEXT_VERSION`; part 11, The model-addition checklist, item 13, is the one list of the pull requests that do and of the value each sets.

## Every node the emitter adds to a form

Nova's authored content is questions, case operations and Connect blocks. Everything else in a form's data tree is generated. From step 2 every name Nova mints in a form's source is `nova_<purpose>...`, starts with a letter, and comes from one allocator; the row element `item` and the build's own `case`, `subcase_<n>` and `commcare_usercase` keep the names CommCare gives them. Nova reserves no question names for its own nodes: an author may name a question `nova_url_x`, and the allocator steps around it. The names Nova refuses are the ones HQ's form builder cannot keep (defect 15, finding 43).

### Nodes in the form source (HQ upload and local archive both)

| # | Today | From step 2 | Written by | Structure and binds from step 2 | Left for step 5 |
|---|---|---|---|---|---|
| 1 | `__nova_constraint_<question>_<n>` | `nova_constraint_<question>_<n>` | `xform/builder.ts::buildFieldParts`, planned by `xform/constraintCollections.ts::planConstraintCollections` | Hidden Value beside the validated question. Bind `type="xsd:int"`, `calculate` the lifted `count(other[predicate])`, `relevant="count(<question>) > 0"`. No `vellum:calculate` (its expression filters a form reference) | none |
| 2 | `nova_constraint_message_<question>` | unchanged | `builder.ts::buildFieldParts`, named by `xform/constraintMessage.ts::ConstraintMessageNames.allocate` today | Sibling with a body `<input>` whose label is the question's `-constraintMsg` itext. Bind `type="xsd:string" relevant="false()" readonly="true()"`. The one generated sibling that carries a control | none |
| 3 | `__nova_url_<question>` | `nova_url_<question>` | `builder.ts::buildFieldParts`, named by `xform/captureUrlNode.ts::captureUrlNodeName`; `lib/commcare/formActions.ts` names the same node | Hidden Value beside the capture. Bind `type="xsd:string"`, `calculate` the link expression, `relevant="count(<capture>) > 0"` | none |
| 4 | `__nova_datetime_<question>` | `nova_datetime_<question>` | `builder.ts::buildFieldParts`, named by `xform/datetimeCaseValue.ts::datetimeCaseValueName`; `formActions.ts` names the same node | Hidden Value beside the datetime question. Bind `type="xsd:string"`, `calculate` `datetimeCaseValueExpression(<question>)`, `relevant="count(<question>) > 0"` | none |
| 5 | none | `nova_trimmed_<question>` (finding 33) | `builder.ts::buildFieldParts`; `formActions.ts::buildFormActions` names it | Hidden Value beside each question a basic action or a source-lowered block (`nova_update_selected_cases`, `nova_subcase_<n>`) reads as a case name or external id. Bind `calculate` the trim `caseOps.ts::caseScalarTextValueCalculation` writes today (`replace()` of leading and trailing code units U+0000 to U+0020), `relevant="count(<question>) > 0"`, no `type` | none |
| 6 | `nova_count_<repeat>` | unchanged | `builder.ts::buildRepeatBody`, named by `xform/repeatCountNode.ts::repeatCountNodeName` today | Hidden Value in the repeat's parent scope. Bind `type="xsd:int"`, `calculate` the count expression | the copy of a hidden value's count (defect 30) |
| 7 | query repeat `<id ids count current_index vellum:role="Repeat"><item id index jr:template>` | unchanged | `builder.ts::buildContainer`, `buildRepeatBody` | Author-named wrapper; binds on `@count` and `@current_index`; three setvalues | `nova_query_count_<repeat>`, `nova_query_id_<repeat>` and the placement (defect 25) |
| 8 | `__nova_operations` (a data element with children and no control) | `nova_operations`, a group | `xform/caseOps.ts::buildCaseOperations`, placed by `attachCaseOperationData` and `attachCaseOperationBody` | Data element plus body `<group ref="<path>"/>` with no label, no appearance and no bind. First child of `/data`; last authored-scope child of a repeat's template; first child of a selected-cases `item` | none |
| 9 | `<operation id>` | unchanged name | `caseOps.ts::buildCaseOperations` | Save to Case block (`vellum:role="SaveToCase"`, `vellum:case_type`). No bind on the block itself. Its condition moves (rows 11 and "Wrapper conditions") | attachment children (defect 23) |
| 10 | none | `nova_caseid_<operation id>` | `caseOps.ts::buildCaseOperations` | Hidden Value inside `nova_operations`, immediately before its operation's block and outside every condition group. Bind `type="xsd:string"`. Emitted only when something other than the operation's own block reads its case id | none |
| 11 | none | `nova_condition_<operation id>`, a group | `caseOps.ts::buildCaseOperations` | Data element inside `nova_operations` plus body `<group ref>` inside the `nova_operations` control. Bind `relevant` the operation's condition | none |
| 12 | `__nova_guard_<operation uuid>_<linkIndex>`, `..._retype_identity`, `..._text` (hand-written `<case><update/></case>`, no role) | `nova_guard_<operation id>_type`, `nova_guard_<operation id>_retype`, `nova_guard_<operation id>_text` | `caseOps.ts::buildCaseOperations` | Update-only Save to Case blocks after the operation's block: at most one of each kind per operation | none |
| 13 | `__nova_selected_cases` | `nova_selected_cases` | `caseOps.ts::buildCaseOperations` | Unchanged structure (`vellum:role="Repeat"`, `ids`, `count`, `current_index`, `item` template, body `<group><repeat jr:count jr:noAddRemove>`), except that its `item` now holds a `nova_operations` group whose control sits inside that `<repeat>` | the placement and model-iteration shape (defect 25) |
| 14 | `__nova_update_selected_cases` | `nova_update_selected_cases`, inside the group `nova_condition_update_selected_cases` | `caseOps.ts::buildCaseOperations` | Update-only Save to Case block per selected case. Per-row `relevant` kept; the "some shared answer is present" condition is the group's `relevant` | the `<attachment>` child (defect 23) |
| 15 | `__nova_close_selected_cases` | `nova_close_selected_cases` | `caseOps.ts::buildCaseOperations` | Close-only Save to Case block. Its condition stays `relevant` on `<block>/case/close` | none |
| 16 | `__nova_subcases` (a data element with children and no control) | `nova_subcases`, a group | `caseOps.ts::buildCaseOperations` | Data element plus body `<group ref>` with no bind; appended at the root or in the owning repeat | none |
| 17 | `__nova_subcase_<n>` | `nova_subcase_<n>` | `caseOps.ts::buildCaseOperations` | Save to Case create (with update, index and close). Its condition is `relevant` on `<block>/case` | the `<attachment>` child (defect 23); the inert subcase action beside it (defect 24) |
| 18 | none | `nova_close`, inside the group `nova_condition_close` | `caseOps.ts::buildCaseOperations` (defect 14's close conditions, pull request 9; part 06, 2. Close conditions the Case Management tab cannot state) | Close-only Save to Case block for the loaded case of a single-select form whose close condition the Case Management tab cannot state. The group's `relevant` is the condition | none |
| 19 | Connect blocks `<connect id>` | unchanged name | `builder.ts::buildConnectBlocks` | Author-named `vellum:role="Connect..."` wrapper. A deliver unit gains an empty `work_area_id` with a bare bind (finding 55) | none |

Not question names, and unchanged: the itext form names `__nova_identity`, `__nova_mode` (with `;markdown`, `;image`, `;audio`, `;video`, `;video-inline`), `__nova_locale` and `__nova_piece_<n>` that `constraintMessage.ts::protectConstraintMessage` writes on a protected message's `<text>`. Vellum's question id rule does not read `<value form>` names (`mugs/baseSpecs.js`, `databind.nodeID.validationFunc` validates node ids only), the manifest holds them (`questions/protected-constraint-message-forms`), and the rename leaves them alone. The `__nova_mode;<medium>` forms leave with validation-message media in part 08, Defect 16: three media slots leave the model, not here.

### Nodes only the local archive adds

`xform/caseBlocks.ts::addCaseBlocks` adds `case`, `subcase_<n>` and `commcare_usercase`, and `xform/metaBlock.ts::addMetaBlock` adds `orx:meta`. These are the names HQ's own build writes (`xform.py::XForm._create_casexml`, `_add_usercase`, `_add_meta_2`), so they keep them. Finding 37 changes their order; finding 33 changes what their name and external id binds read.

### The one allocator

New file `lib/commcare/xform/generatedNodes.ts` exports `planGeneratedNodes(doc, formUuid, connectIds): GeneratedNodePlan`, a pure function of the document. It replaces `repeatCountNodeName`, `ConstraintMessageNames`, `captureUrlNodeName`, `datetimeCaseValueName` and the literals in `caseOps.ts`. Lookups are by purpose and owner identity, never by path: `constraintCount(fieldUuid, n)`, `constraintMessage(fieldUuid)`, `url(fieldUuid)`, `datetime(fieldUuid)`, `trimmed(fieldUuid)`, `count(repeatUuid)`, `operations(scope)`, `subcases(scope)`, `selectedCases(scope)`, `caseId(operationUuid)`, `condition(operationUuid)`, `guard(operationUuid, kind)`, `subcase(n)`, `updateSelectedCases()`, `conditionUpdateSelectedCases()`, `closeSelectedCases()`, `close()`, `conditionClose()`.

The collision rule, which is deterministic:

- **Base.** `nova_<purpose>_<owner id>[_<ordinal or kind>]`, or the fixed name for a container.
- **Scope.** One namespace per parent element. A question's generated siblings share the namespace of the question's container (a query repeat's `item` is its own). Every name inside one `nova_operations` group shares one namespace, including names nested in its condition groups, so adding or removing a condition never renames a node. `nova_subcases` likewise.
- **Taken before any allocation.** Every authored name in the scope: every sibling question id, earlier or later; at the form root, the form's Connect block ids; in a `nova_operations` scope, the id of every case operation whose block lands there.
- **Suffix.** A base that is taken becomes `<base>_<n>` for the smallest `n >= 1` not taken. This is the numbering `repeatCountNodeName` and `ConstraintMessageNames` use today, so no live `nova_count_` or `nova_constraint_message_` path moves. `lib/domain/idSlug.ts::suffixUntilFree` starts at `_2` and is for ids Nova mints for authors; it is not used here.
- **Allocation order**, each allocation joining the taken set: questions in `orderedFieldUuids` order, and for one question its constraint counts by ordinal, its constraint message, its url, its datetime, its trimmed value, then (a repeat) its count; then the scope's containers in the order `nova_operations`, `nova_subcases`, `nova_selected_cases`. Inside a `nova_operations` namespace: operations in `orderedCaseOperations` order, each `nova_caseid_`, then `nova_condition_`, then guards in the order `type`, `retype`, `text`; then `nova_condition_update_selected_cases`, `nova_update_selected_cases`, `nova_subcase_<n>` ascending, `nova_close_selected_cases`, `nova_condition_close`, `nova_close`.

Why it is stable across republish: the plan is a function of the document alone, so two exports of one document agree. A generated name changes only when its owner is renamed (which moves the owner's own path too) or when an authored sibling equal to it appears or disappears. Both are edits to the same form, inside the edit's footprint (`proof/corpus/footprint.ts`). Nova accepts an authored question named like a generated node without a refusal or an advisory, because step 6 must read HQ apps that hold one; the cost, stated in `lib/commcare/CLAUDE.md`, is that the generated node's HQ export column moves to the suffixed path when an author adds such a question.

### The two structural rules Vellum's parser imposes

Both are from `parser.js::parseControlTree` (`merge`) and `parser.js::parseControlElement`, and apply per parent: the root, each group, each repeat.

1. **Control order mirrors data order.** A parent's body controls, in body order, name that parent's data children in the same relative order. Data-only children (Hidden Values, Save to Case blocks) may sit anywhere between them. One control out of order makes Vellum rebuild the parent as every control-bearing child in control order followed by every data-only child, which moves case blocks, and Core applies case blocks in document order (commcare-core `XmlFormRecordProcessor.process`).
2. **Each control sits inside its data parent's control.** A control whose parent control is not its data parent's is re-parented, and `form.js::dataTree` then appends it at the end of the data parent's children.

What the emitter does with them:

- the root `nova_operations` control is the first child of `<h:body>`, as its data is the first child of `/data`;
- a repeat-scoped `nova_operations` control is appended inside that `<repeat>` after the authored controls and before the `nova_subcases` and `nova_selected_cases` controls of the same scope, the order `attachCaseOperationData` places their data;
- a selected-cases `nova_operations` control is the only child of the selected-cases `<repeat>`;
- each `nova_condition_` control sits inside its `nova_operations` control, in the order of its data element among that group's condition groups;
- no Save to Case block and no Hidden Value has a control (`saveToCase.js` mug options `isDataOnly`; `mugs/types/misc.js::DataBindOnly`).

### Save to Case facts the emitter follows

All from Vellum `saveToCase.js` (`getBindList`, `getSetValues`, `parseDataNode`, the plugin's `parseBindElement`, `handleMugParseFinish`, `dataChildFilter`, the `case_id` and `updateProperty` validation functions).

| Fact | What Nova writes |
|---|---|
| The plugin loads only with the `save_to_case` plan privilege (`views/formdesigner.py::_get_vellum_plugins`). Without it every block parses as Hidden Values and its attribute binds are discarded | Every app with a block in a form's source needs that privilege; the confirmation of part 03, C2. Plan features: the per-privilege confirmation, covers it |
| An update-only block needs at least one property row with a name matching `/^[a-z][\w-]*$/i` and a parseable `calculate`; an `<update>` child with no bind is dropped and is the error "Add at least one property to update, or deselect the Update action." | A guard writes `update/case_type` with its own bind |
| A block that creates merges its update rows into its create rows after the parse, and needs no update row | A create carries `create/case_type`, `create/case_name`, `create/owner_id` and any update rows |
| `relevant` on the block's own node is never written back | No bind on a block |
| `relevant` on `<block>/case` is written back only for a block that creates (the Open Case Condition) | Used only on creates |
| `relevant` on an update, create or index row is kept; `relevant` on `<block>/case/close` is kept; a `relevant` on `create/case_type` or `create/case_name` is promoted to the Open Case Condition | Per-row conditions stay on rows; close conditions stay on `case/close` |
| `relevant` on a wrapping group is kept (`mugs/defaultOptions.js::getBindList`) | Conditions of updates and closes live on `nova_condition_` groups |
| No row bind carries `type` or `constraint`; only `@date_modified` is typed (`xsd:dateTime`) | No `type` on a leaf; `@date_modified` stays typed |
| Children of `<case>` are written `create`, `update`, `close`, `index`; children of `<create>` are `case_type`, `case_name`, `owner_id` | That order |
| Binds are written: (a create inside a repeat) `@case_id`; `<block>/case` `relevant`; `create/case_type`; `create/case_name`; `create/owner_id`; update rows; `case/close`; index rows; `@date_modified`; `@user_id`; (a block that does not create) `@case_id` | That order |
| A create outside a repeat carries its id as `<setvalue event="xforms-ready" ref="<block>/case/@case_id" value="...">`; a create inside a repeat as a bind; given the other way round, a save rewrites the first and loses the second | Setvalue outside repeats, bind inside |
| The Case ID must contain a path or a function call, and `uuid()` only with Create | `uuid()` on creates only; `if(...)` and paths elsewhere |
| Each `<index>` child must carry both `case_type` and `relationship`; a missing one is written back as the literal `undefined` | Both attributes on every index child |
| Vellum checks the scalar fields (`case_id`, `caseName`, `ownerId`, the conditions) for unknown questions and skips the property rows (`suppressUnknownReferenceWarning`). Its check reads only absolute `/data/` paths and hashtags (`logic.js::_addReferences`) | No expression reads `<block>/case/@case_id`; shared ids are read from `nova_caseid_` |

### Facts that rest on reading

| Design | State | Decided fallback |
|---|---|---|
| The datetime leaf expression keeps the full instant | Executed during planning, on Core at the pin, in three device zones | none needed |
| A raw casedb read is shown as `#case/<property>` only for a listed property, and is written back unchanged otherwise; `current()/..` reads are left alone; an absolute `/data/a` default becomes `#form/a` with or without a shadow | Executed during planning, on the XPath library Vellum pins, with Vellum's own conversion callbacks | none needed |
| Vellum keeps the group containers and reorders nothing when control order mirrors data order | Reading (`parser.js::parseControlTree`). Proof 4 over `case-operation-*` in the second XForm pull request confirms it | If either Vellum save moves a node of a `nova_operations` group, that pull request instead puts every operation in a group of its own: `nova_condition_<operation id>` exists for every operation, carries `relevant` only when the operation has a condition, and holds `nova_caseid_<operation id>`, the operation's block and its guards in that order. `nova_operations` then holds groups only, so control order is the whole order. Under the fallback: a conditional create keeps `relevant` on `<block>/case` as well; `nova_condition_update_selected_cases`, `nova_condition_close` and `nova_subcases` are unchanged; every operation block's path gains the group step, not only a conditional update's or close's, and the **Identity** paragraphs of "Reserved names and wrapper containers" and "Wrapper conditions" then say so (the `data-paths-move-once` line of part 10, Changes that write nothing and still get a line, already says case blocks sit inside groups, so its copy does not change); `nova_caseid_` inside the group overrides the placement stated for it, and its bind takes no `relevant` of its own, so a reader of it inherits the producer's condition, which is the condition every such reader already carries |
| Everything else in the Save to Case table, the itext fill, and the title rule | Reading | Proof 4 in the fix's pull request is the confirmation. A difference stops that pull request; the emitter is corrected to the bytes the lane's Vellum save writes back, and no register entry is added for it |

## Order the parts land in

Three pull requests of the step's one stack carry this part. An entry whose path holds `__nova_` must be fixed before, or in, the pull request that renames the nodes, because an entry must show on its document and on its control, and a control keeps its pre-fix bytes.

| Stack position | Parts | Entries moved to the fixed register |
|---|---|---|
| XForm, first part (pull request 6) | leaf constraints; shadows with findings 45 and 47; datetime leaves; the root create id; relative defaults; the registration case-id read; blank translations; finding 55; the ref-less repeat group; finding 46 with the data node name | 65 (67 with work item H's two, where pull request 1 registered them): defect 13's 49 (13 leaf constraint, 8 shadows, 5 datetime, 14 root create id, 4 defaults and case-id read, 5 translations), findings 45 (3), 47 (4), 46 (3), 55 (3), defect 14's data node name (3) |
| XForm, second part (pull request 7) | containers as groups; the rename and the allocator; guards; conditions; `nova_caseid`; defect 23's and 24's entries re-pathed onto new controls | 127: guard blocks 67, reserved names 25, wrapper containers 6, wrapper conditions 29 |
| Case writes through basic actions (pull request 9) | finding 33; finding 37; with defect 14's `update_case` always, moved close conditions and `external_id`, which are part 06's (1. `update_case` is `always` on every case form; 2. Close conditions the Case Management tab cannot state; `external_id` as an ordinary update row) | 18 from this part: finding 33's 16, finding 37's 2 |

Defect 3 (case save references) is pull request 8, after the restructure, because the guard blocks appear in `case_references_data.save` (part 04, Defect 3: `case_references_data.save`).

Work item H runs across the stack: its document `targeted-case-operation-read` and its control arrive in pull request 1 (part 09, Work item H: the unknown-question warning for a case operation's property); its two entries, where pull request 1 registered them, move to the fixed register in pull request 6 with findings 45 and 47 (under "Shadows"); and pull request 8 removes the open clause from `proof/README.md` (part 04, Work item H: defect 3's unknown-question clause).

Inside pull request 6 the `case-operation-key` document changes (its root create loses its key). It also carries 14 guard-block entries, which stay live until pull request 7, and whose control is `case-operation-sequence`. The rewrite (under "The root create id") moves the create into a repeat, so those 14 classes no longer show at the root on this document. They follow the re-homing rule of part 09, The 159 entries that remain, third case: the classes still show at the root on `case-operation-sequence`, the document their control was retained from, so each entry's `document` becomes the one `reconcile` reports and nothing else about it changes.

## Shadows (defect 13) with findings 45 and 47: no `#case/` shadow

**Today.** `hashtags/formContext.ts::vellumShorthandInContext` projects `#form/<path>` for every form reference whether or not it carries a predicate, and `#case/<property>` for every single-segment read of the form's own loaded case on a follow-up or close form. `builder.ts::buildFieldParts` writes the result as `vellum:calculate`, `vellum:relevant`, `vellum:constraint`, `vellum:requiredCondition` and `vellum:value`, and `builder.ts::buildXForm` publishes each case reference in the head's `<vellum:hashtags>` and `<vellum:hashtagTransforms>` (`lib/commcare/hashtags.ts::buildVellumTransforms`).

Three harms, one cause:

- A hashtag cannot be the base of a predicate or the head of a longer path (the XPath library's grammar: a hashtag is `#name/name/...` and nothing else). Vellum cannot parse `#form/a[...]`, writes the shadow verbatim into the real attribute (`util.js::writeHashtags`), and HQ's next build fails. Defect 13, shadows.
- `#case/status`, `#case/case_id` and `#case/owner_id` are saved through the prefix transform as child elements (`xpath.js::hashtagToXPath`; `datasources.js` lists no `@` key), which the case database does not have. Finding 45.
- `#case/<property>` for a property HQ's schema does not list (`app_schemas/casedb_schema.py::_get_case_schema_subsets`) is an unknown question on every save (`logic.js::_addReferences`). Finding 47, and defect 3's unobserved clause.

**Fix.**

- `vellumShorthandInContext` projects `#form/` only. Any other namespace in the expression means no shadow.
- It returns no shadow when, in the projected expression, a `HashtagRef` is the base of a `Filtered` node or the first component of a longer `Child` or `Descendant` path. Structure is read through the Lezer grammar (`lib/commcare/xpath/grammar.lezer.grammar`), as `planConstraintCollections` already walks `Filtered` bases. Every constraint count is such an expression and loses its shadow with no special case.
- The form's head carries no `<vellum:hashtags>` and no `<vellum:hashtagTransforms>`, and no `<output>` carries a `vellum:value` for a case reference.
- Why writing nothing is right for every class of read (the conversion executed during planning): for a property HQ lists, Vellum's reverse map turns Nova's raw path into `#case/<property>` on load and saves the same real attribute; for an unlisted property and for an attribute-backed read the raw path stays raw, draws no warning and is written back unchanged. The match is on the printed string, so Nova keeps printing the casedb read as `lib/commcare/hashtags.ts::expandCaseToWire` does today (single quotes, `@case_id = <session read>`).
- Work item H's clause closes here: with no `#case/` hashtag in any form source, and Vellum's only unknown-reference check reading `/data/` paths and hashtags, the warning cannot be produced from Nova's bytes. Defect 3's fix needs no ordering against this one.
- Stated in `lib/commcare/CLAUDE.md`: once a Vellum save has written its own `#case/x` shadow and `x` later leaves HQ's schema, Vellum warns about HQ's bytes, as it does for any form made in HQ; a Nova publish replaces the source.

**Files.**
- Emitters: `lib/commcare/hashtags/formContext.ts` (`vellumShorthandInContext`: drop the `onRef` parameter, the case vocabulary and the header's case paragraph; add the two structural tests); `lib/commcare/xform/builder.ts` (`buildXForm` loses the two head elements; `buildLabelNodes` loses the case `vellum:value`); `lib/commcare/hashtags.ts` (delete `buildVellumTransforms` and the `"#case/"` entry of `VELLUM_HASHTAG_TRANSFORMS`; `VELLUM_CASE_GENERATION_PREFIXES` stays for `hqLoadReference`, which still writes HQ's `#case/` strings into `case_references_data.load` of the HQ JSON; HQ's app summary reads that map (`app_schemas/app_case_metadata.py`), and Vellum posts a map on save and never reads the stored one).
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools, public docs: none. Preview evaluates the AST, not these strings.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Vellum dual-attribute pattern" and "Hashtag form-context", rewritten to say shadows carry `#form/` only and why.
- Proof: `proof/rules/test_vellum_hashtags.py` today takes the two head elements out of Nova's own form (`_dropped` asserts Nova wrote them). From this pull request its document is `standard-case-reads` and it works the other way: Nova's form (no maps) is spelling one, and the test inserts the two head elements a Vellum save writes for that document's listed property (their text copied into the test from the Vellum-saved source in proof 4's retained evidence of control `standard-case-reads`) for spelling two, and the same with one more hashtag in the map for spelling three. Its assertions are unchanged. `proof/rules/conftest.py::DOCUMENTS` gains `standard-case-reads`.
- Tests: the two tests of `lib/commcare/__tests__/expander.test.ts` behind the documents `expander-form-hashtag-expansion-emits-the-editor-1daa5537-0` and `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0` keep their titles in this pull request, so both document ids stay; their bodies assert the new bytes.

**Stored shape and migration.** None: shadows are derived at emission. No transform step, no notice.

**Register.** 15 entries to the fixed register (17 with work item H's two).
- Defect 13, shadows, 8: `d13-shadows-*`, all proof 4 (`source:form`, `build`, `validate_app`, `trace`); controls `container-query-conditional` (7) and `container-query-conditional-parent` (1).
- Finding 45, 3: `d45-blanked-case-reads-*`, proof 4; control `standard-case-reads`.
- Finding 47, 4: `d47-unknown-question-vellum-*`, proof 4 (`editor:vellum` and `editor:vellum again`); controls `standard-case-reads` (2) and `expander-form-hashtag-expansion-emits-the-editor-1daa5537-0` (2).
- Work item H, 2, only where pull request 1 registered them: `d3-operation-read-vellum-logic-bad-path-warning` and `d3-operation-read-vellum-again-logic-bad-path-warning` (defect 3, proof 4, `editor:vellum@*` and `editor:vellum again@*`, the `logic-bad-path-warning` on `#case/*`) move to the fixed register here, on control `targeted-case-operation-read`. Where pull request 1 found no class of its own, nothing moves and the document stays a passing witness.
- Defect 25's `d25-query-repeat-source-bind-nodeset` and `d25-query-repeat-vellum-parse-warning-bind-node-found` (document `container-query-conditional-relative`, control `container-query-conditional`) are step 5's and stay live. They are read from this pull request's run under the re-homing rule of part 09, The 159 entries that remain. Where a path moved, the entry is re-pathed from the run onto a new control `container-query-conditional-after-13`, because `container-query-conditional` is named by this block's fixed entries and keeps its bytes.

**Spelling rule.** None retires. `vellum_attributes`, `vellum_hashtags` and `case_references_load` still erase what Vellum's own save adds for a listed property.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `container-query-conditional`, `container-query-conditional-parent`, `standard-case-reads` and `expander-form-hashtag-expansion-emits-the-editor-1daa5537-0` keep showing the three symptoms on their pre-fix bytes, and `targeted-case-operation-read` keeps showing work item H's warning where pull request 1 registered it.

**Nova tests.**
- Pure: `vellumShorthandInContext` gives no shadow for `#form/a[#form/b > 1]`, `count(#form/a[. = 1])`, `#form/a/@x` and any expression holding a case reference, and keeps one for `#form/a + 1` and for a casedb selector whose predicate reads `#form/a`.
- Pure, over the emitted DOM: no attribute in the Vellum namespace, no `<output>` and no head element of any fixture form's source holds `#case/`, and no form has a `vellum:hashtags` element. This test is also work item H's closure.
- Native proof: `StandardCaseReadsRuntimeTest` already runs the raw reads on Core; unchanged.

**Lane.** Locally: `standard-case-reads`, `container-query-conditional-relative`, `container-query-conditional-parent`, the `emits-the-editor` expander document and `targeted-case-operation-read` through proof 4. CI's full lane shows no difference on any document in the three classes, the 15 fixed entries (17 with work item H's two) held on their controls, and HQ's build passing after both Vellum saves of the container documents.

## Guard blocks (defect 13)

**Today.** `caseOps.ts::buildCaseOperations` writes up to three kinds of guard per operation as hand-written `<case><update/></case>` wrappers with no `vellum:role`, named from the operation's uuid: one per expression-targeted link, `..._retype_identity` and `..._text`. Vellum parses each as a Hidden Value with children, discards the three attribute binds ("Bind Node [...] found but has no associated Data node"), and after a save the guard no longer refuses anything.

**Fix.** Each guard is an update-only Save to Case block, placed after its operation's block:

```xml
<nova_guard_OP_KIND vellum:role="SaveToCase" vellum:case_type="TYPE">
  <case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="" user_id="">
    <update><case_type/></update>
  </case>
</nova_guard_OP_KIND>
```

with binds, in this order: `.../case/update/case_type` `calculate="'TYPE'"`; `.../case/@date_modified` (`/data/meta/timeEnd`, `type="xsd:dateTime"`); `.../case/@user_id` (`/data/meta/userID`); `.../case/@case_id` `calculate="if(OK, ID, '')"`.

- `TYPE` is `operation.retype ?? operation.caseType`, the type the case holds once the operation's block has run, so the update writes a value to itself. This is the spelling Nova already emits for an index-only block (`usesTypeOrderingGuard` in `caseOps.ts`), which the native case proofs run, so the guard adds no new wire shape.
- `ID` reads `nova_caseid_<operation id>` (absolute at the root, through `current()` in a repeat). Every guarded operation therefore has a `nova_caseid_` node.
- `OK` by kind. `type`: the conjunction, over the operation's expression-targeted links in order, of today's per-link test `count(t) > 0 and string(t) != ID`, so an operation has one type guard however many links it has. `retype`: today's `not(starts-with(ID, 'nova-case-v1:'))`. `text`: today's conjunction of fixed-column validity.
- An operation has at most one guard of each kind, three in all.
- A blank `@case_id` still refuses the whole submission: commcare-core `CaseXmlParser.parse` with `CaseXmlParserUtil.validateMandatoryProperty`, and HQ's `corehq/form_processor/casedb_base.py::AbstractCaseDbCache.get` ("case_id must not be empty").
- A guard of a conditional operation sits inside that operation's `nova_condition_` group (see "Wrapper conditions").

**Files.**
- Emitters: `lib/commcare/xform/caseOps.ts` (the three guard sites collapse into one builder that takes the kind and the `OK` expression).
- Proof harness: `proof/native/core/CaseOperationRuntimeTest.java`, `CaseCaptureRuntimeTest.java`, `proof/native/test_case_emission.py` and `test_xml_boundary.py` name the old nodes and are updated here.
- Surface: `lib/commcare/surface/entries/questions.json`, the emission cells of `questions/hand-written-case-block-without-vellum-role-incl-a-root-data` and the `attribute-no-plugin-owns` entry stop saying Nova emits them; the dispositions stay REFUSED.
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools, public docs: none. Nothing outside `lib/commcare` reads these names, and Preview runs operations from the domain model.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Authored case-operation emission" (the guard paragraphs).

**Stored shape and migration.** None: guards are derived. The data paths of guard blocks move once (see "Reserved names and wrapper containers" for the notice).

**Register.** 67 entries, `d13-guard-blocks-*`: manifest 4 (`hand-written-case-block`, `attribute-no-plugin-owns`, two `hidden-value-with-children`) and proof 4 63 (Vellum's parse warnings, the binds missing from the saved form and its source, the case blocks and their `IllegalCaseId` refusals, Core's `InvalidStructureException`, the submission's three attributes per guard, one HQ soft assertion). Controls: `case-operation-query` (25), `case-operation-repeat` (20), `case-operation-sequence` (20), `case-operation-link` (2).

**Spelling rule.** None.

**Identity.** Guard block paths move once in every deployed app with a guarded operation. `proof/identity-moves.json` gains no entry.

**Control.** The four controls above keep showing the discarded binds and the refusals on their pre-fix bytes.

**Nova tests.**
- Pure, over the emitted DOM: an operation with two expression-targeted links, a retype and a rename emits exactly three guards with the block and bind order above, and each `@case_id` reads the operation's `nova_caseid_` node.
- Native proof: `CaseOperationRuntimeTest` keeps proving, on the local archive and on HQ's regenerated form, that a failed guard of each kind refuses the submission on Core and leaves the case database unchanged.

**Lane.** Locally: `case-operation-link`, `case-operation-sequence`, `case-operation-retype` and `case-operation-key` through the bar and proofs 3 and 4. CI's full lane shows every guard bind surviving both Vellum saves, no editor message on any guard, the same refusals from the saved form as from the published one, and the 67 fixed entries held.

## Reserved names and wrapper containers (defect 13)

**Today.** Rows 1, 3, 4, 8 and 12 to 17 of the node table start with `__nova_`, which Vellum refuses as a question id (`util.js::isValidElementName`: `/^(?!XML)[a-zA-Z][\w-]*$/`). `__nova_operations` and `__nova_subcases` are data elements with children and no control, so Vellum parses each as a Hidden Value, which takes no children (`mugs.js`, `validChildTypes`), and reports "Add at least one property to update" on the blocks inside. `lib/commcare/constants.ts::RESERVED_XFORM_NODE_PREFIX` reserves the prefix from authors through `validator/rules/field.ts::reservedFieldIdPrefix`.

**Fix.**

- Every name comes from `planGeneratedNodes` (above). `captureUrlNodePath` and `datetimeCaseValuePath` take the plan instead of deriving a name from a path, so `builder.ts` and `formActions.ts` cannot disagree.
- `nova_operations` and `nova_subcases` are groups: a data element plus a body `<group ref="<path>"/>` with no label, no appearance and no bind. Vellum's save adds a bind holding the node set alone, which `proof/rules/empty_binds.py` already erases; Nova does not emit that bind.
- Their controls are placed by the two structural rules above. `CaseOperationBodyChild` gains a placement, and `attachCaseOperationBody` prepends the root group.
- Nova reserves no question names for its own nodes. Deleted: `RESERVED_XFORM_NODE_PREFIX` with its stale comment, `lib/commcare/identifierValidation.ts::isReservedXFormNodeName`, `reservedFieldIdPrefix` with its code `RESERVED_FIELD_ID_PREFIX`, the `reserved_prefix` arm of `lib/doc/identifierVerdicts.ts::formatVerdict`, the `__nova_` arms of `caseOperationIdVerdict` and `caseOperationLinkIdentifierVerdict`, the two `__nova_` arms in `validator/rules/caseOperations.ts`, and the `.refine` on `operationIdInputSchema`. Defect 15's narrowing (part 08, Defect 15: identifiers HQ's editors refuse) is what holds ids to Vellum's grammar from here on.
- `builder.ts::isRepeatCountSnapshot`, its two filters in `buildXForm` and the comment above them are deleted here: no emitter writes a `__nova_count_` setvalue, so the partition is the identity and the output is byte-identical. They are deleted here and not with defect 16's other stale items, because the function reads the prefix this pull request deletes, and pull request 7 lands first. Part 08, Defect 16: what the code, the tools and the docs say, does not delete them.
- The cutover's matcher reads forms HQ holds from before the step, so it keeps its own `"__nova_"` literal in `scripts/lib/hqRoundTripCutover/` and does not import the constant this pull request deletes.

**Files.**
- Emitters: new `lib/commcare/xform/generatedNodes.ts`; `lib/commcare/xform/builder.ts`, `caseOps.ts`, `captureUrlNode.ts`, `datetimeCaseValue.ts`, `constraintCollections.ts`; `lib/commcare/formActions.ts`; `repeatCountNode.ts` and `ConstraintMessageNames` fold into the new file; `lib/commcare/constants.ts`; `lib/commcare/identifierValidation.ts`.
- Validator: `lib/commcare/validator/rules/field.ts`, `rules/caseOperations.ts`, `validator/errors.ts`, `validator/gate.ts`.
- Doc and mutations: `lib/doc/identifierVerdicts.ts`, `lib/doc/userFacingErrors.ts`; the comment in `lib/doc/caseOperationOrder.ts`.
- Preview: `lib/preview/engine/formEngine.ts` reads the count node's name from the plan in place of `repeatCountNodeName`.
- Builder: comments in `components/builder/editor/FieldIdentitySection.tsx` and `components/builder/editor/renameOutcome.ts`.
- SA and MCP tools: `lib/agent/tools/case-operations/shared.ts` (`operationIdInputSchema`), comments in `lib/agent/tools/editField.ts` and `lib/agent/tools/shared/fieldAssembly.ts`. The schema's refinement changes, so ask the person before running `npm run test:schema`.
- Proof harness: `proof/checks/compare/names.py` (`NOVA_CONTAINERS`, `NOVA_MINTED`, `nova_name`, `data_name`) reads the new fixed names (`nova_operations`, `nova_subcases`, `nova_selected_cases`, `nova_update_selected_cases`, `nova_close_selected_cases`, `nova_close`) and minted families (`nova_url_`, `nova_datetime_`, `nova_constraint_`, `nova_trimmed_`, `nova_caseid_`, `nova_guard_`, `nova_condition_`, `nova_subcase_`, each written `<family>*`), and keeps reading every `__nova_` name, because the fixed entries' controls hold them. Order of the tests in `data_name`: a fixed name first; then a name starting `nova_constraint_message_` or `nova_count_`, written `*` as today so defect 30's paths do not move; then the families. A constraint count of a question whose id starts `message_` (`nova_constraint_message_x_0`) is therefore written `*`, and an authored question named like a family member is written as that family; each loses only specificity. `proof/checks/manifest_value_classes.py::nova_scaffolding_part` likewise. Doc comments in `proof/checks/compare/names.py`, `compare/trace.py`, `proof/checks/proof3.py` and `proof/checks/differences.py` follow. `proof/checks/test_compare.py` and `test_manifest_value_classes.py` gain a case per new fixed name and minted family, with the two overlap cases, and keep their `__nova_` cases; `test_proof3_behavior.py` and `test_proof4_editability.py` keep theirs, which describe control bytes. `proof/README.md`'s defect rows follow.
- Tests that pin the removed rule or the old names: `lib/commcare/__tests__/repeatModes.test.ts`, `validationRules.test.ts`, `caseOperationEmission.test.ts`, `multiSelectEmission.test.ts`, `extensionCaseEmission.test.ts`, `caseCaptureEmission.test.ts`, `caseWriteBoundary.test.ts`, `lib/commcare/validator/__tests__/caseOperations.test.ts`, `lib/doc/__tests__/identifierVerdicts.test.ts`, `lib/agent/tools/__tests__/editField.test.ts`, `addFields.guard.test.ts`, `constructionFuzz.test.ts`, `lib/mcp/__tests__/compileApp.postgres.test.ts`. Not touched: `constraintMessageEmission.test.ts` and `proseWhitespace.test.ts` (itext form names, which stay) and the tests that hold `__nova_compatibility_probe__` (a probe's name, not a form node).
- Surface: `lib/commcare/surface/entries/questions.json` (`invalid-question-id`, `questions/hidden-value-with-children`) and `forms-and-case-writes.json`, the emission cells that say Nova emits these.
- Cutover: `lib/notices/migrationNotice.ts` (`DEPLOYMENT_NOTICE_REASONS` gains `data-paths-move-once`), `lib/notices/migrationNoticeCopy.ts` (its renderer, with part 10's copy), `scripts/lib/hqRoundTripCutover/notice.ts` (one line per deployment) and `report.ts` (the scan's count of affected forms, and their list under `--debug-details`, as part 10, Scripts and their layout, defines the report).
- Public docs: none name these nodes.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Validation counts keep their evaluation context", "Markdown itext", "Repeat modes", "Case-management scaffolding emission", "Authored case-operation emission": every `__nova_` name and "reserved" claim; the new statement that Nova reserves no question names for its own nodes, the allocator and the two structural rules); `lib/doc/CLAUDE.md` (the reserved-prefix sentence).

**Stored shape and migration.** No schema change and no document transform: the names are derived. The cutover adds one notice line with no document change and no step: deployment reason `data-paths-move-once`, written for every deployment with part 10's copy (part 10, Work item F: the migration notice); it names no form. This pull request adds the reason to `DEPLOYMENT_NOTICE_REASONS` with its renderer, and `notice.ts` writes it. The advisory scan counts, per app, the forms whose plan holds a renamed node, a block inside a group or a new leaf (`nova_caseid_`, `nova_trimmed_`), derived from `planGeneratedNodes` over the migrated document. The forms themselves, by id and name, are the report's detail: `--debug-details` prints them for one app (part 10, Scripts and their layout, under "The report"), so the people who own HQ form exports and reports built on the old paths can be told which forms to re-point. The scan also counts the forms where the unified plan gives a `nova_count_` or `nova_constraint_message_` name different from today's; the expected count is zero, and a count above it is read under the same flag.

**Register.** 31 entries.
- Reserved names, 25, `d13-reserved-names-*`: manifest 13 (`invalid-question-id`, one per name pattern and depth) and proof 4 12 ("is not a valid Question ID" on six patterns, both saves). Controls: `case-capture-multiple` (7), `case-extension-registration` (4), `case-operation-query` (4), `case-operation-sequence` (4), `container-query-conditional` (3), `case-extension-multiple-repeat` (1), `case-extension-repeat` (1), `container-query-conditional-parent` (1).
- Wrapper containers, 6, `d13-wrapper-containers-*`: manifest 4 (`hidden-value-with-children` for both containers) and proof 4 2 ("Add at least one property to update", both saves). Controls: `case-operation-query` (3), `case-extension-registration` (1), `case-extension-repeat` (1), `case-operation-sequence` (1).

**Defects 23 and 24 (step 5): paths the rename moves.** The rename and the group change move the structural paths of entries step 2 does not fix. They are re-pathed in this pull request, onto new controls:

- Defect 23, attachment-mode capture: the 60 entries whose `path` holds `__nova_selected_cases`, `__nova_operations`, `__nova_subcases`, `__nova_subcase_*` or `__nova_update_selected_cases`.
- Their six controls, `case-capture-multiple`, `case-extension-multiple`, `case-extension-multiple-repeat`, `case-extension-query`, `case-extension-registration` and `case-extension-repeat`, also serve entries this part moves to the fixed register, which need the old bytes. A directory a fixed entry names is never re-retained.
- So this pull request retains six new controls, `<old control name>-after-13`, from its own corpus (`python3 -m proof.checks.controls <corpus> <document id> manifest,proof3,proof4 --as <old control name>-after-13`, the document being the one of the same name; the name argument arrives in pull request 1), rewrites the 60 paths from that run's evidence (never by text substitution), and points every live entry of defects 23 and 24 that names one of the six old directories at its `-after-13` twin: defect 23's 61 (the 60 re-pathed and `d23-attachment-form-instance-attachment-in-a-savetocase-block`) and defect 24's 12 (which name `case-extension-registration`, `case-extension-query` and `case-extension-repeat`), 73 in all. Defect 23's other six name `case-capture-followup`, hold no Nova name and keep their control.
- Live entries of finding 33 (7), finding 37 (2) and defect 14's multi-select destinations (2, on `case-capture-multiple`) keep the old directories, which they need as fixed entries.
- The new controls are named by live entries only, so a later pull request of the stack may retain them again in place (findings 33 and 37 may, below).
- `proof/timings.json` gains the six `control:` groups.

**Spelling rule.** None retires. `empty_binds` now also erases the bare bind Vellum writes for the two groups.

**Identity.** In every deployed app, at its next publish: the data path of each node of rows 1, 3, 4, 8 and 12 to 17, and of every Save to Case block (now under `nova_operations`). HQ form export columns for the url and datetime siblings and for every block move. The notice above states it. `proof/identity-moves.json` gains no entry.

**Control.** The eight controls above keep showing the refused ids and the childless Hidden Values on their pre-fix bytes, which is why `names.py` keeps the legacy names.

**Nova tests.**
- Pure: `planGeneratedNodes` over a form with a question named exactly like each base (`nova_url_photo` beside a capture `photo`, `nova_operations` at the root, a Connect id equal to a base, a question `message_x` with a constraint count beside a question `x` with a protected message) gives the suffixed names in the stated order, gives the same plan on a second call, and gives today's `nova_count_` and `nova_constraint_message_` names for every existing fixture.
- Pure, over the emitted DOM: for every form every emission fixture produces (the fixtures of `lib/commcare/__tests__/caseOperationEmission.test.ts`, `multiSelectEmission.test.ts`, `extensionCaseEmission.test.ts` and `constraintMessageEmission.test.ts`, whose `nova_constraint_message_` sibling is the one generated node with a control, and every authored group and repeat in them), the sequence of control-bearing data children of each parent equals the sequence of that parent's controls, and each control's parent control is its data parent's.
- Pure: `formActions.ts` names exactly the url and datetime nodes `builder.ts` writes, under a collision.
- Pure: for a question id, an operation id and a link identifier, the verdict for `__nova_x` equals the verdict for `_x`: both accepted at this pull request, and both refused, by the leading underscore alone, once defect 15 lands in pull request 10. The test compares the two verdicts and names no outcome, so it does not flip.
- Pure, over the frozen pre-step fixture that witnesses `data-paths-move-once`: `notice.ts` gives each deployment exactly one such line, with no entities.

**Lane.** Locally: `case-capture-multiple`, `case-extension-registration`, `case-operation-query` and `container-query-conditional` through the manifest check, proof 3 and proof 4. CI's full lane shows no "is not a valid Question ID" and no "Add at least one property" on any document, no node of a `nova_operations` group moved by either Vellum save, the 31 fixed entries held on the old controls, and defects 23 and 24 held on the six `-after-13` controls.

## Wrapper conditions (defect 13)

**Today.** `caseOps.ts::buildCaseOperations` writes a conditional operation's condition as `relevant` on the block's own bind, repeats it on each guard wrapper, writes `relevant` on the `__nova_update_selected_cases` wrapper, and on a conditional `__nova_subcase_<n>` wrapper. Vellum's Save to Case writer writes no bind for a block's own node (`saveToCase.js`, `getBindList`), so after a save every conditional operation runs unconditionally.

**Fix.** Two spellings, by what Vellum keeps:

- **A conditional create** carries its condition as `relevant` on `<block>/case`, Save to Case's Open Case Condition. Its path does not move when the condition is added or removed, and it is the spelling an HQ author produces.
- **A conditional update or close** sits inside `nova_condition_<operation id>`, a group whose bind carries `relevant`.
- **Every guard of a conditional operation, create included, sits inside `nova_condition_<operation id>`.** A guard is an update-only block, Vellum gives an update-only block no condition, and a guard that ran while its create did not would update a case that does not exist and fail the submission (commcare-core `CaseXmlParser.loadCase`). Every create has a text guard, so every conditional create has both spellings of its condition.
- The condition is the conjunction Nova computes today (inherited producer conditions, then the operation's own), printed against the path it is bound to.
- `nova_update_selected_cases` sits inside `nova_condition_update_selected_cases`, whose `relevant` is today's "some shared answer is present". Without it an all-blank form would send an empty update for every selected case and touch each case's modified date. Its per-row `relevant` stays.
- `nova_subcase_<n>` is a create with no guards: its condition is the Open Case Condition and its path does not change.
- `nova_close_selected_cases` and a subcase's close condition already sit on `case/close`: no change.
- Order inside `nova_operations`, per operation: `nova_caseid_<operation id>` (when emitted); the block, when it is a create or has no condition; `nova_condition_<operation id>` holding the block (a conditional update or close) and then the guards. An operation with no condition has no group and its guards follow its block directly.

**Files.**
- Emitters: `lib/commcare/xform/caseOps.ts` (relevance binds move; groups are emitted with their controls).
- Surface: `lib/commcare/surface/entries/questions.json`, the emission cell of the `on-a-savetocase-node` entry; Nova's exports now use the HELD classes `questions/savetocase-open-case-condition` and `questions/savetocase-inside-a-group-whose-display-condition-gates-it`.
- Proof harness: the native tests named under "Guard blocks".
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools, public docs: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Authored case-operation emission" ("Conditions become wrapper relevance" becomes the two spellings and the reason).

**Stored shape and migration.** None. A conditional update's or close's block path gains the group step once; the `data-paths-move-once` line (under "Reserved names and wrapper containers") covers it.

**Register.** 29 entries, `d13-wrapper-conditions-*` other than the 13 leaf constraint entries: manifest 1 (`on-a-savetocase-node`) and proof 4 28 (the eight wrapper binds missing after a save, the extra case blocks and case database differences where an operation ran unconditionally, and the refusals where a conditional retype ran). Controls: `case-operation-retype` (10), `case-operation-expression-retype` (6), `case-operation-query` (5), `case-operation-repeat` (4), `case-capture-multiple` (2), `case-operation-conditional` (1), `case-operation-relation` (1).

**Spelling rule.** None.

**Identity.** The data path of each conditional update's or close's block, once. `proof/identity-moves.json` gains no entry.

**Control.** The seven controls above keep showing operations that run though their condition is false.

**Nova tests.**
- Pure, over the emitted DOM: a form with a conditional create, a conditional update, a guarded conditional create and a multi-select shared update emits exactly the spellings above, with each control inside its data parent's control.
- Native proof: `OperationRelevanceRuntimeTest` and `CaseOperationRuntimeTest` keep proving that a false condition leaves the case database unchanged and that a consumer of an unexecuted create does not run.

**Lane.** Locally: `case-operation-conditional`, `case-operation-retype`, `case-operation-expression-retype` and `case-capture-multiple` through proofs 3 and 4. CI's full lane shows the same case blocks and case database from the Vellum-saved form as from the published one on every `case-operation-*` document, and the 29 fixed entries held.

## Leaf constraints (defect 13)

**Today.** Nova writes a `constraint` on seven kinds of case-block leaf: three in `caseOps.ts::buildCaseOperations` (the selected-cases update's fixed text rows, a source-lowered subcase's `create/case_name`, and its fixed text update rows) and four in `caseBlocks.ts::buildCaseBlocks` (the primary `create/case_name`, the primary fixed text update rows, each subcase's `create/case_name` and its fixed text update rows), all through `caseOps.ts::caseScalarTextValueGuard`. None has ever run: Core evaluates a constraint only for a question being answered (commcare-core `FormDef.evaluateConstraint`, whose only callers are `FormEntryController.answerQuestion` and `checkQuestionConstraint`, both on a question's form index), and a case leaf has no control. Vellum drops the attribute on save, which is the registered difference.

**Fix.** Delete the seven `constraint` attributes. Nothing a worker sees changes, on any runtime.

- Authored case operations stay guarded by their live `nova_guard_<operation id>_text` block, which is a calculate.
- Core refuses a case name, external id, type or owner over 255 characters on its own (commcare-core `CaseXmlParserUtil.checkForMaxLength`).
- The working guard for basic-action writes arrives with finding 33, on the source question.
- `builder.ts` stops writing `required="true()"` on a source-lowered subcase's name question when that question is a Hidden Value: Vellum reports `required` on a Hidden Value as not allowed (`mugs/types/misc.js::DataBindOnly`), and a calculated value cannot be required of a worker.
- `proof/README.md`'s row for this part drops its claim that the save makes Core accept a blank or over-long value: Core's behavior is the same with or without the attribute.

**Files.**
- Emitters: `lib/commcare/xform/caseOps.ts`, `lib/commcare/xform/caseBlocks.ts`, `lib/commcare/xform/builder.ts` (the `requiredNamePaths` loop).
- Surface: `lib/commcare/surface/entries/questions.json`, the emission cell of the `in-a-savetocase-block` entry.
- Docs: `proof/README.md` (the defect row).
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools, public docs: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Authored case-operation emission" ("Guards cap every value" names the guard block, not a leaf constraint).

**Stored shape and migration.** None.

**Register.** 13 entries: `d13-wrapper-conditions-form-case-name-constraint-*` (6) and `d13-wrapper-conditions-source-case-name-constraint-*` (6), proof 4, and `d13-wrapper-conditions-form-bindconstraint-in-a-savetocase-block`, manifest. Controls: `case-extension-registration` (3), `case-capture-multiple` (2), `case-extension-multiple` (2), `case-extension-multiple-repeat` (2), `case-extension-query` (2), `case-extension-repeat` (2).

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** The six controls keep showing the dropped attribute.

**Nova tests.** Pure, over the emitted DOM: no bind whose node set is under a `case` element carries `constraint`, in the source or in the local archive; a Hidden Value that names a source-lowered subcase carries no `required`.

**Lane.** Locally: `case-extension-registration` and `case-capture-multiple` through proof 4. CI's full lane shows no `@constraint` difference on any document and the 13 fixed entries held.

## Datetime leaves (defect 13)

**Today.** `caseOps.ts::buildCaseOperations` gives the bind of a write to a datetime property `type="xsd:dateTime"`, because Core wraps a calculated `Date` as a date alone unless the bind asks for a datetime (commcare-core `Recalculate.wrapData`). Vellum writes a row's bind with `nodeset`, `calculate` and `relevant` only, so a save drops the type and the clock is lost.

**Fix.** One helper, one spelling, for the field sibling and the Save to Case leaf, so step 6's reader recognizes one calculate.

- `datetimeCaseValue.ts` gains `datetimeCaseValueExpression(expression)`, returning `if(E = '', '', format-date(coalesce(E, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`; `datetimeCaseValueCalculate(path)` calls it.
- In `caseOps.ts`, a write to a datetime property takes no `type` and its `calculate` is `datetimeCaseValueExpression(<emitted value>)`.
- Every `@date_modified` bind stays typed: that is Vellum's own spelling.
- Why the expression keeps the instant (executed during planning): `coalesce` returns the unpacked `Date` and `format-date` leaves a `Date` unrounded; without `coalesce` the node set is rounded to midnight. For one instant held as a datetime answer it printed `2026-01-02T20:15:30.123Z` on a UTC device, `2026-01-03T01:45:30.123+05:30` in Kolkata and `2026-01-02T12:15:30.123-08` in Los Angeles.

What changes for a value that is already a string, such as one datetime property copied to another. Today the typed leaf passes a string through byte for byte. From step 2 it is parsed and printed again (executed during planning):

| Value | Today | From step 2 |
|---|---|---|
| a datetime answer, `now()` | the instant, device offset | the same |
| blank | blank | blank |
| a stored datetime string | unchanged | the same instant re-printed in the device's offset with milliseconds; where the device's local date for that instant differs from the date written in the string, Core's parse places it a whole day wrong (commcare-core `DateUtils.parseTimeAndStore`) |
| a date-only string | unchanged | that day's local midnight |
| a date value (a date answer, `today()`) | that day's local midnight (commcare-core `Recalculate.wrapData` already makes it a datetime under the typed bind) | the same |
| text that is not a date | submitted as it stands | the form raises `XPathTypeMismatchException` (commcare-core `FunctionUtils.toDate`) |

This is accepted, and `lib/commcare/CLAUDE.md` says so: wrapping only expressions Nova can prove yield a `Date` needs a second spelling the reader would have to recognize, and a static distinction `lib/commcare/expression/onDeviceEmitter.ts` does not make. No later step is planned to change the day-boundary error on a copied datetime string: step 3 carries finding 56's ordering comparison only. It is accepted here, and `lib/commcare/CLAUDE.md` and the public docs for case changes say that copying a saved datetime re-prints it in the device's zone, and can move it a day when the device's local date for that instant differs from the date written.

**Files.**
- Emitters: `lib/commcare/xform/datetimeCaseValue.ts`, `lib/commcare/xform/caseOps.ts`.
- Surface: `lib/commcare/surface/entries/questions.json`, the emission cell of `savetocase-leaf-type` (disposition stays REFUSED).
- Docs: `content/docs/case-changes.mdx`, one sentence where a change's saved values are described (a saved date and time copied to another property is written again in the device's time zone, and can land a day off when that zone's date differs from the one saved).
- SA and MCP tools: `lib/agent/authoring/reference.ts`, the paragraph on captured clocks gains the same fact for a datetime property copied by an operation. Prose only; no schema change.
- Domain, doc and mutations, validator, Preview, builder: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Authored case-operation emission" (its first paragraph) and "Ordinary datetime case writes" (operation writes use the same calculate on an untyped leaf; the table above).

**Stored shape and migration.** None.

**Register.** 5 entries, `d13-datetime-leaves-*`: manifest 1 (`savetocase-leaf-type`) and proof 4 4 (the bind `@type` in the saved form and its source, the case block's update, the submission text). Control: `case-operation-sequence`.

**Spelling rule.** None.

**Identity.** None: values written from now on, not ids. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-sequence`, which also serves defect 14.

**Nova tests.**
- Native proof (`CaseOperationRuntimeTest`, the case family, local archive and HQ's regenerated form): one form with five writes to datetime properties (a datetime question, `now()`, a stored datetime string with an offset, a blank, a date-only string) asserts the submitted text of each in two device zones, and that the question and `now()` rows equal what the typed leaf submitted before.
- Pure, over the emitted DOM: no bind under `.../case/update/*` or `.../case/create/*` carries `type`.

**Lane.** Locally: `workforce-case-operation-sequence` and `case-operation-retype` through proofs 3 and 4. CI's full lane shows the same submission text and case blocks before and after both Vellum saves, and the 5 fixed entries held.

## The root create id (defect 13)

**Today.** A create keyed by a form answer (`target: { kind: "new", idFrom }`, `lib/domain/forms.ts::newCaseTargetSchema`) is emitted, at the form root, as a live `<bind nodeset=".../case/@case_id" calculate="...">` (`caseOps.ts::authoredCaseIdCalculation`). Vellum writes a create outside a repeat with its id as an `xforms-ready` setvalue (`saveToCase.js`, `getSetValues`), so a save turns the live calculate into a load-time value, evaluated before the worker answers: the id is blank, and Core and HQ refuse the submission.

**Fix.** A create keyed by a form answer is offered only inside a repeat, where Vellum writes the id as a bind.

- Validator: a create with `target.idFrom` set and no `forEach` is refused, code `CASE_OPERATION_ROOT_AUTHORED_KEY`, class soundness. A link never holds a keyed target: the validator already refuses every link whose target is kind `new` (`CASE_OPERATION_LINK_INVALID`), so the rule has one site. Message: "This form creates one <type> case each time it's submitted, so its case ID can't follow an answer here. Nova can generate the ID, or the case can be created once per row of a repeating section, where its ID can follow an answer in that row."
- Emitter: a root create always writes the `xforms-ready` setvalue. `caseOps.ts` throws if a root create reaches it with `idFrom` (the validator guarantees it cannot).
- No spelling inside HQ's envelope keeps the feature at the root: Vellum has no root spelling of a live create id, and a one-row counted repeat around the block was rejected because Core adds a counted repeat's rows only as form entry walks to it, so a submission that never walks there would create nothing.

**Files.**
- Validator: `lib/commcare/validator/rules/caseOperations.ts`, `validator/errors.ts`, `validator/gate.ts`. The new rule runs before the `formFieldCorrelatesWithCreate` test, and the message of `CASE_OPERATION_REPEAT_CORRELATION` ("must be singular with a singular create, or come from the exact repeat the create runs over") loses its singular arm, which the new rule makes unreachable.
- Doc and mutations: `lib/doc/userFacingErrors.ts`.
- Emitters: `lib/commcare/xform/caseOps.ts`.
- Builder: `components/builder/case-operations/CaseOperationInspectorBody.tsx` shows the key picker only when the create has `forEach`; removing `forEach` from a keyed create clears `idFrom` in the same mutation batch.
- SA and MCP tools: `lib/agent/tools/case-operations/shared.ts` (`newTargetInputSchema`'s `idFrom` description, today "Optional field UUID whose answer deterministically keys the case", says it applies only to a create that runs over a repeat; the create input's `superRefine` refuses `target.idFrom` without `forEach` with the same message); `lib/agent/authoring/reference.ts` gains one sentence in its repeat paragraph, where an operation running over a repeat is described; `lib/agent/authoring/operationSemantics.ts`: none, its `"authored-key"` value stands. The description changes a tool schema, so ask the person before running `npm run test:schema`. Sweep `../nova-plugin` for the claim.
- Preview, case store: none; `lib/preview/engine/caseDataBindingHelpers.ts` and `lib/case-store/postgres/submissionEnvelope.ts` execute what the document holds.
- Docs: `content/docs/case-changes.mdx` ("Identity: a distinct case, or a keyed one"). `content/docs/mcp/tools.mdx`: none, it does not describe `idFrom`.
- Cutover: `scripts/lib/hqRoundTripCutover/steps/rootCreateId.ts`, registered in `transform.ts` as `root-create-id`; `lib/notices/migrationNotice.ts` (`DOCUMENT_NOTICE_REASONS` gains `root-create-id-generated` and `case-lookup-by-key-stops`); `lib/notices/migrationNoticeCopy.ts` (their renderers, the two lines under **Stored shape and migration**).
- Surface: `lib/commcare/surface/entries/questions.json`, the emission cell of `live-create-case-id`.
- Corpus: `lib/commcare/__tests__/caseOperationFixture.ts`, the source of the `case-operation-key` document. Its `key` scenario, today a root create keyed by the root question `key`, becomes a keyed create over a user-controlled repeat `items` that holds `answer` and `key`, the shape the `repeat` scenario already builds, so it differs from `key-query` by the repeat's mode alone. It keeps its session link to the patient and its text guard.
- Proof harness: `proof/native/core/CaseOperationRuntimeTest.java::exactAuthoredKeysAndBounds` runs the rewritten `key` scenario by adding one row, answers `/data/items[1]/answer` and `/data/items[1]/key`, and keeps every exact-key and bound assertion against that row's block `@case_id`. `repeatedAuthoredKeysDeliberatelyMerge` is unchanged.
- Tests: `lib/commcare/__tests__/caseOperationEmission.test.ts`, the expectations it holds for the `key` scenario follow the fixture, and it gains the refusal case (the `sequence` fixture's root create given `idFrom`).
- CLAUDE.md: `lib/domain/CLAUDE.md` (the `Form.caseOperations` paragraph); `lib/commcare/CLAUDE.md` ("An `idFrom` answer..." and "A live calculate bind is used even when singular").

**Stored shape and migration.** No schema change. The cutover's transform gains the step `root-create-id` (`scripts/lib/hqRoundTripCutover/steps/rootCreateId.ts`, at the position part 10, The transform steps, in order, gives it): each root create with `idFrom` becomes `target: { kind: "new" }`. The step touches no link target, and part 10's row for the step says the same. Decided here: a link whose target is kind `new` cannot be stored, because the gate refuses every such link (`CASE_OPERATION_LINK_INVALID`) and every stored app passed that gate at its last deploy's probe, so no stored link holds a keyed target and the step has nothing to strip there. The advisory scan counts every such create before the window, per app, with the count of that app's operations that target the same case type by expression; the creates and those operations themselves, by form, id and name, are the report's detail, printed for one app under `--debug-details` (part 10, Scripts and their layout, under "The report"). The notice lines carry document reasons `root-create-id-generated` (entity the form, detail the operation, case type and key field) for the first line and `case-lookup-by-key-stops` (entity the form, detail the operation) for the second; this pull request adds both to `DOCUMENT_NOTICE_REASONS` with their renderers, and these two lines are their copy:

- `root-create-id-generated`: "<Form>: <operation> now gives each new <type> case its own ID. Before, two submissions with the same <question> answer updated one case. Cases already created keep their IDs."
- `case-lookup-by-key-stops`, for each listed expression-targeted operation: "<Form>: <operation> looks a case up by an ID that <other form> no longer builds from <question>. It will not find cases created from now on."

What it does to existing apps: two submissions with one key make two cases, where they made one; an update that finds its case by that key keeps working for cases created before the cutover and finds none created after. The notice is the only repair Nova can offer; the remedy in the app is a search or a case list selection in place of the computed id.

This is the research's decision for defect 13 and needs no further confirmation. It removes an affordance and changes case data for existing apps, and it is decided because no spelling inside HQ's envelope keeps a live create id at the root. The advisory scan prints the count of root keyed creates per app, and under `--debug-details` names each with the expression-targeted operations beside it, and the migration runs. It is not a stop for a person.

**Register.** 14 entries, `d13-root-create-id-*`: manifest 1 (`live-create-case-id`) and proof 4 13 (the bind and the `xforms-ready` setvalue at `.../case/@case_id` in the saved form and its source, the removed block and its `IllegalCaseId` refusal, five `InvalidStructureException` paths). Control: `case-operation-key`.

**Spelling rule.** None.

**Identity.** The case id of cases a migrated create makes from the next publish. No id HQ already holds changes. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-key` keeps showing the blank id and the refusal.

**Nova tests.**
- Pure: the validator refuses a root create with `idFrom` with `CASE_OPERATION_ROOT_AUTHORED_KEY` and admits the same create under `forEach`.
- Pure, state model: removing `forEach` from a keyed create commits one batch that also clears `idFrom`, and the commit gate accepts it.
- Pure, over the emitted DOM: a root create's id is always the `xforms-ready` setvalue; a keyed create in a repeat keeps its bind.
- Pure, over the frozen pre-step fixtures: the `root-create-id` step's output (no root create holds `idFrom`, and every link target is as it was), one `root-create-id-generated` line per migrated create and one `case-lookup-by-key-stops` line per expression-targeted operation over that case type, and that the output passes the commit gate.
- Real Postgres (the cutover's `*.postgres.test.ts`): an app holding a root keyed create and an expression-targeted operation over its case type comes out with the fold baseline, a notice row holding both reasons and no `idFrom`.
- Native proof (`CaseOperationRuntimeTest::exactAuthoredKeysAndBounds`, local archive and HQ's regenerated form): each exact key yields the prefixed id on the row's block and the right case, and a blank or over-long key refuses the submission, on the rewritten `key` scenario.

**Lane.** Locally: `case-operation-key` (rewritten) through the bar and proofs 3 and 4. CI's full lane shows no `@case_id` difference after either Vellum save, the 14 fixed entries held on the control, and the 14 guard-block entries once documented on `case-operation-key` held on the document `reconcile` reports for them.

## Default values read relatively (defect 13)

**Today.** `builder.ts::buildFieldParts` writes a default as `<setvalue value="/data/...">` with `vellum:value="#form/..."`. Vellum refuses any `#form/` hashtag in a default: "You are referencing a node in this form. This can cause errors in the form" (`mugs/baseSpecs.js`, `defaultValue.validationFunc`, unless the deprecated `VELLUM_DATA_IN_SETVALUE` flag is on). Dropping the shadow alone does not help: Vellum turns an absolute `/data/a` into `#form/a` on load (`parser.js::parseSetValue`, executed during planning).

**Fix.** Every form read in a default is printed relative to the question it sets, as `current()/<relative steps>`, with no `vellum:value`.

- `current()/...` and not a bare `../a`: a default is an authored expression and a read can sit inside a predicate, where a bare relative step would start at the predicate's candidate. `current()` is right in every position and is already the house spelling for correlated reads (`caseOps.ts::originalContextPath`).
- Core evaluates a setvalue in its target's context, and `current()` there is the target (commcare-core `SetValueAction.processAction`), so the relative and absolute spellings name the same node, including inside a repeat row.
- Vellum leaves `current()/..` paths alone and does not track them (executed during planning). Stated in `lib/commcare/CLAUDE.md` and the public docs: renaming the question in HQ's form builder leaves such a read as it was.
- Vellum chooses a default's event itself (`jr-insert` in a repeat, `xforms-ready` outside), which is what Nova already writes.

**Files.**
- Emitters: `lib/commcare/xform/formPath.ts` (`relativeXPath` and `originalContextPath` move here from `caseOps.ts`, one implementation for both files); `lib/commcare/hashtags/formContext.ts` (new `expandHashtagsForDefaultValue(expr, ctx, target)`, the walk of `expandHashtagsInContext` with `#form/` resolving to `current()/` plus the relative steps); `lib/commcare/xform/builder.ts::buildFieldParts`; `lib/commcare/xform/caseOps.ts` (imports).
- Docs: `content/docs/building-with-nova.mdx`, one sentence where default values are described.
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools: none. Preview evaluates the AST.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Hashtag form-context".

**Stored shape and migration.** None.

**Register.** 2 entries: `d13-form-defaults-vellum-mug-defaultvalue-error-referencing-node-form` and `d13-form-defaults-vellum-again-mug-defaultvalue-error-referencing-node-form`, proof 4. Control: `targeted-load-time-values`, which also serves defect 28's three live entries on unchanged paths.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-load-time-values`.

**Nova tests.**
- Pure, over the emitted DOM: a root default, a default in a repeat reading a sibling in the row, one reading an enclosing repeat's answer, and one reading an answer outside the repeat each print the expected `current()/...` path and carry no `vellum:value`.
- Native proof (`ExpanderRuntimeTest`, local archive and HQ's regenerated form): the form's submission is the same with the absolute and the `current()` spelling in each of the four places.

**Lane.** Locally: `targeted-load-time-values` and `expander-form-hashtag-expansion-expands-form-in-default-8a732e08-0` through proof 4. CI's full lane shows no `mug-defaultValue-error` on any document and the 2 fixed entries held.

## The registration case-id read and `nova_caseid` (defect 13)

**Today.** On a registration form `formContext.ts::expandHashtagsInContext` expands `#<own type>/case_id` to `/data/case/@case_id`, the block HQ's build adds and the stored source does not hold, and `caseOps.ts` writes the same path as the parent index of an extension child on a registration form. Vellum finds no question there and warns on every save. Separately, one Save to Case block reads another's id at `<block>/case/@case_id` (`caseOps.ts::emitTarget` for an `op` target, `bindOperationPaths`, the guards). That draws no warning today only because the blocks sit under a Hidden Value, which Vellum never re-checks; once `nova_operations` is a group, each such read in a scalar field is an unknown question.

**Fix, in two parts.**

1. **A registration form reads its own new case's id from the session**, in pull request 6:
   - the read is `instance('commcaresession')/session/data/case_id_new_<own type>_0`, the datum HQ's suite and Nova's local suite both give a registration form (`models/forms.py::Form.session_var_for_action`; `suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta`, `function="uuid()"`; `lib/commcare/session.ts`);
   - HQ itself sets `/data/case/@case_id` from that datum (`xform.py::XFormCaseBlock.add_create_block`), so the value is the same on every runtime, and it is available earlier in the load, since HQ's setvalue for the block runs after every setvalue of the form (`xform.py::XForm.add_setvalue`);
   - a resumed incomplete form reads the same id (commcare-core `SessionDescriptorUtil.createSessionDescriptor` stores a computed datum's value);
   - Vellum does not check a path that starts at `instance(...)`;
   - `FormHashtagContext` gains `ownNewCaseIdRef`, built by the caller from new `lib/commcare/session.ts::newCaseIdDatumId(caseType)`, which returns `case_id_new_<type>_0` and replaces the three inline spellings of it today (`session.ts::deriveSessionDatums`, `formContext.ts::expandHashtagsForSessionStack`, `xform/caseBlocks.ts`), so the read and the datum cannot drift. The form declares the `commcaresession` instance whenever the read is emitted. `caseOps.ts` uses the same reference for the registration branch of an extension child's parent index.
2. **A case id more than one block reads is held in `nova_caseid_<operation id>`**, in pull request 7 with the group change (it must not trail it):
   - emitted only where a reader other than the operation's own block exists: an `op` target, a link to an earlier create, a guard, or an expression binding from `bindOperationPaths`;
   - placed inside `nova_operations`, immediately before the operation's block and outside every condition group, so its value is set before anything that reads it (Vellum writes setvalues in data-tree order, `writer.js::createSetValues`, and Nova writes them in that order too);
   - its value, by case:

     | Operation | `nova_caseid_` | The operation's own `@case_id` |
     |---|---|---|
     | create at the root | `<setvalue event="xforms-ready" value="uuid()">` | `<setvalue event="xforms-ready" value="<nova_caseid path>">` |
     | create in a repeat, no key | `<setvalue event="jr-insert" value="uuid()">` | bind, `calculate` the node read through `current()` |
     | keyed create in a repeat | bind, `calculate` `authoredCaseIdCalculation(...)` | bind, `calculate` the node read through `current()` |
     | update or close | bind, `calculate` today's target expression | bind, `calculate` the node |

   - every other reader reads the node, never `<block>/case/@case_id`;
   - it is a submitted leaf, so HQ form exports gain a column per shared id; the `data-paths-move-once` line covers it, and the advisory scan's count of affected forms includes the forms that hold one.

**Files.**
- Emitters: `lib/commcare/hashtags/formContext.ts`, `lib/commcare/session.ts` (`newCaseIdDatumId`), `lib/commcare/xform/caseBlocks.ts` (its caller), `lib/commcare/xform/builder.ts::buildXForm` (which builds the `FormHashtagContext`), `lib/commcare/xform/caseOps.ts`, `lib/commcare/formActions.ts` (the comment at its registration `case_id` handling).
- Domain: none; `lib/domain/caseTypes.ts::caseRefAcceptMap` admits the same reads.
- Doc and mutations, validator, Preview, builder, SA and MCP tools, public docs: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Hashtag form-context" (the registration narrowing) and "Authored case-operation emission" (shared ids).

**Stored shape and migration.** None.

**Register.** 2 entries for part 1: `d13-form-defaults-vellum-case-case-id` and `d13-form-defaults-vellum-again-case-case-id`, proof 4 (`logic-bad-path-warning` on `/data/case/@case_id`). Control: `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0`. Part 2 moves none and prevents new ones.

**Spelling rule.** None.

**Identity.** None for part 1. Part 2 adds a leaf per shared id. `proof/identity-moves.json` gains no entry.

**Control.** `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0`.

**Nova tests.**
- Pure, over the emitted DOM: no expression in any fixture form's source reads `/data/case/@case_id` or any `.../case/@case_id`; each of the four rows of the table above emits as written; every form that emits the session read declares the `commcaresession` instance.
- Pure: `newCaseIdDatumId(type)` equals the id of the datum `deriveSessionDatums` gives a registration form of that type.
- Native proof (`CaseOperationRuntimeTest` and `ExpanderRuntimeTest`, local archive and HQ's regenerated form): a registration form's default, calculate and child index that read the own id get the id the submission's create block carries, including on a form resumed from a saved session descriptor; an update that targets an earlier create, and that create's guard, read the id the create wrote.

**Lane.** Locally: the `records-no-case-id-load` expander document, `case-extension-registration` and `case-operation-link` through proofs 3 and 4. CI's full lane shows no `logic-bad-path-warning` on any document, and no editor message naming a `nova_caseid_` path.

## Blank translations (defect 13)

**Today.** `lib/domain/translationUnits.ts::localizeTranslationUnit` takes an explicitly empty translation of a label, hint, help text, validation message or option label as current, so `builder.ts`'s `addItext` writes an empty `<value/>` for that language beside a non-blank value in another. Vellum writes every form of every text through `javaRosa/itext.js::ItextForm.getValueOrDefault` on each save, which fills the blank, so the saved form shows text the published form did not.

**Fix.** The emitter and Preview apply Vellum's own fill, so a save changes nothing. No authored content is deleted and no migration runs.

- The rule, per itext form: a blank value takes the text of `langs[0]` (the app's default language); if that is blank too, the first non-blank value in language order; if every language is blank, it stays blank. After the fill, a value is blank exactly when the form is blank in every language. The fill is symmetric: a blank default-language value beside a translated one is filled from the translation.
- It follows Vellum's rule and not "the source language's text", because Vellum's fallback knows nothing of Nova's source language, and the two differ whenever the source is not `langs[0]`.
- An item blank in every language: Vellum's save writes no such item and drops the reference to it (`javaRosa/util.js::getItextItemsFromMugs`). `addItext` already writes neither the item nor its `ref` for a hint, help text, validation message or container label. Its two forced callers in `builder.ts`, a leaf question's label and a select option's label, keep writing the empty item: every leaf control and every `<item>` carries a `jr:itext` label reference, and Core refuses a form whose reference has no text entry (commcare-core `XFormParser.verifyTextMappings`). A save in HQ's form builder therefore still drops a label that is blank in every language. No corpus document holds one, the register holds no entry for it, and this fix neither adds nor removes that difference.
- Blank means a prose template with no parts (`lib/domain/prose.ts::proseTemplateIsEmpty`). A text part cannot be empty and a whitespace-only run is a real value (`builder.ts::literalLabelNodes` writes it as an output), so no trimming applies.
- New pure function `lib/domain/translationFill.ts::filledProse(doc, unit, language)`: the unit's `effective` value per language from `localizeTranslationUnit`, then the rule above over `effectiveAppLocalization(doc.localization).languageOrder`. It applies to the itext roles (`field-label`, `field-hint`, `field-help`, `field-validation-message`, `select-option-label`).
- The emitter reads it through `lib/commcare/localization.ts::commCareLocalization` (`prose`), so `addItext` and `protectConstraintMessage` both get filled templates. 
- **Where the fill is applied.** `lib/domain/localizedBlueprintProjection.ts::projectLocalizedField` and `projectLocalizedFields` take an option `{ filled: true }`. With it, each itext slot reads `filledProse`, and the early return for the source language is skipped, because a blank source value beside a translation is filled too. Only what a worker sees passes it: `lib/preview/engine/engineInput.ts`, `lib/preview/hooks/useVisibleFieldOrder.ts`, and new `lib/doc/hooks/useLocalization.ts::useFilledField(language, uuid)`. `lib/doc/hooks/useEntity.ts::useField` and `useLocalization.ts::useLocalizedField` are unchanged and keep returning the stored value, so every editor edits what is stored.
- **Preview rows.** `components/preview/form/virtual/rows/FieldRow.tsx`, `GroupBracket.tsx` and `SectionHeaderRow.tsx` render the text of `useFilledField` and keep passing the stored value of `useLocalizedField` to `TextEditable` as its `value`. A worker's view in Preview matches a device, and opening the inline editor on a filled text shows the empty stored value.
- **Status.** `lib/domain/translationUnits.ts::localizeTranslationUnit` returns `status: "missing"` for a current explicit entry of an itext role whose value is blank while the unit's source or another language's current entry is not. It keeps `explicit`, keeps `effective` as the stored blank, and sets a new optional field `filledFrom: LanguageTag` on `LocalizedTranslationUnit`, the language `lib/domain/translationFill.ts::translationFillSource(doc, unit, language)` returns. No new status is added. An entry blank in every language keeps the status it has today. Everything that reads `status` follows with no rule of its own: `collectTranslationCoverageDiagnostics` and the counts in `components/builder/app-setup/LanguagesSection.tsx` count it Missing, and `lib/agent/translation/translateLanguage.ts` translates it, which is right because workers already read another language's text there.
- **The Languages workspace** (`LanguagesSection.tsx`) is the one builder surface that shows a unit's status. For such a unit it shows the Missing badge, an empty input whose placeholder is the filled text, and the line "Workers see the <language name> text here until this is translated." "Mark as reviewed" is not offered for it (its condition gains `unit.status !== "missing"`). The canvas under a language lens shows the stored blank as it does today.
- **Tools.** Each unit row `lib/agent/tools/localization.ts` returns carries `status` as above and, when set, `filledFrom`; the row's fingerprint includes it. No input schema changes.

**Files.**
- Domain: new `lib/domain/translationFill.ts`; `lib/domain/translationUnits.ts` (`localizeTranslationUnit`, `LocalizedTranslationUnit.filledFrom`); `lib/domain/localizedBlueprintProjection.ts` (the `filled` option).
- Emitters: `lib/commcare/localization.ts`; `lib/commcare/xform/builder.ts` (`addItext` takes the filled templates; its inline blank test becomes `proseTemplateIsEmpty`).
- Preview: `lib/preview/engine/engineInput.ts`, `lib/preview/hooks/useVisibleFieldOrder.ts`; `components/preview/form/virtual/rows/FieldRow.tsx`, `GroupBracket.tsx`, `SectionHeaderRow.tsx`.
- Builder: `lib/doc/hooks/useLocalization.ts` (`useFilledField`); `components/builder/app-setup/LanguagesSection.tsx`.
- SA and MCP tools: `lib/agent/tools/localization.ts` (`filledFrom` on a unit row); `lib/agent/translation/translateLanguage.ts`: none, it follows `status`. No input schema change, so `npm run test:schema` is not needed.
- Docs: `content/docs/languages.mdx`, one sentence (an empty translation shows the default language's text).
- Doc and mutations, validator: none.
- CLAUDE.md: `lib/domain/CLAUDE.md` and `docs/architecture/multilingual-localization.md` (the fill, and that it is Vellum's rule); `lib/commcare/CLAUDE.md`, "Multilingual emission is one derived projection".

**Stored shape and migration.** None. No transform step, no notice.

**Register.** 5 entries, `d13-blank-translations-*`: manifest 1 (`blank-beside-default-text`) and proof 4 4 (`value/text()` and `value[@form=markdown]/text()` in the saved form and its source). Control: `localization-optional`. The document keeps its blank translations, so `d41-empty-list-text-app-no-items-text`, which also names it, is untouched.

**Spelling rule.** None; `itext_value_order` still erases Vellum's order.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `localization-optional` keeps showing a blank value beside text.

**Nova tests.**
- Pure: `filledProse` for a blank target beside a default-language text, a blank default beside a translation, a source language that is not the default, a stale entry, and all blank.
- Pure, over the emitted DOM: no `<text>` has a blank `<value>` beside a non-blank one in another language, for the default and the markdown form; a hint blank in every language emits no item and no `ref`; a leaf label and an option label blank in every language emit their empty item.
- Pure, state model: `projectLocalizedFields` with `filled: true` gives the filled text, in the source language too, and without it gives the stored blank; `localizeTranslationUnit` gives `missing` with `filledFrom` for a blank entry beside text and today's status for one blank in every language.
- Pure, state model: the coverage counts of `collectTranslationCoverageDiagnostics` count such an entry as missing, and `translateLanguage`'s selection includes it.
- Playwright (`e2e/`): the Languages workspace shows the Missing badge and the placeholder for a cleared translation, and Preview in that language shows the default language's text.

**Lane.** Locally: `localization-optional` and `localization-stale` through the manifest check and proof 4. CI's full lane shows no itext value difference after either Vellum save and the 5 fixed entries held.

## The ref-less repeat group (defect 13)

**Today.** `builder.ts::buildRepeatBody` wraps a repeat as `<group ref="<path>"><repeat nodeset="<path>">`. Vellum's `Repeat` writes no `ref` on that group (`mugs/types/group.js`, `writeControlRefAttr: null`), and its parser never reads Nova's, so it comes back as a raw control attribute: kept by a save, and never what the editor writes. The register holds no entry for it.

**Fix.** The wrapper is `<group>` with no `ref`. Core reads the same event sequence either way: a group holding one repeat collapses into it.

**Files.**
- Emitters: `lib/commcare/xform/builder.ts::buildRepeatBody` and its comment; goldens under `lib/commcare/__tests__`.
- Everything else: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Repeat modes" (the wrapper's spelling).

**Stored shape and migration.** None.

**Register.** No entry of defect 13. Two step 5 defects read the same control and are settled from this pull request's run:
- Defect 27 (`targeted-labelled-group-repeat`, 3 entries): expected to stand, because Vellum already takes such a group's path from its repeat (`parser.js`, the `group` control adaptor), so dropping `ref` changes no parse. Each entry is read from this pull request's run under the re-homing rule of part 09, The 159 entries that remain. If "Repeat Count is required." shows on no corpus document, its two proof 4 entries move to the fixed register on `targeted-labelled-group-repeat`. The manifest entry `d27-labelled-group-repeat-form-xform-repeat-user-repeat-in-a-field-list` stays live either way: `proof/checks/manifest_value_classes.py::user_repeat_in_field_list` judges the repeat's place in a Question List, which this fix does not touch, and Android's refusal to add rows there is unchanged.
- Defect 25's two entries (document `container-query-conditional-relative`): the same rule, as stated under "Shadows".

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None of its own; `targeted-labelled-group-repeat` for defect 27.

**Nova tests.** Pure, over the emitted DOM: the repeat wrapper carries no `ref`. Native proof: `ContainerRuntimeTest` keeps passing over all three repeat modes on both paths.

**Lane.** Locally: `targeted-labelled-group-repeat` and `container-nested-query` through proofs 3 and 4. CI's full lane shows no new difference on any repeat document.

## Finding 55: the Connect work area id

**Today.** `builder.ts::buildConnectBlocks` writes a deliver unit's `<deliver>` with `name`, `entity_id` and `entity_name`. Vellum's deliver unit lists `work_area_id` after `entity_name` and writes every child with a bind (`commcareConnect.js`, `mugConfigs.ConnectDeliverUnit.childNodes`, `getBindList`), so a save adds the element and a bare bind. Connect reads it by truth test and takes an empty one as absent (commcare-connect `form_receiver/processor.py::process_deliver_unit`), so the two spellings behave alike.

**Fix.** Emit `<work_area_id/>` after `entity_name`, and `<bind nodeset=".../deliver/work_area_id"/>` with the node set alone, as Vellum writes it. Nova emits no `ConnectWorkAreaUpdate` block; that stays out.

**Files.**
- Emitters: `lib/commcare/xform/builder.ts::buildConnectBlocks`; `lib/commcare/__tests__/connectWireFixtures.ts`.
- Everything else: none.
- CLAUDE.md: none.

**Stored shape and migration.** None.

**Register.** 3 entries, each marked `equivalence`: `d55-connect-work-area-form`, `-source`, `-trace`, proof 4. Control: `expander-expanddoc-hq-json-projection-sort-elements-85a51a04-0`.

**Spelling rule.** None; `empty_binds` stays (it serves every group).

**Identity.** None; a deliver unit's submission gains an empty element. `proof/identity-moves.json` gains no entry.

**Control.** The control above keeps showing the two spellings differ.

**Nova tests.** Pure, over the emitted DOM: the deliver block's child order and the bare bind. Native proof: `ConnectRuntimeTest` and `proof/native/test_connect_emission.py` still read the unit.

**Lane.** Locally: `connect-deliver-default` through proof 4. CI's full lane shows no `work_area_id` difference and the 3 fixed entries held.

## Finding 46 and defect 14's data node name

**Today.** `builder.ts::buildXForm` writes `<h:title>` as `form.name`, the source-language text, and the data node's `name` as a slug of it (`xform/dataRootAttributes.ts::xformDataRootRuntimeAttributes`). Vellum takes HQ's name for the form in the editing language over both and writes it into both on save (`views/formdesigner.py::_get_vellum_core_context`, `'formName': translate(form.name, lang, app.langs)`; `parser.js::parseDataTree`; `writer.js::createXForm`, `createModelHeader`). So a save renames the form's title where the source language is not the default, and replaces the slug on every form.

**Fix.** `<h:title>` and the data node's `name` both carry the form's name in the app's default language, character for character the string Nova writes at `form.name[langs[0]]`. A save in HQ's default editing language then changes neither.

- New `lib/domain/formWireName.ts::formWireName(doc, formUuid)`: the form-name unit localized into `effectiveAppLocalization(doc.localization).defaultLanguage`. One function for the emitter and Preview. HQ JSON's `form.name` is written by `lib/commcare/expander.ts` through `commCareLocalization.textMap`, a different path, and a test holds the two equal.
- `xformDataRootRuntimeAttributes(name)` returns the name as given, with no slug.
- Stated once in `lib/commcare/CLAUDE.md` so nobody reopens it: no spelling survives a save made in another editing language. A person who switched HQ's editing language (`views/utils.py::get_langs` reads the `lang` cookie) gets that language's name written into both, as HQ does to a form made in HQ.
- Android falls back to the form's title for its header (commcare-android `FormEntryActivity.getHeaderString`), which is now the default-language name.

**Files.**
- Domain: new `lib/domain/formWireName.ts`.
- Emitters: `lib/commcare/xform/dataRootAttributes.ts`, `lib/commcare/xform/builder.ts::buildXForm`.
- Preview: `lib/preview/engine/formEngine.ts`, every call of `xformDataRootRuntimeAttributes` passes `formWireName(doc, formUuid)`, so `/data/@name` in Preview matches a device.
- Docs: `content/docs/publishing.mdx`, one sentence: each submission's form name in HQ is the form's name.
- Doc and mutations, validator, builder, SA and MCP tools: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Secondary instances" ("slugged `name`"); `lib/preview/CLAUDE.md` where it repeats it.

**Stored shape and migration.** None. No per-app notice: nothing in a document changes and the change is the same for every app. From each app's next publish every submission's `@name`, which HQ shows as the form's name, is the form's name where it was a slug; the public docs say so.

**Register.** 6 entries.
- Finding 46, 3: `d46-form-renamed-form-title`, `-source-title`, `-trace-title`, proof 4. Control: `localization-bilingual`.
- Defect 14, data node name, 3: `d14-data-node-name-form-instance-name`, `-source-instance-name`, `-trace-name`, proof 4. Control: `case-operation-query`.

**Spelling rule.** None.

**Identity.** The `name` attribute of every submission, once, from the next publish. `xmlns` is untouched. `proof/identity-moves.json` gains no entry.

**Control.** `localization-bilingual` and `case-operation-query`.

**Nova tests.**
- Pure, over the emitted DOM: with a source language that is not the default, the title and `name` are the default language's name; a name holding `&`, `<`, a quote and a non-breaking space passes the serializer and the XForm oracle.
- Pure, state model: the form engine's `/data/@name` reads the same string.
- Pure: for every emission fixture, `formWireName(doc, formUuid)` equals the expanded app's `form.name[langs[0]]`, including where the default-language name is missing and falls back to the source text.

**Lane.** Locally: `localization-stale` and `case-operation-query` through proof 4. CI's full lane shows no title or `name` difference after either Vellum save and the 6 fixed entries held.

## Finding 33: `nova_trimmed` and the source-question guard

**Today.** The local archive binds a basic action's case name and external id through a trim (`caseBlocks.ts::buildCaseBlocks` with `caseOps.ts::caseScalarTextValueCalculation`), while HQ's build of the same actions binds the raw question path (`xform.py::XFormCaseBlock.add_create_block`, `add_case_updates`). So HQ stores `"  proof  "` from a published app where a locally installed one stores `"proof"`, and HQ and Core judge the 255 limit on different strings. The guard beside the trim never ran (see "Leaf constraints"), so a whitespace-only name becomes a case with a blank name on both paths.

**Fix.** The trim lives in a node of the form source that the action names, and the guard on the question the worker answers.

- **The trim.** Every field in `caseScalarTextGuards(doc, formUuid)` (below) gets one sibling Hidden Value, `nova_trimmed_<question id>` (node table, row 5), however many writes read it: each question a basic action reads as a case name or an external id, and each question a source-lowered block (`nova_update_selected_cases`, `nova_subcase_<n>`) reads as one. Keeping the `replace()` trim on the source-lowered leaves was rejected: one rule for both writers means one question has one trim, and a multi-select form or a form whose only writer is a source-lowered subcase gets the node too. Its `relevant` is required: HQ writes the update bind's own relevance as `count(<action path>) > 0` over this node, and Core drops a non-relevant node from a node set, so a hidden answer still leaves the case's stored value alone.
- **The actions name it.** In `formActions.ts::buildFormActions`: `open_case.name_update.question_path`; the primary update map's `case_name` and `external_id`; each subcase's `name_update.question_path` and its `external_id` property. `external_id` itself moves to `update_case.update.external_id` and `open_case.external_id` is `null` (defect 14's equivalent spellings, same pull request). `case_preload` keeps naming the question.
- **HQ's editors produce and keep this.** The Case Management tab offers Hidden Values as the source of a name and of any property (`static/app_manager/js/case_config_utils.js::getQuestions`), and HQ's build validates action paths against a list that includes every data node without a control (`xform.py::XForm.get_questions`; `helpers/validators.py::check_paths`). The datetime and capture-link siblings already depend on both.
- **The local archive binds as HQ's build does.** `caseBlocks.ts` binds the four leaves to the action's path with no trim of its own. `nova_update_selected_cases` and `nova_subcase_<n>` in `caseOps.ts` read the question's `nova_trimmed_` node, which the rule above guarantees exists, and drop their own `replace()` wrapper. `caseScalarTextValueCalculation` stays for authored operations, whose values are expressions.
- **`required`.** HQ's build stamps `required="true()"` on the path a create's name action names, which is now the Hidden Value, where it is inert; the local archive mirrors that stamp so the two paths agree. What keeps a name required of the worker is the source: for every create-name question that is not a Hidden Value, `builder.ts` writes `required="true()"` as the `required` attribute of the question's own bind. It replaces an authored required condition there, which is what HQ's build did to that bind before (`xform.py::XForm.add_bind` merges onto the existing bind). No second bind is written: the `requiredNamePaths` loop in `builder.ts`, which today sets the attribute for source-lowered names and appends a separate bind where it finds none, covers basic-action create names too; where the question has no bind yet, the bind it appends is that question's one bind.
- **The guard.** A visible source question's constraint gains the check, conjoined as `(<authored validation>) and (<guard>)`, or alone where the author wrote none: for a case name, `string-length(replace(., <pattern>, '')) > 0 and string-length(replace(., <pattern>, '')) <= 255`; for an external id, the length half alone. Core does not evaluate a constraint on an empty answer, so the non-blank half catches a whitespace-only answer and `required` catches an empty one.
- **No message of its own.** Where the author wrote a validation message it shows for either failure; where there is none the runtime shows its own localized invalid-answer text. Nova has no source for a message in every app language, and inventing one would be content the author did not write.
- **A Hidden Value source takes no constraint**: Vellum marks one "not allowed" and Core never checks it. For it an over-long value stays an atomic refusal when the form is processed, by Core and by HQ (`corehq/form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy._validate_length`), the same on both paths as today.
- **The set of guarded questions** is one derived fact: new `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards(doc, formUuid)`, a map from field uuid to `"reject"` (case name) or `"allow"` (external id), over `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`'s primary, child-create, update and source-lowered writers. The emitter and Preview's form engine both read it, so Preview refuses the answer at the question as a device does.
- Dropping the trim from the local archive instead was rejected: HQ would hold padded text on both paths while a device holds trimmed text, and `lib/domain/caseScalarText.ts`'s contract (one value for Core, HQ, Preview and Postgres) would be false for every published app.

**Files.**
- Domain: new `lib/domain/caseScalarTextGuard.ts`.
- Emitters: `lib/commcare/xform/generatedNodes.ts` (`trimmed`), `lib/commcare/xform/builder.ts::buildFieldParts`, `lib/commcare/formActions.ts::buildFormActions` (a branch in `projectPrimaryUpdateMap`'s path resolver beside the datetime and capture branches), `lib/commcare/xform/caseBlocks.ts::buildCaseBlocks`, `lib/commcare/xform/caseOps.ts`.
- Preview: `lib/preview/engine/formEngine.ts` validates an answer against the conjoined expression, reading `caseScalarTextGuards`.
- Cutover: `scripts/lib/hqRoundTripCutover/behavior.ts` (the selection function for `case-name-now-checked`), `lib/notices/migrationNotice.ts` (`DOCUMENT_NOTICE_REASONS` gains it), `lib/notices/migrationNoticeCopy.ts` (its renderer, with part 10's copy).
- Proof harness: `proof/checks/compare/names.py` already reads `nova_trimmed_` from the rename pull request.
- Surface: `lib/commcare/surface/entries/forms-and-case-writes.json`, the emission cells for name and external id writes.
- Docs: `content/docs/building-with-nova.mdx`, a clause where the record name is described (a blank or over-long name is refused at the question).
- Doc and mutations, validator, builder, SA and MCP tools: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-management scaffolding emission": the case-create and case-update bullets and the sibling nodes); `lib/domain/CLAUDE.md` (the `caseScalarText.ts` sentence says where the trim and the guard live); `lib/preview/CLAUDE.md` (its trim-boundary paragraph).

**Stored shape and migration.** No document change and no step: the model does not change. `behavior.ts` returns one `case-name-now-checked` record per form with a basic create or rename whose case name comes from a visible question, the question a worker answers, entity the form with the question in `detail`; its copy is part 10's (part 10, Work item F: the migration notice). A form whose name comes from a Hidden Value gets no record, because that source takes no guard. The new leaf is covered by the `data-paths-move-once` line, which pull request 7 already writes for every deployment. Visible effects, stated in the public docs: each such form gains one Hidden Value per name or external id question, shown in HQ's form builder, as the name's source in Case Management, in submissions and as a form-export column; names and external ids HQ stores from the next build are trimmed; a worker sees an invalid-answer message on a whitespace-only or over-long name where none showed before.

**Register.** 16 entries, `d33-trimmed-*`, all proof 3: `case_blocks@local.ccz` (10: create `case_name` at six block paths (`*~1case`, `*~1item~1case`, `*~1item~1subcase_*~1case`, `*~1subcase_*~1case`, `case`, `subcase_*~1case`), update `case_name`, update `external_id`, the stored `cases/*/name` and `cases/*/external_id`) and `trace@local.ccz` (6, the matching submission texts). Controls: `case-extension-registration` (5), `navigation-base` (3), `case-capture-followup` (2), `case-capture-query` (2), `case-capture-repeat` (2), `case-extension-query` (1), `case-extension-repeat` (1). Defects 23 and 24 are read from this pull request's run on the `-after-13` controls: the new `nova_trimmed_` sibling and the changed binds can move their paths. Where a path moved, the entry is re-pathed from the run and that control retained again in place, which is allowed because no fixed entry names it.

**Spelling rule.** None.

**Identity.** None moves; a leaf appears. `proof/identity-moves.json` gains no entry.

**Control.** The seven controls keep showing trimmed against raw on their pre-fix archives.

**Nova tests.**
- Pure, over the emitted DOM and the HQ JSON: each action slot names the Hidden Value; the leaf binds read the action's path and carry no trim; the Hidden Value's bind carries the calculate and the `count(...) > 0` relevance; a name collision takes the suffix; a visible name question carries `required` and the conjoined constraint, and a Hidden Value source carries neither; a name question with an authored required condition carries `required="true()"` on its one bind; a multi-select form and a form whose only name writer is a source-lowered subcase each emit the `nova_trimmed_` node their block reads.
- Pure: `caseScalarTextGuards` over a form with a create name, a rename, an external id, a child name in a repeat and a Hidden Value source.
- Native proof (`CaseOperationRuntimeTest`, the case family, local archive and HQ's regenerated form): a padded name stores trimmed; a hidden name question leaves the case's name untouched; a whitespace-only name and a 256-character name are refused at the question by Core's controller.
- Pure, state model (`lib/preview/engine`): the same two answers are refused at the question, and the accepted padded answer stores the trimmed name.
- Pure, over the frozen pre-step fixture that witnesses `case-name-now-checked`: the `behavior.ts` selection function returns one record for a form whose create or rename reads a visible question, with the form as entity and the question in `detail`, and none for a form whose name source is a Hidden Value or that writes no case name.

**Lane.** Locally: `case-capture-repeat`, `case-extension-registration` and `case-operation-relevance` through proofs 3 and 4. CI's full lane shows the same case blocks and stored cases from HQ's build and the local archive on every document, the Hidden Value kept by a Case Management save and both Vellum saves, and the 16 fixed entries held.

## Finding 37: case block order on the local path

**Today.** `caseBlocks.ts::buildCaseBlocks` pushes the form's own `<case>` before its subcases, so the local data node reads fields, `case`, `subcase_0..n`, `commcare_usercase`, `meta`. HQ's build appends each non-repeat subcase inside its loop and the form's own block after it (`xform.py::XForm._create_casexml`), giving fields, `subcase_0..n`, `case`, `commcare_usercase`, `meta`. Core applies blocks in document order and gives new records storage ids in that order (commcare-core `XmlFormRecordProcessor.process`, `CaseXmlParser.parse`), so new cases reach a device's storage in opposite orders on the two paths.

**Fix.** The local archive takes HQ's order, because HQ's is the one Nova cannot change.

- `buildCaseBlocks` pushes the form's own `<case>` after the subcase loop and before the usercase block. Its binds stay where they are.
- **The repeat item position.** HQ inserts a single repeat subcase's block as the first child of the repeat item (`subcase_node.insert(0, subcase_block.elem)`); with several, each `subcase_<n>` wrapper is appended. `CaseBlockChild` gains `position: "first" | "last"`: a repeat subcase that is not nested in a wrapper takes `"first"`, everything else `"last"`, and `addCaseBlocks` prepends the first kind with `xform/domSplice.ts::prependChildren`. This also covers a repeat item that holds Save to Case blocks, where HQ's block stands before them.
- A child block met before its parent's create is sound: commcare-core `CaseXmlParser.indexCase` records the index without loading the parent, and every HQ-built app already submits in that order. HQ's stored cases do not depend on position (`corehq/ex-submodules/casexml/apps/case/xform.py::get_case_updates` sorts by case id).

**Files.**
- Emitters: `lib/commcare/xform/caseBlocks.ts`.
- Everything else: none. `lib/doc/caseOperationOrder.ts` treats the primary write and the subcase parent index as final implicit consumers and does not order them against each other.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Case-management scaffolding emission" and "Repeat-context subcase splice + nest decision" (the data-node order and the item position, citing `_create_casexml`).

**Stored shape and migration.** None.

**Register.** 2 entries: `d37-case-order-trace-order-d1aa` and `d37-case-order-trace-order-cb3c`, proof 3 on `trace@local.ccz`. Control: `case-extension-registration`. Defect 24's five proof 3 paths read where a subcase block sits on the two paths; if this fix moves them, the controls defect 24 names (`case-extension-registration-after-13`, `case-extension-query-after-13`, `case-extension-repeat-after-13`) are retained again in place from this pull request's corpus and those paths rewritten from the run. No fixed entry names those directories, so retaining them again is allowed.

**Spelling rule.** `proof/rules/case_block_position.py` retires, with `test_case_block_position.py`, its import and `RULES` line in `proof/rules/__init__.py`. The rule erased exactly Nova's former item position.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `case-extension-registration` keeps showing the opposite orders. The retained archives of the repeat controls show the old item position as a difference no entry holds, which a control tolerates.

**Nova tests.** Pure, over the emitted DOM (`caseBlocks.test.ts`, `extensionCaseEmission.test.ts`, `repeatContextSubcase.test.ts`): the data node's child order (fields, subcases, own case, usercase) and the item's first child, for a single repeat subcase and for one beside a Save to Case block, each expectation written from `_create_casexml` and not from the emitter's output. Native proof: `proof/native/test_case_emission.py` compares the child order of the local data node with HQ's regenerated one.

**Lane.** Locally: `case-extension-registration`, `nested-menu-registration-children` and `case-capture-repeat` through proof 3, with `case_block_position` deleted. CI's full lane passes without the rule, shows no `order()` difference on any document, and holds the 2 fixed entries.

## Contract statements this part leaves behind

When the plan leaves `docs/plans/`, these stay in `lib/commcare/CLAUDE.md`:

- Nova reserves no question names for its own nodes; the names it refuses are the ones HQ's form builder cannot keep (defect 15, finding 43). Generated nodes are `nova_<purpose>...` from `planGeneratedNodes`, with the collision rule above.
- The two structural rules, and the Save to Case table.
- Shadows carry `#form/` only; no form source holds a `#case/` hashtag or a head hashtag element. `case_references_data.load` keeps HQ's `#case/` strings, which HQ's app summary reads (`app_schemas/app_case_metadata.py`) and Vellum does not.
- A leaf of a case block carries no `type` and no `constraint`.
- Itext values follow Vellum's fill; `<h:title>` and the data node's `name` are the default-language form name.
- The local archive's case blocks stand where HQ's build puts them.
