# The surface inventory

Every field and construct an HQ application can carry, each with exactly one
disposition, its behavior on each platform, and what Nova emits. This is the
content the surface manifest encodes. `AM/` is
`commcare-hq/corehq/apps/app_manager/`.

The inventory belongs to the HQ round-trip research, whose main document is [`../README.md`](../README.md); citations use the pinned commits named there. Section names in quotes and defect numbers refer to that document.

## Where each area lives

| File | Sections |
|---|---|
| [`application-and-settings.md`](application-and-settings.md) | Application; Settings and profile; Add-ons |
| [`menus-and-case-lists.md`](menus-and-case-lists.md) | Module types; Module fields; Case list and case detail; Detail screens; Detail columns; Column formats; Column field paths; Sorting; Detail tabs; Case list callout; Case selection extras |
| [`case-search.md`](case-search.md) | Case search; Search configuration; Search prompts; CSQL in `_xpath_query` values and ancestor-path criteria |
| [`forms-and-case-writes.md`](forms-and-case-writes.md) | Form types; Form fields; Basic form actions; Case-property typing; Advanced form actions; Shadow forms; Usercase |
| [`questions.md`](questions.md) | Question types; Binds, actions, model and head content; Appearances; Itext, markdown and label text |
| [`expressions-and-data.md`](expressions-and-data.md) | Secondary instances; XPath functions and structure; Media; Lookup tables |
| [`gates.md`](gates.md) | Toggles, privileges and build versions; App-building toggles; Removed toggles with document residue; Privileges; Build versions |

## How to read a row

| Column | Content |
|---|---|
| HQ item | the model path, value class or XForm construct |
| Disposition | **HELD**: a Nova slot holds it today (`widen:` or `narrow:` marks a change to that slot's grammar). **HELD-NEW**: Nova adds the named concept. **TARGET-OWNED**: project-space or server state, never held in the document: the deployment ledger records the identities a project space gives the app, and the rest is left to the target. **INERT**: no effect any runtime or HQ server reads, so Nova does not hold it; build output nothing reads, HQ pages that only describe the app (App Summary), and export columns and data dictionary entries no submission fills, are not effects. The Emission column gives what Nova writes, if anything. **REFUSED**: import is refused, for the reason named. |
| Web Apps / Android | RUNS, IGNORED, UNAVAILABLE or DIFFERENT on each platform; `n/a` where no runtime reads the item as app content Nova holds (TARGET-OWNED rows and the gate summaries use it even where a runtime reads the target's value); `—` on refused rows |
| Emission | the HQ shape Nova writes, inside HQ's editable envelope, with its preconditions. *Printed* means written from Nova's typed expression, with the source's meaning. Where Nova's current emission is outside the envelope, the cell says so: *unproducible* (no HQ editor produces it, and saves keep it or rewrite it equivalently) or *save-breaking* (an HQ save changes, drops or refuses it), with the in-envelope shape beside it. |

A row whose Disposition starts with `→` points at the row that owns the item and
is not counted. The toggles, privileges and build versions ([`gates.md`](gates.md)) summarize
the gates over the other files' rows and are not counted.

## Rules applied

1. **Envelope.** "HQ-editable" as defined under "The bar": HQ's current editors
   can produce the state under a configuration HQ still supports, with no error an editor shows, and every HQ save keeps
   it or rewrites it to a spelling that HQ builds, and HQ's servers read,
   identically. Raw XForm upload, `edit_form_attr_api`, raw attribute posts and
   the import API are not authoring. A state outside the envelope is refused on
   import and fixed on emission.
2. **Same state.** A stored spelling whose build output every runtime and HQ's
   servers read identically to an editor-producible value's is that value: held,
   and re-emitted in the editor's spelling. That includes byte-identical build
   output; output that differs only in attribute order, XPath whitespace, or the
   order of `<update>` children and their binds, which no reader orders; an
   attribute whose absence Core reads as that value; `null`, `''` and absent
   defaults; a default a calculate overrides before any Default Value after it in the form reads it; load-time setvalues in another
   order, where none reads another's target; markup Core walks into the same
   event sequence; and a setting that changes only restore content no held
   app reads.
3. **Expressions.** A slot holding XPath or CSQL gets one row per value class:
   HELD when the value lifts into today's typed vocabulary, HELD-NEW when it needs
   the typed expression model, and REFUSED when Core or HQ fails on it, when it
   is untypeable, or when it is retiring content.
4. **Retiring.** Exactly the retiring content under "What is refused". A gate that is a non-retiring flag or a plan privilege is a target precondition over held content, unless it gates only creating the state in HQ, which is no precondition.
5. **Refusal reasons** are only: retiring (gate named), freeform, not HQ-editable
   (editor rule named; a value an editor marks as an error counts, whether or not
   its save blocks it), not HQ-buildable (validator named), broken at runtime
   (failure named), unrepresentable identity, untypeable (structure that exists
   only at runtime, or content Nova cannot read), below the CommCare version
   floor, and unavailable on a declared platform.

## Counts

| Area | HELD | HELD-NEW | TARGET-OWNED | INERT | REFUSED | Rows |
|---|---|---|---|---|---|---|
| Application | 8 | 5 | 11 | 12 | 9 | 45 |
| Settings and profile | 3 | 26 | 6 | 16 | 12 | 63 |
| Add-ons | 0 | 0 | 0 | 13 | 0 | 13 |
| Module types | 3 | 3 | 0 | 0 | 10 | 16 |
| Module fields | 11 | 14 | 1 | 11 | 15 | 52 |
| Case list and case detail | 44 | 55 | 0 | 19 | 45 | 163 |
| Case selection extras | 4 | 6 | 0 | 3 | 5 | 18 |
| Case search | 41 | 46 | 1 | 8 | 26 | 122 |
| Form types | 5 | 4 | 0 | 0 | 7 | 16 |
| Form fields | 18 | 12 | 2 | 13 | 17 | 62 |
| Basic form actions | 25 | 14 | 1 | 10 | 25 | 75 |
| Advanced form actions | 0 | 26 | 1 | 2 | 24 | 53 |
| Shadow forms | 1 | 3 | 0 | 3 | 4 | 11 |
| Usercase | 2 | 1 | 1 | 0 | 0 | 4 |
| Question types | 51 | 24 | 0 | 4 | 47 | 126 |
| Binds, actions, model and head content | 13 | 1 | 0 | 16 | 18 | 48 |
| Appearances | 0 | 52 | 0 | 9 | 4 | 65 |
| Itext, markdown and label text | 17 | 7 | 0 | 9 | 9 | 42 |
| Secondary instances | 11 | 12 | 0 | 2 | 17 | 42 |
| XPath functions and structure | 3 | 82 | 0 | 0 | 12 | 97 |
| Media | 6 | 7 | 0 | 0 | 7 | 20 |
| Lookup tables | 4 | 7 | 2 | 1 | 2 | 16 |
| **Total** | **270** | **407** | **26** | **151** | **315** | **1169** |

Case list and case detail sums its seven sections, from Detail screens to Case list callout; Case search sums its three; and Basic form actions includes Case-property typing.

## HELD-NEW concepts (Nova vocabulary)

**Cross-cutting.** *typed expression model*: one expression type, total over what CommCare evaluates (JavaRosa's 76 functions, its instance sources and path steps, and HQ's CSQL functions), with a type at every node and a stable identity for every reference (fields including relative paths, case properties at any relation depth, lookup tables and fields, location types, user groups, worker data, session datums and session context values, search inputs and results, selected cases, `jr:itext` strings); it replaces Predicate/ValueExpression and today's text-with-leaves `XPathExpression`, compiles to device XPath, CSQL and Postgres, and Preview runs it in its client-side engine and compiles case queries to Postgres through `lib/case-store` · *typed CSQL composition*: runtime choice among typed CSQL clauses and runtime values in typed CSQL slots; CSQL whose property names, operators or function names are computed at runtime has no typed reading and is refused · *`Field.appearance`*: a typed vocabulary of every appearance value a runtime reads, with its per-platform reading, emitted as HQ spells it · *`localizedMedia`*: per-language media on labels, options and menus · *typed instance references*: lookup tables, user groups, locations, and search results and inputs as identity-bearing data sources in the typed expression model.

- **Application and settings:** the platform declaration (wire: `cloudcare_enabled`) · `localization.wireCodes` · per-language display names · `uiStringOverrides` (keys typed from the runtimes' string catalogs) · `uiStringCatalogKeys` (catalog keys HQ fills with its own text) · `appSettings` (21 typed slots: autoUpdateFrequency, daysFormRetain, loggingEnabled, autoSyncFrequency, multimediaValidation, unsentFormLimit, unsyncedTimeLimit, showSavedForms, showIncompleteForms, resizeImages, fuzzyListSearch, logCaseDetailViews, loginDuration, imageTargetDensity, autoCaptureAccuracy, defaultMapLayer, textToSpeech, requiredAsterisk, androidAppDependencies, persistentMenu, breadcrumbs) · `androidLogos` · `caseSharing` · `menuStyle` (rootGrid, formMenus, moduleGrid).
- **Modules and navigation:** `Module.mirrorOf` (with child mirrors, excluded forms and form entry points) · `Module.showFormsInParent` · `Module.caseListMenuItem` beside forms (the formless case, held today as `caseListOnly`, migrates into it) · `Module.caseListLabel` · `Module.caseListRegistrationForm` (registration and follow-up arms, label, afterSubmit, displayCondition, icon, audioLabel; replacing today's search-no-matches form entry) · `Module.badge` / `Form.badge` · always-false display condition · usercase Predicate term · usercase list module · a module's advanced kind, held once published or imported · `postSubmit: firstMenu` / `parentMenu` · link-chain semantics · self and cyclic links · `entryPoint.computedDatumArguments`.
- **Case list and detail:** `caseListConfig.detailTabs` (plain, child-case and expression rows; displayCondition) · `detailTile` · `persistentContext` · `emptyText` · `selectButtonText` · `callout` (action, name, icon, autoLaunch, extras, responses, resultsColumn) · `optimizations` + `column.optimization` · `selection.autoSelect` · `tile.template` + `column.tileSlot` · a hidden or address column's cell in a custom tile · `tile.persistFrom` · `tile.pullDown` · column kinds `address`, `distance`, `markdown`, `mapLayer` (boundary, boundaryColor, points, pointColors), `clickableIcon`, `conditionalText`, `translatedExpression`, `ownerName` · `interval` widening (optional threshold, until, threshold ≤ 0) · `image-map` equality keys, condition keys and `altText` · ID-mapping keys that are blank or hold several tokens · a plain column showing a select property's raw value · several address columns and a detail tile row across tabs, in an advanced module · a hidden sort of a data tab's rows · `column.via` · usercase column · `sort.comparator` / `blanks` / `label` / `expression` · row-context `here()`.
- **Case search:** `caseSearchConfig.workflow` (listFirst, searchFirst, skipToResults) + `inline`, replacing today's `searchFirst` flag · `resultSort` · `resultsInstanceName` · `caseListConfig.additionalCaseTypes` · `requestCaseTypes` (a `case_type` default filter) · several `_xpath_query` default filter rows, each kept as its own row · search-only owner exclusion · no search title · `includeRelatedCases: false` · a hidden input without a value · a hidden input with a widget · typed default filters (a property, an ancestor property, `owner_id`, `case_id`, `commcare_project` or a reverse index equal to a device-computed value, from a default filter or a hidden prompt without `exclude`) · `relatedCaseProperty` · `includeRelatedCases` · `searchOnClear` · `searchEndpoint` · `geocoder` input + `receiveFrom` · `checkbox` widget · `allowBlank` · `searchInputGroups` · CSQL: `closed_on`, case-type term, project-timezone dates, epoch coercions, list literals, runtime `selected*` values, distance unit tokens, runtime distance operands, case/datum/context value terms.
- **Forms and case management:** `Form.xmlns` · `Form.openCondition` · `Form.closeCondition` on a registration · `Form.autoCaptureLocation` · `Form.submitLabel` · `Form.caseSelections` (tag, caseType, listModule, childOf, autoSelect: expression/userData/lookupRow/usercase/index) · `Module.autoSelectSingle` · case-operation placement (basic form action slot, advanced action tag or Save to Case path; derived for a new operation, held once published) · a selected case as an operation target, and a link relationship chosen per submission · a label's value as an advanced write or name source, and a preload into a label · `Form.plainText` (Vellum's text formatting off) · `Form.computedDatums` · `Form.shadowOf` (selectionOverrides, extraSelections) · a write's `via` and `onlyIfChanged` · preload as a default value that reads the case · an operation's owner write in the basic update slot · a child case's condition and close in its basic subcase placement · `closeCondition.operator: isTrue` · writer-type joins (decimal, multi_select, text) · the date-and-time join writer · a date-and-time question writing its date to a `date` property · an advanced form's own case (its close, open and close conditions on the form).
- **XForm:** `label.acknowledge` · `faceCapture` · `callout` field kind · `image.maxDimension` · `repeat.addLabel` / `addFirstLabel` · `group.fieldList` · `Field.dataParent` · `Field.lockedInHq` · `optionsSource: query` · `sortColumn` on a lookup options source (a question's `optionsSource`, a search input's `options`) · query-repeat placement (model iteration or count repeat; derived for a new query repeat, held once published) · a Hidden Value's data-node namespace · a Hidden Value's default kept beside its calculate · a Save to Case owner-write condition and a close sharing its block with a create or update · lookup carriers over attributes and field properties · `caseOperations` case-type expression and authored create id · `connect.work_area_update` · `labelForms.long` / `qrcode` / `speech` · `label_media.videoInline` · `ProseTemplate.markdown` · prose expression part · `jr:itext` / `jr:choice-name` lookups.
- **Media and lookup data:** held media paths · a media reference holding its path with no file · media formats only one platform plays, for an app that declares only that platform · import-sized media · `LookupColumn.properties` + multi-valued cells · `LookupTable.rowAttributes` · `LookupTable.ownership` · `LookupColumn.indexed` · cell absence states (no element, empty element) · a `types` table, referenced only · import-sized tables.

---
