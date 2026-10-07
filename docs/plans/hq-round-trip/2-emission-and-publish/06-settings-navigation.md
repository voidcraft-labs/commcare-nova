# Step 2, part 06: Work item D, part 3: menus, forms, navigation and search settings (defect 14; findings 41, 50, 54)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part fixes every bullet of defect 14 that is not a logo, the location fixture, a tile, a sort spelling, a date pattern or the data node's name, adds the three model additions those fixes need (`postSubmit: firstMenu` and `parentMenu`, a sort column on a lookup-backed search input, `hiddenFromMenu`), settles findings 41 and 54, and states why finding 50 gets no emission fix (its allowance is specified in part 09, Finding 50: the registration alert on a follow-up form). HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

What this part does not own, and where it is:

| Item | Owner |
|---|---|
| Logos (`d14-logos-*`, 2 entries) and `location_fixture_restore` | Part 03, C6. Defect 14: logos, and part 03, C5. Defect 14: the flat location fixture |
| Tile cell placement, font size and alignment (`d14-tiles-*`, 9 entries) and finding 42 (`d42-tile-alignment-*`, 5 entries) | Part 07, Tile cells and finding 42 |
| Sort type, sort blanks, `field` plus `sort_calculation` pairs, date patterns outside HQ's five | Part 07, The sort spellings and the four rules they retire, and part 07, Date patterns narrowed to HQ's five |
| The data node's `name` (`d14-data-node-name-*`, 3 entries) | Part 05, Finding 46 and defect 14's data node name |

Shared mechanics every block below uses, defined once in their own parts of this plan:

- **Registers.** A fix moves its entries from `proof/known-defects.json` to `proof/fixed-defects.json` in the same pull request. A fixed entry keeps its id, drops `document`, and must still show on its control (part 09, The fixed-defect register and finding 52's orphaned control).
- **Cutover.** A fix that changes a stored shape adds one step module under `scripts/lib/hqRoundTripCutover/steps/`, registered in `transform.ts`, which returns `DocumentChange` records. Each record's `reason` is a member of `DOCUMENT_NOTICE_REASONS` with one renderer in `lib/notices/migrationNoticeCopy.ts`. A fix that changes what a worker sees without changing the document registers no step: `scripts/lib/hqRoundTripCutover/behavior.ts`, which reads the migrated document after the last step, returns its notice records, and the fix adds its selection rule and its reason there. The one registry of step ids and notice reasons is part 10's (part 10, The transform steps, in order, and part 10, Changes that write nothing and still get a line); every id and reason in this part is spelled as that registry spells it, and this part registers none of its own.
- **Identity.** `proof/identity-moves.json` gains no entry from any block here: proof 1 compares two exports of one document at one revision, so a migration or an emitter change moves both sides alike.
- **Tool schemas.** Blocks 3, 4, 5 and 11 change SA and MCP tool input schemas, and blocks 2 and 6 change descriptions inside such schemas. `npm run test:schema` bills one live request per schema, so nothing is run in pull request 9 or pull request 12: every schema these blocks change is named in the stack's one question, asked at the head of pull request 14 after the last schema edit (part 11, The stack, in its list of what every pull request of the stack does). Reason: the stack deploys once, so only the schemas at its top reach the provider, and an ask in pull request 12 would bill the same schemas again at pull request 14.
- **Model context.** Pull request 9 changes the tool catalog (block 2's `close_condition` description) and pull request 12 changes it again (blocks 3, 4, 5 and 11), so each bumps `lib/models.ts::MODEL_CONTEXT_VERSION`, as every pull request that changes the catalog does. Part 11, The model-addition checklist, item 13, is the one list of those pull requests and of the value each sets.
- **Routes.** No block here adds an `/api` route.
- **Plugin.** Blocks 2, 3, 4, 5, 6 and 11 change what Nova tells a model (close placement, the destination list, the search button label, the choice sort column, reserved input names, `hiddenFromMenu` in place of the always-false refusal). The `../nova-plugin` skills are swept for each claim in the step's plugin pull request, which is its own pull request in that repository and merges after the deploy (part 11, House rules for the stack, rule 11).

Pull requests of the stack that carry this part: 1 (finding 50, whose allowance and entry removal are specified in part 09, Finding 50: the registration alert on a follow-up form), 9 (blocks 1, 2 and the `external_id` row of block 10), 11 (findings 41 and 54), 12 (blocks 3 to 7, the rest of block 10, block 11).

Register entries this part moves or removes:

| Part | Entries | Checks | Controls |
|---|---|---|---|
| Non-writing follow-up | 11, `d14-non-writing-followup-*` | manifest 3, proof4 8 | `case-operation-query` |
| Close conditions | 23, `d14-close-conditions-*` | bar 1, manifest 7, proof3 5, proof4 10 | `targeted-close-conditions` (22), `targeted-close-condition-unparsable` (1) |
| Multi-select destinations | 3, `d14-multi-select-*` | bar 1, manifest 1, proof4 1 | `targeted-multi-select-destinations` (1), `case-capture-multiple` (2) |
| Search button label | 4, `d14-search-button-label-*` and `d14-search-settings-app-other-value` | proof4 3, manifest 1 | `case-operation-query` |
| Lookup prompt sort | 3, `d14-search-lookup-prompt-*` | proof4 3 | `prompt-widgets` |
| Reserved input names | 7, `d14-search-settings-*-csql-key-include-closed`, `-reserved-request-key`, `-promptkey-reserved-request-key`, `d14-default-filter-name-*` | manifest 6, proof4 1 | `targeted-search-hq-compile` (4), `targeted-search-default-filter-name` (3) |
| Survey menus | 1, `d14-survey-menus-app-case-type` | intent 1 | `targeted-survey-menu` |
| Finding 41 | 2, `d41-empty-list-text-*` | proof4 2 | `case-list-inline`, `search-browse` |
| Finding 54 | 3, `d54-search-description-*` | proof4 3 | `case-operation-query` (2), `case-list-inline` (1) |
| Finding 50 | 2, `d50-registration-alert-*`, removed, not moved, in pull request 1 (part 09, Finding 50: the registration alert on a follow-up form) | proof4 2 | `nested-menu-previous`, deleted in the same pull request |

## 1. `update_case` is `always` on every case form

**Today.** `lib/commcare/hqShells.ts::emptyFormActions` seeds `update_case.condition` as `never`, and `lib/commcare/formActions.ts::buildFormActions` writes `always` only when the update map is non-empty. A follow-up that writes nothing, a registration that writes only its name and `external_id`, and every form of a multi-select menu upload `never`.

**Fix.** From step 2 `buildFormActions` writes `update_case.condition` `always` on every `registration`, `followup` and `close` form, whatever it writes, and assigns `update` when the map is non-empty.

- Reason: HQ's Case Management save writes `always` on every form that opens or requires a case (`static/app_manager/js/forms/case_config_ui.js::HQFormActions.from_case_transaction`), and HQ's own form creation does the same (`views/forms.py`, `views/modules.py`, `models/applications.py`). `never` is a state its editor produces only for a form moved into a survey menu.
- The survey early return in `buildFormActions` stays first: `always` on a form that neither opens nor requires a case makes HQ's build raise (`xform.py::XForm._create_casexml`, `CaseError`).
- What HQ builds from it (read at source): for a form that requires a case in a single-select menu, a primary block with its `case_id`, `date_modified` and `user_id` binds, and an `<update>` child only when there is a write (`xform.py::XForm._add_case_updates` calls `XFormCaseBlock.add_case_updates` only for a non-empty map). In a multi-select menu `default_case_management` is false and no primary block is built.
- **The local `<update>` rule.** `lib/commcare/xform/caseBlocks.ts::buildCaseBlocks` writes `<update>` exactly when the update map holds at least one entry. Today it writes an empty `<update/>` for every update form. Without this change the fix trades the proof 4 entries for a proof 3 difference between the two paths at `/data/case/update`.
- `lib/commcare/xform/caseBlocks.ts::addCaseBlocks` keeps passing `defaultCaseManagement = false` for a multi-select form, so the local path stays without a primary block there.
- **Preview and the case store.** `lib/case-store/postgres/submissionEnvelope.ts::applyOrdinaryAction` writes nothing for a `followup` or `close` submission whose admitted patch is empty, so the case's `modified_on` does not move. From step 2 that arm calls `stampModified` for a single-selection submission with no property, name or external id write, as HQ's processing of the touch block does. A several-case submission is not stamped (HQ builds no primary block there).
- The one behavior change: each submission of a follow-up that writes nothing now updates its case's `modified_on` in HQ, which case update rules, repeaters and data forwarding see.

**Files.**
- Emitters: `lib/commcare/formActions.ts`, `lib/commcare/xform/caseBlocks.ts`.
- Preview: `lib/case-store/postgres/submissionEnvelope.ts`.
- Manifest: the authored entries under `lib/commcare/surface/entries/forms-and-case-writes.json` whose value class is `update-never-followup-alone` (Nova no longer emits the class).
- Docs: `content/docs/case-changes.mdx` (a follow-up that changes nothing still marks its case as updated).
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-management scaffolding emission", the touch block and the `<update>` rule), `lib/case-store/CLAUDE.md` (the stamp).
- Domain, doc and mutations, validator, builder, SA and MCP tools: none. No authored slot changes.

**Stored shape and migration.** No schema change, no document change and no step. `behavior.ts` returns one record per follow-up form in a single-select menu with no write, no close, no preload, no child case and no worker-record write. Notice reason `follow-up-now-touches-case`, naming the form: its submissions now move its case's last-modified date.

**Register.** 11 entries move to the fixed register: `d14-non-writing-followup-app-schema-form-actions-update-never-followup-alone`, `-app-update-never-followup-alone-6cae`, `-c173` (manifest) and `-app-condition-type`, `-blocks`, `-blocks-case`, `-form-case-case-id`, `-form-case-date-modified`, `-form-case-user-id`, `-form-instance-case`, `-trace-case` (proof4), all on control `case-operation-query`.

**Spelling rule.** `proof/rules/update_never_beside_actions.py` retires with its test and its `RULES` line. Its three "build alike" cases are exactly the forms that now carry `always`. `proof/rules/conftest.py::DOCUMENTS` loses `case-capture-multiple` and `nested-menu-same-multiple`, which only that test reads. `proof/rules/preload_condition.py` stays (block 10).

**Identity.** None in HQ. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` keeps showing all 11.

**Nova tests.**
- Pure: `buildFormActions` writes `always` for each of the three case form types with an empty map, and `never` for a survey and for a form of a menu with no case type.
- Pure, format oracle: the local touch block is `<case>` with its three attribute binds and no `<update>` child, beside a writing follow-up that has one (`lib/commcare/__tests__/caseBlocks.test.ts`).
- Real Postgres (`lib/case-store/__tests__/followupTouch.postgres.test.ts`): a write-free single-selection follow-up advances `modified_on`; the same form over several selected cases does not.
- Pure: `behavior.ts` over a frozen pre-step fixture returns exactly one `follow-up-now-touches-case` record, for the write-free follow-up in a single-select menu, and none for its neighbours: a follow-up with one write, and a write-free follow-up in a multi-select menu.

**Lane.** Locally: `case-operation-query`, `case-capture-multiple`, `targeted-search-hq-compile`. CI's full lane must show no `update_case` condition difference after a Case Management save on any document, proof 3 agreeing on the touch block across the two paths, and the lane passing with the rule gone.

## 2. Close conditions the Case Management tab cannot state

**Today.** `lib/commcare/formActions.ts::buildFormActions` writes `close_case.condition` as `if` for any close form with a field and an answer, with the answer as entered. `lib/domain/forms.ts` holds `closeCondition` as `{ field, answer, operator? }` and `lib/commcare/validator/rules/form.ts::closeConditionValidation` checks only type, completeness and that the field is in the form.

**Fix.** The condition stays authorable on any question. From step 2 a derived placement decides where the close is written.

*The statable rule.* A close condition is statable by HQ's Case Management tab when all five hold. Otherwise its placement is Save to Case.

| # | Clause | Source |
|---|---|---|
| 1 | The field's kind is `single_select`, `multi_select`, `hidden` or `label` | `templates/app_manager/partials/forms/case_config_ko_templates.html` (`case-config:condition`) offers `getQuestions('select select1', ...)`; `static/app_manager/js/case_config_utils.js::getQuestions` adds `hidden` and `trigger` |
| 2 | The field has no `repeat` ancestor | The form's own case transaction allows no repeats (`case_config_ui.js::HQFormActions.to_case_transaction`); `getQuestions` drops a question with `q.repeat` |
| 3 | The answer holds no `'` | `xform.py::XForm.action_relevance` writes the answer between single quotes, so an answer holding `'` is outside what the tab can state |
| 4 | The answer neither starts nor ends with `"` | `views/forms.py::edit_form_actions` strips `"` and `'` from both ends on every Case Management save |
| 5 | For a select with inline options, the answer is one of its option values | The answer control is then a dropdown bound to the stored answer (`case_config_utils.js::getAnswers`, the `optstr` binding in the same template). Read at source: a bound value that matches no option is replaced by the first option on load. A lookup-backed select has no inline options, takes a text box, and is not subject to this clause |

Clause 5 rests on reading alone. The fix's pull request confirms it by one local lane run with clause 5 switched off, on the form this pull request adds to `targeted-close-conditions` for the purpose (a single-select question with inline options `a` and `b`, and a close answer `c`): if proof 4's Case Management save changes `close_case.condition.answer`, the clause stays; if the save keeps the answer, the clause is deleted before merge, since it would then ask for the Save to Case privilege for nothing. The pull request records which. The added form stays in the document either way, as the witness for clause 5 or for its deletion.

*The placement function.* `lib/domain/closeCondition.ts::closeConditionPlacement(doc, formUuid): "form-action" | "save-to-case"`. It is derived, never stored: step 5 makes placement a held property of an operation. An unconditional close is `form-action`.

*What is emitted for `save-to-case` in a single-select form.*

- HQ JSON: `close_case.condition` is `never`. `update_case` stays as block 1 writes it, so the case's writes stay in the Case Management slot.
- Form source, the same bytes on both export paths:

```
/data/nova_operations/nova_condition_close/nova_close/case   (@case_id, @date_modified, @user_id)
                                                        /close
```

- `nova_condition_close` is a group whose bind carries `relevant`, the expression `lib/commcare/xform/caseOps.ts::formActionConditionExpression` already builds (`<path> = <literal>` or `selected(<path>, <literal>)`, the literal quoted through `xpathStringLiteral`, the question read by absolute path so a question in a repeat keeps today's meaning). Reason for a group over `relevant` on `case/close`: an untaken condition then sends no block at all, and it is the one spelling a conditional close of an authored operation uses (part 05, Wrapper conditions (defect 13)).
- `nova_close` is a close-only Save to Case block. It has no `nova_caseid_` node: its `@case_id` bind's calculate is the session read `instance('commcaresession')/session/data/case_id` itself (`caseOps.ts::SESSION_CASE_ID`). Reason: a `nova_caseid_<operation>` node holds an authored target expression, and here there is none to hold. So the diagram above is the whole subtree, and `planGeneratedNodes` mints two names for it, no third.
- Both names come from `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`, the one allocator for every generated name, which suffixes a number on collision with an authored question (part 05, The one allocator).
- `lib/commcare/xform/caseBlocks.ts::addCaseBlocks`, driven by the same form actions, writes no `<close/>` in the primary block.

*A multi-select form.* It already closes through a Save to Case block for every selected case (`caseOps.ts`, the `ordinaryCloseCondition` branch), whatever the condition. That block is unchanged. From step 2 its HQ JSON `close_case.condition` is `never` when the placement is `save-to-case`, so the tab holds no answer it would rewrite.

*Consequences, each stated on the surface that shows it.*

- **The app needs `save_to_case`.** Nothing here keys a privilege on the placement. The privilege follows from the emitted block: `lib/commcare/xform/caseOps.ts::formEmitsSaveToCase` (pull request 13; part 03, C2. Plan features: the per-privilege confirmation) is true for any form whose source holds a Save to Case block, and `lib/commcare/planPrivileges.ts::requiredPlanPrivileges` reads it, so from pull request 13 publish asks for that confirmation. The builder says so beside the condition: "CommCare HQ saves this condition as a Save to Case close. Publishing checks that the project space's plan includes Save to Case."
- **The close runs before the form's own update.** Core applies case blocks in document order and HQ's build appends its primary block after the source's. The final case state is the same: closed, with the form's writes.
- **HQ shows the form as an update form.** `models/forms.py::Form.get_action_type` reads `close_case`. Cosmetic, and true of any Save to Case close.

**Files.**
- Domain: `lib/domain/closeCondition.ts` (new), `lib/domain/index.ts`.
- Validator: none. No refusal is added.
- Emitters: `lib/commcare/formActions.ts`, `lib/commcare/xform/caseOps.ts`, `lib/commcare/xform/generatedNodes.ts`. `lib/commcare/planPrivileges.ts` does not exist until pull request 13 and is not touched here.
- Manifest: the entries in `lib/commcare/surface/entries/forms-and-case-writes.json` whose value classes are `own-case-condition-not-offered-or-quoted` and `answer-with-apostrophe` (Nova no longer emits either).
- Proof: `proof/targeted/documents/closeConditions.ts` (the clause 5 form above).
- Preview: none. `lib/preview/engine/formEngine.ts::computeCloseConditionAnswers` already evaluates the condition on any question.
- Builder: `components/builder/detail/formSettings/CloseConditionSection.tsx`, the close condition editor (the copy above, shown under the condition when the placement is `save-to-case`). It is the only builder file that reads `closeCondition`.
- SA and MCP tools: `lib/agent/planningSchemas.ts::closeConditionInputSchema`, the one close-condition input shape every tool that takes a `close_condition` shares (`lib/agent/tools/updateForm.ts` reads it). Its description gains one sentence, with no change to the shape: a condition on a text, number or date answer, inside a repeat, or with a quote mark in its answer is saved as a Save to Case close, which needs that plan feature in HQ.
- Docs: `content/docs/case-changes.mdx`, `content/docs/project-space-compatibility.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the placement rule, beside the sentence that authored operations run before the ordinary primary action), `lib/domain/CLAUDE.md`.

**Stored shape and migration.** No schema change, no document change and no step. `behavior.ts` returns one record per close form in a single-select menu whose placement is `save-to-case`. Notice reason `close-moves-to-save-to-case`, naming the form: its close is written another way, HQ's Case Management tab no longer shows it, and its next publish asks about one more plan feature. A multi-select close gets no record: it is already a Save to Case close and its plan feature is already needed.

**Register.** 23 entries move to the fixed register, all `d14-close-conditions-*`: `-admission-unresolved-resource` (bar); `-app-own-case-condition-not-offered-or-quoted-3731`, `-2119`, `-2f42`, `-ba84`, `-bf5c`, `-app-answer-with-apostrophe-ab34`, `-4107` (manifest); `-blocks-case-close-937a`, `-blocks-closed-9db3`, `-trace-case-status-7b66`, `-trace-case-last-modified-b2a8`, `-trace-case-close-7842` (proof3); `-app-condition-answer`, `-app-condition-question`, `-blocks-case-close-3452`, `-blocks-closed-cf78`, `-form-close-relevant`, `-trace-case-status-4d82`, `-trace-case-last-modified-7f74`, `-trace-case-close-f132`, `-trace-validate-app-path-error`, `-validate-path-error` (proof4). Eleven pin `values`, which a fixed entry compares on its control alone.

**Spelling rule.** None.

**Identity.** The close's block moves once in each existing deployment's submissions, from `/data/case/close` to `/data/nova_operations/nova_condition_close/nova_close/case/close`, so HQ form exports show the close under the new path from the next publish. The notice says so. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-close-conditions` and `targeted-close-condition-unparsable` keep their pre-fix bytes and keep showing all 23.

**Nova tests.**
- Pure: `closeConditionPlacement`, each of the five clauses failing beside its nearest passing neighbour (a text question and a select; in a repeat and beside it; `it's` and `its`; `"x` and `x`; an answer that is and is not an option value; a lookup-backed select with any answer).
- Pure, emission: a `save-to-case` close writes `close_case` `never`, the group, the block and no primary `<close/>`; an answer holding `'` and one holding both quote marks print as valid XPath literals; a statable condition still writes `close_case` `if`.
- Pure, in pull request 13, not here: that pull request's `requiredPlanPrivileges` test includes a form whose close is placed `save-to-case` (yields `save_to_case`) beside one whose close is statable (does not).
- Pure: `behavior.ts` over a frozen pre-step fixture returns exactly one `close-moves-to-save-to-case` record, for the unstatable close in a single-select menu, and none for a statable close or a multi-select close. The same test holds the one-time path change: the fixture records the pre-step close path `/data/case/close`, and the migrated document's form source holds the close at `/data/nova_operations/nova_condition_close/nova_close/case/close` and nowhere else.
- Native proof: none new. The close-only Save to Case block is the shape the multi-select close already runs.

**Lane.** Both targeted documents stay admitted and turn from symptom to witness. The lane derives `save_to_case` for both documents from the Save to Case block HQ receives (`proof/checks/configurations.py::PRIVILEGE_RULES`, `_needs_save_to_case`); no configuration file is edited. Locally: both documents and `case-capture-multiple`. CI's full lane must show the bar admitting HQ's build, proof 3 agreeing across the two paths on the close and the case's final state, and proof 4 keeping the block and the group's `relevant` through a Case Management save and a Vellum save. If Vellum's save moves or drops the group, the fallback is the one part 05, Facts that rest on reading, decides for the group containers, under which `nova_condition_close` is unchanged, and this block follows it.

## 3. After-submit destinations: `firstMenu`, `parentMenu` and `POST_SUBMIT_NOT_OFFERED`

**Today.** `lib/domain/forms.ts::POST_SUBMIT_DESTINATIONS` is `app_home`, `module`, `previous`, and `defaultPostSubmit` gives a case-loading form `previous`, or `module` in a menu that opens on Search. Nothing reads the selection mode, so a follow-up in a multi-select menu defaults to `previous` and `lib/commcare/session.ts::toHqWorkflow` writes `previous_screen`, which HQ's form settings page cannot save and HQ's build refuses where exactly one of the menu and its parent is multi-select.

**Fix.**

*The model.* `POST_SUBMIT_DESTINATIONS = ["app_home", "firstMenu", "module", "parentMenu", "previous"]`.

| Destination | HQ `post_form_workflow` | Local `<stack>` | What Core does (read at source) |
|---|---|---|---|
| `app_home` | `default` | no frame | The session ends. Android returns to the app's home screen; Web Apps shows the list of menus |
| `firstMenu` | `root` | one `<create/>` with no children | An empty frame is pushed, so the next step needed is a command and the list of menus opens on both runtimes (`suite_xml/post_process/workflow.py::EndOfFormNavigationWorkflow._get_static_stack_frame`, `allow_empty_frame`) |
| `module` | `module` | the menu's command, with its root path | Unchanged |
| `parentMenu` | `parent_module` | the parent menu's frame: `lib/commcare/formLinkProjection.ts::moduleFrameChildren` for the form's menu without its last child, matched to the source like the `module` frame | The parent menu opens with the selections its forms share (`_frame_children_for_module(module.root_module)`) |
| `previous` | `previous_screen` | the form's frame without its last child | Unchanged |

`lib/commcare/session.ts::derivePostSubmitStack` gains the two cases (today it returns no frame for a childless one), `NOVA_TO_HQ` gains `firstMenu: "root"` and `parentMenu: "parent_module"`, and `deriveFormLinkStack` writes the same frames for a fallback. `lib/commcare/validator/hqJsonOracle.ts` already admits both wire words.

*The offered set.* `lib/domain/postSubmit.ts::postSubmitDestinationsOffered(doc, formUuid)` returns, as HQ's form settings page offers them (`views/forms.py`, the `form_workflows` context):

- `app_home` and `firstMenu`: always.
- `module`: unless the menu's parent is multi-select, and unless the menu is `caseListOnly`.
- `previous`: unless the menu's parent is multi-select, the menu is multi-select, or the menu opens on Search.
- `parentMenu`: when the menu has a parent and the parent is not multi-select.

The offered set contains HQ's build rule (`helpers/validators.py::FormBaseValidator.validate_for_module`, `mismatch multi select form links`, `workflow previous inline search`, `form link to missing root`): each arm of each is unoffered. So one rule covers the editor and the build.

*The default.* `defaultPostSubmit(formType, { searchFirst, multiSelect, parentMultiSelect })` returns `app_home` for a registration or a survey, and for a case-loading form the first offered of `previous`, `module`, `firstMenu`. `defaultPostSubmitOf` supplies the facts.

*The validator.* One rule, `POST_SUBMIT_NOT_OFFERED` (soundness, located at the form), replaces `lib/commcare/validator/rules/form.ts::postSubmitValidation` and `rules/case-search/searchFirst.ts::searchFirstNoPreviousWorkflow`. `POST_SUBMIT_MODULE_CASE_LIST_ONLY` and `SEARCH_FIRST_NO_PREVIOUS_WORKFLOW` are removed from `validator/errors.ts`, `validator/gate.ts` and `lib/doc/userFacingErrors.ts`, and their sentences become two of the rule's per-reason messages. The message names the destination, the reason, and the destinations offered:

| Reason | Message stem |
|---|---|
| The menu selects several cases | `"<form>" goes to the previous screen after submit, but "<menu>" selects several cases, and CommCare has no previous screen to return to there.` |
| The parent menu selects several cases | `"<form>" goes to <destination> after submit, but "<menu>" sits under "<parent>", which selects several cases.` |
| The menu opens on Search | the sentence `SEARCH_FIRST_NO_PREVIOUS_WORKFLOW` carries today |
| The menu is a case list with no forms | the sentence `POST_SUBMIT_MODULE_CASE_LIST_ONLY` carries today |
| The menu has no parent | `"<form>" goes to the parent menu after submit, but "<menu>" has no parent menu.` |

Each ends with "Choose one of: <offered destinations>." `parentMenu` with no parent is a reason of the one rule, not a code of its own.

*The exemption for a fallback beside links.* When a form holds `formLinks`, `postSubmit` is the fallback after its links. The two multi-select reasons do not apply to such a form until step 5. `lib/domain/postSubmit.ts::postSubmitDestinationsAdmitted(doc, formUuid)` is the set the rule, the reducers and the cutover all read: the offered set for a form without links, and for a form with links the offered set computed with the two multi-select conditions ignored. Reason: a fallback HQ's settings page does not offer is defect 26's symptom, defect 26 is step 5's, and the lane's document for it (`targeted-form-links-hidden-and-fallback`, a follow-up with links in a multi-select menu and `postSubmit: "previous"`) must stay admissible until then. The other three reasons apply to every form, with or without links: the gate already refuses two of them today, and HQ cannot build `parent_module` with no parent.

*Reducers.* `lib/doc/mutations/modules.ts::reconcilePostSubmitWithSearchFirst` becomes `reconcilePostSubmitWithMenuShape`, so a mode change never dead-ends. It runs when a menu's selection mode, parent menu or Search-first setting changes, and for each child when a parent's selection mode changes. It reads the admitted set before and after the change, for every form, with or without links:

- An explicit destination that leaves the admitted set moves to the nearest admitted (`previous` to `module`, else `firstMenu`; `module` to `firstMenu`; `parentMenu` to `firstMenu`).
- An absent slot whose effective destination D leaves the admitted set stays absent and takes the new default.
- An absent slot whose D is still admitted, while `defaultPostSubmit` would now return another value, is pinned to D, as the Search-first reconciliation does today. This covers a destination coming back (a menu returning to single-select would move the default from `module` to `previous`) and a form that holds links (its menu turning multi-select moves the default from `previous` to `module`, while `previous` stays admitted for it).
- An explicit destination that stays admitted is kept. For a form that holds links that includes a fallback the settings page no longer offers, on the same boundary as the exemption.

*No-matches forms.* `lib/commcare/expander.ts::expandDoc` writes `root` for a no-matches form whose `postSubmit` is `app_home`, and `lib/commcare/compiler.ts` one empty `<create/>`, because HQ reads `default` there as a return to the case list. That is `firstMenu` under another name. From step 2 the document says what the wire does: the one explicit destination a no-matches form may hold is `firstMenu`, `rules/case-search/searchNoMatches.ts` reads `firstMenu` where it reads `app_home`, and the `plan.synthetic.has(moduleUuid) && form.postSubmit === "app_home"` special case and the compiler's `resetToAppHome` test are replaced by the ordinary `firstMenu` lowering. No byte changes. The two no-matches messages (`SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN` and `SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION`, in the rule and in `lib/doc/userFacingErrors.ts`) and `create_form`'s refusal in `lib/agent/tools/createForm.ts` say First menu where they say App home, and name `firstMenu` where they name `app_home`; an absent slot still returns to the search.

*Preview.* `lib/domain/navigation.ts::formNavigation` resolves `firstMenu` to the same `{ screen: "home" }` destination as `app_home` and `parentMenu` to `moduleDestination(doc, parentUuid)` with the parent's selections kept. `lib/preview/noMatchesForm.ts::noMatchesPostSubmit` reads `firstMenu`.

*Builder.* The destination pickers offer exactly `postSubmitDestinationsOffered`, plus a stored fallback while the exemption admits it. Labels: "App home", "First menu", "This menu", "Parent menu: <name>", "Previous screen". Helper text for First menu: "Opens the list of menus. On Android, App home opens the app's home screen, and First menu opens the list of menus."

*SA and MCP.* `post_submit` on `create_form` and `update_form` takes the five values (the enum is `POST_SUBMIT_DESTINATIONS`), and its description states the offered set and the default. A no-matches form takes `firstMenu` where it took `app_home`.

**Files.**
- Domain: `lib/domain/forms.ts`, `lib/domain/postSubmit.ts`, `lib/domain/navigation.ts`, `lib/domain/menuForms.ts`, `lib/domain/index.ts`. `lib/domain/referenceSlots.ts` classes `postSubmit` as a config slot and does not change.
- Doc and mutations: `lib/doc/mutations/modules.ts`, `lib/doc/formLinkMutations.ts`, `lib/doc/searchNoMatchesForm.ts`, `lib/doc/hooks/useFormLinkFacts.ts`, `lib/doc/hooks/useFormLinks.ts`, `lib/doc/userFacingErrors.ts`. `lib/doc/hooks/useBlueprintMutations.ts` passes the value through and does not change.
- Validator: `lib/commcare/validator/rules/form.ts`, `rules/case-search/searchFirst.ts`, `rules/case-search/searchNoMatches.ts`, `rules/module.ts` (drops the import and registration of `searchFirstNoPreviousWorkflow`), `validator/errors.ts`, `validator/gate.ts`.
- Emitters: `lib/commcare/session.ts`, `lib/commcare/expander.ts`, `lib/commcare/compiler.ts`, `lib/commcare/formLinkProjection.ts`, `lib/commcare/previousTaskProjection.ts`; the manifest entries for `post_form_workflow` and `post_form_workflow_fallback` in `lib/commcare/surface/entries/forms-and-case-writes.json` (`root` and `parent_module` become held; `not-offered` becomes refused by the gate).
- Preview: `lib/preview/afterSubmitRouting.ts`, `lib/preview/engine/navigationProjection.ts`, `engine/postSubmissionEvaluation.ts`, `engine/formLinkEvaluation.ts`, `engine/previousTask.ts`, `lib/preview/app-tests/submission.ts` (its switch over the destination gains the two cases), `lib/preview/app-tests/navigation.ts` (the parent menu opened with its kept selections), `lib/preview/noMatchesForm.ts`, `components/preview/screens/FormScreen.tsx`.
- Builder: `components/builder/form-links/FallbackChooser.tsx`, `form-links/afterSubmitCopy.ts`, `detail/formSettings/FormEntrySection.tsx`, `detail/formSettings/NoMatchesAfterSubmitSection.tsx`, `detail/formSettings/noMatchesAfterSubmit.ts` (the `app_home` literal becomes `firstMenu`), `case-list-config/noMatchesFormReview.tsx`; the e2e seeds that set a destination, `e2e/lib/formLinksSeed.ts`, `e2e/lib/caseChangesSeed.ts` and `e2e/lib/previousTaskSeed.ts`, each re-checked against the admitted set, a no-matches seed taking `firstMenu`.
- SA and MCP tools: `lib/agent/tools/createForm.ts`, `updateForm.ts`, `getForm.ts`, `form-links/addFormLinks.ts`, `form-links/updateFormLink.ts`, `form-links/removeFormLink.ts`, `shared/formEntry.ts`, `lib/agent/summarizeBlueprint.ts`, `lib/agent/blueprintHelpers.ts`. The model-facing text that lists or names a destination is in three of those files and nowhere else: the `post_submit` description and the no-matches refusal in `createForm.ts`, the `post_submit` description and the no-matches refusal in `updateForm.ts`, and the `search-no-matches` entry description in `shared/formEntry.ts`. The set is defined by a search of `lib/agent` outside `__tests__` for `app_home` and `post_submit`, re-run in the pull request; `lib/agent/prompts.ts`, `lib/agent/promptSegments.ts`, `lib/agent/planning/` and `lib/agent/authoring/` name no destination today (`lib/agent/authoring/reference.ts` speaks of after-submit navigation without listing one) and are not edited. The `/agents` pages render the result, and the pull request reads the three descriptions there.
- Proof: `proof/targeted/documents/multiSelectDestinations.ts`, `proof/targeted/documents/stableWitnesses.ts`, `proof/corpus/footprint.ts`.
- Docs: `content/docs/form-links.mdx`, `content/docs/nested-menus.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the `post_submit` defaults; the "`previous` + `multi_select`" validation stub line is deleted), `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/preview/CLAUDE.md`, `components/builder/CLAUDE.md`.

**Stored shape and migration.** `Form.postSubmit` gains two enum members; an old document parses unchanged. Cutover step `post-submit`, over each form. "Effective" is the stored value, or for an absent slot what today's `defaultPostSubmit` returns, which the step carries in its own file because `lib/domain/forms.ts` no longer has it.

| Form | Before | After | Notice |
|---|---|---|---|
| No links, effective destination not offered, stored or by default | `previous` in a multi-select menu | `module`, written explicitly | `after-submit-destination-moved`, with `from` and `to` |
| No links, effective destination not offered, stored or by default | `previous` or `module` under a multi-select parent | `firstMenu`, written explicitly | same |
| Holds links, absent slot whose default changes | effective `previous` or `module` | that destination, written explicitly | none: nothing changes |
| Holds links, explicit destination | any | unchanged | none |
| No-matches form | `app_home` | `firstMenu` | none: the same bytes and the same screen |

Every write is explicit, so each notice record names a stored change and no absent slot changes meaning at the cutover. This differs from the reducer's second rule on purpose: a live edit leaves an absent slot to the default because its author is looking at the picker, and the cutover has no one looking.

`parentMenu` is never the migration's answer: HQ withholds `module` only under a multi-select parent, and there it withholds `parent_module` too. It is added because it costs one frame slice and HQ's page offers it.

**Register.** 3 entries move to the fixed register: `d14-multi-select-validate-mismatch-multi-select` (bar, control `targeted-multi-select-destinations`), `d14-multi-select-app-schema-form-post-form-workflow-not-offered` (manifest, control `case-capture-multiple`), `d14-multi-select-editor-jsonobject-exceptions-badvalueerror` (proof4, control `case-capture-multiple`).

**Spelling rule.** None. `proof/rules/form_link_fallback.py` stays.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-multi-select-destinations` and `case-capture-multiple` keep showing the three.

**Nova tests.**
- Pure: `postSubmitDestinationsOffered` over the menu shapes (single, multi-select, under a multi-select parent, opens on Search, `caseListOnly`, with and without a parent).
- Pure, property: for every generated menu shape and form type, `defaultPostSubmit` is in the offered set.
- Pure: `POST_SUBMIT_NOT_OFFERED`, each reason beside an accepted neighbour, and the exemption (a form with links and `previous` in a multi-select menu is admitted; the same form without links is refused; `parentMenu` with no parent is refused with links too).
- Pure, state model: the reducer reconciliation over each mode change, one case per rule above, including a link-holding form with an absent slot whose menu turns multi-select (pinned to `previous`), a link-holding form with an explicit `previous` there (kept), and a link-holding form whose menu starts opening on Search (its explicit `previous` moves to `module`).
- Pure, wire parity: the `firstMenu` and `parentMenu` frames against HQ's build output in `lib/commcare/__tests__/formLinkParity.test.ts`, as a form's own destination and as a fallback.
- Pure, state model: Preview's routing for both destinations and for a no-matches form with `firstMenu`.
- Pure: the cutover step over frozen pre-step fixtures, one per row of the table above, the absent-slot and stored variants of the first two rows each, and that a second application changes nothing.

**Lane.**
- `targeted-multi-select-destinations` is rewritten in place to the migrated shape: a follow-up in a multi-select menu going to `module`, a follow-up under a multi-select parent going to `firstMenu`, and a follow-up in a single-select child menu going to `parentMenu`. It becomes the corpus witness for the two new destinations.
- `targeted-form-links-hidden-and-fallback` is not edited and must still be admitted; defect 26's nine entries stand.
- Every multi-select producer document that leaves `postSubmit` absent changes bytes with no source edit, since the default changes. The pull request runs the corpus emission first and diffs `index.json`.
- Locally: the rewritten document, `case-capture-multiple`, `case-extension-multiple`, `nested-menu-same-multiple`, `targeted-form-links-hidden-and-fallback`. CI's full lane must show the bar admitting every multi-select document, proof 3 agreeing across the two paths on the session after submit for both new destinations, and proof 4's form settings save keeping each.

## 4. The search button label leaves the model

**Today.** `lib/domain/modules.ts` holds `caseSearchConfig.searchButtonLabel` with `DEFAULT_CASE_SEARCH_BUTTON_LABEL = "Search"`, and `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument` writes it as `search_button_label` from the `module/<uuid>/search-button` translation unit. Every Case List save in HQ resets it.

**Fix.** `searchButtonLabel` and `DEFAULT_CASE_SEARCH_BUTTON_LABEL` are removed. Every search button reads "Search All Cases", in every language, on both export paths and in Preview.

- Reason: HQ's Case List save assigns a new `CaseSearch` with no `search_button_label` (`views/modules.py::_gather_and_update_search_properties`), so the model default `{'en': 'Search All Cases'}` returns (`models/case_search.py::CaseSearch.search_button_label`), and HQ's app strings read it through `clean_trans` for every language (`app_strings.py::_create_case_search_app_strings`). No editor can produce or keep another label.
- The text lives once, behind the wire boundary: `lib/commcare/suite/case-search/searchButtonLabel.ts::CASE_SEARCH_BUTTON_LABEL`. `lib/commcare/hqShells.ts::caseSearchConfigShell` already writes `{ en: "Search All Cases" }` and keeps it; the override in `buildSearchConfigDocument` is deleted; `lib/commcare/suite/case-search/remoteRequest.ts` and the locale file write the constant for every language; Preview reads it through `lib/preview/workerModule.ts`.
- The search button's display condition (`searchButtonDisplayCondition`) is unchanged, and so is every reader of the `search-button` surface that names it: `lib/commcare/validator/rules/case-list/moduleWireSlots.ts`, `components/builder/case-list-config/workspaceSelection.ts`, `case-list-config/canvas/SearchConditionCanvas.tsx` and the surface label in `lib/doc/userFacingErrors.ts`.
- This is the one fix here that takes text away from workers in a translated app: a button that read a translated label reads English from the next publish. The notice says so.

**Files.**
- Domain: `lib/domain/modules.ts` (the slot, the constant, `effectiveCaseSearchConfig`'s presence tests), `lib/domain/translationUnits.ts` (the `search-button-label` role and its unit), `lib/domain/localizedBlueprintProjection.ts`, `lib/domain/referenceSlots.ts`.
- Doc and mutations: `lib/doc/caseSearchConfigPatchMutations.ts`, `lib/doc/projectBuilderLanguageMutations.ts`, `lib/doc/types.ts`.
- Validator: `lib/commcare/validator/hqJsonOracle.ts` (refuses any `search_button_label` other than the constant).
- Emitters: `lib/commcare/hqJson/caseList.ts`, `lib/commcare/suite/case-search/remoteRequest.ts`, `lib/commcare/suite/case-search/searchButtonLabel.ts` (new), `lib/commcare/localeFile.ts` (the role leaves `LOCALE_FILE_TRANSLATION_ROLES`), `lib/commcare/types.ts`; the manifest entry for `schema:CaseSearch.search_button_label` in `lib/commcare/surface/entries/case-search.json` and its mentions in `entries/gates.json`.
- Preview: `lib/preview/workerModule.ts`, `components/preview/screens/CaseListScreen.tsx`.
- Builder: `components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx`, `case-list-config/CaseListConfigWorkspace.tsx`, `components/builder/app-setup/LanguagesSection.tsx`; `e2e/lib/caseWorkspaceSeed.ts`, `e2e/lib/case-workspace-surface-client.tsx`, `e2e/tests/browser/case-workspace-surface.spec.ts`.
- SA and MCP tools: `lib/agent/tools/case-search-config/shared.ts` (the field list and the schema of `set_case_search_display`), `lib/agent/translation/translator.ts`.
- Proof: `proof/targeted/documents/searchApps.ts` (the `targeted-search-button-label` document is deleted; the slot is removed from `targeted-search-hq-compile`), `proof/targeted/index.ts`, `proof/targeted/documents/stableWitnesses.ts`, `proof/timings.json`, `proof/README.md` (its row), `lib/commcare/__tests__/searchEmissionFixture.ts`. `proof/checks/manifest_value_classes.py`, its test `proof/checks/test_manifest_value_classes.py` and `proof/checks/compare/app_json.py` keep reading the label and are not edited, since the fixed entries read it on the control.
- Docs: `content/docs/case-workspace.mdx`, `content/docs/languages.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`.

**Stored shape and migration.** `caseSearchConfig` is a strict object, so the key must leave every stored document. Cutover step `search-button-label`: delete `searchButtonLabel` from every module's `caseSearchConfig`, and delete every language's stored translation of the unit `module/<uuid>/search-button`. Notice reason `search-button-text-changed`, one record per module that offers a search button, labelled or not (an unlabelled one reads "Search" today), with the former text in the default language as `from`: the button now reads "Search All Cases" in every language.

**Register.** 4 entries move to the fixed register: `d14-search-settings-app-other-value` (manifest), `d14-search-button-label-app-search-config-search-button-label`, `-strings-case-search-m`, `-trace-actions` (proof4), all on control `case-operation-query`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` keeps showing the four.

**Nova tests.**
- Pure: the strict schema refuses `searchButtonLabel`, beside a config without it.
- Pure, emission: HQ JSON, the local suite's locale and Preview's worker module carry the constant for an app with two languages.
- Pure: the cutover step over a frozen fixture holding a label and its translations in two languages; the output parses under the new schema and holds neither.
- Playwright: `e2e/tests/browser/case-workspace-surface.spec.ts` no longer edits a label and still passes.

**Lane.** Locally: `targeted-search-hq-compile`, `case-list-browse`, `search-browse`. CI's full lane must show the Case List save changing no `search_button_label` on any document and proof 3 agreeing on the action's text across the two paths.

## 5. A sort column on a lookup-backed search input

**Today.** `lib/commcare/suite/case-search/searchPrompts.ts::buildItemset` returns `{ instanceId, nodeset, label, value }` and `lib/commcare/hqJson/caseList.ts::projectSearchInput` writes those four. `lib/domain/lookupCarriers.ts::lookupOptionsSourceSchema` has no sort. HQ's Case List save answers 400 for such a prompt.

**Fix.** A search input's lookup choices gain a sort column, the label column when absent.

- Reason: `views/modules.py::_update_search_properties` (its `_get_itemset`) requires `instance_id`, `nodeset`, `label`, `value` and `sort`, and raises `CaseSearchConfigError` for a missing one. HQ's build writes `sort` as `<sort ref>` (`suite_xml/post_process/remote_requests.py`, `suite_xml/xml_models.py::Itemset.sort_ref`), and Core sorts the choices by it (commcare-core `xml/QueryPromptParser.java`, `core/model/ItemsetBinding.java::sortChoices`, `String.compareTo`, so UTF-16 code unit order, stable for ties).
- **Schema.** The sort belongs to search inputs only, since a form select shares `LookupOptionsSource` and its emitter writes no sort. In `lib/domain/modules.ts` both choice-input arms take `searchInputLookupOptionsSchema = lookupOptionsSourceSchema.extend({ sortColumnId: lookupColumnIdSchema.optional() })`, type `SearchInputLookupOptions`. Absent means the label column. One meaning has one spelling: the `addSearchInput` and `updateSearchInput` arms of `lib/doc/mutations/modules.ts` drop a `sortColumnId` equal to `labelColumnId` on every write of an input's `options`. `updateSearchInput` replaces the whole input, so a later label change that makes the two equal passes through the same arm and drops it too.
- **Lookup identity.** `lib/doc/lookupReferences.ts` registers `sortColumnId` as a column occurrence (subpath `["sortColumnId"]`), so the missing-column finding, the deletion guard and the app-move refusal see it.
- **Emitters.** `SearchPromptItemset` gains `sort`; `buildItemset` sets it from `sortColumnId ?? labelColumnId`; `buildSearchPrompts` writes `<sort ref>` after `<value>`; `projectSearchInput` writes `itemset.sort`.
- **Preview.** `lib/preview/engine/searchExpressionEvaluation.ts` lists a search input's lookup choices in the sort column's order: `lib/preview/engine/lookupEvaluation.ts::evaluateLookupChoices` takes an optional sort column and orders by its cell text with plain string comparison, never `localeCompare`, keeping row order for ties. A form select passes none and keeps row order.
- **Builder.** A "Sort choices by" column picker in `components/builder/case-list-config/inspector/SearchChoiceSourceEditor.tsx`, showing "Label column" when absent.
- **SA and MCP.** `add_search_inputs` and `update_search_input` take `options.sortColumnId` (those tools take the domain's option shape, so the name is the domain's), with the default stated. `lib/agent/identitySchema.ts` classes the property `sortColumnId` as a lookup column, beside `labelColumnId`, so the tool schemas carry it as an identity.

**Files.**
- Domain: `lib/domain/modules.ts`, `lib/domain/referenceSlots.ts`.
- Doc and mutations: `lib/doc/mutations/modules.ts` (the canonical absence), `lib/doc/searchInputMutations.ts` (the builders carry the slot), `lib/doc/lookupReferences.ts`.
- Validator: none new. The existing lookup column findings cover the new occurrence.
- Emitters: `lib/commcare/suite/case-search/searchPrompts.ts`, `lib/commcare/hqJson/caseList.ts`, `lib/commcare/validator/hqJsonOracle.ts` (an itemset without `sort` is refused).
- Preview: `lib/preview/engine/lookupEvaluation.ts`, `lib/preview/engine/searchExpressionEvaluation.ts`.
- Builder: `components/builder/case-list-config/inspector/SearchChoiceSourceEditor.tsx`.
- SA and MCP tools: `lib/agent/tools/case-list-config/shared.ts`, `addSearchInputs.ts`, `updateSearchInput.ts`, `lib/agent/identitySchema.ts`, `lib/agent/summarizeBlueprint.ts`.
- Proof: `proof/native/core/SearchPromptRuntimeTest.java`, `proof/native/test_search_emission.py`.
- Docs: `content/docs/case-workspace.mdx`, `content/docs/project-data.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, `lib/lookup/CLAUDE.md` (the new occurrence a table deletion sees).

**Stored shape and migration.** One new optional slot; no document changes, since absent already means the label column. No step: `behavior.ts` returns one record per lookup-backed search input. Notice reason `lookup-choices-order-changes`, naming the input: its choices are now listed in the order of their labels, where they were listed in the table's row order.

**Register.** 3 entries move to the fixed register: `d14-search-lookup-prompt-editor-alerts-case-search-property`, `-editor-400-case-search-property`, `-editor-state-savebtn-bar-retry` (proof4), on control `prompt-widgets`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `prompt-widgets` keeps showing the three.

**Nova tests.**
- Pure, state model: the reducer stores a sort column equal to the label column as absent, on an add and on an update; an input holding a distinct sort column whose label column is then changed to that column ends with the slot absent; a removed sort column raises the lookup column finding.
- Pure: `behavior.ts` over a frozen pre-step fixture returns exactly one `lookup-choices-order-changes` record, for the lookup-backed input, and none for an input with inline choices.
- Pure, emission: `<sort ref>` and `itemset.sort` name the label column by default and the chosen column otherwise.
- Pure, state model: Preview's order over a table whose labels order differently by code unit and by locale (an upper-case and a lower-case initial, an accented letter), and ties keeping row order.
- Native proof: `SearchPromptRuntimeTest` gains a sorted itemset case that reads the choices Core presents, in order.

**Lane.** Locally: `prompt-widgets`. CI's full lane must show the Case List save accepted on every document with a lookup-backed prompt and proof 3 agreeing on the prompt's choices across the two paths.

## 6. Reserved search input names

**Today.** Nothing refuses a search input's name by HQ's request vocabulary. `lib/commcare/suite/case-search/searchPrompts.ts::searchInputSuppressesAutoMatch` decides which inputs reach HQ as their own request key.

**Fix.** Two refusals, by one derived set.

*Where the set comes from.* The generated surface holds a `csql-key` family of 19 items, read from HQ's own constants (`corehq/apps/case_search/models.py::CONFIG_KEYS_MAPPING`, `CASE_SEARCH_TAGS_MAPPING`, `UNSEARCHABLE_KEYS`, `corehq/apps/case_search/utils.py::CaseSearchQueryBuilder._apply_filter`, `corehq/apps/case_search/const.py`). Nova's set is that family minus `case_id` and `owner_id`:

- 16 names: `_xpath_query`, `case_type`, `case_types`, `commcare_blacklisted_owner_ids`, `commcare_project`, `commcare_sort`, `custom_related_case_property`, `data_registry`, `endpoint_id`, `include_all_related_cases`, `include_closed`, `x_commcare_custom_related_case_property`, `x_commcare_data_registry`, `x_commcare_endpoint_id`, `x_commcare_include_all_related_cases`, `x_commcare_tag_module_name`.
- One prefix: a name starting with `indices.` (the family's `indices.*` item). This is an addition to the research's set, stated: the surface derives it from the same constants. The schema's name pattern (`lib/domain/predicate/types.ts::XML_ELEMENT_NAME_PATTERN`, on `searchInputBase.name` in `lib/domain/modules.ts`) already excludes a dot, so no document can hold such a name, the rule can never fire on it and the cutover can never meet one. The prefix is carried so the constant equals the surface's family, and it is tested on `isReservedSearchInputName` alone.
- `case_id` and `owner_id` are left out because HQ searches them as the case id and the owner, which is what an exact input on them means.

The set lives in `lib/commcare/suite/case-search/reservedInputNames.ts` as `RESERVED_SEARCH_INPUT_NAMES`, `RESERVED_SEARCH_INPUT_NAME_PREFIXES` and `isReservedSearchInputName(name)`. It is a checked constant, never a runtime read of `surface.json`, since server code carries the gate entries alone. `lib/commcare/surface/__tests__/reservedInputNames.test.ts` holds it equal to the derivation from `surface.json`, so the weekly pin pull request fails when HQ adds a key.

*The rule.* `lib/commcare/validator/rules/case-list/searchInputReservedName.ts`, both soundness, located at the input:

| Code | Refuses | Reason |
|---|---|---|
| `CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER` | any input named `_xpath_query` | HQ's Case List save refuses a prompt named like one of the menu's default filters (`static/app_manager/js/details/case_claim.js::searchViewModel.commonProperties`), and Nova writes default filters only as `_xpath_query` rows |
| `CASE_LIST_SEARCH_INPUT_NAME_RESERVED` | an input that reaches HQ as its own key (`!searchInputSuppressesAutoMatch(input)`) whose name `isReservedSearchInputName` | HQ reads that key as part of the search request, so the input never searches the property it names |

Message, both codes: `Search input "<name>" in "<menu>" uses a name CommCare reads as part of the search request, so it would never search a case property. Rename the input.`

**Files.**
- Domain, doc and mutations: `lib/doc/userFacingErrors.ts` (the two renderers).
- Validator: `lib/commcare/validator/rules/case-list/searchInputReservedName.ts` (new), `validator/errors.ts`, `validator/gate.ts`, `lib/commcare/validator/rules/module.ts` (registers the rule).
- Emitters: `lib/commcare/suite/case-search/reservedInputNames.ts` (new), `lib/commcare/surface/__tests__/reservedInputNames.test.ts` (new).
- Manifest: the entries in `lib/commcare/surface/entries/case-search.json` whose value class is `reserved-request-key`, and the two whose value class is `shared-by-filter-and-prompt` (Nova no longer emits either).
- Preview: none.
- Builder: none beyond the refusal the input name field already shows.
- SA and MCP tools: the `name` descriptions in `lib/agent/tools/case-list-config/shared.ts` (description only, no schema change).
- Proof: `proof/targeted/documents/searchApps.ts`.
- Docs: `content/docs/case-workspace.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md`.

**Stored shape and migration.** No schema change. Cutover step `reserved-search-inputs`, per module, removing first and then renaming what remains:

1. Each own-key input whose name is reserved is removed. This includes an own-key input named `_xpath_query`: it is removed, not renamed, because a rename would make it start searching a property of the new name. Every `when-input-present` over it takes its absent branch and every read of it becomes the empty string, the rewrite `lib/doc/searchInputMutations.ts` applies when a person removes an input; a test holds the step's output equal to the reducer's on the same fixture. Notice reason `search-input-removed`, naming the input and each expression that changed. HQ never searched it as the property it names, so no search result changes.
2. Each remaining input named `_xpath_query`, which is one that does not reach HQ as its own key, so its name is only a handle, is renamed with the lowest free numeric suffix (`_xpath_query_2`). References are by uuid, so nothing else is rewritten. Notice reason `search-input-renamed`, with `from` and `to`.

**Register.** 7 entries move to the fixed register: `d14-search-settings-suite-csql-key-include-closed`, `-suite-promptkey-reserved-request-key`, `-app-csql-key-include-closed`, `-app-reserved-request-key` (manifest, control `targeted-search-hq-compile`); `d14-default-filter-name-app-search-property`, `-app-default-property` (manifest) and `-editor-unsent` (proof4), control `targeted-search-default-filter-name`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-search-hq-compile` and `targeted-search-default-filter-name` keep showing the seven.

**Nova tests.**
- Pure: each code beside an accepted neighbour (the same reserved name on an input sent with `exclude` is accepted; `owner_id` and `case_id` are accepted; `_xpath_query` is refused on every route).
- Pure: `isReservedSearchInputName('indices.parent')` is true and `isReservedSearchInputName('indices')` is false.
- Pure: the surface test above.
- Pure: the cutover step over a frozen fixture with one input of each kind (an own-key reserved input, an own-key `_xpath_query`, an advanced `_xpath_query`, an own-key `owner_id`), its equality with the reducer for the removals, and that a second application changes nothing.

**Lane.** `targeted-search-default-filter-name` is rewritten with the suffixed name and becomes the witness that the Case List save goes through. `targeted-search-hq-compile` loses its reserved inputs and stays, for defects 6 and 48. Locally: both. CI's full lane must show no reserved key in any built suite or stored app and the Case List save accepted on both.

## 7. Survey menus keep their case type

**Today.** `lib/commcare/expander.ts::expandDoc` passes `lib/commcare/formLinkProjection.ts::moduleCaseTypeForActions` to `lib/commcare/hqShells.ts::moduleShell`, so a menu that holds a case type, has only survey forms and is not `caseListOnly` uploads `case_type: ""`.

**Fix.** `expandDoc` passes the menu's own `caseType ?? ""` to `moduleShell`. The hidden menu of a no-matches form keeps its host's type. `moduleCaseTypeForActions` stays the gate for form actions, datums, details and the search config, so nothing else is built from the type.

- Reason: the case type is authored content, and HQ's readers of a survey menu's type are only its lists of the app's case types (`models/modules.py::ModuleBase.get_case_types`, so the app summary and the data dictionary), `root_requires_same_case`, which is false for a menu whose forms do not all require a case, and the parent-select offer in `views/modules.py`. HQ builds no detail datum from it.
- A menu that selects its parent record from such a menu is already refused: `lib/domain/caseParentSelection.ts::caseParentSelectionVerdict` requires the source to have a case form or be a case list. No refusal is added.

**Files.**
- Emitters: `lib/commcare/expander.ts`.
- Docs: none (no surface describes the dropped type).
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the sentence on `moduleCaseTypeForActions`).
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools: none.

**Stored shape and migration.** No schema change and no document change. No step: `behavior.ts` returns one record per such menu. Notice reason `survey-menu-takes-case-type`, naming the menu and its case type: HQ shows that type for the menu from the next publish.

**Register.** 1 entry moves to the fixed register: `d14-survey-menus-app-case-type` (intent), control `targeted-survey-menu`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-survey-menu` keeps showing it.

**Nova tests.** Pure: `expandDoc` for a survey-only menu with a case type writes the type and no form action, datum or search config; beside one with no case type, which writes `""`; and the hidden menu of a no-matches form still writes its host's type. Pure: `behavior.ts` over a frozen pre-step fixture returns exactly one `survey-menu-takes-case-type` record, for the survey-only menu with a case type, and none for a survey-only menu with no case type or a `caseListOnly` menu.

**Lane.** `targeted-survey-menu` stays admitted as the witness. Locally: that document. CI's full lane must show the intent check passing and HQ's build of the menu unchanged apart from the type.

## 8. The data node's name

The data node's `name` becomes the form's name in the app's first language, the value `<h:title>` carries. It lands with finding 46 in pull request 6 (part 05, Finding 46 and defect 14's data node name), because proof 4 reports the title and the name together. The three entries `d14-data-node-name-form-instance-name`, `-source-instance-name` and `-trace-name` (proof4, control `case-operation-query`) move to the fixed register in that pull request. `lib/commcare/xform/dataRootAttributes.ts::xformDataRootRuntimeAttributes` and its callers in `lib/commcare/xform/builder.ts` and `lib/preview/engine/formEngine.ts` are files of that block of part 05.

## 9. Tiles and sort spellings

Tile cell placement, the required `horizontalAlign`, `verticalAlign` and `fontSize`, hidden sort carriers, `CASE_TILE_HIDDEN_CALCULATED_SORT`, finding 42, sort type `plain`, explicit sort blanks, `sort_calculation` pairs and date patterns are decided in part 07 (part 07, Tile cells and finding 42; The corrected tile clause; Finding 57: the `case_id` column and attribute-backed hidden carriers; The sort spellings and the four rules they retire; Date patterns narrowed to HQ's five), which owns `lib/commcare/hqJson/caseList.ts::projectSortElements`, `projectColumnForShortDetail`, `hqShortSourceColumns` and `lib/commcare/suite/case-list/sortKeys.ts`. This part edits `caseList.ts` only in `buildSearchConfigDocument`, `projectSearchInput`, `projectColumnToDetail` (the `calculate` format, below) and `projectCaseListForHq` (the empty list and `no_items_text`, below), and its pull request 12 edits land after part 07's pull request 11.

## 10. The equivalent spellings

Spellings no HQ editor produces, which a save keeps or rewrites to an equivalent. No register entry belongs to any of them.

| Item | Nova writes today | HQ's editors write | From step 2 | Rule retired |
|---|---|---|---|---|
| Registration `update never` | `never` when a registration writes only its name and `external_id` | `always` | Block 1 | `update_never_beside_actions` |
| `open_case.external_id` | the question path (`formActions.ts::buildFormActions`) | Nothing sets it. The Case Management tab writes an external id as an ordinary `update_case.update` row | Below | none |
| `no_vellum` | `false` (`hqShells.ts::formShell`) | no such key | Omitted | none |
| `custom_variables` | `null` (`hqShells.ts::detailBase`) | no such key; `models/case_list.py::Detail` holds `custom_variables_dict` | Omitted | none |
| `calculate` column format | `format: "calculate"` (`hqJson/caseList.ts::projectColumnToDetail`) | `plain` with `useXpathExpression` | `plain` | none |
| Empty short case list | `columns: []` when the projected short `columns` array is empty (today: `caseListConfig` absent, or no column shown in the list or carrying an order rule) | at least one column: `models/modules.py::Module.new_module` writes `{ format: "plain", field: "name", model: "case", hasAutocomplete: true, header: { <lang>: "Name" } }` | That one column | none |
| Sort type, sort blanks, `sort_calculation` pairs | see block 9 | see block 9 | Part 07, The sort spellings and the four rules they retire | `sort_type_plain`, `sort_blanks_default`, `sort_calculation_pair` |
| `date_format` outside HQ's five | see block 9 | see block 9 | Part 07, Date patterns narrowed to HQ's five | none |
| `case_preload` | a basic preload action | no basic editor writes one | **Stays until step 5** | none now |

`case_preload` is a departure from the research, which lists it among step 2's equivalent spellings: its editable spelling is a default value that reads the case, which is defect 28's fix and depends on step 5's load-time value rules. Step 2 does not touch it, and `proof/rules/preload_condition.py` stays.

### `external_id` as an ordinary update row

**Today.** `buildFormActions` writes a registration's external id question path on `open_case.external_id`, and `lib/commcare/xform/caseBlocks.ts::buildCaseBlocks` has an `openExternalId` branch for it.

**Fix.** From step 2 `open_case.external_id` is `null` and the write is `update_case.update.external_id`, whose `question_path` reads `nova_trimmed_<question>`, the trimmed hidden value finding 33 introduces (part 05, Finding 33: `nova_trimmed` and the source-question guard). Reason: no editor sets `open_case.external_id`; HQ's build turns it into the same `<update><external_id>` an update row makes (`xform.py::XForm._create_casexml`), and `external_id` is not a reserved word (`static/app_manager/json/case-reserved-words.json`), so the tab shows and keeps the row. `buildCaseBlocks` drops the `openExternalId` branch and writes the row through the update map, so block 1's `<update>` rule covers it. The scalar guard in `buildCaseBlocks` that keys on the property name `external_id` stays and now covers the update row.

**Files.** Emitters: `lib/commcare/formActions.ts`, `lib/commcare/xform/caseBlocks.ts`, `lib/commcare/validator/hqJsonOracle.ts` (refuses a non-null `open_case.external_id`). CLAUDE.md: `lib/commcare/CLAUDE.md`. All other groups: none.

**Stored shape and migration.** None. No notice: no worker or author sees a change.

**Register.** None of its own. Finding 33's entries for trimmed external ids move with finding 33's block in part 05.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None: no entry holds this spelling.

**Nova tests.** Pure, emission: a registration with an external id writes `open_case.external_id: null`, the update row reading `nova_trimmed_<question>`, and one `<update><external_id/>` on the local path; the oracle refuses the old spelling.

**Lane.** Locally: `case-extension-registration`. CI's full lane must show the Case Management save keeping the row and proof 3 agreeing on the stored external id across the two paths.

### `no_vellum`, `custom_variables`, the `calculate` format and the empty short list

**Today.** As the table gives, in `lib/commcare/hqShells.ts::formShell`, `detailBase` and `lib/commcare/hqJson/caseList.ts::projectColumnToDetail`.

**Fix.** The two keys are omitted and leave `lib/commcare/types.ts`. A calculated column writes `format: "plain"`; an unregistered format falls back to the base column class (`detail_screen.py::get_class_for_format`), so HQ builds the same field (read at source; proof 2 is the confirmation). When the projected short `columns` array is empty (`lib/commcare/hqJson/caseList.ts::projectCaseListForHq`: `caseListConfig` is absent, or `hqShortSourceColumns` keeps no column), the menu writes the one `name` column on its short detail, with the header "Name" for every app language so a later save changes nothing. HQ then builds an unreferenced `<detail>` for that menu (`suite_xml/sections/details.py::DetailContributor.get_section_elements` builds one whenever the detail has columns), as it does for every menu its own editor makes. The local suite is unchanged, since no entry reads the detail. If proof 3 or an intent check reports that unreferenced detail as a difference between the two paths, the local suite writes the same detail; that is the decided fallback.

**Files.** Emitters: `lib/commcare/hqShells.ts`, `lib/commcare/hqJson/caseList.ts`, `lib/commcare/types.ts`, `lib/commcare/validator/hqJsonOracle.ts` (refuses `no_vellum`, `custom_variables`, `format: "calculate"` and an empty short `columns`, so the old spellings cannot return). CLAUDE.md: `lib/commcare/CLAUDE.md`. All other groups: none.

**Stored shape and migration.** None. No notice.

**Register.** None.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None.

**Nova tests.** Pure, emission through the oracle: each of the four spellings, and the `name` column's header in every language of a two-language app.

**Lane.** Locally: `targeted-survey-menu`, `arithmetic`, and `case-list-inline` for the `calculate` format (its export holds three such columns; `search-multiple` holds two more). CI's full lane must show the form settings save, the Case List save and the module settings save changing none of the four on any document, and proof 2 unchanged for calculated columns.

## 11. `hiddenFromMenu`: a menu or form that is not on the menu

**Today.** `lib/commcare/validator/rules/displayConditions.ts::validateCarrier` raises `DISPLAY_CONDITION_ALWAYS_FALSE` for a display condition that simplifies to `match-none`, so no Nova app can hold a menu or form that is reached only by a link or an entry point. `lib/commcare/suite/displayConditions.ts` emits through `lib/domain/predicate/simplify.ts::effectiveDisplayConditionForEmission`, where one `match-none` clause absorbs a whole conjunction.

**Fix.**

*The model.* A sibling flag on both carriers: `Module.hiddenFromMenu: z.literal(true).optional()` and `Form.hiddenFromMenu: z.literal(true).optional()`. Absent means on the menu. `displayCondition` is unchanged and holds the rest: the condition that applies once the item is back on the menu.

- Reason for a flag over an arm of the condition: `displayCondition` stays a plain `Predicate` for every walker (`lib/domain/referenceSlots.ts`, `predicate/walk.ts`, `predicate/rewrite.ts`, the reference index, renames, lookup extraction), and "off the menu" and "the condition for when it returns" are two facts.
- What the wire accepts: HQ stores `module_filter` and `form_filter` from free text (`views/modules.py::edit_module_attr`, `views/forms.py::edit_form_attr`), validates the whole expression (`helpers/validators.py::ModuleBaseValidator.validate_with_raise`, `FormBaseValidator`), and writes it as the menu's or command's `relevant` (`suite_xml/sections/menus.py`). So `false()` and `false() and (<rest>)` are both produced and kept by HQ's pages.

*Emission.* `emitModuleDisplayCondition`, `emitFormDisplayConditionForSuite` and `emitFormDisplayConditionForHq` take the flag. When it is set they return `false()` with no rest and `false() and (<rest>)` otherwise, the parentheses always written. Instance declarations still come from the rest.

*Conditions are held as written.* `lib/domain/predicate/simplify.ts::effectiveDisplayConditionForEmission` is deleted and `displayConditionForEmission` takes its place: absent for an absent condition or one whose root node is `match-all`, and otherwise the condition exactly as stored. Nothing inside it is rewritten: `x and always` prints `x and true()`, `x or always` prints `x or true()`, and an authored `x and never` prints `x and false()` and is an ordinary condition. Every reader moves to the new function:

- the three emitters in `lib/commcare/suite/displayConditions.ts`;
- the instance collection for a form's entry in `lib/commcare/session.ts`, and the module's condition in `lib/commcare/compiler.ts`. Both must read what the emitter prints: under the old function an authored `x and never` collapsed to `match-none` there, and the instances `x` reads would go undeclared while the emitter printed them. For a hidden item both collect instances from the rest;
- `lib/preview/engine/displayConditionEvaluation.ts`, which evaluates the stored condition and no longer short-circuits on an absorbed one.

*One meaning, one spelling.* A `displayCondition` that is `match-none`, or an `and` whose first clause is `match-none`, would print exactly the hidden spelling, so it is refused by a shape rule: `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU`, message `"<name>" has a display condition that starts with "never". To keep it off the menu, turn off "Show on the menu" and keep the rest of the condition.` Every other condition that happens to be false is ordinary.

*`DISPLAY_CONDITION_ALWAYS_FALSE` retires.* It is removed from `validator/rules/displayConditions.ts`, `validator/errors.ts`, `validator/gate.ts`, `lib/doc/userFacingErrors.ts`, `components/builder/shared/editorSchemas.ts` and `docs/architecture/complex-apps.md`, and the manifest entries for `module_filter` and `form_filter` equal to `false()` or `false() and <rest>` move from refused to held, their wording changed from "always-false arm" to "`hiddenFromMenu`, with `displayCondition` holding the rest".

*Other rules.* The context rules for a module's and a form's display condition keep running on the rest while the item is hidden, as HQ's do. There is no reachability rule: a hidden item nothing reaches is legal in HQ. A no-matches form refuses `hiddenFromMenu` as it refuses a display condition (`rules/case-search/searchNoMatches.ts`), since it is already on no menu.

*What reaches a hidden item* (read at source, not executed; the lane runs Core's runner and neither Android nor Web Apps' server):

| Route | Android | Web Apps |
|---|---|---|
| An after-submit link | Opens it: Core takes the frame's commands as given | Does not open it. After a submit the session is rebuilt by walking the frame through each menu's relevant choices (formplayer `services/MenuSessionFactory.java::rebuildSessionFromFrame`, called with relevancy respected from `MenuSessionRunnerService.java::executeAndRebuildSession`), so the walk stops at the menu that holds the hidden item |
| A form's entry point with `ignoreDisplayConditions` | Opens it | Opens it (`respect-relevancy="false"`) |
| Any other entry point | Opens it: Android does not read `respect-relevancy` | Does not open it |

This is true today of any link target whose display condition is false when the link fires; `hiddenFromMenu` makes it the constant case. So the builder copy, the SA and MCP descriptions and the docs state the table, and never say a hidden item is reached "by links" without the platform. Step 4 makes Preview play each platform. The Web Apps column is stated as read: the lane does not run Formplayer, so no check of this step holds it, and the main plan lists it among what this step could not settle from the lane.

*Preview.* `lib/preview/menuProjection.ts::previewModuleVisibility` and the form list in `lib/preview/screenProjection.ts` leave a hidden menu or form off the list without evaluating the rest, and a hidden parent hides its child menus as a false condition does. `lib/preview/entryPointLaunch.ts` treats `hiddenFromMenu` as not shown, so an entry point opens the item only with `ignoreDisplayConditions`, the Web Apps behavior it already models. After-submit routing is unchanged and opens a link's target whatever its visibility, the Android behavior it already models. `lib/preview/app-tests/navigation.ts` refuses to open a hidden item from a menu.

*Builder.* A "Show on the menu" switch on the menu's and the form's settings, beside the display condition, on by default. When off: "Off the menu. This opens from an entry point that ignores display conditions, and on Android from an after-submit link." The condition editor stays and is labelled "When shown on the menu".

*SA and MCP.* `hiddenFromMenu` on `update_module` and `update_form`, beside `displayCondition`, which those two tools already carry in that spelling (`true` hides, `null` shows, omission keeps). `create_module` and `create_form` take no display condition today and do not take the flag; a following update sets it. `get_module`, `get_form` and `lib/agent/summarizeBlueprint.ts` show it. No prompt or tool description says a condition may not be always false today (the sentence lives only in the validator rule and `lib/doc/userFacingErrors.ts`, which the retirement above removes), so nothing model-facing is deleted; the two `displayCondition` descriptions gain the pointer to the flag.

**Files.**
- Domain: `lib/domain/modules.ts`, `lib/domain/forms.ts`, `lib/domain/predicate/simplify.ts`, `lib/domain/referenceSlots.ts`.
- Doc and mutations: `lib/doc/displayConditionMutations.ts` (the flag rides the ordinary module and form patch), `lib/doc/diffDocsToMutations.ts`, `lib/doc/userFacingErrors.ts`.
- Validator: `lib/commcare/validator/rules/displayConditions.ts`, `rules/case-search/searchNoMatches.ts`, `validator/errors.ts`, `validator/gate.ts`.
- Emitters: `lib/commcare/suite/displayConditions.ts`, `lib/commcare/session.ts`, `lib/commcare/expander.ts`, `lib/commcare/compiler.ts`, `lib/commcare/surface/entries/menus-and-case-lists.json`.
- Preview: `lib/preview/engine/displayConditionEvaluation.ts`, `lib/preview/menuProjection.ts`, `lib/preview/screenProjection.ts`, `lib/preview/entryPointLaunch.ts`, `lib/preview/app-tests/navigation.ts`, `components/preview/screens/HomeScreen.tsx`, `components/preview/screens/ModuleScreen.tsx`.
- Builder: `components/builder/conditions/DisplayConditionSection.tsx`, `conditions/displayConditionCopy.ts`, `conditions/useDisplayConditionCarrier.ts`, `detail/formSettings/FormSettingsPanel.tsx`, `detail/moduleSettings/ModuleSettingsPanel.tsx`, `components/builder/shared/editorSchemas.ts`.
- SA and MCP tools: `lib/agent/tools/updateModule.ts`, `updateForm.ts`, `getModule.ts`, `getForm.ts`, `lib/agent/summarizeBlueprint.ts`, `lib/agent/authoring/output.ts` (the `getModule` and `getForm` projections carry the flag beside `display_condition`), `lib/agent/tools/entry-points.ts` (the two `ignoreDisplayConditions` descriptions say that it is also what opens an item that is off the menu). The model-facing text that describes a display condition on a menu or a form is the `displayCondition` description in `updateModule.ts` and in `updateForm.ts`, those two entry-point descriptions, and the `search-no-matches` entry description in `lib/agent/tools/shared/formEntry.ts` ("No other destination, links, or display condition", which gains the flag). The set is defined by a search of `lib/agent` outside `__tests__` for `displayCondition`, `display_condition` and `display condition`, re-run in the pull request; its other matches are the search button's condition in `lib/agent/tools/case-search-config/`, which this block does not change, and `lib/agent/prompts.ts`, `lib/agent/promptSegments.ts` and `lib/agent/planning/` hold no sentence on display conditions. The pull request reads the changed descriptions on the `/agents` pages.
- Proof: `proof/targeted/documents/hiddenFromMenu.ts` (new, the document below), `proof/targeted/index.ts`, `proof/timings.json`, `proof/README.md` (its row).
- Docs: `content/docs/display-conditions.mdx`, `content/docs/form-links.mdx`, `content/docs/deep-links.mdx`, `content/docs/mcp/tools.mdx`, `docs/architecture/complex-apps.md`.
- CLAUDE.md: `lib/domain/CLAUDE.md`, `lib/domain/predicate/CLAUDE.md`, `lib/doc/CLAUDE.md` (both name the deleted function), `lib/commcare/CLAUDE.md` (replacing "a deeply always-false condition is a soundness finding"), `lib/preview/CLAUDE.md`, `components/builder/CLAUDE.md`.

**Stored shape and migration.** Two new optional slots. Cutover step `hidden-from-menu` is the only step that sets the flag. Defect 6's step, `time-ordering` (pull request 14; part 08, Defect 6: ordering a time, and the three system dates in CSQL), only replaces comparisons; that pull request inserts it at its row of part 10's registry, before this one in `transform.ts`, so this step's one pass sees every `match-none` it writes, and it sets nothing on a menu or form itself. For each menu and form whose `displayCondition` is `match-none`, or an `and` whose first clause is `match-none`, set `hiddenFromMenu` and keep the remaining clauses as the condition (none, one, or an `and` of the rest). A `match-none` in any other position is left as written. The gate has refused the shape, so apart from defect 6's rewrites none is expected. Notice reason `hidden-from-menu-set`, naming the menu or form. A menu or form hidden because of defect 6's rewrite gets both records: `time-comparison-never-true` from that step, naming the comparison, and `hidden-from-menu-set` from this one.

**Register.** None. Nova cannot emit the shape today.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None: there is no pre-fix symptom to keep showing.

**Nova tests.**
- Pure: the three emitters' bytes for the flag alone, the flag with a rest, `x and never` with no flag, and `x and always` with no flag.
- Pure, emission: a form whose condition is `x and never`, and a hidden form whose rest reads a lookup table, each declare on their entry every instance the printed `relevant` reads; the same for a module's condition.
- Pure: `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU` for `never` and for `never and x`, beside the accepted `x and never`; the no-matches refusal beside an ordinary form.
- Pure, state model: Preview's menu projection hides the item and its child menus without evaluating the rest; an entry point opens a hidden form only with `ignoreDisplayConditions`; an after-submit link opens it; an App Test cannot open it from a menu.
- Pure: the cutover step over a frozen fixture with each of the three shapes (`never`, `never and x`, `never and x and y`) beside `x and never`, which it leaves alone; and, from pull request 14, over a fixture whose display condition is a time comparison, which ends hidden with both records.
- Playwright: the switch hides a form from Preview's menu and the condition editor stays editable.

**Lane.** A new targeted document, `targeted-hidden-from-menu`: a hidden menu holding one form, a hidden form with a rest condition, an after-submit link to each, and a form entry point with `ignoreDisplayConditions`. Locally: that document. CI's full lane must show the bar admitting HQ's build, proof 2 passing, proof 3 agreeing across the two paths on the menu lists and on the session after the link (Core opens the target), and proof 4's module settings save and form settings save keeping `false()` and `false() and (<rest>)` unchanged. If a save rewrites the parenthesised spelling, the emitter writes what the save writes and the pull request says so.

## 12. Finding 41: the empty-list text without English

**Today.** Nova writes no `no_items_text` on a short detail (`lib/commcare/hqShells.ts::detailBase`), so HQ's model default holds `en` alone, and under `USH_EMPTY_CASE_LIST_TEXT` the module settings save writes an empty text for the page's language. In an app with no English the default app strings then read blank.

**Fix.** A derived default, not a model addition: `lib/commcare/hqJson/caseList.ts::projectCaseListForHq` writes `no_items_text` on the short detail as "List is empty." for every app language, keyed by wire code. The text is the constant `lib/commcare/hqShells.ts::EMPTY_CASE_LIST_TEXT`.

- Reason: every language already reads that sentence today, through the fallback in `templatetags/xforms_extras.py::_trans` and `app_strings.py::_create_module_details_app_strings`, so no worker sees a change, and the module settings page then shows and posts the text it was given (`views/modules.py::edit_module_attr`).
- The local `.ccz` is unchanged: HQ writes the element and its locale only under the target's flag (`feature_support.py::supports_empty_case_list_text`).
- An authored empty-list text is a later step's model addition; when it lands it replaces the constant.

**Files.** Emitters: `lib/commcare/hqJson/caseList.ts`, `lib/commcare/hqShells.ts`, `lib/commcare/types.ts`. CLAUDE.md: `lib/commcare/CLAUDE.md`. All other groups: none.

**Stored shape and migration.** None. No notice.

**Register.** 2 entries move to the fixed register: `d41-empty-list-text-app-no-items-text` (proof4, control `case-list-inline`), `d41-empty-list-text-strings-m-no-items-text` (proof4, control `search-browse`).

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `case-list-inline` and `search-browse` keep showing them.

**Nova tests.** Pure, emission: `no_items_text` holds the constant under each wire code of a two-language app with no English, on the short detail only.

**Lane.** Locally: `localization-optional`, `endpoint-case-list`. CI's full lane must show the module settings save changing no `no_items_text` and no `m<i>_no_items_text` reading blank. The first entry's document, `localization-optional`, changes bytes under the blank-translation fill in pull request 6 (part 05, Blank translations (defect 13)) with no source edit; that pull request's lane run must still show the entry on it, and if it does not, the entry's `document` becomes `endpoint-case-list` there.

## 13. Finding 54: the empty search description

**Today.** `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument` writes `description` only where a subtitle is authored and leaves `title_label` as `{}` (`hqShells.ts::caseSearchConfigShell`). HQ's Case List save writes both for the page's language as the text it holds, empty for none, and HQ's build of the saved app then writes a `<description>` on the search.

**Fix.** Nova writes what the save writes, on both paths.

- HQ JSON: on every menu, `search_config.description` is the authored subtitle's text map, and otherwise `""` for every app language; `search_config.title_label` is the authored title's map, and otherwise `""` for every app language. Reason: `views/modules.py::_gather_and_update_search_properties` writes the two in adjacent statements whether or not the menu offers search, so writing one and leaving the other under a rule would be the inconsistent state.
- Local suite: every search writes `<description>` with its locale, on the remote request (`lib/commcare/suite/case-search/remoteRequest.ts`) and on the inline query (`suite/case-search/inlineSearch.ts`), with a blank value where no subtitle is authored. The blank row has no translation unit to come from, so it is a literal: `lib/commcare/suite/case-search/inlineSearch.ts::searchScreenTranslationUnits` keeps mapping `case_search.m<N>.description` to the `search-subtitle` unit only where a subtitle is authored, and otherwise the two search emissions return that locale id in their `strings` with the value `""`, which `lib/commcare/compiler.ts` writes into every language's table as it writes any string with no unit. `compiler.ts` is not edited. `lib/commcare/localeFile.ts::serializeLocaleFileValue` already writes a blank value as a non-breaking space, as HQ's locale writer does, so Core reads the same text on both paths (commcare-core `util/screen/QueryScreen.java::getDescriptionLocaleString`).
- No worker sees a change: Web Apps trims the text to nothing and Android does not read it.
- Reason for writing it at all: the difference's reader is a runtime the lane does not run, so no spelling rule can prove it alike, and an entry leaves only when the difference does.

**Files.** Emitters: `lib/commcare/hqJson/caseList.ts`, `lib/commcare/hqShells.ts`, `lib/commcare/suite/case-search/remoteRequest.ts`, `suite/case-search/inlineSearch.ts`, `lib/commcare/validator/hqJsonOracle.ts` (a `description` or `title_label` missing an app language is refused). Preview: none; it shows no subtitle where none is authored. Proof: `proof/native/test_search_emission.py`; `proof/rules/search_title_empty.py` and `proof/rules/test_search_title_empty.py` (deleted), `proof/rules/__init__.py` (its import and `RULES` line), `proof/rules/conftest.py`. CLAUDE.md: `lib/commcare/CLAUDE.md`. Domain, doc and mutations, validator, builder, SA and MCP tools, docs: none.

**Stored shape and migration.** None. No notice.

**Register.** 3 entries move to the fixed register, each keeping its `equivalence` mark: `d54-search-description-app-description` and `-suite-remote-request` (proof4, control `case-operation-query`), `-suite-entry` (proof4, control `case-list-inline`).

**Spelling rule.** `proof/rules/search_title_empty.py` retires with its test and its `RULES` line. `proof/rules/conftest.py::DOCUMENTS` loses `search-browse`, which only that test reads.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` and `case-list-inline` keep showing the three.

**Nova tests.** Pure, emission: both maps hold every wire code of a two-language app, blank where nothing is authored and the authored text otherwise; the local suite writes `<description>` and a non-breaking-space locale value on a remote request and on an inline query. Native proof: `proof/native/test_search_emission.py` reads the description Core presents for a search with and without a subtitle.

**Lane.** Locally: `case-list-browse`, `case-list-inline`, `search-browse`. CI's full lane must show the Case List save changing neither map, proof 3 agreeing on the description across the two paths, and the lane passing with the rule gone.

## 14. Finding 50: reclassified as what HQ does itself

**Today.** A follow-up form that opens one child case outside a repeat draws Vellum's "This registration form is missing a case name." alert on every save, on `nested-menu-previous`, and the register holds it as two proof 4 entries.

**Fix.** No emission changes. The alert is what HQ does to a form its own editors make, so the lane stops calling it a difference, by one closed and proven allowance that part 09, Finding 50: the registration alert on a follow-up form, specifies. The allowance and the removal of the two entries land in pull request 1.

*Why it is HQ's own.* HQ counts a form with exactly one registration action a registration form, and counts a child case outside a repeat as one (`models/forms.py::Form.get_registration_actions`, `Form.is_registration_form`). It maps a case name only from the form's own `open_case` (`form_action_diff.py::get_case_mappings`). The two disagree for exactly this shape, the form builder is told the form is a registration form (`views/formdesigner.py::_get_vellum_core_context`), and Vellum alerts when a registration form has no name mapping (Vellum `src/caseManagement.js`, its pre-save validation). A blank follow-up form given one child case by HQ's own Case Management page draws the same alert. The save goes through and nothing HQ stores changes.

*Why no emission fix.* The only spellings that silence it are to move the child's create to a Save to Case block, which needs `save_to_case`, moves its submissions and is step 5's placement question, or to write a name mapping on the inactive `open_case`, which would make the form builder show a question as saving the form's own case name, which is false.

*The allowance, its proof and its record.* Part 09, Finding 50: the registration alert on a follow-up form, owns all of it: the one allowance module and its closed list, its test, the condition under which it applies, the `proof/README.md` and `proof/CLAUDE.md` text, the `harness-findings.md` move, the removal of the two entries and the lane run. This part defines none of them, so there is one module path, one test path and one condition, and they are that block's. What this part contributes is the reason above and one fact that block's condition must be no wider than: HQ's two functions disagree exactly when the stored form's `open_case` is not active and exactly one of its subcases has no `repeat_context`.

**Files.** None in this part: no domain, doc and mutations, validator, emitter, Preview, builder, SA and MCP tool, docs or CLAUDE.md file changes for finding 50 outside that block of part 09.

**Stored shape and migration.** None. No notice.

**Register.** Pull request 1 removes the two entries (part 09, the same block), which are **removed, not moved**: `d50-registration-alert-vellum-pre-save-alerts-registration-form-missing` (`editor:vellum@*`) and `d50-registration-alert-vellum-again-pre-save-alerts-registration-form-missing` (`editor:vellum again@*`), both proof4. They cannot be fixed entries: once the judge stops reporting the class, their control stops showing it.

**Spelling rule.** None retires.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `proof/controls/nested-menu-previous` is named by these two entries alone, so pull request 1 deletes it with them. The corpus document `nested-menu-previous` stays and passes proof 4 with no entry.

**Nova tests.** None in this part: the allowance's tests are part 09's.

**Lane.** Pull request 1, with no emitter change; part 09, in the same block, gives its local run and what CI must show.

## Order and shared files

- Blocks 1, 2 and the `external_id` row share `lib/commcare/xform/caseBlocks.ts` and `lib/commcare/formActions.ts` with findings 33 and 37, and block 2 needs `nova_operations`, the `nova_condition_` groups and `planGeneratedNodes` from part 05 (part 05, Reserved names and wrapper containers (defect 13); Wrapper conditions (defect 13); The one allocator), which pull request 7 lands. They land together in pull request 9, after it.
- Findings 41 and 54 edit `lib/commcare/hqJson/caseList.ts` beside part 07 and land with it in pull request 11.
- Blocks 3 to 7, the rest of block 10 and block 11 land in pull request 12. These blocks change tool schemas (3, 4, 5 and 11) and descriptions inside them (6; block 2's is in pull request 9). The one billed check for the stack is asked for at the head of pull request 14 (part 11, The stack, in its list of what every pull request of the stack does), which names each of them, and nothing is run in pull request 9 or pull request 12.
- Block 6 is the second of three edits to `targeted-search-hq-compile`; it keeps the document and its follow-up form, which defects 6 and 48 still need.
- Cutover steps from this part, as part 10, The transform steps, in order, registers them: `search-button-label`, `reserved-search-inputs`, `hidden-from-menu`, `post-submit`, in that relative order, with `time-ordering` (pull request 14) placed before `hidden-from-menu`. Reasons their steps return: `search-button-text-changed`, `search-input-removed`, `search-input-renamed`, `hidden-from-menu-set`, `after-submit-destination-moved`.
- Changes that write nothing, as `behavior.ts` selection rules with no step (part 10, Changes that write nothing and still get a line): `follow-up-now-touches-case` and `close-moves-to-save-to-case` (pull request 9), `lookup-choices-order-changes` and `survey-menu-takes-case-type` (pull request 12).
