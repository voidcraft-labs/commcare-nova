# Step 6, part 09: Acceptance and what the first publish changes

Part of the step 6 plan ("Bring in an app from CommCare HQ"). This part plans pull request **B7** in full:
the pure function that accepts a reading (`acceptReading`, five checks), the identity record check 4
compares over CommCare HQ's source and over Nova's emission, the comparison of CommCare HQ's own question
summary with the document, the closed canon list a Nova-born document is read back under, the typed
registry of every behavior-changing rewrite in the emitter (`EMISSION_REWRITES`, begun by B6), the closed
register of what a first publish changes (`FIRST_PUBLISH_CHANGES`) with every entry and its sentence,
how the review and the first publish receive the entries that apply, what the register gives part 14's
lane file `proof/first-publish-changes.json`, and what a failed acceptance (`read-back-differs`) logs,
stores and says. It also supplies three things other parts call: the production
`ReaderInput.appStrings`, `adoptionExportBoundary` and the read-back comparison `readBackDifferences`.
The lines of other pull requests that this part words (B8, B9, B10, B11, B12, A1, B13 and B14) are
named under "Files by pull request". In the stack B7 sits above B9 and below B10 (Departure 14): it
calls B8's and B9's pure functions, and B10 calls it.

Citations are `path::symbol`: Nova at `main` `15a00a97`, and the Dimagi checkouts at commcare-hq
`d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect
`046c7fd78081`, formplayer `24383ac71bfb` and Vellum `01215f251c57`. Every CommCare fact below was read
at those commits for this part. Other parts are cited as "part NN (file name), section N" and by pull
request id.

Versions: nothing in B7 changes a served tool input, a tool description or the guide, so
`lib/models.ts::MODEL_CONTEXT_VERSION` does not move in B7; `lib/db/appTests.ts::RUNTIME_VERSION` stays
`19`, the value A9 leaves (part 04, 04-names.md, section 3.4).

| Section | Owns | Pull request |
|---|---|---|
| 2 | `acceptReading`: files, types, order, modes, cost | B7 |
| 3 | check 1, complete accounting | B7 |
| 4 | check 2, the gate and export readiness, per declaration | B7 |
| 5 | check 3, the fixed point: what "emission of D" is, the re-read, the equality | B7 |
| 6 | check 4, identity agreement: `sourceIdentity`, the extended `publishedCaseBlocks`, entry facts | B7 (the extension itself is B4's, part 07) |
| 7 | check 5, CommCare HQ's question summary against the document | B7 |
| 8 | which check catches which reader bug, and what holds the rest | B7 (prose) |
| 9 | the canon list for Nova-born documents, and the one read-back comparison | B7 (part 14 runs both in proof 6, B13) |
| 10 | `EMISSION_REWRITES`: the entries B7 adds and the site test | B7 |
| 11 | `FIRST_PUBLISH_CHANGES`: the type, every entry, every decision | B7 |
| 12 | what the review and the first publish are handed, and where it is kept | B7; the column's DDL rides B8 (part 10's migration); part 12 passes the list in B10 |
| 13 | what the register gives part 14's `proof/first-publish-changes.json` and its judge | B7 (the ids, every entry's `source` rows and the file's one Vitest); A1 and B13 (the file's shape, its loader and the judge, part 14) |
| 14 | `read-back-differs`: the finding, the signature, the log, the words | B7 |
| 15 | the production `appStrings` and `adoptionExportBoundary` | B7 |

---

## Decisions in brief

1. **Acceptance is one pure function, `lib/deployment/reading/acceptance.ts::acceptReading`**, of the
   source, the aligned menus, the reader's outcome and the project data. It reads no clock, no store and
   no network, takes and returns plain data, and runs in part 12's worker (section 2).
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
7. **Check 3 runs once a call.** A read step checks D. A creation whose chosen declaration takes the
   split checks the split document in D's place, and any other creation checks D, so each call makes
   one re-read and the check's cost is one number for run K4 to measure (section 5.4).
8. **Check 4 compares a `SourceIdentity` extracted from JSON and XML alone**, by a module that imports no
   reader module: answer leaves with their repeats and Core type class, containers, choice values,
   `xmlns`, ids, case blocks through the extended `publishedCaseBlocks`, and entry facts (section 6).
9. **A generated answer leaf is never an identity difference.** Each side's generated leaves are
   removed by that side's own list (the reading's folded nodes for CommCare HQ's source, the emission
   plan for Nova's), and the difference of the two lists feeds the register. Two things are not cut: a
   generated case block (a guard) is a case block and is compared as one, and an appearance is removed
   from CommCare HQ's side only where the reader accounted it under an inert entry (sections 6.3, 11.3).
10. **A form `publishedCaseBlocks` leaves out fails acceptance**, on either side, under its reason. The
    reader's own entries name those shapes to the person; acceptance holds that none slipped past
    (section 6.4).
11. **Check 5 compares CommCare HQ's summary of the source with the document, never with Nova's
    emission**: paths, repeat and group, choice values, label and choice-label text per language,
    `xmlns` and ids, always-required, the presence of a display condition, a validation and a Hidden
    Value's calculation, and the type only where HQ's lookup matched a row exactly. Text is compared
    only where the source's label holds an itext reference, which is the only label CommCare HQ
    summarizes, and Nova's own case-name check never counts as the source's validation (section 7).
12. **A menu CommCare HQ could not summarize is skipped by check 5 and is never Nova's defect.** Part 12
    raises `menu-unreadable-in-hq` for it (section 7.6).
13. **The plan says what acceptance cannot hold.** What an expression means, what a list shows and what a
    link does rest on the reader's re-emission comparisons, on lane proof 3 with value expectations, and
    on the both-ways register judge (section 8).
14. **The canon list is a typed registry, `lib/commcare/reader/canon.ts::CANONICALIZATIONS`**, of two
    kinds: two documents with one wire, and content no export carries. Each row has a test that prints
    both documents and requires equal bytes. One function, `lib/deployment/reading/readBack.ts
    ::readBackDifferences`, makes the read-back comparison for this part's run K1 and for proof 6
    (section 9).
15. **Every behavior-changing rewrite site reports its id through `ExpandOptions.rewrites`**, and a test
    holds every id to a document that reaches it and a document that does not (section 10).
16. **Every rewrite whose `behavior` is `changes` is declared by a register entry or refused by a named
    manifest entry**, held by a test. None is left unaccounted (section 10.3).
17. **`FIRST_PUBLISH_CHANGES` holds 34 entries in B7**, each with its source, its predicate over the
    reading, the stored-source paths it allows, its sentence and whether it touches workers. Two more are
    written here and land only on a named gated outcome (section 11).
18. **Per candidate change the decision is one of three**: read the original's behavior exactly, refuse,
    or declare. Section 11.4 gives the decision for every candidate the research, the manifest,
    CommCare HQ's import or another part names, and every one found by reading the emitter.
19. **A date and time question saved straight to a case is refused, not declared.** CommCare stores the
    day alone for it and Nova stores the moment; part 07 (B4) raises its finding (section 11.4).
20. **A translation left blank in a language other than the first, where the first language holds
    text, is read as no translation and declared** (`blank-translations-filled`), because Nova writes
    the first language's text there as CommCare HQ's form builder does on every save. A blank in the
    first language where another language holds text stays refused, under part 06's own entry
    (06-the-reader-forms.md, section 12.2, B3) (section 11.4, Departure 21).
21. **The entries that apply are computed per declaration choice, from that choice's own document.**
    Three entries depend on the choice (Web Apps turned off, Web Apps turned on, the date and time
    split), and the generated nodes are planned over the document under the choice, never taken from
    check 3's re-read, so a choice's list is the same at the review and at creation (section 12.1).
22. **What a person reviewed is kept on the adopted baseline** (`app_deployment_baselines
    .first_publish_changes`): the entries that do not depend on the declaration, and the Web App setting
    CommCare HQ held. The two Web Apps lines are worked out again from the app's declaration as it
    stands, so an edit to where the app runs never leaves a stale line, and the push that replaces the
    baseline ends the list (section 12.3).
23. **The lane's file, its shape, its loader and its both-ways judge are part 14's.** B7 renames no
    id: part 14's A1 begins the file under this register's ids. B7 completes it with every entry's
    `source` rows (the stored-app pointers the entry allows), writes the file's one Vitest, and asks
    the judge for one new comparison (`source`), so an entry that changes only the stored app is
    observed (section 13).
24. **Every acceptance failure after a clean read is `read-back-differs`, except an unsettled hand-off**,
    which is `unrecognized` as part 06 decided. That holds for every failure of check 1 too (a defect,
    a census that disagrees, a hand-off settled twice, a settlement no hand-off matches). The finding
    carries the check; the log line carries a content-free signature of at most 80 characters
    (sections 2.3 and 14).
25. **B7 sits above B9 and below B10 in stack B.** Acceptance calls B8's `adoption.ts` and
    `identityMap.ts` and B9's project data functions, and types its input with theirs; nothing of B8 or
    B9 imports B7 (Departure 14).
26. **One renderer words the list for every surface**: `firstPublishLines(view, surface)` gives the
    heading, the lead, the two groups, the reassurance and the note, and the review, the publish
    screen and MCP all draw that one value (section 12.2).
27. **Acceptance's own cost is measured, not argued**: run K4 times `acceptReading` whole at Nova's
    ceiling, with a named change for each outcome (section 2.5).

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

**The plan.** The outline; parts 01, 05, 06, 07, 08, 10, 11 and 12, the sections this part names.

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
`XFormParser.java::getDataType`, `::applyControlProperties`. The plan: parts 13 and 14, the sections
that hold the first-publish list and the lane's register.

**Verified at source (a leaf's label).** A leaf question has no absent label to collapse with a blank
one: `lib/domain/fields/base.ts` requires `label` on every input kind and makes it optional only on a
container. The one pair is a container's, which part 06 already holds
(`blank-container-label-is-absent`).

**Verified at source (the required stamp).** The stamp changes no behavior for an app CommCare HQ
built: HQ's build writes `required="true()"` on the bind of the question a create's name action names,
over whatever the source held (`xform.py::XFormCaseBlock.add_create_block`, its last `add_bind`). Nova
writes the same attribute into the source. What changes for a person is that the form builder shows
the question as always required. It is registered with `behavior: "none"` (section 10.2).

**Verified at source (a date and time question saved straight to a case).** For an app made in
CommCare HQ the difference is not a format, so it is no rewrite to declare. HQ's build binds a case
property to the question's path with no `type` (`xform.py::XFormCaseBlock.add_case_updates`), and Core
wraps a calculated `Date` under any type but `dateTime` as the day alone
(`Recalculate.java::wrapData`), so such an app stores a date. Nova stores the moment. Part 07 (B4)
raises the finding for the shape, under
`forms-and-case-writes/a-datetime-question-saved-straight-to-a-case` (its section 3.2), and this part
registers the rewrite as refused, not declared (section 10.2).

**Verified at source (the media map's prune).** The prune is not the import's alone.
`remove_unused_mappings` runs wherever `multimedia_map_for_build(remove_unused=True)` is called: the
import (`_update_valid_domains_for_media`), HQ's multimedia views (`hqmedia/views.py`, two callers),
every build's media suite (`suite_xml/generator.py`) and `messaging/whatsapputil.py`. On the working
app the import and the multimedia page are the two that save it. The prune does nothing while a form
of the app fails HQ's own validation (`remove_unused_mappings` returns where
`check_media_state()['has_form_errors']`), and it keeps every path in
`all_media_paths() | logo_paths`. The entry stands (`unused-media-entries-removed`) with that wording.

**Verified at source (the export rules that need a mode).**
`lib/doc/commitVerdicts.ts::exportReadinessFindings` is `evaluateBoundary` alone. The rule that refuses
a fixed-place owner (`organizationExportFindings`, `LOCATION_OWNER_EXPORT_NOT_ACTIVE`), the
select-source row rules and the nested-selection rule are private to
`lib/export/boundaryValidation.ts` and run only with a mode. Check 2 runs them, by the code a publish
runs (section 4, step 3), which is what makes true part 12's sentence that export readiness refuses
that owner (12-the-reading-and-the-birth.md, section 6.2).

**Verified at source (the media codes a `pending` call cannot judge).** The validator's media group is
not five file codes. `errors.ts::MEDIA_VALIDATION_CODES` holds the four asset codes and
`CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE`, which reads no file. `MEDIA_EXPORT_TOO_LARGE` is made only by
`boundaryValidation.ts::exportBudgetError` and its asset-count guard, never by
`exportReadinessFindings`. `MEDIA_FACT_CODES` is the four (section 2.4).

**Check 4 takes no type class from the reader.** `ReadFormFacts` holds no bind type (part 06,
06-the-reader-forms.md, section 17.3). A type class the reader reported would agree with the reader's
own mistake; `sourceIdentity` reads each bind from the XML itself (section 6.1, Departure 6).

**The failing arm's `check` is never null.** Section 2.2 gives the failing arm five checks, argued
under Departure 2, and part 12 (12-the-reading-and-the-birth.md, B10) calls section 2.2's types as
written.

---

## Written and not yet run

| Run | Where | Outcomes, and what lands for each |
|---|---|---|
| **K1. The canon list is complete.** `lib/deployment/reading/__tests__/canonReadBack.fuzz.test.ts` over the expression, xform, suite, advanced and names fuzz corpora: `readBackDifferences(canonDocument(D), read(expandDoc(D)))` is empty, the one read-back comparison of section 9 | B7's own CI, hosted runners, never a person's machine | **A**: empty on every sample: nothing more lands. **B**: a sample reads back to another document and the two print byte-equal emission: the pair joins `CANONICALIZATIONS` in B7 with its row of `canon.test.ts`, kind `one-wire`. **C**: a sample reads back to another document and the two print different bytes, or the reader answers an account for Nova's own emission: the reader module that owns the slot is corrected in its own pull request beneath B7 (B3 to B6), and B7 does not merge with this open |
| **K2. HQ's type rows.** `proof/hq/test_question_type_rows.py` in the lane's HQ unit writes `proof/hq-reads/reading/question-type-rows.json`: `_infer_vellum_type`'s answer for every tag, bind type, media type and appearance of `hqQuestionTypes.ts::HQ_TYPE_ROW_DOMAIN`. `lib/commcare/hq/__tests__/hqQuestionTypes.test.ts` holds `exactHqTypeRow` to the file | by hand through `.github/workflows/proof-slice.yml` on B7's branch; the Vitest in ordinary CI | **A**: the port agrees on every vector: the file is committed and stays as the control. **B**: a vector differs: `HQ_TYPE_ROWS` is corrected to HQ's answer in B7 and the vector stays. No outcome changes a check: a row the port cannot call exact is no evidence, never a failure |
| **K3. The register is closed.** Part 14's both-ways judge (14-proof.md, section 9.3, B13) over every HQ-authored base | the proof lane on hosted runners, in B13's own run, before stack B merges | **A**: on every base the predicted ids are the observed ids: each entry of `proof/first-publish-changes.json` takes its `bases` and its rows other than `source` from the run's evidence, as part 14's section 9.1 writes an entry. **B**: an observed difference no predicted id holds (`/<id>/unsaid`, or a difference no entry names). Which of three it is follows part 14's run P2. D does not hold what A held (its outcome R): the reader pull request that claims the entry (B3 to B6) is corrected and the run is made again; no entry is added. D holds it and Nova's emission of D loses it (its outcome B): the site is fixed in B7 with a unit test; no entry is added. D holds what A held and Nova's emission writes every such document this way (its outcome C1): B7 gains the entry by section 11.1's type (its source, its predicate over the reading's facts, the `source` pointers the run showed, its sentence in the voice of Copy C2 with no argument, and its rewrite id in `EMISSION_REWRITES` where a site makes it), and stack B does not merge until the person has read that sentence. **C**: a predicted id nothing shows (`/<id>/unseen`): its predicate is narrowed in B7 to the reading's fact that distinguishes the base, with the base as its test case. One candidate for C is decided at source and needs no clause: HQ's prune returns early while a form fails HQ's validation (`hqmedia/models.py::ApplicationMediaMixin.all_media` sets `media_form_errors` from `form.validate_form()`), and it runs after Nova's body is merged, so the forms it validates are Nova's own, which the bar holds HQ to accept on every base |
| **K4. Acceptance fits its budget.** `lib/deployment/reading/__tests__/acceptance.scale.test.ts` times `acceptReading` whole over the source of part 06's run R2 (Nova's ceiling), read clean, with three declarations offered, under `media: { files, rows }`, and once more as a creation whose chosen declaration takes the split | by hand on a hosted runner, on B7's branch, through `.github/workflows/reader-scale.yml` (part 06, B3), whose `scale` project holds the file, so no default run reaches it | **A**: at or under 40 seconds, which with the reader's own 20 fills part 12's `HQ_READING_CHECK_BUDGET_MS`: nothing lands. **B**: over 40 seconds: check 2 reduces the construction batch once (`prepareMutationCandidate(emptyBlueprintDoc(appId), batch)`) and judges each choice by `mutationCommitVerdict(reduced.nextDoc, c.mutations, lookupContext)`, which reduces to the same candidate and so gives the same verdict; `acceptance.declarations.test.ts` gains the case that holds the two forms equal over the corpus, and the run is made again. **C**: still over after B: nothing more is cut from the checks. Part 12's `over-budget` arm already answers `too-large` for such a reading (its section 3.3, step 8). The run is made again over part 06's R2 source cut to 125, then 100, then 75 forms (200 questions and three languages each, as R2 builds them), and the largest of the three at which acceptance is at or under 40 seconds becomes, in B7, the size `readerScale.scale.test.ts` builds and the ceiling part 06's run R2 states, so the size at which a reading is too large is one number in the plan. Part 12's run M1 (B10, above B7) asks the same of the check's memory and, under its outcome B, lowers that same number by this same ladder, so the smaller of the two is the ceiling. Where 75 forms does not fit, stack B does not merge and the person is told, with the three timings |
| **Part 08's E4**, consumed here | as part 08 (08-the-reader-expressions.md) sets it | **A**: `default-reads-current` stays `behavior: "none"` and has no register entry. **B**: its entry lands as written in section 11.2 (id `default-reads-current`, sentence C5) |
| **Part 10's G2**, consumed here | as part 10 (10-identity-and-the-ledger.md) sets it | **A**, **C**: nothing lands here. **B**: the entry `media-downloaded-again` lands as written in section 11.2 |
| **Part 07's G3**, consumed here | as part 07 (07-the-reader-cases-menus-lists.md) sets it | **A**, **B**: nothing lands here. **C**: the reading's row of part 07's section 13.3 is already an entry of section 11.2; nothing more lands |

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
  what it left out"). It reads no conditions, close conditions or index identifiers. Part 07 (B4)
  extends it.
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

## 2. `acceptReading` (B7)

### 2.1 Files

| File | Holds |
|---|---|
| `lib/deployment/reading/acceptance.ts` | `acceptReading`, `AcceptReadingInput`, `AcceptedReading`, `AcceptedDeclaration`, `ACCEPTANCE_CHECKS`, `AcceptanceCheck`, `AcceptanceDifference`, `MEDIA_FACT_CODES`, `placeOfLocation` |
| `lib/deployment/reading/emission.ts` | `readingEmission`, `emissionAssets`, `sourceFromEmission`, `alignedFromEmission` (section 5) |
| `lib/export/boundaryFindings.ts` | `exportCarrierFindings`: the pure row and mode findings of an export, moved out of `boundaryValidation.ts` with their bodies unchanged (section 4) |
| `lib/deployment/reading/fixedPoint.ts` | `fixedPointDifferences` (section 5) |
| `lib/deployment/reading/identityAgreement.ts` | `identityDifferences` (section 6) |
| `lib/deployment/reading/summaryAgreement.ts` | `summaryDifferences`, `documentSummary`, `DocumentSummaryRow` (section 7) |
| `lib/deployment/reading/signature.ts` | `differenceSignature`, `documentPathKinds`, `documentDifferences`, `DocumentDifference`, `DOCUMENT_SCHEMA_KEYS` (section 14.2) |
| `lib/deployment/reading/readBack.ts` | `readBackDifferences`, `ReadBackDifference`, `ReadBack`: the one read-back comparison, which run K1 and part 14's proof 6 both make (section 9) |
| `lib/deployment/reading/firstPublishChanges.ts` | `FIRST_PUBLISH_CHANGES`, `FirstPublishChange`, `FirstPublishFacts`, `FirstPublishSource`, `GeneratedDifference`, `firstPublishChangesFor`, `generatedDifference`, `emittedGeneratedNodes`, `GENERATED_NODE_CHANGE`, `MEDIA_REFERENCE_PATHS` (section 11) |
| `lib/deployment/reading/adoptionBoundary.ts` | `adoptionExportBoundary` (section 15) |
| `lib/commcare/hq/sourceIdentity.ts` | `sourceIdentity`, `SourceIdentity`, `FormIdentity`, `AnswerLeaf`, `ContainerIdentity`, `ControlAsWritten`, `CoreTypeClass`, `coreTypeClass`, `CORE_BIND_TYPE_CLASSES` (section 6) |
| `lib/commcare/hq/hqQuestionTypes.ts` | `HQ_TYPE_ROWS`, `HQ_TYPE_ROW_DOMAIN`, `exactHqTypeRow`, `HQ_TYPE_OF_KIND` (section 7) |
| `lib/commcare/reader/canon.ts` | `CANONICALIZATIONS`, `Canonicalization`, `canonDocument` (section 9) |
| `lib/commcare/emissionRewrites.ts` | B6's file; B7 adds fifteen entries and the fields `sites`, `what`, `withholdable`, `declaredBy` (section 10) |
| `lib/commcare/appStrings.ts` | `localAppStringTable` (section 15) |
| `lib/commcare/compiler.ts` | today's file; B7 adds `compileCczParts`, `CompilePartsOptions` and `CczParts` (section 15.1) |
| `lib/commcare/xform/generatedNodes.ts` | today's file; B7 adds `generatedNodePaths` (section 6.3) |
| `lib/publish/emissionRewriteIds.ts` | B6's file; B7 appends its ids |
| `lib/publish/firstPublishChangeIds.ts` | `FIRST_PUBLISH_CHANGE_IDS`, `FirstPublishChangeId`, `FirstPublishView`, `firstPublishViewSchema`, `StoredFirstPublish`, `storedFirstPublishSchema`, `firstPublishViewFromStored`, `FIRST_PUBLISH_TOUCHES_WORKERS` (sections 11.1, 12.3) |
| `lib/publish/firstPublishCopy.ts` | B6's file; B7 replaces its `REWRITE_SENTENCES` with `FIRST_PUBLISH_SENTENCES`, and adds the heading, the leads, the labels, the reassurance, the note, `FirstPublishLine`, `FirstPublishLines` and `firstPublishLines` (section 12.2, Copy) |
| `lib/deployment/store.ts`, `types.ts`, `adoption.ts`, `resources.ts`, `actions.ts` | B8's and today's files; B7 adds the stored list's writer clause, `readFirstPublishStates`, `firstPublishOf` and `DeploymentView.firstPublish` (section 12.3) |
| `biome.json` | `lib/export/boundaryFindings.ts` joins the allowed consumers of `lib/commcare` (section 4), and the first sentence of the rule's four messages stops calling the package a one-way emission boundary ("Contracts") |
| `proof/first-publish-changes.json` | part 14's file, begun in A1 under this register's ids; B7 completes it with every entry's `source` rows and deletes `proof/checks/changes.py::CANDIDATE_IDS` (section 13.1) |
| `proof/ci/__tests__/firstPublishChanges.test.ts` | the lane file's one Vitest, new in B7 (section 13.3) |

`lib/deployment/reading/` is an allowed consumer of `lib/commcare` (`biome.json`'s rule leaves out
`lib/deployment/**` today); the reader itself is imported from `@/lib/commcare/reader` as part 06
(06-the-reader-forms.md), section 2.4, admits.
`lib/commcare/hq/sourceIdentity.ts` and `hqQuestionTypes.ts` import nothing under `lib/commcare/reader`:
a test holds it (`sourceIdentity.independence.test.ts`, Tests), because check 4 is evidence only while
it shares no classification with the reader.

### 2.2 Types

```ts
// lib/deployment/reading/acceptance.ts
import "server-only";

export const ACCEPTANCE_CHECKS =
	["accounting", "gate", "fixed-point", "identity", "summary"] as const;
export type AcceptanceCheck = (typeof ACCEPTANCE_CHECKS)[number];

/** The validator codes that read a file's own facts, which a `pending` call cannot judge (2.4). */
export const MEDIA_FACT_CODES = [
	"MEDIA_ASSET_NOT_FOUND", "MEDIA_ASSET_NOT_READY", "MEDIA_KIND_MISMATCH",
	"MEDIA_FORMAT_NOT_PLAYED",
] as const satisfies readonly ValidationErrorCode[];

// `HandOffSettlement` is part 11's (B9), in `lib/deployment/reading/projectData/settlements.ts`,
// beside the function that builds the list. Its shape is fixed here because check 1 reads it:
//   { artifact: string; where: string; key: string; by: "inert-claim" | "finding" }
// `inert-claim`: `HqMediaPlan.claims` holds the hand-off. `finding`: a finding of part 11's names it.

export interface AcceptReadingInput {
	/** The reading's id, which becomes the app's id. */
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
		"target" | "lookup" | "organization" | "media" | "appStrings" | "recordDialect">;
	/**
	 * The declarations to judge and to offer. Under `pending` the draft's own
	 * (`outcome.draft.declaration`). Under `files`, part 11's
	 * `narrowDeclarationsByMedia(outcome.draft.declaration, playsOn)`: the draft's less each choice
	 * that declares a platform a held file does not play on, the proposal moved as that function
	 * moves it. The caller ends the reading itself where none is left.
	 */
	readonly choices: Extract<DeclarationChoices, { readonly kind: "choices" }>;
	readonly settlements: readonly HandOffSettlement[];
	/**
	 * The tables the document reads, as the birth will hold them: part 11's
	 * `readingLookupSnapshot`. Its `definitions` are the bound tables under the reading's ids, its
	 * `rowsByTable` their rows in order, its `projectId` and `projectRevision` the Project's as
	 * part 11's step read them. Empty where the document reads no table.
	 */
	readonly lookup: LookupFixtureDataSnapshot;
	/** Part 11's plan facts the register reads (section 11.1). */
	readonly mediaLeftOut: number;
	/**
	 * `pending`: some file has no verdict yet. `files`: every referenced file is held; `rows` is
	 * the map `exportReadinessFindings` takes as its third argument, which part 11's
	 * `projectData/media.ts::readingMediaRows(plan)` gives.
	 */
	readonly media:
		| "pending"
		| { readonly files: readonly AdoptedMediaFile[];
		    readonly rows: Parameters<typeof exportReadinessFindings>[2] };
	/** The declaration the person chose. Absent in a read step; present at creation. */
	readonly chosen?: { readonly runsOnlyOn: Platform | null;
	                    readonly splitDatetime: boolean };
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

`FirstPublishView` is `{ readonly ids: readonly FirstPublishChangeId[]; readonly touchesWorkers: boolean
}` (`lib/publish/firstPublishChangeIds.ts`), ids in registry order.

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
| `accounting`, a census that disagrees, a hand-off settled twice, or a settlement no hand-off matches (section 3, steps 2 to 4) | one `read-back-differs` at the place section 3 gives the difference, `detail.name` `accounting`: each contradicts the reader's or part 11's own contract, so it is Nova's defect and never a fact of the app |
| `gate`, `fixed-point`, `identity`, `summary` | one `read-back-differs` at each differing place, `detail.name` the check |

Section 14 gives the finding's shape, the signature and the words.

### 2.4 Modes

- **`media: "pending"`.** Every check runs, over the draft's own choices. Check 2 drops the findings
  whose code is one of `MEDIA_FACT_CODES`: `MEDIA_ASSET_NOT_FOUND`, `MEDIA_ASSET_NOT_READY`,
  `MEDIA_KIND_MISMATCH` and `MEDIA_FORMAT_NOT_PLAYED`, the four that read a file's own facts. A test
  holds the list equal to `lib/commcare/validator/errors.ts::MEDIA_VALIDATION_CODES` less
  `CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE`, which reads the document alone, so a fifth file code fails by
  name.
- **`media: { files, rows }`.** Check 2 runs whole, with `rows` as the media manifest, over the choices
  the files left (`input.choices`), and the register reads `assignMediaPaths(files)` (part 10, section
  4.2) for its media entries (section 12.1). A `MEDIA_FORMAT_NOT_PLAYED` here is a difference like any
  other: the validator holds a file's format to each declared platform
  (`validator/rules/media/mediaFormatPlays.ts::mediaFormatPlays`), part 11's `playsOn` holds the same
  fact, and a choice the narrowing kept and the validator refuses means the two disagree.
- **What neither mode judges.** The export's media budget (`MEDIA_EXPORT_TOO_LARGE`) is no finding of
  `exportReadinessFindings`: `lib/export/boundaryValidation.ts` adds it from the files' rows. Part 11
  holds it as its own finding over the same limits (`mediaBudgetFinding`, its section 4.3), before
  acceptance is called whole.
- **`chosen`.** Absent, checks 3 to 5 judge D. Present with `splitDatetime` true, check 3 judges the
  split document in D's place; present without it, check 3 judges D, which is that choice's document
  less the declaration the reader never writes (section 5.4). Checks 4 and 5 judge D in every call,
  since a declaration changes no identity of CommCare HQ's source.

### 2.5 Purity and cost

`acceptReading` reads its argument and module constants. It calls `readHqApp` once (section 5), with a
fresh `mintingResolver(appId)`, or a `matchingResolver` where section 5.4 says so. Two calls with equal
input give deeply equal output, which `acceptance.purity.test.ts` holds. It never throws for content: a
projection or a gate rule that throws over the document is a difference of the check that called it,
with the function's name in the signature (`gate/threw/planFormCaseWire`).

It asks the reader for claim counts only (`ReaderOptions.claims` at its default): what check 4 needs of
the claim log reaches it as a fact of the reading (`ReadFormFacts.inertAppearances`, section 6.3), so
no step of a reading holds every claim in memory.

Its work, for part 12's `HQ_READING_CHECK_BUDGET_MS`: per declaration it is handed (at most three: part
06's section 16.3 drops a split candidate whose unsplit twin runs), one gate, one export readiness
evaluation, one carrier findings pass and one generated-node plan per form; then one `expandDoc` (two
at a creation that chose the split, where check 3 emits the split document and check 4 still emits
D), one reader run (which calls `appStrings`, a compile, as the reading's own run did), two
`sourceIdentity` extractions, two `publishedCaseBlocks` passes and one walk of the summary. Part 06's
run R2 gives one reader run twenty seconds at Nova's ceiling, which leaves forty for all of this
beside the reading's own run. Nothing here shows it fits; run K4 measures it, and names what changes
where it does not.

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
2. **The census agrees.** `outcome.census.byStanding` holds zero for `not-yet`, `never`, `fix-in-hq` and
   `stop`, and `outcome.census.manifestRevision` equals `surfaceStandingsRevision()`. Otherwise:
   signature `accounting/census`, place the app.
3. **Every hand-off is settled exactly once.** For each `HandOffRecord` of
   `outcome.claims.handOffs`, exactly one `HandOffSettlement` of `input.settlements` has its `artifact`,
   `where` and `key`. None: an `unrecognized` finding (part 06, section 4.3), signature
   `accounting/hand-off-unsettled/<to>`, where `<to>` is the record's `HandOffKind`. Two or more:
   signature `accounting/hand-off-settled-twice/<to>`. The place is the `place` of the `PendingMedia` or
   `UnreadTable` of `outcome.draft.facts` whose path or tag is the record's `subject`, and the app where
   none is.
4. **No settlement without a hand-off.** A settlement no record matches is signature
   `accounting/settlement-unmatched`, place the app: part 11 judged a use the reader never handed it.

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
2. `exportReadinessFindings(verdict.nextDoc, lookupContext, rows)`, `rows` being `input.media.rows`, or
   an empty map under `pending` with the four `MEDIA_FACT_CODES` findings dropped. Each remaining finding
   is a difference: signature `gate/export/<code>`.
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
`AcceptedReading.declarations` with nothing filtered a second time (part 12, section 5.1). Under
`pending` no file has a verdict, nothing is narrowed, and the read step that follows the media step
judges the narrowed list whole.

**`exportCarrierFindings`**, the row and mode rules of a publish. `exportReadinessFindings` is the
document's verdict; a publish adds three verdicts that need a mode, and `prepareWithRegistry` computes
them between its lookup read and its media read. B7 moves that computation, bodies unchanged, into a
pure module with no reader of rows and no database import, so the worker can load it:

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
`biome.json`'s allowed consumers of that boundary, so B7 edits `biome.json` beside the move. In both
overrides that list `"!lib/export/boundaryValidation.ts"`, `includes` gains
`"!lib/export/boundaryFindings.ts"` before it, and each of the four message strings that name the
allowed consumers gains "lib/export/boundaryFindings, " before "lib/export/boundaryValidation". The
same edit rewrites the first sentence of each of the four, "lib/commcare is the one-way CommCare
emission boundary.", to "lib/commcare is the CommCare boundary, the one package that speaks
CommCare's wire vocabulary.", because the package reads as well as writes from B2 and no earlier pull
request touches these strings ("Contracts").

What each rule means when it reaches check 2:

| Rule | On a correct reading | So a finding here is |
|---|---|---|
| `LOCATION_OWNER_EXPORT_NOT_ACTIVE` (`organizationExportFindings`) | never: no reading yields a `fixed-location` owner (part 11, section 11.4) | the reader's defect |
| `HQ_NESTED_SELECTION_UNREPRESENTABLE` (`hqNestedSelectionFindings`) | never: the two shapes are ones CommCare HQ's own build cannot carry, so no source holds them | the reader's defect |
| `LOOKUP_SELECT_SOURCE_VALUE_BLANK`, `_VALUE_WHITESPACE`, `_VALUE_DUPLICATE`, `_LABEL_BLANK`, `_EMPTY` (`lookupSelectSourceRowFindings`) | never reaches here: it is a fact of a table's rows, and part 11 raises it first as its own finding, `table-choices-unusable`, over the same snapshot (part 11, sections 13.2 and 14.1, B9) | a rule part 11 missed |
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
	/** The held files, where every file has a verdict; absent under `pending`. */
	readonly files?: readonly AdoptedMediaFile[];
}): HqApplication;

/** One resolved asset per asset id of the draft's media references (the `assets` row below). */
export function emissionAssets(
	references: readonly ReadMediaReference[],
	files: readonly AdoptedMediaFile[] | undefined,
): AssetManifest;
```

`readingEmission` is `expandDoc(doc, options)` with the four options part 07
(07-the-reader-cases-menus-lists.md), section 2.4, fixes for every re-emission of a reading, built here
from the draft so that acceptance needs no reader context, and with the other two left out:

| Option | Value |
|---|---|
| `identity` | `targetWireIdentity(overrides)` (`lib/commcare/wireIdentity.ts`): one `WireIdentityOverride` per entry of `draft.identities.modules` (`{ entityKind: "module", novaEntityUuid: uuid, uniqueId, xmlns: null }`, the type requiring `xmlns` on every override), and one per entry of `draft.identities.forms` (`{ entityKind: "form", novaEntityUuid: uuid, uniqueId: <the source form's readUniqueId, found by xmlns>, xmlns }`) |
| `attachmentTarget` | `input.reader.target` |
| `lookupNaming` | `lib/commcare/lookup/naming.ts::lookupWireNaming(input.lookupDefinitions)`, which takes `LookupTableDefinition`s; absent where the list is empty, as `prepareWithRegistry` leaves it absent for a document that reads no table |
| `assets` | `emissionAssets(draft.facts.mediaReferences, input.files)`, below |
| `runtimeTarget` | absent: the neutral template, as the HQ JSON path always prints |
| `rewrites` | absent: every rewrite applied, as a publish prints |

The source's own form ids are a read's (`hq/appSource.ts`: "a key into this read only"), and every
reference inside one source names forms by them, which is why the form override takes `readUniqueId`
and not the real id of the application resource. Part 07's `readProjectionInputs(ctx)` builds the same
four from the reader's context; `emission.parity.test.ts` holds the two equal over every retained read,
so part 07's re-emission comparisons (its rule (R2), no kin of part 06's scale run R2) and acceptance's
cannot differ on an id, an address, a name or a path.

**`emissionAssets`.** With media on, an asset id a reference names and the map lacks is a thrown
compiler error (`multimedia/assetWirePath.ts::AssetManifest`), so the map holds every asset id of
`draft.facts.mediaReferences`, as one `ResolvedMediaAsset` each:

| Member | Value |
|---|---|
| `assetId` | the reference's `assetId` |
| `wirePath` | a path the source spells for that asset (`ReadMediaReference.path`), less `jr://file/`; where its references spell several, the first in code-unit order, which is the one `assignMediaPaths` keeps (part 10, section 4.2, step 5) |
| `kind` | the reference's `mediaKind` |
| `contentHash`, `extension` | the file's own (`AdoptedMediaFile`) where `files` holds it. Under `pending`: sixty-four zeros, and the path's own extension in lower case |
| `mimeType` | `application/octet-stream` |
| `bytes` | absent: nothing here bundles a file |

`expandDoc` prints `wirePath` and reads no other member of an asset: the hash, the extension and the
type are read by the archive's media suite (`multimedia/mediaSuiteXml.ts`) and the export archive's
logo (`multimedia/hqJsonExportArchive.ts`), neither of which a check builds. `emission.assets.test.ts`
holds that, so a placeholder can never reach a byte a check compares: over the media corpus,
`expandDoc`'s output is byte-equal under the files' own facts and under the `pending` placeholders.

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
| `cloudcareEnabled` | the emission's `cloudcare_enabled === true` |
| `langs`, `translations`, `profile` | the emission's `langs`, `translations` and `profile`, which `hqShells.ts::applicationShell` always writes |
| `addOns` | the emission's `add_ons`, `{}` where it writes none |
| `name` | the emission's `name` |
| `lastModified` | null |
| `modules` | one per menu of the emission: `uniqueId`, `docType` and `caseType` read from it; each form's `docType` and `xmlns` read from it, its `readUniqueId` its `unique_id`, `shadowParentReadId` null, `attachment` `_attachments["<unique_id>.xml"]` |

`alignedFromEmission(emission): readonly HqAlignedModule[]` gives one `aligned` menu per menu, each
form `{ uniqueId: <its unique_id>, xmlns, source: <the form above>, questions: [] }`.

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
});
```

The resolver is fresh: every identity is UUIDv5 over the app's id and a per-kind external key (part 10,
section 2), the emission holds the source's menu ids and `xmlns`, and a question's key is its authored
path, so the re-read mints the uuids the reading minted with no map handed across. The reader's two
runs for worker and place properties (part 11, section 11.5) are the reader's own and happen inside the
call, as in the reading.

### 5.3 The equality

```ts
// lib/deployment/reading/fixedPoint.ts
export function fixedPointDifferences(
	/** The document the re-read must give (5.4). */
	expected: BlueprintDoc,
	/** The re-read's answer (5.2). */
	again: ReadOutcome,
	reading: {
		/** The reading: its hand-offs, identities and declaration are the other side of steps 2, 4, 5. */
		readonly outcome: Extract<ReadOutcome, { readonly kind: "read" }>;
		/** False at a creation that chose the split, where step 5 is not run (5.4). */
		readonly declarations: boolean;
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
   `signature.ts::documentDifferences(expected, again.draft.doc)` walks the two documents together
   and returns every differing path (section 14.2); the first twenty become differences, each at the
   place of the entity the path lies in.
4. **The identities.** `again.draft.identities.modules` and `.forms` equal the reading's as sets of
   `(uuid, uniqueId)` and `(uuid, xmlns)`, the form's `uniqueId` aside (it is a read's own). Otherwise
   `fixed-point/identities/menu` or `/form`.
5. **The declarations.** `again.draft.declaration.choices`, each as `(runsOnlyOn, split)`, equal the
   reading's own in order (`outcome.draft.declaration`, never the narrowed `input.choices`: the reader
   judges no file). Which choice is proposed, `narrowedByHq` and `keepsWebApps` are not compared: part
   06 derives all three from CommCare HQ's Web App setting (its section 16.3, step 4), and the
   emission of a document with no declaration writes `cloudcare_enabled` on whatever the source held.
   Otherwise `fixed-point/declaration`.

**No canonicalization.** `expected` is the reader's own output, so it is in the reader's image, and
every pair of section 9 has the reader's choice on the `expected` side already. Applying `canonDocument`
here would forgive exactly the defect the check exists for: a reader that returns one member of a pair
for CommCare HQ's bytes and the other for Nova's. A test holds that `acceptReading` never imports
`reader/canon.ts`.

**What is equal, said plainly.** Canonical JSON equality is deep equality of the two normalized
documents with object keys in sorted order: every entity map by uuid, every order array in order, every
expression tree node for node, every prose part, every translation entry with its fingerprint. Two
documents that differ only in the insertion order of an entity map are equal; nothing else is.

### 5.4 Which document

| Call | `expected` | Resolver of the re-read |
|---|---|---|
| a read step (`chosen` absent) | `outcome.draft.doc` | `mintingResolver(appId)` |
| creation, the chosen declaration without the split | `outcome.draft.doc` | `mintingResolver(appId)` |
| creation, the chosen declaration with the split | the document under the choice's mutations, with `appSettings.runsOnlyOn` removed | `matchingResolver(input.appId, externalIdentityMap(expected, identity))`, `identity` the `targetWireIdentity(overrides)` of 5.1 (part 10, sections 2.3 and 2.5, B8), so the questions the split made keep their uuids |

`appSettings.runsOnlyOn` is removed from `expected` because the reader never writes it: part 06's
assembly returns no declaration in the document and offers the choices beside it (its section 16.1), and
the emission's `cloudcare_enabled` reads back into the choices, not the document. In the third row
5.3's step 5 is not run: the split document holds no date and time question, so the choices it reads
back to are another document's, and there is nothing of the reading's to hold them to.

The split's document is checked only when the person chose it, and then in D's place, so each call makes
one re-read. A split the person did not choose is never born, and one they chose is checked before
anything is written. What this leaves unheld at the review: that an offered split reads back, for an
app whose split is offered and not yet chosen. `datetimeSplitReadBack.test.ts` (Tests) holds it over
every corpus document that has a date and time question, and proof 6 over the Nova-born documents step
4's split made. A failure at creation is `read-back-differs` and nothing is created.

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
 * What the source spells at one control. Check 4 never compares it: two spellings of one identity
 * differ here by design (`xsd:int` and `xsd:integer`, an inline label and an itext one). Check 5
 * reads it, to ask HQ's own type lookup the question HQ asked and to know which labels HQ
 * summarized (sections 7.3 and 7.4).
 */
export interface ControlAsWritten {
	/** The control element's local name: `input`, `select1`, `select`, `upload`, `trigger`,
	 *  `secret`, `group` or `repeat`. */
	readonly tag: string;
	/** The bind's `type` attribute exactly as written; null where there is no bind or no `type`. */
	readonly bindType: string | null;
	readonly mediatype: string | null;
	/** The `appearance` attribute exactly as written, an inert one included. */
	readonly appearance: string | null;
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
namespace helpers of `lib/commcare/xmlNamespaces.ts` (B2, part 06 section 2.1). It parses
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
5. **As written.** For every container and leaf control of step 3, `written` holds at its path the
   element's local name, its bind's `type` attribute untouched, its `mediatype` and `appearance`
   untouched, whether its `<label>` child holds a `ref`, and that for each inline `<item>`. The
   extraction reads no label's text and resolves no itext id.

A form whose `xmlns` is absent or blank is `no-xmlns`; two forms of one `xmlns` are `shared-xmlns` and
neither is read; a form with no attachment is `no-xform`; one whose XML does not parse or breaks step 1
or 3 is `xform-unparsed`.

### 6.3 The comparison

```ts
// lib/deployment/reading/identityAgreement.ts
export function identityDifferences(input: {
	readonly source: HqAppSource;
	/** `readingEmission` over `outcome.draft.doc`, with no `chosen` (5.1). */
	readonly emission: HqApplication;
	/** The reading's draft: its document, its facts and its identities. */
	readonly draft: ReadDraft;
}): {
	readonly differences: readonly AcceptanceDifference[];
	/** `sourceIdentity` of the source, which check 5 reads `written` from (7.3, 7.4). */
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

- `field-list` in any letter case equals `field-list`, which part 14 proves as a spelling rule (part
  06, section 10.2, reads the other cases and Nova writes the one).
- **An appearance the reader accounted as inert is cut from A.** Part 06's `classifyAppearance` drops an
  appearance no runtime reads on its control (its section 9.2: rule 4 and each row of `APPEARANCE_ROWS`
  whose entry is INERT, among them
  `questions/any-other-value-read-by-no-runtime-not-an-intent-value-on-an`), and Nova then writes none.
  Before rows 5 and 6 compare, the leaf or container of `A` at each path of
  `outcome.draft.facts.forms[i].inertAppearances` (part 06, section 17.3: the data path of every control
  whose `appearance` the reader accounted under an entry of standing `inert`) takes `appearance: null`.
  Two things bound the cut. It applies only where `E` holds no appearance at that path: an inert claim
  beside an appearance Nova still writes is `identity/appearance/inert-kept`. And a path of the list that
  is no leaf and no container of `A` is `identity/appearance/phantom`.

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
lacks fails check 4 with that signature, and never reaches the register. The register holds the same
rule from its side (section 11.3): no entry declares a guard, and a generated difference that adds or
drops one after row 8 passed is `identity/generated/guard`.

### 6.4 Case blocks, and forms left out

Part 07 (B4), section 6.1, extends `publishedCaseBlocks` to return `PublishedCaseBlocks { forms,
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
| `shadow-form` | `forms-and-case-writes/shadowform` (part 06, B2, its section 7.1) |
| `unknown-form-kind` | `unrecognized` at the form (part 06, section 7.1) |
| `no-xform`, `xform-unparsed` | part 06's `form-source` findings (B3, its section 8.2) |
| `actions-malformed` | `unrecognized` at the form (part 07, section 3) |
| `visit-schedule`, `registry-load` | the manifest's REFUSED rows for a visit schedule and a data registry load, which part 07 raises (B4) |

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
examples and, for the three classes the lane reads, by part 14's parity; a claim that is wrong there
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
| `repeat` | for a control, the path of the innermost enclosing `<repeat>`, or null; a repeat's own row holds the repeat outside it. For a node with no control (the second loop of `get_questions`), the longest path `r` with `r + "/"` a prefix of the node's path among: the `repeat` of every control row, and the path of every row typed `Repeat` |
| `group` | for a control, the path of the innermost enclosing `<group ref>` or `<repeat>`, or null; a `<group>` whose direct child is a `<repeat>` gets no row and passes the context through. For a node with no control, the longest path `g` with `g + "/"` a prefix of the node's path among: the `group` of every control row, the path of every row typed `Group`, and the path of every row typed `Repeat`. A group HQ types `FieldList` is in that set only as some control's `group`, so a Hidden Value in a section or a question list that holds no control takes the group outside it, or null |
| `type` | `_infer_vellum_type(control, bind)`: a lookup in `VELLUM_TYPE_INDEX` over tag, bind type, `mediatype` and `appearance`, falling back at each field to the rows that name no value for it; `DataBindOnly` for a node with no control; null where the lookup ends at none or several rows |
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
	readonly repeat: string | null;
	readonly group: string | null;
	/** HQ's type name for the field as Nova holds it (7.4). */
	readonly type: string;
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
- a repeat workers add entries to, a count-bound repeat and a model-iteration query repeat: one row of
  type `Repeat` at the row path (`repeatRowPath`), since HQ gives the wrapper `<group>` no row;
- a query repeat in the count placement: a row of type `Group` at the wrapper's path and a row of type
  `Repeat` at the row path, which is what HQ makes of the wrapper group that has a `ref`
  (`lib/commcare/CLAUDE.md`, "Repeat modes").

`repeat` and `group` follow HQ's two rules in 7.1, in HQ's two passes. First every field with a
control (every kind but `hidden`) takes the row path and the group path of its nearest ancestors.
Then each Hidden Value takes the longest prefix among the first pass's rows, exactly as 7.1's rows
for a node with no control say: its `group` from the `group` of every first-pass row and the paths
of the rows typed `Group` and `Repeat`, its `repeat` from the `repeat` of every first-pass row and
the paths of the rows typed `Repeat`. So a Hidden Value in a section that holds only Hidden Values
has the group outside the section, or null, on both sides.

`alwaysRequired` is true where the field's `required` is the constant true, or the field is in
`caseCreateNameFields(doc, formUuid)` and is no Hidden Value (the stamp). `hasRelevant` is whether
the `relevant` slot holds an expression. `hasConstraint` is whether `validate` holds an expression,
and nothing else: the check Nova conjoins for a case name or an external id
(`lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`) is Nova's own rewrite (`case-text-guard`,
section 10.2), which a source made in CommCare HQ never holds, and 7.5 says how the comparison treats
a source that does hold it. `hasCalculate` is whether a Hidden Value's `calculate` holds one.

### 7.3 Text

A label per language is `commCareLocalization(doc).prose(language, unitId)` for the field's label unit
under `lib/domain/translationFill.ts::filledProse`, the projection every export reads, passed through
`builder.ts::buildLabelNodes` with a stub in place of the expression printer: each text node is its
text, each `<output>` it builds is `____`. Using the emitter's own node builder puts a hole exactly
where Nova writes an output (a reference, a calculated value, a protected whitespace run, part 03's
bracket output), which is where part 06 read one (its section 12.3 confirms each literal output by
that same print). B7 exports `buildLabelNodes` from `builder.ts`, body unchanged.

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
and is skipped, exactly as a type is on an inexact row.

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
blank is the register's question (section 11.2, row 28), and a label CommCare HQ never translated is
a correct reading whether or not any blank was counted.

### 7.4 Types, on an exact row only

```ts
// lib/commcare/hq/hqQuestionTypes.ts
/** `xform.py::VELLUM_TYPES`, the four indexed fields of each row. */
export const HQ_TYPE_ROWS: Readonly<Record<string, {
	readonly tag?: string;
	readonly type?: readonly (string | null)[];
	readonly media?: string;
	readonly appearance?: string;
}>>;
/**
 * HQ's type for a control and its bind, or null where HQ's lookup would not match a row exactly.
 * A port of `_index_on_fields` and `_infer_vellum_type`.
 */
export function exactHqTypeRow(control: {
	readonly tag: string;
	readonly bindType: string | null;
	readonly mediatype: string | null;
	readonly appearance: string | null;
}): string | null;
/** HQ's type name for a Nova field. */
export const HQ_TYPE_OF_KIND: (field: Field) => string;
/**
 * The vectors run K2 asks CommCare HQ: for each indexed field, every value some row of
 * `HQ_TYPE_ROWS` names, the absent value (null), and one value no row names. K2 asks their
 * whole product.
 */
export const HQ_TYPE_ROW_DOMAIN: {
	readonly tags: readonly string[];
	readonly bindTypes: readonly (string | null)[];
	readonly mediatypes: readonly (string | null)[];
	readonly appearances: readonly (string | null)[];
};
```

`exactHqTypeRow` walks the index as HQ does, field by field in the order tag, type, media, appearance:
where the control's value is one a row of the remaining set names, it keeps those rows; otherwise it
keeps the rows that name no value for the field (a `None` inside a row's tuple counts as naming none).
It answers the one remaining row's name, and it answers null where:

- the remaining set is empty or holds several rows (HQ logs and reports null);
- the control has a **tag, a bind type or a media type that no remaining row named**, so the walk fell
  back on it. An `<input>` bound `xsd:decimal` falls through to `Text` in HQ; that is HQ's guess, and
  no evidence.

A fall-back on `appearance` alone is exact: HQ's own comment gives `<group appearance="poodles">` as a
`Group` by design, and an appearance is no type.

`HQ_TYPE_OF_KIND`, total over `lib/domain/fields/index.ts::fieldKinds`:

| Nova field | HQ's type |
|---|---|
| `text` | `Text`; `PhoneNumber` where `keypad` is `numbers` (part 03, A6) |
| `int` | `Int` |
| `decimal` | `Double` |
| `date`, `time`, `datetime` | `Date`, `Time`, `DateTime` |
| `single_select`, `multi_select` | `Select`, `MSelect` |
| `geopoint`, `barcode`, `secret` | `Geopoint`, `Barcode`, `Secret` |
| `image`, `signature` | `Image` |
| `audio`, `video`, `file` | `Audio`, `Video`, `Document` |
| `label` | `Trigger` |
| `hidden` | `DataBindOnly` |
| `group` | `FieldList` where `fieldList` is true, else `Group` |
| `section` | `FieldList` |
| `repeat` | `Repeat` |

For a row of the summary, the type is compared only where `exactHqTypeRow` of the source's own control
and bind answers the type HQ sent. Its argument is `sourceIdentity(source).forms.get(xmlns).written`
at the row's path, member for member (`tag`, `bindType`, `mediatype`, `appearance`): the bind's type
and the appearance exactly as the source spells them, which is what HQ's lookup was given, and never
the type class or the appearance check 4 compares after its cut. Where it answers null or another
name, the row's type is no evidence and is skipped. Run K2 holds the port to HQ.

### 7.5 The comparison

```ts
// lib/deployment/reading/summaryAgreement.ts
export function summaryDifferences(input: {
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	readonly draft: ReadDraft;
	/** Check 4's `sourceIdentity` of the source, read here for `written` alone (7.3, 7.4). */
	readonly sourceIdentity: SourceIdentity;
}): readonly AcceptanceDifference[];
```

It runs per form of each `aligned` menu, joining `HqAlignedForm` to the document's form by `xmlns`
through `draft.identities.forms`.

**Ids.** The aligned form's `xmlns` equals the identity's, and `adoptedIdentityRows(read, modules)`
(part 10, section 3.1) answers `ok`, `read` being `draft.identities` less each menu whose aligned
module is `not-summarized` and that menu's forms (7.6): every other menu and form the document holds
has the real id CommCare HQ's application resource gave. Otherwise `summary/ids/menu` or
`summary/ids/form`.

**Rows.** CommCare HQ's rows and `documentSummary`'s are joined by `path`.

| Case | Verdict |
|---|---|
| a row on both sides | each member below must agree |
| HQ's row alone, and its path is, or lies under, a path of `GA` (section 6.3), a case region or Save to Case block of the form (`ReadFormFacts.caseRegionPaths`, part 06, section 17.3), or a Connect block of the document (`/data/<id>` for each of `formConnectIds`), or it holds `/@` | explained: Nova's own node, a case block, or a block's attribute |
| HQ's row alone otherwise | `summary/row/unread/<HQ's type>` |
| the document's row alone | `summary/row/absent/<type>` |

| Member | Agreement | Signature |
|---|---|---|
| `repeat`, `group` | equal strings, or both null | `summary/question/repeat`, `/group` |
| `type` | equal, where 7.4 makes HQ's exact | `summary/question/type` |
| `required` | HQ's `true` implies `alwaysRequired`. HQ's `false` implies not `alwaysRequired`, unless the field is in `caseCreateNameFields` (HQ's build stamps it whatever the source said) | `summary/question/required` |
| `relevant` | HQ's is a non-empty string exactly where `hasRelevant`, skipped for a query repeat's rows, whose `relevant` is Nova's row guard | `summary/question/relevant` |
| `constraint` | `hasConstraint` implies HQ's is a non-empty string. HQ's non-empty with no `hasConstraint` is accepted only on a field in `caseScalarTextGuards(doc, formUuid)` whose kind `caseScalarTextGuardIsChecked`: a source Nova wrote holds the conjoined check alone there, and the reader folded it out. On any other field it is a validation the reader dropped | `summary/question/constraint` |
| `calculate` | on a `DataBindOnly` row, HQ's is a non-empty string exactly where `hasCalculate` | `summary/question/calculate` |
| `labelTranslations` | 7.3, in every language of the app, where the source's label holds a `ref` | `summary/question/label` |
| `options` | HQ's is null or empty exactly where the document's is null; else the same length, and position by position the same `value`, and labels that agree by 7.3 where that item's label holds a `ref` | `summary/question/options`, `summary/question/option/value`, `summary/question/option/label` |

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

### 7.6 A menu CommCare HQ could not summarize

`dehydrate_module` wraps a whole menu in `try` and returns `{'error': str(e)}` in its place, which part
05 types as `HqAlignedModule { kind: "not-summarized" }`. Check 5 skips every form of such a menu: there
is no summary to agree with. It raises nothing for it. Part 12 (12-the-reading-and-the-birth.md, section
3.3, step 4) has already added `menu-unreadable-in-hq` at the menu, or `app-unreadable-in-hq` for the
app, standing `fix-in-hq`, and made the reading an account, so no app with such a menu is created on
four checks. It is never `read-back-differs`: the fault is in the form, and CommCare HQ's form builder
shows it.

---

## 8. Which check catches what, and what holds the rest

One row per way a reader can be wrong. "No" means the check passes over the bug.

| A reader bug | 1 | 2 | 3 | 4 | 5 | What catches it |
|---|---|---|---|---|---|---|
| A key or node never claimed | yes | | | | | the cursor's close (part 06) |
| A value claimed held and never read into the document | yes | | | | | claim consumption, in the close |
| A value claimed, read, and stored in the wrong slot of the right entity | no | no | yes where Nova prints the two slots differently | no | presence only | check 3; a lane base that exhibits the key |
| A group level dropped | no | no | no | yes: leaf paths | yes: `group` | checks 4 and 5 |
| A repeat read as a group | no | no | no | yes: `repeats`, container kind | yes: `repeat`, type | checks 4 and 5 |
| A whole-number question read as a decimal | no | no | no | yes: type class | yes, on an exact row | checks 4 and 5 |
| A Text question read as a Phone Number, or the reverse | no | no | no | yes: `appearance` | yes: `PhoneNumber` is an exact row | checks 4 and 5 |
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
typed list, and `readBackDifferences` is the one read-back comparison (9.1), which run K1 here and
proof 6 in part 14 both make. Both are planned here because the acceptance tests and run K1 need
them beneath B13; part 14 (14-proof.md, section 5, B13) runs them in proof 6 and adds what its lane
runs find (Departure 9).

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

`canon.ts` imports part 06's `assemble.ts::READER_CANONICAL_CHOICES` (B2), each row of which is
`{ id, kind, apply }`, and part 08's `canonicalExpression` (B6), and wraps each as a row, so one id has
one definition. The reader module that makes a choice writes its row of `READER_CANONICAL_CHOICES`
in its own pull request: part 06 in B2, part 07 three in B4 and two in B5. Three rows are this
file's own, landing in B7: `blank-translation-is-absent`, `blank-optional-text-is-absent` and
`purpose-notes-are-absent`. No row parses or prints: each is a rewrite over the typed document.

| Id | Kind | The pair | The reader returns | Why both print the same bytes | Lands |
|---|---|---|---|---|---|
| `root-question-lists-are-sections` | one-wire | a root of sections; a root of `fieldList` groups with no condition, no label media and no worker-added repeat | sections | `builder.ts::buildContainer` writes `appearance="field-list"` for a section and for a group that holds `fieldList`, over the same `<group ref>` and optional label; a section has no `relevant`, media or hint by schema | B2 (part 06) |
| `translation-equal-to-source-is-absent` | one-wire | a translation equal to its source text; none | none | `localization.ts`'s projection gives a missing entry the current source | B2 (part 06) |
| `blank-translation-is-absent` | one-wire | in a document whose source language is its default (first) language: a translation of an itext role (`translationFill.ts::TRANSLATION_FILL_ROLES`) whose value is blank where its source is not; none | none | `lib/domain/translationFill.ts::filledProse` gives a blank value the default language's text, and a missing entry prints the source language's (`lib/domain/CLAUDE.md`, "Localization"). The two are one text only where the two languages are one, which every reading is (part 06, section 6.3). In a document whose source language is not its default the two print different texts (the default language's and the source language's), so they are no pair there and `apply` leaves such a document as it is | B7; read so by B3 (part 06, section 12.2) |
| `out-of-date-translation-is-absent` | one-wire | a translation whose `sourceFingerprint` is not the current source's; none | none | a stale entry falls back to the current source | B2 (part 06) |
| `translation-provenance-is-read-as-reviewed` | not-carried | a current translation with any `origin`, `review` and `translatedFrom` | human, reviewed, from the source language | provenance is in no export | B2 (part 06) |
| `plain-flag-on-blank-text-is-absent` | one-wire | `plainLabel` or `plainHelp` on a text blank in every language; no flag | no flag | `buildXFormSource`'s `addItext` registers no entry for a text blank everywhere, so no form of it is written | B2 (parts 03 and 06) |
| `plain-flag-under-plain-text-is-absent` | one-wire | `plainLabel` or `plainHelp` in a form that holds `plainText`; no flag | no flag | a form whose text formatting is off writes no markdown form for any text (part 03, A8) | B2 (parts 03 and 06) |
| `blank-container-label-is-absent` | one-wire | a group, repeat or section whose `label` has no parts; one with no `label` | no `label` | `addItext` answers `registered: false` for both, so neither writes a `<label>` | B2 (part 06) |
| `blank-optional-text-is-absent` | one-wire | a hint, a validation message, or a help text with no media, whose template is blank in every language; none | none | `addItext` answers `registered: false`, so `hasHint`, `hasHelp` and `hasValidationMessage` are false and no element or attribute is written | B7 |
| `create-name-required-is-absent` | one-wire | a `required` condition on a question in `caseCreateNameFields` that is no Hidden Value; none | none | `builder.ts::buildFieldParts` deletes `vellum:requiredCondition` and writes `required="true()"` there whatever the slot holds | B4 (part 07) |
| `default-post-submit-is-absent` | one-wire | a form with no destinations whose `postSubmit` equals `defaultPostSubmit` for its type and menu; no `postSubmit` | none | every consumer reads `lib/domain/postSubmit.ts::effectivePostSubmit`, which answers the same destination for both | B4 (part 07) |
| `dormant-tile-cells` | one-wire | tile cells on a list whose layout is not a tile; none | none | `lib/domain/modules.ts::tileCellFor` gives a cell only under a tile layout, and all four consumers call it | B5 (part 07); part 01 names it in A2 (its section 3.2) |
| `registration-form-last` | one-wire | a registration form a list offers after an empty search at any place in its menu; the same form last | last | part 07, section 8.7: the emission plan moves the form into its own hidden menu, so its place among the menu's forms reaches no wire | B4 (part 07) |
| `expression-print-collisions` | one-wire | every row of part 08's `PRINT_COLLISIONS` | the canonical tree | `printCollisions.test.ts` (part 08) | B6 (part 08) |
| `case-catalog-is-as-read` | one-wire | a document's `caseTypes` as authored; the catalog part 07 section 7 derives from the same document | the derived catalog | the emitter reads a property's type through `effectiveCaseTypes`, and section 7 declares a type exactly where a comparator or a search predicate reads one no writer gives; a label and an unread property reach no export | B5 (part 07) |
| `purpose-notes-are-absent` | not-carried | `Module.purpose` and `Form.purpose` (`lib/domain/modules.ts`, `lib/domain/forms.ts`) | absent | purpose notes are outside the wire inventory (`lib/commcare/CLAUDE.md`, "`APP_TEXT_UNREPRESENTABLE`") | B7 |

Sixteen rows. Part 07's run G1 adds none: under its outcome C the builder's shape of a Save to Case
block is refused, and a canonicalization rewrites to a member the reader returns, which a refused
block is not.

**The proof of each row** is one case of `lib/commcare/reader/__tests__/canon.test.ts`: it builds the
two documents of the pair from production builders, runs `expandDoc` over each under identical options
and, for an app that declares Android, `compileLocalArchive`, and requires every emitted file byte for
byte equal. A `not-carried` row is the same test with the content present and removed. So a
canonicalization can never hide a difference a runtime reads. The test also holds `canonDocument`
idempotent, and `canonDocument(read(A)) = read(A)` over every retained read: the reader's own answer
is already canonical.

**Two pairs that look like pairs and are not.** A leaf's blank label and an absent one: a leaf has
no absent label (`lib/domain/fields/base.ts`). The section and field-list pair is part 06's first row,
narrower than it first looks: a `fieldList` group with a condition, label media or a worker-added
repeat inside it is not a section and reads back as a group.

Run K1 holds the list complete over the fuzz corpora.

### 9.1 The one read-back comparison

Run K1 (B7) and proof 6 (B13) state one claim, so they make one comparison, and it lands in B7 beside
`signature.ts::documentDifferences`, which it calls:

```ts
// lib/deployment/reading/readBack.ts
/** One differing path between the document a read back must give and the one it gave. */
export type ReadBackDifference = DocumentDifference; // signature.ts, section 14.2

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

It is pure, imports no `reader/canon.ts` (a caller applies `canonDocument` to `expected` where its
claim has one, as K1 does and as proof 6 does for a Nova-born document), and is no part of
`acceptReading`: check 3 compares a reading with its own re-read exactly (section 5.3) and never
leaves a kind out. `lib/deployment/reading/__tests__/readBack.test.ts` holds each step, and part
14's `proof/reader/cli.ts` imports the function for proof 6, so `proof/reader/` holds no comparison
of its own (part 14, section 5.2).

---

## 10. `EMISSION_REWRITES` (B6 creates it; B7 completes it)

Part 08 (08-the-reader-expressions.md), section 2.3, creates `lib/commcare/emissionRewrites.ts` with the
eight rewrites the emitter makes to an expression, the id list `lib/publish/emissionRewriteIds.ts`, and
`RewriteControl { withhold, reached }` on the wire build context. B7 adds every other
behavior-changing rewrite site, and four fields to every entry.

### 10.1 The type, as B7 leaves it

```ts
// lib/commcare/emissionRewrites.ts
export interface EmissionRewrite {
	readonly behavior: "changes" | "none";
	readonly touchesWorkers: boolean;
	/** Every site that makes the rewrite, `path::symbol`. */
	readonly sites: readonly string[];
	/** What the rewrite changes, for a developer. */
	readonly what: string;
	/** Whether a print can leave it out (`RewriteControl.withhold`). */
	readonly withholdable: boolean;
	/**
	 * What accounts for it on an app made in CommCare HQ: the register entry that declares it, or
	 * the manifest entry whose refusal keeps such an app out. Every rewrite has one: a rewrite that
	 * changes no behavior still changes what CommCare HQ stores, which
	 * `forms-and-settings-rewritten` or a same-state entry declares.
	 */
	readonly declaredBy:
		| { readonly change: FirstPublishChangeId }
		| { readonly refusedBy: string };
}
```

`ExpandOptions` (`lib/commcare/expander.ts`) gains `rewrites?: RewriteControl`. `expandDoc` hands it to
`buildXFormSource` (`BuildXFormOptions.rewrites`), to `planFormCaseWire`
(`PlanFormCaseWireOptions.rewrites`) and to the wire build context B6 already threads. Absent, every
print is as today, so no production caller changes. Each site calls `rewrites?.reached?.(id)` at the
moment it makes the rewrite. `reached` says a site ran; whether that changes anything for one app is
the register's predicate (section 11).

### 10.2 The entries B7 adds

Every site was found by reading the emitter for a place where what Nova writes is not what the document
or a source would spell on its own.

| Id | Sites | What changes | `behavior` | Workers | Reached when | Withholdable | `declaredBy` |
|---|---|---|---|---|---|---|---|
| `case-name-required` | `xform/builder.ts::buildFieldParts` | `required="true()"` on the bind of a visible question that names a created case, in place of an authored condition | none: HQ's build writes the same attribute on the same bind (`xform.py::XFormCaseBlock.add_create_block`) | no | the stamp is written | no | `forms-and-settings-rewritten` |
| `case-text-guard` | `xform/builder.ts::buildFieldParts` (`scalarCheck`), over `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards` | a visible question's `constraint` gains the check: a case name not blank after the trim and at most 255 characters, an external id at most 255 | changes | yes | the check is written, alone or conjoined | no | `case-names-checked` |
| `case-text-trimmed` | `xform/builder.ts::buildFieldParts` (the `trimmed` sibling), `casePlacementPlan.ts::planFormCaseWire` (`questionPath`) | a case name and an external id are saved from a sibling that trims them | changes | yes | the sibling is written | no | `case-names-checked` |
| `update-case-always` | `casePlacementPlan.ts::planFormCaseWire` | `update_case.condition` is `always` on every form that opens or requires a case | none on every shape the reader holds (the manifest's three HELD `never` rows, `forms-and-case-writes/update-case-condition-never-on-a-registration-form`, `forms-and-case-writes/update-case-condition-never-on-a-follow-up-with-any-other-entry` and `forms-and-case-writes/update-case-condition-never-on-a-follow-up-in-a-multi-select-or`, and `forms-and-case-writes/update-case-condition-if-whose-question-exists`); the two shapes it would change are refused (`forms-and-case-writes/update-case-condition-never-on-a-follow-up-with-no-other-active` and `forms-and-case-writes/update-case-condition-if-whose-question-is-gone`) | no | the condition is set | no | `case-settings-respelled` |
| `external-id-in-update` | `casePlacementPlan.ts::planFormCaseWire` (`updateMap`) | a registration's external id is `update_case.update.external_id`, with `open_case.external_id` null | none: HQ's build writes the same `<update>` leaf for either (`xform.py::XForm._create_casexml`) | no | an own arm writes `external_id` | no | `case-settings-respelled` |
| `subcase-index-unnamed` | `casePlacementPlan.ts::planFormCaseWire` | a basic child's `reference_id` is `""` | none: HQ's build reads `subcase.reference_id or 'parent'` | no | a basic subcase is written | no | `case-settings-respelled` |
| `preload-as-default` | `xform/builder.ts::buildFieldParts` (the default's `setvalue`); `formActions.ts` writes no `case_preload` | a value loaded from the case is the question's default, at the question's place | none on every shape the reader holds: part 07's `laterLoadReaders` refuses a form where the move changes a value | no | a default that is `fieldPreload` is written | no | `case-settings-respelled` |
| `setvalues-in-data-order` | `xform/builder.ts::inDataTreeOrder` | load-time values are written in the order of their questions | none on every shape the reader holds: part 06 refuses two defaults whose order matters (`questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes`, its section 11.3) | no | the order it returns differs from the order it was given | no | `forms-and-settings-rewritten` |
| `location-list-project-default` | `hqShells.ts::applicationShell` | `location_fixture_restore` is `project_default` | none for anything the app reads (manifest rows `application-and-settings/50-hq-location-fixture-restore-project-default` and `application-and-settings/50p-hq-location-fixture-restore-both-fixtures-only-flat-fixture`) | no | every app | no | `location-list-setting-reset` |
| `connect-captures-location` | `expander.ts::appLevelValues`, `hqShells.ts::applicationShell` | `auto_gps_capture: true` for a CommCare Connect app | changes | yes | the key is written | no | `connect-app-captures-location` |
| `web-apps-setting-from-declaration` | `hqShells.ts::applicationShell` | `cloudcare_enabled` is the declaration | changes | yes | every app | no | `web-apps-turned-off`; `web-apps-turned-on` names the rewrite as its source (10.3) |
| `validation-count-lifted` | `xform/constraintCollections.ts::planConstraintCollections`, called from `buildFieldParts` | a count inside a validation moves to a sibling Hidden Value | changes | yes | the plan holds a calculation | yes: withheld, the plan returns the expression unchanged and no calculation | `validation-counts-moved` |
| `validation-message-composed` | `xform/constraintMessage.ts::protectConstraintMessage`, called from `buildXFormSource` | a validation message that shows an answer becomes the constraint-message expression with its carrier | changes | yes | a protected message is built | no | `validation-messages-composed` |
| `label-instance-text-protected` | `xform/builder.ts::literalLabelNodes` (part 03, A7) | label text holding an `instance('<id>')` call is split by a literal output | none: no runtime reads label text as a path | no | a split is written | no | `forms-and-settings-rewritten` |
| `date-and-time-saved-as-text` | `xform/builder.ts::buildFieldParts` (the `datetime` sibling), `xform/datetimeCaseValue.ts::datetimeCaseValueExpression` | a date and time answer reaches a case as its whole moment in text | changes: a source that binds the question straight to the property stores the day alone (`Recalculate.java::wrapData`) | yes | the sibling or the wrapper is written | no | `{ refusedBy: "forms-and-case-writes/a-datetime-question-saved-straight-to-a-case" }`, an entry of subject `writer-types` and standing `not-yet` from A2 (part 01, Appendix A.1), under which part 07 raises its finding (its section 3.2) |

`validation-count-lifted` is withholdable because part 08's second acceptance level prints with every
rewrite of the table withheld and compares that with CommCare HQ's text: a validation made in CommCare
HQ holds its count inline, and only a print that does not lift it can equal it. With the count read
inline and the rewrite reported, the first publish lifts it, and the entry says so.

B7 also fills `sites`, `what`, `withholdable` and `declaredBy` for B6's eight entries from part 08's
table (its section 2.3): each is withholdable but `search-value-guards` and `search-today-device-day`,
which part 08 compares as CSQL; each `changes` entry is declared by the register entry of its own id;
`default-reads-current` and `filter-identities-dropped` take `forms-and-settings-rewritten`.

**The sentences have one home.** B6 lands `lib/publish/firstPublishCopy.ts::REWRITE_SENTENCES`, a
`Record<EmissionRewriteId, string | null>` with a test that exactly the `changes` entries hold a sentence
(part 08, section 2.3). B7's fifteen ids would each need a row there, and seven of them change behavior:
six under a register entry of another id (`case-text-guard` under `case-names-checked`) and one under a
refusal, which has no sentence at all. So the record would hold a second copy of a register sentence, or
a null beside a `changes` entry. B7 deletes `REWRITE_SENTENCES` and that test. Part 08's seven sentences
(C1 to C6b; C5 lands only on E4's outcome B) move, unchanged, into `FIRST_PUBLISH_SENTENCES` under the
same ids, which are register ids already (section 11.2, rows 7 to 12, and the gated
`default-reads-current`). What part 08's test held is held by `declaredBy`: every `changes` rewrite names
a register entry, and every register entry has a sentence by its type (10.3). Nothing but B7 reads
`REWRITE_SENTENCES` (part 08 names B7's register as its one reader).

### 10.3 The two tests that close the registry

- **Every id is reached by some site, and only where its trigger stands.**
  `lib/commcare/__tests__/emissionRewrites.sites.test.ts` holds, for every member of
  `EMISSION_REWRITE_IDS`, one exhibit document and one control document (the exhibit without the one
  thing that triggers the rewrite), each built from production builders. `expandDoc(exhibit, { rewrites:
  { withhold: new Set(), reached } })` must report the id, and the same call over `control` must not. An
  id no site reports fails, and so does a site that reports where nothing triggered it. The exhibit list
  is a `Record<EmissionRewriteId, { readonly exhibit: () => BlueprintDoc; readonly control: () =>
  BlueprintDoc }>`, so an id with no exhibit fails `tsc`.
- **Every change is accounted for.** Every entry has a `declaredBy`, by its type.
  `emissionRewrites.test.ts` holds that a `change` it names is a member of
  `FIRST_PUBLISH_CHANGE_IDS`, whose entry's `behavior` is `changes` exactly where the rewrite's is;
  that a `refusedBy` it names is a manifest entry whose standing is `not-yet`, `never` or
  `fix-in-hq`; that `touchesWorkers` is false for every `none` entry; and that a withholdable
  entry's exhibit prints different bytes withheld.
  `web-apps-setting-from-declaration` names two register entries, so its `declaredBy` is
  `{ change: "web-apps-turned-off" }` and the test also requires `web-apps-turned-on` to name the
  rewrite as its source (11.1).

What no test can hold is the converse: a rewrite site nobody registered. That is held from outside the
emitter, by run K3: on every HQ-authored base, a difference no applying entry covers fails the base.

---

## 11. `FIRST_PUBLISH_CHANGES` (B7)

Nova writes its own spelling of every form. Spelling is free; behavior is not, which is the bar's
clause (b). The register is the closed list of what a first publish over an adopted app may change.

### 11.1 The type

```ts
// lib/publish/firstPublishChangeIds.ts  (client-safe; lib/publish may not import lib/commcare)
export const FIRST_PUBLISH_CHANGE_IDS = [ /* the 34 ids of 11.2, in its order */ ] as const;
export type FirstPublishChangeId = (typeof FIRST_PUBLISH_CHANGE_IDS)[number];
export interface FirstPublishView {
	readonly ids: readonly FirstPublishChangeId[];
	readonly touchesWorkers: boolean;
}
export const firstPublishViewSchema: z.ZodType<FirstPublishView>;
/** The register's `touchesWorkers` column as client-safe data (12.2). */
export const FIRST_PUBLISH_TOUCHES_WORKERS: Readonly<Record<FirstPublishChangeId, boolean>>;
/** What the read baseline keeps of a reviewed list (12.3). */
export interface StoredFirstPublish {
	/** The ids that applied under the chosen declaration, less the two Web Apps ids. */
	readonly ids: readonly FirstPublishChangeId[];
	/** CommCare HQ's Web App setting as the reading held it (`HqAppSource.cloudcareEnabled`). */
	readonly webAppsOnInHq: boolean;
}
export const storedFirstPublishSchema: z.ZodType<StoredFirstPublish>;
/** The list as it stands for an app that now declares `runsOnlyOn` (12.3). */
export function firstPublishViewFromStored(
	stored: StoredFirstPublish, runsOnlyOn: Platform | undefined,
): FirstPublishView;

// lib/deployment/reading/firstPublishChanges.ts
export type FirstPublishSource =
	/** A node of `GeneratedNodePurpose` Nova adds, renames or drops. */
	| { readonly kind: "generated-node"; readonly purposes: readonly GeneratedNodePurpose[] }
	| { readonly kind: "rewrite"; readonly ids: readonly EmissionRewriteId[] }
	/** A reading the reader holds as the same state under another spelling (part 07, 13.3). */
	| { readonly kind: "same-state" }
	/** A top-level key Nova's update body writes (`hqShells.ts::applicationShell`,
	 *  `targetOverlay.ts::projectApplicationForTarget`, `targetLogoRefs.ts`). */
	| { readonly kind: "shell"; readonly key: string }
	/** Something CommCare HQ's own import does, `file::symbol`. */
	| { readonly kind: "hq-import"; readonly symbol: string }
	/** A media path the adopted deployment cannot hold (part 10, 4.2). */
	| { readonly kind: "media-path" }
	| { readonly kind: "every-app" };

/** Nodes Nova's emission holds that the source did not, and the reverse (part 06, 13.4). */
export interface GeneratedDifference {
	readonly added: readonly ReadGeneratedNode[];
	readonly dropped: readonly ReadGeneratedNode[];
	readonly renamed: readonly { readonly from: ReadGeneratedNode; readonly to: ReadGeneratedNode }[];
}
/** `before`: what a source held. `after`: what Nova writes for a document. One list per form. */
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
	/** `assignMediaPaths` over the held files; null while a file has no verdict. */
	readonly media: MediaPathAssignment | null;
	/** Media references that point at no file and are left out (part 11, `HqMediaPlan.inert`). */
	readonly mediaLeftOut: number;
	readonly choice: { readonly runsOnlyOn: Platform | null; readonly split: boolean };
}

export interface FirstPublishChange {
	readonly source: FirstPublishSource;
	readonly behavior: "changes" | "none";
	readonly touchesWorkers: boolean;
	/**
	 * `reading`: the predicate reads no choice. `birth`: it reads what the chosen declaration did
	 * to the document at the birth, which no later edit undoes (the split). `declaration`: it reads
	 * `choice.runsOnlyOn`, which the person can change in the builder afterwards.
	 */
	readonly scope: "reading" | "birth" | "declaration";
	applies(facts: FirstPublishFacts): boolean;
	/** JSON Pointers over CommCare HQ's stored app, `*` for a position or an app's own key,
	 *  under which the stored source may differ because of this entry. */
	readonly paths: readonly string[];
}
export const FIRST_PUBLISH_CHANGES: Readonly<Record<FirstPublishChangeId, FirstPublishChange>>;
export function firstPublishChangesFor(facts: FirstPublishFacts): FirstPublishView;
```

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
choice being judged and never from check 3's re-read. A re-read is of one document a call (section
5.4), so a difference taken from it would be D's at the review and the split document's at a creation
that chose the split, and one choice's list would differ between the two calls and change part 12's
review digest. Planned from the choice's own document, a choice's list is a function of the reading
and the choice alone. `generatedNodes.parity.test.ts` holds the two builders to one key: over every
retained read and the fuzz corpora, the reader's `generated` list for Nova's emission of a document
equals `emittedGeneratedNodes` of that document as sets of `(purpose, owner, name, path)`. Step 7
compares two readings with the same function, each side a reader's list.

`firstPublishChangesFor` returns the ids whose `applies` is true, in the order of
`FIRST_PUBLISH_CHANGE_IDS`, and `touchesWorkers` true where any of them has it. The sentence of each id
is copy, in `lib/publish/firstPublishCopy.ts::FIRST_PUBLISH_SENTENCES` (Copy), total over the id type.

`MEDIA_REFERENCE_PATHS`, used below, is the list of pointers a media reference lives under:
`/_attachments/*`, `/modules/*/media_image/*`, `/modules/*/media_audio/*`,
`/modules/*/case_list/media_image/*`, `/modules/*/case_list/media_audio/*`,
`/modules/*/case_list_form/media_image/*`, `/modules/*/case_list_form/media_audio/*`,
`/modules/*/forms/*/media_image/*`, `/modules/*/forms/*/media_audio/*`,
`/modules/*/case_details/*/columns/*/enum/*/value/*` and `/logo_refs/*`. `firstPublishChanges.test.ts`
holds it to the slots part 11's `hqMediaReferencesOf` reads.

### 11.2 Every entry

Thirty-four entries land in B7. In the `applies` column `f` is the `FirstPublishFacts` the predicate is
given: `f.source` is CommCare HQ's source, `f.doc` the document under the choice, `f.facts` the
reader's `ReadFacts`, `f.generated` the generated difference, `f.media` the path assignment or null,
`f.mediaLeftOut` and `f.choice` as typed above.

| # | Id | Source | `applies` | `paths` | Behavior | Workers |
|---|---|---|---|---|---|---|
| 1 | `forms-and-settings-rewritten` | every-app | `f.source` holds a form | `/_attachments/*`; `/modules/*/forms/*/case_references_data/load`; `/modules/*/case_details/short/filter`; and, in the lane, every pointer the base's claim log holds under an entry whose standing is `inert` (13.3) | none | no |
| 2 | `marked-as-updated-from-a-file` | hq-import, `views/app_import_api.py::import_app_api` | `f.source.raw.created_from_template` is not `"import_app_api"` | `/created_from_template` | none | no |
| 3 | `hidden-values-added` | generated-node, every purpose but `guard` (11.3) | `f.generated.added`, `.renamed` or `.dropped` is not empty | `/_attachments/*` | none | no |
| 4 | `case-names-checked` | rewrite `case-text-guard`, `case-text-trimmed`; generated-node `trimmed` | `f.generated.added` holds a `trimmed` node | `/_attachments/*`; `/modules/*/forms/*/actions` | changes | yes |
| 5 | `validation-counts-moved` | rewrite `validation-count-lifted`; generated-node `constraint-count` | `f.generated.added` holds a `constraint-count` node | `/_attachments/*` | changes | yes |
| 6 | `validation-messages-composed` | rewrite `validation-message-composed`; generated-node `constraint-message` | `f.generated.added` holds a `constraint-message` node | `/_attachments/*` | changes | yes |
| 7 | `instant-comparison` | rewrite of that id | `f.facts.rewrites` holds the id | `/_attachments/*`; `/modules/*/module_filter`; `/modules/*/forms/*/form_filter`; `/modules/*/forms/*/form_links/*`; `/modules/*/case_details/*`; `/modules/*/search_config/*` | changes | yes |
| 8 | `empty-rows-guard` | rewrite of that id | the same test for its id | the paths of row 7 | changes | yes |
| 9 | `absent-session-value-guard` | rewrite of that id | the same | the paths of row 7 | changes | yes |
| 10 | `row-predicate-current` | rewrite of that id | the same | `/_attachments/*` | changes | yes |
| 11 | `search-value-guards` | rewrite of that id | the same | `/modules/*/search_config/*` | changes | yes |
| 12 | `search-today-device-day` | rewrite of that id | the same | `/modules/*/search_config/*` | changes | yes |
| 13 | `case-settings-respelled` | same-state; rewrites `update-case-always`, `external-id-in-update`, `subcase-index-unnamed`, `preload-as-default` | `f.facts.sameStateRewrites` holds a record whose `register` is the id | `/modules/*/forms/*/actions`; `/_attachments/*` | none | no |
| 14 | `search-filter-rows-recut` | same-state | the same test for its id | `/modules/*/search_config/default_properties` | none | no |
| 15 | `sort-rule-kept-as-hidden-column` | same-state | the same | `/modules/*/case_details/short/columns`; `/modules/*/case_details/short/sort_elements/*/type`; `/modules/*/case_details/short/sort_elements/*/display` | none | no |
| 16 | `list-settings-respelled` | same-state | the same | `/modules/*/case_details/short/max_select_value`; `/modules/*/case_details/short/sort_elements`; `/modules/*/search_config/title_label`; `/modules/*/search_config/description` (the last two for a search text map that lacks a language where every language is blank, part 07, section 12.4) | none | no |
| 17 | `search-filter-joined-to-list` | same-state | the same | `/modules/*/case_details/short/filter` | none | no |
| 18 | `detail-only-columns-searched` | same-state | the same | `/modules/*/case_details/short/columns` | changes | yes |
| 19 | `search-restates-list-filter` | same-state | the same | `/modules/*/search_config/default_properties` | changes | yes |
| 20 | `link-held-case-guards-added` | same-state | the same | `/modules/*/forms/*/form_links/*/xpath` | changes | yes |
| 21 | `connect-app-captures-location` | shell `auto_gps_capture`; rewrite `connect-captures-location` | `f.doc.connectType` is set and `f.source.raw.auto_gps_capture` is not `true` | `/auto_gps_capture` | changes | yes |
| 22 | `logo-path-only-entry-removed` | shell `logo_refs` | `withoutPathOnlyLogoRefs(f.source.logoRefs)` is not null (`lib/commcare/targetLogoRefs.ts`: some entry's only key is `path`) | `/logo_refs/*` | none | no |
| 23 | `translation-overrides-folded` | shell `translations` | `f.facts.foldedTranslationKeys` is above zero (part 06, section 17.3) | `/translations/*/*`; `/modules/*/name/*`; `/modules/*/forms/*/name/*`; `/modules/*/case_list/label/*`; `/modules/*/case_list_form/label/*` | none | no |
| 24 | `location-list-setting-reset` | shell `location_fixture_restore`; rewrite `location-list-project-default` | `f.source.raw.location_fixture_restore` is `both_fixtures` or `only_flat_fixture` | `/location_fixture_restore` | none | no |
| 25 | `web-apps-turned-off` | shell `cloudcare_enabled`; rewrite `web-apps-setting-from-declaration` | `f.source.cloudcareEnabled` and `f.choice.runsOnlyOn` is `android` | `/cloudcare_enabled` | changes | yes |
| 26 | `web-apps-turned-on` | the same | not `f.source.cloudcareEnabled` and `f.choice.runsOnlyOn` is not `android` | `/cloudcare_enabled` | changes | yes |
| 27 | `date-and-time-questions-split` | rewrite: none in the emitter; the split is `lib/doc/datetimeSplit.ts`, applied by the chosen declaration | `f.choice.split` | `/_attachments/*`; `/modules/*/forms/*/actions` | changes | yes |
| 28 | `blank-translations-filled` | rewrite: none of its own; `lib/domain/translationFill.ts::filledProse` over a blank read as absent | some `f.facts.forms[i].blankTranslations` is above zero (part 06, sections 12.2 and 17.3) | `/_attachments/*` | changes | yes |
| 29 | `media-paths-joined` | media-path | `f.media` is not null and `f.media.collapsed` is not empty | `/multimedia_map/*`; `MEDIA_REFERENCE_PATHS` | none | no |
| 30 | `media-path-not-holdable` | media-path | `f.media` is not null and `f.media.rederived` holds a `not-holdable` | the same | changes | yes |
| 31 | `media-path-names-another-file` | media-path | `f.media` is not null and `f.media.rederived` holds a `names-another-file` | the same | changes | yes |
| 32 | `media-path-differs-only-by-case` | media-path | `f.media` is not null and `f.media.rederived` holds a `differs-only-by-case` | the same | changes | yes |
| 33 | `media-references-with-no-file-removed` | media-path (part 11, section 3.2) | `f.mediaLeftOut` is above zero | `MEDIA_REFERENCE_PATHS`; `/multimedia_map/*` | none | no |
| 34 | `unused-media-entries-removed` | hq-import, `hqmedia/models.py::ApplicationMediaMixin.remove_unused_mappings` | some path of `f.source.multimediaMap` is the `path` of no entry of `f.facts.mediaReferences` and of no logo entry Nova's update keeps (the values of `withoutPathOnlyLogoRefs(f.source.logoRefs) ?? f.source.logoRefs`) | `/multimedia_map/*` | none | no |

Rows 25 and 26 have `scope: "declaration"`, row 27 `birth`, every other row `reading`.

**Row 34's predicate is HQ's own test, over what Nova sends.** The prune keeps a path in
`all_media_paths() | logo_paths` (`remove_unused_mappings`), and it runs at the end of the import,
after Nova's body is merged (`overwrite_app_from_source`, `_update_valid_domains_for_media`). So the
paths it keeps are the ones Nova's forms and menus name, which are the reading's resolved references,
and the logo entries the same body left in place, which is the dict after
`withoutPathOnlyLogoRefs`. A reference with no file is in neither set: Nova leaves it out (row 33),
and where the map held an entry for its path naming no file, that entry goes with it, which is why
row 33 allows `/multimedia_map/*` too.

**Two entries written here that land only on a gated outcome.** Each joins `FIRST_PUBLISH_CHANGE_IDS`,
the register and the copy in the pull request the outcome names, exactly as below.

| Id | Lands | Source | `applies` | `paths` | Behavior | Workers |
|---|---|---|---|---|---|---|
| `default-reads-current` | B7, on part 08's run E4, outcome B | rewrite of that id, whose `behavior` B6 then sets to `changes` | `f.facts.rewrites` holds the id | `/_attachments/*` | changes | yes |
| `media-downloaded-again` | B7, on part 10's run G2, outcome B | hq-import, `hqmedia/models.py::ApplicationMediaMixin.create_mapping` | `f.facts.mediaReferences` is not empty | `/multimedia_map/*` | changes | yes |

Both are `scope: "reading"`.

### 11.3 How the table is held complete

- **By the id types.** `FIRST_PUBLISH_CHANGES` and `FIRST_PUBLISH_SENTENCES` are records over
  `FirstPublishChangeId`, so an id without an entry or a sentence fails `tsc`.
- **By `GeneratedNodePurpose`.** `firstPublishChanges.ts::GENERATED_NODE_CHANGE` is a
  `Record<GeneratedNodePurpose, FirstPublishChangeId | "identity">`: `trimmed` to
  `case-names-checked`, `constraint-count` to `validation-counts-moved`, `constraint-message` to
  `validation-messages-composed`, `guard` to `identity`, and the other twelve to
  `hidden-values-added`. A purpose the emitter gains fails `tsc` here, and whoever adds it decides in
  this record whether a node of it is an answer leaf nobody acts on, a declared change, or a case
  block. `identity` means no entry declares the purpose: a guard refuses a submission, so one added
  or dropped is check 4's difference (section 6.3) and never a line a person is asked to accept.
  `acceptReading` holds the two halves together: after check 4 passes, a `GeneratedDifference` whose
  `added` or `dropped` holds a node mapped to `identity` is the difference
  `identity/generated/guard`, so the register is never asked about one. A test holds each named
  entry's `applies` true for a difference that adds a node of that purpose, `hidden-values-added`
  true for every purpose but `guard` (a trimmed sibling is a new export column too), and that failing
  arm for a guard.
- **By `EMISSION_REWRITES`.** Section 10.3's second test.
- **By the reader's same-state rules.** `firstPublishChanges.test.ts` requires every record of
  `ReadFacts.sameStateRewrites`, over every retained read, to name an id of this table whose `paths`
  cover the record's `path`. Part 07's `rewrites.test.ts` requires every same-state rule in its code to
  carry an id.
- **By the lane.** Run K3 (section 13).

### 11.4 The decision for every candidate

For each candidate change: **exact** (the original's behavior is read exactly, so nothing a runtime
reads changes), **refuse** (the reader raises a finding and no such app comes in), or **declare** (an
entry above). None is left undecided.

| Candidate | Decision | How |
|---|---|---|
| A case name saved trimmed | declare, `case-names-checked` | Nova always writes the trimmed sibling for a question a name comes from. Holding an untrimmed name would be a second spelling of one concept that exists only because CommCare HQ's build has it |
| A case name required | exact | HQ's build stamps `required="true()"` on the same bind; the reader claims the source's own `required` there under the INERT entry `questions/bind-required-on-the-question-that-names-a-created-case` and holds no condition (part 07, section 3.2, B4; canon `create-name-required-is-absent`) |
| A case name or external id capped at 255 characters, a name not blank after the trim | declare, `case-names-checked` | the check is on the question a worker answers |
| An external id held in `open_case` | exact | part 07 reads it as a write of the own arm; the build writes the same `<update>` leaf (`case-settings-respelled`, no behavior) |
| A help text with no markdown form | exact | part 03 (A8) holds `plainHelp`, and Nova writes no markdown form for it. Nothing is left to declare |
| A hint or a validation message with or without a markdown form | exact | no runtime reads a hint's or a validation message's markdown form (part 03, section 8.1), so the copy is inert and Nova writes none from A8. Nothing is left to declare |
| A label or a choice with no markdown form | exact | `plainLabel`, read from the form's presence (part 06, section 12.2) |
| A form whose text formatting is off | exact | `Form.plainText` (part 03, A8) |
| `update_case.condition` of `never` or `if` | exact on the shapes part 07 holds; refuse the two it does not | part 07, section 3.2; `forms-and-case-writes/update-case-condition-never-on-a-follow-up-with-no-other-active` (REFUSED, not HQ-editable) and `forms-and-case-writes/update-case-condition-if-whose-question-is-gone` (REFUSED, not HQ-buildable) are both `fix-in-hq` |
| `location_fixture_restore` of `both_fixtures` or `only_flat_fixture` | declare, `location-list-setting-reset` | the manifest holds both as the same state for everything a held app reads; the stored setting changes |
| `location_fixture_restore` of `only_hierarchical_fixture` | refuse | manifest row `application-and-settings/50pp-hq-location-fixture-restore-only-hierarchical-fixture`, `never` |
| `created_from_template` | declare, `marked-as-updated-from-a-file` | HQ's import view sets it on every import and no body can prevent it |
| The pruned media map | declare, `unused-media-entries-removed` | HQ's import runs the prune and saves |
| A generated translation key in `translations` | exact where it has no effect or is blank; declare where it folds (`translation-overrides-folded`); refuse otherwise | part 01, section 7.1; part 06, section 16.5 |
| The translation keys Nova writes itself (`homescreen.title`, `app.display.name`, a language's name) | exact | the first two are the app's name where it differs by language, read into the name's translations; a language's name is kept at CommCare HQ's value on an adopted deployment (part 10, B8) |
| Preload order | exact where no later load-time value reads the question; refuse otherwise | part 07, section 3.7 (`laterLoadReaders`), `not-yet` |
| The order of two defaults | exact where it does not matter; refuse where one reads what the other sets | part 06, section 11.3, `fix-in-hq` |
| A date and time question saved straight to a case | refuse | part 07, section 3.2, under `forms-and-case-writes/a-datetime-question-saved-straight-to-a-case` (`not-yet`). The source stores the day alone and Nova would store the moment |
| A date and time written through Nova's own sibling | exact | the reader folds the sibling it recognizes |
| The date and time split | declare, `date-and-time-questions-split`, only where the person chose it | part 06, section 16.3 |
| New export columns from generated nodes | declare, `hidden-values-added` | each generated leaf is a new column of CommCare HQ's form export |
| A generated node renamed (a suffix that moved) | declare, `hidden-values-added` | the column starts again under the new name |
| An itext id an expression reads through `jr:itext` | exact | part 08 binds the read to the text it names and prints Nova's id for that text; an itext id is local to one form's source. Covered, as spelling, by `forms-and-settings-rewritten` |
| `case_references_data.load` | exact | only CommCare HQ's app summary reads it; `proof/rules/case_references_load.py` erases it as a proven spelling rule |
| `case_references_data.save` | exact, or refuse | equal to the form builder's own computation (`forms-and-case-writes/case-references-data-save-equal-to-vellum-s-computation-from-the`, HELD) or refused (`forms-and-case-writes/case-references-data-save-differing-from-that-computation`) |
| A guard block Nova writes beside a case operation | exact, or acceptance fails | part 07 reads an operation only with its guards in place, so the emission's guards are the source's; one added or dropped is check 4's difference (sections 6.3, 11.3), never a declared change |
| A count inside a validation | declare, `validation-counts-moved` | section 10.2 |
| A validation message that shows an answer | declare, `validation-messages-composed` | `lib/commcare/CLAUDE.md`, "Markdown itext": the composition deliberately does not claim identical error handling |
| A translation left blank in a language other than the first, where the first holds text | declare, `blank-translations-filled` | Nova's projection fills it as the form builder does on every save; a deliberately blank translation is not a concept Nova holds |
| A text left blank in the first language where another language holds it | refuse | part 06, section 12.2 (B3), under `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text`: no first-language text exists for Nova's fill to take, and the form builder would fill it from whichever language holds text |
| `auto_gps_capture` off on a CommCare Connect app | declare, `connect-app-captures-location` | part 01, section 4.3 |
| `cloudcare_enabled` | declare where the chosen declaration differs from it; the publish also asks before it changes the setting, as it does today | `lib/deployment`'s Web Apps question (step 4) |
| A case detail column the list lacks | declare, `detail-only-columns-searched` | part 07, section 11.3 |
| A media path Nova cannot hold | declare, rows 29 to 32 | part 10, section 4.2 |
| A media reference with no file | exact where no runtime draws it (left out, `media-references-with-no-file-removed`); refuse otherwise | part 11, section 3.2 |
| The data node's `name` and `<h:title>` | exact | part 06 claims both as derived from the form's name; Nova writes the first language's name, which is what a save in the form builder writes |
| The expression rewrites | declare, rows 7 to 12 | part 08, section 2.3 |

---

## 12. What the review and the first publish are handed

### 12.1 The list, per declaration choice

For each choice of `input.choices`, once every check has passed, `acceptReading` builds
`FirstPublishFacts`: the source; the document under the choice (check 2's `verdict.nextDoc`); the
draft's facts; `generatedDifference(facts.forms[i].generated, emittedGeneratedNodes(nextDoc, forms))`
(section 11.1), from that document's own plan; `assignMediaPaths(input.media.files)`, or null under
`pending`; `input.mediaLeftOut`; and the choice. It calls `firstPublishChangesFor`, and the result is
that choice's `AcceptedDeclaration.firstPublish`. `AcceptedReading.firstPublish` is the preselected
choice's, the one at `input.choices.proposed`.

Nothing in a choice's list depends on which document check 3 re-read. A read step and the creation
that follows it give every choice the same list from the same reading, which is what part 12's review
digest needs: the list the person answered is the list the birth stores.

Two choices of one reading differ in the two `declaration` entries, in the `birth` entry, and, where
one of them takes the split, in whatever the split document's generated nodes change. Each choice
carries its own list whole, so the review redraws the list when the person changes the declaration
without another read. Part 12's `ReadingDeclarationChoice` holds `firstPublish: FirstPublishView`,
taken from the `AcceptedDeclaration` at the same position, and its `ReadingReview.firstPublish` stays
the preselected choice's (part 12, 12-the-reading-and-the-birth.md, section 5.1, B10).

Under `media: "pending"` the four media path entries of rows 29 to 32 cannot apply (`f.media` is
null). Row 33 can: its predicate is `f.mediaLeftOut`, which part 11's plan knows from the source
before any file is fetched. No person sees a pending list: a pending step ends in `needs-media`, and
the review is written by the read step that follows the media step (part 12, section 3.3).

### 12.2 The data contract

One function turns a view into everything a surface shows, so the review, the publish screen and MCP
cannot word one list three ways:

```ts
// lib/publish/firstPublishCopy.ts
export const FIRST_PUBLISH_SENTENCES: Readonly<Record<FirstPublishChangeId, string>>;
export interface FirstPublishLine {
	readonly id: FirstPublishChangeId;
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

`workers.lines` and `hqOnly.lines` are split by `FIRST_PUBLISH_TOUCHES_WORKERS`
(`lib/publish/firstPublishChangeIds.ts`), the register's `touchesWorkers` column as client-safe data,
since `lib/publish` cannot import the register; `firstPublishChanges.test.ts` holds the two equal. A
sentence takes no argument: none names a question, a menu, a count or a project space, so the same
string serves every surface. Every app that holds a form has `forms-and-settings-rewritten` in
`hqOnly`, so that group is never empty; `workers` is empty exactly where the reassurance shows.

This is the one renderer and the one copy. Part 13 (13-the-experience.md) draws this value and writes
no sentence, lead or label of its own. It is decided here because the copy's home is this part's
file: the shape above, one heading, two leads and two labels (a review and a publish do not say the
same thing first, and a person needs the worker lines apart from the housekeeping ones), a
reassurance that says something a person can check, and the note. The strings are in Copy, C1.

Part 13's B11 draws that value in the review (`firstPublishLines(choice.firstPublish, "review")`,
its section 8.8) and in the publish dialog (`firstPublishLines(view.firstPublish, "publish")`, its
section 11.2), adds no sentence and drops none: a list is shown whole. Part
13's B12 returns the same value, with its keys in snake case, as `first_publish` on each entry of
`read_hq_app`'s `review.runs_on` (part 13, Departure 14), built with surface `review`, and on
`check_project_space_compatibility`, built with surface `publish`. On the second it is null exactly
where `firstPublishOf` (12.3) answers null: no list is stored for the deployment (an app Nova made,
or one brought in that Nova has since published to), or its live app mapping is not the adopted one
the list was stored for (an ended deployment).

### 12.3 Where the list is kept between the review and the first publish

Part 12 clears a reading's outcome when the app is created (its section 6.3, statement 5), so the list a
person reviewed has to live with the app. It is a fact about the baseline Nova read: it says what
differs between that baseline and what Nova will write, and it stops being true the moment a push
replaces the baseline.

This is the one home of the list. The reading's row holds no copy of it: a second
column could disagree with this one, it would outlive the baseline it describes unless a second
rule ended it, and the review's preselected list is the wrong one whenever the person chose another
declaration. Part 13 (13-the-experience.md, section 11.2) reads `DeploymentView.firstPublish` as
below and adds no column.

**DDL**, in part 10's migration `20261201000000_hq_bring_in_ledger` (B8; 10-identity-and-the-ledger.md,
section 11, statement 10): three clauses of its one `ALTER TABLE app_deployment_baselines`, after
the origin CHECK that admits `read` and the identity-map CHECK. Every statement of that migration
replays over its own result, so the clauses do too. The constraint is named for its predicate, as
that table's others are (`app_deployment_baselines_unread_holds_no_source`):

```sql
ALTER TABLE app_deployment_baselines
	ADD COLUMN IF NOT EXISTS first_publish_changes jsonb,
	DROP CONSTRAINT IF EXISTS app_deployment_baselines_first_publish_changes_belong_to_a_read,
	ADD CONSTRAINT app_deployment_baselines_first_publish_changes_belong_to_a_read
		CHECK (first_publish_changes IS NULL OR origin = 'read');
```

Additive and nullable: the revision serving while the migration runs neither reads nor writes it. No
row is backfilled; no document changes. `lib/db/pg.ts::AppDatabase` gains the column in B8, typed
`JSONColumnType<{ readonly ids: readonly string[]; readonly webAppsOnInHq: boolean }> | null`
(structural, since `StoredFirstPublish` lives in a B7 file); B8 holds no writer and no reader of it,
and every statement of B8 that sets `origin` leaves the column null, so the CHECK holds from the
moment it lands. The writer, the readers and the rule below are B7's, which sits above B8.

**What is kept** is a `StoredFirstPublish` (section 11.1): the ids of the chosen declaration's list
whose entry's `scope` is `reading` or `birth`, in registry order, and `webAppsOnInHq`, the Web App
setting CommCare HQ held at the reading. The two `declaration` ids are not kept. A person can change
where the app runs in the builder between the birth and the first publish, and a stored
`web-apps-turned-off` would then tell them Web Apps is turned off for an app that now runs in it.
Those two lines are worked out again from the document, by the predicates of rows 25 and 26 over the
stored setting. `touchesWorkers` is not kept either: it is a fact of the ids that remain.

- **Written** once, at the birth. `lib/deployment/types.ts::AppBaselineWrite` gains `readonly
  firstPublish: StoredFirstPublish | null`. Part 10's `adoptedAppBaselineWrite` gains the input
  `firstPublish: FirstPublishView`, the chosen declaration's `AcceptedDeclaration.firstPublish` from
  the creation's own acceptance (part 12 passes it), and writes `{ ids: <its ids less the two
  declaration ids>, webAppsOnInHq: source.cloudcareEnabled }`. Every other maker of an
  `AppBaselineWrite` (`service.ts::appBaselineFor`'s `create`, `push` and `unread` arms, and part 01's
  `recordRefreshedAppBaseline`) passes null.
- **The one writer's two arms.** Every baseline goes through `store.ts::writeAppBaseline`, an upsert
  on `deployment_id`. Its `INSERT` list gains `first_publish_changes`, the value as JSON or null. Its
  `ON CONFLICT (deployment_id) DO UPDATE` arm gains, under the `WHERE` it has today:

  ```sql
  first_publish_changes = CASE
  	WHEN EXCLUDED.origin <> 'read' THEN NULL
  	WHEN EXCLUDED.remote_app_id = existing.remote_app_id
  		THEN COALESCE(EXCLUDED.first_publish_changes, existing.first_publish_changes)
  	ELSE EXCLUDED.first_publish_changes END
  ```

  So a push over a read baseline sets `origin = 'push'` and the column null in one statement, and the
  CHECK is never met with a list beside another origin. A refresh of kept values writes the stored
  origin `read` with a null list over the same HQ app (part 01, section 6.5), and `COALESCE` keeps
  the list: it is still the read baseline, read again. A write the `WHERE` turns away (an older
  read) changes nothing, the list included.
- **Ended** by the first push, by that same arm, and by nothing else. No code clears the list; it
  cannot outlive the origin it describes.
- **Read**, for a viewer, by a new `lib/deployment/store.ts::readFirstPublishStates(scope:
  DeploymentScope): Promise<ReadonlyMap<string, { readonly remoteAppId: string; readonly stored:
  StoredFirstPublish }>>`, keyed by deployment id. It authorizes `view` (`roleAllowsApp(scope.role,
  "view")`, else `deploymentNotFound()`), and selects `b.deployment_id`, `b.remote_app_id` and
  `b.first_publish_changes` for the app's deployments where the column is not null. It never selects
  `source_gzip`. `readAppBaseline` is not the reader: it authorizes `edit` because its answer holds
  CommCare HQ's source, its one caller is `preflight.ts`, and the Publishing section and
  `check_project_space_compatibility` read as `view` (`lib/deployment/CLAUDE.md`, "Surfaces").
  `readAppBaseline` does not change for this column; part 10 widens its origin guard to admit `read` (its
  section 6.3). The value is parsed with `storedFirstPublishSchema` after each id the registry no longer
  holds is dropped with `log.warn("[deployment] first-publish change no longer registered")`. A value
  that is no object of the two keys is logged at error and read as no list. Neither throws: a registry
  edit must not stop a page or a publish.
- **Shown.** `lib/deployment/actions.ts::DeploymentView` gains `firstPublish: FirstPublishView |
  null`, and one pure export is the rule that fills it:

  ```ts
  // lib/deployment/resources.ts (B7), beside part 10's deploymentEnding
  /** The list the person reviewed, while the live app mapping is adopted and names the app the list
   *  was stored for; null otherwise. */
  export function firstPublishOf(
  	deployment: DeploymentWithResources,
  	state: { readonly remoteAppId: string; readonly stored: StoredFirstPublish } | undefined,
  	runsOnlyOn: Platform | undefined,
  ): FirstPublishView | null;
  ```

  It answers `firstPublishViewFromStored(state.stored, runsOnlyOn)` where `state` is defined and
  `activeRemoteApp(deployment)` is an `adopted` mapping whose remote id is `state.remoteAppId`, and null
  otherwise, so an ended deployment shows none, and a deployment Nova has published to has no entry in
  the map (the push cleared the column). `readDeploymentsAction` calls `readFirstPublishStates(scope)`
  once beside its one read of the document, and it, `refreshDeploymentAction`,
  `withdrawDeploymentConfirmationAction` and part 10's `stopPublishingAction` (its section 8.3) each call
  `firstPublishOf` with their entry of that map and `doc.appSettings.runsOnlyOn`. The publish dialog
  draws the value before the person confirms a publish (part 13, section 11.2). B12's
  `check_project_space_compatibility` calls `readFirstPublishStates(scope)` and the same function (part
  13, section 14.7).

`firstPublishViewFromStored(stored, runsOnlyOn)` answers the stored ids, with `web-apps-turned-off`
where `stored.webAppsOnInHq` and `runsOnlyOn` is `android`, and `web-apps-turned-on` where
`stored.webAppsOnInHq` is false and `runsOnlyOn` is not `android`, all in registry order, and
`touchesWorkers` from `FIRST_PUBLISH_TOUCHES_WORKERS` over the result. `firstPublishChanges.test.ts`
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
of `{ change, rows: [{ check, artifact, path, kind? }], bases }`, one object a change. A1 begins the
file with the entries the probe showed on `hq-plain`, under this register's ids. B7 completes it:
every entry in registry order with its `source` rows (one row a pointer of the entry's `paths`,
`artifact: "app.json"`), keeping the rows and `bases` stack A wrote, and deletes
`proof/checks/changes.py::CANDIDATE_IDS`. Run K3 fills every other row and every `bases` in B13. B7
also writes the file's one Vitest, `proof/ci/__tests__/firstPublishChanges.test.ts`. What this part
gives the lane is below, and nothing else.

The lane's shards hold `proof/` and `lib/commcare/surface/` and nothing else of the repository
(`proof/CLAUDE.md`), so the judge cannot read the TypeScript register. The two meet in two places
only: the ids, and `first-publish.json` in each base's directory, the predicted ids the reader bundle
writes from the base's declaration's `AcceptedDeclaration.firstPublish.ids` (part 14, section 9.2).

### 13.2 The ids

B7 renames no id. Part 14's A1 candidates are this register's ids (its section 3.3).

### 13.3 What the judge needs for an entry no proof shows

Part 14's judge observes an id through proofs 1, 2 and 3 and intent. Thirteen entries change only what
CommCare HQ stores, and none of those four reads it: rows 1, 2, 13 to 17, 22 to 24, 29, 33 and 34
(proof 2 leaves a form's XML unjudged on this hop, part 14, section 4). Rows 1 and 2 apply on every
base that holds a form. With no comparison of the stored app each would be predicted and never
observed (`/<id>/unseen`) on every base it applies to. So the lane gains one comparison, which part
14 writes (its section 9.3, B13):

- **`source`**, a check name `proof/checks/differences.py::CHECKS` gains (it refuses an unknown one in
  `Difference.__post_init__`), beside `proof6`, `parity` and `changes`. It compares A's stored app with
  B's as CommCare HQ's source view serves each: JSON by pointer, a position and an app's own key as
  `*`, and a form's source as bytes, reported at `/_attachments/*`. Every source read re-mints form
  ids, so a form id and every reference to one is compared as the menu and form position it names
  (part 14, 9.3). `changes.declared` is called for it as for the proofs, so a row may have `check:
  "source"`.
- **A `source` row's `path` is one of its entry's `paths`** (section 11.2). The register writes those
  pointers at source; the lane writes its other rows from evidence. The two are held together where
  the checkout is whole. B7's `proof/ci/__tests__/firstPublishChanges.test.ts` holds: the file's ids
  are `FIRST_PUBLISH_CHANGE_IDS` in order; each object's `source` rows are exactly the entry's
  `paths` (entry 1's three written pointers; its inert allowance has no row); a `proof3` row stands
  only under an entry whose `behavior` is `changes`; `bases` is sorted and unique. A behavior
  difference under an entry that declares none is then a failing test, never an accepted change.
- **Entry 1's allowance.** A `source` difference at a pointer the base's claim log holds under an
  entry of standing `inert` (the reader bundle's `claims: "full"` product, part 14, section 8.1) is
  `forms-and-settings-rewritten`'s: Nova does not write back what no runtime reads. The judge matches
  it with no row (part 14, 9.3).

With `source` an observed check, every one of the thirty-four ids is one some check can show.

### 13.4 What the judge then holds

Part 14's both-ways judge (its section 9.3), with `source` among its observed checks, on every
`hq-authored` document and nowhere else:

1. **Nothing unsaid.** A difference of the hop that no entry naming the document holds goes on to the
   spelling rules and the known-defect register, where nothing holds it, and fails; an observed id the
   reading did not predict is `/<id>/unsaid`.
2. **Nothing said in vain.** A predicted id nothing observed is `/<id>/unseen`.
3. **Behavior only where behavior is declared**, by 13.3's Vitest; proof 3's value expectations
   for a base (part 14, section 6.4) include one that shows each `changes` entry the base exhibits.
4. **`bases` is the truth.** For every entry, `bases` equals the set of bases whose
   `first-publish.json` lists its id, or `/<id>/bases`.

The predicted ids are the base's declaration's list, computed by `acceptReading` in the reader bundle
over the base's retained reads. Run K3 is this judge's first whole run. Every register entry has a
base and none is exempt: part 14's section 9.4 places each of the shapes "What this part needs of
other parts" lists.

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
one of `ACCEPTANCE_CHECKS` (part 12 writes `reader` for the reader's own contract error, its section
3.3). It is Nova's own word and is never shown: part 01's `findingLine` renders `named: null` for this
code (its section 9.2).

Nothing of the difference is stored on the reading. The row holds the findings as every account does
(part 12, section 2), which is enough to show the person where and to let them check again.

### 14.2 The signature

```ts
// lib/deployment/reading/signature.ts
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
/** The property names of Nova's document schema, collected once from `lib/domain/blueprint.ts`. */
export const DOCUMENT_SCHEMA_KEYS: ReadonlySet<string>;
/** A document path as content-free segments (the first row of the table below). */
export function documentPathKinds(path: readonly string[]): readonly string[];
/** The check, then its segments, joined with `/` and cut at a whole segment within 80 characters. */
export function differenceSignature(
	check: AcceptanceCheck, segments: readonly string[],
): string;
```

`differenceSignature` joins the check and its segments with `/` and cuts the result at the last whole
segment within 80 characters, so every signature begins with a member of `ACCEPTANCE_CHECKS`. Every
segment comes from a closed vocabulary that holds no word of any app:

| Segment | From |
|---|---|
| a document path | `documentPathKinds(path)`: the top-level key renamed (`modules` to `menu`, `forms` to `form`, `fields` to `question`, `caseTypes` to `case-type`, `localization` to `translations`), then every later segment that is a property name of Nova's own document schema, in order. A uuid, an array position, a language code, a case type's or a property's name and any other record key is dropped. The property names are collected once from `lib/domain/blueprint.ts`'s schema (`signature.ts::DOCUMENT_SCHEMA_KEYS`) |
| a key of an identity or a summary record | the member's name in this part's own types (`repeats`, `typeClass`, `properties`, `label`) |
| a validator code, an `UnreadFormReason`, a `HandOffKind`, HQ's type name, a production function's name | as they are |
| a fixed word of sections 3 to 7 (`defect`, `census`, `export`, `threw`, `account`, `unread`, `missing`, `added` and the rest written there) | as written there |

Examples: `fixed-point/question/relevant`, `fixed-point/menu/caseListConfig/columns/format`,
`identity/leaf/typeClass`, `identity/case-blocks/basic-subcase/properties`,
`summary/question/option/label`, `gate/FIELD_ID_DUPLICATE`,
`gate/export/LOCATION_OWNER_EXPORT_NOT_ACTIVE`.

The failing arm's `signature` is the first difference's. `signature.test.ts` holds it content-free by
property: for documents whose every name, id, label, choice value and case type is a random sentinel,
no signature of any difference between two of them holds a sentinel.

### 14.3 The log and Sentry

Acceptance logs nothing: it is pure. Part 12 logs each distinct signature of a step once, as
`log.error("[reading] read-back differs: <check>: <signature>")` with the reading's id as the `appId`
tag (its section 10). A message with no error object is a message event in Sentry, which groups by its
text, so one defect of the reader is one issue however many apps meet it. B7's share: `check` is never
null and `signature` is always present, so that line is total; the context part 12 passes gains
`differenceCount` (the number of differences, at most twenty) and `signatures` (the distinct signatures
of the step, at most five), both content-free.

`AcceptanceDifference.detail` holds the app's words and exists for tests and for a developer running
the function over a retained read. It is never passed to `log`, never stored and never returned by a
route: `acceptance.ts` imports no logger and no store (`acceptance.purity.test.ts`), and part 12's
`ReadingCheck`, the value that crosses the worker boundary, has no `differences` member (its section
3.6), so the type keeps the words inside the worker.

### 14.4 The reading, and the words

The reading goes to `account` and stays (part 12, section 3.4). "Check again" reads CommCare HQ afresh
and runs acceptance again, so a person is unblocked by the release that fixes the reader, with nothing
to redo. Nothing was created and nothing in CommCare HQ was touched.

The block is part 01's (`lib/publish/hqFindingCopy.ts::CIRCUMSTANCE_COPY`), with its body widened so it
is true of every check (Copy, C3): a gate refusal is not a comparison with CommCare HQ's reading.

---

## 15. The production `appStrings`, and `adoptionExportBoundary`

### 15.1 `localAppStringTable`

Part 06's classifier of generated translation keys takes `ReaderInput.appStrings: (doc) =>
AppStringTable` (its sections 16.5 and 17.5): the app strings Nova's own build gives a document, by
language, with each string's source unit. `compileCcz` builds exactly that as it walks the app and
returns only an archive. B7 splits it:

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

`ReaderInput.appStrings` keeps part 06's type, `(doc) => AppStringTable`: the stand-in target is why
the function needs nothing of the reading. Part 12's worker builds `appStrings` as
`localAppStringTable` on its own side (its section 3.6); the worker bundle is Node's and its build
gives it Node's `require` (the `createRequire` banner of part 12's 3.6), through which
`compiler.ts`'s archive library, a CommonJS package, loads there as it does on the server.

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
until the birth (part 12's need): `doc` as given; `attachmentTarget` the target; `lookupNaming`
`lookupWireNaming(lookupDefinitions)`, absent where the list is empty, the definitions being
`AcceptReadingInput.lookup.definitions` (each bound table's tag and field names as CommCare HQ holds
them, under the ids the reading minted), which part 12 passes; `assets` one resolved asset per asset
of `mediaFiles`, at the path `assignMediaPaths(mediaFiles)` gives it and at its derivation
(`multimedia/assetWirePath.ts::wirePathFor`) where it gives none, with the file's own `contentHash`
and `extension`, the kind of the slot the document references it from (`lib/domain/mediaRefs.ts`'s
walk), `mimeType` as `emissionAssets` writes it (5.1: the body `hqImportApplication` builds prints an
asset's `wirePath` and reads no other member), and no `bytes`. It takes no type of part 12's, which
sits above it in the stack. Part 10's `adoptedAppBaselineWrite`
takes it as `prepared` (part 12, section 6.2), so the baseline's ownership descriptor is computed over
the body the first publish would send.

---

## Copy

Every string B7 adds, as it ships. All of it follows `design/readme.md`, "Content fundamentals".

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

**C2. The sentences** (`FIRST_PUBLISH_SENTENCES`). Rows 7 to 12 and the gated `default-reads-current`
are part 08's seven (its C1 to C6b; C5 is the gated one), moved here unchanged from the
`REWRITE_SENTENCES` this pull request deletes (section 10.2); rows 13 to 20 are part 07's (its
section 13.3), written here because the register is their home.

| Id | Sentence |
|---|---|
| `forms-and-settings-rewritten` | Nova writes this app's forms and settings again in its own way. What each form asks, shows and saves stays as it is, apart from anything listed here. |
| `marked-as-updated-from-a-file` | CommCare HQ will note that this app was last updated from an app file. Nothing in the app reads that note. |
| `hidden-values-added` | Some forms gain hidden values that Nova manages. Their names start with nova_. CommCare HQ's form builder lists them, and form exports show each as a new column. |
| `case-names-checked` | A question that gives a case its name now needs an answer that isn't blank. A case name or an external ID longer than 255 characters is turned down, and both are saved without spaces at their ends. |
| `validation-counts-moved` | A validation rule that counts another question's answers now counts only that question's answers. Before, CommCare could count the answer being checked instead. |
| `validation-messages-composed` | A validation message that shows an answer now shows exactly that answer. Where the answer can't be read, workers see CommCare's own message. |
| `instant-comparison` | An expression that compares two dates and times is now written so it compares the same moment in every time zone. In CommCare HQ's form builder these expressions will look longer. |
| `empty-rows-guard` | An expression that reads a lookup table, your places or a search answer now reads blank when there is nothing to read. Before, it stopped the form. |
| `absent-session-value-guard` | An expression that reads the screen width or the app's language now reads blank where CommCare has none to give. Before, it stopped the form. |
| `row-predicate-current` | Inside a repeat, a choice filter that names another question of that repeat now reads this entry's answer. Before, CommCare stopped on it or used one entry's answer for every entry. |
| `search-value-guards` | A search value that holds a quote mark is now matched as typed, and a value CommCare HQ can't search by finds no cases. Before, the search failed. |
| `search-today-device-day` | A search filter that uses today's date now uses the worker's day. In CommCare HQ it used the project space's day, which differs for a worker in another time zone. |
| `case-settings-respelled` | Nova writes each form's case settings in its own way. What a form saves and loads stays the same. |
| `search-filter-rows-recut` | Nova writes each search's filters in its own order. Every search finds the same cases. |
| `sort-rule-kept-as-hidden-column` | A sort rule over a property the list doesn't show is kept as a hidden column. Lists sort the same way. |
| `list-settings-respelled` | Nova writes each case list's settings in its own way. Lists show, sort and select the same way. |
| `search-filter-joined-to-list` | Where a menu's forms read its search, Nova keeps the search's filter and the case list's filter as one. The search finds the same cases. |
| `detail-only-columns-searched` | Nova adds the values only a case's detail screen shows to its case list as hidden columns, so a worker's filter on that list will also match them. |
| `search-restates-list-filter` | Nova sends a case list's filter with its search, so a search that matched more cases than CommCare HQ returns at once can show cases it left out before. |
| `link-held-case-guards-added` | A form that opens another form with a case it carries will open it only when that case is on the device. Nova adds that check to each such link. |
| `connect-app-captures-location` | Every form of this CommCare Connect app will record where it was filled in. Nova turns on Auto Capture Location for the app in CommCare HQ. |
| `logo-path-only-entry-removed` | A logo entry that names a path and no file is removed. No logo a worker sees changes. |
| `translation-overrides-folded` | A wording set in CommCare HQ's app translations for a menu's or a form's name becomes that menu's or form's own name. Workers read the same words. |
| `location-list-setting-reset` | This app's own setting for the location list goes back to the project space's default. The app reads places the same way. |
| `web-apps-turned-off` | Web Apps is turned off for this app in CommCare HQ, because the app is set to run on Android only. |
| `web-apps-turned-on` | Web Apps is turned on for this app in CommCare HQ, because the app is set to run in Web Apps. |
| `date-and-time-questions-split` | Each date and time question becomes a date question and a time question, so the app runs in Web Apps. A case still gets one date and time from the two. |
| `blank-translations-filled` | A text left blank in one language is written in the app's first language for that language, as CommCare HQ's form builder does when a form is saved there. |
| `media-paths-joined` | Where CommCare HQ holds one picture, sound or video under several names, the app now uses one of them. Workers see and hear the same files. |
| `media-path-not-holdable` | Nova gives a new name to a file whose name it can't keep in CommCare HQ. Phones download it again with the next version of the app. |
| `media-path-names-another-file` | A file stored under another file's name gets a name of its own. Phones download it again with the next version of the app. |
| `media-path-differs-only-by-case` | Files whose names differ only by capital letters get new names, so each keeps its own picture, sound or video. Phones download them again with the next version of the app. |
| `media-references-with-no-file-removed` | References to pictures, sounds and videos that have no file in CommCare HQ are removed. Workers saw nothing there. |
| `unused-media-entries-removed` | CommCare HQ drops the entries of this app's media list that nothing in the app uses. The files themselves stay in CommCare HQ. |
| `default-reads-current` (gated) | Inside a repeat, a starting value that reads another question of the repeat now reads it from the same entry. |
| `media-downloaded-again` (gated) | Phones download this app's pictures, sounds and videos again with the first version made after this publish. |

**C3. `read-back-differs`** (part 01's `CIRCUMSTANCE_COPY`, its section 9.3, which holds this body
from A2). Title and next step are part 01's. The body, true of every check:

> Nova read this app and then checked its own reading, and the check didn't pass. That's Nova's
> mistake, not the app's, and Nova has told the team.

**C4. Developer-facing errors** (thrown; a person never reads them).

| Where | Message |
|---|---|
| `emission.ts::readingEmission`, a form of the draft whose `xmlns` the source does not hold | "Nova tried to print a reading under its source's own form ids and found no form with the namespace it read. Every form of a reading comes from a form of the source; the draft and the source handed to acceptance are not from one read." |
| `firstPublishCopy.ts::firstPublishLines`, an id with no sentence (unreachable under `tsc`) | "Nova was asked for the sentence of a first-publish change it has no words for. Every id of FIRST_PUBLISH_CHANGE_IDS has a sentence in FIRST_PUBLISH_SENTENCES, and a stored list is checked against those ids where it is read (lib/deployment/store.ts::readFirstPublishStates), so look at the caller that built this list by hand." |
| `store.ts::readFirstPublishStates`, a stored value that is no list of ids beside a Web App setting (logged at error, never thrown) | "The deployment ${deploymentId} holds first-publish changes Nova can't read (${issue}). They are written once, when an app is brought in, by lib/deployment/adoption.ts::adoptedAppBaselineWrite, and nothing else writes them. Nova is showing this deployment with no list." |
| `canon.ts::canonDocument`, a row that still changes the document after 16 passes | "Nova's canonical form of a document did not settle. Each canonicalization returns the member of its pair the reader returns, so applying one twice changes nothing; look at the row whose result another row undoes." |

---

## Tests

Every test is Vitest unless marked. None renders a component: acceptance, the register and the canon
list are functions of data, and part 13 owns the Playwright specs that show the lines.

| Test | Boundary | The failure it catches |
|---|---|---|
| `lib/deployment/reading/__tests__/acceptance.accepts.test.ts`: every retained reading under `proof/hq-reads/reading/` that part 05 keeps as a readable app, through `readHqApp` and `acceptReading` with part 11's settlements, answers `ok` with a list of entries. Named cases, each a retained reading or a production-built source that must answer `ok`: a registration form whose name question holds no validation (check 5's `constraint` row); a question whose label is written inline with no `ref`, and one whose second language has no `<text>` (7.3); a control with an appearance part 06 accounts as inert, and a group whose `<label>` is blank in every language (check 4); a section that holds only a Hidden Value (7.1's `group` rule); an app with a media reference that has no file, left out as inert (5.3, step 2); an app with a Web Apps logo (5.1) | the production reader and acceptance over CommCare HQ's retained answers | a check that fails a correct reading, which would stop every bring-in |
| `acceptance.doctored.test.ts`, check 1: the same input with one hand-off's settlement removed answers `check: "accounting"`, an `unrecognized` finding at the media reference's place and signature `accounting/hand-off-unsettled/media-reference`; with one settlement duplicated, `accounting/hand-off-settled-twice/media-reference` and a `read-back-differs` finding named `accounting`; with a settlement no hand-off matches, `accounting/settlement-unmatched` and the same finding at the app; with one census count doctored, `accounting/census` | `acceptReading` | a media path or a table read that no rule of part 11's judged, accepted on the reader's word |
| `acceptance.doctored.test.ts`, check 2: the draft's batch with one question's id changed to its sibling's answers `check: "gate"`, a `read-back-differs` finding at that form, and a signature that names the validator's code and no id | `acceptReading` over the production gate | a document the birth would refuse, accepted and shown as a review |
| `acceptance.doctored.test.ts`, check 3: the draft's document with an explicit `postSubmit` equal to its form's default (the other member of a canon pair) answers `check: "fixed-point"` and signature `fixed-point/form/postSubmit` | `acceptReading` | a reader whose answer for CommCare HQ's bytes is not its answer for Nova's |
| `acceptance.doctored.test.ts`, check 4: the draft's document and batch with one whole-number question made a decimal, consistently, passes checks 1 to 3 and answers `check: "identity"`, signature `identity/leaf/typeClass`; a second case moves one case write to another question and expects `identity/case-blocks/basic-own/properties` | `acceptReading` | a consistent mis-read of a type or a case write, which the fixed point cannot see |
| `acceptance.doctored.test.ts`, check 5: the draft's document and batch with two choices' labels swapped, consistently, passes checks 1 to 4 and answers `check: "summary"`, signature `summary/question/option/label`, the finding's copy from `CIRCUMSTANCE_COPY["read-back-differs"]` | `acceptReading` over CommCare HQ's retained summary | a consistent mis-read of text, which nothing else in production sees |
| `acceptance.doctored.test.ts`, a menu CommCare HQ could not summarize: the retained answer `reading/application-error-module.json` (part 05, run G3) with a clean draft answers `ok`, and the same input with a label of that menu's form doctored still answers `ok` | `acceptReading` | blaming Nova, or the app's reading, for a menu HQ itself cannot read |
| `acceptance.modes.test.ts`: under `pending`, a document whose only finding is `MEDIA_FORMAT_NOT_PLAYED` passes; under `files`, handed a choice that declares a platform the file does not play on, it fails `gate/export/MEDIA_FORMAT_NOT_PLAYED`; `MEDIA_FACT_CODES` equals `MEDIA_VALIDATION_CODES` less `CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE`; no arm of `exportReadinessFindings` over the corpus returns `MEDIA_EXPORT_TOO_LARGE` | `acceptReading`, `errors.ts` | a file's fact judged before the file is read, or never judged; a code the list names and the function never returns |
| `acceptance.declarations.test.ts`: a draft offering a choice the gate refuses fails check 2 though its other choices pass; a draft whose one file plays in Web Apps only, under `files` with `choices` as `narrowDeclarationsByMedia` gives them, answers `ok` with no declaration that includes Android, `preselected` on the first choice left, and `AcceptedReading.firstPublish` that choice's list; a draft with a split offered passes check 3 over D with no `chosen`, and with `chosen` naming the split runs the re-read under `matchingResolver` and passes; every choice's `firstPublish` is deeply equal between the read step's call and the creation's, the split choice's included; under K4's outcome B, the two forms of check 2 give one verdict over the corpus | `acceptReading`, part 11's narrowing, `lib/doc/datetimeSplit.ts` | a birth that applies a choice nobody checked; an app with a Web-Apps-only file refused as Nova's mistake; a list that changes between the review and the creation; a split whose questions get new uuids on the re-read |
| `acceptance.doctored.test.ts`, the carrier rules: a draft doctored to hold a `fixed-location` owner answers `check: "gate"` with `gate/export/LOCATION_OWNER_EXPORT_NOT_ACTIVE`; one whose select reads a table whose `lookup` rows hold a value twice answers `gate/export/LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE`; `lib/export/__tests__/boundaryValidation.test.ts` passes unchanged over the moved functions | `acceptReading` over `exportCarrierFindings` | an app that is born and then refused by its first publish |
| `acceptance.purity.test.ts`: two calls with equal input give deeply equal answers; the module graph of `acceptance.ts` holds no `reader/canon.ts`, no logger and no database module (it reaches `lib/export/boundaryFindings.ts` and never `boundaryValidation.ts`, and takes `DeploymentTargetKey` as a type alone) | the module graph and the function | acceptance forgiving a canon pair; a clock or a store read in a worker |
| `emission.parity.test.ts`: over every retained reading, `readingEmission`'s options equal `readProjectionInputs(ctx)`'s (part 07) and the two emissions are byte-equal; no re-read raises a finding under `application-and-settings/34p-hq-build-spec-below-nova-s-floor`; a reading with a Web Apps logo reads back with it; `sourceFromEmission`'s answer has every member of `HqAppSource` | the two builders of one projection, and the wrapped source | the reader's own comparisons and acceptance's disagreeing on an id, an address, a table name or a path; a re-read that refuses every app for a key Nova never writes |
| `emission.assets.test.ts`: over the media corpus, `expandDoc` under `emissionAssets` with the files' own facts and under its `pending` placeholders is byte-equal; every asset id a reference names is in the map | `emissionAssets` against the emitter | a placeholder reaching a byte a check compares; a thrown missing-asset error in a read step |
| `identityAgreement.test.ts`: an appearance in `inertAppearances` is cut from A and the pair compares equal; the same path with an appearance still in E is `identity/appearance/inert-kept`; a listed path that is no control of A is `identity/appearance/phantom`; a group whose `<label>` stands on one side alone compares equal; a draft doctored to hold an operation whose guard the source lacks is `identity/case-blocks/save-to-case/added`, and with that row disabled `identity/generated/guard`; `field-list` in another case compares equal | `identityDifferences` over hand-written pairs | a correct reading of an inert appearance or a blank group label failed as Nova's mistake; a guard declared as a hidden value |
| `generatedNodes.parity.test.ts`: over every retained read and the fuzz corpora, the reader's `generated` list for Nova's emission of a document equals `emittedGeneratedNodes` of it as sets of `(purpose, owner, name, path)`; `generatedDifference` pairs two counts of one question in name order and reports a moved suffix as `renamed` | the reader's list against the emitter's plan | the register taking a rename for a new node, which would tell a person their case names are newly checked |
| `lib/commcare/hq/__tests__/sourceIdentity.test.ts`: leaves, repeats, containers, choices and order over hand-written forms (a nested repeat, a ref-less wrapper group, a count placement's wrapper, an upload, a select with an itemset, a Save to Case block, a relative `ref`); `written` for an inline label, an itext label, a repeat whose wrapping group holds the label, an item with and without a `ref`, a bind typed `xsd:integer`, and an appearance kept as spelled; each unread reason by its own source | `sourceIdentity` over XML | an extraction that misses a level or a control, which would make check 4 pass over the bug it is for; check 5 asking HQ's lookup another question than HQ asked |
| `sourceIdentity.independence.test.ts`: the import graph of `hq/sourceIdentity.ts` and `hq/hqQuestionTypes.ts` reaches nothing under `lib/commcare/reader` | the module graph | check 4 sharing a classification with the reader |
| `sourceIdentity.corpus.test.ts`: over the fuzz corpora, `sourceIdentity(expandDoc(D))` has no `unread`, its leaves less `generatedNodePaths` are exactly the document's fields at `collectFieldLocations`' paths, and each leaf's `typeClass` is `coreTypeClass` of `fieldBindType` | the emitter against the extraction | the two drifting apart, so that every reading fails check 4 |
| `generatedNodePaths.test.ts`: over the fuzz corpora, every path of `generatedNodePaths(doc, form)` is an element of the emitted form's data tree and every `nova_` leaf of that tree outside a case block is a path of it | the emitter | a generated node cut from neither side, reported as an added answer |
| `hqQuestionTypes.test.ts`: `exactHqTypeRow` against `proof/hq-reads/reading/question-type-rows.json` (run K2); null for an `<input>` bound `xsd:decimal`, for an `upload` with no bind type, and for a tag HQ does not know; `HQ_TYPE_OF_KIND` total over `fieldKinds` | the port against HQ's retained answers | a type compared on HQ's guess, which would fail a correct reading |
| `summaryAgreement.test.ts`: `documentSummary` over a document with a count-placement query repeat gives a `Group` and a `Repeat` row at the paths HQ's retained summary of Nova's own emission of it holds; the whitespace normalization on a label with a whitespace-only run between two outputs; a label HQ sends in no second language agrees where the document's text there is its first language's, with and without a counted blank; a label with no `ref`, and an item with none, is skipped; a registration's name question with no validation agrees, a source that holds Nova's conjoined check alone agrees, and a document holding a validation the source lacks is `summary/question/constraint`; a Hidden Value in a section that holds only Hidden Values has the group outside it on both sides, and one beside a visible question has the section; a menu that is `not-summarized` fails neither the rows nor the ids; a `DataBindOnly` row under a Save to Case block is explained and one beside it is not | `summaryDifferences` over retained summaries | a path rule of this part's own drifting from the emitter's; a correct reading failed for text or a validation CommCare HQ never reported |
| `signature.test.ts`: the content-free property of 14.2; every signature at most 80 characters, cut at a segment, and beginning with a member of `ACCEPTANCE_CHECKS`; `documentDifferences` reports a changed value as `value`, a path only the first document holds as `missing` and one only the second holds as `added` | `differenceSignature`, `documentDifferences` | an app's words in a log line or a Sentry issue title; a signature under a check that does not exist |
| `readBack.test.ts`: a change planted inside each kind `KINDS_WITH_NO_EXTERNAL_KEY` names gives no difference, and one in any other entity map gives one; with `choices`, `expected`'s `runsOnlyOn` is left out and a declaration no choice offers gives one difference at `appSettings/runsOnlyOn`; with `choices: null` the two declarations are compared in place; the module graph of `readBack.ts` holds no `reader/canon.ts` | `readBackDifferences` | K1 and proof 6 making two comparisons of one claim; a kind compared by nothing |
| `lib/commcare/reader/__tests__/canon.test.ts`: one case per row of section 9, both documents printed and compared byte for byte, the local archive too where the app declares Android; `canonDocument` idempotent; `canonDocument(read(A)) = read(A)` over retained reads | the production emitter | a canonicalization that hides a difference a runtime reads |
| `lib/deployment/reading/__tests__/canonReadBack.fuzz.test.ts` (run K1): over the fuzz corpora, `readBackDifferences(canonDocument(D), read(expandDoc(D)))` is empty. The read is made as part 14's read back is (its section 5.2, step 4): under `matchingResolver(D.appId, externalIdentityMap(D, identity))`, so D's own uuids come back, with the rest of the reader's input the document's own; the comparison takes the draft's `doc` and `declaration.choices` | the reader over Nova's own emission, through the one comparison | a pair the list lacks |
| `lib/commcare/__tests__/emissionRewrites.sites.test.ts` and `emissionRewrites.test.ts` | section 10.3 | a registered rewrite no site makes; a behavior change nothing accounts for |
| `lib/commcare/xform/__tests__/withheldCount.test.ts`: a validation holding `count(/data/r/item[. = 'x']) > 0` printed with `validation-count-lifted` withheld holds the count inline and no `nova_constraint_` node, and prints it lifted otherwise | `buildXFormSource` | a validation made in CommCare HQ that part 08 can never see equal |
| `lib/deployment/reading/__tests__/firstPublishChanges.test.ts`: for every entry, a `FirstPublishFacts` on which it applies and one on which it does not, each built from a retained read or a production builder; `GENERATED_NODE_CHANGE` total; every `sameStateRewrites` record of every retained read names an entry whose `paths` cover it; `FIRST_PUBLISH_TOUCHES_WORKERS` equals the register; `touchesWorkers` implies `behavior: "changes"`; `MEDIA_REFERENCE_PATHS` equals part 11's slots; exactly rows 25 and 26 have `scope: "declaration"` and exactly row 27 `birth`; for every choice of every retained reading, the choice's list equals `firstPublishViewFromStored` of what the birth stores for it under that choice's `runsOnlyOn`, and under the other declarations it gains or loses only the two Web Apps ids; row 34 applies to a source with a map entry no reference and no kept logo entry names, and not to one whose only extra entry a logo names | the register over readings | an entry that never applies, or applies to every app; a same-state rule with no declaration; a stored list that tells a person Web Apps is turned off after they turned it on |
| `lib/publish/__tests__/firstPublishCopy.test.ts`: every sentence is non-empty, ends in a full stop, holds no em dash and no ellipsis; `firstPublishLines` puts each line in the group `FIRST_PUBLISH_TOUCHES_WORKERS` gives it, in registry order, gives the reassurance exactly where `touchesWorkers` is false, the review's lead for `review` and the publish's for `publish`, and the note always; the file exports no `REWRITE_SENTENCES` | the copy | a line with no words; a list ordered by accident; a worker-touching first publish told workers see the same questions |
| `proof/ci/__tests__/firstPublishChanges.test.ts` (new, B7): the file's ids are `FIRST_PUBLISH_CHANGE_IDS` in order; each object's `source` rows are exactly the entry's `paths` (entry 1's three written pointers; its inert allowance has no row); a `proof3` row stands only under an entry whose `behavior` is `changes`; `bases` is sorted and unique | `proof/first-publish-changes.json` against the register (section 13.3) | the lane accepting a stored-app difference the register does not allow, or a behavior difference under an entry that declares none |
| `lib/commcare/__tests__/appStrings.test.ts`: `localAppStringTable(doc)` equals, language by language, the tables `compileLocalArchive` serializes for the same document, over the corpus, a document that reads a lookup table among them; the tables are equal under two stand-in targets and under the identity and a real naming; a document whose app string holds a literal backslash-`n` gives its table and does not throw, where `compileCcz` throws; `compileCcz`'s bytes are those of `main` for every corpus document | the split of `compileCcz` | a classifier judging keys against strings no build makes; a reading that throws on a string the archive cannot carry; a changed archive |
| `lib/deployment/reading/__tests__/acceptance.scale.test.ts` (run K4; by hand on a hosted runner through `reader-scale.yml`, in the `scale` project no default run includes) | `acceptReading` whole at Nova's ceiling | a reading that reads clean and then runs out of its step |
| `adoptionBoundary.test.ts`: over a retained reading with a table and two files, `expandDoc` under `adoptionExportBoundary`'s options is byte-equal to `expandDoc` under the options a publish to the adopted deployment builds after the birth | the boundary against `prepareExportBoundary` | a baseline descriptor computed over a body the first publish does not send |
| `datetimeSplitReadBack.test.ts`: for every corpus document that holds a date and time question, the split document's emission reads back to the split document under `matchingResolver` | the reader over `lib/doc/datetimeSplit.ts`'s result | an offered split that fails at creation |
| `lib/deployment/__tests__/firstPublishBaseline.postgres.test.ts` (real Postgres; B7): an adopted baseline written with a list is read back by `readFirstPublishStates` for a viewer, and a non-member is refused; a push baseline over it leaves the column null in the one upsert and the CHECK holds; a direct `UPDATE` setting a list beside an origin other than `read` is refused by the CHECK; `recordRefreshedAppBaseline` over a read baseline keeps the list; a write the upsert's `WHERE` turns away changes nothing; a stored id outside the registry is dropped and the rest kept; a stored value of another shape reads as no list and is logged; an ended deployment's `DeploymentView.firstPublish` is null; the read selects no `source_gzip` (the query log shows none) | `recordAdoptedDeploymentInTransaction`, `writeAppBaseline`'s two arms, `readFirstPublishStates` and `readDeploymentsAction`, in one database | a list that outlives the baseline it describes, or is lost before the first publish; a push that fails the CHECK; a viewer's Publishing card that throws |
| `lib/case-store/migrations/__tests__/hqBringInLedger.postgres.test.ts` (part 10's, B8; the CHECK's case added there): after `up`, `app_deployment_baselines.first_publish_changes` exists and is nullable, a `read` row may hold a list, and a row of any other origin may not | the migration | the column missing where the birth writes it; a list beside a baseline that is no reading |

---

## Contracts and docs these changes make false

| Where | Old sentence | Replacement | Pull request |
|---|---|---|---|
| `lib/commcare/expander.ts`, `ExpandOptions`'s doc comment | (no `rewrites` member) | "`rewrites`: the rewrites of `lib/commcare/emissionRewrites.ts` a print leaves out, and a callback for each site it reaches. Only the reader of CommCare HQ's apps and its acceptance pass it. Absent, every print is as described here." | B7 |
| `lib/commcare/CLAUDE.md`, new subsection after "The surface manifest" | (none) | "**Rewrites.** Wherever the emitter writes something other than what the document spells (a check it conjoins, a value it routes through a sibling, a setting it fixes), the site reports an id of `emissionRewrites.ts::EMISSION_REWRITES` through `ExpandOptions.rewrites`. The registry says whether the rewrite changes behavior and what accounts for it on an app brought in from CommCare HQ: a first-publish change, or the manifest entry that refuses such an app. A new rewrite lands with its id, its exhibit in `emissionRewrites.sites.test.ts` and its entry in `lib/deployment/reading/firstPublishChanges.ts`." | B7 |
| `lib/commcare/hq/publishedCaseBlocks.ts`, header | "The reader returns only what it read; the caller counts what it left out." | part 07's replacement stands (B4); B7 adds: "Acceptance of a reading is its caller (`lib/deployment/reading/identityAgreement.ts`), and fails a reading for any form listed in `unread`." | B7 |
| `lib/commcare/compiler.ts`, `compileCcz`'s doc comment | (describes one function) | adds: "`compileCczParts` is the same walk up to each language's app-string table and before any is serialized, and `lib/commcare/appStrings.ts::localAppStringTable` reads a document's app strings from it." | B7 |
| `biome.json`, the four messages that list the allowed consumers of `@/lib/commcare` | (each names `lib/export/boundaryValidation` and no `lib/export/boundaryFindings`) | each gains "lib/export/boundaryFindings, " before "lib/export/boundaryValidation", and both overrides' `includes` gain `"!lib/export/boundaryFindings.ts"` (section 4) | B7 |
| `biome.json`, the first sentence of the same four messages | each opens "lib/commcare is the one-way CommCare emission boundary." | each opens "lib/commcare is the CommCare boundary, the one package that speaks CommCare's wire vocabulary." The package reads as well as writes from B2 (part 06, section 2.4), and B7 is the pull request that edits these four strings, so the sentence is rewritten here (part 15, section 6.5) | B7 |
| `lib/export/CLAUDE.md`, the first paragraph | "`lib/export/boundaryValidation.ts` is the one server-only preparation seam for every artifact and direct-HQ export." | adds: "Its row and mode findings (the lookup carrier's, the fixed-place owner's and the two nested selections') are computed by the pure `boundaryFindings.ts::exportCarrierFindings`, which the seam calls and which acceptance of an app brought in from CommCare HQ calls for the first publish it will make." | B7 |
| `lib/deployment/CLAUDE.md`, new subsection "Accepting a reading" | (none) | "`reading/acceptance.ts::acceptReading` is the one judge of a reading: complete accounting, the gate and the export readiness of a first publish under every declaration the review will offer, the exact fixed point over Nova's own emission, identity agreement between CommCare HQ's source and that emission, and agreement with CommCare HQ's own question summary. It is pure and runs in the reading's worker. A failure after a clean read is `read-back-differs`, Nova's own. It reads no expression's meaning: the reader's re-emission comparisons and the proof lane hold that. `reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES` is the closed list of what a first publish over an adopted app may change; what a person reviewed is kept on the read baseline and ends with the first push. `reading/readBack.ts::readBackDifferences` is the one comparison of a document with its read back, made by tests and the proof lane and never by acceptance." | B7 |
| `lib/deployment/CLAUDE.md`, "Baselines" | the sentence that lists what a baseline row holds | adds: "A baseline of origin `read` also holds `first_publish_changes`: the first-publish changes the person reviewed that do not depend on where the app runs, and the Web App setting CommCare HQ held. Every other baseline holds none, and the one upsert clears it when a push replaces a read. `store.ts::readFirstPublishStates` returns it to a viewer and never the source, and `resources.ts::firstPublishOf` is the one rule that turns it into the list a surface shows." | B7 |
| `lib/db/CLAUDE.md`, the `app_deployment_baselines` row | its column list | adds `first_publish_changes`: "set only beside origin `read`, held so by a CHECK" | B8 |
| `docs/architecture/contracts.md`, "HQ deployment safety" | (no sentence on a first publish over an adopted app) | "The first publish over an app brought in from CommCare HQ changes only what `FIRST_PUBLISH_CHANGES` declares, each entry shown to the person at the review and again before that publish. The proof lane holds the declared set equal to the observed set on every HQ-authored base." | B14 (part 15 lands it) |
| `proof/README.md`, new section "First-publish changes" after "Identity moves" | (none) | part 14 writes it from its own section 9, with the `source` check of section 13.3 here | B13 |
| `content/docs/publishing.mdx`, "On CommCare HQ", after part 13's sentence for a brought-in app (its 17.2) | (none) | one paragraph: "The first time you publish an app you brought in, Nova lists what will differ in CommCare HQ: what workers will notice, and what changes only in how CommCare HQ stores the app. The same list is shown before you bring the app in." | B14 |

---

## Departures

Departures from the outline, the research and the manifest, and the alternatives this part weighed
and did not take. Each states the decision and its evidence; a "Not done" names the alternative an
implementer could reach for, and why it is not built. Each keeps its number, which other parts cite.

1. **Every failing check is `read-back-differs`, not checks 3 to 5 alone.** A failure of check 2, and
   a `ReaderDefect` beside a clean read, are `read-back-differs` too. Evidence: the two other
   candidates say something false. `unrecognized`'s block says Nova met something it has no reading
   for, and `could-not-create`'s (part 12) says every check passed. The same holds for the other
   failures of check 1 (a census that disagrees, a hand-off settled twice, a settlement no hand-off
   matches): each contradicts a contract of Nova's own. The one exception stays as part 06 decided:
   an unsettled hand-off is `unrecognized`. The block's body is true of all five (Copy, C3; part 01,
   section 9.3).
2. **The types acceptance is called with are section 2.2's, each member one a check needs and
   cannot derive.** The failing arm's `check` is one of five and never null, so part 12's log line
   is total; the `ok` arm holds `declarations`, each with its own first-publish list; the input
   holds `target`, `choices`, `settlements`, `lookup`, `mediaLeftOut`, `media.rows` and `chosen`,
   and holds no `projectData` of part 12's type. Not done: a failing arm whose `check` is one of
   three or null, an `ok` arm of two members, or an input typed with part 12's gathered project
   data, because every type has to be one B7 can name from beneath B10. Part 12 calls these types
   as section 2.2 writes them (its section 3.3, step 7.4).
3. **One re-read a call**: D in a read step, the chosen declaration's document at creation
   (section 5.4). Not done: the fixed point over D and over each split document in every call.
   Evidence: part 06's R2 allows a reader run twenty seconds at Nova's ceiling and part
   12's budget for the reader and acceptance together is sixty, so a reading, a re-read and a second
   re-read with the gates do not fit. What is left unheld at the review is stated there and held by
   `datetimeSplitReadBack.test.ts` and proof 6. Whether even one re-read fits is run K4's to show.
4. **Three rewrite sites an implementer could expect to be declared are not, and a fourth
   candidate is no rewrite site.** The required stamp changes no behavior (HQ's build writes it),
   so it is registered with `behavior: "none"`. Date and time formatting is not declared but
   refused, by part 07, because a source made in CommCare HQ stores the day alone. Markdown forms
   get no entry (part 03, 03-questions-and-text.md, Departure 8). And "new export columns" is no
   rewrite site: it is the generated-node entry `hidden-values-added`.
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
   observed. The two are tied by the ids and by the file's one Vitest (section 13.3). The lane
   file keeps the shape part 14 writes; this part writes its one Vitest.
9. **The canon registry and the read-back comparison are planned here and land in B7, not with
   proof 6 in B13.** The typed registry and its byte-equality tests land in B7 because the
   acceptance tests, the reader's own fuzz run and `canon.test.ts` need them three pull requests
   beneath B13. Part 14 runs `canonDocument` in proof 6 and adds the rows its lane runs find. The
   read-back comparison lands here for the same reason (`readBack.ts`, section 9.1): run K1 and
   proof 6 state one claim, so one function makes it.
10. **One nullable column**, `app_deployment_baselines.first_publish_changes`. The first publish
    states what it changes (section 12.2), and part 12 clears the reading when the app is born, so
    the list needs a home. It is no document migration, no backfill and no scan. It is the only
    home: the reading's row holds no copy of the list, and part 13 adds no column (section 12.3).
11. **Six entries no part handed on**, each found at source:
    `forms-and-settings-rewritten`, `hidden-values-added`, `blank-translations-filled`,
    `web-apps-turned-off`, `web-apps-turned-on` and `date-and-time-questions-split`; and
    `unused-media-entries-removed` reworded, since HQ's build and its multimedia page run the same
    prune.
12. **The outline.** Item 1's "passes the absolute gate, or refuses with the place and
    the reason" is check 2 and section 14. Item 9's "this step's plan decides how the reader recognizes
    [the split's] result on a later read" is part 06's section 16.4 with section 5.4 here. Item 10's
    "matches an imported form's case transactions to placements through `publishedCaseBlocks`" is part
    07's readers with check 4 as their independent hold. Item 7 (feature-matrix apps) is part 14's.
    Items 2 to 6 and 8 are other parts', each named there. The outline's cutover and its Contracts rows
    are parts 10, 11 and 15's.
13. **No departure on migration or versions.** No stored document changes shape, and neither
    `MODEL_CONTEXT_VERSION` nor `RUNTIME_VERSION` moves in B7.
14. **B7 sits above B9 and below B10, not beneath B8 as its number suggests.** Its id and its
    contents are unchanged by where it sits. Evidence: acceptance calls `lib/deployment/adoption.ts`
    (`assignMediaPaths`, `adoptedIdentityRows`, `AdoptedMediaFile`, `MediaPathAssignment`) and
    `lib/commcare/reader/identityMap.ts` (`externalIdentityMap`), which part 10 lands in B8, and part
    11's `HqMediaPlan`, `narrowDeclarationsByMedia`, settlements and lookup snapshot, which land in
    B9. Beneath B8 none of those exists to import, and B8 would have needed B7's
    `FirstPublishView` for the baseline's writer: a cycle. Above B9 there is none. Nothing of B8 or
    B9 imports a symbol of B7: the column's DDL stays in B8's migration with no code
    over it, and every reader and writer of the column is B7's. B10 already sits above all three
    (part 12, 12-the-reading-and-the-birth.md, "Files by pull request"). A pull request's id is a
    name that parts assign files by and no order, and the stack merges as one deploy, so no person
    meets the order.
15. **Three keys are handed to the re-read at the source's values and not at their schema
    defaults**: `build_spec`, `multimedia_map` and `logo_refs` (section 5.1). Evidence: Nova's body
    never carries them (`hqShells.ts::applicationShell`), CommCare HQ keeps each through an update
    (`_merge_source_into_app`), and the reader refuses the default `build_spec` (`{ version: null }`)
    under the `34p` entry and reads the logo from `logo_refs`, so at their defaults no app would pass.
    Every other absent key reads as CommCare HQ's schema default.
16. **The narrowing by files happens before acceptance**, and acceptance judges exactly the choices
    the review offers (section 4); part 12's `gather.ts` filters none (its section 5.1). Not done:
    narrowing the choices after acceptance. Evidence:
    `validator/rules/media/mediaFormatPlays.ts` refuses a file's format per declared platform, so with
    the files' rows check 2 would fail a choice that was about to be dropped, and a correct reading
    of an app with a Web-Apps-only file would end as Nova's mistake.
17. **Check 2 runs a first publish's row and mode findings** through `exportCarrierFindings`, moved
    out of `boundaryValidation.ts` unchanged. Not done: acceptance over `exportReadinessFindings`
    alone. Evidence: `exportReadinessFindings` is `evaluateBoundary` alone, and part 12 relies on
    acceptance for a rule that only the boundary's private functions hold (its section 6.2).
18. **`REWRITE_SENTENCES` lives from B6 to B7 only.** B7 deletes the record and moves its seven
    sentences (C1 to C6b; C5 lands only on E4's outcome B) into `FIRST_PUBLISH_SENTENCES` (section
    10.2; part 08, section 2.3). Not done: B7 adding the register's other copy to
    `REWRITE_SENTENCES`. Evidence: B7's rewrites that change behavior are declared under register
    ids of other names, so a record keyed by rewrite id would hold each register sentence twice or
    break part 08's own test.
19. **Check 4 maps a generated sibling to its owner by each side's own list**, `GA` and `GE`
    (section 6.4, step 1), and imports no reader module. Not done: comparing through part 07's
    `caseManagement/basicActions.ts::ownerQuestionPath` (its section 6.1). Evidence: the comparison
    is evidence only while it shares no classification with the reader
    (`sourceIdentity.independence.test.ts`); `ownerQuestionPath` is the reader's.
20. **One renderer, one copy and one stored list, all here** (sections 12.2 and 12.3). Not done: a
    renderer, a copy or a stored list of part 13's own. Evidence: a list stored from the review's
    preselected choice is wrong whenever the person chose another declaration, and two strings
    would have shared one constant name. Part 13 draws `firstPublishLines` and reads
    `DeploymentView.firstPublish` (its sections 8.8 and 11.2); where the list sits over MCP is its
    own Departure 14.
21. **From the manifest entry
    `questions/an-explicitly-blank-value-in-a-non-default-language-where-the` (REFUSED, not
    HQ-editable).** Decision 20 reads such a blank as no translation and declares the fill, where the
    manifest refuses it today. Evidence: the entry's own reason is that CommCare HQ's form builder fills
    a blank translation from the default language on every save, and
    `lib/domain/translationFill.ts::filledProse` is that same fill. The step the refusal would send a
    person to (open and save each form in the form builder) writes exactly what Nova's first publish
    writes, so declaring it asks nothing of the person and changes nothing more. B3 re-cuts the entry to
    HELD with its inventory row (part 06, section 12.2). The departure covers exactly a language other
    than the first whose first-language text is not blank. A blank in the first language where another
    language holds text stays refused: the form builder fills that one from whichever language holds text
    (Vellum `javaRosa/itext.js::ItextForm.getValueOrDefault`), so it is another shape with its own entry,
    `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text` (B3).

---

## Files by pull request

**B7, new.**

- `lib/deployment/reading/acceptance.ts`, `emission.ts`, `fixedPoint.ts`, `identityAgreement.ts`,
  `summaryAgreement.ts`, `signature.ts`, `readBack.ts`, `firstPublishChanges.ts`,
  `adoptionBoundary.ts`, and `__tests__/acceptance.accepts.test.ts`, `acceptance.doctored.test.ts`,
  `acceptance.modes.test.ts`, `acceptance.declarations.test.ts`, `acceptance.purity.test.ts`,
  `acceptance.scale.test.ts` (run K4), `emission.parity.test.ts`, `emission.assets.test.ts`,
  `identityAgreement.test.ts`, `generatedNodes.parity.test.ts`, `summaryAgreement.test.ts`,
  `signature.test.ts`, `readBack.test.ts`, `canonReadBack.fuzz.test.ts` (run K1),
  `firstPublishChanges.test.ts`, `adoptionBoundary.test.ts`, `datetimeSplitReadBack.test.ts`.
- `lib/export/boundaryFindings.ts` (`exportCarrierFindings`, with `lookupExportFindings`,
  `organizationExportFindings` and `LookupRowVerdictInput` moved from `boundaryValidation.ts`).
- `lib/deployment/__tests__/firstPublishBaseline.postgres.test.ts`.
- `lib/commcare/hq/sourceIdentity.ts`, `hqQuestionTypes.ts`, and `__tests__/sourceIdentity.test.ts`,
  `sourceIdentity.independence.test.ts`, `sourceIdentity.corpus.test.ts`, `hqQuestionTypes.test.ts`.
- `lib/commcare/reader/canon.ts`, `__tests__/canon.test.ts`.
- `lib/commcare/appStrings.ts`, `__tests__/appStrings.test.ts`.
- `lib/commcare/__tests__/emissionRewrites.sites.test.ts`, `emissionRewrites.test.ts`,
  `lib/commcare/xform/__tests__/withheldCount.test.ts`, `generatedNodePaths.test.ts`.
- `lib/publish/firstPublishChangeIds.ts`, `__tests__/firstPublishCopy.test.ts`.
- `proof/hq/test_question_type_rows.py`, `proof/hq-reads/reading/question-type-rows.json` (run K2).
- `proof/ci/__tests__/firstPublishChanges.test.ts` (the lane file's one Vitest, section 13.3).

**B7, changed.**

- `lib/commcare/emissionRewrites.ts`, `lib/publish/emissionRewriteIds.ts`,
  `lib/publish/firstPublishCopy.ts` (`REWRITE_SENTENCES` removed; section 10, Copy).
- `lib/export/boundaryValidation.ts` (calls `exportCarrierFindings`; answers unchanged),
  `lib/export/CLAUDE.md`.
- `biome.json`: in both overrides that list `"!lib/export/boundaryValidation.ts"`, `includes` gains
  `"!lib/export/boundaryFindings.ts"` before it, and each of the four message strings gains
  "lib/export/boundaryFindings, " before "lib/export/boundaryValidation" (section 4) and opens
  "lib/commcare is the CommCare boundary, the one package that speaks CommCare's wire vocabulary."
  in place of "lib/commcare is the one-way CommCare emission boundary." ("Contracts").
- `lib/deployment/types.ts` (`AppBaselineWrite.firstPublish`), `store.ts` (`writeAppBaseline`'s
  insert list and conflict arm; `readFirstPublishStates`), `adoption.ts`
  (`adoptedAppBaselineWrite`'s `firstPublish`), `service.ts` (`appBaselineFor` passes null),
  `resources.ts` (`firstPublishOf`), `actions.ts` (`DeploymentView.firstPublish`, filled through
  `firstPublishOf` by every maker of the view), `index.ts`.
- `proof/first-publish-changes.json` (completed, 13.1) and `proof/checks/changes.py`
  (`CANDIDATE_IDS` deleted).
- `proof/corpus/publish.ts`: its `hqAuthoredA` arm's `adoptedAppBaselineWrite` call passes
  `firstPublish: { ids: [], touchesWorkers: false }`. No lane check reads the stored list, and a
  base's predicted ids reach the lane through `first-publish.json`.
- `lib/commcare/expander.ts` (`ExpandOptions.rewrites`, threaded; the two shell rewrites reported).
- `lib/commcare/xform/builder.ts` (`BuildXFormOptions.rewrites`; `reached` at the sites of 10.2;
  `buildLabelNodes` exported), `xform/constraintCollections.ts` (the withheld plan),
  `xform/constraintMessage.ts`, `xform/datetimeCaseValue.ts`, `xform/generatedNodes.ts`
  (`generatedNodePaths`), `casePlacementPlan.ts` (`PlanFormCaseWireOptions.rewrites`).
- `lib/commcare/compiler.ts` (`compileCczParts`).
- `lib/commcare/hq/publishedCaseBlocks.ts` (its header's sentence).
- `lib/commcare/CLAUDE.md`, `lib/deployment/CLAUDE.md` (the rows of "Contracts and docs").

**B7, removed.** `lib/publish/firstPublishCopy.ts::REWRITE_SENTENCES` and its test,
`lib/commcare/__tests__/rewriteSentences.test.ts` (B6's; section 10.2, Departure 18);
`proof/checks/changes.py::CANDIDATE_IDS`. Moved, bodies unchanged: `lookupExportFindings`,
`organizationExportFindings` and `LookupRowVerdictInput` from `boundaryValidation.ts` to
`boundaryFindings.ts` (section 4), and `compileCcz`'s walk into `compileCczParts` (section 15.1).

**B8 (part 10's pull request), this part's lines.** The three clauses of 12.3 in statement 10 of
`20261201000000_hq_bring_in_ledger`; the column in `lib/db/pg.ts::AppDatabase`, typed as 12.3 gives
it; the CHECK's case in `hqBringInLedger.postgres.test.ts`; the `lib/db/CLAUDE.md` row. No
TypeScript of B8 reads or writes the column.

**B9 (part 11's pull request), this part's lines.** `projectData/settlements.ts`
(`HandOffSettlement`, `handOffSettlements`); `projectData/lookupTables.ts::readingLookupSnapshot`;
`projectData/media.ts::readingMediaRows`; the finding `table-choices-unusable` (each under "What
this part needs of other parts").

**B10 (part 12's pull request), this part's lines.** `runReadingCheck` builds `AcceptReadingInput` as
section 2.2 types it (`target`, `choices` narrowed under `files`, `lookup`) and passes `chosen` at
creation; `ReadingReview.runsOn` is built from `AcceptedReading.declarations`, each with its
`firstPublish`; the adopted baseline is written with the chosen declaration's list;
`adoptionExportBoundary` is called with `lookup.definitions`.

**B11 and B12 (part 13's pull requests).** The review and the publish dialog draw
`firstPublishLines` (B11); MCP returns it as `first_publish` on each `review.runs_on` entry of
`read_hq_app` and on `check_project_space_compatibility`, which calls `readFirstPublishStates` and
`firstPublishOf` (B12). Neither pull request adds a column, a migration or a first-publish string.

**A1, B13 and B14.** The lane file's shape and loader from A1, the `source` check, the judge, the
rows and `bases` run K3 fills, and `proof/README.md`'s section in B13 (part 14); the `contracts.md`
and `publishing.mdx` rows in B14 (part 15).

---

## What this part needs of other parts

- **Part 01 (01-the-bar-and-the-manifest.md, A2).** Each of these it holds as written.
  `CIRCUMSTANCE_COPY["read-back-differs"]`'s body is Copy C3 (its section 9.3). `findingLine` answers
  `named: null` for `read-back-differs` (its `detail.name` is the check, Nova's own word; the same
  holds for `could-not-create` and `too-large`, whose names part 12 fills with Nova's words; its
  section 9.2). Section 8.3's row for `read-back-differs` reads "acceptance failed after a clean
  read" with `name` one of `accounting`, `gate`, `fixed-point`, `identity`, `summary`, `reader`. The
  manifest entry `forms-and-case-writes/a-datetime-question-saved-straight-to-a-case` has the
  standing `not-yet` from A2 (its Appendix A.1, subject `writer-types`), which section 10.3's test of
  `refusedBy` reads.
- **Part 05 (05-reading-commcare-hq.md, B1).** `HqAppSource`, `HqAppSourceForm`, `HqAlignedModule` and
  `HqQuestionSummary` as its sections 6 to 8 write them. Its retained readings under
  `proof/hq-reads/reading/` are readable by `retainedReadingRead`, and G3's file
  `application-error-module.json` exists.
- **Part 06 (06-the-reader-forms.md, B2 and B3).**
  - `readHqApp` reads nothing of `HqAlignedForm.questions`, so a re-read may pass an empty list.
  - A declared key absent from an object reads as `schemaPropertyDefault`'s default and is no use
    (its section 4.3). The re-read's source never holds a null `multimediaMap`: it holds the
    reading's own (section 5.1).
  - `ReadGeneratedNode` gains `path: string`, the node's absolute data path, beside `owner` and
    `name`. `owner` is one key by one rule, which `generatedNodes.parity.test.ts` holds to the
    emitter's plan: for a question's node, the owner question's data path; for an operation's node,
    the data path of the `nova_operations` scope it stands in, a `#`, and the operation's id.
  - `ReadFormFacts` gains `inertAppearances: readonly string[]`: the data path of every control,
    leaf or container, whose `appearance` `classifyAppearance` accounted under an entry of standing
    `inert` (its section 9.2), in body order. Check 4 cuts exactly these from CommCare HQ's side
    (section 6.3).
  - `ReadFormFacts` gains `caseRegionPaths: readonly string[]` (the data path of every case region
    container and every Save to Case block of the form) and `blankTranslations: number` (the itext
    values blank in a language whose first-language text is not blank, each read as no translation).
    `translationEntryFor` gives no entry for such a blank target. Under this part's decision 20
    (Departure 21) B3 re-cuts
    `questions/an-explicitly-blank-value-in-a-non-default-language-where-the` from REFUSED to HELD,
    read as no translation, with its inventory row, and counts each in `blankTranslations`.
  - `ReadFacts` gains `foldedTranslationKeys: number`, the generated translation keys
    `assembleDocument` folded.
  - Each row of `READER_CANONICAL_CHOICES` is `{ id, kind, apply }`.
  - Its run R2's source and ceiling are the input of run K4, which runs through its
    `.github/workflows/reader-scale.yml` and `scale` Vitest project (B3). Under K4's outcome C its
    stated ceiling of 150 forms is lowered in B7 to the largest of 125, 100 and 75 forms at which
    acceptance fits, as that outcome writes. Part 12's run M1 (B10) starts from that ceiling and
    may lower it again, by the same ladder, for the check's memory.
  - `builder.ts::isConsumerWhitespace` is in `xform/consumerWhitespace.ts` (its section 12.3).
  - `lib/commcare/xmlNamespaces.ts` (B2, its section 2.1) holds the namespace helpers
    `sourceIdentity` reads XML with.
- **Part 07 (07-the-reader-cases-menus-lists.md, B4 and B5).** `publishedCaseBlocks`, `hqEntryFacts`,
  `entryFactsDifference` and `menuFactsDifference` as its section 6 writes them. `ReadFacts
  .sameStateRewrites` records `{ entry, path, register }` with `register` one of rows 13 to 20 of
  section 11.2 and `path` a JSON Pointer under that row's `paths`. `readProjectionInputs(ctx)` builds
  what `readingEmission` builds (the parity test is B7's). Its five rows of part 06's
  `READER_CANONICAL_CHOICES`, each `{ id, kind, apply }`, under these ids: in B4
  `registration-form-last`, `create-name-required-is-absent` and `default-post-submit-is-absent`; in
  B5 `dormant-tile-cells` and `case-catalog-is-as-read`, the last through its
  `caseManagement/catalog.ts::catalogAsRead` (its section 7). Its finding for a date and time
  question saved straight to a case is raised under
  `forms-and-case-writes/a-datetime-question-saved-straight-to-a-case` (its section 3.2), the id
  B7's `refusedBy` names, and its findings for a visit schedule and a data registry load under the
  manifest's REFUSED rows for them. Check 4 does not compare through its `ownerQuestionPath`
  (Departure 19), and that function need not be exported for it.
- **Part 08 (08-the-reader-expressions.md, B6).** `EMISSION_REWRITES`, `EMISSION_REWRITE_IDS` and
  `RewriteControl` as its section 2.3 writes them. B6 lands `REWRITE_SENTENCES` and its test
  (`lib/commcare/__tests__/rewriteSentences.test.ts`) as its section 2.3 says; B7 deletes both and holds
  the seven sentences (C1 to C6b; C5 lands only on E4's outcome B) in `FIRST_PUBLISH_SENTENCES` (section
  10.2), as part 08 says of B7. `ReadFacts.rewrites` holds `{ id, place, key }`; its second acceptance
  level withholds every withholdable id of the registry, so `validation-count-lifted` is withheld from B7
  on with no change to B6's code; `canonicalExpression` is exported for `canon.ts`.
- **Part 10 (10-identity-and-the-ledger.md, B8).** The lines listed under "Files by pull request, B8":
  the three clauses of section 12.3 in statement 10 of its migration (its section 11), the
  `AppDatabase` column as 12.3 types it, the CHECK's case in its migration test and the
  `lib/db/CLAUDE.md` row. Its own widening of `readAppBaseline` to admit `read` (its section 6.3) is
  what lets a publish read the adopted baseline; this part adds nothing to that reader. Its
  `adoptedAppBaselineWrite` and `writeAppBaseline` are as it writes them in B8, and B7 adds the
  input `firstPublish: FirstPublishView` to the first, the member `firstPublish: StoredFirstPublish
  | null` to `AppBaselineWrite`, and the column's clause to the second. `externalIdentityMap(doc,
  identity: WireIdentity)` gives the entries `matchingResolver(appId, known)` takes (its sections
  2.3 and 2.5); acceptance's re-read of a split document at creation is one of that resolver's two
  step 6 callers, with proof 6. `KINDS_WITH_NO_EXTERNAL_KEY` (its section 2.2) is the list
  `readBackDifferences` leaves out of both documents. `deploymentEnding` and `stopPublishingAction`
  are its own (its section 8), and the second fills `DeploymentView.firstPublish` through
  `firstPublishOf`. `adoptedIdentityRows` answers `ok` or names the menu or form with no real id.
  `assignMediaPaths` is pure and total over held files.
- **Part 11 (11-project-data.md, B9).** B9 lands beneath B7, so each of these is a pure export of
  its own that acceptance imports, and none imports a type of B7:
  - `lib/deployment/reading/projectData/settlements.ts::HandOffSettlement`, the shape of section 2.2,
    and `handOffSettlements(handOffs: readonly HandOffRecord[], media: HqMediaPlan, findings:
    readonly Finding[]): readonly HandOffSettlement[]`, one pure function that gives one settlement
    per hand-off it judged, with the hand-off's own `artifact`, `where` and `key` (`inert-claim`
    where `HqMediaPlan.claims` holds the hand-off, `finding` where a finding of part 11's names it).
  - `readingLookupSnapshot(data: ReadingProjectData, reads: ReaderProjectDataReads):
    LookupFixtureDataSnapshot` (`lib/lookup/types.ts`), the generation its own
    `lookupFixtureBudgetFinding` builds fixtures from: `definitions` one per table the document
    reads, under its binding's ids (a table bound to a Project table as it stands is that table's
    own definition); `rowsByTable` each one's rows in CommCare HQ's order; `projectId` the reading's
    Project and `projectRevision` the revision its step 3 read with `getLookupFixtureData`.
  - `projectData/media.ts::readingMediaRows(plan)` gives the media rows `exportReadinessFindings`
    takes, from the held files' verdicts (`plan` its `ReadingMediaPlan`).
  - `narrowDeclarationsByMedia` answers `kind: "choices"` wherever a choice is left, with `proposed`
    the draft's proposal where it remains and else the first left in the same order (its section
    14.2), which is what `AcceptReadingInput.choices` takes.
  - A finding for a table whose rows cannot be a question's choices, raised by
    `readingProjectDataFindingsFor` (its section 14.1) from `lib/commcare/lookup/selectSourceRows.ts
    ::lookupSelectSourceRowFindings(doc, readingLookupSnapshot(data, reads))`, one per table, at `{ kind:
    "lookup-table", tag }`, so that fact of the project space's data is never worded as Nova's mistake by
    check 2. Its section 13.2 holds the row, and part 01's sections 8.3 and 9.3 the code and its block
    (landing in B9): code `table-choices-unusable`; standing `fix-in-hq`; no owner; when: a question or a
    search field of the app takes its choices from a lookup table, and that table has no rows, or a row
    whose value is blank, has white space at an end or repeats another's, or whose label is blank;
    `detail.name` `"<tag> (the field <field name>)"`; title "A lookup table's rows can't be a question's
    choices"; body "A question takes its choices from the lookup table {name} in {space}, and that table
    has no rows there, or has a row whose value is blank, starts or ends with a space or appears twice,
    or whose label is blank."; next "You can change those rows in CommCare HQ, then check again."
  - Its `table-cell-unrepresentable` is judged over `readingLookupSnapshot`, so a Project table the
    app is bound to as it stands is judged with CommCare HQ's own.
  - Of the three rules a workbook to the reading's project space holds a Project table to
    (`LOOKUP_TAG_RESERVED_BY_HQ`, `LOOKUP_CELL_TEXT_CHANGED_BY_HQ`, `LOOKUP_HQ_PUSH_TOO_LARGE`,
    section 4): a Project table that fails one of the three rules is never `same-equal`, and its
    `use-project` offer is not offered (part 11, 7.2).
  - `HqMediaPlan.inert.length` is `mediaLeftOut`. `hqMediaReferencesOf`'s slots are the pointers of
    `MEDIA_REFERENCE_PATHS`.
- **Part 12 (12-the-reading-and-the-birth.md, B10).** The lines listed under "Files by pull request,
  B10", which it writes so. Its 5.1 `runsOn` row: the choices are `AcceptedReading.declarations`,
  one `ReadingDeclarationChoice` each, in order, each with its `firstPublish`, and `gather.ts`
  filters none; the narrowing by files is done once, before acceptance, as
  `AcceptReadingInput.choices`. Its 3.3, step 7.4, hands acceptance `AcceptReadingInput` whole:
  `choices` (the draft's own under `pending`, else `narrowDeclarationsByMedia`'s answer, the step
  ending the reading itself where none is left), `settlements` (`handOffSettlements`), `lookup`
  (`readingLookupSnapshot`), `mediaLeftOut` (`HqMediaPlan.inert.length`), `media` (`"pending"`, or
  the files with `readingMediaRows`' rows), `chosen` at creation, and no `GatheredProjectData`. Its
  6.2 passes the chosen declaration's `AcceptedDeclaration.firstPublish` to
  `adoptedAppBaselineWrite` and calls `adoptionExportBoundary(doc, lookup.definitions, mediaFiles,
  target)`. Its log line for a failing arm is written for every `check`, with `differenceCount` and
  `signatures` in its context; `ReadingCheck` carries no `differences` (its section 3.6). Its worker
  bundle resolves `lib/commcare/compiler.ts` and `lib/export/boundaryFindings.ts`. Its reading's step
  calls `readHqApp` with claim counts (`claims: "counts"`): acceptance needs no claim log in `full`
  mode.
- **Part 13 (13-the-experience.md, B11 and B12).** One list, one renderer, one copy (sections 12.2
  and 12.3; Departure 20):
  - The list has one home (section 12.3), so B11 and B12 add no column, no migration and no
    reader of their own: the column lands in B8, and its writer, `readFirstPublishStates`,
    `firstPublishOf` and `DeploymentView.firstPublish` in B7.
  - It reads `DeploymentView.firstPublish: FirstPublishView | null` as section 12.3 fills it, and
    in the review `ReadingDeclarationChoice.firstPublish` of the choice the person has selected,
    redrawing when they select another.
  - Its `FirstPublishLines` component (props `{ view, surface }`, its section 8.8) calls
    `firstPublishLines(view, surface)` and draws `heading`, `lead`, the `workers` group where it has
    lines, `reassurance` where it is not null, the `hqOnly` group, and `note` last. It writes no
    heading, lead, label, reassurance or note of its own: C1's seven constants are the only ones.
  - B12 returns that value as `first_publish` (`heading`, `lead`, `workers: { label, lines: [{ id,
    sentence }] }`, `hq_only` likewise, `reassurance`, `note`) on each entry of `read_hq_app`'s
    `review.runs_on` (part 13, Departure 14), built with surface `review`, and on
    `check_project_space_compatibility`, built with surface `publish`, null there where
    `firstPublishOf` answers null, and holds both in `servedSchemas.test.ts`.
    `check_project_space_compatibility` calls `readFirstPublishStates(scope)` and
    `firstPublishOf(deployment, states.get(deployment.id), doc.appSettings.runsOnlyOn)` (its 14.7).
    Its tool descriptions and its plugin-skill sentence relay each `sentence` of `workers.lines`,
    then of `hq_only.lines`, then `reassurance` where it is not null, then `note`.
- **Part 14 (14-proof.md, A1 and B13).**
  - The lane file, its shape, its loader and its judge are its own (its section 9); A1 begins the
    file under this register's ids (its section 3.3). It adds the check `source` to
    `proof/checks/differences.py::CHECKS` and to its judge's observed checks, as section 13.3 writes
    it, and `eligibility.py`'s row for the source `hq-authored`.
  - The reader bundle's products per base: `firstPublish.ids` under the base's declaration, and the
    claim log in `full` mode.
  - Proof 6 calls `canonDocument` and `readBackDifferences` (`proof/reader/cli.ts` imports
    `lib/deployment/reading/readBack.ts`, its section 5.2) and writes no comparison of its own; its
    second argument is a `ReadBack`: `{ doc, choices: draft.declaration.choices }` in mode
    `read-back`, and `{ doc, choices: null }` in mode `first-read` with an `expected` document (section
    9.1). Its lane-side list of canonicalization ids is `CANONICALIZATIONS`' ids.
  - Its `proof/corpus/publish.ts` passes an empty `firstPublish` to `adoptedAppBaselineWrite` from
    B7 on (the one line under "Files by pull request").
  - Runs K2 and K3 on hosted runners, and K4 by hand through `reader-scale.yml` (its section 11.2).
  - Bases that exhibit each entry, each of which its section 9.4 places: a case name question with
    no trimmed sibling
    (`case-names-checked`, `hidden-values-added`: every starter app); a validation holding an inline
    count; a validation message that shows an answer; each of part 08's six rewrites (its own bases);
    each of part 07's eight rows (its own bases); a CommCare Connect app with Auto Capture Location off;
    a `logo_refs` entry holding only `path`; a generated translation key that folds;
    `location_fixture_restore` of `both_fixtures`; a base whose content runs on Android only while
    CommCare HQ's Web App setting is on, and one with the setting off whose declaration is both
    platforms; a base whose stated declaration takes the split; an itext value blank in a second
    language; a media base holding one file under two paths, a path CommCare HQ's upload cannot match,
    a path in Nova's derived shape that names other bytes, and two paths that differ by case; a media
    reference with no file; and a `multimedia_map` entry nothing references.
    `marked-as-updated-from-a-file` and `forms-and-settings-rewritten` show on every base that holds a
    form.
  - Value expectations for proof 3 that show each `changes` entry on its base.
- **Part 15 (15-stack-contracts-and-exit.md).** Stack B's order is B1 to B6, B8, B9, B7, B10 and on
  (Departure 14): B7 sits above B6 (it extends B6's registry and reads `ReadFacts.rewrites`), above
  B4 and B5 (it calls their readers), above B8 (it calls `adoption.ts` and `identityMap.ts` and adds
  the baseline column's writer and readers) and above B9 (it calls part 11's pure functions), and
  below B10, which calls it. No migration is B7's: the column's DDL is in B8's. B14 lands the
  `contracts.md` and `publishing.mdx` rows. The step 7 rewrite names, under `changes-made-in-hq`, that
  a later read of an adopted app compares two readings with `canonDocument` and
  `generatedDifference`.

## What other parts read from this one

- **`acceptReading`, `AcceptReadingInput` (with `target`, `choices` and `lookup`), `AcceptedReading`,
  `AcceptedDeclaration`, `ACCEPTANCE_CHECKS`, `AcceptanceCheck`, `AcceptanceDifference`,
  `MEDIA_FACT_CODES`** (`lib/deployment/reading/acceptance.ts`): part 12's `runReadingCheck`, whose
  `runsOn` is `AcceptedReading.declarations`. `HandOffSettlement` is part 11's, in the shape section
  2.2 fixes.
- **`readingEmission`, `emissionAssets`, `sourceFromEmission(emission, source)`,
  `alignedFromEmission`** (`lib/deployment/reading/emission.ts`): part 14's Vitest rung of proof 6;
  step 7's comparison of two readings.
- **`exportCarrierFindings`** (`lib/export/boundaryFindings.ts`): `boundaryValidation.ts`; part 11's
  boundary changes for a managed table land in the function it moves.
- **`sourceIdentity`, `SourceIdentity`, `FormIdentity` (with `written`), `AnswerLeaf`,
  `ContainerIdentity` (no `labelled`), `ControlAsWritten`, `coreTypeClass`,
  `CORE_BIND_TYPE_CLASSES`** (`lib/commcare/hq/sourceIdentity.ts`); **`exactHqTypeRow`,
  `HQ_TYPE_ROWS`, `HQ_TYPE_OF_KIND`** (`lib/commcare/hq/hqQuestionTypes.ts`);
  **`generatedNodePaths`** (`lib/commcare/xform/generatedNodes.ts`).
- **`CANONICALIZATIONS`, `Canonicalization`, `canonDocument`** (`lib/commcare/reader/canon.ts`): part
  14's proof 6; parts 06 and 07, whose rows of `READER_CANONICAL_CHOICES` it wraps and whose pairs
  `canon.test.ts` proves.
- **`readBackDifferences(expected, read)`, `ReadBackDifference`, `ReadBack`**
  (`lib/deployment/reading/readBack.ts`): part 14's `proof/reader/cli.ts`, for proof 6; step 7's
  comparison of two readings.
- **`EmissionRewrite.sites`, `.what`, `.withholdable`, `.declaredBy`, `ExpandOptions.rewrites`**, and
  the fifteen rewrite ids of section 10.2.
- **`FIRST_PUBLISH_CHANGE_IDS`, `FirstPublishChangeId`, `FirstPublishView`, `firstPublishViewSchema`,
  `FIRST_PUBLISH_TOUCHES_WORKERS`, `StoredFirstPublish`, `storedFirstPublishSchema`,
  `firstPublishViewFromStored`** (`lib/publish/firstPublishChangeIds.ts`); **`FIRST_PUBLISH_CHANGES`,
  `FirstPublishChange` (`scope` of `reading`, `birth` or `declaration`), `FirstPublishFacts`,
  `FirstPublishSource`, `GeneratedDifference`, `generatedDifference(before, after)`,
  `emittedGeneratedNodes`, `firstPublishChangesFor`, `GENERATED_NODE_CHANGE`,
  `MEDIA_REFERENCE_PATHS`** (`lib/deployment/reading/firstPublishChanges.ts`);
  **`FIRST_PUBLISH_SENTENCES`, `firstPublishLines(view, surface)`, `FirstPublishLines`,
  `FirstPublishLine`, `FIRST_PUBLISH_HEADING`, `FIRST_PUBLISH_LEAD_REVIEW`,
  `FIRST_PUBLISH_LEAD_PUBLISH`, `FIRST_PUBLISH_WORKERS_LABEL`, `FIRST_PUBLISH_HQ_LABEL`,
  `FIRST_PUBLISH_NO_WORKER_CHANGE`, `FIRST_PUBLISH_FORM_BUILDER_NOTE`**
  (`lib/publish/firstPublishCopy.ts`, which no longer exports `REWRITE_SENTENCES`): parts 08, 12 and
  13.
- **`app_deployment_baselines.first_publish_changes`** and its constraint
  `app_deployment_baselines_first_publish_changes_belong_to_a_read` (DDL in part 10's migration);
  **`AppBaselineWrite.firstPublish`**, `adoptedAppBaselineWrite`'s `firstPublish` input,
  **`readFirstPublishStates`** (`lib/deployment/store.ts`), **`firstPublishOf(deployment, state,
  runsOnlyOn)`** (`lib/deployment/resources.ts`) and **`DeploymentView.firstPublish:
  FirstPublishView | null`** (`lib/deployment/actions.ts`): parts 10, 12 and 13, and B12's
  `check_project_space_compatibility`. `readAppBaseline` gains nothing from this part.
- **The ids of `proof/first-publish-changes.json`** (the register's own from A1; none is renamed),
  each entry's `paths` as its `source` rows, the file's one Vitest
  `proof/ci/__tests__/firstPublishChanges.test.ts`, and the check `source` asked of the judge: part
  14, which owns the file, its shape, its loader and its judge.
- **`localAppStringTable`** (`lib/commcare/appStrings.ts`), **`compileCczParts`**,
  **`CompilePartsOptions`**, **`CczParts`** (`lib/commcare/compiler.ts`): part 12's worker; part 06's
  classifier through `ReaderInput.appStrings`.
- **`adoptionExportBoundary(doc, lookupDefinitions, mediaFiles, target)`**
  (`lib/deployment/reading/adoptionBoundary.ts`): part 12's birth.
- **`differenceSignature`, `documentPathKinds`, `documentDifferences`, `DocumentDifference`**
  (`lib/deployment/reading/signature.ts`): part 12's log; part 14 through `readBackDifferences`.
- **The circumstance `table-choices-unusable`** and its row, worded here, raised by part 11 (its
  sections 13.2 and 14.1, B9) and held in part 01's list (its sections 8.3 and 9.3): parts 01, 11,
  12 and 13.
- **The stack position of B7**, above B9 and below B10: part 15.
- **Runs K1, K2, K3 and K4**, and the outcomes of part 08's E4 and part 10's G2 as they land here.
