# Step 6, part 04: Names: the identifier grammars

This part decides every one of the 45 `widen` slot changes the surface manifest carries on a HELD row
(`lib/commcare/surface/entries/*.json`), row by row: built in step 6, split into a HELD row at the grammar
Nova holds plus a HELD-NEW row with its step 7 owner, or named as another part's with the reason. For
each one it builds it plans every place in Nova that holds the grammar: the domain patterns, the
validator's verdicts and sentences, the reference text and its Lezer grammar, the emitter, Preview, the
case store, the lookup tables' database checks, the builder's inputs, the tool schemas, the manifest rows
and the proof documents.

Citations are `path::symbol`: Nova at `main` `1f103305`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every
CommCare fact below was read at those commits for this part. Versions at `1f103305`:
`lib/models.ts::MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.14"`,
`lib/db/appTests.ts::RUNTIME_VERSION` is `18`, and the newest migration is
`lib/case-store/migrations/20261112010000_retained_conversation_sources.ts`.

| Section | Owns |
|---|---|
| 2 | the 45 rows, each decided (eighteen of them by parts 01 and 02), and the grammars this part leaves as they are |
| 3 | question ids: hyphens, and the three derivations that rested on ids holding none |
| 4 | case types: HQ's editor grammar, and no name refused for being a reference word |
| 5 | the reference text for a record type: the hashtag segment grammar and `#record/<type>/<property>` |
| 6 | case property names in a case write: hyphens, and `category` and `state` |
| 7 | choices: one option, and quote marks in a value |
| 8 | a Search field's name |
| 9 | lookup table tags and column names, with their database checks |
| 10 | Connect block ids |
| 11 | the manifest: every entry edit by id, the new entries, and `widen` leaving the schema |
| 12 | the proof documents and what each shows |
| 13 | the agent surface: the served schemas that move, the guide sentence, and the two versions |

---

## Decisions in brief

1. **Nine rows are built, eighteen are split, eighteen are another part's** (section 2). Built, in whole
   or in the part an HQ author can type: question id hyphens, the case type grammar, hyphens in a case
   write's property, `category` and `state` as properties, a one-option select, quote marks in a choice
   value, hyphens in a Search field's name, hyphens and an uppercase `XML` start in a lookup name, and
   hyphens in a Connect block id.
2. **A question id is Vellum's grammar exactly**, `^(?!XML)[A-Za-z][A-Za-z0-9_-]*$`, because HQ's form
   builder itself writes hyphenated ids when a person duplicates a question (`copy-1-of-<id>`) (section 3).
3. **Three derivations that rested on ids holding no hyphen are made injective**: an itext id's key spells
   an id's own hyphen `--`, Preview's query wrapper is named `<id>.query`, and `FormPath` admits the
   hyphen (section 3).
4. **A case type is HQ's editor grammar**, `^[A-Za-z0-9_-]+$`, and no case type is refused for being one
   of Nova's reference words: HQ's own fallback case type is `case` (section 4). The id Nova mints for a
   case change of such a type is always one HQ's form builder takes as a question id (section 4.2).
5. **Reference text names a record type two ways.** `#<type>/<property>` where the type is not one of the
   six fixed words, and `#record/<type>/<property>` for any type; one function prints it for every
   surface, the parsers read both, and a hashtag segment becomes `[A-Za-z0-9_-]+`. HQ's load metadata is
   built from the typed read and never from that text (section 5).
6. **Every case write's property takes the catalog's grammar**, `^[A-Za-z][A-Za-z0-9_-]*$`, and
   `category` and `state` leave the forbidden set; `location_id` and `hq_user_id` stay refused as a
   HELD-NEW row, because CommCare HQ stores each of them somewhere other than the property (section 6).
7. **A select holds one option or more**, and `SELECT_TOO_FEW_OPTIONS` is removed (section 7).
8. **A choice value holds anything but whitespace, unless it holds both an apostrophe and a double
   quote**, which no rule's text can name; that class is a HELD-NEW row (section 7).
9. **A Search field's name admits hyphens**; a key holding `/` or any other character is a HELD-NEW row
   owned by `case-search` (section 8).
10. **A lookup tag and column name is `^[A-Za-z_][A-Za-z0-9_-]*$` and never starts with lowercase
    `xml`**, held by one ledgered migration that replaces two CHECK constraints. A name holding a
    period, a name with accented or non-Latin letters, and a tag equal to an instance name CommCare owns
    are HELD-NEW rows: HQ's build rewrites an unquoted period in a display condition and a case list
    filter, so a read of a dotted name there has no spelling (section 9).
11. **A Connect block id follows the question id grammar, hyphen included**, since it is one grammar
    (section 10).
12. **Names holding non-ASCII letters are not built in step 6**, for case properties and for lookup names
    alike: what Core reads as a name is decided by each runtime's own Unicode tables, so step 6 has no
    one pattern to prove (section 2.3, and Departures).
13. **`widen` leaves the manifest's schema.** No HELD entry states a grammar Nova does not hold:
    `slotChangeSchema.direction` is `narrow` alone (section 11.4).
14. **No document migrates.** Every change is a wider grammar or a removed refusal; one database
    migration widens two checks and is safe with the old revision serving (sections 9.3 and 11).
15. **This part reaches both versions.** It changes served tool schemas, two served descriptions and
    one guide sentence, which the step's one move of `MODEL_CONTEXT_VERSION` covers, and the rename of
    Preview's query wrapper is this part's reason for the step's one move of `RUNTIME_VERSION`
    (sections 3.4 and 13).

## Executed during planning

Read in full or at the named symbols; nothing was run.

**Nova.** `lib/domain/questionId.ts` (whole); `lib/doc/identifierVerdicts.ts` (whole);
`lib/domain/idSlug.ts`; `lib/domain/casePropertyName.ts`; `lib/domain/caseOperationIdentifiers.ts`;
`lib/domain/selectOptionValue.ts` (whole);
`lib/domain/standardCaseProperties.ts::FORBIDDEN_CASE_WRITE_PROPERTIES`,
`::FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES`; `lib/domain/hashtagSegments.ts` (whole);
`lib/domain/expression/types.ts::CASE_TYPE_PATTERN`, `::XML_ELEMENT_NAME_PATTERN`, `::caseTypeNameSchema`;
`lib/domain/expression/print.ts` (`literal`, the `form-case` and `input` arms);
`lib/domain/fields/selectOptionsSource.ts`; `lib/domain/fields/base.ts::selectOptionSchema`,
`::DEFAULT_SELECT_OPTIONS`; `lib/domain/modules.ts::searchInputBase`, `::simpleSearchInputSlots`,
`::idMappingEntrySchema`, `::idMappingValueHoldsForbiddenCharacter`; `lib/domain/forms.ts::connectIdSchema`;
`lib/domain/placements.ts::advancedTagSchema`, `::saveToCasePlacementSchema`;
`lib/domain/advancedEntryDatums.ts` (its two `CASE_TYPE_PATTERN` reads); `lib/domain/blueprint.ts`
(case type `name`), `lib/domain/localization.ts::makeTranslationUnitId`.
`lib/commcare/constants.ts` (whole); `lib/commcare/identifierValidation.ts` (whole);
`lib/commcare/xform/formPath.ts::FormPath` (`parse`, `child`, `attr`); `lib/commcare/xform/itextIds.ts`
(whole); `lib/commcare/xform/generatedNodes.ts` (its header and every base name);
`lib/commcare/xform/queryRepeatNames.ts`, `repeatCountNames.ts`;
`lib/commcare/advancedTags.ts::allocateAdvancedTags`;
`lib/commcare/xpath/grammar.lezer.grammar` (whole), `hashtagGuard.ts`, `coreOperatorTokens.ts`,
`expressionAst.ts` (`hashtag`), `formSyntax.ts` (the `HashtagRef` arm), `CLAUDE.md`;
`lib/commcare/xpath/wire/serialize.ts` (`literalPieces`, `literalTokens`, `printLiteral`, `stepName`, the
`arith` and `neg` arms); `lib/commcare/suite/case-list/keyVariable.ts`;
`lib/commcare/hqJson/caseList.ts::projectColumnToDetail`; `lib/commcare/suite/case-search/searchPrompts.ts`
(the prompt key); `lib/commcare/lookup/naming.ts`, `fixtures.ts`, `workbook.ts` (the names they write);
`lib/commcare/validator/reservedNamespaces.ts`, `rules/module.ts::invalidCaseTypeFormat`,
`rules/field.ts::selectTooFewOptions`, `rules/caseOperations.ts` (its three grammar reads), `gate.ts` (the
select rows), `errors.ts`; `lib/commcare/connectSlugs.ts` (its `questionIdProblem` reads).
`lib/lookup/constants.ts` (whole), `lib/lookup/schema.ts::wireIdentifierSchema`, `lib/lookup/CLAUDE.md`;
`lib/case-store/migrations/20260722053000_lookup_tables.ts` (the three tables' DDL);
`lib/case-store/sql/compileTerm.ts::jsonbColumnRead`;
`lib/case-store/postgres/store.ts::assertSafeIdentifierFragment`;
`lib/case-store/postgres/indexIdentity.ts`. `lib/preview/engine/queryWrapperName.ts`,
`lib/preview/engine/xpathInstances.ts::CASE_ATTRIBUTE_TEMPLATES`, `lib/preview/xpath/evaluator.ts` and
`rewrite.ts` (which parser they call). `lib/agent/authoring/bindings.ts` (`reference`, `printReference`),
`queryExpressions.ts`, `printQueryExpression.ts` (the `table-column` arm), `expressionSyntax.ts`,
`reference.ts` (the `expressions` guide); `lib/agent/toolSchemaGenerator.ts::FIELD_DOCS`,
`::projectedOptionsSourceSchema`; `lib/agent/tools/case-operations/shared.ts`;
`lib/agent/tools/setFieldOptionsSource.ts`; `scripts/test-schema.ts::SCHEMA_TESTS` (the names).
`lib/references/config.ts`, `lib/references/provider.ts::ReferenceProvider.parse`,
`lib/tiptap/refSuggestion.ts` (its two namespace items), `lib/codemirror/xpath-autocomplete.ts` (the
namespace stage). `lib/commcare/csql/print.ts::quoteLiteral`;
`lib/doc/caseListRegistrationForm.ts::hiddenPromptSavesAs`; `lib/agent/tools/updateModule.ts` (its
`case_type` input). `components/builder/editor/FieldIdentitySection.tsx`, `renameOutcome.ts`,
`fields/OptionsEditor.tsx`, `fields/OptionsSourceEditor.tsx`, `fields/optionsDraftModel.ts`,
`components/builder/project-data/projectDataModel.ts::suggestWireName`,
`components/builder/case-list-config/seeds.ts::xmlNameFromProperty`,
`components/builder/case-operations/seeds.ts`. `lib/commcare/surface/schema.ts` (whole) and all 45 entries
with every entry that shares a key with a built one. `proof/targeted/index.ts`,
`proof/targeted/documents/formShapes.ts` (its header), `.github/workflows/proof-audit.yml` (the
`mechanics` dispatch).
Also read: `lib/commcare/hashtags.ts` (whole),
`formActions.ts::buildCaseReferencesLoad`, `hqJson/caseList.ts` (the case list filter's `hqXPath` call),
`expander.ts` (the `form_filter` call),
`xpath/wire/serialize.ts::printPath`, `placement.ts::derivedSaveToCase`,
`validator/formLogicFindings.ts` (the `CASE_HASHTAG_ON_CREATE_FORM` detail),
`suite/case-search/reservedInputNames.ts`, `xform/caseSaveReferences.ts` (its header);
`lib/domain/prose.ts` (`projectProseTemplate`, `printProseTemplate`, `resolveProseTemplate`),
`lib/domain/modules.ts::searchInputLookupOptionsSchema`, `lib/domain/fields/text.ts`;
`lib/doc/expressionText.ts::parseProseReference`, `lib/doc/userFacingErrors.ts` (the `INVALID_FIELD_ID`
and `CONNECT_ID_INVALID_FORMAT` arms); `lib/agent/authoring/text.ts::printAuthoringText`,
`formRecordContext.ts`, `toolSchema.ts`; `lib/agent/planningSchemas.ts` (`casePropertyInputSchema`,
`connectFormConfigShape`), `lib/agent/tools/caseProperties.ts`, `createForm.ts`, `createModule.ts`,
`case-list-config/shared.ts::searchInputDefInputSchema`, `configureCaseList.ts`, `lib/agent/CLAUDE.md`
(the provider contract); `lib/commcare/connectSlugs.ts::CONNECT_ID_FIELD_DESCRIPTION`;
`scripts/inspect-tool-schema-hashes.ts`; `components/builder/shared/caseTypePickerModel.ts`,
`editor/fields/caseWritePresentation.ts`, `project-data/CreateTableDialog.tsx`, `AddColumnDialog.tsx`;
`lib/commcare/__tests__/xformDocArbitrary.ts`, `suiteDocArbitrary.ts`;
`lib/mcp/__tests__/servedSchemas.test.ts`; `lib/commcare/surface/__tests__/gates.test.ts`,
`surface/schema.ts::refusedPlatformsSchema`; `proof/checks/test_manifest_value_classes.py` (`SHAPES`),
`proof/store/queue.py` (the edited-document refusal), `proof/connect/conftest.py` (`DOCUMENTS`,
`ACCEPTED_NAMES`), `proof/targeted/documents/connectApps.ts`;
`lib/case-store/migrations/20261004000000_app_test_lookup_definitions.ts`;
`lib/collab/lookupManifestFrame.ts::lookupManifestFrameSchema` and the lookup pump of
`app/api/apps/[id]/stream/route.ts` (each parses a table's tag under `lookupTagSchema`);
`docs/architecture/complex-apps.md` (the reserved write properties, the case operation grammar and the
inline source's minimum).

**CommCare.** commcare-core `org/javarosa/xpath/parser/Lexer.java` (whole: `lex`, `matchQName`,
`matchNCName`, `isAlpha`, `isDigit`); `org/javarosa/xform/parse/XFormParser.java::parseItem`;
`org/commcare/cases/model/Case.java` (`CATEGORY_KEY`, `STATE_KEY`, `setProperty`, `getProperties`);
`org/commcare/cases/instance/CaseChildElement.java::buildAndCacheInternalTree`, `::setCaseProperties`;
`org/commcare/xml/bulk/BulkProcessingCaseXmlParser.java` (its `category` and `state` arms).
Vellum `src/util.js::isValidElementName`, `::invalidAttributeRegex`;
`src/mugs/baseSpecs.js` (`RESERVED_NAMES`, `databind.nodeID.validationFunc`);
`src/form.js::generate_question_id`; `src/mugs/types/select.js` (the Choice `nodeID.validationFunc`,
`BaseSelect`); `src/javaRosa/util.js::getDefaultItextRoot`; `src/javaRosa/plugin.js` (the itext id check);
`src/widgets.js::identifier`; `src/saveToCase.js::validatePropertyNameChars`, `::CASE_TYPE_REGEX`;
`tests/copy-paste.js` (`/copy-1-of-text`). commcare-hq `corehq/apps/app_manager/util.py::CASE_TYPE_REGEX`,
`::is_valid_case_type`; `views/modules.py` (the `case_type` arm of the module edit view,
`::_init_module_case_type`); `static/app_manager/js/bootstrap5/app_manager.js::valueIncludeInvalidCharacters`,
`::valueIsReservedWord`; `static/app_manager/js/modules/bootstrap5/module_view.js` (the case type
check); `helpers/validators.py::validate_property`, `::IndexedFormBaseValidator.check_case_properties`;
`static/app_manager/json/case-reserved-words.json`;
`static/app_manager/js/forms/case_config_ui.js::caseProperty.validate`;
`models/case_list.py::MappingItem`; `corehq/apps/fixtures/utils.py::is_identifier_invalid`,
`::clean_fixture_field_name`; `fixtures/views.py` (the table save's validation);
`fixtures/upload/workbook.py` (`from_row`); `fixtures/fixturegenerators.py` (the field elements);
`fixtures/static/fixtures/js/lookup-manage.js` (its one pattern);
`corehq/form_processor/backends/sql/update_strategy.py::_apply_update_action`;
`corehq/form_processor/models/cases.py` (`location_id`, `dynamic_case_properties`);
`corehq/ex-submodules/casexml/apps/case/const.py::RESTRICTED_PROPERTIES`; the js-xpath lexer rules in the
form builder HQ vendors (`static/app_manager/js/vellum/`: `#` is a token of its own and a hashtag's
segments are ordinary name tokens). commcare-connect `commcare_connect/opportunity/models.py` (`slug`
on the learn module and deliver unit models), `form_receiver/processor.py` and `opportunity/app_xml.py`
(each reads a block's `@id` as the slug). Also read: commcare-hq
`corehq/apps/app_manager/xpath.py` (`DOT_INTERPOLATE_PATTERN`, `dot_interpolate`, `interpolate_xpath`,
`_ensure_no_case_references`) and each of its callers
(`suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`, `suite_xml/sections/menus.py`,
`models/modules.py`, `suite_xml/post_process/remote_requests.py`,
`suite_xml/sections/details.py`, `helpers/validators.py`); `xform.py::XForm.case_node`; commcare-core
`Case.java::setCategory`, `::setState`, `org/commcare/xml/CaseXmlParser.java` (its `category` and
`state` arms); Vellum `src/saveToCase.js` (the Save to Case section's `nodeID`, which keeps the base
question id rule of `mugs/baseSpecs.js`).

**Claims corrected.**

- **Claim corrected** (research, "External identity": hyphenated question ids "are sound end to end").
  They are sound on the wire, and three Nova derivations are not: `itextIds.ts::fieldItextKey` joins a
  field's path with `-`, so group `a` holding `b-c` and group `a-b` holding `c` would share every itext
  id; `queryWrapperName.ts::previewQueryWrapperName` names Preview's wrapper `<id>-query` on the stated
  ground that no question id holds a hyphen; and `FormPath` throws on a name outside
  `XML_ELEMENT_NAME_REGEX`, which admits none.
- **Verified** (`lib/domain/modules.ts::searchInputBase`, `::simpleSearchInputSlots`): nothing of the
  Search field name's widen is in place today. `simpleSearchInputSlots.property` admits hyphens, but the
  prompt's key is `searchInputBase.name`, held to `XML_ELEMENT_NAME_PATTERN`, which admits none.
- **Verified** (`lib/domain/caseOperationIdentifiers.ts::CASE_OPERATION_PROPERTY_REGEX`): the grammar a
  saved property is held to today is not the catalog's `AUTHORED_CASE_PROPERTY_NAME_PATTERN`. Since step
  5 every "Saves to" is a case operation's write, held to `CASE_OPERATION_PROPERTY_REGEX`, which admits
  no hyphen. So today a catalog entry, a column and a Search field can name `first-name`, and no form
  can save it.
- **Claim corrected** (entry `menus-and-case-lists/modulebase-case-type`: the grammar is "the editor's
  ASCII `^[\w-]+$`"). The page's check is ASCII (`app_manager.js::valueIncludeInvalidCharacters`, a
  JavaScript `\w`), and the server's is not (`util.py::is_valid_case_type` compiles the same text in
  Python, where `\w` is every Unicode word character), so the server stores a type the page marks an
  error. The row also says nothing of the five names Nova refuses on its own
  (`reservedNamespaces.ts::RESERVED_CASE_TYPE_NAMES`), one of which, `case`, is the type HQ gives a menu
  when none is supplied (`views/modules.py::_init_module_case_type`).
- **Claim corrected** (`lib/domain/selectOptionValue.ts`, header: "A quote breaks the XPath literal a
  value is compared with"). Since step 3 every literal prints through
  `xpath/wire/serialize.ts::literalTokens`, which spells a value holding `'` between `"`, and one holding
  both as `concat(…)`. The emitter is already total over quote marks; what has no spelling is the form
  text of a literal holding both (`expression/print.ts`, `literal`, which reports it missing).
- **Verified** (`lib/commcare/xpath/grammar.lezer.grammar`, `hashtagName` and `localName`): a hyphen in
  a question id needs no change to the Lezer grammar. The grammar's `hashtagName` token already admits
  `-` after the first character, and `localName` admits `-` and `.`. The grammar changes for case
  types, not for question ids.
- **Claim corrected** (`lib/case-store/store.ts` and `postgres/store.ts`, two comments naming an
  `indexName` defense "at the bottom of this file"). No such function exists: the case store derives no
  Postgres identifier from a case type or a property. A case type is a `case_type` column value and a
  bound parameter; a property is a JSONB key that Kysely writes as a string literal
  (`compileTerm.ts::jsonbColumnRead`), checked first by `assertSafeIdentifierFragment`.
- **Claim corrected** (research, "External identity", and entry
  `expressions-and-data/tag-or-field-name-with-non-ascii-letters-or-starting-xml-in-any`: a tag or field
  name holding `.` is held verbatim "in the workbook, the fixture and every read"). HQ's build passes a
  case list filter and a form's display condition through `xpath.py::interpolate_xpath`. With a case
  (`entries.py::EntriesHelper.get_filter_xpath`, `menus.py`) it ends in `dot_interpolate`, which replaces
  every `.` outside a quoted string that stands between two characters that are not digits with the
  case's path; without one (`models/modules.py`, `menus.py`, `remote_requests.py`)
  `_ensure_no_case_references` raises on the same shape. Nova writes lookup reads into both slots
  (`hqJson/caseList.ts`, `expander.ts`, each `hqXPath(…, "case")` or `"no-case"`), and
  `serialize.ts::printPath` refuses only a self or parent step there, so a step named `geo.lat` would
  reach HQ's suite rewritten or stop the build. A dotted name has no spelling in those slots.
- **Claim corrected** (`docs/architecture/complex-apps.md`, the reserved write properties: `category`
  and `state` "have dedicated client setters and no server mapping at all, so the same block sets a
  reserved slot on the device and an ordinary dynamic property on HQ"). The setters store into the
  property map itself: `Case.java::setCategory` and `setState` are `data.put(CATEGORY_KEY, …)` and
  `data.put(STATE_KEY, …)`, the map `setProperty` writes and `getProperties` returns, and
  `CaseChildElement.setCaseProperties` exposes every key of it as a child. The device and HQ both hold
  an ordinary property; the device adds an attribute of the same name beside it.
- **Claim corrected** (`lib/commcare/hashtags.ts`, header: `hqLoadReference` "projects typed case reads").
  It takes text: `formActions.ts::buildCaseReferencesLoad` re-assembles `` `#${caseType}/${property}` ``
  from the typed term and `hqLoadReference` dispatches on the text's namespace, throwing for `case` and
  `search` and passing `user` through as a worker read. Today's reservation of those names is what keeps
  that sound.
- **Claim corrected** (`lib/references/config.ts::namespaceOf`, doc: "every node-attr write site derives
  the namespace through one rule"). The function has no caller; only a comment in
  `lib/tiptap/refSuggestion.ts` names it. Eleven files print a case reference with a template of their
  own (section 5.2 lists them).
- **Claim corrected** (`lib/agent/toolSchemaGenerator.ts`, two comments: the select source is "shared by
  add_fields, create_form, create_module, and edit_field"). `createForm.ts` and `createModule.ts` import
  no field or option schema, and their `case_type` is a plain string.
- **Confirmed** (entry `questions/multiple-choice-select1-item`: Vellum and Core allow one option).
  `mugs/types/select.js::BaseSelect` states no minimum, and `XFormParser.parseItem` reads any item.
- **Confirmed** (entry `questions/choice-value-containing-or`: HELD). `XFormParser.parseItem` reports a
  quote mark as a warning (`reporter.warning`, `TYPE_ERROR_PRONE`) and keeps the choice.

## Written and not yet run

Each check below decides something. Each names where it runs and what the session does for every
outcome. None waits on a person.

**R1. The grammar generator over the widened segment token.** Where: `scripts/build-xpath-parser.ts`, run
by the session as it writes the grammar (a few seconds; it regenerates `parser.ts` and
`parser.terms.ts`). Ordinary CI then holds the committed parser by the divergence corpus (T5).
The token `hashtagName` becomes `(@asciiLetter | "_" | @digit | "-")+`, which now overlaps
`NumberLiteral` and the `"-"` token as it already overlaps `localName`.
- *Outcome A, the generator accepts it* (expected: the three are never valid in one state, which is how
  `hashtagName` and `localName` coexist today): section 5 lands as written.
- *Outcome B, the generator reports overlapping tokens*: `hashtagName` is added at the head of the
  `@tokens` block's `@precedence` list. It changes no parse, since `hashtagName` is requested only after
  `noGapIdent`, where neither other token is valid; the divergence corpus (section "Tests", T5) holds it.
- *Outcome C, it still cannot be generated*: the segment leaves `@tokens`. `hashtagGuard.ts` gains a
  third external token, `hashtagSegment`, emitted after `noGapIdent`'s conditions hold and consuming
  `[A-Za-z0-9_-]+`; `HashtagType` and `HashtagSegment` wrap it. Same tests.

**R2. The readers over the eight new documents.** Where: `.github/workflows/proof-audit.yml` on GitHub's
hosted runners, in two runs the session starts itself on a pushed branch (the top-level file
`../6-bring-in.md`, "What needs your yes before this starts", lists the step's lane runs). The eight
documents of section 12 ride the mechanics dispatch over the step's new targeted documents, which runs
the lane with every reader over the documents it names by id, separated by commas:

```bash
gh workflow run proof-audit.yml --ref <the branch> -f nightly=false -f mechanics=<the ids>
```

`nightly` is ticked by default and is unticked here; `mechanics_readers` stays ticked. The queue builder
refuses a selection that names no edited document (`proof/store/queue.py`, since proof 5 collects over
edited documents alone), and three of the eight carry an edit: `targeted-hyphenated-question-ids` and
the two Connect documents (section 12). The gate judges each document on its own, so the eight may
share a dispatch with the other parts' new documents or run apart from them. The Connect proof's own
tests (`proof/connect`) read the documents its `DOCUMENTS` names and run in no `mechanics` dispatch, so
what Connect's receiver makes of a hyphenated id is read through the `ACCEPTED_NAMES` rows section 12
adds, in the second run, a bounded slice:

```bash
gh workflow run proof-audit.yml --ref <the branch> -f nightly=false \
  -f slice='proof/connect/test_receiver.py -k names_beside_connects_keys' -f slice_readers=connect
```

Each document's outcomes are independent. A row below that keeps a grammar as it is today is taken only
where a named CommCare reader refuses or misreads a correctly emitted name, and the entry it writes
names that reader. Where the run shows Nova's emitter, reader, port or Preview wrong, that is corrected
and the document runs again: the grammars are this step's own work.

| Document | Outcome | What lands |
|---|---|---|
| `targeted-hyphenated-question-ids` | every proof passes | section 3 as written |
| | HQ's form builder's two saves change a generated node whose name holds a hyphen, or a shadow that reads one | `generatedNodes.ts`, `queryRepeatNames.ts` and `repeatCountNames.ts` spell an owner id's `-` as `_` in a base name (`nova_trimmed_first_name`), the allocator suffixing as it does on any collision; authored ids keep their hyphens |
| | a reader cannot read an authored hyphenated id | nothing of section 3 lands; row 31 splits: HELD at today's grammar, HELD-NEW `questions/question-id-holding-a-hyphen`, owner `xform`; section 10 falls with it |
| `targeted-case-type-names` | every proof passes | section 4 as written |
| | a reader fails on a type starting with a digit or a hyphen | `CASE_TYPE_PATTERN` is `^[A-Za-z_][A-Za-z0-9_-]*$`; HELD-NEW `menus-and-case-lists/case-type-starting-with-a-digit-or-a-hyphen`, owner `menus`; the rest of sections 4 and 5 lands |
| | a reader fails on a type named `case`, `parent`, `form`, `user` or `search` | that name stays in `RESERVED_CASE_TYPE_NAMES` and gains HELD-NEW `menus-and-case-lists/case-type-named-<name>`, owner `menus`; the others land |
| `targeted-choice-values` | every proof passes | section 7 as written |
| | a reader shows a difference for a value holding a quote mark | `SELECT_OPTION_VALUE_PATTERN` stays; row 33 becomes HELD-NEW whole (`questions/choice-value-holding-a-quote-mark`, owner `xform`); the one-option half lands |
| | a reader fails on a one-option select | the minimum stays two; rows 32 and `questions/checkbox-select-item` gain HELD-NEW `questions/select-with-one-choice`, owner `xform`; the quote half lands |
| `targeted-lookup-names` | every proof passes | section 9 as written |
| | HQ's upload, its restore, its build of a filter or a display condition, or Core's read fails on a name starting `XML` | `LOOKUP_XML_PREFIX_PATTERN` stays `/^xml/i` and both checks keep `!~*`; the class "starting `xml` in any case other than all lowercase" gets the HELD-NEW entry `expressions-and-data/tag-or-field-name-starting-xml-in-another-case`, subject `lookup-tables`, owner `project-data-at-hq-size`, and row 19's `item` drops it |
| | one of them fails on a `-` | nothing of section 9 lands, the migration included; row 19 becomes HELD-NEW whole, owner `project-data-at-hq-size` |
| `targeted-search-field-names` | every proof passes | section 8 as written |
| | HQ's search view or Core binds a hyphenated key wrongly | `searchInputBase.name` keeps today's pattern; the hyphen class joins N3, whose `item` then names the grammar `^[A-Za-z_][A-Za-z0-9_]*$` |
| `targeted-case-write-names` | every proof passes | section 6 as written |
| | HQ's case processing and Core disagree about a saved `state` or `category` | both names stay forbidden and join N2 beside `location_id` and `hq_user_id`; row 21 becomes HELD-NEW whole |
| | the form builder's saves change a Save to Case row whose property holds a hyphen | `CASE_OPERATION_PROPERTY_REGEX` stays; row 34 becomes HELD-NEW, owner `forms-and-case-management` |
| `targeted-connect-deliver-hyphen-ids`, `targeted-connect-learn-hyphen-ids` | every proof passes, and the slice's receiver test passes | section 10 as written |
| | HQ's build or the form builder's two saves change a Connect block whose id holds a hyphen | `connectSlugs.ts` refuses a Connect id holding `-` with the `characters` sentence of today (its `alsoReserved` call gains a hyphen test of its own); row 35 becomes HELD-NEW `questions/connect-block-id-holding-a-hyphen`, subject `connect-blocks`, owner `xform` |
| | Connect's receiver does not complete a hand-written block named with a hyphen (the slice) | the same |

Five fallback rows correct a claim `docs/research/2026-09-26-hq-round-trip/harness-findings.md`
states under "Found while planning step 6", in a bullet that names this run, and the session writes
each into that bullet with the reader and what it showed:

- `targeted-hyphenated-question-ids`, a reader that cannot read an authored hyphenated id: the
  bullet on hyphenated question ids, whose wire half is withdrawn.
- `targeted-lookup-names`, a failure on a `-`: the bullet on a lookup tag or field name holding
  `.`, which then says the whole row is not held yet.
- `targeted-case-type-names`, either fallback row: the bullet on
  `menus-and-case-lists/modulebase-case-type`.
- `targeted-case-write-names`, HQ's case processing and Core disagreeing about a saved `state` or
  `category`: the bullet on `category` and `state`, which is withdrawn.
- `targeted-choice-values`, a difference for a value holding a quote mark: the bullet on a quote
  mark in a choice's value.

Each of those bullets already says what every other row of its document lands, so no other row of
the table writes there, and a document whose every proof passes writes nothing.

The stack does not merge until both runs have run and each document's row of the table is the one that
landed. A grammar a fallback row keeps as it is today keeps its words too: the rows of "Contracts and
docs these changes make false", the strings of "Copy" and the served patterns of section 13 that state
the wider grammar are not written for it. So hyphens in a Connect id leave
`content/docs/commcare-connect.mdx` as it reads today, hyphens in a saved property leave
`content/docs/case-changes.mdx` and the write-property sentence of `content/docs/mcp/tools.mdx`, and a
quote mark in a choice value and a one-option select each leave their own sentence of `mcp/tools.mdx`.

A HELD-NEW entry a fallback row adds takes its subject by part 01's rule
(`01-the-bar-and-the-manifest.md`, section 2.2, the thing its author would name): `question-ids`,
`case-types`, `case-property-names`, `question-choices`, `lookup-tables` or `connect-blocks`. Its
sentence is the subject's `not-yet` sentence of `lib/publish/hqFindingCopy.ts::FINDING_COPY` (part 01,
section 9.2), with the next step `FINDING_NEXT_STEPS["not-yet"]`, and for `question-ids` that sentence
is "A question ID here is one Nova can't hold yet." One of those subjects holds no `not-yet` sentence,
since without a fallback no HELD-NEW entry takes it: `case-types`. A fallback entry of
`targeted-case-type-names` adds it to `FINDING_COPY` with the entry, in these words: "A case type here
is one Nova can't hold yet."

---

## 1. What Nova does today

**Question ids.** `lib/domain/questionId.ts::QUESTION_ID_PATTERN` is `/^(?!XML)[A-Za-z][A-Za-z0-9_]*$/`,
and its header says so: "Nova keeps refusing the hyphen Vellum accepts, a rule of its own."
`questionIdProblem` names the first of five problems, `editorSafeQuestionId` is the one normalizer, and
`questionIdProblemSentence` the one sentence. `Field.id` is `z.string()` in the stored schema
(`lib/domain/fields/base.ts`); the grammar is the gate's (`validator/rules/field.ts`, `INVALID_FIELD_ID`)
and the verdicts' (`lib/doc/identifierVerdicts.ts::fieldIdVerdict`, `renameFieldIdVerdict`), which the
builder's `FieldIdentitySection` and the `addFields` and `editField` tools ask. A Connect block id is
judged by the same function with five more reserved names (`lib/commcare/connectSlugs.ts`), and stored
under `lib/domain/forms.ts::connectIdSchema`, at most 50 characters of `XML_ELEMENT_NAME_PATTERN`.

**Paths and generated names.** `lib/commcare/xform/formPath.ts::FormPath` refuses a segment outside
`lib/commcare/constants.ts::XML_ELEMENT_NAME_REGEX`, `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.
`xform/generatedNodes.ts::planGeneratedNodes` names every generated node `nova_`, its purpose and its
owner's id written as it stands, and steps a taken name to `_<n>`. `xform/itextIds.ts::fieldItextKey` is
a field's path joined with `-`, and an itext id is that key, `-`, and a role (`label`, `hint`, `help`,
`constraintMsg`, or `opt<i>-label`). `lib/preview/engine/queryWrapperName.ts` names a query repeat's
wrapper in Preview's instance `<id>-query`.

**The XPath text.** `lib/commcare/xpath/grammar.lezer.grammar` already lexes a hyphenated name: `localName`
is a start character then any of `identChar`, which holds `-`, `.` and the digits, and `hashtagName` is
`[A-Za-z_][A-Za-z0-9_-]*`. Core lexes the same way: `Lexer.matchNCName` takes a letter or `_`, then
letters, `_`, digits, `.` and `-`, and only where a value is expected, so `a-b` is one name and `a - b` is
a subtraction. Nova's printers never put a minus against a name: `serialize.ts` prints an `arith` node as
`left op right` with spaces and a `neg` node only as an operand, and `expression/print.ts` the same.
Preview parses with the same generated parser (`lib/preview/xpath/evaluator.ts`, `rewrite.ts`).

**Reference text.** A hashtag is `#`, a namespace and one or more segments, each a `hashtagName`
(`lib/domain/hashtagSegments.ts::HASHTAG_SEGMENT_SOURCE`, held to the grammar by
`xpath/__tests__/hashtagMatchers.divergence.test.ts`). Form text binds `form`, `user`, `search` and, for
the SA and MCP, `case` (`expressionAst.ts`, `hashtag`); any other namespace is a case type, so
`#mother/age` reads the `mother` case's `age`. The SA's record dialect adds `row` and
`#record/<type>/<property>` (`lib/agent/authoring/bindings.ts::reference`). Because the namespace is the
case type, `validator/reservedNamespaces.ts::RESERVED_CASE_TYPE_NAMES` refuses the case types `form`,
`user`, `search`, `case` and `parent`, in any letter case (`rules/app.ts`, `RESERVED_CASE_TYPE_NAME`;
`identifierVerdicts.ts::caseTypeNameVerdict`, code `reserved`). One emitter reads that text back:
`formActions.ts::buildCaseReferencesLoad` re-assembles `` `#${caseType}/${property}` `` from each typed
case read and `hashtags.ts::hqLoadReference` dispatches on the text's namespace to build HQ's
`case_references_data.load`, throwing for `case` and `search` and passing `user` through unchanged. And
eleven files print a case reference with a template of their own (section 5.2).

**Case types.** `lib/domain/expression/types.ts::CASE_TYPE_PATTERN` and
`lib/commcare/constants.ts::CASE_TYPE_REGEX` are `/^[a-zA-Z][a-zA-Z0-9_-]*$/`; a third copy with a length
is `lib/agent/tools/case-operations/shared.ts::CASE_TYPE_PATTERN`. A module's `caseType` and a catalog
type's `name` are `z.string()`; the grammar is `caseTypeNameSchema` in every expression term and select
source, the gate's `INVALID_CASE_TYPE_FORMAT` and `CASE_OPERATION_INVALID_CASE_TYPE`, and
`caseTypeNameVerdict`. The emitter writes a case type into string literals, into session datum ids
(`case_id_new_<type>_<n>`, `case_id_case_<type>`: `lib/commcare/session.ts`, `formCaseEntryPlan.ts`) and,
with `-` spelled `_`, into advanced tags (`advancedTags.ts::allocateAdvancedTags`).

**Case properties.** A property's name in the catalog, a column, a Search field and an expression is
`lib/domain/casePropertyName.ts::AUTHORED_CASE_PROPERTY_NAME_PATTERN`, `/^[A-Za-z][A-Za-z0-9_-]*$/`. A
case operation's write is `caseOperationIdentifiers.ts::CASE_OPERATION_PROPERTY_REGEX`,
`/^[A-Za-z][A-Za-z0-9_]*$/`, and may not be one of
`standardCaseProperties.ts::FORBIDDEN_CASE_WRITE_PROPERTIES`, which holds HQ's reserved words and four
names HQ does not reserve: `location_id`, `hq_user_id`, `category` and `state`.

**Choices.** `selectOptionsSource.ts::inlineOptionsSourceSchema` requires two options; the gate's
`SELECT_TOO_FEW_OPTIONS` catches one reached by a granular removal, and the builder's option editor
disables Remove at two. A choice's value is `selectOptionValue.ts::SELECT_OPTION_VALUE_PATTERN`,
``/^[^\s'"`]+$/``, and the option editor drops a quote mark as it is typed
(`sanitizeSelectOptionValue`). An option's itext id is positional (`opt<i>`), and a plain column over a
select property is written to HQ with placeholder keys (`hqJson/caseList.ts::projectColumnToDetail`,
`hqEnumPlaceholder`), so no export spells an option's value outside a literal or an XML text node.

**Search fields.** `modules.ts::searchInputBase.name` is `XML_ELEMENT_NAME_PATTERN`. It is the prompt's
`key` (`searchPrompts.ts`), the name `instance('search-input:results')/input/field[@name='…']` reads, a
locale id's last segment, and the segment of `#search/<name>`.

**Lookup tables.** `lib/lookup/constants.ts::LOOKUP_WIRE_IDENTIFIER_PATTERN` is `/^[A-Za-z_][A-Za-z0-9_]*$/`
and `LOOKUP_XML_PREFIX_PATTERN` `/^xml/i`, applied by `schema.ts::wireIdentifierSchema` to a tag (at most
32 characters) and a column's wire name (at most 255). The database holds the same in two inline checks
(`20260722053000_lookup_tables.ts`): `lookup_tables.tag` and `lookup_columns.wire_name`, each
`~ '^[A-Za-z_][A-Za-z0-9_]*$'` and `!~* '^xml'`. No other table of `public` holds a name grammar. Each
App Test namespace holds a copy of the tag check: `public.nova_create_app_test_namespace`
(`20261004000000_app_test_lookup_definitions.ts`) creates its `lookup_tables` with
`LIKE … INCLUDING CONSTRAINTS` (section 9.3).
A tag is a fixture's element names (`<tag>_list`, `<tag>`), its instance id in a form, a workbook sheet's
name, and a step of every read; a column's wire name is a row's child element and a step.

## 2. The 45 rows, decided

Numbering is the order `lib/commcare/surface/entries/*.json` yields them, by file then by position.

### 2.1 Built in step 6 (nine rows)

| # | Entry | What is built | Section | What is not, and where it goes |
|---|---|---|---|---|
| 17 | `case-search/name-prompt-key-case-property` | hyphens in a Search field's name | 8 | a key holding `/` or any other character: HELD-NEW, `case-search` |
| 19 | `expressions-and-data/tag-or-field-name-with-non-ascii-letters-or-starting-xml-in-any` | `-`, and a name starting `XML` in any case but all lowercase | 9 | a name holding `.`, non-ASCII letters, and a tag equal to an instance name CommCare owns: three HELD-NEW rows, `project-data-at-hq-size` |
| 21 | `forms-and-case-writes/update-keys-location-id-hq-user-id-category-state` | `category` and `state` | 6 | `location_id` and `hq_user_id`: HELD-NEW, `forms-and-case-management` |
| 24 | `menus-and-case-lists/modulebase-case-type` | the editor's whole grammar, and no reference word refused | 4, 5 | a type the page marks an error and the server stores: REFUSED, `not-hq-editable` |
| 31 | `questions/question-id-matching-xml-a-za-z-w` | hyphens | 3 | nothing |
| 32 | `questions/multiple-choice-select1-item` (and `questions/checkbox-select-item`, whose cell says "same widening" and whose `slotChanges` is `[]`, so it is none of the 45) | one option | 7 | nothing |
| 33 | `questions/choice-value-containing-or` | `'`, `"` and `` ` `` in a value | 7 | a value holding both `'` and `"`: HELD-NEW, `xform` |
| 34 | `questions/savetocase-property-names-with-hyphens-a-z-w-case-insensitive` | hyphens in every case write's property | 6 | nothing |
| 35 | `questions/connect-learn-module` (first change) | hyphens in the four Connect block ids | 10 | nothing |

Each is an identifier an HQ author types in an ordinary editor, and none can be changed in HQ without
changing data a project already holds: a question id is a submission path and an export column, a case
type and a property are every existing case's, a choice value is every saved answer, a Search field's key
is the request a server reads, a tag and a column name are what every form of every app in the project
space reads the table by, and a Connect block id is the slug Connect knows the unit by.

### 2.2 Split: HELD at the grammar Nova holds, HELD-NEW for the wider class (eighteen rows)

Each is a capability or a limit, not a name, or a name whose building is a change to a model a step 7
group owns. Section 11.2 writes each new entry in full.

| # | Entry | The wider class | Owner | What it touches, and why it waits |
|---|---|---|---|---|
| 18 | `case-search/default-value-lifting-into-valueexpression` | a default on a date-range Search field | `case-search` | a new slot on `simpleDateRangeSearchInputSchema`, its seed in Preview's search screen, and the range's two-ended value shape |
| 22 | `forms-and-case-writes/update-key-whose-characters-after-the-ascii-first-are-all-core-s` | a key holding a non-ASCII character Core reads | `forms-and-case-management` | 2.3 |
| 23 | `menus-and-case-lists/child-menu-one-tier-root-module-id-a-parentless-module` | a child of another case type under a parent with no forms | `menus` | `NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM` and the entry projection that aligns a child against the root's first form (`formLinkProjection.ts::entrySessionDatums`) |
| 25 | `menus-and-case-lists/detail-max-select-value-on-a-multi-select-basic-list` | a maximum above 100 | `case-list-and-detail` | a number's bound, not a name; Preview's selection screen and the Web Apps reading above HQ's own default are unproven |
| 26 | `menus-and-case-lists/enum-mappingitem-alt-text-lang` | authored alt text on an image map | `case-list-and-detail` | a new translatable slot per mapping row |
| 27 | `menus-and-case-lists/10-markdown-any-property-or-expression` | a markdown column outside the link shape | `case-list-and-detail` | a new column kind |
| 28 | `menus-and-case-lists/21-translatable-enum-authored` | an authored translated expression | `case-list-and-detail` | a new column kind |
| 29 | `menus-and-case-lists/parent-select-active-true-relationship-parent-module-id-a-non` | a parent menu of any other case type, and an extension child | `menus` | `caseParentSelection.ts::caseParentSelectionVerdict` and every chain reader built on the declared parent type |
| 36 | `questions/connect-learn-module` (second change) | an id over 50 characters, a display condition on a block, blank entity expressions, a zero time estimate, several blocks of a kind, a block inside a group or repeat | `xform` | `connectIds.ts::connectBlocks` reads one block of each kind per form; every Connect surface rests on it |
| 37 | `questions/connect-deliver-unit` | a `work_area_id` expression | `xform` | a new expression slot |
| 38, 39 | `questions/bind-required-true`, `questions/bind-required-expr` | required on a label | `xform` | the acknowledge label, which `labelFieldSchema` does not hold |
| 40 | `questions/bind-constraint` | validation on a geopoint, image, audio, video, signature or file question or a label | `xform` | a new `validate` slot on seven field kinds (`fields/geopoint.ts`, `image.ts`, `audio.ts`, `video.ts`, `signature.ts`, `file.ts`, `label.ts`), each with its editor, its Preview check and its emission |
| 41 | `questions/setvalue-event-xforms-ready-default-on-a-question-outside` | a default on an image, audio, video, signature or file question or a label | `xform` | a new `default_value` slot on six of those kinds (a geopoint question holds one today) |
| 42 | `questions/hint-text` | a hint on a label | `xform` | a new `hint` slot on `labelFieldSchema`, whose one slot beyond its label is `relevant` |
| 43 | `questions/help-text-markdown-form` | help on an image, audio, video, signature or file question or a label | `xform` | a new `help` slot on the six kinds of row 41 |
| 44 | `questions/help-media` | help media on an image, audio, video, signature or file question or a label | `xform` | a new `help_media` slot on the same six, which follows row 43's `help` |
| 45 | `questions/validation-message-text` | a validation message on a geopoint, image, audio, video, signature or file question or a label | `xform` | a new `validate_msg` slot on the seven kinds of row 40, which follows its `validate` |

### 2.3 Why names with non-ASCII letters wait

HQ accepts a case property whose characters after an ASCII first letter are any Unicode word characters
(`helpers/validators.py::validate_property`, a Python `\w`; the Case Management page checks no characters
at all, `case_config_ui.js::caseProperty.validate`), and a lookup tag or field that is any XML name
(`fixtures/utils.py::is_identifier_invalid`, which asks lxml). What a device then reads is narrower and is
not one grammar: `Lexer.matchNCName` reads one UTF-16 unit at a time and admits a unit only where Java's
`Character.isLowerCase` or `isUpperCase` holds, a property of the Unicode tables each runtime ships, which
are the JDK's under Formplayer and the operating system's under each Android version. A letter given case
in a later Unicode version is a name on one runtime and a parse failure on another. Building the class
needs a table of the characters every declared platform reads, generated and proven on both, and a
reference text that admits them: `hashtagSegments.ts` and the grammar's `hashtagName` are ASCII on
purpose, and every matcher built from them (the editor's chips, prose references, the SA's dialect) would
change with it. That is one piece of work on the reference text, which step 6 does not prove. The rows are
HELD-NEW with owners (22: `forms-and-case-management`; the lookup class of 19: `project-data-at-hq-size`).
`project-data-at-hq-size` builds the shared name token and its table, since it stands first of the two
in the order step 7 lists its groups (`../7-rest-of-model.md`), and `forms-and-case-management` reuses
it; where the two are reordered, the first of them builds it. The two REFUSED rows beside them
(`forms-and-case-writes/update-key-holding-a-character-validate-property-accepts-that-is`,
`expressions-and-data/tag-or-field-name-core-s-xpath-lexer-does-not-read-as-a-name-any`) keep the
characters Core reads on no runtime.

### 2.4 Another part's (eighteen rows)

| # | Entries | Whose | Why, and what that part does |
|---|---|---|---|
| 1 to 15 | the fifteen `application-and-settings/` rows whose widen is `appSettings.<slot>`, in order: `1-properties-cc-autoup-freq`, `4-properties-cc-days-form-retain`, `5-properties-logenabled`, `13-properties-cc-autosync-freq`, `17-properties-cc-content-valid`, `18-properties-unsent-number-limit`, `19-properties-unsent-time-limit`, `22-properties-cc-resize-images`, `23-properties-cc-fuzzy-search-enabled`, `25-properties-cc-login-duration-seconds`, `26-properties-cc-inflation-target-density`, `27-properties-cc-gps-auto-capture-accuracy`, `28-properties-cc-maps-default-layer`, `29-properties-cc-enable-tts`, `30-properties-cc-label-required-questions-with-asterisk` | part 01 (`01-the-bar-and-the-manifest.md`), section 3.6 | this plan keeps each at CommCare HQ's value: the entry becomes TARGET-OWNED with its `KEPT_AT_HQ` row and the widen is removed. No `appSettings` slot is added. |
| 16 | `application-and-settings/45-hq-auto-gps-capture` | part 01, section 3.6 | the entry is split there: HELD with `slotChanges: []` on a Connect app, and a TARGET-OWNED entry for every other app. The widen leaves with the split. |
| 20 | `forms-and-case-writes/xmlns-form-json-and-xform-data-node` | part 01, section 3.3; the cell is worded by part 10 (`10-identity-and-the-ledger.md`), "Contracts and docs these changes make false" | this plan gives a form no `xmlns` slot (the top-level file `../6-bring-in.md`, "What changed from the outline, and why"; part 10, sections 2 to 4). Part 01 sets `slotChanges: []` with the cell part 10 fixes, an emission-side re-cut, since Nova's exports already hold an `xmlns` this way. |
| 30 | `menus-and-case-lists/case-list-form-post-form-workflow-default-case-list` | part 02 (`02-menus.md`), section 14 | the `always` arm of `Module.caseListRegistrationForm` carries `afterSubmit`, which is this widen. Part 02 re-words the cell and takes the `widen` out of `slotChanges`. |

With those eighteen removals no entry outside this part's twenty-seven holds a widen, which is what
lets `widen` leave the manifest's schema (section 11.4 states the order that follows).

### 2.5 The grammars this part leaves as they are

These identifier grammars do not change in step 6, so a name CommCare HQ holds outside one of them is
a finding and never a held value:

- an operation's id and a link's identifier
  (`caseOperationIdentifiers.ts::CASE_OPERATION_IDENTIFIER_REGEX`, section 6.1);
- a relation's index identifier, an advanced tag, a Save to Case placement's path segments and a tile
  grouping's identifier (`lib/domain/expression/types.ts::XML_ELEMENT_NAME_PATTERN`, section 3.2);
- an ID-mapping key (`modules.ts::idMappingValueHoldsForbiddenCharacter`, section 7.2);
- a worker property's slug, a level's code and a place's site code.

The part that reads one of these from an HQ app states the standing of the wider class, with its
entry: part 07 (`07-the-reader-cases-menus-lists.md`) for the advanced tag, the index identifier, a
link's name and the tile grouping's identifier (its sections 4.4, 5.2 and 11.5, with their entries in
its section 14), part 08 (`08-the-reader-expressions.md`) for the three an expression can name (its
section 9.2), and part 11 (`11-project-data.md`) for worker properties, levels and places (its
section 11). For the grammars this part does widen, a name outside one is a finding under the entry of
11.2 that takes its class.

## 3. Question ids

### 3.1 The grammar

From step 6, `lib/domain/questionId.ts`:

```ts
/** A letter first, then letters, digits, underscores or hyphens, never `XML` first. */
export const QUESTION_ID_PATTERN = /^(?!XML)[A-Za-z][A-Za-z0-9_-]*$/;
```

It is Vellum's `util.js::isValidElementName`, `/^(?!XML)[a-zA-Z][\w-]*$/`, written out (a JavaScript `\w`
is `[A-Za-z0-9_]`). Vellum's `mugs/baseSpecs.js` refuses anything else and `meta` in any case, and its
`form.js::generate_question_id` names a duplicated question `copy-<n>-of-<id>`, so a hyphenated id is what
HQ's form builder writes without the author typing one. Lifecycle: alive, unflagged. The narrow half of
the row stays as it is: no leading underscore, no leading `XML`, the reserved names.

`questionIdProblem` changes one line: the `characters` test is `/^[A-Za-z0-9_-]*$/`. A leading hyphen is
`not-letter-first`, as a leading digit is. `editorSafeQuestionId` keeps a hyphen and strips a leading one:

```ts
let safe = id.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+/, "");
```

so `first name` is still `first_name`, `first-name` stays, `-notes` is `notes` and `1st` is `q1st`. Its
result always passes `questionIdProblem`, the invariant its doc states. Nova's own minters do not change
what they mint: `lib/commcare/identifierValidation.ts::toSnakeId` and `lib/domain/idSlug.ts::slugifyId`
still give underscores. The hyphen is admitted, never minted.

`questionIdProblemSentence`'s `characters` arm changes (Copy, C1), and so do the two fallback sentences
`lib/doc/userFacingErrors.ts` shows when a finding carries no problem, in its `INVALID_FIELD_ID` and
`CONNECT_ID_INVALID_FORMAT` arms, which name "letters, numbers, and underscores" (Copy, C20). The verdicts
(`identifierVerdicts.ts::fieldIdVerdict`, `fieldIdFormatVerdict`, `renameFieldIdVerdict`) and the gate's
`INVALID_FIELD_ID` call these functions and change with them; `FieldIdentitySection.tsx` filters no
characters and shows the verdict's sentence, so the builder needs no change.

### 3.2 Paths

`lib/commcare/constants.ts`:

```ts
/** Nova's XForm element names: an ASCII letter or underscore, then letters, digits,
 * underscores or hyphens. XML itself permits more; this is Nova's vocabulary. */
export const XML_ELEMENT_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
```

Its readers are `FormPath.parse`, `child` and `attr` (the last two spell the grammar out and gain the
hyphen, Copy C18; `parse` prints the pattern itself), `identifierValidation.ts::validatePropertyName`
and `formLinkProjection.ts`'s check of a field id, and each wants the hyphen: a question's element, a
property's leaf under `update/` (section 6) and a generated node.
`lib/domain/expression/types.ts::XML_ELEMENT_NAME_PATTERN` is a different constant and does not change:
it holds a relation's index identifier, an advanced tag, a Save to Case placement's path segments and a
tile grouping's identifier, none of which this part widens. The two names it stops holding get patterns
of their own (sections 8 and 10).

Two comments state the old element grammar and are restated with it. `xform/caseSaveReferences.ts`,
rule 4 of its header: "Every element name `FormPath` reads matches `[a-zA-Z_][a-zA-Z0-9_-]*`, which the
editor's `[\w-]+` admits whole". `advancedTags.ts`, above `spelledType`: "The tag names the data-root
element `case_<tag>`, and a tag is held to `advancedTagSchema`, which holds no `-`, so the case type's
`-` is spelled `_`", and the comment above its check: "A case type holds letters, digits, `-` and `_`".

`xpath/wire/serialize.ts::stepName` already admits a hyphen and a period (it refuses whitespace and
`/[]()'"*=<>`). The Lezer grammar and Core's lexer already read `/data/first-name`, `../first-name`,
`current()/../first-name` and `#form/first-name` as one name each (section 1), and the form builder's own
XPath lexer reads a hashtag as `#` and ordinary name tokens, so `vellum:nodeset="#form/first-name"` and a
shadow that reads `#form/copy-1-of-age` are spellings it writes itself.

### 3.3 Itext ids

`xform/itextIds.ts::fieldItextKey` from step 6:

```ts
/** Logical ancestry, without generated query-repeat item nodes. A hyphen an id
 * holds is written twice, so the single hyphen between two ids and before a
 * role stays a separator and two fields never share a key. */
export function fieldItextKey(form: FormStructure, fieldUuid: Uuid): string | undefined {
	return formFieldPath(form, fieldUuid)
		?.map((segment) => segment.replaceAll("-", "--"))
		.join("-");
}
```

Every id starts with a letter, so in a key a run of hyphens of even length lies inside one id and a run of
odd length ends at a separator; the map from paths to keys is injective, and so is the map to itext ids,
since every role suffix follows one separator. A form with no hyphenated id gets byte for byte the ids it
has today, so no existing form's source changes. `formItextUnits` and `itextIdFor` build ids only from
`fieldItextKey` and need no change; `itextUnitForId` looks an id up in the same map, so
`jr:itext('first--name-label')` in form text binds the unit it prints as. An itext id is an attribute
value and an XPath string literal on every reader, and Vellum's own check refuses only `<&'">`
(`javaRosa/plugin.js`, `util.js::invalidAttributeRegex`).

### 3.4 Generated names

`generatedNodes.ts::planGeneratedNodes`, `queryRepeatNames.ts::queryRepeatBaseNames` and
`repeatCountNames.ts::repeatCountBaseName` write an owner's id into a base name as it stands, so
`nova_trimmed_first-name`, `nova_count_visit-rows` and `nova_query_ids_copy-1-of-members` are names from
step 6. Each is a question id HQ's form builder accepts (`[\w-]*` after the first letter), each element
passes the widened `XML_ELEMENT_NAME_REGEX`, and the allocator is already total over collisions: a base an
authored sibling, a Connect block id or an earlier allocation holds takes `_<n>`. No allocator code
changes. The Save to Case path of a held placement (`saveToCasePlacementSchema.path`) holds only container
names and operation ids, whose grammar this part does not change, so no stored placement meets a hyphen.

`lib/preview/engine/queryWrapperName.ts` from step 6:

```ts
/** The element a query repeat's wrapper attributes sit on in Preview's
 * instance. Preview keeps the repeat's rows directly beneath the repeat's own
 * name, so the wrapper cannot take that name too; a period keeps its name
 * apart from every question id (`lib/domain/questionId.ts::
 * QUESTION_ID_PATTERN`), which may hold a hyphen and never a period. The name
 * is evaluator input only: it never reaches a person or an export. */
export function previewQueryWrapperName(repeatId: string): string {
	return `${repeatId}.query`;
}
```

A period is in no question id, the grammar's `localName` reads `r.query` as one name, and the name still
reaches no person and no export. Its two callers (`formExpressionRuntime.ts`, `dataInstance.ts`) need no
change. A journey that pins a document with a query repeat was built over the old name, so this rename
moves `lib/db/appTests.ts::RUNTIME_VERSION`, and its doc comment names query repeat wrappers. It is
this part's reason for the step's one move of the number (Departure 9; the top-level file holds its
value and the other reason, part 03's section 7.1), and an App Test journey in flight at the deploy is
refused its next step and started again (`lib/db/appTests.ts`: "Nova's test runtime changed. Start a
new test.").

### 3.5 What reads an id and needs nothing

`lib/doc/fieldPath.ts` splits on `/`. The SA's short names and paths compare strings
(`lib/agent/authoring/fieldNames.ts`). The reference index keys on UUIDs. `casePlacementPlan.ts` projects
every path through `FormPath`. HQ's build writes its own binds over the paths the actions name
(`relevant="count(/data/first-name) > 0"`), which Core lexes as one name. The case store never sees a
question id. `FIELD_DOCS.id` in `toolSchemaGenerator.ts` teaches lowercase words joined by underscores and
carries no pattern, so no projected schema changes for a question id.

## 4. Case types

### 4.1 The grammar

From step 6, one pattern in one place, `lib/domain/expression/types.ts`:

```ts
/** CommCare HQ's case type grammar, as its menu page checks it. */
export const CASE_TYPE_PATTERN = /^[A-Za-z0-9_-]+$/;
```

`lib/commcare/constants.ts::CASE_TYPE_REGEX` becomes `export const CASE_TYPE_REGEX = CASE_TYPE_PATTERN;`
(the import direction the boundary allows), and `lib/agent/tools/case-operations/shared.ts` drops its own
copy for `caseTypeNameSchema.max(MAX_CASE_TYPE_LENGTH)`. The source is HQ's page:
`app_manager.js::valueIncludeInvalidCharacters` refuses a value that fails `/^[\w-]*$/`, an empty one is
"Case type is required." (`module_view.js`), and Vellum's Save to Case holds the same
(`saveToCase.js::CASE_TYPE_REGEX`). Lifecycle: alive, unflagged. A leading digit, underscore or hyphen is
therefore authorable, and so is a type of digits alone.

The server's check is wider than the page's (`util.py::is_valid_case_type`, Python's Unicode `\w`), so a
type holding a non-ASCII letter can be stored by a save the page marks an error. That class gets a REFUSED
row, as the two reserved words on a basic menu already have for the same reason (section 11.2, N1).

### 4.2 Every place the type is written

- **String literals** (`@case_type = '1st-visit'`, a create's `case_type` leaf): any character of the
  grammar is safe inside either quote mark. `searchSession.ts`'s one text-assembled literal
  (`ancestor-exists(parent, @case_type='…')`) is safe for the same reason.
- **Session datum ids**: `case_id_new_<type>_<n>` and `case_id_case_<type>` start with a letter whatever
  the type starts with, and HQ's build writes the same ids
  (`suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta`). `validateCaseType` reads
  the widened constant.
- **Advanced tags**: `allocateAdvancedTags` spells `-` as `_` and prefixes `load_`, `open_` or
  `autoload_`, so `load_1st_visit0` and `load__flagged0` are tags. Its thrown sentence changes (Copy, C6).
- **The id a case change is born with.** `caseOperationIdentifiers.ts::ownCaseOperationId` mints the id of
  a form's own case, of a child create and of the worker's update (`lib/doc/scaffolds.ts`,
  `fieldCaseWriteMutations.ts`, `fieldWriteOperations.ts`). It turns every character outside
  `[A-Za-z0-9_]` into `_` and falls back to `case` when the result is no identifier. Today a type starts
  with a letter and is never `case`, so the fallback is unreachable and the id starts with a letter.
  From step 6 a type may start with a digit or a hyphen, or be `case`, and the unchanged minter would give
  `case` for `1st-visit` and for `case`, and `_flagged` for `-flagged`. An operation's id names its Save
  to Case block where it takes one (`placement.ts::derivedSaveToCase`, the `block` segment), and that
  block is a question to HQ's form builder: its Save to Case section holds the base Question ID
  (`saveToCase.js`), whose rule (`mugs/baseSpecs.js`) refuses a name that fails
  `util.js::isValidElementName`, a leading underscore among them, and warns about `case`,
  `registration` and `script`. The block always stands inside an operations group, never at the data
  root, so HQ's build's own `case` node (`xform.py::XForm.case_node`, a child of the data root) is not
  the reason. From step 6 the minter gives only ids the question id rule takes:

  ```ts
  /**
   * The id the form's own case operation is born with: the case type with every
   * character the identifier grammar refuses turned into `_`, prefixed `case_`
   * where that spelling is not a question ID CommCare HQ's form builder takes,
   * and suffixed `_2`, `_3`, … past the form's other operation ids.
   */
  export function ownCaseOperationId(
  	caseType: string,
  	takenIds: ReadonlySet<string>,
  ): string {
  	const spelled = caseType.replace(/[^A-Za-z0-9_]/g, "_");
  	const base =
  		spelled.length === 0
  			? "change"
  			: questionIdProblem(spelled) === undefined
  				? spelled
  				: `case_${spelled}`;
  	return suffixUntilFree(base, takenIds);
  }
  ```

  The signature is today's. `suffixUntilFree` is `lib/domain/idSlug.ts::suffixUntilFree`, which the file
  imports today, and `questionIdProblem` is `lib/domain/questionId.ts::questionIdProblem`, called with
  its default reserved names, a new import inside `lib/domain`. `case_<spelled>` always passes it: it
  starts with a letter, holds only letters, digits and underscores, never starts `XML`, and no reserved
  name starts `case_`. So `1st-visit` gives `case_1st_visit`, `-flagged` gives `case__flagged`, `2024`
  gives `case_2024`, `case` gives `case_case`, and `XMLrecord` gives `case_XMLrecord`. Among the types
  today's grammar admits, every one mints the id it mints today but those the question id rule refuses
  as they stand: `meta`, `registration` and `script` in any letter case, `instance`, `bind`,
  `parsererror`, and a type starting `XML`. No stored id changes: an id is minted once, at the
  operation's birth. An authored operation id keeps `CASE_OPERATION_IDENTIFIER_REGEX`; this part does
  not narrow what a person may type. The builder's seed
  (`components/builder/case-operations/seeds.ts`) already strips leading digits and falls back to
  `change`; it needs no change.
- **The reserved instance family.** `lib/lookup/constants.ts::reservedInstanceTagCause` reserves
  `selected_cases_<type>`; its pattern becomes `/^(?:parent_)*selected_cases(?:_[a-z0-9_-]+)?$/` over the
  lowered tag, so a table cannot take the instance of a type that starts with a digit.
- **The case store**: `case_type` is a column value and a bound parameter everywhere;
  `caseSchemaIndexLockScope` JSON-encodes it. Nothing changes.
- **Preview**: reads types as strings. Nothing changes.

### 4.3 No name is refused for being a reference word

`validator/reservedNamespaces.ts::RESERVED_CASE_TYPE_NAMES` is deleted, with `rules/app.ts`'s
`reservedCaseTypeName` rule, the `RESERVED_CASE_TYPE_NAME` code (`errors.ts`, `gate.ts`, `runner.ts`,
`userFacingErrors.ts`), and `caseTypeNameVerdict`'s `reserved` code and arm. `RESOLVED_REFERENCE_NAMESPACES`
moves to `lib/domain/hashtagSegments.ts` as `HASHTAG_FIXED_NAMESPACES` (section 5).

The reason is HQ's own behavior: `views/modules.py::_init_module_case_type` gives a new menu the type
`case` when none is supplied and no other menu has one, and its page accepts `case`, `parent`, `form`,
`user` and `search` as it accepts any word. `parent` beside a child type is an ordinary name for a
household's adults. Nova writes a case type into no hashtag HQ expands
(`serialize.ts::INTERPOLATION_LITERAL` already splits a literal that would read as one), and no Vellum
shadow carries a case hashtag (`lib/commcare/CLAUDE.md`, "Vellum dual-attribute pattern"). One emitter
does rest on the reservation, and it changes no later than the reservation goes, since without the
change an app the gate admits could not export: HQ's load metadata. `hashtags.ts::hqLoadReference`
becomes a function of the typed read,

```ts
/** HQ's `case_references_data.load` entry for one typed case read, or `undefined`
 * where the form reaches no case of that type. */
export function hqLoadReference(
	caseType: string,
	property: string,
	caseTypeDepths: ReadonlyMap<string, number>,
): string | undefined {
	const depth = caseTypeDepths.get(caseType);
	if (depth === undefined) return undefined;
	const prefix =
		HQ_CASE_GENERATION_PREFIXES[depth] ?? `#case/${"parent/".repeat(depth)}`;
	return prefix + property;
}
```

`hashtagNamespace` and its three text arms (`search`, `case`, `user`) are deleted, and
`formActions.ts::buildCaseReferencesLoad` passes `term.caseType` and `term.property` and adds the
answer to its set only where it is a string and is not a registration form's `#case/case_id`, the one
exclusion it makes today. A read of the type `case`, `user` or `search` at depth 0 is
`#case/<property>` like any other type's, where today the first and third throw and the second is
recorded as a worker read. A type outside the form's reachable types gives `undefined` and no entry,
where today its raw `#<type>/<property>` is recorded; the checker already refuses such a read
(`caseTypes.ts::caseRefAcceptMap`), so no admitted document's bytes change. A worker read keeps its own
arm in `buildCaseReferencesLoad` and is the only source of `#user/`.

With that, the reservation existed only for Nova's own reference text, and section 5 gives that text a
spelling for every type. HQ's own two reserved words, `commcare-user` and `user-owner-mapping-case`, are
untouched: they are the manifest's REFUSED row and `RESERVED_CASE_OPERATION_TYPES`.

### 4.4 Verdicts and messages

`caseTypeNameVerdict` keeps `empty`, `illegal_format`, `too_long` and `duplicate`. The gate keeps
`INVALID_CASE_TYPE_FORMAT`, `CASE_TYPE_TOO_LONG` and `CASE_OPERATION_INVALID_CASE_TYPE`. Their strings are
Copy C2 to C6.

The builder's picker follows. `components/builder/shared/caseTypePickerModel.ts::creationErrorMessage`
switches on the verdict's code, so its `reserved` arm is deleted with the code (a type error otherwise),
and its `illegal_format` line, "Start the name with a word, not a number", stops being true and becomes
Copy C22. `planCaseTypeCreation` keeps slugging what a person types through `idSlug.ts::slugifyId`, which
lowers it and joins its words with underscores, so typing "1st visit" now creates `1st_visit`, which the
earlier rule refused, and typing "Case" creates `case`. The builder mints underscores; a hyphen in a case
type arrives through the Solutions Architect, MCP and a reading of an HQ app.

## 5. The reference text for a record type

### 5.1 The segment grammar

`lib/domain/hashtagSegments.ts` from step 6:

```ts
/** Regex source for ONE hashtag segment (namespace or path segment). */
export const HASHTAG_SEGMENT_SOURCE = "[A-Za-z0-9_-]+";

/** The namespaces reference text fixes, which no case type's short form can take. */
export const HASHTAG_FIXED_NAMESPACES = ["form", "user", "search", "case", "record", "row"] as const;

function isFixedNamespace(name: string): boolean {
	return (HASHTAG_FIXED_NAMESPACES as readonly string[]).includes(name);
}

/** The text before the property: `#record/<type>/` or `#<type>/`. What a completion
 * offers and inserts for a record type. */
export function caseReferencePrefix(caseType: string): string {
	return isFixedNamespace(caseType) ? `#record/${caseType}/` : `#${caseType}/`;
}

/** `#record/<type>/<property>` where the type is a fixed namespace, else `#<type>/<property>`. */
export function caseReferenceText(caseType: string, property: string): string {
	return caseReferencePrefix(caseType) + property;
}

/** The record type and property a hashtag names, or `undefined` when it names neither:
 * `record` with two segments, or any other unfixed namespace with one. */
export function readCaseReference(
	namespace: string,
	segments: readonly string[],
): { caseType: string; property: string } | undefined {
	const [first, second, ...rest] = segments;
	if (namespace === "record")
		return first !== undefined && second !== undefined && rest.length === 0
			? { caseType: first, property: second }
			: undefined;
	if (isFixedNamespace(namespace)) return undefined;
	return first !== undefined && second === undefined
		? { caseType: namespace, property: first }
		: undefined;
}
```

A segment is the case type grammar exactly, so every case type is a segment, and a property, a question
id, a Search field's name, a lookup column's wire name and a worker property's slug stay within it. The
comparison with a fixed namespace is exact, as the parser's is: `Form` is a case type's short form,
`form` is not. `buildHashtagRefRegex` and `HASHTAG_REF_SOURCE` are built from the segment source and
change with it, with no edit of their own.

`grammar.lezer.grammar`: `hashtagIdentStart` is removed and

```
hashtagName { (@asciiLetter | "_" | @digit | "-")+ }
```

with its comment restated ("the ASCII charset shared with `HASHTAG_SEGMENT_SOURCE`, `[A-Za-z0-9_-]+`").
`hashtagGuard.ts`'s `isIdentStart` becomes `isSegmentChar` (letters, digits, `_`, `-`), used by both
guards, so `#1st-visit/age` and `#record/-flagged/age` are one span each. R1 holds the generator's answer.
The frozen grammar and guard under `lib/case-store/migrations/20260728000000_canonical_identity_foundation/`
are frozen and untouched.

Nothing that parses today parses differently. A hashtag's first character after `#` or `/` was a letter
or `_`; text where a digit or `-` stood there (`#form/a/2`, `#2/x`) was a syntax error or no reference,
and is now a reference the binder refuses or the resolve gate leaves as text. XPath has no construct that
puts a number or a minus directly after a path's `/`. In prose the pattern now locates `#1/2`, which
resolves only where a case type `1` declares a property `2`, and a property starts with a letter, so it
stays text.

### 5.2 One spelling rule, every printer and parser

| Place | Today | From step 6 |
|---|---|---|
| `lib/domain/expression/print.ts`, the `form-case` arm | `` `#${term.caseType}/${term.property}` `` | `caseReferenceText(term.caseType, term.property)` |
| `lib/commcare/xpath/expressionAst.ts`, `hashtag` | more than one segment is refused; any unfixed namespace is a case type | after `form`, `user`, `search` and the authoring `case`: `readCaseReference(node.namespace, node.segments)`, a `form-case` term when it answers; otherwise the refusal C7. `row` is refused with C8. |
| `lib/agent/authoring/bindings.ts::reference` | `record` with two segments in every scope; `formCaseTypes.has(value)` for a form's types | the form-scope arm also takes `record` with two segments whose first is one of the form's types, so `#record/case/region` reads the selected or an ancestor record of the type `case`; the short form `#<type>/` reads a form's type only where the word is not one of `HASHTAG_FIXED_NAMESPACES`, whatever order the arms stand in |
| `lib/agent/authoring/bindings.ts::printReference` | a `form-case` term is `#case/<property>` for the selected type, else `` `#${term.caseType}/…` ``; `#record/<type>/<property>` only beside a table scope | the selected type stays `#case/<property>`; every other `form-case` term is `caseReferenceText(term.caseType, term.property)`, so an ancestor type named `case` prints `#record/case/<property>`. `#row/<wireName>` is unchanged: every wire name of section 9 is one hashtag segment |
| `lib/agent/authoring/printQueryExpression.ts`, the `form-case` arm of `term` | `` `#${value.caseType}/${value.property}` `` where the scope printed no reference | `caseReferenceText(value.caseType, value.property)` |
| `lib/agent/authoring/formRecordContext.ts::formRecordContext` | `propertyReference: "#<name>/property"`, `identityReference: "#<name>/case_id"` for each readable type | `caseReferenceText(name, "property")` and `caseReferenceText(name, "case_id")`, so the context the guide tells the SA to read never hands it `#case/property` for an ancestor type named `case`, which would bind the selected record |
| `lib/domain/prose.ts::projectProseTemplate`, `::resolveProseTemplate` (which `printProseTemplate`, `localization.ts::wireText` and `lib/preview/engine/formText.ts` print through) | a `case-ref` part is `` `#${part.caseType}/${part.property}` `` | `caseReferenceText(part.caseType, part.property)`; a `case-ref` of the type `form` prints `#record/form/region`, never `#form/region` |
| `lib/agent/authoring/text.ts::printAuthoringText` | prints one part through `printProseTemplate` and strips a leading `#form/` from any result | strips `#form/` only where `part.kind === "field-ref"`, so a case reference is never shown to the SA as an answer reference |
| `lib/doc/expressionText.ts::parseProseReference` | a non-`form`, non-`user` namespace with one segment is a case type; `case` is the selected type in the authoring scope; `search` fails | after `form`, `user` and the authoring `case`: `readCaseReference(namespace, segments)` gives the `case-ref`, so `{{#record/case/region}}` reads the type `case`; `search`, `row` and a one-segment `record` fail as today's unknown reference does |
| `lib/references/config.ts::namespaceOf`, `classifyNamespace` | `namespaceOf` has no caller; `classifyNamespace` reads every namespace but `form` and `user` as a case type | `namespaceOf` is deleted with the comment in `refSuggestion.ts` that names it; `classifyNamespace` returns `"case"` for `record` too |
| `lib/references/provider.ts` | `ReferenceProvider.parse` reads `#<ns>/<path>`: `form` and `user` are fixed, `case` is no reference, any other namespace is a case type. `search`, `resolve` and the unresolved arm print `` `#${caseType}/…` `` as `raw` and `repairText` | `parse` splits the path on `/` and asks `readCaseReference`, so `record` with two segments is `{ type: "case", caseType: segments[0], path: segments[1] }`, and `case`, `search`, `row` and a one-segment `record` are no reference in prose. `raw` is `caseReferenceText(caseType, property)` and `repairText` is `caseReferencePrefix(caseType)` then `[reference needs repair]`. `search(formUuid, namespace, query)` and `namespaces(formUuid)` stay keyed by case type; their callers pass the type they read from the text |
| `lib/tiptap/refSuggestion.ts` | both namespace items label a type `` `#${ns}/` ``, the namespace command inserts `` `#${props.namespace}/` ``, and `parseQuery` reads the namespace as the text before the first `/` | the label and the inserted text are `caseReferencePrefix(type)`, so a type named `case` is offered and inserted as `#record/case/`; `parseQuery` reads `record/<type>/<query>` as that type and its query, and hands `provider.search` the type |
| `lib/codemirror/xpath-autocomplete.ts`, `xpath-chips.ts` | the namespace stage labels a type `` `#${typeName}/` ``, the property stage labels `` `#${namespace}/${prop}` ``, and the namespace is the text before the first `/`; chips come from parse spans | the namespace stage labels `caseReferencePrefix(typeName)`, the property stage `caseReferenceText(type, prop)`, and a `record` namespace's type is its first segment; chips need nothing |
| `components/builder/editor/fields/caseWritePresentation.ts::destinationRef` | `#user/<property>` for the worker's record, else `` `#${caseType}/${property}` `` | the worker's arm stands; else `caseReferenceText(caseType, property)` |
| `lib/commcare/validator/formLogicFindings.ts`, `details.hashtag` of `CASE_HASHTAG_ON_CREATE_FORM` | `` `#${term.caseType}/${term.property}` `` | `caseReferenceText(term.caseType, term.property)` |
| `lib/commcare/formActions.ts::buildCaseReferencesLoad` | re-assembles the text for `hqLoadReference` | passes the typed read (section 4.3); it prints no reference text |

With every row above in place, a search of `lib` and `components` for a template that starts
`` `#${ `` finds only `hashtagSegments.ts`, the worker's `#user/` and Search's `#search/` arms,
`messages.ts`'s automation scopes and `lib/deployment/hqSourceBaseline.ts`'s ordinal. T6, T7 and T26
hold each surface's print and read over a type named for each of the six fixed words.

In the SA's and MCP's form text `#case/<property>` stays the selected record's alias
(`scope.authoring.selectedCaseType`), whatever its type is called; a type named `case` that is not the
selected one is `#record/case/<property>`. In the builder's text `#case/<property>` stays refused, and its
sentence names the long form (C9).

### 5.3 What stays out

`lib/agent/authoring/messages.ts`'s automation message scopes (`{{#case/…}}`, `{{#parent/…}}`,
`{{#host/…}}`) are a closed vocabulary of their own in which no case type is a namespace; they do not
change. HQ's `#case/` and `#user/` strings in `case_references_data.load` are emitted metadata, built
from the typed read from step 6 (section 4.3) and never from reference text.

## 6. Case property names in a case write

### 6.1 Hyphens

`lib/domain/caseOperationIdentifiers.ts` from step 6:

```ts
/** A written property's name: the catalog's grammar. */
export const CASE_OPERATION_PROPERTY_REGEX = AUTHORED_CASE_PROPERTY_NAME_PATTERN;
export const CASE_OPERATION_PROPERTY_FORMAT_MESSAGE =
	"Start with a letter; use only letters, digits, underscores, or hyphens.";
```

`CASE_OPERATION_IDENTIFIER_REGEX` (an operation's id, a link's identifier) does not change, and its header
comment stops saying a property shares its vocabulary. Both sources agree on the grammar: HQ's build,
`validate_property`'s `^[a-zA-Z][\w_-]*`, and Vellum's Save to Case,
`saveToCase.js::validatePropertyNameChars`, `/^[a-z][\w-]*$/i`. Lifecycle: alive; the Save to Case plugin
loads under the `save_to_case` plan privilege, which publish already asks.

Every reader of the constant follows: `identifierVerdicts.ts::caseOperationWritePropertyVerdict`, the
gate's rule in `rules/caseOperations.ts` (the code that reports an invalid written property),
`case-operations/shared.ts`'s property schema (a projected pattern, section 13), and the "Saves to"
editor's own line (`CaseWriteEditor.tsx`, which already says "letters, numbers, underscores, or hyphens").
On the wire the property is an element under `update/` or `create/`: a basic slot's leaf is HQ's build's
to write and the local archive's through `FormPath` (section 3.2), and a Save to Case row is a child of
the block that Vellum's parser reads with `[\w-]+` (`saveToCase.js`, its case path pattern). The case
store already admits the hyphen (`assertSafeIdentifierFragment`), since the catalog always could.

`lib/domain/placementCopy.ts`'s sentence about a worker property a case action cannot save already names
hyphens and stays true.

### 6.2 `category` and `state`

`standardCaseProperties.ts::FORBIDDEN_CASE_WRITE_PROPERTIES` loses `category` and `state`. HQ's reserved
list (`case-reserved-words.json`) holds neither, its case processing stores each as an ordinary property
(`update_strategy.py::_apply_update_action`: only `location_id`, `name` and `hq_user_id` are special, and
`RESTRICTED_PROPERTIES` holds neither), and Core stores each under its own key in the same property map
every property lives in (`Case.java::setCategory` and `setState` are `data.put(CATEGORY_KEY, …)` and
`data.put(STATE_KEY, …)`, called from the update arms of `CaseXmlParser` and
`BulkProcessingCaseXmlParser`) and exposes it as a child element like any other
(`CaseChildElement.setCaseProperties`), with an attribute of the same name beside it that no Nova
expression reads. `docs/architecture/complex-apps.md` says the two runtimes disagree about the pair; the
source shows they agree, and its paragraph is rewritten ("Contracts and docs"). A geographic `state` and
a `category` are names a person types in the Case Management tab without a second thought. Preview's
case template already lists both attributes (`xpathInstances.ts::CASE_ATTRIBUTE_TEMPLATES`), so a read
of the property still finds the child.

`location_id` and `hq_user_id` stay in the set. CommCare HQ moves a written `location_id` out of the
property map into the case's own column, and copies a written `hq_user_id` into the case's external id
(`update_strategy.py::_apply_update_action`; `models/cases.py`, `location_id` and
`dynamic_case_properties`), so each write means something a property write in Nova's case store does not.
Holding them is a decision about what those two writes are, which `forms-and-case-management` owns.

`lib/doc/caseListRegistrationForm.ts::hiddenPromptSavesAs` reads the set to decide whether a hidden Search
value's name can be the property it is saved under; with two names gone a hidden value named `category`
or `state` is saved, which is right.

## 7. Choices

### 7.1 One option

`lib/domain/fields/selectOptionsSource.ts`: `options: z.array(selectOptionSchema).min(1)`.
`lib/agent/toolSchemaGenerator.ts::projectedOptionsSourceSchema`: `.min(1)`. The zero-option state stays
`SELECT_NO_OPTIONS`; HQ's build cannot read a select with no choices (the manifest's
`questions/select-with-both-items-and-an-itemset-or-no-choices`).

Removed: `rules/field.ts::selectTooFewOptions` and its registration, and the code `SELECT_TOO_FEW_OPTIONS`
in `errors.ts`, `gate.ts` and `userFacingErrors.ts`. The comments that explain the gate by the schema's
minimum are restated for one: `gate.ts` (the `shape` paragraph), `lib/doc/types.ts` (the `convertField`
arm and the granular option kinds), `lib/doc/mutations/fields.ts` (both blocks), `fields/base.ts`
(`DEFAULT_SELECT_OPTIONS`, which stays two starter options, "named so the user's only job is renaming
them"), `fields/singleSelect.ts` and `fields/multiSelect.ts` (their headers), `fields/text.ts` (the
convert-target comment's "the schema's `.min(2)`"), and `toolSchemaGenerator.ts` twice: the `addFields`
item's doc ("≥2 `options` on the selects") and the comment in its kind policy ("structurally required to
carry at least two complete options"), each restated for one.

The builder: `optionsDraftModel.ts::removeOptionDraft` refuses at `draft.length <= 1`;
`OptionsEditor.tsx`'s Remove is disabled at `draft.length <= 1`; `OptionsSourceEditor.tsx`'s "Use these
options" at `draft.options.length < 1`. `setFieldOptionsSource.ts`'s description changes (C13).

A single checkbox ("I have read this to the client") is the ordinary one-option case, and a person
building one in Nova is served by the same change. `validator/rules/selectPreloadWriterOptions.ts` already
branches on `options.length > 1` and needs nothing.

### 7.2 Quote marks in a value

`lib/domain/selectOptionValue.ts` from step 6:

```ts
/** The admitted grammar as one anchored pattern: no whitespace, not empty. */
export const SELECT_OPTION_VALUE_PATTERN = /^\S+$/;

export type SelectOptionValueProblem = "empty" | "whitespace" | "both-quotes" | "duplicate";

export function selectOptionValueProblem(
	value: string,
): Exclude<SelectOptionValueProblem, "duplicate"> | undefined {
	if (value.length === 0) return "empty";
	if (/\s/.test(value)) return "whitespace";
	if (value.includes("'") && value.includes('"')) return "both-quotes";
	return undefined;
}

export const selectOptionValueSchema = z
	.string()
	.regex(SELECT_OPTION_VALUE_PATTERN, SELECT_OPTION_VALUE_REJECTION)
	.refine((value) => !(value.includes("'") && value.includes('"')), SELECT_OPTION_VALUE_BOTH_QUOTES)
	.describe(SELECT_OPTION_VALUE_DESCRIPTION);

export function sanitizeSelectOptionValue(raw: string): string {
	return raw.replace(/\s+/g, "_");
}
```

The grammar is Vellum's: `mugs/types/select.js` refuses a value holding whitespace (`/\s/`, the same
JavaScript class), a value another choice of the question holds, and an empty one; its `widgets.identifier`
turns a typed space into `_` as Nova's sanitizer does. Core warns about a quote mark and keeps the choice
(`XFormParser.parseItem`). Lifecycle: alive, unflagged.

The `quote` problem is renamed `both-quotes` and narrowed. A value holding both an apostrophe and a double
quote stays refused, because a rule that names the choice prints it as a string literal and XPath has no
literal for a string holding both: `expression/print.ts`'s `literal` reports it missing, so no editor could
show the rule. The wire has a spelling (`concat`), and so has the SA's record dialect:
`printQueryExpression.ts::literal` prints such a string as `literal(concat(…))`, which
`queryExpressions.ts` reads back. Form text has none. A choice is compared in form logic (a display
condition, a validation, a calculation), which the builder's XPath editor and the SA both write as form
text through `expressionAst.ts`, and that binder reads no `literal(…)` call. Giving form text the
spelling means a new call in the form grammar's bound vocabulary, its print in `print.ts`, and the
editor's chips and completion over it, a change to what form text is that step 6 does not prove. That
class is the HELD-NEW row N6.

Where a value goes, and why each place is already total:

| Place | Why a quote mark is safe |
|---|---|
| the XForm's `<value>` | an XML text node; `serializeXml.ts` escapes it |
| every comparison and `selected()` test on a device | a wire `str` node, printed by `serialize.ts::literalTokens` between the other quote mark |
| a plain column over a select property, to HQ | placeholder keys and an expression field (`hqJson/caseList.ts::projectColumnToDetail`); the value is a literal in that expression |
| the same column in the local suite | built as wire nodes (`suite/case-list/columns.ts`) |
| a server search condition | `csql/print.ts::quoteLiteral` quotes with the other mark, and throws on a value holding both, a second reason that class waits |
| an option's itext id | positional, `opt<i>` (`itextIds.ts`) |
| a translation unit's id | length-prefixed segments (`localization.ts::makeTranslationUnitId`) |
| a case property's stored value, the catalog's `options[].value` | bound parameters and JSON strings; `CASE_PROPERTY_OPTION_VALUE_INVALID` reads the same function and widens with it |
| Preview | string comparison and `selected()` over tokens |
| form text and the SA's dialect | a literal between the other quote mark (`print.ts::literal`, `printQueryExpression.ts::literal`) |
| a Search field's choices | never a question's choices: a select Search field offers a Project table's value column (`modules.ts::searchInputLookupOptionsSchema`), whose cells this part does not touch and which could hold either quote mark before it. What an answer holding both finds on Android is already said where a Search field is authored (`case-list-config/shared.ts::SEARCH_ANSWER_QUOTE_MARKS_GUIDANCE`) |

An ID-mapping or image-map column's own keys do not widen: `modules.ts::idMappingValueHoldsForbiddenCharacter`
and `CASE_LIST_ID_MAPPING_KEY_CHARACTERS` hold what HQ's mapping dialog refuses, a separate rule with its
own REFUSED row (`menus-and-case-lists/5p-enum-key-containing`). So a column cannot map the value `it's`
to a label by hand, and the plain column's label projection covers it.

The builder's value box stops dropping quote marks and the draft model refuses a value holding both when
the row is committed, with the inline line C23. `repairSelectOptionValue` and
`suggestSelectOptionValue` are unchanged in what they mint (a lowercased slug), and
`repairSelectOptionValue`'s `slugOf(sanitize(value))` still drops punctuation, quote marks among it.

## 8. A Search field's name

`lib/domain/modules.ts` from step 6:

```ts
/** A Search field's name: the key CommCare sends its answer under. */
export const SEARCH_INPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
```

`searchInputBase.name` uses it with C14, and its comment is restated: the name is an attribute value
(`<prompt key>`), a string literal (`field[@name='…']`), the last segment of a locale id
(`search_property.m<N>.<name>`) and a hashtag segment (`#search/<name>`), each of which takes a hyphen.
HQ checks no grammar on a search property's name at all (`views/modules.py::_update_search_properties`
stores what the page sends), so the grammar is Nova's to choose, and the one that matters is the one that
can hold an HQ key equal to a property's name: a property may hold a hyphen, and from step 6 so may the
name. Lifecycle of `CaseSearchProperty.name`: alive, unflagged. None of the request keys HQ reads for
itself holds a hyphen (`suite/case-search/reservedInputNames.ts::RESERVED_SEARCH_INPUT_NAMES`), and the
one reserved prefix, `indices.`, holds a period no name admits, so the reserved set needs no change; its
comment that a name "cannot hold a dot (`XML_ELEMENT_NAME_PATTERN`)" cites `SEARCH_INPUT_NAME_PATTERN`
instead.

`components/builder/case-list-config/seeds.ts::xmlNameFromProperty` seeds a new field's name from its
property and today turns a hyphen into `_`. From step 6 it keeps it:
`property.replace(/[^A-Za-z0-9_-]/g, "_")`, with a leading digit or hyphen still prefixed `_`, and its
comment drops "Properties admit hyphens; names don't." An existing field keeps its name. The builder's
name input in the Search workspace shows the schema's message.

A key holding `/` is HQ's spelling of a related case's property (`parent/age`), and a key holding any
other character is whatever a person typed. Reading either means deriving a Search field's property and
relation from its key, the case search reader's model, so that class is the HELD-NEW row N3, owned by
`case-search`.

## 9. Lookup table tags and column names

### 9.1 The grammar

`lib/lookup/constants.ts` from step 6:

```ts
/** A tag's or a column's wire name: an unaccented letter or underscore, then
 * letters, digits, underscores or hyphens. */
export const LOOKUP_WIRE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** CommCare HQ refuses a name that starts with lowercase `xml`, and only that. */
export const LOOKUP_XML_PREFIX_PATTERN = /^xml/;
```

The source is `fixtures/utils.py::is_identifier_invalid`: a name is refused when it is blank, starts with
the three lowercase characters `xml`, or is not an element name lxml accepts. Over ASCII an element name
is a letter or underscore, then letters, digits, `_`, `-` and `.`. HQ's table page validates the tag as
`<tag>_list` and each field through the same function (`fixtures/views.py`), its upload does the same per
sheet (`upload/workbook.py`, `from_row`), and its page's own script refuses only `/`, `\`, `<`, `>` and a
space (`lookup-manage.js`). Lifecycle: `LookupTable.tag` and `TypeField.name`, alive, unflagged. The 32
and 255 character bounds stand.

Core reads every such name: `Lexer.matchNCName` admits `-` after the first character and an uppercase
`X` first. `fixturegenerators.py` writes a field's element through `clean_fixture_field_name`, which
changes only `/`, `\`, `<`, `>`, whitespace and a leading lowercase `xml`, none of which the pattern
admits, so the element a device receives is the name Nova holds.

**The period is left out, though HQ's table page and Core both take it.** A lookup read is a path whose
steps are the tag and the column, and Nova writes such paths into slots HQ's build rewrites as text
before it prints the suite, the ones `hqJson/xpath.ts::hqXPath` prints in its `"case"` and `"no-case"`
modes: a case list filter and a case form's display condition (`hqJson/caseList.ts`, `expander.ts`),
and a menu's display condition, a survey form's and a Search field's required condition. HQ's
`xpath.py::interpolate_xpath` ends the first two in `dot_interpolate`, which reads every `.` outside a
quoted string that stands between two characters that are not digits as the current case and replaces
it with the case's path (`entries.py::EntriesHelper.get_filter_xpath`, `menus.py`); in the others, which
have no case (`models/modules.py`, `menus.py`, `remote_requests.py`), `_ensure_no_case_references`
refuses the expression and the build stops. A step named `geo.lat` is that shape, and an unquoted step
has no other spelling. A hyphen meets no such rewrite: the same function reads only `.`, `#case`,
`#parent`, `#host`, `#user`, `#session/` and `$fixture_value`. So a dotted name could be held only where
none of those slots reads it, which is a rule about uses, with its own findings and its own copy, and
not a grammar. Step 6 holds the grammar every slot can read; the dotted class is the HELD-NEW row N24.

### 9.2 Where a name goes

- `lib/lookup/schema.ts::wireIdentifierSchema`: the two messages (C15, C16). `reservedInstanceTagCause` is
  unchanged but for the family of 4.2.
- `lib/commcare/lookup/naming.ts`: `listElementName` is `<tag>_list` and `rowElementName` the tag;
  `fixtures.ts` builds each element through `el`, and `workbook.ts` names a sheet by the tag. A hyphen is
  legal in an element name and in a sheet name; the tag's 32 characters already exceed a
  sheet name's 31 and HQ's upload reads it (the lane's
  `proof/views/test_lookup_upload.py`), so no bound moves.
- **Reads.** A form-logic read is `instance('<tag>')/<tag>_list/<tag>[…]/<column>` and a suite read the
  same with `item-list:<tag>`; `serialize.ts::stepName` admits the hyphen, and the grammar's
  `localName` reads `facility-name` and `health-facility_list` as one name each, so
  `formPathBinding.ts` resolves them through the catalog as it does today. In the slots HQ's build
  rewrites as text (9.1) a hyphenated step passes through untouched, which `targeted-lookup-names` shows
  on HQ's own build (section 12).
- **The case store and Preview**: rows are keyed by column UUID; no name reaches SQL or the evaluator
  except as an element of the fixture Preview builds from `naming.ts`.
- **The builder**: `projectDataModel.ts::suggestWireName` keeps suggesting lowercase words joined by
  underscores; only its comment's statement of the rule changes. The tag and column inputs show the
  schema's messages, and the two dialogs' own descriptions, which say "Letters, digits, and underscores"
  (`project-data/CreateTableDialog.tsx`, `AddColumnDialog.tsx`), become Copy C21.
- **The agent**: `lib/agent/tools/lookupTables.ts` and `lib/lookup/authoringBatch.ts` use `lookupTagSchema`
  and `lookupWireNameSchema`, so `createLookupTable`, `updateLookupTable` and `editLookupColumns` project
  the new pattern (section 13).

### 9.3 The database

One ledgered migration, `lib/case-store/migrations/20261113000000_hq_round_trip_lookup_names.ts`, added to
`migrations/index.ts` after `20261112010000_retained_conversation_sources`. It is the first of the
step's migrations by stamp, and the top-level file (`../6-bring-in.md`), where it lists them, holds
the one case in which a stamp moves. The two checks were written inline and never named, so the
migration finds each by its text and replaces it:

```ts
export async function up(db: Kysely<unknown>): Promise<void> {
	// Wait five seconds for a lock, and no longer, while the previous revision serves.
	await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
	await sql`
		DO $$
		DECLARE held record;
		BEGIN
			FOR held IN
				SELECT conrelid::regclass AS relation, conname
				FROM pg_constraint
				WHERE contype = 'c'
					AND (
						(conrelid = 'public.lookup_tables'::regclass
							AND pg_get_constraintdef(oid) LIKE '%tag ~%')
						OR (conrelid = 'public.lookup_columns'::regclass
							AND pg_get_constraintdef(oid) LIKE '%wire_name ~%')
					)
			LOOP
				EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', held.relation, held.conname);
			END LOOP;
		END $$
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_tables ADD CONSTRAINT lookup_tables_tag_check CHECK (
			char_length(tag) BETWEEN 1 AND 32
			AND tag ~ '^[A-Za-z_][A-Za-z0-9_-]*$'
			AND tag !~ '^xml'
		)
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_columns ADD CONSTRAINT lookup_columns_wire_name_check CHECK (
			char_length(wire_name) BETWEEN 1 AND 255
			AND wire_name ~ '^[A-Za-z_][A-Za-z0-9_-]*$'
			AND wire_name !~ '^xml'
		)
	`.execute(db);
	// Hand the batch back as it was found.
	await sql`SET LOCAL lock_timeout = 0`.execute(db);
}
```

`down` puts back the two definitions `20260722053000_lookup_tables.ts` wrote, under the names `up` gave
them, and throws before it changes anything when a stored name fails them, naming how many:

```ts
export async function down(db: Kysely<unknown>): Promise<void> {
	const held = await sql<{ tags: string; wire_names: string }>`
		SELECT
			(SELECT count(*)::text FROM public.lookup_tables
				WHERE tag !~ '^[A-Za-z_][A-Za-z0-9_]*$' OR tag ~* '^xml') AS tags,
			(SELECT count(*)::text FROM public.lookup_columns
				WHERE wire_name !~ '^[A-Za-z_][A-Za-z0-9_]*$' OR wire_name ~* '^xml') AS wire_names
	`.execute(db);
	const tags = held.rows[0]?.tags ?? "0";
	const wireNames = held.rows[0]?.wire_names ?? "0";
	if (tags !== "0" || wireNames !== "0") {
		throw new Error(
			`Nova can't put the earlier lookup name checks back: ${tags} table tags and ${wireNames} ` +
				"column names hold a hyphen or start with XML in capitals, which the earlier checks " +
				"refuse. Renaming them first lets the rollback run.",
		);
	}
	await sql`
		ALTER TABLE public.lookup_tables
			DROP CONSTRAINT lookup_tables_tag_check,
			ADD CONSTRAINT lookup_tables_tag_check CHECK (
				char_length(tag) BETWEEN 1 AND 32
				AND tag ~ '^[A-Za-z_][A-Za-z0-9_]*$'
				AND tag !~* '^xml'
			)
	`.execute(db);
	await sql`
		ALTER TABLE public.lookup_columns
			DROP CONSTRAINT lookup_columns_wire_name_check,
			ADD CONSTRAINT lookup_columns_wire_name_check CHECK (
				char_length(wire_name) BETWEEN 1 AND 255
				AND wire_name ~ '^[A-Za-z_][A-Za-z0-9_]*$'
				AND wire_name !~* '^xml'
			)
	`.execute(db);
}
```

Every stored row passes the new checks, since each passed the narrower ones, so `ADD CONSTRAINT`
validates without a scan script.

**Locks.** The two `DROP CONSTRAINT`s take `ACCESS EXCLUSIVE` on `lookup_tables` and on
`lookup_columns`, two tables the serving revision reads and writes. The migrator runs every pending
migration in one transaction (`lib/case-store/CLAUDE.md`: "Kysely wraps the whole migration batch in
ONE transaction"), and this migration is the first of the step's four by stamp, so both locks are held
until the whole batch commits: through this migration's two validation passes and through the three
migrations after it, and not for this migration's statements alone. The top-level file ("Migrations and
the deploy") says once what that hold is made of and why it needs no maintenance window. What this
migration owes that argument is the bound on its own wait. `up` opens with
`SET LOCAL lock_timeout = '5s'`, as `20261112000000_incremental_transcripts` and part 10's migration do
(`10-identity-and-the-ledger.md`, section 11, statement 0), so a lock request that queues behind one
long reader gives up after five seconds, where an unbounded request would stall every lookup read
behind it for as long as that reader ran. It closes by setting the timeout back to `0`, as
`20260724030000_opaque_case_ids` does, so each migration of the batch states its own. A request that
times out raises SQLSTATE `55P03` and fails the migration Job with nothing changed, since the batch is
one transaction; the Job's failure blocks the deploy, and running the deploy again tries again. T18
holds the bound and the reset.

**With the previous revision serving.** The migration is additive in what it admits, so it is safe
while `main` as it stood before the step still serves:
that revision's own schema (`lib/lookup/schema.ts::wireIdentifierSchema` at `1f103305`) lets it write
only names the old checks accept, and the new checks accept every one of those. A name holding a
hyphen exists only once the new revision serves and someone saves one; no code mints one, since
`suggestWireName` still joins words with underscores (9.2). An instance or an open tab of the earlier
revision that meets such a name while the rollout lasts refuses it under its own narrower schema (a
lookup manifest frame parses each tag, `lib/collab/lookupManifestFrame.ts::lookupManifestFrameSchema`,
on the server's stream and in the browser, and each retries or refetches), which is the forward-only
state the top-level file states for every grammar the step widens, and it ends with the rollout.
`lib/lookup/constants.ts`'s comment on `LOOKUP_MAX_TAG_LENGTH` ("the `lookup_tables` check holds the
same number") stays true.

The migration changes `public` alone, and that is enough. Each App Test namespace holds its own
`lookup_tables`, created `LIKE public.lookup_tables INCLUDING CONSTRAINTS`
(`20261004000000_app_test_lookup_definitions.ts`), so a namespace made after the migration copies the
new check and one made before it keeps the old. A namespace lives for one journey, a journey made
before the deploy carries the runtime version of the revision before the step, and this step moves
`RUNTIME_VERSION` (3.4), so such a journey is refused its next step and never meets a tag the old
check would refuse. T18 holds that a namespace created after the migration takes a hyphenated tag.

### 9.4 What is not built

- **A name holding a period**: 9.1. HQ's table page accepts it and Core reads it, and HQ's build
  rewrites or refuses it in a filter, a display condition and a required condition. Holding it needs a
  rule that refuses a read of a dotted name in those slots, with its sentence on every surface that
  writes them. HELD-NEW row N24, `project-data-at-hq-size`.
- **Non-ASCII letters**: 2.3. HELD-NEW row N4.
- **A tag equal to an instance name CommCare owns** (`commcaresession`, `locations`, `results`, `input`,
  `search_selected_cases` and the `selected_cases` family, the names `reservedInstanceTagCause` answers
  `{ kind: "name" }` for other than `casedb` and `ledgerdb`, which the REFUSED row
  `expressions-and-data/tag-containing-casedb-or-ledgerdb` holds), which the entry's item also names.
  HQ accepts such a tag, and the form builder then gives the table's instance an id that differs from
  its tag (`form.js::addInstanceIfNotExists`). Nova's form text names a table by its tag
  (`instance('<tag>')/…`), and a form's instance id is the tag (`xpath/wire/instances.ts::lookupInstance`);
  holding such a table needs an instance id that is not the tag and a text that says which `locations` is
  meant. HELD-NEW row N5, `project-data-at-hq-size`. `RESERVED_INSTANCE_TAGS` stands, and
  `reservedInstanceTagCause` changes only the `selected_cases` family's pattern (4.2).

### 9.5 `#row/<column>` in the SA's dialect

`bindings.ts::printReference` prints a column of the scoped table as `#row/<wireName>`. Every wire name
the grammar of 9.1 admits is one hashtag segment (`[A-Za-z0-9_-]+`, section 5.1), so the spelling stands
for every column and the printer needs no guard: `#row/facility-name` prints, and `bindings.reference`
resolves it as it resolves any name. `bindings.column` already matches a quoted wire name, id or label.
The segment grammar and the wire name grammar are held together by T19: every wire name
`lookupWireNameSchema` admits matches `HASHTAG_SEGMENT_SOURCE` whole.

## 10. Connect block ids

`lib/domain/forms.ts` from step 6:

```ts
/** The stored bound of a Connect id; `connectSlugs.ts` holds the exact rule. */
export const CONNECT_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const connectIdSchema = z.string().min(1).max(CONNECT_ID_MAX_LENGTH).regex(CONNECT_ID_PATTERN);
```

The exact rule is already `questionIdProblem(id, RESERVED_CONNECT_BLOCK_IDS)`
(`lib/commcare/connectSlugs.ts`), so the hyphen arrives with section 3 and the schema is widened to match
it; the schema keeps admitting the leading underscore it always has, so no stored block stops parsing. A
Connect block is a question in HQ's form builder and takes the same id rule (`util.js::isValidElementName`);
Connect reads the id from the block's `@id` and stores it as a slug
(`form_receiver/processor.py`, `opportunity/app_xml.py`, `opportunity/models.py`), and a slug holds
hyphens. Lifecycle: the Connect plugin is behind `toggle/COMMCARE_CONNECT`, the gate the entry already
carries. `CONNECT_ID_MAX_LENGTH` stays 50; the lengths each Connect column takes are part of row 36's
HELD-NEW class.

`connectSlugs.ts`'s minter still mints underscores (`toSnakeId` through `editorSafeQuestionId`).

No tool schema carries a pattern for a Connect id: `lib/agent/planningSchemas.ts::connectFormConfigShape`
types each block's `id` as a plain string described by `connectSlugs.ts::CONNECT_ID_FIELD_DESCRIPTION`,
which says "a letter first, then letters, digits or underscores". That description is what a model reads
on `configureConnect` and on `updateForm`'s `connect` patch, and it changes (Copy, C19).

## 11. The manifest

Every edit below is made with the matching row edit in
`docs/research/2026-09-26-hq-round-trip/inventory/<area>.md`: a re-worded row in place, a new row beside
the row it splits from. Entries below give `id`, `valueClass`, `disposition`, the `item` and
`dispositionCell` text, and its `subject` (a slug of part 01's `SUBJECTS`, on every HELD-NEW and REFUSED
entry) and, for a HELD-NEW entry, its `owner` (the two fields part 01 adds to the manifest's schema,
`01-the-bar-and-the-manifest.md`, sections 2.2 and 2.3, which exist before these entries). `surfaceKeys`,
`platforms`, `emission` and `gates` of a new entry are copied from the entry it splits from, with the
emission's `markers` unchanged, unless stated. Two things follow from the copy and are stated here. A
REFUSED entry has no platform reading, so N1's `platforms` is the one value
`schema.ts::refusedPlatformsSchema` admits, not row 24's: `kind: "none"`, and a `cell` that is the one
character that schema's `z.literal` holds (U+2014), which every REFUSED entry of the area carries; N1's
`emission.cell` is the same character with `markers: []`, as theirs is. And an entry that copies a gate
is one that gate governs: `surface/__tests__/gates.test.ts` holds each gate's `contentEntries` in
`entries/gates.json` to every entry naming it, in inventory order. Two new entries copy a gate, so N8
joins `toggle/CASE_SEARCH_ADVANCED`'s `contentEntries` directly after
`case-search/default-value-lifting-into-valueexpression`, and N15 joins `toggle/COMMCARE_CONNECT`'s
directly after `questions/connect-learn-module`. No other split-from entry names a gate.

### 11.1 Entries edited in place

| Entry | Edit |
|---|---|
| `questions/question-id-matching-xml-a-za-z-w` | `dispositionCell`: "**HELD**: `Field.id`; narrow: no leading underscore, no leading `XML`, and not `meta` in any case; a rename would move the submission path". `slotChanges`: the `narrow` change alone, its text ending at "…in any case; a rename would move the submission path" (the parenthesis about what Nova admits today is removed, since Nova no longer admits it). |
| `menus-and-case-lists/modulebase-case-type` | `valueClass`: `editor-grammar-other-than-a-reserved-word`. `item`: "`ModuleBase.case_type` matching `^[A-Za-z0-9_-]+$`". `dispositionCell`: "**HELD**: `Module.caseType`". `slotChanges`: `[]`. `emission.cell`: "`case_type`" (the sentence about defect 14 is removed; step 2 fixed it). |
| `forms-and-case-writes/update-keys-location-id-hq-user-id-category-state` | `valueClass`: `category-state-keys`. `item`: "update keys `category`, `state`". `dispositionCell`: "**HELD**: a case write's property". `slotChanges`: `[]`. |
| `forms-and-case-writes/update-key-whose-characters-after-the-ascii-first-are-all-core-s` | `valueClass`: `ascii-name-key`. `item`: "update key matching `^[A-Za-z][A-Za-z0-9_-]*$`, other than the keys the rows around this one name". `dispositionCell`: "**HELD**: a case write's property". `slotChanges`: `[]`. |
| `questions/savetocase-property-names-with-hyphens-a-z-w-case-insensitive` | `dispositionCell`: "**HELD**: `writes[].property`". `slotChanges`: `[]`. |
| `questions/multiple-choice-select1-item` | `dispositionCell`: "**HELD**: `single_select`, one option or more". `slotChanges`: `[]`. |
| `questions/checkbox-select-item` | `dispositionCell`: "**HELD**: `multi_select`, one option or more". Its `slotChanges` is `[]` today and stays so. |
| `questions/choice-value-containing-or` | `valueClass`: `one-kind-of-quote-mark`. `item`: "choice value containing `'`, `\"` or `` ` ``, and not both `'` and `\"`". `dispositionCell`: "**HELD**: option `value`". `slotChanges`: `[]`. |
| `case-search/name-prompt-key-case-property` | `valueClass`: `key-in-nova-name-grammar`. `item`: "`name` (prompt key) matching `^[A-Za-z_][A-Za-z0-9_-]*$`". `dispositionCell`: "**HELD**: `searchInputs[].name`". `slotChanges`: `[]`. |
| `expressions-and-data/tag-or-field-name-with-non-ascii-letters-or-starting-xml-in-any` | `valueClass`: `ascii-hyphen-or-uppercase-xml`. `item`: "`tag` or field name with `-`, or starting `xml` in any case other than all lowercase, over unaccented letters and holding no `.`". `dispositionCell`: "**HELD**: `LookupTable.tag`, a column's wire name, held verbatim". `slotChanges`: `[]`. `emission.cell`: "verbatim in the workbook, the fixture and every read". |
| `expressions-and-data/table-tag-in-nova-s-grammar` | `item`: "table `tag` matching `^[A-Za-z_][A-Za-z0-9_]*$`" (so the two HELD rows stay disjoint). |
| `questions/connect-learn-module` | `dispositionCell`: "**HELD**: `Form.connect.learn_module`; narrow (all four Connect blocks): no leading `_` or `XML` and not `meta` in any case, which Vellum refuses on every Connect block". `slotChanges`: the `narrow` change alone, its `text` "no leading `_` or `XML` and not `meta` in any case, which Vellum refuses on every Connect block" and its `scope` "all four Connect blocks" (the words "and Nova admits today (executed; defect 15)" are removed: `proof/fixed-defects.json` holds defect 15 as fixed, and Nova refuses those ids). |
| `questions/connect-deliver-unit` | `dispositionCell`: "**HELD**: `connect.deliver_unit`, with an empty `work_area_id`". `slotChanges`: `[]`. |
| `case-search/default-value-lifting-into-valueexpression` (row 18) | `item`: "`default_value` lifting into ValueExpression, on a prompt other than `daterange`" (so its class no longer covers what N8 claims). `dispositionCell`: "**HELD**: `searchInputs[].default`". `slotChanges`: `[]`. |
| `menus-and-case-lists/enum-mappingitem-alt-text-lang` (row 26) | gains `valueClass`: `blank`, so the pair with N11 is disjoint. `item`: "`enum[]` `MappingItem.alt_text{lang}`, blank". `dispositionCell`: the text before "; widen:". `slotChanges`: `[]`. |
| `questions/help-text-markdown-form` (row 43) | its widen stands inside a parenthesis, not after "; widen:". `dispositionCell`: "**HELD**: `Field.help`, markdown on (markdown off is `plainHelp`)", which is the cell as part 03 words it (`03-questions-and-text.md`, section 10) less its "(widen: on image, audio, video, signature and file questions and labels)". `slotChanges`: `[]`. |
| the twelve rows of 2.2 not named above: `menus-and-case-lists/child-menu-one-tier-root-module-id-a-parentless-module` (23), `menus-and-case-lists/detail-max-select-value-on-a-multi-select-basic-list` (25), `menus-and-case-lists/10-markdown-any-property-or-expression` (27), `menus-and-case-lists/21-translatable-enum-authored` (28), `menus-and-case-lists/parent-select-active-true-relationship-parent-module-id-a-non` (29), `questions/bind-required-true` (38), `questions/bind-required-expr` (39), `questions/bind-constraint` (40), `questions/setvalue-event-xforms-ready-default-on-a-question-outside` (41), `questions/hint-text` (42), `questions/help-media` (44), `questions/validation-message-text` (45) | `dispositionCell`: the text before "; widen:"; `slotChanges`: `[]`, the `widen` change being each one's only change. Row 25's cell gains ", at most 100". Rows 38 to 40 and 42 take the `valueClass` and `item` edits the paragraph under 11.2's table gives. Row 22 is the fourth row of this table, and rows 36 and 37 the two Connect rows. |

### 11.2 New entries

| Id | Beside | `valueClass` | Disposition | `item` | `dispositionCell` | `subject` | `owner` |
|---|---|---|---|---|---|---|---|
| N1 `menus-and-case-lists/case-type-outside-the-menu-page-s-grammar` | `…/modulebase-case-type` | `outside-editor-grammar` | REFUSED, reason `{ kind: "not-hq-editable", named: "app_manager.js::valueIncludeInvalidCharacters" }` | "`case_type` holding a character other than `A-Z`, `a-z`, `0-9`, `_` and `-`" | "**REFUSED**: not HQ-editable: the menu settings page marks the value an error (`app_manager.js::valueIncludeInvalidCharacters`), though the server's check admits any Unicode word character (`util.py::is_valid_case_type`)" | `case-types` | none (REFUSED) |
| N2 `forms-and-case-writes/update-keys-location-id-hq-user-id` | `…/update-keys-location-id-hq-user-id-category-state` | `location-id-hq-user-id-keys` | HELD-NEW | "update keys `location_id`, `hq_user_id`" | "**HELD-NEW**: a write CommCare HQ stores elsewhere: `location_id` becomes the case's own column and `hq_user_id` is copied to its external id (`update_strategy.py::_apply_update_action`)" | `case-property-names` | `forms-and-case-management` |
| N3 `case-search/prompt-key-outside-nova-s-name-grammar` | `…/name-prompt-key-case-property` | `key-outside-nova-name-grammar` | HELD-NEW | "`name` (prompt key) holding `/` (an ancestor path) or any other character outside `^[A-Za-z_][A-Za-z0-9_-]*$`" | "**HELD-NEW**: a Search field whose property and relation are read from its key" | `search-fields` | `case-search` |
| N4 `expressions-and-data/tag-or-field-name-with-non-ascii-letters` | `…/tag-or-field-name-with-non-ascii-letters-or-starting-xml-in-any` | `non-ascii-name` | HELD-NEW | "`tag` or field name with non-ASCII letters, every character one Core reads as a name character, or read by no expression" | "**HELD-NEW**: HQ's grammar over every XML name (`fixtures/utils.py::is_identifier_invalid`), which needs a name token proven on each runtime's Unicode tables; the row below refuses a name Core's XPath cannot read where an expression reads it" | `lookup-tables` | `project-data-at-hq-size` |
| N5 `expressions-and-data/tag-equal-to-an-instance-name-commcare-owns` | the same | `reserved-instance-name` | HELD-NEW | "`tag` equal to `commcaresession`, `locations`, `results`, `input`, `search_selected_cases` or a `selected_cases` instance name" | "**HELD-NEW**: a table whose instance id in a form differs from its tag, as the form builder makes it (`form.js::addInstanceIfNotExists`)" | `lookup-tables` | `project-data-at-hq-size` |
| N6 `questions/choice-value-holding-both-an-apostrophe-and-a-double-quote` | `…/choice-value-containing-or` | `both-quote-marks` | HELD-NEW | "choice value containing both `'` and `\"`" | "**HELD-NEW**: a value no XPath string literal spells, so a rule naming the choice has no form text" | `question-choices` | `xform` |
| N7 `forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character` | `…/update-key-whose-characters-after-the-ascii-first-are-all-core-s` | `non-ascii-core-name-key` | HELD-NEW | "update key whose characters after the ASCII first are all Core's name characters, at least one of them non-ASCII" | "**HELD-NEW**: the property grammar over what both HQ (`validate_property`) and Core read, which needs a name token proven on each runtime's Unicode tables" | `case-property-names` | `forms-and-case-management` |
| N8 `case-search/default-value-on-a-date-range-input` | row 18's | `default-on-date-range` | HELD-NEW | "`default_value` on a `daterange` prompt" | "**HELD-NEW**: a default on a date-range Search field, which HQ's editor offers and Core seeds (`RemoteQuerySessionManager.initUserAnswers`)" | `search-fields` | `case-search` |
| N9 `menus-and-case-lists/child-menu-of-another-case-type-under-a-parent-with-no-forms` | row 23's | `cross-type-child-of-a-formless-parent` | HELD-NEW | "child menu of another case type whose parent menu has no forms" | "**HELD-NEW**: HQ builds it (`entries.py::add_parent_datums`); Nova refuses it (`NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM`)" | `menu-structure` | `menus` |
| N10 `menus-and-case-lists/detail-max-select-value-above-100` | row 25's | `above-100` | HELD-NEW | "`Detail.max_select_value` above 100 on a multi-select basic list" | "**HELD-NEW**: `selection.maximum` above 100" | `case-list-setup` | `case-list-and-detail` |
| N11 `menus-and-case-lists/enum-mappingitem-alt-text-non-blank` | row 26's | `non-blank` | HELD-NEW | "`MappingItem.alt_text{lang}` holding text" | "**HELD-NEW**: `imageMap[].altText` and the clickable icon mapping's alt text" | `case-list-columns` | `case-list-and-detail` |
| N12 `menus-and-case-lists/10-markdown-outside-the-link-shape` | row 27's | `markdown-outside-link` | HELD-NEW | "10 `markdown` over a property or an expression other than the fixed `[text](value)` link" | "**HELD-NEW**: a `markdown` column kind" | `case-list-columns` | `case-list-and-detail` |
| N13 `menus-and-case-lists/21-translatable-enum-outside-nova-s-two-projections` | row 28's | `authored-translated-expression` | HELD-NEW | "21 `translatable-enum` other than a select property's label projection or an interval's text" | "**HELD-NEW**: the `translatedExpression` column kind" | `case-list-columns` | `case-list-and-detail` |
| N14 `menus-and-case-lists/parent-select-naming-a-module-outside-the-declared-parent-type` | row 29's | `parent-outside-declared-type` | HELD-NEW | "`parent_select` naming a module of a case type other than the child's declared parent, or of an extension's host" | "**HELD-NEW**: a parent menu of any other case type HQ offers (`views/modules.py::get_modules_with_parent_case_type`)" | `parent-selection` | `menus` |
| N15 `questions/connect-blocks-beyond-one-of-each-kind` | `…/connect-learn-module` | `beyond-one-of-each-kind` | HELD-NEW | "a Connect block with an id over 50 characters, a display condition, a blank entity expression or a `time_estimate` of 0; several blocks of one kind in a form; a block inside a group or a repeat" | "**HELD-NEW**: Connect blocks as questions at authored positions" | `connect-blocks` | `xform` |
| N16 `questions/connect-deliver-unit-work-area-id-expression` | `…/connect-deliver-unit` | `work-area-id-expression` | HELD-NEW | "Connect Deliver Unit with a `work_area_id` expression" | "**HELD-NEW**: a `work_area_id` expression" | `connect-blocks` | `xform` |
| N17 `questions/bind-required-on-a-label` | rows 38 and 39's | `on-a-label` | HELD-NEW | "bind `required` on a label" | "**HELD-NEW**: the acknowledge label's required" | `question-logic` | `xform` |
| N18 `questions/bind-constraint-on-a-capture-question-or-a-label` | row 40's | `on-capture-or-label` | HELD-NEW | "bind `constraint` on a geopoint, image, audio, video, signature or file question or a label" | "**HELD-NEW**: `Field.validate` on those kinds" | `question-logic` | `xform` |
| N19 `questions/default-on-a-capture-question-or-a-label` | row 41's | `on-capture-or-label` | HELD-NEW | "a default on an image, audio, video, signature or file question or a label" | "**HELD-NEW**: `Field.default_value` on those kinds" | `question-logic` | `xform` |
| N20 `questions/hint-text-on-a-label` | row 42's | `on-a-label` | HELD-NEW | "hint text on a label" | "**HELD-NEW**: `Field.hint` on a label" | `question-text` | `xform` |
| N21 `questions/help-text-on-a-capture-question-or-a-label` | row 43's | `on-capture-or-label` | HELD-NEW | "help text on an image, audio, video, signature or file question or a label" | "**HELD-NEW**: `Field.help` on those kinds" | `question-text` | `xform` |
| N22 `questions/help-media-on-a-capture-question-or-a-label` | row 44's | `on-capture-or-label` | HELD-NEW | "help media on an image, audio, video, signature or file question or a label" | "**HELD-NEW**: `Field.help_media` on those kinds" | `question-media` | `xform` |
| N23 `questions/validation-message-on-a-capture-question-or-a-label` | row 45's | `on-capture-or-label` | HELD-NEW | "validation message text on a geopoint, image, audio, video, signature or file question or a label" | "**HELD-NEW**: a validation message on those kinds" | `question-text` | `xform` |
| N24 `expressions-and-data/tag-or-field-name-holding-a-period` | `…/tag-or-field-name-with-non-ascii-letters-or-starting-xml-in-any` | `holding-a-period` | HELD-NEW | "`tag` or field name holding `.`, over unaccented letters" | "**HELD-NEW**: a name HQ's table page accepts and Core reads, which HQ's build rewrites or refuses where a filter, a display condition or a required condition reads it: an unquoted `.` there is the current case (`xpath.py::dot_interpolate`)" | `lookup-tables` | `project-data-at-hq-size` |

Where a split-from entry had no `valueClass`, it gains one so the pair is disjoint:
`questions/bind-constraint` takes `on-kinds-nova-validates`, `questions/hint-text` takes `off-a-label`,
and `menus-and-case-lists/enum-mappingitem-alt-text-lang` takes `blank` (11.1). Rows 38 and 39 keep
the classes `true` and `expression`, and each `item` gains the words that leave a label to N17: "bind
`required="true()"` on a question other than a label" and "bind `required="<expr>"` on a question
other than a label". Row 18's class keeps its slug and its `item` is re-worded to leave the date-range
prompt to N8 (11.1).

**Subjects and their sentences.** Every subject above is a slug of part 01's closed set
(`lib/publish/hqFindings.ts::SUBJECTS`; part 01 (`01-the-bar-and-the-manifest.md`), section 2.2), and
`case-types` is in that set for N1 alone. The sentence a person reads for each entry is its subject's,
in `lib/publish/hqFindingCopy.ts` as part 01's section 9.2 words it: the whole sentence of `case-types`
at the standing `fix-in-hq` with the cause `hq-refuses`, and the `not-yet` sentence of each HELD-NEW
entry's subject. This part writes no finding copy. The test that holds one sentence to every subject
and standing an entry uses (`lib/publish/__tests__/hqFindingCopy.test.ts`, part 01, section 10) is what
fails where an entry here takes a pair with no sentence. Part 01's Appendix A lists these twenty-four
entries with their subjects and owners.

### 11.3 The lane's value-class readers

`proof/checks/manifest_value_classes.py::VALUE_CLASSES` gains one reader, for N1, the one REFUSED class
this part adds: a `schema:Module.case_type` or `schema:AdvancedModule.case_type` value that is not empty
and does not fully match `[A-Za-z0-9_-]+`. Nova's exports can never use it, since the gate holds the same
pattern. `proof/checks/test_manifest_value_classes.py` holds every reader of the registry to a refused
shape and an accepted one (`SHAPES`, and its test that the two sets of keys are equal), so N1's pair
joins it with the reader: refused, a module whose `case_type` is `visit.note` and one whose
`case_type` is `visité`; accepted, `1st-visit` and `case`. This part adds no reader for a HELD-NEW
class. Part 14 (`14-proof.md`), section 8.2, holds one for seven of them, each a class one value
decides with no other place read: N2, N3, N6, N7, N8, N10 and N11, by the ids and classes of 11.2. The
other sixteen HELD-NEW entries get no Python reader and are held by their variants (part 14, section
7.2) and the reader's own tests.

### 11.4 `widen` leaves the schema

`lib/commcare/surface/schema.ts`:

```ts
/**
 * A limit a HELD row sets on the grammar of the Nova slot that holds it:
 * `text` is the limit as the row words it. A HELD row never states a grammar
 * Nova does not hold; a wider class has an entry of its own.
 */
export const slotChangeSchema = z.strictObject({
	direction: z.literal("narrow"),
	text: z.string().min(1),
	scope: z.string().min(1).optional(),
});
```

and the comment above `inventoryEntryHead` says "a HELD entry's slot changes are the `narrow` changes its
Disposition cell names". The manifest parses under this schema only once no entry carries a widen: the
twenty-seven rows 11.1 edits, and the eighteen of 2.4. So the three pieces of work that remove those
eighteen exist before this change to the schema: the re-cut of the `xmlns` row (part 01, section 3.3),
the kept flips of the settings rows (part 01, section 3.6) and registration from the case list (part
02, section 14). Any entry still carrying a widen fails `manifest.test.ts`, naming it.

## 12. Proof documents

Eight targeted documents, each built by Nova's planners and admitted by the gate
(`proof/targeted/build.ts`), under `proof/targeted/documents/`, registered in
`proof/targeted/index.ts`. Each form echoes what the worker answers (`documents/echo.ts`), so proof 3
holds values, and each is declared for both platforms unless stated. Three carry an edit, D′, so proof
5 runs over them and R2's dispatch names an edited document.

| Document (file) | Holds | What it would catch |
|---|---|---|
| `targeted-hyphenated-question-ids` (`hyphenatedQuestionIds.ts`) | a registration and a follow-up of case type `client`. Questions `first-name`, `copy-1-of-age`, `a-`; a group `a` holding `b-c` beside a group `a-b` holding `c`, each labelled differently in two languages; a select `mood` beside a text question `mood-opt0`; a count repeat `visit-rows` whose count is an expression; a query repeat `kin` beside a question `kin-query`; `first-name` as the case's name; a validation on `copy-1-of-age` that counts another question's rows; a calculate `#form/copy-1-of-age - 1`; a default that reads `current()/../first-name`; a label that shows `first-name`. Its edit renames `first-name` to `given-name` and the group `a-b` to `a-b2` | a shared itext id (two labels equal on a reader); a generated node HQ's form builder renames; a minus read into a name; Preview's wrapper colliding with `kin-query`; a rename of a hyphenated path that leaves a reader behind (proof 5) |
| `targeted-case-type-names` (`caseTypeNames.ts`) | menus of the types `case` (parent) and `1st-visit` (its child), `parent`, `-flagged` and `2024`; a follow-up on `1st-visit` that reads `#record/case/region` and its own `#1st-visit/outcome`; a child create of `1st-visit` from a `case` form; a case list on each; one after-submit link from the `case` registration to the `1st-visit` menu, which makes that create an advanced open action; in the `parent` follow-up, an extension create of the type `2024` and one of the type `-flagged`, each of which takes a Save to Case block named by its minted id (`case_2024`, `case__flagged`) | a datum id, tag or minted operation id that some reader cannot take; a reference that binds another record; a load entry HQ's summary reads as a worker's; a Save to Case block HQ's form builder refuses or warns about on its two saves |
| `targeted-choice-values` (`choiceValues.ts`) | a single select with one choice; a multi-select with one choice; a single select with the values `it's`, `say"hi"`, `` back`tick `` and `plain`; a multi-select with `o'clock` and `half"past`; a relevant on each quoted value; a starting value `"it's"`; saves of both to select properties; a case list with a plain column over each property; a label showing `jr:choice-name` of the single select | a literal no reader parses; a label projection keyed by a value; an answer token split or altered |
| `targeted-lookup-names` (`lookupNames.ts`) | a Project table tagged `health-facility-v2` with columns `facility-name`, `XMLcode` and `geo-lat`; a select whose choices come from it; a calculate that reads `geo-lat` by a filter on `XMLcode`; a calculated case list column reading it through `lookup(…)`; a case list filter that compares the case's `facility` with a `facility-name` the table holds (HQ interpolates it with a case); a display condition on a follow-up form that reads the table (interpolated with a case) and one on a survey form in a menu with no case type (interpolated with none) | HQ's upload, its restore or Core refusing or altering a name; a read that finds no row; HQ's build rewriting or refusing a hyphenated step in a filter or a display condition |
| `targeted-search-field-names` (`searchFieldNames.ts`) | a menu with Search whose fields are named `first-name` and `dob_from`, a filter reading `#search/first-name`, forms that read the search, and a registration that starts from `#search/first-name` | HQ's search view or Core's query screen binding the key wrongly |
| `targeted-case-write-names` (`caseWriteNames.ts`) | a registration and a follow-up saving `state`, `category`, `first-name` and `visit-count`, the last two also from a Save to Case update of a parent case; the follow-up opens on each saved value; a case list column over each | HQ's case processing and Core disagreeing on a saved value; the form builder altering a hyphenated row |
| `targeted-connect-deliver-hyphen-ids` (`connectApps.ts`, its deliver builder called with other ids) | a deliver app, Android only: the unit `home-visit` in its first form and the task `follow-up` in a form of its own, as `targeted-connect-deliver-rename` holds them. Its edit renames them `household-visit` and `return-visit` | HQ's build or the form builder's two saves changing a Connect block whose id holds a hyphen; a renamed hyphenated id left behind (proof 5) |
| `targeted-connect-learn-hyphen-ids` (`connectApps.ts`, its learn builder) | a learn app, Android only: the module `intro-module` and the assessment `intro-check` in one form. Its edit renames them `intro-module-2` and `intro-check-2` | the same, for the two learn blocks |

A Connect app is a learn app or a deliver app (`lib/domain/blueprint.ts`, the `connectType` check), so the
four block kinds take two documents, and both are Android only, as every Connect app is
(`connectApps.ts`, its header). The Connect proof reads the documents its own tuple names
(`proof/connect/conftest.py::DOCUMENTS`), built around the ids of the two rename documents, so these two
are not added to it. What Connect's receiver makes of a hyphenated id is shown where that proof already
shows what it makes of a name: `conftest.py::ACCEPTED_NAMES` gains `deliver-home-visit` and
`task-follow-up` under its deliver app and `module-intro-module` and `assessment-intro-check` under its
learn app, each a hand-written form in a fork of the published app, which
`test_receiver.py::test_the_names_beside_connects_keys_are_received` posts to Connect's own receiver and
holds to an approved delivery, a completed task, a completed module and a scored assessment. That test
is a reader's and runs in the nightly lanes and in R2's slice.

`proof/README.md` gains each under "Targeted documents", as one paragraph after the sentence about
`targeted-shared-property-sort`, in these eight sentences:

> `targeted-hyphenated-question-ids` holds question ids with hyphens (`first-name`, `copy-1-of-age`,
> `a-`), two groups whose paths differ only in where a hyphen falls, a question beside each generated
> name a hyphen could collide with, and an edit that renames two of them.
> `targeted-case-type-names` holds menus of the case types `case`, `parent`, `1st-visit`, `-flagged`
> and `2024`, a read of the type `case` written `#record/case/region`, and a Save to Case block named
> by each id Nova mints for a type that is no question ID as it stands.
> `targeted-choice-values` holds a single select and a multi-select with one choice each, and choice
> values holding an apostrophe, a double quote and a backtick, each compared in a display condition,
> saved to a case and shown in a case list column.
> `targeted-lookup-names` holds a table whose tag and column names hold hyphens and one column name
> that starts `XML`, read by a select, a calculation, a calculated column, a case list filter and two
> display conditions, the three slots CommCare HQ's build rewrites as text among them.
> `targeted-search-field-names` holds a Search field named `first-name`, read by a filter and by the
> forms the search opens.
> `targeted-case-write-names` holds saves to `state`, `category` and two hyphenated properties, from a
> form's own case and from a Save to Case update of a parent, each read back by a follow-up form and a
> case list column.
> `targeted-connect-deliver-hyphen-ids` holds a deliver unit and a task whose ids hold hyphens, on
> Android only, with an edit that renames both.
> `targeted-connect-learn-hyphen-ids` holds a learn module and an assessment whose ids hold hyphens,
> on Android only, with an edit that renames both.

Its two sentences about `targeted-invalid-question-ids` and `targeted-invalid-connect-ids` stay true:
the ids those hold are still refused (a leading underscore, `XML`, `meta`), and neither holds a hyphen.

The apps made in CommCare HQ that exhibit each grammar from HQ's side are part 14's (`14-proof.md`).
Its section 6.2 holds the bases, among them `hq-names`, `hq-lookups`, `hq-new-app` (whose new menu takes
the case type HQ gives it, `case`), `hq-connect-deliver` and `hq-connect-learn`, and its section 7.2
gives each entry N1 to N24 a variant on the base of the entry's area, whose row names 11.2's id and
standing.

## 13. The agent surface

**Served schemas that move.** The tools the Solutions Architect is given whose served input schema or
description this part changes, each already registered in `scripts/test-schema.ts::SCHEMA_TESTS`, with
what moves in each:

| Tools | What moves |
|---|---|
| `addFields`, `editField`, `setFieldOptionsSource` | the option value's pattern, the inline source's `minItems` of one, and the case type's pattern in the `cases` source (`toolSchemaGenerator.ts::projectedOptionsSourceSchema`); on `setFieldOptionsSource`, its `source` description too (C13) |
| `generateSchema`, `updateCaseProperty` | the option value's pattern, through `planningSchemas.ts::casePropertyInputSchema` (`tools/caseProperties.ts` builds its input from that schema's shape) |
| `addCaseOperations`, `updateCaseOperation` | the case type's and the written property's patterns (`case-operations/shared.ts`) |
| `addSearchInputs`, `updateSearchInput`, `configureCaseList` | the Search field name's pattern (`case-list-config/shared.ts::searchInputDefInputSchema` and `searchInputUpdateInputSchema`; `configureCaseList` takes `searchInputs`) |
| `createLookupTable`, `updateLookupTable`, `editLookupColumns` | the tag's and the wire name's patterns |
| `configureConnect`, `updateForm` | a description alone: `CONNECT_ID_FIELD_DESCRIPTION` (C19), on each block's `id` of `connectFormConfigSchema` and `connectFormPatchSchema`. Neither carries a pattern for the id |

What does not move, and why. `createForm` and `createModule` hold no field or option schema and take
`case_type` as a plain string, as `updateModule` does. No tool moves for the case type's pattern inside
an expression: the authoring projection puts each expression position's authored string schema in place
before Zod walks the input (`lib/agent/authoring/schema.ts::authoringJsonSchema`), so a change to
`caseTypeNameSchema` in the `Expression` union changes no served byte. A refinement is no keyword of a
JSON Schema, so the both-quotes rule sends the provider nothing. `SELECT_OPTION_VALUE_DESCRIPTION` and
`FIELD_DOCS.id` keep teaching the lowercase underscore slug, the shape Nova mints.

**What the billed check proves here.** The step's one billed schema check (the top-level file
`../6-bring-in.md`, "What needs your yes before this starts") sends each tool the top-level file's two
free comparisons name (its served input schema or its description moved), the table's among them, and
its answer is the only proof that the provider accepts each new pattern, the inline source's
`minItems` of one and the two descriptions as a tool definition. What needs no
provider is held in CI: T24 compiles every served pattern under the providers' regex engine, and T28
holds that no served schema keeps a retired pattern or minimum, on any tool, in the table or not.

**The guide** (`lib/agent/authoring/reference.ts`, the `expressions` entry). After "Read the form's
recordContext for the available types." the entry gains: "A record type named form, user, search, case,
record or row is written #record/<record-type>/<property>, as in #record/case/region; that spelling
reads any type." No other guide sentence states a grammar this part changes.

**Versions.** The table's schemas, the two descriptions (C13, C19) and the guide sentence are what of
this part a model is served, so they are among the changes the step's one move of
`lib/models.ts::MODEL_CONTEXT_VERSION` covers (the top-level file states the move). The rename of 3.4
is this part's reason for the step's one move of `RUNTIME_VERSION`.

**The plugin.** `../nova-plugin` states none of these grammars (its one hyphen sentence is a project
space's slug), so the plugin's pull request carries nothing for this part.

---

## Copy

Every string this part adds or changes. Unchanged strings are not listed.

| # | Where | String |
|---|---|---|
| C1 | `questionId.ts::questionIdProblemSentence`, `characters` | `${subject} holds only letters, digits, underscores and hyphens. ${free}` |
| C2 | `identifierVerdicts.ts::caseTypeNameVerdict`, `illegal_format` | `A case type holds only letters, digits, underscores and hyphens.` |
| C3 | `rules/module.ts`, `INVALID_CASE_TYPE_FORMAT` | `Module "${mod.name}" has case_type "${mod.caseType}", which holds a character a case type can't. A case type holds only letters, digits, underscores and hyphens (for example "patient", "home_visit" or "1st-visit").` |
| C4 | `userFacingErrors.ts`, `INVALID_CASE_TYPE_FORMAT` | `` `${q(modName(e))}'s case type ${q(det(e, "caseType", ""))} holds a character a case type can't. Letters, numbers, underscores and hyphens all work.` `` |
| C5 | `rules/caseOperations.ts`, the case type finding; `case-operations/shared.ts::CASE_TYPE_FORMAT_MESSAGE` | `Case type "${caseType}" holds only letters, digits, underscores, or hyphens, and is at most ${MAX_CASE_TYPE_LENGTH} characters.` and `A case type holds only letters, digits, underscores, or hyphens.` |
| C6 | `advancedTags.ts`, the thrown invariant | `Nova was asked for the case tag of an advanced action on the case type "${caseType}", which is not a case type CommCare accepts: a case type holds only letters, digits, "-" and "_". The app's case types are checked before it is emitted, so this one should not have reached the tags.` |
| C7 | `expressionAst.ts`, `unknown-hashtag` | `A record reference names one property: #<record-type>/<property>, or #record/<record-type>/<property>, which reads any record type. A worker's detail is #user/<property>.` |
| C8 | `expressionAst.ts`, `unknown-hashtag` for `row` | `#row reads the record or the table row a filter is testing, so it has nothing to read in this formula. A record's value is #<record-type>/<property>, and a record type called row is #record/row/<property>.` |
| C9 | `expressionAst.ts`, `case-alias-unbound` | `This formula has no selected record for #case to read. You can name the record type, as in #<record-type>/<property>. A record type called case is #record/case/<property>.` |
| C10 | `selectOptionValue.ts::SELECT_OPTION_VALUE_REJECTION` | `A choice value is the stored answer token, not the wording: it cannot hold spaces and cannot be empty. A lowercase slug with words joined by underscores (prefer_not_to_say) keeps it easy to read, with the wording in the label.` |
| C11 | `selectOptionValue.ts::SELECT_OPTION_VALUE_BOTH_QUOTES` (new), and the gate's `SELECT_OPTION_VALUE_INVALID` and `CASE_PROPERTY_OPTION_VALUE_INVALID` detail for `both-quotes` | `Nova can't yet write a rule that names a choice holding both an apostrophe and a double quote. Keeping one kind of quote mark, or neither, works.` |
| C12 | `userFacingErrors.ts`, `SELECT_OPTION_VALUE_INVALID` and its catalog twin; `optionValueProblemPhrase` for `both-quotes` | `` `A choice on ${q(fieldName(e))} in ${q(formName(e))} ${optionValueProblemPhrase(e)}. A choice's value is the answer the app saves, so it can't hold spaces, can't hold both an apostrophe and a double quote, and can't be empty. ${q(det(e, "suggestedValue", "a_value_like_this"))} would work, with the wording kept in the label.` ``; phrase: `holds both an apostrophe and a double quote` |
| C13 | `setFieldOptionsSource.ts`, the `source` description | `The complete replacement choice source. Use kind inline with at least one option, kind lookup with the table and its value/label columns, or kind cases with caseType, labelProperty (default case_name), and an optional filter. Replacing one kind discards the previous source.` |
| C14 | `modules.ts::searchInputBase.name` | `A Search field's name starts with a letter or an underscore, then holds only letters, digits, underscores and hyphens. CommCare sends the field's answer under this name, and a rule reads it back by it.` |
| C15 | `lookup/schema.ts::wireIdentifierSchema`, the pattern | `` `${label} starts with a letter or an underscore, then holds only unaccented letters, digits, underscores and hyphens.` `` |
| C16 | `lookup/schema.ts::wireIdentifierSchema`, the prefix | `` `${label} can't start with lowercase "xml", which CommCare HQ keeps for itself. A capital first letter works.` `` |
| C17 | `caseOperationIdentifiers.ts::CASE_OPERATION_PROPERTY_FORMAT_MESSAGE` | `Start with a letter; use only letters, digits, underscores, or hyphens.` |
| C18 | `formPath.ts`, `FormPath.child` and `FormPath.attr` (a developer reads these; `FormPath.parse`'s message prints the pattern itself and needs no edit) | `` `FormPath.child got invalid element name "${name}". XForm element names must match ${XML_ELEMENT_NAME_REGEX} (letter or underscore, then letters / digits / underscores / hyphens).` `` and `` `FormPath.attr got invalid attribute name "${name}". XForm attribute names must match ${XML_ELEMENT_NAME_REGEX} (letter or underscore, then letters / digits / underscores / hyphens).` `` |
| C19 | `connectSlugs.ts::CONNECT_ID_FIELD_DESCRIPTION` (today's text with "digits or underscores" become "digits, underscores or hyphens") | `` `Leave unset. Nova derives a valid unique id from the name. Set only to pin one: a letter first, then letters, digits, underscores or hyphens, not starting with XML, at most ${CONNECT_SLUG_MAX_LENGTH} characters, unique in the app, and none of assessment, deliver, module, task, work_area_update, meta, case, registration, script, instance, bind, parsererror. CommCare Connect keys its records by these ids, so change one only when the person asks, and publish that change after an opportunity manager has added the new deliver unit to a payment unit.` `` |
| C20 | `userFacingErrors.ts`, the fallback of `INVALID_FIELD_ID` and of `CONNECT_ID_INVALID_FORMAT` | `` `${q(fieldName(e))} in ${q(formName(e))} has an ID that won't work. Letters, numbers, underscores and hyphens all work, with a letter first.` `` and `` `The Connect ID ${q(id)} in ${q(formName(e))} won't work. Letters, numbers, underscores and hyphens all work, with a letter first.` `` |
| C21 | `CreateTableDialog.tsx`, the tag's description; `AddColumnDialog.tsx`, the column name's | `Letters, digits, underscores and hyphens, with a letter or an underscore first. Changing it later needs admin access.` and `Letters, digits, underscores and hyphens, with a letter or an underscore first. This is the heading a CSV import must use.` |
| C22 | `caseTypePickerModel.ts::creationErrorMessage`, `illegal_format` | `Letters, numbers and underscores all work in a case type name` (no closing period, as its sibling lines) |
| C23 | the option editor's refusal beside the value box (`optionsDraftModel.ts`), where the question and the form are already on screen | `This value holds both an apostrophe and a double quote. Keeping one kind works.` |

The sentence a reading shows for each manifest entry of 11.2 is part 01's (`lib/publish/hqFindingCopy.ts`,
its section 9.2) and is not repeated here.

Removed: the `SELECT_TOO_FEW_OPTIONS` sentences in `rules/field.ts` and `userFacingErrors.ts`; the
`RESERVED_CASE_TYPE_NAME` sentences in `rules/app.ts` and `userFacingErrors.ts`;
`caseTypeNameVerdict`'s `reserved` line; `caseTypePickerModel.ts`'s `reserved` line ("Choose a more
specific name, such as … record"); `case-operations/shared.ts`'s "must start with a letter".

## Tests

Vitest unless marked. Each names its boundary and the failure it would catch. No DOM test. A file marked
extended, rewritten or existing is in the tree at `1f103305`; every other file is new.

| # | File | Boundary | Holds | Catches |
|---|---|---|---|---|
| T1 | `lib/domain/__tests__/questionId.test.ts` (extended) | the production functions | `questionIdProblem` admits `first-name`, `a-`, `copy-1-of-x`; refuses `-a`, `_a`, `XMLa`, `a b`, `a.b`; `editorSafeQuestionId` of each refused spelling passes `questionIdProblem` (property test over arbitrary strings) | a normalizer that mints an id the grammar refuses |
| T2 | `lib/commcare/xform/__tests__/itextIds.test.ts` | `formStructure` over a built document | over generated forms whose ids hold hyphens, `formItextUnits` has one entry per declared unit (no key overwritten); a form with no hyphen has exactly today's ids (a fixed list) | two fields sharing an itext id; an id of an existing form moving |
| T3 | `lib/commcare/xform/__tests__/builder.hyphenatedIds.test.ts` | `buildXFormSource` then `validateXForm` and the binding oracle | the source of `targeted-hyphenated-question-ids` passes both oracles; every bind's nodeset, every `vellum:nodeset` and every itext reference resolves | a path or shadow the emitter writes wrongly for a hyphen |
| T4 | `lib/commcare/__tests__/generatedNodes.hyphen.test.ts` | `planGeneratedNodes` | an authored sibling named as a generated base of a hyphenated owner (`nova_trimmed_first-name`) makes the allocator take `_1`; names within one namespace are distinct | a generated name colliding with an authored one |
| T5 | `lib/commcare/xpath/__tests__/hashtagMatchers.divergence.test.ts` (extended corpus) | the generated parser and the regex built from `HASHTAG_SEGMENT_SOURCE` | both agree on the extent of `#1st-visit/age`, `#record/-flagged/age`, `#form/a/2`, `#2024/x + 1`, `#form/age - 1`, `# form/x` and a hashtag ending a sentence | the editor chipping a span the parser does not store |
| T6 | `lib/commcare/xpath/__tests__/recordReference.test.ts` | `parseFormExpressionForSlot` and the domain printer over a real slot | for case types `case`, `form`, `user`, `search`, `record`, `row`, `parent`, `1st-visit`, `-flagged`: print then parse gives the same tree; `#record/<type>/<p>` parses for every type; `#case/<p>` in the builder's scope refuses with C9 and in the authoring scope reads the selected type | a type whose reads cannot be shown or typed back |
| T7 | `lib/agent/authoring/__tests__/recordReference.test.ts` | the shared tool call body over a built document: `getForm`'s read projection, then the same text sent back through `editField` and `updateForm` | for a form whose selected type is `visit` and whose ancestor types are `case`, `form`, `user` and `row`: `formRecordContext` gives each ancestor a `propertyReference` that, sent back in a calculation, stores a `form-case` term of that ancestor; a label holding a `case-ref` of the type `form` reads as `{{#record/form/region}}` and stores the same part when sent back; the same round trip through the record dialect; `#row/facility-name` prints and reads as the table's column | the SA shown a spelling it cannot send back, or one that binds another record |
| T8 | `lib/domain/__tests__/hashtagSegments.test.ts` | the three new functions | `caseReferenceText` and `readCaseReference` are inverse over every case type the grammar admits and every property (property test); `caseReferenceText(t, p)` starts with `caseReferencePrefix(t)` | a printer and parser disagreeing |
| T9 | `lib/doc/__tests__/identifierVerdicts.test.ts` (extended) | the verdicts against the gate | `fieldIdVerdict`, `caseTypeNameVerdict` and `caseOperationWritePropertyVerdict` return `ok` exactly where a candidate document holding the name passes `mutationCommitVerdict` | "rejected here, accepted there" between a verdict and the gate |
| T10 | `lib/commcare/validator/__tests__/caseTypeNames.test.ts` | the absolute gate over built documents | documents whose types are `case`, `parent`, `2024`, `-x` pass; `a b`, `ñ`, an empty type and a 256-character type are refused with their codes | a reservation or pattern left behind in one rule |
| T11 | `lib/commcare/__tests__/caseTypeWire.test.ts` | `expandDoc` and `compileLocalArchive`, read by the suite and HQ JSON oracles | for `targeted-case-type-names`: every datum id and advanced tag is one name; every minted operation id passes `questionIdProblem` (`case_1st_visit`, `case_case`, `case__flagged`, `case_2024`), and each Save to Case block is named by it; both oracles pass | a block HQ's form builder refuses or warns about |
| T12 | `lib/domain/__tests__/selectOptionValue.test.ts` (extended) | the production functions | `selectOptionValueProblem` over `it's`, `a"b`, `` a`b ``, `a'b"c`, `a b`, `""`; `sanitizeSelectOptionValue` keeps quote marks | the editor silently changing a typed value |
| T13 | `lib/commcare/__tests__/choiceValueWire.test.ts` | `buildXFormSource`, the suite and HQ JSON emitters, each read by its oracle and by `parser.parse` | every literal that spells a quoted value parses as one string literal equal to the value; the plain column's enum keys are placeholders | a value reaching text outside a literal |
| T14 | `lib/preview/engine/__tests__/choiceValues.test.ts` | the Preview engine over `targeted-choice-values` | choosing `it's` makes its relevant true; the multi-select's answer holds both tokens; a one-choice select accepts and clears its answer | Preview and the device disagreeing on a quoted token |
| T15 | `lib/doc/__tests__/selectOptionCount.test.ts` | `mutationSchema`, the reducer and the gate | `removeOption` to one option commits; to none is refused `SELECT_NO_OPTIONS`; a `convertField` seeded with one option commits | a one-option state some path still refuses |
| T16 | `lib/domain/__tests__/caseWriteProperties.test.ts` | the gate over built documents | a write to `first-name`, `state` or `category` passes; to `location_id` or `hq_user_id` is refused; the emitted Save to Case row and the local basic block name the leaf | a forbidden name left in one set; a leaf `FormPath` refuses |
| T17 | `lib/case-store/__tests__/hyphenatedProperty.postgres.test.ts` | real Postgres through the store's submission path | a submission that saves `first-name`, `state` and a choice value `it's` stores them, and a case list filtered on each returns the row | a name or value the SQL compiler mishandles |
| T18 | `lib/case-store/migrations/__tests__/lookupNames.postgres.test.ts` | the production migration chain | inserts of tags `health-facility-v2`, `XMLcodes`, `a-b_c` and wire names `geo-lat`, `XMLcode` succeed; `health-facility.v2`, `geo.lat`, `xmlcodes`, `1a`, `-a`, `a b`, `ñ` and a 33-character tag fail with SQLSTATE 23514; exactly one check constraint remains on each column; `down` restores the old refusals; a namespace `nova_create_app_test_namespace` makes after the migration takes the tag `health-facility-v2`; the lock wait: with a second connection holding `ACCESS SHARE` on `lookup_columns` in an open transaction, `up`, run in one transaction as the migrator runs it, is refused with SQLSTATE `55P03` after five seconds and before ten, the rolled-back transaction leaves both columns the checks they had, and once the second connection's transaction ends `up` succeeds; after `up`, `SHOW lock_timeout` in the same transaction answers `0`. The second connection is released in a `finally` | a check the migration missed or doubled; a new App Test namespace left with the old check; a lock request that waits with no bound behind a reader of the serving revision; a timeout left set for the next migration of the batch |
| T19 | `lib/lookup/__tests__/schema.test.ts` (extended) | `lookupTagSchema`, `lookupWireNameSchema` | the same accept and refuse lists as T18, so the schema and the database agree; every wire name the schema admits matches `HASHTAG_SEGMENT_SOURCE` whole (property test), so `#row/<wireName>` is always one reference | a name one layer takes and the other refuses; a column the SA's dialect cannot name |
| T20 | `lib/commcare/lookup/__tests__/names.test.ts` | `fixtures.ts`, `workbook.ts`, a form read, and the HQ JSON's case list filter and `form_filter` for a case form and a survey form, parsed back with `parseXml` and `parser.parse` | the fixture's elements, the workbook's headers and sheet name and each printed read hold the names verbatim; each HQ JSON string is one HQ's build leaves alone: a port of `xpath.py::dot_interpolate`'s character walk (quote state, the digit test on each side), run with an empty replacement, returns the string unchanged, which is the test `_ensure_no_case_references` itself makes | an element or step altered or refused; a read HQ's build would rewrite |
| T21 | `lib/domain/__tests__/searchInputName.test.ts` and `lib/commcare/suite/case-search/__tests__/hyphenatedName.test.ts` | the schema, then the prompt, query and locale emitters read by the suite oracle | `first-name` is a name; the prompt's key, the `field[@name=…]` read and the locale id hold it | a key and its read disagreeing |
| T22 | `lib/commcare/__tests__/connectSlugs.test.ts` (extended) | the verdict and `connectIdSchema` | `intro-module` passes both; the five reserved names and a leading underscore are refused by the verdict | the schema and the verdict disagreeing on a hyphen |
| T23 | `lib/commcare/surface/__tests__/manifest.test.ts`, `gates.test.ts` (existing), and the lane's `proof/checks/test_manifest_value_classes.py` | the entries against the schema, the gates against the entries, the value-class readers against their shapes | every entry parses under `direction: "narrow"` and with a `subject` of `SUBJECTS`; no two entries claim one key at one class; each gate's `contentEntries` holds N8 and N15 in inventory order; N1's reader takes its refused shapes and leaves its accepted ones | a widen left on a row; a gate that does not govern a new entry; an overlapping pair |
| T24 | `lib/mcp/__tests__/servedSchemas.test.ts` (existing; it compiles every served pattern under Ajv and the Rust regex engine and holds no expected value) | what an MCP client receives | every new pattern compiles under the providers' engine, with no edit to the test | a pattern a provider refuses |
| T25 | `e2e/tests/app/names.spec.ts` (Playwright smoke) | the builder in a browser | renaming a question to `first-name` saves and its chip resolves; typing `it's` as a choice value keeps the apostrophe; removing choices stops at one; typing "1st visit" in the case type picker creates `1st_visit`, which the earlier rule refused | an input that still filters or refuses |
| T26 | `lib/commcare/__tests__/caseLoadMetadata.test.ts` (rewritten over the typed signature) | `hqLoadReference`, then `buildCaseReferencesLoad` through `expandDoc` over built documents | for a follow-up whose own type is each of `case`, `user`, `search`, `form`, `row` and `record` and whose parent type is another of them: the form's load map holds `#case/<p>` for the own read and `#case/parent/<p>` for the parent's, never `#user/…`, and nothing throws; a worker read still gives `#user/<p>`; a type the form does not reach gives no entry; depth 3 and past keeps the parent chain | an app the gate admits that cannot export, or a case read HQ's summary records as a worker's |
| T27 | `lib/domain/__tests__/caseOperationIdentifiers.test.ts` (extended) | `ownCaseOperationId` | over every case type the grammar admits (property test): the id passes `questionIdProblem` and `isCaseOperationIdentifier`, and is free among the taken ids; over types of letters, digits and underscores that pass the question id rule, the id is the type with `-` spelled `_`, as today | a minted id the form builder refuses; an existing type minting a new id |
| T28 | `lib/mcp/__tests__/servedGrammars.test.ts` (new, over the same `tools/list` read and schema walk) | what an MCP client receives | no served schema holds a `pattern` equal to the source of a retired grammar (the old case type pattern and its 255-bounded copy, and the old written-property, option-value, Search-name and lookup patterns, each a literal in the test); and behavior at the boundary, through Ajv over the served schema: `addFields` takes an inline source of one option and the value `it's`, `updateCaseProperty` takes the option value `say"hi"`, `addCaseOperations` takes the case type `1st-visit` and the write `first-name`, `addSearchInputs` and `configureCaseList` take the name `first-name`, `createLookupTable` takes the tag `health-facility-v2` and refuses `geo.lat`, and each refuses a value holding a space | a served schema that kept an old pattern or minimum, on any tool, named or not |
| T29 | `components/builder/shared/__tests__/caseTypePickerModel.test.ts` (extended) | `planCaseTypeCreation` (a state model, no DOM) | "1st visit" plans the creation of `1st_visit`; "Case" plans `case`; an existing name plans the pick of it; an empty draft plans nothing | a picker that still refuses a word the gate takes |

The fuzz corpora do not widen on their own. Their generators draw from fixed lists:
`lib/commcare/__tests__/xformDocArbitrary.ts` takes field ids from `SIBLING_ID_POOL`, case types from
`fc.constantFrom("patient", "household", "visit", "service")`, and option values from
`fc.constantFrom("a", "b", "c", "yes", "no")` with `minLength: 2`, and `suiteDocArbitrary.ts` takes case
types from `CASE_TYPE_NAMES`. Those draws stay as they are: `proof/corpus/fuzzSample.ts` builds the
lane's fuzz documents from the same generators, and a longer list would change what every existing seed
draws (`proof/CLAUDE.md`, "An existing fuzz sample keeps its draws": a new family has its own sample).
So this part adds a family with its own sample:

- `lib/commcare/__tests__/namesDocArbitrary.ts` (new): draws a document from `xformDocArbitrary`'s
  form core and `suiteDocArbitrary`'s module shapes with its own name draws: field ids from
  `first-name`, `copy-1-of-age`, `a-`, `a` and `a-b` (so nested pairs meet the itext key's doubled
  hyphen), case types from `case`, `parent`, `user`, `1st-visit`, `-flagged`, `2024` and `patient`,
  written properties from `first-name`, `state`, `category` and `visit-count`, option lists of one to
  three with values from `it's`, `say"hi"`, `` back`tick `` and `plain`, and a Search field named
  `first-name`.
- `xformOracle.fuzz.test.ts` and `suiteOracle.fuzz.test.ts` each gain one seeded sample over it (seed
  `20261113`, 80 runs, shrinking on), through the same `compilerEvidence.ts` every sample uses: the
  strict persisted schema, the gate, one expansion and one archive, then the HQ JSON, XForm, suite and
  binding oracles. Each sample counts what it drew and asserts that it held a hyphenated id, a type
  that starts with a digit, a type named `case`, a one-option select and a quoted value, so a generator
  that stops drawing them fails by name.
- `lib/doc/__tests__/referenceIndex.fuzz.test.ts` runs unchanged: it draws mutation batches, and names
  are not what it varies.

`proof/corpus/fuzzSample.ts` is not changed; the lane reads these grammars on the eight targeted
documents.

## Contracts and docs these changes make false

| Where | Old | New |
|---|---|---|
| `lib/domain/CLAUDE.md` | "`QUESTION_ID_PATTERN` (a letter first, then letters, digits and underscores, never starting `XML`)" | "`QUESTION_ID_PATTERN` (a letter first, then letters, digits, underscores and hyphens, never starting `XML`: HQ's form builder's grammar)" |
| `lib/domain/CLAUDE.md` | "non-empty, no whitespace, no `'` `\"` `` ` `` (`SELECT_OPTION_VALUE_PATTERN`). The bound is the wire's, not a naming taste: CommCare Android throws on any select value holding a space, a multi-select answer is a space-joined token list, and the case list compares the property inside an XPath literal." | "non-empty and no whitespace (`SELECT_OPTION_VALUE_PATTERN`), and never both `'` and `\"`. The bound is the wire's and the text's: CommCare Android throws on any select value holding a space, a multi-select answer is a space-joined token list, and a value holding both quote marks has no XPath string literal a rule's text could show." |
| `lib/domain/CLAUDE.md` | (new, beside the hashtag sentences) | "A record type is named in reference text as `#<type>/<property>`, or `#record/<type>/<property>` where the type is one of `HASHTAG_FIXED_NAMESPACES`; `hashtagSegments.ts::caseReferenceText` and `readCaseReference` are the one printer and reader." |
| `lib/domain/CLAUDE.md`, the choice value paragraph | "`sanitizeSelectOptionValue` is the keystroke repair (whitespace to `_`, quotes dropped)" | "`sanitizeSelectOptionValue` is the keystroke repair (whitespace to `_`)" |
| `lib/domain/CLAUDE.md`, the case operations paragraph | "operation ids and link identifiers match `[A-Za-z_][A-Za-z0-9_]*`, while write properties match `[A-Za-z][A-Za-z0-9_]*`; none trims or admits XML-name punctuation that the emitted case wire rejects" | "operation ids and link identifiers match `[A-Za-z_][A-Za-z0-9_]*`, while write properties take the catalog's grammar, `[A-Za-z][A-Za-z0-9_-]*`; none trims" |
| `lib/doc/CLAUDE.md`, the `identifierVerdicts.ts` bullet | "Nova's question-id grammar (HQ's form builder's without the hyphen, …)" | "Nova's question-id grammar (HQ's form builder's, …)" |
| `lib/doc/identifierVerdicts.ts`, header | "HQ's form builder's, without the hyphen" and the case type paragraph's "avoid the reserved reference namespaces" | "HQ's form builder's"; the case type paragraph names `CASE_TYPE_PATTERN` and the length alone |
| `lib/commcare/CLAUDE.md`, "Typed FormPath" | "element-step names pass `XML_ELEMENT_NAME_REGEX` at construction" | unchanged, with "(a letter or underscore, then letters, digits, underscores and hyphens)" added |
| `lib/commcare/CLAUDE.md`, the generated-node paragraphs | "a base an authored sibling … holds takes `_<n>`" | unchanged, with "An owner's id is written as it stands, hyphens included." added |
| `lib/commcare/xpath/CLAUDE.md`, "Parsing and identity" | "binds `#case` to the selected record type (`selectedCaseType`)" | the same, then "A record type is `#<type>/<property>` or `#record/<type>/<property>` (`lib/domain/hashtagSegments.ts`)." |
| `lib/lookup/CLAUDE.md` | (the tag paragraph) | gains "A tag and a column's wire name start with an unaccented letter or underscore and hold letters, digits, underscores and hyphens, never starting with lowercase `xml` (`LOOKUP_WIRE_IDENTIFIER_PATTERN`, and the two checks of `20261113000000_hq_round_trip_lookup_names`). A period is left out because CommCare HQ's build rewrites one in a case list filter and a display condition." |
| `docs/architecture/complex-apps.md`, the reserved write properties | "extended with `location_id`, `hq_user_id`, `external_id`, `category`, and `state`." and the paragraph after it, from "`category` and `state` are reserved because the two runtimes disagree about them" to "A property that means two different things cannot be authored." | "extended with `location_id`, `hq_user_id`, and `external_id`." and, in the paragraph's place: "`location_id` and `hq_user_id` are reserved because CommCare HQ stores each somewhere other than the property: a written `location_id` becomes the case's own location and a written `hq_user_id` is copied to its external id (`update_strategy.py::_apply_update_action`). `category` and `state` are ordinary properties on both runtimes: Core keeps each in the case's property map (`Case.java::setCategory`, `setState`) and shows it as a child like any other (`CaseChildElement.setCaseProperties`), beside an attribute of the same name that no Nova expression reads." |
| `docs/architecture/complex-apps.md`, the case operation vocabularies | "ASCII letters, digits, and underscores throughout; an operation id or link identifier starts with a letter or underscore, a write property with a letter only" | "an operation id or link identifier holds ASCII letters, digits, and underscores and starts with a letter or underscore; a write property takes the catalog's grammar, a letter first, then letters, digits, underscores, and hyphens" |
| `docs/architecture/complex-apps.md`, "Lookup carriers, table expressions, and itemsets" | "either `inline`, which owns at least two fully UUID-identified options" | "either `inline`, which owns at least one fully UUID-identified option" |
| `lib/commcare/CLAUDE.md`, "Form reads" | "References are **per-case-type**: `#<case_type>/<prop>` names the form's own module case type or an ancestor" | the same, then "A type named for one of reference text's fixed words is `#record/<case_type>/<prop>` (`lib/domain/hashtagSegments.ts::caseReferenceText`)." |
| `lib/commcare/CLAUDE.md`, "Vellum dual-attribute pattern", the load map sentence | "`case_references_data.load` walks typed form-case and worker-record terms" | unchanged, with "and `hashtags.ts::hqLoadReference` takes the typed read, never reference text" added |
| `lib/commcare/hashtags.ts`, header and `hqLoadReference`'s doc | "Translate one extracted hashtag ref", "`#user/` is already target vocabulary and passes through. Literal authored `#case/` is rejected" | "Project one typed case read"; the two sentences are removed with the arms they describe |
| `lib/references/config.ts` | `namespaceOf` and its doc | removed |
| `lib/agent/toolSchemaGenerator.ts`, two comments | "shared by add_fields, create_form, create_module, and edit_field"; "(also embedded by `createForm` / `createModule` for their `fields` arrays)" | "shared by add_fields, edit_field and set_field_options_source"; the parenthesis is removed |
| `components/builder/CLAUDE.md` | "either an inline source with at least two UUID-identified options" | "either an inline source with at least one UUID-identified option" |
| `components/builder/CLAUDE.md` | "(a space becomes `_`, a quote mark is dropped)" | "(a space becomes `_`)" |
| `lib/domain/questionId.ts`, header | "Nova keeps refusing the hyphen Vellum accepts, a rule of its own." | removed |
| `lib/domain/selectOptionValue.ts`, header | "A quote breaks the XPath literal a value is compared with (`field = 'value'`), which is how the case list projects a select's labels." | "A value holding both an apostrophe and a double quote has no XPath string literal, so a rule naming the choice could not be shown as text." |
| `lib/domain/caseOperationIdentifiers.ts`, header | "ASCII letters, digits, and underscores only. Operation and connection ids may begin with an underscore; case properties must begin with a letter." | "Operation and connection ids hold ASCII letters, digits and underscores and may begin with an underscore; a written property takes the catalog's grammar, a letter first and then letters, digits, underscores and hyphens." |
| `lib/db/appTests.ts`, the comment on `RUNTIME_VERSION` | "(version 18: query repeats, repeat counts and case operations)" | the parenthesis names the version the step moves to and its two reasons, "a query repeat's wrapper name, and a date and time on a case stored as CommCare HQ stores it" (the second is part 03's, its section 7.1); `lib/preview/app-tests/CLAUDE.md` gains one sentence that names the same version: "Runtime version <n> names a query repeat's wrapper `<id>.query` and stores a date and time on a case as CommCare HQ stores it." |
| `content/docs/commcare-connect.mdx`, "IDs" | "starts with a letter, uses letters, digits and underscores, and is 50 characters or fewer" | "starts with a letter, uses letters, digits, underscores and hyphens, and is 50 characters or fewer" |
| `content/docs/case-changes.mdx` | "Change ids and connection names use letters, numbers, and underscores and start with a letter or underscore; saved property names use the same characters and start with a letter." | "Change ids and connection names use letters, numbers, and underscores and start with a letter or underscore; saved property names start with a letter and can also hold hyphens." |
| `content/docs/mcp/tools.mdx` | "It can't hold spaces, quotes, or apostrophes, because the device refuses a choice value with a space in it and a multi-select answer is a space-separated list of these values." | "It can't hold spaces, because the device refuses a choice value with a space in it and a multi-select answer is a space-separated list of these values, and it can't hold both an apostrophe and a double quote." |
| `content/docs/mcp/tools.mdx` | "An inline source carries at least two options" | "An inline source carries at least one option" |
| `content/docs/mcp/tools.mdx` | "Write-property names use the same characters and start with a letter." | "Write-property names start with a letter and can also hold hyphens." |
| `proof/README.md`, "Targeted documents" | (new) | the paragraph of eight sentences section 12 writes out, and under the Connect proof's description ("What the package's tests hold") one sentence: "Its accepted names hold four hyphenated ids, one for each kind of block." |
| `docs/research/2026-09-26-hq-round-trip/inventory/*.md` | the rows of 11.1 | as 11.1, and the rows of 11.2 added; the Counts table stays the research's |

## Departures

Departures from the outline, the research, a manifest entry and the architecture contract, and the
decisions of this part where an alternative was weighed and not taken.

1. **Four classes of a name are not-yet, each with a step 7 owner and the reason at source.** The
   plan's rule for a name is that it cannot be fixed in CommCare HQ without changing data, so each
   widen is built or is honestly not-yet, decided row by row (the top-level file `../6-bring-in.md`,
   "What changed from the outline, and why"). The four classes are: names with non-ASCII
   letters (rows 19 and 22), because what Core reads is decided by each runtime's Unicode tables
   (`Lexer.isAlpha` over `Character.isLowerCase` and `isUpperCase`) and step 6 can state no one pattern
   proven on both; a lookup name holding a period (row 19), because HQ's build rewrites an unquoted
   period in a case list filter and a display condition (`xpath.py::dot_interpolate`); a choice value
   holding both quote marks (row 33), because form text has no spelling for it; and a lookup tag equal to
   an instance name CommCare owns (row 19), because a form's instance id is the tag
   (`instances.ts::lookupInstance`). Each is HELD-NEW, its entry says what is missing, and the reader's
   account lists it under `FINDING_LABELS`' "Nova can't hold this yet" (part 01, section 9.1). This is
   the rule's second arm, not a departure from it.
2. **Quote marks in a choice value are in, except both kinds in one value.** The SA's record dialect
   already spells such a string (`printQueryExpression.ts::literal`, `literal(concat(…))`), and form
   text does not (`expression/print.ts::literal` reports it missing, and `expressionAst.ts` binds no
   `literal(…)` call). A choice is compared in form logic, so the missing spelling is form text's, and
   adding it is a change to the form grammar's vocabulary that step 6 does not prove (7.2). Not done:
   admitting a value that holds both an apostrophe and a double quote, because no editor could show a
   rule that names the choice.
3. **Every one of the 45 rows is decided here, in part 04.** The nine built and the eighteen split are
   this part's to plan, and the eighteen of 2.4 are answered by parts 01 and 02 and named here with
   the reason. Part 03 (`03-questions-and-text.md`) decides none of them: it words the cell of row 43,
   and this part takes the row's `widen` out (11.1).
4. **From the research, "External identity"** ("Nova's lookup grammar widens to" HQ's XML-name grammar,
   and case properties "whose characters … are all Core's name characters … Nova's grammars must widen to
   admit them"). Step 6 widens both over ASCII, leaves the period out of lookup names (9.1), and leaves
   the rest HELD-NEW (2.3).
5. **From the outline, item 6** ("every `widen:` change a HELD row of the manifest names that no earlier
   step builds"). Nine are built in whole or in the authorable part, eighteen are split with owners,
   eighteen are answered by other parts of this plan, and the manifest stops being able to state a widen.
6. **Beyond the manifest**: Nova's own five reserved case type names are removed. No manifest entry
   names them; without the change the gate refuses a case type of `case`, which is what
   `views/modules.py::_init_module_case_type` gives a menu, and the reader admits exactly what the gate
   admits (part 09, `09-acceptance-and-the-first-publish.md`, section 4), so an app whose menu
   took HQ's own default type could not come in.
7. **Against the manifest entry and the architecture contract**: `category` and `state` are built and
   `location_id` and `hq_user_id` are not, where the entry treats the four alike and
   `docs/architecture/complex-apps.md` reserves `category` and `state` "because the two runtimes disagree
   about them". They do not disagree: HQ stores each as an ordinary property
   (`update_strategy.py::_apply_update_action`, `RESTRICTED_PROPERTIES`), and Core stores each in the
   case's property map (`Case.java::setCategory`, `setState`) and shows it as a child
   (`CaseChildElement.setCaseProperties`). The contract's paragraph is rewritten ("Contracts and docs"),
   and `targeted-case-write-names` holds the two runtimes to the same saved value on every reader.
8. **Two changes that are no grammar belong to this work**: `hashtags.ts::hqLoadReference` changes its
   signature and `caseOperationIdentifiers.ts::ownCaseOperationId` its fallback. Each rested on a case
   type never being one of five words or starting with anything but a letter, so each changes no later
   than the case type grammar and the reservation do (4.2, 4.3).
9. **`RUNTIME_VERSION` moves, for 3.4's reason.** Preview's query repeat wrapper is renamed, so a
   journey that pins a document holding a query repeat was built over a name the new runtime does not
   write. Nothing else in this part moves the number, and part 03's section 7.1 is the step's other
   reason for the same move (its section 9.5 states it). Not done: leaving the number where it is,
   because a journey made before the deploy would then continue under a runtime that names the wrapper
   differently from the one it was built over.

## Files

Paths are under the directory each bullet names. Nothing moves; one symbol changes its file (4.3).

**New.**

- `lib/case-store/migrations/20261113000000_hq_round_trip_lookup_names.ts`: the two lookup name checks,
  found by their text and replaced by named, wider ones, under a lock wait of at most five seconds, and
  a `down` that refuses where a stored name needs the wider grammar (9.3).
- `proof/targeted/documents/`: `hyphenatedQuestionIds.ts`, `caseTypeNames.ts`, `choiceValues.ts`,
  `lookupNames.ts`, `searchFieldNames.ts`, `caseWriteNames.ts`, each one document of section 12.
- `lib/commcare/__tests__/namesDocArbitrary.ts`: the generator of the names fuzz family ("Tests").
- The test files "Tests" does not mark extended, rewritten or existing, at the paths its table gives:
  T2, T3, T4, T6, T7, T8, T10, T11, T13 to T18, T20, T21 (two files), T25 and T28.

**Changed.**

- `lib/domain`: `questionId.ts` (the pattern, the `characters` test, the normalizer, C1, its header);
  `hashtagSegments.ts` (the segment source, `HASHTAG_FIXED_NAMESPACES`, `caseReferencePrefix`,
  `caseReferenceText`, `readCaseReference`); `expression/types.ts` (`CASE_TYPE_PATTERN`);
  `expression/print.ts` (the `form-case` arm); `caseOperationIdentifiers.ts` (the written property's
  grammar and message, `ownCaseOperationId`, its header); `standardCaseProperties.ts` (`category` and
  `state` leave the forbidden set); `selectOptionValue.ts` (the pattern, the problems, the schema, the
  sanitizer, C10, C11, its header); `fields/selectOptionsSource.ts` (the minimum of one);
  `fields/base.ts`, `fields/singleSelect.ts`, `fields/multiSelect.ts`, `fields/text.ts` (comments);
  `modules.ts` (`SEARCH_INPUT_NAME_PATTERN`, C14); `forms.ts` (`CONNECT_ID_PATTERN`); `prose.ts` (the
  two `case-ref` prints); `index.ts` (exports); `CLAUDE.md`.
- `lib/commcare`: `constants.ts` (`XML_ELEMENT_NAME_REGEX`, `CASE_TYPE_REGEX`); `xform/formPath.ts`
  (C18); `xform/itextIds.ts` (`fieldItextKey`); `xform/caseSaveReferences.ts` (comment);
  `advancedTags.ts` (C6 and two comments); `hashtags.ts` (`hqLoadReference` over the typed read, its
  text arms deleted) and `formActions.ts` (`buildCaseReferencesLoad`); `connectSlugs.ts` (C19);
  `xpath/grammar.lezer.grammar` and `xpath/hashtagGuard.ts` (the segment token), `xpath/parser.ts` and
  `parser.terms.ts` (regenerated, R1), `xpath/expressionAst.ts` (the `hashtag` arm, C7 to C9);
  `validator/rules/app.ts` (the reserved-name rule deleted), `rules/module.ts` (C3), `rules/field.ts`
  (`selectTooFewOptions` deleted), `rules/caseOperations.ts` (C5), `validator/errors.ts`, `gate.ts` and
  `runner.ts` (the two removed codes), `validator/formLogicFindings.ts` (the hashtag detail);
  `suite/case-search/reservedInputNames.ts` (comment); `surface/schema.ts` (`slotChangeSchema`),
  `surface/entries/*.json` (the five area files, by 11.1 and 11.2, and `gates.json`); `CLAUDE.md`,
  `xpath/CLAUDE.md`.
- `lib/doc`: `identifierVerdicts.ts` (the `reserved` code deleted, C2, its header); `userFacingErrors.ts`
  (C4, C12, C20, and the two removed codes' arms); `expressionText.ts` (`parseProseReference`);
  `types.ts`, `mutations/fields.ts` (comments); `CLAUDE.md`.
- `lib/lookup`: `constants.ts` (the two patterns, the `selected_cases` family), `schema.ts` (C15, C16),
  `CLAUDE.md`.
- `lib/case-store`: `migrations/index.ts` (the new migration's entry); `store.ts` and
  `postgres/store.ts` (the two stale `indexName` comments, removed).
- `lib/preview`: `engine/queryWrapperName.ts` (`<id>.query`); `app-tests/CLAUDE.md`.
- `lib/db/appTests.ts`: `RUNTIME_VERSION` and its comment (3.4).
- `lib/agent`: `authoring/bindings.ts`, `authoring/printQueryExpression.ts`,
  `authoring/formRecordContext.ts`, `authoring/text.ts` (each row of 5.2); `authoring/reference.ts` (the
  guide sentence); `toolSchemaGenerator.ts` (the minimum of one, and its comments);
  `tools/case-operations/shared.ts` (its own case type pattern dropped, C5);
  `tools/setFieldOptionsSource.ts` (C13).
- `lib/references`: `config.ts` (`namespaceOf` deleted, `classifyNamespace`), `provider.ts`.
  `lib/tiptap/refSuggestion.ts`. `lib/codemirror/xpath-autocomplete.ts` (each a row of 5.2).
- `components/builder`: `editor/fields/OptionsEditor.tsx`, `OptionsSourceEditor.tsx`,
  `optionsDraftModel.ts` (one option, C23), `caseWritePresentation.ts`; `shared/caseTypePickerModel.ts`
  (C22, the `reserved` arm deleted); `case-list-config/seeds.ts` (`xmlNameFromProperty`);
  `project-data/projectDataModel.ts` (comment), `CreateTableDialog.tsx`, `AddColumnDialog.tsx` (C21);
  `CLAUDE.md`.
- `proof`: `targeted/documents/connectApps.ts` (its two builders called with hyphenated ids for the
  two Connect documents); `targeted/index.ts` (the eight registered); `connect/conftest.py`
  (`ACCEPTED_NAMES`); `checks/manifest_value_classes.py` (N1's reader),
  `checks/test_manifest_value_classes.py` (`SHAPES`); `README.md`.
- `docs/architecture/complex-apps.md`, `content/docs/commcare-connect.mdx`, `case-changes.mdx` and
  `mcp/tools.mdx`: the sentences "Contracts and docs these changes make false" gives.
- `docs/research/2026-09-26-hq-round-trip/inventory/`: the five area files, by 11.1 and 11.2.
- Tests: the files "Tests" marks extended or rewritten (T1, T5, T9, T12, T19, T22, T26, T27, T29),
  the lane's `SHAPES` (T23), and one new seeded sample in each of `xformOracle.fuzz.test.ts` and
  `suiteOracle.fuzz.test.ts`. Changed because a removed code leaves them false:
  `lib/commcare/__tests__/validationRules.test.ts` (its `RESERVED_CASE_TYPE_NAME` cases become cases
  that the five words are admitted) and `lib/doc/__tests__/multiplayerMerge.test.ts` (its
  `SELECT_TOO_FEW_OPTIONS` merge becomes a merge that leaves one option and commits, and one that
  leaves none and is refused `SELECT_NO_OPTIONS`).

**Removed.**

- `lib/commcare/validator/reservedNamespaces.ts`: `RESERVED_CASE_TYPE_NAMES` is deleted with the rule
  and the code that read it, and `RESOLVED_REFERENCE_NAMESPACES` becomes `HASHTAG_FIXED_NAMESPACES` in
  `lib/domain/hashtagSegments.ts` (4.3).
