# Step 2, part 05: Work item D, part 2: XForms inside HQ's editable envelope (defect 13; findings 33, 37, 45, 46, 47, 55, 66)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part makes every form Nova exports one that HQ's form builder (Vellum) opens, saves and writes back unchanged in meaning. It owns defect 13 in all its parts, findings 33, 37, 45, 46, 47, 55 and 66, and defect 14's data node name, which is one change with finding 46. It moves 210 register entries of `main`'s register to `proof/fixed-defects.json` (212 where pull request 1 registered work item H's two): 176 for defect 13, 16 for finding 33, 2 for finding 37, 3 each for findings 45, 46 and 55, 4 for finding 47, and defect 14's 3 data node name entries; and finding 66's one, which the lane's branch added.

Conventions for this part:

- HQ paths are relative to `corehq/apps/app_manager`. Vellum paths are relative to Vellum `src`. Core, Android and Connect are named by repo.
- Every upstream fact this part states was executed during planning on the reader that decides it, at the pins. The method, once: each planned spelling was written by hand into the form of a retained control (`proof/controls/<id>`), in a fork of that control's published app, and run through two saves in HQ's form builder with and without the `save_to_case` privilege, HQ's build, Core's sessions and submissions before and after each save, and HQ's case processing of every submission. The lane's own manifest check and proof 4 then judged a copy of each control whose captured publishes held the planned form, against the register. Formplayer's own application, HQ's Web Apps client in Chromium, and commcare-android under Robolectric (install, restore, form entry to its end, its own case processing, an incomplete save reopened) ran HQ's build of the same forms, and Connect's receiver ran the one Connect spelling. Each block names its controls. "Executed" with no reader named means every one of these that reads the spelling.
- A citation says where a behavior lives so the implementer can find it. It is never the evidence: the run is.
- `proof/identity-moves.json` gains no entry from this part. Proof 1 compares two exports of one document by one revision of Nova, so an emitter rename or a migration moves both sides alike. What moves once in HQ is listed under each block's **Identity** and held by the cutover's tests over the frozen pre-step fixtures.
- No pull request in this part adds an `/api` route. One changes a tool's input schema (the reserved-name removal, pull request 7); the implementer asks the person before running `npm run test:schema`, which bills one live request per schema. Pull request 6 changes model-facing prose and one tool's output row, and no input schema. Each is a change to what a model is told, so pull requests 6 and 7 each bump `lib/models.ts::MODEL_CONTEXT_VERSION`; part 11, The model-addition checklist, item 13, is the one list of the pull requests that do and of the value each sets.

## Every node the emitter adds to a form

Nova's authored content is questions, case operations and Connect blocks. Everything else in a form's data tree is generated. From step 2 every name Nova mints in a form's source is `nova_<purpose>...`, starts with a letter, and comes from one allocator; the row element `item` and the build's own `case`, `subcase_<n>` and `commcare_usercase` keep the names CommCare gives them. Nova reserves no question names for its own nodes: an author may name a question `nova_url_x`, and the allocator steps around it. The names Nova refuses are the ones HQ's form builder cannot keep (defect 15, finding 43).

### Nodes in the form source (HQ upload and local archive both)

| # | Today | From step 2 | Written by | Structure and binds from step 2 | Left for step 5 |
|---|---|---|---|---|---|
| 1 | `__nova_constraint_<question>_<n>` | `nova_constraint_<question>_<n>` | `xform/builder.ts::buildFieldParts`, planned by `xform/constraintCollections.ts::planConstraintCollections` | Hidden Value beside the validated question. Bind `type="xsd:int"`, `calculate` the lifted `count(other[predicate])`, `relevant="count(<question>) > 0"`. No `vellum:calculate` (its expression filters a form reference). The predicate's own-node read is printed `./.` (under "Shadows") | none |
| 2 | `nova_constraint_message_<question>` | unchanged | `builder.ts::buildFieldParts`, named by `xform/constraintMessage.ts::ConstraintMessageNames.allocate` today | Sibling with a body `<input>` whose label is the question's `-constraintMsg` itext. Bind `type="xsd:string" relevant="false()" readonly="true()"`. The one generated sibling that carries a control | none |
| 3 | `__nova_url_<question>` | `nova_url_<question>` | `builder.ts::buildFieldParts`, named by `xform/captureUrlNode.ts::captureUrlNodeName`; `lib/commcare/formActions.ts` names the same node | Hidden Value beside the capture. Bind `type="xsd:string"`, `calculate` the link expression, `relevant="count(<capture>) > 0"` | none |
| 4 | `__nova_datetime_<question>` | `nova_datetime_<question>` | `builder.ts::buildFieldParts`, named by `xform/datetimeCaseValue.ts::datetimeCaseValueName`; `formActions.ts` names the same node | Hidden Value beside the datetime question. Bind `type="xsd:string"`, `calculate` `datetimeCaseValueExpression(<question>)`, `relevant="count(<question>) > 0"` | none |
| 5 | none | `nova_trimmed_<question>` (finding 33) | `builder.ts::buildFieldParts`; `formActions.ts::buildFormActions` names it | Hidden Value beside each question a basic action or a source-lowered block (`nova_update_selected_cases`, `nova_subcase_<n>`) reads as a case name or external id. Bind `calculate` the trim `caseOps.ts::caseScalarTextValueCalculation` writes today (`replace()` of leading and trailing code units U+0000 to U+0020), `relevant="count(<question>) > 0"`, no `type` | none |
| 6 | `nova_count_<repeat>` | unchanged | `builder.ts::buildRepeatBody`, named by `xform/repeatCountNode.ts::repeatCountNodeName` today | Hidden Value in the repeat's parent scope. Bind `type="xsd:int"`, `calculate` the count expression | the copy of a hidden value's count (defect 30) |
| 7 | query repeat `<id ids count current_index vellum:role="Repeat"><item id index jr:template>` | unchanged | `builder.ts::buildContainer`, `buildRepeatBody` | Author-named wrapper; binds on `@count` and `@current_index`; three setvalues | `nova_query_count_<repeat>`, `nova_query_id_<repeat>` and the placement (defect 25) |
| 8 | `__nova_operations` (a data element with children and no control) | `nova_operations`, a group | `xform/caseOps.ts::buildCaseOperations`, placed by `attachCaseOperationData` and `attachCaseOperationBody` | Data element plus body `<group ref="<path>"/>` with no label, no appearance and no bind. First child of `/data`; last authored-scope child of a repeat's template; first child of a selected-cases `item` | none |
| 9 | `<operation id>` | unchanged name | `caseOps.ts::buildCaseOperations` | Save to Case block (`vellum:role="SaveToCase"`, `vellum:case_type`). No bind on the block itself. Its condition moves (row 11 and "Wrapper conditions") | attachment children (defect 23) |
| 10 | none | `nova_keyed_<operation id>`, a one-row repeat, with its count node `nova_count_nova_keyed_<operation id>` | `caseOps.ts::buildCaseOperations` | Only around a root create keyed by an answer ("The root create id"). Data element with `jr:template=""` inside `nova_operations` holding the create's block; body `<group><repeat nodeset jr:count jr:noAddRemove="true()"/></group>` inside the `nova_operations` control. The count node is row 6's, with `calculate="1"` | none |
| 11 | none | `nova_condition_<operation id>`, a group | `caseOps.ts::buildCaseOperations` | Data element inside `nova_operations` plus body `<group ref>` inside the `nova_operations` control. Bind `relevant` the operation's condition | none |
| 12 | `__nova_guard_<operation uuid>_<linkIndex>`, `..._retype_identity`, `..._text` (hand-written `<case><update/></case>`, no role) | `nova_guard_<operation id>_type`, `nova_guard_<operation id>_retype`, `nova_guard_<operation id>_text` | `caseOps.ts::buildCaseOperations` | Update-only Save to Case blocks after the operation's block: at most one of each kind per operation | none |
| 13 | `__nova_selected_cases` | `nova_selected_cases` | `caseOps.ts::buildCaseOperations` | Unchanged structure (`vellum:role="Repeat"`, `ids`, `count`, `current_index`, `item` template, body `<group><repeat jr:count jr:noAddRemove>`), except that its `item` now holds a `nova_operations` group whose control sits inside that `<repeat>` | the placement and model-iteration shape (defect 25) |
| 14 | `__nova_update_selected_cases` | `nova_update_selected_cases`, inside the group `nova_condition_update_selected_cases` | `caseOps.ts::buildCaseOperations` | Update-only Save to Case block per selected case. Per-row `relevant` kept; the "some shared answer is present" condition is the group's `relevant` | the `<attachment>` child (defect 23) |
| 15 | `__nova_close_selected_cases` | `nova_close_selected_cases` | `caseOps.ts::buildCaseOperations` | Close-only Save to Case block. Its condition stays `relevant` on `<block>/case/close` | none |
| 16 | `__nova_subcases` (a data element with children and no control) | `nova_subcases`, a group | `caseOps.ts::buildCaseOperations` | Data element plus body `<group ref>` with no bind; appended at the root or in the owning repeat | none |
| 17 | `__nova_subcase_<n>` | `nova_subcase_<n>` | `caseOps.ts::buildCaseOperations` | Save to Case create (with update, index and close). Its condition is `relevant` on `<block>/case` | the `<attachment>` child (defect 23); the inert subcase action beside it (defect 24) |
| 18 | none | `nova_close`, inside the group `nova_condition_close` | `caseOps.ts::buildCaseOperations` (defect 14's close conditions, pull request 9; part 06, 2. Close conditions the Case Management tab cannot state) | Close-only Save to Case block for the loaded case of a single-select form whose close condition the Case Management tab cannot state. The group's `relevant` is the condition | none |
| 19 | Connect blocks `<connect id>` | unchanged name | `builder.ts::buildConnectBlocks` | Author-named `vellum:role="Connect..."` wrapper. A deliver unit gains an empty `work_area_id` with a bare bind (finding 55) | none |

No generated node holds a case id for other blocks to read. One block reads another's id and leaves where they stand, through `current()` ("The registration case-id read and reads between case blocks"), so a form's submission gains no leaf for it.

Not question names, and unchanged: the itext form names `__nova_identity`, `__nova_mode` (with `;markdown`, `;image`, `;audio`, `;video`, `;video-inline`), `__nova_locale` and `__nova_piece_<n>` that `constraintMessage.ts::protectConstraintMessage` writes on a protected message's `<text>`. HQ's form builder keeps them: proof 4 saves the corpus documents that hold them (`xml-unicode`, `expander-form-hashtag-expansion-declares-the-casedb-02e7ce76-0`) twice on every pull request, and the register holds no entry for them. The manifest holds them (`questions/protected-constraint-message-forms`), and the rename leaves them alone. The `__nova_mode;<medium>` forms leave with validation-message media in part 08, Defect 16: three media slots leave the model, not here.

### Nodes only the local archive adds

`xform/caseBlocks.ts::addCaseBlocks` adds `case`, `subcase_<n>` and `commcare_usercase`, and `xform/metaBlock.ts::addMetaBlock` adds `orx:meta`. These are the names HQ's own build writes (`xform.py::XForm._create_casexml`, `_add_usercase`, `_add_meta_2`), so they keep them. Finding 37 changes their order; finding 33 changes what their name and external id binds read.

### The one allocator

New file `lib/commcare/xform/generatedNodes.ts` exports `planGeneratedNodes(doc, formUuid, connectIds): GeneratedNodePlan`, a pure function of the document. It replaces `repeatCountNodeName`, `ConstraintMessageNames`, `captureUrlNodeName`, `datetimeCaseValueName` and the literals in `caseOps.ts`. Lookups are by purpose and owner identity, never by path: `constraintCount(fieldUuid, n)`, `constraintMessage(fieldUuid)`, `url(fieldUuid)`, `datetime(fieldUuid)`, `trimmed(fieldUuid)`, `count(repeatUuid)`, `operations(scope)`, `subcases(scope)`, `selectedCases(scope)`, `keyed(operationUuid)`, `keyedCount(operationUuid)`, `condition(operationUuid)`, `guard(operationUuid, kind)`, `subcase(n)`, `updateSelectedCases()`, `conditionUpdateSelectedCases()`, `closeSelectedCases()`, `close()`, `conditionClose()`.

The collision rule, which is deterministic:

- **Base.** `nova_<purpose>_<owner id>[_<ordinal or kind>]`, or the fixed name for a container. A keyed create's count node is `nova_count_` followed by its repeat's own name, the rule every count node follows.
- **Scope.** One namespace per parent element. A question's generated siblings share the namespace of the question's container (a query repeat's `item` is its own). Every name inside one `nova_operations` group shares one namespace, including names nested in its condition groups and its keyed repeats, so adding or removing a condition never renames a node. `nova_subcases` likewise.
- **Taken before any allocation.** Every authored name in the scope: every sibling question id, earlier or later; at the form root, the form's Connect block ids; in a `nova_operations` scope, the id of every case operation whose block lands there.
- **Suffix.** A base that is taken becomes `<base>_<n>` for the smallest `n >= 1` not taken. This is the numbering `repeatCountNodeName` and `ConstraintMessageNames` use today, so no live `nova_count_` or `nova_constraint_message_` path moves. `lib/domain/idSlug.ts::suffixUntilFree` starts at `_2` and is for ids Nova mints for authors; it is not used here.
- **Allocation order**, each allocation joining the taken set: questions in `orderedFieldUuids` order, and for one question its constraint counts by ordinal, its constraint message, its url, its datetime, its trimmed value, then (a repeat) its count; then the scope's containers in the order `nova_operations`, `nova_subcases`, `nova_selected_cases`. Inside a `nova_operations` namespace: operations in `orderedCaseOperations` order, each `nova_count_nova_keyed_`, then `nova_keyed_`, then `nova_condition_`, then guards in the order `type`, `retype`, `text`; then `nova_condition_update_selected_cases`, `nova_update_selected_cases`, `nova_subcase_<n>` ascending, `nova_close_selected_cases`, `nova_condition_close`, `nova_close`.

Why it is stable across republish: the plan is a function of the document alone, so two exports of one document agree. A generated name changes only when its owner is renamed (which moves the owner's own path too) or when an authored sibling equal to it appears or disappears. Both are edits to the same form, inside the edit's footprint (`proof/corpus/footprint.ts`). Nova accepts an authored question named like a generated node without a refusal or an advisory, because step 6 must read HQ apps that hold one; the cost, stated in `lib/commcare/CLAUDE.md`, is that the generated node's HQ export column moves to the suffixed path when an author adds such a question.

### The two structural rules Vellum's parser imposes

Both live in `parser.js::parseControlTree` (`merge`) and `parser.js::parseControlElement`, and apply per parent: the root, each group, each repeat.

1. **Control order mirrors data order.** A parent's body controls, in body order, name that parent's data children in the same relative order. Data-only children (Hidden Values, Save to Case blocks) may sit anywhere between them. One control out of order makes Vellum rebuild the parent as every control-bearing child in control order followed by every data-only child, which moves case blocks, and Core applies case blocks in document order (commcare-core `XmlFormRecordProcessor.process`).
2. **Each control sits inside its data parent's control.** A control whose parent control is not its data parent's is re-parented, and `form.js::dataTree` then appends it at the end of the data parent's children.

What the emitter does with them:

- the root `nova_operations` control is the first child of `<h:body>`, as its data is the first child of `/data`;
- a repeat-scoped `nova_operations` control is appended inside that `<repeat>` after the authored controls and before the `nova_subcases` and `nova_selected_cases` controls of the same scope, the order `attachCaseOperationData` places their data;
- a selected-cases `nova_operations` control is the only child of the selected-cases `<repeat>`;
- each `nova_condition_` control and each `nova_keyed_` control sits inside its `nova_operations` control, in the order of its data element among that group's control-bearing children;
- no Save to Case block and no Hidden Value has a control (`saveToCase.js` mug options `isDataOnly`; `mugs/types/misc.js::DataBindOnly`);
- setvalues are written in data-tree order, the order Vellum writes them (`writer.js::createSetValues`).

Executed during planning, on `case-operation-conditional`, `case-operation-sequence`, `case-operation-retype`, `case-operation-link`, `case-operation-key` (root scope), `case-operation-query` and `case-operation-repeat` (repeat scope), `case-capture-multiple` (selected cases, once as it stands and once with a `nova_close_selected_cases` block added, which no corpus document holds), and `case-extension-registration` and `case-extension-repeat` (`nova_subcases` at the root and in a repeat): with the forms written this way, Vellum's first save kept every group, every data-only child between the controls where it stood, and every block, and its second save changed nothing. The first save wrote setvalues back in data-tree order where the hand-built form had them in another, and a bare bind for each group, which `proof/rules/empty_binds.py` erases.

What a worker sees of the groups, executed on HQ's build of the same forms: nothing. HQ's Web Apps client gives each of these groups, the keyed repeat and its row no box (each is rendered `d-none` with a zero-size rectangle, the screen's text and question positions equal to today's form); commcare-android steps past them and shows the same question screens as today; Core's session reads one group event with no caption.

### Save to Case facts the emitter follows

Where each lives: Vellum `saveToCase.js` (`getBindList`, `getSetValues`, `parseDataNode`, the plugin's `parseBindElement`, `handleMugParseFinish`, `dataChildFilter`, the `case_id` and `updateProperty` validation functions) and `logic.js::_addReferences`. Each row was executed during planning by the two saves over the controls named above; the last column says what was seen.

| Fact | What Nova writes | Seen in the two saves |
|---|---|---|
| The plugin loads only with the `save_to_case` plan privilege (`views/formdesigner.py::_get_vellum_plugins`). Without it every block parses as Hidden Values and its attribute binds are discarded | Every app with a block in a form's source needs that privilege; the confirmation of part 03, C2. Plan features: the per-privilege confirmation, covers it | Without the privilege, on `case-operation-conditional`: 17 "Bind Node [...] found but has no associated Data node" warnings on load, every `@case_id`, `@date_modified` and `@user_id` bind gone after the first save, and Core then refuses the submission whose condition is true ("The date_modified attribute of a <case> ... wasn't set"). With it, none of this |
| An update-only block needs at least one property row with a name matching `/^[a-z][\w-]*$/i` and a parseable `calculate`; an `<update>` child with no bind is dropped and is the error "Add at least one property to update, or deselect the Update action." | A guard writes `update/case_type` with its own bind | No message on any guard; both saves keep the row |
| A block that creates merges its update rows into its create rows after the parse, and needs no update row | A create carries `create/case_type`, `create/case_name`, `create/owner_id` and any update rows | Kept, in this order |
| `relevant` on the block's own node is never written back | No bind on a block | No bind on any block after a save |
| `relevant` on `<block>/case` is written back only for a block that creates (the Open Case Condition) | Used only on creates | Kept on the conditional creates |
| `relevant` on an update, create or index row is kept; `relevant` on `<block>/case/close` is kept; a `relevant` on `create/case_type` or `create/case_name` is promoted to the Open Case Condition | Per-row conditions stay on rows; close conditions stay on `case/close` | A row's and a close's `relevant` kept |
| `relevant` on a wrapping group is kept (`mugs/defaultOptions.js::getBindList`) | Conditions of updates and closes live on `nova_condition_` groups | Kept on every group |
| No row bind carries `type` or `constraint`; only `@date_modified` is typed (`xsd:dateTime`) | No `type` on a leaf; `@date_modified` stays typed | Kept as written |
| Children of `<case>` are written `create`, `update`, `close`, `index`; children of `<create>` are `case_type`, `case_name`, `owner_id` | That order | Kept |
| Binds are written: (a create inside a repeat) `@case_id`; `<block>/case` `relevant`; `create/case_type`; `create/case_name`; `create/owner_id`; update rows; `case/close`; index rows; `@date_modified`; `@user_id`; (a block that does not create) `@case_id` | That order | Written back in this order |
| A create outside a repeat carries its id as `<setvalue event="xforms-ready" ref="<block>/case/@case_id" value="...">`; a create inside a repeat as a bind; given the other way round, a save rewrites the first and loses the second | `uuid()` setvalue on a root create; a bind on a create inside a repeat, the keyed one-row repeat included | Each kept in its own spelling |
| The Case ID must contain a path or a function call, and `uuid()` only with Create | `uuid()` on creates only; `if(...)` and paths elsewhere | No message |
| Each `<index>` child must carry both `case_type` and `relationship`; a missing one is written back as the literal `undefined` | Both attributes on every index child | Kept |
| Vellum checks the scalar fields (`case_id`, `caseName`, `ownerId`, the conditions) for unknown questions and skips the property rows (`suppressUnknownReferenceWarning`). Its check reads absolute `/data/` paths and hashtags, and never a path that starts at `current()` | No expression names a node inside a case block by an absolute path. One block reads another's `@case_id` and leaves through `current()` | An absolute read of `<block>/case/create/case_name` or `<block>/case/update/<row>` in a guard's Case ID drew "Unknown questions" on both saves, on every root-scope control. The same reads through `current()` drew none, at the root and in a repeat |
| Vellum finds a block's actions by element name (`parseDataNode`: `create`, `update`, `close`, `index`), so a `<case>` whose children carry a namespace prefix is a block with no action | `<case>` declares the case namespace as its default namespace and its children carry no prefix, as `caseOps.ts` writes them today | A close-only block written with prefixed children drew "You must select at least one case action", lost its `close` and its binds on the save, and Core and HQ then refused every submission. Written with the default namespace, both saves kept it |
| A raw casedb read in a scalar field is no hashtag and draws no warning, listed property or not | Raw casedb reads, as `lib/commcare/hashtags.ts::expandCaseToWire` prints them | An Open Case Condition, a group condition and a Case ID that read an unlisted property drew no message |

### What ran, by reader

| Design | Readers that ran it during planning | Controls |
|---|---|---|
| Group containers, condition groups, guards as Save to Case blocks, reads between blocks through `current()` | Two Vellum saves with and without the privilege; HQ's build; Core before and after the saves; HQ's case processing; the lane's manifest check and proof 4; Formplayer; the Web Apps client; Android | `case-operation-conditional`, `-sequence`, `-retype`, `-link`, `-query`, `-repeat`, `case-capture-multiple`, `case-extension-registration`, `case-extension-repeat` |
| A root keyed create in a one-row repeat | The same, with an incomplete save reopened on Android | `case-operation-key` |
| The datetime leaf expression | Core in three device zones; two Vellum saves; HQ's case processing; Android | `case-operation-sequence`, `case-operation-retype` |
| No `#case/` shadow, no predicate shadow, `./.` | Two Vellum saves; HQ's build after each; Core; Android | `standard-case-reads`, `container-query-conditional` |
| Defaults read through `current()`; the registration id read from the session | Two Vellum saves; Core; Formplayer; Android, with an incomplete save reopened | `targeted-load-time-values`, `case-operation-repeat`, `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0` |
| The itext fill; a label blank in every language; the title and data node name | Two Vellum saves, one in a second editing language; HQ's build; Core; Formplayer; the Web Apps client; Android | `localization-optional`, `localization-bilingual`, `navigation-base`, `expander-select-option-itext-ids-index-keyed-issue-10-608c801a-0` |
| The ref-less repeat group | Two Vellum saves; Core | `targeted-labelled-group-repeat`, and every repeat control above |
| `nova_trimmed` and the source-question guard | HQ's build; two Vellum saves; two Case Management page saves; Core; HQ's case processing; Formplayer; the Web Apps client; Android | `navigation-base` |
| The Connect work area id | Two Vellum saves; Core; Connect's receiver | `expander-expanddoc-hq-json-projection-sort-elements-85a51a04-0` (its edit), `connect-deliver-default` |

One reader does not decide one spelling: commcare-android at the pin has no step for a multi-select case list (its home starts nothing while the session still needs the selected cases), so the selected-cases forms (rows 13 to 15) are Formplayer's and the Web Apps client's, and both ran them: in the client, two cases ticked in the list and Continue, the form opened, answered and submitted.

## Order the parts land in

Three pull requests of the step's one stack carry this part. An entry whose path holds `__nova_` must be fixed before, or in, the pull request that renames the nodes, because an entry must show on its document and on its control, and a control keeps its pre-fix bytes.

| Stack position | Parts | Entries moved to the fixed register |
|---|---|---|
| XForm, first part (pull request 6) | leaf constraints; shadows with findings 45 and 47; datetime leaves; relative defaults; the registration case-id read; blank translations; finding 55; the ref-less repeat group; finding 46 with the data node name | 51 (53 with work item H's two, where pull request 1 registered them): defect 13's 35 (13 leaf constraint, 8 shadows, 5 datetime, 4 defaults and case-id read, 5 translations), findings 45 (3), 47 (4), 46 (3), 55 (3), defect 14's data node name (3) |
| XForm, second part (pull request 7) | containers as groups; the rename and the allocator; guards; conditions; reads between blocks; the root create id; defect 23's and 24's entries re-pathed onto new controls | 141: guard blocks 67, reserved names 25, wrapper containers 6, wrapper conditions 29, the root create id 14 |
| Case writes through basic actions (pull request 9) | finding 33; finding 37; finding 66; with defect 14's `update_case` always, moved close conditions and `external_id`, which are part 06's (1. `update_case` is `always` on every case form; 2. Close conditions the Case Management tab cannot state; `external_id` as an ordinary update row) | 19 from this part: finding 33's 16, finding 37's 2, finding 66's 1 |

The root create id is in pull request 7 and not in pull request 6, because its spelling puts a repeat's control inside the `nova_operations` control, which exists only once the containers are groups.

Each of pull request 6's spellings was also judged alone, with the old names and containers still in place (the lane's manifest check and proof 4 over `container-query-conditional`, `case-operation-sequence`, `case-extension-registration` and `case-capture-multiple` holding pull request 6's spellings and nothing of pull request 7's): its entries left, pull request 7's stayed, and the only differences no entry held were defect 25's new classes on `container-query-conditional` (under "Shadows").

Defect 3 (case save references) is pull request 8, after the restructure, because the guard blocks appear in `case_references_data.save` (part 04, Defect 3: `case_references_data.save`). Seen in the saves: Vellum posts one entry per block under the block's absolute path, a block inside a group or a keyed repeat under its nested path, a guard with the one property `case_type`.

Work item H runs across the stack: its document `targeted-case-operation-read` and its control arrive in pull request 1 (part 09, Work item H: the unknown-question warning for a case operation's property); its two entries, where pull request 1 registered them, move to the fixed register in pull request 6 with findings 45 and 47 (under "Shadows"); and pull request 8 removes the open clause from `proof/README.md` (part 04, Work item H: defect 3's unknown-question clause).

The `case-operation-key` document does not change in this part: its root create keeps its key. Its 14 guard-block entries leave in pull request 7 with the rest, on its own bytes.

## Shadows (defect 13) with findings 45 and 47: no `#case/` shadow

**Today.** `hashtags/formContext.ts::vellumShorthandInContext` projects `#form/<path>` for every form reference whether or not it carries a predicate, and `#case/<property>` for every single-segment read of the form's own loaded case on a follow-up or close form. `builder.ts::buildFieldParts` writes the result as `vellum:calculate`, `vellum:relevant`, `vellum:constraint`, `vellum:requiredCondition` and `vellum:value`, and `builder.ts::buildXForm` publishes each case reference in the head's `<vellum:hashtags>` and `<vellum:hashtagTransforms>` (`lib/commcare/hashtags.ts::buildVellumTransforms`).

Three harms, one cause:

- A hashtag cannot be the base of a predicate or the head of a longer path. Vellum cannot parse `#form/a[...]`, writes the shadow verbatim into the real attribute (`util.js::writeHashtags`), and HQ's next build fails. Defect 13, shadows. Executed on today's `container-query-conditional`: after one save HQ's build refuses the form, "invalid calculate expression [count(#form/items/item/choice[. = 'yes'])]".
- `#case/status`, `#case/case_id` and `#case/owner_id` are saved through the prefix transform as child elements (`xpath.js::hashtagToXPath`; `datasources.js` lists no `@` key), which the case database does not have. Finding 45.
- `#case/<property>` for a property HQ's schema does not list (`app_schemas/casedb_schema.py::_get_case_schema_subsets`) is an unknown question on every save (`logic.js::_addReferences`). Finding 47, and defect 3's unobserved clause.

**Fix.**

- `vellumShorthandInContext` projects `#form/` only. Any other namespace in the expression means no shadow.
- It returns no shadow when, in the projected expression, a `HashtagRef` is the base of a `Filtered` node or the first component of a longer `Child` or `Descendant` path. Structure is read through the Lezer grammar (`lib/commcare/xpath/grammar.lezer.grammar`), as `planConstraintCollections` already walks `Filtered` bases. Every constraint count is such an expression and loses its shadow with no special case.
- The form's head carries no `<vellum:hashtags>` and no `<vellum:hashtagTransforms>`, and no `<output>` carries a `vellum:value` for a case reference.
- **A predicate's own-node read is printed `./.` outside a validation condition.** With the shadow gone HQ's build passes, and Vellum then marks the expression itself: a bare `.` anywhere in a Calculate Condition or a Display Condition, inside a predicate too, draws "The Calculate Condition for a question is not allowed to reference the question itself. Please remove the . from the Calculate Condition or your form will have errors." on every save (`logic.js::LogicExpression.analyze` sets `referencesSelf` for a relative path of exactly one `self` step; only the validation condition's spec carries `mayReferenceSelf`). A relative path of two `self` steps is not that, and Core reads `./.` as `.`. New `lib/commcare/xpath/selfSteps.ts::spellPredicateSelf(source)` rewrites, through the Lezer grammar, each one-step `.` path that stands inside a predicate to `./.`. It is applied to every expression Nova writes into a `calculate`, `relevant`, `required`, a setvalue's `value` and a Save to Case field, the lifted constraint count included, and never to a `constraint`, where `.` is the answer and Vellum allows it. A bare `.` outside any predicate is left as written.
- Why writing no case shadow is right for every class of read: for a property HQ lists, Vellum's reverse map turns Nova's raw path into `#case/<property>` on load and saves the same real attribute; for an unlisted property and for an attribute-backed read the raw path stays raw, draws no warning and is written back unchanged. The match is on the printed string, so Nova keeps printing the casedb read as `lib/commcare/hashtags.ts::expandCaseToWire` does today (single quotes, `@case_id = <session read>`).
- Work item H's clause closes here: with no `#case/` hashtag in any form source, the warning cannot be produced from Nova's bytes. Defect 3's fix needs no ordering against this one.
- Stated in `lib/commcare/CLAUDE.md`: once a Vellum save has written its own `#case/x` shadow and `x` later leaves HQ's schema, Vellum warns about HQ's bytes, as it does for any form made in HQ; a Nova publish replaces the source.

Executed during planning:

- On `standard-case-reads` with no head maps and no case shadow, two saves, no message. Vellum wrote `vellum:calculate="string(#case/case_name)"` and its own two head elements for the one listed property, left `@case_id`, `@owner_id`, `@status`, the three unlisted properties and every parent read raw with no shadow, and changed no real attribute. Core's submission is the same before and after.
- On `container-query-conditional` with no shadow on the count and on the filtered constraint: two saves, the real attributes kept verbatim with no shadow written by Vellum either, HQ's build passing after each.
- The same form with the count's predicate spelled `[. = 'yes']` drew the self-reference warning on both saves; spelled `[./. = 'yes']` it drew none and both saves kept it. A Display Condition behaved the same way in both spellings. Core computed the count alike in both spellings (2 with two matching rows, the dependent question shown and accepted), and Android accepted the answer at a count of 2 and refused it at 1 with the `./.` spelling.
- An Open Case Condition, a condition group and a Case ID that each read an unlisted property as a raw casedb path, on `case-operation-conditional`: two saves, no message. That is work item H's closure.

**Files.**
- Emitters: `lib/commcare/hashtags/formContext.ts` (`vellumShorthandInContext`: drop the `onRef` parameter, the case vocabulary and the header's case paragraph; add the two structural tests); new `lib/commcare/xpath/selfSteps.ts`; `lib/commcare/xform/builder.ts` (`buildXForm` loses the two head elements; `buildLabelNodes` loses the case `vellum:value`; `buildFieldParts` applies `spellPredicateSelf`); `lib/commcare/xform/constraintCollections.ts` and `lib/commcare/xform/caseOps.ts` (apply it); `lib/commcare/hashtags.ts` (delete `buildVellumTransforms` and the `"#case/"` entry of `VELLUM_HASHTAG_TRANSFORMS`; `VELLUM_CASE_GENERATION_PREFIXES` stays for `hqLoadReference`, which still writes HQ's `#case/` strings into `case_references_data.load` of the HQ JSON; HQ's app summary reads that map (`app_schemas/app_case_metadata.py`), and Vellum posts a map on save and never reads the stored one).
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools, public docs: none. Preview evaluates the AST, not these strings.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Vellum dual-attribute pattern" and "Hashtag form-context", rewritten to say shadows carry `#form/` only and why, and that a predicate's own node is `./.` outside a validation condition.
- Proof: `proof/rules/test_vellum_hashtags.py` today takes the two head elements out of Nova's own form (`_dropped` asserts Nova wrote them). From this pull request its document is `standard-case-reads` and it works the other way: Nova's form (no maps) is spelling one, and the test inserts the two head elements a Vellum save writes for that document's listed property (their text copied into the test from the Vellum-saved source in proof 4's retained evidence of control `standard-case-reads`; during planning the save wrote `{"#case/case_name":null}` and the `#case/` prefix transform) for spelling two, and the same with one more hashtag in the map for spelling three. Its assertions are unchanged. `proof/rules/conftest.py::DOCUMENTS` gains `standard-case-reads`.
- Tests: the two tests of `lib/commcare/__tests__/expander.test.ts` behind the documents `expander-form-hashtag-expansion-emits-the-editor-1daa5537-0` and `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0` keep their titles in this pull request, so both document ids stay; their bodies assert the new bytes.

**Stored shape and migration.** None: shadows and the `./.` spelling are derived at emission. No transform step, no notice.

**Register.** 15 entries to the fixed register (17 with work item H's two).
- Defect 13, shadows, 8: `d13-shadows-*`, all proof 4 (`source:form`, `build`, `validate_app`, `trace`); controls `container-query-conditional` (7) and `container-query-conditional-parent` (1).
- Finding 45, 3: `d45-blanked-case-reads-*`, proof 4; control `standard-case-reads`.
- Finding 47, 4: `d47-unknown-question-vellum-*`, proof 4 (`editor:vellum` and `editor:vellum again`); controls `standard-case-reads` (2) and `expander-form-hashtag-expansion-emits-the-editor-1daa5537-0` (2).
- Work item H, 2, only where pull request 1 registered them: `d3-operation-read-vellum-logic-bad-path-warning` and `d3-operation-read-vellum-again-logic-bad-path-warning` (defect 3, proof 4, `editor:vellum@*` and `editor:vellum again@*`, the `logic-bad-path-warning` on `#case/*`) move to the fixed register here, on control `targeted-case-operation-read`. Where pull request 1 found no class of its own, nothing moves and the document stays a passing witness.
- **Defect 25 gains entries here.** Today the saved `container-query-conditional` form does not build, so nothing downstream of defect 25's dropped bind is compared. Once it builds, proof 4 shows the rest of that symptom: the query repeat's own `relevant` bind is gone from the built form, and Core's sessions on the saved build differ. Seen when the lane's proof 4 judged the planned form: 17 classes no entry holds, one on `form:*@vellum@*` (`/html/head[*]/model[*]/bind[@nodeset=/data/*]`, removed) and sixteen on `trace@vellum@*` (under `/runs/*/trace/*/events/*`: the event itself added, and its `attempts`, `audio`, `control`, `dataPath`, `dataType`, `event`, `help`, `hint`, `image`, `path`, `readOnly`, `required`, `text`, `unanswerable` and `valuesFrom`). They are defect 25's, step 5's, and are registered live in this pull request from its own run, with their control `container-query-conditional-after-13` retained from this pull request's corpus. Defect 25's nine entries that show today still showed, on unchanged paths.

**Spelling rule.** None retires. `vellum_attributes`, `vellum_hashtags` and `case_references_load` still erase what Vellum's own save adds for a listed property.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `container-query-conditional`, `container-query-conditional-parent`, `standard-case-reads` and `expander-form-hashtag-expansion-emits-the-editor-1daa5537-0` keep showing the three symptoms on their pre-fix bytes, and `targeted-case-operation-read` keeps showing work item H's warning where pull request 1 registered it.

**Nova tests.** These hold Nova's own output; what a reader does with it is under **Lane**.
- Pure: `vellumShorthandInContext` gives no shadow for `#form/a[#form/b > 1]`, `count(#form/a[. = 1])`, `#form/a/@x` and any expression holding a case reference, and keeps one for `#form/a + 1` and for a casedb selector whose predicate reads `#form/a`.
- Pure: `spellPredicateSelf` rewrites `.` inside a predicate, a nested predicate included, and leaves a top-level `.`, `..`, `./x` and a string literal holding a dot.
- Pure, over the emitted DOM: no attribute in the Vellum namespace, no `<output>` and no head element of any fixture form's source holds `#case/`, no form has a `vellum:hashtags` element, and no `calculate`, `relevant`, `required` or setvalue `value` holds a one-step `.` inside a predicate.

**Lane.** Locally: `standard-case-reads`, `container-query-conditional-relative`, `container-query-conditional-parent`, the `emits-the-editor` expander document and `targeted-case-operation-read` through proof 4. CI's full lane shows no difference on any document in the three classes, no self-reference warning on any document, the 15 fixed entries (17 with work item H's two) held on their controls, defect 25's new entries held on `container-query-conditional-after-13`, and HQ's build passing after both Vellum saves of the container documents. The lane's manifest check and proof 4 judged both planned forms during planning: every entry of this block documented on them left, and beyond defect 25's classes above no difference was unregistered but the form version, which is finding 46's (under "Finding 46 and defect 14's data node name").

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

- `TYPE` is `operation.retype ?? operation.caseType`, the type the case holds once the operation's block has run, so the update writes a value to itself. This is the spelling Nova already emits for an index-only block (`usesTypeOrderingGuard` in `caseOps.ts`), so the guard adds no new wire shape.
- `ID` reads the operation's own block, `<block>/case/@case_id`, through `current()`. `OK`'s reads of that block's leaves go through `current()` too. Neither is ever an absolute path: an absolute read of a node inside a block is an unknown question to Vellum ("Save to Case facts", the last two rows).
- `OK` by kind. `type`: the conjunction, over the operation's expression-targeted links in order, of today's per-link test `count(t) > 0 and string(t) != ID`, so an operation has one type guard however many links it has. `retype`: today's `not(starts-with(ID, 'nova-case-v1:'))`. `text`: today's conjunction of fixed-column validity, each read of a leaf through `current()`.
- An operation has at most one guard of each kind, three in all.
- A blank `@case_id` refuses the whole submission (commcare-core `CaseXmlParser.parse` with `CaseXmlParserUtil.validateMandatoryProperty`; HQ's `corehq/form_processor/casedb_base.py::AbstractCaseDbCache.get`).
- A guard of a conditional operation sits inside that operation's `nova_condition_` group (see "Wrapper conditions").

Executed during planning, on `case-operation-conditional`, `-sequence`, `-retype`, `-link`, `-key`, `-query` and `-repeat`, one guard of each kind among them:

- two saves keep every guard, its row and its four binds, with no message;
- a passing guard writes `case_type` to itself and HQ's case processing leaves the same cases as today's form;
- a failing text guard (a whitespace-only name) and a failing type guard give a blank `@case_id`: Core refuses the submission ("The case_id attribute of a <case> wasn't set"), HQ refuses it (`IllegalCaseId`, "case_id must not be empty"), and Android shows "Error Saving your Form" with the same text and quarantines the record, before and after the saves;
- Formplayer submits the same case blocks as Core where the guards pass.

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

**Nova tests.** These hold Nova's own output.
- Pure, over the emitted DOM: an operation with two expression-targeted links, a retype and a rename emits exactly three guards with the block and bind order above, and every read of a block's `@case_id` or leaf in a guard starts at `current()`.

**Lane.** Locally: `case-operation-link`, `case-operation-sequence`, `case-operation-retype` and `case-operation-key` through the bar and proofs 3 and 4. CI's full lane shows every guard bind surviving both Vellum saves, no editor message on any guard, the same refusals from the saved form as from the published one, and the 67 fixed entries held. `proof/native/core/CaseOperationRuntimeTest.java` runs a failed guard of each kind on Core, on the local archive and on HQ's regenerated form. The readers the lane does not yet judge carry a test each in this pull request (under "Reader tests this part adds").

## Reserved names and wrapper containers (defect 13)

**Today.** Rows 1, 3, 4, 8 and 12 to 17 of the node table start with `__nova_`, which Vellum refuses as a question id (`util.js::isValidElementName`: `/^(?!XML)[a-zA-Z][\w-]*$/`). `__nova_operations` and `__nova_subcases` are data elements with children and no control, so Vellum parses each as a Hidden Value, which takes no children (`mugs.js`, `validChildTypes`), and reports "Add at least one property to update" on the blocks inside. `lib/commcare/constants.ts::RESERVED_XFORM_NODE_PREFIX` reserves the prefix from authors through `validator/rules/field.ts::reservedFieldIdPrefix`.

**Fix.**

- Every name comes from `planGeneratedNodes` (above). `captureUrlNodePath` and `datetimeCaseValuePath` take the plan instead of deriving a name from a path, so `builder.ts` and `formActions.ts` cannot disagree. They must not. Executed on `case-operation-sequence`: with a datetime sibling renamed in the source and the action still naming the old node, HQ's validation reports a path error and Core refuses to open the form.
- `nova_operations` and `nova_subcases` are groups: a data element plus a body `<group ref="<path>"/>` with no label, no appearance and no bind. Vellum's save adds a bind holding the node set alone, which `proof/rules/empty_binds.py` already erases; Nova does not emit that bind.
- Their controls are placed by the two structural rules above. `CaseOperationBodyChild` gains a placement, and `attachCaseOperationBody` prepends the root group.
- Nova reserves no question names for its own nodes. Deleted: `RESERVED_XFORM_NODE_PREFIX` with its stale comment, `lib/commcare/identifierValidation.ts::isReservedXFormNodeName`, `reservedFieldIdPrefix` with its code `RESERVED_FIELD_ID_PREFIX`, the `reserved_prefix` arm of `lib/doc/identifierVerdicts.ts::formatVerdict`, the `__nova_` arms of `caseOperationIdVerdict` and `caseOperationLinkIdentifierVerdict`, the two `__nova_` arms in `validator/rules/caseOperations.ts`, and the `.refine` on `operationIdInputSchema`. Defect 15's narrowing (part 08, Defect 15: identifiers HQ's editors refuse) is what holds ids to Vellum's grammar from here on.
- `builder.ts::isRepeatCountSnapshot`, its two filters in `buildXForm` and the comment above them are deleted here: no emitter writes a `__nova_count_` setvalue, so the partition is the identity and the output is byte-identical. They are deleted here and not with defect 16's other stale items, because the function reads the prefix this pull request deletes, and pull request 7 lands first. Part 08, Defect 16: what the code, the tools and the docs say, does not delete them.
- The cutover's matcher reads forms HQ holds from before the step, so it keeps its own `"__nova_"` literal in `scripts/lib/hqRoundTripCutover/` and does not import the constant this pull request deletes.

Executed during planning: the two saves named under "The two structural rules" drew no "is not a valid Question ID" and no "Add at least one property to update" on any of the nine controls; with `nova_subcases` left without its control on `case-extension-repeat` the second message came back on both saves, and went with the control.

**Files.**
- Emitters: new `lib/commcare/xform/generatedNodes.ts`; `lib/commcare/xform/builder.ts`, `caseOps.ts`, `captureUrlNode.ts`, `datetimeCaseValue.ts`, `constraintCollections.ts`; `lib/commcare/formActions.ts`; `repeatCountNode.ts` and `ConstraintMessageNames` fold into the new file; `lib/commcare/constants.ts`; `lib/commcare/identifierValidation.ts`.
- Validator: `lib/commcare/validator/rules/field.ts`, `rules/caseOperations.ts`, `validator/errors.ts`, `validator/gate.ts`.
- Doc and mutations: `lib/doc/identifierVerdicts.ts`, `lib/doc/userFacingErrors.ts`; the comment in `lib/doc/caseOperationOrder.ts`.
- Preview: `lib/preview/engine/formEngine.ts` reads the count node's name from the plan in place of `repeatCountNodeName`.
- Builder: comments in `components/builder/editor/FieldIdentitySection.tsx` and `components/builder/editor/renameOutcome.ts`.
- SA and MCP tools: `lib/agent/tools/case-operations/shared.ts` (`operationIdInputSchema`), comments in `lib/agent/tools/editField.ts` and `lib/agent/tools/shared/fieldAssembly.ts`. The schema's refinement changes, so ask the person before running `npm run test:schema`.
- Proof harness: `proof/checks/compare/names.py` (`NOVA_CONTAINERS`, `NOVA_MINTED`, `nova_name`, `data_name`) reads the new fixed names (`nova_operations`, `nova_subcases`, `nova_selected_cases`, `nova_update_selected_cases`, `nova_close_selected_cases`, `nova_close`) and minted families (`nova_url_`, `nova_datetime_`, `nova_constraint_`, `nova_trimmed_`, `nova_keyed_`, `nova_guard_`, `nova_condition_`, `nova_subcase_`, each written `<family>*`), and keeps reading every `__nova_` name, because the fixed entries' controls hold them. Order of the tests in `data_name`: a fixed name first; then a name starting `nova_constraint_message_` or `nova_count_`, written `*` as today so defect 30's paths do not move (a keyed create's count node is one of these); then the families. A constraint count of a question whose id starts `message_` (`nova_constraint_message_x_0`) is therefore written `*`, and an authored question named like a family member is written as that family; each loses only specificity. `proof/checks/manifest_value_classes.py::nova_scaffolding_part` likewise. Doc comments in `proof/checks/compare/names.py`, `compare/trace.py`, `proof/checks/proof3.py` and `proof/checks/differences.py` follow. `proof/checks/test_compare.py` and `test_manifest_value_classes.py` gain a case per new fixed name and minted family, with the two overlap cases, and keep their `__nova_` cases; `test_proof3_behavior.py` and `test_proof4_editability.py` keep theirs, which describe control bytes. `proof/README.md`'s defect rows follow.
- Tests that pin the removed rule or the old names: `lib/commcare/__tests__/repeatModes.test.ts`, `validationRules.test.ts`, `caseOperationEmission.test.ts`, `multiSelectEmission.test.ts`, `extensionCaseEmission.test.ts`, `caseCaptureEmission.test.ts`, `caseWriteBoundary.test.ts`, `lib/commcare/validator/__tests__/caseOperations.test.ts`, `lib/doc/__tests__/identifierVerdicts.test.ts`, `lib/agent/tools/__tests__/editField.test.ts`, `addFields.guard.test.ts`, `constructionFuzz.test.ts`, `lib/mcp/__tests__/compileApp.postgres.test.ts`. Not touched: `constraintMessageEmission.test.ts` and `proseWhitespace.test.ts` (itext form names, which stay) and the tests that hold `__nova_compatibility_probe__` (a probe's name, not a form node).
- Surface: `lib/commcare/surface/entries/questions.json` (`invalid-question-id`, `questions/hidden-value-with-children`) and `forms-and-case-writes.json`, the emission cells that say Nova emits these.
- Cutover: `lib/notices/migrationNotice.ts` (`DEPLOYMENT_NOTICE_REASONS` gains `data-paths-move-once`), `lib/notices/migrationNoticeCopy.ts` (its renderer, with part 10's copy), `scripts/lib/hqRoundTripCutover/notice.ts` (one line per deployment) and `report.ts` (the scan's count of affected forms, and their list under `--debug-details`, as part 10, Scripts and their layout, defines the report).
- Public docs: none name these nodes.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Validation counts keep their evaluation context", "Markdown itext", "Repeat modes", "Case-management scaffolding emission", "Authored case-operation emission": every `__nova_` name and "reserved" claim; the new statement that Nova reserves no question names for its own nodes, the allocator and the two structural rules); `lib/doc/CLAUDE.md` (the reserved-prefix sentence).

**Stored shape and migration.** No schema change and no document transform: the names are derived. The cutover adds one notice line with no document change and no step: deployment reason `data-paths-move-once`, written for every deployment with part 10's copy (part 10, Work item F: the migration notice); it names no form. This pull request adds the reason to `DEPLOYMENT_NOTICE_REASONS` with its renderer, and `notice.ts` writes it. The advisory scan counts, per app, the forms whose plan holds a renamed node, a block inside a group or a keyed repeat, or a new leaf (`nova_trimmed_`), derived from `planGeneratedNodes` over the migrated document. The forms themselves, by id and name, are the report's detail: `--debug-details` prints them for one app (part 10, Scripts and their layout, under "The report"), so the people who own HQ form exports and reports built on the old paths can be told which forms to re-point. The scan also counts the forms where the unified plan gives a `nova_count_` or `nova_constraint_message_` name different from today's; a count above zero is read under the same flag before the window.

**Register.** 31 entries.
- Reserved names, 25, `d13-reserved-names-*`: manifest 13 (`invalid-question-id`, one per name pattern and depth) and proof 4 12 ("is not a valid Question ID" on six patterns, both saves). Controls: `case-capture-multiple` (7), `case-extension-registration` (4), `case-operation-query` (4), `case-operation-sequence` (4), `container-query-conditional` (3), `case-extension-multiple-repeat` (1), `case-extension-repeat` (1), `container-query-conditional-parent` (1).
- Wrapper containers, 6, `d13-wrapper-containers-*`: manifest 4 (`hidden-value-with-children` for both containers) and proof 4 2 ("Add at least one property to update", both saves). Controls: `case-operation-query` (3), `case-extension-registration` (1), `case-extension-repeat` (1), `case-operation-sequence` (1).

**Defects 23 and 24 (step 5): paths the rename moves.** The rename and the group change move the structural paths of entries step 2 does not fix. They are re-pathed in this pull request, onto new controls:

- Defect 23, attachment-mode capture: the 60 entries whose `path` holds `__nova_selected_cases`, `__nova_operations`, `__nova_subcases`, `__nova_subcase_*` or `__nova_update_selected_cases`.
- Their six controls, `case-capture-multiple`, `case-extension-multiple`, `case-extension-multiple-repeat`, `case-extension-query`, `case-extension-registration` and `case-extension-repeat`, also serve entries this part moves to the fixed register, which need the old bytes. A directory a fixed entry names is never re-retained.
- So this pull request retains six new controls, `<old control name>-after-13`, from its own corpus (`python3 -m proof.checks.controls <corpus> <document id> manifest,proof3,proof4 --as <old control name>-after-13`, the document being the one of the same name; the name argument arrives in pull request 1), rewrites the 60 paths from that run's evidence (never by text substitution), and points every live entry of defects 23 and 24 that names one of the six old directories at its `-after-13` twin: defect 23's 61 (the 60 re-pathed and `d23-attachment-form-instance-attachment-in-a-savetocase-block`) and defect 24's 12 (which name `case-extension-registration`, `case-extension-query` and `case-extension-repeat`), 73 in all. Defect 23's other six name `case-capture-followup`, hold no Nova name and keep their control.
- What the run shows, seen when the lane's proof 4 judged the planned `case-capture-multiple`, `case-extension-registration` and `case-extension-repeat`: on each, the same ten classes no entry holds yet, all of them the attachment child Vellum drops, on the new paths (`editor:vellum@*` two parse warnings for `/data/*/case/attachment/*` and its `@src`; `source:form:*@vellum@*` and `form:*@vellum@*` three each, the attachment element and its two binds; `trace@vellum@*` and `case_blocks@vellum@*` one each), and nothing else unregistered.
- Live entries of finding 33 (7), finding 37 (2) and defect 14's multi-select destinations (2, on `case-capture-multiple`) keep the old directories, which they need as fixed entries.
- The new controls are named by live entries only, so a later pull request of the stack may retain them again in place (findings 33 and 37 may, below).
- `proof/timings.json` gains the six `control:` groups.

**Spelling rule.** None retires. `empty_binds` now also erases the bare bind Vellum writes for the two groups.

**Identity.** In every deployed app, at its next publish: the data path of each node of rows 1, 3, 4, 8 and 12 to 17, and of every Save to Case block (now under `nova_operations`). HQ form export columns for the url and datetime siblings and for every block move. The notice above states it. `proof/identity-moves.json` gains no entry.

**Control.** The eight controls above keep showing the refused ids and the childless Hidden Values on their pre-fix bytes, which is why `names.py` keeps the legacy names.

**Nova tests.** These hold Nova's own output and state model.
- Pure: `planGeneratedNodes` over a form with a question named exactly like each base (`nova_url_photo` beside a capture `photo`, `nova_operations` at the root, a Connect id equal to a base, a question `message_x` with a constraint count beside a question `x` with a protected message) gives the suffixed names in the stated order, gives the same plan on a second call, and gives today's `nova_count_` and `nova_constraint_message_` names for every existing fixture.
- Pure, over the emitted DOM: for every form every emission fixture produces (the fixtures of `lib/commcare/__tests__/caseOperationEmission.test.ts`, `multiSelectEmission.test.ts`, `extensionCaseEmission.test.ts` and `constraintMessageEmission.test.ts`, whose `nova_constraint_message_` sibling is the one generated node with a control, and every authored group and repeat in them), the sequence of control-bearing data children of each parent equals the sequence of that parent's controls, each control's parent control is its data parent's, and setvalues stand in data-tree order.
- Pure: `formActions.ts` names exactly the url and datetime nodes `builder.ts` writes, under a collision.
- Pure: for a question id, an operation id and a link identifier, the verdict for `__nova_x` equals the verdict for `_x`: both accepted at this pull request, and both refused, by the leading underscore alone, once defect 15 lands in pull request 10. The test compares the two verdicts and names no outcome, so it does not flip.
- Pure, over the frozen pre-step fixture that witnesses `data-paths-move-once`: `notice.ts` gives each deployment exactly one such line, with no entities.

**Lane.** Locally: `case-capture-multiple`, `case-extension-registration`, `case-operation-query` and `container-query-conditional` through the manifest check, proof 3 and proof 4. CI's full lane shows no "is not a valid Question ID" and no "Add at least one property" on any document, no node of a `nova_operations` group moved by either Vellum save, the 31 fixed entries held on the old controls, and defects 23 and 24 held on the six `-after-13` controls. The lane's manifest check and proof 4 judged the planned form of each of the nine controls during planning: every entry of pull request 7 documented on them left, and nothing was unregistered beyond defect 23's classes above and the form version (under "Finding 46 and defect 14's data node name").

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
- Order inside `nova_operations`, per operation: the block, when it is a create or has no condition (a root keyed create inside its `nova_keyed_` repeat, after that repeat's count node); `nova_condition_<operation id>` holding the block (a conditional update or close) and then the guards. An operation with no condition has no group and its guards follow its block directly.

Executed during planning, on `case-operation-conditional` (every operation conditional, a create among them), `case-operation-retype`, `case-operation-query` and `case-operation-repeat` (a conditional update in a repeat row) and `case-capture-multiple`: two saves keep each Open Case Condition and each group's `relevant`. With the condition false, Core, Formplayer and Android each submit an empty `<create_visit/>` and no other block, and HQ's case processing touches no case; with it true each submits every block in order and HQ leaves the cases today's form leaves. The saved form behaves the same. On `case-capture-multiple` with a `nova_close_selected_cases` block added, two saves keep the `relevant` on `case/close` and the second save writes the same bytes as the first; Core and Formplayer close each selected case when the condition is true and leave it open when it is false, and HQ's case processing agrees. The Web Apps client, with two cases selected, lays out no box for the repeat, its rows or any group inside them (each has no client rectangle) before and after the condition turns true, shows the same text as today's form, and submits one block per selected case, with `close` when the condition is true and without it when it is false.

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

**Nova tests.** These hold Nova's own output.
- Pure, over the emitted DOM: a form with a conditional create, a conditional update, a guarded conditional create and a multi-select shared update emits exactly the spellings above, with each control inside its data parent's control.

**Lane.** Locally: `case-operation-conditional`, `case-operation-retype`, `case-operation-expression-retype` and `case-capture-multiple` through proofs 3 and 4. CI's full lane shows the same case blocks and case database from the Vellum-saved form as from the published one on every `case-operation-*` document, and the 29 fixed entries held. `proof/native/core/OperationRelevanceRuntimeTest.java` and `CaseOperationRuntimeTest.java` run a false condition on Core and show the case database unchanged and a consumer of an unexecuted create not run.

## Leaf constraints (defect 13)

**Today.** Nova writes a `constraint` on seven kinds of case-block leaf: three in `caseOps.ts::buildCaseOperations` (the selected-cases update's fixed text rows, a source-lowered subcase's `create/case_name`, and its fixed text update rows) and four in `caseBlocks.ts::buildCaseBlocks` (the primary `create/case_name`, the primary fixed text update rows, each subcase's `create/case_name` and its fixed text update rows), all through `caseOps.ts::caseScalarTextValueGuard`. None has ever run: a runtime evaluates a constraint only for a question being answered (commcare-core `FormDef.evaluateConstraint`), and a case leaf has no control. Vellum drops the attribute on save, which is the registered difference.

Executed during planning, on today's `case-extension-registration` and `case-capture-multiple` with a 300-character name: Core accepts every answer and submits, and only then refuses the case block ("Invalid <case_name>, value must be 255 characters or less", commcare-core `CaseXmlParserUtil.checkForMaxLength`); HQ refuses it (`CaseValueError`, "Value exceeds allowed length: 255"); Android, on the registration form, walks to the form's end, then shows "Error Saving your Form" with Core's text and quarantines the record. The leaf's constraint stopped nothing on any of them.

**Fix.** Delete the seven `constraint` attributes. Nothing a worker sees changes, on any runtime: the same runs over the same forms without the attribute gave the same results on Core, HQ and Android.

- Authored case operations stay guarded by their live `nova_guard_<operation id>_text` block, which is a calculate.
- Core refuses a case name, external id, type or owner over 255 characters on its own, as above.
- The working guard for basic-action writes arrives with finding 33, on the source question.
- `builder.ts` stops writing `required="true()"` on a source-lowered subcase's name question when that question is a Hidden Value. Executed: Vellum marks `required` on a Hidden Value "Required is not allowed." and a constraint on one "Validation Condition is not allowed.", on both saves.
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

**Nova tests.** Pure, over the emitted DOM: no bind whose node set is under a `case` element carries `constraint`, in the source or in the local archive; a Hidden Value that names a source-lowered subcase carries no `required`. They hold Nova's output only.

**Lane.** Locally: `case-extension-registration` and `case-capture-multiple` through proof 4. CI's full lane shows no `@constraint` difference on any document and the 13 fixed entries held. During planning the lane's proof 4 judged both documents with this pull request's spellings alone: the two leaf-constraint entries documented on each left and nothing was unregistered.

## Datetime leaves (defect 13)

**Today.** `caseOps.ts::buildCaseOperations` gives the bind of a write to a datetime property `type="xsd:dateTime"`, because Core wraps a calculated `Date` as a date alone unless the bind asks for a datetime (commcare-core `Recalculate.wrapData`). Vellum writes a row's bind with `nodeset`, `calculate` and `relevant` only, so a save drops the type and the clock is lost.

**Fix.** One helper, one spelling, for the field sibling and the Save to Case leaf, so step 6's reader recognizes one calculate.

- `datetimeCaseValue.ts` gains `datetimeCaseValueExpression(expression)`, returning `if(E = '', '', format-date(coalesce(E, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`; `datetimeCaseValueCalculate(path)` calls it.
- In `caseOps.ts`, a write to a datetime property takes no `type` and its `calculate` is `datetimeCaseValueExpression(<emitted value>)`.
- Every `@date_modified` bind stays typed: that is Vellum's own spelling.
- Why the expression keeps the instant: `coalesce` returns the unpacked `Date` and `format-date` leaves a `Date` unrounded; without `coalesce` the node set is rounded to midnight.

Executed during planning:

- On Core at the pin, in three device zones, one instant held as a datetime answer printed `2026-01-02T20:15:30.123Z` on a UTC device, `2026-01-03T01:45:30.123+05:30` in Kolkata and `2026-01-02T12:15:30.123-08` in Los Angeles.
- On `case-operation-sequence` and `case-operation-retype` with the leaves spelled this way: two saves keep the calculate and write no type; on Core a `now()` write submits the instant the typed leaf submits today, and on Android it submits the instant with its milliseconds (`2026-10-07T06:41:20.748Z`); HQ's case processing stores the same value before and after the saves.

What changes for a value that is already a string, such as one datetime property copied to another. Today the typed leaf passes a string through byte for byte. From step 2 it is parsed and printed again (each row executed on Core; the stored-string row also on `case-operation-sequence`, where `2026-04-17T14:23:41+03:00` is submitted as `2026-04-17T11:23:41.000Z` and HQ stores the same instant either way):

| Value | Today | From step 2 |
|---|---|---|
| a datetime answer, `now()` | the instant, device offset | the same |
| blank | blank | blank |
| a stored datetime string | unchanged | the same instant re-printed in the device's offset with milliseconds; where the device's local date for that instant differs from the date written in the string, Core's parse places it a whole day wrong (commcare-core `DateUtils.parseTimeAndStore`): `2026-01-03T02:45:30.123+05:30` on a UTC device gives `2026-01-03T21:15:30.123Z` |
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

**Nova tests.** Pure, over the emitted DOM: no bind under `.../case/update/*` or `.../case/create/*` carries `type`. It holds Nova's output only.

**Lane.** Locally: `workforce-case-operation-sequence` and `case-operation-retype` through proofs 3 and 4. CI's full lane shows the same submission text and case blocks before and after both Vellum saves, and the 5 fixed entries held. `proof/native/core/CaseOperationRuntimeTest.java` (the case family, local archive and HQ's regenerated form) gains one form with five writes to datetime properties (a datetime question, `now()`, a stored datetime string with an offset, a blank, a date-only string) and asserts Core's submitted text of each in two device zones, and that the question and `now()` rows equal what the typed leaf submitted before. During planning the lane's proof 4 judged `case-operation-sequence` with this spelling alone and with pull request 7's on top: no datetime entry matched and nothing was unregistered.

## The root create id (defect 13)

**Today.** A create keyed by a form answer (`target: { kind: "new", idFrom }`, `lib/domain/forms.ts::newCaseTargetSchema`) is emitted, at the form root, as a live `<bind nodeset=".../case/@case_id" calculate="...">` (`caseOps.ts::authoredCaseIdCalculation`). Vellum writes a create outside a repeat with its id as an `xforms-ready` setvalue (`saveToCase.js`, `getSetValues`), so a save turns the live calculate into a load-time value, evaluated before the worker answers: the id is blank, and Core and HQ refuse the submission.

**Fix.** The feature stays, at the root as in a repeat. Vellum writes a create's id as a bind when the block is inside a repeat, so a root keyed create's block sits inside a repeat of exactly one row that no worker sees:

```xml
<nova_operations>
  <nova_count_nova_keyed_OP/>
  <nova_keyed_OP jr:template="">
    <OP vellum:role="SaveToCase" vellum:case_type="TYPE">
      <case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="" user_id="">...</case>
    </OP>
  </nova_keyed_OP>
  <nova_guard_OP_text .../>
</nova_operations>
```

with, in the body, inside the `nova_operations` control:

```xml
<group>
  <repeat nodeset="/data/nova_operations/nova_keyed_OP"
          jr:count="/data/nova_operations/nova_count_nova_keyed_OP" jr:noAddRemove="true()"/>
</group>
```

- Binds: `.../nova_count_nova_keyed_OP` `type="xsd:int" calculate="1"`; `.../nova_keyed_OP/OP/case/@case_id` `calculate` `authoredCaseIdCalculation(...)` unchanged, its read of the key question absolute as today; the block's other binds as for any create.
- The row is there before the worker answers anything. `nova_operations` is the first child of `/data` and of the body, so every runtime steps through the group and the repeat on its way to the first question, and a counted repeat's row is made when entry steps onto it (commcare-core `FormEntryModel.createModelIfNecessary`). The bind then follows the key as the worker types.
- A conditional keyed create keeps its Open Case Condition on `<block>/case`, as any conditional create.
- Its guards stand where any root create's stand, outside the repeat, and read the block through `current()`.
- A keyed create that already runs over a repeat is unchanged: it needs no wrapper.
- No validator rule, no builder change, no tool change and no migration: a document's keyed creates mean what they meant, and two submissions with one key still make one case.

Executed during planning, on `case-operation-key` with its root create spelled this way:

- two saves keep the repeat, its count, the block and the `@case_id` bind, write no setvalue for the id, and draw no message; the lane's manifest check and proof 4 judged the form and found no unregistered difference, with all 14 `d13-root-create-id-*` entries and the 14 guard-block entries documented on this document gone;
- Core on HQ's build submits `case_id="nova-case-v1:<operation>:<key>"` and HQ creates that case, before and after the saves; Formplayer submits the same instance as Core; the Web Apps client lays out no box for the group, the repeat or its row; Android creates the same case, shows only the form's own questions, and after an incomplete save and a reopen still writes the keyed id (the saved instance holds the row with a blank id while the key is unanswered, and the keyed id once it is);
- a blank key gives a blank id and the refusal today's form gives, on Core, HQ, Formplayer and Android.

The research decided to withdraw the feature at the root, on the reading that no spelling inside HQ's envelope keeps a live create id there. The runs above show one does, so the feature is kept and nothing is taken from an author or from a deployed app. This reverses that decision and is returned to the person as such.

**Files.**
- Emitters: `lib/commcare/xform/caseOps.ts` (a root create with `idFrom` is wrapped; `attachCaseOperationBody` places the repeat's control), `lib/commcare/xform/generatedNodes.ts` (`keyed`, `keyedCount`).
- Proof harness: `proof/native/core/CaseOperationRuntimeTest.java::exactAuthoredKeysAndBounds` keeps its `key` scenario and its assertions, reading the block at its new path. `repeatedAuthoredKeysDeliberatelyMerge` is unchanged.
- Surface: `lib/commcare/surface/entries/questions.json`, the emission cell of `live-create-case-id` (Nova no longer emits a root create with a live id bind); the root keyed create is now the HELD class `questions/savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside` (a create with an authored id inside a repeat).
- Tests: `lib/commcare/__tests__/caseOperationEmission.test.ts`, the expectations it holds for the `key` scenario.
- Corpus: `lib/commcare/__tests__/caseOperationFixture.ts` is unchanged; the `case-operation-key` document keeps its root keyed create.
- Validator, doc and mutations, Preview, case store, builder, SA and MCP tools, public docs, cutover: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("An `idFrom` answer..." and "A live calculate bind is used even when singular": the one-row repeat and why).

**Stored shape and migration.** None. The block's data path gains the `nova_keyed_` step once; the `data-paths-move-once` line (under "Reserved names and wrapper containers") covers it, and the advisory scan's count of affected forms includes the forms that hold one.

**Register.** 14 entries, `d13-root-create-id-*`: manifest 1 (`live-create-case-id`) and proof 4 13 (the bind and the `xforms-ready` setvalue at `.../case/@case_id` in the saved form and its source, the removed block and its `IllegalCaseId` refusal, five `InvalidStructureException` paths). Control: `case-operation-key`.

**Spelling rule.** None.

**Identity.** The block's data path, once. No case id changes, for cases made before or after. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-key` keeps showing the blank id and the refusal.

**Nova tests.** These hold Nova's own output.
- Pure, over the emitted DOM: a root create with `idFrom` emits the count node, the repeat with its template, the block inside it with its `@case_id` bind and no setvalue, and the repeat's control inside the `nova_operations` control; a root create without `idFrom` keeps its `xforms-ready` setvalue and no repeat; a keyed create in a repeat keeps its bind and gains no wrapper.

**Lane.** Locally: `case-operation-key` through the bar and proofs 3 and 4. CI's full lane shows no `@case_id` difference after either Vellum save and the 14 fixed entries held on the control. `proof/native/core/CaseOperationRuntimeTest.java::exactAuthoredKeysAndBounds` runs each exact key on Core, on the local archive and on HQ's regenerated form: the prefixed id on the block and the right case, and a blank or over-long key refused. The readers the lane does not yet judge carry a test each in this pull request (under "Reader tests this part adds").

## Default values read relatively (defect 13)

**Today.** `builder.ts::buildFieldParts` writes a default as `<setvalue value="/data/...">` with `vellum:value="#form/..."`. Vellum refuses any `#form/` hashtag in a default: "You are referencing a node in this form. This can cause errors in the form" (`mugs/baseSpecs.js`, `defaultValue.validationFunc`, unless the deprecated `VELLUM_DATA_IN_SETVALUE` flag is on). Dropping the shadow alone does not help: Vellum turns an absolute `/data/a` into `#form/a` on load (`parser.js::parseSetValue`).

**Fix.** Every form read in a default is printed relative to the question it sets, as `current()/<relative steps>`, with no `vellum:value`.

- `current()/...` and not a bare `../a`: a default is an authored expression and a read can sit inside a predicate, where a bare relative step would start at the predicate's candidate. `current()` is right in every position and is already the house spelling for correlated reads (`caseOps.ts::originalContextPath`).
- Core evaluates a setvalue in its target's context, and `current()` there is the target (commcare-core `SetValueAction.processAction`), so the relative and absolute spellings name the same node, including inside a repeat row.
- Vellum leaves `current()/..` paths alone and does not track them. Stated in `lib/commcare/CLAUDE.md` and the public docs: renaming the question in HQ's form builder leaves such a read as it was.
- Vellum chooses a default's event itself (`jr-insert` in a repeat, `xforms-ready` outside), which is what Nova already writes.

Executed during planning: on `targeted-load-time-values` with its default spelled `concat('was ', current()/../weight)` and no shadow, two saves, no message, nothing changed. On `case-operation-repeat` with four Hidden Values added, a root default `concat('was ', current()/../r_seed)` gave `was root seed`, and a default in a repeat row reading an answer outside the repeat and a sibling in the row (`concat(current()/../../enabled, '|', current()/../d_seed)`) gave `yes|row seed` in each row, on Core, on Android and (the root one) on Formplayer, before and after two saves that drew no message.

**Files.**
- Emitters: `lib/commcare/xform/formPath.ts` (`relativeXPath` and `originalContextPath` move here from `caseOps.ts`, one implementation for both files); `lib/commcare/hashtags/formContext.ts` (new `expandHashtagsForDefaultValue(expr, ctx, target)`, the walk of `expandHashtagsInContext` with `#form/` resolving to `current()/` plus the relative steps); `lib/commcare/xform/builder.ts::buildFieldParts`; `lib/commcare/xform/caseOps.ts` (imports).
- Proof harness: `proof/checks/manifest_value_classes.py::load_changes_values` reads which form nodes a load-time setvalue reads (`_form_reads`). It resolves an absolute path only, so with the relative spelling it cannot decide and reports three uses under `undecided/load-changes-values` (seen when the lane's manifest check judged the planned `targeted-load-time-values`: `schema:Form.actions`, `schema:FormActions.case_preload`, `schema:PreloadAction.preload`, with defect 28's three entries no longer matching). `_form_reads` gains the setvalue's target and resolves a path that starts at `current()` from it; `proof/checks/test_manifest_value_classes.py` gains the case, paired with an absolute read of the same node. Defect 28's three entries then match as before.
- Docs: `content/docs/building-with-nova.mdx`, one sentence where default values are described.
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools: none. Preview evaluates the AST.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Hashtag form-context".

**Stored shape and migration.** None.

**Register.** 2 entries: `d13-form-defaults-vellum-mug-defaultvalue-error-referencing-node-form` and `d13-form-defaults-vellum-again-mug-defaultvalue-error-referencing-node-form`, proof 4. Control: `targeted-load-time-values`, which also serves defect 28's three live entries on unchanged paths.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-load-time-values`.

**Nova tests.** Pure, over the emitted DOM: a root default, a default in a repeat reading a sibling in the row, one reading an enclosing repeat's answer, and one reading an answer outside the repeat each print the `current()/...` path and carry no `vellum:value`. It holds Nova's output only.

**Lane.** Locally: `targeted-load-time-values` and `expander-form-hashtag-expansion-expands-form-in-default-8a732e08-0` through the manifest check and proof 4. CI's full lane shows no `mug-defaultValue-error` on any document, defect 28's three entries held, and the 2 fixed entries held. `proof/native/core/ExpanderRuntimeTest.java` (local archive and HQ's regenerated form) runs the four placements above on Core and holds each default's value.

## The registration case-id read and reads between case blocks (defect 13)

**Today.** On a registration form `formContext.ts::expandHashtagsInContext` expands `#<own type>/case_id` to `/data/case/@case_id`, the block HQ's build adds and the stored source does not hold, and `caseOps.ts` writes the same path as the parent index of an extension child on a registration form. Vellum finds no question there and warns on every save. Separately, one Save to Case block reads another's id at `<block>/case/@case_id` (`caseOps.ts::emitTarget` for an `op` target, `bindOperationPaths`, the guards), by an absolute path at the form root. That draws no warning today only because the blocks sit under a Hidden Value, which Vellum never re-checks; once `nova_operations` is a group, each such read in a scalar field is an unknown question.

**Fix, in two parts.**

1. **A registration form reads its own new case's id from the session**, in pull request 6:
   - the read is `instance('commcaresession')/session/data/case_id_new_<own type>_0`, the datum HQ's suite and Nova's local suite both give a registration form (`models/forms.py::Form.session_var_for_action`; `suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta`, `function="uuid()"`; `lib/commcare/session.ts`);
   - HQ itself sets `/data/case/@case_id` from that datum (`xform.py::XFormCaseBlock.add_create_block`), so the value is the same on every runtime;
   - `FormHashtagContext` gains `ownNewCaseIdRef`, built by the caller from new `lib/commcare/session.ts::newCaseIdDatumId(caseType)`, which returns `case_id_new_<type>_0` and replaces the three inline spellings of it today (`session.ts::deriveSessionDatums`, `formContext.ts::expandHashtagsForSessionStack`, `xform/caseBlocks.ts`), so the read and the datum cannot drift. The form declares the `commcaresession` instance whenever the read is emitted. `caseOps.ts` uses the same reference for the registration branch of an extension child's parent index.
   - Executed during planning, on `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0` with its calculate reading the datum: two saves, no message, nothing changed; the calculated value equals the create block's `@case_id` on Core, on Formplayer and on Android, and on Android it is still that id after the form was saved incomplete and reopened. On `case-extension-registration` with the children's parent index reading the datum: each child's index names the new parent's id on Core, Formplayer and Android.
2. **One block reads another through `current()`**, in pull request 7 with the group change (it must not trail it):
   - the reads are an `op` target's id, a link to an earlier create, a guard's `ID` and `OK`, and an expression binding from `bindOperationPaths`;
   - each is printed `current()/` followed by one `..` for every step from the bound node up to the nearest ancestor the two share, then the steps down to `<block>/case/@case_id` or the leaf, at the form root exactly as in a repeat row today. `formPath.ts::relativeXPath` computes it;
   - a block's own id is unchanged:

     | Operation | Its own `@case_id` |
     |---|---|
     | create at the root | `<setvalue event="xforms-ready" value="uuid()">` |
     | keyed create at the root | bind in its one-row repeat, `calculate` `authoredCaseIdCalculation(...)` |
     | create in a repeat, no key | bind, `calculate="uuid()"` |
     | keyed create in a repeat | bind, `calculate` `authoredCaseIdCalculation(...)` |
     | update or close | bind, `calculate` today's target expression, with a read of an earlier block through `current()` |

   - no leaf is added, so a submission and HQ's form export hold exactly the blocks;
   - stated in `lib/commcare/CLAUDE.md`: Vellum does not follow a `current()` path, so a person who renames an operation's block in HQ's form builder leaves these reads naming the old block; a Nova publish replaces the form.
   - Rejected: a Hidden Value per shared id that the readers name by absolute path (`nova_caseid_<operation id>`). It was built and run through every reader and works, and it costs a submitted leaf and a form-export column per shared id, an id submitted for a conditional create that did not run, and, at the root, a create whose `xforms-ready` setvalue reads that Hidden Value, a use the manifest's `savetocase-blank-create-id` reader cannot decide (seen as two unregistered uses when the lane judged it).
   - Executed during planning, on the seven operation controls named under "The two structural rules": two saves draw no message and keep each read; Core, Formplayer and Android give every consumer the id its producer wrote (an update, an unlink and a close of a case created by an earlier block in the same form, at the root and per repeat row), and HQ's case processing leaves the cases today's form leaves. The lane's manifest check and proof 4 found no unregistered difference on any of the seven.

**Files.**
- Emitters: `lib/commcare/hashtags/formContext.ts`, `lib/commcare/session.ts` (`newCaseIdDatumId`), `lib/commcare/xform/caseBlocks.ts` (its caller), `lib/commcare/xform/builder.ts::buildXForm` (which builds the `FormHashtagContext`), `lib/commcare/xform/caseOps.ts`, `lib/commcare/xform/formPath.ts`, `lib/commcare/formActions.ts` (the comment at its registration `case_id` handling).
- Domain: none; `lib/domain/caseTypes.ts::caseRefAcceptMap` admits the same reads.
- Doc and mutations, validator, Preview, builder, SA and MCP tools, public docs: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Hashtag form-context" (the registration narrowing) and "Authored case-operation emission" (reads between blocks).

**Stored shape and migration.** None.

**Register.** 2 entries for part 1: `d13-form-defaults-vellum-case-case-id` and `d13-form-defaults-vellum-again-case-case-id`, proof 4 (`logic-bad-path-warning` on `/data/case/@case_id`). Control: `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0`. Part 2 moves none and prevents new ones.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0`.

**Nova tests.** These hold Nova's own output.
- Pure, over the emitted DOM: no expression in any fixture form's source reads `/data/case/@case_id`, and none names a node inside a case block by an absolute path; each row of the table above emits as written; every form that emits the session read declares the `commcaresession` instance.
- Pure: `newCaseIdDatumId(type)` equals the id of the datum `deriveSessionDatums` gives a registration form of that type.

**Lane.** Locally: the `records-no-case-id-load` expander document, `case-extension-registration` and `case-operation-link` through proofs 3 and 4. CI's full lane shows no `logic-bad-path-warning` on any document. `proof/native/core/CaseOperationRuntimeTest.java` and `ExpanderRuntimeTest.java` (local archive and HQ's regenerated form) run on Core a registration form's default, calculate and child index that read the own id against the id the submission's create block carries, and an update that targets an earlier create, and that create's guard, against the id the create wrote. The resumed form is Android's to run (under "Reader tests this part adds").

## Blank translations (defect 13)

**Today.** `lib/domain/translationUnits.ts::localizeTranslationUnit` takes an explicitly empty translation of a label, hint, help text, validation message or option label as current, so `builder.ts`'s `addItext` writes an empty `<value/>` for that language beside a non-blank value in another. Vellum writes every form of every text through `javaRosa/itext.js::ItextForm.getValueOrDefault` on each save, which fills the blank, so the saved form shows text the published form did not.

**Fix.** The emitter and Preview apply Vellum's own fill, so a save changes nothing. No authored translation is deleted.

- The rule, per itext form: a blank value takes the text of `langs[0]` (the app's default language); if that is blank too, the first non-blank value in language order; if every language is blank, it stays blank. After the fill, a value is blank exactly when the form is blank in every language. The fill is symmetric: a blank default-language value beside a translated one is filled from the translation.
- It follows Vellum's rule and not "the source language's text", because Vellum's fill knows nothing of Nova's source language, and the two differ whenever the source is not `langs[0]`.
- Executed during planning, on `localization-optional` with its four blank English values filled from the default language's: two saves, no message, nothing changed, and proof 4 found the document's four blank-translation entries gone.
- **A text blank in every language.** Vellum's save writes no such item and drops the reference to it (`javaRosa/util.js::getItextItemsFromMugs`). What that does differs by role, each executed:
  - a hint, help text, validation message or container label: `addItext` already writes neither the item nor its `ref`. Unchanged.
  - **a leaf question's label**: today Nova writes the empty item and a `<label ref>`. One save removes both, the item and the `<label>` element. So Nova writes neither, which is what the save leaves: on `localization-optional` with one question's label written that way, two saves change nothing, HQ builds it, Core, Formplayer and Android enter and submit it, and the Web Apps client shows the question with no label text. Where the label is blank and the question carries label media, the item keeps its media forms and its empty text and two saves change nothing.
  - **a select option's label**: today Nova writes the empty item and the option's `<label ref>`. One save removes the item and keeps the reference, Vellum marks the option "Display Text (or multimedia) is required.", and HQ's next build fails ("Item <label> '...': text is not localizable for default locale"). No spelling of it works: with the `<label>` left out, Core refuses the form ("<item> without proper <label>"). So Nova refuses it: a select option whose label is blank in every language and that carries no media is a validation error, `SELECT_OPTION_LABEL_EMPTY`, class soundness, beside `SELECT_OPTION_VALUE_INVALID` in `validator/rules/field.ts`. Message: "Option <n> of field "<id>" in "<form>" has no label in any language and no image, audio or video. A worker would see an empty choice, and CommCare HQ's form builder cannot keep one. Give the choice a label, or attach media to it." An option with media and no text is accepted, and two saves change nothing on one (executed, on `expander-select-option-itext-ids-index-keyed-issue-10-608c801a-0`).
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
- Emitters: `lib/commcare/localization.ts`; `lib/commcare/xform/builder.ts` (`addItext` takes the filled templates; its inline blank test becomes `proseTemplateIsEmpty`; a leaf question's label blank in every language and without media writes no `<label>` and no item).
- Validator: `lib/commcare/validator/rules/field.ts` (`selectOptionLabelEmpty`), `validator/errors.ts`, `validator/gate.ts`; `lib/doc/userFacingErrors.ts`.
- Preview: `lib/preview/engine/engineInput.ts`, `lib/preview/hooks/useVisibleFieldOrder.ts`; `components/preview/form/virtual/rows/FieldRow.tsx`, `GroupBracket.tsx`, `SectionHeaderRow.tsx`.
- Builder: `lib/doc/hooks/useLocalization.ts` (`useFilledField`); `components/builder/app-setup/LanguagesSection.tsx`. The option editor shows the new refusal where it shows `SELECT_OPTION_VALUE_INVALID`; no new surface.
- SA and MCP tools: `lib/agent/tools/localization.ts` (`filledFrom` on a unit row); `lib/agent/translation/translateLanguage.ts`: none, it follows `status`. No input schema change, so `npm run test:schema` is not needed. `lib/agent/authoring/reference.ts`, one sentence where choices are described: every choice has a label or media.
- Cutover: `scripts/lib/hqRoundTripCutover/steps/optionLabels.ts`, registered in `transform.ts` as `option-labels`, at the position part 10, The transform steps, in order, gives it beside `option-values`; `lib/notices/migrationNotice.ts` (`DOCUMENT_NOTICE_REASONS` gains `option-label-filled`); `lib/notices/migrationNoticeCopy.ts` (its renderer).
- Docs: `content/docs/languages.mdx`, one sentence (an empty translation shows the default language's text); `content/docs/building-with-nova.mdx`, a clause where choices are described (each choice has a label or media).
- Doc and mutations: none.
- CLAUDE.md: `lib/domain/CLAUDE.md` and `docs/architecture/multilingual-localization.md` (the fill, and that it is Vellum's rule; the two all-blank rules); `lib/commcare/CLAUDE.md`, "Multilingual emission is one derived projection".

**Stored shape and migration.** No schema change. The fill is derived and migrates nothing. The option rule needs one transform step, `option-labels`: each select option whose label is blank in every language and that carries no media gets its own value as its source-language label, so the document passes the new rule and a worker reads something where an empty choice stood. One notice line per option, document reason `option-label-filled` (entity the form, detail the question and the option's value): "<Form>: the choice with the value <value> in <question> had no label, so it now shows its value. Give it the wording you want workers to read." The advisory scan counts such options per app and lists them under `--debug-details` (part 10, Scripts and their layout, under "The report").

**Register.** 5 entries, `d13-blank-translations-*`: manifest 1 (`blank-beside-default-text`) and proof 4 4 (`value/text()` and `value[@form=markdown]/text()` in the saved form and its source). Control: `localization-optional`. The document keeps its blank translations, so `d41-empty-list-text-app-no-items-text`, which also names it, is untouched. No register entry exists for a text blank in every language, because no corpus document holds one; this pull request adds the targeted document `targeted-blank-labels` (a question whose label is blank in every language, one with label media and no text, and a choice with media and no text), which passes every check with no entry.

**Spelling rule.** None; `itext_value_order` still erases Vellum's order.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `localization-optional` keeps showing a blank value beside text.

**Nova tests.** These hold Nova's own code and state model.
- Pure: `filledProse` for a blank target beside a default-language text, a blank default beside a translation, a source language that is not the default, a stale entry, and all blank.
- Pure, over the emitted DOM: no `<text>` has a blank `<value>` beside a non-blank one in another language, for the default and the markdown form; a hint blank in every language emits no item and no `ref`; a leaf label blank in every language emits no `<label>` and no item, and with label media emits its item.
- Pure: the validator refuses an option whose label is blank in every language and that has no media with `SELECT_OPTION_LABEL_EMPTY`, and admits the same option with media and with a label in one language only.
- Pure, state model: `projectLocalizedFields` with `filled: true` gives the filled text, in the source language too, and without it gives the stored blank; `localizeTranslationUnit` gives `missing` with `filledFrom` for a blank entry beside text and today's status for one blank in every language.
- Pure, state model: the coverage counts of `collectTranslationCoverageDiagnostics` count such an entry as missing, and `translateLanguage`'s selection includes it.
- Pure, over the frozen pre-step fixture that witnesses `option-label-filled`: the `option-labels` step's output passes the commit gate and yields one notice line per filled option.
- Playwright (`e2e/`): the Languages workspace shows the Missing badge and the placeholder for a cleared translation, and Preview in that language shows the default language's text.

**Lane.** Locally: `localization-optional`, `localization-stale` and `targeted-blank-labels` through the manifest check and proof 4. CI's full lane shows no itext value difference after either Vellum save, HQ's build passing after both saves of `targeted-blank-labels`, and the 5 fixed entries held.

## The ref-less repeat group (defect 13)

**Today.** `builder.ts::buildRepeatBody` wraps a repeat as `<group ref="<path>"><repeat nodeset="<path>">`. Vellum's `Repeat` writes no `ref` on that group (`mugs/types/group.js`, `writeControlRefAttr: null`), and its parser never reads Nova's, so it comes back as a raw control attribute: kept by a save, and never what the editor writes. The register holds no entry for it.

**Fix.** The wrapper is `<group>` with no `ref`, for every repeat mode, the selected-cases repeat and the keyed repeat included.

Executed during planning, on `targeted-labelled-group-repeat` (a user-controlled repeat), `case-operation-repeat`, `case-operation-query` and `container-query-conditional` (query-bound repeats), `case-capture-multiple` (selected cases) and `case-operation-key` (the keyed repeat), each with the `ref` gone: two saves change nothing in the wrapper, and Core's session reads the same event sequence as from today's form (on `targeted-labelled-group-repeat` the submission differs from today's by the data node's name and version alone). Formplayer and Android ran the query-bound and user-controlled forms to a submission with the wrapper spelled this way.

**Files.**
- Emitters: `lib/commcare/xform/builder.ts::buildRepeatBody` and its comment; goldens under `lib/commcare/__tests__`.
- Everything else: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Repeat modes" (the wrapper's spelling).

**Stored shape and migration.** None.

**Register.** No entry of defect 13. Two step 5 defects read the same control:
- Defect 27 (`targeted-labelled-group-repeat`, 3 entries) stands. Executed: with the `ref` gone Vellum still marks the repeat "Repeat Count is required." on both saves, because the message is about the repeat's place in a Question List (`mugs/types/group.js`, `repeat_count.validationFunc`), which this fix does not touch. Its two proof 4 entries and its manifest entry `d27-labelled-group-repeat-form-xform-repeat-user-repeat-in-a-field-list` stay live on unchanged paths, and Android's refusal to add rows there is unchanged.
- Defect 25's entries (document `container-query-conditional-relative`): as stated under "Shadows", where they gain the classes the build now reaches.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None of its own; `targeted-labelled-group-repeat` for defect 27.

**Nova tests.** Pure, over the emitted DOM: no repeat's wrapper carries `ref`. It holds Nova's output only.

**Lane.** Locally: `targeted-labelled-group-repeat` and `container-nested-query` through proofs 3 and 4. CI's full lane shows no new difference on any repeat document. `proof/native/core/ContainerRuntimeTest.java` runs all three repeat modes on Core on both paths. During planning the lane's manifest check and proof 4 judged `targeted-labelled-group-repeat` with the wrapper spelled this way: defect 27's entries matched and nothing but the form version was unregistered.

## Finding 55: the Connect work area id

**Today.** `builder.ts::buildConnectBlocks` writes a deliver unit's `<deliver>` with `name`, `entity_id` and `entity_name`. Vellum's deliver unit lists `work_area_id` after `entity_name` and writes every child with a bind (`commcareConnect.js`, `mugConfigs.ConnectDeliverUnit.childNodes`, `getBindList`), so a save adds the element and a bare bind.

**Fix.** Emit `<work_area_id/>` after `entity_name`, and `<bind nodeset=".../deliver/work_area_id"/>` with the node set alone, as Vellum writes it. Nova emits no `ConnectWorkAreaUpdate` block; that stays out.

Executed during planning: on the deliver form of `expander-expanddoc-hq-json-projection-sort-elements-85a51a04-0` (its edit) spelled this way, two saves change nothing and draw no message, and Core's submission carries `<work_area_id/>` empty inside the deliver block, byte for byte what the Vellum-saved form of today submits. Connect's receiver, run over exactly that submission (`proof/connect/test_receiver.py::test_connect_reads_the_empty_work_area_id_hqs_form_designer_writes_as_none`), leaves the same visit, payment and task rows as for a submission without the element: it takes the empty id as none (commcare-connect `form_receiver/processor.py::process_deliver_unit`).

**Files.**
- Emitters: `lib/commcare/xform/builder.ts::buildConnectBlocks`; `lib/commcare/__tests__/connectWireFixtures.ts`.
- Proof harness: `proof/connect/test_receiver.py`, the test above turns around. Nova's form now holds the empty element, so the test asserts it there and compares Connect's rows with those of the same submission with the element taken out. `proof/native/core/ConnectRuntimeTest.java` and `proof/native/test_connect_emission.py` read the unit's new child.
- Everything else: none.
- CLAUDE.md: none.

**Stored shape and migration.** None.

**Register.** 3 entries, each marked `equivalence`: `d55-connect-work-area-form`, `-source`, `-trace`, proof 4. Control: `expander-expanddoc-hq-json-projection-sort-elements-85a51a04-0`.

**Spelling rule.** None; `empty_binds` stays (it serves every group).

**Identity.** None; a deliver unit's submission gains an empty element. `proof/identity-moves.json` gains no entry.

**Control.** The control above keeps showing the two spellings differ.

**Nova tests.** Pure, over the emitted DOM: the deliver block's child order and the bare bind. It holds Nova's output only.

**Lane.** Locally: `connect-deliver-default` through proof 4, and `proof/connect`. CI's full lane shows no `work_area_id` difference, the 3 fixed entries held, and Connect's receiver leaving the same rows with and without the element.

## Finding 46 and defect 14's data node name

**Today.** `builder.ts::buildXForm` writes `<h:title>` as `form.name`, the source-language text, and the data node's `name` as a slug of it (`xform/dataRootAttributes.ts::xformDataRootRuntimeAttributes`). Vellum takes HQ's name for the form in the editing language over both and writes it into both on save (`views/formdesigner.py::_get_vellum_core_context`, `'formName': translate(form.name, lang, app.langs)`; `parser.js::parseDataTree`; `writer.js::createXForm`, `createModelHeader`). So a save renames the form's title where the source language is not the default, and replaces the slug on every form.

**Fix.** `<h:title>` and the data node's `name` both carry the form's name in the app's default language, character for character the string Nova writes at `form.name[langs[0]]`. A save in HQ's default editing language then changes neither.

- New `lib/domain/formWireName.ts::formWireName(doc, formUuid)`: the form-name unit localized into `effectiveAppLocalization(doc.localization).defaultLanguage`. One function for the emitter and Preview. HQ JSON's `form.name` is written by `lib/commcare/expander.ts` through `commCareLocalization.textMap`, a different path, and a test holds the two equal.
- `xformDataRootRuntimeAttributes(name)` returns the name as given, with no slug.
- Stated once in `lib/commcare/CLAUDE.md` so nobody reopens it: no spelling survives a save made in another editing language. A person who switched HQ's editing language (`views/utils.py::get_langs` reads the `lang` cookie) gets that language's name written into both, as HQ does to a form made in HQ.

Executed during planning:

- On `localization-bilingual` (default language Spanish, source English) with both set to `Registrar`: two saves in the default editing language change nothing. The same two saves with the editing language switched to English write `Register` into both on the first save.
- On `navigation-base` with a form named `R&D <alpha> "q" 'r'`, a no-break space and `x`, in both places: two saves change nothing, HQ builds it, and Core and Android submit it with that `name`.
- On Android, over HQ's build of `localization-bilingual`: the header a worker sees from home is the menu's own text and reads `Aplicación de salud > Registrar` for today's form and for the planned one. The form's own title and the name a completed save carries (commcare-android `FormEntryInstanceState.getDefaultFormTitle`) follow `<h:title>`: `Register` today, `Registrar` from step 2.

**The form version after a save.** With the name fixed, a save in HQ's form builder can leave a form whose parsed content equals what Nova published. HQ still gives that form a new version at its next build: `models/applications.py::Application.set_form_versions` compares an MD5 of the rendered form's bytes with the previous build's file, and the form builder writes its own layout of the same content. Today the name difference hides this on every form. Seen when the lane's proof 4 judged the planned forms of eight controls whose save now changes nothing else: three classes no entry holds, `form:*@vellum@*` at `/html/head[*]/model[*]/instance[*]/data[*]/@version`, `suite.xml@vellum@*` at `/suite/xform[*]/resource[@id=*]/@version`, and `trace@vellum@*` at `/runs/*/trace/*/submission/data/@version`.

- This pull request makes proof 2's version clause read a form's content as HQ reads it. `proof/checks/compare/versions.py::apply_version_clause` and `proof/checks/proof4.py::content_versions` hold a form's version to the built file's bytes with its data node's `version` value set aside, in place of its parsed tree. Where the bytes differ the version may differ; a version HQ changed over identical bytes stays a difference.
- `proof/checks/test_proof2_build.py` and `test_proof4_editability.py` gain the pair: two builds of a form that differ in layout alone may differ in version, and two with the same bytes may not.
- Emitting the form builder's own layout so the bytes match was rejected: it would bind Nova's serializer to the editor's whitespace and attribute order, release by release.
- Stated in `lib/commcare/CLAUDE.md` and the public docs: the first time a person saves a Nova form in HQ's form builder, the next build gives that form a new version and devices fetch it again; nothing in it differs.

**Files.**
- Domain: new `lib/domain/formWireName.ts`.
- Emitters: `lib/commcare/xform/dataRootAttributes.ts`, `lib/commcare/xform/builder.ts::buildXForm`.
- Preview: `lib/preview/engine/formEngine.ts`, every call of `xformDataRootRuntimeAttributes` passes `formWireName(doc, formUuid)`, so `/data/@name` in Preview matches a device.
- Proof harness: `proof/checks/compare/versions.py`, `proof/checks/proof4.py`, `proof/checks/test_proof2_build.py`, `proof/checks/test_proof4_editability.py`, and `proof/README.md` where the version clause is described.
- Docs: `content/docs/publishing.mdx`, two sentences: each submission's form name in HQ is the form's name; saving a form in CommCare HQ's form builder makes the next build send that form to devices again.
- Doc and mutations, validator, builder, SA and MCP tools: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Secondary instances" ("slugged `name`") and the version note; `lib/preview/CLAUDE.md` where it repeats the slug.

**Stored shape and migration.** None. No per-app notice: nothing in a document changes and the change is the same for every app. From each app's next publish every submission's `@name`, which HQ shows as the form's name, is the form's name where it was a slug; the public docs say so.

**Register.** 6 entries.
- Finding 46, 3: `d46-form-renamed-form-title`, `-source-title`, `-trace-title`, proof 4. Control: `localization-bilingual`.
- Defect 14, data node name, 3: `d14-data-node-name-form-instance-name`, `-source-instance-name`, `-trace-name`, proof 4. Control: `case-operation-query`.

**Spelling rule.** None.

**Identity.** The `name` attribute of every submission, once, from the next publish. `xmlns` is untouched. `proof/identity-moves.json` gains no entry.

**Control.** `localization-bilingual` and `case-operation-query`.

**Nova tests.** These hold Nova's own output and state model.
- Pure, over the emitted DOM: with a source language that is not the default, the title and `name` are the default language's name; a name holding `&`, `<`, a quote and a non-breaking space passes the serializer and the XForm oracle.
- Pure, state model: the form engine's `/data/@name` reads the same string.
- Pure: for every emission fixture, `formWireName(doc, formUuid)` equals the expanded app's `form.name[langs[0]]`, including where the default-language name is missing and falls back to the source text.

**Lane.** Locally: `localization-stale` and `case-operation-query` through proof 4. CI's full lane shows no title, `name` or lone version difference after either Vellum save and the 6 fixed entries held. The Android half is a reader test in this pull request (under "Reader tests this part adds").

## Finding 33: `nova_trimmed` and the source-question guard

**Today.** The local archive binds a basic action's case name and external id through a trim (`caseBlocks.ts::buildCaseBlocks` with `caseOps.ts::caseScalarTextValueCalculation`), while HQ's build of the same actions binds the raw question path (`xform.py::XFormCaseBlock.add_create_block`, `add_case_updates`). So HQ stores `"  proof  "` from a published app where a locally installed one stores `"proof"`, and HQ and Core judge the 255 limit on different strings. The guard beside the trim never ran (see "Leaf constraints"), so a whitespace-only name becomes a case with a blank name on both paths.

**Fix.** The trim lives in a node of the form source that the action names, and the guard on the question the worker answers.

- **The trim.** Every field in `caseScalarTextGuards(doc, formUuid)` (below) gets one sibling Hidden Value, `nova_trimmed_<question id>` (node table, row 5), however many writes read it: each question a basic action reads as a case name or an external id, and each question a source-lowered block (`nova_update_selected_cases`, `nova_subcase_<n>`) reads as one. Keeping the `replace()` trim on the source-lowered leaves was rejected: one rule for both writers means one question has one trim, and a multi-select form or a form whose only writer is a source-lowered subcase gets the node too. Its `relevant` is required: HQ writes the update bind's own relevance as `count(<action path>) > 0` over this node, and Core drops a non-relevant node from a node set, so a hidden answer still leaves the case's stored value alone.
- **The actions name it.** In `formActions.ts::buildFormActions`: `open_case.name_update.question_path`; the primary update map's `case_name` and `external_id`; each subcase's `name_update.question_path` and its `external_id` property. `external_id` itself moves to `update_case.update.external_id` and `open_case.external_id` is `null` (defect 14's equivalent spellings, same pull request). `case_preload` keeps naming the question.
- **HQ's editors produce and keep this.** The Case Management tab offers Hidden Values as the source of a name and of any property (`static/app_manager/js/case_config_utils.js::getQuestions`), and HQ's build validates action paths against a list that includes every data node without a control (`xform.py::XForm.get_questions`; `helpers/validators.py::check_paths`).
- **The local archive binds as HQ's build does.** `caseBlocks.ts` binds the four leaves to the action's path with no trim of its own. `nova_update_selected_cases` and `nova_subcase_<n>` in `caseOps.ts` read the question's `nova_trimmed_` node, which the rule above guarantees exists, and drop their own `replace()` wrapper. `caseScalarTextValueCalculation` stays for authored operations, whose values are expressions.
- **`required`.** HQ's build stamps `required="true()"` on the path a create's name action names, which is now the Hidden Value, where it is inert; the local archive mirrors that stamp so the two paths agree. What keeps a name required of the worker is the source: for every create-name question that is not a Hidden Value, `builder.ts` writes `required="true()"` as the `required` attribute of the question's own bind. It replaces an authored required condition there, which is what HQ's build did to that bind before (`xform.py::XForm.add_bind` merges onto the existing bind). No second bind is written: the `requiredNamePaths` loop in `builder.ts`, which today sets the attribute for source-lowered names and appends a separate bind where it finds none, covers basic-action create names too; where the question has no bind yet, the bind it appends is that question's one bind.
- **The guard.** A visible source question's constraint gains the check, conjoined as `(<authored validation>) and (<guard>)`, or alone where the author wrote none: for a case name, `string-length(replace(., <pattern>, '')) > 0 and string-length(replace(., <pattern>, '')) <= 255`; for an external id, the length half alone.
- **No message of its own.** Where the author wrote a validation message it shows for either failure; where there is none the runtime shows its own text. Nova has no source for a message in every app language, and inventing one would be content the author did not write. The texts, as run: the Web Apps client shows "This answer is outside the allowed range." under the question; Android shows "Sorry, this response is invalid!" for an over-long name and, because its text widget hands a whitespace-only entry on as no answer, "Sorry, this response is required!" for that one.
- **A Hidden Value source takes no constraint**: Vellum marks one "Validation Condition is not allowed." (executed), and no runtime checks it. For it an over-long value stays an atomic refusal when the form is processed, by Core and by HQ (`corehq/form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy._validate_length`), the same on both paths as today.
- **The set of guarded questions** is one derived fact: new `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards(doc, formUuid)`, a map from field uuid to `"reject"` (case name) or `"allow"` (external id), over `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`'s primary, child-create, update and source-lowered writers. The emitter and Preview's form engine both read it, so Preview refuses the answer at the question as a device does.
- Dropping the trim from the local archive instead was rejected: HQ would hold padded text on both paths while a device holds trimmed text, and `lib/domain/caseScalarText.ts`'s contract (one value for Core, HQ, Preview and Postgres) would be false for every published app.

Executed during planning, on the registration form of `navigation-base` with both Hidden Values, the two action slots naming them, `external_id` in the update map, and the guard and `required` on the name question:

- HQ's build accepts it, binds `create/case_name` to `/data/nova_trimmed_name`, stamps `required="true()"` on that node, and writes `update/external_id` with `relevant="count(/data/nova_trimmed_external) > 0"`.
- Two Vellum saves change nothing and draw no message. HQ's Case Management page is given both Hidden Values in its question list, and two saves of it store the same actions.
- Core submits a padded name with `<case_name>proof</case_name>` and HQ stores the name and the external id trimmed, where today's form on HQ's build stores both padded.
- A whitespace-only name and a 300-character name are refused at the question: by Core (the answer's result is `constraint`, with no text), by Formplayer (`validation-error`, type `constraint`), in the Web Apps client and on Android with the texts above. Formplayer refuses a 300-character external id the same way.
- Android's text widget trims what a worker types before it answers, so a typed padded name reaches the form already trimmed there; the Hidden Value still matters for a default or calculated name.

**Files.**
- Domain: new `lib/domain/caseScalarTextGuard.ts`.
- Emitters: `lib/commcare/xform/generatedNodes.ts` (`trimmed`), `lib/commcare/xform/builder.ts::buildFieldParts`, `lib/commcare/formActions.ts::buildFormActions` (a branch in `projectPrimaryUpdateMap`'s path resolver beside the datetime and capture branches), `lib/commcare/xform/caseBlocks.ts::buildCaseBlocks`, `lib/commcare/xform/caseOps.ts`.
- Preview: `lib/preview/engine/formEngine.ts` validates an answer against the conjoined expression, reading `caseScalarTextGuards`.
- Cutover: `scripts/lib/hqRoundTripCutover/behavior.ts` (the selection function for `case-name-now-checked`), `lib/notices/migrationNotice.ts` (`DOCUMENT_NOTICE_REASONS` gains it), `lib/notices/migrationNoticeCopy.ts` (its renderer, with part 10's copy).
- Proof harness: `proof/checks/compare/names.py` already reads `nova_trimmed_` from the rename pull request.
- Surface: `lib/commcare/surface/entries/forms-and-case-writes.json`, the emission cells for name and external id writes.
- Docs: `content/docs/building-with-nova.mdx`, a clause where the record name is described (a blank or over-long name is refused at the question, with the app's own validation message where the question has one and CommCare's otherwise).
- Doc and mutations, validator, builder, SA and MCP tools: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-management scaffolding emission": the case-create and case-update bullets and the sibling nodes); `lib/domain/CLAUDE.md` (the `caseScalarText.ts` sentence says where the trim and the guard live); `lib/preview/CLAUDE.md` (its trim-boundary paragraph).

**Stored shape and migration.** No document change and no step: the model does not change. `behavior.ts` returns one `case-name-now-checked` record per form with a basic create or rename whose case name comes from a visible question, the question a worker answers, entity the form with the question in `detail`; its copy is part 10's (part 10, Work item F: the migration notice). A form whose name comes from a Hidden Value gets no record, because that source takes no guard. The new leaf is covered by the `data-paths-move-once` line, which pull request 7 already writes for every deployment. Visible effects, stated in the public docs: each such form gains one Hidden Value per name or external id question, shown in HQ's form builder, as the name's source in Case Management, in submissions and as a form-export column; names and external ids HQ stores from the next build are trimmed; a worker sees an invalid-answer message on a whitespace-only or over-long name where none showed before.

**Register.** 16 entries, `d33-trimmed-*`, all proof 3: `case_blocks@local.ccz` (10: create `case_name` at six block paths (`*~1case`, `*~1item~1case`, `*~1item~1subcase_*~1case`, `*~1subcase_*~1case`, `case`, `subcase_*~1case`), update `case_name`, update `external_id`, the stored `cases/*/name` and `cases/*/external_id`) and `trace@local.ccz` (6, the matching submission texts). Controls: `case-extension-registration` (5), `navigation-base` (3), `case-capture-followup` (2), `case-capture-query` (2), `case-capture-repeat` (2), `case-extension-query` (1), `case-extension-repeat` (1). Defects 23 and 24 are read from this pull request's run on the `-after-13` controls: the new `nova_trimmed_` sibling and the changed binds can move their paths. Where a path moved, the entry is re-pathed from the run and that control retained again in place, which is allowed because no fixed entry names it.

**Spelling rule.** None.

**Identity.** None moves; a leaf appears. `proof/identity-moves.json` gains no entry.

**Control.** The seven controls keep showing trimmed against raw on their pre-fix archives.

**Nova tests.** These hold Nova's own output and state model.
- Pure, over the emitted DOM and the HQ JSON: each action slot names the Hidden Value; the leaf binds read the action's path and carry no trim; the Hidden Value's bind carries the calculate and the `count(...) > 0` relevance; a name collision takes the suffix; a visible name question carries `required` and the conjoined constraint, and a Hidden Value source carries neither; a name question with an authored required condition carries `required="true()"` on its one bind; a multi-select form and a form whose only name writer is a source-lowered subcase each emit the `nova_trimmed_` node their block reads.
- Pure: `caseScalarTextGuards` over a form with a create name, a rename, an external id, a child name in a repeat and a Hidden Value source.
- Pure, state model (`lib/preview/engine`): a whitespace-only name and a 256-character name are refused at the question, and the accepted padded answer stores the trimmed name.
- Pure, over the frozen pre-step fixture that witnesses `case-name-now-checked`: the `behavior.ts` selection function returns one record for a form whose create or rename reads a visible question, with the form as entity and the question in `detail`, and none for a form whose name source is a Hidden Value or that writes no case name.

**Lane.** Locally: `case-capture-repeat`, `case-extension-registration` and `case-operation-relevance` through proofs 3 and 4. CI's full lane shows the same case blocks and stored cases from HQ's build and the local archive on every document (proof 3), the Hidden Value kept by a Case Management save and both Vellum saves (proof 4), and the 16 fixed entries held. `proof/native/core/CaseOperationRuntimeTest.java` (the case family, local archive and HQ's regenerated form) runs on Core a padded name stored trimmed, a hidden name question leaving the case's name untouched, and a whitespace-only and a 256-character name refused at the question. During planning the lane's manifest check and proof 4 judged the planned registration form: nothing but the form version was unregistered. The message a worker reads is the readers' to show (under "Reader tests this part adds").

## Finding 37: case block order on the local path

**Today.** `caseBlocks.ts::buildCaseBlocks` pushes the form's own `<case>` before its subcases, so the local data node reads fields, `case`, `subcase_0..n`, `commcare_usercase`, `meta`. HQ's build appends each non-repeat subcase inside its loop and the form's own block after it (`xform.py::XForm._create_casexml`), giving fields, `subcase_0..n`, `case`, `commcare_usercase`, `meta`. Core applies blocks in document order and gives new records storage ids in that order (commcare-core `XmlFormRecordProcessor.process`, `CaseXmlParser.parse`), so new cases reach a device's storage in opposite orders on the two paths.

**Fix.** The local archive takes HQ's order, because HQ's is the one Nova cannot change.

- `buildCaseBlocks` pushes the form's own `<case>` after the subcase loop and before the usercase block. Its binds stay where they are.
- **The repeat item position.** HQ inserts a single repeat subcase's block as the first child of the repeat item (`subcase_node.insert(0, subcase_block.elem)`); with several, each `subcase_<n>` wrapper is appended. `CaseBlockChild` gains `position: "first" | "last"`: a repeat subcase that is not nested in a wrapper takes `"first"`, everything else `"last"`, and `addCaseBlocks` prepends the first kind with `xform/domSplice.ts::prependChildren`. This also covers a repeat item that holds Save to Case blocks, where HQ's block stands before them.
- HQ's order is the one every runtime already runs from every published app, child blocks before their parent's create included.

Executed during planning, on HQ's build: the built form of `case-extension-registration` reads fields, the Save to Case container, `subcase_0`, `subcase_1`, `subcase_2`, `case`, `meta`; the built repeat item of `case-extension-repeat`, with several subcases, has its `subcase_<n>` wrappers appended after the fields. Core, Formplayer and Android each submitted that registration form, and Core, HQ and Android each created the parent and every child with its index to the parent, the children's blocks standing before the parent's create. The single repeat subcase standing first is what `proof/rules/test_case_block_position.py` builds on HQ today.

**Files.**
- Emitters: `lib/commcare/xform/caseBlocks.ts`.
- Everything else: none. `lib/doc/caseOperationOrder.ts` treats the primary write and the subcase parent index as final implicit consumers and does not order them against each other.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Case-management scaffolding emission" and "Repeat-context subcase splice + nest decision" (the data-node order and the item position, citing `_create_casexml`).

**Stored shape and migration.** None.

**Register.** 2 entries: `d37-case-order-trace-order-d1aa` and `d37-case-order-trace-order-cb3c`, proof 3 on `trace@local.ccz`. Control: `case-extension-registration`. Defect 24's five proof 3 paths read where a subcase block sits on the two paths; if this fix moves them, the controls defect 24 names (`case-extension-registration-after-13`, `case-extension-query-after-13`, `case-extension-repeat-after-13`) are retained again in place from this pull request's corpus and those paths rewritten from the run. No fixed entry names those directories, so retaining them again is allowed.

**Spelling rule.** `proof/rules/case_block_position.py` retires, with `test_case_block_position.py`, its import and `RULES` line in `proof/rules/__init__.py`. The rule erased exactly Nova's former item position.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `case-extension-registration` keeps showing the opposite orders. The retained archives of the repeat controls show the old item position as a difference no entry holds, which a control tolerates.

**Nova tests.** Pure, over the emitted DOM (`caseBlocks.test.ts`, `extensionCaseEmission.test.ts`, `repeatContextSubcase.test.ts`): the data node's child order (fields, subcases, own case, usercase) and the item's first child, for a single repeat subcase and for one beside a Save to Case block. They hold Nova's output only; that it is HQ's order is proof 3's to show.

**Lane.** Locally: `case-extension-registration`, `nested-menu-registration-children` and `case-capture-repeat` through proof 3, with `case_block_position` deleted. CI's full lane passes without the rule, shows no `order()` difference between the local archive and HQ's build on any document, and holds the 2 fixed entries. `proof/native/test_case_emission.py` compares the child order of the local data node with HQ's regenerated one.

## Finding 66: update properties in name order on the local path

**Today.** HQ's build writes the children of a case block's `<update>`, and their binds, sorted by property name (`xform.py::XFormCaseBlock.add_case_updates`: `for key, q_path in sorted(update_mapping.items())`, after renaming the action key `name` to `case_name`), for the form's own case, each subcase and the worker's own record alike, and its `<attachment>` children the same way (`sorted(attachments.items())`). `lib/commcare/xform/caseBlocks.ts::buildCaseBlocks` writes them in the order the form's actions list them (the `updateMappings` array: the external id first, then `update_case.update`'s entries in insertion order), and its attachment writes in the same order. Observed in the lane's served states: Formplayer hands back a form's instance with the same properties and values in another order on the two paths (`formplayer@local.ccz`, proof 3, `/runs/*/steps/*/response/instanceXml/output/data/case[*]/update[*]/order()`, on `workforce-case-operation-sequence` and `case-operation-sequence`).

*Harm:* none found. HQ's case processing and Core apply each property of an update by its name, and no update names a property twice. It is a difference between the two export paths that Core's sessions did not show, and the lane holds it as one.

**Fix.** The local archive takes HQ's order, because HQ's is the one Nova cannot change, as finding 37 does for the blocks themselves.

- `buildCaseBlocks` sorts each block's scalar writes by wire property name before it writes the `<update>` children and their binds, and its attachment writes by property name before it writes the `<attachment>` children and their binds. One comparator serves every block the file writes: the form's own case, each subcase and `commcare_usercase`.
- The comparator is a code-unit comparison of the wire names (`a < b`), never `localeCompare`: Python's `sorted` over `str` keys orders by code point, and every wire property name matches `lib/domain/casePropertyName.ts`'s ASCII grammar, where code unit and code point order agree.
- The source-lowered blocks under `nova_operations` (`nova_update_selected_cases`, `nova_subcase_<n>`) are Save to Case blocks in the form's source, which HQ's build does not rewrite; their order is the one Vellum keeps (part 05, Save to Case facts the emitter follows) and does not change.

**Files.**
- Emitters: `lib/commcare/xform/caseBlocks.ts`.
- Everything else: none.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Case-management scaffolding emission" (an update's properties and an attachment's children are written in name order, as `XFormCaseBlock.add_case_updates` writes them).

**Stored shape and migration.** None. No notice: no worker, export or person sees the order.

**Register.** One entry the lane's branch added moves to `proof/fixed-defects.json` in pull request 9: `d66-update-property-order-formplayer-local-ccz-case-update-order` (proof 3, artifact `formplayer@local.ccz`, part "update property order"), control `workforce-case-operation-sequence`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `workforce-case-operation-sequence` keeps its pre-fix archive and keeps showing the order.

**Nova tests.** Pure, over the emitted DOM (`lib/commcare/__tests__/caseBlocks.test.ts`): a registration form whose writes are listed `zeta`, `external_id`, `alpha`, `case_name` emits `<update>` children and binds `alpha`, `case_name`, `external_id`, `zeta`, for the form's case, a subcase and the worker's record; two attachment writes are emitted in name order; an uppercase name sorts before a lowercase one, as code points do.

**Lane.** Locally `npm run proof -- proof/checks -k "workforce-case-operation-sequence or case-operation-sequence"` and `-k control-workforce-case-operation-sequence`. CI's full lane shows no `update[*]/order()` difference between `formplayer@local.ccz` and `formplayer@A` on any document, Core's sessions unchanged, and the fixed entry held on its control. `proof/native/test_case_emission.py` compares the child order of the local `<update>` with HQ's regenerated one. Pull request 9, with finding 37.

## Reader tests this part adds

Proofs 3 and 4 judge Core's sessions and HQ's own code. Formplayer, the Web Apps client, Android and Connect each run in a package of their own (`proof/formplayer`, `proof/webapps`, `proof/android`, `proof/connect`), and no check judges their sessions yet. So each harm of this part that lands on one of them carries a test in that package, in the pull request that makes the change. Every one of them was run by hand during planning, on the forms named, and showed what is written here. Each package's `DOCUMENTS` list gains the documents its test names.

| Pull request | Package and test | Documents | What it must show |
|---|---|---|---|
| 6 | `proof/android`, registration id | `expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0` | The calculated value equals the create block's `@case_id` in the saved instance, on a form completed in one go and on one saved incomplete at its first screen and reopened |
| 6 | `proof/android`, form name | `localization-bilingual` | The header from home is the same text as before the change; the form's title and a completed save's name are the default-language name |
| 6 | `proof/android`, predicate self read | `container-query-conditional` | The dependent answer is accepted when the count matches and refused with "Sorry, this response is invalid!" when it does not |
| 6 | `proof/connect/test_receiver.py`, the work area test | `connect-deliver-default` | Under "Finding 55" |
| 7 | `proof/formplayer/test_case_blocks.py` (new) | `case-operation-conditional`, `case-operation-key`, `case-operation-query`, `case-operation-sequence`, `case-capture-multiple`, `case-extension-registration` | For one script with each condition true and one with it false, Formplayer's submitted instance equals Core's with ids and the clock marked, and HQ's case processing of it leaves the same cases; a failing guard makes Formplayer refuse the submission |
| 7 | `proof/webapps/test_generated_groups.py` (new) | `case-operation-conditional`, `case-operation-key`, `case-operation-query`, `case-operation-sequence`, `case-capture-multiple` (two cases ticked, then Continue) | The client lays out no box for any `nova_operations` or `nova_condition_` group, the keyed repeat or its row (each has no client rectangle), before and after a condition turns true; the form's visible text is its questions' labels and Submit |
| 7 | `proof/android`, case operations | `case-operation-conditional`, `case-operation-key`, `case-operation-query`, `case-operation-repeat`, `case-operation-sequence`, `case-operation-retype` | Entered to its end and completed: the saved instance holds every block in order with the condition true and an empty create with it false; the device's cases after Android's own processing are the ones Core's hold; a keyed root create writes its keyed id, also after an incomplete save and a reopen; a failing guard ends in "Error Saving your Form" and a quarantined record; only the form's own questions are screens |
| 9 | `proof/formplayer/test_case_name_guard.py` (new) | `navigation-base` | A whitespace-only and a 256-character name are answered `validation-error` of type `constraint`; a padded name is submitted trimmed in the case block |
| 9 | `proof/webapps/test_case_name_guard.py` (new) | `navigation-base` | Typing a whitespace-only name shows the client's own invalid-answer text under the question and sends nothing to HQ |
| 9 | `proof/android`, name guard | `navigation-base` | A whitespace-only name is held with "Sorry, this response is required!", an over-long one with "Sorry, this response is invalid!"; an accepted name creates the case with the trimmed name |

The Android reader gains one request for these, `complete`: a form entered through home to its last screen with given answers, completed as its Finish does (`FormEntryActivity.triggerUserFormComplete`), the saved instance read back, the device's cases after Android's own form processing, each screen's questions with any warning Android shows on them, and, on request, an incomplete save at a named screen reopened from its record and then completed. It drives `FormEntryActivity` as the reader's `app` request does and copies nothing of commcare-android. Part 09 owns where these packages run in CI.

## Contract statements this part leaves behind

When the plan leaves `docs/plans/`, these stay in `lib/commcare/CLAUDE.md`:

- Nova reserves no question names for its own nodes; the names it refuses are the ones HQ's form builder cannot keep (defect 15, finding 43). Generated nodes are `nova_<purpose>...` from `planGeneratedNodes`, with the collision rule above.
- The two structural rules, and the Save to Case table.
- No expression names a node inside a case block by an absolute path: one block reads another through `current()`, and HQ's form builder does not follow such a read when a person renames a block.
- A root create keyed by an answer sits in a one-row repeat, because the form builder writes a create's id as a live bind only inside a repeat.
- Shadows carry `#form/` only; no form source holds a `#case/` hashtag or a head hashtag element. `case_references_data.load` keeps HQ's `#case/` strings, which HQ's app summary reads (`app_schemas/app_case_metadata.py`) and Vellum does not. A predicate's own node is printed `./.` outside a validation condition.
- A leaf of a case block carries no `type` and no `constraint`.
- Itext values follow Vellum's fill; a leaf label blank in every language has no `<label>`; a choice has a label or media; `<h:title>` and the data node's `name` are the default-language form name.
- A save in HQ's form builder that changes nothing still gives the form a new version at the next build.
- The local archive's case blocks stand where HQ's build puts them, and write an update's properties and an attachment's children in name order, as HQ's build does.
