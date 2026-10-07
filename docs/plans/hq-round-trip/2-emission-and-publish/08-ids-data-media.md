# Step 2, part 08: Work items D and E: identifiers, form content, lookup tags, CSQL, media and the model clean-up (defects 6, 11, 15, 16; findings 31, 43, 44, 48, 56)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part plans two pull requests of the stack and one targeted document of a third:

| Pull request | What this part plans in it |
|---|---|
| 1, lane mechanics | Finding 56's targeted document, entries and control |
| 10, identifiers and form content | Defect 15, findings 31, 43, 44 |
| 14, lookup, CSQL, media and the model clean-up | Defect 6, finding 48, defect 11 (first half), defect 16 (all but hidden columns), the Hidden Value with neither a calculate nor a default |

Defect 5 (lookup tags and table content) lands in pull request 14 too and is planned in part 02, Defect 5: the lookup push, beside the drift check whose table baselines its refusals read. Defect 16's hidden columns are planned in part 07, Hidden columns: defect 16's column half, findings 35 and 36.

## What every block below shares

- **Where a narrowing lives.** Every rule this part adds lives in the validator (`lib/commcare/validator`) and in the verdicts the builder and the tools call before dispatch (`lib/doc/identifierVerdicts.ts`). No persisted Zod schema narrows. Reasons: a persisted schema states what the store can hold, and a pattern added there makes a stored document unreadable before the cutover's transform reaches it; the validator names the rule that failed and offers the replacement id; and one predicate in `lib/domain` then serves the validator, the builder, the tools and the migration. The two exceptions are schema removals (the three media slots) and the tool input schemas named in each block.
- **The cutover.** Each stored-shape change is one step of the cutover's pure transform (`scripts/lib/hqRoundTripCutover/steps/`), registered in `transform.ts` in the same pull request as the fix, with its notice reason added to `DOCUMENT_NOTICE_REASONS` (`lib/notices/migrationNotice.ts`) and its renderer to `lib/notices/migrationNoticeCopy.ts`. The one registry of step ids and notice reasons is part 10, The transform steps, in order, and this part uses its names verbatim; a pull request inserts its step at its registered position, never at the end. The steps of this part run in this registered order, after the identity additions: `media-slots`, `hidden-inert-default` (removals); `question-ids`, `case-operation-ids`, `connect-ids`, `entry-point-ids`, `option-values` (renames); `empty-forms`; then `time-ordering`, which runs before the `hidden-from-menu` step of part 06, 11. `hiddenFromMenu`: a menu or form that is not on the menu. Their modules are `steps/mediaSlots.ts`, `steps/hiddenInertDefault.ts`, `steps/questionIds.ts`, `steps/caseOperationIds.ts`, `steps/connectIds.ts`, `steps/entryPointIds.ts`, `steps/optionValues.ts`, `steps/emptyForms.ts` and `steps/timeOrdering.ts`. The three id steps share one relative-path rewrite module. The scan (`scripts/scan-hq-round-trip-cutover.ts`) reports each step's count per app, and the three scan-blocking cases of defect 15 and finding 43 stop the cutover before its first write.
- **How a notice names an entity.** Each step records the entity's uuid. The notice writer resolves the form's and the field's displayed name from the final document after every step has run, so a removal notice written before a rename names the id the builder shows afterwards. The rename notices alone carry `from`.
- **Registers.** A fix moves its entries from `proof/known-defects.json` to `proof/fixed-defects.json` in its own pull request, each keeping its id and its `control`, and each must still show on that control. The control directories named below are never re-retained.
- **Identity.** `proof/identity-moves.json` gains no entry from this part. Proof 1 compares two exports of one document made by one revision, so a migration or an emitter change moves both sides alike and no listed move could ever be matched. Each one-time change is listed in its block, written into the migration notice, and held by the cutover's tests over the frozen pre-step fixtures (`scripts/lib/hqRoundTripCutover/__tests__/fixtures/pre-step/`).
- **Lane.** "Locally" means `npm run proof -- proof/checks -k <document id>` and `-k control-<name>` for the documents and controls a block names, plus `npm run proof -- proof/native -k <family>` where a native family changes. Each pull request also runs the corpus emission first (no Docker), diffs `index.json`'s document ids before and after, and rewrites or removes every document a narrowing refuses. CI's full lane must be green at the pull request's own head with both registers as the block states them.
- **Paid check.** A block that changes a tool input schema or a tool description says so. The implementer asks the person before running `npm run test:schema`, which bills one live request per schema.
- **Model context.** Pull requests 10 and 14 each change the tool catalog (the entry-point and case operation id inputs in 10, `attach_field_media`'s slots in 14), so each bumps `lib/models.ts::MODEL_CONTEXT_VERSION`, as every pull request of the stack that changes the catalog does. Part 11, The model-addition checklist, item 13, is the one list of them and of the value each sets.
- **The sibling plugin.** A `../nova-plugin` sweep that finds a claim records it for that repository's own pull request (part 11, House rules for the stack, rule 11), which merges after the deploy. Nothing in `../nova-plugin` changes in pull requests 10 or 14.
- **Routes.** No block here adds an `/api` route. A new one would need its allowlist entry in `lib/hostnames.ts`.

---

## Defect 15: identifiers HQ's editors refuse

**Today.** Nova admits ids HQ's editors refuse. A question id is `lib/commcare/constants.ts::XML_ELEMENT_NAME_REGEX` (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`), applied by `lib/commcare/validator/rules/field.ts::invalidFieldId` and `lib/doc/identifierVerdicts.ts::formatVerdict`, and no rule refuses `meta`. A Connect block id is `lib/domain/forms.ts::connectIdSchema` (the same pattern, 1 to 50 characters), and `lib/commcare/connectSlugs.ts::deriveConnectId` mints through `lib/commcare/identifierValidation.ts::toSnakeId`, which turns `1st visit` into `_1st_visit`, so Nova itself mints an id Vellum refuses. An entry-point id is `lib/domain/entryPoints.ts::entryPointIdSchema` (`/^[a-z0-9_-]+$/`). A case operation id and a link identifier are `lib/domain/caseOperationIdentifiers.ts::CASE_OPERATION_IDENTIFIER_REGEX` (`/^[A-Za-z_][A-Za-z0-9_]*$/`).

Upstream facts the fix rests on:

| Fact | Source |
|---|---|
| A question id must match `/^(?!XML)[a-zA-Z][\w-]*$/` (the `XML` test is case-sensitive), and `meta` in any case is an error. Every data-bearing mug inherits the rule: questions, groups, repeats, Hidden Values, Save to Case blocks, Connect blocks | Vellum `src/util.js::isValidElementName`; `src/mugs/baseSpecs.js` (`databind.nodeID.validationFunc`) |
| A Connect block's inner `id` is written from the wrapper's question id | Vellum `src/commcareConnect.js` (`baseMugOptions.dataChildFilter`, `parseDataNode`) |
| A Save to Case property or relationship name must match `/^[a-z][\w-]*$/i` | Vellum `src/saveToCase.js::validatePropertyNameChars` |
| HQ's build removes a root data node named `meta` or `Meta`, after which Core cannot install the form | `xform.py::XForm.already_has_meta`; the lane's `d15-question-ids-admission-unresolved-resource` |
| An endpoint id must equal `slugify(id)`, or the save answers 400 | `views/utils.py::get_cleaned_session_endpoint_id`, reached from `set_session_endpoint` and `set_case_list_session_endpoint` |
| Connect keys a learn module, a deliver unit and a task type by the block's `@id`; `LearnModule.slug` and `TaskType.slug` hold 50 characters | commcare-connect `commcare_connect/form_receiver/processor.py::get_or_create_learn_module`, `get_or_create_deliver_unit`, `process_task_modules`; `commcare_connect/opportunity/models.py` |
| A delivery under an unknown deliver unit fails with "Payment unit is not configured for the deliver unit" | commcare-connect `commcare_connect/form_receiver/processor.py::process_deliver_unit` |

The editor facts are observed by the lane today (the 12 entries below). That the migrated shape is accepted rests on reading and is confirmed in this pull request by the rewritten documents (see Lane).

**Fix.** One grammar in the domain, read by every surface.

New `lib/domain/questionId.ts`:

- `QUESTION_ID_PATTERN = /^(?!XML)[A-Za-z][A-Za-z0-9_]*$/`. Nova keeps refusing a hyphen, which Vellum accepts, because `XML_ELEMENT_NAME_REGEX` never admitted one.
- `RESERVED_QUESTION_IDS`: `meta` compared lowercased, and the exact names `instance`, `bind`, `parsererror` (finding 43).
- `questionIdProblem(id)`: `"leading-underscore" | "not-letter-first" | "xml-prefix" | "reserved-name" | "characters" | undefined`.
- `editorSafeQuestionId(id)`, the one normalizer the migration and every minter use: (1) drop leading underscores; (2) prepend `q` when what remains is empty, does not start with a letter, or starts with `XML`; (3) prepend `q_` when the result is a reserved name. So `_notes` becomes `notes`, `_1st` becomes `q1st`, `XMLcode` becomes `qXMLcode`, `Meta` becomes `q_Meta`. The caller settles a collision with `lib/domain/idSlug.ts::suffixUntilFree` (`_2`, `_3`), the policy Nova already uses for ids it mints. (Generated node names count from `_1`; that is the allocator's rule, not this one.)

| Id kind | Rule from step 2 | Where it is applied |
|---|---|---|
| Question id | `QUESTION_ID_PATTERN`, not in `RESERVED_QUESTION_IDS` | `validator/rules/field.ts::invalidFieldId` (code `INVALID_FIELD_ID`, message by `questionIdProblem`); `lib/doc/identifierVerdicts.ts::formatVerdict`, so the builder's rename field, `add_fields` and `edit_field` refuse before dispatch |
| Connect block id | the question rule, 1 to 50 characters | `lib/commcare/connectSlugs.ts::connectIdError` (code `CONNECT_ID_INVALID_FORMAT` in `validator/rules/form.ts`); `deriveConnectId` mints through `editorSafeQuestionId`, and `toSnakeId`'s digit arm, the source of the underscore, is replaced by it |
| Entry-point id | `/^(?!.*--)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/`: exactly the ids among Nova's admitted ones that `slugify` leaves unchanged (starts and ends with a letter or digit, no doubled hyphen) | `validator/rules/app.ts::validEntryPoints` (code `ENTRY_POINT_INVALID`); exported from `lib/domain/entryPoints.ts` as `entryPointIdProblem` |
| Case operation id | the question rule | `lib/domain/caseOperationIdentifiers.ts::isCaseOperationIdentifier` and `CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE`; `identifierVerdicts.ts::caseOperationIdVerdict`; `validator/rules/caseOperations.ts` (code `CASE_OPERATION_INVALID_ID`) |
| Link identifier | `CASE_OPERATION_PROPERTY_REGEX` (`/^[A-Za-z][A-Za-z0-9_]*$/`, letter first), and not `instance`, `bind` or `parsererror`. `meta` and an `XML` prefix stay admitted: a link identifier is an index name, not a question | `identifierVerdicts.ts::caseOperationLinkIdentifierVerdict`; the link rule in `validator/rules/caseOperations.ts` (code `CASE_OPERATION_LINK_INVALID`) |

The operation and link predicates, which share one regex and one message today, part:

- `CASE_OPERATION_IDENTIFIER_REGEX` is deleted. `isCaseOperationIdentifier(id)` becomes `questionIdProblem(id) === undefined`, and it serves operation ids only.
- `CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE` becomes "Start with a letter; use only letters, digits, or underscores." The reserved-name and `XML` cases take `questionIdProblem`'s messages.
- The link paths (`caseOperationLinkIdentifierVerdict` and the link rule) switch to `isCaseOperationProperty` and `CASE_OPERATION_PROPERTY_FORMAT_MESSAGE`, then refuse the three reserved names with finding 43's reason.
- In `lib/agent/tools/case-operations/shared.ts`, `operationIdInputSchema` and `linkIdInputSchema` both take `.regex(CASE_OPERATION_PROPERTY_REGEX, CASE_OPERATION_PROPERTY_FORMAT_MESSAGE)` as their `pattern`, so the provider's strict schema gains no lookahead. The `XML` prefix and the reserved names are refused by a `.superRefine` over the verdict (`caseOperationIdVerdict` for an operation id, in the place of the `__nova_` refine pull request 7 removes (part 05, Reserved names and wrapper containers (defect 13)); `linkIdInputSchema` already calls `caseOperationLinkIdentifierVerdict`).

`XML_ELEMENT_NAME_REGEX` itself is unchanged: `FormPath`, search input names, relation identifiers and tile grouping identifiers use it and are not question ids.

Messages name the actual problem and offer the replacement, for example: "A question ID can't start with an underscore, because CommCare HQ's form builder can't keep it. `notes` is free here." and "`meta` is a name CommCare keeps for the form's own details. `q_meta` is free here."

**Files.**
- Domain: `lib/domain/questionId.ts` (new); `lib/domain/entryPoints.ts` (`entryPointIdProblem`; `entryPointIdSchema` unchanged); `lib/domain/caseOperationIdentifiers.ts` (`CASE_OPERATION_IDENTIFIER_REGEX` deleted, operation ids take the question rule, the message reworded; the header comment that allows a leading underscore is rewritten).
- Doc and mutations: `lib/doc/identifierVerdicts.ts`; `lib/doc/userFacingErrors.ts` (`INVALID_FIELD_ID`, `CONNECT_ID_INVALID_FORMAT`, the entry-point and operation messages).
- Validator: `lib/commcare/validator/rules/field.ts`, `rules/form.ts`, `rules/app.ts`, `rules/caseOperations.ts`; `lib/commcare/connectSlugs.ts`; `lib/commcare/identifierValidation.ts`.
- Emitters: none.
- Preview: none (Preview runs the document).
- Builder: `components/builder/detail/formSettings/LearnConfig.tsx`, `DeliverConfig.tsx`, `components/builder/detail/appSettings/connectDraft.ts`, `components/builder/app-setup/DeepLinksSection.tsx` (each calls the same predicate).
- SA and MCP tools: `lib/agent/tools/shared/connectIds.ts`; `lib/agent/tools/entry-points.ts` (the new test is a `.refine` plus the description, and the `pattern` stays, so the provider's strict schema gains no lookahead); `lib/agent/tools/case-operations/shared.ts::operationIdInputSchema` and `linkIdInputSchema` (the `pattern` of each changes, as above). All three are tool-schema changes: ask before `npm run test:schema`. The question id description in `lib/agent/toolSchemaGenerator.ts` already says "starting with a letter" and carries no `pattern`. Sweep `../nova-plugin` for "letter or underscore".
- Docs: `content/docs/mcp/tools.mdx` (the entry-point sentence and the operation id sentence), `content/docs/case-changes.mdx` ("start with a letter or underscore"), `content/docs/deep-links.mdx`.
- CLAUDE.md: `lib/domain/CLAUDE.md` (the one question-id grammar), `lib/doc/CLAUDE.md` (verdicts).

**Stored shape and migration.** No schema change. Steps `question-ids` (`steps/questionIds.ts`), `case-operation-ids` (`steps/caseOperationIds.ts`) and `connect-ids` (`steps/connectIds.ts`), in that order and sharing one relative-path rewrite module, then step `entry-point-ids`:

1. Per scope, valid ids are taken first. Each failing id is normalized and suffixed until free: a question among its siblings; a case operation within its form; a Connect id app-wide, cut at the tail so the id with its suffix fits 50 characters; an entry-point id app-wide after stripping leading and trailing `-` and `_` and collapsing each run of hyphens to one, `entry` when nothing survives.
2. The rename writes the entity's `id`. Identity leaves (`field-ref`, `path-ref`, prose reference atoms) follow by construction: they store the uuid and print the current name.
3. Relative paths in text runs are rewritten through Nova's XPath grammar, never by pattern, by the module the three id steps share. For every XPath slot the registry lists (`lib/domain/referenceSlots.ts::fieldReferenceSlotsFor`, `FORM_REFERENCE_SLOTS`), the step prints the expression with the pre-rename names, parses it with `lib/commcare/xpath/parser.ts`, and takes each name step that no leaf span covers and no `instance()` path owns (the reading `lib/commcare/xpath/expressionAst.ts::collectLeafSpans` and `hasExplicitPathContext` give). A relative path (a chain of `..`, `.` and name steps at the expression's own context, or rooted at `current()`) is resolved step by step against the form tree from the carrier question. Where a step resolves to a renamed question, that step's characters are rewritten inside its text part. Leaves are untouched.
4. A name step equal to an old id that does not resolve this way is left alone and reported.

Scan-blocking (the cutover stops for a person; none is expected):

| Case, with its blocker code | Why it is not migrated | What the person does |
|---|---|---|
| A link identifier that starts with an underscore, or is `instance`, `bind` or `parsererror` (`link-identifier-reserved`) | It is the index name on cases already in HQ and in Nova's case store. A rename would orphan the old index on existing cases | Before the window, the app's owner accepts that cases already linked keep the old index name, renames the connection in the builder (the rules before the cutover admit both names), and the scan is run again |
| An unresolved name step equal to an old id, item 4 (`unresolved-relative-path`) | Which node it meant is a person's call. The agent authoring boundary refuses such paths, but the builder's expression editor admits them | Before the window, a person edits the expression in the builder to a reference chip or to the path that was meant, and the scan is run again |
| A case property named `instance`, `bind` or `parsererror` written by a block in a form's source (`reserved-property-write`) | Finding 43, below | Before the window, a person moves the write to another property name in the builder, and the scan is run again |

For each case the scan's report gives the blocker code, the count and the app ids; the form, the entity and the old value are that report's detail, printed for one app under `--debug-details` (part 10, Scripts and their layout, under "The report"). The cutover has no override: it runs only when the scan reports none. All three are decided, for the reasons in the table: a rename of any of them would change the identity of data that already exists, or would guess at what a person meant. Part 10, The cutover and work item F (the migration notice), registers the three blocker codes.

Notice reasons, as part 10 registers them, each naming the form and the entity with `from` and `to` (`connect-block-renamed` also names the block kind):

| Reason | What the notice says |
|---|---|
| `question-renamed` | "`<form>`: the question `<from>` is now `<to>`, because CommCare HQ's form builder can't keep the old ID. Submissions use the new name from your next publish. In CommCare HQ, a form export column or report that reads `<from>` stops filling and a new `<to>` column starts." |
| `case-operation-renamed` | "`<form>`: the case change `<from>` is now `<to>`. Its place in each submission moves with the name from your next publish." |
| `connect-block-renamed` | "`<form>`: the Connect block `<from>` is now `<to>`. CommCare Connect reads it as a new block: deliveries under a renamed deliver unit wait until an opportunity manager assigns a payment unit, the old learn module stays counted, and a renamed task matches no task type until one is set up." |
| `entry-point-renamed` | "The deep link `<from>` is now `<to>`. Links shared with the old ID stop working after your next publish." |

**Register.** 12 entries, all on document and control `targeted-invalid-question-ids`:

| Check | Count | Ids |
|---|---|---|
| bar | 1 | `d15-question-ids-admission-unresolved-resource` |
| manifest | 3 | `d15-question-ids-form-instance-invalid-question-id-9f9c`, `d15-ids-form-instance-authored-meta`, `d15-ids-app-not-a-slug-or-duplicated` |
| proof4 | 8 | `d15-question-ids-vellum-mug-nodeid-error-not-valid-question-*` (2), `d15-question-ids-vellum-again-mug-nodeid-error-not-valid-question-*` (2), `d15-question-ids-editor-view-form-form-meta-block`, `d15-entry-point-ids-editor-*` (3) |

**Spelling rule.** None retires.

**Identity.** Once per deployed app, at its next publish: the data path of each renamed question, Save to Case block and Connect block; each renamed session endpoint id; each Connect block id. A staged, unsubmitted capture on a renamed question is orphaned until its seven-day expiry. No entry in `proof/identity-moves.json`.

**Control.** `targeted-invalid-question-ids` keeps the pre-fix bytes and keeps showing all 12 classes under the bar, manifest and proof 4.

**Nova tests.**
- Pure (`lib/domain/__tests__/questionId.test.ts`): `questionIdProblem` and `editorSafeQuestionId`, each refusal beside an accepted neighbor (`xmlcode` accepted, `XMLcode` refused; `metadata` accepted, `Meta` refused).
- Pure: `entryPointIdProblem` agrees with a transcription of Django's `slugify` over a generated set of admitted ids.
- Pure: `deriveConnectId("1st visit", ...)` is letter-first and within 50 characters with a suffix.
- Pure (validator): each of the five id kinds refused and accepted through `runValidation`; the builder verdicts return the same verdict as the validator for the same id.
- Pure (the steps): the `question-ids`, `case-operation-ids`, `connect-ids` and `entry-point-ids` steps over a frozen pre-step fixture holding `_notes`, `XMLcode`, `Meta`, a colliding sibling, `../_notes` in a calculate, a `current()/../_notes` default, a Connect block `_lesson`, an operation `_close`, and an entry point `intake_`; and one fixture for each blocking case.
- Real Postgres (`scripts/lib/hqRoundTripCutover/__tests__/writer.postgres.test.ts`): that fixture app comes out gate-clean with the expected ids, the relative paths rewritten, the horizon baseline written and the notice rows present.

**Lane.** Locally: `targeted-invalid-question-ids` and `targeted-invalid-connect-ids`, both rewritten in place as the migrated shape (the second stays a Connect app), plus `control-targeted-invalid-question-ids`. The rewritten documents are the positive witness: Vellum's two saves, the form settings save and the endpoint saves report nothing on them, and Core installs HQ's build. Decided fallback: where an editor still reports an id on a rewritten document, the pattern narrows to what it reports and the step follows, in this pull request. CI: the full lane with 12 entries fewer in the live register and 12 more in the fixed one.

## Finding 43: names that stop HQ's form builder opening a form

**Today.** A question may be named `instance` or `bind` (`validator/rules/field.ts::invalidFieldId` admits both), and `lib/commcare/__tests__/xformDocArbitrary.ts` draws both on purpose. Vellum then cannot open the form: `src/parser.js::_getInstances` runs `xml.find("instance")` over the whole document and throws on a second instance with no id, and `parseXForm` hands every `bind` under the head to `parseBindList`, which fails on one with no `nodeset`. Both are observed by the lane. A third name rests on reading alone: `parseXForm` runs `xml.find('parsererror')` over the whole document and throws when it finds one. Each search is by bare element name at any depth, so it reaches every element Nova writes in a form's source: a question, an operation's wrapper, a Connect wrapper, a Save to Case property leaf and an index child. `itext` is harmless (`src/javaRosa/plugin.js` skips a language that is not the app's) and stays admitted.

**Fix.** The exact, case-sensitive names `instance`, `bind` and `parsererror` are refused as:

- a question id, a case operation id and a Connect block id, through `RESERVED_QUESTION_IDS` (defect 15);
- a link identifier (defect 15's table);
- a case property name written by a block in a form's source: a case operation's write, the derived selected-cases update, or a source-lowered subcase. New code `CASE_PROPERTY_NAME_STOPS_FORM_BUILDER`, class soundness, located at the operation or field: "CommCare HQ's form builder can't open a form that saves a property named `<name>` from a case change. Save it under another property name here." A property written only through a basic action is not refused, because HQ's build adds that block and the form's source never holds it. Step 5 inherits the rule for every write when every write becomes a Save to Case block.

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

`parsererror` is refused on reading alone. The refusal costs one name, so no lane observation is added for it.

**Files.**
- Domain: `lib/domain/questionId.ts` (`RESERVED_QUESTION_IDS`).
- Doc and mutations: `lib/doc/userFacingErrors.ts` (the new code).
- Validator: `validator/rules/sourceCaseWrites.ts` (new, registered with the form rules in `validator/index.ts`), `validator/rules/caseOperations.ts` (the link identifier's three names), `validator/errors.ts`, `validator/gate.ts`.
- Emitters: `lib/commcare/xform/sourceCaseWrites.ts` (new); `lib/commcare/expander.ts` and `lib/commcare/xform/caseOps.ts` call its predicates, with byte-identical output.
- Preview, builder: none beyond defect 15's verdicts.
- SA and MCP tools: the write-property description in `lib/agent/tools/case-operations/shared.ts` names the three names (a description change: ask before `npm run test:schema`).
- Docs: `content/docs/case-changes.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("An answer named `secret`, `bind`, or `translation` is ordinary data" is true of Core and of Nova's oracle; it gains that HQ's form builder cannot open a form holding `bind`, `instance` or `parsererror`, so the validator refuses them).
- Tests and generators: `lib/commcare/__tests__/xformDocArbitrary.ts` stops drawing `instance` and `bind` (it keeps `secret` and `translation`).

**Stored shape and migration.** No schema change. The `question-ids`, `case-operation-ids` and `connect-ids` steps rename a question, operation or Connect block with one of the three names to `q_<name>` with the standard suffix, under `question-renamed`, `case-operation-renamed` or `connect-block-renamed`. A property write of one of the three names from a source block is scan-blocking and is not migrated: a property name is the identity of data on existing cases.

**Register.** 5 entries on document and control `targeted-reserved-node-names`: manifest 1 (`d43-instance-node-form-instance-second-instance-without-id`); proof4 4 (`d43-instance-node-vellum-load-multiple-unnamed-instance`, `d43-instance-node-vellum-page-errors-multiple-unnamed-instance`, `d43-bind-node-vellum-load-typeerror-cannot-read`, `d43-bind-node-vellum-page-errors-typeerror-cannot-read`).

**Spelling rule.** None.

**Identity.** The data path of each renamed question or block, once. No entry in `proof/identity-moves.json`.

**Control.** `targeted-reserved-node-names` keeps showing Vellum's two load failures and the manifest class.

**Nova tests.** Pure: the validator rules, each refusal beside an accepted neighbor (`instances`, `Bind`), with the property rule shown on an operation write, on a field of a several-case form and on an extension subcase's field, and accepted on a field whose write rides a basic action; the existing emission tests hold the output byte-identical over the extracted predicates; a test that pins `RESERVED_QUESTION_IDS`, with a comment citing the three Vellum searches, so a removal is a reviewed change; the `question-ids`, `case-operation-ids` and `connect-ids` steps over a fixture holding each name; the blocking fixture for a source-block property write.

**Lane.** Locally: `targeted-reserved-node-names`, rewritten in place with `q_instance`, `q_bind` and `q_parsererror` as the witness that Vellum opens and saves the migrated form, and its control. The fuzz sample's documents keep their ids and change content. CI: the full lane, 5 entries moved.

## Finding 44: duplicate option values

**Today.** Two options of one select may share a value: `lib/domain/fields/base.ts::selectOptionSchema` has no uniqueness and `validator/rules/field.ts::selectOptionValueInvalid` checks each value alone. A case property's option catalog (`lib/domain/blueprint.ts::casePropertySchema`, an array) can hold the same. Vellum reports "This choice value has been used in the same question" on exact string equality among siblings (`src/mugs/types/select.js`) and then shows "Form has validation errors." on every save (`src/core.js`, `validateForSave`). An export of such a form cannot say which option was chosen.

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

**Today.** `validator/rules/form.ts::emptyForm` asks only whether the root holds a non-section field or a non-empty section, so a form whose only content is an empty group or repeat passes. HQ's build then refuses it as a "blank form": `helpers/validators.py::FormBaseValidator.validate_for_build` requires `any(not q.get('is_group') for q in questions)` over `xform.py::XForm.get_questions`, where a group or repeat control is a group and every other control or controlless leaf counts. The lane observes it.

**Fix.** `emptyForm` passes when the form holds, at any depth, a field whose kind is not `group`, `repeat` or `section`. Nova asks for a field a person authored and does not copy HQ's counting of generated leaves (a count node, a Save to Case leaf), so a form of empty containers and case operations is refused too. The code stays `EMPTY_FORM`, class completeness, with three messages: no fields; sections with nothing on them (today's); and "This form has sections or groups and no question in them yet. Add a question, a label or a hidden value." `lib/doc/scaffolds.ts` already starts every form with a text question, so no scaffold changes.

**Files.**
- Validator: `validator/rules/form.ts`. Doc and mutations: `lib/doc/userFacingErrors.ts` (the third wording).
- Domain, emitters, Preview, builder, SA and MCP tools, docs: none.
- CLAUDE.md: none.
- Tests: in `lib/commcare/__tests__/expander.test.ts`, under the `describe` "empty container expansion", the test "emits an empty <group> wrapper when a group has zero children" keeps its title, keeps asserting the empty group's emission, and its form gains a question.

**Stored shape and migration.** No schema change. Step `empty-forms` (`steps/emptyForms.ts`), after `option-values`: for each form with fields and no question, add one Label at the root (inside the first section when the form is sectioned, since a sectioned root admits only sections), id `note` suffixed until free, text "This form has no questions yet." as the Label's own text. Reason for adding and not refusing: the gate judges the whole document, so an app holding such a form could commit nothing after the cutover; a Label is the smallest content that satisfies Nova's rule and HQ's, the author sees it as the thing to replace, and nothing is removed. Notice reason `empty-form-label-added`: "`<form>` had no questions, and CommCare HQ won't build a form like that. It now has one label to replace with your first question." Expected count in production: none.

**Register.** 1 entry: `d31-empty-groups-validate-blank-form` (bar), control `expander-empty-container-expansion-emits-an-empty-group-86a5cfc1-0`.

**Spelling rule.** None.

**Identity.** None: a node is added, none moves. No entry in `proof/identity-moves.json`.

**Control.** That control keeps showing HQ's `validate_app` refusal under the bar.

**Nova tests.** Pure (validator): each refusal beside an accepted form (a group holding only a hidden value; a repeat holding a label). Pure (state model, over the commit gate): removing the last question of a form that still holds an empty group is refused with the new message, and moving the only question into a group is accepted. Pure (the step): a flat form and a sectioned form. The writer test's fixture app holds one such form.

**Lane.** Locally: the control and the document. The expander test keeps its title, so its document keeps the id `expander-empty-container-expansion-emits-an-empty-group-86a5cfc1-0` (an expander id is the slug and hash of the test's title plus its index, `proof/corpus/documents.ts::readExpanderCapture`) and only its bytes change; the `index.json` diff must show no id added or removed by this block. The document then shares its name with the control, which a control may; the control keeps the pre-fix bytes and the document no longer shows the bar's refusal. CI: the full lane, 1 entry moved.

## Vellum's warning-only names: outside step 2

Vellum warns, and does not error, on a question id of `case`, `registration` or `script` in any case (`src/mugs/baseSpecs.js`, `RESERVED_NAMES`, "may cause problems with form parsing"). Step 2 refuses none of them: an editor warning leaves the form inside what HQ's editors produce and keep, and no check of the lane reports a warning-level id as a difference. No rule, migration or document is added for them.

---

## Defect 16: what the code, the tools and the docs say

**Today.** Comments, type comments, tool descriptions and one public page state CommCare facts that are false, and one validator code has no rule. (The dead function that orders setvalues no emitter writes, `builder.ts::isRepeatCountSnapshot`, goes in pull request 7: part 05, Reserved names and wrapper containers (defect 13).)

**Fix.** Each row is corrected to the right-hand column. No behavior changes in this block.

| Where | What it says | What is true, with the evidence |
|---|---|---|
| `lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES` (comment) | "plus `owner_id` which HQ also rejects in update blocks" | HQ supports an `owner_id` update (`xform.py::autoset_owner_id_for_open_case`). The set keeps `owner_id` as Nova's own rule, and the comment gives Nova's reason |
| `lib/commcare/hqShells.ts` and `lib/commcare/types.ts` (comments on target-owned settings) | `case_sharing` and `cloudcare_enabled` are target-owned | Both are app content that an update writes. The comments list only what the target owns |
| `FIXTURE_REFERENCE_NOT_MODELED` in `validator/errors.ts`, `validator/gate.ts`, `lib/doc/userFacingErrors.ts` | a validator code | No rule produces it. All three entries are deleted |
| `lib/domain/modules.ts::idMappingEntrySchema`, `imageMapEntrySchema` (comments and both schema messages) | `selected()` "splits both sides on whitespace" | commcare-core `XPathSelectedFunc.multiSelected` trims only the key and tests `(" " + value + " ").contains(" " + key + " ")`. The schemas keep refusing blank and multi-word values until step 7 holds them. The message becomes "A mapping value is one word with no spaces." |
| `lib/commcare/xform/captureUpload.ts` (comment) | Android's `WidgetFactory` has no `face` branch | commcare-android `WidgetFactory.createWidgetFromPrompt` builds `FaceCaptureWidget` for `face`. Comment only; step 2 does not add `face` |
| `lib/domain/fields/file.ts` (header and `saDocs`); `content/docs/attachments.mdx` ("File attachments only work in the web app") | Android has no document upload and shows a text box | commcare-android `WidgetFactory.createWidgetFromPrompt` builds `DocumentWidget` for `CONTROL_DOCUMENT_UPLOAD`; commcare-core `XFormParser` sets that control type; HQ offers the question from 2.57 (`feature_support.py::support_document_upload`), which is step 2's version floor. The header, the `saDocs` and the docs section say the File question works in Web Apps and in the Android app |
| `HIDDEN_VALUE_BOTH_SOURCES` and its echoes: `validator/rules/field.ts::hiddenValueBothSources`, `lib/domain/fields/hidden.ts`, `lib/agent/tools/editField.ts`, `lib/agent/toolSchemaGenerator.ts::gateHiddenValueSources`, `lib/doc/userFacingErrors.ts`, `lib/domain/effectiveCaseTypes.ts::inferHiddenWriterType`, `components/builder/editor/fields/hiddenValueModel.ts`, `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md` | the default "is overwritten before anyone could read it" | A later setvalue can read it, and in a repeat row on Android it can outlast the calculate. Every place says only that Nova does not yet write a Hidden Value's default beside its calculate. One exported constant, `HIDDEN_VALUE_ONE_SOURCE_SENTENCE` in `lib/domain/fields/hidden.ts`, holds the sentence: "A hidden value takes a calculation or a starting value. Nova doesn't yet write both on one field." `lib/commcare/validator/gate.ts` was checked: it holds the code's class and no claim to correct |
| `lib/domain/multimedia.ts::AUDIO_MIME_TYPES` and its three echoes | HQ validates a media file's extension | Defect 11's block below |
| The headers of `lib/commcare/multimedia/mediaSuiteXml.ts` and `assetWirePath.ts`, the two comments and the two finding messages in `lib/commcare/validator/mediaSuiteOracle.ts`, and the comment in `lib/commcare/__tests__/mediaSuiteOracle.test.ts` | an unbundled file fails to install | Defect 11's block below |

Dead code, none removed here:

- `lib/commcare/xform/builder.ts::isRepeatCountSnapshot`, its two filters in `buildXForm` and the comment above them are not this block's: pull request 7 deletes them with the prefix (part 05, Reserved names and wrapper containers (defect 13)).
- `lib/commcare/constants.ts::RESERVED_XFORM_NODE_PREFIX` and its stale comment are not this block's either: the same pull request deletes the constant.

**Files.** Domain: `lib/domain/modules.ts`, `lib/domain/fields/file.ts`, `lib/domain/fields/hidden.ts`, `lib/domain/effectiveCaseTypes.ts`. Doc and mutations: `lib/doc/userFacingErrors.ts`. Validator: `lib/commcare/constants.ts`, `validator/errors.ts`, `validator/gate.ts`, `validator/rules/field.ts`. Emitters: `lib/commcare/hqShells.ts`, `lib/commcare/types.ts`, `lib/commcare/xform/captureUpload.ts` (comments only). Preview: none. Builder: `components/builder/editor/fields/hiddenValueModel.ts`. SA and MCP tools: `lib/agent/tools/editField.ts`, `lib/agent/toolSchemaGenerator.ts` (descriptions: ask before `npm run test:schema`); sweep `../nova-plugin` for the File and hidden-value claims. Docs: `content/docs/attachments.mdx`. CLAUDE.md: `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`.

**Stored shape and migration.** None: nothing stored changes.

**Register.** None. `proof/README.md` ("What the lane does not observe") lists defect 16's comments, dead code and copy.

**Spelling rule.** None.

**Identity.** None. No entry in `proof/identity-moves.json`.

**Control.** None.

**Nova tests.** Pure: the classified-code renderer test fails if `FIXTURE_REFERENCE_NOT_MODELED` keeps a renderer; the ID-mapping schema test reads the new message.

**Lane.** Locally: none beyond the pull request's other blocks. CI: the full lane with no entry moved by this block and no document's bytes changed by it.

## Defect 16: three media slots leave the model

**Today.** A field may carry `hint_media` and `validate_msg_media`, and a group or repeat `label_media` (`lib/domain/fields/base.ts`, the ten validatable kinds' files). `lib/commcare/xform/builder.ts::buildFieldParts` emits all three as itext media forms, and Preview shows hint media and container label media. No CommCare runtime shows any of them:

| Slot | Why no device shows it |
|---|---|
| Hint media | formplayer `PromptToJson.parseQuestion` sends the hint as text only; commcare-android `QuestionWidget` and `QuestionsView` read `getHintText()` only |
| Group and repeat label media | Web Apps renders media only from `corehq/apps/cloudcare/templates/cloudcare/partials/form_entry/question.html`; a group caption reads `caption` and `caption_markdown`. Android's group caption is `QuestionsView`'s `getLongText()` |
| Validation-message media | The only callers of `FormEntryPrompt.getConstraintText` are commcare-android `FormEntryActivity` and formplayer `JsonActionUtils`, both with no text form |

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

**Stored shape and migration.** The three keys leave the strict field schemas, so a pre-step document holding one does not parse under the new schema and a history row carrying one does not replay. That is one of the reasons the cutover is a fold horizon. Step `media-slots` deletes `hint_media`, `validate_msg_media` and a group's or repeat's `label_media` from each field. It deletes no asset: the library is the Project's, another app may use the file, and the cutover rebuilds the app's exact media reference projection from the target document (`lib/db/canonicalCommitKernel.ts::replaceExactMediaReferencesForApp`), so `lib/media`'s deletion guard stops counting these references and a person may remove a file nothing else uses. Notice reason `media-slot-removed`, naming the form, the field, the slot and the asset's name: "`<form>`, `<field>`: the `<image, audio or video>` on its `<hint, validation message or section title>` was removed. No CommCare app shows media there, so workers see no change. The file is still in your media library."

**Register.** None.

**Spelling rule.** None.

**Identity.** None in HQ's stored identities. The built media suite of an app that used a slot loses those resources at its next publish. No entry in `proof/identity-moves.json`.

**Control.** None.

**Nova tests.**
- Pure: schema parse tests that each removed key is refused on each kind; `collectAssetRefs` no longer reports the slots; an emission test that no hint, group or repeat label, or validation message `<text>` carries an `image`, `audio`, `video` or `video-inline` form, and that a protected message carries no `__nova_mode;<medium>` form.
- Pure (the step): a fixture with each slot on each kind that had it.
- Real Postgres (the writer test): the fixture app's asset rows survive, its `media_asset_refs` rows for the removed slots are gone, and the deletion guard then allows a delete of an asset nothing else references.
- Native proof: `npm run proof -- proof/native -k xml` holds the protected-message boundary without the media forms.

**Lane.** Locally: `media-rich` (also named by `proof/hq/test_branches.py::DOCUMENTS`), whose bytes change, and the native `media` and `xml` families. CI: the full lane with no entry moved by this block.

## The Hidden Value with neither a calculate nor a default

**Today.** `lib/domain/fields/hidden.ts::hiddenFieldSchema` already makes both slots optional, and `validator/rules/field.ts::hiddenNoValue` (`HIDDEN_NO_VALUE`) refuses a field with neither. Every authoring surface therefore seeds `lib/domain/fields/base.ts::HIDDEN_INERT_VALUE`, a default of `''`: `components/preview/form/newFieldDefaults.ts`, `lib/doc/hooks/useBlueprintMutations.ts` (convert to hidden) and `components/builder/editor/fields/hiddenValueModel.ts`. HQ's form builder keeps a Hidden Value with neither as a data node and a bare bind (Vellum `src/mugs/defaultOptions.js::getSetValues` writes a setvalue only where a default is set), and an inert default and no default load alike, because HQ's preload setvalues are appended after the form's own (`xform.py::XForm.add_setvalue`).

**Fix.** A Hidden Value with neither is valid, and the placeholder is deleted.

- Deleted: `hiddenNoValue` and `HIDDEN_NO_VALUE` (`validator/errors.ts`, `validator/gate.ts`, `lib/doc/userFacingErrors.ts`, the sample string in `app/(dev-only)/rejection-test/page.tsx`); `HIDDEN_INERT_VALUE` and its export in `lib/domain/fields/index.ts`; `hiddenValueModel.ts::isInertHiddenValue`.
- `HIDDEN_VALUE_EMPTY_PATCH` becomes `{ calculate: null, default_value: null }`; `hiddenValueModeSwitch` treats an absent default as nothing to carry.
- The blank-write note. One pure function beside `lib/domain/casePreload.ts::writerPreloadsFromLoadedCase`: `hiddenWriterBlankNote(field, module, form): string | undefined`, defined for a Hidden Value with no value and a `caseWrite`:
  - where the form preloads that property into it: "Opens with this case's current value and carries it through unchanged.";
  - where it does not: "Has no value yet, so each submission saves `<property>` blank."
- The note is shown by the builder (`hiddenValueModeHint`), and returned by the SA and MCP tools in the result of a call that leaves a hidden writer with no value (`edit_field`, `add_fields`), from that one function, so the three surfaces cannot drift.
- `saDocs` for the kind becomes "Value the user never sees. Give it a calculate expression or a default value; with neither it stays blank."

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

**Stored shape and migration.** No schema change. Step `hidden-inert-default` removes `default_value` from every hidden field whose default is structurally the one text part `''` and which has no `calculate`. Nothing a worker or an export sees changes. Notice reason `hidden-value-saves-blank`, only for a writer the form does not preload: "`<form>`: `<field>` has no value, so each submission saves `<property>` blank. This is unchanged; Nova now says so where you set it." The scan splits its count by whether the field writes a property and whether the form preloads it.

**Register.** None. **Spelling rule.** None.

**Identity.** None: the setvalue of an inert default leaves the form's source, and no path moves. No entry in `proof/identity-moves.json`.

**Control.** None.

**Nova tests.** Pure: the validator admits neither and still refuses both; `hiddenValueModel` state tests for every gesture; `hiddenWriterBlankNote` for preload, no preload and no writer; a Preview engine state test that a bare hidden value opens blank; an XForm oracle test that a bare hidden value emits a data node and a bind and no setvalue; the step over a fixture. The writer test's fixture app holds one inert default.

**Lane.** Locally: any document with a bare hidden value (`npm run proof -- proof/checks -k arithmetic`); bytes change, ids stay. CI: the full lane with no entry moved.

---

## Defect 6: ordering a time, and the three system dates in CSQL

**Today.** `lib/domain/predicate/typeChecker.ts::ORDERED_TYPES` holds `time`, so `checkComparison` and the `between` rule admit an ordering on a time in every Predicate slot. In form logic, `lib/commcare/validator/typeChecker.ts::checkTypes` flags only a non-numeric string literal, and a reference passes. `lib/commcare/predicate/csqlEmitter.ts::emitAbsenceSegments` prints `<property> = ''` for any property, and a comparison between `date_opened`, `closed_on` or `last_modified` and a value that is not a date is sent as written.

| Fact | Source |
|---|---|
| Core turns both sides of `<`, `<=`, `>`, `>=` into numbers, and a string holding any character but a digit, `-` or `.` is NaN, so an ordering on a time is always false | commcare-core `XPathCmpExpr.evalRaw`, `FunctionUtils.toNumeric`, `checkForInvalidNumericOrDatestringCharacters`; the lane's `d6-core-evaluate` |
| HQ's range query tries a number, then a date or datetime; a time of day, other text or `''` raises `CaseFilterError` | `corehq/apps/case_search/xpath_functions/comparison.py::_case_property_range_query` |
| `date_opened`, `closed_on` and `last_modified` go to the system datetime query whatever the operator, and `''` or a non-date raises | `comparison.py::property_comparison_query`, `_create_system_datetime_query`; `corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY` |
| `match-none()` is one of HQ's CSQL functions | `corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS` |

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

4. **CSQL, a runtime value: the emitter guards it.** No Predicate can spell "this runtime value is not blank" in a CSQL slot (`is-blank` admits only a property there, `csqlRepresentability.ts::checkPropertyOnlyLeft`, and `when-input-present` yields `match-all()` when absent), so neither an author nor a migration could write the guard. The emitter already has the mechanism: a typed obligation on a runtime segment replaces the whole clause with `'match-none()'` (`csqlEmitter.ts::wrapClause`, the typed condition). Step 2 adds one obligation, kind `blank-comparand` in `lib/commcare/predicate/csqlSegment.ts::RuntimeCsqlRejectionKind` (beside `quote`, `whole-number`, `nonnegative-whole-number` and `geopoint`; the name says what is refused, since the obligation covers an ordering on a number too), built in the new `lib/commcare/predicate/runtimeCsqlDateSafety.ts` and called from the three callers of `csqlEmitter.ts::emitComparisonOperandSegments` (the comparison, `in` and `between` arms), beside the `runtimeCsqlNumericSafety.ts` call: a runtime value compared by any operator with one of the three system dates, or by an ordering operator with any property, carries `rejectWhen: <value> = ''`. The clause is then `if(<value> = '', 'match-none()', <query>)`. The obligation names no prompt, so no prompt validation is written for it, and under `when-input-present` it is conditioned on the trigger as every obligation is. There is no validator refusal and no migration for runtime values: the emitter is total by construction, and an existing document starts sending a search HQ accepts in place of one it refuses. The whole-clause scope is the numeric guard's existing meaning (an unusable runtime value finds nothing). Blank is the one value the guard covers, because the type checker already holds an ordered operand to a number, a date or a date and time.

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

- Nothing is simplified after a replacement: the stored tree keeps `and(x, match-none)`, so the author sees where the comparison was. Form logic needs nothing more, since `relevant="false()"` is ordinary.
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
- Pure (`lib/commcare/predicate/__tests__/runtimeCsqlDateSafety.test.ts`): the wrapper for a session value and for an input under `when-input-present`; a fixed date emits no guard; no prompt validation is added.
- Pure (the step): one fixture per row of the table, and three display conditions (one that becomes `match-none`, one that then starts with it, one that holds it later), each asserting only the replaced tree and no `hiddenFromMenu`. The flag is asserted by the `hidden-from-menu` step's own test and by the writer test over both steps.
- Native proof (`npm run proof -- proof/native -k search`, the family that compiles Core's payloads with HQ's compiler): one fixture whose runtime value is blank, asserting Core builds `match-none()` and HQ compiles it. This is the harm `proof/README.md` lists as not observed.
- The writer test's fixture app holds one of each shape.

**Lane.** Locally: `targeted-search-hq-compile` (the document, now a witness whose `csql@A` intent check compiles every search) and the two controls; the native `search` family. `targeted-time-ordering` leaves `index.json`. CI: the full lane, 11 entries moved.

## Finding 48: a search answer holding both quote marks

**Today.** For a free-text search answer that holds both `'` and `"`, the quote cascade sends the whole CSQL string `search-value-mixes-quote-marks()` (`lib/commcare/predicate/termEmitter.ts::CSQL_UNREPRESENTABLE_RUNTIME_STRING`, written by `csqlEmitter.ts::wrapClause` and `buildQuoteCascade`). HQ has no such function, so it answers 400 (`corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`). Web Apps sends the value only on a default search (formplayer `MenuSessionRunnerService.doQuery`). Android sends it without validating the prompt and shows its own generic client-error text with the status code whatever HQ answers (commcare-android `QueryRequestActivity.processClientError`).

**Fix.** The cascade sends `match-none()`. `CSQL_UNREPRESENTABLE_RUNTIME_STRING` and its doc block go, and `wrapClause` and `buildQuoteCascade` write `'match-none()'` for a quote obligation, the sentinel the typed obligations already write, so `wrapClause`'s two `if` layers merge into one condition. Reasons: it is the only fail-closed value in HQ's CSQL vocabulary; an unknown function is a REFUSED surface class that step 6's reader would refuse in Nova's own export; the injection defense is unchanged, since no runtime byte reaches the CSQL grammar in that arm; and it is what Nova already does for a value that is not a number where one is needed.

What a worker sees: on Android, the empty-results message (`query.response.empty`) on the search screen with the answer still editable, in place of a client error with a code. No channel on Android carries a reason. On Web Apps the prompt's validation message stops a search the person starts, as today, and a default search returns no rows. The builder's search input editor, the `add_search_inputs` description and the public docs say: "On Android, an answer that holds both ' and \" finds nothing."

**Files.**
- Emitters: `lib/commcare/predicate/termEmitter.ts`, `csqlEmitter.ts`, `runtimeCsqlQuoteSafety.ts` (comments).
- Domain, doc and mutations, validator, Preview: none.
- Builder: `components/builder/case-list-config/inspector/SearchInputEditor.tsx` (the sentence, on a free-text input).
- SA and MCP tools: `lib/agent/tools/case-list-config/addSearchInputs.ts` and `shared.ts` (the description: ask before `npm run test:schema`). Sweep `../nova-plugin`.
- Docs: `content/docs/case-workspace.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-search emission", the sentence naming the function).
- Proof: `proof/native/test_quote_payload.py`, `proof/native/core/CsqlQuoteRuntimeTest.java` and `StaticQuoteRuntimeTest.java` expect `match-none()` and that HQ compiles it (the `before-static-quote-branches` resource is a retained counterexample and stays). The authored surface key `csql-fn:search-value-mixes-quote-marks` (`proof/surface/families/authored.py`) and the manifest entry `case-search/a-function-on-the-left-side-a-property-on-the-right-side` stay, because the two fixed entries pin that class on a control whose bytes still hold the function; the key's `source` drops the deleted Nova symbol and its `novaWrites` says exports before step 2 wrote it. `npm run surface` regenerates `lib/commcare/surface/surface.json`.

**Stored shape and migration.** None.

**Register.** 2 manifest entries: `d48-mixed-quote-suite-csql-fn-search-value-mixes-quote-marks`, `d48-mixed-quote-app-csql-fn-search-value-mixes-quote-marks`, control `targeted-search-hq-compile`.

**Spelling rule.** None. **Identity.** None; no entry in `proof/identity-moves.json`.

**Control.** `targeted-search-hq-compile` keeps showing `/csql-fn:search-value-mixes-quote-marks/refused` under the manifest check.

**Nova tests.** Pure: the emitter's test for the cascade's three arms. Native proof (`npm run proof -- proof/native -k quote`): Core builds the payload from a both-quotes answer and HQ compiles it to its match-none filter.

**Lane.** Locally: `targeted-search-hq-compile`, its control and the native quote family. That HQ compiles the new payload rests on reading until that family runs in this pull request; its test is the confirmation. Decided fallback for the retained key: where the manifest check cannot keep a surface key no corpus document uses, the key and the two entries are deleted in this pull request with that reason, and the native family is the proof. CI: the full lane, 2 entries moved.

---

## Defect 11, first half: the media formats every platform plays

**Today.** `lib/domain/multimedia.ts` accepts PNG, JPEG, GIF, WebP, MP3, WAV and MP4 (`IMAGE_MIME_TYPES`, `AUDIO_MIME_TYPES`, `VIDEO_MIME_TYPES`), and `lib/media/validate.ts::validateMediaBytes` checks no codec, brand or encoding. The stated reason for the short list is false: the comment on `AUDIO_MIME_TYPES`, `lib/media/CLAUDE.md`, and the header and description of `lib/mcp/tools/uploadMediaAsset.ts` say HQ validates a file's extension. That check (`corehq/apps/hqmedia/views.py::BaseProcessFileUploadView.validate_file`) belongs to HQ's single-file uploader, which Nova never calls. Nova's upload types each file by its bytes (`corehq/apps/hqmedia/tasks.py::process_bulk_upload_zip`, `corehq/apps/hqmedia/models.py::CommCareMultimedia.get_class_by_data`). A second false claim, that an unbundled media file fails to install, is in `lib/commcare/multimedia/mediaSuiteXml.ts`, `assetWirePath.ts`, `lib/commcare/validator/mediaSuiteOracle.ts` (comments and the text of `MEDIA_LOCATION_PATH_NOT_BUNDLED` and `MEDIA_LOCATION_UNKNOWN_AUTHORITY`) and a comment in `lib/commcare/__tests__/mediaSuiteOracle.test.ts`; and `proof/native/core/MediaRuntimeTest.java::actualMediaResourcesInstallOnlyWhenLocalBytesExist` tests a file-system install while `proof/README.md` describes it as the archive's.

**Fix.** A format is accepted when every platform plays it and HQ types its bytes as the same kind. `lib/commcare/surface/media-formats.json` already records both for each format (its HQ classification is recorded there as executed; each platform reading is from the platform's documentation). Six formats join, each admitted only in the variant its manifest item describes:

| Format | Manifest key | Canonical MIME, extension, kind | Sniff (`file-type`) | Body check beyond the sniff |
|---|---|---|---|---|
| BMP | `media-format:image/bmp` | `image/bmp`, `.bmp`, image | `image/bmp` | A header read in the new pure `lib/media/bmp.ts` (sharp has no BMP loader): `BITMAPFILEHEADER` and a DIB header of 40, 108 or 124 bytes, one plane, compression `BI_RGB` or `BI_BITFIELDS`, 1, 4, 8, 16, 24 or 32 bits per pixel, width above 0, height not 0, pixel-array offset and size inside the file. Dimensions come from the header. HQ's `CommCareImage.attach_data` aborts the whole upload on an image Pillow refuses, hence the narrowing |
| M4A | `media-format:audio/m4a` | `audio/mp4`, `.m4a`, audio | `audio/x-m4a`, `audio/mp4` | The `ftyp` major brand read from the bytes is exactly `M4A ` or `M4B `; one track, audio, codec `MPEG-4/AAC`, no video. A file branded `isom`, `mp42`, `mp41` or `dash` is refused with its own message, because HQ types it as video and an audio slot would never receive it |
| FLAC | `media-format:audio/flac` | `audio/flac`, `.flac`, audio | `audio/flac` | container `FLAC` |
| Ogg Vorbis | `media-format:audio/ogg-vorbis` | `audio/ogg`, `.ogg`, audio | `audio/ogg` | container `Ogg`, codec starting `Vorbis` |
| Ogg Opus | `media-format:audio/ogg-opus` | `audio/ogg`, `.ogg` (declared `.opus` accepted, as `.jpeg` is for `.jpg`), audio | `audio/ogg; codecs=opus` | codec `Opus`. Speex and FLAC in Ogg are refused |
| WebM | `media-format:video/webm-vp8`, `media-format:video/webm-vp9` | `video/webm`, `.webm`, video | `video/webm` | container `EBML/webm`; exactly one video track, `VP8` or `VP9`; every audio track Vorbis or Opus, or none. AV1, Matroska and an audio-only WebM are refused |

- MP4 and WAV acceptance is unchanged in step 2; step 4 narrows both by declared platform. MP3, PNG, JPEG, GIF and WebP are unchanged. The size caps are unchanged.
- The container and codec spellings are `music-metadata`'s. The accepted fixtures pin them: where the library reports another spelling for an accepted fixture, the check keys on the spelling the fixture shows. The library reads container structure and each track's codec id, not the payload or the AAC object type; that limit is stated in the code and in `lib/media/CLAUDE.md`.
- One registry replaces the hand-kept lists. `lib/domain/multimedia.ts` exports `ACCEPTED_FORMATS` (`{ mime, kind, extension, declaredExtensions, aliases, label, surfaceKeys }` per format). It holds every accepted asset format, the documents (PDF, text, DOCX, XLSX) included with `surfaceKeys: []`. `IMAGE_MIME_TYPES`, `AUDIO_MIME_TYPES`, `VIDEO_MIME_TYPES`, `ALL_MIME_TYPES`, `AssetMimeType`, `EXTENSION_FOR_MIME_TYPE` and `mimeTypeForExtension` derive from it and keep their exported names; the private `MIME_ALIASES` derives from it and stays private. The module gains a new export, `ACCEPTED_EXTENSIONS`, derived from it, and `lib/media/validate.ts` imports that in place of its own declaration, keeping its `AcceptedExtension` type. The MP4 and WAV entries name the `media-format:` items step 4 narrows to and carry a comment saying so.
- Claim aliases, so a browser's spelling is not read as a renamed file: `audio/x-m4a` and `audio/m4a` to `audio/mp4`; `audio/x-flac` to `audio/flac`; `audio/opus`, `audio/vorbis` and `application/ogg` to `audio/ogg`; `image/x-ms-bmp` and `image/x-bmp` to `image/bmp`.
- New failure reasons in `validate.ts`: `container-brand-not-accepted` and `codec-not-accepted`. The brand message: "This M4A is one CommCare HQ would file as video, so an audio slot would never receive it. Exporting it again as M4A (AAC) audio fixes that." The codec message: "This file's audio or video is encoded in a way some CommCare apps can't play (`<codec>`). Exporting it again as `<accepted codecs for the format>` fixes that." It serves ALAC in M4A, Speex and FLAC in Ogg, AV1 in WebM, an audio-only WebM and a second track.
- **The model-readable image subset.** BMP must not reach the model: `lib/agent/documentExtraction.ts` builds `MODEL_READABLE_FIGURE_TYPES` from `IMAGE_MIME_TYPES`, and `lib/agent/resolveAttachments.ts` and `lib/agent/sources.server.ts::loadImage` send any image asset with its own MIME. The domain exports `MODEL_READABLE_IMAGE_MIME_TYPES` (PNG, JPEG, GIF, WebP). `documentExtraction.ts` reads it; `resolveAttachments` and `loadImage` return the existing placeholder for an image outside it; the chat picker (`components/chat/ChatInput.tsx`, `CHAT_ATTACHMENT_KINDS`) shows a library BMP as unavailable ("The assistant can't read BMP images yet. A PNG or JPEG of it works.") and does not offer `.bmp` in its own upload. Transcoding BMP for the model is rejected: it adds a pixel decoder over untrusted bytes for a rare case.

**Files.**
- Domain: `lib/domain/multimedia.ts`.
- Doc and mutations: none.
- Validator: `lib/media/validate.ts` (its own `ACCEPTED_EXTENSIONS` declaration becomes the domain import; stage 4 dispatches on the sniffed MIME; one `parseBuffer` call shared with the duration read; the declared-extension family rule generalized), `lib/media/bmp.ts` (new); `lib/commcare/validator/mediaSuiteOracle.ts` (comments and two messages, below).
- Emitters: `lib/commcare/multimedia/mediaSuiteXml.ts`, `assetWirePath.ts` (comments only; wire paths derive from hash and extension).
- Preview: none (the browser plays all six).
- Builder: `components/builder/media/assetKindMeta.ts` (`extLabel` from the registry; `accept` becomes MIME types plus declared extensions, because browsers report `.m4a`, `.flac`, `.opus` and `.ogg` inconsistently), read by `MediaPickerDialog.tsx`; `components/chat/ChatInput.tsx`.
- SA and MCP tools: `lib/mcp/tools/uploadMediaAsset.ts` (header and description state the accepted set from the registry and drop "CommCare HQ can't ingest .m4a or .ogg": ask before `npm run test:schema`); `lib/agent/documentExtraction.ts`, `lib/agent/resolveAttachments.ts`, `lib/agent/sources.server.ts`. `app/api/media/upload/route.ts` needs no change: its refusal lists `ALL_MIME_TYPES`. Sweep `../nova-plugin` for mp3, wav, m4a and ogg.
- Docs: `content/docs/mcp/tools.mdx` (the `upload_media_asset` row); a short passage naming the accepted image, audio and video formats in `content/docs/building-with-nova.mdx`; one clause in `content/docs/attachments.mdx` saying its list is worker capture formats.
- CLAUDE.md: `lib/media/CLAUDE.md` ("Accepted formats are HQ-ingestion-bound" becomes the formats every platform plays, with the registry, the body checks and HQ's true path); `lib/domain/CLAUDE.md` (the registry and the model-readable subset).
- Infrastructure: `scripts/rollout/verify-runtime-packages.mjs` gains one tiny real buffer per lazily loaded `music-metadata` parser now in use (Ogg, FLAC, Matroska, MP4), beside its WAV probe, so a parser missing from the standalone image fails the build and not every upload of that format.
- Proof: `lib/commcare/surface/entries/expressions-and-data.json` (the `widen` halves of `image-bmp`, the M4A and FLAC entry, `audio-ogg-vorbis-or-opus` and the WebM entry are marked done; the `narrow` halves stay for step 4); the native `media` family, below.

The comment and test corrections:

- The headers of `mediaSuiteXml.ts` and `assetWirePath.ts`, the two comments and the two finding messages in `mediaSuiteOracle.ts`, and the comment in `mediaSuiteOracle.test.ts` say: Core's `BasicInstaller.install` installs a local resource when its reference reports the file exists and never installs a remote one; Core's and Formplayer's archive references always report yes (commcare-core `ArchiveFileReference.doesBinaryExist`; formplayer `FormplayerArchiveFileRoot.derive`), so an archive install does not notice a missing file; Android unzips the archive and copies each file (commcare-android `InstallArchiveActivity`, `FileSystemInstaller.install`), so a missing file fails the install there; the bundling proof is therefore the oracle's own `bundledPaths` join. `MEDIA_LOCATION_PATH_NOT_BUNDLED` names Android as the runtime that refuses.
- `MediaRuntimeTest.actualMediaResourcesInstallOnlyWhenLocalBytesExist` is renamed for what it is, the file-system install (Android's shape). A new archive test opens the `<scenario>.ccz` the producer already writes, registers it with Core's `ArchiveFileRoot`, and for every media resource asserts that (1) the archive reference installs, (2) a reference to a `missing-` sibling also installs, which records that Core's archive install cannot be the bundling proof, and (3) the zip holds an entry at the location's path whose SHA-256 is the hash in its name. `proof/README.md` ("Media (`media`)") and the docstring of `proof/native/test_media_emission.py` follow.

**Stored shape and migration.** None: `media_assets.mime_type` is `text` with no check constraint, and this half only widens. No notice.

**Register.** None (defect 11 has no entry). **Spelling rule.** None. **Identity.** None; no entry in `proof/identity-moves.json`. **Control.** None.

**Nova tests.**
- Pure, real bytes (`lib/media/__tests__/validate.test.ts`): one accepted fixture per new format with its kind, canonical MIME, extension, and dimensions or duration; and one near miss per refusal, each first shown to pass the earlier gates: M4A branded `isom`; `M4A ` holding ALAC; Ogg Speex; FLAC in Ogg; WebM holding AV1; audio-only WebM; a Matroska file named `.webm`; BMP with RLE compression; BMP with a 12-byte core header; a truncated BMP. Fixtures are small committed files under `lib/media/__tests__/fixtures/`, generated once with ffmpeg from a 0.2 second sine tone and a 16 by 16 test pattern (`-c:a aac -f ipod` for M4A, `-c:a alac -f ipod`, `-c:a aac -f mp4` for the `isom` brand, `-c:a flac`, `-c:a libvorbis`, `-c:a libopus`, `-c:a libspeex`, `-c:a flac -f ogg`, `-c:v libvpx -f webm`, `-c:v libvpx-vp9 -f webm`, `-c:v libaom-av1 -f webm`, `-c:a libopus -f webm`, `-c:v libvpx -f matroska`); the commands are recorded in a comment at the top of the test. BMP fixtures are built in the test from bytes.
- Pure (`lib/domain/__tests__/multimedia.test.ts`): the registry's derivations (every alias and declared extension resolves only through its own entry; an inherited object key resolves to nothing), and the model-readable subset is exactly four types.
- Pure (`lib/commcare/surface/__tests__/manifest.test.ts`): every `surfaceKeys` entry of the registry exists in `media-formats.json`, reads `runs` on both platforms, and has an HQ class matching the registry's kind. It lives there because `lib/domain` may not import `lib/commcare`.
- Pure: `resolveAttachments` returns the placeholder for a BMP; the figure set excludes it.
- Playwright (one smoke test, added to `e2e/tests/browser/media-transport.spec.ts`): an `.m4a` and an `.opus` file upload through the media picker. The claimed MIME is a browser behavior no unit test stands in for.
- Native proof: the `media` family gains one real file of each new format in the slot of its kind (`lib/commcare/__tests__/mediaWireFixtures.ts::mediaManifest`, `proof/native/producers/emit-media-evidence.ts`, `proof/native/steps/media_emission.py`, `proof/native/test_media_emission.py`), so HQ's whole `process_bulk_upload_zip` must finish with no error, skipped or unmatched file and class each as Nova does. Its asserted counts change. This also shows Pillow opens Nova's accepted BMP.

**Lane.** Locally: `npm run proof -- proof/native -k media`. HQ's typing of each new format is confirmed by that family in this pull request. Decided fallback: a format HQ's upload does not accept as its kind leaves `ACCEPTED_FORMATS` in this pull request, its manifest entry keeps `widen`, and `lib/media/CLAUDE.md` records why. CI: the full lane with no register change.

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

A second executed fact decides the fix's shape: Core's parse of an offset-bearing date and time (`DateUtils.parseTimeAndStore`) converts the clock to the reader's zone and keeps the written date, so `date(<text>)` is a whole day wrong whenever the reader's local date for that instant differs from the written one. No single wrapper is right for every operand. CSQL is a separate dialect and is correct: HQ's range query parses a date or datetime and compares instants.

**Fix.** Step 2 observes it and does not fix it. The fix is step 3's, whose typed expression model owns per-operand lowering: it chooses there between a zone-proof arithmetic conversion of the text and a refusal. `3-expressions.md` carries the finding and these requirements: the lowering is chosen per operand from its type, never by wrapping the whole comparison; `date()` is never applied to `now()` or a typed answer; date against date stays bare; date against datetime is refused by the type checker, so a date operand meets a datetime only through an explicit coercion, and it then enters the lowering as the UTC-midnight day number, agreeing with the UTC-day rule in `lib/domain/predicate/CLAUDE.md`, Preview and CSQL; a lowering that applies `date()` to text does not throw on malformed text where today's comparison is false; no on-device wrapper leaks into a CSQL segment; and a native proof runs the ordering in at least two device zones with a value written in a third. The one shape step 2 closes is a date and time written as a string literal in form logic, which defect 6's `XPATH_TIME_ORDERING` refuses because the literal holds a colon.

What step 2 adds, in pull request 1 (lane mechanics):

This block is the document's definition; part 09, Finding 56: an ordering comparison on a datetime never orders by instant, defers to it.

- **Document** `targeted-datetime-ordering` (`proof/targeted/documents/datetimeOrdering.ts`, registered in `TARGETED_DOCUMENTS`), `rows: ["56"]`, the one row `proof/README.md` gains:
  - a survey form with two datetime questions, `start` and `end`, and a hidden value `if(#form/start < #form/end, 'start before end', 'start not before end')`, with answers one hour apart on one day and the intent expectation `start before end`, on the `local` and `A` exports;
  - a case list over a case type with two datetime properties, filtered by `seen` before `due`, with one fixed case whose `seen` is a day before its `due`, and the intent expectation that the list holds that case.
  - It holds no string literal and no time, so it stays admitted through defect 6's fix, and the manifest's `time-operand` reading leaves each of its operands open, so no live entry of finding 56 shares a class with defect 6's fixed entries. A date and time written as a string literal, or compared in a display condition's text, is deliberately not in it: `XPATH_TIME_ORDERING` would refuse the document at pull request 14 while its entries must stay live to the exit.
  - No manifest entry: the manifest's `time-operand` reading leaves every operand open, so the manifest gains no REFUSED class for this document.
- **Entries** in `proof/known-defects.json`, defect `56`, written from that pull request's lane evidence: two intent entries expected, `d56-datetime-ordering-evaluate` (`evaluate:start-before-end-*`, `/values/*/value`, values pinned `start before end` to `start not before end`) and `d56-datetime-ordering-evaluate-rows-caseid` (the list's `/caseList/rows/*/caseId`, the case pinned to absent). Decided fallback: where the run shows a path or a count other than these, the entries are written from what it shows, and the document keeps both forms.
- **Control** `targeted-datetime-ordering`, retained in the same pull request for the intent check.
- **Record.** `docs/research/2026-09-26-hq-round-trip/harness-findings.md` gains finding 56 with the table above.

**Files.** Proof only: the document, which holds its two expectations in its own file as `timeOrdering.ts` holds its `expectation` (`proof/targeted/expected.ts` gives the types and does not change), `proof/targeted/index.ts`, the two entries, the control directory, `harness-findings.md`, the row in `proof/README.md`, `proof/timings.json` (the new control group). Domain, doc and mutations, validator, emitters, Preview, builder, SA and MCP tools, docs, CLAUDE.md: none in step 2.

**Stored shape and migration.** None.

**Register.** Nothing moves to the fixed register: the two entries are added and stay live through step 2. The step's exit says the register holds no entry for 31 and up except finding 56.

**Spelling rule.** None. **Identity.** None; no entry in `proof/identity-moves.json`.

**Control.** `targeted-datetime-ordering` shows both symptoms under the intent check from pull request 1 on.

**Nova tests.** `proof/targeted/__tests__/targeted.test.ts` (pure) covers the new maker with every other targeted document: it is built twice alike, the gate admits it, and each expectation names a form it holds. No other Nova test in step 2, since the harm is in Core, which the lane runs. Step 3's fix brings the native proof named above.

**Lane.** Locally, in pull request 1: `npm run proof -- proof/checks -k targeted-datetime-ordering` and `-k control-targeted-datetime-ordering`. CI: the full lane with two more live entries, each seen on its document and on its control.
