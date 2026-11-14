# Step 6, part 06: The reader: frame and forms

Part of step 6's plan, "Bringing an app in from CommCare HQ". This part plans the reader's
architecture and its structural half: the package `lib/commcare/reader/`, its one public function, the
manifest as the reader reads it at run time, the accounting cursor that makes admission a property of
the code, the walk of an HQ application, its menus and its forms at the level of their own keys, and
the whole reading of a form's source: data tree, binds, load-time values, body, text, media references,
the nodes Nova itself generates, Vellum's shadows, Connect blocks, and the declaration the content
allows. Case management, menus, lists and search are part 07's
(`07-the-reader-cases-menus-lists.md`), expressions part 08's (`08-the-reader-expressions.md`) and
acceptance part 09's (`09-acceptance-and-the-first-publish.md`). This part states the frame each of
them works in.

Citations are `path::symbol`. Nova is read at `main` `1f103305`; the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every
CommCare fact below was read at those commits for this part. HQ paths are relative to
`corehq/apps/app_manager/` unless they start with another app's name; Vellum paths to `src/`. A manifest
entry is named by its full id as `lib/commcare/surface/entries/*.json` holds it.

A person reaches the reader only through the read and the create of part 12
(`12-the-reading-and-the-birth.md`). Nothing in this part changes a served tool input, a tool
description or the guide, so it gives `lib/models.ts::MODEL_CONTEXT_VERSION` no reason to move and
adds no `scripts/test-schema.ts` entry. Nothing in it changes what an app test runs, so it gives
`lib/db/appTests.ts::RUNTIME_VERSION` none either.

| Section | Owns |
|---|---|
| 2 | the package; `readHqApp`'s input and output; purity; the stages; the Biome rule |
| 3 | the manifest at run time: `surface/inventory.ts` and the index |
| 4 | the accounting cursor: claims, consumption, the claim log, unknown keys, cost |
| 5 | findings and places as the reader makes them |
| 6 | the application walker: every `Application` key, languages and wire codes, the floor, doc types |
| 7 | menus and forms at the level of their own keys; identity; the keys left to parts 07 and 08 |
| 8 | the XForm reader: parse to model and body, the join |
| 9 | the field kind decision table and appearances |
| 10 | choices, groups, sections and repeats |
| 11 | logic slots as pending text; load-time values and A's effective order |
| 12 | itext by reference, prose, markdown copies, media references, translations |
| 13 | the generated-node recognizer, purpose by purpose |
| 14 | Vellum's shadows and hashtag metadata |
| 15 | Connect blocks |
| 16 | assembly, the declaration the content allows, the date-and-time split, generated translation keys |
| 17 | what the reader hands the expression stage, acceptance and the request that calls it |
| 18 | the circumstances this part raises |

---

## Decisions in brief

1. **The reader is one pure function, `readHqApp(input, options)`, in `lib/commcare/reader/`** (2). It
   reads nothing but its arguments, never throws for an app's content, reports every finding in one
   pass, and returns either a draft (the document, its construction batch, identities, the declaration
   choices and the facts later parts read) or an account. It is outside the `lib/commcare` barrel and
   carries `server-only`. Its stages, 1 to 11 with 5b, run in one fixed order (2.3), with part 07's
   four settle functions after the expressions are bound.
2. **The reader needs no new consumer in `biome.json`** (2.4). Its one production consumer is
   `lib/deployment/reading/`, which the rule already admits, and `proof/` is outside the rule. The
   rule's four messages open by calling `lib/commcare` a one-way emission boundary, which the reader
   makes false, so this part rewrites that first sentence ("Contracts").
3. **The manifest's entries are loaded by one server module, `lib/commcare/surface/inventory.ts`** (3),
   which parses the six area files once and derives each entry's standing, cause and subject
   through part 01's `standingOf` and `fixCauseOf`.
4. **Every claim site is data** (4.2). A reader module declares its claims with `defineClaims`: each
   names one entry id, one surface key and what the site does (`take`, `derived`, `drop`, `refuse` or
   `account`). A test holds every claim to the manifest: the entry exists, its standing permits the use,
   and it names the key.
5. **The cursor decides nothing about content** (4.3). The calling code picks the claim by the value it
   read; the cursor checks the use against the entry's standing, records it, and turns everything left
   unclaimed into the circumstance `unrecognized` at that place. A value handed out under a `held`
   claim must be read before the reading closes, or it too is `unrecognized`.
6. **The claim log is in the proof lane's vocabulary** (4.5): `(artifact, where, key, entry, standing)`,
   with `artifact` and `where` spelled as `proof/checks/manifest_usage.py` spells them. Production keeps
   counts by entry; the full log is materialized only for tests and the lane's judge.
7. **A stage absent from `STAGES` leaves its keys unclaimed** (2.3). No stub and no flag: the
   property that refuses an unknown key is the one that keeps a reader with a stage missing from
   admitting anything.
8. **The application walker claims every declared `Application` property by part 01's table** (6), reads
   `langs` into language identities with HQ's codes stored verbatim, and judges `build_spec` against the
   floor. A menu or form of a document type Nova does not hold is one finding at that menu or form, and
   its keys are covered by it.
9. **A language code Nova's registry cannot name, and two codes that name one language, are a new
   HELD-NEW entry** (6.3), not a late schema failure.
10. **The form reader joins model and body as Vellum does** (8): data tree first, then binds, then
    setvalues, then the control tree, each control finding its node by `ref`, `nodeset` or `bind`. What
    Vellum reads as a question Nova cannot hold is a finding under that question's own entry.
11. **A field's kind is decided by one table over (control, bind type, media type, appearance,
    structure)** (9), read from the same tables the emitter writes with. Appearances are classified by
    the runtime read rules `surface.json` records, never by a list of strings in reader code.
12. **A root made only of Question Lists reads as sections** (10.2), because that is the one document
    of the pair Nova's editors make, and the manifest already says so.
13. **A model-iteration repeat is held exactly where Nova's own rule runs model iteration** (10.4). The
    three shapes the manifest refuses stay refused; any other shape the rule does not run is a new
    HELD-NEW entry. The outline's wider "load-time rule" is not built in step 6 (Departure 1).
14. **A logic attribute is never read as text by this part** (11.1). The forms stage registers each
    as part 08's `PendingExpression`, under the slot of the document it will live in; stage 7 builds
    a provisional document in every reading, findings or none, and part 08's `readExpressions` binds
    against it, so an expression finding is reported beside a structural one.
15. **A's effective load-time order is computed, and a changed order between a value and the node it
    reads is a finding** (11.3): in the form's own setvalues under a new REFUSED entry, since a save in
    HQ's form builder would reorder them too; for a value HQ's build appends, under part 07's entries.
16. **A Hidden Value's bind type is held only as text or date and time** (11.4). Any other type changes
    what Core stores for a calculated value, so it is a new HELD-NEW entry.
17. **Text is read by reference, never by id** (12.1): a control's or bind's `jr:itext('id')` names the
    entry, whatever the id's spelling, and Nova writes its own ids back. An entry only an expression
    reads is the manifest's existing refusal.
18. **A translation equal to its source text is no translation** (12.5). The source language is HQ's
    first language. This is one of the reader's canonical choices (16.2), seven of them this part's
    rows, each a document pair Nova writes identically.
19. **A generated node is recognized by rebuilding it** (13): the reader proposes the owner, builds the
    node's bind with the production emitter's own function, and compares parsed trees. The name must be
    the allocator's base or a suffixed form of it. A node a person changed in HQ fails the comparison
    and reads as their own Hidden Value.
20. **A generated node Nova would name, add or drop differently is a fact for the first-publish
    register, never a refusal** (13.4): the reading lists every node it folded, and part 09 gets the
    difference from its own re-read of Nova's emission.
21. **A real attribute and its `vellum:` shadow must expand to one tree** (14), compared by the forms
    stage over the grammar's syntax tree with the form's own hashtag metadata. A difference is
    `shadow-disagrees`. A form saved with rich text off has shadows HQ's form builder does not read,
    and they are inert. A hashtag the head lists with no meaning takes the one the real attribute
    gives it, once per form. The comparison is this part's alone: part 08 writes none.
22. **The declaration is a list of choices with one proposed** (16.3): each declaration the content runs
    on, with and without the date-and-time split, the proposal narrowed to Android where HQ holds Web
    Apps off and keeping Web Apps where HQ holds it on. Content no choice runs is a new circumstance,
    `no-platform-runs-everything`, at each use, judged over the provisional document in every reading.
23. **A split question reads back as three ordinary questions** (16.4): a Hidden Value bound
    `xsd:dateTime` whose calculate is the clock-keeping join, beside a date and a time question. The
    reader gives the shape no name of its own.
24. **A generated key in `translations` is classified in the reading that meets it** (16.5), against
    the strings Nova's build makes of the document as read, wherever the menu or form the key names
    read whole. A key of a menu or form that holds a finding stands under that finding, and none is
    ever reported as `unrecognized` or left for a later reading to claim (Departure 11).
25. **A reference whose standing is project data's is handed off, never left unclaimed** (4.3, 12.4).
    A media path with no file and an itemset over a table the catalog lacks are recorded as hand-offs
    with their node; the caller settles each through part 11's pure rules in the same request, and
    acceptance holds that none is left (Departure 13).
26. **Nova's own defects never reach a person as HQ's content** (5.1). An `unrecognized` finding's
    `detail.name` is a surface key, or the value as the app writes it where the unclaimed thing is a
    value (an appearance, 9.2); what went wrong inside the reader is a `ReaderDefect` returned beside
    the findings, which part 12 logs at error and never stores or shows.
27. **A translation left blank is held in another language and refused in the first** (12.2). A
    blank value in a language other than the first, where the first language holds text, reads as no
    translation, and Nova's first publish writes the first language's text there, as HQ's form
    builder does on every save. A blank in the first language where another language holds text
    stays a refusal, under an entry of its own.
28. **The reader is handed the project space's levels and the record dialect's judge, and learns
    worker and location properties from the app** (2.2, 2.3). The structure stage puts HQ's levels
    on the draft, and the expression stage runs part 08's `readExpressions` twice, the first run
    only to learn which worker and location properties the app reads.
29. **Text CommCare HQ's build reads as an instance is a finding at the form** (7.4, 15): a form's
    name in the first language, and a Connect block's name or description, for which part 03's
    `instanceScanRead` answers. The entries are part 03's (its section 5.1), and the reader adds
    neither.
30. **A logo entry CommCare HQ's uploader did not write is refused** (6.1): a slot whose path is
    not the uploader's, or whose entry holds no `m_id`.

---

## Executed during planning

Read in full unless a range is named.

- **The plan's rules**: `docs/plans/hq-round-trip/README.md` and the outline.
- **The plan's other parts**, for each thing of theirs this part uses: parts 01, 03, 04, 05 and 07
  to 14, at the sections this part cites where it uses them.
- **The emitter**: `lib/commcare/CLAUDE.md` (the barrel, multilingual emission, the surface manifest,
  typed form expression emission, validation counts, hidden fields, capture uploads, the Vellum
  dual-attribute pattern, bare hashtags, markdown itext, secondary instances, repeat modes, sections,
  the oracles, typed FormPath, the meta block, form reads, Connect, case-backed choices);
  `xform/builder.ts` (whole); `xform/generatedNodes.ts` (whole); `xform/constraintMessage.ts`;
  `xform/itextIds.ts`; `multimedia/itextMedia.ts`; `xform/bindType.ts`; `xform/captureUpload.ts`;
  `xform/countPlacementRow.ts`; `xform/datetimeCaseValue.ts`; `xform/captureUrlNode.ts`;
  `xform/namespace.ts`; `xform/queryRepeatNames.ts::queryRepeatBaseNames`;
  `xform/repeatCountNames.ts::repeatCountBaseName`; `xform/caseOps.ts` (`caseScalarTextValueCalculation`,
  `caseScalarTextValueGuard`, `saveToCaseBlockShape`, `blockNames`, the guard and keyed-repeat sites);
  `xmlParse.ts`; `hq/publishedCaseBlocks.ts` (whole); `hq/appSource.ts` (its types).
- **The manifest**: `surface/schema.ts`, `surface/gates.ts`, `surface/schemaDefaults.ts`,
  `surface/__tests__/loadManifest.ts`; every entry of `entries/questions.json` by id, disposition, value
  class and first key, with the `item` and `dispositionCell` of the seventy this part claims; the
  `Form types`, `Form fields`, `Shadow forms`, `Module types`, `Module fields` and `Application`
  sections of the other area files; `surface.json`'s families and its `xform:`, `mug:`, `jr-type:`,
  `itext-form:`, `vellum-markup:` and `appearance:` items; the declared keys and defaults of
  `Application`, `Module`, `AdvancedModule`, `Form`, `AdvancedForm` and `BuildSpec`.
- **The lane's reading of the same manifest**: `proof/checks/manifest_usage.py` (its header, `Use`,
  `app_json_uses`, `_walk_object`, `_element_path`, `qualified`, `PREFIXES`, `xform_uses`,
  `_question_uses`, `standing`, `_standing_plan`, `_evaluate`); `proof/checks/manifest_value_classes.py`
  (`AppearanceRule`, `appearance_rules`, `appearance_matches`, `element_facts`, `ANDROID_INSIDE`, the
  registry lines of the appearance readers); `proof/checks/differences.py::pointer_token`.
- **The domain**: `lib/domain/fields/*.ts` (every kind's schema), `prose.ts`, `localization.ts`
  (`translationEntrySchema`, `appLocalizationSchema`, `translationSourceFingerprint`),
  `translationFill.ts`, `translationUnits.ts::storedTranslationValue`, `fieldValueType.ts`,
  `expression/datePattern.ts::isClockKeepingDate` and `clockKeepingJoin`,
  `expression/formStructure.ts`, `queryRepeatPlacement.ts`, `languageRegistry/index.ts::languageCodeVerdict`;
  `lib/doc/platformDeclaration.ts`; `lib/doc/datetimeSplit.ts` (header and types);
  `lib/commcare/xpath/formParseScope.ts`, `formNodeProjection.ts`, `formSyntax.ts`,
  `expressionAst.ts::parseFormExpression`; `languageWire.ts`; `biome.json` (the override that holds the
  `lib/commcare` rule, and its `includes`).
- **Vellum**: `parser.js` (whole); `writer.js::createSetValues` and its `vellum:ignore` and hashtag
  writers; `javaRosa/plugin.js::loadXML`, `contributeToModelXML` and `onXFormLoaded`;
  `javaRosa/itext.js::ItextForm.getValueOrDefault`; `javaRosa/util.js` (its exports);
  `form.js` (`inferHashtagMeanings`, `normalizeHashtag`, the hashtag map).
- **commcare-hq**: `xform.py` (`VELLUM_TYPES`, `VELLUM_TYPE_INDEX`, `_infer_vellum_type`,
  `XForm.get_questions`, `XForm.add_setvalue`, `VALID_VALUE_FORMS`, the advanced preload loop of
  `_create_casexml_advanced`).
- **commcare-core**: `Recalculate.java::wrapData`; `SetValueAction.java::processAction`;
  `ActionController.java::triggerActionsFromEvent`; `FormDef.java::initialize`.
- **Also read in Nova and the lane**: `lib/domain/questionId.ts` (whole);
  `lib/domain/expression/types.ts::SlotContextRef`; `xform/caseSaveReferences.ts::caseSaveReferences`;
  `xmlParse.ts::tryParseXml`; `appStringKeys.ts` (its import of `surface.json`);
  `docs/testing.md` ("Performance and verification"); `lib/doc/commitVerdicts.ts` (its imports of
  `lib/commcare`); `lib/commcare/hq/locations.ts::HqLocationType`; the manifest entries this part
  copies fields from, as `lib/commcare/surface/entries/*.json` holds them, and
  `surface/schema.ts::inventoryEntrySchema`; `xform/builder.ts::buildFieldParts` (the constraint
  count's bind and the scalar check); `proof/checks/manifest_usage.py::xform_vocabulary`,
  `namespace_read_holds`, `qualified` and `_element_path`;
  `proof/checks/manifest_value_classes.py::VALUE_CLASSES` and `element_facts`, and the known gaps
  of `proof/checks/test_manifest_value_classes.py`; `proof/CLAUDE.md` ("The register is strict").
- **Also read in Vellum and commcare-hq**: Vellum `parser.js::initHashtags`, `parseVellumAttrs` and
  the `group` adaptor of `buildControlNodeAdaptorMap`, `form.js::inferHashtagMeanings` and
  `makeHashtagInferencer`, `xpath.js::hashtagToXPath` and
  `javaRosa/itext.js::ItextForm.getValueOrDefault`; commcare-hq
  `models/forms.py::FormSource.__set__`, `xform.py::XMLNode.tag_xmlns`,
  `models/applications.py::Application.scrub_source`, `util.py::update_form_unique_ids` and
  `models/modules.py::ModuleBase.get_or_create_unique_id`.
- **Also read, for sections 6.1, 7.4, 8.2, 10.2 and 16.5**: commcare-hq `id_strings.py` (every
  `@pattern`), `hqmedia/views.py::ProcessLogoFileUploadView.process_upload`,
  `hqmedia/models.py::CommCareMultimedia.get_media_info`, `cloudcare/utils.py::format_app_doc`,
  `models/applications.py::Application.create_profile`, `xform.py::parse_xml` and
  `_infer_vellum_type`, `reports/formdetails/readable.py` (its two tests of a question's type) and
  `export/models/new.py::FormExportDataSchema.datatype_mapping`; commcare-core
  `FormEntryController.java::isHostWithAppearance`; Nova's `lib/commcare/compiler.ts::compileCcz`
  (where it fills `appStrings` and `appStringUnits`, and its three oracle gates),
  `lib/domain/translationUnits.ts::translationUnitOwnerKinds` and
  `lib/domain/formWireName.ts::formWireName`; and the two retained reads run R1 names, form by
  form.

**Claims corrected.**

- **Claim corrected (`lib/commcare/CLAUDE.md`, "The surface manifest").** "Server code reads gate
  entries through `surface/gates.ts`, never `surface.json`, so a server bundle carries the gate entries
  alone." `surface/schemaDefaults.ts` imports `surface.json`, and `lib/deployment/hqSourceBaseline.ts`,
  `preflight.ts` and `service.ts` import it. `appStringKeys.ts` imports `surface.json` too. A server
  bundle already carries the generated surface. This part replaces the sentence ("Contracts").
- **Claim corrected (the outline, item 9).** "The reader proposes the platforms the content runs on
  (`contentRunsOn`, the rule of `planContentDeclaration` reduced to platforms)". `planContentDeclaration`
  returns one declaration, and offers the split only where the content runs on neither platform. An app
  that runs on Android alone only because of its date-and-time questions gets `runsOnlyOn: "android"`
  and no offer, though the split would let it run on both. Section 16.3 plans the choices.
- **Claim corrected (the outline, item 10).** "reads `plainLabel` from an item's `hasMarkdown`".
  `hasMarkdown` is a property of Vellum's in-memory item (`javaRosa/plugin.js::loadXML`). In a source
  the fact is whether the text's entry holds a `<value form="markdown">`.
- **Claim corrected (the outline, item 10).** "Model iteration's admission widens from step 5's
  structural rule to the research's load-time rule for imported repeats." Telling a query that reads an
  answer set at load from one that reads a blank answer needs an analysis of load-time values Nova does
  not have, and `queryRepeatPlacement.ts::queryRepeatPlacementNeeds` would have to hold the same
  analysis for the gate, Preview and both exports. Departure 1.

**Facts verified at source**, each one this part's design rests on.

- **No file holds a predicate per entry.** An allowing entry's value class is prose the lane never
  reads (`proof/checks/manifest_usage.py`, its header: "An allowing entry's class is what its row
  describes and the check does not read it"; `::standing` says the same), and `lib/commcare/surface/`
  holds no value-class predicates. None is added: a predicate per entry id would be a second
  manifest. The reader's own code decides the class at each claim site and names the entry; the
  claim table (4.2) and the variants hold it.
- **`unique_id` in a source read.** A form's is minted anew by every source read and a menu's is as
  stored: `models/applications.py::Application.scrub_source` calls
  `util.py::update_form_unique_ids`, which re-mints form ids, and a menu's id is minted once
  (`models/modules.py::ModuleBase.get_or_create_unique_id`; part 10, 2.2). So the walker keys menus
  by `unique_id` and forms by position and `xmlns`.
- **A source's own names bind.** A relative path and `current()` resolve through the form-node
  graph, and a form brought in carries its generated nodes under whatever names it was written
  with, which may not be the names Nova's projection gives them today.
  `xpath/formParseScope.ts::FormParseScope.sourceProjection` takes a projection under other
  physical names, so the reader hands part 08 the source's own names (17.2) and nothing is renamed
  before binding.
- **Nova's build is total over a document the gate admits, and over no other.**
  `compiler.ts::compileCcz` throws where a generated form, suite or media suite fails its oracle,
  and the oracles are held to pass only for a document the gate admitted. So the app strings of a
  document that holds a stand-in or a placeholder exist only where the gate admits that document.
  Section 16.5 rests on this.
- **Every generated app string that names a menu names it by position.** In `id_strings.py` every
  `@pattern` that names a menu holds `m%d` as its first number, and one that names a form holds
  `m%df%d`, with one exception: `custom_assertion.%s.%d` (`custom_assertion_locale`), whose `%s`
  is `m<n>`, `m<n>.f<n>` or `root`, so its pattern names a menu or a form and holds neither
  number. Nova's build writes no string under that id: nothing under `lib/` spells
  `custom_assertion.` but the generated `surface.json`, which lists the pattern. Nova's build
  fills the other ids from a menu's, a form's, a list's and a search's own text (`compileCcz`,
  `appStringUnits`), and from one unit that is no menu's: a case property's option label
  (`translationUnitOwnerKinds`, `case-property-option`), which feeds an enum string in every list
  that shows the property.
- **The retained save holds no generated node that was saved.** In
  `proof/hq-reads/navigation-base/app-source-after-form-builder-save.json` the one form HQ's form
  builder saved holds one question and no generated node, and the form that holds generated nodes
  (`nova_trimmed_name`, `nova_trimmed_external`) was not saved: its source is byte-equal to the
  one in `app-source.json`. Run R1 is written for that.

---

## Written and not yet run

Nothing was run for this part: no test, no typecheck, no lane. Every Vitest named under "Tests" is
an ordinary CI test. One of them decides something.

**R1 (ordinary CI, `lib/commcare/reader/xform/__tests__/vellumSavedSource.test.ts`).** Whether a
save in HQ's form builder leaves each generated node in the shape section 13 recognizes. It has two
cases, because no one retained read holds both halves of the question:

- **The save's own respelling.** `proof/hq-reads/navigation-base/app-source-after-form-builder-save.json`
  is a Nova export after HQ's form builder saved one of its forms with nothing changed, and
  `app-source.json` beside it the same export before. The form that was saved holds no generated
  node ("Executed during planning"), so this case holds one thing: what a save respells (attribute
  order, added `vellum:` attributes, the hashtag blocks) does not disturb the read. The two
  readings give equal form drafts.
- **A generated node after a save.** `proof/hq-apps/hq-nova-then-builder/app-source.json`, read
  through `retainedBase`, is a base whose every form was saved in the form builder after Nova
  wrote it, and it holds Save to Case blocks, guards, keyed creates and a lifted validation count
  (part 14, section 6.2). Every node of a saved form that carries an allocator name (13.1) folds
  as the generated node of that purpose, and none reads as a Hidden Value: the base holds no
  question an author named like one of Nova's. This case needs the base's retained read in the
  tree, so it joins the test with that read (part 14 says how a base is retained).

Each outcome is settled before the merge:

- *A: every allocator-named node of each saved form folds, and the respelling case reads to equal
  drafts.* Section 13 stands.
- *B: a generated node of a saved form fails its comparison because the save re-spelled it* (an
  attribute added or dropped, a type re-cased). The rule of 13.2 for that purpose gains the saved
  spelling as a second accepted tree, written from the retained read, and the test keeps both
  spellings. No other file changes.
- *C: the save changed what the node computes.* That is a defect of the emitter, not of the
  reader. The emitter is corrected in this step, in the file that writes that node (13.2's
  "Emitter" column names it). The fix changes bytes every export writes, so the uncorrected export
  is retained as a control under `proof/controls/`, named by the entry the fix adds to
  `proof/fixed-defects.json` (`proof/CLAUDE.md`, "The register is strict"); the base is emitted
  and retained again, and R1 runs again.

The retained reads hold the generated nodes their documents have. The purposes they do not exhibit
are held by the form fixed point over the fuzz corpus ("Tests").

The reader's time is no run of this part. An app's source is refused above part 12's byte bound
before it is parsed, and the test at that bound, which holds each synchronous piece of a read
under five seconds, is part 12's (its "Tests"); `readHqApp` is one such piece. What this part
holds is deterministic: `readerWork.test.ts` ("Tests") reads a form of 200 questions and one of
400 and requires each counter of `ReadWork` (2.2) to at most double, so a stage that goes
quadratic fails there with no clock in the test.

---

## 1. What Nova does today

- **Nothing reads an HQ app into a document.** `lib/commcare` is an emission boundary:
  `expander.ts::expandDoc` builds HQ's JSON and `xform/builder.ts::buildXFormSource` each form's source.
  Three things read anything back: `xpath/expressionAst.ts::parseFormExpression` reads form-logic text
  for a slot of an existing document; `hq/publishedCaseBlocks.ts::publishedCaseBlocks` reads which case
  blocks HQ's build would write, and has no production caller; `hq/appSource.ts::readHqAppSource` types
  a source read for the publish path.
- **The manifest is read at run time for three things only.** `surface/gates.ts` reads
  `entries/gates.json` for a toggle's identity; `surface/schemaDefaults.ts::schemaPropertyDefault`
  reads `surface.json` for a declared property's default, for the drift comparison; and
  `appStringKeys.ts` reads `surface.json`'s `app-string-id:` items for
  `GENERATED_APP_STRING_PATTERNS` and `translationKeyOwner`. The six inventory files are read by
  tests alone, through `surface/__tests__/loadManifest.ts`.
- **A form's source is authored content, generated nodes and Save to Case blocks.**
  `buildXFormSource` writes the head (`h:title`, the model: the primary instance, the secondary
  instances its printed trees read, binds, setvalues in data-tree order, itext with one translation per
  language) and the body. It writes no meta block, no basic or advanced case block and no
  `<vellum:hashtags>`. Every executable attribute prints from a wire tree
  (`xpath/wire/serialize.ts::serializeWire`), the real attribute in `xform` mode and its shadow in
  `vellum` mode.
- **Every generated name comes from one allocator.** `xform/generatedNodes.ts::planGeneratedNodes`
  names sixteen purposes (`GeneratedNodePurpose`) and the fixed containers, reserves no name, and gives
  a taken base the suffix `_<n>`.
- **Text is itext with Nova's own ids.** `xform/itextIds.ts::fieldItextKey` joins a field's authored
  path with `-`; `builder.ts::addItext` writes a default value, a `markdown` copy unless the owner holds
  `plainLabel`, and media values (`multimedia/itextMedia.ts::itextMediaValues`). A validation message
  that shows a value is composed in the bind (`xform/constraintMessage.ts::protectConstraintMessage`),
  with a carrier node and helper forms named `__nova_*`.
- **XML is parsed by one parser.** `xmlParse.ts::parseXml` is SAXES with namespaces on, into a
  `domhandler` tree; it refuses a DTD and XML 1.1. `publishedCaseBlocks.ts` holds the only namespace-aware
  helpers (`scopeOf`, `isElement`, `namespacedAttribute`, `elementChildren`), private to that file.
- **The declaration a document's content allows has one planner.**
  `lib/doc/platformDeclaration.ts::planContentDeclaration` gives one declaration or says the content
  runs on neither platform, and `lib/doc/datetimeSplit.ts::planDatetimeSplits` plans the split.
- **A person meets none of it.** There is no finding type and no place type today; part 01 adds
  both (its section 8).

The forms stage reads into four things this step adds on the emission side, and writes each back
with the production emitter, so each exists in the tree before the code that reads into it: a Text
question's `keypad` and the one writer of `appearance`, `xform/appearance.ts::fieldAppearance`
(part 03); a prose `value` part and `canonicalProseAtom` (part 03); `plainHelp`, `Form.plainText`,
and no `markdown` copy on a hint or a validation message (part 03); hyphens in question ids and
the doubled hyphen of `fieldItextKey`, one-option selects and quote marks in a choice value (part
04).

---
## 2. The package and its public function

### 2.1 The package

`lib/commcare/reader/` is new. Nothing in it is exported from `lib/commcare/index.ts`. These are
its own modules; "Files" lists every other file this part makes or changes.

| File | Exports |
|---|---|
| `reader/index.ts` | `readHqApp`, `STAGES`, `ReaderStage`, and the types of `types.ts` |
| `reader/types.ts` | `ReaderInput`, `ReaderOptions`, `ReadOutcome`, `ReadDraft`, `ReadMenuAndFormIdentities`, `ReadFacts`, `ReadFormFacts`, `ReadGeneratedNode`, `ReadWork`, `ReaderDefect`, `ReaderLookupCatalog`, `ReaderLookupTable`, `ReaderOrganization`, `ReaderMediaIndex`, `ReaderMediaResolution`, `ReadMediaReference`, `PendingMedia`, `UnreadTable`, `AppStringTable` |
| `reader/claims.ts` | `Claim`, `ClaimUse`, `take`, `derived`, `drop`, `refuse`, `account`, `defineClaims`, `claimRegistry` |
| `reader/accounting.ts` | `Accounting`, `Admitted`, `ClaimSite`, `ClaimRecord`, `HandOffRecord`, `ClaimLog`, `serializeClaimLog` |
| `reader/jsonCursor.ts`, `reader/xmlCursor.ts` | `JsonCursor`, `HandOffKind`; `XmlCursor`, `XmlNode`, `elementWhere` |
| `reader/place.ts` | `appPlace`, `appSettingsPlace`, `languagesPlace`, `menuPlace`, `formPlace`, `questionPlace`, `placeOrder`, `whereText`, `placeKey` |
| `reader/defects.ts` | `READER_DEFECT_CODES`, `ReaderDefectCode`, `ReaderDefectWhy`, `readerDefect` (5.1) |
| `reader/context.ts` | `ReadContext`, `MutableReadFacts`, `DraftApp`, `DraftModule`, `DraftForm` |
| `reader/pendingExpressions.ts` | `PendingRegistry` (11.1), beside part 08's record, which the file also holds: `ReadMode`, `PendingExpression`, `pendingPlaceholder` (part 08, section 2.5) |
| `reader/provisional.ts` | `provisionalDocument`, `bindExpressions` (2.3) |
| `reader/appShell.ts`, `reader/languages.ts` | `readApplication`; `languageIdentityForHqCode`, `readLanguages` |
| `reader/structure.ts` | `readStructure` |
| `reader/translations.ts` | `TranslationSink`, `translationEntryFor` |
| `reader/generatedTranslationKeys.ts` | `classifyGeneratedTranslationKeys`, `GeneratedKeyVerdict`, `HeldGeneratedKey`, `generatedKeyOwner`, `GeneratedKeyOwner`, `repositionGeneratedKey` (16.5) |
| `reader/assemble.ts` | `assembleDocument`, `READER_CANONICAL_CHOICES`, `ReaderCanonicalChoice` |
| `reader/xform/*.ts` | section 8.1 lists them |

Other parts own the rest of the package, and each states its own file: `reader/identity.ts` (part
10, sections 2.1 to 2.3), `reader/syntaxCompare.ts` and `reader/hqInterpolation.ts` (part 08,
sections 3.1 and 6.1), `reader/worldEntities.ts` (part 11, sections 11.2 and 11.5),
`reader/expressions/` (part 08) and the directories of part 07's stages. Two of those are used
before the expression reader exists: the forms stage compares trees through
`syntaxCompare.ts::sameXPathText` under its form rows (13.1), and part 07's stages call
`hqInterpolation.ts`. Neither file reads anything else of the expression reader.

### 2.2 The function

```ts
// lib/commcare/reader/index.ts
import "server-only";

/** Read one HQ app into a Nova document, or into the account of why it cannot be held. */
export function readHqApp(input: ReaderInput, options?: ReaderOptions): ReadOutcome;
```

```ts
// lib/commcare/reader/types.ts
export interface ReaderInput {
	/** The app's id, derived from the reading's id (part 12). */
	readonly appId: string;
	/** The project space the source was read from, for a capture's link (13.2, `url`). */
	readonly target: { readonly origin: string; readonly domain: string };
	/** Part 05: the source as served, with `raw` and each form's attachment. */
	readonly source: HqAppSource;
	/** Part 05: the aligned menus, each form's real id and HQ's own question summary. */
	readonly modules: readonly HqAlignedModule[];
	/** Part 10, section 2.3: `mintingResolver(appId)` for a reading; `matchingResolver` for
	 *  acceptance's re-read, proof 6 and part 15's two readings (its section 2.2). */
	readonly resolver: IdentityResolver;
	readonly lookup: ReaderLookupCatalog;
	readonly organization: ReaderOrganization;
	readonly media: ReaderMediaIndex;
	/** The local app strings Nova's build gives a document, or `null` where Nova's gate refuses
	 *  the document, which Nova's build cannot write (16.5). Pure. */
	readonly appStrings: (doc: BlueprintDoc) => AppStringTable | null;
	/** Whether the record dialect prints a tree and reads it back (part 08, section 2.5).
	 *  `RecordDialectJudge` is part 08's type (`reader/expressions/index.ts`). Pure. */
	readonly recordDialect: RecordDialectJudge;
	/** Whether the source project space applies "save only if changed", as part 05's probe of
	 *  it answered; absent where the source holds no `update_mode: "edit"` and no probe was made.
	 *  Part 07 reads it (its section 3); nothing of this part does. */
	readonly saveOnlyEditedApplied?: boolean;
}

export interface ReaderOptions {
	/** `counts`, the default, keeps claim counts by entry. `full` also keeps every claim. */
	readonly claims?: "counts" | "full";
}

/** The tables of the source project space the app may read, with the ids part 11 gives them. */
export interface ReaderLookupCatalog {
	table(tag: string): ReaderLookupTable | undefined;
	/** What `FormParseScope.lookup` and the checker read. */
	readonly definitions: LookupDefinitionIndex;
}
export interface ReaderLookupTable {
	readonly tableId: LookupTableId;
	/** A column by the field name HQ holds. */
	column(fieldName: string): LookupColumnId | undefined;
}

/** HQ's levels as part 11 read them; the slugs an app reads are learned from the app
 *  (part 11, 11.5). */
export interface ReaderOrganization {
	readonly levelCodes: readonly string[];
	/** `lib/commcare/hq/locations.ts::HqLocationType`, on `main`; part 05 reuses its reader. */
	readonly levels: readonly HqLocationType[];
}

export type ReaderMediaResolution =
	/** `multimedia_map` holds the path and the reading has an asset for its file. */
	| { readonly kind: "asset"; readonly assetId: string; readonly mediaKind: MediaKind }
	/** `multimedia_map` holds no entry for the path. */
	| { readonly kind: "no-entry" }
	/** The entry names no file Nova can ask for, or HQ serves none. */
	| { readonly kind: "unreadable" };
export interface ReaderMediaIndex {
	resolve(path: string): ReaderMediaResolution;
}

export type ReadOutcome =
	| { readonly kind: "read"; readonly draft: ReadDraft;
	    readonly work: ReadWork; readonly claims: ClaimLog;
	    readonly defects: readonly ReaderDefect[] }
	| { readonly kind: "account"; readonly findings: readonly Finding[];
	    readonly work: ReadWork; readonly claims: ClaimLog;
	    readonly defects: readonly ReaderDefect[];
	    /** What `ReadFacts.unreadTables` held when the reading closed (17.3). */
	    readonly unreadTables: readonly UnreadTable[];
	    /** Whether any slot reads the `locations` instance (2.3). */
	    readonly readsLocations: boolean };

/** What the reader minted for the menus and forms the document holds (part 10, 3.1). */
export interface ReadMenuAndFormIdentities {
	/** Every menu of HQ's app the document holds, a folded hidden menu under its synthetic UUID. */
	readonly modules: readonly { readonly uuid: Uuid; readonly uniqueId: string }[];
	readonly forms: readonly {
		readonly uuid: Uuid; readonly xmlns: string; readonly moduleUniqueId: string;
	}[];
}

export interface ReadDraft {
	/** The document, before the gate. Part 09 runs the gate and export readiness over it. */
	readonly doc: BlueprintDoc;
	/** `diffDocsToMutations(emptyBlueprintDoc(appId), doc)`: the birth's construction batch. */
	readonly batch: readonly Mutation[];
	readonly identities: ReadMenuAndFormIdentities & { readonly entries: readonly IdentityMapEntry[] };
	readonly declaration: DeclarationChoices;
	readonly facts: ReadFacts;
}

/** Something the reader itself got wrong. Logged at error by the caller; never stored or shown. */
export interface ReaderDefect {
	readonly place: HqPlace;
	/** The surface key of the `unrecognized` finding it stands behind. */
	readonly name: string;
	/** What went wrong, for a developer: text only `defects.ts::readerDefect` builds, from closed
	 *  slots, so it holds no word of an app (5.1). */
	readonly why: ReaderDefectWhy;
}

/** Work done, a function of the input alone: JSON values and XML nodes visited, texts read with
 *  `readFormSyntax`, and expected trees built for a generated node (13.1). */
export interface ReadWork {
	readonly nodes: number;
	readonly syntaxReads: number;
	readonly rebuilds: number;
}
```

`ReadFacts` is section 17.3. `kind: "read"` means no finding of any standing was produced; one finding
makes the outcome `account`, with every finding of the pass in `placeOrder` (5.2). A `read` may still
hold hand-offs (4.3): `draft.facts.pendingMedia` and `draft.facts.unreadTables` list what the caller
must settle before the reading is accepted. An `account` carries the two facts part 11's findings
need where there is no draft: `unreadTables`, and `readsLocations`, so a table or a place Nova
cannot hold joins the same account (part 11, 14.1, `projectDataReadsOf`). `ReadStanding` and
`FindingStanding` are part 01's (its 2.1): the second is the three of the first that make a finding.

`ReadWork` is what `readerWork.test.ts` reads ("Tests"): three counters that grow with the input
and with nothing else, so a stage's growth can be held with no clock.

`readHqApp` reads nothing of `HqAlignedForm.questions`, HQ's own question summary, which is part
09's for its check 5. A re-read of Nova's emission may pass an empty list there.

`ReadMenuAndFormIdentities` is defined here and nowhere else. Part 10's
`lib/deployment/adoption.ts` (its section 3.1) imports it from `@/lib/commcare/reader` and
declares none, because `lib/commcare` cannot import that file: no production file of `lib/commcare`
imports `lib/deployment`, and `lib/deployment` imports `lib/commcare`.

**Purity.** `readHqApp` reads its arguments and module constants (the manifest index, `surface.json`'s
defaults and appearance rules, the language registry) and nothing else: no clock, no randomness, no
environment, no store, no network. Two calls with equal input give deeply equal output, which
`readerPurity.test.ts` holds. The resolver is the one stateful argument: a call consumes it, so a
caller that reads twice passes a fresh one. It never throws for content: a malformed attachment, an
unknown key and a shape no stage expects are findings. It throws only for an input that breaks its own
contract (an `HqAlignedModule` list whose length differs from the source's), which is a defect of the
caller, and the caller logs it at error and gives `read-back-differs`. It also throws three
invariants, each a defect of Nova's own code and no fact of an app: part 08's two, its C10 and
C11, and this part's one, a document read with no finding that Nova's gate refuses (16.5; "Copy",
C9).

**Logging.** The reader holds no logger. Each `unrecognized` finding it produces carries in
`detail.name` what part 01's 8.3 asks for (4.4), and each defect of the reader's own (the twelve of
5.1) is a `ReaderDefect` in `defects`, its `why` built from closed slots alone. `lib/deployment/reading/`
(part 12) logs each finding and each defect at error with the reading's id when it answers the
account, and shows no defect. A pure function that logged would not be pure under a
`matchingResolver` re-read.

### 2.3 The pipeline

`readHqApp` builds one `ReadContext` and runs the stages in this order: structure, case management,
menus, then expressions. Each stage is a function of the context exported by its module and listed
in `reader/index.ts::STAGES`:

```ts
// lib/commcare/reader/index.ts
export type ReaderStage = (ctx: ReadContext) => void;
/** The stages, in the order of the table below. */
export const STAGES: readonly ReaderStage[];
```

Part 07's functions take the draft as a second argument (`readMenus(ctx, app)`); their entries in
`STAGES` pass `ctx.draft`.

| # | Stage | Module |
|---|---|---|
| 1 | the application: its own keys, languages, the floor | `appShell.ts::readApplication` |
| 2 | menus and forms: document types, identity, their own keys; the project space's levels onto the draft | `structure.ts::readStructure` |
| 3 | each form's source: fields, text, media references, generated nodes | `xform/index.ts::readForms` |
| 4 | a menu's own shape: its case type, kind and nesting, which every form's reading needs | part 07, `menus/index.ts::readMenus` |
| 5 | case management and the case catalog; settles the generated candidates of 13.3 | part 07, `caseManagement/index.ts::readCaseManagement` |
| 5b | mint each form's fields in document order, then register their expressions (11.1) | `xform/index.ts::mintFields` |
| 6 | case lists and search, every XPath registered as pending; then the entry facts compared and the links' expressions registered, which need every entry's structure and nothing bound | part 07, `caseList/index.ts::readCaseLists`, `search/index.ts::readSearches`, then part 07's `caseManagement/index.ts::compareEntryFacts` and `menus/afterSubmit.ts::registerLinkExpressions` |
| 7 | the provisional document, then every pending expression bound against it | `provisional.ts::bindExpressions`, which builds `provisional.ts::provisionalDocument`, calls part 08's `readExpressions` twice with `worldEntitiesFromReads` between and applies the second answer |
| 8 | what part 07 decides over the bound document | part 07, `settleCaseManagement`, `settleCaseLists`, `settleSearches`, `settleMenus`, in that order |
| 9 | text: translations from the bound outputs | `xform/prose.ts::finishText` |
| 10 | what the bound document decides for a form: repeat counts, model iteration, load order, a Hidden Value's bind type | `xform/afterBinding.ts::finishForms` |
| 11 | the declaration's verdict, the late claims, the close, and the draft where no finding stands | `assemble.ts::assembleDocument` |

This is the order "structure, case management, menus, then expressions" with one reading of it made
exact, the one part 07's 2.1 argues (Departure 14): a menu's case type, kind and nesting are
structure every form needs, so `readMenus` runs before case management, and what the word menus
names in that order (registration, links, deep links, display conditions) is settled last, in
`settleMenus`, after expressions. `settleMenus` is last of the four because a link's held-case guards are
checked by projecting the whole form's after-submit. The entry facts are compared at the end of stage 6
and not after the expressions (part 07, 2.1): every key a fact reads is structure stages 2 to 6 write,
the frame cannot withdraw a claim once made, and part 08 takes the verdict before it binds, as
`ExpressionReadEnv.entryFactsRefused` (17.2).

**The levels.** `readStructure` puts
`levelsFromHq(input.organization.levels, ctx.resolver).levels` on the draft (`DraftApp.levels`,
which `provisionalDocument` and `assembleDocument` write into the document), so the levels are in
scope when expressions bind. It raises none of that function's findings: part 11's
`readingProjectDataFindingsFor` raises them, once, and only where the app reads places (part 11,
14.1).

A stage absent from `STAGES` leaves its keys unclaimed, and stage 11 turns each into `unrecognized`
(4.4). So a reader with a stage missing reads every app that needs that stage to an account and
admits nothing it cannot read. The frame needs no stub and no flag while its stages are written.

**The provisional document (stage 7).** `provisional.ts::provisionalDocument(ctx)` builds a
`BlueprintDoc` from the drafts as they stand, in every reading, whether or not a finding stands:

- every draft menu, form and field with the slots stages 1 to 6 set, each required expression slot
  holding `pendingPlaceholder` (part 08, 2.5) and each optional one absent;
- each text in the source language, an `<output>` that is no literal as a prose `value` part holding
  `pendingPlaceholder("value")` (12.3);
- a menu or form that got a document-type finding (7.1) left out, with everything under it;
- a question that got a finding which leaves it no kind or no id Nova holds (9.1, 8.3) as a
  **stand-in**: a `hidden` field for a leaf and a `group` for a node with children, under the source's
  own name, minted like any field and marked `DraftField.standIn`. Its own logic attributes are
  covered by its finding (claimed under the same entry) and are not registered. It is there so a path
  another expression writes to it still binds: without it one refused question would make every
  expression that reads it a second, false finding.

A provisional document is never returned: `ReadDraft.doc` exists only where no finding stands, and
then no stand-in exists. Every draft form has its type by stage 7 (part 07 sets it, 7.4), so no
form is left out without a finding at or above it, which is what part 08's C10 holds.

`provisionalDocument(ctx)` may be called at any stage before 7; it returns a deeply frozen document,
the same object until a draft is next written. From stage 7 a stage patches `ctx.doc` only by
assigning a new frozen document, never by mutating it. Part 07's projections memoize by the document
object (`casePlacementPlan.ts`, `placement.ts`, `basicCaseSlots.ts`, each a `WeakMap` keyed by the
document), so a document changed in place would answer with the plan of its earlier state. The
mechanism is one writer: every stage changes a draft inside `ctx.writeDraft(() => { … })`, which
counts a revision, and `provisionalDocument` memoizes on that revision. `provisional.test.ts` holds
both halves: two calls with no write between return one object, and no stage function of `STAGES`
writes a draft outside `writeDraft`.

**Binding (stage 7).** Stage 7's entry in `STAGES` is `provisional.ts::bindExpressions(ctx)`. It
names part 08's exports (`readExpressions`, `ExpressionReading`, `ExpressionReadEnv`) and part
11's `worldEntitiesFromReads`, so it and `expressionEnvOf` (17.2) are written once those exist. It
builds `env` with `expressionEnvOf(ctx)` and calls part 08's
`readExpressions(doc, ctx.pending.list(), env)` twice, `doc` being `provisionalDocument(ctx)` each
time (part 08, 2.5; part 11, 11.5):

1. The first run is kept only for `ExpressionReading.worldReads`.
   `worldEntitiesFromReads(worldReads, ctx.resolver)` gives the worker properties and location
   properties the app reads, which the frame writes onto the draft (`DraftApp.userProperties`,
   `DraftApp.locationProperties`) inside `ctx.writeDraft`, so the provisional document built next
   holds them.
2. The second run, over that document, is the reading and the one applied:
   - `ExpressionReading.doc` becomes `ctx.doc`, the document stages 8 to 11 read and patch;
   - each `ExpressionClaim` is applied through `Accounting.claimEntry` (4.3) to the node of the
     registration its `source` names (`ctx.pending.site(source)`), and a claim whose `source` is
     `-1` to the `instance` element of the form at its `place` whose `src` its key names (part 08,
     9.3);
   - `ctx.pending.outcome(i)` answers from this run (11.1);
   - each row of `circumstances` is raised with `Accounting.circumstance`, under the row's name
     alone, and its registration's node is covered by it (`Accounting.cover`), so the close
     reports that node once. The row's reason goes to the defect's line and to no finding. The frame
     also records part 08's log line C9 for it as a `ReaderDefect` (D11), and its C12 where the
     row's `detail.reason` is `no-case-datum` (D12): the reader holds no logger (2.2), and part 12
     logs every defect at error;
   - each index of `ExpressionReading.ownerless` has its node covered by the finding that stands at
     or above its place (the registration's own question, else its form, else its menu, else the
     app), through `Accounting.cover`. Where none stands the frame throws part 08's C10;
   - each tag of `ExpressionReading.unreadTables` is appended to `ReadFacts.unreadTables` as
     `{ tag, place: { kind: "lookup-table", tag } }`, a tag already listed left as it is;
   - `rewrites` is kept on `ctx.facts` for part 09's register (its 11.2), and `rounds` as
     `ReadFacts.expressionRounds` for part 12's log. `declaredProperties` is not kept: the
     properties it lists are in the document the run gave, and no part reads the list;
   - `readsLocations` (2.2) is set: true where `worldReads.locationDataSlugs` holds a slug, or some
     tree of `ExpressionReading.bound` holds a `locations`, `location-field`, `location-level` or
     `owner-location-at-level` leaf, the leaves part 11's `documentReadsPlaces` names (its 11.1),
     found with `expression/walk.ts::walkExpressionTerms`.

```ts
// lib/commcare/reader/context.ts
export interface ReadContext {
	readonly input: ReaderInput;
	readonly accounting: Accounting;
	readonly app: JsonCursor;                 // class Application, artifact app.json
	readonly draft: DraftApp;
	readonly translations: TranslationSink;
	/** Every expression registered for stage 7, with the node each was read from (11.1). */
	readonly pending: PendingRegistry;
	/** Part 10's resolver, `input.resolver`. */
	readonly resolver: IdentityResolver;
	/** The bound provisional document; undefined before stage 7. Frozen; replaced, never mutated. */
	doc: BlueprintDoc | undefined;
	/** Facts stages append for `ReadFacts`, the hand-offs of 4.3 among them. */
	readonly facts: MutableReadFacts;
	/** The one way a stage changes a draft: runs `write`, then counts a draft revision. */
	writeDraft(write: () => void): void;
}
/** `ReadFacts` (17.3) while the stages fill it: every list appendable, every scalar assignable. */
export type MutableReadFacts = {
	-readonly [K in keyof ReadFacts]: ReadFacts[K] extends readonly (infer E)[] ? E[] : ReadFacts[K];
};
export interface DraftApp {
	appName: Admitted<string> | undefined;
	localization: AppLocalization | undefined;       // set by stage 1, translations filled at stage 9
	appSettings: Partial<BlueprintDoc["appSettings"]>;
	readonly modules: DraftModule[];                 // HQ's order
	/** The project space's levels (`levelsFromHq`). */
	levels: readonly OrganizationLevel[];
	/** What the app reads of the worker and of places (`worldEntitiesFromReads`). */
	userProperties: readonly UserProperty[];
	locationProperties: readonly LocationProperty[];
}
export interface DraftModule {
	readonly index: number;
	readonly uniqueId: string;
	readonly uuid: Uuid;
	readonly docType: "Module" | "AdvancedModule";
	readonly json: JsonCursor;
	readonly place: HqPlace;
	/** The slots stages set. `assembleDocument` parses the whole with `moduleSchema`. */
	readonly module: Partial<Module>;
	readonly forms: DraftForm[];
}
export interface DraftForm {
	readonly menu: number;
	readonly index: number;
	readonly xmlns: string;
	readonly uuid: Uuid;
	readonly docType: "Form" | "AdvancedForm";
	readonly json: JsonCursor;
	readonly place: HqPlace;
	readonly form: Partial<Form>;
	/** Set by stage 3; null where the source held no readable XForm (a finding was made). */
	xform: ReadXForm | null;
	/** Part 07's (its 5.2): each create block's `@case_id` path, absolute from the data root, to
	 *  the UUID of the operation read from it. Empty until `readCaseManagement` sets it. */
	operationIdPaths: ReadonlyMap<string, Uuid>;
}
```

A menu or form that got a document-type finding (7.1) has no draft and is skipped by every later stage.

**What part 07's words are in this frame.** Part 07 (`07-the-reader-cases-menus-lists.md`) speaks
this frame through a shorthand its section 2.2 lists, and this is each word's name here. Its
`ctx.claim(node, key, entryId)` and `ctx.inert` are a declared claim (`defineClaims`) used through
the cursor's `take`, `derived`, `drop`, `refuse` or `account`; its `node.rest()` is the close (4.4);
its `ctx.finding(entryId, place, detail?)` is `ctx.accounting.finding(claim, place, detail?)` (4.3);
its `ctx.pending(slot, text, mode, place)` is `ctx.pending.register(expression, at)` (11.1) with
part 08's `PendingExpression`, which returns the registration's index `i`, and a settle function
reads `ctx.pending.outcome(i)`; its `ctx.snapshot()` is `provisionalDocument(ctx)` before stage 7
and `ctx.doc` after, and its writes go to `ctx.draft` before stage 7, each inside
`ctx.writeDraft(() => { … })`, and to `ctx.doc` after; its `ReadApp`, `ReadModule` and `ReadForm`
are `DraftApp`, `DraftModule` and `DraftForm`, and its `app` argument is `ctx.draft`; its
`ctx.text(unitId, byLanguage)` is `ctx.translations` (12.5); and its `readNavMedia` reads each map
through `xform/media.ts::readMediaMap` (12.4) over `input.media`.

### 2.4 Who may import it

`biome.json`'s override for `@/lib/commcare` (`includes`: `components/**`, `app/**`, `lib/**`, less the
listed consumers) already excludes `lib/commcare/**` and `lib/deployment/**`. The reader's production
consumer is `lib/deployment/reading/` (part 12), its tests live under
`lib/commcare/reader/**/__tests__/`, and the lane's bundle is built from `proof/` (part 14), which the
override's `includes` does not cover. So the reader adds no consumer to the rule.

What changes is what the package is called. The rule's four messages each open "lib/commcare is
the one-way CommCare emission boundary.", which is false once this package reads as well as
writes, and so is every other sentence that says "one-way" of it. This part rewrites each
("Contracts"). Each of them is true only of import direction, which stands: nothing of
`lib/commcare` but its tests imports `lib/deployment`. `import "server-only"` at the head of
`reader/index.ts` and of `surface/inventory.ts` keeps both out of a client bundle, as
`hq/appSource.ts` does; a script or bundle that loads them under plain Node passes
`--conditions=react-server`, as `scripts/test-schema.ts` runs.

---

## 3. The manifest at run time

```ts
// lib/commcare/surface/inventory.ts
import "server-only";

export interface IndexedEntry {
	readonly id: string;
	readonly disposition: Disposition;
	readonly standing: ReadStanding;            // standingOf(entry)
	readonly cause: FixCause | null;            // fixCauseOf(entry)
	readonly subject: Subject | null;
	readonly surfaceKeys: readonly string[];
	readonly valueClass: string | null;
}
export interface InventoryIndex {
	entry(id: string): IndexedEntry | undefined;
	/** Every entry naming a surface key, in file order. */
	naming(key: string): readonly IndexedEntry[];
}
export function inventoryIndex(): InventoryIndex;
```

- **Loading.** The module imports the six area files statically (`./entries/application-and-settings.json`
  and the five others, as `gates.ts` imports `gates.json`), about 1.2 MB of JSON beside the 2.4 MB of
  `surface.json` the server already carries. `inventoryIndex()` parses them on its first call with
  `schema.ts::inventoryEntriesFileSchema`, builds the two maps, and memoizes; a file that fails the
  schema throws there, which a deploy's build and `manifest.test.ts` both meet first. It adds no rule:
  `standing` and `cause` are part 01's `surface/standing.ts::standingOf` and `fixCauseOf`.
- **Who else reads it.** Part 01's account never needs the index: a finding carries its standing,
  cause and subject. Part 14's parity judge loads the JSON files itself in Python.

`surface/__tests__/inventory.test.ts` holds the index to `loadManifest()`: the same entries, each
standing equal to `standingOf`, and `naming` equal to a scan.

---

## 4. The accounting cursor

### 4.1 What it guarantees

Three properties, each a mechanism and not a discipline:

1. **Everything used is claimed.** At the close, every JSON key at a value other than HQ's default and
   every XML element and attribute that no claim covers is the circumstance `unrecognized` at its
   place. The one thing that is neither is a hand-off (4.3): a use whose entry project data decides,
   recorded with its node and settled by the caller before acceptance.
2. **A claim says what the manifest says.** A claim names an entry. The cursor reads the entry's
   standing from the index and refuses a use the standing does not permit.
3. **A held value reaches the document.** `take` returns an `Admitted<T>`; a value never read is
   `unrecognized` too.

### 4.2 Claims are data

```ts
// lib/commcare/reader/claims.ts
export type ClaimUse = "take" | "derived" | "drop" | "refuse" | "account";
export interface Claim {
	/** The inventory entry id, exactly as its area file holds it. */
	readonly entry: string;
	/** The surface key this site reads, one of the entry's `surfaceKeys`; null where it has none. */
	readonly key: string | null;
	readonly use: ClaimUse;
}
export const take: (entry: string, key: string | null) => Claim;
export const derived: (entry: string, key: string | null) => Claim;
export const drop: (entry: string, key: string | null) => Claim;
export const refuse: (entry: string, key: string | null) => Claim;
export const account: (entry: string, key: string | null) => Claim;
/** Registers a module's claims under `<module>.<name>` and returns them unchanged. */
export function defineClaims<const T extends Record<string, Claim>>(module: string, claims: T): T;
export function claimRegistry(): ReadonlyMap<string, Claim>;
```

| Use | What the site does | Standings it is permitted under |
|---|---|---|
| `take` | reads the value into the document | `held` |
| `derived` | reads past a value the document already holds through another slot, which Nova writes back from that slot (a form's title, a path that is structure) | `held` |
| `drop` | reads past the value | `inert`, `kept` |
| `refuse` | makes a finding | `not-yet`, `never`, `fix-in-hq` |
| `account` | carries no value: drops under `inert` or `kept`, makes a finding under the other three | every standing but `held` |

`account` is for a key whose value never reaches the document whatever its standing (a setting Nova
does not own, a server record). A manifest edit that moves such an entry between kept, inert and
refused, in this step or in step 7, then changes no reader code. An entry that becomes `held` needs
code to read it, and its claim then fails the test below until it is a `take`.

Every claim in the reader is declared in a module-level `defineClaims` call and used by reference, never
built at a call site, so `reader/__tests__/claimsBindManifest.test.ts` can hold all of them without
running the reader: for each registered claim, the entry exists in `inventoryIndex()`; its standing
permits the use; `key` is one of the entry's `surfaceKeys` (or is `null` and the entry holds
`noSurfaceKey`). The test imports every reader module so each registers. It is the test that fails when
a manifest edit and the reader disagree, naming the claim and the entry.

Where one key's values are split among entries by value class, the site holds one claim per class and
its own code picks. That code is the reader's statement of the class; the variants (part 14,
section 7) and the parity judge hold it to the manifest's words.

### 4.3 The API

```ts
// lib/commcare/reader/accounting.ts
export class Admitted<T> {
	/** The claimed value. Reading it marks the claim consumed. */
	get value(): T;
}
export class Accounting {
	constructor(index: InventoryIndex, options: { readonly log: "counts" | "full" });
	/** A cursor over the app's root object, class `Application`, artifact `app.json`. */
	json(root: Readonly<Record<string, unknown>>, place: HqPlace): JsonCursor;
	/** A cursor over one parsed form, artifact `form:<m>.<f>`. */
	xml(document: Document, menu: number, form: number, place: HqPlace): XmlCursor;
	/** A finding no entry names, made through `hqFindings.ts::circumstanceFinding` (part 01, 8.1),
	 *  whose types say what `detail` a code takes. */
	circumstance<C extends ReadCircumstance>(
		code: C, place: HqPlace, detail: CircumstanceDetail<C>,
	): void;
	/**
	 * A manifest finding that is a relation between several nodes, each already claimed (two forms
	 * of one `xmlns`, a second code for one language, learn beside deliver). The claim's use must be
	 * `refuse` or `account` and its entry's standing one that makes a finding. It claims no node.
	 */
	finding(claim: Claim, place: HqPlace, detail?: FindingDetail): void;
	/**
	 * Applies a claim another stage decided by entry id: part 08's `ExpressionClaim` on the node its
	 * expression was registered with. The use follows the entry's standing: `held` is a consumed
	 * `take` (the tree is in `ctx.doc`), `inert` and `kept` a `drop`, any other a `refuse`.
	 */
	claimEntry(site: ClaimSite, entryId: string, key: string, place: HqPlace,
	           detail?: FindingDetail): void;
	/**
	 * Marks a node as covered by a finding already raised, as `refuseWhole` covers the keys under
	 * an object: a log record under the finding's entry where it is a manifest finding, none where
	 * it is a circumstance, and no second finding. For a registration part 08 answers
	 * `unrecognized` or `ownerless` (2.3).
	 */
	cover(site: ClaimSite, by: Finding): void;
	/** A defect of the reader's own, returned in `ReadOutcome.defects` (5.1). `why` comes from a
	 *  constructor of `defects.ts::readerDefect` and from nowhere else. */
	defect(place: HqPlace, name: string, why: ReaderDefectWhy): void;
	/** Every unclaimed use and unread admission becomes `unrecognized`; then the totals. */
	close(): { readonly findings: readonly Finding[]; readonly work: ReadWork;
	           readonly claims: ClaimLog; readonly defects: readonly ReaderDefect[] };
}
/** A node of the source: an element or attribute of a form, or a key of a JSON object. */
export type ClaimSite = XmlNode | { readonly json: JsonCursor; readonly key: string };
```

`claimEntry` is the one claim not declared with `defineClaims`, because part 08 picks the entry from
its own tables by the checker's verdict. Those tables are data too (`SLOT_ENTRIES`, `parseIssueEntry`,
`checkErrorEntry`, part 08's 9.2), and part 08 registers every entry id they can answer with
`defineClaims("expressions", …)`, its `expressions/findings.ts::EXPRESSION_CLAIMS` (its 9.2), so
`claimsBindManifest.test.ts` holds them like any other claim; an id `claimEntry` is handed that is
in no registered claim is the defect D9 (5.1) and `unrecognized` at that node.

```ts
// lib/commcare/reader/jsonCursor.ts
export interface JsonCursor {
	/** HQ's class of this object: `Application`, `Module`, `Form`, `DetailColumn` and so on. */
	readonly cls: string;
	/** RFC 6901 pointer from the app's root. */
	readonly pointer: string;
	readonly place: HqPlace;
	/** The stored value, or HQ's default for the class where the key is absent. Claims nothing. */
	peek(key: string): unknown;
	/** Whether the key holds a value other than the class's default, compared as JSON values. */
	used(key: string): boolean;
	/** Keys the class does not declare (`schemaPropertyDefault(cls, key).known` is false). */
	undeclared(): readonly string[];
	take<T>(key: string, claim: Claim, read: (value: unknown) => T): Admitted<T>;
	derived(key: string, claim: Claim): void;
	drop(key: string, claim: Claim): void;
	refuse(key: string, claim: Claim, detail?: FindingDetail): void;
	account(key: string, claim: Claim, detail?: FindingDetail): void;
	/** Claim the container key and descend. The children are accounted on their own cursors. */
	object(key: string, cls: string, claim: Claim, place?: HqPlace): JsonCursor;
	list(key: string, cls: string, claim: Claim,
	     place?: (index: number, value: unknown) => HqPlace): readonly JsonCursor[];
	map(key: string, cls: string, claim: Claim): ReadonlyMap<string, JsonCursor>;
	/** Cover this object, every key at every depth, by one finding. */
	refuseWhole(claim: Claim, detail?: FindingDetail): void;
	/** Hand the key's value to project data: no claim here, a `HandOffRecord` in the log.
	 *  `subject` is the media path or the table's tag. */
	handOff(key: string, to: HandOffKind, subject: string): void;
}
/** What a hand-off waits on: part 11's media rules, or its lookup table rules. */
export type HandOffKind = "media-reference" | "lookup-table-read";
```

A list of strings is claimed whole. `list` descends only into objects, as the lane does
(`manifest_usage.py::_walk_object` descends only into dict elements and records one use at the list's
own pointer), so a claim per element would have no use to join in part 14's parity. Where the elements
of such a list differ in standing (`langs`, 6.3), the site claims the key once under the entry that
holds the list and raises each element's finding with `Accounting.finding`.

```ts
// lib/commcare/reader/xmlCursor.ts
/** An element, or one attribute of it by the name the source wrote. */
export interface XmlNode { readonly element: Element; readonly attribute?: string }
export interface XmlCursor {
	readonly artifact: string;
	take(node: XmlNode, claim: Claim): Admitted<string>;      // an attribute's value, or an element's text
	derived(node: XmlNode, claim: Claim): void;
	drop(node: XmlNode, claim: Claim): void;
	refuse(node: XmlNode, claim: Claim, place: HqPlace, detail?: FindingDetail): void;
	account(node: XmlNode, claim: Claim, place: HqPlace, detail?: FindingDetail): void;
	/** Cover an element, its attributes and everything under it by one claim. */
	takeSubtree(element: Element, claim: Claim): Admitted<Element>;
	derivedSubtree(element: Element, claim: Claim): void;
	dropSubtree(element: Element, claim: Claim): void;
	refuseSubtree(element: Element, claim: Claim, place: HqPlace, detail?: FindingDetail): void;
	/** Hand a node to project data, as `JsonCursor.handOff` does. */
	handOff(node: XmlNode, to: HandOffKind, subject: string): void;
	handOffSubtree(element: Element, to: HandOffKind, subject: string): void;
	/** Where an unclaimed node's finding is placed: the nearest question, else the form. */
	placeUnclaimed(resolve: (element: Element) => HqPlace): void;
}
```

A node whose claim is the element's default `xmlns` is written `{ element, attribute: "xmlns" }`.

Rules, all in the cursor:

- **A use is a non-default value.** `schemaPropertyDefault(cls, key)` gives the default (the rule
  `manifest_usage.py::_walk_object` applies: "a key is used when its value is not the default HQ writes
  for it"). A claim on a key at its default records nothing and, for `take`, hands out the default.
  `refuse` on a key at its default records nothing: a site refuses a value, not a key. A declared
  key absent from an object reads as `schemaPropertyDefault`'s default and is no use, which is what
  lets a re-read of Nova's own emission, whose objects hold only the keys Nova writes, account
  clean.
- **A claim covers its whole value** unless the site descends with `object`, `list` or `map`, whose
  children are then accounted key by key.
- **One claim per node and key.** A second claim on a key or node already claimed under the same
  surface key is a reader defect: the cursor keeps the first, records `unrecognized` there with
  `detail.name` the node's surface key (4.4), and records the defect D1 (5.1). Every claim a
  reader module declares has its node to itself. The one case of several claims on one node is
  `claimEntry`: part 08 answers, for one expression, its slot's claim and one claim for each surface
  use its syntax makes (a function, an instance, a session path; its 9.3), each under its own key,
  as the lane records several uses at one `where`.
- **A hand-off is for a use whose entry only project data can name.** Two uses qualify, and the
  type admits no third: a media path the index does not resolve to an asset (12.4), and an itemset
  over a table the catalog lacks (10.1). Whether each is inert and listed or a finding depends on the
  platforms the app runs on and on HQ's table list, which are part 11's rules
  (`lib/deployment/reading/projectData/`, its 3.2 and 5.1), and `lib/commcare` cannot import them. So
  the cursor records the node as handed off, lists it in `ReadFacts`, and reports neither a claim nor
  a finding for it. The caller settles each in the same request, after the reader returns (part
  12's `gatherReading`): `planHqMedia` gives every pending reference a finding or an inert
  claim (`HqMediaPlan.claims`, part 11's 2.1), and `readingProjectDataFindingsFor` every unread tag a
  finding (part 11, 14.1). Part 09's acceptance check 1 (complete accounting) holds that every
  `HandOffRecord` of the log is settled by exactly one of those, and a hand-off left over is
  `unrecognized` there. A reading with a hand-off is therefore never accepted on the reader's word alone
  (Departure 13).
- **A use the standing does not permit** (a `take` under an entry that is no longer `held`) is recorded
  as `unrecognized` with `detail.name` the node's surface key, and as the defect D2 (5.1), which
  names the claim, its entry and the entry's standing. The test of 4.2 makes this unreachable on `main`;
  in production it refuses the app instead of admitting it wrong.
- **Namespace declarations.** A prefixed declaration (`xmlns:x`) is no construct, as it is none in
  the lane, whose parser holds declarations apart from attributes; the manifest's two inert rows for
  them (`questions/extra-namespace-declarations-on-h-html`,
  `questions/a-data-root-namespace-declaration-other-than-xmlns-and-xmlns-jrm`) need no claim. A
  default `xmlns` attribute is a construct exactly where it gives its element another namespace than
  its parent's (the data root, a Connect block's child, a case block, a data node with a namespace of
  its own), and there a stage must claim it.
- **Comments and processing instructions** are dropped by the cursor under
  `questions/xml-comments-processing-instructions`. Whitespace-only text between elements is no
  construct. Any other text directly under an element that is not claimed as text is unclaimed.

### 4.4 What is left at the close

`Accounting.close()` walks every cursor it handed out.

| Left unclaimed | Finding |
|---|---|
| a declared JSON key that is used | `unrecognized` at the cursor's place, `detail.name` `schema:<cls>.<key>` |
| an undeclared JSON key | `unrecognized`, `detail.name` `<cls>.<key>` |
| an XML element | `unrecognized` at `placeUnclaimed`'s place, `detail.name` `xform:<qualified name>` |
| an XML attribute | the same, `detail.name` `xform:<qualified element>@<qualified attribute>` |
| an `Admitted` value never read | `unrecognized` at the claim's place, `detail.name` the node's surface key as the rows above spell it; the defect D3 (5.1) |
| an unpreempted `IdentityClaim` of `ok: false` (part 10, 2.3) | `unrecognized` at the second place, `detail.name` the surface key of the node that was being minted; the defect D4 (5.1), which names the key's kind and no part of the key: a key's parts are an `xmlns`, a question's path and an option's value, each an app's own content |
| a node handed off (4.3) | nothing: a `HandOffRecord`, for the caller to settle |

Unclaimed nodes under one element collapse to that element's finding when the element itself is
unclaimed, so a hand-written subtree is one finding and not one per attribute. Findings are deduplicated
on `(code, place, detail.name)`.

`detail.name` of an `unrecognized` finding is therefore a surface key, or, where the unclaimed
thing is a value, the value as the app writes it (an appearance, section 9): the one thing part
01's 8.3 lets a person read after "In CommCare HQ:", and what part 12 expects of it. A sentence
about the reader's own claims never stands there.

### 4.5 The claim log

```ts
export interface ClaimRecord {
	readonly artifact: string;     // "app.json" or "form:<m>.<f>"
	readonly where: string;
	readonly key: string | null;
	readonly entry: string;
	readonly standing: ReadStanding;
}
/** A use handed to project data (4.3): a place and a key, and no entry yet. */
export interface HandOffRecord {
	readonly artifact: string;
	readonly where: string;
	readonly key: string;
	readonly to: HandOffKind;
	/** The media path or the table's tag, which the caller settles it by. */
	readonly subject: string;
}
export interface ClaimLog {
	/** Claims by entry id, in every mode. */
	readonly counts: Readonly<Record<string, number>>;
	/** Every hand-off, in every mode: there are few, and acceptance needs each. */
	readonly handOffs: readonly HandOffRecord[];
	/** Every claim, sorted by artifact, where, key and entry. Throws unless the log is `full`. */
	records(): IterableIterator<ClaimRecord>;
}
/** One JSON object per line, keys in the order above, in `records()` order, `\n` ended. */
export function serializeClaimLog(log: ClaimLog): string;
```

The vocabulary is the lane's (`manifest_usage.py::Use`), so part 14's judge joins on it with no
translation:

- `artifact`: `app.json` for the app's JSON, `form:<m>.<f>` for the form at menu position `m`, form
  position `f`, as `app_json_uses` names each source.
- `where` in the JSON: the RFC 6901 pointer from the root, each token escaped as
  `differences.py::pointer_token` escapes it.
- `where` in a form: `xmlCursor.ts::elementWhere`, a port of `manifest_usage.py::_element_path`: from
  the root down, each step the element's qualified name, and for every element but the root `[n]`, its
  1-based position among its parent's children of the same expanded name. An attribute is the element's
  `where`, `/@`, and the attribute's qualified name.
- A claim on an element's default `xmlns` (4.3, namespace declarations) is the one exception: its
  `where` is the element's `where` followed by `/namespace()`, and its key ends `@xmlns`. That is how
  the lane records a namespace read (`manifest_usage.py::xform_vocabulary`:
  `found.add(read, artifact, f"{where}/namespace()", at)`, and only where `namespace_read_holds`):
  its XML parser keeps namespace declarations out of an element's attributes, so it never records
  `/@xmlns`, and a claim spelled that way would join nothing. The data root's namespace, a Connect
  block's and a case block's are all claims of this kind.
- `xmlNamespaces.ts::qualifiedName` is a port of
  `manifest_usage.py::qualified` with its `PREFIXES` table: the namespace decides the prefix (`h`, `jr`,
  `orx`, `cc`, `vellum`, `odkx`, `xsd`, none for XForms), whatever prefix the document used, and an
  unknown namespace is written `{uri}local`.
- A field's kind claim (9.1) is recorded at `where` equal to the question's absolute data path
  (`/data/household/head_name`), which is where `_question_uses` puts a `mug:` use.
- `key` is the claim's own. Part 14 joins a use of Python's `(artifact, where, K)` to the reader's
  records at that `(artifact, where)` and asks that the entry named there holds `K` among its
  `surfaceKeys` and that its standing projects to Python's as the table of part 14's 8.1 sets out.
- A `HandOffRecord` has the same `artifact`, `where` and `key` a claim there would have. Part 11's
  `HqMediaPlan.claims` and its table findings supply the entry, and part 14 joins the two before it
  judges, so a handed-off use is judged like a claimed one.

```ts
// lib/commcare/reader/xmlCursor.ts
/** A node's `where`; `scope` is `ParsedXForm.scope`. */
export function elementWhere(node: XmlNode, scope: (element: Element) => NamespaceScope): string;
// lib/commcare/xmlNamespaces.ts
/** `namespace` is the expanded name's URI, null for none; `local` its local name. */
export function qualifiedName(namespace: string | null, local: string): string;
```

**Cost.** One reading visits each JSON value and each XML node once; a claim is a map write. In `counts`
mode the log is one integer per entry. In `full` mode the cursor keeps the node and the claim for each
record and builds `where` only when `records()` is iterated, so a production reading never builds a
path string. An app's source is bounded before the reader meets it (part 12's byte bound), and
`readerWork.test.ts` holds each stage's work to grow no faster than its input ("Tests").

---

## 5. Findings and places

### 5.1 How a finding is made

The reader never spells a standing. `Accounting` builds a manifest finding from the index
(`{ code: entry.id, standing, cause, place, subject, detail }`, with `cause` present as part 01's
8.1 says) and a circumstance finding through `hqFindings.ts::circumstanceFinding` (part 01, 8.1).
A manifest finding's `detail.name` is cut with `hqFindings.ts::cutFindingName`; the constructor
cuts a circumstance's. `detail.reason` is set only on `no-platform-runs-everything`, to
`split-refused` at a date and time question whose split is refused (16.3); part 08's checker
reason reaches the defect line D11 and no finding (2.3).

What `detail.name` holds, by what the finding is about (part 01, 8.3 and 9.2):

| The finding is about | `detail.name` |
|---|---|
| an appearance | the appearance string as written |
| a bind type, a media type, an itext form | that value as written |
| a setting, a profile property, a translations key | the key |
| an element or attribute no entry names | the lane-style name of 4.4 |
| a language code | the code |
| text CommCare HQ's build reads as an instance (7.4, 15) | the read `instanceScanRead` answered, as the text spells it |
| a platform use no declaration runs (16.3) | the feature's label in curly quotes and the platform that cannot run it |
| anything whose place says it all | absent |

**Defects.** Where the reader itself is at fault it raises `unrecognized` at the place, with the
surface key as above, and calls `Accounting.defect(place, name, why)`. `why` is one of a closed set of
twelve developer lines ("Copy", the defect table, D1 to D12): a second claim, a claim the
manifest no longer permits, a held value nothing read, an identity key met twice, a form source only
Nova's parser refuses, a form's `xmlns` that differs from its source's, an itemset column the catalog
lacks, a document that does not assemble, an entry id `claimEntry` was handed that no claim
registers, a translation Nova's own rule refuses after the pairing passed it (12.5), and part
08's two lines for an expression Nova could not write back (2.3). A person reads only "In
CommCare HQ: `xform:model/bind@relevant`" under part 01's sentence for `unrecognized`; the developer
reads `why` in the log beside it.

**No word of an app is in a `why`.** Part 12 logs it, and its log holds no app content (its section
10). So a `why` is no free string: it is a `ReaderDefectWhy`, and the one way to make one is a
constructor of `reader/defects.ts::readerDefect`, one per code:

```ts
// lib/commcare/reader/defects.ts
export const READER_DEFECT_CODES = [
	"claimed-twice", "claim-not-permitted", "claimed-not-read", "identity-met-twice",
	"form-source", "xmlns-differs", "itemset-column", "assembly",
	"unregistered-expression-claim", "translation",
	"expression-not-written-back", "no-case-datum",
] as const;
export type ReaderDefectCode = (typeof READER_DEFECT_CODES)[number];
/** A defect's line. Only the constructors below return one. */
export type ReaderDefectWhy = string & { readonly __readerDefectWhy: true };

export const readerDefect: {
	/** `first` and `second` are names `claims.ts::claimRegistry()` holds. */
	claimedTwice(place: HqPlace, first: string, second: string): ReaderDefectWhy;
	claimNotPermitted(place: HqPlace, claim: string, standing: ReadStanding): ReaderDefectWhy;
	claimedNotRead(place: HqPlace, claim: string): ReaderDefectWhy;
	identityMetTwice(place: HqPlace, kind: ExternalEntityKind): ReaderDefectWhy;
	formSource(place: HqPlace, kind: "xml-version" | "malformed"): ReaderDefectWhy;
	xmlnsDiffers(place: HqPlace): ReaderDefectWhy;
	itemsetColumn(place: HqPlace, ref: "value" | "label"): ReaderDefectWhy;
	/** `issue` is the first issue of the document schema's parse. */
	assembly(
		place: HqPlace, issue: { readonly path: readonly PropertyKey[]; readonly code: string },
	): ReaderDefectWhy;
	unregisteredExpressionClaim(place: HqPlace, entry: string): ReaderDefectWhy;
	/** `language` is the language's 0-based position among the app's languages. */
	translation(
		place: HqPlace, role: TranslationUnitRole, language: number,
		issue: TranslationValueIntegrityIssue,
	): ReaderDefectWhy;
	/** `reason` is the row's `detail.reason`, one of part 08's codes (its 9.1). */
	expressionNotWrittenBack(place: HqPlace, reason: string): ReaderDefectWhy;
	noCaseDatum(place: HqPlace): ReaderDefectWhy;
};
```

Each constructor fills its row's template ("Copy") and nothing else. The slots are closed:

| Slot | What it prints |
|---|---|
| `<place>` | `place.ts::placeKey(place)` (5.2): the place by position alone, `form[2,0]`, never a menu's, a form's or a question's name, a path, a tag or a file's path |
| `<claim>` | the name, where `claimRegistry()` holds it (`<module>.<name>`, a name of Nova's own code), and `unregistered-claim` otherwise |
| `<entry>` | the id, where `inventoryIndex()` holds it, and `no-such-entry` otherwise |
| `<standing>` | a member of part 01's `READ_STANDINGS` |
| `<kind>` | a member of part 10's `EXTERNAL_ENTITY_KINDS`, or one of the two parse failure kinds |
| `<ref>` | `value` or `label` |
| `<top-level key>` | `issue.path[0]` where it is a key `lib/domain/blueprint.ts`'s document schema declares at its root, and `root` otherwise |
| `<issue code>` | Zod's issue code; `<issue>` a member of `TranslationValueIntegrityIssue` |
| `<role>` | a member of `lib/domain/translationUnits.ts::TranslationUnitRole` |
| `<n>` | a position, as digits |
| `<reason>` | part 08's `detail.reason`: `no-case-datum`, `parse:<issue code>` or `differs:<node kind>`, each a code of Nova's grammar and never a text read from the app (its 9.1) |

No constructor takes a name, a label, a tag, a column, a question's path, a value, an expression's
text or a parser's message, so none can print one. A parser's message is replaced by the failure's
kind (D5), a schema issue's message and path by its code and top-level key (D8), an external key's
text by its kind (D4). What a developer loses in the line is found by reading the app again:
nothing of a read is stored, and the log line's ids say whose Project it was read into (part 12,
section 10). `defects.test.ts` holds the closure (Tests).

### 5.2 Places

`reader/place.ts` builds part 01's `HqPlace` values. A menu's and a form's `name` is its name in the
app's first language by part 01's rule; a question's `path` is its data path below the form's root,
joined by `/` (`household/head_name`). `placeOrder(a, b)` orders findings as the app reads: the app, its
settings, its languages, then each menu at its index with its case list, detail and search, then that
menu's forms at their index, each followed by its questions in data-tree order; then lookup tables,
media and the organization. `whereText(place)` is the string a resolver claim takes (part 10, 2.3):
`placeOrder`'s sort key, which is stable and names no person's content beyond the place itself.
`placeKey(place)` is the place by position alone, for a defect's line (5.1), and holds nothing of
the app: `app`, `app-settings`, `languages`, `organization`, `lookup-table`, `media`, `menu[<menu>]`,
`case-list[<menu>]`, `case-detail[<menu>]`, `search[<menu>]`, `form[<menu>,<form>]` and
`question[<menu>,<form>]`, the indexes 0-based as `HqPlace` holds them. A question's path is left
out because its steps are question ids.

```ts
// lib/commcare/reader/place.ts
export function appPlace(): HqPlace;
export function appSettingsPlace(): HqPlace;
export function languagesPlace(): HqPlace;
export function menuPlace(menu: number, name: string): HqPlace;
export function formPlace(menu: number, form: number, menuName: string, name: string): HqPlace;
/** `path` is the question's data path below the form's root, a name per step. */
export function questionPlace(
	form: Extract<HqPlace, { kind: "form" }>, path: readonly string[],
): HqPlace;
export function placeOrder(a: HqPlace, b: HqPlace): number;
export function whereText(place: HqPlace): string;
export function placeKey(place: HqPlace): string;
```

---

## 6. The application walker

`appShell.ts::readApplication` opens the root cursor (class `Application`) and claims every key. The
standing of each is part 01's (`01-the-bar-and-the-manifest.md`, sections 4.1 to 4.4); this
table is which claim reads it. Entry ids are under `application-and-settings/`.

### 6.1 Every declared property

| Keys | Claim | Reads |
|---|---|---|
| `doc_type` | `derived(doc-type-application)` | nothing: Nova writes `Application` back whatever it read (6.4) |
| `name` | `take(name)` | `appName` |
| `langs` | `take(langs-order-langs-0-default)` for the whole list; each code's finding by 6.3 | `localization` |
| `modules` | `list(…, take(modules))`, each child's class from its `doc_type` (7.1) | the drafts |
| `_attachments` | `map`, each `<read id>.xml` key `take(attachments-form-unique-id-xml)` when a form of this read names it, else `drop(attachments-entry-for-a-form-no-longer-in-the-app)` | each form's source text |
| `cloudcare_enabled` | `take(40-hq-cloudcare-enabled)` | `facts.webAppsOnInHq`; the proposal (16.3) |
| `translations` | `map` by language, each key by 6.5 | language names, the app's display name |
| `profile` | `object`, by 6.6 | `showSavedForms`, `showIncompleteForms` |
| `build_spec` | by 6.2 | nothing |
| `logo_refs` | `take(logo-refs-hq-logo-web-apps)` for the slot `hq_logo_web_apps` with the uploader's path and an `m_id`; `account(logo-refs-hq-logo-android-home-login-demo)` for the three Android slots, each with an `m_id`; `refuse(logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare)` for a slot whose path is any other, or whose entry holds no `m_id` | the Web Apps logo, by 12.4's rule for a path: an asset is a `ReadMediaReference` of slot `app_logo`, and a path with no file is handed off |
| `auto_gps_capture` | `account(45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app)` where no form holds a Connect block, else `derived(45-hq-auto-gps-capture)` (decided at stage 11, when 15 has run) | nothing: Nova writes `true` on a Connect app, from `connectType` |
| `location_fixture_restore` | `derived(50-hq-location-fixture-restore-project-default)`, `derived(50p-hq-location-fixture-restore-both-fixtures-only-flat-fixture)`, `refuse(50pp-hq-location-fixture-restore-only-hierarchical-fixture)` by value | nothing: Nova writes `project_default` and reads the flat fixture, so the two held values are `derived`, as `doc_type` is (6.4) |
| `application_version` | `account(33-hq-application-version-2-0)`, `account(33p-hq-application-version-1-0)` by value | |
| `use_custom_suite` | `account(41-hq-use-custom-suite-false)` or `account(41p-hq-use-custom-suite-true)` by value | |
| `translation_strategy` | `account(44-hq-translation-strategy-select-known)` at `select-known`, else `account(44p-hq-translation-strategy-select-known)` (the entry of the class `not-select-known`) | |
| `target_commcare_flavor` | `account(48-hq-target-commcare-flavor-none)` at `none`, else `account(48p-hq-target-commcare-flavor-commcare-commcare-lts)` | |
| `mobile_ucr_restore_version` | `account(49-hq-mobile-ucr-restore-version-2-0)` at `2.0`, else `account(49p-hq-mobile-ucr-restore-version-1-0-1-5)` | |
| `case_sharing`; `use_grid_menus`; `grid_form_menus`; `persistent_menu`; `show_breadcrumbs` | `account(39-hq-case-sharing)`; `account(46-hq-use-grid-menus)`; `account(47-hq-grid-form-menus-none-all-some)`; `account(51-hq-persistent-menu)`; `account(52-hq-show-breadcrumbs)` | |
| `practice_mobile_worker_id`; `custom_base_url`; `secure_submissions` | `account(35-hq-practice-mobile-worker-id)`; `account(36-hq-custom-base-url)`; `account(43-hq-secure-submissions)` | |
| `build_profiles` | `account(build-profiles-each-profile-s-name-langs-practice-mobile-worker)` when `{}`, else `account(build-profiles-non-empty)` | |
| `custom_assertions` | `account(non-empty-custom-assertions-app)` | |
| `multimedia_map` | `account(multimedia-map)`: the map is read through `input.media`, never here | |
| `add_ons` | `account(add-ons)` | |
| `_id`; `_rev`, `domain`, `copy_of`, `version`; `short_odk_url`, `short_odk_media_url`; the ten build record keys; `date_created`, `created_from_template`, `last_modified`, `has_submissions`; `copy_history`, `family_id`; `external_blobs`; `archived_media`; the four MALT keys | `account` under `id`, `rev-domain-copy-of-version`, `short-odk-url-short-odk-media-url`, `built-with-build-signed-built-on-build-comment-comment-from-last`, `date-created-created-from-template-last-modified-has-submissions`, `copy-history-family-id`, `external-blobs`, `archived-media`, `amplifies-workers-amplifies-project-minimum-use-threshold` | |
| `recipients`; `admin_password`, `admin_password_charset`; `cached_properties`, `description`, `deployment_date`, `phone_model`, `user_type`, `attribution_notes`; `vellum_case_management`; `comment`; `smart_lang_display` | `account` under `recipients`, `admin-password-admin-password-charset`, `cached-properties-description-deployment-date-phone-model-user`, `vellum-case-management`, `comment-app`, `smart-lang-display` | |

Part 05's source read strips `_id`, `version` and `domain` and keeps the rest in `raw`; a key absent
from `raw` is at its default and is no use.

CommCare HQ's uploader always stores `m_id`
(`hqmedia/views.py::ProcessLogoFileUploadView.process_upload` stores what
`hqmedia/models.py::CommCareMultimedia.get_media_info` returns), and Web Apps and the Android
profile read an entry's path whether or not it names a file (`cloudcare/utils.py::format_app_doc`,
`models/applications.py::Application.create_profile`), so an entry without one is never dropped
unsaid. The entry's wording for it is part 01's (its section 4.3).

**Undeclared keys.** For each key of `undeclared()`: one of the names the entry
`dynamic-keys-anonymous-cloudcare-enabled-anonymous-cloudcare` lists is `account`ed under it; a name that
is a read-only property or method of `Application` (an undeclared `schema:Application.<name>` item of
`surface.json`, the 75 of part 01's 4.1) under
`an-unknown-top-level-key-naming-an-application-read-only`; any other under
`any-other-unknown-top-level-key-that-names-no-application`.

### 6.2 The floor

`build_spec.version` is compared with `versionFloor.ts::compareToVersionFloor`, the comparison publish
makes. At or above 2.57: `account(34-hq-build-spec-at-or-above-nova-s-floor-2-57)`. Below, or a version
the comparison cannot read: `refuse(34p-hq-build-spec-below-nova-s-floor)` at the app-settings place with
`detail.name` the version as HQ holds it. `build_spec.build_number` and `latest` are covered by the same
claim. Lifecycle: `build_spec` is alive; HQ sets it from the project space's default build when the key
is absent (`ApplicationBase.wrap`).

### 6.3 Languages and wire codes

`languages.ts::readLanguages` reads `langs` in order.

1. **Each code.** The list is one use, claimed once (6.1; 4.3 says why a list of strings takes no
   claim per element), so each code's finding is raised with `Accounting.finding` at the languages
   place, the code in `detail.name`. An empty string: `refuse(langs-containing-an-empty-code)`. A
   code outside `localization.ts::languageWireCodeSchema`'s grammar, or one the list holds twice:
   `refuse(a-non-empty-langs-code-outside-that-grammar-or-repeated)`. Otherwise the code is held
   verbatim as the language's wire code.
2. **Its identity.** `languageIdentityForHqCode(code)`: split at the first hyphen into `base` and
   `suffix`. `languageRegistry/index.ts::languageCodeVerdict(base)` gives the language: itself where it
   is `individual-living`; `resolved` where it is `set1-alias`; the first of `members` where it is a
   `macrolanguage` (the registry lists the predominant member first, the rule
   `languageWire.ts::mintLanguageWireCode` runs the other way through `classicWideningTarget`); nothing
   where it is `non-living` or `unknown`. The suffix is lower case, since the grammar admits
   `[a-z]*` alone, so it is read by its length and its letters, never its case: two letters whose
   upper-cased form is one of `regionChoices(language)` is the region; four letters whose title-cased
   form (first letter upper case) is one of `scriptChoices(language)` is the script; six letters
   whose first four so read are a script and whose last two so read are a region is both, the
   spelling `mintLanguageWireCode` writes for an identity that holds both (`<script><region>`
   lower-cased into one segment); any other suffix adds nothing. The identity must pass
   `identityIssues`.
3. **What cannot be named.** A code that gives no language, an identity `identityIssues` refuses, and a
   second code that gives an identity an earlier code already took are each the new entry of the table
   below, raised with `Accounting.finding` and the code in `detail.name`.
4. **The result.** `localization = { sourceLanguage: tag(langs[0]), defaultLanguage: tag(langs[0]),
   languageOrder, translations: {}, wireCodes: { [tag]: code } }`, with `tag` from
   `localization.ts::languageTag`. HQ's first language is the default every runtime starts in
   (`Application.default_language`), and Nova's source language is the one whose text the document's own
   slots hold, so both are `langs[0]`. The list is claimed `take(langs-order-langs-0-default)`, key
   `schema:Application.langs`. The code-spelling entry,
   `langs-code-spelling-matching-hq-s-grammar-a-z-2-3-a-z-e-g-en-hin`, shares that key and is claimed
   where a form spells a code: on each `translation@lang` the itext reader reads (12.1), key
   `xform:model/itext/translation@lang`.

An app whose `langs` is empty has no entry: HQ's pages never leave it so (a new app starts with one
language), and HQ falls back to `en` for it (`models/applications.py::Application.default_language`).
The reader does not guess a language into the document: it is `unrecognized` at the languages place,
`detail.name` `schema:Application.langs`.

**Manifest edit.** One new entry in `entries/application-and-settings.json`, beside
`langs-code-spelling-matching-hq-s-grammar-a-z-2-3-a-z-e-g-en-hin`, with its inventory row:

| Field | Value |
|---|---|
| `id` | `application-and-settings/langs-code-nova-s-language-registry-cannot-name` |
| `area`, `section` | `application-and-settings`, `Application` |
| `item` | "a `langs` code in HQ's grammar that names no living language of ISO 639-3, or two codes that name one language (`en` beside `eng`)" |
| `surfaceKeys` | `["schema:Application.langs"]` |
| `valueClass` | `code-outside-nova-s-registry` |
| `disposition` | `HELD-NEW` |
| `dispositionCell` | "**HELD-NEW**: a language held by a code alone, with no identity in Nova's registry (`languageRegistry/index.ts::languageCodeVerdict`)" |
| `subject`, `owner` | `language-codes`, `settings-nova-comes-to-own` |
| `platforms` | `{ kind: "each", cell: "RUNS / RUNS", webApps: { reading: "runs" }, android: { reading: "runs" } }` |
| `emission` | a copy of the `emission` object of the entry it sits beside, cell and markers unchanged |
| `gates` | `[]` |

The entry beside it keeps its class and gains to its `item` ", naming a living language of ISO 639-3,
each language once". `language-codes` has no `not-yet` sentence today (its two entries are
`fix-in-hq`), so this entry needs one ("Copy").

### 6.4 Document types

The reader is handed an `HqAppSource`, which `readHqAppSource` gives only for `doc_type` `Application`
(part 05, 7; part 01, 8.3), so the four document-type entries of the manifest are never claimed here and
`doc_type` is claimed `derived(doc-type-application)`: the value reaches no slot, because Nova writes
`Application` for every app, and a `take` nothing read would close as `unrecognized` (4.1, rule 3).
A menu's and a form's document type is 7.1.

### 6.5 `translations`

For each language key of `translations` that is one of the app's codes, each key inside it is claimed
once, by part 01's 4.4 classes in this order:

| The key | Claim |
|---|---|
| equal to an app language's code | the language's display name: `derived(translations-lang-code-language-display-names-equal-to-the-label)` where the value equals Nova's label for that identity (`resolvedLanguageDisplayLabel`), else `account(translations-lang-code-any-other-value-or-absent-where-hq-s)`, which part 01 keeps at CommCare HQ's value (its 7.2). The first claim is `derived` because the value is read into nothing: Nova derives its label from the language's identity |
| `app.display.name` | `take(translations-app-display-name)`: where it differs from `name`, the app name's translation in that language, through `ctx.translations` |
| `homescreen.title` | `account(translations-homescreen-title)` |
| a runtime's own UI text (`appStringKeys.ts::isRuntimeUiStringKey`) | `account(translations-key-in-a-runtime-s-ui-string-catalog-core-android)`; HQ's catalog fill for such a key, `account(translations-catalog-key-hq-fills-with-its-own-text-in-a)` |
| one of HQ's generated patterns (`translationKeyOwner` gives `generated`) | held back to stage 11, and classified or covered there (16.5) |
| any other | `account(translations-key-no-runtime-reads)` |

A language key of `translations` that is none of the app's codes is `account`ed whole under
`translations-key-no-runtime-reads`: HQ builds no strings for it (part 01, 7.1).

### 6.6 `profile`

`profile` is a `DictProperty` with three known members. `properties` and `features` are walked key by
key; each key's entries are `index.naming("setting:properties.<key>")` or
`index.naming("setting:features.<key>")`.

| The key | Claim |
|---|---|
| `properties.cc-show-saved`, `properties.cc-show-incomplete` | `take(20-properties-cc-show-saved)`, `take(21-properties-cc-show-incomplete)`: `appSettings.showSavedForms`, `showIncompleteForms`, by `appProfileSettings.ts`'s own value table read backwards |
| `features.sense` holding `'true'`; `properties.cc-entry-mode` holding `'cc-entry-review'` | `refuse(profile-features-sense-true-or-profile-properties-cc-entry-mode)` |
| a key whose `setting:` item lists its choices and whose value is none of them | `refuse(profile-properties-or-features-dependencies-value-outside-its)` with the key |
| a key one entry names | `account` under it |
| a key two entries name (`lazy-load-video-files`) | `account` under the one whose class takes the value |
| a key no `setting:` item names | `account(any-other-profile-properties-features-key-not-in-the-yaml)` |

`custom_properties` is part 07's, which derives whether `cc-index-case-search-results` is what Nova
would write. This walker claims nothing under it.

---

## 7. Menus and forms at the level of their own keys

### 7.1 Document types and drafts

`structure.ts::readStructure` reads `modules` in order beside `input.modules` (the aligned read; the two
lists have one length or the input is broken, 2.2).

| `doc_type` | What happens |
|---|---|
| `Module`, `AdvancedModule` | a draft; `AdvancedModule` under `take(menus-and-case-lists/advancedmodule)` |
| `ShadowModule` | `refuseWhole`, under the first of these that applies: `menus-and-case-lists/shadowmodule-version-1-or-key-absent-model-default-1` where `shadow_module_version` is not 2; `menus-and-case-lists/shadowmodule-with-no-source-module-id-or-one-naming-no-module` where `source_module_id` names no menu of the app; `menus-and-case-lists/shadowmodule-v2-under-a-v2-shadow-menu-mirroring-a-non-shadow` where it is the entry's child mirror ("v2 under a v2 shadow menu, mirroring a non-shadow child of that menu's source"): its `root_module_id` names a version 2 mirror menu, and its `source_module_id` names a menu that is no mirror and whose own `root_module_id` is that mirror's source; `menus-and-case-lists/shadowmodule-shadow-module-version-2` otherwise |
| `ReportModule` | `refuseWhole(menus-and-case-lists/reportmodule-mobile-ucr-and-all-of-report-configs)` |
| any other | `refuseWhole(menus-and-case-lists/unknown-module-doc-type)` with the type |
| a form: `Form`, `AdvancedForm` | a draft; `AdvancedForm` under `take(forms-and-case-writes/advancedform)` |
| a form: `ShadowForm` | `refuseWhole(forms-and-case-writes/shadowform)` |
| a form: any other | `refuseWhole(forms-and-case-writes/unknown-form-doc-type)` |

Each is one finding at the menu or the form, whatever the object holds, never one per key: a mirror
menu is one finding under the subject `mirror-menus`, `not-yet` where it is a version 2 mirror (part
01, section 2.2 and Appendix A.1). A menu part 05 marked `not-summarized` still gets its draft and its
structural findings; part 12's `gatherReading` adds `menu-unreadable-in-hq` at that menu, and the
reading ends as an account either way.

### 7.2 Identity, before any mint

In this order, for the drafts that remain (part 10, 2.2 and 2.3):

1. A menu with no `unique_id` (absent, null or empty):
   `refuse(menus-and-case-lists/module-unique-id-missing)` at the menu; no draft. The entry is a real
   state with a real next step (its reason: HQ gives a menu its id lazily,
   `models/modules.py::ModuleBase.get_or_create_unique_id`, and opening App Preview once saves one),
   so the person must meet this finding and not a stop. On `main` the menu never reaches a reader:
   `hq/appSource.ts::readHqAppSource` answers `malformed` for a menu whose `unique_id` is no string.
   Part 05 (`05-reading-commcare-hq.md`, its sections 7 and 8.3) admits such a menu under
   `admit: "any"` with `uniqueId: null`, aligned by position; a `unique_id` of any other type stays
   `malformed`.
2. A form whose `xmlns` is null or empty: HQ could not read its source when it was last saved.
   `models/forms.py::FormSource.__set__` sets `xmlns` to `None` on any exception of
   `wrapped_xform().data_node.tag_xmlns`, which a source that does not parse raises and so does one
   with no instance or no data node. It is
   `refuse(forms-and-case-writes/blank-source-or-no-non-group-question)` at the form; no draft.
3. Two forms of one `xmlns`: `refuse(forms-and-case-writes/two-non-shadow-forms-sharing-an-xmlns)` at
   each; no draft for either.
4. Then, in HQ's order: `resolver.claim(externalKey.module(uniqueId), whereText(place))` for each menu
   and `resolver.claim(externalKey.form(xmlns), …)` for each form. A claim that answers `ok: false` here
   is the frame's `unrecognized` (4.4).

`unique_id` is claimed `account(menus-and-case-lists/modulebase-unique-id)` on a menu and
`account(forms-and-case-writes/unique-id)` on a form (both kept: identity); `xmlns` is
`take(forms-and-case-writes/xmlns-form-json-and-xform-data-node)`, read into the draft and compared with
the data root's namespace in 8.2.

### 7.3 A menu's keys

Ids are under `menus-and-case-lists/`. The structure stage claims the keys that are the menu's own
record; every other declared key is part 07's, named in the last row so the two cannot both claim
one. Part 07 claims no key of the other rows: it reads their result from `ctx.draft`.

| Keys | Claim |
|---|---|
| `doc_type`, `module_type` | 7.1; `module_type` is at its class's default or is covered by the document-type finding |
| `unique_id` | 7.2 |
| `name` | `take(modulebase-name)`: the name in the source language into `module.name`, each other language through `ctx.translations` (12.5's rule) |
| `forms` | `list(…, take(module-forms))`, each child's class from its `doc_type` |
| `comment` | `account(comment-module)` |
| `ref_details`, `referral_list` | `account(module-ref-details)`, `account(module-referral-list)` |
| undeclared: `display_separately`; `display_style` on an advanced menu; any other | `account(module-display-separately)`; `account(display-style-on-an-advanced-or-shadow-module)`; `refuse(any-other-undeclared-key)` |
| `case_type`, `root_module_id`, `put_in_root`, `parent_select`, `module_filter`, `media_image`, `media_audio`, `use_default_image_for_all`, `use_default_audio_for_all`, `custom_icons`, `case_list`, `case_list_form`, `session_endpoint_id`, `case_list_session_endpoint_id`, `display_style` on a basic menu (where the class declares it), `fixture_select`, `report_context_tile`, `auto_select_case`, `is_training_module`, `lazy_load_case_list_fields`, `show_case_list_optimization_options`, `task_list`, `custom_assertions`, `case_details`, `search_config`, and on an advanced menu `product_details`, `has_schedule`, `schedule_phases` | part 07 |

### 7.4 A form's keys

Ids are under `forms-and-case-writes/`.

| Keys | Claim |
|---|---|
| `doc_type`, `form_type` | 7.1; `take(form-type)` where `form_type` is not the class's default |
| `unique_id`, `xmlns` | 7.2 |
| `name` | `take(name-lang)`, as a menu's name; where `instanceScanRead` (`lib/commcare/hqInstanceScan.ts`; part 03, section 5.1) answers for the name in the app's first language, the one `formWireName` writes into the form, also `refuse(form-name-read-as-an-instance)`, raised with `Accounting.finding` at the form, `detail.name` the text it answered |
| `version` | `account(version)` |
| `validation_cache`, `comment`, `submit_notification_label` | `account(validation-cache)`, `account(comment)`, `account(submit-notification-label)` |
| `show_count` | `account(show-count-false)` or `account(show-count-true)` by value |
| `submit_label` | `account(submit-label-default)` where every language's value is HQ's default or blank, else `account(submit-label-non-default)` |
| `is_release_notes_form`, `enable_release_notes` | `account(is-release-notes-form-true-with-or-without-enable-release-notes)` where the first is true, else `account(is-release-notes-form-false-with-enable-release-notes-either-way)` |
| `schedule_form_id`, `custom_instances`, `auto_gps_capture` | `account(schedule-form-id-set)`, `account(custom-instances-non-empty)`, `account(auto-gps-capture-form)` |
| `case_references_data` | `object`, with `load` under `account(case-references-data-load)` (8.7); `save` is part 07's (its 5.3), judged in `settleCaseManagement` once the Save to Case blocks are read |
| undeclared: `put_in_root`; `no_vellum`; any other | `account(put-in-root-on-a-form-dynamic-key)`; `account(no-vellum-removed-field-dynamic-key)`; `refuse(any-other-undeclared-key)` |
| `requires`, `actions`, `form_filter`, `post_form_workflow`, `post_form_workflow_fallback`, `form_links`, `session_endpoint_id`, `respect_relevancy`, `function_datum_endpoints`, `media_image`, `media_audio`, `use_default_image_for_all`, `use_default_audio_for_all`, `custom_icons`, `custom_assertions`, and on an advanced form `arbitrary_datums`, `schedule` | part 07 |

`Form.type` is not on the wire: part 07 derives it from `requires` and `actions`, before stage 7.

The entry `form-name-read-as-an-instance` is part 03's, with its subject `instance-text` (its
section 5.1): a form's name is plain text in the form's source, CommCare HQ's build reads
`instance('…')` there as an instance read, and Nova's gate refuses the name
(`FORM_TEXT_READ_AS_INSTANCE`), so the reader refuses what the gate would.

---
## 8. The XForm reader: parse and join

### 8.1 Files

All under `lib/commcare/reader/xform/`. Entry ids in sections 8 to 15 are under `questions/` unless
another area is written.

| File | Exports |
|---|---|
| `index.ts` | `readForms` (stage 3), `mintFields` (stage 5b), `ReadXForm`, `ReadSaveToCaseBlock`, `ReadConnectBlock`, `NodeRole`, `DraftField`, `ReadSourceNames`, `SourceNodeRef`, `expressionEnvOf` (17.2) |
| `claims.ts` | `X`, the form reader's `defineClaims("xform", …)` table: one member for each claim sections 8 to 15 write, named by the entry's id less its area, followed by `@<use>` where the reader claims one entry under two uses and by `@<key>` where under two keys |
| `parse.ts` | `parseXFormSource`, `ParsedXForm` |
| `model.ts` | `readDataTree`, `readBinds`, `readSetvalues`, `readInstances`, `DataNode`, `BindFacts`, `SetvalueFacts` |
| `body.ts` | `readControls`, `ControlNode` |
| `join.ts` | `joinForm` |
| `kinds.ts` | `FIELD_KIND_ROWS`, `fieldKindOf` (9.1) |
| `appearances.ts` | `appearanceReads`, `APPEARANCE_ROWS`, `classifyAppearance` (9.2) |
| `options.ts` | `readChoices` (10.1) |
| `containers.ts` | `readContainers`, `rootSections` (10.2) |
| `repeats.ts` | `readRepeat`, `modelIterationVerdict` (10.3, 10.4) |
| `logic.ts` | `pendingLogic` (11.1, 11.2) |
| `loadOrder.ts` | `effectiveLoadOrder`, `loadOrderConflicts`, `LoadStep` (11.3) |
| `itext.ts` | `readItext`, `ItextTable`, `PRAGMA_KEYS` (12.1, 12.2) |
| `prose.ts` | `readText`, `literalOutputText`, `finishText` (12.3, 12.5) |
| `media.ts` | `readMediaForms`, `readMediaMap` (12.4) |
| `generated.ts` | `GENERATED_RULES`, `recognizeGenerated`, `sameTree` (13) |
| `shadow.ts` | `readHashtagMetadata`, `shadowAgrees`, `SHADOWED_ATTRIBUTES` (14) |
| `connect.ts` | `readConnectBlocks` (15) |
| `afterBinding.ts` | `finishForms` (stage 10) |

### 8.2 Parsing

`readForms` takes each draft form's attachment (the `Admitted` text of 6.1).

| The source | Result |
|---|---|
| no attachment, or an empty one | `refuse(forms-and-case-writes/blank-source-or-no-non-group-question)` at the form |
| `xmlParse.ts::tryParseXml` answers `kind: "doctype"` | `refuse(dtd-declared-entity-references-predefined-ones-such-as-amp-are)` |
| it answers `kind: "xml-version"` or `kind: "malformed"` | `unrecognized` at the form, `detail.name` `xform:h:html`, and the defect D5 (5.1) with the failure's `kind`, never the parser's message, which quotes the source. HQ parsed this source to give the form its `xmlns`, so a source Nova's parser alone refuses is Nova's to learn |
| parsed | `parseXFormSource`, below |

Nova's parser reads no document type declaration, so a source that holds one is refused under
this entry whether or not it references a declared entity. HQ's own page refuses only a source
that holds an entity node (`xform.py::parse_xml`) and its import stores any text, so both kinds
can sit in an app. Part 14's variant shows the one with no reference.

`tryParseXml` answers `{ issue: string }` today, and a document type declaration can be told from any
other failure only by its message text ("Malformed XML: Document type declarations are not
supported."). This part gives the failure arm a kind, set where `xmlParse.ts::parseXml` raises
each error and never read back from a message:

```ts
// lib/commcare/xmlParse.ts
export type XmlParseFailureKind = "doctype" | "xml-version" | "malformed";
export function tryParseXml(
	xml: string,
): { doc: Document } | { issue: string; kind: XmlParseFailureKind };
```

```ts
export class XmlParseError extends Error {
	constructor(message: string, readonly kind: XmlParseFailureKind);
}
```

`parseXml` throws an `XmlParseError` whose message is today's, so `xmlParseIssue` and `assertXml`
keep their text and their callers change nothing.

`parseXFormSource` finds, by namespace and never by prefix (`xmlNamespaces.ts`): the root `h:html`; its
`h:head` and `h:body`; the head's `h:title` and `model`; the model's primary instance (the one
`instance` with no `id`, `publishedCaseBlocks.ts::dataRoot`'s rule) and its one element child, the data
root; the other instances; every `bind`, `setvalue` and the `itext`. A source missing any of root, head,
body, model, primary instance or data root is
`refuse(forms-and-case-writes/blank-source-or-no-non-group-question)`, and so is a data root in no
namespace: HQ reads such a root's namespace as a slice of its tag
(`xform.py::XMLNode.tag_xmlns`, `self.tag.split('}')[0][1:]`, which gives `ata` for `<data>`), so the
form's stored `xmlns` is no namespace any source declares, and the comparison below would blame Nova
for it.
A second instance with no `id` is `refuse(expressions-and-data/more-than-one-instance-without-an-id)`.

The frame of the document, claimed here:

| Node | Claim |
|---|---|
| `h:html`, `h:head`, `h:body`, `model`, the primary `instance`, `itext` | `derived(application-and-settings/attachments-form-unique-id-xml)`, with the key `jr-control:model`: the frame every form's source has |
| `h:html@vellum:ignore` | each token: `markdown` is `take(vellum-ignore-containing-markdown-on-h-html-vellum-s-disable)`, read as `Form.plainText` (12.2); `richText` is `drop(vellum-ignore-containing-richtext)`, remembered for 14; `retain` and any other token is `refuse(content-marked-vellum-ignore-retain-vellum-ignored)` |
| `h:title`; the data root's `name` | `derived(h-title-and-data-name-whatever-their-text)`: Nova writes both from the form's name |
| the data root's `uiVersion` | `derived(data-root-uiversion-of-1)` at `1`; absent or any other, `refuse(data-root-uiversion-other-than-1-or-absent)` |
| the data root's `version` | `drop(data-root-version)` |
| the data root's namespace | `take(forms-and-case-writes/xmlns-form-json-and-xform-data-node)`, compared with the form's `xmlns`; a difference is `unrecognized`, `detail.name` `schema:Form.xmlns`, and the defect D6 (5.1). The claim's node is the root's `xmlns` (4.5: `where` ends `/namespace()`) |
| any other attribute of the data root | `refuse(data-root-attributes-other-than-uiversion-version-and-name-and)` |
| a data root whose element is not named `data` | `refuse(data-root-element-named-other-than-data)`, the new entry of 8.8 |
| `vellum:hashtags`, `vellum:hashtagTransforms` in the head | read by 14, then `dropSubtree(vellum-hashtags-vellum-hashtagtransforms)` |
| `odkx:intent` in the head | where an input's appearance names its `id`: left to 9.2's intent rows; otherwise `dropSubtree(odkx-intent-that-no-question-references)` |
| any other head child | where its local name or a descendant's is one of `surface.json`'s `jr-control:` or `jr-action:` names, `refuseSubtree(other-h-head-children-whose-local-name-or-a-descendant-s-core-or)`; otherwise `dropSubtree(h-head-children-other-than-hq-s-own-h-title-model-odkx-intent)` |
| a `submission` in the model | named by a `send`: `refuseSubtree(send-submission)` on both. Otherwise by Core's rule as the entry's `item` states it (an `id`, a `resource` and a `targetref`; `method` absent or `get`; `replace` absent or `text`; `mode` absent or `synchronous`; `targetref` and `ref` paths to nodes of the data tree): passing, `dropSubtree(a-submission-core-accepts-with-no-send-naming-it)`; failing, `refuseSubtree(a-submission-core-s-parser-refuses-missing-any-of-id-resource)` |
| `orx:pollsensor` in the model | `refuseSubtree(authored-orx-pollsensor)`: HQ's build writes its own, and a stored source holds none |
| any other model child | in the XForms namespace, or text: `refuseSubtree(unknown-xforms-namespace-model-children-text-in-model)`; in another namespace and named `itext`, `instance`, `bind`, `submission`, `setvalue`, `send` or `pollsensor`: `refuseSubtree(unknown-namespace-model-children-named-itext-instance-bind)`; otherwise `dropSubtree(other-unknown-model-children-non-xforms-namespace-whose-local)` |

### 8.3 The model

**The data tree** (`model.ts::readDataTree`, as `parser.js::parseDataTree` and `parseDataElement` read
it). Every element under the data root is a `DataNode`: its name, its path from the root, its parent
and children, its `vellum:role`, whether it carries `jr:template`, and its own text where it has no
element child.

| What the tree holds | Result |
|---|---|
| two siblings of one name | `refuse(two-sibling-data-nodes-with-one-name)` at each |
| a child of the root named `meta` in any case | `refuseSubtree(authored-data-meta-block)` |
| a name `questionId.ts::questionIdProblem` refuses as `leading-underscore`, `not-letter-first`, `characters` or `xml-prefix`, or as `reserved-name` for `meta` in any letter case or for `instance`, `bind` or `parsererror` as written, on a node that becomes a field | `refuse(question-id-failing-the-grammar-or-meta-in-any-case)` with the name. That entry's `item` gains ", or `instance`, `bind` or `parsererror`, which HQ's form builder cannot open" |
| a name it refuses as `reserved-name` for `case`, `registration` or `script` in any letter case, on a node that becomes a field | `refuse(question-id-case-registration-script)` with the name, the entry 8.8 re-cuts to HELD-NEW. The one exception is a root node named `case` as written (below) |
| `vellum:comment` | `drop(vellum-comment)` |
| `vellum:lock` on a node or a bind | `refuse(vellum-lock-all-locked-question)` |
| a default-namespace declaration that changes a node's namespace, on a node no plugin owns | `refuse(data-node-xmlns-on-a-hidden-value)` |
| non-blank text on a leaf that becomes a field | `refuse(default-data-value-datavalue-instance-text)` |
| any other attribute of a data node | unclaimed: `unrecognized`. Vellum keeps it as a raw attribute and Nova writes none |

**Root nodes named `case` and `commcare_usercase`.** A root node named `case` as written gets the
role `root-case`, no field, and no claim here. Part 07 claims it whole, under whichever of
`a-root-question-case-in-a-form-where-hq-writes-the-primary-case` and
`hand-written-case-block-without-vellum-role-incl-a-root-data` its form's actions make apply; its
refusals cover every such node, with the form's actions or without. A root node named
`commcare_usercase` passes the question id rule and is a field this stage claims; where the form
holds usercase updates part 07 raises `a-root-question-commcare-usercase-in-a-form-with-usercase`
with `ctx.accounting.finding` at that question, which claims no node.

A node with `vellum:role` is never a field: `SaveToCase` starts a case region (13.3), `Repeat` is a
model-iteration wrapper (10.3), and the four Connect roles are 15. A role none of these names
(`ConnectWorkAreaUpdate`) is `refuseSubtree(connect-work-area-update)`; any other role is unclaimed.

**Binds** (`readBinds`, as `parseBindList` reads them). A bind's path is its `nodeset`, or its `ref`; a
relative path is taken from the data root (`parser.js::processPath`). The path is read with
`xpath/formSyntax.ts::readFormSyntax` and must be a chain of child steps, with at most one final
attribute step.

| The bind | Result |
|---|---|
| its path names no node | `dropSubtree(bind-whose-nodeset-matches-no-node)` |
| its path ends in an attribute of a model-iteration wrapper or row, or lies in a case region | kept for 10.3 or handed to part 07 |
| its path ends in any other attribute | `refuseSubtree(bind-on-an-attribute-path-not-owned-by-a-plugin-savetocase-model)` |
| a second bind for one node | left unclaimed: `unrecognized` |
| otherwise | `BindFacts` on the node; `nodeset` is `take(bind-nodeset-absolute-or-relative)` |

`BindFacts` holds the element, the `type` as written, and which of `relevant`, `required`,
`constraint`, `calculate`, `readonly`, `jr:constraintMsg`, `jr:preload`, `jr:preloadParams`, `id` and
`requiredCondition` it carries. `jr:preload` and `jr:preloadParams` are `drop(jr-preload-jr-preloadparams)`.
The rest are sections 9, 11, 12 and 14.

**Setvalues** (`readSetvalues`): the model's `setvalue` children in document order, each with its
`event`, its `ref` resolved as a bind's path is, and its `value` attribute. Section 11.2 decides each.

**Secondary instances** (`readInstances`): each `instance` with an `id`, with its `src`. A form's
declarations are derived by Nova from what its expressions read (`xpath/wire/instances.ts::InstanceSink`),
so none is content. Part 08 claims each declaration when it has bound the form's expressions: one an
expression reads, under the entry of the read; one nothing reads, under
`expressions-and-data/declared-unreferenced-fixture-instance-item-list-locations-user` where its
source is an `item-list:<tag>`, `locations` or `user-groups` fixture, and under
`expressions-and-data/declared-unreferenced-instance-whose-source-loads-no-data-casedb` for any other
(part 08, 9.3). An instance with no `src` and inline content is
`refuseSubtree(expressions-and-data/inline-instance-content-inside-instance-no-src)`, claimed here.

### 8.4 The body

`body.ts::readControls` walks `h:body` as `parser.js::parseControlTree` does. A control is an `input`,
`secret`, `select`, `select1`, `trigger`, `upload` or `group` in the XForms namespace.

| The body holds | Result |
|---|---|
| any other element where a control may stand | `refuseSubtree(unknown-body-control-vellum-readonly-e-g-range)` |
| a `repeat` that is not the one `repeat` child of a `group` whose appearance is not `field-list` in any letter case | `refuseSubtree(bare-repeat-with-no-group-wrapper)`. Vellum's `group` adaptor tests `appearance === 'field-list'` first (`parser.js::buildControlNodeAdaptorMap`), so under a group written `field-list` the `repeat` is a control it does not know, and under a case variant (`Field-List`) it is a Repeat in HQ's form builder while Core, which reads the appearance ignoring case, draws a Question List. Neither is a repeat Nova holds |
| `<input readonly="true()">` | `refuseSubtree(input-readonly-true-control-attribute)` |
| a `trigger` with no `ref`, `nodeset` or `bind` | `refuseSubtree(ref-less-trigger)` |

A control finds its node as `parser.js::getPathFromControlElement` does: its `ref`, else its `nodeset`,
else the bind whose `id` its `bind` attribute names. A relative path is taken from the enclosing
control's node. A control found through a bind `id` equal to the node's path, relative to the root or to
the enclosing control, is `take(bind-id-with-control-bind-where-the-id-is-the-node-s-path)` on both
attributes; any other `id` so used is `refuse(any-other-bind-id-named-by-a-control-s-bind)`. A control
whose path names no node is `refuseSubtree(a-control-whose-ref-names-no-node)`. Two controls for one node
leave the second unclaimed.

### 8.5 The join

`join.ts::joinForm` gives every data node one `NodeRole`, in this order, so a generated node never
becomes a field:

1. role nodes (`SaveToCase`, `Repeat`, Connect) and everything under them;
2. the case scaffolding of 13.3;
3. generated question siblings (13.2), each proposed against the fields found so far and those found
   after, in two passes: fields first by control and bind, then generated candidates among the nodes
   with no control;
4. every node a control names: a field of the kind 9.1 gives;
5. every remaining node with no element child: a Hidden Value (9.1);
6. a remaining node with element children and no control: `refuseSubtree(hidden-value-with-children)`.

**A control's place and its node's place must agree.** Where a field's control stands in another
container than its data node, it is `refuse(data-parent-data-node-under-another-group-than-its-control)`,
or `refuse(data-parent-crossing-a-repeat)` where a repeat lies between the two.

**Order.** A container's children are ordered as `parseControlTree`'s `merge` leaves them: in data-tree
order, unless its children that have controls stand in another order in the body, in which case those
come first in body order and the children with no control follow in data-tree order. Nova writes data
nodes and controls in one order, so this is the order a save in HQ's form builder would give the form.

**Identity.** Stage 5b, `mintFields`, mints each field in document order, once part 07 has settled the
candidates of 13.3, through `resolver.claim(externalKey.field(xmlns, path), whereText(place))`,
`path` its ids from the form's root with a query repeat's `item` step left out, which is
`formStructure.ts::formFieldPath`'s path and part 10's key. Each inline choice is minted through
`externalKey.selectOption(xmlns, path, value)` after its value passed 10.1.

### 8.6 What a form's reading holds

```ts
// lib/commcare/reader/xform/parse.ts
export interface HashtagMetadata {
	readonly hashtags: Readonly<Record<string, string | null>>;
	readonly transforms: Readonly<Record<string, string>>;
}
export interface ParsedXForm {
	readonly html: Element;
	readonly head: Element;
	readonly body: Element;
	readonly model: Element;
	readonly dataRoot: Element;
	readonly instances: readonly {
		readonly element: Element; readonly id: string; readonly src: string | undefined;
	}[];
	readonly binds: readonly Element[];
	readonly setvalues: readonly Element[];
	readonly itext: Element | undefined;
	/** `vellum:ignore`'s tokens. */
	readonly ignore: readonly string[];
	readonly hashtags: HashtagMetadata;
	/** An element's namespace scope, for `xmlNamespaces.ts`'s helpers. */
	scope(element: Element): NamespaceScope;
}

// lib/commcare/reader/xform/model.ts
export interface DataNode {
	readonly element: Element;
	readonly name: string;
	/** Names from the data root down, the root left out. */
	readonly path: readonly string[];
	readonly parent: DataNode | null;
	readonly children: readonly DataNode[];
	readonly role: string | undefined;          // vellum:role
	readonly template: boolean;                 // carries jr:template
	/** Its own text, where it has no element child. */
	readonly text: string;
}
export interface BindFacts {
	readonly element: Element;
	/** `type` as written. */
	readonly type: string | undefined;
	/** The logic attributes it carries, each with its text. */
	readonly logic: Readonly<Partial<Record<
		"relevant" | "required" | "constraint" | "calculate" | "readonly" | "constraintMsg", string>>>;
}
export interface SetvalueFacts {
	readonly element: Element;
	readonly event: string;
	/** The path `ref` names, an attribute as a last step `@name`; undefined where it names none. */
	readonly target: readonly string[] | undefined;
	readonly value: string | undefined;
}

// lib/commcare/reader/xform/body.ts
export interface ControlNode {
	readonly element: Element;
	readonly tag: "input" | "secret" | "select" | "select1" | "trigger" | "upload" | "group" | "repeat";
	/** The data node it names (8.4); undefined where its path names none. */
	readonly node: DataNode | undefined;
	readonly parent: ControlNode | null;
	readonly children: readonly ControlNode[];
	/** `appearance` and, on an upload, `mediatype`, each as written. */
	readonly appearance: string | undefined;
	readonly mediaType: string | undefined;
}

// lib/commcare/reader/xform/itext.ts
export interface ItextTable {
	/** A text's `value` elements by app language and form name (`default` for none). */
	values(id: string): ReadonlyMap<LanguageTag, ReadonlyMap<string, Element>> | undefined;
	/** The slots that reference a text id, in document order. */
	owners(id: string): readonly {
		readonly field: DraftField; readonly slot: string; readonly option?: number;
	}[];
	/** Every text id of the source, for 12.1's table of texts no slot references. */
	ids(): readonly string[];
}

// lib/commcare/reader/xform/index.ts
export type NodeRole =
	| { readonly kind: "field"; readonly field: DraftField }
	| { readonly kind: "generated"; readonly purpose: GeneratedNodePurpose; readonly owner: DataNode }
	/** Proposed here, settled by part 07. The purposes are `GeneratedNodePurpose`'s own names. */
	| { readonly kind: "generated-candidate";
	    readonly purpose: "url" | "datetime" | "trimmed" | "owner"; readonly owner: DataNode | null;
	    /** For `owner`: which of the two trees its calculate is (13.2). */
	    readonly ownerValue?: "acting-user" | "unowned" }
	| { readonly kind: "query-row"; readonly repeat: DraftField }
	| { readonly kind: "connect";
	    readonly block: "learn_module" | "assessment" | "deliver_unit" | "task" }
	/** A node of the case region (13.3), with the container it is where its name and shape tell. */
	| { readonly kind: "case-region";
	    readonly container?: "operations" | "condition" | "keyed" | "keyed-count" | "guard"
	      | "selected-cases" | "selected-case" | "subcases" }
	/** A root node named `case`, which part 07 claims (8.3). */
	| { readonly kind: "root-case" };

/** One `vellum:role="SaveToCase"` element, as part 07's `readSaveToCaseBlocks` takes it (its 5). */
export interface ReadSaveToCaseBlock {
	readonly element: Element;
	/** Its data path from the form's root. */
	readonly path: readonly string[];
	/** The repeat it stands in, by that repeat's draft field; null at the root. */
	readonly repeat: DraftField | null;
	/** Every bind and setvalue whose target is the block or lies under it. */
	readonly binds: readonly BindFacts[];
	readonly setvalues: readonly SetvalueFacts[];
	/** Its ancestors between its scope and itself, outermost first, each a `case-region` node. */
	readonly wrappers: readonly DataNode[];
}
/** One Connect element (15), read here and listed for part 07's `connectType` rows. */
export interface ReadConnectBlock {
	readonly block: "learn_module" | "assessment" | "deliver_unit" | "task";
	readonly id: string;
	readonly path: readonly string[];
}

/** A field as the form reader builds it: its kind's slots, less its logic, which is pending. */
export interface DraftField {
	readonly node: DataNode;
	readonly kind: FieldKind;
	readonly id: string;
	readonly parent: DraftField | null;
	/** True for the stand-in of a question that got a finding (2.3); never in a returned document. */
	readonly standIn: boolean;
	/** Set by `mintFields` (stage 5b). */
	uuid: Uuid | undefined;
	/** The slots stages set. `assembleDocument` parses the whole with the kind's schema. */
	readonly field: Record<string, unknown>;
	/** Which scalar check its constraint carried (13.2). */
	scalarCheck?: "allow" | "reject";
}

export interface ReadXForm {
	readonly parsed: ParsedXForm;
	readonly cursor: XmlCursor;
	/** Every data node by its path joined with "/". */
	readonly nodes: ReadonlyMap<string, DataNode>;
	readonly roles: ReadonlyMap<DataNode, NodeRole>;
	readonly binds: ReadonlyMap<DataNode, BindFacts>;
	readonly setvalues: readonly SetvalueFacts[];
	/** A container's fields in order; `null` is the form's root. */
	childrenOf(parent: DraftField | null): readonly DraftField[];
	/** Nodes proposed as generated and not yet settled (13.3). */
	readonly candidates: readonly DataNode[];
	settle(node: DataNode, verdict: "generated" | "field"): void;
	/** Every node of the case region (13.3), in document order. */
	readonly caseRegion: readonly DataNode[];
	/** Every Save to Case block of the form, in document order, wherever it stands. */
	readonly saveToCaseBlocks: readonly ReadSaveToCaseBlock[];
	readonly connectBlocks: readonly ReadConnectBlock[];
	readonly connect: FormStructureConnect;
	readonly itext: ItextTable;
	/** Each declared secondary instance id to its `src` (part 08's `instanceSources`). */
	readonly instanceSources: ReadonlyMap<string, string>;
	/** Set by `mintFields`. */
	sourceNames: ReadSourceNames | undefined;
}
```

The purposes are the emitter's own names, which part 07 uses too: a capture's link node is `url`,
and the join of a date and a time question is no generated node at all (16.4: it is an ordinary
Hidden Value's calculate, which part 08 binds, and part 07 types the property it writes
`datetime`). The `container` member lists `keyed-count` and `subcases` because the emitter writes
both (`generatedNodes.ts`, `caseBlocks.ts`).

### 8.7 `case_references_data`

The forms stage opens `case_references_data` with `object` (class `CaseReferences`), the container
claimed `account(forms-and-case-writes/case-references-data-load)` with the key
`schema:Form.case_references_data` (`schema:AdvancedForm.case_references_data` on an advanced form),
and claims `load` inside it under the same entry with the key `schema:CaseReferences.load`.

`save` is part 07's, claimed in `settleCaseManagement` (its 5.3), and this stage claims nothing of
it. A differing map can only be judged once the Save to Case blocks are read: a form whose block is
part 07's own finding raises that finding alone, and its `save` map is not judged. Two readers of
one key would also be a second claim on one node (4.3).

Part 07 computes the map it compares from the pair `parseXFormSource` already found by namespace,
`ParsedXForm.model` and `ParsedXForm.dataRoot`. It cannot call
`xform/caseSaveReferences.ts::caseSaveReferences` on a read source as that function stands: it
finds `h:head` and `model` by their prefixed names (`childNamed(root, "h:head")`), takes the
primary instance as the `instance` with no `src` where 8.2 takes the one with no `id`, and throws
where either is missing, and where a bind has no `nodeset` or one `FormPath.parse` refuses. Part
07's 5.3 splits it into a function of those two elements that is total over a read source.

### 8.8 Manifest edits of this section

One new entry in `entries/questions.json`, section "Binds, actions, model and head content", beside
`data-root-uiversion-other-than-1-or-absent`, with its inventory row:

| Field | Value |
|---|---|
| `id` | `questions/data-root-element-named-other-than-data` |
| `item` | "a data root whose element is named other than `data` (Vellum keeps the name it finds, `parser.js::parseDataTree`), so every answer's path starts with that name" |
| `surfaceKeys` | `["xform:model/instance/*"]` |
| `valueClass` | `root-named-other-than-data` |
| `disposition` | `HELD-NEW`, `subject: "form-source"`, `owner: "xform"` |
| `dispositionCell` | "**HELD-NEW**: a form's own root name; Nova writes `data`, and every path of the form's case management names the root" |
| `platforms` | `{ kind: "each", cell: "RUNS / RUNS", webApps: { reading: "runs" }, android: { reading: "runs" } }` |
| `emission`, `gates` | `{ cell: "Nova writes `data`", markers: [] }`, `[]` |

Its `area` is `questions`, as its id's prefix requires (`schema.ts`). The REFUSED entry beside it holds
a value class already (`ui-version-other-than-1`), so the pair is disjoint. `form-source` has no
`not-yet` sentence today, so this entry needs one ("Copy").

One entry re-cut, `questions/question-id-case-registration-script`. It is HELD today ("`Field.id`
(Vellum warning only), except as below"), and that is not what Nova does: `questionIdProblem` answers
`reserved-name` for `case`, `registration` and `script` in any letter case
(`questionId.ts::RESERVED_QUESTION_IDS.anyCase`), the gate refuses the id (`INVALID_FIELD_ID`), and
neither part 03 nor part 04 changes that set. The bar admits exactly what the gate admits, so a
reading cannot hold such a question, and the REFUSED entry beside it ("failing the grammar, or `meta`
in any case") does not describe it and would send a person to change a name HQ only warns about.
The re-cut:

| Field | Value |
|---|---|
| `disposition` | `HELD-NEW`, `subject: "question-ids"`, `owner: "xform"` |
| `dispositionCell` | "**HELD-NEW**: a name HQ's form builder only warns about, which Nova's question id rule refuses (`questionId.ts::RESERVED_QUESTION_IDS`)" |
| `slotChanges` | removed, as a HELD-NEW entry holds none |
| `platforms`, `emission`, `gates`, `surfaceKeys`, `valueClass`, `item` | unchanged |

`question-ids` is the subject the REFUSED entry beside it carries (part 01, Appendix A), and it holds
no `not-yet` sentence today, so the re-cut needs one ("Copy"). Nova's own exports never use the
entry, since the gate refuses the name, so no export loses a holder. The re-cut is a reading
re-cut: it changes with the reader that first claims it (part 01, section 3, the rule that an
entry's standing changes with the code that makes its new wording true).

---

## 9. Field kinds

### 9.1 The table

```ts
// lib/commcare/reader/xform/kinds.ts
export interface FieldKindFacts {
	readonly control: "input" | "secret" | "select1" | "select" | "trigger" | "upload" | "none";
	/** The bind's type with one leading `xsd:` removed; undefined where it has none. */
	readonly bindType: string | undefined;
	readonly mediaType: string | undefined;
	readonly appearance: string | undefined;
	readonly hasCalculate: boolean;
	readonly hasDefault: boolean;
}
export interface FieldKindRow {
	/** Whether the row takes these facts: the cells of the table below, as a predicate. */
	readonly matches: (facts: FieldKindFacts) => boolean;
	/** The kind the row gives; undefined for a row that refuses. */
	readonly kind: FieldKind | undefined;
	/** Slots the row sets beside the kind (`keypad: "numbers"`). */
	readonly slots?: Readonly<Record<string, unknown>>;
	readonly claim: Claim;
	/** The claim on the bind's `type` where the manifest holds it apart (a select's, an upload's). */
	readonly typeClaim?: Claim;
}
/** The rows of the table below, in its order. A `group` control is no row (10.2, 10.3). */
export const FIELD_KIND_ROWS: readonly FieldKindRow[];
/** The first row that matches; undefined for the one shape the table leaves unclaimed. */
export function fieldKindOf(facts: FieldKindFacts): FieldKindRow | undefined;
```

The trigger row for an appearance other than `minimal` carries its cell's `refuse` as its claim;
`readForms` asks 9.2 first for such a trigger and takes the row's claim only where 9.2 names no row.
The three Hidden Value cells of one line are three rows.

`kinds.ts::fieldKindOf` reads one row for each control and its bind. A bind's type is compared after
one leading `xsd:` is removed, exactly and with its case, against Core's names; Vellum lower-cases
before it matches (`parser.js::buildControlNodeAdaptorMap`) while Core does not, which is why a case
variant is the manifest's refusal. The kind's claim is recorded at the question's data path with the
key `mug:<Type>` (4.5), and the bind's `type` attribute and the control's own attributes are claimed
under the same entry, with two exceptions the rows state: a select's present bind type and an upload's
`binary` type, each of which the manifest holds under an entry of its own.

| Control | Bind type | Media type | Appearance | Field | Claim |
|---|---|---|---|---|---|
| `input` | `string` | | none, or one 9.2 holds or drops | `text` | `take(text-input-xsd-string)` |
| `input` | `string` | | exactly `numeric` | `text` with `keypad: "numbers"` | `take(phone-number-xsd-string-appearance-numeric)` |
| `input` | none | | not `numeric` or `numbers` in any case | `text` | `take(an-input-whose-bind-has-no-type-any-appearance-but-numeric-or)` |
| `input` | none | | `numeric` or `numbers` in any case | | `refuse(an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring)` |
| `input` | `int`, `integer` | | | `int` | `take(integer-xsd-int-xsd-integer-read-as-the-same)` |
| `input` | `double` | | | `decimal` | `take(decimal-xsd-double)` |
| `input` | `date` | | | `date` | `take(date-xsd-date)` |
| `input` | `time` | | | `time` | `take(time-xsd-time)` |
| `input` | `dateTime` | | | `datetime` | `take(date-and-time-xsd-datetime)` |
| `input` | `geopoint` | | | `geopoint` | `take(gps-geopoint)` |
| `input` | `barcode` | | | `barcode` | `take(barcode-barcode)` |
| `input` | `long` | | | | `refuse(long-xsd-long)` |
| `input` | `intent` | | | | `refuse(android-app-callout-input-appearance-intent-id-bind-type-intent)` |
| `input` | any other | | | | `refuse(input-whose-bind-type-vellum-does-not-write-xsd-decimal-xsd)` with the type |
| `secret` | `string` | | | `secret` | `take(password-secret-xsd-string)` |
| `secret` | none | | not `numeric` or `numbers` in any case | `secret` | `take(a-secret-whose-bind-has-no-type-any-appearance-but-numeric-or)` |
| `secret` | none | | `numeric` or `numbers` in any case | | `refuse(a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring)` |
| `secret` | `int`, `integer`, `long`, `double` | | | | `refuse(secret-with-a-numeric-bind-type)` |
| `select1` | none, `string`, `listItem`, `select1` | | | `single_select` | `take(multiple-choice-select1-item)`; a present type `take(select-bind-type-xsd-string-or-a-choice-type-matching-the)` |
| `select` | none, `string`, `listItems`, `select` | | | `multi_select` | `take(checkbox-select-item)`; the type as above |
| `select1` | `listItems`, `select`; `select` with `listItem`, `select1` | | | | `refuse(a-choice-bind-type-contradicting-the-control-listitem-select1-on)` |
| `select`, `select1` | any other | | | | `refuse(a-select-whose-bind-type-is-neither-a-choice-type-nor-a-string)` |
| `trigger` | any | | exactly `minimal` | `label` | `take(label-trigger-whose-appearance-is-exactly-minimal)` |
| `trigger` | any | | anything else, or none | | 9.2: `trigger-selectable`, a floating row, or `refuse(acknowledge-label-a-trigger-whose-appearance-is-neither-exactly)` |
| `upload` | `binary` | `image/*` | none | `image` | `take(image-capture-upload-image)`; the type `take(binary-bind-type-on-an-upload)` |
| `upload` | `binary` | `image/*` | exactly `signature` | `signature` | `take(signature-image-signature)` |
| `upload` | `binary` | `image/*` | exactly `face` | | `refuse(face-capture-image-face)` |
| `upload` | `binary` | `audio/*` | | `audio` | `take(audio-capture-audio)` |
| `upload` | `binary` | `video/*` | | `video` | `take(video-capture-video)` |
| `upload` | `binary` | `application/*,text/*` | | `file` | `take(document-upload-application-text)` |
| `upload` | any | any other, or none | | | `refuse(upload-with-any-other-mediatype-or-none)` |
| `upload` | not `binary` | one of the four | | | left unclaimed: `unrecognized` |
| `group` | | | | 10.2, 10.3 | |
| none | none, `string` | | | `hidden` | `take(hidden-value-data-node-bind-no-control-with-calculate-or-default)` where it holds a calculate or a default, `take(hidden-value-with-neither)` where neither, `refuse(hidden-value-with-both-calculate-and-a-default-by-any-expression)` where both |
| none | `dateTime` | | | `hidden` | `take(hidden-value-bound-xsd-datetime)`, held to 11.4 |
| none | any other | | | | `refuse(hidden-value-bound-a-type-nova-would-not-write)` (11.4) |

The media types are compared as `xform/captureUpload.ts::UPLOAD_MEDIATYPES` holds them, byte for byte,
as Core does (`XFormParser::parseUpload`); Vellum lower-cases first, and a case variant is the refusal
row. `jr:imageDimensionScaledMax` on an image upload is
`refuse(jr-imagedimensionscaledmax-250-500-1000px-or-another-positive)` where it is a positive whole
number with or without `px`, `refuse(jr-imagedimensionscaledmax-that-is-not-an-integer-or-is-greater)`
otherwise, and on any other upload
`account(jr-imagedimensionscaledmax-an-integer-with-or-without-px-on-any)`.

**Slots a kind does not hold.** Each kind's schema declares its slots (`lib/domain/fields/*.ts`). A
source that gives a kind something its schema has no slot for is a finding under part 04's entries:
`required` on a label, `bind-required-on-a-label`; a `constraint` on a geopoint, a capture question or a
label, `bind-constraint-on-a-capture-question-or-a-label`; a default on a capture question or a label,
`default-on-a-capture-question-or-a-label`; a hint on a label, `hint-text-on-a-label`; help text, help
media or a validation message on a capture question or a label,
`help-text-on-a-capture-question-or-a-label`, `help-media-on-a-capture-question-or-a-label`,
`validation-message-on-a-capture-question-or-a-label`. Two refusals are the manifest's own: a `calculate`
on a question with a control, `refuse(bind-calculate-on-a-visible-question)`; `readonly` on any bind but
a protected message's carrier (13.2), `refuse(bind-readonly)`. A `jr:constraintMsg` on a bind with no
`constraint` is `refuse(validation-message-without-a-validation-condition)`.

### 9.2 Appearances

Nova holds four appearance facts, and reads them from the table it writes them with, backwards:
`xform/appearance.ts::FIELD_DISPLAY_SETTING_TOKENS`, the token table of `fieldAppearance`, which part
03 exports for this (its 2.3). They are `minimal` on a trigger, `signature` on an image upload,
`field-list` on a group, `numeric` on a text input, each as the whole attribute. Every other string
is classified, never guessed.

`appearances.ts` reads the runtime read rules `surface.json` records in its `appearance:` family, as the
lane does (`manifest_value_classes.py::appearance_rules`): each item's `reads` give the reader, the
token, how it matches (`whole`, `contains`, `prefix`, a token of a split, a token regex), its case
handling and the holders, controls and data types it applies to. `appearanceReads(value, facts)` is a
port of `appearance_matches` and `AppearanceRule.reads` over the same items, with `facts` built as
`element_facts` builds them from the control and its bind. It answers which runtime reads act on a
value on this control.

```ts
// lib/commcare/reader/xform/appearances.ts
/** What Core builds of a body element, as `manifest_value_classes.py::element_facts` answers it. */
export interface AppearanceFacts {
	readonly holder: "group" | "question" | null;
	/** Core's control constant (`CONTROL_INPUT`, `CONTROL_IMAGE_CHOOSE`); null for a group. */
	readonly control: string | null;
	/** Core's data type constant (`DATATYPE_NULL` where the bind gives none); null for a group. */
	readonly datatype: string | null;
}
/** One runtime read that acts on the value: its surface item, its reader and its token. */
export interface AppearanceRead {
	readonly key: string; readonly reader: string; readonly token: string;
}
export function appearanceReads(value: string, facts: AppearanceFacts): readonly AppearanceRead[];
export interface AppearanceRow {
	/** The table's first column: whether the row applies to this control and its bind. */
	readonly applies: (control: ControlNode, bind: BindFacts | undefined) => boolean;
	/** The table's second column: whether the whole appearance string is one the row names. */
	readonly matches: (value: string) => boolean;
	/** Always an `account` claim. */
	readonly claim: Claim;
}
export const APPEARANCE_ROWS: readonly AppearanceRow[];
export type AppearanceVerdict =
	/** Rule 1: the kind's own token, which 9.1's row claims. */
	| { readonly kind: "held" }
	/** Rules 2 to 4. */
	| { readonly kind: "claim"; readonly claim: Claim }
	/** Rule 5: left unclaimed. */
	| { readonly kind: "unclaimed" };
export function classifyAppearance(
	control: ControlNode, bind: BindFacts | undefined, value: string,
): AppearanceVerdict;
```

`classifyAppearance` answers by the first rule that applies:

1. **Held.** The whole string is the kind's own token: section 9.1's row.
2. **A refused class.** Eight entries, read two ways.
   Three have a reader in the lane, and `appearances.ts` holds a port of each, function for function,
   under the entry `manifest_value_classes.py::VALUE_CLASSES` registers it for:
   `appearance_whitespace_read_otherwise`
   (`an-appearance-holding-such-whitespace-that-some-runtime-reads`), `appearance_token_no_runtime_reads`
   (`any-other-multi-token-string-holding-a-token-no-runtime-reads-on`) and `android_inside_match_other`
   (`any-other-single-string-no-row-names-that-holds-a-value-android`). Part 14's parity holds these
   three.
   The other five have no lane reader: `proof/checks/test_manifest_value_classes.py` lists each among
   its known gaps. They are the two per-row refusals
   (`a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does`,
   `a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts`), the case-variant refusal
   (`a-case-variant-of-numeric-short-or-ethiopian-as-the-whole`), and the two intent refusals
   (`intent-id-naming-an-odkx-intent-that-no-callout-question-writes`,
   `intent-id-on-any-input-naming-no-odkx-intent-in-the-form`). `appearances.ts` writes each of these
   five from its entry's `item`, one function per entry named for it, and nothing in Python checks
   them: what holds them is `appearances.test.ts` over the examples each `item` gives, and one variant
   per entry in part 14 whose row of `proof/matrix/variants.json` names the entry. Parity is not
   claimed for them.
3. **A row of `APPEARANCE_ROWS`**, the table below: the entry whose control and token match.
4. **Read by no runtime.** `appearanceReads` is empty for the value on this control and it is no
   `intent:` value on an input: `account(any-other-value-read-by-no-runtime-not-an-intent-value-on-an)`.
5. **Otherwise** it is left unclaimed, and is `unrecognized` with the string in `detail.name`: a runtime
   reads it and no row names it.

Every finding of this section carries the appearance string as written in `detail.name`. Every
control, leaf or container, whose appearance a claim of this section accounted under an entry of
standing `inert` is listed by its data path in `ReadFormFacts.inertAppearances` (17.3), in body
order: part 09's check 4 cuts exactly those from CommCare HQ's side.

`APPEARANCE_ROWS`, each row an entry and the control it applies to. A token written `<n>` is one or more
digits; a row with several tokens matches the string of those tokens joined by single spaces. Every
row is claimed with `account`: each entry of the table is HELD-NEW or INERT, so the one use drops the
inert ones and makes a finding of the others, and a row whose entry later becomes HELD fails
`claimsBindManifest.test.ts` until code reads it. `appearanceRows.test.ts` asserts that no row's entry
is HELD.

| Control | Whole string | Entry |
|---|---|---|
| `select1` | `minimal` | `select1-minimal` |
| `select1` | `compact`, `compact-<n>` | `select1-compact-compact-n` |
| `select1` | `quick` | `select1-quick` |
| `select1` | `quick compact-<n>`, `compact-<n> quick` | `select1-quick-compact-n` |
| `select1` | `combobox` | `select1-combobox` |
| `select1` | `combobox multiword` | `select1-combobox-multiword` |
| `select1` | `combobox fuzzy` | `select1-combobox-fuzzy` |
| `select1` | `list` | `select1-list` |
| `select1` | `list-nolabel` | `select1-list-nolabel` |
| `select1` | `label` | `select1-label` |
| `select1` | `button-select` | `select1-button-select` |
| `select1` | `receive-<topic>-<field>` | `select1-receive-topic-field` |
| `select` | `minimal`; `compact`, `compact-<n>`; `list`; `list-nolabel`; `label` | `select-minimal`; `select-compact-compact-n`; `select-list`; `select-list-nolabel`; `select-label` |
| `select` | `combobox` and any string starting with it, `quick`, `button-select` | `select-combobox-quick-button-select` (inert) |
| `secret` | `numeric` | `secret-numeric` |
| text `input`, `secret` | `numbers` | `text-secret-numbers` |
| text `input`, `secret` | a case variant of `numbers` | `a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of` |
| any input | `short`; `medium` | `short`; `medium` |
| text `input` | `address` | `text-address` |
| text `input` | `broadcast-<topic>` | `broadcast-topic-an-address-entry-under-the-gates-above-and` |
| text `input` | `receive-<topic>-<field>` | `text-receive-topic-field` |
| barcode `input` | `numeric`, `address`, `receive-<topic>-<field>` | `barcode-numeric-address-or-receive-topic-field` |
| barcode `input` | `quick`; `editable` | `barcode-quick`; `barcode-editable` |
| text `input`, and a `secret` holding `numeric` | `hint-as-placeholder` | `hint-as-placeholder-on-text-other-than-a-secret-without-numeric` |
| any other entry control | `hint-as-placeholder` | `hint-as-placeholder-on-any-other-entry` |
| any `input` not typed `intent` | `intent:<id>`, `<id>` the tag of a callout question of the form | `intent-id-on-any-input-other-than-an-intent-typed-one-where-id` |
| int or decimal `input` | any other single token | `numeric-input-int-decimal-any-other-value-apart-from-the-values` (inert) |
| dateTime `input` | any other single token | `datetime-any-value-apart-from-the-values-every-question-reads` (inert) |
| date `input` | `ethiopian`; `nepali`; `gregorian`, `gregorian cancel` | `date-ethiopian`; `date-nepali`; `date-gregorian-gregorian-cancel` |
| time `input` | `12-hour` | `time-12-hour` |
| geopoint `input` | `maps` | `geopoint-maps` |
| image `upload` | `acquire`; `overlay-small` | `image-acquire`; `image-overlay-small` |
| audio `upload` | `legacy`; `acquire-or-upload`; `long` | `audio-legacy`; `audio-acquire-or-upload`; `audio-long` |
| audio `upload` | `acquire` | `audio-acquire` (inert) |
| video `upload` | `acquire` | `video-acquire` |
| document `upload` | any single token but a `broadcast-` one and the tokens every question reads | `document-upload-any-value-except-broadcast-and-the-values-every` (inert) |
| `trigger` | `selectable` | `trigger-selectable` |
| any question | `floating-good`, `floating-caution`, `floating-bad` | `floating-good-floating-caution-floating-bad` |
| `trigger` | any other string starting `floating-` whose first token the per-row pattern does not match | `a-label-whose-appearance-string-starts-with-floating-other-than` |
| `group` | `compact`; `group-collapse`; `collapse-open`; `group-border` | `group-compact`; `group-group-collapse`; `group-collapse-open`; `group-group-border` |
| `group` | `collapse-closed` | `group-collapse-closed` (inert) |
| a `group` that wraps a `repeat`, and the `repeat` | any string but a per-row-repeat token | `any-value-on-a-vellum-repeat-written-on-its-wrapping-group-or-on` (inert) |
| a `group` that wraps a `repeat` | `<n>-per-row-repeat` | `n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or` |
| any question or group but that one | `<n>-per-row` | `n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one` |
| the same | any other per-row token rule 2 did not refuse | `any-other-per-row-token-the-first-token-web-apps-per-row-pattern` |
| any question | `text-align-center`, `text-align-right` | `text-align-center-text-align-right` |
| any question | `field-list`; `compact` on a question that is no select | `field-list-on-any-question-compact-on-a-question-that-is-not-a` (inert) |
| any | a single string holding a value Android matches inside it, which Android reads as a held or listed value (`ANDROID_INSIDE`'s table, ported) | `a-single-string-no-row-names-that-holds-values-android-matches` |
| any | several tokens, every one a row above or a held token | `multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2` |
| any | several tokens, some read by no runtime on that control, where dropping them leaves a string a row above names | `a-multi-token-string-holding-tokens-no-runtime-reads-on-that` |

`appearanceRows.test.ts` holds the table to the manifest: every entry of the manifest's section
"Appearances" is the entry of a rule 2 port, of a row, or of rule 4, and every row's entry is in that
section or is one of the kind rows of 9.1.

---

## 10. Choices, groups and repeats

### 10.1 Choices

`options.ts::readChoices` reads a select's `item` and `itemset` children.

| The select holds | Result |
|---|---|
| both items and an itemset, or neither | `refuse(select-with-both-items-and-an-itemset-or-no-choices)` |
| an `item` with no `value`, or an `itemset` with no `label` or with neither `value` nor `copy` | `refuse(item-without-value-or-an-itemset-without-label-or-without-both)` |
| an `itemset` with `copy` | `refuseSubtree(itemset-copy)` |
| an `itemset` with `sort` | `refuseSubtree(itemset-sort-ref)` |

**Inline choices.** An option's value is its `value` element's text, as written. By
`selectOptionValue.ts::selectOptionValueProblem` and the values already read on this question: empty,
holding whitespace, or equal to an earlier one is `refuse(choice-value-with-whitespace-empty-or-duplicated)`;
holding both quote marks is `refuse(choice-value-holding-both-an-apostrophe-and-a-double-quote)`; read
by CommCare HQ's build as an instance (problem `instance-read`, part 03, section 5.1) is
`refuse(choice-value-read-as-an-instance)`, `detail.name` the text `instanceScanRead` answered; holding
one kind of quote mark is `take(choice-value-containing-or)`. Its label is 12. The options keep the
body's order. One option is a select (part 04, 7.1).

**An itemset** is classified from its `nodeset`, read with `readFormSyntax`, and the form's instance
declarations. The nodeset's head must be `instance('<id>')`.

| Nodeset | Label and value refs | Result |
|---|---|---|
| `instance(id)/<tag>_list/<tag>`, with or without one predicate on the last step, where the form declares `id` with `src="jr://fixture/item-list:<tag>"` and `input.lookup.table(tag)` is defined | each a single name step that is one of the table's columns | `optionsSource: { kind: "lookup", tableId, labelColumnId, valueColumnId }` under `take(lookup-table-select-selectdynamic-mselectdynamic-itemset-nodeset)` and `take(itemset-label-value-refs-to-lookup-fields)`; a predicate is a pending expression under the field's `lookup_options_source` slot (11.1) |
| the same | an attribute step or a longer path | `refuse(itemset-refs-to-attr-or-property-qualified-fields)` |
| the same | `jr:itext(…)` as the label | `refuse(itemset-label-jr-itext-field)` |
| the same | a name the table has no column for | left unclaimed: `unrecognized`, `detail.name` `xform:itemset/value@ref` or `xform:itemset/label@ref`, and the defect D7 (5.1), which says which of the two refs it was and names neither the column nor the table: the catalog part 11 built holds every field HQ lists for the table, so a missing one is Nova's to learn |
| the same shape, `input.lookup.table(tag)` undefined | | `handOffSubtree(itemset, "lookup-table-read", tag)`, and `{ tag, place }` in `facts.unreadTables` (4.3; 17.4). The select gets no `optionsSource`, so the draft is no document Nova would return, and part 11's finding for the table is what the person reads |
| `instance('casedb')/casedb/case…` with the value ref `@case_id` | one property or attribute step | the forms stage proposes `optionsSource: { kind: "cases", caseType, labelProperty }` from the nodeset's own `@case_type` literal and the label ref, registers the rest of the nodeset's predicate as a pending expression under the field's `lookup_options_source` slot (11.1), and in stage 10, with the filter bound, rebuilds the nodeset with `caseOptions.ts::caseOptionsNodeset` and compares it through `sameTree`: equal, the itemset is `take(itemset-over-casedb-in-nova-s-case-choices-shape)`; different, `refuse(itemset-over-casedb-or-another-instance-advanced-data-source)` |
| any other | | `refuseSubtree(itemset-over-casedb-or-another-instance-advanced-data-source)` |

**Manifest edit.** Nova writes a casedb itemset today (`builder.ts::buildFieldParts`, the `caseSource`
branch) and no entry holds it by name. New entry `questions/itemset-over-casedb-in-nova-s-case-choices-shape`,
section "Question types", beside `itemset-over-casedb-or-another-instance-advanced-data-source`:
`valueClass` `case-choices`; `disposition` `HELD`; `item` "itemset over `casedb` whose value is
`@case_id`, whose label is one property or attribute, and whose nodeset is the case query Nova writes for
a question's case choices (`caseOptions.ts::caseOptionsNodeset`)"; `dispositionCell` "**HELD**:
`optionsSource: cases`"; `slotChanges` `[]`; `area` `questions`; and `surfaceKeys`, `platforms`
(RUNS / RUNS on both), `emission` and `gates` (`["privilege/lookup_tables"]`) copied value for value
from the entry it splits from. That entry's `item` becomes "itemset over casedb in any other shape, or
over another instance (advanced data-source editor)", and it keeps its class `advanced-data-source`,
so the pair on the shared keys is disjoint.

### 10.2 Groups, Question Lists and sections

A `group` control that does not wrap a repeat is a `group` field over its data node.

| The group | Field | Claim |
|---|---|---|
| no appearance, a label | `group` | `take(group-group-ref-label-no-appearance)` |
| no appearance, no label | `group` | `take(group-group-ref-with-no-label-and-no-appearance-outside-a)` |
| appearance `field-list` in any case | `group` with `fieldList: true`, or a `section` (below) | `take(question-list-group-appearance-field-list-labelled)`, `take(question-list-unlabelled-anywhere-else)`, or `take(question-list-unlabelled-when-every-root-field-is-a-section-and)` |
| a group nested in a Question List | as its own row | also `take(groups-nested-in-a-question-list)` |
| a repeat whose rows the worker adds, anywhere under a Question List | | `refuse(user-controlled-repeat-inside-a-question-list-a-group-whose)` at the repeat |
| any other appearance | | 9.2 |

The runtimes read `field-list` in any letter case (Core's
`FormEntryController.isHostWithAppearance` compares ignoring case, and Formplayer, the Web Apps
client and a device run Core). CommCare HQ's form builder and its question summary read only the
lower-case token as a Question List (`parser.js`: `appearance === 'field-list'`;
`xform.py::_infer_vellum_type`); HQ's reports and exports treat `Group` and `FieldList` alike
(`reports/formdetails/readable.py`,
`export/models/new.py::FormExportDataSchema.datatype_mapping`). So the reader holds a case variant
as `fieldList`, and Nova writes `field-list`. After a first publish HQ shows such a group as the
Question List it already ran as, which is Nova's spelling of the form and is declared by
`forms-and-settings-rewritten`. Acceptance draws no difference from HQ's own summary of that
group: HQ's type there follows a spelling, not what the form runs as (part 09, Departure 18).

**Sections.** `containers.ts::rootSections` runs after the root's fields are known. The form's root
fields all become `section`s exactly when: there is at least one; every root field is a Question List;
none has a bind `relevant`; none has label media; and none holds, at any depth, a repeat whose rows the
worker adds. Otherwise each stays a `group` with `fieldList`. This is the rule the manifest's three
Question List entries state, and it is the document Nova's own editors make of that wire: a form Nova
sectioned and a form of root Question Lists print one source
(`builder.ts::buildContainer`, "A SECTION is ALWAYS a field-list").

A group's label media is `account(group-repeat-label-media-other-than-a-missing-file-the-media)`; its
label is `take(group-repeat-label-text-markdown)` (12).

### 10.3 Repeats

A `group` whose appearance is not `field-list` in any letter case and that holds exactly one `repeat`
child is a repeat (`parser.js::buildControlNodeAdaptorMap`, `group`; 8.4 refuses the `repeat` under a
group that is a Question List to either reader). The wrapping group's own `ref`, where it has one, is
`derived(group-ref-x-wrapping-the-repeat-raw-attribute)`. The repeat's node is the node its `nodeset`
names, which must carry `jr:template`; a repeat node without it is left unclaimed (Vellum writes it on
every repeat, `mugs/types/group.js`).

| `jr:count` | `jr:noAddRemove` | The node | Field | Claim |
|---|---|---|---|---|
| none | none | plain | `repeat`, `user_controlled` | `take(repeat-group-user-controlled)` |
| none | present | | | `refuse(jr-noaddremove-without-jr-count)` |
| not a path | | | | `refuse(jr-count-that-is-not-a-path-such-as-data-n-1)` |
| a path to no node of the data tree | | | | `refuse(jr-count-naming-a-node-in-a-secondary-instance-or-no-node)` |
| the path of the generated count node of this repeat (13.2, `count`) | `true()` | plain | `count_bound`; `repeat_count` is that node's `calculate`, registered (11.1) | `take(jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in)` |
| the path of a field | `true()` | plain | `count_bound`; `repeat_count` is a read of that field, which part 08 binds from the registered `jr:count` path | by the field: an int question `take(repeat-with-jr-count-naming-an-integer-question-of-the-form-s)`; a Hidden Value `take(jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in)`; a single select `take(jr-count-naming-a-single-select-question-whose-every-choice)`; a decimal question `refuse(jr-count-naming-a-decimal-question)`; any other kind `refuse(jr-count-naming-any-other-question-kind-text-barcode-multi)` |
| `<wrapper>/@count` | `true()` | a `vellum:role="Repeat"` wrapper holding `ids`, `count` and `current_index` attributes and one `item` child with `id`, `index` and `jr:template` | `query_bound`, `placement: "model-iteration"` | `take(repeat-model-iteration-vellum-role-repeat-ids-count-current)`, held to 10.4 |
| the generated query count node (13.2, `query-count`) | `true()` | a wrapper holding the generated ids and count nodes and one `item` child with `jr:template`, in a body group over the wrapper | `query_bound`, `placement: "count"` | `take(count-repeat-whose-count-and-row-ids-come-from-one-query-a)` |

The three refusals that need the bound document are decided in stage 10 (`afterBinding.ts`), from the
bound `repeat_count`: a Hidden Value count the checker does not type as a whole number is
`refuse(jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer)`; a single select with a choice
that is no whole number is `refuse(jr-count-naming-any-other-question-kind-text-barcode-multi)`; a count
that reads the rows it creates (the gate's own rule) is
`refuse(a-count-that-depends-on-the-rows-it-creates-through-calculations)`. Each is found by running the
production rule that would refuse the document (`validator/rules/field.ts`) over the candidate and
mapping its code, so the reader and the gate cannot disagree.

**A model-iteration repeat's parts.** The wrapper's four setvalues and the `@current_index` bind are
recognized by rebuilding them with `builder.ts::buildQueryRepeat`'s own trees for the wrapper's path and
comparing (13.1's method): `@ids` at the wrapper's event holding `join(' ', <query>)`, whose argument is
the pending `ids_query`; `@count`; the row's `@index` and `@id` at `jr-insert`. A wrapper whose parts
differ is left unclaimed. The repeat captions `jr:addCaption` and `jr:addEmptyCaption` are
`refuseSubtree(repeat-add-captions-jr-addcaption-jr-addemptycaption)`; the others are
`dropSubtree(other-repeat-captions-choosecaption-delcaption-donecaption)` where they hold text and
`refuseSubtree(those-captions-referencing-itext)` where they reference itext.

A query repeat's field is at the wrapper; its children are the `item` row's children, and `item` is no
field (`NodeRole` `query-row`).

### 10.4 Where model iteration is held

Nova runs model iteration for a query repeat only where `queryRepeatPlacement.ts::queryRepeatPlacementNeeds`
is empty, and the gate refuses a held `model-iteration` placement elsewhere
(`QUERY_REPEAT_MODEL_ITERATION_SHAPE`). The reader admits exactly that. `repeats.ts::modelIterationVerdict`
runs in stage 10 over the bound document (`ctx.doc`):

| The repeat | Result |
|---|---|
| no need | held |
| need `nested` | `refuse(model-iteration-repeat-nested-in-another-repeat-of-any-kind)` |
| need `query-reads-answers`, and some answer the query reads is certainly blank where the setvalues run: a question with a control and no default, or a node whose only load-time setvalue stands after the wrapper's `@ids` setvalue in A's order (11.3) | `refuse(model-iteration-repeat-whose-query-reads-a-form-answer-that-is)` |
| need `ancestor-condition-changes`, and the group's condition reads a question with a control and no default | `refuse(model-iteration-repeat-under-an-ancestor-that-core-s-load-can)` |
| any other need | `refuse(model-iteration-repeat-outside-nova-s-model-iteration-rule)`, new |

The two manifest refusals are claimed only where the blank answer is certain, because their next step
sends a person to change the form in CommCare HQ, and that is wrong advice for a form that works. Every
other shape is `not-yet`.

**Manifest edit.** New entry `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule`,
beside `repeat-model-iteration-vellum-role-repeat-ids-count-current`: `valueClass`
`model-iteration-outside-nova-s-rule`; `disposition` `HELD-NEW`, `subject: "repeats"`, `owner: "xform"`;
`item` "a model-iteration repeat with a display condition, or whose query reads a form answer set when
the form loads, or under a group whose display condition reads an answer or the clock, outside the three
refused rows"; `dispositionCell` "**HELD-NEW**: model iteration by the load-time rule (README, "Load-time
values"); Nova runs model iteration only where nothing the query reads can change
(`queryRepeatPlacement.ts::queryRepeatPlacementNeeds`)"; `area` `questions`, section "Question
types"; `surfaceKeys`, `platforms` (RUNS / RUNS on both), `emission` and `gates` (`[]`) copied value
for value from the entry it sits beside; no `slotChanges`, as a HELD-NEW entry holds none. That
entry's `item` gains ", un-nested, with no display condition, whose query reads no answer of the
form". The new entry joins the pair `repeats` at `not-yet`, whose sentence must then hold of a
repeat's button captions and of this shape alike ("Copy").

---

## 11. Logic slots and load-time values

### 11.1 Pending expressions

The forms stage parses no expression for its meaning. For each attribute that holds one it
registers a `PendingExpression` and claims nothing; stage 7 hands every registration to part 08's
`readExpressions`, which binds it against the provisional document (2.3), and the frame applies each
`ExpressionClaim` it answers to the node the expression was registered with. An attribute nothing
registers is unclaimed.

The record is part 08's, exactly as its section 2.5 writes it (`ReadMode`, `PendingExpression` with
`ref`, `text`, `mode`, `place` and `key`, and `pendingPlaceholder`), in
`lib/commcare/reader/pendingExpressions.ts`. This part adds to that file only the registry that
keeps what the record does not hold: the node, a default's event, and what the expression stage
answered for it.

```ts
// lib/commcare/reader/pendingExpressions.ts
export interface PendingRegistry {
	/** Register one expression with the node it was read from. Returns the registration's index. */
	register(expression: PendingExpression, at: ClaimSite,
	         options?: { readonly event?: "xforms-ready" | "jr-insert" }): number;
	/** Every registration, in registration order: what `readExpressions` takes. */
	list(): readonly PendingExpression[];
	/** The node the registration at `index` was read from, and its event where it is a default. */
	site(index: number): { readonly at: ClaimSite; readonly event?: "xforms-ready" | "jr-insert" };
	/** What the expression stage answered for the registration at `index`. */
	outcome(index: number): {
		readonly expression: Expression | undefined;
		readonly claim: ExpressionClaim | undefined;
	};
}
```

`outcome` is filled by `bindExpressions` from the run it applies: `expression` is
`ExpressionReading.bound[index]`, and `claim` is the claim whose `source` is `index`, the slot's own
(the one whose `key` is the registration's `key`, where part 08 also answers surface-use claims for
the same expression). For a registration nothing bound, both are undefined. Parts 07
and 08 read a registration's result through it and no other way.

`ref` is a `SlotContextRef` (`lib/domain/expression/types.ts`), so the slot must exist in the
provisional document: stage 3 records each attribute on its draft, and `mintFields` (stage 5b)
registers them once the owner has its UUID. A required slot holds `pendingPlaceholder`. The
evaluation context is the slot's own, from `slotContext`, so the reader states no path of its own.
`mode` is `{ target: "xform", constraint }`, `constraint` true for a `validate` alone. `key` is the
attribute's surface key as `surface.json`'s `xform:` family spells it. The record holds no shadow:
a `vellum:` shadow is judged here (14.2), once, and part 08 compares none.

| Source | `ref` | `key` |
|---|---|---|
| a field's bind `relevant`, `constraint`, `calculate` | the field, slot `relevant`, `validate`, `calculate` | `xform:model/bind@relevant`, `@constraint`, `@calculate` |
| a field's bind `required` | the field, slot `required` | `xform:model/bind@required` |
| a field's default (11.2) | the field, slot `default_value`; the registry keeps its event | `xform:setvalue@value` |
| a count node's `calculate` (10.3) or a direct `jr:count` | the repeat, slot `repeat_count` | `xform:model/bind@calculate`, or `xform:repeat@jr:count` |
| the argument of a query repeat's `join(' ', …)` | the repeat, slot `ids_query` | `xform:setvalue@value`, or `xform:model/bind@calculate` in the count placement |
| a row guard's left operand, a scalar check's left operand (13.2) | the repeat's `relevant`, the question's `validate`; `text` is the operand's own source text | the attribute's key |
| an `<output>` of the source language's text that `literalOutputText` does not answer for (12.3) | the prose slot's `ProseSlotRef` (`label`, `hint`, `help`, `validate_msg`, or `option_label` with its option); one registration per `value` part, in part order | `xform:output@value` |
| an itemset's predicate over a table, and the filter of a casedb itemset (10.1) | the field, slot `lookup_options_source` | `xform:itemset@nodeset` |
| a Connect block's calculate (15) | the form, slot `assessment_user_score`, `deliver_entity_id` or `deliver_entity_name` | `xform:model/bind@calculate` |

Three things are not registered. The `calculate` of a `nova_constraint_<q>_<n>` node (13.2) is no slot
of the document: it goes to part 08 in `env.generatedValues` (17.2), and part 08 puts it back where
the question's `validate` reads the node. An `<output>` of any language but the source is matched to a
source output and never bound on its own (12.5). And the attributes of a stand-in (2.3) are covered
by its finding.

`required` is one slot whether the attribute is `true()`, `false()` or a condition; part 08 claims
`bind-required-true` where the text binds to `match-all` and `bind-required-expr` otherwise, and holds a
`required` of `false()` as the `match-none` it binds to, never as absent: a Nova document can store that
tree there, it prints `false()`, and the read of Nova's own print gives it back (part 08, 9.2 and its run
E5). No row of 16.2 names the pair, since the two print different bytes. A bind's `requiredCondition`, in
Vellum's namespace or bare, is 14.3.

### 11.2 Defaults

A model `setvalue` is a field's default when its `ref` names a field's node (`parser.js::parseSetValue`).

| The setvalue | Result |
|---|---|
| `xforms-ready`, on a field in no repeat | the field's `default_value`: the element, `event` and `ref` under `take(setvalue-event-xforms-ready-default-on-a-question-outside)`; `value` pending |
| `jr-insert`, on a field in a repeat | the same under `take(setvalue-event-jr-insert-default-inside-a-repeat-not-reading)` |
| the event of the other placement | `refuseSubtree(a-default-value-s-setvalue-whose-event-does-not-match-where-the)` |
| a second default on one field | `refuseSubtree(a-second-default-setvalue-on-one-question)` |
| any other event, or a `ref` that names no field and that no plugin shape owns (model iteration, the count placement's row, a case region) | `refuseSubtree(setvalue-event-xforms-value-changed-authored-xforms-revalidate)` |
| a `setvalue` inside a control | `refuseSubtree(actions-nested-inside-controls)` |

Part 08 claims the `value` attribute under the same entry, or under
`a-default-value-that-reads-form-nodes` where the bound value reads a form node.

### 11.3 A's effective load-time order

Core runs an event's actions in the order the model holds them (`ActionController.java::triggerActionsFromEvent`),
every `xforms-ready` action before any calculate (`FormDef.java::initialize`), and a setvalue stores its
value through the node's bind type (`SetValueAction.java::processAction`, `Recalculate.wrapData`). HQ's
build appends each value it adds to the end of the model (`xform.py::XForm.add_setvalue`:
`self.model_node.append`), so a case preload runs after every setvalue of the source. Nova writes
setvalues in data-tree order (`builder.ts::inDataTreeOrder`), and reads a preload as the question's own
default at the question's place. So the order can move, and it matters exactly where one load-time
value reads a node another sets.

```ts
// lib/commcare/reader/xform/loadOrder.ts
export interface LoadStep {
	readonly event: "xforms-ready" | "jr-insert";
	/** The data path set, an attribute as its last step `@name`. */
	readonly target: string;
	readonly pending?: PendingExpression;
}
/** A's order of the form's own setvalues: the source's, in document order. */
export function effectiveLoadOrder(form: ReadXForm): readonly LoadStep[];
/** Each pair of one event whose relative order differs between A and Nova's emission of the
 *  document, where `reader` reads `read.target`. */
export function loadOrderConflicts(
	order: readonly LoadStep[],
	emitted: readonly LoadStep[],
	reads: (step: LoadStep) => ReadonlySet<string>,
): readonly { readonly reader: LoadStep; readonly read: LoadStep }[];
```

`emitted` is the same steps in the order `inDataTreeOrder` gives their targets. `reads` is the set
of data paths the step's bound value reads: the tree in the step's slot of `ctx.doc`, walked with
`expression/walk.ts::walkExpressionTerms` over its field, form-node and repeat-row terms, each
mapped to its source path through `ReadSourceNames` (17.2). A step whose expression part 08 did not
hold reads nothing here; its own finding stands. Stage 10 (`finishForms`) runs both per form, and
each conflicting pair is `refuse(default-setvalues-in-an-order-a-save-in-the-form-builder-changes)`
at the reader's question, the new entry below.

A value HQ's build appends (a basic `case_preload` or `usercase_preload`, an advanced load's
`preload`) is no step here. Part 07 reads it as the question's own default and judges the move
itself, in `settlePreloads`, with its `caseManagement/preloads.ts::laterLoadReaders` over the bound
document, under its own entries (its 3.7): the same rule, for the one value whose place in A is
always the end of the load.

A form HQ's form builder saved has no such pair of its own: `writer.js::createSetValues` writes the
form-level setvalues and then each question's in data-tree order, which is Nova's order.

**Manifest edit.** New entry
`questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes`, section "Binds, actions,
model and head content", beside `a-second-default-setvalue-on-one-question`: `surfaceKeys`
`["xform:setvalue"]`; `valueClass` `order-a-save-changes`; `disposition` `REFUSED`, `reasons: [{ kind:
"not-hq-editable", named: "Vellum writes defaults in data-tree order (`writer.js::createSetValues`)" }]`,
`subject: "question-logic"`; `area` `questions`; `item` "two default setvalues of one event standing in
another order than their questions, where one reads the node the other sets"; `dispositionCell`
"**REFUSED**: not HQ-editable: Vellum writes each question's default in data-tree order on every save
(`writer.js::createSetValues`), which changes what the reading default finds"; `platforms` `{ kind:
"none", cell: "\u2014" }`, the one value `schema.ts`'s refused arm admits, with `emission` `{ cell:
"\u2014", markers: [] }` and `gates` `[]`, as the entry it sits beside holds them. That entry holds its
own value class already (`second-default`).

### 11.4 A Hidden Value's bind type

Nova writes a Hidden Value's bind as `xsd:string`, or `xsd:dateTime` where
`xform/bindType.ts::fieldBindType` says so: it writes a date-and-time property, or it writes nothing and
its calculate is the clock-keeping date. An absent type and `xsd:string` are one state: Core reads an
absent type as no data type, and `Recalculate.wrapData` treats that and text alike for every value
(only the boolean, integer, long, select, multi-select, date-and-time and time types change what it
stores: its `DATATYPE_CHOICE` and `DATATYPE_CHOICE_LIST` arms wrap a selection as the others wrap a
number or a date). Every other type changes what a calculated or defaulted node holds, so:

- at 9.1, a bind-only node typed anything but `string` or `dateTime` is
  `refuse(hidden-value-bound-a-type-nova-would-not-write)`;
- in stage 10 (`finishForms`), per form over the bound document, each Hidden Value's source type class
  (text, or date and time) is compared with
  `fieldBindType(field, effectiveCaseTypes(ctx.doc), fieldCaseWriteViews(ctx.doc, uuid))`.
  A difference either way is the same refusal, raised with `Accounting.finding` at the question (the
  `type` attribute was claimed at 9.1). This is the outline's item 9 ("the bind rule of
  `fieldValueType` run backwards"), made a comparison with the production rule so it cannot drift.
  It runs in every reading, over the provisional document where findings stand (2.3), so a person
  who fixes an account does not meet this finding for the first time on the next check. Where part
  08 did not hold the Hidden Value's calculate, or a case write of the form was itself a finding,
  the comparison for that question is skipped: its inputs are not known, and the finding that
  stands already sends the person to that question or that form.

**Manifest edit.** New entry `questions/hidden-value-bound-a-type-nova-would-not-write`, beside
`hidden-value-bound-xsd-datetime`: `surfaceKeys` `["xform:model/bind@type"]`; `valueClass`
`hidden-value-other-bind-type`; `disposition` `HELD-NEW`, `subject: "question-types"`, `owner: "xform"`;
`item` "a Hidden Value whose bind type is one Nova would not write for it: any type but `xsd:string` and
`xsd:dateTime`; `xsd:dateTime` where it neither writes a date-and-time case property nor is calculated by
the clock-keeping date; or text where it does"; `dispositionCell` "**HELD-NEW**: a Hidden Value's own
bind type, which decides what Core stores for its value (`Recalculate.java::wrapData`)"; `area`
`questions`, section "Question types"; `platforms`
`{ kind: "each", cell: "RUNS / RUNS", webApps: { reading: "runs" }, android: { reading: "runs" } }`;
`emission` `{ cell: "the type as written on the bind of a data node no control draws", markers: [] }`;
`gates` `[]`; no `slotChanges`.

---

## 12. Text

### 12.1 Itext, by reference

`itext.ts::readItext` reads `itext` into an `ItextTable`: for each `translation`, its `lang`, and for
each `text` its `id` and its `value` children by `form` (`default` where absent). A `translation`'s
`lang` that is one of the app's codes is
`take(application-and-settings/langs-code-spelling-matching-hq-s-grammar-a-z-2-3-a-z-e-g-en-hin)`,
key `xform:model/itext/translation@lang`, read as the language the texts under it belong to (6.3).

| The table holds | Result |
|---|---|
| a `translation` whose `lang` is none of the app's codes | `dropSubtree(translation-for-a-language-not-in-langs)` |
| `translation@default` | `drop(itext-ids-other-than-a-pragma-key-default-placement)`; Nova marks `langs[0]` |
| two `text`s of one `id` in one translation | `refuseSubtree(duplicate-text-id-in-one-translation-jr-itext-with-double-quotes)` at the form |
| a `text` whose first translation has no default value | `refuse(a-label-whose-itext-in-the-first-translation-has-no-default-form)` at the question that references it |
| a translation absent for an app language | nothing to claim: its texts read as untranslated (12.5), the state `a-translation-missing-for-an-app-language` holds |

A text is found by what references it. A control's `label`, `hint`, `help` and `alert`, an `item`'s
`label` and a bind's `jr:constraintMsg` each hold a `ref` (or the attribute itself) that
`readFormSyntax` reads as a call of `jr:itext` with one string argument: that string is the id, whatever
its spelling. Vellum's ids are free text an author can rename and share
(`javaRosa/util.js::getDefaultItextId`), and Nova writes its own (`xform/itextIds.ts`), so the id is
never content: the `text@id` attribute is `drop(itext-ids-other-than-a-pragma-key-default-placement)`.

| The reference | Result |
|---|---|
| the argument is written between double quotes (the string node's first source character) | `refuse(duplicate-text-id-in-one-translation-jr-itext-with-double-quotes)` |
| the id is in no translation of the first language | the same entry |
| a `label` with text and no `ref` | `take(inline-label-text-label-no-itext)`: that text, in the source language |
| a bind's `jr:constraintMsg` that is no `jr:itext` call and no protected message (13.2) | `refuse(literal-jr-constraintmsg-text-no-itext)` |
| a `jr:constraintMsg` and an `alert` naming two ids | left unclaimed |
| one id referenced by two slots or two questions | each slot reads the text as its own: Nova holds a text per slot, and writes two entries of equal text, which HQ's build merges again (`XForm.normalize_itext`) |

After every reference is read, the forms stage finds which ids an expression reads. It reads the
text of every logic attribute, setvalue value and output of the form (the texts 11.1 registers)
with `readFormSyntax` and collects each call of `jr:itext` whose one argument is a string: the
grammar's tree, never a pattern over text. It needs no binding, so it runs in stage 3. Then:

| A `text` no slot references | Result |
|---|---|
| read by an expression | `refuseSubtree(itext-entry-referenced-only-from-jr-itext-in-an-expression)` |
| its id is one of `PRAGMA_KEYS` | `refuseSubtree(itext-pragma-entries-pragma-form-descriptor-pragma-skip-full)` |
| otherwise | `dropSubtree(itext-entry-referenced-by-no-question-and-no-expression-other)` |

`PRAGMA_KEYS` is the seven the manifest names: `Pragma-Form-Descriptor`,
`Pragma-Skip-Full-Form-Validation`, `Pragma-Submit-Automatically`, `Pragma-Suppress-Autosync`,
`Pragma-Volatility-Key`, `Pragma-Volatility-Entity-Title`, `Pragma-Volatility-Window`. A referenced text
whose id is one of them is, in order: where another `text` holds equal values in every translation and
form under an id that sorts before it, `account(a-question-text-whose-itext-id-is-a-pragma-key-hq-s-build-merges)`;
where it is `Pragma-Volatility-Entity-Title` or `Pragma-Volatility-Window` and the form has no
`Pragma-Volatility-Key` text, `account(a-question-text-whose-itext-id-is-pragma-volatility-entity-title)`;
where it is `Pragma-Form-Descriptor`, `refuse(a-question-text-whose-itext-id-is-pragma-form-descriptor-where)`;
otherwise `refuse(a-question-text-label-hint-help-validation-message-repeat-add)`. Under the two
`account` rows the text reads as any text does.

**Reads of a text by an expression.** `jr:itext('<id>')` in form logic binds a translation unit
(`xform/itextIds.ts::itextUnitForId`), by Nova's own id today. The reader hands part 08 the map from
each source id to the unit of the slot that owns it (`env.itextUnits`, 17.2, built from
`ItextTable.owners`), so a read of an HQ id binds the unit of the text it names and prints as Nova's
id afterwards. An id that owns two slots is read through the first in document order. No fact is
kept of the re-spelled id: part 09's register covers it as spelling, under
`forms-and-settings-rewritten` (its 11.4), and reads nothing of the reader for it.

### 12.2 Forms of a text

`prose.ts::readText` reads each referenced text by the slot that references it. A form named below is
claimed on its `value` element. `Form.plainText` is set from `vellum:ignore` (8.2).

| Form | Label of a question | Choice label | Help | Hint | Validation message | Label of a group, repeat or section |
|---|---|---|---|---|---|---|
| default | `take(label-default-text-itext-value)` | `take(choice-label-text-markdown)` | `take(help-text-markdown-form)` | `take(hint-text)` | `take(validation-message-text)` | `take(group-repeat-label-text-markdown)` |
| `markdown`, equal to the default in every language | `take(markdown-form-equal-to-the-default-text)` | the same | the same | `drop(hint-markdown-form)` | `drop(validation-message-markdown-form)` | `take(markdown-form-equal-to-the-default-text)` |
| `markdown`, differing in some language | `refuse(markdown-form-differing-from-the-default-text)` | the same | the same | `drop(hint-markdown-form)` | `drop(validation-message-markdown-form)` | the refusal |
| `markdown` in some languages only | `refuse(a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk)` on every text | | | | | |
| no `markdown` in any language | `plainLabel` under `take(label-with-no-markdown-form)` | `plainLabel` under `take(choice-label-with-no-markdown-form)` | `plainHelp` under `take(help-text-with-no-markdown-form)` | nothing | nothing | `plainLabel` under `take(label-with-no-markdown-form)` |
| `image`, `audio`, `video` | 12.4 | 12.4 | 12.4 | `account(hint-media-other-than-a-missing-file-the-media-section-refuses)` | `account(validation-message-media-constraintmediaitext-other-than-a)` | `account(group-repeat-label-media-other-than-a-missing-file-the-media)` |
| `video-inline` | `refuse(label-video-inline)` on any text | | | | | |
| `long` | `refuse(long-form)` | | | | | |
| `short` | `account(short-form)` | | | | | |
| `big-image` | `refuse(label-big-image)` | `refuse(choice-big-image)` | `refuse(label-big-image)` | | | |
| `qrcode`; `tts` | `refuse(label-qrcode)`; `refuse(label-tts)` | | | | | |
| `__nova_identity`, `__nova_mode`, `__nova_locale`, `__nova_piece_<n>` and their `;markdown` forms | 13.2, the protected message | | | | | |
| any other name | `account(custom-form-names)` | | | | | |

Rules that complete the table:

- **Equal** means the `markdown` value's child nodes equal the default value's in the same language:
  the same text nodes and the same `output` elements with the same `value` or `ref`.
- **The plain flags follow part 03's canonical choice.** A flag is set only where the text is not blank
  in every language and the form does not hold `plainText`. A text blank everywhere and any text in a
  `plainText` form get none.
- **A form whose text formatting is off** (`plainText`) and that holds a `markdown` value on a label, a
  choice or a help text is `refuse(a-markdown-form-in-a-form-whose-text-formatting-is-off)` at that
  question: the form builder's next save drops the copy. A hint's or validation message's copy there is
  dropped as anywhere.
- **Media on a slot Nova holds none for** (a hint, a validation message, a group's, repeat's or
  section's label). The three `account` entries of the `image`, `audio`, `video` row each say "other
  than a missing file", so the claim is made only where `input.media.resolve(path)` answers `asset`;
  the asset reaches no slot and is not listed. Where it answers `no-entry` or `unreadable`, the
  `value` is handed off (`"media-reference"`) as a `PendingMedia` of slot `unheld_itext` (12.4):
  Android's install check reaches every itext media form, held slot or not, so part 11's rule must
  see it (its 3.2, row 1).
- **A translation left blank.** A `value` present and empty in a language other than the first,
  where the first language's text is not blank, is
  `take(an-explicitly-blank-value-in-a-non-default-language-where-the)`: read as no translation
  (`translationEntryFor` gives no entry) and counted in `ReadFormFacts.blankTranslations` (part 09,
  Decision 19). A `value` present and empty in the first language where another language holds text
  is `refuse(an-explicitly-blank-value-in-the-first-language-where-another-holds-text)`, new. A
  missing `text` or `value` is no blank: it reads as untranslated. Two cases the pair leaves: a
  blank `value` in another language of a text refused this way is claimed under the same refusal,
  one finding at the question; and a text whose values are blank in every language is the default
  row of the table, read as a blank text.

**Manifest edits.** Three entries, each with its inventory row.

- NEW `questions/a-markdown-form-in-a-form-whose-text-formatting-is-off`, as part 03's section 10
  writes it (REFUSED, `not-hq-editable`, `subject: "question-text"`, `surfaceKeys`
  `["itext-form:android/markdown", "itext-form:core/markdown", "itext-form:hq/markdown"]`,
  `valueClass` `in-a-form-with-formatting-off`, `platforms` the one value `schema.ts`'s refused arm
  admits).
- RE-CUT `questions/an-explicitly-blank-value-in-a-non-default-language-where-the`, REFUSED to HELD.
  `item` stays as the manifest holds it ("an explicitly blank value in a non-default language where
  the default has text"); `valueClass` stays `blank-beside-default-text`; `dispositionCell`
  "**HELD**: read as no translation; Nova writes the first language's text there, as the form
  builder does on every save (`javaRosa/itext.js::ItextForm.getValueOrDefault`), which the first
  publish declares (`blank-translations-filled`)"; `reasons` and `subject` leave; `slotChanges: []`;
  `platforms` and `emission` as `questions/label-default-text-itext-value` holds them
  (`{ kind: "each", cell: "RUNS / RUNS", webApps: { reading: "runs" }, android: { reading: "runs" } }`
  and `{ cell: "itext default form", markers: [] }`).
- NEW `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text`: REFUSED;
  `reasons: [{ kind: "not-hq-editable", named: "Vellum fills a blank value from any language that
  holds text on every save (javaRosa/itext.js::ItextForm.getValueOrDefault)" }]`; `surfaceKeys`
  `["xform:model/itext/translation/text/value"]`; `valueClass` `blank-in-the-first-language`;
  `subject` `question-text`; `item` "an explicitly blank value in the first language where another
  language holds text"; `dispositionCell` "**REFUSED**: not HQ-editable: Vellum fills a blank value
  from any language that holds text on every save
  (`javaRosa/itext.js::ItextForm.getValueOrDefault`)"; `area` `questions`, section "Itext, markdown
  and label text"; the refused arm's fixed `platforms` `{ kind: "none", cell: "\u2014" }` and
  `emission` `{ cell: "\u2014", markers: [] }`; `gates` `[]`.

Part 09's Departure 17 argues the held half at source: Nova's first publish fills a blank from the
default language as the form builder does on save, and a reading's source language is its first
language (6.3). The first-language half stays refused because no first-language text exists to
fill from, and the form builder would fill it from whichever language holds text.

The three media rows of part 01's 3.5 for questions and forms take the wording it gives them.

### 12.3 Prose

A `value` element's children become prose parts in order.

| Child | Part |
|---|---|
| a text node that is whitespace only by `builder.ts::isConsumerWhitespace` | nothing: Core removes it before it reads the text (`XFormParser.getXMLDocument`), and the emitter never writes one |
| any other text node | text, as written |
| `<output>` whose `value` (or `ref`, `take(output-ref)`) `literalOutputText` answers for: it reads as one string literal | text: that string. This is the inverse of `builder.ts::whitespaceOutput`'s ASCII arm and of part 03's bracket output |
| `<output>` it answers for the other way: the value reads as `json-property(<string>, 'v')` where the first string is JSON holding one string member `v` | text: `v`. The inverse of `whitespaceOutput`'s other arm |
| any other `<output>` of the source language | a `value` part holding `pendingPlaceholder("value")`, registered under the prose slot (11.1); part 08 binds it and `canonicalProseAtom` then makes a plain reference its reference part (`output-value-of-a-question-case-or-user-reference`) and leaves anything else a `value` part (`output-value-any-other-expression`) |
| any other `<output>` of another language | matched to a source output (12.5) |
| an element in the XHTML namespace | `refuseSubtree(xhtml-namespace-child-elements-inside-a-value)` |
| any other element | `dropSubtree(other-child-elements-inside-a-value)` |

The forms stage claims no entry for an output it registers: the claim is part 08's, made once the
value is bound. That holds for the two entries part 03 adds only under a run's outcome,
`questions/output-value-holding-text-the-form-builder-rewrites` (its G1 outcome B) and
`questions/output-value-in-a-validation-message-core-cannot-compose` (its G3 outcome C, second
case). Each class is a property of the bound value, so part 08's prose slot row claims each ahead
of `questions/output-value-any-other-expression`, by the predicate part 03 exports for it (part 08,
sections 9.1 and 9.2), and nothing of `reader/xform/` names either.

`prose.ts::literalOutputText(value: string): string | undefined` is the one reader of those two
shapes, over `readFormSyntax`'s tree. It needs no bound tree, and the expression reader writes no
second (part 08, its 10.2). A literal output read as text is confirmed by the print, as
every proposal is: `builder.ts::buildLabelNodes` over the proposed text must write that same output
back, and where it writes a plain text node the output is kept as the value it is, a `value` part.

Adjacent text parts are joined into one, which `proseTemplateSchema` requires. `isConsumerWhitespace`
moves from `builder.ts` to the new `lib/commcare/xform/consumerWhitespace.ts`, which both import, so the
two sides hold one definition of a run Core drops.

### 12.4 Media

`media.ts::readMediaForms` reads the `image`, `audio` and `video` values of a text on the slots Nova
holds media for: a question's label (`label_media`), its help (`help_media`) and an inline choice
(`media`). The value's text is a path.

- **One path in every language.** Each media kind's path must be equal in every app language that holds
  a `text` for the id, and present in all or in none. Then the slot holds that kind, under
  `take(label-image-audio-video-same-asset-every-language)`, `take(help-media)`, `take(choice-image)` or
  `take(choice-audio-video)`. A path that differs between two languages, or is present in one and absent
  in another, is `refuse(label-or-option-media-differing-by-language)` at the question (part 01's
  3.5 holds the wording of the three media rows of questions and forms).
- **The file.** `input.media.resolve(path)`: `asset` puts the asset id in the slot, makes the `take`
  claim above on each language's `value`, and adds a `ReadMediaReference` to `facts.mediaReferences`.
  `no-entry` and `unreadable` put nothing in the slot and hand each language's `value` off
  (`XmlCursor.handOff(node, "media-reference", path)`, 4.3), with one `PendingMedia` in
  `facts.pendingMedia`. No claim is made here because the entry is not the reader's to pick: part
  11's rule (its 3.2) makes such a reference a finding or inert and listed by the platforms the app
  runs on and by what each runtime draws for that slot, the two entries its 13.1 splits
  `expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` into (part
  01, 3.5).

```ts
export interface ReadMediaReference {
	readonly path: string;
	readonly assetId: string;
	readonly mediaKind: MediaKind;
	readonly place: HqPlace;
	/** A `lib/domain/mediaRefs.ts::MediaRefLocation` kind: `field_media_bundle`, `option_media`,
	 *  `app_logo`, and the menu and list kinds part 07's readers pass. */
	readonly slot: string;
}
/** A reference whose path the index gives no asset for: handed off, with its node in the log. */
export interface PendingMedia {
	readonly path: string;
	readonly mediaKind: MediaKind;
	readonly resolution: "no-entry" | "unreadable";
	readonly place: HqPlace;
	/** As `ReadMediaReference.slot`, or `unheld_itext` for a slot Nova holds no media for (12.2). */
	readonly slot: string;
}
```

Part 11's `hqMediaReferencesOf(facts)` (its 2.1) is the one bridge from these two lists to its own
`HqMediaReference`, and its table of slot strings is the contract: this part writes exactly
`field_media_bundle`, `option_media`, `app_logo` and `unheld_itext`.

`readMediaForms(ctx: ReadContext, form: ReadXForm): void` is called by `readForms`, once per form.

**A map of paths by language** (a menu's, a form's or a case list menu item's icon and audio label,
the Web Apps logo, an image column's image) is read by the same rule through one function, which part
07's `menus/navMedia.ts::readNavMedia` calls for every map it reads (its 2.2):

```ts
// lib/commcare/reader/xform/media.ts
/** One shared path of a `{ lang: path }` map, resolved; or why there is none. */
export function readMediaMap(
	ctx: ReadContext,
	byLanguage: Readonly<Record<string, string>>,
	at: { readonly site: ClaimSite; readonly place: HqPlace; readonly slot: string;
	      readonly mediaKind: MediaKind },
): { readonly kind: "asset"; readonly assetId: string }
 | { readonly kind: "none" }
 | { readonly kind: "handed-off" }
 | { readonly kind: "differs" };
```

`none` is an empty map. `differs` is a path that is not one in every app language that holds one;
the caller refuses under its own `…-differing-by-language` entry. `asset` and `handed-off` list the
reference as above; the caller makes its own `take` claim on `asset` and none on `handed-off`.

### 12.5 Translations

`translations.ts::TranslationSink` collects, for each translation unit, its text in every app language.

```ts
// lib/commcare/reader/translations.ts
export interface TranslationSink {
	/** One unit's value in each app language that holds one. The source language's value is the
	 *  slot's own and makes no entry. A later call for one unit and language replaces the earlier. */
	set(unit: TranslationUnitId, kind: "text" | "prose",
	    byLanguage: ReadonlyMap<LanguageTag, LocalizedValue>): void;
	/** Every unit given, in the order first given. */
	units(): readonly {
		readonly unit: TranslationUnitId; readonly kind: "text" | "prose";
		readonly byLanguage: ReadonlyMap<LanguageTag, LocalizedValue>;
	}[];
}
/** The entry a language's value makes, or undefined where it makes none. */
export function translationEntryFor(
	kind: "text" | "prose", source: LocalizedValue, target: LocalizedValue | undefined,
	sourceLanguage: LanguageTag,
): TranslationEntry | undefined;
```

A text unit (a menu's or a form's name, a localized map of part 07's) is given to the sink where it
is read. A prose unit is given in stage 9, once its templates exist. Stage 9 (`finishText`) runs
after part 08 bound the outputs, builds each language's `ProseTemplate`, and writes `ctx.doc`:

- the source language's template is the slot's own value (`langs[0]`, 6.3), already in the document
  since stage 7, each bound output where its placeholder stood;
- an `<output>` of another language is never bound on its own. It takes the part of the source
  output it equals: `finishText` pairs each of the language's outputs with a source output of the
  same text by `sameXPathText` (form rule set), each source output used once, and gives it that
  output's bound part. So a translation's protected parts are the source's own, which is what
  Nova's translation holds (`lib/domain/CLAUDE.md`, "Localization is an overlay"). The `value`
  attribute of a paired output is claimed under the entry its source twin was claimed under, with
  `Accounting.claimEntry`. An output with no twin is the finding below;
- for every other language, `translationEntryFor(kind, source, target, sourceLanguage)` gives no
  entry where the target is absent, is deeply equal to the source, or is blank where the source is
  not (12.2's held blank), and otherwise
  `{ value: target, sourceFingerprint: translationSourceFingerprint(kind, source), origin: "human",
  review: "reviewed", translatedFrom: sourceLanguage }`.

A translation equal to its source is no translation because that is what HQ's form builder leaves for
an untranslated text (it fills it from the default language on every save), because Nova writes the
source text for a missing translation (`lib/commcare/CLAUDE.md`, "Multilingual emission"), so the two
documents print one source, and because Nova then shows the text as not yet translated, which is true.
Menu and form names (7.3, 7.4) and every other localized map part 07 reads go through the same sink
with `kind: "text"`.

**Values that differ between languages.** Nova's translation may move a reference and may not change
which values a text shows (`translationUnits.ts::translationValueIntegrityIssue`, `protected-content`;
the gate's `TRANSLATION_PROTECTED_CONTENT_CHANGED`). A text whose languages show different values is
`refuse(a-text-whose-languages-show-different-values)` at the question: an output of one language with no
twin in the source language, or a source output another language's text leaves out. The unpaired `output`
element is the node refused. The same function then runs over every entry `finishText` wrote, and an
issue it finds that the pairing did not is a reader defect: `unrecognized` at the place of the slot
that owns the unit, `detail.name` `xform:model/itext/translation/text/value`, and the defect D10
("Copy") with the unit's role, the language's position among the app's languages and the issue's
code. The unit's id is not in it: it is built from question ids.

**Manifest edit.** New entry `questions/a-text-whose-languages-show-different-values`, section
"Itext, markdown and label text", beside `output-value-of-a-question-case-or-user-reference`:
`surfaceKeys` `["xform:model/itext/translation/text/value/output"]`; `valueClass`
`outputs-differing-by-language`; `disposition` `HELD-NEW`, `subject: "question-text"`,
`owner: "question-display"`; `item` "a text whose `<output>`s differ between languages: a value one
language's text shows and another's does not"; `dispositionCell` "**HELD-NEW**: a translation that shows
other values than its source text"; `area` `questions`; `platforms`
`{ kind: "each", cell: "RUNS / RUNS", webApps: { reading: "runs" }, android: { reading: "runs" } }`,
`emission` ``{ cell: "`<output value>`", markers: [] }`` and `gates` `[]`, the values of the entry it
sits beside; no `slotChanges`. That entry gains `valueClass: "outputs-equal-in-every-language"`.

---
## 13. Generated nodes

### 13.1 The method

Nova writes nodes no author made, each named by `xform/generatedNodes.ts::planGeneratedNodes`. Reading
one as a question would give the person a field they never wrote and make Nova write a second copy
beside it. Each is recognized the way this plan recognizes every pattern (part 08, 2.1, for an
expression; part 07, 2.4, for a case block): parse, propose, rebuild with the production emitter,
compare trees.

```ts
// lib/commcare/reader/xform/generated.ts
export interface GeneratedRule {
	readonly purpose: GeneratedNodePurpose;
	/** `forms`: settled here. `case-management`: proposed here, settled by part 07 (13.3). */
	readonly settledBy: "forms" | "case-management";
}
/** Total over the union, so a purpose the emitter gains fails `tsc` here. */
export const GENERATED_RULES: Readonly<Record<GeneratedNodePurpose, GeneratedRule>>;
/** Whether an attribute's text is the tree the emitter writes. */
export function sameTree(sourceText: string, expected: WireExpr): boolean;
/** The role of a node with no control that is one of Nova's, proposed against `owners`, the
 *  fields the join has found; undefined where no rule's tree matches, and the node is then a
 *  Hidden Value. `target` is `ReaderInput.target`, which the `url` rule's tree names. */
export function recognizeGenerated(
	node: DataNode, binds: ReadonlyMap<DataNode, BindFacts>, owners: readonly DraftField[],
	target: ReaderInput["target"],
): Extract<NodeRole, { kind: "generated" | "generated-candidate" }> | undefined;

// lib/commcare/xform/generatedNodes.ts
/** A purpose's base name for an owner id. `part` is the count `n` of a constraint count and the
 *  kind of a guard (`type`, `retype`, `text`); other purposes take none. */
export function generatedBaseName(
	purpose: GeneratedNodePurpose, ownerId: string, part?: string,
): string;
```

- **Compare trees, never text.** `sameTree` prints `expected` with
  `xpath/wire/serialize.ts::serializeWire` in the mode the emitter prints that attribute in and asks
  `reader/syntaxCompare.ts::sameXPathText(sourceText, print, { ruleSet: "form" })`. That function is
  part 08's (its 3.1), the one comparison of two XPath texts in the reader: it reads both with
  `readFormSyntax` and compares the trees under rows L1 to L6 of its 3.2 (spacing, grouping
  parentheses, the quote mark, a number's spelling, axis spellings, `./.`). Those six rows need
  nothing else of the expression reader (`readFormSyntax` and `formSyntax.ts` are on `main`), so
  this recognizer does not wait for it. No rule of this part matches a string, and none compares
  `formSyntaxKey`s on its own.
- **The expected tree comes from the emitter.** Each rule calls the function the emitter calls for that
  node (`caseScalarTextValueCalculation`, `datetimeCaseValue`, `captureUrlCalculate`,
  `countPlacementRowPieces`, `protectConstraintMessage`, the `w` builders of
  `builder.ts::buildQueryRepeat`) over the proposed owner's path. Four of the first five are exported
  today, and part 03 exports `datetimeCaseValue` in place of `datetimeCaseValueCalculate`
  (`03-questions-and-text.md`, section 7.1).
  `builder.ts` exports the ones that are private there ("Files"), bodies unchanged, and neither
  `caseOps.ts` nor `countPlacementRow.ts` is touched. Rebuilding that tree for every candidate is
  the one cost of this design that grows with a form's questions times its generated nodes, and
  `ReadWork.rebuilds` counts it (2.2). Where `readerWork.test.ts` finds `rebuilds` growing faster
  than the form, the fix is a memo of the expected tree by purpose and path shape, in
  `generated.ts`. A claim's `where` is already built only where the full log is asked for (4.5),
  so nothing is left to move there.
- **The name must be the allocator's.** `generatedNodes.ts` gains
  `generatedBaseName(purpose, ownerId, part?)`, the base-name templates the allocator holds inline today
  (`nova_constraint_<id>_<n>`, `nova_constraint_message_<id>`, `nova_url_<id>`, `nova_datetime_<id>`,
  `nova_trimmed_<id>`, `repeatCountBaseName`, `queryRepeatBaseNames`, `nova_keyed_<id>`,
  `nova_count_<keyed>`, `nova_condition_<id>`, `nova_guard_<id>_<kind>`, `nova_owner_<id>`,
  `nova_instant_<operation id>_<n>`), which the allocator then calls. A node is a candidate for an
  owner only where its name is that base, or the base followed by `_` and a whole number from 1 with
  no leading zero, the suffix `namespace.ts::Namespace.peek` gives. The name orders the proposals and
  never proves one: the tree names the owner's path, so at most one owner can match.
- **Everything of the node is claimed under one entry.** A recognized node's element, its bind and each
  bind attribute are claimed `derived` under the entry of its purpose's row, so a generated node's
  `type="xsd:int"` is never mistaken for a question's.

What does not match is what it looks like: a node with no control is a Hidden Value (9.1), with its
own calculate and condition registered as any Hidden Value's are (11.1).

### 13.2 Purpose by purpose

`q` is the owner question's path, `r` a repeat's, `P` any parsed subtree. A bind holds exactly the
attributes listed, shadows aside.

| Purpose | Emitter | The node | Its bind | What confirms it | Folds into |
|---|---|---|---|---|---|
| `constraint-count` | `builder.ts::buildFieldParts`, `constraintCollections.ts` | a sibling of `q` with no control, named `nova_constraint_<q>_<n>` | `type="xsd:int"`; `relevant` the tree `count(q) > 0`; `calculate` a call of `count` over a filtered path; no `vellum:calculate` | `q`'s `constraint` reads the node's path | the calculate goes to part 08 in `env.generatedValues`, by the node's absolute path (17.2); part 08 puts it back where `q`'s validation reads the node. Claimed under `bind-constraint` |
| `constraint-message` | `builder.ts::buildFieldParts`, `constraintMessage.ts::protectConstraintMessage` | a sibling of `q` with a body `input` directly after `q`'s control whose one child is a `label` referencing a text id `T` | `type="xsd:string"`, `relevant="false()"`, `readonly="true()"` | `q`'s `jr:constraintMsg` is the tree `protectConstraintMessage(T, messages, lower).expression` gives for the messages read from `T`'s ordinary values, compared through `sameTree` in stage 10, once the outputs are bound; and `T`'s forms are exactly the ones it writes | `q.validate_msg` is `T`'s text (12.3). The node, its control, its bind and the forms are claimed under `protected-constraint-message-carrier-readonly`, `protected-constraint-message-expression`, `protected-constraint-message-forms` and, for `__nova_identity`, `drop(protected-constraint-message-identity)` |
| `count` | `builder.ts::buildRepeatBody` | a sibling of the repeat `r` with no control, named `nova_count_<r>` | `type="xsd:int"`; `calculate` any tree; `vellum:nodeset` | `r`'s `jr:count` names it | 10.3: `repeat_count` is the calculate, registered (11.1) |
| `query-ids` | `builder.ts::buildQueryRepeat` | a child of the wrapper, named `nova_query_ids_<r>` | `calculate` a call `join(' ', P)`; `vellum:nodeset` | the count node reads it | `ids_query` is `P`, registered (11.1) |
| `query-count` | the same | a child of the wrapper, named `nova_query_count_<r>` | `type="xsd:int"`; `calculate` the tree `count-selected(../<ids>)` | the repeat's `jr:count` names it | the count placement (10.3) |
| `query-position` | the same | a child of the wrapper, named `nova_query_position_<r>` | `calculate` the tree `count(../item)` | none needed | nothing: part 08 reads a reference to it as the authoring spelling (`formNodeProjection`'s `query-position` role) |
| `query-id` | `countPlacementRow.ts::countPlacementRowPieces` | a child of `item`, named `nova_query_id_<r>` | the `calculate` the function gives; a `jr-insert` setvalue with the value it gives | the pieces match for the four names | nothing: the row's id |
| `query-index` | the same | a child of `item`, named `nova_query_index_<r>` | `type="xsd:int"`, no calculate; a `jr-insert` setvalue `position(..)` | the same | nothing: the row's index |
| the row guard | `builder.ts::buildQueryRepeat` | the `item` row's bind | `relevant` the tree `position() < ../<count>`, or an `and` whose last operand is that tree | | the repeat's `relevant` is the rest of the `and`, registered with the source text of the left operand as its `text`; with no `and`, no condition |
| `url` | `captureUrlNode.ts` | a sibling of a capture question `q`, named `nova_url_<q>` | `type="xsd:string"`; `calculate` the tree `captureUrlCalculate(q, input.target)`; `relevant` `count(q) > 0` | a case action names it (part 07) | part 07: the write's value is `capture-link(q)` |
| `datetime` | `datetimeCaseValue.ts` | a sibling of `q`, named `nova_datetime_<q>` | `type="xsd:string"`; `calculate` the tree `datetimeCaseValue` of `q` as a field read (part 03, section 7.1), or the earlier tree `typedInstantValue(q)`, which an app Nova published before step 6 holds; `relevant` `count(q) > 0` | a case action names it, or `q`'s trimmed sibling reads it (part 07) | part 07: the write reads `q`. Under the earlier tree the fold also appends `{ entry, path, register: "date-and-time-saved-as-hq-stores-it" }` to `ReadFacts.sameStateRewrites` (part 09, section 11.2) |
| `trimmed` | `builder.ts::buildFieldParts` | a sibling of `q`, named `nova_trimmed_<q>` | no type; `calculate` the tree `caseScalarTextValueCalculation(v)`, `v` the path of `q` or of its `datetime` sibling; `relevant` `count(q) > 0` | a case action names it as a name or an external id (part 07) | part 07: the action reads `q` |
| `owner` | `builder.ts::buildOwnerNodes` | the last child of its scope with no control, named `nova_owner_<operation id>` | `calculate` the tree `instance('commcaresession')/session/context/userid`, or the string `-`; nothing else | an advanced open action names it as its `owner_id` (part 07) | part 07: the operation's `owner` |
| `instant` | `datetimeCaseValue.ts`, called from `caseOps.ts` | a Hidden Value in an operation's `nova_operations` group, named `nova_instant_<operation id>_<n>`, with no control | no `type`; `calculate` the tree `typedInstantValue(leaf)` | the Save to Case row of its operation reads it as `if(N = '', '', storedInstantOfText(N))` (part 03, section 7.1) | part 07, section 5.2: the row takes `leaf` in the node's place, and the node becomes no field |
| `keyed`, `keyed-count`, `condition`, `guard` | `caseOps.ts::buildCaseOperations` | inside a case region (13.3) | | | part 07 |

**The scalar check on `q`.** A question with a recognized `trimmed` sibling carries, on its own
`constraint`, the check `caseScalarTextValueGuard(caseScalarTextValueCalculation(.), allow | reject)`,
alone or as the last operand of an `and` (`builder.ts::buildFieldParts`, `scalarCheck`). `logic.ts`
compares that operand with both trees. Where one matches, the `validate` registered is the source text
of the left operand (none where the check stands alone), and the draft field records which of the two
it was (`DraftField.scalarCheck`). The fold is made in stage 3, before part 07 has settled the
`trimmed` candidate, so part 07 holds it afterwards: its `settleCaseManagement` compares the record
with `caseScalarTextGuards` of the bound document and raises `unrecognized` where they differ (its
3.5). Where neither tree matches, the whole `constraint` is the author's.

**The count placement's row guard, query repeat and model iteration use the same comparison**: 10.3
names their trees.

### 13.3 Candidates, the case region, and who settles them

A node whose purpose is settled by `case-management` cannot be decided from the form alone: `url`,
`datetime`, `trimmed` and `owner` are Nova's only where a case action names them. The forms stage
gives such a node the role `generated-candidate` and mints nothing for it. Part 07's case
management stage (stage 5) settles each through `ReadXForm.settle(node, "generated" | "field")`:
named by an action in the shape the emitter writes, it is generated; otherwise it is the person's
own Hidden Value. Stage 5b, `xform/index.ts::mintFields`, then settles every candidate still open
as a field and mints the form's fields in document order (8.5), so expressions bind against the
final structure. A candidate nothing settles becomes a Hidden Value, which is the safe reading.

**The case region.** A data node is case scaffolding where every leaf under it lies in a
`vellum:role="SaveToCase"` element or is a keyed create's count node (a bind-only node typed `xsd:int`
whose `calculate` is the number `1`), or is an operation's clock node (a bind-only node with no type,
named `nova_instant_<operation id>_<n>`, whose `calculate` is `typedInstantValue` of a leaf; part 03,
section 7.1), and its body control, where it has one, is a `group` with no label and no appearance or
the `group` and `repeat` of a one-row repeat. Such nodes, their controls, binds and setvalues take
the role `case-region`, each with the `container` its name and shape tell (`generatedBaseName`:
`nova_operations`, `nova_condition_<id>`, `nova_keyed_<id>` and its count node,
`nova_guard_<id>_<kind>`, the selected-cases wrapper and row, `nova_subcases`, the clock nodes
`nova_instant_<operation id>_<n>` of `nova_operations`). The forms stage claims nothing in them and
lists them in `ReadXForm.caseRegion`. Every `vellum:role="SaveToCase"` element, inside the region or
under an authored group, is also a `ReadSaveToCaseBlock` in `ReadXForm.saveToCaseBlocks`, with its
path, its repeat, the binds and setvalues under it and its wrappers, which is what part 07's
`readSaveToCaseBlocks` takes (its section 5). The data path of every case region container and of
every Save to Case block is listed in
`ReadFormFacts.caseRegionPaths` (17.3), in document order, for part 09's check 5 (its 7.4). Part 07
reads every block, container, condition group, guard and keyed repeat, and what it does not claim
is `unrecognized`. A labelled group around a Save to Case block is an ordinary group field with a
case region inside it.

### 13.4 Collisions and edits

- **An author's question named like one of Nova's.** A node named `nova_trimmed_x` that has a control,
  or whose bind does not rebuild, is a field with that id. Nova reserves no name
  (`generatedNodes.ts`, "Nova reserves no question names"), and when Nova writes the form its own node
  takes the next suffix. `authoredNovaName.test.ts` holds a document with such a question to a clean
  fixed point.
- **A generated node a person changed in HQ's form builder.** The form builder shows Nova's nodes as
  Hidden Values, and a person can edit one. An edited node fails its comparison and reads as their
  Hidden Value with the calculate they wrote. Whatever named it then names a question: a case action
  that named `nova_trimmed_x` now reads that Hidden Value, and Nova writes its own trimmed sibling for
  it. The person's edit is kept and nothing is refused.
- **A name Nova would now spell or place otherwise.** A folded `nova_trimmed_x_1` whose sibling
  `nova_trimmed_x` is gone reads as the trimmed sibling of `x`, and Nova writes `nova_trimmed_x`. An
  HQ-authored form has no trimmed sibling at all, and Nova writes one. Each is a change to a generated
  node's path, with no change to what any question asks or stores. The forms stage records every
  generated node it folded (`ReadFormFacts.generated`, 17.3); part 09 re-reads Nova's emission for
  the fixed point with this same reader, and the difference of the two lists is exactly the nodes
  Nova adds, renames and drops. That difference feeds the first-publish register's entries drawn
  from `GeneratedNodePurpose` (part 09, 11.2 and 11.3). It is never a finding of this part.

---

## 14. Vellum's shadows and hashtag metadata

### 14.1 What a shadow is, and when it is read

HQ's form builder reads `vellum:<name>` in preference to `<name>` wherever it reads a path or an
expression, while every device reads `<name>` (`parser.js::parseVellumAttrs`:
`form.richText && vellumAttr ? vellumAttr : xmlAttr`). On its next save it writes the real attribute
from the shadow. So a shadow that means something else is a form that changes under the next person who
opens it.

`shadow.ts::SHADOWED_ATTRIBUTES`, from `surface.json`'s `vellum-markup:` family:

| Element | Real attribute and its shadow |
|---|---|
| `bind` | `nodeset`, `ref`, `relevant`, `calculate`, `constraint`, each with `vellum:<name>` |
| `setvalue` | `ref`, `value` |
| `input`, `secret`, `select`, `select1`, `trigger`, `upload`, `group` | `ref`; `input` also `nodeset` and `bind` |
| `repeat` | `nodeset`, `ref`; `jr:count` with `vellum:jr__count` |
| `itemset` | `nodeset` |
| `output` | `value` |

`vellum:role`, `vellum:case_type`, `vellum:comment`, `vellum:lock` and `vellum:ignore` are not shadows.
`vellum:requiredCondition` is 14.3.

### 14.2 The rule

`readHashtagMetadata` reads the head's `vellum:hashtags` (a JSON object from hashtag to a path or
`null`) and `vellum:hashtagTransforms` (a JSON object whose `prefixes` map a hashtag prefix to a path
prefix). Unreadable JSON is an empty map, as `parser.js::initHashtags` treats it.

For each shadow attribute, in the order `readForms` meets it:

| Condition | Result |
|---|---|
| the form's `vellum:ignore` holds `richText` | `drop(vellum-hashtag-shadow-attributes)`: HQ's form builder reads the real attribute |
| the real attribute is absent | `shadow-disagrees`, `detail.name` the attribute's name |
| the shadow does not parse | `shadow-disagrees` |
| the real attribute does not parse | `drop` the shadow: part 08's finding for the real attribute stands alone |
| a hashtag the head's map holds as `null` | it takes its meaning from the real attribute, below |
| any other hashtag of the shadow with no expansion | `shadow-disagrees` |
| the expanded shadow and the real attribute are one tree (`sameSyntax`, form rule set) | `drop(vellum-hashtag-shadow-attributes)` |
| otherwise | `shadow-disagrees` |

**A hashtag listed with no meaning.** The head's map holds a hashtag as `null` where HQ's form builder
knew the reference by name and wrote no path for it. Such a form is one the builder still reads:
`parser.js::initHashtags` sets `form.shouldInferHashtags` when any meaning is `null`, and
`parseVellumAttrs` then hands each shadow and its real attribute to
`form.js::inferHashtagMeanings`, which gives the hashtag a meaning where its guess prints the real
attribute. Calling such a pair a disagreement would send a person to fix a form HQ opens correctly.
The reader does not port the builder's guess (its `makeHashtagInferencer` tries four built-in
prefixes). It asks the question the finding exists to ask, whether the two spellings can mean one
thing: a `null` hashtag binds to the subtree that stands at its position in the real attribute's
tree, and every later occurrence of that hashtag in the form must meet an equal subtree
(`sameSyntax`). The first binding stands for the form, as `form.js::initHashtag` keeps a hashtag's
first meaning. A second, different subtree is `shadow-disagrees`. This can read as agreeing a pair
the builder's own guess would miss; that costs nothing, because Nova reads the real attribute, the
one a device runs, and writes both spellings itself at the first publish.

```ts
// lib/commcare/reader/xform/shadow.ts
/** The head's two maps as written; unreadable JSON reads as empty maps. */
export function readHashtagMetadata(head: Element, scope: NamespaceScope): HashtagMetadata;
/** A form's bindings of `null` hashtags so far, by hashtag: the subtree each first met. */
export type HashtagBindings = Map<string, FormSyntax>;
/** Whether the shadow, expanded, and the real attribute are one tree. `base` is the path a
 *  relative path is taken from. A `null` hashtag met for the first time is bound in `bindings`. */
export function shadowAgrees(
	real: string, shadow: string,
	metadata: { readonly head: HashtagMetadata; readonly bindings: HashtagBindings;
	            readonly root: string },
	base: readonly string[],
): "agrees" | "disagrees" | "shadow-unparseable" | "real-unparseable";
/** By element local name: each real attribute that has a shadow, with the shadow's name. */
export const SHADOWED_ATTRIBUTES: Readonly<Record<string, readonly {
	readonly real: string; readonly shadow: string;
}[]>>;
```

`shadowAgrees` does the comparison over `readFormSyntax`'s trees, with `metadata.bindings` carrying
the form's bindings of `null` hashtags so far and `metadata.root` the data root's name:

- A hashtag in the namespace `form` expands to the absolute path of its segments under the data root's
  name.
- Any other hashtag `#ns/a/b` expands to the tree of `metadata.head.hashtags["#ns/a/b"]` where that
  is a path; else to the tree of `metadata.head.transforms["#ns/a/"]` followed by the step `b`, the
  rule `parser.js::initHashtags`'s `transformHashtag` applies, which looks up exactly the prefix up to
  the last slash (`/(#.+\/)([^\/]+)/`) and never a longer or shorter one; else, where the map holds it as
  `null`, the rule above; else it has no expansion, and HQ's form builder would write the hashtag back as
  itself (`xpath.js::hashtagToXPath` returns its argument).
- A relative path on a `bind`, a control or a `setvalue` is made absolute from `base`, the data root
  for a bind and a setvalue, the enclosing control's node for a control (`parser.js::processPath`,
  `getPathFromControlElement`).
- One enclosing group around a whole expression is ignored on both sides.

This is the reader's one shadow comparison (part 08, its 10.1): a shadow is a fact of the form's
source and needs no bound tree, stage 3 has judged every shadow before stage 7 binds, a
`PendingExpression` holds no shadow (11.1), and the expression reader reads the real attribute and
writes no comparison of its own.

`shadow-disagrees` is part 01's circumstance (`fix-in-hq`), placed at the question, with the shadow
attribute claimed `drop` so it is not also `unrecognized`. Opening the form in HQ's form builder and
saving it makes the two agree, which is what its next step says.

Nova's own forms agree by construction: both spellings print from one wire tree
(`lib/commcare/CLAUDE.md`, "Vellum dual-attribute pattern"), and Nova writes no shadow where the form
builder could not read the tree back.

The head's two metadata elements are `dropSubtree(vellum-hashtags-vellum-hashtagtransforms)` after they
are read. They say what HQ's form builder knew when it last saved, and Nova writes neither (8.2).
A `vellum-plugin:caseManagement` mapping in the head is `dropSubtree(vellum-case-mappings-head)`.

### 14.3 `requiredCondition`

A bind's `vellum:requiredCondition`, or the bare `requiredCondition` Vellum also writes: where `required`
is absent, `drop(required-condition-without-required)`; where `required` is `false()` or the two expand
to one tree, `drop(vellum-requiredcondition-expr-vellum-requiredcondition-equal-to)`; otherwise
`refuse(requiredcondition-differing-from-a-present-non-false-required)`. `jr:requiredMsg` is
`account(jr-requiredmsg)`.

---

## 15. Connect blocks

`connect.ts::readConnectBlocks` reads the root's children that carry a Connect role, against the shapes
`builder.ts::buildConnectBlocks` writes. The Connect namespace is
`http://commcareconnect.com/data/v1/learn`.

| Role | Shape | Reads | Claim |
|---|---|---|---|
| `ConnectLearnModule` | `<ID><module xmlns id="ID"><name/><description/><time_estimate/></module></ID>`; one bind, on the wrapper | `connect.learn_module`: `id`, `name`, `description`, `time_estimate` as a whole number | `take(connect-learn-module)` |
| `ConnectAssessment` | `<ID><assessment xmlns id="ID"><user_score/></assessment></ID>`; a bind on the wrapper and one on `user_score` | `connect.assessment`: `id`; `user_score` registered under the form's `assessment_user_score` slot (11.1) | `take(connect-assessment)` |
| `ConnectDeliverUnit` | `<ID><deliver xmlns id="ID"><name/><entity_id/><entity_name/><work_area_id/></deliver></ID>`; binds on the wrapper and each leaf | `connect.deliver_unit`: `id`, `name`; `entity_id`, `entity_name` registered under the form's `deliver_entity_id` and `deliver_entity_name` slots | `take(connect-deliver-unit)` |
| `ConnectTask` | `<ID><task xmlns id="ID"><name/><description/></task></ID>`; one bind | `connect.task`: `id`, `name`, `description` | `take(connect-task)` |

Each block's subtree and binds are claimed under its entry. A block whose wrapper name differs from its
`id` is left unclaimed.

| The form holds | Result |
|---|---|
| a block with `ConnectWorkAreaUpdate` | `refuseSubtree(connect-work-area-update)` |
| a learn module or task id over 50 characters, or a deliver unit id over 100 | `refuse(a-connect-learn-module-or-task-id-longer-than-50-characters-or)` |
| several assessment blocks, or one inside a repeat | `refuse(several-connect-assessment-blocks-in-one-form-or-one-inside-a)` |
| a calculate on `work_area_id` | `refuse(connect-deliver-unit-work-area-id-expression)` |
| a block inside a group or a repeat; two blocks of one kind other than assessments; a `relevant` on a wrapper; a `time_estimate` that is 0 or no whole number; an `entity_id` or `entity_name` with no calculate; an assessment or deliver unit id of 51 to 100 characters where Nova's grammar stops at 50 | `refuse(connect-blocks-beyond-one-of-each-kind)` |
| an id `lib/domain/forms.ts::CONNECT_ID_PATTERN` refuses (part 04, section 10) | `refuse(question-id-failing-the-grammar-or-meta-in-any-case)` |
| a deliver unit and a task in one form | `refuse(connect-deliver-unit-and-task-in-one-form)`, new, raised with `Accounting.finding` at the form: each block is claimed under its own entry, and the finding is the pair |
| a learn module's or task's name or description, or a deliver unit's name, for which `instanceScanRead` answers | `refuse(connect-block-text-read-as-an-instance)`, raised with `Accounting.finding` at the form, `detail.name` the text it answered: the block is claimed under its own entry, and the finding is the text |

The last row's entry, like `form-name-read-as-an-instance` (7.4), is part 03's and exists with
its gate rule (its section 5.1), so the reader adds neither. Their subject `instance-text` holds a
whole sentence (part 01, section 9.2), so no copy is added here.

Connect blocks are read here and nowhere else. They are form content with no case action, and a
Connect id takes the question id rule (part 04, section 10), which is why an id the pattern refuses is
the question id entry's and not N15's. Two readers of one element would be a second claim on every
node of it, so part 07 (its 10.2) builds no Connect reader and claims no Connect entry. It reads
the result: `ReadXForm.connectBlocks` and the draft form's `connect`, for its own rows that turn on
`connectType`.

After every form is read, `connectType` is `"learn"` where some form holds a learn module or an
assessment, `"deliver"` where some form holds a deliver unit or a task, and `null` where none holds a
block. An app that holds both kinds is `refuse(connect-learn-and-deliver-blocks-in-one-app)` at the app,
new, raised with `Accounting.finding`: Nova's document holds one `connectType`, and the gate refuses a
block of the other kind (`CONNECT_MODE_MISMATCH`). The provisional document then takes the kind of
the first block in document order, so the forms still bind.

**Manifest edits.** Two entries in `entries/questions.json`, section "Question types", beside
`connect-task`, each with `surfaceKeys` `["mug:ConnectDeliverUnit", "mug:ConnectTask"]` for the first and
`["mug:ConnectLearnModule", "mug:ConnectDeliverUnit"]` for the second, `gates`
`["toggle/COMMCARE_CONNECT"]` (added to that gate's `contentEntries` after `questions/connect-task`),
`area` `questions` and `subject: "connect-blocks"`. The REFUSED one takes the refused arm's fixed
values, `platforms` `{ kind: "none", cell: "\u2014" }` and `emission` `{ cell: "\u2014", markers: [] }`.
The HELD-NEW one takes `platforms` and `emission` from `connect-task`
(`{ kind: "each", cell: "RUNS / RUNS", webApps: { reading: "runs" }, android: { reading: "runs" } }`
and `{ cell: "same", markers: [] }`):

| `id` | `valueClass` | Disposition | `item` | `dispositionCell` |
|---|---|---|---|---|
| `questions/connect-deliver-unit-and-task-in-one-form` | `deliver-unit-beside-task` | REFUSED, `reasons: [{ kind: "broken-at-runtime", named: "Connect checks a form's deliver units before its tasks (`form_receiver/processor.py::process_deliver_form`)" }]` | "a Connect Deliver Unit and a Connect Task in one form" | "**REFUSED**: broken at runtime: Connect processes the form's deliver units before its tasks (`commcare-connect` `form_receiver/processor.py::process_deliver_form`), and Nova's gate refuses the pair (`CONNECT_DELIVER_FORM_HOLDS_TASK`)" |
| `questions/connect-learn-and-deliver-blocks-in-one-app` | `learn-beside-deliver` | HELD-NEW, `owner: "xform"` | "Connect learn blocks and Connect deliver blocks in one app" | "**HELD-NEW**: an app that is both a learn app and a deliver app; Nova holds one `connectType`" |

`connect-blocks` holds a `not-yet` sentence and a `fix-in-hq` stem already (part 01, 2.2), so no copy is
added. The four held Connect entries hold a value class each, so every pair on a shared key is
disjoint.

---

## 16. Assembly, the declaration and the split

### 16.1 Assembly

Stage 11, `assemble.ts::assembleDocument`, runs once the stages before it have. It works on `ctx.doc`,
the provisional document stage 7 built and stages 8 to 10 patched (2.3), which exists in every
reading.

1. **The claims that waited for every form.** `auto_gps_capture` (6.1), which needs only whether any
   form held a Connect block.
2. **What the document decides, in every reading.** The declaration's verdict (16.3) over `ctx.doc`:
   its `none` arm makes its findings here, whether or not another finding stands. (11.4's bind-type
   comparison has already run, per form, in stage 10.)
3. **The document, where no finding stands yet.** There is then no stand-in and no placeholder
   left: every draft is whole and every expression held. It takes `ctx.doc` as the normalized
   `BlueprintDoc`: `appId` from the input, `appName`, `connectType` (15), `localization` with the
   translations of 12.5, `appSettings` as `lib/domain/blueprint.ts::NEW_APP_SETTINGS` gives them
   with `showSavedForms` and `showIncompleteForms` as read (a key the profile lacks reads as
   `NEW_APP_SETTINGS` holds it, which is what HQ's build writes for an absent key) and no
   `runsOnlyOn`, the organization's levels and the worker and location properties the draft holds
   (2.3), the entity maps keyed by UUID, and `moduleOrder`, `formOrder` and `fieldOrder` in HQ's
   order. It parses the whole with `lib/domain/blueprint.ts`'s document schema. A failure is a
   reader defect: `unrecognized` at the app, `detail.name` `schema:Application.modules`, and the
   defect D8 (5.1) with the first issue's top-level key and code. The issue's deeper path and its
   message are not in it: a path can hold a case type's name and a message can quote a value.
4. **The generated translation keys, in every reading** (16.5). Each is covered by a finding that
   stands at what it names, or classified against the strings Nova's build makes of the document:
   step 3's where there is one, `ctx.doc` otherwise. A fold in a reading that holds no finding
   rebuilds the document once, and the keys folded are counted in
   `ReadFacts.foldedTranslationKeys`.
5. **The close.** `Accounting.close()`. If a finding stands, the outcome is the account, with
   `unreadTables` and `readsLocations` from `ctx.facts` (2.2), and the provisional document is
   dropped.
6. **The draft.** `batch` is `lib/doc/diffDocsToMutations.ts::diffDocsToMutations` from
   `lib/doc/scaffolds.ts::emptyBlueprintDoc(appId)` to the document, the construction a birth applies
   (as `e2e/lib/smokeSeedFactory.ts` builds one today). Its last mutation is the one
   `holdPlacements` that function writes for held slots, carrying every query repeat's `placement`
   this part read and every `placement`, `Form.ownClosePlacement` and `Module.heldKind` part 07 read,
   which part 12's genesis records as holds (its 6.4, "held placements").
   `identities.entries` is `resolver.entries()`; `identities.modules` and `identities.forms` are the
   drafts' ids (part 10, 3.1), a folded hidden menu listed by part 07; `declaration` is 16.3's
   choices.

The gate, export readiness and the fixed point are part 09's (its sections 4 and 5), run by
`lib/deployment/reading/` over the draft. Not done: the reader running the gate itself.
`lib/commcare` already imports `lib/doc` (`xform/builder.ts`, `compiler.ts`, `expander.ts`), and
`lib/doc`'s commit verdicts import `lib/commcare` (`lib/doc/commitVerdicts.ts` imports
`@/lib/commcare/validator/gate`), so a reader that ran the gate itself would close a cycle.

### 16.2 The reader's canonical choices

Where two documents print one source, a reading can return only one of them. The list is closed and
lives in `assemble.ts::READER_CANONICAL_CHOICES` as rows of type `{ readonly id: string; readonly
kind: "one-wire" | "not-carried"; readonly apply: (doc: BlueprintDoc) => BlueprintDoc }`, `apply`
rewriting every instance of the pair to the member the reader returns; the table keeps its columns
(the two shapes, the one returned) as prose. It is what part 09's `canonDocument` wraps and proof 6
calls on a Nova-born document before it compares (part 09, section 9; part 14, 5.5; part 09's
`canon.test.ts` proves each pair prints equal bytes).

```ts
// lib/commcare/reader/assemble.ts
export interface ReaderCanonicalChoice {
	readonly id: string;
	/** `one-wire`: two documents print the same bytes. `not-carried`: content no export holds. */
	readonly kind: "one-wire" | "not-carried";
	readonly apply: (doc: BlueprintDoc) => BlueprintDoc;
}
export const READER_CANONICAL_CHOICES: readonly ReaderCanonicalChoice[];
```

| Id | Kind | The pair | The reader returns |
|---|---|---|---|
| `root-question-lists-are-sections` | `one-wire` | a root of sections, and a root of `fieldList` groups with no condition and no worker-added repeat | sections (10.2) |
| `translation-equal-to-source-is-absent` | `one-wire` | a translation equal to its source text, and none | none (12.5) |
| `plain-flag-on-blank-text-is-absent` | `one-wire` | `plainLabel` or `plainHelp` on a text blank in every language, and no flag | no flag (12.2; part 03's first) |
| `plain-flag-under-plain-text-is-absent` | `one-wire` | `plainLabel` or `plainHelp` in a form holding `plainText`, and no flag | no flag (12.2; part 03's second) |
| `blank-container-label-is-absent` | `one-wire` | a group, repeat or section whose `label` is a template with no parts, and one with no `label` | no `label` |
| `translation-provenance-is-read-as-reviewed` | `not-carried` | a current translation entry with any `origin`, `review` and `translatedFrom`, and the same `value` as a human-reviewed translation of the current source | `origin: "human"`, `review: "reviewed"`, `translatedFrom` the source language, the current source's fingerprint (12.5) |
| `out-of-date-translation-is-absent` | `one-wire` | a translation entry whose `sourceFingerprint` is not the current source's, and none | none: Nova writes the source text for it (`lib/domain/CLAUDE.md`, "Missing and out-of-date entries fall back to the canonical source"), so the wire holds no trace of it |

The last two are why a Nova-born document in several languages reads back to itself under part
09's `canonDocument`.
Provenance, review state and a stale entry never reach the wire: a Nova-born document holds
`origin: "ai"` or `"copied"`, `review: "needs-review"`, a `translatedFrom` that may name a language
since removed (`localization.ts::translationEntrySchema`) and entries waiting on review, and 12.5
writes every translation it reads as human and reviewed against the current source. Without the two
rows proof 6 would fail on every such document.

The first row names no label media: a group's label in a Nova document holds text alone
(`lib/domain/fields/base.ts::containerFieldBase`), so only the reading rule of 10.2, which judges
a source, has that condition.

Part 07 adds its own rows to the list and states each where it reads the pair (its "Tests", the
paragraph on the canonical choices). One of them, `unheld-placements-are-held`, covers the query
repeat placements this part reads too (16.1, step 6). Part 08 adds none: its `expression-print-collisions` is
`canonicalExpression`, which `canon.ts` wraps (part 09, section 9). `blank-translation-is-absent`
is not a row of this list: it is part 09's `canon.ts`'s own, though the forms stage reads a held
blank translation as absent from the start (12.2).

### 16.3 The declaration the content allows

A document is born declaring where it runs (`appSettings.runsOnlyOn`). The reader does not choose; it
returns every declaration the content runs on, with one proposed, and the birth applies the chosen
one's mutations (part 12). The proposed one is a preselected choice in the review, never a gate
before the app exists (part 12, 5.1; part 13, 8.3).

```ts
// lib/doc/platformDeclaration.ts
export interface DeclarationChoice {
	/** Undefined is Web Apps and Android. */
	readonly runsOnlyOn: Platform | undefined;
	/** Whether every date-and-time question is split (`datetimeSplit.ts`). */
	readonly split: boolean;
	/** `setAppSettings` where `runsOnlyOn` is defined, then each split's mutations. */
	readonly mutations: readonly Mutation[];
	readonly splits: readonly DatetimeSplit[];
}
export type DeclarationChoices =
	| { readonly kind: "choices"; readonly choices: readonly DeclarationChoice[];
	    /** Index of the proposed choice. */
	    readonly proposed: number;
	    /** True where HQ holds Web Apps off and the proposal is narrower than the content needs. */
	    readonly narrowedByHq: boolean;
	    /** True where HQ holds Web Apps on and the proposal splits date-and-time questions to keep it. */
	    readonly keepsWebApps: boolean }
	| { readonly kind: "none";
	    /** Every use some platform cannot run, with that platform. */
	    readonly blocking: readonly { readonly use: PlatformFeatureUse; readonly platform: Platform }[];
	    /** The question whose split is refused, where that is why no choice runs. */
	    readonly splitRefused?: Uuid };
export function planDeclarationChoices(
	doc: BlueprintDoc, options: { readonly webAppsOnInHq: boolean },
): DeclarationChoices;
```

The function, over a document that declares nothing:

1. **Candidates**, in this order: both platforms; Android only; Web Apps only; then, where the document
   holds a date-and-time question and `planDatetimeSplits(doc)` is `ok`, both platforms with the split,
   and Web Apps only with the split.
2. **A candidate runs** where `platformUses.ts::unavailableUses(candidate, platforms)` is empty, with
   `candidate` the document under the split's mutations (applied in a draft, as `declaredForContent`
   applies them) and `platforms` the ones it declares.
3. **The choices** are the candidates that run, less a split candidate whose unsplit twin runs, and less
   "Web Apps only with the split" where "both with the split" runs.
4. **The proposal.** Where `webAppsOnInHq` is false: "Android only" where it runs (`narrowedByHq` is
   true where "both platforms" also runs), else the first choice in the order of step 1. Where
   `webAppsOnInHq` is true: the first choice in that order that declares Web Apps, else the first
   choice. So an app whose only gap in Web Apps is its date-and-time questions, in a project space
   that serves Web Apps, is proposed "both platforms with the split" and not "Android only": the
   proposal never turns off a platform the project space serves while a choice keeps it.
   `keepsWebApps` is true exactly there, where the proposal is a split choice standing after an
   unsplit "Android only" in the order. The person still sees every choice and picks.
5. **No choice** gives `kind: "none"`, with the uses of `unavailableUses(doc, PLATFORMS)` each beside the
   platform that cannot run it, and `splitRefused` where `planDatetimeSplits` answered
   `self-read-through-a-filter`.

It keeps `planContentDeclaration` as it is, for the fuzz mapping that reads it. What it adds over that
function is the one case the outline missed: an app Android runs whole, which Web Apps could run too if
its date-and-time questions were split. The split is then a choice the review offers, never something
done unasked. Media is outside this function, as it is outside `planContentDeclaration`: part 11
judges the files the app references against the platforms the choices declare.

**In the reader.** `assembleDocument` calls it over `ctx.doc` with `webAppsOnInHq` from
`cloudcare_enabled`, in every reading (16.1, step 2). `none` makes one finding per blocking use, the
circumstance `no-platform-runs-everything` (part 01, 8.3 and 9.3), at the use's place, with
`detail.name` the feature's label in curly quotes and the platform
(`PLATFORM_FEATURES[feature].label` between `“` and `”`, then ", which Web Apps can't run" or ",
which Android can't run"; "Copy"); where `splitRefused` is set the finding at that question carries
`detail.reason: "split-refused"`, and part 01's `circumstanceBlock` then words its next step. Over
a provisional document the verdict is sound one way: every use it
finds is a use the source holds, so a finding it makes is true, and a use inside a menu or form that got
no draft is not seen (Departure 11). `choices` goes into the draft, which exists only where no finding
stands, so the choices a person is offered are always over the whole document.

The choices leave this part as the content allows them. One later narrowing is another part's: part
11's `narrowDeclarationsByMedia` (its 14.2) drops a choice that declares a platform a referenced
file does not play on, before acceptance (part 12's `gatherReading`). Part 09's check 2 then drops none:
it runs the gate and export readiness over the document under each remaining choice's mutations,
and one failing choice fails the reading (its section 4).

The outline's reason `unavailable-on-declared-platform` is not used for the `none` arm: nothing is
declared yet, and part 01 folds that reason into the cause a person reads as "breaks when the app
runs".

**What a publish then asks.** Where the chosen declaration differs from HQ's Web App setting, the first
publish asks before it changes the setting (`hq_web_apps_change`, unchanged). A Connect app's
`connect-app` use is unavailable in Web Apps, so its only choice is Android.

### 16.4 The split, read back

A date-and-time question Nova split is three fields on the wire: a date question, a time question, and
a Hidden Value bound `xsd:dateTime` whose calculate is `datePattern.ts::clockKeepingJoin` over the two.
The reader gives the shape no name. It reads the Hidden Value by 9.1 and 11.4 (its bind type is the one
`fieldBindType` gives a calculate `isClockKeepingDate` recognizes, once part 08 has bound it) and the two
questions as any date and time question. So a document that was split reads back as the three
questions it holds, and a re-read mints them by their paths.

Two things follow for other parts. A birth that applies a split adds two fields whose UUIDs come from
`datetimeSplitIdentity.ts::datetimeSplitFieldUuid`, not from the resolver, so part 09's fixed point over
the document the birth will write uses `matchingResolver` over `externalIdentityMap` of that document
(part 10, 2.5), as proof 6 does. And the split changes the form in CommCare HQ at the next publish,
which the review says where it offers the choice (part 13).

### 16.5 Generated translation keys

Part 01's 7.1 classifies a key of `translations` that matches one of HQ's generated patterns against
the app strings Nova's own build gives the document, and holds the three entries a key is claimed
under. The reader takes those strings as an input, so it stays pure and needs no target or media
manifest of its own:

```ts
// lib/commcare/reader/types.ts, a member of ReaderInput
/** The local app strings of a document, by language code, with each string's source; `null`
 *  where Nova's gate refuses the document. */
readonly appStrings: (doc: BlueprintDoc) => AppStringTable | null;

export interface AppStringTable {
	readonly languages: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** A string's source where it comes from a translation unit or several. */
	readonly units: Readonly<Record<string, WireStringSource>>;
}
```

The answer can be `null` because Nova's build is total only over a document the gate admits
("Executed during planning"), and the reader cannot ask the gate itself (16.1). The request that
calls the reader passes the production function: part 09's `readingAppStrings` (its section 15.1),
which puts Nova's gate in front of `localAppStringTable` and answers `null` for a document the gate
refuses. It is called only where a key is left to classify, which most apps never reach.

```ts
// lib/commcare/reader/generatedTranslationKeys.ts
/** What a generated key's id names. `menu` and `form` are positions, as the id spells them. */
export type GeneratedKeyOwner =
	| { readonly kind: "app" }
	| { readonly kind: "menu"; readonly menu: number }
	| { readonly kind: "form"; readonly menu: number; readonly form: number };
export function generatedKeyOwner(key: string): GeneratedKeyOwner;
/** The key with its menu's and its form's numbers replaced: the same string as a document spells
 *  it whose menus and forms stand at other positions. */
export function repositionGeneratedKey(
	key: string, to: { readonly menu: number; readonly form?: number },
): string;
export interface HeldGeneratedKey {
	readonly language: string;
	/** The key as `translations` holds it. */
	readonly key: string;
	/** The same string's id in the table (`repositionGeneratedKey`). */
	readonly id: string;
	readonly value: string;
}
export type GeneratedKeyVerdict =
	| { readonly kind: "inert" }
	| { readonly kind: "fold"; readonly unit: TranslationUnitId; readonly language: string;
	    readonly value: string }
	| { readonly kind: "not-yet" };
export function classifyGeneratedTranslationKeys(
	held: readonly HeldGeneratedKey[], table: AppStringTable,
): readonly GeneratedKeyVerdict[];
```

**What a key names.** `generatedKeyOwner` reads it from the generated pattern the key matches
(`appStringKeys.ts::GENERATED_APP_STRING_PATTERNS`): a pattern that holds `m#f#` names a form by
those two numbers, any other that holds `m#` names a menu by that number, and one that holds
neither names the app. Every pattern holds `m#` at most once and at one of two places, its start
or straight after its first `.`, so a key that matches two patterns reads the same under both.

One pattern holds neither and its keys still name a menu or a form: `custom_assertion.*.#`,
whose `*` is `m<n>`, `m<n>.f<n>` or `root` ("Executed during planning"). Its key is read as the
app's, and that is right. Nova's build writes no `custom_assertion` string, so no table has the
id at any position and the key is inert whichever menu it names (step 4): there is nothing to
reposition and nothing a menu's finding could withhold. An app that holds a custom assertion
stands under that assertion's own finding, at the app (`non-empty-custom-assertions-app`, 6.1),
the menu or the form (`custom-assertions-module-non-empty`, `custom-assertions-form-non-empty`;
the key is part 07's at both, 7.3 and 7.4), so a reading that gives a document holds no custom
assertion for the key to override.

**Every key is decided in the reading that meets it.** Stage 11 does this in every reading (16.1,
step 4), in order:

1. **A key stands under a finding where what it names did not read whole.** It is not classified
   and not reported again: `Accounting.cover` puts it under the finding named.

   | The key | The finding it stands under |
   |---|---|
   | is in a language the reading could not name (6.3) | that code's finding at the languages place |
   | names a menu, or a form, that got no draft (7.1, 7.2) | the finding at that menu or form |
   | names a menu, and a finding stands at that menu, its case list, its case detail or its search | the first such finding in `placeOrder` |
   | names a form, and a finding stands at that form | the first such finding in `placeOrder` |

   A finding at a question covers no key: no generated string comes from a question, whose text
   is itext in its form.
2. **The table.** Where a key is left, the frame asks `input.appStrings` for the strings of the
   document: the one of 16.1's step 3, or `ctx.doc` where a finding stands. In that document a
   menu or a form stands at its position among the ones that got a draft, so each key's `id` is
   `repositionGeneratedKey` to those positions; in a reading that left nothing out the two are
   equal. A key that names a position the app holds no menu or form at keeps its own spelling,
   which no string of the table has.
3. **No table.** `null` in a reading that holds a finding means the provisional document leans
   on something a finding withheld, so Nova's build cannot write it. No key is classified: each
   stands under the reading's first finding in `placeOrder`. `null` in a reading that holds no
   finding means the reader built a document Nova's gate refuses, which is the reader's own
   defect: `readHqApp` throws ("Copy", C9), and its caller answers `read-back-differs` as for any
   throw (2.2).
4. **The verdicts.** `classifyGeneratedTranslationKeys` is part 01's five rules, in its order,
   over ids: a blank value, an id no string of the table has, and a value equal to the table's
   string are inert; an id whose source is one translation unit, where every other id that unit
   feeds holds the same value in that language or is this one, folds; anything else, an id whose
   source is several units among it, is not-yet. `held` lists every generated key whose menu and
   form have drafts, the covered ones among them, because the fold rule reads the stored value of
   every id a unit feeds; a verdict is applied only to a key step 1 did not cover.
   `assembleDocument` claims each such key with
   `account(translations-generated-key-with-no-effect)`,
   `take(translations-generated-key-over-one-text)` (writing the value as the unit's text in that
   language through the translation sink, once per unit) or
   `refuse(translations-generated-key-anything-else)` with the key in `detail.name`.

Over a provisional document the verdicts are sound one way, as 16.3's are. A `not-yet` it raises
is true of the source: the key's menu or form read whole, so its strings and their sources are
the ones the finished document holds. What it can miss is one case. One kind of unit feeds
strings of several menus, a case property's option label, which every list that shows the
property spells as its own string ("Executed during planning"). Where one of those menus got no
draft, or holds the finding that covered its keys, the fold rule runs without that menu's string,
and two overrides that differ between the menus read as a fold now and as not-yet once the other
menu reads. Departure 11 states this with the reading's other limit, and part 01's account line
says a later check may find more (its 9.1). No key is ever reported as `unrecognized`, which
would blame Nova for a key it reads perfectly well, and none is left unclaimed for a later
reading to meet.

---

## 17. What the reader hands on

### 17.1 The case management, menu, list and search stages

Part 07's ten functions are stages 4, 5, 6 and 8 (2.3). Everything they read of this part is
stated where it is defined: the frame and its names for part 07's shorthand (2.3), the keys left
unclaimed for them (7.3, 7.4, 6.6), a form's parsed source with its roles, case region, Save to
Case blocks and Connect blocks (8.6), the candidates they settle (13.3), the scalar check they
hold (13.2), the root nodes they claim (8.3), `case_references_data.save` (8.7), the load-time
values they judge (11.3), and the translation sink and `readMediaMap` (12.5, 12.4). They set
`Form.type`, `caseOperations`, `postSubmit`, the links and every menu slot before stage 7, each
write inside `ctx.writeDraft`, with `pendingPlaceholder` in a required expression slot. After
stage 7 they read `ctx.doc` and patch it by assigning a new frozen document (2.3).

### 17.2 The expression stage

- **The registrations.** `ctx.pending.list()`: every `PendingExpression` of 11.1, in registration
  order, each under a slot the provisional document holds. Stage 7 runs part 08's
  `readExpressions(doc, pending, env)` twice and applies what the second run answers (2.3).
- **`env`**, from `xform/index.ts::expressionEnvOf(ctx: ReadContext): ExpressionReadEnv`. It
  builds the members part 08's `ExpressionReadEnv` names (its 2.5), the per-form ones from each
  `ReadXForm`, keyed by the form's UUID:

  | `env` member | Built from |
  |---|---|
  | `lookup` | `input.lookup.definitions` |
  | `sourceNames` | `ReadXForm.sourceNames`, below |
  | `itextUnits` | `ItextTable.owners`: each source text id a control references, to the unit of its first owning slot in document order (`itextIds.ts`'s unit for that field, slot and option) |
  | `instanceSources` | `ReadXForm.instanceSources` |
  | `generatedValues` | each node folded as a `constraint-count` (13.2), by absolute path, with its `calculate` text |
  | `operationIdPaths` | each `DraftForm.operationIdPaths`, which part 07's `readCaseManagement` set (its 5.2), keyed by the form's UUID |
  | `recordDialect` | `input.recordDialect` |
  | `entryFactsRefused` | `ctx.facts.entryFactsRefused`, as a set: the forms part 07's `compareEntryFacts` found differing (stage 6) |

- **The source's own names.** `ReadXForm.sourceNames`:

  ```ts
  // lib/commcare/reader/xform/index.ts
  export interface ReadSourceNames {
  	/** The data root's element name. */
  	readonly root: string;
  	/** Each field's path in the source, from the root. */
  	fieldPath(uuid: Uuid): readonly string[] | undefined;
  	/** What a source path names, or undefined where the form holds nothing there. */
  	at(path: readonly string[]): SourceNodeRef | undefined;
  }
  export type SourceNodeRef =
  	| { readonly kind: "field"; readonly uuid: Uuid }
  	| { readonly kind: "query-row"; readonly repeat: Uuid }
  	| { readonly kind: "repeat-attribute"; readonly repeat: Uuid;
  	    readonly attribute: "ids" | "count" | "current_index" | "id" | "index" }
  	| { readonly kind: "generated"; readonly purpose: GeneratedNodePurpose; readonly owner: Uuid };
  ```

  Part 08 (its 3.3) builds `FormParseScope.sourceProjection` from it. The names Nova's own export
  would write (`formNodeProjection(doc, form, { surface: "wire" })`) are wrong for a source whose
  generated node carries a suffix Nova would not give it today (13.4: a folded `nova_trimmed_x_1`
  whose sibling is gone) or whose root is not `data`. `ReadSourceNames` is the same projection under
  the names the source holds, so a path of the source binds to the node it names, and a read of a
  folded generated node (a `nova_query_ids_r`, a `nova_constraint_q_1`) binds to the authoring
  spelling or to the expression it stood for.
- **A prose slot's value parts**: one registration per `value` part of a slot, in part order.
  `readExpressions` writes the tree of the i-th registration under a `ProseSlotRef` into that slot's
  i-th `value` part.
- **The comparisons that wait for bound trees** are this part's code over `ctx.doc`, in stage 10: the
  protected message's expression (13.2), the case choices itemset (10.1), the count and
  model-iteration verdicts (10.3, 10.4), the load order (11.3) and the Hidden Value bind types (11.4).

### 17.3 Acceptance and the first-publish register

```ts
// lib/commcare/reader/types.ts
export interface ReadFacts {
	/** HQ's `cloudcare_enabled`. */
	readonly webAppsOnInHq: boolean;
	/** Every media reference whose path resolved to an asset. */
	readonly mediaReferences: readonly ReadMediaReference[];
	/** Every media reference handed off: no file for its path (12.4). */
	readonly pendingMedia: readonly PendingMedia[];
	/** Every itemset over a table the catalog does not hold, handed off (10.1), and each tag an
	 *  expression reads that the catalog lacks, at the place `{ kind: "lookup-table", tag }`. */
	readonly unreadTables: readonly UnreadTable[];
	/** The generated translation keys `assembleDocument` folded (16.5). */
	readonly foldedTranslationKeys: number;
	readonly forms: readonly ReadFormFacts[];

	// Part 07's (its 2.2, 13.3 and 6.3).
	/** Each same-state rule applied: the entry, a JSON Pointer, and the id of the row of part 09's
	 *  `FIRST_PUBLISH_CHANGES` the rule falls under. */
	readonly sameStateRewrites: readonly {
		readonly entry: string; readonly path: string; readonly register: string;
	}[];
	/** The forms `compareEntryFacts` found differing. */
	readonly entryFactsRefused: readonly Uuid[];

	// `bindExpressions` fills these from the run it applies (2.3).
	/** Part 08's report, passed through: the rewrites it applied. */
	readonly rewrites: ExpressionReading["rewrites"];
	/** `ExpressionReading.rounds`, for the reading's log. */
	readonly expressionRounds: number;
}
export interface UnreadTable {
	readonly tag: string;
	readonly place: HqPlace;
}
export interface ReadFormFacts {
	readonly xmlns: string;
	/** Every generated node folded, by purpose, owner, path and the name the source gave it. */
	readonly generated: readonly ReadGeneratedNode[];
	/** The data path of every control, leaf or container, whose `appearance` was accounted under
	 *  an entry of standing `inert` (9.2), in body order. */
	readonly inertAppearances: readonly string[];
	/** The data path of every case region container and every Save to Case block (13.3). */
	readonly caseRegionPaths: readonly string[];
	/** The itext values blank in a language other than the first whose first-language text is not
	 *  blank, each read as no translation (12.2). */
	readonly blankTranslations: number;
}
export interface ReadGeneratedNode {
	readonly purpose: GeneratedNodePurpose;
	/** One key by one rule. For a question's node, the owner question's data path. For an
	 *  operation's node, the data path of the `nova_operations` scope it stands in, a `#`, and the
	 *  operation's id. */
	readonly owner: string;
	/** The node's absolute data path. */
	readonly path: string;
	readonly name: string;
}
```

`ReadGeneratedNode.owner`'s rule is held to the emitter's plan by part 09's
`generatedNodes.parity.test.ts`. Every member of `ReadFacts` and `ReadFormFacts` has a reader.
Part 09 compares `forms[i].generated` of the reading with `emittedGeneratedNodes` of the document
under each declaration choice, through `generatedDifference`, for the register's generated-node
entries (its sections 11.1 and 12.1; 13.4 here), cuts the paths of `inertAppearances` from
CommCare HQ's side in its check 4 (its 6.3), reads `caseRegionPaths` in its check 5 (its 7.4), and
reads `foldedTranslationKeys`, `blankTranslations`, `rewrites` and `sameStateRewrites` for the
register entries that name them, `translation-overrides-folded` and `blank-translations-filled`
among them (its 11.2). Part 11 reads the two media lists and
`unreadTables` (17.4), part 08 `entryFactsRefused` (17.2), and part 12 `webAppsOnInHq` for the
review and `expressionRounds` for its log. A fact no part reads is not kept, so the form's itext
ids, a count of dropped markdown copies, the form's load order and a machine reason beside a
finding are in neither type. `ReadFormFacts` holds no bind type: part 09's check 4 reads each bind
from the form's XML itself, through a module that imports no reader module, so a mistake of the
reader's cannot agree with itself (its 6.1 and Departure 6).

Acceptance re-reads Nova's emission by calling `readHqApp` again with a fresh resolver (part 09,
its 5.2), which is why the function is pure. Its check 1 holds every `HandOffRecord` of
`ReadOutcome.claims.handOffs` settled by exactly one finding or one inert claim of part 11's
(4.3), and one left over is `unrecognized` at its place.

### 17.4 The request: project data

The reader takes the lookup catalog and the media index as inputs, so the request reads the tables
before it calls the reader. It does so without the reader: part 11's
`candidateLookupTags(sourceText, tables)` and `sourceMayReadPlaces(sourceText)` (its 5.1 and 11.1)
test the source's text for the names HQ gave, inside its `readReadingProjectData` (its 14.1), which
part 12's `gatherReading` calls before the reader. This part plans no scan of its own. The levels
reach the reader as `input.organization` (2.2), and the structure stage puts them on the draft
(2.3). Part 11 builds the reader's three inputs from what the request gathered: the catalog
(`readerLookupCatalog`, its 5.5), the organization (its 14.1) and the media index
(`readingMediaIndex`, its 14.2).

What the reader gives back, for part 11's rules to judge in the same request:

- `facts.mediaReferences` and `facts.pendingMedia` (12.4), which part 11's `hqMediaReferencesOf`
  turns into its `HqMediaReference` list for `planHqMedia`;
- `facts.unreadTables` (10.1), which with the table ids the document holds
  (`lib/doc/lookupReferences.ts::extractLookupReferenceTargets`) is what part 11's
  `projectDataReadsOf` reads (its 14.1); in an account, where there is no draft, the same list and
  `readsLocations` on the outcome itself (2.2);
- the claim log's `handOffs` (4.5), one per node behind the media list and the itemset tags, which
  acceptance holds settled. A tag the expression stage appends has no hand-off: its expression's
  node is claimed by part 08 under its own entry.

A table the catalog holds is bound by the reader itself, through `input.lookup.table(tag)` and
`column(fieldName)`. The media index is built for one request and stored nowhere. It answers a
path the map holds with the provisional id part 12 derives for that file
(`mediaIds.ts::provisionalReadingMediaId`) before any byte of a file is fetched, so the document
is the same before the files are judged and after. Where a file then proves missing, the request
runs the reader once more with that path answered `unreadable` (part 12's `gatherReading`).

---

## 18. The circumstances this part raises

A manifest finding is a `refuse`, or an `account` whose entry is not kept or inert, and each is
stated in the section that reads its key (6 to 15); it takes its standing, cause and subject from
the entry. The circumstances are these:

| Code | Where | When |
|---|---|---|
| `unrecognized` | any place | 4.4: a use nothing claimed, and each of the reader's own defects (5.1), every one with a surface key or the app's own value in `detail.name` (4.4), a defect with its `ReaderDefect` beside it |
| `shadow-disagrees` | a question | 14.2 |
| `no-platform-runs-everything` | each use | 16.3; part 01 holds its row and its block (its 8.3 and 9.3) |

It raises no `stop`: every `stop` is the HQ read's (part 05) or the reading's (part 12). It never raises
`read-back-differs`, which is part 09's for acceptance checks 3 to 5.

---

## Copy

Every string this part adds that a person, a developer or a model reads.

**For a person.** Every manifest finding of this part is worded by its subject and standing, and
every sentence is part 01's (its 9.2). Four pairs of that table are there because of this part's
entries: `language-codes`, `form-source` and `question-ids` at `not-yet` (6.3, 8.8), and `repeats`
at `not-yet`, whose sentence holds of a repeat's button captions and of 10.4's model iteration
entry alike. This part writes none of them.

**The circumstance this part raises** (`no-platform-runs-everything`). Its row and its block are
part 01's (its 8.3 and 9.3), and its `circumstanceBlock` fills them (its 8.4), choosing the second
next step where `detail.reason` is `split-refused`. What this part writes is the finding's name,
which the block's body opens with:

| When | `detail.name` |
|---|---|
| Web Apps cannot run the use | `“<feature label>”, which Web Apps can't run` |
| Android cannot run the use | `“<feature label>”, which Android can't run` |

`<feature label>` is `lib/domain/platforms.ts::PLATFORM_FEATURES[feature].label` ("Date and time
questions", "Forms that read the search"). The labels are headings, so the name sets one in curly
quotes, as Nova quotes a name inside a sentence (`lib/deployment/preflight.ts`: "can't reach the
project space “{domain}”").

**The account's line.** Part 01's `ACCOUNT_CHECK_AGAIN_LINE` (its 9.1) is shown under the groups of
every account (part 13, 7.1). Departure 11 is why it exists.

**For a developer.**

| # | Where | String |
|---|---|---|
| C3 | `readHqApp`, a broken input | "The reader was given <n> aligned menus for a source that holds <m>. Pass the menus of the same reading the source came from." |
| C4 | `claimsBindManifest.test.ts`, an entry that is gone | "The claim <module.name> names the entry <entry>, which no area file of lib/commcare/surface/entries holds. Check the id's spelling, or point the claim at the entry that took its place." |
| C5 | the same, a use the standing forbids | "The claim <module.name> would <use> a value under <entry>, and that entry is now <standing>. Change the claim to a use its standing permits (take or derived: held; drop: inert or kept; refuse: not-yet, never or fix-in-hq; account: any but held), or put the entry back." |
| C6 | the same, a key the entry lacks | "The claim <module.name> reads the surface key <key>, which <entry> does not list. Name one of the entry's surfaceKeys, or add the key to the entry." |
| C7 | `appearanceRows.test.ts` | "The appearance entry <entry> is named by no rule of lib/commcare/reader/xform/appearances.ts. Give it a row of APPEARANCE_ROWS, or the refused-class port that reads it." |
| C8 | `inventoryIndex()`, a file that fails the schema | Zod's own issue, prefixed "lib/commcare/surface/entries/<area>.json does not match the manifest schema: " |
| C9 | `readHqApp`, a document read with no finding that Nova's gate refuses (16.5) | "The reader read this app with no finding and built a document Nova's gate refuses, so the app's strings could not be built. A reading with no finding should be a document the gate admits. Run the gate over the reading's document to see which rule refuses it, then look at the reader stage that set that slot." |

**In an account, from the reader itself** (`detail.name` of an `unrecognized` finding, shown after part
01's sentence as "In CommCare HQ: <name>"). It is a surface key in the lane's vocabulary, or the
app's own value where what Nova met is a value: the name of what Nova met in the app, and never a
sentence about the reader:

| When | `detail.name` |
|---|---|
| an unclaimed JSON key, or one the reader mishandled | `schema:<Class>.<key>`, or `<Class>.<key>` for an undeclared key |
| an unclaimed element or attribute, or one the reader mishandled | `xform:<name>`, `xform:<element>@<attribute>` |
| an appearance a runtime reads that no row names (9.2) | the appearance string as written |
| a source Nova's parser refuses | `xform:h:html` |
| an `xmlns` that differs | `schema:Form.xmlns` |
| a document that does not assemble | `schema:Application.modules` |

**For a developer, in the log** (`ReaderDefect.why`, which part 12 logs at error beside the finding and
never stores or shows; 5.1). Each is the exact template its constructor of `readerDefect` fills, and
every slot is one of 5.1's closed slots, so no line holds a word of an app:

| # | Defect | Code and constructor | `why` |
|---|---|---|---|
| D1 | a second claim | `claimed-twice`, `claimedTwice` | "claimed twice at <place>: first by <claim>, then by <claim>" |
| D2 | a use the manifest no longer permits | `claim-not-permitted`, `claimNotPermitted` | "claim <claim> at <place> is not permitted by <entry>, which is now <standing>", `<entry>` the claim's own |
| D3 | a held value nothing read | `claimed-not-read`, `claimedNotRead` | "claimed and not read at <place>: <claim>" |
| D4 | an identity key met twice | `identity-met-twice`, `identityMetTwice` | "identity met twice at <place>: a <kind> key" |
| D5 | a source Nova's parser refuses | `form-source`, `formSource` | "form source at <place>: Nova's parser answered <kind>" |
| D6 | an `xmlns` that differs | `xmlns-differs`, `xmlnsDiffers` | "xmlns differs between the form and its source at <place>" |
| D7 | an itemset column the catalog lacks | `itemset-column`, `itemsetColumn` | "itemset column at <place>: the <ref> ref names a column the catalog lacks" |
| D8 | a document that does not assemble | `assembly`, `assembly` | "assembly at <place>: <top-level key>: <issue code>" |
| D9 | an entry id `claimEntry` was handed that no claim registers | `unregistered-expression-claim`, `unregisteredExpressionClaim` | "expression claim at <place> names <entry>, which no registered claim holds" |
| D10 | a translation Nova's own rule refuses after the pairing passed it (12.5) | `translation`, `translation` | "translation at <place>: <role>, language <n>: <issue>" |
| D11 | an expression Nova could not write back (2.3) | `expression-not-written-back`, `expressionNotWrittenBack` | part 08's log line C9, as its "Copy" words it, its `{place}` filled by `placeKey` and its `{reason}` by the row's `detail.reason` |
| D12 | the same, where `detail.reason` is `no-case-datum` | `no-case-datum`, `noCaseDatum` | part 08's log line C12, as its "Copy" words it, its `{place}` filled by `placeKey` |

The reading's id is in no line: part 12's log line carries it as the `appId` tag.

No string of this part reaches a model: it adds no tool, no tool description and no guide text.

---

## Tests

Vitest, in ordinary CI, at the reader's own boundary: inputs are retained HQ reads
(`proof/hq-reads/`, HQ's own answers held byte for byte by the lane) and sources the production emitter
or a person's hand built; outputs are what `readHqApp` and its stages return. No test runs HQ, no test
touches a database, and none renders a component. Each names the failure it would catch.

| Test | Boundary | Catches |
|---|---|---|
| `lib/commcare/surface/__tests__/inventory.test.ts` | `inventoryIndex()` against `loadManifest()` | an entry the index drops; a standing that differs from `standingOf` |
| `reader/__tests__/syntaxCompare.test.ts` | the form-row cases this part's recognizer rests on, in the test file part 08 owns: `sameXPathText` over pairs for rows L1 to L6 of part 08's 3.2, and pairs that differ in an operator, a name, a string or the order of operands | two texts of one tree read as different; two trees read as one |
| `reader/__tests__/provisional.test.ts` | `provisionalDocument` over drafts holding a refused question that another question's `relevant` reads, a mirror menu, and a form with a refused control; two calls with no draft write between, and two with one; every stage function of `STAGES` run over drafts a test proxy watches; `bindExpressions` with a hand-written `ExpressionReading` | a provisional document the schema refuses; a stand-in in a returned document; a document that is not frozen, or a new object where no draft changed, or the same object after one did; a draft written outside `ctx.writeDraft` |
| `reader/__tests__/onePass.test.ts` | `readHqApp` over one source that holds a mirror menu, a refused appearance, a default order a save changes and an expression the checker refuses | any of the findings missing from the one account, which is the test of one pass (Decision 1) |
| `reader/__tests__/defects.test.ts` | each of the twelve defects provoked, D1 to D4, D8 and D9 through a test claim table. And the closure, one case over every constructor of `readerDefect`: called with a place whose every name, path and tag is a marker string, with each member of each closed argument, with a claim name the registry lacks, an entry id the index lacks and an issue whose path and message hold the marker, it returns exactly its row's template of "Copy" with the closed slots filled | a defect's sentence in `detail.name`, where a person would read it; a defect with no finding; a `why` that holds a marker, which is a word of an app in the log; a `why` built outside a constructor; an unknown claim or entry printed as given |
| `lib/commcare/reader/__tests__/claimsBindManifest.test.ts` | every registered claim against the index | a claim under a renamed or flipped entry (C4 to C6); it is the test a manifest edit trips |
| `reader/__tests__/accounting.test.ts` | `Accounting` over hand-built objects and documents | a used key that passes unclaimed; a default-valued key counted as a use; a held value dropped after `take`; a second claim; `refuseWhole` leaking a nested `unrecognized`; a handed-off node reported as `unrecognized` or missing from `handOffs`; `finding` accepted under a held entry; a list of strings claimed per element; a second `claimEntry` on one node refused under another key, or accepted under the same key; a node `cover` marked reported again at the close; an absent declared key counted as a use |
| `reader/__tests__/placeVectors.test.ts`, with `proof/checks/test_place_vectors.py` | `elementWhere`, `qualifiedName` and the pointer escape against `proof/checks/fixtures/place-vectors.json`, which the Python test holds to `_element_path`, `qualified`, `pointer_token` and, for one vector that is a default `xmlns`, the `/namespace()` place `xform_vocabulary` records | the two sides spelling one place two ways, which would make part 14's parity join miss |
| `reader/__tests__/appShell.test.ts` | `readApplication` over `proof/hq-reads/shell/app-source.json`, `shell/app-source-after-app-settings-save.json`, `hq-built/app-source.json`, `navigation-base/app-source-after-ui-translations-save.json` | an `Application` key HQ's own pages write that the walker leaves unclaimed; a setting accounted under the wrong value class; and, over hand-built sources, a logo entry with no `m_id` admitted, and a language's display name that differs from Nova's label raised as a finding where the manifest keeps it |
| `reader/__tests__/appShellTotality.test.ts` | the same sources with one unknown key planted at the root, in `profile.properties` and in `translations` | an unknown key admitted; the wrong undeclared entry |
| `reader/__tests__/languages.test.ts` | `readLanguages` over a table of code lists | `en` beside `eng` held twice; a macrolanguage code minted to no identity; a code HQ's grammar refuses held; `pt-br`, `zh-hans` and `cmn-hantcn` read without their region or script, since the suffix is lower case |
| `reader/__tests__/structure.test.ts` | `readStructure` over hand-built menus and forms | a mirror menu read key by key into dozens of findings; two forms of one `xmlns` both minted; with a report menu and a shadow form in one app, that both findings are in one account; and a form named `instance('casedb') practice` read to anything but the one finding `form-name-read-as-an-instance` |
| `reader/__tests__/generatedTranslationKeys.test.ts` | the classifier over hand-built tables, one case per rule of part 01's 7.1 and the two-key fold; `generatedKeyOwner` and `repositionGeneratedKey` over a key for every pattern of `GENERATED_APP_STRING_PATTERNS`; the keys `custom_assertion.m0.f1.3`, `custom_assertion.m0.3` and `custom_assertion.root.3`, each read as the app's and classified inert against a table built for a document with two menus | an override of a constant string called inert; one fold applied twice; a pattern whose key names no owner or the wrong one; a key repositioned at any number but its menu's and form's; a `custom_assertion` key read as a menu's or a form's, or given any verdict but inert (16.5) |
| `reader/__tests__/generatedKeysInAccount.test.ts` | `readHqApp` over hand-built sources, with `appStrings` a hand-built function: a mirror menu standing before a plain menu whose name holds an override; a key on a menu whose case list holds a finding; a key under a language code the reading cannot name; `appStrings` answering `null` beside a finding, and with none; an option label's override in two menus, one of them a mirror | a key whose menu read whole left out of an account that holds another menu's finding; a key judged against the string of the menu that now stands at its number; a covered key reported, as a finding or as `unrecognized`; a key left unclaimed where there is no table; a clean read whose document the gate refuses returned and not thrown (C9); a `not-yet` raised for a key the source does not make one |
| `reader/__tests__/assemble.test.ts` | `assembleDocument` over complete drafts built through the stages' own setters | a document the schema refuses; a `batch` that does not rebuild the document (`applyMutations(emptyBlueprintDoc(appId), batch)` must equal `doc`); a generated translation key reported as `unrecognized`; a fold that does not reach the returned document, or is counted twice; a `batch` whose held placements are not its one trailing `holdPlacements`; a document of content no platform runs whole returned without `no-platform-runs-everything`, alone and beside another finding |
| `reader/__tests__/readerPurity.test.ts` | `readHqApp` twice over one input with fresh resolvers | hidden state; an order that depends on a `Map`'s insertion history |
| `lib/doc/__tests__/declarationChoices.test.ts` | `planDeclarationChoices` over production documents: plain; date-and-time questions alone; a date-and-time question beside a feature Android cannot run; uses neither platform runs; a refused split; each with HQ's setting on and off. And over the fuzz documents: every choice's mutations leave no unavailable use, and `planContentDeclaration`'s declaration is among the choices | a choice the gate would refuse; the split offered where it adds nothing; the proposal ignoring HQ's setting; "Android only" proposed, with Web Apps on in HQ, for an app the split would keep in Web Apps |
| `lib/commcare/hq/__tests__/publishedCaseBlocks.test.ts` | unchanged | the helpers' move changing what it reads |
| `reader/xform/__tests__/formFixedPoint.fuzz.test.ts` | for each form of the fuzz documents (`lib/commcare/__tests__/xformDocArbitrary.ts::blueprintDocArbitrary`), `buildXFormSource` then stages 3 and 5b; the reading's fields compared with the document's: path, kind, order, repeat mode and placement, `fieldList`, section, `keypad`, plain flags, choices and their values, media, and each text in each language | a slot the emitter writes and the reader does not read; a generated node read as a field; a kind row that is wrong; a canonical choice applied where the pair differs |
| `reader/xform/__tests__/kinds.test.ts` | each row of `FIELD_KIND_ROWS` as a minimal hand-written source; and every `FieldKind` emitted alone and read back | a row unreachable or shadowed by an earlier one; a kind Nova gains with no row; a question named `registration` refused under the grammar entry, or held |
| `reader/xform/__tests__/appearances.test.ts`, `appearanceRows.test.ts` | `classifyAppearance` over the examples each entry's `item` gives (`minimal` with a trailing space, `combobox2`, `x2-per-row`, `minimal foo`, `Numeric`, `compact-3`) and the four held tokens; the table against the manifest's section | an inert claim for a string a runtime reads; an entry no rule reaches (C7); a row whose entry is HELD; one of the five refused classes with no lane reader misread, which nothing in Python would catch; a control missing from `inertAppearances`, or one listed whose appearance made a finding |
| `reader/xform/__tests__/itext.test.ts` | hand-built itext: renamed ids, one id shared by two questions, each form of 12.2, each pragma row, a value blank in a second language beside first-language text, a value blank in the first language beside another's text, a text blank in every language, a missing language, media equal and differing | a text found by its id's spelling; a `markdown` copy on a hint refused; a flag set on a blank text; a held blank refused, written as a translation or left out of `blankTranslations`; a first-language blank held |
| `reader/xform/__tests__/prose.test.ts` | text of every character class (whitespace runs, NBSP, `instance(`, `<`, `&`, quotes) emitted through a one-label document and read back, property-based | the literal-output inverse losing or adding a character |
| `reader/xform/__tests__/generated.test.ts` | for each purpose of `GENERATED_RULES`, a document that makes the emitter write the node, read back; then the same source with one token of the node's calculate changed, and with the node renamed | a purpose with no rule; an edited node folded; a renamed node folded |
| `reader/xform/__tests__/authoredNovaName.test.ts` | a document whose author named a question `nova_trimmed_x` beside a question `x` that names a case | the author's question folded into Nova's node |
| `reader/xform/__tests__/shadow.test.ts` | pairs of real and shadow text with head metadata: agreeing through `#form/`, through a `hashtags` entry, through a prefix; disagreeing; unexpandable; under `vellum:ignore="richText"`; a hashtag the map holds as `null`, used twice over one subtree and twice over two; a prefix that is a longer key's beginning; the three `requiredCondition` rows | a disagreement read as agreement; an inert shadow refused; a form HQ's form builder reads through a `null` hashtag sent back to be fixed; the longest key taken where Vellum takes the exact prefix |
| `reader/xform/__tests__/repeats.test.ts` | each row of 10.3 by hand, and both placements emitted and read | a count repeat over a Hidden Value read as a generated count; a wrapper missing a setvalue held |
| `reader/xform/__tests__/loadOrder.test.ts` | `effectiveLoadOrder` and `loadOrderConflicts` with reads given by hand | a reordered dependent pair missed; an independent reordering refused |
| `reader/xform/__tests__/connect.test.ts` | the four blocks emitted and read; each refusal row by hand; learn and deliver blocks in two forms of one app | a deliver unit beside a task held; an app of both kinds read as `unrecognized`; a learn module whose description holds `instance('casedb')` read to anything but the one finding `connect-block-text-read-as-an-instance` |
| `reader/xform/__tests__/retainedForms.test.ts` | `readHqApp`, every stage, over `hq-built/app-source.json`, `navigation-base/app-source.json`, `case-list-inline/app-source.json` and each `navigation-base/app-source-after-*-save.json`, with an empty catalog and a media index that answers every path as an asset | an element or attribute HQ's own pages or builder write that no stage claims: any `unrecognized` at a form or a question of those sources |
| `reader/xform/__tests__/xmlTotality.test.ts` | each retained form with one unknown attribute planted on one element of each qualified name, and one unknown element under each | an unknown construct admitted in a form |
| `reader/xform/__tests__/vellumSavedSource.test.ts` | R1's two cases ("Written and not yet run") | a save's respelling read as a difference; a generated node a save left in place read as a Hidden Value |
| `reader/__tests__/readerWork.test.ts` | `ReadWork` of one emitted form of 200 questions and one of 400, in three languages, with generated nodes of every purpose | a stage whose work more than doubles when the form does; deterministic, with no clock. Where `rebuilds` is the counter that fails, 13.1 names the fix |
| `reader/xform/__tests__/media.test.ts` | `readMediaForms` and `readMediaMap` over an index that answers `asset`, `no-entry` and `unreadable`: held slots, a hint's and a group label's media, a path differing by language | a path with no file read as `unrecognized`, or claimed held; an unheld slot's missing file left out of `pendingMedia`; a hand-off with no `HandOffRecord` |
| `lib/commcare/__tests__/xmlParseKind.test.ts` | `tryParseXml` over a document type declaration, an XML 1.1 declaration and unclosed markup | a kind told from a message; `xmlParseIssue`'s text changing |

What these do not hold, stated so no one reads more into them: that an expression means what the
source's did (part 08's tests and lane proof 3), that a whole app reads to itself (part 09's fixed point
and proof 6), that the reader's standings equal the lane's (part 14's parity), and that a read of
an app at the byte bound is short (part 12's test at the bound).

---

## Contracts and docs these changes make false

| File | Sentence today | Replacement |
|---|---|---|
| `lib/commcare/CLAUDE.md`, opening | "One-way emission boundary: `BlueprintDoc` → CommCare wire formats (XForm XML, `HqApplication` JSON, `.ccz` archive)." | "The CommCare boundary. It emits a `BlueprintDoc` as CommCare's wire formats (XForm XML, `HqApplication` JSON, `.ccz` archive), and, in `reader/`, reads an HQ app back into one. Nothing outside this package speaks the wire vocabulary in either direction." |
| `lib/commcare/CLAUDE.md`, the opening's last sentence | "A Biome `noRestrictedImports` rule enforces the one-way direction." | "A Biome `noRestrictedImports` rule holds who may import it." |
| `lib/commcare/CLAUDE.md`, "capture URL node" | "from the caller (`lib/deployment/attachmentTarget.ts`), because the emission boundary is one-way;" | "from the caller (`lib/deployment/attachmentTarget.ts`), because `lib/commcare` imports nothing of the deployment layer;" |
| `lib/commcare/xform/captureUrlNode.ts`, the header of `AttachmentUrlTarget` | "because `lib/commcare` is a one-way emission boundary: the deployment layer may read the wire package, never the other way round." | "because `lib/commcare` imports nothing of the deployment layer: the deployment layer may read the wire package, never the other way round." |
| `lib/commcare/xpath/index.ts`, the header comment | "the package's \"one-way emission boundary\" rule is scoped to wire-format emission (XForm XML, HqApplication JSON)," | "the package's import rule (`biome.json`) is scoped to the wire formats (XForm XML, HqApplication JSON)," |
| `biome.json`, the four messages of the rule on `@/lib/commcare` | each opens "lib/commcare is the one-way CommCare emission boundary." | each opens "lib/commcare is the CommCare boundary, the one package that speaks CommCare's wire vocabulary." Part 09's edit of the same four strings adds a consumer and leaves this sentence as written here |
| `lib/commcare/CLAUDE.md`, "The surface manifest" | "Server code reads gate entries through `surface/gates.ts`, never `surface.json`, so a server bundle carries the gate entries alone." | "Server code reads the manifest through `surface/gates.ts` (a gate's identity), `surface/schemaDefaults.ts` (a declared property's default, from `surface.json`), `appStringKeys.ts` (HQ's generated app string patterns, from `surface.json`) and `surface/inventory.ts` (every inventory entry with its standing, for the reader) and `surface/revision.ts` (`isDeclaredSurfaceKey`, part 12's). `inventory.ts` is `server-only`." |
| `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility" | "Server code reads gate entries through `surface/gates.ts`, never the generated `surface.json`." | "Server code reads gate entries through `surface/gates.ts`." (the readers are listed under "The surface manifest") |
| `lib/commcare/CLAUDE.md`, new section "### The reader" after "The surface manifest" | none | "`reader/index.ts::readHqApp` is the one function that turns an HQ app into a document. It is pure and reads only its arguments. Admission is an accounting: every JSON key at a value other than HQ's default and every XML element and attribute must be claimed against a manifest entry (`reader/claims.ts::defineClaims`), the entry's standing decides whether the value is read, dropped or a finding, and whatever is left unclaimed is the circumstance `unrecognized`. A claim is data, held to the manifest by `reader/__tests__/claimsBindManifest.test.ts`, so a manifest edit and the reader cannot drift. A reader stage reads nothing it does not claim. Two uses are handed off instead of claimed, a media path with no file and an itemset over a table the catalog lacks, because project data's rules name their entry; the caller settles each and acceptance holds none is left. The stages run in the order of `reader/index.ts::STAGES`: structure and forms, menus, case management, lists and search, then every expression bound against a provisional document that is built whether or not a finding stands, then the settle passes and assembly. An `unrecognized` finding names a surface key, or the app's own value where what was unclaimed is a value (an appearance); what the reader itself got wrong is a `ReaderDefect`, logged and never shown." |
| the same section, second paragraph | none | "A form is read as HQ's form builder reads it (`reader/xform/`): data tree, binds, setvalues, then the control tree, joined by path. A field's kind comes from one table (`xform/kinds.ts`). Text is found by what references it, never by an itext id. A node Nova generates is recognized by rebuilding it with the emitter's own function and comparing parsed trees (`xform/generated.ts`), with the allocator's name as a precondition; an edited or renamed one is the author's Hidden Value. A real attribute and its `vellum:` shadow must expand to one tree. Logic is never read as text here: each attribute is registered as a pending expression the expression reader binds. Two XPath texts are compared in one place, `reader/syntaxCompare.ts::sameXPathText`." |
| `lib/commcare/CLAUDE.md`, "XForm parse-time oracle + fuzzer", the `xmlParse.ts` paragraph | "DTDs and XML 1.1 declarations are outside Nova's generated resource vocabulary." | the same, followed by "`tryParseXml` names which of the three a failure is (`doctype`, `xml-version`, `malformed`), and no caller reads a message to tell." |
| `lib/commcare/CLAUDE.md`, "Validation counts keep their evaluation context" | "The name is not reserved: an authored sibling of the same name makes the allocator take the next suffix." | the same, followed by "Each base name comes from `generatedNodes.ts::generatedBaseName`, which the reader's recognizer reads too." |
| `lib/doc/CLAUDE.md`, the paragraph on `platformDeclaration.ts` | names `planContentDeclaration` as the one planner | adds "`planDeclarationChoices` gives every declaration a document's content runs on, with and without the date-and-time split, and the one to propose; a reading's review offers them." |
| `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md` | no row | the row of `langs-code-nova-s-language-registry-cannot-name` beside the code-spelling row |
| `docs/research/2026-09-26-hq-round-trip/inventory/questions.md` | no rows | the rows of the ten entries this part adds to the area, each beside the row it splits from or sits beside; the two re-cut rows, `question-id-case-registration-script` (8.8) and `an-explicitly-blank-value-in-a-non-default-language-where-the` (12.2); the re-worded cells of the entries this part edits (8.3, 10.1, 10.4, 12.5); and part 01's 3.5 wording on the question media rows |
| `docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md` | the form media pair as the research wrote it | part 01's 3.5 wording on the pair |
| `lib/domain/expression/CLAUDE.md` | "CommCare names and wire function spelling are provided at the one-way emission boundary." | "CommCare names and wire function spelling are provided at the `lib/commcare` boundary." |
| `docs/architecture/multilingual-localization.md` | "CommCare's localized maps and resources exist only at the one-way `lib/commcare` emission boundary." | "CommCare's localized maps and resources exist only at the `lib/commcare` boundary, which writes them on emission and reads them when an app is brought in from CommCare HQ." |
| root `CLAUDE.md`, "The mental models", item 3 | "CommCare's wire vocabulary is quarantined behind `lib/commcare`, a one-way emission boundary enforced by a Biome import rule." | "CommCare's wire vocabulary is quarantined behind `lib/commcare`, the one boundary that writes it and, for an app brought in from CommCare HQ, reads it, enforced by a Biome import rule." The next sentence, "The SA and the builder never speak CommCare.", is unchanged |
| root `CLAUDE.md`, "The map", `lib/commcare` | "`BlueprintDoc` → wire (XForm XML, HQ JSON, suite.xml, `.ccz`), the validator and its parse-time oracles" | "`BlueprintDoc` → wire (XForm XML, HQ JSON, suite.xml, `.ccz`) and, in `reader/`, an HQ app back to a `BlueprintDoc`; the validator and its parse-time oracles" |
| the same bullet | "This is the compile / export / HQ-upload path; the barrel is client-safe and consumers are allowlisted in `biome.json`." | "This is the compile / export / HQ-upload path and the path an app is brought in through; the barrel is client-safe, the reader sits outside it, and consumers are allowlisted in `biome.json`." |

Every "one-way" row above rests on one fact (2.4): the old sentences are true only of import
direction, and that stands. No page of `content/docs/` changes with this part: what a person does
with the reader is part 13's to document.

---

## Departures

Each item is a decision of this part: a departure from the outline or the research, or an
alternative that was weighed and not taken, with its evidence. The numbers are fixed, since other
parts cite them.

1. **From the outline, item 10 ("Model iteration's admission widens … to the research's load-time
   rule").** Not built in step 6. Evidence: the rule needs to know which answers are set when a form
   loads, an analysis Nova has nowhere; `queryRepeatPlacement.ts::queryRepeatPlacementNeeds` is read by
   the gate (`QUERY_REPEAT_MODEL_ITERATION_SHAPE`), both exports and Preview, so widening it is a new
   authoring rule on four surfaces; and the top-level file `../6-bring-in.md` ("What changed from the
   outline, and why") lists every concept that comes into step 6, and this is not among them.
   Decision: a model-iteration repeat is held where Nova's rule runs it, the three manifest refusals
   stay, and any other shape is the new HELD-NEW entry
   `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule`, owner `xform` (10.4).
2. **From the outline, item 9 ("refused, with the reason `unavailable-on-declared-platform`").** Content
   no declaration runs is the circumstance `no-platform-runs-everything`, one finding per use. Evidence:
   it is a relation between uses, which no manifest entry can name; nothing is declared when a reading
   runs; and part 01 already folds that reason kind into one cause. And a declined split is no refusal:
   where the split is one choice among others the person picks another, and where it is the only one the
   review says what creating the app does.
3. **From the outline, item 9 ("the reader admits `xsd:dateTime` on a bind-only node exactly when … and
   refuses it otherwise").** Kept as a rule, widened to every bind type and made a comparison with
   `fieldBindType` over the bound document (11.4), and the finding is `not-yet`, not a refusal for
   a change in HQ: nothing in HQ is wrong, Nova's Hidden Value holds no type of its own.
4. **From the outline, item 1 ("into one construction batch that passes the absolute gate, or
   refuses with the place and the reason").** `readHqApp` returns more than a batch and runs no
   gate. It returns the document beside its batch, the identities, the declaration choices, the
   facts later parts read, the claim log with its hand-offs and its own defects, and findings only
   where there is no draft. Evidence: part 09's gate and fixed point take a document (16.1 says
   why the reader does not run the gate itself); part 12 logs the defects; part 14's judge takes
   the log. One call builds them all from one walk. Not done: a
   reader that returns a construction batch, identities and findings alone, because each of those
   callers needs what the same walk already holds.
5. **The claim log names a place with two fields.** A record is
   `(artifact, where, key, entry, standing)` (4.5): the place is `artifact` and `where`, because
   that is the lane's own `Use` (`manifest_usage.py::Use`). Not done: a record of
   `(place, surface key, entry id, standing)` with the place as one value, because a log in any
   other shape than the lane's could not be joined to it.
6. **Claims are declared constants, and no file holds a predicate per entry.** A claim is declared
   with a stated use (`take`, `drop`, `refuse`, `account`, `derived`) and checked against the
   entry's standing (4.2). Not done: a claim built at its call site, `cursor.claim(key, entryId)`
   with a `cursor.rest()` for what is left, because such a claim cannot be held to the manifest
   without running the reader on an app that reaches it. Not done: a TypeScript predicate per entry
   id in a file such as `surface/valueClasses.ts`, because it would restate prose the lane itself
   declines to read ("Facts verified at source").
7. **A generated node must carry the allocator's name as well as rebuild.** The name is a
   precondition: the allocator's base name or a suffixed form of it (13.1). Not done: recognizing a
   node by its rebuilt tree alone, with the name only a hint that orders the proposals. Evidence: a
   node of the same shape under another name (`trim_x`) is a path HQ's exports and a case action
   already name; folding it would rename that path at the first publish, and reading it as the
   author's Hidden Value changes nothing.
8. **The classifier of part 01's 7.1 takes the app strings as an input of the reader, and the
   input may answer that there are none.** The reader takes the strings of the document without
   its generated keys (part 01's `D0`) through `ReaderInput.appStrings`, which answers `null`
   where Nova's gate refuses the document (16.5). Not done: the reader building the strings
   itself. Evidence: they exist only as locals of `compiler.ts::compileCcz`, whose inputs (a
   target, a media manifest, lookup naming) the request holds and the reader does not, and that
   compile is total only over a document the gate admits, which the reader cannot ask (16.1). Not
   done: a table built from a walk of text slots alone, which would need no gate. It would be a
   second statement of which ids the emitters write, since the case list and search emitters name
   their strings as they print, and the classifier's own precondition is that Nova's ids are the
   build's (part 01, 7.1).
9. **Beyond the manifest as `main` holds it: eleven manifest entries and two re-cuts.** The first
   re-cut is `questions/question-id-case-registration-script`, HELD to HELD-NEW
   (8.8): Nova's question id rule refuses the three names, so the entry said held of something no
   document can hold. The second is
   `questions/an-explicitly-blank-value-in-a-non-default-language-where-the`, REFUSED to HELD (12.2),
   which part 09's Departure 17 argues: Nova's first publish fills such a blank from the first language,
   as the form builder does on save, and declares it. Each of the eleven new entries is a shape HQ can
   hold that Nova's gate would refuse or Nova's emitter would change, which no entry named, found by
   reading the emitter and the gate against the reader's rows:
   `application-and-settings/langs-code-nova-s-language-registry-cannot-name`;
   `questions/data-root-element-named-other-than-data`,
   `questions/itemset-over-casedb-in-nova-s-case-choices-shape` (HELD: Nova writes it today),
   `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule`,
   `questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes`,
   `questions/hidden-value-bound-a-type-nova-would-not-write`,
   `questions/a-text-whose-languages-show-different-values`,
   `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text` (the half of the
   blank row that stays refused, since one entry has one disposition),
   `questions/connect-deliver-unit-and-task-in-one-form`,
   `questions/connect-learn-and-deliver-blocks-in-one-app`; and part 03's
   `questions/a-markdown-form-in-a-form-whose-text-formatting-is-off` (12.2). The rule of the
   bar is why: the reader admits exactly what the gate admits, so each of these is a finding with a place
   and a sentence, never a gate refusal a person meets after the review.
10. **One circumstance this part adds to part 01's list**, `no-platform-runs-everything`
    (Departure 2), which part 01 holds (its 8.3 and 9.3), with `detail.reason: "split-refused"`
    for its second next step.
11. **The limits of one pass.** The reader reports every finding in one pass (Decision 1; the
    top-level file `../6-bring-in.md` states it as a principle). It reports everything the reader
    can decide from the source, structure and expressions together, because stage 7 builds a
    provisional document and binds every expression in every reading (2.3), and stage 11 decides
    every generated key of `translations` over that document (16.5). Two things are outside it,
    each for a stated reason, and the cursor and the tests hold that nothing else is:
    - **What stands under a thing that got no draft, or under a finding at the thing itself.** A
      mirror menu, a shadow form, and a question whose kind or id is refused are one finding each,
      and their keys, their expressions and their platform uses are covered by it: there is no
      slot to bind an expression in and no owner to count a use against. A generated key of
      `translations` that names such a menu or form, or a menu, list, detail, search or form that
      holds a finding of its own, stands under that finding the same way, and so does the one
      string a shared option label gives that menu (16.5). The person changes that thing first
      either way.
    - **A check whose inputs another finding withheld.** A Hidden Value's bind type is compared only
      where its calculate was held and the form's case writes were read (11.4); a model-iteration
      verdict and a load-order conflict only over expressions that bound; and the generated keys
      are classified only where Nova's build can write the provisional document, which it cannot
      where that document leans on something a finding withheld (16.5). Each skipped check is at a
      place that already carries the finding that withheld it, or, for the keys, in a reading
      whose findings did.

    Not done: leaving a generated key for the reading that follows the person's fix, unclaimed
    and unreported, whenever any finding stands. A key whose menu read whole can be judged now,
    and a person who fixes an account should not meet it for the first time on the next check.
    Part 01's account line says a later check may find more (its 9.1), for the two limits that
    remain.
12. **No document migration, no flag, no rollout.** This part adds no stored key.
    `planDeclarationChoices` is a new function beside `planContentDeclaration`, which keeps its
    callers.
13. **Two uses are handed off, neither claimed nor a finding.** Anything else left unclaimed is a finding
    (4.1). These two are neither when the reader returns: a media path with no file, and an itemset over
    a table the catalog lacks. They are handed off (4.3). Evidence: which entry each stands under is
    decided by the platforms the app runs on, by what each runtime draws for the slot and by HQ's table
    list, rules part 11 owns in `lib/deployment/reading/projectData/`, where `lib/commcare` cannot reach
    them. Not done: leaving the two unclaimed, because every app with a path missing from its media map
    would then read to `unrecognized`, blamed on Nova, where part 11's rule (its 3.2) makes such a
    reference inert and listed. Not done: moving part 11's classifier into the reader, because its inputs
    (the map's entries, the verdict on each file once it is fetched, the declaration a person has not
    chosen yet) are the request's, and it runs again once the files are judged with no new read of the
    source. The property is kept by other means: a hand-off is a typed record with its node, only
    those two kinds exist, the caller settles each in the same request, and acceptance check 1
    refuses a reading with one left over.
14. **The stage order, made exact.** The reader's order is structure, case management, menus, then
    expressions (2.3), with a menu read in two places. A menu's own shape (case type, kind, nesting) is
    read before case management, and what a menu holds that needs bound expressions is settled after them
    (2.3). Evidence: part 07's 2.1, which shows a form's type and its placements cannot be read without
    its menu's case type and kind, and that a link's held-case guards can only be checked over bound
    trees. Not done: one menus stage between case management and expressions, for those two reasons.
15. **The shadow comparison and the literal-output reader are the forms stage's, and it uses the
    tree comparison before the expression reader exists.** `shadowAgrees` and `literalOutputText`
    are in `reader/xform/` (14.2, 12.3), and the generated-node recognizer calls part 08's
    `reader/syntaxCompare.ts` under its form rows alone (13.1). Not done: the three in the
    expression reader. Evidence: each is a fact of a form's source that needs no bound tree, the
    forms stage judges generated nodes, shadows and literal outputs before any expression binds,
    and a second `shadowAgrees` with another prefix rule would raise `shadow-disagrees` twice for
    one attribute and differently.
16. **One reader for `case_references_data.save`, and one for Connect blocks.** `save` is part 07's (8.7)
    and Connect blocks are this part's (15). Not done: either part reading both, because two readers of
    one node are a second claim on it. One reader per node is the frame's rule (4.3).

**The outline's items that touch this part, each settled.**

| Outline item | Where it is settled |
|---|---|
| 1, the reader reads source and forms into one batch or refuses with the place and reason | sections 2 to 16; identity is part 10's; the UI-catalog keys are kept (part 01); no `Form.xmlns` slot (part 10) |
| 5, the platform declaration confirmed before the app exists | 16.3: choices with a proposal, applied at the birth; the surfaces are part 13's |
| 8, output expressions and `instance(…)` text in prose | part 03 for the concept; 12.3 for the reading |
| 8, the other bullets (project-timezone days, several `_xpath_query` rows, HQ's escape hatches, the lowered comparison) | parts 07 and 08 |
| 9, the proposed declaration and the split | 16.3; Departure 2 |
| 9, media by platform | part 11 |
| 9, the confirmations | part 10 (6.5): none is asked at a reading |
| 9, the split's joined value | 16.4, 11.4; Departure 3 |
| 9, guarded and `current()` reads | part 08 |
| 10, query repeats | 10.3, 10.4, 13.2 for structure and placement; part 08 for the authoring spelling of reads; Departure 1 |
| 10, labels and markdown | 12.2, 10.2 (the `field-list` case variant); part 03 for the concepts |
| 10, placements, case writes, advanced selections, search and menus, form links | part 07 |

---

## Files

One list: every file this part makes, changes or moves, with what it holds. Paths under
`lib/commcare/reader/` are written from `reader/`.

**New**

| File | Holds |
|---|---|
| `reader/index.ts`, `reader/types.ts`, `reader/context.ts` | the public function, `STAGES` and the types (2) |
| `reader/claims.ts`, `reader/accounting.ts`, `reader/jsonCursor.ts`, `reader/xmlCursor.ts` | claims as data, the accounting and its two cursors, the claim log (4) |
| `reader/place.ts`, `reader/defects.ts` | places, and the reader's own defects with their closed templates (5) |
| `reader/pendingExpressions.ts` | `PendingRegistry` (11.1), in the file that holds part 08's record (its 2.5) |
| `reader/provisional.ts` | `provisionalDocument` and `bindExpressions` (2.3) |
| `reader/appShell.ts`, `reader/languages.ts`, `reader/structure.ts` | the application walker, languages, and menus and forms at their own keys (6, 7) |
| `reader/translations.ts` | the translation sink (12.5) |
| `reader/generatedTranslationKeys.ts`, `reader/assemble.ts` | the generated key classifier and its owner rule (16.5); assembly and the canonical choices (16.1, 16.2) |
| `reader/xform/*.ts` | the twenty files of 8.1 |
| `lib/commcare/xmlNamespaces.ts` | `XFORMS_NS`, `XHTML_NS`, `JAVAROSA_NS`, `VELLUM_NS`, `OPENROSA_NS`, `NamespaceScope`, `scopeOf`, `splitName`, `isElement`, `namespacedAttribute`, `elementChildren`, `qualifiedName`. The helpers `hq/publishedCaseBlocks.ts` holds privately today are moved here and renamed (`Scope` to `NamespaceScope`, `XFORMS` to `XFORMS_NS`, `XHTML` to `XHTML_NS`, `VELLUM` to `VELLUM_NS`), their bodies unchanged; `JAVAROSA_NS`, `OPENROSA_NS` and `qualifiedName` (4.5) are new |
| `lib/commcare/surface/inventory.ts` | the manifest's index (3) |
| `lib/commcare/xform/consumerWhitespace.ts` | `isConsumerWhitespace`, moved from `builder.ts` (12.3) |
| `proof/checks/fixtures/place-vectors.json`, `proof/checks/test_place_vectors.py` | the place vectors both sides are held to ("Tests") |
| the tests of "Tests" | each under the `__tests__` directory its row names |

**Changed**

| File | Change |
|---|---|
| `lib/commcare/hq/publishedCaseBlocks.ts`, `lib/commcare/xform/deviceForm.ts` | import the namespace helpers and `VELLUM_NS`; `deviceForm.ts`'s own `VELLUM_NAMESPACE` goes. No behavior change |
| `lib/doc/platformDeclaration.ts` | adds `planDeclarationChoices`, `DeclarationChoice`, `DeclarationChoices` (16.3) |
| `lib/commcare/xform/generatedNodes.ts` | adds `generatedBaseName` (13.1), which the allocator then calls. No behavior change |
| `lib/commcare/xform/builder.ts` | exports `buildQueryRepeat`, `buildRepeatBody`, `buildOwnerNodes`, `buildConnectBlocks`, `whitespaceOutput` and `inDataTreeOrder`, private today, and two trees `buildFieldParts` builds inline today, cut out as named functions it then calls: `constraintCountRelevant(question: FormPath): WireExpr` (the `count(q) > 0` of a constraint count's bind) and `questionScalarCheck(blank: "allow" \| "reject"): WireExpr` (`caseScalarTextValueGuard(caseScalarTextValueCalculation(.), blank)`) (13.1); imports `isConsumerWhitespace`. No emitted byte changes, which the existing expander and oracle suites hold |
| `lib/commcare/xmlParse.ts` | `XmlParseFailureKind`, `XmlParseError`, and the `kind` of `tryParseXml`'s failure arm (8.2) |
| `lib/commcare/xform/captureUrlNode.ts`, `lib/commcare/xpath/index.ts` | a comment each ("Contracts"); no code changes |
| `biome.json` | the first sentence of the four messages of the rule on `@/lib/commcare` ("Contracts") |
| `lib/commcare/surface/entries/application-and-settings.json` | the new language entry and the re-worded one beside it (6.3) |
| `lib/commcare/surface/entries/questions.json` | the ten new entries, the two re-cuts (`question-id-case-registration-script`, 8.8; `an-explicitly-blank-value-in-a-non-default-language-where-the`, 12.2) and the re-worded ones (8.3, 10.1, 10.4, 12.5), by the manifest edits of 8.8, 10.1, 10.4, 11.3, 11.4, 12.2, 12.5 and 15; part 01's 3.5 wording on `label-or-option-media-differing-by-language` and its held sibling |
| `lib/commcare/surface/entries/forms-and-case-writes.json` | part 01's 3.5 wording on the form media pair |
| `lib/commcare/surface/entries/gates.json` | `toggle/COMMCARE_CONNECT`'s `contentEntries` gains the two Connect entries (15) |
| `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md`, `questions.md`, `forms-and-case-writes.md` | the rows of those entries ("Contracts") |
| `lib/commcare/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `docs/architecture/multilingual-localization.md`, root `CLAUDE.md` | "Contracts" |

Nothing is removed. The finding types, the circumstance's row and block, and every sentence a
person reads are in part 01's files (`lib/publish/hqFindings.ts`, `hqFindingCopy.ts`), and the two
entries of 7.4 and 15 that name text read as an instance are in part 03's.
