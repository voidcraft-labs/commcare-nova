# Step 5, part 01: Case writes as one concept

Part of [step 5's plan](../5-case-writes-forms-navigation.md) ("Case writes, forms and navigation").
This part holds the case-write model: defect 22 (a form's case writes are its case operations, and
a field's "Saves to" is that field's view of them), defect 23 (attachment mode removed; a captured
file reaches a case only as a link write), defect 28's preload half (a preload is an explicit
default value that reads the case), and defect 12's model side (the predicate that finds a basic
child case of its own menu's case type). It fixes the stored shapes (the form's own case as one
operation arm, the write with `via` and `onlyIfChanged`, the worker's record as a target, the
`capture-link` term, open and close conditions as `Expression`s, and the placement shapes), the
one placement procedure `lib/commcare/placement.ts::planPlacements` with every eligibility
condition, the held placements and the gate rule `HELD_PLACEMENT_INEXPRESSIBLE`, and the planner
`lib/doc/placementMoves.ts` that feeds the one identity-move statement, with the two pure planners
the cutover and the fuzz mapping share (`lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites`
and `lib/doc/explicitPreloads.ts::planExplicitPreloads`, §16.6). How each placement is written on
the wire (`lib/commcare/casePlacementPlan.ts::planFormCaseWire`), advanced modules and the held
module kind are part 02's; step 5 stores no case selection list on a form (§3.4); who records a
hold and when, the kernel rule and the publish stops are part 03's; the
builder, SA and MCP surfaces are part 07's; the register, corpus and lane are part 08's; the one
cutover is part 09's. §29 names the interface each of them reads from this one.

Citations are `path::symbol` for Nova at `main` `2f985ed6` (#825, step 4's fifteen pull requests
merged and its cutover run), and `file::symbol` for CommCare at these pins:
commcare-hq `d6c6e16d8ae1` (paths relative to `corehq/apps/app_manager/` unless rooted at
`corehq/`), commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, formplayer
`24383ac71bfb`, commcare-connect `046c7fd78081` (the commits `proof/pins.json` names), and Vellum
`01215f251c57`, the build HQ vendors at its pin
(`corehq/apps/app_manager/static/app_manager/js/vellum/version.txt`). Every CommCare fact below was read at its pin while this part was planned (§25). At
`main`, `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v5-hq-round-trip-platforms.12"` and
`lib/db/appTests.ts::RUNTIME_VERSION` is `17`.

Pull request numbers are the stack's ([`../5-case-writes-forms-navigation.md`](../5-case-writes-forms-navigation.md)):
1 lane mechanics, 2 attachment mode removed, 3 repeats, 4 case writes as one concept, 5 held
placements and identity moves, 6 publish placements, 7 advanced modules and extension child cases,
8 CommTrack and same-type child links at publish, 9 groups and labels, 10 search and menus, 11 form
links, 12 builder, 13 agent, 14 cutover, 15 contracts and public docs, 16 removal of the cutover
tooling. Parts are named by file number: part 02 advanced and extension, part 03 publish and ledger,
part 04 questions, part 05 search and menus, part 06 form links, part 07 authoring, part 08 proof,
part 09 cutover, part 10 the stack and contracts. "Resolution N" names the step plan's numbered
resolutions between its parts.

## Decisions in brief

1. **One stored concept.** `Field.caseWrite` leaves the document in pull request 4. A form writes
   case data only through `Form.caseOperations`; a field's "Saves to" is a derived view of the
   writes whose value is a bare read of that field or a link to its captured file
   (`lib/domain/caseWriteViews.ts::fieldCaseWriteViews`), computed from the reference index and
   never stored. Reason: two stored concepts that must agree are defect 22 itself; deriving
   operations from field writes keeps it, and storing both needs a sync.
2. **The form's own case is one operation arm, `action: "own"`,** first in `caseOperations` on
   every registration, follow-up and close form of a module with a case type, and on no other
   form. It stores no case type and no action: its type is the module's, and its lifecycle is
   `Form.type` with `Form.openCondition` and `Form.closeCondition` (§5). Reason: the operation
   sequence is already the execution-order and dependency model; a second home for the own case
   would need a second order analysis, and an `action` on the arm would be a second spelling of
   `Form.type`.
3. **The own arm's effects are independent of every other operation's.** No other operation
   writes a property the own arm writes on the form's own case, retypes it while the own arm
   writes, or closes it; on a registration, an operation that updates or closes the case the form
   creates keeps the own arm out of Case Management (§5.3). Under those rules the own arm means the
   same wherever its block runs, so its first position in the array and Case Management's block,
   which HQ appends after every other, cannot disagree. Reason: today the ordinary form action
   runs last on the wire and the validator treats it as the final consumer; the rules keep that
   truth while the own arm stands first.
4. **Open and close conditions are `Expression`s** (`Form.openCondition` on registration forms,
   `Form.closeCondition` on registration and close forms). A comparison with a select whose
   choices are written in the form holds a `choice` leaf, so an option's value edit reprints it
   and the option editor's who-reads-this-choice refusal covers it. A registration closes the case
   it creates exactly when `closeCondition` is present; a close form closes always when it is
   absent. Departure from the outline (§27).
5. **Writes gain `via` and `onlyIfChanged`; a write's identity in its operation is
   `(via, property)`.** `via` saves to an ancestor of the case a follow-up or close form loads;
   `onlyIfChanged` saves only an answer that differs from the case's value when the form opened.
   Both are facets of Case Management's update rows, so only the own arm in the basic own slot
   holds them (and, from pull request 7, an advanced load); every other operation saves to another
   case by targeting it (§7, §8).
6. **A captured file reaches a case only through the term `capture-link {field}`,** the HQ address
   of the file the capture question submitted, admitted only as the whole value of a write.
   Attachment mode, the `case-attachments` capability and its `MM_CASE_PROPERTIES` probe leave in
   pull request 2, before the model change.
7. **The worker's record is a target, `{kind: "worker-record"}`,** of at most one `update` of
   `commcare-user` per form.
8. **Placements are stored shapes** (`lib/domain/placements.ts::casePlacementSchema`): a basic
   form action slot (own, usercase, subcase by index, or the one subcase of a repeat row), an
   advanced action and its tag (shape here, emission in part 02), or a Save to Case block path.
   A held placement is stored on each operation (`placement`) and on the form for its own close
   when that close cannot share the own arm's place (`Form.ownClosePlacement`,
   `ownClosePlacementSchema`). Absent means not held. Both slots land with the operation model in
   pull request 4, and `planPlacements` reads a hold first from then; every mutation payload
   omits them, so only `holdPlacements` (pull request 5) writes one, and before it only test
   fixtures and specs do. No authoring surface writes one.
9. **One placement procedure.** `lib/commcare/placement.ts::planPlacements(doc, formUuid,
   options?)` gives every subject of a form its placement, held first, then the simplest eligible
   in array order, by a closed list of eligibility conditions (§12). Every emitter (through part
   02's `planFormCaseWire`), the privilege derivation, the publish recorder, the move planner, the
   builder's placement lines and the tools read it.
10. **A held placement is kept until an edit makes it inexpressible,** and then only by an
    explicit move in the same batch: `HELD_PLACEMENT_INEXPRESSIBLE` refuses any other batch on
    every editor from pull request 5 (§13). `lib/doc/placementMoves.ts::planOperationPlacementMoves`
    writes the moves for operations and the own close as `holdPlacements` entries and hands them to
    `lib/doc/identityMoves.ts::withIdentityMoves` (resolutions 3 and 4). Undo and redo restore a
    hold only as part 03's kernel rule admits it (§14).
11. **A preload is a default value.** `default_value` holding the `form-case` read of the written
    property. Planners add it when a writer of the own case is born on a one-case follow-up or
    close form; Nova never writes a basic `case_preload` again; Preview runs every default in its
    place (§11). Defect 28's three register entries move in pull request 4.
12. **`onlyIfChanged` asks a capability at publish,** `save-only-edited-answers`, proven by the
    project-space probe through `SAVE_ONLY_EDITED_FORM_FIELDS` (§8).
13. **Defect 12 has no validator rule.** `lib/commcare/sameTypeChildCases.ts::sameTypeBasicChildCases`
    finds every basic child create of its own menu's case type; publish asks the capability
    `same-type-child-links` from it and offers the move to Save to Case (part 03, resolution 8).
    Until pull request 8 lands that capability, such a create takes Save to Case (§15).
14. **No new mutation kind but `holdPlacements`** (part 03's envelope, resolution 4, pull request
    5). Every other change rides `updateForm`, `updateModule`, `updateField` and the case-operation
    change and patch payloads, whose shapes §16 gives.

## 1. What Nova does today

### 1.1 Two stored concepts

- **`Field.caseWrite`** (`lib/domain/fields/base.ts::caseWriteSchema`, `{caseType, property}`) on
  every input kind through `inputFieldBaseSchema`, and on the five capture kinds as
  `captureCaseWriteSchema` (`{caseType, property, mode}`, `mode` in
  `CAPTURE_CASE_WRITE_MODES = ["url", "attachment"]`), read through
  `lib/domain/caseTypes.ts::fieldCaseWrite`.
- **`Form.caseOperations`** (`lib/domain/forms.ts::caseOperationSchema`), an action-discriminated
  union `create | update | close` with `uuid`, `id`, `caseType`, `target` (`new {idFrom?}`,
  `op {opUuid}`, `session`, `expression {expr}`), `condition?`, `forEach? {repeat}`,
  `writes? [{property, value, condition?}]`, and per arm `name`, `owner`, `rename`, `retype`,
  `links? [{identifier, targetType, target | null, relationship: child | extension}]`. Array
  position is execution order (`orderedCaseOperations`).
- **`Form.type`** (`FORM_TYPES`: registration, followup, close, survey) and **`Form.closeCondition`**
  `{field: Uuid, answer: string, operator?: "=" | "selected"}` (`forms.ts::closeConditionSchema`),
  admitted only on close forms (`lib/commcare/validator/rules/form.ts`, `CLOSE_CONDITION_WRONG_TYPE`,
  `CLOSE_CONDITION_INCOMPLETE`, `CLOSE_CONDITION_FIELD_NOT_FOUND`, all soundness in
  `lib/commcare/validator/gate.ts`). The reference slot `close_condition_field`
  (`lib/domain/referenceSlots.ts`) carries the field's uuid. No open condition exists.

### 1.2 How field writes become case actions

`lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory` walks the form tree and buckets each
writer: `primary` (the module's type), `child` (an exact declared direct child, keyed by
`(caseType, nearest repeat UUID)`), `usercase` (`commcare-user`, declared worker properties).
`lib/commcare/caseWriteFindings.ts::caseWriteAdmissionFindings` renders its issues as
`CASE_WRITE_NO_CASE_ACTION`, `CASE_WRITE_UNKNOWN_TYPE`, `CASE_WRITE_NOT_DIRECT_CHILD`,
`USERCASE_WRITE_UNDECLARED_PROPERTY`, `USERCASE_WRITE_MANAGED_PROPERTY`, `USERCASE_FIELD_IN_REPEAT`,
`RESERVED_CASE_PROPERTY`, `CAPTURE_CASE_WRITE_STANDARD_PROPERTY`, `PRIMARY_CASE_FIELD_IN_REPEAT`,
`CASE_WRITE_DUPLICATE_PROPERTY`, `CASE_CREATE_NAME_DUPLICATE` and `CASE_CREATE_NAME_MISSING`.
`lib/commcare/caseWriteAdmission.ts::assertAndProjectCaseWriteInventory`,
`lib/commcare/deriveCaseConfig.ts::deriveCaseConfig` and
`lib/commcare/formActions.ts::buildFormActions` write HQ's basic `FormActions`: `open_case` with the
`nova_trimmed_<q>` name sibling, `update_case.update` (always `update_mode: always`), `case_preload`
(every non-capture primary writer on a one-case loading form), `close_case`, `subcases` (one per
child bucket, `condition: always`, `close_condition: never`, `reference_id: ""`) and
`usercase_update`. A several-case form writes its primary writers as Save to Case blocks in the
selected-cases iteration (`formActions.ts::buildPrimaryCaseUpdateMap`).
`lib/commcare/subcaseWire.ts::hqCaseActions` marks extension subcases `never` (defect 24, part 02).

Every authored operation lowers to a Save to Case block in the form source
(`lib/commcare/xform/caseOps.ts`), named by `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`:
the root `nova_operations` group is prepended before the authored fields, a repeat's is appended
after the repeat's authored children, each block is named by its operation's `id`, a conditional
update or close stands in `nova_condition_<op>`, and a create keyed by an answer at the root stands
in `nova_keyed_<op>`. So any app with an operation needs the `save_to_case` plan privilege
(`lib/commcare/planPrivileges.ts`, through `caseOps.ts::formEmitsSaveToCase`). HQ appends its basic
blocks after the authored tree (§2.1), so today every operation runs before the ordinary form
action, and the order analysis treats the ordinary action as the final consumer
(`lib/doc/caseOperationOrder.ts::ordinaryFormActionsRequireSessionType`,
`lib/commcare/CLAUDE.md`, "Authored case-operation emission").

### 1.3 Where a close is written

`lib/domain/closeCondition.ts::closeConditionPlacement` derives `form-action` or `save-to-case` on
every read and stores nothing. Its five rules: the question is a single or multi select, Hidden
Value or label; it stands in no repeat; the answer holds no `'`; it neither starts nor ends with
`"`; a select with written choices holds the answer among them. `save-to-case` writes `nova_close`
inside `nova_condition_close` (`caseOps.ts`, the close branch) and `close_case.condition` `never`.

### 1.4 The implicit preload

`lib/domain/casePreload.ts::writerPreloadsFromLoadedCase(field, module, form)`: a scalar writer of
the module's own type, on a follow-up or close form of a one-case module (`formOpensWithOneCase`),
never a capture. Its readers: the builder's field editors
(`components/builder/editor/fields/{caseWritePresentation.ts, CaseOptionsEditor.tsx,
HiddenValueEditor.tsx, PreloadedValueRow.tsx, hiddenValueModel.ts}`,
`components/builder/editor/fieldEditorSchemas.ts`), `lib/domain/expression/inference.ts`,
`lib/domain/formRecordScope.ts`, `lib/commcare/validator/rules/selectPreloadWriterOptions.ts`,
`lib/doc/datetimeSplit.ts`, `lib/agent/authoring/{fieldBehavior,operationSemantics,formRecordContext}.ts`,
`lib/agent/formAnswerWrites.ts`, `lib/agent/tools/{addFields,editField}.ts` (`hiddenWriterBlankNote`)
and `lib/preview/engine/formEngine.ts` (`shouldPreloadPrimaryCase`, `seededWriters`,
`primaryCaseWritesByField`, the preload pass after defaults). The emitted XForm carries HQ's
`case_preload` setvalues after every other setvalue, so the loaded value beats an authored default
(`lib/commcare/CLAUDE.md`, the case-preload bullet). Its header's sentence "Inside a repeat, the
running form seeds only the first instance" describes a shape no valid document reaches
(`PRIMARY_CASE_FIELD_IN_REPEAT`).

### 1.5 Attachment mode

`mode: "attachment"` names the upload question as the update's `question_path`
(`formActions.ts::caseUpdateQuestionPath`, and the same branch in `caseOps.ts`), so HQ writes an
`<attachment>` block. It derives the capability `case-attachments`
(`lib/commcare/projectSpaceCompatibility.ts::HQ_PRIVATE_FEATURE_FLAG_SYMBOLS["case-attachments"] =
"MM_CASE_PROPERTIES"`, copy "Attachments saved to cases" in
`lib/publish/projectSpaceCompatibility.ts::PROJECT_SPACE_CAPABILITIES`). `mode: "url"` writes the
sibling `nova_url_<question>` (`xform/captureUrlNode.ts::captureUrlNodePath`,
`captureUrlCalculate`), withheld when the export has no deployment target
(`lib/publish/exportAdvisories.ts`). The builder offers both (`CaseWriteEditor.tsx`, "What reaches
the case"); the SA and MCP field schema carries `mode`
(`lib/agent/toolSchemaGenerator.ts::caseWriteToolSchema`, `gateCaseWriteMode`).

### 1.6 Mutations and the index

A field's destination rides `updateField {patch: {caseWrite}}`. Operations ride
`updateForm.caseOperationChange` (`add`, `remove`) and `updateForm.caseOperationPatch` (`update` by
`targetAction`, `add-write`, `update-write`, `remove-write`, `move-write` keyed by `property`,
`add-link`, `update-link`, `remove-link`, `move-link`, `move`)
(`lib/doc/types.ts::caseOperationPatchSchemaFor`), planned in `lib/doc/caseOperationMutations.ts`
and ordered by `lib/doc/caseOperationOrder.ts`. `closeCondition` rides `updateForm.patch`. The
reference index registers each field's `caseWrite` (`case_write_case_type`, `case_write_property`)
and every operation slot, a write's member keyed `{operationUuid, property}`
(`lib/domain/referenceSlots.ts`). `lib/doc/scaffolds.ts::formScaffoldMutations` gives a new
registration form a first field with `caseWrite: {caseType, property: "case_name"}`.

### 1.7 The register today

`proof/known-defects.json` holds 271 entries. Defect 23, part "attachment-mode capture", holds 79:
5 `manifest`, 2 `intent`, 72 `proof4` (on the documents `case-capture-followup`,
`case-capture-registration`, `case-capture-multiple` and the six `case-extension-*`; controls
`case-capture-followup`, `case-capture-multiple-after-3`, `case-capture-multiple-after-13`, and the
`case-extension-*-after-13` controls). Defect 28, part "load-time values", holds 3 `manifest`
entries on `targeted-load-time-values`, its own control. Defects 12 and 22 have no entry: 12's
input was unproducible (`proof/targeted/__tests__/unproducedInputs.test.ts`, first bullet;
`lib/commcare/__tests__/compilerEvidence.ts` asserts no same-type subcase), and 22 is a model
defect no export shows.

## 2. What CommCare does at the pins

| Fact | Source |
|---|---|
| A multi-select module turns off default case management unless the form opens a case; a module that loads a data-registry case turns it off too | `xform.py::XForm._create_casexml`, `default_case_management` |
| An `open_case` writes its block with the open condition as the whole `case` element's `relevant` | `xform.py::XFormCaseBlock.add_create_block`, the `case` bind |
| `action_relevance`: `always` is `true()`; `if` with `selected` is `selected({path}, '{answer}')`, `boolean_true` is `{path}`, otherwise `{path} = '{answer}'`, the answer interpolated unescaped; anything else is `false()` | `xform.py::XForm.action_relevance` |
| A save of the Case Management page strips `"` and `'` from both ends of the open and close conditions' answers, not from a subcase's | `views/forms.py::edit_form_actions`, `condition.answer.strip('"\'')` |
| The condition picker offers single and multi selects, Hidden Values and labels; the own case allows no repeat question, a subcase any repeat question; a select's answer is a dropdown of its options | `templates/app_manager/partials/forms/case_config_ko_templates.html` (`case-config:condition`), `static/app_manager/js/case_config_utils.js::getQuestions`, `static/app_manager/js/forms/case_config_ui.js` (`allow.repeats`) |
| The property picker offers every question but labels; an upload only under `MM_CASE_PROPERTIES`; a property question in a repeat other than the transaction's is "Inside the wrong repeat!" | `case_config_utils.js::getQuestions`, `case_config_ui.js` (property `validate`) |
| Each basic subcase writes `subcase_<i>` (`i` its index in `subcases`, `OpenSubCaseAction.form_element_name` over `IndexedSchema.id`); in a repeat it nests only when that repeat context holds more than one subcase, otherwise its block is the row's first child at `<repeat>/case`; outside a repeat its id is the session datum `case_id_new_<type>_<i>` (`+1` when the form opens its case), inside one `uuid()` | `xform.py::_create_casexml` (subcase loop, `nest`), `models/form_actions.py::FormActions.count_subcases_per_repeat_context`, `models/forms.py::Form.session_var_for_action` |
| A subcase's type must be some module's case type of the app | `xform.py::_create_casexml`, `case_type_exists`, `CaseError` |
| The subcase's parent index is written only when the form has its own case block and either `DONT_INDEX_SAME_CASETYPE` is off for the domain or the subcase's type differs from the form's | `xform.py::_create_casexml`, `index_same_casetype` |
| The own `case` block is appended to the data root after the subcase loop; the usercase block `commcare_usercase` after it | `xform.py::_create_casexml`, `_add_usercase` |
| HQ appends case preloads as `xforms-ready` setvalues after every setvalue already in the source | `xform.py::XForm.add_case_preloads`, `add_setvalue` |
| With `save_only_if_edited`, an update row whose `update_mode` is `edit` gets `relevant="count(path) > 0 and <casedb>/case[@case_id=…]/<key> != path"`; `save_only_if_edited` is `SAVE_ONLY_EDITED_FORM_FIELDS.enabled(domain, NAMESPACE_DOMAIN)`; it applies to the own block, subcases and the usercase block alike | `xform.py::XFormCaseBlock.add_case_updates`, `XForm.__init__` (`save_only_if_edited`), `_add_usercase` |
| `SAVE_ONLY_EDITED_FORM_FIELDS` is a domain-namespaced `FeatureRelease`; `DONT_INDEX_SAME_CASETYPE` and `MM_CASE_PROPERTIES` are domain-namespaced `StaticToggle`s | `corehq/toggles/__init__.py` |
| The Case Management page maps `update_mode: edit` to its checkbox and back on save, whatever the toggle | `case_config_utils.js::propertyDictToArray`, `propertyMultiDictToArray`, the save at `update_mode: updateMode` |
| An update whose path is an upload question goes to `<attachment>`, and case processing applies attachments only where `MM_CASE_PROPERTIES` is on | `xform.py::XFormCaseBlock.is_attachment`, `corehq/form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy._apply_attachments_action` |
| Vellum's Save to Case block has no "save only if edited" setting and refuses to create, close or link `commcare-user` | `Vellum/src/saveToCase.js` (`'commcare-user' cases can only be updated, not created, closed, or linked`) |
| An advanced open action in a repeat nests at `case_<tag>` only when that repeat holds more than one indexed open action | `xform.py::_create_casexml_advanced`, `get_action_path`; `models/form_actions.py::AdvancedFormActions.count_subcases_per_repeat_context` |

Claims the pins refine:

1. **A child's condition question.** The research says a child case in a repeat may use that
   repeat's questions for its condition; HQ's subcase picker offers every repeat question. Nova's
   eligibility keeps the narrower rule (the child's own repeat or none), because an absolute path
   to another repeat's question in a bind under this repeat is a read of several nodes; step 6's
   import reads the wider set and judges it. Gated run G3 (§26) confirms the per-row behavior.
2. **Quote stripping** strips both quote kinds from the own case's answers; the rule "neither
   starts nor ends with `"`" is complete only with "holds no `'`", which the research states too.
3. **`DONT_INDEX_SAME_CASETYPE` reaches registration forms too**: the own case block exists there,
   so a same-type basic subcase of a registration loses its parent index as well.
4. **The basic subcase in a repeat moves with its siblings.** Not in the research: whether a
   repeat's subcase is written at `<repeat>/case` or `<repeat>/subcase_<i>/case` depends on how
   many basic subcases that repeat holds, so the placement shape records it (§3.7).

## 3. The stored shapes

### 3.1 Fields lose their destination

From pull request 2, the five capture kinds take the ordinary `caseWriteSchema` and
`captureCaseWriteSchema`, `CAPTURE_CASE_WRITE_MODES`, `CaptureCaseWriteMode` and `CaptureCaseWrite`
are deleted (`lib/domain/fields/base.ts`, `fields/{image,audio,video,signature,file}.ts`,
`fields/index.ts`): a capture's destination saves a link to its file, and nothing else can.

From pull request 4, `caseWrite` leaves `inputFieldBaseSchema`, `fields/hidden.ts` and the capture
kinds, and `caseWriteSchema`, `CaseWrite` and `caseTypes.ts::fieldCaseWrite` are deleted. Every
reader of a field's destination reads `fieldCaseWriteViews` (§4).

### 3.2 The operation union gains the own arm

```ts
// lib/domain/forms.ts
export const CASE_OPERATION_ACTIONS = ["own", "create", "update", "close"] as const;

const ownCaseOperationSchema = z.strictObject({
	uuid: uuidSchema,
	id: z.string(),
	action: z.literal("own"),
	/** Registration: the new case's name (CASE_CREATE_NAME_MISSING without it).
	 *  Follow-up and close: a rename of the case the form loaded. */
	name: valueSchema.optional(),
	owner: valueSchema.optional(),
	writes: z.array(caseOperationWriteSchema).optional(),
	links: z.array(caseOperationLinkSchema).optional(),
	placement: casePlacementSchema.optional(),          // the held slot; no payload carries it
	caseType: z.never().optional(),
	target: z.never().optional(),
	condition: z.never().optional(),
	forEach: z.never().optional(),
	rename: z.never().optional(),
	retype: z.never().optional(),
});
```

`caseOperationSchema` becomes the discriminated union of `own`, `create`, `update` and `close`;
in the same pull request (4) every arm gains `placement: casePlacementSchema.optional()`, the held
slot, which every mutation payload's arm schema omits (§16.1). The read model
`CaseOperation` becomes a union whose `own` member has no `caseType` and no `target`; the readers
that today read `operation.caseType` read `operationCaseType(doc, formUuid, operation)` (new in
`lib/domain/forms.ts`: the module's case type for `own`, else the stored one) and
`operationTarget(operation)` (`{kind: "session"}` for `own` on a loading form, `{kind: "new"}` on a
registration). The arm's `id` is the module's case type at birth, made unique among the form's
operation ids by `lib/domain/caseOperationIdentifiers.ts`; it names the arm's Save to Case block
when it has one.

### 3.3 The write

```ts
// lib/domain/forms.ts
export const caseWriteViaSchema = z.tuple([relationStepSchema], relationStepSchema);
export const caseOperationWriteSchema = z.strictObject({
	property: authoredCasePropertyNameSchema,
	value: valueSchema,
	condition: conditionSchema.optional(),
	via: caseWriteViaSchema.optional(),
	onlyIfChanged: z.literal(true).optional(),
});
export const caseWriteKeySchema = z.strictObject({
	property: authoredCasePropertyNameSchema,
	via: caseWriteViaSchema.optional(),
});
export type CaseWriteKey = z.infer<typeof caseWriteKeySchema>;
export function caseWriteKeyOf(write: CaseOperationWrite): CaseWriteKey;
export function sameCaseWriteKey(a: CaseWriteKey, b: CaseWriteKey): boolean;
```

`relationStepSchema` is the one `prop.via` uses (`lib/domain/expression/types.ts`,
`{identifier, throughCaseType?}`), and a write's destination type resolves as a `prop` read's
`ancestor` arm does (`lib/domain/expression/relationDestination.ts`). Two writes of one key in one
operation are `CASE_WRITE_DUPLICATE_PROPERTY`.

### 3.4 Targets

`caseTargetSchema` gains `{kind: z.literal("worker-record")}`, admitted only as the target of an
`update` whose `caseType` is `commcare-user` (§9). `RESERVED_CASE_OPERATION_TYPES` keeps refusing
`commcare-user` everywhere else.

No `selection` target exists in step 5, and a form stores no case selection list: a module is
advanced exactly when its kind is held or one of its forms holds an advanced-placed operation (in
step 5 only a carried create's open action, defect 24), and an advanced form's chain case is
targeted by an `expression` target that is exactly the session datum of its selection (part 02
§3.4). Stored case selections (several selected cases per form, auto-selection, computed datums)
are step 7's, because no Nova document needs them before an imported advanced form.

A case type keeps one `parent_type` in the catalog in step 5. A `create`'s links keep `main`'s rule:
a link's `targetType` is any declared case type (`lib/commcare/validator/rules/caseOperations.ts`),
checked against its target's type (`lib/doc/caseOperationOrder.ts`) and never against the created
type's `parent_type`, so a `create` of
`X` may already link `parent` or `host` to a case of a type other than `X`'s catalog parent. That
create's placement follows §12.2 alone: the basic subcase when its one link is a `parent` link of
relationship `child` to the form's own case, else Save to Case or, from pull request 7, an advanced
open action. The catalog's `parent_type` decides only two things here: the field view's new-child
destination (§16.3, "a declared direct child type") and every walk through an index, which
resolves a step through it (a `prop` read's `ancestor` arm, a write's `via` with reason
`unresolved` in §7, the case store's ancestor walk). A child type declared under more than one
parent, read and written through each, is step 7's (§27, departure 20), because no step 5
document needs it. `placement.test.ts` holds the pair: a `create` whose one `parent` link targets
the own case while `X`'s catalog parent names another type takes the basic subcase, and the same
create linked to a case other than the own case takes Save to Case with `subcase-link`.

### 3.5 The form

```ts
// lib/domain/forms.ts, formSchema
openCondition: conditionSchema.optional(),     // registration only (OPEN_CONDITION_WRONG_TYPE)
closeCondition: conditionSchema.optional(),    // registration and close (CLOSE_CONDITION_WRONG_TYPE)
ownClosePlacement: ownClosePlacementSchema.optional(),     // the held slot; no payload carries it
```

`closeConditionSchema` (`{field, answer, operator}`) is deleted. `match-all` (`true()`) as an open
condition, or as a close form's close condition, is not stored: the `updateForm` reducer stores
either as absent, so "every time" has one spelling per form type; on a registration `match-all` is
the stored "close every time" and absent is "never close".

### 3.6 The `capture-link` term

```ts
// lib/domain/expression/types.ts
export const captureLinkTermSchema = z.strictObject({
	kind: z.literal("capture-link"),
	field: uuidSchema,
});
```

`Term` and `termSchema` gain it. Its type is `text`. It is admitted only as the whole value of a
`writes[].value` in a profile with form answers, naming a capture-kind field of the form; anywhere
else the checker refuses it (§17). Form text spells it `capture-link(#form/photo)`: the authoring
grammar `lib/commcare/xpath/grammar.lezer.grammar` gains the call, `expressionAst.ts` binds it, and
the printer prints it back. It reaches the reference index as a read of its field.

### 3.7 The placement shapes

```ts
// lib/domain/placements.ts (new)
export const advancedTagSchema = z.string().regex(XML_ELEMENT_NAME_PATTERN);
const xmlNameSchema = z.string().regex(XML_ELEMENT_NAME_PATTERN);

export const basicPlacementSchema = z.discriminatedUnion("slot", [
	z.strictObject({ kind: z.literal("basic"), slot: z.literal("own") }),
	z.strictObject({ kind: z.literal("basic"), slot: z.literal("usercase") }),
	/** `subcases[index]`, written at `subcase_<index>`: at the data root, or in a
	 *  repeat that holds more than one basic subcase. */
	z.strictObject({
		kind: z.literal("basic"),
		slot: z.literal("subcase"),
		index: z.number().int().nonnegative(),
	}),
	/** The one basic subcase of its repeat, written at the row's `case`. Its
	 *  index in `subcases` reaches no path, so it holds none. */
	z.strictObject({ kind: z.literal("basic"), slot: z.literal("subcase-row") }),
]);

/** Pull request 7 (part 02 emits it). `row`: written at the row's `case`: its
 *  repeat holds fewer than two indexed open actions. */
export const advancedPlacementSchema = z.strictObject({
	kind: z.literal("advanced"),
	tag: advancedTagSchema,
	row: z.literal(true).optional(),
});

export const saveToCasePlacementSchema = z.strictObject({
	kind: z.literal("save-to-case"),
	/** The `forEach` repeat the block was placed in; absent at the form root. */
	repeat: uuidSchema.optional(),
	/** Element names from that scope (the form root, or the repeat's row) to the
	 *  element that carries `vellum:role="SaveToCase"`, every segment. */
	path: z.tuple([xmlNameSchema], xmlNameSchema),
});

export const casePlacementSchema = z.union([
	basicPlacementSchema,
	advancedPlacementSchema,           // joins in pull request 7
	saveToCasePlacementSchema,
]);
export type CasePlacement = z.infer<typeof casePlacementSchema>;
export type SaveToCasePlacement = z.infer<typeof saveToCasePlacementSchema>;

/** The own close runs once per form, at the root (a close in a repeat is the
 *  cutover's blocker `own-close-in-repeat`), so its block holds no `repeat`. */
export const ownClosePlacementSchema = saveToCasePlacementSchema.omit({ repeat: true });
export type OwnClosePlacement = z.infer<typeof ownClosePlacementSchema>;
```

`advancedTagSchema` holds no `/` (the inventory row "a load or open action's `case_tag` containing
`/`" is refused). The basic and Save to Case arms, `ownClosePlacementSchema` and the two held slots
land in pull request 4; `Module.heldKind`, the module-kind target of `holdPlacements` and the
`advanced` arm land in pull request 7 with the emission that can write them (part 02). Who writes
a held placement: a `publish-placement` change (part 03, from pull request 6), a move publish
offers and the person accepts (part 03), an identity move (§14, from pull request 5), import (step
6), and the cutover (part 09). In pull request 4 only test fixtures and specs write one (part 08's
case-writes witness holds what the cutover writes). No tool schema and no builder control carries
one.

## 4. The field's view

```ts
// lib/domain/caseWriteViews.ts (new, pull request 4)
export type FieldCaseWriteSlot = "name" | "owner" | "write";
export type FieldCaseWriteDestination = "own" | "ancestor" | "child" | "worker-record" | "other";
export interface FieldCaseWriteView {
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly slot: FieldCaseWriteSlot;
	/** The case type the write lands on: `via`'s destination when present. */
	readonly caseType: string;
	/** `case_name` for the name slot, `owner_id` for the owner slot. */
	readonly property: string;
	readonly via?: CaseWriteVia;
	readonly onlyIfChanged: boolean;
	/** The value is `capture-link`, not a bare read. */
	readonly link: boolean;
	readonly destination: FieldCaseWriteDestination;
}
export function fieldCaseWriteViews(doc: BlueprintDoc, fieldUuid: Uuid): readonly FieldCaseWriteView[];
export function formCaseWriteViews(doc: BlueprintDoc, formUuid: Uuid): ReadonlyMap<Uuid, readonly FieldCaseWriteView[]>;
```

A write is in a field's view exactly when its value (an operation's `name`, its `owner`, or a
`writes[].value`) is `{kind: "term", term: {kind: "field", uuid}}` with no `filters` and no `role`,
in any spelling, or `{kind: "term", term: {kind: "capture-link", field: uuid}}`. `destination` is
`own` for the own arm without `via`, `ancestor` for any write with `via`, `child` for a `create`
whose links are exactly one `parent` link of relationship `child` or `extension` to the own case,
`worker-record` for the worker-record target, and `other` for anything else. The view is read from
the reference index (`referencingCarrierUuids` for the field, filtered to the operation `name`,
`owner` and write-value slots), never a form walk; views come in operation order, then slot order
(`name`, `owner`, writes in array order). `lib/domain/casePreload.ts::caseWriteDestinationClass`
(and its type `CaseWriteDestinationClass`) is replaced by `destination`.

## 5. The own arm

### 5.1 Lifecycle

- **Registration**: creates the case under `openCondition` (absent: every submission), with
  `name` (required), `owner`, `writes` and `links`; closes it under `closeCondition` when present.
  Other operations name the case it creates as `{kind: "op", opUuid: <own uuid>}` or
  `id-of {opUuid: <own uuid>}`; the session datum read `{kind: "new-case"}` keeps reading the same
  id, so expressions that spell it so are unchanged.
- **Follow-up**: updates the case the form loaded: `name` renames it, `owner` reassigns it, writes
  save, `links` add indices.
- **Close**: updates it as a follow-up does, then closes it under `closeCondition` (absent: every
  submission).

### 5.2 Exactly one, first, only where it belongs

Rule `CASE_OWN_OPERATION` (soundness, located at the form, `details.reason`):

| Reason | When |
|---|---|
| `missing` | a registration, follow-up or close form of a module with a case type has no `own` arm |
| `duplicate` | a form holds two `own` arms |
| `position` | the `own` arm is not at index 0 |
| `form-type` | an `own` arm on a survey form, or on a form of a module without a case type |

Planners never produce any of them: `formScaffoldMutations`, `addForm`, the form-type change planner
(§16.4) and the module case-type change planner add or remove the arm in the batch that needs it,
and `move` refuses to move the arm or move another operation before it ("This form's case is always
the first change."). `removeCaseOperation` refuses the arm ("This form's own case goes only with its
form's type."). The move planners of `lib/doc/caseOperationMutations.ts`
(`moveCaseOperationMutation`, `moveCaseOperationAfterMutation`) carry that refusal as the reason
`own-first`, beside `operation-not-found`, `execution-order` and `dependent-reference`, so part 07's
move verdicts and keyboard refusal read one reason for a move of the own arm or of another
operation above it.

### 5.3 Why its position is safe: the own case is independent

The own arm stands first, and Case Management's block runs it after every other operation (HQ
appends the `case` block after the authored tree and every subcase, §2). Today the ordinary action
runs last too, and the validator proves it as the final consumer. From pull request 4 the gate
holds these rules, so the own arm's effects mean the same at either end:

1. **No other operation writes what the own arm writes on the own case.** Another operation whose
   target is the form's own case (`session` on a loading form, `op` naming the own arm on a
   registration) may not write a property the own arm writes, write `case_name` or rename it when
   the own arm has `name`, or set `owner` when the own arm has `owner`:
   `CASE_WRITE_DUPLICATE_PROPERTY` reason `own-case` (§17). A write through `via` counts on the
   case `via` reaches; an `expression` target is not proven the same and keeps today's runtime
   descriptor check.
2. **No other operation retypes the own case while the own arm writes it.** The rolling type proof
   keeps the own arm in today's role of final consumer: a retype of the own case by another
   operation, where the own arm has a name, owner or write, is `CASE_OPERATION_TARGET_TYPE_MISMATCH`
   as today, with the subject "this form's own case" in place of "ordinary form action's session
   target".
3. **No other operation closes the own case.** The own close is `closeCondition`
   (`CASE_OPERATION_CLOSES_OWN_CASE`, §17; the cutover's class C9 migrates the stored shape first,
   below).
4. **On a registration, an operation that updates or closes the case the form creates keeps the
   own arm out of Case Management.** Such an update would stand before the case's create on the
   wire, so the basic own slot is ineligible (`case-changed-before-create`, §12.2) and the own arm
   takes Save to Case, first in the root `nova_operations` group, where it runs first. Links from
   other operations to the case it creates stay eligible: an index names the id, which exists from
   the moment the form opens (`case_id_new_<type>_0`), and HQ's own basic subcases index the own
   case from blocks that stand before it. Gated run G1 holds that reading on Core.

Reads of the own case in other operations' expressions are evaluated against the case as the form
loaded it, so they are order-independent. Preview applies operations in array order (§19), which
these rules make the wire's meaning.

Rules 1 and 3 refuse shapes `main` admits: an operation on a follow-up's selected case that writes
a property a field also writes to it, and a `close` operation on a follow-up's selected case. Today
the ordinary action runs last on the wire, so the field's value is what every platform keeps, and
the close runs before the ordinary update. Both rules land in pull request 4, and the cutover
migrates each stored shape before the head's gate reads it (§22):

- **Rule 3's shape is stored in production** (the planning scan found follow-up forms whose case
  operation closes the form's own case), so class C9 has work at the window. It is part 09's rule
  (part 09 §7.4): the form becomes a close form whose `closeCondition` is the `or` of the close it
  already had and each such operation's condition (any absent term makes the whole absent); each
  such operation without writes is removed; each with writes becomes an `update` of the session
  case with the same `uuid`, `id`, `condition` and writes, so its Save to Case block keeps its path
  and its writes keep their condition; in a published app the own close is held
  (`Form.ownClosePlacement`) at the path the first removed operation had, so its block stays where
  HQ holds it, and where every such operation carried writes the own close takes its simplest
  placement unheld and the deployment's line names the cause `own-close-moved`. Such an operation
  under `forEach` is the blocker `own-close-in-repeat`, because its close ran once per row, which
  no close condition states.
- **Rule 1's shape was not counted by the planning scan.** Class C10 ships either way, and the
  cutover's advisory dry run counts what it meets: where it meets the shape, C10 removes the other
  operation's write of that property, which changes nothing a worker or HQ sees, because the
  ordinary action's write already replaced it on every platform; where it meets none, C10 writes
  nothing and stays the transform's guard.
- **Update operations targeting the own case** (stored in production) stay operations: rule 1
  refuses only a write the own arm also makes, which C10 removes, and an `update` that writes
  anything else means the same at either end.

### 5.4 Form type changes

`lib/doc/formTypeMutations.ts::planFormTypeChange(doc, formUuid, type, options?: {nameField?: Uuid})`
(new) is the only planner of `updateForm {patch: {type}}`:

| From → to | What the batch also does |
|---|---|
| survey → registration | adds the own arm at index 0, `name` the bare read of `options.nameField`; without one it refuses "Choose the question that names the new case." |
| survey → follow-up or close | adds the own arm with no writes |
| registration, follow-up or close → survey | removes the own arm (its writes and its hold go with it), `openCondition` and `closeCondition`; §14's planner clears `ownClosePlacement` |
| registration → follow-up or close | keeps the arm; clears `openCondition` and, on follow-up, `closeCondition`; on close, keeps a `closeCondition` that is not `match-all` and drops a `match-all` one |
| follow-up or close → registration | keeps the arm; a write with `via` or `onlyIfChanged` refuses "A new case has no earlier value or case above it. Remove Save only if changed and any save to a case above it first."; a missing `name` refuses as survey → registration does; drops `closeCondition` |
| follow-up ↔ close | keeps the arm; close → follow-up drops `closeCondition`, and §14's planner clears `ownClosePlacement` |

### 5.5 Module case type changes and form moves

The own arm stores no case type, so its writes follow the module's. The module case-type change
planner (the callers of `lib/doc/scaffolds.ts::caseTypeSetPatch`) and a cross-module `moveForm`
planner declare each property the moved or retyped own arms write on the new type in the same
batch (`addCaseProperty`, as `declareCaseTypeMutations` declares a type), so the gesture lands
valid. A module whose case type is cleared turns its forms into surveys first through
`planFormTypeChange`. Whether a held placement survives either move is decided by the eligibility
conditions alone (§12.2), never by the move itself.

## 6. Open and close conditions

- **Slots.** `lib/domain/referenceSlots.ts` gains `form_open_condition` (path `openCondition`,
  `formTypes: ["registration"]`) and `form_close_condition` (path `closeCondition`, `formTypes:
  ["registration", "close"]`), both `kind: "expression"`, profile form logic with form answers, read
  once at submission; `close_condition_field` is deleted. A finding inside either is
  `CASE_OPERATION_EXPRESSION_TYPE` at path `openCondition` or `closeCondition`.
- **Admission.** `CLOSE_CONDITION_WRONG_TYPE` admits registration and close forms; the new
  `OPEN_CONDITION_WRONG_TYPE` admits registration only. `CLOSE_CONDITION_INCOMPLETE` and
  `CLOSE_CONDITION_FIELD_NOT_FOUND` retire: an `Expression` has no incomplete state, and a dangling
  field read is the checker's.
- **Choices.** The parser already binds a literal opposite a select whose choices are inline to a
  `choice` leaf when it names an option (`lib/commcare/xpath/expressionAst.ts`, the comparison
  binder); the conditions take that path, so `lib/doc/optionRemoval.ts::optionRemovalBlocker`
  refuses removing an option a condition reads, and an option value edit reprints it.
- **Deleted.** `lib/domain/closeCondition.ts`, `lib/doc/expressionText.ts::resolveCloseFieldRef`
  and `lib/doc/hooks/useCloseConditionPlacement.ts`. Its rules become the stateable condition
  (§12.1), which reads the tree.
- **Builder, forced in pull request 4.** Part 07's `components/builder/detail/formSettings/OwnCaseSection.tsx`
  (new) replaces `CloseConditionSection.tsx`, which is deleted: on a close form its **Close the
  case** row edits `closeCondition` with the ordinary `ExpressionCardEditor` over
  `form_close_condition`, with a line from `lib/domain/placementCopy.ts::placementLine` under it.
  Part 07's pull request 12 adds the registration's **Create the case** and **Close the case it
  creates** rows over `form_open_condition` and `form_close_condition` (part 07 §3.4).

## 7. `via`

`via` is a facet of Case Management's update keys (`parent/p`, `host/parent/p`), which only the own
case's basic action and, from pull request 7, an advanced load hold. Every other operation
saves to another case by targeting it, so a write to the case above another case is its own
`update`.

- **Admitted** on writes of the own arm of a follow-up or close form, each step's identifier
  `parent` or `host` (the update keys HQ holds: manifest entry
  `forms-and-case-writes/update-key-whose-index-segments-are-each-parent-or-host-parent-p`), when the
  own arm takes the basic own slot; from pull request 7, on writes of an advanced load without
  `childOf` (part 02).
- **Refused**, `CASE_WRITE_VIA_INVALID` (soundness, located at the write) with `details.reason`:
  `new-case` (the own arm of a registration, or a `create`: HQ builds the key, but the new case's
  index is not in the case database while the form is open, so the block's id is empty and Core
  refuses the submission; inventory row "an update key with an index segment on a form that opens
  its case"); `target` (any operation but the own arm, the worker's record included);
  `step` (an identifier other than `parent` or `host`); `unresolved` (a step the catalog does not
  resolve to a declared type); `placement` (the own arm takes Save to Case for another reason, §12.2,
  and Vellum's block saves one case).
- **Emission**: the key `<identifier>/…/<property>` of `update_case.update`, which HQ resolves
  through `get_case_parent_id_xpath`; the local `.ccz` builder writes the same block
  (`xform/caseBlocks.ts`).

## 8. `onlyIfChanged`

- **Admitted** on writes of the own arm of a follow-up or close form when it takes the basic own
  slot, and, from pull request 7, of an advanced load (part 02).
- **Refused**, `CASE_WRITE_ONLY_IF_CHANGED_INVALID` (soundness, located at the write) with
  `details.reason`: `new-case` (a registration's own arm or a `create`: HQ's edit expression
  compares with an empty node-set and never writes); `target` (any operation but the own arm, the
  worker's record included: a Save to Case block has no such setting, and the usercase slot is kept
  simple); `placement` (the own arm takes Save to Case, §12.2, and Vellum's block has no such
  setting, `Vellum/src/saveToCase.js`).
- **Emission**: basic and advanced rows write `update_mode: "edit"`; HQ's build adds the comparison
  when the project space has the flag, so the local `.ccz` builder writes the same
  `relevant="count(path) > 0 and instance('casedb')/casedb/case[@case_id=<id path>]/<key> != path"`
  (`lib/commcare/xform/caseBlocks.ts`, mirroring `add_case_updates`).
- **Capability.** `lib/commcare/projectSpaceCompatibility.ts`: `HqPrivateFeatureFlagId` gains
  `"save-only-edited-answers"`, `HQ_PRIVATE_FEATURE_FLAG_SYMBOLS["save-only-edited-answers"] =
  "SAVE_ONLY_EDITED_FORM_FIELDS"`, and the reason "A form saves an answer to a case only when the
  worker changed it." is added for every form with an `onlyIfChanged` write. In
  `lib/publish/projectSpaceCompatibility.ts`, `ProjectSpaceCapabilityId` gains
  `"save-only-edited-answers"` with label "Save only answers that changed" and description "Lets a
  form save an answer to a case only when the worker changed it.". Without it HQ's build writes
  every such row every time, so publish stops (`project_space_incompatible`) as for every
  capability. The gate entry `toggle/SAVE_ONLY_EDITED_FORM_FIELDS`
  (`lib/commcare/surface/entries/gates.json`) moves from `preflight: precondition` to
  `{kind: "capability", cell: "flag probe; save-only-edited-answers"}`.
- **Preview**: the envelope compares the evaluated value with the case's value in the
  pre-submission snapshot (the snapshot every evaluation already reads) and writes nothing when
  they are equal as stored strings (§19).

## 9. The worker's record

- Target `{kind: "worker-record"}` on an `update` of `commcare-user`; at most one such operation per
  form (`CASE_OPERATION_TARGET_INVALID` reason `worker-record-twice`).
- Refused facets, `CASE_OPERATION_TARGET_INVALID` reason `worker-record-facet`: `name`, `owner`,
  `rename`, `retype`, `links`, `condition`, `forEach` (Nova's choice for the worker's record:
  Vellum refuses only creating, closing or linking `commcare-user`, `saveToCase.js`, which covers
  `links`; HQ's usercase block, `xform.py::_add_usercase`, writes only property updates); a write's `via` and `onlyIfChanged` are refused by their own codes, reason `target`
  (§7, §8).
- `USERCASE_WRITE_UNDECLARED_PROPERTY` and `USERCASE_WRITE_MANAGED_PROPERTY` keep their codes,
  located at the write. `USERCASE_FIELD_IN_REPEAT` retires: a read of a repeat's question in a
  root operation's value is the checker's `many-values` already.
- The session datum `{kind: "worker-record"}` needs an active write as today; the worker-record
  operation is that write.

## 10. Attachment mode removed; the link write

### 10.1 Pull request 2

- Domain: §3.1's first paragraph. Every capture `caseWrite` saves a link. A property is never
  an attachment slot again, so `lib/domain/attachmentSlots.ts::casePropertyIsAttachmentSlot` is
  deleted with the rule that read it, `CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT`
  (`lib/commcare/validator/rules/case-list/columnKindPropertyType.ts`, `errors.ts`, `gate.ts`,
  `lib/doc/userFacingErrors.ts`): a column over a link property shows the link.
- Emission: `formActions.ts::caseUpdateQuestionPath` loses the attachment branch (a capture always
  names its `nova_url_<question>` sibling); `xform/caseOps.ts` loses its attachment branch;
  `xform/caseBlocks.ts` loses the local splicer's `<attachment>` block. With no deployment target
  the write is withheld and `exportAdvisories.ts` says so (unchanged).
- Publish: `"case-attachments"` leaves `HqPrivateFeatureFlagId`,
  `HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`, the probe plan's capability list and `ProjectSpaceCapabilityId`
  with its copy. `toggle/MM_CASE_PROPERTIES` keeps `preflight: refusal`; no export can need it, and
  the probe stops asking it.
- Authoring, forced: `CaseWriteEditor.tsx` loses the "What reaches the case" chooser and
  `CAPTURE_MODE_LABELS`; a capture's row reads "Saves a link to the file in {property}".
  `toolSchemaGenerator.ts::caseWriteToolSchema` loses `mode` and `gateCaseWriteMode` goes, which
  changes `addFields` and `editField`'s served schemas: `MODEL_CONTEXT_VERSION` becomes
  `"v6-hq-round-trip-case-writes.2"`. The billed `npm run test:schema` is not run here: it is asked
  once, at pull request 13's head, over every entry the stack added or whose served schema moved
  (part 07).
- `lib/commcare/projectSpaceCompatibility.ts::linkWriteIsShown` keeps deciding `attachment-links`
  (`VIEW_FORM_ATTACHMENT`); part 03 owns that capability.

### 10.2 Pull request 4

The capture's write becomes the term `capture-link {field}` in the write's value (§3.6). A bare
`field` read of a capture as a write value is the checker's `expected-value` reason
`capture-answer`. Emission: the basic slots name the `nova_url_<question>` sibling (unchanged); a
Save to Case row's calculate is `captureUrlCalculate` printed over the capture's own path, with no
sibling. `CAPTURE_CASE_WRITE_STANDARD_PROPERTY` keeps its code for a `capture-link` as a `name` or
written to `external_id`.

## 11. The explicit preload (defect 28)

### 11.1 Stored

A preload is `default_value = {kind: "term", term: {kind: "form-case", caseType: <the module's
case type>, property: <the property>}}` on the field. `case_name` reads `case_name` (HQ's preload
key `name` reads the same property, `add_case_preloads`). No new slot, and no new term arm: the
`form-case` term gains no selection in step 5 (§3.4), so an advanced form's load preloads through
the same default (part 02 §11).

```ts
// lib/domain/casePreload.ts (rewritten, pull request 4)
/** The case property a field opens showing: its default, when that default is
 *  exactly the `form-case` read of a property, with no other operator. */
export function fieldPreload(field: Field): { readonly caseType: string; readonly property: string } | undefined;
/** Whether a write of `property` by `fieldUuid` to the form's own case should
 *  be born with that preload: a one-case follow-up or close form, a write of the
 *  own arm without `via`, a field that is not a capture, holds no `calculate`
 *  and no `default_value`. */
export function writerOffersPreload(doc: BlueprintDoc, fieldUuid: Uuid, property: string): boolean;
export function formOpensWithOneCase(formType: FormType, cardinality: CaseSelectionCardinality): boolean; // kept
export function hiddenWriterBlankNote(doc: BlueprintDoc, fieldUuid: Uuid): string | undefined;
```

`writerPreloadsFromLoadedCase` and `writerPreloadsInContext` are deleted, and every reader of §1.4
reads `fieldPreload`. `hiddenWriterBlankNote` returns "Has no value yet, so each submission saves
{property} blank." for a Hidden Value with neither `calculate` nor `default_value` whose view holds
a write, and nothing otherwise (the "carries it through unchanged" sentence goes: that state is now
a default the author sees).

### 11.2 Admission

Any field may hold such a default where the checker admits the read (a registration refuses it with
`CASE_HASHTAG_ON_CREATE_FORM`; a several-case form's shared logic may not read one selected case).
There is no preload-specific rule. `selectPreloadWriterOptions` reads a select whose `fieldPreload`
names a property it writes, otherwise unchanged. `HIDDEN_VALUE_BOTH_SOURCES` is unchanged.
`lib/domain/expression/inference.ts`: a default that is a `form-case` read types as its property;
the clause that gave a starting value a preload overwrote no type opinion goes.

### 11.3 Births

`lib/doc/fieldCaseWriteMutations.ts::planFieldCaseWrite` (§16.3) appends `updateField {patch:
{default_value: <form-case read>}}` in the same batch when `writerOffersPreload` holds. The
builder's "Saves to" gesture, `addFields` and `editField`, `createForm`'s carried search answers and
`formScaffoldMutations` all go through it, and their results say "Opens with the case's current
value." A person removes it like any default.

### 11.4 Emission

Basic forms never emit `case_preload`: the default is a Vellum default setvalue at the question's
place in data-tree order, printed through `toWire` like every default (a casedb read the form
builder shows as `#case/<property>`). From pull request 7 an advanced form writes it the same way,
and every `LoadUpdateAction.preload` is `{}` (part 02 §11).

### 11.5 Load order

The case read now runs at the question's place among the defaults, so a later default that reads
the writer reads the case value, and an earlier one reads blank as before (the research's
"Load-time values", held on `targeted-load-time-values`).

## 12. Placement: `planPlacements`

`lib/commcare/placement.ts` (new in pull request 4, reading held placements first from the same
pull request; the advanced branch from pull request 7) decides wire facts, so it lives in
`lib/commcare`. `lib/doc` reaches it through two new `biome.json` allow-list entries,
`lib/doc/placementMoves.ts` (pull request 5) and `lib/doc/casePlacements.ts` (the hooks'
projection, §12.7, pull request 4), as `lib/doc/formLinkReview.ts` already reaches `lib/commcare`;
part 03's `lib/db/placementAuthority.ts` and `lib/doc/placementHolds.ts` call `placementIneligibility`
and part 07's `lib/doc/identityMoves.ts` calls `placementExpresses`, so each needs an entry of its
own in pull request 5.

### 12.1 Subjects and the stateable condition

A form's placement subjects are its operations (keyed by uuid) and, where it cannot share the own
arm's place, its own close (`"own-close"`):

```ts
export type PlacementSubject =
	| { readonly kind: "operation"; readonly operationUuid: Uuid }
	| { readonly kind: "own-close" };
```

A condition `C` is **stateable** by Case Management for a subject `S` (the own case, a child at
the form root, or a child in repeat `R`) when `C` is absent or `match-all`, or is one of:

1. `term field{q}` alone (HQ `boolean_true`, `{path}`);
2. `eq(term field{q}, A)` or `eq(A, term field{q})` (HQ `=`);
3. `multi-select-contains(term field{q}, [A], any)` (HQ `selected`);

where `q` is a single select, multi select, Hidden Value or label (`getQuestions('select select1')`
widened by `hidden` and `trigger`); `q` stands in no repeat, or, for a child in `R`, its innermost
repeat is `R`; `A` is a `literal` string, or a `choice` of `q` naming exactly one option; where
`q`'s choices are inline, `A` is a `choice` (the page's dropdown offers only them, and its save
writes the first option over any other answer); the answer's text (the literal, or the option's
current value) holds no `'` (HQ interpolates it between single quotes); and, for the own case, the
text neither starts nor ends with `"` (the save strips it). `match-none` (`false()`) is not
stateable: HQ's `never` makes the action inactive.

The test reads the condition the emitter writes. Under part 04's gated run G2 outcome B2, every
operation whose scope is a row of a count-placed query repeat has its emitted condition conjoined
with `nova_query_id_r != ''` (part 04), which `planPlacements` adds to the authored condition
before the test (part 02 emits it); a generated node is no question Case Management's picker
offers, so such an operation's condition is not stateable (`condition-shape`) and it takes Save to
Case. Under part 04's other outcomes no conjunct exists and the authored condition is the one
tested.

### 12.2 Eligibility, condition by condition

Each condition has an id, the `PlacementIneligibility` reason the procedure reports when it fails
(§12.8). A placement is eligible for a subject when every condition of its row holds.

**Basic own slot** `{basic, own}`, the own arm only:

| Condition | Reason when it fails |
|---|---|
| The module is not emitted advanced (pull request 7) | `module-advanced` |
| The form is a registration, or its module selects one case at a time (HQ's `default_case_management`) | `several-cases` |
| `name`, `owner` and every write value is a bare read of a question that is not a label or container, or a `capture-link` of a capture | `value-computed`, `value-label` |
| Each of those questions stands in no repeat | `value-in-repeat` |
| No write carries a `condition` | `write-condition` |
| The arm has no `links` | `links` |
| `openCondition` is stateable for the own case | `condition-shape`, `condition-question-kind`, `condition-question-repeat`, `condition-apostrophe`, `condition-quote-boundary`, `condition-not-a-choice` (with `details.condition: "open"`) |
| On a registration, no other operation updates or closes the case the form creates (§5.3, rule 4) | `case-changed-before-create` |

**Basic usercase slot** `{basic, usercase}`, the form's worker-record update:

| Condition | Reason |
|---|---|
| The module is not emitted advanced | `module-advanced` |
| Every write value is a bare read of a question that is not a label or container | `value-computed`, `value-label` |
| Each of those questions stands in no repeat | `value-in-repeat` |
| No write carries a `condition` | `write-condition` |

**Basic subcase** `{basic, subcase, index}` or `{basic, subcase-row}`, a `create`:

| Condition | Reason |
|---|---|
| The module is not emitted advanced | `module-advanced` |
| The form is a registration, or its module selects one case at a time | `several-cases` |
| The target is `new` with no `idFrom` | `keyed-id` |
| Exactly one link: identifier `parent`, relationship `child`, its target the form's own case (`session` on a loading form, `op` naming the own arm on a registration) | `subcase-link` |
| On a registration, the own arm takes the basic own slot (HQ writes the parent index only beside the own block, and numbers root subcase datums after `open_case`) | `own-not-basic` |
| `caseType` is the case type of some module of the app | `subcase-type` |
| `name`, `owner` and every write value is a bare read of a question that is not a label or container | `value-computed`, `value-label` |
| Each of those questions' innermost repeat is the `forEach` repeat, or none | `value-wrong-repeat` |
| The `name` question's innermost repeat is exactly the `forEach` repeat (HQ's `repeat_context`), none when `forEach` is absent | `name-repeat` |
| No write carries a `condition` | `write-condition` |
| `condition` is stateable for a child in the `forEach` repeat (or at the root) | the six `condition-*` reasons, `details.condition: "operation"` |
| No other operation updates or closes the case it creates, except a `close` that shares its slot (§12.3) | `case-changed-before-create` |
| A held `index` is the one §12.3 step 4 gives it | `subcase-index` |
| Held `subcase-row` when its repeat holds exactly one basic subcase, held `subcase` when it stands at the root or its repeat holds more than one | `subcase-nesting` |

From pull request 4 to pull request 7, an unheld `create` whose `caseType` is its module's case
type (HQ's `form.get_case_type()`) skips the basic subcase slot and takes Save to Case: part 03's
check that a project space keeps a same-type child's parent index (`DONT_INDEX_SAME_CASETYPE` off,
the capability `same-type-child-links`) lands in pull request 8, so no export may hold that shape
before it. The skip runs through the same `excludeBasic` option part 03's offer uses (§12.3), as
the default exclusion of every caller; it is no eligibility condition, so `placementIneligibility`
never reports it. Pull request 8 lifts it with the capability, the offer, the lane's `flagsOff`
verdict key and part 03's gated runs G3 and G4. One deploy carries the stack, so no published app
meets the interim placement.

**Advanced action** `{advanced, tag, row?}` (pull request 7): part 02's clauses
(`lib/commcare/advancedPlacement.ts::loadIneligibility` for a load, `openActionIneligibility` for
an open action; `planPlacements` calls both and reports the clause as the reason), with the same
value and condition rules as the basic slots (part 02 §9): a value is a bare read of a question,
never a label or a container, and a label as a write source stays HELD-NEW for step 7; the one
difference is that the own case's quote boundary rule does not apply (HQ's advanced save strips
nothing from an answer).

**A carried create** (pull request 7, part 02 §14.5). Every `create` that
`lib/commcare/formLinkProjection.ts::linkCarriedCreates` holds for its form, an extension or not,
needs a session datum, so a placement of it is eligible only when it is `{basic, own}` on a
registration, a `{basic, subcase}` outside a repeat, or `{advanced, tag}` of an open action outside
a repeat (reason `carried-create`). A Save to Case placement never expresses a carried create, so
none is ever held: the edit that makes a published create carried moves its hold to an advanced
open action, stated before it commits, and the publish recorder and the cutover hold none.

**Part 02's gated runs on appended names** (pull request 7). Under part 02's G3 outcome A (HQ's
build or Core refuses, or loses a write, when a root question takes the name of a block HQ
appends), the basic subcase and usercase slots gain the condition "no root question takes the name
HQ appends for this slot" (`subcase_<i>`, `commcare_usercase`; reason `appended-name-taken`), and
`HELD_BLOCK_PATH_TAKEN` (§13.2) covers those appended names. G3 found outcome A on pull request 7's
first push: the condition holds for an unheld slot, read where HQ appends it (the form root, or the
rows of a repeat holding two subcases), and a held slot keeps its name for `HELD_BLOCK_PATH_TAKEN`
to refuse the question (part 02 §27). Under part 02's G4 outcome A (a basic
write to a worker property whose name starts with `_` is refused while Save to Case lands), the
usercase slot gains the condition "no write's property starts with `_`" (reason
`worker-property-name`). Under their other outcomes neither condition exists.

**Save to Case** `{save-to-case, repeat?, path}`:

| Condition | Reason |
|---|---|
| No write of the operation carries `onlyIfChanged` or `via` | `only-if-changed`, `via` |
| A held placement's `repeat` is the operation's `forEach` repeat (absent for both at the root) | `scope` |
| A held `path` has as many segments as the wrappers the operation's block now needs (`lib/commcare/xform/caseOps.ts::saveToCaseBlockShape(doc, formUuid, subject)`: the selected-cases item where the operation runs per selected case, the scope's `nova_operations` group, a keyed row for a root create keyed by an answer, a condition group for a conditional update or close, the block) | `block-shape` |

Save to Case is otherwise always eligible, so every operation Nova admits has a placement. An
operation whose `onlyIfChanged` or `via` write no basic slot or advanced action can take is refused
at the gate (§7, §8), naming the first failed condition of the slot it needed.

### 12.3 The procedure

```ts
export interface PlannedPlacement {
	readonly placement: CasePlacement;
	readonly held: boolean;
	/** A close sharing another operation's basic or advanced place. */
	readonly sharesWith?: Uuid;
}
export interface InexpressibleHold {
	readonly subject: PlacementSubject;
	readonly held: CasePlacement;
	/** Every failed condition, the first in table order first. */
	readonly reasons: readonly [PlacementIneligibility, ...PlacementIneligibility[]];
}
export interface FormPlacements {
	readonly formKind: "basic" | "advanced";
	readonly placements: ReadonlyMap<PlacementSubjectKey, PlannedPlacement>;
	readonly inexpressible: readonly InexpressibleHold[];
}
export type PlacementSubjectKey = Uuid | "own-close";
export interface PlanPlacementsOptions {
	/** Fixes step 1's form kind, so part 02's `emittedModuleKind` can ask what a
	 *  basic form would give without asking itself (pull request 7). */
	readonly moduleKind?: "basic" | "advanced";
	/** Operations that skip the basic and advanced slots and take Save to Case
	 *  (part 03's `same-type-child-links` offer; until pull request 8 also every
	 *  same-type create, §12.2). */
	readonly excludeBasic?: ReadonlySet<Uuid>;
}
export function planPlacements(doc: BlueprintDoc, formUuid: Uuid, options?: PlanPlacementsOptions): FormPlacements;
export function appPlacements(doc: BlueprintDoc): ReadonlyMap<Uuid, FormPlacements>;
export function placementExpresses(doc: BlueprintDoc, formUuid: Uuid, subject: PlacementSubject, placement: CasePlacement): boolean;
export function placementCandidates(doc: BlueprintDoc, formUuid: Uuid, subject: PlacementSubject): readonly CasePlacement[];
export function placementIneligibility(doc: BlueprintDoc, formUuid: Uuid, subject: PlacementSubject, placement: CasePlacement): readonly PlacementIneligibility[];
```

Pure, and memoized per document object (documents are replaced, never changed in place), like
`planGeneratedNodes`; a call with options is memoized per document and options. Steps, in order:

1. **Form kind.** `options.moduleKind` when given; otherwise `advanced` when part 02's
   `lib/commcare/moduleKind.ts::emittedModuleKind` gives it for the form's module (pull request 7);
   `basic` before then.
2. **Held placements first** (pull request 4). Each subject holding a placement (an operation's
   `placement`, the form's `ownClosePlacement`) keeps it when `placementIneligibility` returns
   nothing for it. One that fails is planned as if unheld, so every emitter gets a total answer for
   any document; from pull request 5 it is also listed in `inexpressible` with every failed
   condition, which only the gate (§13) and the move planner (§14) read.
3. **Unheld subjects, in array order.** Each takes the first eligible of: a basic slot (a basic
   form) or an advanced action (an advanced form), else Save to Case; an operation in
   `options.excludeBasic` takes Save to Case. The own slot belongs to the own arm and the usercase
   slot to the worker-record update. Where Save to Case fails only on
   `only-if-changed` or `via`, the subject still gets it, so the procedure is total; the gate
   refuses that document through §7 and §8, so no export reaches it. A `close` whose target is `op` naming
   a `create` placed in a basic subcase slot or an advanced open action, with the same `forEach`, a
   condition stateable for that child, and nothing between them that names the case, shares that
   placement (`sharesWith`; HQ's `close_condition`); every other `close` takes its own Save to Case
   block, as today.
4. **Basic subcase indices.** Let `k` be the number of operations placed in basic subcase slots,
   held or not. A subcase whose repeat holds exactly one of them is `subcase-row`; every other one
   takes an index in `0 … k-1`. Held indices keep theirs; the remaining indices go to the
   remaining subcases, row subcases included, lowest first in array order. A held index of `k` or
   more, or one another held subcase also claims, fails `subcase-index`. Emission writes
   `subcases` in index order (part 02's `planFormCaseWire`). An extension create is placed as any
   `create` (Save to Case in `nova_operations`, or an advanced open action where it is carried),
   and takes no index here (part 02 §14.3, the cutover's M2).
5. **Save to Case paths.** A held path is written verbatim. An unheld block takes the names today's
   allocator gives it (`planGeneratedNodes`: the scope's `nova_operations` group, its condition
   group or keyed row, and the block named by the operation's `id`), after the allocator has
   reserved, in each namespace, every segment of every held path of the form (§12.5). The planned
   placement carries that exact path, allocator suffixes included, so a hold recorded from it pins
   the bytes the emitter writes (part 03's publish recorder relies on it).
6. **The own close.** §12.6.

`placementExpresses` is `placementIneligibility(...).length === 0`. `placementCandidates` lists the
placements eligible for the subject on the document as it stands, simplest first (basic or
advanced, then Save to Case), each with the index, tag or path step 4 or 5 would give it; part 03's
publish offers read it.

### 12.4 Physical order

Core applies case blocks in document order, and HQ sorts one case's blocks create first
(`lib/doc/caseOperationOrder.ts`, the authored-key rule's comment). Save to Case blocks stand where
today's emitter writes them: the root group before the authored fields, each repeat's after its
authored children. HQ writes a basic subcase of a repeat as the row's first child (`subcase-row`)
or after the row's children (`subcase_<i>`), root subcases and then the own `case` block after the
authored tree, and `commcare_usercase` last. `caseOperationWireOrderViolations` keeps its three
rules over the array order. The basic slots add the two conditions that physical order needs and
the array order cannot show: `case-changed-before-create` (an update or close standing before its
case's create) and, on a registration, `own-not-basic` for a subcase. An index naming a case a later
block creates is what HQ's own basic subcases write, and stays eligible; gated run G1 holds it on
Core.

### 12.5 Held paths in the allocator

From pull request 4, `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes` takes, before any allocation, every
segment of every held Save to Case path of the form (operations' and the own close's) in the
namespace that segment stands in: the first segment at its scope (the form root or the held
`repeat`'s row), the rest in the operations namespace of that scope. An unheld node whose base a
held segment takes gets `_<n>` as for any taken base. An authored name that equals a held segment
in the same namespace is refused at the gate (`HELD_BLOCK_PATH_TAKEN`, §13.2), because the allocator
steps around taken names but never moves a held one.

### 12.6 The own close

The own close (a close form's, or a registration's with `closeCondition`) shares the own arm's
place when:

- the own arm takes the basic own slot and `closeCondition` is absent, `match-all`, or stateable for
  the own case (HQ `close_case`), or
- the own arm takes Save to Case in a form whose module selects one case at a time (the close is
  the block's `close` element, its `relevant` the condition, as Vellum writes a Save to Case close).

Otherwise it is its own subject: held at `Form.ownClosePlacement`, or unheld at today's close-only
block (`nova_condition_close`/`nova_close` in a one-case form, `nova_close_selected_cases` in a
several-case form), and `close_case.condition` is `never`. From pull request 7 an advanced form's
own close is its load's `close_condition` (part 02).

### 12.7 Readers

Part 02's `lib/commcare/casePlacementPlan.ts::planFormCaseWire` (new in pull request 4 with its
basic and Save to Case arms, its advanced arm from pull request 7) turns the placements into the
wire, and every emitter reads that plan: `lib/commcare/formActions.ts` (basic `FormActions`),
`lib/commcare/xform/caseOps.ts` (Save to Case), `lib/commcare/xform/caseBlocks.ts` (the local
`.ccz` builder's basic blocks), `lib/commcare/planPrivileges.ts` (`save_to_case` only where a form
has a `save-to-case` placement: `formEmitsSaveToCase` becomes `appPlacements` over the form;
`child_cases` only where a form has a basic subcase placement), `lib/commcare/addOns.ts`,
`lib/doc/placementMoves.ts` (§14), `lib/doc/casePlacements.ts::formCasePlacementView(doc,
formUuid)` (the builder's placement lines through `lib/doc/hooks/useCasePlacements.ts`, part 07),
the `get_case_operations` projection (part 07), `lib/commcare/sameTypeChildCases.ts` (§15) and part
03's publish recorder and offers. Preview reads none (§19).

### 12.8 The ineligibility reasons and their sentences

```ts
// lib/domain/placements.ts
export const PLACEMENT_INELIGIBILITY_REASONS = [
	"module-advanced", "module-basic", "several-cases", "value-computed", "value-label",
	"value-in-repeat", "value-wrong-repeat", "name-repeat", "write-condition", "links",
	"subcase-link", "own-not-basic", "subcase-type", "keyed-id", "condition-shape",
	"condition-question-kind", "condition-question-repeat", "condition-apostrophe",
	"condition-quote-boundary", "condition-not-a-choice", "case-changed-before-create",
	"subcase-index", "subcase-nesting", "only-if-changed", "via", "scope", "block-shape",
	"no-close",
] as const;
export interface PlacementIneligibility {
	readonly reason: (typeof PLACEMENT_INELIGIBILITY_REASONS)[number];
	readonly condition?: "open" | "close" | "operation";
}
```

Part 02 adds its advanced reasons (the `AdvancedIneligibility` clauses of
`lib/commcare/advancedPlacement.ts`, `appended-name-taken` and `worker-property-name` among them,
which also name the basic slots' conditions under part 02's G3 and G4 outcomes A, §12.2) and
`carried-create` to the tuple in pull request 7 (`module-basic` is the held advanced action in a
module emitted basic), with their sentences; `carried-create` reads "An after-submit link now hands
the case it creates to another form, which needs that case's id when the form opens.". Each
reason's sentence lives in `lib/domain/placementCopy.ts::placementIneligibilitySentence(reason)`,
which the gate's messages (§17), part 07's identity-move rows and part 03's offers all read:

| Reason | Sentence |
|---|---|
| `module-advanced` | Its menu is now an advanced menu in CommCare HQ, where every form saves its cases through case actions. |
| `module-basic` | Its menu is no longer an advanced menu in CommCare HQ. |
| `several-cases` | Its form now works on several cases at once, and Case Management saves one case per form. |
| `value-computed` | One of its values is now a calculation, which Case Management can't save. |
| `value-label` | One of its values now reads a label or a group, which Case Management can't save. |
| `value-in-repeat` | One of its values now comes from a question inside a repeat. |
| `value-wrong-repeat` | One of its values now comes from a question in another repeat than the one it runs in. |
| `name-repeat` | Its name now comes from a question in another repeat than the one it runs in. |
| `write-condition` | One of its saves now has a condition of its own, which Case Management can't hold. |
| `links` | It now links to another case, which Case Management can't do for this form's case. |
| `subcase-link` | Its link changed, and Case Management creates a new case only as a child of this form's case. |
| `own-not-basic` | This form's own case is now saved through Save to Case, and Case Management links a new case only to a case it saves itself. |
| `subcase-type` | Its case type is no longer one a menu of this app uses. |
| `keyed-id` | Its case id now comes from an answer. |
| `condition-shape` | Its condition is now more than one question compared with one value. |
| `condition-question-kind` | Its condition now reads a question that isn't a select, a hidden value or a label. |
| `condition-question-repeat` | Its condition now reads a question inside a repeat it doesn't run in. |
| `condition-apostrophe` | Its condition now compares with a value that holds an apostrophe. |
| `condition-quote-boundary` | Its condition now compares with a value that starts or ends with a double quote. |
| `condition-not-a-choice` | Its condition now compares a select with a value that isn't one of its choices. |
| `case-changed-before-create` | Another case change now updates or closes the case it creates, and Case Management would create that case only after it. |
| `subcase-index` | A new case before it was removed or moved, so its place in Case Management's list of new cases changed. |
| `subcase-nesting` | The repeat it runs in now creates a different number of new cases, so Case Management keeps it in a new place. |
| `only-if-changed` | One of its saves now keeps only changed answers, which Save to Case can't do. |
| `via` | One of its saves now goes to a case above it, which Save to Case can't do in the same block. |
| `scope` | It now runs in another repeat. |
| `block-shape` | Its condition, or the answer its case id comes from, changed, which changes where Save to Case keeps it. |
| `no-close` | This form no longer closes its case. |

## 13. Held placements (slots and procedure in pull request 4; the mutation and rules in pull request 5)

### 13.1 Writing a hold

`holdPlacements` is part 03's one mutation kind (resolution 4), landing in pull request 5 with the
targets case operation, own close and query repeat (part 02 adds the module kind in pull request
7). This part fixes its two targets' entries:

```ts
// lib/doc/types.ts, inside part 03's placementHoldSchema
z.strictObject({ target: z.literal("case-operation"), formUuid: uuidSchema,
	operationUuid: uuidSchema, placement: casePlacementSchema.nullable() }),
z.strictObject({ target: z.literal("own-close"), formUuid: uuidSchema,
	placement: ownClosePlacementSchema.nullable() }),
```

The reducer (`lib/doc/mutations/placements.ts`, part 03) sets `caseOperations[i].placement` or
`Form.ownClosePlacement`, and `null` deletes the key; target admission refuses a missing form or
operation and two entries for one target in a batch. Who may write which entry is part 03's kernel
rule (`lib/db/placementAuthority.ts::placementChangeRefusal`, pull request 5), which reads this
part's `placementIneligibility` through part 03's `holdExpresses` (an empty list is "expresses";
§12.3); it needs its own `biome.json` allow-list entry. `holdPlacements` is the only writer of
either slot: the arm schema of `caseOperationChange` `add` and of `caseOperationPatch` `update`
omits `placement`, and `updateForm.patch` omits `ownClosePlacement` (§16.1). Re-creating a removed
held operation with its hold, which an undo does, is the `add` followed by a `holdPlacements`
entry restoring the hold, which the kernel rule admits as a restore of the latest recorded hold
(§14).

### 13.2 The rules

All soundness, in `lib/commcare/validator/rules/casePlacement.ts` (new), located at the form:

- **`HELD_PLACEMENT_INEXPRESSIBLE`**: a subject of `planPlacements(doc, form).inexpressible`, or
  an `ownClosePlacement` on a form that does not close its own case (reason `no-close`). A held
  own close keeps its own block even where it could now share the own arm's place (held first,
  §12.3).
  `details: {subject, held, reasons}`. Message: "CommCare HQ keeps “{subject}” where your last
  publish put it, and this change can't keep it there. {first reason's sentence} Make the change
  again to see where it moves and confirm it." (`{subject}` is "this form's case" for the own arm,
  "closing this form's case" for the own close, and the case change “{operation id}” otherwise, as
  every case-operation finding names an operation today; the builder's row sentence, the dialog's
  and the tools' are `lib/domain/caseOperationDescription.ts::describeCaseOperation(doc, formUuid,
  operationUuid)`, §14.) Because the gate runs on every
  editor, a batch that strands a hold commits only when the same batch also writes the subject's
  hold, which is what §14's planner appends.
- **`CASE_PLACEMENT_SHARED`**: two subjects of one form hold one placement value, except a `close`
  holding the basic or advanced place of the `create` it shares (§12.3). `details: {subjects}`.
  Message: "Two case changes in “{form}” are kept in the same place in CommCare HQ: {a} and {b}.
  Removing one of them and adding it again gives it a place of its own."
- **`HELD_BLOCK_PATH_TAKEN`**: an authored question id at a scope, a Connect block id at the root,
  or an operation id in an operations namespace equals a segment of a held Save to Case path in
  that namespace (§12.5). `details: {held: subject, name, suggestion}`, the suggestion from
  `lib/domain/questionId.ts::editorSafeQuestionId` and `idSlug.ts::suffixUntilFree`. Message: "The
  name “{name}” is where your published app keeps {subject} in CommCare HQ. You can name it
  “{suggestion}”."

Part 02 adds `CASE_PLACEMENT_KIND` and the `module-kind` arm of `HELD_PLACEMENT_INEXPRESSIBLE`
(part 02 §5) to `casePlacement.ts` with the advanced arm in pull request 7. The three rules land in
pull request 5 with `holdPlacements`; in pull request 4, where only fixtures and specs hold a
placement, `planPlacements` already keeps a held one and the allocator already reserves held paths
(§12.3, §12.5), so the witnesses emit what the cutover will hold.

### 13.3 Validation scope

`HELD_PLACEMENT_INEXPRESSIBLE` and `CASE_PLACEMENT_SHARED` read the whole form and its module, and
a held subcase's index reads every operation of the form. `lib/doc/incrementalValidationScope.ts`
takes the whole-module scope for a batch that holds `holdPlacements`, any case-operation change or
patch, `updateForm` with `type`, `openCondition` or `closeCondition`, `updateModule` with a case
type or a change to how many cases its list selects, and any field mutation in a form that
holds a placement (`lib/doc/heldIdentity.ts::formHoldsPlacement`, memoized per document, beside
part 07's `documentHoldsIdentity`). A form that holds none takes today's scope.

## 14. Identity moves for operations: `lib/doc/placementMoves.ts`

```ts
// lib/doc/placementMoves.ts (new, pull request 5)
export function planOperationPlacementMoves(candidate: BlueprintDoc): {
	readonly holds: readonly PlacementHoldEntry[]; // part 03's holdPlacements entries, document order
	readonly moves: readonly IdentityMove[];      // part 07's shape (resolution 3)
};
```

Over a candidate (the document with the batch applied, which `withIdentityMoves` already prepares,
so no second `prepareMutationCandidate`): for each form, `planPlacements(candidate, form)`; for each
subject in `inexpressible`, the planner computes its new placement with every inexpressible hold of
the form treated as unheld (one `planPlacements` run over a copy of the candidate with those holds
removed), and records that placement as held at once: the subject was published at its old place, so
the move changes its submission path in every project space, and the new place is the one Nova
keeps from then on. Each yields one entry (`case-operation` or `own-close`) and one move:

```ts
{ subject: { kind: "case-operation", formUuid, operationUuid } | { kind: "own-close", formUuid },
  from: placementLabel(<held>), to: placementLabel(<new>),
  reason: { source: "case-placement", reason: <the first PlacementIneligibility> } }
```

`from` and `to` are part 07's `PlacementLabel` words (`lib/domain/placementCopy.ts::placementLabel`:
`case-management`, `case-actions` or `save-to-case`), and `reason` is part 07's
`IdentityMoveReason` arm `case-placement` (part 07 §2.2), carrying the first failed condition whole:
its reason is an id of §12.8's tuple, whose sentence is `placementIneligibilitySentence`, and its
`condition` names which condition failed where the reason is a `condition-*` one.
The subject's name in the dialog and the tool sentences is
`lib/domain/caseOperationDescription.ts::describeCaseOperation(doc, formUuid, operationUuid)` (new,
pull request 5): the operation's sentence the builder's case changes screen shows today
(`components/builder/case-operations/operationSentence.ts` moves its text there and reads it), so
the dialog, the tool results and part 03's offered moves name a change the way the builder does.

A move that renumbers basic subcases (an earlier one removed, moved or turned into Save to Case)
yields one entry per later subcase whose held index fails. Removing an operation or the field it
reads is no move: the path goes with its data, and an operation's hold goes with the operation.
The own close is the one subject that can vanish while its hold stays on the form (its
registration's `closeCondition` removed, or the form's type changed so it no longer closes): the
planner yields an entry clearing `ownClosePlacement` (`placement: null`) and no move. `withIdentityMoves` (part 07, resolution 3) appends
one `holdPlacements` mutation with every planner's entries to the batch, states the moves, and
re-runs the gate.

**What moves a held placement**, each a reason of §12.8: a write's value stops being a bare
question read; a write gains a condition; the own arm gains a link; a basic subcase's link, type,
`forEach` or `idFrom` changes, or its name question moves to another repeat; a written question is
converted to a label or container, or moved into a repeat (own, usercase) or out of the child's;
a stateable condition becomes unstateable (an option's value gains `'` or a boundary `"`, the
condition reads another kind of question or one in a repeat, or gains a second comparison); a form
moves to a module that selects several cases, or its module comes to select several; another
operation comes to update or close a case a basic slot creates; an earlier basic subcase is removed,
moved or moved to Save to Case; a repeat gains or loses a basic subcase; a Save to Case operation's
`forEach` changes, or its condition or keyed id comes or goes; an operation held in Save to Case
gains `onlyIfChanged` or `via` (it moves to the basic slot that can take them, or the batch is
refused); from pull request 7, a module turning advanced or back (part 02's
`lib/doc/moduleKindMoves.ts::planModuleKindMoves`; this planner reads the form kind the candidate
gives once that planner has moved the kind's hold, so it runs after it, as part 02 §21 says), and a
create a link comes to carry (its hold moves to an advanced open action, `carried-create`).

**Undo and redo.** A history step records no `holdPlacements` (part 03); part 07's
`lib/doc/store.ts::applyHistoryStep` derives the hold changes of each inverse at the moment it
applies, and carries only those part 03's kernel rule admits under an editor's kind: (a) a move of
a hold the same step makes inexpressible, which this planner computes as for any edit, or (b) a
restore, for a target, of exactly the hold the latest recording for that target wrote (the latest
`publish-placement` or `blueprint-migration` row, else the greatest fold baseline's snapshot). So
the undo of an identity move puts the hold back where the latest recording put it; that restore is
admitted under arm (b) and is no move, since the answers return to where the published app keeps
them, so nothing is stated and no dialog opens (part 07 §2.5). The undo of removing a held
operation or own close re-creates it with that hold (§13.1), also under arm (b). A redo of a move
makes the earlier hold inexpressible again (arm (a)) and states the move as any edit does. Where a
publish recorded the new place after the edit, the hold the undo would restore is no longer the
recorded one, so `applyHistoryStep` drops that hold change, the content is undone, and the subject
stays where the publish recorded it; where that undone content strands the recorded hold, this
planner moves it under arm (a) and `withIdentityMoves` states the move. Any other hold change in
an inverse is refused by the kernel, so `applyHistoryStep` never derives one.
`placementExpresses` serves part 07's `identityMovesBetween` and part 03's `admittedHoldChanges`, which
`applyHistoryStep` calls.

**The conflict path.** A `publish-placement` change (part 03) lands at revision R; a tab's batch
composed before R that strands a hold R recorded is refused by the server gate with
`HELD_PLACEMENT_INEXPRESSIBLE`; the reconciler classifies a refusal whose findings all carry the
identity codes as a conflict (part 03), and the tab re-plans with `withIdentityMoves` over the new
head (part 07's dialog lead).

## 15. Defect 12, model side

```ts
// lib/commcare/sameTypeChildCases.ts (new, pull request 4)
export interface SameTypeChildCase {
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly caseType: string;
	/** "registers" on a registration form, "works-on" on a form that loads its case. */
	readonly ownCase: "registers" | "works-on";
}
/** Every create placed (held or simplest) in a basic subcase slot whose case type
 *  is its module's case type for actions, in document order. */
export function sameTypeBasicChildCases(doc: BlueprintDoc): readonly SameTypeChildCase[];
```

It reads `planPlacements` and each operation's `caseType` against
`lib/commcare/formLinkProjection.ts::moduleCaseTypeForActions(doc, moduleUuid)` (HQ's
`form.get_case_type()`), so it cannot disagree with the emitted `subcases`; the shape is part 03's
(part 03 §8), which reads it. Until pull request 8 the interim exclusion of §12.2 keeps every unheld
same-type create out of the basic subcase slot, so the list holds only a held one, which only a
fixture writes before pull request 8.

No validator rule: the shape is valid in every project space where `DONT_INDEX_SAME_CASETYPE` is
off, which is HQ's default (`corehq/toggles/__init__.py`, a deprecated `StaticToggle`). Part 03's
`sameTypeChildReasons(doc)` reads this list for the capability `same-type-child-links`, probes the
flag as one that must be off, and offers each such operation's move to its Save to Case candidate
(`placementCandidates`, or `planPlacements` with `excludeBasic`), which always exists (resolution
8). The shape becomes producible in pull request 8, when the exclusion lifts: there part 03 moves
`proof/targeted/__tests__/unproducedInputs.test.ts`'s bullet "a basic child case of its own menu's
case type" to `proof/targeted/__tests__/publishChecks.test.ts`, and
`lib/commcare/__tests__/compilerEvidence.ts` drops its same-type subcase assertion. The production
scan found no same-type basic child create in any app, so the capability asks nothing of a
production app today.

## 16. Mutations and planners

### 16.1 Payload changes (`lib/doc/types.ts`)

No new mutation kind besides part 03's `holdPlacements`.

- `updateField.patch` loses `caseWrite` (pull request 4; in pull request 2 the capture arms' patch
  loses `mode` with the schema).
- `updateForm.patch` gains `openCondition` and `closeCondition`, each an `Expression` or `null`
  (clears). The reducer (`lib/doc/mutations/forms.ts`) stores `match-all` as absent for an open
  condition and for a close form's close condition (§3.5).
- `caseOperationChange.add.value` admits the `own` arm. Removing the own arm or moving it from
  index 0 is refused by the gate (`CASE_OWN_OPERATION` reasons `missing` and `position`) unless the
  same batch changes the form's type to survey, and the planners and tools refuse it first with
  "This form's case is always the first change, and it goes only with the form's type."
  `planFormTypeChange` removes it with the type in one batch.
- `caseOperationPatch.update` gains `targetAction: "own"` with a clearable partial patch of `name`
  and `owner`.
- A write is keyed by `caseWriteKeySchema` (`{property, via?}`): `update-write`, `remove-write`
  and `move-write` replace `property` with `key`; `add-write.after` and `move-write.after` become
  `caseWriteKeySchema.nullable()`. `via` is part of the key and never patched: changing it is
  `remove-write` then `add-write`. `writePatchSchema` gains `onlyIfChanged: z.literal(true).nullable()`
  (`null` clears).
- No payload carries a placement (pull request 4): the arm schemas of `caseOperationChange` `add`
  and `caseOperationPatch` `update` omit `placement`, and `updateForm.patch` omits
  `ownClosePlacement`, so both slots change only through `holdPlacements` (pull request 5).

The stored history before the cutover's fold horizon is not replayed by the new schema (decision
12, part 09), so these payloads change in place without a compatibility arm.
`lib/doc/diffDocsToMutations.ts` diffs the own arm, write keys with `via` and the two conditions
from pull request 4, and from pull request 5 the holds (one trailing `holdPlacements` with an entry
for any placement that differs, part 03), so autosave and the synthetic writer carry each.

### 16.2 The reference index

`lib/domain/referenceSlots.ts`: `case_write_case_type` and `case_write_property` are deleted (pull
request 4); a write member becomes `{operationUuid, property, via?}`; `form_open_condition` and
`form_close_condition` are added and `close_condition_field` deleted; `capture-link` registers a
read of its field. `lib/doc/referenceIndex.ts::declarersOf` reads operation writes only.

### 16.3 The one "Saves to" planner

```ts
// lib/doc/fieldCaseWriteMutations.ts (new, pull request 4)
export interface FieldCaseWriteDestination {
	readonly caseType: string;
	readonly property: string;
	readonly via?: CaseWriteVia;
	readonly onlyIfChanged?: true;
}
export type FieldCaseWritePlan =
	| { readonly ok: true; readonly mutations: readonly Mutation[]; readonly notes: readonly string[] }
	| { readonly ok: false; readonly message: string };
/** Replace the field's whole view (`replace` absent) or one row of it with
 *  `destination`; `null` removes. */
export function planFieldCaseWrite(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	destination: FieldCaseWriteDestination | null,
	options?: { readonly replace?: FieldCaseWriteViewKey },
): FieldCaseWritePlan;
```

`FieldCaseWriteViewKey` is `{operationUuid, slot, key?: CaseWriteKey}`. Each destination class:

| Destination | The batch |
|---|---|
| the module's case type, no `via` | `add-write` on the own arm, or its `name` for `case_name`; `owner_id` sets `owner` |
| the module's case type through `via` (a loading form) | `add-write` with `via` on the own arm |
| a declared direct child type | `add-write` on the first `create` of that type whose only link is a `parent` link to the own case, with the field's nearest repeat as `forEach`, no `idFrom` and no `condition`; else a new `create` (`id` the type, made unique by `caseOperationIdentifiers.ts`, one link `{identifier: "parent", targetType: <the module's case type>, target: <the own case>, relationship}` with the relationship from the catalog, `child` or `extension`, the index name today's wire writes for both, `forEach` the nearest repeat). `case_name` sets its `name`. A new create needs a name, so a property other than `case_name` with no such create refuses: "Save a name for the new {type} first." |
| `commcare-user` | `add-write` on the form's worker-record update, or a new one |
| anything else | refuses with today's sentences of `CASE_WRITE_NOT_DIRECT_CHILD` and `CASE_WRITE_UNKNOWN_TYPE`, now planner refusals |
| `null` | removes every write in the view (or the `replace` row); a registration's own `name` refuses: "A new case needs a name. Choose another question to name it first."; a child `create` left with only its link and no name and no writes is removed with it; one left with other writes refuses with `CASE_CREATE_NAME_MISSING`'s sentence |

A replacement is the removal then the addition in one batch. When `writerOffersPreload` holds for
the new own write, the batch also sets the field's `default_value` to the `form-case` read and
`notes` holds "Opens with the case's current value." (§11.3). The plan is an ordinary batch: the
builder, `addFields`, `editField` and `createForm` commit it through `withIdentityMoves` like any
other.

### 16.4 Other planners

- **Form type**: `lib/doc/formTypeMutations.ts::planFormTypeChange` (§5.4); `updateForm {patch:
  {type}}` from every surface goes through it.
- **New forms**: `lib/doc/scaffolds.ts::formScaffoldMutations` adds the own arm at index 0: on a
  registration, `name` the bare read of its born `case_name` question (the question is born with no
  destination, and the arm reads it); on a follow-up or close, no writes.
- **Field moves**: `moveField`'s planner and `lib/doc/formSectionMutations.ts` re-home each view
  write of a moved field that sits on a child `create` keyed by its old repeat to the `create` of
  `(type, new repeat)`, creating or removing creates as `planFieldCaseWrite` does, so today's
  re-bucketing stays automatic. Own and worker writes stay where they are, and the gate decides
  (a write read from inside a repeat is the checker's `many-values`).
- **Removal**: `removeField` callers append `planFieldCaseWrite(…, null)` for every field of the
  removed subtree before the removal.
- **Kind conversion**: `lib/doc/kindConversionCascade.ts` converts a written question to a label or
  container only after `planFieldCaseWrite(…, null)`, as it clears today's `caseWrite`.
- **Choices**: `lib/doc/caseWriteChoices.ts::caseWriteChoiceVerdict` dry-runs `planFieldCaseWrite`
  and the gate.
- **Readers**: `kindConversionCascade.ts`, `casePropertyRenames.ts` (a property rename rewrites
  write keys and the `form-case` defaults that read the property), `caseTypeRetirement.ts`,
  `unwrittenProperties.ts`, `datetimeSplit.ts` (the split's original keeps every write that reads
  it, which the view now names) and `lib/doc/caseOperationMutations.ts` read views and operations.

### 16.5 Authoring changes each pull request is forced to carry

The rest is part 07's (pull requests 12 and 13).

- **Pull request 2**: §10.1.
- **Pull request 4**: `addFields` and `editField` keep `caseWrite: {caseType, property}` and plan it
  through `planFieldCaseWrite`; a `caseWrite` on a question whose view holds more than one write
  stages nothing and returns part 07's sentence (part 07 §4.2): "Question “<id>” saves its answer
  to <n> places, and caseWrite would replace them all with one. You can change each with
  updateCaseOperation/update_case_operation, or set caseWrite to null first to stop every one.";
  `getField` returns `caseWrites` (the view) in place of `caseWrite`; `updateCaseOperation` accepts
  the `own` arm (`name`, `owner`, `writes`, `links`), while `addCaseOperations` keeps the three
  arms and its strict union refuses an `own` one; `removeCaseOperation` and `moveCaseOperation`
  refuse the own arm; `updateForm.close_condition` becomes form logic (an `Expression`, `null`
  clearing it), replacing the structured `{fieldUuid, answer, operator}`, because the stored
  `closeConditionSchema` it wrote is deleted; `getCaseOperations` returns the own arm first and each
  operation's `placement` (`"case management" | "save to case"`). The builder's `CaseWriteEditor`
  lists the view and edits each row through `planFieldCaseWrite`; `PreloadedValueRow.tsx` is
  deleted and the default row shows the `form-case` read as any default; part 07's
  `OwnCaseSection.tsx` replaces `CloseConditionSection.tsx` with the close form's **Close the
  case** row over the `Expression` (§6; the registration's rows are pull request 12's); the
  case-operations canvas lists the own arm first without a remove or a drag handle. These are the
  changes the model forces, since the replaced concepts (`Field.caseWrite`, the structured close
  condition, the implicit preload) leave every surface with it. `MODEL_CONTEXT_VERSION` becomes
  `"v6-hq-round-trip-case-writes.4"`. `scripts/test-schema.ts` registers `getCaseOperations`,
  `removeCaseOperation` and `moveCaseOperation`, and the changed tools' entries move; none is
  billed here (the one billed run is at pull request 13's head).
- **Pull request 5**: `withIdentityMoves` on every builder dispatch, undo and redo, and in the SA
  and MCP workspace hosts (`lib/agent/workspace/canonicalWorkspace.ts` and
  `lib/agent/change-set/workspace.ts`, in `applyBatch` and `applyStages`), where the hold entries
  join the batch before the verdict; tool bodies and `lib/agent/tools/common.ts::guardedMutate`
  change nothing (part 07 §2.7). `identityMoves` in tool results and `saveWork`; the
  `IdentityMoveDialog` (part 07; resolution 3). `getCaseOperations` adds `placementKept: true`.
  `MODEL_CONTEXT_VERSION` becomes `"v6-hq-round-trip-case-writes.5"`.
- **Pull request 13** (part 07): the new inputs no replaced concept needs. The field tool's
  `caseWrite` gains `via` and `onlyIfChanged`, planned through the same `planFieldCaseWrite`
  destination, which pull request 4 already takes; `updateCaseOperation`'s own arm writes gain
  `via` and `onlyIfChanged` (`onlyIfChanged` on both under G5 outcome A only, §26; the other arms' writes keep the plain write schema, so the strict
  schema refuses either there, §7, §8); the existing-target union gains `{kind: "worker-record"}`;
  `updateForm` gains `open_condition` and `close_condition`'s final description, which covers a
  registration's close. The model admits each shape and the gate holds its rules from pull request
  4: there `planFieldCaseWrite` writes the worker-record update for a question saving to
  `commcare-user`, and from pull request 12 the builder's rows (part 07 §3.2, §3.4) write `via`,
  `openCondition` and, under G5 outcome A only, `onlyIfChanged`.

### 16.6 The planners the cutover and the fuzz mapping share (pull request 4)

Two pure, deterministic planners turn today's stored facts into this part's model. Part 09's
transform and part 08's fuzz mapping call them, and they stay in `lib/doc` after pull request 16.

```ts
// lib/doc/fieldWriteOperations.ts (new)
export interface FieldWriteFact {
	readonly fieldUuid: Uuid;
	readonly caseType: string;
	readonly property: string;
	/** A capture kind: its value is `capture-link`. */
	readonly capture: boolean;
}
/** The mutations that give `formUuid` the operations its field writes made
 *  (`facts` in data-tree order): C1 to C3 of §22. */
export function operationsFromFieldWrites(
	doc: BlueprintDoc,
	formUuid: Uuid,
	facts: readonly FieldWriteFact[],
): readonly Mutation[];

// lib/doc/explicitPreloads.ts (new)
/** The mutations that give each listed writer `default_value` = the `form-case`
 *  read of its property, replacing any default: C7 of §22. */
export function planExplicitPreloads(
	doc: BlueprintDoc,
	formUuid: Uuid,
	writers: readonly Uuid[],
): readonly Mutation[];
```

`operationsFromFieldWrites` buckets each fact as today's inventory does (the module's case type,
`commcare-user`, or a declared direct child keyed by `(caseType, nearest repeat)`, the relationship
the catalog's), and writes the own arm at index 0, a `create` per child bucket and one
worker-record `update`, in §22's order. Each operation's UUID is
`lib/domain/caseWriteOperationIdentity.ts::caseWriteOperationUuid(appId, formUuid, unit, attempt)`
(part 09 §10.1, UUIDv5 under the cutover's namespace, the first attempt no entity of the document
holds), and its `id` is the one §22 gives (the own arm the module's case type, a create its type,
each made unique among the form's operation ids by `lib/domain/idSlug.ts::suffixUntilFree`), so a
dry run and its execution, or a fuzz draw mapped twice, name the same operations.
`planExplicitPreloads` writes no default on a Hidden Value with a `calculate`; which writers it
receives is the caller's (the cutover's frozen preload rule, a fuzz draw's own-case writers).

## 17. Validator codes

Every code is soundness (`lib/commcare/validator/gate.ts::classifyError`). `lib/doc/userFacingErrors.ts`
gives each new and changed code its builder sentence, which is the finding's message with the form
and operation named as the builder names them.

| Code | From step 5 |
|---|---|
| `CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT` | retired (pull request 2, §10.1): no property holds an attachment |
| `CASE_WRITE_NO_CASE_ACTION` | retired (pull request 4): no field writer exists; `CASE_OWN_OPERATION` reason `form-type` holds an own arm on a survey |
| `CASE_WRITE_UNKNOWN_TYPE` | retired, into `CASE_OPERATION_UNKNOWN_CASE_TYPE` |
| `CASE_WRITE_NOT_DIRECT_CHILD` | retired: an operation may create any declared type; the planner keeps the field gesture to own, ancestor, child and worker |
| `PRIMARY_CASE_FIELD_IN_REPEAT` | retired, into the checker's `many-values` reason `repeat` at the own arm's write |
| `USERCASE_FIELD_IN_REPEAT` | retired (§9) |
| `CASE_CREATE_NAME_DUPLICATE` | retired: a name is one facet |
| `RESERVED_CASE_PROPERTY` | retired, into `CASE_OPERATION_RESERVED_PROPERTY` |
| `CLOSE_CONDITION_INCOMPLETE`, `CLOSE_CONDITION_FIELD_NOT_FOUND` | retired (§6) |
| `CASE_WRITE_DUPLICATE_PROPERTY` | kept: reason `operation` (two writes of one key in one operation, or a `case_name` write beside `name`, an `owner_id` write beside `owner`): "“{op}” saves {property} twice. You can keep one of them."; reason `own-case` (§5.3, rule 1): "“{op}” saves {property} to this form's case, which this form's own change already saves. You can save it in one of the two." |
| `CASE_CREATE_NAME_MISSING` | kept, for an own arm on a registration without `name`: "“{form}” creates a case, so its case needs a name. You can choose the question that names it." |
| `CAPTURE_CASE_WRITE_STANDARD_PROPERTY` | kept, for a `capture-link` as a `name` or written to `external_id` |
| `USERCASE_WRITE_UNDECLARED_PROPERTY`, `USERCASE_WRITE_MANAGED_PROPERTY` | kept, located at the worker-record write |
| `CLOSE_CONDITION_WRONG_TYPE` | kept, admits registration and close: "Only registration and close forms close their own case, and “{form}” is a {type} form. You can remove the close condition or make it a close form." |
| `CASE_OPERATION_TARGET_INVALID` | gains reasons `worker-record-type` ("The worker's record is a commcare-user case, so only an update of commcare-user can save to it."), `worker-record-twice` ("This form already saves to the worker's record in “{op}”. You can add these saves there."), `worker-record-facet` ("The worker's record can only be updated, so “{op}” can't {facet}.", `{facet}` one of "rename it", "change its owner", "change its type", "link it to another case", "run on a condition", "run for each row of a repeat") |
| `CASE_OPERATION_TARGET_TYPE_MISMATCH` | its "ordinary" subject reads "this form's own case" |
| new `CASE_OWN_OPERATION` | §5.2. `missing`: "“{form}” is a {type} form, so it needs a change for its own case, and it has none. Setting the form's type again adds it."; `duplicate`: "“{form}” has two changes for its own case. You can move the saves of one into the other and remove it."; `position`: "The change for “{form}”'s own case has to come first. You can move the other changes after it."; `form-type` on a survey: "“{form}” is a survey, so it has no case of its own to change. You can remove this change or choose another form type."; `form-type` in a module without a case type: "“{module}” has no case type, so “{form}” has no case of its own to change. You can give the menu a case type or remove this change." |
| new `OPEN_CONDITION_WRONG_TYPE` | "Only a registration form creates its case on a condition, and “{form}” is a {type} form. You can remove the condition or make it a registration form." |
| new `CASE_OPERATION_CLOSES_OWN_CASE` | §5.3, rule 3: "“{op}” closes this form's own case. You can make “{form}” a close form, which closes it, and remove this change." (on a close form: "“{form}” already closes its own case. You can remove “{op}”, or set when it closes in the form's settings.") |
| new `CASE_WRITE_VIA_INVALID` | §7. `new-case`: "{property} is saved to the case above a case this form creates, and that case has no link yet while the form is open. You can save it from a form that opens the existing case."; `target`: "Only this form's own case can save to the case above it. You can add a case change that updates that case instead."; `step`: "CommCare HQ saves to a case above only through a parent or host link, and “{identifier}” is neither."; `unresolved`: "{property} is saved through a link that doesn't lead to a case type. You can choose the case above it again."; `placement`: "This form's case is saved through Save to Case, which saves one case per block. {first failed condition's sentence} You can save {property} with a case change that updates that case instead." |
| new `CASE_WRITE_ONLY_IF_CHANGED_INVALID` | §8. `new-case`: "{property} is saved to a case this form creates, so there's no earlier value to compare with. You can save it every time instead."; `target`: "Only this form's own case can save just the answers that changed. You can save {property} every time instead."; `placement`: "This form's case is saved through Save to Case, which can't save only changed answers. {first failed condition's sentence} You can save {property} every time, or change the form so Case Management can hold it." |
| new `HELD_PLACEMENT_INEXPRESSIBLE`, `CASE_PLACEMENT_SHARED`, `HELD_BLOCK_PATH_TAKEN` | §13.2 (pull request 5) |

Checker reasons (`lib/domain/expression/typeChecker.ts`, under each slot's own code):
`expected-value` reason `capture-answer` (a bare `field` read of a capture as a write value): "A
captured file reaches a case as a link to it. You can save capture-link(#form/{id}) instead.";
`arm-unavailable` reason `capture-link-slot` ("capture-link works only as the whole value a case
change saves.") and reason `capture-link-field` ("capture-link reads a question that captures a
file, and {question} doesn't.").

`caseWriteFindings.ts`, `caseWriteAdmission.ts`, `deriveCaseConfig.ts` and `caseWriteInventory.ts`
are deleted in pull request 4; `validator/rules/caseOperations.ts` holds the own arm's rules,
`validator/rules/form.ts` the two condition rules, `validator/rules/casePlacement.ts` the held
rules.

## 18. Emission (pull request 4, through part 02's `planFormCaseWire`; its advanced arm in pull request 7)

What each placement writes is part 02's plan (`lib/commcare/casePlacementPlan.ts::planFormCaseWire`,
part 02 §3), which lands in pull request 4 with its basic and Save to Case arms; this section states
what this part's model asks of it.

- **Basic `FormActions`** (`lib/commcare/formActions.ts`, the basic projection of the plan over `planPlacements` and the
  operations): the own arm in the basic own slot writes `open_case` (registration: `name_update`
  from the `nova_trimmed_<q>` sibling, `condition` from `openCondition`) or `update_case`
  (`condition: always` as the page saves it); its writes, `owner` (key `owner_id`) and a loading
  form's `name` (key `name`) go to `update_case.update`, each `update_mode` `"edit"` where
  `onlyIfChanged`, else `"always"`, and each `via` write under its index key; the own close is
  `close_case` with its condition, or `never` when it takes its own Save to Case block.
  Conditions print as `FormActionCondition {type: "if", question: <path>, answer: <text>, operator:
  "=" | "selected" | "boolean_true"}` from the stateable shape (`answer: null` for
  `boolean_true`), `always` for absent or `match-all`. The usercase slot writes `usercase_update`.
  Each basic subcase writes `OpenSubCaseAction` at its index with `repeat_context` from its name
  question's repeat path, `condition` from its condition, `close_condition` from a sharing close
  (`never` otherwise), `relationship: "child"`, `reference_id: ""`, `owner_id` among
  `case_properties` when it has `owner`. `case_preload` is never written.
- **Save to Case** (`lib/commcare/xform/caseOps.ts`): every subject placed in Save to Case, at its
  held or allocated path, in array order within its scope; the own arm's block first in the root
  group (§5.3, rule 4); a `capture-link` value as `captureUrlCalculate` over the capture's path.
  `formEmitsSaveToCase(doc, formUuid)` is "some placement of the form is `save-to-case`".
- **The local `.ccz` builder** (`lib/commcare/xform/caseBlocks.ts`) writes the basic blocks as HQ's
  build does, `update_mode: edit` rows with the comparison (§8), `via` keys through the index chain,
  no `<attachment>`.
- **What does not change on the wire.** For every document the cutover produces from a stored app,
  each operation's placement is the one today's emitter writes (part 09 holds it for a published
  app, §22; a field-written extension create keeps its `nova_subcases` block through pull request 6,
  §12.3), so pull request 4 changes no case block, update row or Save to Case block of a
  migrated corpus document. What it changes is defect 28's fix: every preload leaves HQ JSON's
  `case_preload` and becomes a default setvalue at its question's place in the source, so a
  case-loading form's export changes wherever it preloads, and what a worker sees changes only
  where a later default reads the writer (`targeted-load-time-values`). No `<attachment>` stands
  anywhere from pull request 2 (defect 23).

## 19. Preview (pull request 4)

- **Defaults run in their place.** `lib/preview/engine/formEngine.ts` drops
  `shouldPreloadPrimaryCase`, `seededWriters`, `primaryCaseWritesByField`, `projectedCaseWrites`
  and the preload pass after defaults; a `form-case` default prints the casedb read over the device
  snapshot, which is the case. `answerCast.ts` casts as today.
- **The submission program carries every case change.** The submission mutation keeps its arms and
  the loaded case ids they carry, but the ordinary action's writes, child buckets, usercase writes
  (`collectUsercaseWrites`) and close (`computeCloseConditionAnswers`, `closeConditionAnswers`)
  leave it: the own arm, its open and close conditions, the child creates and the worker-record
  update run in the operation program (`lib/case-store/postgres/submissionEnvelope.ts`,
  `lib/case-store/submission.ts`), in array order, their conditions evaluated by the
  `Expression`→Kysely compiler with form answers bound through `operationAnswers` as every
  operation's are. The envelope's header line "then the ordinary form action last" becomes "the own
  case's change first, as the array holds it; §5.3's rules make that the wire's meaning".
- **The own arm in the program**: on a registration its create is skipped when `openCondition` is
  false, as a conditional create is today; a close runs after its writes when `closeCondition` holds
  (absent: always on a close form, never on a registration).
- **`onlyIfChanged`**: §8. **`via`**: the write goes to the ancestor the index chain reaches in the
  pre-submission snapshot; no ancestor, no write (HQ writes to an empty id, which case processing
  drops).
- **`capture-link`**: unwritten, as a link write is today (`content/docs/attachments.mdx`).
- **Placement is not read.** §5.3's rules make the array order the wire's meaning on every platform,
  so Preview applies operations in array order whatever their placement.
- `RUNTIME_VERSION` moves once, to 18, in pull request 3 (resolution 14); pull request 4's change of
  what an App Test evaluates rides the same deploy.
- `lib/preview/app-tests/submission.ts` and `evaluate_form` read the same engine.

## 20. Manifest entries and register moves

### 20.1 Register moves

- **Pull request 2: defect 23, all 79 entries** move from `proof/known-defects.json` to
  `proof/fixed-defects.json`, each without `document`, keeping id, check, artifact, path, kind and
  control (the 5 `manifest`, the 2 `intent`, the 72 `proof4`). The corpus documents that held
  attachment-mode writes emit link writes from this pull request (part 08's fixture mapping); their
  new exports hold no `<attachment>`, which the fixed entries' rule holds on every later run. This
  lands before pull requests 4 and 7 (the stack's ordering constraint), so neither re-paths a live
  defect 23 entry.
- **Pull request 4: defect 28's 3 entries** (`d28-load-time-values-app-form-actions`,
  `d28-load-time-values-app-formactions-case-preload`, `d28-load-time-values-app-preloadaction-preload`)
  move to fixed on their control `targeted-load-time-values`. `proof/targeted/documents/loadTimeValues.ts`
  is rewritten: its weight writer carries the explicit preload, its export holds no `case_preload`,
  the note's default reads the case value (its `values` pin the case's weight), and its header
  describes the explicit preload. `OPEN_DEFECTS` loses 23 in pull request 2 and 28 in pull
  request 4: these three are every defect 28 entry the register holds, and part 04's markdown half
  (pull request 9) moves none.

### 20.2 Manifest entries (`lib/commcare/surface/entries/forms-and-case-writes.json`, `questions.json`, `gates.json`)

| Entry | Today | From step 5 (pull request) |
|---|---|---|
| `forms-and-case-writes/a-writer-question-with-no-case-preload-update-only` | HELD-NEW | HELD (4): an own writer without a default emits no preload |
| `forms-and-case-writes/case-preload-question-property-into-a-question-outside-any` | HELD | HELD; its emission cell reads "a Vellum default value"; Nova writes no basic `case_preload` |
| `forms-and-case-writes/case-preload-from-parent-paths-into-a-question-outside-any` | HELD | HELD; Nova writes the ancestor `form-case` read as a default, which the manifest classifies as an XForm setvalue |
| `forms-and-case-writes/case-preload-from-any-other-index-path-host-user-a-mixed-path` | HELD-NEW | HELD-NEW (step 6 imports it) |
| `forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` | REFUSED | unchanged; no export writes `case_preload` |
| `forms-and-case-writes/conditionalcaseupdate-update-mode-edit` | HELD-NEW | HELD (4), outcome A of G5 (§26) |
| `forms-and-case-writes/update-key-whose-index-segments-are-each-parent-or-host-parent-p` | HELD-NEW | HELD (4) |
| `forms-and-case-writes/update-key-owner-id` | HELD-NEW | HELD (4) |
| `forms-and-case-writes/close-case-condition-if-operator-boolean-true-on-a-requires-case` | HELD-NEW | HELD (4) |
| `forms-and-case-writes/form-requires-none-open-case-condition-if` | HELD-NEW | HELD (4) |
| `forms-and-case-writes/form-requires-none-open-case-close-case-active` | HELD-NEW | HELD (4) |
| `forms-and-case-writes/subcases-condition-if` | HELD-NEW | HELD (4) |
| `forms-and-case-writes/subcases-close-condition-active` | HELD-NEW | HELD (4) |
| `forms-and-case-writes/update-from-an-upload-question-attachment-mode` | REFUSED | unchanged; no export writes it from pull request 2 |
| `questions/attachment-inside-a-savetocase-block` | REFUSED | unchanged; no export writes it from pull request 2 |
| `forms-and-case-writes/subcase-of-the-module-s-own-case-type-in-a-project-space-with` | REFUSED (gate `DONT_INDEX_SAME_CASETYPE`) | unchanged; held by part 03's probe |
| `gates.json` `toggle/SAVE_ONLY_EDITED_FORM_FIELDS` | `preflight: precondition` | `{kind: "capability", cell: "flag probe; save-only-edited-answers"}` (4) |
| `gates.json` `toggle/MM_CASE_PROPERTIES` | `preflight: refusal` | unchanged; the probe stops asking it (2) |

Each flip lands with its inventory row edited in the same pull request
(`docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md`; `lib/commcare/CLAUDE.md`,
"The surface manifest") and with the targeted document that first emits it (part 08's name:
`targeted-case-writes-one-concept`, which holds the writes and the open and registration close
conditions alike). None of these entries reads apart by platform (each `RUNS / RUNS`),
so no platform-table row and no Preview cell changes.

## 21. Proof the lane gains (names are part 08's)

- **`targeted-case-writes-one-concept`** (`proof/targeted/documents/caseWritesOneConcept.ts`, pull
  request 4, declared for both platforms; part 08 adds it to its list, since none of the fourteen
  holds these shapes): a basic module; a registration whose own arm writes three questions, opens
  under a select condition and closes the case it creates under a close condition whose answer is
  a `choice` of a static select; a child create at the root and one in a repeat (basic subcases,
  one `subcase-row` and one at `subcase_0`), and a worker-record update; a follow-up with an
  explicit preload, a writer without one, a `via: parent` write and an `onlyIfChanged` write; an
  operation that takes Save to Case because it writes a computed value, so that form alone needs
  `save_to_case`. Its configurations grant `SAVE_ONLY_EDITED_FORM_FIELDS`
  (`proof/checks/configurations.py`). Its written D′ renames the choice's value, so proof 5 holds
  the reprinted answer. It flips the writes' and the conditions' manifest entries of §20.2, and
  carries G3 and G5 (§26).
- **`targeted-held-placement`** (`proof/targeted/documents/heldPlacement.ts`, pull request 5): form
  "Update", whose own update holds a basic slot, and form "Weigh", whose operation holds Save to
  Case because it writes a computed value. Written D′ adds to Update a write the basic slot cannot
  hold, and removes Weigh's computed write. It witnesses the move to Save to Case stated and
  committed with the edit (proof 1 inside the edit's footprint, proof 5 outside it, part 08 §5.1),
  and Weigh's held Save to Case path unchanged though its simplest placement is now basic (proof 1
  across A and the edited B). In pull request 5 its spec authors D's holds in the document, as the
  cutover and import write holds; from pull request 6 its first publish records the same holds
  through the capture's placement record (part 08 §1.3 and §4.5), and D′ is planned over the held document
  either way.
- **`targeted-same-type-child`** (pull request 8, part 03): its D is a follow-up form creating a
  child of its own menu's case type at a basic slot, the shape §12.2's interim exclusion keeps out
  of every export before pull request 8.
- **`targeted-load-time-values`** rewritten (§20.1); `proof/targeted/documents/closeConditions.ts`
  rewritten in pull request 4 to hold its four parts as `Expression`s: the quoted `"done"`, the
  `x' or 'y` answer and the text question keep their Save to Case closes; the select part compares
  with the literal `c`, which the parser keeps a literal because no option holds it, so it keeps
  its Save to Case close (`condition-not-a-choice`).
- **Native**: `proof/native/core/CaseOperationRuntimeTest.java` gains G1's cases and an
  `onlyIfChanged` case (the edit expression evaluated over a native case instance, on both export
  paths).
- **Fuzz**: the generators' draws of field writes map, after the draw, to operations at the
  simplest placement through the two planners the cutover shares (§16.6),
  `lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites` and
  `lib/doc/explicitPreloads.ts::planExplicitPreloads` (part 08 §4.3); a drawn attachment mode
  maps to a link write (pull request 2).

## 22. Migration classes for the one cutover

Part 09 runs these in its transform (resolution 12: raw old-shape read, structure phase, head parse,
semantics phase with production planners), in its step order, before placements are recorded. Each
class names its part 09 step; notice reasons are resolution 13's.

Every class ships and runs on every app. The production scan (§26) says which meet work today:
C9's shape is stored in production, so C9 rewrites forms at the window; C5 meets no app today
(production holds no capture write of any mode), and the dry run counts it, because an author can
add one until the window closes ingress; C10 and C11's shapes were not counted by the planning
scan, so the cutover's advisory dry run decides whether each has work, and where it meets none the
class writes nothing and stays the transform's guard.

| # | Class | Old → new | Part 09 step | Notice |
|---|---|---|---|---|
| C4 | capture link mode | a capture `caseWrite` with `mode: "url"` loses `mode` | `capture-link-writes` (structure) | none |
| C5 | attachment mode | a capture `caseWrite` with `mode: "attachment"` loses `mode`, becoming a link write; the dry run counts it, and production holds none today | `capture-link-writes` (structure) | `capture-saves-link` per field; deployment `case-attachments-stop` where a published deployment's baseline holds the attachment |
| C6 | close condition | `{field, answer, operator}` → `eq(term field, A)` for `=` or no operator, `multi-select-contains(term field, [A], any)` for `selected`; `A` the `choice` of the field's inline option whose value is `answer`, else the literal `answer` | `close-condition-expression`, a structure step part 09 adds before the head parse (the head schema refuses the old shape) | none: the same close runs |
| C1 | own arm | every registration, follow-up and close form of a module with a case type gets an own arm at index 0: `id` the module's case type made unique; `name` the bare read of its `case_name` writer (a registration's name, a loading form's rename); `writes` every other writer of the module's type, in data-tree order, a capture's as `capture-link` | `writes-into-operations` (semantics), through `operationsFromFieldWrites` (§16.6) over the lifted `FieldWriteFact`s | none |
| C2 | child writers | each `(caseType, nearest repeat)` child bucket of the frozen `deriveCaseWriteInventory` → a `create`: `id` the type made unique, `name` its `case_name` writer, `writes` the rest, one `parent` link (relationship from the catalog, `child` or `extension`) to the own case, `forEach` the repeat. An extension bucket's create is placed by part 02's M1 (carried or not) | `writes-into-operations`, through `operationsFromFieldWrites` | none |
| C3 | worker writers | the `usercase` bucket → one worker-record `update` | `writes-into-operations` | none |
| | order | the own arm at 0; then, scope by scope in `caseOperationMultiplicityScopes` order, the stored operations of that scope in their order followed by that scope's new creates in bucket order; the worker-record update after the root scope's operations. That keeps every array rule, and §5.3's rules make it mean what today's wire does | `writes-into-operations` | none |
| C7 | preload | every field the frozen `writerPreloadsFromLoadedCase` preloads gets `default_value` = the `form-case` read of its property, replacing any default; a Hidden Value with a `calculate` gets none. Production holds preloaded writers, some with a default the step replaces and some read by a later load-time value | `explicit-preloads`, through `planExplicitPreloads` (§16.6) | `starting-value-reads-case` where a default was replaced; `load-time-value-reads-case` for each later default (or query repeat setvalue, part 04) in data-tree order that read such a writer |
| C8 | placements | every operation and own close (and, part 04's, every query repeat) of a published app | `placements` | deployment `form-data-paths-move`; `placements-kept-unread` (resolution 5) |
| C9 | close operations on a follow-up's own case (stored in production) | part 09's rule (part 09 §7.4, §5.3 above): the form becomes a close form whose `closeCondition` is the `or` of its own close and each such operation's `condition` (any absent term makes it absent); an operation without writes is removed; one with writes becomes an `update` of the session case with the same `uuid`, `id`, `condition` and writes; in a published app `Form.ownClosePlacement` holds the path the first removed operation had, and where every such operation carried writes the own close takes its simplest placement unheld; such an operation under `forEach` is the blocker `own-close-in-repeat` | `writes-into-operations`, before C1 | `form-became-close-form` for a follow-up form it makes a close form (a close form keeps its type: no line); deployment `form-data-paths-move` with the cause `own-close-moved` where the own close moved |
| C10 | another operation writing what the own arm writes (not counted by the planning scan; the dry run decides) | that operation's write of the property is removed (an operation left with no write, name, owner, link, rename or retype is removed) | `writes-into-operations`, after C1 | none: the ordinary action's write already replaced it on every platform |
| C11 | a registration with an operation that updates or closes the case it creates (not counted by the planning scan; the dry run decides) | nothing in the document; the own arm takes Save to Case (`case-changed-before-create`) and, where a published baseline carries it at the basic own slot, C8 cannot hold that slot, so the deployment line `form-data-paths-move` gains the cause `case-changed-before-create` (part 09's cause list) | `placements` | deployment `form-data-paths-move` |

**C8, the rule** (resolution 5, part 09 §3.6). A subject is held at the placement a published
deployment's baseline carries it at; for a deployment whose baseline is unread, it is held at the
placement today's emitter gives it, computed by part 09's frozen copy of today's classifier
(`deriveCaseWriteInventory`'s buckets and today's Save to Case paths). Production holds such a
deployment, so the unread rule and `placements-kept-unread` meet apps at the window (a query
repeat whose rule gives the count placement is part 04's one exception: it moves to count). A
deployment whose live app mapping is marked remote-missing counts as published (part 03), since
HQ's submissions keep their `xmlns`; a baseline whose bytes fail to decompress, match their digest
or parse is part 09's blocker `baseline-unreadable`, whose remedy is refreshing that deployment.
The baseline is read through part 03's `lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks`
(pull request 6). For the basic slots the
match reads the baseline form's `actions` (`open_case` or `update_case` for the own arm, `subcases`
at the index with the same `case_type` and `repeat_context`, `usercase_update`), and records a
repeat's basic subcase as `subcase-row` where its repeat context holds one subcase, `subcase` with
the index otherwise; for Save to Case, the source element at the path with `vellum:role="SaveToCase"`
and the unit's `vellum:case_type`, and the `repeat` its scope names. An unpublished app records
nothing. Today's own close in Save to Case is the own-close subject at
`[nova_operations, nova_condition_close, nova_close]`. A several-case form's own arm is held at
today's selected-cases block path. A carried create's Save to Case placement is never held (§12.2,
part 02 §14.5), and no basic placement or module kind is held for a module part 02's M1 makes
advanced. No published baseline holds a `nova_subcases` block today, so no extension child's path
is held at the window. The transform's postcondition is the gate: a held placement the
head's `planPlacements` finds inexpressible is the blocker `placement-path-mismatch` (part 09), a
defect of the stack.

**What the scan decided.** The rules of §5.3 and §12.2 land in pull request 4 whatever the
cutover meets. C9 has work in production; C10 and C11 are decided by the advisory dry run; C5 meets
no app today; C7 meets replaced defaults and later load-time readers; C8's unread rule meets
published deployments.

## 23. Contracts and docs sentences (part 10 places them)

1. `docs/architecture/contracts.md`, "Identity and references": "An eligible field writes case data
   only through `caseWrite: { caseType, property }`; changing `id` changes the friendly form path
   only, and changing `caseWrite` retargets only that writer." becomes "A form writes case data only
   through its case operations, and the form's own case is one of them; a field's "Saves to" is the
   view of the writes that read its answer. Changing a field's `id` changes the friendly form path
   only, and changing "Saves to" retargets only those writes."
2. `docs/architecture/contracts.md`, "Case attachment display is link-first. … The deprecated
   `MM_CASE_PROPERTIES` attachment mode is an explicit opt-in …" becomes "**A captured file reaches
   a case only as a link.** A write's `capture-link` value is the CommCare HQ address of the
   submitted file, and a `link` column makes it openable. Nova writes no case attachment."
   (pull request 2 makes the old row false; part 10 lands the new one in pull request 15 with every
   `contracts.md` change.)
3. `docs/architecture/contracts.md`, a new row: "**A placement, once published, is kept.** Each case
   change's placement (a Case Management action, an advanced action and its tag, or a Save to Case
   block path) is recorded by the publish that first carries it. An edit the held placement cannot
   express moves it, and the builder, SA and MCP say so before it commits." (beside part 03's
   `publish-placement` row).
4. `docs/architecture/complex-apps.md`, "Field id, case writes, and app-wide property rename": the
   paragraphs on `caseWrite` and `deriveCaseWriteInventory` become the own arm, the field's view,
   and the placement procedure; the scalar-text paragraph stays. "A capture's `caseWrite` carries a
   required `mode`…" becomes "A capture reaches a case as a `capture-link` write…".
5. `lib/domain/CLAUDE.md`: "Question identity and case storage are separate" and the
   `caseWriteInventory.ts` paragraph become the own arm, `caseWriteViews.ts` and
   `planFieldCaseWrite`; the capture-mode sentences of "Fields are a registry" become `capture-link`;
   in "Four form types", the `casePreload.ts` sentence becomes "`casePreload.ts::fieldPreload` reads
   a field's preload, which is its default value when that default reads a case property the form
   loads; `writerOffersPreload` says when a new writer is born with one", and
   "`closeCondition.ts::closeConditionPlacement` … not yet a property an author holds" becomes the
   held placement (`placements.ts`) and the stateable condition.
6. `lib/commcare/CLAUDE.md`: the case-preload bullet becomes "Nova writes no `case_preload`; a
   preload is the question's default."; the capture attachment block bullet is deleted;
   "Authored case-operation emission" gains a paragraph on `placement.ts::planPlacements`, held
   placements and the own case's independence, and loses the `closeConditionPlacement` sentences;
   "Hidden fields carry one value source" loses "the case preload below beats a `default_value`".
7. `lib/doc/CLAUDE.md`: the case-operation bullets gain the own arm, write keys with `via`,
   `planFieldCaseWrite`, `planFormTypeChange`, `fieldWriteOperations.ts` and `explicitPreloads.ts`
   (pull request 4), and `placementMoves.ts` and `HELD_PLACEMENT_INEXPRESSIBLE` (pull request 5).
8. `lib/preview/CLAUDE.md`, "Form engine lifecycle rules": "primary case preloads are appended last"
   becomes "a preload is a default and runs in its place"; "Ordinary followup preloads still override
   defaults…" is deleted. `lib/case-store/CLAUDE.md`: the submission program carries the own case's
   change; the ordinary action leaves.
9. `lib/agent/CLAUDE.md`, "Effective reads": "The case preload rule remains in
   `lib/domain/casePreload.ts`; selected-record values can supersede explicit defaults, including
   with blank." becomes "A preload is a default value that reads the case
   (`lib/domain/casePreload.ts::fieldPreload`)."
10. Public docs, all in part 10's pull request 15: `content/docs/case-changes.mdx`, "Forms that open
    an existing case" (questions open with the case's value because Nova sets their starting value
    to it, which you can change or remove; a later starting value reads the case's value);
    `content/docs/attachments.mdx` deletes "Saving the file itself" and the sentence on two answers
    to what reaches the case (made false by pull request 2); `content/docs/building-with-nova.mdx`,
    the Hidden Value sentences; `content/docs/publishing.mdx` deletes the sentence on "The file
    itself" (made false by pull request 2); `content/docs/project-space-compatibility.mdx` drops
    "Attachments saved to cases" (made false by pull request 2) and adds "Save only answers that
    changed"; `content/docs/mcp/tools.mdx`, the field's `caseWrite`, `getField`'s `caseWrites`, and
    the operations' `via`, `onlyIfChanged` and `worker-record`. The subtree `CLAUDE.md` sentences of
    items 5 to 9 move in the feature pull request whose change makes them false (part 10).

## 24. Tests

Each test names the failure it catches, at the smallest boundary that can show it
(`docs/testing.md`). None is a React state test.

### 24.1 Pure

| File | What it proves, and the failure it catches |
|---|---|
| `lib/domain/__tests__/caseWriteViews.test.ts` (new, 4) | A bare `field` read in each spelling, and `capture-link`, are in the view, in name, owner and write slots; a filtered read, a read inside an expression and a `role: query-wrapper` read are not; `destination` for own, `via`, child (child and extension links), worker record and other; order. Catches the builder showing a write the field does not own, or missing one it does. |
| `lib/domain/__tests__/casePreload.test.ts` (rewritten, 4) | `fieldPreload` for an exact `form-case` default of the own type and of an ancestor type, `undefined` for a default that contains the read inside another expression; `writerOffersPreload` true on a one-case follow-up's own write, false on a registration, a several-case form, a capture, a field with a `calculate` or a default, a `via` write; `hiddenWriterBlankNote`. Catches a preload offered where HQ would never have loaded one, and a hidden writer told it carries a value it doesn't. |
| `lib/domain/__tests__/placements.test.ts` (new, 4) | Each arm of `casePlacementSchema` parses; a path segment or tag holding `/` or a leading digit is refused; `subcase-row` refuses an `index`; `ownClosePlacementSchema` refuses a `repeat`. Catches a held path HQ cannot name. |
| `lib/commcare/__tests__/placement.test.ts` (new, 4; `inexpressible` 5; the carried-create clause and the advanced arm 7; the same-type lift 8) | One table, one row per condition of §12.2, each a pair: a form where the condition holds and the placement is chosen, and the same form changed in that condition alone where it is not, with the reason §12.8 names. The stateable condition's three shapes and each failure (a text question, a question in a repeat, `'`, a boundary `"` for the own case only, a literal opposite an inline select, a two-option choice under `=`, `match-none`); the several-case module with a registration admitted; the competition order (two worker-record updates refused by the gate; two child creates take indices 0 and 1 in array order); `subcase-row` for a repeat's only subcase and `subcase_<i>` when it has two; held indices kept with a gap filled lowest first, a held index of `k` failing; a held Save to Case path written verbatim, failing `scope` and `block-shape` as their rows say; a derived Save to Case placement carrying the allocator's exact path, suffix included; `excludeBasic` sending a basic-eligible create to Save to Case; a field-written extension create at `["nova_subcases", "nova_subcase_<n>"]` with its index counted for its repeat's nesting (4 to 6 only); a same-type create taking Save to Case (4 to 7) and a basic subcase from pull request 8; a create linked `parent` to the own case while its type's catalog parent is another type taking the basic subcase (§3.4); `inexpressible` listing every failed reason in table order; `placementCandidates` simplest first; a carried create refused every Save to Case placement. Catches an operation emitted where HQ's Case Management page rewrites it, and a held path that silently changes. |
| `lib/commcare/__tests__/sameTypeChildCases.test.ts` (new, 4; extended 8) | Pull request 4: a same-type create is not listed (it takes Save to Case), one held in a basic slot is, with `caseType` and `ownCase`. Pull request 8: a registration's unheld basic child of its own type is listed, one of another type is not, one placed in Save to Case is not. Catches a publish that misses the refusal or refuses a Save to Case child. |
| `lib/doc/__tests__/fieldWriteOperations.test.ts` and `explicitPreloads.test.ts` (new, 4) | `operationsFromFieldWrites` over facts of each bucket (own, child at the root and in a repeat, extension, worker, capture) gives C1 to C3's operations in §22's order, with the same UUIDs and ids on a second run and a UUID already taken stepped around; `planExplicitPreloads` replaces a default, skips a calculated Hidden Value, and its batch commits. Catches a dry run and its execution, or two fuzz mappings of one draw, naming different operations. |
| `lib/commcare/validator/rules/__tests__/caseOwnOperation.test.ts` (new, 4) | `CASE_OWN_OPERATION`'s four reasons and their messages; `OPEN_CONDITION_WRONG_TYPE`; `CLOSE_CONDITION_WRONG_TYPE` admitting a registration; `CASE_WRITE_DUPLICATE_PROPERTY` reason `own-case` over a `session` update on a follow-up and an `op` update on a registration; `CASE_OPERATION_CLOSES_OWN_CASE`; a retype of the own case refused only where the own arm writes. Catches an own arm the wire cannot run at either end. |
| `lib/commcare/validator/rules/__tests__/caseWriteFacets.test.ts` (new, 4) | `CASE_WRITE_VIA_INVALID` and `CASE_WRITE_ONLY_IF_CHANGED_INVALID` for each reason, the `placement` reason naming the first failed condition's sentence; the worker-record target's reasons. Catches a write the wire would build empty or write always. |
| `lib/commcare/validator/rules/__tests__/casePlacement.test.ts` (new, 5) | `HELD_PLACEMENT_INEXPRESSIBLE` on each kind of hold with its message; `CASE_PLACEMENT_SHARED` except the sharing close; `HELD_BLOCK_PATH_TAKEN` for a question, a Connect block and an operation id, with its suggestion. Catches a held path an author's name could displace. |
| `lib/domain/expression/__tests__/captureLink.test.ts` (new, 4) | `capture-link` admitted as a whole write value, refused in a condition, in a calculate and inside `concat`, refused over a text question; a bare capture read as a write value refused with `capture-answer`; `lib/commcare/xpath` parses `capture-link(#form/photo)` and prints it back. Catches a file name saved as case data. |
| `lib/commcare/__tests__/formActions.test.ts` (rewritten, 4) | Basic `FormActions` from placements: `open_case` with its condition, `update_case` with `update_mode: edit` and an index key, `close_case` printed from each stateable shape (`=`, `selected`, `boolean_true`) or `never`, `subcases` at their indices with `condition` and a sharing `close_condition`, `usercase_update`; no `case_preload` for any form. Catches an action HQ builds differently from what Nova means. |
| `lib/commcare/__tests__/caseBlocks.test.ts` (extend, 2 and 4) | Pull request 2 deletes the attachment cases; pull request 4 adds the edit-mode relevance over `casedb` and the `via` key's index chain, matching HQ's build text. Catches the local `.ccz` and HQ's build disagreeing (proof 3 catches it too, later and costlier). |
| `lib/commcare/__tests__/planPrivileges.test.ts` (extend, 4) | `save_to_case` asked for a form with one Save to Case placement and not for a form whose operations all take basic slots; `child_cases` only for a basic subcase placement. Catches a plan stop for a privilege no export needs. |
| `lib/commcare/__tests__/projectSpaceCompatibility.test.ts` (extend, 2 and 4) | Pull request 2: no capability `case-attachments` for any document; pull request 4: `save-only-edited-answers` asked exactly where an `onlyIfChanged` write exists, with `SAVE_ONLY_EDITED_FORM_FIELDS`'s slug and namespace from the gate entry. Catches a publish to a space whose build writes every row. |
| `lib/doc/__tests__/fieldCaseWriteMutations.test.ts` (new, 4) | Each destination row of §16.3 replayed through the reducers and `mutationCommitVerdict`: own write, own `name`, `via`, a child joining an existing create and making a new one, the worker's record, each refusal sentence, the preload born with its note, removal cascades, a move re-homing a child write. Catches a "Saves to" gesture that lands an invalid batch or loses a write. |
| `lib/doc/__tests__/formTypeMutations.test.ts` (new, 4) | Each row of §5.4 through the gate. Catches a type change that strands an own arm or a condition. |
| `lib/doc/__tests__/placementMoves.test.ts` (new, 5) | For each reason of §12.8 that an edit can cause, a document holding a placement, the edit alone refused with `HELD_PLACEMENT_INEXPRESSIBLE`, and the edit with `planOperationPlacementMoves`' entries accepted with exactly the expected move, its `from` and `to` labels and its reason; a renumbering move; a removal yielding no move; an unheld form yielding nothing; the undo of a move restoring the latest recorded hold and the re-creation of a removed held operation with its hold, each admitted by `placementChangeRefusal`. Catches a published path that changes without a statement, and an undo the kernel refuses. |
| `lib/doc/__tests__/mutations-forms.test.ts` (extend, 4) | `openCondition` and `closeCondition` set and cleared; `match-all` stored as absent where §3.5 says; the own arm's add, patch and the refused remove and moves (`own-first`); an `add`, an `update` patch or an `updateForm` patch carrying a held slot refused at admission. Catches a second spelling of "every time", and a hold written past `holdPlacements`. |
| `lib/doc/__tests__/diffDocsToMutations.fuzz.test.ts` (extend, 4 and 5) | Documents differing in the own arm, a `via` write and the conditions (4), and in a hold (5), diff to the payloads of §16.1, and the replay equals the target. Catches autosave dropping a hold or a keyed write. |
| `lib/doc/__tests__/incrementalValidationScope.test.ts` (extend, 5) | Each batch kind of §13.3 takes the whole-module scope; a batch in a form holding nothing takes today's. Catches a scoped commit that skips the held rules. |
| `lib/agent/tools/__tests__/caseWriteTools.test.ts` (new, 4) | Through `makeAuthoringHarness`: `addFields` with `caseWrite` plans the own write and its preload note; `editField` refuses a field with two views; `updateCaseOperation` edits the own arm; `removeCaseOperation` refuses it; `getField` returns `caseWrites`. Catches a tool that writes a second concept. |

### 24.2 Postgres

- `lib/db/__tests__/heldPlacements.postgres.test.ts` (new, 5): a document holding placements
  written through `writeApp` reads back the holds from its entity rows; an edit that strands one,
  committed through `commitGuardedBatch` without its move, is refused, and with
  `withIdentityMoves`' batch is accepted and folds through
  `lib/db/canonicalMutationFold.ts::replayCanonicalAppChangeSuffix` to the same head. Catches a
  persistence path that drops a hold, and the gate's absence on the server path.
- `lib/case-store/postgres/__tests__/submissionEnvelope.postgres.test.ts` and
  `lib/preview/engine/__tests__/submissionProgramAcceptance.postgres.test.ts` (extend, 4): the own
  arm creating under a false and a true open condition, a registration closing its case, a close
  form's conditional close, a `via` write to the parent, an `onlyIfChanged` write skipped when equal
  and written when not, the worker-record update. Catches Preview's case rows differing from what a
  device keeps.

### 24.3 Preview, native and the lane

- `lib/preview/engine/__tests__/` (extend, 4): the `targeted-load-time-values` shape, the explicit
  preload running in its place and a later default reading the case's value. Catches Preview
  keeping today's preload pass.
- Native: §21. The lane: §21 and part 08.

### 24.4 Deleted

`lib/domain/__tests__/caseWriteInventory.test.ts`, `lib/domain/__tests__/closeCondition.test.ts`,
and the attachment branches of `caseBlocks.test.ts` and `formActions.test.ts` (2). Rewritten over
operations in pull request 4, keeping their contracts: `lib/commcare/__tests__/caseWriteBoundary.test.ts`
(the builder's choice verdict, `editField`, the validator, the emitted actions and Preview agree on
one destination, now through `planFieldCaseWrite` and the view), `caseWriteEmission.test.ts`,
`repeatContextSubcase.test.ts` and `usercaseWriteWire.test.ts`. `lib/__tests__/docHelpers.ts`'s `f({caseWrite})` sugar stays and
lowers through `planFieldCaseWrite`, so fixtures keep stating content; the e2e helpers and targeted
documents that write `caseWrite` keep compiling through it.

## 25. Executed during planning

Nothing this part's planning ran was a paid call, a build, a test run, a lane run or a production
read. Planning read
Nova at `2f985ed6` (the files cited above, `biome.json`'s `lib/commcare` allow-list, and
`proof/known-defects.json` and `lib/commcare/surface/entries/*.json` with two small `python3` reads
for the counts and keys in §1.7 and §20), and the Dimagi checkouts at the pins with `rg` and reads:
`xform.py` (`_create_casexml`, `add_create_block`, `add_case_updates`, `action_relevance`,
`_add_usercase`, `get_action_path`), `models/form_actions.py`, `models/forms.py::session_var_for_action`,
`views/forms.py::edit_form_actions`, `static/app_manager/js/case_config_utils.js`,
`static/app_manager/js/forms/case_config_ui.js`, `case_config_ko_templates.html`,
`corehq/toggles/__init__.py`, and `Vellum/src/saveToCase.js`. The owner brief's further reads at the
same pins (§2) were made the same way.

The step's production scan (resolution 16) ran during planning with the person's yes: read-only,
in one read-only transaction, over every app, live and soft-deleted, printing counts only. Its
counts stay out of the repo; §26 states its findings for this part in words, and §5.3 and §22
fold them in.

## 26. Written and not yet run

- **G1, Core's order across placements** (pull request 4, native `CaseOperationRuntimeTest` on its
  lane's `native` family, both export paths). Cases: a Save to Case create in the root operations
  group whose `parent` link names the registration's own case, which the basic `case` block creates
  after it; and one whose link names a case a basic `subcase_0` creates after it.
  - Outcome A, Core indexes each new case to an id whose create stands later (what HQ's own basic
    subcases already rely on): nothing changes; §12.4 stands.
  - Outcome B, Core refuses either submission: §12.2 gains, for the basic own slot and the basic
    subcase slot, the condition "no operation placed in Save to Case links to the case it creates"
    (reason `case-linked-before-create`, sentence "A case change saved through Save to Case now
    links to the case it creates, before Case Management would create it."), so such a create
    takes Save to Case; `placement.test.ts` gains the pair; part 09's C8 is unchanged, because
    today's emission already writes these shapes and the lane holds them, which outcome B would
    contradict, so outcome B is also recorded in `harness-findings.md` as a claim corrected.
- **G3, a child's condition on its own repeat's question** (pull request 4's lane, started by hand
  as part 08 §8.4's row 4: `gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f
  mechanics=targeted-case-writes-one-concept,targeted-load-time-values,case-operation-link,targeted-migration-case-writes,targeted-migration-groups-preloads,case-operation-query
  -f mechanics_shards=auto -f mechanics_readers=true`, with every reader). The repeat child's condition
  reads a select in that repeat; HQ builds it and Formplayer's walk shows each row's child.
  - Outcome A, each row's child follows its own row's answer: §12.1's "innermost repeat is `R`"
    stands.
  - Outcome B, it does not: a child's condition is stateable only over a question in no repeat;
    §12.1, `placement.test.ts` and the targeted document change in the same pull request, and the
    claim is recorded in `harness-findings.md`.
- **G4, the form builder keeps the explicit preload** (pull request 4's lane, proof 4's two Vellum
  saves on `targeted-load-time-values`).
  - Outcome A, the save keeps the default, shown as `#case/` and written back as the same casedb
    read: the three defect 28 entries move to fixed as §20.1 says.
  - Outcome B, the save rewrites it: in the same pull request the preload's printed spelling
    follows what the form builder keeps (still a default; the spelling is the emitter's), so no
    admitted document holds the symptom and the three entries move as §20.1 says. Where the
    pre-fix bytes must keep showing the class, `targeted-load-time-values` is retained as a control
    from this pull request's own first run (`targeted-load-time-values-step5`) and the class is
    registered directly in `proof/fixed-defects.json` on that control with a new harness finding's
    number; no entry is added to `proof/known-defects.json` and `OPEN_DEFECTS` gains nothing
    (part 08 §2.6).
- **G5, the Case Management save keeps `update_mode: edit`** (pull request 4's lane, proof 4's
  editor driver on `targeted-case-writes-one-concept` with `SAVE_ONLY_EDITED_FORM_FIELDS` on).
  - Outcome A, kept (as `case_config_utils.js` reads and writes it): the flip of
    `conditionalcaseupdate-update-mode-edit` stands.
  - Outcome B, cleared: the entry becomes REFUSED, reason `not-hq-editable` (part 08 §2.6),
    `onlyIfChanged` is refused everywhere (`CASE_WRITE_ONLY_IF_CHANGED_INVALID` reason
    `not-hq-editable`, "CommCare HQ's Case Management page doesn't keep this setting yet, so Nova
    saves every answer."). In pull request 4 the capability `save-only-edited-answers` is not built
    (no `HqPrivateFeatureFlagId` or `ProjectSpaceCapabilityId` entry, no reason;
    `toggle/SAVE_ONLY_EDITED_FORM_FIELDS` keeps `preflight: precondition`, and
    `projectSpaceCompatibility.test.ts` asks it nowhere), `targeted-case-writes-one-concept` drops
    its `onlyIfChanged` write and its `SAVE_ONLY_EDITED_FORM_FIELDS` grant, and
    `CaseOperationRuntimeTest` drops its `onlyIfChanged` case; pull request 12 adds no **Save only
    if changed** switch (part 07 §3.2); pull request 13 adds no `onlyIfChanged` to the field tool's
    `caseWrite` or to `ownWriteInputSchema` (part 07 §4.2), and its `addFields` and
    `updateCaseOperation` schema-test prompts drop "only if changed" (part 07 §4.8). Step 7's outline gains the item with this reason (the Case Management save does
    not keep `update_mode: edit`). No register entry is added. The cutover has nothing to migrate
    either way: no stored document holds it.
- **G6, `DONT_INDEX_SAME_CASETYPE`'s effect** is part 03's (publish G4, resolution 8), with both its
  outcomes there.

**The production scan, as it decided this part** (resolution 16; its counts never enter the repo).
The classes this part reads, and what each finding settles:

- (a) `close` operations targeting `session` on follow-up forms: present. C9 ships and has work at
  the window, under part 09's rule (part 09 §7.4, §5.3 here); `CASE_OPERATION_CLOSES_OWN_CASE`
  lands in pull request 4, and because one deploy carries the stack and the cutover runs before it,
  every stored instance is migrated before the head's gate reads it. Whether such an operation stands under
  `forEach` or holds writes was not counted, so the advisory dry run says whether the blocker
  `own-close-in-repeat` or the cause `own-close-moved` meets an app; both ship.
- (b) capture writes of any mode: none. No attachment-mode write and no link write exists in
  production. C5, `capture-saves-link` and `case-attachments-stop` still ship: the dry run counts
  them, and production holds none today.
- (c) preloaded writers holding a default: present, so `starting-value-reads-case` meets apps; (d)
  a later load-time value reading a preloaded writer: present, so `load-time-value-reads-case`
  meets apps. Hidden writers with a `calculate` exist and get no default (C7).
- (e) `update` operations targeting `session`: present. They stay operations (§5.3); only C10
  removes a duplicate write.
- (f) operations writing a property a field writer of the same own case writes: not counted by the
  planning scan. Both outcomes stay written, and the advisory dry run decides: where it meets the
  shape, C10 removes each such write; where it meets none, C10 writes nothing and stays the
  transform's guard.
- (g) registrations with an operation that updates or closes the case the form creates: not counted
  by the planning scan. Both outcomes stay written, and the advisory dry run decides: where it meets
  the shape in a published app whose baseline carries the own arm at the basic own slot, the
  deployment line `form-data-paths-move` names the cause `case-changed-before-create` (already in
  part 09's cause list); where it meets none, C11 has no work.
- Beyond the classes: worker-record writes exist, so C3 has work; extension child writes exist in
  unpublished apps only, and no published baseline holds a `nova_subcases` block, so no extension
  path is held (part 02's M1); no same-type basic child create exists (§15); published deployments
  with an unread baseline exist, so C8's unread rule and `placements-kept-unread` meet apps.

## 27. Departures

From the research, the outline and the owner brief, each with its reason.

1. **The close condition is an `Expression`,** not `{field, answer}` with the answer widened to a
   choice (the outline's item 1): a second condition grammar would stand beside the one
   `Expression`, and a Save to Case close already takes any condition, which only an `Expression`
   holds.
2. **The open condition is an `Expression`** (the inventory row's `{type: if, question, answer,
   operator}`), for the same reason.
3. **The own case is an operation arm, `action: "own"`** (the research names the operation and no
   shape): §5.2's reason.
4. **The own arm stands first, and its independence is a rule** (the owner brief put it first
   without saying why the wire, which runs it last, agrees): §5.3. Rules 1 and 3 refuse shapes
   `main` admits, which C9 and C10 migrate (rule 3's shape is stored in production).
5. **`capture-link` is a term** (the research: a hidden value `nova_url_<id>`). The hidden value
   stays the basic slot's wire; the document holds the meaning, not the node.
6. **`via` and `onlyIfChanged` belong to the own arm** (and advanced loads), refused with reason
   `target` elsewhere (the owner brief admitted them on `update` arms): no `update` but the own
   arm takes a Case Management slot in a basic form, and a Save to Case block saves one case and has
   no such setting, so on any other operation they could never be written.
7. **One worker-record update per form** (the owner brief let the first take the usercase slot and
   the rest take Save to Case): two updates of one record would make their order matter where the
   basic block runs last, and one operation holds every worker write.
8. **The basic subcase has two placements, `subcase` with an index and `subcase-row`** (the owner
   brief had the index alone): HQ writes a repeat's only subcase at the row's `case`, so the index
   reaches no path there and the nesting is part of the identity (§2, claim 4). The advanced arm
   carries `row` for the same reason.
9. **A held Save to Case placement records its `repeat`** (the owner brief: the path alone), so a
   change of the operation's scope is detected (`scope`).
10. **Physical order is two eligibility conditions** (`case-changed-before-create`, `own-not-basic`)
    in place of the owner brief's annotated order analysis: those are the only two orders the array
    cannot show, and HQ's own indices to a later create make the third (an index) safe, which G1
    confirms.
11. **The mutation for a hold is part 03's `holdPlacements`** (resolution 4), not a `placement` key on
    `updateForm` or the operation patch (the owner brief); `withPlacementMoves` becomes
    `planOperationPlacementMoves`, a planner `withIdentityMoves` composes (resolution 3), and the
    builder's dialog is part 07's `IdentityMoveDialog`.
12. **Moves are stated, not confirmed, by the SA and MCP** (the research: "say so before it
    commits"): resolution 3.
13. **The preload is added at a writer's birth** (the research is silent on new writers), which
    keeps today's edit-in-place experience as content the author sees.
14. **`onlyIfChanged` is refused in Save to Case** (the research holds it on the write without a
    Save to Case spelling, which Vellum lacks).
15. **No stored case selections in step 5** (the owner brief carried `Form.caseSelections` with an
    authored `autoSelect`, a `selection` target and `form-case.selection`): no Nova document needs a
    form that selects cases beyond its menu's chain before an imported advanced form, so a module is
    advanced only by its held kind or a carried create's open action, and stored case selections
    (several selected cases per form, auto-selection, computed datums) are written into step 7's
    outline (§3.4).
16. **Names reconciled.** The owner brief's `heldPlacementSchema`, `withPlacementMoves`,
    `PlacementMoveDialog` and `same-type-child-index` are `casePlacementSchema` (with
    `ownClosePlacementSchema` for the own close), `planOperationPlacementMoves`, part 07's
    `IdentityMoveDialog` and part 03's `same-type-child-links`; part 03's brief's
    `lib/domain/placements.ts::placementExpresses` and `placementCandidates` live in
    `lib/commcare/placement.ts` (they run the procedure, which decides wire facts), and its
    `form-close` hold target is `own-close`. The baseline case-block reader is part 03's
    `publishedCaseBlocks`; the planners the cutover shares are `operationsFromFieldWrites` and
    `planExplicitPreloads` (§16.6).
17. **Undo of an identity move restores the latest recorded hold.** The owner brief's gate test has
    an undo restore the earlier hold, which a kernel rule admitting only moves of inexpressible
    holds would refuse (a Save to Case hold can still express almost anything), and the undo of
    removing a held operation would read as a hold gained by an editor. Part 03's kernel rule admits
    both as a restore of exactly the hold the latest recording for that target wrote, and part
    07's `applyHistoryStep` derives each inverse so it carries only such changes (§14, §13.1).
    A restore puts the answers back where the published app keeps them, so it is no move and
    nothing is stated (part 07 §2.5).
18. **The held slots land with the operation model** (the owner brief put them with the held
    rules): pull request 4 stores `placement` and `ownClosePlacement`, reads a hold first and
    reserves held paths, so part 08's case-writes witness holds what the cutover writes from the
    pull request that first emits operations; `holdPlacements`, the rules and the moves follow in
    pull request 5.
19. **A same-type child create takes Save to Case until pull request 8** (not in the owner brief):
    the publish check that keeps its parent index lands there (part 03), and no export may hold the
    shape before a publish can check it.
20. **A child type under more than one parent is step 7's** (the research's "Also held" list):
    the catalog keeps one `parent_type` per type, and every walk through an index resolves a step
    through it. A `create` already links to a case of any declared type (§3.4), so no step 5
    document needs a second parent in the catalog, and the item is written into step 7's outline.
21. **`dropCaptureWriters` keeps its code in pull request 2** (§28 says it "keeps link writes
    only"): at the base it already drops every capture writer, which is §19's end state (a
    capture-link write is unwritten in Preview), so pull request 2 rewrites only its comments.
22. **The local splicer loses its upload-ref partition whole** (§10.1 names only its
    `<attachment>` block): `caseBlocks.ts::attachmentQuestionPaths` existed to route a write naming
    an `<upload ref>` the way `xform.py::XFormCaseBlock.is_attachment` does, and from pull request
    2 no action names one (a capture's write names its `nova_url_<question>` sibling,
    `formActions.ts::caseUpdateQuestionPath`), so every write is an `<update>` row on both paths.
23. **`lib/commcare/CLAUDE.md`'s capture URL node bullet changes in pull request 2** (part 10
    §7.5 gives it to pull request 4): its opening, "`caseWrite` carries `mode`", is false from
    pull request 2, and a subtree contract is true at every head. Pull request 2 drops only that
    clause; pull request 4 writes the bullet's capture-link text.
24. **`gates.json` does not change in pull request 2** (part 10 §2 lists it in the lane):
    `lib/commcare/surface/entries/gates.json`'s `toggle/MM_CASE_PROPERTIES` already holds
    `preflight: {kind: "refusal", cell: "refuse"}` at the base, which is §20.2's end state, and the
    probe that stops asking it is `projectSpaceCompatibility.ts`'s, so the entry has nothing to
    lose.
25. **Four more readers of `caseWrite.mode` change in pull request 2** (part 10 §2 does not list
    them): `lib/commcare/xform/generatedNodes.ts::allocateGeneratedNodes` and
    `xform/builder.ts::buildFieldParts` allocate and emit the `nova_url_<question>` sibling for
    every capture with a write, where they tested `mode === "url"`;
    `lib/publish/exportAdvisories.ts::attachmentLinkProperties` names every capture write's
    property; and `lib/domain/referenceSlots.ts::NON_REFERENCE_FIELD_PATHS` loses its
    `"caseWrite.mode"` discriminator row, with the capture slot's comment reworded. Each reads a
    member pull request 2 deletes, so it changes with it.
26. **A child a field writes in a several-case form links `parent` to `session`, and `session`
    there names the current selected case** (§16.3 gives the planner "the own case" without saying
    what that is when a menu selects several; pull request 4's rule
    `MULTI_SELECT_SESSION_OPERATION_LINK` refused every session link in such a form, so
    `extensionCaseFixture("multiple")`, the `case-extension-multiple*` corpus documents and
    `proof/native/producers/emit-case-evidence.ts` failed the gate). One predicate,
    `lib/domain/forms.ts::caseOperationRunsPerSelectedCase`, says which operations run once per
    selected case: the own arm, an update or close of the loaded case, and a create with a link to
    it. Inside that iteration `session` is the current selected case, so it is never ambiguous; the
    rule refuses a session link only on an operation that runs once for the form. The validator's
    order and case-read rules, `caseOps.ts::saveToCaseBlockShape`, and the case store's
    `submissionEnvelope.ts` (physical expansion, the batch's session-link refusal, and a per-case
    create's id visible only to its own selected case) all read that predicate. This keeps `main`'s
    meaning (`lib/commcare/CLAUDE.md`, "Multi-select case-list emission": one child per selected
    case, indexed to it, inside the selected-case iteration) and keeps one spelling of "the case
    this form opened" for a follow-up or close form whatever its menu's selection; linking to the
    own arm (`op`) in a several-case form only would have given a loading form two spellings of
    one case, and every reader of `op` targets a second, per-selection correlation. HQ is no help
    either way: `corehq/apps/app_manager/xform.py::XForm._create_casexml` sets
    `default_case_management = False` for a multi-select module, so its build writes no basic
    subcase there (`entries.py::EntriesHelper.get_new_case_id_datums_meta` still allocates the
    datum), and the per-case child is Nova's Save to Case block alone.
27. **A child a field writes in a several-case form keeps `main`'s bytes through pull request 6,
    as an extension child does** (§12.2 sends it to Save to Case through `several-cases`, which
    would rename its block from `nova_subcase_<n>` to its operation id, add a
    `nova_guard_<op>_text` block, drop its subcase from `subcases` and its
    `case_id_new_<type>_<n>` datum, and so move the bytes of `case-extension-multiple` and
    `case-extension-multiple-repeat`, which §18 and part 10's row 4 forbid). §12.3 step 4's
    interim branch therefore also holds, in a several-case form, a `create` whose only link is
    `parent` to the own case (`child` or `extension`) and whose name is a bare question read,
    where `several-cases` is its only failed subcase condition: it takes an index in step 4's
    sequence, its subcase stays in `subcases` (relationship and condition as the operation states
    them for a child, `never` for an extension; HQ's build writes no subcase in a several-case
    form, `xform.py::XForm._create_casexml`'s `default_case_management`, and its entry still
    allocates the datum), and its placement is `{save-to-case, repeat: <its forEach>, path:
    [nova_selected_cases, item, nova_operations, nova_subcase_<n>]}`, the source-lowered block
    `main` writes in the selected-case row (`lib/commcare/placement.ts::PlannedBasicSubcase.inSource`).
    Pull request 7 removes it with the extension branch. Until then the entry still supplies no
    such datum to a form link (`lib/domain/entryDatumSupplies.ts` adds a root child's datum only
    on a registration or a one-case menu), so a link that reads it is refused as
    `SESSION_DATUM_NOT_SUPPLIED`, as on `main`.
28. **`lib/domain/caseWriteViews.ts` reads the reference index through a domain-side query**
    (§16 has the view find its forms through the index, which on `main` is queried only from
    `lib/doc/referenceIndex.ts::referencingCarrierUuids`): `lib/domain` may not import
    `lib/doc` (`lib/domain/referenceIndex.ts`'s header: the shape is part of `BlueprintDoc`'s
    type, and `lib/domain` cannot import `lib/doc`). So `lib/domain/referenceIndex.ts` gains
    `indexedReferencingSlots`, a read of the index data that already rides on `BlueprintDoc`,
    and `caseWriteViews.ts::fieldCaseWriteViews` keeps the carriers whose name, owner or
    write-value slot reads the field, falling back to the field's own form when a document
    carries no index. The index stays built and maintained only by `lib/doc`.

29. **`operationTarget(operation, formType)` takes the form's type** (§3.2 writes
    `operationTarget(operation)`): the own arm stores no target, and what it targets depends on the
    form, `{kind: "new"}` on a registration and `{kind: "session"}` otherwise
    (`lib/domain/forms.ts::operationTarget`). `operationCaseType(doc, formUuid, operation)` reads a
    structural `{formOrder, modules}` and walks `formOrder` itself, because calling
    `postSubmit.ts::moduleUuidOfForm` would make an import cycle with `forms.ts`. "Made unique among
    the form's operation ids" (§3.2) is `caseOperationIdentifiers.ts::ownCaseOperationId`, which maps
    the `-` a case type admits (`CASE_TYPE_PATTERN`) to `_`, which an operation id requires.
30. **The worker's record is refused by the schema outside an update** (§3.3 admits it "only as the
    target of an update", leaving where unsaid): `forms.ts::updateCaseTargetSchema` holds it, and the
    close and create arms' target schemas do not, so a close or create of the worker's record never
    parses.
31. **`capture-link` needs no grammar change.** §3.6 says the authoring grammar gains the call; the
    grammar's `identChar` already admits `-`, so `capture-link(...)` parses as an `Invoke` as
    `string-length(...)` does, and only `lib/commcare/xpath/expressionAst.ts` binds it, refusing an
    argument that names no question with the new parse issue `capture-link-not-a-question`. The
    checker applies "whole value only" through a flag set at its entry points
    (`typeChecker.ts::checkExpression`, `typeOf`, the root of `assignmentErrors`), since a cached
    node cannot tell it is the slot's root; a link over a capture inside a repeat the slot is outside
    of is `many-values` reason `repeat`, as §17 retires `PRIMARY_CASE_FIELD_IN_REPEAT` into it. The
    wire printer's arm throws an invariant error (`fromExpression.ts::term`), and every print dry run
    (`validator/rules/caseOperations.ts::validateExpressionSlot`) skips a whole `capture-link`, which
    emission writes as the URL node.
32. **`writerOffersPreload(doc, fieldUuid, property, via?)` and `fieldValueType(field, caseTypes,
    writes)`.** §11.1's three arguments cannot say "a write of the own arm without `via`", which §24.1
    tests, so the fourth is `via`; and a Hidden Value's bind type can no longer be read from the field
    alone, so `fieldValueType` takes the field's write views (the first write whose property has an
    effective type decides).
33. **`lib/domain/referenceSlots.ts` gains two slots §4 does not name**, both forced by the
    registry's audit of the stored shapes: `case_operation_write_via` (a relation path) and
    `case_operation_placement_repeat` (an entity uuid); a write's slot address includes its `via`,
    because two writes of one property, one through `via`, are two slots.
34. **The `new-child-case` session supply is a domain approximation of §12.2's basic subcase row**
    (`lib/domain/entryDatumSupplies.ts::newChildCaseTypes`): `lib/domain` cannot import
    `lib/commcare/placement.ts::planPlacements`. It counts an unheld create with no `forEach`, a `new`
    target with no `idFrom`, one `parent` link to the own case, a type some module lists other than
    the module's own, bare reads for its values and no condition, plus a field-written extension
    create while part 02 §14.4's interim inert subcase stands.
35. **Placement readings §12 leaves open** (`lib/commcare/placement.ts`):
    - on a registration the basic own slot also needs `closeCondition` stateable (reasons tagged
      `condition: "close"`), since a close block of its own would stand before the `case` block
      HQ appends and close a case that does not exist yet (`xform.py::XForm._create_casexml`);
    - a registration's own close always shares the own arm's place, and a close form's own close
      takes a block of its own only where it cannot;
    - a `capture-link` of a capture is admitted in the usercase and subcase slots too, which keep
      naming the `nova_url_` sibling as `main` does;
    - a held slot its subject can never take reports `scope`; pull request 5's `holdPlacements`
      admission refuses such a hold;
    - a held segment equal to a container's base (`nova_operations`, `nova_subcases`,
      `nova_selected_cases`) names the scope's one container, and only another owner's base is
      suffixed, so a held path never renames the shared group;
    - `nova_url_<q>` and `nova_datetime_<q>` are reserved for every question an operation writes
      from, whatever the placement, so generated names never depend on placement;
    - a close holding a Save to Case placement of its own never shares a create's place.
36. **The scalar text guard reads only basic actions** (`lib/domain/caseScalarTextGuard.ts`, with
    `placement.ts::placedBasic` passed in by `xform/builder.ts` and `engineInput.ts`): counting
    every view as §12's basic buckets gave eight unchanged corpus documents a trimmed node and a
    constraint they did not have.
37. **Validator readings of §17.** `CASE_PROPERTY_BAD_FORMAT`, `CASE_PROPERTY_TOO_LONG` and
    `MULTI_SELECT_FANOUT_CHILD_DATUM` retire with the readers they had (a field writer, a fan-out
    datum); every write's property format and length is `CASE_OPERATION_UNKNOWN_PROPERTY`'s. A
    write whose value is a question's answer as it is may save to a property the catalog does not
    declare, as a field write could on `main`; a computed value still needs a declared property.
    For such a write the field rules alone judge type agreement, so each refusal is said once, at
    the question. `CASE_OWN_OPERATION`'s statement lives in `lib/commcare/ownCaseOperationFindings.ts`,
    which `formLinkProjection.ts` and `previousTaskProjection.ts` read too, because importing the
    rule file would make an import cycle; `previousTaskProjection.ts` reports
    `CASE_CREATE_NAME_MISSING` for a registration whose own arm has no name instead of throwing in
    emission. `MULTI_SELECT_OPERATION_ORDER` skips the own arm, whose position decides nothing (§5.3).
38. **`planFieldCaseWrite` readings §16.3 leaves open** (`lib/doc/fieldCaseWriteMutations.ts`): a new
    worker-record update is named by its case type made unique (`commcare_user`); a worker-record
    update left with no writes is removed, as a create is; saving a second value where the case
    already saves one refuses ("{case} already saves another value to {property}. Stop that save
    first, or choose another property."), since the reducer would drop it silently; a case
    destination on a survey refuses in `CASE_WRITE_NO_CASE_ACTION`'s words; a new create is added at
    the end of its multiplicity scope, which the wire order requires; and no starting value is
    offered for `owner_id`.
39. **Preview readings of §19.** A registration whose open condition is false still names the id the
    entry minted, as the session datum does on a device; every operation naming the own create
    inherits the open condition as a guard; the own arm is the final consumer of its case's type in
    the runtime type proof; and `FormEngine.ownCloseHolds` counts a close condition the synchronous
    evaluator cannot run as holding, so Android's check refuses rather than writes.
40. **A question's answer saved as it is to the own case of a form that updates it, or to the
    worker's record, saves nothing while the question is not answered, in every placement.** HQ's
    basic update guards such a row with `count(path) > 0` (`xform.py::XFormCaseBlock.add_case_updates`),
    which keeps a hidden question from clearing the stored value, and the Save to Case row §10 writes
    has no such guard, so the own arm would mean one thing in Case Management and another in Save to
    Case, against §5.3. `xform/caseOps.ts` gives that row the same relevance, and Preview, which reads
    no placement (§19), marks a non-relevant answer `absent` (`FormEngine.computeOperationAnswers`)
    and leaves such a write out of the program (`caseDataBindingHelpers.ts::buildCaseOperationProgramFromDoc`).
    No byte of `main` moves: `main` wrote neither the own arm nor the worker-record update in Save to
    Case. A name, whose text guard refuses a blank, keeps its row.
41. **A registration whose own arm takes Save to Case supplies no `new-case` session value.** §5.1
    says the `new-case` read keeps reading the same id, and §5.3 rule 4 that an index names
    `case_id_new_<type>_0`; HQ gives that datum only where `open_case` is active
    (`suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta`), which is where the
    own arm takes the basic slot. Where it takes Save to Case (an open condition Case Management can't
    state, a computed name, a link, a change before the create, a hold), the entry has no such datum,
    so the checker refuses a read of the case the form creates or the cases above it
    (`SESSION_DATUM_NOT_SUPPLIED`, reason `own-case-save-to-case`, in form logic and after-submit
    links alike), a `session-datum {new-case}` read is refused by the supplies, and a held own close
    block reads the own block's id (`caseOps.ts::ownCreateIdAt`). Printing the block's id instead was
    not chosen: a form-logic read would need a `current()` path from every slot that reads it, which
    `formCasePropertyRead` has no target path for, and a session-scope read after the form closes has
    no block to read. A form a search with no matches offers must take the basic slot
    (`SEARCH_NO_MATCHES_ENTRY_NOT_REGISTRATION`, reason `own-case-save-to-case`): HQ's build admits a
    case-list form only with `open_case` active (`models/forms.py::FormBase.is_registration_form`,
    `helpers/validators.py::ModuleBaseValidator.validate_case_list_form`), and its return frame reads
    that datum.
42. **The slot eligibility of the own arm and the creates lives in `lib/domain/basicCaseSlots.ts`.**
    `newChildCaseTypes` approximated which creates take a basic subcase slot and disagreed with
    `placement.ts` (a create's own condition, the own arm's slot, a name in a repeat, a label value, a
    later change, a stale hold), so the checker admitted `new-child-case` reads the wire never
    supplies. The eligibility conditions, the held slots and the subcase index choice moved into the
    domain (`basicCaseSlots`), which `placement.ts::planPlacements`, `entryDatumSupplies`
    (`registrationMintsOwnCaseId`, `rootBasicSubcaseCreates`) and Preview's named creates
    (`caseDataBindingHelpers.ts::entryNamedCreates`) all read; `placement.ts` keeps the worker's record,
    the closes and every Save to Case path. `saveToCaseBlockShape` reads the own arm's and a create's
    shape from the domain (`ownOrCreateBlockShape`) and `moduleCaseTypeForActions` is the domain's. No
    corpus byte moved.
43. **A new catalog entry a question's answer creates takes the question kind's type, as `main`'s
    did.** `main`'s `ensureCatalogProperty` stamped `caseDataTypeForFieldKind` onto the entry a field's
    "Saves to" added; the case-operation catalog chokepoint (`scaffolds.ts::catalogMutationsForOperations`)
    declared the property with no `data_type`. The case list emitters read the effective catalog and
    the translation inventory reads the stored one, so a select's saved property took no choice list
    (`updateCaseProperty` refused it as text) and the labels the case list shows were missing from the
    inventory. The chokepoint now stamps the type of a write whose value is a question's answer as it
    is, and `updateCaseProperty` checks a choice list against the effective type where the entry
    stores none. No corpus byte moved.
44. **An own close whose new place is the own arm's clears its hold and states the move** (§14
    names an entry with the new placement, or `null` only where the close vanished). The slot
    `Form.ownClosePlacement` holds only a block of the close's own (`ownClosePlacementSchema`), so
    where the planner, with the stranded hold removed, gives the close the own arm's place
    (`PlannedPlacement.sharesWith`), the entry is `placement: null` and the move is stated from Save
    to Case to the own arm's place; the own arm's hold carries that place. The kernel admits the
    clear by arm (a), since the earlier block no longer expresses the close.
45. **The pull request 5 move tests check the client half of the kernel's rule.**
    `placementMoves.test.ts` and `queryRepeatPlacement.test.ts` show each undo, restore and
    re-creation admitted by `lib/doc/placementHolds.ts::admittedHoldChanges`, which keeps exactly
    the entries `placementChangeRefusal` admits and drops the rest; `lib/db`'s rule test checks the
    same changes against the kernel. Their documents are a gate-valid fixture
    (`lib/doc/__tests__/placementMoveFixture.ts`), since `placementHoldFixture.ts`'s fixture is
    shaped for the planner's rules and the gate refuses it (a quoted choice value, empty forms).
    Two §12.8 reasons are not rows there, because the gate refuses their edit for another reason
    first: `condition-apostrophe` and `condition-quote-boundary` (an option value holding a quote is
    `SELECT_OPTION_VALUE_INVALID`). Removing a held own close's close condition, or a held Save to
    Case create's condition, keeps the held block (`saveToCaseBlockShape` gives the own close its
    condition segment always and the create's shape is unchanged), so neither is a move.
46. **A history step records the holds its batch carried** (§14 says "A history step records no
    `holdPlacements`"). Part 03 §2.6 and part 07 §2.5 both have the step record its holds and keep
    only the admitted ones when it applies, and arm (b) needs them: the undo of a move, and the
    re-creation of a removed held change with its hold, restore a hold only the recorded inverse
    carries. So `lib/doc/store.ts` records the forward batch and its derived inverse as before (the
    diff writer's trailing `holdPlacements` carries the holds), `historyStepBatch(action)` keeps only
    the entries `lib/doc/placementHolds.ts::admittedHoldChanges` admits over `recordedHolds`, and
    `applyHistoryStep(action, batch)` applies the batch `lib/routing/historyStep.ts::runHistoryStep`
    planned and gated. `lib/routing/__tests__/historyStep.test.ts` shows both the restore and the
    dropped change. In pull request 5 a recording is a `blueprint-migration` row or the greatest
    fold baseline's snapshot; `publish-placement` joins in pull request 6 (part 03's Departures).
47. **Pull request 5's tests beyond the ones named.** Beside the named files, the move planners and
    copy have their own: `lib/doc/__tests__/queryRepeatPlacement.test.ts`,
    `identityMoveCopy.test.ts`, `lib/domain/__tests__/caseOperationDescription.test.ts`,
    `placementCopy.test.ts`, `lib/commcare/validator/__tests__/queryRepeatModelIterationShape.test.ts`,
    `lib/agent/tools/__tests__/heldPlacementReads.test.ts` and
    `proof/targeted/__tests__/heldPlacement.test.ts`; their documents come from shared fixtures
    (`lib/doc/__tests__/placementHoldFixture.ts`, `placementMoveFixture.ts`,
    `heldHistoryFixture.ts`, `lib/db/__tests__/heldPlacementApp.ts`). Each owns a contract the named
    files do not reach: the query repeat's planner, the move sentences, the read flags and the
    targeted document's shape.
48. **The interim same-type exclusion lives in the domain, and pull request 8 lifts it in all three
    readers** (§28 and part 10 §2 place the lift in `lib/commcare/placement.ts`). Since departure 42
    moved slot eligibility into the domain, departure 19's exclusion is
    `lib/domain/basicCaseSlots.ts::sameTypeExclusions`, and three readers call it:
    `basicCaseSlots`, `lib/commcare/placement.ts::planAdvancedCore` and
    `lib/domain/advancedEntryDatums.ts::advancedEntryActions`. Pull request 8 removes the function and
    all three calls, so the advanced arm takes an open action for a same-type create too. That is
    right because `DONT_INDEX_SAME_CASETYPE` touches only basic subcases:
    `corehq/apps/app_manager/xform.py::XForm._create_casexml` reads the flag
    (`index_same_casetype = not DONT_INDEX_SAME_CASETYPE.enabled(self.domain)`) when it writes a
    subcase's index, and `XForm._create_casexml_advanced`, which writes an open action's indices, does
    not read it. `PlanPlacementsOptions.excludeBasic`'s comment loses the "unheld creates of the
    menu's own case type" clause it described.

## 28. Files by pull request

**Pull request 2, attachment mode removed** (with part 08's register moves and fixture mappings).
- `lib/domain/fields/{base,image,audio,video,signature,file,index}.ts` (§3.1);
  `lib/domain/attachmentSlots.ts` deleted, with `lib/domain/index.ts`'s export and the rule
  `CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT` (`lib/commcare/validator/rules/case-list/columnKindPropertyType.ts`,
  `lib/commcare/validator/{errors,gate}.ts`, `lib/doc/userFacingErrors.ts`) and its tests.
- `lib/commcare/formActions.ts`, `lib/commcare/xform/caseOps.ts`, `lib/commcare/xform/caseBlocks.ts`
  (attachment branches); `lib/commcare/projectSpaceCompatibility.ts`,
  `lib/publish/projectSpaceCompatibility.ts` (`case-attachments` leaves);
  `lib/preview/engine/formEngine.ts` (`dropCaptureWriters` keeps link writes only).
- `lib/agent/toolSchemaGenerator.ts` (`mode`, `gateCaseWriteMode`), `lib/models.ts`
  (`"v6-hq-round-trip-case-writes.2"`), `components/builder/editor/fields/{CaseWriteEditor.tsx,caseWritePresentation.ts}`
  (part 07's files for this pull request); the moved schemas are sent in the one billed run at
  pull request 13's head.
- `proof/known-defects.json` → `proof/fixed-defects.json` (79); `OPEN_DEFECTS` loses 23.
- Tests: `caseBlocks.test.ts`, `formActions.test.ts`, `projectSpaceCompatibility.test.ts` (§24.1).
- Docs: `lib/domain/CLAUDE.md` and `lib/commcare/CLAUDE.md` capture sentences, which this change
  makes false. The public pages and `contracts.md`'s attachment row (§23, items 2 and 10) land in
  part 10's pull request 15.

**Pull request 4, case writes as one concept** (with part 08's moves and fixtures).
- Domain: `lib/domain/forms.ts` (own arm, write, key, targets, conditions, `operationCaseType`,
  `operationTarget`, `placement` on every arm and `Form.ownClosePlacement` as held slots),
  `lib/domain/fields/{base,hidden,image,audio,video,signature,file,index}.ts`
  (`caseWrite` leaves), `lib/domain/caseTypes.ts` (`fieldCaseWrite` deleted),
  `lib/domain/caseWriteViews.ts` (new), `lib/domain/casePreload.ts` (rewritten),
  `lib/domain/placements.ts` (new: the basic and Save to Case schemas, `ownClosePlacementSchema`,
  the reason tuple), `lib/domain/placementCopy.ts` (new, with part 07),
  `lib/domain/referenceSlots.ts`,
  `lib/domain/expression/{types,typeChecker,inference,profiles,children,walk}.ts` (`capture-link`),
  `lib/domain/formRecordScope.ts`, `lib/domain/index.ts`.
- Deleted: `lib/domain/caseWriteInventory.ts`, `lib/domain/closeCondition.ts`,
  `lib/commcare/{caseWriteFindings,caseWriteAdmission,deriveCaseConfig}.ts`,
  `lib/doc/hooks/useCloseConditionPlacement.ts`,
  `components/builder/editor/fields/PreloadedValueRow.tsx`,
  `components/builder/detail/formSettings/CloseConditionSection.tsx`.
- `lib/commcare/placement.ts` (new: `planPlacements` with its options, held first, the interim
  extension branch and same-type exclusion, `placementExpresses`, `placementCandidates`,
  `placementIneligibility`), `lib/commcare/sameTypeChildCases.ts` (new),
  part 02's `lib/commcare/casePlacementPlan.ts` (new: `planFormCaseWire`'s basic and Save to Case
  arms), `lib/commcare/formActions.ts` (rewritten), `lib/commcare/xform/{caseOps,caseBlocks,captureUrlNode,generatedNodes,builder,sourceCaseWrites}.ts`
  (`generatedNodes.ts` reserving held paths),
  `lib/commcare/{planPrivileges,addOns,projectSpaceCompatibility,expander}.ts`,
  `lib/commcare/xpath` (grammar, `expressionAst.ts`, printer: `capture-link`),
  `lib/commcare/validator/{errors,gate}.ts`,
  `lib/commcare/validator/rules/{form,field,caseOperations,selectPreloadWriterOptions,hiddenValueWriterAgreement,sourceCaseWrites}.ts`,
  `lib/commcare/surface/entries/{forms-and-case-writes,gates}.json`,
  `lib/publish/projectSpaceCompatibility.ts`, `lib/publish/exportAdvisories.ts`.
- `lib/doc/{types,referenceIndex,caseOperationMutations,caseOperationOrder,caseWriteChoices,kindConversionCascade,casePropertyRenames,caseTypeRetirement,unwrittenProperties,datetimeSplit,scaffolds,formSectionMutations,formSectionVerdicts,userFacingErrors,diffDocsToMutations,expressionText,optionRemoval}.ts`,
  `lib/doc/mutations/{fields,forms,modules}.ts` (every payload schema omits the held slots),
  `lib/doc/fieldCaseWriteMutations.ts` (new), `lib/doc/formTypeMutations.ts` (new),
  `lib/doc/casePlacements.ts` (new), `lib/doc/fieldWriteOperations.ts` (new:
  `operationsFromFieldWrites`, `FieldWriteFact`), `lib/doc/explicitPreloads.ts` (new:
  `planExplicitPreloads`), part 09's `lib/domain/caseWriteOperationIdentity.ts` (new, which
  `operationsFromFieldWrites` calls), `lib/doc/hooks/{useCaseOperations,useCaseWriteChoices}.ts`;
  `biome.json` (allow-list entry `lib/doc/casePlacements.ts`).
- Preview and the case store: `lib/preview/engine/{formEngine,caseDataBindingHelpers,caseDataBindingTypes}.ts`,
  `lib/preview/app-tests/submission.ts`, `lib/case-store/postgres/submissionEnvelope.ts`,
  `lib/case-store/submission.ts`.
- Authoring forced (§16.5): `lib/agent/{toolSchemaGenerator,formAnswerWrites}.ts`,
  `lib/agent/authoring/{fieldBehavior,operationSemantics,formRecordContext}.ts`,
  `lib/agent/tools/{addFields,editField,getField,updateForm}.ts`, `lib/agent/tools/case-operations/*.ts`,
  `lib/models.ts` (`"v6-hq-round-trip-case-writes.4"`), `scripts/test-schema.ts` (`getCaseOperations`,
  `removeCaseOperation` and `moveCaseOperation` registered; none billed here),
  `components/builder/editor/fields/{CaseWriteEditor,caseWritePresentation,CaseOptionsEditor,HiddenValueEditor,hiddenValueModel}.ts(x)`,
  `components/builder/editor/fieldEditorSchemas.ts`,
  part 07's `components/builder/detail/formSettings/{OwnCaseSection.tsx,ownCaseModel.ts}` (new),
  `components/builder/case-operations/*` (own arm first, the `own-first` refusal).
- Proof: `proof/targeted/documents/caseWritesOneConcept.ts` (new, `targeted-case-writes-one-concept`),
  `proof/targeted/documents/{loadTimeValues,closeConditions}.ts` (rewritten), every targeted
  document and e2e seed that writes `caseWrite` (through `docHelpers.ts`), the fixture mapping and
  the fuzz items of defects 22 and 28 (part 08, through §16.6's planners), the case-writes and
  groups-preloads witnesses' operation holds (part 08),
  `proof/native/core/CaseOperationRuntimeTest.java`, `proof/known-defects.json` →
  `proof/fixed-defects.json` (3), the inventory rows of §20.2.
- Tests: §24 rows marked 4.
- Docs: §23 items 1, 4 to 10 land in part 10's pull request 15; this pull request edits the
  subtree `CLAUDE.md` sentences of items 5 to 9 that its change makes false.

**Pull request 5, held placements and identity moves** (with parts 03, 04, 07 and 08).
- `lib/doc/types.ts` (`holdPlacements` with §13.1's entries, part 03's envelope),
  `lib/doc/mutations/placements.ts` (part 03's reducer), `lib/commcare/placement.ts`
  (`inexpressible`), `lib/commcare/validator/rules/casePlacement.ts` (new),
  `lib/commcare/validator/{errors,gate}.ts`,
  `lib/doc/{placementMoves,heldIdentity,incrementalValidationScope,userFacingErrors,diffDocsToMutations}.ts`,
  `lib/domain/caseOperationDescription.ts` (new: `describeCaseOperation`), `lib/domain/placementCopy.ts`
  (`placementLabel`), `biome.json` (allow-list entries `lib/doc/placementMoves.ts`, part 03's
  `lib/db/placementAuthority.ts` and `lib/doc/placementHolds.ts`, and part 07's
  `lib/doc/identityMoves.ts`, each of which reaches `lib/commcare/placement.ts`).
- Part 03's `lib/db/placementAuthority.ts::placementChangeRefusal` (its editor half) and
  `lib/doc/placementHolds.ts`; part 07's `lib/doc/identityMoves.ts`, `applyHistoryStep`, the
  dialog, the workspace hosts (`lib/agent/workspace/canonicalWorkspace.ts`,
  `lib/agent/change-set/workspace.ts`; `guardedMutate` unchanged) and the tool results; `lib/models.ts` (`"v6-hq-round-trip-case-writes.5"`).
- Proof: `proof/targeted/documents/heldPlacement.ts` (`targeted-held-placement`).
- Tests: §24 rows marked 5, `heldPlacements.postgres.test.ts`.

**Pull request 7.** Part 02 adds `advancedPlacementSchema` to the union, `Module.heldKind`, the
module-kind target, `CASE_PLACEMENT_KIND` and the `module-kind` arm of
`HELD_PLACEMENT_INEXPRESSIBLE` (part 02 §5), the advanced reasons and `carried-create` with their
sentences, the `moduleKind` arm of `planPlacements`' step 1 and its calls of `loadIneligibility`
and `openActionIneligibility`, the carried-create clause, and the removal of the interim extension
branch (§12.3), reading §3.7, §12 and §13; under its G3 and G4 outcomes A, the
`appended-name-taken` and `worker-property-name` conditions on the basic slots (§12.2).

**Pull request 8.** Part 03 lifts §12.2's same-type exclusion and reads `sameTypeBasicChildCases`
(§15) for the capability and its offer, with `excludeBasic`; `unproducedInputs.test.ts`'s same-type
bullet moves to `publishChecks.test.ts`, `compilerEvidence.ts` drops its same-type subcase
assertion, and `sameTypeChildCases.test.ts` and `placement.test.ts` gain their pull request 8
cases.

**Pull request 14.** Part 09 runs §22's classes.

## 29. What other parts read from this one

| Part (pull request) | Reads |
|---|---|
| Part 02, advanced and extension (4, 5, 7) | the own arm and `operationCaseType`/`operationTarget`; `casePlacementSchema` with the `advanced` arm's shape (`tag`, `row`); §12's procedure as the input of `planFormCaseWire` from pull request 4, including a derived Save to Case placement's exact path and the interim placement `{save-to-case, path: ["nova_subcases", "nova_subcase_<n>"]}` of a field-written extension create through pull request 6 (§12.3); from pull request 7 the option `moduleKind` its `emittedModuleKind` passes, the calls of `loadIneligibility` and `openActionIneligibility`, the carried-create clause (§12.2), and the reason tuple it extends; under its G3 and G4 outcomes A, the `appended-name-taken` and `worker-property-name` conditions on the basic slots; the extension `create` shape (a `create` with one `parent` link of relationship `extension` to the own case, as today's wire names the index); that no `Form.caseSelections`, `selection` target or `form-case.selection` exists in step 5 (§3.4); C8's ordering (its M1 and M2 renumber subcases before C8 records them) |
| Part 03, publish and ledger (5, 6, 8) | `appPlacements` (the publish recorder's derivation: every subject whose `PlannedPlacement.held` is false), with each derived Save to Case placement's exact path; `placementIneligibility` (an empty list where the placement expresses its subject) and `placementExpresses` for `holdExpresses` and the kernel rule; `placementCandidates`, `planPlacements`' option `excludeBasic` and `placementIneligibilitySentence` for the offers; `casePlacementSchema`, `ownClosePlacementSchema` and §13.1's two hold entries for `holdPlacements`; that no payload but `holdPlacements` carries a held slot (§16.1); `HELD_PLACEMENT_INEXPRESSIBLE` for the conflict classification; `sameTypeBasicChildCases` with `caseType` and `ownCase` for `same-type-child-links`, and the same-type exclusion it lifts in pull request 8 (§12.2); the capability `save-only-edited-answers` (§8); the removal of `case-attachments` (§10.1); the undo inverses its kernel rule admits (§14) |
| Part 04, questions (3, 5, 9) | `holdPlacements` and the identity-move statement for query repeats; C7's later-reader walk includes query repeat setvalues; a case operation's emission inside a count-placed row keeps its path; under part 04's G2 outcome B2, the row guard's conjunct read into §12.1's stateable test |
| Part 05, search and menus (10) | the several-case condition of the basic own slot (`several-cases`) |
| Part 06, form links (11) | `{kind: "op", opUuid: <own arm>}` and `id-of` naming the case a registration creates beside the `new-case` datum; a basic root subcase's datum `case_id_new_<type>_<i+1>` follows its held index |
| Part 07, authoring (4, 5, 12, 13) | `fieldCaseWriteViews` (with the `ancestor` destination and `onlyIfChanged`), `planFieldCaseWrite` with the destination `{caseType, property, via?, onlyIfChanged?}` from pull request 4, `planFormTypeChange`, `writerOffersPreload`/`fieldPreload`, `formCasePlacementView`, `placementLine`, `placementLabel` and `placementIneligibilitySentence` from `lib/domain/placementCopy.ts`, `describeCaseOperation` (`lib/domain/caseOperationDescription.ts`, pull request 5), the move planners' refusal reason `own-first` (§5.2), `planOperationPlacementMoves` for `withIdentityMoves` with moves whose `reason` is the `case-placement` arm carrying the first `PlacementIneligibility` (a §12.8 reason), `placementExpresses` for `identityMovesBetween` and `admittedHoldChanges`, that the undo of an identity move restores the recorded hold under the kernel rule's arm (b) and states no move (§14), every finding message of §17, §16.5's forced changes (the tool inputs `via`, `onlyIfChanged`, the `worker-record` target and `open_condition` in pull request 13); `via` and **Save only if changed** are offered on the own arm's writes only (§7, §8); under §26's G5 outcome B the switch, the `onlyIfChanged` input and the capability are not built |
| Part 08, proof (2, 4, 5, 8) | §20's register moves and manifest flips, §21's documents under part 08's names (`targeted-case-writes-one-concept`, `targeted-held-placement`, `targeted-same-type-child`), G1, G3, G4 and G5 (§26), G4's outcome B landing by part 08 §2.6, the held slots stored from pull request 4 for the case-writes witness, `operationsFromFieldWrites` and `planExplicitPreloads` (§16.6) for the fixture mapping and the fuzz items |
| Part 09, cutover (4, 14) | §22's classes, their order and notice reasons; `operationsFromFieldWrites` with `FieldWriteFact` and `planExplicitPreloads` (§16.6), which call part 09's `caseWriteOperationUuid`; the frozen copies of `deriveCaseWriteInventory` and `writerPreloadsFromLoadedCase`; the structure step `close-condition-expression`; C9 as part 09 §7.4 writes it, with `own-close-in-repeat`, `own-close-moved` and the document reason `form-became-close-form`; the scan's findings for classes (a) to (g) (§26), C10 and C11 decided by the advisory dry run, and the cause `case-changed-before-create`; `ownClosePlacementSchema` (an own close holds no `repeat`) |
| Part 10, stack and contracts (15) | §23's sentences and §28's files; public docs and `contracts.md` in pull request 15, subtree `CLAUDE.md` sentences in the feature pull request |
| For the outlines | step 6: the wider subcase condition picker (§2, claim 1), `case-preload-from-any-other-index-path…` and preloads that are not exact case reads, because only import meets them; step 7: stored case selections (several selected cases per form, auto-selection, computed datums), because no Nova document needs them before an imported advanced form (§3.4, written into the outline with part 02's items); a child case type under more than one parent, because the catalog holds one `parent_type` per type and no step 5 document needs a second (§3.4, departure 20); under G5's outcome B, `onlyIfChanged`, because the Case Management save does not keep `update_mode: edit` |
