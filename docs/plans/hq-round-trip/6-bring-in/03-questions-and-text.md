# Step 6, part 03: Questions and text

Part of step 6's plan, "Bringing an app in from CommCare HQ". This part plans five authored concepts,
each a complete Nova feature that is useful with no reader: the **Phone Number question**, a
**calculated value in prose**, a **search with no title**, a sort rule's **blanks first or last**, and
**text shown as typed** on a help text and on a whole form. With the first it fixes the shape of the
typed question display vocabulary that step 7's group `question-display` joins without a migration.
It also fixes three defects of today's Nova. Two share one cause, text CommCare HQ's build reads as
an instance: in a label (section 5), and in a form's name or a CommCare Connect block's name or
description (5.1). The third is the text a phone writes for a date and time saved to a case, which
is not the text CommCare HQ stores, so a list ordered by it misplaces the cases that phone saved
(7.1). Each concept is planned across the domain, the validator, the emitters, Preview,
the builder, the Solutions Architect and MCP, the platform table, the surface manifest, the public
docs and the proof lane. It adds four optional document keys (`keypad`, a sort rule's `blanks`,
`plainHelp`, `plainText`), one prose part kind, one wider slot grammar (`searchScreenTitle`), one
validator code (`FORM_TEXT_READ_AS_INSTANCE`) and one generated node purpose (7.1); no table, no
migration, no route, no MCP tool and no notice.
Another part is cited by its number and file name: part 01 is `01-the-bar-and-the-manifest.md`, part
04 `04-names.md`, part 06 `06-the-reader-forms.md`, part 07 `07-the-reader-cases-menus-lists.md`,
part 08 `08-the-reader-expressions.md`, part 09 `09-acceptance-and-the-first-publish.md`, part 10
`10-identity-and-the-ledger.md` and part 14 `14-proof.md`. The top-level file is `../6-bring-in.md`
and step 7's outline `../7-rest-of-model.md`.

Citations are `path::symbol`: Nova at `main` `1f103305`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, formplayer `24383ac71bfb`, commcare-connect `046c7fd78081`, Vellum `01215f251c57`. Every
CommCare fact below was read at those commits for this part. HQ paths are under
`corehq/apps/app_manager/` unless they start elsewhere; Web Apps client paths are under
`corehq/apps/cloudcare/static/cloudcare/js/`. A fact marked "(read, not run)" has a check in "Written
and not yet run" that settles it.

| Section | Owns |
|---|---|
| 2 | the question display vocabulary: its shape, its registry, the one writer of `appearance` |
| 3 | the Phone Number question |
| 4 | a calculated value in prose: the part, its check, emission, Preview, translations, the builder |
| 5 | text CommCare HQ's build reads as an instance: a label (5), and a form's name and a Connect block's text (5.1) |
| 6 | a search with no title |
| 7 | a sort rule's blanks first or last (7), and a date and time saved to a case as CommCare HQ stores it (7.1) |
| 8 | text shown as typed: help, a whole form, and what hints and validation messages write |
| 9 | the Solutions Architect and MCP |
| 10 | the surface manifest, entry by entry |
| 11 | the model-addition checklist, line by line |

---

## Decisions in brief

1. **A question display setting is an optional key on the schema of each kind whose control reads it**
   (2.1): named for what the worker sees, valued from a closed set, absent for the platform's own
   behavior. There is no free-text appearance slot and there never will be one. `group.fieldList`, the
   `label` kind and the `signature` kind are three such facts Nova already holds.
2. **`lib/domain/fieldDisplay.ts::FIELD_DISPLAY_SETTINGS` is the one registry of those settings, and
   `lib/commcare/xform/appearance.ts::fieldAppearance` the one writer of an XForm control's
   `appearance`** (2.2, 2.3). Step 7 adds registry rows, schema keys and token rows; it changes
   neither shape.
3. **The Phone Number question is a Text question with `keypad: "numbers"`** (3.1). Its answer is text,
   its bind `xsd:string`, its case property type text; it writes `<input appearance="numeric">`, the
   one shape Vellum's Phone Number or Numeric ID question stores.
4. **Nova adds no validation of its own to it** (3.3). Web Apps refuses an answer that is not digits
   with an optional sign and decimal part, Android limits the keys, and the new platform row
   `number-keypad` says so wherever the author sets it. Preview plays each; what Android's keypad does
   with a sign or a period out of place is read on the lane's Android reader (G5), and Preview's
   Android rule is what that read shows.
5. **The builder offers it twice, as one stored thing** (3.5): a **Phone number** entry in the question
   picker, and a **Number keypad** switch on every Text question.
6. **A calculated value is a sixth prose part kind, `{ kind: "value", expression }`** (4.1), beside
   `text` and the four references, on a question's label, hint, help text, validation message and
   choice labels: every prose slot a form evaluates. The case type catalog's three prose slots do not
   admit it, by schema.
7. **One canonical form** (4.1): the schema refuses a `value` part whose expression is what one of the
   four reference parts lowers to (a question read by hashtag or by absolute path is one read), and
   every writer stores that reference part instead.
8. **A `value` part is checked by the slot's own profile** (4.2): form rules, one scalar of any type,
   the same context a reference part of that slot is checked in. No new validator code.
9. **Prose values join the one expression enumeration** (4.3):
   `lib/domain/referenceSlots.ts::expressionSlotValues` yields each under its prose slot, so every
   reader that walks the enumeration (the reference index, renames, lookup and location reads,
   platform uses, case data loading, the emitter's count carriers) sees it with no walker of its own.
   Three readers walk prose by part kind instead, and each gains a value arm by name in 4.3 and 4.4:
   the worker-record requirement, case type retirement's field walk, and the captured-file link
   capability.
10. **It prints as `<output value>` with its Vellum shadow, like a reference** (4.4), and is evaluated in
    Preview by the text the XForm holds (4.5). Vellum shows `format-date(date(x), '<pattern>')` as its
    date chip and any other expression as the output it is. In a composed validation message a value
    enters as it is, with no `count()` guard: Core's `count` refuses anything but a node-set.
11. **Translations treat it as a protected part** (4.6): a translation may move it and may not change
    it. Adding the arm changes no stored fingerprint, because a fingerprint is the template's own JSON.
12. **The builder inserts and edits one from the reference picker** (4.7), in a popover holding the
    expression editor, and shows it as a chip that prints the formula.
13. **The Solutions Architect and MCP write it `{{= formula}}`** (9.2). The formula ends at the first
    `}}` outside a quoted string, so any formula form logic admits can be written and read back.
14. **Literal text in a label that CommCare HQ's build would read as an instance is written so it
    cannot** (5): `instance` and its bracket are split by a literal output. The text a worker reads is
    unchanged, a label can hold any characters, and no gate rule is added for a label.
15. **A form's name and a Connect block's name and description can't hold text CommCare HQ's build
    reads as an instance** (5.1). They are plain text in the form's source, where no spelling keeps
    the scan out, so the gate refuses it (`FORM_TEXT_READ_AS_INSTANCE`) and offers a space before the
    bracket. A label keeps any characters, because itext can be protected.
16. **A search with no title is `searchScreenTitle: { kind: "none" }`** (6). Absent keeps meaning
    "Search", so no document changes. It writes a blank title in every language, as CommCare HQ's Case
    List page does, and no translation unit.
17. **A sort rule's `blanks` is `"first" | "last"`, stored only where it differs from its direction's
    own** (7), by schema. `caseListOrderPlan` already carries the value to the HQ JSON, the suite,
    Preview and Postgres.
18. **Only a help text gains a stored "as typed" setting, `plainHelp`** (8.1). Android draws a help
    text's formatting only where the form holds its formatted copy; no runtime reads a hint's or a
    validation message's.
19. **From step 6 Nova writes no formatted copy of a hint or a validation message** (8.2), in any app.
    One held without one comes back exactly; one held with one loses a copy nothing reads.
20. **A form whose text formatting is off is `Form.plainText`** (8.3). No text of the form writes a
    formatted copy, so every label shows as typed on both platforms and every choice and help text on
    Android (Web Apps formats those two whatever the form holds, 8.1). The form writes
    `vellum:ignore="markdown"`, and each text's own setting is kept for when the switch goes back on.
21. **One rule of this part narrows the gate for a stored document: 5.1's.** Every other new refusal
    is of a shape no stored document holds (a new key's value, a new prose arm). For 5.1 a read-only
    scan of every saved app found none holding the text when it ran. The session runs it once more
    before the merge and once more when the deploy has ended, and the deploy's own probe covers the
    time between (5.1, "What existing apps see").
22. **This part's changes reach served tool inputs, descriptions and the guide** (9.5 lists them), so
    they are part of the step's one move of `MODEL_CONTEXT_VERSION`, and `setFormSections` joins
    `scripts/test-schema.ts`, since this step is the first to change its served schema (section 9).
23. **A date and time saved to a case is written as CommCare HQ stores it, UTC with six fraction
    digits and `Z`** (7.1), on a phone, in Preview and in Nova's case store. A list ordered by one
    then orders by the moment with no sort key, no hidden column and no list rule, because the
    defect was the text and never the list. Text that is already a stored moment is written as it
    is. An app's next publish carries the new text to its phones; no stored row and no document is
    rewritten, and no notice is written.

---

## Executed during planning

Read, by `file::symbol` group. Nothing was run but `rg`, `python3` over the manifest JSON, file
reads, and one read-only scan of production: no saved form row, translation or other entity row of
a saved app holds `instance(` followed by a quote mark, which is more than 5.1's rule refuses.

- **Field kinds and display.** `lib/domain/fields/base.ts`, `text.ts`, `secret.ts`, `index.ts` (the
  registry, `partialOf`, the conversion notes), `lib/domain/kinds.ts::FieldKindMetadata`;
  `lib/commcare/xform/builder.ts::buildLeafControl`, `buildContainer`; `xform/captureUpload.ts`;
  `xform/bindType.ts::BIND_TYPE_BY_KIND`; `lib/domain/casePropertyTypes.ts`;
  `lib/domain/platforms.ts::PLATFORM_FEATURES`, `PLATFORM_FEATURE_IDS`; `platformUses.ts::fieldUses`;
  `lib/commcare/surface/platformFeatureEntries.ts`; `lib/preview/platform.ts::PREVIEW_PLATFORM_RULES`;
  `lib/preview/engine/formEngine.ts::readNumericAnswer`; `lib/preview/runtimeMessages.ts`;
  `components/preview/form/fields/TextField.tsx`, `NumberField.tsx`, `newFieldDefaults.ts`,
  `FieldTypePicker.tsx`; `components/builder/editor/fieldEditorSchemas.ts`, `fields/FieldListEditor.tsx`;
  `lib/agent/contentProcessing.ts::flatFieldToField`; `lib/preview/__tests__/platformCells.ts`,
  `platformCells.test.ts::requiredCells`; `e2e/lib/previewPlatformScenarios.ts`;
  `lib/commcare/surface/platformFeatureEntries.ts::AMBIENT_PLATFORM_ENTRIES` and
  `surface/__tests__/platformFeatures.test.ts` (rule 2); `suite/case-search/searchPrompts.ts` (the
  prompt's own `appearance`).
- **Prose.** `lib/domain/prose.ts` (whole); `expressionSource.ts::prosePartTerm`, `proseSurfaceReads`;
  `referenceSlots.ts::FIELD_REFERENCE_SLOTS`, `visitExpressionSlots`, `expressionSlotValues`,
  `expressionSlotKey`; `expression/types.ts::ProseSlotRef`, `SlotContextRef`;
  `expression/context.ts::slotContext` (the field arm); `localization.ts::translationSourceFingerprint`,
  `translationSourceFingerprintsEqual`; `translationUnits.ts::proseReferenceSignature`,
  `translationValueIntegrityIssue`; `lib/commcare/xform/builder.ts::buildLabelNodes`,
  `literalLabelNodes`, `whitespaceOutput`, `addItext`; `xform/formExpressions.ts::formExpressionEmission`;
  `xform/proseExpression.ts`; `xform/constraintMessage.ts::protectConstraintMessage`;
  `xform/itextIds.ts::itextProseSlot`; `xpath/wire/serialize.ts::literalPieces`, `INSTANCE_LITERAL`;
  `lib/commcare/validator/index.ts` (the prose surface loop); `lib/doc/referenceIndex.ts::extractProseRefs`;
  `lib/doc/casePropertyRenames.ts::rewriteCasePropertyCarriers`; `lib/doc/formSectionVerdicts.ts`;
  `lib/doc/expressionText.ts::parseProseReference`, `formParseScopeForSlot`;
  `lib/commcare/xpath/expressionAst.ts::parseFormExpression`, `formParseScope.ts`;
  `lib/preview/engine/labelRefs.ts`, `formExpressionRuntime.ts`, `triggerDag.ts` (the wording block),
  `formText.ts`; `lib/tiptap/proseTemplateCodec.ts`, `commcareRefNode.ts`, `proseReferenceEditing.ts`,
  `CommcareRefView.tsx`; `lib/references/provider.ts::resolvePart`, `projectPart`;
  `components/builder/RefLabelInput.tsx`, `ProseReferencePicker.tsx`, `XPathField.tsx`,
  `editor/fields/XPathEditor.tsx`, `TextEditor.tsx`; `lib/codemirror/expressionEditorContext.ts`;
  `lib/agent/authoring/text.ts`, `input.ts` (`textAt`), `formPreparation.ts`, `output.ts`;
  `lib/agent/authoring/schema.ts::families`, `familyOf`, `valueSchemas` (the served `text` and
  `localized` descriptions; `text.ts::textSchema` has no importer); `scripts/test-schema.ts` (its
  registered names); `lib/agent/sharedToolRegistry.ts` and `tools/setFormSections.ts`;
  `lib/agent/translation/translator.ts`; `components/builder/app-setup/protectedProse.ts`;
  `lib/domain/workerRecordRequirements.ts::readsWorkerRecord`, `workerRecordRequirements`;
  `lib/doc/caseTypeRetirement.ts` (the field walk, `proseNamesCaseType`, `expressionRefsCaseType`);
  `lib/doc/hooks/useXPathSlots.ts::expressionEditorContextFor`,
  `useExpressionSlotContext.ts::expressionCandidateDoc`; `referenceSlots.ts::expressionSlotValue`;
  `lib/doc/projectBuilderLanguageMutations.ts` (the prose refusal and the `updateModule` arm);
  `proof/native/families.py::CORE_CLASSES`, `ZONED_CLASSES`;
  `proof/native/producers/emit-expression-evidence.ts`. For 5.1:
  `lib/commcare/xform/dataRootAttributes.ts::xformDataRootRuntimeAttributes`;
  `lib/domain/formWireName.ts::formWireName`; `xform/constraintMessage.ts::asciiJson`;
  `lib/commcare/connectSlugs.ts::buildConnectSlugMap`; `lib/domain/forms.ts` (the four Connect
  schemas); `lib/commcare/validator/rules/form.ts::runFormRules`, `connectValidation`;
  `validator/rules/xmlText.ts::authoredXmlText`; `validator/gate.ts::evaluateCommit`,
  `evaluateBoundary`; `lib/doc/incrementalValidationScope.ts`; `lib/doc/userFacingErrors.ts`;
  `lib/db/runtimeDatabaseProbe.ts::runCanonicalRuntimeDatabaseProbe`,
  `auditRuntimeProbeParsedBlueprint`; `lib/db/apps.ts::loadSchemaAdmittedAppForInspection`;
  `components/builder/detail/formSettings/InlineField.tsx`, `LearnConfig.tsx`;
  `components/builder/detail/appSettings/ConnectManagerDialog.tsx`;
  `lib/agent/planningSchemas.ts` (the Connect input shapes); `lib/db/pg.ts::BlueprintEntitiesTable`.
- **Search title, sort, markdown.** `lib/domain/modules.ts::ordinaryCaseSearchConfigSchema`,
  `DEFAULT_CASE_SEARCH_TITLE`, `columnSortSchema`, `caseSearchConfigAfterFinalInputRemoval`;
  `translationUnits.ts` (the `search-screen-title` unit);
  `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument`;
  `suite/case-search/searchSession.ts`; `lib/commcare/localeFile.ts::serializeLocaleFileValue`;
  `lib/domain/caseListOrder.ts::caseListOrderPlan` (rule 9, `finalRule`); `suite/case-list/sortKeys.ts`;
  `lib/case-store/postgres/store.ts` (the blanks term); `lib/commcare/CLAUDE.md`, "Markdown itext";
  `components/preview/form/formatText.ts`, `useLabelFormatText.ts`, `FieldHelp.tsx`;
  `components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx`, `SortPriorityStack.tsx`;
  `lib/agent/toolSchemaGenerator.ts::FIELD_DOCS`, `buildAddFieldsItemSchema`, `gateDisplayFlags`;
  `lib/agent/tools/case-search-config/shared.ts::setCaseSearchDisplayBodySchema`;
  `lib/agent/tools/case-list-config/shared.ts::columnSortInput` (it is the domain `columnSortSchema`,
  made optional and described); `lib/doc/types.ts` (the column `sortPatch`).
- **The manifest.** Every entry of `lib/commcare/surface/entries/questions.json`, by script: section
  "Appearances" holds 73 entries (56 HELD-NEW, 9 INERT, 8 REFUSED); the Phone Number entry sits in
  "Question types". The title, blanks, markdown, output and `vellum:ignore` entries, each whole.
- **Vellum.** `src/mugs/types/text.js::PhoneNumber`; `src/parser.js::buildControlNodeAdaptorMap` (the
  `input` adaptor), `parseXForm` (the `vellum:ignore` read); `src/core.js::getQuestionGroups`,
  `showFormPropertiesModal`; `src/writer.js::write_html_tag_boilerplate`;
  `src/javaRosa/plugin.js::loadXML`, `contributeToModelXML`, `getMugSpec` (the four itext properties);
  `src/javaRosa/itextBlock.js::itextLabelBlock`; `src/javaRosa/itextWidget.js::itextMarkdownWidget`;
  `src/javaRosa/util.js::looksLikeMarkdown`; `src/richText.js::formats`, `extractXPathInfo`,
  `outputToBubble`, `sanitizeInput`; `src/xml.js::normalize`; `src/commcareConnect.js`
  (`parseDataNode`, `dataChildFilter`, the `name` and `description` specs).
- **HQ.** `xform.py::VELLUM_TYPES`, `XForm.add_missing_instances`, `VALID_VALUE_FORMS`,
  `ItextValue.from_node` (how the question summary reads an `<output>`), `WrappedNode.render`,
  `parse_xml`, `XForm._get_instance_ids`, `XForm.add_instance`;
  `suite_xml/post_process/instances.py::get_instance_names`, `get_all_instances_referenced_in_xpaths`,
  `instance_re`, `get_instance_factory`, `INSTANCE_KWARGS_BY_ID`, `null_factory`;
  `models/forms.py::FormBase.add_stuff_to_xform`, `FormBase.render_xform`;
  `models/applications.py::Application._get_form_files`;
  `helpers/validators.py::ApplicationBaseValidator.validate_app`;
  `tests/test_form_preparation_v2.py` (`test_add_remote_instances`, `test_add_instances_quotes`);
  `models/case_search.py::CaseSearch.get_search_title_label`;
  `app_strings.py::_create_case_search_app_strings`;
  `suite_xml/post_process/remote_requests.py` (the title);
  `feature_support.py::enable_case_search_title_translation`,
  `enable_markdown_in_groups`; `views/modules.py::_gather_and_update_search_properties`,
  `_init_new_sort_element`; `detail_screen.py::sort_node`; `models/case_list.py::SortElement`;
  `static/app_manager/js/details/bootstrap5/sort_rows.js`;
  `static/app_manager/template_apps/health/app.json`;
  `corehq/apps/translations/app_translations/upload_form.py` (the markdown veto);
  `submodules/commcare-translations/commcare_translations.py::dumps`; Web Apps
  `form_entry/entries.js::getEntry`,
  `PhoneEntry`, `FreeTextEntry`; `form_entry/form_ui.js::getMatchingStyles`, `Question.prototype.fromJS`;
  `formplayer/menus/views/query.js::templateContext`; the template
  `corehq/apps/cloudcare/templates/cloudcare/partials/query/list.html`.
- **Runtimes.** commcare-core `xform/parse/XFormParser.java::parseOutput` and the control's
  `setAppearanceAttr`; `core/model/FormDef.java::fillTemplateString`;
  `xpath/XPathConditional.java::evalReadable`; `xpath/expr/XPathCountFunc.java::evalBody` (it throws
  `XPathTypeMismatchException` for an argument that is no node-set);
  `form/api/FormEntryPrompt.java::getHintText`, `getHelpText`, `getHelpMultimedia`, `getConstraintText`;
  `xml/DetailFieldParser.java::parseBlanksPreference`; `cases/entity/EntitySorter.java::getCmp`;
  `util/screen/QueryScreen.java::getTitleLocaleString`. commcare-android
  `views/widgets/WidgetFactory.java::createWidgetFromPrompt`, `buildBasicWidget`; `StringNumberWidget.java`
  (its `DigitsKeyListener(true, true)` with `getAcceptedChars` overridden; the listener's own filter is
  the Android framework's and in no pinned checkout, which is check G5);
  `QuestionWidget.java::createHelpLayout`, `addHintText`. formplayer
  `api/json/PromptToJson.java::parseQuestion`, `parseStyle`, `parseCaption`. For 5.1: commcare-core
  `core/model/FormDef.java::initialize`; `core/process/CommCareInstanceInitializer.java::generateRoot`,
  `setupFixtureData`, `loadFixtureRoot`; `core/sandbox/SandboxUtils.java::loadFixture`.
  commcare-android `utils/AndroidInstanceInitializer.java::setupFixtureData`;
  `tasks/FormLoaderTask.java`. formplayer
  `session/FormplayerInstanceInitializer.java::setupFixtureData`.
- **Connect.** commcare-connect `opportunity/app_xml.py::get_form_xml_for_app`, `extract_modules`,
  `extract_deliver_unit`, `extract_task_unit`, `get_element_text`;
  `opportunity/tasks.py::sync_learn_modules_and_deliver_units`;
  `form_receiver/processor.py::get_or_create_learn_module`.
- **A date and time saved to a case (7.1).** Nova: `lib/commcare/xform/datetimeCaseValue.ts`
  (whole); `xpath/wire/instant.ts` (whole: `instantMicros`, `typedInstantText`, `typedInstantValue`,
  `leafText`, `datetimeCoerceValue`, `epochDayMidnight`); `lib/domain/expression/instantOperand.ts`
  (`InstantLeaf`, `instantOperand`, `literalInstantMicros`, `literalInstantText`);
  `xform/caseOps.ts` and `xform/builder.ts` (the two call sites); `casePlacementPlan.ts`;
  `xform/generatedNodes.ts::GeneratedNodePurpose`; `lib/domain/caseListOrder.ts` (whole);
  `suite/case-list/sortKeys.ts`; `hqJson/caseList.ts::projectSortElements`, `sortElementType`;
  `lib/domain/temporalValues.ts` (`instantDatetimeValue`, `storageDatetimeValue`) and its five
  callers; `lib/case-store/sql/compileExpression.ts::compileReadingText`,
  `compileDeviceTextExpression`; `compileTerm.ts::compileStoredInstant`;
  `lib/case-store/postgres/store.ts::compileSortKey`;
  `lib/preview/engine/caseDataBindingHelpers.ts::buildCaseStoreSortKeys`;
  `caseDataBindingClient.ts::caseRowDisplayValue`; `lib/preview/columnDisplay.ts`; the manifest
  entries that quote the spelling. HQ: `corehq/form_processor/utils/xform.py::adjust_datetimes`,
  `adjust_text_to_datetime`, `RE_DATETIME_MATCH`; `corehq/form_processor/parsers/form.py`;
  `dimagi/utils/parsing.py::json_format_datetime`;
  `sql_templates/get_modified_case_ids.sql`; `casexml/apps/phone/data_providers/case/livequery.py`;
  `detail_screen.py::FormattedDetailColumn.sort_node`; `util.py::get_sort_and_sort_only_columns`,
  `create_temp_sort_column`; `suite_xml/sections/details.py::get_detail_column_infos`. Core:
  `DateUtils.java` (`format`, `getOffsetInStandardFormat`, `parseDateTime`, `parseTimeAndStore`,
  `dateAdd`, `daysSinceEpoch`, `fractionalDaysSinceEpoch`); `FunctionUtils.java` (`toString`,
  `toNumeric`, `toDouble`, `toDate`, `expandDateSafe`); `XPathNowFunc.java`,
  `XPathFormatDateFunc.java`, `XPathSubstrFunc.java`, `XPathArithExpr.java`;
  `suite/model/Text.java::ensureCacheIsParsed`; `cases/entity/EntitySorter.java` (`getCmp`,
  `applyType`); `util/EntitySortUtil.java::sortEntities`; `cases/entity/Entity.java`.

Claims of the outline and the manifest found false, and the facts read at source that this part's
decisions rest on:

- **Verified at source (which texts Vellum gives a formatted copy):** the markdown widget is not the
  label's alone. The hint, the help text and the validation message are built by the same block as
  the label (`javaRosa/plugin.js::getMugSpec`: `hintItext`, `helpItext` and `constraintMsgItext`
  each call `itextBlock.label`), whose widget is the markdown widget on every question
  (`itextBlock.js::itextLabelBlock`). So each of the four texts holds a formatted copy exactly when
  its text looked like formatting as it was typed (`util.js::looksLikeMarkdown`) and the author left
  it on. A help text typed plainly has none.
- **Claim corrected (the outline, item 10):** that a hint and a validation message without a
  markdown form are things to hold. No runtime reads either's form: `FormEntryPrompt.getHintText`
  and `getConstraintText` ask for no form, and the Web Apps client renders the hint's default text
  as formatting whatever the form holds (`form_ui.js::Question.prototype.fromJS`). There is nothing
  for a stored setting to mean. Section 8.2 and "Departures" give what lands instead.
- **Claim corrected (the outline, item 8):** label text holding `instance('…')` is a shape "only an
  imported app holds". Any author can type it today, Nova writes it as a text node
  (`builder.ts::literalLabelNodes`), and HQ's build scans it (section 5). It is a defect of today's
  emitter, found here.
- **Claim corrected (`lib/commcare/surface/entries/questions.json`, `questions/help-text-markdown-form`):**
  "Nova always writes the markdown form, so Android always renders help as markdown" is true today and
  false once `plainHelp` exists (8.1).
- **Verified by script (the appearance entries the display vocabulary answers to):** they are 57, the
  56 HELD-NEW entries of the section "Appearances" and the Phone Number entry of "Question types".
  Section 2.4 places all 57, and the three other HELD-NEW question types that carry an appearance
  (face capture, the Android app callout and the acknowledge label).
- **Decided by reading (label text and HQ's instance scan):** HQ's build reads a label's
  `instance('x')` as an instance read, and section 5's spelling keeps the scan out. Section 5 gives
  the evidence at the commcare-hq pin, and the fix carries no condition.
- **Found while planning (two more places HQ's scan reads):** a CommCare Connect block's name and
  description are text nodes in the form's data (`builder.ts::buildConnectBlocks`), and the form's
  name is the text of `<h:title>` and the data root's `name` attribute
  (`builder.ts::buildXFormSource`). HQ's instance scan reads both as it reads a label, and neither
  has a protected spelling. Section 5.1 refuses the text at the gate.
- **Claim corrected (the step 7 outline at `main`, `7-rest-of-model.md` at `1f103305`, on a list
  sorted by a date and time):** that a case a phone wrote misorders "before it synced". A restore
  sends a case back only where a change came from another sync (`get_modified_case_ids.sql`), so
  the phone keeps the text it wrote after it syncs, until another phone or CommCare HQ changes the
  case. The defect is lasting on that phone, and it is in what Nova writes (7.1).
- **Claim corrected (the same bullet):** that step 3's instant lowering "can be the sort's `double`
  key". Core reads a sort text through `string()` (`Text.java::ensureCacheIsParsed`), which prints
  a number past `int` range in scientific notation (`FunctionUtils.java::toString`), and the
  decimal comparator then reads that text as no number (`FunctionUtils.java::toNumeric` refuses any
  character but a digit, `-` and `.`). A count of microseconds, milliseconds or, from 2038, seconds
  is such a number, so every row's key would be the same. Departure 11 gives the rest.
- **Found while planning (a copy of a stored date and time):** Core's parse of date-and-time text
  keeps the written date and moves only the clock (`DateUtils.java::parseTimeAndStore`), so today's
  wrapper lands a copied value a day off wherever the device's date for that moment differs from
  the written one. Over CommCare HQ's UTC text that is common. 7.1 writes stored text as it is.

---

## Written and not yet run

Each check below decides something. Each names where it runs and what the session does for every
outcome. None waits on a person. The ids keep their numbers; G2 is decided by reading (section 5).

**G1. CommCare HQ's form builder keeps each calculated value.** The proof lane's pull request run,
which runs HQ's editors (proof 4), over `targeted-prose-value` (section 4.9), whose outputs hold the
date chip, a call with string literals and spaces, a comparison with `<` and `>`, a string literal
holding a double quote and an ampersand, a lookup table read, and a relative read inside a repeat.
The served readers read the saved form in the lane dispatch over the step's new targeted documents,
which the session starts itself (part 14, section 12.4).
- *A: every output of the saved form is tree-equal to Nova's under the lane's proven spelling rules.*
  Nothing more lands.
- *B: a save changes or drops an output whose text holds some character class* (the candidates, from
  `src/xml.js::normalize`'s own comment that its empty-tag pattern "does not match
  `<tag attr="a > b">`": `<`, `>`, `"` or `&` inside the value). The class is not HQ-editable, so
  `lib/commcare/validator/rules/field.ts` gains the rule `PROSE_VALUE_NOT_KEPT_BY_FORM_BUILDER`,
  matched on the part's printed XForm text holding any of those four characters the run shows a save
  changes or drops, and on no other, with its three table rows (the code in
  `lib/commcare/validator/errors.ts`, class `soundness` in `gate.ts::VALIDITY_CLASS_BY_CODE`, and the
  message of "Copy" in `lib/doc/userFacingErrors.ts`). The rule's test is one exported predicate of
  that file, `proseValueNotKeptByFormBuilder(printed: string): boolean`, where `printed` is the
  value as `FormExpressionEmission.prose` writes it into `<output value>`. The builder's formula
  popover and the Solutions Architect show that message through the commit gate; the manifest gains
  the REFUSED entry `questions/output-value-holding-text-the-form-builder-rewrites`
  (`not-hq-editable`, subject `question-text`); and the offending output leaves
  `targeted-prose-value` for the retained control of that rule. No register entry. The reader's
  claim is the expressions reader's (part 08), never the form reader's (part 06): the class is a
  property of the bound value, which only binding knows. Where this outcome landed, part 08's prose
  slot row claims the entry ahead of `questions/output-value-any-other-expression`, by calling the
  same predicate over the candidate's print (part 08, sections 9.1 and 9.2), and the paragraph "A
  calculated value in text" of "Contracts and docs" gains one sentence naming the refusal.
- *C: a save changes an output's spelling only* (spacing, quote marks, an expanded path). The
  spelling rule that erases it lands with its proof: `proof/rules/prose_output_spelling.py` (rule id
  `prose-output-spelling`: an `<output>`'s `value` in the form builder's spelling reads as Nova's) and
  `proof/rules/test_prose_output_spelling.py`, which opens both spellings of each output the save
  changed in Core and requires `FormDef.fillTemplateString` to give equal text for each.

The same proof reads section 5's bracket output, `<output value="'('"/>`, in the label
`targeted-prose-value` carries. It is the spelling an ASCII whitespace run already has (a literal
string output with no Vellum shadow, `builder.ts::buildLabelNodes`), which the lane's two form
builder saves keep today (`lib/commcare/CLAUDE.md`, "Markdown itext"), so the one new fact is its
content. Under A nothing more lands. Under C the same spelling rule covers it. Under B (a save
changes or drops it) section 5 writes the bracket with the `json-property` spelling a Unicode
whitespace run has, which the same saves keep today, and `proof/hq/test_instance_text.py` holds that
spelling against HQ's scan.

**G3. Each runtime prints a calculated value as Preview does.** The lane's native family
`expression`, in the pull request run. The producer
`proof/native/producers/emit-expression-evidence.ts` writes `prose-values.json` from the vectors of
`lib/preview/engine/__tests__/proseValue.vectors.ts` (a text, a whole number, a decimal, a date, a
date and time, a yes or no, a blank, a formatted date), each with the form Nova emits for it and
Preview's text. `proof/native/core/ProseValueRuntimeTest.java`, entered
in `proof/native/families.py::CORE_CLASSES` as `"ProseValueRuntimeTest": "expression"` and in
`ZONED_CLASSES` under `DEVICE_ZONES` (the date and time vector reads the zone), opens each form in
Core and reads the label through `FormDef.fillTemplateString`. It also answers two questions wrongly
and reads `FormEntryPrompt.getConstraintText()`: one whose validation message holds
`{{= format-date(date(#form/visit), '%e %b %Y')}}` and one whose message holds a value beside a
reference.
- *A: every vector agrees, and each validation message reads as its composed text.* Nothing more
  lands.
- *B: a vector differs.* Preview's evaluator is corrected to Core's text and the vector kept. A
  difference between Formplayer's JVM zone and a device's zone on a date and time is stated by the
  existing platform rows `now` and `today`, never by a new one.
- *C: a validation message reads as its expression's own text* (Core caught an error raised while
  composing it). The composition of 4.4 is wrong for a value, and the error Core logs names the
  call. Where the call is `count`, a `count()` still wraps a scalar: the emitter is corrected to
  leave it out, and the message stays in the document. Where it is any other call, Core refuses the
  value's own lowering where a message is composed though it accepts it in an `<output>`, and that
  shape is refused as G1's outcome B refuses its class: `lib/commcare/validator/rules/field.ts`
  gains the rule `PROSE_VALUE_BREAKS_VALIDATION_MESSAGE`, matched on a `value` part of a
  `validate_msg` whose expression holds that call, with its three table rows (the code in
  `errors.ts`, class `soundness` in `gate.ts::VALIDITY_CLASS_BY_CODE`, the message of "Copy" in
  `lib/doc/userFacingErrors.ts`). The rule's test is one exported predicate of that file,
  `proseValueBreaksValidationMessage(expression: Expression): boolean`, true where the value's tree
  holds a call the run named. The manifest gains the REFUSED entry
  `questions/output-value-in-a-validation-message-core-cannot-compose` (`broken-at-runtime`, subject
  `question-text`); and the message leaves `targeted-prose-value` for the retained control of that
  rule. The reader's claim is the expressions reader's, as under G1's outcome B: where this case
  landed, part 08's prose slot row claims the entry for a `value` part of a validation message, ahead
  of `questions/output-value-any-other-expression`, by calling the same predicate over the bound tree
  (part 08, sections 9.1 and 9.2), and the paragraph "A calculated value in text" of "Contracts and
  docs" gains one sentence naming the refusal.

**G4. A device draws a help text with no formatted copy as typed.** The lane's Android reader, in
the slice over `proof/android/test_form_reads.py` that the session starts itself (part 14, section
12.4), over `targeted-plain-help`: the test reads the help of a question holding `plainHelp` and of
one without, each `**bold** and a [link](https://example.org)`.
- *A: the first shows its symbols and the second shows formatting.* The read stays in the lane as
  the evidence for the entry's Android reading, `RUNS (as written)`. The cell table takes no Android
  row for it: `platformCells.test.ts::requiredCells` asks a row only where a HELD entry reads
  neither `runs` nor `not-applicable`, and refuses any other.
- *B: both show formatting, or both show symbols.* `plainHelp` has no reading on any runtime, so the
  key, its switch, its tool input (and the two prompts of section 9 that name `plain_help`) and its
  manifest entry are not built, a help text follows section 8.2's rule for hints,
  `questions/help-text-markdown-form` becomes INERT beside them, and the paragraph "Text shown as
  typed" of "Contracts and docs" says a help text follows the rule of a hint.

**G5. What Android's number keypad keeps.** The lane's Android reader, in the same slice, over
`targeted-number-keypad`. `StringNumberWidget.java` installs
`new DigitsKeyListener(true, true)` (sign and decimal on) and overrides only `getAcceptedChars`. What
that listener's own filter does with a sign after the first character, or with a second period, is
the Android framework's and in no pinned checkout, so what the widget's text can hold is read, not
run. `proof/android/test_form_reads.py` enters `+1 555-1234`, `1.2.3`, `12+` and `a1` into the
question's widget, through the widget's own filters at the reader's Android runtime, and reads the
answer each leaves. `a1` is the control: a read that stores it whole did not pass the widget's
filter and is no evidence, and the test is corrected until it stores `1`.
- *A: the first three are stored as typed and `a1` as `1`.* `numberKeypadTyped` filters characters
  only, as 3.6 writes it, and the Android note of 3.4 stands.
- *B: a sign after the first character, or a second period, is dropped, and a space is kept.* After
  its character filter `numberKeypadTyped` under `"keys"` applies two rules, each only where its
  read shows it: where `12+` is stored as `12`, a `+` or `-` is kept only as the answer's first
  character; where `1.2.3` is stored as `1.23`, only the first period is kept. The vectors of
  `lib/preview/engine/__tests__/numberKeypad.test.ts` are the four reads. The Android note of 3.4
  and "Copy" becomes "the keypad offers digits, a period, a dash, a plus and a space" followed by
  "; a + or - only starts the answer" where the first rule lands and ", and it takes one period"
  where the second does (with one rule alone: "; it takes one period"). The public sentence of
  "Contracts and docs" takes the outcome B sentence given there.
- *C: the space of `+1 555-1234` is dropped.* The override does not reach the filter, so the keys
  are the listener's own. `ANDROID_NUMBER_KEYPAD_KEYS` is `"0123456789.-+"`, `numberKeypadTyped`
  applies outcome B's two rules as its reads show them, the Android note becomes "the keypad offers
  digits, a period, a plus and a minus, with no space" followed by outcome B's clauses where they
  land, and the Web Apps note stands as written: its facts are `PhoneEntry`'s, which this run does
  not read. `KeypadEditor`'s line and `FIELD_DOCS.keypad` stand (a leading zero and a + are kept
  either way). The public sentence takes the outcome C sentence of "Contracts and docs".

Preview's Android rule and its two notes merge only with the outcome written into them, and under
outcome B or C the sentence on Android's widget in the paragraph "The Phone Number question" of
"Contracts and docs" takes the platform note's words. The read stays in the lane as the evidence for
the row.

**G6. A phone writes a date and time as CommCare HQ stores it.** The lane's native family
`expression`, in the pull request run, with one test of the lane's HQ unit. The producer
`proof/native/producers/emit-expression-evidence.ts` writes `stored-instants.json` from the vectors
of `lib/domain/__tests__/hqInstantText.vectors.ts`, each an instant with the text `hqInstantText`
gives it: a moment whose UTC day is the day after the device's and one whose UTC day is the day
before, the last millisecond before UTC midnight, both sides of a daylight saving turn, a moment
before 1970, and midnight itself. `proof/native/core/StoredInstantRuntimeTest.java`, entered in
`proof/native/families.py::CORE_CLASSES` as `"StoredInstantRuntimeTest": "expression"` and in
`ZONED_CLASSES` under `DEVICE_ZONES` (UTC, New York, Kolkata with its half hour, Kiritimati at
fourteen hours), opens the forms of `targeted-datetime-saved` from the local archive and from
CommCare HQ's build, sets each vector as the question's answer and as the recorded clock `now()`
reads, submits, applies the submission through `CaseXmlParser` and reads the case's property. It
reads the copy row over a case stored in CommCare HQ's spelling too.
`proof/hq/test_stored_datetime.py` hands each vector's text, and the earlier device-offset text of
the same instant, to CommCare HQ's own `adjust_datetimes`.
- *A: every stored value equals its vector's text in every zone, the copy is exact, and
  `adjust_datetimes` returns the vector's text for both spellings.* Nothing more lands.
- *B: a value differs in some zone.* The piece of `storedInstantOfText` that the difference names
  (the day, the hour and minute, or the copied seconds) is corrected to give the vector's text
  there, and the vector kept. Nothing merges with a vector unequal.
- *C: `adjust_datetimes` changes the text Nova wrote* (the reading of `json_format_datetime` is
  wrong). The spelling is the one CommCare HQ returns: `storedInstantOfText`, `hqInstantText`,
  `HQ_DATETIME_PATTERN`'s use in 7.1 and the vectors take it, and 7.1's two examples are corrected.

**The search title read.** Where: `proof/webapps/test_search_title.py` (section 6), in the one
slice the session starts for the step's tests that take the Web Apps reader (part 14, section
12.4). It is a control on what section 6 read at the client's source, so it decides nothing new.
- *It passes.* Nothing more lands.
- *Web Apps draws a heading for the search with no title, or none for the search with one.*
  Section 6 misread the client. The session corrects the emission section 6 changes
  (`hqJson/caseList.ts::buildSearchConfigDocument` and the rows of section 6's table) and section
  6's sentence to what the client does, as the top-level file's rule for a control that
  contradicts the plan says, and runs the slice again.

No other fact of this part waits on execution. One thing of this part touches production, and the
top-level file's list of what needs a yes names it: the read-only scan of 5.1, which found nothing
during planning and is run once more before the merge and once more when the deploy has ended. 5.1
("What existing apps see") says what the scan reads and prints and what the session does with each
answer. Nothing of this part writes
production.

---

## 1. What Nova does today

**Question display.** No field holds a display setting but three facts of its kind or shape:
`lib/commcare/xform/builder.ts::buildLeafControl` writes `appearance="minimal"` on a `label`'s
`<trigger>` and `captureUpload.ts::UPLOAD_APPEARANCE_BY_CAPTURE_KIND`'s `signature` on a signature's
`<upload>`, and `buildContainer` writes `field-list` on a section and on a group holding `fieldList`.
Every other control carries no `appearance`. A Text question is `<input>` with bind `xsd:string`
(`xform/bindType.ts::BIND_TYPE_BY_KIND`), drawn in Preview by
`components/preview/form/fields/TextField.tsx` as a plain text box on both platforms.

**Prose.** `lib/domain/prose.ts::prosePartSchema` is a union of five arms: `text` and the four
reference kinds `field-ref`, `case-ref`, `user-property-ref` and `user-ref`. Every one of a field's
prose slots (`referenceSlots.ts::FIELD_REFERENCE_SLOTS`, kind `prose`: `label`, `hint`, `help`,
`validate_msg`, `option_label`) and the case type catalog's three (`blueprint.ts::casePropertySchema`'s
`label`, `hint` and option labels) store a `proseTemplateSchema`. A field's prose slot is already a
checking context: `expression/types.ts::ProseSlotRef` is a `SlotContextRef`, and `slotContext` gives it
the form-rule value profile (`slotProfile("form", "form", ["XF", "PV"], { kind: "value" })`). The
validator checks each reference part as a bare term in that context
(`lib/commcare/validator/index.ts`, findings of kind `field-prose`). The emitter lowers each reference
part through `xform/formExpressions.ts::FormExpressionEmission.prose` and writes
`<output value vellum:value>` (`builder.ts::buildLabelNodes`); a validation message that holds a
reference in some language is composed into the constraint expression
(`xform/constraintMessage.ts`). Preview evaluates each reference part's printed text
(`lib/preview/engine/formExpressionRuntime.ts::prose`, `labelRefs.ts::resolveLabel`). A translation
entry fingerprints its source as `source-v1:prose:` and the template's schema-order JSON
(`localization.ts::translationSourceFingerprint`), and must hold the same multiset of reference parts
(`translationUnits.ts::translationValueIntegrityIssue`). The builder edits prose in two TipTap editors
that share one picker (`components/builder/RefLabelInput.tsx`,
`components/preview/form/InlineTextEditor.tsx`, `ProseReferencePicker.tsx`); a reference is the atom
`lib/tiptap/commcareRefNode.ts::CommcareRef`, which stores the exact part. The Solutions Architect
writes prose as text with `{{name}}` and `{{#case/property}}` insertions
(`lib/agent/authoring/text.ts::parseInterpolatedText`), under the description every wording position
serves, `lib/agent/authoring/schema.ts::valueSchemas.text`. Literal text is written as text nodes, with
whitespace-only runs and non-breaking spaces protected by literal outputs
(`builder.ts::literalLabelNodes`); nothing protects text that CommCare HQ reads as XPath.

**The search title.** `modules.ts::ordinaryCaseSearchConfigSchema.searchScreenTitle` is
`z.string().min(1).optional()`, and absence means `DEFAULT_CASE_SEARCH_TITLE`, "Search", on every
surface: the translation inventory makes the default a unit (`translationUnits.ts`, role
`search-screen-title`), `hqJson/caseList.ts::buildSearchConfigDocument` writes the unit's text map as
`title_label`, `suite/case-search/searchSession.ts` writes it as the locale `case_search.<m>.inputs`,
and Preview shows it (`components/preview/screens/CaseListScreen.tsx`). No document says "no title".

**Sort.** `modules.ts::columnSortSchema` is `{ direction, priority }`. `caseListOrder.ts::caseListOrderPlan`
gives every rule a `blanks`, always `first` for ascending and `last` for descending (`finalRule`), and
the HQ JSON, the local suite, Preview's store read and Postgres read the plan's value
(`hqJson/caseList.ts`, `suite/case-list/sortKeys.ts`, `lib/case-store/postgres/store.ts`).

**A date and time on a case.** A phone writes it as text in the device's own zone, with its offset
and three fraction digits (`lib/commcare/xform/datetimeCaseValue.ts::datetimeCaseValueExpression`),
and Nova's case store holds the same shape in the viewer's zone
(`lib/domain/temporalValues.ts::storageDatetimeValue`). CommCare HQ stores every such value in UTC
with six fraction digits and `Z`. A list ordered by the property compares the text (7.1).

**Markdown.** A label and an inline choice write `<value form="markdown">` in every language unless
their owner holds `plainLabel`; a hint, a help text and a validation message always write it
(`builder.ts::addItext`, its `markdown` parameter; `lib/commcare/CLAUDE.md`, "Markdown itext"). The
platform row `plain-text` states the label's and the choice's difference, and Preview follows
`lib/preview/platform.ts`'s `hint` and `plainChoice` rules. No form holds a setting for its text
formatting, and Nova writes no `vellum:ignore`.

---

## 2. The question display vocabulary

### 2.1 The shape

CommCare holds how a control is drawn in one attribute, a string of tokens. Nova holds each thing an
author can choose about a question's display as its own typed fact. These rules bind step 7's group
`question-display`, which adds members and changes no rule:

1. **A display setting is an optional key of the field kind's own schema** (`lib/domain/fields/*.ts`),
   declared on exactly the kinds whose control reads it. The registry principle holds: a kind's schema
   declares only the slots it has, so a setting on a kind that cannot show it is unrepresentable.
2. **The key names what the worker sees**, in Nova's words (`keypad`, never `appearance` or a token).
3. **The value is from a closed set**: an enum, a whole number in a stated range, `true`, or an
   identifier under a stated grammar where the runtime takes a name (a broadcast topic). Absent is the
   platform's own behavior. No slot holds free text for a runtime to interpret.
4. **Settings compose by being separate keys.** Where CommCare reads two tokens differently by their
   order, each order a platform reads differently is its own value of one setting, or is the reader's
   finding; an order no platform reads differently is spelling, and the writer has one.
5. **One registry names every setting** (2.2), and a test holds it to the schemas both ways.
6. **One function writes every `appearance` attribute** (2.3), total over `Field`.
7. **A value one platform reads differently is a row of `PLATFORM_FEATURES`**, named by the registry,
   bound to its manifest entries by `platformFeatureEntries.ts`, with its Preview rule and cells.
8. **A setting is patched like any slot**: an `updateField` patch key, `null` to clear, and
   conversion keeps it only where the target kind's schema declares the same key, which is what
   `fields/index.ts`'s conversion does for every key today.
9. **The Solutions Architect and MCP take the same key and values** on the per-kind arms of
   `addFields` and `editField`, gated by `fieldKindDeclaresKey`.

`group.fieldList` (a group shown on one screen), the `label` kind and the `signature` kind are
appearance facts Nova already holds under rules 1 to 3. They keep their shape; 2.3 moves their tokens
into the one writer.

### 2.2 The registry

New file `lib/domain/fieldDisplay.ts`, importing `./fields` (types only) and `./platforms`:

```ts
export interface FieldDisplayValue {
	/** The value's name where the builder offers it. */
	readonly label: string;
	/** The platform row that states how each platform reads it, where they differ. */
	readonly feature?: PlatformFeatureId;
}
export interface FieldDisplaySetting {
	/** The schema key. */
	readonly key: string;
	/** Exactly the kinds whose schema declares the key. */
	readonly kinds: readonly FieldKind[];
	readonly values: Readonly<Record<string, FieldDisplayValue>>;
}
export const FIELD_DISPLAY_SETTINGS = [
	{
		key: "keypad",
		kinds: ["text"],
		values: { numbers: { label: "Number keypad", feature: "number-keypad" } },
	},
] as const satisfies readonly FieldDisplaySetting[];
export type FieldDisplaySettingKey = (typeof FIELD_DISPLAY_SETTINGS)[number]["key"];
/** The settings a kind's schema declares, in registry order. */
export function fieldDisplaySettingsFor(kind: FieldKind): readonly FieldDisplaySetting[];
/** Each setting a field holds, with its value's registry row. */
export function fieldDisplayValues(
	field: Field,
): readonly { key: FieldDisplaySettingKey; value: string; row: FieldDisplayValue }[];
```

`lib/domain/platformUses.ts::fieldUses` reads `fieldDisplayValues(field)` and pushes
`slotUse(row.feature, owner, key)` for each value that names a feature, so a new setting needs no
detector of its own. The registry is exported from the `lib/domain` barrel.

### 2.3 The one writer of `appearance`

New file `lib/commcare/xform/appearance.ts`:

```ts
/** The `appearance` a field's control carries, or undefined for none. The kind's own token first,
 *  then each display setting's token in `FIELD_DISPLAY_SETTINGS` order, joined by one space. */
export function fieldAppearance(field: Field): string | undefined;
```

| Field | Token |
|---|---|
| `label` | `minimal` |
| `signature` | `signature` (from `captureUpload.ts::UPLOAD_APPEARANCE_BY_CAPTURE_KIND`, which stays the source) |
| `section`; `group` holding `fieldList` | `field-list` |
| `text` holding `keypad: "numbers"` | `numeric` |

The setting tokens are an exported table of the same file, keyed by setting and then by value:

```ts
/** The token each value of each display setting writes. */
export const FIELD_DISPLAY_SETTING_TOKENS: {
	readonly [K in FieldDisplaySettingKey]: Readonly<Record<string, string>>;
} = { keypad: { numbers: "numeric" } };
```

A registry row with no entry here fails `tsc`, and `appearance.test.ts` holds that every value of a
registry row has a token (section "Tests"). The reader reads the table backwards for the strings
Nova writes, and any other string is its own manifest entry's to decide (part 06, section 9.2).
`builder.ts::buildLeafControl` and `buildContainer` take
the attribute from `fieldAppearance` and hold no token of their own. The emitted bytes of every
existing document are unchanged, which the same test holds.

It is the one writer for a question's control. The suite's `<prompt appearance>`
(`suite/case-search/searchPrompts.ts`) is a Search field's widget, which the Search input's own kind
decides, and stays where it is.

### 2.4 The shape holds every appearance entry

Step 7 names each setting when it builds it. This table is the proof that the shape has a place for
each of the 57 HELD-NEW appearance entries (the 56 of the manifest's section "Appearances" and the
Phone Number entry) and the three question types beside them (face capture, the Android app callout,
the acknowledge label). Step 6 builds the first row alone. The key names of the other rows bind
nothing: the step 7 group that owns an entry fixes its key when it builds it (`../7-rest-of-model.md`,
groups `question-display` and `xform`), under the rules of 2.1, which do bind. The owners are part
01's (Appendix A.1), and this table moves none. The appearance entries, subject
`question-appearance`, are `question-display`'s, all but one: the reference to a callout from
another input (`intent-id-on-any-input-other-than-an-intent-typed-one-where-id`) is `xform`'s,
because it cannot be built without the callout kind. The three question types are entries of the
manifest's section "Question types", subject `question-types`, and their owner is `xform` too:
`acknowledge-label-a-trigger-whose-appearance-is-neither-exactly`, `face-capture-image-face` and
`android-app-callout-input-appearance-intent-id-bind-type-intent`. So `xform` builds each of the
three kinds and the reference to a callout, under the same rules of 2.1. Each id below is the
entry's whole id after `questions/`.

| Manifest entries (under `questions/`) | Kinds | Setting and values, by 2.1 |
|---|---|---|
| `phone-number-xsd-string-appearance-numeric` | text | `keypad: "numbers"` (step 6) |
| `secret-numeric`; `text-secret-numbers`; `a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of` (its `numbers` arm) | text, secret | further values of `keypad`, one per distinct reading: Android reads `numbers` as it reads `numeric`, Web Apps ignores it, so it is a second value with its own platform row |
| `short`, `medium` | text, int, decimal and the other inputs Web Apps narrows | `width: "short" \| "medium"` |
| `text-address`; `broadcast-topic-an-address-entry-under-the-gates-above-and`; `text-receive-topic-field`; `select1-receive-topic-field`; `barcode-numeric-address-or-receive-topic-field` | text, barcode, single_select, capture kinds | `addressLookup: true`; `broadcasts: [topic]` and `receives: { topic, field }`, identifiers under a stated grammar |
| `hint-as-placeholder-on-text-other-than-a-secret-without-numeric`, `hint-as-placeholder-on-any-other-entry` | inputs | `hintPlacement: "placeholder"` |
| `intent-id-on-any-input-other-than-an-intent-typed-one-where-id`; `android-app-callout-input-appearance-intent-id-bind-type-intent` | inputs | a callout: a kind of its own (the second entry), and a reference to it by identity (the first entry); both owner `xform` |
| `barcode-quick`, `barcode-editable` | barcode | `scan: "on-open"`, `editable: true` |
| `select1-minimal`, `select1-compact-compact-n`, `select1-quick`, `select1-quick-compact-n`, `select1-combobox`, `select1-combobox-multiword`, `select1-combobox-fuzzy`, `select1-list`, `select1-list-nolabel`, `select1-label`, `select1-button-select` | single_select | `layout` (dropdown, grid, search box, row, row without labels, header row, button), `columns` (a whole number), `advance: "on-choice"`, `match: "words" \| "fuzzy"` |
| `select-minimal`, `select-compact-compact-n`, `select-list`, `select-list-nolabel`, `select-label` | multi_select | the same `layout` and `columns`, with the values a multiple choice reads |
| `date-ethiopian`, `date-nepali`, `date-gregorian-gregorian-cancel` | date | `calendar` |
| `time-12-hour` | time | `clock: "12-hour"` |
| `geopoint-maps` | geopoint | `picker: "map"` |
| `image-acquire`, `image-overlay-small`, `audio-legacy`, `audio-acquire-or-upload`, `audio-long`, `video-acquire`; `face-capture-image-face` | image, audio, video | `source`, `recorder`, `overlay`; face capture a kind, as signature is (owner `xform`) |
| `trigger-selectable`, `floating-good-floating-caution-floating-bad`, `a-label-whose-appearance-string-starts-with-floating-other-than` | label | `selectableText: true`, `banner` |
| `acknowledge-label-a-trigger-whose-appearance-is-neither-exactly` (section "Question types") | a kind of its own | an acknowledge question: it holds an answer (the entry's readings: a checkbox on Android, an automatic `OK` in Web Apps, where a required one never blocks), which a label does not, and a display setting never changes what a question answers, so it is a kind, as signature is (owner `xform`). Its control is a `<trigger>` whose kind token is none, and it takes the settings a label takes (`perRow`, `align`) as its own keys |
| `group-compact`, `group-group-collapse`, `group-collapse-open`, `group-group-border` | group | `compact: true`, `collapse: "closed" \| "open"`, `border: true` |
| `n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one`, `n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or`, `any-other-per-row-token-the-first-token-web-apps-per-row-pattern`, `text-align-center-text-align-right` | every visible kind; group | `perRow` (a whole number), `align` |
| `multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2`, `a-multi-token-string-holding-tokens-no-runtime-reads-on-that`, `a-single-string-no-row-names-that-holds-values-android-matches` | any | no setting of their own: several keys on one field, written in the writer's order (rule 4); the entries' emission cells already state one spelling |

---

## 3. The Phone Number question

### 3.1 What CommCare holds, and Nova's concept

Vellum's **Phone Number or Numeric ID** question (`src/mugs/types/text.js::PhoneNumber`, offered under
"Number" beside Integer and Decimal by `core.js::getQuestionGroups`) is a Text mug whose `init` sets
`appearance = "numeric"`. It is stored as `<input appearance="numeric">` with bind `xsd:string`, and
read back as that mug exactly when the bind type is `string` and the appearance is the whole string
`numeric` (`parser.js::buildControlNodeAdaptorMap`). HQ's question summary types the same tuple
`PhoneNumber` (`xform.py::VELLUM_TYPES`: tag `input`, type `xsd:string` or none, appearance `numeric`).
Lifecycle: alive in Vellum's palette, HQ's type table and both runtimes.

| Reader | What it does with a text input whose appearance is `numeric` |
|---|---|
| Core | keeps the string on the question (`XFormParser.java`, the control's `setAppearanceAttr`) and reads nothing from it; the value is `StringData` |
| Formplayer | sends it as `style.raw` and the datatype `str` (`PromptToJson.java::parseStyle`, `parseQuestion`) |
| Web Apps | where `numeric` is one of the space-separated tokens (`form_ui.js::getMatchingStyles`) draws `PhoneEntry` (`entries.js::getEntry`): a text box with `inputmode="tel"` that stores an answer only where it matches `^[+-]?\d*(\.\d+)?$`, and otherwise shows "This does not appear to be a valid phone/numeric number" and keeps the earlier answer |
| Android | where the whole appearance equals `numeric` or `numbers`, in any case, builds `StringNumberWidget` (`WidgetFactory.java::buildBasicWidget`): a keypad whose key listener's accepted characters are the digits and `.`, `-`, `+` and space (`getAcceptedChars`), and whose answer is the widget's text. The listener is `DigitsKeyListener(true, true)`, and what its own filter does with a sign after the first character or a second period is not in a pinned checkout (read, not run: G5) |

The answer is text on every reader, so a leading zero and a plus sign are kept, which is the point of
the question.

**Nova's concept.** A Text question that gives the worker a number keypad. Stored on the `text` kind:

```ts
// lib/domain/fields/text.ts
export const TEXT_KEYPADS = ["numbers"] as const;
export const textFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("text"),
	/** The worker types on a number keypad; the answer stays text. Absent: the full keyboard. */
	keypad: z.enum(TEXT_KEYPADS).optional(),
	validate: formLogicSchema.optional(),
	validate_msg: proseTemplateSchema.optional(),
	default_value: formLogicSchema.optional(),
});
```

It is not a kind of its own: its answer, bind, case property type, validation, starting value, saves
and conversions are a Text question's, and CommCare's two other readings of the same token (a Password
question, a barcode in Web Apps) are the same setting on those kinds in step 7. `textFieldMetadata` is
unchanged, and its `saDocs` gains one sentence (section 9.1).

### 3.2 What follows from "it is a Text question"

- **Value type and bind.** `fieldValueType` and `BIND_TYPE_BY_KIND` are untouched: text, `xsd:string`.
- **Case property type.** A save from it types the property `text` (`caseDataTypeForFieldKind`), the
  **Phone** column kind applies to it as to any text property (`columnApplicability.ts`), and a search
  input over it is a text input. Nothing joins on the keypad.
- **Conversion.** `textFieldMetadata.convertTargets` (`secret`, `barcode`, `single_select`, `hidden`)
  is unchanged. No target declares `keypad` in step 6, so each conversion drops it, as conversion drops
  every key the target does not declare.
- **Patches.** `updateField` takes `keypad: "numbers"` and `keypad: null` through the kind's partial
  patch schema (`fields/index.ts::partialOf`), with no change to `lib/doc/types.ts`.
- **References.** `keypad` is classified `config` in `referenceSlots.ts::NON_REFERENCE_FIELD_PATHS`,
  beside `fieldList` and `plainLabel`, which the registry's totality audit requires of every schema key.

### 3.3 Validation

Nova adds no rule to the question and no validator code. An author's own `validate` works as on any
Text question. What each platform refuses is the platform's, stated by the platform row (3.4) and
played by Preview (3.6). A starting value or a preloaded case value is not checked against the keypad:
neither runtime checks one either.

### 3.4 The platform row

`lib/domain/platforms.ts`: `"number-keypad"` joins `PLATFORM_FEATURE_IDS` after `"question-pages"`,
not refusable (both platforms run it), with the row:

```ts
"number-keypad": {
	label: "Number keypad",
	channel: "structure",
	webApps: {
		reading: "different",
		note:
			"an answer must be digits, with an optional + or - in front and an optional decimal " +
			"part, so a space or a dash inside it is refused",
	},
	android: {
		reading: "runs",
		note: "the keypad offers digits, a period, a dash, a plus and a space",
	},
},
```

`platformFeatureEntries.ts` binds it to `questions/phone-number-xsd-string-appearance-numeric`, and
`lib/domain/__tests__/platformFeatureFixtures.ts` gains its fixture (a Text question with and without
`keypad`, use `slotUse("number-keypad", FIELD_OWNER, "keypad")`). The use is found by 2.2's generic
detector. Because the row is not refusable it has no refusal copy, no picker line and no cause word.
The Android note is G5's outcome A; outcome B or C gives the note written there.

### 3.5 The builder

- **The question picker** (`components/preview/form/FieldTypePicker.tsx`). The "Input" submenu gains
  **Phone number** after Text, icon `tabler/phone`. The picker's item type widens from a `FieldKind` to
  the file's new `type FieldPickerItem = { readonly kind: FieldKind; readonly preset?: "phone-number" }`:
  `InsertionCategory.types` and `INSERTION_TOP_LEVEL` hold `FieldPickerItem`s, `handleSelect` and each
  row's `onSelect` take one, and a row's key is `item.preset ?? item.kind`. The preset inserts what
  the new builder gives, with the id `uniqueFieldId` makes from the base `phone_number`
  (`new_phone_number`) and the label "New Phone Number":

  ```ts
  // components/preview/form/newFieldDefaults.ts
  /** The starter of the picker's Phone number entry: a Text question with a number keypad. */
  export function newPhoneNumber(
  	id: string,
  	label: string,
  ): Omit<Extract<Field, { kind: "text" }>, "uuid"> {
  	return { ...NEW_FIELD_BUILDERS.text(id, label), keypad: "numbers" };
  }
  ```

  One mutation, one undo step, as any insert.
- **The Text inspector** (`components/builder/editor/fieldEditorSchemas.ts::textFieldEditorSchema`).
  The `ui` section's first entry is `{ key: "keypad", component: KeypadEditor, label: "Number keypad" }`,
  always shown. New `components/builder/editor/fields/KeypadEditor.tsx`, on `FieldListEditor`'s model,
  exports `KeypadEditor({ field, label }: FieldEditorComponentProps<TextField, "keypad">)`: a
  `ToggleRow` with the line of "Copy", on writes `keypad: "numbers"` and off `keypad: null`, one
  `updateField` each; `data-field-id="keypad"`; while off it shows
  `<PlatformNoteRow features={["number-keypad"]} />`, and once on the inspector's own note row states
  the feature for the question (`FieldPlatformNotes`), so it is not said twice.
- **The canvas** draws the question as Preview does (3.6); the question's kind label stays "Text".
- **Offering by declaration.** The row is not refusable, so nothing is disabled on any declaration, and
  `lib/doc/__tests__/platformOfferParity.test.ts` needs no row.

### 3.6 Preview

`lib/preview/platform.ts::PreviewPlatformRules` gains

```ts
/** A Text question with a number keypad. Web Apps `form_entry/entries.js::PhoneEntry` stores an
 *  answer only where it matches its pattern; Android `views/widgets/StringNumberWidget.java` limits
 *  the keys and stores what its key listener leaves in the box. */
readonly numberKeypad: "pattern" | "keys";
```

with `"pattern"` for `web-apps` and `"keys"` for `android`. New file
`lib/preview/engine/numberKeypad.ts`:

```ts
/** Web Apps' own pattern, `entries.js::PhoneEntry`. */
export const WEB_APPS_NUMBER_KEYPAD_ANSWER = /^[+-]?\d*(\.\d+)?$/;
/** The keys Android's widget accepts, `StringNumberWidget.java`. */
export const ANDROID_NUMBER_KEYPAD_KEYS = "0123456789.-+ ";
/** What typing leaves in the box: on Android, the text without the keys the keypad lacks. */
export function numberKeypadTyped(rule: PreviewPlatformRules["numberKeypad"], raw: string): string;
/** Whether the engine stores the answer: on Web Apps, only one the pattern matches. */
export function numberKeypadStores(rule: PreviewPlatformRules["numberKeypad"], raw: string): boolean;
```

`lib/preview/engine/formEngine.ts`, where it reads a typed answer for a Text question holding
`keypad`, calls both: under `"keys"` the stored and shown text is `numberKeypadTyped`; under
`"pattern"` an answer that does not match is not written to the instance, the question's state is
invalid with `runtimeMessage(language, "numberKeypadAnswer")`, and the earlier answer stays in the
instance, as `readNumericAnswer` refuses a whole number today. `TextField.tsx` sets `inputMode="tel"`
for such a question on both platforms. `numberKeypadTyped` under `"keys"` is G5's outcome A (a
character filter); outcome B or C gives the rule written there.

`lib/preview/__tests__/platformCells.ts` gains
`"questions/phone-number-xsd-string-appearance-numeric@web-apps": browser("number-keypad-web-apps")`,
the one cell the entry asks (its Android reading is `runs`). A browser cell names a scenario, so
`e2e/lib/previewPlatformScenarios.ts::PREVIEW_PLATFORM_SCENARIOS` gains

```ts
"number-keypad-web-apps": {
	platform: "web-apps",
	fixture: "questions",
	describe:
		"a Text question with a number keypad keeps 0712 and +254712, and refuses 12 34 with its message while keeping the earlier answer",
},
```

and `e2e/tests/browser/preview-platforms.spec.ts` implements it over the `questions` fixture of
`e2e/lib/preview-platforms-client.tsx`, which gains the question.

### 3.7 Emission and the lane

`<input ref appearance="numeric">` with the bind every Text question has; no generated node and no
instance. HQ's form builder reads it as its own question and writes it back unchanged (3.1), HQ's
build keeps the attribute, and the `.ccz` carries the same bytes. Lane document
`targeted-number-keypad` (declares both platforms): a registration form whose `phone` question holds
the keypad, saves to a property and shows in a Phone column. Its checks are in "Tests", and G5 reads
the question's widget on the Android reader.

---

## 4. A calculated value in prose

### 4.1 The part, and where it is admitted

```ts
// lib/domain/prose.ts
export const proseValuePartSchema = z.strictObject({
	kind: z.literal("value"),
	/** A form-rule expression that gives one value, shown as text where the part stands. */
	expression: formLogicSchema,
});
export type ProseValuePart = z.infer<typeof proseValuePartSchema>;
/** The four identity kinds, as today. */
export type ProseReferencePart = Exclude<ProsePart, { kind: "text" } | { kind: "value" }>;
/** Every part that is not literal text. */
export type ProseAtomPart = ProseReferencePart | ProseValuePart;
```

`prosePartSchema` gains the arm, so `proseTemplateSchema` admits it. The catalog's template is a
refinement of it:

```ts
/** A case property's label, hint or choice label: a template that holds no calculated value. */
export const catalogProseTemplateSchema = proseTemplateSchema.superRefine(
	/* refuses each `value` part at its own path, message in "Copy" */
);
```

It replaces `proseTemplateSchema` on `blueprint.ts::casePropertySchema`'s `label`, `hint` and option
labels: no form evaluates a catalog text (the suite prints it as a literal,
`suite/case-list/columns.ts`), so a calculated value there could mean nothing. It is a refinement and
not a second template over five arms for one reason: the authoring layer finds a text by its schema's
lineage (`lib/agent/authoring/schema.ts::familyOf` walks `_zod.parent` to the definition `families`
registers as `text`), and Zod keeps that lineage through `superRefine` and through no fresh object.
A separate schema would leave the `text` family, and `getCaseProperty` would print a label as its
stored parts. The template's type stays `ProseTemplate`, so every projector and the translation
inventory read a catalog text as they do today. Every field prose slot admits the part: `label`,
`hint`, `help`, `validate_msg` and an inline choice's `label`, on every kind that declares the slot.
No stored document holds the arm, so nothing migrates.

**One canonical form.** `proseReferenceExpression` moves from `lib/commcare/xform/proseExpression.ts`
(removed) to the new `lib/domain/proseExpression.ts`, which also exports its inverse:

```ts
/** The expression a reference part lowers to. */
export function proseReferenceExpression(part: ProseReferencePart): Expression;
/** The reference part an expression is the lowering of, or undefined. A question read spelled as an
 *  absolute path counts as its hashtag spelling: both print one path. */
export function proseReferenceOf(expression: Expression): ProseReferencePart | undefined;
/** The expression an atom part evaluates: a reference's lowering, or a value's own. */
export function proseAtomExpression(part: ProseAtomPart): Expression;
/** A value part, or the reference part its expression is the lowering of. */
export function canonicalProseAtom(expression: Expression): ProseAtomPart;
```

`proseTemplateSchema`'s refinement refuses a `value` part where `proseReferenceOf(expression)` is
defined (message in "Copy"), beside its rule against adjacent text parts. Every writer (the builder,
the tools, the reader, 4.8) builds a part through `canonicalProseAtom`, so a formula that only reads
one answer becomes that answer's reference chip. So does `{{= #user/region}}`: form
text binds `#user/<property>` as the worker-record read (`lib/commcare/xpath/expressionAst.ts`,
through `referenceBindings.ts::formUserProperty` with `"worker-record"`), which is exactly the
lowering of a `user-property-ref`. A formula that reads the
session's copy, `instance('commcaresession')/session/user/data/region`, binds with no `worker-record`
source, is no reference part's lowering, and stays a value. For an answer the match is by what
prints: a read of one question with no filter, spelled as a hashtag or as an absolute path, is the
`field-ref`, because `lib/commcare/xpath/wire/formReads.ts` prints those two spellings as one path
(so `<output value="/data/name"/>`, the form Nova itself writes for a `field-ref`, reads back as that
reference). A relative or `current()` read prints another path and stays a value.

`prose.ts`'s readers follow the arm:

| Function | A `value` part |
|---|---|
| `proseTemplateText` | skipped, as a reference is |
| `proseReferenceParts` | returns the four identity kinds only; new `proseAtomParts(template: ProseTemplate): readonly ProseAtomPart[]` returns every part that is not text, in document order |
| `projectProseTemplate(template, doc, options?)` | `options.value?: (part: ProseValuePart) => string` prints it; with no printer it projects as `[calculated value]` |
| `printProseTemplate(template, doc, options?)` | the same option; with no printer it throws `ProseProjectionError`, since a strict caller that meets one without a way to print it is a defect |
| `resolveProseTemplate` | passes `proseAtomExpression`'s projection to its evaluator: the callback takes the atom part |
| `mapCasePropertiesInProse(template, resolve, mapExpression)` | calls the new third argument on its expression. `lib/doc/mutations/referenceRewrites.ts::rewriteFieldReferenceSlots` (its `prose` arm) binds it to the rewrite its `expression` arm applies to a slot's tree, with the same `ops`; `lib/doc/casePropertyRenames.ts::rewriteCasePropertyCarriers` binds the same for each translation entry it already rewrites; the catalog's three calls pass none, since a catalog text holds no value |

### 4.2 The check

A `value` part is checked by `checkExpression(part.expression, slotContext(doc, slot, lookup))` with
`slot` the part's `ProseSlotRef`: the profile every prose slot already has, form rules and one scalar
value. So a value may read answers, the form's case, the worker, the session, lookup tables, places and
any function form logic has; a read of many values is refused as it is in a calculation
(`XPATH_MANY_VALUES`), and a platform's own functions are noted or refused by the checker's existing
`platform-unavailable` channel. Any scalar type is admitted, because every runtime prints the result by
XPath's string rule (4.4).

The validator reports its findings as `kind: "field-prose"` with `surface` the prose slot, so the
builder places them on the text they belong to. `lib/commcare/validator/index.ts`'s prose loop skips
`value` parts (the expression loop of 4.3 has checked them) and keeps its two rules for references: the
round-trip rule and "Text can read an answer, but cannot display a whole group or repeat." The skip
is `lib/domain/expressionSource.ts::prosePartTerm`'s new arm: it answers `undefined` for a `value`
part, as it does for text, because a value is no one term, so the validator's loop and
`lib/doc/formSectionVerdicts.ts`'s two prose walks pass over it. `formSectionVerdicts.ts`'s move
verdict reads values through the same enumeration.

### 4.3 One enumeration

`lib/domain/referenceSlots.ts`:

```ts
export interface ExpressionSlotValue {
	/** The slot the expression is checked in. A calculated value in prose carries its prose slot. */
	readonly ref: SlotContextRef;
	readonly expression: Expression;
	readonly path: readonly (string | number)[];
}
```

`visitExpressionSlots`, for a field owner, after the registry's expression entries, visits each
applicable prose entry in registry order (`label`, `hint`, `help`, `validate_msg`, `option_label`) and,
within a template, each `value` part in part order, with `holder` the part, `key` `"expression"`, `ref`
the prose slot (an option label's carries `member.optionUuid`) and `path` the concrete key path
(`["label", "parts", 2, "expression"]`). `rewriteExpressionSlotValues` therefore rewrites them.

`expressionSlotKey` widens to take a `SlotContextRef`: a prose ref keys as
`[entity, uuid, slot]`, with the option's uuid after them for an `option_label`. It has to, since
`expressionSlotValue` compares the key of every ref the visitor hands it, and it can: no prose slot
shares a name with an expression slot, so no prose key equals an expression slot's.
`expressionSlotValue` keeps taking an `ExpressionSlotRef`: a prose slot holds any number of values,
so one value's address is its slot and its `path`, and a caller that edits one holds the part itself
(4.7). The TypeScript widening of `ref` shows every consumer that narrows on it:

| Consumer | What it does with a prose value |
|---|---|
| `lib/commcare/validator/index.ts` (the field expression loop) | checks it; reports `field-prose` with the slot as `surface` |
| `lib/doc/referenceIndex.ts::extractFieldEdges` | `expressionEdges(sink, ref.slot, …)`, so its edges carry the prose slot's name; `extractProseRefs` handles the four reference kinds only |
| `lib/doc/lookupReferences.ts`, `platformNotes.ts`, `fieldWalk.ts`; `lib/domain/platformUses.ts` (expression uses, site the prose slot); `lib/commcare/locations/readsLocationsFixture.ts`; `lib/commcare/validator/rules/multiSelect.ts`, `rules/form.ts` | reads it as any field form-logic value: no arm of its own |
| `lib/domain/expression/context.ts` (`expressionFacts`, `referencedCountResults`) | included as a reader of answers and of count results; it feeds no other value, so inference gives it no type to anyone |
| `lib/commcare/xform/builder.ts` | included where the form's expressions are walked for carriers and instances; the text itself is written by 4.4 |
| `lib/preview/engine/expressionCaseReads.ts`, `useCaseDatabaseSnapshot.tsx`, `caseDataBindingHelpers.ts` | included, so Preview loads the case data a label's value reads |
| `lib/preview/engine/triggerDag.ts` | its wording block (4.5) |
| `lib/doc/formSectionVerdicts.ts` | compares its findings before and after a move, keyed by `path` |

Two readers do not walk the enumeration for a field. Each reads the registry's `expression` and
`prose` entries through `readSlotValues` and judges a template by its part kinds, so neither would
see a value. Each gains the arm:

| Reader | Today | With a value part |
|---|---|---|
| `lib/domain/workerRecordRequirements.ts::readsWorkerRecord` | a template reads the worker's record where it holds a `user-ref` or a `user-property-ref` | also where a `value` part's expression holds a worker-record term, by the term test the function already applies to an expression. So a label holding `{{= concat(#user/region, ' team')}}` lists its form in `lib/commcare/planPrivileges.ts::formsUsingWorkerRecord`, and the worker-record plan feature, its confirmation and the setup guide's section follow |
| `lib/doc/caseTypeRetirement.ts` (the field walk's `prose` arm, `proseNamesCaseType`) | a template names a case type where it holds a `case-ref` of that type | also where a `value` part's expression passes `expressionRefsCaseType`, so retiring a case type names the question whose text reads it (the reference stays "mentions it in its text") |

`lib/commcare/projectSpaceCompatibility.ts`'s walk of prose is the third, in 4.4.

A form structure under edit (the Solutions Architect's prepared forms,
`lib/domain/expression/formStructure.ts`) needs no prose values: nothing reads one to type another
value, and 9.2 parses each in its own slot.

### 4.4 Emission

Core reads each `<output>` of a text as an expression of its own (`XFormParser.java::parseOutput`,
preferring `ref` over `value`), evaluates it at the question's node
(`FormDef.java::fillTemplateString`, with the question's reference as context and original context)
and prints the result by XPath's string rule (`XPathConditional.java::evalReadable` →
`FunctionUtils.toString`): a date as its ISO day, a number as XPath prints it, yes or no as `true` or
`false`. Formplayer and Android show Core's text. Lifecycle: alive in every runtime and in Vellum.

- `xform/formExpressions.ts::FormExpressionEmission.prose` takes a `ProseAtomPart` and lowers
  `proseAtomExpression(part)` in the part's slot. `builder.ts::buildLabelNodes` is unchanged in shape:
  one `<output value vellum:value>` per atom, in every language's value and in the formatted copy.
- The instances a value reads are declared by the serializer, as for every attribute it writes.
- A validation message that holds a value is composed like one that holds a reference
  (`constraintMessage.ts::constraintMessageNeedsProtection` already tests "any part that is not text",
  and `protectConstraintMessage`'s `lower` takes the atom), with one difference. Today every non-text
  part enters `ambiguousReferences` as `count(x) > 1`, the guard that returns no wording where a
  reference names several answers. Core's `count` takes a node-set and nothing else
  (`XPathCountFunc.java::evalBody` throws `XPathTypeMismatchException` otherwise), a value's lowering
  is a scalar (`format-date(…)`, `#form/a + 1`, `concat(…)`), and Core answers an error raised while
  composing a message with the expression's own text, which the worker would read in place of the
  message. So `MessagePart`'s expression arm gains `readonly counted: boolean`, true for a
  `ProseReferencePart` and false for a value, and the guard is built from the counted parts alone. A
  value needs none: the slot's check has already refused one that reads many answers
  (`XPATH_MANY_VALUES`, 4.2). Its lowering enters `concat`, or stands alone, as it is. G3 reads the
  result in Core.
- **What CommCare HQ's form builder shows.** Vellum reads an output's `vellum:value` and shows a bubble
  where the text is one reference with no whitespace, a date bubble where it matches
  `^format-date\(date\(([^)]+)\),\s*'([^']+)'\)$` (`richText.js::extractXPathInfo`), and otherwise the
  output as written (`outputToBubble`), which its save keeps (`sanitizeInput`). Nova's printed
  `format-date(date(#form/dob), '%e/%n/%y')` matches the date pattern, so the commonest calculated
  value opens in HQ as the chip an HQ author would have made. Whether every other text survives a save
  unchanged is check G1.
- `lib/commcare/projectSpaceCompatibility.ts`'s `attachment-links` capability, which counts a link
  write a text prints, also walks each value part's terms (`expression/walk.ts::walkExpressionTerms`)
  with the two predicates it applies to a `case-ref` and a `field-ref`.

### 4.5 Preview

`lib/preview/engine/formExpressionRuntime.ts::FormExpressionRuntime.prose` takes a `ProseAtomPart` and
lowers `proseAtomExpression(part)` at the Preview target, cached by slot and part as today.
`labelRefs.ts::resolveLabel` and `resolveLabelAsync` pass atoms. `triggerDag.ts`'s wording block adds a
settle-free edge from every path `formReadPaths(part.expression, runtime.projection, runtime.readPath)`
gives, beside the edge a `field-ref` adds, so a label redraws when anything its value reads changes.
`formText.ts`'s itext table prints a value part with the same text. A validation message's fallback
to the generic wording (`labelRefs.ts::resolveConstraintMessage`, on a reference that names several
answers) stays a rule of reference parts, as the wire's guard is: a value is one scalar by its check.
The evaluator's result is string-coerced by the device's rule, which G3 holds to Core. Both
platforms read a value alike; no platform rule and no cell is added.

In edit mode `lib/references/LabelContent.tsx` draws a value as its chip (4.7); in the running preview
it draws the evaluated text. `lib/references/provider.ts::ReferenceProvider.projectTemplate`, the
plain-text projection of compact and search surfaces, adds `[calculated value]` for a `value` part
(the text of `projectProseTemplate` with no printer) and reports nothing unresolved for it;
`resolvePart` and `projectPart` keep taking a `ProseReferencePart`.

### 4.6 Translations

- **Fingerprints.** `translationSourceFingerprint` is the parsed template's JSON. A template without a
  `value` part parses to the bytes it parsed to before, so no existing fingerprint moves and no stored
  translation becomes stale. A template with one fingerprints its expression too, so editing the
  formula marks each translation out of date, as editing the text does.
- **Protection.** `translationUnits.ts::proseReferenceIdentity` takes a `ProseAtomPart` and gives a
  value `value\0` and `canonicalJsonText(part.expression)`; `proseReferenceSignature` filters on
  "not text". A translation must hold the same multiset: it may move a value and may not change it.
- **The translator** (`lib/agent/translation/translator.ts`) already replaces every non-text part by a
  protected token and restores the part by token; its `tokenReferences` map holds `ProsePart`, so it
  needs the type widening alone. `lib/agent/tools/localization.ts::protectedParts` and
  `components/builder/app-setup/protectedProse.ts` likewise; a token's label is the part's projection,
  `{{= formula}}` for the tools and the formula for the builder.
- **Renames.** 4.1's `mapCasePropertiesInProse` keeps a renamed property's translations current.
- **The language view's refusal.** Editing a text under a worker language other than the source
  refuses a translation that changes a protected part
  (`lib/doc/projectBuilderLanguageMutations.ts`, on `translationValueIntegrityIssue`'s
  `protected-content`). Its sentence names answers, case values and worker values today; it takes the
  sentence of "Copy", which names calculated values too.

### 4.7 The builder

The atom `lib/tiptap/commcareRefNode.ts::CommcareRef` already stores any non-text part exactly. Its
`encodeProseReferencePart`, `decodeProseReferencePart` and `serializedProseReferencePart` take and
return `ProseAtomPart`, as do the node's `part` attribute and
`proseTemplateCodec.ts::proseTemplateToTiptapContent`'s `labelFor`. `markdownExtensions.ts` and
`lib/tiptap/formatText.ts` follow by type with no edit: each treats every part that is not text
alike. `proseTemplateSurvivesTiptapRoundTrip` holds for a value because the codec copies the part.

- **The chip.** `lib/tiptap/CommcareRefView.tsx` draws a value part as the new
  `lib/references/ValueChip.tsx` (`ValueChip({ text }: { readonly text: string })`): icon
  `tabler/math-function`, the formula's printed text in the mono face, truncated by width with the
  whole formula as its title, in the reference chip's neutral colors. A value whose expression no
  longer prints (a removed question) draws `UnresolvedReferenceChip` with the text of "Copy". The
  text comes from the first of two new hooks of `lib/doc/hooks/useXPathSlots.ts`:

  ```ts
  /** A calculated value's formula on one line, as its chip shows it; undefined where the slot is
   *  gone or the expression no longer prints (`projectFormExpression` reports it unresolved). */
  export function useProseValueText(
  	part: ProseValuePart,
  	slot: ProseSlotRef | undefined,
  ): string | undefined;
  /** Parses a formula in a prose slot and builds its part with `canonicalProseAtom`. `current` is
   *  the expression of the part being edited. Throws an `Error` holding the parse's sentences
   *  joined by a space, as `useParseFormExpression` does; the slot's check is the editor's lint. */
  export function useParseProseValue(
  	slot: ProseSlotRef | undefined,
  	current?: Expression,
  ): (text: string) => ProseAtomPart;
  ```
- **Insert and edit.** `components/builder/ProseReferencePicker.tsx` gains one row above its search
  results, **Calculated value**, and its trigger reads **Edit calculated value** while a value chip is
  selected. Either opens the new `components/builder/ProseValuePopover.tsx`, anchored where the
  picker is:

  ```ts
  interface ProseValuePopoverProps {
  	readonly open: boolean;
  	readonly onOpenChange: (open: boolean) => void;
  	/** The text's slot: where the formula is parsed, linted, completed and checked. */
  	readonly slot: ProseSlotRef;
  	/** The value being edited. Absent for a new one. */
  	readonly editing?: ProseValuePart;
  	/** The part to insert, or to put in place of `editing`. */
  	readonly onCommit: (part: ProseAtomPart) => void;
  	/** Removes `editing`. The Remove button shows only while `editing` is set. */
  	readonly onRemove: () => void;
  }
  export function ProseValuePopover(props: ProseValuePopoverProps): ReactNode;
  ```

  It is a popover titled **Calculated value** holding `XPathField` with the slot's lint, completion
  and chips, **Insert** (**Save** while editing) and, while editing, **Remove**. **Insert** and
  **Save** are disabled while the editor is empty. On commit it parses the text in the slot
  (`useParseProseValue(slot, editing?.expression)`) and hands the part to `onCommit`, and the picker
  replaces the selection through the new
  `lib/tiptap/proseReferenceEditing.ts::insertProseAtom(editor: Editor, range: Range, part:
  ProseAtomPart): boolean`, one undo step, as `insertProseReference` is, with no provider lookup: the
  part is already built. A parse or check finding shows inline in the popover and nothing is
  inserted. The popover is the shared `@/components/shadcn/popover`; the picker is shared by both
  prose editors, so the label's inline editor and every inspector text gain it together.
- **The slot.** `RefLabelInput` and `InlineTextEditor` take a new prop `proseSlot: ProseSlotRef`, which
  each call site has (the field and the key it edits; an option's uuid for a choice label), and pass it
  to the picker. A text with no slot (a case property's label in Project data) gets no **Calculated
  value** row.
- **The scope.** `lib/commcare/xpath/formParseScope.ts::FormParseScope.slot`,
  `lib/doc/expressionText.ts::formParseScopeForSlot` and `projectFormExpression`,
  `lib/codemirror/expressionEditorContext.ts::ExpressionEditorContext.slot` and
  `buildExpressionEditorContext`, and `useXPathSlots.ts`'s hooks widen from `ExpressionSlotRef` to
  `SlotContextRef`. For a prose slot `formParseScopeForSlot` takes the stored tree to bind against from
  its caller (`options.current`, the expression of the part being edited, absent for a new value) in
  place of `expressionSlotValue`, and `buildExpressionEditorContext`'s options carry the same
  `current` to it. `lib/commcare/xpath/formPrintContext.ts` hands `scope.slot` to `slotContext`,
  which takes a `SlotContextRef` today, so it follows the widened `FormParseScope` with no edit.
- **The context cache.** `useXPathSlots.ts::expressionEditorContextFor` keeps one context per slot
  key and variant. Two values in one label share a slot and differ in the tree each binds against,
  so the cache must tell them apart: its key is the widened `expressionSlotKey(slot)` (4.3), and a
  variant matches where its `form`, its candidate and now its `current` are the same (`current`
  compared by object identity: the stored part's expression, or `undefined` for a new value). The
  hooks take `current` as a fourth argument, which only the popover passes.
  `lib/doc/hooks/useExpressionSlotContext.ts::expressionCandidateDoc` widens its slot to
  `SlotContextRef` with no new arm: a prose ref's entity is `field`, so the field arm substitutes a
  pending field for it exactly as it does for a field's expression slot.
- **The translation editor** shows a value as its protected token, movable and not editable.

### 4.8 What the reader is handed

The reader's forms pass (part 06, section 12.3) reads an `<output>` that is one string literal back
as text, and registers every other `<output>` of the source language as a pending `value` part
under its prose slot. Part 08 (section 10.2) binds it in that slot, and `canonicalProseAtom` then
builds the part, so a plain reference reads as its reference part and anything else as a value. A
part holds no identity, so part 10's `IdentityResolver` (its section 2) mints nothing for one.

### 4.9 The lane document

`targeted-prose-value` (declares both platforms; two languages): a follow-up form with a date question
and labels holding the date chip, a `concat` with literals, a comparison in an `if`, a literal holding
`"` and `&`, a lookup table read, a hint, a help text and a choice label each holding a value, a
validation message holding a `format-date` value and one holding a value beside a reference (the two
G3 reads in Core), a value inside a repeat reading its own row, a second language whose label moves
its value, and the label of section 5. Its checks are in "Tests".

---

## 5. Text CommCare HQ reads as an instance

HQ's build renders the whole form and searches the text for instance reads
(`models/forms.py::FormBase.add_stuff_to_xform` → `xform.py::XForm.add_missing_instances`), with the
pattern `instance\(\s*['"]([\w\-:]+)['"]\s*\)` over the HTML-unescaped document
(`suite_xml/post_process/instances.py::get_instance_names`). The search does not tell an expression
from a label. For each name the form does not declare, HQ adds the instance where it knows the name
(`get_instance_factory`) and refuses the build otherwise: "The form … is missing some instance
declarations that can't be automatically added". Lifecycle: alive, on every build.

Nova already keeps an XPath string literal from matching (`xpath/wire/serialize.ts::literalPieces`
cuts it after `instance`). A label's literal text has no such guard: `builder.ts::literalLabelNodes`
writes it as a text node, so a label that says `instance('abc')` cannot be built by HQ, and one that
says `instance('casedb')` gains a declaration nothing reads.

**The evidence, read at the commcare-hq pin.** The fix below carries no condition, because each step
of the reading is in the source:

- `FormBase.add_stuff_to_xform` calls `xform.add_missing_instances(self, app)` after
  `normalize_itext` and `strip_vellum_ns_attributes`, and `FormBase.render_xform` runs that for every
  form a build renders.
- `XForm.add_missing_instances` hands one string to the scan, `self.render().decode('utf-8')`, where
  `WrappedNode.render` is `ET.indent` then `ET.tostring`. So the scan's input is the form's
  serialized XML, labels and expressions alike.
- `get_instance_names` runs `html.unescape` over that string and then `instance_re`. A match needs
  the characters `instance(` in a row.
- Today's spelling writes the label as one text node holding `instance('nova_absent')`. Whether the
  serializer writes the apostrophes bare or as references, `html.unescape` gives the pattern its
  match. `get_instance_factory` answers `null_factory` for a name it has no scheme for, so
  `XForm._get_instance_ids` does not hold it and `add_missing_instances` raises
  `XFormValidationError`. `casedb` is a key of `INSTANCE_KWARGS_BY_ID`, so `add_instance` declares
  it. HQ's own test holds the refusal:
  `tests/test_form_preparation_v2.py::test_add_remote_instances`.
- With the fix, the serialized text holds `instance`, then the element `<output value="'('"/>`,
  then the rest. The character after `instance` is `<`, and the only bracket the cut writes follows
  an apostrophe inside an attribute. `html.unescape` turns references into characters and cannot
  remove an element, so the string holds no `instance(` at the cut and the pattern cannot match,
  whatever the serializer escapes.

`docs/research/2026-09-26-hq-round-trip/harness-findings.md` holds the defect as finding 76. Reading
does not show that HQ's form builder keeps the bracket output across a save, which is G1's question,
or that a worker reads the same characters, which is the lane's reading of `targeted-prose-value`.

**The fix.**

- New file `lib/commcare/hqInstanceScan.ts` exports `instanceScanCuts(value: string): number[]`, the
  offsets just after each `instance` that HQ's pattern would start a match at (today's
  `INSTANCE_LITERAL`, moved here). `serialize.ts::literalPieces` and `literalLabelNodes` both call it.
- `literalLabelNodes` writes, at each cut, the text up to and including `instance`, then the bracket as
  a literal output, `<output value="'('"/>`, then the rest. A worker reads the same characters on every
  runtime (Core substitutes the bracket), HQ's pattern finds no `instance(`, and the output carries no
  Vellum shadow, as the whitespace outputs carry none. HQ's form builder shows that output as written
  and keeps it.
- Nothing is refused, the text stays one `text` part in the document, and no editor shows a
  difference. The reader's inverse is the one it already needs for whitespace outputs: a literal string
  output reads back as its text.

An output's own text needs no guard: a `value` part's instances are declared (4.4), and the string
literals inside it are cut by the serializer. The split changes no behavior and nothing declares it
(part 09, section 11.4). `proof/hq/test_instance_text.py` builds both spellings through HQ's own
build as an ordinary test with one expectation ("Tests").

### 5.1 Text with no protected spelling: a form's name, and a Connect block's name and description

A label can be protected because an itext value takes an `<output>`. Two kinds of authored text sit in
a form's source where no element can stand between `instance` and its bracket, and HQ's scan reads
both.

**What happens today.** `lib/commcare/xform/builder.ts::buildXFormSource` writes three kinds of
authored text outside itext and outside an expression:

- A Connect block's text, as text nodes of the form's data
  (`builder.ts::buildConnectBlocks`): a learn module's `<name>` and `<description>`, a deliver unit's
  `<name>`, and a task's `<name>` and `<description>`. Each is a plain string in the document
  (`lib/domain/forms.ts`, `connectLearnModuleSchema`, `connectDeliverUnitSchema`,
  `connectTaskSchema`: `z.string()`), in one language (`lib/domain/translationUnits.ts`, the coverage
  diagnostic `connect-text-has-no-locale-carrier`).
- The form's name in the app's default language (`lib/domain/formWireName.ts::formWireName`), as the
  text of `<h:title>` and as the data root's `name` attribute
  (`lib/commcare/xform/dataRootAttributes.ts::xformDataRootRuntimeAttributes`).
- A choice's value, as the text of an `<item>`'s `<value>`. It can hold no quote mark
  (`lib/domain/selectOptionValue.ts::SELECT_OPTION_VALUE_PATTERN`, `SELECT_OPTION_VALUE_INVALID`), so
  HQ's pattern cannot match it. It needs nothing.

That list is complete. It was made by reading every `text(…)` call and every attribute that holds an
authored string in `builder.ts` and `xform/constraintMessage.ts`. The other text a form's source
holds is itext, which section 5 protects, and the pieces of a composed validation message, which
`constraintMessage.ts::asciiJson` already writes with every apostrophe as `\u0027` and every double
quote as `\"`, so no quote mark follows a bracket there.

Nothing checks the first two. `lib/commcare/validator/rules/xmlText.ts::authoredXmlText` reads them
only for characters XML cannot hold. So a learn module described as
`Shows how instance('casedb') works`, or a form named `instance('abc') practice`, is admitted, saved
and emitted as typed. `docs/research/2026-09-26-hq-round-trip/harness-findings.md` holds the defect
as finding 77.

**What HQ does with it.** HQ's scan is section 5's: one string, the whole rendered form, read by
`instance_re` after `html.unescape`. So what it reads is `instance(`, any whitespace, a quote mark,
a name of letters, digits, `_`, `-` and `:`, a quote mark of either kind, any whitespace, and a
closing bracket. It reads that in a title, in an attribute and in a data node exactly as in a
formula. For each name the form does not already declare (`XForm._get_instance_ids`):

- *HQ has no source for the name* (`instances.py::get_instance_factory` answers `null_factory`, or
  the name's own factory answers nothing). `add_missing_instances` raises "The form … is missing some
  instance declarations that can't be automatically added". Every build of the app then fails
  (`models/applications.py::Application._get_form_files` re-raises it as `Error in form "…"`, and
  `helpers/validators.py::ApplicationBaseValidator.validate_app` reports it), so the app has no
  version at all. CommCare Connect reads an app only from a build HQ made
  (commcare-connect `opportunity/app_xml.py::get_form_xml_for_app`), so a Connect app in this
  state gives Connect nothing.
- *HQ has a source for the name* (`instances.py::INSTANCE_KWARGS_BY_ID`, and the factories for
  `item-list`, `locations`, `commtrack`, `schedule`, `indicators`, `selected_cases` and the rest).
  `add_missing_instances` calls `XForm.add_instance`, and the built form declares a data source that
  no formula of the form reads. For `casedb` and `commcaresession` that is all: every runtime holds
  both. For a fixture, such as a lookup table (`instance('item-list:villages')`) or `locations`,
  Core opens every declared source when the form opens (commcare-core
  `core/model/FormDef.java::initialize`), and a fixture the device does not hold stops the form
  there: `core/process/CommCareInstanceInitializer.java::loadFixtureRoot` raises
  `FixtureInitializationException` where `core/sandbox/SandboxUtils.java::loadFixture` finds none, on
  Android (`utils/AndroidInstanceInitializer.java::setupFixtureData`, caught in
  `tasks/FormLoaderTask.java`) and in Web Apps
  (formplayer `session/FormplayerInstanceInitializer.java::setupFixtureData`). The worker cannot
  open the form. (The runtime half was read at those symbols and not run.)

Either way HQ's build is not the form Nova states. Nova declares exactly the sources a form's printed
formulas read (`lib/commcare/CLAUDE.md`, "Secondary instances"), and the local `.ccz` holds no such
declaration.

**Why no spelling keeps it out.** The text is not Nova's to re-spell. Connect reads a block's `name`
and `description` as the element's own text, from the built form when an opportunity is set up
(`opportunity/app_xml.py::extract_modules`, `extract_deliver_unit`, `extract_task_unit`, through
`get_element_text`, which is `element.text`) and stores it as read
(`opportunity/tasks.py::sync_learn_modules_and_deliver_units`), and again from each submission
(`form_receiver/processor.py::get_or_create_learn_module`). HQ's form builder reads and writes the
same text (Vellum `src/commcareConnect.js`, `parseDataNode` and `dataChildFilter`). So:

- A child element between `instance` and the bracket cuts what Connect reads: `element.text` ends at
  the first child.
- A character reference or an escaped quote changes nothing: HQ parses the source, renders it again
  and unescapes it before the pattern runs.
- A comment between the two halves is removed when HQ parses the source
  (`xform.py::parse_xml`, `remove_comments=True`), which joins the halves again.
- A calculate that builds the text leaves the element empty in the built form, which is where
  Connect reads a learn module's name.
- An invisible character between `instance` and the bracket changes what Connect stores and shows,
  and what a person copies, without saying so.
- Declaring the source in Nova's own form would make HQ's check pass, and would put a data source
  nothing reads into every worker's form to carry a sentence of prose. For a fixture the device
  lacks, that is the failure above.

A form's title is plain text in the same way, and HQ's form builder writes the form's name into the
title and the `name` attribute on every save (`lib/domain/formWireName.ts`, its comment), so any
spelling Nova chose there would be undone.

**The fix.** Nova refuses the text at the gate, in the two places and nowhere else, and says the one
change that keeps it as text: a space before the bracket. `instance ('casedb')` reads the same to a
person, and HQ's pattern, which needs `instance(` unbroken, finds nothing in it.

This is right for the worker because every form HQ builds from a Nova app then declares only what
its formulas read, and no form fails to open over a sentence in a description. It is right for the
author because the alternative is not a kept text: it is an app HQ cannot build, or a built form
that differs from the one Nova shows, found later and far from the text that caused it. The author
loses one spelling of one phrase and is told the other in the same sentence.

One rule covers every name, `casedb` and `commcaresession` included, although HQ's build of those
two only gains a declaration nothing reads. Two reasons. The author gets a rule they can predict
("this text reads as a data source") in place of one that turns on which names CommCare HQ happens
to know. And holding those two would need Nova to copy HQ's list of known names and to state a
source that no formula reads, in the document, the local archive and the oracles that hold the two
equal, all to carry prose. Nothing needs it.

**The predicate.** `lib/commcare/hqInstanceScan.ts` (the file of section 5) gains one export beside
`instanceScanCuts`:

```ts
/** The first text in `value` that CommCare HQ's build reads as an instance, or `undefined`. */
export function instanceScanRead(value: string): string | undefined;
```

Its pattern is HQ's whole pattern, with the same whitespace class `instanceScanCuts` uses and with
the name written as `[^'"]+`: `instance\(` then whitespace, a quote mark, one or more characters
that are no quote mark, a quote mark, whitespace, `\)`. HQ's name class holds no quote mark, so
every text HQ's pattern matches, this one matches at the same place, whatever letters either
runtime's Unicode tables hold. It is wider than HQ's in one way only: a closed call whose name
holds a character outside HQ's class, such as `instance('a b')`, is refused though HQ reads
nothing there. That costs an author nothing they would write, and it removes the one way the
predicate could be narrower than HQ's.

`instanceScanCuts` keeps its shorter pattern (the head of this one). A cut that was not needed costs
nothing, so the split sites cut wherever a match could start. A refusal that was not needed costs
the author a text, so the refusing sites ask for the whole shape.

The predicate reads the authored string. That is the string HQ's pattern sees: HQ parses the source
back to the authored characters, its render escapes every `&` again, and `html.unescape` reads each
reference once (`lib/commcare/xpath/wire/serialize.ts::hqHtmlUnescape`, its comment), so rendering
and unescaping give the authored text back. The lane holds that with the two rows typed as
references (below).

**The places.** New file `lib/commcare/xform/sourceTexts.ts`, beside the emitter whose output it
describes:

```ts
export type FormSourceTextSite =
	| "form-name"
	| "learn-module-name"
	| "learn-module-description"
	| "deliver-unit-name"
	| "task-name"
	| "task-description";

export interface FormSourceText {
	readonly site: FormSourceTextSite;
	readonly text: string;
}

/** Every authored text a form's source holds as plain text: outside itext and outside a formula. */
export function formSourceTexts(doc: BlueprintDoc, formUuid: Uuid): readonly FormSourceText[];
```

`form-name` is `formWireName(doc, formUuid)`, the one name the source holds. The form's name in any
other language reaches only the app's strings, which HQ's scan does not read, so it is not listed
and not refused. The Connect texts are those of `form.connect` as it stands. The file imports
`lib/domain` alone, so the validator, which also runs in the browser, can read it without the
emitter.

**The rule.** `lib/commcare/validator/rules/form.ts` gains `formTextReadAsInstance(doc, ctx)`, called
from `runFormRules` beside `connectValidation`. For each `formSourceTexts` entry whose text
`instanceScanRead` answers, it files one finding:

| | |
|---|---|
| Code | `FORM_TEXT_READ_AS_INSTANCE`, in `lib/commcare/validator/errors.ts` |
| Class | `soundness`, in `gate.ts::VALIDITY_CLASS_BY_CODE`. It binds every target a form has: HQ builds every form it is sent, and a `.ccz` is made only for a project space the app is published to |
| Scope and location | `form`, at the form (`baseLocation(ctx)`) |
| `details` | `site`, the `FormSourceTextSite`; `match`, what `instanceScanRead` answered, cut to its first 40 characters |
| Messages | the validator's and the builder's, by site, in "Copy" |

No schema changes. The stored strings stay `z.string()`, so every stored document still loads, and
the rule lives with the validator because the pattern is CommCare HQ's.

The scoped gate needs no change. A rename keeps its form in the footprint
(`lib/doc/incrementalValidationScope.ts`, `renameForm`), an edit of a form's Connect block is an
`updateForm` of that form, and every language mutation, which is what can change the default
language's name, takes the whole-document gate there.

**Surfaces.**

- *The builder.* No component changes. Every editor of these texts commits through the gate and
  shows a refusal beside the field with the draft kept
  (`lib/ui/hooks/useCommitField.ts`, through `components/builder/detail/formSettings/InlineField.tsx`
  for a block's name and description and the form title's editor for a name; the Connect manager
  shows the gate's lines under its drafts, `ConnectManagerDialog.tsx`, `rejectionMessages`). A
  translated name goes through the same gate. The person reads the builder sentence of "Copy".
- *The Solutions Architect and MCP.* No tool, schema or description changes. `configureConnect`,
  `updateForm`, `createForm` and a rename all commit through the shared gate
  (`lib/agent/tools/common.ts::guardedMutate`) and answer with the validator's message, which names
  the form, the text and the spelling that works. No guide sentence is added: the text is rare, and
  the refusal says everything a sentence would. A refusal's message is no part of a tool's schema,
  so 5.1 adds nothing to the step's one move of `MODEL_CONTEXT_VERSION` and gives the billed schema
  check nothing to send.
- *Publish, the HQ import file and the `.ccz`.* Unchanged. Each runs the full validator at its
  boundary (`gate.ts::evaluateBoundary`), so the rule holds there with no new stage and no new
  confirmation.
- *Preview.* Unchanged on both platforms. No runtime shows a Connect block's text (Connect does), and
  Preview reads a form's name from the same `formWireName`, which the gate has already judged.
- *The platform table, Postgres, the reference index.* Unchanged: this is no platform difference, no
  stored case data and no reference.
- *`../nova-plugin`.* Swept for a sentence about what a Connect name or a form's name may hold: its
  skills say nothing of either.

**The manifest.** Two new REFUSED entries, each landing with the rule and its inventory row, and one
new subject for both, `instance-text` (part 01, section 2.2, and its sentence in section 9.2). Each
takes the refused arm's fixed `platforms` and `emission` values and `gates: []`.

| `id` | File and section | `surfaceKeys` | `valueClass` | `item` |
|---|---|---|---|---|
| `questions/connect-block-text-read-as-an-instance` | `entries/questions.json`, "Question types", beside `questions/connect-task` | `mug:ConnectLearnModule`, `mug:ConnectDeliverUnit`, `mug:ConnectTask`, `vellum-plugin:commcareConnect` | `text-read-as-an-instance` | "a Connect learn module's or task's name or description, or a deliver unit's name, holding `instance('…')`" |
| `forms-and-case-writes/form-name-read-as-an-instance` | `entries/forms-and-case-writes.json`, "Form fields", beside `forms-and-case-writes/name-lang` | `schema:Form.name`, `schema:AdvancedForm.name` | `default-language-name-read-as-an-instance` | "`name{lang}` in the app's default language holding `instance('…')`" |

Both hold `subject: "instance-text"` and the same two reasons and cell:

- `{ kind: "not-hq-buildable", named: "`xform.py::XForm.add_missing_instances`: \"is missing some instance declarations that can't be automatically added\"", condition: "a name CommCare HQ has no source for" }`
- `{ kind: "broken-at-runtime", named: "the built form declares the source (`XForm.add_instance`), Core opens every declared source with the form (`FormDef.initialize`), and a fixture the device does not hold raises `FixtureInitializationException` (`CommCareInstanceInitializer.loadFixtureRoot`)", condition: "a fixture name CommCare HQ has a source for" }`
- `dispositionCell`: "**REFUSED**: HQ's build reads the text as an instance read (`xform.py::XForm.add_missing_instances`) and no spelling of plain text keeps it out. It stops the build for a name it has no source for, and adds the source to the built form for a name it has one for, which stops the form from opening where that is a fixture the device does not hold. For `casedb` and `commcaresession` the built form only gains a declaration nothing reads; Nova refuses those with the rest (`FORM_TEXT_READ_AS_INSTANCE`), so that one rule covers the text and a form declares only what its formulas read."

`forms-and-case-writes/name-lang` and the four held Connect entries stay as they are: each new entry
holds a value class of its own, so every pair on a shared key is disjoint.
`questions/h-title-and-data-name-whatever-their-text` stays too: a reader takes a form's name from
`Form.name`, never from the title. Both entries exist before the reader does, so the reader adds
neither and claims each (part 06, sections 7.4 and 15).

**The lane.** The lane's HQ unit holds the fix in `proof/hq/test_instance_text.py`, the file that
holds section 5's label controls, in the pull request run, as every `proof/hq` test with no served
reader does.

- *The pattern.* New fixture `lib/commcare/__tests__/fixtures/hq-instance-scan-vectors.json`, one
  row per text: the text, the names HQ reads in it (`hqReads`), and whether Nova refuses it
  (`refused`). The lane puts each text into an element's text and into an attribute, renders it as
  `WrappedNode.render` does, and asks HQ's own `get_instance_names`. It requires the answer to equal
  `hqReads`, and `refused` to be true wherever `hqReads` holds a name. The same file is read by
  `lib/commcare/__tests__/hqInstanceScan.test.ts`, which requires `instanceScanRead` to answer
  exactly where `refused` is true. The `hqReads` column was written by reading HQ's pattern, and
  the lane's run is what holds each row. The rows:

  | Text | `hqReads` | `refused` |
  |---|---|---|
  | `instance('casedb')` | `casedb` | true |
  | `instance("item-list:villages")` | `item-list:villages` | true |
  | `instance( 'a-b' )` | `a-b` | true |
  | `instance('a")` (the two quote marks differ) | `a` | true |
  | `instance(` then a no-break space then `'a')` | `a` | true |
  | `instance(` then U+0085 then `'a')` | `a` | true |
  | `Read instance('a') and instance('b')` | `a`, `b` | true |
  | `instance('a b')` | none | true |
  | `instance ('casedb')` (the spelling the copy offers) | none | false |
  | `Instance('casedb')` | none | false |
  | `instance('casedb'` | none | false |
  | `instance(casedb)` | none | false |
  | `instance('')` | none | false |
  | `instance(&apos;casedb&apos;)` (typed as those characters) | none | false |
  | `instance(&#39;casedb&#39;)` (typed as those characters) | none | false |

- *The build.* Through HQ's own `Application.create_all_files`, over six hand-written control forms
  as section 5's label controls are: a learn form whose module's description holds each text below
  in turn, and a form whose title and data `name` hold each.

  | Text | What HQ's build must do |
  |---|---|
  | `instance('nova_absent')` | refuse, with "missing some instance declarations" naming `nova_absent` |
  | `instance('item-list:nova_absent')` | build a form that declares `item-list:nova_absent` with `jr://fixture/item-list:nova_absent`, which the source did not |
  | `instance ('nova_absent')` | build a form that declares nothing the source did not, whose text is the text typed |

The two refused texts are the retained controls of the rule: Nova's gate refuses each
(`FORM_TEXT_READ_AS_INSTANCE`), so no corpus document holds one, and a pin move that changed HQ's
pattern or what its build does shows here. No targeted document is added: an admitted document
holds nothing new for the lane's proofs to read.

**What existing apps see.**

*An app made in CommCare HQ.* HQ's editors accept the text (`commcareConnect.js`: a block's name is a
text widget and its description a text area, each only required), and HQ builds the app where it has
a source for the name. Brought in, such an app gets one finding at the form, the sentence of the
subject `instance-text` with the text it found, and comes in once a space stands before the bracket
(part 06, sections 7.4 and 15).

*An app published from Nova.* Nothing at CommCare HQ changes: the rule changes no emitted byte of an
admitted document.

*An app saved in Nova.* The gate is absolute, so a saved app holding the text would stop at its next
edit. No saved app held it when a read-only scan of every saved app ran during planning. It looked
for `instance(` followed by a quote mark in every saved form row, translation and other
entity row, which is more than this rule refuses. `scripts/scan-instance-text.ts` is that scan in
the repository's form: read-only, over every stored app, loaded by
`lib/db/apps.ts::loadSchemaAdmittedAppForInspection` (the loader for a scan that looks for what a
new rule refuses: it applies the stored schema and skips today's gate), it asks `instanceScanRead`
of every `formSourceTexts` entry and prints the id of each app that holds such a text, and app ids
alone: no name, no form and never the text. It writes nothing.

A scan is a fact about the moment it ran, and the revision that serves until the deploy finishes
is `main` before the step, which still admits the text. So the session runs the scan twice more
against production (`--prod`, through `scripts/lib/prodDb.ts`), and the top-level file's list of
what needs a yes names both runs and what each is for (its item 1). The first is once the rule
exists and just before the merge. Where it prints nothing, the session goes on and removes the
script in the last commit before the merge. Where it prints an app, the session stops before the
merge and says what the scan printed. From that run until the migration Job, the deploy itself
holds the rule: the Job's runtime database probe reruns the whole gate over every saved app and
raises on any finding (`lib/db/runtimeDatabaseProbe.ts::runCanonicalRuntimeDatabaseProbe`), which
blocks the deploy with the previous revision still serving and no app changed. The second run is
when the deploy has ended. Where the deploy is live, it finds an app saved after the probe and
before the new revision held all traffic. Where the probe refused the deploy, it names the app,
since the probe reports counts. Where it prints an app, the session stops and says what the scan
printed, and no repair is planned for either run.

---

## 6. A search with no title

**What CommCare holds.** HQ's Case List page writes `title_label[lang]` on every save, blank where
nothing was typed (`views/modules.py::_gather_and_update_search_properties`); the app string
`case_search.m<i>.inputs` is `title_label.get(lang) or ''`
(`models/case_search.py::CaseSearch.get_search_title_label`), written into the locale file as a
non-breaking space (`commcare_translations.py::dumps`); the suite's `<title>` names that locale
(`remote_requests.py`, at CommCare 2.53 and later,
`feature_support.py::enable_case_search_title_translation`).
Core evaluates it (`QueryScreen.java::getTitleLocaleString`), and the Web Apps client trims it and
draws the heading only where something is left (`formplayer/menus/views/query.js::templateContext`;
the template `corehq/apps/cloudcare/templates/cloudcare/partials/query/list.html`). Android draws no
search title at all (the platform row `search-screen-text`). Lifecycle: `CaseSearch.title_label` is
alive, read under the frozen toggle `SYNC_SEARCH_CASE_CLAIM` that Nova's search capability already
requires.

**The stored shape.** `lib/domain/modules.ts`:

```ts
export const NO_SEARCH_SCREEN_TITLE = { kind: "none" } as const;
export const searchScreenTitleSchema = z.union([
	z.string().min(1),
	z.strictObject({ kind: z.literal("none") }),
]);
export type SearchScreenTitle = z.infer<typeof searchScreenTitleSchema>;
// ordinaryCaseSearchConfigSchema
searchScreenTitle: searchScreenTitleSchema.optional(),
/** The title a worker reads: the authored text, "Search" where none is authored, or null for a
 *  search with no title. The one reader. */
export function searchScreenTitleText(config: CaseSearchConfig | undefined): string | null;
```

Absent keeps meaning `DEFAULT_CASE_SEARCH_TITLE`. No stored document holds the object arm, so nothing
migrates, and the patch schema (`lib/doc/types.ts`, `configSchema.shape.searchScreenTitle.nullable()`)
follows the slot: `null` returns the default.

**Readers**, each moved to `searchScreenTitleText` or a test of the arm:

| Reader | With no title |
|---|---|
| `translationUnits.ts` (role `search-screen-title`) | no unit; a translation of an earlier title is pruned with its slot, as for any removed slot |
| `localizedBlueprintProjection.ts` | today it always writes `search.searchScreenTitle = text(id, effectiveSearch.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE)`, which would hand the object to `text()`. It now calls `text()` only where `searchScreenTitleText(effectiveSearch)` is a string, and otherwise leaves the arm in the clone as it is |
| `lib/preview/workerModule.ts` | keeps the arm as it is; its fallback to the source title runs only where the source holds none |
| `hqJson/caseList.ts::buildSearchConfigDocument` | `title_label` is `""` for every language of the app, the map HQ's page leaves |
| `suite/case-search/searchSession.ts` | writes the `<title>` element as today; the locale's value is the blank literal every language's table writes as a non-breaking space (`localeFile.ts::serializeLocaleFileValue`), the mechanism the blank description already uses |
| `components/preview/screens/CaseListScreen.tsx`, through `lib/preview/platform.ts::searchScreenHeading` | `searchScreenHeading`'s `authored.title` and the `title` it returns become `string \| null`, and the screen passes `null` where `searchScreenTitleText` gives it. Web Apps (`searchScreenText` true) then draws no heading; Android shows the search action's label as its heading, as it does for every search |
| `platformUses.ts` (the `search-screen-text` use) | not a use: the test becomes `typeof searchScreenTitle === "string"`, since there is no text for Android to leave out |
| `modules.ts::caseSearchConfigHasAuthoredSettings`, `caseSearchConfigAfterFinalInputRemoval` | the arm is an authored setting, and leaves with the last input as a title does |
| `components/builder/case-list-config/canvas/SearchCanvas.tsx`, `CaseListConfigWorkspace.tsx` | draw no title |

**The builder.** `inspector/SearchPanelInspectorBody.tsx` gains a `ToggleRow` **Show a title** above
the title field (line in "Copy"). Off writes `NO_SEARCH_SCREEN_TITLE` and hides the field; on writes
`searchScreenTitle: undefined`, which shows "Search" in the field again. `setTitle` is otherwise as
today. The `search-screen-text` note row is shown as today while a title or subtitle text is set.

**Under another worker language.** No title is one setting for every language, so the switch works
the same whichever language the builder shows. Today it would not turn back on:
`lib/doc/caseSearchConfigPatchMutations.ts` writes the switch's `undefined` as
`searchScreenTitle: null`, and `lib/doc/projectBuilderLanguageMutations.ts` (its `updateModule` arm)
reads a `null` for a slot with no translation unit as already handled and drops it, and a search with
no title has no unit. With this part that arm leaves `searchScreenTitle` in the patch, so the source
takes it, in two cases: the value is the `none` arm (which it passes today, since only a string is
redirected to a translation), and the value is `null` while the source holds the `none` arm. A title
typed under another language while the source has none cannot arise: the projector runs only inside
the builder, and the field is hidden while the switch is off.

**Validator.** No rule. **Platforms.** No row and no use: with no title neither platform draws an
authored title. Web Apps draws no heading, and Android shows the search action's label there as it
does for every search (the row `search-screen-text`), so there is no text for either to read
differently.

**The lane document.** `targeted-search-no-title` (declares both platforms): one menu whose search
has no title and one whose search has one. The claim is about what a client draws, so its assertion
is a reader's own test, in the form of `proof/webapps/test_media_slots.py`:
`proof/webapps/test_search_title.py` reads the search screen of each menu and requires no title
element for the first and the title's text for the second. It runs with the Web Apps reader, in the
one slice the session starts itself for the step's tests that take the Web Apps reader (part 14,
section 12.4, holds the command; "Written and not yet run" gives its outcomes), and in every
scheduled lane with the readers after the merge. A dispatch that names documents runs no test of a
reader's own package (`proof/README.md`, "The run started by hand"). What the client does with the
non-breaking space HQ writes for a blank title is read at the sources above and not run before that
test.

---

## 7. A sort rule's blanks first or last

**What CommCare holds.** `SortElement.blanks` (`models/case_list.py`) is written by the Case List
page's sort rows, where the author chooses it and the default follows the direction
(`sort_rows.js`: `params.blanks || (direction === "descending" ? "last" : "first")`;
`views/modules.py::_init_new_sort_element`), and copied to the suite's `<sort blanks>`
(`detail_screen.py::sort_node`). Core reads `first` or `last` and otherwise falls back to the
direction (`DetailFieldParser.java::parseBlanksPreference`), then places a blank by that alone,
whatever the direction (`EntitySorter.java::getCmp`). HQ's health starter app sorts ascending with
blanks last. Lifecycle: alive in HQ's page, its build and Core; both platforms read it alike.

**The stored shape.** `lib/domain/modules.ts`:

```ts
export const SORT_BLANKS = ["first", "last"] as const;
export type SortBlanks = (typeof SORT_BLANKS)[number];
/** Where a rule of this direction puts blank values when it says nothing. */
export function defaultSortBlanks(direction: SortDirection): SortBlanks; // asc: first; desc: last
/** A rule's keys with no rule between them: what a tool input takes before `columnSort` stores it. */
export const columnSortShape = {
	direction: z.enum(SORT_DIRECTIONS),
	priority: persistableJsonNonnegativeIntegerSchema,
	/** Where cases with no value sort. Stored only where it differs from the direction's own. */
	blanks: z.enum(SORT_BLANKS).optional().describe(/* the `blanks` description of "Copy" */),
};
export const columnSortSchema = z
	.strictObject(columnSortShape)
	.superRefine(/* refuses blanks === defaultSortBlanks(direction), message in "Copy" */);
/** Where the rule puts blank values. The one reader. */
export function sortBlanks(sort: ColumnSort): SortBlanks;
/** A rule in its one stored form: `blanks` left out where it is the direction's own. */
export function columnSort(direction: SortDirection, priority: number, blanks?: SortBlanks): ColumnSort;
```

One meaning has one stored form, as adjacent prose text parts have: an ascending rule with blanks
first is the rule with no `blanks`. Every writer builds a rule through `columnSort`, so no writer can
meet the refusal. No stored document holds the key. The refinement sits on the stored schema alone:
a tool's input is built from `columnSortShape` (9.3), because today
`lib/agent/tools/case-list-config/shared.ts::columnSortInput` is `columnSortSchema` itself, and under
the refinement it would refuse `{ direction: "asc", blanks: "first" }` before any tool could store
it as its absence.

**The plan.** `caseListOrder.ts`: a pending rule carries its column's `sortBlanks(sort)`, and
`finalRule` returns it in place of the derivation. The implicit rule of an unsorted list stays
ascending with blanks first, unwritten where HQ's default leaves it unwritten (rule 7). Rule 9's header
comment is rewritten ("Blanks. The rule's own, which follows its direction where the author says
nothing"). `hqJson/caseList.ts` (`blanks: rule.blanks`), `suite/case-list/sortKeys.ts`,
`lib/preview/engine/caseDataBindingHelpers.ts` and `lib/case-store/postgres/store.ts` already read
`rule.blanks` and place blanks by it whatever the direction, so none changes; what changes is that the
two pairings they never met now reach them, which the tests of section "Tests" hold.

**The builder.** `components/builder/case-list-config/SortPriorityStack.tsx`: each rule row gains a
two-option control **Blank values**, **First** and **Last**, beside its direction. Choosing writes
`sort: columnSort(direction, priority, chosen)`. Changing the direction keeps where blanks sort when
the author had chosen it, and follows the new direction when they had not.
The row's summary sentence adds ", blanks first" or ", blanks last" only where the rule holds
`blanks`.

"Had chosen it" cannot be read from the rule alone. An ascending rule with blanks last, turned to
descending, stores no `blanks` (last is descending's own), and turned back would read as never
chosen and sort blanks first. So the stack remembers the choice: it holds, per column uuid, the
position the person last picked with the control, for as long as the case list workspace stays
open, and the new pure function of `components/builder/case-list-config/sortBlanksChoice.ts`

```ts
/** The rule a change of direction writes: `picked` where the person picked a side with the
 *  control, else the rule's stored `blanks`, else the new direction's own. */
export function blanksAfterDirectionChange(
	rule: ColumnSort,
	direction: SortDirection,
	picked: SortBlanks | undefined,
): ColumnSort; // columnSort(direction, rule.priority, picked ?? rule.blanks)
```

gives the rule a direction change writes: `picked` where the person picked one, else the
rule's stored `blanks` where it holds one, else none. Two turns of the direction then give back the
rule the person made. The memory is not stored: after the workspace closes, a rule that holds no
`blanks` follows its direction, which is what the document says, and undo restores any rule exactly.

**Validator.** No rule beyond the schema's. **Platforms.** No row.

**The lane document.** `targeted-sort-blanks` (declares both platforms): one list with an ascending
rule whose blanks come last and a descending rule whose blanks come first, over a hand-written
restore of three cases, one of them blank. `expected.json` holds one `caseList` expectation for each
rule, on `local`, with `sortIndex` the rule's column, fixing the three rows' order. Core reads each
field's own blanks preference by index (`EntitySorter.java::getCmp`,
`detailFields[index].showBlanksLastInSort()`), so `sortIndex` picks the rule's column. Proofs 2 to 4
compare states that all come from one emission, so they cannot show an order Nova gets wrong on
every side; these expectations can.

### 7.1 A date and time saved to a case is written as CommCare HQ stores it

A case list ordered by a date and time puts the cases a phone saved itself hours out of place. The
cause is no rule of the list. It is the text Nova writes for the value, and it is fixed there.

**What happens today.** A form saves a date and time to a case as text Nova builds.
`lib/commcare/xform/datetimeCaseValue.ts::datetimeCaseValueExpression` wraps the value in
`xpath/wire/instant.ts::typedInstantValue`,
`if(V = '', '', format-date(coalesce(V, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`, at two sites: the hidden
sibling `nova_datetime_<question>` that a basic or an advanced action names
(`xform/builder.ts`, through `datetimeCaseValueCalculate`), and every Save to Case row that writes a
date-and-time property (`xform/caseOps.ts`). Core prints `%Z` as the device's own offset
(`core/model/utils/DateUtils.java::getOffsetInStandardFormat`: `Z`, `±HH` or `±HH:MM`), so a phone
in Nairobi saves `2026-01-02T12:30:00.000+03`.

CommCare HQ stores another text for the same moment. Its form processing rewrites every
date-and-time string of a submission to UTC
(`corehq/form_processor/utils/xform.py::adjust_datetimes`, through `adjust_text_to_datetime`),
printed with six fraction digits and `Z`
(`corehq/ex-submodules/dimagi/utils/parsing.py::json_format_datetime`:
`2026-01-02T09:30:00.000000Z`). So the case at HQ, HQ's search index and every other phone hold
that text, and the phone that saved the value keeps its own. It keeps it past its next sync: a
restore sends a case back only where a change came from another sync
(`corehq/sql_accessors/sql_templates/get_modified_case_ids.sql`,
`trans.sync_log_id IS DISTINCT FROM last_sync_id`, which
`corehq/ex-submodules/casexml/apps/phone/data_providers/case/livequery.py` reads). The step 7
outline at `main` says such a case "can misorder" on a device "before it synced"
(`7-rest-of-model.md` at `1f103305`, among the things "step 3 found and left byte-stable"); at
source the phone holds its own text until another phone or CommCare HQ changes that case.

**What it costs a worker.** A list ordered by a date-and-time property compares text
(`lib/domain/caseListOrder.ts`, rule 8; Core's `cases/entity/EntitySorter.java::getCmp` lower-cases
and compares). Two spellings compare by their written clocks, so on the phone that saved a case,
that case sorts away from where it belongs among the others by the device's offset, which is hours.
A plain column shows the two spellings side by side. And a value copied from one property to
another goes through the same wrapper, where Core's parse keeps the written date and moves only the
clock (`DateUtils.java::parseTimeAndStore`), so the copy lands a day off wherever the device's date
for that moment differs from the written one. `lib/commcare/CLAUDE.md` ("Authored case-operation
emission") states that and accepts it today. Over CommCare HQ's UTC text it is every value late or
early in the UTC day, on every phone away from UTC.

**The fix.** A phone writes the text CommCare HQ stores, `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC.
CommCare HQ then stores what the phone wrote, every device holds one spelling of fixed width in one
zone, and the order of the text is the order of the moments, in a row list and a tile list alike.
Nothing changes in `caseListOrderPlan`, the HQ JSON's sort elements, the suite's `<sort>` or the
columns: no sort key, no hidden column and no list rule is added. Text that is already a stored
moment is written as it is, so a copy is exact.

**The value, leaf by leaf.** `datetimeCaseValue.ts` exports, in place of
`datetimeCaseValueExpression` and `datetimeCaseValueCalculate`,

```ts
/** The text a date and time takes on a case: its moment as CommCare HQ stores it. */
export function datetimeCaseValue(operand: InstantOperand, emit: InstantEmission): WireExpr;
```

Both sites hand it the value's classification
(`lib/domain/expression/instantOperand.ts::instantOperand`, which the instant lowering and the
checker already read): a Save to Case row its write's value, the sibling node its question as a
field read. It distributes over `if`, `coalesce` and `switch` as `instant.ts::datetimeCoerceValue`
does, and prints each leaf by what a device holds:

| Leaf (`InstantLeaf.class`) | Printed |
|---|---|
| `typed`; `unknown` holding a date; `day-only` (a `casedb` `date_opened` or `last_modified`, a `Date` at the device's midnight) | `storedInstantValue(V)`, below |
| `text`; `unknown` holding text; `not-instant` (a blank) | `V` itself: stored text is already a stored moment, and Core parses nothing |
| `literal-instant` | folded at emission to CommCare HQ's spelling, `instantOperand.ts::literalStoredInstantText` (new, over `literalInstantMicros`); a literal whose UTC year has no four digits keeps `literalInstantText` |
| `coerced-date-typed`, `coerced-date-text`, `coerced-text`, `epoch-days` | the UTC midnight `datetimeCoerceValue` prints, with the suffix `T00:00:00.000000Z` |

`clock-lost` never reaches it: the checker refuses that assignment (`expected-value`, reason
`clock-lost`). A search result's `date_opened`, which the classification also calls `day-only`, is
the UTC day as text (the checker's `dayText`), so it takes the `coerced-date-text` row. Text of a
spelling CommCare HQ's pattern does not read (`form_processor/utils/xform.py::RE_DATETIME_MATCH`)
is stored as written on both sides, where today it stops the form (`FunctionUtils.java::toDate`
raises on text that is no date).

**The text of a typed moment.** `xpath/wire/instant.ts` gains

```ts
/** Instant text in `typedInstantText`'s own shape, as the text CommCare HQ stores for it. */
export function storedInstantOfText(t: WireExpr): WireExpr;
/** A typed date and time as the text CommCare HQ stores, blank when it is. */
export function storedInstantValue(value: WireExpr): WireExpr;
// if(value = '', '', storedInstantOfText(typedInstantText(value)))
/** The value `storedInstantValue` was built over, or undefined: the blank guard's first operand,
 *  kept only where `storedInstantValue` of it is the tree. */
export function storedInstantSource(tree: WireExpr): WireExpr | undefined;
```

`typedInstantText` gives `T`, the device's clock in one fixed shape,
`YYYY-MM-DDTHH:MM:SS.mmm` and then `%Z`. `storedInstantOfText(T)` moves it to UTC with whole-number
arithmetic, every sub-term built once and shared as `instantMicros`'s are:

```
tail   = substr(T, 23)
offset = if(starts-with(tail, 'Z'), 0,
            if(starts-with(tail, '-'), -1, 1)
            * (number(substr(tail, 1, 3)) * 60
               + if(string-length(tail) > 3, number(substr(tail, 4, 6)), 0)))
U      = number(substr(T, 11, 13)) * 60 + number(substr(T, 14, 16)) - offset
D      = floor(U div 1440)
M      = (U + 1440) mod 1440
day    = format-date(date(date(substr(T, 0, 10)) + D), '%Y-%m-%d')
text   = concat(day, 'T', substr(100 + floor(M div 60), 1), ':', substr(100 + M mod 60, 1), ':',
                substr(T, 17, 23), '000Z')
```

What each piece rests on, read at the commcare-core pin and not run (check G6 runs it):

- `%Z` prints whole minutes, so the seconds and milliseconds of the UTC text are `T`'s own, copied.
  `U`, the minute of the UTC day, lies from -840 to 2159, so `D` is -1, 0 or 1 and `U + 1440` is
  never negative (`xpath/expr/XPathArithExpr.java` takes Java's remainder).
- `substr` counts from 0 and reads its first argument as text
  (`xpath/expr/XPathSubstrFunc.java::substring`), and Core prints a whole number with no decimal
  point (`FunctionUtils.java::toString`), so `substr(100 + h, 1)` is `h` in two digits.
- `date(text) + D` is a count of days (`FunctionUtils.java::toNumeric` of a `Date` is
  `DateUtils.java::daysSinceEpoch`), `date(number)` is the day that many days after 1970-01-01
  (`FunctionUtils.java::toDate`, `DateUtils.java::dateAdd`), and `format-date` prints a `Date` it is
  handed without rounding it (`FunctionUtils.java::expandDateSafe`). It is the day arithmetic
  `instant.ts::epochDayMidnight` prints today.
- An offset under an hour and not zero prints as `Z:MM` whatever its sign
  (`getOffsetInStandardFormat`), so it reads as UTC here. Only historic offsets are such, the limit
  `lib/commcare/xpath/CLAUDE.md` ("The instant lowering") already states for a typed instant.

`T` is printed 23 times, about 3 KB for a question read. One operand of a lowered comparison prints
its text more often (`instantMicros`).

**A leaf that reads the clock.** XPath holds no value: each print of `T` evaluates `V` again.
A question read gives one answer however often it is read. `now()` is a new `Date` each time
(`xpath/expr/XPathNowFunc.java::evalBody`, which Core does not cache), so 23 prints of it can fall
on both sides of a minute's turn, and the pieces would then name a moment that never was. So a
`typed` leaf whose tree holds `now()` is read once, into a node:

- `lib/commcare/xform/generatedNodes.ts::GeneratedNodePurpose` gains `"instant"`. The node is a
  Hidden Value `nova_instant_<operation id>_<n>`, `n` counting that operation's clock leaves from 1
  in write order, in the `nova_operations` group of the operation's scope, with no control and no
  `type`. Its calculate is `typedInstantValue(leaf)`, the spelling Nova writes today, in which one
  `format-date` feeds the text, so it holds one moment.
- The row prints `if(N = '', '', storedInstantOfText(N))`, with `N` the node read through
  `current()`, as one block reads another (`xform/formPath.ts::originalContextWirePath`).
  `storedInstantOfText` takes the node's text as `T` and parses nothing again.

Only a Save to Case row meets this. A basic or an advanced action's value is a bare question read
(`placement.ts`, `advancedPlacement.ts`), and the sibling `nova_datetime_<question>` reads its
question.

**The reader's side.** The reader recognizes a generated node and a row's value by rebuilding them
with these same functions, and it reads two spellings as the same write: this section's, and
`typedInstantValue(V)`, the spelling Nova wrote before this step, which an app Nova published
before this step and that is brought in holds in its forms. The spelling is this section's, so
the rows are stated here, and the form reader and the case reader read by them:

- *The sibling.* A node `nova_datetime_<q>` beside a date and time question `q` is the generated
  node of purpose `datetime` where its calculate is `datetimeCaseValue` of `q` as a field read, or
  the earlier tree `typedInstantValue(q)`. Under either the write reads `q`.
- *The clock node.* A Hidden Value `nova_instant_<operation id>_<n>` in an operation's
  `nova_operations` group, with no `type` and no control, whose calculate is
  `typedInstantValue(leaf)`, is the generated node of purpose `instant`. It becomes no field: the
  Save to Case row that reads it takes `leaf` in its place.
- *A Save to Case value* written to a property the catalog types date and time is `V` where the
  row's tree is `datetimeCaseValue` of `V`'s classification, read leaf by leaf through `if`,
  `coalesce` and the `if` chain a `switch` prints. `storedInstantSource` gives a typed leaf's
  value; a text leaf is itself; a literal in CommCare HQ's spelling is that literal; a UTC
  midnight ending `T00:00:00.000000Z` is the `datetime-coerce` of the value `datetimeCoerceValue`
  was built over; and `if(N = '', '', storedInstantOfText(N))` over a clock node `N` is that
  node's leaf. The earlier tree `typedInstantValue(V)` is `V` too.
- *A list's order.* Nothing is read for it. A sort element over a date and time property is a
  plain property element, as an app made in CommCare HQ holds it, and Nova writes it back as one.

Where the reader meets the earlier spelling it says so in what it hands on, and part 09 says what
the first publish of such an app declares (its sections 11.2 and 11.4,
`date-and-time-saved-as-hq-stores-it`).

**Preview and Nova's case store.** `lib/domain/temporalValues.ts` gains the one spelling and the
one cast:

```ts
/** A moment as CommCare HQ stores it: UTC, `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
export function hqInstantText(instantMs: number): string;
/** The text a date and time takes on a case: the instant `storageDatetimeValue(text, zone)` names,
 *  as `hqInstantText`. Total: text the grammar cannot read comes back trimmed, for the schema to
 *  refuse. */
export function caseDatetimeValue(text: string, zone: string): string;
```

- The three writers of a date-and-time case property call `caseDatetimeValue` where they call
  `storageDatetimeValue` today: `lib/case-store/postgres/submissionEnvelope.ts` (the `datetime` arm
  of its storage cast, whose `Date` branch prints `hqInstantText` in place of `toISOString()`),
  `lib/case-store/postgres/store.ts` (the cast a property's change of type runs) and
  `components/builder/data-review/dataReviewModel.ts` (a value saved in Data review).
- A form answer stays as it is. `lib/preview/engine/formEngine.ts` and `answerCast.ts` keep
  `instantDatetimeValue`: an answer in the instance is what Core's `DateTimeData` holds, the
  viewer's own clock, and a question that opens on a case's value already casts the stored text to
  it (`answerCast.ts`, the `datetime` arm), whichever spelling the case holds.
- A plain column and the case detail show the stored text
  (`lib/preview/engine/caseDataBindingClient.ts::caseRowDisplayValue`), so Preview shows
  `...000000Z`, as a phone does.
- `lib/preview/columnDisplay.ts::hqDatetimeText`, the same spelling kept privately for
  `last_modified`, becomes a call of `hqInstantText`.
- **The order.** `lib/case-store/sql/compileExpression.ts::compileDeviceTextExpression` reads a
  custom date-and-time property as the text a device holds for it: CommCare HQ's text of its
  instant (`compileTerm.ts::compileStoredInstant`, printed at UTC with `HQ_DATETIME_PATTERN`, as
  `compileReadingText` prints `last_modified`), and the stored text where it names no instant. A
  text comparison of that is the order of the moments whichever spelling a row holds and whatever
  the session's zone.
- **Comparisons.** Unchanged. `compileStoredInstant` reads either spelling as its instant
  (`lib/case-store/sql/dataTypeTokens.ts::STORED_INSTANT_TEXT_PATTERN` admits any fraction and
  `Z`), and Preview's evaluator and the device lowering parse the text zone-free.

**Rows Nova already stores.** A row saved before this step holds the viewer's offset
(`2026-01-02T12:30:00.000+03:00`). It is not rewritten, and no scan or migrate script is planned for
it. Every reader that orders or compares reads the instant, as above, so no row orders or matches
wrongly. The one reader of the text itself is display, where an older row shows the text it was
saved with, which is what the phone that saved a value before the update shows.

**The validator.** No rule names either spelling, and none is added.
`lib/domain/expression/datePattern.ts::INSTANT_TEXT_PATTERN` and `isClockKeepingDate` stay: they
are the pattern `typedInstantText` prints and the date-and-time split's join reads.

**What existing apps see.**

- *At an app's next publish.* Each form that saves a date and time to a case carries the new
  calculate, so CommCare HQ keeps a new version of that form. From then a phone that saves such a
  value writes `...000000Z`, the text it already holds for every case that came from CommCare HQ.
  Nothing at CommCare HQ changes: it stored that text all along.
- *What a phone already holds.* A value a phone saved before it took the new version keeps its
  text on that phone until that case is saved again, by a form that writes the property or from
  another phone or CommCare HQ. No update rewrites it, and a case nobody saves again keeps it for
  good. While both spellings are on a phone, a list ordered by the property shows what it shows
  today: the rows that phone saved earlier sit out of place by its offset, and every row saved
  since, and every row from CommCare HQ, is in order. Nothing that orders correctly today orders
  wrongly. CommCare HQ and every other phone were never affected.
- *In Nova.* Preview orders by the moment for every row and shows an older row's text as saved.

That is the whole of it. No notice is written, no script reads or writes production for this
change, and no stored row or document is rewritten.

**The lane document.** `targeted-datetime-saved` (declares both platforms): a registration form
whose date and time question saves to a property through Case Management, a follow-up whose Save
to Case rows write the question's answer, `now()`, a copy of the saved property, and an `if` that
chooses between a typed answer and the stored text, and a list ordered by the property ascending.
Its restore holds three cases whose values are in CommCare HQ's spelling, and `expected.json` holds
one `caseList` expectation on `local` fixing their order. The lane's proofs read the forms on both
paths and through two saves in CommCare HQ's form builder, which must keep the long calculate.
What a phone then stores is G6's: `StoredInstantRuntimeTest` opens this document's forms, from the
local archive and from CommCare HQ's build, submits them in every device zone and reads the stored
case. Its other checks are in "Tests".

---

## 8. Text shown as typed

### 8.1 Who reads a formatted copy

| Text | Android | Web Apps |
|---|---|---|
| Label | formatting where the copy exists, else as typed (`QuestionWidget.java`, `getMarkdownText`) | the same (`caption_markdown`, else `caption`) |
| Inline choice | the same, per choice | formats every choice (the rule `plainChoice`) |
| Help text | formatting where the copy exists, else as typed (`QuestionWidget.java::createHelpLayout`: `getHelpMultimedia(TEXT_FORM_MARKDOWN)`, else `getHelpText()`) | formats the default text always (`form_ui.js::Question.prototype.fromJS`, `help`; `PromptToJson.java::parseQuestion` sends `getHelpText()`) |
| Hint | as typed always (`QuestionWidget.java::addHintText`, `getHintText()`) | formats the default text always (`fromJS`, `hint`) |
| Validation message | as typed always (`FormEntryPrompt.java::getConstraintText`, no form) | as typed always (the manifest's `questions/validation-message-markdown-form`, IGNORED on both) |

Step 5 gave the label and the choice `plainLabel`. The help text has the same reading on Android (read,
not run: G4), so it gains the same setting. A hint and a validation message have none on any runtime.

**`plainHelp`.** `lib/domain/fields/base.ts::inputFieldBaseSchema` gains

```ts
/** The help text shows exactly as written on Android, with no markdown form on the wire.
 *  Absent: markdown. */
plainHelp: z.literal(true).optional(),
```

on every kind that holds `help`. Like `plainLabel` it is one setting for every language of the text,
independent of whether the text is blank, patched by `updateField` (`plainHelp: true | null`), and
classified `config` in `NON_REFERENCE_FIELD_PATHS`.

**The lane document.** `targeted-plain-help` (declares both platforms): a form whose two questions
hold the same help text, `**bold** and a [link](https://example.org)`, one with `plainHelp` and one
without, beside a hint and a validation message typed with the same symbols, and a second form
holding `plainText` with a label, a choice and a help text. Its assertion is the Android read of G4.
Proof 4 holds that a save in the form builder adds no formatted copy to the hint and reopens the
second form with the property set.

### 8.2 Hints and validation messages write no formatted copy

`builder.ts::addItext` is now called with `markdown = false` for a hint and for a validation
message, in every form of every app. The reasons: nothing reads the copy (8.1); HQ's form builder
writes it only where the text looked like formatting, so the form an HQ author leaves usually has none
and comes back exactly; and HQ's form builder keeps a text without one as it is
(`javaRosa/plugin.js::contributeToModelXML` writes the copy only where `item.hasMarkdown`, which
`loadXML` sets only from a copy it read). A protected validation message's own forms
(`__nova_mode;markdown` and the others, `constraintMessage.ts`) are not copies of the text and stay.

So a formatted copy on a hint or a validation message is inert in both directions: the reader drops
one, and Nova writes none. Every existing app's next publish removes the copies Nova wrote. Workers see
nothing change, on either platform.

No app notice is written for it, as for every change of this step.

**In the lane.** A form HQ's form builder wrote can hold such a copy, and Nova's form of the same
document holds none, so the two differ wherever the lane compares an HQ-authored form with Nova's
(proof 1 on the HQ-authored bases, part 14). That difference is spelling, and the rule that erases
it lands with its proof: `proof/rules/hint_validation_markdown_form.py` (rule id
`hint-validation-markdown-form`, as part 14, section 4, names it: a `<value form="markdown">` under
an itext id a `<hint>` or a bind's `jr:constraintMsg` names) and
`proof/rules/test_hint_validation_markdown_form.py`, which reads both spellings of one form in Core
and requires `FormEntryPrompt.getHintText()` and `getConstraintText()` equal in every language. The
test also builds both spellings through `Application.create_all_files` and holds the two built
forms equal but for the copy, the build half `proof/CLAUDE.md` asks of a spelling rule. No other
reader is owed one: 8.1 settles at source that no runtime reads a hint's or a validation message's
formatted copy. The dropped copy is no first-publish change (Departure 8): part 09, section 11.4,
records a help text, a hint and a validation message as exact, with nothing left to declare.

### 8.3 A form whose text formatting is off

Vellum's form property **Disable Text Formatting** (`core.js::showFormPropertiesModal`, slug
`noMarkdown`) is stored as `vellum:ignore="markdown"` on `h:html`
(`writer.js::write_html_tag_boilerplate`, read by `parser.js::parseXForm`). With it the form builder
gives every text the plain widget (`itextBlock.js::itextLabelBlock`) and writes no formatted copy,
dropping any the form held (`plugin.js::contributeToModelXML`). No HQ server code and no runtime reads
the attribute. Lifecycle: alive in Vellum.

`lib/domain/forms.ts`'s form schema gains

```ts
/** Text formatting is off for the whole form: no label, choice or help text writes a markdown
 *  form, so each shows as its platform shows a text without one. */
plainText: z.literal(true).optional(),
```

patched by `updateForm` through `clearablePartialPatch(formSchema)` (`plainText: true | null`), and
classified `config` in `NON_REFERENCE_FORM_PATHS`.

**One reader of "as typed".** New file `lib/domain/plainText.ts`:

```ts
/** Whether a text writes no formatted copy: its form's switch, or its own setting. */
export function labelShowsAsTyped(form: Pick<Form, "plainText">, owner: { plainLabel?: true }): boolean;
export function helpShowsAsTyped(form: Pick<Form, "plainText">, field: { plainHelp?: true }): boolean;
```

The emitter (`builder.ts`: the label's, each choice's and the help's `markdown` argument), Preview and
the builder read these two. A text's own setting is kept while the form's switch is on, and takes
effect again when it goes off, so turning the switch on and off loses nothing.

**Emission.** A form holding `plainText` writes `vellum:ignore="markdown"` among `h:html`'s attributes
and no formatted copy on any text. HQ's form builder then opens it with the property set and adds no
formatting on later edits.

**Platforms.** `platforms.ts`'s `plain-text` note for Web Apps becomes "a tag in the text shows as
formatting, and a choice or a help text still shows its formatting". `platformUses.ts` adds two uses:
`slotUse("plain-text", owner, "plainHelp")` for a field, and for a form holding `plainText` one use
with the form as owner and site `plainText`. `platformFeatureEntries.ts` binds `plain-text` to the new
entry `questions/help-text-with-no-markdown-form` as well.

**Preview.** `PreviewPlatformRules` gains `plainHelp: "markdown" | "literal"` (Web Apps `"markdown"`,
Android `"literal"`), beside `plainChoice`. `components/preview/form/FieldHelp.tsx` draws a help text
as written where `helpShowsAsTyped` holds and the rule is `"literal"`, and in edit mode on both.
`LabelContent`'s and the choice fields' tests of `plainLabel` become `labelShowsAsTyped`.

`platformCells.ts` gains one row,
`"questions/help-text-with-no-markdown-form@web-apps": browser("help-plain-web-apps")`. The entry's
Android reading is `runs`, so the table takes no Android row (G4's outcome A); the Android reading's
evidence is G4's read in the lane. `e2e/lib/previewPlatformScenarios.ts` gains

```ts
"help-plain-web-apps": {
	platform: "web-apps",
	fixture: "questions",
	describe: "a help text written with formatting off still renders its markdown",
},
```

implemented in `e2e/tests/browser/preview-platforms.spec.ts` over the `questions` fixture, which
gains a question holding `plainHelp`. The INERT flip of section 10 also removes what it would leave
standing: the rows `"questions/validation-message-markdown-form@web-apps"` and `"…@android"`
(a row for an entry that is no longer HELD fails `platformCells.test.ts`) and the entry's line in
`platformFeatureEntries.ts::AMBIENT_PLATFORM_ENTRIES` (rule 2 of `platformFeatures.test.ts` admits
only a HELD entry there). The scenarios `validation-plain-web-apps` and `validation-plain-android`
and their spec bodies stay: the scenario registry holds scenarios no cell names (Android's stand-ins
for the phone's hardware are such), and these two remain the browser evidence that Preview shows a
validation message as typed, which `lib/preview/CLAUDE.md` states.

**The builder.**
- *Help.* `components/builder/editor/fields/TextEditor.tsx`, mounted on `help`, passes
  `RefLabelInput`'s `labelRight` the **Format text** toggle the label's inline editor has, driven by
  the new `components/preview/form/useHelpFormatText.ts`, which exports
  `useHelpFormatText(field: Field | undefined): FormatTextControl | undefined` on the model of
  `useLabelFormatText`: the same `FormatTextControl`, whose `plain` is the field holding `plainHelp`
  and whose `write(true | null)` patches `plainHelp` in one `updateField`, and `undefined` for a
  kind whose schema holds no `help`. `formatText.ts::FormatTextOwner` gains `"help"`,
  `formatTextOffLine("help", platforms)` gives the lines of "Copy", and `formatTextGesture` is
  unchanged. A hint and a validation message get no toggle.
- *The form.* `components/builder/detail/formSettings/FormAppearanceSection.tsx` gains a `ToggleRow`
  **Format text in this form**, on by default; off writes `plainText: true` after the confirmation of
  "Copy" where some text of the form holds formatting, on writes `plainText: null`. Its line is the
  form's own row of "Copy", chosen by the platforms the app declares
  (`formatTextOffLine("form", platforms)`; `FormatTextOwner` gains `"form"` beside `"help"`), because
  what the switch does to a choice or a help text is Android's alone (8.1): Web Apps formats both
  whatever the form holds.
- *Under the form's switch.* Each text's **Format text** toggle shows off and disabled, with the reason
  of "Copy"; the stored setting is not touched.

**Validator.** No rule: a text's setting and the form's switch may both be set.

---

## 9. The Solutions Architect and MCP

No tool is added. Every change is an input key, a description or a guide sentence of an existing tool,
and `lib/mcp/__tests__/servedSchemas.test.ts` holds what a client receives.

Of the tools this part's sections change, one the Solutions Architect is offered has no entry in
`scripts/test-schema.ts`: `setFormSections` (`lib/agent/sharedToolRegistry.ts`,
`saName: "setFormSections"`). Its section `label` is a text position, so the new `text` description
(9.2) is the first change to its served schema, and the root `CLAUDE.md` asks the change that makes
it to register the tool. The entry goes after the `updateForm` entry, with its import from
`lib/agent/tools/setFormSections.ts` and its name in the header's list of known names:

```ts
{
	name: "setFormSections",
	description: setFormSectionsTool.description,
	schema: setFormSectionsTool.inputSchema,
	prompt:
		'Use setFormSections with moduleUuid 11111111-1111-4111-8111-111111111111 and formUuid 22222222-2222-4222-8222-222222222222 to put field 33333333-3333-4333-8333-333333333333 on a page titled "About the household" and field 44444444-4444-4444-8444-444444444444 on an untitled page.',
},
```

The tools sections 9.1 to 9.3 name are registered already (`addFields`, `editField`, `createForm`,
`updateForm`, `setCaseSearchDisplay`, `addCaseListColumns`, `updateCaseListColumn`,
`configureCaseList`, `updateTranslations`, `setFieldOptionsSource`). The `text` description reaches
every tool that holds a wording position, and no other: at `main` those are the tools
`lib/agent/toolSchemaGenerator.ts` builds (`addFields`, `editField`, `setFieldOptionsSource`),
`lib/agent/planningSchemas.ts` builds (`generateSchema`, `updateCaseProperty`) and
`lib/agent/tools/setFormSections.ts`, with `updateTranslations` through `valueSchemas.localized`.
`lib/agent/tools/createForm.ts` and `createModule.ts` import no field schema, no option schema and
no text schema, so the wording description moves neither tool's hash: `createForm`'s moves for
`plain_text` alone, and `createModule`'s not at all. The top-level file's two free comparisons (the
hash run of `scripts/inspect-tool-schema-hashes.ts` and each tool's description, at the baseline
and at the step's head) are what find the moved tools, and the top-level file holds the one billed
check over them. This part's reading expects every moved tool but `setFormSections` to be
registered already.

Four registered entries of `scripts/test-schema.ts` take a longer or a new prompt, so that the one
request each sends asks for a call that uses an input this part adds. A provider accepts or refuses
a schema whatever the prompt asks for, so every other entry keeps its prompt.

| Entry | Prompt from step 6 |
|---|---|
| `addFields` | today's prompt, then: `Also add a text field phone with keypad numbers, and a text field notes whose help text "Use *short* words" shows exactly as typed (plain_help true) and whose label is "Visit on {{= format-date(date(#form/visit_date), '%e %b %Y')}}".` |
| `editField` | today's prompt, then: `Also set keypad to numbers and plain_help to true.` |
| `setCaseSearchDisplay` | `Use setCaseSearchDisplay with moduleUuid 11111111-1111-4111-8111-111111111111 to show no search title ({ "kind": "none" }) and clear every other display slot (null).` It replaces today's, which sets the title to 'Find a patient'. |
| `createForm` | today's prompt, then: `Turn text formatting off for the whole form (plain_text true).` |

### 9.1 The keypad

`lib/agent/toolSchemaGenerator.ts`: `keypad: z.enum(TEXT_KEYPADS).nullable().optional()` on the
`addFields` item and the `editField` patch, described by `FIELD_DOCS.keypad` ("Copy"). `keypad` joins
`ADD_GATED_KEYS`, so a kind that does not declare it is told so by the existing undeclared-slot issue.
`lib/agent/tools/editField.ts` passes `keypad` through (`null` clears). On the add path the candidate
field is built key by key in `lib/agent/contentProcessing.ts::flatFieldToField` and then cut to the
kind's keys, so a key it does not copy is accepted and stored nowhere; it gains
`...(q.keypad != null && { keypad: q.keypad })`, with `keypad` on `PreparedFlatField` from the
generated item type. Every caller that assembles a question goes through it
(`lib/agent/tools/shared/fieldAssembly.ts`). `getField` and the form reads print it where set.
`textFieldMetadata.saDocs` becomes "Free-text field for single-line string input. Supports XPath
validation. With keypad numbers it is a phone number or numeric ID question." The fields reference
of `lib/agent/authoring/reference.ts` gains `${platformSentence("number-keypad")}`.

### 9.2 Calculated values

- **The syntax.** `{{= formula}}` is a calculated value; the formula is form logic, as `calculate`
  takes it. The description a model reads for every wording position is the `text` family's,
  `lib/agent/authoring/schema.ts::valueSchemas.text`, which `authoringJsonSchema` substitutes for
  each `proseTemplateSchema` position; it becomes the sentence of "Copy", and
  `valueSchemas.localized` (a translation's value) the one beside it. `text.ts::textSchema` is a
  second copy of that description with no importer, so it is removed.
- **Where an insertion ends.** `text.ts::parseInterpolatedText` closes an insertion at the next
  `}}` (`source.indexOf("}}", cursor + 2)`), which would cut `{{= concat('a', '}}')}}` inside its
  string. An insertion whose inner text starts with `=` now closes at the first `}}` outside a
  quoted string: the scan steps over each `'…'` and `"…"` run whole. That is the form grammar's own
  rule for a string literal (`lib/commcare/xpath/grammar.lezer.grammar::StringLiteral`: a quote, any
  characters but that quote, the quote, with no escape), and `}` is no token of the grammar outside
  one, so the scan and the parser cannot disagree about where a formula ends. It reads no XPath
  structure: the formula between the delimiters still goes whole to `parseFormExpression`. The
  printer needs no escape, and every other insertion closes as today. A `{{=` that never closes, an
  unclosed quote among the causes, is refused with the sentence of "Copy".
- **Reading.** `normalizeText`'s `parse` callback returns a `ProseAtomPart`. `input.ts::textAt` calls
  the new function of `lib/doc/expressionText.ts`:

  ```ts
  /** One insertion of a text: `=` and a formula is a calculated value, parsed in the text's prose
   *  slot; any other name is a reference. Throws `AuthoringInputError` with the sentences of
   *  "Copy": for `=` with no slot, for `=` with nothing after it, and for a formula that does not
   *  parse. */
  export function parseProseAtom(
  	scope: ProseReferenceScope,
  	name: string,
  	slot: ProseSlotRef | undefined,
  	lookup: LookupDefinitionIndex | "unavailable",
  ): ProseAtomPart;
  ```

  A name that starts with `=` is parsed by `parseFormExpression` in the prose slot (a
  `FormParseScope` of the scope's `doc` and prepared `form`, the slot, `lookup` and no `current`)
  and built with `canonicalProseAtom`; any other name goes to `parseProseReference` as today. The
  slot comes from the new function of `lib/agent/authoring/proseSlots.ts`,
  `proseSlotAt(toolName: string, input: unknown, path: AuthoringPath, doc: BlueprintDoc):
  ProseSlotRef | undefined`, which takes the call's input after its identity pass and answers
  `undefined` for a text no form evaluates. It holds an arm only for a tool that holds a wording
  position, which is five tools. It maps a text's path to its `ProseSlotRef` for `addFields` and
  `editField` (a field's `label`, `hint`, `help`, `validate.msg` and
  `optionsSource.options[].label`), for `setFormSections` (a section's `label`, the `label` slot of
  that section), for `setFieldOptionsSource` (`source.options[].label`, the `option_label` slot of
  that option's uuid, which the call's identity pass has allocated before any text binds), and, for
  `updateTranslations`, from the translation unit's field and role (`translationUnitsById(doc)`,
  which `input.ts` already builds for that tool). A text holding `{{=` sets `needsTables`, so a
  lookup read binds. A text with no slot that holds `{{=` is refused with the sentence of "Copy".
- **Writing.** `printAuthoringText(value: ProseTemplate, doc: ReferenceNamesDoc, printValue?: (part:
  ProseValuePart) => string): string` prints a value as `{{= ` + what `printValue` gives + `}}`, and
  hands `printValue` to `printProseTemplate`, so a caller that passes none and meets a value throws
  `ProseProjectionError` (4.1). `output.ts`'s `text` encoder takes the path and resolves the slot
  with `proseSlotAt`, and its `printValue` is `projectFormExpression(doc, slot, part.expression,
  lookup).text`; `searchBlueprint`'s and the translation tools' printers do the same with the field
  they already hold. A catalog text's printer passes none: it holds no value.
- **The guide.** `reference.ts`'s forms paragraph gains the sentence of "Copy".

### 9.3 The title, blanks and text as typed

- `lib/agent/tools/case-search-config/shared.ts::setCaseSearchDisplayBodySchema.searchScreenTitle`
  becomes `z.union([z.string(), z.strictObject({ kind: z.literal("none") })]).nullable()`, described
  as "Copy" gives.
- `lib/agent/tools/case-list-config/shared.ts::columnSortInput` is the domain `columnSortSchema`
  today (`columnSortSchema.optional().describe(description)`). It becomes
  `z.strictObject(columnSortShape).optional().describe(description)`: the same three keys with no
  refinement, `blanks` carrying the description of "Copy" from the shape. Every column tool
  (`addCaseListColumns`, `updateCaseListColumn`, `configureCaseList`) builds the stored rule with
  `columnSort(direction, priority, blanks)` before admission, so an explicit value equal to the
  direction's own is stored as its absence, with no refusal. Reads print `blanks` where stored.
- `toolSchemaGenerator.ts`: `plain_help: z.boolean().nullable().optional()` on the `addFields` item
  and the `editField` patch, gated like `plain_label` by `gateDisplayFlags` (a kind with no `help` is
  told to leave it out); `FIELD_DOCS.plain_label`'s last sentence and `FIELD_DOCS.plain_help` as in
  "Copy". `editField.ts` and `output.ts` map `plain_help` to `plainHelp` as they map `plain_label`,
  and `contentProcessing.ts::flatFieldToField` gains `...(q.plain_help === true && { plainHelp: true })`
  beside its `plain_label` line, without which `addFields` would accept the key and store nothing
  (9.1).
- `lib/agent/tools/updateForm.ts` and `lib/agent/tools/createForm.ts` gain the input
  `plain_text: z.boolean().nullable().optional()` ("Copy"), written as `plainText: true` or `null`.
- The guide's forms paragraph is rewritten as "Copy" gives.

### 9.4 MCP

MCP serves the same tools, so each key above reaches a client unchanged. `content/docs/mcp/tools.mdx`
takes the sentences of "Contracts and docs".

### 9.5 Versions

`lib/models.ts::MODEL_CONTEXT_VERSION` moves once for the whole step (the top-level file,
"Versions"). These are this part's changes that reach a served tool input, a tool description or the
guide, and so are part of the reason it moves:

| Change | Reaches |
|---|---|
| `keypad` (9.1) | the `addFields` item and the `editField` patch; `textFieldMetadata.saDocs`; the guide's fields reference, through `platformSentence("number-keypad")` |
| `{{= formula}}` (9.2) | the `text` description of every wording position and the `localized` description of `updateTranslations`; the guide's forms paragraph |
| the `none` arm of `searchScreenTitle` (9.3) | `setCaseSearchDisplay` |
| `blanks` (9.3) | `addCaseListColumns`, `updateCaseListColumn`, `configureCaseList` |
| `plain_help` (9.3) | the `addFields` item and the `editField` patch; the description of `plain_label` |
| `plain_text` (9.3) | `createForm`, `updateForm`; the guide's forms paragraph, its first two sentences |

Section 5 changes emission alone, 7.1 changes emission, Preview and the case store, and 5.1 adds a
refusal's message, which is no part of a schema, so none of the three reaches a served input or the
guide.

One change of this part is a reason for the step's one move of
`lib/db/appTests.ts::RUNTIME_VERSION` (the top-level file, "Versions"): 7.1 changes the text
Preview stores for a date and time saved to a case, in every document, so an App Test journey in
flight would hold values of both spellings. Nothing else here is: a journey pins its document, a
pinned document holds none of the new keys, and no other change alters how Preview reads a document
without them.

---

## 10. The surface manifest

Each edit lands with its inventory row in `docs/research/2026-09-26-hq-round-trip/inventory/`, with
the code that makes it true. An entry that becomes HELD or INERT loses `subject` and `owner` (part
01, sections 2.2 and 2.3).
`lib/commcare/surface/schema.ts::inventoryEntrySchema`'s HELD arm requires `slotChanges`, which a
HELD-NEW entry does not carry, so every entry below that becomes HELD, and the new HELD entry,
carries `"slotChanges": []`. Part 04 (Decision 13 and section 11.4) removes the `widen` direction,
not the field, so that holds with its changes too.

| Entry | Edit |
|---|---|
| `questions/phone-number-xsd-string-appearance-numeric` | HELD-NEW → HELD. `dispositionCell`: "**HELD**: a Text question with `keypad: \"numbers\"`". Platforms and emission cells unchanged. Bound to `number-keypad`. |
| `questions/output-value-any-other-expression` | HELD-NEW → HELD. `dispositionCell`: "**HELD**: a prose `value` part, where the expression passes the slot's check". Value class kept. |
| `case-search/title-label-or-blank-hq-s-default` | HELD-NEW → HELD. `item`: "`title_label` `{}` or blank in every language (HQ's default)". `dispositionCell`: "**HELD**: `searchScreenTitle: { kind: \"none\" }`". Platforms: `RUNS (no heading) / RUNS (Android draws no search title)`, both `runs`. Emission cell: "`title_label` blank for every language". |
| `case-search/title-label-lang-non-empty` | `dispositionCell`: "**HELD**: `searchScreenTitle`, a text; absent is \"Search\"". No disposition change. |
| `menus-and-case-lists/blanks-first-last` | HELD-NEW → HELD. `dispositionCell`: "**HELD**: `Column.sort.blanks`, stored where it differs from the direction's own". |
| `menus-and-case-lists/blanks` | The inventory row's emission cell loses "(Nova writes `''` today: unproducible)"; the entry is unchanged. |
| `questions/help-text-markdown-form` | `dispositionCell`: "…, markdown on (markdown off is `plainHelp`)", replacing "(Nova always writes the markdown form, so Android always renders help as markdown)". Part 04 splits the same entry (its section 2.2, row 43, and section 11.1 move its `widen` to the HELD-NEW entry `questions/help-text-on-a-capture-question-or-a-label`): the HELD half keeps this wording. |
| `questions/help-text-with-no-markdown-form` (new) | HELD. Section "Itext, markdown and label text"; `item` "help text with no `markdown` form"; `surfaceKeys` `xform:model/itext/translation/text`, `itext-form:android/markdown`; `valueClass` `help-without-markdown-form`; `dispositionCell` "**HELD**: `plainHelp`"; platforms `DIFFERENT (the help still shows as formatted text) / RUNS (as written)`; emission "help itext without a markdown form". Bound to `plain-text`. |
| `questions/validation-message-markdown-form` | HELD → INERT. `item`: "validation message `markdown` form, equal to the default text or differing from it". `dispositionCell`: "**INERT**: no runtime reads it (`FormEntryPrompt.getConstraintText` asks for no form), and Nova writes none". Platforms `not-applicable`; emission `omit`. Its two cell rows and its ambient line leave with the flip (8.3). |
| `questions/hint-markdown-form` (new) | INERT. Same section; `item` "hint `markdown` form, equal to the default text or differing from it"; `surfaceKeys` the three `itext-form:*/markdown` keys; `valueClass` `hint`; `dispositionCell` "**INERT**: no runtime reads it (`FormEntryPrompt.getHintText` asks for no form; Web Apps formats the default text), and Nova writes none"; emission `omit`. |
| `questions/markdown-form-equal-to-the-default-text` | `item`: "`markdown` form equal to the default text, on a label, a choice or a help text". No disposition change. |
| `questions/markdown-form-differing-from-the-default-text` | `item`: "`markdown` form differing from the default text, on a label, a choice or a help text". Stays REFUSED, `not-hq-editable`. |
| `questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk` | `item`: "a text with a `markdown` form in some languages only (as HQ's bulk translation upload adds, `upload_form.py::_add_or_remove_translations`)". Stays REFUSED for every text, a hint and a validation message among them. |
| `questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable` | HELD-NEW → HELD. `dispositionCell`: "**HELD**: `Form.plainText`: the form writes no markdown form on any text". |

The three edits before the last row draw one line through the entries that share the
`itext-form:*/markdown` keys. Before them the equal and differing entries claimed a copy on any
text, the keys the two INERT entries claim for a hint and a validation message, and this part would
have called a hint's differing copy both refused and inert. After them: a copy on a label, a
choice or a help text is HELD where it equals the text and REFUSED where it differs (the form
builder loads the copy as the text,
`javaRosa/plugin.js::loadXML`, so a save there replaces what the worker reads); a copy on a hint or
a validation message is INERT either way, because no runtime reads it and Nova's form holds none for
a save to load; and a copy held in some languages only stays REFUSED on every text, because its
first reason is Core's own (a language that holds a form the default lacks fails to load), which is
a fact of the itext table and not of which text the id belongs to.

Two more entries exist only because a reader's claim makes them true, so the part whose reader
claims each one adds it, and none of this part's code adds either (part 01, section 3, and the
joining lists of its Appendix A.1 and A.2):

| Entry | Added and claimed by | What it is |
|---|---|---|
| `questions/a-markdown-form-in-a-form-whose-text-formatting-is-off` (new) | the form reader (part 06, section 12.2) | REFUSED, `not-hq-editable`, subject `question-text`, `surfaceKeys` the three `itext-form:*/markdown` keys, `valueClass` `in-a-form-with-formatting-off`: a form holding `vellum:ignore="markdown"` and a formatted copy on a label, a choice or a help text, which the form builder's next save drops |
| `case-search/title-label-blank-in-some-languages` (new) | the case list and search reader (part 07, sections 12.4 and 14, which hold its fields) | HELD-NEW, subject `search-setup`, owner `case-search`: HQ shows a blank title in such a language, where Nova's translation fill would show the default language's. Part 07 also narrows `case-search/title-label-lang-non-empty`'s `item` to "`title_label{lang}` non-empty in every app language", so the classes on the key are disjoint. This part re-words the two title entries above and leaves the mixed case unclaimed |

The form reader also claims two entries this part re-words (part 06, section 12.2):
`questions/markdown-form-differing-from-the-default-text`, a label's, a choice's or a help text's
copy that differs from its text (a hint's or validation message's differing copy is the INERT
entries'), and `questions/a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk`, any
text, a hint and a validation message among them.

Two entries exist only under a check's outcome, each added with its rule:
`questions/output-value-holding-text-the-form-builder-rewrites` (G1 outcome B) and
`questions/output-value-in-a-validation-message-core-cannot-compose` (G3 outcome C, its second
case). Each is REFUSED with subject `question-text`, in the section "Itext, markdown and label
text", with `surfaceKeys` those of `questions/output-value-any-other-expression`, whose `item` is
narrowed by the same class so the two are disjoint. The class is the rule's exported predicate
(`lib/commcare/validator/rules/field.ts::proseValueNotKeptByFormBuilder`,
`proseValueBreaksValidationMessage`), and the expressions reader claims each entry by that predicate
in its prose slot row, ahead of `questions/output-value-any-other-expression` (part 08, sections 9.1
and 9.2). The form reader claims neither: it registers the output's text and knows nothing of the
value it binds to.

Section 5.1 adds two REFUSED entries with its rule,
`questions/connect-block-text-read-as-an-instance` and
`forms-and-case-writes/form-name-read-as-an-instance`, both under the new subject `instance-text`
(5.1, "The manifest"). The form reader claims each (part 06, sections 15 and 7.4).

7.1 changes no disposition. Three entries quote the earlier spelling and are re-worded with it:

| Entry | Edit |
|---|---|
| `forms-and-case-writes/update-from-a-date-and-time-question-through-a-hidden-sibling` | `item`: "update from a date-and-time question through a hidden sibling `nova_datetime_<question>` whose calculate is the question's moment as CommCare HQ stores it (`datetimeCaseValue.ts::datetimeCaseValue`), or the device-offset spelling Nova wrote before (`instant.ts::typedInstantValue`)". Both spellings stay one HELD value class: each is the same write. |
| `forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time` | no edit: its item names the sibling, not its spelling. |
| `questions/type-on-a-savetocase-property-leaf-a-create-update-or-index` | its emission cell, "(in-envelope: untyped `if(p = '', '', format-date(coalesce(p, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`)", reads "(in-envelope: untyped, the moment as CommCare HQ stores it, `datetimeCaseValue`)". |

`nova_instant_<operation id>_<n>` is a Hidden Value with a calculate, a shape the manifest holds
already, so it takes no entry. How a reader recognizes it is 7.1's ("The reader's side").

---

## 11. The model-addition checklist

One line per place of step 5's checklist (its section 6), per concept. "None" carries its reason.

| Place | Phone Number | Calculated value, and label text (5) | No title, blanks, as typed | Text read as an instance (5.1) |
|---|---|---|---|---|
| 1 Schema | `text.keypad`; `fieldDisplay.ts` | `proseValuePartSchema`, `catalogProseTemplateSchema`, `proseExpression.ts` | `searchScreenTitleSchema`; `columnSortSchema.blanks`; `plainHelp`; `Form.plainText`; `plainText.ts` | none: the stored strings stay `z.string()` |
| 2 Validator tables | none: no code | none: checker findings under `field-prose`; one code with its three table rows under G1 outcome B, and one under G3 outcome C's second case | none: schema refusals only | `FORM_TEXT_READ_AS_INSTANCE` with its three table rows |
| 3 Platform table and manifest | `number-keypad`; one entry | none: both platforms alike; one entry | `plain-text` note and uses; eleven entry edits, one ambient line removed | no platform row; two REFUSED entries, one new subject |
| 4 Wire | `appearance.ts`; `builder.ts` | `formExpressions.ts`, `builder.ts`, `hqInstanceScan.ts`, `constraintMessage.ts` | `caseList.ts`, `searchSession.ts`, `caseListOrder.ts`, `builder.ts::addItext` and `h:html` | `hqInstanceScan.ts::instanceScanRead`; new `xform/sourceTexts.ts`; no emitted byte changes |
| 5 Preview | rule `numberKeypad`, `numberKeypad.ts`, one cell and its scenario | `formExpressionRuntime.ts`, `labelRefs.ts`, `triggerDag.ts` | `searchScreenHeading`; rule `plainHelp`, one cell and its scenario, two cell rows removed; the order plan's readers unchanged | none: no runtime shows the text, and a refused name never reaches Preview |
| 6 Postgres | none: text | none: prose is not stored in case data | none: the store already orders by the plan's `blanks` | none |
| 7 Index | none: no identity | through `expressionSlotValues` | none | none: no reference |
| 8 Builder | picker entry, `KeypadEditor` | chip, popover, picker row | title switch, blanks control, help toggle, form switch | none: the editors show the gate's sentence |
| 9 SA and MCP | `keypad` | `{{= }}` | title arm, `blanks`, `plain_help`, `plain_text` | none: the refusal's message |
| 10 Public docs | section "Contracts and docs" | the same | the same | two paragraphs, in the same section |
| 11 Proof | `targeted-number-keypad`, G5 | `targeted-prose-value`, G1 and G3, the label controls of `proof/hq/test_instance_text.py` | three targeted documents, G4, one spelling rule | `proof/hq/test_instance_text.py`: the vectors and the build controls |
| 12 Existing documents | none: optional key | none: new arm | none: optional keys, a wider grammar; every app's next publish drops hint and validation copies (8.2) | none: a scan found no saved app holding the text; it is run once more before the merge and once more when the deploy has ended, and the deploy's probe covers the time between (5.1) |
| 13 `MODEL_CONTEXT_VERSION` | reaches served inputs (9.5) | reaches served descriptions and the guide (9.5) | reaches served inputs and the guide (9.5) | reaches none |
| 14 Billed check | no new entry; two prompts gain `keypad` | registers `setFormSections`; one prompt gains a formula | no new entry; four prompts gain an input (section 9) | nothing to send: no schema or description changes |
| 15 Docs | section "Contracts and docs" | the same | the same | the same |
| 16 `../nova-plugin` | none: its skills name no question setting | swept for "`{{name}}` inserts an answer" sentences, which gain `{{= }}` in the plugin's one change | swept for "always Markdown" | swept; nothing says what these texts may hold |

7.1 adds no model, so it takes the places it touches alone:

| Place | A date and time saved to a case (7.1) |
|---|---|
| 1 Schema | none: no document key. `temporalValues.ts` gains `hqInstantText` and `caseDatetimeValue` |
| 2 Validator tables | none: no rule names either spelling |
| 3 Platform table and manifest | no platform row (both platforms run Core's arithmetic); two entry cells re-worded (section 10) |
| 4 Wire | `datetimeCaseValue.ts`, `instant.ts` (`storedInstantOfText`, `storedInstantValue`, `storedInstantSource`), `caseOps.ts`, `builder.ts`, `generatedNodes.ts` (the purpose `instant`) |
| 5 Preview | the three writers of a case's date and time; `columnDisplay.ts` |
| 6 Postgres | `compileDeviceTextExpression` reads a date-and-time property as CommCare HQ's text; no row is rewritten |
| 7 Index | none |
| 8 Builder | none: Data review saves the new text through `dataReviewModel.ts` |
| 9 SA and MCP | none: no input, description or guide sentence names the spelling |
| 10 Public docs | one sentence ("Contracts and docs") |
| 11 Proof | `targeted-datetime-saved`, G6, `proof/hq/test_stored_datetime.py` |
| 12 Existing documents | none rewritten; every app with such a write emits the new calculate at its next publish |
| 13 `MODEL_CONTEXT_VERSION` | reaches none; it is a reason for `RUNTIME_VERSION`'s move (9.5) |
| 14 Billed check | nothing to send |
| 15 Docs | section "Contracts and docs" |
| 16 `../nova-plugin` | swept for a sentence on how a date and time is stored on a case, which the plugin's one change corrects where the sweep finds one |

---

## Copy

Every string this part adds or changes. Voice: `design/readme.md`, "Content fundamentals".

**The Phone Number question**

| Where | String |
|---|---|
| Question picker, Input | `Phone number` |
| New question's label | `New Phone Number` |
| `KeypadEditor` label | `Number keypad` |
| `KeypadEditor` line | `Workers type on a number keypad. The answer is kept as text, so a leading zero or a + stays.` |
| `PLATFORM_FEATURES["number-keypad"]` | label `Number keypad`; the two notes of 3.4. The Android note there is G5's outcome A; under outcome B or C it is the note that outcome writes in "Written and not yet run", and the Web Apps note stands under every outcome |
| `runtimeMessages.ts`, `numberKeypadAnswer` (English) | `This answer takes digits, with an optional + or - in front and an optional decimal part.` |
| the same (Spanish) | `Esta respuesta admite dígitos, con un + o un - opcional al principio y una parte decimal opcional.` |
| Scenario `number-keypad-web-apps`, `describe` | as 3.6 writes it |
| `FIELD_DOCS.keypad` | `Text questions only. "numbers" gives the worker a number keypad and keeps the answer as text, for a phone number or an ID that may start with 0 or +. Use int or decimal for a quantity. null returns the full keyboard.` |
| `textFieldMetadata.saDocs` (replacing "Free-text field for single-line string input. Supports XPath validation.") | `Free-text field for single-line string input. Supports XPath validation. With keypad numbers it is a phone number or numeric ID question.` |
| Fields reference of `lib/agent/authoring/reference.ts` | `${platformSentence("number-keypad")}`, generated from the row of 3.4 |

**A calculated value**

| Where | String |
|---|---|
| Picker row | `Calculated value` |
| Picker row's line | `Shows the result of a formula, such as a formatted date.` |
| Picker trigger, a value selected | `Edit calculated value` |
| Popover title | `Calculated value` |
| Popover buttons | `Insert`, `Save`, `Remove` |
| Popover, empty formula (the editor's placeholder) | `A formula's result shows here` |
| Unresolved value chip | `Calculated value needs repair` |
| `projectProseTemplate` with no printer | `[calculated value]` |
| `proseTemplateSchema`, a value that is a bare reference | `This calculated value only reads one answer or saved value, and Nova keeps that as a reference. It can be stored as the reference part instead.` |
| `catalogProseTemplateSchema`, a value part | `A case property's label, hint and choice labels can't hold a calculated value, because no form evaluates them. You can put it in a question's label instead.` |
| `authoring/schema.ts::valueSchemas.text` description | `Markdown. {{field_id}} inserts an answer; {{#case/property}} inserts a saved value; {{= formula}} inserts a calculated value, such as {{= format-date(date(#form/dob), '%e %b %Y')}}. \{{ keeps literal braces.` |
| `authoring/schema.ts::valueSchemas.localized` description | `Translated text. Keep every inserted reference and {{= formula}} from the source.` |
| `AuthoringInputError`, `{{=}}` with nothing after it | `{{= }} needs a formula after the equals sign, such as {{= format-date(date(#form/visit_date), '%e %b %Y')}}.` |
| `AuthoringInputError`, a `{{=` that never closes | `The calculated value that starts {{= <its first 40 characters> has no closing }}. A quote mark inside it may be unclosed.` |
| `AuthoringInputError`, a formula that can't be read | `The calculated value {{= <formula>}} can't be read.` followed by a space and each `FormParseIssue.message` of the parse (`lib/commcare/xpath/expressionAst.ts::parseFormExpression`), joined by one space, as the expression positions report them today |
| `AuthoringInputError`, no slot | `A calculated value shows only in a question's label, hint, help text, validation message or choice label, where the form works it out. This text is none of those, so it can't hold {{= <formula>}}. You can write the text without it.` |
| `projectBuilderLanguageMutations.ts`, a translation that changes a protected part (replacing "This translation must preserve every referenced answer, case value, and worker value. Edit it in Languages to repair the protected references.") | `This translation keeps every answer, case value, worker value and calculated value its source shows. You can repair them in Languages.` |
| Guide, forms paragraph, after "Worker values use {{#user/property}}." | `{{= formula}} shows a calculated value, checked like calculate: {{= format-date(date(#form/dob), '%e %b %Y')}} shows a date the way you format it.` |
| `PROSE_VALUE_NOT_KEPT_BY_FORM_BUILDER` (G1 outcome B only) | `The calculated value in “<question>”'s <slot> holds <character>, which CommCare HQ's form builder changes when someone saves the form there. You can calculate it in a hidden value and show that value here instead.` `<slot>` is `label`, `hint`, `help text`, `validation message` or `choice label`. `<character>` is the first of the refused characters the printed text holds: `a < sign`, `a > sign`, `a double quote mark` or `an & sign` |
| `PROSE_VALUE_BREAKS_VALIDATION_MESSAGE` (G3 outcome C, its second case, only) | `The calculated value in “<question>”'s validation message uses <call>(), which CommCare can't work out while it writes a validation message. You can calculate it in a hidden value and show that value here instead.` |

**The title, blanks and text as typed**

| Where | String |
|---|---|
| Search inspector switch | `Show a title` |
| Its line | `A heading above the search fields in Web Apps` |
| `searchScreenTitle` tool description | `Plain-text title shown above the search inputs. null returns the default title, Search. { "kind": "none" } shows no title.` |
| Sort rule control | `Blank values`, options `First` and `Last` |
| Sort rule summary suffix | `, blanks first` / `, blanks last` |
| `columnSortSchema` refusal | `An ascending rule already puts blank values first, and a descending rule last, so blanks is kept only when it says the other one.` |
| `columnSortShape.blanks` description (served through `columnSortInput`) | `Where cases with no value sort: "first" or "last". Leave it out to follow the direction: first when ascending, last when descending.` |
| `formatTextOffLine("help", …)`, both platforms | `On Android, workers see this help as you typed it. Web Apps formats every help text.` |
| the same, Android only | `Workers see this help as you typed it, without formatting.` |
| the same, Web Apps only | `Web Apps formats every help text, so workers see its formatting either way.` |
| Form switch | `Format text in this form` |
| Its line, `formatTextOffLine("form", …)`, both platforms | `Off shows every label exactly as typed, and every choice and help text too on Android. Web Apps still formats those two. It also keeps CommCare HQ's form builder from adding formatting.` |
| the same, Android only | `Off shows every label, choice and help text exactly as typed, and keeps CommCare HQ's form builder from adding formatting.` |
| the same, Web Apps only | `Off shows every label exactly as typed. Web Apps still formats choices and help text. It also keeps CommCare HQ's form builder from adding formatting.` |
| Scenario `help-plain-web-apps`, `describe` | as 8.3 writes it |
| Confirmation before turning it off | `Some text in this form uses formatting. With Format text off, workers see its symbols as you typed them.` with `Turn it off` and `Keep formatting` |
| A text's toggle under the form's switch | `Text formatting is off for this whole form` |
| `plain-text`, Web Apps note | `a tag in the text shows as formatting, and a choice or a help text still shows its formatting` |
| `FIELD_DOCS.plain_label`, last sentence | `A help text takes plain_help the same way; a hint and a validation message have no such setting.` |
| `FIELD_DOCS.plain_help` | `true shows the help text exactly as typed on Android. Web Apps formats every help text either way. false or null returns it to Markdown.` |
| `plain_text` description | `true turns text formatting off for the whole form, whatever a text's own plain_label or plain_help says: every label shows as typed, and every choice and help text shows as typed on Android (Web Apps formats those two either way). false or null turns it back on.` |
| Guide, forms paragraph, first two sentences | `Form wording is Markdown. A label or a choice with plain_label, a help text with plain_help, and every text of a form with plain_text are written without formatting: a label then shows exactly as typed, and a choice or a help text does on Android.` |

**Text read as an instance (5.1)**

`<site>` is, by `details.site`: `learn module's name`, `learn module's description`,
`deliver unit's name`, `task's name`, `task's description`. `<match>` is `details.match`, and
`<form>` the form's name at the finding's location. A name's sentence names the form and shows the
match, so it reads true where the text is the default language's translation of the name too.

| Where | String |
|---|---|
| The validator's message, `form-name` | `The name of the form "<form>" in the app's default language holds <match>. CommCare HQ reads instance( followed by a quoted name and a closing bracket as a data source wherever it appears in a form, and a form's name is written there as plain text, so CommCare HQ would add that data source to the form or stop its build. A space before the bracket keeps it as text: instance ('...').` |
| The validator's message, a Connect site | `The <site> in "<form>" holds <match>. CommCare HQ reads instance( followed by a quoted name and a closing bracket as a data source wherever it appears in a form, and CommCare Connect reads this text exactly as the form holds it, so CommCare HQ would add that data source to the form or stop its build. A space before the bracket keeps it as text: instance ('...').` |
| `lib/doc/userFacingErrors.ts`, `form-name` | `The name of "<form>" holds <match>, which CommCare HQ reads as a data source and not as text. A space before the bracket keeps it as text.` |
| `lib/doc/userFacingErrors.ts`, a Connect site | `The <site> in "<form>" holds <match>, which CommCare HQ reads as a data source and not as text. A space before the bracket keeps it as text.` |

7.1 adds no string a person reads in Nova but the public sentence of "Contracts and docs".

---

## Tests

Each test names its boundary and the failure it would catch. No Vitest test mounts a component; UI is
proven by Playwright. Lane documents run on hosted runners: proofs 2 to 4 in the pull request run,
and the served readers in the lane dispatch over the step's new targeted documents (part 14, section
12.4), which names all six of this part's: `targeted-number-keypad`, `targeted-prose-value`,
`targeted-search-no-title`, `targeted-sort-blanks`, `targeted-plain-help` and
`targeted-datetime-saved`.

**The Phone Number question**

| Test | Boundary | Catches |
|---|---|---|
| `lib/domain/__tests__/fieldDisplay.test.ts` (new) | the registry against the real kind schemas, both ways | a setting declared on a schema and missing from the registry, or listed for a kind that does not declare it; a registry value the schema's enum lacks, or an enum value with no registry row (a `feature` that names no platform row already fails `tsc`, by `PlatformFeatureId`) |
| `lib/domain/__tests__/fields.test.ts` | schema execution | `keypad` admitted on a kind other than Text, or a value outside `TEXT_KEYPADS` |
| `lib/domain/__tests__/referenceSlots.test.ts` | the totality audit | `keypad`, `plainHelp` or `plainText` unclassified |
| `lib/commcare/xform/__tests__/appearance.test.ts` (new) | `fieldAppearance` over one field of every kind, and the emitted XForm of the existing emission fixtures parsed by `parseXml` | a control whose `appearance` changed for an existing document; a registry row with no token |
| `lib/commcare/xform/__tests__/numberKeypad.test.ts` (new) | the emitted form through `validator/xformOracle` and `parseXml` | `numeric` on the wrong element, or a bind that is not `xsd:string` |
| `lib/domain/__tests__/platformUses.test.ts`, `lib/commcare/surface/__tests__/platformFeatures.test.ts` | the detector and the manifest binding | a keypad with no use; a row bound to no entry |
| `lib/preview/engine/__tests__/numberKeypad.test.ts` (new) | the form engine's state under each platform's rules; the Android vectors are G5's four reads | Web Apps storing `12 34`; Android keeping a letter, or keeping what G5 shows a phone drops; the earlier answer lost on a refusal |
| `lib/preview/__tests__/platformCells.test.ts` | the cell table | the differing cell with no evidence; its scenario missing or another platform's |
| `e2e/tests/browser/preview-platforms.spec.ts`, scenario `number-keypad-web-apps` | Playwright over the component peer | Preview in Web Apps storing `12 34`, or losing the earlier answer, or showing no message |
| `lib/doc/__tests__/mutations-fields-convertField.test.ts` | the production reducer | a conversion to Password that keeps `keypad` |
| `lib/agent/__tests__/toolSchemaGenerator.test.ts` | the generated schemas | `keypad` accepted on a whole-number question |
| `lib/agent/__tests__/contentProcessing.test.ts`, `lib/agent/tools/__tests__/addFields.guard.test.ts` | `flatFieldToField`, and `addFields` through the tool over the store | `addFields` with `keypad: "numbers"` answering `ok` and storing a Text question without it |
| `e2e/tests/app/number-keypad.spec.ts` (new, `@seed:sections`) | Playwright | the picker entry, the switch, and Preview refusing `12 34` in Web Apps while Android drops a letter |
| lane: `targeted-number-keypad` | proofs 2 to 4, the Web Apps and Android readers, G5 | HQ's build dropping the attribute; the form builder saving another question type; a runtime drawing a plain text box; Preview's Android rule keeping what a phone drops |

**A calculated value, and label text**

| Test | Boundary | Catches |
|---|---|---|
| `lib/domain/__tests__/proseProjection.test.ts`, new `proseExpression.test.ts` | schema execution and the pure functions | a value that is a bare reference admitted; `proseReferenceOf` not the inverse of `proseReferenceExpression` for each of the four kinds; a catalog text admitting a value |
| `lib/domain/__tests__/localization.test.ts`, `translationUnits.test.ts` | fingerprints and integrity over stored fixtures | a fingerprint of a template without a value that moved; a translation that changed a formula accepted |
| `lib/domain/__tests__/expressionSlotAddresses.test.ts` | `expressionSlotValues` and `expressionSlotKey` over a document | a value part missing from the enumeration, or out of slot and part order; a prose slot's key equal to an expression slot's, or two options' labels sharing one key |
| `lib/doc/__tests__/referenceIndex.test.ts` (and its fuzz oracle), `casePropertyRenames.test.ts`, `lookupReferences.test.ts` | the production doc store | a question removable while a label's value reads it; a renamed property left in a value or in its translation; a table deletable while a label reads it |
| `lib/commcare/__tests__/planPrivileges.test.ts` | `formsUsingWorkerRecord` over a document | a form whose only read of the worker's record is a label's `{{= concat(#user/region, ' team')}}` left out of the worker-record plan feature |
| `lib/doc/__tests__/caseTypeRetirement.test.ts` | retirement's references over a document | a case type retired with no mention of the question whose hint value reads `#household/village` |
| `lib/commcare/validator/__tests__/proseValue.test.ts` (new) | the commit gate | a value reading many answers admitted; a finding reported off its text |
| `lib/commcare/xform/__tests__/proseValue.test.ts` (new) | the emitted form through `xformOracle` and `parseXml`; instance declarations read from the model; the constraint's wire tree | an output without its instance; a validation message's value outside the composed expression; a `count()` around a value part's expression, or none around a reference's; `instance(` joined in a label |
| `lib/commcare/__tests__/hqInstanceScan.test.ts` (new) | `instanceScanCuts` as a unit: its offsets over a vector table, and both callers writing no `instance(` run. It restates no HQ behavior; what HQ's scan does with the result is `proof/hq/test_instance_text.py`'s, HQ's own `add_missing_instances` over the built form | a cut at the wrong offset; a caller that skips a cut |
| `lib/doc/__tests__/projectBuilderLanguageMutations.test.ts` | the language projection | a translation that changes a formula accepted, or refused with the old sentence |
| `lib/preview/engine/__tests__/proseValue.test.ts` and `proseValue.vectors.ts` (new) | the form engine | a label that does not redraw when its value's answer changes; a result printed otherwise than G3's vectors |
| `lib/tiptap/__tests__/proseTemplateCodec.test.ts` | the codec | a value lost or altered by a round trip through the editor |
| `lib/agent/authoring/__tests__/proseValue.test.ts` (new), `input.test.ts`, `readContract.test.ts` | the authoring layer over a prepared form | `{{= }}` naming a question added in the same call unresolved; a printed value that does not parse back to the same part; `{{= concat('a', '}}')}}` cut at the `}}` inside its string; a `{{=` in a choice label sent through `setFieldOptionsSource` refused as having no slot; `getCaseProperty` printing a label as its stored parts and not as `{{…}}` text |
| `lib/agent/authoring/__tests__/schemaProjection.test.ts` | the served schemas | a wording position whose description lacks `{{= formula}}`; a case property's label outside the `text` family |
| `lib/doc/hooks/__tests__/expressionEditorContext.test.ts` (new) | `expressionEditorContextFor` as a function of its inputs, over a real document | two values of one label handed one context; a context rebuilt for an unchanged part |
| `e2e/tests/app/prose-references.spec.ts` (new cases, `@seed:sections`) | Playwright | inserting, editing and removing a value in a label and a hint; two values in one label each opening on its own formula; the chip; Preview showing the result |
| lane: `targeted-prose-value`, `proof/native/core/ProseValueRuntimeTest.java` | G1, G3 | as those checks state |
| lane: `proof/hq/test_instance_text.py`, the label controls, in the pull request run | HQ's own `Application.create_all_files` over a form whose label holds `instance('nova_absent')` and one whose label holds `instance('casedb')`, each in today's spelling (a hand-written control) and in section 5's. One expectation: HQ refuses the first control, adds a `casedb` instance to the second, and builds both of section 5's with no added instance | the reading of `add_missing_instances` being wrong; section 5's spelling still read as an instance |

**The title, blanks and text as typed**

| Test | Boundary | Catches |
|---|---|---|
| `lib/domain/__tests__/modules.test.ts` | schema execution | an empty title admitted; `blanks` equal to the direction's own admitted; `columnSort` storing it |
| `lib/domain/__tests__/translationUnits.test.ts` | the inventory | a title unit for a search with none |
| `lib/doc/__tests__/projectBuilderLanguageMutations.test.ts` (which already drives `localizedBlueprintProjection.ts::projectLocalizedModule`) | the language projection, both ways, over a document with two languages | a search with no title projected with the object as its text, or with "Search"; **Show a title** turned on under a language other than the source dropped with no write; turning it off there not reaching the source |
| `lib/domain/__tests__/caseListOrder.test.ts` | the plan | a rule's `blanks` ignored; the implicit rule changed |
| `lib/commcare/__tests__/expander.test.ts`, `hqJsonOracle.test.ts`, `suite/case-list/__tests__/orderPlanOptions.test.ts`, each through `validator/hqJsonOracle` and `suiteOracle` | wire through the oracles | a title text written for no title; `blanks` missing from an element or a `<sort>` |
| `lib/preview/engine/__tests__/caseListOrder.postgres.test.ts` | real Postgres, through Preview's store read | ascending with blanks last, or descending with blanks first, ordered as the direction alone would |
| `lib/commcare/xform/__tests__/markdownForms.test.ts` (new) | the emitted form through `parseXml` | a formatted copy on a hint or a validation message; one on a help holding `plainHelp`; any in a form holding `plainText`; `vellum:ignore` missing |
| `lib/domain/__tests__/plainText.test.ts` (new), `platformUses.test.ts` | the two readers and the detector | the form's switch not reaching a text; a use missing |
| `lib/agent/tools/case-list-config/__tests__/addCaseListColumns.test.ts`, `configureCaseList.test.ts`; `lib/agent/tools/__tests__/editField.test.ts`, `addFields.guard.test.ts`; `lib/agent/__tests__/contentProcessing.test.ts`, `blueprintHelpers.updateForm.test.ts` | the generated schemas and the tools over the store | `blanks: "first"` on an ascending rule refused rather than stored as absent; `plain_help` on a label question accepted; `addFields` with `plain_help: true` answering `ok` and storing no `plainHelp`; `plain_text` not reaching `Form.plainText` |
| `components/builder/case-list-config/__tests__/sortBlanksChoice.test.ts` (new) | the pure function | ascending with blanks last, turned to descending and back, sorting blanks first; a rule never picked keeping its old side after a turn |
| `lib/preview/__tests__/platformCells.test.ts`, `lib/commcare/surface/__tests__/platformFeatures.test.ts`, `manifest.test.ts` | the cell table and the manifest | a row left for the validation message entry after it turns INERT; its ambient line left; the new help entry with no Web Apps cell; a HELD entry without `slotChanges`; two entries claiming one markdown key at one value class |
| `e2e/tests/browser/preview-platforms.spec.ts`, scenario `help-plain-web-apps` | Playwright over the component peer | Preview in Web Apps showing a `plainHelp` help text's symbols |
| `proof/rules/test_hint_validation_markdown_form.py` (new) | Core reading both spellings of one form | the rule erasing a copy some runtime reads |
| `e2e/tests/app/text-and-lists.spec.ts` (new; the help toggle and the form switch under `@seed:sections`, the title switch and the blanks control under `@seed:workspace`) | Playwright | the title switch (under the source language and under another), the blanks control and its two turns of direction, the help toggle and the form switch, each with what Preview then draws |
| lane: `targeted-search-no-title` (`proof/webapps/test_search_title.py`), `targeted-sort-blanks` (its two `caseList` expectations), `targeted-plain-help` (the Android read) | proofs 2 to 4; the Web Apps slice of section 6 for `test_search_title.py`; the Android slice of G4 for `targeted-plain-help` | a heading drawn in Web Apps for a search with no title, or none for a search with one; Core ordering blanks by direction; the form builder adding a copy to a hint on save; a form with the switch reopening without it |

**Text read as an instance (5.1)**

| Test | Boundary | Catches |
|---|---|---|
| `lib/commcare/__tests__/hqInstanceScan.test.ts` (the file above), over `fixtures/hq-instance-scan-vectors.json` | `instanceScanRead` as a function of its input, against rows HQ's own function answers in the lane | a text HQ reads that Nova admits; the offered spelling (`instance ('casedb')`) refused; text typed as `&apos;` refused |
| `lib/commcare/validator/__tests__/formTextInstanceRead.test.ts` (new) | the commit gate over real documents (`lib/doc/commitVerdicts.ts::mutationCommitVerdict`): a rename, a Connect edit through `updateForm`, a `setTranslation` of the default language's name, and a `setDefaultLanguage` that makes a language holding the text the default | a site the rule does not read; the default language's translated name slipping past; a name in another language refused; a finding with the wrong `site`; a scoped run that misses what the whole-document run finds |
| `lib/commcare/xform/__tests__/sourceTexts.test.ts` (new) | the emitted form through `parseXml`, for a learn form and a deliver form whose every authored text is its own marker | a text node outside `<itext>`, or an attribute outside a formula, that holds an authored marker and is not a `formSourceTexts` entry (the defect returning at a new place in the emitter); an entry the emitter no longer writes |
| `lib/doc/__tests__/userFacingErrors.test.ts` | the message table | the builder sentence naming the wrong text for a site, or showing no match |
| lane: `proof/hq/test_instance_text.py`, the vectors and the six build controls, in the pull request run | HQ's own `get_instance_names` and `Application.create_all_files` | HQ's pattern reading more than Nova refuses; the reading of `add_missing_instances` being wrong; the offered spelling being read as an instance |

No Playwright case is added for 5.1. What the builder shows for a refused edit is the editors' own
behavior, which this rule does not change, and the sentence is held at the table.

**A date and time saved to a case (7.1)**

| Test | Boundary | Catches |
|---|---|---|
| `lib/domain/__tests__/temporalValues.test.ts`, over the new `hqInstantText.vectors.ts` | `hqInstantText` and `caseDatetimeValue` as functions of their input; a property test that the order of two texts is the order of their instants, for every four-digit year | a spelling CommCare HQ does not store (three fraction digits, an offset); two moments whose text orders them the other way; a six-digit `Z` value the grammar refuses to read back; unreadable text changed rather than returned |
| `lib/commcare/__tests__/datetimeCaseValue.test.ts`, `xpath/wire/__tests__/instant.test.ts` | the wire tree by structure, and `storedInstantSource` over it | a typed leaf printed in the device's offset; stored text wrapped in `format-date`; a branch of an `if`, `coalesce` or `switch` printed by another branch's class; a literal not folded; `storedInstantSource` not the inverse of `storedInstantValue`; a tree with more than 23 prints of `T` |
| `lib/commcare/__tests__/caseOperationEmission.test.ts`, `generatedNodes.test.ts` | the emitted form through `xformOracle` and `parseXml` | a row whose value holds `now()` printed inline; a `nova_instant_` node with a control or a `type`, or outside its operation's `nova_operations` group; a second node for a value with no clock read; the sibling `nova_datetime_` in the earlier spelling |
| `lib/case-store/postgres/__tests__/submissionEnvelope.postgres.test.ts`, `lib/preview/engine/__tests__/caseListOrder.postgres.test.ts` | real Postgres, through the submission executor and Preview's store read | a submitted date and time stored with the viewer's offset; rows of one property in both spellings and three offsets ordered by their text and not their moment; the order moving with the session's time zone |
| `components/builder/data-review/__tests__/dataReviewModel.test.ts` | the state model | a value saved in Data review stored with an offset |
| lane: `targeted-datetime-saved`, `proof/native/core/StoredInstantRuntimeTest.java`, `proof/hq/test_stored_datetime.py` | proofs 2 to 4, Core in every device zone, CommCare HQ's own `adjust_datetimes` (G6) | the form builder changing the calculate on a save; a zone in which a phone stores another text than CommCare HQ; a copy that moves a day; CommCare HQ rewriting what Nova wrote |
| `proof/native/core/CaseOperationRuntimeTest.java` (its recorded-clock matrix) | Core over the case-operation corpus | its expectations still naming the device's offset for a stored value |

---

## Contracts and docs these changes make false

Old sentence → replacement. Each lands with the code that makes it true, the public pages included.

| Where | Old | New |
|---|---|---|
| `lib/domain/CLAUDE.md`, "Fields are a registry" | (none) | `A question's display is typed: each setting is an optional key of the kinds that can show it, named in fieldDisplay.ts::FIELD_DISPLAY_SETTINGS, and lib/commcare/xform/appearance.ts is the one writer of a control's appearance. A Text question with keypad numbers is CommCare's Phone Number question.` |
| `lib/domain/CLAUDE.md`, the prose paragraph | the sentence's list of five typed parts (`text`, `field-ref`, `case-ref`, `user-property-ref` and external `user-ref`) | `an array of typed parts: text, the four references, and value, a calculated value holding a form-rule Expression, on a field's prose slots and never in the case type catalog. A value that only reads one reference is stored as that reference.` |
| the same file, "Read a template through the right projector" | (none) | `A value part prints through the caller's printer; with none, the human projection reads [calculated value] and the strict one throws.` |
| `lib/domain/CLAUDE.md`, the modules paragraph | `Sort lives per-column (direction + priority)` | `Sort lives per-column (direction, priority, and blanks where it differs from the direction's own)` |
| the same file, `CASE_SEARCH_BUTTON_LABEL` line | `a display constant like the search screen's default title` | the same, followed by `A search with no title holds searchScreenTitle { kind: "none" }; searchScreenTitleText is the one reader.` |
| the same file, "Fields are a registry" | `A question's, container's or choice's plainLabel turns its markdown off.` | `A question's, container's or choice's plainLabel, a help text's plainHelp and a form's plainText turn markdown off; plainText.ts is the one reader.` |
| `lib/commcare/CLAUDE.md`, "Markdown itext", first paragraph | the whole paragraph | `A label and an inline choice write <value form="markdown"> in every language unless their owner holds plainLabel, and a help text unless its question holds plainHelp; a form holding plainText writes none and carries vellum:ignore="markdown". A hint and a validation message never write one: no runtime reads it. CommCare holds markdown per text across every language, so no setting is per language.` |
| the same section | (none) | `Literal text that CommCare HQ's build would read as an instance (hqInstanceScan.ts) is written with its bracket as a literal output, so no label can add an instance or fail a build. Plain text in a form's source has no such spelling and is refused ("CommCare Connect").` |
| `lib/commcare/CLAUDE.md`, "CommCare Connect" | (none) | `A Connect block's name and description, and a form's name in the default language, are plain text in the form's source (xform/sourceTexts.ts::formSourceTexts). HQ's build reads instance('…') there as an instance read and no spelling keeps it out, so the gate refuses text hqInstanceScan.ts::instanceScanRead reads (FORM_TEXT_READ_AS_INSTANCE).` |
| `lib/commcare/CLAUDE.md`, the case list order paragraph ("Sort lives on each column…") | `blanks come first ascending and last descending.` | `blanks follow the rule's own blanks, first ascending and last descending where the author says nothing.` |
| `lib/domain/expression/CLAUDE.md`, "Context and projection" | `ProseSlotRef extends context selection without pretending prose is a stored expression.` | `ProseSlotRef is the context of a prose slot and of each calculated value it holds: expressionSlotValues yields a value part under its prose slot with its path, and expressionSlotKey keys a prose slot too.` |
| `lib/agent/authoring/CLAUDE.md`, "Wording is Markdown…" | `Literal braces and backslashes must round-trip.` | the same, followed by `A {{= formula}} insertion ends at the first }} outside a quoted string.` |
| `lib/agent/authoring/CLAUDE.md` | (none) | `Wording takes {{= formula}} for a calculated value, parsed in the text's prose slot (proseSlots.ts).` |
| `lib/preview/CLAUDE.md`, the labels paragraph | `hints by rules.hint, validation messages as plain text.` | the same, followed by `A help text holding plainHelp, or in a form holding plainText, follows rules.plainHelp. A Text question with a number keypad follows rules.numberKeypad.` |
| `components/builder/CLAUDE.md`, Field editor | `Format text on a label or a choice writes plainLabel.` | `Format text on a label or a choice writes plainLabel and on a help text plainHelp; a form's Format text in this form writes plainText. A Text question's Number keypad switch writes keypad, and the reference picker inserts a calculated value.` |
| `docs/architecture/complex-apps.md` | (none) | the seven paragraphs below |
| `content/docs/where-workers-use-your-app.mdx`, "Other features run on both…" | `…records the device's location on Android.` | the same, followed by `A phone number question takes digits, with an optional + or - in front and an optional decimal part, in Web Apps, and on Android offers a keypad that also has a space and a dash. A help text set to show as typed still shows its formatting in Web Apps.` The first sentence is G5's outcome A. Under outcome B it ends `…a space and a dash, where a + or - only starts the answer.` (the clause only where that rule lands). Under outcome C it reads `A phone number question takes digits, with an optional + or - in front and an optional decimal part, in Web Apps, and on Android offers a keypad of digits, a period, a plus and a minus.` |
| `content/docs/building-with-nova.mdx`, "Text in your app" | (none) | `A label, a hint, a help text, a validation message or a choice can show a calculated value: choose Insert reference, then Calculated value, and write a formula such as a formatted date. Format text can be turned off for one label, one choice or one help text, or for a whole form in its settings.` |
| the same section, a new paragraph after its first | (none) | `CommCare HQ reads instance('name') as a data source wherever it appears in a form. Question text can say it: Nova writes it so that CommCare HQ reads it as text. A form's name and a CommCare Connect name or description have no way to do that, so there Nova asks for a space before the bracket, as in instance ('name').` |
| `content/docs/commcare-connect.mdx`, a new section after "Deliver units and tasks" | (none) | `## Names and descriptions` / `CommCare Connect reads each learn module's, deliver unit's and task's name and description from the form exactly as you wrote them. One phrase can't go in them: instance( followed by a quoted name and a closing bracket, such as instance('casedb'). CommCare HQ reads that as a data source wherever it appears in a form, and would add the source to the form or stop the app's build. A space before the bracket keeps it as text.` |
| `content/docs/mcp/tools.mdx`, the wording paragraph | `…and {{#user/region}} inserts a declared worker property.` | the same, followed by `{{= formula}} inserts a calculated value, such as {{= format-date(date(#form/dob), '%e %b %Y')}}.` |
| the same page, `add_fields` and `get_field` rows | `field_list and plain_label where set` | `field_list, plain_label, plain_help and keypad where set` |
| the same page, the column `sort` paragraph | `A column's sort is one order rule; …` | the same, followed by `blanks says where cases with no value sort, and follows the direction where you leave it out.` |
| `lib/commcare/CLAUDE.md`, "Authored case-operation emission", first paragraph | from "is an untyped leaf whose calculate is `xform/datetimeCaseValue.ts::datetimeCaseValueExpression` of the value" to "Existing stored dates are not rewritten." | `is an untyped leaf whose calculate is xform/datetimeCaseValue.ts::datetimeCaseValue of the value: the moment as CommCare HQ stores it, UTC with six fraction digits and Z (form_processor/utils/xform.py::adjust_datetimes writes that text for every date and time it receives), so the phone, CommCare HQ and every other phone hold one text and a list ordered by the property orders by the moment. Each leaf prints by what Core holds, branch by branch: a typed Date through instant.ts::storedInstantValue, which moves typedInstantText's text to UTC with whole-number arithmetic; text that is already a stored moment as itself, so a copy is exact and Core parses nothing; a date at its UTC midnight. A typed leaf that reads the clock is read once into a Hidden Value nova_instant_<operation id>_<n>, because each print of a value evaluates it again. HQ's form builder writes a row's bind with no type, and Core's Recalculate.wrapData would wrap an untyped calculated Date as the day alone, which is why the value is text. Every @date_modified bind stays xsd:dateTime, the builder's own spelling. Values a phone saved before keep their text.` |
| `lib/commcare/CLAUDE.md`, "Dates and times compare as moments on a device" | `a typed instant as instant.ts::typedInstantValue (the same spelling xform/datetimeCaseValue.ts::datetimeCaseValueExpression writes)` | `a typed instant as instant.ts::typedInstantValue, the device's clock with its offset (a case write prints CommCare HQ's spelling instead, xform/datetimeCaseValue.ts::datetimeCaseValue)` |
| `lib/commcare/CLAUDE.md`, the paragraph on the sibling `nova_datetime_<question>` ("Ordinary datetime writes use a sibling text node…") | `The sibling formats the unpacked typed value; Core's format-date(node-set) itself rounds typed dates, so coalesce unpacks first. An authored operation's write to a datetime property uses the same calculate on an untyped leaf (datetimeCaseValueExpression).` | `The sibling writes the question's moment as CommCare HQ stores it (xform/datetimeCaseValue.ts::datetimeCaseValue), unpacking the typed value with coalesce first, because Core's format-date(node-set) rounds typed dates. An authored operation's write to a datetime property uses the same function on an untyped leaf.` |
| `lib/commcare/xpath/wire/instant.ts`, the comment of `datetimeCoerceValue` | "a typed date and time in `datetimeCaseValueExpression`'s shape" | "a typed date and time as `typedInstantValue`" |
| `lib/domain/CLAUDE.md`, "Temporal values have wire shapes…" | `A datetime answer carries the offset of the zone it was entered in, so it takes the VIEWER's offset (Preview's browser standing in for the device), never Z` and the sentence that follows it | the same, followed by `That is the answer in the form. On a case a date and time is the text CommCare HQ stores, UTC with six fraction digits and Z (hqInstantText, caseDatetimeValue), which the three writers of a case's value call; a row saved earlier keeps the offset it was saved with, and every reader that orders or compares reads the instant.` |
| the same paragraph | `The tag is NOT removed on the way back in: the form instance holds a temporal value exactly as the case store holds it` | the same, followed by `, a time by its tag and a date and time by the cast a loading question applies to the stored text (lib/preview/engine/answerCast.ts)` |
| `lib/case-store/CLAUDE.md`, where it says how a list's order reads a value | (none) | `A list's order reads a custom date-and-time property as the text a device holds, CommCare HQ's text of its instant (compileDeviceTextExpression), so rows saved in either spelling order by the moment.` |
| `content/docs/building-with-nova.mdx`, where it says what a form saves to a case | (none) | `A date and time saved to a case is kept the way CommCare HQ keeps it, in UTC, so a case list sorted by one shows cases in the order they happened. In a list or a case detail the saved value reads in UTC, such as 2026-01-02T09:30:00.000000Z.` |

A search with no title changes no public sentence. No page of `content/docs` describes a search's
title beyond two sentences of `mcp/tools.mdx` (the case search section's opening and the
`set_case_search_display` row), which name the title and stay true. The switch's own line says what
it does ("Copy"), and the tool's description carries the `none` arm.

**`docs/architecture/complex-apps.md`, a new section after "Form sections", "### Question display
and text"**, four paragraphs, from sections 3.1, 4.4, 5 with 5.1, and 8.1:

> **The Phone Number question.** A Text question holding `keypad: "numbers"` is the form builder's
> Phone Number or Numeric ID question (`src/mugs/types/text.js::PhoneNumber`): `<input
> appearance="numeric">` with bind `xsd:string`, read back as that question exactly when the bind is
> a string and the appearance is the whole string `numeric`
> (`parser.js::buildControlNodeAdaptorMap`), and typed `PhoneNumber` by CommCare HQ's question
> summary (`xform.py::VELLUM_TYPES`). The answer is text on every reader, so a leading zero and a
> plus sign are kept. Core keeps the appearance and reads nothing from it. Web Apps draws its phone
> entry where `numeric` is one of the appearance's tokens and stores an answer only where it matches
> `^[+-]?\d*(\.\d+)?$` (`form_ui.js::getMatchingStyles`, `entries.js::getEntry`). Android builds its
> string-number widget where the whole appearance equals `numeric` or `numbers`, with a keypad of
> the digits, a period, a dash, a plus and a space (`WidgetFactory.java::buildBasicWidget`). The
> platform row `number-keypad` states the difference, and `lib/commcare/xform/appearance.ts` is the
> one writer of a control's appearance.
>
> **A calculated value in text.** A prose part `{ kind: "value", expression }` is an `<output
> value>` holding any form-rule expression. Core reads each output of a text as an expression of
> its own (`XFormParser.java::parseOutput`), evaluates it at the question's node
> (`FormDef.java::fillTemplateString`) and prints the result by XPath's string rule
> (`XPathConditional.java::evalReadable`): a date as its ISO day, a number as XPath prints it, yes
> or no as `true` or `false`. Formplayer and Android show Core's text. A value that only reads one
> reference is stored as that reference, so one meaning has one stored form. In a validation
> message a value is composed as it stands, with no `count` guard: Core's `count` takes a node-set
> alone (`XPathCountFunc.java::evalBody`), and Core answers an error raised while it composes a
> message with the expression's own text. The form builder shows an output whose text matches its
> date pattern as a date chip and any other output as written, and keeps both on save
> (`richText.js::extractXPathInfo`, `outputToBubble`).
>
> **Text CommCare HQ reads as an instance.** CommCare HQ's build renders the whole form to one
> string and searches it for instance reads by a text pattern, `instance(`, a quoted name and a
> closing bracket, labels, titles, attributes and data nodes included
> (`xform.py::XForm.add_missing_instances`,
> `suite_xml/post_process/instances.py::get_instance_names`). For a name the form does not declare
> it adds the instance where it has a source for the name and refuses the build otherwise, and an
> added fixture the device does not hold stops the form from opening
> (`CommCareInstanceInitializer.java::loadFixtureRoot`). So literal label text that holds
> `instance('x')` is written with its bracket as a literal output, `<output value="'('"/>`, after
> the word (`lib/commcare/hqInstanceScan.ts::instanceScanCuts`, the cut the serializer already makes
> inside a string literal). A worker reads the same characters, and the text stays one `text` part
> in the document. A form's name and a Connect block's name and description are plain text in the
> form's source, which CommCare Connect and the form builder read as the element's own text
> (commcare-connect `opportunity/app_xml.py::get_element_text`; Vellum `src/commcareConnect.js`), so
> no spelling keeps the scan out there and the gate refuses the text
> (`FORM_TEXT_READ_AS_INSTANCE`, over `lib/commcare/xform/sourceTexts.ts::formSourceTexts`).
>
> **Text shown as typed.** Who reads a text's formatted copy (`<value form="markdown">`) differs
> by text and by platform. A label: Android and Web Apps both format where the copy exists and show
> the text as typed otherwise (`QuestionWidget.java`; `caption_markdown`). An inline choice: Android
> the same, while Web Apps formats every choice. A help text: Android formats where the copy exists
> (`QuestionWidget.java::createHelpLayout`), and Web Apps formats the default text always
> (`form_ui.js::Question.prototype.fromJS`). A hint: Android shows it as typed always
> (`QuestionWidget.java::addHintText`), and Web Apps formats the default text always. A validation
> message: as typed on both (`FormEntryPrompt.java::getConstraintText`). So `plainLabel`,
> `plainHelp` and a form's `plainText` each leave the copy out, a hint and a validation message
> never write one, and a form holding `plainText` carries `vellum:ignore="markdown"` on `h:html`,
> the form builder's Disable Text Formatting (`core.js::showFormPropertiesModal`). The form builder
> writes a copy only where it loaded one or the text looked like formatting
> (`javaRosa/plugin.js::contributeToModelXML`, `loadXML`), so a text Nova writes without one stays
> without one through a save there.

**Under "Case lists, search, and the case workspace", after "The search workflow"**, three paragraphs,
from sections 6, 7 and 7.1:

> **A search with no title.** `searchScreenTitle: { kind: "none" }` is a search with no title;
> absent means "Search". CommCare HQ's Case List page writes `title_label` for every language on
> every save, blank where nothing was typed
> (`views/modules.py::_gather_and_update_search_properties`); the app string is that text or empty
> (`models/case_search.py::CaseSearch.get_search_title_label`), written into the locale file as a
> non-breaking space (`commcare_translations.py::dumps`); and the suite's `<title>` names that
> locale at CommCare 2.53 and later (`feature_support.py::enable_case_search_title_translation`).
> Web Apps trims it and draws the heading only where something is left
> (`formplayer/menus/views/query.js::templateContext`), and Android draws no search title at all.
> So Nova writes `title_label` blank for every language and the `<title>` over a blank locale.
>
> **Where blanks sort.** A sort rule's `blanks` is `first` or `last`, stored only where it differs
> from the direction's own, first ascending and last descending. CommCare HQ's sort rows offer the
> choice with that default (`sort_rows.js`; `views/modules.py::_init_new_sort_element`) and copy it
> to the suite's `<sort blanks>` (`detail_screen.py::sort_node`). Core reads `first` or `last`,
> falls back to the direction otherwise (`DetailFieldParser.java::parseBlanksPreference`), and
> places a blank by that alone, whatever the direction (`EntitySorter.java::getCmp`). Both platforms
> read it alike.
>
> **A date and time on a case.** A date and time saved to a case is text, and CommCare HQ rewrites
> every such text of a submission to UTC with six fraction digits and `Z`
> (`corehq/form_processor/utils/xform.py::adjust_datetimes`,
> `dimagi/utils/parsing.py::json_format_datetime`). A phone keeps what it wrote: a restore sends a
> case back only where a change came from another sync (`get_modified_case_ids.sql`). A list orders
> such a property as text (`EntitySorter.java::getCmp`), so Nova writes CommCare HQ's own text on
> the phone (`lib/commcare/xform/datetimeCaseValue.ts::datetimeCaseValue`): Core prints a typed
> date and time in the device's zone with its offset (`DateUtils.java::getOffsetInStandardFormat`),
> and `instant.ts::storedInstantOfText` moves that text to UTC. Stored text is written as it is,
> because Core's parse of text with an offset keeps the written date and moves only the clock
> (`DateUtils.java::parseTimeAndStore`). Core reads a sort text through `string()`
> (`Text.java::ensureCacheIsParsed`), which prints a number past `int` range in a form its number
> comparator refuses (`FunctionUtils.java::toString`, `toNumeric`), so a moment cannot be a number
> key.

Four of these paragraphs are written for a check's planned outcome, and each check's other
outcomes say what the paragraph takes then: the sentence on Android's widget (G5), a refusal
sentence for a calculated value (G1 outcome B, G3 outcome C), `plainHelp` (G4 outcome B), and the
spelling of a stored date and time (G6 outcome C).

---

## Departures

Where this part departs from the outline, the research and the manifest's cells, with the
alternatives it weighed and did not take. Each item is this plan's decision, with its evidence.

1. **From the outline's item 10: hints and validation messages gain no stored setting.** The outline
   lists a hint or a validation message without a markdown form as a thing to hold, beside the help
   text. At source only the help text's form is read by a runtime (8.1). A stored setting for the
   other two would be a control that changes nothing a worker sees, which Nova does not build.
   Decision: `plainHelp` for the help text; for hints and validation messages Nova writes no
   formatted copy at all (8.2). The outline's aim holds in full: a republish adds no formatting and
   no formatted copy to any of the three. Not done: a stored "as typed" setting on a hint or on a
   validation message, because no runtime would read what it writes.
2. **8.2 changes what existing apps emit, and that is taken knowingly.** Step 6 migrates no stored
   document (the top-level file), which is not the same as leaving every existing app's emission
   alone: 8.2 changes the form bytes of every app that
   has a hint or a validation message, at its next publish. It is no document migration and nothing
   a runtime reads; it is stated here because it moves every such corpus document's key in the lane.
   Not done: writing the copy for an app made in Nova and leaving it out for an app brought in,
   because telling the two apart needs the stored setting Departure 1 declines.
3. **From the outline's item 8, on `instance(…)` text.** The outline asks how an imported label's
   `instance(…)` text is stored. It is stored as the text it is. What changes is Nova's own emitter,
   for every app (section 5), because the defect is not an imported app's. The outline names a
   label alone; the same scan reads a form's name and a Connect block's text, which 5.1 refuses.
4. **Label text holding `instance('x')` is held, and is no finding.** Not done: reading such a
   label as `fix-in-hq` where HQ's build would refuse the form, because HQ keeps a saved source
   whether or not it builds, so such a form can exist there. Nova holds the text and writes it in
   section 5's spelling, which builds either way, and nothing a runtime reads changes. No finding.
5. **Three things the outline lists beside this part's are other parts'.** The 45 `widen` rows of
   its item 6 are part 04's to decide, row by row (its section 2). Of its item 10, reading
   `plainLabel` from the presence of a text's formatted copy, and a `field-list` appearance spelled
   in another case, are the form reader's (part 06, sections 12.2 and 10.2), because each is a
   reading of a form Nova does not write.
6. **From the manifest's cell for the Phone Number entry, "`text` with `Field.appearance: numeric`".**
   There is no `Field.appearance`. The slot is `keypad`, by the rules of 2.1.
7. **From the manifest's cell for a blank title, "step 7's migration writes "Search" as the title of
   each such module".** No migration is planned: absent keeps meaning "Search" and the explicit arm
   means none (section 6). Not done: the cell's migration, which would write "Search" into each
   stored module that sets no title, because the explicit arm says "no title" with no stored
   document changed.
8. **A dropped markdown form is no first-publish change.** A markdown form could be taken for a
   difference the first-publish register declares (part 09, section 11). After step 5's
   `plainLabel` and this part there is nothing left to declare: a label's, a choice's and a
   help text's copy is read and written exactly (`plainLabel`, `plainHelp`, `Form.plainText`), and a
   hint's or a validation message's copy is read by no runtime (8.1), so dropping it changes no
   behavior. A difference that changes no behavior is spelling, and the lane erases it with a proven
   rule (8.2, "In the lane"). Not done: a register entry for the dropped copies, because a person
   would be shown it for nothing.
9. **A form's name and a Connect block's text are refused, where a label is re-spelled.** The
   spellings weighed for plain text in a form's source, and why none keeps HQ's scan out, are 5.1's
   list. Not done: admitting `casedb` and `commcaresession` there, the two names HQ's build only
   declares, because the author would get a rule that turns on which names CommCare HQ knows, and
   Nova would state a source no formula reads. Not done: a rewrite of a saved app's text, because
   the text is the author's and a read-only scan of every saved app found none that holds it (5.1).
10. **From the manifest's cell for the acknowledge label, "`label.acknowledge`".** 2.4 places it as a
    kind of its own: what a question answers is its kind's, never a display setting's.
11. **From the step 7 outline: a list sorted by a date and time is fixed where the value is written,
    in this step.** The outline at `main` lists it among things "step 3 found and left
    byte-stable" and suggests the instant lowering as the sort's `double` key
    (`7-rest-of-model.md` at `1f103305`). This pull request takes that bullet out of the outline.
    It is a defect of today's emitter, so it is fixed here (7.1), and at its cause. Not done, a
    number key over the moment, for four reasons read at the pins. Core reads a sort text through
    `string()` and its number comparator refuses the scientific notation that gives a count of
    microseconds, milliseconds or, from 2038, seconds, so every row's key would be no number
    ("Executed during planning"). A key of its own needs either
    `SortElement.sort_calculation`, which CommCare HQ's Case List page empties without the flag
    `SORT_CALCULATION_IN_CASE_LIST` (the manifest's
    `menus-and-case-lists/sort-calculation-authored-calculation-row-field`) and which
    `detail_screen.py::FormattedDetailColumn.sort_node` never reads on a date column, or a stored
    hidden expression column, which a tile list cannot hold (`lib/domain/caseListOrder.ts`, rule
    1). A worker's list filter matches every field's text, hidden fields included
    (`commcare-core` `util/EntitySortUtil.java::sortEntities`), so a hidden key would make typed
    digits find rows. And a key would leave the two spellings on the phone, in the columns a worker
    reads and in every copy. Not done, a rewrite of the rows Nova already stores: every reader
    that orders or compares them reads the instant (7.1). Not done, a generated node for every
    typed value: a question read is one answer however often it is printed, so only a value that
    reads the clock takes one.

---

## Files

**New**

- `lib/domain/fieldDisplay.ts`: the registry of question display settings and its two readers (2.2).
- `lib/domain/proseExpression.ts`: `proseReferenceExpression` (moved from `lib/commcare/xform/`),
  `proseReferenceOf`, `proseAtomExpression`, `canonicalProseAtom` (4.1).
- `lib/domain/plainText.ts`: `labelShowsAsTyped`, `helpShowsAsTyped` (8.3).
- `lib/commcare/xform/appearance.ts`: `fieldAppearance` and `FIELD_DISPLAY_SETTING_TOKENS` (2.3).
- `lib/commcare/hqInstanceScan.ts`: `instanceScanCuts` (today's `INSTANCE_LITERAL`, moved from
  `xpath/wire/serialize.ts`) and `instanceScanRead` (5, 5.1).
- `lib/commcare/xform/sourceTexts.ts`: `formSourceTexts` (5.1).
- `lib/preview/engine/numberKeypad.ts`: the two platforms' keypad rules (3.6).
- `lib/references/ValueChip.tsx`; `components/builder/ProseValuePopover.tsx` (4.7).
- `components/builder/editor/fields/KeypadEditor.tsx` (3.5).
- `components/preview/form/useHelpFormatText.ts` (8.3).
- `components/builder/case-list-config/sortBlanksChoice.ts`: `blanksAfterDirectionChange` (7).
- `lib/agent/authoring/proseSlots.ts`: `proseSlotAt` (9.2).
- `scripts/scan-instance-text.ts`: the read-only scan of 5.1, removed in the last commit before the
  merge. Its run when the deploy has ended reads it as the top-level file says (its item 1).
- `lib/domain/__tests__/hqInstantText.vectors.ts`: the vectors Vitest and the lane share (G6).
- The tests "Tests" marks new, among them `e2e/tests/app/number-keypad.spec.ts`,
  `e2e/tests/app/text-and-lists.spec.ts` and the fixture
  `lib/commcare/__tests__/fixtures/hq-instance-scan-vectors.json`.
- The lane: the five documents `targeted-number-keypad`, `targeted-prose-value`,
  `targeted-search-no-title`, `targeted-sort-blanks` and `targeted-plain-help`;
  `proof/hq/test_instance_text.py`; `proof/native/core/ProseValueRuntimeTest.java`;
  `proof/webapps/test_search_title.py`; `proof/rules/hint_validation_markdown_form.py` and
  `proof/rules/test_hint_validation_markdown_form.py`; for 7.1 the document
  `targeted-datetime-saved`, `proof/native/core/StoredInstantRuntimeTest.java` and
  `proof/hq/test_stored_datetime.py`.
- Only under a check's outcome: `proof/rules/prose_output_spelling.py` and its test (G1 outcome C).

**Removed**

- `lib/commcare/xform/proseExpression.ts` (its function moves to the domain).
- The export `lib/agent/authoring/text.ts::textSchema`, a copy of a description with no importer.

**Changed**

- The domain: `lib/domain/fields/text.ts` (`keypad`), `fields/base.ts` (`plainHelp`), `forms.ts`
  (`plainText`), `prose.ts` and `blueprint.ts` (the `value` part and the catalog's template),
  `modules.ts` (the title's `none` arm, a sort rule's `blanks`), `caseListOrder.ts` (the rule's own
  `blanks`), `referenceSlots.ts` (the enumeration, and the new keys classified `config`),
  `expressionSource.ts` (`prosePartTerm`), `translationUnits.ts`, `localizedBlueprintProjection.ts`,
  `workerRecordRequirements.ts`, `platforms.ts`, `platformUses.ts`, `index.ts` (the barrel),
  `__tests__/platformFeatureFixtures.ts`; `temporalValues.ts` (`hqInstantText`,
  `caseDatetimeValue`) and `expression/instantOperand.ts` (`literalStoredInstantText`) for 7.1.
- The doc store: `lib/doc/referenceIndex.ts`, `mutations/referenceRewrites.ts`,
  `casePropertyRenames.ts`, `caseTypeRetirement.ts`, `formSectionVerdicts.ts`, `expressionText.ts`
  (`parseProseAtom`, the widened scope), `projectBuilderLanguageMutations.ts` (the refusal's
  sentence, the title's pass-through), `userFacingErrors.ts` (5.1's two sentences),
  `hooks/useXPathSlots.ts`, `hooks/useExpressionSlotContext.ts`, and each consumer of 4.3's tables.
- The emitters and the validator: `lib/commcare/xform/builder.ts` (the one appearance writer, value
  outputs, the label split, the `markdown` arguments, `vellum:ignore`), `xform/formExpressions.ts`,
  `xform/constraintMessage.ts`, `xpath/wire/serialize.ts`, `xpath/formParseScope.ts`,
  `hqJson/caseList.ts`, `suite/case-search/searchSession.ts`, `projectSpaceCompatibility.ts`,
  `validator/index.ts` (the prose loops), `validator/rules/form.ts` (`formTextReadAsInstance`),
  `validator/errors.ts` and `validator/gate.ts` (`FORM_TEXT_READ_AS_INSTANCE`). For 7.1:
  `xform/datetimeCaseValue.ts` (`datetimeCaseValue` in place of its two expression functions),
  `xpath/wire/instant.ts` (`storedInstantOfText`, `storedInstantValue`, `storedInstantSource`),
  `xform/caseOps.ts` and `xform/builder.ts` (the two call sites, the clock node),
  `xform/generatedNodes.ts` (the purpose `instant`). Under G1 outcome B
  or G3 outcome C's second case, also `validator/rules/field.ts`, `errors.ts`, `gate.ts` and
  `lib/doc/userFacingErrors.ts` for that rule.
- The manifest: `lib/commcare/surface/entries/questions.json`, `case-search.json`,
  `menus-and-case-lists.json`, `forms-and-case-writes.json`, their inventory rows, and
  `surface/platformFeatureEntries.ts` (two bindings gained, one ambient line removed).
- Preview: `lib/preview/platform.ts` (`numberKeypad`, `plainHelp`, `searchScreenHeading`),
  `engine/formEngine.ts`, `engine/formExpressionRuntime.ts`, `engine/labelRefs.ts`,
  `engine/triggerDag.ts`, `engine/formText.ts`, `runtimeMessages.ts`, `workerModule.ts`,
  `__tests__/platformCells.ts` (two rows gained, two removed); `e2e/lib/previewPlatformScenarios.ts`,
  `e2e/lib/preview-platforms-client.tsx`, `e2e/tests/browser/preview-platforms.spec.ts`,
  `e2e/tests/app/prose-references.spec.ts`. For 7.1: `lib/preview/columnDisplay.ts`
  (`hqDatetimeText` becomes `hqInstantText`).
- The case store, for 7.1: `lib/case-store/postgres/submissionEnvelope.ts` and
  `lib/case-store/postgres/store.ts` (the two casts), `lib/case-store/sql/compileExpression.ts`
  (`compileDeviceTextExpression`); `components/builder/data-review/dataReviewModel.ts`.
- The editors: `lib/tiptap/commcareRefNode.ts`, `proseTemplateCodec.ts`, `proseReferenceEditing.ts`,
  `CommcareRefView.tsx`; `lib/references/provider.ts` (`projectTemplate`), `LabelContent.tsx`;
  `lib/codemirror/expressionEditorContext.ts`; `components/builder/ProseReferencePicker.tsx`,
  `RefLabelInput.tsx`, `components/preview/form/InlineTextEditor.tsx` and their call sites (the
  `proseSlot` prop); `components/builder/app-setup/protectedProse.ts`;
  `components/preview/form/FieldTypePicker.tsx`, `newFieldDefaults.ts`, `fields/TextField.tsx`, the
  choice fields, `FieldHelp.tsx`, `formatText.ts`; `components/preview/screens/CaseListScreen.tsx`;
  `components/builder/editor/fieldEditorSchemas.ts`, `editor/fields/TextEditor.tsx`;
  `components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx`,
  `canvas/SearchCanvas.tsx`, `CaseListConfigWorkspace.tsx`, `SortPriorityStack.tsx`;
  `components/builder/detail/formSettings/FormAppearanceSection.tsx`.
- The Solutions Architect and MCP: `lib/agent/toolSchemaGenerator.ts`, `contentProcessing.ts`,
  `tools/editField.ts`, `tools/updateForm.ts`, `tools/createForm.ts`,
  `tools/case-search-config/shared.ts`, `tools/case-list-config/shared.ts` and the column tools that
  read it, `tools/localization.ts`, `translation/translator.ts`, `authoring/schema.ts` (the two
  descriptions), `authoring/text.ts`, `authoring/input.ts`, `authoring/output.ts`,
  `authoring/reference.ts`; `scripts/test-schema.ts` (the `setFormSections` entry and four prompts).
- The lane: `proof/native/families.py`, `proof/native/producers/emit-expression-evidence.ts`,
  `proof/android/test_form_reads.py` (G4, G5), `proof/native/core/CaseOperationRuntimeTest.java`
  (its expectations for a stored date and time, 7.1).
- Contracts and docs: the `CLAUDE.md` sentences, the seven paragraphs of
  `docs/architecture/complex-apps.md` and the public pages of "Contracts and docs".

Nothing in this part adds an `/api` route, a schema migration, a table, a privilege or an MCP
tool. Nothing in this part writes production data.
