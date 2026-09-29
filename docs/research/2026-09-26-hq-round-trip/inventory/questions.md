# Questions

Part of the surface inventory of the HQ round-trip research. Section names in quotes and defect numbers refer to the main document, [`../README.md`](../README.md). Rows that point elsewhere with `→` name the section that owns the item; the inventory [`README.md`](README.md) says which file holds each section.

## Question types (XForm controls: Vellum's 42 mug types, plus raw constructs)

Vellum's error-level findings put a state outside the envelope; warnings do not. Platform cells are each runtime's reading.

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| Question ID matching `^(?!XML)[a-zA-Z][\w-]*$` | **HELD**: `Field.id`; widen: hyphens; narrow: no leading underscore, no leading `XML`, and not `meta` in any case (Nova admits `[a-zA-Z_][a-zA-Z0-9_]*`, including those); a rename would move the submission path | n/a | the id verbatim |
| Question ID `case`, `registration`, `script` | **HELD**: `Field.id` (Vellum warning only), except as below | n/a | verbatim |
| a root question `case` in a form where HQ writes the primary case block | **REFUSED**: not HQ-buildable: `XForm._create_casexml` "You cannot use the Case Management UI if you already have a case block in your form." (executed) | — | — |
| a root question `commcare_usercase` in a form with usercase updates | **REFUSED**: unrepresentable identity: `XForm._add_usercase` appends HQ's own `commcare_usercase` beside it (executed: the build succeeds with both) | — | — |
| Question ID failing the grammar, or `meta` in any case | **REFUSED**: not HQ-editable: Vellum error "not a valid Question ID" | — | — (Nova's `__nova_*` scaffolding names are unproducible today; in-envelope: letter-initial names) |
| two sibling data nodes with one name | **REFUSED**: unrepresentable identity: both answers share one submission path | — | — |
| Text (`<input>` `xsd:string`) | **HELD**: `text` | RUNS / RUNS | `input` + `xsd:string` |
| Phone Number (`xsd:string` + `appearance="numeric"`) | **HELD-NEW**: `text` with `Field.appearance: numeric` (Appearances) | DIFFERENT (regex-validated) / RUNS | `appearance="numeric"` |
| Password (`<secret>` `xsd:string`) | **HELD**: `secret` | RUNS / RUNS | `secret` |
| `<secret>` with a numeric bind type | **REFUSED**: not HQ-editable: Vellum's Secret writes `xsd:string` only | — | — |
| a `<secret>` whose bind has no `type` (any appearance but `numeric` or `numbers`, ignoring case, as the whole string) | **HELD**: `secret`, the same state: Android answers `DATATYPE_NULL` with its default `StringWidget` in secret mode (`WidgetFactory`), and Vellum writes `xsd:string` (executed) | RUNS / RUNS | `xsd:string` |
| a `<secret>` whose bind has no `type`, with `numeric` or `numbers`, ignoring case, as the whole appearance | **REFUSED**: not HQ-editable: Android shows a plain secret text box (`DATATYPE_NULL` reaches `StringWidget`, which ignores the appearance), and a Vellum save writes `xsd:string` and keeps the appearance (executed), which Android shows as a numeric box (`StringNumberWidget`) | — | — |
| Integer (`xsd:int`; `xsd:integer` read as the same) | **HELD**: `int` | RUNS / RUNS | `xsd:int` |
| Long (`xsd:long`) | **REFUSED**: not HQ-editable: Vellum's `Long` is not addable ("Deprecated. Users may not add new longs", `mugs/types/numeric.js`) | — | — |
| a select whose bind type is neither a choice type nor a string (such as `xsd:int` on `<select1>`) | **REFUSED**: not HQ-editable: Vellum drops the type on save | — | — |
| an `<input>` whose bind has no `type` (any appearance but `numeric` or `numbers`, ignoring case, as the whole string) | **HELD**: a text question, the same state: Core parses it as `DATATYPE_NULL`, which Android answers with a text widget (`WidgetFactory`) and Formplayer as text (`PromptToJson`), and Vellum writes `xsd:string` | RUNS / RUNS | `xsd:string` |
| an `<input>` whose bind has no `type`, with `numeric` or `numbers`, ignoring case, as the whole appearance | **REFUSED**: not HQ-editable: Android shows a plain text box (`WidgetFactory.buildBasicWidget` sends `DATATYPE_NULL` to `StringWidget`, which ignores `numeric` and `numbers`), and a Vellum save writes `xsd:string`, which Android shows as a numeric box (executed) | — | — |
| Decimal (`xsd:double`) | **HELD**: `decimal` | RUNS / RUNS | `xsd:double` |
| Date (`xsd:date`) | **HELD**: `date` | RUNS / RUNS | `xsd:date` |
| Time (`xsd:time`) | **HELD**: `time` | RUNS / RUNS | `xsd:time` |
| Date and Time (`xsd:dateTime`) | **HELD**: `datetime` | UNAVAILABLE ("web entry cannot support"; submit can silently fail) / RUNS | `xsd:dateTime` |
| GPS (`geopoint`) | **HELD**: `geopoint` | DIFFERENT (map-picked point, altitude/accuracy 0) / RUNS | `geopoint` |
| Barcode (`barcode`) | **HELD**: `barcode` | DIFFERENT (text box) / RUNS | `barcode` |
| Multiple Choice (`<select1>` + `<item>`) | **HELD**: `single_select`; widen: one option (Vellum and Core allow it; Nova needs ≥2) | RUNS / RUNS | `select1` |
| Checkbox (`<select>` + `<item>`) | **HELD**: `multi_select` (same widening) | RUNS / RUNS | `select` |
| choice value containing `'`, `"` or `` ` `` | **HELD**: option `value`; widen the option grammar (Vellum forbids only whitespace and duplicates) and escape in Nova's XPath emitters | RUNS / RUNS | the value |
| choice value with whitespace, or duplicated | **REFUSED**: not HQ-editable: Vellum error (`mugs/types/select.js`); multi-select stops Web Apps | — | — |
| select bind `type` `xsd:string`, or a choice type matching the control (`listItem`/`select1` on `<select1>`, `listItems`/`select` on `<select>`) | **HELD**: same state: Vellum writes no type on selects and Core infers the matching choice type (`XFormParser::applyControlProperties`) | RUNS / RUNS | no `type` (Nova writes `xsd:string`: equivalent) |
| a choice bind type contradicting the control (`listItem`/`select1` on `<select>`, `listItems`/`select` on `<select1>`) | **REFUSED**: not HQ-editable: a Vellum save drops the type, and Core then infers the other choice type (`applyControlProperties` keeps an explicit choice type, and Web Apps renders by it) | — | — |
| `<item>` without `<value>`, or an itemset without `<label>`, or without both `<copy>` and `<value>` (one with `<copy>` alone is the `<copy>` row below) | **REFUSED**: not HQ-buildable: `get_questions` "has no <value>" / JavaRosa fatal ("requires <label>", "requires <copy> or <value>") | — | — |
| `<odkx:intent>` that no question references | **INERT**: no runtime reads it (Vellum keeps it as an unmapped intent); HQ's build still applies the intents-privilege check to it (`_validate_intents` via `XForm.odk_intents`), which omitting it only relaxes | n/a | omit |
| select with both items and an itemset, or no choices | **REFUSED**: not HQ-buildable (JavaRosa fatal) | — | — |
| Label (`<trigger>` whose appearance is exactly `minimal`) | **HELD**: `label` | RUNS / RUNS | `trigger appearance="minimal"` |
| acknowledge label (a `<trigger>` whose appearance is neither exactly `minimal` nor exactly `selectable`: Android's `TriggerWidget` is interactive for any other string, so `minimal 2-per-row` or `minimal text-align-center` on a Label is an acknowledge there, while a `floating-` appearance hides the widget) | **HELD-NEW**: `label.acknowledge` | DIFFERENT (auto-`OK`; a required one never blocks) / RUNS (checkbox) | `trigger` with the held appearance, or none (Web Apps reads `N-per-row` and `text-align-*` on it, and Android a `floating-` value) |
| ref-less `<trigger>` | **REFUSED**: not HQ-buildable: `XForm._get_path` "has no 'ref' or 'bind'" | — | — |
| Hidden Value (data node + bind, no control) with `calculate` or default | **HELD**: `hidden` | RUNS / RUNS | bind (+ setvalue) |
| Hidden Value with neither | **HELD**: `hidden`; widen: Nova requires a value source (`HIDDEN_NO_VALUE`) | RUNS / RUNS | bare bind |
| Hidden Value with both `calculate` and a default, where no Default Value after it in the form reads it | **HELD**: read as the calculate (the default is dead: defaults run, then the calculate recomputes before anything else reads the value) | RUNS / RUNS | calculate only |
| Hidden Value with both `calculate` and a default, where a Default Value after it in the form reads it (by any spelling) | **HELD-NEW**: a Hidden Value keeping its default beside its calculate: defaults run in document order, which Vellum writes in data-tree order (`writer.js::createSetValues`), before Core's initial calculate pass (`FormDef.initialize`, `FormDef.createNewRepeat`), and a default that sets a node the calculate reads recomputes it then (`FormDef.setValue` → `triggerTriggerables`; executed), so the later Default Value sees the default unless such a default runs between them; Nova keeps both, in document order (executed in Core: `3`, where without the default, or with the reader first, it is empty) | RUNS / RUNS | both |
| Hidden Value with children | **REFUSED**: not HQ-editable: Vellum cannot construct it (`validChildTypes` empty) | — | — (Nova's `__nova_operations`/`__nova_subcases` are unproducible) |
| Group (`<group ref>` + label, no appearance) | **HELD-NEW**: `group.fieldList: false` (Nova emits every labelled group as a field-list today) | RUNS / RUNS (one question per screen) | `group` without `field-list` |
| Group (`<group ref>`) with no label and no appearance, outside a Question List | **HELD**: `group` with no label (Nova emits an unlabelled group without `field-list` today, `lib/commcare/xform/builder.ts`) | RUNS / RUNS | `group` |
| Question List (`<group appearance="field-list">`) labelled | **HELD**: a `section` at the root when every root field is a section and it has no display condition, no label media and no user-added repeat (`lib/domain/fields/section.ts`, `FORM_SECTION_USER_REPEAT`), otherwise a labelled `group` | IGNORED / RUNS | `appearance="field-list"` |
| Question List unlabelled, when every root field is a section and it has no display condition | **HELD**: an untitled `section` at the root (a section carries none) | IGNORED / RUNS | same |
| Question List unlabelled anywhere else | **HELD-NEW**: `group.fieldList: true` without a label | IGNORED / RUNS | same |
| groups nested in a Question List | **HELD**: nested `group` | IGNORED / RUNS | nested `group` |
| Repeat Group, user-controlled | **HELD**: `repeat` `user_controlled` | RUNS / RUNS (no delete) | `<group><label/><repeat nodeset>` (no `ref` on the group) |
| `<group ref=X>` wrapping the repeat (raw attribute) | **HELD**: same state as the ref-less group (identical Core event sequence) | RUNS / RUNS | ref-less group (Nova writes `ref` today: unproducible) |
| bare `<repeat>` with no group wrapper | **REFUSED**: freeform (kept only as a ReadOnly control) | — | — |
| Repeat with `jr:count` naming a node of the form's own data that exists (+ `jr:noAddRemove="true()"`) | **HELD**: `repeat` `count_bound`, whose meaning changes from today's form-load snapshot to the live count (defect 25) | RUNS / RUNS | `jr:count` naming the count question, or a hidden value whose calculate holds the count expression (Core requires a path, `XFormParser` `new XPathReference(countRef)`); read live, as Core rereads it during entry; no `__nova_count_*` snapshot (today's `__nova_count_*` snapshot is unproducible: Vellum refuses its `__nova_` name, and Nova writes its read by absolute path, which Vellum reports without VELLUM_DATA_IN_SETVALUE; defect 25) |
| `jr:count` that is not a path (such as `/data/n + 1`) | **REFUSED**: not HQ-buildable: Vellum writes it as entered (executed), and Core's parser requires a path (`XPathReference.getPathExpr`: "Expected XPath path, got XPath expression"; executed), which Formplayer's `validate_form` runs during the build | — | — |
| `jr:count` naming a node in a secondary instance, or no node | **REFUSED**: broken at runtime: Core resolves the count only in the form's own data (`FormEntryModel.createModelForGroup`), and form entry throws "Could not find the location … where the repeat … is looking for its count" (`FormDef.canCreateRepeat`; executed) | — | — |
| `jr:noAddRemove` without `jr:count` | **REFUSED**: not HQ-editable: Vellum filters it out (`mugs/types/group.js` Repeat `controlChildFilter`) | — | — |
| Repeat model iteration (`vellum:role="Repeat"`, `ids`/`count`/`current_index`, `item/@id`/`@index` setvalues) | **HELD**: `repeat` `query_bound` (`data_source.ids_query`) | RUNS / RUNS | Vellum's canonical shape: `@count` setvalue (`xforms-ready`/`jr-insert`), absolute `@current_index`, relevance on `…/item` (Nova's live `@count`, wrapper relevance and relative `@current_index`, `count(../item)`, are save-breaking today: a save makes the index absolute, `modeliteration.js`, which breaks a nested query repeat) |
| Count repeat whose count and row ids come from one query: a hidden value `nova_query_count_<repeat id>` holding the query's count, `jr:count` naming it, and in each row a hidden value `nova_query_id_<repeat id>` holding the id of the query's result at the row's position | **HELD-NEW**: `repeat` `query_bound` in its count-repeat placement (the reader recognizes exactly this shape, by those names and calculates, as one query repeat) | RUNS / RUNS | that shape, for a query repeat nested in another, under an ancestor whose relevance reads form answers, or whose query reads a form answer |
| model-iteration repeat under an ancestor whose relevance reads an answer a load-time default sets before the repeat's setvalues | **REFUSED**: broken at runtime: Core evaluates that relevance when those defaults are set, so Vellum's `@count` setvalue leaves the repeat empty (`count="0"`) whenever they make the ancestor not relevant, and it stays empty after the ancestor becomes relevant (executed; without such a default the rows are built) | — | — |
| model-iteration repeat whose query reads a form answer no load-time default sets before the repeat's setvalues (a calculated value, an answer entered in the form, or a default set after them) | **REFUSED**: broken at runtime: Vellum's setvalues evaluate the query once, when the form loads or the parent row is added, while that answer is still blank, so the rows never reflect it (executed) | — | — |
| model-iteration repeat nested in another repeat of any kind | **REFUSED**: broken at runtime: Vellum's canonical absolute `@current_index` counts the inner rows of every outer row, so once an earlier outer row has inner rows, form entry throws (`XPathException: … element 2 of a list with only 1`) or first gives rows the wrong case ids (executed, with a model-iteration, a counted and a user-added outer repeat) | — | — |
| user-controlled repeat inside a Question List (a group whose appearance is `field-list` in any case) | **REFUSED**: not HQ-editable and broken at runtime: Vellum reports "Repeat Count is required." (for `field-list` exactly; a case variant loads as a plain group), and Android cannot add instances there, reading the host ignoring case (`FormEntryController.isHostWithAppearance`) | — | — |
| repeat add captions `jr:addCaption`, `jr:addEmptyCaption` | **HELD-NEW**: `repeat.addLabel`, `addFirstLabel` | RUNS / RUNS | itext refs |
| other repeat captions (`chooseCaption`, `delCaption`, `doneCaption`, `doneEmptyCaption`, `mainHeader`, `entryHeader`, `delHeader`) with literal text | **INERT**: no runtime reads them: both build their form entry model with `REPEAT_STRUCTURE_LINEAR` (Formplayer `FormSession`, Android `FormLoaderTask` through `FormEntryModel`'s default), where only the `add` and `add-empty` captions are read, and a save keeps them | n/a | omit |
| those captions referencing itext | **REFUSED**: not HQ-editable: a Vellum save keeps the element but drops the itext no question references, which Core then refuses to load (executed), as for any orphaned itext reference | — | — |
| Image Capture (`upload image/*`) | **HELD**: `image` | DIFFERENT (file picker, no resize) / RUNS | `upload mediatype="image/*"` |
| `jr:imageDimensionScaledMax` (250/500/1000px, or another positive integer with or without `px`, which Vellum keeps as "Custom", `parser.js::populateControlMug`), on an image or face-capture question | **HELD-NEW**: `image.maxDimension` | IGNORED / RUNS | the attribute |
| `jr:imageDimensionScaledMax` that is not an integer (with or without `px`), on any upload, or zero, or less than -1, on an image or face-capture question (`-1` is Android's no-limit value, `ImageCaptureProcessing`, the same state as none) | **REFUSED**: broken at runtime or not HQ-editable: Core throws "Invalid input for image max dimension" on a non-integer when Android installs or loads the form, on every `<upload>` element (`UploadQuestionExtensionParser`, which Android registers for all of them, `XFormExtensionUtils`), a Vellum save drops a non-number and truncates a fraction (executed: `big` dropped, `12.5px` becomes `12px`), and Android cannot scale an image to a size of zero or less (`FileUtil.getBitmapScaledByMaxDimen` then asks for a non-positive size) | — | — |
| `jr:imageDimensionScaledMax`, an integer with or without `px`, on any other upload (a signature, say) | **INERT**: Vellum writes it only on image and face-capture questions (`mugs/types/media.js`) and drops it elsewhere on save, and no other widget reads it (only `ImageWidget` and its subclass `FaceCaptureWidget` apply it, and Core's parser rejects only a non-integer) | n/a | omit |
| Audio Capture (`audio/*`) | **HELD**: `audio` | DIFFERENT (file picker) / RUNS | `audio/*` |
| Video Capture (`video/*`) | **HELD**: `video` | DIFFERENT (file picker) / RUNS | `video/*` |
| Signature (`image/*` + `signature`) | **HELD**: `signature` | RUNS / RUNS | `appearance="signature"` |
| Face Capture (`image/*` + `face`) | **HELD-NEW**: `faceCapture` capture kind | DIFFERENT (a plain image upload) / RUNS | `appearance="face"`; FACE_CAPTURE gates only creating it |
| Document Upload (`application/*,text/*`) | **HELD**: `file` | RUNS / RUNS | that mediatype |
| `<upload>` with any other mediatype, or none | **REFUSED**: not HQ-editable: Vellum refuses to open the form (`parser.js::buildControlNodeAdaptorMap` `upload`), and for a case variant of the four mediatypes (`IMAGE/*`) a save rewrites it to lowercase, which Core reads as a different control, since its match is case-sensitive (`XFormParser.parseUpload`; executed) | — | — |
| Android App Callout (`input appearance="intent:<id>"`, bind `type="intent"`, head `<odkx:intent>` with extras/responses) | **HELD-NEW**: `callout` field kind (app id, extras, responses) | UNAVAILABLE (unsupported entry; the literal "Not Supported by Web Entry" can be submitted) / RUNS | as Vellum writes it; privilege `templated_intents` / `custom_intents` |
| `<odkx:intent appearance="quick">` | **REFUSED**: not HQ-editable: no editor writes it; Vellum keeps it only as a hidden unknown attribute of the intent tag (`intentManager.js::parseIntentTags`) | — | — |
| Print callout (`class="org.commcare.dalvik.action.PRINT"`, extra `cc:print_template_reference`) | **REFUSED**: retiring (VELLUM_PRINTING, tagged deprecated in HQ; Vellum also turns an Android App Callout given the print action into this question on load, `intentManager.js::syncMugWithIntent`, so that path is the same feature) | — | — |
| lookup-table select (`SelectDynamic`/`MSelectDynamic`, `<itemset nodeset="instance('<tag>')/<tag>_list/<tag>[filter]">`) | **HELD**: `optionsSource: lookup` | RUNS / RUNS | bare-tag instance id; privilege `lookup_tables` |
| itemset `label`/`value` refs to lookup fields | **HELD**: `labelColumnId`, `valueColumnId` | RUNS / RUNS | refs |
| itemset refs to `@attr` or property-qualified fields | **HELD-NEW**: lookup carrier over attributes and field properties (Lookup tables) | RUNS / RUNS | refs |
| itemset label `jr:itext(field)` | **REFUSED**: not HQ-editable: Vellum error "… was not found in the lookup table" (`itemset.js::validateRefWidget` checks against HQ's field and `@attr` list) | — | — |
| itemset `<sort ref>` | **HELD-NEW**: `optionsSource.sortColumn` | RUNS / RUNS | `<sort ref>` |
| itemset filter lifting into Predicate | **HELD**: `optionsSource.filter` | RUNS / RUNS | `[filter]` |
| itemset filter outside Predicate | **HELD-NEW**: typed expression model in `optionsSource.filter` | RUNS / RUNS | `[filter]` |
| itemset over casedb or another instance (advanced data-source editor) | **HELD-NEW**: `optionsSource: query` (choices from a casedb or fixture nodeset) | RUNS / RUNS | `<itemset nodeset=…>`; add-on `advanced_itemsets`; privilege `lookup_tables` (Vellum marks any itemset an error without it, `itemset.js`) |
| `<itemset><copy>` | **REFUSED**: freeform: Vellum drops it | — | — |
| `jr:choice-name()` on an itemset select | → XPath functions and structure | — | — |
| Balance / Transfer / Dispense / Receive (ledger blocks) | **REFUSED**: retiring (COMMTRACK): authorable only by the `commtrack` Vellum plugin | — | — |
| SaveToCase create (`case_type` literal, `case_name`, `owner_id`, `uuid()` case id) | **HELD**: `caseOperations[] {action: create}` | RUNS / RUNS | `vellum:role="SaveToCase"` block; privilege `save_to_case` (without it a Vellum save discards every case-attribute bind) |
| SaveToCase `case_type` given as an XPath | **HELD-NEW**: `caseOperations[].caseType` expression | RUNS / RUNS | bind `calculate` |
| SaveToCase create with an authored (non-`uuid()`) Case ID XPath, inside a repeat, or at the form root unless it is blank whenever the form opens (the row below) | **HELD-NEW**: authored create id expression (beyond `idFrom`); at the form root a load-time value: HQ's editor keeps it only as an `xforms-ready` setvalue (`saveToCase.js::getSetValues`), Vellum writes it and each load-time default in data-tree order (`writer.js::createSetValues`), and Core runs them in that order when the form opens (`FormDef.initialize`), so a read of an answer sees the value an earlier default gave it, and blank otherwise (executed: `concat(/data/key, '-')` gives `abc-` after a default of `abc` and `-` without one, and `concat(/data/key, uuid())` gives a fresh id) | RUNS / RUNS | `@case_id` setvalue (live calculate only inside a repeat) |
| SaveToCase create at the form root whose authored Case ID XPath is blank whenever the form opens: every value it reads is an answer no earlier load-time default sets, and with those blank it yields blank (such as the bare answer, or a `concat` of such answers) | **REFUSED**: broken at runtime: computed when the form opens (the row above), the id is blank on every submission, and a blank case id makes HQ reject the whole submission (`form_processor/casedb_base.py`, `IllegalCaseId`; executed: `/data/key` with no default gives `case_id=""`) | — | — (Nova emits a live root calculate today: defect 13) |
| SaveToCase update (Case ID XPath) | **HELD**: `caseOperations[] {action: update, target: expression}` | RUNS / RUNS | `@case_id` bind |
| SaveToCase property rows (calculation + condition) lifting into ValueExpression/Predicate | **HELD**: `writes[] {property, value, condition}` | RUNS / RUNS | update leaves with `calculate`/`relevant` |
| SaveToCase expressions outside Nova's typed vocabularies (case id, owner, open/close conditions, property values) | **HELD-NEW**: typed expression model in `caseOperations` | RUNS / RUNS | printed |
| SaveToCase property names with hyphens (`^[a-z][\w-]*$`, case-insensitive) | **HELD**: `writes[].property`; widen `CASE_OPERATION_PROPERTY_REGEX` | RUNS / RUNS | verbatim |
| SaveToCase Open Case Condition | **HELD**: operation `condition` (Vellum puts it on `…/case`, so the whole block is conditional) | RUNS / RUNS | binds |
| a close-only SaveToCase block with a Close Condition | **HELD-NEW**: two operations sharing the block: an update with no writes, which touches the case (a transaction and a new `modified_on`) on every submission that reaches the block, and a close under the Close Condition, since Vellum puts it on `…/case/close` alone (`saveToCase.js`; HQ processes a case block with no action, `form_processor/backends/sql/update_strategy.py`); Nova's close condition gates the whole block today | RUNS / RUNS | binds |
| a SaveToCase block that creates or updates and also closes (under its own Close Condition) or closes and links | **HELD-NEW**: two operations sharing the block, the create or update and a close of the same case under the block's Close Condition (Vellum makes only create and update exclusive, `saveToCase.js`, and puts the Close Condition on `…/case/close` alone; Nova's close arm today gates the whole operation and takes no links) | RUNS / RUNS | binds |
| SaveToCase owner | **HELD**: operation `owner` | RUNS / RUNS | `owner_id` bind |
| SaveToCase Owner ID Condition | **HELD-NEW**: a condition on the owner write (Vellum writes it as `relevant` on the `create/owner_id` leaf, and a non-relevant owner is left out of the block) | RUNS / RUNS | `relevant` on the `owner_id` bind |
| SaveToCase Link (`index/<name>` `child`/`extension`) and Unlink (empty index) | **HELD**: `links[]` (unlink: `target: null`) | RUNS / RUNS | `<index><name case_type relationship/>` |
| SaveToCase inside a repeat | **HELD**: `forEach` | RUNS / RUNS | live `uuid()` calculate |
| SaveToCase inside a Group whose display condition gates it | **HELD**: operation `condition` | RUNS / RUNS | the in-envelope shape for a conditional operation |
| relevance bound on the SaveToCase node itself | **REFUSED**: not HQ-editable: Vellum discards it (`saveToCaseMugOptions.getBindList`) | — | — (Nova emits this today: save-breaking) |
| `constraint` on SaveToCase case leaves | **REFUSED**: not HQ-editable: dropped | — | — (Nova emits this today: save-breaking; in-envelope: the constraint on the source question) |
| `type` on a SaveToCase property leaf (a create, update or index child; Vellum writes its own `xsd:dateTime` on `…/case/@date_modified`) | **REFUSED**: not HQ-editable: dropped | — | — (Nova emits this today: save-breaking; in-envelope: untyped `if(p = '', '', format-date(coalesce(p, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`) |
| `<attachment>` inside a SaveToCase block | **REFUSED**: not HQ-editable: Vellum writes only create/update/close/index | — | — (Nova emits this today: save-breaking) |
| create `@case_id` live calculate outside a repeat | **REFUSED**: not HQ-editable: Vellum rewrites it to an `xforms-ready` setvalue | — | — (Nova's `idFrom` at the root: save-breaking) |
| SaveToCase create, close or link of `commcare-user`, or type `user-owner-mapping-case` | **REFUSED**: not HQ-editable: Vellum error | — | — |
| hand-written `<case>` block without `vellum:role` (incl. a root `/data/case` with no Case Management) | **REFUSED**: freeform: Vellum discards its attribute binds, so every submission fails after a save | — | — (Nova's `__nova_guard_*` blocks: save-breaking) |
| Connect Learn Module | **HELD**: `Form.connect.learn_module`; widen (all four Connect blocks): hyphens in block ids, as Vellum's id rule allows (`util.js` `/^(?!XML)[a-zA-Z][\w-]*$/`), and narrow: no leading `_` or `XML` and not `meta` in any case, which Vellum refuses on every Connect block and Nova admits today (executed; defect 15), and the id length each block's Connect column takes (50 for a learn module or task, 100 for a deliver unit, any for an assessment, which Connect does not store; Nova caps every id at 50 today), a display condition per block, blank entity expressions, a `time_estimate` of 0, several blocks per form, and placement inside groups and repeats, as Vellum allows | RUNS / RUNS | `vellum:role="ConnectLearnModule"`; COMMCARE_CONNECT |
| Connect Assessment | **HELD**: `connect.assessment` | RUNS / RUNS | same |
| Connect Deliver Unit | **HELD**: `connect.deliver_unit`; widen: a `work_area_id` expression | RUNS / RUNS | with an empty `<work_area_id/>` (Vellum adds it; equivalent) |
| Connect Task | **HELD**: `connect.task` | RUNS / RUNS | same |
| a Connect learn module or task id longer than 50 characters, or deliver unit id longer than 100 | **REFUSED**: broken at runtime: Connect keeps these ids in slug columns of those lengths (commcare-connect `opportunity/models.py` `LearnModule.slug`, `TaskType.slug`, `DeliverUnit.slug`): a longer learn module or deliver unit id fails where Connect writes it (`opportunity/tasks.py`, `form_receiver/processor.py`), and a longer task id matches no task type (`processor.py` looks tasks up by `task_type__slug`), while Vellum allows any length | — | — |
| Connect Work Area Update | **HELD-NEW**: `connect.work_area_update` | RUNS / RUNS | same |
| unknown body control (Vellum `ReadOnly`, e.g. `<range>`) | **REFUSED**: freeform | — | — |
| content marked `vellum:ignore="retain"` (Vellum `Ignored`) | **REFUSED**: freeform | — | — |
| `<input readonly="true()">` (control attribute) | **REFUSED**: freeform: Vellum turns it into an acknowledge label (`<trigger>` without an appearance, executed) ("produces different XML than consumed") | — | — |
| input whose bind type Vellum does not write (`xsd:decimal`, `xsd:float`, `xsd:boolean`, `xsd:anyURI`, `xsd:base64Binary`, `xsd:hexBinary`, `xsd:gYear`, `xsd:gMonth`, `xsd:gDay`, `xsd:gYearMonth`, `xsd:gMonthDay`, `geotrace`, `geoshape`, any unknown) | **REFUSED**: not HQ-editable: Vellum rewrites the type to `xsd:string`, or a case variant of a type it knows (`xsd:Int`, `xsd:datetime`) to that type's spelling (`parser.js` lowercases before matching), while Core's type names are case-sensitive | — | — |
| `binary` bind type on an upload | **HELD**: capture kinds | RUNS / RUNS | `binary` |
| Data Parent (data node under another group than its control, within one repeat) | **HELD-NEW**: `Field.dataParent` | RUNS / RUNS | data tree placement |
| Data Parent crossing a repeat | **REFUSED**: not HQ-editable: Vellum error | — | — |
| Default Data Value (`dataValue`, instance text) | **REFUSED**: not HQ-editable: Vellum shows the property only when present (a code comment marks it deprecated, `mugs.js`) | — | — |
| a default value's setvalue whose event does not match where the question sits (`xforms-ready` inside a repeat, `jr-insert` outside one) | **REFUSED**: not HQ-editable: Vellum reads either event as the Default Value and rewrites the event by placement on save (`parser.js::parseSetValue`, `defaultOptions.getSetValues`) | — | — |
| data-node `xmlns` on a Hidden Value | **HELD-NEW**: a Hidden Value's data-node namespace (Vellum's "Special Hidden Value XMLNS attribute", `mugs/baseSpecs.js`) | n/a (submission shape only) | `xmlns` on the data node |
| `vellum:lock="all"` (locked question) | **HELD-NEW**: `Field.lockedInHq` (privilege `locked_admin_questions` a target precondition; no runtime effect) | n/a | the attribute |
| `vellum:comment` | **INERT**: authoring note; stripped at build | n/a | omit |

## Binds, actions, model and head content

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| bind `nodeset` (absolute or relative) | **HELD**: the field's path | n/a | absolute (Vellum's spelling) |
| bind `relevant` | **HELD**: `Field.relevant` | RUNS / RUNS | `relevant` |
| bind `required="true()"` | **HELD**: `Field.required` (`true()`) | RUNS / RUNS | `required="true()"` |
| bind `required="<expr>"` | **HELD**: `Field.required` (expression) | RUNS / RUNS | `required` (Vellum adds `requiredCondition` itself) |
| Vellum `requiredCondition="<expr>"` / `vellum:requiredCondition` | **INERT**: ignored by JavaRosa (unused-attribute warning); Vellum's own mirror of `required` | n/a | omit |
| Required Condition without Required | **INERT**: Vellum warning only; `required` absent means not required | n/a | omit |
| `jr:requiredMsg` | **INERT**: not parsed by JavaRosa (`processStandardBindAttributes` usedAtts) | n/a | omit |
| bind `constraint` | **HELD**: `Field.validate` | RUNS / RUNS | `constraint` (Nova drops it on `barcode`/`secret` today, an emitter bug) |
| Validation Message without a Validation Condition | **REFUSED**: not HQ-editable: a Vellum error, which puts it outside the envelope (Rule 1) though no runtime shows the message (`FormEntryPrompt.getConstraintText` reads a bind's message only through its constraint) | — | — |
| `jr:constraintMsg="jr:itext('id')"` or `<alert ref="jr:itext('id')">` | **HELD**: `Field.validate_msg` (Vellum adds the `<alert>`: equivalent) | RUNS / RUNS | `jr:constraintMsg` + `<alert>` |
| literal `jr:constraintMsg="text"` (no itext) | **REFUSED**: not HQ-editable: Vellum keeps it only as the hidden `constraintMsgAttr` property (`javaRosa/plugin.js`), written back verbatim, which no editor sets | — | — |
| bind `calculate` on a Hidden Value | **HELD**: `hidden.calculate` | RUNS (re-evaluated on every request) / RUNS (dependency-driven) | `calculate` |
| bind `calculate` on a visible question | **REFUSED**: not HQ-editable: Vellum shows Calculate Condition only when already present (`visible_if_present`) | — | — |
| bind `readonly` | **REFUSED**: freeform: no Vellum property (kept only as a raw attribute) | — | — |
| `jr:preload` / `jr:preloadParams` | **INERT**: parsed but never executed on any runtime (`TreeElement.getPreloadHandler` has no caller) | n/a | omit |
| bind `id` with control `bind=`, where the id is the node's path relative to the root or to its parent control | **HELD**: same state as the `ref` binding, which Vellum rewrites it to | n/a | `ref` |
| any other bind `id` named by a control's `bind=` | **REFUSED**: not HQ-editable: Vellum reads `bind=` as a path, warns "Ambiguous bind", turns the question into a Hidden Value and writes a control with no `ref` (executed), which HQ's build then refuses (`XForm._get_path`) | — | — |
| `<bind>` whose nodeset matches no node | **INERT**: Core warns and ignores it (`XFormParser::verifyBindings`), and Vellum discards it on save | n/a | omit |
| a control whose `ref` names no node | **REFUSED**: not HQ-buildable: JavaRosa "Question bound to non-existent node" (`XFormParser::verifyControlBindings`) | — | — |
| bind on an attribute path not owned by a plugin (SaveToCase, model iteration) | **REFUSED**: freeform: Vellum discards it ("Bind Node … will be discarded") | — | — |
| bind `type` | → Question types (per control) | — | — |
| `<setvalue event="xforms-ready">` default on a question outside repeats, not reading form nodes by absolute path | **HELD**: `Field.default_value` | RUNS (new sessions only) / RUNS (new instances only) | `setvalue xforms-ready` |
| `<setvalue event="jr-insert">` default inside a repeat, not reading form nodes by absolute path (a relative read such as `../a` is held through the typed expression model; Vellum flags only `#form/` reads, executed; HQ's editors produce it with the flag off) | **HELD**: `Field.default_value` | RUNS / RUNS | `setvalue jr-insert` |
| a default value that reads `#form/…` nodes | **HELD**: `Field.default_value`, the same state as the read spelled relatively (the row above): Vellum reports it without VELLUM_DATA_IN_SETVALUE, and Core resolves both spellings to the same node, inside and outside repeats (executed) | RUNS / RUNS | the read printed relatively (Nova's `__nova_count_*` snapshots: unproducible; see Question types, count repeats) |
| a second default setvalue on one question | **REFUSED**: not HQ-editable: Vellum keeps one (`parser.js::parseSetValue`) | — | — |
| `<setvalue event="xforms-value-changed">`, authored `xforms-revalidate`, or a setvalue on a non-question ref | **REFUSED**: freeform: kept only as a form-level setvalue | — | — |
| actions nested inside controls | **REFUSED**: freeform: Vellum drops them, or keeps them as read-only controls inside a group | — | — |
| `<send>` + `<submission>` | **REFUSED**: freeform: Vellum drops both | — | — |
| a `<submission>` Core's parser refuses (without `resource` and `targetref`, `method="get"`, `replace="text"` and `mode="synchronous"`, as the ordinary ODK spelling is) | **REFUSED**: not HQ-buildable: JavaRosa fatal (`XFormParser::parseSubmission`, "Missing required attribute resource") | — | — |
| a `<submission>` Core accepts, with no `<send>` naming it | **INERT**: only a send action reads it, and Vellum drops it; the instance always posts to the app's receiver | n/a | omit |
| authored `<orx:pollsensor>` | **REFUSED**: freeform: Vellum drops it (HQ injects its own from `auto_gps_capture`) | — | — |
| other unknown `<model>` children (non-XForms namespace) whose local name Core does not dispatch | **INERT**: Core ignores them (`XFormParser.parseModel`), and Vellum drops them | n/a | omit |
| unknown-namespace `<model>` children named `itext`, `instance`, `bind`, `submission`, `setvalue`, `send` or `pollsensor` | **REFUSED**: freeform: Core dispatches `<model>` children by local name whatever their namespace (`XFormParser.parseModel`; Android registers `pollsensor`), and Vellum drops them | — | — |
| unknown XForms-namespace `<model>` children, text in `<model>` | **REFUSED**: not HQ-buildable: JavaRosa fatal | — | — |
| `<h:head>` children, other than HQ's own `h:title`, `model`, `odkx:intent` and `vellum:*`, whose local name, and every descendant's, no runtime dispatches | **INERT**: Core ignores them and processes their children (`XFormParser.parseElement`), and Vellum drops them | n/a | omit |
| other `<h:head>` children whose local name, or a descendant's, Core or Android dispatches whatever its namespace (a control name such as `input` or `select1`, `group`, `model`, `title`, `meta`, Android's `intent`) | **REFUSED**: freeform: Core parses them as form content by local name (`XFormParser` `topLevelHandlers`; executed: a foreign-namespace `input` there became a question), and Vellum drops them | — | — |
| authored `/data/meta` block | **REFUSED**: not HQ-editable: Vellum error "'meta' is not a valid Question ID" (HQ's build would replace it, `XForm._add_meta_2`) | — | — |
| HQ-generated meta (`deviceID`, `timeStart`, `timeEnd`, `username`, `userID`, `instanceID`, `appVersion`, `drift`, `location`) | **HELD**: derived by HQ at build | DIFFERENT (`deviceID` `Formplayer`, `appVersion` `Formplayer Version: X.Y`, `drift` 0, `location` empty) / RUNS | nothing |
| `<h:title>` and data `@name`, whatever their text | **HELD**: derived from `Form.name`: Vellum writes the name in the language it is editing (`views/formdesigner.py` passes `formName`), and HQ's name edit writes it too (`XForm.set_name`), while a Bulk App Translations rename leaves both stale until the next Vellum save (`upload_app.py::BulkAppTranslationModulesAndFormsUpdater.update`); which language or which earlier name a title holds is not held | IGNORED / RUNS (Android takes a saved form's name from the title; HQ reads `@name` from the submission) | the form's name in the default language (Nova writes that as the title and a slug as `@name` today: defect 14) |
| data-root `uiVersion`, `version` | **INERT**: `version` overwritten at build; `uiVersion` unread | n/a | `1` / any |
| data-root `xmlns` | → Form fields `xmlns` | — | — |
| data-root attributes other than `xmlns`, `xmlns:jrm`, `uiVersion`, `version`, `name`; extra namespace declarations on `h:html` | **INERT**: no reader; Vellum drops them | n/a | omit |
| XML comments, processing instructions | **INERT**: no reader; Vellum drops them | n/a | omit |
| DTD-declared entity references (predefined ones such as `&amp;` are ordinary text) | **REFUSED**: not HQ-buildable: `DangerousXmlException` | — | — |
| `vellum:*` hashtag shadow attributes | **INERT**: Vellum metadata, stripped at build | n/a | only Vellum's own `toHashtag()` output, or none; never a shadow with a predicate on a form path (Nova's `constraintCollections.ts` shadows make Vellum write unparseable XPath into the real attribute: save-breaking) |
| `<vellum:hashtags>`, `<vellum:hashtagTransforms>` | **INERT**: metadata | n/a | as Vellum writes them |
| `<vellum:case_mappings>` (head) | **INERT**: HQ never parses it | n/a | omit |
| `vellum:ignore` containing `markdown` on `h:html` (Vellum's "Disable Text Formatting") | **HELD-NEW**: `Form.plainText`: with it, Vellum writes no markdown forms and drops every existing one on each save, so dropping it would let later Vellum edits add markdown forms (`javaRosa/plugin.js`); the validator refuses a markdown label form in such a form | n/a | `vellum:ignore="markdown"` |
| `vellum:ignore` containing `richText` | **INERT**: Vellum editor preference | n/a | omit |
| `case_mapping_diff` (Vellum → HQ) | **INERT**: editor side channel; empty for every Nova form | n/a | n/a |

## Appearances (`appearance` attribute)

`Field.appearance` (HELD-NEW) is a typed vocabulary of the values each runtime reads; the platform cells are each runtime's reading. Web Apps matches space-separated tokens; Android matches `compact`, `combobox` (and within a combobox, `multiword` or `fuzzy`), `gregorian` (ignoring case), `legacy`, `overlay-small`, `editable` and, for images only, `acquire` inside the string, as it does `quick` inside a compact single select and `cancel` (ignoring case) inside a Gregorian date; `intent:` at the start of an input's appearance and `floating-` at the start of a label's; `floating-good`, `floating-caution` and `floating-bad` as the whole string on any question (`FormNavigationUI`); and every other value only as the whole string, some ignoring case (group `field-list` and `compact`, `short`, `ethiopian`, `nepali`, `numbers`, `numeric`, `maps`, and `acquire` on a video question; audio `acquire` has no reader, since Android builds `AudioWidget` only for `legacy`) (`WidgetFactory.java`, `ImageWidget.java`, `BarcodeWidget.java`, `TriggerWidget.java`, `DatePrototypeFactory.java`, `AudioWidget.java`, `VideoWidget.java`, `StringWidget.java`, `GeoPointWidget.java`, `CommCareAudioWidget.java`, `RecordingFragment.java`, `IntentWidget.java`, `FormNavigationUI.java`, and Core's `FormEntryController.isHostWithAppearance`). Both runtimes read a multi-token string's order and spelling, so it is held exactly as HQ stores it. `field-list` belongs to groups (`group.fieldList`), never to `Field.appearance`, and an acknowledge label is `label.acknowledge`. A value no runtime reads is INERT.

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| select1 `minimal` | **HELD-NEW**: `Field.appearance` | RUNS (dropdown) / RUNS (spinner) | `minimal` |
| select1 `compact`, `compact-N` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS (grid) | the token as HQ spells it |
| select1 `quick` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS (auto-advance) | the token as HQ spells it |
| select1 `quick compact-N` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| select1 `combobox` | **HELD-NEW**: `Field.appearance` | RUNS / RUNS | the token as HQ spells it |
| select1 `combobox multiword` | **HELD-NEW**: `Field.appearance` | DIFFERENT (whole-word match, 2nd token only) / RUNS (substring) | the token as HQ spells it |
| select1 `combobox fuzzy` | **HELD-NEW**: `Field.appearance` | DIFFERENT (Web Apps algorithm) / RUNS | the token as HQ spells it |
| select1 `list` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| select1 `list-nolabel` | **HELD-NEW**: `Field.appearance` | RUNS / RUNS | the token as HQ spells it |
| select1 `label` | **HELD-NEW**: `Field.appearance` | RUNS / RUNS | the token as HQ spells it |
| select1 `button-select` | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| select1 `receive-<topic>-<field>` | **HELD-NEW**: `Field.appearance` | RUNS (radio list, combobox) / IGNORED | the token as HQ spells it |
| select `minimal` | **HELD-NEW**: `Field.appearance` | RUNS / RUNS | the token as HQ spells it |
| select `compact`, `compact-N` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| select `list` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| select `list-nolabel` | **HELD-NEW**: `Field.appearance` | RUNS / RUNS | the token as HQ spells it |
| select `label` | **HELD-NEW**: `Field.appearance` | RUNS / RUNS | the token as HQ spells it |
| select `combobox*`, `quick`, `button-select` | **INERT**: neither runtime reads them on multi-selects, as the whole appearance | n/a | omit |
| text `numeric` (Phone Number preset) | → Question types, Phone Number | — | — |
| `<secret>` `numeric` | **HELD-NEW**: `Field.appearance` | DIFFERENT (shown unmasked) / RUNS (masked) | the token as HQ spells it |
| text/secret `numbers` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| `short` | **HELD-NEW**: `Field.appearance` | RUNS (narrow) / DIFFERENT (text and numeric inputs only, as the whole appearance: the keyboard action) | the token as HQ spells it |
| `medium` | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| text `address` | **HELD-NEW**: `Field.appearance` | RUNS (geocoder) with CASE_SEARCH_ADVANCED and the `geocoder` privilege, else UNAVAILABLE (unsupported entry; the literal "Not Supported by Web Entry" can be submitted) / IGNORED (text) | verbatim; both gates are target preconditions |
| `broadcast-<topic>` (an address entry under the gates above, and uploads other than signatures) | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| text `receive-<topic>-<field>` | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| barcode `numeric`, `address` or `receive-<topic>-<field>` | **HELD-NEW**: `Field.appearance` | DIFFERENT (read as on a text question, since `entries.js::getEntry` handles text and barcode in one branch: `numeric` a digits check, `address` the geocoder under its gates, `receive-*` a receiver) / IGNORED (Android's barcode widget reads only `editable` inside the string and `quick` as the whole string, `BarcodeWidget.java`, `IntentWidget.java`) | the token as HQ spells it |
| `hint-as-placeholder` on text (other than a `<secret>` without `numeric`, or an address entry), numeric, barcode (a text box on Web Apps), `minimal`/`combobox` selects | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| `hint-as-placeholder` on any other entry | **HELD-NEW**: `Field.appearance` | DIFFERENT (the hint shows nowhere) / IGNORED | the token as HQ spells it |
| `intent:<id>` on an intent-typed input (callout preset) | → Question types, Android App Callout | — | — |
| `intent:<id>` on any `<input>` other than an intent-typed one, where `<id>` is the tag of a callout question in the same form | **HELD-NEW**: `Field.appearance` | IGNORED (the ordinary entry) / RUNS (Android builds the intent widget for any input, `WidgetFactory`) | the token as HQ spells it |
| `intent:<id>` naming an `<odkx:intent>` that no callout question writes | **REFUSED**: not HQ-editable: no editor creates an `<odkx:intent>` without its callout question, which owns it and deletes or renames it (a save keeps an existing one, `intentManager.js::writeIntentXML`, executed: unproducible), and `Field.appearance` cannot hold the tag's class, extras or responses | — | — |
| `intent:<id>` on any input naming no `<odkx:intent>` in the form | **REFUSED**: broken at runtime: Android form entry throws "No registered intent callout for id …" (`AndroidXFormExtensions.getIntent`) | — | — |
| barcode `quick` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS (auto-scan) | the token as HQ spells it |
| numeric input (int/decimal) any other value, apart from the values every question reads (`N-per-row`, `short`, `medium`, `text-align-*`, `hint-as-placeholder`, `floating-good`, `floating-caution`, `floating-bad`) and `intent:` | **INERT**: no reader, as the whole appearance | n/a | omit |
| date `ethiopian` | **HELD-NEW**: `Field.appearance` | RUNS / RUNS | the token as HQ spells it |
| date `nepali` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| date `gregorian`, `gregorian cancel` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| time `12-hour` | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| dateTime, any value apart from the values every question reads and `intent:` (as above) | **INERT**: no reader, as the whole appearance | n/a | omit |
| geopoint `maps` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| barcode `editable` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| image `signature` | → Question types, Signature | — | — |
| image `face` | → Question types, Face Capture | — | — |
| image `acquire` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| image `overlay-small` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| audio `legacy` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| audio `acquire` | **INERT**: dead on both, as the whole appearance | n/a | omit |
| audio `acquire-or-upload` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| audio `long` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS (API ≥24) | the token as HQ spells it |
| video `acquire` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| document upload, any value except `broadcast-*` and the values every question reads (as above) | **INERT**: no reader, as the whole appearance | n/a | omit |
| trigger `minimal` (Label preset), as the whole string, case-sensitively (`TriggerWidget`) | → Question types, Label | — | — |
| trigger `selectable` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| trigger with no or an unrecognized appearance (acknowledge) | → Question types, acknowledge label | — | — |
| `floating-good`, `floating-caution`, `floating-bad` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| group `field-list` as the whole appearance (inside a multi-token string no runtime reads it) | → Question types, Question List | — | — |
| group whose whole appearance is `field-list` in a case other than all lowercase (such as `Field-List`, which Vellum's free-text Appearance Attribute writes on a Group, `mugs/baseSpecs.js`) | → Question types, Question List: the same state as `field-list`, re-emitted as `field-list`, since Core reads the host ignoring case (`FormEntryController.isHostWithAppearance`); Vellum loads it as a plain Group and HQ's form summary shows a Group (`xform.py` `VELLUM_TYPE_INDEX`), and both show a Question List once it is re-emitted | — | — |
| group `compact` | **HELD-NEW**: `Field.appearance` | IGNORED / RUNS | the token as HQ spells it |
| group `group-collapse` | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| group `collapse-open` | **HELD-NEW**: `Field.appearance` | RUNS (with `group-collapse`) / IGNORED | the token as HQ spells it |
| group `collapse-closed` | **INERT**: constant with no reader, as the whole appearance | n/a | omit |
| group `group-border` | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| `N-per-row` (any question or group) | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| `N-per-row-repeat` (group holding a repeat) | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| `text-align-center`, `text-align-right` | **HELD-NEW**: `Field.appearance` | RUNS / IGNORED | the token as HQ spells it |
| any value on a Vellum Repeat (written on its wrapping group) or on `<repeat>` | **INERT**: discarded at parse (`XFormParser::collapseRepeatGroups`) / never read | n/a | omit |
| `field-list` on any question, `compact` on a question that is not a select | **INERT**: `field-list` hosts must be groups, and only selects read `compact` | n/a | omit |
| multi-token strings (e.g. `minimal hint-as-placeholder`, `signature 2-per-row`, `fuzzy combobox`) whose every token some runtime reads | **HELD-NEW**: `Field.appearance` holding the ordered list of its typed tokens, emitted in the order and spelling HQ stores | DIFFERENT / DIFFERENT (Web Apps reads every token but takes a combobox's match type only from its second token, so `fuzzy combobox` is a plain combobox there; Android reads only its substring values, so `fuzzy combobox` is fuzzy there and `minimal hint-as-placeholder` falls back to the default widget) | the tokens as HQ spells them |
| a multi-token string holding a token no runtime reads on that control in that position | **REFUSED**: untypeable: the token has no typed reading, and dropping it would change what Android matches in the whole string | — | — |
| a single string no row names that holds values Android matches inside the string, each a value whose own row Web Apps ignores, which Android reads exactly as it reads a held value or held multi-token value (`compact2` as `compact`, image `acquire-or-upload` as `acquire`, audio `legacyx` as `legacy`, `gregorian-cancel` as `gregorian cancel`) | **HELD-NEW**: `Field.appearance` holding that held value, the same state: Android's substring matches read both alike (a compact select takes its column count from the text after the string's first `-` when that is an integer, else none, `WidgetFactory.buildCompactSelectOne`, `buildSelectMulti`; a Gregorian date reads `cancel` anywhere in the string, `DatePrototypeFactory.getWidget`), and Web Apps reads neither | IGNORED / RUNS | the held value as its row spells it |
| any other single string no row names that holds a value Android matches inside it (such as `combobox2`: a combobox on Android, while Web Apps reads `combobox` only as a whole token and shows a plain select) | **REFUSED**: untypeable: the two runtimes read it differently, and no held value has that pair of readings | — | — |
| any other value (read by no runtime; not an `intent:` value on an input) | **INERT**: no reader, as the whole appearance | n/a | omit |

## Itext, markdown and label text

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| label default text (itext `<value>`) | **HELD**: `Field.label` (prose + localization) | RUNS / RUNS | itext default form |
| inline `<label>text</label>` (no itext) | **HELD**: `Field.label` (Vellum converts it to itext: same text) | RUNS / RUNS | itext |
| `long` form | **HELD-NEW**: `labelForms.long` (preferred over the default text on both runtimes only when the label has no markdown form) | RUNS / RUNS | `form="long"` |
| `short` form | **INERT**: no runtime reads it | n/a | omit |
| `markdown` form equal to the default text | **HELD**: the text with markdown on | RUNS (markdown-it) / DIFFERENT (Markwon: single newlines join, images alt-only) | `form="markdown"` copy |
| label with no `markdown` form | **HELD-NEW**: `ProseTemplate.markdown: false` (Nova writes a markdown copy on every text today, which re-renders plain labels containing `*`, `#`, `1. `) | RUNS / RUNS (literal) | no markdown form |
| `markdown` form differing from the default text | **REFUSED**: not HQ-editable: Vellum loads the markdown value as the default text and writes both from it, so a save replaces the default (`javaRosa/plugin.js::loadXML`, `contributeToModelXML`) | — | — |
| label `image` / `audio` / `video` (same asset every language) | **HELD**: `Field.label_media` | DIFFERENT / DIFFERENT (renderers) | itext media forms |
| label or option media differing by language | **HELD-NEW**: `localizedMedia` | RUNS / RUNS | per-language forms |
| label `video-inline` | **HELD-NEW**: `label_media.videoInline` | IGNORED / RUNS (replaces the label image) | `form="video-inline"` |
| label `big-image` | **REFUSED**: broken at runtime: HQ ships no file for a `big-image` form of its own (`FormMediaMixin.all_media` collects image, audio, video and video-inline forms; `remove_unused_mappings` prunes the rest), so Android's full-screen view opens a missing file unless another media form in the app happens to use the same path | — | — |
| label `qrcode` | **HELD-NEW**: `labelForms.qrcode` | IGNORED / RUNS (replaces the label image unless a `video-inline` form does) | `form="qrcode"` |
| label `tts` | **HELD-NEW**: `labelForms.speech` | IGNORED / DIFFERENT (only with no `audio`) | `form="tts"` |
| custom form names | **INERT**: no runtime reads them | n/a | omit |
| a label whose itext in the first `<translation>` has no default-form value (only `long`/custom/media; another language lacking it builds, and Core falls back per key) | **REFUSED**: not HQ-buildable: HQ's build raises 'Unrecognized value of "form" attribute' when a `long` or custom form is present, and otherwise "has no <value>" (`xform.py::XForm.localize`, which checks the first `<translation>`) | — | — |
| hint text | **HELD**: `Field.hint` | DIFFERENT (always markdown) / DIFFERENT (plain) | `<hint>` itext |
| hint media | **INERT**: no accessor on either runtime | n/a | omit (Nova emits `hint_media` today; inert on both runtimes) |
| help text (+ markdown form) | **HELD**: `Field.help`, markdown on (markdown off is HELD-NEW `ProseTemplate.markdown`) | DIFFERENT / DIFFERENT | `<help>` itext |
| help media | **HELD**: `Field.help_media` | DIFFERENT (only when help has text) / RUNS | itext media |
| validation message text | **HELD**: `Field.validate_msg` | RUNS / RUNS | itext |
| validation message markdown form | **HELD**: same text (neither runtime renders markdown there) | IGNORED / IGNORED | copy |
| validation message media (`constraintMediaIText`) | **INERT**: no runtime reads it (Android shows the message's text only, `FormEntryActivity`; Formplayer returns its text only, `JsonActionUtils`) | n/a | omit (Nova emits `validate_msg_media` today: defect 16) |
| choice label text (+ markdown) | **HELD**: option `label`, markdown on (markdown off is HELD-NEW `ProseTemplate.markdown`) | DIFFERENT (markdown in lists) / DIFFERENT (markdown in some widgets) | item itext |
| choice `image` | **HELD**: option `media.image` | IGNORED / RUNS | itext media |
| choice `audio`, `video` | **HELD**: option `media.audio`/`video` | IGNORED / RUNS (select-one/multi, quick) | itext media |
| choice `big-image` | **REFUSED**: broken at runtime (as for labels) | — | — |
| group/repeat label text (+ markdown) | **HELD**: container `label`, markdown on (markdown off is HELD-NEW `ProseTemplate.markdown`) | DIFFERENT (card header) / DIFFERENT (breadcrumb) | itext |
| group/repeat label media | **INERT**: Vellum offers no media on group, question list or repeat labels (`javaRosa/plugin.js`, `isSpecialGroup`), and neither runtime renders it | n/a | omit (Nova emits container `label_media` today; no runtime reads it) |
| `<output value="…">` of a question, case or user reference | **HELD**: prose `field-ref`/`case-ref`/`user-ref`/`user-property-ref` parts | RUNS / RUNS | `<output value>` |
| `<output ref="…">` | **HELD**: same (Vellum rewrites to `value`) | RUNS / RUNS | `<output value>` |
| `<output value="<any other expression>">` | **HELD-NEW**: prose expression part (`XPathExpression`) | RUNS / RUNS | `<output value>` |
| plain label containing HTML text | **HELD**: the text | DIFFERENT (sanitized HTML) / DIFFERENT (literal) | verbatim |
| XHTML-namespace child elements inside a `<value>` | **REFUSED**: freeform | — | — |
| other child elements inside a `<value>` | **INERT**: dropped at parse (`XFormParser::getLabel`) | n/a | omit |
| a translation missing for an app language | **HELD**: the default-language fallback (Core per-key fallback) | RUNS / RUNS | copy of the default (Vellum fills it the same way) |
| an explicitly blank value in a non-default language where the default has text | **REFUSED**: not HQ-editable: Vellum fills a blank translation from the default language on every save (executed; a Bulk App Translations upload of one language can write one) | — | — (Nova emits a blank `<value>` today where a label, hint, help text, validation message or option label has an explicitly empty translation: save-breaking; in-envelope: the default language's text) |
| `<translation>` for a language not in `langs` | **INERT**: HQ strips it at build (`exclude_languages`) | n/a | omit |
| itext entry referenced by no question and no expression | **INERT**: no reader; Vellum drops it | n/a | omit |
| itext entry referenced only from `jr:itext()` in an expression | **REFUSED**: not HQ-editable: Vellum drops itext that no question references | — | — |
| itext pragma entries (`Pragma-Form-Descriptor`, `Pragma-Skip-Full-Form-Validation`, `Pragma-Submit-Automatically`, `Pragma-Suppress-Autosync`, `Pragma-Volatility-Key`/`-Entity-Title`/`-Window`) | **REFUSED**: not HQ-editable: unreferenced itext, dropped by Vellum | — | — |
| itext ids, `default=""` placement | **INERT**: no runtime reads id spelling; HQ sets `default` and merges identical entries at build (`set_default_language`, `normalize_itext`) | n/a | Vellum's `<path>-<property>` ids |
| duplicate `<text id>` in one translation; `jr:itext("…")` with double quotes as a control, label or item `ref`; a `jr:itext` id missing from the default locale | **REFUSED**: not HQ-buildable: `ItextNodeGroup.add_node`, JavaRosa fatal | — | — |
