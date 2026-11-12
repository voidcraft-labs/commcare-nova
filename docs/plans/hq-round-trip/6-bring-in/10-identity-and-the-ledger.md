# Step 6, part 10: Identity and the ledger

This part plans what makes an app brought in from CommCare HQ the same app on both sides: the one
`IdentityResolver` and the external key of every entity a reading mints; the adopted deployment's
identity rows and media paths; the claim that lets one Nova app manage one HQ app; the ledger an
adoption is born with and the writers that record it inside the birth's transaction; what a publish
over an adopted deployment does; ending a deployment ("Stop publishing here"); the drift wording by
where a baseline came from; and the identity map step 7's first group (`changes-made-in-hq`) reads. It
plans pull request B8 in full, and one file of B2 (`lib/commcare/reader/identity.ts`, which every
reader module of B3 to B6 mints through). Pull requests are named by their ids in the two stacks
(A1 to A11, B1 to B15; the top-level file `../6-bring-in.md`, "Work items"). Another part is cited as
"part NN (file name), section N" with its pull request, and a pull request id that stands alone names
the part that plans it:

| Part | File | Pull requests |
|---|---|---|
| 01 | `01-the-bar-and-the-manifest.md` | A2, A3, the manifest and copy lines of B1 to B10 |
| 04 | `04-names.md` | A9 |
| 05 | `05-reading-commcare-hq.md` | B1 |
| 06 | `06-the-reader-forms.md` | B2, B3 |
| 07 | `07-the-reader-cases-menus-lists.md` | B4, B5 |
| 08 | `08-the-reader-expressions.md` | B6 |
| 09 | `09-acceptance-and-the-first-publish.md` | B7 |
| 11 | `11-project-data.md` | B9 |
| 12 | `12-the-reading-and-the-birth.md` | B10 |
| 13 | `13-the-experience.md` | B11, B12 |
| 14 | `14-proof.md` | A1, B13 |
| 15 | `15-stack-contracts-and-exit.md` | A10, A11, B14, B15, the step 7 rewrite |

Stack B's order is B1, B2, B3, B4, B5, B6, B8, B9, B7, B10, B11, B12, B13, B14, B15 (part 09,
Departure 14): B7 lands above B8, so a line that says "B7 adds" names a later pull request.

Citations are `path::symbol`: Nova at `main` `15a00a97`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`.
Every CommCare fact below was read at `d6c6e16d8ae1` for this part; HQ paths are under `corehq/apps/`.

Versions at `15a00a97`: `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.14"`
and `lib/db/appTests.ts::RUNTIME_VERSION` is `18`; A9 moves the second to `19` (part 04
(`04-names.md`), section 3.4). Nothing in this part moves either: no tool the Solutions Architect
holds changes (`lib/deployment/CLAUDE.md`, "Surfaces"), so B8 adds no `scripts/test-schema.ts` entry
and asks for no billed run. The two served enums B8 widens (`ended` on the deployment tools' state,
`publishing_stopped` on `upload_app_to_hq`'s error tags) belong to tools only MCP serves, and
`lib/agent/CLAUDE.md` exempts them ("A tool only MCP serves is in no stored model context and does
not move it"), so no `v7-hq-round-trip-bring-in.b8` literal is written: stack B moves the value in
B6, B9 and B12 alone. B8 adds no route, so `lib/hostnames.ts` is untouched: the one new browser call
is a Server Action in `lib/deployment/actions.ts`, and the body of
`app/api/commcare/upload/route.ts` gains one optional field (9.1).

| Section | Owns | Pull request |
|---|---|---|
| 2 | the `IdentityResolver`, the namespace, the key table for every entity kind, UUID-version fit | B2 (`identity.ts` and its test), B8 (the map projection and parity) |
| 3 | `app_deployment_identities` for an adopted deployment: dense rows, writers, the privilege move | B8 |
| 4 | `app_deployment_media_paths`: DDL, reader, the manifest and the `.ccz` media suite | B8 |
| 5 | the claim: columns, trigger, index, release, concurrent bring-ins, what the picker reads | B8 |
| 6 | the adopted ledger at birth, column by column, and the transaction-taking writers | B8 (B10 calls them) |
| 7 | publish over an adopted deployment | B8 |
| 8 | ending a deployment: state, transaction, who may, every reader, the publish fence | B8 |
| 9 | drift wording by baseline origin | B8 |
| 10 | the baseline identity map step 7 reads, and that step 6 stores it | B8 |
| 11 | the one ledgered migration, statement by statement | B8 |

---

## Decisions in brief

1. **Every entity UUID a reading mints is UUIDv5 over one fixed namespace, with the app's id and the
   entity's external key in the name** (2.1). The key is a function of the entity as Nova holds it,
   minus its UUID, and of its owner's key, so the reader and a projection of any Nova document compute
   the same key from the same content.
2. **Twelve of the document's twenty-one identity kinds have an external key; nine have none, because
   CommCare HQ's app holds nothing of them** (2.2). A binding test holds the split to
   `lib/domain/authoredIdentities.ts::BLUEPRINT_AUTHORED_IDENTITY_KINDS`.
3. **A form's key is its `xmlns`; a question's is its form's `xmlns` and its authored path** (2.2),
   read with `lib/domain/expression/formStructure.ts::formFieldPath`, which leaves out the nodes Nova
   generates.
4. **A key met twice is never minted twice** (2.3): the resolver answers the second claim with the
   first one's place, and the reader's frame reports it as `unrecognized` where no reader module named
   it first.
5. **An adopted deployment's identity rows are dense: one row per menu and per form the reading holds,
   written once, in the birth's transaction** (3). Rows are immutable; `app_deployment_identities`
   and the new `app_deployment_media_paths` are runtime insert-and-delete. No DDL changes the
   identities table.
6. **A media file's HQ path is a row of `app_deployment_media_paths`**, one path per asset per
   deployment (4), in any directory under `jr://file/`. A file HQ holds under several paths keeps the
   first in code-unit order. Three kinds of path are not held, and the file takes Nova's own path as a
   declared first-publish change (Departure 6): one in Nova's derived shape that is not that file's own
   derivation, one that only letter case tells from another file's, and one CommCare HQ's upload
   cannot address. `resolveMediaManifest` takes the target's rows, and the `.ccz` media suite writes
   each file's own directory.
7. **One HQ app is managed by one Nova app, by a partial unique index** over
   `app_deployment_resources (server, domain, remote_id)` for live, unreleased `app` mappings (5).
   `server` and `domain` reach the mapping row through a `BEFORE INSERT` trigger and a composite
   foreign key, so no writer sets them.
8. **An app in recently deleted gives its HQ app up when another app takes it, not when it is deleted**
   (5.3, Departure 1). To a person the two are the same: while the holder is deleted, the HQ app is
   free to bring in. `lib/db/apps.ts::softDeleteApp` does not change.
9. **Restoring an app takes each given-up HQ app back unless a live Nova app holds it, and ends that
   deployment where one does** (5.4), saying which project spaces it stopped publishing to. A holder
   that is itself in recently deleted gives the HQ app up in turn, so of two deleted apps the first
   one restored publishes there.
10. **An adopted deployment is born `uploaded`, with every phase outcome null, an `adopted` app mapping
    at `pushed_revision` 1, a `read` baseline and no entry-point manifest** (6). One writer,
    `lib/deployment/store.ts::recordAdoptedDeploymentInTransaction`, records all of it in the birth's
    transaction.
11. **A `read` baseline is compared exactly as a `push` baseline is**, under the ownership descriptor
    `lib/deployment/importApplication.ts::hqImportApplication` gives for the document over that read,
    with the Search advisory taken as unverified (6.3).
12. **At adoption Nova records a plan-feature confirmation for each feature the app's source already
    uses** (6.5): every feature the document needs when nothing is pushed, except Web Apps where HQ
    holds the setting off and Save to Case where the source holds no Save to Case block.
13. **A publish keeps the ownership of the mapping it updates** (7): `publishAppToHq` stops writing
    `nova-created` over an adopted app.
14. **A deployment can be ended** (8): a new state `ended`, reached by one transaction that supersedes
    the live `app` mapping with who ended it and why, deletes the deployment's identity and media-path
    rows, clears what described the HQ app, and counts the ending. An admin or owner of the app's
    Project may do it; an editor is told who can (`not_permitted`, 8.3).
15. **A publish belongs to the deployment as it stood when the publish read it** (8.5): every store
    write of a publish carries the count of endings it read, and an ending in between refuses every
    later write of that publish with `publishing_stopped`.
16. **Every reader of a deployment already asks for a live `app` mapping or a reached state, so an
    ended deployment reads as not published there** (8.6). Check status and worker provisioning say
    that publishing stopped, and whether a deployment is ended for the card and the dialog is read
    from its mappings, so a publish that stops before it makes the new app still shows the ending.
17. **Drift copy names what the comparison is against** (9): a typed `DriftReference`, `published` or
    `brought-in` with its time, on every app change and on the Web Apps question. Each brought-in
    sentence says the day, "since Nova brought it in on 10 November 2026", in the reader's own time
    zone. Four more sentences that said Nova made or published the app are reworded.
18. **Every baseline written from step 6 stores the identity map of the document it describes** (10):
    external key to Nova UUID, gzip beside the source, bound to that source's digest. Step 6 writes it
    and reads it only in tests; step 7's first group (`changes-made-in-hq`) is its first production
    reader.
19. **One ledgered migration, `20261201000000_hq_bring_in_ledger`** (11), additive in effect: every
    statement the previous revision runs still passes. It waits at most five seconds for a lock and
    replays over its own result. It also holds part 09's column
    `app_deployment_baselines.first_publish_changes` with its CHECK (part 09
    (`09-acceptance-and-the-first-publish.md`), section 12.3): nullable, read and written by nothing
    in B8.

---

## Executed during planning

Read in full at `15a00a97`:

- **`lib/deployment`**: `CLAUDE.md`; `store.ts` (`lockAppForDeploymentWrite`, `toDeploymentRecord`,
  `toDeploymentResource`, `loadResources`, `readDeployment`, `readDeploymentPreviewRecords`,
  `readDeploymentIdentityOverrides`, `readReachedDeploymentTargets`, `withDeploymentRow`,
  `foldDeploymentAttempt`, `withdrawDeploymentConfirmation`, `recordRemoteResource`,
  `recordCreatedRemoteApp`, `writeAppBaseline`, `writeResourceBaselines`, `readAppBaseline`,
  `writeResourceMapping`, `recordPushedResources`, `applyDeploymentObservation`,
  `beginDeploymentContentWrite`, `finishDeploymentContentWrite`, `recordEntryPointObservation`,
  `markResourceBaselinesUnread`, `readEntryPointEvidence`);
  `service.ts` (`publishAppToHq`, `remoteAppGoneOutcome`, `preflightRefusal`, `appBaselineFor`,
  `fillSource`, `refreshDeployment`); `preflight.ts` (the `target-app`, `hq-changes` and `web-apps`
  edges, `appRemoteChange`, `publishConfirmationNeeds`, `hqAppSourceReadFailure`,
  `remoteAppMissingFailure`); `resources.ts`; `hqSourceBaseline.ts`; `confirmations.ts`;
  `remoteChanges.ts`; `webApps.ts`; `stateMachine.ts`; `types.ts`; `importApplication.ts`;
  `downloadTarget.ts`; `runtimeTarget.ts::chooseDownloadTarget`; `previewSpace.ts`; `previewTarget.ts`;
  `attachmentTarget.ts`; `entryPointLinks.ts::getEntryPointLink`; `workers.ts::provisionWorkers`;
  `actions.ts`.
- **`lib/commcare`**: `wireIdentity.ts`; `emissionPlan.ts` (`syntheticModuleUuid`, `emissionPlan`);
  `expander.ts::expandDoc` (its identity reads); `targetOverlay.ts` (`projectApplicationForTarget`,
  `projectProfileForTarget`, `ownedProfilePart`, `shellOwnership`); `placement.ts` (`planPlacements`,
  `PlannedPlacement`); `planPrivileges.ts::requiredPlanPrivileges`; `multimedia/assetWirePath.ts`,
  `mediaSuiteXml.ts`, `bundle.ts`, `bulkUploadZip.ts`; the entries
  `forms-and-case-writes/xmlns-form-json-and-xform-data-node`, `forms-and-case-writes/unique-id`,
  `forms-and-case-writes/two-non-shadow-forms-sharing-an-xmlns`,
  `menus-and-case-lists/modulebase-unique-id`, `menus-and-case-lists/module-unique-id-missing`,
  `expressions-and-data/media-path-jr-file` and `application-and-settings/multimedia-map` of
  `surface/entries/`.
- **`lib/db`**: `CLAUDE.md`; `privilegeConvergence.ts` (the five capability sets,
  `EXPECTED_PUBLIC_ROUTINES`, `RUNTIME_TABLES_WITHOUT_ROW_LOCKS`); `apps.ts` (`softDeleteApp`,
  `restoreApp`, `commitAppProjectMoveInTransaction`, `copyPlaceBaselinesToProject`); `pg.ts` (the
  deployment table types); the migrations `20260806000000_deployments`,
  `20260818010000_deployment_resource_push`, `20260906000000_deployment_push_tokens`,
  `20261015020000_hq_round_trip_deployment_ledger`,
  `20261101000000_hq_round_trip_platforms_web_apps_read` and
  `20261110010000_hq_round_trip_case_writes_commtrack_confirmation`.
- **`lib/domain`**: `uuid.ts`; `lookupIds.ts`; `authoredIdentities.ts`; `placements.ts`; `prose.ts`;
  `connectIds.ts`; `entryPoints.ts`; the `uuid` slots of `forms.ts`, `modules.ts`, `users.ts`,
  `organization.ts`, `automations.ts` and `fields/`; `datetimeSplitIdentity.ts` and
  `caseOperationIdentity.ts` (the two UUIDv5 derivations Nova already has);
  `expression/formStructure.ts::formFieldPath`.
- **`lib/media` and `lib/export`**: `manifest.ts` (`resolveMediaManifest`, `assetWirePaths`);
  `boundaryValidation.ts` (`ExportBoundaryReads`, `prepareExportBoundary`); its three callers.
- **CommCare HQ**: `app_manager/models/applications.py` (`Application.export_json`, `scrub_source`,
  `copy_form`, `set_media_versions`, `_merge_source_into_app`, `overwrite_app_from_source`,
  `ApplicationBase._update_excluded_fields`); `app_manager/util.py` (`update_form_unique_ids`,
  `save_xform`, `generate_xmlns`); `app_manager/models/forms.py::FormSource.__set__`;
  `app_manager/models/modules.py::ModuleBase.get_or_create_unique_id`;
  `app_manager/models/base.py::FormIdProperty`;
  `app_manager/helpers/validators.py::ApplicationValidator._check_forms`;
  `api/resources/v0_4.py::ApplicationResource.dehydrate_module`;
  `app_manager/suite_xml/generator.py::MediaSuiteGenerator.media_resources`;
  `hqmedia/models.py` (`remove_unused_mappings`, `create_mapping`, `HQMediaMapItem`,
  `CommCareMultimedia.attach_data`, `get_form_path`); `hqmedia/tasks.py::process_bulk_upload_zip`;
  `app_manager/views/releases.py::current_app_version`.
- **The plan and what it replaces**: the plans `README.md`; the outline; parts 02 and 05 in full; of
  part 01, its circumstance list (8.3), `TargetFacts` and its readers (6), the language display name
  rule (7.2) and what it hands to B8; parts 03 and 04, searched for identity, for the resolver and
  for B8.
- **Also read in Nova and in CommCare HQ**: `biome.json` (the `lib/commcare` import boundary and
  its allowlist); `lib/deployment/errors.ts`, `observe.ts::observeDeployment` (its gone outcome) and
  `actions.ts` (`resolveScope`, `failure`, `DeploymentActionResult`); `lib/mcp/errors.ts` and
  `lib/apiError.ts` (their `DeploymentError` arms); `lib/db/canonicalCommitKernel.ts` (`lockAppRow`,
  `assertAppCapabilityInTransaction`), `appGenesis.ts::writePreparedGenesisInTransaction` and
  `mediaAssets.ts::findReadyAssetByProjectAndHash`; the migrations
  `20260728000000_canonical_identity_foundation` (which makes `media_assets.id` a `uuid`) and
  `20261112000000_incremental_transcripts` (its lock timeout); `lib/domain/modules.ts::
  caseListConfigSchema`; `lib/publish/planFeatures.ts::PLAN_FEATURES`;
  `lib/notices/migrationNoticeCopy.ts` (`NoticeDateOptions`, `formatNoticeDay`);
  `app/api/commcare/upload/route.ts`; `components/builder/PublishDialogBody.tsx` and
  `publishOutcome.ts`; `e2e/tests/browser/publishing.spec.ts`; `content/docs/publishing.mdx`; and in
  CommCare HQ `hqmedia/tasks.py::process_bulk_upload_zip`, `hqmedia/models.py::
  CommCareMultimedia.get_form_path` and `app_manager/util.py::split_path`.
- **The other parts, at the passages this part cites or is cited from**: part 01, sections 3.3,
  6.5, 7.2, 7.3, 8.1, 8.3 and 9.3 and its needs of this part; part 04, its row 20; part 05,
  sections 4.3, 8.3, 11 and 14.1 and its needs of this
  part; part 06, sections 2.1, 2.2, 2.4, 4.4 and 7.2; part 07,
  sections 6.1 and 8.7; part 09, sections 2.2, 5.4, 11.1, 11.2 and 12.3, its "Copy" and its
  "Contracts"; part 11, sections 2.1, 4.1 and 4.4 and its run table; part 12, sections 3.3, 6.2, 6.3
  and 6.5; part 13, sections 4.3, 8.8, 11.1, 11.4, 14.5 and 14.7; part 14, sections 2.5, 6.2 and
  11.2. In Nova: `lib/agent/CLAUDE.md` (what moves `MODEL_CONTEXT_VERSION`);
  `lib/deployment/store.ts::markResourceBaselinesUnread` and `readEntryPointEvidence`;
  `lib/deployment/types.ts` (`DEPLOYMENT_PHASES`, `NO_DEPLOYMENT_PHASE_OUTCOMES`,
  `DeploymentRemoteChange`, `AppBaselineWrite`); `lib/deployment/resources.ts::NextPublishAction`;
  `lib/publish/planFeatures.ts` (`namesInWords`) and `lib/publish/webApps.ts::webAppsChangeMessage`;
  `lib/db/pg.ts::AppDeploymentBaselinesTable`; `app/(app)/(site)/app-actions.ts::RestoreAppResult`.

Run: four golden UUIDv5 values for 2.1, computed with Python's `uuid.uuid5` over the namespace and the
name text this part fixes. The unit test of 2.6 holds the `uuid` package to them.

Facts verified at source that this part leans on, and claims of the outline found false there:

- **Verified (the target columns):** `app_deployments` holds one `target_*` column,
  `target_empty_case_list_text` (`lib/db/pg.ts::AppDeploymentsTable`). Step 4 dropped
  `target_web_apps_enabled` (`20261101000000_hq_round_trip_platforms_web_apps_read`). Departure 2.
- **Verified (what a publish over held media paths leaves in CommCare HQ):** `multimedia_map` is not
  byte-equal after it. `hqmedia/models.py::CommCareMultimedia.attach_data` returns `True` on every
  call, so `hqmedia/tasks.py::process_bulk_upload_zip` calls
  `hqmedia/models.py::ApplicationMediaMixin.create_mapping` for every matched path, and
  `create_mapping` builds a fresh `HQMediaMapItem` with no `version` and no `upstream_media_id`. What
  holds is the set of paths, each path's `multimedia_id` and its `unique_id`
  (`HQMediaMapItem.gen_unique_id` is a hash of the id and the path). A phone keeps its copy because
  `app_manager/models/applications.py::Application.set_media_versions` gives a path the previous
  build's version where the `multimedia_id` is the same. Run G2 holds it.
- **Verified (a question's key is its authored path, not the wire's data path):** the wire's data
  path includes the nodes Nova generates (a count placement's wrapper group, the operations node).
  The key is the authored path, which `formFieldPath` documents as "Logical authored paths omit
  generated query-row structure".
- **Verified (a form's `xmlns` is not unique in a working app):** HQ's build refuses a duplicate
  `xmlns`; the working app can hold it (`_check_forms` runs at build, and `save_xform` rewrites a
  clashing `xmlns` only on a save of that form's source). The reader therefore claims
  `forms-and-case-writes/two-non-shadow-forms-sharing-an-xmlns` before it mints, and the resolver's
  duplicate answer is the floor under it.
- **Verified (no delete or restore can keep a ledger column during a deploy):** the migrate Job
  runs while the previous revision serves (`lib/case-store/CLAUDE.md`), and that revision's
  `lib/db/apps.ts::softDeleteApp` and `restoreApp` write no ledger column, so a `released_at` kept by
  those two functions would be stale from the first minute. Departure 1.
- **Claim corrected (the outline, item 2):** an adoption "writes the ids its target holds that
  differ from Nova's derivation". Every one differs: a Nova UUID is minted from the app's id and the
  key, and HQ's ids are HQ's. The rows are dense.
- **Claim corrected (the outline, item 10):** ending a deployment "decides which deployments stop
  counting as published for placements". No runtime code reads a deployment to judge a placement: no
  file of `lib/doc`, `lib/db/placementAuthority.ts` or `lib/db/placementRecords.ts` imports
  `lib/deployment`. Ending changes no hold (8.6).
- **Verified (every reader of a baseline's origin):** `store.ts::readAppBaseline` throws on an origin
  it does not know, and it is not the only reader: `webApps.ts::webAppsChange` (its `create`
  test and its `push | cutover` test for `changedInHq`), `service.ts::publishAppToHq` (the
  `appPreviewNote` test, and the `unread` and `create` tests that set `heldOwnership` and `shell`)
  and `preflight.ts` (`appRemoteChange`'s `unread` and `create` tests, and the `web-apps` edge's
  `create` test for its passed detail) each name origins. Three change (`readAppBaseline`, the
  `appPreviewNote` test, `webAppsChange`'s `changedInHq`); every `create` and `unread` test already
  treats `read` as it treats `push` (6.3).
- **Verified (which paths CommCare HQ's upload can address):** HQ's bulk upload matches a zip entry
  to an app path with both lower-cased and the entry stripped (`process_bulk_upload_zip`:
  `get_form_path(path, lowercase=True)` against `app_paths_lower`, the first match winning), so two
  paths that differ only by letter case receive one file, and a path with a space at either end is
  never matched. Such a path cannot be kept. Departure 6.
- **Verified (a publish writes `nova-created` over any app mapping today):**
  `service.ts::publishAppToHq` passes the literal `ownership: "nova-created"` to
  `recordRemoteResource`, and `store.ts::writeResourceMapping`'s conflict arm nulls `adopted_at` and
  `adopted_by` when the incoming ownership is not `adopted`. Section 7.1 changes the first.

---

## Written and not yet run

**G1. The duplicate-claim scan.** Where: production Cloud SQL, read-only, as the person's gcloud IAM
identity, by `scripts/scan-hq-app-claims.ts --prod` (new in B8, removed in B15), run by the person
before B8 merges. It asks one question of the schema as it stands before the migration:

```sql
SELECT d.server, d.domain, r.remote_id,
       count(*) FILTER (WHERE a.deleted_at IS NULL) AS live_apps,
       count(*) FILTER (WHERE a.deleted_at IS NOT NULL) AS deleted_apps
FROM app_deployment_resources r
JOIN app_deployments d ON d.id = r.deployment_id
JOIN apps a ON a.id = d.app_id
WHERE r.kind = 'app' AND r.superseded_at IS NULL
GROUP BY d.server, d.domain, r.remote_id
HAVING count(*) > 1;
```

It prints two numbers and nothing else: groups whose `live_apps` is 2 or more, and groups whose
`live_apps` is 1 or 0. With `--list` it prints each group's app ids to the terminal for the person who
ran it; nothing of the output is committed.

- **Outcome A: no group has two live apps.** B8 merges as written. The migration's statement 7
  releases each deleted member of a group that has a live or another deleted member, and its index
  builds.
- **Outcome B: some group has two or more live apps.** B8 does not merge. No product path makes this
  state (every `app` mapping today was written from HQ's answer to that app's own create), so each
  group is a hand-made or recovered row. For each group the person chooses the app that keeps
  publishing there, and every other app of the group is moved to recently deleted in the product by
  someone who may delete it. The scan runs again until outcome A. After the deploy, restoring one of
  those apps brings it back with that deployment ended (5.4). No code beyond this part's lands for
  outcome B, and the migration's guard (statement 8) refuses the deploy if a group is still there.

**G2. Held media paths over a published HQ app.** Where: the proof lane on hosted runners, on the
HQ-authored base `hq-media` (part 14 (`14-proof.md`), section 6.2, B13), inside part 14's P2
dispatch on B13's branch, as part of that base's A-to-B hop. The run reads `multimedia_map`
before the first publish and after it, makes a build of each, and compares the media suite's
resources.

- **Outcome A: the paths, each path's `multimedia_id` and `unique_id` are equal, and the second
  build's resource versions equal the first's.** Nothing lands beyond this part.
- **Outcome B: a resource's version rises, so a phone downloads a file it holds.** The first-publish
  register (`FIRST_PUBLISH_CHANGES`, part 09 (`09-acceptance-and-the-first-publish.md`), section
  11.2, B7) gains the entry `media-downloaded-again`, exactly as that section writes it for this
  outcome: it applies where the reading holds a media reference, it touches workers, and its sentence
  is part 09's: "Phones download this app's pictures, sounds and videos again with the first version
  made after this publish." Held paths stay as planned, since without them every later publish would
  repeat it.
- **Outcome C: a path or a `multimedia_id` differs.** Nova's bulk upload is then not the write this
  part read. Part 11 (`11-project-data.md`, "Written and not yet run", B9) then adds
  `lib/deployment/service.ts::withoutHeldMedia(assets, heldPaths)`, which leaves out of the bulk
  upload every asset that holds a path row for the target (a replaced file is a new asset and holds
  none), and the run is made again; outcome A is required before B13 merges.

---

## 1. What Nova does today

**Ids on the wire.** A menu's and a form's HQ id is the Nova UUID without hyphens, and a form's `xmlns`
is `http://openrosa.org/formdesigner/` and the UUID in upper case
(`lib/commcare/wireIdentity.ts::derivedUniqueId`, `derivedFormXmlns`). The document stores none of
them. `targetWireIdentity(overrides)` lays a target's rows over the derivation, per entity and per
field. The hidden menu of a registration form a case list offers after an empty search is a module
of the emission plan only; its UUID is `emissionPlan.ts::syntheticModuleUuid(formUuid)`, a UUIDv5 of
the form's UUID under a namespace of its own.

**`app_deployment_identities`.** Primary key `(deployment_id, entity_kind, nova_entity_uuid)`,
`entity_kind` in `module | form`, nullable `unique_id` and `xmlns`, unique on
`(deployment_id, entity_kind, unique_id)` and on `(deployment_id, xmlns)`. It is in
`privilegeConvergence.ts::RUNTIME_READ_ONLY_TABLES`: step 2's cutover wrote every row, and no serving
code writes one. `store.ts::readDeploymentIdentityOverrides` reads a target's rows at `view`, for a
publish (`service.ts::publishAppToHq`, only where a deployment exists) and for a `.ccz`
(`downloadTarget.ts::resolveDownloadTarget`). The HQ app file takes the derivation.

**Media paths.** The document holds asset ids. `lib/media/manifest.ts::resolveMediaManifest` gives
every asset the path `commcare/<sha256><ext>` (`assetWirePath.ts::wirePathFor`), and
`mediaSuiteXml.ts` writes every file under the one directory `MEDIA_INSTALL_PATH`, `../../commcare`.

**The ownership ledger.** `app_deployment_resources` holds one live row per
`(deployment_id, kind, nova_resource_id)`. `ownership` is `nova-created | adopted`; the DDL does not
tie `adopted` to a kind, and `adopted_at` and `adopted_by` are set exactly with it. The row has no
`server` and no `domain`: those are on `app_deployments`. Both writers of an `app` mapping write
`nova-created` (`store.ts::recordCreatedRemoteApp`; `service.ts::publishAppToHq`'s call of
`recordRemoteResource`). Nothing asks whether two Nova apps map one HQ app.

**Writers.** Every store write is its own transaction: `store.ts::withDeploymentRow` calls
`withAppTx`, locks the app row `FOR SHARE` and re-proves the Project and the role
(`lockAppForDeploymentWrite`), takes the deployment row `FOR UPDATE` and folds. No exported writer
takes a caller's transaction. Confirmations are inserted only by `foldDeploymentAttempt`, and only
with a preflight that passed.

**Baselines.** `app_deployment_baselines.origin` is `create | push | cutover | unread` by CHECK.
`store.ts::readAppBaseline` throws on any other origin, and answers `unread` where the stored bytes
fail gunzip, the digest, the parse or the ownership shape. The stored source is
`hqSourceBaseline.ts::normalizeHqAppSource` of one HQ read, with each form id replaced by its position
token. `diffHqAppSource` compares two reads under the baseline's ownership; with `shell: true`
(origin `create`) it compares `modules` alone.

**Reached targets.** A project space holds the app's content when the record displays as `uploaded`
and its live `app` mapping is not gone and has a `pushed_revision`
(`resources.ts::publishedRemoteApp`, `remoteAppHoldsContent`; `store.ts::readReachedDeploymentTargets`).
Preview's project space reads four columns of `app_deployments` and no mapping
(`store.ts::readDeploymentPreviewRecords`, `previewTarget.ts::resolvePreviewDeploymentTarget`).

**Gone and ended.** HQ reporting the mapped app gone sets the mapping's `remote_missing_at`; the next
publish creates an app in the same deployment, which keeps its identity rows. There is no ended state,
column or function. A deployment row is never deleted.

**Deleting and restoring an app.** `lib/db/apps.ts::softDeleteApp` sets `deleted_at` and
`recoverable_until` under the app row lock; `restoreApp` clears both. Neither touches a deployment.
No runtime path deletes an app row.

**Drift copy.** Every sentence about a change made in CommCare HQ is in
`lib/deployment/remoteChanges.ts` and `lib/publish/webApps.ts`, and each that names a time says "since
Nova last published it".

---

## 2. The `IdentityResolver`

### 2.1 The namespace and the name

`lib/commcare/reader/identity.ts` (new, pure, outside the `lib/commcare` barrel, lands in B2):

```ts
import { v5 as uuidv5 } from "uuid";

/** Wire protocol: changing either re-ids every app a later reading mints. */
export const HQ_ENTITY_KEY_VERSION = "nova-hq-entity-v1";
export const HQ_ENTITY_NAMESPACE_UUID = "094fd6bb-29a8-4353-80ad-87b19db1277a";

export type ExternalKeyPart = string | number | readonly ExternalKeyPart[];
export interface ExternalKey {
	readonly kind: ExternalEntityKind;
	readonly parts: readonly ExternalKeyPart[];
}

/** `JSON.stringify([kind, ...parts])`: a key's one text form, used to sort and to compare. */
export function externalKeyText(key: ExternalKey): string;

/** UUIDv5 of `JSON.stringify([HQ_ENTITY_KEY_VERSION, appId, key.kind, ...key.parts])`. */
export function mintEntityUuid(appId: string, key: ExternalKey): Uuid;
```

The name is a JSON array, as `lib/domain/caseOperationIdentity.ts::authoredCaseIdNamespaceName` and
`lib/domain/datetimeSplitIdentity.ts::datetimeSplitFieldUuid` already build theirs: it is
deterministic and keeps boundaries whatever a part contains. The app's id is the name's second
element and never the namespace: `apps.id` is opaque text to every reader
(`lib/deployment/types.ts::DeploymentResource`, "an app id is an opaque storage identity"), and a
UUIDv5 namespace must be a UUID. The kind is in the name, so equal parts under two kinds give two
UUIDs, which `authoredBlueprintIdentities`' rule (a UUID names one thing whatever its kind) needs.
Parts are used exactly as read: no trimming, no case folding, no Unicode normalization.

Golden values (app id `3f2c9a1e-5b7d-4c8e-9f10-2a3b4c5d6e7f`), held by the unit test:

| Kind | Parts | UUID |
|---|---|---|
| `module` | `["a1b2c3d4e5f60718293a4b5c6d7e8f90"]` | `378c6a63-9d66-56ad-b0f2-06b79ad46109` |
| `form` | `["http://openrosa.org/formdesigner/1A2B3C4D-0000-4000-8000-ABCDEF012345"]` | `82b5fae7-6161-544d-8549-a3814e6670df` |
| `field` | that `xmlns`, then `["household","head_name"]` | `032e17ab-28fd-5672-a25e-3a1122d8fc42` |
| `selectOption` | that `xmlns`, `["household","sex"]`, `"f"` | `21202100-d17b-5467-a6c6-47fa90e94f17` |

### 2.2 The key table

The rule every row follows: **a key is computed from the entity as Nova holds it, without its UUID,
and from its owner's key.** The reader computes it from the entity it has assembled and not yet
minted; `externalIdentityMap` (2.5) computes it from any Nova document. Both call the constructors
below, so there is one spelling of each key.

```ts
export const EXTERNAL_ENTITY_KINDS = [
	"module", "form", "field", "selectOption", "caseListColumn", "searchInput",
	"caseOperation", "formLink", "entryPoint", "userProperty", "organizationLevel",
	"locationProperty",
] as const satisfies readonly BlueprintAuthoredIdentityKind[];
export type ExternalEntityKind = (typeof EXTERNAL_ENTITY_KINDS)[number];

/** The kinds CommCare HQ's app holds nothing of, so a reading mints none. */
export const KINDS_WITH_NO_EXTERNAL_KEY = [
	"userType", "persona", "automation", "automationCriterion",
	"automationSetupOnlyCriterion", "automationUpdate", "automationRecipient",
	"automationEvent", "automationUserDataFilter",
] as const satisfies readonly BlueprintAuthoredIdentityKind[];

/** A case operation's place, by its `CasePlacement` (the second table below). */
export type CaseOperationPlaceKey =
	| readonly ["basic", "own"]
	| readonly ["basic", "usercase"]
	| readonly ["basic", "subcase", index: number]
	| readonly ["basic", "subcase-row", repeatPath: readonly string[]]
	| readonly ["advanced", tag: string]
	| readonly ["save-to-case", repeatPath: readonly string[], path: readonly string[]];
export type FormLinkTargetKey =
	| readonly ["form", targetXmlns: string]
	| readonly ["module", targetModuleUniqueId: string]
	| readonly ["this-form"];
export type EntryPointOwnerKey =
	| readonly ["module", moduleUniqueId: string, slot: "menu" | "case-list"]
	| readonly ["form", xmlns: string];

/** One constructor per kind. Each takes the parts of the table below, in its order, and returns
 *  `{ kind, parts }` with nothing trimmed or folded. */
export const externalKey: {
	module(uniqueId: string): ExternalKey;
	form(xmlns: string): ExternalKey;
	field(xmlns: string, path: readonly string[]): ExternalKey;
	selectOption(xmlns: string, path: readonly string[], value: string): ExternalKey;
	caseListColumn(
		moduleUniqueId: string, columnKind: Column["kind"], field: string, n: number,
	): ExternalKey;
	searchInput(moduleUniqueId: string, name: string): ExternalKey;
	caseOperation(
		xmlns: string, place: CaseOperationPlaceKey, action: CaseOperation["action"], n: number,
	): ExternalKey;
	formLink(xmlns: string, target: FormLinkTargetKey, n: number): ExternalKey;
	entryPoint(...owner: EntryPointOwnerKey): ExternalKey;
	userProperty(slug: string): ExternalKey;
	organizationLevel(code: string): ExternalKey;
	locationProperty(slug: string): ExternalKey;
};
```

`Column` is `lib/domain/modules.ts::Column` and `CaseOperation` is `lib/domain/forms.ts::CaseOperation`.
The constructors take their parts as arguments, one per part, and every part of this plan calls
them so: `externalKey.searchInput(moduleUniqueId, name)`, `externalKey.organizationLevel(code)`,
`externalKey.caseOperation(xmlns, ["basic", "own"], "own", 0)`. No call passes its parts as one
array.

| Kind (schema that holds the `uuid`) | Parts | From HQ's source | From a Nova document |
|---|---|---|---|
| `module` (`modules.ts::moduleSchema`) | `[uniqueId]` | `modules[i].unique_id` | `identity.moduleUniqueId(module.uuid)` |
| `form` (`forms.ts::formSchema`) | `[xmlns]` | the form's `xmlns` | `identity.formXmlns(form)` |
| `field` (`fields/base.ts`, every field kind) | `[xmlns, path]`, `path` the ids from the form's root to the field | the assembled field tree | `formFieldPath(formStructure, field.uuid)` |
| `selectOption` (an inline option of a select) | `[xmlns, path, value]` | the item's value | `option.value` |
| `caseListColumn` (`modules.ts::columnBase`) | `[moduleUniqueId, columnKind, field, n]`: `field` the case property of the seven arms that show one, `""` for `calculated`; `n` the 0-based ordinal among the module's columns of equal `(columnKind, field)`, in `listColumnOrder` order (a complete permutation of the columns, `modules.ts::caseListConfigSchema`; the `columns` array carries no sequence) | the assembled column and the assembled `listColumnOrder` | the stored column and `listColumnOrder` |
| `searchInput` (`modules.ts::searchInputBase`) | `[moduleUniqueId, name]` | the assembled input | `input.name` |
| `caseOperation` (`forms.ts::caseOperationSchema`, the own arm included) | `[xmlns, place, action, n]`: `place` below; `n` the ordinal among the form's operations of equal `(place, action)`, in `caseOperations` order | the held placement the reader read | `planPlacements(doc, formUuid).placements.get(op.uuid).placement` |
| `formLink` (`forms.ts::formLinkObjectSchema`, and a link `otherwise`) | `[xmlns, target, n]`: `target` is `["form", targetXmlns]`, `["module", targetModuleUniqueId]` or `["this-form"]`; `n` the ordinal among the form's links of equal `target`, counting `formLinks` in order and then the `otherwise` link | the assembled links | the stored links |
| `entryPoint` (`entryPoints.ts::entryPointSchema`) | `["module", moduleUniqueId, "menu"]`, `["module", moduleUniqueId, "case-list"]` or `["form", xmlns]` | which of HQ's three endpoint slots held the id | `Module.entryPoint`, `Module.caseListEntryPoint`, `Form.entryPoint` |
| `userProperty` (`users.ts`) | `[slug]` | the slug an expression or a write names | `property.slug` |
| `organizationLevel` (`organization.ts::organizationLevelSchema`) | `[code]` | the level's code | `level.code` |
| `locationProperty` (`organization.ts::locationPropertySchema`) | `[slug]` | the slug | `property.slug` |

A case operation's `place`, from its `CasePlacement` (`lib/domain/placements.ts`):

| Placement | `place` |
|---|---|
| basic `own` | `["basic", "own"]` |
| basic `usercase` | `["basic", "usercase"]` |
| basic `subcase` at `index` | `["basic", "subcase", index]` |
| basic `subcase-row` | `["basic", "subcase-row", repeatPath]`, `repeatPath` the authored path of `forEach.repeat` |
| advanced, tag `t` | `["advanced", t]` |
| Save to Case | `["save-to-case", repeatPath or [], path]` |

What a reading also meets and the schemas hold no `uuid` for, each with what its identity is:

| Thing | Identity |
|---|---|
| a link `otherwise` | it is a `formLink`: its `uuid` "shares the links' namespace" (`authoredIdentities.ts`) |
| a form's own close | none of its own: `Form.ownClosePlacement` is a slot of the form; the own case is the `caseOperation` whose action is `own` |
| a sort rule | the `sort` slot of its column |
| a tile cell | the `tile` slot of its column |
| a language | its code; `localization.wireCodes[code]` holds HQ's code as read |
| a Connect block | its `id`, HQ's own block id (`connectIds.ts::connectBlocks`) |
| a prose part | none: a `field-ref` holds a field UUID this table mints, a `user-property-ref` a worker property's |
| an options source | inline options are `selectOption`; a lookup source holds a table id and column ids |
| a case type, a case property | its name |
| a lookup table, column, row | UUIDv7, never derived (`lookupIds.ts::LOOKUP_UUID_V7_PATTERN`): minted when the reading starts, handed to the reader bound to its tag |
| a media asset | its asset id, from the media store |
| a translation unit | derived from its owner's UUID (`makeTranslationUnitId`) |
| the hidden menu of a registration form | `syntheticModuleUuid(formUuid)`, unchanged: never minted here, and its HQ id is an identity row (3.1) |
| the app | its id is random, minted with the reading, so a retried creation gives the same app |

**Why each key holds under edits made in CommCare HQ, and what happens where it does not.**

- `modules[].unique_id` is minted once (`ModuleBase.get_or_create_unique_id`) and no source read
  changes it: `Application.scrub_source` re-mints form ids and report config ids only. A module with
  none is `menus-and-case-lists/module-unique-id-missing`, refused before any mint (part 06
  (`06-the-reader-forms.md`), section 7.2, B2).
- A form's `xmlns` is the namespace of its XForm's data node, copied to the form on every save of its
  source (`FormSource.__set__`). HQ's form builder keeps it. It changes only when a person uploads
  another XForm over the form, and `copy_form` gives the copy a new one (`save_xform`). A form whose
  XForm does not parse has `xmlns` null: the reader refuses it before any mint (part 06, section 7.2,
  under `forms-and-case-writes/blank-source-or-no-non-group-question`).
- A question's path is its identity to HQ too (exports, case management and the form's submissions
  name it), so renaming or moving a question in HQ is a new question to both systems.
- A menu id, an `xmlns`, an option value, a search input's name, a level code and a slug are each the
  name HQ's data is filed under. Lifecycle: every one of these fields is alive at the pin.
- Where a key does change, the entity reads as one removed and one added. Step 6 reads an app once
  per adoption, so the only cost in step 6 is to a reading that is checked again after HQ changed, and
  its review is new anyway. In step 7 it is how a rename in HQ arrives, and its review says so.
- A column, a case operation and a link have no name in HQ. Their keys are content (`columnKind` and
  property, place and action, target) and an ordinal among equals. So reordering columns of distinct
  `(columnKind, field)`, case operations of distinct `(place, action)` or links of distinct targets
  changes no key, and changing a column's property makes it another column, which is what HQ itself
  holds: a new list entry. Two reorders do change keys. Among entities that are equal in content the
  ordinal follows the order, so swapping two columns that show one property the same way swaps their
  keys; nothing tells those two apart in HQ either. And a basic subcase's `place` holds its `index`,
  HQ's own position of it in the form's `subcases` and the name of the node its block is written at
  (`subcase_<index>`, `lib/domain/placements.ts`). Reordering a form's subcases in HQ therefore moves
  where each one's answers sit and changes the key of each one whose position moved: such an
  operation reads as one removed and one added, which is what happened to its data.

### 2.3 The resolver

```ts
export interface IdentityMapEntry {
	readonly kind: ExternalEntityKind;
	readonly parts: readonly ExternalKeyPart[];
	readonly uuid: Uuid;
}
export type IdentityClaim =
	| { readonly ok: true; readonly uuid: Uuid }
	/** The key was claimed before, at `firstPlace`. Nothing is minted. */
	| { readonly ok: false; readonly key: ExternalKey; readonly firstPlace: string };

export interface IdentityResolver {
	/** `place` is where in HQ's app the entity was read, in the finding's place vocabulary. */
	claim(key: ExternalKey, place: string): IdentityClaim;
	/** Every key claimed so far, ordered by `externalKeyText`. */
	entries(): readonly IdentityMapEntry[];
}

/** Mints every key: `mintEntityUuid(appId, key)`. A reading of an HQ app uses this. */
export function mintingResolver(appId: string): IdentityResolver;
/** Answers a key `known` holds with its UUID and mints the rest. */
export function matchingResolver(
	appId: string, known: readonly IdentityMapEntry[],
): IdentityResolver;
```

`matchingResolver` throws at construction if `known` holds one key twice or one UUID under two keys.
Its step 6 callers are acceptance's re-read of a split document at creation (part 09, 5.4, B7) and
proof 6 (B13), which reads Nova's own emission of a Nova-born document and must get that document's
UUIDs back: it passes `externalIdentityMap(D, identity)` (part 14 (`14-proof.md`), section 5.2).
Acceptance passes `matchingResolver(input.appId, externalIdentityMap(expected, identity))`, so the
questions a split made keep their UUIDs. Step 7's first group is its next caller (10).

A reader module that knows a duplicate by its manifest entry claims that entry first (two forms of
one `xmlns`; two options of one value). Any other `ok: false` is the reader frame's to report (part
06 (`06-the-reader-forms.md`), section 4.4, B2): the circumstance `unrecognized` at the second
place, with `detail.name` the surface key of the node that was being minted, which is the detail
part 01's row for the code gives it (its section 8.3), and a `ReaderDefect` whose `why` is part
06's line D4, `readerDefect.identityMetTwice(place, key.kind)`: "identity met twice at <place>: a
<kind> key", the place by position alone. It names the key's kind and no part of the key, because
a key's parts are an `xmlns`, a question's path and an option's value, an app's own content, and
no log line holds any (part 12 (`12-the-reading-and-the-birth.md`), section 10). The reading's
service logs both at error when it stores the account (part 12, B10). An accepted reading
therefore never holds one UUID twice.

### 2.4 UUID versions

- `lib/domain/uuid.ts::CANONICAL_UUID_PATTERN` admits versions 1 to 8 with the RFC variant, lower
  case. The `uuid` package's v5 output is lower case, version nibble `5`, variant `8` to `b`. Every
  minted UUID passes `uuidSchema`.
- The only version-specific rule over document content is `LOOKUP_UUID_V7_PATTERN`, on lookup table,
  column and row ids, which this part never derives.
- `blueprint_entities.uuid` and `app_deployment_identities.nova_entity_uuid` are Postgres `uuid`
  columns, which hold any version.
- `derivedUniqueId` and `derivedFormXmlns` read a UUID as text, so a v5 UUID derives as any other. On
  the adopted deployment the rows of section 3 take their place; every other project space and the HQ
  app file take the derivation.
- `syntheticModuleUuid` and `datetimeSplitFieldUuid` already put v5 UUIDs in documents and on the
  wire.
- Nothing orders entities by UUID: `moduleOrder`, `formOrder`, `fieldOrder` and each nested array
  carry order.

### 2.5 The projection: `externalIdentityMap`

`lib/commcare/reader/identityMap.ts` (new, pure, B8):

```ts
/** Every entity of `doc` that has an external key, with that key, ordered by `externalKeyText`. */
export function externalIdentityMap(
	doc: BlueprintDoc, identity: WireIdentity,
): readonly IdentityMapEntry[];

export interface EncodedIdentityMap { readonly gzip: Buffer; readonly bytes: number }
/** gzip of `canonicalJsonText({ version: HQ_ENTITY_KEY_VERSION, entries: [[kind, uuid, ...parts]] })`. */
export function encodeIdentityMap(entries: readonly IdentityMapEntry[]): EncodedIdentityMap;
/** Null where the bytes fail gunzip, the parse, the shape or the version. */
export function decodeIdentityMap(gzip: Buffer): readonly IdentityMapEntry[] | null;
```

It walks the document as `authoredBlueprintIdentities` does and builds each key from the "From a Nova
document" column of 2.2: `lib/domain/expression/formStructure.ts`'s structure for paths,
`lib/commcare/placement.ts::planPlacements` for each operation's place (the held placement, or the one
the plan gives an unheld operation), and `identity` for menu ids and `xmlns`. A menu the emission plan
adds is not an entity and gets no entry. It is total over a document the gate admits: it reads no
store and parses nothing. Two entities of one key cannot both be in a gate-clean document for the
named kinds (ids are unique among siblings, option values within a select, input names within a
module); for the ordinal kinds the ordinal makes the key unique by construction.

### 2.6 Tests of this section

Named in "Tests": `identity.test.ts` (B2), `identityMap.test.ts` and `identityMapParity.test.ts` (B8).

---

## 3. `app_deployment_identities` for an adopted deployment

### 3.1 The rows

`lib/deployment/adoption.ts` (new, pure, B8):

```ts
import type { ReadMenuAndFormIdentities } from "@/lib/commcare/reader";
// What the reader returns of the menus and forms it minted (`ReadDraft.identities`, B2).

export type AdoptedIdentityRows =
	| { readonly ok: true; readonly rows: readonly DeploymentIdentityOverride[] }
	/** A form of the document has no real id in the aligned read. */
	| { readonly ok: false; readonly at: string };

export function adoptedIdentityRows(
	read: ReadMenuAndFormIdentities, aligned: readonly HqAlignedModule[],
): AdoptedIdentityRows;
```

`ReadMenuAndFormIdentities` is part 06's (`06-the-reader-forms.md`, section 2.2, B2), declared in
`lib/commcare/reader/types.ts` and nowhere else, because `lib/commcare` cannot import
`lib/deployment`: `modules` holds `{ uuid, uniqueId }` for every menu of HQ's app the document
holds, a folded hidden menu under its synthetic UUID, and `forms` holds `{ uuid, xmlns,
moduleUniqueId }`. The reader returns, on a `ReadOutcome` of kind `read`, `draft.identities: {
entries, modules, forms }`: this type with the `entries` of 2.3. `lib/deployment` already imports
`lib/commcare` (`biome.json`'s override leaves `lib/deployment/**` out), so the import changes no
rule.

- One row per entry of `read.modules`: `{ entityKind: "module", novaEntityUuid: uuid, uniqueId, xmlns:
  null }`.
- One row per entry of `read.forms`: `{ entityKind: "form", novaEntityUuid: uuid, uniqueId: <real id>,
  xmlns }`. The real id is `HqAlignedForm.uniqueId` (part 05 (`05-reading-commcare-hq.md`), section
  8.3, B1) of the `aligned` module whose `uniqueId` is the form's `moduleUniqueId`, at the form whose
  `xmlns` equals. A module that is `not-summarized`, or a form not found, answers `{ ok: false, at
  }`. Such a reading has already ended: with `menu-unreadable-in-hq` at each menu HQ could not
  summarize or `app-unreadable-in-hq` at the app where it could summarize none (part 05, section
  8.3, `notSummarizedMenus`), or with an answer of HQ's that Nova could not read (part 05, 8.2). So
  in production this arm is unreachable. The birth answers it as an invariant failure: the
  circumstance `could-not-create` with `detail.name` `identity`, no transaction opened, logged at
  error (part 12 (`12-the-reading-and-the-birth.md`), section 6.5, B10).
- A menu with no `unique_id`, which part 05 aligns by position with `uniqueId: null` (its sections 7
  and 8.3), has no draft (part 06, section 7.2), so `read` names neither it nor a form of it:
  `modules[].uniqueId` and `forms[].moduleUniqueId` stay `string`, and no null reaches a row.
- A menu HQ holds as the hidden home of a registration form, which the reader folds into its host
  (`caseListRegistrationForm`, the `after-empty-search` arm), is listed in `read.modules` with
  `uuid: syntheticModuleUuid(formUuid)`, so the publish writes HQ's id for the hidden menu it emits.
- Rows are sorted by kind, then UUID. The table's two unique indexes hold what the reader has already
  held: one `unique_id` per kind and one `xmlns` per deployment.

Real form ids exist nowhere but HQ's application resource (`ApplicationResource.dehydrate_module`
returns `form.unique_id`; `Application.scrub_source` re-mints it in every source read), which needs
the plan's API access. That is why a reading requires it, and it is checked first (part 05, section
5.2). Lifecycle: `Form.unique_id`, `ModuleBase.unique_id`, `Form.xmlns` and the resource's
`unique_id` keys are alive.

### 3.2 Who writes, and the privilege move

- **Insert**: `store.ts::recordAdoptedDeploymentInTransaction` (6.2), once per adoption. No publish
  writes a row: a menu or a form made in Nova after the adoption has no row and takes the derivation,
  and one removed in Nova leaves a row no export reads.
- **Delete**: `lib/db/hqAppClaims.ts::endDeploymentInTransaction` (8.2), every row of the deployment.
- **Update**: never. A row is immutable; a change is the delete of an ending and the inserts of a
  later adoption.

`app_deployment_media_paths` has the same insert and the same delete, and two more deletes of its
own: a Project move deletes an app's rows and inserts each under its destination asset id (4.6), and
the asset foreign key cascades when a file is deleted from the library (4.1). Neither is an update.

`lib/db/privilegeConvergence.ts`: `app_deployment_identities` leaves `RUNTIME_READ_ONLY_TABLES` and
joins `RUNTIME_INSERT_DELETE_TABLES`, with `app_deployment_media_paths`. That set's comment gains "A
deployment's identity and media-path rows are inserted when an app is brought in and deleted when the
deployment is ended; a Project move deletes an app's media-path rows and inserts them under the
destination Project's asset ids; no row is ever changed." The `RUNTIME_READ_ONLY_TABLES` comment
loses "the identity overrides a deployment target holds (a publish writes none)". The classification
of the identities table moves from `control` to `application` with the set. Both tables stay in
`RUNTIME_TABLES_WITHOUT_ROW_LOCKS`: the deployment row's lock serializes their writers, and the birth
writes them for a deployment only its own transaction can see. Grants converge on the next deploy; no
migration statement grants anything.

`readDeploymentIdentityOverrides`, `targetWireIdentity` and `WireIdentityOverride` do not change.

---

## 4. `app_deployment_media_paths`

### 4.1 DDL

```sql
CREATE TABLE IF NOT EXISTS app_deployment_media_paths (
	deployment_id uuid NOT NULL REFERENCES app_deployments(id) ON DELETE CASCADE,
	media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
	wire_path text NOT NULL,
	recorded_at timestamptz(3) NOT NULL DEFAULT now(),
	PRIMARY KEY (deployment_id, media_asset_id),
	CONSTRAINT app_deployment_media_paths_path_unique UNIQUE (deployment_id, wire_path),
	CONSTRAINT app_deployment_media_paths_path_shape CHECK (
		char_length(wire_path) <= 255
		AND wire_path ~ '^[^/\\[:cntrl:]]+(/[^/\\[:cntrl:]]+)+$'
		AND wire_path !~ '(^|/)\.{1,2}(/|$)'
		AND wire_path !~ '^ | $')
);
CREATE UNIQUE INDEX IF NOT EXISTS app_deployment_media_paths_path_folded
	ON app_deployment_media_paths (deployment_id, lower(wire_path));
```

`wire_path` is HQ's path without `jr://file/`, the form `ResolvedMediaAsset.wirePath` already has.
`media_asset_id` is `uuid` because `media_assets.id` is: created `text` in `20260708000000_app_state`
and altered to `uuid` by `20260728000000_canonical_identity_foundation` (`ALTER TABLE media_assets
ALTER COLUMN id TYPE uuid`), which is why `20260809000000_design_sessions` can declare
`thread_media_refs.asset_id uuid REFERENCES media_assets(id)`. The asset foreign key cascades, so
deleting a file from the library removes its path. `lib/db/pg.ts` gains `AppDeploymentMediaPathsTable`
(`media_asset_id: MediaAssetId`) and its `AppDatabase` entry. In the same file,
`lib/db/pg.ts::AppDatabase` types the baseline's new column of section 11, statement 10,
`first_publish_changes`, as `JSONColumnType<{ readonly ids: readonly string[]; readonly
webAppsOnInHq: boolean }> | null` on `AppDeploymentBaselinesTable`. The type is structural, since
part 09's `StoredFirstPublish` lives in a B7 file (`lib/publish/firstPublishChangeIds.ts`), which
lands above B8.

The CHECK and the folded index are the floor the database can state without leaning on its locale:
a directory and a name (any directory, since HQ's build writes whichever one the path names,
`MediaSuiteGenerator.media_resources`), no empty segment, no `.` or `..` segment, no backslash, no
ASCII control character, no space at either end, and no two paths of one deployment that differ only
by case as `lower()` folds them. The rule itself is `isHoldableWirePath` and `assignMediaPaths` (4.2),
in TypeScript, and every row a writer inserts has passed it.

### 4.2 Which path a file keeps

```ts
/** `lib/deployment/adoption.ts`. One file the app's source references, resolved to its asset. */
export interface AdoptedMediaFile {
	/** HQ's path as the source spells it, `jr://file/...`. */
	readonly hqPath: string;
	readonly assetId: MediaAssetId;
	readonly contentHash: string;
	readonly extension: string;
}
export interface MediaPathAssignment {
	readonly rows: readonly { readonly assetId: MediaAssetId; readonly wirePath: string }[];
	/** A file HQ holds under several paths: the one kept and the ones every slot leaves. */
	readonly collapsed: readonly { readonly assetId: MediaAssetId; readonly kept: string;
		readonly dropped: readonly string[] }[];
	/** A path of HQ's that is not held, with why: the file takes its derivation. */
	readonly rederived: readonly { readonly assetId: MediaAssetId; readonly from: string;
		readonly why: MediaPathRederivedReason }[];
}
export type MediaPathRederivedReason =
	/** HQ's upload cannot address it, or it is no safe archive entry (`isHoldableWirePath`). */
	| "not-holdable"
	/** It is in Nova's derived shape and is not this file's own derived path. */
	| "names-another-file"
	/** Only letter case tells it from a path of another file, and HQ's upload matches without case. */
	| "differs-only-by-case";
/** `path` is HQ's path without `jr://file/`. */
export function isHoldableWirePath(path: string): boolean;
export function assignMediaPaths(files: readonly AdoptedMediaFile[]): MediaPathAssignment;
```

`isHoldableWirePath` answers true exactly when the path has at most 255 code points; has a directory
and a name, with no empty segment and no `.` or `..` segment; holds no backslash and no control
character (`\p{Cc}`); and neither starts nor ends with a character Python's `str.strip()` removes
(`\p{Zs}`, U+2028, U+2029; the controls it removes are already refused). Each clause has a reason:

- **Any directory is held, and a path with none is not.** HQ's build writes `install_path = '../../' +
  directory` and `local = './' + directory + '/' + name` for whatever directory the path names
  (`media_resources`, over `app_manager/util.py::split_path`), so `jr://file/media/logo.png` builds
  and is held as `media/logo.png`. For `jr://file/logo.png` the directory is empty, and HQ's suite
  then holds `path="../../"` and the location `.//logo.png`, a location with an empty segment that
  4.4's writer has no spelling for.
- **Segments.** An empty, `.` or `..` segment, a backslash and a control character are what make a
  path unsafe as a zip entry and as a media suite location.
- **Ends.** `CommCareMultimedia.get_form_path` strips the path of every zip entry before the bulk
  upload matches it, so no entry can ever match an app path that starts or ends with such a
  character: HQ's own upload cannot put a file there.

`assignMediaPaths`, in order:

1. Each `hqPath` loses `jr://file/`. A path that does not start with it makes `assignMediaPaths`
   throw: HQ's own build refuses such a path (`MediaSuiteGenerator.media_resources` raises
   `MediaResourceError`), so the media reader (part 11 (`11-project-data.md`), section 2.1, B9) has
   already given its finding, under the entry
   `expressions-and-data/multimedia-map-key-not-under-jr-file-that-the-build-keeps`, and no such file
   reaches a birth. This is the one path that is a finding. Every other path is held or re-derived.
2. A candidate `isHoldableWirePath` refuses is dropped: `rederived`, `not-holdable`.
3. A candidate whose lower-case form matches `^commcare/[0-9a-f]{64}\.[a-z0-9]+$` and that is not
   exactly `wirePathFor(contentHash, extension)` is dropped: `rederived`, `names-another-file`. Such a
   path names another file's bytes: it arises when a file Nova published was replaced in HQ under the
   same path. Holding it would let it collide with the derived path of the file whose hash it spells,
   and `multimedia/bundle.ts::buildMediaBundle` dedupes by path on the premise that one path is one
   file. The test is on the lower-case form because of step 4's rule.
4. A candidate whose `toLowerCase()` form equals that of a candidate of another asset is dropped, on
   both assets: `rederived`, `differs-only-by-case`. HQ's bulk upload matches a zip entry to an app
   path with both lower-cased and takes the first match (`hqmedia/tasks.py::process_bulk_upload_zip`:
   `form_path = media_class.get_form_path(path, lowercase=True)`, `app_paths_lower.index(form_path)`,
   `create_mapping(multimedia, app_paths[index])`), so of two such paths both uploads land on one and
   one file would show the other's picture. HQ matches within one media class; Nova applies the rule
   across all of them, which only ever holds fewer paths.
5. The remaining candidates of one asset are sorted in code-unit order; the first is kept. Where there
   were several, the asset is listed in `collapsed`. The media reader (part 11, section 4.1,
   `adoptedMediaFiles`, B9) resolves every path whose bytes share a content hash to one asset id
   (`lib/db/mediaAssets.ts::findReadyAssetByProjectAndHash`
   answers the oldest ready row of that hash; the `media_assets_dedup` index is not unique, so one
   asset per file is B9's resolution and no constraint), and the document holds an asset id per slot,
   so two paths for one file cannot both be kept without a path in the document, which decision 6
   rules out: a path is a row of one deployment and never a slot of the document (the top-level
   file `../6-bring-in.md`, "What changed from the outline, and why", item 17).
6. An asset left with no candidate gets no row and takes its derivation.

`collapsed` and `rederived` are changes the first publish makes (a reference moves to another path
for the same picture, and HQ's `remove_unused_mappings` drops the path nothing names). They are inputs
of the first-publish register (part 09 (`09-acceptance-and-the-first-publish.md`), section 11.2,
its `media-path` rows, B7), which reads `assignMediaPaths(files)` and holds four entries for them:

| Register id | Applies where |
|---|---|
| `media-paths-joined` | `collapsed` is not empty |
| `media-path-not-holdable` | `rederived` holds a `not-holdable` |
| `media-path-names-another-file` | `rederived` holds a `names-another-file` |
| `media-path-differs-only-by-case` | `rederived` holds a `differs-only-by-case` |

Each one's sentence is part 09's ("Copy"). None is a finding: the app reads, the picture a worker
sees is the same one, and the reference moves to a path Nova can hold. Departure 6 gives the
evidence for each of the three reasons.

### 4.3 Readers

```ts
/** `lib/deployment/store.ts`. The target's held media paths; empty where it holds none. `view`. */
export async function readDeploymentMediaPaths(
	scope: DeploymentScope, target: DeploymentTargetKey,
): Promise<ReadonlyMap<MediaAssetId, string>>;
```

- `lib/media/manifest.ts::ResolveManifestOptions` gains
  `heldPaths?: ReadonlyMap<MediaAssetId, string>`. An uploaded asset's `wirePath` is
  `heldPaths.get(id) ?? wirePathFor(contentHash, extension)`. A built-in icon has no asset row and is
  never held.
- `lib/export/boundaryValidation.ts`: `PrepareExportBoundaryInput` gains the optional
  `heldMediaPaths` of the same type, and `ExportBoundaryReads.mediaManifest` gains it as a third,
  optional parameter, which `PRODUCTION_READS` passes to `resolveMediaManifest`. A caller that passes
  its own reads and no held paths (the proof capture, `proof/corpus/publish.ts`, for a Nova-born
  document) is unchanged. For an HQ-authored A the capture passes the held media paths of its
  ledger (part 14 (`14-proof.md`), section 2.5; "Files by pull request", B8).
- **Publish**: `preflight.ts::runDeploymentPreflight` reads `readDeploymentMediaPaths(input.access,
  target)` and passes it to `prepareExportBoundary`, so the bulk upload's zip entries
  (`bulkUploadZip.ts::buildMediaBulkUploadZip`) and every reference of the body name HQ's paths.
- **`.ccz`**: `downloadTarget.ts::resolveDownloadTarget`'s `ccz` arm gains
  `mediaPaths: ReadonlyMap<MediaAssetId, string>`, read beside `identity` for the chosen target;
  `app/api/compile/prepareCompileRequest.ts` and `lib/mcp/tools/compileApp.ts` pass it to
  `prepareExportBoundary`.
- **The HQ app file** and every other project space pass none and take the derivation, as for ids.

### 4.4 The `.ccz` media suite

`lib/commcare/multimedia/mediaSuiteXml.ts`: the constant `MEDIA_INSTALL_PATH` goes. Each `<media>`
block's `path` is `../../` and the directory of the asset's `wirePath`, and its location stays
`./<wirePath>`, which is HQ's own rule (`media_resources`: `install_path = '../../' + path`,
`local = './' + path + '/' + name`). For a derived path the directory is `commcare`, so every archive
Nova makes today keeps its bytes; a held `media/logo.png` gives `path="../../media"` and the location
`./media/logo.png`. A held path always has a directory (4.2), so the writer never meets an empty one.
The resource id stays `media-<contentHash>-<filename>`: with one path per asset in a deployment and
one row per path, it stays unique in the suite.

### 4.5 When the author replaces a file

A new file is a new asset: it has no row, takes the derived path, and the next publish uploads it
there. HQ drops the old path once nothing names it. The old asset's row stays until the asset is
deleted from the library, the deployment is ended or a Project move drops it (4.6), and no export
reads it, since the manifest is built from the document's references. New bytes never take an old
path: a phone keeps a file it holds under a path whose `multimedia_id` did not change
(`set_media_versions`).

### 4.6 A Project move

`lib/db/apps.ts::commitAppProjectMoveInTransaction` re-maps the document's asset ids to the
destination Project's (`args.assetIdMap`). After its `app_deployments` update it calls

```ts
/** `lib/db/hqAppClaims.ts`. Runs inside the move's own transaction. */
export async function remapDeploymentMediaPathsInTransaction(
	tx: Transaction<AppDatabase>,
	input: { readonly appId: string;
	         readonly assetIdMap: ReadonlyMap<MediaAssetId, MediaAssetId> },
): Promise<void>;
```

(`MediaAssetId` from `lib/domain/multimedia`, which `lib/db/apps.ts` already imports.) For the
app's deployments it reads the rows, deletes them, and inserts each under its destination asset id.
Two source assets that map to one destination asset keep the first path in code-unit order. A row
whose asset the map does not name is dropped: the document no longer references it.

---

## 5. The claim

### 5.1 Columns, trigger and index

The DDL is statements 2 to 9 of section 11. In words:

- `app_deployment_resources` gains `server` and `domain`, copied from its deployment by the
  `BEFORE INSERT` trigger `app_deployment_resources_target` (function
  `public.nova_fill_deployment_resource_target()`), and held to it by the composite foreign key
  `(deployment_id, server, domain)` to a new `UNIQUE (id, server, domain)` on `app_deployments`. No
  writer sets them, so the previous revision's inserts keep working. A deployment's server and
  project space never change, so the copies never go stale.
- It gains `released_at`, set only on a live `app` mapping whose HQ app another Nova app took, or
  took back, while this mapping's app was in recently deleted (5.2 step 4, 5.4), and by statement 7.
  Its CHECK holds one thing, that a release is an `app` mapping's. It says nothing of
  `superseded_at`, because the previous revision supersedes a mapping by setting that one column
  and can do so to a released one (5.3). A superseded mapping that still carries `released_at` is
  inert: every statement that reads the column reads it beside `superseded_at IS NULL` (the index
  below, 5.2 step 2, 5.4's reads 1 and 3, 7.1's settle, 8.6's Preview filter), and the ending is
  the one statement of this revision that supersedes a released mapping, which clears it (8.2).
- The index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS app_deployment_resources_hq_app_claim
	ON app_deployment_resources (server, domain, remote_id)
	WHERE kind = 'app' AND superseded_at IS NULL AND released_at IS NULL;
```

It spans Projects and both ownerships: an app Nova created holds its HQ app as an adopted one does. A
mapping HQ reported gone (`remote_missing_at`) still holds the claim, since HQ's own undo brings that
app back. The function is registered in `privilegeConvergence.ts::EXPECTED_PUBLIC_ROUTINES`
(`{ name: "nova_fill_deployment_resource_target", identityArguments: "" }`).

### 5.2 Taking a claim: `claimHqAppInTransaction`

`lib/db/hqAppClaims.ts` (new, server-only, B8):

```ts
export const HQ_APP_CLAIM_INDEX = "app_deployment_resources_hq_app_claim";
/** `server` is the stored text; the column's CHECK bounds it, and `lib/deployment` narrows it. */
export interface HqAppKey {
	readonly server: string; readonly domain: string; readonly remoteAppId: string;
}
export const HQ_APP_MAPPING_OWNERSHIPS = ["nova-created", "adopted"] as const;
export const HQ_APP_END_REASONS = ["stopped", "claimed-elsewhere"] as const;
export type HqAppEndReason = (typeof HQ_APP_END_REASONS)[number];
/** The live Nova app that publishes to an HQ app. */
export interface HqAppClaimHolder {
	readonly appId: string; readonly projectId: string;
	readonly ownership: (typeof HQ_APP_MAPPING_OWNERSHIPS)[number];
	/** `adopted_by` for an adopted mapping, the deployment's `created_by` otherwise. */
	readonly byUserId: string;
	/** `adopted_at`, or the mapping's `created_at`. */
	readonly at: string;
}
/** `app_deployments.phases` as an ending writes it: every phase, never run (8.2). */
export const NO_PHASE_OUTCOMES_JSON =
	'{"preflight":null,"resources":null,"upload":null,"build":null,"release":null,"probe":null}';

export class HqAppAlreadyClaimedError extends Error {
	readonly name = "HqAppAlreadyClaimedError";
	constructor(readonly key: HqAppKey, readonly holder: HqAppClaimHolder | null);
}

/** The first step of a birth's transaction. Throws `HqAppAlreadyClaimedError` where a live app holds it. */
export async function claimHqAppInTransaction(
	tx: Transaction<AppDatabase>, key: HqAppKey,
): Promise<void>;
```

**The module imports nothing from `lib/deployment` and nothing from `lib/commcare`.** No file of
`lib/db` imports `lib/deployment` today (`lib/deployment/store.ts` imports `lib/db`, and this module
is called from `lib/db/apps.ts`), and Biome's `noRestrictedImports` allows `@/lib/commcare` to three
files of `lib/db` only (`biome.json`: `settings.ts`, `types.ts`, `canonicalMutationFold.ts`). So the
server is `string` here and in `lib/db/apps.ts`; the two vocabularies above are declared here; and
the phases an ending writes (8.2) are this module's own `NO_PHASE_OUTCOMES_JSON`. One test in
`lib/deployment`, `hqAppClaimsVocabulary.test.ts`, holds `HQ_APP_MAPPING_OWNERSHIPS` equal to
`types.ts::DEPLOYMENT_RESOURCE_OWNERSHIPS`, `HQ_APP_END_REASONS` equal to `DEPLOYMENT_END_REASONS`
(8.1) and the parsed constant equal to `NO_DEPLOYMENT_PHASE_OUTCOMES`. `lib/deployment/store.ts`
narrows a server with `types.ts::isDeploymentServer` where it needs a `CommCareServer`, as
`readDeploymentPreviewRecords` does today.

In order:

1. `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))` over the text
   `JSON.stringify(["nova-hq-app-claim-v1", server, domain, remoteAppId])`. Two births of one HQ app
   serialize here, before either has written anything, and so does a restore that settles a claim
   on it (5.4).
2. Read the live, unreleased `app` mapping of the key with its deployment and its app's `deleted_at`.
   None: return.
3. The holder's app is live: throw `HqAppAlreadyClaimedError` with the holder.
4. The holder's app is in recently deleted: lock that app row `FOR UPDATE` and read `deleted_at`
   again. Still deleted: set the mapping's `released_at` to `now()` and return. Restored meanwhile:
   throw as in 3.

The mapping insert of 6.2 is what takes the index entry. A birth and a settle of a released claim
(5.4) both hold the HQ app's advisory lock, so between step 2 and the insert no other birth and no
restore can take it. The index is the floor under that: if the insert still meets a unique violation
on `HQ_APP_CLAIM_INDEX`, the writer throws `HqAppAlreadyClaimedError` with a null holder, and the
transaction is over. The birth (part 12 (`12-the-reading-and-the-birth.md`), section 6.5, B10) turns
either throw into the circumstance `already-in-nova` on the reading, with `detail.claim` from a
fresh `readHqAppClaims` (5.5), and the reading stays so the person can check again.

**Lock order.** A birth takes, in this order: its own authority row (the reading row; part 12,
section 6.3, statement 1); the claim's advisory lock; where the holder is in recently deleted, that
app's row (step 4); then what the rest of the creation transaction takes, which ends with the
genesis tail's membership gate
(`lib/db/appGenesis.ts::writePreparedGenesisInTransaction` calls
`assertProjectCapabilityInTransaction`) and its inserts. A settle (5.4) takes every advisory lock it
needs, in key order, and only then app rows, in app id order, and its membership gate last. Three
facts make that free of a cycle:

- An advisory lock is never waited for while an app row is held. A birth holds none before step 1,
  and a settle takes all of its advisory locks first.
- App rows are waited for in one order. A birth waits for one existing app's row and holds no other.
  A settle locks its rows in ascending app id, so two restores that each need the other's row take
  them in the same order.
- The membership gate is taken after every app row, which is the order of every existing-app
  protocol ("Existing-app protocols lock the app first", `lib/db/CLAUDE.md`). A membership write
  takes the gate and no app row, so nothing that holds the gate waits for a row a birth or a settle
  holds. A birth is not gate-first because it locks an existing app's row; the new app's own row
  does not exist until the tail inserts it, so nothing can wait on it.

### 5.3 Why release is written at the take, and what the previous revision can do

`softDeleteApp` writes nothing new. A deleted holder's mapping keeps its index entry until another
app takes the HQ app. `released_at` is set by step 4 above, by a restore that takes an HQ app back
from a holder that is itself deleted (5.4), and by the migration; it is cleared by a restore's
re-claim and by an ending. To a person the rule is one sentence: an app in recently deleted does
not hold its HQ app against anyone. The picker (5.5), step 2 and a restore read through to
`apps.deleted_at`, so a deleted holder marks nothing and blocks nobody.

The previous revision serves while the migration runs and until the new one takes traffic. In that
time it can delete and restore apps and cannot bring one in, so nothing it does can leave two live
apps on one HQ app, and no column it does not know needs keeping. It can leave two states, both
from an app statement 7 released as a deleted duplicate and that the previous revision then
restored. That can follow either outcome of G1, since statement 7 releases the deleted members of
every group that has another unreleased member, and outcome A still holds groups of one live app
and apps in recently deleted.

- **A live app whose mapping is released.** Until it is settled, no reader treats that deployment
  as published: `resources.ts::plannedInPlaceUpdate` answers null for a released mapping (7.1), so
  it is no reached target for a `.ccz`, an attachment link, a deep link or worker provisioning, and
  `store.ts::readDeploymentPreviewRecords` leaves it out (8.6), so Preview does not name its
  project space. `publishAppToHq` settles it before it reads anything else (7.1).
- **A superseded mapping that still carries `released_at`.** The previous revision publishes that
  restored app afresh where CommCare HQ had reported its HQ app gone:
  `store.ts::writeResourceMapping` supersedes the released mapping by setting `superseded_at`
  alone, naming no column it does not know, and inserts a fresh mapping for the new HQ app. The
  fresh mapping is an ordinary live claim of an HQ app no one else holds. The superseded one keeps
  a `released_at` nothing reads (5.1). Statement 6's CHECK admits that row, and a migration test
  makes the previous revision's statement on it (Tests), because a CHECK that refused it would
  fail that publish with a bare constraint error while the previous revision still serves.

### 5.4 Restoring: `restoreApp`

`lib/db/apps.ts::restoreApp` returns what it ended:

```ts
export interface RestoredApp {
	/** The project spaces this app stopped publishing to, because another Nova app publishes there now. */
	readonly stoppedPublishing: readonly { readonly server: string; readonly domain: string }[];
}
export async function restoreApp(appId: string, actorUserId: string): Promise<RestoredApp>;
/** Thrown after three tries whose locks each found the claims changed. Nothing was written. */
export class RestoreClaimsChangedError extends Error {}
```

```ts
/** `lib/db/hqAppClaims.ts`. What a settle of one app's released claims holds locked. */
export interface ReleasedClaimLocks {
	/** The app's row, locked `FOR UPDATE`, as `lockAppRow` answers it. */
	readonly app: PersistedBlueprintAppRow | undefined;
	/** The app's live `app` mappings with `released_at` set, in `(server, domain, remote_id)` order,
	 *  each with the live, unreleased mapping another app holds on that HQ app, if one does. */
	readonly released: readonly {
		readonly deploymentId: string; readonly key: HqAppKey;
		readonly holder: { readonly mappingId: string; readonly appId: string;
			readonly appDeleted: boolean } | null;
	}[];
}
/** Null: what was read before the locks no longer holds under them. The caller starts again. */
export async function lockReleasedClaimsInTransaction(
	tx: Transaction<AppDatabase>, appId: string,
): Promise<ReleasedClaimLocks | null>;
export async function settleReleasedClaimsInTransaction(
	tx: Transaction<AppDatabase>,
	input: { readonly appId: string; readonly actorUserId: string; readonly at: Date;
	         readonly locks: ReleasedClaimLocks },
): Promise<readonly { readonly server: string; readonly domain: string }[]>;
```

`restoreApp` calls `lockReleasedClaimsInTransaction` where it calls `lockAppRow` today, and it is the
only lock-taker of the transaction before the capability check. It takes, in order:

1. With no lock, the app's live `app` mappings with `released_at` set. None, which is every restore
   of an app nobody took an HQ app from: `lockAppRow`, then the same read again under it. Still
   empty, the answer is `{ app, released: [] }`, which is today's path and two indexed reads more.
   No longer empty (a birth took one in between), the answer is null.
2. `pg_advisory_xact_lock` for each mapping's HQ app, over 5.2's text, in `(server, domain,
   remote_id)` order.
3. For each, the live, unreleased `app` mapping of another app on that HQ app, with its app's
   `deleted_at`. Under the advisory locks no birth and no other settle can change who that is.
4. `SELECT ... FOR UPDATE`, in ascending app id, on this app's row and on the row of each holder
   whose app is in recently deleted.
5. Reads 1 and 3 again. Where either differs from what was read before the locks (a birth took an
   HQ app from this app in between, a holder was restored or deleted, a holder's deployment was
   ended), the answer is null.

On null, `restoreApp` ends the transaction having written nothing and starts again, three times at
most, then throws `RestoreClaimsChangedError`, which
`app/(app)/(site)/app-actions.ts::restoreApp` answers with `RESTORE_CLAIMS_CHANGED` (Copy).

After the capability check and before the `apps` update, `settleReleasedClaimsInTransaction` goes
through `locks.released` in order:

- **No holder.** `UPDATE ... SET released_at = NULL`. The app holds its HQ app again, with its
  identity rows, its media paths and its baseline as they were.
- **A holder in recently deleted.** Its row is locked, so it stays deleted until this commits. Its
  mapping gets `released_at = at`, then this app's gets `released_at = NULL`. The restored app
  publishes there again, and the holder is now an app that gave the HQ app up, which its own restore
  settles in turn. This is decision 9's outcome for two deleted apps: the first one restored takes
  the HQ app back.
- **A live holder.** `endDeploymentInTransaction` (8.2) with reason `claimed-elsewhere`, and the
  project space joins the answer, which `restoreApp` returns as `stoppedPublishing`.

No statement here can meet the claim index: every case was read under the locks that decide it. A
unique violation on `HQ_APP_CLAIM_INDEX` is therefore an invariant failure and fails the restore,
logged at error, with nothing written.

`app/(app)/(site)/app-actions.ts::RestoreAppResult`'s success arm becomes `{ success: true;
stoppedPublishing: readonly { readonly domain: string; readonly serverLabel: string }[] }`, empty for
a restore that ended nothing. `serverLabel` is `lib/deployment/types.ts::deploymentServerLabel` of
the entry's server after `isDeploymentServer` (that file may import `lib/deployment` and not
`lib/commcare`), and the home list says so (Copy; part 13 (`13-the-experience.md`), section 11.4,
B11, places it). A restore that races a birth taking one of its HQ apps waits for that birth, on
the app row the birth locks (5.2 step 4) or on the HQ app's advisory lock, and then reads the
birth's outcome under its own locks, so the answer is never a guess.

### 5.5 What the picker reads: `readHqAppClaims`

```ts
/** `lib/deployment/store.ts`. */
export type HqAppClaimView =
	/** The viewer is a member of the holding Project. */
	| { readonly remoteAppId: string; readonly kind: "open"; readonly appId: string;
	    readonly appName: string }
	| { readonly remoteAppId: string; readonly kind: "elsewhere";
	    /** How the holder came to publish there. */
	    readonly how: "brought-in" | "published";
	    readonly at: string;
	    /** Who to ask: the person named by `how` while they are a member of that Project, else its owners. */
	    readonly contact: { readonly role: "person" | "owners"; readonly names: readonly string[] } };

export async function readHqAppClaims(input: {
	readonly viewerUserId: string;
	readonly server: CommCareServer; readonly domain: string;
	readonly remoteAppIds: readonly string[];
}): Promise<readonly HqAppClaimView[]>;
```

One query over the index's rows for `(server, domain, remote_id = ANY)`, joined to `app_deployments`
and to `apps` with `deleted_at IS NULL`; then, per holder, the viewer's membership of the holding
Project (`lib/db/projectMembership.ts`), `auth_user.name` for the contact, and the Project's owners
where the person is no longer a member. An HQ app with no row is absent from the answer: it is free. A
name that no longer resolves reads "A former member", as a confirmation's does. The caller has
already proven a key that reaches the project space (part 05, section 11, `getHqCredentials`); the
function reads nothing of HQ. The holding Project's name and the Nova app's name are never returned
for `elsewhere`.

`HqAppClaimView` is part 01's `HqAppClaimDetail` with `remoteAppId` added (part 01
(`01-the-bar-and-the-manifest.md`), section 8.1, A2). That type is declared in
`lib/publish/hqFindings.ts`, because a finding is client-safe and the store is not, and it is what
`already-in-nova` carries as `detail.claim`.

The reading's read step (part 12, section 3.3, step 2, B10) calls it for the one app chosen and gives
`already-in-nova` at once, with the view less `remoteAppId` as the finding's `detail.claim`. The
picker (part 13, section 4.2, B11) calls it once over the apps it lists. Each of those reads is
advisory; `claimHqAppInTransaction` decides.

---

## 6. The adopted ledger at birth

### 6.1 Column by column

**`app_deployments`** (one row):

| Column | Value |
|---|---|
| `app_id`, `project_id`, `server`, `domain` | the born app, its Project, the source project space |
| `state` | `uploaded` |
| `resume_phase` | null |
| `phases` | every phase null (`NO_DEPLOYMENT_PHASE_OUTCOMES`) |
| `created_by` | the person who brought it in |
| `last_observed_at` | null |
| `content_generation`, `entry_point_manifest`, `entry_point_observation` | null: deep links wait for the first publish |
| `offered_logo_content_hash` | null: no logo was offered |
| `target_empty_case_list_text` | null: no publish has read it (Departure 2) |
| `endings` | 0 |

**`app_deployment_resources`** (one row, the app):

| Column | Value |
|---|---|
| `kind`, `nova_resource_id`, `remote_id` | `app`, the Nova app id, HQ's app id |
| `ownership`, `adopted_at`, `adopted_by` | `adopted`, the birth's time, the person |
| `pushed_identity` | null |
| `pushed_revision`, `pushed_at` | 1 (the birth's sequence), the birth's time |
| `push_token` | the column's default |
| `remote_revision`, `remote_observed_at` | `HqAppReading.version` of the bracketed read (part 05, 8.1), the birth's time |
| `superseded_at`, `remote_missing_at`, `released_at`, `ended_by`, `ended_reason` | null |
| `server`, `domain` | by the trigger |

`pushed_revision` 1 says what is true: acceptance (part 09, B7) has shown that sequence 1 is what HQ
holds, up to the declared first-publish changes. It is what makes
`resources.ts::remoteAppHoldsContent` true, so the deployment is a reached target for a `.ccz`, for
Preview's project space, for attachment links and for provisioning workers, and `nextPublishAction`
answers `updates`.

**`app_deployment_baselines`** (one row): `remote_app_id`; `origin` `read`; the gzip, byte count and
digest of `normalizeHqAppSource` of the source the creation accepted; `ownership` of 6.3;
`observed_at` the time that source was read; `observed_by` the person; no discard; the identity map of
10. `first_publish_changes` is null in B8, and from B7 holds the list the person reviewed (part 09,
section 12.3).

**`app_deployment_identities`**: the rows of 3.1. **`app_deployment_media_paths`**: the rows of 4.2.
**`app_deployment_confirmations`**: the rows of 6.5. **`project_space_resource_baselines`** and every
`lookup-table`, `location` and `worker` mapping: none from this part. A table or a place managed in
CommCare HQ has no per-app mapping (part 11 (`11-project-data.md`), B9).

### 6.2 The writers, and what changes in the store

```ts
/** `lib/deployment/store.ts`. */
export interface AdoptedDeploymentWrite {
	readonly appId: string;
	readonly projectId: string;
	readonly actorUserId: string;
	readonly target: DeploymentTargetKey;
	readonly remoteAppId: string;
	/** HQ's save counter the bracketed read held. */
	readonly remoteRevision: number;
	/** The birth's sequence. */
	readonly pushedRevision: number;
	readonly baseline: AppBaselineWrite & { readonly origin: "read" };
	readonly identities: readonly DeploymentIdentityOverride[];
	readonly mediaPaths: readonly { readonly assetId: MediaAssetId; readonly wirePath: string }[];
	readonly confirmations: readonly DeploymentConfirmationKey[];
	readonly at: Date;
}
/** Records an adopted deployment inside the transaction that births its app. */
export async function recordAdoptedDeploymentInTransaction(
	tx: Transaction<AppDatabase>, write: AdoptedDeploymentWrite,
): Promise<DeploymentWithResources>;
/** The confirmation insert `foldDeploymentAttempt` makes inline today, under its conflict rule. */
export async function insertDeploymentConfirmationsInTransaction(
	tx: Transaction<AppDatabase>, deploymentId: string, actorUserId: string,
	keys: readonly DeploymentConfirmationKey[],
): Promise<void>;
```

It runs after the genesis tail has inserted the app row (`app_deployments.app_id` references it) and
in this order: read the app row and require `project_id` equal to `write.projectId` and `deleted_at`
null (the tail asserted the person's membership in this transaction, so the role is not read again);
insert the deployment row; `writeResourceMapping`; `writeAppBaseline`; insert the identity rows in one
statement; insert the media-path rows in one statement; `insertDeploymentConfirmationsInTransaction`;
`notifyAppDeployments`; return `loadWithinTransaction`. It takes no row lock: every row is new, and
the claim (5.2) has already serialized births of this HQ app.

Refactors of `store.ts`, all in B8:

| Symbol | Change |
|---|---|
| `writeAppBaseline(tx, deploymentId, scope, baseline)` | takes `observedBy: string` in place of `scope` (it reads only the actor), and writes the two identity map columns by `baseline.identityMap` (6.3). `store`: the insert and the conflict arm both write the map's gzip with `source_digest` as its digest, or two nulls for a null map. `rebind`: the insert writes two nulls; the conflict arm keeps `existing.identity_map_gzip` and sets `identity_map_source_digest` to the new `source_digest` where `existing.identity_map_source_digest = existing.source_digest` and the HQ app is the same, and writes two nulls otherwise, so a map that was already stale is dropped and never bound to a source it does not describe. B8 names `first_publish_changes` in neither arm, so every row B8 writes holds it null; B7 adds the column's clause to both arms (part 09, section 12.3) |
| `lockAppForDeploymentWrite(tx, scope, capability)` | returns the role it read under the lock (`ProjectRole`), which `endDeployment` reads (8.3); every other caller ignores it |
| the confirmation insert inside `foldDeploymentAttempt` | moves to `insertDeploymentConfirmationsInTransaction(tx, deploymentId, actorUserId, keys)`, same statement and conflict rule; `foldDeploymentAttempt` calls it and keeps its "only with a preflight that passed" refusal, which is a rule of the fold and not of the table |
| `writeResourceMapping` | unchanged signature; exported to the module's own callers only, as today |
| `withDeploymentRow` | gains `expectedEndings` and the ended rule (8.5) |
| `toDeploymentRecord`, `toDeploymentResource`, `loadResources` | read `endings`; `endedReason`, `releasedAt`; resolve `adoptedByName` and `endedByName` through `confirmerNames` |
| `readAppBaseline` | admits `read`; reports `storedOrigin` on an unverified row (6.3) |

`lib/deployment/index.ts` exports `recordAdoptedDeploymentInTransaction`, `AdoptedDeploymentWrite`,
`readDeploymentMediaPaths`, `readHqAppClaims`, `HqAppClaimView` and the `adoption.ts` functions.

### 6.3 The `read` origin

```ts
// lib/deployment/types.ts
export type AppBaseline =
	| { readonly origin: "create" | "push" | "cutover" | "read"; /* as today */ }
	| { readonly origin: "unread"; readonly remoteAppId: string;
	    readonly observedAt: string; readonly observedBy: string;
	    /** What the row's `origin` column holds: `unread` for a read that failed. */
	    readonly storedOrigin: "create" | "push" | "cutover" | "read" | "unread" };
export interface AppBaselineWrite {
	// A3 widened it with "cutover" (part 01, section 6.5); B8 adds "read".
	readonly origin: "create" | "push" | "cutover" | "read" | "unread";
	// as today, then:
	readonly identityMap: BaselineIdentityMapWrite;
}
export type BaselineIdentityMapWrite =
	/** Store this map for the source written; null for a source that describes no document. */
	| { readonly kind: "store"; readonly map: EncodedIdentityMap | null }
	/** Keep the row's map and bind it to the source written: the document did not change. */
	| { readonly kind: "rebind" };
```

Who passes which: an adoption and a publish's read-back pass `store` with a map; a `create` and an
`unread` baseline pass `store` with null; `refreshKeptValues`' write,
`store.ts::recordRefreshedAppBaseline`, passes `identityMap: { kind: "rebind" }` and carries
`expectedEndings` (10, 8.5; the writer is part 01's, its section 6.5, A3, and it writes the stored
origin, which is why `AppBaselineWrite.origin` holds `cutover`).

- **CHECK**: `app_deployment_baselines_origin_check` admits `read` (statement 10 of section 11).
  `app_deployment_baselines_unread_holds_no_source` is unchanged: a `read` row holds its source and its
  ownership.
- **`readAppBaseline`**: `read` joins the admitted origins. Where a stored row fails gunzip, the
  digest, the parse or the ownership shape (`store.ts::verifiedBaselineSource`, which part 01
  extracts in A3), the answer stays `unread`, now with `storedOrigin`, so the copy can say what Nova
  could not confirm (9). `targetFactsFromBaseline` (part 01, A3) projects a `read` baseline as it
  does a `push` one, and the kept list's one lead (part 01, 9.4) serves it; B8 adds no origin to
  `TargetFacts`.
- **The comparison**: `preflight.ts::appRemoteChange` passes `shell: baseline.origin === "create"`,
  so a `read` baseline compares every part a `push` baseline does: `modules`, each form with its
  attachment, `name`, `langs`, `application_version`, `location_fixture_restore`, the owned add-ons
  and profile part, and Nova's part of `translations`. Both sides are HQ's own reads, so an app
  nobody touched since it was brought in compares equal whatever Nova's emission would spell
  differently.
- **Language names and seeds.** On a deployment whose app mapping is `adopted`, a language's display
  name is no part of Nova's translations (part 01, 7.2), and a publish writes none of the fifteen
  seeded settings the project space holds no value for (part 01, 7.3). `hqImportApplication` cannot
  see the mapping, so both rules travel on its input: `importApplication.ts::HqImportApplicationInput`
  gains `readonly languageNames: "nova" | "target"` and `readonly seeds: "nova" | "target"`, both
  `"target"` exactly where `inPlaceUpdate?.ownership === "adopted"` (never for an app this publish
  created), computed once in `publishAppToHq` and passed to its three `hqImportApplication` calls,
  which hand both to `projectApplicationForTarget` (part 01, 7.2 and 7.3).
  `hqSourceBaseline.ts::diffHqAppSource` takes `languageNames` alone, since the ownership descriptor
  names none of the fifteen settings: its input gains the field, which it hands to
  `ownedTranslations`. `publishAppToHq` passes the same `languageNames` to its own `diffHqAppSource`
  of the second read and to `runDeploymentPreflight`, whose `appRemoteChange` passes it on.
  `adoptedAppBaselineWrite` passes `"target"` for both; `proof/corpus/publish.ts` passes `"target"`
  for both for an HQ-authored A from this pull request on (`hq-plain` is one from A1), and `"nova"`
  for every other document. Part 01's `refreshKeptValues` reads the live mapping's ownership the
  same way for the `languageNames` of its `diffHqAppSource`.
- **`webApps.ts::webAppsChange`**: `changedInHq` is computed for `read` as for `push` and `cutover`
  (the baseline's `cloudcare_enabled` against the value HQ holds now). `WebAppsChangeInput` gains
  `readonly since: DriftReference`, which the `web-apps` edge computes with
  `driftReferenceOf(appBaseline, input.inPlaceUpdate)` (9.1), and the change carries it (9.2).
- **`service.ts::publishAppToHq`**: `appPreviewNote` is also given where
  `appBaseline?.origin === "read"`. The first publish replaces every form's source, and HQ keeps a
  form's last check for up to seven days, which `APP_PREVIEW_NOTE` already says.
- **Readers that do not change.** `webAppsChange`'s `create` test and the `web-apps` edge's `create`
  test for its passed detail; `publishAppToHq`'s `heldOwnership` (null only for `unread`) and `shell`
  (`create` only); `appRemoteChange`'s `unread` and `create` tests. Each already treats `read` as it
  treats `push`.

**The ownership descriptor.**

```ts
/** `lib/deployment/adoption.ts`. */
export function adoptedAppBaselineWrite(input: {
	readonly remoteAppId: string;
	/** The source the creation accepted. */
	readonly source: HqAppSource;
	readonly prepared: Pick<PreparedExportBoundary, "doc" | "assets" | "attachmentTarget" | "lookupNaming">;
	readonly target: DeploymentTargetKey;
	/** `targetWireIdentity(rows)` of 3.1. */
	readonly identity: WireIdentity;
	readonly identityMap: readonly IdentityMapEntry[];
	readonly observedAt: string;
}): AppBaselineWrite & { readonly origin: "read" };
```

B7 adds the input `firstPublish: FirstPublishView` and the member `firstPublish: StoredFirstPublish |
null` (part 09, 12.3): the input to `adoptedAppBaselineWrite`, the member to `AppBaselineWrite`. In
B8 neither exists, and the baseline row's `first_publish_changes` is null.

`ownership` is `hqImportApplication({ prepared, target, compatibility: { advisories: [] }, update:
{ appId: remoteAppId, source }, identity, languageNames: "target", seeds: "target" }).ownership`,
called as a publish over an adopted mapping calls it (part 01, 7.2 and 7.3): the descriptor the first
publish's body would give over this read. The baseline's `identityMap` is
`{ kind: "store", map: encodeIdentityMap(identityMap) }`. With no advisory,
`derivedProfileTargetState` answers `not-needed` or `unverified`, and both give no owned custom
profile property, which is right: Nova has not written that key here, and a first publish that does
write it owns it from its own baseline on. `addOns` are the add-ons the document needs,
`profileProperties` the two settings Nova always writes, and `autoGpsCapture` true exactly for a
Connect app. A source `normalizeHqAppSource` calls malformed makes this function throw: acceptance
has already read that source.

### 6.4 `publishedRemoteApp` of a fresh adoption

`resources.ts::plannedInPlaceUpdate` returns the adopted mapping (live, not gone, not released, see
7.1), `remoteAppHoldsContent` is true, so `publishedRemoteApp` returns it and `nextPublishAction`
answers `updates`. `stateMachine.ts::deploymentIsObservable` is true at `uploaded`, so Check status
reads HQ's builds for it from the first minute. A test holds each of these on a row the writer made.

### 6.5 Confirmations recorded at adoption

```ts
/** `lib/deployment/adoption.ts`. The plan features the app's source already uses. */
export function adoptionPlanFeatureConfirmations(input: {
	readonly doc: BlueprintDoc;
	readonly target: DeploymentTargetKey;
	/** `HqAppSource.cloudcareEnabled` of the accepted source. */
	readonly sourceWebAppsOn: boolean;
	/** Whether `publishedCaseBlocks` reads a Save to Case block in the accepted source: acceptance's
	 *  `sourceHoldsSaveToCase` (part 09, section 2.2, B7), over part 07's extension of that reader
	 *  (`07-the-reader-cases-menus-lists.md`, section 6.1, B4). */
	readonly sourceHoldsSaveToCase: boolean;
}): readonly DeploymentConfirmationKey[];
```

It is `requiredPlanFeatures(doc, { lookupTables: false, places: false },
attachmentUrlTarget(target))`, each as a `plan-feature` key, less two:

| Feature | Recorded when |
|---|---|
| `web-apps` | the document declares Web Apps and `sourceWebAppsOn` |
| `advanced-case-actions` (Save to Case) | the document needs it and `sourceHoldsSaveToCase` |
| `worker-records`, `lookup-tables`, `child-cases`, `form-links`, `organization`, `data-forwarding` | the document needs it |

Each of the last six is needed because of content the reading took from HQ's app as it is (a form
that reads the worker's record, a select over a table, a basic subcase, a form link, a Connect block).
That content does not prove the plan: CommCare HQ keeps content a plan no longer covers, which is
what each feature's own consequence line says (`lib/publish/planFeatures.ts::PLAN_FEATURES`: without
Form links "The links Nova wrote stay", without Child Cases "The app itself runs the same"). The
reason these are recorded is another one: the first publish leaves each of them exactly as the source
app already has it. It adds no such form, link or block, and it sends no table and no place
(`pushes` is all false, and a table or places managed in CommCare HQ are never pushed, B9), so
whatever the project space's plan does with that content today, it does the same after the publish,
and asking the person would change nothing they could decide. That is this plan's rule that bringing
an app in asks no confirmation its source project space already answers (the top-level file
`../6-bring-in.md`, "What changed from the outline, and why", item 9). Web Apps is the person's
declaration, which the review lets them change, and Save to Case could come from a placement Nova's
emission gives, so each of those two is recorded only where HQ's own source shows the app already
uses it.

No project-space setting (`flat-location-fixture`, `connect-forwarder`, `form-entry-sync-off`,
`commtrack-off`) is recorded: the first publish asks for those, since the same rule leaves to the
first publish whatever the source does not already answer. Each row is attributed to the person who
brought the app in and is withdrawn like any other (`withdrawDeploymentConfirmation`). The review
says which features Nova won't ask about and why
(Copy; part 13 (`13-the-experience.md`), section 8.8, B11, places the line). The birth calls this
function over the candidate's document, the target, `source.cloudcareEnabled` and
`accepted.sourceHoldsSaveToCase` (part 12, section 6.2, B10).

---

## 7. Publish over an adopted deployment

### 7.1 Four changes to `publishAppToHq`

1. **The ownership it records.** The call of `recordRemoteResource` passes
   `ownership: createdApp ? "nova-created" : (inPlaceUpdate?.ownership ?? "nova-created")` and, where
   that is `adopted`, `adoptedBy: inPlaceUpdate.adoptedBy`. `writeResourceMapping`'s conflict arm then
   keeps the first `adopted_at` and `adopted_by` (its `COALESCE`). An app this publish created, the
   recreate after HQ reported an adopted app gone among them, is `nova-created`: Nova made it.
2. **A released mapping is settled first.** Right after `readDeployment`, where the live `app`
   mapping's `releasedAt` is not null, it calls `store.ts::settleReleasedClaims(scope)`, which runs
   a transaction in 5.4's order: `lockReleasedClaimsInTransaction` (on null the transaction ends and
   another starts, three at most, as in `restoreApp`), the Project and `edit` role proved on the
   locked app row as `lockAppForDeploymentWrite` proves them, then
   `settleReleasedClaimsInTransaction` over every released claim of the app, with the publisher as
   the actor. The publish reads the deployment again. Reclaimed, it goes on. Ended, it goes on as a
   publish to an ended deployment (8.6), and the outcome's deployment says why. A third null
   (`{ settled: false }`) answers the publish `landed: false` with the failure code
   `app_changed_while_publishing`, which exists today and means the same to a caller (nothing was
   sent, and publishing again is the way on), with the sentence `PUBLISH_CLAIMS_CHANGED` (Copy).
   `plannedInPlaceUpdate` also answers null for a released mapping, so no reader plans an update
   over one.
3. **The fence of 8.5.** Every store write passes the count of endings the first read held.
4. **Language names and seeds.** It computes `languageNames` and `seeds` from the mapping it updates
   and passes them on (6.3).

```ts
/** `lib/deployment/store.ts`. Settles every released claim of the scope's app, as change 2 says. */
export async function settleReleasedClaims(scope: DeploymentScope): Promise<
	| { readonly settled: true;
	    /** The project spaces the settle ended, because a live Nova app publishes there now. */
	    readonly stoppedPublishing: readonly { readonly server: string; readonly domain: string }[] }
	/** Three tries each found the claims changed under their locks. Nothing was written. */
	| { readonly settled: false }
>;
```

`recordCreatedRemoteApp` is unchanged: a shell is `nova-created`.

### 7.2 The first publish, phase by phase

- **Preflight.** `nextPublishAction` is `updates`. `plan-features` asks only for what 6.5 did not
  record and for the settings. `project-data` and `organization` are B9's for a managed table and
  managed places. `target-app` reads the source, holds it to the 2.57 floor, and compares it with the
  `read` baseline: an app nobody touched compares equal. `hq-changes` gives its one verdict, in the
  words of 9. `web-apps` asks where the review's declaration differs from HQ's setting.
- **Placements.** `placementsToHold(doc)` is empty where the reader held every placement, so no
  `publish-placement` change is written and the pushed revision is the head.
- **The record.** `foldDeploymentAttempt` for the passed preflight changes no state, since the
  deployment displays as reached, and stores the confirmations the person gave.
- **No shell.** `targetApp` is not null, so no app is created and `shell` is false: the profile the
  body is built over is HQ's, untouched (`fillSource`).
- **Resources.** Whatever B9 pushes; an app with only managed tables and places pushes nothing, and
  the second read is not made.
- **The import.** `hqImportApplication` over the `target-app` read with
  `identity = targetWireIdentity(overrides)`, the dense rows, so every menu id, form id and `xmlns` is
  HQ's own (`_merge_source_into_app` replaces `modules` whole and writes ids as sent). It carries
  `languageNames` and `seeds` at `"target"`, so each language's name and each seeded setting HQ
  holds no value for stay as HQ has them (6.3).
- **The read-back** is the new baseline: origin `push`, the ownership of the body sent, the identity
  map of the document sent (10). From B7 the same upsert sets `first_publish_changes` null, which
  ends the list the person reviewed (part 09, section 12.3).
- **The mapping** stays `adopted`, with its first attribution, `pushed_revision` the head, and
  `remote_revision` the import's answer.
- **Media.** The bulk upload names HQ's paths (4.3). `appPreviewNote` is given.

### 7.3 Stops

The drift stop and its discard work as for any deployment. A discard is recorded with the `push`
baseline of the publish that used it. "Stop publishing here" (8) is offered beside "Publish over
this". A `read` baseline that no longer verifies reads `unread` and stops the publish to ask, in the
words of 9. HQ reporting the app gone marks the mapping as today; the next publish creates an app
that keeps the deployment's identity rows and media paths, so submissions keep their `xmlns`.

---

## 8. Ending a deployment

### 8.1 The state

```ts
// lib/deployment/types.ts
export const DEPLOYMENT_STATES = [
	"preflight", "resources", "uploaded", "built", "released", "runnable", "incomplete", "ended",
] as const;
export const DEPLOYMENT_END_REASONS = ["stopped", "claimed-elsewhere"] as const;
export type DeploymentEndReason = (typeof DEPLOYMENT_END_REASONS)[number];
export interface DeploymentRecord { /* as today, then: */ readonly endings: number }
export interface DeploymentResource {
	// as today, then:
	readonly adoptedByName: string | null;
	readonly releasedAt: string | null;
	readonly endedReason: DeploymentEndReason | null;
	readonly endedByName: string | null;
}
```

`ended` is not a progress state: `stateMachine.ts::deploymentProgressIndex` answers null for it, so
`deploymentHasReached`, `deploymentDisplaysAsReached` and `deploymentIsObservable` are false with no
change to their bodies. One function changes:

```ts
export function applyAttemptOutcome(record, phase, outcome) {
	if (deploymentDisplaysAsReached(record, "uploaded")) return record;
	/* A refused attempt leaves an ended deployment ended: the project space holds nothing this
	 * app publishes to, as before a first publish, where a refused attempt writes no row. */
	if (record.state === "ended" && outcome.status !== "succeeded") return record;
	return applyPhaseOutcome(record, phase, outcome);
}
```

A preflight that passes moves `ended` to `preflight`, and the publish goes on as a first publish.

The ending's who, when and why live on the mapping it superseded (`superseded_at`, `ended_by`,
`ended_reason`), which is kept as every superseded mapping is, so they outlive a later publish.

```ts
/** `lib/deployment/resources.ts`. The ending this deployment still stands at, else null. */
export function deploymentEnding(view: DeploymentWithResources): {
	readonly at: string; readonly byName: string;
	readonly reason: DeploymentEndReason; readonly hqAppId: string;
} | null;
```

It reads the mappings and never the state: where the deployment has no live `app` mapping and its
superseded `app` mapping with the greatest `supersededAt` has an `endedReason`, it is that mapping;
else null. The state would be the wrong witness. A publish to an ended deployment that passes
preflight moves the state to `preflight`, and one that then stops before it makes the new app (a
head that moved three times, `app_changed_while_publishing`; a create CommCare HQ refuses) leaves
`preflight` or `incomplete` with the old HQ app still there and no new one. Read from the mappings,
the ending's line and `creates-beside` (8.6) stay until a publish records a new app, and go the
moment one does.

### 8.2 The transaction: `endDeploymentInTransaction`

```ts
/** `lib/db/hqAppClaims.ts`. */
export async function endDeploymentInTransaction(
	tx: Transaction<AppDatabase>,
	input: { readonly deploymentId: string; readonly appId: string; readonly byUserId: string;
	         readonly reason: HqAppEndReason; readonly at: Date },
): Promise<{ readonly ended: boolean }>;
```

The caller holds the app row lock: `FOR SHARE` with the deployment row `FOR UPDATE` in
`endDeployment` (8.3), `FOR UPDATE` in a settle (5.4), which shuts out every `withDeploymentRow`
writer of the app. `<all null>` below is this module's `NO_PHASE_OUTCOMES_JSON` (5.2). In order:

1. `UPDATE app_deployment_resources SET superseded_at = at, ended_by = byUserId, ended_reason =
   reason, released_at = NULL WHERE deployment_id = $1 AND kind = 'app' AND superseded_at IS NULL`. No
   row: return `{ ended: false }` and change nothing.
2. `DELETE FROM app_deployment_identities WHERE deployment_id = $1`.
3. `DELETE FROM app_deployment_media_paths WHERE deployment_id = $1`.
4. `UPDATE app_deployments SET state = 'ended', resume_phase = NULL, phases = <all null>,
   endings = endings + 1, content_generation = gen_random_uuid(), entry_point_manifest = NULL,
   entry_point_observation = NULL, offered_logo_content_hash = NULL,
   target_empty_case_list_text = NULL, last_observed_at = NULL, updated_at = at WHERE id = $1`.
5. `notifyAppDeployments(tx, appId)`, so every open tab re-resolves Preview's project space.

Kept: the baseline row ("its baseline stays as history"; the next create there replaces it, since
`writeAppBaseline` replaces a row for another HQ app); every confirmation (they are about the project
space); every `lookup-table`, `location` and `worker` mapping (what Nova put there is still there, and
a later publish updates it in place).

The index entry goes with `superseded_at`, so the HQ app is free the moment this commits.

### 8.3 "Stop publishing here", server side

```ts
/** `lib/deployment/store.ts`. An admin or owner of the app's Project; `not_permitted` for an editor. */
export async function endDeployment(
	scope: DeploymentScope, target: DeploymentTargetKey,
): Promise<DeploymentWithResources>;
/** `lib/deployment/service.ts`. The one lifecycle the builder and MCP share. */
export async function stopPublishing(
	scope: DeploymentScope, target: DeploymentTargetKey, doc: BlueprintDoc,
): Promise<{ readonly deployment: DeploymentWithResources; readonly artifact: SetupArtifact }>;
/** `lib/deployment/actions.ts`. Input: `deploymentTargetSchema`. */
export async function stopPublishingAction(input: unknown):
	Promise<DeploymentActionResult<DeploymentView & { readonly previewProjectSpace: string | null }>>;
```

- **Who.** An admin or an owner of the app's Project: the members who hold `delete` on its apps
  (`lib/auth/projectRoles.ts`), the capability a delete and a move already ask for. An editor can see
  the deployment and publish to it, so the honest answer to an editor names who can stop, and is not
  "not found". Neither existing gate can give that answer: `actions.ts::resolveScope` turns every
  `AppAccessError` into `notFound()`, and `store.ts::lockAppForDeploymentWrite` throws
  `deploymentNotFound()` for a role that lacks the capability it was asked for. So:
  - `stopPublishingAction` resolves its scope at `"edit"`, as `refreshDeploymentAction` does.
    `resolveScope`'s capability union does not change. A viewer or a stranger gets `not_found`.
  - `endDeployment` runs one `withAppTx`: `const role = await lockAppForDeploymentWrite(tx, scope,
    "edit")` (which now returns the role it read under the lock, 6.2); where
    `roleAllowsApp(role, "delete")` is false it throws `DeploymentError("not_permitted", <Copy>)`;
    then the deployment row `FOR UPDATE`, then `endDeploymentInTransaction` with reason `stopped`.
  - `lib/deployment/errors.ts::DeploymentErrorCode` gains `"not_permitted"`: "The caller can see and
    edit the deployment and may not do this to it. Its message names who may."
  - `actions.ts::DeploymentActionResult`'s failure codes gain `"not_permitted"`, and
    `actions.ts::failure` answers a `DeploymentError` of that code with it and the error's message.
  - `lib/mcp/errors.ts` maps the code to the tag `permission_denied`, which exists for a member who
    lacks a capability, and `lib/apiError.ts` to status 403, beside `domain_not_authorized`.
- **Nothing to stop.** No deployment for the target is `deploymentNotFound()`. A deployment with no
  live `app` mapping (`{ ended: false }`) is `DeploymentError("invalid", ...)`.
- **What it asks of CommCare HQ.** Nothing. The HQ app is not read and not written, so no key is
  needed and a person whose key no longer reaches the project space can still stop.
- **A shell.** A deployment whose live mapping is the empty app of a first publish can be stopped
  too: the empty app stays in HQ, and the ended card's line links to it (8.6).
- **MCP.** `stop_publishing` (B12 registers it; Departure 3): input
  `{ app_id: string, server: "production" | "india" | "eu", domain: string }`, scope
  `nova.hq.write` through `oauthScopeChallenge` and `assertScope` as
  `withdraw_deployment_confirmation` does. It calls `stopPublishing` and returns `{ app_id,
  ...describeDeployment(deployment, identities), setup_artifact }`, as `refresh_deployment` returns;
  the served schema and the description are part 13's (`13-the-experience.md`, section 14.5, B12).

### 8.4 Deleting and restoring an app

Moving an app to recently deleted ends nothing and writes nothing (5.3). Restoring it re-claims or
ends each released deployment (5.4), with reason `claimed-elsewhere`. An app whose HQ app nobody took
comes back exactly as it was.

### 8.5 A publish in flight when a deployment ends

No lock spans a publish's round trips to HQ, so an ending can land in the middle of one. Without a
fence, that publish's `recordRemoteResource` would insert a live mapping to the old HQ app on a
deployment whose identity rows are gone, and the publish after it would send derived ids to an app
whose forms have HQ's: every form's `xmlns` would change.

- `publishAppToHq` reads `endings` once, from its first `readDeployment` (0 where there is no row),
  after 7.1's settle.
- `withDeploymentRow`'s options gain `expectedEndings?: number`. Under the row lock, where it is given
  and differs from the row's `endings`, it throws `DeploymentEndedError` and writes nothing:

  ```ts
  // lib/deployment/errors.ts
  /** A store write found the deployment ended since its publish first read it. Never shown to a
   *  person: `publishAppToHq` catches it. It is no `DeploymentError` and carries no code. */
  export class DeploymentEndedError extends Error {
  	readonly name = "DeploymentEndedError";
  	constructor(
  		readonly deploymentId: string,
  		/** The count the writer was given, and the count the locked row holds. */
  		readonly expectedEndings: number, readonly endings: number,
  	);
  }
  ```

- These writers require it: `foldDeploymentAttempt`, `beginDeploymentContentWrite`,
  `recordCreatedRemoteApp`, `recordPushedResources`, `markResourceBaselinesUnread`,
  `recordRemoteResource`, and `recordRefreshedAppBaseline`, the baseline write of part 01's
  `refreshKeptValues` (its section 6.5).
  `finishDeploymentContentWrite` takes it and, on a mismatch, returns false and writes nothing (the
  ending already cleared the manifest and rotated the generation).
  `workers.ts::provisionWorkers` passes the count from its own read to `recordPushedResources`.
- Four `withDeploymentRow` users take none, each for its own reason.
  `applyDeploymentObservation` folds only while the live `app` mapping still carries the remote id
  and the `push_token` the observation read, and `recordEntryPointObservation` only for the
  generation and the mapping it checked; an ended deployment has no live mapping and a new
  generation, so both write nothing. `withdrawDeploymentConfirmation` reads no mapping at all: it
  acts on a confirmation, which is about the project space and which an ending keeps (8.2), so
  withdrawing one after an ending is as right as before it. `readEntryPointEvidence` writes nothing.
- `publishAppToHq` catches `DeploymentEndedError` once, around everything after its first read, and
  answers `landed: false` with the failure code `publishing_stopped` (new in
  `DEPLOYMENT_FAILURE_CODES`), the phase it was in, the deployment as it now stands, and one of two
  messages by whether anything had been sent to HQ (Copy). `lib/mcp/tools/uploadAppToHq.ts::
  UPLOAD_ERROR_TAGS` and `lib/mcp/errors.ts` gain the tag in B8 so their maps stay total; the tool's
  description sentence is B12's (part 13, section 14.7).

**What the fence cannot close.** A publish already running on the previous revision when the deploy
lands knows no `endings`. If a person stops that deployment through the new revision in those
minutes, that publish can still record its mapping. The window is one deploy's drain, and the remedy
is to stop the deployment again.

A publish that was sent before the ending and landed after it leaves HQ updated with HQ's own ids,
which is a valid app. Nova keeps no record of it, and says so.

### 8.6 What every reader does with an ended deployment

| Reader | What it does | Change |
|---|---|---|
| Preview's project space (`readDeploymentPreviewRecords`, `resolvePreviewDeploymentTarget`) | `ended` does not display as `uploaded`, so the project space is not named; the ending's notify re-resolves open tabs | none for an ending. For 5.3's released mapping on a live app, whose state still displays as `uploaded`, `readDeploymentPreviewRecords` gains one filter: `NOT EXISTS` a live `app` mapping of the deployment with `released_at IS NOT NULL` |
| `.ccz` (`readReachedDeploymentTargets`, `chooseDownloadTarget`) | no live mapping, so it is not a target; `unknownProjectSpace`'s sentence is true as written | none |
| the HQ app file's attachment links | as the `.ccz`: not a reached target | none |
| deep links (`getEntryPointLink`) | no manifest and no published app: "Publish this app again before creating a link." | none |
| Check status (`refreshDeployment`) | where `deploymentEnding` is not null, says the publishing stopped, in place of "hasn't reached" | sentence (Copy) |
| provisioning workers (`provisionWorkers`) | where `deploymentEnding` is not null, refuses, saying the publishing stopped | sentence (Copy) |
| the Publishing card and the dialog's row (`deploymentEnding`, `nextPublishAction`) | while `deploymentEnding` is not null: no Check status, no Workers panel, the ending's line and a link to the HQ app, and `nextPublishAction` answers the new arm `creates-beside`. At state `ended` there is no ladder; after a publish that stopped before its create, the card draws that attempt's refusal as it does for any deployment, under the ending's line | part 13 (`13-the-experience.md`, section 11.1, B11) draws it from this part's data and Copy |
| the left-behind report (`leftBehindResources`) | a superseded `app` mapping with an `endedReason` is not left behind: the card's line names it | one test in the filter |
| `earlierHqApps` (the `.ccz` version) | counts the ended mapping like any superseded `app` mapping, so a `.ccz` made after a fresh publish is newer | none |
| the setup artifact (`setupArtifactFor`) | no HQ app id, so no link into an app's pages | none |
| placements' recorded holds (`readRecordedPlacementHolds`, `placementChangeRefusal`) | read the document and its recordings, never a deployment | none: ending changes no hold. Answers already sit where a hold says, in the HQ app that stays and in every other project space |
| migration notices (`lib/notices`) | a stored deployment entry names its project space and renders as stored | none |
| kept values (part 01's `readTargetFacts`, `refreshKeptValues`, `previewTargetFactsFor`) | the `.ccz` and Preview reach facts through a reached target, which an ended deployment is not, and the ended card shows no kept list. `refreshKeptValues` is the one that needs a change: as part 01 writes it (its section 6.5, step 1), it answers `no-baseline` for a deployment with no live `app` mapping, and an ended deployment has none, so it would read `no-baseline`'s "Publishing again reads it", which is false there. And it knows nothing of a released mapping, which is live and is not published to (5.3) | B8 adds two tests ahead of its step 1. Where `deploymentEnding(view)` is not null it throws the `DeploymentError("invalid", ...)` that `refreshDeployment` throws for an ended deployment, with the same sentence (Copy). Where the live `app` mapping is released it answers `no-baseline`. No live `app` mapping for any other reason stays part 01's own `no-baseline` |
| drift | no mapping, so nothing is compared | none |

`lib/deployment/resources.ts::NextPublishAction` gains one member and becomes
`"creates" | "creates-beside" | "fills-shell" | "updates"`: `creates-beside` exactly while
`deploymentEnding(deployment)` is not null, and `creates` for every other deployment with no app to
update.

### 8.7 A later publish creates afresh

A publish to an ended deployment is a first publish in every step: no in-place update is planned, no
identity row and no media path exists, so the shell and its fill carry derived ids and derived paths.
The project space then holds two apps, HQ's and Nova's new one, with no `xmlns` in common. The
`preflight` fold moves the state from `ended`; `recordCreatedRemoteApp` inserts the new live mapping,
which takes the index entry for the new HQ app; the `create` baseline replaces the old one. Tables and
places the deployment still maps are updated in place.

---

## 9. Drift wording by baseline origin

### 9.1 The reference

```ts
// lib/publish/driftReference.ts (new, client-safe)
/** What a change in CommCare HQ is measured against. `at` is when the app was brought in. */
export type DriftReference =
	| { readonly kind: "published" }
	| { readonly kind: "brought-in"; readonly at: string };
/** Whose calendar day a drift sentence names. Both default to `DEFAULT_DRIFT_DATE`'s. */
export interface DriftDateOptions { readonly locale?: string; readonly timeZone?: string }
export const DEFAULT_DRIFT_DATE = { locale: "en-GB", timeZone: "UTC" } as const;
/** A day, month and year, such as "10 November 2026". A locale or zone `Intl` refuses reads as
 *  the default's. */
export function driftDate(at: string, options?: DriftDateOptions): string;
/** The reader's own: `navigator.language` and the browser's resolved time zone. Browser only. */
export function viewerDriftDate(): DriftDateOptions;
// lib/deployment/remoteChanges.ts
export function driftReferenceOf(
	baseline: AppBaseline | null, mapping: Pick<DeploymentResource, "adoptedAt"> | null,
): DriftReference;
```

`brought-in` where the baseline's origin is `read`, or `unread` with `storedOrigin` `read`;
`published` for every other baseline and for none. `at` is the app mapping's `adoptedAt` and never the
baseline's `observedAt`: part 01's "Refresh from CommCare HQ" rewrites a `read` baseline's source and
its date and keeps its origin, and the app was still brought in when it was. (A `read` baseline's
live mapping is always the adopted one; were `adoptedAt` ever null there, `at` is the baseline's
`observedAt`, so the function is total.) A lookup table's and a place's reference is always
`published`: their baselines are written by a push.

`lib/deployment/types.ts::DeploymentRemoteChange` gains `readonly since: DriftReference`.
`WebAppsChange` (`lib/publish/webApps.ts`) gains `readonly since: DriftReference`, and
`WebAppsChangeInput` gains it too (6.3). `components/builder/publishOutcome.ts` reads an absent
`since` on either as `{ kind: "published" }`, as it defaults every field a server that predates it
leaves out.

**The date is in the sentence, and it is the reader's day.** The brought-in wording is "since Nova
brought it in on <date>". These sentences are built on the server (`preflight.ts` writes them into
the check's `detail` and the refusal's `message`, which the dialog, MCP and the logs all read as one
text), and the server does not know the reader's time zone. A date in the server's zone would be
wrong by a day for a person who brought the app in on their evening and publishes the same evening.
So the reader's zone travels with the request that can stop on drift, and there is one such request:

- `app/api/commcare/upload/route.ts`'s body gains the optional `viewer: { locale: string, timeZone:
  string }`, which `PublishDialogBody.tsx` fills from `viewerDriftDate()` on every publish. The route
  reads it leniently, unlike the consent-bearing fields beside it: anything but an object of two
  strings is absent, and a locale or a zone `Intl.DateTimeFormat` refuses falls back to the default
  inside `driftDate`. It decides how one date is spelled and nothing about what is written, so a
  malformed one never refuses a publish.
- `service.ts::PublishInput` gains `readonly driftDate?: DriftDateOptions`, which `publishAppToHq`
  hands to `runDeploymentPreflight` (its input gains the same field) for the `hq-changes` and
  `web-apps` edges.
- MCP's `upload_app_to_hq` passes none, so its sentences name the UTC day, and its projection
  carries `since.at` as ISO text for a client that wants the instant (part 13, section 14.7, B12).
- The one drift sentence the browser builds itself, the per-change `baselineUnknownSentence` in
  `PublishDialogBody.tsx`, passes `viewerDriftDate()`, the same values the request sent, so every
  date in one dialog is the same day.

No brought-in sentence is ever stored: an adopted deployment displays as reached from its birth, so
a refusal on it is the attempt's and is not folded into the record (`applyAttemptOutcome`), and an
ended deployment compares nothing.

### 9.2 Every sentence

`remoteChanges.ts`, by export. "Unchanged" means the text and the name stay. Each of the four
constants that gains a brought-in wording **stays exported with its text unchanged** and gains a
function beside it, whose `published` arm returns the constant. Their importers keep compiling
(`lib/deployment/index.ts`, `preflight.ts`, `components/builder/PublishDialogBody.tsx`,
`components/builder/__tests__/publishOutcome.test.ts`, `e2e/tests/browser/publishing.spec.ts`,
`publishSequence.postgres.test.ts`), and B8 moves the three production readers to the functions:
`preflight.ts`'s `hq-changes` edge, and `PublishDialogBody.tsx`'s per-change sentence, which becomes
`baselineUnknownSentence(change.since, viewerDriftDate())`. `{date}` is `driftDate(since.at,
options)`, and `options` is each function's last, optional argument:

```ts
// lib/deployment/remoteChanges.ts
/** `changes` are the refusal's own, in its order. A `brought-in` date is the app change's. */
export function hqChangedMessage(
	changes: readonly Pick<DeploymentRemoteChange, "since">[], options?: DriftDateOptions,
): string;
export function baselineUnknownSentence(since: DriftReference, options?: DriftDateOptions): string;
export function hqChangesConfirmedDetail(since: DriftReference, options?: DriftDateOptions): string;
export function hqChangesNoneDetail(since: DriftReference, options?: DriftDateOptions): string;
// lib/publish/webApps.ts
export function webAppsChangeMessage(
	space: string, change: WebAppsChange, options?: DriftDateOptions,
): string;
```

| Export | Today | From step 6 |
|---|---|---|
| `HQ_CHANGED_MESSAGE` | "Something this app publishes isn't the same in CommCare HQ as when Nova last published it, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version." | gains `hqChangedMessage(changes, options)`. Every change `published`: the constant. Every change `brought-in` (only the app's can be, so this is the app listed alone): "Something in this app isn't the same in CommCare HQ as when Nova brought it in on {date}, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version." Both kinds listed: "Something this app publishes isn't the same in CommCare HQ as when Nova last read it there, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version." |
| `HQ_CHANGED_DURING_PUSH_MESSAGE` | "CommCare HQ's copy of this app changed while Nova was publishing its lookup tables and places, so Nova stopped before sending the app's content. Publishing again checks what is there now and lists anything that changed." | unchanged |
| `BASELINE_UNKNOWN_SENTENCE` | "Nova couldn't confirm what its last publish left here, so it can't tell whether anything changed." | gains `baselineUnknownSentence(since, options)`. `published`: the constant. `brought-in`: "Nova couldn't confirm what CommCare HQ held when it brought this app in on {date}, so it can't tell whether anything changed." |
| `LOOKUP_DISCARD_NOTE`, `LOOKUP_ADOPTION_NOTE`, `lookupTableMadeAgainWarning` | as written | unchanged |
| `APP_READ_BACK_FAILED_WARNING`, `RESOURCES_READ_BACK_FAILED_WARNING` | as written | unchanged |
| `APP_PREVIEW_NOTE` | as written | unchanged; also given after a first publish over a `read` baseline (6.3) |
| `HQ_CHANGES_CONFIRMED_DETAIL` | "You chose to publish over what changed in CommCare HQ since Nova last published it." | gains `hqChangesConfirmedDetail(since, options)`. `published`: the constant. `brought-in`: "You chose to publish over what changed in CommCare HQ since Nova brought this app in on {date}." |
| `HQ_CHANGES_NONE_DETAIL` | "Nothing this app publishes has changed in CommCare HQ since Nova last published it." | gains `hqChangesNoneDetail(since, options)`. `published`: the constant. `brought-in`: "Nothing in this app has changed in CommCare HQ since Nova brought it in on {date}." |
| `HQ_CHANGES_NOTHING_TO_COMPARE_DETAIL` | "Nova hasn't published this app's content here before, so there's nothing in CommCare HQ to compare yet." | unchanged: an adopted deployment always has something to compare |
| `describeAppChange`, `describeLookupChange`, `describePlaceChange`, `boundedParts` | as written | unchanged: a part names what changed, never since when |

The check's `since` for the two details is the app baseline's reference where the app was compared,
else `published`.

`lib/publish/webApps.ts::webAppsChangeMessage(space, change, options)`, the two sentences given where
`changedInHq` is true. `options` is new, optional and last, so today's callers compile:

| Arm | Today | From step 6, where `change.since.kind` is `brought-in` |
|---|---|---|
| to on | "Someone turned this app's Web App setting off in CommCare HQ since Nova last published it to “{space}”. This app runs in Web Apps, so publishing turns it back on, and workers there can open it in Web Apps from the next version Web Apps serves, usually the next one you release. Where a project space's plan doesn't include Web Apps, saving the app's settings in CommCare HQ turns it off." | "Someone turned this app's Web App setting off in CommCare HQ since Nova brought it in from “{space}” on {date}. This app runs in Web Apps, so publishing turns it back on, and workers there can open it in Web Apps from the next version Web Apps serves, usually the next one you release. Where a project space's plan doesn't include Web Apps, saving the app's settings in CommCare HQ turns it off." |
| to off | "Someone turned this app's Web App setting on in CommCare HQ since Nova last published it to “{space}”. This app runs on Android only, so publishing turns it back off, and from the next version Web Apps serves, nobody there can open the app in Web Apps." | "Someone turned this app's Web App setting on in CommCare HQ since Nova brought it in from “{space}” on {date}. This app runs on Android only, so publishing turns it back off, and from the next version Web Apps serves, nobody there can open the app in Web Apps." |

The `published` arms and the two sentences for `changedInHq` false or null are unchanged.
`WebAppsChange.since` is required, so every place that builds one by hand gains
`since: { kind: "published" }`: `e2e/tests/browser/publishing.spec.ts` (its `webAppsChangeMessage(
"alpha", change)`), `lib/deployment/__tests__/publishGates.postgres.test.ts` and
`lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`.

Four sentences elsewhere say Nova made or published the app, which is false for an adopted one:

| Where | Today | From step 6 |
|---|---|---|
| `preflight.ts::hqAppSourceReadFailure`, the linked-app arm | "The app on “{domain}” is a linked app in CommCare HQ, and Nova only updates apps it made. Nova left it unchanged. You can publish to another project space, or remove the link in CommCare HQ and publish again." | "The app on “{domain}” is a linked app in CommCare HQ, and Nova can't update a linked app. Nova left it unchanged. You can publish to another project space, or remove the link in CommCare HQ and publish again." |
| `preflight.ts::remoteAppMissingFailure` | "The app Nova published to “{domain}” isn't there any more: CommCare HQ reported it gone when Nova tried to update it. It may have been deleted there. Publish again to create a fresh one." | "The app this one publishes to on “{domain}” isn't there any more: CommCare HQ reported it gone when Nova tried to update it. It may have been deleted there. Publishing again creates a new one." |
| `observe.ts::observeDeployment`, the gone outcome (`remote_app_missing`), which Check status reaches on an adopted deployment whose HQ app was deleted before any publish | "The app Nova published to “{domain}” isn't there any more. It may have been deleted on CommCare HQ. Publish again to create a new one." | "The app this one publishes to on “{domain}” isn't there any more. It may have been deleted on CommCare HQ. Publishing again creates a new one." |
| `components/builder/DeploymentStatus.tsx`, the gone line | "Publishing again creates a new app on CommCare HQ, because the one Nova made is gone." | moves to `lib/publish/stopPublishing.ts::GONE_APP_NEXT_PUBLISH`: "Publishing again creates a new app on CommCare HQ, because the one that was there is gone." |

`remoteAppMissingFailure` changes its subject and its last sentence, which ends as its twin in
`observe.ts` does: both invite ("Publishing again creates a new one.") where today's two instruct.

### 9.3 The test that holds them

`lib/deployment/__tests__/remoteChanges.test.ts` gains a table: for each sentence function and each
`DriftReference["kind"]`, the exact text above, with `at` `2026-11-10T23:30:00.000Z`: under the
default options the brought-in text says "10 November 2026", and under `{ locale: "en-GB", timeZone:
"Pacific/Auckland" }` it says "11 November 2026" (the date follows the reader and not the server);
an unknown zone reads as the default. Each `published` arm equals its constant. The functions switch
on the kind with a `never` default, so a third kind fails to compile until it has a sentence.
`driftReferenceOf` is tested over every `AppBaseline["origin"]` and every `storedOrigin`, through a
`satisfies Record<...>` table, so a new origin fails to compile until it is placed. One assertion
over every string this part exports from `lib/publish/` and `remoteChanges.ts` refuses an em dash and
an ellipsis.

---

## 10. What step 7's first group needs, and that step 6 stores it

Step 7's first group (`changes-made-in-hq`) reads two HQ sources of one deployment, the baseline and
HQ now, into two documents whose entities carry the live document's UUIDs wherever the live document
holds that entity. For that it needs, per baseline, the map from external key to Nova UUID of the
document the baseline describes. It cannot compute the map later: the document at a pushed revision
is not reconstructible behind a fold horizon ("A reader that folds at a sequence behind an app's greatest
fold baseline answers from the current saved app instead", `lib/db/CLAUDE.md`), and entities made in
Nova after an adoption have random UUIDs no key derives.

The map is one of two things the base reading needs, and the only one step 6 stores. A baseline's
source is the normalized source and nothing else:
`lib/deployment/hqSourceBaseline.ts::normalizeHqAppSource` keeps what CommCare HQ returned with each
form id replaced by its position, because every source read mints a new id for every form. The
reader takes more than a source (part 06, `06-the-reader-forms.md`, section 2.2, `ReaderInput`):
each form's real id and CommCare HQ's question summary (`modules`), the tables (`lookup`), the
levels and places (`organization`) and the media index (`media`). A baseline holds none of those,
so the base of a comparison cannot be read from a baseline as step 6 writes it. Step 6 does not add
them: nothing in step 6 reads a baseline back through the reader, and what the base reading is
handed is an open question of `changes-made-in-hq`, stated in `7-rest-of-model.md` ("What its full
plan decides", question 12) with what is known on each side: a baseline that comes to store the
alignment and the project data its reading took, written at an adoption and at every publish, or a
base reading that builds its alignment from the stored source and takes the Project's tables,
places and media as they stand.

So from step 6 every baseline that holds a source holds its map:

- **Columns** (statement 10 of section 11): `identity_map_gzip bytea` and
  `identity_map_source_digest text` on `app_deployment_baselines`, both or neither. The second is the
  `source_digest` the map was written with.
- **At adoption**: the reader's `draft.identities.entries` (every key it claimed), encoded, written
  by `recordAdoptedDeploymentInTransaction` as `{ kind: "store", map }` (6.3).
- **At every publish**: `externalIdentityMap(doc, identity)` of the document and the identity the
  publish sent, encoded in `service.ts::appBaselineFor` (which gains `identityMap`), written with the
  `push` baseline as `{ kind: "store", map }`. A `create` baseline describes an empty app and an
  `unread` one describes nothing: both write `{ kind: "store", map: null }`.
- **Reader**:

```ts
/** `lib/deployment/store.ts`. `edit`. Null where there is no map, or it is not this source's. */
export async function readAppBaselineIdentityMap(
	scope: DeploymentScope, target: DeploymentTargetKey,
): Promise<readonly IdentityMapEntry[] | null>;
```

  It answers null unless `identity_map_source_digest` equals the row's `source_digest` and
  `decodeIdentityMap` reads the bytes. The digest pairing is what keeps a map honest across the
  deploy: a publish in flight on the previous revision upserts the source and leaves the map columns
  alone, and the stale map then names another source and reads as none.
- **"Refresh from CommCare HQ"** (part 01's `service.ts::refreshKeptValues`, A3) rewrites a
  baseline's source only where nothing Nova writes has changed, so the document that source describes
  is the same and so is its map. From B8 `refreshKeptValues`' write,
  `store.ts::recordRefreshedAppBaseline`, passes `identityMap: { kind: "rebind" }` and carries
  `expectedEndings` (6.2, 6.3, 8.5): where the row's map is bound to the source being replaced, the
  map's bytes stay and `identity_map_source_digest` becomes the new source's digest; where the row
  holds no map, or one
  already bound to another source, both columns are null after the write. So a refresh never makes a
  stale map read as current, and never loses a current one.
- **In step 6** the only readers are tests. Step 7 hands the entries to `matchingResolver`.
- **The key version.** A map's `version` is `HQ_ENTITY_KEY_VERSION`. A later change to any key of 2.2
  mints a new version, and the pull request that makes it translates stored maps or reads the old
  version beside the new: `decodeIdentityMap` refuses a version it does not know.

A baseline written before step 6 holds no map, and its next publish under step 6 stores one. Step 6
reads no map in production, so it offers such a deployment nothing and loses nothing by that. What
step 7 offers a deployment whose baseline still holds none is `changes-made-in-hq`'s to decide, with
the map's first production read, and part 15 (`15-stack-contracts-and-exit.md`) lists both under
that group in its rewrite of step 7.

---

## 11. The migration

`lib/case-store/migrations/20261201000000_hq_bring_in_ledger.ts`, registered in
`lib/case-store/migrations/index.ts`. Every statement replays over its own result, as
`lib/case-store/CLAUDE.md` requires ("Migrations are intentionally replay-idempotent because the
migration adoption tests erase Kysely's ledger and replay the complete chain"): `IF NOT EXISTS`,
`DROP CONSTRAINT IF EXISTS` before `ADD` for a constraint nothing depends on, a guarded `ADD` for the
one a foreign key depends on (statement 2), `CREATE OR REPLACE`, and `DROP TRIGGER IF EXISTS` before
`CREATE`. `down` throws: undoing it would delete what people confirmed and where their apps came
from. If `main` holds a later-stamped migration when this pull request is rebased, the stamp moves to
the next free hour after `main`'s newest, and every later stamp of the stack keeps its order; nothing
else changes.

```sql
-- 0. Wait five seconds for a lock, and no longer, while the previous revision serves.
SET LOCAL lock_timeout = '5s';

-- 1. The ended state and the count of endings.
ALTER TABLE app_deployments
	ADD COLUMN IF NOT EXISTS endings integer NOT NULL DEFAULT 0 CHECK (endings >= 0),
	DROP CONSTRAINT IF EXISTS app_deployments_state_check,
	ADD CONSTRAINT app_deployments_state_check CHECK (state IN
		('preflight', 'resources', 'uploaded', 'built', 'released', 'runnable', 'incomplete', 'ended'));

-- 2. The key the mapping's composite foreign key points at. Guarded, never dropped: on a replay
--    statement 6's foreign key depends on it, and PostgreSQL refuses the drop (2BP01).
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint
		WHERE conname = 'app_deployments_id_target_unique'
			AND conrelid = 'public.app_deployments'::regclass) THEN
		ALTER TABLE public.app_deployments
			ADD CONSTRAINT app_deployments_id_target_unique UNIQUE (id, server, domain);
	END IF;
END $$;

-- 3. The mapping's new columns.
ALTER TABLE app_deployment_resources
	ADD COLUMN IF NOT EXISTS server text,
	ADD COLUMN IF NOT EXISTS domain text,
	ADD COLUMN IF NOT EXISTS released_at timestamptz(3),
	ADD COLUMN IF NOT EXISTS ended_by text,
	ADD COLUMN IF NOT EXISTS ended_reason text;

-- 4. No writer sets server or domain: the trigger copies them from the deployment.
CREATE OR REPLACE FUNCTION public.nova_fill_deployment_resource_target() RETURNS trigger
	LANGUAGE plpgsql AS $$
	BEGIN
		SELECT d.server, d.domain INTO STRICT NEW.server, NEW.domain
			FROM public.app_deployments d WHERE d.id = NEW.deployment_id;
		RETURN NEW;
	END;
	$$;
DROP TRIGGER IF EXISTS app_deployment_resources_target ON app_deployment_resources;
CREATE TRIGGER app_deployment_resources_target
	BEFORE INSERT ON app_deployment_resources
	FOR EACH ROW EXECUTE FUNCTION public.nova_fill_deployment_resource_target();

-- 5. Existing rows. Outside the push-token trigger's columns, so no token rotates.
UPDATE app_deployment_resources r SET server = d.server, domain = d.domain
	FROM app_deployments d
	WHERE d.id = r.deployment_id
		AND (r.server IS DISTINCT FROM d.server OR r.domain IS DISTINCT FROM d.domain);

-- 6. Hold them.
ALTER TABLE app_deployment_resources
	ALTER COLUMN server SET NOT NULL,
	ALTER COLUMN domain SET NOT NULL,
	DROP CONSTRAINT IF EXISTS app_deployment_resources_target_fk,
	ADD CONSTRAINT app_deployment_resources_target_fk
		FOREIGN KEY (deployment_id, server, domain)
		REFERENCES app_deployments (id, server, domain) ON DELETE CASCADE,
	-- No clause about superseded_at: the previous revision supersedes a released mapping by
	-- setting that column alone, and this CHECK must admit the row it leaves (section 5.3).
	DROP CONSTRAINT IF EXISTS app_deployment_resources_release_is_an_apps,
	ADD CONSTRAINT app_deployment_resources_release_is_an_apps
		CHECK (released_at IS NULL OR kind = 'app'),
	DROP CONSTRAINT IF EXISTS app_deployment_resources_ending_is_attributed,
	ADD CONSTRAINT app_deployment_resources_ending_is_attributed CHECK (
		(ended_reason IS NULL) = (ended_by IS NULL)
		AND (ended_reason IS NULL OR (kind = 'app' AND superseded_at IS NOT NULL
			AND btrim(ended_by) <> '' AND ended_reason IN ('stopped', 'claimed-elsewhere'))));

-- 7. An app in recently deleted gives up an HQ app another mapping also names.
UPDATE app_deployment_resources r SET released_at = now()
	FROM app_deployments d JOIN apps a ON a.id = d.app_id
	WHERE r.deployment_id = d.id AND r.kind = 'app' AND r.superseded_at IS NULL
		AND r.released_at IS NULL AND a.deleted_at IS NOT NULL
		AND EXISTS (SELECT 1 FROM app_deployment_resources o
			WHERE o.id <> r.id AND o.kind = 'app' AND o.superseded_at IS NULL
				AND o.released_at IS NULL AND o.server = r.server AND o.domain = r.domain
				AND o.remote_id = r.remote_id);

-- 8. The guard: two live Nova apps on one HQ app stop the deploy, worded.
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM app_deployment_resources
		WHERE kind = 'app' AND superseded_at IS NULL AND released_at IS NULL
		GROUP BY server, domain, remote_id HAVING count(*) > 1) THEN
		RAISE EXCEPTION 'Two Nova apps publish to one CommCare HQ app, and from this migration only one may. Move every app but one of each such pair to recently deleted, then deploy again.';
	END IF;
END $$;

-- 9. One HQ app, one Nova app.
CREATE UNIQUE INDEX IF NOT EXISTS app_deployment_resources_hq_app_claim
	ON app_deployment_resources (server, domain, remote_id)
	WHERE kind = 'app' AND superseded_at IS NULL AND released_at IS NULL;

-- 10. The read origin, the identity map, and part 09's first-publish list.
ALTER TABLE app_deployment_baselines
	ADD COLUMN IF NOT EXISTS identity_map_gzip bytea,
	ADD COLUMN IF NOT EXISTS identity_map_source_digest text,
	DROP CONSTRAINT IF EXISTS app_deployment_baselines_origin_check,
	ADD CONSTRAINT app_deployment_baselines_origin_check
		CHECK (origin IN ('create', 'push', 'cutover', 'read', 'unread')),
	DROP CONSTRAINT IF EXISTS app_deployment_baselines_identity_map_is_whole,
	ADD CONSTRAINT app_deployment_baselines_identity_map_is_whole CHECK (
		(identity_map_gzip IS NULL) = (identity_map_source_digest IS NULL)
		AND (identity_map_source_digest IS NULL
			OR identity_map_source_digest ~ '^[0-9a-f]{64}$')),
	ADD COLUMN IF NOT EXISTS first_publish_changes jsonb,
	DROP CONSTRAINT IF EXISTS app_deployment_baselines_first_publish_changes_belong_to_a_read,
	ADD CONSTRAINT app_deployment_baselines_first_publish_changes_belong_to_a_read
		CHECK (first_publish_changes IS NULL OR origin = 'read');

-- 11. The two statements of section 4.1, exactly as written there and in that order:
--     CREATE TABLE IF NOT EXISTS app_deployment_media_paths (...), then
--     CREATE UNIQUE INDEX IF NOT EXISTS app_deployment_media_paths_path_folded.

-- 12. Hand the batch back as it was found.
SET LOCAL lock_timeout = 0;
```

The column is part 09's (its 12.3): B8 holds no writer and no reader of it, and every statement of B8
that sets `origin` leaves it null; B7 adds both.

In the TypeScript source each backslash of the path CHECK is doubled inside the `sql` template. The
guard's message names no script: a migration is immutable once applied, and B15 removes
`scripts/scan-hq-app-claims.ts`.

**With the previous revision serving.** Statements 1, 3 and 10 add nullable or defaulted columns and
widen two CHECKs, so every row that revision writes still passes. Statement 10's
`first_publish_changes` is nullable, read and written by nothing in B8, and its CHECK holds for every
row that revision writes, since it writes the column nowhere. Statement 4 fills the two columns
its inserts leave out. Statement 6's foreign key holds for rows the trigger filled.

Every new CHECK, `NOT NULL` and unique index of this migration was read against each statement
the previous revision runs on these three tables (`store.ts` at `15a00a97`: the insert, the
conflict arm and the supersede of `writeResourceMapping`, the supersede of
`recordPushedResources`, the observation update of `applyDeploymentObservation`,
`writeAppBaseline`'s upsert, every `app_deployments` update, and
`lib/db/apps.ts::commitAppProjectMoveInTransaction`), over the rows the migration itself leaves.
`recordPushedResources`' supersede names the kinds of a table or place push and of a worker
reconcile, never `app`, so `writeResourceMapping`'s is the one that can meet a released row:

| Constraint | Why no statement of the previous revision can break it |
|---|---|
| `server` and `domain` `NOT NULL`, and the composite foreign key | its one insert names neither, and the trigger fills both from the deployment row; no statement of it updates either column, or `app_deployments.server` or `domain` |
| `app_deployment_resources_release_is_an_apps` | it writes `released_at` nowhere and updates `kind` nowhere, so a row statement 7 released stays an `app` row whatever else it sets. The CHECK holds no clause about `superseded_at` for this reason: its supersede sets that column alone, on any live mapping, a released one included |
| `app_deployment_resources_ending_is_attributed` | it writes neither `ended_by` nor `ended_reason`, and the migration sets neither, so both stay null on every row it can reach before the new revision serves; it never clears `superseded_at`, so a row this revision ended stays superseded |
| `app_deployment_resources_hq_app_claim` | after statements 7 and 8 each HQ app has at most one live, unreleased `app` mapping. Its insert of an `app` mapping carries the id CommCare HQ answered for that app's own create, which no other mapping holds; its conflict arm fires only where the remote id is the one already held; it never clears `released_at`; and its delete and restore of an app write no ledger column |
| `app_deployments_state_check`, `endings`, `app_deployments_id_target_unique` | the state check is wider than before, `endings` is defaulted, and `id` is already the primary key |
| `app_deployment_baselines_origin_check`, `…_identity_map_is_whole` | the origin check is wider, and it writes neither identity map column, so both stay null together |
| `app_deployment_baselines_first_publish_changes_belong_to_a_read` | it writes the column nowhere, and no row holds a list until the new revision's first birth |
| `app_deployment_media_paths`, its CHECKs and its index | it never reads or writes the table |

The one constraint that can be met by that revision at all is the last CHECK of statement 10, and
only in a state this plan does not support: after the new revision has brought an app in, traffic
returned to the previous revision, and that revision publishing the app afresh, where its upsert
would set another origin beside the list. It is listed with the two throws below. The index is
built without `CONCURRENTLY`: the migrator runs the whole batch in one transaction
(`lib/case-store/CLAUDE.md`: "Kysely wraps the whole migration batch in ONE transaction"), which
rules `CONCURRENTLY` out, and the table holds one row per published resource, so the build is brief.

**Locks.** Statements 1, 2, 3, 6 and 10 take `ACCESS EXCLUSIVE` on `app_deployments`,
`app_deployment_resources` and `app_deployment_baselines`, three tables the serving revision reads
and writes, and hold them until the batch commits. A lock request that queues behind one long reader
would stall every deployment read behind it, so statement 0 bounds the wait at five seconds, as
`20261112000000_incremental_transcripts` does, and statement 12 sets the timeout back to `0`, as
`20260724030000_opaque_case_ids` does, for whatever migration shares the batch. A timeout fails the
migration Job with nothing changed, since the batch is one transaction; the Job's failure blocks the
deploy, and running the deploy again tries again.

**What the previous revision does with a row only the new one writes.** A `read` baseline makes its
`readAppBaseline` throw "which Nova does not know" for that deployment's publish. An `ended` state
makes `toDeploymentRecord` throw, and `store.ts::readDeploymentsForApp` maps every deployment of the
app through it, so that revision's readers of the whole app's deployments throw, not of the one
deployment. A fresh publish of a brought-in app whose HQ app CommCare HQ reported gone reads no
baseline, so on that revision its `writeAppBaseline` upsert would set origin `create` beside the
stored `first_publish_changes` and be refused by statement 10's CHECK, with nothing written. No
request for such an app reaches that revision once the new one serves, and a rollback to it is
not a state this plan supports.

---

## Copy

Every string below is in Nova's voice, sentence case, with no em dash and no ellipsis. Strings part
13 places (B11) are exported from `lib/publish/` so the builder, MCP and the docs read one text.

**`lib/publish/stopPublishing.ts`** (new, client-safe):

| Export | Text |
|---|---|
| `STOP_PUBLISHING_ACTION` | "Stop publishing here" |
| `STOP_PUBLISHING_HELPER` (under the control on the card and at the drift stop) | "The app in CommCare HQ stays as it is, and this app stops publishing to it. It can be brought in to Nova again as a new app." |
| `stopPublishingConfirmTitle(domain)` | "Stop publishing to “{domain}”?" |
| `stopPublishingConfirmBody(domain)` | "Nova stops publishing this app to “{domain}”. The app in CommCare HQ stays exactly as it is, and you or a teammate can bring it in to Nova again as a new app. If you publish to “{domain}” later, Nova makes a new app there." |
| `STOP_PUBLISHING_CONFIRM` / `STOP_PUBLISHING_CANCEL` | "Stop publishing" / "Cancel" |
| `endedLine(ending, date)`, reason `stopped` | "{name} stopped publishing here on {date}. The app in CommCare HQ stays as it was, and publishing here again makes a new app beside it." |
| `endedLine(ending, date)`, reason `claimed-elsewhere` | "Nova stopped publishing here on {date}, because another Nova app publishes to that CommCare HQ app now. Publishing here again makes a new app beside it." |
| `ENDED_HQ_APP_LINK` | "Open the app in CommCare HQ" |
| `PUBLISH_PLAN_CREATES_BESIDE` (the dialog's plan line for `creates-beside`) | "Nova stopped publishing to the app that's already in this project space, so this makes a new app beside it." |
| `GONE_APP_NEXT_PUBLISH` | "Publishing again creates a new app on CommCare HQ, because the one that was there is gone." |
| `restoredStoppedPublishing(spaces)` (the home list, after a restore) | one space: "Your app is back. It no longer publishes to “{domain}”, because another Nova app publishes to that CommCare HQ app now. Publishing there again makes a new app." Several: "Your app is back. It no longer publishes to {spaces in words}, because other Nova apps publish to those CommCare HQ apps now. Publishing to one of them again makes a new app there." |
| `RESTORE_CLAIMS_CHANGED` (the home list, a restore that met three changes in a row, 5.4) | "Nova couldn't bring this app back just now, because where it publishes was changing at the same moment. Nothing was changed, and you can try again." |
| `PUBLISH_CLAIMS_CHANGED` (a publish whose settle met the same, 7.1; code `app_changed_while_publishing`) | "Where this app publishes was changing while Nova got this publish ready, so nothing was sent. You can publish again now." |

The four functions, as the file declares them:

```ts
// lib/publish/stopPublishing.ts
export function stopPublishingConfirmTitle(domain: string): string;
export function stopPublishingConfirmBody(domain: string): string;
/** `ending` is `deploymentEnding`'s answer, taken structurally so this file imports nothing of
 *  `lib/deployment`. `date` is the day the caller formatted. */
export function endedLine(
	ending: { readonly byName: string; readonly reason: "stopped" | "claimed-elsewhere" },
	date: string,
): string;
/** Each entry is one project space as the caller words it, quotation marks included: “{domain}”,
 *  with its server's label after it where the caller adds one. Several are joined in words. */
export function restoredStoppedPublishing(spaces: readonly string[]): string;
```

`{name}` in the `stopped` line is `ending.byName`. `endedLine`'s `date` is the card's own day of
`ending.at`, formatted as the card formats a confirmation's today (`DeploymentStatus.tsx`: day,
month and year in the reader's locale). The `claimed-elsewhere` line names no person: the mapping's
`ended_by` is whoever's restore or publish met the other app (5.4, 7.1), which is nothing that
person chose, so the line says what happened. `restoredStoppedPublishing`'s caller is the home list
(part 13 (`13-the-experience.md`), section 11.4, B11), which words each entry of
`RestoreAppResult.stoppedPublishing` (5.4) as “{domain}” and adds the server's label where the app
publishes to more than one server. In the one-space text the entry stands where the table shows
“{domain}”, and the function adds no quotation marks of its own.

**Refusals and errors** (`lib/deployment`):

| Where | Text |
|---|---|
| `stopPublishing`, not permitted (`not_permitted`) | "Only an admin or owner of this Project can stop publishing here. You can ask one of them to." |
| `stopPublishing`, nothing to stop (`invalid`) | "Nova isn't publishing this app to “{domain}”, so there's nothing to stop." |
| `publishing_stopped`, nothing sent | "Someone stopped publishing this app to “{domain}” while Nova was getting this publish ready, so nothing was sent. Publishing again makes a new app there." |
| `publishing_stopped`, something sent | "Someone stopped publishing this app to “{domain}” while this publish was running. CommCare HQ may hold what this publish had already sent, and Nova keeps no record of it. Publishing again makes a new app there." |
| `refreshDeployment` and `refreshKeptValues`, ended (`invalid`) | "Nova stopped publishing this app to “{domain}”, so there's nothing there for it to check on. Publishing there again makes a new app." |
| `provisionWorkers`, ended (`app_not_published`) | "Nova stopped publishing this app to “{domain}”, so there's no app there for a worker to sign in to. You can publish it there again and then add workers." |
| `recordAdoptedDeploymentInTransaction`, the app row is not the born app (thrown, never shown to a person) | "Nova tried to record where app {appId} came from and found no such app in Project {projectId}. The app's birth and its deployment are written together, so this is Nova's fault to fix: check the order of the creation transaction." |
| `assignMediaPaths`, a path outside `jr://file/` (thrown, never shown) | "Nova was given the media path “{path}” to keep, and it doesn't start with jr://file/. CommCare HQ can't build an app with such a path, so the reader should have reported this file before the app was created." |
| `matchingResolver`, a key or UUID twice (thrown) | "Nova was given an identity map that names {what} twice (entries {first} and {second}). A map holds each key and each UUID once, so whatever built this map has a mistake to fix." `{what}` is "the key " and `externalKeyText(key)`, or "the UUID " and the UUID; `{first}` and `{second}` are the two entries' positions in `known`, counted from 0 |

**The picker's marks** (`lib/publish/hqAppClaims.ts`, new, client-safe; part 13, section 4.3, B11,
places them). The file exports the two row labels and the action "Open", and no line:

| Export | Text |
|---|---|
| `HQ_APP_CLAIM_OPEN_LABEL` | "Already in Nova" |
| `HQ_APP_CLAIM_OPEN_ACTION` | "Open" |
| `HQ_APP_CLAIM_ELSEWHERE_LABEL` | "Already in Nova, in a Project you're not part of" |

| View | Row label | Line under it |
|---|---|---|
| `open` | `HQ_APP_CLAIM_OPEN_LABEL` | none: the action `HQ_APP_CLAIM_OPEN_ACTION`, a link to the app |
| `elsewhere`, `brought-in`, contact `person` | `HQ_APP_CLAIM_ELSEWHERE_LABEL` | `alreadyInNovaNext(claim)` (part 01, 9.3) |
| `elsewhere`, `published`, contact `person` | the same | `alreadyInNovaNext(claim)` (part 01, 9.3) |
| `elsewhere`, `brought-in`, contact `owners` | the same | `alreadyInNovaNext(claim)` (part 01, 9.3) |
| `elsewhere`, `published`, contact `owners` | the same | `alreadyInNovaNext(claim)` (part 01, 9.3) |

The four sentences live in part 01's `lib/publish/hqFindingCopy.ts::alreadyInNovaNext` (A2), so the
picker and a reading that stops on `already-in-nova` say one thing. The facts are this part's claim
view (5.5), which tells `brought-in` from `published`: "It was brought in" would be false of an app
made in Nova and published. The date in the line is part 01's to word too (its section 9.3): the
viewer's locale day of the claim's `at`.

**The review's line for 6.5** (part 13, section 8.8, B11, places it under "After it's in"):
`lib/publish/planFeatures.ts::adoptionRecordedFeaturesLine(labels: readonly string[], domain:
string): string`, beside `namesInWords`, which joins the labels: "This app already uses {labels in
words} on “{domain}”, and publishing changes nothing about them, so Nova won't ask about them. You
can withdraw any of these on the Publishing card." `labels` are `PLAN_FEATURES[id].label` for each
recorded feature, in `PLAN_FEATURES`' order. It is left out where no feature was recorded. It claims
nothing about the project space's plan, which Nova cannot read (6.5).

**The scan** (`scripts/scan-hq-app-claims.ts`, to the person who runs it): "Checked every CommCare HQ
app a Nova app publishes to. {n} are published to by two or more Nova apps that are not in recently
deleted, and {m} by one live app and apps in recently deleted. The migration handles the second kind
by itself. For the first kind, run again with --list to see the apps, and move all but one of each
group to recently deleted before deploying."

---

## Tests

Pure tests run without Docker. `*.postgres.test.ts` runs against real Postgres through the existing
fixtures. Each line names the failure it would catch.

**B2**

- `lib/commcare/reader/__tests__/identity.test.ts` (pure). The four golden UUIDs (a changed namespace,
  version string or name layout). Equal parts under two kinds give two UUIDs. Every minted UUID parses
  with `uuidSchema` and has version 5. `EXTERNAL_ENTITY_KINDS` and `KINDS_WITH_NO_EXTERNAL_KEY`
  partition `BLUEPRINT_AUTHORED_IDENTITY_KINDS` (a new identity kind nobody classified). A second
  claim of one key answers `ok: false` with the first place and mints nothing. `matchingResolver`
  answers a known key with its UUID, mints an unknown one, and throws on a map with a key or a UUID
  twice.

**B8, pure**

- `lib/commcare/reader/__tests__/identityMap.test.ts`. Over the document arbitraries
  `lib/commcare/__tests__/expressionDocArbitrary.ts` and `advancedDocArbitrary.ts`:
  `externalIdentityMap` holds exactly one entry per authored identity of an external kind and none
  of the other nine (an entity the projection skips or invents); its keys are unique; it is equal for
  two calls. Stated cases: renaming a question changes its key and its descendants' and no other;
  reordering a module's `listColumnOrder` changes no key where no two columns share
  `(columnKind, field)`, and swaps the keys of two that do; reordering the `columns` array alone
  changes no key at all; moving a basic subcase to another index changes the key of each operation
  whose index moved and of no other. `encodeIdentityMap` and
  `decodeIdentityMap` round-trip; a truncated buffer and an unknown version decode to null.
- `lib/commcare/reader/__tests__/identityMapParity.test.ts`. For every retained reading of
  `proof/hq-reads/reading/` that reads (through part 05's `retainedReadingRead`, its section 14.1,
  and the reader), the reader's `draft.identities.entries` equals `externalIdentityMap(doc,
  targetWireIdentity(rows))`. This is the test that fails when a reader module mints under a key the
  projection spells differently, which would make every baseline's map wrong for step 7.
- `lib/deployment/__tests__/adoption.test.ts`. `adoptedIdentityRows`: one row per menu and form, the
  hidden menu under `syntheticModuleUuid`, `ok: false` on a menu that was not summarized.
  `assignMediaPaths`: the first path in code-unit order with the others in `collapsed`; a path under
  another directory (`media/logo.png`) is held; a derived-shape path of another hash goes to
  `rederived` as `names-another-file` and gets no row, in lower case and in upper case; a file's own
  derived path is held; two files whose paths differ only by case are both `differs-only-by-case`
  and neither gets a row, while a third path of one of them is still held; a path with `..`, with no
  directory, or with a space at either end is `not-holdable`; a path outside `jr://file/` throws.
  One list of paths, exported from the test's fixtures, is run through `isHoldableWirePath` here and
  through the table's CHECK in `hqBringInLedger.postgres.test.ts`: the function refuses every path
  the CHECK refuses, and the two agree on every ASCII path of the list, so the floor cannot come to
  admit what the rule refuses there.
  `adoptedAppBaselineWrite`: origin `read`, a `store` identity map, and for two stated documents the
  whole ownership written out by hand: a plain app (its add-ons, the two profile settings Nova
  always writes, no custom profile property, `autoGpsCapture` false) and a Connect app
  (`autoGpsCapture` true).
  `adoptionPlanFeatureConfirmations`: the table of 6.5, each exception both ways.
- `lib/deployment/__tests__/hqAppClaimsVocabulary.test.ts`. The three equalities of 5.2 (a reason or
  an ownership added on one side of the `lib/db` boundary and not the other).
- `lib/deployment/__tests__/stateMachine.test.ts` (additions). `ended` reaches nothing, displays
  nothing and is not observable; a failed attempt leaves it `ended` by reference; a passed preflight
  moves it to `preflight`.
- `lib/deployment/__tests__/resources.test.ts` and `leftBehindResources.test.ts` (additions). An ended
  `app` mapping is not left behind. `deploymentEnding` reads the latest ending at state `ended`; still
  reads it at `preflight` and at `incomplete` with no live `app` mapping (a publish that passed
  preflight and stopped before its create); is null once a live `app` mapping exists; and is null for
  a deployment whose latest superseded `app` mapping has no `endedReason`. `nextPublishAction`
  answers `creates-beside` in exactly the cases `deploymentEnding` is not null.
  `plannedInPlaceUpdate` is null for a released mapping.
- `lib/deployment/__tests__/remoteChanges.test.ts` and `webApps.test.ts` (additions): section 9.3, and
  `changedInHq` computed for a `read` baseline with `since` carried.
- `lib/deployment/__tests__/hqSourceBaseline.test.ts` (addition). A retained HQ source compared with
  itself under the adoption ownership gives no part; with one form's attachment changed it gives that
  form's part.
- `lib/commcare/multimedia/__tests__/bundle.test.ts` (additions). A manifest with a nested path gives
  `<media path="../../commcare/image">` and the location `./commcare/image/<name>`, one outside
  `commcare/` gives `<media path="../../media">` and `./media/<name>`, and the bundle's zip entry is
  each path; a manifest of derived paths gives the bytes it gives today (the existing golden).
  `lib/commcare/validator/mediaSuiteOracle.ts` reads each such suite and joins every resource to a
  bundled path: the independent reader of this change. Core and Android read it in the lane on the
  base `hq-media` (part 14, section 6.2, B13).

**B8, Postgres**

- `lib/case-store/migrations/__tests__/hqBringInLedger.postgres.test.ts`. From the schema before this
  migration with rows of every kind: `server` and `domain` backfilled on every mapping; an insert that
  names neither (the previous revision's statement) is filled; an insert naming a wrong pair is
  overwritten by the trigger; the guard raises its sentence on two live claims; a deleted duplicate is
  released and the index builds; a second live claim across two Projects is refused with `23505` on
  `app_deployment_resources_hq_app_claim`, and admitted once the first is superseded or released; the
  CHECKs refuse an ending with no person, a release on a mapping of any kind but `app`, a media
  path with `..`, a backslash, no directory or a space at either end, and an identity map with no
  source digest; **the previous revision's supersede on a released row**: over a mapping statement
  7 released, the test runs the statement `store.ts::writeResourceMapping` runs at `15a00a97`
  (`UPDATE app_deployment_resources SET superseded_at = $now WHERE deployment_id = $1 AND kind =
  'app' AND nova_resource_id = $2 AND superseded_at IS NULL AND remote_id <> $3`, naming no column
  this migration adds) and then that function's insert of the fresh mapping, naming neither
  `server` nor `domain`: both succeed, the old row holds `superseded_at` and `released_at`
  together, the new row is live and unreleased with its target filled by the trigger, and a
  `lockReleasedClaimsInTransaction` read of the app's live released mappings then finds none;
  `app_deployment_baselines.first_publish_changes` exists and is nullable, and its CHECK holds (a
  `read` row may hold a list; any other origin may not), which is the case part 09 asks of this
  file; a media path under any directory is admitted; a second path of one deployment that differs from a
  held one only by case is refused by `app_deployment_media_paths_path_folded`; a media path row
  whose asset is deleted from the library is gone, and so is one whose deployment is deleted. `up`
  run a second time over its own result, with the ledger row erased as the adoption tests erase it,
  raises nothing and changes no catalog row and no data row: this is the run that fails if statement
  2 drops the constraint statement 6's foreign key depends on. After `up`, `SHOW lock_timeout` in
  the same transaction answers `0`, so a migration that shares the batch keeps its own.
- `lib/db/__tests__/privilegeConvergence.postgres.test.ts` and `privilegeConvergence.test.ts`
  (additions). The runtime role inserts and deletes rows of both tables and is refused an UPDATE with
  `42501`; the new routine is in the expected inventory. `runtimeRowLockPrivileges.test.ts` keeps
  refusing a row lock on either table.
- `lib/deployment/__tests__/adoptedLedger.postgres.test.ts`. Inside one transaction that births an app
  through the production genesis writer and then calls `recordAdoptedDeploymentInTransaction`: every
  column of 6.1 holds its value; `publishedRemoteApp` is the adopted mapping; `nextPublishAction` is
  `updates`; `readReachedDeploymentTargets` lists the project space;
  `readDeploymentIdentityOverrides` and `readDeploymentMediaPaths` return the rows;
  `readAppBaseline` answers `read` with the ownership; `readAppBaselineIdentityMap` returns the
  entries, and null after the source is rewritten by a statement that leaves the map columns alone
  (the previous revision's upsert). A `rebind` write over a current map keeps the entries readable
  under the new source; a `rebind` over a map already stale leaves both columns null. A throw after
  the writer leaves no row of any table (the birth and the ledger are one transaction). A baseline
  whose stored bytes are corrupted reads `unread` with `storedOrigin` `read`.
- `lib/db/__tests__/hqAppClaims.postgres.test.ts`. Two transactions claim one key: the second waits
  on the first and throws `HqAppAlreadyClaimedError` once it commits, having written nothing. A holder
  in recently deleted is released by a claim, and a concurrent restore of that holder, held in real
  Postgres at each of the two lock orders, ends with exactly one live claim. Restore with no take
  changes no row; restore after a take by an app that is live ends the deployment with
  `claimed-elsewhere`, deletes its identity and media-path rows and returns the project space;
  restore after the taker itself was ended re-claims; restore after the taker was moved to recently
  deleted re-claims, keeps the restored app's identity and media-path rows, and leaves the taker's
  mapping released, and restoring the taker afterwards ends the taker's deployment. Two apps that
  each hold what the other gave up, both in recently deleted and restored at once in two real
  transactions, both commit with no deadlock and each HQ app has exactly one live claim. A restore
  whose released claims change between its first read and its locks starts again and settles what
  it then finds. `readHqAppClaims` answers `open` to a member and `elsewhere` to a non-member, names
  owners where the person left the Project, and never returns a deleted holder.
- `lib/deployment/__tests__/endDeployment.postgres.test.ts`. An editor is refused `not_permitted`
  with the sentence that names who can, a viewer `not_found`, and an admin and an owner succeed
  (through `stopPublishingAction`, the editor's result carries the code `not_permitted` and not
  `not_found`); after it the state is `ended`, `endings` is 1, the mapping is superseded with the
  person and `stopped`, no identity or media-path row remains, the baseline and the confirmations
  remain, the claim is free, and `previewProjectSpaceFor` no longer names the project space. A second
  call answers "nothing to stop". Each fenced writer, called with the count read before the ending,
  throws `DeploymentEndedError` and writes nothing.
- `lib/deployment/__tests__/publishSequence.postgres.test.ts` (additions, over the controlled HQ
  adapter of `publishFixtures.ts`). A first publish over an adopted deployment: the import body's
  menu ids, form ids and `xmlns` are the rows'; the mapping stays `adopted` with its first
  `adopted_by` and `adopted_at`; the baseline becomes `push` with an identity map of the sent
  document; `appPreviewNote` is given; no shell is created. Over an untouched app with no Search, the
  `push` baseline that publish writes holds the same ownership as the `read` baseline it replaced;
  with an effective Search and the advisory `available`, the two differ in `profileCustomProperties`
  and nowhere else (the adoption's descriptor drifting from the publish's own). A language's display
  name that differs in HQ's source is no change on the adopted deployment, is carried in the body as
  HQ holds it, and is a change on a deployment Nova created. A seeded setting HQ's source holds no
  value for is absent from the body on the adopted deployment and seeded on a deployment Nova
  created (`seeds` reaching the import beside `languageNames`). HQ's source changed since the reading:
  the refusal's app change carries `since.kind` `brought-in`, and the message is the brought-in text
  with the day of `adopted_at` in the zone the publish was given, UTC where it was given none.
  An ending between preflight and the import: `publishing_stopped`, and no live mapping after it. A
  publish to an ended deployment: a shell is created, the body carries derived ids, and the
  deployment leaves `ended`; one stopped after its preflight and before its create still answers
  `deploymentEnding` and `creates-beside`. A released mapping on a live app: settled before anything
  is read of HQ, and until then `previewProjectSpaceFor` does not name its project space.
- `lib/deployment/__tests__/refreshKeptValues.postgres.test.ts` (part 01's file, additions). On an
  ended deployment the refresh throws the ended sentence and reads nothing of HQ; over a live `app`
  mapping that is released it answers `no-baseline` and reads nothing of HQ; a refresh over a `read`
  baseline keeps `readAppBaselineIdentityMap` answering the same entries; and
  `recordRefreshedAppBaseline`, called with the count of endings read before an ending, throws
  `DeploymentEndedError` and writes nothing.
- `app/api/commcare/upload/__tests__/route.test.ts` (addition). A body with `viewer` reaches
  `publishAppToHq` as `driftDate`; a malformed `viewer` reaches it as absent and refuses nothing.
- `lib/db/__tests__/projectMove.postgres.test.ts` (addition). A moved app's media-path rows name the
  destination Project's asset ids, and two source assets that meet one destination asset leave one
  row.
- `lib/db/__tests__/softDeleteApp.postgres.test.ts` (addition). Deleting writes no deployment row;
  `restoreApp` returns `stoppedPublishing`, and an app with no released claim restores as it does
  today.
- `lib/mcp/__tests__/errors.test.ts` and `lib/__tests__/apiError.test.ts` (additions). A
  `DeploymentError` of code `not_permitted` is `permission_denied` with its message kept, and status
  403.
- `lib/deployment/__tests__/downloadTargetsAction.postgres.test.ts` and
  `lib/mcp/__tests__/compileApp.postgres.test.ts` (additions). A `.ccz` made for an adopted project
  space holds each media file at HQ's path and each form under HQ's `xmlns`; one made for another
  project space holds the derived ones.
- `lib/mcp/__tests__/servedSchemas.test.ts`. The served enums gain `ended` and `publishing_stopped`.
  No served object gains a key in B8: `ending`, `brought_in` and `since` are B12's (part 13, section
  14.7).
- `proof/corpus/__tests__/publish.postgres.test.ts` (part 14's case, its section 2.5; changed here).
  The case that sends Nova's real `publishAppToHq` over a peer holding `hq-plain`'s retained source
  builds its ledger through this part's writers, where A1 inserted the identity rows directly: the
  rows of `adoptedIdentityRows`, the baseline of `adoptedAppBaselineWrite` at origin `read`, and the
  held media paths. It still sends the bodies the capture recorded, now with `languageNames` and
  `seeds` at `"target"`. The failure it catches is the capture drifting from the publish it records.

**Playwright** is part 13's (B11): the Publishing card's "Stop publishing here" with its
confirmation, the ended card, the drift stop's second answer, and the restore message, each over the
controlled Server
Action transport (`e2e/lib/publishing-boundary.ts`), which B8 extends with `stopPublishingAction`.
B8 itself changes `e2e/tests/browser/publishing.spec.ts` only where it must to compile and stay true:
its hand-built `WebAppsChange` gains `since`, and its existing drift assertions keep comparing with
the constants, which are the `published` texts.

---

## Contracts and docs these changes make false

**`lib/deployment/CLAUDE.md`** (B8).

- "Ownership", old: "The recreated app keeps the deployment's recorded ids, which
  `app_deployment_identities` holds sparsely: only the ids that differ from the derivation, for a
  deployment first published before ids were derived (a menu's id and a form's `xmlns` as the app
  source held them, a form's id as the `ApplicationResource` read held it). No publish writes a row.
  No publish reads form ids back." New: "The recreated app keeps the deployment's recorded ids and
  media paths. `app_deployment_identities` holds the ids a target holds that are not the derivation:
  every menu and form of an app brought in from CommCare HQ, on the project space it came from, and
  the ids of a deployment first published before ids were derived. Rows are written when an app is
  brought in and deleted when its deployment is ended; no publish writes one, and no publish reads
  form ids back."
- "Ownership", old: "A publish creates afresh only when there is no active mapping or the active
  mapping's `remote_missing_at` is set." New: "A publish creates afresh only when there is no active
  mapping (a first publish, or one after the deployment was ended) or the active mapping's
  `remote_missing_at` is set."
- "Identities", old: "The runtime role reads it (...) and cannot write it; every row belongs to a
  deployment first published before ids were derived." New: "The runtime role reads it (...), inserts
  rows when an app is brought in and deletes them when a deployment is ended, and never changes one.
  `app_deployment_media_paths` holds, the same way, the path CommCare HQ keeps each of that app's media
  files under; a Project move writes those rows again under the destination Project's asset ids, and
  deleting a file from the library removes its row."
- "Baselines", old: "the normalized source HQ answered right after Nova's push (`push`), right after
  the empty app was made (`create`), or at the cutover (`cutover`)". New: the same list with ", or
  when the app was brought in (`read`), which is compared as a push is" and, after the sentence on form
  ids, "From step 6 a baseline that holds a source also holds the identity map of the document it
  describes (external key to Nova UUID), bound to that source's digest."
- "Preflight is a graph", old: "written only by the fold of a passed preflight
  (`foldDeploymentAttempt`'s `confirmations`), so a refused publish stores none and the caller
  resends them; the one exception is the resources fold of `hq_plan_lacks_web_apps`, which withdraws
  the `web-apps` answer HQ's create contradicted." New: the same up to "resends them;", then "two
  other writers touch them: the resources fold of `hq_plan_lacks_web_apps`, which withdraws the
  `web-apps` answer HQ's create contradicted, and bringing an app in from CommCare HQ, which records
  a `plan-feature` row for each feature the app's source already uses
  (`recordAdoptedDeploymentInTransaction`, `adoption.ts::adoptionPlanFeatureConfirmations`), since
  the first publish changes nothing about them."
- "Ownership", old: "`adopted` is never inferred. A publish that meets a name it cannot account for
  REFUSES and names the resource; the caller comes back with `adoptResourceIds` carrying the exact
  Nova ids a person confirmed, and only those become `adopted` mappings." New: the same, with the
  last clause "and only those become `adopted` mappings of a table or a place. An `app` mapping is
  `adopted` by one route only: a person brings that app in from CommCare HQ, and its birth records
  the mapping with who and when. A publish keeps the ownership of the app mapping it updates, and an
  app a publish creates is `nova-created`."
- New section "One HQ app, one Nova app" (the index, the trigger, release at the take, restore and
  its lock order: each HQ app's advisory lock in key order, then app rows in app id order, then the
  membership gate), and new section "Ending a deployment" (the state, the transaction, who may, the
  fence, the table of 8.6, and that an ending is read from the mappings and never the state). "The
  state machine" gains "`ended`: the person stopped publishing here, or a restored app found a live
  Nova app on its HQ app. It holds no position; a publish that passes preflight leaves it."
- "Surfaces": no change in B8, which registers no tool. `stop_publishing` joins that section's MCP
  list in B12, with the other bring-in tools (part 13 (`13-the-experience.md`), "Contracts"). The
  new section "Ending a deployment" says that the builder's `stopPublishingAction` and that tool
  share the one `stopPublishing` lifecycle.
- "No lock spans the CommCare HQ round trips" gains the bullet "Every write of a publish carries the
  count of endings its first read held, and refuses where the deployment has been ended since."

**`lib/db/CLAUDE.md`** (B8).

- Old: "`app_deployment_identities` (the module and form ids a target holds that are not Nova's
  derivation) is runtime read-only: only a migration writes it, as the migration role, and a publish
  writes none." New: "`app_deployment_identities` (the module and form ids a target holds that are not
  Nova's derivation) and `app_deployment_media_paths` (the path CommCare HQ keeps a media file under)
  are runtime insert-and-delete: rows are written when an app is brought in and deleted when its
  deployment is ended, never changed and never row-locked. A Project move deletes an app's
  media-path rows and inserts them under the destination Project's asset ids."
- The sentence on `app_deployment_baselines` gains the column, in part 09's words (its "Contracts",
  the `lib/db/CLAUDE.md` row, which lands here in B8): `first_publish_changes`, "set only beside
  origin `read`, held so by a CHECK".
- Old: "The three runtime-written tables are insert/update, never deleted or row-locked. The first
  three cascade with their deployment". New: "The three insert/update tables are never deleted from or
  row-locked. All five per-deployment tables cascade with their deployment".
- Old: "A partial unique index on `(deployment_id, kind, nova_resource_id) WHERE superseded_at IS
  NULL` makes two live ownership mappings for one Nova resource unrepresentable". Add after it: "A
  second, on `(server, domain, remote_id)` for live, unreleased `app` mappings, makes two Nova apps
  on one HQ app unrepresentable across Projects; a `BEFORE INSERT` trigger copies `server` and
  `domain` from the deployment."
- The paragraph on soft deletion gains: "`restoreApp` settles each HQ app the restored app gave up
  while it was deleted: it takes it back, from a holder in recently deleted too, or ends that
  deployment where a live app holds it (`hqAppClaims.ts`)."
- "Lock ordering is the concurrency discipline" gains: "A transaction that settles an app's released
  HQ app claims (`hqAppClaims.ts::lockReleasedClaimsInTransaction`: a restore, and a publish that
  finds one) is the one protocol that locks more than one app row. It takes each HQ app's
  transaction advisory lock first, in key order, then the app rows in ascending app id, and starts
  again where what it read before the locks no longer holds. A birth from CommCare HQ takes the same
  advisory lock before the one existing app row it may lock."

**`lib/media/CLAUDE.md`** (B8), under "Manifest": "An uploaded asset's wire path is the path the
export's target holds for it (`app_deployment_media_paths`, for an app brought in from CommCare HQ on
the project space it came from) or, with none, the content-hash path."

**`lib/commcare/CLAUDE.md`** (B8). Old: "so every menu and form id is `lib/commcare/wireIdentity.ts`'s
derivation or the target's recorded override (`ExpandOptions.identity`)". Unchanged and still true;
the media paragraph that says all media lives flat under `commcare/` gains "except a path a target
holds, which keeps its directory; the media suite writes each file's own".

**`docs/architecture/contracts.md`, "HQ deployment safety"** (B14, text fixed here).

- Old: "A durable deployment record is keyed by Nova app, Project, HQ server, and HQ domain.
  Remote-resource mappings additionally key the Nova resource UUID and store ownership/adoption,
  remote id, pushed identity, and revision." New: the same, then "One HQ app is published to by one
  Nova app at a time, across Projects. An app in recently deleted gives its HQ app up to whoever takes
  it. A deployment can be ended: its app mapping is superseded with no successor, its recorded ids and
  media paths go, and a later publish there makes a new app with derived ids."
- Old: "Nova never writes over a change made in CommCare HQ since its last publish there without a
  person's word." New: "Nova never writes over a change made in CommCare HQ since its last publish
  there, or since it brought the app in, without a person's word."
- Old: "by comparing HQ's current read of the app, each mapped lookup table and each mapped place
  with HQ's own read after Nova's last push". New: "... with HQ's own read after Nova's last push, or
  the read the app was brought in from".

**Root `CLAUDE.md`, mental model 3** (B14). Old: "A form's `xmlns` and every HQ menu and form id are
derived from the Nova entity's UUID and stored nowhere in the document." New: "A form's `xmlns` and
every HQ menu and form id are stored nowhere in the document: they are derived from the Nova entity's
UUID, except on the project space an app was brought in from, where the deployment ledger holds
CommCare HQ's own."

**The research's contract rows for step 6.**

| Row | Settled by |
|---|---|
| "A publish creates afresh only when there is no active mapping, or when a persisted upload failure says the mapped app is gone" → "also after the person ends a deployment" | this part: the `lib/deployment/CLAUDE.md` sentence above. The research's "whose HQ app no longer reads" is not a condition: a person may end any deployment |
| "A durable deployment record is keyed by Nova app, Project, HQ server, and HQ domain" | the key stands (this part); what a lookup table's standing is in a project space is part 11's (B9) |
| the closed birth vocabulary gaining `hq-adoption` | part 12 (B10) |
| "no arm for matched by name" | part 11 (B9) |
| "every export mode carries the data" | part 11 (B9) |

**The surface manifest** (A2, text fixed here). `forms-and-case-writes/xmlns-form-json-and-xform-data-node`:
`slotChanges` becomes `[]` and `dispositionCell` becomes "**HELD**: derived from the form's UUID
(`wireIdentity.ts::derivedFormXmlns`), or the `xmlns` the deployment ledger records for that project
space (`app_deployment_identities`, `wireIdentity.ts::targetWireIdentity`): an app brought in from
CommCare HQ keeps HQ's `xmlns` for every form on the project space it came from, and takes the derived
one everywhere else". Its row in
`docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md` takes the same cell in the
same commit. This plan gives a form no `xmlns` slot (the top-level file `../6-bring-in.md`, "What
changed from the outline, and why", item 17; sections 2 and 3 here), which decides this row, and
part 04 (`04-names.md`, its table of widens, row 20) hands the edit to A2 as an emission-side
re-cut: Nova's exports already hold an `xmlns` this way. Part 01 lists the row for A2 with this
cell (its section 3.3, "Stale cells").
`expressions-and-data/media-path-jr-file` flips in B9 (part 11 (`11-project-data.md`), section
13.1), in part 01's words (its section 3.5), to which B9 adds one sentence from this part: "A
path CommCare HQ's upload cannot address, one that only letter case tells from another file's, and
one in Nova's own shape that names another file are not kept: the file takes Nova's path, as a
stated first-publish change (`adoption.ts::assignMediaPaths`)".

**Public docs** (B14, text fixed here). `content/docs/publishing.mdx`, "Changes made in CommCare
HQ", old: "Each publish remembers what CommCare HQ held just after it: the app, each lookup table and
each place." New: "Each publish remembers what CommCare HQ held just after it: the app, each lookup
table and each place. An app you brought in from CommCare HQ starts from what it held when it came
in." The section gains: "**You can also stop publishing here.** The app in CommCare HQ stays as it is,
this app stops publishing to it, and it can be brought in to Nova again as a new app. If you publish
to that project space later, Nova makes a new app there. A Project's admins and owners can do this."

The same file, "On CommCare HQ", old: "The one exception: if the app was deleted on CommCare HQ since
Nova put it there, Nova tells you so when you try, and publishing once more makes a fresh one there."
New: "There are two exceptions. If the app was deleted on CommCare HQ, Nova tells you so when you
try, and publishing once more makes a fresh one there. And if someone stopped publishing this app to
that project space, the next publish makes a new app beside the one that stays." ("since Nova put it
there" goes: an app brought in was never put there by Nova.)

---

## Departures

From the outline and the research, and the alternatives this part weighed and did not take. Each
states the decision and its evidence; a "Not done" names the alternative an implementer could reach
for, and why it is not built.

1. **`released_at` is written when another app takes the HQ app, not when the holder is moved to
   recently deleted.** Evidence: the migrate Job runs while the previous revision serves
   (`lib/case-store/CLAUDE.md`), and that revision's `softDeleteApp` and `restoreApp` write no ledger
   column, so a column those two functions keep would be wrong for every delete and restore made
   during a deploy: a deleted app would hold its HQ app against everyone, and an app restored by the
   previous revision would be live and unclaimed. Decision: a deleted holder is passed over by the
   picker, released by the birth that takes its HQ app (5.2, 5.3), and released by the restore of an
   app that takes the HQ app back from it (5.4). What a person sees is the same in every order of
   deletes, takes and restores: an app in recently deleted holds nothing against anyone, and
   restoring an app takes its HQ app back unless a live Nova app publishes there, in which case that
   deployment is ended. `softDeleteApp` is unchanged. Not done: `released_at` as a mirror of
   `apps.deleted_at`, set by `softDeleteApp` on every delete, cleared by `restoreApp` on every
   restore and set by the migration on every mapping of an app already in recently deleted, because
   of the evidence above: the column would be stale from the first minute of the deploy. A restore
   clears it only through its re-claim (5.4), and the migration's statement 7 sets it only where
   another live mapping names the same HQ app (11).
2. **No target column is filled from the reading.** Evidence: one such column exists,
   `target_empty_case_list_text` (`lib/db/pg.ts::AppDeploymentsTable`); it holds a project-space
   flag the compatibility probe reads, and part 05 (section 10.5) keeps that probe out of a reading
   because its plan is built from a document. Decision: the column is null at birth and the first
   publish fills it, as for a deployment whose publish could not read the flag. Until then a `.ccz`
   made for the adopted project space writes no empty-list text, where HQ's own build writes one if
   the flag is on. That is a stated difference of one file before one publish; the download's
   advisories are part 01's (section 6.3). Not done: filling `target_*` columns at birth from the
   reading, because the one such column holds a project-space flag and a reading does not call the
   probe that reads it.
3. **`stop_publishing` is an MCP tool, beside the tools that bring an app in.** Evidence:
   `bring_in_hq_app` lets an MCP client take the one-to-one hold, and every other act on a
   deployment a person can decide is served there (`withdraw_deployment_confirmation`,
   `refresh_deployment`). Decision: B12 registers the tool over this part's `stopPublishing`, with
   the input, scope and output of 8.3 (part 13 (`13-the-experience.md`), section 14.5, and its
   Departure 2, which counts it). Not done: serving the tools that bring an app in (`list_hq_apps`,
   `read_hq_app`, `bring_in_hq_app`) with no `stop_publishing`, and leaving the ending to the
   builder, because a hold a client can take and cannot give back would send it to the browser for
   the one act that frees an HQ app.
4. **The app's id is in the UUIDv5 name, under one fixed namespace.** Evidence: `apps.id` is opaque
   text to every reader, and Nova's two existing derivations put the app id in a JSON name under a
   fixed namespace (`caseOperationIdentity.ts`, `datetimeSplitIdentity.ts`). The effect that matters
   holds: two readings of one HQ app into one Nova app give the same UUIDs, and two Nova apps never
   share one. Not done: the app's id as the UUIDv5 namespace, with the per-kind external key alone
   as the name, because a UUIDv5 namespace must be a UUID and no reader may take `apps.id` for one
   (2.1).
5. **From the outline**, each settled here or named as another's:
   item 1's "optional stored slot" for `xmlns` is not built (the top-level file `../6-bring-in.md`,
   "What changed from the outline, and why", item 17; this part, 3);
   item 2's "ids its target holds that differ" are all of them (3.1) and its privilege move is
   insert and delete, not write (3.2);
   item 4, drift merging, is step 7's first group (`changes-made-in-hq`), and what it needs of step 6
   is section 10;
   item 10's rule for the drift merge over a deployment whose baseline is unread (its operations and
   query repeats keep the placements they hold, except a query repeat whose rule gives the count
   placement) goes with the merge to step 7's `changes-made-in-hq`, and part 15's rewrite carries
   the sentence;
   item 10's "Ending a deployment ... decides which deployments stop counting as published for
   placements" has nothing to decide (8.6), and its "baseline first refreshed from CommCare HQ" was a
   cutover's rule: at run time a baseline that does not verify reads `unread` and asks (7.3);
   the "Cutover and migration" section's merge of lookup records is part 11's (B9), by derivation,
   with no data move (part 11 (`11-project-data.md`), Departure 5).
6. **Three kinds of media path are not kept.** A media path is identity of one deployment
   (decision 6), and HQ's path is kept there wherever it can be. Evidence, each read at the pin:
   `hqmedia/tasks.py::process_bulk_upload_zip` matches a zip entry to an app path with both
   lower-cased and takes the first match, so Nova's upload cannot put two files at two paths that
   differ only by case; `hqmedia/models.py::CommCareMultimedia.get_form_path` strips the entry's
   path, so no upload reaches a path with a space at either end; a path with no directory gives HQ's
   own media suite a location with an empty segment (`media_resources`, `split_path`); and a path in
   Nova's derived shape that spells another file's hash would collide with that file's derived path
   in one archive (`multimedia/bundle.ts::buildMediaBundle` dedupes by path). Decision: such a path
   is not held, the file takes Nova's derived path on that project space as on every other, and the
   first publish moves the reference, which the first-publish register declares (4.2,
   `MediaPathRederivedReason`). It is not a finding: the app reads, and every worker sees the same
   picture. Every other path under `jr://file/`, in any directory, is kept. Not done: a row for
   every path HQ holds, because each of the three breaks a publish or an archive, as the evidence
   shows: two files that land on one path, a file no upload can place or no suite can locate, and
   two files at one archive entry.
7. **The reader's zone reaches the server for one date.** The brought-in wording, "since Nova
   brought it in on <date>", names a day, and a day is someone's. Evidence: the drift sentences are
   built in `preflight.ts` on the server and read as one text by the dialog, MCP and the logs, and
   the server holds no time zone for a person. Decision: the upload route's body gains the optional
   `viewer` (9.1), read leniently, and MCP's sentences name the UTC day. This is the one field the
   plan adds to a request for presentation alone. Not done: the server's own day in the sentences
   the browser shows, because it would be wrong by a day for a person who brought the app in on
   their evening and publishes the same evening (9.1).

---

## Files by pull request

**B2** (with the reader's frame; part 06 lists both in its own "Files by pull request")

- New: `lib/commcare/reader/identity.ts`; `lib/commcare/reader/__tests__/identity.test.ts`.

**B8**

- New: `lib/case-store/migrations/20261201000000_hq_bring_in_ledger.ts`, which holds part 09's two
  statements for `first_publish_changes` inside its statement 10 (section 11). If `main` holds a
  later-stamped migration when this pull request is rebased, the stamp moves to the next free hour
  after `main`'s newest, and every later stamp of the stack keeps its order; nothing else changes.
  `lib/case-store/migrations/__tests__/hqBringInLedger.postgres.test.ts`;
  `lib/commcare/reader/identityMap.ts` with its two tests; `lib/deployment/adoption.ts` with its test;
  `lib/db/hqAppClaims.ts` (`claimHqAppInTransaction`, `lockReleasedClaimsInTransaction`,
  `settleReleasedClaimsInTransaction`, `endDeploymentInTransaction`,
  `remapDeploymentMediaPathsInTransaction`, `HqAppAlreadyClaimedError`, `HQ_APP_CLAIM_INDEX`,
  `HQ_APP_MAPPING_OWNERSHIPS`, `HQ_APP_END_REASONS`, `NO_PHASE_OUTCOMES_JSON`) with its test;
  `lib/publish/driftReference.ts`; `lib/publish/stopPublishing.ts`; `lib/publish/hqAppClaims.ts`
  (the two row labels and the action, and no line);
  `lib/deployment/__tests__/adoptedLedger.postgres.test.ts`;
  `lib/deployment/__tests__/endDeployment.postgres.test.ts`;
  `lib/deployment/__tests__/hqAppClaimsVocabulary.test.ts`; `scripts/scan-hq-app-claims.ts`.
- Changed: `lib/case-store/migrations/index.ts`; `lib/db/pg.ts` (the two tables' types, the new
  columns; `lib/db/pg.ts::AppDatabase` types `first_publish_changes` as `JSONColumnType<{ readonly
  ids: readonly string[]; readonly webAppsOnInHq: boolean }> | null`, structural, since
  `StoredFirstPublish` lives in a B7 file); `lib/db/privilegeConvergence.ts`; `lib/db/apps.ts`
  (`restoreApp`, `RestoreClaimsChangedError`, `commitAppProjectMoveInTransaction`);
  `lib/deployment/types.ts`, `errors.ts` (`not_permitted`, `DeploymentEndedError`),
  `stateMachine.ts`, `resources.ts`, `store.ts`, `service.ts`, `preflight.ts`, `remoteChanges.ts`,
  `webApps.ts`, `observe.ts` (its gone sentence), `importApplication.ts` (`languageNames` and
  `seeds`) and `hqSourceBaseline.ts` (`languageNames`), `downloadTarget.ts`, `workers.ts`,
  `actions.ts`, `index.ts`, `CLAUDE.md`; `lib/publish/webApps.ts`; `lib/publish/planFeatures.ts`
  (`adoptionRecordedFeaturesLine`); `lib/media/manifest.ts`; `lib/export/boundaryValidation.ts`;
  `lib/commcare/multimedia/mediaSuiteXml.ts` and the comment of `assetWirePath.ts` that calls the
  directory single; `app/api/compile/prepareCompileRequest.ts`; `lib/mcp/tools/compileApp.ts`;
  `app/api/commcare/upload/route.ts` (the `viewer` field);
  `lib/mcp/tools/uploadAppToHq.ts` (the `publishing_stopped` tag only); `lib/mcp/errors.ts` (that
  tag, and `not_permitted` to `permission_denied`); `lib/apiError.ts` (`not_permitted` to 403);
  `lib/mcp/tools/deploymentProjection.ts` (the state `ended` in its served enum, so the projection
  stays total; the `ending` key is B12's, part 13, 14.7);
  `app/(app)/(site)/app-actions.ts` (`RestoreAppResult.stoppedPublishing`, and
  `RESTORE_CLAIMS_CHANGED` for `RestoreClaimsChangedError`);
  `components/builder/DeploymentStatus.tsx` (the one sentence that moves to
  `lib/publish/stopPublishing.ts`); `components/builder/PublishDialogBody.tsx` (the per-change
  sentence becomes `baselineUnknownSentence(change.since, viewerDriftDate())`, and the publish
  request sends `viewer`); `components/builder/publishOutcome.ts` (an absent `since` reads
  `published`); `proof/corpus/publish.ts` (for an `hqAuthoredA` document: ledger origin `read`,
  `adoptedAppBaselineWrite`, `adoptedIdentityRows`, the held media paths, `languageNames` and
  `seeds` `"target"`; `"nova"` for every other document; part 14 section 2.5) and its case in
  `proof/corpus/__tests__/publish.postgres.test.ts`;
  `e2e/lib/publishing-boundary.ts`; `e2e/tests/browser/publishing.spec.ts` (its hand-built
  `WebAppsChange`); `lib/deployment/service.ts::refreshKeptValues` and
  `store.ts::recordRefreshedAppBaseline` (the lines of sections 6.3, 8.5, 8.6 and 10);
  `lib/db/CLAUDE.md` (with part 09's row for `first_publish_changes`), `lib/media/CLAUDE.md`,
  `lib/commcare/CLAUDE.md`; the test files "Tests" names as additions. `biome.json` does not change:
  no file this part adds or changes gains an import of `lib/commcare` it is not already allowed
  (3.1, 5.2).
- B8 also carries what part 01 gives it: the two overlay rules of its sections 7.2 and 7.3 and the
  fiftieth `KEPT_AT_HQ` row. `targetFactsFromBaseline` (part 01, A3) projects a `read` baseline as
  it does a `push` one, and the kept list's one lead (part 01, 9.4) serves it; B8 adds no origin to
  `TargetFacts`. Those files are listed there (part 01, "Files by pull request", B8), with
  `lib/commcare/reader/appShell.ts` among them.
- B8 holds no writer and no reader of `first_publish_changes`: `adoptedAppBaselineWrite`'s
  `firstPublish`, `AppBaselineWrite.firstPublish`, `writeAppBaseline`'s clause,
  `readFirstPublishStates`, `firstPublishOf` and `DeploymentView.firstPublish` are B7's (part 09,
  section 12.3).

**A2**: the `xmlns` entry's cell and its inventory row ("Contracts").

**B14** (part 15): the `contracts.md`, root `CLAUDE.md` and `content/docs/publishing.mdx` text above.
**B15** (part 15): removes `scripts/scan-hq-app-claims.ts` with the plan.

---

## What this part needs of other parts

Each need is met by the part named, as that part is written; the section it is met in is given.

- **Part 01 (`01-the-bar-and-the-manifest.md`; A2, A3, and its lines of B8).** `READ_CIRCUMSTANCES`
  holds `already-in-nova` (the claim, 5.2 and 5.5), `unrecognized` (an identity key met twice, 2.3),
  `menu-unreadable-in-hq` and `app-unreadable-in-hq` (B1's row), as its section 8.3 lists them, with
  `unrecognized`'s detail as `name` and `already-in-nova`'s as `claim`. Its `HqAppClaimDetail` (8.1)
  is this part's `HqAppClaimView` without `remoteAppId`, and its `alreadyInNovaNext` (9.3) holds the
  line for `open` and the four `elsewhere` sentences the picker shows under this part's labels. Its
  sections 7.2 and 7.3 read whether the app mapping is adopted from the live mapping
  (`plannedInPlaceUpdate(existing)?.ownership`), which 7.1 keeps `adopted` across publishes; B8
  carries the two overlay rules of its sections 7.2 and 7.3 and the fiftieth `KEPT_AT_HQ` row,
  through the `languageNames` and `seeds` options this part adds to `HqImportApplicationInput` and
  the `languageNames` it adds to `diffHqAppSource` (6.3). `targetFactsFromBaseline` (part 01, A3)
  projects a `read` baseline as it does a `push` one, and the kept list's one lead (part 01, 9.4)
  serves it; B8 adds no origin to `TargetFacts`. A2 carries the `xmlns` entry's edit (its section
  3.3; "Contracts"). Its `refreshKeptValues` (A3, its section 6.5) is changed by B8 in four places,
  each written here: the two tests ahead of its step 1 (8.6), the `expectedEndings` and the `rebind`
  map write of its writer `recordRefreshedAppBaseline` (8.5, 10) and its `languageNames` (6.3). Its
  download advisories state Departure 2's difference (its section 6.3).
- **Part 04 (`04-names.md`; A9).** Its table of widens keeps row 20 (the `xmlns` entry) as A2's,
  with this part's cell.
- **Part 05 (`05-reading-commcare-hq.md`; B1).** `readHqAppForReading` answers `HqAppReading` with
  `version`, `source` and aligned `modules` (its sections 8.1 and 8.2); `HqAlignedForm.uniqueId` is
  the real form id (8.3); `HqAppSource` holds `raw`, `cloudcareEnabled` and `multimediaMap` (7). A
  reading with a `not-summarized` menu or a misaligned form ends before a birth
  (`menu-unreadable-in-hq`, `app-unreadable-in-hq`), so `adoptedIdentityRows`' failing arm is never
  met in production. Part 05 cites this part at sections 3.1 and 5.5 for the same hand-off (its
  "What this part needs of other parts").
- **Part 06 (`06-the-reader-forms.md`; B2, the reader's frame).** B2 carries `identity.ts`, exactly
  as sections 2.1 to 2.3 write it (its section 2.1). It declares `ReadMenuAndFormIdentities` in
  `lib/commcare/reader/types.ts` (its section 2.2), which `adoption.ts` imports. The reader takes an
  `IdentityResolver` and returns, on a `ReadOutcome` of kind `read`, `draft.identities: { entries,
  modules, forms }`. It refuses a menu with no `unique_id`, a form with no `xmlns` and two forms of
  one `xmlns` under their entries before it mints a menu or a form (its section 7.2), and maps an
  unpreempted `IdentityClaim` of `ok: false` to `unrecognized` (its section 4.4).
- **Parts 06, 07 and 08 (`06-the-reader-forms.md`, `07-the-reader-cases-menus-lists.md`,
  `08-the-reader-expressions.md`; B3 to B6, the reader's modules).** Every entity is minted through
  `externalKey.<kind>` and `resolver.claim`, with the parts of 2.2 computed from the assembled
  entity, in document order, each constructor called with its parts as arguments (2.2). Part 07
  folds a hidden registration menu into its host and lists it in the identities under
  `syntheticModuleUuid(formUuid)` (its section 8.7; part 06, section 16.1). Part 08 mints no entity.
- **Part 09 (`09-acceptance-and-the-first-publish.md`; B7, acceptance and the register).** The
  fixed-point re-read expands the document with `targetWireIdentity(rows)` and the held media paths,
  so the re-read's keys equal the reading's (its section 5), and its re-read of a split document
  calls `matchingResolver` (its section 5.4). `FIRST_PUBLISH_CHANGES` holds `media-paths-joined` for
  `MediaPathAssignment.collapsed`, and `media-path-not-holdable`, `media-path-names-another-file`
  and `media-path-differs-only-by-case` for the three `MediaPathRederivedReason`s (its section
  11.2), and lands `media-downloaded-again` on G2's outcome B as that section writes it. Its
  `sourceHoldsSaveToCase` says whether a source holds a Save to Case block (its section 2.2), over
  part 07's extended `publishedCaseBlocks` (B4). Its column `first_publish_changes` and its CHECK
  land in this part's migration, typed in `pg.ts` and worded in `lib/db/CLAUDE.md` in B8; B7 adds
  `adoptedAppBaselineWrite`'s `firstPublish` input, `AppBaselineWrite.firstPublish`,
  `writeAppBaseline`'s clause and every reader (its section 12.3).
- **Part 11 (`11-project-data.md`; B9, project data).** It resolves each media file the source
  references to an `AdoptedMediaFile`, every path of one content hash to one asset id
  (`adoptedMediaFiles`, its section 4.1). It gives its finding for a path outside `jr://file/` under
  `expressions-and-data/multimedia-map-key-not-under-jr-file-that-the-build-keeps` (its section 2.1)
  and hands every other path to `assignMediaPaths`, whatever its directory: no other path is a
  finding (its section 4.4). It adds this part's sentence to the `media-path-jr-file` cell (its
  section 13.1; "Contracts"). A table and places managed in CommCare HQ have no per-app mapping. G2's
  outcome C is its change (`withoutHeldMedia`, its "Written and not yet run").
- **Part 12 (`12-the-reading-and-the-birth.md`; B10, the reading and the birth).** Its creation
  transaction calls `claimHqAppInTransaction` first, after its reading row lock and before any other
  lock, and takes the genesis tail's membership gate after it (its section 6.3; 5.2's lock order
  here). It calls `recordAdoptedDeploymentInTransaction` after the genesis tail, with
  `pushedRevision` 1, `remoteRevision` from the bracketed read, the baseline of
  `adoptedAppBaselineWrite`, the rows of `adoptedIdentityRows` and `assignMediaPaths`, and the keys
  of `adoptionPlanFeatureConfirmations` (its sections 6.2 and 6.3). It turns
  `HqAppAlreadyClaimedError` into `already-in-nova` and keeps the reading, and answers
  `adoptedIdentityRows`' `ok: false` with `could-not-create` (its section 6.5). Its read step calls
  `readHqAppClaims` for the chosen app (its section 3.3, step 2).
- **Part 13 (`13-the-experience.md`; B11, the experience).** It draws the picker's marks (its
  section 4.3), the ended card and "Stop publishing here" on the card (11.1) and at the drift stop
  (11.3), offered only to a member who may delete (an editor who reaches the action another way
  reads the `not_permitted` sentence), the restore message (11.4) and the review's recorded-features
  line (8.8), from this part's types and Copy. It keys the ended card and `creates-beside` on
  `deploymentEnding` and never on the state. It formats the date of the ended line in the reader's
  locale; the drift sentences arrive with their date already in them (9.1). It owns their Playwright
  specs.
- **Part 13 (`13-the-experience.md`; B12, MCP).** It registers `stop_publishing` (its section
  14.5), adds `ending`, `brought_in` and `since` to its projections, and names `ended`, `ending` and
  `publishing_stopped` in its tool descriptions (its section 14.7), says in `upload_app_to_hq`'s
  description that a brought-in date is the UTC day and that `permission_denied` can answer
  `stop_publishing`, and sweeps the `upload_to_hq` skill's "the first upload creates the HQ app"
  (its section 16.2). The plugin's pull request opens with B12 and merges after stack B's deploy is
  live.
- **Part 14 (`14-proof.md`; B13, proof).** Proof 6 matches entities through `matchingResolver` over
  `externalIdentityMap` (its section 5.2). Its base `hq-media` runs G2 inside its P2 dispatch (its
  section 6.2). Its section 2.5 words the capture's ledger for an HQ-authored A, which B8 changes in
  `proof/corpus/publish.ts` ("Files by pull request"), and its section 11.2 lists B8's lane lines.
- **Part 15 (`15-stack-contracts-and-exit.md`; B14, B15, the step 7 rewrite).**
  B14 lands the `contracts.md`, root `CLAUDE.md` and public docs text above. B15 removes
  `scripts/scan-hq-app-claims.ts`. The rewrite of step 7 lists, under `changes-made-in-hq`: the
  first production reader of the baseline identity map and what is offered a deployment whose
  baseline holds none (10); and outline item 10's rule for the drift merge over an unread baseline
  (Departure 5). Its checklist holds G1, the read-only production scan, with the person's approval
  before B8 merges, and G2 inside part 14's P2.

## What other parts read from this one

- **Identity**: `HQ_ENTITY_KEY_VERSION`, `HQ_ENTITY_NAMESPACE_UUID`, `EXTERNAL_ENTITY_KINDS`,
  `KINDS_WITH_NO_EXTERNAL_KEY`, `ExternalEntityKind`, `ExternalKey`, `ExternalKeyPart`,
  `externalKey` (each constructor takes its parts as arguments), `CaseOperationPlaceKey`,
  `FormLinkTargetKey`, `EntryPointOwnerKey`, `externalKeyText`, `mintEntityUuid`,
  `IdentityResolver`, `IdentityClaim`, `IdentityMapEntry`, `mintingResolver`, `matchingResolver`
  (`lib/commcare/reader/identity.ts`);
  `externalIdentityMap`, `encodeIdentityMap`, `decodeIdentityMap`, `EncodedIdentityMap`
  (`lib/commcare/reader/identityMap.ts`).
- **Adoption**: `adoptedIdentityRows`, `AdoptedIdentityRows`, `AdoptedMediaFile`,
  `MediaPathAssignment`, `MediaPathRederivedReason`, `assignMediaPaths`, `isHoldableWirePath`,
  `adoptedAppBaselineWrite`, `adoptionPlanFeatureConfirmations` (`lib/deployment/adoption.ts`, which
  imports part 06's `ReadMenuAndFormIdentities` and declares none); `AdoptedDeploymentWrite`,
  `recordAdoptedDeploymentInTransaction`,
  `insertDeploymentConfirmationsInTransaction`, `readDeploymentMediaPaths`,
  `readAppBaselineIdentityMap` (`lib/deployment/store.ts`); `HqImportApplicationInput.languageNames`
  and `.seeds`, and `diffHqAppSource`'s `languageNames`.
- **The claim**: `HqAppKey` (its `server` is `string`), `HqAppClaimHolder`,
  `HQ_APP_MAPPING_OWNERSHIPS`, `claimHqAppInTransaction`, `HqAppAlreadyClaimedError`,
  `HQ_APP_CLAIM_INDEX`, `ReleasedClaimLocks`, `lockReleasedClaimsInTransaction`,
  `settleReleasedClaimsInTransaction` (`lib/db/hqAppClaims.ts`); `settleReleasedClaims`,
  `readHqAppClaims`, `HqAppClaimView`, which is part 01's `HqAppClaimDetail` with `remoteAppId`
  (`lib/deployment/store.ts`); `RestoredApp`, `RestoreClaimsChangedError` (`lib/db/apps.ts`);
  `RestoreAppResult.stoppedPublishing` (`app/(app)/(site)/app-actions.ts`); the lock order of 5.2.
- **Ending**: the state `ended`, `DEPLOYMENT_END_REASONS`, `DeploymentEndReason` and their `lib/db`
  twins `HQ_APP_END_REASONS`, `HqAppEndReason`; `DeploymentRecord.endings`,
  `DeploymentResource.endedReason`, `endedByName`, `adoptedByName`, `releasedAt`,
  `endDeploymentInTransaction`, `endDeployment`, `stopPublishing`, `stopPublishingAction`,
  `deploymentEnding` (read from the mappings), `DeploymentEndedError`, the failure code
  `publishing_stopped`, the error code `not_permitted` (MCP `permission_denied`, HTTP 403,
  `DeploymentActionResult`'s `not_permitted`), `NextPublishAction`'s `creates-beside`,
  `lockAppForDeploymentWrite`'s returned role.
- **Baselines and drift**: the origin `read`, `AppBaseline`'s `storedOrigin`,
  `BaselineIdentityMapWrite` (`store`, `rebind`), `DriftReference`, `DriftDateOptions`,
  `DEFAULT_DRIFT_DATE`, `driftDate`, `viewerDriftDate`, `driftReferenceOf`,
  `DeploymentRemoteChange.since`, `WebAppsChange.since`, `WebAppsChangeInput.since`,
  `PublishInput.driftDate`, the upload route's `viewer`, `hqChangedMessage`,
  `baselineUnknownSentence`, `hqChangesConfirmedDetail`, `hqChangesNoneDetail` (each beside its
  constant, which stays), and `webAppsChangeMessage`'s third argument.
- **Tables and DDL**: `app_deployment_media_paths` and its index
  `app_deployment_media_paths_path_folded`; `app_deployment_resources.server`, `domain`,
  `released_at`, `ended_by`, `ended_reason`; `app_deployments.endings`;
  `app_deployment_baselines.identity_map_gzip`, `identity_map_source_digest`;
  `app_deployment_baselines.first_publish_changes` (`jsonb`, nullable) and its CHECK
  `app_deployment_baselines_first_publish_changes_belong_to_a_read` (`first_publish_changes IS NULL
  OR origin = 'read'`), part 09's column, which B8 lands and neither reads nor writes; the index
  `app_deployment_resources_hq_app_claim`; the trigger function
  `nova_fill_deployment_resource_target`; the migration `20261201000000_hq_bring_in_ledger`.
- **Media**: `ResolveManifestOptions.heldPaths`, `PrepareExportBoundaryInput.heldMediaPaths`, the
  `mediaPaths` of a `.ccz` download target, and the media suite's per-file directory.
- **Copy**: `lib/publish/stopPublishing.ts` (with `stopPublishingConfirmBody`, `endedLine(ending,
  date)`, `restoredStoppedPublishing(spaces)`, `RESTORE_CLAIMS_CHANGED`, `PUBLISH_CLAIMS_CHANGED`);
  `lib/publish/hqAppClaims.ts` (`HQ_APP_CLAIM_OPEN_LABEL`, `HQ_APP_CLAIM_OPEN_ACTION`,
  `HQ_APP_CLAIM_ELSEWHERE_LABEL`, and no line: the line is part 01's `alreadyInNovaNext`);
  `lib/publish/planFeatures.ts::adoptionRecordedFeaturesLine`.
- **Facts**: a form's key is its `xmlns` and a question's its authored path; identity rows and media
  paths exist only on the project space an app came from; a media path is kept in any directory
  under `jr://file/`, and three kinds are re-derived and none is a finding; an app in recently
  deleted holds no HQ app against anyone, and of two deleted apps the first one restored publishes
  there; ending deletes a deployment's recorded ids, so the next publish there makes a new app; a
  publish over held media paths rebuilds HQ's map items and keeps their paths, ids and build
  versions; a brought-in drift sentence holds its date; no document slot, no document migration and
  no route comes from this part.
