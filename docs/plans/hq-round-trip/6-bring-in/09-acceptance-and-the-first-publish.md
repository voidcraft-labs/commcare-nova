# Step 6, part 09: Acceptance and what the first publish changes

Part of the step 6 plan ("Bring in an app from CommCare HQ"). This part plans the pure function that
accepts a reading (`acceptReading`, five checks), the identity record check 4 compares over CommCare
HQ's source and over Nova's emission, the comparison of CommCare HQ's own question summary with the
document, the closed canon list a Nova-born document is read back under, what the register reads of
part 08's rewrite registry, the closed register of what a first publish changes
(`FIRST_PUBLISH_CHANGES`) with every entry and its sentence, how the review and the first publish
receive the entries that apply, what the register gives part 14's lane file
`proof/first-publish-changes.json`, and what a failed acceptance (`read-back-differs`) logs and
says. It also supplies three things other parts call: the production `ReaderInput.appStrings`,
`adoptionExportBoundary` and the read-back comparison `readBackDifferences`.

Citations are `path::symbol`: Nova at `main` `1f103305`, and the Dimagi checkouts at commcare-hq
`d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect
`046c7fd78081`, formplayer `24383ac71bfb` and Vellum `01215f251c57`. Every CommCare fact below was read
at those commits for this part. Other parts are cited as "part NN (file name), section N".

Versions: nothing in this part changes a served tool input, a tool description or the guide, so it
gives the step's one move of `lib/models.ts::MODEL_CONTEXT_VERSION` nothing to carry. Nothing here
changes a byte Nova emits or what an App Test journey replays, so nothing here moves
`lib/db/appTests.ts::RUNTIME_VERSION`.

| Section | Owns |
|---|---|
| 2 | `acceptReading`: where it lives, types, order, what a call judges, cost |
| 3 | check 1, complete accounting |
| 4 | check 2, the gate and export readiness, per declaration |
| 5 | check 3, the fixed point: what "emission of D" is, the re-read, the equality |
| 6 | check 4, identity agreement: `sourceIdentity`, the extended `publishedCaseBlocks`, entry facts |
| 7 | check 5, CommCare HQ's question summary against the document |
| 8 | which check catches which reader bug, and what holds the rest |
| 9 | the canon list for Nova-born documents, and the one read-back comparison |
| 10 | the rewrite registry, and the emitter sites it does not hold |
| 11 | `FIRST_PUBLISH_CHANGES`: the type, every entry, every decision |
| 12 | what the review and the first publish are handed, and where it is kept |
| 13 | what the register gives part 14's `proof/first-publish-changes.json` and its judge |
| 14 | `read-back-differs`: the finding, the signature, the log, the words |
| 15 | the production `appStrings` and `adoptionExportBoundary` |

---

## Decisions in brief

1. **Acceptance is one pure function, `lib/deployment/reading/acceptance.ts::acceptReading`**, of the
   source, the aligned menus, the reader's outcome and the project data. It reads no clock, no store and
   no network, takes and returns plain data, and runs on the request (section 2).
2. **The five checks run in order and the first that fails ends the function.** A later check over a
   document an earlier one refused would report the same defect a second way (section 2.3).
3. **Check 1 is the reader's own close plus two things only acceptance can see**: no `ReaderDefect`, and
   every hand-off settled exactly once by part 11's verdicts (section 3).
4. **Check 2 runs the gate and the export readiness of a first publish over the document under every
   declaration it is handed.** The caller hands it the reader's choices, less those a held file does
   not play on (part 11's one narrowing). A choice it is handed and the gate refuses fails acceptance;
   no choice is dropped inside acceptance. Export readiness is the document's (`exportReadinessFindings`)
   and the publish's own row and mode rules, by the code a publish runs (section 4).
5. **"Emission of D" is `expandDoc` under the reading's own projection inputs, before
   `projectApplicationForTarget`**: the source's menu ids, form ids and `xmlns`, its project space, its
   table names and its media paths. The re-read wraps that output as an `HqAppSource` in which an absent
   declared key reads as HQ's schema default, and which holds the source's own `build_spec`,
   `multimedia_map` and `logo_refs`, the three keys the reader reads that Nova's body never carries
   (section 5.1).
6. **The fixed point is exact: canonical JSON equality of the two documents, with no canonicalization.**
   D is in the reader's image, so nothing may be forgiven (section 5.3).
7. **Check 3 re-reads D, and the split document where a choice holds the split, in every call.** Part
   06's section 16.3 leaves at most one split choice, so a call makes at most two re-reads, and a split
   that does not read back is found before the review offers it (section 5.4).
8. **Check 4 compares a `SourceIdentity` extracted from JSON and XML alone**, by a module that imports no
   reader module: answer leaves with their repeats and Core type class, containers, choice values,
   `xmlns`, ids, case blocks through the extended `publishedCaseBlocks`, and entry facts (section 6).
9. **A generated answer leaf is never an identity difference.** Each side's generated leaves are
   removed by that side's own list (the reading's folded nodes for CommCare HQ's source, the emission
   plan for Nova's), and the difference of the two lists feeds the register. Two things are not cut: a
   generated case block (a guard) is a case block and is compared as one, and an appearance is removed
   from CommCare HQ's side only where the reader accounted it under an inert entry, and never where it
   is one of the four appearances Nova holds (sections 6.3, 11.3).
10. **A form `publishedCaseBlocks` leaves out fails acceptance**, on either side, under its reason. The
    reader's own entries name those shapes to the person; acceptance holds that none slipped past
    (section 6.4).
11. **Check 5 compares CommCare HQ's summary of the source with the document, never with Nova's
    emission**: paths, repeat and group on a row that has a control, choice values, label and
    choice-label text per language, `xmlns` and ids, always-required, and the presence of a display
    condition, a validation and a Hidden Value's calculation. It compares no type: check 4 holds every
    input of CommCare HQ's type lookup. Text is compared only where the source's label holds an itext
    reference, which is the only label CommCare HQ summarizes, and Nova's own case-name check never
    counts as the source's validation (section 7).
12. **A menu CommCare HQ could not summarize is skipped by check 5 and is never Nova's defect.** The
    read raises `menu-unreadable-in-hq` for it before acceptance is called (section 7.5).
13. **The plan says what acceptance cannot hold.** What an expression means, what a list shows and what a
    link does rest on the reader's re-emission comparisons, on lane proof 3 with value expectations, and
    on the both-ways register judge (section 8).
14. **The canon list is a typed registry, `lib/commcare/reader/canon.ts::CANONICALIZATIONS`**, of two
    kinds: two documents with one wire, and content no export carries. Each row has a test that prints
    both documents and requires equal bytes. One function, `lib/deployment/reading/readBack.ts
    ::readBackDifferences`, makes the read-back comparison for `canonReadBack.fuzz.test.ts` and for
    proof 6 (section 9).
15. **A rewrite is a row of part 08's `EMISSION_REWRITES` only where the reader prints without it or
    reports it.** Nine are. Every other place the emitter writes something a source would spell another
    way is decided in section 11.4: read exactly, refused, or declared by a register entry
    (section 10).
16. **`FIRST_PUBLISH_CHANGES` holds 31 entries**, each with its predicate over the reading, the
    stored-source paths it allows and whether it touches workers. Twenty-nine sentences say them
    (section 11).
17. **Per candidate change the decision is one of three**: read the original's behavior exactly, refuse,
    or declare. Section 11.4 gives the decision for every candidate the research, the manifest,
    CommCare HQ's import or another part names, and every one found by reading the emitter.
18. **A date and time question saved straight to a case is refused, not declared.** CommCare stores the
    day alone for it and Nova stores the moment; part 07 raises its finding (section 11.4).
19. **A translation left blank in a language other than the first, where the first language holds
    text, is read as no translation and declared** (`blank-translations-filled`), because Nova writes
    the first language's text there as CommCare HQ's form builder does on every save. A blank in the
    first language where another language holds text stays refused, under part 06's own entry
    (06-the-reader-forms.md, section 12.2) (section 11.4, Departure 17).
20. **The entries that apply are computed per declaration choice, from that choice's own document.**
    Three entries depend on the choice (Web Apps turned off, Web Apps turned on, the date and time
    split), and the generated nodes are planned over the document under the choice, never taken from
    check 3's re-read, so a choice's list is a function of the reading and the choice alone
    (section 12.1).
21. **What a person reviewed is kept on the adopted baseline** (`app_deployment_baselines
    .first_publish_changes`): the entries that do not depend on the declaration, and the Web App setting
    CommCare HQ held. The two Web Apps lines are worked out again from the app's declaration as it
    stands, so an edit to where the app runs never leaves a stale line, and the push that replaces the
    baseline ends the list (section 12.3). Part 15 (15-changes-made-in-commcare-hq.md, section 4.4)
    keeps a second kind of list in the same column: what the next publish changes, after a change
    made in CommCare HQ is brought in or recorded.
22. **The lane's file, its shape, its loader and its both-ways judge are part 14's.** This part gives
    the file its ids and every entry's `source` rows (the stored-app pointers the entry allows), writes
    the file's one Vitest, and asks the judge for one comparison (`source`), so an entry that changes
    only the stored app is observed (section 13).
23. **Every acceptance failure after a clean read is `read-back-differs`, except an unsettled hand-off**,
    which is `unrecognized` as part 06 decided. That holds for every failure of check 1 too (a defect,
    a hand-off settled twice, a settlement no hand-off matches). The finding carries the check; the
    log line carries a content-free signature of at most 80 characters (sections 2.3 and 14).
24. **One renderer words the list for every surface**: `firstPublishLines(view, surface)` gives the
    heading, the lead, the two groups, the reassurance and the note, and the review, the publish
    screen and MCP all draw that one value (section 12.2).
25. **Acceptance has one mode, and it is called once every referenced file is judged.** The caller
    hands it the held files and the choices they left. A read and a create judge the same documents by
    the same checks, and nothing about the person's choice reaches it (sections 2.2 and 2.4).
26. **An app that holds the spelling Nova gave a saved date and time before this step comes in
    whole, and its first publish declares the new one** (`date-and-time-saved-as-hq-stores-it`).
    Part 03 writes such a value as CommCare HQ stores it (03-questions-and-text.md, section 7.1),
    the reader reads both spellings as one write, and a phone then keeps other text for a case it
    saves. A list sorted by a date and time needs no entry: that fix changes no list
    (sections 11.2 and 11.4, Departure 23).
27. **The reader's `appStrings` is `readingAppStrings`, which answers null for a document Nova's gate
    refuses** and the document's local app strings otherwise. Nova's build is total only over a
    document the gate admits, and part 06 hands the function a provisional document wherever a
    finding stands (section 15.1, Departure 24).

---

## Executed during planning

Read, by file and symbol. Nothing was run: no test, no typecheck, no lane.

**Nova, the emitter.** `lib/commcare/xform/builder.ts::buildXFormSource` (the `addItext` closure, the
model's child order, `inDataTreeOrder`), `::buildFieldParts` (the required stamp, `scalarCheck`, the
`url`, `datetime` and `trimmed` siblings, the constraint counts, the protected validation message's
carrier, the default's `setvalue`), `::buildOwnerNodes`, `::inDataTreeOrder`;
`lib/commcare/xform/generatedNodes.ts::GeneratedNodePurpose`, `::GeneratedNodePlan`, the allocator's
header; `lib/commcare/casePlacementPlan.ts::planFormCaseWire` (`questionPath`, `updateMap`, the
`update_case` condition, the subcase shell); `lib/commcare/hqShells.ts::applicationShell`;
`lib/commcare/expander.ts::ExpandOptions`, `::expandDoc`, `::appLevelValues`;
`lib/commcare/compiler.ts::compileCcz` (the `appStrings` and `appStringUnits` locals);
`lib/commcare/surface/schemaDefaults.ts::schemaPropertyDefault`;
`lib/commcare/hq/publishedCaseBlocks.ts` (its exports and readers);
`lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`, `::caseCreateNameFields`,
`::caseScalarTextGuardIsChecked`; `lib/domain/fields/base.ts` (a leaf's `label` is required, a
container's optional); `lib/domain/fields/index.ts::fieldKinds`;
`lib/doc/commitVerdicts.ts::mutationCommitVerdict`, `::exportReadinessFindings`;
`lib/commcare/validator/errors.ts::ValidationError`, `::ValidationLocation`;
`lib/export/boundaryValidation.ts::PreparedExportBoundary`; `lib/commcare/CLAUDE.md` whole.

**Nova, the lane.** `proof/README.md` ("Proofs 1 to 5", "Identity moves"), `proof/CLAUDE.md`,
`proof/checks/identity.py` (the identity records and `DATA_MAPS`), `proof/checks/differences.py` (the
`Difference` vocabulary), `proof/identity-moves.json`, `proof/walk-stops.json`,
`proof/checks/eligibility.py::WITNESS_UNRUN`.

**CommCare HQ.** `corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_module` (the `try`
around a whole menu, `get_questions` called with `include_triggers`, `include_groups`,
`include_translations` and `include_fixtures`); `corehq/apps/app_manager/xform.py::XForm.get_questions`,
`::XForm._get_control_nodes`, `::XForm._get_label_translations`, `::XForm.localize`, `::ItextValue`,
`::VELLUM_TYPES`, `::_index_on_fields`, `::VELLUM_TYPE_INDEX`, `::_infer_vellum_type`,
`::XFormCaseBlock.add_create_block`, `::XForm.add_case_preloads`, `::XForm.add_setvalue`,
`::XForm._create_casexml`; `corehq/apps/app_manager/views/app_import_api.py::import_app_api`;
`corehq/apps/app_manager/models/applications.py::_merge_source_into_app`,
`::overwrite_app_from_source`, `::_update_valid_domains_for_media`;
`corehq/apps/hqmedia/models.py::ApplicationMediaMixin.multimedia_map_for_build`,
`::ApplicationMediaMixin.remove_unused_mappings`; every reader of `created_from_template`
(`app_manager/_design/views/applications_brief/map.js`, `es/apps.py::created_from_template`,
`es/mappings/app_mapping.py`).

**CommCare Core.** `org/javarosa/core/model/condition/Recalculate.java::wrapData`;
`org/javarosa/xform/parse/XFormParser.java::typeMappings`;
`org/javarosa/core/services/locale/Localizer.java` (the fallback to the default locale applies to a
text that is missing).

**The plan.** The outline; parts 01 to 03, 05 to 08 and 10 to 15, the sections this part names.

**Also read at source.** Nova: `lib/export/boundaryValidation.ts::prepareWithRegistry`,
`::collectViolationsWithRegistry`, `::lookupExportFindings`, `::organizationExportFindings`,
`::exportBudgetError`; `lib/commcare/lookup/selectSourceRows.ts::lookupSelectSourceRowFindings`;
`lib/commcare/hqNestedSelection.ts::hqNestedSelectionFindings`;
`lib/commcare/validator/errors.ts::MEDIA_VALIDATION_CODES`;
`lib/commcare/validator/rules/media/mediaFormatPlays.ts::mediaFormatPlays`;
`lib/doc/lookupReferences.ts::LookupValidationContext`; `lib/lookup/types.ts::LookupFixtureDataSnapshot`;
`lib/commcare/lookup/naming.ts::lookupWireNaming`; `lib/domain/expression/context.ts
::LookupDefinitionIndex`; `lib/commcare/hq/appSource.ts::HqAppSource`, `::readHqAppSource`;
`lib/commcare/wireIdentity.ts::WireIdentityOverride`; `lib/commcare/multimedia/assetWirePath.ts
::ResolvedMediaAsset`; `lib/commcare/compiler.ts::CompileOptions`; `lib/commcare/runtimeTarget.ts
::RuntimeTarget`; `lib/commcare/placement.ts::repeatRowPath`; `lib/commcare/xform/generatedNodes.ts
::operationGuardKinds` and the guard blocks of `xform/caseOps.ts`; `lib/commcare/targetLogoRefs.ts
::withoutPathOnlyLogoRefs`; `lib/domain/translationFill.ts::translationFillSource`;
`lib/deployment/store.ts::writeAppBaseline`, `::readAppBaseline`; `lib/deployment/actions.ts
::DeploymentView`, `::readDeploymentsAction`; `lib/deployment/webApps.ts::baselineWebApps`;
`proof/checks/differences.py::CHECKS`; the manifest's seven `update-case-condition-*` entries.
CommCare HQ: `xform.py::XForm.get_questions` (its second loop, `group_contexts` and
`repeat_contexts`), `::XForm._get_label_translations`, `::XForm._get_label_text`;
`models/applications.py::Application._update_excluded_fields`; `hqmedia/models.py
::ApplicationMediaMixin.logo_paths`; `messaging/whatsapputil.py`. Core:
`XFormParser.java::getDataType`, `::applyControlProperties`.

**Verified at source (a leaf's label).** A leaf question has no absent label to collapse with a blank
one: `lib/domain/fields/base.ts` requires `label` on every input kind and makes it optional only on a
container. The one pair is a container's, which part 06 already holds
(`blank-container-label-is-absent`).

**Verified at source (the required stamp).** HQ's build writes `required="true()"` on the bind of the
question a create's name action names, over whatever the source held
(`xform.py::XFormCaseBlock.add_create_block`, its last `add_bind`), so the stamp changes no behavior
for an app CommCare HQ built. Nova writes the same attribute into the source. What changes for a
person is that the form builder shows the question as always required.

**Verified at source (a date and time question saved straight to a case).** For an app made in
CommCare HQ the difference is not a format, so it is no rewrite to declare. HQ's build binds a case
property to the question's path with no `type` (`xform.py::XFormCaseBlock.add_case_updates`), and Core
wraps a calculated `Date` under any type but `dateTime` as the day alone
(`Recalculate.java::wrapData`), so such an app stores a date. Nova stores the moment. Part 07 raises the
finding for the shape, under
`forms-and-case-writes/a-datetime-question-saved-straight-to-a-case` (its section 3.2), and no
register entry declares it (section 11.4).

**Verified at source (the media map's prune).** The prune is not the import's alone.
`remove_unused_mappings` runs wherever `multimedia_map_for_build(remove_unused=True)` is called: the
import (`_update_valid_domains_for_media`), HQ's multimedia views (`hqmedia/views.py`, two callers),
every build's media suite (`suite_xml/generator.py`) and `messaging/whatsapputil.py`. On the working
app the import and the multimedia page are the two that save it. The prune does nothing while a form
of the app fails HQ's own validation (`remove_unused_mappings` returns where
`check_media_state()['has_form_errors']`). At the import it runs after Nova's body is merged
(`overwrite_app_from_source` calls `_update_valid_domains_for_media` after `save_attachments`), so
the forms it validates are Nova's own (`hqmedia/models.py::ApplicationMediaMixin.all_media` sets
`media_form_errors` where `validate_form()` raises for a form of a menu that uses media), which the
bar holds CommCare HQ to accept. So the early return never stops the prune after a first publish,
and `unused-media-entries-removed` is never predicted and unseen for that reason. The prune keeps
every path in `all_media_paths() | logo_paths`. The entry stands (`unused-media-entries-removed`)
with that wording.

**Verified at source (the export rules that need a mode).**
`lib/doc/commitVerdicts.ts::exportReadinessFindings` is `evaluateBoundary` alone. The rule that refuses
a fixed-place owner (`organizationExportFindings`, `LOCATION_OWNER_EXPORT_NOT_ACTIVE`), the
select-source row rules and the nested-selection rule are private to
`lib/export/boundaryValidation.ts` and run only with a mode. Check 2 runs them, by the code a publish
runs (section 4, step 3), which is what makes true part 12's sentence that export readiness refuses
that owner (12-the-reading-and-the-birth.md, section 6.2).

**Verified at source (the export's media budget).** `MEDIA_EXPORT_TOO_LARGE` is made only by
`lib/export/boundaryValidation.ts::exportBudgetError` and its asset-count guard, never by
`exportReadinessFindings`, so check 2 never answers it (section 2.4).

**Verified at source (the gate over a whole document).**
`lib/doc/commitVerdicts.ts::mutationCommitVerdict` with an empty batch validates the candidate as it
stands, by its own contract ("Empty batches still validate the unchanged candidate"), so
`readingAppStrings` asks the gate about a document with no construction batch (section 15.1).
`lib/commcare/compiler.ts::compileCcz` throws where its form, suite or media-suite oracle fails, which
a document the gate admits never does and a provisional one can.

**Verified at source (the generated purposes).** `generatedNodes.ts::GeneratedNodePurpose` has sixteen
members on `main`. Part 03 adds a seventeenth, `instant` (03-questions-and-text.md, section 7.1), and
section 11.3's record is total over all seventeen.

**Verified at source (what CommCare HQ's summary takes from the body).**
`xform.py::XForm._get_control_nodes` gives each control the path of its innermost enclosing
`<repeat>` and `<group>` of the body (`repeat_context`, `group_context`), whatever the data tree
holds. Check 4 reads structure from the data tree. So the two differ exactly where a control stands in
a body group or repeat its data node is not under (section 7.4).

**Verified at source (a child case's index name).** `xform.py::XForm._create_casexml` reads
`subcase.reference_id or 'parent'`, so a child whose stored `reference_id` is `parent` and one whose
is blank build the same index (section 11.4).

**Check 4 takes no type class from the reader.** `ReadFormFacts` holds no bind type (part 06,
06-the-reader-forms.md, section 17.3). A type class the reader reported would agree with the reader's
own mistake; `sourceIdentity` reads each bind from the XML itself (section 6.1, Departure 6).

---

## Written and not yet run

Nothing in this part was run. Three of its checks decide something only execution shows. Each names
where it runs, and its outcomes are written once, in the section that owns the rule. Every outcome
ends in an edit the session makes itself.

| Check | Where it runs | The rule for each outcome |
|---|---|---|
| **The canon list is complete.** `lib/deployment/reading/__tests__/canonReadBack.fuzz.test.ts` over the expression, xform, suite, advanced and names fuzz corpora: `readBackDifferences(canonDocument(D), read(expandDoc(D)))` is empty | the work's own CI, as an ordinary Vitest | section 9: a pair joins the list, a reader defect is corrected, and nothing merges with a failing sample |
| **The register is closed.** Part 14's both-ways judge (14-proof.md, section 9.3) over every HQ-authored base: the predicted first-publish ids are the observed ones | the proof lane on hosted runners, in the dispatches over the bases that the session starts itself (the top-level file lists them), and in every scheduled lane after the merge | section 11.3, "By the lane" |
| **One read back over CommCare HQ's retained answers.** `lib/deployment/reading/__tests__/readBack.retained.test.ts` over the three retained files for `navigation-base` | the work's own CI, as an ordinary Vitest | section 9.1: the case is written where part 05's bracket closes over the three files, and is not written where it does not |

---

## 1. What Nova does today

- **No reader exists.** `lib/commcare` is a one-way emission boundary (`lib/commcare/CLAUDE.md`), and
  nothing reads a CommCare HQ app into a document. There is no acceptance function, no canon list and no
  register of first-publish changes.
- **The gate is absolute and pure.** `lib/doc/commitVerdicts.ts::mutationCommitVerdict(prevDoc,
  mutations, lookupContext)` admits a batch only where the whole candidate has no shape, soundness or
  completeness finding, and `::exportReadinessFindings(doc, lookupContext, mediaAssets)` adds the
  manifest-gated environment rules. Each `ValidationError` carries a `code`, a `scope`, a sentence that
  quotes the app's own words, and a `ValidationLocation` of uuids and names.
- **Emission is `expandDoc`.** `lib/commcare/expander.ts::expandDoc(doc, ExpandOptions)` returns the HQ
  application JSON with every form's source under `_attachments`. `ExpandOptions` holds `runtimeTarget`,
  `identity`, `assets`, `lookupNaming` and `attachmentTarget`. What a publish sends is that output after
  `lib/commcare/targetOverlay.ts::projectApplicationForTarget`, assembled only in
  `lib/deployment/importApplication.ts::hqImportApplication`.
- **Generated nodes have one allocator.** `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`
  names every node Nova adds, by purpose and owner; `GeneratedNodePurpose` has sixteen members.
- **Rewrites are spread through the emitter and nothing lists them.** The required stamp, the trim and
  length check and the trimmed sibling are in `builder.ts::buildFieldParts`; `update_case` is written
  `always`, an external id goes into the update map and a child's index name is written blank in
  `casePlacementPlan.ts::planFormCaseWire`; defaults are ordered by `builder.ts::inDataTreeOrder`;
  `location_fixture_restore`, `cloudcare_enabled` and `auto_gps_capture` are written by
  `hqShells.ts::applicationShell`.
- **`publishedCaseBlocks` reads a source's case blocks for one caller-less purpose.**
  `lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks` returns a map by `xmlns` and silently
  leaves out a form it cannot read (its header: "The reader returns only what it read; the caller counts
  what it left out"). It reads no conditions, close conditions or index identifiers. Part 07
  extends it (its section 6.1).
- **A local archive's app strings are locals.** `lib/commcare/compiler.ts::compileCcz` builds
  `appStrings` and `appStringUnits` while it walks the app and returns only the archive.
- **Proof 1 compares identities HQ reports from a build** (`proof/checks/identity.py`), and accepts a
  difference only where `proof/identity-moves.json` scopes it to a migration witness. No corpus
  document is HQ-authored.
- **CommCare HQ's import has two side effects on the stored app beyond the body.**
  `views/app_import_api.py::import_app_api` passes `{'created_from_template': 'import_app_api'}` as
  extra properties on every import, and `models/applications.py::overwrite_app_from_source` ends in
  `_update_valid_domains_for_media`, whose `get_media_objects(remove_unused=True)` reaches
  `hqmedia/models.py::ApplicationMediaMixin.remove_unused_mappings`: every `multimedia_map` path outside
  `all_media_paths() | logo_paths` is deleted and the app saved, unless a form fails validation.
  `created_from_template` is alive and read by no runtime (the `applications_brief` view and HQ's own
  app analytics read it). The prune is alive.

---

## 2. `acceptReading`

### 2.1 Where it lives

Acceptance and the register live under `lib/deployment/reading/`; the identity record, the canon list
and the app-string table under `lib/commcare`; the ids and the copy a client draws under
`lib/publish`. "Files" lists each file with what it holds.

`lib/deployment/reading/` is an allowed consumer of `lib/commcare` (`biome.json`'s rule leaves out
`lib/deployment/**` today); the reader itself is imported from `@/lib/commcare/reader` as part 06
(06-the-reader-forms.md), section 2.4, admits.
`lib/commcare/hq/sourceIdentity.ts` imports nothing under `lib/commcare/reader`: a test holds it
(`sourceIdentity.independence.test.ts`, Tests), because check 4 is evidence only while it shares no
classification with the reader.

### 2.2 Types

```ts
// lib/deployment/reading/acceptance.ts
import "server-only";

export const ACCEPTANCE_CHECKS =
	["accounting", "gate", "fixed-point", "identity", "summary"] as const;
export type AcceptanceCheck = (typeof ACCEPTANCE_CHECKS)[number];

// `HandOffSettlement` is part 11's, in `lib/deployment/reading/projectData/settlements.ts`,
// beside the function that builds the list. Its shape is fixed here because check 1 reads it:
//   { artifact: string; where: string; key: string; by: "inert-claim" | "finding" }
// `inert-claim`: `HqMediaPlan.claims` holds the hand-off. `finding`: a finding of part 11's names it.

export interface AcceptReadingInput {
	/** The app's id, derived from the reading's id (part 12, section 2.3). */
	readonly appId: string;
	/** The project space the app was read from, as a publish names one. */
	readonly target: DeploymentTargetKey;
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	/** The reader's answer. Acceptance is called only where the reader read clean. */
	readonly outcome: Extract<ReadOutcome, { readonly kind: "read" }>;
	/** Everything of the reader's input but the source, the menus, the app id and the resolver:
	 *  the re-read of check 3 is given exactly these. */
	readonly reader: Pick<ReaderInput,
		| "target" | "lookup" | "organization" | "media" | "appStrings" | "recordDialect"
		| "saveOnlyEditedApplied">;
	/**
	 * The declarations to judge and to offer: part 11's
	 * `narrowDeclarationsByMedia(outcome.draft.declaration, playsOn)`, the draft's less each choice
	 * that declares a platform a held file does not play on, the proposal moved as that function
	 * moves it. The caller ends the reading itself where none is left.
	 */
	readonly choices: Extract<DeclarationChoices, { readonly kind: "choices" }>;
	readonly settlements: readonly HandOffSettlement[];
	/**
	 * The tables the document reads, as the birth will hold them: part 11's
	 * `readingLookupSnapshot`. Its `definitions` are the bound tables under the reading's ids, its
	 * `rowsByTable` their rows in order, its `projectId` and `projectRevision` the Project's as
	 * part 11 read them. Empty where the document reads no table.
	 */
	readonly lookup: LookupFixtureDataSnapshot;
	/** Part 11's plan facts the register reads (section 11.1). */
	readonly mediaLeftOut: number;
	/**
	 * Every referenced file, held and judged before acceptance is called. `rows` is the map
	 * `exportReadinessFindings` takes as its third argument, which part 11's
	 * `projectData/media.ts::readingMediaRows(plan)` gives.
	 */
	readonly media: {
		readonly files: readonly AdoptedMediaFile[];
		readonly rows: Parameters<typeof exportReadinessFindings>[2];
	};
}

export interface AcceptedDeclaration {
	/** Null is Web Apps and Android: part 06's `DeclarationChoice.runsOnlyOn`, undefined as null. */
	readonly runsOnlyOn: Platform | null;
	readonly splitDatetime: boolean;
	readonly preselected: boolean;
	/** The choice's own mutations, which follow the construction batch at the birth. */
	readonly mutations: readonly Mutation[];
	/** What a first publish changes where this choice is made (section 12.1). */
	readonly firstPublish: FirstPublishView;
}

/** Something acceptance found, for a developer and a test. Never stored, never logged. */
export interface AcceptanceDifference {
	readonly check: AcceptanceCheck;
	readonly signature: string;
	readonly place: HqPlace;
	/** What differs, in the app's own words. This string never leaves the process. */
	readonly detail: string;
}

export type AcceptedReading =
	| { readonly ok: true;
	    /** One per choice of `input.choices`, in its order. Part 12's `runsOn` is this list. */
	    readonly declarations: readonly AcceptedDeclaration[];
	    /** The preselected declaration's list: what part 12's `ReadingReview.firstPublish` holds. */
	    readonly firstPublish: FirstPublishView;
	    readonly sourceHoldsSaveToCase: boolean }
	| { readonly ok: false;
	    readonly check: AcceptanceCheck;
	    /** Content-free, at most 80 characters: the first difference's (section 14.2). */
	    readonly signature: string;
	    /** One finding per place, in `placeOrder`; at most 20. */
	    readonly findings: readonly Finding[];
	    readonly differences: readonly AcceptanceDifference[] };

export function acceptReading(input: AcceptReadingInput): AcceptedReading;
```

`FirstPublishView` is `{ readonly ids: readonly FirstPublishChangeId[]; readonly touchesWorkers: boolean;
readonly of: "first-publish" | "next-publish" }` (`lib/publish/firstPublishChangeIds.ts`, section
11.1), ids in registry order. Every list acceptance gives is of kind `first-publish`.

`sourceHoldsSaveToCase` is whether any form of `publishedCaseBlocks(source.raw).forms` holds a block of
kind `save-to-case`, which is what part 10 (10-identity-and-the-ledger.md), section 6.5, asks of the
extended reader for `adoptionPlanFeatureConfirmations`.

### 2.3 Order, and what a failure is

`acceptReading` runs the checks in the order of `ACCEPTANCE_CHECKS`. The first check that finds a
difference ends the function with that check's differences (every one it found, the first twenty kept)
and the failing arm. The findings of a failing arm:

| Check | Findings |
|---|---|
| `accounting`, an unsettled hand-off | one `unrecognized` at the hand-off's place, `detail.name` its `key` (part 06, section 4.3) |
| `accounting`, a `ReaderDefect` in a clean outcome | one `read-back-differs` at the defect's place, `detail.name` `accounting` |
| `accounting`, a hand-off settled twice, or a settlement no hand-off matches (section 3, steps 2 and 3) | one `read-back-differs` at the place section 3 gives the difference, `detail.name` `accounting`: each contradicts the reader's or part 11's own contract, so it is Nova's defect and never a fact of the app |
| `gate`, `fixed-point`, `identity`, `summary` | one `read-back-differs` at each differing place, `detail.name` the check |

Section 14 gives the finding's shape, the signature and the words.

### 2.4 What a call judges

- **Media.** Acceptance is called once every referenced file is held and judged. Check 2 runs whole,
  with `rows` as the media manifest, over the choices the files left (`input.choices`), and the
  register reads `assignMediaPaths` (part 10, section 4.2) over the held files, keyed by content,
  for its media entries (section 12.1). A `MEDIA_FORMAT_NOT_PLAYED` here is a difference like any
  other: the validator holds a file's format to each declared platform
  (`validator/rules/media/mediaFormatPlays.ts::mediaFormatPlays`), part 11's `playsOn` holds the same
  fact, and a choice the narrowing kept and the validator refuses means the two disagree.
- **What it does not judge.** The export's media budget (`MEDIA_EXPORT_TOO_LARGE`) is no finding of
  `exportReadinessFindings`: `lib/export/boundaryValidation.ts` adds it from the files' rows. Part 11
  holds it as its own finding over the same limits (`mediaBudgetFinding`, its section 4.3), before
  acceptance is called.
- **Which documents.** Checks 3 to 5 judge D. Check 3 also judges the split document where a choice
  holds the split (section 5.4). A declaration changes no identity of CommCare HQ's source, so checks
  4 and 5 judge D alone.

A read and a create call it over the same reading, so they judge the same documents by the same
checks, and neither passes it the person's choice. Where a create calls it once more after its files
are published, the input is that same reading with each file named by its published id (part 12,
12-the-reading-and-the-birth.md, section 5.3, step 8). That call changes no choice's first-publish
list: the list reads the files by their content and never by an asset id (section 12.1), so it is
the list the read gave.

### 2.5 Purity and cost

`acceptReading` reads its argument and module constants. It calls `readHqApp` once for D, with a
fresh `mintingResolver(appId)`, and once more for the split document where one is offered, with a
`matchingResolver` (section 5.4). Two calls with equal input give deeply equal output, which
`acceptance.purity.test.ts` holds. It never throws for content: a projection or a gate rule that
throws over the document is a difference of the check that called it, with the function's name in
the signature (`gate/threw/planFormCaseWire`).

It asks the reader for claim counts only (`ReaderOptions.claims` at its default): what check 4 needs of
the claim log reaches it as a fact of the reading (`ReadFormFacts.inertAppearances`, section 6.3), so
no request holds every claim in memory.

Its work: per declaration it is handed (at most three: part 06's section 16.3 drops a split candidate
whose unsplit twin runs), one gate, one export readiness evaluation, one carrier findings pass and
one generated-node plan per form; one `expandDoc` and one reader run for D (which calls `appStrings`,
a compile, as the reading's own run did), and one more of each where a split is offered; two
`sourceIdentity` extractions, two `publishedCaseBlocks` passes and one walk of the summary. It runs
in the serving process, on the request. The bring-in's test at the size cap (part 12, section 3.6)
runs it whole over a source at the cap and holds each synchronous piece under five seconds; a slower
piece is a defect of the reader or of a check, and is fixed there.

---

## 3. Check 1: complete accounting

Complete accounting, with claim consumption, is the first check: it is the bar's clause (d). Part 06
holds both inside the reader: `Accounting.close()` turns every unclaimed key and node, and every
`Admitted` value nothing read, into `unrecognized` (its section 4.4), so an outcome of kind `read`
already means the cursor closed clean. Acceptance adds what the reader cannot see or cannot be trusted
to report.

In order:

1. **No defect.** `outcome.defects` is empty. A defect beside a clean outcome is a contradiction of part
   06's contract (each defect stands behind an `unrecognized` finding), so it is a difference:
   signature `accounting/defect`, place the defect's.
2. **Every hand-off is settled exactly once.** For each `HandOffRecord` of
   `outcome.claims.handOffs`, exactly one `HandOffSettlement` of `input.settlements` has its `artifact`,
   `where` and `key`. None: an `unrecognized` finding (part 06, section 4.3), signature
   `accounting/hand-off-unsettled/<to>`, where `<to>` is the record's `HandOffKind`. Two or more:
   signature `accounting/hand-off-settled-twice/<to>`. The place is the `place` of the `PendingMedia` or
   `UnreadTable` of `outcome.draft.facts` whose path or tag is the record's `subject`, and the app where
   none is.
3. **No settlement without a hand-off.** A settlement no record matches is signature
   `accounting/settlement-unmatched`, place the app: part 11 judged a use the reader never handed it.

Acceptance takes no tally of findings from the outcome. An outcome of kind `read` holds no finding
(part 06, section 2.2), so a count of them by standing could never differ from zero.

What check 1 does not hold: that a claimed and consumed value was stored at the right slot. That is
check 3's and check 5's.

---

## 4. Check 2: the gate and export readiness

The bar's clause (a): D passes the absolute gate and export readiness with no reader-only leniency.
Acceptance runs the production functions and nothing else.

**The lookup context** is the one a publish builds, `{ kind: "available", projectId:
input.lookup.projectId, projectRevision: input.lookup.projectRevision, definitions:
input.lookup.definitions }` (`lib/doc/lookupReferences.ts::LookupValidationContext`, as
`boundaryValidation.ts::availableLookupContext` makes it from a snapshot). It is built from
`input.lookup`, never from `input.reader.lookup.definitions`: that member is a
`LookupDefinitionIndex`, a map of a projection the expression checker reads, and the gate takes the
tables' own definitions.

For each choice `c` of `input.choices.choices` (part 06, section 16.3, as the caller narrowed it), at
index `i`, in order:

1. `verdict = mutationCommitVerdict(emptyBlueprintDoc(appId), [...outcome.draft.batch, ...c.mutations],
   lookupContext)`. `ok: false` is one difference per finding: signature `gate/<code>`, place from the
   finding's location (below).
2. `exportReadinessFindings(verdict.nextDoc, lookupContext, input.media.rows)`. Each finding is a
   difference: signature `gate/export/<code>`.
3. `exportCarrierFindings({ doc: verdict.nextDoc, mode: "hq-upload", fixtureData: input.lookup,
   lookupTarget: input.target })` (below). Each finding is a difference: signature
   `gate/export/<code>`.

   Every signature begins with its check (section 14.2), and export readiness is check 2's, so the
   word `export` is a segment after `gate` and never a check of its own.
4. For a choice that passes, `AcceptedDeclaration` is `{ runsOnlyOn: c.runsOnlyOn ?? null,
   splitDatetime: c.split, preselected: i === input.choices.proposed, mutations: c.mutations,
   firstPublish }`, `firstPublish` from section 12.1 over `verdict.nextDoc`.

One failing choice fails the check, whatever the others do: the declaration is a preselected default
the person may change (part 06, section 16.3; part 13, 13-the-experience.md, section 8.3), so every
choice the review offers must be one the birth can apply. `outcome.draft.doc` itself (no
declaration) is not gated on its own: no app is born without a choice's mutations.

**Which choices.** Acceptance drops none. The one narrowing a correct reading needs is by the files:
a file CommCare HQ holds can play on Android and not in Web Apps, and such an app comes in as Android
only. That narrowing is part 11's (`narrowDeclarationsByMedia`, over `readingMediaFindings().playsOn`),
it happens before acceptance, and `input.choices` is its answer. So check 2 never fails a reading for
a choice the review would not have offered, the `preselected` choice is the one the review preselects
(the draft's proposal where it remains, else the first that remains in part 06's order, which is
where `narrowDeclarationsByMedia` puts `proposed`), and part 12's `runsOn` is
`AcceptedReading.declarations` with nothing filtered a second time (part 12, section 5.1).

**`exportCarrierFindings`**, the row and mode rules of a publish. `exportReadinessFindings` is the
document's verdict; a publish adds three verdicts that need a mode, and `prepareWithRegistry` computes
them between its lookup read and its media read. That computation moves, bodies unchanged, into a
pure module, so acceptance reaches the row and mode rules of a publish without importing a module
that reads the database: `lib/export/boundaryValidation.ts` imports `@/lib/db/appAccess`,
`@/lib/db/mediaAssets` and `@/lib/lookup/service`, and `acceptReading` is pure and is bundled by the
proof lane, which opens no socket:

```ts
// lib/export/boundaryFindings.ts
export function exportCarrierFindings(input: {
	readonly doc: BlueprintDoc;
	readonly mode: ExportMode;
	/** One generation of the tables the document reads: definitions and rows. */
	readonly fixtureData: LookupFixtureDataSnapshot;
	/** Part 11's `PrepareExportBoundaryInput.lookupTarget` (its section 8.2), passed through. */
	readonly lookupTarget?: { readonly server: string; readonly domain: string };
}): {
	readonly naming: LookupWireNaming | undefined;
	readonly lookupWire: PreparedLookupWire | undefined;
	readonly lookupWorkbook: LookupWorkbook | undefined;
	/** `lookupExportFindings`, then `organizationExportFindings`: the order
	 *  `collectViolationsWithRegistry` joins them in. */
	readonly rowFindings: readonly ValidationError[];
	/** `hqNestedSelectionFindings`, for the two HQ modes; empty for `ccz`. */
	readonly selectionFindings: readonly ValidationError[];
};
```

It holds `lookupExportFindings` (the cell text findings, `lookupSelectSourceRowFindings`, the reserved
tag, the carrier's budget), `organizationExportFindings` and the call of `hqNestedSelectionFindings`,
with `LookupRowVerdictInput` and the carrier builds they read. `prepareWithRegistry` and
`collectViolationsWithRegistry` call it and keep their order and their answers, which
`lib/export/__tests__/boundaryValidation.test.ts` holds unchanged. Check 2 reads `rowFindings` and
`selectionFindings`. Mode `hq-upload` with the reading's own project space is the first publish this
app will make, so a table managed there is left out of the workbook exactly as part 11's boundary
leaves it out.

The moved bodies import `@/lib/commcare`, and `lib/export/boundaryFindings.ts` is a new file outside
`biome.json`'s allowed consumers of that boundary, so `biome.json` changes beside the move. In both
overrides that list `"!lib/export/boundaryValidation.ts"`, `includes` gains
`"!lib/export/boundaryFindings.ts"` before it, and each of the four message strings that name the
allowed consumers gains "lib/export/boundaryFindings, " before "lib/export/boundaryValidation". The
first sentence of the same four strings is rewritten by part 06 (06-the-reader-forms.md,
"Contracts"), with the reader that makes it false.

What each rule means when it reaches check 2:

| Rule | On a correct reading | So a finding here is |
|---|---|---|
| `LOCATION_OWNER_EXPORT_NOT_ACTIVE` (`organizationExportFindings`) | never: no reading yields a `fixed-location` owner (part 11, section 11.4) | the reader's defect |
| `HQ_NESTED_SELECTION_UNREPRESENTABLE` (`hqNestedSelectionFindings`) | never: the two shapes are ones CommCare HQ's own build cannot carry, so no source holds them | the reader's defect |
| `LOOKUP_SELECT_SOURCE_VALUE_BLANK`, `_VALUE_WHITESPACE`, `_VALUE_DUPLICATE`, `_LABEL_BLANK`, `_EMPTY` (`lookupSelectSourceRowFindings`) | never reaches here: it is a fact of a table's rows, and part 11 raises it first as its own finding, `table-choices-unusable`, over the same snapshot (part 11, sections 13.2 and 14.1) | a rule part 11 missed |
| `LOOKUP_CELL_TEXT_UNREPRESENTABLE` | never reaches here: part 11's `table-cell-unrepresentable` (its section 5.3), which it judges over `readingLookupSnapshot`, a bound Project table included | a rule part 11 missed |
| `LOOKUP_TAG_RESERVED_BY_HQ`, `LOOKUP_CELL_TEXT_CHANGED_BY_HQ`, `LOOKUP_HQ_PUSH_TOO_LARGE` | never for a table the reading brings in: CommCare HQ manages it in this project space, and the workbook leaves it out (part 11, section 8.2). They judge only a Project table Nova manages that the app is bound to as it stands, and a Project table that fails one of the three is never `same-equal`, and its `use-project` offer is not offered (part 11, section 7.2) | a rule part 11 missed |

The `.ccz`'s fixture budget is not a rule of mode `hq-upload`; part 11's `lookupFixtureBudgetFinding`
holds it. So of everything `exportCarrierFindings` can answer, two rules are the reader's to keep
clean and the rest are facts of data that part 11 words before acceptance runs. Check 2 is the
backstop for both: an app that would be born and then refused by its first publish is never born.

**A finding's place.** `ValidationLocation` holds Nova uuids. `acceptance.ts::placeOfLocation(location:
ValidationLocation, identities: ReadDraft["identities"], source: HqAppSource): HqPlace` (part 01's
`HqPlace`, built with part 06's place builders) maps it through `outcome.draft.identities`: a
`formUuid` to the form's position in the source by its `xmlns` (place `form`), a `moduleUuid` to the
menu's position by its `uniqueId` (place `menu`), a `fieldUuid` to place `question` with the field's
authored path, and none of them to the app. The names a place carries are the source's own.
The finding's `message` quotes the app's content and goes into `AcceptanceDifference.detail` only.

**Why a gate refusal here is Nova's defect.** The reader admits exactly what the gate admits (the
bar's clause (a), part 01, 01-the-bar-and-the-manifest.md), each of its settle steps runs the gate
rules of its own slots (part 07, section 2.4; part 08, section 9.1), and a name outside a grammar is a
finding under part 04's entries. A refusal that still
reaches check 2 is a rule no reader module foresaw. It is worded as Nova's (section 14.4), and the fix
is an entry and a claim in the reader module that owns the slot.

---

## 5. Check 3: the fixed point

The bar's clause (c): re-reading Nova's own emission of D gives D exactly.

### 5.1 What "emission of D" is

```ts
// lib/deployment/reading/emission.ts
/** Nova's emission of a read document under the source's own ids, names and paths. */
export function readingEmission(input: {
	readonly doc: BlueprintDoc;
	readonly source: HqAppSource;
	readonly draft: ReadDraft;
	readonly reader: Pick<ReaderInput, "target">;
	/** The bound tables' definitions: `AcceptReadingInput.lookup.definitions`. */
	readonly lookupDefinitions: readonly LookupTableDefinition[];
	/** The held files. */
	readonly files: readonly AdoptedMediaFile[];
}): HqApplication;

/** One resolved asset per asset id of the draft's media references (the `assets` row below). */
export function emissionAssets(
	references: readonly ReadMediaReference[],
	files: readonly AdoptedMediaFile[],
): AssetManifest;
```

`readingEmission` is `expandDoc(doc, options)` with the four options part 07
(07-the-reader-cases-menus-lists.md), section 2.4, fixes for every re-emission of a reading, built here
from the draft so that acceptance needs no reader context, and with `runtimeTarget` left out:

| Option | Value |
|---|---|
| `identity` | `targetWireIdentity(overrides)` (`lib/commcare/wireIdentity.ts`): one `WireIdentityOverride` per entry of `draft.identities.modules` (`{ entityKind: "module", novaEntityUuid: uuid, uniqueId, xmlns: null }`, the type requiring `xmlns` on every override), and one per entry of `draft.identities.forms` (`{ entityKind: "form", novaEntityUuid: uuid, uniqueId: <the source form's readUniqueId, found by xmlns>, xmlns }`) |
| `attachmentTarget` | `input.reader.target` |
| `lookupNaming` | `lib/commcare/lookup/naming.ts::lookupWireNaming(input.lookupDefinitions)`, which takes `LookupTableDefinition`s; absent where the list is empty, as `prepareWithRegistry` leaves it absent for a document that reads no table |
| `assets` | `emissionAssets(draft.facts.mediaReferences, input.files)`, below |
| `runtimeTarget` | absent: the neutral template, as the HQ JSON path always prints |

The source's own form ids are a read's (`hq/appSource.ts`: "a key into this read only"), and every
reference inside one source names forms by them, which is why the form override takes `readUniqueId`
and not the real id of the application resource. Part 07's `readProjectionInputs(ctx)` builds the same
four from the reader's context; `emission.parity.test.ts` holds the two equal over every retained read,
so part 07's re-emission comparisons (its rule (R2)) and acceptance's cannot differ on an id, an
address, a name or a path.

**`emissionAssets`.** With media on, an asset id a reference names and the map lacks is a thrown
compiler error (`multimedia/assetWirePath.ts::AssetManifest`), so the map holds every asset id of
`draft.facts.mediaReferences`, as one `ResolvedMediaAsset` each:

| Member | Value |
|---|---|
| `assetId` | the reference's `assetId` |
| `wirePath` | a path the source spells for that asset (`ReadMediaReference.path`), less `jr://file/`; where its references spell several, the first in code-unit order, which is the one `assignMediaPaths` keeps (part 10, section 4.2, step 5) |
| `kind` | the reference's `mediaKind` |
| `contentHash`, `extension` | the file's own (`AdoptedMediaFile`) |
| `mimeType` | `application/octet-stream` |
| `bytes` | absent: nothing here bundles a file |

`expandDoc` prints `wirePath` and reads no other member of an asset. The reader's own projection
inputs name each asset before any file is judged (part 07, section 2.4), so they hold other facts
than the files' own, and `emission.parity.test.ts` holds the two emissions byte-equal.

**D is emitted without a declaration.** Checks 3 and 4 emit `outcome.draft.doc`, which check 2 gated
only under each choice's mutations. D differs from a gated document by those mutations alone: the
declaration, and for a split choice the split's questions. The emitter reads no verdict, and one that
throws over D is a difference and never an exception (section 2.5: `fixed-point/threw/expandDoc`), so
a D the emitter cannot print fails acceptance as Nova's defect and nothing half-printed is compared.
5.4 says what the missing declaration means for the equality.

**Before the target overlay.** The emission is `expandDoc`'s output. It is never passed through
`projectApplicationForTarget`, which leaves `profile`, `translations` and `add_ons` out of a body where
they equal the target's read: the re-read must see what Nova writes, not what a merge would leave.

**As a source.** `sourceFromEmission(emission, source): HqAppSource` wraps the output in part 05's
type (05-reading-commcare-hq.md, section 7), every member named:

| Member | Value |
|---|---|
| `docType` | `"Application"` |
| `raw` | the emission less `_attachments`, with `build_spec`, `multimedia_map` and `logo_refs` set to `source.raw`'s values (below) |
| `buildSpecVersion` | `source.buildSpecVersion` |
| `multimediaMap` | `source.multimediaMap` |
| `logoRefs` | `source.logoRefs` |
| `buildProfiles` | `[]`: the emission carries no `build_profiles` |
| `cloudcareEnabled` | the emission's `cloudcare_enabled === true` |
| `langs`, `translations`, `profile` | the emission's `langs`, `translations` and `profile`, which `hqShells.ts::applicationShell` always writes |
| `addOns` | the emission's `add_ons`, `{}` where it writes none |
| `name` | the emission's `name` |
| `lastModified` | null |
| `modules` | one per menu of the emission: `uniqueId`, `docType` and `caseType` read from it; each form's `docType` and `xmlns` read from it, its `readUniqueId` its `unique_id`, `shadowParentReadId` null, `attachment` `_attachments["<unique_id>.xml"]` |

`alignedFromEmission(emission): readonly HqAlignedModule[]` gives one `aligned` menu per menu, each
form `{ uniqueId: <its unique_id>, xmlns, source: <the form above>, questions: [] }`. The list is
empty because the reader reads nothing of a form's `questions` (part 06, section 2.2): CommCare HQ's
summary is check 5's alone, and no CommCare HQ has summarized the emission.

**The three keys taken from the source.** Nova's body never carries `build_spec`, `multimedia_map` or
`logo_refs` (`hqShells.ts::applicationShell`'s comment says why for each; the import adds `logo_refs`
only to take out a path-only entry, `lib/commcare/targetLogoRefs.ts`), and CommCare HQ keeps each
through an update: `models/applications.py::_merge_source_into_app` leaves out every key of
`Application._update_excluded_fields`, `build_spec` and `_attachments`, and keeps a key the body does
not name. All three are keys the reader reads: it refuses a `build_spec.version` the floor comparison
cannot read (`application-and-settings/34p-hq-build-spec-below-nova-s-floor`, part 06, section 6.2),
it walks `multimedia_map`, and it takes the Web Apps logo from `logo_refs` (part 06, section 6.1). Read
at their schema defaults (`{ version: null }`, no map, no logo) the re-read of every app would end in
the `34p` refusal, and the re-read of an app with a logo would come back without it. They are no part
of Nova's emission, so the re-read is handed the source's own, and clause (c) stays what it says:
Nova's bytes read back to D. Every other key Nova's body leaves out is one the reader reads nothing
from into the document (`build_profiles`, `custom_base_url`, `practice_mobile_worker_id` and the other
values kept at CommCare HQ's, part 01), so it reads at its default as no use.
`emission.parity.test.ts` holds that no re-read of a retained reading raises a finding under the `34p`
entry, and that a retained reading with a Web Apps logo reads back with it.

**Absent keys.** CommCare HQ serializes every declared property of its models, and Nova's body carries
only what Nova writes. The reader reads a declared key that is absent as
`schemaPropertyDefault(docType, key).default` and counts it as no use, which part 06's cursor does for
every object (its section 4.3: "A use is a non-default value"). So the emission reads as CommCare HQ's
stored copy of it would, for every key but those HQ's own saves fill in later and the three above. Proof
6 alone holds the reader on a source HQ normalized and served (part 14, 14-proof.md, section 5.1);
production holds it on Nova's bytes.

### 5.2 The re-read

```ts
const again = readHqApp({
	appId: input.appId,
	target: input.reader.target,
	source: sourceFromEmission(emission, input.source),
	modules: alignedFromEmission(emission),
	resolver: mintingResolver(input.appId),
	lookup: input.reader.lookup,
	organization: input.reader.organization,
	media: input.reader.media,
	appStrings: input.reader.appStrings,
	recordDialect: input.reader.recordDialect,
	saveOnlyEditedApplied: input.reader.saveOnlyEditedApplied,
});
```

`saveOnlyEditedApplied` is what part 05's probe of the source project space answered (part 07,
section 3.2). The re-read takes the reading's own answer, because Nova's emission holds
`update_mode: "edit"` exactly where D holds a write saved only if changed, and D holds one only
where the probe said the project space applies it.

The resolver is fresh: every identity is UUIDv5 over the app's id and a per-kind external key (part 10,
section 2), the emission holds the source's menu ids and `xmlns`, and a question's key is its authored
path, so the re-read mints the uuids the reading minted with no map handed across. The reader's two
runs for worker and place properties (part 11, section 11.5) are the reader's own and happen inside the
call, as in the reading. The split document's re-read is the same call over its own emission, with
the resolver 5.4 gives it.

### 5.3 The equality

```ts
// lib/deployment/reading/fixedPoint.ts
export function fixedPointDifferences(
	/** The document the re-read must give (5.4). */
	expected: BlueprintDoc,
	/** The re-read's answer (5.2). */
	again: ReadOutcome,
	reading: {
		/** The reading: its hand-offs are the other side of step 2. */
		readonly outcome: Extract<ReadOutcome, { readonly kind: "read" }>;
		/** CommCare HQ's source, for each difference's place (`placeOfLocation`). */
		readonly source: HqAppSource;
	},
): readonly AcceptanceDifference[];
```

In order:

1. `again.kind` is `read`. An account for Nova's own emission is a difference at each finding's place:
   signature `fixed-point/account/<finding code's standing>`.
2. `again.defects` is empty, and every hand-off of `again.claims.handOffs` has a hand-off of the
   reading's with its `to` and `subject`. The re-read may hold fewer and never one the reading lacks:
   a reference with no file that part 11 left out as inert is in no document (its section 3.2), so
   Nova's emission does not write it and the re-read hands nothing off for it. Otherwise
   `fixed-point/defect` or `fixed-point/hand-offs`.
3. **The documents.** `canonicalJsonDigest(again.draft.doc)` equals `canonicalJsonDigest(expected)`
   (`lib/utils/canonicalJson.ts`). Where the digests differ,
   `documentDifferences(expected, again.draft.doc)` walks the two documents together
   and returns every differing path (section 14.2); the first twenty become differences, each at the
   place of the entity the path lies in.

A difference of the split document's re-read carries the segment `split` after the check
(`fixed-point/split/account/...`, `fixed-point/split/form/...`), so the log says which document did
not read back.

Two more things the re-read returns are not compared, because step 3 already holds them. A menu's
and a form's uuid is UUIDv5 over the app's id and its `uniqueId` or `xmlns` (part 10, section 2.2),
so equal documents hold equal identity keys, and check 4 compares the ids themselves from the JSON
and the XML. The declarations the re-read offers are a function of the document alone (part 06,
section 16.3, steps 1 to 3), apart from which choice is proposed, `narrowedByHq` and `keepsWebApps`,
which part 06 derives from CommCare HQ's Web App setting (its step 4) and not from the document.

**No canonicalization.** `expected` is the reader's own output, so it is in the reader's image, and
every pair of section 9 has the reader's choice on the `expected` side already. Applying `canonDocument`
here would forgive exactly the defect the check exists for: a reader that returns one member of a pair
for CommCare HQ's bytes and the other for Nova's. A test holds that `acceptReading` never imports
`reader/canon.ts`.

**What is equal, said plainly.** Canonical JSON equality is deep equality of the two normalized
documents with object keys in sorted order: every entity map by uuid, every order array in order, every
expression tree node for node, every prose part, every translation entry with its fingerprint. Two
documents that differ only in the insertion order of an entity map are equal; nothing else is.

### 5.4 Which documents

| Document | `expected` | Resolver of the re-read |
|---|---|---|
| D, in every call | `outcome.draft.doc` | `mintingResolver(appId)` |
| the split document, in every call where a choice of `input.choices` holds `split` | the document under that choice's mutations, with `appSettings.runsOnlyOn` removed | `matchingResolver(input.appId, externalIdentityMap(expected, identity))`, `identity` the `targetWireIdentity(overrides)` of 5.1 (part 10, sections 2.3 and 2.5), so the questions the split made keep their uuids |

`appSettings.runsOnlyOn` is removed from `expected` because the reader never writes it: part 06's
assembly returns no declaration in the document and offers the choices beside it (its section 16.1), and
the emission's `cloudcare_enabled` reads back into the choices, not the document.

D is judged first, and a difference there ends the check. Part 06's section 16.3 leaves at most one
split choice (step 3 drops a split candidate whose unsplit twin runs, and one of the two split
candidates where both run), and both split candidates give one split document, so a call makes at
most two re-reads. A split that does not read back fails the reading before the review offers it:
the failure is `read-back-differs`, at the read, as any other failure of acceptance is.
`datetimeSplitReadBack.test.ts` (Tests) holds the same over every corpus document that has a date
and time question, and proof 6 over the Nova-born documents step 4's split made.

---

## 6. Check 4: identity agreement

The bar's clause (b), as far as a source alone can show it: publishing D back changes no identity a
runtime, CommCare HQ's servers or existing data read. Both sides are extracted the same way from an
application's JSON and its forms' XML, with no build and no reader module.

### 6.1 The identity record

```ts
// lib/commcare/hq/sourceIdentity.ts
/** Core's data type for a bind's `type`, by `XFormParser.java::typeMappings`. */
export type CoreTypeClass =
	| "text" | "integer" | "long" | "decimal" | "date" | "time" | "date-time" | "boolean"
	| "choice" | "choice-list" | "geopoint" | "barcode" | "binary" | "unsupported"
	| `other:${string}`;
export const CORE_BIND_TYPE_CLASSES: Readonly<Record<string, CoreTypeClass>>;
/** `type` with its prefix removed, looked up; an absent type is `text`; an unmapped one `other:<type>`. */
export function coreTypeClass(bindType: string | null): CoreTypeClass;

export interface AnswerLeaf {
	/** The leaf's absolute data path: `/data/household/head_name`. */
	readonly path: string;
	/** The nodeset of every `<repeat>` whose template holds the leaf, outermost first. */
	readonly repeats: readonly string[];
	/** The body control bound to it, by local name; `none` for a node with no control. */
	readonly control: "input" | "select1" | "select" | "upload" | "trigger" | "secret" | "none";
	readonly typeClass: CoreTypeClass;
	/** `mediatype` of an `upload`; null otherwise. */
	readonly mediatype: string | null;
	/** The control's `appearance`, as written; null where it has none or there is no control. */
	readonly appearance: string | null;
	/** Inline `<item>` values in body order, each trimmed; null where the control has no item. */
	readonly choices: readonly string[] | null;
	/** Whether the control holds an `<itemset>`. */
	readonly itemset: boolean;
}

export interface ContainerIdentity {
	/** A `<group ref>`'s `ref`, or a `<repeat>`'s `nodeset`. */
	readonly path: string;
	readonly kind: "group" | "repeat";
	readonly appearance: string | null;
	/** A repeat's `jr:count`, present or not. */
	readonly counted: boolean;
}

/**
 * Which labels the source writes through an itext reference. Check 4 never compares it. Check 5
 * reads it to know which labels HQ summarized (section 7.3).
 */
export interface ControlAsWritten {
	/** Whether the control's `<label>` holds a `ref`. A `repeat` answers for the `<label>` of the
	 *  `<group>` that wraps it, as `xform.py::XForm._get_label_translations` reads it. */
	readonly labelRef: boolean;
	/** For each inline `<item>` in body order, whether its `<label>` holds a `ref`. */
	readonly itemLabelRefs: readonly boolean[];
}

export interface FormIdentity {
	readonly xmlns: string;
	/** The data root's own namespace, which must equal `xmlns`. */
	readonly dataNamespace: string;
	readonly uniqueId: string;
	readonly docType: string;
	readonly leaves: ReadonlyMap<string, AnswerLeaf>;
	readonly containers: ReadonlyMap<string, ContainerIdentity>;
	/** The paths of the leaf controls in body order. */
	readonly order: readonly string[];
	/** Every control of the body by its path, leaf and container alike. Not compared by check 4. */
	readonly written: ReadonlyMap<string, ControlAsWritten>;
}

export interface SourceIdentity {
	readonly languages: readonly string[];
	/** Menus in order: id, document type, case type, and each form's `xmlns` in order. */
	readonly menus: readonly { readonly uniqueId: string; readonly docType: string;
		readonly caseType: string | null; readonly forms: readonly string[] }[];
	readonly forms: ReadonlyMap<string, FormIdentity>;
	/** Each form left out, with why. A source both readers read whole has none. */
	readonly unread: readonly { readonly menu: number; readonly form: number;
		readonly reason: "no-xmlns" | "shared-xmlns" | "no-xform" | "xform-unparsed" }[];
}
export function sourceIdentity(application: unknown): SourceIdentity;
```

`CORE_BIND_TYPE_CLASSES` is `XFormParser.java::typeMappings` as data, each key with and without the
`xsd:` prefix: `string` text; `int` and `integer` integer; `long` long; `decimal`, `double` and `float`
decimal; `dateTime` date-time; `date` date; `time` time; `boolean` boolean; `listItem` and `select1`
choice; `listItems` and `select` choice-list; `geopoint`, `barcode`, `binary` by their names; `gYear`,
`gMonth`, `gDay`, `gYearMonth`, `gMonthDay`, `base64Binary`, `hexBinary` and `anyURI` unsupported. The
class is one per Core data type, which is what "type class" has to mean for a check about what
existing data reads: `xsd:int` and `xsd:integer` are one class and `xsd:double` and `xsd:decimal`
another, because Core gives each pair one data type, and nothing else is forgiven. Three places it is
this record's own cut and not Core's word for word, each the same on both sides, so the comparison
stays sound. An absent `type` is classed with `string`: Core gives it `DATATYPE_NULL`
(`XFormParser.java::getDataType`), and part 06 holds the two as one (its section 11.4), as
`Recalculate.java::wrapData` wraps them alike. A select is classed by its bind as written: Core turns
a select's null or text node into a choice type afterwards (`XFormParser.java::applyControlProperties`),
which the `control` member already says. And a type outside the table keeps its own name
(`other:<type>`) where Core gives every such type `DATATYPE_UNSUPPORTED`, so two unknown types never
compare equal.

### 6.2 Extraction

`sourceIdentity(application)` takes the app's JSON as an object with `_attachments` (the emission as it
is; CommCare HQ's source as `{ ...source.raw, _attachments }`, each form's attachment under
`<readUniqueId>.xml`). It reads JSON by key and XML through `lib/commcare/xmlParse.ts`, with the
namespace helpers of `lib/commcare/xmlNamespaces.ts` (part 06, section 2.1). It parses
no XPath: a path attribute is used as text, and a `ref` that is relative is resolved against its
enclosing `group` or `repeat` as `xform.py::XForm.resolve_path` resolves it (a leading `/` is absolute;
anything else is the context, a `/`, and the text).

Per form:

1. **Model.** The primary instance is the first `<instance>` of `<model>` with no `id`; its one element
   child is the data root. `dataNamespace` is the root's namespace. Every element under the root with no
   element child is a leaf, at the path of its local names from `/data` (the root reads as `data`
   whatever it is named: part 06 refuses any other root name under
   `questions/data-root-element-named-other-than-data`). An element in the case transaction namespace,
   and everything under one, is no leaf: section 6.3's case blocks hold it.
2. **Binds.** Each `<bind>` by its `nodeset`, resolved; a leaf's `typeClass` is `coreTypeClass` of its
   bind's `type`.
3. **Body.** A walk of `<h:body>` in document order. A `<group>` with a `ref` (or `nodeset`) is a
   container of kind `group`; one with neither is no container and passes its context on, as
   `XForm._get_control_nodes` passes it. A `<repeat>` is a container of kind `repeat` at its `nodeset`,
   and every leaf under that path takes it in `repeats`. Any other element in the XForms namespace but
   `label`, `hint`, `help`, `alert`, `item`, `itemset`, `value` and `output` is a leaf control: its path
   is its `ref` or `bind`, and the leaf at that path takes its `control`, `mediatype`, `appearance`,
   `choices` and `itemset`. A control whose path names no leaf, and two controls on one leaf, make the
   form `xform-unparsed`.
4. **Order.** `order` is the leaf controls' paths as the walk met them.
5. **As written.** For every container and leaf control of step 3, `written` holds at its path
   whether its `<label>` child holds a `ref`, and that for each inline `<item>`. The extraction reads
   no label's text and resolves no itext id.

A form whose `xmlns` is absent or blank is `no-xmlns`; two forms of one `xmlns` are `shared-xmlns` and
neither is read; a form with no attachment is `no-xform`; one whose XML does not parse or breaks step 1
or 3 is `xform-unparsed`.

### 6.3 The comparison

```ts
// lib/deployment/reading/identityAgreement.ts
export function identityDifferences(input: {
	readonly source: HqAppSource;
	/** `readingEmission` over `outcome.draft.doc` (5.1). */
	readonly emission: HqApplication;
	/** The reading's draft: its document, its facts and its identities. */
	readonly draft: ReadDraft;
}): {
	readonly differences: readonly AcceptanceDifference[];
	/** `sourceIdentity` of the source, which check 5 reads `written` from (7.3). */
	readonly sourceIdentity: SourceIdentity;
};
```

`A` is `sourceIdentity` of the source and `E` of the emission. In order, every difference collected:

| # | Compared | Equal when | Signature |
|---|---|---|---|
| 1 | `unread` on each side | both empty (section 6.4) | `identity/unread/<reason>`, `identity/emission-unread/<reason>` |
| 2 | `languages` | the same codes in the same order | `identity/languages` |
| 3 | `menus` | the same length; position by position the same `uniqueId`, `docType`, `caseType` and form `xmlns` list. A hidden registration menu the reader folded (part 07, section 8.7) is in both: the emission plan writes it back under `syntheticModuleUuid`'s identity row | `identity/menu/<key>` |
| 4 | each form's `xmlns`, `dataNamespace`, `docType` | equal, and `dataNamespace` equals `xmlns` on each side | `identity/form/<key>` |
| 5 | each form's leaves | `A.leaves` less `GA` equals `E.leaves` less `GE` as maps by path, each leaf deeply equal after the inert appearances are cut from A (below) | `identity/leaf/missing`, `identity/leaf/added`, `identity/leaf/<key>` |
| 6 | each form's containers | the authored containers of each side are equal as maps by path, each deeply equal after the same cut. A container's label is no member of the record: its text is check 5's (section 7.3) | `identity/container/missing`, `/added`, `/<key>` |
| 7 | each form's `order` | equal after removing the paths of `GA` and `GE` | `identity/order` |
| 8 | case blocks | section 6.4 | `identity/case-blocks/<kind>/<key>` |
| 9 | entry facts | `hqEntryFacts(A)` and `hqEntryFacts(E)` (part 07, section 6.3): the menus' facts equal in order under `menuFactsDifference`, each form's under `entryFactsDifference` | `identity/entry/<key>`, `identity/entry-menu/<key>` |

**`GA` and `GE`, the generated leaves.** A node Nova generates is no answer of the app, and Nova may
name, add or drop one (part 06, section 13.4). Each side is cut by its own list:

- `GA`, for CommCare HQ's source: the data paths of `outcome.draft.facts.forms[i].generated`, each the
  owner's parent path and the node's `name` (for a purpose whose node is a child of its owner's wrapper
  or row, the path part 06 records). These are nodes whose trees the reader compared with the production
  emitter's before folding them.
- `GE`, for the emission: the data paths of `planGeneratedNodes(doc, formUuid).nodes`, each placed by the
  production path functions (`generatedNodes.ts::trimmedValuePath`, `datetimeCaseValue.ts
  ::datetimeCaseValuePath`, `captureUrlNode.ts::captureUrlNodePath`, and for the rest the owner's parent
  path and the name), through one new export `generatedNodes.ts::generatedNodePaths(doc: BlueprintDoc,
  formUuid: Uuid): ReadonlyMap<string, GeneratedNode>`, keyed by the node's absolute data path, each
  value that file's own `GeneratedNode` as it stands today (`purpose`, `name` and the `owner` uuid).
  The emitter's own placement of each node is held to it by `generatedNodePaths.test.ts`.

The two lists are not required to be equal. Their difference is `generatedDifference` (section 11.1),
which the register reads. What check 4 requires is that everything else is equal, and that nothing
but a generated node was cut: a path of `GA` that is not a leaf of `A`, or of `GE` not a leaf of `E`, is
signature `identity/generated/phantom`.

**An authored container** is one that has an `appearance` after the cut below, or is a `repeat`, or
has at least one leaf under its path that is not in its side's generated list. Nova's own groups
(`nova_operations`, a condition group, a count placement's wrapper) carry no label, no appearance and no
bind (`lib/commcare/CLAUDE.md`, "Authored case-operation emission"), so one that holds only generated
leaves is cut, and one that holds a Save to Case block is in both sides at one path because the block's
placement is held. Whether a container holds a `<label>` is no part of the test and no member of the
record. A group whose label is blank in every language reads as a group with no label, and Nova
writes no `<label>` for it (part 06's canon row `blank-container-label-is-absent`; CommCare HQ's form
builder drops an empty label the same way, `Vellum/src/writer.js`, the `labelItext.isEmpty()`
branch), so a `<label>` element standing on one side alone is a correct reading. A group with no
leaf, no appearance and no repeat under it is cut on both sides alike, and check 5 holds that the
reader did not drop one (`summary/row/unread/Group`).

**Appearance.** Two `appearance` values are equal as strings, with two exceptions and no other:

- `field-list` in any letter case equals `field-list`: part 06, section 10.2, reads the other cases
  as a Question List and Nova writes the one. The proof lane holds no spelling rule for it, because
  no check of the hop reports the two spellings apart (part 14, 14-proof.md, section 4 and
  Departure 19).
- **An appearance the reader accounted as inert is cut from A.** Part 06's `classifyAppearance` drops an
  appearance no runtime reads on its control (its section 9.2: rule 4 and each row of `APPEARANCE_ROWS`
  whose entry is INERT, among them
  `questions/any-other-value-read-by-no-runtime-not-an-intent-value-on-an`), and Nova then writes none.
  Before rows 5 and 6 compare, the leaf or container of `A` at each path of
  `outcome.draft.facts.forms[i].inertAppearances` (part 06, section 17.3: the data path of every control
  whose `appearance` the reader accounted under an entry of standing `inert`) takes `appearance: null`.
  One thing bounds the cut. **An appearance Nova holds is never cut.** A path of `inertAppearances`
  whose leaf or container in `A` holds one of the four appearances Nova writes is
  `identity/appearance/inert-held`: a `trigger` with appearance exactly `minimal`; an `upload` whose
  `mediatype` starts `image/` with appearance exactly `signature`; a `group` container whose
  appearance is `field-list` in any letter case; an `input` whose `typeClass` is `text` with
  appearance exactly `numeric`. The rule reads `A`'s own record (`AnswerLeaf`, `ContainerIdentity`)
  and no raw bind type, so `numeric` on an input of class `integer` or `decimal` never meets it:
  there the claim is right (part 06, section 9.2). `identityAgreement.test.ts` holds the four to the
  emitter's own tokens (`lib/commcare/xform/appearance.ts::fieldAppearance`, part 03, section 2.3).
  An inert claim beside an appearance Nova still writes needs no rule of its own: the cut leaves `A`
  with none and `E` with one, which rows 5 and 6 report.

**A generated case block is compared, never cut.** A guard (`GeneratedNodePurpose` `guard`) is an
update-only Save to Case block that refuses a whole submission (`lib/commcare/CLAUDE.md`, "Authored
case-operation emission": a blank `@case_id` on Core and on HQ), so one that Nova's emission holds
and the source does not is a change to what a worker can submit, and no "hidden value". It is no
leaf (its element holds a `<case>`), so `GA` and `GE` never remove it, and row 8 compares it as the
`save-to-case` block it is: `identity/case-blocks/save-to-case/added` or `/missing`. On a correct
reading neither arises: part 07 reads a Save to Case block as an operation only with its guards in
place (its `saveToCase.boundary.test.ts`: a block with a missing guard is its not-yet entry and
never an operation), so the guards the emission writes are the guards the source held.
`identityAgreement.test.ts` holds it: a draft doctored to hold an operation whose guard the source
lacks fails check 4 with that signature. The register never sees a guard: `generatedDifference`
leaves the purpose out (section 11.1).

### 6.4 Case blocks, and forms left out

Part 07, section 6.1, extends `publishedCaseBlocks` to return `PublishedCaseBlocks { forms,
unread }` with conditions, close conditions, indices, `ownerWritten`, `editOnly`, the session value a
basic own block reads, and each Save to Case block's actions, indices and property leaves. Check 4 is
its caller.

For each `xmlns`, `publishedCaseBlocks(A).forms.get(xmlns)` and `publishedCaseBlocks(E).forms
.get(xmlns)` must hold the same blocks: matched by `kind` and `path` (a `basic-subcase` by `index`, an
`advanced` block by `tag`), and for a matched pair equal `caseType`, `condition`, `closeCondition`,
`indices`, `ownerWritten`, `editOnly`, `sessionDatum`, `opens`, `closes`, `repeatContext`, `actions`
and `properties`, and equal `modelIterationRows` as sets. Three things are applied before comparing,
and nothing else:

1. **A generated sibling's path maps to its owner question, on each side by that side's list.** A
   property whose path is in `GA` (for the source) or `GE` (for the emission) with purpose `trimmed`,
   `datetime` or `url` is replaced by its owner question's path. So `name -> /data/q` in a source made
   in CommCare HQ equals `name -> /data/nova_trimmed_q` in Nova's emission, and a property that named
   one question in the source and another's sibling in the emission does not.
2. **`external_id` of a basic own block** is read into `properties` from `open_case.external_id` on
   both sides, as the existing code does.
3. **`condition` of a basic own block that does not open** is compared as `always` on both sides: part
   07 reads `never` and `if` as the same state only on the shapes the manifest holds, and it refuses
   the two the manifest refuses. The four HELD entries, each under `forms-and-case-writes/`:
   `update-case-condition-never-on-a-registration-form`,
   `update-case-condition-never-on-a-follow-up-with-any-other-entry`,
   `update-case-condition-never-on-a-follow-up-in-a-multi-select-or` and
   `update-case-condition-if-whose-question-exists`. The two REFUSED:
   `update-case-condition-never-on-a-follow-up-with-no-other-active` and
   `update-case-condition-if-whose-question-is-gone`.

A property key present on one side alone is `identity/case-blocks/<kind>/properties`; a block on one
side alone is `identity/case-blocks/<kind>/missing` or `/added`.

**A form left out is never a silent pass.** Any entry of `publishedCaseBlocks(A).unread` or
`sourceIdentity(A).unread` fails the check. `sourceIdentity`'s four reasons are four of part 07's nine
`UnreadFormReason`s under the same names, so `<reason>` in `identity/unread/<reason>` is one
vocabulary, and a form both lists hold under one reason is one difference. The reader was to have
named each to the person before a clean read was possible, so the failure is Nova's, and its
signature says which entry was missed:

| `UnreadFormReason` | The reader's own finding for the shape (the owner of the fix) |
|---|---|
| `no-xmlns`, `shared-xmlns` | refused before minting (part 10, section 2.3; part 06, section 7.2); `shared-xmlns` under `forms-and-case-writes/two-non-shadow-forms-sharing-an-xmlns` |
| `shadow-form` | `forms-and-case-writes/shadowform` (part 06, section 7.1) |
| `unknown-form-kind` | `unrecognized` at the form (part 06, section 7.1) |
| `no-xform`, `xform-unparsed` | part 06's `form-source` findings (its section 8.2) |
| `actions-malformed` | `unrecognized` at the form (part 07, section 3) |
| `visit-schedule`, `registry-load` | the manifest's REFUSED rows for a visit schedule and a data registry load, which part 07 raises |

The same reasons on the emission's side are `identity/emission-unread/<reason>`: Nova wrote a form its
own reader of case blocks cannot read.

### 6.5 What check 4 holds and does not

It holds, trusting two things of the reader and no more (which leaves are generated nodes, and which
appearances it accounted as inert): that no answer leaf moved, appeared, vanished, changed its repeat,
its stored type class, its control or its choices; that no container changed kind, and none changed
an appearance some runtime reads; that every case block Nova will write, a guard included, stands
where CommCare HQ's stood, with the same type, condition, indices and properties from the same
questions; and that CommCare HQ's entry builder is handed the same facts.

Each trust is bounded from outside the reader. A leaf the reader calls generated is folded only where
its tree equals the production emitter's (part 06, section 13), and a phantom fails the check. An
appearance the reader calls inert is held by part 06's `appearances.test.ts` over each entry's own
examples and, for the three classes the lane reads, by part 14's parity, and one of
Nova's own four is never taken on the reader's word (6.3); a claim that is wrong there
would drop an appearance a runtime reads, which lane proof 3 shows on the base that holds it.

It does not hold: any expression's meaning (it reads none), any text, anything of a case list, a detail
or a search but the facts `hqEntryFacts` reads, a link's condition or target, a display condition, or a
setting. Sections 7 and 8 say what holds those.

---

## 7. Check 5: CommCare HQ's question summary against the document

CommCare HQ reads each form of the source itself and returns a row per question
(`api/resources/v0_4.py::ApplicationResource.dehydrate_module`, calling `xform.py::XForm.get_questions`
with triggers, groups, translations and fixtures). It is a second parse of the same bytes by other code
(Python and lxml), which is what makes it evidence. It is compared with D, never with Nova's emission:
no CommCare HQ has summarized the emission.

### 7.1 What a row is, at source

`HqQuestionSummary` is part 05's type (05-reading-commcare-hq.md, section 6). What HQ puts in each
member, which decides what can be compared:

| Member | HQ's rule |
|---|---|
| `path` | the control's resolved `ref`, `nodeset` or `bind` (`_get_control_nodes`); for a node with no control, its data path |
| `repeat` | for a control, the path of the innermost enclosing `<repeat>`, or null; a repeat's own row holds the repeat outside it. For a node with no control HQ takes the longest matching path among the control rows; check 5 does not compare it there |
| `group` | for a control, the path of the innermost enclosing `<group ref>` or `<repeat>`, or null; a `<group>` whose direct child is a `<repeat>` gets no row and passes the context through. For a node with no control HQ takes the longest matching path among the control rows; check 5 does not compare it there |
| `type` | `_infer_vellum_type(control, bind)`: a lookup in `VELLUM_TYPE_INDEX` over tag, bind type, `mediatype` and `appearance`, falling back at each field to the rows that name no value for it; `DataBindOnly` for a node with no control; null where the lookup ends at none or several rows. Check 5 compares no type. It reads the name only to tell a `DataBindOnly` row and as a word of a signature |
| `required` | `bind/@required == "true()"`, a boolean; null on a node with no control |
| `relevant`, `constraint` | the bind's attribute text, or null |
| `calculate` | the bind's attribute text, on a node with no control only |
| `labelTranslations` | per language of the app, `XForm.localize` of the label's itext id: the default form's `<value>` with each `<output>` printed as `____` (`ItextValue._render`); a language whose text is empty is left out |
| `options` | each `<item>`: its `<value>` stripped, and its label per language by the same rule. HQ raises on an item with no value, which makes the whole menu an error |

HQ lists every leaf of the data tree that no control names as a `DataBindOnly` row, and adds rows for a
Save to Case block's `@case_id`, `@user_id` and `@date_modified`. It reports no hint, help, media,
appearance beyond what picks the type, `readonly`, no `calculate` on a question with a control, and
nothing above the form but each form's `xmlns` and id.

### 7.2 The document, in the summary's words

```ts
// lib/deployment/reading/summaryAgreement.ts
export interface DocumentSummaryRow {
	readonly path: string;
	/** For a field with a control. Null for a Hidden Value, which check 5 does not compare. */
	readonly repeat: string | null;
	/** For a field with a control. Null for a Hidden Value, which check 5 does not compare. */
	readonly group: string | null;
	/** The field's kind, for a signature. */
	readonly kind: FieldKind;
	readonly alwaysRequired: boolean;
	readonly hasRelevant: boolean;
	readonly hasConstraint: boolean;
	/** For a Hidden Value. */
	readonly hasCalculate: boolean;
	/** The label per language, normalized (7.3); a language with no text is absent. */
	readonly label: Readonly<Record<string, string>>;
	/** Inline choices in order, or null. */
	readonly options: readonly { readonly value: string;
		readonly label: Readonly<Record<string, string>> }[] | null;
	readonly fieldUuid: Uuid;
}
export function documentSummary(doc: BlueprintDoc, formUuid: Uuid): readonly DocumentSummaryRow[];
```

`documentSummary` projects each field of the form. Every path comes from the projection the emitter
prints from (`xform/caseOps.ts::collectFieldLocations` and `lib/commcare/placement.ts::repeatRowPath`,
over `xpath/formNodeProjection.ts`), never from a second path rule:

- a leaf, a group and a section: one row at the field's path;
- a repeat workers add entries to, a count-bound repeat and a model-iteration query repeat: one row at
  the row path (`repeatRowPath`), since HQ gives the wrapper `<group>` no row;
- a query repeat in the count placement: a row at the wrapper's path and a row at the row path,
  which is what HQ makes of the wrapper group that has a `ref`
  (`lib/commcare/CLAUDE.md`, "Repeat modes").

`repeat` and `group` are filled for every field with a control (every kind but `hidden`): the row
path of its nearest repeat ancestor and the path of its nearest group or repeat ancestor, as 7.1's
rows for a control say. A Hidden Value holds null for both.

`alwaysRequired` is true where the field's `required` is the constant true, or the field is in
`caseCreateNameFields(doc, formUuid)` and is no Hidden Value (the stamp). `hasRelevant` is whether
the `relevant` slot holds an expression. `hasConstraint` is whether `validate` holds an expression,
and nothing else: the check Nova conjoins for a case name or an external id
(`lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`) is Nova's own, which a source made
in CommCare HQ never holds, and 7.4 says how the comparison treats a source that does hold it.
`hasCalculate` is whether a Hidden Value's `calculate` holds one.

### 7.3 Text

A label per language is `commCareLocalization(doc).prose(language, unitId)` for the field's label unit
under `lib/domain/translationFill.ts::filledProse`, the projection every export reads, passed through
`builder.ts::buildLabelNodes` with a stub in place of the expression printer: each text node is its
text, each `<output>` it builds is `____`. Using the emitter's own node builder puts a hole exactly
where Nova writes an output (a reference, a calculated value, a protected whitespace run, part 03's
bracket output), which is where part 06 read one (its section 12.3 confirms each literal output by
that same print). `buildLabelNodes` is exported from `builder.ts`, body unchanged.

Both sides are then **normalized**: every character `lib/commcare/xform/consumerWhitespace.ts
::isConsumerWhitespace` answers true for is removed, and so is every other Unicode white space
character. Core drops a whitespace-only text node before it reads a text and lxml keeps it, so
whitespace is where the two parses differ without the reading being wrong. A language whose normalized
text is empty is absent on that side.

**Which labels are compared.** CommCare HQ summarizes a label only where the `<label>` holds a `ref`
(`xform.py::XForm._get_label_translations`: `'ref' in label_node.attrib`), and sends no text for a label
written inline, which part 06 reads all the same (`take` under
`questions/inline-label-text-label-no-itext`, its section 12.1). So a question's label is compared only
where `sourceIdentity(source).written` holds `labelRef: true` at the row's path, and a choice's label
only where `itemLabelRefs` holds true at its position. Where it is false the row's text is no evidence
and is skipped.

**Agreement, per language.** HQ leaves a language out where the itext holds no `<text>` for it
(`XForm.localize` answers `None`) and where the value is empty (`if label:`). The document always has
a text there once any language does, because `filledProse` fills a blank and a missing translation
prints its source (`lib/domain/translationFill.ts`; `lib/commcare/CLAUDE.md`, "Multilingual
emission"). So, for a compared label:

- where HQ sends text in a language, the two normalized strings are equal;
- where HQ sends none in a language `L`, the document's text in `L` equals the document's text in the
  first language, in the app's language order, for which HQ did send text. That is the fill's own
  rule, and for a reading the app's first language is both the default and the source language (part
  06, section 6.3), so a missing translation and a blank one land on the same text;
- where HQ sends text in no language, the document's label is absent in every language.

Check 5 does not ask whether `blank-translations-filled` applies. Whether the first publish fills a
blank is the register's question (section 11.2), and a label CommCare HQ never translated is a
correct reading whether or not any blank was counted.

### 7.4 The comparison

```ts
// lib/deployment/reading/summaryAgreement.ts
export function summaryDifferences(input: {
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	readonly draft: ReadDraft;
	/** Check 4's `sourceIdentity` of the source, read here for `written` alone (7.3). */
	readonly sourceIdentity: SourceIdentity;
}): readonly AcceptanceDifference[];
```

It runs per form of each `aligned` menu, joining `HqAlignedForm` to the document's form by `xmlns`
through `draft.identities.forms`.

**Ids.** The aligned form's `xmlns` equals the identity's, and `adoptedIdentityRows(read, modules)`
(part 10, section 3.1) answers `ok`, `read` being `draft.identities` less each menu whose aligned
module is `not-summarized` and that menu's forms (7.5): every other menu and form the document holds
has the real id CommCare HQ's application resource gave. Otherwise `summary/ids/menu` or
`summary/ids/form`.

**Rows.** CommCare HQ's rows and `documentSummary`'s are joined by `path`.

| Case | Verdict |
|---|---|
| a row on both sides | each member below must agree |
| HQ's row alone, and its path is, or lies under, a path of `GA` (section 6.3), a case region or Save to Case block of the form (`ReadFormFacts.caseRegionPaths`, part 06, section 17.3), or a Connect block of the document (`/data/<id>` for each of `formConnectIds`), or it holds `/@` | explained: Nova's own node, a case block, or a block's attribute |
| HQ's row alone otherwise | `summary/row/unread/<HQ's type>` |
| the document's row alone | `summary/row/absent/<kind>`, the field's kind |

| Member | Agreement | Signature |
|---|---|---|
| `repeat`, `group` | on a row that has a control on both sides (HQ's row is not `DataBindOnly`, and the field is no Hidden Value): equal strings, or both null | `summary/question/repeat`, `/group` |
| `required` | HQ's `true` implies `alwaysRequired`. HQ's `false` implies not `alwaysRequired`, unless the field is in `caseCreateNameFields` (HQ's build stamps it whatever the source said) | `summary/question/required` |
| `relevant` | HQ's is a non-empty string exactly where `hasRelevant`, skipped for a query repeat's rows, whose `relevant` is Nova's row guard | `summary/question/relevant` |
| `constraint` | `hasConstraint` implies HQ's is a non-empty string. HQ's non-empty with no `hasConstraint` is accepted only on a field in `caseScalarTextGuards(doc, formUuid)` whose kind `caseScalarTextGuardIsChecked`: a source Nova wrote holds the conjoined check alone there, and the reader folded it out. On any other field it is a validation the reader dropped | `summary/question/constraint` |
| `calculate` | on a `DataBindOnly` row, HQ's is a non-empty string exactly where `hasCalculate` | `summary/question/calculate` |
| `labelTranslations` | 7.3, in every language of the app, where the source's label holds a `ref` | `summary/question/label` |
| `options` | HQ's is null or empty exactly where the document's is null; else the same length, and position by position the same `value`, and labels that agree by 7.3 where that item's label holds a `ref` | `summary/question/options`, `summary/question/option/value`, `summary/question/option/label` |

**What `repeat` and `group` catch.** CommCare HQ reads them from the body's nesting
(`xform.py::XForm._get_control_nodes`), and check 4 reads structure from the data tree. They differ
only where a control stands in a body group or repeat its data node is not under, which part 06
refuses (its section 8.5, `data-parent-data-node-under-another-group-than-its-control` and
`data-parent-crossing-a-repeat`). A reader that missed the refusal and placed the question by its
data node passes checks 1 to 4 and fails here.

The `constraint` row is one-sided on a guarded field for the reason the `required` row is one-sided on
a create's name question: each is a rewrite of Nova's own that a source made in CommCare HQ never
holds (HQ reads the bind's `constraint` attribute of the source as written,
`xform.py::XForm._get_control_nodes`), so on such a source a registration's name question has no
validation in HQ's summary and none in the document, and the two agree. On a guarded field the row
catches a validation the document holds and the source does not. It cannot tell a validation the
reader dropped from Nova's own check there, since each leaves a constraint in the source and none in
the document. What holds that case is the reader's one recognition method (part 08,
08-the-reader-expressions.md, section 2.1): the check is folded out only where the constraint's tree
equals what the production emitter conjoins for that field (part 06, section 13.2), so a constraint
that is anything else stays the validation it is, and check 3 then holds that Nova prints it back.

`setvalue` is not compared: HQ reports the first setvalue of the source on a path, and a preload HQ's
build appends is in no source, so its presence says nothing about a default Nova holds.

### 7.5 A menu CommCare HQ could not summarize

`dehydrate_module` wraps a whole menu in `try` and returns `{'error': str(e)}` in its place, which part
05 types as `HqAlignedModule { kind: "not-summarized" }`. Check 5 skips every form of such a menu: there
is no summary to agree with. It raises nothing for it. The read has already raised
`menu-unreadable-in-hq` at the menu, or `app-unreadable-in-hq` for the app, standing `fix-in-hq`
(part 05, 05-reading-commcare-hq.md, section 8.3, `notSummarizedMenus`; part 12,
12-the-reading-and-the-birth.md, section 3.3, step 4), and it answers an account, so no app with
such a menu is created on four checks. It is never `read-back-differs`: the fault is in the form,
and CommCare HQ's form builder shows it.

---

## 8. Which check catches what, and what holds the rest

One row per way a reader can be wrong. "No" means the check passes over the bug.

| A reader bug | 1 | 2 | 3 | 4 | 5 | What catches it |
|---|---|---|---|---|---|---|
| A key or node never claimed | yes | | | | | the cursor's close (part 06) |
| A value claimed held and never read into the document | yes | | | | | claim consumption, in the close |
| A value claimed, read, and stored in the wrong slot of the right entity | no | no | yes where Nova prints the two slots differently | no | presence only | check 3; a lane base that exhibits the key |
| A group level dropped | no | no | no | yes: leaf paths | yes: `group` | checks 4 and 5 |
| A repeat read as a group | no | no | no | yes: `repeats`, container kind | yes: `repeat` | checks 4 and 5 |
| A whole-number question read as a decimal | no | no | no | yes: type class | no | check 4 |
| A Text question read as a Phone Number, or the reverse | no | no | no | yes: `appearance`; `identity/appearance/inert-held` where the reader called `numeric` inert | no | check 4 |
| An appearance Nova holds, accounted as inert | no | no | no | yes: `identity/appearance/inert-held` | no | check 4 |
| A control in a body group or repeat its data node is not under, read by its data node (part 06's agreement refusal missed) | no | no | no | no | yes: `group`, `repeat` | check 5 |
| A choice's value changed or two choices reordered | no | no | no | yes: `choices` | yes | checks 4 and 5 |
| Two choices' labels swapped | no | no | no | no | yes: option labels | check 5 |
| A label bound to the wrong language | no | no | no | no | yes: per language | check 5 |
| A display condition, a validation or a Hidden Value's calculation dropped | no | no | no | no | yes: presence | check 5 |
| A required condition read as always required, or the reverse | no | no | no | no | half: HQ reports only `true()` | check 5 for `true()`; proof 3 for a condition |
| A hint, a help text or a validation message dropped or bound to the wrong question | no | no | no | no | no | nothing in production. Proof 6 over Nova-born documents; proof 3 on a base whose walk shows the text |
| `selected(#form/a, 'x')` read as `#form/a = 'x'` | no | no | no: the wrong tree prints and reads back as itself | no | no | the reader's own comparison of the source text with the production print (part 08, section 2.3), which fails where the trees differ. Past that, proof 3 with a value expectation that answers `a` with two choices |
| An expression bound to another question of the same type | no | no | no | no | no | part 08's comparison (the printed path differs from the source's) |
| A default read from the wrong event, or two defaults whose order matters | no | no | no | no | no | part 06's `loadOrderConflicts`; proof 3 |
| A case property written from the wrong question | no | no | no | yes: `properties` after the sibling map | no | check 4 |
| A case block's condition, close condition or index identifier lost | no | no | no | yes | no | check 4 |
| A child case read at another position, or a placement not held | no | no | no | yes: block `path` and `index` | no | check 4 |
| A form's case selection read wrongly (a parent selection missed) | no | no | no | yes: entry facts | no | check 4 |
| A menu's display condition claimed and dropped | no | no | no | no | no | part 07's (R2) projection equality over the menu; proof 3 on a base that holds one |
| A case list column, a sort rule or a filter read wrongly | no | no | no | no | no | part 07's (R2) over `projectCaseListForHq`; proof 3's list rows on the base |
| A search field or a search filter row read wrongly | no | no | no | no | no | part 07's (R2) and part 08's CSQL comparison; proof 3 with HQ's own search views |
| A form link's condition or carried value read wrongly | no | no | no | no | no | part 07's (R2) over `projectAfterSubmit`; proof 3's frames |
| A generated node of Nova's read as the author's question | no | no | yes: Nova then writes a second one | yes: an added leaf | yes: an unread row | checks 3, 4 and 5 |
| An author's Hidden Value folded as one of Nova's | no | no | no | no | no | not a behavior change: the fold requires the node's tree to equal the emitter's, so Nova writes the same node back |
| The reader returns one member of a canon pair for HQ's bytes and the other for Nova's | no | no | yes | | | check 3 |
| The reader offers a declaration the gate refuses | no | yes | | | | check 2 |
| A shape the gate refuses that no reader module names | no | yes | | | | check 2 |
| A form CommCare HQ's build treats specially (a visit schedule, a registry load) read as plain | no | no | no | yes: `unread` | no | check 4 |

**What production cannot hold, said once.** Checks 3 to 5 see structure, identity, text and presence.
They read no expression. A reader that mis-reads an expression consistently, in a way its own printed
text does not show, passes all five. What stands against that is, in order: the one recognition method
(parse, propose, print with the production emitter, compare trees), which makes a consistent mis-read
require the emitter to print the wrong tree as the source's own text; lane proof 3 on every HQ-authored
base, with its case database seeded from the source and not from D, and hand-written value
expectations as positive controls (part 14, 14-proof.md, sections 2.6 and 6.4); and the register's
both-ways judge,
under which a behavior difference no entry declares fails the base. The bound is base coverage, and
part 14 states which entries must be base-exhibited.

---

## 9. The canon list for Nova-born documents

A document made in Nova is not always in the reader's image: several documents can print one wire, and
some of what a document holds reaches no export. So for a Nova-born document D the claim is
`read(emit(D)) = canon(D)` (part 14, 14-proof.md, section 5.1), stated exactly as
`readBackDifferences(canonDocument(D), read(expandDoc(D)))` is empty. `canonDocument` applies a closed,
typed list, and `readBackDifferences` is the one read-back comparison (9.1), which
`canonReadBack.fuzz.test.ts` here and proof 6 in part 14 both make.

```ts
// lib/commcare/reader/canon.ts
export interface Canonicalization {
	readonly id: string;
	/** `one-wire`: two documents print the same bytes. `not-carried`: content no export holds. */
	readonly kind: "one-wire" | "not-carried";
	/** The document with every instance of the pair replaced by the member the reader returns. */
	apply(doc: BlueprintDoc): BlueprintDoc;
}
export const CANONICALIZATIONS: readonly Canonicalization[];
/** Every row applied in list order, repeated until none changes the document. */
export function canonDocument(doc: BlueprintDoc): BlueprintDoc;
```

`canon.ts` imports part 06's `assemble.ts::READER_CANONICAL_CHOICES`, each row of which is
`{ id, kind, apply }`, and part 08's `canonicalExpression`, and wraps each as a row, so one id has one
definition. Three rows are this file's own: `blank-translation-is-absent`,
`blank-optional-text-is-absent` and `purpose-notes-are-absent`. Every other row is written by the
reader module that makes the choice, and the last column names where. No row parses or prints: each
is a rewrite over the typed document.

| Id | Kind | The pair | The reader returns | Why both print the same bytes | Defined in |
|---|---|---|---|---|---|
| `root-question-lists-are-sections` | one-wire | a root of sections; a root of `fieldList` groups with no condition and no worker-added repeat | sections | `builder.ts::buildContainer` writes `appearance="field-list"` for a section and for a group that holds `fieldList`, over the same `<group ref>` and optional label; a section has no `relevant`, media or hint by schema. A group's label holds text alone (`lib/domain/fields/base.ts::containerFieldBase`), so label media is no part of the pair | part 06, section 16.2 |
| `translation-equal-to-source-is-absent` | one-wire | a translation equal to its source text; none | none | `localization.ts`'s projection gives a missing entry the current source | part 06, section 16.2 |
| `blank-translation-is-absent` | one-wire | in a document whose source language is its default (first) language: a translation of an itext role (`translationFill.ts::TRANSLATION_FILL_ROLES`) whose value is blank where its source is not; none | none | `lib/domain/translationFill.ts::filledProse` gives a blank value the default language's text, and a missing entry prints the source language's (`lib/domain/CLAUDE.md`, "Localization"). The two are one text only where the two languages are one, which every reading is (part 06, section 6.3). In a document whose source language is not its default the two print different texts (the default language's and the source language's), so they are no pair there and `apply` leaves such a document as it is | this part; part 06 reads the blank so (its section 12.2) |
| `out-of-date-translation-is-absent` | one-wire | a translation whose `sourceFingerprint` is not the current source's; none | none | a stale entry falls back to the current source | part 06, section 16.2 |
| `translation-provenance-is-read-as-reviewed` | not-carried | a current translation with any `origin`, `review` and `translatedFrom` | human, reviewed, from the source language | provenance is in no export | part 06, section 16.2 |
| `plain-flag-on-blank-text-is-absent` | one-wire | `plainLabel` or `plainHelp` on a text blank in every language; no flag | no flag | `buildXFormSource`'s `addItext` registers no entry for a text blank everywhere, so no form of it is written | part 06, section 16.2; the flags are part 03's (its section 8) |
| `plain-flag-under-plain-text-is-absent` | one-wire | `plainLabel` or `plainHelp` in a form that holds `plainText`; no flag | no flag | a form whose text formatting is off writes no markdown form for any text (part 03, section 8.3) | part 06, section 16.2 |
| `blank-container-label-is-absent` | one-wire | a group, repeat or section whose `label` has no parts; one with no `label` | no `label` | `addItext` answers `registered: false` for both, so neither writes a `<label>` | part 06, section 16.2 |
| `blank-optional-text-is-absent` | one-wire | a hint, a validation message, or a help text with no media, whose template is blank in every language; none | none | `addItext` answers `registered: false`, so `hasHint`, `hasHelp` and `hasValidationMessage` are false and no element or attribute is written | this part |
| `create-name-required-is-absent` | one-wire | a `required` condition on a question in `caseCreateNameFields` that is no Hidden Value; none | none | `builder.ts::buildFieldParts` deletes `vellum:requiredCondition` and writes `required="true()"` there whatever the slot holds | part 07, section 3.2 |
| `default-post-submit-is-absent` | one-wire | a form with no destinations whose `postSubmit` equals `defaultPostSubmit` for its type and menu; no `postSubmit` | none | every consumer reads `lib/domain/postSubmit.ts::effectivePostSubmit`, which answers the same destination for both | part 07, section 9.1 |
| `dormant-tile-cells` | one-wire | a tile cell `tileCellFor` gives no square for (the list's layout is not a tile, or the column is not shown in Results); none | none | `lib/domain/modules.ts::tileCellFor` gives a cell only under a tile layout and only for a column shown in Results, and every consumer calls it | part 07, section 11.5 |
| `unsorted-hidden-tile-columns-are-off-the-list` | one-wire | in a tile list, a column hidden from Results, shown on Details and holding no order rule, with `notOnList` and without it | the one that holds `notOnList` | in a tile list a column hidden from Results with no order rule is no field of the short detail either way (`lib/domain/caseListOrder.ts`, rule 1), so neither document writes one | part 07, section 11.6 |
| `registration-form-last` | one-wire | a registration form a list offers after an empty search at any place in its menu; the same form last | last | the emission plan moves the form into its own hidden menu, so its place among the menu's forms reaches no wire | part 07, section 8.7 |
| `unheld-placements-are-held` | one-wire | a document with a placement it does not hold (a case change, a form's own close in its own block, a query repeat, a menu emitted advanced); the same document holding every placement `lib/commcare/placementHolds.ts::placementsToHold` derives | holding | holding what the emission derives changes no byte (`lib/commcare/__tests__/heldPlacementEmission.test.ts`). `apply` is `holdPlacements` over `placementsToHold(doc)` | part 07, section 1 |
| `expression-print-collisions` | one-wire | every row of part 08's `PRINT_COLLISIONS` | the canonical tree | `printCollisions.test.ts` (part 08) | part 08, section 5.5 |
| `case-catalog-is-as-read` | one-wire | a document's `caseTypes` as authored; the catalog part 07 derives from the same document | the derived catalog | the emitter reads a property's type through `effectiveCaseTypes`, and part 07 declares a type exactly where a comparator or a search predicate reads one no writer gives; a label and an unread property reach no export | part 07, section 7 |
| `purpose-notes-are-absent` | not-carried | `Module.purpose` and `Form.purpose` (`lib/domain/modules.ts`, `lib/domain/forms.ts`) | absent | purpose notes are outside the wire inventory (`lib/commcare/CLAUDE.md`, "`APP_TEXT_UNREPRESENTABLE`") | this part |

Eighteen rows. Part 07's check of a form-builder save of Nova's Save to Case shapes adds none: where
the builder changed a block's structure the block is refused, and a canonicalization rewrites to a
member the reader returns, which a refused block is not.

Part 15 applies the `one-wire` rows alone, to the menus and forms a change made in CommCare HQ
touched, where that change does not fit Nova's own spelling of them (its section 2.5, step 9).

**The proof of each row** is one case of `lib/commcare/reader/__tests__/canon.test.ts`, or the test
the row names where one already prints both members: `unheld-placements-are-held` is held by
`heldPlacementEmission.test.ts`, and `expression-print-collisions` by part 08's
`printCollisions.test.ts`. A case of `canon.test.ts` builds the two documents of the pair from
production builders, runs `expandDoc` over each under identical options and, for an app that
declares Android, `compileLocalArchive`, and requires every emitted file byte for byte equal. A
`not-carried` row is the same test with the content present and removed. So a canonicalization can
never hide a difference a runtime reads. The test also holds `canonDocument` idempotent, and
`canonDocument(read(A)) = read(A)` over every retained read: the reader's own answer is already
canonical.

**Two pairs that look like pairs and are not.** A leaf's blank label and an absent one: a leaf has
no absent label (`lib/domain/fields/base.ts`). The section and field-list pair is part 06's first row,
narrower than it first looks: a `fieldList` group with a condition or a worker-added repeat inside it
is not a section and reads back as a group.

`canonReadBack.fuzz.test.ts` holds the list complete over the fuzz corpora, in ordinary CI. Its rule
for a failure is fixed. A sample that reads back to another document whose emission is byte-equal is
a pair: it joins the list, with its case in `canon.test.ts` or the test that already holds it. A
sample whose emission differs, or that reads as an account, is a reader defect: the reader module
that owns the slot is corrected, and nothing merges with it open.

### 9.1 The one read-back comparison

`canonReadBack.fuzz.test.ts` and proof 6 state one claim, so they make one comparison, beside
`lib/doc/documentDifferences.ts::documentDifferences` (section 14.2), which it calls:

```ts
// lib/deployment/reading/readBack.ts
/** One differing path between the document a read back must give and the one it gave. */
export type ReadBackDifference = DocumentDifference; // lib/doc/documentDifferences.ts, 14.2

/** What a read back gave. */
export interface ReadBack {
	readonly doc: BlueprintDoc;
	/**
	 * The declarations the reading offers (`ReadDraft.declaration.choices`; empty where its kind is
	 * `none`). Null where the comparison is made whole: `doc` was read under one declaration and
	 * already holds that declaration's mutations, as a base's first reading does (part 14, 5.1).
	 */
	readonly choices: readonly DeclarationChoice[] | null;
}

export function readBackDifferences(
	expected: BlueprintDoc, read: ReadBack,
): readonly ReadBackDifference[];
```

In order:

1. Both documents lose every entity of a kind part 10's `KINDS_WITH_NO_EXTERNAL_KEY` names
   (`lib/commcare/reader/identity.ts`, its section 2.2: user types, personas, and automations with
   their criteria, setup-only criteria, updates, recipients, events and user-data filters), with
   the membership arrays that order them. CommCare HQ's app holds nothing of those kinds, so no
   reading returns one.
2. Where `read.choices` is not null, `expected` loses `appSettings.runsOnlyOn`: the reader never
   writes it and returns the choices beside the document (section 5.4).
3. `documentDifferences(expected, read.doc)` over the two.
4. Where `read.choices` is not null and no choice's `runsOnlyOn` is the declaration `expected` held
   (absent on both sides for Web Apps and Android), one more difference, `{ path: ["appSettings",
   "runsOnlyOn"], kind: "value" }`: the reading does not offer the declaration the document states.

Where `read.choices` is null nothing is taken out in step 2 and step 4 is not run, so the two
documents are compared with their declarations in place.

Part 15 is its third caller: it asks whether two readings of CommCare HQ's app are one document
(its section 2.5, step 4), with `choices: null`.

It is pure, imports no `reader/canon.ts` (a caller applies `canonDocument` to `expected` where its
claim has one, as that test does and as proof 6 does for a Nova-born document), and is no part of
`acceptReading`: check 3 compares a reading with its own re-read exactly (section 5.3) and never
leaves a kind out. `lib/deployment/reading/__tests__/readBack.test.ts` holds each step, and part
14's `proof/reader/cli.ts` imports the function for proof 6, so `proof/reader/` holds no comparison
of its own (part 14, section 5.2).

**Where `canon` ends and the comparison begins.** Content no export holds is in one of two places
and never both. A `not-carried` row of `CANONICALIZATIONS` removes content inside an entity the
comparison does compare (a translation's provenance, a menu's or a form's purpose note).
`KINDS_WITH_NO_EXTERNAL_KEY` names whole entity kinds no wire carries and so no reading returns,
which step 1 leaves out of both documents. The case catalog is no such kind: what a Nova-born
document's catalog holds beyond what the reader derives is the canon row `case-catalog-is-as-read`.
`lib/deployment/reading/__tests__/notCarried.test.ts` holds three things: no `not-carried` row's
`apply` changes anything inside a kind `KINDS_WITH_NO_EXTERNAL_KEY` names; every entity map the
document schema declares (read from the keys of `lib/domain/blueprint.ts`'s document object schema)
is either a kind that list names or one in which a planted change shows as a difference of
`readBackDifferences`; and the content each `not-carried` row removes shows as a difference when the
row is left out. So the two are disjoint, and nothing leaves the comparison unnamed.

**One read back over CommCare HQ's own retained answers.** Proof 6 is the only check that reads Nova's
export after CommCare HQ stored and served it, and it runs in the lane. One case of it can run with
no Docker, over files that exist or that part 05 already retains:
`proof/hq-reads/navigation-base/app-source.json`, `proof/hq-reads/reading/application.json` and
`proof/hq-reads/reading/current-version.json` (part 05, 05-reading-commcare-hq.md, section 14.1) are
CommCare HQ's answers for the corpus document `navigation-base`.
`lib/deployment/reading/__tests__/readBack.retained.test.ts` reads them through the production
reader and requires `readBackDifferences(canonDocument(D), read(served(D)))` empty, D being that
document built by its producer. It shows a read back that fails on a source CommCare HQ normalized
before a push does. The source read carries no version (`models/applications.py::
Application.export_json` deletes every key of `_meta_fields`), so the three files agree unless
part 05's bracket compares something the two retained groups made differently. Both outcomes are
decided: where the bracket closes over the three files the case is written; where it does not, the
case is not written, no file is added, and proof 6 alone holds the read back of a served source.

---

## 10. The rewrite registry, and the sites it does not hold

`lib/commcare/emissionRewrites.ts::EMISSION_REWRITES` is part 08's (08-the-reader-expressions.md,
section 2.3): nine rows, each a rewrite the reader of CommCare HQ's apps prints without, or reports.
`EmissionRewrite` is `{ behavior }`. This part reads it in one assertion of
`firstPublishChanges.test.ts`: every id whose `behavior` is `changes` is an id of
`FIRST_PUBLISH_CHANGE_IDS` whose entry touches workers. So the reader's report of a rewrite is, by
its id, the entry a person is shown.

Fourteen other places write something a source made in CommCare HQ would spell another way. None is a
row: no print leaves one out, and no register predicate reads a report of one. Each is decided in
section 11.4, and each site carries a comment naming that decision.

| Site | Decided by |
|---|---|
| `xform/builder.ts::buildFieldParts`, the required stamp | exact: section 11.4, "A case name required" |
| `buildFieldParts` (`scalarCheck`); `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards` | `case-names-checked` |
| `buildFieldParts` (the `trimmed` sibling); `casePlacementPlan.ts::planFormCaseWire` (`questionPath`) | `case-names-checked` |
| `planFormCaseWire`, `update_case.condition` | `case-settings-respelled`, or the two refusals of section 11.4 |
| `planFormCaseWire` (`updateMap`), an external id | `case-settings-respelled` |
| `planFormCaseWire`, a basic child's `reference_id` | `case-settings-respelled` |
| `buildFieldParts`, a default that is a preload | `case-settings-respelled`; refused where a later load-time value reads the question |
| `xform/builder.ts::inDataTreeOrder` | exact; refused where one default reads what another sets |
| `hqShells.ts::applicationShell`, `location_fixture_restore` | `location-list-setting-reset` |
| `expander.ts::appLevelValues`, `applicationShell`, `auto_gps_capture` | `connect-app-captures-location` |
| `applicationShell`, `cloudcare_enabled` | `web-apps-turned-off`, `web-apps-turned-on` |
| `xform/constraintMessage.ts::protectConstraintMessage` | `validation-messages-composed` |
| `xform/builder.ts::literalLabelNodes`, label text holding `instance(` (part 03, section 5) | exact: no runtime reads label text as a path |
| `buildFieldParts` (the `datetime` sibling); `xform/datetimeCaseValue.ts::datetimeCaseValue` (part 03, section 7.1) | refused where an app made in CommCare HQ saves the question straight to a case: `forms-and-case-writes/a-datetime-question-saved-straight-to-a-case`. Declared where the source holds the spelling Nova wrote before this step: `date-and-time-saved-as-hq-stores-it` |

What no test can hold is a place nobody listed. That is held from outside the emitter: on every
HQ-authored base, a difference no applying entry covers fails the base (section 13.3).

---

## 11. `FIRST_PUBLISH_CHANGES`

Nova writes its own spelling of every form. Spelling is free; behavior is not, which is the bar's
clause (b). The register is the closed list of what a first publish over an adopted app may change.

### 11.1 The type

```ts
// lib/publish/firstPublishChangeIds.ts  (client-safe; lib/publish may not import lib/commcare)
export const FIRST_PUBLISH_CHANGE_IDS = [ /* the 31 ids of 11.2, in its order */ ] as const;
export type FirstPublishChangeId = (typeof FIRST_PUBLISH_CHANGE_IDS)[number];
export interface FirstPublishView {
	readonly ids: readonly FirstPublishChangeId[];
	readonly touchesWorkers: boolean;
	/** Which kind of list this is (`StoredFirstPublish.of`, below). */
	readonly of: "first-publish" | "next-publish";
}
export const firstPublishViewSchema: z.ZodType<FirstPublishView>;
/** The register's `touchesWorkers` column as client-safe data (12.2). */
export const FIRST_PUBLISH_TOUCHES_WORKERS: Readonly<Record<FirstPublishChangeId, boolean>>;
/** Ids another entry's sentence says to a person. */
export const FIRST_PUBLISH_SAID_BY = {
	"search-filter-rows-recut": "forms-and-settings-rewritten",
	"list-settings-respelled": "forms-and-settings-rewritten",
} as const satisfies Partial<Record<FirstPublishChangeId, FirstPublishChangeId>>;
/** The ids that have a sentence of their own. */
export type FirstPublishSentenceId =
	Exclude<FirstPublishChangeId, keyof typeof FIRST_PUBLISH_SAID_BY>;
/** The id whose sentence says `id` to a person: its own, or the one `FIRST_PUBLISH_SAID_BY` names. */
export function firstPublishSentenceId(id: FirstPublishChangeId): FirstPublishSentenceId;
/** What a baseline keeps of a list (12.3). */
export interface StoredFirstPublish {
	/** The ids that applied under the chosen declaration, less the two Web Apps ids. */
	readonly ids: readonly FirstPublishChangeId[];
	/** CommCare HQ's Web App setting as the reading held it (`HqAppSource.cloudcareEnabled`). */
	readonly webAppsOnInHq: boolean;
	/** `first-publish`: the list of an app brought in and not yet published. `next-publish`: what
	 *  the next publish changes after a bring-in of changes (part 15, section 4.4). */
	readonly of: "first-publish" | "next-publish";
}
export const storedFirstPublishSchema: z.ZodType<StoredFirstPublish>;
/** The list as it stands for an app that now declares `runsOnlyOn` (12.3). */
export function firstPublishViewFromStored(
	stored: StoredFirstPublish, runsOnlyOn: Platform | undefined,
): FirstPublishView;

// lib/deployment/reading/firstPublishChanges.ts
/** Nodes Nova's emission holds that the source did not, and the reverse (part 06, 13.4). */
export interface GeneratedDifference {
	readonly added: readonly ReadGeneratedNode[];
	readonly dropped: readonly ReadGeneratedNode[];
	readonly renamed: readonly { readonly from: ReadGeneratedNode; readonly to: ReadGeneratedNode }[];
}
/**
 * `before`: what a source held. `after`: what Nova writes for a document. One list per form.
 * A node whose purpose `GENERATED_NODE_CHANGE` maps to `identity` is left out of both lists: a
 * guard is a case block, and check 4's row 8 compares it.
 */
export function generatedDifference(
	before: readonly (readonly ReadGeneratedNode[])[],
	after: readonly (readonly ReadGeneratedNode[])[],
): GeneratedDifference;
/**
 * What Nova writes for `doc`, as the reader would list it: one list per entry of `forms`, which
 * the caller gives in the order of `ReadFacts.forms`, each form found by its `xmlns` through
 * `draft.identities.forms`.
 */
export function emittedGeneratedNodes(
	doc: BlueprintDoc, forms: readonly { readonly uuid: Uuid }[],
): readonly (readonly ReadGeneratedNode[])[];

export interface FirstPublishFacts {
	readonly source: HqAppSource;
	/** The document under the declaration choice being judged. */
	readonly doc: BlueprintDoc;
	readonly facts: ReadFacts;
	/** The reading's folded nodes against what Nova writes for `doc` (12.1). */
	readonly generated: GeneratedDifference;
	/** `assignMediaPaths` over the held files, keyed by content (12.1). */
	readonly media: MediaPathAssignment;
	/** Media references that point at no file and are left out (part 11, `HqMediaPlan.inert`). */
	readonly mediaLeftOut: number;
	readonly choice: { readonly runsOnlyOn: Platform | null; readonly split: boolean };
}

export interface FirstPublishChange {
	/** Whether a worker meets the change. A `proof3` row of the lane stands only under such an entry. */
	readonly touchesWorkers: boolean;
	/**
	 * `declaration`: the predicate reads `choice.runsOnlyOn`, which a person can change in the
	 * builder afterwards, so the id is never stored and is worked out again (12.3).
	 * `reading`: every other entry. Its id is stored at the birth.
	 */
	readonly scope: "reading" | "declaration";
	applies(facts: FirstPublishFacts): boolean;
	/** JSON Pointers over CommCare HQ's stored app, `*` for a position or an app's own key,
	 *  under which the stored source may differ because of this entry. */
	readonly paths: readonly string[];
}
export const FIRST_PUBLISH_CHANGES: Readonly<Record<FirstPublishChangeId, FirstPublishChange>>;
/** The one builder of a `FirstPublishFacts` (12.1). */
export function firstPublishFactsOf(input: {
	readonly source: HqAppSource;
	/** The document under the declaration choice being judged. */
	readonly doc: BlueprintDoc;
	readonly facts: ReadFacts;
	/** The forms of `facts.forms`, in its order, as `emittedGeneratedNodes` takes them. */
	readonly forms: readonly { readonly uuid: Uuid }[];
	/** The files the media path assignment is made over (12.1). */
	readonly mediaFiles: readonly AdoptedMediaFile[];
	readonly mediaLeftOut: number;
	readonly choice: { readonly runsOnlyOn: Platform | null; readonly split: boolean };
}): FirstPublishFacts;
export function firstPublishChangesFor(facts: FirstPublishFacts): FirstPublishView;
```

Where a change comes from (a rewrite, a generated node, a key of the update's body, something
CommCare HQ's own import does) is the doc comment on its entry, with the `path::symbol`.

`generatedDifference` matches the two lists form by form on `(purpose, owner)`. Within one such pair
the nodes of each side are taken in code-unit order of `name` and paired in that order (a question
can own several counts lifted from one validation): a pair whose names differ is `renamed`, a node of
`after` left over is `added`, a node of `before` left over is `dropped`.

`before` is the reading's own list, `facts.forms[i].generated`. `after` is
`emittedGeneratedNodes(doc, forms)`: `generatedNodes.ts::generatedNodePaths(doc, formUuid)` (section
6.3) for each form, each node as a `ReadGeneratedNode` with the `purpose`, `name` and `path` the plan
gives and the `owner` key part 06 records for it (its section 17.3, one rule: the
owner question's data path for a question's node, and for an operation's node the data path of its
`nova_operations` scope, a `#`, and the operation's id). It is computed from the document under the
choice being judged and never from check 3's re-read. A re-read is of D or of the split document,
and a choice's list must be that choice's own document's. Planned from the choice's own document, a
choice's list is a function of the reading and the choice alone. `generatedNodes.parity.test.ts`
holds the two builders to one key: over every retained read and the fuzz corpora, the reader's
`generated` list for Nova's emission of a document equals `emittedGeneratedNodes` of that document
as sets of `(purpose, owner, name, path)`. Part 15 builds a second reading's list through the same
two functions, by section 12.1's builder (its section 2.5, step 13).

`firstPublishChangesFor` returns the ids whose `applies` is true, in the order of
`FIRST_PUBLISH_CHANGE_IDS`, `touchesWorkers` true where any of them has it, and `of` as
`first-publish`. The sentence of each id is copy:
`lib/publish/firstPublishCopy.ts::FIRST_PUBLISH_SENTENCES[firstPublishSentenceId(id)]` (Copy), a
record total over `FirstPublishSentenceId`.

`MEDIA_REFERENCE_PATHS`, used below, is the list of pointers a media reference lives under:
`/_attachments/*`, `/modules/*/media_image/*`, `/modules/*/media_audio/*`,
`/modules/*/case_list/media_image/*`, `/modules/*/case_list/media_audio/*`,
`/modules/*/case_list_form/media_image/*`, `/modules/*/case_list_form/media_audio/*`,
`/modules/*/forms/*/media_image/*`, `/modules/*/forms/*/media_audio/*`,
`/modules/*/case_details/*/columns/*/enum/*/value/*` and `/logo_refs/*`. `firstPublishChanges.test.ts`
holds it to the slots part 11's `hqMediaReferencesOf` reads.

### 11.2 Every entry

Thirty-one entries, in registry order. In the `applies` column `f` is the `FirstPublishFacts` the
predicate is given: `f.source` is CommCare HQ's source, `f.doc` the document under the choice,
`f.facts` the reader's `ReadFacts`, `f.generated` the generated difference, `f.media` the path
assignment, `f.mediaLeftOut` and `f.choice` as typed above. The first column is the entry's place in
the order and nothing cites it: every sentence names an entry by its id.

| # | Id | `applies` | `paths` | Workers |
|---|---|---|---|---|
| 1 | `forms-and-settings-rewritten` | always | `/_attachments/*`; `/modules/*/forms/*/case_references_data/load`; `/modules/*/case_details/short/filter`; `/created_from_template`; and, in the lane, every pointer the base's claim log holds under an entry whose standing is `inert` (13.2) | no |
| 2 | `hidden-values-added` | `f.generated.added`, `.renamed` or `.dropped` is not empty | `/_attachments/*` | no |
| 3 | `case-names-checked` | `f.generated.added` holds a `trimmed` node | `/_attachments/*`; `/modules/*/forms/*/actions` | yes |
| 4 | `validation-counts-moved` | `f.generated.added` holds a `constraint-count` node | `/_attachments/*` | yes |
| 5 | `validation-messages-composed` | `f.generated.added` holds a `constraint-message` node | `/_attachments/*` | yes |
| 6 | `instant-comparison` | `f.facts.rewrites` holds the id | `/_attachments/*`; `/modules/*/module_filter`; `/modules/*/forms/*/form_filter`; `/modules/*/forms/*/form_links/*`; `/modules/*/case_details/*`; `/modules/*/search_config/*` | yes |
| 7 | `empty-rows-guard` | the same test for its id | the paths of `instant-comparison` | yes |
| 8 | `absent-session-value-guard` | the same | the paths of `instant-comparison` | yes |
| 9 | `row-predicate-current` | the same | `/_attachments/*` | yes |
| 10 | `search-value-guards` | the same | `/modules/*/search_config/*` | yes |
| 11 | `search-today-device-day` | the same | `/modules/*/search_config/*` | yes |
| 12 | `case-settings-respelled` | `f.facts.sameStateRewrites` holds a record whose `register` is the id | `/modules/*/forms/*/actions`; `/_attachments/*` | no |
| 13 | `search-filter-rows-recut` | the same test for its id | `/modules/*/search_config/default_properties` | no |
| 14 | `sort-rule-kept-as-hidden-column` | the same | `/modules/*/case_details/short/columns`; `/modules/*/case_details/short/sort_elements/*/type`; `/modules/*/case_details/short/sort_elements/*/display` | no |
| 15 | `list-settings-respelled` | the same | `/modules/*/case_details/short/max_select_value`; `/modules/*/case_details/short/sort_elements`; `/modules/*/search_config/title_label`; `/modules/*/search_config/description` (the last two for a search text map that lacks a language where every language is blank, part 07, section 12.4); `/modules/*/case_list/label` (a case list menu item's label with no text, read as "Case List", part 07, section 8.6) | no |
| 16 | `search-filter-joined-to-list` | the same | `/modules/*/case_details/short/filter` | no |
| 17 | `search-restates-list-filter` | the same | `/modules/*/search_config/default_properties` | yes |
| 18 | `link-held-case-guards-added` | the same | `/modules/*/forms/*/form_links/*/xpath` | yes |
| 19 | `registration-label-fixed` | the same | `/modules/*/case_list_form/label/*` | yes |
| 20 | `date-and-time-saved-as-hq-stores-it` | the same | `/_attachments/*` | yes |
| 21 | `connect-app-captures-location` | `f.doc.connectType` is set and `f.source.raw.auto_gps_capture` is not `true` | `/auto_gps_capture` | yes |
| 22 | `translation-overrides-folded` | `f.facts.foldedTranslationKeys` is above zero (part 06, section 17.3) | `/translations/*/*`; `/modules/*/name/*`; `/modules/*/forms/*/name/*`; `/modules/*/case_list/label/*`; `/modules/*/case_list_form/label/*` | no |
| 23 | `location-list-setting-reset` | `f.source.raw.location_fixture_restore` is `both_fixtures` or `only_flat_fixture` | `/location_fixture_restore` | no |
| 24 | `web-apps-turned-off` | `f.source.cloudcareEnabled` and `f.choice.runsOnlyOn` is `android` | `/cloudcare_enabled` | yes |
| 25 | `web-apps-turned-on` | not `f.source.cloudcareEnabled` and `f.choice.runsOnlyOn` is not `android` | `/cloudcare_enabled` | yes |
| 26 | `date-and-time-questions-split` | `f.choice.split` | `/_attachments/*`; `/modules/*/forms/*/actions` | yes |
| 27 | `blank-translations-filled` | some `f.facts.forms[i].blankTranslations` is above zero (part 06, sections 12.2 and 17.3) | `/_attachments/*` | yes |
| 28 | `media-paths-joined` | `f.media.collapsed` is not empty | `/multimedia_map/*`; `MEDIA_REFERENCE_PATHS` | no |
| 29 | `media-files-renamed` | `f.media.rederived` is not empty | `/multimedia_map/*`; `MEDIA_REFERENCE_PATHS` | yes |
| 30 | `media-references-with-no-file-removed` | `f.mediaLeftOut` is above zero (part 11, section 3.2) | `MEDIA_REFERENCE_PATHS`; `/multimedia_map/*` | no |
| 31 | `unused-media-entries-removed` | some path of `f.source.multimediaMap` is the `path` of no entry of `f.facts.mediaReferences` and of no entry of `f.source.logoRefs` | `/multimedia_map/*` | no |

`web-apps-turned-off` and `web-apps-turned-on` have `scope: "declaration"`. Every other entry has
`reading`. `date-and-time-questions-split` reads what the chosen declaration did to the document at
the birth, which no later edit undoes, so it is stored like any other.

**`forms-and-settings-rewritten` applies on every reading.** Nova writes every form again in its own
spelling, and CommCare HQ's import marks every app it updates:
`views/app_import_api.py::import_app_api` sets `created_from_template` on every import, and no body
can prevent it. No page and no runtime reads that key (its readers are the `applications_brief`
view's map, the Elasticsearch mapping and `es/apps.py::created_from_template`), so the pointer is
allowed here and no line of its own says it.

**`unused-media-entries-removed`'s predicate is HQ's own test, over what Nova sends.** The prune
keeps a path in `all_media_paths() | logo_paths` (`remove_unused_mappings`), and it runs at the end
of the import, after Nova's body is merged (`overwrite_app_from_source`,
`_update_valid_domains_for_media`). So the paths it keeps are the ones Nova's forms and menus name,
which are the reading's resolved references, and the logo entries, which Nova's body leaves as
CommCare HQ holds them. A reference with no file is in neither set: Nova leaves it out
(`media-references-with-no-file-removed`), and where the map held an entry for its path naming no
file, that entry goes with it, which is why that entry allows `/multimedia_map/*` too.

**`registration-label-fixed`.** A `case_list_form` label beside a `form_id` that holds no text, in
every language or in one whose value is an empty string, is read as "Create a new Case" there, the
words HQ's build writes for it, and the menus reader appends a record under this id to
`ReadFacts.sameStateRewrites` where it reads the block. A language the label holds no key for is no
translation and records nothing. Part 02 decides both (02-menus.md, section 11.8), and the block's
reader is part 07's (07-the-reader-cases-menus-lists.md, section 8.7). CommCare HQ's fallback goes
through `gettext` and a toggle of the project space
(`app_strings.py::_create_case_list_form_app_strings`), so a build could show other words before.
After the first publish every build shows the label Nova writes. A worker reads that text, so the
entry touches workers.

**`date-and-time-saved-as-hq-stores-it`.** Part 03 changes the text Nova writes for a date and time
on a case: the moment as CommCare HQ stores it, where Nova wrote the device's own clock with its
offset before this step (03-questions-and-text.md, section 7.1). An app Nova published before this
step holds the earlier spelling in its forms, in each `nova_datetime_` sibling and in each Save to
Case value written to a date-and-time property, and it comes in like any other app once no Nova app
publishes to it (part 10, 10-identity-and-the-ledger.md, section 5). The reader reads both
spellings as the same write (part 03, section 7.1, "The reader's side"), so the document is the one
the current spelling gives, and it appends a record under this id to `ReadFacts.sameStateRewrites`
wherever it met the earlier one: where part 06 folds a sibling whose calculation is the earlier
tree, and where part 07 reads a Save to Case value in the earlier spelling. After the first publish
a phone keeps CommCare HQ's text for a case it saves, where it kept its own zone's before, so a
list sorted by that property places that case among the others and a plain column shows the new
text. A worker's phone meets that, so the entry touches workers. An app made in CommCare HQ holds
neither spelling (a question it saves straight to a case is refused, section 11.4), so the entry
never applies to one. No check of acceptance stands in the way: check 3's two readings give one
document, check 4 reads no expression, and check 5 reads only whether a calculation is present.

### 11.3 How the table is held complete

- **By the id types.** `FIRST_PUBLISH_CHANGES` and `FIRST_PUBLISH_SENTENCES` are records over
  `FirstPublishChangeId`, so an id without an entry or a sentence fails `tsc`.
- **By `GeneratedNodePurpose`.** `firstPublishChanges.ts::GENERATED_NODE_CHANGE` is a
  `Record<GeneratedNodePurpose, FirstPublishChangeId | "identity">`: `trimmed` to
  `case-names-checked`, `constraint-count` to `validation-counts-moved`, `constraint-message` to
  `validation-messages-composed`, `guard` to `identity`, and the other thirteen to
  `hidden-values-added`, part 03's `instant` among them (its section 7.1). A purpose the emitter
  gains fails `tsc` here, and whoever adds it decides in
  this record whether a node of it is an answer leaf nobody acts on, a declared change, or a case
  block. `identity` means no entry declares the purpose: a guard refuses a submission, so one added
  or dropped is check 4's difference (section 6.3) and never a line a person is asked to accept.
  `generatedDifference` leaves the purpose out, so the register is never asked about a guard. A test
  holds each named entry's `applies` true for a difference that adds a node of that purpose,
  `hidden-values-added` true for every purpose but `guard` (a trimmed sibling is a new export column
  too), and a difference of guards alone empty.
- **By `EMISSION_REWRITES`.** Every id whose `behavior` is `changes` is an id of this table whose
  entry touches workers (`firstPublishChanges.test.ts`).
- **By the reader's same-state rules.** `firstPublishChanges.test.ts` requires every record of
  `ReadFacts.sameStateRewrites`, over every retained read, to name an id of this table whose `paths`
  cover the record's `path`. Part 07's `rewrites.test.ts` requires every same-state rule in its code to
  carry an id. The one id recorded outside part 07's rules, `date-and-time-saved-as-hq-stores-it`,
  has its two recording sites held by two cases of `firstPublishChanges.test.ts` (Tests).
- **By the lane.** Part 14's both-ways judge (14-proof.md, section 9.3) runs on every HQ-authored
  base, in the dispatches over the bases that the session starts before the merge and in every
  scheduled lane after it. Where it reports a difference no applying entry holds, the session
  classes it by part 14's outcome table (14-proof.md, "Written and not yet run"), which is the one
  classification of a lane difference. Under its outcome C1, a change Nova's spelling makes on
  purpose and of a kind this register is drawn from, the session adds the entry by section 11.1's
  type (its predicate over the reading's facts, the `source` pointers the run showed,
  `touchesWorkers` true where a build file or a served walk differs and false where only the stored
  source does), writes its sentence in the voice of Copy C2 with no argument, and places it on the
  base that showed it. A change of any kind the register is not drawn from is never an entry: it is
  part 14's C2. A predicted id nothing shows has its predicate narrowed to the reading's fact that
  tells the base apart. Nothing waits on a person.

Where part 07's comparison of its same-state readings over the bases (its "Written and not yet run")
shows a build file that differs, the reading's row of part 07's section 13.3 is already an entry of
section 11.2.

### 11.4 The decision for every candidate

For each candidate change: **exact** (the original's behavior is read exactly, so nothing a runtime
reads changes), **refuse** (the reader raises a finding and no such app comes in), or **declare** (an
entry above). None is left undecided.

| Candidate | Decision | How |
|---|---|---|
| A case name saved trimmed | declare, `case-names-checked` | Nova always writes the trimmed sibling for a question a name comes from. Holding an untrimmed name would be a second spelling of one concept that exists only because CommCare HQ's build has it |
| A case name required | exact | HQ's build stamps `required="true()"` on the same bind; the reader claims the source's own `required` there under the INERT entry `questions/bind-required-on-the-question-that-names-a-created-case` and holds no condition (part 07, section 3.2; canon `create-name-required-is-absent`) |
| A case name or external id capped at 255 characters, a name not blank after the trim | declare, `case-names-checked` | the check is on the question a worker answers |
| An external id held in `open_case` | exact | part 07 reads it as a write of the own arm; the build writes the same `<update>` leaf (`case-settings-respelled`, no behavior) |
| A child case's index named `parent` | exact | CommCare HQ's build reads `subcase.reference_id or 'parent'` (`xform.py::XForm._create_casexml`), and Nova writes `""` (`casePlacementPlan.ts::planFormCaseWire`). The stored spelling is `case-settings-respelled`'s |
| A help text with no markdown form | exact | part 03 (its section 8) holds `plainHelp`, and Nova writes no markdown form for it. Nothing is left to declare |
| A hint or a validation message with or without a markdown form | exact | no runtime reads a hint's or a validation message's markdown form (part 03, section 8.1), so the copy is inert and Nova writes none (part 03, section 8.2). Nothing is left to declare |
| A label or a choice with no markdown form | exact | `plainLabel`, read from the form's presence (part 06, section 12.2) |
| A form whose text formatting is off | exact | `Form.plainText` (part 03, section 8.3) |
| `update_case.condition` of `never` or `if` | exact on the shapes part 07 holds; refuse the two it does not | part 07, section 3.2; `forms-and-case-writes/update-case-condition-never-on-a-follow-up-with-no-other-active` (REFUSED, not HQ-editable) and `forms-and-case-writes/update-case-condition-if-whose-question-is-gone` (REFUSED, not HQ-buildable) are both `fix-in-hq` |
| `update_mode: edit` on a form's own update of a case it requires | exact | part 07, section 3.2: the read probes the source project space's flag (part 05, section 10.5). Where the project space applies the word, the write reads as saved only if changed. Where it does not, the write reads as saved every time, which is what the source's build does, and the stored word differs as spelling under `case-settings-respelled` |
| `location_fixture_restore` of `both_fixtures` or `only_flat_fixture` | declare, `location-list-setting-reset` | the manifest holds both as the same state for everything a held app reads; the stored setting changes |
| `location_fixture_restore` of `only_hierarchical_fixture` | refuse | manifest row `application-and-settings/50pp-hq-location-fixture-restore-only-hierarchical-fixture`, `never` |
| `created_from_template` | exact | CommCare HQ's import view sets it on every import and no body can prevent it. No page and no runtime reads it, so no line says it. The pointer is one of `forms-and-settings-rewritten`'s |
| The pruned media map | declare, `unused-media-entries-removed` | HQ's import runs the prune and saves |
| A generated translation key in `translations` | exact where it has no effect or is blank; declare where it folds (`translation-overrides-folded`); refuse otherwise | part 01, section 7.1; part 06, section 16.5 |
| The translation keys Nova writes itself (`homescreen.title`, `app.display.name`, a language's name) | exact | the first two are the app's name where it differs by language, read into the name's translations; a language's name is kept at CommCare HQ's value on an adopted deployment (part 10) |
| Preload order | exact where no later load-time value reads the question; refuse otherwise | part 07, section 3.7 (`laterLoadReaders`), `not-yet` |
| The order of two defaults | exact where it does not matter; refuse where one reads what the other sets | part 06, section 11.3, `fix-in-hq` |
| A default's read spelled absolute, where Nova writes `current()` | exact | Core resolves both to one node (part 08, 08-the-reader-expressions.md, "Executed during planning"). A read inside a row predicate is `row-predicate-current`'s |
| A date and time question saved straight to a case | refuse | part 07, section 3.2, under `forms-and-case-writes/a-datetime-question-saved-straight-to-a-case` (`not-yet`). The source stores the day alone and Nova would store the moment |
| A date and time written through Nova's own sibling or Save to Case value, in the spelling Nova writes | exact | the reader folds the sibling and reads the value it recognizes (part 03, section 7.1) |
| The same, in the spelling Nova wrote before this step | declare, `date-and-time-saved-as-hq-stores-it` | section 11.2: the reader reads it as the same write, Nova writes CommCare HQ's spelling back, and a phone then keeps other text for a case it saves |
| A sort rule over a date and time property | exact | part 03, section 7.1: the fix is in the text a phone writes, so the list's order rule, its sort element and its columns are written as the source holds them |
| The date and time split | declare, `date-and-time-questions-split`, only where the person chose it | part 06, section 16.3 |
| New export columns from generated nodes | declare, `hidden-values-added` | each generated leaf is a new column of CommCare HQ's form export |
| A generated node renamed (a suffix that moved) | declare, `hidden-values-added` | the column starts again under the new name |
| An itext id an expression reads through `jr:itext` | exact | part 08 binds the read to the text it names and prints Nova's id for that text; an itext id is local to one form's source. Covered, as spelling, by `forms-and-settings-rewritten` |
| `case_references_data.load` | exact | only CommCare HQ's app summary reads it; `proof/rules/case_references_load.py` erases it as a proven spelling rule |
| `case_references_data.save` | exact, or refuse | equal to the form builder's own computation (`forms-and-case-writes/case-references-data-save-equal-to-vellum-s-computation-from-the`, HELD) or refused (`forms-and-case-writes/case-references-data-save-differing-from-that-computation`) |
| A guard block Nova writes beside a case operation | exact, or acceptance fails | part 07 reads an operation only with its guards in place, so the emission's guards are the source's; one added or dropped is check 4's difference (section 6.3), never a declared change |
| A count inside a validation | declare, `validation-counts-moved` | part 08, section 2.3 |
| A validation message that shows an answer | declare, `validation-messages-composed` | `lib/commcare/CLAUDE.md`, "Markdown itext": the composition deliberately does not claim identical error handling |
| A translation left blank in a language other than the first, where the first holds text | declare, `blank-translations-filled` | Nova's projection fills it as the form builder does on every save; a deliberately blank translation is not a concept Nova holds |
| A text left blank in the first language where another language holds it | refuse | part 06, section 12.2, under `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text`: no first-language text exists for Nova's fill to take, and the form builder would fill it from whichever language holds text |
| `auto_gps_capture` off on a CommCare Connect app | declare, `connect-app-captures-location` | part 01, section 4.3 |
| `cloudcare_enabled` | declare where the chosen declaration differs from it; the publish also asks before it changes the setting, as it does today | `lib/deployment`'s Web Apps question (step 4) |
| A case detail column the list lacks | exact | part 07, sections 11.3 and 11.6: it is read as a column that is not on the list (`Column.notOnList`), which is no field of the short detail and is matched by no list filter, so Nova writes the short detail without it, as the source holds it |
| A media path Nova cannot hold | declare, `media-paths-joined` and `media-files-renamed` | part 10, section 4.2 |
| A held media path after the bulk upload | exact | part 10, section 4.7, with its evidence in that part's "Executed during planning": the next build keeps a path's version where its `multimedia_id` is the same, and the base `hq-media` asserts it |
| A media reference with no file | exact where no runtime draws it (left out, `media-references-with-no-file-removed`); refuse otherwise | part 11, section 3.2 |
| A logo entry with no `m_id` | refuse | part 06, section 6.1, under `application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`. No editor of CommCare HQ writes one, and Web Apps and the Android profile read its path whether or not it names a file |
| The data node's `name` and `<h:title>` | exact | part 06 claims both as derived from the form's name; Nova writes the first language's name, which is what a save in the form builder writes |
| A form's name, or a CommCare Connect block's name or description, holding `instance(` and a quoted id | refuse | part 03, section 5.1: no spelling of plain text keeps CommCare HQ's instance scan out, so the gate refuses the text (`FORM_TEXT_READ_AS_INSTANCE`), and the reader raises `forms-and-case-writes/form-name-read-as-an-instance` and `questions/connect-block-text-read-as-an-instance` for an app that holds it (part 06, sections 7.4 and 15). No register entry is added |
| Label text holding `instance(` | exact | part 03, section 5: Nova splits the text with a literal output, and no runtime reads label text as a path |
| A Register button's label with no text, in every language or in one | declare, `registration-label-fixed` | part 02, section 11.8: read as "Create a new Case" in each such language, the words HQ's build writes; a build could show other words before |
| A case list menu item's label with no text | exact | part 07, section 8.6: HQ's build writes the literal "Case List" in every language, and Nova holds that label. The stored map's spelling is `list-settings-respelled`'s |
| The expression rewrites | declare, `instant-comparison` to `search-today-device-day` | part 08, section 2.3 |

---

## 12. What the review and the first publish are handed

### 12.1 The list, per declaration choice

For each choice of `input.choices`, once every check has passed, `acceptReading` builds
`FirstPublishFacts`: the source; the document under the choice (check 2's `verdict.nextDoc`); the
draft's facts; `generatedDifference(facts.forms[i].generated, emittedGeneratedNodes(nextDoc, forms))`
(section 11.1), from that document's own plan; the media path assignment, keyed by content (below);
`input.mediaLeftOut`; and the choice. It calls `firstPublishChangesFor`, and the result is that
choice's `AcceptedDeclaration.firstPublish`. `AcceptedReading.firstPublish` is the preselected
choice's, the one at `input.choices.proposed`.

The builder of `FirstPublishFacts` is exported from `lib/deployment/reading/firstPublishChanges.ts`
as `firstPublishFactsOf(input)` (section 11.1), and `acceptReading` calls it for each choice. So
part 15 builds the base reading's facts with the code acceptance uses and subtracts the two lists
(its section 2.5, step 13). For that caller the media path assignment is over the files CommCare
HQ added or replaced, and over none for the base.

**The media path assignment is keyed by content.** `FirstPublishFacts.media` is `assignMediaPaths`
(part 10, section 4.2) over the builder's `mediaFiles` (acceptance's `input.media.files`) with each
`assetId` set to `reviewMediaId(contentHash)` (`lib/deployment/reading/mediaIds.ts`; part 12,
12-the-reading-and-the-birth.md, section 5.2), never over the ids the files carry. Those ids are
not the same in the two requests: a file is named by a provisional id at the read, one per media
document of CommCare HQ's, and by its published id where a create calls acceptance once more
(section 2.4). `assignMediaPaths` collapses paths per asset id, so two media documents that hold
the same bytes are two assets at the read and one at the create, and an assignment over the ids as
they stand would apply `media-paths-joined` at the create and not at the read. Keyed by content the
two files are one asset in both calls, which is also the assignment the birth writes, up to the
ids' names. No predicate of section 11.2 reads an `assetId` of the assignment: each reads only
whether `collapsed` or `rederived` holds an entry.

A read and the create that follows it call `acceptReading` over the same reading, and no predicate
reads an asset id (the document under the choice holds them, and no entry reads a media slot of
it), so each choice's list is the same in both. Part
12's review digest needs that (its section 5.2: `review.runsOn[].firstPublish` is digested, and
its own `mediaPaths` is keyed the same way): the list the person answered is the list the birth
stores. `acceptance.declarations.test.ts` holds it over two held files of one content (Tests).

Two choices of one reading differ in the two `declaration` entries, in
`date-and-time-questions-split`, and, where one of them takes the split, in whatever the split
document's generated nodes change. Each choice carries its own list whole, so the review redraws
the list when the person changes the declaration without another read. Part 12's
`ReadingDeclarationChoice` holds `firstPublish: FirstPublishView`, taken from the
`AcceptedDeclaration` at the same position, and its `ReadingReview.firstPublish` stays the
preselected choice's (part 12, 12-the-reading-and-the-birth.md, section 5.1).

### 12.2 The data contract

One function turns a view into everything a surface shows, so the review, the publish screen and MCP
cannot word one list three ways:

```ts
// lib/publish/firstPublishCopy.ts
export const FIRST_PUBLISH_SENTENCES: Readonly<Record<FirstPublishSentenceId, string>>;
export interface FirstPublishLine {
	readonly id: FirstPublishSentenceId;
	readonly sentence: string;
}
export interface FirstPublishLines {
	/** `FIRST_PUBLISH_HEADING`. */
	readonly heading: string;
	/** `FIRST_PUBLISH_LEAD_REVIEW` or `FIRST_PUBLISH_LEAD_PUBLISH`, by `surface`. */
	readonly lead: string;
	/** `FIRST_PUBLISH_WORKERS_LABEL`, and the lines that touch workers, in registry order. */
	readonly workers: { readonly label: string; readonly lines: readonly FirstPublishLine[] };
	/** `FIRST_PUBLISH_HQ_LABEL`, and the other lines, in registry order. */
	readonly hqOnly: { readonly label: string; readonly lines: readonly FirstPublishLine[] };
	/** `FIRST_PUBLISH_NO_WORKER_CHANGE` exactly where `view.touchesWorkers` is false; else null. */
	readonly reassurance: string | null;
	/** `FIRST_PUBLISH_FORM_BUILDER_NOTE`, always. */
	readonly note: string;
}
export function firstPublishLines(
	view: FirstPublishView, surface: "review" | "publish",
): FirstPublishLines;
```

`firstPublishLines` maps each id of the view through `firstPublishSentenceId`, keeps the first of
each, and keeps registry order. So a list can hold fewer lines than the view has ids, and a line's
`id` is the id whose sentence it shows.

`workers.lines` and `hqOnly.lines` are split by `FIRST_PUBLISH_TOUCHES_WORKERS`
(`lib/publish/firstPublishChangeIds.ts`), the register's `touchesWorkers` column as client-safe data,
since `lib/publish` cannot import the register; `firstPublishChanges.test.ts` holds the two equal. A
sentence takes no argument: none names a question, a menu, a count or a project space, so the same
string serves every surface. Every list of kind `first-publish` has `forms-and-settings-rewritten`
in `hqOnly`, so that group is never empty there; `workers` is empty exactly where the reassurance
shows. A list of kind `next-publish` never holds that id (part 15, section 2.5, step 13), so
either of its groups can be empty.

For a view of kind `next-publish`, which only the `publish` surface meets, `heading` and `lead` are
part 15's `NEXT_PUBLISH_HEADING` and `NEXT_PUBLISH_DIALOG_LEAD` (its section 9.4 and its "Copy").
Every other member is built as for any view.

This is the one renderer and the one copy. Part 13 (13-the-experience.md, section 8.8) draws this
value and writes no sentence, lead or label of its own. It is decided here because the copy's home
is this part's file: the shape above, one heading, two leads and two labels (a review and a
publish do not say the same thing first, and a person needs the worker lines apart from the
housekeeping ones), a reassurance that says something a person can check, and the note. The
strings are in Copy, C1.

Part 13 draws that value in the review (`firstPublishLines(choice.firstPublish, "review")`, its
section 8.8) and in the Publish dialog (`firstPublishLines(view.firstPublish, "publish")`, its
section 11.2), adds no sentence and drops none: a list is shown whole. Its MCP tools return the
same value, with its keys in snake case, as `first_publish` on each entry of `read_hq_app`'s
`review.runs_on`, built with surface `review` (its section 14.3), and on
`check_project_space_compatibility`, built with surface `publish` (its section 14.7). On the second
it is null exactly where `firstPublishOf` (12.3) answers null: no list is stored for the
deployment, or its live app mapping is not the one the list was stored for (an ended deployment).
A list of kind `next-publish` is drawn with part 15's heading and lead (its section 9.4).

### 12.3 Where the list is kept between the review and the first publish

Nothing of a reading is kept between the two requests, so the list a person reviewed has to live
with the app. It is a fact about the baseline Nova read: it says what
differs between that baseline and what Nova will write, and it stops being true the moment a push
replaces the baseline.

This is the one home of the list. Nothing else holds a copy of it. Part 13 (13-the-experience.md,
section 11.2) reads `DeploymentView.firstPublish` as below and adds no column.

**DDL**, in part 10's migration `20261201000000_hq_bring_in_ledger` (10-identity-and-the-ledger.md,
section 11, statement 10): three clauses of its one `ALTER TABLE app_deployment_baselines`, after
the origin CHECK that admits `read` and `changes`. Every statement of that migration replays over
its own result, so the clauses do too. The constraint is named for its predicate, as that table's
others are (`app_deployment_baselines_unread_holds_no_source`):

```sql
ALTER TABLE app_deployment_baselines
	ADD COLUMN IF NOT EXISTS first_publish_changes jsonb,
	DROP CONSTRAINT IF EXISTS app_deployment_baselines_first_publish_changes_need_a_source,
	ADD CONSTRAINT app_deployment_baselines_first_publish_changes_need_a_source
		CHECK (first_publish_changes IS NULL OR origin NOT IN ('create', 'unread'));
```

Additive and nullable: the revision serving while the migration runs neither reads nor writes it. No
row is backfilled; no document changes. `lib/db/pg.ts::AppDatabase` gains the column, typed
`JSONColumnType<{ readonly ids: readonly string[]; readonly webAppsOnInHq: boolean; readonly of:
"first-publish" | "next-publish" }> | null`. The type is structural, with `ids` as strings, because
a stored id may be one a later registry no longer holds, which the reader drops (below). A list is
written only beside a source Nova can compare: beside an origin of `read`, `changes` or `push`,
the three part 15's usable pair admits (its section 3). The `create` and `unread` arms write no
list (below). So the CHECK holds for every row the ledger writes. The column's writer, its
readers and the rule below are this part's.

**What is kept** is a `StoredFirstPublish` (section 11.1). Its `of` says which kind of list it is.
A list of kind `next-publish` is part 15's: the ids of its `publishChanges` and the Web App setting
the source it read holds (its section 4.4). A list of kind `first-publish` holds the ids of the
chosen declaration's list whose entry's `scope` is `reading`, in registry order, and
`webAppsOnInHq`, the Web App setting CommCare HQ held at the reading. The two `declaration` ids are
not kept. A person can change where the app runs in the builder between the birth and the first
publish, and a stored
`web-apps-turned-off` would then tell them Web Apps is turned off for an app that now runs in it.
Those two lines are worked out again from the document, by the predicates of `web-apps-turned-off` and
`web-apps-turned-on` over the stored setting. `touchesWorkers` is not kept either: it is a fact of
the ids that remain.

- **Written** at the birth, and by part 15 where a bring-in of changes or a read that compared
  equal leaves something the next publish will write its own way (its section 4.4).
  `lib/deployment/types.ts::AppBaselineWrite` gains `readonly firstPublish: { readonly kind: "keep"
  } | { readonly kind: "set"; readonly list: StoredFirstPublish | null }`. Part 10's
  `adoptedAppBaselineWrite` gains the input `firstPublish: FirstPublishView`, the chosen
  declaration's `AcceptedDeclaration.firstPublish` from the create's own acceptance: the entry of
  `AcceptedReading.declarations` whose `(runsOnlyOn, splitDatetime)` the person chose (part 12
  passes it, its section 6.2). It passes `set` with
  `{ ids: <its ids less the two declaration ids>, webAppsOnInHq: source.cloudcareEnabled, of:
  "first-publish" }`. `service.ts::appBaselineFor`'s `create`, `push` and `unread` arms pass `set`
  with null. Part 01's `recordRefreshedAppBaseline` passes `keep`, unless part 15 hands it a list.
- **The one writer's two arms.** Every baseline goes through `store.ts::writeAppBaseline`, an upsert
  on `deployment_id`. Its `INSERT` list gains `first_publish_changes`: a `set`'s list as JSON or
  null, and null for a `keep`. Its `ON CONFLICT (deployment_id) DO UPDATE` arm gains, under the
  `WHERE` it has today, with `keep` a bound boolean of the write:

  ```sql
  first_publish_changes = CASE
  	WHEN ${keep} AND EXCLUDED.remote_app_id = existing.remote_app_id
  		THEN existing.first_publish_changes
  	ELSE EXCLUDED.first_publish_changes END
  ```

  So a push writes `set` with null and ends the list in the statement that sets `origin = 'push'`.
  A refresh of kept values writes `keep` over the same HQ app (part 01, section 6.5), and the list
  stays: it is still the same baseline, read again. A write the `WHERE` turns away (an older
  read) changes nothing, the list included.
- **Ended** by the next push, by that same arm, and replaced or cleared by a bring-in of changes
  (part 15, section 4.4). Nothing else clears it.
- **Read**, for a viewer, by a new `lib/deployment/store.ts::readFirstPublishStates(scope:
  DeploymentScope): Promise<ReadonlyMap<string, { readonly remoteAppId: string; readonly stored:
  StoredFirstPublish }>>`, keyed by deployment id. It authorizes `view` (`roleAllowsApp(scope.role,
  "view")`, else `deploymentNotFound()`), and selects `b.deployment_id`, `b.remote_app_id` and
  `b.first_publish_changes` for the app's deployments where the column is not null. It never selects
  `source_gzip`. `readAppBaseline` is not the reader: it authorizes `edit` because its answer holds
  CommCare HQ's source, its one caller is `preflight.ts`, and the Publishing section and
  `check_project_space_compatibility` read as `view` (`lib/deployment/CLAUDE.md`, "Surfaces").
  `readAppBaseline` does not change for this column; part 10 widens its origin guard to admit `read`
  and `changes` (its section 6.3). The value is parsed with `storedFirstPublishSchema` after each id
  the registry no longer holds is dropped with `log.warn("[deployment] first-publish change no
  longer registered")`. A value that is no object of the three keys is logged at error and read as
  no list. Neither throws: a registry edit must not stop a page or a publish.
- **Shown.** `lib/deployment/actions.ts::DeploymentView` gains `firstPublish: FirstPublishView |
  null`, and one pure export is the rule that fills it:

  ```ts
  // lib/deployment/resources.ts, beside part 10's deploymentEnding
  /** The stored list, while the live app mapping names the app it was stored for; null otherwise. */
  export function firstPublishOf(
  	deployment: DeploymentWithResources,
  	state: { readonly remoteAppId: string; readonly stored: StoredFirstPublish } | undefined,
  	runsOnlyOn: Platform | undefined,
  ): FirstPublishView | null;
  ```

  It answers `firstPublishViewFromStored(state.stored, runsOnlyOn)` where `state` is defined and
  `activeRemoteApp(deployment)` is a mapping whose remote id is `state.remoteAppId`, whatever its
  ownership, and null otherwise, so an ended deployment shows none, and a deployment has no entry
  in the map from a push, which clears the column, until part 15 next stores a list for it.
  `readDeploymentsAction` calls `readFirstPublishStates(scope)` once beside its one read of the
  document, and it, `refreshDeploymentAction`, `withdrawDeploymentConfirmationAction` and part 10's
  `stopPublishingAction` (its section 8.3) each call
  `firstPublishOf` with their entry of that map and `doc.appSettings.runsOnlyOn`. The Publish dialog
  draws the value before the person confirms a publish, and `check_project_space_compatibility`
  calls `readFirstPublishStates(scope)` and the same function (part 13, sections 11.2 and 14.7).

`firstPublishViewFromStored(stored, runsOnlyOn)` answers the stored ids, with `web-apps-turned-off`
where `stored.webAppsOnInHq` and `runsOnlyOn` is `android`, and `web-apps-turned-on` where
`stored.webAppsOnInHq` is false and `runsOnlyOn` is not `android`, all in registry order,
`touchesWorkers` from `FIRST_PUBLISH_TOUCHES_WORKERS` over the result, and `of` copied from the
stored value. A `next-publish` view holds neither Web App line unless the stored setting differs
from the declaration, by the same two predicates. `firstPublishChanges.test.ts`
holds it to the register: for every choice of every retained reading, the choice's own list equals
`firstPublishViewFromStored` of what the birth would store for it, under that choice's `runsOnlyOn`.

Where the app runs is the one edit that changes this list. Every other edit made in Nova between
the birth and the first publish changes what that publish sends and leaves the list as it is: the
list is what bringing the app in changes, and the person's own edits are theirs. The publish
surface's lead says so. The publish still asks before it changes the Web App setting CommCare HQ
holds, as it does today (`lib/deployment/webApps.ts::webAppsChange`); the line says what will be
asked, and the question is where it is agreed.

---

## 13. `proof/first-publish-changes.json` and its judge

### 13.1 Whose file it is

The file's shape, its loader and its judge are part 14's (14-proof.md, sections 9.1 to 9.4): an array
of `{ change, rows: [{ check, artifact, path, kind? }] }`, one object a change, every register entry
in registry order. This part gives it the ids and each entry's `source` rows: one row a pointer of
the entry's `paths`, `artifact: "app.json"`. Every row but a `source` row is written from a run's
evidence, as part 14's section 9.1 says. This part also writes the file's one Vitest,
`proof/ci/__tests__/firstPublishChanges.test.ts`. What it gives the lane is below, and nothing else.

The lane's shards hold `proof/` and `lib/commcare/surface/` and nothing else of the repository
(`proof/CLAUDE.md`), so the judge cannot read the TypeScript register. The two meet in two places
only: the ids, and `first-publish.json` in each base's directory, the predicted ids the reader bundle
writes from the base's declaration's `AcceptedDeclaration.firstPublish.ids` (part 14, section 9.2).

### 13.2 What the judge needs for an entry no proof shows

Part 14's judge observes an id through proofs 1, 2 and 3 and intent. Eleven entries change only what
CommCare HQ stores, and none of those four reads it: `forms-and-settings-rewritten`,
`case-settings-respelled`, `search-filter-rows-recut`, `sort-rule-kept-as-hidden-column`,
`list-settings-respelled`, `search-filter-joined-to-list`, `translation-overrides-folded`,
`location-list-setting-reset`, `media-paths-joined`, `media-references-with-no-file-removed` and
`unused-media-entries-removed` (proof 2 leaves a form's XML unjudged on this hop, part 14, section
4). `forms-and-settings-rewritten` applies on every base. With no comparison of the stored app each
would be predicted and never observed (`/<id>/unseen`) on every base it applies to. So the lane gains
one comparison, which part 14 writes (its section 9.3):

- **`source`**, a check name `proof/checks/differences.py::CHECKS` gains (it refuses an unknown one in
  `Difference.__post_init__`), beside `proof6`, `parity` and `changes`. It compares A's stored app with
  B's as CommCare HQ's source view serves each: JSON by pointer, a position and an app's own key as
  `*`, and a form's source as bytes, reported at `/_attachments/*`. Every source read re-mints form
  ids, so a form id and every reference to one is compared as the menu and form position it names
  (part 14, 9.3). `changes.declared` is called for it as for the proofs, so a row may have `check:
  "source"`.
- **A `source` row's `path` is one of its entry's `paths`** (section 11.2). The register writes those
  pointers at source; the lane writes its other rows from evidence. The two are held together where
  the checkout is whole. `proof/ci/__tests__/firstPublishChanges.test.ts` holds: the file's ids are
  `FIRST_PUBLISH_CHANGE_IDS` in order; each object's `source` rows are exactly the entry's `paths`
  (entry 1's four written pointers; its inert allowance has no row); a `proof3` row stands only under
  an entry whose `touchesWorkers` is true. A behavior difference under an entry that declares none
  is then a failing test, never an accepted change.
- **Entry 1's allowance.** A `source` difference at a pointer the base's claim log holds under an
  entry of standing `inert` (the reader bundle's `claims: "full"` product, part 14, section 8.1) is
  `forms-and-settings-rewritten`'s: Nova does not write back what no runtime reads. The judge matches
  it with no row (part 14, 9.3).

With `source` an observed check, every one of the thirty-one ids is one some check can show.

### 13.3 What the judge then holds

Part 14's both-ways judge (its section 9.3), with `source` among its observed checks, on every
`hq-authored` document and nowhere else:

1. **Nothing unsaid.** A difference of the hop that no entry naming the document holds goes on to the
   spelling rules and the known-defect register, where nothing holds it, and fails; an observed id the
   reading did not predict is `/<id>/unsaid`.
2. **Nothing said in vain.** A predicted id nothing observed is `/<id>/unseen`.
3. **Behavior only where behavior is declared**, by 13.2's Vitest; proof 3's value expectations
   for a base (part 14, section 6.4) include one that shows each worker-touching entry the base
   exhibits.

The predicted ids are the base's declaration's list, computed by `acceptReading` in the reader bundle
over the base's retained reads. Every register entry has a base and none is exempt: part 14's section
9.4 places each.

---

## 14. `read-back-differs`

### 14.1 The finding

Every failing check but an unsettled hand-off (section 2.3) gives `CircumstanceFinding`s of code
`read-back-differs` (part 01, section 8.3: standing `not-yet`, no owner):

```ts
{ code: "read-back-differs", standing: "not-yet", subject: null,
  place, detail: { name: check } }
```

`place` is where the difference lies: the form, the menu or the question for a difference inside one,
the app otherwise. One finding per place, at most twenty, in `placeOrder`. `detail.name` is the check,
one of `ACCEPTANCE_CHECKS` (part 12 writes `reader` for the reader's own contract error, its
section 3.3). A birth's own check writes its name with the prefix `birth-` (part 12, section 6.5).
It is Nova's own word: part 01's row for this code holds `name: "internal"` (its section 8.3), so
no surface shows it.

Nothing of the difference is stored. The answer holds the findings as every account does, which is
enough to show the person where and to let them check again.

### 14.2 The signature

```ts
// lib/doc/documentDifferences.ts (pure, client-safe)
/** One differing path of two documents, as the keys from the document's root. */
export interface DocumentDifference {
	readonly path: readonly string[];
	/** `value`: both hold the path and differ. `missing`: only the expected document holds it.
	 *  `added`: only the other does. */
	readonly kind: "value" | "missing" | "added";
}
/** Every differing path of two documents, in a depth-first walk with object keys sorted. */
export function documentDifferences(
	expected: BlueprintDoc, actual: BlueprintDoc,
): readonly DocumentDifference[];

// lib/deployment/reading/signature.ts, which imports the two above
/** The property names of Nova's document schema, collected once from `lib/domain/blueprint.ts`. */
export const DOCUMENT_SCHEMA_KEYS: ReadonlySet<string>;
/** A document path as content-free segments (the first row of the table below). */
export function documentPathKinds(path: readonly string[]): readonly string[];
/** The check, then its segments, joined with `/` and cut at a whole segment within 80 characters. */
export function differenceSignature(
	check: AcceptanceCheck | HqChangePlanCheck, segments: readonly string[],
): string;
```

The walk lives in `lib/doc` because part 15's `lib/doc/documentChanges.ts` words its output (its
section 6.2), and `lib/doc` may not import `lib/deployment`: no module of it does on `main`, and
`lib/deployment` imports `lib/doc`. `HqChangePlanCheck` is part 15's type
(`lib/deployment/hqChanges/plan.ts`, its section 2.5): the checks of its own plan, whose failures
take a signature from this function.

`differenceSignature` joins the check and its segments with `/` and cuts the result at the last whole
segment within 80 characters, so every signature begins with a member of `ACCEPTANCE_CHECKS` or of
part 15's `HQ_CHANGE_PLAN_CHECKS` (its section 2.5). Every segment comes from a closed vocabulary
that holds no word of any app:

| Segment | From |
|---|---|
| a document path | `documentPathKinds(path)`: the top-level key renamed (`modules` to `menu`, `forms` to `form`, `fields` to `question`, `caseTypes` to `case-type`, `localization` to `translations`), then every later segment that is a property name of Nova's own document schema, in order. A uuid, an array position, a language code, a case type's or a property's name and any other record key is dropped. The property names are collected once from `lib/domain/blueprint.ts`'s schema (`signature.ts::DOCUMENT_SCHEMA_KEYS`) |
| a key of an identity or a summary record | the member's name in this part's own types (`repeats`, `typeClass`, `properties`, `label`) |
| a validator code, an `UnreadFormReason`, a `HandOffKind`, HQ's type name, a Nova field kind, a production function's name | as they are |
| a fixed word of sections 3 to 7 (`defect`, `export`, `threw`, `account`, `split`, `unread`, `missing`, `added` and the rest written there) | as written there |

Examples: `fixed-point/question/relevant`, `fixed-point/menu/caseListConfig/columns/format`,
`identity/leaf/typeClass`, `identity/case-blocks/basic-subcase/properties`,
`summary/question/option/label`, `gate/FIELD_ID_DUPLICATE`,
`gate/export/LOCATION_OWNER_EXPORT_NOT_ACTIVE`.

The failing arm's `signature` is the first difference's. `signature.test.ts` holds it content-free by
property: for documents whose every name, id, label, choice value and case type is a random sentinel,
no signature of any difference between two of them holds a sentinel.

### 14.3 The log and Sentry

Acceptance logs nothing: it is pure. Part 12 logs each distinct signature of a request once, as
`log.error("[reading] read-back differs: <check>: <signature>")` with the app's id as the `appId`
tag (12-the-reading-and-the-birth.md, section 10). A message with no error object is a message
event in Sentry, which groups by its text, so one defect of the reader is one Sentry group however
many apps meet it. This part's share: `check` is never null and `signature` is always present, so
that line is total; the context part 12 passes gains `differenceCount` (the number of differences,
at most twenty) and `signatures` (the distinct signatures of the request, at most five), both
content-free.

`AcceptanceDifference.detail` holds the app's words and exists for tests and for a developer running
the function over a retained read. It is never passed to `log`, never stored and never returned by a
route: `acceptance.ts` imports no logger and no store (`acceptance.purity.test.ts`), and the request
that calls it reads `findings`, `check` and `signature` of a failing answer and never `differences`,
so the words stay inside `acceptReading`'s answer.

### 14.4 The reading, and the words

The read answers an account. Checking again reads CommCare HQ afresh and runs acceptance again, so a
person is unblocked by the release that fixes the reader, with nothing to redo. Nothing was created
and nothing in CommCare HQ was touched.

The block is part 01's (`lib/publish/hqFindingCopy.ts::CIRCUMSTANCE_COPY`, its section 9.3): its
title, body and next step are written there. What this part requires of the body is that it is true
of every check, since a gate refusal is no comparison with CommCare HQ's reading.

---

## 15. The production `appStrings`, and `adoptionExportBoundary`

### 15.1 `localAppStringTable` and `readingAppStrings`

Part 06's classifier of generated translation keys takes `ReaderInput.appStrings: (doc) =>
AppStringTable | null` (its section 16.5): the app strings Nova's own build gives a document, by
language, with each string's source unit, or null where Nova's gate refuses the document.
`compileCcz` builds exactly those strings as it walks the app and returns only an archive. This
part splits it, and `readingAppStrings`, below, puts the gate in front:

- **The split falls after the last app-string table is built and before any is serialized.**
  `lib/commcare/compiler.ts::compileCcz`'s body from its start through the loop that materializes each
  language's `table` (the walk of menus and forms, the two suite oracles, and per language
  `localization.wireTextFor`, the language names and `lang.current`) moves, unchanged, into
  `compiler.ts::compileCczParts`:

  ```ts
  // lib/commcare/compiler.ts
  export type CompilePartsOptions = Omit<CompileOptions, "lookup"> & {
  	readonly lookupNaming?: LookupWireNaming;
  };
  export interface CczParts {
  	/** Every text entry of the archive but each language's `app_strings.txt`, by its path. */
  	readonly files: Readonly<Record<string, string>>;
  	/** The media bundle's byte entries, as `packageCcz` takes them. */
  	readonly mediaEntries: readonly { readonly path: string; readonly bytes: Buffer }[];
  	/** Each language directory's app-string table, as values, before any is serialized. */
  	readonly tables: Readonly<Record<string, Readonly<Record<string, string>>>>;
  	/** Each app string's source unit, as the walk filled it. */
  	readonly appStringUnits: Readonly<Record<string, WireStringSource>>;
  }
  export function compileCczParts(
  	hqJson: HqApplication, appName: string, authoredDoc: BlueprintDoc,
  	opts: CompilePartsOptions,
  ): CczParts;
  ```

  `compileCcz` calls it, writes each `<dir>/app_strings.txt` from `tables` through
  `serializeLocaleFileValue`, and packages. Its bytes do not change, which `compilerEvidence.ts`'s
  corpora hold. The serializer is the one step that fails closed on text the locale grammar cannot
  carry (a literal backslash-`n`; `lib/commcare/CLAUDE.md`, "Multilingual emission"), and it stays in
  `compileCcz`, so `compileCczParts` returns such a string as the value it is and
  `localAppStringTable` never throws for it.
- **The options.** `CompileOptions.runtimeTarget` is required ("no archive is compiled without one"),
  and lookup naming reaches the compiler only inside `CompileOptions.lookup`, a `PreparedLookupWire`
  that also holds budget-checked fixture blocks. `compileCczParts` takes its own options type,
  `CompilePartsOptions`: `CompileOptions` with `lookup` replaced by `lookupNaming?: LookupWireNaming`
  (the walk reads the naming and never the fixtures, which `compileCcz` packages), and
  `runtimeTarget` still required. `compileCcz` passes `opts.lookup?.naming`.
- `lib/commcare/appStrings.ts::localAppStringTable(doc: BlueprintDoc): AppStringTable` calls
  `expandDoc(doc)` and `compileCczParts` with `runtimeTarget: { server: "production", domain:
  "nova-app-strings", appId: doc.appId }`, no assets, and `lookupNaming:
  identityLookupWireNaming()` (`lookup/naming.ts`), and returns `{ languages, units: appStringUnits
  }`, `languages` being the table of each named language directory by its code (the `default`
  directory repeats the default language's and is left out). The target is a fixed stand-in: it
  names the profile's and the suite's request addresses and no app string, and a document that
  reads a table needs a naming and gets the identity one, since no app string names a table.
  `appStrings.test.ts` holds both claims over the corpus, by compiling under two targets and under
  the identity and a real naming and requiring equal tables.

The stand-in target is why `localAppStringTable` needs nothing of the reading.

**`readingAppStrings`, the function a reading passes.** `localAppStringTable` is total only over a
document the gate admits: `compileCczParts` runs the form, suite and media-suite oracles, which
throw for a document the gate refuses ("Executed during planning"). Part 06 asks for the strings of
the reading's document, and where a finding stands that is a provisional document, with stand-ins
for what the finding withheld (its section 16.5). So the function a reading passes puts the gate in
front:

```ts
// lib/deployment/reading/appStrings.ts
/** The `ReaderInput.appStrings` of a reading: a document's local app strings, or null where
 *  Nova's gate refuses the document. */
export function readingAppStrings(
	lookupContext: LookupValidationContext,
): (doc: BlueprintDoc) => AppStringTable | null;
```

The function it returns answers null where `mutationCommitVerdict(doc, [], lookupContext)` is not
`ok` (an empty batch validates the candidate as it stands), and `localAppStringTable(doc)`
otherwise. It reads no finding and no place: what a null means is part 06's to say (its section
16.5, step 3).

`lookupContext` is the gate's context over every table the reader's catalog binds, under the
catalog's own ids: `kind: "available"`, the reading's Project and the revision part 11 read, and one
definition for each binding (part 11, 11-project-data.md, section 5.5). It holds more tables than
check 2's context (section 4), which names only the tables the document turned out to read: this
function is called while the reader runs, before that list exists, and a definition no reference
names changes no verdict. The read builds the context once and passes
`readingAppStrings(lookupContext)` as `appStrings` (part 12, 12-the-reading-and-the-birth.md,
section 3.3), acceptance hands the same function to its re-read (section 5.2), and the lane's reader
bundle gets it both ways: its first reading is one call of `gatherFromHq`, which builds it as a
read does, and its read back passes it over the document's own lookup context (part 14,
14-proof.md, section 5.2, steps 2 and 4).
`lib/deployment/reading/__tests__/readingAppStrings.test.ts` holds both arms.

### 15.2 `adoptionExportBoundary`

```ts
// lib/deployment/reading/adoptionBoundary.ts
export function adoptionExportBoundary(
	doc: BlueprintDoc,
	lookupDefinitions: readonly LookupTableDefinition[],
	mediaFiles: readonly AdoptedMediaFile[],
	target: { readonly origin: string; readonly domain: string },
): Pick<PreparedExportBoundary, "doc" | "assets" | "attachmentTarget" | "lookupNaming">;
```

Built from the reading's facts with no database read, since the tables and files it names do not exist
until the birth: `doc` as given; `attachmentTarget` the target; `lookupNaming`
`lookupWireNaming(lookupDefinitions)`, absent where the list is empty, the definitions being
`AcceptReadingInput.lookup.definitions` (each bound table's tag and field names as CommCare HQ holds
them, under the ids the reading minted), which part 12 passes; `assets` one resolved asset per asset
of `mediaFiles`, at the path `assignMediaPaths(mediaFiles)` gives it and at its derivation
(`multimedia/assetWirePath.ts::wirePathFor`) where it gives none, with the file's own `contentHash`
and `extension`, the kind of the slot the document references it from (`lib/domain/mediaRefs.ts`'s
walk), `mimeType` as `emissionAssets` writes it (5.1: the body `hqImportApplication` builds prints an
asset's `wirePath` and reads no other member), and no `bytes`. It takes no type of the request that
calls it. Part 10's `adoptedAppBaselineWrite` takes it as `prepared` (part 12, section 6.2), so
the baseline's ownership descriptor is computed over the body the first publish
would send.

---

## Copy

Every string this part adds, as it ships. All of it follows `design/readme.md`, "Content fundamentals".

**C1. The heading and its parts** (`lib/publish/firstPublishCopy.ts`; `firstPublishLines` returns
them and part 13 places them). These are the only strings of their kind: part 13's Copy names these
constants and writes no heading, lead, label, reassurance or note of its own (section 12.2).

| Constant | String |
|---|---|
| `FIRST_PUBLISH_HEADING` | What the first publish changes |
| `FIRST_PUBLISH_LEAD_REVIEW` | Nova writes an app in its own way. This is everything that will differ in CommCare HQ the first time you publish this app back. |
| `FIRST_PUBLISH_LEAD_PUBLISH` | This is the first publish since Nova brought this app in. Along with your edits, these things will differ in CommCare HQ. |
| `FIRST_PUBLISH_WORKERS_LABEL` | Workers will notice |
| `FIRST_PUBLISH_HQ_LABEL` | Only in CommCare HQ |
| `FIRST_PUBLISH_NO_WORKER_CHANGE` | Workers see the same questions, and their answers save to the same places. |
| `FIRST_PUBLISH_FORM_BUILDER_NOTE` | If your team opens these forms in CommCare HQ's form builder, some hidden details will look different there. |

**C2. The sentences** (`FIRST_PUBLISH_SENTENCES`), one for each id that has a line of its own:
twenty-nine. `search-filter-rows-recut` and `list-settings-respelled` are said by the first. The
sentences of part 08's rewrites and of part 07's same-state readings are written here, because the
register is their home.

| Id | Sentence |
|---|---|
| `forms-and-settings-rewritten` | Nova writes this app's forms, case lists, searches and settings again in its own way. Apart from anything listed here, each form asks, shows and saves the same things, and each list and search finds, shows and sorts the same cases, with the same limit on how many a worker can select. |
| `hidden-values-added` | Nova adds, renames or removes some hidden values in this app's forms. Their names start with nova_. CommCare HQ's form builder lists them, and form exports start a new column for each new name. |
| `case-names-checked` | A question that gives a case its name now needs an answer that isn't blank. A case name or an external ID longer than 255 characters is turned down, and both are saved without spaces at their ends. |
| `validation-counts-moved` | A validation rule that counts another question's answers now counts only that question's answers. Before, CommCare could count the answer being checked instead. |
| `validation-messages-composed` | A validation message that shows an answer now shows exactly that answer. Where the answer can't be read, workers see CommCare's own message. |
| `instant-comparison` | An expression that compares two dates and times is now written so it compares the same moment in every time zone. In CommCare HQ's form builder these expressions will look longer. |
| `empty-rows-guard` | An expression that reads a lookup table, your places or a search answer now reads blank when there is nothing to read. Before, it stopped the form. |
| `absent-session-value-guard` | An expression that reads the screen width or the app's language now reads blank where CommCare has none to give. Before, it stopped the form. |
| `row-predicate-current` | Inside a repeat, a choice filter that names another question of that repeat now reads this entry's answer. Before, CommCare stopped on it or used one entry's answer for every entry. |
| `search-value-guards` | A search value that holds a quote mark is now matched as typed, and a value CommCare HQ can't search by finds no cases. Before, the search failed. |
| `search-today-device-day` | A search filter that uses today's date now uses the worker's day. In CommCare HQ it used the project space's day, which differs for a worker in another time zone. |
| `case-settings-respelled` | Nova writes each form's case settings in its own way, so some of them can look different on CommCare HQ's case management page. Where a form loads a value from its case, that page stops listing it, and the question holds it as its default value. What each form saves and loads stays the same. |
| `sort-rule-kept-as-hidden-column` | A sort rule over a property the list doesn't show is kept as a hidden column. Lists sort the same way. |
| `search-filter-joined-to-list` | Where a menu's forms read its search, Nova keeps the search's filter and the case list's filter as one. The search finds the same cases. |
| `search-restates-list-filter` | Nova sends a case list's filter with its search, so a search that matched more cases than CommCare HQ returns at once can show cases it left out before. |
| `link-held-case-guards-added` | A form that opens another form with a case it carries will open it only when that case is on the device. Nova adds that check to each such link. |
| `registration-label-fixed` | A Register button that had no text of its own in CommCare HQ, in every language or in just one, now always reads "Create a new Case" there. Before, CommCare HQ filled in the words each time it made a build, so they could differ between builds. You can change the text in Nova. |
| `date-and-time-saved-as-hq-stores-it` | A date and time that a form saves to a case is now written the way CommCare HQ stores it. Before, a phone wrote it in its own time zone for the cases it saved, so a list sorted by that date and time could show those cases out of place. |
| `connect-app-captures-location` | Every form of this CommCare Connect app will record where it was filled in. Nova turns on Auto Capture Location for the app in CommCare HQ. |
| `translation-overrides-folded` | A wording set in CommCare HQ's app translations for a menu's or a form's name becomes that menu's or form's own name. Workers read the same words. |
| `location-list-setting-reset` | This app's own setting for the location list goes back to the project space's default. The app reads places the same way. |
| `web-apps-turned-off` | Web Apps is turned off for this app in CommCare HQ, because the app is set to run on Android only. |
| `web-apps-turned-on` | Web Apps is turned on for this app in CommCare HQ, because the app is set to run in Web Apps. |
| `date-and-time-questions-split` | Each date and time question becomes a date question and a time question, so the app runs in Web Apps. A case still gets one date and time from the two. |
| `blank-translations-filled` | A text left blank in one language is written in the app's first language for that language, as CommCare HQ's form builder does when a form is saved there. |
| `media-paths-joined` | Where CommCare HQ holds one picture, sound or video under several names, the app now uses one of them. Workers see and hear the same files. |
| `media-files-renamed` | Some pictures, sounds and videos get new names in CommCare HQ, because Nova can't keep the names they had. Phones download them again with the next version of the app. |
| `media-references-with-no-file-removed` | References to pictures, sounds and videos that have no file in CommCare HQ are removed. Workers saw nothing there. |
| `unused-media-entries-removed` | CommCare HQ drops the entries of this app's media list that nothing in the app uses. The files themselves stay in CommCare HQ. |

**C3. `read-back-differs`.** The block is part 01's (01-the-bar-and-the-manifest.md, section 9.3).
This part writes no title, body or next step for it (section 14.4).

**C4. Developer-facing errors** (thrown; a person never reads them).

| Where | Message |
|---|---|
| `emission.ts::readingEmission`, a form of the draft whose `xmlns` the source does not hold | "Nova tried to print a reading under its source's own form ids and found no form with the namespace it read. Every form of a reading comes from a form of the source; the draft and the source handed to acceptance are not from one read." |
| `firstPublishCopy.ts::firstPublishLines`, an id with no sentence (unreachable under `tsc`) | "Nova was asked for the sentence of a first-publish change it has no words for. Every id of FIRST_PUBLISH_CHANGE_IDS has a sentence in FIRST_PUBLISH_SENTENCES, its own or the one FIRST_PUBLISH_SAID_BY names, and a stored list is checked against those ids where it is read (lib/deployment/store.ts::readFirstPublishStates), so look at the caller that built this list by hand." |
| `store.ts::readFirstPublishStates`, a stored value that is no list of ids beside a Web App setting and a kind (logged at error, never thrown) | "The deployment ${deploymentId} holds first-publish changes Nova can't read (${issue}). They are written when an app is brought in, by lib/deployment/adoption.ts::adoptedAppBaselineWrite, and when changes made in CommCare HQ are brought in or recorded, by lib/deployment/store.ts::recordHqChangesTaken and ::recordRefreshedAppBaseline. Nova is showing this deployment with no list." |
| `canon.ts::canonDocument`, a row that still changes the document after as many passes as the list has rows | "Nova's canonical form of a document did not settle. Each canonicalization returns the member of its pair the reader returns, so applying one twice changes nothing; look at the row whose result another row undoes." |

---

## Tests

Every test is Vitest unless marked. None renders a component: acceptance, the register and the canon
list are functions of data, and part 13 owns the Playwright specs that show the lines.

| Test | Boundary | The failure it catches |
|---|---|---|
| `lib/deployment/reading/__tests__/acceptance.accepts.test.ts`: every retained reading under `proof/hq-reads/reading/` that part 05 keeps as a readable app, through `readHqApp` and `acceptReading` with part 11's settlements, answers `ok` with a list of entries. Named cases, each a retained reading or a production-built source that must answer `ok`: a registration form whose name question holds no validation (check 5's `constraint` row); a question whose label is written inline with no `ref`, and one whose second language has no `<text>` (7.3); a control with an appearance part 06 accounts as inert, a group whose `<label>` is blank in every language, and a group written `Field-List` (check 4); an app with a media reference that has no file, left out as inert (5.3, step 2); an app with a Web Apps logo (5.1); a source Nova's own emission gives with one `nova_datetime_` sibling's calculation replaced by `instant.ts::typedInstantValue` of its question, the spelling Nova wrote before this step, which answers `ok` with `date-and-time-saved-as-hq-stores-it` in its list (11.2) | the production reader and acceptance over CommCare HQ's retained answers | a check that fails a correct reading, which would stop every bring-in |
| `acceptance.doctored.test.ts`, check 1: the same input with one hand-off's settlement removed answers `check: "accounting"`, an `unrecognized` finding at the media reference's place and signature `accounting/hand-off-unsettled/media-reference`; with one settlement duplicated, `accounting/hand-off-settled-twice/media-reference` and a `read-back-differs` finding named `accounting`; with a settlement no hand-off matches, `accounting/settlement-unmatched` and the same finding at the app | `acceptReading` | a media path or a table read that no rule of part 11's judged, accepted on the reader's word |
| `acceptance.doctored.test.ts`, check 2: the draft's batch with one question's id changed to its sibling's answers `check: "gate"`, a `read-back-differs` finding at that form, and a signature that names the validator's code and no id | `acceptReading` over the production gate | a document the birth would refuse, accepted and shown as a review |
| `acceptance.doctored.test.ts`, check 3: the draft's document with an explicit `postSubmit` equal to its form's default (the other member of a canon pair) answers `check: "fixed-point"` and signature `fixed-point/form/postSubmit`; a draft whose split choice's mutations are doctored to leave such a pair in the split document answers `check: "fixed-point"` with a signature that begins `fixed-point/split/`, in a call that passes no choice of the person's | `acceptReading` | a reader whose answer for CommCare HQ's bytes is not its answer for Nova's; a split the review offers that the birth could not read back |
| `acceptance.doctored.test.ts`, check 4: the draft's document and batch with one whole-number question made a decimal, consistently, passes checks 1 to 3 and answers `check: "identity"`, signature `identity/leaf/typeClass`; a second case moves one case write to another question and expects `identity/case-blocks/basic-own/properties` | `acceptReading` | a consistent mis-read of a type or a case write, which the fixed point cannot see |
| `acceptance.doctored.test.ts`, check 5: the draft's document and batch with two choices' labels swapped, consistently, passes checks 1 to 4 and answers `check: "summary"`, signature `summary/question/option/label`, the finding's copy from `CIRCUMSTANCE_COPY["read-back-differs"]` | `acceptReading` over CommCare HQ's retained summary | a consistent mis-read of text, which nothing else in production sees |
| `acceptance.doctored.test.ts`, a menu CommCare HQ could not summarize: the retained answer `reading/application-error-module.json` (part 05, section 14.1) with a clean draft answers `ok`, and the same input with a label of that menu's form doctored still answers `ok` | `acceptReading` | blaming Nova, or the app's reading, for a menu HQ itself cannot read |
| `acceptance.media.test.ts`: handed a choice that declares a platform a held file does not play on, it fails `gate/export/MEDIA_FORMAT_NOT_PLAYED`; no arm of `exportReadinessFindings` over the corpus returns `MEDIA_EXPORT_TOO_LARGE` | `acceptReading`, `exportReadinessFindings` | a choice the narrowing kept and the validator refuses, offered at the review; a code check 2 is said never to answer, answered |
| `acceptance.declarations.test.ts`: a draft offering a choice the gate refuses fails check 2 though its other choices pass; a draft whose one file plays in Web Apps only, with `choices` as `narrowDeclarationsByMedia` gives them, answers `ok` with no declaration that includes Android, `preselected` on the first choice left, and `AcceptedReading.firstPublish` that choice's list; a draft with a split offered makes two re-reads in one call, D under `mintingResolver` and the split document under `matchingResolver`, and passes; two held files of one content, referenced at two paths, give every choice the same `firstPublish` under two provisional ids and under one published id, `media-paths-joined` in both (12.1) | `acceptReading`, part 11's narrowing, `lib/doc/datetimeSplit.ts`, `assignMediaPaths` keyed by content | a birth that applies a choice nobody checked; an app with a Web-Apps-only file refused as Nova's mistake; a split whose questions get new uuids on the re-read; a review that shows a list the birth does not store, so a correct app fails the create's integrity check |
| `acceptance.doctored.test.ts`, the carrier rules: a draft doctored to hold a `fixed-location` owner answers `check: "gate"` with `gate/export/LOCATION_OWNER_EXPORT_NOT_ACTIVE`; one whose select reads a table whose `lookup` rows hold a value twice answers `gate/export/LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE`; `lib/export/__tests__/boundaryValidation.test.ts` passes unchanged over the moved functions | `acceptReading` over `exportCarrierFindings` | an app that is born and then refused by its first publish |
| `acceptance.purity.test.ts`: two calls with equal input give deeply equal answers; the module graph of `acceptance.ts` holds no `reader/canon.ts`, no logger and no database module (it reaches `lib/export/boundaryFindings.ts` and never `boundaryValidation.ts`, and takes `DeploymentTargetKey` as a type alone) | the module graph and the function | acceptance forgiving a canon pair; a clock or a store read inside acceptance, which the proof lane's bundle could not load |
| `emission.parity.test.ts`: over every retained reading, `readingEmission`'s options equal `readProjectionInputs(ctx)`'s (part 07) in identity, attachment target, lookup naming and each asset's id and `wirePath`, and the two emissions are byte-equal; every asset id a reference names is in `emissionAssets`' map; no re-read raises a finding under `application-and-settings/34p-hq-build-spec-below-nova-s-floor`; a reading with a Web Apps logo reads back with it; `sourceFromEmission`'s answer has every member of `HqAppSource` | the two builders of one projection, and the wrapped source | the reader's own comparisons and acceptance's disagreeing on an id, an address, a table name or a path; a thrown missing-asset error inside acceptance; a re-read that refuses every app for a key Nova never writes |
| `identityAgreement.test.ts`: an appearance in `inertAppearances` is cut from A and the pair compares equal; each of Nova's four held appearances claimed inert is `identity/appearance/inert-held` (`minimal` on a trigger, `signature` on an image upload, `field-list` on a group, `numeric` on a text input), and `numeric` on an `xsd:decimal` input claimed inert passes; over the fuzz corpora, every leaf and container of `sourceIdentity(expandDoc(D))` that holds an appearance meets one of the four conditions, and a document built for each condition meets it, so the rule names exactly what `fieldAppearance` writes; a group whose `<label>` stands on one side alone compares equal; a draft doctored to hold an operation whose guard the source lacks is `identity/case-blocks/save-to-case/added`; `field-list` in another case compares equal | `identityDifferences` over hand-written pairs and the emitter | a correct reading of an inert appearance or a blank group label failed as Nova's mistake; a number keypad, a signature or a question list dropped on the reader's word |
| `generatedNodes.parity.test.ts`: over every retained read and the fuzz corpora, the reader's `generated` list for Nova's emission of a document equals `emittedGeneratedNodes` of it as sets of `(purpose, owner, name, path)`; `generatedDifference` pairs two counts of one question in name order and reports a moved suffix as `renamed`; a difference of guards alone is empty | the reader's list against the emitter's plan | the register taking a rename for a new node, which would tell a person their case names are newly checked; a guard declared as a hidden value |
| `lib/commcare/hq/__tests__/sourceIdentity.test.ts`: leaves, repeats, containers, choices and order over hand-written forms (a nested repeat, a ref-less wrapper group, a count placement's wrapper, an upload, a select with an itemset, a Save to Case block, a relative `ref`); `written` for an inline label, an itext label, a repeat whose wrapping group holds the label, and an item with and without a `ref`; each unread reason by its own source | `sourceIdentity` over XML | an extraction that misses a level or a control, which would make check 4 pass over the bug it is for; check 5 comparing a label CommCare HQ never summarized |
| `sourceIdentity.independence.test.ts`: the import graph of `hq/sourceIdentity.ts` reaches nothing under `lib/commcare/reader` | the module graph | check 4 sharing a classification with the reader |
| `sourceIdentity.corpus.test.ts`: over the fuzz corpora, `sourceIdentity(expandDoc(D))` has no `unread`, its leaves less `generatedNodePaths` are exactly the document's fields at `collectFieldLocations`' paths, and each leaf's `typeClass` is `coreTypeClass` of `fieldBindType` | the emitter against the extraction | the two drifting apart, so that every reading fails check 4 |
| `lib/commcare/xform/__tests__/generatedNodePaths.test.ts`: over the fuzz corpora, every path of `generatedNodePaths(doc, form)` is an element of the emitted form's data tree and every `nova_` leaf of that tree outside a case block is a path of it | the emitter | a generated node cut from neither side, reported as an added answer |
| `summaryAgreement.test.ts`: `documentSummary` over a document with a count-placement query repeat gives a row at the wrapper's path and a row at the row path, which HQ's retained summary of Nova's own emission holds as a `Group` and a `Repeat`; the whitespace normalization on a label with a whitespace-only run between two outputs; a label HQ sends in no second language agrees where the document's text there is its first language's, with and without a counted blank; a label with no `ref`, and an item with none, is skipped; a registration's name question with no validation agrees, a source that holds Nova's conjoined check alone agrees, and a document holding a validation the source lacks is `summary/question/constraint`; a control whose data node is outside its body group, with a draft doctored to place it by its data node, is `summary/question/group`, and the same across a repeat is `summary/question/repeat`; a menu that is `not-summarized` fails neither the rows nor the ids; a `DataBindOnly` row under a Save to Case block is explained and one beside it is not | `summaryDifferences` over retained summaries | a path rule of this part's own drifting from the emitter's; a correct reading failed for text or a validation CommCare HQ never reported; a control placed by its data node where part 06's refusal was missed |
| `signature.test.ts`: the content-free property of 14.2; every signature at most 80 characters, cut at a segment, and beginning with a member of `ACCEPTANCE_CHECKS` or of part 15's `HQ_CHANGE_PLAN_CHECKS` | `differenceSignature` | an app's words in a log line or a Sentry issue title; a signature under a check that does not exist |
| `lib/doc/__tests__/documentDifferences.test.ts`: `documentDifferences` reports a changed value as `value`, a path only the first document holds as `missing` and one only the second holds as `added` | `documentDifferences` | a difference the walk does not report, which the fixed point, the read back and part 15's two lists would each miss |
| `readBack.test.ts`: a change planted inside each kind `KINDS_WITH_NO_EXTERNAL_KEY` names gives no difference, and one in any other entity map gives one; with `choices`, `expected`'s `runsOnlyOn` is left out and a declaration no choice offers gives one difference at `appSettings/runsOnlyOn`; with `choices: null` the two declarations are compared in place; the module graph of `readBack.ts` holds no `reader/canon.ts` | `readBackDifferences` | `canonReadBack.fuzz.test.ts` and proof 6 making two comparisons of one claim; a kind compared by nothing |
| `notCarried.test.ts`: no `not-carried` row's `apply` changes anything inside a kind `KINDS_WITH_NO_EXTERNAL_KEY` names; every entity map the document schema declares is either a kind that list names or one in which a planted change shows as a difference of `readBackDifferences`; the content each `not-carried` row removes shows as a difference when the row is left out | `readBackDifferences`, `CANONICALIZATIONS`' `not-carried` rows and `KINDS_WITH_NO_EXTERNAL_KEY` over built documents (9.1) | a kind compared by nothing and named nowhere; content one mechanism removes and the other also skips |
| `readBack.retained.test.ts` (written where part 05's bracket closes over the three files, 9.1): `read(served(D))` over CommCare HQ's retained answers for `navigation-base` equals `canonDocument(D)` | the production reader over CommCare HQ's own stored and served answers, with no Docker | a read back that fails on a source CommCare HQ normalized, found only in the lane |
| `lib/commcare/reader/__tests__/canon.test.ts`: one case per row of section 9 that names no other test, both documents printed and compared byte for byte, the local archive too where the app declares Android; both cases of `dormant-tile-cells` (a cell on a list that is no tile, and a cell on a column hidden from Results in a tile list); `canonDocument` idempotent; `canonDocument(read(A)) = read(A)` over retained reads | the production emitter | a canonicalization that hides a difference a runtime reads |
| `lib/deployment/reading/__tests__/canonReadBack.fuzz.test.ts`, in ordinary CI: over the fuzz corpora, `readBackDifferences(canonDocument(D), read(expandDoc(D)))` is empty. The read is made as part 14's read back is (its section 5.2, step 4): under `matchingResolver(D.appId, externalIdentityMap(D, identity))`, so D's own uuids come back, with the rest of the reader's input the document's own; the comparison takes the draft's `doc` and `declaration.choices` | the reader over Nova's own emission, through the one comparison | a pair the list lacks (section 9 gives the rule for a failure) |
| `lib/deployment/reading/__tests__/firstPublishChanges.test.ts`: for every entry, a `FirstPublishFacts` on which it applies and one on which it does not, each built from a retained read or a production builder (`forms-and-settings-rewritten` applies on both, and is held to that); `GENERATED_NODE_CHANGE` total; every `sameStateRewrites` record of every retained read names an entry whose `paths` cover it; `FIRST_PUBLISH_TOUCHES_WORKERS` equals the register; every id of `EMISSION_REWRITES` whose `behavior` is `changes` is an id of this table whose entry touches workers; `MEDIA_REFERENCE_PATHS` equals part 11's slots; exactly `web-apps-turned-off` and `web-apps-turned-on` have `scope: "declaration"`; for every choice of every retained reading, the choice's list equals `firstPublishViewFromStored` of what the birth stores for it under that choice's `runsOnlyOn`, and under the other declarations it gains or loses only the two Web Apps ids; a stored list of kind `next-publish` comes back as a view of that kind, with a Web App line only where the stored setting differs from the declaration; `unused-media-entries-removed` applies to a source with a map entry no reference and no logo entry names, and not to one whose only extra entry a logo names; `date-and-time-saved-as-hq-stores-it` applies to a reading of a source whose `nova_datetime_` sibling holds the earlier calculation, and to one whose Save to Case value holds the earlier spelling, and to neither source written in the current spelling; and for each of `connect-app-captures-location`, `location-list-setting-reset`, `web-apps-turned-off` and `web-apps-turned-on`, over the facts on which it applies, `lib/deployment/importApplication.ts::hqImportApplication`'s body (built over `adoptionExportBoundary`'s options, with the reading's source as the update's read) holds the entry's one top-level key (`auto_gps_capture`, `location_fixture_restore`, `cloudcare_enabled`) at a value other than the source's, and over the facts on which it does not, at the source's value or absent | the register over readings, and over the body a first publish sends | an entry that never applies; a same-state rule with no declaration; a rewrite the reader reports that no line says; a stored list that tells a person Web Apps is turned off after they turned it on; a shell edit and a predicate that part ways |
| `lib/publish/__tests__/firstPublishCopy.test.ts`: every sentence is non-empty, ends in a full stop, holds no em dash and no ellipsis; `firstPublishLines` puts each line in the group `FIRST_PUBLISH_TOUCHES_WORKERS` gives it, in registry order, gives the reassurance exactly where `touchesWorkers` is false, the review's lead for `review` and the publish's for `publish`, and the note always; a view of kind `next-publish` takes part 15's heading and lead on the `publish` surface and every other member as any view does; two ids said by one sentence give one line; an id and the id that says it have the same `touchesWorkers`; every value of `FIRST_PUBLISH_SAID_BY` is a `FirstPublishSentenceId` | the copy | a line with no words; a list ordered by accident; a worker-touching first publish told workers see the same questions; one sentence shown twice |
| `proof/ci/__tests__/firstPublishChanges.test.ts`: the file's ids are `FIRST_PUBLISH_CHANGE_IDS` in order; each object's `source` rows are exactly the entry's `paths` (entry 1's four written pointers; its inert allowance has no row); a `proof3` row stands only under an entry whose `touchesWorkers` is true | `proof/first-publish-changes.json` against the register (section 13.2) | the lane accepting a stored-app difference the register does not allow, or a behavior difference under an entry that declares none |
| `lib/commcare/__tests__/appStrings.test.ts`: `localAppStringTable(doc)` equals, language by language, the tables `compileLocalArchive` serializes for the same document, over the corpus, a document that reads a lookup table among them; the tables are equal under two stand-in targets and under the identity and a real naming; a document whose app string holds a literal backslash-`n` gives its table and does not throw, where `compileCcz` throws; `compileCcz`'s bytes are those of `main` for every corpus document | the split of `compileCcz` | a classifier judging keys against strings no build makes; a reading that throws on a string the archive cannot carry; a changed archive |
| `lib/deployment/reading/__tests__/readingAppStrings.test.ts`: for a corpus document and its own lookup context the function answers `localAppStringTable`'s table; for the same document with one question's id changed to its sibling's it answers null and does not throw; for a document that reads a table, a context that lacks the table answers null and one that holds it beside a table nothing reads answers the table | `readingAppStrings` over the production gate | a reading that throws inside Nova's build for a document a finding left provisional; a key classified against strings of a document Nova would never write |
| `adoptionBoundary.test.ts`: over a retained reading with a table and two files, `expandDoc` under `adoptionExportBoundary`'s options is byte-equal to `expandDoc` under the options a publish to the adopted deployment builds after the birth | the boundary against `prepareExportBoundary` | a baseline descriptor computed over a body the first publish does not send |
| `datetimeSplitReadBack.test.ts`: for every corpus document that holds a date and time question, the split document's emission reads back to the split document under `matchingResolver` | the reader over `lib/doc/datetimeSplit.ts`'s result | a split that no reading could ever offer |
| `lib/deployment/__tests__/firstPublishBaseline.postgres.test.ts` (real Postgres): an adopted baseline written with a list is read back by `readFirstPublishStates` for a viewer, and a non-member is refused; a push baseline over it leaves the column null in the one upsert and the CHECK holds; a direct `UPDATE` setting a list beside the origin `create` or `unread` is refused by the CHECK; `recordRefreshedAppBaseline` over a read baseline writes `keep` and the list stays; a `keep` over another HQ app leaves none; a `set` with a list of kind `next-publish` over a `push` baseline is read back, and `firstPublishOf` answers it for a mapping Nova created; a write the upsert's `WHERE` turns away changes nothing; a stored id outside the registry is dropped and the rest kept; a stored value of another shape reads as no list and is logged; an ended deployment's `DeploymentView.firstPublish` is null; the read selects no `source_gzip` (the query log shows none) | `recordAdoptedDeploymentInTransaction`, `writeAppBaseline`'s two arms, `readFirstPublishStates` and `readDeploymentsAction`, in one database | a list that outlives the baseline it describes, or is lost before the first publish; a push that fails the CHECK; a viewer's Publishing card that throws |
| `lib/case-store/migrations/__tests__/hqBringInLedger.postgres.test.ts` (part 10's file; this part adds the CHECK's case): after `up`, `app_deployment_baselines.first_publish_changes` exists and is nullable, a row whose origin is `read`, `push`, `changes` or `cutover` may hold a list, and a `create` or an `unread` row may not | the migration | the column missing where the birth writes it; a list beside the baseline of an empty app, or beside one Nova could not read |

The bring-in's test at the size cap (part 12, section 3.6, and its "Tests") runs `acceptReading`
whole over a source at the cap. It is that part's test, and this part adds no test of cost.

---

## Contracts and docs these changes make false

| Where | Old sentence | Replacement |
|---|---|---|
| `lib/commcare/hq/publishedCaseBlocks.ts`, header | "The reader returns only what it read; the caller counts what it left out." | part 07's replacement stands; this part adds: "Acceptance of a reading is its caller (`lib/deployment/reading/identityAgreement.ts`), and fails a reading for any form listed in `unread`." |
| `lib/commcare/compiler.ts`, `compileCcz`'s doc comment | (describes one function) | adds: "`compileCczParts` is the same walk up to each language's app-string table and before any is serialized, and `lib/commcare/appStrings.ts::localAppStringTable` reads a document's app strings from it." |
| `biome.json`, the four messages that list the allowed consumers of `@/lib/commcare` | (each names `lib/export/boundaryValidation` and no `lib/export/boundaryFindings`) | each gains "lib/export/boundaryFindings, " before "lib/export/boundaryValidation", and both overrides' `includes` gain `"!lib/export/boundaryFindings.ts"` (section 4). The first sentence of the same four messages is part 06's row (06-the-reader-forms.md, "Contracts") |
| `lib/export/CLAUDE.md`, the first paragraph | "`lib/export/boundaryValidation.ts` is the one server-only preparation seam for every artifact and direct-HQ export." | adds: "Its row and mode findings (the lookup carrier's, the fixed-place owner's and the two nested selections') are computed by the pure `boundaryFindings.ts::exportCarrierFindings`, which the seam calls and which acceptance of an app brought in from CommCare HQ calls for the first publish it will make." |
| `lib/deployment/CLAUDE.md`, new subsection "Accepting a reading" | (none) | "`reading/acceptance.ts::acceptReading` is the one judge of a reading: complete accounting, the gate and the export readiness of a first publish under every declaration the review will offer, the exact fixed point over Nova's own emission of the document and of the split document a declaration can make, identity agreement between CommCare HQ's source and that emission, and agreement with CommCare HQ's own question summary. It is pure and runs on the request. A failure after a clean read is `read-back-differs`, Nova's own. It reads no expression's meaning: the reader's re-emission comparisons and the proof lane hold that. `reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES` is the closed list of what a first publish over an adopted app may change; what a person reviewed is kept on the read baseline and ends with the first push. `reading/readBack.ts::readBackDifferences` is the one comparison of a document with its read back, made by tests, by the proof lane and where Nova asks whether two readings of CommCare HQ's app are one document, and never by acceptance." |
| `lib/deployment/CLAUDE.md`, "Baselines" | the sentence that lists what a baseline row holds | adds: "A baseline of origin `read` also holds `first_publish_changes`: the first-publish changes the person reviewed that do not depend on where the app runs, and the Web App setting CommCare HQ held. After changes made in CommCare HQ are brought in or recorded, a baseline can hold a list of the other kind in the same column: what the next publish changes there. The value's `of` says which kind it is. A `create` and an `unread` baseline hold none, and the one upsert clears it when a push replaces the baseline. `store.ts::readFirstPublishStates` returns it to a viewer and never the source, and `resources.ts::firstPublishOf` is the one rule that turns it into the list a surface shows." |
| `lib/db/CLAUDE.md`, the `app_deployment_baselines` row | its column list | adds `first_publish_changes`: "never set beside origin `create` or `unread`, held so by a CHECK" |
| `docs/architecture/contracts.md`, "HQ deployment safety" | (no sentence on a first publish over an adopted app) | "The first publish over an app brought in from CommCare HQ changes only what `FIRST_PUBLISH_CHANGES` declares, each entry shown to the person at the review and again before that publish. The proof lane holds the declared set equal to the observed set on every HQ-authored base." |
| `content/docs/publishing.mdx`, "On CommCare HQ", after part 13's sentence for a brought-in app | (none) | one paragraph: "The first time you publish an app you brought in, Nova lists what will differ in CommCare HQ: what workers will notice, and what changes only in how CommCare HQ stores the app. The same list is shown before you bring the app in." |

The `lib/commcare/CLAUDE.md` subsection on rewrites is part 08's row, and `proof/README.md`'s section
on first-publish changes is part 14's.

---

## Departures

Departures from the outline, the research and the manifest, and the alternatives this part weighed
and did not take. Each states the decision and its evidence; a "Not done" names the alternative an
implementer could reach for, and why it is not built.

1. **Every failing check is `read-back-differs`, not checks 3 to 5 alone.** A failure of check 2, and
   a `ReaderDefect` beside a clean read, are `read-back-differs` too. Evidence: the other candidate
   says something false. `unrecognized`'s block says Nova met something it has no reading for. The
   same holds for the other failures of check 1 (a hand-off settled twice, a settlement no hand-off
   matches): each contradicts a contract of Nova's own. The one exception stays as part 06 decided:
   an unsettled hand-off is `unrecognized`. The block's body is true of all five (part 01, section
   9.3).
2. **The types acceptance is called with are section 2.2's, each member one a check needs and
   cannot derive.** The failing arm's `check` is one of five and never null, so part 12's log line
   is total; the `ok` arm holds `declarations`, each with its own first-publish list; the input
   holds `target`, `choices`, `settlements`, `lookup`, `mediaLeftOut` and `media`, and holds no
   `projectData` of part 12's type. Not done: a failing arm whose `check` is one of three or null,
   an `ok` arm of two members, or an input typed with part 12's gathered project data, because
   acceptance is pure and takes no type of the request that calls it.
3. **Check 3 re-reads D, and the split document where one is offered, in every call** (section
   5.4). Not done: one re-read a call, the split's only once a person chose it. Evidence: part 06's
   section 16.3 leaves at most one split choice, so that is at most two re-reads; a read and a
   create then judge the same documents; and a split that does not read back is found before the
   review offers it.
4. **Three rewrite sites an implementer could expect to be declared are not, and a fourth
   candidate is no rewrite site.** The required stamp changes no behavior (HQ's build writes it),
   so nothing declares it. A date and time question an app made in CommCare HQ saves straight to a
   case is not declared but refused, by part 07, because such a source stores the day alone (the
   spelling Nova itself wrote before this step is Departure 23's). Markdown forms get no entry: Nova
   holds each as its own state (part 03, 03-questions-and-text.md, section 8). And "new export
   columns" is no rewrite site: it is the generated-node entry `hidden-values-added`.
5. **An entry's predicate is over the reading, not over CommCare HQ's source alone.** It reads
   CommCare HQ's source, the document, the reader's facts, the generated nodes Nova plans for the
   document under the choice, the media path assignment and the declaration choice. Not done: a
   predicate over the source alone. Evidence: whether Nova adds a trimmed sibling, lifts a count or
   changes the Web App setting is not a fact of the source alone; three entries depend on what the
   person chooses.
6. **Check 4 takes no type class from the reader.** It reads each bind from the XML through a
   module that imports no reader module (section 6.1). Not done: a list of bind types in the
   reader's facts for check 4 to compare, because a type class the reader reported would agree
   with the reader's own mistake.
7. **`setvalue` and a menu's case type are not compared in check 5.** HQ reports only the source's
   first setvalue on a path, and part 05's aligned menu carries no case type. A menu's case type
   is held by check 4's `menus`.
8. **The register and the lane's file each hold what can be written where they stand.** Not done:
   one file holding each entry's difference class and every path it allows. The TypeScript
   register holds the stored-source pointers, which can be written at source. The lane's entries
   are part 14's, written from each base's evidence into its `proof/first-publish-changes.json`,
   as identity moves are, because a trace path guessed ahead of a run would be a path nobody
   observed. The two are tied by the ids and by the file's one Vitest (section 13.2). The lane
   file keeps the shape part 14 writes; this part writes its one Vitest.
9. **One nullable column**, `app_deployment_baselines.first_publish_changes`. The first publish
   states what it changes (section 12.2), and nothing of a reading is kept between the read and
   the create, so the list needs a home. It is no document migration, no backfill and no scan. It
   is the only home: nothing else holds a copy of the list, and part 13 adds no column (section
   12.3).
10. **Six entries no part handed on**, each found at source:
    `forms-and-settings-rewritten`, `hidden-values-added`, `blank-translations-filled`,
    `web-apps-turned-off`, `web-apps-turned-on` and `date-and-time-questions-split`; and
    `unused-media-entries-removed` reworded, since HQ's build and its multimedia page run the same
    prune.
11. **The outline.** Item 1's "passes the absolute gate, or refuses with the place and
    the reason" is check 2 and section 14. Item 9's "this step's plan decides how the reader recognizes
    [the split's] result on a later read" is part 06's section 16.4 with section 5.4 here. Item 10's
    "matches an imported form's case transactions to placements through `publishedCaseBlocks`" is part
    07's readers with check 4 as their independent hold. Item 7 (feature-matrix apps) is part 14's.
    Items 2 to 6 and 8 are other parts', each named there. The outline's cutover and its Contracts rows
    are parts 10 and 11's.
12. **Three keys are handed to the re-read at the source's values and not at their schema
    defaults**: `build_spec`, `multimedia_map` and `logo_refs` (section 5.1). Evidence: Nova's body
    never carries them (`hqShells.ts::applicationShell`), CommCare HQ keeps each through an update
    (`_merge_source_into_app`), and the reader refuses the default `build_spec` (`{ version: null }`)
    under the `34p` entry and reads the logo from `logo_refs`, so at their defaults no app would pass.
    Every other absent key reads as CommCare HQ's schema default.
13. **The narrowing by files happens before acceptance**, and acceptance judges exactly the choices
    the review offers (section 4); the request that calls it filters none afterwards. Not done:
    narrowing the choices after acceptance. Evidence:
    `validator/rules/media/mediaFormatPlays.ts` refuses a file's format per declared platform, so with
    the files' rows check 2 would fail a choice that was about to be dropped, and a correct reading
    of an app with a Web-Apps-only file would end as Nova's mistake.
14. **Check 2 runs a first publish's row and mode findings** through `exportCarrierFindings`, moved
    out of `boundaryValidation.ts` unchanged. Not done: acceptance over `exportReadinessFindings`
    alone. Evidence: `exportReadinessFindings` is `evaluateBoundary` alone, and the birth relies on
    acceptance for a rule that only the boundary's private functions hold (part 12, section 6.2).
15. **Check 4 maps a generated sibling to its owner by each side's own list**, `GA` and `GE`
    (section 6.4, step 1), and imports no reader module. Not done: comparing through part 07's
    `caseManagement/basicActions.ts::ownerQuestionPath` (its section 6.1). Evidence: the comparison
    is evidence only while it shares no classification with the reader
    (`sourceIdentity.independence.test.ts`); `ownerQuestionPath` is the reader's.
16. **One renderer, one copy and one stored list, all here** (sections 12.2 and 12.3). Not done: a
    renderer, a copy or a stored list of part 13's own. Evidence: a list stored from the review's
    preselected choice is wrong whenever the person chose another declaration, and two strings
    would have shared one constant name. Part 13 draws `firstPublishLines` and reads
    `DeploymentView.firstPublish`; where the list sits over MCP is part 13's to say.
17. **From the manifest entry
    `questions/an-explicitly-blank-value-in-a-non-default-language-where-the` (REFUSED, not
    HQ-editable).** Decision 19 reads such a blank as no translation and declares the fill, where the
    manifest refuses it today. Evidence: the entry's own reason is that CommCare HQ's form builder fills
    a blank translation from the default language on every save, and
    `lib/domain/translationFill.ts::filledProse` is that same fill. The step the refusal would send a
    person to (open and save each form in the form builder) writes exactly what Nova's first publish
    writes, so declaring it asks nothing of the person and changes nothing more. Part 06 re-cuts the
    entry to HELD with its inventory row (its section 12.2). The departure covers exactly a language
    other than the first whose first-language text is not blank. A blank in the first language where
    another language holds text stays refused: the form builder fills that one from whichever language
    holds text (Vellum `javaRosa/itext.js::ItextForm.getValueOrDefault`), so it is another shape with
    its own entry,
    `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text`.
18. **Check 5 compares no type.** CommCare HQ's type is a lookup over a control's tag, bind type,
    media type and appearance (`xform.py::_infer_vellum_type`), and check 4 compares all four between
    the source and Nova's emission, from the XML. The one case check 4 passed over, an appearance
    Nova holds that the reader called inert, is `identity/appearance/inert-held`. Not done: a port of
    HQ's lookup held to HQ by a lane run. A port would also have had to skip every row HQ's lookup
    falls back on, a group written `Field-List` among them (`_index_on_fields`).
19. **The rewrite registry holds nine rows.** A row is kept where the reader prints without the
    rewrite or reports it (section 10). Not done: a row and a `reached` call for every place the
    emitter spells something its own way, read by one test about the registry.
20. **Nothing is declared for a held media path, or for a default's `current()` spelling.** Each
    was read at source and found to change nothing: a held path keeps its version (part 10,
    "Executed during planning"), and both spellings of a default name one node (part 08, "Executed
    during planning"). Not done: a register entry for either that lands on a lane run's outcome.
    Each keeps a control where it is owned: an assertion on the base `hq-media` (part 10, section
    4.7) and part 08's native test of the two spellings. Where part 08's control fails, the reading
    of Core was wrong, and the entry is added as section 11.3 says an entry is added. Where
    `hq-media`'s fails, part 10 changes the upload (its section 4.7) and still nothing is declared.
21. **Three lines are said by one, and three reasons by one entry.** `created_from_template`,
    `search-filter-rows-recut` and `list-settings-respelled` have no sentence of their own: no page
    and no runtime reads the first, and a person cannot tell the other two from the first line of
    the list, which says them. The two rows stay, because each holds a pointer and a narrow predicate
    the lane's judge needs. A media path Nova cannot keep is one entry, `media-files-renamed`,
    whatever the reason: the three reasons have the same paths and the same effect, a person cannot
    act on the reason, and the lane's judge cannot tell them apart (part 14, section 9.3). Not done:
    a sentence for each.
22. **A logo entry with no `m_id` is refused, not removed and declared.** CommCare HQ's uploader
    always stores `m_id` and Nova writes no `logo_refs`, so no app made in either holds the shape,
    and Web Apps and the Android profile read such an entry's path whether or not it names a file
    (part 06, section 6.1). Not done: a register entry that removes it and says no logo changes.
23. **A list sorted by a date and time gets no entry, and the spelling Nova wrote for a saved date
    and time before this step gets one.** Part 03 fixes the order where it goes wrong, in the text
    a phone writes to a case (its section 7.1), and changes no order rule, sort element or column.
    Not done: a hidden number key for the rule, with a pointer for it under
    `forms-and-settings-rewritten`. Core reads such a key back as no number, and a hidden field
    would join what a worker's list filter matches (part 03, "Executed during planning" and its
    Departures). The earlier spelling is
    declared and not read as exact, because a phone stores other text after the first publish, and
    not refused, because the app is one Nova wrote and reads whole. It is the one entry an app made
    in CommCare HQ can never meet.
24. **The reader's `appStrings` is gated, in `readingAppStrings`.** Not done: handing the reader
    `localAppStringTable` itself. Evidence: `compileCcz`'s oracles throw for a document the gate
    refuses, part 06 asks for the strings of a provisional document wherever a finding stands (its
    section 16.5), and the reader cannot run the gate itself (`lib/doc/commitVerdicts.ts` imports
    `lib/commcare`, part 06, section 16.1). Not done either: catching what the build throws and
    answering null, which would read a defect of Nova's build as a fact of the app.

---

## Files

**New.**

| File | Holds |
|---|---|
| `lib/deployment/reading/acceptance.ts` | `acceptReading`, `AcceptReadingInput`, `AcceptedReading`, `AcceptedDeclaration`, `ACCEPTANCE_CHECKS`, `AcceptanceCheck`, `AcceptanceDifference`, `placeOfLocation` (sections 2 to 4) |
| `lib/deployment/reading/emission.ts` | `readingEmission`, `emissionAssets`, `sourceFromEmission`, `alignedFromEmission` (section 5) |
| `lib/deployment/reading/fixedPoint.ts` | `fixedPointDifferences` (section 5) |
| `lib/deployment/reading/identityAgreement.ts` | `identityDifferences` (section 6) |
| `lib/deployment/reading/summaryAgreement.ts` | `summaryDifferences`, `documentSummary`, `DocumentSummaryRow` (section 7) |
| `lib/deployment/reading/signature.ts` | `differenceSignature`, `documentPathKinds`, `DOCUMENT_SCHEMA_KEYS` (section 14.2) |
| `lib/doc/documentDifferences.ts` | `documentDifferences`, `DocumentDifference` (section 14.2), with `__tests__/documentDifferences.test.ts` |
| `lib/deployment/reading/readBack.ts` | `readBackDifferences`, `ReadBackDifference`, `ReadBack` (section 9.1) |
| `lib/deployment/reading/firstPublishChanges.ts` | `FIRST_PUBLISH_CHANGES`, `FirstPublishChange`, `FirstPublishFacts`, `firstPublishFactsOf`, `GeneratedDifference`, `firstPublishChangesFor`, `generatedDifference`, `emittedGeneratedNodes`, `GENERATED_NODE_CHANGE`, `MEDIA_REFERENCE_PATHS` (section 11) |
| `lib/deployment/reading/appStrings.ts` | `readingAppStrings` (section 15.1) |
| `lib/deployment/reading/adoptionBoundary.ts` | `adoptionExportBoundary` (section 15.2) |
| `lib/deployment/reading/__tests__/` | `readingAppStrings.test.ts`, `acceptance.accepts.test.ts`, `acceptance.doctored.test.ts`, `acceptance.media.test.ts`, `acceptance.declarations.test.ts`, `acceptance.purity.test.ts`, `emission.parity.test.ts`, `identityAgreement.test.ts`, `generatedNodes.parity.test.ts`, `summaryAgreement.test.ts`, `signature.test.ts`, `readBack.test.ts`, `readBack.retained.test.ts` (where 9.1 says it is written), `notCarried.test.ts`, `canonReadBack.fuzz.test.ts`, `firstPublishChanges.test.ts`, `adoptionBoundary.test.ts`, `datetimeSplitReadBack.test.ts` |
| `lib/export/boundaryFindings.ts` | `exportCarrierFindings`, with `lookupExportFindings`, `organizationExportFindings` and `LookupRowVerdictInput` (section 4) |
| `lib/commcare/hq/sourceIdentity.ts` | `sourceIdentity`, `SourceIdentity`, `FormIdentity`, `AnswerLeaf`, `ContainerIdentity`, `ControlAsWritten`, `CoreTypeClass`, `coreTypeClass`, `CORE_BIND_TYPE_CLASSES` (section 6), with `__tests__/sourceIdentity.test.ts`, `sourceIdentity.independence.test.ts` and `sourceIdentity.corpus.test.ts` |
| `lib/commcare/reader/canon.ts` | `CANONICALIZATIONS`, `Canonicalization`, `canonDocument` (section 9), with `__tests__/canon.test.ts` |
| `lib/commcare/appStrings.ts` | `localAppStringTable` (section 15.1), with `__tests__/appStrings.test.ts` |
| `lib/commcare/xform/__tests__/generatedNodePaths.test.ts` | the emitter's placement of each generated node (section 6.3) |
| `lib/publish/firstPublishChangeIds.ts` | `FIRST_PUBLISH_CHANGE_IDS`, `FirstPublishChangeId`, `FirstPublishView`, `firstPublishViewSchema`, `FIRST_PUBLISH_TOUCHES_WORKERS`, `FIRST_PUBLISH_SAID_BY`, `FirstPublishSentenceId`, `firstPublishSentenceId`, `StoredFirstPublish`, `storedFirstPublishSchema`, `firstPublishViewFromStored` (sections 11.1, 12.3) |
| `lib/publish/firstPublishCopy.ts` | `FIRST_PUBLISH_SENTENCES`, the heading, the leads, the labels, the reassurance, the note, `FirstPublishLine`, `FirstPublishLines` and `firstPublishLines` (section 12.2, Copy), with `__tests__/firstPublishCopy.test.ts` |
| `lib/deployment/__tests__/firstPublishBaseline.postgres.test.ts` | the stored list's writer, its two arms and its readers, over real Postgres (section 12.3) |
| `proof/ci/__tests__/firstPublishChanges.test.ts` | the lane file's one Vitest (section 13.2) |

**Changed.**

| File | What changes |
|---|---|
| `lib/export/boundaryValidation.ts` | calls `exportCarrierFindings`; its answers do not change (section 4) |
| `biome.json` | in both overrides that list `"!lib/export/boundaryValidation.ts"`, `includes` gains `"!lib/export/boundaryFindings.ts"` before it, and each of the four message strings gains "lib/export/boundaryFindings, " before "lib/export/boundaryValidation" (section 4) |
| `lib/deployment/types.ts` | `AppBaselineWrite.firstPublish` (section 12.3) |
| `lib/deployment/store.ts` | `writeAppBaseline`'s insert list and conflict arm; `readFirstPublishStates` |
| `lib/deployment/adoption.ts` | `adoptedAppBaselineWrite`'s `firstPublish` input |
| `lib/deployment/service.ts` | `appBaselineFor` passes `set` with null |
| `lib/deployment/resources.ts` | `firstPublishOf` |
| `lib/deployment/actions.ts`, `index.ts` | `DeploymentView.firstPublish`, filled through `firstPublishOf` by every maker of the view |
| `lib/db/pg.ts` | `AppDatabase`'s `first_publish_changes` column, typed as 12.3 gives it |
| part 10's migration `20261201000000_hq_bring_in_ledger` and its test `hqBringInLedger.postgres.test.ts` | the three clauses of 12.3 in its statement 10, and the CHECK's case |
| `proof/first-publish-changes.json` | part 14's file: this register's ids and every entry's `source` rows (section 13.1) |
| `proof/corpus/publish.ts` | its `hqAuthoredA` arm's `adoptedAppBaselineWrite` call passes `firstPublish: { ids: [], touchesWorkers: false, of: "first-publish" }`. No lane check reads the stored list, and a base's predicted ids reach the lane through `first-publish.json` |
| `lib/commcare/xform/builder.ts` | `buildLabelNodes` exported (section 7.3); the comments of section 10 at its sites |
| `lib/commcare/xform/generatedNodes.ts` | `generatedNodePaths` (section 6.3) |
| `lib/commcare/casePlacementPlan.ts`, `hqShells.ts`, `expander.ts`, `xform/constraintMessage.ts`, `xform/datetimeCaseValue.ts`, `lib/domain/caseScalarTextGuard.ts` | the comment of section 10 at each site, and no code of this part's |
| `lib/commcare/compiler.ts` | `compileCczParts`, `CompilePartsOptions`, `CczParts`; `compileCcz` calls it (section 15.1) |
| `lib/commcare/hq/publishedCaseBlocks.ts` | its header's sentence ("Contracts") |
| `lib/export/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `lib/db/CLAUDE.md`, `docs/architecture/contracts.md`, `content/docs/publishing.mdx` | the rows of "Contracts and docs these changes make false" |

**Moved, bodies unchanged.** `lookupExportFindings`, `organizationExportFindings` and
`LookupRowVerdictInput` from `lib/export/boundaryValidation.ts` to `boundaryFindings.ts` (section 4),
and `compileCcz`'s walk into `compileCczParts` (section 15.1).

**Removed.** Nothing.
