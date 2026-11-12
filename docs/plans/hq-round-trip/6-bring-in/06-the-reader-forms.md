# Step 6, part 06: The reader: frame and forms

Part of step 6's plan, "Bringing an app in from CommCare HQ". This part plans the reader's
architecture and its structural half: the package `lib/commcare/reader/`, its one public function, the
manifest as the reader reads it at run time, the accounting cursor that makes admission a property of
the code, the walk of an HQ application, its menus and its forms at the level of their own keys, and
the whole reading of a form's source: data tree, binds, load-time values, body, text, media references,
the nodes Nova itself generates, Vellum's shadows, Connect blocks, and the declaration the content
allows. It plans pull requests B2 (the frame) and B3 (forms) in full. It hands case management, menus,
lists and search to part 07 (`07-the-reader-cases-menus-lists.md`, B4 and B5), expressions to part 08
(`08-the-reader-expressions.md`, B6) and acceptance to part 09
(`09-acceptance-and-the-first-publish.md`, B7), and states exactly what each receives.

Citations are `path::symbol`. Nova is read at `main` `15a00a97`; the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every
CommCare fact below was read at those commits for this part. HQ paths are relative to
`corehq/apps/app_manager/` unless they start with another app's name; Vellum paths to `src/`. A manifest
entry is named by its full id as `lib/commcare/surface/entries/*.json` holds it.

Nothing in B2 or B3 is reachable by a person: the reader has no caller until B10. Neither pull request
changes a served tool input, a tool description or the guide, so `lib/models.ts::MODEL_CONTEXT_VERSION`
and `lib/db/appTests.ts::RUNTIME_VERSION` do not move, and no `scripts/test-schema.ts` entry is added.

| Section | Owns | Pull request |
|---|---|---|
| 2 | the package, file by file; `readHqApp`'s input and output; purity; the Biome rule | B2 |
| 3 | the manifest at run time: `surface/inventory.ts`, the index and the manifest revision | B2 |
| 4 | the accounting cursor: claims, consumption, the claim log, unknown keys, cost on a large app | B2 |
| 5 | findings and places as the reader makes them | B2 |
| 6 | the application walker: every `Application` key, languages and wire codes, the floor, doc types | B2 |
| 7 | menus and forms at the level of their own keys; identity; the keys left to parts 07 and 08 | B2 |
| 8 | the XForm reader: parse to model and body, the join | B3 |
| 9 | the field kind decision table and appearances | B3 |
| 10 | choices, groups, sections and repeats | B3 |
| 11 | logic slots as pending text; load-time values and A's effective order | B3 |
| 12 | itext by reference, prose, markdown copies, media references, translations | B3 |
| 13 | the generated-node recognizer, purpose by purpose | B3 |
| 14 | Vellum's shadows and hashtag metadata | B3 |
| 15 | Connect blocks | B3 |
| 16 | assembly, the declaration the content allows and the date-and-time split | B2 |
| 17 | what parts 07, 08, 09, 11 and 12 receive | B2, B3 |
| 18 | every finding this part can produce | B2, B3 |

---

## Decisions in brief

1. **The reader is one pure function, `readHqApp(input, options)`, in `lib/commcare/reader/`** (2). It
   reads nothing but its arguments, never throws for an app's content, reports every finding in one
   pass, and returns either a draft (the document, its construction batch, identities, the declaration
   choices and the facts later parts read) or an account. It is outside the `lib/commcare` barrel and
   carries `server-only`. Its stages, 1 to 11 with 5b, run in one fixed order (2.3), with part 07's
   four settle functions after the expressions are bound.
2. **`biome.json` does not change in B2 or B3** (2.4). The reader's one production consumer is
   `lib/deployment/reading/`, which the rule already admits, and `proof/` is outside the rule. The
   rule's four messages open by calling `lib/commcare` a one-way emission boundary, which the reader
   makes false; B7 (part 09), which already edits those four strings, rewrites that first sentence.
3. **The manifest's entries are loaded by one server module, `lib/commcare/surface/inventory.ts`** (3),
   which parses the six area files once and derives each entry's standing, cause, subject and owner
   through part 01's `standingOf` and `fixCauseOf`. The revision a reading stores is part 12's
   `surface/revision.ts::surfaceStandingsRevision`, which B2 carries so the census can name it.
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
7. **A stage that has not landed is an unclaimed key** (2.3). B2's reader reports `unrecognized` for
   everything B3 to B6 will claim. No stub, no flag: the property that refuses an unknown key is the
   one that keeps a half-built reader from admitting anything.
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
14. **A logic attribute is never read as text by this part** (11.1). B3 registers each as part 08's
    `PendingExpression`, under the slot of the document it will live in; stage 7 builds a provisional
    document in every reading, findings or none, and part 08's `readExpressions` binds against it, so
    an expression finding is reported beside a structural one.
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
21. **A real attribute and its `vellum:` shadow must expand to one tree** (14), compared in B3 over the
    grammar's syntax tree with the form's own hashtag metadata. A difference is `shadow-disagrees`. A
    form saved with rich text off has shadows HQ's form builder does not read, and they are inert. A
    hashtag the head lists with no meaning takes the one the real attribute gives it, once per form.
    The comparison is this part's alone: part 08 reads `shadowAgrees` and writes none.
22. **The declaration is a list of choices with one proposed** (16.3): each declaration the content runs
    on, with and without the date-and-time split, the proposal narrowed to Android where HQ holds Web
    Apps off and keeping Web Apps where HQ holds it on. Content no choice runs is a new circumstance,
    `no-platform-runs-everything`, at each use, judged over the provisional document in every reading.
23. **A split question reads back as three ordinary questions** (16.4): a Hidden Value bound
    `xsd:dateTime` whose calculate is the clock-keeping join, beside a date and a time question. The
    reader gives the shape no name of its own.
24. **One class of finding can wait for a second reading** (16.5): a generated key in `translations`
    is classified against the strings Nova's build makes of the whole document, so in a reading that
    already holds a finding it is postponed, never reported as `unrecognized` (Departure 11).
25. **A reference whose standing is project data's is handed off, never left unclaimed** (4.3, 12.4).
    A media path with no file and an itemset over a table the catalog lacks are recorded as hand-offs
    with their node; the caller settles each through part 11's pure rules in the same check, and
    acceptance holds that none is left (Departure 13).
26. **Nova's own defects never reach a person as HQ's content** (5.1). An `unrecognized` finding's
    `detail.name` is always a surface key; what went wrong inside the reader is a `ReaderDefect`
    returned beside the findings, which part 12 logs at error and never stores or shows.
27. **A translation left blank is held in another language and refused in the first** (12.2). A
    blank value in a language other than the first, where the first language holds text, reads as no
    translation, and Nova's first publish writes the first language's text there, as HQ's form
    builder does on every save. A blank in the first language where another language holds text
    stays a refusal, under an entry of its own.
28. **The reader is handed the project space's levels and the record dialect's judge, and learns
    worker and location properties from the app** (2.2, 2.3). From B9 the structure stage puts HQ's
    levels on the draft; from B6 the expression stage runs part 08's `readExpressions` twice, the
    first run only to learn which worker and location properties the app reads.

---

## Executed during planning

Read in full unless a range is named.

- **The plan's rules**: `docs/plans/hq-round-trip/README.md` and the outline.
- **The plan's other parts, for each seam this part states**: part 01 (opening, decisions, 2, 3.5,
  4.1 to 4.4, 7.1, 8, 9.1, 9.3, files, needs, reads), part 03 (2, 3.1, 4.1 to 4.4, 4.8, 5, 8, 10,
  reads), part 04 (3, 7, 11, reads), part 05 (7, 8, the question summary type), part 07 (2, 3.7, 5,
  10.2, 13.3, needs), part 08 (2.5, 3.1 to 3.3, 6.1, 9.3, 10, copy, files, needs), part 09 (4, 5.2,
  5.4, 6.1, 9, 11.2, Departure 6, needs), part 10 (2, 3.1, needs), part 11 (2.1, 3.2, 5.1, 5.5,
  11.1, 11.2, 11.5, 14, needs), part 12 (3.3, 3.6, 3.9, 6.4, needs), part 13 (14.4, needs) and part
  14 (4, 6.2, 8.1, needs).
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
  `vitest.config.mts` (its projects); `docs/testing.md` ("Performance and verification");
  `lib/doc/commitVerdicts.ts` (its imports of `lib/commcare`);
  `lib/commcare/hq/locations.ts::HqLocationType`; the manifest entries this part copies fields
  from, as `lib/commcare/surface/entries/*.json` holds them, and
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

**Claims corrected.**

- **Claim corrected (`lib/commcare/CLAUDE.md`, "The surface manifest").** "Server code reads gate
  entries through `surface/gates.ts`, never `surface.json`, so a server bundle carries the gate entries
  alone." `surface/schemaDefaults.ts` imports `surface.json`, and `lib/deployment/hqSourceBaseline.ts`,
  `preflight.ts` and `service.ts` import it. `appStringKeys.ts` imports `surface.json` too. A server
  bundle already carries the generated surface. B2 replaces the sentence (see "Contracts").
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

---

## Written and not yet run

Nothing was run for this part: no test, no typecheck, no lane. Every Vitest named under "Tests" runs
first in the pull request that adds it, in ordinary CI; R2's file alone is outside it. Two runs decide
something.

**R1 (B3; ordinary CI, `lib/commcare/reader/xform/__tests__/vellumSavedSource.test.ts`).** Whether a
save in HQ's form builder leaves each generated node in the shape section 13 recognizes. The test reads
`proof/hq-reads/navigation-base/app-source-after-form-builder-save.json`, a Nova export after HQ's form
builder saved it with nothing changed, and `proof/hq-reads/navigation-base/app-source.json`, the same
export before.

- *A: every generated node of the saved source folds to the owner the unsaved source folds it to, and
  the two readings give equal form drafts.* Section 13 stands.
- *B: a generated node of the saved source fails its comparison because the save re-spelled it* (an
  attribute added or dropped, a type re-cased). The rule of 13.2 for that purpose gains the saved
  spelling as a second accepted tree, written from the retained read, in B3; the test keeps both
  spellings. No other file changes.
- *C: the save changed what the node computes.* That is a defect of the emitter, not of the reader.
  B3 stops. The emitter is corrected in a pull request of its own against `main`, outside stack B,
  because it changes bytes every export writes. That pull request retains the uncorrected export as
  a control under `proof/controls/`, named by the entry it adds to `proof/fixed-defects.json`
  (`proof/CLAUDE.md`, "The register is strict"). Stack B is rebased onto it and R1 is run again.

The retained read holds the generated nodes its document has. The purposes it does not exhibit are held
by the form fixed point over the fuzz corpus ("Tests") and, after a save, by the lane's two editor saves
in part 14 (B13).

**R2 (B3; by hand on a hosted runner, `lib/commcare/reader/__tests__/readerScale.scale.test.ts`).**
Whether the reader fits its share of a step on an app at Nova's own ceiling. The run builds a source of
150 forms of 200 questions in three languages with the production emitter, reads it in `counts` mode
five times, and prints the slowest read. It is a measurement and asserts no time, because
`docs/testing.md` ("Performance and verification") keeps a timing assertion off shared runners.

The share is 20 seconds for one read. A reading's check runs the reader twice (the read, and
acceptance's re-read of Nova's emission, 17.3) beside a compile, the gate and export readiness, all
inside part 12's `HQ_READING_CHECK_BUDGET_MS` of 60 seconds, which is itself cut from the 90 seconds
part 05 leaves a step beyond its HQ reads (`HQ_READING_STEP_REMAINDER_MS`). Two reads at 20 seconds
leave the other three 20 seconds.

- *A: the slowest read is at or under 20 seconds.* Nothing lands beyond the run and its workflow.
- *B: it is over.* B3 gains, before it merges, a memo of the expected tree of a generated node by
  purpose and path shape (13.1): rebuilding that tree for every candidate is the one cost of this
  design that grows with a form's questions times its generated nodes. A claim's `where` is already
  built only where the full log is asked for (4.5), so nothing is left to move there. The share does
  not move, and the run is made again.

Nothing runs it unasked. The file's name ends `.scale.test.ts`; B3 adds `**/*.scale.test.ts` to the
`exclude` of the `unit` project in `vitest.config.mts` and a third project, `scale`, that includes
only that pattern, so `npm test` and `npm run test:changed` never reach it on any machine. It runs
only from `.github/workflows/reader-scale.yml` (new, `workflow_dispatch` alone, one hosted runner,
`npx vitest run --project scale`), started by hand on B3's branch. It is never run on a person's
machine.

What ordinary CI holds instead is deterministic: `readerWork.test.ts` ("Tests") reads a form of 200
questions and one of 400 and requires each counter of `ReadCensus.work` (2.2) to at most double, so a
stage that goes quadratic fails there with no clock in the test. In production an app that still
runs long ends as part 12's `too-large` (its 3.6), never as a hung step.

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
- **A person meets none of it.** There is no finding type and no place type before part 01's A2.

Stack A changes four things this part reads as its ground, each from the pull request named: a Text
question's `keypad` and the one writer of `appearance`, `xform/appearance.ts::fieldAppearance` (A6); a
prose `value` part and `canonicalProseAtom` (A7); `plainHelp`, `Form.plainText`, and no `markdown` copy
on a hint or a validation message (A8); hyphens in question ids and the doubled hyphen of
`fieldItextKey`, one-option selects and quote marks in a choice value (A9). Stack B is cut after stack A
deploys, so B2 and B3 are written against all of it.

---
## 2. The package and its public function (B2)

### 2.1 Files

`lib/commcare/reader/` is new. Nothing in it is exported from `lib/commcare/index.ts`.

| File | Pull request | Exports |
|---|---|---|
| `lib/commcare/xmlNamespaces.ts` | B2 | `XFORMS_NS`, `XHTML_NS`, `JAVAROSA_NS`, `VELLUM_NS`, `OPENROSA_NS`, `NamespaceScope`, `scopeOf`, `splitName`, `isElement`, `namespacedAttribute`, `elementChildren`, `qualifiedName`. The helpers `hq/publishedCaseBlocks.ts` holds privately today are moved and renamed (`Scope` to `NamespaceScope`, `XFORMS` to `XFORMS_NS`, `XHTML` to `XHTML_NS`, `VELLUM` to `VELLUM_NS`), their bodies unchanged; `JAVAROSA_NS`, `OPENROSA_NS` and `qualifiedName` (4.5) are new. `publishedCaseBlocks.ts` imports them, and so does `xform/deviceForm.ts`, whose own `VELLUM_NAMESPACE` goes |
| `lib/commcare/surface/inventory.ts` | B2 | section 3 |
| `lib/commcare/surface/revision.ts` | B2 | `surfaceStandingsRevision`, exactly as part 12's 3.9 writes it; B10 adds that section's other two functions to the file |
| `reader/index.ts` | B2 | `readHqApp`, `STAGES`, `ReaderStage`, and the types of `types.ts` |
| `reader/types.ts` | B2 | `ReaderInput`, `ReaderOptions`, `ReadOutcome`, `ReadDraft`, `ReadMenuAndFormIdentities`, `ReadFacts`, `ReadFormFacts`, `ReadGeneratedNode`, `ReadCensus`, `ReaderDefect`, `ReaderLookupCatalog`, `ReaderLookupTable`, `ReaderOrganization`, `ReaderMediaIndex`, `ReaderMediaResolution`, `ReadMediaReference`, `PendingMedia`, `UnreadTable`, `AppStringTable` |
| `reader/identity.ts` | B2 | part 10's file, exactly as its sections 2.1 to 2.3 write it |
| `reader/claims.ts` | B2 | `Claim`, `ClaimUse`, `take`, `derived`, `drop`, `refuse`, `account`, `defineClaims`, `claimRegistry` |
| `reader/accounting.ts` | B2 | `Accounting`, `Admitted`, `ClaimSite`, `ClaimRecord`, `HandOffRecord`, `ClaimLog`, `serializeClaimLog` |
| `reader/jsonCursor.ts`, `reader/xmlCursor.ts` | B2 | `JsonCursor`, `HandOffKind`; `XmlCursor`, `XmlNode`, `elementWhere` |
| `reader/place.ts` | B2 | `appPlace`, `appSettingsPlace`, `languagesPlace`, `menuPlace`, `formPlace`, `questionPlace`, `placeOrder`, `whereText`, `placeKey` |
| `reader/defects.ts` | B2 | `READER_DEFECT_CODES`, `ReaderDefectCode`, `ReaderDefectWhy`, `readerDefect` (5.1), with the six constructors of B2's defects; B3 adds the four of D5 to D7 and D10 with their codes, and B6 the two of D11 and D12 |
| `reader/context.ts` | B2 | `ReadContext`, `MutableReadFacts`, `DraftApp`, `DraftModule`, `DraftForm` |
| `reader/pendingExpressions.ts` | B2 | part 08's file, exactly as its section 2.5 writes it: `ReadMode`, `PendingExpression`, `pendingPlaceholder`; and this part's `PendingRegistry` (11.1) |
| `reader/syntaxCompare.ts` | B2 | `sameXPathText`, `sameSyntax`, `firstDifference`, `CompareOptions`, as part 08's 3.1 writes them, with rows L1 to L6 of its 3.2; B6 adds the record rows S1 and S2 to the same file |
| `reader/hqInterpolation.ts` | B2 | part 08's file, exactly as its section 6.1 writes it: `interpolateHqXPath`, `dotInterpolate`, `syntaxOf`, `hqInterpolationSlot`, `HqInterpolationSlot`, `HqInterpolated`, `HQ_USERCASE_XPATH`, `hqCaseByIdXPath`. B2 carries it because B4 and B5 call `syntaxOf`, `dotInterpolate` and `hqInterpolationSlot`; B6 adds nothing to it |
| `reader/provisional.ts` | B2 | `provisionalDocument`; B6 adds `bindExpressions` (stage 7) to the file |
| `reader/worldEntities.ts` | B6, B9 | part 11's file: `worldEntitiesFromReads` (B6), `levelsFromHq` (B9), exactly as its 11.2 and 11.5 write them |
| `reader/appShell.ts`, `reader/languages.ts` | B2 | `readApplication`; `languageIdentityForHqCode`, `readLanguages` |
| `reader/structure.ts` | B2 | `readStructure` |
| `reader/translations.ts` | B2 | `TranslationSink`, `translationEntryFor` |
| `reader/generatedTranslationKeys.ts` | B2 | `classifyGeneratedTranslationKeys`, `GeneratedKeyVerdict` (part 01, 7.1) |
| `reader/assemble.ts` | B2 | `assembleDocument`, `READER_CANONICAL_CHOICES`, `ReaderCanonicalChoice` |
| `reader/xform/*.ts` | B3 | section 8 lists them |
| `lib/doc/platformDeclaration.ts` | B2 | adds `planDeclarationChoices`, `DeclarationChoice`, `DeclarationChoices` (16.3) |
| `lib/commcare/xform/generatedNodes.ts` | B3 | adds `generatedBaseName` (13.1); no behavior changes |
| `lib/commcare/xform/builder.ts` | B3 | exports `buildQueryRepeat`, `buildRepeatBody`, `buildOwnerNodes`, `buildConnectBlocks`, `whitespaceOutput` and `inDataTreeOrder`, private today, and two trees `buildFieldParts` builds inline today, cut out as named functions it then calls: `constraintCountRelevant(question: FormPath): WireExpr` (the `count(q) > 0` of a constraint count's bind) and `questionScalarCheck(blank: "allow" | "reject"): WireExpr` (`caseScalarTextValueGuard(caseScalarTextValueCalculation(.), blank)`) (13.1); imports `isConsumerWhitespace`. No emitted byte changes |
| `lib/commcare/xform/consumerWhitespace.ts` | B3 | new: `isConsumerWhitespace`, moved from `builder.ts` (12.3) |
| `lib/commcare/xmlParse.ts` | B3 | `tryParseXml`'s failure arm gains `kind` (8.2) |

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
	/** The reading's id, which becomes the app's id (part 12). */
	readonly appId: string;
	/** The project space the source was read from, for a capture's link (13.2, `url`). */
	readonly target: { readonly origin: string; readonly domain: string };
	/** Part 05: the source as served, with `raw` and each form's attachment. */
	readonly source: HqAppSource;
	/** Part 05: the aligned menus, each form's real id and HQ's own question summary. */
	readonly modules: readonly HqAlignedModule[];
	/** Part 10: `mintingResolver(appId)` for a reading, `matchingResolver` for proof 6. */
	readonly resolver: IdentityResolver;
	readonly lookup: ReaderLookupCatalog;
	readonly organization: ReaderOrganization;
	readonly media: ReaderMediaIndex;
	/** The local app strings Nova's build gives a document (16.5). Pure. */
	readonly appStrings: (doc: BlueprintDoc) => AppStringTable;
	/** Added by B6 (part 08, 2.5): whether the record dialect prints a tree and reads it back.
	 *  `RecordDialectJudge` is part 08's type (`reader/expressions/index.ts`). Pure. */
	readonly recordDialect: RecordDialectJudge;
}

export interface ReaderOptions {
	/** `counts`, the default, keeps claim counts by entry. `full` also keeps every claim. */
	readonly claims?: "counts" | "full";
}

/** The tables of the source project space the app may read, with the ids the reading minted. */
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
 *  (part 11, 11.5). Both lists are empty until B9's read fills them. */
export interface ReaderOrganization {
	readonly levelCodes: readonly string[];
	/** `lib/commcare/hq/locations.ts::HqLocationType`, on `main`; part 05 reuses its reader
	 *  (its 10.4). */
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
	    readonly census: ReadCensus; readonly claims: ClaimLog;
	    readonly defects: readonly ReaderDefect[] }
	| { readonly kind: "account"; readonly findings: readonly Finding[];
	    readonly census: ReadCensus; readonly claims: ClaimLog;
	    readonly defects: readonly ReaderDefect[];
	    /** What `ReadFacts.unreadTables` held when the reading closed (17.3). */
	    readonly unreadTables: readonly UnreadTable[];
	    /** Whether any slot reads the `locations` instance (2.3). False before B6. */
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

export interface ReadCensus {
	/** `surface/revision.ts::surfaceStandingsRevision()` (part 12, 3.9). */
	readonly manifestRevision: string;
	/** Findings by `code`. */
	readonly byCode: Readonly<Record<string, number>>;
	readonly byStanding: Readonly<Record<FindingStanding | "stop", number>>;
	readonly byOwner: Readonly<Partial<Record<Step7Group, number>>>;
	/** Work done, a function of the input alone: JSON values and XML nodes visited, texts read
	 *  with `readFormSyntax`, and expected trees built for a generated node (13.1). */
	readonly work: { readonly nodes: number; readonly syntaxReads: number; readonly rebuilds: number };
}
```

`ReadFacts` is section 17.3. `kind: "read"` means no finding of any standing was produced; one finding
makes the outcome `account`, with every finding of the pass in `placeOrder` (5.2). A `read` may still
hold hand-offs (4.3): `draft.facts.pendingMedia` and `draft.facts.unreadTables` list what the caller
must settle before the reading is accepted. An `account` carries the two facts part 11's findings
need where there is no draft: `unreadTables`, and `readsLocations`, so a table or a place Nova
cannot hold joins the same account (part 11, 14.1, `projectDataReadsOf`). `ReadStanding` and
`FindingStanding` are part 01's (its 2.1): the second is the three of the first that make a finding.

`readHqApp` reads nothing of `HqAlignedForm.questions`, HQ's own question summary, which is part
09's for its check 5. A re-read of Nova's emission may pass an empty list there.

`ReadMenuAndFormIdentities` is defined here and nowhere else. Part 10's
`lib/deployment/adoption.ts` (B8, its section 3.1) imports it from `@/lib/commcare/reader` and
declares none, because `lib/commcare` cannot import that file: no production file of `lib/commcare`
imports `lib/deployment`, and `lib/deployment` imports `lib/commcare`.

**Purity.** `readHqApp` reads its arguments and module constants (the manifest index, `surface.json`'s
defaults and appearance rules, the language registry) and nothing else: no clock, no randomness, no
environment, no store, no network. Two calls with equal input give deeply equal output, which
`readerPurity.test.ts` holds. The resolver is the one stateful argument: a call consumes it, so a
caller that reads twice passes a fresh one. It never throws for content: a malformed attachment, an
unknown key and a shape no stage expects are findings. It throws only for an input that breaks its own
contract (an `HqAlignedModule` list whose length differs from the source's), which is a defect of the
caller, and the caller logs it at error and gives `read-back-differs`. From B6 it also throws part
08's two invariants, its C10 and C11, each a defect of Nova's own code and no fact of an app.

**Logging.** The reader holds no logger. Each `unrecognized` finding it produces carries the surface
key part 01's 8.3 asks for in `detail.name`, and each defect of the reader's own (the twelve of
5.1) is a `ReaderDefect` in `defects`, its `why` built from closed slots alone. `lib/deployment/reading/`
(part 12) logs each finding and each defect at error with the reading's id when it stores the account,
and stores no defect. A pure function that logged would not be pure under a `matchingResolver` re-read.

### 2.3 The pipeline

`readHqApp` builds one `ReadContext` and runs the stages in this order: structure, case management,
menus, then expressions. Each stage is a function of the context exported by its module and listed
in `reader/index.ts::STAGES`:

```ts
// lib/commcare/reader/index.ts
export type ReaderStage = (ctx: ReadContext) => void;
/** The stages that have landed, in the order of the table below. */
export const STAGES: readonly ReaderStage[];
```

Part 07's functions take the draft as a second argument (`readMenus(ctx, app)`); their entries in
`STAGES` pass `ctx.draft`.

| # | Stage | Module | Lands |
|---|---|---|---|
| 1 | the application: its own keys, languages, the floor | `appShell.ts::readApplication` | B2 |
| 2 | menus and forms: document types, identity, their own keys; from B9, the project space's levels onto the draft | `structure.ts::readStructure` | B2 |
| 3 | each form's source: fields, text, media references, generated nodes | `xform/index.ts::readForms` | B3 |
| 4 | a menu's own shape: its case type, kind and nesting, which every form's reading needs | part 07, `menus/index.ts::readMenus` | B4 |
| 5 | case management and the case catalog; settles the generated candidates of 13.3 | part 07, `caseManagement/index.ts::readCaseManagement` | B4 |
| 5b | mint each form's fields in document order, then register their expressions (11.1) | `xform/index.ts::mintFields` | B3 |
| 6 | case lists and search, every XPath registered as pending; then the entry facts compared and the links' expressions registered, which need every entry's structure and nothing bound | part 07, `caseList/index.ts::readCaseLists`, `search/index.ts::readSearches`, then part 07's `caseManagement/index.ts::compareEntryFacts` and `menus/afterSubmit.ts::registerLinkExpressions` | B5; the last two B4 |
| 7 | the provisional document, then every pending expression bound against it | `provisional.ts::provisionalDocument` (B2); `provisional.ts::bindExpressions`, which calls part 08's `readExpressions` twice with `worldEntitiesFromReads` between and applies the second answer (B6, in part 08's file list) | B2; B6 |
| 8 | what part 07 decides over the bound document | part 07, `settleCaseManagement`, `settleCaseLists`, `settleSearches`, `settleMenus`, in that order | B4, B5; `settleSearches` joins `STAGES` in B6, with the search row code it calls |
| 9 | text: translations from the bound outputs | `xform/prose.ts::finishText` | B3 |
| 10 | what the bound document decides for a form: repeat counts, model iteration, load order, a Hidden Value's bind type | `xform/afterBinding.ts::finishForms` | B3 |
| 11 | the declaration's verdict, the late claims, the close, and the draft where no finding stands | `assemble.ts::assembleDocument` | B2 |

This is the order "structure, case management, menus, then expressions" with one reading of it made
exact, the one part 07's 2.1 argues (Departure 14): a menu's case type, kind and nesting are
structure every form needs, so `readMenus` runs before case management, and what the word menus
names in that order (registration, links, deep links, display conditions) is settled last, in
`settleMenus`, after expressions. `settleMenus` is last of the four because a link's held-case guards are
checked by projecting the whole form's after-submit. The entry facts are compared at the end of stage 6
and not after the expressions (part 07, 2.1): every key a fact reads is structure stages 2 to 6 write,
the frame cannot withdraw a claim once made, and part 08 takes the verdict before it binds, as
`ExpressionReadEnv.entryFactsRefused` (17.2).

**The levels.** From B9, `readStructure` puts
`levelsFromHq(input.organization.levels, ctx.resolver).levels` on the draft (`DraftApp.levels`,
which `provisionalDocument` and `assembleDocument` write into the document), so the levels are in
scope when expressions bind. It raises none of that function's findings: part 11's
`readingProjectDataFindingsFor` raises them, once, and only where the app reads places (part 11,
14.1). Before B9 the list is empty, and a test that needs levels puts them on the draft by hand.

A stage that has not landed is absent from `STAGES`. Its keys are then unclaimed, and stage 11 turns
each into `unrecognized` (4.4). So in B2 every real app reads to an account, in B3 every form with a
case action or an expression still does, and the first pull request after which a plain app reads clean
is B6. That is the frame working, not a gap to cover: nothing calls the reader before B10. Stage 7 in
B2 to B5 builds the provisional document and binds nothing, so every registered expression's node
stays unclaimed.

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
then no stand-in exists. A draft form that cannot be made schema-valid even so is left out. The one
such form is a form with no type, which only a reader before B4 holds (7.4): from B4 every draft
form has a type, so from B6, where expressions are first bound, no form is left out without a
finding at or above it, which is what part 08's C10 holds.

`provisionalDocument(ctx)` may be called at any stage before 7; it returns a deeply frozen document,
the same object until a draft is next written. From stage 7 a stage patches `ctx.doc` only by
assigning a new frozen document, never by mutating it. Part 07's projections memoize by the document
object (`casePlacementPlan.ts`, `placement.ts`, `basicCaseSlots.ts`, each a `WeakMap` keyed by the
document), so a document changed in place would answer with the plan of its earlier state. The
mechanism is one writer: every stage changes a draft inside `ctx.writeDraft(() => { … })`, which
counts a revision, and `provisionalDocument` memoizes on that revision. `provisional.test.ts` holds
both halves: two calls with no write between return one object, and no stage function of `STAGES`
writes a draft outside `writeDraft`.

In B2 to B5 stage 7 is `provisionalDocument` alone: its entry in `STAGES` is
`(ctx) => { ctx.doc = provisionalDocument(ctx); }`, which binds nothing.
`provisional.ts::bindExpressions(ctx)` lands in B6, in part 08's pull request, because it names B6's
exports, and takes that entry's place. It builds `env` with `expressionEnvOf(ctx)` (17.2) and calls
part 08's `readExpressions(doc, ctx.pending.list(), env)` twice (part 08, 2.5; part 11, 11.5):

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
   - each row of `circumstances` is raised with `Accounting.circumstance` and its registration's
     node is covered by it (`Accounting.cover`), so the close reports that node once. The frame
     also records part 08's log line C9 for it as a `ReaderDefect` (D11), and its C12 where the
     row's `detail.reason` is `no-case-datum` (D12): the reader holds no logger (2.2), and part 12
     logs every defect at error;
   - each index of `ExpressionReading.ownerless` has its node covered by the finding that stands at
     or above its place (the registration's own question, else its form, else its menu, else the
     app), through `Accounting.cover`. Where none stands the frame throws part 08's C10;
   - each tag of `ExpressionReading.unreadTables` is appended to `ReadFacts.unreadTables` as
     `{ tag, place: { kind: "lookup-table", tag } }`, a tag already listed left as it is;
   - `rewrites` and `declaredProperties` are kept on `ctx.facts` for part 09, and `rounds` as
     `ReadFacts.expressionRounds` for part 12's log;
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
	/** The project space's levels (`levelsFromHq`); empty until B9. */
	levels: readonly OrganizationLevel[];
	/** What the app reads of the worker and of places (`worldEntitiesFromReads`); empty until B6. */
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
	/** Added by B4 (part 07, 5.2): each create block's `@case_id` path, absolute from the data
	 *  root, to the UUID of the operation read from it. Empty until `readCaseManagement` sets it. */
	operationIdPaths: ReadonlyMap<string, Uuid>;
}
```

A menu or form that got a document-type finding (7.1) has no draft and is skipped by every later stage.

**What part 07's words are in this frame.** Part 07 (`07-the-reader-cases-menus-lists.md`; B4, B5)
speaks this frame through a shorthand its section 2.2 lists, and this is each word's name here. Its
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
consumer is `lib/deployment/reading/` (part 12, section 3), its tests live under
`lib/commcare/reader/**/__tests__/`, and the lane's bundle is built from `proof/` (part 14), which the
override's `includes` does not cover. So B2 and B3 change no line of `biome.json`. The rule's four
messages each open "lib/commcare is the one-way CommCare emission boundary.", which is false once
this package reads as well as writes. B7 already edits those four strings to add a consumer, so the
first sentence of each is rewritten there, to "lib/commcare is the CommCare boundary, the one package
that speaks CommCare's wire vocabulary." (part 09, `09-acceptance-and-the-first-publish.md`,
"Contracts"; part 15, `15-stack-contracts-and-exit.md`, section 6.5). What B2 changes is every other
place that says "one-way" of the package: three sentences of `lib/commcare/CLAUDE.md` and a comment
each in `lib/commcare/xform/captureUrlNode.ts` and `lib/commcare/xpath/index.ts` ("Contracts"). Each
of those is true only of import direction, which stands: nothing of `lib/commcare` but its tests
imports `lib/deployment`. `import "server-only"` at the head of `reader/index.ts` and of
`surface/inventory.ts` keeps both out of a client bundle, as `hq/appSource.ts` does; a script or bundle
that loads them under plain Node passes `--conditions=react-server`, as `scripts/test-schema.ts` runs.

---

## 3. The manifest at run time (B2)

```ts
// lib/commcare/surface/inventory.ts
import "server-only";

export interface IndexedEntry {
	readonly id: string;
	readonly disposition: Disposition;
	readonly standing: ReadStanding;            // standingOf(entry)
	readonly cause: FixCause | null;            // fixCauseOf(entry)
	readonly subject: Subject | null;
	readonly owner: Step7Group | null;
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
- **The revision is not here.** The index holds no revision of its own. The one a reading stores is
  `lib/commcare/surface/revision.ts::surfaceStandingsRevision()`, as part 12's 3.9 defines it (the
  first 16 hex characters of the SHA-256 over every entry's `[id, standingOf(entry)]`, sorted by id).
  B2 carries that file with that one function, because `ReadCensus.manifestRevision` names it from
  B2; part 12 adds `currentStandingOf` and `isDeclaredSurfaceKey` to it in B10 and owns
  `whatNovaLearned`, the rule for "Nova can now hold everything this list named". That rule skips
  a code that is a circumstance, which is right: an account of `shadow-disagrees` names no entry,
  and no manifest edit makes it hold.
- **Who else reads it.** Part 01's account never needs the index: a finding carries its standing,
  cause, subject and owner. Part 14's parity judge loads the JSON files itself in Python.

`surface/__tests__/inventory.test.ts` holds the index to `loadManifest()`: the same entries, each
standing equal to `standingOf`, and `naming` equal to a scan. `surface/__tests__/revision.test.ts`
holds the revision: it changes when a planted entry's standing does and not when its `item` text does.

---

## 4. The accounting cursor (B2)

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
does not own, a server record). A pull request of stack A or of step 7 that moves such an entry between
kept, inert and refused then changes no reader code. An entry that becomes `held` needs code to read it,
and its claim then fails the test below until it is a `take`.

Every claim in the reader is declared in a module-level `defineClaims` call and used by reference, never
built at a call site, so `reader/__tests__/claimsBindManifest.test.ts` can hold all of them without
running the reader: for each registered claim, the entry exists in `inventoryIndex()`; its standing
permits the use; `key` is one of the entry's `surfaceKeys` (or is `null` and the entry holds
`noSurfaceKey`). The test imports every reader module so each registers. It is the test that fails when
a manifest edit and the reader disagree, naming the claim and the entry.

Where one key's values are split among entries by value class, the site holds one claim per class and
its own code picks. That code is the reader's statement of the class; the variants' `expected.json`
(part 14) and the parity judge hold it to the manifest's words.

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
	/** A finding no entry names. */
	circumstance(code: ReadCircumstance, place: HqPlace, detail?: FindingDetail): void;
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
	close(): { readonly findings: readonly Finding[]; readonly census: ReadCensus;
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
	/** Leave a key for the next reading: no claim and no finding. Honored only in an account. */
	postpone(key: string): void;
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
  a finding for it. The caller settles each in the same pure check, straight after the reader
  returns (part 12, 3.3, step 7): `planHqMedia` gives every pending reference a finding or an inert
  claim (`HqMediaPlan.claims`, part 11's 2.1), and `readingProjectDataFindingsFor` every unread tag a
  finding (part 11, 14.1). Part 09's acceptance check 1 (complete accounting) holds that every
  `HandOffRecord` of the log is settled by exactly one of those, and a hand-off left over is
  `unrecognized` there. A reading with a hand-off is therefore never accepted on the reader's word alone
  (Departure 13).
- **A postponed key** is one whose standing needs the document Nova would write, in a reading that
  has none because another finding stands (16.1). It is neither claimed nor reported, and the next reading
  decides it. `close()` honors a postponement only where some other finding stands; in a reading with
  none, a postponed key is `unrecognized` like any unclaimed key, so nothing can be postponed into a
  clean read. This is the one place a finding can wait for a second pass, and 16.5 says why.
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

`detail.name` of an `unrecognized` finding is therefore always a surface key, the one thing part 01's
8.3 lets a person read after "In CommCare HQ:", and what part 12 expects of it. A sentence about the
reader's own claims never stands there.

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
path string. The lane's bases are small, and R2 measures the production mode against its share on an app at
Nova's ceiling.

---

## 5. Findings and places (B2)

### 5.1 How a finding is made

The reader never spells a standing. `Accounting` builds a manifest finding from the index
(`{ code: entry.id, standing, cause, place, subject, owner, detail }`, with `cause` and `owner` present
as part 01's 8.1 says) and a circumstance finding from `hqFindings.ts::CIRCUMSTANCE_STANDINGS`.
`detail.name` is cut to 200 characters, the last a `…` when cut. `detail.reason` is set by part 08,
to the checker's reason, and by this part on `no-platform-runs-everything`, to `split-refused` at a
date and time question whose split is refused (16.3).

What `detail.name` holds, by what the finding is about (part 01, 8.3 and 9.2):

| The finding is about | `detail.name` |
|---|---|
| an appearance | the appearance string as written |
| a bind type, a media type, an itext form | that value as written |
| a setting, a profile property, a translations key | the key |
| an element or attribute no entry names | the lane-style name of 4.4 |
| a language code | the code |
| a platform use no declaration runs (16.3) | the feature's label and the platform that cannot run it |
| anything whose place says it all | absent |

**Defects.** Where the reader itself is at fault it raises `unrecognized` at the place, with the
surface key as above, and calls `Accounting.defect(place, name, why)`. `why` is one of a closed set of
twelve developer lines ("Copy", the defect table, D1 to D12): a second claim, a claim the
manifest no longer permits, a held value nothing read, an identity key met twice, a form source only
Nova's parser refuses, a form's `xmlns` that differs from its source's, an itemset column the catalog
lacks, a document that does not assemble, an entry id `claimEntry` was handed that no claim
registers, a translation Nova's own rule refuses after the pairing passed it (12.5), and, from B6,
part 08's two lines for an expression Nova could not write back (2.3). A person reads only "In
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
	/** B6. `reason` is the row's `detail.reason`, one of part 08's codes (its 9.1). */
	expressionNotWrittenBack(place: HqPlace, reason: string): ReaderDefectWhy;
	/** B6. */
	noCaseDatum(place: HqPlace): ReaderDefectWhy;
};
```

The list and the object are shown as B6 leaves them. Each code lands with its constructor: B2's six
(D1 to D4, D8, D9), B3's four (D5 to D7, D10), B6's two (D11, D12). Each constructor fills its row's
template ("Copy") and nothing else. The slots are closed:

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
text by its kind (D4). What a developer loses in the line is on the reading's row: the finding
beside the defect holds the full place and `detail.name`, and the reading's id finds the row (part
12, section 10). `defects.test.ts` holds the closure (Tests).

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

## 6. The application walker (B2)

`appShell.ts::readApplication` opens the root cursor (class `Application`) and claims every key. The
standing of each is part 01's (`01-the-bar-and-the-manifest.md`, sections 4.1 to 4.4, A2 and A3); this
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
| `logo_refs` | `take(logo-refs-hq-logo-web-apps)` for the slot `hq_logo_web_apps` with the uploader's path; `account(logo-refs-hq-logo-android-home-login-demo)` for the three Android slots; `refuse(logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare)` for a slot whose path is any other | the Web Apps logo, by 12.4's rule for a path: an asset is a `ReadMediaReference` of slot `app_logo`, and a path with no file is handed off |
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

**Manifest edit, B2.** One new entry in `entries/application-and-settings.json`, beside
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
`fix-in-hq`), so B2 adds one to `hqFindingCopy.ts::FINDING_COPY` ("Copy").

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
| equal to an app language's code | the language's display name: until B8, `derived(translations-lang-code-language-display-names-equal-to-the-label)` where the value equals Nova's label for that identity (`resolvedLanguageDisplayLabel`), else `refuse(translations-lang-code-any-other-value-or-absent-where-hq-s)`; from B8 that entry is kept (part 01, 7.2) and the second claim becomes `account`, an edit B8 makes to `appShell.ts` ("Files by pull request", B8). The first claim is `derived` because the value is read into nothing: Nova derives its label from the language's identity |
| `app.display.name` | `take(translations-app-display-name)`: where it differs from `name`, the app name's translation in that language, through `ctx.translations` |
| `homescreen.title` | `account(translations-homescreen-title)` |
| a runtime's own UI text (`appStringKeys.ts::isRuntimeUiStringKey`) | `account(translations-key-in-a-runtime-s-ui-string-catalog-core-android)`; HQ's catalog fill for such a key, `account(translations-catalog-key-hq-fills-with-its-own-text-in-a)` |
| one of HQ's generated patterns (`translationKeyOwner` gives `generated`) | held back to stage 11, and classified there by `classifyGeneratedTranslationKeys` (16.5) |
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

`custom_properties` is left to part 07 (B5), which derives whether `cc-index-case-search-results` is
what Nova would write; B2 claims nothing under it, so until B5 a non-empty map is `unrecognized`.

---

## 7. Menus and forms at the level of their own keys (B2)

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
structural findings; part 12 adds `menu-unreadable-in-hq` at that menu (its 3.3, step 4), and the
reading ends as an account either way.

### 7.2 Identity, before any mint

In this order, for the drafts that remain (part 10, 2.2 and 2.3):

1. A menu with no `unique_id` (absent, null or empty):
   `refuse(menus-and-case-lists/module-unique-id-missing)` at the menu; no draft. The entry is a real
   state with a real next step (its reason: HQ gives a menu its id lazily,
   `models/modules.py::ModuleBase.get_or_create_unique_id`, and opening App Preview once saves one),
   so the person must meet this finding and not a stop. On `main` the menu never reaches a reader:
   `hq/appSource.ts::readHqAppSource` answers `malformed` for a menu whose `unique_id` is no string.
   Part 05 (`05-reading-commcare-hq.md`, B1; its sections 7 and 8.3) admits such a menu under
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

Ids are under `menus-and-case-lists/`. B2 claims the keys that are the menu's own record; every other
declared key is part 07's, named in the last row so the two parts cannot both claim one. Part 07
claims no key of the B2 rows: it reads their result from `ctx.draft`.

| Keys | Claim | Lands |
|---|---|---|
| `doc_type`, `module_type` | 7.1; `module_type` is at its class's default or is covered by the document-type finding | B2 |
| `unique_id` | 7.2 | B2 |
| `name` | `take(modulebase-name)`: the name in the source language into `module.name`, each other language through `ctx.translations` (12.5's rule) | B2 |
| `forms` | `list(…, take(module-forms))`, each child's class from its `doc_type` | B2 |
| `comment` | `account(comment-module)` | B2 |
| `ref_details`, `referral_list` | `account(module-ref-details)`, `account(module-referral-list)` | B2 |
| undeclared: `display_separately`; `display_style` on an advanced menu; any other | `account(module-display-separately)`; `account(display-style-on-an-advanced-or-shadow-module)`; `refuse(any-other-undeclared-key)` | B2 |
| `case_type`, `root_module_id`, `put_in_root`, `parent_select`, `module_filter`, `media_image`, `media_audio`, `use_default_image_for_all`, `use_default_audio_for_all`, `custom_icons`, `case_list`, `case_list_form`, `session_endpoint_id`, `case_list_session_endpoint_id`, `display_style` on a basic menu (where the class declares it), `fixture_select`, `report_context_tile`, `auto_select_case`, `is_training_module`, `lazy_load_case_list_fields`, `show_case_list_optimization_options`, `task_list`, `custom_assertions`, `case_details`, `search_config`, and on an advanced menu `product_details`, `has_schedule`, `schedule_phases` | part 07 | B4, B5 |

### 7.4 A form's keys

Ids are under `forms-and-case-writes/`.

| Keys | Claim | Lands |
|---|---|---|
| `doc_type`, `form_type` | 7.1; `take(form-type)` where `form_type` is not the class's default | B2 |
| `unique_id`, `xmlns` | 7.2 | B2 |
| `name` | `take(name-lang)`, as a menu's name | B2 |
| `version` | `account(version)` | B2 |
| `validation_cache`, `comment`, `submit_notification_label` | `account(validation-cache)`, `account(comment)`, `account(submit-notification-label)` | B2 |
| `show_count` | `account(show-count-false)` or `account(show-count-true)` by value | B2 |
| `submit_label` | `account(submit-label-default)` where every language's value is HQ's default or blank, else `account(submit-label-non-default)` | B2 |
| `is_release_notes_form`, `enable_release_notes` | `account(is-release-notes-form-true-with-or-without-enable-release-notes)` where the first is true, else `account(is-release-notes-form-false-with-enable-release-notes-either-way)` | B2 |
| `schedule_form_id`, `custom_instances`, `auto_gps_capture` | `account(schedule-form-id-set)`, `account(custom-instances-non-empty)`, `account(auto-gps-capture-form)` | B2 |
| `case_references_data` | `object`, with `load` under `account(case-references-data-load)` in B3 (8.7); `save` is part 07's (its 5.3), judged in `settleCaseManagement` once the Save to Case blocks are read | B3; B4 |
| undeclared: `put_in_root`; `no_vellum`; any other | `account(put-in-root-on-a-form-dynamic-key)`; `account(no-vellum-removed-field-dynamic-key)`; `refuse(any-other-undeclared-key)` | B2 |
| `requires`, `actions`, `form_filter`, `post_form_workflow`, `post_form_workflow_fallback`, `form_links`, `session_endpoint_id`, `respect_relevancy`, `function_datum_endpoints`, `media_image`, `media_audio`, `use_default_image_for_all`, `use_default_audio_for_all`, `custom_icons`, `custom_assertions`, and on an advanced form `arbitrary_datums`, `schedule` | part 07 | B4 |

`Form.type` is not on the wire: part 07 derives it from `requires` and `actions`. Until it does, a draft
form has no type and cannot be assembled, which is one more reason no app reads clean before B4.

---
## 8. The XForm reader: parse and join (B3)

### 8.1 Files

All under `lib/commcare/reader/xform/`. Entry ids in sections 8 to 15 are under `questions/` unless
another area is written.

| File | Exports |
|---|---|
| `index.ts` | `readForms` (stage 3), `mintFields` (stage 5b), `ReadXForm`, `ReadSaveToCaseBlock`, `ReadConnectBlock`, `NodeRole`, `DraftField`, `ReadSourceNames`, `SourceNodeRef` (17.2). B6 adds `expressionEnvOf` to the file (17.2) |
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

`tryParseXml` answers `{ issue: string }` today, and a document type declaration can be told from any
other failure only by its message text ("Malformed XML: Document type declarations are not
supported."). B3 gives the failure arm a kind, set where `xmlParse.ts::parseXml` raises each error and
never read back from a message:

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
| a name `questionId.ts::questionIdProblem` refuses as `leading-underscore`, `not-letter-first`, `characters` or `xml-prefix`, or as `reserved-name` for `meta` in any letter case or for `instance`, `bind` or `parsererror` as written, on a node that becomes a field | `refuse(question-id-failing-the-grammar-or-meta-in-any-case)` with the name. B3 adds to that entry's `item`: ", or `instance`, `bind` or `parsererror`, which HQ's form builder cannot open" |
| a name it refuses as `reserved-name` for `case`, `registration` or `script` in any letter case, on a node that becomes a field | `refuse(question-id-case-registration-script)` with the name, the entry B3 re-cuts to HELD-NEW (8.8). The one exception is a root node named `case` as written, which B3 gives no field and leaves whole to part 07 (17.1): its three refusals cover every such node, with the form's actions or without |
| `vellum:comment` | `drop(vellum-comment)` |
| `vellum:lock` on a node or a bind | `refuse(vellum-lock-all-locked-question)` |
| a default-namespace declaration that changes a node's namespace, on a node no plugin owns | `refuse(data-node-xmlns-on-a-hidden-value)` |
| non-blank text on a leaf that becomes a field | `refuse(default-data-value-datavalue-instance-text)` |
| any other attribute of a data node | unclaimed: `unrecognized`. Vellum keeps it as a raw attribute and Nova writes none |

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
	/** Proposed by B3, settled by part 07. The purposes are `GeneratedNodePurpose`'s own names. */
	| { readonly kind: "generated-candidate";
	    readonly purpose: "url" | "datetime" | "trimmed" | "owner"; readonly owner: DataNode | null;
	    /** For `owner`: which of the two trees its calculate is (13.2). */
	    readonly ownerValue?: "acting-user" | "unowned" }
	| { readonly kind: "query-row"; readonly repeat: DraftField }
	| { readonly kind: "connect";
	    readonly block: "learn_module" | "assessment" | "deliver_unit" | "task" }
	/** A node of the case region (13.3), with the container it is where B3 can tell. */
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
/** One Connect element (15), read by B3 and listed for part 07's `connectType` rows. */
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

B3 opens `case_references_data` with `object` (class `CaseReferences`), the container claimed
`account(forms-and-case-writes/case-references-data-load)` with the key
`schema:Form.case_references_data` (`schema:AdvancedForm.case_references_data` on an advanced form),
and claims `load` inside it under the same entry with the key `schema:CaseReferences.load`.

`save` is part 07's, claimed in `settleCaseManagement` (its 5.3), and B3 claims nothing of it. A
differing map can only be judged once the Save to Case blocks are read: a form whose block is part
07's own finding raises that finding alone, and its `save` map is not judged. Two readers of one key
would also be a second claim on one node (4.3). Until B4 a non-empty `save` is therefore unclaimed.

Part 07 cannot call `xform/caseSaveReferences.ts::caseSaveReferences` on a read source as it stands:
it finds `h:head` and `model` by their prefixed names (`childNamed(root, "h:head")`), takes the
primary instance as the `instance` with no `src` where 8.2 takes the one with no `id`, and throws
where either is missing, and where a bind has no `nodeset` or one `FormPath.parse` refuses. This
part's hand-off to it is the pair `parseXFormSource` already found by namespace,
`ParsedXForm.model` and `ParsedXForm.dataRoot`; part 07 (B4, its 5.3) splits the function into
`caseSaveReferencesOf(model: Element, dataRoot: Element): Record<string, HqCaseSaveReference>`,
which takes those two and is total over a read source, and keeps today's `caseSaveReferences(root)`
as the emitter's wrapper over it, with today's throws.

### 8.8 Manifest edits of this section, B3

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
`not-yet` sentence today; B3 adds it ("Copy").

One entry re-cut, `questions/question-id-case-registration-script`. It is HELD today ("`Field.id`
(Vellum warning only), except as below"), and that is not what Nova does: `questionIdProblem` answers
`reserved-name` for `case`, `registration` and `script` in any letter case
(`questionId.ts::RESERVED_QUESTION_IDS.anyCase`), the gate refuses the id (`INVALID_FIELD_ID`), and
neither part 03 nor part 04 changes that set. The bar admits exactly what the gate admits, so a
reading cannot hold such a question, and the REFUSED entry beside it ("failing the grammar, or `meta`
in any case") does not describe it and would send a person to change a name HQ only warns about. B3
re-cuts it:

| Field | Value |
|---|---|
| `disposition` | `HELD-NEW`, `subject: "question-ids"`, `owner: "xform"` |
| `dispositionCell` | "**HELD-NEW**: a name HQ's form builder only warns about, which Nova's question id rule refuses (`questionId.ts::RESERVED_QUESTION_IDS`)" |
| `slotChanges` | removed, as a HELD-NEW entry holds none |
| `platforms`, `emission`, `gates`, `surfaceKeys`, `valueClass`, `item` | unchanged |

`question-ids` is the subject the REFUSED entry beside it carries (part 01, Appendix A), and it holds
no `not-yet` sentence today, so B3 adds one ("Copy", C2b). Nova's own exports never use the entry,
since the gate refuses the name, so no export loses a holder. The re-cut is a reading re-cut,
and lands in B3 with the reader that first claims it (part 01, section 3, the rule for where an
edit lands, and its 3.8, which names this entry for B3).

---

## 9. Field kinds (B3)

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
03 exports for this (A6, its 2.3). They are `minimal` on a trigger, `signature` on an image upload,
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
   per entry in part 14 whose `expected.json` names the entry. Parity is not claimed for them.
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

## 10. Choices, groups and repeats (B3)

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
holding both quote marks is `refuse(choice-value-holding-both-an-apostrophe-and-a-double-quote)`; holding
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
| `instance('casedb')/casedb/case…` with the value ref `@case_id` | one property or attribute step | B3 proposes `optionsSource: { kind: "cases", caseType, labelProperty }` from the nodeset's own `@case_type` literal and the label ref, registers the rest of the nodeset's predicate as a pending expression under the field's `lookup_options_source` slot (11.1), and in stage 10, with the filter bound, rebuilds the nodeset with `caseOptions.ts::caseOptionsNodeset` and compares it through `sameTree`: equal, the itemset is `take(itemset-over-casedb-in-nova-s-case-choices-shape)`; different, `refuse(itemset-over-casedb-or-another-instance-advanced-data-source)` |
| any other | | `refuseSubtree(itemset-over-casedb-or-another-instance-advanced-data-source)` |

**Manifest edit, B3.** Nova writes a casedb itemset today (`builder.ts::buildFieldParts`, the `caseSource`
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

Core reads `field-list` ignoring case (`surface.json`, `appearance:core/field-list`: `whole`,
`ignore-case`), Vellum only as written (`parser.js`: `appearance === 'field-list'`). A case variant is a
Question List on a device and a plain group in HQ's form builder; the reader holds it as `fieldList`,
and Nova writes `field-list`, which the outline's item 10 gave this step. No runtime reads the two
spellings differently, so the re-spelling is a spelling rule the lane proves (part 14), not a change
the first publish declares.

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

**Manifest edit, B3.** New entry `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule`,
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
form". The new entry joins the pair `repeats` at `not-yet`, whose sentence A2 words for button captions
alone, so B3 re-words it ("Copy", C2c).

---

## 11. Logic slots and load-time values (B3)

### 11.1 Pending expressions

B3 parses no expression for its meaning. For each attribute that holds one it registers a
`PendingExpression` and claims nothing; stage 7 hands every registration to part 08's
`readExpressions`, which binds it against the provisional document (2.3), and the frame applies each
`ExpressionClaim` it answers to the node the expression was registered with. An attribute nothing
registers, or one registered before B6 lands, is unclaimed.

The record is part 08's, exactly as its section 2.5 writes it (`ReadMode`, `PendingExpression` with
`ref`, `text`, `mode`, `place` and `key`, and `pendingPlaceholder`), in
`lib/commcare/reader/pendingExpressions.ts`, which B2 carries. This part adds to that file only the
registry that keeps what the record does not hold: the node, a default's event, and what the
expression stage answered for it.

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

`outcome` is filled by `bindExpressions` (B6) from the run it applies: `expression` is
`ExpressionReading.bound[index]`, and `claim` is the claim whose `source` is `index`, the slot's own
(the one whose `key` is the registration's `key`, where part 08 also answers surface-use claims for
the same expression). Before B6, and for a registration nothing bound, both are undefined. Parts 07
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
of the document: B3 gives it to part 08 in `env.generatedValues` (17.2), and part 08 puts it back where
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

**Manifest edit, B3.** New entry
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

**Manifest edit, B3.** New entry `questions/hidden-value-bound-a-type-nova-would-not-write`, beside
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

## 12. Text (B3)

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

After every reference is read, B3 finds which ids an expression reads. It reads the text of every
logic attribute, setvalue value and output of the form (the texts 11.1 registers) with
`readFormSyntax` and collects each call of `jr:itext` whose one argument is a string: the grammar's
tree, never a pattern over text. It needs no binding, so it runs in stage 3 and does not wait for B6.
Then:

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
  Decision 20). A `value` present and empty in the first language where another language holds text
  is `refuse(an-explicitly-blank-value-in-the-first-language-where-another-holds-text)`, new. A
  missing `text` or `value` is no blank: it reads as untranslated. Two cases the pair leaves: a
  blank `value` in another language of a text refused this way is claimed under the same refusal,
  one finding at the question; and a text whose values are blank in every language is the default
  row of the table, read as a blank text.

**Manifest edits, B3.** Three entries, each with its inventory row.

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

Part 09's Departure 21 argues the held half at source: Nova's first publish fills a blank from the
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

B3 claims no entry for an output it registers: the claim is B6's, made once the value is bound.
That holds for the two entries part 03 (A7) adds only under a run's outcome,
`questions/output-value-holding-text-the-form-builder-rewrites` (its G1 outcome B) and
`questions/output-value-in-a-validation-message-core-cannot-compose` (its G3 outcome C, second
case). Each class is a property of the bound value, so part 08's prose slot row claims each ahead
of `questions/output-value-any-other-expression`, by the predicate A7 exports for it (part 08,
sections 9.1 and 9.2), and nothing of `reader/xform/` names either.

`prose.ts::literalOutputText(value: string): string | undefined` is the one reader of those two
shapes, over `readFormSyntax`'s tree, and it lands here in B3, three pull requests before B6. Part
08 (`08-the-reader-expressions.md`, B6; its 10.2) says the same: the function is this part's, and
B6 exports nothing for it. A literal output read as text is confirmed by the print, as
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
  in another, is `refuse(label-or-option-media-differing-by-language)` at the question (part 01's 3.5
  wording, which B3 lands on the three media rows of questions and forms).
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

**Manifest edit, B3.** New entry `questions/a-text-whose-languages-show-different-values`, section
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
## 13. Generated nodes (B3)

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
  parentheses, the quote mark, a number's spelling, axis spellings, `./.`). B3 needs it three pull
  requests before B6, and it needs nothing B6 adds (`readFormSyntax` and `formSyntax.ts` are on
  `main`), so B2 carries the file with those six rows and B6 adds its two record rows to it. No rule
  of this part matches a string, and none compares `formSyntaxKey`s on its own.
- **The expected tree comes from the emitter.** Each rule calls the function the emitter calls for that
  node (`caseScalarTextValueCalculation`, `datetimeCaseValueCalculate`, `captureUrlCalculate`,
  `countPlacementRowPieces`, `protectConstraintMessage`, the `w` builders of
  `builder.ts::buildQueryRepeat`) over the proposed owner's path. The first five are exported today.
  B3 exports from `builder.ts` the ones that are private there (2.1), bodies unchanged, and touches
  neither `caseOps.ts` nor `countPlacementRow.ts`.
- **The name must be the allocator's.** `generatedNodes.ts` gains
  `generatedBaseName(purpose, ownerId, part?)`, the base-name templates the allocator holds inline today
  (`nova_constraint_<id>_<n>`, `nova_constraint_message_<id>`, `nova_url_<id>`, `nova_datetime_<id>`,
  `nova_trimmed_<id>`, `repeatCountBaseName`, `queryRepeatBaseNames`, `nova_keyed_<id>`,
  `nova_count_<keyed>`, `nova_condition_<id>`, `nova_guard_<id>_<kind>`, `nova_owner_<id>`), which the
  allocator then calls. A node is a candidate for an owner only where its name is that base, or the
  base followed by `_` and a whole number from 1 with no leading zero, the suffix
  `namespace.ts::Namespace.peek` gives. The name orders the proposals and never proves one: the tree
  names the owner's path, so at most one owner can match.
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
| `datetime` | `datetimeCaseValue.ts` | a sibling of `q`, named `nova_datetime_<q>` | `type="xsd:string"`; `calculate` the tree `datetimeCaseValueCalculate(q)`; `relevant` `count(q) > 0` | a case action names it, or `q`'s trimmed sibling reads it (part 07) | part 07: the write reads `q` |
| `trimmed` | `builder.ts::buildFieldParts` | a sibling of `q`, named `nova_trimmed_<q>` | no type; `calculate` the tree `caseScalarTextValueCalculation(v)`, `v` the path of `q` or of its `datetime` sibling; `relevant` `count(q) > 0` | a case action names it as a name or an external id (part 07) | part 07: the action reads `q` |
| `owner` | `builder.ts::buildOwnerNodes` | the last child of its scope with no control, named `nova_owner_<operation id>` | `calculate` the tree `instance('commcaresession')/session/context/userid`, or the string `-`; nothing else | an advanced open action names it as its `owner_id` (part 07) | part 07: the operation's `owner` |
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
`datetime`, `trimmed` and `owner` are Nova's only where a case action names them. B3 gives such a node
the role `generated-candidate` and mints nothing for it. Part 07's case management stage (stage 5)
settles each through `ReadXForm.settle(node, "generated" | "field")`: named by an action in the shape the
emitter writes, it is generated; otherwise it is the person's own Hidden Value. Stage 5b,
`xform/index.ts::mintFields`, then settles every candidate still open as a field and mints the form's
fields in document order (8.5), so expressions bind against the final structure. In B3, with no part 07,
every candidate becomes a Hidden Value, which is the safe reading.

**The case region.** A data node is case scaffolding where every leaf under it lies in a
`vellum:role="SaveToCase"` element or is a keyed create's count node (a bind-only node typed `xsd:int`
whose `calculate` is the number `1`), and its body control, where it has one, is a `group` with no
label and no appearance or the `group` and `repeat` of a one-row repeat. Such nodes, their controls,
binds and setvalues take the role `case-region`, each with the `container` B3 can tell from its name
and shape (`generatedBaseName`: `nova_operations`, `nova_condition_<id>`, `nova_keyed_<id>` and its
count node, `nova_guard_<id>_<kind>`, the selected-cases wrapper and row, `nova_subcases`). B3 claims
nothing in them and lists them in `ReadXForm.caseRegion`. Every `vellum:role="SaveToCase"` element,
inside the region or under an authored group, is also a `ReadSaveToCaseBlock` in
`ReadXForm.saveToCaseBlocks`, with its path, its repeat, the binds and setvalues under it and its
wrappers, which is what part 07's `readSaveToCaseBlocks` takes (its section 5). The data path of
every case region container and of every Save to Case block is listed in
`ReadFormFacts.caseRegionPaths` (17.3), in document order, for part 09's check 5 (its 7.5). Part 07
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
  node's path, with no change to what any question asks or stores. B3 records every generated node it
  folded (`ReadFormFacts.generated`, 17.3); part 09 re-reads Nova's emission for the fixed point with
  this same reader, and the difference of the two lists is exactly the nodes Nova adds, renames and
  drops. That difference feeds the first-publish register's entries drawn from `GeneratedNodePurpose`
  (part 09, 11.2 and 11.3). It is never a finding of this part.

---

## 14. Vellum's shadows and hashtag metadata (B3)

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

This is the reader's one shadow comparison, and part 08 (B6; its 10.1) says the same: a shadow is a
fact of the form's source and needs no bound tree, B3 has judged every shadow before B6 runs, a
`PendingExpression` holds no shadow (11.1), and B6 reads the real attribute and writes no comparison
of its own.

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

## 15. Connect blocks (B3)

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

Connect blocks are read here and nowhere else. They are form content with no case action, and a
Connect id takes the question id rule (part 04, section 10), which is why an id the pattern refuses is
the question id entry's and not N15's. Two readers of one element would be a second claim on every
node of it, so part 07 (B4; its 10.2) builds no Connect reader and claims no Connect entry. It reads
the result: `ReadXForm.connectBlocks` and the draft form's `connect`, for its own rows that turn on
`connectType`.

After every form is read, `connectType` is `"learn"` where some form holds a learn module or an
assessment, `"deliver"` where some form holds a deliver unit or a task, and `null` where none holds a
block. An app that holds both kinds is `refuse(connect-learn-and-deliver-blocks-in-one-app)` at the app,
new, raised with `Accounting.finding`: Nova's document holds one `connectType`, and the gate refuses a
block of the other kind (`CONNECT_MODE_MISMATCH`). The provisional document then takes the kind of
the first block in document order, so the forms still bind.

**Manifest edits, B3.** Two entries in `entries/questions.json`, section "Question types", beside
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

## 16. Assembly, the declaration and the split (B2)

### 16.1 Assembly

Stage 11, `assemble.ts::assembleDocument`, runs once the stages before it have. It works on `ctx.doc`,
the provisional document stage 7 built and stages 8 to 10 patched (2.3), which exists in every
reading.

1. **The claims that waited for every form.** `auto_gps_capture` (6.1), which needs only whether any
   form held a Connect block.
2. **What the document decides, in every reading.** The declaration's verdict (16.3) over `ctx.doc`:
   its `none` arm makes its findings here, whether or not another finding stands. (11.4's bind-type
   comparison has already run, per form, in stage 10.)
3. **If any finding stands, no document is returned.** The generated translation keys (16.5) need
   the strings of a document Nova would write, which a reading with a finding has none of, so each
   is postponed (`JsonCursor.postpone`), the accounting is closed, and the outcome is the account,
   with `unreadTables` and `readsLocations` from `ctx.facts` (2.2). The provisional document is
   dropped.
4. **The document.** With no finding there is no stand-in and no placeholder left: every draft is
   whole and every expression held. It takes `ctx.doc` as the normalized `BlueprintDoc`: `appId` from
   the input, `appName`, `connectType` (15), `localization` with the translations of 12.5,
   `appSettings` as `lib/domain/blueprint.ts::NEW_APP_SETTINGS` gives them with `showSavedForms` and
   `showIncompleteForms` as read and no `runsOnlyOn`, the organization's levels and the worker and
   location properties the draft holds (2.3), the entity maps keyed by UUID, and
   `moduleOrder`, `formOrder` and `fieldOrder` in HQ's order. It parses the whole with
   `lib/domain/blueprint.ts`'s document schema. A failure is a reader defect: `unrecognized` at the
   app, `detail.name` `schema:Application.modules`, and the defect D8 (5.1) with the first issue's
   top-level key and code. The issue's deeper path and its message are not in it: a path can hold a
   case type's name and a message can quote a value.
5. **The generated translation keys** (16.5) are claimed now that the document exists; a fold rebuilds
   the document once, and the keys folded are counted in `ReadFacts.foldedTranslationKeys`.
6. **The close.** `Accounting.close()`. If a finding stands, the outcome is the account.
7. **The draft.** `batch` is `lib/doc/diffDocsToMutations.ts::diffDocsToMutations` from
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
`canon.test.ts` (B7) proves each pair prints equal bytes).

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
| `root-question-lists-are-sections` | `one-wire` | a root of sections, and a root of `fieldList` groups with no condition, no label media and no worker-added repeat | sections (10.2) |
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

Part 07 adds five rows: in B4 `registration-form-last`, `create-name-required-is-absent` and
`default-post-submit-is-absent`; in B5 `dormant-tile-cells` and `case-catalog-is-as-read`. Part 08
adds none: its `expression-print-collisions` is `canonicalExpression`, which `canon.ts` wraps (part
09, section 9). `blank-translation-is-absent` is not a row of this list: it is `canon.ts`'s own
(B7), though B3 reads a held blank translation as absent from the start (12.2).

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
circumstance `no-platform-runs-everything` (worded here, held by part 01's 8.3; "Copy"), at the use's
place, with `detail.name` the feature's label and the platform (`PLATFORM_FEATURES[feature].label`,
then ", which Web Apps can't run" or ", which Android can't run"); where `splitRefused` is set the
finding at that question carries `detail.reason: "split-refused"`, and part 01's `circumstanceNext`
then words its next step ("Copy"). Over a provisional document the verdict is sound one way: every use it
finds is a use the source holds, so a finding it makes is true, and a use inside a menu or form that got
no draft is not seen (Departure 11). `choices` goes into the draft, which exists only where no finding
stands, so the choices a person is offered are always over the whole document.

The choices leave this part as the content allows them. One later narrowing is another part's: part
11's `narrowDeclarationsByMedia` (its 14.2) drops a choice that declares a platform a referenced
file does not play on, before acceptance (part 12, 3.3, step 7). Part 09's check 2 then drops none:
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
the app strings Nova's own build gives the document. The reader takes those strings as an input, so it
stays pure and needs no target or media manifest of its own:

```ts
// lib/commcare/reader/types.ts, a member of ReaderInput
/** The local app strings of a document, by language code, with each string's source. */
readonly appStrings: (doc: BlueprintDoc) => AppStringTable;

export interface AppStringTable {
	readonly languages: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** A string's source where it comes from a translation unit or several. */
	readonly units: Readonly<Record<string, WireStringSource>>;
}
```

```ts
// lib/commcare/reader/generatedTranslationKeys.ts
export type GeneratedKeyVerdict =
	| { readonly kind: "inert" }
	| { readonly kind: "fold"; readonly unit: TranslationUnitId; readonly language: string;
	    readonly value: string }
	| { readonly kind: "not-yet" };
export function classifyGeneratedTranslationKeys(
	held: readonly { readonly language: string; readonly key: string; readonly value: string }[],
	table: AppStringTable,
): readonly GeneratedKeyVerdict[];
```

It is part 01's five rules, in its order: a blank value, a key no string of the table has, and a value
equal to the table's string are inert; a key whose source is one translation unit, where every other
key that unit feeds holds the same value in that language or is this key, folds; anything else, a key
whose source is several units among it, is not-yet. `assembleDocument` claims each key with
`account(translations-generated-key-with-no-effect)`, `take(translations-generated-key-over-one-text)`
(writing the value as the unit's text in that language through the translation sink, once per unit) or
`refuse(translations-generated-key-anything-else)` with the key in `detail.name`, and rebuilds the
document when anything folded.

Where the reading already holds a finding there is no document Nova would write and so no table (the
provisional one holds placeholders and stand-ins, whose strings are not the app's), and a generated
key is postponed (4.3): it is classified in the reading that follows the person's fix. The reader
reports every finding in one pass (Decision 1), and this class cannot be given in it: its standing
is a fact about the strings Nova's build makes of the whole app. Departure 11 states this limit and
the two smaller ones beside it. A postponed key is never reported as `unrecognized`, which would blame
Nova for a key it reads perfectly well.

B2 lands the three entries, the subject `translation-overrides` with its label and sentence (part 01,
files of B2) and the classifier with its tests over hand-built tables. The production value of
`appStrings` is part 09's (17.5), since it needs the compile of a reading's document.

---

## 17. What other parts receive

### 17.1 Part 07 (B4, B5): case management, menus, lists and search

- **The stages.** Its ten functions are stages 4, 5, 6 and 8 of 2.3, in the order its 2.1 gives:
  `readMenus`, `readCaseManagement`, `readCaseLists`, `readSearches`, `compareEntryFacts`,
  `registerLinkExpressions`, and the four settle functions.
- **The drafts.** `ctx.draft.modules[i].json` and each form's `json`, with the keys of 7.3's and
  7.4's last rows left unclaimed for it, and `module`, `form` to set slots on, each write inside
  `ctx.writeDraft` (2.3). `Form.type`, `caseOperations`, `postSubmit`, the links and every menu slot
  are its to set before stage 7, with `pendingPlaceholder` in a required expression slot. After
  stage 7 it reads `ctx.doc` and patches it by assigning a new frozen document (2.3).
- **The frame's names for its shorthand** are the paragraph that closes 2.3: declared claims through
  the cursors, `ctx.accounting.finding`, `ctx.pending.register` and `outcome`,
  `provisionalDocument(ctx)`, `ctx.translations`, `readMediaMap`.
- **A form's source.** `DraftForm.xform` (`ReadXForm`): the parsed source, the data nodes by path, each
  node's role, the binds by node, the setvalues, the cursor to claim with, `caseRegion` with each
  node's container, `saveToCaseBlocks` and `connectBlocks` (8.6).
- **Candidates.** `ReadXForm.candidates`, each a node whose role names the purpose (`url`, `datetime`,
  `trimmed`, `owner`, the emitter's own names) and the owner it was proposed for, an `owner`
  candidate with its value (`acting-user` or `unowned`); `settle(node, verdict)` (13.3). It settles
  them in stage 5.
- **The scalar check** recorded on a draft field (13.2, `DraftField.scalarCheck`), which its
  `settleCaseManagement` holds to `caseScalarTextGuards` of the bound document (its 3.5).
- **Load order.** A value HQ's build appends (basic `case_preload` and `usercase_preload`, an
  advanced load's `preload`) is its own to judge, with its `laterLoadReaders` in `settlePreloads`
  (its 3.7). This part's `loadOrderConflicts` judges the form's own setvalues alone (11.3).
- **Root nodes named `case` and `commcare_usercase`.** A root node named `case` has the role
  `root-case`, no field, and nothing of it claimed (8.3): part 07 claims it under whichever of
  `a-root-question-case-in-a-form-where-hq-writes-the-primary-case` and
  `hand-written-case-block-without-vellum-role-incl-a-root-data` its form's actions make apply. A
  root node named `commcare_usercase` passes the question id rule and is a field B3 claimed; where
  the form holds usercase updates part 07 raises
  `a-root-question-commcare-usercase-in-a-form-with-usercase` with `ctx.accounting.finding` at that
  question, which claims no node.
- **`case_references_data.save`** and the model and data root to compute it from (8.7).
- **The translation sink**, for every localized map it reads, under 12.5's rule.

### 17.2 Part 08 (B6): expressions

- **The registrations.** `ctx.pending.list()`: every `PendingExpression` of 11.1, in registration
  order, each under a slot the provisional document holds. Stage 7 (`bindExpressions`, the frame's
  code, landing in B6 with what it calls) runs `readExpressions(doc, pending, env)` twice and
  applies what the second run answers (2.3): the document, the claims by their `source` index, the
  circumstances, the ownerless registrations, the unread tables, the rewrites, the declared
  properties and the rounds.
- **`env`**, from `xform/index.ts::expressionEnvOf(ctx: ReadContext): ExpressionReadEnv`, which B6
  adds to that file. It builds the members part 08's `ExpressionReadEnv` names (its 2.5), the
  per-form ones from each `ReadXForm`, keyed by the form's UUID:

  | `env` member | Built from |
  |---|---|
  | `lookup` | `input.lookup.definitions` |
  | `sourceNames` | `ReadXForm.sourceNames`, below |
  | `itextUnits` | `ItextTable.owners`: each source text id a control references, to the unit of its first owning slot in document order (`itextIds.ts`'s unit for that field, slot and option) |
  | `instanceSources` | `ReadXForm.instanceSources` |
  | `generatedValues` | each node B3 folded as a `constraint-count` (13.2), by absolute path, with its `calculate` text |
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
- **What it reads of B2 and B3 and does not write**: `sameXPathText` with `sameSyntax`,
  `firstDifference` and `CompareOptions` in `reader/syntaxCompare.ts`, which B2 carries with the form
  rows and to which B6 adds its record rows S1 and S2; `reader/hqInterpolation.ts`, which B2 carries
  whole; `literalOutputText` in `reader/xform/prose.ts` (12.3); and the shadow comparison of
  `reader/xform/shadow.ts` (14.2), of which B6 writes no second.
- **The comparisons that wait for bound trees** are this part's code over `ctx.doc`, in stage 10: the
  protected message's expression (13.2), the case choices itemset (10.1), the count and
  model-iteration verdicts (10.3, 10.4), the load order (11.3) and the Hidden Value bind types (11.4).

### 17.3 Part 09 (B7): acceptance and the first-publish register

```ts
// lib/commcare/reader/types.ts
export interface ReadFacts {
	/** HQ's `cloudcare_enabled`. */
	readonly webAppsOnInHq: boolean;
	/** Every media reference whose path resolved to an asset. */
	readonly mediaReferences: readonly ReadMediaReference[];
	/** Every media reference handed off: no file for its path (12.4). */
	readonly pendingMedia: readonly PendingMedia[];
	/** Every itemset over a table the catalog does not hold, handed off (10.1); from B6 also each
	 *  tag an expression reads that the catalog lacks, at the place `{ kind: "lookup-table", tag }`. */
	readonly unreadTables: readonly UnreadTable[];
	/** The generated translation keys `assembleDocument` folded (16.5). */
	readonly foldedTranslationKeys: number;
	readonly forms: readonly ReadFormFacts[];

	// Added by B4 (part 07): its 2.2, 13.3 and 6.3.
	/** Each same-state rule applied: the entry, a JSON Pointer, and the id of the row of part 09's
	 *  `FIRST_PUBLISH_CHANGES` the rule falls under. */
	readonly sameStateRewrites: readonly {
		readonly entry: string; readonly path: string; readonly register: string;
	}[];
	/** The forms `compareEntryFacts` found differing. */
	readonly entryFactsRefused: readonly Uuid[];

	// Added by B6 (part 08): `bindExpressions` fills them from the run it applies (2.3).
	/** Part 08's reports, passed through: the rewrites it applied and the properties it declared. */
	readonly rewrites: ExpressionReading["rewrites"];
	readonly declaredProperties: ExpressionReading["declaredProperties"];
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

The members marked B4 and B6 land in `types.ts` with the pull request named, which also lists the
file; every other member is B2's. `ReadGeneratedNode.owner`'s rule is held to the emitter's plan by
part 09's `generatedNodes.parity.test.ts` (B7). Part 09 gets the register's generated-node entries
by comparing `forms[i].generated` of the reading with the same list of its fixed-point re-read
(13.4). Its check 4 cuts the paths of `inertAppearances` from CommCare HQ's side (its 6.3), its
check 5 reads `caseRegionPaths` (its 7.5), and rows 23 and 28 of its register read
`foldedTranslationKeys` and `blankTranslations` (its 11.2). `ReadFormFacts` holds no bind type:
check 4 reads each bind from the form's XML itself, through a module that imports no reader module,
so a mistake of the reader's cannot agree with itself (its 6.1 and Departure 6). Every member of
`ReadFacts` and `ReadFormFacts` has a reader named in this section or in 2.3: a fact no part reads
is not kept, so the form's itext ids, a count of dropped markdown copies, the form's load order and
a machine reason beside a finding are in neither type. Its check 3 re-read calls `readHqApp` again over
Nova's emission with a fresh resolver (its 5.2), which is why the function is pure. Its check 1, complete
accounting, includes the hand-offs: every `HandOffRecord` of `ReadOutcome.claims.handOffs` must be
settled by exactly one finding or one inert claim of part 11's (4.3), and one left over is `unrecognized`
at its place.

### 17.4 Parts 11 and 12: project data

The reader takes the lookup catalog and the media index as inputs, so the reading must fetch the
tables before it calls the reader. It does so without the reader: part 11's
`candidateLookupTags(sourceText, tables)` and `sourceMayReadPlaces(sourceText)` (its 5.1 and 11.1)
test the source's text for the names HQ gave, inside its `readReadingProjectData` (its 14.1), which
part 12's read step calls before the check that runs the reader (its 3.3, step 5). This part plans
no scan of its own. The levels reach the reader as `input.organization` (2.2), and from B9 the
structure stage puts them on the draft (2.3).

What the reader gives back, for part 11's rules to judge in the same check:

- `facts.mediaReferences` and `facts.pendingMedia` (12.4), which part 11's `hqMediaReferencesOf`
  turns into its `HqMediaReference` list for `planHqMedia`;
- `facts.unreadTables` (10.1), which with the table ids the document holds
  (`lib/doc/lookupReferences.ts::extractLookupReferenceTargets`) is what part 11's
  `projectDataReadsOf` reads (its 14.1); in an account, where there is no draft, the same list and
  `readsLocations` on the outcome itself (2.2);
- the claim log's `handOffs` (4.5), one per node behind the media list and the itemset tags, which
  acceptance holds settled. A tag part 08 appends in B6 has no hand-off: its expression's node is
  claimed by part 08 under its own entry.

A table the catalog holds is bound by the reader itself, through `input.lookup.table(tag)` and
`column(fieldName)`. Before any byte of a file is fetched, the media index answers a path the map
holds with the id the reading has reserved for that file (part 12, 3.3, step 6), so the document is
the same before the media step and after it.

### 17.5 The production `appStrings`

`ReaderInput.appStrings` (16.5) needs the strings Nova's build gives a document, with each string's
source. `compiler.ts::compileCcz` builds exactly that pair (`appStrings`, `appStringUnits`) as locals and
returns an archive. Part 09 (B7; its section 15) is the first to compile a reading's document, so it
splits `compileCcz` there and passes the function; until then tests pass a table by hand.

---

## 18. Every finding this part can produce

Manifest findings are every `refuse` and every `account` whose entry is not kept or inert, in sections
6 to 15; each takes its standing, cause, subject and owner from the entry. This table is the index, by
where a person meets it. Ids under `questions/` are written bare.

| Where | Entries |
|---|---|
| the app | `application-and-settings/34p-hq-build-spec-below-nova-s-floor`; the `account` rows of 6.1 that part 01 leaves refused or not-yet (`39-hq-case-sharing`, `46-hq-use-grid-menus`, `47-hq-grid-form-menus-none-all-some`, `41p-hq-use-custom-suite-true`, `44p-hq-translation-strategy-select-known`, `48p-hq-target-commcare-flavor-commcare-commcare-lts`, `33p-hq-application-version-1-0`, `50pp-hq-location-fixture-restore-only-hierarchical-fixture`, `build-profiles-non-empty`, `non-empty-custom-assertions-app`, `logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`, `an-unknown-top-level-key-naming-an-application-read-only`); the profile rows of 6.6; `translations-generated-key-anything-else`; until B8, `translations-lang-code-any-other-value-or-absent-where-hq-s`; `connect-learn-and-deliver-blocks-in-one-app` |
| the languages | `langs-containing-an-empty-code`, `a-non-empty-langs-code-outside-that-grammar-or-repeated`, `langs-code-nova-s-language-registry-cannot-name` |
| a menu | the document types of 7.1; `menus-and-case-lists/module-unique-id-missing`; `menus-and-case-lists/any-other-undeclared-key` |
| a form | the document types of 7.1; `forms-and-case-writes/blank-source-or-no-non-group-question`; `forms-and-case-writes/two-non-shadow-forms-sharing-an-xmlns`; the `account` rows of 7.4 that are refused or not-yet (`show-count-true`, `submit-label-non-default`, `is-release-notes-form-true-with-or-without-enable-release-notes`, `schedule-form-id-set`, `custom-instances-non-empty`, `auto-gps-capture-form`, `any-other-undeclared-key`); every refusal of 8.2; `content-marked-vellum-ignore-retain-vellum-ignored`; `data-root-element-named-other-than-data` |
| a question: what it is | the refusals of 8.3 to 8.5 and of 9.1, `question-id-case-registration-script` among them; the appearance entries of 9.2; part 04's seven entries for a slot a kind does not hold; `bind-calculate-on-a-visible-question`; `bind-readonly`; `hidden-value-with-children`; `hidden-value-with-both-calculate-and-a-default-by-any-expression`; `hidden-value-bound-a-type-nova-would-not-write` |
| a question: its choices | the refusals of 10.1 |
| a group or a repeat | `user-controlled-repeat-inside-a-question-list-a-group-whose`; the refusals of 10.3 and 10.4; the repeat captions |
| a question: its logic | the setvalue refusals of 11.2; `default-setvalues-in-an-order-a-save-in-the-form-builder-changes`; `validation-message-without-a-validation-condition`; `requiredcondition-differing-from-a-present-non-false-required` |
| a question: its text and media | the refusals of 12.1 and 12.2, `an-explicitly-blank-value-in-the-first-language-where-another-holds-text` among them; `label-or-option-media-differing-by-language`; `a-text-whose-languages-show-different-values` |
| a Connect block | the refusals of 15 |

Circumstances this part raises:

| Code | Where | When |
|---|---|---|
| `unrecognized` | any place | 4.4: a use nothing claimed, and each of the reader's own defects (5.1), every one with a surface key in `detail.name` and its `ReaderDefect` beside it |
| `shadow-disagrees` | a question | 14.2 |
| `no-platform-runs-everything` | each use | 16.3; worded here, held by part 01 (its 8.3 and 9.3), landing in B2 |

It raises no `stop`: every `stop` is the HQ read's (part 05) or the reading's (part 12). It never raises
`read-back-differs`, which is part 09's for acceptance checks 3 to 5.

---
## Copy

Every string this part adds that a person, a developer or a model reads.

**For a person (finding copy, `lib/publish/hqFindingCopy.ts`).** Each new HELD-NEW or REFUSED entry of
this part takes a subject part 01 already words, except three pairs that have no sentence today and one
sentence its model iteration entry makes false. The pull request that adds the entry adds or re-words
the sentence, as part 01's 2.6 requires.

| # | Pull request | Where | String |
|---|---|---|---|
| C1 | B2 | `FINDING_COPY["language-codes"]["not-yet"]` | "A language code here is one Nova can't hold yet." |
| C2 | B3 | `FINDING_COPY["form-source"]["not-yet"]` | "A form's source here is built in a way Nova can't hold yet." |
| C2b | B3 | `FINDING_COPY["question-ids"]["not-yet"]` | "A question ID here is one Nova can't hold yet." |
| C2c | B3 | `FINDING_COPY["repeats"]["not-yet"]`, replacing A2's sentence | "A repeat group here is set up in a way Nova can't hold yet." |

C2c replaces a sentence where the other three add one: A2 words the pair for a repeat's button captions
alone ("A repeat group here has its own wording on its buttons, which Nova can't hold yet."), and 10.4's
entry `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule` joins the pair in B3, of
which that sentence would be false. The new sentence is true of both entries (part 01, 9.2's second
table).

**The circumstance this part words** (`no-platform-runs-everything`). Part 01 owns the list: its 8.3
holds the row and its 9.3 the block, both landing in B2 ("What this part needs of other parts").

| Field | String |
|---|---|
| title | "No one platform runs this whole app" |
| body | "Part of this app runs only in Web Apps and part only on Android, so workers on either would meet something that doesn't work." |
| next | "You can change one of these in CommCare HQ so one platform runs everything, then check again." |
| next, where the finding carries `detail.reason: "split-refused"` | "You can change how the date and time question {question} reads its own answer in CommCare HQ, then check again." |
| `detail.name`, Web Apps | "<feature label>, which Web Apps can't run" |
| `detail.name`, Android | "<feature label>, which Android can't run" |

Part 01's `lib/publish/hqFindingCopy.ts::circumstanceNext(finding)` (its 8.4, B2) chooses between the
two next steps, for the account screen and MCP alike: the second where `detail.reason` is
`split-refused`, with `{question}` the last segment of `place.path`, and the first otherwise.
`<feature label>` is `lib/domain/platforms.ts::PLATFORM_FEATURES[feature].label` ("Date and time
questions", "Forms that read the search"), which is already written in Nova's voice.

**The account's line.** "When these are changed, Nova will check the app again and may find more to
name." is part 01's `ACCOUNT_CHECK_AGAIN_LINE` (its 9.1, B2), shown under the groups of every
account (part 13, 7.1). Departure 11 is why it exists.

**For a developer.**

| # | Pull request | Where | String |
|---|---|---|---|
| C3 | B2 | `readHqApp`, a broken input | "The reader was given <n> aligned menus for a source that holds <m>. Pass the menus of the same reading the source came from." |
| C4 | B2 | `claimsBindManifest.test.ts`, an entry that is gone | "The claim <module.name> names the entry <entry>, which no area file of lib/commcare/surface/entries holds. Check the id's spelling, or point the claim at the entry that took its place." |
| C5 | B2 | the same, a use the standing forbids | "The claim <module.name> would <use> a value under <entry>, and that entry is now <standing>. Change the claim to a use its standing permits (take or derived: held; drop: inert or kept; refuse: not-yet, never or fix-in-hq; account: any but held), or put the entry back." |
| C6 | B2 | the same, a key the entry lacks | "The claim <module.name> reads the surface key <key>, which <entry> does not list. Name one of the entry's surfaceKeys, or add the key to the entry." |
| C7 | B3 | `appearanceRows.test.ts` | "The appearance entry <entry> is named by no rule of lib/commcare/reader/xform/appearances.ts. Give it a row of APPEARANCE_ROWS, or the refused-class port that reads it." |
| C8 | B2 | `inventoryIndex()`, a file that fails the schema | Zod's own issue, prefixed "lib/commcare/surface/entries/<area>.json does not match the manifest schema: " |

**In an account, from the reader itself** (`detail.name` of an `unrecognized` finding, shown after part
01's sentence as "In CommCare HQ: <name>"). It is always a surface key in the lane's vocabulary, the
name of what Nova met in the app, and never a sentence about the reader:

| When | `detail.name` |
|---|---|
| an unclaimed JSON key, or one the reader mishandled | `schema:<Class>.<key>`, or `<Class>.<key>` for an undeclared key |
| an unclaimed element or attribute, or one the reader mishandled | `xform:<name>`, `xform:<element>@<attribute>` |
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
| D11 | from B6: an expression Nova could not write back (2.3) | `expression-not-written-back`, `expressionNotWrittenBack` | part 08's log line C9, as its "Copy" words it, its `{place}` filled by `placeKey` and its `{reason}` by the row's `detail.reason` |
| D12 | from B6: the same, where `detail.reason` is `no-case-datum` | `no-case-datum`, `noCaseDatum` | part 08's log line C12, as its "Copy" words it, its `{place}` filled by `placeKey` |

D1 to D4, D8 and D9 are B2's; D5 to D7 and D10 land in B3 with the form reader; D11 and D12 in B6.
The reading's id is in no line: part 12's log line carries it as the `appId` tag.

No string of this part reaches a model: B2 and B3 add no tool, no tool description and no guide text.

---

## Tests

Vitest, in ordinary CI but for R2's one file, at the reader's own boundary: inputs are retained HQ reads
(`proof/hq-reads/`, HQ's own answers held byte for byte by the lane) and sources the production emitter
or a person's hand built; outputs are what `readHqApp` and its stages return. No test runs HQ, no test
touches a database, and none renders a component. Each names the failure it would catch.

**B2**

| Test | Boundary | Catches |
|---|---|---|
| `lib/commcare/surface/__tests__/inventory.test.ts` | `inventoryIndex()` against `loadManifest()` | an entry the index drops; a standing that differs from `standingOf` |
| `lib/commcare/surface/__tests__/revision.test.ts` | the revision's cases of part 12's 3.9: `surfaceStandingsRevision()` over the manifest with one entry's standing planted, and with one `item` text edited. B10 adds the cases of the two functions it adds | a revision that moves on a text edit or stays on a standing flip |
| `reader/__tests__/syntaxCompare.test.ts` | `sameXPathText` over pairs for rows L1 to L6 of part 08's 3.2, and pairs that differ in an operator, a name, a string or the order of operands | two texts of one tree read as different; two trees read as one |
| `reader/__tests__/hqInterpolation.test.ts`, with `reader/__tests__/interpolationVectors.ts` | part 08's, its 6.1: the port of HQ's interpolation over its vectors | the failures part 08's "Tests" names for it |
| `reader/__tests__/provisional.test.ts` | `provisionalDocument` over drafts holding a refused question that another question's `relevant` reads, a mirror menu, and a form with a refused control; two calls with no draft write between, and two with one; every stage function of `STAGES` run over drafts a test proxy watches. The case "`bindExpressions` with a hand-written `ExpressionReading`" is B6's, added with the function | a provisional document the schema refuses; a stand-in in a returned document; a document that is not frozen, or a new object where no draft changed, or the same object after one did; a draft written outside `ctx.writeDraft` |
| `reader/__tests__/onePass.test.ts` | `readHqApp` over one source that holds a mirror menu, a refused appearance, a default order a save changes and (from B6) an expression the checker refuses | any of the findings missing from the one account, which is the test of one pass (Decision 1) |
| `reader/__tests__/defects.test.ts` | each of B2's defects (D1 to D4, D8, D9) provoked through a test claim table; B3 adds the cases of D5 to D7 and D10, B6 those of D11 and D12. And the closure, one case over every constructor of `readerDefect` (a constructor joins the case in the pull request that adds it): called with a place whose every name, path and tag is a marker string, with each member of each closed argument, with a claim name the registry lacks, an entry id the index lacks and an issue whose path and message hold the marker, it returns exactly its row's template of "Copy" with the closed slots filled | a defect's sentence in `detail.name`, where a person would read it; a defect with no finding; a `why` that holds a marker, which is a word of an app in the log; a `why` built outside a constructor; an unknown claim or entry printed as given |
| `lib/commcare/reader/__tests__/claimsBindManifest.test.ts` | every registered claim against the index | a claim under a renamed or flipped entry (C4 to C6); it is the test a manifest edit in any later pull request trips |
| `reader/__tests__/accounting.test.ts` | `Accounting` over hand-built objects and documents | a used key that passes unclaimed; a default-valued key counted as a use; a held value dropped after `take`; a second claim; `refuseWhole` leaking a nested `unrecognized`; a handed-off node reported as `unrecognized` or missing from `handOffs`; `finding` accepted under a held entry; a list of strings claimed per element; a second `claimEntry` on one node refused under another key, or accepted under the same key; a node `cover` marked reported again at the close; an absent declared key counted as a use |
| `reader/__tests__/placeVectors.test.ts`, with `proof/checks/test_place_vectors.py` | `elementWhere`, `qualifiedName` and the pointer escape against `proof/checks/fixtures/place-vectors.json`, which the Python test holds to `_element_path`, `qualified`, `pointer_token` and, for one vector that is a default `xmlns`, the `/namespace()` place `xform_vocabulary` records | the two sides spelling one place two ways, which would make part 14's parity join miss |
| `reader/__tests__/appShell.test.ts` | `readApplication` over `proof/hq-reads/shell/app-source.json`, `shell/app-source-after-app-settings-save.json`, `hq-built/app-source.json`, `navigation-base/app-source-after-ui-translations-save.json` | an `Application` key HQ's own pages write that the walker leaves unclaimed; a setting accounted under the wrong value class |
| `reader/__tests__/appShellTotality.test.ts` | the same sources with one unknown key planted at the root, in `profile.properties` and in `translations` | an unknown key admitted; the wrong undeclared entry |
| `reader/__tests__/languages.test.ts` | `readLanguages` over a table of code lists | `en` beside `eng` held twice; a macrolanguage code minted to no identity; a code HQ's grammar refuses held; `pt-br`, `zh-hans` and `cmn-hantcn` read without their region or script, since the suffix is lower case |
| `reader/__tests__/structure.test.ts` | `readStructure` over hand-built menus and forms | a mirror menu read key by key into dozens of findings; two forms of one `xmlns` both minted; and, with a report menu and a shadow form in one app, that both findings are in one account |
| `reader/__tests__/generatedTranslationKeys.test.ts` | the classifier over hand-built tables, one case per rule of part 01's 7.1 and the two-key fold | an override of a constant string called inert; one fold applied twice |
| `reader/__tests__/assemble.test.ts` | `assembleDocument` over complete drafts built through the stages' own setters | a document the schema refuses; a `batch` that does not rebuild the document (`applyMutations(emptyBlueprintDoc(appId), batch)` must equal `doc`); a generated translation key reported as `unrecognized` in an account, or postponed out of a clean read; a `batch` whose held placements are not its one trailing `holdPlacements`; a document of content no platform runs whole returned without `no-platform-runs-everything`, alone and beside another finding |
| `reader/__tests__/readerPurity.test.ts` | `readHqApp` twice over one input with fresh resolvers | hidden state; an order that depends on a `Map`'s insertion history |
| `lib/doc/__tests__/declarationChoices.test.ts` | `planDeclarationChoices` over production documents: plain; date-and-time questions alone; a date-and-time question beside a feature Android cannot run; uses neither platform runs; a refused split; each with HQ's setting on and off. And over the fuzz documents: every choice's mutations leave no unavailable use, and `planContentDeclaration`'s declaration is among the choices | a choice the gate would refuse; the split offered where it adds nothing; the proposal ignoring HQ's setting; "Android only" proposed, with Web Apps on in HQ, for an app the split would keep in Web Apps |
| `lib/commcare/hq/__tests__/publishedCaseBlocks.test.ts` | unchanged | the helpers' move changing what it reads |

**B3**

| Test | Boundary | Catches |
|---|---|---|
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
| `reader/xform/__tests__/connect.test.ts` | the four blocks emitted and read; each refusal row by hand; learn and deliver blocks in two forms of one app | a deliver unit beside a task held; an app of both kinds read as `unrecognized` |
| `reader/xform/__tests__/retainedForms.test.ts` | stage 3 over every form of `hq-built/app-source.json`, `navigation-base/app-source.json`, `case-list-inline/app-source.json` and each `navigation-base/app-source-after-*-save.json` | an element or attribute HQ's own pages or builder write that the form reader neither claims nor leaves pending. The test's `PENDING_AFTER_B3` lists what B3 leaves to later stages by design (the logic attributes of 11.1, `setvalue@value`, non-literal outputs, itemset nodesets, instance declarations, the case region, a root node named `case`, `case_references_data.save`, the form keys of 7.4's last row); B4 to B6 each remove their lines, and B6 deletes the constant |
| `reader/xform/__tests__/xmlTotality.test.ts` | each retained form with one unknown attribute planted on one element of each qualified name, and one unknown element under each | an unknown construct admitted in a form |
| `reader/xform/__tests__/vellumSavedSource.test.ts` | R1 | |
| `reader/__tests__/readerScale.scale.test.ts` | R2: by hand on a hosted runner, outside every default project | |
| `reader/__tests__/readerWork.test.ts` | `ReadCensus.work` of one emitted form of 200 questions and one of 400, in three languages, with generated nodes of every purpose | a stage whose work more than doubles when the form does; deterministic, with no clock |
| `reader/xform/__tests__/media.test.ts` | `readMediaForms` and `readMediaMap` over an index that answers `asset`, `no-entry` and `unreadable`: held slots, a hint's and a group label's media, a path differing by language | a path with no file read as `unrecognized`, or claimed held; an unheld slot's missing file left out of `pendingMedia`; a hand-off with no `HandOffRecord` |
| `lib/commcare/__tests__/xmlParseKind.test.ts` | `tryParseXml` over a document type declaration, an XML 1.1 declaration and unclosed markup | a kind told from a message; `xmlParseIssue`'s text changing |

What these do not hold, stated so no one reads more into them: that an expression means what the
source's did (part 08's tests and lane proof 3), that a whole app reads to itself (part 09's fixed point
and proof 6), and that the reader's standings equal the lane's (part 14's parity).

---

## Contracts and docs these changes make false

| File | Sentence today | Replacement | Pull request |
|---|---|---|---|
| `lib/commcare/CLAUDE.md`, opening | "One-way emission boundary: `BlueprintDoc` → CommCare wire formats (XForm XML, `HqApplication` JSON, `.ccz` archive)." | "The CommCare boundary. It emits a `BlueprintDoc` as CommCare's wire formats (XForm XML, `HqApplication` JSON, `.ccz` archive), and, in `reader/`, reads an HQ app back into one. Nothing outside this package speaks the wire vocabulary in either direction." | B2 |
| `lib/commcare/CLAUDE.md`, the opening's last sentence | "A Biome `noRestrictedImports` rule enforces the one-way direction." | "A Biome `noRestrictedImports` rule holds who may import it." | B2 |
| `lib/commcare/CLAUDE.md`, "capture URL node" | "from the caller (`lib/deployment/attachmentTarget.ts`), because the emission boundary is one-way;" | "from the caller (`lib/deployment/attachmentTarget.ts`), because `lib/commcare` imports nothing of the deployment layer;" | B2 |
| `lib/commcare/xform/captureUrlNode.ts`, the header of `AttachmentUrlTarget` | "because `lib/commcare` is a one-way emission boundary: the deployment layer may read the wire package, never the other way round." | "because `lib/commcare` imports nothing of the deployment layer: the deployment layer may read the wire package, never the other way round." | B2 |
| `lib/commcare/xpath/index.ts`, the header comment | "the package's \"one-way emission boundary\" rule is scoped to wire-format emission (XForm XML, HqApplication JSON)," | "the package's import rule (`biome.json`) is scoped to the wire formats (XForm XML, HqApplication JSON)," | B2 |
| `biome.json`, the four messages of the rule on `@/lib/commcare` | each opens "lib/commcare is the one-way CommCare emission boundary." | each opens "lib/commcare is the CommCare boundary, the one package that speaks CommCare's wire vocabulary." B2 changes no line of the file; the sentence lands with part 09's edit of the same four strings | B7 |
| `lib/commcare/CLAUDE.md`, "The surface manifest" | "Server code reads gate entries through `surface/gates.ts`, never `surface.json`, so a server bundle carries the gate entries alone." | "Server code reads the manifest through five modules and nothing else: `surface/gates.ts` (a gate's identity), `surface/schemaDefaults.ts` (a declared property's default, from `surface.json`), `appStringKeys.ts` (HQ's generated app string patterns, from `surface.json`), `surface/inventory.ts` (every inventory entry with its standing, for the reader) and `surface/revision.ts` (the revision of every entry's standing). `inventory.ts` is `server-only`." | B2 |
| `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility" | "Server code reads gate entries through `surface/gates.ts`, never the generated `surface.json`." | "Server code reads gate entries through `surface/gates.ts`." (the five readers are listed under "The surface manifest") | B2 |
| `lib/commcare/CLAUDE.md`, new section "### The reader" after "The surface manifest" | none | "`reader/index.ts::readHqApp` is the one function that turns an HQ app into a document. It is pure and reads only its arguments. Admission is an accounting: every JSON key at a value other than HQ's default and every XML element and attribute must be claimed against a manifest entry (`reader/claims.ts::defineClaims`), the entry's standing decides whether the value is read, dropped or a finding, and whatever is left unclaimed is the circumstance `unrecognized`. A claim is data, held to the manifest by `reader/__tests__/claimsBindManifest.test.ts`, so a manifest edit and the reader cannot drift. A reader stage reads nothing it does not claim. Two uses are handed off instead of claimed, a media path with no file and an itemset over a table the catalog lacks, because project data's rules name their entry; the caller settles each and acceptance holds none is left. The stages run in the order of `reader/index.ts::STAGES`: structure and forms, menus, case management, lists and search, then every expression bound against a provisional document that is built whether or not a finding stands, then the settle passes and assembly. An `unrecognized` finding names a surface key; what the reader itself got wrong is a `ReaderDefect`, logged and never shown." | B2 |
| the same section, second paragraph | none | "A form is read as HQ's form builder reads it (`reader/xform/`): data tree, binds, setvalues, then the control tree, joined by path. A field's kind comes from one table (`xform/kinds.ts`). Text is found by what references it, never by an itext id. A node Nova generates is recognized by rebuilding it with the emitter's own function and comparing parsed trees (`xform/generated.ts`), with the allocator's name as a precondition; an edited or renamed one is the author's Hidden Value. A real attribute and its `vellum:` shadow must expand to one tree. Logic is never read as text here: each attribute is registered as a pending expression the expression reader binds. Two XPath texts are compared in one place, `reader/syntaxCompare.ts::sameXPathText`." | B3 |
| `lib/commcare/CLAUDE.md`, "XForm parse-time oracle + fuzzer", the `xmlParse.ts` paragraph | "DTDs and XML 1.1 declarations are outside Nova's generated resource vocabulary." | the same, followed by "`tryParseXml` names which of the three a failure is (`doctype`, `xml-version`, `malformed`), and no caller reads a message to tell." | B3 |
| `docs/testing.md`, "Performance and verification" | no mention of a scale project | adds "A file named `*.scale.test.ts` belongs to the `scale` Vitest project, which no default run includes. It is a measurement started by hand on a hosted runner (`.github/workflows/reader-scale.yml`) and asserts no time." | B3 |
| `lib/commcare/CLAUDE.md`, "Validation counts keep their evaluation context" | "The name is not reserved: an authored sibling of the same name makes the allocator take the next suffix." | the same, followed by "Each base name comes from `generatedNodes.ts::generatedBaseName`, which the reader's recognizer reads too." | B3 |
| `lib/doc/CLAUDE.md`, the paragraph on `platformDeclaration.ts` | names `planContentDeclaration` as the one planner | adds "`planDeclarationChoices` gives every declaration a document's content runs on, with and without the date-and-time split, and the one to propose; a reading's review offers them." | B2 |
| `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md` | no row | the row of `langs-code-nova-s-language-registry-cannot-name` beside the code-spelling row | B2 |
| `docs/research/2026-09-26-hq-round-trip/inventory/questions.md` | no rows | the rows of the ten entries B3 adds, each beside the row it splits from or sits beside; the two re-cut rows, `question-id-case-registration-script` (8.8) and `an-explicitly-blank-value-in-a-non-default-language-where-the` (12.2); the re-worded cells of the entries B3 edits (8.3, 10.1, 10.4, 12.5); and part 01's 3.5 wording on the question media rows | B3 |
| `docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md` | the form media pair as the research wrote it | part 01's 3.5 wording on the pair | B3 |
| root `CLAUDE.md`, "The mental models", item 3 | "CommCare's wire vocabulary is quarantined behind `lib/commcare`, a one-way emission boundary enforced by a Biome import rule." | "CommCare's wire vocabulary is quarantined behind `lib/commcare`, the one boundary that writes it and, for an app brought in from CommCare HQ, reads it, enforced by a Biome import rule." The clause is false from B2 and is rewritten with the root file's other stack B sentences (part 15, section 6.2). The next sentence, "The SA and the builder never speak CommCare.", is unchanged | B14 |
| root `CLAUDE.md`, "The map", `lib/commcare` | "`BlueprintDoc` → wire (XForm XML, HQ JSON, suite.xml, `.ccz`), the validator and its parse-time oracles" | "`BlueprintDoc` → wire (XForm XML, HQ JSON, suite.xml, `.ccz`) and, in `reader/`, an HQ app back to a `BlueprintDoc`; the validator and its parse-time oracles" | B14 |
| the same bullet | "This is the compile / export / HQ-upload path; the barrel is client-safe and consumers are allowlisted in `biome.json`." | "This is the compile / export / HQ-upload path and the path an app is brought in through; the barrel is client-safe, the reader sits outside it, and consumers are allowlisted in `biome.json`." (part 15, section 6.2) | B14 |

The outline this plan replaces is removed by the plan's own pull request, before either stack, so
no pull request of B2 or B3 touches it. Nothing public changes in B2 or B3: no page of
`content/docs/` describes what no person can reach yet.

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
   outline, and why", item 16) lists every concept that comes into step 6, and this is not among them.
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
   facts later parts read, the census, the claim log with its hand-offs and its own defects, and
   findings only where there is no draft. Evidence: part 09's gate and fixed point take a document
   (16.1 says why the reader does not run the gate itself); part 12 stores the census and logs the
   defects; part 14's judge takes the log. One call builds them all from one walk. Not done: a
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
8. **The classifier of part 01's 7.1 takes the app strings as an input of the reader.** The classifier
   lands in B2 as part 01 writes it and takes the strings of the document without its generated keys
   (part 01's `D0`) through `ReaderInput.appStrings`; the production function lands in B7 (17.5; part
   01's "What this part needs of other parts" says the same). Not done: the reader taking those strings
   from the production emitter in B2. Evidence: the strings exist only as locals of
   `compiler.ts::compileCcz`, whose inputs (a target, a media manifest, lookup naming) a reading first
   has at acceptance. Until B7 no production `appStrings` exists; the reader claims generated keys from
   B2 through its input, which B2's tests supply by hand, and nothing calls the reader in production
   before B10.
9. **Beyond the manifest as `main` holds it: eleven manifest entries and two re-cuts** (one entry in B2,
   ten in B3). The first re-cut is `questions/question-id-case-registration-script`, HELD to HELD-NEW
   (8.8): Nova's question id rule refuses the three names, so the entry said held of something no
   document can hold. The second is
   `questions/an-explicitly-blank-value-in-a-non-default-language-where-the`, REFUSED to HELD (12.2),
   which part 09's Departure 21 argues: Nova's first publish fills such a blank from the first language,
   as the form builder does on save, and declares it. Each of the eleven new entries is a shape HQ can
   hold that Nova's gate would refuse or Nova's emitter would change, which no entry named, found by
   reading the emitter and the gate against the reader's rows:
   `application-and-settings/langs-code-nova-s-language-registry-cannot-name` (B2);
   `questions/data-root-element-named-other-than-data`,
   `questions/itemset-over-casedb-in-nova-s-case-choices-shape` (HELD: Nova writes it today),
   `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule`,
   `questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes`,
   `questions/hidden-value-bound-a-type-nova-would-not-write`,
   `questions/a-text-whose-languages-show-different-values`,
   `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text` (the half of the
   blank row that stays refused, since one entry has one disposition),
   `questions/connect-deliver-unit-and-task-in-one-form`,
   `questions/connect-learn-and-deliver-blocks-in-one-app` (B3); and part 03's
   `questions/a-markdown-form-in-a-form-whose-text-formatting-is-off`, which B3 lands. The rule of the
   bar is why: the reader admits exactly what the gate admits, so each of these is a finding with a place
   and a sentence, never a gate refusal a person meets after the review.
10. **One circumstance this part adds to part 01's list**, `no-platform-runs-everything`
    (Departure 2), which part 01 holds (its 8.3 and 9.3), with `detail.reason: "split-refused"`
    for its second next step.
11. **The limits of one pass.** The reader reports every finding in one pass (Decision 1; the
    top-level file `../6-bring-in.md`, "The experience in brief", "Every finding in one pass"). It
    reports everything the reader can decide from the source, structure and expressions together, because
    stage 7 builds a provisional document and binds every expression in every reading (2.3). Three
    things are outside it, each for a stated reason, and the cursor and the tests hold that nothing
    else is:
    - **A generated key in `translations`, in a reading that holds another finding** (16.5). Part
      01's 7.1 classifies such a key against the app strings of the document Nova would write, and a
      reading with a finding has no such document. Calling every such key `not-yet` would report
      overrides Nova reads exactly, and calling it `unrecognized` would blame Nova. Nothing can be
      postponed out of a clean read (4.3).
    - **What stands under a thing that got no draft.** A mirror menu, a shadow form, and a question
      whose kind or id is refused are one finding each, and their keys, their expressions and their
      platform uses are covered by it: there is no slot to bind an expression in and no owner to
      count a use against. The person changes that thing first either way.
    - **A check whose inputs another finding withheld.** A Hidden Value's bind type is compared only
      where its calculate was held and the form's case writes were read (11.4); a model-iteration
      verdict and a load-order conflict only over expressions that bound. Each skipped check is at a
      question or a form that already carries the finding that withheld it.

    Part 01 gains one line for the account so a person is not told a list is complete when it may
    not be ("What this part needs of other parts").
12. **No document migration, no flag, no rollout.** B2 and B3 add no stored key. `planDeclarationChoices`
    is a new function beside `planContentDeclaration`, which keeps its callers.
13. **Two uses are handed off, neither claimed nor a finding.** Anything else left unclaimed is a finding
    (4.1). These two are neither when the reader returns: a media path with no file, and an itemset over
    a table the catalog lacks. They are handed off (4.3). Evidence: which entry each stands under is
    decided by the platforms the app runs on, by what each runtime draws for the slot and by HQ's table
    list, rules part 11 owns in `lib/deployment/reading/projectData/`, where `lib/commcare` cannot reach
    them. Not done: leaving the two unclaimed, because every app with a path missing from its media map
    would then read to `unrecognized`, blamed on Nova, where part 11's rule (its 3.2) makes such a
    reference inert and listed. Not done: moving part 11's classifier into the reader, because its inputs
    (the map's entries, the file verdicts of a later step, the declaration a person has not chosen yet)
    are the reading's, and it runs again after the media step with no new read of the source. The
    property is kept by other means: a hand-off is a typed record with its node, only those two kinds
    exist, the caller settles each in the same pure check, and acceptance check 1 refuses a reading with
    one left over.
14. **The stage order, made exact.** The reader's order is structure, case management, menus, then
    expressions (2.3), with a menu read in two places. A menu's own shape (case type, kind, nesting) is
    read before case management, and what a menu holds that needs bound expressions is settled after them
    (2.3). Evidence: part 07's 2.1, which shows a form's type and its placements cannot be read without
    its menu's case type and kind, and that a link's held-case guards can only be checked over bound
    trees. Not done: one menus stage between case management and expressions, for those two reasons.
15. **B2 and B3 land three things part 08 specifies.** B2 lands `reader/syntaxCompare.ts` (part
    08's 3.1) with the form rows, and B3 lands `shadowAgrees` and `literalOutputText` in
    `reader/xform/` (part 08's 10.1 and 10.2 say the same). Not done: landing the three in B6 with
    the expression reader. Evidence: B3 compares generated nodes, shadows and literal outputs
    three pull requests before B6 exists, and a second `shadowAgrees` with another prefix rule would
    raise `shadow-disagrees` twice for one attribute and differently.
16. **One reader for `case_references_data.save`, and one for Connect blocks.** `save` is part 07's (8.7)
    and Connect blocks are this part's (15). Not done: either part reading both, because two readers of
    one node are a second claim on it. One reader per node is the frame's rule (4.3).

**The outline's items that touch this part, each settled.**

| Outline item | Where it is settled |
|---|---|
| 1, the reader reads source and forms into one batch or refuses with the place and reason | sections 2 to 16; identity is part 10's; the UI-catalog keys are kept (part 01); no `Form.xmlns` slot (part 10) |
| 5, the platform declaration confirmed before the app exists | 16.3: choices with a proposal, applied at the birth; the surfaces are part 13's |
| 8, output expressions and `instance(…)` text in prose | part 03 (A7) for the concept; 12.3 for the reading |
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

## Files by pull request

**B2: the reader's frame**

| File | Change |
|---|---|
| `lib/commcare/xmlNamespaces.ts` | new: the namespace helpers moved from `hq/publishedCaseBlocks.ts` and renamed (2.1), `JAVAROSA_NS`, `OPENROSA_NS` and `qualifiedName` |
| `lib/commcare/hq/publishedCaseBlocks.ts`, `lib/commcare/xform/deviceForm.ts` | import the helpers and `VELLUM_NS`; no behavior change |
| `lib/commcare/surface/inventory.ts` | new (3) |
| `lib/commcare/surface/revision.ts` | new: `surfaceStandingsRevision` (part 12, 3.9) |
| `lib/commcare/reader/index.ts`, `types.ts`, `context.ts` | new (2) |
| `lib/commcare/reader/pendingExpressions.ts` | new: part 08's 2.5 shape, and `PendingRegistry` (11.1) |
| `lib/commcare/reader/syntaxCompare.ts` | new: part 08's 3.1, with rows L1 to L6 |
| `lib/commcare/reader/hqInterpolation.ts`, `lib/commcare/reader/__tests__/hqInterpolation.test.ts`, `lib/commcare/reader/__tests__/interpolationVectors.ts` | new: part 08's, its 6.1 |
| `lib/commcare/reader/provisional.ts` | new: `provisionalDocument` (2.3) |
| `lib/commcare/reader/identity.ts` | new: part 10's sections 2.1 to 2.3 |
| `lib/commcare/reader/claims.ts`, `accounting.ts`, `jsonCursor.ts`, `xmlCursor.ts`, `place.ts`, `defects.ts` | new (4, 5) |
| `lib/commcare/reader/appShell.ts`, `languages.ts`, `structure.ts`, `translations.ts` | new (6, 7, 12.5's sink) |
| `lib/commcare/reader/generatedTranslationKeys.ts`, `assemble.ts` | new (16) |
| `lib/doc/platformDeclaration.ts` | `planDeclarationChoices`, `DeclarationChoice`, `DeclarationChoices` |
| `lib/commcare/xform/captureUrlNode.ts`, `lib/commcare/xpath/index.ts` | a comment each: the two "one-way emission boundary" rows of "Contracts"; no code changes |
| `lib/commcare/surface/entries/application-and-settings.json` | part 01's three generated-key entries and its re-wording (its files of B2); the new language entry and the re-worded one beside it (6.3) |
| `lib/publish/hqFindings.ts` | part 01's B2 lines (its "Files by pull request", B2): `translation-overrides` in `SUBJECTS`; `no-platform-runs-everything` in `READ_CIRCUMSTANCES` and `CIRCUMSTANCE_STANDINGS` (its 8.3) |
| `lib/publish/hqFindingCopy.ts` | part 01's B2 lines: the label and sentence of `translation-overrides`; the block of `no-platform-runs-everything` with its second next step (its 9.3); `circumstanceNext` (its 8.4); `ACCOUNT_CHECK_AGAIN_LINE` (its 9.1); and C1 |
| `lib/publish/__tests__/hqFindingCopy.test.ts` | part 01's "From B2" cases |
| `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md` | the rows of those entries |
| `proof/checks/fixtures/place-vectors.json`, `proof/checks/test_place_vectors.py` | new: the shared place vectors |
| the tests of "Tests", B2 | new, `lib/commcare/surface/__tests__/revision.test.ts` with the revision's cases of part 12's 3.9 among them; `reader/__tests__/identity.test.ts` is part 10's |
| `lib/commcare/CLAUDE.md`, `lib/doc/CLAUDE.md` | "Contracts", B2 rows |

**B3: the reader, forms**

| File | Change |
|---|---|
| `lib/commcare/reader/xform/*.ts` | new, the twenty files of 8.1 |
| `lib/commcare/reader/index.ts` | `STAGES` gains stages 3, 5b, 9 and 10 |
| `lib/commcare/reader/defects.ts` | the codes and constructors of D5 to D7 and D10 (5.1) |
| `lib/commcare/reader/__tests__/defects.test.ts` | the cases of D5 to D7 and D10, their four constructors joined to the closure case |
| `lib/commcare/xform/generatedNodes.ts` | `generatedBaseName`, called by the allocator |
| `lib/commcare/xform/consumerWhitespace.ts` | new: `isConsumerWhitespace`, moved from `builder.ts` |
| `lib/commcare/xform/builder.ts` | exports the builders 2.1 names and imports `isConsumerWhitespace`; no emitted byte changes, which the existing expander and oracle suites hold |
| `lib/commcare/xmlParse.ts` | `XmlParseFailureKind`, `XmlParseError`, the `kind` of `tryParseXml`'s failure arm (8.2) |
| `vitest.config.mts`, `.github/workflows/reader-scale.yml` | the `scale` project and its hand-started workflow (R2) |
| `docs/testing.md` | "Contracts", B3 row |
| `lib/commcare/surface/entries/questions.json` | the ten new entries, the two re-cuts (`question-id-case-registration-script`, 8.8; `an-explicitly-blank-value-in-a-non-default-language-where-the`, 12.2) and the re-worded ones (8.3, 10.1, 10.4, 12.5), by the manifest edits of 8.8, 10.1, 10.4, 11.3, 11.4, 12.2, 12.5 and 15; part 01's 3.5 wording on `label-or-option-media-differing-by-language` and its held sibling |
| `lib/commcare/surface/entries/forms-and-case-writes.json` | part 01's 3.5 wording on the form media pair |
| `lib/commcare/surface/entries/gates.json` | `toggle/COMMCARE_CONNECT`'s `contentEntries` gains the two Connect entries |
| `lib/publish/hqFindingCopy.ts` | C2, C2b, and C2c in place of A2's `repeats` sentence |
| `docs/research/2026-09-26-hq-round-trip/inventory/questions.md`, `forms-and-case-writes.md` | the rows |
| the tests of "Tests", B3 | new |
| `lib/commcare/CLAUDE.md` | "Contracts", B3 rows |

**Later pull requests, this part's lines.** Each edit below is to a file B2 or B3 creates, lands in
the pull request named, and is written in this part at the section cited. The part named beside the
pull request lists the file too.

**B4 and B5 (part 07's pull requests)**

| File | Change |
|---|---|
| `lib/commcare/reader/index.ts` | `STAGES` gains part 07's functions of stages 4, 5, 6 and 8, less `settleSearches` (2.3) |
| `lib/commcare/reader/types.ts` | B4: `ReadFacts.sameStateRewrites` and `entryFactsRefused` (17.3) |
| `lib/commcare/reader/context.ts` | B4: `DraftForm.operationIdPaths` (2.3) |
| `lib/commcare/reader/assemble.ts` | part 07's rows of `READER_CANONICAL_CHOICES`: three in B4, two in B5 (16.2) |
| `lib/commcare/reader/xform/__tests__/retainedForms.test.ts` | each removes its lines of `PENDING_AFTER_B3` |

**B6 (part 08's pull request)**

| File | Change |
|---|---|
| `lib/commcare/reader/provisional.ts` | `bindExpressions` (2.3, 11.1), which takes stage 7's entry in `STAGES` |
| `lib/commcare/reader/index.ts` | `STAGES`: stage 7's entry is `bindExpressions`; stage 8 gains `settleSearches` (2.3) |
| `lib/commcare/reader/types.ts` | `ReaderInput.recordDialect` (2.2); `ReadFacts.rewrites`, `declaredProperties` and `expressionRounds` (17.3) |
| `lib/commcare/reader/xform/index.ts` | `expressionEnvOf` (17.2) |
| `lib/commcare/reader/worldEntities.ts`, `lib/commcare/reader/__tests__/worldEntities.test.ts` | new: part 11's `worldEntitiesFromReads` (its 11.5) |
| `lib/commcare/reader/syntaxCompare.ts` | part 08's record rows S1 and S2 |
| `lib/commcare/reader/defects.ts` | the constructors of D11 and D12, `expressionNotWrittenBack` and `noCaseDatum` (5.1) |
| `lib/commcare/reader/__tests__/provisional.test.ts`, `defects.test.ts`, `onePass.test.ts` | the `bindExpressions` case; the cases of D11 and D12; the expression the checker refuses |
| `lib/commcare/reader/xform/__tests__/retainedForms.test.ts` | `PENDING_AFTER_B3` is deleted |

**B8 (part 01's lines)**

| File | Change |
|---|---|
| `lib/commcare/reader/appShell.ts`, `lib/commcare/reader/__tests__/appShell.test.ts` | the application walker's second claim for a language's display name becomes `account` (6.5), since part 01 flips that entry to kept in B8 (its 7.2), with its case in the test |

**B9 (part 11's pull request)**

| File | Change |
|---|---|
| `lib/commcare/reader/worldEntities.ts`, `lib/commcare/reader/__tests__/worldEntities.test.ts` | part 11's `levelsFromHq` (its 11.2), with its cases |
| `lib/commcare/reader/structure.ts`, `lib/commcare/reader/__tests__/structure.test.ts` | `readStructure` puts `levelsFromHq(input.organization.levels, ctx.resolver).levels` on the draft and raises none of its findings (2.3); the case holds both |

---

## What this part needs of other parts

Each paragraph states the seam as the part named writes it, by section; part 15's is what this part
hands the stack. Nothing here is asked of a part that no section of that part names.

**Part 01 (`01-the-bar-and-the-manifest.md`; A2, A3, and the manifest and copy lines of B2).** It
holds what this part worded, each landing in B2 through this part's file list:

| What | Where part 01 holds it |
|---|---|
| the circumstance `no-platform-runs-everything`: `fix-in-hq`, no owner, `name` the feature's label and the platform that cannot run it, `reason` `split-refused` at a date and time question whose split is refused | its section 8.3 |
| the circumstance's block, with its second next step | its section 9.3 |
| `circumstanceNext(finding)`, which chooses between the two next steps | its section 8.4 |
| `ACCOUNT_CHECK_AGAIN_LINE`, "When these are changed, Nova will check the app again and may find more to name.", which Departure 11 needs | its section 9.1 |
| the `not-yet` sentences C1, C2 and C2b for `language-codes`, `form-source` and `question-ids`, and C2c, the re-worded `not-yet` sentence of `repeats` | its section 9.2, second table |

Its Appendix A takes this part's eleven entries and two re-cuts at B2 and B3 (A.1 and A.2). Its 8.3
row for `unrecognized` stands as written (`name`: the surface key), and this part meets it
everywhere (5.1). `SUBJECTS` holds every subject used here. Its B8 lines change the application
walker's claim for a language's display name ("Files by pull request", B8; 6.5). Nothing is left to
ask of it.

**Part 03 (`03-questions-and-text.md`; A6 to A8).** `xform/appearance.ts::FIELD_DISPLAY_SETTING_TOKENS`,
the token table of `fieldAppearance`, exported for the reader to read backwards (its 2.3; 9.2 here);
`canonicalProseAtom`; `labelShowsAsTyped`, `helpShowsAsTyped`; the entries
`help-text-with-no-markdown-form` and `hint-markdown-form`; a prose `value` part and `ProseSlotRef`
as a `SlotContextRef`; and the entry its section 10 writes, which B3 lands (12.2). Its hand-off to
B3 is met in 9.1, 9.2, 12.2 and 12.3.

**Part 04 (`04-names.md`; A9).** The grammars of its "What other parts read" and the entries N6 and N15
to N23, which this part claims. It leaves `RESERVED_QUESTION_IDS` as it is, which 8.8's re-cut rests on.

**Part 05 (`05-reading-commcare-hq.md`; B1).** `HqAppSource.raw` holds the stored document less the keys
the view strips; each `HqAppSourceForm.attachment` is the form's source text; `cloudcareEnabled`;
`HqAlignedModule` in the source's order and length. Its sections 7 and 8.3 admit, under
`admit: "any"`, a menu whose `unique_id` is absent, null or the empty string, with `uniqueId: null`
and aligned by position; a `unique_id` of any other type stays `malformed`. The reader then raises
`menus-and-case-lists/module-unique-id-missing` at that menu (7.2), whose next step (open App
Preview once in CommCare HQ) is the one that fixes it, where on `main` the person would meet the
unreadable-answer stop. `ReaderOrganization.levels` holds
`lib/commcare/hq/locations.ts::HqLocationType`, which is on `main`; its 10.4 reuses that file's
readers.

**Part 07 (`07-the-reader-cases-menus-lists.md`; B4, B5).** It speaks this part's frame, by the
names that close 2.3 (its 2.1 and 2.2):

- **Stages.** Its ten functions run as stages 4, 5, 6 and 8 of 2.3, the order its own 2.1 gives:
  `readMenus`, `readCaseManagement`, `readCaseLists`, `readSearches`, `compareEntryFacts`,
  `registerLinkExpressions` and the four settle functions. `settleSearches` and the search row code
  it calls land in B6, with part 08's files they name (2.3).
- **The API.** Declared claims (`defineClaims`) used through `JsonCursor` and `XmlCursor`;
  `ctx.accounting.finding(claim, place, detail?)` for a finding outside a node;
  `ctx.pending.register(expression, at)` with part 08's `PendingExpression`, a settle function
  reading `ctx.pending.outcome(i)` (11.1); `provisionalDocument(ctx)` before stage 7 and `ctx.doc`
  after; every write to a draft inside `ctx.writeDraft(() => { … })`; `DraftApp`, `DraftModule` and
  `DraftForm`; `ctx.translations`; `ctx.facts.pendingMedia`; and `readNavMedia` reading each map
  through `readMediaMap` (12.4).
- **What it claims.** Every menu key of 7.3's last row, every form key of 7.4's last row,
  `case_references_data.save` (8.7; its 5.3) and `profile.custom_properties` (6.6), and no key of
  the other rows: those are claimed in B2, and it reads their result from `ctx.draft`.
- **Generated nodes.** Candidates carry the emitter's purpose names (`url`, `datetime`, `trimmed`,
  `owner`). The join of a date and a time question is no purpose: it is an ordinary Hidden Value
  (16.4), and part 07 types the property it writes `datetime`. Case-region nodes carry `container`;
  every Save to Case element is a `ReadSaveToCaseBlock` (8.6, 13.3; its section 5). It settles
  candidates in stage 5, before `mintFields`, and reads everything in `caseRegion`.
- **Connect.** It builds no Connect reader and claims no Connect entry (its 10.2; 15 here). It
  reads `ReadXForm.connectBlocks` and the draft's `connect` for its rows that turn on
  `connectType`, and `buildConnectBlocks` is exported by B3 (2.1).
- **Root nodes.** It claims a root node named `case` whole, and raises the `commcare_usercase`
  refusal with `ctx.accounting.finding` (17.1).
- **Slots.** It sets `Form.type` and every other slot of a draft menu and form it reads before
  stage 7; it lists a folded hidden menu in the identities under `syntheticModuleUuid(formUuid)`
  (its 8.7; part 10, 3.1).
- **Load order.** It judges a value HQ's build appends with its own `laterLoadReaders`, in
  `settlePreloads` (its 3.7). This part's `loadOrderConflicts` judges the form's own setvalues
  (11.3), and neither calls the other.
- **Canonical choices.** It adds five rows to `READER_CANONICAL_CHOICES`, each `{ id, kind, apply }`
  (16.2): in B4 `registration-form-last` (its 8.7), `create-name-required-is-absent` (its section 3)
  and `default-post-submit-is-absent` (its 9.1); in B5 `dormant-tile-cells` (its 11.5) and
  `case-catalog-is-as-read` (its section 7). For the second, a required condition on a question
  that names a created case is read as none, and the bind's own `required` is claimed under the
  INERT entry it adds in B4, `questions/bind-required-on-the-question-that-names-a-created-case`
  (its section 14): HQ's build writes `required="true()"` on that bind whatever the source holds
  (`xform.py::XFormCaseBlock.add_create_block`), and so does `builder.ts::buildFieldParts`.
- **Facts.** It adds `sameStateRewrites` and `entryFactsRefused` to `ReadFacts` in B4 (17.3), and
  `operationIdPaths` to `DraftForm` (2.3; its 5.2). It keeps no machine reason beside a finding: no
  part reads one (its 13.1).
- **Three seams its sections name.** `caseSaveReferencesOf(model, dataRoot)`, split from
  `caseSaveReferences` in B4 (8.7), over the two elements this part's `ParsedXForm` holds: its 5.3
  writes the split and lists the file. The scalar check recorded on a draft field (13.2,
  `DraftField.scalarCheck`), which its `settleCaseManagement` holds to `caseScalarTextGuards` of
  the bound document (its 3.5). And its read functions write `DraftModule.module` and
  `DraftForm.form` only inside `ctx.writeDraft(() => { … })` (2.3; its 2.2).

**Part 08 (`08-the-reader-expressions.md`; B6).** Its record and its entry point stand, and its
"What this part needs", Part 06, states the same seam:

- **Stands.** `ReadMode`, `PendingExpression`, `pendingPlaceholder` (its 2.5), which B2 carries in
  `reader/pendingExpressions.ts`; `readExpressions(doc, pending, env)` and `ExpressionReading`, which
  stage 7 calls and applies (2.3). It binds every registration and answers one slot claim each, in
  registration order, with the checker's reason in `detail.reason` where it refuses.
- **Carried by B2.** Its three files: `reader/pendingExpressions.ts`; `reader/syntaxCompare.ts`
  (`sameXPathText`, `sameSyntax`, `firstDifference`, `CompareOptions`) with rows L1 to L6 (its 3.1
  and 3.2); and `reader/hqInterpolation.ts` with its test and vectors (its 6.1), which holds
  `syntaxOf`, `dotInterpolate` and `hqInterpolationSlot`. B6 adds rows S1 and S2 to
  `syntaxCompare.ts` and nothing else to the three, and its `reader/expressions/syntaxCompare.ts` is
  not made.
- **This part's, in B3.** `literalOutputText` (`reader/xform/prose.ts`) and `shadowAgrees`
  (`reader/xform/shadow.ts`); its 10.1 and 10.2 say the same. `ExpressionReading`'s circumstances
  never hold `shadow-disagrees`, a `PendingExpression` has no `shadow` member, and `env` holds no
  `hashtags`.
- **Lands in B6, in its file list.** `provisional.ts::bindExpressions` (2.3);
  `xform/index.ts::expressionEnvOf` (17.2); `ReaderInput.recordDialect`, typed by its
  `RecordDialectJudge`; `ReadFacts.rewrites`, `declaredProperties` and `expressionRounds`;
  `reader/worldEntities.ts` with part 11's `worldEntitiesFromReads`; and `settleSearches` in
  `STAGES`.
- **Names.** `FormParseScope.sourceProjection` is built from `ReadSourceNames` (17.2), the names
  the source holds (its 3.3).
- **Prose.** It writes the i-th registration under a `ProseSlotRef` into that slot's i-th `value`
  part (17.2; its 10.2).
- **Instances.** It claims each secondary instance declaration (8.3; its 9.3).
- **Canonical choices.** It adds no row (16.2).
- **Claims.** It registers every entry id its tables can answer with
  `defineClaims("expressions", …)`, as `EXPRESSION_CLAIMS` in `expressions/findings.ts` (its 9.2),
  and adds that file's import to `claimsBindManifest.test.ts`, which then holds them (4.3).

**Part 09 (`09-acceptance-and-the-first-publish.md`; B7).**

- **`appStrings`.** It supplies the production `ReaderInput.appStrings`,
  `lib/commcare/appStrings.ts::localAppStringTable`, cut from `compileCcz` (its 15.1; 17.5 here).
- **The re-read.** Its check 3 calls `readHqApp` over Nova's emission with `mintingResolver` (its
  5.2), and with `matchingResolver` over a document a split was applied to (its 5.4; 16.4 here). It
  may pass an empty question summary, which the reader never reads (2.2).
- **Facts it reads.** The two readings' `generated` lists, for the register's generated-node
  entries (13.4); `inertAppearances` in check 4 (its 6.3); `caseRegionPaths` in check 5 (its 7.5);
  `foldedTranslationKeys` and `blankTranslations` in rows 23 and 28 of its register (its 11.2);
  `rewrites` and `sameStateRewrites` in the rows that name them. It reads no bind type from the
  reader (its Departure 6), and 17.3 holds none.
- **Hand-offs.** Its check 1 holds every `HandOffRecord` settled exactly once (its section 3).
- **Declarations.** Its check 2 drops no choice: one failing choice fails the reading (its section
  4; 16.3 here).
- **`canon`.** `lib/commcare/reader/canon.ts::canonDocument` wraps each row of
  `READER_CANONICAL_CHOICES` as `{ id, kind, apply }` (its section 9), and its `canon.test.ts`
  proves each pair prints equal bytes. `blank-translation-is-absent` is its own row (16.2).
- **Scale.** Its run K4 takes the source of run R2 and runs through `reader-scale.yml`.

**Part 10 (`10-identity-and-the-ledger.md`; B8).** `lib/deployment/adoption.ts` imports
`ReadMenuAndFormIdentities` from `@/lib/commcare/reader` and declares none (its 3.1; 2.2 here). The
reader returns the identities on the draft: on a `ReadOutcome` of kind `read`,
`draft.identities: { entries, modules, forms }`. `reader/identity.ts` is its file, carried by B2
(its 2.1 to 2.3).

**Part 11 (`11-project-data.md`; B9).** It builds the reader's three inputs from what the reading
gathered: `ReaderLookupCatalog` (`readerLookupCatalog`, its 5.5), `ReaderOrganization` as
`{ levelCodes, levels }` (its 14.1) and `ReaderMediaIndex` (`readingMediaIndex`, its 14.2). It
authors `reader/worldEntities.ts`: `worldEntitiesFromReads` (its 11.5, B6) and `levelsFromHq` (its
11.2, B9). What it reads here: `facts.mediaReferences` and `facts.pendingMedia` through its
`hqMediaReferencesOf` (its 2.1), with exactly the slot strings of 12.4 (`field_media_bundle`,
`option_media`, `app_logo`, `unheld_itext`, and part 07's menu and list kinds); `facts.unreadTables`
as `{ tag, place }`; and, on an account, `unreadTables` and `readsLocations` (its 14.1,
`projectDataReadsOf`). An unheld slot's media form is listed only where its path has no file: one
with a file is accounted and inert and reaches no list (12.2). Its `HqMediaPlan.claims` and the
findings of `readingProjectDataFindingsFor` settle the hand-offs, each naming the reference or the
tag a `HandOffRecord.subject` holds. It raises the findings of `levelsFromHq`, once, where the app
reads places; the structure stage raises none (2.3).

**Part 12 (`12-the-reading-and-the-birth.md`; B10).** Its 3.3, step 7, calls
`readHqApp({ appId, target, source, modules, resolver, lookup, organization, media, appStrings,
recordDialect })`, with `recordDialect` part 08's `recordDialectRoundTrip`, and reads `draft`. It
logs `ReadOutcome.defects` at error with the reading's id beside each `unrecognized` and never
stores them. `ReadCensus.manifestRevision` is `surfaceStandingsRevision()`, whose file B2 carries
with that one function (3); B10 adds `currentStandingOf` and `isDeclaredSurfaceKey` to the file
(its 3.9). It calls no scan of this part's (17.4). It applies the chosen `DeclarationChoice`'s
mutations at the birth after the batch (its 6.2), records the held placements of the batch's last
mutation (its 6.4), and gives `read-back-differs` where `readHqApp` throws C3 (its 3.3, step 8).
Its run M1 runs through `reader-scale.yml` over run R2's source, and under M1's outcome B it
lowers, in B10, the size `readerScale.scale.test.ts` builds and the ceiling R2 states, by the
ladder part 09's K4 uses (125, 100, 75 forms); the smaller of K4's and M1's is the ceiling.

**Part 13 (`13-the-experience.md`; B11, B12).** It draws the review's declaration control and the
split's offer from part 12's review (its 8.3), whose `runsOnWhy` is `web-apps-off-in-hq` where
`narrowedByHq` is true and `keeps-web-apps` where `keepsWebApps` is. `bring_in_hq_app` takes
`runs_only_on` and `split_datetime`, which together must be one of the review's choices (its
14.4). It shows `ACCOUNT_CHECK_AGAIN_LINE` under the groups of every account (its 7.1).

**Part 14 (`14-proof.md`; A1, B13).** Its parity judge joins on `(artifact, where)` and reads the
claimed entry's keys (its 8.1; 4.5 here), with a default `xmlns` at `/namespace()` and each
hand-off joined to part 11's claim for it before it judges. Parity covers three of the eight
refused appearance classes; the other five rest on one variant each (9.2; its 7.2). Its bundle of
the reader is built with the `react-server` condition (its 5.2). Proof 6 calls part 09's
`canonDocument`, which wraps `READER_CANONICAL_CHOICES` (its 5.5). Its rule
`field-list-appearance-case` proves the spelling rule for `field-list` written in another case
(its section 4; 10.2 here). Of its bases (its 6.2), `hq-questions` holds the held rows of 9.1, a
Question List root, a count repeat over a question and over a Hidden Value and a model-iteration
repeat; `hq-languages` holds shared and renamed itext ids and a label left blank in a second
language; `hq-nova-then-builder` holds forms saved in HQ's form builder after Nova wrote them. Its
variants (its 7.2) hold each of this part's refusals with `expected.json` naming the entry, a menu
with no `unique_id` among them. Runs R1 and R2 are in its 11.2: R1 in B3's own CI, R2 by hand
through `reader-scale.yml`.

**Part 15 (`15-stack-contracts-and-exit.md`; B14, B15).** The root `CLAUDE.md`
bullet of "Contracts", in B14; gated runs R1 and R2, for the stack's checklist.

## What other parts read from this one

| Name | Where | Who reads it |
|---|---|---|
| `readHqApp`, `STAGES`, `ReaderStage`, `ReaderInput` (with `target` and `appStrings`, and from B6 `recordDialect`), `ReaderOptions`, `ReadOutcome` (with `defects`, and on an account `unreadTables` and `readsLocations`), `ReadDraft`, `ReadMenuAndFormIdentities`, `ReadCensus` (with `work`), `ReaderDefect`, `ReadFacts`, `ReadFormFacts`, `ReadGeneratedNode`, `ReadMediaReference`, `PendingMedia`, `UnreadTable`, `ReaderLookupCatalog`, `ReaderLookupTable`, `ReaderOrganization`, `ReaderMediaIndex`, `ReaderMediaResolution`, `AppStringTable` | `lib/commcare/reader/index.ts`, `types.ts` | parts 09, 10, 11, 12, 14 |
| `inventoryIndex`, `InventoryIndex`, `IndexedEntry` | `lib/commcare/surface/inventory.ts` | the reader's parts |
| `surfaceStandingsRevision` | `lib/commcare/surface/revision.ts` (part 12's function, carried by B2) | part 12 |
| `Claim`, `ClaimUse`, `take`, `drop`, `refuse`, `account`, `derived`, `defineClaims`, `claimRegistry` | `reader/claims.ts` | parts 07, 08 |
| `Accounting` (with `finding`, `claimEntry`, `cover`, `defect`), `Admitted`, `ClaimSite`, `JsonCursor`, `XmlCursor`, `XmlNode`, `HandOffKind`, `ClaimRecord`, `HandOffRecord`, `ClaimLog`, `serializeClaimLog`, `elementWhere` | `reader/accounting.ts`, `jsonCursor.ts`, `xmlCursor.ts` | parts 07, 08; part 09 (the hand-offs); part 14 (the log) |
| `ReadContext` (with `writeDraft`), `MutableReadFacts`, `DraftApp`, `DraftModule`, `DraftForm` | `reader/context.ts` | parts 07, 08 |
| `ReadMode`, `PendingExpression`, `pendingPlaceholder` (part 08's, carried by B2), `PendingRegistry` (with `register`'s index and `outcome`) | `reader/pendingExpressions.ts` | parts 07, 08 |
| `sameXPathText`, `sameSyntax`, `firstDifference`, `CompareOptions` (part 08's, carried by B2) | `reader/syntaxCompare.ts` | parts 07, 08 |
| `interpolateHqXPath`, `dotInterpolate`, `syntaxOf`, `hqInterpolationSlot`, `HqInterpolationSlot`, `HqInterpolated`, `HQ_USERCASE_XPATH`, `hqCaseByIdXPath` (part 08's, carried by B2) | `reader/hqInterpolation.ts` | parts 07, 08 |
| `provisionalDocument` (B2), `bindExpressions` (B6, in part 08's file list) | `reader/provisional.ts` | part 07 (the document before stage 7, and what `ctx.doc` is after), part 08 (what calls it) |
| `worldEntitiesFromReads` (B6), `levelsFromHq` (B9), both part 11's | `reader/worldEntities.ts` | this part's stages 2 and 7; parts 08, 11, 12 |
| `appPlace`, `appSettingsPlace`, `languagesPlace`, `menuPlace`, `formPlace`, `questionPlace`, `placeOrder`, `whereText`, `placeKey` | `reader/place.ts` | every reader part |
| `READER_DEFECT_CODES`, `ReaderDefectCode`, `ReaderDefectWhy`, `readerDefect` | `reader/defects.ts` | part 08 (its C9 and C12 are the templates of two constructors), part 10 (the line of an identity key met twice), part 12 (what it logs as `defects`) |
| `TranslationSink`, `translationEntryFor` | `reader/translations.ts` | part 07 |
| `classifyGeneratedTranslationKeys`, `GeneratedKeyVerdict` | `reader/generatedTranslationKeys.ts` | part 09 (through `appStrings`) |
| `assembleDocument`, `READER_CANONICAL_CHOICES`, `ReaderCanonicalChoice` | `reader/assemble.ts` | part 07 (its five rows), part 09 (`canonDocument` wraps each row), part 14 (proof 6, through `canonDocument`) |
| `planDeclarationChoices`, `DeclarationChoice`, `DeclarationChoices` (with `keepsWebApps`) | `lib/doc/platformDeclaration.ts` | parts 09, 12, 13 |
| `ReadXForm` (`parsed`, `nodes`, `roles`, `binds`, `setvalues`, `cursor`, `candidates`, `settle`, `caseRegion`, `saveToCaseBlocks`, `connectBlocks`, `instanceSources`, `sourceNames`, `itext`), `ReadSaveToCaseBlock`, `ReadConnectBlock`, `NodeRole`, `DraftField`, `DataNode`, `BindFacts`, `SetvalueFacts`, `ParsedXForm`, `ReadSourceNames`, `SourceNodeRef`, `mintFields`, and from B6 `expressionEnvOf` | `reader/xform/index.ts`, `model.ts`, `parse.ts` | parts 07, 08 |
| `effectiveLoadOrder`, `loadOrderConflicts`, `LoadStep` | `reader/xform/loadOrder.ts` | this part's stage 10; part 09 names `loadOrderConflicts` among what holds a default's order (its section 8) |
| `GENERATED_RULES`, `sameTree`, `generatedBaseName` | `reader/xform/generated.ts`, `lib/commcare/xform/generatedNodes.ts` | part 07 (the case-region purposes) |
| `shadowAgrees`, `readHashtagMetadata`, `SHADOWED_ATTRIBUTES` | `reader/xform/shadow.ts` | part 08, which writes no shadow comparison of its own |
| `literalOutputText` | `reader/xform/prose.ts` | part 08 |
| `readMediaForms`, `readMediaMap` | `reader/xform/media.ts` | part 07 (menu and list media) |
| `XmlParseFailureKind`, `tryParseXml`'s `kind` | `lib/commcare/xmlParse.ts` | part 07 (a case block it parses) |
| `scopeOf`, `isElement`, `namespacedAttribute`, `elementChildren`, `qualifiedName`, `NamespaceScope` and the namespace constants | `lib/commcare/xmlNamespaces.ts` | part 07 (the extended `publishedCaseBlocks`) |
| the circumstance `no-platform-runs-everything` and its block, with `detail.reason: "split-refused"`; the account line of Departure 11 | worded here, held by part 01 (its 8.3, 8.4, 9.1 and 9.3) | parts 12, 13 |
| eleven manifest entries and two re-cuts. Added in B2: `application-and-settings/langs-code-nova-s-language-registry-cannot-name`. Added in B3: `questions/data-root-element-named-other-than-data`, `questions/itemset-over-casedb-in-nova-s-case-choices-shape`, `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule`, `questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes`, `questions/hidden-value-bound-a-type-nova-would-not-write`, `questions/a-text-whose-languages-show-different-values`, `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text`, `questions/connect-deliver-unit-and-task-in-one-form`, `questions/connect-learn-and-deliver-blocks-in-one-app`, `questions/a-markdown-form-in-a-form-whose-text-formatting-is-off`. Re-cut in B3: `questions/question-id-case-registration-script`, HELD to HELD-NEW; `questions/an-explicitly-blank-value-in-a-non-default-language-where-the`, REFUSED to HELD | the manifest | part 01 (Appendix A), part 09 (the held blank, its Decision 20), part 14 (variants) |
| gated runs R1 and R2; `.github/workflows/reader-scale.yml` and the `scale` Vitest project | this file | part 09 (run K4), part 12 (run M1), part 14 (its 11.2), part 15 (the stack's checklist) |
