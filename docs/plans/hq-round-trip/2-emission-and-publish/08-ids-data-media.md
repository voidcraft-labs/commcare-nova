# Step 2, part 08: Work items D and E: identifiers, form content, lookup tags, CSQL, media and the model clean-up (defects 6, 11, 15, 16; findings 31, 43, 44, 48, 56, 60, 61, 62)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part plans two pull requests of the stack and three targeted documents of a third:

| Pull request | What this part plans in it |
|---|---|
| 1, lane mechanics | Finding 56's targeted document, entries and control; finding 43's `parsererror` document, entries and control; finding 62's document, entries and control |
| 10, identifiers and form content | Defect 15, findings 31, 43, 44, 60, 61, 62 |
| 14, lookup, CSQL, media and the model clean-up | Defect 6, finding 48, defect 11 (first half), defect 16 (all but hidden columns), the Hidden Value with neither a calculate nor a default |

Defect 5 (lookup tags and table content) lands in pull request 14 too and is planned in part 02, Defect 5: the lookup push, beside the drift check whose table baselines its refusals read. Defect 16's hidden columns are planned in part 07, Hidden columns: defect 16's column half, findings 35 and 36.

Findings 60 and 61 are what Connect's receiver showed once it ran over Nova's submissions. Finding 62 was found while this part was planned, by running the block that used to say Vellum's warning-only names were outside step 2.

## What every block below shares

- **What was run.** Every fact below about a reader was observed by running that reader at the pins: HQ's build, its pages, Vellum and Core in the lane (`npm run proof`); Connect's receiver (`proof/connect`); Formplayer (`proof/formplayer`) and HQ's Web Apps client over it (`proof/webapps`); commcare-android under Robolectric (`proof/android`); and, for media decoding, three Android emulator images and Chrome. "Executed during planning" means the run used a document built by Nova's own planners and admitted by its gate, or a planned spelling written by hand into a fork of a retained control. None of those documents is committed. Each block names the lane check or reader test that keeps its proof running once its pull request lands.
- **Where a narrowing lives.** Every rule this part adds lives in the validator (`lib/commcare/validator`) and in the verdicts the builder and the tools call before dispatch (`lib/doc/identifierVerdicts.ts`). No persisted Zod schema narrows. Reasons: a persisted schema states what the store can hold, and a pattern added there makes a stored document unreadable before the cutover's transform reaches it; the validator names the rule that failed and offers the replacement id; and one predicate in `lib/domain` then serves the validator, the builder, the tools and the migration. The two exceptions are schema removals (the three media slots) and the tool input schemas named in each block.
- **The cutover.** Each stored-shape change is one step of the cutover's pure transform (`scripts/lib/hqRoundTripCutover/steps/`), registered in `transform.ts` in the same pull request as the fix, with its notice reason added to `DOCUMENT_NOTICE_REASONS` (`lib/notices/migrationNotice.ts`) and its renderer to `lib/notices/migrationNoticeCopy.ts`. The one registry of step ids and notice reasons is part 10, The transform steps, in order, and this part uses its names verbatim; a pull request inserts its step at its registered position, never at the end. The steps of this part run in this registered order, after the identity additions: `media-slots`, `hidden-inert-default` (removals); `question-ids`, `case-operation-ids`, `connect-ids`, `entry-point-ids`, `option-values` (renames); `empty-forms`; then `time-ordering`, which runs before the `hidden-from-menu` step of part 06, 11. `hiddenFromMenu`: a menu or form that is not on the menu. Their modules are `steps/mediaSlots.ts`, `steps/hiddenInertDefault.ts`, `steps/questionIds.ts`, `steps/caseOperationIds.ts`, `steps/connectIds.ts`, `steps/entryPointIds.ts`, `steps/optionValues.ts`, `steps/emptyForms.ts` and `steps/timeOrdering.ts`. The three id steps share one relative-path rewrite module. The scan (`scripts/scan-hq-round-trip-cutover.ts`) reports each step's count per app, and the three scan-blocking cases of defect 15 and finding 43 stop the cutover before its first write.
- **How a notice names an entity.** Each step records the entity's uuid. The notice writer resolves the form's and the field's displayed name and the field's kind from the final document after every step has run, so a removal notice written before a rename names the id the builder shows afterwards. The rename notices alone carry `from`.
- **Registers.** A fix moves its entries from `proof/known-defects.json` to `proof/fixed-defects.json` in its own pull request, each keeping its id and its `control`, and each must still show on that control. The control directories named below are never re-retained.
- **Identity.** `proof/identity-moves.json` gains no entry from this part. Proof 1 compares two exports of one document made by one revision, so a migration or an emitter change moves both sides alike and no listed move could ever be matched. Each one-time change is listed in its block, written into the migration notice, and held by the cutover's tests over the frozen pre-step fixtures (`scripts/lib/hqRoundTripCutover/__tests__/fixtures/pre-step/`).
- **Nova tests.** Each block's "Nova tests" are tests of Nova's own functions, state model and Postgres writes. They prove what Nova computes and stores. No statement about HQ, Vellum, Core, Formplayer, Web Apps, Android or Connect rests on one: those are in each block's "Lane".
- **Lane.** "Locally" means `npm run proof -- proof/checks -k <document id>` and `-k control-<name>` for the documents and controls a block names, `npm run proof -- proof/native -k <family>` where a native family changes, and `npm run proof -- proof/<reader>` for a reader package a block names. Each pull request also runs the corpus emission first (no Docker), diffs `index.json`'s document ids before and after, and rewrites or removes every document a narrowing refuses. CI's full lane must be green at the pull request's own head with both registers as the block states them.
- **Paid check.** A block that changes a tool input schema or a tool description says so. The implementer asks the person before running `npm run test:schema`, which bills one live request per schema.
- **Model context.** Pull requests 10 and 14 each change the tool catalog (the entry-point id input and the id descriptions in 10, `attach_field_media`'s slots in 14), so each bumps `lib/models.ts::MODEL_CONTEXT_VERSION`, as every pull request of the stack that changes the catalog does. Part 11, The model-addition checklist, item 13, is the one list of them and of the value each sets.
- **The sibling plugin.** A `../nova-plugin` sweep that finds a claim records it for that repository's own pull request (part 11, House rules for the stack, rule 11), which merges after the deploy. Nothing in `../nova-plugin` changes in pull requests 10 or 14.
- **Routes.** No block here adds an `/api` route. A new one would need its allowlist entry in `lib/hostnames.ts`.

---

## Defect 15: identifiers HQ's editors refuse

**Today.** Nova admits ids HQ's editors refuse. A question id is `lib/commcare/constants.ts::XML_ELEMENT_NAME_REGEX` (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`), applied by `lib/commcare/validator/rules/field.ts::invalidFieldId` and `lib/doc/identifierVerdicts.ts::formatVerdict`, and no rule refuses `meta`. A Connect block id is `lib/domain/forms.ts::connectIdSchema` (the same pattern, 1 to 50 characters), and `lib/commcare/connectSlugs.ts::deriveConnectId` mints through `lib/commcare/identifierValidation.ts::toSnakeId`, which turns `1st visit` into `_1st_visit`, so Nova itself mints an id Vellum refuses. An entry-point id is `lib/domain/entryPoints.ts::entryPointIdSchema` (`/^[a-z0-9_-]+$/`). A case operation id and a link identifier are `lib/domain/caseOperationIdentifiers.ts::CASE_OPERATION_IDENTIFIER_REGEX` (`/^[A-Za-z_][A-Za-z0-9_]*$/`).

What each reader does, and the run that showed it:

| Fact | Observed by |
|---|---|
| Vellum reports an error on a question id that does not match `/^(?!XML)[a-zA-Z][\w-]*$/` (the `XML` test is case-sensitive) and on `meta` in any case (Vellum `src/util.js::isValidElementName`; `src/mugs/baseSpecs.js`, `databind.nodeID.validationFunc`). Questions, groups, repeats, Hidden Values and Connect blocks carry it | The lane's proof 4 entries below, on `targeted-invalid-question-ids`; the same class shows on `targeted-invalid-connect-ids`, where Vellum names the assessment's wrapper ("XMLquiz is not a valid Question ID", a `ConnectAssessment` question) |
| A Save to Case block does not carry it. Vellum opens and saves a block whose wrapper is named `_link_patient`, `XMLlink` or `meta`, and an index named `_related`, `XMLrel` or `meta`, keeps each name in what it stores, and reports no message on the block | Executed during planning: each name written by hand into the form of `case-operation-link` in a fork, opened and saved in Vellum; Vellum made a `SaveToCase` question at each path with no message, and HQ's `validate_app` reported nothing |
| HQ's build removes a root data node named `meta` or `Meta`, a question or a group, after which Core cannot install the form (`xform.py::XForm.already_has_meta`) | The lane's `d15-question-ids-admission-unresolved-resource` for a question. Executed during planning for a root group named `meta` that holds one question: Core refuses HQ's build ("Question bound to non-existent node: [/data/meta/inner]"), HQ's form settings page warns of a meta block, and Vellum reports "'meta' is not a valid Question ID." on the group |
| An endpoint id must equal `slugify(id)`, or the save answers 400 (`views/utils.py::get_cleaned_session_endpoint_id`, reached from `set_session_endpoint` and `set_case_list_session_endpoint`) | The lane's three `d15-entry-point-ids-editor-*` entries. Executed during planning: HQ's function and Django's `slugify`, over every id of one to seven characters drawn from `a`, `9`, `_` and `-`, accept exactly the ids the pattern below matches |
| Connect keys a learn module, a deliver unit and a task type by the block's `@id` (commcare-connect `form_receiver/processor.py::get_or_create_learn_module`, `get_or_create_deliver_unit`, `process_task_modules`). After a rename: every delivery under the renamed deliver unit is refused with "Payment unit is not configured for the deliver unit" until a manager adds the new unit to a payment unit; the renamed learn module becomes a second module beside the old one, so a learner who completes the course after the rename stands at 50 percent and is never finished, while one who finished before stays finished; a task assigned before the rename is never completed by the form, and each of that worker's deliveries is rejected for the pending task | `proof/connect/test_receiver.py::test_a_renamed_deliver_unit_is_refused_until_a_manager_pays_for_it`, `::test_a_renamed_learn_module_leaves_learning_unfinished`, `::test_a_renamed_task_never_completes_the_task_a_worker_was_assigned`, each over Nova's own publish and local archive of the rename edit |
| Connect takes a learn module id and a task id of 50 characters | Executed during planning: a learn module and a task, each with a 50-character id that starts `q` and a digit, received by Connect's receiver; the module completed and the task completed |

**Fix.** One grammar in the domain, read by every surface.

New `lib/domain/questionId.ts`:

- `QUESTION_ID_PATTERN = /^(?!XML)[A-Za-z][A-Za-z0-9_]*$/`. Nova keeps refusing a hyphen, which Vellum accepts, because `XML_ELEMENT_NAME_REGEX` never admitted one.
- `RESERVED_QUESTION_IDS`: `meta`, `case`, `registration` and `script` compared lowercased (finding 62 for the last three), and the exact names `instance`, `bind`, `parsererror` (finding 43).
- `RESERVED_CONNECT_BLOCK_IDS`: the exact names `assessment`, `deliver`, `module`, `task`, `work_area_update` (finding 60).
- `questionIdProblem(id, alsoReserved?)`: `"leading-underscore" | "not-letter-first" | "xml-prefix" | "reserved-name" | "characters" | undefined`.
- `editorSafeQuestionId(id, alsoReserved?)`, the one normalizer the migration and every minter use: (1) drop leading underscores; (2) prepend `q` when what remains is empty, does not start with a letter, or starts with `XML`; (3) prepend `q_` when the result is a reserved name. So `_notes` becomes `notes`, `_1st` becomes `q1st`, `XMLcode` becomes `qXMLcode`, `Meta` becomes `q_Meta`, `case` becomes `q_case`, and, with the Connect names, `task` becomes `q_task`. The caller settles a collision with `lib/domain/idSlug.ts::suffixUntilFree` (`_2`, `_3`), the policy Nova already uses for ids it mints. (Generated node names count from `_1`; that is the allocator's rule, not this one.)

| Id kind | Rule from step 2 | Where it is applied |
|---|---|---|
| Question id | `QUESTION_ID_PATTERN`, not in `RESERVED_QUESTION_IDS` | `validator/rules/field.ts::invalidFieldId` (code `INVALID_FIELD_ID`, message by `questionIdProblem`); `lib/doc/identifierVerdicts.ts::formatVerdict`, so the builder's rename field, `add_fields` and `edit_field` refuse before dispatch |
| Connect block id | the question rule, not in `RESERVED_CONNECT_BLOCK_IDS`, 1 to 50 characters | `lib/commcare/connectSlugs.ts::connectIdError` (code `CONNECT_ID_INVALID_FORMAT` in `validator/rules/form.ts`); `deriveConnectId` mints through `editorSafeQuestionId(id, RESERVED_CONNECT_BLOCK_IDS)`, and `toSnakeId`'s digit arm, the source of the underscore, is replaced by it |
| Entry-point id | `/^(?!.*--)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/`: exactly the ids among Nova's admitted ones that `slugify` leaves unchanged (starts and ends with a letter or digit, no doubled hyphen) | `validator/rules/app.ts::validEntryPoints` (code `ENTRY_POINT_INVALID`); exported from `lib/domain/entryPoints.ts` as `entryPointIdProblem` |
| Case operation id | unchanged (`CASE_OPERATION_IDENTIFIER_REGEX`), and not `instance`, `bind` or `parsererror` | finding 43 |
| Link identifier | unchanged (the same regex), and not `instance`, `bind` or `parsererror` | finding 43 |

Case operation ids and link identifiers keep their grammar. The outline put both under the question rule on the reading that Vellum refuses a Save to Case wrapper as it refuses a question. Vellum does not (the second row of the table above), HQ's build and `validate_app` take them, and the lane's Core installs forms whose wrappers begin with an underscore on every case-operation document today. So no id of either kind is renamed for an underscore, an `XML` prefix or `meta`, and the cutover's `link-identifier-reserved` blocker covers the three names of finding 43 alone.

`XML_ELEMENT_NAME_REGEX` itself is unchanged: `FormPath`, search input names, relation identifiers and tile grouping identifiers use it and are not question ids.

Messages name the actual problem and offer the replacement, for example: "A question ID can't start with an underscore, because CommCare HQ's form builder can't keep it. `notes` is free here.", "`meta` is a name CommCare keeps for the form's own details. `q_meta` is free here." and "`task` is a name CommCare Connect keeps for itself, and it can't receive a form whose block is called that. `q_task` is free here."

**Files.**
- Domain: `lib/domain/questionId.ts` (new); `lib/domain/entryPoints.ts` (`entryPointIdProblem`; `entryPointIdSchema` unchanged).
- Doc and mutations: `lib/doc/identifierVerdicts.ts`; `lib/doc/userFacingErrors.ts` (`INVALID_FIELD_ID`, `CONNECT_ID_INVALID_FORMAT`, the entry-point message).
- Validator: `lib/commcare/validator/rules/field.ts`, `rules/form.ts`, `rules/app.ts`; `lib/commcare/connectSlugs.ts`; `lib/commcare/identifierValidation.ts`.
- Emitters: none.
- Preview: none (Preview runs the document).
- Builder: `components/builder/detail/formSettings/LearnConfig.tsx`, `DeliverConfig.tsx`, `components/builder/detail/appSettings/connectDraft.ts`, `components/builder/app-setup/DeepLinksSection.tsx` (each calls the same predicate).
- SA and MCP tools: `lib/agent/tools/shared/connectIds.ts` (`CONNECT_ID_FIELD_DESCRIPTION` names the five names); `lib/agent/tools/entry-points.ts` (the new test is a `.refine` plus the description, and the `pattern` stays, so the provider's strict schema gains no lookahead). Both are tool-schema changes: ask before `npm run test:schema`. The question id description in `lib/agent/toolSchemaGenerator.ts` already says "starting with a letter" and carries no `pattern`; it gains the reserved names. Sweep `../nova-plugin` for "letter or underscore".
- Docs: `content/docs/mcp/tools.mdx` (the entry-point sentence), `content/docs/deep-links.mdx`, the Connect page's id sentence.
- CLAUDE.md: `lib/domain/CLAUDE.md` (the one question-id grammar), `lib/doc/CLAUDE.md` (verdicts).
- Fixtures: the Connect fixtures behind `connect-deliver-default` and `connect-deliver-custom` name their task `follow_up` (finding 60).

**Stored shape and migration.** No schema change. Steps `question-ids` (`steps/questionIds.ts`), `case-operation-ids` (`steps/caseOperationIds.ts`) and `connect-ids` (`steps/connectIds.ts`), in that order and sharing one relative-path rewrite module, then step `entry-point-ids`:

1. Per scope, valid ids are taken first. Each failing id is normalized and suffixed until free: a question, group or repeat among its siblings; a case operation within its form (finding 43's three names only); a Connect id app-wide, cut at the tail so the id with its suffix fits 50 characters; an entry-point id app-wide after stripping leading and trailing `-` and `_` and collapsing each run of hyphens to one, `entry` when nothing survives. A Connect id of an underscore and a digit (`_1st_visit`) becomes `q1st_visit`, the same length, so a 50-character id stays inside the limit and only a collision's suffix cuts the tail.
2. The rename writes the entity's `id`. Identity leaves (`field-ref`, `path-ref`, prose reference atoms) follow by construction: they store the uuid and print the current name. A renamed group or repeat moves the data path of every question inside it.
3. Relative paths in text runs are rewritten through Nova's XPath grammar, never by pattern, by the module the three id steps share. For every XPath slot the registry lists (`lib/domain/referenceSlots.ts::fieldReferenceSlotsFor`, `FORM_REFERENCE_SLOTS`), the step prints the expression with the pre-rename names, parses it with `lib/commcare/xpath/parser.ts`, and takes each name step that no leaf span covers and no `instance()` path owns (the reading `lib/commcare/xpath/expressionAst.ts::collectLeafSpans` and `hasExplicitPathContext` give). A relative path (a chain of `..`, `.` and name steps at the expression's own context, or rooted at `current()`) is resolved step by step against the form tree from the carrier question. Where a step resolves to a renamed question, group or repeat, that step's characters are rewritten inside its text part. Leaves are untouched.
4. A name step equal to an old id that does not resolve this way is left alone and reported.

Scan-blocking (the cutover stops for a person):

| Case, with its blocker code | Why it is not migrated | What the person does |
|---|---|---|
| A link identifier that is `instance`, `bind` or `parsererror` (`link-identifier-reserved`) | It is the index name on cases already in HQ and in Nova's case store. A rename would orphan the old index on existing cases | Before the window, the app's owner accepts that cases already linked keep the old index name, renames the connection in the builder (the rules before the cutover admit both names), and the scan is run again |
| An unresolved name step equal to an old id, item 4 (`unresolved-relative-path`) | Which node it meant is a person's call. The agent authoring boundary refuses such paths, but the builder's expression editor admits them | Before the window, a person edits the expression in the builder to a reference chip or to the path that was meant, and the scan is run again |
| A case property named `instance`, `bind` or `parsererror` written by a block in a form's source (`reserved-property-write`) | Finding 43, below | Before the window, a person moves the write to another property name in the builder, and the scan is run again |

For each case the scan's report gives the blocker code, the count and the app ids; the form, the entity and the old value are that report's detail, printed for one app under `--debug-details` (part 10, Scripts and their layout, under "The report"). The cutover has no override: it runs only when the scan reports none. All three are decided, for the reasons in the table: a rename of any of them would change the identity of data that already exists, or would guess at what a person meant. Part 10, The cutover and work item F (the migration notice), registers the three blocker codes.

Notice reasons, as part 10 registers them, each naming the form and the entity with `from` and `to`. `question-renamed` takes its noun from the field's kind (question, group or repeat), and `connect-block-renamed` names the block kind and takes the template of that kind:

| Reason | What the notice says |
|---|---|
| `question-renamed`, a question | "`<form>`: the question `<from>` is now `<to>`, because CommCare HQ's form builder can't keep the old ID. Submissions use the new name from your next publish. In CommCare HQ, a form export column or report that reads `<from>` stops filling and a new `<to>` column starts." |
| `question-renamed`, a group or repeat | "`<form>`: the group `<from>` is now `<to>`, because CommCare HQ's form builder can't keep the old ID. Every question inside it moves with it, so submissions use the new paths from your next publish. In CommCare HQ, a form export column or report that reads a question under `<from>` stops filling and a new column starts." (with "repeat" for a repeat) |
| `case-operation-renamed` | "`<form>`: the case change `<from>` is now `<to>`. Its place in each submission moves with the name from your next publish." |
| `connect-block-renamed`, a deliver unit | "`<form>`: the deliver unit `<from>` is now `<to>`. CommCare Connect reads it as a new deliver unit and turns away each delivery until an opportunity manager adds `<to>` to a payment unit." |
| `connect-block-renamed`, a learn module | "`<form>`: the learn module `<from>` is now `<to>`. CommCare Connect reads it as a second module and keeps the old one, so a learner who had not finished the course before this stays short of finished. A learner who had finished stays finished." |
| `connect-block-renamed`, a task | "`<form>`: the task `<from>` is now `<to>`. CommCare Connect reads it as a new task type. A task assigned under `<from>` is never completed by this form, and CommCare Connect rejects that worker's deliveries while it stays assigned." |
| `connect-block-renamed`, an assessment | "`<form>`: the assessment `<from>` is now `<to>`. CommCare Connect keeps no record under an assessment's ID, so scoring is unchanged." |
| `connect-block-renamed`, from one of finding 60's five names | The kind's template, with this sentence first: "CommCare Connect could not receive this form while its block was called `<from>`." |
| `entry-point-renamed` | "The deep link `<from>` is now `<to>`. Links shared with the old ID stop working after your next publish." |

**Register.** 12 entries, all on document and control `targeted-invalid-question-ids`:

| Check | Count | Ids |
|---|---|---|
| bar | 1 | `d15-question-ids-admission-unresolved-resource` |
| manifest | 3 | `d15-question-ids-form-instance-invalid-question-id-9f9c`, `d15-ids-form-instance-authored-meta`, `d15-ids-app-not-a-slug-or-duplicated` |
| proof4 | 8 | `d15-question-ids-vellum-mug-nodeid-error-not-valid-question-*` (2), `d15-question-ids-vellum-again-mug-nodeid-error-not-valid-question-*` (2), `d15-question-ids-editor-view-form-form-meta-block`, `d15-entry-point-ids-editor-*` (3) |

**Spelling rule.** None retires.

**Identity.** Once per deployed app, at its next publish: the data path of each renamed question, of every question inside a renamed group or repeat, and of each renamed Connect block; each renamed session endpoint id; each Connect block id. A staged, unsubmitted capture on a renamed question is orphaned until its seven-day expiry. No entry in `proof/identity-moves.json`.

**Control.** `targeted-invalid-question-ids` keeps the pre-fix bytes and keeps showing all 12 classes under the bar, manifest and proof 4.

**Nova tests.**
- Pure (`lib/domain/__tests__/questionId.test.ts`): `questionIdProblem` and `editorSafeQuestionId`, each refusal beside an accepted neighbor (`xmlcode` accepted, `XMLcode` refused; `metadata` accepted, `Meta` refused; `cases` accepted, `Case` refused), and the Connect names refused only when passed.
- Pure: `deriveConnectId("1st visit", ...)` is letter-first and within 50 characters with a suffix; `deriveConnectId("Task", ...)` is `q_task`.
- Pure (validator): each id kind refused and accepted through `runValidation`; the builder verdicts return the same verdict as the validator for the same id; a case operation `_close` and a link identifier `_parent` stay accepted.
- Pure (the steps): the `question-ids`, `case-operation-ids`, `connect-ids` and `entry-point-ids` steps over a frozen pre-step fixture holding `_notes`, `XMLcode`, `Meta`, a root group `meta` with a question a calculate reads by `#form` reference, a colliding sibling, `../_notes` in a calculate, a `current()/../_notes` default, Connect blocks `_lesson`, `_1st_visit` at 50 characters and `task`, an operation `instance`, an operation `_close` that must come out unchanged, and an entry point `intake_`; and one fixture for each blocking case.
- Real Postgres (`scripts/lib/hqRoundTripCutover/__tests__/writer.postgres.test.ts`): that fixture app comes out gate-clean with the ids above, the relative paths rewritten, the horizon baseline written and the notice rows present.

**Lane.**
- Locally: `targeted-invalid-question-ids` and `targeted-invalid-connect-ids`, both rewritten in place as the migrated shape (the second stays a Connect app), plus `control-targeted-invalid-question-ids`. Executed during planning, the migrated shape passes every check under the `minimum` and `maximum` configurations with nothing reported that a fix in this part removes: a document holding `notes`, `q1st`, `qXMLcode`, `q_Meta`, a root group `q_meta` whose question a calculate reads, `q_instance`, `q_bind`, `q_parsererror`, a calculate and a display condition holding `false()`, and the entry points `intake` and `intake-2_b` (Vellum's two saves and the form settings save report nothing on its ids, and Core installs HQ's build); and a learn app whose module id is 50 characters and whose assessment is `qXMLquiz`.
- New lane test `proof/hq/test_endpoint_ids.py`, with `proof/hq/entryPointIdVerdicts.ts` beside it (as `publishCaptureDocuments.ts` sits beside its test): the script prints Nova's `entryPointIdProblem` for every id of one to seven characters over `a`, `9`, `_`, `-`, and the test holds each verdict to HQ's own `get_cleaned_session_endpoint_id`. This is the proof that Nova's pattern is HQ's rule; no Nova test transcribes `slugify`.
- `proof/connect`: the three rename tests above keep running over `targeted-connect-deliver-rename` and `targeted-connect-learn-rename`, whose ids the grammar admits before and after.
- CI: the full lane with 12 entries fewer in the live register and 12 more in the fixed one.

## Finding 60: a Connect block named like one of Connect's own keys

**Today.** Nova names a Connect block's wrapper node by the block's id. Connect's receiver looks through a submission at every depth for `module` and `assessment` in a learn app's form, and for `deliver`, `task` and `work_area_update` in a deliver app's, and reads each match's namespace (commcare-connect `form_receiver/processor.py::_get_matching_blocks`). A wrapper so named has none: the receiver raises `KeyError('@xmlns')`, answers 500 and rolls the whole submission back, on every submission of that form, from HQ's build and from the local archive alike. Run for all five names (`proof/connect/test_receiver.py::test_a_task_named_task_fails_connects_receiver_on_every_submission`, `::test_every_other_name_connects_receiver_looks_for_fails_it_too`). The fixtures behind `connect-deliver-default` and `connect-deliver-custom` name their task `task`, so every delivery from those two apps fails in Connect.

What bounds the rule, each executed during planning through HQ's own payload and Connect's receiver:

- HQ forwards Connect blocks and the nodes above them, and nothing else of the form (`corehq/motech/repeaters/repeater_generators.py::ConnectFormRepeaterPayloadGenerator.get_payload`). A deliver form holding ordinary questions named `task`, `deliver`, `work_area_update`, `module` and `assessment` beside a deliver unit `home_visit` forwards the one key `home_visit`, and its visit is approved. So a question id is never refused for these names.
- The match is exact and case-sensitive: a learn app's block named `Module` is received and scored, and a deliver unit named `Task`, once paid for, has its visit approved.
- Each app type fails only on its own names: a learn app's block named `task` or `deliver` is received and scored, and a deliver unit named `module` or `assessment` is approved. All five are refused in both all the same, so one list serves every Connect app.
- The replacements are received: deliver units `q_deliver` and `q_work_area_update` are approved, a task `q_task` is completed, and a learn module `q_module` with an assessment `q_assessment` is completed and scored.

**Fix.** `RESERVED_CONNECT_BLOCK_IDS` in `lib/domain/questionId.ts`, refused by `connectIdError` on every Connect block id and avoided by `deriveConnectId` (defect 15's table). The fixtures' task becomes `follow_up`.

**Files.** Defect 15's, with `lib/commcare/__tests__/` Connect fixtures and `lib/commcare/CLAUDE.md` (the Connect paragraph gains the five names and why).

**Stored shape and migration.** No schema change. The `connect-ids` step renames a block with one of the five names to `q_<name>`, suffixed until free app-wide, under `connect-block-renamed` with the sentence that Connect could not receive the form before.

**Register.** None: Connect is not in the per-document unit, so the lane's registers hold no entry for it. The reader package's tests below are the proof.

**Spelling rule.** None. **Identity.** The Connect block id and its data path, once. No entry in `proof/identity-moves.json`.

**Control.** None in `proof/controls/`. The failing shape stays under proof by being written by hand (Lane).

**Nova tests.** Pure: `connectIdError` refuses each of the five names beside `tasks` and `Task`; `deriveConnectId` never mints one; the `connect-ids` step over a fixture holding each.

**Lane.** `npm run proof -- proof/connect`. In this pull request `targeted-connect-deliver-key-names` and `targeted-connect-learn-key-names` leave the corpus, since the validator refuses them, and the two tests above are rewritten to write each name by hand: in a fork of the published deliver app (and of the learn app), the wrapper node, its binds and its block's id are renamed to the name, HQ builds it, Connect syncs from that build, the unit is paid for, Core submits the form, HQ builds the payload and Connect receives it. Executed during planning that way: a deliver unit's wrapper renamed to `deliver`, and a learn app's assessment wrapper renamed to `assessment` and to `module`, each answer 500 with `KeyError('@xmlns')` and keep nothing, and the accepted names of the list above were written and received the same way. `task` and `work_area_update` were run on Nova's own exports, by the two tests as they stand. A third test, new, holds the accepted counterparts: the five `q_` names, `Module` and `Task`, the other app type's names, and the ordinary questions named like the keys.

## Finding 61: a deliver form that also holds a task

**Today.** With a task assigned, Connect reads a deliver form's deliver unit before its task (`processor.py::process_deliver_form`), and rejects any delivery while a task is pending (`process_deliver_unit`, `_has_blocking_pending_task`). So the submission that completes the task has its own visit rejected for that task, then the task is completed, and the next visit is approved (`proof/connect/test_receiver.py::test_the_form_that_delivers_also_completes_the_workers_assigned_task`).

This is what Connect does for any app of that shape, whoever wrote it: the order and the rule are Connect's. Executed during planning, the same rule with the task in a form of its own: a delivery sent while the task is assigned is rejected (`pending_task`) though its form holds no task, and then the task's form completes the task; sent the other way round, the task's form completes the task with no visit, and the delivery after it is approved.

**Fix.** Recorded as Connect's own. A shape inside the envelope works (the task in its own form, sent before the delivery), so the validator refuses nothing and nothing is migrated. Nova says what will happen where a person makes the choice:

- `components/builder/detail/formSettings/DeliverConfig.tsx`, under a task on a form that also holds a deliver unit: "CommCare Connect rejects the visit that completes this task, because it checks the delivery first. A task in a form of its own avoids that."
- The `configure_connect` description in `lib/agent/tools/` carries the same fact, so the SA puts a task in a form of its own unless the person asks otherwise (a description change: ask before `npm run test:schema`).
- The Connect page under `content/docs/`.

**Files.** The three above, and `lib/commcare/CLAUDE.md` (the Connect paragraph).

**Stored shape and migration.** None. No notice: nothing changes for an existing app.

**Register.** None. **Spelling rule.** None. **Identity.** None; no entry in `proof/identity-moves.json`. **Control.** None.

**Nova tests.** A state-model test that the note is derived from the form's Connect config (a task with a deliver unit, a task alone, a deliver unit alone).

**Lane.** `proof/connect/test_receiver.py`: the existing test stays, and a new one, over a deliver app whose task sits in its own form, holds the two orders above.

## Finding 43: names that stop HQ's form builder opening a form

**Today.** A question may be named `instance`, `bind` or `parsererror` (`validator/rules/field.ts::invalidFieldId` admits all three), and `lib/commcare/__tests__/xformDocArbitrary.ts` draws the first two on purpose. Vellum then cannot open the form:

| Name | What Vellum does | Observed by |
|---|---|---|
| `instance` | `src/parser.js::_getInstances` runs `xml.find("instance")` over the whole document and throws on a second instance with no id | the lane's `d43-instance-node-*` entries |
| `bind` | `parseXForm` hands every `bind` under the head to `parseBindList`, which fails on one with no `nodeset` | the lane's `d43-bind-node-*` entries |
| `parsererror` | jQuery's `parseXML`, which Vellum loads the form with, takes any element named `parsererror` for the browser's own parse failure and throws "Invalid XML"; Vellum shows "Parsing Error. Please check that your form is valid XML." and saves nothing | executed during planning: a form with one question named `parsererror`, through the lane; HQ's build, Core and every other check take the form |

Each search is by bare element name at any depth, so it reaches every element Nova writes in a form's source. Executed during planning, in forks of `case-operation-link`: a case operation whose wrapper is named `instance`, and an index (a link identifier) named `instance`, `bind` or `parsererror`, each stop Vellum opening the form with the message of that name's row. `itext` is harmless (`src/javaRosa/plugin.js` skips a language that is not the app's; `targeted-reserved-node-names` holds a question so named and Vellum opens it) and stays admitted.

**Fix.** The exact, case-sensitive names `instance`, `bind` and `parsererror` are refused as:

- a question id and a Connect block id, through `RESERVED_QUESTION_IDS` (defect 15);
- a case operation id: `lib/domain/caseOperationIdentifiers.ts::isCaseOperationIdentifier` refuses the three after its regex, with `identifierVerdicts.ts::caseOperationIdVerdict` and `validator/rules/caseOperations.ts` (code `CASE_OPERATION_INVALID_ID`) following;
- a link identifier: `identifierVerdicts.ts::caseOperationLinkIdentifierVerdict` and the link rule in `validator/rules/caseOperations.ts` (code `CASE_OPERATION_LINK_INVALID`);
- a case property name written by a block in a form's source: a case operation's write, the derived selected-cases update, or a source-lowered subcase. New code `CASE_PROPERTY_NAME_STOPS_FORM_BUILDER`, class soundness, located at the operation or field: "CommCare HQ's form builder can't open a form that saves a property named `<name>` from a case change. Save it under another property name here." A property written only through a basic action is not refused, because HQ's build adds that block and the form's source never holds it. Step 5 inherits the rule for every write when every write becomes a Save to Case block.

In `lib/agent/tools/case-operations/shared.ts`, `operationIdInputSchema` and `linkIdInputSchema` keep their `pattern`. The three names are refused by a `.superRefine` over the verdict (`caseOperationIdVerdict` for an operation id, in the place of the `__nova_` refine pull request 7 removes (part 05, Reserved names and wrapper containers (defect 13)); `linkIdInputSchema` already calls `caseOperationLinkIdentifierVerdict`).

Which writes are in a form's source is decided today in three places with no shared predicate: every case operation's `writes` (`lib/commcare/xform/caseOps.ts::buildCaseOperations`); the form's own case update when its case selection takes several cases (`lib/commcare/expander.ts::expandDoc`, where `selectedCaseSessionDatum(...).maxSelectValue` is set and `buildPrimaryCaseUpdateMap` supplies the writes); and a subcase in such a form or one whose relationship is `extension`, with a condition other than `never` (the subcase loop in `buildCaseOperations`). This pull request extracts that decision into one pure module, `lib/commcare/xform/sourceCaseWrites.ts`:

```ts
export interface SourceBlockCaseWrite {
	readonly property: string;
	readonly origin:
		| { readonly kind: "operation"; readonly operationUuid: Uuid }
		| { readonly kind: "field"; readonly fieldUuid: Uuid };
}
export function formUpdatesSelectedCasesInSource(ownCaseDatum: SessionDatum | undefined): boolean;
export function subcaseIsWrittenInSource(subcase: OpenSubCaseAction, severalCases: boolean): boolean;
export function sourceBlockCaseWrites(
	doc: BlueprintDoc, moduleUuid: Uuid, formUuid: Uuid, linkContext: FormLinkProjectionContext,
): readonly SourceBlockCaseWrite[];
```

`expandDoc` and `buildCaseOperations` replace their inline tests with the two predicates, and `sourceBlockCaseWrites` is built from the same two plus the operations' writes, so the emitter, the validator and the scan cannot disagree. `SessionDatum` is `lib/commcare/session.ts`'s, `FormLinkProjectionContext` and `selectedCaseSessionDatum` are `lib/commcare/formLinkProjection.ts`'s, and `buildPrimaryCaseUpdateMap` is `lib/commcare/formActions.ts`'s. One form-scoped rule, `casePropertyNameStopsFormBuilder` in the new `validator/rules/sourceCaseWrites.ts`, calls `sourceBlockCaseWrites` and locates each finding at its origin: the operation, or the field whose `caseWrite` names the property. The cutover's `reserved-property-write` scan calls the same function over the document as stored.

**Files.**
- Domain: `lib/domain/questionId.ts` (`RESERVED_QUESTION_IDS`); `lib/domain/caseOperationIdentifiers.ts` (the three names, with a message of their own: "`<name>` is a name CommCare HQ's form builder can't open a form with. `q_<name>` is free here.").
- Doc and mutations: `lib/doc/identifierVerdicts.ts`; `lib/doc/userFacingErrors.ts` (the new code).
- Validator: `validator/rules/sourceCaseWrites.ts` (new, registered with the form rules in `validator/index.ts`), `validator/rules/caseOperations.ts`, `validator/errors.ts`, `validator/gate.ts`.
- Emitters: `lib/commcare/xform/sourceCaseWrites.ts` (new); `lib/commcare/expander.ts` and `lib/commcare/xform/caseOps.ts` call its predicates, with byte-identical output.
- Preview, builder: none beyond the verdicts.
- SA and MCP tools: `lib/agent/tools/case-operations/shared.ts` (the two refines; the id, link and write-property descriptions name the three names: ask before `npm run test:schema`).
- Docs: `content/docs/case-changes.mdx`, `content/docs/mcp/tools.mdx` (the operation id sentence).
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("An answer named `secret`, `bind`, or `translation` is ordinary data" is true of Core and of Nova's oracle; it gains that HQ's form builder cannot open a form holding `bind`, `instance` or `parsererror`, so the validator refuses them).
- Tests and generators: `lib/commcare/__tests__/xformDocArbitrary.ts` stops drawing `instance` and `bind` (it keeps `secret` and `translation`).

**Stored shape and migration.** No schema change. The `question-ids`, `case-operation-ids` and `connect-ids` steps rename a question, operation or Connect block with one of the three names to `q_<name>` with the standard suffix, under `question-renamed`, `case-operation-renamed` or `connect-block-renamed`. A link identifier and a property write of one of the three names are scan-blocking and are not migrated: each is the identity of data on existing cases.

**In pull request 1.** `parsererror` gets the proof the other two names have, before its fix:

- **Document** `targeted-parsererror-node-name` (`proof/targeted/documents/formShapes.ts::parsererrorNodeName`, registered in `TARGETED_DOCUMENTS`), `rows: ["43 (a question named parsererror)"]`: one survey form holding one text question `parsererror`, with the `answerHeld` expectation the other form-shape documents carry.
- **Entries**, defect `43`, check `proof4`, artifact `editor:vellum@*`: `d43-parsererror-node-vellum-load-parsing-error` (path `/modules/*/forms/*/load/Parsing Error. Please check that your form is valid XML.`) and `d43-parsererror-node-vellum-page-errors-invalid-xml` (the `/modules/*/forms/*/page_errors/Error: Invalid XML: ...` path exactly as the lane prints it for the document, since jQuery's message holds the form's source). Executed during planning: these two classes, on both configurations, are everything any check reports on that document. `vellum again` is skipped, because Vellum saved nothing.
- **Control** `targeted-parsererror-node-name`, retained for proof 4.

**Register.** 7 entries. 5 on document and control `targeted-reserved-node-names`: manifest 1 (`d43-instance-node-form-instance-second-instance-without-id`); proof4 4 (`d43-instance-node-vellum-load-multiple-unnamed-instance`, `d43-instance-node-vellum-page-errors-multiple-unnamed-instance`, `d43-bind-node-vellum-load-typeerror-cannot-read`, `d43-bind-node-vellum-page-errors-typeerror-cannot-read`). 2 on control `targeted-parsererror-node-name`, added in pull request 1.

**Spelling rule.** None.

**Identity.** The data path of each renamed question or block, once. No entry in `proof/identity-moves.json`.

**Control.** `targeted-reserved-node-names` keeps showing Vellum's two load failures and the manifest class. `targeted-parsererror-node-name` keeps showing Vellum's load failure.

**Nova tests.** Pure: the validator rules, each refusal beside an accepted neighbor (`instances`, `Bind`), with the property rule shown on an operation write, on a field of a several-case form and on an extension subcase's field, and accepted on a field whose write rides a basic action; the operation id and link identifier refusals beside `_instance`; the existing emission tests hold the output byte-identical over the extracted predicates; a test that pins `RESERVED_QUESTION_IDS`, with a comment naming the two controls, so a removal is a reviewed change; the `question-ids`, `case-operation-ids` and `connect-ids` steps over a fixture holding each name; the blocking fixtures for a link identifier and for a source-block property write.

**Lane.** Locally: `targeted-reserved-node-names`, rewritten in place with `q_instance`, `q_bind` and `q_parsererror`, and both controls. Executed during planning: Vellum opens and saves a form holding those three questions twice and reports nothing, and an index named `q_instance` opens and saves. `targeted-parsererror-node-name` leaves the corpus in this pull request (the validator refuses it), which the `index.json` diff must show. The fuzz sample's documents keep their ids and change content. CI: the full lane, 7 entries moved.

## Finding 62: question names HQ's editors warn about, and `case` in a form that saves a case

**Today.** A question may be named `case`, `registration` or `script`. Executed during planning, through the lane:

- Vellum adds the message "The ID '`<id>`' may cause problems with form parsing. It is recommended to pick a different Question ID." to each such question, in any case (`src/mugs/baseSpecs.js`, `RESERVED_NAMES`), and proof 4 reports it on Vellum's first save and its second. So no document holding one can pass the lane.
- A root question named `case` in a form with basic case actions stops HQ's build: `xform.py::XForm.case_node` finds it as the form's own case block, and both `validate_app` and `create_all_files` answer "You cannot use the Case Management UI if you already have a case block in your form." HQ's form settings and Case Management pages show the same message. Nothing can be installed from HQ for that app.

**Fix.** `case`, `registration` and `script`, compared lowercased as Vellum compares them, join `RESERVED_QUESTION_IDS` (defect 15), for every question, group, repeat and Connect block, at any depth: one rule, and Vellum's message does not depend on depth. Message: "`case` is a name CommCare keeps for a form's case data. `q_case` is free here.", and for the other two: "`<id>` is a name CommCare HQ's form builder warns about. `q_<id>` is free here."

**Files.** Defect 15's (`lib/domain/questionId.ts`, `validator/rules/field.ts`, `lib/doc/userFacingErrors.ts`, the question id description in `lib/agent/toolSchemaGenerator.ts`). CLAUDE.md: `lib/domain/CLAUDE.md`.

**Stored shape and migration.** No schema change. The `question-ids` and `connect-ids` steps rename each to `q_<id>` with the standard suffix, under `question-renamed` and `connect-block-renamed`. A case operation id and a link identifier are not touched: neither is a question, and neither sits at a form's root.

**In pull request 1.**

- **Document** `targeted-reserved-question-names` (`proof/targeted/documents/formShapes.ts::reservedQuestionNames`, registered in `TARGETED_DOCUMENTS`), `rows: ["62"]`: a survey menu whose form holds text questions `registration`, `script` and `notes`; and a menu over a case type whose registration form holds `full_name`, saving the case's name, and a text question `case`, saving a property.
- **Entries**, defect `62`, written from that pull request's lane evidence. Executed during planning on two documents that together hold this one's forms, the classes were these six and no other: bar, `create_all_files@*` at `/raised/XFormException` and `validate_app@*` at `/error`; proof4, `editor:case management@*` and `editor:form settings@*`, each at `/modules/*/forms/*/messages/view_form/You cannot use the Case Management UI if you already have a case block in your form.`, and `editor:vellum@*` and `editor:vellum again@*`, each at `/modules/*/forms/*/questions/*/nodeID/mug-nodeID-reserved-name-warning/The ID '*' may cause problems with form parsing. It is recommended to pick a different Question ID.`
- **Control** `targeted-reserved-question-names`, retained for the bar and proof 4.
- **Record.** `docs/research/2026-09-26-hq-round-trip/harness-findings.md` gains finding 62.

**Register.** The 6 entries, added in pull request 1 and moved in pull request 10.

**Spelling rule.** None. **Identity.** The data path of each renamed question, once. No entry in `proof/identity-moves.json`.

**Control.** `targeted-reserved-question-names` keeps showing HQ's build refusal and both editors' messages.

**Nova tests.** Pure: the three names refused in any case beside `cases`, `registrations` and `scripts`; the steps over a fixture holding each, one of them a root `case` in a registration form.

**Lane.** Locally: the control. The document leaves the corpus in pull request 10. Executed during planning: a form holding `q_instance`, `q_bind`, `q_parsererror` and `q_Meta` passes every check, which is the shape `q_case`, `q_registration` and `q_script` take. CI: the full lane, 6 entries moved.

## Finding 44: duplicate option values

**Today.** Two options of one select may share a value: `lib/domain/fields/base.ts::selectOptionSchema` has no uniqueness and `validator/rules/field.ts::selectOptionValueInvalid` checks each value alone. A case property's option catalog (`lib/domain/blueprint.ts::casePropertySchema`, an array) can hold the same. Vellum reports "This choice value has been used in the same question" on exact string equality among siblings (`src/mugs/types/select.js`) on its first save and its second, which the lane's four entries below observe. An export of such a form cannot say which option was chosen.

**Fix.** Refuse it, comparing exactly as Vellum and Core do.

- `SELECT_OPTION_VALUE_DUPLICATE`, class soundness, beside `selectOptionValueInvalid`, located at the field with the option's uuid and a suggested value.
- `CASE_PROPERTY_OPTION_VALUE_DUPLICATE` in `validator/rules/app.ts`, beside `CASE_PROPERTY_OPTION_VALUE_INVALID`.
- Message: "Two choices of `<question>` both store `<value>`, so a saved answer can't say which was chosen. `<suggestion>` is free for the second."
- Lookup-backed selects are already covered at the export boundary. The itext ids stay keyed by option index, which is still the right key.

**Files.**
- Domain: `lib/domain/selectOptionValue.ts` (a `duplicate` member of `SelectOptionValueProblem`, and the sibling-aware check the validator and the builder share).
- Doc and mutations: `lib/doc/userFacingErrors.ts`.
- Validator: `validator/rules/field.ts`, `rules/app.ts`, `validator/errors.ts`, `validator/gate.ts`.
- Emitters, Preview: none.
- Builder: `components/builder/editor/fields/optionsDraftModel.ts` (the verdict that sanitizes a value also refuses one a sibling holds).
- SA and MCP tools: none. `SELECT_OPTION_VALUE_DESCRIPTION` and `content/docs/mcp/tools.mdx` already say "unique".
- Docs: none. CLAUDE.md: `lib/domain/CLAUDE.md` (the option value sentence).
- Tests: in `lib/commcare/__tests__/expander.test.ts`, under the `describe` whose title ends "index-keyed (issue #10)", the tests "single_select with duplicate option values emits distinct itext ids" and "multi_select with duplicate option values emits distinct itext ids" become refusal tests, and the third, "distinct-value single_select still emits one item + ref per option (regression)", stays; `xformDocArbitrary.ts` draws distinct option values.

**Stored shape and migration.** No schema change. Step `option-values`, a pure planner over the raw rows (`planDuplicateOptionValueSplit` in the step module), written to the rules of the existing repair planner `scripts/lib/selectOptionValueRepair.ts::planSelectOptionValueRepair`:

- A value space is the catalog options of one case property together with every field writing that property; a select with no case binding is its own space.
- In each option list, the first option holding a value keeps it. New values are allocated once per space: the k-th duplicate of a value `v` across the space is `suffixUntilFree(v, taken)` in allocation order (`yes_2`, `yes_3`), where `taken` is the space's values and those already allocated. In each list the k-th later holder of `v` takes the k-th allocated value, and a list with fewer holders uses fewer, so a field and its catalog property stay in agreement.
- Translation entries keyed by the old value and its occurrence (`lib/domain/translationUnits.ts::casePropertyOptionOccurrence`) move to the new unit id, so no wording is lost.
- Nothing else follows the rename. No case row, close condition, ID-mapping entry or expression literal is rewritten: the shared value cannot say which option was meant, so it keeps reading as the first option.

The step does not call that script's writer, which lands through `lib/db/apps.ts::appendSyntheticBatchInTransaction` and needs a source that parses under the current schema; the cutover's removals make the pre-step document unparseable there.

Notice reason `option-value-split`, with two templates. For a field: "`<form>`, `<question>`: the choices `<label 1>` and `<label 2>` both stored `<value>`. `<label 2>` now stores `<new value>`. Answers saved before this show as `<label 1>`." For a case property's catalog, which has no form or question (the entry's entity is the app, with the case type and the property in its detail): "`<case type>`, `<property>`: the choices `<label 1>` and `<label 2>` both stored `<value>`. `<label 2>` now stores `<new value>`. Values saved before this show as `<label 1>`."

**Register.** 4 entries: manifest 2 (`d44-duplicate-options-form-item-refused-choice-value-9e0a` on control `expander-select-option-itext-ids-index-keyed-issue-10-608c801a-0`; `...-cb90` on `expander-select-option-itext-ids-index-keyed-issue-10-bf790763-0`); proof4 2 (`d44-duplicate-options-vellum-mug-nodeid-error-choice-value-been` and `d44-duplicate-options-vellum-again-...`, on the `bf790763-0` control).

**Spelling rule.** None.

**Identity.** The stored value of each renamed option, for answers saved from the next publish. No entry in `proof/identity-moves.json`.

**Control.** The two `expander-select-option-itext-ids-index-keyed-issue-10-*` controls keep their names (a control's name is its directory's) and keep showing the manifest class and Vellum's message.

**Nova tests.** Pure: both validator rules with an accepted neighbor (values differing only in case are distinct); the builder verdict; the planner over a field-only select, a field with its catalog property, and a translated catalog option. Real Postgres (the writer test): an app with a duplicated value comes out gate-clean with the second option renamed, the translation entry moved, and no case row changed.

**Lane.** Locally: the two controls. The two documents leave the corpus when their tests become refusal tests, which the `index.json` diff must show as exactly those two ids removed. Removing two documents rebalances the fixed producers' edit batches, so another document's edit can move. Where the full lane then reports a live entry unseen on its document, that entry is re-documented on the document that now shows it, in this pull request; a path is never loosened. CI: the full lane, 4 entries moved.

## Finding 31: a form with no question

**Today.** `validator/rules/form.ts::emptyForm` asks only whether the root holds a non-section field or a non-empty section, so a form whose only content is an empty group or repeat passes. HQ's build then refuses it as a "blank form": `helpers/validators.py::FormBaseValidator.validate_for_build` requires `any(not q.get('is_group') for q in questions)` over `xform.py::XForm.get_questions`. The lane observes it (the entry below).

**Fix.** `emptyForm` passes when the form holds, at any depth, a field whose kind is not `group`, `repeat` or `section`. Nova asks for a field a person authored and does not copy HQ's counting of generated leaves (a count node, a Save to Case leaf), so a form of empty containers and case operations is refused too. The code stays `EMPTY_FORM`, class completeness, with three messages: no fields; sections with nothing on them (today's); and "This form has sections or groups and no question in them yet. Add a question, a label or a hidden value." `lib/doc/scaffolds.ts` already starts every form with a text question, so no scaffold changes.

Executed during planning, through the lane: HQ builds, Vellum saves twice and Core runs each smallest form Nova's rule admits, and every check passes on a document holding all four: an empty group beside one Label at the root; a group holding only a Hidden Value; a repeat holding only a Label; and a sectioned form whose first section holds one Label and whose second holds an empty group.

**Files.**
- Validator: `validator/rules/form.ts`. Doc and mutations: `lib/doc/userFacingErrors.ts` (the third wording).
- Domain, emitters, Preview, builder, SA and MCP tools, docs: none.
- CLAUDE.md: none.
- Tests: in `lib/commcare/__tests__/expander.test.ts`, under the `describe` "empty container expansion", the test "emits an empty <group> wrapper when a group has zero children" keeps its title, keeps asserting the empty group's emission, and its form gains a question.

**Stored shape and migration.** No schema change. Step `empty-forms` (`steps/emptyForms.ts`), after `option-values`: for each form with fields and no question, add one Label at the root (inside the first section when the form is sectioned, since a sectioned root admits only sections), id `note` suffixed until free, text "This form has no questions yet." as the Label's own text. Both placements are among the four forms run above. Reason for adding and not refusing: the gate judges the whole document, so an app holding such a form could commit nothing after the cutover; a Label is the smallest content that satisfies Nova's rule and HQ's, the author sees it as the thing to replace, and nothing is removed. Notice reason `empty-form-label-added`: "`<form>` had no questions, and CommCare HQ won't build a form like that. It now has one label to replace with your first question."

**Register.** 1 entry: `d31-empty-groups-validate-blank-form` (bar), control `expander-empty-container-expansion-emits-an-empty-group-86a5cfc1-0`.

**Spelling rule.** None.

**Identity.** None: a node is added, none moves. No entry in `proof/identity-moves.json`.

**Control.** That control keeps showing HQ's `validate_app` refusal under the bar.

**Nova tests.** Pure (validator): each refusal beside an accepted form (a group holding only a hidden value; a repeat holding a label). Pure (state model, over the commit gate): removing the last question of a form that still holds an empty group is refused with the new message, and moving the only question into a group is accepted. Pure (the step): a flat form and a sectioned form. The writer test's fixture app holds one such form.

**Lane.** Locally: the control and the document. The expander test keeps its title, so its document keeps the id `expander-empty-container-expansion-emits-an-empty-group-86a5cfc1-0` (an expander id is the slug and hash of the test's title plus its index, `proof/corpus/documents.ts::readExpanderCapture`) and only its bytes change; the `index.json` diff must show no id added or removed by this block. The document then shares its name with the control, which a control may; the control keeps the pre-fix bytes and the document no longer shows the bar's refusal. CI: the full lane, 1 entry moved.

---

## Defect 16: what the code, the tools and the docs say

**Today.** Comments, type comments, tool descriptions and one public page state CommCare facts that are false, and one validator code has no rule. (The dead function that orders setvalues no emitter writes, `builder.ts::isRepeatCountSnapshot`, goes in pull request 7: part 05, Reserved names and wrapper containers (defect 13).)

**Fix.** Each row is corrected to the right-hand column. No behavior changes in this block.

| Where | What it says | What is true, and the run that showed it |
|---|---|---|
| `lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES` (comment) | "plus `owner_id` which HQ also rejects in update blocks" | HQ takes an `owner_id` update. Executed during planning: with `owner_id` added to a form's `update_case` in a fork of `case-capture-followup`, `validate_app` reports nothing and HQ's build writes the bind `/data/case/update/owner_id`; and HQ's case processing of an update block holding `owner_id` moves the case to the new owner. The set keeps `owner_id` as Nova's own rule, and the comment gives Nova's reason |
| `lib/commcare/hqShells.ts` and `lib/commcare/types.ts` (comments on target-owned settings) | `case_sharing` and `cloudcare_enabled` are target-owned | Both are app content that an update writes. Executed during planning: an update of `navigation-base` carrying the opposite of each stored value changed both in HQ's stored app. The comments list only what the target owns |
| `FIXTURE_REFERENCE_NOT_MODELED` in `validator/errors.ts`, `validator/gate.ts`, `lib/doc/userFacingErrors.ts` | a validator code | No rule produces it (Nova's own code: no reader is involved). All three entries are deleted |
| `lib/domain/modules.ts::idMappingEntrySchema`, `imageMapEntrySchema` (comments and both schema messages) | `selected()` "splits both sides on whitespace" | Core trims the key and looks for it, between spaces, in the value padded with spaces (commcare-core `XPathSelectedFunc.multiSelected`). Executed during planning on Core: `selected('a b', ' a ')` and `selected('a b', 'a b')` are true; `selected('a  b', 'a b')` (two spaces in the value) is false, and so is `selected()` of `b` in a value whose two words a tab separates. The schemas keep refusing blank and multi-word values until step 7 holds them. The message becomes "A mapping value is one word with no spaces." |
| `lib/commcare/xform/captureUpload.ts` (comment) | Android's `WidgetFactory` has no `face` branch | Executed during planning on the Android reader: an image capture question with the appearance `face`, written by hand into a Nova archive, is drawn by `FaceCaptureWidget`, and without it by `ImageWidget`. Comment only; step 2 does not add `face` |
| `lib/domain/fields/file.ts` (header and `saDocs`); `content/docs/attachments.mdx` ("File attachments only work in the web app") | Android has no document upload and shows a text box | Executed during planning on the Android reader: the File question of `case-capture-registration`'s local archive is drawn by `DocumentWidget`, with its "Choose Document" button, and its image question by `ImageWidget`. The header, the `saDocs` and the docs section say the File question also works in the Android app |
| `HIDDEN_VALUE_BOTH_SOURCES` and its echoes: `validator/rules/field.ts::hiddenValueBothSources`, `lib/domain/fields/hidden.ts`, `lib/agent/tools/editField.ts`, `lib/agent/toolSchemaGenerator.ts::gateHiddenValueSources`, `lib/doc/userFacingErrors.ts`, `lib/domain/effectiveCaseTypes.ts::inferHiddenWriterType`, `components/builder/editor/fields/hiddenValueModel.ts`, `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md` | the default "is overwritten before anyone could read it" | A later load-time setvalue reads it. Executed during planning on Core: a hidden value with the default `'D'` and the calculate `'C'` ends as `C`, and a second value whose own default reads the first holds `D`. Every place says only that Nova does not yet write a Hidden Value's default beside its calculate. One exported constant, `HIDDEN_VALUE_ONE_SOURCE_SENTENCE` in `lib/domain/fields/hidden.ts`, holds the sentence: "A hidden value takes a calculation or a starting value. Nova doesn't yet write both on one field." `lib/commcare/validator/gate.ts` was checked: it holds the code's class and no claim to correct |
| `lib/domain/multimedia.ts::AUDIO_MIME_TYPES` and its three echoes | HQ validates a media file's extension | Defect 11's block below |
| The headers of `lib/commcare/multimedia/mediaSuiteXml.ts` and `assetWirePath.ts`, the two comments and the two finding messages in `lib/commcare/validator/mediaSuiteOracle.ts`, and the comment in `lib/commcare/__tests__/mediaSuiteOracle.test.ts` | an unbundled file fails to install | Defect 11's block below |

Dead code, none removed here:

- `lib/commcare/xform/builder.ts::isRepeatCountSnapshot`, its two filters in `buildXForm` and the comment above them are not this block's: pull request 7 deletes them with the prefix (part 05, Reserved names and wrapper containers (defect 13)).
- `lib/commcare/constants.ts::RESERVED_XFORM_NODE_PREFIX` and its stale comment are not this block's either: the same pull request deletes the constant.

**Files.** Domain: `lib/domain/modules.ts`, `lib/domain/fields/file.ts`, `lib/domain/fields/hidden.ts`, `lib/domain/effectiveCaseTypes.ts`. Doc and mutations: `lib/doc/userFacingErrors.ts`. Validator: `lib/commcare/constants.ts`, `validator/errors.ts`, `validator/gate.ts`, `validator/rules/field.ts`. Emitters: `lib/commcare/hqShells.ts`, `lib/commcare/types.ts`, `lib/commcare/xform/captureUpload.ts` (comments only). Preview: none. Builder: `components/builder/editor/fields/hiddenValueModel.ts`. SA and MCP tools: `lib/agent/tools/editField.ts`, `lib/agent/toolSchemaGenerator.ts` (descriptions: ask before `npm run test:schema`); sweep `../nova-plugin` for the File and hidden-value claims. Docs: `content/docs/attachments.mdx`. CLAUDE.md: `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`.

**Stored shape and migration.** None: nothing stored changes.

**Register.** None.

**Spelling rule.** None.

**Identity.** None. No entry in `proof/identity-moves.json`.

**Control.** None.

**Nova tests.** Pure: the classified-code renderer test fails if `FIXTURE_REFERENCE_NOT_MODELED` keeps a renderer; the ID-mapping schema test reads the new message.

**Lane.** Each corrected sentence states a reader's behavior, so each gets a test that runs the reader, in pull request 14:

- `proof/core/test_evaluate.py` gains the `selected()` cases and the default-beside-calculate form above.
- `proof/hq/test_publish.py` gains the update that flips `case_sharing` and `cloudcare_enabled`; `proof/hq/test_case_processing.py` gains the `owner_id` update, and `proof/hq/test_build.py` the `update_case` that carries it.
- `proof/android/predicates.py` gains the two capture widgets: `DocumentWidget` for the File question of a retained control's local archive, and `FaceCaptureWidget` once `face` is written into it.
- `proof/README.md` ("What the lane does not observe") drops its line for defect 16's comments. CI: the full lane with no entry moved by this block and no document's bytes changed by it.

## Defect 16: three media slots leave the model

**Today.** A field may carry `hint_media` and `validate_msg_media`, and a group or repeat `label_media` (`lib/domain/fields/base.ts`, the ten validatable kinds' files). `lib/commcare/xform/builder.ts::buildFieldParts` emits all three as itext media forms, and Preview shows hint media and container label media. No CommCare runtime shows any of them. Executed during planning, on one form built by Nova's emitter that holds a question with label, hint, help and validation-message media; a group with label media around a question with hint and validation-message media and no label media; and a counted repeat with label media around a question with none:

| Slot | Android (the Android reader, `FormEntryActivity`) | Formplayer (HQ's build, the real server) | Web Apps (HQ's client in Chromium over Formplayer) |
|---|---|---|---|
| Label media on a question (the accepted case) | an audio button, a video button and an image view | `caption_image`, `caption_audio`, `caption_video` | the image, the audio and the video are drawn |
| Hint media | the hint's text and nothing else | `hint` is text; no hint media in the question | the hint's text; no image |
| Group label media | the group's title as text; the screen holds no audio button and no image view | sends `caption_image` and `caption_audio` on the group | the group's header draws its caption text alone |
| Repeat label media | the repeat's title and row number as text ("Rows (1)"); the screen holds no audio button and no image view | sends `caption_image` and `caption_audio` on the repeat | the repeat's header draws its caption text alone |
| Validation-message media | after a refused answer, the message's text and no further view | the refusal is `reason` text | (what Formplayer sends is all the client has) |

Formplayer does carry a group's and a repeat's label media to the client (formplayer `PromptToJson`); the client's group template draws none of it (`corehq/apps/cloudcare/templates/cloudcare/partials/form_entry/sub_group.html`). So the slot is dead by what Web Apps and Android draw, which is what the tests below hold.

**Fix.** The three slots are removed from every surface. `label_media` stays on every non-container kind, and `help_media` stays.

**Files.**
- Domain: `lib/domain/fields/base.ts` (`containerFieldBase.label_media`, `hint_media` in the input base, the comments); `validate_msg_media` in `text.ts`, `int.ts`, `decimal.ts`, `date.ts`, `time.ts`, `datetime.ts`, `secret.ts`, `barcode.ts`, `singleSelect.ts`, `multiSelect.ts`; `lib/domain/mediaRefs.ts` (the slot union, `collectAssetRefs`' field walk, the remap walk, the slot switch); `lib/domain/referenceSlots.ts` (the `hint_media` and `validate_msg_media` kinds).
- Doc and mutations: `lib/doc/types.ts::FIELD_MEDIA_SLOTS` becomes `label`, `help` (the `setFieldMedia` payload); `lib/doc/mutations/fields.ts` and `lib/doc/diffDocsToMutations.ts` follow.
- Validator: `lib/commcare/validator/rules/media/shared.ts` (the slot map); `validator/xformOracle.ts` (comment).
- Emitters: `lib/commcare/xform/builder.ts::buildFieldParts` passes no media for a hint, a validation message or a container's label. `lib/commcare/xform/constraintMessage.ts::protectConstraintMessage` stops writing the `__nova_mode;image`, `;audio`, `;video` and `;video-inline` forms, which exist only so a request for a media form of a protected message returns its media. The `__nova_identity`, `__nova_mode`, `__nova_mode;markdown`, `__nova_locale` and `__nova_piece_<n>` forms stay: they are itext form names, not question names.
- Preview: `lib/preview/engine/formPresentation.ts`; `components/preview/form/InteractiveFormRenderer.tsx`, `fields/GroupField.tsx`, `fields/RepeatField.tsx`, `fields/ValidationError.tsx`, `virtual/rows/FieldRow.tsx`, `virtual/rows/GroupBracket.tsx`, and the validation-message readers in `fields/TextField.tsx`, `NumberField.tsx`, `DateField.tsx`, `SelectOneField.tsx`, `SelectMultiField.tsx`.
- Builder: `components/builder/editor/fieldEditorSchemas.ts` (every `validate_msg_media` and `hint_media` entry and the container label-media entries); `components/builder/editor/fields/MediaSlotEditor.tsx` (comment). The comment in `lib/session/store.ts` was checked: its example key is `label_media` on a field, which stays, so it needs no change.
- SA and MCP tools: `lib/agent/tools/media/shared.ts::FIELD_MEDIA_SLOTS` becomes `label`, `help`; `lib/agent/tools/media/attachFieldMedia.ts` (`label` on every visible non-container kind, `help` on input kinds). This changes `attach_field_media`'s input schema: ask before `npm run test:schema`. Sweep `../nova-plugin` for the slot names.
- Docs: `content/docs/mcp/tools.mdx` (the `attach_field_media` row).
- CLAUDE.md: `lib/media/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`.
- Proof: the three emission cells in `lib/commcare/surface/entries/questions.json`; the manifest entry `questions/protected-constraint-message-forms`; the protected-message reader in `proof/checks/manifest_value_classes.py` and `proof/native/test_xml_boundary.py`, which name the `__nova_mode;<medium>` forms; the `media-rich` producer source drops the slots and keeps its id.

**Stored shape and migration.** The three keys leave the strict field schemas, so a pre-step document holding one does not parse under the new schema and a history row carrying one does not replay. That is one of the reasons the cutover is a fold horizon. Step `media-slots` deletes `hint_media`, `validate_msg_media` and a group's or repeat's `label_media` from each field. It deletes no asset: the library is the Project's, another app may use the file, and the cutover rebuilds the app's exact media reference projection from the target document (`lib/db/canonicalCommitKernel.ts::replaceExactMediaReferencesForApp`), so `lib/media`'s deletion guard stops counting these references and a person may remove a file nothing else uses. Notice reason `media-slot-removed`, naming the form, the field, the slot and the asset's name: "`<form>`, `<field>`: the `<image, audio or video>` on its `<hint, validation message, group title or repeat title>` was removed. No CommCare app shows media there, so workers see no change. The file is still in your media library."

**Register.** None.

**Spelling rule.** None.

**Identity.** None in HQ's stored identities. The built media suite of an app that used a slot loses those resources at its next publish. No entry in `proof/identity-moves.json`.

**Control.** None.

**Nova tests.**
- Pure: schema parse tests that each removed key is refused on each kind; `collectAssetRefs` no longer reports the slots; an emission test that no hint, group or repeat label, or validation message `<text>` carries an `image`, `audio`, `video` or `video-inline` form, and that a protected message carries no `__nova_mode;<medium>` form.
- Pure (the step): a fixture with each slot on each kind that had it.
- Real Postgres (the writer test): the fixture app's asset rows survive, its `media_asset_refs` rows for the removed slots are gone, and the deletion guard then allows a delete of an asset nothing else references.

**Lane.**
- The removal's proof is that no runtime shows the slots, so the three runs above become tests in this pull request, each over a form that still holds the slots. No document can hold them afterwards, so the form as the pre-fix emitter wrote it is kept as a file beside the tests and written into a fork of `media-rich`'s published app, as a spelling rule's test writes a form's source, and into a copy of its local archive for Android: `proof/android/predicates.py` (the views on each screen and after a refused answer), `proof/formplayer/test_media.py` (the question tree and the answer's refusal) and `proof/webapps/test_media.py` (the form's media elements and the group header), each with the question's own label media as its accepted case.
- Locally: `media-rich` (also named by `proof/hq/test_branches.py::DOCUMENTS`), whose bytes change, and the native `media` and `xml` families (`npm run proof -- proof/native -k xml` holds the protected-message boundary without the media forms). CI: the full lane with no entry moved by this block.

## The Hidden Value with neither a calculate nor a default

**Today.** `lib/domain/fields/hidden.ts::hiddenFieldSchema` already makes both slots optional, and `validator/rules/field.ts::hiddenNoValue` (`HIDDEN_NO_VALUE`) refuses a field with neither. Every authoring surface therefore seeds `lib/domain/fields/base.ts::HIDDEN_INERT_VALUE`, a default of `''`: `components/preview/form/newFieldDefaults.ts`, `lib/doc/hooks/useBlueprintMutations.ts` (convert to hidden) and `components/builder/editor/fields/hiddenValueModel.ts`.

Executed during planning: a data node with a bare bind, and beside it a node whose setvalue writes `''`, written by hand into the form of `targeted-load-time-values` in a fork. Vellum opened and saved the form twice; the bare node kept its data node and its bind and gained no setvalue; the second save stored what the first did; and `validate_app` reported nothing. In HQ's build of that form, the preload setvalue HQ adds for the form's case-loaded question sits after the form's own two (`xform.py::XForm.add_setvalue`). On Core, a bare node and one with the inert default both hold `''` once the form has loaded, and compare equal.

**Fix.** A Hidden Value with neither is valid, and the placeholder is deleted.

- Deleted: `hiddenNoValue` and `HIDDEN_NO_VALUE` (`validator/errors.ts`, `validator/gate.ts`, `lib/doc/userFacingErrors.ts`, the sample string in `app/(dev-only)/rejection-test/page.tsx`); `HIDDEN_INERT_VALUE` and its export in `lib/domain/fields/index.ts`; `hiddenValueModel.ts::isInertHiddenValue`.
- `HIDDEN_VALUE_EMPTY_PATCH` becomes `{ calculate: null, default_value: null }`; `hiddenValueModeSwitch` treats an absent default as nothing to carry.
- The blank-write note. One pure function beside `lib/domain/casePreload.ts::writerPreloadsFromLoadedCase`: `hiddenWriterBlankNote(field, module, form): string | undefined`, defined for a Hidden Value with no value and a `caseWrite`:
  - where the form preloads that property into it: "Opens with this case's current value and carries it through unchanged.";
  - where it does not: "Has no value yet, so each submission saves `<property>` blank."
- The note is shown by the builder (`hiddenValueModeHint`), and returned by the SA and MCP tools in the result of a call that leaves a hidden writer with no value (`edit_field`, `add_fields`), from that one function, so the three surfaces cannot drift.
- `saDocs` for the kind becomes "Value the user never sees. Give it a calculate expression or a default value; with neither it stays blank."
- A calculate of `''` is a calculate and is untouched: it is valid before and after, is no "Hidden Value with neither", and the step below leaves it. Executed during planning: a form holding one passes every check of the lane.

**Files.**
- Domain: `lib/domain/fields/base.ts`, `fields/hidden.ts`, `fields/index.ts`, `lib/domain/casePreload.ts`.
- Doc and mutations: `lib/doc/hooks/useBlueprintMutations.ts`, `lib/doc/userFacingErrors.ts`.
- Validator: `validator/rules/field.ts`, `validator/errors.ts`, `validator/gate.ts`.
- Emitters: none (`buildFieldParts` writes the setvalue only where a default exists).
- Preview: `components/preview/form/newFieldDefaults.ts`; the engine seeds a default only where one exists.
- Builder: `components/builder/editor/fields/hiddenValueModel.ts`, `HiddenValueEditor.tsx`, `components/builder/editor/fieldEditorSchemas.ts`; `app/(dev-only)/rejection-test/page.tsx`.
- SA and MCP tools: `lib/agent/tools/editField.ts`, `lib/agent/tools/addFields.ts` (the note in the result), `lib/agent/toolSchemaGenerator.ts` (descriptions; no schema shape changes, and the description change still calls for asking before `npm run test:schema`). Sweep `../nova-plugin` for the claim that a hidden field needs a value.
- Docs: `content/docs/building-with-nova.mdx` (the hidden value paragraphs).
- CLAUDE.md: `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md` ("Hidden fields carry one value source"), `components/builder/CLAUDE.md` (the hidden Value paragraph).
- Proof: the manifest entry "Hidden Value with neither" in `questions.json` drops its widen note.

**Stored shape and migration.** No schema change. Step `hidden-inert-default` removes `default_value` from every hidden field whose default is structurally the one text part `''` and which has no `calculate`. A hidden field whose `calculate` is `''` is left as it is. Nothing a worker or an export sees changes. Notice reason `hidden-value-saves-blank`, only for a writer the form does not preload: "`<form>`: `<field>` has no value, so each submission saves `<property>` blank. This is unchanged; Nova now says so where you set it." The scan splits its count by whether the field writes a property and whether the form preloads it.

**Register.** None. **Spelling rule.** None.

**Identity.** None: the setvalue of an inert default leaves the form's source, and no path moves. No entry in `proof/identity-moves.json`.

**Control.** None.

**Nova tests.** Pure: the validator admits neither and still refuses both; `hiddenValueModel` state tests for every gesture; `hiddenWriterBlankNote` for preload, no preload and no writer; a Preview engine state test that a bare hidden value opens blank; an emission test that a bare hidden value emits a data node and a bind and no setvalue; the step over a fixture holding an inert default, a blank calculate and both beside a case write. The writer test's fixture app holds one inert default.

**Lane.** No corpus document holds an inert default or a bare Hidden Value today, so one must: `targeted-load-time-values` gains one bare Hidden Value beside its existing fields, the document the shape was written into by hand above. Proof 4 then holds Vellum's two saves, and proofs 2 and 3 hold HQ's build and Core's run of it, on every pull request. Its control keeps the pre-fix bytes and its entries keep showing there and on the document. Locally: `npm run proof -- proof/checks -k targeted-load-time-values` and its control. CI: the full lane with no entry moved.

---

## Defect 6: ordering a time, and the three system dates in CSQL

**Today.** `lib/domain/predicate/typeChecker.ts::ORDERED_TYPES` holds `time`, so `checkComparison` and the `between` rule admit an ordering on a time in every Predicate slot. In form logic, `lib/commcare/validator/typeChecker.ts::checkTypes` flags only a non-numeric string literal, and a reference passes. `lib/commcare/predicate/csqlEmitter.ts::emitAbsenceSegments` prints `<property> = ''` for any property, and a comparison between `date_opened`, `closed_on` or `last_modified` and a value that is not a date is sent as written.

| Fact | Observed by |
|---|---|
| Core turns both sides of `<`, `<=`, `>`, `>=` into numbers, and a string holding any character but a digit, `-` or `.` is NaN, so an ordering on a time is always false (commcare-core `XPathCmpExpr.evalRaw`, `FunctionUtils.toNumeric`) | the lane's `d6-core-evaluate` |
| HQ's range query tries a number, then a date or datetime; a time of day or `''` raises `CaseFilterError` (`corehq/apps/case_search/xpath_functions/comparison.py::_case_property_range_query`) | the lane's `d6-csql-compile-time-ordering`. Executed during planning on HQ's compiler: `visit_time > '09:00:00'` and `visits > ''` raise; `visits > '3'`, `visits > 3` and `visits >= '2026-01-01'` compile |
| `date_opened`, `closed_on` and `last_modified` go to the system datetime query whatever the operator, and `''` or a non-date raises (`comparison.py::property_comparison_query`, `_create_system_datetime_query`; `corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY`) | the lane's `d6-csql-compile-date-opened-blank`. Executed during planning: `date_opened = ''`, `!= ''` and `>= ''`, `last_modified = ''`, `closed_on = ''`, `date_opened = 'abc'` and `date_opened = 3` raise; `date_opened >= '2026-01-01'` and `date_opened > '2026-01-01T10:00:00.000Z'` compile |
| `match-none()` is one of HQ's CSQL functions and composes | Executed during planning: `match-none()` compiles to `{"match_none": {}}`, and `name = 'x' and match-none()`, `name = 'x' or match-none()` and `not(match-none())` compile |

**Fix.** Four parts.

1. **Predicate slots.** `time` leaves `ORDERED_TYPES`. One edit serves `gt`, `gte`, `lt`, `lte` and `between` in every slot: case list filters, advanced search predicates, display conditions, case operation conditions, lookup select filters and search prompt rules. The `ordered-values` message becomes "A time of day can't be compared with before or after. CommCare compares these as numbers and a time is not one, so the comparison would never be true. A date can be compared this way." The sentence names a date and not a date and time, because an ordering on a date and time does not order by instant on a device until step 3 (finding 56). The authoring menus read the same set (`lib/domain/predicate/slotConstraints.ts`), so the builder stops offering the operators on a time, and the tool schemas derive from the same tables.

2. **Form logic.** New `lib/commcare/validator/timeOrdering.ts`:

   ```ts
   export interface TimeOrderingFinding { readonly from: number; readonly to: number; readonly operator: "<" | "<=" | ">" | ">="; }
   export function findTimeOrderingComparisons(
   	expression: XPathExpression,
   	context: { doc: BlueprintDoc; formUuid?: Uuid; printContext: XPathPrintContext },
   ): readonly TimeOrderingFinding[];
   ```

   It prints the expression, parses it with `lib/commcare/xpath/parser.ts`, and for every `LessThanExpr`, `LessEqualExpr`, `GreaterThanExpr` and `GreaterEqualExpr` node asks whether either operand is a time. Structure is read only through the grammar. An operand is a time when it is:

   | Operand | How it is known |
   |---|---|
   | a `field-ref` or `path-ref` leaf whose field's kind is `time` | the leaf, found by span as `lib/commcare/xpath/expressionAst.ts::collectLeafSpans` finds them; `lib/domain/fields/time.ts` |
   | the same leaf whose field is a hidden value with a calculate that is a time | the calculate's own value, recursively, with a visited set |
   | a `case-ref` leaf whose effective property type is `time` | `lib/domain/effectiveCaseTypes.ts` |
   | a string literal holding `:` | the literal's text |
   | `if(c, a, b)` or `coalesce(...)` with any branch a time | the call's arguments |
   | a parenthesized time | the inner expression |

   Everything else is not a time. This is the reading `proof/checks/manifest_value_classes.py::time_operand` applies to the emitted form, so the validator refuses exactly what the manifest calls the REFUSED class `time-operand`. A string literal holding `:` includes a date and time written as text, which the same Core function reads as NaN (executed during planning), so that one shape of finding 56 is refused here in form logic.

   New code `XPATH_TIME_ORDERING`, class soundness: "This comparison has a time of day, or text holding a colon, on one side. CommCare compares before and after as numbers, so it would never be true." It is wired in `lib/commcare/validator/index.ts` at the three places that call `validateXPath` (field slots, form-link slots, Connect slots), over the carriers `lib/commcare/xpath/carriers.ts::authoredXPathCarriers` lists, so a catalog property's `required` and `validation` are covered. `lib/codemirror/xpath-lint.ts` calls the same function, so the editor underlines the comparison. The signature stays this small so step 3's typed expression model replaces its body and not the rule.

3. **CSQL, a fixed value.** In `lib/commcare/predicate/csqlRepresentability.ts`, the walk `validator/rules/case-list/csqlPredicateRepresentability.ts` runs over every slot that reaches `_xpath_query` while case search is effective, a new `CsqlRepresentabilityReason` `system-datetime-value` under the existing code `CASE_LIST_CSQL_NOT_REPRESENTABLE`:
   - `is-blank` on `date_opened`, `closed_on` or `last_modified`: "CommCare's search can't ask whether `<label>` is blank. Every case has one."
   - `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in` or `between` anchored on one of them with a fixed value whose resolved type is not `date` or `datetime` (a null literal, text, a number): "`<label>` is compared with a date, or a date and time."

   The three names are a new exported constant `SYSTEM_DATETIME_CASE_PROPERTIES` in `lib/domain/standardCaseProperties.ts`, with the HQ citation in its comment. `closed_on` is in it although Nova reads no `closed_on` today, so the rule is total when step 7 adds it.

4. **CSQL, a runtime value: the emitter guards it.** No Predicate can spell "this runtime value is not blank" in a CSQL slot (`is-blank` admits only a property there, `csqlRepresentability.ts::checkPropertyOnlyLeft`, and `when-input-present` yields `match-all()` when absent), so neither an author nor a migration could write the guard. The emitter already has the mechanism: a typed obligation on a runtime segment replaces the whole clause with `'match-none()'` (`csqlEmitter.ts::wrapClause`, the typed condition). Step 2 adds one obligation, kind `blank-comparand` in `lib/commcare/predicate/csqlSegment.ts::RuntimeCsqlRejectionKind` (beside `quote`, `whole-number`, `nonnegative-whole-number` and `geopoint`; the name says what is refused, since the obligation covers an ordering on a number too), built in the new `lib/commcare/predicate/runtimeCsqlDateSafety.ts` and called from the three callers of `csqlEmitter.ts::emitComparisonOperandSegments` (the comparison, `in` and `between` arms), beside the `runtimeCsqlNumericSafety.ts` call: a runtime value compared by any operator with one of the three system dates, or by an ordering operator with any property, carries `rejectWhen: <value> = ''`. The clause is then `if(<value> = '', 'match-none()', <query>)`. Executed during planning on Core: that expression gives `match-none()` while the value is blank and `date_opened >= "2026-01-01"` once it holds a date, and HQ compiles both, where it refuses the unguarded `date_opened >= ''`. The obligation names no prompt, so no prompt validation is written for it, and under `when-input-present` it is conditioned on the trigger as every obligation is. There is no validator refusal and no migration for runtime values: the emitter is total by construction, and an existing document starts sending a search HQ accepts in place of one it refuses. The whole-clause scope is the numeric guard's existing meaning (an unusable runtime value finds nothing). Blank is the one value the guard covers, because the type checker already holds an ordered operand to a number, a date or a date and time.

**Files.**
- Domain: `lib/domain/predicate/typeChecker.ts`, `lib/domain/standardCaseProperties.ts`.
- Doc and mutations: `lib/doc/userFacingErrors.ts` (`XPATH_TIME_ORDERING`, the two `system-datetime-value` wordings).
- Validator: `lib/commcare/validator/timeOrdering.ts` (new), `validator/index.ts`, `validator/errors.ts`, `validator/gate.ts`; `lib/commcare/predicate/csqlRepresentability.ts`.
- Emitters: `lib/commcare/predicate/runtimeCsqlDateSafety.ts` (new), `csqlEmitter.ts`, `csqlSegment.ts`.
- Preview: none of its own; Preview evaluates the document, which no longer holds the comparison.
- Builder: `components/builder/shared/checkErrorPresentation.ts` (the same `ordered-values` wording, ending "A date can be compared this way."); `lib/codemirror/xpath-lint.ts`.
- SA and MCP tools: the generated tool schemas' operator descriptions name the ordered types (`lib/agent/toolSchemaGenerator.ts`); the implementer checks the generated text for "time" and asks before `npm run test:schema`. Sweep `../nova-plugin`.
- Docs: `content/docs/display-conditions.mdx` and `content/docs/case-workspace.mdx` (a time of day is not compared with before or after, and a date is; neither page says a date and time is).
- CLAUDE.md: `lib/domain/predicate/CLAUDE.md`, `lib/commcare/CLAUDE.md` ("Case-search emission": a further typed obligation beside the numeric and geopoint ones).
- Proof: `proof/targeted/documents/timeOrdering.ts` is deleted and its maker leaves `TARGETED_DOCUMENTS`; `proof/targeted/documents/searchApps.ts` keeps `targeted-search-hq-compile` as a witness with a fixed-date comparison on `date_opened` and a free-text input.

**Stored shape and migration.** No schema change. Step `time-ordering` walks the production carriers (`authoredXPathCarriers` for form logic; `validator/rules/case-list/moduleWireSlots.ts` and the other Predicate carriers), never a hand-written slot list:

| Shape | The step writes | Notice names |
|---|---|---|
| Predicate `gt`, `gte`, `lt`, `lte` with a time operand, or `between` anchored on a time | the comparison node replaced by `{ kind: "match-none" }`, in place | the slot and the comparison's printed text |
| Form-logic `<`, `<=`, `>`, `>=` with a time operand | the comparison's span replaced by `false()` in the printed source, outermost comparisons first, then re-parsed to the stored AST through `lib/commcare/xpath/expressionAst.ts::parseXPathExpression` with the form's resolver. A reference leaf inside the span goes with it, every leaf outside it resolves to the same identity as before, and the result must print as the edited source | the field or link and the comparison |
| CSQL slot: `is-blank` on a system date, or a fixed non-date value compared with one | the term replaced by `match-none` | the search and the term |

- Nothing is simplified after a replacement: the stored tree keeps `and(x, match-none)`, so the author sees where the comparison was. Form logic needs nothing more: executed during planning, a form whose calculate is `if(false(), 'a', 'b')` and whose label's display condition is `false()` passes every check of the lane.
- **Interaction with `hiddenFromMenu`.** The step only replaces the comparison and simplifies nothing. Where that leaves a module's or form's display condition as `match-none`, or an `and` whose first clause is `match-none` (the shape `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU` refuses), the `hidden-from-menu` step (part 06, 11. `hiddenFromMenu`: a menu or form that is not on the menu), which runs after it, sets `hiddenFromMenu` and keeps the rest, under its own reason `hidden-from-menu-set`. `time-ordering` writes no flag. Any other result (`and(x, match-none)`, `or(match-none, x)`, `not(match-none)`) stays an ordinary condition.
- **Search inputs.** No simple search input is migrated, settled at source: `range` mode is stored only on the `date-range` arm, and `lib/domain/modules.ts::SEARCH_INPUT_TYPE_PROPERTY_TYPES` admits that widget over `date` and `datetime` properties alone. An advanced input's predicate is covered by the first row.

Notice reasons: `time-comparison-never-true` ("`<where>`: `<comparison>` compares a time of day with before or after, which is never true on a device. It now reads as never true everywhere, Preview included."); and `search-term-matches-nothing` ("`<search>`: `<term>` is a check CommCare's search can't run. It now matches nothing, where the search failed before.").

**Register.** 11 entries.

| Part | Check | Ids | Control |
|---|---|---|---|
| Core | intent 1 | `d6-core-evaluate` (values pinned) | `targeted-time-ordering` |
| Core | manifest 2 | `d6-core-form-xpath-expr-xpathcmpexpr-time-operand`, `d6-core-form-xpath-token-lt-time-operand` | `targeted-time-ordering` |
| Core | manifest 2 | `d6-core-suite-xpath-expr-xpathcmpexpr-time-operand`, `d6-core-suite-xpath-token-gt-time-operand` | `targeted-search-hq-compile` |
| CSQL | manifest 4 | `d6-csql-suite-*` (2), `d6-csql-app-*` (2): `csql-metadata:date_opened/refused/non-date-value` and `csql-op:>/refused/untyped-right-side` | `targeted-search-hq-compile` |
| CSQL | intent 2 | `d6-csql-compile-time-ordering`, `d6-csql-compile-date-opened-blank` | `targeted-search-hq-compile` |

**Spelling rule.** None.

**Identity.** None. No entry in `proof/identity-moves.json`.

**Control.** `targeted-time-ordering` (manifest, intent) and `targeted-search-hq-compile` (manifest, intent) keep the pre-fix bytes and keep showing every class.

**Nova tests.**
- Pure (`lib/domain/predicate/__tests__/typeChecker.test.ts`): the `time` arm tests become refusals, each beside an accepted date comparison; `slotConstraints.test.ts` still matches its tables to `ORDERED_TYPES`.
- Pure (`lib/commcare/validator/__tests__/timeOrdering.test.ts`): each "is a time" shape refused and each neighbor accepted (a time compared with `=`, a date ordered, a hidden value whose calculate is a number, a text literal with no colon).
- Pure (`lib/commcare/predicate/__tests__/runtimeCsqlDateSafety.test.ts`): the wrapper Nova writes for a session value and for an input under `when-input-present`; a fixed date emits no guard; no prompt validation is added.
- Pure (the step): one fixture per row of the table, and three display conditions (one that becomes `match-none`, one that then starts with it, one that holds it later), each asserting only the replaced tree and no `hiddenFromMenu`. The flag is asserted by the `hidden-from-menu` step's own test and by the writer test over both steps.
- The writer test's fixture app holds one of each shape.

**Lane.**
- Native proof (`npm run proof -- proof/native -k search`, the family in which Core's query manager builds each payload and HQ's compiler compiles it): one fixture whose guarded comparison takes a blank runtime value and then a date, asserting Core builds `match-none()` and then the dated query and HQ compiles both. This is the reader proof of part 4, and it is the run made by hand above with Core's query manager in place of a bare evaluation.
- Locally: `targeted-search-hq-compile` (the document, now a witness whose `csql@A` intent check compiles every search) and the two controls. `targeted-time-ordering` leaves `index.json`. CI: the full lane, 11 entries moved.

## Finding 48: a search answer holding both quote marks

**Today.** For a free-text search answer that holds both `'` and `"`, the quote cascade sends the whole CSQL string `search-value-mixes-quote-marks()` (`lib/commcare/predicate/termEmitter.ts::CSQL_UNREPRESENTABLE_RUNTIME_STRING`, written by `csqlEmitter.ts::wrapClause` and `buildQuoteCascade`). What each reader does with it, each run on `targeted-search-hq-compile`:

| Reader | Observed |
|---|---|
| HQ's compiler | refuses the string: "'search-value-mixes-quote-marks' is not a valid standalone function" (executed during planning) |
| Formplayer | answers the search screen again with the prompt's validation message and sends HQ nothing; an answer with one kind of quote mark is sent and HQ compiles it (`proof/formplayer/test_search.py::test_formplayer_keeps_a_mixed_quote_answer_from_hq_and_sends_a_one_mark_answer`) |
| Android | holds no error for the prompt (`RemoteQuerySessionManager.getErrors` is empty) and sends `_xpath_query=search-value-mixes-quote-marks()`; when the server answers 400 it shows its own text, "Client-side error (code 400) received from network request.", never HQ's message (the Android reader, `QueryRequestActivity`) |

**Fix.** The cascade sends `match-none()`. `CSQL_UNREPRESENTABLE_RUNTIME_STRING` and its doc block go, and `wrapClause` and `buildQuoteCascade` write `'match-none()'` for a quote obligation, the sentinel the typed obligations already write, so `wrapClause`'s two `if` layers merge into one condition. Reasons: it is the only fail-closed value in HQ's CSQL vocabulary; an unknown function is a REFUSED surface class that step 6's reader would refuse in Nova's own export; the injection defense is unchanged, since no runtime byte reaches the CSQL grammar in that arm; and it is what Nova already does for a value that is not a number where one is needed.

Executed during planning, with `match-none()` written by hand in place of the function:

- HQ compiles `match-none()` to a filter that matches no case.
- On Android the screen sends `_xpath_query=match-none()`. Answered as HQ answers a search that finds nothing (200, no case), it shows the toast "Query response had no results" (`query.response.empty`), stays on the search screen, and the prompt still holds the answer and takes typing.
- On Formplayer nothing changes: the mixed answer is still stopped at the prompt with nothing sent, and the one-mark answer is still sent and compiled.

What a worker sees: on Android, "Query response had no results" on the search screen with the answer still editable, in place of a client error with a code. No channel on Android carries a reason. On Web Apps the prompt's validation message stops the search, as today. The builder's search input editor, the `add_search_inputs` description and the public docs say: "On Android, an answer that holds both ' and \" finds nothing."

**Files.**
- Emitters: `lib/commcare/predicate/termEmitter.ts`, `csqlEmitter.ts`, `runtimeCsqlQuoteSafety.ts` (comments).
- Domain, doc and mutations, validator, Preview: none.
- Builder: `components/builder/case-list-config/inspector/SearchInputEditor.tsx` (the sentence, on a free-text input).
- SA and MCP tools: `lib/agent/tools/case-list-config/addSearchInputs.ts` and `shared.ts` (the description: ask before `npm run test:schema`). Sweep `../nova-plugin`.
- Docs: `content/docs/case-workspace.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-search emission", the sentence naming the function).
- Proof: `proof/native/test_quote_payload.py`, `proof/native/core/CsqlQuoteRuntimeTest.java` and `StaticQuoteRuntimeTest.java` hold `match-none()` and that HQ compiles it (the `before-static-quote-branches` resource is a retained counterexample and stays). The authored surface key `csql-fn:search-value-mixes-quote-marks` (`proof/surface/families/authored.py`) and the manifest entry `case-search/a-function-on-the-left-side-a-property-on-the-right-side` stay: the two fixed entries pin that class on the control, whose bytes still hold the function, and the manifest check reads a control as it reads a document, so the key is still used. The key's `source` drops the deleted Nova symbol and its `novaWrites` says exports before step 2 wrote it. `npm run surface` regenerates `lib/commcare/surface/surface.json`.

**Stored shape and migration.** None.

**Register.** 2 manifest entries: `d48-mixed-quote-suite-csql-fn-search-value-mixes-quote-marks`, `d48-mixed-quote-app-csql-fn-search-value-mixes-quote-marks`, control `targeted-search-hq-compile`.

**Spelling rule.** None. **Identity.** None; no entry in `proof/identity-moves.json`.

**Control.** `targeted-search-hq-compile` keeps showing `/csql-fn:search-value-mixes-quote-marks/refused` under the manifest check.

**Nova tests.** Pure: the emitter's test for the cascade's three arms.

**Lane.**
- Native proof (`npm run proof -- proof/native -k quote`): Core's query manager builds the payload from a both-quotes answer, and HQ compiles it to its match-none filter.
- `proof/android/predicates.py`: over the control's local archive (the function, a 400, Android's client-error text) and over the document's (the same answer, `match-none()` sent, a 200 with no case, the empty-results toast and the prompt still holding the answer).
- `proof/formplayer/test_search.py`: the existing test, unchanged, over the document.
- Locally: `targeted-search-hq-compile` and its control. CI: the full lane, 2 entries moved.

---

## Defect 11, first half: the media formats every platform plays

**Today.** `lib/domain/multimedia.ts` accepts PNG, JPEG, GIF, WebP, MP3, WAV and MP4 (`IMAGE_MIME_TYPES`, `AUDIO_MIME_TYPES`, `VIDEO_MIME_TYPES`), and `lib/media/validate.ts::validateMediaBytes` checks no codec, brand or encoding. The stated reason for the short list is false: the comment on `AUDIO_MIME_TYPES`, `lib/media/CLAUDE.md`, and the header and description of `lib/mcp/tools/uploadMediaAsset.ts` say HQ validates a file's extension. That check (`corehq/apps/hqmedia/views.py::BaseProcessFileUploadView.validate_file`) belongs to HQ's single-file uploader, which Nova never calls. Nova's upload types each file by its bytes (`corehq/apps/hqmedia/tasks.py::process_bulk_upload_zip`, `corehq/apps/hqmedia/models.py::CommCareMultimedia.get_class_by_data`). A second false claim, that an unbundled media file fails to install, is in `lib/commcare/multimedia/mediaSuiteXml.ts`, `assetWirePath.ts`, `lib/commcare/validator/mediaSuiteOracle.ts` (comments and the text of `MEDIA_LOCATION_PATH_NOT_BUNDLED` and `MEDIA_LOCATION_UNKNOWN_AUTHORITY`) and a comment in `lib/commcare/__tests__/mediaSuiteOracle.test.ts`; and `proof/native/core/MediaRuntimeTest.java::actualMediaResourcesInstallOnlyWhenLocalBytesExist` tests a file-system install while `proof/README.md` describes it as the archive's.

**What was played.** One real file of each format, made with ffmpeg (a one-second tone, a 64 by 64 test pattern) or written byte by byte (the BMP variants ffmpeg does not write), on every reader named:

- **Android**, three emulator system images, arm64: Android 6.0 (API 23, CommCare Android's minimum), Android 10 (API 29) and Android 15 (API 35). Audio and video were read by `MediaExtractor` and decoded to the end of the stream by the platform's own `MediaCodec` decoder; images by `BitmapFactory`. No physical phone was run, and a phone's hardware decoders are not the emulator's.
- **Chrome** 154 on macOS, the full browser and not the headless shell: each audio and video file played to its end in a media element, and each image decoded.
- **HQ**, in the lane: `CommCareMultimedia.get_class_by_data` on each file, and the whole of `process_bulk_upload_zip` over one archive holding all of them into an app whose form names each, which matched every file to the slot of its kind with no error and no skipped file, but for the one near miss it is meant to miss.

| File | Android 6.0 | Android 10 | Android 15 | Chrome | HQ's class |
|---|---|---|---|---|---|
| BMP, 1, 4, 8, 16, 24 and 32 bits per pixel, `BITMAPINFOHEADER`; 24-bit `BITMAPV4HEADER`; 32-bit `BITMAPV5HEADER` | decodes | decodes | decodes | decodes | image (Pillow opens each) |
| M4A, brand `M4A ` or `M4B `, AAC | decodes | decodes | decodes | plays | audio |
| FLAC | decodes | decodes | decodes | plays | audio |
| Ogg Vorbis | decodes | decodes | decodes | plays | audio |
| Ogg Opus, named `.ogg` and `.opus` | decodes | decodes | decodes | plays | audio |
| WebM, VP8, alone and with Vorbis | decodes | decodes | decodes | plays | video |
| WebM, VP9 profile 0 (8-bit 4:2:0), alone and with Opus | decodes | decodes | decodes | plays | video |
| Near miss: WebM, VP9 profile 1 (4:4:4), which ffmpeg writes by default from an RGB source | refused by the decoder | refused by the decoder | decodes | plays | video |
| Near miss: WebM, VP9 profile 2 (10-bit) | refused by the decoder | decodes | decodes | plays | video |
| Near miss: WebM, AV1 | no track | refused by the decoder | decodes | plays | video |
| Near miss: M4A holding ALAC | no decoder | no decoder | no decoder | refused | audio |
| Near miss: Ogg Speex; FLAC in Ogg | no track | no track | no track | Speex refused; FLAC in Ogg plays | audio |
| Near miss: M4A branded `isom` | decodes | decodes | decodes | plays | video, so the upload leaves it unmatched in an audio slot |
| Near miss: an audio-only WebM | decodes | decodes | decodes | plays | video |

**Fix.** A format is accepted when every reader above took it and HQ types its bytes as the same kind. Six formats join, each admitted only in the variant that ran:

| Format | Manifest key | Canonical MIME, extension, kind | Sniff (`file-type`) | Body check beyond the sniff |
|---|---|---|---|---|
| BMP | `media-format:image/bmp` | `image/bmp`, `.bmp`, image | `image/bmp` | A header read in the new pure `lib/media/bmp.ts` (sharp has no BMP loader: executed, it answers "unsupported image format" for each): `BITMAPFILEHEADER` and a DIB header of 40, 108 or 124 bytes, one plane, compression `BI_RGB` or `BI_BITFIELDS`, 1, 4, 8, 16, 24 or 32 bits per pixel, width and height above 0, pixel-array offset and size inside the file. Dimensions come from the header. One image Pillow refuses stops HQ's whole upload: executed during planning, an archive holding a PNG, a BMP with an impossible pixel depth and a good BMP ended with "Error while processing zip: Upload is not a valid image file." and no file mapped, the two good ones included (`CommCareImage.attach_data`, `process_bulk_upload_zip`). Hence a reader of Nova's own. RLE compression and the 12-byte core header are refused although every reader above took one of each: the reader cannot hold an RLE stream's size to the file without decoding it, and each further variant is one more shape to keep proven |
| M4A | `media-format:audio/m4a` | `audio/mp4`, `.m4a`, audio | `audio/x-m4a` for the brand `M4A `, `audio/mp4` for `M4B ` | The `ftyp` major brand read from the bytes is exactly `M4A ` or `M4B `; one track, audio, codec `MPEG-4/AAC`, no video. A file branded `isom`, `mp42`, `mp41` or `dash` is refused with its own message, because HQ types it as video and an audio slot would never receive it |
| FLAC | `media-format:audio/flac` | `audio/flac`, `.flac`, audio | `audio/flac` | container `FLAC` |
| Ogg Vorbis | `media-format:audio/ogg-vorbis` | `audio/ogg`, `.ogg`, audio | `audio/ogg` | container `Ogg`, codec starting `Vorbis` |
| Ogg Opus | `media-format:audio/ogg-opus` | `audio/ogg`, `.ogg` (declared `.opus` accepted, as `.jpeg` is for `.jpg`), audio | `audio/ogg; codecs=opus` | codec `Opus`. Speex and FLAC in Ogg are refused |
| WebM | `media-format:video/webm-vp8`, `media-format:video/webm-vp9` | `video/webm`, `.webm`, video | `video/webm` | container `EBML/webm`; exactly one video track, `VP8` or `VP9`; every audio track `VORBIS` or `OPUS`, or none; and for VP9, profile 0, read from the first video frame by the new pure `lib/media/webm.ts`. AV1, Matroska (`file-type` sniffs it `video/matroska`) and an audio-only WebM are refused |

- **The VP9 profile reader.** `music-metadata` reports `VP9` for every profile, so `lib/media/webm.ts` walks the EBML itself: the Segment's Tracks for the first video track's number and `CodecID`, then the first Cluster's first `SimpleBlock` or `BlockGroup` `Block` of that track, whose first frame byte holds the frame marker (the top two bits are `10`) and the profile's low and high bits (the next two). It answers the profile, or that it could not find a frame, which is refused as unreadable. A laced block is refused the same way. Executed during planning as a prototype over the files above: it read profile 0, 1 and 2 from the three VP9 files and found no VP9 frame in the VP8, AV1 and audio-only ones.
- MP4 and WAV acceptance is unchanged in step 2; step 4 narrows both by declared platform. MP3, PNG, JPEG, GIF and WebP are unchanged. The size caps are unchanged.
- The container and codec spellings are `music-metadata`'s, as version 11.16.1 reported them for the files above (`FLAC`; `M4A/isom/iso2` or `M4B/isom/iso2` with `MPEG-4/AAC` or `ALAC`; `Ogg` with `Vorbis I`, `Opus`, `Speex 1.2.1` or `FLAC`; `EBML/webm` with `VP8`, `VP9`, `AV1`, `VORBIS`, `OPUS`). The library reads container structure and each track's codec id, not the payload or the AAC object type; that limit is stated in the code and in `lib/media/CLAUDE.md`.
- One registry replaces the hand-kept lists. `lib/domain/multimedia.ts` exports `ACCEPTED_FORMATS` (`{ mime, kind, extension, declaredExtensions, aliases, label, surfaceKeys }` per format). It holds every accepted asset format, the documents (PDF, text, DOCX, XLSX) included with `surfaceKeys: []`. `IMAGE_MIME_TYPES`, `AUDIO_MIME_TYPES`, `VIDEO_MIME_TYPES`, `ALL_MIME_TYPES`, `AssetMimeType`, `EXTENSION_FOR_MIME_TYPE` and `mimeTypeForExtension` derive from it and keep their exported names; the private `MIME_ALIASES` derives from it and stays private. The module gains a new export, `ACCEPTED_EXTENSIONS`, derived from it, and `lib/media/validate.ts` imports that in place of its own declaration, keeping its `AcceptedExtension` type. The MP4 and WAV entries name the `media-format:` items step 4 narrows to and carry a comment saying so.
- Claim aliases, so a browser's spelling is not read as a renamed file: `audio/x-m4a` and `audio/m4a` to `audio/mp4`; `audio/x-flac` to `audio/flac`; `audio/opus`, `audio/vorbis` and `application/ogg` to `audio/ogg`; `image/x-ms-bmp` and `image/x-bmp` to `image/bmp`.
- New failure reasons in `validate.ts`: `container-brand-not-accepted` and `codec-not-accepted`. The brand message: "This M4A is one CommCare HQ would file as video, so an audio slot would never receive it. Exporting it again as M4A (AAC) audio fixes that." The codec message: "This file's audio or video is encoded in a way some CommCare apps can't play (`<codec>`). Exporting it again as `<accepted codecs for the format>` fixes that." It serves ALAC in M4A, Speex and FLAC in Ogg, AV1 in WebM, an audio-only WebM, a second track, and a VP9 profile other than 0, for which `<codec>` reads "VP9 in 4:4:4 or 10-bit color" and the accepted list reads "VP8, or VP9 in 8-bit 4:2:0 color (ffmpeg's `-pix_fmt yuv420p`)".
- **The model-readable image subset.** BMP must not reach the model: `lib/agent/documentExtraction.ts` builds `MODEL_READABLE_FIGURE_TYPES` from `IMAGE_MIME_TYPES`, and `lib/agent/resolveAttachments.ts` and `lib/agent/sources.server.ts::loadImage` send any image asset with its own MIME. The domain exports `MODEL_READABLE_IMAGE_MIME_TYPES` (PNG, JPEG, GIF, WebP). `documentExtraction.ts` reads it; `resolveAttachments` and `loadImage` return the existing placeholder for an image outside it; the chat picker (`components/chat/ChatInput.tsx`, `CHAT_ATTACHMENT_KINDS`) shows a library BMP as unavailable ("The assistant can't read BMP images yet. A PNG or JPEG of it works.") and does not offer `.bmp` in its own upload. Transcoding BMP for the model is rejected: it adds a pixel decoder over untrusted bytes for a rare case.

**Files.**
- Domain: `lib/domain/multimedia.ts`.
- Doc and mutations: none.
- Validator: `lib/media/validate.ts` (its own `ACCEPTED_EXTENSIONS` declaration becomes the domain import; stage 4 dispatches on the sniffed MIME; one `parseBuffer` call shared with the duration read; the declared-extension family rule generalized), `lib/media/bmp.ts` (new), `lib/media/webm.ts` (new); `lib/commcare/validator/mediaSuiteOracle.ts` (comments and two messages, below).
- Emitters: `lib/commcare/multimedia/mediaSuiteXml.ts`, `assetWirePath.ts` (comments only; wire paths derive from hash and extension).
- Preview: none of its own. The builder's preview plays a file with the browser's own elements, which Chrome did for all six; another browser may not play one of them, and Preview then shows the element's own failure, as it does for any file.
- Builder: `components/builder/media/assetKindMeta.ts` (`extLabel` from the registry; `accept` becomes MIME types plus declared extensions, because browsers report `.m4a`, `.flac`, `.opus` and `.ogg` inconsistently), read by `MediaPickerDialog.tsx`; `components/chat/ChatInput.tsx`.
- SA and MCP tools: `lib/mcp/tools/uploadMediaAsset.ts` (header and description state the accepted set from the registry and drop "CommCare HQ can't ingest .m4a or .ogg": ask before `npm run test:schema`); `lib/agent/documentExtraction.ts`, `lib/agent/resolveAttachments.ts`, `lib/agent/sources.server.ts`. `app/api/media/upload/route.ts` needs no change: its refusal lists `ALL_MIME_TYPES`. Sweep `../nova-plugin` for mp3, wav, m4a and ogg.
- Docs: `content/docs/mcp/tools.mdx` (the `upload_media_asset` row); a short passage naming the accepted image, audio and video formats in `content/docs/building-with-nova.mdx`; one clause in `content/docs/attachments.mdx` saying its list is worker capture formats.
- CLAUDE.md: `lib/media/CLAUDE.md` ("Accepted formats are HQ-ingestion-bound" becomes the formats every platform plays, with the registry, the body checks, the devices they were played on and HQ's true path); `lib/domain/CLAUDE.md` (the registry and the model-readable subset).
- Infrastructure: `scripts/rollout/verify-runtime-packages.mjs` gains one tiny real buffer per lazily loaded `music-metadata` parser now in use (Ogg, FLAC, Matroska, MP4), beside its WAV probe, so a parser missing from the standalone image fails the build and not every upload of that format.
- Proof: `lib/commcare/surface/media-formats.json` (each of the six items' Android and web readings become `executed`, naming the three images, Chrome's version and the profile; the VP9 item says profile 0; its `documentation` entries stay as background); `lib/commcare/surface/entries/expressions-and-data.json` (the `widen` halves of `image-bmp`, the M4A and FLAC entry, `audio-ogg-vorbis-or-opus` and the WebM entry are marked done; the `narrow` halves stay for step 4); the native `media` family and the decode probe, below.

The comment and test corrections, each stating what a reader did:

- Executed during planning on the Android reader: Nova's local archive of `media-rich` installs, and the same archive with one media file taken out is refused (`MissingResourcesWithMessage`). On Formplayer: HQ's build of the same document installs and runs from the archive HQ's download arranges, which holds the media suite and none of the files it names. The lane's Core admits that same archive on every document that carries media.
- So the headers of `mediaSuiteXml.ts` and `assetWirePath.ts`, the two comments and the two finding messages in `mediaSuiteOracle.ts`, and the comment in `mediaSuiteOracle.test.ts` say: an archive install on Core and on Formplayer does not notice a missing media file (commcare-core `ArchiveFileReference.doesBinaryExist`; formplayer `FormplayerArchiveFileRoot.derive`); Android unzips the archive and copies each file (commcare-android `InstallArchiveActivity`, `FileSystemInstaller.install`), so a missing file fails the install there; the bundling proof is therefore the oracle's own `bundledPaths` join. `MEDIA_LOCATION_PATH_NOT_BUNDLED` names Android as the runtime that refuses.
- `MediaRuntimeTest.actualMediaResourcesInstallOnlyWhenLocalBytesExist` is renamed for what it is, the file-system install (Android's shape). A new archive test opens the `<scenario>.ccz` the producer already writes, registers it with Core's `ArchiveFileRoot`, and for every media resource asserts that (1) the archive reference installs, (2) a reference to a `missing-` sibling also installs, which records that Core's archive install is not the bundling proof, and (3) the zip holds an entry at the location's path whose SHA-256 is the hash in its name. `proof/README.md` ("Media (`media`)") and the docstring of `proof/native/test_media_emission.py` follow.

**Stored shape and migration.** None: `media_assets.mime_type` is `text` with no check constraint, and this half only widens. No notice.

**Register.** None (defect 11 has no entry). **Spelling rule.** None. **Identity.** None; no entry in `proof/identity-moves.json`. **Control.** None.

**Nova tests.**
- Pure, real bytes (`lib/media/__tests__/validate.test.ts`): one accepted fixture per new format with its kind, canonical MIME, extension, and dimensions or duration; and one near miss per refusal, each first shown to pass the earlier gates: M4A branded `isom`; `M4A ` holding ALAC; Ogg Speex; FLAC in Ogg; WebM holding AV1; WebM holding VP9 profile 1; WebM holding VP9 profile 2; audio-only WebM; a Matroska file named `.webm`; BMP with RLE compression; BMP with a 12-byte core header; a truncated BMP. Fixtures are small committed files under `lib/media/__tests__/fixtures/`, generated once with ffmpeg from a one-second sine tone and a 64 by 64 test pattern (`-c:a aac -f ipod` for M4A, with `-brand 'M4B '` for M4B, `-c:a alac -f ipod`, `-c:a aac -f mp4` for the `isom` brand, `-c:a flac`, `-c:a libvorbis`, `-c:a libopus`, `-c:a libspeex`, `-c:a flac -f ogg`, `-c:v libvpx -f webm`, `-c:v libvpx-vp9 -pix_fmt yuv420p -f webm` for profile 0, the same with no `-pix_fmt` for profile 1 and with `-pix_fmt yuv420p10le` for profile 2, `-c:v libaom-av1 -f webm`, `-c:a libopus -f webm`, `-c:v libvpx -f matroska`); the commands are recorded in a comment at the top of the test. The BMP fixtures ffmpeg does not write (1-bit, 4-bit, V4, V5, RLE, core header) are built in the test from bytes. These are the files that were played.
- Pure (`lib/media/__tests__/webm.test.ts`): the profile reader over the same fixtures.
- Pure (`lib/domain/__tests__/multimedia.test.ts`): the registry's derivations (every alias and declared extension resolves only through its own entry; an inherited object key resolves to nothing), and the model-readable subset is exactly four types.
- Pure (`lib/commcare/surface/__tests__/manifest.test.ts`): every `surfaceKeys` entry of the registry exists in `media-formats.json`, reads `executed` on both platforms, and has an HQ class matching the registry's kind. It lives there because `lib/domain` may not import `lib/commcare`.
- Pure: `resolveAttachments` returns the placeholder for a BMP; the figure set excludes it.

**Lane.**
- HQ: the native `media` family (`npm run proof -- proof/native -k media`) gains one real file of each new format in the slot of its kind (`lib/commcare/__tests__/mediaWireFixtures.ts::mediaManifest`, `proof/native/producers/emit-media-evidence.ts`, `proof/native/steps/media_emission.py`, `proof/native/test_media_emission.py`), so HQ's whole `process_bulk_upload_zip` must finish with no error, skipped or unmatched file and class each as Nova does. Its asserted counts change. This is the run made by hand above.
- Android: `proof/android/decode/` (new): the probe that was run (`DecodeProbe.java`, built against the SDK's `android.jar` and run on a device with `app_process`), and `run.sh <avd>`, which boots an image without a window, pushes `lib/media/__tests__/fixtures/` and prints each file's decoder and frame count. A unittest beside it, in the shape of `proof/android/selfcheck.py`, holds every accepted fixture to a full decode and each profile near miss to its refusal on the API 23 image. It runs wherever an emulator runs; part 09 says where the Android reader runs in CI. `lib/commcare/surface/media-formats.json` records the image fingerprints of the run its readings were taken from.
- Chrome: one Playwright test, `e2e/tests/browser/media-play.spec.ts`, launched with `channel: "chrome"` because the bundled headless shell lacks AAC, plays each accepted fixture to its end and decodes each BMP. A second smoke in `e2e/tests/browser/media-transport.spec.ts` uploads an `.m4a` and an `.opus` file through the media picker: the claimed MIME is a browser behavior no unit test stands in for.
- Android install: `proof/android/predicates.py` gains the missing-file install above. Formplayer: `proof/formplayer/test_media.py` (the media slots block's file) holds that the build installs from the archive without the files.
- CI: the full lane with no register change.

---

## Finding 56: ordering a date and time never orders by instant on a device

**Today.** `lib/domain/predicate/typeChecker.ts::ORDERED_TYPES` admits `datetime`, and Nova emits the comparison bare: `lib/commcare/predicate/caseListFilterEmitter.ts::emitPredicate` writes `<left> <op> <right>`, with operands from `lib/commcare/expression/onDeviceEmitter.ts::emitOnDeviceExpression` (a property as its casedb path, a literal as a quoted string through `termEmitter.ts::emitOnDeviceLiteralValue`, `now` as `now()`). Nothing lowers or refuses it. Defect 6 covers a time of day only.

Executed during planning against Core at the pin, in three device time zones with the same results:

| Operand at run time | Examples | Result |
|---|---|---|
| A date and time held as text | a custom datetime case property, a literal, a lookup column, a worker property, a search input | NaN to `FunctionUtils.toNumeric`, so every ordering is false, in both directions |
| A typed `Date` | `now()`, a datetime answer in a form | ordered by calendar day only: two values one hour apart are not `<`, and are both `<=` and `>=` |
| A `date-coerce` or `datetime-coerce` of text (emitted as `date(...)`) | a coerced case property or literal | a `Date` with a clock, so day only as the row above; and `date()` of text that is not a date throws, where the bare comparison is a quiet false |
| `date_opened`, `last_modified` | Core holds them as dates | unchanged: already documented as calendar dates |

A second executed fact decides the fix's shape: Core's parse of an offset-bearing date and time (`DateUtils.parseTimeAndStore`) converts the clock to the reader's zone and keeps the written date, so `date(<text>)` is a whole day wrong whenever the reader's local date for that instant differs from the written one. No single wrapper is right for every operand. CSQL is a separate dialect and is correct: HQ's range query parses a date or datetime and compares instants (`date_opened > '2026-01-01T10:00:00.000Z'` compiles to a range on the instant, executed during planning).

**Fix.** Step 2 observes it and does not fix it. The fix is step 3's, whose typed expression model owns per-operand lowering: it chooses there between a zone-proof arithmetic conversion of the text and a refusal. `3-expressions.md` carries the finding and these requirements: the lowering is chosen per operand from its type, never by wrapping the whole comparison; `date()` is never applied to `now()` or a typed answer; date against date stays bare; date against datetime is refused by the type checker, so a date operand meets a datetime only through an explicit coercion, and it then enters the lowering as the UTC-midnight day number, agreeing with the UTC-day rule in `lib/domain/predicate/CLAUDE.md`, Preview and CSQL; a lowering that applies `date()` to text does not throw on malformed text where today's comparison is false; no on-device wrapper leaks into a CSQL segment; and a native proof runs the ordering in at least two device zones with a value written in a third. The one shape step 2 closes is a date and time written as a string literal in form logic, which defect 6's `XPATH_TIME_ORDERING` refuses because the literal holds a colon.

What step 2 adds, in pull request 1 (lane mechanics):

This block is the document's definition; part 09, Finding 56: an ordering comparison on a datetime never orders by instant, defers to it. The document, its expectations and its entries below were built and run through the whole lane during planning: the bar, the manifest check, proofs 1 to 5 and configuration sensitivity pass on it, and the intent check reports exactly the two classes the entries name.

- **Document** `targeted-datetime-ordering` (`proof/targeted/documents/datetimeOrdering.ts`, registered in `TARGETED_DOCUMENTS`), `rows: ["56"]`, the one row `proof/README.md` gains:
  - A menu with no case type and one survey form, "Visit instants": two datetime questions, `start` and `end`, and a hidden value `order` whose calculate is `if(#form/start < #form/end, 'start before end', 'start not before end')`. This is the typed-answer row of the table.
  - A menu over the case type `visit` (properties `due` and `seen`, both datetime, and `notes`, text) with two forms. A registration form, "Book": a text question saving the case's name, then datetime questions `due` and `seen`, each saving its property. It is there so HQ knows both properties, without which Vellum reports "Unknown question: #case/due" on the next form; and its two writers sit in name order, because HQ's build writes a case update's properties in name order and the local archive in field order. A follow-up form, "Check": a text question `notes` saving `notes`; hidden values `seen` and `due` whose default values are `#visit/seen` and `#visit/due`; and a hidden value `order` whose calculate is `if(#form/seen < #form/due, 'seen before due', 'seen not before due')`. The two defaults hold the case's text, so this is the text row of the table.
  - `restore.xml`: one case, `targeted-visit`, whose `seen` is `2026-03-01T10:00:00.000Z` and whose `due` is a day later.
  - Four intent expectations, one per form on each of the `local` and `A` exports: `start-before-end-local` and `start-before-end-a` answer `start` with `2026-03-01T10:00:00.000Z` and `end` an hour later and hold `/data/order` to `start before end`; `seen-before-due-local` and `seen-before-due-a` open "Check" on the fixed case (`session.command` `m1-f1`, `case_id` in its data) over the restore and hold `/data/order` to `seen before due`.
  - It holds no string literal and no time, so it stays admitted through defect 6's fix. The text row is shown in a form and not in a case list filter, where the outline's draft had it: the manifest's `time-operand` reader reads a form's nodes and not a case property in a suite's nodeset, and reports an ordering there as undecided, which no register entry may hold (`proof/checks/registers.py`). Run as first drafted, with a filter comparing the two properties, the manifest check failed on exactly that. In the form, both operands are nodes the reader reads, and the manifest check reports nothing.
- **Entries** in `proof/known-defects.json`, defect `56`, check `intent`, path `/values/*/value`: `d56-datetime-ordering-evaluate-answers` (artifact `evaluate:start-before-end-*`, values pinned `start before end` to `start not before end`) and `d56-datetime-ordering-evaluate-case-text` (artifact `evaluate:seen-before-due-*`, values pinned `seen before due` to `seen not before due`). Each shows on both exports.
- **Control** `targeted-datetime-ordering`, retained in the same pull request for the intent check.
- **Record.** `docs/research/2026-09-26-hq-round-trip/harness-findings.md` gains finding 56 with the table above.

**Files.** Proof only: the document, which holds its expectations in its own file as `timeOrdering.ts` holds its `expectation` (`proof/targeted/expected.ts` gives the types and does not change), `proof/targeted/index.ts`, the two entries, the control directory, `harness-findings.md`, the row in `proof/README.md`, `proof/timings.json` (the new control group). Domain, doc and mutations, validator, emitters, Preview, builder, SA and MCP tools, docs, CLAUDE.md: none in step 2.

**Stored shape and migration.** None.

**Register.** Nothing moves to the fixed register: the two entries are added and stay live through step 2. The step's exit says the register holds no entry for 31 and up except finding 56.

**Spelling rule.** None. **Identity.** None; no entry in `proof/identity-moves.json`.

**Control.** `targeted-datetime-ordering` shows both symptoms under the intent check from pull request 1 on.

**Nova tests.** `proof/targeted/__tests__/targeted.test.ts` (pure) covers the new maker with every other targeted document: it is built twice alike, the gate admits it, and each expectation names a form it holds. No other Nova test in step 2: the harm is in Core, which the lane runs.

**Lane.** Locally, in pull request 1: `npm run proof -- proof/checks -k targeted-datetime-ordering` and `-k control-targeted-datetime-ordering`. CI: the full lane with two more live entries, each seen on its document and on its control. Step 3's fix brings the native proof named above.
