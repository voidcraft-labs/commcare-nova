# Step 2, part 06: Work item D, part 3: menus, forms, navigation and search settings (defect 14; findings 41, 50, 54, 58)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part fixes every bullet of defect 14 that is not a logo, the location fixture, a tile, a sort spelling, a date pattern or the data node's name, adds the three model additions those fixes need (`postSubmit: firstMenu` and `parentMenu`, a sort column on a lookup-backed search input, `hiddenFromMenu`), settles findings 41, 54 and 58, and states why finding 50 gets no emission fix (its allowance is specified in part 09, Finding 50: the registration alert on a follow-up form). HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

**How every fact below was settled.** Each claim about what HQ's build, an HQ page, Vellum, Core, Formplayer, the Web Apps client or Android does with a spelling was run during planning at the pins of `proof/pins.json`, on that reader's own code: the planned spelling was written by hand into a fork of a real document's published app, or into its local archive, and the reader ran over it. Each block says what was run and on which document. Each harm is held from its fix's pull request on by a lane check or a reader package test, named in the block's **Lane**. A **Nova tests** block lists tests of Nova's own code: they prove what Nova does, and nothing about a reader. The readers are the lane's HQ, its editor pages, Vellum and Core (`proof/hq`, `proof/editors`, `proof/core`), Formplayer (`proof/formplayer`), the Web Apps client (`proof/webapps`) and Android (`proof/android`).

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

Pull requests of the stack that carry this part: 1 (finding 50, whose allowance and entry removal are specified in part 09, Finding 50: the registration alert on a follow-up form), 9 (blocks 1, 2 and the `external_id` row of block 10), 11 (findings 41 and 54), 12 (blocks 3 to 7, the rest of block 10, block 11, block 15).

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

- Reason: HQ's Case Management save writes `always` on every form that opens or requires a case (`static/app_manager/js/forms/case_config_ui.js::HQFormActions.from_case_transaction`). The lane observes that rewrite today: it is this block's proof 4 entries. Executed during planning, on `case-operation-query` with `always` written by hand: the Case Management save then changes nothing of `update_case`.
- The survey early return in `buildFormActions` stays first. Executed during planning, on `targeted-survey-menu` with `always` written by hand: HQ's build raises (`XFormException`, "To update a case you must either open a case or require a case to begin with").
- What HQ builds from it (executed during planning, on `case-operation-query`): for a form that requires a case in a single-select menu, a primary block `/data/case` with its `@case_id` (the session's case id), `@date_modified` and `@user_id` binds, and no `<update>` child. HQ writes the `<update>` child only where there is a write (`navigation-base`, whose registration form writes one). In a multi-select menu (`case-capture-multiple`) HQ builds the same files under `never` and under `always`: no primary block.
- **The local `<update>` rule.** `lib/commcare/xform/caseBlocks.ts::buildCaseBlocks` writes `<update>` exactly when the update map holds at least one entry. Today it writes an empty `<update/>` for every update form. Without this change the fix trades the proof 4 entries for a proof 3 difference between the two paths at `/data/case/update`.
- `lib/commcare/xform/caseBlocks.ts::addCaseBlocks` keeps passing `defaultCaseManagement = false` for a multi-select form, so the local path stays without a primary block there.
- **Preview and the case store.** `lib/case-store/postgres/submissionEnvelope.ts::applyOrdinaryAction` writes nothing for a `followup` or `close` submission whose admitted patch is empty, so the case's `modified_on` does not move. From step 2 that arm calls `stampModified` for a single-selection submission with no property, name or external id write. Executed during planning, on HQ's build of `case-operation-query` with `always`: Core submitted the form, and HQ's case processing of that submission moved the selected case's `modified_on` to the submission's `date_modified`; under `never` the same submission did not touch the case. A several-case submission is not stamped: HQ builds no primary block there.
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

**Nova tests.** These prove Nova's own code; what HQ and Core do with the block is the Lane's.
- Pure: `buildFormActions` writes `always` for each of the three case form types with an empty map, and `never` for a survey and for a form of a menu with no case type.
- Pure: the local touch block is `<case>` with its three attribute binds and no `<update>` child, beside a writing follow-up that has one (`lib/commcare/__tests__/caseBlocks.test.ts`). The expected bytes are the block HQ built during planning.
- Real Postgres (`lib/case-store/__tests__/followupTouch.postgres.test.ts`): Nova's case store advances `modified_on` for a write-free single-selection follow-up, and does not for the same form over several selected cases.
- Pure: `behavior.ts` over a frozen pre-step fixture returns exactly one `follow-up-now-touches-case` record, for the write-free follow-up in a single-select menu, and none for its neighbours: a follow-up with one write, and a write-free follow-up in a multi-select menu.

**Lane.** Locally: `case-operation-query`, `case-capture-multiple`, `targeted-search-hq-compile`. Proof 4 on every document holds the save: no `update_case` condition difference after a Case Management save. Proof 3 on `case-operation-query` holds the touch: Core submits the form from HQ's build and from the local archive, HQ processes both submissions, and both name the selected case through the same primary block. The lane passes with the rule gone.

## 2. Close conditions the Case Management tab cannot state

**Today.** `lib/commcare/formActions.ts::buildFormActions` writes `close_case.condition` as `if` for any close form with a field and an answer, with the answer as entered. `lib/domain/forms.ts` holds `closeCondition` as `{ field, answer, operator? }` and `lib/commcare/validator/rules/form.ts::closeConditionValidation` checks only type, completeness and that the field is in the form.

**Fix.** The condition stays authorable on any question. From step 2 a derived placement decides where the close is written.

*The statable rule.* A close condition is statable by HQ's Case Management tab when all five hold. Otherwise its placement is Save to Case. Each clause was executed during planning: the condition was written by hand into the third form of `targeted-close-conditions`, over a question of the kind the row names, and HQ's Case Management page saved the form.

| # | Clause | What the page or the build did |
|---|---|---|
| 1 | The field's kind is `single_select`, `multi_select`, `hidden` or `label` | Over a text question the save emptied the condition's `question`. Over a single-select, a multi-select with `selected`, a Hidden Value and a label it kept the condition (`templates/app_manager/partials/forms/case_config_ko_templates.html`, `case-config:condition`; `static/app_manager/js/case_config_utils.js::getQuestions`) |
| 2 | The field has no `repeat` ancestor | Over a single-select inside a repeat the save emptied the condition's `question` |
| 3 | The answer holds no `'` | The save keeps the answer, and HQ's build writes it between single quotes (`xform.py::XForm.action_relevance`): `it's` built `relevant="/data/outcome = 'it's'"`, which does not parse, and `x' or 'y` built `/data/outcome = 'x' or 'y'`, another condition |
| 4 | The answer neither starts nor ends with `"` | The save stripped it: `"x` and `x"` both came back `x` (`views/forms.py::edit_form_actions`). A `"` inside the answer (`x"y`) was kept |
| 5 | For a select with inline options, the answer is one of its option values | Over a single-select with options `a` and `b` and the answer `c`, the save wrote `a`, the first option. A lookup-backed select has no inline options, takes a text box, and kept an answer that is no row's value |

Clause 5's witness in the corpus is a form this pull request adds to `targeted-close-conditions`: a single-select question with inline options `a` and `b`, and a close answer `c`. Its placement is `save-to-case`.

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

*Executed during planning*, on `targeted-close-conditions`, with this subtree, its body groups and its four binds written by hand into the third form (a text question, so clause 1 fails), `close_case` set to `never`, and one property write added to the form:

- HQ's build accepts the form and appends its own primary block after the source's nodes.
- Where the condition holds, Core's submission carries the close block and then the primary block, and HQ's case processing leaves the case closed with the write. Where it does not hold, the submission carries the primary block alone and the case stays open with the write.
- HQ's Case Management save and form settings save change nothing of `close_case`, `update_case` or the form's source.
- Vellum, in a project space whose plan has Save to Case: it reads `nova_operations` and `nova_condition_close` as groups and `nova_close` as a Save to Case question, reports no error, warning or alert, and saves. Two saves keep the group, its `relevant`, the block and its three attribute binds where they are, and the second changes nothing the first left. HQ's build of the twice-saved form still closes the case.
- Vellum, in a project space without it: it reads the block as plain data, and its save deletes the block's three attribute binds ("Bind Node ... found but has no associated Data node. This bind node will be discarded!"), so the close would then name no case. This is the harm the plan-feature confirmation below prevents.

*A multi-select form.* It already closes through a Save to Case block for every selected case (`caseOps.ts`, the `ordinaryCloseCondition` branch), whatever the condition. That block is unchanged. From step 2 its HQ JSON `close_case.condition` is `never` when the placement is `save-to-case`, so the tab holds no answer it would rewrite. Executed during planning, on `case-capture-multiple`: HQ builds the same files for a multi-select form under `never` and under `if`.

*Consequences, each stated on the surface that shows it.*

- **The app needs `save_to_case`.** Nothing here keys a privilege on the placement. The privilege follows from the emitted block: `lib/commcare/xform/caseOps.ts::formEmitsSaveToCase` (pull request 13; part 03, C2. Plan features: the per-privilege confirmation) is true for any form whose source holds a Save to Case block, and `lib/commcare/planPrivileges.ts::requiredPlanPrivileges` reads it, so from pull request 13 publish asks for that confirmation. The builder says so beside the condition: "CommCare HQ saves this condition as a Save to Case close. Publishing checks that the project space's plan includes Save to Case."
- **The close runs before the form's own update.** HQ's build appends its primary block after the source's, and HQ applied the two blocks in that order (executed, above). The final case state is the same: closed, with the form's writes.
- **HQ shows the form as an update form.** `models/forms.py::Form.get_action_type` answered `update` for the form above. Cosmetic, and true of any Save to Case close.

**Files.**
- Domain: `lib/domain/closeCondition.ts` (new), `lib/domain/index.ts`.
- Validator: none. No refusal is added.
- Emitters: `lib/commcare/formActions.ts`, `lib/commcare/xform/caseOps.ts`, `lib/commcare/xform/generatedNodes.ts`. `lib/commcare/planPrivileges.ts` does not exist until pull request 13 and is not touched here.
- Manifest: the entries in `lib/commcare/surface/entries/forms-and-case-writes.json` whose value classes are `own-case-condition-not-offered-or-quoted` and `answer-with-apostrophe` (Nova no longer emits either).
- Proof: `proof/targeted/documents/closeConditions.ts` (the clause 5 form above).
- Preview: none. `lib/preview/engine/formEngine.ts::computeCloseConditionAnswers` already evaluates the condition on any question.
- Builder: `components/builder/detail/formSettings/CloseConditionSection.tsx`, the close condition editor (the copy above, shown under the condition when the placement is `save-to-case`). It is the only builder file that reads `closeCondition`.
- SA and MCP tools: `lib/agent/planningSchemas.ts::closeConditionInputSchema`, the one close-condition input shape every tool that takes a `close_condition` shares (`lib/agent/tools/updateForm.ts` reads it). Its description gains one sentence, with no change to the shape: a condition on a text, number or date answer, inside a repeat, with a quote mark in its answer, or with an answer that is none of a select's options is saved as a Save to Case close, which needs that plan feature in HQ.
- Docs: `content/docs/case-changes.mdx`, `content/docs/project-space-compatibility.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the placement rule, beside the sentence that authored operations run before the ordinary primary action), `lib/domain/CLAUDE.md`.

**Stored shape and migration.** No schema change, no document change and no step. `behavior.ts` returns one record per close form in a single-select menu whose placement is `save-to-case`. Notice reason `close-moves-to-save-to-case`, naming the form: its close is written another way, HQ's Case Management tab no longer shows it, and its next publish asks about one more plan feature. A multi-select close gets no record: it is already a Save to Case close and its plan feature is already needed.

**Register.** 23 entries move to the fixed register, all `d14-close-conditions-*`: `-admission-unresolved-resource` (bar); `-app-own-case-condition-not-offered-or-quoted-3731`, `-2119`, `-2f42`, `-ba84`, `-bf5c`, `-app-answer-with-apostrophe-ab34`, `-4107` (manifest); `-blocks-case-close-937a`, `-blocks-closed-9db3`, `-trace-case-status-7b66`, `-trace-case-last-modified-b2a8`, `-trace-case-close-7842` (proof3); `-app-condition-answer`, `-app-condition-question`, `-blocks-case-close-3452`, `-blocks-closed-cf78`, `-form-close-relevant`, `-trace-case-status-4d82`, `-trace-case-last-modified-7f74`, `-trace-case-close-f132`, `-trace-validate-app-path-error`, `-validate-path-error` (proof4). Eleven pin `values`, which a fixed entry compares on its control alone.

**Spelling rule.** None.

**Identity.** The close's block moves once in each existing deployment's submissions, from `/data/case/close` to `/data/nova_operations/nova_condition_close/nova_close/case/close`, so HQ form exports show the close under the new path from the next publish. The notice says so. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-close-conditions` and `targeted-close-condition-unparsable` keep their pre-fix bytes and keep showing all 23.

**Nova tests.** These prove Nova's own code; what HQ, Vellum and Core do with the close is the Lane's.
- Pure: `closeConditionPlacement`, each of the five clauses failing beside its nearest passing neighbour (a text question and a select; in a repeat and beside it; `it's` and `its`; `"x` and `x`; an answer that is and is not an option value; a lookup-backed select with any answer).
- Pure, emission: a `save-to-case` close writes `close_case` `never`, the group, the block (the bytes written by hand during planning) and no primary `<close/>`; an answer holding `'` and one holding both quote marks print as valid XPath literals; a statable condition still writes `close_case` `if`.
- Pure, in pull request 13, not here: that pull request's `requiredPlanPrivileges` test includes a form whose close is placed `save-to-case` (yields `save_to_case`) beside one whose close is statable (does not).
- Pure: `behavior.ts` over a frozen pre-step fixture returns exactly one `close-moves-to-save-to-case` record, for the unstatable close in a single-select menu, and none for a statable close or a multi-select close. The same test holds the one-time path change: the fixture records the pre-step close path `/data/case/close`, and the migrated document's form source holds the close at `/data/nova_operations/nova_condition_close/nova_close/case/close` and nowhere else.

**Lane.** Both targeted documents stay admitted and turn from symptom to witness. The lane derives `save_to_case` for both documents from the Save to Case block HQ receives (`proof/checks/configurations.py::PRIVILEGE_RULES`, `_needs_save_to_case`); no configuration file is edited. Locally: both documents and `case-capture-multiple`. The bar admits HQ's build of both. Proof 3 holds the close and the case's final state across the two paths: Core submits each form from HQ's build and from the local archive, and HQ processes both submissions. Proof 4 holds the editors: the block, the group and its `relevant` through the Case Management save and two Vellum saves, under the configuration the lane derives, which grants Save to Case. The lane checks no target without the plan feature (step 1's decision 19); publish's confirmation is what keeps an app out of one (part 03, C2. Plan features: the per-privilege confirmation).

## 3. After-submit destinations: `firstMenu`, `parentMenu` and `POST_SUBMIT_NOT_OFFERED`

**Today.** `lib/domain/forms.ts::POST_SUBMIT_DESTINATIONS` is `app_home`, `module`, `previous`, and `defaultPostSubmit` gives a case-loading form `previous`, or `module` in a menu that opens on Search. Nothing reads the selection mode, so a follow-up in a multi-select menu defaults to `previous` and `lib/commcare/session.ts::toHqWorkflow` writes `previous_screen`, which HQ's form settings page cannot save and HQ's build refuses where exactly one of the menu and its parent is multi-select.

**Fix.**

*The model.* `POST_SUBMIT_DESTINATIONS = ["app_home", "firstMenu", "module", "parentMenu", "previous"]`.

| Destination | HQ `post_form_workflow` | The stack HQ builds | Where a worker lands on Android | Where a worker lands in Web Apps |
|---|---|---|---|---|
| `app_home` | `default` | none | The app's home screen | The app's first screen, which lists its menus |
| `firstMenu` | `root` | one `<create/>` with no children | The list of the app's menus | The app's first screen: the same screen as `app_home` |
| `module` | `module` | the menu's command, after its parent's command and selections for a child menu | The menu's first screen: its case list for a case menu, with the parent's selection kept | The same |
| `parentMenu` | `parent_module` | the parent menu's command and its selections | The parent menu, listing its forms and child menus, with its selection kept | The same |
| `previous` | `previous_screen` | the form's frame without its last child, as today | The screen before the form: the menu's list of forms for a top-level menu, the child menu's case list for a form of a child menu | The same |

Executed during planning, on `nested-menu-previous` with each value written by hand on the form of its parent menu and on the form of its child menu. HQ built each stack above. Core's session ran each; Formplayer answered each submission with the screen above; the Web Apps client, with the child form opened by clicks and submitted with its own Submit button, showed that screen; and Android's own home activity, handed the completed form, started the screen above. The two runtimes differ only at `app_home`.

The local suite writes the same frames: for `firstMenu` one `<create/>` with no children, and for `parentMenu` the parent menu's frame (`lib/commcare/formLinkProjection.ts::moduleFrameChildren` for the form's menu without its last child, matched to the source like the `module` frame).

`lib/commcare/session.ts::derivePostSubmitStack` gains the two cases (today it returns no frame for a childless one), `NOVA_TO_HQ` gains `firstMenu: "root"` and `parentMenu: "parent_module"`, and `deriveFormLinkStack` writes the same frames for a fallback. `lib/commcare/validator/hqJsonOracle.ts` already admits both wire words.

*The offered set.* `lib/domain/postSubmit.ts::postSubmitDestinationsOffered(doc, formUuid)` returns:

- `app_home` and `firstMenu`: always.
- `module`: unless the menu's parent is multi-select, the menu is `caseListOnly`, or the menu is off the menu.
- `previous`: unless the menu's parent is multi-select, the menu is multi-select, the menu opens on Search, or the menu is off the menu.
- `parentMenu`: when the menu has a parent, and the parent is neither multi-select nor off the menu.

The multi-select and Search conditions are what HQ's form settings page offers (`views/forms.py`, the `form_workflows` context). Executed during planning, on every form of `targeted-multi-select-destinations`, `nested-menu-previous`, `case-list-inline` and `navigation-base`, which between them hold every menu shape (top-level and child; single and multi-select; under a single and under a multi-select parent; opening on Search):

- The page's own list of destinations was what those conditions give, in every shape.
- The form settings save kept each offered value written by hand (`root`, `parent_module`, `module`, `default`, `previous_screen`), and answered 500 for an unoffered one (`previous_screen` in a multi-select menu, `module` under a multi-select parent).
- HQ's build refused, of every value on every form, exactly these: `previous_screen` where exactly one of the menu and its parent is multi-select (`mismatch multi select form links`), `previous_screen` in a menu that opens on Search (`workflow previous inline search`), and `parent_module` with no parent (`form link to missing root`). Each is unoffered, so one rule covers the editor and the build.

The "off the menu" conditions are Nova's own: HQ offers the value there. Block 11 gives what each runtime does with it and why it is withheld.

*The default.* `defaultPostSubmit(formType, { searchFirst, multiSelect, parentMultiSelect, offTheMenu })` returns `app_home` for a registration or a survey, and for a case-loading form the first offered of `previous`, `module`, `firstMenu`. `defaultPostSubmitOf` supplies the facts.

*The validator.* One rule, `POST_SUBMIT_NOT_OFFERED` (soundness, located at the form), replaces `lib/commcare/validator/rules/form.ts::postSubmitValidation` and `rules/case-search/searchFirst.ts::searchFirstNoPreviousWorkflow`. `POST_SUBMIT_MODULE_CASE_LIST_ONLY` and `SEARCH_FIRST_NO_PREVIOUS_WORKFLOW` are removed from `validator/errors.ts`, `validator/gate.ts` and `lib/doc/userFacingErrors.ts`, and their sentences become two of the rule's per-reason messages. The message names the destination, the reason, and the destinations offered:

| Reason | Message stem |
|---|---|
| The menu selects several cases | `"<form>" goes to the previous screen after submit, but "<menu>" selects several cases, and CommCare has no previous screen to return to there.` |
| The parent menu selects several cases | `"<form>" goes to <destination> after submit, but "<menu>" sits under "<parent>", which selects several cases.` |
| The menu opens on Search | the sentence `SEARCH_FIRST_NO_PREVIOUS_WORKFLOW` carries today |
| The menu is a case list with no forms | the sentence `POST_SUBMIT_MODULE_CASE_LIST_ONLY` carries today |
| The menu has no parent | `"<form>" goes to the parent menu after submit, but "<menu>" has no parent menu.` |
| The menu is off the menu | `"<form>" goes to <destination> after submit, but "<menu>" is off the menu: on Android that screen lists nothing, and Web Apps opens another screen instead.` |
| The parent menu is off the menu | `"<form>" goes to the parent menu after submit, but "<parent>" is off the menu: on Android it lists none of its own forms, and Web Apps opens the app's first screen instead.` |

Each ends with "Choose one of: <offered destinations>." `parentMenu` with no parent is a reason of the one rule, not a code of its own.

*The exemption for a fallback beside links.* When a form holds `formLinks`, `postSubmit` is the fallback after its links. The two multi-select reasons do not apply to such a form until step 5. `lib/domain/postSubmit.ts::postSubmitDestinationsAdmitted(doc, formUuid)` is the set the rule, the reducers and the cutover all read: the offered set for a form without links, and for a form with links the offered set computed with the two multi-select conditions ignored. Reason: a fallback HQ's settings page does not offer is defect 26's symptom, defect 26 is step 5's, and the lane's document for it (`targeted-form-links-hidden-and-fallback`, a follow-up with links in a multi-select menu and `postSubmit: "previous"`) must stay admissible until then. The other five reasons apply to every form, with or without links: the gate already refuses two of them today, HQ cannot build `parent_module` with no parent, and a destination that is a menu off the menu fails on both runtimes whatever precedes it.

*Reducers.* `lib/doc/mutations/modules.ts::reconcilePostSubmitWithSearchFirst` becomes `reconcilePostSubmitWithMenuShape`, so a mode change never dead-ends. It runs when a menu's selection mode, parent menu, Search-first setting or `hiddenFromMenu` changes, and for each child when a parent's selection mode or `hiddenFromMenu` changes. It reads the admitted set before and after the change, for every form, with or without links:

- An explicit destination that leaves the admitted set moves to the nearest admitted (`previous` to `module`, else `firstMenu`; `module` to `firstMenu`; `parentMenu` to `firstMenu`).
- An absent slot whose effective destination D leaves the admitted set stays absent and takes the new default.
- An absent slot whose D is still admitted, while `defaultPostSubmit` would now return another value, is pinned to D, as the Search-first reconciliation does today. This covers a destination coming back (a menu returning to single-select would move the default from `module` to `previous`) and a form that holds links (its menu turning multi-select moves the default from `previous` to `module`, while `previous` stays admitted for it).
- An explicit destination that stays admitted is kept. For a form that holds links that includes a fallback the settings page no longer offers, on the same boundary as the exemption.

*No-matches forms.* `lib/commcare/expander.ts::expandDoc` writes `root` for a no-matches form whose `postSubmit` is `app_home`, and `lib/commcare/compiler.ts` one empty `<create/>`, because HQ reads `default` there as a return to the case list. That is `firstMenu` under another name. From step 2 the document says what the wire does: the one explicit destination a no-matches form may hold is `firstMenu`, `rules/case-search/searchNoMatches.ts` reads `firstMenu` where it reads `app_home`, and the `plan.synthetic.has(moduleUuid) && form.postSubmit === "app_home"` special case and the compiler's `resetToAppHome` test are replaced by the ordinary `firstMenu` lowering. No byte changes. The two no-matches messages (`SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN` and `SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION`, in the rule and in `lib/doc/userFacingErrors.ts`) and `create_form`'s refusal in `lib/agent/tools/createForm.ts` say First menu where they say App home, and name `firstMenu` where they name `app_home`; an absent slot still returns to the search.

*Preview.* `lib/domain/navigation.ts::formNavigation` resolves `firstMenu` to the same `{ screen: "home" }` destination as `app_home`, which is what Web Apps does; Preview has one home screen for both until step 4 plays each platform. It resolves `parentMenu` to `moduleDestination(doc, parentUuid)` with the parent's selections kept. `lib/preview/noMatchesForm.ts::noMatchesPostSubmit` reads `firstMenu`.

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
- Proof: `proof/targeted/documents/multiSelectDestinations.ts`, `proof/targeted/documents/stableWitnesses.ts`, `proof/corpus/footprint.ts`; `proof/formplayer/test_end_of_form.py`, `proof/formplayer/conftest.py` and `proof/webapps/test_links.py`, `proof/webapps/conftest.py` (each `DOCUMENTS` gains the rewritten document); `proof/android/src/nova/proof/android/Nav.java` (new), `proof/android/src/nova/proof/android/Reader.java` (the `nav` request), `proof/android/navigation.py` (new), `proof/android/README.md`.
- Docs: `content/docs/form-links.mdx`, `content/docs/nested-menus.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the `post_submit` defaults; the "`previous` + `multi_select`" validation stub line is deleted), `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/preview/CLAUDE.md`, `components/builder/CLAUDE.md`.

**Stored shape and migration.** `Form.postSubmit` gains two enum members; an old document parses unchanged. Cutover step `post-submit`, over each form. "Effective" is the stored value, or for an absent slot what today's `defaultPostSubmit` returns, which the step carries in its own file because `lib/domain/forms.ts` no longer has it.

| Form | Before | After | Notice |
|---|---|---|---|
| No links, effective destination not offered, stored or by default | `previous` in a multi-select menu | `module`, written explicitly | `after-submit-destination-moved`, with `from` and `to` |
| No links, effective destination not offered, stored or by default | `previous` or `module` under a multi-select parent | `firstMenu`, written explicitly | same |
| Holds links, absent slot whose default changes | effective `previous` or `module` | that destination, written explicitly | none: nothing changes |
| Holds links, explicit destination | any | unchanged | none |
| With or without links, in a menu that `hidden-from-menu` has just marked off the menu | effective `previous` or `module` | `firstMenu`, written explicitly | same |
| No-matches form | `app_home` | `firstMenu` | none: the same bytes and the same screen |

Every write is explicit, so each notice record names a stored change and no absent slot changes meaning at the cutover. This differs from the reducer's second rule on purpose: a live edit leaves an absent slot to the default because its author is looking at the picker, and the cutover has no one looking.

`parentMenu` is never the migration's answer: HQ withholds `module` only under a multi-select parent, and there it withholds `parent_module` too. It is added because it costs one frame slice and HQ's page offers it.

**Register.** 3 entries move to the fixed register: `d14-multi-select-validate-mismatch-multi-select` (bar, control `targeted-multi-select-destinations`), `d14-multi-select-app-schema-form-post-form-workflow-not-offered` (manifest, control `case-capture-multiple`), `d14-multi-select-editor-jsonobject-exceptions-badvalueerror` (proof4, control `case-capture-multiple`).

**Spelling rule.** None. `proof/rules/form_link_fallback.py` stays.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-multi-select-destinations` and `case-capture-multiple` keep showing the three.

**Nova tests.** These prove Nova's own code; where each destination lands is the Lane's.
- Pure: `postSubmitDestinationsOffered` over the menu shapes (single, multi-select, under a multi-select parent, opens on Search, `caseListOnly`, off the menu, under a parent that is off the menu, with and without a parent).
- Pure, property: for every generated menu shape and form type, `defaultPostSubmit` is in the offered set.
- Pure: `POST_SUBMIT_NOT_OFFERED`, each of the seven reasons beside an accepted neighbour, and the exemption (a form with links and `previous` in a multi-select menu is admitted; the same form without links is refused; `parentMenu` with no parent, and `module` in a menu that is off the menu, are refused with links too).
- Pure, state model: the reducer reconciliation over each mode change, one case per rule above, including a link-holding form with an absent slot whose menu turns multi-select (pinned to `previous`), a link-holding form with an explicit `previous` there (kept), a link-holding form whose menu starts opening on Search (its explicit `previous` moves to `module`), and a menu turned off the menu (its forms' `previous` and `module` move to `firstMenu`, and its child menus' `parentMenu` moves to `firstMenu`).
- Pure: the local `firstMenu` and `parentMenu` frames in `lib/commcare/__tests__/formLinkParity.test.ts`, as a form's own destination and as a fallback, against the frames HQ built during planning, kept as fixtures.
- Pure, state model: Preview's routing for both destinations and for a no-matches form with `firstMenu`.
- Pure: the cutover step over frozen pre-step fixtures, one per row of the table above, the absent-slot and stored variants of the first two rows each, and that a second application changes nothing.

**Lane.**
- `targeted-multi-select-destinations` is rewritten in place to the migrated shape: a follow-up in a multi-select menu going to `module`, a follow-up under a multi-select parent going to `firstMenu`, and a follow-up in a single-select child menu going to `parentMenu`. It becomes the corpus witness for the two new destinations.
- `targeted-form-links-hidden-and-fallback` is not edited and must still be admitted; defect 26's nine entries stand.
- Every multi-select producer document that leaves `postSubmit` absent changes bytes with no source edit, since the default changes. The pull request runs the corpus emission first and diffs `index.json`.
- Locally: the rewritten document, `case-capture-multiple`, `case-extension-multiple`, `nested-menu-same-multiple`, `targeted-form-links-hidden-and-fallback`. The bar admits every multi-select document. Proof 3 on the rewritten document holds Core's session after submit across the two paths, for both new destinations. Proof 4's form settings save keeps each.
- Reader package tests, each over HQ's build of the rewritten document, each asserting the landing the table above gives for `module`, `firstMenu` and `parentMenu`:
  - `proof/formplayer/test_end_of_form.py`: Formplayer's answer to each form's submission.
  - `proof/webapps/test_links.py`: the screen the client shows after each form is submitted with its own Submit button.
  - `proof/android/navigation.py` (new), on a new reader request `nav` (`proof/android/src/nova/proof/android/Nav.java`: a command's form completed as its end completes it, the result handed to the app's own home activity, and the activity home then starts, with the session's frame and, for a menu screen, the rows its `MenuAdapter` lists; the same request launches a session endpoint as `DispatchActivity` hands one to home). It reads the lane's stored archive of A, as `proof/android/observe.py` reads archives. A request of this shape produced the Android column above.

## 4. The search button label leaves the model

**Today.** `lib/domain/modules.ts` holds `caseSearchConfig.searchButtonLabel` with `DEFAULT_CASE_SEARCH_BUTTON_LABEL = "Search"`, and `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument` writes it as `search_button_label` from the `module/<uuid>/search-button` translation unit. Every Case List save in HQ resets it.

**Fix.** `searchButtonLabel` and `DEFAULT_CASE_SEARCH_BUTTON_LABEL` are removed. Every search button reads "Search All Cases", in every language, on both export paths and in Preview.

- Reason: HQ's Case List save keeps no other label (`views/modules.py::_gather_and_update_search_properties` assigns a new `CaseSearch` without one, so `models/case_search.py::CaseSearch.search_button_label`'s default returns). Executed during planning, on `prompt-widgets`, `case-list-inline` and `search-browse`: the save replaced the stored `{'en': 'Search'}` with `{'en': 'Search All Cases'}`, and with that value written by hand the save changed nothing of the search configuration. HQ's build of `prompt-widgets` with a second language added by hand wrote `case_search.m0=Search All Cases` in every language's strings.
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

**Nova tests.** These prove Nova's own code; what the save and the build do is the Lane's.
- Pure: the strict schema refuses `searchButtonLabel`, beside a config without it.
- Pure, emission: HQ JSON, the local suite's locale and Preview's worker module carry the constant for an app with two languages.
- Pure: the cutover step over a frozen fixture holding a label and its translations in two languages; the output parses under the new schema and holds neither.
- Playwright: `e2e/tests/browser/case-workspace-surface.spec.ts` no longer edits a label and still passes.

**Lane.** Locally: `targeted-search-hq-compile`, `case-list-browse`, `search-browse`. Proof 4 on every document that offers search holds the save: the Case List save changes no `search_button_label`. Proof 3 holds the action's text as Core reads it across the two paths.

## 5. A sort column on a lookup-backed search input

**Today.** `lib/commcare/suite/case-search/searchPrompts.ts::buildItemset` returns `{ instanceId, nodeset, label, value }` and `lib/commcare/hqJson/caseList.ts::projectSearchInput` writes those four. `lib/domain/lookupCarriers.ts::lookupOptionsSourceSchema` has no sort. HQ's Case List save answers 400 for such a prompt.

**Fix.** A search input's lookup choices gain a sort column, the label column when absent.

- Reason: HQ's Case List save requires it (`views/modules.py::_update_search_properties`, its `_get_itemset`). Executed during planning, on `prompt-widgets`:
  - As published today the save answers 400, "The case search property 'region' is missing the following lookup table attributes: sort". With `sort` written by hand on both lookup-backed inputs the save is accepted and keeps it.
  - HQ's build then writes `<sort ref="label"/>` inside each `<itemset>` (`suite_xml/xml_models.py::Itemset.sort_ref`).
  - The choices a worker sees, over that build and a restore whose table rows were labelled by hand `b`, `B`, `a`, `é`, `Z`, `a`, `10`, `9`, `a`, in that row order. Without `<sort>`: row order, on Formplayer and in Android's search screen. With it: `10`, `9`, `B`, `Z`, `a`, `a`, `a`, `b`, `é` on both, the three `a` rows in their row order. That is UTF-16 code unit order, stable for ties (commcare-core `core/model/ItemsetBinding.java::sortChoices`). The Web Apps client, run over the document's own three rows (`North & coast`, `East`, `South`), listed them in row order without `<sort>` and as `East`, `North & coast`, `South` with it, the order Formplayer handed it.
- **Schema.** The sort belongs to search inputs only, since a form select shares `LookupOptionsSource` and its emitter writes no sort. In `lib/domain/modules.ts` both choice-input arms take `searchInputLookupOptionsSchema = lookupOptionsSourceSchema.extend({ sortColumnId: lookupColumnIdSchema.optional() })`, type `SearchInputLookupOptions`. Absent means the label column. One meaning has one spelling: the `addSearchInput` and `updateSearchInput` arms of `lib/doc/mutations/modules.ts` drop a `sortColumnId` equal to `labelColumnId` on every write of an input's `options`. `updateSearchInput` replaces the whole input, so a later label change that makes the two equal passes through the same arm and drops it too.
- **Lookup identity.** `lib/doc/lookupReferences.ts` registers `sortColumnId` as a column occurrence (subpath `["sortColumnId"]`), so the missing-column finding, the deletion guard and the app-move refusal see it.
- **Emitters.** `SearchPromptItemset` gains `sort`; `buildItemset` sets it from `sortColumnId ?? labelColumnId`; `buildSearchPrompts` writes `<sort ref>` inside the `<itemset>`, at the position HQ's build gives it (`proof/native/test_search_emission.py` compares each `<remote-request>` and `<entry>` of the two paths child for child); `projectSearchInput` writes `itemset.sort`.
- **Preview.** `lib/preview/engine/searchExpressionEvaluation.ts` lists a search input's lookup choices in the sort column's order: `lib/preview/engine/lookupEvaluation.ts::evaluateLookupChoices` takes an optional sort column and orders by its cell text with plain string comparison (the order observed above), never `localeCompare`, keeping row order for ties. A form select passes none and keeps row order.
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
- Proof: `proof/native/core/SearchPromptRuntimeTest.java`, `proof/native/test_search_emission.py` and the `prompt` family's producer table; `proof/formplayer/test_search.py`, `proof/webapps/test_search.py` and their `conftest.py` `DOCUMENTS`; `proof/android/src/nova/proof/android/Queries.java` (each dropdown's items).
- Docs: `content/docs/case-workspace.mdx`, `content/docs/project-data.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, `lib/lookup/CLAUDE.md` (the new occurrence a table deletion sees).

**Stored shape and migration.** One new optional slot; no document changes, since absent already means the label column. No step: `behavior.ts` returns one record per lookup-backed search input. Notice reason `lookup-choices-order-changes`, naming the input: its choices are now listed in the order of their labels, where they were listed in the table's row order.

**Register.** 3 entries move to the fixed register: `d14-search-lookup-prompt-editor-alerts-case-search-property`, `-editor-400-case-search-property`, `-editor-state-savebtn-bar-retry` (proof4), on control `prompt-widgets`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `prompt-widgets` keeps showing the three.

**Nova tests.** These prove Nova's own code; the save, the build and the order a worker sees are the Lane's.
- Pure, state model: the reducer stores a sort column equal to the label column as absent, on an add and on an update; an input holding a distinct sort column whose label column is then changed to that column ends with the slot absent; a removed sort column raises the lookup column finding.
- Pure: `behavior.ts` over a frozen pre-step fixture returns exactly one `lookup-choices-order-changes` record, for the lookup-backed input, and none for an input with inline choices.
- Pure, emission: `<sort ref>` and `itemset.sort` name the label column by default and the chosen column otherwise.
- Pure, state model: Preview's order over the nine labels above gives the order the readers gave, ties in row order.

**Lane.** Locally: `prompt-widgets`.
- Proof 4 holds the save: the Case List save is accepted on every document with a lookup-backed prompt, and keeps `sort`.
- `proof/native/core/SearchPromptRuntimeTest.java` (the `prompt` family, `proof/native/test_search_emission.py`) holds the order on Core for both paths: its lookup-choice assertions read `ItemsetBinding.getChoices()` from HQ's regeneration and from the local archive, and now expect label order. The family's table gains rows whose labels order differently by code unit and by locale, and a tie.
- `proof/formplayer/test_search.py` and `proof/webapps/test_search.py` gain one case each over HQ's build of `prompt-widgets`: the choices Formplayer hands the client, and the options the client's dropdown lists, in label order.
- `proof/android/observe.py` over the lane's archive of `prompt-widgets` records the search screen's choices in the same order (the `app` request's search screen gains each dropdown's items).

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
| `CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER` | any input named `_xpath_query` | HQ's Case List page refuses a prompt named like one of the menu's default filters (`static/app_manager/js/details/case_claim.js::searchViewModel.commonProperties`), and Nova writes default filters only as `_xpath_query` rows |
| `CASE_LIST_SEARCH_INPUT_NAME_RESERVED` | an input that reaches HQ as its own key (`!searchInputSuppressesAutoMatch(input)`) whose name `isReservedSearchInputName` | HQ reads that key as part of the search request, so the input never searches the property it names |

Message, both codes: `Search input "<name>" in "<menu>" uses a name CommCare reads as part of the search request, so it would never search a case property. Rename the input.`

*Executed during planning.*

- Each of the 16 names and `indices.parent` was sent as a request key through HQ's own request reading and query builder (`case_search/models.py::extract_search_request_config`, `case_search/utils.py::CaseSearchQueryBuilder.build_query`), beside two controls. None produced a query on a case property of that name:
  - `case_type`, `commcare_sort`, the four `x_commcare_` settings and `x_commcare_tag_module_name` are taken out of the request as settings.
  - `case_types`, `custom_related_case_property`, `data_registry`, `endpoint_id`, `include_all_related_cases` and `include_closed` reach the builder and add nothing to the query.
  - `commcare_blacklisted_owner_ids` and `commcare_project` filter by owner and by project space.
  - `_xpath_query` is compiled as a query, and a plain value is refused.
  - `indices.parent` searches the case's index.
  - The controls `first_name` and `external_id` query the case property of that name. `case_id` and `owner_id` query the case's id and its owner.
- On `targeted-search-default-filter-name` HQ's Case List page refuses to send its save: "Search Properties and Default Search Filters can't have common properties. Please update following properties: _xpath_query". With the input renamed by hand to `_xpath_query_2`, and each expression that reads it following the rename, the save is accepted.

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

**Nova tests.** These prove Nova's own code; what HQ reads of a request, and what its page saves, is the Lane's.
- Pure: each code beside an accepted neighbour (the same reserved name on an input sent with `exclude` is accepted; `owner_id` and `case_id` are accepted; `_xpath_query` is refused on every route).
- Pure: `isReservedSearchInputName('indices.parent')` is true and `isReservedSearchInputName('indices')` is false.
- Pure: the surface test above.
- Pure: the cutover step over a frozen fixture with one input of each kind (an own-key reserved input, an own-key `_xpath_query`, an advanced `_xpath_query`, an own-key `owner_id`), its equality with the reducer for the removals, and that a second application changes nothing.

**Lane.** `targeted-search-default-filter-name` is rewritten with the suffixed name and becomes the witness that the Case List save goes through. `targeted-search-hq-compile` loses its reserved inputs and stays, for defects 6 and 48. Locally: both.
- The manifest check holds every built suite and stored app: no `csql-key` item is a prompt key.
- Proof 4 holds the page: the Case List save is accepted on both documents.
- `proof/hq/test_case_search.py` gains the run above as its own test: each name of `RESERVED_SEARCH_INPUT_NAMES` and one `indices.` name through `operations.search_request_config` and HQ's query builder, none querying a case property of that name, beside `first_name`, which does. It reads the names from `lib/commcare/surface/surface.json`'s `csql-key` family, so a key HQ adds is run the week it appears.

## 7. Survey menus keep their case type

**Today.** `lib/commcare/expander.ts::expandDoc` passes `lib/commcare/formLinkProjection.ts::moduleCaseTypeForActions` to `lib/commcare/hqShells.ts::moduleShell`, so a menu that holds a case type, has only survey forms and is not `caseListOnly` uploads `case_type: ""`.

**Fix.** `expandDoc` passes the menu's own `caseType ?? ""` to `moduleShell`. The hidden menu of a no-matches form keeps its host's type. `moduleCaseTypeForActions` stays the gate for form actions, datums, details and the search config, so nothing else is built from the type.

- Reason: the case type is authored content, and HQ builds nothing from it. Executed during planning, on `targeted-survey-menu` with a type written by hand: HQ's build is the same, file for file and byte for byte, with and without it, and the module settings save keeps it. What changes is HQ's own page for the menu: HQ counts a menu with no type a survey menu and shows it no case list, and with the type it shows the Case List and Case Detail tabs.
- A menu that selects its parent record from such a menu is already refused: `lib/domain/caseParentSelection.ts::caseParentSelectionVerdict` requires the source to have a case form or be a case list. No refusal is added.

**Files.**
- Emitters: `lib/commcare/expander.ts`.
- Docs: none (no surface describes the dropped type).
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the sentence on `moduleCaseTypeForActions`).
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools: none.

**Stored shape and migration.** No schema change and no document change. No step: `behavior.ts` returns one record per such menu. Notice reason `survey-menu-takes-case-type`, naming the menu and its case type: HQ shows that type for the menu, and its case list settings, from the next publish.

**Register.** 1 entry moves to the fixed register: `d14-survey-menus-app-case-type` (intent), control `targeted-survey-menu`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-survey-menu` keeps showing it.

**Nova tests.** Pure: `expandDoc` for a survey-only menu with a case type writes the type and no form action, datum or search config; beside one with no case type, which writes `""`; and the hidden menu of a no-matches form still writes its host's type. Pure: `behavior.ts` over a frozen pre-step fixture returns exactly one `survey-menu-takes-case-type` record, for the survey-only menu with a case type, and none for a survey-only menu with no case type or a `caseListOnly` menu.

**Lane.** `targeted-survey-menu` stays admitted as the witness. Locally: that document. The intent check passes on it; proof 2 holds HQ's build of A and B alike; proof 4 holds the module settings save keeping the type and, with the one `name` column block 10 gives the menu, the Case List save going through.

## 8. The data node's name

The data node's `name` becomes the form's name in the app's first language, the value `<h:title>` carries. It lands with finding 46 in pull request 6 (part 05, Finding 46 and defect 14's data node name), because proof 4 reports the title and the name together. The three entries `d14-data-node-name-form-instance-name`, `-source-instance-name` and `-trace-name` (proof4, control `case-operation-query`) move to the fixed register in that pull request. `lib/commcare/xform/dataRootAttributes.ts::xformDataRootRuntimeAttributes` and its callers in `lib/commcare/xform/builder.ts` and `lib/preview/engine/formEngine.ts` are files of that block of part 05.

## 9. Tiles and sort spellings

Tile cell placement, the required `horizontalAlign`, `verticalAlign` and `fontSize`, hidden sort carriers, `CASE_TILE_HIDDEN_CALCULATED_SORT`, finding 42, sort type `plain`, explicit sort blanks, `sort_calculation` pairs and date patterns are decided in part 07 (part 07, Tile cells and finding 42; The corrected tile clause; Finding 57: the `case_id` column and attribute-backed hidden carriers; The sort spellings and the four rules they retire; Date patterns narrowed to HQ's five), which owns `lib/commcare/hqJson/caseList.ts::projectSortElements`, `projectColumnForShortDetail`, `hqShortSourceColumns` and `lib/commcare/suite/case-list/sortKeys.ts`. This part edits `caseList.ts` only in `buildSearchConfigDocument`, `projectSearchInput`, `projectColumnToDetail` (the `calculate` format, below) and `projectCaseListForHq` (the empty list and `no_items_text`, below), and its pull request 12 edits land after part 07's pull request 11.

## 10. The equivalent spellings

Spellings HQ's editors do not write, which a save keeps or rewrites to an equivalent. No register entry belongs to any of them.

| Item | Nova writes today | HQ's editors write | From step 2 | Rule retired |
|---|---|---|---|---|
| Registration `update never` | `never` when a registration writes only its name and `external_id` | `always` | Block 1 | `update_never_beside_actions` |
| `open_case.external_id` | the question path (`formActions.ts::buildFormActions`) | Nothing sets it. The Case Management tab writes an external id as an ordinary `update_case.update` row | Below | none |
| `no_vellum` | `false` (`hqShells.ts::formShell`) | no such key | Omitted | none |
| `custom_variables` | `null` (`hqShells.ts::detailBase`) | no such key; `models/case_list.py::Detail` holds `custom_variables_dict` | Omitted | none |
| `calculate` column format | `format: "calculate"` with `useXpathExpression` (`hqJson/caseList.ts::projectColumnToDetail`) | `plain` with `useXpathExpression` | `plain` | none |
| Empty short case list | `columns: []` when the projected short `columns` array is empty (today: `caseListConfig` absent, or no column shown in the list or carrying an order rule) | at least one column: `models/modules.py::Module.new_module` writes `{ format: "plain", field: "name", model: "case", hasAutocomplete: true, header: { <lang>: "Name" } }` | That one column | none |
| Sort type, sort blanks, `sort_calculation` pairs | see block 9 | see block 9 | Part 07, The sort spellings and the four rules they retire | `sort_type_plain`, `sort_blanks_default`, `sort_calculation_pair` |
| `date_format` outside HQ's five | see block 9 | see block 9 | Part 07, Date patterns narrowed to HQ's five | none |
| `case_preload` | a basic preload action | no basic editor writes one | **Stays until step 5** | none now |

`case_preload` is a departure from the research, which lists it among step 2's equivalent spellings: its editable spelling is a default value that reads the case, which is defect 28's fix and depends on step 5's load-time value rules. Step 2 does not touch it, and `proof/rules/preload_condition.py` stays.

### `external_id` as an ordinary update row

**Today.** `buildFormActions` writes a registration's external id question path on `open_case.external_id`, and `lib/commcare/xform/caseBlocks.ts::buildCaseBlocks` has an `openExternalId` branch for it.

**Fix.** From step 2 `open_case.external_id` is `null` and the write is `update_case.update.external_id`, whose `question_path` reads `nova_trimmed_<question>`, the trimmed hidden value finding 33 introduces (part 05, Finding 33: `nova_trimmed` and the source-question guard). Reason: the Case Management tab writes an external id as an update row, and the two spellings are one to HQ and to a device. Executed during planning, on the registration form of `navigation-base` with the row written by hand: HQ builds the same files for the two spellings (one `<update><external_id/>` either way); Core's submission of each and HQ's case processing of it store the same external id; and the Case Management save keeps the row and the `null`. `buildCaseBlocks` drops the `openExternalId` branch and writes the row through the update map, so block 1's `<update>` rule covers it. The scalar guard in `buildCaseBlocks` that keys on the property name `external_id` stays and now covers the update row.

**Files.** Emitters: `lib/commcare/formActions.ts`, `lib/commcare/xform/caseBlocks.ts`, `lib/commcare/validator/hqJsonOracle.ts` (refuses a non-null `open_case.external_id`). CLAUDE.md: `lib/commcare/CLAUDE.md`. All other groups: none.

**Stored shape and migration.** None. No notice: no worker or author sees a change.

**Register.** None of its own. Finding 33's entries for trimmed external ids move with finding 33's block in part 05.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None: no entry holds this spelling.

**Nova tests.** Pure, emission: a registration with an external id writes `open_case.external_id: null`, the update row reading `nova_trimmed_<question>`, and one `<update><external_id/>` on the local path; the oracle refuses the old spelling. These prove Nova's own code.

**Lane.** Locally: `navigation-base`, the corpus document whose registration form writes an external id. Proof 4 holds the Case Management save keeping the row. Proof 3 holds the stored external id across the two paths: Core submits the form from each, and HQ processes both.

### `no_vellum`, `custom_variables`, the `calculate` format and the empty short list

**Today.** As the table gives, in `lib/commcare/hqShells.ts::formShell`, `detailBase` and `lib/commcare/hqJson/caseList.ts::projectColumnToDetail`.

**Fix.** Each executed during planning, in the lane's HQ and its editor pages.

- **`no_vellum` and `custom_variables`** are omitted and leave `lib/commcare/types.ts`. On `case-list-inline` with both removed by hand: HQ builds the same files, and the form settings, module settings, Case List and Case Detail saves each leave both absent.
- **A calculated column** writes `format: "plain"`, with `useXpathExpression` as today. On `case-list-inline`, whose list holds such columns, with `plain` written by hand: HQ builds the same files, and the Case List save keeps `plain`.
- **An empty short list.** When the projected short `columns` array is empty (`lib/commcare/hqJson/caseList.ts::projectCaseListForHq`: `caseListConfig` is absent, or `hqShortSourceColumns` keeps no column), the menu writes the one `name` column on its short detail, through the ordinary column projection, with the header "Name" for every app language so a later save changes nothing. On `targeted-survey-menu` with the column written by hand:
  - HQ builds one more `<detail>` for that menu, `m0_case_short`, which no entry references, and its header strings. Nothing else of the build changes.
  - Core runs the same sessions on that build as on today's, and HQ processes the same submissions. Formplayer walks it and submits both forms as before, and Android installs it and opens both forms.
  - With the menu's case type (block 7) HQ's page offers the Case List tab, and its save goes through; with `columns: []` the tab has no column to save from.
- **The local suite does not change.** It writes no detail for such a menu. No session reaches the detail, so the two paths behave alike, which is what proof 3 compares.

**Files.** Emitters: `lib/commcare/hqShells.ts`, `lib/commcare/hqJson/caseList.ts`, `lib/commcare/types.ts`, `lib/commcare/validator/hqJsonOracle.ts` (refuses `no_vellum`, `custom_variables`, `format: "calculate"` and an empty short `columns`, so the old spellings cannot return). CLAUDE.md: `lib/commcare/CLAUDE.md`. All other groups: none.

**Stored shape and migration.** None. No notice.

**Register.** None.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None.

**Nova tests.** Pure, emission through the oracle: each of the four spellings, and the `name` column's header in every language of a two-language app. These prove Nova's own code.

**Lane.** Locally: `targeted-survey-menu`, `arithmetic`, and `case-list-inline` for the `calculate` format (`search-multiple` holds more such columns). Proof 4 on every document holds the saves: the form settings, module settings, Case List and Case Detail saves change none of the four. Proof 2 holds HQ's build of calculated columns alike across A and B, and proof 3 holds Core's sessions on `targeted-survey-menu` alike across the two paths, the unreferenced detail on one side only.

## 11. `hiddenFromMenu`: a menu or form that is not on the menu

**Today.** `lib/commcare/validator/rules/displayConditions.ts::validateCarrier` raises `DISPLAY_CONDITION_ALWAYS_FALSE` for a display condition that simplifies to `match-none`, so no Nova app can hold a menu or form that is reached only by a link or an entry point. `lib/commcare/suite/displayConditions.ts` emits through `lib/domain/predicate/simplify.ts::effectiveDisplayConditionForEmission`, where one `match-none` clause absorbs a whole conjunction.

**Fix.**

*The model.* A sibling flag on both carriers: `Module.hiddenFromMenu: z.literal(true).optional()` and `Form.hiddenFromMenu: z.literal(true).optional()`. Absent means on the menu. `displayCondition` is unchanged and holds the rest: the condition that applies once the item is back on the menu. A menu that is off the menu takes its forms with it: none of them is listed anywhere. "Off the menu" below always means the item's own flag; a child menu of a menu that is off the menu is not itself off the menu.

- Reason for a flag over an arm of the condition: `displayCondition` stays a plain `Predicate` for every walker (`lib/domain/referenceSlots.ts`, `predicate/walk.ts`, `predicate/rewrite.ts`, the reference index, renames, lookup extraction), and "off the menu" and "the condition for when it returns" are two facts.
- What the wire accepts (executed during planning, on `nested-menu-previous`): with `false()` and with `false() and (<rest>)` written by hand as a form's `form_filter` and as a menu's `module_filter`, HQ's form settings save and module settings save keep each spelling character for character, parentheses included, and HQ's build writes each as the command's or the menu's `relevant` (the rest expanded as any condition is). A condition that ends in `and false()`, and one that holds `and true()`, are kept and built the same way.

*Emission.* `emitModuleDisplayCondition`, `emitFormDisplayConditionForSuite` and `emitFormDisplayConditionForHq` take the flag. When it is set they return `false()` with no rest and `false() and (<rest>)` otherwise, the parentheses always written. Instance declarations still come from the rest.

*Conditions are held as written.* `lib/domain/predicate/simplify.ts::effectiveDisplayConditionForEmission` is deleted and `displayConditionForEmission` takes its place: absent for an absent condition or one whose root node is `match-all`, and otherwise the condition exactly as stored. Nothing inside it is rewritten: `x and always` prints `x and true()`, `x or always` prints `x or true()`, and an authored `x and never` prints `x and false()` and is an ordinary condition. Every reader moves to the new function:

- the three emitters in `lib/commcare/suite/displayConditions.ts`;
- the instance collection for a form's entry in `lib/commcare/session.ts`, and the module's condition in `lib/commcare/compiler.ts`. Both must read what the emitter prints: under the old function an authored `x and never` collapsed to `match-none` there, and the instances `x` reads would go undeclared while the emitter printed them. For a hidden item both collect instances from the rest;
- `lib/preview/engine/displayConditionEvaluation.ts`, which evaluates the stored condition and no longer short-circuits on an absorbed one.

*One meaning, one spelling.* A `displayCondition` that is `match-none`, or an `and` whose first clause is `match-none`, would print exactly the hidden spelling, so it is refused by a shape rule: `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU`, message `"<name>" has a display condition that starts with "never". To keep it off the menu, turn off "Show on the menu" and keep the rest of the condition.` Every other condition that happens to be false is ordinary.

*`DISPLAY_CONDITION_ALWAYS_FALSE` retires.* It is removed from `validator/rules/displayConditions.ts`, `validator/errors.ts`, `validator/gate.ts`, `lib/doc/userFacingErrors.ts`, `components/builder/shared/editorSchemas.ts` and `docs/architecture/complex-apps.md`, and the manifest entries for `module_filter` and `form_filter` equal to `false()` or `false() and <rest>` move from refused to held, their wording changed from "always-false arm" to "`hiddenFromMenu`, with `displayCondition` holding the rest".

*What each runtime does with an item that is off the menu.* Executed during planning, over HQ's builds of `targeted-form-link-hidden-target`, `nested-menu-previous` and `endpoint-case-list` with the two spellings written by hand: through Formplayer and the Web Apps client (a link's source form opened by clicks and submitted with its own Submit button; an entry point opened by the route HQ's own link view sends the browser to), and through Android's own home activity (handed a completed form, or launched with an entry point as its dispatcher launches one).

| # | What a worker does | Android | Web Apps |
|---|---|---|---|
| 1 | Opens the menu that holds a hidden form, or the list of menus | The form is not listed; the menu is not listed | The same |
| 2 | Submits a form whose after-submit link names a hidden form | Opens the hidden form | Does not open it. Lands on the menu that holds it, which lists its other forms |
| 3 | Submits a form whose link names a form inside a hidden menu | Opens the form | Lands on the app's first screen |
| 4 | Submits a form whose link names a hidden menu | Opens a menu screen that lists nothing | Lands on the app's first screen |
| 5 | Opens a form's entry point that has `ignoreDisplayConditions` (the form hidden, or inside a hidden menu) | Opens the form | Opens the form |
| 6 | Opens a form's entry point that does not | Opens the form all the same: Android does not act on the setting | Does not open it, and shows no message. Lands on the menu that holds a hidden form, or on the app's first screen when the form's menu is hidden |
| 7 | Opens a hidden menu's own entry point | Opens a menu screen that lists nothing | Lands on the app's first screen |
| 8 | Opens a hidden menu's case list entry point | Opens the case list. Once a case is picked, a menu screen that lists nothing | Lands on the app's first screen |
| 9 | Submits a form of a hidden menu whose destination is `module` or `previous` | The hidden menu's screen, which lists nothing (for a case menu, its case list first) | The nearest menu above it that is on the menu, or the app's first screen |
| 10 | Submits a form whose destination is `parentMenu`, the parent hidden | The parent's screen, which lists its child menus and none of its own forms | Lands on the app's first screen |

Rows 3, 8, 9 and 10 in Web Apps are Formplayer's answers. Every other row was also read off the client's screen, which showed Formplayer's answer each time. Core, as the lane's runner drives it, takes a frame as given: it opens the hidden form of rows 2 and 3, and at row 4 asks for a command of the hidden menu. A child menu of a hidden parent is reached through no menu on either runtime, and row 10 is the one screen that still names it.

This was already true of any target whose display condition is false when a worker gets there; `hiddenFromMenu` makes it the constant case. Three things follow.

- **Rows 2, 3, 5 and 6 are what `hiddenFromMenu` is for, and they are allowed.** A hidden form opens on Android from a link or any entry point, and in Web Apps only from an entry point with `ignoreDisplayConditions`. The builder copy, the SA and MCP descriptions, the notice and the docs say exactly that, per platform, and never say a hidden item is reached "by links" without the platform.
- **Rows 4, 7 and 8 work on neither runtime, and are refused.** `HIDDEN_MENU_NOT_A_DESTINATION` (soundness, `lib/commcare/validator/rules/hiddenFromMenu.ts`): a form link whose target is a menu that is off the menu (located at the link), and an entry point or a case list entry point on such a menu (located at the menu). Message: `"<menu>" is off the menu, so <the link from "<form>" | its entry point | its case list entry point> would open a menu with nothing in it on Android and the app's first screen in Web Apps. Point it at a form inside the menu, or show the menu again.`
- **Rows 9 and 10 are withheld as destinations.** They are the last two reasons of `POST_SUBMIT_NOT_OFFERED` (block 3), and block 3's reducer moves a destination that turning a menu off the menu leaves unoffered. So a case-loading form of a hidden menu goes to `firstMenu` by default, which lands on the list of menus on both runtimes.

*Other rules.* The context rules for a module's and a form's display condition keep running on the rest while the item is hidden. There is no reachability rule: a hidden item nothing reaches is a valid app, which HQ builds. A no-matches form refuses `hiddenFromMenu` as it refuses a display condition (`rules/case-search/searchNoMatches.ts`), since it is already on no menu.

*Preview.* Preview has one runtime until step 4 plays each platform, and for an item that is off the menu it does this:

- `lib/preview/menuProjection.ts::previewModuleVisibility` and the form list in `lib/preview/screenProjection.ts` leave a hidden menu or form off the list without evaluating the rest, and a hidden parent hides its child menus, as on both runtimes (row 1). `lib/preview/app-tests/navigation.ts` refuses to open a hidden item from a menu.
- After-submit routing is unchanged and opens a link's target whatever its visibility: Android's behavior (rows 2 and 3).
- `lib/preview/entryPointLaunch.ts` treats `hiddenFromMenu` as not shown, so a form's entry point opens the form only with `ignoreDisplayConditions`: Web Apps' behavior (rows 5 and 6). Without it Preview keeps its existing refusal, with copy that says what was observed: "This form is off the menu. On Android this entry point opens it. In Web Apps it opens only when the entry point ignores display conditions."

*Builder.* A "Show on the menu" switch on the menu's and the form's settings, beside the display condition, on by default. The condition editor stays and is labelled "When shown on the menu". When the switch is off:

- on a form: "Off the menu. On Android this form opens from an after-submit link or an entry point. In Web Apps it opens only from an entry point that ignores display conditions."
- on a menu: "Off the menu, with every form in it. On Android its forms open from an after-submit link or an entry point. In Web Apps they open only from an entry point that ignores display conditions."

*SA and MCP.* `hiddenFromMenu` on `update_module` and `update_form`, beside `displayCondition`, which those two tools already carry in that spelling (`true` hides, `null` shows, omission keeps). Each description carries the two sentences of the builder copy for its carrier, and the menu's adds that a hidden menu can be no link's target and hold no entry point. `create_module` and `create_form` take no display condition today and do not take the flag; a following update sets it. `get_module`, `get_form` and `lib/agent/summarizeBlueprint.ts` show it. No prompt or tool description says a condition may not be always false today (the sentence lives only in the validator rule and `lib/doc/userFacingErrors.ts`, which the retirement above removes), so nothing model-facing is deleted; the two `displayCondition` descriptions gain the pointer to the flag.

**Files.**
- Domain: `lib/domain/modules.ts`, `lib/domain/forms.ts`, `lib/domain/predicate/simplify.ts`, `lib/domain/referenceSlots.ts`, `lib/domain/postSubmit.ts` (the offered set reads the flag, block 3).
- Doc and mutations: `lib/doc/displayConditionMutations.ts` (the flag rides the ordinary module and form patch), `lib/doc/mutations/modules.ts` (block 3's reconciliation runs when the flag changes), `lib/doc/diffDocsToMutations.ts`, `lib/doc/userFacingErrors.ts` (the renderer of `HIDDEN_MENU_NOT_A_DESTINATION`).
- Validator: `lib/commcare/validator/rules/displayConditions.ts`, `rules/hiddenFromMenu.ts` (new), `rules/module.ts` and `rules/form.ts` (register it), `rules/case-search/searchNoMatches.ts`, `validator/errors.ts`, `validator/gate.ts`.
- Emitters: `lib/commcare/suite/displayConditions.ts`, `lib/commcare/session.ts`, `lib/commcare/expander.ts`, `lib/commcare/compiler.ts`, `lib/commcare/surface/entries/menus-and-case-lists.json`.
- Preview: `lib/preview/engine/displayConditionEvaluation.ts`, `lib/preview/menuProjection.ts`, `lib/preview/screenProjection.ts`, `lib/preview/entryPointLaunch.ts`, `lib/preview/app-tests/navigation.ts`, `components/preview/screens/HomeScreen.tsx`, `components/preview/screens/ModuleScreen.tsx`.
- Builder: `components/builder/conditions/DisplayConditionSection.tsx`, `conditions/displayConditionCopy.ts`, `conditions/useDisplayConditionCarrier.ts`, `detail/formSettings/FormSettingsPanel.tsx`, `detail/moduleSettings/ModuleSettingsPanel.tsx`, `components/builder/shared/editorSchemas.ts`.
- SA and MCP tools: `lib/agent/tools/updateModule.ts`, `updateForm.ts`, `getModule.ts`, `getForm.ts`, `lib/agent/summarizeBlueprint.ts`, `lib/agent/authoring/output.ts` (the `getModule` and `getForm` projections carry the flag beside `display_condition`), `lib/agent/tools/entry-points.ts` (the two `ignoreDisplayConditions` descriptions say that in Web Apps it is also what opens a form that is off the menu or inside a menu that is off the menu, and that Android opens the form either way; the menu and case list entry point descriptions say a menu that is off the menu takes neither). The model-facing text that describes a display condition on a menu or a form is the `displayCondition` description in `updateModule.ts` and in `updateForm.ts`, those two entry-point descriptions, and the `search-no-matches` entry description in `lib/agent/tools/shared/formEntry.ts` ("No other destination, links, or display condition", which gains the flag). The set is defined by a search of `lib/agent` outside `__tests__` for `displayCondition`, `display_condition` and `display condition`, re-run in the pull request; its other matches are the search button's condition in `lib/agent/tools/case-search-config/`, which this block does not change, and `lib/agent/prompts.ts`, `lib/agent/promptSegments.ts` and `lib/agent/planning/` hold no sentence on display conditions. The pull request reads the changed descriptions on the `/agents` pages.
- Proof: `proof/targeted/documents/hiddenFromMenu.ts` (new, the document below), `proof/targeted/index.ts`, `proof/timings.json`, `proof/README.md` (its row); `proof/formplayer/test_end_of_form.py`, `proof/webapps/test_links.py` and both packages' `conftest.py` `DOCUMENTS`; `proof/android/navigation.py` and the `nav` request (block 3 adds both).
- Docs: `content/docs/display-conditions.mdx`, `content/docs/form-links.mdx`, `content/docs/deep-links.mdx` and `content/docs/nested-menus.mdx` (each states its rows of the table, per platform), `content/docs/mcp/tools.mdx`, `docs/architecture/complex-apps.md`.
- CLAUDE.md: `lib/domain/CLAUDE.md`, `lib/domain/predicate/CLAUDE.md`, `lib/doc/CLAUDE.md` (both name the deleted function), `lib/commcare/CLAUDE.md` (replacing "a deeply always-false condition is a soundness finding"), `lib/preview/CLAUDE.md`, `components/builder/CLAUDE.md`.

**Stored shape and migration.** Two new optional slots. Cutover step `hidden-from-menu` is the only step that sets the flag. Defect 6's step, `time-ordering` (pull request 14; part 08, Defect 6: ordering a time, and the three system dates in CSQL), only replaces comparisons; that pull request inserts it at its row of part 10's registry, before this one in `transform.ts`, so this step's one pass sees every `match-none` it writes, and it sets nothing on a menu or form itself. For each menu and form whose `displayCondition` is `match-none`, or an `and` whose first clause is `match-none`, set `hiddenFromMenu` and keep the remaining clauses as the condition (none, one, or an `and` of the rest). A `match-none` in any other position is left as written. The gate has refused the shape, so only defect 6's rewrite can make one. Notice reason `hidden-from-menu-set`, naming the menu or form, with the builder copy's two platform sentences for its carrier.

A menu the step marks must still pass the gate. Block 3's step `post-submit` runs after this one and moves its forms' `previous` and `module` to `firstMenu`. A marked menu that is a link's target, or that holds an entry point or a case list entry point, has no rewrite that keeps what its author asked for, so the scan reports it as the blocker `hidden-menu-is-a-destination`, naming the menu and what points at it; its remedy is the author's: point the link or the entry point at a form, or change the comparison defect 6 rewrote. Part 10's registry of blockers gains it. A menu or form hidden because of defect 6's rewrite gets both records: `time-comparison-never-true` from that step, naming the comparison, and `hidden-from-menu-set` from this one.

**Register.** None. Nova cannot emit the shape today.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None: there is no pre-fix symptom to keep showing.

**Nova tests.** These prove Nova's own code; what each runtime does is the Lane's.
- Pure: the three emitters' bytes for the flag alone, the flag with a rest, `x and never` with no flag, and `x and always` with no flag.
- Pure, emission: a form whose condition is `x and never`, and a hidden form whose rest reads a lookup table, each declare on their entry every instance the printed `relevant` reads; the same for a module's condition.
- Pure: `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU` for `never` and for `never and x`, beside the accepted `x and never`; the no-matches refusal beside an ordinary form.
- Pure: `HIDDEN_MENU_NOT_A_DESTINATION`, each of its three arms beside its accepted neighbour (a link to a form inside the hidden menu; a form's entry point inside it; the same link and entry points on a menu that is on the menu).
- Pure, state model: turning a menu off the menu moves its forms' and its child menus' destinations as block 3's reducer says, and is refused while the menu is a link's target or holds an entry point.
- Pure, state model: Preview's own model. Its menu projection hides the item and its child menus without evaluating the rest; an entry point opens a hidden form only with `ignoreDisplayConditions` and otherwise shows the refusal copy above; an after-submit link opens it; an App Test cannot open it from a menu.
- Pure: the cutover step over a frozen fixture with each of the three shapes (`never`, `never and x`, `never and x and y`) beside `x and never`, which it leaves alone; and, from pull request 14, over a fixture whose display condition is a time comparison, which ends hidden with both records; and the scan over a fixture whose marked menu is a link's target, which reports `hidden-menu-is-a-destination`.
- Playwright: the switch hides a form from Preview's menu and the condition editor stays editable.

**Lane.** A new targeted document, `targeted-hidden-from-menu`, under a configuration with entry points on:

- a menu "Start" with two forms, one linking to the hidden form and one to the form inside the hidden menu;
- a menu "Targets" with a shown form (an entry point), a hidden form with a rest condition (an entry point with `ignoreDisplayConditions`) and a second hidden form (an entry point without);
- a hidden menu holding one form (an entry point with `ignoreDisplayConditions`; its destination is its type's default).

Locally: that document. What holds each fact:

- The bar admits HQ's build; proof 2 passes; proof 4's module settings save and form settings save keep `false()` and `false() and (<rest>)`.
- Proof 3 holds Core across the two paths: the menu lists, and the session after each link (Core opens the target).
- `proof/formplayer/test_end_of_form.py` gains the document: rows 1, 2, 3, 5 and 6 of the table as Formplayer answers them (each link's submission, and each entry point asked for as the client asks for one).
- `proof/webapps/test_links.py` gains the document: rows 1, 2, 5 and 6 on the client's own screen, an entry point opened by the route HQ's `cloudcare/views.py::session_endpoint` sends the browser to.
- `proof/android/navigation.py` gains the document, through the `nav` request: rows 1, 2, 3, 5 and 6 as Android's home activity starts them, each menu screen read from its `MenuAdapter`.
- Rows 4, 7, 8, 9 and 10 name shapes the gate refuses, so no admitted document holds them and no check can run them. They are recorded here as executed during planning, and the Nova tests above hold the refusals.

## 12. Finding 41: the empty-list text without English

**Today.** Nova writes no `no_items_text` on a short detail (`lib/commcare/hqShells.ts::detailBase`), so HQ's model default holds `en` alone, and under `USH_EMPTY_CASE_LIST_TEXT` the module settings save writes an empty text for the page's language. In an app with no English the default app strings then read blank.

**Fix.** A derived default, not a model addition: `lib/commcare/hqJson/caseList.ts::projectCaseListForHq` writes `no_items_text` on the short detail as "List is empty." for every app language, keyed by wire code. The text is the constant `lib/commcare/hqShells.ts::EMPTY_CASE_LIST_TEXT`.

- Reason: every language already reads that sentence today, so no worker sees a change, and the module settings page then shows and posts the text it was given. Executed during planning:
  - On `localization-optional` (Spanish and English) under its maximum configuration, which holds `USH_EMPTY_CASE_LIST_TEXT`: HQ's build of today's export writes `m0_no_items_text=List is empty.` in every language's strings. Today the module settings save adds `no_items_text/es` as an empty text. With the text written by hand for both languages the save changes nothing of it, and the build's strings are the same.
  - In the Web Apps client, on a Spanish-only app (`targeted-empty-list-no-english`): a worker reads "List is empty." on today's export, and a blank box after the module settings save. With the text written by hand for `es`, the worker reads "List is empty." before the save and after it.
- The local `.ccz` does not change. HQ writes the element and its strings only under the target's flag (under the minimum configuration the same builds held no such string).
- An authored empty-list text is a later step's model addition; when it lands it replaces the constant.

**Files.** Emitters: `lib/commcare/hqJson/caseList.ts`, `lib/commcare/hqShells.ts`, `lib/commcare/types.ts`. Proof: `proof/webapps/test_empty_list.py`. CLAUDE.md: `lib/commcare/CLAUDE.md`. All other groups: none.

**Stored shape and migration.** None. No notice.

**Register.** 2 entries move to the fixed register: `d41-empty-list-text-app-no-items-text` (proof4, control `case-list-inline`), `d41-empty-list-text-strings-m-no-items-text` (proof4, control `search-browse`).

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `case-list-inline` and `search-browse` keep showing them.

**Nova tests.** Pure, emission: `no_items_text` holds the constant under each wire code of a two-language app with no English, on the short detail only. This proves Nova's own code.

**Lane.** Locally: `localization-optional`, `endpoint-case-list`.
- Proof 4 on every document holds the save: the module settings save changes no `no_items_text`, and no `m<i>_no_items_text` reads blank in the build that follows.
- `proof/webapps/test_empty_list.py` holds what a worker reads: over `targeted-empty-list-no-english` it now expects "List is empty." before the module settings save and after it, where today it shows the blank box after.
- The first entry's document, `localization-optional`, changes bytes under the blank-translation fill in pull request 6 (part 05, Blank translations (defect 13)) with no source edit. The entry keeps showing on it until this block lands: its symptom is the stored short detail's `no_items_text`, which that fill does not write, and the run above is that symptom on that document.

## 13. Finding 54: the empty search description

**Today.** `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument` writes `description` only where a subtitle is authored and leaves `title_label` as `{}` (`hqShells.ts::caseSearchConfigShell`). HQ's Case List save writes both for the page's language as the text it holds, empty for none, and HQ's build of the saved app then writes a `<description>` on the search.

**Fix.** Nova writes what the save writes, on both paths.

- HQ JSON: on every menu, `search_config.description` is the authored subtitle's text map, and otherwise `""` for every app language; `search_config.title_label` is the authored title's map, and otherwise `""` for every app language. Reason: the Case List save writes both on every menu, whether or not the menu offers search (`views/modules.py::_gather_and_update_search_properties`; executed, below, on `case-operation-query`, whose menu offers none and gains both), so writing one and leaving the other under a rule would be the inconsistent state.
- Local suite: every search writes `<description>` with its locale, on the remote request (`lib/commcare/suite/case-search/remoteRequest.ts`) and on the inline query (`suite/case-search/inlineSearch.ts`), with a blank value where no subtitle is authored. The blank row has no translation unit to come from, so it is a literal: `lib/commcare/suite/case-search/inlineSearch.ts::searchScreenTranslationUnits` keeps mapping `case_search.m<N>.description` to the `search-subtitle` unit only where a subtitle is authored, and otherwise the two search emissions return that locale id in their `strings` with the value `""`, which `lib/commcare/compiler.ts` writes into every language's table as it writes any string with no unit. `compiler.ts` is not edited. `lib/commcare/localeFile.ts::serializeLocaleFileValue` already writes a blank value as a non-breaking space, as HQ's locale writer does.
- Executed during planning:
  - On `case-operation-query`, `case-list-inline` and `search-browse` with both maps written by hand: the Case List save changes nothing of the search configuration, where today it adds `description/en` (and `title_label/en` where no title is authored).
  - HQ's build of the planned `search-browse` writes `<description>` after the query's `<title>`, and `case_search.m0.description` as a non-breaking space. Formplayer hands the client `""` for today's build and the non-breaking space for the planned one.
  - Nova's local archive of `search-browse` with the same `<description>` and locale value written into it by hand: Core admits it, and Formplayer hands the client the same non-breaking space as for HQ's planned build (`""` for today's archive).
  - The Web Apps client renders no description element for `""` or for the non-breaking space, on a search opened from a list, one a menu opens and an inline one (`proof/webapps/test_search.py`).
  - Android's search screen shows the same texts for all four archives: its prompts and its button, and no description.
- So no worker sees a change, and the fix removes a difference between what Formplayer is handed by the two builds.

**Files.** Emitters: `lib/commcare/hqJson/caseList.ts`, `lib/commcare/hqShells.ts`, `lib/commcare/suite/case-search/remoteRequest.ts`, `suite/case-search/inlineSearch.ts`, `lib/commcare/validator/hqJsonOracle.ts` (a `description` or `title_label` missing an app language is refused). Preview: none; it shows no subtitle where none is authored. Proof: `proof/native/test_search_emission.py`, `proof/formplayer/test_search.py`, `proof/formplayer/test_local_archive.py`, `proof/webapps/test_search.py`; `proof/rules/search_title_empty.py` and `proof/rules/test_search_title_empty.py` (deleted), `proof/rules/__init__.py` (its import and `RULES` line), `proof/rules/conftest.py`. CLAUDE.md: `lib/commcare/CLAUDE.md`. Domain, doc and mutations, validator, builder, SA and MCP tools, docs: none.

**Stored shape and migration.** None. No notice.

**Register.** 3 entries move to the fixed register, each keeping its `equivalence` mark: `d54-search-description-app-description` and `-suite-remote-request` (proof4, control `case-operation-query`), `-suite-entry` (proof4, control `case-list-inline`).

**Spelling rule.** `proof/rules/search_title_empty.py` retires with its test and its `RULES` line. `proof/rules/conftest.py::DOCUMENTS` loses `search-browse`, which only that test reads.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` and `case-list-inline` keep showing the three.

**Nova tests.** Pure, emission: both maps hold every wire code of a two-language app, blank where nothing is authored and the authored text otherwise; the local suite writes `<description>` and a non-breaking-space locale value on a remote request and on an inline query. These prove Nova's own code.

**Lane.** Locally: `case-list-browse`, `case-list-inline`, `search-browse`.
- Proof 4 on every document holds the save: the Case List save changes neither map. The lane passes with the rule gone.
- `proof/native/test_search_emission.py` holds the element on both paths, child for child, and reads the description Core presents for a search with and without a subtitle.
- `proof/formplayer/test_search.py` now expects the non-breaking space from HQ's build of Nova's export as from the saved app, and `proof/formplayer/test_local_archive.py` gains the same reading of the local archive.
- `proof/webapps/test_search.py` keeps holding what a worker sees: no description for either, on its three kinds of search.

## 14. Finding 50: reclassified as what HQ does itself

**Today.** A follow-up form that opens one child case outside a repeat draws Vellum's "This registration form is missing a case name." alert on every save, on `nested-menu-previous`, and the register holds it as two proof 4 entries.

**Fix.** No emission changes. The alert is what HQ does to a form its own editors make, so the lane stops calling it a difference, by one closed and proven allowance that part 09, Finding 50: the registration alert on a follow-up form, specifies. The allowance and the removal of the two entries land in pull request 1.

*Why it is HQ's own.* HQ counts a form with exactly one registration action a registration form, and counts a child case outside a repeat as one (`models/forms.py::Form.get_registration_actions`, `Form.is_registration_form`). It maps a case name only from the form's own `open_case` (`form_action_diff.py::get_case_mappings`). The two disagree for exactly this shape, the form builder is told the form is a registration form (`views/formdesigner.py::_get_vellum_core_context`), and Vellum alerts when a registration form has no name mapping (Vellum `src/caseManagement.js`, its pre-save validation). Executed during planning, on the follow-up form of HQ's own test app (`corehq/apps/app_manager/tests/data/suite/app.json`), cleared of its own writes: with no child case Vellum's save shows no alert; given one child case outside a repeat and saved by HQ's Case Management page, HQ counts it a registration form and each of two Vellum saves shows "This registration form is missing a case name." The save goes through both times and nothing HQ stores changes.

*Why no emission fix.* Two spellings avoid the shape, and neither is taken. Moving the child's create to a Save to Case block needs `save_to_case`, moves its submissions and is step 5's placement question. A name mapping on the inactive `open_case` states something false of the form: that a question saves the form's own case name.

*The allowance, its proof and its record.* Part 09, Finding 50: the registration alert on a follow-up form, owns all of it: the one allowance module and its closed list, its test, the condition under which it applies, the `proof/README.md` and `proof/CLAUDE.md` text, the `harness-findings.md` move, the removal of the two entries and the lane run. This part defines none of them, so there is one module path, one test path and one condition, and they are that block's. What this part contributes is the reason above and one fact that block's condition must be no wider than: HQ's two functions disagree exactly when the stored form's `open_case` is not active and exactly one of its subcases has no `repeat_context`.

**Files.** None in this part: no domain, doc and mutations, validator, emitter, Preview, builder, SA and MCP tool, docs or CLAUDE.md file changes for finding 50 outside that block of part 09.

**Stored shape and migration.** None. No notice.

**Register.** Pull request 1 removes the two entries (part 09, the same block), which are **removed, not moved**: `d50-registration-alert-vellum-pre-save-alerts-registration-form-missing` (`editor:vellum@*`) and `d50-registration-alert-vellum-again-pre-save-alerts-registration-form-missing` (`editor:vellum again@*`), both proof4. They cannot be fixed entries: once the judge stops reporting the class, their control stops showing it.

**Spelling rule.** None retires.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `proof/controls/nested-menu-previous` is named by these two entries alone, so pull request 1 deletes it with them. The corpus document `nested-menu-previous` stays and passes proof 4 with no entry.

**Nova tests.** None in this part: the allowance's tests are part 09's.

**Lane.** Pull request 1, with no emitter change; part 09, in the same block, gives its local run and what CI must show.

## 15. Finding 58: a link to a target its menu hides

**Today.** HQ builds an after-submit link as a stack frame that names the target's commands (`suite_xml/post_process/workflow.py`), and what a runtime does with a command its menu screen leaves out is the runtime's own. Core's session takes the frame as it stands: for a hidden form it needs nothing more and the form opens (`CommCareSession.getNeededData`), and for a hidden menu it asks for a command inside it. Formplayer rebuilds the session by walking the frame through the screens it would show (formplayer `services/MenuSessionFactory.java::rebuildSessionFromFrame`, which matches a step only against `MenuScreen.getMenuDisplayables`), so it answers with the menu that holds a hidden form, listing its shown forms alone, and with the app's first screen for a hidden menu. Nova admits such a link: today it refuses only a display condition no worker could meet (`DISPLAY_CONDITION_ALWAYS_FALSE`), and a link's target may be hidden by a condition false for the worker who submits. Observed on `targeted-form-link-hidden-target`, whose three forms each link with no condition to a form shown in another menu, a form whose display condition is false for the lane's worker, and a menu whose condition is false for that worker:

| Fact | Observed by |
|---|---|
| Formplayer: the link to a shown form opens it; to a hidden form, the menu that holds it, listing its shown form alone; to a hidden menu, the app's first screen. Core's session opens the hidden form, and asks for a command of the hidden menu | `proof/formplayer/test_end_of_form.py::test_a_link_to_a_shown_form_opens_it_and_a_hidden_target_stops_formplayer_where_core_goes_on` |
| The Web Apps client, the form opened and submitted by clicks: the same three screens, and HQ receives one submission each time and the client shows HQ's message for it | `proof/webapps/test_links.py::test_web_apps_follows_a_link_to_a_shown_form_and_stops_before_a_hidden_target` |
| Android's own home activity, handed the completed form: it opens the hidden form, and for the hidden menu a menu screen that lists nothing | the run behind block 11's table (rows 2 and 4), made during planning through the Android reader's `nav` request |

So a target hidden from a worker behaves per platform, whatever hides it: Android opens a hidden form and Web Apps does not, and neither opens anything useful for a hidden menu. *Harm:* none found in Web Apps, where the worker lands on a screen they may use; on Android a worker reaches a form its menu hides from them, and a hidden menu shows them an empty screen.

**Fix.** The design of block 11, which was settled from these runs: what each runtime does decides what Nova admits and what it says.

- A target that is off the menu for every worker is the flag `hiddenFromMenu`. A link to a menu that is off the menu is refused (`HIDDEN_MENU_NOT_A_DESTINATION`, block 11), because it fails on both runtimes; a link to a form that is off the menu is admitted, because it opens on Android, and every surface says it does not open in Web Apps (block 11's builder copy, SA and MCP descriptions, docs).
- A target hidden by a display condition that some worker can meet is an ordinary condition and stays admitted: Nova cannot know which worker submits. What the worker for whom the condition is false meets is the same as for an item off the menu, so the link editor says it where a person makes the link. `components/builder/form-links/afterSubmitCopy.ts` gains one line, shown under a link whose target form or menu has a display condition: for a form, "When this form's display condition is false for a worker, Android still opens it after submit, and Web Apps opens the menu that holds it instead."; for a menu, "When this menu's display condition is false for a worker, Android opens it with nothing in it, and Web Apps opens the app's first screen instead." The `add_form_links` and `update_form_link` descriptions carry the same two sentences.
- Preview keeps Android's behavior for links until step 4 (block 11, Preview), and opens such a target.
- `content/docs/form-links.mdx` states the per-platform behavior for a target hidden by a condition, beside block 11's rows for one off the menu.

**Files.**
- Builder: `components/builder/form-links/afterSubmitCopy.ts`, and the link editor that shows it (`components/builder/form-links/`).
- SA and MCP tools: `lib/agent/tools/form-links/addFormLinks.ts`, `updateFormLink.ts` (descriptions). A description change in pull request 12, which already bumps `MODEL_CONTEXT_VERSION` (part 11, The model-addition checklist, item 13, row 12, gains the two link tools); the stack's one billed check names them.
- Docs: `content/docs/form-links.mdx`.
- Domain, doc and mutations, validator, emitters, Preview: block 11's, nothing more.

**Stored shape and migration.** None beyond block 11's. No notice: no stored link changes meaning.

**Register.** None. The lane's branch holds this finding in its reader tests and in no register entry: it is a difference between Formplayer and Core's session on one HQ build, which no served-state check compares, so the three tests above are its proof.

**Spelling rule.** None. **Identity.** None. `proof/identity-moves.json` gains no entry. **Control.** None.

**Nova tests.** Pure, state model: the link editor's line shows for a target with a display condition and for none without one, with the form and the menu wording; the two tool descriptions hold the same sentences as `afterSubmitCopy.ts`.

**Lane.** The three tests above keep running over `targeted-form-link-hidden-target` unchanged, since its targets are hidden by conditions false for the lane's worker, which stay admitted. `proof/android/navigation.py`, which block 3 adds with the `nav` request, gains the document: Android opens the hidden form and shows the hidden menu's empty screen. Block 11's `targeted-hidden-from-menu` holds the same rows for items off the menu. Locally `npm run proof -- proof/formplayer/test_end_of_form.py proof/webapps/test_links.py` and `python3 -m unittest proof.android.navigation`. Pull request 12.

## Order and shared files

- Blocks 1, 2 and the `external_id` row share `lib/commcare/xform/caseBlocks.ts` and `lib/commcare/formActions.ts` with findings 33 and 37, and block 2 needs `nova_operations`, the `nova_condition_` groups and `planGeneratedNodes` from part 05 (part 05, Reserved names and wrapper containers (defect 13); Wrapper conditions (defect 13); The one allocator), which pull request 7 lands. They land together in pull request 9, after it.
- Findings 41 and 54 edit `lib/commcare/hqJson/caseList.ts` beside part 07 and land with it in pull request 11.
- Blocks 3 to 7, the rest of block 10 and block 11 land in pull request 12. These blocks change tool schemas (3, 4, 5 and 11) and descriptions inside them (6; block 2's is in pull request 9). The one billed check for the stack is asked for at the head of pull request 14 (part 11, The stack, in its list of what every pull request of the stack does), which names each of them, and nothing is run in pull request 9 or pull request 12.
- Blocks 3 and 11 share `lib/domain/postSubmit.ts`, the reducer in `lib/doc/mutations/modules.ts` and the Android reader's `nav` request, and land together in pull request 12. Block 15 rides the same pull request: its copy states block 11's table for targets hidden by a condition.
- Block 6 is the second of three edits to `targeted-search-hq-compile`; it keeps the document and its follow-up form, which defects 6 and 48 still need.
- Cutover steps from this part, as part 10, The transform steps, in order, registers them: `search-button-label`, `reserved-search-inputs`, `hidden-from-menu`, `post-submit`, in that relative order, with `time-ordering` (pull request 14) placed before `hidden-from-menu`. Reasons their steps return: `search-button-text-changed`, `search-input-removed`, `search-input-renamed`, `hidden-from-menu-set`, `after-submit-destination-moved`. One blocker the scan reports: `hidden-menu-is-a-destination` (block 11).
- Changes that write nothing, as `behavior.ts` selection rules with no step (part 10, Changes that write nothing and still get a line): `follow-up-now-touches-case` and `close-moves-to-save-to-case` (pull request 9), `lookup-choices-order-changes` and `survey-menu-takes-case-type` (pull request 12).
