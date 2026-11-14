# Step 6, part 14: Proof

This part plans how the proof lane holds step 6: the sixth corpus source, the bases made in
CommCare HQ and their variants, proof 6, parity, the first-publish judge, coverage, and what the
lane costs. It replaces the outline's item 7 and its Exit. Other parts are cited as "part NN
(file), section N".

Citations are `path::symbol`: Nova at `main` `1f103305`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`.
Every CommCare fact below was read at those commits for this part. Nothing was run: no lane, no
emission, no test. Every count comes from `jq` or `python3` over committed files.

Nothing in this part reaches a served tool input, a tool description or the authoring guide, and
nothing here changes what Preview stores. So this part gives the step's one `MODEL_CONTEXT_VERSION`
move and its one `RUNTIME_VERSION` move no reason of its own.

| Section | Owns |
|---|---|
| 1 | what the lane does today, for this part's ground |
| 2 | the sixth corpus source `hq-authored`: `proof/hq-apps/`, `proof/matrix/`, how A is made in the unit, what stands where a first publish stood, the capture over an A Nova did not send, the case database seeded from A |
| 3 | the base `hq-plain` and its hand-written document |
| 4 | which proofs run on the A to B hop, and what each needs changed |
| 5 | proof 6: the reader bundle, the lane's new records, the judge, part 09's `canonDocument`, the store key |
| 6 | the twenty-two bases, and what the lane holds of part 15's saves made in CommCare HQ (6.6) |
| 7 | variants, what HQ never serves, coverage |
| 8 | parity between the reader's claim log and the lane's Python standings |
| 9 | `proof/first-publish-changes.json` and its judge |
| 10 | Vitest suites of the reader over retained HQ answers |
| 11 | what keeps the corpus and the registers whole: the list of what the fixed corpus leaves out, a fuzz family that draws advanced menus, and `proof/known-defects.json` staying empty |
| 12 | cost a pull request and a night, and the dispatches |
| 13 | `proof/corpus/hq/` and its self-checks |
| 14 | the weekly pin pull request and regenerating `proof/hq-apps/` |

---

## Decisions in brief

1. **A sixth corpus source, `hq-authored`, whose A Nova never sent** (section 2). A base is authored
   through HQ's own models and pages in a lane package group (`proof/matrix/`), retained whole under
   `proof/hq-apps/<base>/` and held byte for byte to HQ at the pin on every lane run. The unit makes A
   from the retained stored app through `Application.from_source` and `save_attachments`, so A holds
   exactly the menu ids, form ids and `xmlns` the emission read. Such a document has no first
   publish, and 2.4 names what stands in each place the lane read one.
2. **The capture publishes D over that A as Nova's real publish does over an app it brought in**
   (2.5): the peer starts from HQ's retained source answer, the ledger is the one a bring-in
   leaves, and every id comes from `lib/commcare/wireIdentity.ts::targetWireIdentity` over the
   identity rows.
3. **Proof 3's case database for an HQ-authored document is seeded from A alone** (2.6): case types
   and properties from HQ's own property map, types from HQ's own question summary, compared literals
   from Core's parse of A's expressions. D contributes nothing.
4. **`hq-plain` is the one base a person also wrote by hand** (section 3): an app HQ's own pages
   make, whose reading is held to a document written from what its builder authors.
5. **One table says which proofs run on the A to B hop** (section 4): the bar, intent and the manifest
   check judge A, B and B-edit; proof 1 runs against the first-publish register; proof 2 judges every
   build file but a form's XML; proof 3 always walks B; proof 4 runs; proof 5 runs where the base
   states an edit; sensitivity does not run. A comparison of the two stored apps, `source`, runs on
   this hop alone.
6. **Proof 6 is a judge that runs the reader bundle under the image's Node** (section 5), over new
   records of each unit (HQ's source answer, its application resource and its version answer, read
   through HQ's API in a fork). Nova-born documents: `read(served(D)) = canonDocument(D)`.
   HQ-authored documents: `read(A) = D` and `read(served(D)) = D`, exactly.
7. **`canon` is part 09's one closed list**, `lib/commcare/reader/canon.ts::CANONICALIZATIONS` with
   `canonDocument` (part 09, section 9), each row proven there to print equal bytes. This part
   keeps no second list and no second proof of it (5.5).
8. **The bundle's digest joins the judged key of corpus document groups and no other key** (5.6):
   a reader change judges every corpus document again from stored records and observes no Nova-born
   document. A base whose reading changes is emitted anew and observed again, as an emission change
   would be.
9. **Twenty-two bases** (section 6): `hq-plain`, a just-created app, that app after a save on each
   HQ page, three starter apps, and sixteen authored bases, each named with what it exhibits, the
   declaration it is read under, its hand-written value expectations and its edit where it states
   one.
10. **A variant is one change over a base, made in HQ and read where it is made** (section 7): a
    row of `proof/matrix/variants.json` names the entry, the standing and the place, and
    `test_retained.py` holds the reader's answer to it. Every non-allowing entry an app's source
    can hold has one. A value HQ's own import refuses, or its source read never serves, is exempt
    for that reason, and the lane holds that on every run. Coverage is three sets and a closed
    exemption list, held both ways by one test.
11. **Parity is a lane judge over the bundle's claim log** (section 8), required on every use the
    Python check decides. Python gains thirteen HELD-NEW value-class readers, named.
12. **`proof/first-publish-changes.json` has the shape 9.1 gives it and is strict both ways**
    (section 9). An entry applies on a document where its reading predicts it, and a judge holds
    three things on every base: nothing undeclared, nothing declared in vain, behavior only where
    behavior is declared.
13. **`proof/known-defects.json` stays empty.** An outcome that would add a live entry is settled
    before the merge: fixed, declared in the first-publish register, or taken out of what the reader
    holds as a `not-yet` entry with its owner (11.3).
14. **The fixed corpus leaves out only what a committed list names** (11.1). A rule that newly
    refuses a source document stops the emission by name, where today it would make the corpus one
    document smaller and pass.
15. **The lane's fuzz sample gains a family that draws advanced menus** (11.2), so proof 6 and
    every other check read Nova's own advanced menus and carried cases, which the sample draws none
    of today.
16. **`proof/corpus/hq/`'s harvest is removed** and its privilege tests move to `proof/hq/`
    (section 13).
17. **The weekly pin pull request regenerates `proof/hq-apps/` itself**, in a job of its own whose
    artifact the prewarm, the readers' lane and the report all take (section 14).

---

## Executed during planning

Read, in full or at the symbols named:

- **The lane's contract**: `proof/CLAUDE.md` whole; `proof/README.md` "What the lane proves", "The
  corpus", "HQ's apps as self-checks", "How the lane observes" through "The Core runner", "The
  registers", "Spelling rules", "The evidence store and its audits", "How the harness proves itself",
  "Native proofs", "The lane in CI", "Timings", "Changing a pin", "Step 1's decisions";
  `docs/testing.md`'s rules as `CLAUDE.md` states them.
- **The corpus**: `proof/corpus/documents.ts::CorpusSource`, `CorpusDocument`, `HqSideSaves`;
  `proof/corpus/entryWriter.ts::sourceName` and its witness branch; `proof/corpus/inputs.ts::
  retainedMigrationA`; `proof/corpus/publish.ts` header, `PublishInput`, `RetainedPublish`,
  `applyRetainedA`, `capturePublish`; `proof/corpus/targetPeer.ts` header and `applyRetained`;
  `lib/commcare/wireIdentity.ts::targetWireIdentity`, `WireIdentityOverride`.
- **The observation**: `proof/observe/publish.py::create`, `update`; `proof/observe/unit.py::
  input_files`, `case_databases`, `_build`, `_state_record`, `_Unit.create_a`, `observe_a`,
  `recreate_a`; `proof/observe/casedata.py::case_database`, `document_values`,
  `document_case_database`; `proof/observe/intent.py` header and `EXPECTATION_KEYS`;
  `proof/targeted/expected.ts::Expectation`.
- **The checks and the store**: `proof/checks/eligibility.py` whole; `proof/checks/differences.py::
  CHECKS`; `proof/checks/registers.py::HELD_CHECKS`, `OPEN_DEFECTS`; `proof/checks/controls.py::
  EDIT_READERS`; `proof/checks/manifest_usage.py::Use`, `standing`, `app_json_uses`, `xform_uses`;
  `proof/checks/manifest_value_classes.py::VALUE_CLASSES`; `proof/checks/
  test_manifest_value_classes.py::test_every_reader_reads_a_refused_entry_that_names_a_value_class`;
  `proof/store/keys.py` whole; `proof/store/fingerprints.py` header; `proof/store/queue.py::
  Builder.document`, `package_data`; `proof/store/pack.py`'s gathering of judgments;
  `proof/lane/blocks.py::CORPUS_PACKAGES`, `SINGLE_GROUPS`; `proof/native/produce.py` header.
- **HQ in the lane**: `proof/hq/operations.py` (every operation's name, `app_source`, `held_app`,
  `source_read`, `seed_api_user`, `seed_api_key`); `proof/hq/test_retained_reads.py::Retained`,
  `_hq_built`, `_shell_reads`; `proof/corpus/hq/` (each file's contract).
- **CI**: `.github/workflows/ci.yml` (`proof-corpus`), `proof-audit.yml` (`mechanics`),
  `proof-slice.yml` (inputs); `proof/ci/store-keys.mjs` header; `proof/timings.json` (both profiles,
  computed below).
- **HQ at the pin**: `corehq/apps/app_manager/views/apps.py::load_app_from_slug`,
  `_load_app_template`, `_app_template_dir`, `app_from_template`, `default_new_app`;
  `views/modules.py::new_module`, `_init_module_case_type`; `views/forms.py::new_form`;
  `models/applications.py::import_app_from_doc`, `_import_app`, `_create_app_from_doc`,
  `Application.from_source`, `export_json`, `scrub_source`, `save_attachments`, `_meta_fields`;
  `corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_module`,
  `get_all_case_properties_local`; `app_schemas/case_properties.py::get_all_case_properties`,
  `get_parent_type_map`; `xform.py::VELLUM_TYPES`; `hqmedia/models.py::create_mapping`,
  `MULTIMEDIA_PREFIX`; the three template apps under `static/app_manager/template_apps/` with their
  `multimedia.json`, counted with `python3`.
- **The outline and the research**: the outline's items 4 and 7 and its Exit;
  `docs/research/2026-09-26-hq-round-trip/README.md`, "The corpus".
- **The plan's other parts**, each at the sections this part cites.
- **Read as well, for the readers of a first publish (2.4), the seed (2.6), the base `hq-plain`
  (3.1), the bundle's peer and keys (5.2, 5.6) and the pin workflow (section 14)**:
  `proof/checks/corpus.py::Document.exports`,
  `_first_publish`, `_captured`; `proof/checks/configurations.py::PRIVILEGE_CAPTURES`,
  `_content_privileges`, `privileges_for`, `read_configurations`, `required_privileges`;
  `proof/observe/unit.py::restore_for_sessions`, `b_context`, `upload_media`;
  `proof/observe/sessions.py::hq_restore`; `proof/observe/casedata.py::lookup_fixtures`, `restore`;
  `proof/observe/intent.py::_restore_path`, `_runs_at`; `proof/checks/intent.py::profile_settings`,
  `NOVA_PROFILE_CONSTANTS`; `proof/lane/test_blocks.py::CORPUS_READERS` and its test;
  `proof/store/queue.py::PACKAGE_DATA`; `proof/observe/partition.py::OBSERVATION_DIRECTORIES`;
  `proof/hq/determinism.py::operation`; `proof/hq/operations.py::HqAnswer.retained`,
  `current_version_read`, `locations_read`, `api_request`; `proof/hq/seams.py::also_granted`,
  `api_rate_limits`; `proof/checks/sharding.py::estimate`, `documents`, `_percentile`;
  `proof/checks/manifest_usage.py::app_json_uses`, `_special`; `__tests__/helpers/httpPeer.ts`,
  `retainedHqReads.ts`; `docs/testing.md` on native `fetch`;
  `lib/commcare/targetOverlay.ts::projectProfileForTarget`, `holdsNoValue`;
  `lib/domain/blueprint.ts::NEW_APP_SETTINGS`; `proof/corpus/emitCorpus.ts::PartCensus` and its
  header; `proof/corpus/fuzzSample.ts::sampleFuzzDocuments`, `proof/corpus/documents.ts::
  FUZZ_GENERATORS`, `fuzzSplit`, `proof/corpus/defaults.ts`,
  `lib/commcare/__tests__/advancedDocArbitrary.ts` (its header and `advancedDocArbitrary`);
  `proof/observe/intent.py::expectations`; `proof/observe/identity.py`;
  `.github/workflows/upstream-pins.yml` (its jobs) and `proof-lane.yml` (`inputs.surface`). At HQ:
  `models/applications.py::_import_app` and `_create_app_from_doc` again, `Application.
  cloudcare_enabled`, `get_case_types`; `corehq/blobs/mixin.py::atomic_blobs`;
  `app_manager/util.py::update_form_unique_ids`; `app_schemas/case_properties.py::
  ParentCasePropertyBuilder`, `_propagate_and_normalize_case_properties`; `models/forms.py::
  get_contributed_case_relationships`; `models/form_actions.py::OpenSubCaseAction`, `CaseIndex`;
  `views/settings.py::edit_commcare_profile`; `views/apps.py::edit_app_attr` (its
  `cloudcare_enabled` arm and `_always_allowed`), `_build_sample_app`; `templates/app_manager/
  partials/forms/case_config_ko_templates.html` and `case_config_advanced.html`;
  `views/forms.py::_edit_form_attr`, `_allow_xform_upload`; `util.py::save_xform`;
  `xform.py::parse_xml`, `_infer_vellum_type`; `models/forms.py::FormSource.__set__`;
  `dbaccessors.py::wrap_app`; `models/applications.py::overwrite_app_from_source`,
  `absolute_url_property`, `Application.create_profile`;
  `static/app_manager/json/commcare-profile-settings.yml` and `commcare-app-settings.yml`;
  `hqmedia/views.py::ViewMultimediaFile.multimedia`;
  `export/models/new.py::FormExportDataSchema.datatype_mapping`; Vellum's
  `javaRosa/plugin.js` (`hasMarkdown`) and `src/parser.js`; Core's
  `FormEntryController.java::isHostWithAppearance`.

Counted at `15a00a97`, and unchanged at `1f103305` (the two commits between touch no manifest
entry and no timing):

- `lib/commcare/surface/entries/*.json`, gates apart: 1,250 entries (HELD 472, REFUSED 349, HELD-NEW
  237, INERT 166, TARGET-OWNED 26). Of the 586 that are REFUSED or HELD-NEW: 207 name `schema:` keys
  alone (157 REFUSED, 50 HELD-NEW), 361 name a surface key and at least one key outside `schema:`
  without being lookup-only (288 of them a key outside `schema:` and `parser:`, 73 `schema:` and
  `parser:` keys together), 9 name no surface key, 9 name only lookup families (`lookup-model:`,
  `lookup-workbook:`, `lookup-code:`). Of the 664 allowing entries, 12 name no key, 8 name only
  families no app source holds (`lookup-model:`, `lookup-workbook:`, `lookup-code:`,
  `project-setting:`) and 7 name `parser:` keys alone. 146 HELD-NEW entries share a key with an
  allowing entry, 143 of them with a value class.
- `proof/timings.json`: `no-readers` holds 430 documents (median 6.354 box-seconds, sum 3,622), 86
  controls (643) and 30 package groups (632), measured 2026-11-03 at four workers a box. `readers`
  holds 413 document groups (median 1,289.9 box-seconds, sum 815,717) at two workers a box. A group
  no run has measured is counted as `proof/checks/sharding.py::estimate` counts it: the 90th
  percentile of the whole measures of documents and controls together, pieces summed
  (`documents`, `_percentile`), which is 15.486 box-seconds over 516 in `no-readers` and 4,652.6
  over 450 in `readers`.
- The starter apps: agriculture 4 menus and 9 forms, 2 `put_in_root` menus, 1 `case_list_form`
  naming a form (`post_form_workflow: default`) and 3 with a blank `form_id` (menus 0, 2 and 3), 13
  PNG paths; health 3 and 4, 2, 1 (`case_list`) and 1 blank (menu 2), 6 PNG and 4 MP3 paths; wash 5
  and 6, 4, 1 (`default`) and 3 blank (menus 2, 3 and 4), 7 PNG paths. Each holds `build_spec`
  2.44.x, `cloudcare_enabled: true`, `secure_submissions: true`, `mobile_ucr_restore_version:
  "1.0"`, and profile values Nova does not seed. Agriculture holds `translations.fra` with `langs:
  ["en"]`. No form of any of the three holds a `case_preload` entry (every
  `actions.case_preload.preload` is empty): where a starter form shows a case's value, the form
  builder wrote a default that reads the case (six of agriculture's forms and one of wash's hold
  such defaults; health's three case forms read the case only in other logic).
- `template_apps/` holds a fourth directory, `wash_before_cond_case_update`: `wash`'s `app.json`
  without `update_mode` at its 52 case updates and `doc_type` at 20 of them (72 pointers and no
  other difference; its form sources are `wash`'s byte for byte), with the same seven
  `multimedia_map` entries and no `multimedia.json`.
  `models/form_actions.py::ConditionalCaseUpdate.update_mode` defaults to `always`, which is what
  `wash` holds at all 52. HQ's own test of the templates loads the other three
  (`app_manager/tests/test_apps.py`), and at the pin no page links the view that makes an app
  from a template (`views/apps.py::app_from_template` is named by `urls.py`, `views/__init__.py`
  and `docs/apps/terminology.rst` alone).
- `proof/checks/manifest_value_classes.py::VALUE_CLASSES`: 203 readers.

Read at source, and what each decides here:

**An app HQ makes from a template is at the lane's floor.** The template files hold `build_spec`
2.44.x, and HQ's own import drops it: `_import_app` runs `del source_doc['build_spec']` "to update
to the current default build_spec", so an app HQ makes from a template takes the project space's
default version. In a lane configuration that is 2.57.0 (`proof/README.md`, "Configurations").

**The store has no key that is one check's alone.** The store keeps one outcome a group under
`keys.group_key(document key, judge, records)` and each check's evidence under
`keys.judgment_key(group key, check)`, and `queue.py::Builder.document` makes a group cached, judged
or observed whole. So the reader bundle's digest joins the judged key of corpus
document groups: every judge of such a group runs again over stored records when the reader changes,
which is the "judge's file" row of the lane's cost table, and no document whose files are unchanged
is observed again (5.6, Departure 2).

**The application resource gives a case type's property names and nothing more.** The resource's
`case_properties` is `get_all_case_properties(app, exclude_invalid_properties=False)[module.case_type]`
(`v0_4.py::ApplicationResource.dehydrate_module`): names only, with no type and no parent. So the
seed also reads `get_parent_type_map` and each writing question's type from HQ's own summary (2.6).

**Claim corrected (outline item 7, research "The corpus").** "At least one HQ app per manifest entry,
plus generated combinations." The nine non-allowing entries that name only lookup families and 27
allowing entries name nothing an app's source holds, and one app an entry through the unit would be
about 1,250 document groups. Coverage is defined in section 7.

**What `hq-plain` leaves out or sets.** Two things an app made in HQ's pages would otherwise hold
or lack, each read at source (Departure 14):

- *A load through `case_preload`.* The basic Case Management page has no load section: the template
  `case-config:case-transaction:case-preload` is used by `case_config_advanced.html` alone
  (`partials/forms/case_config_ko_templates.html`), and the manifest says so
  (`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held`). A person
  loads a case's value by typing `#case/members` as the question's default in the form builder,
  which is how `hq-plain` does it. A stored `case_preload` is another matter: the page's save keeps
  one (`forms/case_config_ui.js::HQFormActions.from_case_transaction`) and HQ's build writes it, so
  part 07 (07-the-reader-cases-menus-lists.md, section 14 and Departure 9) re-cuts that entry from
  REFUSED to HELD-NEW, owner `forms-and-case-management`, and its new cell keeps the sentence about
  the page.
- *Web Apps off.* `Application.cloudcare_enabled` defaults to false and `default_new_app` sets
  nothing, while a D that declares both platforms publishes it true, which Nova's publish asks a
  person about first. `hq-plain` turns Web Apps on through `edit_app_attr`; the change itself is
  `hq-new-app`'s to show (part 09's `web-apps-turned-on`).

**A form source no form builder wrote.** `views/forms.py::_edit_form_attr` takes an uploaded form
source (`"xform" in request.FILES`, allowed by `_allow_xform_upload` unless the project space locks
questions) and stores it through `util.py::save_xform`. `xform.py::parse_xml` raises
`DangerousXmlException` for a source that holds an entity node, which is no `XFormException` and so
reaches the view's own error. `models/forms.py::FormSource.__set__` stores any text with no parse,
and HQ's import stores every form that way (`models/applications.py::_import_app`, through
`save_attachments`). This decides 7.2's `ops.set_form_source` and its row for a document type
declaration.

**How a value no page writes enters HQ.** `import_app_from_doc` wraps the document with
`dbaccessors.py::wrap_app` before it stores anything, and `overwrite_app_from_source` wraps the
merged document the same way. `export_json` runs `scrub_source` over what it serves. This decides
7.2's `ops.set_json` and 7.3.

**`custom_base_url`.** `views/apps.py::edit_app_attr` takes it always (`_always_allowed`); the
toggle `CUSTOM_APP_BASE_URL` is read only by the settings page's field
(`commcare-app-settings.yml`). Every URL HQ builds from it is `urljoin(self.url_base, <a path from
the root>)` (`models/applications.py::absolute_url_property`, `suite_xml/generator.py`), so only
its origin reaches a build. This decides 6.2's `hq-kept-settings`.

**A group's appearance in another case.** `xform.py::_infer_vellum_type` looks the appearance up
as written, so `Field-List` answers `Group`; `Vellum/src/parser.js` tests `appearance ===
'field-list'`; Core compares ignoring case (`FormEntryController.java::isHostWithAppearance`). This
decides section 4's spelling rule. Part 09's fifth acceptance check compares no type
(09-acceptance-and-the-first-publish.md, its Departure "Check 5 compares no type"), so such a
group needs nothing of acceptance.

**An absent show setting.** `Application.create_profile` writes a setting's `default` for an absent
key where the setting carries a `commcare_default` that differs, and
`commcare-profile-settings.yml` gives `cc-show-saved` and `cc-show-incomplete` `default: "no"`.
This decides 3.2.

**A case list expectation.** `proof/observe/intent.py::expectations` refuses a `caseList` request
on any export but `local`. This decides 6.4.

**A mapped file HQ does not hold.** `hqmedia/views.py::ViewMultimediaFile.multimedia` answers 404.
This decides why the fourth template is no base (6.2).

**The lane's fuzz sample draws no advanced menu.** `proof/corpus/documents.ts::FUZZ_GENERATORS` is
`xform`, `suite` and `expression`, and `lib/commcare/__tests__/advancedDocArbitrary.ts` says of
itself "The proof sample does not use it." That arbitrary draws, over a suite document, a form
that creates a case of another menu's type and a link that carries the new case to a follow-up
form, which is what makes Nova emit an advanced menu. This decides 11.2.

**More than `create_a` reads a first publish.** Five readers of the lane read a document's first
publish, the fifth for its tables:
`corpus.py::Document.exports` (`_first_publish`, which requires `create.json`),
`configurations.py::_content_privileges` (`PRIVILEGE_CAPTURES`), `unit.py::input_files` (the
`privileges.` roles), `_Unit.create_a` (`upload_media` over `export.content`) and, as one reader,
`restore_for_sessions` with `b_context` (`export.content.lookups`). Section 2.4 gives each its arm.

**HQ's property map and parent map are not a catalog as they stand.** `get_all_case_properties`
runs `ParentCasePropertyBuilder` with
`include_parent_properties=True` and `defaults=('name',)`, so a child type's set holds
`parent/<property>` names and `name`; `get_parent_type_map` answers `{type: {identifier:
[parent types]}}`, where the identifier is `reference_id or 'parent'`
(`models/forms.py::get_contributed_case_relationships`), not `child` or `extension`; and
`Application.get_case_types` adds `commcare-user` with usercase access. Section 2.6 reads each for
what it is.

**The lane's Python check reads settings and UI text from the app's source.**
`manifest_usage.py::_special` extracts
`setting:`, `profile-property:` and `ui-string:` uses from the app JSON's own `profile` and
`translations`, not from the built profile and app strings. So parity holds them like every other
family and excepts none (8.1).

---

## Written and not yet run

Each check below decides something only execution shows. Each names where it runs and what the
session does for every outcome. None waits on a person, and none runs on a laptop: a check is in
the work's own CI, or in a lane run on GitHub's hosted runners that the session starts itself
(12.4). No outcome adds an entry to `proof/known-defects.json` (11.3). The ids are kept where
other parts cite them; P1 and P4 are not used.

**P2. Every base with every reader.** Where: the session dispatches `proof-audit.yml` with `-f
nightly=false -f mechanics=<base ids>`, twice: eleven bases and then twelve, `hq-plain` in both
(12.4). It asks whether every base comes in, republishes and passes section 4's checks, which is to
ask how HQ's authoring and Nova's emission of one meaning differ in what a reader reads. Part 01's
Run 3 (`hq-new-app`), part 07's same-state readings (`hq-case-management`, `hq-case-lists`,
`hq-search`), part 09's check that the register is closed and part 10's assertion on held media
paths (`hq-media`) are read from these same runs, each as its part words it. Each difference the
gate reports falls in exactly one class, decided at source:

| Outcome | What the session does |
|---|---|
| A: no difference beyond the register | nothing |
| S: two spellings every reader reads alike (an itext id, a Vellum data attribute, an attribute order HQ's build keeps) | a spelling rule `proof/rules/<rule>.py` with its proof on every reader of the spelling |
| H: a report a reader makes of an app with no Nova byte in it (seen on A itself) | a member of `HQ_OWN_REPORTS` with its proof (`proof/README.md`, "Spelling rules and the registers") |
| R: the reader read A wrongly (proof 1, proof 3 or intent shows a meaning A does not hold) | the reader module that claims the entry is corrected, and the base's hand-written expectation gains the value that showed it |
| B: an emission gap, where Nova can write HQ's meaning and does not | fixed in the emitter, with a unit test |
| C1: a change Nova's spelling makes on purpose, of a kind the first-publish register is drawn from | the session writes the entry by part 09's section 11.1 type (its predicate over the reading's facts, the pointers the run showed, `touchesWorkers` true where a build file or a served walk differs) and its sentence in the voice of part 09's Copy C2, as part 09's section 11.3 says; its rows come from the run's evidence (9.1) |
| C2: a change of any other kind that a runtime, HQ's servers or stored data read | the session first reads which side is wrong: where Nova's emitter or reader is, the outcome is B or R. Only where CommCare does something with the shape that Nova's model has no concept for is the entry re-cut so the value is `not-yet` (never for a starter app, where outcome D applies), with its owner, and the shape moves from the base to a row of `proof/matrix/variants.json`. Under part 07's check of a form-builder save, where the builder changed a block's structure: the Save to Case forms leave `hq-nova-then-builder`, which keeps its form without one, and become the row `hq-nova-then-builder/save-to-case-saved`, naming `questions/savetocase-block-outside-nova-s-own-block-shape` with its standing |
| D: a starter app reads as an account | in this order: the reader misread the app (R); the checker refuses a record expression CommCare runs correctly (the record rule set is widened to it for every author, with the starter as the exhibit, which is part 08's E6); an entry's HELD class is too narrow for a value HQ's own pages write (the entry is re-cut, with the starter as the exhibit); the app holds a concept Nova has no model for (the session builds that concept in this step, with the completeness the top-level file asks of every concept, and dispatches the base again: `../6-bring-in.md`, "Checks before the merge", "A starter app must come in"). No base reads to an account |
| W: a walk stops | where a worker would go on, the walk is taught. Where the reader ends there on A and on B alike, a `proof/walk-stops.json` entry naming the base and the reader's own reason. Where it stops on B alone, it is R or B |

A fix that changes what a base emits dispatches that base again, with `hq-plain`. The stack does not
merge until the gate of a run over every base passes.

**P3. The bundle's bytes.** Where: the work's own CI, `proof/ci/__tests__/readerBundle.test.ts`
(two builds on one runner), and the weekly `proof-image.yml` product comparison (two
architectures). A: equal both ways, nothing lands. B: two builds on one runner differ: the entry
point's source of nondeterminism is found from `esbuild`'s metafile and removed. C: equal on one
runner and unequal across architectures: `proof/ci/products.mjs` compares the bundle by what it
answers for `hq-plain` (its read document and claim log) in place of its bytes, and says so in its
header; the store's keys already name the architecture. C can show only in the first weekly
`proof-image.yml` after the merge, and is fixed forward then.

**P5. Proof 6 over the Nova-born corpus.** Where: the work's own CI, the pull request lane. A:
every document reads back to `canonDocument(D)`. B: a document differs and the two documents print
equal bytes: the pair joins part 09's `CANONICALIZATIONS` (`lib/commcare/reader/canon.ts`) as a
`one-wire` row with its case of `lib/commcare/reader/__tests__/canon.test.ts`; where the reader
module that owns the slot must choose the member, its row of `READER_CANONICAL_CHOICES` is added in
that module first, and `canon.ts` wraps it. C: it differs and the bytes differ: a reader defect,
fixed in the module that claims the entry. D: the reader gives an account of Nova's own export: the
reader lacks a fold, which is added, or an entry's disposition is wrong, which is corrected where
the entry is cut. Nothing merges with a `proof6` difference, and none is ever a register entry.

**P6. Parity's first run.** Where: the work's own CI, the pull request lane. A: every decided use
agrees. B: the reader claims a use under an entry Python's standing rules out: whichever is wrong
at source is corrected, the reader or the Python reader. C: Python finds a use at an `(artifact,
where)` the log has no record for: `xmlCursor.ts::elementWhere` or the pointer escape is corrected,
with the vector added to `proof/checks/fixtures/place-vectors.json`. The join is never loosened.

**P7. A made again from its retained document.** Where: the work's own CI, the pull request lane,
`proof/matrix/test_remade.py`. A: the app `from_source` makes of `app.json`, saved by
`save_attachments`, gives `to_json()` equal to the retained document but for `_meta_fields` and each
form's attachment digest. B: another field differs because `wrap` rewrites it: the retained
`app.json` is written after one `wrap` and `to_json` round, so it is a fixed point; the test then
holds that. C: a field still differs: the unit's arm saves the document with
`Application.get_db().save_doc` after `wrap_app`, in place of `from_source`, and the test names the
field.

**P8. The media read at the pin.** Where: the work's own CI: `proof/matrix/test_retained.py` over
the four bases that map media, in the pull request lane, and `bases.retained.test.ts` over what it
retained. A: HQ answers each mapped file's read (5.3) with the file's bytes, and Nova's
`readHqMediaFile` reads each from the retained answer: nothing more lands. B: HQ answers a read
with something other than the file: that is part 05's reader meeting an answer it did not plan for,
the bases stay as written, and part 05's section 9 is corrected from the retained answer. C: Nova's
client asks for an address the lane did not read: the URL Nova builds is not the one HQ gives the
map item (`hqmedia/models.py::HQMediaMapItem.url`), and `lib/commcare/hq/media.ts` is corrected.

**P9. The variants' first run.** Where: the work's own CI, the pull request lane,
`proof/matrix/test_retained.py::test_each_variant_reads_as_its_row_says`. Which rows set a value
HQ never serves is not known before HQ answers, and no count is claimed. A: a row reads as it
says. B: a row's change raises, or its value is not served while the reading is not the row's
(Copy L17): where the change is the one the row means, the session records `hqNeverServes` in the
row and exempts the entry as `hq-never-serves-the-value` (7.3); where the change is wrong, it is
corrected. C: HQ holds the value and the reader answers otherwise than the row (L12): the reader
module that claims the entry is corrected, or the row's standing or place where the row is the one
that is wrong at source. The row for a document type declaration is decided both ways in 7.2.

**P10. The corpus keeps its documents.** Where: the work's own CI, the `proof-corpus` job's
emission, which holds the fixed corpus's census to `proof/corpus/left-out.json` (11.1). A: the two
are equal. B: a rule of this step newly refuses a fixed document (L19): where the rule is right, the
session changes the document's source so it holds what Nova holds and the corpus keeps its witness,
and names the document in the list only where no source change keeps what the document exists to
show; where the rule refuses too much, the rule is corrected. C: the list names a document the
corpus takes (L20): it comes off the list.

---

## 1. What Nova does today

**Every corpus document is a Nova document.** `proof/corpus/documents.ts::CorpusSource` has five
arms (`producer`, `workforce`, `expander`, `fuzz`, `targeted`), and `CorpusDocument.doc` is a
`PersistableDoc`. The one A that Nova's current emission did not produce is a migration witness's:
its first-publish bodies are retained under `proof/migrations/<id>/`
(`proof/corpus/inputs.ts::retainedMigrationA`), the capture replays them into its peer
(`publish.ts::applyRetainedA`, `targetPeer.ts::applyRetained`), and
`proof/checks/eligibility.py::WITNESS_UNRUN` leaves proofs 2, 3 and 5 and sensitivity out of it. A
witness's A is still bytes Nova once sent.

**The capture's ledger records no identity override.** `proof/corpus/publish.ts` passes
`DERIVED_WIRE_IDENTITY` to `hqImportApplication` at its two call sites and to the local export's
`compileLocalArchive`, and its header says so. `lib/commcare/wireIdentity.ts::targetWireIdentity`
already lays overrides over the derivation, per entity and per field.

**The unit makes A by applying Nova's captured bodies.** `proof/observe/publish.py::create` applies
the shell and the content import through HQ's own view, and `proof/observe/unit.py::_Unit.create_a`
runs it as the operation `create`, keyed by `first_publish_digest`. Each built state's record holds
the stored app (`_state_record`: `doc`). No record holds HQ's `app_source` answer or its application
resource, and `proof/hq/operations.py` has no operation for the application resource.

**Five readers of the lane read a document's first publish.** `proof/checks/corpus.py::
Document.exports` calls `_first_publish` for every `export/<configuration>/`, which requires
`create.json`. `proof/checks/configurations.py::_content_privileges` derives a document's privileges
from the apps of `PRIVILEGE_CAPTURES` and raises `PrivilegeInputError` without
`export/minimum/create.json`. `proof/observe/unit.py::input_files` builds the `privileges.` roles
from the same capture. `_Unit.create_a` uploads the media `export.content` names, and
`restore_for_sessions` and `b_context` serve the tables `export.content.lookups` uploads
(`sessions.hq_restore`, `casedata.lookup_fixtures`).

**A value expectation runs over a restore its entry names.** `proof/observe/intent.py::_runs_at`
returns expectations only for a `targeted` document, and `_restore_path` gives each the file its
`restore` names or `TEMPLATE_RESTORE`, never the document's case database.
`proof/targeted/expected.ts::EvaluateRequest.session` is `{ command?, data? }`, `data` keyed by datum
id, and an `ExpectedValue` is `{ pointer, value }`.

**A document's case database is made from the document.** `proof/observe/casedata.py::case_database`
reads `document.json`: the emitted `catalog` for types and properties, and
`document_values` for the literals the document's own expressions compare. A control reads the
database it retains (`document_case_database`).

**The lane runs no Nova TypeScript in a shard.** Nova's code runs in the `proof-corpus` job
(`proof/corpus/emit.ts` and `python3 -m proof.native.produce`), whose outputs the corpus carries.
Node is in the image and runs in shards for the editor driver and HQ's XPath validator.

**The manifest check reads REFUSED classes only.** `manifest_usage.py::standing` returns HELD for a
use an allowing entry names once no REFUSED class takes it, and its docstring says a HELD-NEW class
that shares its key with an allowing class is not judged.
`test_every_reader_reads_a_refused_entry_that_names_a_value_class` holds every reader to a REFUSED
entry.

**HQ's own apps are harvested and read by nothing.** `proof/corpus/hq/` writes HQ's test apps,
template apps and harvested `AppFactory` apps beside the corpus under `--with-hq`, which CI does not
pass; the group `hq-selfchecks` has no test module (`proof/lane/blocks.py::SINGLE_GROUPS`,
`proof/checks/sharding.py::collection_roots`).

**The registers.** `proof/known-defects.json` and `registers.py::OPEN_DEFECTS` are empty.
`proof/identity-moves.json` is scoped to migration witnesses. `proof/walk-stops.json` holds 25
entries.

---

## 2. The sixth source: `hq-authored`

### 2.1 The source

`proof/corpus/documents.ts::CorpusSource` gains one arm:

```ts
| {
		readonly kind: "hq-authored";
		/** The base's id: its directory under `proof/hq-apps/` and its entry of `proof/matrix`. */
		readonly base: string;
  }
```

`entryWriter.ts::sourceName` names it `hq-authored:<base>`. The document's id is the base's id
(`hq-plain`, `starter-health`). `CorpusDocument` gains:

```ts
/** Present exactly for an `hq-authored` document. */
readonly hqAuthored?: HqAuthoredFacts;

export interface HqAuthoredFacts {
	/** The HQ id of every menu and form D holds, and each form's `xmlns`. Dense: one row an entity. */
	readonly identity: readonly WireIdentityOverride[];
	/** HQ's source answer the capture's peer starts from: `proof/hq-apps/<base>/app-source.json`. */
	readonly source: unknown;
	/** The register ids that apply under `declaration` (section 9). */
	readonly firstPublish: readonly string[];
	/** The declaration D was read under (6.1): the base's own, or the reading's preselected one. */
	readonly declaration: { readonly runsOnlyOn: "web-apps" | "android" | null;
	                        readonly splitDatetime: boolean };
	/** HQ's path for each asset D references (part 10, section 4). Empty where A maps no file. */
	readonly mediaPaths: ReadonlyMap<string, string>;
}
```

A base's media are the document's own assets: `hqAuthoredDocuments()` puts each retained file of
`proof/hq-apps/<base>/media/` into the document's media manifest (`documents.ts::uploadedMedia`)
under the id the reading names the file by, which is part 12's
`lib/deployment/reading/mediaIds.ts::provisionalReadingMediaId(appId, mediaType, multimediaId)`
(12-the-reading-and-the-birth.md, section 2.3), its media type and multimedia id being the ones
`media-reads.json` records for its path, with the kind, MIME type and extension `media.json`
records. So the capture publishes D with the bytes A holds, and `mediaPaths` names each asset's
path in A. One file that two paths name is one asset.

New file `proof/corpus/hqAuthored.ts` exports `HQ_APPS = "proof/hq-apps"`, `RetainedHqAnswer`,
`RetainedHqApp`, `readRetainedHqApp(base: string): Promise<RetainedHqApp>` and
`hqAuthoredDocuments(): Promise<CorpusDocument[]>`, which `emitCorpus.ts` adds to the fixed floor
after the targeted documents. `RetainedHqApp` is a base's directory, parsed, file for file (2.2):

```ts
/** One retained answer, as `proof/hq/operations.py::HqAnswer.retained()` writes it. */
export interface RetainedHqAnswer {
	readonly status: number;
	/** `Content-Type` and `Retry-After`, where HQ sent them; absent where it sent neither. */
	readonly headers?: Readonly<Record<string, string>>;
	/** The body as text; absent where HQ sent none. */
	readonly body?: string;
}

export interface RetainedHqApp {
	/** The base's id, which is its directory's name. */
	readonly id: string;
	/** Absolute path of `proof/hq-apps/<id>/`. */
	readonly directory: string;
	/** `base.json`. */
	readonly base: {
		readonly id: string;
		readonly configuration: {
			readonly flags: readonly string[];
			readonly namedPrivileges: readonly string[];
			readonly commcareVersion: string;
			readonly commtrack: boolean;
			readonly syncCasesOnFormEntry: boolean;
			readonly caseSearchEnabled: boolean;
		};
		readonly declaration: "preselected" | { readonly runsOnlyOn: "web-apps" | "android" | null;
		                                        readonly splitDatetime: boolean };
		readonly exhibits: readonly string[];
	};
	/** `app-source.json`, `application.json` and `current-version.json`. */
	readonly source: RetainedHqAnswer;
	readonly application: RetainedHqAnswer;
	readonly currentVersion: RetainedHqAnswer;
	/** `project-spaces.json` and `project-spaces-flag.json`, where the reading asks for them (2.2). */
	readonly projectSpaces?: { readonly all: RetainedHqAnswer; readonly flagged: RetainedHqAnswer };
	/** `media.json`, one row a mapped path, each with its file read from `media/`. */
	readonly media: readonly {
		readonly path: string;
		readonly file: string;
		readonly mediaClass: "CommCareImage" | "CommCareAudio" | "CommCareVideo";
		readonly kind: "image" | "audio" | "video";
		readonly mimeType: string;
		readonly extension: string;
		readonly bytes: Uint8Array;
	}[];
	/** Where the base holds each: the lookup, location and media answers (2.2). */
	readonly lookupTables?: RetainedHqAnswer;
	readonly fixtureRows?: Readonly<Record<string, RetainedHqAnswer>>;
	readonly locationTypes?: RetainedHqAnswer;
	readonly locations?: RetainedHqAnswer;
	readonly mediaReads?: readonly {
		readonly path: string; readonly mediaType: string; readonly multimediaId: string;
		readonly status: number; readonly sha256: string; readonly length: number;
	}[];
	/** `expected.json` (7.1). */
	readonly expected: {
		readonly reads: true;
		readonly declaration: { readonly runsOnlyOn: "web-apps" | "android" | null;
		                        readonly splitDatetime: boolean };
		readonly claimed: readonly string[];
		readonly firstPublish: readonly string[];
	};
}
```

`RetainedHqAnswer` is the file shape itself. `proof/reader/` (5.2) imports it as a type; the helper
`__tests__/helpers/retainedHqReads.ts` keeps its own type of that name for `proof/hq-reads/`, which
defaults the headers. A document of this source
carries no generated edit batch, as a targeted document carries none; its edit is the one its base
states (`proof/matrix/hand/<base>/edit.ts`), planned and admitted through `proof/targeted/build.ts`'s
own gate call.

D is `proof/reader/laneReading.ts::readForLane` over the base's retained answers (5.2), which must
answer `read`. `hq-plain` also holds `proof/matrix/hand/hq-plain/document.ts`, a document a person
wrote from what 3.1 authors. `proof/corpus/__tests__/hqAuthored.test.ts` holds the reading equal to
it by external key (`externalIdentityMap`, part 10, 10-identity-and-the-ledger.md, section 2.5), and
names each menu or form of A the hand-written document gives no identity row (Copy L2). It is the
one base whose reading is held to a document a person wrote, so a reader that mis-reads a shape
`hq-plain` holds, consistently, fails there.

An emission stops, naming the base, where the reading answers `account` (Copy L1) and where the
base states a declaration the reading does not offer (L13).

### 2.2 `proof/hq-apps/<base>/`: what is retained

Everything under `proof/hq-apps/` is written by the lane and held to it byte for byte. Nothing in it
is written by hand.

| File | What it is | Who reads it |
|---|---|---|
| `base.json` | `{ "id", "configuration": { "flags": [], "namedPrivileges": [], "commcareVersion": "2.57.0", "commtrack": bool, "syncCasesOnFormEntry": bool, "caseSearchEnabled": bool }, "declaration": "preselected" or { "runsOnlyOn", "splitDatetime" }, "exhibits": [entry ids] }`, from the registry (2.3). `configuration` is one entry of a corpus document's `configurations.json`, key for key (`proof/checks/configurations.py::read_configurations`) | emission (the document's `configurations.json`, 2.4), Vitest |
| `app.json` | the app as HQ stores it: `Application.to_json()` after one `wrap` round, with `_attachments` as `{ "<form unique id>.xml": "<source text>" }` and no blob metadata | the unit (2.4) |
| `media.json`, `media/<n>.<ext>` | an array, one row a mapped path in path order: `{ "path", "file", "mediaClass", "kind", "mimeType", "extension" }`, as in `[{ "path": "jr://file/commcare/image/module0_en.png", "file": "media/0.png", "mediaClass": "CommCareImage", "kind": "image", "mimeType": "image/png", "extension": "png" }]`. `path` is the full path the app's references hold, `file` the retained file, `mediaClass` HQ's own (`CommCareImage`, `CommCareAudio` or `CommCareVideo`); the files are the lane's stand-in bytes (6.3) | the unit, emission |
| `tables.json` (where the base holds tables) | an array, one object a lookup table as HQ's models hold it, in tag order: `{ "tag", "is_global", "fields": [{ "name", "properties": [...], "is_indexed" }], "item_attributes": [...], "rows": [{ "fields": { "<name>": [{ "value", "properties": {...} }] }, "item_attributes": {...} }] }`, the rows in `sort_key` order (`corehq/apps/fixtures/models.py::LookupTable`, `TypeField`, `LookupTableRow`, `Field`) | the unit (2.4) |
| `places.json` (where the base holds places) | `{ "levels": [{ "name", "code", "parent" }], "places": [{ "name", "site_code", "level", "parent", "metadata": {...}, "archived" }] }`: each level as `LocationType` holds it, `parent` its parent's code or null, and each place as `SQLLocation` holds it, `level` its level's code and `parent` its parent's site code or null; both lists parents first (`corehq/apps/locations/models.py`) | the unit (2.4) |
| `app-source.json` | HQ's answer to the source read, `operations.source_read`, as `HqAnswer.retained()` writes it | emission, Vitest |
| `application.json`, `current-version.json` | HQ's answers to the application resource read, part 05's `operations.application_read` (05-reading-commcare-hq.md, section 14.1), and to `operations.current_version_read`, which exists today | emission, Vitest |
| `project-spaces.json`, `project-spaces-flag.json` (where the reading asks for them) | HQ's answers to part 05's `operations.project_spaces_read`, whole and filtered by the slug of `SAVE_ONLY_EDITED_FORM_FIELDS`: the two reads Nova makes of a project space where the app's source holds a write saved only if changed (part 05, section 10.5). `retain` makes both reads for every base and keeps the two files only where the first reading's `asked` names them (5.2) | emission, Vitest |
| `media-reads.json` (where the source maps media) | for each mapped path, HQ's answer to the read of its file with the seeded key (5.3): `{ "path", "mediaType", "multimediaId", "status", "sha256", "length" }`. The bytes are the file `media.json` names for the path | emission, Vitest |
| `lookup-tables.json`, `fixture-rows-<tag>.json`, `location-types.json`, `locations.json` (where the base holds them) | HQ's answers to `lookup_tables_read`, `fixture_rows_read`, `locations_read` (all three exist today) and the new `location_types_read` | emission, Vitest |
| `seed.json` | the case seed made from A (2.6) | the unit, through the corpus document |
| `expected.json` | `{ "reads": true, "declaration": { "runsOnlyOn", "splitDatetime" }, "claimed": [entry ids], "firstPublish": [register ids] }`, written by the lane from the bundle's answer over these files (7.1). `declaration` is the one the base was read under (6.1) | emission, Vitest, the coverage test |

`biome.json` gains `proof/hq-apps` beside `proof/hq-reads` in its ignore list. The tree is about
7.3 MB: each starter app's stored document and source answer are 0.2 to 0.6 MB apiece, and an
authored base's about 0.1 MB. Nothing of a variant is retained (7.2).

What is written by hand lives apart, under `proof/matrix/hand/<base>/`: `expectations.json` and the
`restore.xml` its expectations run over (6.4), `edit.ts` where the base states an edit, and
`document.ts` for `hq-plain`.

### 2.3 `proof/matrix/`: authoring a base

A new lane package, in `proof/checks/sharding.py::SPLIT` as two groups,
`proof/matrix/test_retained.py` and the rest. It is in `proof/lane/blocks.py::CORPUS_PACKAGES`:
`test_retained.py` runs the bundle through `proof.checks.readerbundle`, which finds it through
`proof.native.produce`, and `bases/nova_then_builder.py` reads a corpus document through
`proof/matrix/conftest.py` (6.2).
`proof/lane/test_blocks.py::test_the_packages_the_early_phase_refuses_are_those_whose_tests_read_
the_corpus` holds `CORPUS_PACKAGES` equal to the packages whose tests or conftests reach
`CORPUS_READERS` (`proof.checks.corpus`, `proof.checks.cases`, `proof.native.produce`).

```python
# proof/matrix/registry.py
@dataclass(frozen=True)
class Declaration:
    runs_only_on: str | None               # "web-apps", "android" or None for both
    split_datetime: bool = False

@dataclass(frozen=True)
class Base:
    id: str
    build: Callable[[Authoring], str]      # returns the app id HQ holds
    configuration: Configuration           # proof.hq.configuration.Configuration, whole
    exhibits: tuple[str, ...]              # entry ids the base is built to exhibit (6.2)
    vellum: tuple[tuple[int, int], ...] = ()   # (menu, form) positions saved in HQ's form builder
    declaration: Declaration | None = None     # None: the reading's preselected declaration (6.1)

BASES: tuple[Base, ...]

# proof/matrix/author.py
@dataclass(frozen=True)
class Authoring:
    """What a base's builder and a variant's change are handed."""
    state: object                        # the open HQ check's state, as every operation takes it
    documents: Mapping[str, Document]    # conftest's `documents`: the corpus documents DOCUMENTS names
```

`proof/matrix/author.py::authored(base)` opens one HQ check (`proof.hq.check.hq_check`, as
`test_retained_reads.py::_hq_built` does) under the base's configuration, inside
`seams.also_granted(privileges.API_ACCESS)` (the privilege's slug, as every caller of
`also_granted` passes one) and `seams.api_rate_limits(unit)` (which `operations.api_request` asks
of every caller), and runs, each in a determinism operation of its own labelled
`matrix:<base>:<step>`:

1. `api-user`: `operations.seed_api_user`, which makes the user's key.
2. `build`: the base's `build`, which uses only HQ's own code. A builder reaches HQ three ways, in
   this order of preference: HQ's views through `operations.session_post` (`default_new_app`,
   `new_module`, `new_form`, `edit_form_actions`, `edit_module_attr`, `edit_module_detail_screens`,
   `edit_form_attr`, `edit_app_attr`, `edit_commcare_profile`, `edit_app_ui_translations`,
   `edit_app_langs`); HQ's models where a page needs a browser the group does not start
   (`Module.new_module`, `AdvancedModule.new_module`, `FormActions`, `DetailColumn`, `app.save()`,
   and for project data `LookupTable`, `LookupTableRow`, `LocationType`, `SQLLocation`), as
   `_hq_built` does; and HQ's own form writer `xform_builder.py::XFormBuilder` for a form's source.
3. `vellum:<m>.<f>`, for each position `Base.vellum` names: the form opened and saved once in HQ's
   vendored form builder through `proof/editors/vellum.py`, the driver proof 4 uses. Where a base
   needs something only a person's typing in the form builder writes (a default reading
   `#case/<property>`, a formatted hint), the save follows the driver steps `ops.builder_save`
   takes (7.2).
4. `retain`: `proof/matrix/retain.py::retain(state, app, core_runner)` writes the files of 2.2 to
   `$PROOF_OUT/hq-apps/<base>/`: `app.json` from `operations.held_app(...).to_json()` with each
   attachment from `lazy_fetch_attachment`; `tables.json` and `places.json` from HQ's models; the
   reads through HQ's API with the seeded key, each in an operation labelled
   `matrix:<base>:reads`; and `seed.json` (2.6).
5. `variants`: each row of `proof/matrix/variants.json` for the base, in a fork of the base's
   state (`state.mark`, the change, the application read, the source read, the version read
   `operations.current_version_read` and the two project space reads, `state.restore`), read by
   the bundle and held to its row (7.2). The version read is the variant's own: a change saves
   the app, and every save of an app that is no build raises its `version`
   (`models/applications.py::ApplicationBase.save`), so the base's retained version answer would
   read as a save between the two ends of part 05's bracket (its section 8.2). Nothing of a
   variant is retained.

`proof/matrix/test_retained.py::test_the_hq_apps_nova_reads_are_hqs_own` runs `authored` for every
base and holds the committed tree to what it wrote, with `test_retained_reads.py::Retained`'s rule
moved into `proof/matrix/retained.py::Retained`, a helper both test modules import, since a test
module is imported by nothing (`proof/store/test_partition.py`). The helper sits in `proof/matrix`
and not in `proof/hq`: every file under `proof/hq/` is in the observation partition
(`proof/observe/partition.py::OBSERVATION_DIRECTORIES`), so a later edit to a helper there would
move every part key. Its failure message is Copy L3.

No builder is in the observation partition: `proof/matrix/` is a package group keyed by the harness
fingerprint, so an edit to a builder runs the package groups and observes no document again. What a
builder changes of a base reaches that base's document through `proof/hq-apps/<base>/`, whose files
the emission copies into the document's directory, so only that document's key moves.

### 2.4 Making A in the unit

`proof/hq/operations.py` gains:

```python
@dataclass(frozen=True)
class AuthoredMedia:
    """One mapped file of an authored app: a row of its media.json with the file's bytes."""
    path: str                 # the full path the app's references hold (media.json's `path`)
    data: bytes
    original_filename: str    # the path's last segment, as the loader passes it to attach_data


def save_authored_app(state, document: dict, media: Sequence[AuthoredMedia]) -> str:
    """An app HQ's own models made, saved again from its stored document: the same menu ids, form ids,
    xmlns and content. Returns the id HQ gives it."""
```

It takes `_attachments` out of the document, calls `Application.from_source(document, state.domain)`
(which removes `_id`, `_rev`, `domain`, `copy_of`, `version`, `short_odk_url` and
`short_odk_media_url`, `models/applications.py::_meta_fields`, sets the domain and wraps), then
`app.save_attachments(attachments)`, which stores each form and saves the app as `_import_app`'s
own call of it does (`corehq/blobs/mixin.py::atomic_blobs` saves the document when its block ends;
`_import_app` makes no other save of it). It does not call `_import_app`: that goes through
`export_json`, whose `scrub_source` mints a new id for every form
(`update_form_unique_ids(source, ids_map={})`), and A must hold the ids the emission read. It skips
`_create_app_from_doc`'s three writes too (`convert_build_to_app`, `date_created`, and
`cloudcare_enabled` set from the plan), since each would change a field the retained app holds as
its author left it. For each media file it does what `views/apps.py::load_app_from_slug` does for a
template's: `CommCareMultimedia.get_class_by_data`, `get_by_data`, `attach_data(data,
original_filename=..., username=...)`, `add_domain(state.domain, owner=True)` and
`app.create_mapping(multimedia, path)`, with `path` the full path `media.json` holds (the loader
passes `MULTIMEDIA_PREFIX + path` because a template's `multimedia.json` holds the path without
its prefix).

Two more operations make the project data a base holds, each from HQ's models and each before the
app is saved, so A's build, its restore and every walk run over a project space that holds them:

```python
def save_authored_tables(state, tables: Sequence[dict]) -> None:
    """Each lookup table of an authored base and its rows, made with HQ's own models
    (fixtures/models.py::LookupTable, LookupTableRow) from the base's tables.json."""

def save_authored_places(state, places: dict) -> None:
    """Each level and place of an authored base, parents first, made with HQ's own models
    (locations/models.py::LocationType, SQLLocation) from the base's places.json."""
```

A managed table is never pushed to the project space that manages it (part 11, 11-project-data.md,
section 8.2), so no later operation of the unit uploads a workbook for such a document: the tables
B and B-edit read are the ones A was made with.

Part 05's reads (`application_read`, `app_list_read`, `api_access_read`, `project_spaces_read` and
the rest of its section 14.1) and this part's `location_types_read` are operations of this same
file, because the observation makes the app's reads through them (5.3).

`proof/observe/publish.py` gains `create_authored(unit, document)`, which runs the two project-data
operations where the document holds their files, then `save_authored_app`, and returns
`(app id, None, None)` in `create`'s shape. `first_publish_digest` gains the arm for it: the digest
of `app.json`, `media.json`, each media file, and `tables.json` and `places.json` where they exist.

**What stands where a first publish stood.** An `hq-authored` document has no `create.json` and no
`content.json`. Each reader of one (section 1) gains an arm for the source:

| Reader | For an `hq-authored` document |
|---|---|
| `proof/checks/corpus.py::Document.exports` | where `authored/app.json` exists, an `Export` with `create=None` and `content=None`, its `republish` and `republish_stopped` read as for any document. `Document.authored` gives what `content` gave: the app's path, `media.json` and, where the base holds them, `tables.json` and `places.json` |
| `proof/checks/configurations.py::_content_privileges` | `required_privileges` over the apps of `authored/app.json`, the captured republish under `export/minimum` and, where the base states an edit, the captured update, with `lookup_push` true where `authored/tables.json` exists (the plan must hold what HQ's own table pages and reads ask). The republish is among the sources because B can need what A does not: a D that declares Web Apps over an A with the setting off needs `CLOUDCARE` (`_needs_cloudcare`) |
| `proof/observe/unit.py::input_files` | the `privileges.` roles are `privileges.authored.app` (`authored/app.json`), `privileges.republish.` (the republish's request files) and `privileges.update.` as today. Part `a` holds the roles `authored.app`, `authored.media` (`authored/media.json`), one role a media file, `seed` (`authored/seed.json`) and, where the base holds them, `authored.tables` and `authored.places`, in place of the first publish's requests. `proof/corpus/inputs.ts` writes the same roles |
| `_Unit.create_a` | calls `create_authored` in the operation `create`, keyed by the digest above, and skips `upload_media`: `save_authored_app` attached the media. Its publish record is `_publish_record(None, None, None)`, which `bar.py::republish_bar` reads as a create HQ took with no upload beside it. No HQ-side save follows (an `hq-authored` document carries no `hq-side.json`, and the entry writer refuses one). The build, the saved build, the mark and the state record follow as for any A |
| `restore_for_sessions`, `b_context` (`sessions.hq_restore`) | no workbook is uploaded. `proof/observe/casedata.py::lookup_fixtures` is split: `served_fixtures(state, user_id)` is its second half (each table HQ holds, served as `ItemListsProvider` serves a global table), and `hq_restore` calls that half alone where the document is `hq-authored`, its operation keyed by the digest of `authored/tables.json` (a base that holds no table is served none) |

The entry writer writes the document's `configurations.json` from `base.json`: `minimum` is the
base's `configuration`, `maximum` is the same entry, and `singleFlag` is empty, and it writes
`export/minimum/` alone. A base is authored under one configuration, and an app HQ's pages made
under one set of flags is not the app those pages would make under another, so A has no other
configuration to be made again under; sensitivity, the one check that asks what a flag changes,
does not run on the source (section 4). The entry writer copies the base's `app.json`,
`media.json`, `media/`, `seed.json` and, where the base holds them, `tables.json` and `places.json`
into the document's `authored/` directory, so the document's key (`keys.document_key`, every file of its
directory) names them and the store's guard admits them.

`proof/checks/corpus.py::Document` gains `hq_authored` (its `source` starts `hq-authored:`, through
`eligibility.hq_authored`), `authored` (above) and `case_seed` (the parsed `authored/seed.json`, or
None).

State A's version is whatever HQ's saves leave (1 after `save`, raised by each attachment and media
save), and no check reads its number: proof 2's version clause compares a form's version between
A's build and B's.

### 2.5 The capture over an A Nova did not send

`proof/corpus/publish.ts::PublishInput` gains:

```ts
/**
 * An HQ-authored A. With it the capture writes no first publish: the peer starts holding HQ's own
 * source answer, the ledger is the one a bring-in leaves, every id is the target's, and the updates
 * are sent over it, the first of them B. Never beside `retainedA` or `hqSide`.
 */
readonly hqAuthoredA?: {
	readonly source: unknown;
	readonly identity: readonly WireIdentityOverride[];
	readonly mediaPaths: ReadonlyMap<string, string>;
};
```

and `capturePublish` a third overload returning `RepublishCapture`. With `hqAuthoredA`:

- `targetPeer.ts::TargetPeer` gains `holdSource(source: unknown): void`, which makes the peer hold
  that source as the app's, at the placeholder id, as it holds one after `applyRetained`. Every later
  answer is the peer's existing `sourceAfterUpdate`.
- The identity every body and every local export of the document is built with is
  `targetWireIdentity(hqAuthoredA.identity)`, at the two `hqImportApplication` call sites and at
  `compileLocalArchive`. `DERIVED_WIRE_IDENTITY` stays for every other document.
- The ledger (`CaptureLedger`) is the one a bring-in leaves (part 10,
  10-identity-and-the-ledger.md, section 6.3): `app.origin` is `"read"`, which
  `CaptureLedger.origin` (`"create" | "push"` today) gains; the baseline is the one part 10's
  `adoptedAppBaselineWrite` gives for the peer's source read, called with `firstPublish: { ids: [],
  touchesWorkers: false }` (part 09, 09-acceptance-and-the-first-publish.md, section 12.3); the
  identity rows are `adoptedIdentityRows`'; the held media paths are `mediaPaths` (part 10,
  section 4); and `tables` is empty. No lane check reads the stored first-publish list: a base's
  predicted ids reach the lane through `first-publish.json` (9.2).
- The publish passes `languageNames: "target"` and `seeds: "target"` for such a document (part
  01, 01-the-bar-and-the-manifest.md, sections 7.2 and 7.3), and `"nova"` for both on every other.
- The peer answers the lookup table reads the `managed-data` preflight makes (part 11,
  11-project-data.md, section 8.1) from the tables the base holds, in `publish.ts` and
  `targetPeer.ts`. The capture moves with publish (`proof/CLAUDE.md`), so each of these lines
  changes with the publish code it mirrors.
- Where the document's declaration is not the Web Apps setting A holds (6.1), the publish asks
  before it changes the setting, and the capture answers as a person who confirms it, through the
  confirmation `lib/deployment` takes for that question. Any other stop of an update ends the
  capture, naming the base and the stop's code, as over a witness: Nova's own reading must never
  read as a change made in CommCare HQ.
- The local archives are compiled with the same identity, so proof 3 compares A with a `.ccz` that
  names A's forms by A's `xmlns`.

The HQ side holds the capture as it holds any update: `proof/observe/publish.py::update` runs
`operations.hold_assumed_source` over the eight fields the update's body was built on
(`AssumedSource`: `doc_type`, the build version, `profile`, `translations`, `add_ons`, `langs`,
`auto_gps_capture`, `cloudcare_enabled`), against HQ's own read of the A the unit made. A retained
`app-source.json` that differs from what HQ serves in one of those eight refuses the capture there
(`CapturedSourceNotHeld`). The rest of the retained source is held another way: it and `app.json`
are written by one `authored` run and compared byte for byte by `test_retained.py`, and
`test_remade.py` holds the app the unit makes of `app.json` to that document (P7).

`proof/corpus/__tests__/publish.postgres.test.ts` gains the case that Nova's real `publishAppToHq`,
over a peer holding `hq-plain`'s retained source and the ledger a bring-in leaves, sends the bodies
the capture recorded. Its deployment is written by part 10's
`recordAdoptedDeploymentInTransaction` (its section 6.2), so its identity rows are
`adoptedIdentityRows`' and no row is inserted by hand.

**Build profiles become part of what the capture peer holds.** A publish reads `build_profiles`
from the app's source and can stop on it (part 01, section 7.4), so the peer must answer that read
with what HQ would hold.

- `proof/corpus/targetPeer.ts`: the source the peer serves holds `build_profiles`, `{}` from the
  create on. `applyHqSide`'s `buildProfiles` arm stops being "none of the peer's state": it stores
  each profile as `views/releases.py::LanguageProfilesView.post` does, replacing the map whole,
  `{ <id>: { doc_type: "BuildProfile", name, langs, practice_mobile_worker_id: "" } }`, and its
  doc comment says so. An update leaves the map as it is, as HQ's does
  (`models/applications.py::_merge_source_into_app`).
- `proof/corpus/__tests__/publish.test.ts`, one case: after `applyHqSide` with
  `targeted-hq-side-state`'s saves, the peer's source read holds the same `build_profiles` as
  `proof/hq-reads/targeted-hq-side-state/app-source-after-buildProfiles.json`, HQ's own answer
  after that save, which `proof/hq/test_retained_reads.py` holds to HQ on every lane run. It
  catches a peer that models a profile HQ would not serve.
- `targeted-hq-side-state` keeps `republish: "proceeds"`, and now says more than it did: its
  republish and its edit both run the new check over a served profile (`zho`, a code both
  documents hold) and neither stops. Its header comment gains that sentence. A stop there fails
  the capture by name ("hq-side.json states that Nova's ... proceeds ..."), which is the lane's
  proof that the rule does not stop a publish it should let through.
- **No document whose publish stops is added.** The stop needs a language removed after a profile
  was saved, so it can only fall on a document's edit while its republish lands, a shape the corpus
  does not have (a stopped publish is recorded for B alone,
  `proof/checks/corpus.py::Export.republish_stopped`). Building that shape would prove one thing:
  that Nova's preflight refuses. That is Nova's own decision over a read, and
  `lib/deployment/__tests__/publishGates.postgres.test.ts` proves it on `publishAppToHq` itself,
  over a read whose shape HQ's retained answer fixes. The CommCare fact the refusal rests on is
  already run every lane: the fixed entry `d1-language-codes-build-profile-raised` on the control
  `targeted-hq-side-state` holds HQ's build of a profile that names none of the app's languages
  raising `XFormException`. The registers do not change.

### 2.6 The case database, seeded from A

`proof/matrix/seed.py::case_seed(state, app, core_runner) -> dict`, run in the `retain` step with
the Core runner the matrix group starts for it (it parses A's expressions), writes:

```json
{
	"catalog": [{ "name": "household", "parent_type": null, "relationship": null,
		"index_identifier": null,
		"properties": [{ "name": "head_name", "data_type": "text", "options": [] }] }],
	"values": { "household/village": ["north", "south"] },
	"userData": ["district"],
	"worker": { "location": null }
}
```

- `catalog`: each case type of `app.get_case_types()` but `commcare-user`, which
  `Application.get_case_types` adds with usercase access and `casedata` makes itself as the
  worker's usercase (`USERCASE_TYPE`). Parents come first.
- A type's properties are the names `get_all_case_properties(app,
  exclude_invalid_properties=False)` gives it (the call the application resource makes), less every
  name holding `/` and less `name`. That call runs `ParentCasePropertyBuilder` with
  `include_parent_properties=True` and `defaults=('name',)`, so a child type's set holds
  `parent/<property>` for each of its parent's properties and every set holds `name`;
  `casedata.case_database` writes each catalog property as a case property element
  (`CaseRecord.properties`), which `parent/x` cannot name, and it gives every case its
  `case_name` already.
- A type's `parent_type` and `index_identifier` come from `get_parent_type_map(app)`, which
  answers `{type: {identifier: [parent types]}}` with the identifier each form's index names
  (`reference_id or 'parent'`, `models/forms.py::get_contributed_case_relationships`). Its
  `relationship` comes from the action that opens the type: `OpenSubCaseAction.relationship` in a
  basic form, the `CaseIndex.relationship` of the opening action in an advanced one
  (`models/form_actions.py`), `child` or `extension`. `casedata` writes `INDEX_IDENTIFIER`
  (`parent`) for every index today; `seeded_case_database` writes the seed's `index_identifier`
  where it is not null. A base keeps one parent, one identifier and one relationship a type, and
  `test_seed.py` refuses a base whose map gives a type two, or a relationship answered by a
  question (`CaseIndex.relationship: "question"`), by name.
- A property's `data_type` comes from HQ's own summary of the questions that write it
  (`Form.get_questions`, each `update_case.update` and subcase `case_properties` path looked up in
  it): `Date` is `date`, `Time` `time`, `DateTime` `datetime`, `Int` and `Long` `int`, `Double`
  `decimal`, `Select` `single_select` with the summary's option values, `MSelect` `multi_select`
  likewise, `Geopoint` `geopoint`, anything else `text` (`xform.py::VELLUM_TYPES`). A property two
  questions of different types write is `text`.
- `values`: every string literal A's expressions compare with a case property, read with the Core
  runner's `xpathParse` over each form's binds and setvalues and each module's filter, detail
  column, sort calculation and search expression. A literal beside `=`, `!=`, `<`, `<=`, `>`, `>=`
  or inside `selected(...)` whose other operand is a path ending in a property name of the type is
  that property's value. Never a regular expression (`proof/CLAUDE.md`).
- `userData`: every name read under `instance('commcaresession')/session/user/data/`, and the
  usercase properties `get_usercase_properties(app)` gives.
- `worker.location`: the site code of the place the base's builder names as the worker's, or
  null. Where it is set, `proof/formplayer/hq.py::create_worker` assigns the worker there with
  HQ's own `CommCareUser.set_location` (`corehq/apps/users/models.py`), so each reader HQ serves
  restores the places HQ's own restore hands that worker. Core's sessions run over
  `casedata.restore`, which writes cases and item lists and no location fixture for any document
  today; what `hq-places`' logic reads of a place is held by its value expectations over the
  hand-written `restore.xml` that carries the fixture (6.4), and by the served readers.

`proof/observe/casedata.py` gains `seeded_case_database(seed) -> CaseDatabase`, which runs the same
generation `case_database` runs (`VALUES`, the case counts, parent indices, the worker) over the
seed's catalog and values. `document_case_database` returns it where `document.case_seed` is not
None. D's `catalog` and D's expressions are never read for such a document, so a reader that drops a
type, a property or a literal cannot empty the lists A's walk and B's walk both show.

`proof/matrix/test_seed.py` holds the contract with a planted case: an app whose module filter
compares `status = 'open'` seeds `open` for `status`, and a D with that filter removed changes no
byte of the database.

---

## 3. The base `hq-plain` and its hand-written document

### 3.1 The base

It holds only what Nova holds, made as a person makes it. `proof/matrix/bases/plain.py::build`:

1. `views/apps.py::default_new_app`, then `edit_app_attr` naming it "Household visits" and turning
   Web Apps on. `Application.cloudcare_enabled` defaults to false and `default_new_app` sets
   nothing, and D declares both platforms, so with the setting off Nova's publish would stop to ask
   before turning it on. That change is `hq-new-app`'s to show (6.2).
2. `views/modules.py::new_module` with `module_type=case`, `name=Households` and
   `case_type=household`. HQ adds "Registration Form" and "Followup Form", each with `open_case` or
   `update_case` at `always` (read at `new_module`).
3. The registration form's source through `XFormBuilder`: a text question `head_name`, an integer
   `members`, a single select `village` (`north`, `south`), a date `visit_date`, a group `notes`
   holding a text question `remark`, and a hidden value `members_plus_one` calculating
   `/data/members + 1`. Then saved in HQ's form builder (`vellum: ((0, 0), (0, 1))`), so every byte
   of the form is the builder's own.
4. `views/forms.py::edit_form_actions` on the registration form: the case name from `head_name`,
   and `members`, `village` and `visit_date` saved as case properties.
5. The follow-up form: a label, an integer `members` whose default reads the case, a text `remark`
   required where `members > 5`. The default is typed in the form builder as a person types it
   (`#case/members` as the question's Default Value, through `ops.builder_save`'s steps), because
   the basic Case Management page offers no load ("Executed during planning"). `edit_form_actions`
   saves `members` and `remark`, and writes no `case_preload`.
6. `edit_module_detail_screens`: the list shows the name and `village`, sorted by `village`; the
   detail shows the name, `village`, `members` and `visit_date` as a date.

It saves no setting: an app a person just made holds none, and a deployment Nova brought in is
seeded with none (part 01, 01-the-bar-and-the-manifest.md, section 7.3).

Its configuration is the lane's minimum for the content with no flag, with `CLOUDCARE`, which the
content rule derives for an app Web Apps lists (`_needs_cloudcare`). It declares both platforms:
nothing it holds is unavailable on either.

### 3.2 The hand-written D

`proof/matrix/hand/hq-plain/document.ts` exports `document(): { doc: BlueprintDoc; identity:
WireIdentityOverride[] }`: a Nova document meaning what 3.1 authors, built with
`lib/commcare/__tests__/` builders as targeted documents are
(`proof/targeted/build.ts::TargetedSpec`), every UUID a literal. Its `identity` names A's menu id,
the two form ids and the two `xmlns`, read from the retained `app.json` and matched by position:
`{ entityKind: "module", novaEntityUuid, uniqueId: app.modules[0].unique_id, xmlns: null }` and one
`form` row a form with `uniqueId` and `xmlns`. The hand writes the Nova UUIDs; the ids of HQ's side
are read, never typed, so a pin move that re-mints them needs no hand edit.

Three things the hand-written D states because 3.1 authors them so:

- every label and every choice holds `plainLabel: true`. The form's source comes from
  `XFormBuilder`, which writes no formatted copy, and HQ's form builder writes one on a save only
  for a text it read one for or a person formatted (`javaRosa/plugin.js`, `item.hasMarkdown`), so A
  holds none; a D without the flag would publish a formatted copy of every label;
- the follow-up form's `members` holds a default value reading the case's `members`, and no load
  through a case operation;
- it declares both platforms, and its `appSettings` hold `showSavedForms` and
  `showIncompleteForms` false. 3.1 saves no setting; part 06 reads a key the profile lacks as
  `lib/domain/blueprint.ts::NEW_APP_SETTINGS` holds it (06-the-reader-forms.md, sections 6.6 and
  16.1); and HQ's build of A writes `no` for each
  (`models/applications.py::Application.create_profile`). It states none of the fifteen settings
  a project space keeps.

It is written by reading 3.1 and the rules the parts state, never from a reading's output (2.1
holds the reader to it).

`proof/matrix/hand/hq-plain/edit.ts` exports its edit: the follow-up form gains a text question
`follow_up_note` after `remark`, and the registration form's `remark` label changes. It gives proof 5
a footprint of two forms and a `mechanics` dispatch its edited document.

`proof/matrix/hand/hq-plain/expectations.json` is 6.4's, with five expectations over its
`restore.xml`.

---

## 4. Which proofs run on the A to B hop

For an `hq-authored` document A is HQ's own app, B is Nova's publish of D over A, and B-edit is
Nova's publish of D′ over A. The table is the one place that says which checks run on the hop, with
what each needs.

| Check | On an `hq-authored` document | What changes, and where |
|---|---|---|
| bar | runs on A, B and B-edit. A must build: a base is an app HQ accepts | none in the judge: `observations.py::judged_states` already answers every state for a document that is no witness, `bar.py::document_bar` already reads A and B, and `create_authored`'s publish record (`_publish_record(None, None, None)`, 2.4) is a create HQ took with no upload beside it |
| intent | runs on A, B and B-edit, and on the local archives. At A it holds what HQ builds of its own app to what D states, which is a check of the reader | `proof/checks/intent.py`: for an `hq-authored` document `profile_settings` and `local_profile_settings` take A's stored profile values (`authored/app.json`, `profile.properties`) as `saved`, at A, B, B-edit and each local archive, the mechanism `hq-side.json`'s `profileProperties` already uses. Nothing is skipped: Nova's publish carries the target's own values and its archive mirrors them (`KEPT_AT_HQ`, part 01 section 5). A setting A does not hold is expected, at every state, as HQ's build writes an unstated one (`_unstated_setting`). No base saves the settings for this reason; a deployment Nova brought in is seeded with none (`seeds: "target"`, part 01 section 7.3) |
| value expectations | each of the base's hand-written expectations runs on A, on B and, where the base's declaration includes Android, on the local archive, and must give the one value (6.4) | the entry writer writes one `Expectation` for each state the expectation runs at (`export: "A" | "B" | "local"`, less `local` where no archive is made, and only the states its `exports` names: 6.4); `proof/observe/intent.py::_runs_at` runs expectations for a document that is `targeted` or `hq_authored` |
| manifest | runs on A, B, B-edit and the local archives. At A it is the independent check that the base holds nothing refused, undecided, unnamed or held-new | none in the judge; it reads `authored/app.json` through `Document.authored` (2.4), which a `test_corpus.py` case holds |
| proof 1 | runs, A against B. A difference is accepted only where an entry of `proof/first-publish-changes.json` names the document (section 9); `proof/identity-moves.json` never applies | `proof/checks/proof1.py` asks `changes.declared` before it reports |
| proof 2 | runs on every build file but `modules-<m>/forms-<f>.xml`. HQ builds both suites, profiles, app strings and media suites from the two stored apps, so they compare; a form's bytes are Nova's own spelling of it, which proof 3 and intent judge | `proof/checks/proof2.py`: `eligibility.form_xml_unjudged(source)` drops the artifacts named `modules-<m>/forms-<f>.xml` for this source; `proof/checks/test_build_files.py` gains the case that every other file still has a comparator |
| proof 3 | runs always: Core's sessions and Formplayer's walks replay on B's aligned build whether or not the raw builds differ, over the database seeded from A (2.6), and the local archive is compared with A where the base declares Android | `proof/observe/unit.py::observe_b_aligned` takes "B where the raw builds differ" as always for this source; `proof/checks/proof3.py` asks `changes.declared` |
| proof 4 | runs over B and B-edit, as on any document | none |
| proof 5 | runs where the base states an edit (`hq-plain`, `starter-health`, `hq-case-management`) | none: a document with no `edit/` is already uncollected |
| sensitivity | does not run. Its flips rebuild A, and a gate's effects are what HQ's build changes of a Nova export; A is not one. Every flag HQ reads while it builds B is still held to a gate entry by the manifest check | `eligibility.HQ_AUTHORED_UNRUN` |
| stops | runs on A, and on proof 4's B and B-edit | none |
| proof 6 | `read(A) = D` and `read(served(D)) = D`, exactly (section 5) | new |
| parity | runs on A (section 8) | new |
| source | A's stored app against B's, as HQ's source read serves each: the comparison the first-publish judge needs (9.3). It runs on this source alone | new: `proof/checks/source.py` |
| changes | the judge's three holds over the register file (section 9) | new |

`proof/checks/eligibility.py` becomes:

```python
WITNESS_UNRUN = frozenset({"proof2", "proof3", "proof5", "sensitivity", "parity", "source", "changes"})
HQ_AUTHORED_UNRUN = frozenset({"sensitivity"})
HQ_AUTHORED_ONLY = frozenset({"parity", "source", "changes"})


def migration_witness(source):
    return source.startswith("targeted-migration:")


def hq_authored(source):
    return source.startswith("hq-authored:")


def eligible(check, source):
    if migration_witness(source):
        return check not in WITNESS_UNRUN
    if hq_authored(source):
        return check not in HQ_AUTHORED_UNRUN
    return check not in HQ_AUTHORED_ONLY
```

The module stays standard library only (`proof/CLAUDE.md`, "What runs with no image").
`proof/checks/test_corpus.py` gains `test_an_hq_authored_document_runs_every_check_but_sensitivity`,
which reads `eligible` over every name of `differences.CHECKS`.

**One spelling rule the hop needs.** A form HQ's form builder wrote and Nova's form of the same
document differ in a spelling no reader reads apart, and it is a rule with its proof on every
reader, never a register entry: `hint-validation-markdown-form` (part 03,
03-questions-and-text.md, section 8.2). P2 adds any other the runs find (outcome S). No rule is
written for a group's `field-list` token in another case: no check of the hop reports the two
spellings apart. Proof 1 compares each question's export class, which is one class for a group
and a Question List (`proof/observe/identity.py`,
`export/models/new.py::FormExportDataSchema.datatype_mapping`); proof 2 leaves a form's XML out;
Core and the served readers read the token ignoring case; and proof 4 saves B and B-edit, which
Nova writes in lower case. `hq-questions` holds such a group (6.2), read as part 06 section 10.2
says.

**App strings.** Part 01 section 7.1's classifier rests on HQ's build and Nova's archive writing the
same generated app-string ids for one document. Proof 3 already compares each language's app strings
as Core reads them between A's build and the local archive, for a document whose declaration
includes Android. Every base that holds more than a default language (`hq-languages`,
`hq-kept-settings`, `starter-agriculture`) is read under its preselected declaration, and by part
06's rule that one includes Android for each of them (6.1), so each has that comparison (6.4, the
last rule).

`proof/checks/differences.py::CHECKS` and `registers.py::HELD_CHECKS` gain `proof6`, `parity`,
`source` and `changes`. `controls.py::EDIT_READERS` gains none: no control is retained for
them, because `proof/known-defects.json` takes no entry of theirs (11.3) and a control holds no
document.

---

## 5. Proof 6: the fixed point

### 5.1 The claim

- **Nova-born documents** (every source but `hq-authored`): for D and for D′,
  `read(served(D)) = canonDocument(D)`, where `served(D)` is what HQ's API answers for the app
  Nova's publish of D left, and `canonDocument` is part 09's (5.5).
- **HQ-authored documents**: `read(A) = D` and `read(served(D)) = D`, with no canonicalization: D is
  in the reader's image. Its D′ is D after a Nova edit (`edit.ts`'s mutations), which can hold
  either member of a canonical pair, so `read(served(D′)) = canonDocument(D′)`.
- **A migration witness**: `read(served(D)) = canonDocument(D)` at B. Its A is an export from before
  a migration, which no claim is made of.

So `canonDocument` applies to every D′, and to D exactly when the document is not `hq-authored`.

At state A the comparison holds the unit, not the reader: D is the reader's answer over the base's
retained answers, and `read(A)` is the same reader over what HQ answers for the A the unit made, so
the two differ only where the unit's A is not the base (an app, a table, a place or a file made
otherwise than HQ made it). It is the one hold on `save_authored_tables`, `save_authored_places`
and the worker's place (2.4, 2.6). What holds the reader at A is intent, the value expectations,
the manifest check at A, parity, and for `hq-plain` the hand-written document.

**The declaration is compared beside the document.** The reader never writes
`appSettings.runsOnlyOn`: it returns the declaration choices beside the document (part 09, section
5.4). So every read back compares the documents with `appSettings.runsOnlyOn` taken out of the
expected one, and separately requires the declaration the document holds to be among the reading's
choices, reported at `/appSettings/runsOnlyOn` where it is not. `read(A) = D` is the one comparison
made whole: the bundle reads A under the base's declaration, as the emission did (5.2), and D holds
what that declaration's mutations wrote. Both forms are part 09's one comparison,
`readBackDifferences(expected, read)` (09-acceptance-and-the-first-publish.md, section 9.1): a
read back hands it the reading's choices, and `read(A) = D` hands it `choices: null`.

What proof 6 does not hold on a read back, stated in `proof/README.md` beside it: the project data's own
readers. On a read back the bundle is handed the lookup catalog, the levels and the media index as the
corpus document holds its Project's data (5.2), since Nova's publish of a Nova-born document creates
those in HQ from the same data. Part 11's readers of HQ's lookup, location and media answers run in
proof 6 only at state A of the bases that hold such data (`hq-lookups`, `hq-places`, `hq-media`, the
starters' media), and are otherwise held by their own tests over `proof/hq-reads/lookups/` and
`places/`. Nor does it hold an expression's meaning: a consistent mis-read prints back to itself. Proof
3 with the hand-written value expectations holds meaning (6.4).

### 5.2 The reader bundle

New directory `proof/reader/`, TypeScript, outside every barrel:

| File | Exports |
|---|---|
| `proof/reader/laneReading.ts` | `readForLane(input: LaneReadInput): Promise<LaneReading>`, `LaneReadInput`, `LaneReading` |
| `proof/reader/retainedPeer.ts` | `withRetainedHq`, `RetainedHqPeer`, `LANE_TARGET`, `LANE_READING_ID` |
| `proof/reader/cli.ts` | the bundle's entry: reads requests, writes answers |
| `proof/reader/build.mjs` | `node proof/reader/build.mjs --out <dir>`: the esbuild call |

The directory holds no comparison of its own: `readBackDifferences` and `ReadBackDifference` are
part 09's `lib/deployment/reading/readBack.ts` (its section 9.1), which `cli.ts` imports.
`RetainedHqAnswer` is `proof/corpus/hqAuthored.ts`'s (2.1). It mints no id either: every id of a
reading is derived by production's own functions from the app's id and the reading's id (part 12,
12-the-reading-and-the-birth.md, section 2.3; part 11, 11-project-data.md, section 5.5), so the
lane hands them one fixed reading id and an emission is byte-stable.

```ts
// proof/reader/retainedPeer.ts
/** The one target every request of a lane reading is built with: `proof/corpus/publish.ts`'s
 *  `PROOF_SERVER` and `PROOF_DOMAIN`, written out here so the bundle carries no capture code.
 *  `retainedPeer.test.ts` holds the two equal to those constants. */
export const LANE_TARGET = { server: "production", domain: "nova-proof" } as const;
/** The reading id of every lane reading: a UUIDv7 written out, which part 12's
 *  `READING_ID_PATTERN` admits. Its time bits order nothing (part 11, section 5.5). */
export const LANE_READING_ID = "01900000-0000-7000-8000-000000000000";

export interface RetainedHqPeer {
	/** A fixed credential. The agent checks no key: HQ checked it when the answer was made. */
	readonly creds: CommCareCredentials;
	/** The names of the retained answers consumed so far, in the order they were asked for. */
	asked(): readonly string[];
}

/** Answers native `fetch` from `answers` for the length of `run`, and nothing else (step 1). */
export function withRetainedHq<T>(
	answers: Pick<LaneReadInput,
		"source" | "application" | "currentVersion" | "projectSpaces" | "projectData">,
	run: (peer: RetainedHqPeer) => Promise<T>,
): Promise<T>;
```

A retained answer's name, in `asked`, is its member of the input: `application`, `source`,
`currentVersion`, `projectSpaces:all`, `projectSpaces:flagged`, `lookupTables`,
`fixtureRows:<tag>`, `locationTypes`, `locations` and `media:<path>`.

```ts
// proof/reader/laneReading.ts
export interface LaneReadInput {
	/** The Nova app id the reading mints or matches under: the corpus document's `doc.appId`,
	 *  which for an `hq-authored` document is the base's id, as a targeted document's is its own. */
	readonly appId: string;
	/** The corpus document's `document.json`, whole: `doc`, its lookup snapshot, its media.
	 *  Absent for a base's first reading, which has no document yet. */
	readonly document?: unknown;
	/** HQ's answers, as the unit recorded them or `proof/hq-apps/` retains them. */
	readonly source: RetainedHqAnswer;
	readonly application: RetainedHqAnswer;
	/** HQ's answer to the version read that closes part 05's bracket (its section 8.2). */
	readonly currentVersion: RetainedHqAnswer;
	/** HQ's two project space lists, whole and filtered by the flag (part 05, section 10.5).
	 *  Asked for only where the source holds a write saved only if changed. */
	readonly projectSpaces?: { readonly all: RetainedHqAnswer; readonly flagged: RetainedHqAnswer };
	/** Required for `identity: "mint"`: HQ's own project data answers, and its files. */
	readonly projectData?: {
		readonly lookupTables: RetainedHqAnswer;
		readonly fixtureRows: Readonly<Record<string, RetainedHqAnswer>>;
		readonly locationTypes?: RetainedHqAnswer;
		readonly locations?: RetainedHqAnswer;
		/** One a mapped path: HQ's answer to the file's read, and its bytes where HQ gave them. */
		readonly media: readonly {
			readonly path: string;
			readonly mediaType: string;
			readonly multimediaId: string;
			readonly status: number;
			readonly base64?: string;
		}[];
	};
	/** A first reading's declaration: the base's own, or absent for the reading's preselected one. */
	readonly declaration?: { readonly runsOnlyOn: "web-apps" | "android" | null;
	                         readonly splitDatetime: boolean };
	/** `mint`: a base's first reading. `match`: a read back, which must give D's own UUIDs. */
	readonly identity: "mint" | "match";
	/** The `claims` option of part 06's `readHqApp` (06-the-reader-forms.md, section 2.2). */
	readonly claims: "counts" | "full";
}
export type LaneReading =
	| { readonly kind: "read"; readonly doc: BlueprintDoc;
	    readonly identity: readonly WireIdentityOverride[];
	    readonly declaration: { readonly runsOnlyOn: "web-apps" | "android" | null;
	                            readonly splitDatetime: boolean };
	    /** Every declaration the reading offers, for a read back's declaration check (5.1). */
	    readonly offered: readonly { readonly runsOnlyOn: "web-apps" | "android" | null;
	                                 readonly splitDatetime: boolean }[];
	    readonly firstPublish: readonly string[];
	    /** The retained answers the reader asked for, by name: a test holds each one asked. */
	    readonly asked: readonly string[];
	    /** Under `full`, the claim log as `serializeClaimLog` writes it; under `counts`, the JSON
	     *  of the count of claims by entry id. */
	    readonly claims: string }
	| { readonly kind: "account"; readonly findings: readonly Finding[];
	    readonly asked: readonly string[]; readonly claims: string };
```

A `LaneReadInput` with `identity: "mint"` and no `projectData`, or with `identity: "match"` and no
`document`, is refused by name before anything is read.

`readForLane` is the production path with no service around it:

1. **The peer.** `proof/reader/retainedPeer.ts::withRetainedHq(answers, run)` puts an undici
   `MockAgent` in place with `setGlobalDispatcher` for the length of `run` and puts the previous
   dispatcher back in a `finally`, which is how `__tests__/helpers/httpPeer.ts::withHttpPeer`
   controls native `fetch` and what `docs/testing.md` asks of a peer ("the controlled peer must cover
   the dispatch path that Node actually uses"; never a replaced `fetch` or a Response-shaped
   object). `undici` is a dependency (`package.json`), so the bundle carries it. The agent refuses
   every connection (`disableNetConnect`) and answers each request Nova's client makes from the
   retained answer for it, status, headers and body as HQ gave them: the application resource, the
   source read, the version read (from `currentVersion`, an answer HQ made, so the bracket of part
   05 section 8.2 closes on HQ's own body), the two project space lists (from `projectSpaces`),
   and, with `projectData`, the lookup table list, each table's rows, the location types, the
   locations, and each mapped file at the address HQ gives its map item, answered with the status
   the lane recorded and the file's bytes. A request with no retained answer is refused by the
   agent and ends the reading, naming its path (Copy L15); `asked` lists what was consumed. No
   socket is opened.
2. **A first reading** (`identity: "mint"`: a base at emission, in Vitest, at state A in the
   judge, and a variant where it is made). It is one call, inside the peer, of part 12's
   `lib/deployment/reading/gather.ts::gatherFromHq` (12-the-reading-and-the-birth.md, section
   3.3): that section's steps 3 to 9 as production runs them, without the two reads of Nova's own
   store that `gatherReading` makes first (the stored connection, which the peer's `creds` stand
   for, and the advisory claim read, which decides nothing).

   ```ts
   gatherFromHq({ key, readingId: LANE_READING_ID, appId: input.appId, keepMedia: false,
   	onEvent: () => {}, creds: peer.creds, project, claims: input.claims })
   ```

   `key` is `{ projectId: "proof-lane", ...LANE_TARGET, remoteAppId }`, the last the id the
   retained application resource names. `project` is a Project that holds nothing: a part 11
   `ReadingProjectSide` (11-project-data.md, section 14.1) whose `tables` answers no definition
   and no row, whose `referencingApps` and `siblings` answer none, whose `mayAdminister` is true,
   and whose `measureRows` answers a measure under both caps. So every table stands as new. The
   two byte caps are Postgres's to measure, and part 11's own tests hold them. `keepMedia: false`
   fetches each referenced file through the peer and keeps nothing.

   So the decoding and the bracket of the app read (part 05, section 8.2), the flag read where
   the source holds a write saved only if changed (its section 10.5), the menus HQ could not
   summarize, the project data, the reader, the files' plan and verdicts, part 11's findings,
   part 09's `acceptReading` and the review are production's, in production's order, and the
   lane holds no copy of a step and assembles no reader input and no `AcceptReadingInput` of its
   own. The answer's result becomes the reading:
   - `stop` is an `account` holding that one circumstance finding, and `account` is an `account`
     of its findings, an acceptance failure among them as its `read-back-differs` finding;
   - `clean` gives the draft (`gathered.draft`) and `gathered.accepted.declarations`.

   `LaneReading.claims` is the answer's `claims.log` under `full` and the JSON of its
   `claims.counts` under `counts`, or the empty string where `claims` is null, which is a stop
   before the reader ran.
3. **The declaration.** The entry takes the `AcceptedDeclaration` `input.declaration` names, or
   the one with `preselected: true` where it names none, and applies its `mutations` to the
   draft's document: that is D. `firstPublish` is that declaration's `firstPublish.ids`, and
   `offered` is every declaration's choice. A base that names a declaration the reading does not
   offer stops its emission (Copy L13).
4. **A read back** (`identity: "match"`). `lib/commcare/hq/appReading.ts::readHqAppForReading`
   (part 05, section 8.2) and, where part 07's `publishedCaseBlocks.ts::sourceHoldsEditMode` is
   true of the source, `lib/commcare/client.ts::readHqSaveOnlyEditedAnswers` (part 05, section
   10.5), as step 3 of part 12's section 3.3 makes them, so the decoding, the alignment and the
   failure classification are production's; then `readHqApp(input, { claims })` (part 06,
   06-the-reader-forms.md, section 2.2) with the resolver
   `matchingResolver(appId, externalIdentityMap(doc, targetWireIdentity(identity)))` (part 10
   sections 2.3 and 2.5), `appId` the corpus document's app id, `saveOnlyEditedApplied` the flag
   read's answer, and `recordDialect: recordDialectRoundTrip`
   (`lib/agent/authoring/recordRoundTrip.ts`; part 08, 08-the-reader-expressions.md, section
   8.4), as production's read passes it. The rest of the reader's input is the document's own:
   the lookup catalog from its lookup snapshot with its table and column ids; the organization as
   part 06's `ReaderOrganization`, `{ levelCodes,
   levels }`, each level of the document written as the `HqLocationType` part 11's `levelsFromHq`
   reads it back from (its section 11.2): `name`, `code` and `parentCode` the level's own,
   `sharesCases` its `caseFlow.ownsCases`, `viewDescendants` true where its
   `caseFlow.descendantCases` is `all`, and `administrative` false and `id` the code, neither of
   which that function reads; the media index from its
   media by the path each asset was published at (`assetWirePath.ts::wirePathFor`, or
   `HqAuthoredFacts.mediaPaths` where the document holds one); and `appStrings` from part 09's
   `lib/deployment/reading/appStrings.ts::readingAppStrings` over the gate's context for that
   lookup catalog (its section 15.1). Nova's publish of the document
   created those in HQ from the same data, or, for a base, left HQ's as they were. No acceptance
   runs: the read back is itself the fixed point, and `offered` comes from the draft's
   `declaration.choices`.
5. `identity` is part 10's `adoptedIdentityRows` over the draft's identities, projected to
   `WireIdentityOverride`.

`proof/reader/cli.ts <requests> <answers>` reads one JSON document from the first path:
`{ "requests": [{ "id", "mode": "read-back" | "first-read" | "claims", "input": LaneReadInput,
"expected"?: unknown, "canon"?: boolean, "holds"?: [{ "key", "pointer", "value" }] }] }`, and
writes `{ "answers": [{ "id", "kind", "differences"?, "findings"?, "claims"?, "declaration"?,
"firstPublish"?, "held"?: [{ "key", "pointer", "found" }], "asked" }] }` to the second
(`declaration` and `firstPublish` on a `first-read` that answers `read`: the declaration the
reading was taken under and its list, which `test_retained.py` writes into the base's
`expected.json`; `held` for a holding variant's `holds`, each with the value found at that
pointer of the entity the external key names, 7.2). Standard
output is not the answer channel: `lib/logger.ts` and the readers under it write there, so it is the
bundle's log, which `readerbundle.py` keeps beside the evidence. For `read-back` and `first-read`
with an `expected` document, the entry applies `canonDocument` (`@/lib/commcare/reader/canon`, part
09) to `expected` where the request says `"canon": true`, and answers part 09's
`lib/deployment/reading/readBack.ts::readBackDifferences(expected, read)` (its section 9.1),
which this entry imports and does not restate: both documents less the entity kinds
`KINDS_WITH_NO_EXTERNAL_KEY` names (part 10, section 2.2), then part 09's
`lib/doc/documentDifferences.ts::documentDifferences` (its section 14.2) over the two. `read` is
part 09's `ReadBack`, `{ doc; choices }`, in exactly these two shapes. In mode `read-back` it is
`{ doc: draft.doc, choices: draft.declaration.choices }`, the reading's offered declarations (the
empty list where the declaration's kind is `none`), so `expected` loses `appSettings.runsOnlyOn`
and the declaration difference of 5.1 is added. In mode `first-read` with an `expected` document
it is `{ doc: draft.doc, choices: null }`, and the two are compared whole. A read back under
`matchingResolver` gives D's own UUIDs, so the two documents are compared as they stand.
The entry draws nothing, opens no socket and reads no file but its first argument, and nothing it
answers depends on a clock (production's check times its own pieces and stamps its review with
the time of the read, and the lane reads neither).

`proof/reader/build.mjs` calls `esbuild.build` with: `entryPoints: ["proof/reader/cli.ts"]`,
`bundle: true`, `platform: "node"`, `format: "esm"`, `target: "node24"`, `conditions:
["react-server"]` (so `server-only` resolves to its empty module, as `scripts/test-schema.ts` needs),
`tsconfig: "tsconfig.json"` (the `@/` alias), `legalComments: "none"`, `sourcemap: false`,
`minify: false`, `charset: "utf8"`, `absWorkingDir` the checkout's root, `outfile:
"<out>/reader.mjs"`, and `banner.js` the two lines that give an ESM bundle `require`
(`createRequire(import.meta.url)`). It then writes `<out>/reader.json`: `{ "sha256": <of reader.mjs>,
"esbuild": <its version>, "node": <.nvmrc> }`.

It is a native product and no family: `proof/native/produce.py` gains `produce_reader(directory,
log, *, timeout)` beside `produce_publish_captures` and `produce_entry_point_ids`, which runs `node
proof/reader/build.mjs --out <DIR>/reader`, and `produce_all` records it in `produced.json` under
`reader`. So CI's `proof-corpus` job builds it once, where `node_modules` are, and the corpus carries
it as `native/reader/`. A local `npm run proof` builds it the first time a test asks, as it builds
the publish captures. `proof/ci/products.mjs` compares it across the weekly's four productions byte
for byte (P3).

### 5.3 The lane's new records

`proof/observe/unit.py` gains `_Unit.api_reads(ops, label)`:

1. `mark = unit.mark()`.
2. Inside `seams.also_granted(privileges.API_ACCESS)` (the privilege's slug, as every caller passes
   one) and `seams.api_rate_limits(unit)` (which `operations.api_request` asks of its callers):
   `operations.seed_api_user`, which makes its key, then part 05's `operations.application_read`,
   `operations.source_read(unit, app_id, credential)` and `operations.current_version_read`, each
   in an operation `reads:<label>`, in the order Nova's own read makes them (the application
   resource before the source and the version read after it: the bracket of part 05, section 8.2).
   Then part 05's `operations.project_spaces_read`, whole and with the slug of
   `SAVE_ONLY_EDITED_FORM_FIELDS`, in the operation `reads:project-spaces`: the flag read Nova
   makes where a source holds a write saved only if changed (5.2). The unit makes both for every
   read and the bundle asks for them only where the source holds such a write.
3. For an `hq-authored` document at label `authored`, what a first reading asks beyond the app
   (5.2): where `authored/tables.json` exists, `lookup_tables_read` and one `fixture_rows_read` a
   table; where `authored/places.json` exists, `location_types_read` and `locations_read`; each in
   the operation `reads:project-data`, recorded under `projectData` as `LaneReadInput` names them.
   And where the source maps media, each mapped file read
   with the same credential at the address HQ gives its map item
   (`hqmedia/models.py::HQMediaMapItem.url`), through `operations.api_request`, in one operation
   `reads:media`. The record keeps `{ path, mediaType, multimediaId, status, sha256, length }` a
   file and not its bytes: the bytes are the document's own (`authored/media/`), and the judge
   requires each `sha256` to be that file's. This is where the URL part 05's `readHqMediaFile`
   builds is held to the pin (part 05, Departure 3): the bundle answers Nova's request for a file
   only at the address the lane read it at, so a pin that moves the address fails the base's
   reading by name (P8).
4. `unit.restore(mark)`.

It returns `{ "source": <blob of the answer>, "application": <blob>, "currentVersion": <blob>,
"projectSpaces": { "all": <blob>, "flagged": <blob> }, "projectData"?: {...}, "media"?: [...] }`,
each answer as `HqAnswer.retained()` writes it. The fork keeps the API user,
its key and anything HQ writes while it answers out of every later operation:
`ApplicationResource.dehydrate_module` calls `get_all_case_properties`, and with `USERCASE` HQ's case
property map creates the project space's user field definition the first time it is asked
(`proof/CLAUDE.md`, "A state made again under a stored part"). Because the fork is restored, a state
made again under a stored part leaves the reads out, and `proof/checks/test_record_determinism.py`'s
`USERCASE` document holds that the records after it are the first observation's.

| Part | Label | Where in the unit | For |
|---|---|---|---|
| `a` | `published` | after the content import and its media, before any HQ-side save: `served(D)` as Nova's publish left it | Nova-born documents but a witness |
| `a` | `authored` | after `create_authored` | `hq-authored` documents |
| `a` | `saved` | after the HQ-side saves: the source Nova's review of changes made in CommCare HQ reads | part 15's ten documents (6.6) |
| `b` | `published` | after the republish and its media | `hq-authored` documents, witnesses, and the documents whose `hq-side.json` states `brings-in` (6.6) |
| `b_edit` | `published` | after the update of D′ and its media | every document with an edit and no `hq-side.json` |

The record's key is `apiReads` in each part. A document with `hq-side.json` gets no `b_edit` read: its
B-edit is published over a person's saves, which are not Nova's export. `observations.py::
OPERATION_CHECKS` gains `"reads": "proof6"`.

`proof/observe/served.py` and every other hook are untouched. Every read goes through HQ's URLconf,
API-key authentication, permission and privilege checks and rate limiter, as every retained read
does (`operations.api_request`).

### 5.4 The judge

`proof/checks/proof6.py` (pure, no HQ import) and `proof/checks/test_proof6_fixed_point.py`,
parametrized by `cases.document_params("proof6")`.

`proof/checks/readerbundle.py::run_reader(requests) -> list[dict]` writes the requests to a
temporary file, runs `node <corpus>/native/reader/reader.mjs <requests> <answers>` through
`proof/processes.py` with a 120 second deadline, parses the answers file and keeps the process's
standard output as the judgment's log. It refuses, by name, a
corpus with no `native/reader/reader.mjs` (Copy L4) and a bundle whose `reader.json` digest is not
the file's.

For each configuration of the document, `proof6.differences(document, records)` sends one request a
recorded read (5.3), but a `saved` read, which it makes no claim of (6.6), and reports, as
`Difference(check="proof6", artifact, path, kind)`:

| What the bundle answered | Difference |
|---|---|
| `read`, no differences | none |
| `read`, differences | one a difference: artifact `document@<state>`, path the differing entity's place and slot with every authored name as `*` and kept in `at` (`proof/CLAUDE.md`, "A structural path names a symptom"), kind `value`, `missing` or `added` |
| `account` | one a finding: artifact `reading@<state>`, path `/<finding code>`, with the place in `at` |
| the bundle exits non-zero or times out | the test fails by name; no difference stands for a broken judge |

`<state>` is `A`, `B` or `B-edit`. `canon` is asked for at every B-edit, and at A and B exactly when the
document is not `hq-authored` (5.1). At state A of an `hq-authored` document the request's mode is
`first-read` under the declaration `document.json` records (`hqAuthored.declaration`), with the project
data answers and media statuses of the same record and the media files of the document's `authored/`
directory; every other request is a `read-back`. All of a document's requests go in one Node
process.

The judge starts Node once a document. A reading of a real app is well under a second, so the start
is the cost, and no long-lived reader process is built: `proof/reader/cli.ts` serves one requests
file and exits. `node proof/run.mjs --timings` over the step's first whole run replaces the
estimate of 12.1 with a measure. The start's own time is unmeasured; it changes cost and never a
verdict.

The test holds the differences to the register through `cases.hold("proof6", ...)`, as every check
does. No entry of either register names `proof6` and none will (11.3), so any difference fails.

`proof/checks/test_proof6_controls.py` proves the judge sees what it must, with planted cases and no
HQ: a recorded source with one option label swapped gives one `value` difference at that option; a
recorded source with an unknown key gives `reading@A` `/unrecognized`; a Nova-born document differing
from its read by one canonical pair gives none; an `hq-authored` one differing so gives one at A and
at B and none at B-edit (5.1); and a document whose declaration the reading does not offer gives one
at `/appSettings/runsOnlyOn`. This is a `proof/checks` package test that runs the bundle, which 5.6
keys.

### 5.5 `canon`: part 09's closed list

Part 09 (09-acceptance-and-the-first-publish.md, section 9) owns the list: `lib/commcare/reader/
canon.ts` exports `CANONICALIZATIONS`, each row `{ id, kind: "one-wire" | "not-carried", apply }`,
and `canonDocument(doc)`. Proof 6 calls `canonDocument` and nothing else: this part keeps no list of
ids, no count of them, no `canon` of its own and no second equal-bytes test, and the lane-side list
of canonicalization ids is `CANONICALIZATIONS`' own.

Part 09 proves each row prints equal bytes (`lib/commcare/reader/__tests__/canon.test.ts`) and
holds the list complete over the fuzz corpora with no HQ (`canonReadBack.fuzz.test.ts`). Proof 6
is the third hold, and the only one over every corpus document on a source HQ normalized and
served: P5 adds what its run finds to `CANONICALIZATIONS`, never to a list here. What the
comparison leaves out of both documents, and why that and the `not-carried` rows are disjoint, is
part 09's too (its section 9.1, with `notCarried.test.ts`).

### 5.6 The store key

`proof/store/keys.py` gains:

```python
READER = "native/reader"

def reader_digest(corpus: Path) -> str | None:
    """The reader bundle the corpus carries (``native/reader/``): its bytes. None without one."""

def judged_under(judge: str, reader: str | None) -> str:
    """The judge component of a corpus document's judged key: the judge's fingerprint and the reader
    bundle a judge of it runs."""
    return hashed("judge", VERSION, judge, reader)
```

- `keys.NATIVE_UNREAD` gains `"reader/"`, so `native_digest` does not move with the reader and no
  native family runs again for it.
- `proof/store/queue.py::Builder.document` passes `judged_under(fingerprints["judge"],
  reader_digest(corpus))` to `group_key` for a group of kind `corpus`, and the bare fingerprint for a
  `control`: a control holds no document, so no judge of it runs the bundle.
- The queue records the digest as `reader` beside `fingerprints`; `proof/lane/blocks.py` writes it
  into each block's manifest; `proof/store/pack.py` computes the same component from the manifest
  and refuses outputs written under two reader digests, as it refuses two judge fingerprints.
- `queue.py::PACKAGE_DATA` gains the kind `reader` (`reader_digest`), which `package_data` digests
  beside `documents` and `native`, for every package whose tests run the bundle: `proof/matrix`
  (`{"documents": ("proof/matrix/conftest.py", "DOCUMENTS"), "reader": EVERY}`: `test_retained.py`
  writes each `expected.json` and reads every variant with the bundle) and `proof/checks`
  (`{"documents": EVERY, "reader": EVERY}`:
  `test_proof6_controls.py` and `test_parity_controls.py` run it over planted records, and with
  `documents` alone a reader change would leave their stored verdicts standing). The rule, held by
  a new case of `proof/lane/test_blocks.py` over the import graph it already walks: a package whose
  test modules or conftests reach `proof.checks.readerbundle` names the kind `reader`, and no other
  package does.
- No part key, storage key, document key or transcript key names it: the bundle lives outside every
  document's directory, and the store's guard never admits it to an open observation.

`proof/store/test_keys.py` gains `test_a_changed_reader_bundle_judges_every_corpus_document_again_
and_observes_none`: over a store holding a whole run, a corpus whose `native/reader/reader.mjs`
differs by one byte and whose documents are the same queues every `corpus:` group as `judged`,
every `control:` group as `cached`, no group as `observed`, the `proof/matrix` and `proof/checks`
package groups to run again, and every other package group, the native ones among them, as cached.
`proof/store/test_pack.py` gains the two-digest refusal.

So a reader change costs what a judge's file costs: every document judged again from its records,
about twelve minutes on three shards as `proof/README.md` models it, with the controls left cached.
One thing is observed, and only when a reading itself changes: a base's `document.json`, its
`expected.json` and its `first-publish.json` are what the bundle read of the retained answers
(2.1, 9.2), so a reader change that changes a base's reading changes those files, the base's
document key with them, and the base is observed again, exactly as an emission change to a
Nova-born document would be. The same change adopts the new `expected.json` files into
`proof/hq-apps/` (`python3 -m proof.matrix.adopt`, section 14), which `test_retained.py` holds.

### 5.7 The rule in `proof/CLAUDE.md`

The rule "Observation is separate from judgment" gains, after "import neither HQ nor Django":

> Three judges run one product of Nova's: `proof/checks/proof6.py`, `proof/checks/parity.py` and
> `proof/checks/changes.py` run the reader bundle the corpus carries (`native/reader/reader.mjs`,
> built by `proof/reader/build.mjs` in the corpus job) under the image's Node, through
> `proof/checks/readerbundle.py`. The bundle reads its requests file and nothing else, and its
> digest is part of every corpus document's judged key (`proof/store/keys.py::judged_under`), so a
> judgment stands for the reader that made it. No other judge runs a product of Nova's while it
> judges; the corpus reader's `emit_corpus` runs the emission before any judging. The bundle is
> never run inside an observation, so a reader change observes no Nova-born document again; a base
> whose reading changes is emitted anew and observed again, as an emission change would be.

`proof/checks/test_judge_purity.py` gains the case that `readerbundle.py` imports only the standard
library, `proof.processes` and `proof.native.produce` (where the corpus's products are found), that
no judge but the three imports it, and that no module of the observation's import closure does.

### 5.8 The Vitest rung

The fixed point is held outside the lane three ways, each cheaper and narrower than proof 6:
`bases.retained.test.ts` over every retained base (section 10), part 09's
`canonReadBack.fuzz.test.ts` over the fuzz corpora, and part 09's one case over HQ's retained
answers for `navigation-base`, `readBack.retained.test.ts` (its section 9.1, which also says when
that case is not written). Only proof 6 reads HQ's normalized answer for every corpus document.

---

## 6. The bases

### 6.1 Rules every base keeps

- It is made only of what Nova holds, kept at HQ's value or reads past: its `expected.json` is
  `reads: true`, and the manifest check over A reports nothing.
- It is authored under a lane configuration at CommCare 2.57.0 with the flags, privileges and case
  search its content needs and no other (`Base.configuration`), and declares the platforms Nova's
  own rule gives its content. Where a base must declare Android for a kept row
  (7.5, rule 2), its content is chosen so the rule gives Android; a declaration
  is never written to make the lane pass.
- It is read under one declaration, which `base.json` records. Part 09's `AcceptedReading` offers a
  reading's declarations, each with its own `mutations` and its own first-publish list, and one is
  preselected. `Base.declaration` is `None` for the preselected one, which is what a person who
  changes nothing in the review gets, and is stated for the three bases that exist to show a
  change that depends on the choice (part 09's `web-apps-turned-on`, `web-apps-turned-off` and
  `date-and-time-questions-split`, its section 11.2): `hq-new-app` (both platforms over an app
  whose Web Apps setting is off),
  `hq-connect-deliver` (Android only over one whose setting is on) and `hq-questions` (the
  date-and-time split taken). D is the reading under that declaration, and
  `hqAuthored.firstPublish` is that declaration's list. Stating one is no choice made to pass the
  lane: the declaration is the person's to make in the review, and each stated one is a choice the
  reading itself offers, or the emission stops (L13).
- Where this part says a base with no stated declaration declares a platform, it means its
  preselected declaration does, by the rule the reader proposes with (part 06,
  06-the-reader-forms.md, section 16.3, step 4): where A holds Web Apps off, Android only where the
  content runs there; where A holds Web Apps on, the first choice that keeps Web Apps, which is
  both platforms where the content runs on both. So a base whose content Android runs is read
  under a declaration that includes Android whatever its Web Apps setting, and one that must be
  read as both platforms is authored with Web Apps on. The base's `expected.json` records the
  declaration it was read under (7.1), `bases.retained.test.ts` holds every reading to it, and 7.5's rule
  2 and 6.4's rules read it there. A reading that proposes another is a reader defect (P2, outcome
  R), never a reason to state a declaration.
- Every string, name and value in it is invented for the lane. No base holds a client's content.
- Its registry row's `exhibits` names each entry it is built to exhibit: every kept entry
  (`KEPT_AT_HQ[...].base`), every entry a first-publish change reads, and every entry its row of
  6.2 names. `proof/matrix/test_retained.py::test_a_base_exhibits_what_it_names` requires each named
  entry among the entries the bundle's claim log counts for the base.

### 6.2 The twenty-two

How each is authored: "pages" is HQ's views through `operations.session_post`, "builder" a save in
HQ's vendored form builder, "models" HQ's own models with `app.save()`, "template" HQ's own
`import_app_from_doc(_load_app_template(slug), domain, {"created_from_template": slug})`, the first
call of `views/apps.py::load_app_from_slug`, followed by that loader's media calls over the lane's
stand-in files (6.3), each mapped at `MULTIMEDIA_PREFIX + path` as the loader maps it. The loader's
last call, `_build_sample_app` (a build of the new app, released), is left out on purpose: nothing
Nova reads of an app is a released copy of it, and the unit builds A itself.

`template_apps/` holds a fourth directory, `wash_before_cond_case_update`: `wash`'s `app.json`
without `update_mode` at its 52 case updates and `doc_type` at 20 (72 pointers), with the same
seven `multimedia_map` entries and no `multimedia.json`, so the loader attaches no file to an app
made from it. It is no base. Its content is `starter-wash`'s. A map entry whose file the project
space does not hold is part 11's "no file" (11-project-data.md, section 3): HQ answers that read
404 (`hqmedia/views.py::ViewMultimediaFile.multimedia`), which part 05 reads as `missing`, and part
11's `media.test.ts` holds what follows. A base is added for what it exhibits, and coverage is by
manifest entry (7.5), not by template.

| Id | Authored by | What it holds, and for whom | Edit |
|---|---|---|---|
| `hq-plain` | pages, builder | section 3 | yes |
| `hq-new-app` | pages, builder | `default_new_app` then `new_module` with no case type posted, so the type is `case` (`_init_module_case_type`), the registration form given one text question in the form builder and its case name set. None of the fifteen settings is saved (part 01, 01-the-bar-and-the-manifest.md, section 7.3), and Web Apps is off, as `Application.cloudcare_enabled` defaults. Declaration: both platforms, so the first publish turns Web Apps on (part 09's `web-apps-turned-on`). Part 01's Run 3 reads it | no |
| `hq-saved-pages` | pages, builder | `hq-new-app`, then every app-manager section saved once with nothing changed, as proof 4 saves them: app settings, add-ons, UI translations, the menu's settings, its case list with its search, its case detail, each form's settings and case management, and each form in the form builder. It exhibits what each page writes on a save: the nine tile cell keys off a tile (the INERT entry part 01 section 3.2 cuts for them), `case_tile_field: ""`, and the profile settings a save of the settings page writes that no runtime reads, each an INERT entry at `15a00a97` (`application-and-settings/3-properties-purge-freq`, `6-properties-log-prop-weekly-within-its-choices`, `7-properties-log-prop-daily-within-its-choices`, `12-properties-user-reg-server`, `14-properties-restore-tolerance`, `16-properties-loose-media`). A stored-source difference at any of them is under part 09's `forms-and-settings-rewritten`, whose lane allowance is every pointer the claim log holds as `inert` (9.3) | no |
| `starter-health` | template, stand-in media | HQ's health starter: two display-only menus, a Register action that returns to the list with an icon, a case list filter, an ascending sort with blanks last (part 03), three case forms whose logic reads the case (none through a `case_preload` entry and none through a default), one `case_list_form` block with a blank form id (menu 2), ten media paths at HQ's own paths, profile values Nova does not seed (`cc-fuzzy-search-enabled: yes` among them), `secure_submissions: true`, `mobile_ucr_restore_version` 1.0, `created_from_template`. Its preselected declaration is both platforms: the template holds `cloudcare_enabled: true`, so its configuration holds `CLOUDCARE` and HQ's import sets the setting on from the plan (`models/applications.py::_create_app_from_doc`), and nothing it holds is unavailable on either platform (6.1). Part 01's two `mirrors` rows on this base (`23-properties-cc-fuzzy-search-enabled`, `43-hq-secure-submissions`) need a declaration that includes Android (7.5, rule 2), which that rule gives whatever the setting. Parts 01, 02, 03; part 08's E6 | yes |
| `starter-agriculture` | template, stand-in media | four menus and nine forms, five Phone Number questions (part 03), a child case, six forms whose questions default to a case's value (form builder defaults reading `#case/`; no `case_preload` entry), a date-descending sort, `translations.fra` for a language outside `langs` (kept runtime UI keys, part 01), a Register action that goes on with the new case, three `case_list_form` blocks with a blank form id (menus 0, 2 and 3). E6 | no |
| `starter-wash` | template, stand-in media | four display-only menus beside one with a case list, three forms that open a child case, three `case_list_form` blocks with a blank form id (menus 2, 3 and 4; menu 0 holds none) (part 02's INERT row). E6 | no |
| `hq-kept-settings` | pages, models | Web Apps turned on through `edit_app_attr`, so its preselected declaration is both platforms (6.1); holds each of the fifteen settings at a choice other than Nova's seed, `cc-log-entity-detail-enabled`, the credential level, a runtime UI text key in each of two languages, `secure_submissions: true`, `practice_mobile_worker_id`, `logo_refs` on both Android slots, `mobile_ucr_restore_version` 1.5, `persistent_menu` and `show_breadcrumbs` on, `location_fixture_restore: both_fixtures` written through the model, since HQ's settings page does not offer it (`location-list-setting-reset`), one language with a display name and one without; and `custom_base_url`, a second origin with a path (`https://example.org/hq/`, as part 01's vectors hold one), posted through the app settings page's save (`views/settings.py::edit_commcare_settings`), whose `edit_app_attr` with `all` takes it always; the attribute's own URL answers 400. HQ joins each address to it with `urljoin`, which keeps the origin alone, so this base shows Nova's archive taking the origin as HQ's build does. Formplayer and a device already reach the lane's HQ under any origin (Formplayer's `RewriteHostRequestInterceptor.java`, the lane's `PeerUrls.java`, `proof/android/peer.py`); where another reader does not, its routing in the lane is taught the same and the value stays, and it is never a walk stop. Every labelled row of `KEPT_AT_HQ` (part 01 section 5). It is not `targeted-kept-values`, which stays in the corpus as the kept rows' control: that document is a Nova-born app whose kept values a person saved in HQ after Nova's first publish, on a deployment Nova created (seeded with Nova's own settings, ledger origin `push`), and this base is an app made in HQ and brought in (seeded with none, origin `read`). `KEPT_AT_HQ` binds both, and part 01, section 7.3, makes the two publish differently | no |
| `hq-languages` | pages, builder | three languages; a label blank in one whose first-language text is not (`blank-translations-filled`, part 09); a text whose languages share one itext id and one renamed id (part 06); a generated translation key equal to HQ's own text and one that overrides a menu name (`translation-overrides-folded`, part 01 section 7.1) | no |
| `hq-menus` | pages, models | a display-only menu under a parent that is one, a display-only menu at the top level beside a case-first menu, Register offered always with each return and with media, a Register action whose label holds no text in any language beside its form (`registration-label-fixed`, part 02 section 11.8), the case list menu item with a label and, on another menu, one whose label holds no text (read as the words HQ's build writes, under `list-settings-respelled`: part 07, Departure 15), a menu and a form display condition, a child menu, an after-submit link with an otherwise, an after-submit link that carries a case by hand onto a form of a single-case menu, with no held-case guard in its condition (`link-held-case-guards-added`), a deep link id on a form and on a case list (part 02 sections 4 to 11; part 07's menu readings) | no |
| `hq-questions` | builder | every question kind of part 06 section 9.1's held rows; a Phone Number question; a Question List at the root; a count repeat over a question and one over a Hidden Value; a model-iteration repeat inside Nova's rule; a label holding a date chip; a help text typed plainly and one typed with formatting; a hint typed plainly and one typed with formatting; a validation message; a validation holding an inline count (`validation-counts-moved`) and a validation message that shows an answer (`validation-messages-composed`); a date-and-time question, with the declaration `splitDatetime: true` on both platforms (`date-and-time-questions-split`); a second form with Disable Text Formatting on; a group whose appearance is written `Field-List`, put in through the form page's upload after the form builder's save (`ops.set_form_source`, 7.2), since the form builder writes the token in lower case (parts 03, 06 and 09) | no |
| `hq-names` | pages, builder | a hyphenated question id, a one-choice select, a choice value holding an apostrophe, a case property and a search field name holding a hyphen, the update keys `category` and `state` (part 04) | no |
| `hq-case-management` | pages, models | part 07's same-state readings, one form a reading: an external id on `open_case`; `update_case` under an `if` condition; a parent index with `reference_id: "parent"`; a preload no later default reads; a child case with a close condition; a usercase update and preload; a form that opens one child case outside a repeat (`registration_alert_child_case`). The external id, the index and the preload are what `case-settings-respelled` rewrites (part 09, section 11.2: `external-id-in-update`, `subcase-index-unnamed`, `preload-as-default`). Its configuration holds the flag `SAVE_ONLY_EDITED_FORM_FIELDS`, and one property write of a follow-up form is saved only if changed, set on the Case Management page, which writes `update_mode` (`js/forms/case_config_ui.js`): the flag read answers `applied` and the write reads as `onlyIfChanged` (part 07, section 3.2). One more follow-up form holds what an app Nova published before this step holds (`date-and-time-saved-as-hq-stores-it`, part 09, section 11.2): a date-and-time question saved to the case through the hidden sibling `nova_datetime_<question>`, whose calculate is the spelling Nova wrote before this step, `lib/commcare/xpath/wire/instant.ts::typedInstantValue` of the question (part 03, 03-questions-and-text.md, section 7.1). No page of HQ's writes that node, so the builder puts it in through the form page's upload after the form's own save (`ops.set_form_source`, 7.2) and names its path in the form's case update. The reader reads the sibling under either spelling and records the id for the earlier one alone, so a builder whose text is not that tree leaves the id on no base, and 7.5's rule 3 fails by name. The id's other recording site, a Save to Case value in the earlier spelling, is on no base: part 09's `lib/deployment/reading/__tests__/firstPublishChanges.test.ts` holds both sites (its section 11.3), and what the lane adds is the change itself on a real publish, which one site shows | yes |
| `hq-advanced` | models | an advanced menu whose forms load a two-menu chain and write to the parent load, and one whose parent load is read only; an advanced preload no later default reads; and, in a project space without `SAVE_ONLY_EDITED_FORM_FIELDS`, `update_mode: "edit"` stored through the model on one property write of a basic follow-up form and on one write of an advanced load: the flag read answers `not-applied`, the first reads as saved every time and is respelled under `case-settings-respelled`, and the second is read past under the INERT entry `forms-and-case-writes/update-mode-edit-in-a-project-space-that-saves-every-time` (part 07, sections 3.2 and 14) | no |
| `hq-nova-then-builder` | Nova's publish, builder | `targeted-save-to-case-shapes`'s first publish as the corpus captured it, then every form saved in the form builder: Save to Case blocks and generated nodes as the builder writes them back (part 06's R1 shape, and part 07's check of a form-builder save). The document (`proof/targeted/documents/saveToCaseShapes.ts`) holds the eight Save to Case arms that check lists (a root create, a keyed create, a create in a repeat, a conditional update, a close, a several-case form, the own arm in a block, the own close's block) and one form with no Save to Case operation holding a validation with a lifted count (part 06's R1 shape). Its `app.json` is HQ's stored app after those saves. The builder applies the corpus document's captured first publish with `proof.observe.publish.create`, as `proof/hq/test_retained_reads.py` publishes `navigation-base`, reading the document through `proof/matrix/conftest.py`'s `documents` fixture, whose `DOCUMENTS` names it so the package's key moves with it (`queue.py::PACKAGE_DATA`). It is the one base Nova's emitter can stale: a change to that document's capture fails `test_retained.py` on this base, and the same change adopts it again (`python3 -m proof.matrix.adopt`), which L3 says | no |
| `hq-case-lists` | pages | a detail column its list lacks, read as a column that is not on the list with no change at the first publish (part 07, section 11.6), a sort rule on a property no column shows (`sort-rule-kept-as-hidden-column`), sort rules with each type word and with blanks first and last, a plain, a date, a phone and an ID-mapping column, a calculated column, a multi-select list whose `max_select_value` is `-1` and a list with no sort elements under an invisible first column (`list-settings-respelled`; part 07's same-state readings `detail-max-select-value-on-a-multi-select-basic-list` and `no-sort-elements`); its case list filter compares a date property with a quoted date (`dob > '2000-01-01'`), part 08's positive control of the typed-literal fold, with a value expectation in 6.4's file. It is authored so its preselected declaration includes Android: its `caseList` expectations run on the local archive (6.4) (parts 03, 07 and 08) | no |
| `hq-search` | pages | `SYNC_SEARCH_CASE_CLAIM` and case search on; a search with no title; search fields of each held kind; a list filter the search restates (`search-restates-list-filter`); a search-only filter row order HQ ANDs (`search-filter-rows-recut`); a filter row that compares a property with a search field's answer (`search-value-guards`); on the `inline_search` menu, whose forms read the search, a filter row that reads no search field and restates no clause of that menu's list filter (`search-filter-joined-to-list`, part 07 section 12.3, kind F); a bare date-and-time comparison, an absolute read in a default and a search row calling `today()` (part 08; the last is `search-today-device-day`); each of `auto_launch`, `default_search` and `inline_search` on a menu of its own (parts 03, 07 and 08) | no |
| `hq-expressions` | builder | a form holding one expression for each expression rewrite of part 08's section 2.3 whose behavior changes: a bare comparison of two dates and times, an unguarded table read, a row predicate without `current()` and a session value read with no guard; and, beside them, a default that reads another question (`default-reads-current`, which changes no behavior and expects no register id) (part 08, 08-the-reader-expressions.md, section 2.3; part 09's Copy C2 holds each rewrite's sentence) | no |
| `hq-media` | models, stand-in media | image, audio and video on a label, a choice, a menu and a form at HQ's own paths; one file two paths name (`media-paths-joined`); a path differing from another only by case, a path HQ's upload cannot match and a path in Nova's derived shape that names other bytes (each `media-files-renamed`); a `multimedia_map` entry nothing references (`unused-media-entries-removed`); a menu icon whose path has no map entry (`media-references-with-no-file-removed`). Its hop also holds part 10's assertion on held paths: every held path keeps its `multimedia_id`, its `unique_id` and its resource version across the two builds (part 09, section 11.2; part 10, sections 4.2 and 4.7; part 11, section 3) | no |
| `hq-lookups` | pages, builder | a global table a select reads through an itemset, a second table the form declares and nothing reads, a table whose tag holds a hyphen, an itemset filter comparing a column with an answer (parts 04 and 11) | no |
| `hq-places` | pages, builder | two levels with a location property, six active places and one archived, a form whose logic reads the worker's place and its parent (part 11 section 11) | no |
| `hq-connect-deliver` | pages, builder | a Connect Deliver app: one deliver unit and one task, `auto_gps_capture` off, so Nova's publish turns it on (`connect-app-captures-location`, which applies where the source does not hold it true), and Web Apps turned on through `edit_app_attr`. Declaration: Android only, which a Connect app is, so the first publish turns Web Apps off (`web-apps-turned-off`) (parts 01, 07 and 09) | no |
| `hq-connect-learn` | builder | a Connect Learn app, Android only: one form holding a learn module and an assessment, each with a name, a description and a score or time the block reads (part 06, section 15: the learn module and assessment rows). Its expectations fix the module's and the assessment's ids and the assessment's score as Core gives them. A Connect app is a learn app or a deliver app (`lib/domain/blueprint.ts`, the `connectType` check), so the two block kinds of each need two bases | no |

Sixteen authored bases (`hq-kept-settings` to `hq-connect-learn`), three starters, and `hq-plain`,
`hq-new-app` and `hq-saved-pages`.

Where the hop on `hq-media` fails part 10's assertion, the remedy is part 10's (its section 4.7),
and the base is dispatched again.

### 6.3 The starter apps' media

HQ's template apps name their media in `multimedia.json`, a map of path to a URL that
`load_app_from_slug` fetches (`urllib3.PoolManager`), skipping a file whose fetch fails: "It's not a
big deal if a template app is missing a file." The lane refuses every socket, and the files are not
Nova's to redistribute.

**Decision: stand-in files, made by the lane and attached with the code HQ's loader uses.** For each
path of a template's `multimedia.json`, `proof/matrix/media.py::stand_in(path: str) -> bytes` makes the
bytes of a file of the kind the path's extension names: for `.png`, a PNG of one pixel whose colour is
the first three bytes of `sha256(path)`; for `.mp3`, one silent MPEG frame followed by an ID3 comment
holding the path. Each is a distinct, valid file of its class, so `CommCareMultimedia.get_class_by_data`
classifies it and `get_by_data` gives each its own document. It is attached exactly as the loader
attaches a fetched file (2.4). `proof/matrix/test_media.py` holds each stand-in to HQ's own
classification and to `lib/media/validate.ts`'s through a retained pair Vitest reads.

This is a named stand-in, and `proof/CLAUDE.md` gains it among the lane's accepted seams:

> *A starter app's media files are the lane's own* (`proof/matrix/media.py::stand_in`). HQ fetches a
> template app's media from addresses the lane does not reach, and attaches whatever it fetched;
> the lane attaches a file of the same kind at each path with the same calls
> (`load_app_from_slug`). What a picture shows is no claim the lane makes; where it sits, what kind it
> is and that Nova keeps it there are.

`hq-media` uses the same function for its own files, with one file attached at two paths.

### 6.4 Value expectations: the positive controls

`proof/matrix/hand/<base>/expectations.json`, written by hand from what the base's builder authors and
never from a reading:

```json
[{
	"id": "members-loaded-from-the-case",
	"entry": "forms-and-case-writes/case-preload-question-property-into-a-question-outside-any",
	"form": { "menu": 0, "form": 1 },
	"restore": "restore.xml",
	"request": { "session": { "data": { "case_id": "household-two" } },
	             "expressions": ["/data/members"] },
	"expect": [{ "pointer": "/values/0/value", "value": "10" }]
}]
```

The example is `hq-case-management`'s, whose follow-up form loads `members` through a
`case_preload` entry made with HQ's models; the entry named is the HELD row for a load no later
default reads (`load-as-default-same-state`). `hq-plain` loads the same value through a form
builder default, and its expectation names the entry part 06 claims a default's `#case/` read
under.

An entry is `proof/targeted/expected.ts::Expectation` less `export`, with `form` as HQ's positions
and two more keys, `entry` and `exports`:

- `form` names HQ's positions; the entry writer resolves it to D's form UUID through the reading's
  identities.
- `restore` is always stated, and names a file of the base's hand directory. Each base holds one
  `proof/matrix/hand/<base>/restore.xml`, written by hand: the worker, each case its expectations
  turn on with its id, type, name, index and property values written out, and, for `hq-lookups`
  and `hq-places`, the item lists and the location fixture its expectations read. An expectation
  runs over the restore it names or the lane's template restore and never over the seeded case
  database (`proof/observe/intent.py::_restore_path`), and a value a person is to fix by hand must
  come from a case a person wrote: here `household-two` holds `members` 10 because the file says
  so. The seeded database (2.6) stays what proof 3's walks run over.
- `request` is `EvaluateRequest` as it stands: `session.data` keyed by datum id, `expressions`,
  `answers` and the rest. A datum id is the one HQ's suite gives the form (`case_id` for a basic
  form that needs a case; an advanced form's own). One request serves all three states: HQ builds
  A's suite and B's from one menu structure, and proof 3 already replays A's sessions on the local
  archive, so a datum Nova's own suite named otherwise is a proof 3 difference before any
  expectation runs.
- `expect` is `ExpectedValue[]`: `{ pointer, value }`, the pointer into Core's result
  (`/values/<n>/value` for the n-th expression, as the targeted documents write it).
- `exports`, optional: the states it runs at, a subset of `["A", "B", "local"]`. Absent means all
  three, which is every expectation but the before and after pairs of a declared change and a
  `caseList` request (below). A `caseList` request runs on `local` alone
  (`proof/observe/intent.py::expectations`).

The entry writer copies `restore.xml` into the document's directory (a plain `.xml` name, which
`documents.ts::checkDocumentFileName` admits) and writes one `Expectation` for each state the entry
runs at into the document's `expected.json` (A, B, and the local archive where the declaration D
was read under includes Android, `hqAuthored.declaration`), dropping `entry` and `exports`, which
only the matrix tests and the writer read. One value must hold in HQ's original, in Nova's
republish and in Nova's archive, so a reader that reads `selected(#form/a, 'x')` as `#form/a = 'x'`
fails on B against a value a person fixed.

Rules, held by `proof/matrix/test_expectations.py`:

- Every base's `restore.xml` parses, every `case_id` and other datum value an expectation names is
  a case of it, and every case type and property it writes is in the base's `seed.json` catalog, so
  a hand restore cannot drift from the app it is written for.
- Every base holds at least one expectation a form.
- Every HELD entry a base's `exhibits` names whose claim sits in a form (`artifact`
  `form:<m>.<f>`) has an expectation naming it in `entry`, on that form.
- Every HELD entry a base's `exhibits` names whose claim sits in the app's JSON under a case list
  or a case detail has a `caseList` expectation naming it, run on the local archive (`exports:
  ["local"]`), fixing the rows a filter text or a sort column gives. Such a base is authored so its
  declaration includes Android, and the test refuses it otherwise. Proof 2 compares A's and B's
  suites whole as well. A search entry has no expectation: a `caseList` request's `searchText` is
  the list's own filter box, not HQ's case search. Proof 2 (the suite's remote request) and proof 3
  with the readers hold it, where Formplayer and a device search through HQ's search view on A and
  on B.
- Every register id a base's `expected.json` lists in `firstPublish` whose entry holds a `proof3`
  row in `proof/first-publish-changes.json` (which only an entry whose `touchesWorkers` is true
  may: part 09's Vitest holds that) has a pair of expectations named `<id>:before` (run on A alone)
  and `<id>:after` (run on B and the archive), whose values differ: the declared change, shown.
  This is the second half of hold 3 (9.3).
- A multi-select question an expression tests has an expectation answering it with two choices.
- A base whose `app.json` holds more than one language is read under a declaration that includes
  Android (its `expected.json`'s `declaration.runsOnlyOn` is not `web-apps`), so proof 3 compares
  its app strings with an archive's (section 4).

The intent judge reports an expectation that fails as it does for a targeted document; on an
`hq-authored` document `changes.declared` never holds one, so a failed expectation fails the lane.

### 6.5 Edits

Three bases state one, each `proof/matrix/hand/<base>/edit.ts` exporting
`edit(doc: BlueprintDoc): readonly Mutation[]`, which finds its targets by external key
(`externalIdentityMap`) so a re-reading at a new pin needs no hand edit:

| Base | The edit | Proof 5's footprint |
|---|---|---|
| `hq-plain` | 3.2 | both forms |
| `starter-health` | the follow-up form gains an integer question saved to a new case property | that form, its menu's case type |
| `hq-case-management` | the child case gains one property write | the form that opens it |

### 6.6 Saves in CommCare HQ that Nova brings in

Part 15 adds ten targeted documents, each a Nova-born document with an `hq-side.json` whose saves
change the app's content and whose `republish` is `brings-in` or `proceeds`
(`15-changes-made-in-commcare-hq.md`, "Tests", "The lane", which holds the list, the view each
save reaches and the five checks a `brings-in` document holds). None is a base: each starts from
Nova's own publish. What this part holds of them:

- `proof/corpus/documents.ts::HqSideSaveKinds` gains ten kinds: `formLabel` and `formResave`
  (through `proof/editors/vellum.py::open_and_save`, which gains one edit step between open and
  save), `questions`, `formAttribute`, `formActions`, `moduleAttribute`, `moduleDetail`,
  `formsAddedAndRemoved`, `order` and `mediaReplaced`, each made in `proof/observe/hqside.py`
  through the view a person's save reaches, which part 15's table names. The location list's
  document saves through `appAttributes`, a kind the corpus already has. `HqSideSaves.republish`
  gains `"brings-in"`, with `bringsIn: PersistableDoc`, the document the bring-in must give, and
  `hqside.py::STATEMENTS` gains `bringsIn`.
- `proof/checks/corpus.py` reads the new outcome: a `brings-in` document's export holds the
  review, the bring-in and the publish that follows, written by the capture as it writes every
  publish (`proof/corpus/publish.ts`, which holds the stated outcome as it holds the other
  three). Its checks are part 15's five, and the fifth is proof 6 over the document the bring-in
  gave.
- `_Unit.api_reads` (5.3) reads CommCare HQ for the ten after their saves, under the label
  `saved`: the source Nova's review reads. For a `brings-in` document it reads again after the
  republish, and part 15's fourth and fifth checks take that read. Proof 6 makes its claim of the
  second read alone, against `bringsIn` with `canon`: the first is a person's save and not Nova's
  export.
- `proof/observe/publish.py::upload_media` gains part 15's hold W4: for every entry of
  `matched_files`, the app's map holds that `m_id` at that path. Every unit whose publish sends a
  file runs it.
- The ten ride the `mechanics` dispatch of the step's new targeted documents (12.4), which runs
  W4 for the media document.

---

## 7. Variants, what HQ never serves, coverage

### 7.1 `expected.json`

A base holds one, written by the lane: `{ "reads": true, "declaration": { "runsOnlyOn": null,
"splitDatetime": false }, "claimed": [...], "firstPublish": [...] }`: the declaration the base was
read under (6.1), the entry ids its claim log counts, sorted, and that declaration's first-publish
ids in register order. A variant holds none: its expectation is its row (7.2).

### 7.2 Variants

A variant is one change over a base, made in HQ and read where it is made. Its row is data, so
the coverage test can read it: `proof/matrix/variants.json`, one row a variant.

```json
{ "id": "hq-names/quoted-choice-value", "base": "hq-names",
  "entry": "questions/choice-value-holding-both-an-apostrophe-and-a-double-quote",
  "standing": "not-yet",
  "place": { "kind": "question", "menu": 0, "form": 0, "menuName": "Households",
             "formName": "Registration Form", "name": "village" },
  "change": { "op": "named", "name": "quoted_choice_value" } }
```

`entry` is the finding's `code`, and `standing` and `place` are part 01's `Finding` members
(`lib/publish/hqFindings.ts`), `place` an `HqPlace`. `change` is one of two:

- `{ "op": "set-json", "pointer", "value" }`: `proof/matrix/ops.py::set_json` sets the value at
  the pointer in the stored app's JSON, wraps the whole document (`dbaccessors.py::wrap_app`) and
  saves it. That is how a value no page writes enters HQ: its import and its update both wrap the
  document they are handed before they store it (`models/applications.py::import_app_from_doc`,
  `overwrite_app_from_source`). The pointer addresses the app as HQ's source read serves it.
- `{ "op": "named", "name" }`: a function of `proof/matrix/variants/<area>.py`, one module a
  manifest area, built from the changes builders share (`ops.set_form_source`,
  `ops.builder_save`, `ops.post`). `proof/matrix/registry.py` loads the file and refuses a row
  whose named function does not exist and a function no row names.

A holding row adds `"holds": [{ "key", "pointer", "value" }]`: the document fragment the reading
must hold, `key` the external key text of the entity and `pointer` a pointer into it. The one
composed row (`two-refusals-one-pass`) adds `"second"`, a second `{ entry, standing, place, change
}`. A row whose value HQ never serves adds `"hqNeverServes"` (7.3).

`ops.set_form_source(m, f, edit)` parses the form's source with lxml, edits it, and posts the
result through the form page's own upload (`views/forms.py::_edit_form_attr`, the `xform` file),
so the variant is one a person can make. Where that view refuses the source, the function stores
it the way HQ's import stores every form (`models/applications.py::_import_app`, through
`save_attachments`, with no parse), and its docstring says so. `ops.builder_save(m, f, steps)` is a
save in the form builder after the driver's steps, for a class only the builder's own writer makes,
and `ops.post(view, ...)` a post to one of HQ's views. Each is HQ's own code.

**The test.** `proof/matrix/test_retained.py::test_each_variant_reads_as_its_row_says`. For each
base, after the base's tree is held, each row of the base is made in a fork of the base's state
(2.3, step 5), so no variant sees another's change. Its application resource, its source, its
version (`operations.current_version_read`) and the two project space lists are read through
HQ's API, in the order Nova's own read makes them, and those answers go to the reader bundle
as the input's `application`, `source`, `currentVersion` and `projectSpaces`, beside the base's
retained project data answers (`mode: "first-read"`, `identity: "mint"`, `claims: "full"`). So
the bracket closes on the variant's own save counter, and a variant answers its row and never
the stop `changed-while-reading`. The answer is held to the row:

- a refusing row: the reading is an `account` whose findings are exactly the row's `(code,
  standing, place)`, one unless the row composes two (Copy L12);
- a holding row: the reading is `read`, its claim log counts the row's entry, and each `holds`
  fragment is in the document (the answer's `held` carries, for each, the value found at that
  entity's pointer, 5.2);
- where Python decides the class (a REFUSED entry with a value-class reader, or one of 8.2's
  thirteen): parity's join (`proof/checks/parity.py::join(uses, claims)`, the pure function
  `parity.differences` calls) over the uses Python extracts from the variant's source answer
  that it does not extract from the base's, and the variant's claim log. Each such use must have
  a record at the same `(artifact, where)` naming the row's entry with a standing that projects
  to Python's (8.1's table). `unclaimed` and `unseen` are not judged on a variant: a reader that
  refuses a subtree claims nothing inside it. Every other row is listed by name as
  `unchecked_by_python`, so the count is seen.

So the three statements of a variant's class (its row, Python, the reader) meet in one test,
over what HQ answers at the pin on that run. Nothing of a variant is retained.

What moves out of Vitest is the variant over HQ's own bytes: a reader change that breaks only a
variant is first seen in the pull request's lane run, where the `proof/matrix` package group
runs again on any change to the bundle (5.6). The parts' own Vitest suites keep each rule table
by hand (part 06, "Tests", and parts 07 and 08 likewise), and `bases.retained.test.ts` keeps
every base, so the rung with no Docker still reads each reader rule; the lane adds HQ's bytes
for it.

**Which entries get a row.** Every REFUSED or HELD-NEW entry an app's source can hold: 576 at
`1f103305` (361 that name a key outside `schema:`, 207 that name `schema:` keys alone, and the
eight below that name no key), and each such entry the step adds, which each part names in its own
manifest section (parts 02, 03, 04, 06, 07, 08 and 11). And every allowing entry no base's claim
log counts, as a holding row. A `schema:`-only entry's row is a `set-json`, so HQ's own model
answers whether the value can exist (7.3). A class HQ's form builder cannot write (every
`not-hq-editable` class is one) is made with `set_form_source`, which is how such a form exists in
HQ at all.

Eight refusals name no surface key and are raised from an app's source, so each has a row:

| Entry | Disposition | Raised by | Base |
|---|---|---|---|
| `case-search/a-function-call-written-unparenthesized-as-the-2nd-or-later` | REFUSED | part 08, section 7 | `hq-search` |
| `expressions-and-data/declared-unreferenced-fixture-instance-the-project-space-does` | REFUSED | parts 06 and 11 | `hq-lookups` |
| `expressions-and-data/any-other-function-name` | REFUSED | part 08, section 9 | `hq-expressions` |
| `forms-and-case-writes/writers-int-decimal` | HELD-NEW | part 07, section 7 | `hq-case-management` |
| `forms-and-case-writes/writers-single-select-multi-select` | HELD-NEW | part 07, section 7 | `hq-case-management` |
| `forms-and-case-writes/any-other-mixed-writer-pair` | HELD-NEW | part 07, section 7 | `hq-case-management` |
| `forms-and-case-writes/a-datetime-question-saved-straight-to-a-case` | HELD-NEW | part 07, section 3.2; part 09, section 11.4 | `hq-case-management` |
| `questions/dtd-declared-entity-references-predefined-ones-such-as-amp-are` | REFUSED | part 06, section 8.2 | `hq-questions` |

The DTD row's change is a document type declaration with no entity reference, made by
`ops.set_form_source`. HQ's page refuses only a source that holds an entity node
(`xform.py::parse_xml`); whether lxml gives such a node for a declaration with no reference was
not read (lxml is no pinned checkout), and where the page refuses this source too the function
stores it as HQ's import does. Either way HQ holds the source and Nova's reader meets it, so the
row is never exempt. The ninth such entry, `application-and-settings/unknown-doc-type`, is
`stated-by-its-part`: the read stops before any reader runs (part 01, section 8.3).

The rows the other parts ask for by name, each a row of `variants.json`:

| Asked by | Rows |
|---|---|
| part 01 | on `hq-kept-settings`: a `logo_refs` entry holding only `path`, a `set-json` row naming `application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare` |
| part 02 | on `hq-menus`: a case list deep link on a display-only menu, a form display condition reading the case on a screen that chooses none first, a search on a display-only menu |
| part 04 | one an entry N1 to N24, on `hq-names`, `hq-lookups`, `hq-search`, `hq-case-lists`, `hq-menus`, `hq-connect-deliver` and `hq-questions` by the entry's area |
| part 06 | each refusal of its sections 8 to 13: a menu with no `unique_id`, a form with no `xmlns`, two forms of one `xmlns`, an empty `langs`, a real attribute that disagrees with its `vellum:` shadow (`shadow-disagrees`), the five appearance classes with no lane reader (its 9.2), and the entries it adds |
| part 07 | each entry of its section 14, and `hq-case-management/preload-read-later` (a preload a later default reads). The rows of `forms-and-case-writes/update-mode-edit-off-a-follow-up-form-s-own-update` are on `hq-case-management`, whose project space applies the mode (6.2). Only where a form-builder save changed a block's structure: `hq-nova-then-builder/save-to-case-saved` (P2, outcome C2) |
| part 08 | M1 to M8; M8 on `hq-search`, a form of a child menu under the menu whose forms read the search, reading a search field; on `hq-search`, a search row with fixed quotes HQ's interpolation would not write; on `hq-case-lists`, `#host/p` in the case list filter, expecting the filter's HELD-NEW entry of part 08 section 9.2 |
| part 11 | on `hq-media`, a question image whose path has no map entry (REFUSED where a runtime draws it); on `hq-lookups`, a form that reads a tag HQ's table list lacks, which a source alone exhibits. A table with a field property and one with a row attribute are no rows: both live in the lookup answers, which no variant changes, and their entries (`expressions-and-data/fields-properties-and-multi-valued-cells-name-lang-en-name-name`, `expressions-and-data/item-attributes-and-per-row-attribute-values`) name lookup keys alone, so 7.5 exempts them under `not-in-app-source` with part 11's Vitest over `proof/hq-reads/lookups/` as their evidence |
| this part | `hq-new-app/as-created`: the app exactly as `new_module` leaves it, whose registration form is the blank source HQ writes for a new form (`models/modules.py::Module.new_form`, `views/utils.py::get_blank_form_xml`) and holds no question: `fix-in-hq` under `forms-and-case-writes/blank-source-or-no-non-group-question` (`not-hq-buildable`); `two-refusals-one-pass`: two refused changes in two forms of `hq-plain`, both expected, which holds that a reading reports every finding in one pass (part 06, 06-the-reader-forms.md, Decision 1) |

### 7.3 What HQ never serves

A row can set a value HQ cannot hold or does not serve. Then no app's source carries it, and
Nova never reads it. A shape neither HQ nor Nova can make does not exist, and the lane checks
that on every run in place of assuming it. Two ways, each decided:

- **HQ refuses the change.** `wrap_app` or the named function raises.
- **HQ takes the change and does not serve it.** Its source read does not hold the row's value
  at the pointer: the key is gone, or holds another value.

In both the entry is exempt under `hq-never-serves-the-value` (7.5), and the row stays in
`variants.json` with `"hqNeverServes": { "raised": "<exception class>" }` or
`{ "notServedAt": "<pointer>" }`. `test_each_variant_reads_as_its_row_says` requires that
outcome of such a row on every run: HQ must raise that class, or its source read must not hold
the value there. So the exemption is held at every pin and ends by name where HQ starts to
serve the value (Copy L18). A row with no `hqNeverServes` whose change raises, or whose value is
not served while the reading is not the row's, fails with Copy L17, which says what to record
(P9). A value HQ serves in another spelling that the reader still answers as the row says is an
ordinary variant.

`lib/commcare/reader/__tests__/schemaKeyVariants.test.ts` keeps one assertion, which needs no
variant: at every pointer of every base's source, a key no entry names reads as `unrecognized`
at that place (part 06's totality test, over the bases).

### 7.4 What else holds a base and a variant to the manifest

`test_each_variant_reads_as_its_row_says` holds Python to each row where Python decides and
lists the rest as `unchecked_by_python` (7.2).
`proof/matrix/test_retained.py::test_a_base_exhibits_what_it_names` requires each entry a
base's `exhibits` names among the entries its claim log counts. That a base holds nothing
refused is the manifest check at A (section 4) and parity (8.1), and is not tested a third time.

### 7.5 Coverage

Every manifest entry is in exactly one of three sets or on the exemption list.

| Set | An entry is in it when | What it has run through |
|---|---|---|
| base-exhibited | some base's `expected.json` lists it in `claimed` | every proof |
| variant-exhibited | a row of `proof/matrix/variants.json` names it, and the row has no `hqNeverServes` | the reader over HQ's own answer in the lane; Python where 7.2 decides |
| exempt | `proof/matrix/exemptions.json` names it with a reason | nothing but what the reason names |

`proof/matrix/exemptions.json` is `{ "<entry id>": { "reason": <one of five>, "note": "<one
sentence>" } }`, with the closed reasons. An entry has one reason, the first of this order that is
true of it, so a part's own decision outranks a key-family reason:

| Reason | Meaning |
|---|---|
| `stated-by-its-part` | a part of this plan decided it, named in `note`: part 01's four `doc_type` entries (its 8.3: no reading claims one, because the HQ read stops first), `application-and-settings/unknown-doc-type` among them, and part 11's `expressions-and-data/fields-is-indexed` and `expressions-and-data/absent-field-vs-zero-values-vs-empty-string` (its 13.1) |
| `hq-never-serves-the-value` | HQ's import refuses the value, or its source read does not hold it, so no app's source carries it (7.3). The `note` says which. Every row of `variants.json` that names the entry carries `hqNeverServes`, and the lane requires that outcome on every run |
| `no-surface-key` | the entry names no key and is allowing (twelve at `1f103305`) |
| `not-in-app-source` | every key is of a family an app's source never holds: `lookup-model:`, `lookup-workbook:`, `lookup-code:`, `hq-api:`, `project-setting:` (17 at `1f103305`: 9 non-allowing, 8 allowing; 15 once part 11's two above are `stated-by-its-part`). The `note` of each names the test file that is its evidence, for a lookup entry part 11's Vitest over `proof/hq-reads/lookups/`, and rule 1 requires that file to exist |
| `only-in-a-build` | every key is `parser:`, which a runtime reads from a build (7 at `1f103305`, all allowing) |

`lib/commcare/surface/__tests__/entryCoverage.test.ts`, in ordinary CI, holds:

1. every entry id is in exactly one set or exempt, no file names an id the manifest lacks, and a
   `note` that names a file names one that exists;
2. **every kept entry is base-exhibited, and each one an archive follows is exhibited where an
   archive is made**. For each row of `KEPT_AT_HQ` (part 01, section 5):
   - the row's `base` is a base whose `claimed` holds the entry;
   - a row of kind `setting` whose `.ccz` cell is `mirrors` or `states` also needs its base to be
     read under a declaration that includes Android (its `expected.json`'s
     `declaration.runsOnlyOn` is not `web-apps`: only such an app is handed an archive, so only
     there is the cell observed)
     and to hold the entry's key at a value other than `schemaPropertyDefault` gives, or, for a
     profile property, other than Nova's seed (at the default the mirror and Nova's own constant
     are one value and the row shows nothing).

   A row whose cell is `own` or `no-reader`, and a row of kind `server-record`, `identity` or
   `project-state`, is at whatever value a base holds it: the rows on `hq-new-app` are there
   because a just-created app holds each at HQ's own default, which is the case those rows state;
3. **every source-rewriting entry is base-exhibited**: every id of `FIRST_PUBLISH_CHANGE_IDS` (part
   09, section 11.1) is in some base's `firstPublish`; and every `register` id a reading can record
   in `ReadFacts.sameStateRewrites` (part 07) is recorded by the reading of some base;
4. no entry is exempt under `not-in-app-source` or `only-in-a-build` while one of its keys is of a
   family `manifest_usage.py` extracts from an app's source (the family list is read from
   `proof/checks/fixtures/source-families.json`, which `proof/checks/test_manifest.py` holds to the
   extractor);
5. **no refusal is exempt for want of a key, and no exemption rests on an assumption about HQ**: no
   entry that is REFUSED or HELD-NEW is exempt under `no-surface-key`; every entry a registered
   claim of the reader names with the use `refuse` (`lib/commcare/reader/claims.ts::claimRegistry`)
   is variant-exhibited or exempt under `stated-by-its-part`, `not-in-app-source` or
   `hq-never-serves-the-value`; an entry exempt under `hq-never-serves-the-value` is named by at
   least one row of `variants.json`, and every row that names it carries `hqNeverServes`; and a row
   that carries `hqNeverServes` names an entry so exempt.

Its failure names the entry and what would settle it (Copy L7).

---

## 8. Parity

### 8.1 What is compared

The reader and the lane's Python check are two classifiers written apart over one manifest. Parity
holds them to each other on every HQ-authored A, wherever Python decides.

`proof/checks/parity.py` (pure) exports `differences(document, records) -> list[Difference]`, in
the shape of `proof6.differences` and `source.differences`; `join(uses, claims) ->
list[Difference]`, the pure join of step 3 below, which `differences` calls and 7.2's test calls
over a variant; and `undecided(document, records) -> dict[str, int]`.
`proof/checks/test_parity.py` holds the first to the register. For each
configuration of an `hq-authored` document:

1. **Python's uses.** From the `authored` API read of part `a` (5.3): one call of
   `manifest_usage.app_json_uses` over the source answer's parsed body as artifact `app.json`. That
   call already runs `xform_uses` over each form's `_attachments` entry and names it
   `form:<m>.<f>`, so no second call is made (one would count every form's uses twice). Each use
   has `(key, artifact, where)` and a standing from `manifest_usage.standing`.
2. **The reader's claims.** One request to the bundle in mode `claims` (`claims: "full"`), which
   answers `serializeClaimLog`'s lines (part 06 section 4.5): `artifact`, `where`, `key`, `entry`,
   `standing`, and each hand-off, which the judge joins to the claim part 11's media plan and table
   findings give it (their `claims`, carried in the same answer) before it compares.
3. **The join**, on `(artifact, where)`. For each use Python decides, some record at that place must
   name an entry whose `surfaceKeys` hold the use's key, and its standing must project to Python's:

| Python's standing | The reader's standing must be | And |
|---|---|---|
| `refused`, resting on entries E | `never` or `fix-in-hq` | the claimed entry is in E |
| `bar` | `fix-in-hq` | the claimed entry is REFUSED with a reason HQ's build gives |
| `held-new`, resting on E | `not-yet` | the claimed entry is in E |
| `held`, on a key no HELD-NEW entry shares, or one whose every HELD-NEW class has a reader | `held`, `kept` or `inert` | the claimed entry is an allowing entry naming the key |
| `unnamed` | `not-yet`, with code `unrecognized` | |

Python does not decide, and parity leaves to each variant's row: a use it calls
`undecided`; a use it calls `held` on a key some HELD-NEW entry shares with no reader (8.2); a use of
a `parser:` key, which no source holds; and the standing `source`, which is a local archive's (the
check named `source` is 9.3's and another thing).
`parity.undecided(document, records)` counts those by key, and the check's evidence holds the
counts, so what parity did not judge is a number a reviewer reads.

4. **The other way.** Every claim record whose `key` is not null must be a use Python extracted at
   that `(artifact, where)`. No family is excepted: `app_json_uses` walks the whole source, and
   `manifest_usage.py::_special` extracts `setting:`, `profile-property:` and `ui-string:` uses
   from the source's own `profile` and `translations`, at pointers under the app JSON, which is
   where the kept settings live and where parity matters most. A claim at a place the lane has no
   use for is a difference, `claims@A` `/<key>/unseen`: the two vocabularies have drifted.

Differences are `Difference(check="parity", artifact="claims@A", path="/<key>/<what>")` with `what`
one of `unclaimed`, `entry`, `standing`, `unseen`. They are held to the register like any check's,
and no entry names `parity` (11.3).

A base reads clean, so on a base every use is held and every claim allowing, and the manifest check
at A already fails wherever Python's standing is anything else. On a base parity reports three
things nothing else reports by place: a use Python extracts that no claim covers (`unclaimed`: the
reader claimed a container and never read inside it, or reads another default than HQ's); a claim
at a place Python extracts no use (`unseen`: the lane's own extraction never visits that place, on
Nova's exports too, or the two place vocabularies have drifted); and a claim whose entry does not
hold the use's key (`entry`), which `claimsBindManifest.test.ts` (part 06) holds statically. Python
cannot tell two allowing entries of one key apart (`manifest_usage.py::standing` never reads an
allowing class), so parity does not judge which of them a claim names. The table's refusing rows
(`refused`, `bar`, `held-new`, `unnamed`) meet no use on a base. They run on the variants:
`test_each_variant_reads_as_its_row_says` joins each variant's added uses to its claim log with the
same function (7.2).

`proof/checks/test_parity_controls.py` plants, with no HQ: a claim naming an allowing entry whose
`surfaceKeys` lack the key (one `entry`), a `held` claim on a use Python calls `refused` (one
`standing`), a use with no record (one `unclaimed`), a record with no use (one `unseen`), an
agreeing pair (none), and a planted variant whose added use is refused and whose claim names
another entry (one `entry`).

### 8.2 What Python gains: thirteen HELD-NEW value-class readers

`manifest_usage.py::standing` returns HELD for a use an allowing entry names, whichever class it is
in, because no HELD-NEW class has a reader. Where step 6 cuts a HELD row by one value's grammar or
bound, the line between "Nova holds this" and "not yet" is one predicate over one value, the
reader's own check is all that draws it, and a wrong draw publishes over an app Nova mis-read. Those
classes get a Python reader, so parity and 7.4 decide them. The rule that picks them, which the
registry test enforces: the entry is HELD-NEW, shares a key with a HELD entry, its key's family is
one `app_json_uses` or `xform_uses` extracts, and its class is decided by the use's own value with no
other place read.

| Entry (as its part names it) | The reader, in `manifest_value_classes.py` |
|---|---|
| `forms-and-case-writes/update-keys-location-id-hq-user-id` (part 04, N2) | the update key is `location_id` or `hq_user_id` |
| `case-search/prompt-key-outside-nova-s-name-grammar` (N3) | the prompt `name` does not fully match `^[A-Za-z_][A-Za-z0-9_-]*$` |
| `questions/choice-value-holding-both-an-apostrophe-and-a-double-quote` (N6) | the value holds `'` and `"` |
| `forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character` (N7) | the key holds a character outside ASCII |
| `case-search/default-value-on-a-date-range-input` (N8) | `default_value` is not empty and the prompt's `input_` is `daterange` |
| `menus-and-case-lists/detail-max-select-value-above-100` (N10) | the value is above 100 |
| `menus-and-case-lists/enum-mappingitem-alt-text-non-blank` (N11) | some language's `alt_text` holds a non-space character |
| `forms-and-case-writes/case-tag-holding-a-hyphen` (part 07) | the tag holds `-` |
| `forms-and-case-writes/index-identifier-outside-an-xml-element-name` (part 07) | the identifier is not an XML element name as `lib/commcare/constants.ts::XML_ELEMENT_NAME_REGEX` spells one |
| `menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name` (part 07) | the same test of the group identifier |
| `menus-and-case-lists/column-field-outside-nova-s-property-grammar` (part 07) | the column's `field` is outside the grammar part 07 section 11 gives |
| `application-and-settings/build-profiles-non-empty` (part 01) | `build_profiles` holds a key |
| `questions/data-root-element-named-other-than-data` (part 06) | the main instance's root element is not `data` |

Each lands with its `SHAPES` pair (a refused shape and an accepted one) in
`proof/checks/test_manifest_value_classes.py`. Three things change with them:

- `standing` gains, before its HELD step: a use some HELD-NEW entry's reader takes is `held-new`,
  resting on that entry. Its last docstring paragraph becomes: "A HELD-NEW class that shares its key
  with an allowing class is judged where it has a reader (`VALUE_CLASSES`), and is otherwise not
  judged: a use of the key is then held whichever class it is in."
- `test_every_reader_reads_a_refused_entry_that_names_a_value_class` becomes
  `test_every_reader_reads_a_refused_or_held_new_entry_that_names_a_value_class`, admitting both
  dispositions and still refusing an allowing one.
- Nova's own exports never use one of the thirteen (the gate refuses each value), so no corpus
  document's manifest evidence moves. `proof/checks/test_manifest.py` gains the case that a use a
  HELD-NEW reader takes on a Nova export is reported `/<key>/held-new`.

The other HELD-NEW classes that share a key (the 146 at `15a00a97`, and those step 6 adds whose
class reads a second place or the document Nova would build) get no Python reader: each needs
structure the lane's extraction does not hold as one use, and each is held by its variant and the
reader's own tests. The HELD-NEW entry part 02 adds is one of them and gets no Python reader
(`menus-and-case-lists/case-list-form-post-form-workflow-default-on-the-hidden-module-shape`, part
02, 02-menus.md, section 14). A REFUSED class keeps getting its reader with the entry that adds
it: part 04's N1, part 02's two and part 07's two, each planned in its part.

---

## 9. `proof/first-publish-changes.json` and its judge

### 9.1 The file

The lane's register of what Nova's first publish over an HQ-authored app changes on purpose. Part 09
(09-acceptance-and-the-first-publish.md, section 11) owns the typed register
`FIRST_PUBLISH_CHANGES` (the predicate over A, the stored-source paths, the sentence, whether it
touches workers). A shard holds `proof/` and `lib/commcare/surface/` and cannot read the
TypeScript register, so the lane keeps this file beside it. The file's shape is this part's:

```json
[
	{
		"change": "case-names-checked",
		"rows": [
			{ "check": "source", "artifact": "app.json", "path": "/_attachments/*" },
			{ "check": "source", "artifact": "app.json", "path": "/modules/*/forms/*/actions" },
			{ "check": "proof1", "artifact": "form", "path": "/questions/*" }
		]
	}
]
```

The rows above show the shape; a row that is not a `source` row is the run's to give, not this
plan's.

- `change` is a member of `FIRST_PUBLISH_CHANGE_IDS`. One object a change, every register entry
  in registry order.
- `rows`: each a difference the entry allows, in the lane's own vocabulary: `check` one of `source`,
  `proof1`, `proof2`, `proof3`; `artifact`, the structural `path` and the optional `kind` name the
  class exactly as a known-defect entry does (`proof/README.md`, "Known defects"). A `source` row
  is one of the entry's `paths` in part 09's register. Every other row is written from a base's own
  evidence (`blocks/<id>/checks/<check>/corpus-<base>.json`), never by typing a path
  (`proof/CLAUDE.md`, "A structural path names a symptom"). No row names `intent`: an intent
  difference on a base says the reader read A wrongly or Nova's emission lost what D states, and
  neither is ever a declared change.

The file names no document: where an entry applies is the reading's to say (9.2), and each base's
`expected.json` already holds its `firstPublish` list byte for byte.

```python
# proof/checks/changes.py
@dataclass(frozen=True)
class Row:
    check: str                 # "source", "proof1", "proof2" or "proof3"
    artifact: str
    path: str
    kind: str | None = None

@dataclass(frozen=True)
class Change:
    change: str
    rows: tuple[Row, ...]

def load(path: Path = FIRST_PUBLISH_CHANGES) -> tuple[Change, ...]:
    """The file's entries in file order. Refuses two objects of one change, two rows of one class
    within an object, and a check outside the four."""

def declared(document, check: str, differences, *, inert: frozenset[str] = frozenset()):
    """-> (held, ids): the differences of `check` a row of an entry applying on `document` matches
    (9.2), and the ids of the entries that matched. A `source` difference whose pointer is in
    `inert` (the pointers the claim log holds under an entry of standing inert, 9.3) is matched
    by forms-and-settings-rewritten."""

def differences(document, checked: Mapping[str, Sequence[Difference]], *,
                inert: frozenset[str], readers: bool) -> list[Difference]:
    """Holds 1 and 2 of 9.3 for one base. `checked` is every difference of the four checks, by
    check; `readers` is whether the served readers ran. Answers the `changes` differences
    `/<id>/unsaid` and `/<id>/unseen`."""
```

A `source` row is one of the entry's `paths`, which part 09's Vitest holds
(`proof/ci/__tests__/firstPublishChanges.test.ts`, its section 13.2: the file's ids are the
register's in order, each object's `source` rows are exactly the entry's `paths`, and a `proof3`
row stands only under an entry whose `touchesWorkers` is true). Every other row is written from a
run's evidence: `python3 -m proof.checks.changes rows <output> <base>` prints, for each unheld
difference of the base's evidence, the row that names it, and the session writes each printed row
under the entry whose change it shows, which it reads from the entry's sentence in part 09. No
row's path is typed. The command runs on a hosted runner's `python3`, on the standard library
(`proof/CLAUDE.md`, "What runs with no image").

### 9.2 The hold

`proof/checks/changes.py::declared(document, check, differences)` returns the differences of
`check` that a row of an applying entry matches, and the ids that matched; `proof1.py`, `proof2.py`,
`proof3.py` and `source.py` call it before `cases.hold`.

An entry applies on a document where the document's `first-publish.json` lists its id. That file,
`{ "ids": [...] }`, is written at emission from the reading (`LaneReading.firstPublish`, the base's
declaration's `AcceptedDeclaration.firstPublish.ids`): the changes Nova would tell the person this
app's first publish makes.

It is strict both ways, as `proof/walk-stops.json` is:

- a difference on an `hq-authored` document that no row of an applying entry matches goes on to the
  spelling rules and the known-defect register like any other, where nothing holds it, and fails;
- an entry that applies on a document must match some difference there (hold 2 of the judge);
- an entry is never read on a document it does not apply to, and never on a document of another
  source. `proof/identity-moves.json` stays the witnesses' alone.

The file joins `proof/store/fingerprints.py::JUDGE_FILES`, so an edit to it judges every document
again and observes none.

### 9.3 The judge

Part 09's section 13.3 states what the judge holds, and this part writes it:
`proof/checks/source.py` (the new comparison), `proof/checks/changes.py::differences` and
`proof/checks/test_first_publish_changes.py`, on each `hq-authored` document and no other.

**The `source` comparison.** `proof/checks/source.py::differences(document, records)` compares A's
stored app with B's as HQ's source read serves each: the parsed bodies of part `a`'s `authored`
read and part `b`'s `published` read (5.3). It walks the two JSON values together and reports
`Difference(check="source", artifact="app.json", path, kind)` at each differing pointer, a list
position and an app's own key (a form's attachment name, a language code, a media path) as `*` in
`path` and kept in `at`. A form's source is compared as bytes and reported once, at
`/_attachments/*`. One thing is compared another way, for its reason at source: a form's
`unique_id` and every reference to one (`case_list_form.form_id`, a form link's `form_id`,
`shadow_parent_form_id`). Every source read re-mints them (`Application.scrub_source`,
`update_form_unique_ids`), so each is compared as the menu and form position it names, and an
attachment is paired with its form by that position. Nothing else is left out: a difference at a
key Nova's publish must never change (a kept one) is no row of any entry and no `inert` pointer, so
it fails the base, which is the kept test's first clause held on a real publish.

**Held media paths.** A register row at `/multimedia_map/*` would absorb a change to a path Nova
holds, so the comparison reports those apart. For each path the document's `mediaPaths` names
(2.1), a map item whose `multimedia_id` or `unique_id` differs between the two reads, and a
resource of that path whose version differs between A's and B's built media suites, is a
`source` difference at `/multimedia_map/*/held`, which is no entry's path and so never a declared
change. That is part 10's assertion (10-identity-and-the-ledger.md, section 4.7), held on every
base that maps media and exhibited on `hq-media`.

`source` is a check like any other: its differences go through `changes.declared`, then the
spelling rules and the registers. It observes nothing new; it reads records proof 6 already needs.

**The inputs, a base.** The differences of the hop (`source`, proof 1 against A, proof 2 over every
build file but a form's XML, proof 3 always: section 4); the entries that apply (`first-publish.json`,
9.2); and the claim log in `full` mode, one request to the bundle in mode `claims` over part `a`'s
`authored` read, for the allowance of `forms-and-settings-rewritten`: a `source` difference whose
pointer the log holds under an entry of standing `inert` is matched by that entry, which is how it
covers "the settings no runtime reads" without a row for each.

**The three holds.**

1. **Nothing undeclared.** Every difference of the four checks is matched by a row of an entry that
   applies on the base (or by the inert allowance), or erased by a spelling rule. Any other is
   reported as the difference it is, and with the known register empty it fails the base. Where
   such a difference matches a row of an entry that does not apply on the base, the judge adds
   `Difference(check="changes", artifact="register", path="/<id>/unsaid")`: the first publish
   changed something Nova's review would not have said (Copy L9).
2. **Nothing declared in vain.** Every entry that applies on the base matches at least one
   difference there, or `/<id>/unseen`: Nova would tell the person of a change that did not happen
   (L10). By profile: in the `no-readers` profile (`PROOF_READERS=0`) the hold skips an entry every
   row of which names a served reader's artifact (`formplayer@`, `webapps@`, `android@`,
   `connect@`), since no served reader ran; in the `readers` profile it holds every entry. The
   judge reads the profile from the records' scope, as the gate does when it leaves the served
   readers' register entries to the nightly, and from no list of ids.
3. **Behavior only where behavior is declared.** A `proof3` difference is matched only by a `proof3`
   row, and part 09's Vitest admits a `proof3` row only under an entry whose `touchesWorkers` is
   true. The other half is 6.4's rule: each such entry on a base has a before and after pair of
   value expectations that shows it.

So the register is closed three ways: the typed list (part 09), the lane's file (9.1), and this
judge between what the reader predicts for an app and what HQ, Core and the readers then show.
`proof/checks/test_first_publish_changes_controls.py` plants evidence for each hold in both
profiles, with no HQ. `proof/views/test_exports.py` gains the `hq-plain` case: HQ's form export of
B holds a column for each generated node, which is what the sentence of `hidden-values-added` tells
the person.

### 9.4 Which base shows each entry

Section 7.5's rule 3 requires every id on some base. Part 09's register names the ids (its section
11.2); each is placed here:

| Entry | Base |
|---|---|
| `forms-and-settings-rewritten` | every base: each holds a form, and Nova's publish goes through the import view that marks every app it updates |
| `hidden-values-added`, `case-names-checked` | `hq-plain`, the three starters and every other base with a case name question |
| `validation-counts-moved`, `validation-messages-composed` | `hq-questions` |
| `instant-comparison`, `empty-rows-guard`, `absent-session-value-guard`, `row-predicate-current` | `hq-expressions` |
| `search-value-guards`, `search-today-device-day`, `search-filter-rows-recut`, `search-filter-joined-to-list`, `search-restates-list-filter` | `hq-search` |
| `case-settings-respelled` | `hq-case-management`, and `hq-advanced` for a write stored `edit` that the project space saves every time |
| `date-and-time-saved-as-hq-stores-it` | `hq-case-management`, on the form whose `nova_datetime_` sibling holds the spelling Nova wrote before this step (6.2) |
| `sort-rule-kept-as-hidden-column`, `list-settings-respelled` | `hq-case-lists`; `hq-menus` holds `list-settings-respelled` too, for a case list menu item's blank label |
| `link-held-case-guards-added`, `registration-label-fixed` | `hq-menus` |
| `connect-app-captures-location`, `web-apps-turned-off` | `hq-connect-deliver` |
| `translation-overrides-folded`, `blank-translations-filled` | `hq-languages` |
| `location-list-setting-reset` | `hq-kept-settings` |
| `web-apps-turned-on` | `hq-new-app` |
| `date-and-time-questions-split` | `hq-questions` |
| `media-paths-joined`, `media-files-renamed`, `media-references-with-no-file-removed`, `unused-media-entries-removed` | `hq-media` |

`hq-expressions` keeps the shape of a default that reads another question and expects no id for
it. `date-and-time-saved-as-hq-stores-it` touches workers, so where the run gives it a `proof3`
row, `hq-case-management` holds its before and after pair (6.4): the sibling's value for one
answered moment, the device's clock with its offset on A and the text CommCare HQ stores on B and
in the archive. An entry a run adds (P2, outcome C1) is placed on the base that showed it. No
register entry is exempt from having a base.

---

## 10. Vitest suites over retained HQ answers

Retained HQ answers live in two trees, both written and byte-held by the lane:
`proof/hq-reads/` (what HQ answers of apps Nova published, and part 05's `reading/` group) and
`proof/hq-apps/` (HQ-authored apps). No suite reads a hand-written HQ answer.

`__tests__/helpers/retainedHqApps.ts` reads files and builds nothing HQ did not answer:

```ts
/** The directory names under `proof/hq-apps/`, sorted. */
export const RETAINED_BASES: readonly string[];
/** A base's directory, read synchronously: `proof/corpus/hqAuthored.ts`'s type (2.1). */
export function retainedBase(id: string): RetainedHqApp;
/** A first reading's input: `identity: "mint"`, `claims: "full"`, `appId` the base's id, and the
 *  base's own declaration where `base.json` states one. */
export function laneInputOf(base: RetainedHqApp): LaneReadInput;
```

| Suite | Boundary | The failure it would catch |
|---|---|---|
| `lib/commcare/reader/__tests__/bases.retained.test.ts` | the production reader, part 11's verdicts and acceptance (`readForLane`, so part 12's `gatherFromHq`) over every retained base, through a peer that answers native `fetch` from the retained answers | a base that no longer comes in; a reading whose declaration, claimed entries or first-publish ids are not `expected.json`'s; a retained answer the reading never asked for (`asked`, Copy L16), or a request with no retained answer, a mapped file's read among them (P8) |
| `lib/commcare/reader/__tests__/schemaKeyVariants.test.ts` | the reader over every base's source with one unknown key set at each pointer | an unknown key read past |
| `lib/commcare/surface/__tests__/entryCoverage.test.ts` | the manifest, `KEPT_AT_HQ`, the register's ids, `proof/hq-apps/`, `proof/matrix/variants.json` and `exemptions.json` | 7.5's five rules |
| `proof/reader/__tests__/retainedPeer.test.ts` | `withRetainedHq` under native `fetch` | a request with no retained answer that reaches a socket or is answered; the previous dispatcher not put back after a failure; `LANE_TARGET` other than `PROOF_SERVER` and `PROOF_DOMAIN`; a `LANE_READING_ID` part 12's `READING_ID_PATTERN` refuses |
| `proof/corpus/__tests__/hqAuthored.test.ts` | the emission's `hq-authored` source over `hq-plain` | a reading of `hq-plain` that is not the hand-written document by external key; an identity row missing for a menu or form |
| `proof/ci/__tests__/readerBundle.test.ts` | `proof/reader/build.mjs` run twice into two directories | a bundle whose bytes differ between two builds; a bundle that imports a module outside itself at run time |

Four things are other parts' and are not written here: the equal-bytes proof of each canonical
pair, the fuzz read back, `notCarried.test.ts` and the one read back over HQ's retained answers
for `navigation-base` are part 09's (its sections 9 and 9.1), and the file's hold to the register
is part 09's `proof/ci/__tests__/firstPublishChanges.test.ts` (its section 13.2). That a second
reading of the same answers gives the same bytes is `proof/corpus/__tests__/emitCorpus.test.ts`'s
`hq-authored` case ("Tests"). Part 07's form-builder case of
`lib/commcare/reader/caseManagement/__tests__/saveToCase.retained.test.ts` reads this part's base
`hq-nova-then-builder` through `retainedBase`; part 07 plans the file.

None of these is a Vitest DOM test, none runs a database, and each runs once in ordinary CI.
`bases.retained.test.ts` is the heaviest: twenty-two bases, each read and accepted once.

---

## 11. What keeps the corpus and the registers whole

### 11.1 A rule that refuses more takes no document out of the corpus unseen

The emission leaves out a source document Nova's publish or local export refuses and names it in
the census (`proof/corpus/emitCorpus.ts::PartCensus`, `refused`, and `editsRefused` for an edit).
So a new refusal can shrink the corpus without failing it. Step 6 adds four places a refusal can
newly meet a source document: the rules of forms in the menu above and `several-registrations`
(part 02), the schema's refusal of a sort rule's `blanks` equal to its direction's own (part 03),
and the identifier grammars (part 04).

`proof/corpus/left-out.json` names what the fixed floor leaves out:
`{ "documents": [{ "id", "by", "codes" }], "edits": [{ "id", "by", "codes", "kind" }] }`, each
list in id order. The emission holds the fixed part's census equal to the file and stops where
they differ, as it already stops where a mutation kind lands on no fixed document
(`proof/corpus/emit.ts`), naming each document or edit that left or joined (Copy L19, L20). The
sample is not held: a draw is the generator's.
`proof/corpus/emitCorpus.ts::leftOutDifferences(census, named)` is the comparison, pure.
`proof/corpus/__tests__/emitCorpus.test.ts` holds it over the emission that suite already makes:
silent with a list naming `nested-menu-same-smaller`, one difference with an empty list, and one
with a list naming a document the emission takes.

The file's first content is the census of `main`'s corpus, read from the `index.json` in the
corpus `main`'s CI uploaded. Which documents that is was not read for this plan, and nothing is
emitted on a laptop to find out. P10 says what the session does where the step's own rules move
the census.

### 11.2 A fuzz family that draws advanced menus

The lane's sample draws no advanced menu today ("Executed during planning"), while step 6 adds a
reader of advanced menus, their loads and the links that carry a case, and proof 6 reads back
every Nova-born corpus document. A reader proven over a corpus that holds no advanced menu is not
proven for them. So the sample gains a family, before proof 6 first runs, with its own draws so the
existing sample keeps its own:

- `proof/corpus/documents.ts::FUZZ_GENERATORS` gains `"advanced"`, and `fuzzSplit` gives it
  `DEFAULT_ADVANCED_SAMPLE_SIZE`, a new constant of `proof/corpus/defaults.ts`, 8, beside
  `DEFAULT_EXPRESSION_SAMPLE_SIZE`. Like the expression family it is a separate stream: adding its
  draws moves no document of the original sample.
- `proof/corpus/fuzzSample.ts`'s `ARBITRARIES` maps it to
  `lib/commcare/__tests__/advancedDocArbitrary.ts::advancedDocArbitrary`: over a suite draw, a form
  that creates a case of another menu's type outside any repeat, and one after-submit link that
  carries the new case to a follow-up form of that type, which is what makes the creating form's
  menu emit as advanced. The arbitrary keeps only draws the commit gate admits, and
  `sampleFuzzDocuments` holds each to the strict schema and full validation as it holds every
  draw. Its header sentence "The proof sample does not use it." goes.
- A document's id is `fuzz-advanced-<seed>-<index>` (`fuzzDocumentId`), and its source `{ kind:
  "fuzz", generator: "advanced", seed, index }`. The index schema of the sample
  (`documents.ts`, `z.enum(FUZZ_GENERATORS)`) admits it with the constant.
- `proof/corpus/__tests__/fuzzSample.test.ts` gains the case that every advanced draw's export
  holds an advanced menu or names the blocker that kept it basic
  (`lib/commcare/moduleKind.ts::emittedModuleKind`), and that the family's draws hold at least one
  advanced menu, so a generator change that stops drawing them fails by name; and the case that
  the original 24 and the expression eight are byte for byte what they were. Where the eight of
  the corpus seed hold no advanced menu, the constant is raised until they do: a family that
  draws none checks nothing.

The eight are corpus documents like any other: every check of the lane runs on them, proof 6 and
the manifest check among them, with the generated edit batches every sampled document carries.
12.1 counts them. A difference one of them shows on `main`'s emission, with no step 6 code in it,
is a defect of today's Nova found by widening the sample: it is fixed in this step in the emitter
that owns it, and never registered (11.3).

### 11.3 `proof/known-defects.json` stays empty

`OPEN_DEFECTS` stays `{}`. A live entry would mean Nova ships a defect it knows and a later step
owns; step 6's bar leaves no room for one on an app it brings in, and nothing in the step may add
one. Every outcome that would have added one is settled before the merge:

| What the lane shows | Settled as |
|---|---|
| a difference on a Nova-born document from a concept this step adds | the emitter is fixed where the concept is built |
| a difference on an HQ-authored document every reader reads alike | a spelling rule with its proof on each reader |
| a difference Nova makes on purpose and would tell the person | a first-publish register entry, with the sentence the session writes for it (part 09, section 11.3) |
| a difference Nova would not tell the person, where CommCare does something Nova's model has no concept for | the shape leaves what the reader holds: a `not-yet` entry with its owner, a variant row in place of the base's shape |
| a defect in Nova's emitter, reader or Preview | fixed in this step, in the code that owns it |
| a report a reader makes of an app with no Nova byte | a member of `HQ_OWN_REPORTS` with its proof |
| a `proof6`, `parity`, `source` or `changes` difference | fixed, or, for `source`, declared in the first-publish register by part 09; these checks have no known-defect entry and the loader refuses one (`registers.py` refuses an entry whose `check` is one of the four, Copy L8) |

A control is retained only where a fix takes a registered symptom off a document, which nothing in
step 6 does to an existing entry; part 03's change to a hint's formatted copy re-paths fixed
entries only as "Fixed defects" rule 8 allows.

---

## 12. Cost

### 12.1 A pull request, without the readers

From `proof/timings.json`'s `no-readers` profile: the whole lane is 4,897 box-seconds (documents
3,622, controls 643, packages 632), and a document no run has measured is counted as
`sharding.estimate` counts it, at the 90th percentile of the measured documents and controls,
15.486 box-seconds.

The step adds 64 corpus documents: the twenty-two bases; thirty-four targeted documents (part 01's
`targeted-kept-values` and `targeted-tile-group-filter`, part 02's five, part 03's six, part 04's
eight, part 07's `targeted-detail-only-column`, part 11's `targeted-missing-media`, part 15's ten
(6.6), and this part's `targeted-save-to-case-shapes`), each worded in its own part; and the eight
draws of the advanced fuzz family (11.2).

| | Added, as counted before a measure | Whole lane | Expected end, every group fresh |
|---|---|---|---|
| main | | 4,897 | 14.0 min (840 s), modelled |
| the step's head | 64 documents × 15.486 = 991; the API reads, about 0.5 box-seconds a document over 494 documents = 247; `proof6`'s judge, about 0.25 a document = 124; `parity`, `source` and `changes` on the 22 bases, about 22; `proof/matrix`, about 160 | about 6,440 (+32%) | about 16.0 min: 840 s plus 0.32 of a 377 s shard span |

The figures marked "about" are estimates no run made: a read is five API requests in a fork (and
one a mapped file on the four bases with media), and the judge one Node start a document. The
`proof/matrix` figure leaves out 215 of the variant rows (the 207 `schema:` rows and the eight
that name no key) and the bundle's run over each row, which no earlier estimate counted, and a
`brings-in` document of part 15 also runs a review, a bring-in and a second publish, which the
per-document figure does not hold. The step's first whole run is the pull request lane's run over
the step's head, which is a whole one (the next paragraph says why): it measures all of it, and
`node proof/run.mjs --timings` over its outputs, committed in the stack, replaces every counted
figure of the `no-readers` profile. At the measured median (6.354) the documents cost under half
what the table counts.

A change to the observation's code moves every part key, so a pull request that carries one
observes every document afresh. This step carries several (the new source's arm in the unit, the
API reads, `proof/hq/operations.py`), so its lane runs are whole ones. One whole lane is about 1.8
runner-hours of work plus thirteen shards' fixed cost (13 × 146 s = 0.53 hours).

Vitest: the suites of section 10 add seconds, `bases.retained.test.ts` the most.

### 12.2 A night and a week, with every reader

From the `readers` profile (two workers a box): a document group's median is 1,289.9 box-seconds
(2,580 worker-seconds), and an unmeasured document is counted at 4,652.6 box-seconds (9,305
worker-seconds), the 90th percentile `sharding.estimate` uses.

| | Added | In worker-hours |
|---|---|---|
| the step's 64 documents, weekly | 64 × 9,305 as counted; 64 × 2,580 at the median | 165.4 counted, 45.9 at the median |
| the API reads and `proof6` on every document | under 3 worker-seconds a document, 494 documents | 0.4 |

Against 552 worker-hours for the whole lane with every reader, the step adds 8% at the median and
30% as first counted. The starter apps are the heavy ones: agriculture's nine forms walked whole in
the client, in one language, for every case.

**The first night after the merge is the whole lane with every reader.** The step moves every part
key, and part 03's change to how a date and time is saved changes what many documents emit, so the
merge's next night observes every group: about 718 worker-hours as counted, where the `README`
plans a fresh queue of this size at 31 to 37 hours on fourteen runners. That night can span the
next schedule, which the `proof-scheduled-readers` queue serializes, as it does after any merge
that moves every key (`proof/CLAUDE.md`, "Three lanes"). Nothing is scheduled around it, and it is
no dispatch.

This step does not refresh the `readers` profile: no run of the step's own measures every group
with every reader, and the step plans no work after its exit. Until a weekly run's outputs refresh
it, the new groups are counted at the 90th percentile, which oversizes the lane and undersizes
nothing (`proof/README.md`, "Timings and what the lane is expected to take").

### 12.3 What a reader change costs after step 6

A change under `lib/commcare/reader/`, or to anything the bundle imports, changes
`native/reader/reader.mjs`: every corpus document is judged again from its records, on about three
shards, in about twelve minutes, and no Nova-born document is observed. The `proof/matrix` package
group runs again, so every variant is made in HQ and read again. A base whose reading the change
moves is emitted anew (its `document.json`, `expected.json` or `first-publish.json` differs), so
that base is observed again and the change adopts its new `expected.json` into `proof/hq-apps/`
with `python3 -m proof.matrix.adopt` (5.6, section 14). A change that moves no reading observes
nothing, and the night after it is not a whole lane. A change to the emitter moves documents' keys
as it does today.

### 12.4 Dispatches

The lane runs the session starts itself, each with `gh workflow run` on a branch GitHub holds.
Hosted runs bill nothing on this public repository (`proof/README.md`, "Seeing a reader's verdict
before a merge"). The top-level file names them once among what is agreed before the work starts;
this table is what each holds and costs.

| Dispatch | What it holds | Readers | Cost |
|---|---|---|---|
| `proof-audit.yml -f nightly=false -f mechanics=<base ids>`, twice | the twenty-two bases, `hq-plain` in both: `hq-plain` with ten others, then `hq-plain` with the remaining eleven (a `mechanics` dispatch names at least one edited document). P2, and the checks of parts 01, 07, 09 and 10 that P2 names | every reader | each about 8 to 31 worker-hours (the median and the counted figure of 12.2), holding up to fourteen of the account's twenty runners for one to three hours |
| `proof-audit.yml -f nightly=false -f mechanics=<ids>` | the thirty-one new targeted documents whose parts ask a served reader's verdict (the top-level file, "What needs your yes before this starts", item 3, names which parts give them), each for the check its own part words, part 15's ten among them (6.6). The session splits it where the documents exist at different times: the gate judges each document on its own | every reader | about 2.6 worker-hours a document as counted, 0.7 at the median, so about 22 to 80 for the thirty-one |
| four bounded slices | `proof-slice.yml -f selectors='proof/hq/test_retained_reads.py proof/surface/test_hq_api.py' -f readers=0` (part 05: its retained reads, whose `reading/` files the session copies in, and the surface extraction it commits; and the same workflow over `proof/matrix/test_retained.py` wherever a base's builder changes, which gives `adopt` its output); and three of `proof-audit.yml -f nightly=false`: `-f slice='proof/android/test_form_reads.py' -f slice_readers=android` (part 03, G4 and G5); `-f slice='proof/connect/test_receiver.py -k names_beside_connects_keys' -f slice_readers=connect` (part 04, R2); and one for the three tests that take the Web Apps reader, with the Android reader beside it for part 11's: `-f slice='proof/webapps/test_tiles.py::test_web_apps_makes_a_grouped_tiles_cards_from_the_rows_a_search_leaves proof/webapps/test_search_title.py proof/android/test_missing_media.py proof/webapps/test_missing_media.py' -f slice_readers=android,webapps` (part 01, Run 4; part 03, section 6; part 11, R2). Part 01's test is named by its node id, since a `-k` would apply to every file the slice names; the workflow's slice check admits a file or a `file::test` item (`.github/workflows/proof-slice.yml`, "Validate the slice"). The last three exist because a `mechanics` dispatch runs no test of a reader's own package (`proof/README.md`, "The run started by hand") | none; Android; Connect; Android and Web Apps | one runner each, for at most 90 minutes |

- **No lane on a laptop.** Every lane run named in this plan is on GitHub's hosted runners: the
  work's own CI, `proof-audit.yml`'s `mechanics` dispatch or its slice, or `proof-slice.yml`. Of the
  lane's work, the session's shell runs a file copy (`python3 -m proof.matrix.adopt`), the `rows`
  command of 9.1 on the standard library, and `node proof/run.mjs --timings` over a run's
  downloaded outputs (12.1). What else it runs before a push is the top-level file's ("What needs
  your yes before this starts").
- **One dispatch at a time**, never while a scheduled lane with the readers is running, so pull
  requests keep their six runners (`proof/CLAUDE.md`, "Three lanes").
- **A run's verdict is its gate's summary.** Nothing is pushed to find the next failure: what the
  run reported is fixed, proven green where CI could fail it, and then pushed. A fix that changes
  emission dispatches only the documents it touched.
- No fresh lane is dispatched to measure the judge: its start is decided (5.4).

---

## 13. `proof/corpus/hq/` and its self-checks

`proof/corpus/hq/` harvests HQ's own test apps, template apps and `.ccz` archives at CommCare 2.54.0
for a group, `hq-selfchecks`, that no test module belongs to and no queue holds. Step 1's decision
17 left HQ-authored apps to step 6, and `proof/matrix` is how step 6 holds them: authored at the
floor, with real form sources, each with an expectation. The harvest has none of the three.

Removed: `proof/corpus/hq/__main__.py`, `harvest.py`, `sources.py`, `test_harvest.py`,
`test_sources.py`; the emission's `--with-hq` flag and its step (`proof/corpus/emit.ts`);
`"hq-selfchecks"` from `proof/lane/blocks.py::SINGLE_GROUPS`, its sentence in that module's
docstring and its name in `group_problem`'s message, its sentence in `proof/store/queue.py`'s
docstring and in `proof/checks/sharding.py::collection_roots`'s, and its name in
`proof/lane/test_blocks.py` and `proof/checks/test_sharding.py`; the index's `hq`
list and `emitCorpus.ts::HqIndexEntry`, which only the flag filled; the README
section "HQ's apps as self-checks". With the privilege tests moved, `proof/corpus`
holds no Python test, so it is no package group: `proof/lane/test_forkserver.py`'s
early-queue tests, which used it as a group that reads no corpus, use `proof/core`
in its place, and the README's list of the groups a reader's run by hand takes
loses it.

Kept, moved: `proof/corpus/hq/test_privileges.py` is no part of the harvest. It holds each privilege
rule of `proof/checks/configurations.py` to the content HQ gates, over `AppFactory` apps, and runs
today in the `proof/corpus` package group (`proof/timings.json` measures it there). It moves to
`proof/hq/test_privilege_rules.py`, unchanged but for the path in its docstring, and runs in
`proof/hq`'s group. Its `conftest.py` is deleted, not moved: it shadows the session fixture `hq`
and the autouse fixture `network` that `proof/conftest.py` already supplies (the root `hq` with
`database.drop_template()`, the root `network` with `NetworkWatch.expect`), and the same two
fixtures written into `proof/hq/conftest.py` would replace the root ones for every test of
`proof/hq` and edit a file of the observation partition for no reason. The moved test takes the
root fixtures. `proof/corpus/hq/__init__.py` goes with the directory.

HQ's test app JSONs are not made variants: each holds many classes at once, at shapes HQ's own
pages no longer write, and a variant exhibits one entry.

---

## 14. The weekly pin pull request

A pin move can change any byte of `proof/hq-apps/`: HQ's stored document, its answers, a form the
form builder writes. `proof/matrix/test_retained.py` fails on the first, naming the base.

`python3 -m proof.matrix.adopt <output>` is the one way the trees are written: it copies
`blocks/*/hq-apps/` over `proof/hq-apps/` and `blocks/*/hq-reads/` over `proof/hq-reads/`, removing
a file the run did not write, and with `--report` prints each base whose stored app or answers
changed and each base whose reading changed (read by running the bundle the run's own corpus
production built over the old and the new answers). A change to a builder, the reader or
`targeted-save-to-case-shapes`'s capture runs it over the output of the failing
`test_retained.py`, which wrote what HQ made before it compared. Adopting is a file copy, on the
standard library, with no image.

`.github/workflows/upstream-pins.yml` cannot do this in a step of an existing job. Its `surface` job
has no `node_modules` and its one product is the `upstream-surface` artifact; `prewarm` and
`readers` call `proof-lane.yml` at `ref: upstream/pins` and are handed only that artifact
(`inputs.surface`, put in place in three jobs); and `report` checks out `main` and downloads only
the surface. So the regenerated trees get the surface's own path through the workflow:

| Where | Change |
|---|---|
| a new job `retained`, `needs: image` | checks out `upstream/pins`, runs `npm ci`, then `PROOF_READERS=0 PROOF_IMAGE=<the candidate> npm run proof -- proof/matrix/test_retained.py proof/hq/test_retained_reads.py proof/editors/test_retained_reads.py`, read whatever its verdict (each test writes what HQ made before it compares), then `python3 -m proof.matrix.adopt .proof/out`, and uploads the artifact `upstream-retained`: `proof/hq-apps/`, `proof/hq-reads/` and the adopt report |
| `proof-lane.yml` | a new input `retained` ("An artifact of this run holding the retained trees to check in place of the checkout's"), put in place in each job that puts the surface in place, by the same download step with `path: proof` |
| `prewarm`, `readers` | `needs` gains `retained`; each passes `retained: upstream-retained`, so both lanes emit the bases from the regenerated answers and hold the regenerated tree byte for byte |
| `report` | `needs` gains `retained`; downloads `upstream-retained` where that job succeeded and passes `pins.mjs report --retained-result <result> --retained <dir>`, which adds both trees to the one commit beside the image lock and the surface and puts the adopt report in the pull request's description. Where the job failed, the pull request carries the pins and the surface, and the description names the failed job, as it does for a failed surface |

What that branch then needs, each before it merges:

- a base that no longer comes in: the entry its finding names is classified (the pin added a key or
  a value: the surface diff in the same pull request says which), as any new surface item is;
- a variant row HQ now answers otherwise: the row, or its `hqNeverServes`, is corrected as Copy
  L12, L17 or L18 says;
- a hand-written file the new answers contradict (`expectations.json`, `hq-plain`'s `document.ts`,
  an `edit.ts`): corrected from the new A, by reading it;
- a `proof/first-publish-changes.json` path that moved: re-pathed from the prewarm's evidence.

The prewarm runs the pull request lane's profile over the regenerated trees, and the lane with
every reader runs after it, as today. `proof/upstream/__tests__/pins.test.ts` gains the outcomes:
the two trees and the report are in the commit and the description when `retained` succeeded, and
the description names the failed job when it did not. `proof/ci/__tests__/` gains the case that
`proof-lane.yml` puts `retained` in place in every job that puts `surface` in place, read from the
workflow file, since what a workflow and the lane must say alike is tested where the checkout is
whole.

A pin moved by hand follows `proof/README.md`'s "Moving a pin by hand" with the same two commands.

---

## Copy

Every string here is read by a developer or a model in a failure. No person using Nova meets one.

| Id | Where | Text |
|---|---|---|
| L1 | `proof/corpus/hqAuthored.ts`, a base whose reading is an account | `The base ${base} did not come in: Nova's reader found ${found} it does not hold, the first at ${placeLine} (${code}). A base is made only of what Nova holds, so either the reader is wrong about that place or the base holds more than it should. Look at proof/hq-apps/${base}/app-source.json there, and at the entry ${code} in lib/commcare/surface/entries/.` `found` is `one thing` or `${count} things`. |
| L2 | `proof/corpus/__tests__/hqAuthored.test.ts` | `The hand-written document for ${base} names ${named} menus and forms, and CommCare HQ's app holds ${held}. Each menu and form of proof/hq-apps/${base}/app.json needs exactly one identity row in proof/matrix/hand/${base}/document.ts. The ones without a row: ${missing}.` |
| L3 | `proof/matrix/test_retained.py` | `proof/hq-apps/${base}/ is not what CommCare HQ holds and answers at its pin: ${differences}. What HQ made is under ${out}. Copy it into proof/hq-apps/${base}/ (python3 -m proof.matrix.adopt ${output}) and read what changed.` `differences` joins the clauses that are true with commas and a final `and`: `it lacks ${missing}`, `${stale} changed`, `it holds ${extra}, which HQ did not make`. For `hq-nova-then-builder` the message ends: `This base starts from Nova's own publish of targeted-save-to-case-shapes, so a change to that document's capture changes it too.` |
| L4 | `proof/checks/readerbundle.py` | `Proof 6 runs Nova's reader from the corpus (native/reader/reader.mjs), and ${corpus} holds none. The corpus job builds it (node proof/reader/build.mjs); look at native/produced.json and native/logs/reader.log for why it was not written.` |
| L5 | `proof/checks/test_proof6_fixed_point.py` | `Nova read ${document} back from CommCare HQ (${state}) and got a different document: ${found}, the first at ${path}. Nova's own export must read back to the document that made it. If the two documents print the same bytes, the pair belongs in CANONICALIZATIONS (lib/commcare/reader/canon.ts) with its test; otherwise the reader lost or changed something there.` `found` is `one difference` or `${count} differences`. |
| L6 | `proof/checks/test_parity.py` | `Nova's reader and the lane's manifest check disagree about ${key} at ${where} in ${artifact} of ${document}: the reader claimed it under ${entry} (${readerStanding}), and the lane reads it as ${laneStanding}. One of the two is wrong about this value. Look at the entry's row in lib/commcare/surface/entries/ and at the value itself.` |
| L7 | `entryCoverage.test.ts` | `No base and no variant shows the manifest entry ${entry}, and proof/matrix/exemptions.json gives no reason for leaving it out. Every entry is exhibited by a base that comes in, by a variant with its expected finding, or exempted with one of the five reasons. Add the one that is true of it.` For rule 5, a second form: `The entry ${entry} is a refusal Nova's reader raises (${claim}), and no variant shows it. A refusal is exempt only where a part of the plan decided it, where no app's source holds it, or where CommCare HQ never serves the value. Add its row to proof/matrix/variants.json.` |
| L8 | `proof/checks/registers.py`, the loader | `The register entry ${id} names the check ${check}. A difference of proof 6, parity, the stored-app comparison or the first-publish judge is never a known defect: it means Nova's reader, its manifest or its first-publish list is wrong, and it is fixed where it is found.` |
| L9 | `proof/checks/test_first_publish_changes.py`, hold 1, `unsaid` | `Publishing ${document} back to CommCare HQ changed something Nova's review would not have mentioned: ${id}, seen at ${path} by ${check}. Either the change's rule in FIRST_PUBLISH_CHANGES misses this app, or the reader should not have held the shape that caused it.` |
| L10 | the same test, hold 2, `unseen` | `Nova's review of ${document} would say its first publish makes the change ${id}, and nothing the lane ran showed it. Either the rule fires where the change does not happen, or no row of the entry in proof/first-publish-changes.json names what this base shows.` |
| L12 | `proof/matrix/test_retained.py::test_each_variant_reads_as_its_row_says` | `The variant ${variant} should be refused at ${placeLine} under ${code} (${standing}), and Nova's reader answered ${got}. Look at the one change the variant makes (its row in proof/matrix/variants.json) and at the reader's claim for that key.` |
| L13 | `proof/corpus/hqAuthored.ts`, a declaration the reading does not offer | `The base ${base} is to be read as an app that runs on ${stated}, and Nova's reading of it offers only ${offered}. A base's declaration is one a person could choose in the review. Either the base's content no longer allows that choice (look at what proof/matrix/bases/ authors for it) or the reader narrowed the choices wrongly.` `stated` and each of `offered` read as `Web Apps and Android`, `Web Apps only` or `Android only`, with `, with date and time questions split` after one that takes the split. |
| L15 | `proof/reader/laneReading.ts`, a request with no retained answer | `Nova's reader asked CommCare HQ for ${path} while it read ${base}, and the lane holds no answer for that request. The retained answers are every request Nova's client makes of an app; either the client now asks for something new, which the lane must read and keep (proof/matrix/retain.py), or it built an address HQ does not give.` |
| L16 | `bases.retained.test.ts`, an answer nothing asked for | `The base ${base} retains ${unasked}, and Nova's reader never asked for it. A base keeps only the answers a reading uses. Either the reader stopped reading it, or the base no longer holds what needs it.` |
| L17 | `test_retained.py`, a value HQ does not serve | `CommCare HQ doesn't serve the value the variant ${variant} sets: ${why}. An app's source never carries it, so Nova never reads it. Record that in the row (hqNeverServes) and exempt ${entry} as hq-never-serves-the-value. If the change itself is wrong, look at the row's change in proof/matrix/variants.json.` `why` is `its import refused it (${raised})` or `its source read holds something else at ${pointer}`. |
| L18 | `test_retained.py`, an exemption that ended | `CommCare HQ now serves the value the variant ${variant} sets, where it used to ${was}. So ${entry} can sit in an app's source after all. Take it out of proof/matrix/exemptions.json, and give the row the standing and the place the reader should answer.` `was` is `refuse it (${raised})` or `serve something else at ${pointer}`. |
| L19 | `proof/corpus/emit.ts`, a document the corpus newly leaves out | `The corpus now leaves out ${id}: Nova's ${by} refuses it (${codes}). The fixed corpus leaves out only what proof/corpus/left-out.json names, so a rule that refuses more can't shrink it unseen. If the rule is right, change the document's source so it holds what Nova holds, or name it in left-out.json. If it isn't, the rule refuses too much.` `by` reads `publish`, `upload to CommCare HQ` or `local export`. `id` is the document's id, or for an edit `the ${kind} edit of ${id}`: an edit's entry carries its document's id, so the bare id would say the document left. |
| L20 | the same, a named document the corpus takes | `proof/corpus/left-out.json names ${id} as left out, and the corpus now takes it. Take it off the list.` `id` reads as in L19. |

`placeLine` is part 01's (`lib/publish/hqFindingCopy.ts`). The ids L11 and L14 are not used. No
string here uses an em dash, and none is a button or a placeholder.

---

## Tests

Each names its boundary and the failure it would catch. Lane tests are pytest in the image;
`*.test.ts` run in ordinary CI's Vitest. Sections 5.4 to 5.6, 8.1, 10 and 11.2 name the rest.

| Test | Boundary | Failure it would catch |
|---|---|---|
| `proof/matrix/test_retained.py::test_the_hq_apps_nova_reads_are_hqs_own` | HQ's own views, models and API over a real unit | a retained app or answer a person edited, or that a pin moved unseen |
| `proof/matrix/test_retained.py::test_each_variant_reads_as_its_row_says` | HQ's own import, model and API over a fork of each base, and the reader bundle | a refusal with another code, standing or place; a held variant whose fragment is not in the document; a variant that reads when it must not; a row that does not exhibit its entry; a value HQ cannot hold counted as one an app can carry |
| `proof/matrix/test_retained.py::test_a_base_exhibits_what_it_names` | each base's claim log | a builder that quietly stops authoring a shape at a pin |
| `proof/matrix/test_remade.py::test_an_authored_app_is_remade_with_its_ids` | `operations.save_authored_app` in a unit | A in the unit holding other menu ids, form ids, `xmlns` or content than the emission read (P7) |
| `proof/matrix/test_seed.py` | `case_seed` over planted apps; `seeded_case_database` | a seed that reads D; a compared literal missed, so both walks show an empty list; a `parent/<property>` name or `name` written as a case property; `commcare-user` seeded as a type; a child indexed under `parent` where its form names another identifier |
| `proof/checks/test_corpus.py` (new cases) | `Document.exports`, `configurations.privileges_for` and `unit.input_files` over a planted `hq-authored` document directory | an HQ-authored document refused for having no `create.json`; privileges derived from A alone, so B lacks what Nova's publish adds; a part key that does not name `authored/app.json`; a manifest check at A that reads no `authored/app.json` |
| `proof/checks/test_intent.py` (new case) | `profile_settings` and `local_profile_settings` with A's stored profile as `saved` | a kept profile value reported as a difference at B or in the archive; an unstated setting expected at Nova's seed on an app that holds none |
| `proof/matrix/test_media.py` | HQ's `CommCareMultimedia` classification of each stand-in | a stand-in HQ stores as another class, or two paths sharing one file by accident |
| `proof/matrix/test_expectations.py` | the registry, the hand files, each base's `expected.json`, its seed and the claim logs (6.4's rules) | a datum naming a case the restore lacks; a hand restore writing a property the app does not hold; a held entry with no value fixed by hand, in a form or on a case list; a declared change with no before and after; a base of several languages, or one with a case list expectation, read as Web Apps only |
| `proof/checks/test_source.py` | `source.differences` over planted pairs of source answers, no HQ | two reads' re-minted form ids reported as a change; a form link that moved to another form not reported; a changed kept key absorbed |
| `proof/checks/test_first_publish_changes.py`, `test_first_publish_changes_controls.py` | the judge's three holds over every base; over planted evidence, both profiles | an undeclared difference absorbed by an entry that does not apply; an entry declared in vain; a served reader's entry failed in the readers-off profile, or skipped with the readers on |
| `proof/lane/test_blocks.py` (new case) | the import graph and `queue.PACKAGE_DATA` | a package whose tests run the bundle without the `reader` kind, whose stored verdict a reader change would leave standing |
| `proof/checks/test_corpus.py::test_an_hq_authored_document_runs_every_check_but_sensitivity` | `eligibility.eligible` | a check silently left out of the hop |
| `proof/checks/test_build_files.py` (new case) | proof 2's comparators over an `hq-authored` document | a build file other than a form left with no comparator |
| `proof/checks/test_registers.py` (new cases) | the first-publish loader and its strictness | two objects of one change, two rows of one class, a check outside the four; an entry that matches nothing on a document it applies on; a difference absorbed on a document the entry does not apply on; a known-defect entry naming one of the four new checks |
| `proof/corpus/__tests__/publish.postgres.test.ts` (new case) | Nova's real `publishAppToHq` over real Postgres (the deployment written by part 10's `recordAdoptedDeploymentInTransaction`, so its identity rows are `adoptedIdentityRows`') and a peer holding HQ's retained source | a capture that is not what Nova would send over an adopted app; a body carrying a derived id |
| `proof/corpus/__tests__/emitCorpus.test.ts` (new cases) | the emission, twice; `leftOutDifferences` over the suite's own emission | an `hq-authored` document whose bytes differ between two runs; a document that leaves the corpus unseen |
| `proof/corpus/__tests__/fuzzSample.test.ts` (new cases) | `sampleFuzzDocuments` with the advanced family | an advanced family that draws no advanced menu; an original draw moved by the new family |
| `proof/corpus/__tests__/publish.test.ts` (new case) | the capture peer after `targeted-hq-side-state`'s saves, against HQ's retained answer | a peer that models a build profile HQ would not serve |
| `proof/checks/test_parity_controls.py` | planted uses and claim logs, no HQ (8.1's six controls) | a join that reports nothing |
| `proof/checks/test_proof6_controls.py` | planted records through the bundle, no HQ (5.4) | a judge that reports nothing |
| `proof/checks/test_record_determinism.py` (extended) | a `USERCASE` document, whole and under a stored `a` | the API reads leaving a write behind that a state made again lacks |
| `proof/store/test_keys.py`, `test_pack.py` (new cases) | the queue builder and packer over a stored run | a reader change that observes a document whose files did not change, or that leaves a stale judgment or a stale package verdict cached |
| `proof/checks/test_judge_purity.py` (new case) | the import graph | a judge other than the three running the bundle; the bundle reachable from an observation |
| `proof/hq/test_privilege_rules.py` | moved unchanged, under the root fixtures | as before |
| `proof/upstream/__tests__/pins.test.ts` (new cases) | `pins.mjs` with controlled `git` and `gh` | a pin pull request without its regenerated trees |
| `proof/ci/__tests__/` (new case over `proof-lane.yml`) | the workflow file | a job that takes the candidate's surface and not its retained trees |
| part 15's ten lane documents (6.6) | HQ's own views and form builder over a real unit, then Nova's review, bring-in and publish | the round trip of a change made in CommCare HQ: a change Nova loses, alters or sends back changed, each as part 15's check words it ("Tests", "The lane") |

No test sleeps. Every process a test starts goes through `proof/processes.py`.

---

## Contracts and docs these changes make false

| File | Today | From |
|---|---|---|
| root `CLAUDE.md`, the `proof/` bullet | "over a reproducible corpus of admitted documents" | "over a reproducible corpus of admitted documents and of apps made in CommCare HQ's own pages" |
| root `CLAUDE.md`, the same bullet | "Its checks (the bar, intent, manifest, configuration sensitivity, proofs 1 to 5, every walk held to its end or a held stop)" | "Its checks (the bar, intent, manifest, configuration sensitivity, proofs 1 to 6, parity with Nova's reader, every walk held to its end or a held stop)" |
| root `CLAUDE.md`, the same bullet | "every difference is erased by a proven spelling rule or held by the strict known-defect register (`proof/known-defects.json`), whose entries for a fixed defect move to `proof/fixed-defects.json` and keep showing on its retained control;" | "every difference is erased by a proven spelling rule, held by the strict known-defect register (`proof/known-defects.json`), whose entries for a fixed defect move to `proof/fixed-defects.json` and keep showing on its retained control, or, on an app made in CommCare HQ, named by the first-publish register (`proof/first-publish-changes.json`);" The sentence is replaced whole, so the clause on `proof/known-defects.json` stays with the register it describes |
| `proof/CLAUDE.md`, opening | "over a reproducible corpus" | "over a reproducible corpus of Nova's documents and of apps HQ's own pages and models made" |
| `proof/CLAUDE.md`, "Observation is separate from judgment" | (no sentence about a judge running a process) | 5.7's paragraph |
| `proof/CLAUDE.md`, the accepted seams | "The accepted seams are these four" | "The accepted seams are these five", with 6.3's paragraph |
| `proof/CLAUDE.md`, "The register is strict" | "Every difference a check reports is held by an entry of `known-defects.json` or erased by a spelling rule" | adds: "On a document made in HQ (`hq-authored`), a difference the first-publish register names for that document is the one other thing a check may accept, and that register is strict both ways and never read elsewhere. Proof 6, parity, the stored-app comparison and the first-publish judge take no known-defect entry." |
| `proof/CLAUDE.md`, new rule | (none) | "**An HQ-authored A is HQ's own.** A base is made by HQ's views, models and form builder in `proof/matrix`, retained under `proof/hq-apps/` and held to the pin byte for byte; the unit saves it again from its stored document and never through Nova's import. Its case database is seeded from A alone (`proof/matrix/seed.py`), so a reader that drops something cannot empty both walks. What a person writes about a base (`proof/matrix/hand/`) is written from A's authored meaning, never from a reading." |
| `proof/README.md`, "A, B and B-edit" | (three bullets and the witness paragraph) | adds a paragraph: section 2's A, B and B-edit for an `hq-authored` document, and section 4's table |
| `proof/README.md`, "A, B and B-edit", what a person saves over A and what `republish` states | "UI translations, app settings, add-ons, the app's CommCare settings (its profile), build profiles, and a lookup table"; "it `proceeds` ...; it `discards` ...; or it `stops`" | the list gains the content saves of 6.6, and `republish` a fourth outcome, `brings-in`: Nova takes what the person saved into the app and then publishes (part 15 names the same two changes among its contracts) |
| `proof/README.md`, "Proofs 1 to 5" heading and list | five items | "Proofs 1 to 6", with item 6 (5.1) and what it does not hold |
| `proof/README.md`, "Native proofs" | "to the structural intent checks, and to proofs 1 to 5." | "to the structural intent checks, and to proofs 1 to 6." Proof 6 reads back every Nova-born corpus document, the native families' among them (P5) |
| `proof/README.md`, "Manifest checks" | "An allowing class is what its row describes and is never read" stands; "A use whose key only HELD-NEW entries name is held-new" | adds: "A HELD-NEW class with a value-class reader takes its uses wherever its key is named (thirteen classes, `VALUE_CLASSES`)", and a subsection "Parity with Nova's reader" (section 8) |
| `proof/README.md`, "Spelling rules and the registers" | (no first-publish register) | a subsection "First-publish changes" (section 9) |
| `proof/README.md`, "Where documents come from" | "Five sources feed it" | "Six sources feed it", with the `hq-authored` bullet and a section "Apps made in CommCare HQ" (sections 2, 6 and 7: the tree, authoring a base, adding a variant, the hand files, coverage). The fuzz bullet gains "and eight of the advanced generator, a third stream of its own" (11.2). The sentence on what the fixed floor leaves out gains: "The emission holds that list to `proof/corpus/left-out.json` and stops where it moves." |
| `proof/README.md`, "The layout on disk" | (the per-document list) | adds `authored/` (2.4), the hand-written `restore.xml` (6.4) and `first-publish.json` (9.2), and says an `hq-authored` document holds no `create.json` and one configuration; `<corpus>/native/` gains "and the reader bundle (`native/reader/`)" |
| `proof/README.md`, "HQ's apps as self-checks" | the section | removed (section 13) |
| `proof/README.md`, "Targeted documents" | (no row for the document) | adds: "`targeted-save-to-case-shapes` holds every Save to Case shape Nova writes (a root create, a keyed create, a create in a repeat, a conditional update, a close, a several-case form, the own arm in a block, the own close's block) and one form with no Save to Case operation whose validation holds a lifted count. Its first publish is what the base `hq-nova-then-builder` saves again in HQ's form builder." |
| `proof/README.md`, "How the lane observes", the unit's diagram | `create(D) → media → HQ-side saves` | `create(D) → media → reads → HQ-side saves`, and `reads` after `republish(D) → media` and `update(D′) → media` where 5.3 says |
| `proof/README.md`, "The Core runner" | "Each document's sessions run over its case database ... drawn from the emitted effective `catalog`" | adds: "A document made in HQ takes its database from A instead (`proof/matrix/seed.py`)" |
| `proof/README.md`, "The evidence store" | "each check's evidence on a document under the document's files, ... and the judge's code" | adds: "and, for a corpus document, the reader bundle the corpus carries" |
| `proof/README.md`, "How the harness proves itself" | (the table) | rows for `test_retained.py` (its three tests), `test_remade.py`, `test_seed.py`, `test_source.py`, the judges' controls and the bundle's key test |
| `proof/checks/configurations.py`, the comment over `PRIVILEGE_CAPTURES` | "The captured publishes whose apps the privilege derivation reads: D's first publish and D′'s update under the minimum configuration." | adds: "For a document made in HQ, the app HQ's own pages made (`authored/app.json`), Nova's republish over it and D′'s update." |
| `proof/observe/unit.py::input_files`, docstring | "Part `a` reads both imports of a first publish in the two-import layout, and the privileges read both" | adds: "Part `a` of a document made in HQ reads the app, media and seed under `authored/` in their place." |
| `proof/observe/casedata.py`, module docstring and `lookup_fixtures` | "`lookup_fixtures` uploads the lookup workbook Nova's push sends" | "`lookup_fixtures` uploads the lookup workbook Nova's push sends and serves the tables (`served_fixtures`); a document made in HQ uploads none and is served the tables its A was made with" |
| `.github/workflows/upstream-pins.yml`, header | "(proof/image.lock) and the surface regenerated from them" | adds: "and the retained HQ answers and apps made again at them (`proof/hq-reads/`, `proof/hq-apps/`)" |
| `proof-lane.yml`, the comment over `surface` | "`surface` puts the surface the candidate's pull request will carry in place" | adds the same sentence for `retained` |
| `proof/README.md`, "Changing a pin" | "The pull request that moves the pin regenerates them by copying `.proof/out/blocks/<id>/hq-reads/` over `proof/hq-reads/`" | "The weekly pin pull request regenerates `proof/hq-reads/` and `proof/hq-apps/` itself (`python3 -m proof.matrix.adopt`); a pin moved by hand runs the same command" and section 14's list |
| `proof/README.md`, "Timings" | the corpus counts and the table of expected ends | refreshed by `node proof/run.mjs --timings` over the step's first whole run |
| `proof/README.md`, "Step 1's decisions", 17 | "HQ's feature-matrix apps belong to step 6, whose reader is their first consumer." | adds: "Step 6 holds them as bases and variants (`proof/matrix`, `proof/hq-apps/`)." |
| `proof/store/keys.py`, module docstring | "`group_key(document key, judge, records)`: ... the judge's code (whose fingerprint includes both registers)" | adds: "and, for a corpus document, the reader bundle (`judged_under`)" |
| `proof/checks/manifest_usage.py::standing`, docstring | its last paragraph | 8.2's replacement |
| `proof/corpus/publish.ts`, header | "a ledger that records no identity override, so every id is the derived one" | "a ledger that records no identity override for a Nova-born document, so every id is the derived one; for an HQ-authored A, the ledger a bring-in leaves, with one identity row a menu and form (`hqAuthoredA`)" |
| `proof/corpus/documents.ts`, header | "Five sources feed the corpus" | "Six sources", with the bullet |
| `proof/corpus/targetPeer.ts`, `applyHqSide`'s doc comment on `buildProfiles` | "none of the peer's state" | the arm stores each profile as `LanguageProfilesView.post` does, replacing the map whole (2.5) |
| `proof/README.md`, "The defect rows", the row "1, language codes" | its Symptom cell | gains, after the sentence on the fix of step 2: "A language an author removes would leave the same profile behind; since step 6 a publish stops before it does (`hq_build_profile_language_missing`)." |
| `lib/commcare/__tests__/advancedDocArbitrary.ts`, header | "The proof sample does not use it." | removed: the lane's advanced family draws from it (11.2) |
| `docs/plans/hq-round-trip/README.md`, step 1's bullet on the proof lane | "proofs 1 to 5" | "proofs 1 to 6" |
| `lib/commcare/CLAUDE.md`, "The surface manifest" | (no sentence on coverage) | "Every entry is shown by an app made in CommCare HQ that comes in, by a variant of one with its expected finding, or exempted with a reason (`lib/commcare/surface/__tests__/entryCoverage.test.ts`)." |

`docs/testing.md` changes nothing: every new test follows it as written.

Where `proof/README.md` or `proof/CLAUDE.md` says which proofs an app made in CommCare HQ
passes on its first publish, it says "the first five proofs". "Proofs 1 to 5" is how those
files count every proof today, and the step's last check searches for that phrase as a stale
one (the top-level file, "Exit").

---

## Departures

Departures from the outline and the research, and the alternatives this part weighed and did not
take. Each states the decision and its evidence; a "Not done" names the alternative an implementer
could reach for, and why it is not built. The numbers are fixed, since other files cite them.

1. **`hq-plain` is the one base with a hand-written document.** Not done: a hand-written document
   for a starter, because one small app whose every shape a person can state from its builder is
   enough to hold the reader to a second author, and a starter's nine forms are not.
2. **The reader bundle's digest is an input of the judged key of every corpus document's group.**
   Not done: a key that is proof 6's judgment alone, because the store has none:
   `proof/store/keys.py::judgment_key` derives from `group_key`, and
   `queue.py::Builder.document` decides cached, judged or observed a group at a time. The cost is
   accepted: a reader change costs what a judge's file costs, every judge of every corpus document
   group run again from its stored records and no document whose files are unchanged observed,
   about twelve minutes on three shards with the controls left cached (5.6, 12.3).
3. **The bar, intent and the manifest check judge A as well as B and B-edit.** Not done: judging B
   alone, because a base that HQ cannot build or that holds a refused value
   is a broken base, and the manifest check over A is the one classifier of A that is not the reader;
   intent at A holds HQ's own build to what the reader said A means.
4. **Sensitivity is not run on an HQ-authored document**, the one check of the hop left out (section
   4). Evidence: its flips rebuild A (`proof/observe/unit.py::observe_a`, `flip_builds`), and a
   gate's `effects` are written from what HQ's build changes of Nova's exports
   (`proof/README.md`, "Configuration sensitivity"); the weekly's both-ways hold would then fail on
   effects only an HQ-authored A shows. Flags HQ reads building B are held by the manifest check.
5. **Every exhibited entry's variant is made in HQ.** Not done: a JSON value set by hand in a
   retained source for the `schema:`-only entries, because HQ's own model then never says whether
   it can hold the value (7.2, 7.3).
6. **A starter app's media are stand-in files, made by the lane and attached
   with the calls HQ's loader makes, named as a seam (6.3).** Not done: the files HQ's loader
   fetches, kept as a retained set, because `load_app_from_slug` fetches
   from addresses the lane does not reach and tolerates a missing file, and the fetched files are
   not Nova's to commit to a public repository.
7. **From the outline's item 7 and its Exit.** "At least one HQ app per manifest entry ... plus
   generated combinations" and "every other app is refused with the right reason" become: every
   base comes in, republishes and passes section 4's checks; every variant is refused or held as its
   row says, or its value is one CommCare HQ never serves; every entry is in one of 7.5's sets. The
   outline's "generated combinations" are the one composed variant (`two-refusals-one-pass`);
   combinations of held entries are the bases themselves.
8. **From the outline's item 4 (drift merging).** Built in step 6 by part 15
   (`15-changes-made-in-commcare-hq.md`), with no merge, so the outcome is `brings-in` and never
   `merges`. `HqSideSaveKinds` gains the content saves and `HqSideSaves.republish` the outcome, by
   section 6.6.
9. **Proof 6 runs on B-edit**, for every edited
   document with no `hq-side.json`. Not done: proof 6 at A and B alone, because D′ is a Nova
   document as much as D is, and the read costs five
   requests. `canonDocument` applies to every D′, an HQ-authored base's among them, since an edit
   made in Nova can hold either member of a canonical pair (5.1).
10. **Thirteen HELD-NEW value-class readers in Python** (8.2), where part 01 and
    part 04 leave the number to this part. Not done: leaving every HELD-NEW class that shares a
    key unjudged by Python, as the lane does today, because where step 6 cuts a HELD row by one
    value's grammar or bound, a wrong draw publishes over an app Nova mis-read (8.2).
11. **`hq-plain`'s hand-written document is kept** as the one reading
    held to a document a person wrote (2.1). Not done: holding `hq-plain` by its reading alone,
    because neither production acceptance nor proof 6 can catch a consistent mis-read: it
    prints back to itself (5.1).
12. **No departure on migration, rollout or product code.** This part changes nothing under `lib/`
    but `lib/commcare/surface/__tests__/entryCoverage.test.ts`, the reader's own test directories
    (section 10's suites, and part 07's form-builder case of `saveToCase.retained.test.ts`), one
    header sentence of `lib/commcare/__tests__/advancedDocArbitrary.ts` (11.2) and one sentence
    of `lib/commcare/CLAUDE.md` ("Contracts"). `proof/reader/` imports part 12's `gatherFromHq`
    and, for a read back, the reader and part 05's two reads, with part 11's
    `ReadingProjectSide` type and `levelsFromHq`, part 10's resolver and identity functions, part
    09's `readBack.ts`, `canon.ts` and `readingAppStrings`, and part 08's
    `recordDialectRoundTrip` (5.2). It is imported only by Vitest suites and their helper
    (`bases.retained.test.ts`, its own `__tests__/`, and `__tests__/helpers/retainedHqApps.ts`,
    whose `laneInputOf` answers a `LaneReadInput`). No production module imports it.
13. **Part 09 holds the one canon list, in `lib/commcare/reader/canon.ts`, and this part keeps
    none.** Not done: a list of the canonicalizations collected here under `proof/reader/`,
    because part 09's acceptance tests and its fuzz read back need the list where the reader is,
    and a second list would have its own ids, its own equal-bytes test and its own fuzz read back,
    and two lists drift: a row one holds and the other lacks, or one id spelled two ways. One list
    has one definition. What proof 6 needs of the list is kept: every canonicalization is a row
    proof 6 applies, and P5 adds what the lane's run finds.
14. **What `hq-plain` holds.** It holds no `case_preload` and turns Web Apps on. Evidence, each
    read at source ("Executed during planning"): the basic Case Management page offers no load, so
    a person loads a case's value by typing a default; and a new app's Web Apps setting is off,
    and a publish that turns it on asks first. Not done: a `hq-plain` that holds the two as other
    bases do, because each is another base's to show: `hq-case-management` holds a stored
    `case_preload`, and `hq-new-app` leaves Web Apps off.
15. **An HQ-authored document has one configuration** (2.4). Not done: a second configuration for
    a base (a `maximum` other than its `minimum`, or a `singleFlag` entry), because A is authored
    under one set of flags, and the app HQ's
    pages make under another set is another app, so no second A exists to be made; the one check
    that reads a flag's effect, sensitivity, does not run on the source (Departure 4).
16. **A base is read under a stated declaration where it exists to show a
    change that depends on the choice** (6.1). Part 09's register has three such entries
    (`web-apps-turned-on`, `web-apps-turned-off`, `date-and-time-questions-split`), and the
    declaration is the person's choice in the review (the top-level file `../6-bring-in.md`, "What
    changed from the outline, and why", item 5). Three bases state one; every other takes the
    preselected one, which the base's `expected.json` records.
17. **A variant is read in the lane, where HQ made it.** Not done: retaining each variant as
    patches for a Vitest suite. The patches, their two readers and their tests would verify the
    transport and nothing of the reader, and a pin move would rewrite several hundred of them. The
    cost is stated: a reader change that breaks only a variant is first seen in the pull request's
    lane run (7.2).
18. **Two things the lane's own types carry, and one they do not.** A base's
    `expected.json` records the declaration it was read under, so 7.5's rule 2 and 6.4's rules
    read a fact and not an expectation (6.1). `LaneReadInput` carries `appId`, and the lane's one
    target and one reading id are `LANE_TARGET` and `LANE_READING_ID` (5.2). Not done: ids minted
    in the lane, because parts 11 and 12 derive every lookup id and every provisional media id of
    a reading from the app's id and the reading's id, so the lane hands production one fixed
    reading id and an emission is byte-stable with no minting code of its own.
19. **No rule is written for `field-list` in another case.** Not done: the spelling rule
    `field-list-appearance-case`, because no check of the hop reports the two spellings apart
    (section 4). Acceptance needs nothing for it: part 09's check 5 compares no type.
20. **The lane calls `gatherFromHq`, not `gatherReading`.** Not done: calling `gatherReading`,
    because its steps 1 and 2 read Postgres (the stored connection and the advisory claim read)
    and the bundle opens no socket. `gatherFromHq` is every later step of production's read as
    one function (part 12, section 3.3), so the lane copies none of them (5.2).
21. **The advanced menus the lane reads are a fuzz family of its own** (11.2). Not done: leaving
    them to the targeted documents that hold an advanced menu, because each of those fixes one
    shape by hand, and until now the reader's advanced reading was proven over drawn shapes in
    Vitest alone. Not done: drawing them inside the original sample, because that would move the
    draws, the ids and the stored evidence of the 24 documents the lane has measured.
22. **Each state of "save only if changed" is one base's content** (6.2: `hq-case-management`
    with the flag, `hq-advanced` without it). Not done: a variant for either state, because a
    variant never publishes, and what the state decides shows on the hop: with the flag, that
    Nova's publish keeps the comparison HQ's build makes; without it, that the respelled word
    changes no build file. Not done: a twenty-third base for it, because the flag changes nothing
    else HQ's build writes of those two apps.
23. **The fixed corpus's left-out list is a committed file the emission holds** (11.1). Not done:
    comparing two emissions before a push, because that is neither a test nor a decision: a rule
    that refuses one document more would still pass every run in which nobody compared.

---

## Files

**New**

- `proof/matrix/`, the package that authors the bases: `__init__.py`; `registry.py` (`Base`,
  `Declaration`, `BASES`, and the loader of `variants.json`); `author.py` (`Authoring`,
  `authored`); `retain.py`; `retained.py` (`Retained`); `seed.py` (`case_seed`); `ops.py`
  (`set_json`, `set_form_source`, `builder_save`, `post`); `media.py` (`stand_in`); `adopt.py`;
  `bases/*.py`, one module a base of 6.2; `variants/*.py`, one a manifest area, the named changes;
  `variants.json`; `exemptions.json`; `conftest.py` (`DOCUMENTS`); `test_retained.py` (the three
  tests of 2.3, 7.2 and 7.4); `test_remade.py`; `test_seed.py`; `test_expectations.py`;
  `test_media.py`.
- `proof/matrix/hand/<base>/`, what a person writes: `expectations.json` and `restore.xml` for
  each base, `edit.ts` for the three bases of 6.5, and `hq-plain/document.ts`.
- `proof/hq-apps/<base>/` for the twenty-two bases, with the files of 2.2, written by the lane.
- `proof/corpus/hqAuthored.ts` (the source's reader and `hqAuthoredDocuments`);
  `proof/corpus/left-out.json` (11.1); `proof/corpus/__tests__/hqAuthored.test.ts`.
- `proof/first-publish-changes.json` (9.1): its ids and `source` rows are part 09's to give, its
  other rows the runs'.
- `proof/reader/`: `laneReading.ts`, `retainedPeer.ts`, `cli.ts`, `build.mjs`,
  `__tests__/retainedPeer.test.ts`.
- `proof/targeted/documents/saveToCaseShapes.ts` (`targeted-save-to-case-shapes`, 6.2).
- `proof/checks/`: `changes.py` (`load`, `declared`, `differences`, the `rows` command),
  `source.py`, `proof6.py`, `parity.py`, `readerbundle.py`, `test_proof6_fixed_point.py`,
  `test_proof6_controls.py`, `test_parity.py`, `test_parity_controls.py`, `test_source.py`,
  `test_first_publish_changes.py`, `test_first_publish_changes_controls.py`,
  `fixtures/source-families.json`.
- `__tests__/helpers/retainedHqApps.ts`; `lib/commcare/reader/__tests__/bases.retained.test.ts`
  and `schemaKeyVariants.test.ts`; `lib/commcare/surface/__tests__/entryCoverage.test.ts`;
  `proof/ci/__tests__/readerBundle.test.ts` and the case over `proof-lane.yml`.

**Changed**

- `proof/corpus/documents.ts` (`CorpusSource`, `CorpusDocument.hqAuthored`, `LAYOUT_FILES` gains
  `first-publish.json`, `FUZZ_GENERATORS` and `fuzzSplit` gain the advanced family, the header's
  "Six sources"); `defaults.ts` (`DEFAULT_ADVANCED_SAMPLE_SIZE`); `fuzzSample.ts` (`ARBITRARIES`);
  `entryWriter.ts` (`sourceName`, the `authored/` copy, `configurations.json` from `base.json`,
  the expectation expansion and the `restore.xml` copy, `first-publish.json`, the `hq-side.json`
  refusal); `emitCorpus.ts` (the bases on the fixed floor, `leftOutDifferences`); `emit.ts`
  (`--with-hq` removed, the stop on `left-out.json`); `inputs.ts` (the `authored.` roles);
  `publish.ts` (`hqAuthoredA` and its ledger); `targetPeer.ts` (`holdSource`, the lookup table
  reads, `build_profiles`); `__tests__/publish.postgres.test.ts`, `publish.test.ts`,
  `emitCorpus.test.ts`, `fuzzSample.test.ts`.
- `lib/commcare/__tests__/advancedDocArbitrary.ts` (its header sentence, 11.2);
  `proof/targeted/documents/hqSideState.ts` (its header comment, 2.5).
- `proof/hq/operations.py` (`save_authored_app`, `save_authored_tables`, `save_authored_places`,
  `location_types_read`); `proof/hq/test_retained_reads.py` (imports `Retained`).
- `proof/observe/publish.py` (`create_authored`, `first_publish_digest`); `unit.py` (`create_a`,
  `input_files`, `restore_for_sessions`, `b_context`, `observe_b_aligned`, `api_reads` and its
  call sites); `sessions.py` (`hq_restore`'s arm); `intent.py` (`_runs_at`); `casedata.py`
  (`seeded_case_database`, `document_case_database`, `served_fixtures`, the seed's
  `index_identifier`); `proof/formplayer/hq.py` (`create_worker`'s place).
- `proof/checks/corpus.py` (`Document.exports`, `hq_authored`, `authored`, `case_seed`);
  `configurations.py` (`_content_privileges`); `eligibility.py`; `intent.py` (`saved` from A's
  profile); `proof1.py`, `proof2.py`, `proof3.py` (each asks `changes.declared`);
  `differences.py` (`CHECKS`); `registers.py` (`HELD_CHECKS`, the refusal of L8);
  `observations.py` (`OPERATION_CHECKS`); `manifest_usage.py` (`standing`);
  `manifest_value_classes.py` (thirteen readers); `sharding.py` (`SPLIT`, `collection_roots`'
  docstring); and the tests `test_corpus.py`, `test_intent.py`, `test_build_files.py`,
  `test_registers.py`, `test_manifest_value_classes.py`, `test_manifest.py`,
  `test_judge_purity.py`, `test_record_determinism.py`.
- `proof/store/fingerprints.py` (`JUDGE_FILES`), `keys.py`, `queue.py` (`PACKAGE_DATA`), `pack.py`,
  `test_keys.py`, `test_pack.py`; `proof/lane/blocks.py` (the manifest's `reader`;
  `CORPUS_PACKAGES` gains `proof/matrix`; `SINGLE_GROUPS` and `group_problem` lose
  `hq-selfchecks`), `test_blocks.py`.
- `proof/native/produce.py` (`produce_reader`, `produce_all`); `proof/ci/products.mjs`;
  `proof/views/test_exports.py`.
- `.github/workflows/upstream-pins.yml` (the `retained` job), `proof-lane.yml`
  (`inputs.retained`), `proof/upstream/pins.mjs`, `proof/upstream/__tests__/pins.test.ts`.
- For part 15's documents (6.6): `proof/corpus/documents.ts` (`HqSideSaveKinds`, `HqSideSaves`),
  `proof/observe/hqside.py` (`SAVES`, `STATEMENTS`), `proof/editors/vellum.py` (`open_and_save`'s
  edit step), `proof/checks/corpus.py` (the outcome `brings-in`), `proof/observe/publish.py`
  (`upload_media`'s hold) and `proof/observe/unit.py` (the `saved` read). The ten builders under
  `proof/targeted/` are listed in part 15.
- `proof/timings.json`, from the step's first whole run; `biome.json`; and the documents of
  "Contracts": `proof/README.md`, `proof/CLAUDE.md`, root `CLAUDE.md`, `lib/commcare/CLAUDE.md`,
  `docs/plans/hq-round-trip/README.md`.

**Moved**

- `proof/corpus/hq/test_privileges.py` to `proof/hq/test_privilege_rules.py` (section 13);
  `Retained` out of `proof/hq/test_retained_reads.py` into `proof/matrix/retained.py` (2.3).

**Removed**

- `proof/corpus/hq/`: `__main__.py`, `harvest.py`, `sources.py`, `test_harvest.py`,
  `test_sources.py`, `conftest.py`, `__init__.py` (section 13).

**Not changed, and why**

- `proof/checks/bar.py` and `observations.py::judged_states`, which already judge every state of
  an `hq-authored` document (section 4).

**Not written here**

- A canon list under `proof/reader/` with its equal-bytes test, a comparison module under
  `proof/reader/`, a fuzz read back under `lib/commcare/reader/__tests__/`, `notCarried.test.ts`,
  or a second Vitest of the first-publish file. Part 09 owns each one's subject (5.2, 5.5, 9.1).
- Part 05's lane reads and their retained files, which are part 05's own (its section 14.1).
- The lane files of the targeted documents and native families the other parts add, each planned
  in its own part.
