# Step 6, part 14: Proof

This part plans how the proof lane holds step 6: the lane groundwork and the probe (A1), proof at full
(B13: the HQ-authored bases, their variants, proof 6, parity, the first-publish judge, coverage), and
the proof lines of every pull request of both stacks (A1 to A11, B1 to B15). It replaces the outline's
item 7 and its Exit, and takes every proof hand-off the other parts address to A1 or
B13. Pull requests are named by their ids in the two stacks (A1 to A11, B1 to B15: the top-level
file `../6-bring-in.md`, "The stacks"); other parts as "part NN (file), section N" with the pull
request beside them.

Citations are `path::symbol`: Nova at `main` `15a00a97`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`.
Every CommCare fact below was read at those commits for this part. Nothing was run: no lane, no
emission, no test. Every count comes from `jq` or `python3` over committed files.

| Section | Owns | Pull request |
|---|---|---|
| 1 | what the lane does today, for this part's ground | none |
| 2 | the sixth corpus source `hq-authored`: `proof/hq-apps/`, `proof/matrix/`, how A is made in the unit, what stands where a first publish stood, the capture over an A Nova did not send, identity overrides, the case database seeded from A | A1 (tables and places: B13) |
| 3 | the probe: the base `hq-plain`, its hand-written D, the run by hand, outcomes | A1 |
| 4 | which proofs run on the A to B hop, and what each needs changed | A1 (proofs 1 to 5), B13 (proof 6, parity, `source`, changes) |
| 5 | proof 6: the reader bundle, the lane's new records, the judge, part 09's `canonDocument`, the store key, the Vitest rung | B13 |
| 6 | the twenty-two bases | A1 (`hq-plain`), B13 (the rest) |
| 7 | variants, the synthetic layer, coverage | B13 |
| 8 | parity between the reader's claim log and the lane's Python standings | B13 |
| 9 | `proof/first-publish-changes.json` and its judge | A1 (the file begun, and its hold), B7 (part 09 completes the file), B13 (the `source` comparison and the judge's four holds) |
| 10 | Vitest suites of the reader over retained HQ answers | B13 |
| 11 | each pull request's proof lines, both stacks | all |
| 12 | cost per pull request and per night, runs by hand | all |
| 13 | `proof/corpus/hq/` and its self-checks | B13 |
| 14 | the weekly pin pull request and regenerating `proof/hq-apps/` | B13 |

---

## Decisions in brief

1. **A sixth corpus source, `hq-authored`, whose A Nova never sent** (section 2). A base is authored
   through HQ's own models and pages in a lane package group (`proof/matrix/`), retained whole under
   `proof/hq-apps/<base>/` and held byte for byte to HQ at the pin on every lane run. The unit makes A
   from the retained stored app through `Application.from_source` and `save_attachments`, so A holds
   exactly the menu ids, form ids and `xmlns` the emission read. Such a document has no first
   publish, and 2.4 names what stands in each place the lane read one.
2. **The capture publishes D over that A with identity overrides** (2.5): the peer starts from HQ's
   retained source answer, the ledger is the one a bring-in leaves, and every id comes from
   `lib/commcare/wireIdentity.ts::targetWireIdentity` over the overrides.
3. **Proof 3's case database for an HQ-authored document is seeded from A alone** (2.6): case types
   and properties from HQ's own property map, types from HQ's own question summary, compared literals
   from Core's parse of A's expressions. D contributes nothing.
4. **The probe base in A1 is `hq-plain`, an app HQ's own pages make, not a starter app** (section 3,
   Departure 1): every starter app holds a menu that shows its forms in the menu above, a Register
   action on a case list, and media at HQ's own paths, none of which Nova at A1 can hold. The three
   starter apps are bases of B13, and their first lane run is the second probe.
5. **One table says which proofs run on the A to B hop** (section 4): the bar, intent and the manifest
   check judge A, B and B-edit; proof 1 runs against the first-publish register; proof 2 judges every
   build file but a form's XML; proof 3 always walks B; proof 4 runs; proof 5 runs where the base
   states an edit; sensitivity does not run. From B13 a comparison of the two stored apps, `source`,
   runs on this hop alone.
6. **Proof 6 is a judge that runs the reader bundle under the image's Node** (section 5), over new
   records of each unit (HQ's source answer, its application resource and its version answer, read
   through HQ's API in a fork). Nova-born documents: `read(served(D)) = canonDocument(D)`.
   HQ-authored documents: `read(A) = D` and `read(served(D)) = D`, exactly.
7. **`canon` is part 09's one closed list**, `lib/commcare/reader/canon.ts::CANONICALIZATIONS` with
   `canonDocument` (part 09, section 9, B7), each row proven there to print equal bytes. This part
   keeps no second list and no second proof of it (5.5).
8. **The bundle's digest joins the judged key of corpus document groups and no other key** (5.6):
   a reader change judges every corpus document again from stored records and observes no Nova-born
   document. A base whose reading changes is emitted anew and observed again, as an emission change
   would be.
9. **Twenty-two bases** (section 6): one probe, a just-created app, that app after a save on each HQ
   page, three starter apps, and sixteen authored bases, each named with what it exhibits, the
   declaration it is read under, its hand-written value expectations and its edit where it states
   one.
10. **A variant is a patch over its base's retained answers with an `expected.json`** (section 7).
    Entries on `schema:` keys alone are exhibited by a synthetic layer in Vitest; every other
    non-allowing entry an app source can hold gets an authored variant. Coverage is three sets and a
    closed exemption list, held both ways by one test.
11. **Parity is a lane judge over the bundle's claim log** (section 8), required on every use the
    Python check decides. Python gains thirteen HELD-NEW value-class readers, named.
12. **`proof/first-publish-changes.json` has the shape 9.1 gives it, is strict both ways and is
    scoped to named HQ-authored bases** (section 9). A1 begins it with the entries the probe shows,
    under the ids of part 09's register, B7 completes it to the register, and from B13 a judge holds
    part 09's four things on every base:
    nothing undeclared, nothing declared in vain, behavior only where behavior is declared, and
    `bases` the truth.
13. **`proof/known-defects.json` stays empty.** An outcome that would add a live entry is settled
    before the merge: fixed, declared in the first-publish register, or taken out of what the reader
    holds as a `not-yet` entry with its owner (11.3).
14. **`proof/corpus/hq/`'s harvest is removed** and its privilege tests move to `proof/hq/`
    (section 13).
15. **The weekly pin pull request regenerates `proof/hq-apps/` itself**, in a job of its own whose
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
- **The plan's other parts**: parts 01, 03, 04, 05, 06, 07, 08,
  09, 10, 11 and 12 at their openings, hand-offs and the sections this part reads (01: 3.2, 5, 7.1,
  7.3, 8.3; 03: 8.1, 8.2; 05: 9, 14 and Departure 3; 06: 2.2, 4.5, 9.2, 16.2, 16.3; 07: 8.7, 13.3;
  08: 5.5, its canonical tree; 09: 2.2, 5, 9, 11, 13 and its runs K1 to K4; 10: 2.2 to 2.5; 11: 5
  and 14; 12: 3.3 and 3.6). Part 13 was read at its opening and its run E1.
- **Read as well, for the readers of a first publish (2.4), the seed (2.6), the probe base (3.1),
  the bundle's peer and keys (5.2, 5.6) and the pin workflow (section 14)**:
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
  `retainedHqReads.ts`; `docs/testing.md` on native `fetch`; `lib/domain/multimedia.ts::
  mediaAssetIdSchema`, `lib/domain/uuid.ts::CANONICAL_UUID_PATTERN`;
  `lib/commcare/targetOverlay.ts::projectProfileForTarget`, `holdsNoValue`;
  `.github/workflows/upstream-pins.yml` (its jobs) and `proof-lane.yml` (`inputs.surface`). At HQ:
  `models/applications.py::_import_app` and `_create_app_from_doc` again, `Application.
  cloudcare_enabled`, `get_case_types`; `corehq/blobs/mixin.py::atomic_blobs`;
  `app_manager/util.py::update_form_unique_ids`; `app_schemas/case_properties.py::
  ParentCasePropertyBuilder`, `_propagate_and_normalize_case_properties`; `models/forms.py::
  get_contributed_case_relationships`; `models/form_actions.py::OpenSubCaseAction`, `CaseIndex`;
  `views/settings.py::edit_commcare_profile`; `views/apps.py::edit_app_attr` (its
  `cloudcare_enabled` arm), `_build_sample_app`; `templates/app_manager/partials/forms/
  case_config_ko_templates.html` and `case_config_advanced.html`; Vellum's
  `javaRosa/plugin.js` (`hasMarkdown`).

Counted at `15a00a97`:

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
  such defaults; health's three case forms read the case only in other logic). `template_apps/`
  holds a fourth directory, `wash_before_cond_case_update`, with the same five menus, six forms,
  four `put_in_root` menus and `case_list_form` blocks as `wash`; HQ's own test of the templates
  loads the other three (`app_manager/tests/test_apps.py`).
- `proof/checks/manifest_value_classes.py::VALUE_CLASSES`: 203 readers.

Read at source, and what each decides here:

**No starter app can be written as a Nova document at A1.** All three hold `put_in_root: true`
menus and a `case_list_form` with no search (counts above), which become Nova concepts in A4 and
A5, and all three hold media under HQ's own paths (`commcare/image/module0_en.png`), which Nova
writes back at those paths only from B8's `app_deployment_media_paths`. Departure 1 gives the
decision.

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
plus generated combinations." 18 non-allowing and 27 allowing entries can sit in no app's source, and
one app an entry through the unit would be about 1,250 document groups. Coverage is defined in
section 7.

**What `hq-plain` leaves out or sets, so that it holds only what Nova at `15a00a97` holds.** Four
things an app made in HQ's pages would otherwise hold or lack are outside that, each read at
source (Departure 14):

- *A hint.* Nova at `15a00a97` writes a formatted copy for every hint, and HQ's form builder writes
  one only where the text held formatting (Vellum's `javaRosa/plugin.js`, `item.hasMarkdown`). Part
  03 (A8) stops writing the copy and lands the rule that erases the difference. So `hq-plain` holds
  no hint and no validation message; `hq-questions` (B13) holds them.
- *A load through `case_preload`.* The basic Case Management page has no load section: the template
  `case-config:case-transaction:case-preload` is used by `case_config_advanced.html` alone
  (`partials/forms/case_config_ko_templates.html`), and the manifest says so
  (`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held`). A person
  loads a case's value by typing `#case/members` as the question's default in the form builder,
  which is how `hq-plain` does it. A stored `case_preload` is another matter: the page's save keeps
  one (`forms/case_config_ui.js::HQFormActions.from_case_transaction`) and HQ's build writes it, so
  part 07 (B4) re-cuts that entry from REFUSED to HELD-NEW, owner `forms-and-case-management`, and
  its new cell keeps the sentence about the page (part 07, section 14 and Departure 9).
- *Web Apps off.* `Application.cloudcare_enabled` defaults to false and `default_new_app` sets
  nothing, while a D that declares both platforms publishes it true, which Nova's publish asks a
  person about first. `hq-plain` turns Web Apps on through `edit_app_attr`; the change itself is
  `hq-new-app`'s to show in B13 (part 09's `web-apps-turned-on`).
- *An empty profile.* `lib/commcare/targetOverlay.ts::projectProfileForTarget` writes each of the
  fifteen seeded settings wherever the target holds no value (`holdsNoValue`), so a publish over an
  app with none turns fifteen absent settings into stated ones. Part 01 section 7.3 ends that for a
  deployment Nova brought in, in B8. `hq-plain` saves the seventeen settings Nova states on HQ's
  settings page (`views/settings.py::edit_commcare_profile`), so nothing is seeded on it;
  `hq-new-app` holds none and lands in B13, above B8, where part 01's Run 3 reads it.

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

Every run is on GitHub's hosted runners. None runs on the person's machine, and each run started by
hand is asked of the person first, with its expected cost (12.4).

**P1. The probe (A1).** Where: `gh workflow run proof-audit.yml --ref <A1's branch> -f nightly=false
-f mechanics=hq-plain`, every reader on, once A1's own CI is green. It asks how HQ's authoring and
Nova's emission of one meaning differ in what a reader reads. Each difference the gate reports falls
in exactly one class, decided at source:

| Outcome | What it is | What lands |
|---|---|---|
| A | no difference but those `proof/first-publish-changes.json` names for `hq-plain` (3.3's candidates) | nothing more; A1 merges with the file as written |
| S | two spellings every reader reads alike (an itext id, a Vellum data attribute, an attribute order HQ's build keeps) | a spelling rule `proof/rules/<rule>.py` with its proof on every reader of the spelling, in A1 |
| B | an emission gap: Nova can write HQ's meaning and does not | `proof/matrix/bases/plain.py` leaves the shape out in A1, `proof/hq-apps/hq-plain/` is made again without it, and A1 merges on the rest, so no stack A pull request below the fix runs red. The pull request that owns the emitter fixes it (a text or markdown difference in A8, a prose difference in A7, a profile, app string or setting difference in A3, a menu difference in A4 or A5, a name's grammar in A9, anything else in A2 beside the manifest row it belongs to), adds the shape back to `bases/plain.py` and to the hand-written D, makes the retained tree again (`python3 -m proof.matrix.adopt`, section 14), and P1 is repeated at its head |
| C1 | a change Nova's spelling makes on purpose, of a kind the first-publish register is drawn from (a generated node, a guard, `update_case` always, the external id move, a new export column, a field `applicationShell` writes: part 09, 09-acceptance-and-the-first-publish.md, section 11, B7) | an entry of `proof/first-publish-changes.json` with `bases: ["hq-plain"]`, its rows written from the run's evidence in A1, under the id part 09 section 11.2 gives the change. Where part 09 has no entry for it, the id is a new member of `CANDIDATE_IDS` and part 09 gains the entry in B7 with its predicate, paths and sentence, as its run K3, outcome B, words it |
| C2 | a change of any other kind that a runtime, HQ's servers or stored data read | the shape leaves what Nova holds: a HELD-NEW manifest entry in A2 with `subject` and `owner` by part 01's rules, `hq-plain`'s builder stops making the shape, and the shape becomes a variant in B13 |
| H | a report a reader makes of an app HQ's own pages made, with no Nova byte in it (seen on A itself) | a member of `HQ_OWN_REPORTS` with its proof, in A1 (`proof/README.md`, "Spelling rules and the registers") |
| W | a walk stops | where a worker would go on, the walk is taught, in A1. Where the reader ends there on A and on B alike, a `proof/walk-stops.json` entry naming `hq-plain` with the reader's own reason. Where it stops on B alone, it is B, C1 or C2 |

A1 does not merge until a probe run's gate passes. No outcome adds an entry to
`proof/known-defects.json`.

**P2. The starter apps and every base with every reader (B13).** Where: `gh workflow run
proof-audit.yml --ref <B13's branch> -f nightly=false -f mechanics=<base ids>`, in two dispatches
before stack B merges: eleven bases and then twelve, `hq-plain` in both (12.4). It runs part 07's G3,
part 08's E6, part 10's G2, part 09's K3 and part 01's Run 3 (proof 1 on `hq-new-app`, judging B8's
code) as those parts word them, on the bases 6.2 names for each. This dispatch is G3's run, as part
07 (07-the-reader-cases-menus-lists.md, "Written and not yet run", B4 and B5) words it: a
`mechanics` dispatch names documents and holds them at the gate, which is what G3 asks. Part 07's G1
is read with it: its form-builder case is a Vitest over `hq-nova-then-builder` in B13's own CI, and
its outcome C is this run's C2. Outcomes, by difference:

| Outcome | What lands |
|---|---|
| A: no difference beyond the register | nothing |
| S, H | as P1, in B13 |
| R: the reader read A wrongly (proof 1, 3 or intent shows a meaning A does not hold) | the reader pull request that claims the entry (B3 to B6) is amended on the stack; the base's hand-written expectation gains the value that showed it |
| B: an emission gap | fixed in B7, beside the `EMISSION_REWRITES` site, with a unit test |
| C1 | a `FIRST_PUBLISH_CHANGES` entry in B7 with its predicate, paths and sentence (part 09's K3, outcome B), and its rows and `bases` in the lane file in B13 |
| C2 | the claiming reader pull request re-cuts the entry so the value is `not-yet`; an authored base moves the shape to a variant. Under part 07's G1, outcome C, that is: the Save to Case forms leave `hq-nova-then-builder`, which keeps its form without one, and become the variant `hq-nova-then-builder/save-to-case-saved`, whose `expected.json` names `questions/savetocase-block-outside-nova-s-own-block-shape` with its standing |
| D: a starter app reads as an account | stack B does not merge. Step 6 brings every concept a starter holds into Nova as stack A (the top-level file `../6-bring-in.md`, "The baseline this plan was written against", the starter apps, and "What changed from the outline, and why", item 16), so the finding is a reader defect (R) or a re-cut owed (the entry's HELD class is widened in the pull request that claims it, with the starter as its exhibit). Where the finding names a concept no stack A pull request built, the person is told before anything merges, with the finding and the starter's place. Part 08's E6, outcome B (08-the-reader-expressions.md, "Written and not yet run", B6), is this row for a record expression the checker refuses: B6 widens the record rule set to that expression, with the starter as the widened class's exhibit, and E6 runs again inside this dispatch |
| W: a walk stops | where a worker would go on, the walk is taught (B13). Where the reader ends there on A and on B alike, a `proof/walk-stops.json` entry naming the base and the reader's own reason. Where it stops on B alone, it is R or B |

**P3. The bundle's bytes (B13).** Where: B13's own CI, `proof/ci/__tests__/readerBundle.test.ts`
(two builds on one runner) and the weekly `proof-image.yml` product comparison (two architectures).
A: equal both ways, nothing lands. B: two builds on one runner differ: the entry point's source of
nondeterminism is found from `esbuild`'s metafile and removed before B13 merges. C: equal on one
runner and unequal across architectures: `proof/ci/products.mjs` compares the bundle by what it
answers for `hq-plain` (its read document and claim log) in place of its bytes, and says so in its
header; the store's keys already name the architecture.

**P4. The judge's cost (B13).** Where: `gh workflow run ci.yml --ref <B13's branch> -f
proof_fresh=true`, then `node proof/run.mjs --timings` over its outputs, committed in B13. A: the
median `proof6` item is under five worker-seconds: the judge starts Node once a document (5.4). B: it
is five or more: `proof/reader/cli.ts` gains `--serve` (one JSON line a request, as
`proof/hq/xpath/` serves HQ's validator) and `proof/checks/readerbundle.py` keeps one child a worker,
before B13 merges.

**P5. Proof 6 over the Nova-born corpus (B13).** Where: B13's own CI. A: every document reads back
to `canonDocument(D)`. B: a document differs and the two documents print equal bytes: the pair
joins part 09's `CANONICALIZATIONS` (`lib/commcare/reader/canon.ts`, amended in B7 on the stack) as
a `one-wire` row with its case of `lib/commcare/reader/__tests__/canon.test.ts`; where the reader
module that owns the slot must choose the member, its row of `READER_CANONICAL_CHOICES` is added in
that module's pull request first, and `canon.ts` wraps it.
C: it differs and the bytes differ: a reader defect, fixed in the claiming pull request. D: the
reader gives an account of Nova's own export: the reader lacks a fold (fixed in its pull request), or
an entry's disposition is wrong (fixed in the pull request that owns the entry). Stack B does not
merge with a `proof6` difference, and none is ever a register entry.

**P6. Parity's first run (B13).** Where: B13's own CI. A: every decided use agrees. B: the reader
claims a use under an entry Python's standing rules out: whichever is wrong at source is corrected,
the reader in its pull request or the Python reader in B13. C: Python finds a use at an `(artifact,
where)` the log has no record for: `xmlCursor.ts::elementWhere` or the pointer escape is corrected in
B2 with the vector added to `proof/checks/fixtures/place-vectors.json`. The join is never loosened.

**P7. A made again from its retained document (A1).** Where: A1's own CI,
`proof/matrix/test_remade.py`. A: the app `from_source` makes of `app.json`, saved by
`save_attachments`, gives `to_json()` equal to the retained document but for `_meta_fields` and each
form's attachment digest. B: another field differs because `wrap` rewrites it: the retained
`app.json` is written after one `wrap` and `to_json` round, so it is a fixed point; the test then
holds that. C: a field
still differs: the unit's arm saves the document with `Application.get_db().save_doc` after
`wrap_app`, in place of `from_source`, and the test names the field.

**P8. The media read at the pin (B13).** Where: B13's own CI, `proof/matrix/test_retained.py` over
the four bases that map media, and `hqApps.test.ts` over what it retained. A: HQ answers each mapped
file's read (5.3) with the file's bytes, and Nova's `readHqMediaFile` reads each from the retained
answer: nothing more lands. B: HQ answers a read with something other than the file: that is part
05's reader meeting an answer it did not plan for, the bases stay as written, and part 05's section
9 is corrected in B1 on the stack from the retained answer before stack B merges. C: Nova's client
asks for an address the lane did not read: the URL Nova builds is not the one HQ gives the map item
(`hqmedia/models.py::HQMediaMapItem.url`); `lib/commcare/hq/media.ts` is corrected in B1.

Runs of other parts this part hosts or feeds: part 01's Run 1 (A3, `targeted-kept-values`) and its
Run 3 (proof 1 on `hq-new-app`, run in P2, judging B8); part 02's G1 to G3 and G6; part 03's G1 to
G5; part 04's R2; part 05's G1 to G7 (`proof-slice.yml`); part 06's R1 (B3's own CI) and R2 (by hand
through `reader-scale.yml`); part 07's G1 (B13's own CI, read with P2) and G3 (inside P2); part 08's
E1 to E4 (B6's own CI) and E6 (inside P2); part 09's K2 (`proof-slice.yml` on B7's branch), K3
(B13's own lane and P2: the judge of 9.3 over every base) and K4 (by hand through
`reader-scale.yml`); part 10's G2 (inside P2); part 11's R1 and R2; part 12's M1 (by hand through
`reader-scale.yml`). Their outcomes are written in
their parts.

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

## 2. The sixth source: `hq-authored` (A1)

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
	/** The register ids that apply under `declaration` (section 9). Empty in the hand-written arm. */
	readonly firstPublish: readonly string[];
	/** The declaration D was read under (6.1): the base's own, or the reading's preselected one. In
	 *  the hand-written arm, which has no reading, the one the hand-written document holds:
	 *  `doc.appSettings.runsOnlyOn ?? null`, with `splitDatetime: false`. */
	readonly declaration: { readonly runsOnlyOn: "web-apps" | "android" | null;
	                        readonly splitDatetime: boolean };
	/** From B13: HQ's path for each asset D references (part 10, section 4). */
	readonly mediaPaths?: ReadonlyMap<string, string>;
}
```

From B13 a base's media are the document's own assets: `hqAuthoredDocuments()` puts each retained
file of `proof/hq-apps/<base>/media/` into the document's media manifest
(`documents.ts::uploadedMedia`) under the id `proof/reader/laneIds.ts::mintLaneMediaId(appId,
mediaType, multimediaId)` gives the file (5.2), its media type and multimedia id being the ones
`media-reads.json` records for its path, with the kind, MIME type and extension `media.json`
records, so the capture publishes D with the bytes A holds and `mediaPaths` names each asset's path
in A. One file that two paths name is one asset.

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
	/** `app-source.json`. */
	readonly source: RetainedHqAnswer;
	/** `application.json` and `current-version.json`: from B13. */
	readonly application?: RetainedHqAnswer;
	readonly currentVersion?: RetainedHqAnswer;
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
	/** From B13, where the base holds each: the lookup, location and media answers (2.2). */
	readonly lookupTables?: RetainedHqAnswer;
	readonly fixtureRows?: Readonly<Record<string, RetainedHqAnswer>>;
	readonly locationTypes?: RetainedHqAnswer;
	readonly locations?: RetainedHqAnswer;
	readonly mediaReads?: readonly {
		readonly path: string; readonly mediaType: string; readonly multimediaId: string;
		readonly status: number; readonly sha256: string; readonly length: number;
	}[];
	/** `expected.json`: from B13 (7.1). */
	readonly expected?: {
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

D comes from one of two arms, chosen by what the base's hand directory holds:

| Arm | When | D |
|---|---|---|
| hand-written | `proof/matrix/hand/<base>/document.ts` exists (A1: `hq-plain` alone) | the module's `document(): { doc: BlueprintDoc; identity: WireIdentityOverride[] }`, built with the builders targeted documents use, every entity UUID written out |
| read | otherwise (from B13: every base, `hq-plain` among them) | `proof/reader/laneReading.ts::readForLane` over the retained answers (5.2), which must answer `read` |

From B13 `hq-plain` keeps `document.ts` for another purpose: `proof/corpus/__tests__/hqAuthored.test.ts`
holds `read(A)` equal to the hand-written document after both are keyed by external identity
(`externalIdentityMap`, part 10 section 2.5, B8). It is the one base whose reading is held to a
document a person wrote from A's authored meaning, so a reader that mis-reads a shape `hq-plain` holds,
consistently, fails there.

An emission stops, naming the base, where the read arm answers `account` (Copy L1), where the
hand-written document's `identity` does not name every menu and form of A's source exactly once
(L2), and where the base states a declaration the reading does not offer (L13).

### 2.2 `proof/hq-apps/<base>/`: what is retained

Everything under `proof/hq-apps/` is written by the lane and held to it byte for byte. Nothing in it
is written by hand.

| File | What it is | Who reads it |
|---|---|---|
| `base.json` | `{ "id", "configuration": { "flags": [], "namedPrivileges": [], "commcareVersion": "2.57.0", "commtrack": bool, "syncCasesOnFormEntry": bool, "caseSearchEnabled": bool }, "declaration": "preselected" or { "runsOnlyOn", "splitDatetime" }, "exhibits": [entry ids] }`, from the registry (2.3). `configuration` is one entry of a corpus document's `configurations.json`, key for key (`proof/checks/configurations.py::read_configurations`) | emission (the document's `configurations.json`, 2.4), Vitest |
| `app.json` | the app as HQ stores it: `Application.to_json()` after one `wrap` round, with `_attachments` as `{ "<form unique id>.xml": "<source text>" }` and no blob metadata | the unit (2.4) |
| `media.json`, `media/<n>.<ext>` | an array, one row a mapped path in path order: `{ "path", "file", "mediaClass", "kind", "mimeType", "extension" }`, as in `[{ "path": "jr://file/commcare/image/module0_en.png", "file": "media/0.png", "mediaClass": "CommCareImage", "kind": "image", "mimeType": "image/png", "extension": "png" }]`. `path` is the full path the app's references hold, `file` the retained file, `mediaClass` HQ's own (`CommCareImage`, `CommCareAudio` or `CommCareVideo`); the files are the lane's stand-in bytes (6.3) | the unit, emission |
| `tables.json` (B13, where the base holds tables) | an array, one object a lookup table as HQ's models hold it, in tag order: `{ "tag", "is_global", "fields": [{ "name", "properties": [...], "is_indexed" }], "item_attributes": [...], "rows": [{ "fields": { "<name>": [{ "value", "properties": {...} }] }, "item_attributes": {...} }] }`, the rows in `sort_key` order (`corehq/apps/fixtures/models.py::LookupTable`, `TypeField`, `LookupTableRow`, `Field`) | the unit (2.4) |
| `places.json` (B13, where the base holds places) | `{ "levels": [{ "name", "code", "parent" }], "places": [{ "name", "site_code", "level", "parent", "metadata": {...}, "archived" }] }`: each level as `LocationType` holds it, `parent` its parent's code or null, and each place as `SQLLocation` holds it, `level` its level's code and `parent` its parent's site code or null; both lists parents first (`corehq/apps/locations/models.py`) | the unit (2.4) |
| `app-source.json` | HQ's answer to the source read, `operations.source_read`, as `HqAnswer.retained()` writes it | emission, Vitest |
| `application.json`, `current-version.json` (B13) | HQ's answers to the application resource read, part 05's `application_read` (B1), and to `operations.current_version_read`, which exists today | emission, Vitest |
| `media-reads.json` (B13, where the source maps media) | for each mapped path, HQ's answer to the read of its file with the seeded key (5.3): `{ "path", "mediaType", "multimediaId", "status", "sha256", "length" }`. The bytes are the file `media.json` names for the path | emission, Vitest |
| `lookup-tables.json`, `fixture-rows-<tag>.json`, `location-types.json`, `locations.json` (B13, where the base holds them) | HQ's answers to `lookup_tables_read`, `fixture_rows_read`, `locations_read` (all three exist today) and the new `location_types_read` | emission, Vitest |
| `seed.json` | the case seed made from A (2.6) | the unit, through the corpus document |
| `expected.json` (B13) | `{ "reads": true, "declaration": { "runsOnlyOn", "splitDatetime" }, "claimed": [entry ids], "firstPublish": [register ids] }`, written by the lane from the bundle's answer over these files (7.1). `declaration` is the one the base was read under (6.1) | Vitest, the coverage test |
| `variants/<variant>/` (B13) | section 7 | Vitest |

`biome.json` gains `proof/hq-apps` beside `proof/hq-reads` in its ignore list. The tree is about
7.5 MB at B13: each starter app's stored document and source answer are 0.2 to 0.6 MB apiece, an
authored base's about 0.1 MB, and the variants' patches about 0.2 MB in all (7.2).

What is written by hand lives apart, under `proof/matrix/hand/<base>/`: `expectations.json` and the
`restore.xml` its expectations run over (6.4), `edit.ts` where the base states an edit, and
`document.ts` for `hq-plain`.

### 2.3 `proof/matrix/`: authoring a base

A new lane package, in `proof/checks/sharding.py::SPLIT` as two groups,
`proof/matrix/test_retained.py` and the rest. In A1 it is an early-phase package and is not in
`proof/lane/blocks.py::CORPUS_PACKAGES`: its test modules read `proof/hq-apps/` and HQ, and
`proof/lane/test_blocks.py::test_the_packages_the_early_phase_refuses_are_those_whose_tests_read_
the_corpus` holds `CORPUS_PACKAGES` equal to the packages whose tests or conftests reach
`CORPUS_READERS` (`proof.checks.corpus`, `proof.checks.cases`, `proof.native.produce`). B13 adds it
to `CORPUS_PACKAGES` in the pull request whose matrix tests first reach one: `test_retained.py`
runs the bundle through `proof.checks.readerbundle`, which finds it through
`proof.native.produce`, and `bases/nova_then_builder.py` reads a corpus document through
`proof/matrix/conftest.py` (6.2).

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
   `matrix:<base>:reads` (7.2 gives a variant's reads the same key); and `seed.json` (2.6).

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

From B13 two more operations make the project data a base holds, each from HQ's models and each
before the app is saved, so A's build, its restore and every walk run over a project space that
holds them:

```python
def save_authored_tables(state, tables: Sequence[dict]) -> None:
    """Each lookup table of an authored base and its rows, made with HQ's own models
    (fixtures/models.py::LookupTable, LookupTableRow) from the base's tables.json."""

def save_authored_places(state, places: dict) -> None:
    """Each level and place of an authored base, parents first, made with HQ's own models
    (locations/models.py::LocationType, SQLLocation) from the base's places.json."""
```

A managed table is never pushed to the project space that manages it (part 11, 11-project-data.md,
section 8.2, B9), so no later operation of the unit uploads a workbook for such a document: the
tables B and B-edit read are the ones A was made with.

`proof/observe/publish.py` gains `create_authored(unit, document)`, which runs the two project-data
operations where the document holds their files, then `save_authored_app`, and returns
`(app id, None, None)` in `create`'s shape. `first_publish_digest` gains the arm for it: the digest
of `app.json`, `media.json`, each media file, and `tables.json` and `places.json` where they exist.

**What stands where a first publish stood.** An `hq-authored` document has no `create.json` and no
`content.json`. Each reader of one (section 1) gains an arm for the source, in A1 unless marked:

| Reader | For an `hq-authored` document |
|---|---|
| `proof/checks/corpus.py::Document.exports` | where `authored/app.json` exists, an `Export` with `create=None` and `content=None`, its `republish` and `republish_stopped` read as for any document. `Document.authored` gives what `content` gave: the app's path, `media.json` and, from B13, `tables.json` and `places.json` |
| `proof/checks/configurations.py::_content_privileges` | `required_privileges` over the apps of `authored/app.json`, the captured republish under `export/minimum` and, where the base states an edit, the captured update, with `lookup_push` true where `authored/tables.json` exists (the plan must hold what HQ's own table pages and reads ask). The republish is among the sources because B can need what A does not: a D that declares Web Apps over an A with the setting off needs `CLOUDCARE` (`_needs_cloudcare`) |
| `proof/observe/unit.py::input_files` | the `privileges.` roles are `privileges.authored.app` (`authored/app.json`), `privileges.republish.` (the republish's request files) and `privileges.update.` as today. Part `a` holds the roles `authored.app`, `authored.media` (`authored/media.json`), one role a media file, `seed` (`authored/seed.json`) and, from B13, `authored.tables` and `authored.places`, in place of the first publish's requests. `proof/corpus/inputs.ts` writes the same roles |
| `_Unit.create_a` | calls `create_authored` in the operation `create`, keyed by the digest above, and skips `upload_media`: `save_authored_app` attached the media. Its publish record is `_publish_record(None, None, None)`, which `bar.py::republish_bar` reads as a create HQ took with no upload beside it. No HQ-side save follows (an `hq-authored` document carries no `hq-side.json`, and the entry writer refuses one). The build, the saved build, the mark and the state record follow as for any A |
| `restore_for_sessions`, `b_context` (`sessions.hq_restore`) | no workbook is uploaded. `proof/observe/casedata.py::lookup_fixtures` is split: `served_fixtures(state, user_id)` is its second half (each table HQ holds, served as `ItemListsProvider` serves a global table), and `hq_restore` calls that half alone where the document is `hq-authored`, its operation keyed by the digest of `authored/tables.json` (B13; in A1 `hq-plain` holds no table and the restore serves none) |

The entry writer writes the document's `configurations.json` from `base.json`: `minimum` is the
base's `configuration`, `maximum` is the same entry, and `singleFlag` is empty, and it writes
`export/minimum/` alone. A base is authored under one configuration, and an app HQ's pages made
under one set of flags is not the app those pages would make under another, so A has no other
configuration to be made again under; sensitivity, the one check that asks what a flag changes,
does not run on the source (section 4). The entry writer copies the base's `app.json`,
`media.json`, `media/`, `seed.json` and, from B13, `tables.json` and `places.json` into the
document's `authored/` directory, so the document's key (`keys.document_key`, every file of its
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
	readonly mediaPaths?: ReadonlyMap<string, string>;
};
```

and `capturePublish` a third overload returning `RepublishCapture`. With `hqAuthoredA`:

- `targetPeer.ts::TargetPeer` gains `holdSource(source: unknown): void`, which makes the peer hold
  that source as the app's, at the placeholder id, as it holds one after `applyRetained`. Every later
  answer is the peer's existing `sourceAfterUpdate`.
- The identity every body and every local export of the document is built with is
  `targetWireIdentity(hqAuthoredA.identity)`, at the two `hqImportApplication` call sites and at
  `compileLocalArchive`. `DERIVED_WIRE_IDENTITY` stays for every other document.
- The ledger (`CaptureLedger`) is: `app.normalized` the peer's source read, normalized as a baseline
  is (`normalizedRead`); `app.ownership` the ownership `hqImportApplication` gives for D over that
  source, which is the ownership descriptor an adopted baseline holds (part 10, section 6.3);
  `app.origin`
  `"push"` (`CaptureLedger.origin` is `"create" | "push"` today); `tables` empty. Three later pull
  requests change this arm, each in the pull request that changes publish ("the capture moves with
  publish", `proof/CLAUDE.md`). B8 (part 10, 10-identity-and-the-ledger.md, section 6.3 and "Files
  by pull request"): for an `hqAuthoredA` document the ledger's origin is `"read"`, the baseline is
  part 10's `adoptedAppBaselineWrite`, the identity rows are `adoptedIdentityRows`, the held media
  paths are written, and the publish passes `languageNames: "target"` and `seeds: "target"` (part
  01, sections 7.2 and 7.3); every other document keeps `"nova"` for both. The adopted base exists
  from A1 (`hq-plain`), so `hq-plain` re-emits in B8. B9 (part 11, 11-project-data.md, "Files by
  pull request"): `publish.ts` and `targetPeer.ts`, whose peer answers the lookup table reads the
  `managed-data` preflight makes. B7 (part 09, 09-acceptance-and-the-first-publish.md, section
  12.3; B7 lands above B8 and B9): the `adoptedAppBaselineWrite` call passes `firstPublish: { ids:
  [], touchesWorkers: false }`. No lane check reads the stored list: a base's predicted ids reach
  the lane through `first-publish.json` (9.2).
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
over a peer holding `hq-plain`'s retained source and a ledger with its identity rows, sends the
bodies the capture recorded. In A1 the test inserts the `app_deployment_identities` rows with Kysely
directly, as `lib/deployment/__tests__/publishSequence.postgres.test.ts` inserts them:
`lib/deployment/store.ts` only reads that table today (`readDeploymentIdentityOverrides`). B8
switches the case to part 10's `adoptedIdentityRows` through its writer.

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
- `worker.location` (B13): the site code of the place the base's builder names as the worker's, or
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

## 3. The probe (A1)

### 3.1 The base `hq-plain`

It holds only what Nova at `15a00a97` holds, made as a person makes it. `proof/matrix/bases/
plain.py::build`:

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
   of the form is the builder's own. It holds no hint and no validation message: Nova writes a
   formatted copy of each until A8 and HQ's form builder writes none for plain text
   ("Executed during planning"), and `hq-questions` holds both from B13.
4. `views/forms.py::edit_form_actions` on the registration form: the case name from `head_name`,
   and `members`, `village` and `visit_date` saved as case properties.
5. The follow-up form: a label, an integer `members` whose default reads the case, a text `remark`
   required where `members > 5`. The default is typed in the form builder as a person types it
   (`#case/members` as the question's Default Value, through `ops.builder_save`'s steps), because
   the basic Case Management page offers no load ("Executed during planning"). `edit_form_actions`
   saves `members` and `remark`, and writes no `case_preload`.
6. `edit_module_detail_screens`: the list shows the name and `village`, sorted by `village`; the
   detail shows the name, `village`, `members` and `visit_date` as a date.
7. `views/settings.py::edit_commcare_profile`, posting the seventeen settings Nova states, each at
   the value Nova states it: the fifteen of `lib/commcare/appProfileSettings.ts::
   appProfileProperties` at Nova's seeds (which `proof/checks/intent.py::NOVA_PROFILE_CONSTANTS`
   lists) and `cc-show-saved` and `cc-show-incomplete` at what the hand-written D states. The view
   is the one the app's settings page posts a person's choices to, and it stores each property it
   is sent. With them saved, Nova's publish seeds nothing over this app and its archive states what
   HQ's build states. An app whose profile holds none is `hq-new-app` (6.2), which lands above B8.

Its configuration is the lane's minimum for the content with no flag, with `CLOUDCARE`, which the
content rule derives for an app Web Apps lists (`_needs_cloudcare`). It declares both platforms:
nothing it holds is unavailable on either.

### 3.2 The hand-written D

`proof/matrix/hand/hq-plain/document.ts` exports `document()`: a Nova document meaning what 3.1
authors, built with `lib/commcare/__tests__/` builders as targeted documents are
(`proof/targeted/build.ts::TargetedSpec`), every UUID a literal. Its `identity` names A's menu id, the
two form ids and the two `xmlns`, read from the retained `app.json` at emission and matched by
position: `{ entityKind: "module", novaEntityUuid, uniqueId: app.modules[0].unique_id, xmlns: null }`
and one `form` row a form with `uniqueId` and `xmlns`. The hand writes the Nova UUIDs; the ids of HQ's
side are read, never typed, so a pin move that re-mints them needs no hand edit.

Three things the hand-written D states because 3.1 authors them so:

- every label and every choice holds `plainLabel: true`. The form's source comes from
  `XFormBuilder`, which writes no formatted copy, and HQ's form builder writes one on a save only
  for a text it read one for or a person formatted (`javaRosa/plugin.js`, `item.hasMarkdown`), so A
  holds none; a D without the flag would publish a formatted copy of every label;
- the follow-up form's `members` holds a default value reading the case's `members`, and no load
  through a case operation;
- it declares both platforms, and its settings state what step 7 of 3.1 saved.

It is written by reading 3.1 and nothing else: no reader exists at A1, and none is consulted when one
does (2.1 holds the reader to it).

`proof/matrix/hand/hq-plain/edit.ts` exports its edit: the follow-up form gains a text question
`follow_up_note` after `remark`, and the registration form's `remark` label changes. It gives proof 5
a footprint of two forms and the `mechanics` dispatch its edited document.

`proof/matrix/hand/hq-plain/expectations.json` is 6.4's, with five expectations over its
`restore.xml`.

### 3.3 The run and where each outcome lands

P1 above. The candidates are the entries of part 09's register (its section 11.2) that apply to
`hq-plain` as 3.1 authors it, under part 09's ids, so no id is renamed later. Each is written into
`proof/first-publish-changes.json` in A1 only once the run's evidence gives it a row (9.1):

| Candidate id (`CANDIDATE_IDS`) | What changes | Source | Expected rows at A1 |
|---|---|---|---|
| `case-names-checked` | the case name is written through a generated trimmed copy of the answer, and the question a name comes from gains the trim and length check | `lib/commcare/casePlacementPlan.ts::planFormCaseWire`, `lib/domain/caseScalarTextGuard.ts`; part 09 row 4, behavior `changes` | `proof3` (a name with surrounding spaces is saved trimmed), `proof1` |
| `hidden-values-added` | the form holds each generated node, and HQ's form export gains a column for each | `lib/commcare/xform/generatedNodes.ts::GeneratedNodePurpose`; part 09 row 3, behavior `none` | `proof1` (the form's questions as HQ reports them) |
| `forms-and-settings-rewritten` | Nova's own spelling of each form and of the settings no runtime reads | part 09 row 1, behavior `none` | none expected: its rows are `source` rows, judged from B13 |
| `marked-as-updated-from-a-file` | `created_from_template` becomes `import_app_api` | `views/app_import_api.py::import_app_api`; part 09 row 2, behavior `none` | none expected: a `source` row, judged from B13 |

Three changes that look like candidates are not. A case name question required
always is exact, not declared: HQ's build stamps the same bind, and part 09 holds the pair as the
canon row `create-name-required-is-absent` (its 11.4; the row lands in B4 with part 07). A load
moved to a default is part of
`case-settings-respelled` and applies only to a `case_preload` entry, which `hq-plain` does not hold
(3.1, step 5); `hq-case-management` shows it. `location_fixture_restore` is declared only where A
holds `both_fixtures` or `only_flat_fixture` (`location-list-setting-reset`), which
`hq-kept-settings` holds and an app `default_new_app` made does not.

Where a proof does show a difference under one of the two `none` candidates at A1, it is an outcome
of P1 like any other difference: S or B, unless the evidence shows Nova means it, and then a
`proof1` or `proof2` row. No `proof3` row is ever written under a `none` entry (9.3, hold 3).

---

## 4. Which proofs run on the A to B hop

For an `hq-authored` document A is HQ's own app, B is Nova's publish of D over A, and B-edit is
Nova's publish of D′ over A. The table is the one place that says which checks run on the hop, with
what each needs.

| Check | On an `hq-authored` document | What changes, and where |
|---|---|---|
| bar | runs on A, B and B-edit. A must build: a base is an app HQ accepts | none in the judge: `observations.py::judged_states` already answers every state for a document that is no witness, `bar.py::document_bar` already reads A and B, and `create_authored`'s publish record (`_publish_record(None, None, None)`, 2.4) is a create HQ took with no upload beside it |
| intent | runs on A, B and B-edit, and on the local archives. At A it holds what HQ builds of its own app to what D states, which is a check of the reader | `proof/checks/intent.py`: for an `hq-authored` document `profile_settings` and `local_profile_settings` take A's stored profile values (`authored/app.json`, `profile.properties`) as `saved`, at A, B, B-edit and each local archive, the mechanism `hq-side.json`'s `profileProperties` already uses. Nothing is skipped: Nova's publish carries the target's own values and its archive mirrors them from A3 (`KEPT_AT_HQ`, part 01 section 5). A setting A does not hold is expected, at every state, as HQ's build writes an unstated one (`_unstated_setting`): `hq-plain` holds all seventeen (3.1), and every other base lands in B13, above B8, where a deployment Nova brought in is seeded with none (`seeds: "target"`, part 01 section 7.3) |
| value expectations | each of the base's hand-written expectations runs on A, on B and, where the base's declaration includes Android, on the local archive, and must give the one value (6.4) | the entry writer writes one `Expectation` for each state the expectation runs at (`export: "A" | "B" | "local"`, less `local` where no archive is made, and only the states its `exports` names: 6.4); `proof/observe/intent.py::_runs_at` runs expectations for a document that is `targeted` or `hq_authored` |
| manifest | runs on A, B, B-edit and the local archives. At A it is the independent check that the base holds nothing refused, undecided, unnamed or held-new | none |
| proof 1 | runs, A against B. A difference is accepted only where an entry of `proof/first-publish-changes.json` names the document (section 9); `proof/identity-moves.json` never applies | `proof/checks/proof1.py` asks `changes.declared` before it reports |
| proof 2 | runs on every build file but `modules-<m>/forms-<f>.xml`. HQ builds both suites, profiles, app strings and media suites from the two stored apps, so they compare; a form's bytes are Nova's own spelling of it, which proof 3 and intent judge | `proof/checks/proof2.py`: `eligibility.form_xml_unjudged(source)` drops the artifacts named `modules-<m>/forms-<f>.xml` for this source; `proof/checks/test_build_files.py` gains the case that every other file still has a comparator |
| proof 3 | runs always: Core's sessions and Formplayer's walks replay on B's aligned build whether or not the raw builds differ, over the database seeded from A (2.6), and the local archive is compared with A where the base declares Android | `proof/observe/unit.py::observe_b_aligned` takes "B where the raw builds differ" as always for this source (A1, observation); `proof/checks/proof3.py` asks `changes.declared` |
| proof 4 | runs over B and B-edit, as on any document | none |
| proof 5 | runs where the base states an edit (`hq-plain`, `starter-health`, `hq-case-management`) | none: a document with no `edit/` is already uncollected |
| sensitivity | does not run. Its flips rebuild A, and a gate's effects are what HQ's build changes of a Nova export; A is not one. Every flag HQ reads while it builds B is still held to a gate entry by the manifest check | `eligibility.HQ_AUTHORED_UNRUN` |
| stops | runs on A, and on proof 4's B and B-edit | none |
| proof 6 (B13) | `read(A) = D` and `read(served(D)) = D`, exactly (section 5) | new |
| parity (B13) | runs on A (section 8) | new |
| source (B13) | A's stored app against B's, as HQ's source read serves each: the comparison part 09's judge needs (9.3). It runs on this source alone | new: `proof/checks/source.py` |
| changes (B13) | part 09's four holds over the register file (section 9) | new |

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

`parity`, `source` and `changes` join in B13; A1 lands `hq_authored` and `HQ_AUTHORED_UNRUN`. The
module stays standard library only (`proof/CLAUDE.md`, "What runs with no image").
`proof/checks/test_corpus.py` gains `test_an_hq_authored_document_runs_every_check_but_sensitivity`,
which reads `eligible` over every name of `differences.CHECKS`.

**Two spelling rules the hop needs.** A form HQ's form builder wrote and Nova's form of the same
document differ in spellings no reader reads apart, and each is a rule with its proof on every reader,
never a register entry: `hint-validation-markdown-form` (part 03 section 8.2, lands in A8, which is
why no base below A8 holds a hint or a validation message: 3.1), and, in
B13, `field-list-appearance-case` (`proof/rules/field_list_appearance_case.py` with
`test_field_list_appearance_case.py`): a group's `appearance` token that is `field-list` in another
case reads as `field-list`, which part 06 section 10.2 reads so and Nova writes in lower case. Its
readers are HQ's build and Core in its own test, and `formplayer`, `webapps` and `android`, each run
on both spellings of one form of `hq-questions`, which holds a group spelled `Field-List`. P1 and P2
add any other the runs find (outcome S).

**App strings.** Part 01 section 7.1's classifier rests on HQ's build and Nova's archive writing the
same generated app-string ids for one document. Proof 3 already compares each language's app strings
as Core reads them between A's build and the local archive, for a document whose declaration
includes Android. Every base that holds more than a default language (`hq-languages`,
`hq-kept-settings`, `starter-agriculture`) is read under its preselected declaration, and by part
06's rule that one includes Android for each of them (6.1), so each has that comparison;
`proof/matrix/test_expectations.py` refuses a base holding a second language whose `expected.json`
records `runsOnlyOn: "web-apps"`.

`proof/checks/differences.py::CHECKS` and `registers.py::HELD_CHECKS` gain `proof6`, `parity`,
`source` and `changes` in B13. `controls.py::EDIT_READERS` gains none: no control is retained for
them, because `proof/known-defects.json` takes no entry of theirs (11.3) and a control holds no
document.

---

## 5. Proof 6: the fixed point (B13)

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

**The declaration is compared beside the document.** The reader never writes
`appSettings.runsOnlyOn`: it returns the declaration choices beside the document (part 09, section
5.4). So every read back compares the documents with `appSettings.runsOnlyOn` taken out of the
expected one, and separately requires the declaration the document holds to be among the reading's
choices, reported at `/appSettings/runsOnlyOn` where it is not. `read(A) = D` is the one comparison
made whole: the bundle reads A under the base's declaration, as the emission did (5.2), and D holds
what that declaration's mutations wrote. Both forms are part 09's one comparison,
`readBackDifferences(expected, read)` (09-acceptance-and-the-first-publish.md, section 9.1, B7): a
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
| `proof/reader/retainedPeer.ts` | `withRetainedHq`, `RetainedHqPeer`, `LANE_TARGET` |
| `proof/reader/laneIds.ts` | `mintLaneLookupIds`, `mintLaneMediaId` |
| `proof/reader/cli.ts` | the bundle's entry: reads requests, writes answers |
| `proof/reader/build.mjs` | `node proof/reader/build.mjs --out <dir>`: the esbuild call |

The directory holds no comparison of its own: `readBackDifferences` and `ReadBackDifference` are
part 09's `lib/deployment/reading/readBack.ts` (its section 9.1, B7), which `cli.ts` imports.
`RetainedHqAnswer` is `proof/corpus/hqAuthored.ts`'s (2.1).

```ts
// proof/reader/retainedPeer.ts
/** The one target every request of a lane reading is built with: `proof/corpus/publish.ts`'s
 *  `PROOF_SERVER` and `PROOF_DOMAIN`, written out here so the bundle carries no capture code.
 *  `retainedPeer.test.ts` holds the two equal to those constants. */
export const LANE_TARGET = { server: "production", domain: "nova-proof" } as const;

export interface RetainedHqPeer {
	/** A fixed credential. The agent checks no key: HQ checked it when the answer was made. */
	readonly creds: CommCareCredentials;
	/** The names of the retained answers consumed so far, in the order they were asked for. */
	asked(): readonly string[];
}

/** Answers native `fetch` from `answers` for the length of `run`, and nothing else (step 1). */
export function withRetainedHq<T>(
	answers: Pick<LaneReadInput, "source" | "application" | "currentVersion" | "projectData">,
	run: (peer: RetainedHqPeer) => Promise<T>,
): Promise<T>;

// proof/reader/laneIds.ts
/** A lookup table's id where `field` is absent, and that field's column id otherwise. */
export function mintLaneLookupIds(appId: string, tag: string, field?: string): string;
/** One id a file CommCare HQ holds, whatever paths name it: part 11's `ReserveMediaId`, bound. */
export function mintLaneMediaId(
	appId: string, mediaType: HqMediaType, multimediaId: string,
): MediaAssetId;
```

A retained answer's name, in `asked`, is its member of the input: `application`, `source`,
`currentVersion`, `lookupTables`, `fixtureRows:<tag>`, `locationTypes`, `locations` and
`media:<path>`.

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
	/** Part 12's `ReadingCheckInput.claims`, and the `claims` option of part 06's `readHqApp`. */
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
   05 section 8.2 closes on HQ's own body), and, with `projectData`, the lookup table list, each
   table's rows, the location types, the locations, and each mapped file at the address HQ gives
   its map item, answered with the status the lane recorded and the file's bytes. A request with
   no retained answer is refused by the agent and ends the reading, naming its path; `asked` lists
   what was consumed. Inside it the entry calls part 05's `readHqAppForReading` (B1) with the
   peer's `creds` at `LANE_TARGET`, so the decoding, the alignment and the failure classification
   are production's. An answer other than `read` is an `account` holding
   the circumstance part 05 gives it. No socket is opened.
2. **A first reading** (`identity: "mint"`: a base at emission, in Vitest, and at state A in the
   judge). Still inside the peer, the entry gathers what part 11's `readReadingProjectData`
   gathers (11-project-data.md, section 14.1, B9), by that function's own steps, with its step 3
   (the Project's side, which reads Postgres) answered as an empty Project, since the bundle opens
   no socket: `readHqLookupTablesForReading`; ids from `proof/reader/laneIds.ts` in place of
   `mintIds`; `lookupTableFindings` with `measured` null (the two byte caps are
   `measureLookupRows`'s to count in Postgres, and part 11's own tests hold them);
   `lookupTableStanding` with `existing: null` and `apps: []`, so every table stands as new;
   `resolveLookupBindings` with `choices: null`; and, where the source may read places, part 05's
   `listHqLocationTypes` and `listHqLocations`. Its media step runs over each file the app
   references (`readHqMediaFile`, part 05, then `validateSniffedMediaBytes`) and stages no object.
   Every id the production path would mint or reserve is given by `proof/reader/laneIds.ts`.
   `mintLaneLookupIds(appId, tag, field?)` fills part 11's `PredeclaredLookupIds`: the first
   sixteen bytes of the SHA-256 of `JSON.stringify([appId, tag, field ?? null])`, with the version
   nibble set to 7 and the variant bits to `10`. `mintLaneMediaId(appId, mediaType, multimediaId)`
   is part 11's `ReserveMediaId` bound to the app (`(mediaType, multimediaId) => MediaAssetId`: one
   file one id, however many paths name it): the first sixteen bytes of the SHA-256 of
   `JSON.stringify([appId, mediaType, multimediaId])`, with the version nibble set to 8 and the
   variant bits to `10`, so it passes `lib/domain/multimedia.ts::mediaAssetIdSchema`
   (`CANONICAL_UUID_PATTERN`), which sixty-four hex characters do not. Both are functions of their
   arguments, so an emission is byte-stable. Then the entry builds part 12's `ReadingCheckInput`
   from that plain data (`ReadingProjectData.gathered`, `minted`, the media plan with its
   verdicts, and `claims`: `LaneReadInput.claims` is `ReadingCheckInput.claims`) and calls
   `lib/deployment/reading/check.ts::runReadingCheck` (part 12, 12-the-reading-and-the-birth.md,
   section 3.6, B10): the reader, part 11's verdicts and part 09's `acceptReading` as production's
   one pure function, which builds `mintingResolver(appId)`, the lookup catalog
   (`readerLookupCatalog`), `ReaderOrganization` as `{ levelCodes, levels }` from
   `gathered.hqLevels` (part 06, section 2.2), the media index and `appStrings` on its own side,
   and passes `recordDialect: recordDialectRoundTrip` to the reader. The lane calls no
   `levelsFromHq`: the reader's structure stage does (`lib/commcare/reader/worldEntities.ts`). No
   second assembly of `AcceptReadingInput` exists in the lane. `LaneReading.claims` is
   `ReadingCheck.claims.log` under `full`, or the JSON of its `counts`. A `ReadingCheck` with
   findings is an `account`; one acceptance refuses is an `account` holding its
   `read-back-differs` finding. A clean one gives the draft and `accepted.declarations`.
3. **The declaration.** The entry takes the `AcceptedDeclaration` `input.declaration` names, or
   the one with `preselected: true` where it names none, and applies its `mutations` to the
   draft's document: that is D. `firstPublish` is that declaration's `firstPublish.ids`, and
   `offered` is every declaration's choice. A base that names a declaration the reading does not
   offer stops its emission (Copy L13).
4. **A read back** (`identity: "match"`). `readHqAppForReading`, then `readHqApp(input, { claims })`
   (part 06, 06-the-reader-forms.md, section 2.2) with the resolver `matchingResolver(appId,
   externalIdentityMap(doc, targetWireIdentity(identity)))` (part 10 sections 2.3 and 2.5),
   `appId` the corpus document's app id, and `recordDialect: recordDialectRoundTrip`
   (`lib/agent/authoring/recordRoundTrip.ts`, B6), as production's worker passes it. The rest of
   the reader's input is the document's own: the lookup catalog from its lookup snapshot with its
   table and column ids; the organization as part 06's `ReaderOrganization`, `{ levelCodes,
   levels }`, each level of the document written as the `HqLocationType` part 11's `levelsFromHq`
   reads it back from (its section 11.2): `name`, `code` and `parentCode` the level's own,
   `sharesCases` its `caseFlow.ownsCases`, `viewDescendants` true where its
   `caseFlow.descendantCases` is `all`, and `administrative` false and `id` the code, neither of
   which that function reads; the media index from its
   media by the path each asset was published at (`assetWirePath.ts::wirePathFor`, or
   `HqAuthoredFacts.mediaPaths` where the document holds one); and `appStrings` from part 09's
   `localAppStringTable`. Nova's publish of the document
   created those in HQ from the same data, or, for a base, left HQ's as they were. No acceptance
   runs: the read back is itself the fixed point, and `offered` comes from the draft's
   `declaration.choices`.
5. `identity` is part 10's `adoptedIdentityRows` over the draft's identities, projected to
   `WireIdentityOverride`.

`proof/reader/cli.ts <requests> <answers>` reads one JSON document from the first path:
`{ "requests": [{ "id", "mode": "read-back" | "first-read" | "claims", "input": LaneReadInput,
"expected"?: unknown, "canon"?: boolean }] }`, and writes `{ "answers": [{ "id", "kind",
"differences"?, "findings"?, "claims"?, "declaration"?, "firstPublish"?, "asked" }] }` to the
second (`declaration` and `firstPublish` on a `first-read` that answers `read`: the declaration
the reading was taken under and its list, which `test_retained.py` writes into the base's
`expected.json`). Standard
output is not the answer channel: `lib/logger.ts` and the readers under it write there, so it is the
bundle's log, which `readerbundle.py` keeps beside the evidence. For `read-back` and `first-read`
with an `expected` document, the entry applies `canonDocument` (`@/lib/commcare/reader/canon`, part
09) to `expected` where the request says `"canon": true`, and answers part 09's
`lib/deployment/reading/readBack.ts::readBackDifferences(expected, read)` (its section 9.1, B7),
which this entry imports and does not restate: both documents less the entity kinds
`KINDS_WITH_NO_EXTERNAL_KEY` names (part 10, section 2.2), then part 09's
`signature.ts::documentDifferences` over the two. `read` is part 09's `ReadBack`, `{ doc; choices }`,
in exactly these two shapes. In mode `read-back` it is `{ doc: draft.doc, choices:
draft.declaration.choices }`, the reading's offered declarations (the empty list where the
declaration's kind is `none`), so `expected` loses `appSettings.runsOnlyOn` and the declaration
difference of 5.1 is added. In mode `first-read` with an `expected` document it is `{ doc:
draft.doc, choices: null }`, and the two are compared whole. A read
back under `matchingResolver` gives D's own UUIDs, so the two documents are compared as they stand.
The entry reads no clock, draws nothing, opens no socket and reads no file but its first argument.

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
"projectData"?: {...}, "media"?: [...] }`, each answer as `HqAnswer.retained()` writes it.
`application_read` and part 05's other reads move into `proof/hq/operations.py` in B13, when this
observation first calls them (12.1 says where B1 keeps them until then). The fork keeps the API user,
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
| `b` | `published` | after the republish and its media | `hq-authored` documents and witnesses |
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
recorded read (5.3) and reports, as `Difference(check="proof6", artifact, path, kind)`:

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
directory; every other request is a `read-back`. All of a document's requests go in one Node process
(P4).

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

Part 09 (09-acceptance-and-the-first-publish.md, section 9, B7) owns the list, because its acceptance
tests and its run K1 need it beneath B13: `lib/commcare/reader/canon.ts` exports `CANONICALIZATIONS`,
each row `{ id, kind: "one-wire" | "not-carried", apply }`, and `canonDocument(doc)`, every row applied
in list order until none changes the document. The file wraps part 06's `READER_CANONICAL_CHOICES` (B2,
each row `{ id, kind, apply }`; part 07 adds three rows in B4 and two in B5) and part 08's
`canonicalExpression` (B6), so one id has one definition. Proof 6 calls `canonDocument` and nothing
else: this part keeps no list of ids, no `canon` of its own and no second equal-bytes test, and the
lane-side list of canonicalization ids is `CANONICALIZATIONS`' own.

The rows, as part 09's table writes them (sixteen): `root-question-lists-are-sections`,
`translation-equal-to-source-is-absent`, `blank-translation-is-absent`,
`out-of-date-translation-is-absent`, `translation-provenance-is-read-as-reviewed`,
`plain-flag-on-blank-text-is-absent`, `plain-flag-under-plain-text-is-absent`,
`blank-container-label-is-absent`, `blank-optional-text-is-absent`,
`create-name-required-is-absent`, `default-post-submit-is-absent`, `dormant-tile-cells`,
`registration-form-last`, `expression-print-collisions`, `case-catalog-is-as-read` and
`purpose-notes-are-absent`. Part 07's run G1 adds none: under its outcome C the builder's shape of
a Save to Case block is refused, and a refused block is no member a reader returns. Part 09's table
is the definition; this sentence is a reader's index of it and binds nothing.

**Each row is proven there to print equal bytes.** `lib/commcare/reader/__tests__/canon.test.ts`
(part 09, B7) builds the two documents of each pair from production builders, runs `expandDoc` and,
for an app that declares Android, `compileLocalArchive` over each, and requires every emitted file
byte for byte equal; it holds `canonDocument` idempotent and `canonDocument(read(A)) = read(A)`
over every retained read. Part 09's K1 (`canonReadBack.fuzz.test.ts`) holds the list complete over
the fuzz corpora with no HQ. Proof 6 is the third hold, and the only one on a source HQ normalized
and served: its P5 adds what its run finds to `CANONICALIZATIONS`, never to a list here.

**Where `canon` ends and the comparison begins.** Content no export holds is in one of two places
and never both. A `not-carried` row of `CANONICALIZATIONS` removes content inside an entity the
comparison does compare (a translation's provenance, a menu's or a form's purpose note).
`KINDS_WITH_NO_EXTERNAL_KEY` (part 10, 10-identity-and-the-ledger.md, section 2.2, B8) names whole
entity kinds no wire carries and so no reading returns (user types, personas, and automations with
their criteria, setup-only criteria, updates, recipients, events and user-data filters: the nine
kinds part 10 lists), which part 09's `readBackDifferences` leaves out of both documents. The case
catalog is no such kind: what a Nova-born document's catalog holds beyond what the reader derives
is the canon row `case-catalog-is-as-read` (part 07, B5).
`proof/reader/__tests__/notCarried.test.ts` holds three things: no `not-carried` row's `apply`
changes anything inside a kind `KINDS_WITH_NO_EXTERNAL_KEY` names; every entity map the document
schema declares (read from the keys of `lib/domain/blueprint.ts`'s document object schema) is
either a kind that list names or one in which a planted change shows as a difference of
`readBackDifferences`; and the content each `not-carried` row removes shows as a difference when
the row is left out. So the two are disjoint, and nothing leaves the comparison unnamed.

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
  writes each `expected.json` from it) and `proof/checks` (`{"documents": EVERY, "reader": EVERY}`:
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
One thing is observed, and only when a reading itself changes: from B13 a base's `document.json`,
its `expected.json` and its `first-publish.json` are what the bundle read of the retained answers
(2.1, 9.2), so a reader change that changes a base's reading changes those files, the base's
document key with them, and the base is observed again, exactly as an emission change to a
Nova-born document would be. The same pull request adopts the changed `expected.json` files into
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

Section 10 names the suites. The fixed point is held three ways outside the lane, each cheaper and
narrower than proof 6: over the retained HQ answers of Nova-published documents
(`fixedPoint.retained.test.ts`), over every retained base (`hqApps.test.ts`), and over the fuzz
families with no HQ, reading Nova's own `expandDoc` output as production's acceptance check 3 does,
which is part 09's `canonReadBack.fuzz.test.ts` (its run K1, B7) and is not written twice. Only
proof 6 reads HQ's normalized answer for every corpus document.

---

## 6. The bases (A1: `hq-plain`; B13: the rest)

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
  change that depends on the choice (part 09's rows 25 to 27: two of scope `declaration`, one of
  scope `birth`): `hq-new-app` (both platforms over an app whose Web Apps setting is off),
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
  declaration it was read under (7.1), `hqApps.test.ts` holds every reading to it, and 7.5's rule
  2 and 6.4's rules read it there. A reading that proposes another is a reader defect (P2, outcome
  R), never a reason to state a declaration.
- Every string, name and value in it is invented for the lane. No base holds a client's content.
- Its registry row's `exhibits` names each entry it is built to exhibit: every kept entry
  (`KEPT_AT_HQ[...].base`), every entry a first-publish change reads, and every hand-off item
  below. `proof/matrix/test_classified.py::test_a_base_exhibits_what_it_names` requires each named
  entry among the entries the bundle's claim log counts for the base.

### 6.2 The twenty-two

How each is authored: "pages" is HQ's views through `operations.session_post`, "builder" a save in
HQ's vendored form builder, "models" HQ's own models with `app.save()`, "template" HQ's own
`import_app_from_doc(_load_app_template(slug), domain, {"created_from_template": slug})`, the first
call of `views/apps.py::load_app_from_slug`, followed by that loader's media calls over the lane's
stand-in files (6.3), each mapped at `MULTIMEDIA_PREFIX + path` as the loader maps it. The loader's
last call, `_build_sample_app` (a build of the new app, released), is left out on purpose: nothing
Nova reads of an app is a released copy of it, and the unit builds A itself. `template_apps/` holds
a fourth directory, `wash_before_cond_case_update`, which is no base: by its counts it is `wash`
again (the same menus, forms, display-only menus and `case_list_form` blocks), HQ's own test of the
templates loads the other three, and a base is added for what it exhibits.

| Id | Authored by | What it holds, and for whom | Edit |
|---|---|---|---|
| `hq-plain` | pages, builder | section 3 | yes |
| `hq-new-app` | pages, builder | `default_new_app` then `new_module` with no case type posted, so the type is `case` (`_init_module_case_type`), the registration form given one text question in the form builder and its case name set. None of the fifteen settings is saved (part 01, 01-the-bar-and-the-manifest.md, section 7.3), and Web Apps is off, as `Application.cloudcare_enabled` defaults. Declaration: both platforms, so the first publish turns Web Apps on (part 09's `web-apps-turned-on`). Run 3 of part 01 (run in P2, judging B8) | no |
| `hq-saved-pages` | pages, builder | `hq-new-app`, then every app-manager section saved once with nothing changed, as proof 4 saves them: app settings, add-ons, UI translations, the menu's settings, its case list with its search, its case detail, each form's settings and case management, and each form in the form builder. It exhibits what each page writes on a save: the nine tile cell keys off a tile (the INERT entry part 01 section 3.2 cuts for them), `case_tile_field: ""`, and the profile settings a save of the settings page writes that no runtime reads, each an INERT entry at `15a00a97` (`application-and-settings/3-properties-purge-freq`, `6-properties-log-prop-weekly-within-its-choices`, `7-properties-log-prop-daily-within-its-choices`, `12-properties-user-reg-server`, `14-properties-restore-tolerance`, `16-properties-loose-media`). A stored-source difference at any of them is under part 09's `forms-and-settings-rewritten`, whose lane allowance is every pointer the claim log holds as `inert` (9.3) | no |
| `starter-health` | template, stand-in media | HQ's health starter: two display-only menus, a Register action that returns to the list with an icon, a case list filter, an ascending sort with blanks last (part 03), three case forms whose logic reads the case (none through a `case_preload` entry and none through a default), one `case_list_form` block with a blank form id (menu 2), ten media paths at HQ's own paths, profile values Nova does not seed (`cc-fuzzy-search-enabled: yes` among them), `secure_submissions: true`, `mobile_ucr_restore_version` 1.0, `created_from_template`. Its preselected declaration is both platforms: the template holds `cloudcare_enabled: true`, so its configuration holds `CLOUDCARE` and HQ's import sets the setting on from the plan (`models/applications.py::_create_app_from_doc`), and nothing it holds is unavailable on either platform (6.1). Part 01's two `mirrors` rows on this base (`23-properties-cc-fuzzy-search-enabled`, `43-hq-secure-submissions`) need a declaration that includes Android (7.5, rule 2), which that rule gives whatever the setting. Parts 01, 02, 03; part 08's E6 | yes |
| `starter-agriculture` | template, stand-in media | four menus and nine forms, five Phone Number questions (part 03), a child case, six forms whose questions default to a case's value (form builder defaults reading `#case/`; no `case_preload` entry), a date-descending sort, `translations.fra` for a language outside `langs` (kept runtime UI keys, part 01), a Register action that goes on with the new case, three `case_list_form` blocks with a blank form id (menus 0, 2 and 3). E6 | no |
| `starter-wash` | template, stand-in media | four display-only menus beside one with a case list, three forms that open a child case, three `case_list_form` blocks with a blank form id (menus 2, 3 and 4; menu 0 holds none) (part 02's INERT row). E6 | no |
| `hq-kept-settings` | pages, models | Web Apps turned on through `edit_app_attr`, so its preselected declaration is both platforms (6.1); holds each of the fifteen settings at a choice other than Nova's seed, `cc-log-entity-detail-enabled`, the credential level, a runtime UI text key in each of two languages, `secure_submissions: true`, `practice_mobile_worker_id`, `logo_refs` on both Android slots and one `logo_refs` entry holding only `path` (`logo-path-only-entry-removed`), `mobile_ucr_restore_version` 1.5, `persistent_menu` and `show_breadcrumbs` on, `location_fixture_restore: both_fixtures` written through the model, since HQ's settings page does not offer it (`location-list-setting-reset`), one language with a display name and one without. It does not hold `custom_base_url`, which no lane configuration can author (7.5). Every other labelled row of `KEPT_AT_HQ` (part 01 section 5) | no |
| `hq-languages` | pages, builder | three languages; a label blank in one whose first-language text is not (`blank-translations-filled`, part 09); a text whose languages share one itext id and one renamed id (part 06); a generated translation key equal to HQ's own text and one that overrides a menu name (`translation-overrides-folded`, part 01 section 7.1) | no |
| `hq-menus` | pages, models | a display-only menu under a parent that is one, a display-only menu at the top level beside a case-first menu, Register offered always with each return and with media, the case list menu item with a label, a menu and a form display condition, a child menu, an after-submit link with an otherwise, an after-submit link that carries a case by hand onto a form of a single-case menu, with no held-case guard in its condition (`link-held-case-guards-added`), a deep link id on a form and on a case list (part 02 sections 4 to 11; part 07's menu readings) | no |
| `hq-questions` | builder | every question kind of part 06 section 9.1's held rows; a Phone Number question; a Question List at the root; a count repeat over a question and one over a Hidden Value; a model-iteration repeat inside Nova's rule; a label holding a date chip; a help text typed plainly and one typed with formatting; a hint typed plainly and one typed with formatting; a validation message; a validation holding an inline count (`validation-counts-moved`) and a validation message that shows an answer (`validation-messages-composed`); a date-and-time question, with the declaration `splitDatetime: true` on both platforms (`date-and-time-questions-split`); a second form with Disable Text Formatting on (parts 03, 06 and 09) | no |
| `hq-names` | pages, builder | a hyphenated question id, a one-choice select, a choice value holding an apostrophe, a case property and a search field name holding a hyphen, the update keys `category` and `state` (part 04, rows built in A9) | no |
| `hq-case-management` | pages, models | part 07's G3 table, one form a reading: an external id on `open_case`; `update_case` under an `if` condition; a parent index with `reference_id: "parent"`; a preload no later default reads; a child case with a close condition; a usercase update and preload; a form that opens one child case outside a repeat (`registration_alert_child_case`). The external id, the index and the preload are what `case-settings-respelled` rewrites (part 09, section 11.2, row 13: `external-id-in-update`, `subcase-index-unnamed`, `preload-as-default`) | yes |
| `hq-advanced` | models | an advanced menu whose forms load a two-menu chain and write to the parent load, and one whose parent load is read only; an advanced preload no later default reads (part 07) | no |
| `hq-nova-then-builder` | Nova's publish, builder | `targeted-save-to-case-shapes`'s first publish as the corpus captured it, then every form saved in the form builder: Save to Case blocks and generated nodes as the builder writes them back (part 06's R1 shape, part 07's G1). The document (new in B13, `proof/targeted/documents/saveToCaseShapes.ts`) holds the eight Save to Case arms part 07's G1 lists (a root create, a keyed create, a create in a repeat, a conditional update, a close, a several-case form, the own arm in a block, the own close's block) and one form with no Save to Case operation holding a validation with a lifted count (part 06's R1 shape). Its `app.json` is HQ's stored app after those saves. The builder applies the corpus document's captured first publish with `proof.observe.publish.create`, as `proof/hq/test_retained_reads.py` publishes `navigation-base`, reading the document through `proof/matrix/conftest.py`'s `documents` fixture, whose `DOCUMENTS` names it so the package's key moves with it (`queue.py::PACKAGE_DATA`). It is the one base Nova's emitter can stale: a pull request that changes that document's capture fails `test_retained.py` on this base and adopts it again (`python3 -m proof.matrix.adopt`), which L3 says | no |
| `hq-case-lists` | pages | a detail column its list lacks (`detail-only-columns-searched`), a sort rule on a property no column shows (`sort-rule-kept-as-hidden-column`), sort rules with each type word and with blanks first and last, a plain, a date, a phone and an ID-mapping column, a calculated column, a multi-select list whose `max_select_value` is `-1` and a list with no sort elements under an invisible first column (`list-settings-respelled`; part 07 G3's `detail-max-select-value-on-a-multi-select-basic-list` and `no-sort-elements`); its case list filter compares a date property with a quoted date (`dob > '2000-01-01'`), part 08's positive control of the typed-literal fold, with a value expectation in 6.4's file (parts 03, 07 and 08) | no |
| `hq-search` | pages | `SYNC_SEARCH_CASE_CLAIM` and case search on; a search with no title; search fields of each held kind; a list filter the search restates (`search-restates-list-filter`); a search-only filter row order HQ ANDs (`search-filter-rows-recut`); a filter row that compares a property with a search field's answer (`search-value-guards`); on the `inline_search` menu, whose forms read the search, a filter row that reads no search field and restates no clause of that menu's list filter (`search-filter-joined-to-list`, part 07 section 12.3, kind F); a bare date-and-time comparison, an absolute read in a default and a search row calling `today()` (part 08; the last is `search-today-device-day`); each of `auto_launch`, `default_search` and `inline_search` on a menu of its own (parts 03, 07 and 08) | no |
| `hq-expressions` | builder | a form holding one expression for each expression rewrite of part 08's section 2.3 whose behavior changes: a bare comparison of two dates and times, an unguarded table read (part 08), a row predicate without `current()`, a default that reads another question, a session value read with no guard (part 08, 08-the-reader-expressions.md, C1 to C6b) | no |
| `hq-media` | models, stand-in media | image, audio and video on a label, a choice, a menu and a form at HQ's own paths; one file two paths name (`media-paths-joined`); a path differing from another only by case (`media-path-differs-only-by-case`); a path HQ's upload cannot match (`media-path-not-holdable`); a path in Nova's derived shape that names other bytes (`media-path-names-another-file`); a `multimedia_map` entry nothing references (`unused-media-entries-removed`); a menu icon whose path has no map entry (`media-references-with-no-file-removed`) (part 09's rows 29 to 34; part 10's G2 and section 4.2; part 11 section 3) | no |
| `hq-lookups` | pages, builder | a global table a select reads through an itemset, a second table the form declares and nothing reads, a table whose tag holds a hyphen, an itemset filter comparing a column with an answer (parts 04 and 11) | no |
| `hq-places` | pages, builder | two levels with a location property, six active places and one archived, a form whose logic reads the worker's place and its parent (part 11 section 11) | no |
| `hq-connect-deliver` | pages, builder | a Connect Deliver app: one deliver unit and one task, `auto_gps_capture` off, so Nova's publish turns it on (`connect-app-captures-location`: part 09's row 21 applies where the source does not hold it true), and Web Apps turned on through `edit_app_attr`. Declaration: Android only, which a Connect app is, so the first publish turns Web Apps off (`web-apps-turned-off`) (parts 01, 07 and 09) | no |
| `hq-connect-learn` | builder | a Connect Learn app: a learn module and an assessment | no |

Sixteen authored bases (`hq-kept-settings` to `hq-connect-learn`), three starters, and `hq-plain`,
`hq-new-app` and `hq-saved-pages`.

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
  three, which is every expectation but the before and after pairs of a declared change (below).

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
- Every entry a base's `exhibits` names that is HELD has an expectation naming it in `entry`, and
  the expectation's request reaches the place the entry was claimed (the claim log's `where` lies
  under the form the expectation names).
- Every register id a base's `expected.json` lists in `firstPublish` whose entry holds a `proof3`
  row in `proof/first-publish-changes.json` (which only an entry whose `behavior` is `changes` may:
  part 09's Vitest holds that) has a pair of expectations named `<id>:before` (run on A alone) and
  `<id>:after` (run on B and the archive), whose values differ: the declared change, shown. This is
  the second half of part 09's hold 3.
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

---

## 7. Variants, the synthetic layer, coverage (B13)

### 7.1 `expected.json`

For a base: `{ "reads": true, "declaration": { "runsOnlyOn": null, "splitDatetime": false },
"claimed": [...], "firstPublish": [...] }`, written by the lane: the declaration the base was read
under (6.1), the entry ids its claim log counts, sorted, and that declaration's first-publish ids
in register order.

For a variant, written by the lane from its registry row:

```json
{ "reads": false,
  "findings": [{ "code": "questions/choice-value-holding-both-an-apostrophe-and-a-double-quote",
                 "standing": "not-yet",
                 "place": { "kind": "question", "menu": 0, "form": 0, "menuName": "Households",
                            "formName": "Registration Form", "name": "village" } }] }
```

or, for a held variant, `{ "reads": true, "claimed": ["<entry id>"], "holds": [{ "key": "<external
key text>", "pointer": "/keypad", "value": "numbers" }] }`. `code`, `standing` and `place` are part
01's `Finding` members (`lib/publish/hqFindings.ts`), `place` an `HqPlace`. A variant names exactly
one finding unless its registry row says it composes two (`two-refusals-one-pass`, which holds that
a reading reports every finding in one pass: part 06, 06-the-reader-forms.md, Decision 1).

### 7.2 Authored variants

```python
# proof/matrix/registry.py
@dataclass(frozen=True)
class Variant:
    id: str                 # "<base>/<slug>"
    base: str
    entry: str              # the manifest entry id it exhibits
    standing: str           # the standing the reader must give it
    change: Callable[[Authoring, str], None]   # one HQ model operation over the base's app
    place: dict             # the HqPlace the finding must name
    holds: tuple = ()       # for an allowing entry: the document fragment the reading must hold

VARIANTS: tuple[Variant, ...]
```

`proof/matrix/author.py::authored` makes each variant in a fork of its base's state (`state.mark`,
the change, the source and application reads, `state.restore`), so no variant sees another's
change. The change runs in an operation labelled for the variant; the two reads run in operations
with the key and depth of the base's own reads (`matrix:<base>:reads`, 2.3), not the variant's.
`proof/hq/determinism.py::operation` makes every draw a function of its key and depth, and the
source read draws one `uuid4` a form in menu and form order (`update_form_unique_ids`), so a
variant's source answer holds the base's form ids at every position the two share.
`proof/matrix/ops.py` holds the changes builders share, each HQ's own code: `set_json(pointer,
value)` (the app wrapped, the value set through its model property, `app.save()`),
`set_form_source(m, f, edit)` (the form's source parsed with lxml, edited, and stored through
`Form.source`'s setter), `builder_save(m, f, steps)` (a save in the form builder after the driver's
steps, for a class only the builder's own writer makes), `post(view, ...)`.

`retain` writes, under `proof/hq-apps/<base>/variants/<slug>/`: `source.patch.json` and
`application.patch.json`, each the operations that turn the base's retained answer into the
variant's, and `expected.json`. A retained answer's `body` is text (`operations.HqAnswer.retained`),
which a JSON Pointer cannot address, so a patch addresses the parsed body: its paths are pointers
into `JSON.parse(body)`, with no `/body` before them, and `apply(base answer, patch)` returns the
variant's answer as `{ status, headers, body }` with `body` the patched value serialized again.
Nova's client parses a body and reads no byte of its spelling, so the two patch readers are held
equal on parsed values, and `test_patch.py` requires `apply` over the base to give HQ's own answer
for the variant as a parsed value. A patch is RFC 6902 `add`, `remove`, `replace` and `move`, plus
one operation of this lane's for a string value:

```json
{ "op": "lines", "path": "/_attachments/3f2a.xml", "from": 41, "drop": 1,
  "add": ["      <input ref=\"/data/phone\" appearance=\"numeric  short\">"] }
```

which replaces `drop` lines starting at line `from` (1-based) with `add`. A form's source is one
string of a few hundred lines, and without it a one-attribute variant would retain the whole form.
`move` is there for the one case the shared ids do not cover: a variant that adds or removes a form
shifts the draw of every form after it, each of those forms' `unique_id` is a `replace` and its
attachment's new key a `move` from the old, and neither carries the form's text.
`proof/matrix/patch.py::diff` writes patches and `apply` applies them;
`__tests__/helpers/retainedHqApps.ts::applyVariantPatch` is the TypeScript reading, and
`proof/matrix/test_patch.py` with `retainedHqApps.test.ts` hold the two to one set of vectors
(`proof/matrix/fixtures/patch-vectors.json`), a `move` and a `lines` vector among them.
`test_patch.py` also holds every committed patch small: no `add` or `replace` of a whole
`_attachments` value in a variant that changes no form's source.

**Which entries get an authored variant.** Every REFUSED or HELD-NEW entry with a surface key and at
least one key outside `schema:`, other than those 7.5 exempts: 361 at `15a00a97` (288 with a key
outside `schema:` and `parser:`, and 73 whose keys are `schema:` and `parser:` together), plus each
such entry stack A and stack B add (parts 02, 04, 06, 07, 08 and 11 name theirs: part 04's N1 to N24,
part 06's eleven, part 07's twenty-four, part 08's M1 to M7, part 11's one). And every allowing entry
no base's claim log counts, as a held variant. Their rows are `proof/matrix/variants/<area>.py`, one
module a manifest area. A class HQ's form builder cannot write (every `not-hq-editable` class is
one) is made with `set_form_source`, which is how such a form exists in HQ at all.

The variants the other parts ask for by name, each a row of that registry:

| Asked by | Variants |
|---|---|
| part 04 | one an entry N1 to N24, on `hq-names`, `hq-lookups`, `hq-search`, `hq-case-lists`, `hq-menus`, `hq-connect-deliver` and `hq-questions` by the entry's area |
| part 06 | each refusal of its sections 8 to 13: a menu with no `unique_id`, a form with no `xmlns`, two forms of one `xmlns`, an empty `langs`, a real attribute that disagrees with its `vellum:` shadow (`shadow-disagrees`), the five appearance classes with no lane reader (its 9.2), the eleven entries it adds |
| part 07 | each entry of its section 14, and `hq-case-management/preload-read-later` (a preload a later default reads). Under its G1, outcome C alone: `hq-nova-then-builder/save-to-case-saved` (P2, outcome C2) |
| part 08 | M1 to M7; on `hq-search`, a search row with fixed quotes HQ's interpolation would not write; on `hq-case-lists`, `#host/p` in the case list filter, expecting the filter's HELD-NEW entry of part 08 section 9.2 |
| part 11 | on `hq-media`, a question image whose path has no map entry (REFUSED where a runtime draws it); on `hq-lookups`, a form that reads a tag HQ's table list lacks, which a source alone exhibits. A table with a field property and one with a row attribute are not variants: both live in the lookup answers, which no variant patches, and their entries (`expressions-and-data/fields-properties-and-multi-valued-cells-name-lang-en-name-name`, `expressions-and-data/item-attributes-and-per-row-attribute-values`) name lookup keys alone, so 7.5 exempts them under `not-in-app-source` with part 11's Vitest over `proof/hq-reads/lookups/` as their evidence. Part 11 says the same (11-project-data.md, "What this part needs of other parts") |
| part 02 | on `hq-menus`: a case list deep link on a display-only menu, a form display condition reading the case on a screen that chooses none first, a search on a display-only menu |
| this part | `hq-new-app/as-created`: the app exactly as `new_module` leaves it, whose registration form is the blank source HQ writes for a new form (`models/modules.py::Module.new_form`, `get_blank_form_xml`) and holds no question: `fix-in-hq` under `forms-and-case-writes/blank-source-or-no-non-group-question` (`not-hq-buildable`); `two-refusals-one-pass`: two refused changes in two forms of `hq-plain`, both expected |

### 7.3 The synthetic layer for `schema:` keys

The 207 non-allowing entries that name `schema:` keys alone (and each such entry step 6 adds) are
exhibited without an HQ operation: a JSON value of HQ's own schema is a value whoever wrote it.

`proof/matrix/schema_samples.json`, written by hand, one row an entry:

```json
{ "entry": "application-and-settings/build-profiles-non-empty", "base": "hq-new-app",
  "pointer": "/build_profiles", "value": { "p1": { "name": "French", "langs": ["fra"] } },
  "standing": "not-yet", "place": { "kind": "app-settings" } }
```

`pointer` addresses the parsed body of the base's source answer, as a patch's paths do (7.2).

- `lib/commcare/reader/__tests__/schemaKeyVariants.test.ts` sets each row's value at its pointer in
  the base's retained source answer and requires the reader to answer `account` with exactly that
  finding. It also sets, at every pointer of every base's source, a key no entry names, and requires
  `unrecognized` at that place (the totality test part 06 names, run over every base).
- `proof/matrix/test_classified.py::test_each_schema_sample_is_in_its_class` applies the same row in
  Python and requires `manifest_usage.standing` to give the standing the entry's disposition has
  there, resting on that entry: `refused` for a REFUSED entry with a value-class reader, and
  `held-new` for a HELD-NEW one, which Python gives only for an entry whose key no allowing entry
  shares or that is one of 8.2's thirteen (the example above is one of them). A sample of any
  other entry is listed by name as `unchecked_by_python`, as 7.4 lists variants; so a sample that
  is not in its class fails in the lane wherever the lane can tell, not only against the reader it
  tests.
- A row for every such entry is required by the coverage test (7.5).

### 7.4 The Python cross-check of authored variants

`proof/matrix/test_classified.py`, over what `authored` made (no reader, no bundle):

- `test_a_base_holds_nothing_refused`: `manifest_usage.app_json_uses` over each base's source
  answer (one call, which runs `xform_uses` over each form itself) gives no use whose standing is
  `refused`, `undecided`, `unnamed`, `unheld` or `held-new`.
- `test_a_refused_variant_is_in_its_class`: for a variant whose entry is REFUSED with a value-class
  reader, or HELD-NEW with one of section 8's thirteen, some use of the variant's source that the
  base's source lacks has that standing, resting on that entry. A builder that does not exhibit its
  entry fails here.
- Every other variant's expectation rests on its registry row and the reader, and the test lists
  them by name in its report (`unchecked_by_python`), so the count is seen.

### 7.5 Coverage

Every manifest entry is in exactly one of three sets or on the exemption list.

| Set | An entry is in it when | What it has run through |
|---|---|---|
| base-exhibited | some base's `expected.json` lists it in `claimed` | every proof |
| variant-exhibited | an authored variant's `expected.json` or a row of `schema_samples.json` names it | the reader in Vitest; Python where 7.4 decides |
| exempt | `proof/matrix/exemptions.json` names it with a reason | nothing; the reason says why |

`proof/matrix/exemptions.json` is `{ "<entry id>": { "reason": <one of five>, "note": "<one
sentence>" } }`, with the closed reasons. An entry has one reason, the first of this order that is
true of it, so a part's own decision outranks a key-family reason:

| Reason | Meaning |
|---|---|
| `stated-by-its-part` | a part of this plan decided it, named in `note`: part 01's four `doc_type` entries (its 8.3), part 11's `expressions-and-data/fields-is-indexed` and `expressions-and-data/absent-field-vs-zero-values-vs-empty-string` (its 13.1) |
| `needs-a-flag-no-configuration-grants` | the value exists only under a flag the lane's configurations never turn on for an HQ-authored A (`application-and-settings/36-hq-custom-base-url` under `CUSTOM_APP_BASE_URL`) |
| `no-surface-key` | the entry names no key (21 at `15a00a97`: 9 non-allowing, 12 allowing, before the first reason takes any) |
| `not-in-app-source` | every key is of a family an app's source never holds: `lookup-model:`, `lookup-workbook:`, `lookup-code:`, `hq-api:`, `project-setting:` (17 at `15a00a97`: 9 non-allowing, 8 allowing; 15 once part 11's two above are `stated-by-its-part`). The `note` of a lookup entry names its evidence, part 11's Vitest over `proof/hq-reads/lookups/` |
| `only-in-a-build` | every key is `parser:`, which a runtime reads from a build (7 at `15a00a97`, all allowing) |

`lib/commcare/surface/__tests__/entryCoverage.test.ts`, in ordinary CI, holds:

1. every entry id is in exactly one set or exempt, and no file names an id the manifest lacks;
2. **every kept entry is base-exhibited, and each one an archive follows is exhibited where an
   archive is made**. For each row of `KEPT_AT_HQ` (part 01, section 5):
   - a row whose entry `exemptions.json` names has `base: null` and is skipped
     (`36-hq-custom-base-url`);
   - every other row's `base` is a base whose `claimed` holds the entry;
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
   09, B7) is in some base's `firstPublish`; for every id of `EMISSION_REWRITE_IDS` whose
   `behavior` is `changes` (part 08 creates the registry in B6 and part 09 completes it in B7, its
   section 10), the register id its `declaredBy.change` names is in some base's `firstPublish`
   (for part 08's six the two ids are one), or, where its `declaredBy` is `{ refusedBy }`, that
   manifest entry is variant-exhibited; and every `register` id a reading can record in
   `ReadFacts.sameStateRewrites` (part 07) is recorded by the reading of some base;
4. no entry is exempt under `not-in-app-source` or `only-in-a-build` while one of its keys is of a
   family `manifest_usage.py` extracts from an app's source (the family list is read from
   `proof/checks/fixtures/source-families.json`, which `proof/checks/test_manifest.py` holds to the
   extractor).

Its failure names the entry and what would settle it (Copy L7).

---

## 8. Parity (B13)

### 8.1 What is compared

The reader and the lane's Python check are two classifiers written apart over one manifest. Parity
holds them to each other on every HQ-authored A, wherever Python decides.

`proof/checks/parity.py` (pure) exports `differences(document, records) -> list[Difference]`, in
the shape of `proof6.differences` and `source.differences`, and `undecided(document, records) ->
dict[str, int]`; `proof/checks/test_parity.py` holds the first to the register. For each
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

Python does not decide, and parity leaves to the variants' `expected.json`: a use it calls
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

A base reads clean, so on a base every use is `held` and every claim allowing; parity's teeth on
bases are the entry named (a `kept` claim on a key whose only allowing entry is HELD fails) and the
both-ways extraction. The refused side is 7.4's, in Python over every variant, and the reader's over
the same variants in Vitest: three statements of each variant's class (its registry row, Python, the
reader), each pair held.

`proof/checks/test_parity_controls.py` plants, with no HQ: a claim log naming another allowing entry
of the same key (one `entry` difference), a use with no record (one `unclaimed`), a record with no
use (one `unseen`), and an agreeing pair (none).

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
reader's own tests. The HELD-NEW entry part 02 adds in A5 is one of them and gets no Python reader
(`menus-and-case-lists/case-list-form-post-form-workflow-default-on-the-hidden-module-shape`, part
02, 02-menus.md, section 14). REFUSED classes keep
getting a reader with the pull request that adds them: part 04's N1 (A9), part 02's two (A4, A5),
part 07's two (B4).

---

## 9. `proof/first-publish-changes.json` and its judge

### 9.1 The file, and who writes what of it

The lane's register of what Nova's first publish over an HQ-authored app changes on purpose. Part 09
(09-acceptance-and-the-first-publish.md, section 11, B7) owns the typed register
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
		],
		"bases": ["hq-plain", "starter-health"]
	}
]
```

The rows above show the shape; a row that is not a `source` row is the run's to give, not this
plan's.

- `change` is a member of `FIRST_PUBLISH_CHANGE_IDS` (in stack A, of `CANDIDATE_IDS`, below). One
  object a change.
- `rows`: each a difference the entry allows, in the lane's own vocabulary: `check` one of `source`,
  `proof1`, `proof2`, `proof3`; `artifact`, the structural `path` and the optional `kind` name the
  class exactly as a known-defect entry does (`proof/README.md`, "Known defects"). A `source` row
  is one of the entry's `paths` in part 09's register. Every other row is written from a base's own
  evidence (`blocks/<id>/checks/<check>/corpus-<base>.json`), never by typing a path
  (`proof/CLAUDE.md`, "A structural path names a symptom"). No row names `intent`: an intent
  difference on a base says the reader read A wrongly or Nova's emission lost what D states, and
  neither is ever a declared change.
- `bases`: the `hq-authored` documents on which the entry applies, sorted. The loader
  (`proof/checks/changes.py::load`) refuses a name that is no `hq-authored` document (L11), two
  objects of one `change`, two rows of one class within an object, and a `check` outside the four.

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
    bases: tuple[str, ...]

def load(path: Path = FIRST_PUBLISH_CHANGES, *, authored=None) -> tuple[Change, ...]:
    """The file's entries in file order. With `authored` (the ids of the corpus's hq-authored
    documents), a base naming any other document is refused, as load_identity_moves refuses a
    document that is no witness."""

def declared(document, check: str, differences, *, inert: frozenset[str] = frozenset()):
    """-> (held, ids): the differences of `check` a row of an entry applying on `document` matches
    (9.2), and the ids of the entries that matched. From B13 a `source` difference whose pointer
    is in `inert` (the pointers the claim log holds under an entry of standing inert, 9.3) is
    matched by forms-and-settings-rewritten."""

def differences(document, checked: Mapping[str, Sequence[Difference]], *,
                inert: frozenset[str], readers: bool) -> list[Difference]:
    """B13. Holds 1 and 2 of 9.3 for one base. `checked` is every difference of the four checks,
    by check; `readers` is whether the served readers ran. Answers the `changes` differences
    `/<id>/unsaid` and `/<id>/unseen`."""

def bases_differences(
    entries: Sequence[Change], applies: Mapping[str, frozenset[str]]
) -> list[Difference]:
    """B13. Hold 4. `applies` is, for each base, the ids its first-publish.json lists. Answers one
    `changes` difference at `/<id>/bases` for each base an entry lists and the reading does not,
    and for each base the reading lists and the entry does not, on that base."""
```

**Three pull requests write it.**

| PR | What it writes | Held by |
|---|---|---|
| A1 | the file, with one object for each candidate P1's evidence gave a row (3.3): its `proof1`, `proof2` and `proof3` rows, `bases: ["hq-plain"]`. `proof/checks/changes.py::CANDIDATE_IDS` is the closed list of ids stack A may use: part 09's ids for the entries that apply to `hq-plain`, and any id a P1 outcome C1 added | the loader refuses an id outside `CANDIDATE_IDS` |
| B7 (part 09) | every register entry in registry order, each with its `source` rows; the rows and `bases` stack A wrote stand. `CANDIDATE_IDS` is deleted, and the loader takes any id | part 09's `proof/ci/__tests__/firstPublishChanges.test.ts`: the same ids in the same order as the register, each object's `source` rows equal to the entry's `paths`, a `proof3` row only under an entry whose `behavior` is `changes`, `bases` sorted and unique |
| B13 | every other row and every `bases`, from the lane's own evidence over the twenty-two bases (part 09's run K3) | the judge of 9.3 |

No row's path and no `bases` is typed. The lane's own command gives each from a run's output:
`python3 -m proof.checks.changes rows <output> <base>` prints, for each unheld difference of the
base's evidence, the row that names it, and a person pastes each printed row under the entry whose
change it shows (which entry a difference belongs to is the one judgment a person makes, from the
entry's sentence in part 09); `python3 -m proof.checks.changes bases <output>` (B13) rewrites
every entry's `bases` from the run's `first-publish.json` files. Both run on a hosted runner's
`python3`, on the standard library (`proof/CLAUDE.md`, "What runs with no image").

### 9.2 The hold, from A1

`proof/checks/changes.py::declared(document, check, differences)` returns the differences of
`check` that a row of an applying entry matches, and the ids that matched; `proof1.py`, `proof2.py`
and `proof3.py` call it before `cases.hold` (and `source.py` from B13). An entry applies on a
document:

- in stack A and until B13: where its `bases` names the document. No reader exists to say more.
- from B13: where the document's `first-publish.json` lists its id. That file, `{ "ids": [...] }`,
  is written at emission from the reading (`LaneReading.firstPublish`, the base's declaration's
  `AcceptedDeclaration.firstPublish.ids`): the changes Nova would tell the person this app's first
  publish makes. `bases` is then held to it (9.3, hold 4).

It is strict both ways, as `proof/walk-stops.json` is:

- a difference on an `hq-authored` document that no row of an applying entry matches goes on to the
  spelling rules and the known-defect register like any other, where nothing holds it, and fails;
- an entry that applies on a document must match some difference there. From A1 the register's
  evidence check (`registers.py::verify_evidence`, which already reports a known-defect entry that
  holds nothing) reports such an entry by its id and base; from B13 that is hold 2 of the judge;
- an entry is never read on a document it does not apply to, and never on a document of another
  source. `proof/identity-moves.json` stays the witnesses' alone.

The file joins `proof/store/fingerprints.py::JUDGE_FILES`, so an edit to it judges every document
again and observes none.

### 9.3 The judge (B13)

Part 09's section 13.4 states what the judge holds, and this part writes it:
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

`source` is a check like any other: its differences go through `changes.declared`, then the
spelling rules and the registers. It observes nothing new; it reads records proof 6 already needs.

**The inputs, a base.** The differences of the hop (`source`, proof 1 against A, proof 2 over every
build file but a form's XML, proof 3 always: section 4); the entries that apply (`first-publish.json`,
9.2); and the claim log in `full` mode, one request to the bundle in mode `claims` over part `a`'s
`authored` read, for entry 1's allowance: a `source` difference whose pointer the log holds under an
entry of standing `inert` is matched by `forms-and-settings-rewritten`, which is how that entry
covers "the settings no runtime reads" without a row for each.

**The four holds.**

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
   row, and part 09's Vitest admits a `proof3` row only under an entry whose `behavior` is
   `changes`. The other half is 6.4's rule: each such entry on a base has a before and after pair
   of value expectations that shows it.
4. **`bases` is the truth.** For every entry, `bases` equals the set of bases whose
   `first-publish.json` lists it, or `/<id>/bases` (L14). This is the one hold that reads across
   documents, so it runs once a run, in `test_first_publish_changes.py::
   test_bases_are_the_bases_each_change_applies_on`, over `Corpus.emitted`, and not once a document.

So the register is closed three ways: the typed list (part 09), the lane's file (9.1), and this
judge between what the reader predicts for an app and what HQ, Core and the readers then show.
`proof/views/test_exports.py` gains the `hq-plain` case in B13: HQ's form export of B holds a column
for each generated node, which is what the sentence of `hidden-values-added` tells the person.

### 9.4 Which base shows each entry

Section 7.5's rule 3 requires every id on some base. Part 09's register names the ids (its section
11.2) and asks for a base for each (its needs of this part); each is placed here:

| Entry (part 09's row) | Base |
|---|---|
| `forms-and-settings-rewritten` (1), `marked-as-updated-from-a-file` (2) | every base: each holds a form, and none was made through the import view that sets `import_app_api` |
| `hidden-values-added` (3), `case-names-checked` (4) | `hq-plain`, the three starters and every other base with a case name question |
| `validation-counts-moved` (5), `validation-messages-composed` (6) | `hq-questions` |
| `instant-comparison` (7), `empty-rows-guard` (8), `absent-session-value-guard` (9), `row-predicate-current` (10) | `hq-expressions` |
| `search-value-guards` (11), `search-today-device-day` (12), `search-filter-rows-recut` (14), `search-filter-joined-to-list` (17), `search-restates-list-filter` (19) | `hq-search` |
| `case-settings-respelled` (13) | `hq-case-management` |
| `link-held-case-guards-added` (20) | `hq-menus` |
| `sort-rule-kept-as-hidden-column` (15), `list-settings-respelled` (16), `detail-only-columns-searched` (18) | `hq-case-lists` |
| `connect-app-captures-location` (21), `web-apps-turned-off` (25) | `hq-connect-deliver` |
| `logo-path-only-entry-removed` (22), `location-list-setting-reset` (24) | `hq-kept-settings` |
| `translation-overrides-folded` (23), `blank-translations-filled` (28) | `hq-languages` |
| `web-apps-turned-on` (26) | `hq-new-app` |
| `date-and-time-questions-split` (27) | `hq-questions` |
| `media-paths-joined` (29), `media-path-not-holdable` (30), `media-path-names-another-file` (31), `media-path-differs-only-by-case` (32), `media-references-with-no-file-removed` (33), `unused-media-entries-removed` (34) | `hq-media` |

The two entries part 09 lands only on a gated outcome take their bases with them:
`default-reads-current` (part 08's E4, outcome B) on `hq-expressions`, which holds the shape either
way and expects no id under outcome A; `media-downloaded-again` (part 10's G2, outcome B) on
`hq-media` and the three starters. An entry P1 or P2 adds (outcome C1) is placed on the base that
showed it. No register entry is exempt from having a base.

---

## 10. Vitest suites over retained HQ answers (B13)

Retained HQ answers live in two trees, both written and byte-held by the lane:
`proof/hq-reads/` (what HQ answers of apps Nova published, and part 05's `reading/` group) and
`proof/hq-apps/` (HQ-authored apps). No suite reads a hand-written HQ answer.

`__tests__/helpers/retainedHqApps.ts` reads files and builds nothing HQ did not answer:

```ts
/** The directory names under `proof/hq-apps/`, sorted. */
export const RETAINED_BASES: readonly string[];
/** A base's directory, read synchronously: `proof/corpus/hqAuthored.ts`'s type (2.1). */
export function retainedBase(id: string): RetainedHqApp;

/** One operation of a variant's patch (7.2): RFC 6902's four, or this lane's `lines`. */
export type VariantPatchOp =
	| { readonly op: "add" | "replace"; readonly path: string; readonly value: unknown }
	| { readonly op: "remove"; readonly path: string }
	| { readonly op: "move"; readonly from: string; readonly path: string }
	| { readonly op: "lines"; readonly path: string; readonly from: number;
	    readonly drop: number; readonly add: readonly string[] };

export interface RetainedHqVariant {
	/** `<base>/<slug>`, as the registry names it. */
	readonly id: string;
	readonly base: string;
	readonly slug: string;
	readonly sourcePatch: readonly VariantPatchOp[];
	readonly applicationPatch: readonly VariantPatchOp[];
	/** The variant's `expected.json` (7.1). */
	readonly expected:
		| { readonly reads: false;
		    readonly findings: readonly { readonly code: string; readonly standing: ReadStanding;
		                                  readonly place: HqPlace }[] }
		| { readonly reads: true; readonly claimed: readonly string[];
		    readonly holds: readonly { readonly key: string; readonly pointer: string;
		                               readonly value: unknown }[] };
}
/** A base's variants, in slug order. */
export function retainedVariants(id: string): readonly RetainedHqVariant[];
/** The base's answer with the patch applied to its parsed body, serialized again (7.2). */
export function applyVariantPatch(
	answer: RetainedHqAnswer, patch: readonly VariantPatchOp[],
): RetainedHqAnswer;
/** A first reading's input: `identity: "mint"`, `claims: "full"`, `appId` the base's id, the
 *  base's own declaration where `base.json` states one, and, given a variant, the base's
 *  answers with the variant's two patches applied. */
export function laneInputOf(base: RetainedHqApp, variant?: RetainedHqVariant): LaneReadInput;
```

| Suite | Boundary | The failure it would catch |
|---|---|---|
| `lib/commcare/reader/__tests__/hqApps.test.ts` | the production reader, part 11's verdicts and acceptance (`readForLane`, so `runReadingCheck`) over every retained base, through a peer that answers native `fetch` from the retained answers | a base that no longer comes in; a reading whose declaration, claimed entries or first-publish ids are not `expected.json`'s; a retained answer the reading never asked for (`asked`), or a request with no retained answer, a mapped file's read among them (P8); a second reading of the same answers that differs by a byte (the reader is not a function of its input) |
| `lib/commcare/reader/__tests__/hqAppVariants.test.ts` | the same over every authored variant | a refusal with another code, standing or place; a held variant whose fragment is not in the document; a variant that reads when it must not |
| `lib/commcare/reader/__tests__/schemaKeyVariants.test.ts` | the reader over a base's source with one JSON value set (7.3) | a `schema:` class the walker does not refuse, or refuses under another entry; an unknown key read past |
| `lib/commcare/reader/__tests__/fixedPoint.retained.test.ts` | the reader over HQ's answers for the Nova-published documents whose source, application and version answers are all retained, against the corpus document built by its producer | a read back that is not `canonDocument(D)` on HQ-normalized input, on a laptop with no Docker |
| `lib/commcare/reader/__tests__/twoRefusals.test.ts` | the reader over the variant `two-refusals-one-pass` | a reader that stops at its first finding |
| `lib/commcare/surface/__tests__/entryCoverage.test.ts` | the manifest, `KEPT_AT_HQ`, the two rewrite id lists, and `proof/hq-apps/` with `proof/matrix/` | 7.5's four rules |
| `proof/reader/__tests__/notCarried.test.ts` | part 09's `readBackDifferences`, `CANONICALIZATIONS`' `not-carried` rows and `KINDS_WITH_NO_EXTERNAL_KEY` over built documents (5.5) | a kind compared by nothing and named nowhere; content one mechanism removes and the other also skips |
| `proof/reader/__tests__/retainedPeer.test.ts` | `withRetainedHq` under native `fetch` | a request with no retained answer that reaches a socket or is answered; the previous dispatcher not put back after a failure; `LANE_TARGET` other than `PROOF_SERVER` and `PROOF_DOMAIN` |
| `proof/reader/__tests__/laneIds.test.ts` | `mintLaneLookupIds`, `mintLaneMediaId` | an id `mediaAssetIdSchema`, `lookupTableIdSchema` or `lookupColumnIdSchema` refuses; two files, or a table and one of its fields, given one id; one file given two ids |
| `proof/corpus/__tests__/hqAuthored.test.ts` | the emission's `hq-authored` arm over `hq-plain` | a reading of `hq-plain` that is not the hand-written document by external key; an identity row missing for a menu or form |
| `proof/ci/__tests__/readerBundle.test.ts` | `proof/reader/build.mjs` run twice into two directories | a bundle whose bytes differ between two builds; a bundle that imports a module outside itself at run time |

The equal-bytes proof of each canonical pair and the fuzz read back are part 09's
(`lib/commcare/reader/__tests__/canon.test.ts` and
`lib/deployment/reading/__tests__/canonReadBack.fuzz.test.ts`, B7), and the file's hold to the
register is part 09's `proof/ci/__tests__/firstPublishChanges.test.ts` (B7). This part writes none
of the three again. Part 07's G1 case of
`lib/commcare/reader/caseManagement/__tests__/saveToCase.retained.test.ts` lands in B13 with its
base, `hq-nova-then-builder`, which it reads through `retainedBase`; part 07 plans the file.

For `fixedPoint.retained.test.ts`, `proof/hq/test_retained_reads.py` keeps two more files a document
in its publish group and each of its five drift groups: `application`, the application resource of
the app as Nova's first publish left it, through part 05's `application_read`, and
`current-version`, through `operations.current_version_read`. Twelve files, read through HQ's API
as the group's other reads are.

None of these is a Vitest DOM test, none runs a database, and each runs once in ordinary CI.
`hqApps.test.ts` is the heaviest: twenty-two bases, each read and accepted once.

---

## 11. Each pull request's proof lines

### 11.1 Stack A

Every stack A pull request runs the whole lane without the readers afresh (12.1). "Documents" are
the corpus documents it adds.

| PR | Documents and lane files | Registers and stops | Runs by hand before the stack merges |
|---|---|---|---|
| A1 | `hq-plain` (source `hq-authored`); the package `proof/matrix`, early-phase until B13 (2.3); `proof/first-publish-changes.json` in the shape of 9.1, with the entries P1's evidence gave rows (9.1); the observation's new arm, so every part key moves | known and fixed registers unchanged; identity moves unchanged; a walk stop only by P1's outcome W | P1 |
| A2 | none. The manifest check judges every document again under the re-cut entries; part 01's emission-side re-cuts add no use, which that check holds (a re-cut that left a Nova export `unheld` or `held-new` fails it) | none | none |
| A3 | `targeted-kept-values`: a targeted document declaring Android whose `hq-side.json` saves each mirrored kept value over A (`profileProperties`, `appAttributes`, `uiTranslations`, `republish: "proceeds"`), and whose `expected.json` holds the profile and app-string values on the local archive. The native `expression` family gains part 01's Run 2 vectors, under the test part 01 names | none | part 01's Run 1, with the readers, over `targeted-kept-values` |
| A4 | `targeted-forms-in-menu-above`, `-nested`, `-registration-only`, `-one-case`; the native family `menu-screens` with `MenuScreensRuntimeTest`; the REFUSED reader `put_in_root_beside_an_endpoint_inline_search_or_form_return` with its `SHAPES` pair; under part 02's G6 outcome B, `targeted-forms-in-menu-above-shared-case` | none; part 02's G2 outcome B teaches a walker and adds no stop | part 02's G1 (in its own CI), G2, G6 (in its own CI) |
| A5 | `targeted-register-from-case-list`; `RegisterFromListRuntimeTest`; the REFUSED reader `default_on_multi_select_host` | none | part 02's G3 (in its own CI) |
| A6 | `targeted-number-keypad` | none | part 03's G5 (the Android reader, by hand) |
| A7 | `targeted-prose-value`; `proof/hq/test_label_instance_text.py`; `ProseValueRuntimeTest` | none. Under part 03's G1 outcome B the output moves to the control part 03 names, and no known-defect entry is written | part 03's G1 (proof 4 runs in its own CI), G2, G3 |
| A8 | `targeted-search-no-title`, `targeted-sort-blanks`, `targeted-plain-help`; the spelling rule `hint-validation-markdown-form` with `proof/rules/test_hint_validation_markdown_form.py`. Every document holding a hint or a validation message re-emits | none added. The lane's expectations for a hint's and a validation message's formatted copy change as part 03 section 8.2 words them; a fixed entry whose control still shows its symptom stays as it is | part 03's G4 (the Android reader) |
| A9 | `targeted-hyphenated-question-ids`, `targeted-case-type-names`, `targeted-choice-values`, `targeted-lookup-names`, `targeted-search-field-names`, `targeted-case-write-names`, `targeted-connect-deliver-hyphen-ids`, `targeted-connect-learn-hyphen-ids`; the names fuzz sample (its own seeded documents, part 04 section 12); the REFUSED reader for N1 | none | part 04's R2 |
| A10 | none. No lane file changes; the billed schema check is asked of the person once, by part 15 | none | none |
| A11 | none | none | none |

Stack A adds twenty corpus documents and the names sample (twenty-one under part 02's G6 outcome
B).

### 11.2 Stack B

| PR | Documents and lane files | Registers and stops | Runs by hand before the stack merges |
|---|---|---|---|
| B1 | none. Part 05's new reads (`app_list_read`, `application_read`, `api_access_read` and the rest of its section 14.1) land in `proof/views/reading_reads.py`, outside the observation partition, because only `proof/hq/test_retained_reads.py` calls them below B13 and every file under `proof/hq/` moves every part key (12.1); B13 moves them into `proof/hq/operations.py`. `proof/hq-reads/reading/`; the `hq-api` surface family | none | part 05's G1 to G7, through `proof-slice.yml` |
| B2 | none. `proof/checks/fixtures/place-vectors.json` and `proof/checks/test_place_vectors.py` (part 06) | none | none |
| B3 | none; Vitest over `proof/hq-reads/` and `proof/hq-apps/hq-plain/` | none | part 06's R1 in its own CI; R2 by hand through `reader-scale.yml` |
| B4 | none; the REFUSED readers `case_list_endpoint_on_a_put_in_root_module` and `form_filter_reads_case_off_a_case_first_screen`; the two `targeted-migration-*` cases of part 07's `saveToCase.retained.test.ts` | none | part 07's G4 in its own CI |
| B5 | none | none | part 07's G2 in its own CI |
| B6 | none; the native families gain `ReaderSpellingRuntimeTest`, `proof/native/test_hq_interpolation.py`'s reader vectors, `proof/native/test_csql_reader_parity.py`, and the new cases of `RowPredicateCurrentRuntimeTest` | none | part 08's E1 to E4 run in its own CI |
| B7 | none; part 09 completes `proof/first-publish-changes.json` to every register entry in registry order with its `source` rows, keeping the rows and `bases` stack A wrote; its `proof/ci/__tests__/firstPublishChanges.test.ts` lands; `changes.py::CANDIDATE_IDS` is deleted; part 09's `proof/hq/test_question_type_rows.py` (its run K2); one line of `proof/corpus/publish.ts`: its `hqAuthoredA` arm's `adoptedAppBaselineWrite` call passes `firstPublish: { ids: [], touchesWorkers: false }` (no lane check reads the stored list, and a base's predicted ids reach the lane through `first-publish.json`) | the first-publish file, completed; no `source` row is judged before B13 | part 09's K2, through `proof-slice.yml`; K4 by hand through `reader-scale.yml` |
| B8 | none; the capture's ledger for an HQ-authored A takes `origin: "read"`, part 10's `adoptedAppBaselineWrite` and `adoptedIdentityRows`, the held media paths, and `languageNames` and `seeds` `"target"` (2.5), so `hq-plain` re-emits | none | part 10's G1 (the person's read-only scan) |
| B9 | `targeted-missing-media`; `proof/views/test_lookup_upload.py` gains part 11's R1 case; `proof/corpus/publish.ts` and `targetPeer.ts`, whose peer answers the lookup table reads the `managed-data` preflight makes (2.5) | none | part 11's R2 |
| B10 | none (real-Postgres tests in ordinary CI) | none | part 12's M1 by hand through `reader-scale.yml` |
| B11 | none (Playwright) | none | none |
| B12 | none (`servedSchemas.test.ts`; the billed check is part 13's E1, asked once at B12's head) | none | none |
| B13 | twenty-one bases; every variant; the targeted document `targeted-save-to-case-shapes` (`proof/targeted/documents/saveToCaseShapes.ts`), whose first publish `hq-nova-then-builder` starts from, and the G1 case of `lib/commcare/reader/caseManagement/__tests__/saveToCase.retained.test.ts`; `proof6`, `parity`, `source`, `changes`; the new records, so every part key moves; `proof/corpus/hq/` removed. `targeted-kept-values` stays (below) | walk stops only by P2's outcome W; the first-publish file's remaining rows and every `bases`, from the run (part 09's K3) | P2 (with part 07's G1 and G3, part 08's E6, part 10's G2, part 09's K3 and part 01's Run 3 inside it) and P4, by hand; P3, P5, P6 and P8 in its own CI |
| B14 | none | none | none |
| B15 | none | none | none |

Stack B adds twenty-three corpus documents: the twenty-one bases, `targeted-missing-media` (B9) and
`targeted-save-to-case-shapes` (B13). The targeted documents for each new concept of parts 02, 03
and 04 are the eighteen named in A4 to A9 above; each part words its own document, and each joins
`proof/README.md`'s "Targeted documents" with its sentence in its own pull request, as
`targeted-save-to-case-shapes` does in B13.

**`targeted-kept-values` stays after B13.** It is the kept rows' control and is not replaced by
`hq-kept-settings`, as part 01's Run 1 words it (01-the-bar-and-the-manifest.md, "Written and not
yet run", A3: it "stays beside B13's base `hq-kept-settings`"). The two hold different
deployments: `targeted-kept-values` is a Nova-born app whose kept values a person saved in HQ after
Nova's first publish, on a deployment Nova created (seeded with Nova's own settings, ledger origin
`push`), and `hq-kept-settings` is an app made in HQ and brought in (seeded with none, origin
`read`). `KEPT_AT_HQ` binds both, and part 01 section 7.3 makes the two publish differently.

### 11.3 `proof/known-defects.json` stays empty

`OPEN_DEFECTS` stays `{}` through both stacks. A live entry would mean Nova ships a defect it knows
and a later step owns; step 6's bar leaves no room for one on an app it brings in, and none of its
pull requests may add one. Every outcome that would have added one is settled in the stack:

| What the lane shows | Settled as |
|---|---|
| a difference on a Nova-born document from a stack A concept | the emitter is fixed in that concept's pull request (part 02's G1 outcome C is the model) |
| a difference on an HQ-authored document every reader reads alike | a spelling rule with its proof on each reader |
| a difference Nova makes on purpose and would tell the person | a first-publish register entry, and its sentence in B7 |
| a difference Nova would not tell the person, or a defect in holding a shape | the shape leaves what the reader holds: a `not-yet` entry with its owner, a variant in place of the base's shape |
| a report a reader makes of an app with no Nova byte | a member of `HQ_OWN_REPORTS` with its proof |
| a `proof6`, `parity`, `source` or `changes` difference | fixed, or, for `source`, declared in the first-publish register by part 09; these checks have no known-defect entry and the loader refuses one (`registers.py` refuses an entry whose `check` is one of the four, Copy L8) |

A control is retained only where a fix takes a registered symptom off a document, which no step 6
pull request does to an existing entry; A8 re-paths fixed entries only as "Fixed defects" rule 8
allows.

---

## 12. Cost

### 12.1 A pull request, without the readers

From `proof/timings.json`'s `no-readers` profile: the whole lane is 4,897 box-seconds (documents
3,622, controls 643, packages 632), and a document no run has measured is counted as
`sharding.estimate` counts it, at the 90th percentile of the measured documents and controls,
15.486 box-seconds.

| | Added, as counted before a measure | Whole lane | Expected end, every group fresh |
|---|---|---|---|
| main at `15a00a97` | | 4,897 | 14.0 min (840 s), modelled |
| stack A's head | 20 documents × 15.486 = 310; `proof/matrix` with one base, about 10 | 5,217 (+6.5%) | 14.4 min: 840 s plus 0.065 of a 377 s shard span |
| stack B's head | 23 more documents (21 bases, `targeted-missing-media`, `targeted-save-to-case-shapes`) × 15.486 = 356; the API reads, about 0.5 box-seconds a document over 473 documents = 237; `proof6`'s judge, about 0.25 a document = 118; `parity`, `source` and `changes` on the 22 bases, about 22; `proof/matrix` whole, about 150 | 6,100 (+24.6% over main) | 15.5 min: 840 s plus 0.246 × 377 s |

The figures marked "about" are estimates no run made: a read is three API requests in a fork (and
one a mapped file on the four bases with media), and the judge one Node start a document. P4
measures them, and `node proof/run.mjs --timings` replaces every counted figure with a measured one
in B13. At the measured median (6.354) the documents cost under half what the table counts.

**Every pull request of stack A runs the whole lane afresh, and three of stack B do.** A pull
request reads main's store and its own, never its base's (`proof/ci/store-keys.mjs`: one snapshot
scope a pull request), so a pull request above one that moved every part key observes every
document itself.

- Stack A: A1 changes the observation's code, which moves every part key. A push to the k-th of its
  eleven pull requests starts 12 − k whole lanes: eleven for A1.
- Stack B: B13 moves every part key (its records, and `proof/store` and `proof/lane`, which are in
  the partition). Below it no pull request does, on one condition this part sets: B1's new HQ
  operations sit outside the observation partition until B13 (11.2). `proof/hq/` is one of
  `proof/observe/partition.py::OBSERVATION_DIRECTORIES`, so adding them to
  `proof/hq/operations.py` in B1 would move every part key in B1 for reads only a test module
  makes, and every push to B1 would start fifteen whole lanes. With them outside, B1 to B12 each
  run the package groups (every harness file keys those), the judges whose files they change, and
  the documents they emit anew (B8 and B9: `hq-plain`, and `targeted-missing-media`). A push at or
  below B13 starts three whole lanes: B13, B14 and B15.

One whole lane is about 1.45 runner-hours of work (5,217 box-seconds) plus thirteen shards' fixed
cost (13 × 146 s = 0.53 hours). Pushes to the bottom of stack A, and to B13, are batched for that
reason, and a change to a lane file is settled at the lowest pull request that needs it before the
stack above is rebased.

Vitest: the suites of section 10 add seconds, `hqApps.test.ts` the most.

### 12.2 A night and a week, with every reader

From the `readers` profile (two workers a box): a document group's median is 1,289.9 box-seconds
(2,580 worker-seconds), and an unmeasured document is counted at 4,652.6 box-seconds (9,305
worker-seconds), the 90th percentile `sharding.estimate` uses.

| | Added | In worker-hours |
|---|---|---|
| stack A's 20 documents, weekly | 20 × 9,305 as counted; 20 × 2,580 at the median | 51.7 counted, 14.3 at the median |
| stack B's 23 documents, weekly | 23 × 9,305; 23 × 2,580 | 59.4 counted, 16.5 at the median |
| the API reads and `proof6` on every document | under 3 worker-seconds a document, 473 documents | 0.4 |

Against 552 worker-hours for the whole lane with every reader, the two stacks add 6% at the median
and 20% as first counted. The starter apps are the heavy ones: agriculture's nine forms walked whole
in the client, in one language, for every case.

**The first night after each merge is the whole lane with every reader.** Stack A moves every part
key (A1), and so does stack B (B13), so each merge's next night observes every group: about 605
and then about 665 worker-hours as counted, where the `README` plans a fresh queue of this size at
31 to 37 hours on fourteen runners. That night can span the next schedule, which the
`proof-scheduled-readers` queue serializes, as it does after any merge that moves every key
(`proof/CLAUDE.md`, "Three lanes"). Nothing is scheduled around it: step 6 has no window (the
top-level file `../6-bring-in.md`, "The stacks" and "Migrations and the cutover"), and a stack merges
when it is proven green. One ordering is evidence and not a window:
stack B merges no sooner than the first green night after stack A, because stack B's pull requests
read main's store, and until that night main's store holds no record made under stack A's keys.
The night's issue, if one opens, is read before stack B's pull requests are rebased.

The weekly whole run after stack B refreshes the `readers` profile: the person who merged stack B
opens the ordinary pull request that commits `node proof/run.mjs --timings` over that run's outputs.
Until then the new groups are counted at the 90th percentile, which oversizes the lane and
undersizes nothing.

### 12.3 What a reader change costs after step 6

A change under `lib/commcare/reader/`, or to anything the bundle imports, changes
`native/reader/reader.mjs`: every corpus document is judged again from its records, on about three
shards, in about twelve minutes, and no Nova-born document is observed. A base whose reading the
change moves is emitted anew (its `document.json`, `expected.json` or `first-publish.json`
differs), so that base is observed again and the pull request adopts its new `expected.json` into
`proof/hq-apps/` with `python3 -m proof.matrix.adopt` (5.6, section 14). A change that moves no
reading observes nothing, and the night after it is not a whole lane. A change to the emitter moves
documents' keys as it does today.

### 12.4 Runs by hand

- **Never on the person's machine.** They work on the laptop agents run on. Every run named in this
  plan is on GitHub's hosted runners: a pull request's own CI, `proof-audit.yml`'s `mechanics`
  dispatch, `proof-slice.yml`, `reader-scale.yml` (part 06's, B3: its R2, part 09's K4 and part 12's
  M1), or `ci.yml`'s `proof_fresh`.
- **Asked first, each time.** A dispatch spends the account's runners: a `mechanics` run of eleven
  or twelve bases with every reader is about 8 to 31 worker-hours (the median and the counted
  figure of 12.2) and holds up to fourteen of the account's twenty runners for one to three hours.
  Before each, the person is asked with the documents, the readers and that estimate; there is no
  standing approval.
- **One dispatch at a time**, never while a scheduled lane with the readers is running, so pull
  requests keep their six runners (`proof/CLAUDE.md`, "Three lanes").
- A `mechanics` dispatch names at least one edited document; `hq-plain` is in each for that. So P2's
  twenty-two bases go in two dispatches of eleven and twelve: `hq-plain` with ten others, then
  `hq-plain` with the remaining eleven.
- A run's verdict is its gate's summary. Nothing is pushed to find the next failure: what the run
  reported is fixed, proven green where CI could fail it, and then pushed.

---

## 13. `proof/corpus/hq/` and its self-checks (B13)

`proof/corpus/hq/` harvests HQ's own test apps, template apps and `.ccz` archives at CommCare 2.54.0
for a group, `hq-selfchecks`, that no test module belongs to and no queue holds. Step 1's decision
17 left HQ-authored apps to step 6, and `proof/matrix` is how step 6 holds them: authored at the
floor, with real form sources, each with an expectation. The harvest has none of the three.

Removed in B13: `proof/corpus/hq/__main__.py`, `harvest.py`, `sources.py`, `test_harvest.py`,
`test_sources.py`; the emission's `--with-hq` flag and its step (`proof/corpus/emit.ts`);
`"hq-selfchecks"` from `proof/lane/blocks.py::SINGLE_GROUPS`, its sentence in that module's
docstring and its name in `group_problem`'s message, its sentence in `proof/store/queue.py`'s
docstring and in `proof/checks/sharding.py::collection_roots`'s, and its name in
`proof/lane/test_blocks.py`; the README section "HQ's apps as self-checks".

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

## 14. The weekly pin pull request (B13)

A pin move can change any byte of `proof/hq-apps/`: HQ's stored document, its answers, a form the
form builder writes. `proof/matrix/test_retained.py` fails on the first, naming the base.

`python3 -m proof.matrix.adopt <output>` (A1) is the one way the trees are written: it copies
`blocks/*/hq-apps/` over `proof/hq-apps/` and `blocks/*/hq-reads/` over `proof/hq-reads/`, removing
a file the run did not write, and with `--report` prints each base whose stored app or answers
changed, each variant whose patch changed, and each base whose reading changed standing (read by
running the bundle the run's own corpus production built over the old and the new answers). A pull
request that changes a builder, the reader or `targeted-save-to-case-shapes`'s capture runs it over
the output of the failing `test_retained.py`, which wrote what HQ made before it compared.

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

What a person then does on that branch, each before it merges:

- a base that no longer comes in: the entry its finding names is classified (the pin added a key or
  a value: the surface diff in the same pull request says which), as any new surface item is;
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
| L2 | the same file, the hand-written arm | `The hand-written document for ${base} names ${named} menus and forms, and CommCare HQ's app holds ${held}. Each menu and form of proof/hq-apps/${base}/app.json needs exactly one identity row in proof/matrix/hand/${base}/document.ts. The ones without a row: ${missing}.` |
| L3 | `proof/matrix/test_retained.py` | `proof/hq-apps/${base}/ is not what CommCare HQ holds and answers at its pin: ${differences}. What HQ made is under ${out}. Copy it into proof/hq-apps/${base}/ (python3 -m proof.matrix.adopt ${output}) and read what changed.` `differences` joins the clauses that are true with commas and a final `and`: `it lacks ${missing}`, `${stale} changed`, `it holds ${extra}, which HQ did not make`. For `hq-nova-then-builder` the message ends: `This base starts from Nova's own publish of targeted-save-to-case-shapes, so a change to that document's capture changes it too.` |
| L4 | `proof/checks/readerbundle.py` | `Proof 6 runs Nova's reader from the corpus (native/reader/reader.mjs), and ${corpus} holds none. The corpus job builds it (node proof/reader/build.mjs); look at native/produced.json and native/logs/reader.log for why it was not written.` |
| L5 | `proof/checks/test_proof6_fixed_point.py` | `Nova read ${document} back from CommCare HQ (${state}) and got a different document: ${found}, the first at ${path}. Nova's own export must read back to the document that made it. If the two documents print the same bytes, the pair belongs in CANONICALIZATIONS (lib/commcare/reader/canon.ts) with its test; otherwise the reader lost or changed something there.` `found` is `one difference` or `${count} differences`. |
| L6 | `proof/checks/test_parity.py` | `Nova's reader and the lane's manifest check disagree about ${key} at ${where} in ${artifact} of ${document}: the reader claimed it under ${entry} (${readerStanding}), and the lane reads it as ${laneStanding}. One of the two is wrong about this value. Look at the entry's row in lib/commcare/surface/entries/ and at the value itself.` |
| L7 | `entryCoverage.test.ts` | `No base and no variant shows the manifest entry ${entry}, and proof/matrix/exemptions.json gives no reason for leaving it out. Every entry is exhibited by a base that comes in, by a variant with its expected finding, or exempted with one of the five reasons. Add the one that is true of it.` |
| L8 | `proof/checks/registers.py`, the loader | `The register entry ${id} names the check ${check}. A difference of proof 6, parity, the stored-app comparison or the first-publish judge is never a known defect: it means Nova's reader, its manifest or its first-publish list is wrong, and it is fixed where it is found.` |
| L9 | `proof/checks/test_first_publish_changes.py`, hold 1, `unsaid` | `Publishing ${document} back to CommCare HQ changed something Nova's review would not have mentioned: ${id}, seen at ${path} by ${check}. Either the change's rule in FIRST_PUBLISH_CHANGES misses this app, or the reader should not have held the shape that caused it.` |
| L10 | the same test, hold 2, `unseen` | `Nova's review of ${document} would say its first publish makes the change ${id}, and nothing the lane ran showed it. Either the rule fires where the change does not happen, or no row of the entry in proof/first-publish-changes.json names what this base shows.` |
| L11 | `proof/checks/changes.py::load` | `The first-publish entry ${id} names the base ${document}, which is not an app made in CommCare HQ. A first-publish change is accepted only on the HQ-authored bases it names; a difference on any other document is a defect or a spelling rule.` |
| L12 | `hqAppVariants.test.ts` | `The variant ${variant} should be refused at ${placeLine} under ${code} (${standing}), and Nova's reader answered ${got}. Look at the one change the variant makes (proof/hq-apps/${base}/variants/${slug}/source.patch.json) and at the reader's claim for that key.` |
| L13 | `proof/corpus/hqAuthored.ts`, a declaration the reading does not offer | `The base ${base} is to be read as an app that runs on ${stated}, and Nova's reading of it offers only ${offered}. A base's declaration is one a person could choose in the review. Either the base's content no longer allows that choice (look at what proof/matrix/bases/ authors for it) or the reader narrowed the choices wrongly.` `stated` and each of `offered` read as `Web Apps and Android`, `Web Apps only` or `Android only`, with `, with date and time questions split` after one that takes the split. |
| L14 | `proof/checks/test_first_publish_changes.py`, hold 4, `bases` | `proof/first-publish-changes.json lists the change ${id} on ${listed}, and Nova's reading says it applies on ${applies}. The file's bases are written from the run (python3 -m proof.checks.changes bases ${output}); if the reading is the one that is wrong, look at the entry's rule in FIRST_PUBLISH_CHANGES.` |
| L15 | `proof/reader/laneReading.ts`, a request with no retained answer | `Nova's reader asked CommCare HQ for ${path} while it read ${base}, and the lane holds no answer for that request. The retained answers are every request Nova's client makes of an app; either the client now asks for something new, which the lane must read and keep (proof/matrix/retain.py), or it built an address HQ does not give.` |

`placeLine` is part 01's (`lib/publish/hqFindingCopy.ts`). No string here uses an em dash, and none is
a button or a placeholder.

---

## Tests

Each names its boundary and the failure it would catch. Lane tests are pytest in the image;
`*.test.ts` run in ordinary CI's Vitest. Sections 5.4 to 5.6, 7.4, 8.1 and 10 name the rest.

| Test | PR | Boundary | Failure it would catch |
|---|---|---|---|
| `proof/matrix/test_retained.py::test_the_hq_apps_nova_reads_are_hqs_own` | A1 | HQ's own views, models and API over a real unit | a retained app or answer a person edited, or that a pin moved unseen |
| `proof/matrix/test_remade.py::test_an_authored_app_is_remade_with_its_ids` | A1 | `operations.save_authored_app` in a unit | A in the unit holding other menu ids, form ids, `xmlns` or content than the emission read (P7) |
| `proof/matrix/test_seed.py` | A1 | `case_seed` over planted apps; `seeded_case_database` | a seed that reads D; a compared literal missed, so both walks show an empty list; a `parent/<property>` name or `name` written as a case property; `commcare-user` seeded as a type; a child indexed under `parent` where its form names another identifier |
| `proof/checks/test_corpus.py` (new cases) | A1 | `Document.exports`, `configurations.privileges_for` and `unit.input_files` over a planted `hq-authored` document directory | an HQ-authored document refused for having no `create.json`; privileges derived from A alone, so B lacks what Nova's publish adds; a part key that does not name `authored/app.json` |
| `proof/checks/test_intent.py` (new case) | A1 | `profile_settings` and `local_profile_settings` with A's stored profile as `saved` | a kept profile value reported as a difference at B or in the archive; an unstated setting expected at Nova's seed on an app that holds none |
| `proof/matrix/test_expectations.py` (the restore rules) | A1 for `hq-plain`, B13 for the rest | each hand `restore.xml` against its expectations and its base's seed | a datum naming a case the restore lacks; a hand restore writing a property the app does not hold |
| `proof/matrix/test_media.py` | B13 | HQ's `CommCareMultimedia` classification of each stand-in | a stand-in HQ stores as another class, or two paths sharing one file by accident |
| `proof/matrix/test_patch.py`, `retainedHqApps.test.ts` | B13 | the two patch readers over shared vectors, a `move` and a `lines` among them; every committed patch | a variant Vitest reads differently from what HQ answered; a variant whose reads drew other form ids than its base's, so its patch carries whole forms |
| `proof/matrix/test_classified.py` | B13 | `manifest_usage.standing` over every base and variant | a base holding a refused value; a variant that does not exhibit its entry |
| `proof/matrix/test_expectations.py` | B13 | the registry, the hand files, each base's `expected.json` and the claim logs | a kept or rewritten entry with no value fixed by hand; a declared change with no before and after; a base of several languages read as Web Apps only |
| `proof/checks/test_source.py` | B13 | `source.differences` over planted pairs of source answers, no HQ | two reads' re-minted form ids reported as a change; a form link that moved to another form not reported; a changed kept key absorbed |
| `proof/checks/test_first_publish_changes.py`, `test_first_publish_changes_controls.py` | B13 | the judge's four holds over every base; over planted evidence, both profiles | an undeclared difference absorbed by an entry that does not apply; an entry declared in vain; a served reader's entry failed in the readers-off profile, or skipped with the readers on; `bases` that is not where the entry applies |
| `proof/lane/test_blocks.py` (new case) | B13 | the import graph and `queue.PACKAGE_DATA` | a package whose tests run the bundle without the `reader` kind, whose stored verdict a reader change would leave standing |
| `proof/checks/test_corpus.py::test_an_hq_authored_document_runs_every_check_but_sensitivity` | A1 | `eligibility.eligible` | a check silently left out of the hop |
| `proof/checks/test_build_files.py` (new case) | A1 | proof 2's comparators over an `hq-authored` document | a build file other than a form left with no comparator |
| `proof/checks/test_registers.py` (new cases) | A1 | the first-publish loader and its strictness | an entry naming a Nova-born document; an id outside `CANDIDATE_IDS` in stack A; an entry that matches nothing on a base it names; a difference absorbed on a base the entry does not name |
| `proof/corpus/__tests__/publish.postgres.test.ts` (new case) | A1 | Nova's real `publishAppToHq` over real Postgres (identity rows inserted with Kysely, as `publishSequence.postgres.test.ts` inserts them) and a peer holding HQ's retained source | a capture that is not what Nova would send over an adopted app; a body carrying a derived id |
| `proof/corpus/__tests__/emitCorpus.test.ts` (new case) | A1 | the emission, twice | an `hq-authored` document whose bytes differ between two runs |
| `proof/checks/test_record_determinism.py` (extended) | B13 | a `USERCASE` document, whole and under a stored `a` | the API reads leaving a write behind that a state made again lacks |
| `proof/store/test_keys.py`, `test_pack.py` (new cases) | B13 | the queue builder and packer over a stored run | a reader change that observes a document whose files did not change, or that leaves a stale judgment or a stale package verdict cached |
| `proof/checks/test_judge_purity.py` (new case) | B13 | the import graph | a judge other than the three running the bundle; the bundle reachable from an observation |
| `proof/hq/test_privilege_rules.py` | B13 | moved unchanged, under the root fixtures | as before |
| `proof/upstream/__tests__/pins.test.ts` (new cases) | B13 | `pins.mjs` with controlled `git` and `gh` | a pin pull request without its regenerated trees |
| `proof/ci/__tests__/` (new case over `proof-lane.yml`) | B13 | the workflow file | a job that takes the candidate's surface and not its retained trees |

No test sleeps. Every process a test starts goes through `proof/processes.py`.

---

## Contracts and docs these changes make false

| File | Today | From | PR |
|---|---|---|---|
| root `CLAUDE.md`, the `proof/` bullet | "over a reproducible corpus of admitted documents" | "over a reproducible corpus of admitted documents and of apps made in CommCare HQ's own pages" | A1 |
| root `CLAUDE.md`, the same bullet | "Its checks (the bar, intent, manifest, configuration sensitivity, proofs 1 to 5, every walk held to its end or a held stop)" | "Its checks (the bar, intent, manifest, configuration sensitivity, proofs 1 to 6, parity with Nova's reader, every walk held to its end or a held stop)" | B13 |
| root `CLAUDE.md`, the same bullet | "every difference is erased by a proven spelling rule or held by the strict known-defect register (`proof/known-defects.json`), whose entries for a fixed defect move to `proof/fixed-defects.json` and keep showing on its retained control;" | "every difference is erased by a proven spelling rule, held by the strict known-defect register (`proof/known-defects.json`), whose entries for a fixed defect move to `proof/fixed-defects.json` and keep showing on its retained control, or, on an app made in CommCare HQ, named by the first-publish register (`proof/first-publish-changes.json`);" The sentence is replaced whole, so the clause on `proof/known-defects.json` stays with the register it describes (part 15, section 6.2) | A1 |
| `proof/CLAUDE.md`, opening | "over a reproducible corpus" | "over a reproducible corpus of Nova's documents and of apps HQ's own pages and models made" | A1 |
| `proof/CLAUDE.md`, "Observation is separate from judgment" | (no sentence about a judge running a process) | 5.7's paragraph | B13 |
| `proof/CLAUDE.md`, the accepted seams | "The accepted seams are these four" | "The accepted seams are these five", with 6.3's paragraph | B13 |
| `proof/CLAUDE.md`, "The register is strict" | "Every difference a check reports is held by an entry of `known-defects.json` or erased by a spelling rule" | adds: "On a document made in HQ (`hq-authored`), a difference the first-publish register names for that document is the one other thing a check may accept, and that register is strict both ways and never read elsewhere. Proof 6, parity, the stored-app comparison and the first-publish judge take no known-defect entry." | A1 (first sentence), B13 (second) |
| `proof/CLAUDE.md`, new rule | (none) | "**An HQ-authored A is HQ's own.** A base is made by HQ's views, models and form builder in `proof/matrix`, retained under `proof/hq-apps/` and held to the pin byte for byte; the unit saves it again from its stored document and never through Nova's import. Its case database is seeded from A alone (`proof/matrix/seed.py`), so a reader that drops something cannot empty both walks. What a person writes about a base (`proof/matrix/hand/`) is written from A's authored meaning, never from a reading." | A1 |
| `proof/README.md`, "A, B and B-edit" | (three bullets and the witness paragraph) | adds a paragraph: section 2's A, B and B-edit for an `hq-authored` document, and section 4's table | A1 |
| `proof/README.md`, "Proofs 1 to 5" heading and list | five items | "Proofs 1 to 6", with item 6 (5.1) and what it does not hold | B13 |
| `proof/README.md`, "Native proofs" | "to the structural intent checks, and to proofs 1 to 5." | "to the structural intent checks, and to proofs 1 to 6." From B13 proof 6 reads back every Nova-born corpus document, the native families' among them (run P5; part 15, section 8.2) | B13 |
| `proof/README.md`, "Manifest checks" | "An allowing class is what its row describes and is never read" stands; "A use whose key only HELD-NEW entries name is held-new" | adds: "A HELD-NEW class with a value-class reader takes its uses wherever its key is named (thirteen classes, `VALUE_CLASSES`)", and a subsection "Parity with Nova's reader" (section 8) | B13 |
| `proof/README.md`, "Spelling rules and the registers" | (no first-publish register) | a subsection "First-publish changes" (section 9) | A1, completed B13 |
| `proof/README.md`, "Where documents come from" | "Five sources feed it" | "Six sources feed it", with the `hq-authored` bullet and a section "Apps made in CommCare HQ" (sections 2, 6 and 7: the tree, authoring a base, adding a variant, the hand files, coverage) | A1, completed B13 |
| `proof/README.md`, "The layout on disk" | (the per-document list) | adds `authored/` (2.4), the hand-written `restore.xml` (6.4) and `first-publish.json` (9.2), and says an `hq-authored` document holds no `create.json` and one configuration; `<corpus>/native/` gains "and the reader bundle (`native/reader/`)" | A1, B13 |
| `proof/README.md`, "HQ's apps as self-checks" | the section | removed (section 13) | B13 |
| `proof/README.md`, "Targeted documents" | (no row for the document) | adds: "`targeted-save-to-case-shapes` holds every Save to Case shape Nova writes (a root create, a keyed create, a create in a repeat, a conditional update, a close, a several-case form, the own arm in a block, the own close's block) and one form with no Save to Case operation whose validation holds a lifted count. Its first publish is what the base `hq-nova-then-builder` saves again in HQ's form builder." | B13 |
| `proof/README.md`, "How the lane observes", the unit's diagram | `create(D) → media → HQ-side saves` | `create(D) → media → reads → HQ-side saves`, and `reads` after `republish(D) → media` and `update(D′) → media` where 5.3 says | B13 |
| `proof/README.md`, "The Core runner" | "Each document's sessions run over its case database ... drawn from the emitted effective `catalog`" | adds: "A document made in HQ takes its database from A instead (`proof/matrix/seed.py`)" | A1 |
| `proof/README.md`, "The evidence store" | "each check's evidence on a document under the document's files, ... and the judge's code" | adds: "and, for a corpus document, the reader bundle the corpus carries" | B13 |
| `proof/README.md`, "How the harness proves itself" | (the table) | rows for `test_retained.py`, `test_remade.py`, `test_seed.py`, `test_classified.py`, `test_source.py`, the judge's controls, the bundle's key test, `notCarried.test.ts` | A1, B13 |
| `proof/checks/configurations.py`, the comment over `PRIVILEGE_CAPTURES` | "The captured publishes whose apps the privilege derivation reads: D's first publish and D′'s update under the minimum configuration." | adds: "For a document made in HQ, the app HQ's own pages made (`authored/app.json`), Nova's republish over it and D′'s update." | A1 |
| `proof/observe/unit.py::input_files`, docstring | "Part `a` reads both imports of a first publish in the two-import layout, and the privileges read both" | adds: "Part `a` of a document made in HQ reads the app, media and seed under `authored/` in their place." | A1 |
| `proof/observe/casedata.py`, module docstring and `lookup_fixtures` | "`lookup_fixtures` uploads the lookup workbook Nova's push sends" | "`lookup_fixtures` uploads the lookup workbook Nova's push sends and serves the tables (`served_fixtures`); a document made in HQ uploads none and is served the tables its A was made with" | B13 |
| `.github/workflows/upstream-pins.yml`, header | "(proof/image.lock) and the surface regenerated from them" | adds: "and the retained HQ answers and apps made again at them (`proof/hq-reads/`, `proof/hq-apps/`)" | B13 |
| `proof-lane.yml`, the comment over `surface` | "`surface` puts the surface the candidate's pull request will carry in place" | adds the same sentence for `retained` | B13 |
| `proof/README.md`, "Changing a pin" | "The pull request that moves the pin regenerates them by copying `.proof/out/blocks/<id>/hq-reads/` over `proof/hq-reads/`" | "The weekly pin pull request regenerates `proof/hq-reads/` and `proof/hq-apps/` itself (`python3 -m proof.matrix.adopt`); a pin moved by hand runs the same command" and section 14's list | B13 |
| `proof/README.md`, "Timings" | the corpus counts and the table of expected ends | refreshed from P4's run | B13 |
| `proof/README.md`, "Step 1's decisions", 17 | "HQ's feature-matrix apps belong to step 6, whose reader is their first consumer." | adds: "Step 6 holds them as bases and variants (`proof/matrix`, `proof/hq-apps/`)." | B13 |
| `proof/store/keys.py`, module docstring | "`group_key(document key, judge, records)`: ... the judge's code (whose fingerprint includes both registers)" | adds: "and, for a corpus document, the reader bundle (`judged_under`)" | B13 |
| `proof/checks/manifest_usage.py::standing`, docstring | its last paragraph | 8.2's replacement | B13 |
| `proof/corpus/publish.ts`, header | "a ledger that records no identity override, so every id is the derived one" | "a ledger that records no identity override for a Nova-born document, so every id is the derived one; for an HQ-authored A, the ledger a bring-in leaves, with one identity row a menu and form (`hqAuthoredA`)" | A1 |
| `proof/corpus/documents.ts`, header | "Five sources feed the corpus" | "Six sources", with the bullet | A1 |
| `docs/plans/hq-round-trip/README.md`, step 1's bullet on the proof lane | "proofs 1 to 5" | "proofs 1 to 6" | B14 (part 15 lands it) |
| `lib/commcare/CLAUDE.md`, "The surface manifest" | (no sentence on coverage) | "Every entry is shown by an app made in CommCare HQ that comes in, by a variant of one with its expected finding, or exempted with a reason (`lib/commcare/surface/__tests__/entryCoverage.test.ts`)." | B13 |

`docs/testing.md` changes nothing: every new test follows it as written.

---

## Departures

Departures from the outline and the research, and the alternatives this part weighed and did not
take. Each states the decision and its evidence; a "Not done" names the alternative an implementer
could reach for, and why it is not built. The numbers are fixed, since other files cite them.

1. **The probe base is `hq-plain`, an app made by HQ's own pages and form builder that holds only
   what Nova at `15a00a97` holds.** Not done: a starter app as the probe base, with a hand-written
   D, because each starter app
   holds `put_in_root` menus and a `case_list_form` with no search (agriculture 2 and 1, health 2
   and 1, wash 4 and 1, counted from the template files), which Nova cannot state before A4 and A5,
   and each holds media under HQ's own paths, which Nova writes back there only from B8. A
   hand-written D for a starter would fail the gate at A1 or fail proof 1 on every media path. The
   question the probe exists to answer (how HQ's authoring and Nova's emission of one meaning
   differ to a reader) is asked by `hq-plain` at A1, when its answer can still move stack A; the
   starters are asked the same in P2, before stack B merges.
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
5. **From the outline's item 7 ("at least one HQ app per manifest entry, built through HQ's own
   models"), for entries that name `schema:` keys alone.** Those entries
   are exhibited by a hand-written sample table applied in Vitest and checked in Python
   (7.3); authored variants are the entries with a key of
   another family. Not done: an authored variant, a base plus one HQ model operation, for each of
   the 586 non-allowing entries, because a JSON value of HQ's own schema is a value whoever wrote
   it, so the 207 that name `schema:` keys alone need no HQ operation to be shown (7.3).
6. **A starter app's media are stand-in files, made by the lane and attached
   with the calls HQ's loader makes, named as a seam (6.3).** Not done: the files HQ's loader
   fetches, kept as a retained set, because `load_app_from_slug` fetches
   from addresses the lane does not reach and tolerates a missing file, and the fetched files are
   not Nova's to commit to a public repository.
7. **From the outline's item 7 and its Exit.** "At least one HQ app per manifest entry ... plus
   generated combinations" and "every other app is refused with the right reason" become: every
   base comes in, republishes and passes section 4's checks; every variant is refused or held as its
   `expected.json` says; every entry is in one of 7.5's sets. The outline's "generated combinations"
   are the one composed variant (`two-refusals-one-pass`); combinations of held entries are the
   bases themselves.
8. **From the outline's item 4 (drift merging).** Not in step 6: bringing HQ's changes in is step 7's
   first group (`changes-made-in-hq`: the top-level file `../6-bring-in.md`, "What changed from the
   outline, and why", item 4), and its lane design is planned with it. Not done: extending
   `hq-side.json` with content edits and a `merges` outcome. Nothing
   here changes `HqSideSaves`.
9. **Proof 6 runs on B-edit**, for every edited
   document with no `hq-side.json`. Not done: proof 6 at A and B alone, because D′ is a Nova
   document as much as D is, and the read costs three
   requests. `canonDocument` applies to every D′, an HQ-authored base's among them, since an edit
   made in Nova can hold either member of a canonical pair (5.1).
10. **Thirteen HELD-NEW value-class readers in Python** (8.2), where part 01 and
    part 04 leave the number to this part. Not done: leaving every HELD-NEW class that shares a
    key unjudged by Python, as the lane does today, because where step 6 cuts a HELD row by one
    value's grammar or bound, a wrong draw publishes over an app Nova mis-read (8.2).
11. **`hq-plain`'s hand-written document stays after B13** as the one reading
    held to a document a person wrote (2.1). Not done: removing `document.ts` once the read arm
    exists, because neither production acceptance nor proof 6 can catch a consistent mis-read: it
    prints back to itself (5.1).
12. **No departure on migration, rollout or product code.** A1 and B13 change nothing under `lib/`
    but `lib/commcare/surface/__tests__/entryCoverage.test.ts`, the reader's own test directories
    (section 10's suites, and part 07's G1 case of `saveToCase.retained.test.ts`) and one sentence
    of `lib/commcare/CLAUDE.md` ("Contracts"); `proof/reader/` imports the reader, part 09's
    `readBack.ts` and `canon.ts`, and is imported only by Vitest suites and their
    helper (`hqApps.test.ts`, `hqAppVariants.test.ts`, `fixedPoint.retained.test.ts`, its own
    `__tests__/`, and `__tests__/helpers/retainedHqApps.ts`, whose `laneInputOf` answers a
    `LaneReadInput`). No production module imports it.
13. **Part 09 holds the one canon list, in `lib/commcare/reader/canon.ts`, and this part keeps
    none.** Not done: a list of the canonicalizations the parts hand on, collected here under
    `proof/reader/`, because part 09's acceptance tests and its run K1 need the list in
    B7, beneath B13, and a second list in `proof/reader/` would have its own ids, its own
    equal-bytes test and its own fuzz read back, and two lists drift: a row one holds and the other
    lacks, or one id spelled two ways. One list has one definition. What proof 6 needs of the list
    is kept: every canonicalization a part hands on is a row proof 6 applies,
    and P5 adds what the lane's run finds.
14. **What the probe base holds.**
    `hq-plain` holds no hint, no validation message and no `case_preload`, turns Web Apps on, and
    saves the seventeen settings Nova states. Evidence, each read at source ("Executed during
    planning"): Nova writes a formatted copy of every hint until A8; the basic Case Management page
    offers no load; a new app's Web Apps setting is off and a publish that turns it on asks first;
    and a publish seeds fifteen settings an app made in HQ does not hold, until B8. Not done: a
    probe base that holds the four as HQ's pages leave them, because each is a known
    difference owned by a later pull request, and a probe that tripped on all four would answer
    nothing new. Each is asked of a base that lands above its fix: `hq-questions`,
    `hq-case-management`, `hq-new-app` (twice).
15. **An HQ-authored document has one configuration** (2.4). Not done: a second configuration for
    a base (a `maximum` other than its `minimum`, or a `singleFlag` entry), because A is authored
    under one set of flags, and the app HQ's
    pages make under another set is another app, so no second A exists to be made; the one check
    that reads a flag's effect, sensitivity, does not run on the source (Departure 4).
16. **A base is read under a stated declaration where it exists to show a
    change that depends on the choice** (6.1). Part 09's register has three such entries (rows 25
    to 27: two of scope `declaration`, one of scope `birth`), and the declaration is the person's
    choice in the review (the top-level file `../6-bring-in.md`, "What changed from the outline,
    and why", item 5). Three bases state one; every other takes the
    preselected one, which the base's `expected.json` records.
17. **A1 begins `proof/first-publish-changes.json`, and B1's lane reads sit
    outside the observation partition until B13.** Not done: beginning the file in B7, because the
    hold is needed from the first HQ-authored
    document (9.1). Not done: B1's reads in `proof/hq/operations.py` from B1, because inside the
    partition they would make
    every push to B1 fifteen whole lanes for reads only a test module makes (12.1). Part 09
    (section 13.1, B7) and part 05 (section 14.1, B1) say the same.
18. **Three things the lane's own types carry.** A base's
    `expected.json` records the declaration it was read under, so 7.5's rule 2 and 6.4's rules
    read a fact and not an expectation (6.1). `LaneReadInput` carries `appId`, and the lane's one
    target is `LANE_TARGET` (5.2). `mintLaneMediaId` takes a file's media type and multimedia id,
    which is the shape of part 11's `ReserveMediaId`. Not done: `mintLaneMediaId(appId, path)`,
    because one file that two paths name
    is one asset (2.1, 5.2).

---

## Files by pull request

**A1**

- New: `proof/matrix/__init__.py`, `registry.py` (`Base`, `Declaration`, `BASES`), `author.py`,
  `retain.py`, `retained.py` (`Retained`, moved out of `proof/hq/test_retained_reads.py`),
  `seed.py`, `ops.py`, `adopt.py`, `bases/__init__.py`, `bases/plain.py`, `test_retained.py`,
  `test_remade.py`, `test_seed.py`, `test_expectations.py` (the restore rules of 6.4),
  `conftest.py`; `proof/matrix/hand/hq-plain/document.ts`, `edit.ts`, `expectations.json`,
  `restore.xml`; `proof/hq-apps/hq-plain/` (`base.json`, `app.json`, `media.json`,
  `app-source.json`, `seed.json`); `proof/corpus/hqAuthored.ts`;
  `proof/first-publish-changes.json`; `proof/checks/changes.py` (`load`, `declared`,
  `CANDIDATE_IDS`, the `rows` command).
- Changed: `proof/corpus/documents.ts` (`CorpusSource`, `CorpusDocument.hqAuthored`),
  `entryWriter.ts` (`sourceName`, the `authored/` copy, `configurations.json` from `base.json`, the
  expectation expansion and the `restore.xml` copy, the `hq-side.json` refusal), `emitCorpus.ts`,
  `inputs.ts`, `publish.ts` (`hqAuthoredA`), `targetPeer.ts` (`holdSource`);
  `proof/hq/operations.py` (`save_authored_app`); `proof/hq/test_retained_reads.py` (imports
  `Retained`); `proof/observe/publish.py` (`create_authored`, `first_publish_digest`), `unit.py`
  (`create_a`, `input_files`, `restore_for_sessions`, `b_context`, `observe_b_aligned`),
  `intent.py` (`_runs_at`), `casedata.py` (`seeded_case_database`, `document_case_database`);
  `proof/checks/corpus.py` (`Document.exports`, `hq_authored`, `authored`, `case_seed`),
  `configurations.py` (`_content_privileges`), `eligibility.py`, `intent.py` (`saved` from A's
  profile), `proof1.py`, `proof2.py`, `proof3.py`, `registers.py` (the first-publish file among
  what it verifies), `test_corpus.py`, `test_intent.py`, `test_build_files.py`,
  `test_registers.py`; `proof/store/fingerprints.py` (`JUDGE_FILES`); `proof/checks/sharding.py`
  (`SPLIT`); `proof/corpus/__tests__/publish.postgres.test.ts`, `emitCorpus.test.ts`; `biome.json`;
  `proof/README.md`, `proof/CLAUDE.md`, root `CLAUDE.md`.
- Not changed in A1: `proof/checks/observations.py` and `bar.py`, which already judge every state
  of such a document (section 4), and `proof/lane/blocks.py::CORPUS_PACKAGES`, which gains
  `proof/matrix` in B13 (2.3).

**B7 (part 09's pull request), this part's lines.** `proof/checks/changes.py` loses
`CANDIDATE_IDS`; `proof/first-publish-changes.json` is completed as 9.1 says;
`proof/corpus/publish.ts` passes the empty `firstPublish` (2.5). Part 09 lists all three among its
own files, with the file's one Vitest.

**B8 and B9 (parts 10 and 11), this part's lines.** `proof/corpus/publish.ts` in B8, and
`publish.ts` with `targetPeer.ts` in B9, as 2.5 says; each part lists them among its own files.

**B13**

- New: `proof/reader/laneReading.ts`, `retainedPeer.ts`, `laneIds.ts`, `cli.ts`,
  `build.mjs`, `__tests__/notCarried.test.ts`, `__tests__/retainedPeer.test.ts`,
  `__tests__/laneIds.test.ts`; `proof/targeted/documents/saveToCaseShapes.ts`
  (`targeted-save-to-case-shapes`, 6.2) and the G1 case of
  `lib/commcare/reader/caseManagement/__tests__/saveToCase.retained.test.ts` (part 07's file, new
  in B4); `proof/checks/proof6.py`, `test_proof6_fixed_point.py`,
  `test_proof6_controls.py`, `parity.py`, `test_parity.py`, `test_parity_controls.py`,
  `source.py`, `test_source.py`, `test_first_publish_changes.py`,
  `test_first_publish_changes_controls.py`, `readerbundle.py`, `fixtures/source-families.json`;
  `proof/rules/field_list_appearance_case.py` and its test; `proof/matrix/bases/*.py` (one module
  a base of 6.2), `variants/*.py` (one an area), `media.py`, `patch.py`, `schema_samples.json`,
  `exemptions.json`, `fixtures/patch-vectors.json`, `test_classified.py`, `test_media.py`,
  `test_patch.py`; `proof/matrix/hand/<base>/expectations.json` and `restore.xml` for each base
  and `edit.ts` for two; `proof/hq-apps/<base>/` for twenty-one bases and every variant, and
  `application.json`, `current-version.json` and `expected.json` for `hq-plain`;
  `proof/hq/test_privilege_rules.py` (moved); `__tests__/helpers/retainedHqApps.ts` and
  `retainedHqApps.test.ts`; the suites of section 10; `proof/ci/__tests__/readerBundle.test.ts`
  and the `proof-lane.yml` case.
- Changed: `proof/native/produce.py` (`produce_reader`, `produce_all`); `proof/ci/products.mjs`;
  `proof/observe/unit.py` (`api_reads` and its call sites), `sessions.py` (`hq_restore`'s arm),
  `casedata.py` (`served_fixtures`, the seed's `index_identifier`), `publish.py` (`create_authored`'s
  project data, the digest's arm); `proof/formplayer/hq.py` (`create_worker`'s place);
  `proof/hq/operations.py` (`save_authored_tables`, `save_authored_places`, `location_types_read`, and
  part 05's reads moved in from `proof/views/reading_reads.py`, which is removed);
  `proof/hq/test_retained_reads.py` (twelve more files; its imports); `proof/matrix/registry.py`
  (`Variant`, `VARIANTS`), `author.py`, `retain.py`, `seed.py` (`worker.location`), `adopt.py` (the
  reading's part of `--report`), `test_expectations.py`, `test_retained.py`, `conftest.py`
  (`DOCUMENTS`); `proof/checks/differences.py` (`CHECKS`), `registers.py` (`HELD_CHECKS`, the refusal of
  L8), `observations.py` (`OPERATION_CHECKS`), `eligibility.py`, `changes.py` (`differences`,
  `bases_differences`, `declared`'s `inert`, the `bases` command, an entry applying by
  `first-publish.json`), `manifest_usage.py` (`standing`), `manifest_value_classes.py` (thirteen
  readers), `test_manifest_value_classes.py`, `test_manifest.py`, `test_judge_purity.py`,
  `test_record_determinism.py`; `proof/store/keys.py`, `queue.py` (`PACKAGE_DATA`), `pack.py`,
  `test_keys.py`, `test_pack.py`; `proof/lane/blocks.py` (the manifest's `reader`; `CORPUS_PACKAGES`
  gains `proof/matrix`; `SINGLE_GROUPS` and `group_problem` lose `hq-selfchecks`), `test_blocks.py`;
  `proof/checks/sharding.py` (`collection_roots`' docstring); `proof/corpus/documents.ts`
  (`LAYOUT_FILES` gains `first-publish.json`), `hqAuthored.ts` (the read arm, the media assets),
  `emit.ts` (`--with-hq` removed), `entryWriter.ts` (`first-publish.json`, `tables.json`,
  `places.json`); `proof/views/test_exports.py`; `.github/workflows/upstream-pins.yml` (the `retained`
  job), `proof-lane.yml` (`inputs.retained`), `proof/upstream/pins.mjs`,
  `proof/upstream/__tests__/pins.test.ts`; `proof/timings.json`; `proof/README.md`, `proof/CLAUDE.md`,
  root `CLAUDE.md`, `lib/commcare/CLAUDE.md`.
- Removed: `proof/corpus/hq/`, its `conftest.py` with it (section 13).
- Not written here: a canon list under `proof/reader/` with its equal-bytes test, a comparison
  module under `proof/reader/`, a fuzz read back under `lib/commcare/reader/__tests__/`, or a
  second Vitest of the first-publish file. Part 09 owns each one's subject, in
  `lib/commcare/reader/canon.ts` with `canon.test.ts`, `lib/deployment/reading/readBack.ts`,
  `canonReadBack.fuzz.test.ts` and `proof/ci/__tests__/firstPublishChanges.test.ts` (5.2, 5.5,
  9.1).

**Every other pull request**: the lane files section 11 names for it, which its own part plans.

---

## What this part needs of other parts

Each part is cited once by its file. Nothing below waits on an edit to another part: where this
part and another meet, both are written to the same names.

- **Part 01 (01-the-bar-and-the-manifest.md; A2, A3, and the overlay rules of its sections 7.2 and
  7.3, which B8 carries).** `KEPT_AT_HQ[...].base` (its section 5) names three bases of
  6.2, `hq-new-app`, `hq-kept-settings` and `starter-health`, or is null: `KeptRow.base` is `string
  | null`, null exactly for a row whose entry `proof/matrix/exemptions.json` names, which is the
  one row `36-hq-custom-base-url` (no lane configuration can author the value, so no base holds
  it; 7.5, rule 2). Its Run 1 document is `targeted-kept-values`, which stays beside
  `hq-kept-settings` (11.2). Its Run 3 runs inside P2 on `hq-new-app`, judging B8's code. Its four
  `doc_type` entries carry the reason this part's `exemptions.json` quotes. Its two `mirrors` rows
  on `starter-health` need a declaration that includes Android, which part 06's rule gives that
  base (6.1, 6.2) and 7.5's rule 2 holds.
- **Part 02 (02-menus.md; A4, A5).** Nothing beyond what it plans. A1 changes nothing of
  `proof/native/families.py`, so its family `menu-screens` registers as families do today. Its run
  G6 is in A4's own CI, and its outcome B adds the document
  `targeted-forms-in-menu-above-shared-case` (11.1). This part states no `MODEL_CONTEXT_VERSION`
  literal: no lane file is a served tool input, and each pull request that changes one words its
  own (part 15, 15-stack-contracts-and-exit.md, section 1.3).
- **Part 03 (03-questions-and-text.md; A6 to A8).**
  `proof/rules/hint_validation_markdown_form.py` lands in A8 proven, as it says; `hq-questions`
  relies on it, and no base below A8 holds a hint or a validation message (3.1), so nothing of
  that rule is needed earlier. Its run G5 (A6) is the Android reader,
  by hand.
- **Part 04 (04-names.md; A9).** Its N-entries keep the ids of its section 11.2, which 8.2
  and the variants name.
- **Part 05 (05-reading-commcare-hq.md; B1).** `application_read(state, app_id,
  credential)` returns an `HqAnswer`; `readHqAppForReading` and `readHqMediaFile` reach HQ only
  through native `fetch`, so `withRetainedHq`'s dispatcher answers them. Its version read is
  answered from HQ's own retained answer to `operations.current_version_read`, which exists today;
  nothing is made up for it. This part adds `location_types_read` in B13 for the read
  `listHqLocationTypes` makes. Two things it states that this part rests on:
  - B1 lands its new lane reads (`app_list_read`, `application_read`, `api_access_read`,
    `remote_app_through_hq`, `seed_api_superuser` and `client_request`, its section 14.1) in
    `proof/views/reading_reads.py`, and `proof/hq/test_retained_reads.py` imports them from there.
    `proof/hq/` is in the observation partition, so the same functions in
    `proof/hq/operations.py` would move every part key in B1 (12.1). B13 moves them into
    `operations.py` when the observation first calls them.
  - Its Departure 3 and its hand-off to part 14 (B13) are met here: each base that maps media has
    its files read through HQ in the unit (5.3) and brought in by `readHqMediaFile` against the
    retained answers (5.2, P8), which is what holds the map item's address to the pin.
- **Part 06 (06-the-reader-forms.md; B2, B3).** `readHqApp(input, { claims: "full" })`,
  `serializeClaimLog`, `READER_CANONICAL_CHOICES` (each row `{ id, kind, apply }`),
  `ReadDraft.identities`, `ReadDraft.declaration.choices`, `ReadFacts`, `ReaderOrganization` as
  `{ levelCodes, levels }` (its section 2.2), `ReaderInput.recordDialect` (from B6) and the
  proposal rule of its section 16.3. This part asks nothing more of it: a
  `READER_CANONICAL_CHOICES` row carries no example documents, since part 09's
  `canon.test.ts` builds each pair from production builders. Its runs R1 (B3's own CI) and R2 (by
  hand through `reader-scale.yml`) are listed in 11.2.
- **Part 07 (07-the-reader-cases-menus-lists.md; B4, B5).** Its canonical choices are
  five rows of `READER_CANONICAL_CHOICES` under the ids part 09 names: `registration-form-last`,
  `create-name-required-is-absent` and `default-post-submit-is-absent` in B4, `dormant-tile-cells`
  and `case-catalog-is-as-read` in B5. `ReadFacts.sameStateRewrites[].register` holds a
  `FIRST_PUBLISH_CHANGES` id. Its G3 runs inside P2, as a `mechanics` dispatch. Its G1 reads this
  part's base `hq-nova-then-builder` through `retainedBase` in B13's own CI: the base, the
  document `targeted-save-to-case-shapes` and the test's G1 case land in B13, and the test's two
  `targeted-migration-*` cases in B4 (6.2, 11.2).
- **Part 08 (08-the-reader-expressions.md; B6).** `PRINT_COLLISIONS`,
  `canonicalExpression`, `EMISSION_REWRITE_IDS` with each id's `behavior`, and
  `lib/agent/authoring/recordRoundTrip.ts::recordDialectRoundTrip`. What it asks of this part is
  base content of `hq-expressions`, `hq-search` and `hq-case-lists` (6.2), each shown by its
  register entry, since a variant never publishes and a rewrite is shown only by a publish (9.4);
  its two variants are the search row with fixed quotes on `hq-search` and `#host/p` in a case list
  filter on `hq-case-lists` (7.2). Its run E6, outcome B, is P2's outcome D: stack B does not
  merge with a record expression the checker refuses, B6 widens the record rule set to it with the
  starter as the exhibit, and a base's `expected.json` stays `reads: true` (6.1).
- **Part 09 (09-acceptance-and-the-first-publish.md; B7).** Used as written:
  `lib/commcare/reader/canon.ts::CANONICALIZATIONS` and `canonDocument`;
  `lib/deployment/reading/readBack.ts::readBackDifferences`, `ReadBack` and `ReadBackDifference`
  (its section 9.1); `lib/deployment/reading/acceptance.ts::acceptReading`, `AcceptedReading`,
  `AcceptedDeclaration` (`mutations`, `firstPublish`, `preselected`);
  `lib/publish/firstPublishChangeIds.ts::FIRST_PUBLISH_CHANGE_IDS`; `EMISSION_REWRITES` with each
  id's `declaredBy` (its section 10);
  `lib/deployment/reading/signature.ts::documentDifferences`; `lib/commcare/appStrings.ts::
  localAppStringTable`; the file's one Vitest `proof/ci/__tests__/firstPublishChanges.test.ts`,
  and the judge's four holds (its 13.4). Its needs of this part are each met: the judge and the
  `source` comparison (9.3), `eligibility.py`'s rows (section 4), the bundle's `firstPublish.ids`
  under the base's declaration and the claim log in `full` mode (5.2, 9.3), `canonDocument` and
  `readBackDifferences` in proof 6 (5.2, 5.5), K2, K3 and K4 on hosted runners (the runs' list),
  a base for every entry (9.4), and a value expectation pair for every `changes` entry (6.4).
  Its sections 13.1 to 13.3 say what this part's section 9 says
  (A1 begins the file under part 09's ids, B7 completes it and deletes `CANDIDATE_IDS`, and a form
  id is compared as the position it names). Its B7 passes the empty `firstPublish` in
  `proof/corpus/publish.ts` (2.5). One thing stays contingent on a run: an id a P1 or P2 outcome C1
  adds that the register lacks becomes a part 09 entry in B7, as its run K3, outcome B, words it.
- **Part 10 (10-identity-and-the-ledger.md; B8).** `mintingResolver`, `matchingResolver`,
  `externalIdentityMap`, `adoptedIdentityRows`, `adoptedAppBaselineWrite`,
  `KINDS_WITH_NO_EXTERNAL_KEY` (its section 2.2), `ResolveManifestOptions.heldPaths`. B8 changes
  `proof/corpus/publish.ts`'s `hqAuthoredA` arm in its own pull request, as its section 6.3 and
  its "Files by pull request" say (2.5): from B8 the capture passes `"target"` for
  `languageNames` and `seeds` on an HQ-authored A, and `"nova"` on every other document. Its G2
  runs on `hq-media` inside P2.
- **Part 11 (11-project-data.md; B9).** Its section 14 is the surface: the lane's first
  reading gathers what `readReadingProjectData` gathers, by its steps (5.2), and so calls
  `readHqLookupTablesForReading`, `lookupTableFindings`, `lookupTableStanding`,
  `resolveLookupBindings`, `validateSniffedMediaBytes` and the types `PredeclaredLookupIds`,
  `ReadingProjectData`, `ReadingMediaPlan` and `ReserveMediaId`. Each of those functions is pure
  or reads CommCare HQ alone; the function's step 3 reads Postgres, which the lane answers as an
  empty Project. `runReadingCheck` builds `ReaderOrganization` as `{ levelCodes, levels }` (part
  06, 2.2), and `levelsFromHq` and `worldEntitiesFromReads` are the reader's own calls
  (`lib/commcare/reader/worldEntities.ts`), so this part calls neither. Its variants are the two
  7.2 names, each a finding a source alone can exhibit; the field-property and
  row-attribute findings are no variants and are exempt, with its own Vitest named as their
  evidence (7.2, 7.5). B9
  changes the capture for managed tables in its own pull request (2.5).
- **Part 12 (12-the-reading-and-the-birth.md; B10).**
  `lib/deployment/reading/check.ts::runReadingCheck`, `ReadingCheckInput` and `ReadingCheck`, as
  its section 3.6 describes them: one pure function of plain data, importable with no database
  and no worker thread around it, which `readForLane` calls in process (5.2). Two members carry
  the claims mode: `ReadingCheckInput.claims` (`"counts" | "full"`, which the lane sets from
  `LaneReadInput.claims`) and `ReadingCheck.claims` (`{ counts, handOffs, log }`, whose `log` is
  `serializeClaimLog`'s text under `full` and null under `counts`). `proof/hq-reads/reading/` is
  not renamed.
- **Part 13 (13-the-experience.md; B11, B12).** No screen and no tool is proven here, and
  its Playwright specs are its own. Its run E1 is stack B's one billed schema check, asked once at
  B12's head (11.2).
- **Part 15 (15-stack-contracts-and-exit.md; A10, A11, B14, B15, the stacks).** A1 sits at the bottom of
  stack A and B13 above B10 (it calls B1's operations, B2 to B6's reader, B7's acceptance, canon and
  read-back comparison, B8's identity functions, B9's project data functions and B10's `runReadingCheck`;
  it calls nothing of B11 or B12). Stack B merges no sooner than the first green night after stack A, and
  no weekday or window is set for either merge (12.2). The stack checklists carry P1 (before A1 merges;
  P7 is A1's own CI), P2 and P4 by hand and P3, P5, P6 and P8 in B13's own CI (all before stack B
  merges), and the asks of 12.4. A10's billed schema check is asked once by part 15 (11.1). B14 lands
  `docs/plans/hq-round-trip/README.md`'s "proofs 1 to 6". B15 removes nothing of this part: every file it
  adds endures.

## What other parts read from this one

| Name | Where | Read by |
|---|---|---|
| the source `hq-authored`, `HqAuthoredFacts` (`identity`, `source`, `firstPublish`, `declaration`, `mediaPaths`), `PublishInput.hqAuthoredA`, `TargetPeer.holdSource` | `proof/corpus/` | B8, B9 (their capture changes) |
| `proof/hq-apps/<base>/` and its file names (`base.json`, `app.json`, `media.json`, `tables.json`, `places.json`, `app-source.json`, `application.json`, `current-version.json`, `media-reads.json`, the lookup and location answers, `seed.json`, `expected.json`, `variants/`); `proof/matrix/hand/<base>/` (`expectations.json`, `restore.xml`, `edit.ts`, `document.ts`) | section 2.2 | every reader part's Vitest from B13; part 01 (`KEPT_AT_HQ.base`) |
| the base ids of 6.2 | section 6.2 | parts 01, 03, 04, 06, 07, 08, 09, 10, 11 |
| `Base`, `Declaration`, `Variant`, `BASES`, `VARIANTS`, `ops.set_json`, `ops.set_form_source`, `ops.builder_save`; `python3 -m proof.matrix.adopt` | `proof/matrix/` | whoever adds an entry after step 6; any pull request that changes a reading |
| `operations.save_authored_app`, `save_authored_tables`, `save_authored_places`, `location_types_read` | `proof/hq/operations.py` | the lane |
| `Retained` | `proof/matrix/retained.py` | part 05 (its `reading/` group uses it, through `proof/hq/test_retained_reads.py`) |
| `proof/views/reading_reads.py` as the home of part 05's new reads from B1 until B13 | 11.2, 12.1 | part 05 (B1) |
| `seeded_case_database`, `served_fixtures`, `Document.hq_authored`, `Document.authored`, `Document.case_seed` | `proof/observe/casedata.py`, `proof/checks/corpus.py` | the lane |
| `eligibility.hq_authored`, `HQ_AUTHORED_UNRUN`, `HQ_AUTHORED_ONLY`, `form_xml_unjudged` | `proof/checks/eligibility.py` | the lane; part 09 (its row for the source) |
| the checks `proof6`, `parity`, `source`, `changes` | `proof/checks/` | part 09 (the judge it specifies); part 15 (the contracts) |
| `readForLane`, `LaneReadInput`, `LaneReading`, `withRetainedHq`, `RetainedHqPeer`, `LANE_TARGET`, `mintLaneLookupIds`, `mintLaneMediaId` | `proof/reader/` | step 7's first group (`changes-made-in-hq`: the drift merge's lane) |
| `RetainedHqAnswer`, `RetainedHqApp`, `readRetainedHqApp`, `hqAuthoredDocuments`, `HQ_APPS` | `proof/corpus/hqAuthored.ts` | `proof/reader/` and `__tests__/helpers/retainedHqApps.ts` (the types); the emission |
| `native/reader/reader.mjs`, `reader.json`; `keys.reader_digest`, `keys.judged_under`; the `reader` kind of `PACKAGE_DATA` | the corpus; `proof/store/keys.py`, `queue.py` | the lane |
| `proof/first-publish-changes.json`, its shape (9.1) and the file as A1 begins it; `changes.Change`, `Row`, `load`, `declared`, `differences`, `bases_differences`, `CANDIDATE_IDS` (until B7), the `rows` and `bases` commands; `first-publish.json` in a base's document directory | `proof/`, `proof/checks/changes.py` | part 09 (B7 completes the file, deletes `CANDIDATE_IDS` and writes the file's one Vitest) |
| `proof/matrix/schema_samples.json`, `exemptions.json` and its five reasons in their order | `proof/matrix/` | parts 01 and 11 (their exempt entries; part 01's `KeptRow.base: null`) |
| `retainedBase`, `retainedVariants`, `RetainedHqVariant`, `VariantPatchOp`, `applyVariantPatch`, `laneInputOf`, `RETAINED_BASES` | `__tests__/helpers/retainedHqApps.ts` | reader parts' suites from B13; part 07 (its G1 case reads `hq-nova-then-builder` through `retainedBase`) |
| the base `hq-nova-then-builder`, the document `targeted-save-to-case-shapes` and, on G1's outcome C, the variant `hq-nova-then-builder/save-to-case-saved` | 6.2, 7.2, P2 | part 07 (G1) |
| the thirteen HELD-NEW readers and `standing`'s new step | `proof/checks/manifest_value_classes.py`, `manifest_usage.py` | parts 01, 04, 06, 07 |
| the seam "a starter app's media files are the lane's own"; `media.stand_in` | `proof/CLAUDE.md`, `proof/matrix/media.py` | part 11 (`hq-media`) |
| gated runs P1 to P8 | "Written and not yet run" | part 15's checklists |
| `targeted-kept-values`, which stays after B13 | A3 | part 01 (Run 1) |
