# Step 6, part 11: Project data: media, lookup tables and places

This part plans what an app brought in from CommCare HQ brings with it that is not the app's own
document: its media files, the lookup tables it reads, and the places its logic reads. It plans pull
request **B9** in full: the media fetch, check and publication; the path each file keeps; lookup
tables as copies managed in CommCare HQ, with the fact stored on the Project table, the writer arm
that refuses every edit and the one that refreshes; the choice a person makes when a table meets one
the Project already has; the re-read before a publish; ownership of a Project table in a project
space derived from the Project's live mappings; places as a copy managed in CommCare HQ; levels,
location properties and worker properties as document entities; every finding; every string on the
table page, in Organization and in Files; the one surface the reading and acceptance call (section
14); and the tests. One function of section 11.5, `worldEntitiesFromReads`, lands in B6 with the
stage that calls it (part 08, `08-the-reader-expressions.md`, section 2.5), in a file this part
authors. It names what it hands to the reading and the birth (part 12,
`12-the-reading-and-the-birth.md`, B10), the reader (part 06, `06-the-reader-forms.md`, B2 and B3;
part 07, `07-the-reader-cases-menus-lists.md`, B4 and B5; part 08, B6), the experience and MCP
(part 13, `13-the-experience.md`, B11 and B12), acceptance (part 09,
`09-acceptance-and-the-first-publish.md`, B7), proof (part 14, `14-proof.md`, A1 and B13) and the
contracts pull request (part 15, `15-stack-contracts-and-exit.md`, B14).

Citations are `path::symbol`: Nova at `main` `15a00a97`, and the Dimagi checkouts at commcare-hq
`d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect
`046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every CommCare fact below was read
at those commits for this part. Nothing was run: no test, no typecheck, no lane.

Versions: B9 changes the description of `getLookupTables` and `getOrganization` and one guide
paragraph (section 12.4), so `lib/models.ts::MODEL_CONTEXT_VERSION` becomes
`"v7-hq-round-trip-bring-in.b9"` in B9 (part 15, `15-stack-contracts-and-exit.md`, decision 3 and
section 1.3: the literal moves in each pull request that changes a served tool or the guide).
`scripts/test-schema.ts` registers `getLookupTables` today and not `getOrganization`, and the root
`CLAUDE.md` has a tool registered by the pull request that first changes its description, so B9 adds
the `getOrganization` entry (12.4) and B12 sends both entries in its one billed run.
`lib/db/appTests.ts::RUNTIME_VERSION` does not move: no App Test journey pins a document that holds
anything this part adds, and this part adds no document slot.

| Section | Owns | Pull request |
|---|---|---|
| 2 | media: which files, the fetch, sniff then name, the verdicts, the pending keys and their horizon | B9 |
| 3 | media: a reference with no file, by slot and platform | B9 |
| 4 | media: publication before the birth, edges, orphans, the budget, paths, the logo | B9 |
| 5 | lookup tables: which come in, what Nova cannot hold, the caps, column types | B9 |
| 6 | the managed fact on the Project table: DDL, types, the writer arms, realtime | B9 |
| 7 | a tag that meets a Project table: the decision table and the two choices | B9 |
| 8 | the re-read before a publish, another project space, the HQ app file | B9 |
| 9 | Manage in Nova, Let CommCare HQ manage it again, Refresh | B9 |
| 10 | derived ownership across the Project's live mappings | B9 |
| 11 | places, levels, location properties, worker properties | B9 (`worldEntitiesFromReads`: B6) |
| 12 | surfaces: the table page, Organization, Files, MCP and the agent | B9 (MCP registration: B12) |
| 13 | every finding, and the manifest edits by id | B9 |
| 14 | the surface the reading (part 12) and acceptance (part 09) call, composed from 2 to 11 | B9 |

---

## Decisions in brief

1. **A file comes in when the read document references it** (2.1): every `multimedia_map` entry
   whose path a held slot names, and the Web Apps logo. An entry nothing references is not fetched.
2. **The bytes are sniffed before any name is trusted** (2.3). `lib/media/validate.ts` gains
   `validateSniffedMediaBytes`, which builds the name from the sniffed format and then runs the one
   gate. CommCare HQ's path, its extension and the response's content type decide nothing.
3. **Before the app exists, a file's bytes wait under the media contract's `pending/` key and no row
   is written** (2.5). The bucket's rule deletes them after one day and stays as it is. The reading
   keeps each file's verdict for as long as the reading lives, so "Check again" asks CommCare HQ only
   for files it has not judged, and creation fetches again any file whose bytes have lapsed.
   Departures 1 and 15.
4. **A reference with no file is judged by where it is drawn** (3). In an app that runs on Android,
   a question's, a choice's and an image column's missing file is a `fix-in-hq` finding; so is a
   question's missing sound or video in an app that runs in Web Apps, where the player shows with
   nothing to play; and so is any reference Android's media check at install reaches while that
   check is on. A menu's, a form's or the Register action's icon or audio label with no file is
   inert and listed in the review, and so, in an app that runs in Web Apps only, is a picture with
   no map entry and a choice's media.
5. **Files are published as ordinary ready rows before the birth transaction, by the code MCP's
   upload uses, extracted** (4.1). The birth's own edge writer admits the references. A creation
   that fails leaves ready files in the Project's files; a retry finds them by hash.
6. **Nova's limits stand** (2.4, 4.3): 5, 10 and 50 MB a file, 500 files and 200 MB an app. Over any
   of them is a `not-yet` finding under the manifest's entry for it, known before creation.
7. **Only the tables the app reads come in, each as a copy managed in CommCare HQ** (5, 6). Every
   column is text and every cell is CommCare HQ's string as it stands.
8. **The fact is ten nullable columns on `lookup_tables`** (6.1): where the table came from, CommCare
   HQ's id and canonical state at the last refresh, who and when, and whether a person has since
   chosen Manage in Nova. `lockLookupTableForUpdate` takes a required purpose, so every writer of an
   existing table states one and an authoring write of a managed table is refused in one place.
9. **Lookup table and column ids are UUIDv7, minted from Postgres when the reading starts** (5.5),
   and a new create arm takes them. Row ids are not predeclared: no document holds one.
10. **A tag that meets a Project table is the same table when the Project's table is managed from
    that project space, or when its columns and rows are equal, one of the Project's apps already
    publishes that very table to that project space, and a workbook there would take it as it
    stands** (7). Otherwise the review asks one question
    with two answers, "Use CommCare HQ's table" and "Use {Project}'s table", each naming the apps
    that read the table and what happens to them. An equal table nothing accounts for there is a
    question too, because the first publish would otherwise ask it. Before any answer the app is
    bound to the Project table's id, as the first answer binds it, so no answer moves a binding
    the reader read (7.4).
11. **Before a publish, Nova re-reads each managed table the app reads with the publisher's own
    key** (8.1). A column the app reads that is gone, a table that is gone, and content Nova cannot
    hold stop the publish with the next step said. Anything else refreshes the copy. Nova never
    reads CommCare HQ with another member's key. The re-read comes before `plan-features`, alone of
    the edges that ask CommCare HQ anything (Departure 14).
12. **A managed table is left out of the workbook for its own project space and pushed from the copy
    to any other** (8.2). The HQ app file carries managed tables in a second workbook, and its guide
    names each and says when to leave that file out (8.3).
13. **"Manage in Nova" is a new, confirmed action; "Let CommCare HQ manage it again" reverses it**
    (9). Neither needs a ledger row of its own: the first publish after a takeover compares CommCare
    HQ with the table's stored state and records an ordinary adopted mapping.
14. **A Project table's standing in a project space is derived from the live mappings of the
    Project's apps** (10): where a sibling app's live mapping names the table CommCare HQ holds
    under the tag, this app pushes it under that standing. Today's refusal that asks a second app to
    take over Nova's own table ends. No table, no backfill, no scan.
15. **No lock spans a CommCare HQ round trip** (10.3). The derivation is one statement at preflight
    and the managed fact is read again in one statement before the workbook goes. Departure 2.
16. **When the app's logic reads places, CommCare HQ's levels come in as document levels and its
    active places as a copy managed in CommCare HQ** (11). The fact is eight nullable columns on
    `app_organization_state`; `lockOrganizationForWrite` takes a purpose, as the lookup lock does.
    A publish to that project space sends no place; a publish to another creates them from the copy.
    Every level comes in, read or not, because a place stands at one (Departure 16).
17. **Level settings no API returns take Nova's defaults, said where they matter** (11.3): every
    level holds workers and a worker's phone carries their own branch.
18. **A location property and a worker property come in one per slug the app reads** (11.5), with
    the slug as its label, not required, no choices. Neither has a type in Nova, so nothing is typed
    from use. The reader's expression pass runs twice, the first time to learn the slugs, because a
    read binds to an entity by UUID only once the entity exists. The two pure functions the reader
    calls for this, `worldEntitiesFromReads` and `levelsFromHq`, live in the reader
    (`lib/commcare/reader/worldEntities.ts`), which may not import `lib/deployment`.
19. **`tag-types`, field properties, row attributes, tables that are not global and everything over
    a cap stay `not-yet`** (5.3), owned by step 7's `project-data-at-hq-size`.
20. **The reading calls one surface** (14): `readReadingProjectData` for tables, levels
    and places, and the `...ReadingMedia` functions for files, each composed from the functions of
    sections 2 to 11, which stay as that surface's parts. The names are the ones part 12 calls. The
    two types the review's answers carry, `ReviewTable` and `ReviewPlaces`, are declared here in a
    client-safe module (`reviewTypes.ts`), because B9 lands beneath B10 and cannot import its files.
21. **The birth writes tables and places inside the genesis tail**, through part 12's
    `afterAppInsert` seam: after the app row, before the lookup context and the organization's
    integrity step (7.4, 11.4). A table that changed under the birth sends the reading back to
    `reading` (part 12, section 6.5).
22. **A cell CommCare can't carry in a value is a finding at the reading and a stop at the re-read**
    (5.3, 8.1), so no export of an app that reads a managed table is refused for a character the
    person has no way to change in Nova.
23. **Acceptance (part 09, B7) reads three pure exports of B9** (14.3): `handOffSettlements`,
    `readingLookupSnapshot` and `readingMediaRows`. A table whose rows cannot be a question's
    choices is this part's finding (`table-choices-unusable`), found before acceptance runs.

---

## Executed during planning

Read, by group. "Read" means the enclosing function and every caller named.

- **Lookup tables in Nova.** `lib/lookup/CLAUDE.md`; `lib/lookup/writerTransaction.ts`
  (`lockLookupProjectState`, `lockLookupTableForUpdate`, `advanceLookupProjectRevision`,
  `updateLockedLookupTable`) and every caller (`service.ts` under the alias `lockTable`,
  `authoringBatch.ts::loadWork`, `schemaGovernance.ts`); `authoringBatch.ts::mintIds`, `createTable`,
  `applyLookupAuthoringBatchInTransaction`; `service.ts::createLookupTable`, `updateLookupTableTag`,
  `replaceLookupRows`, `translateExpectedSqlError`, `manifestEntryOf`; `types.ts`; `errors.ts`;
  `constants.ts`; `lib/case-store/migrations/20260722053000_lookup_tables.ts`;
  `20261004000000_app_test_lookup_definitions.ts`; `lib/collab/lookupManifestFrame.ts`;
  `lib/doc/lookupReferences.ts::extractLookupReferenceTargets`, `LookupReferenceTargetSet`;
  `lib/db/privilegeConvergence.ts` (the table sets); `lib/commcare/lookup/fixtures.ts` (header).
- **Media in Nova.** `lib/media/CLAUDE.md`; `lib/media/validate.ts::validateMediaBytes`,
  `classifyStoredMediaBytes`, `ValidationFailureReason`; `lib/media/exportBudget.ts`;
  `lib/mcp/tools/uploadMediaAsset.ts::registerUploadMediaAsset`, `recoverFailedMcpPublication`;
  `lib/db/mediaAssets.ts::insertReadyAssetInTransaction`, `ReadyAssetInsert`;
  `lib/storage/media.ts::applyMediaBucketStoragePolicy`, `verifyMediaBucketStoragePolicy`;
  `config/media-bucket-policy.json`; `lib/domain/multimedia.ts` (`ASSET_SIZE_CAPS_BYTES`,
  `MAX_MEDIA_EXPORT_ASSETS`, `MAX_MEDIA_EXPORT_BYTES`, `pendingGcsObjectKeyFor`, `gcsObjectKeyFor`).
- **Places in Nova.** `lib/organization/writerTransaction.ts::lockOrganizationForWrite`,
  `advanceOrganizationRevision`; `errors.ts`; `schema.ts` (`SITE_CODE_PATTERN`,
  `MAX_LOCATIONS_PER_APP`); `footprint.ts::locationFixtureRows`; `lib/domain/organization.ts`
  (`LEVEL_CODE_PATTERN`, `levelCaseFlowSchema`, `levelAddressBookSchema`, `locationPropertySchema`);
  `lib/domain/users.ts::userPropertySchema`; `20260802010000_organization_model.ts`;
  `lib/deployment/workerProvisionPlan.ts` (how a persona's places become CommCare HQ ids).
- **Publish.** `lib/deployment/CLAUDE.md`; `lookupResourcePlan.ts` whole; `preflight.ts`
  (`PREFLIGHT_CHECK_IDS`, `publishConfirmationNeeds`, the `project-data` and `organization` edges);
  `hqResourceBaseline.ts::canonicalLookupTable`, `lookupDefinitionChange`, `lookupRowsChange`,
  `lookupIdentityChange`; `resources.ts::leftBehindResources`; `store.ts::writeResourceBaselines`;
  `remoteChanges.ts::LOOKUP_DISCARD_NOTE`, `LOOKUP_ADOPTION_NOTE`; `types.ts::DeploymentResource`;
  `20260806000000_deployments.ts`, `20261015020000_hq_round_trip_deployment_ledger.ts`;
  `lib/export/boundaryValidation.ts::prepareWithRegistry`, `lookupHqReservedTagFindings`;
  `lib/publish/manualImportGuide.ts::lookupTablesStep`; `lib/commcare/hq/lookupTables.ts` and
  `locations.ts` (types); `lib/deployment/setupArtifact.ts` (the page addresses).
- **CommCare HQ.** `corehq/apps/hqmedia/models.py::CommCareMultimedia.attach_data`, `get_by_hash`,
  `get_by_data`, `attachment_id`, `get_class_by_data`, `get_form_path`, `HQMediaMapItem`,
  `ApplicationMediaMixin.all_media`, `logo_paths`, `remove_unused_mappings`, `create_mapping`,
  `get_media_objects`; `corehq/apps/fixtures/resources/v0_1.py::FixtureResource`,
  `LookupTableResource`; `fixtures/models.py::LookupTableRow.fields_without_attributes`;
  `fixtures/fixturegenerators.py::ItemListsProvider.to_xml`;
  `fixtures/upload/run_upload.py::_run_upload`; `locations/resources/v0_5.py::LocationTypeResource`;
  `locations/resources/v0_6.py::LocationResource`; `locations/models.py::SQLLocation`;
  `locations/util.py::validate_site_code`;
  `corehq/apps/cloudcare/static/cloudcare/js/formplayer/app.js` (the `resourceMap` reply),
  `form_entry/form_ui.js` (`mediaSrc`), `templates/cloudcare/partials/form_entry/multimedia.html`,
  `cloudcare/utils.py` (the logo's `imageUri`).
- **commcare-android.** `CommCareApp.areMMResourcesValidated`;
  `activities/DispatchActivity.handleUnvalidatedApp`; `CommCareVerificationActivity` (the skip
  button); `android/resource/installers/XFormAndroidInstaller.verifyInstallation`,
  `SuiteAndroidInstaller.verifyInstallation`; `utils/FileUtil.checkReferenceURI`;
  `views/media/MediaLayout.setAVT`, `setupStandardAudio`, `setupVideoButton`, `setupImage`,
  `showMissingMediaView`; `adapters/MenuAdapter.setupAudioButton`, `setupImageView`;
  `utils/MediaUtil.inflateDisplayImage`; `views/EntityView.setupImageLayout`;
  `preferences/HiddenPreferences.MM_VALIDATED_FROM_HQ`.
- **The plan.** The outline; parts 01, 04, 05 and 10; part 06 (its reader inputs, `ReadFacts` and
  section 17.4), part 08 (its section 5 and its need of this part) and part 12 (its sections 2.5,
  2.6, 3.3, 3.4, 5, 6.1 to 6.3 and its need of this part).
- **Where this part meets the others, and the code beneath.** Part 06 (sections 2.2, 4.5, 12.4,
  17.3 and 17.4), part 08 (section 2.5 and `ExpressionReading`), part 09 (section 2.2 and its
  need of this part), part 12 (sections 5.1, 6.5 and its need of this part), part 13 (sections
  8.5, 14.4, 14.6 and 16.2) and part 14 (sections 2.5, 6.2, 7.2, 7.5 and 11.2);
  `lib/commcare/lookup/selectSourceRows.ts::lookupSelectSourceRowFindings`;
  `lib/commcare/lookup/hqCellText.ts::lookupHqCellTextFindings`;
  `lib/commcare/lookup/workbook.ts` (`TYPES_SHEET`, `MAX_HQ_FIXTURE_WORKBOOK_ROWS`);
  `lib/export/boundaryValidation.ts::lookupHqReservedTagFindings`, `lookupWorkbookBudgetFindings`;
  `lib/deployment/preflight.ts::publishConfirmationNeeds`, `lookupRemoteChange`;
  `lib/deployment/types.ts::ResourceBaseline`; `lib/lookup/types.ts::LookupFixtureDataSnapshot`,
  `LookupReferencingAppSummary`; `lib/organization/types.ts::OrganizationSnapshot`;
  `lib/publish/manualImportGuide.ts` (`MANUAL_IMPORT_LOOKUP_WORKBOOK`); `e2e/lib/smokeProfiles.ts`;
  `biome.json` (the import rules); the entry ids of `lib/commcare/surface/entries/`.
- **The export boundary, the organization's refusals and the surfaces.**
  `lib/export/boundaryValidation.ts::prepareWithRegistry` (the two cell-text findings);
  `lib/commcare/lookup/xmlText.ts::lookupXmlTextFindings`,
  `hqCellText.ts::lookupHqCellTextFindings`, `fixtures.ts::lookupFixtureBudgetExcess`;
  `lib/commcare/multimedia/hqJsonExportArchive.ts::hqImportFileGuide`, `buildHqJsonExportArchive`
  and their two callers; `lib/organization/commitIntegrity.ts` (the three refusals a level or a
  property edit can meet); `lib/organization/service.ts::withOrganizationWrite`,
  `describeArchiveImpact`; `lib/deployment/workerProvisionPlan.ts::workerProvisionProblems`;
  `components/builder/project-data/useProjectData.ts::useProjectDataTable`;
  `lib/commcare/xpath/referenceBindings.ts::formUserProperty`; `lib/media/validate.ts` stage 3 and
  `encodingRefusal`'s `audio/mp4` arm; `node_modules/file-type` 22.3.0, `source/index.js` (the
  `<?xml ` check); `lib/storage/media.ts::downloadAssetBytes`, `getStoredObjectSize`;
  `scripts/test-schema.ts`; `lib/agent/authoring/reference.ts::AUTHORING_REFERENCE`;
  `e2e/tests/app/publish-flow.spec.ts`; `lib/deployment/__tests__/publishSequence.postgres.test.ts`
  (its `MockAgent`); `content/docs/project-data.mdx`, `organization.mdx`. CommCare HQ:
  `cloudcare/partials/form_entry/help_multimedia.html`. formplayer:
  `api/json/PromptToJson.parseCaption`, `parseQuestion`, `parseSelect`. commcare-android:
  `views/EntityActionViewUtils.setupActionAudio`, `setupActionImage`; `views/ViewUtil.addActionToMenu`.

**Read at source: a `pending/` object lives one day.** The bucket deletes a `pending/` object one day
after it is written (`config/media-bucket-policy.json`, `age: 1`), the policy is held exact
(`verifyMediaBucketStoragePolicy`: "the lifecycle rule set is not exact"), and changing it is an
infrastructure apply outside a deploy (`applyMediaBucketStoragePolicy`'s header). Decision 3 keeps
the bytes for one day and the verdicts for as long as the reading lives, and part 12 (its section
2.6) gives a reading no expiry.

**Read at source: no lock spans a CommCare HQ round trip.** `lib/deployment/CLAUDE.md`, "No lock
spans the CommCare HQ round trips": every store write is one short transaction. A derivation read at
preflight cannot hold a lock until the workbook goes. Decision 15.

**Claim corrected (the manifest cell of
`a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`): "Android shows its missing-media
placeholder".** Only inside a form and in a case list's image column. `MediaLayout.setupImage` calls
`showMissingMediaView` for a question's or a choice's image, `setupStandardAudio` shows the audio
button for any reference, `setupVideoButton` shows a download icon and a toast, and
`EntityView.setupImageLayout` draws `ic_menu_archive`. A menu's or a form's tile draws nothing:
`MenuAdapter.setupImageView` gets `null` from `MediaUtil.inflateDisplayImage`, and `setupAudioButton`
hides the button when the file is absent. The Register action draws nothing either:
`EntityActionViewUtils.setupActionAudio` shows its button only where `FileUtil.referenceFileExists`,
`setupActionImage` shows its icon only for a bitmap that is not null, and `ViewUtil.addActionToMenu`
sets a menu item's icon only for one.

**Claim corrected (the same manifest cell, whose Web Apps reading is "no image": Web Apps resolves a
path through the map and shows nothing without an entry).** True of a picture and false of a
question's sound and video. `form_entry/multimedia.html` and `help_multimedia.html` bind the `<img>`
to `visible: mediaSrc(...)` and the `<audio controls>` and `<video controls>` to `visible:
caption_audio`, `caption_video`, `help_audio` and `help_video`, which are the paths themselves:
formplayer sends them whatever the map holds (`PromptToJson.parseCaption`: `caption_audio` is
`prompt.getAudioText()`). So a question's sound or video with no entry shows a player with nothing
to play. A choice's media never reaches the Web Apps client: `PromptToJson.parseSelect` sends each
choice's text alone.

**Read at source: an entry whose `multimedia_id` is null is not the same as no entry.** The
`resourceMap` reply builds its address from any entry it finds (`'/hq/multimedia/
file/' + resource.media_type + '/' + id + '/' + name`, `formplayer/app.js`) and never reads the
entry's `url`, so such an entry gives Web Apps an address with no file behind it: "no file" (2.1).

**Read at source: `reason === "container-brand-not-accepted"` does not find an M4A that CommCare HQ
files as video.** `validateMediaBytes` gives that reason at its stage 3 only
where the name's extension says `audio/mp4`, and a name built from a sniffed `video/mp4` never does
(its other site, `encodingRefusal`'s `audio/mp4` arm, is reached only by bytes that sniff as audio).
The manifest's entry is about the pairing, not the bytes ("HQ classifies it as video, so an audio
reference never receives the bytes", `CommCareMultimedia.get_class_by_data`): an audio slot whose
map entry is a `CommCareVideo`. That is read from the source alone (2.1).

**Which paths this part sends on (part 10, `10-identity-and-the-ledger.md`, section 4.2).** One path
is a finding (a `multimedia_map` key outside `jr://file/`), and every other path goes to
`assignMediaPaths`, which holds it or re-derives it. This part refuses no path that
`isHoldableWirePath` refuses: such a path is re-derived there.

**Claim corrected (the research, `README.md`: "Worker and location properties come from the slugs
the app reads, typed from how it reads them").** `lib/domain/users.ts::userPropertySchema` holds
`uuid`, `slug`, `label`, `required` and `choices`. There is no type to give.

**Read at source: taking CommCare HQ's table is not a raw row replacement.**
`lib/lookup/service.ts::replaceLookupRows` replaces rows under the table's current columns. Taking
CommCare HQ's table means its columns too, with column identity kept by name, which is the refresh
arm of 6.4.

**Read at source: a table's rows are read through `FixtureResource` alone.** Part 05 decides it (its
section 10.2), and it is confirmed here: `FixtureResource.Meta.limit` is 0 and `obj_get_list`
filters on `fixture_type_id`.

**Confirmed, not corrected.** A workbook upload leaves a table it does not name alone:
`_run_upload` processes tables with `delete_missing=False`, and `replace` reaches only the rows of a
table the workbook names (`delete_missing=replace` in `process_table`). A media document is found by
the hash of its bytes (`get_by_data` to `get_by_hash`) and holds one attachment (`attachment_id`
asserts one id), so one `multimedia_id` is one file's bytes for as long as it exists.

---

## Written and not yet run

| Run | Where | Question | Every outcome, and what lands |
|---|---|---|---|
| R1 | the proof lane's HQ unit, `proof/views/test_lookup_upload.py`, on B9's branch, in the pull request's own lane run | Does an upload with "replace" on, naming table A, leave table B's id, definition and rows as they were? | **A**, B is byte-equal before and after (what `_run_upload` reads as): the new test `test_a_replacing_upload_leaves_an_unnamed_table_alone` stays as the control, nothing else lands. **B**, B's id or rows change: B9 does not merge as written; `lookupResourcePlan.ts::planLookupResourcePush` gains the refusal `managed-table-shares-the-space` (a project space that manages a table of the Project takes no workbook from that Project), with the message "Nova can't send lookup tables to {domain} without touching {tag}, which CommCare HQ manages there. That's Nova's to fix, and it's logged.", logged at error, and B9 records the outcome in the closing paragraph "Gated runs that write here" under "Found while planning step 6" in `docs/research/2026-09-26-hq-round-trip/harness-findings.md` (part 15, `15-stack-contracts-and-exit.md`, sections 1.4 and 8.1). |
| R2 | the lane's Android reader and Web Apps client reader, by hand through `proof-slice.yml` on B9's branch, over the new targeted document `targeted-missing-media` (8 references with no file: a question's image, a question's audio, a choice's audio, a menu's icon, a form's audio label, a case list image column's image and the Register action's icon, each with no map entry; and one question image with a map entry whose file the base deletes) | What does each runtime draw? | **A**, as read: Android shows the prompt on the question's image, the audio button on the question's and the choice's audio and the archive icon in the list, and nothing on the menu, the form or the Register action; Web Apps shows a player with nothing to play for the question's audio, nothing for the other six with no entry, and a broken picture for the eighth: section 3 stands and each is a device cell bound to the read. **B**, Android draws something on a menu tile, a form tile or the Register action: that slot (`tile` or `register-action`) joins the drawn side for Android in `mediaSlotDrawnOn` (3.2), the INERT entry's `item` loses that slot for Android, the REFUSED entry's `item` gains it, and Copy R3 is unchanged. **C**, Android draws nothing for a question's or a choice's missing file: `form` leaves the drawn side for Android, the REFUSED entry `a-media-reference-with-no-file-on-a-slot-a-runtime-draws` keeps only its Web Apps clause and the image column, and those references are inert on Android. **D**, Web Apps draws something for a picture with no entry: `web-apps` draws every slot but `unheld-itext` for `no-entry` too, the INERT entry's `item` keeps only its Android clause, and each such reference in an app that runs in Web Apps is the REFUSED entry. **E**, Web Apps shows no player for the question's audio with no entry: `form` with `audio` or `video` leaves the drawn side for `web-apps` and `no-entry`, and the REFUSED entry's `item` loses its Web Apps clause. Under each of **B** to **E**, B9 also corrects the sentence that outcome contradicts in the bullet "A media reference with no file draws differently by slot, not by platform alone" under "Found while planning step 6" in `harness-findings.md`, which names this run (part 15, sections 1.4 and 8.1). |
| G7 | part 05's (`05-reading-commcare-hq.md`, "Written and not yet run") | What `FixtureResource` answers for a row holding a field with no value | **A**: this part raises `table-rows-unreadable` at the table (5.3). **B**: `rowsHoldOtherThanOneValue` is true for it and the table is `not-yet` under `fields-properties-and-multi-valued-cells-name-lang-en-name-name`; `table-rows-unreadable` is never raised. |
| G2 | part 10's (`10-identity-and-the-ledger.md`, "Written and not yet run") | Held media paths over a published HQ app | **A** and **B** change nothing here. **C** (a path or a multimedia id differs after the bulk upload): B9 adds `lib/deployment/service.ts::withoutHeldMedia(assets, heldPaths)`, which leaves out of `buildMediaBulkUploadZip`'s input every asset that has a row in `app_deployment_media_paths` for the target (such a file is by construction the one CommCare HQ already holds at that path; a replaced file is a new asset with no row), with `publishHeldMedia.test.ts` over a held and a replaced file. |

R1 and R2 decide nothing a person sees differently in outcome A, which is what source reading gives.

---

## 1. What Nova does today

**Media.** A media file is a Project-scoped row in `media_assets` and bytes at
`projects/<project>/<sha256><ext>` (`lib/domain/multimedia.ts::gcsObjectKeyFor`). It is `pending` or
`ready`, and `ready` is terminal (`lib/media/CLAUDE.md`). A browser upload lands at
`pending/<project>/<assetId><ext>` (`pendingGcsObjectKeyFor`) and its confirm re-validates the stored
bytes; MCP's `upload_media_asset` validates in memory and publishes a caller-preallocated id as one
ready row under the Project and hash lock (`lib/mcp/tools/uploadMediaAsset.ts`), all inline in the
tool's handler. `validateMediaBytes` refuses a filename whose extension is off its list before it
sniffs. The document holds an asset id per slot and no path: `lib/media/manifest.ts::
resolveMediaManifest` derives `commcare/<sha256><ext>`. An app's referenced files are held to 500
files and 200 MB at every attach and export (`lib/media/exportBudget.ts::exportBudgetExcess`), and
the birth runs the same check (`lib/db/appGenesis.ts::writePreparedGenesisInTransaction`). Nothing
reads a media file from CommCare HQ.

**Lookup tables.** A table is `(project_id, id)` with a tag unique in the Project, typed columns and
rows keyed by column id (`20260722053000_lookup_tables.ts`). Every writer of an existing table takes
`lookup_project_state`, then the table row through `lockLookupTableForUpdate`, compares the caller's
revision, writes, advances the Project revision once and notifies (`lib/lookup/CLAUDE.md`, "Valid
writes"). No table is read-only: any editor of the Project, the SA and MCP may change any table.
Ids are minted inside the write transaction (`authoringBatch.ts::mintIds`). A publish reads the
target's tables, plans against this deployment's own live mappings
(`lookupResourcePlan.ts::planLookupResourcePush`), and sends one workbook that carries every table
the app reads (`lib/export/boundaryValidation.ts::prepareWithRegistry`). A second app of the Project
that reads the same table and publishes to the same project space has no mapping of its own, so the
plan reads Nova's own table as a stranger's and refuses with "Nova didn't make them"
(`preflight.ts`, the `project-data` edge), though `project_space_resource_baselines` is already
shared across the Project's apps.

**Places.** Levels and location properties are document entities (`lib/domain/organization.ts`).
Places are rows of `app_locations`, keyed on the app, and every writer takes
`lockOrganizationForWrite` (`lib/organization/writerTransaction.ts`). A publish plans the places
against the deployment's `location` mappings and pushes them in batches
(`locationResourcePlan.ts::planLocationResourcePush`). Levels have no writable resource
(`locations/resources/v0_5.py::LocationTypeResource`, GET only), so they are instructions in the
setup artifact. Provisioning a worker turns a persona's places into CommCare HQ ids through the
deployment's `location` mappings (`workerProvisionPlan.ts`). Preview builds a persona's `locations`
instance from the rows and the levels' settings (`footprint.ts::locationFixtureRows`).

**Worker properties.** A slug, a label, `required` and `choices`, no type
(`lib/domain/users.ts::userPropertySchema`).

---

## 2. Media: which files, the fetch and the verdict

All of this section's new code that speaks of findings lives in
`lib/deployment/reading/projectData/media.ts` (new; `lib/deployment` is an allowed consumer of
`lib/commcare`), which is pure. The functions that fetch, stage, publish and discard bytes
(`fetchAndStageHqMediaFile`, 2.2, and `stageReadingMedia`, `publishReadingMedia` and
`discardReadingMedia`, 14.2) are in `mediaStore.ts` beside it (section 14, "Pure files and store
files"). `lib/media` gains two functions and stays free of findings.

### 2.1 Which files

The reader's form and menu modules (B3, B4) return, with the batch, every media reference they read:

```ts
/** `lib/deployment/reading/projectData/media.ts`. One reference in the app's source. */
export interface HqMediaReference {
	/** The path as the source spells it. */
	readonly path: string;
	/** The kind of slot it stands in. */
	readonly kind: MediaKind; // "image" | "audio" | "video", lib/domain/multimedia.ts
	readonly slot: HqMediaSlot;
	readonly place: HqPlace; // lib/publish/hqFindings.ts
}
export const HQ_MEDIA_SLOTS = [
	/** A question's label or help media. */
	"form",
	/** A choice's media. Apart from `form` because the Web Apps client never receives it (3.1). */
	"choice",
	/** An image column's image in a case list or a case detail. */
	"list-image",
	/** A menu's, a form's or a case list menu item's icon or audio label. */
	"tile",
	/** The Register action's icon or audio label (part 02's always-offered arm). */
	"register-action",
	/** The Web Apps logo. */
	"logo",
	/** An itext media form on a slot Nova holds no media for: a hint, a validation message, a
	 *  group's or a repeat's label. Never held; listed only for Android's install check (3.2). */
	"unheld-itext",
] as const;
export type HqMediaSlot = (typeof HQ_MEDIA_SLOTS)[number];
```

Part 06 (B2, B3) writes the reader's side of this as it stands (its section 12.4): a reference whose
path the media index resolves is a `ReadMediaReference` in `ReadFacts.mediaReferences`, and one it
does not is a `PendingMedia` in `ReadFacts.pendingMedia`, each with the `path`, the `mediaKind`, the
`place` and a `slot` that names a `lib/domain/mediaRefs.ts::MediaRefLocation` kind.
`hqMediaReferencesOf(facts: ReadFacts): readonly HqMediaReference[]` (this file) is the one bridge.
It takes `kind` from the reference's `mediaKind` and `slot` by this table, and it throws on a slot
string the table lacks, so a new carrier cannot pass unjudged:

| The reader's `slot` | `HqMediaSlot` |
|---|---|
| `field_media_bundle` | `form` |
| `option_media` | `choice` |
| `image_map_mapping` | `list-image` |
| `module_icon`, `module_audio_label`, `form_icon`, `form_audio_label`, `case_list_icon`, `case_list_audio_label` | `tile` |
| the two kinds part 02 (A5) adds for the always-offered Register action's icon and audio label | `register-action` |
| `app_logo` | `logo` |
| `unheld_itext` (not a `MediaRefLocation`: the reader's own word for a media form on a slot Nova holds none for) | `unheld-itext` |

`ReadFacts` carries the pending references and the unheld itext media forms beside the resolved
ones (part 06, section 17.3), and part 07's `readNavMedia` (B4) writes the menu and list kinds
through the same index.

The Web Apps logo is the reference `{ path: source.logoRefs.hq_logo_web_apps.path, kind: "image",
slot: "logo", place: { kind: "app-settings" } }`, present where that entry holds a string `path` and
an `m_id` (the manifest's HELD entry `application-and-settings/logo-refs-hq-logo-web-apps`: "import
reads the logo HQ's uploader holds through the media map"). The three Android slots are kept at
CommCare HQ's value (part 01, section 4.3) and are not references. Media that differs by language is
the form and menu readers' finding (part 01, section 3.5, landing in B3 and B4), so every reference
that reaches this section is one shared slot.

`planHqMedia` is pure:

```ts
export interface HqMediaFile {
	/** `<mediaType>/<multimediaId>`: the key a verdict is filed under. */
	readonly key: string;
	readonly mediaType: Exclude<HqMediaType, "CommCareMultimedia">;
	readonly multimediaId: string;
	/** The kind Nova fetches it as: Image, Audio or Video by `mediaType`. */
	readonly kind: MediaKind;
	/** Every referenced path that names it, in code-unit order. */
	readonly paths: readonly string[];
	/** The references whose `kind` is this file's `kind`. Never empty. */
	readonly references: readonly HqMediaReference[];
}
export interface HqMediaPlan {
	readonly files: readonly HqMediaFile[];
	/** Findings known from the source alone. */
	readonly findings: readonly Finding[];
	/** References Nova leaves out because nothing draws them (section 3). */
	readonly inert: readonly HqMediaReference[];
	/**
	 * The manifest entry each reference with no asset stands under, for the reading's claim log
	 * (part 06's `ClaimRecord`: the surface key is `schema:Application.multimedia_map`).
	 */
	readonly claims: readonly { readonly reference: HqMediaReference; readonly entry: string }[];
	/** The input's three values, kept because section 3's rule is run again for a file whose
	 *  verdict is `missing` (2.4). Held in memory; never stored. */
	readonly references: readonly HqMediaReference[];
	readonly runsOn: readonly Platform[];
	readonly contentValid: string | null;
}
export function planHqMedia(input: {
	readonly references: readonly HqMediaReference[];
	readonly multimediaMap: readonly HqMediaMapItem[]; // part 05, section 7
	/** The platforms of the declaration the draft proposes (part 06, section 16.3): 3.2's "the
	 *  app runs on". */
	readonly runsOn: readonly Platform[];
	/** `profile.properties["cc-content-valid"]` as the source holds it, or null. */
	readonly contentValid: string | null;
}): HqMediaPlan;
```

For each reference, by its path's entry in `multimediaMap`:

| The path | Result |
|---|---|
| does not start with `jr://file/` and the map holds an entry for it | finding `expressions-and-data/multimedia-map-key-not-under-jr-file-that-the-build-keeps` at `{ kind: "media", path }` (part 10, section 4.2, step 1) |
| has no entry | section 3, "no entry" |
| has an entry with `multimediaId === null` and `unreadable: false` | section 3, "no file": the entry names no file, and Web Apps still builds an address from it (the `resourceMap` reply in `formplayer/app.js` reads `media_type` and `multimedia_id` of any entry it finds, never `HQMediaMapItem.url`) |
| has an entry with `unreadable: true` | section 3, "no file" (the map names a file Nova cannot ask for) |
| has an entry of type `CommCareMultimedia` | finding `unrecognized` at the reference, `detail.name` the path: an image, audio or video slot naming a file HQ files as neither is a shape no entry names, logged at error |
| is an audio reference and its entry is a `CommCareVideo` | finding `expressions-and-data/audio-m4a-with-another-brand-isom-mp41-mp42-dash` (REFUSED, `fix-in-hq`) at the reference, `detail.name` the path. The reference is in no file's `references`, and the file is fetched only if a video reference also names it |
| has an entry of any other type whose kind is not the reference's `kind` (a picture slot naming a sound, a video slot naming a picture) | finding `unrecognized` at the reference, `detail.name` `"<path> (<slot kind> slot, <entry type>)"`, logged at error. The reference is in no file's `references` |
| has an entry of type `CommCareImage`, `CommCareAudio` or `CommCareVideo` that is its own kind | a file: one `HqMediaFile` per distinct `(mediaType, multimediaId)` |

The audio row is the manifest entry's own case, read from the source: CommCare HQ types a file by
its bytes (`CommCareMultimedia.get_class_by_data`), files an M4A of another brand as video, and "an
audio reference never receives the bytes" (the entry's reason, whose surface key is
`media-class:CommCareVideo`). An audio 3GP is filed as video for the same reason and reaches the
same row (the entry `expressions-and-data/audio-3gp` shares that surface key). Telling the two
containers apart needs the bytes, and Nova fetches no file for a slot that can never play it, so
the finding is filed under the M4A entry, whose reason states this fact; both entries are REFUSED
with one subject and one sentence, so the person reads the same thing either way. Without this row
the file would be fetched as a video, judged `held`, and handed to an audio slot, which the birth's
`admitExactMediaReferences` refuses ("the wrong kind for its authored slot",
`lib/db/canonicalCommitKernel.ts`): a gate refusal at creation, which 4.3 rules out.

More than `MAX_MEDIA_EXPORT_ASSETS` files is a finding at once, with no fetch (4.3).

### 2.2 The fetch

Part 05 plans the read (`lib/commcare/hq/media.ts::readHqMediaFile`, its section 9), made with the
credential Nova already stores, bounded, with one resend. Part 12's media step calls
`stageReadingMedia` (14.2), which runs `HQ_MEDIA_READ_CONCURRENCY` at a time over at most
`HQ_MEDIA_FILES_PER_STEP` files and calls, for each file that has no verdict yet:

```ts
export type HqMediaVerdict =
	| { readonly kind: "held"; readonly staged: StagedMediaFile } // lib/media/stagedMediaFile.ts, 2.5
	| { readonly kind: "missing" }
	| { readonly kind: "over-limit"; readonly mediaKind: MediaKind; readonly capBytes: number }
	| { readonly kind: "refused"; readonly reason: ValidationFailureReason;
	    readonly sniffedMime: string | null }
	| { readonly kind: "wrong-kind"; readonly sniffedKind: AssetKind };

/** One file, fetched, judged and staged. A failed read is returned for the step to classify. */
export function fetchAndStageHqMediaFile(input: {
	readonly creds: CommCareCredentials;
	readonly projectId: string;
	readonly file: HqMediaFile;
	/** The asset id the reading reserved for this file (14.2). */
	readonly stagingId: MediaAssetId;
	readonly signal?: AbortSignal;
}): Promise<HqMediaVerdict | CommCareApiError>;
```

1. `readHqMediaFile(creds, file.mediaType, file.multimediaId, { maxBytes:
   ASSET_SIZE_CAPS_BYTES[file.kind], signal })`.
2. `missing` is the verdict `missing`. `too-large` is `over-limit` with that kind and cap. A
   `CommCareApiError` is returned as it is: `stageReadingMedia` classifies it and part 12 stops the
   step with `hqReadCircumstance`'s code, since a file CommCare HQ could not send this minute is no
   fact about the app, and no verdict is written for it.
3. `validateSniffedMediaBytes(Buffer.from(bytes))` (2.3). Not ok: `refused`. Ok with a kind other
   than `file.kind`: `wrong-kind`. Ok with `sizeBytes` over the sniffed kind's cap cannot happen
   (the gate refuses it as `size-cap-exceeded`, which is `refused`).
4. `stageMediaBytes({ projectId, stagingId, bytes, validated, originalFilename })` (2.5): `held`.

The verdict is filed under `file.key` in the reading's row: its `media` column holds this part's
`ReadingMediaPlan` (14.2), whose `verdicts` is a `Record<string, HqMediaVerdict>` parsed by
`hqMediaVerdictSchema: z.ZodType<HqMediaVerdict>` (this file): a `z.discriminatedUnion("kind", ...)`
of five `z.strictObject` arms holding exactly the members above, `staged` parsed by
`stagedMediaFileSchema` (2.5), `mediaKind` by `z.enum(MEDIA_KINDS)`, `sniffedKind` by
`z.enum(ASSET_KINDS)` (both of `lib/domain/multimedia.ts`), `capBytes` a positive integer, `reason`
a `z.enum` of `ValidationFailureReason`'s members and `sniffedMime` a nullable string. One
`multimedia_id` is one file's bytes for as long as CommCare HQ holds it
(`CommCareMultimedia.get_by_data`, `attachment_id`), so a verdict stays true while the reading
lives, and "Check again" fetches only the files of the fresh read that have none.

### 2.3 Sniff, then name

`lib/media/validate.ts` gains:

```ts
export type SniffedMediaValidation =
	| { readonly ok: true; readonly validated: ValidatedMediaMetadata }
	| { readonly ok: false; readonly reason: ValidationFailureReason; readonly message: string;
	    /** What `file-type` reported, normalized where Nova knows the format, else as reported;
	     *  null where it reported nothing. */
	    readonly sniffedMime: string | null };

/**
 * Judge bytes that arrive with no name Nova can trust. The format is read from the bytes, the
 * name is built from it, and the one gate runs over that name.
 */
export async function validateSniffedMediaBytes(bytes: Buffer): Promise<SniffedMediaValidation>;
```

In order: `fileTypeFromBuffer(bytes)`.

- **SVG first.** `file-type` (22.3.0, the installed version) answers `{ ext: "xml", mime:
  "application/xml" }` for bytes that begin `<?xml ` (`source/index.js`, the `checkString('<?xml ')`
  arm and its two UTF-16 twins) and nothing for bytes that begin `<svg`. So: where the sniff answers
  nothing, `application/xml` or `text/xml`, the bytes are decoded as text (UTF-8, or UTF-16 by
  their byte order mark), and `looksLikeSvg(text)` asks whether, after a byte order mark, white
  space, one XML declaration, comments and one `<!DOCTYPE ...>`, the first element's local name is
  `svg` in any case. It is a scan of the document's first tag, bounded at the first 4 KiB, and it
  parses nothing else. True: `{ ok: false, reason: "svg-not-accepted", message: SVG_REFUSAL_MESSAGE,
  sniffedMime: "image/svg+xml" }`.
- **Nothing sniffed, and no SVG**: `magic-bytes-sniff-failed` with `sniffedMime: null`.
- **A sniffed type `normalizeMimeType` does not know** (any other XML among them):
  `mime-claim-mismatch` with the reported string.
- **A known type**: `validateMediaBytes({ bytes, claimedMimeType: mime, claimedSizeBytes:
  bytes.length, originalFilename: "file" + ext })`, `ext` the canonical extension of that type in
  `ACCEPTED_FORMATS`, and its result with `sniffedMime: mime`.

The last arm is the shape `classifyStoredMediaBytes` already uses for a stored row; the new function
differs only in where the type comes from. Text kinds never reach it: a document sniffs as itself
or as nothing.

The response's content type is not read (Departure 9). `StagedMediaFile.originalFilename` (2.5) is
the last segment of the file's first path, with the canonical extension appended where the segment
does not already end in one of that format's declared extensions, so Files shows the name the
author gave the file in CommCare HQ.

### 2.4 Verdicts to findings

`mediaFindings` is pure. `readingMediaFindings` (14.2) calls it, and part 12 calls that on every
read step, so after each media step and at "Check again":

```ts
export function mediaFindings(input: {
	readonly plan: HqMediaPlan;
	readonly verdicts: Readonly<Record<string, HqMediaVerdict>>;
	/** Every platform some declaration choice of the draft declares (part 06, section 16.3): what
	 *  the rest of the app can run on. Not `plan.runsOn`, which is the one proposed choice's. */
	readonly runsOn: readonly Platform[];
}): { readonly findings: readonly Finding[];
      /** Platforms every held file plays on, of `runsOn`
       *  (`lib/domain/multimedia.ts::mediaFormatPlaysOn`). */
      readonly playsOn: readonly Platform[];
      /** True when every file of the plan has a verdict. */
      readonly complete: boolean };
```

| Verdict | Finding | Standing | Place and `detail.name` |
|---|---|---|---|
| `over-limit` | `expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app` | not-yet | `{ kind: "media", path: file.paths[0] }`; name `"<path> (over <cap> MB, the most Nova takes for <a picture / a sound / a video>)"` |
| `refused`, by `hqMediaRefusalEntry` (below) | the format's own REFUSED entry | fix-in-hq, cause `breaks-when-run` | the media place; name the path |
| `refused`, no entry | `unrecognized` | not-yet | name the path; logged at error with the reason and the sniffed type |
| `wrong-kind` | `unrecognized` | not-yet | name the path; logged at error |
| `missing` | section 3, "no file", for each of the file's references, over `plan.references`, `plan.runsOn` and `plan.contentValid` | | |
| `held`, where `playsOn` is empty and the file's `mediaFormat` does not play on every platform of `runsOn` | `media-not-played-where-app-runs` (13.2) | fix-in-hq | name the path |

`hqMediaRefusalEntry(sniffedMime, reason, mediaType): string | null` reads the sniffed type's
subtype, lower case, and takes the first row that matches:

| Test | Entry |
|---|---|
| `reason === "svg-not-accepted"`, or the subtype holds `svg` | `expressions-and-data/image-svg` |
| the subtype holds `tiff`, `heic` or `heif`; or the subtype is `avif` and the reason is `image-parse-failed` | `expressions-and-data/image-tiff-heif` |
| the subtype holds `wav` | `expressions-and-data/audio-wav-that-is-not-8-or-16-bit-pcm` |
| `reason === "container-brand-not-accepted"` | `expressions-and-data/audio-m4a-with-another-brand-isom-mp41-mp42-dash` |
| the subtype holds `3gpp` and `mediaType === "CommCareAudio"` | `expressions-and-data/audio-3gp` |
| the subtype holds `3gpp`, `quicktime`, `avi` or `msvideo`; or the type starts `video/` and its subtype holds `ogg`; or the type starts `video/` and the reason is `codec-not-accepted` or `media-parse-failed` | `expressions-and-data/video-av1-mov-avi-ogg-theora-h-263-3gp` |
| anything else | `null` |

The keys are substrings because `file-type` has spelled several of these two ways across versions
(`video/x-msvideo` and `video/vnd.avi`), and a substring holds both. A format no row names is
`unrecognized`: Nova's to classify, and the log names the type so the row can be added.

Two rows are narrower than they look. `ogg` counts only under `video/`: `audio/ogg` is a format Nova
takes (`ACCEPTED_FORMATS`), so an Ogg sound refused for its codec (Speex, FLAC in Ogg) is no video,
and with no audio row of its own it is `unrecognized`. And the `container-brand-not-accepted` row
is a guard, reached only by bytes that sniff as audio MP4 under a brand other than `M4A ` or `M4B `
(`encodingRefusal`'s `audio/mp4` arm): the M4A that CommCare HQ files as video never reaches a
verdict, because 2.1 finds it from the source.

A held file that plays on only some platforms narrows the declarations the review offers:
`narrowDeclarationsByMedia` (14.2) drops each choice that declares a platform outside `playsOn`.
`media-not-played-where-app-runs` is raised exactly where `playsOn` is empty, so that no choice
would be left: on each held file that does not play on every platform of `runsOn`, since each such
file is part of why. Where `playsOn` holds a platform, no held file raises it.

### 2.5 The pending keys, and their horizon

`lib/media/stagedMedia.ts` (new), with the type and its schema in `lib/media/stagedMediaFile.ts`
(new, pure: its only run-time import is `zod`), which `stagedMedia.ts` imports (section 14, "Pure
files and store files"):

```ts
// lib/media/stagedMediaFile.ts: the schema and the interface. lib/media/stagedMedia.ts: the function.
export const stagedMediaFileSchema: z.ZodType<StagedMediaFile>;
export interface StagedMediaFile {
	/** The id the caller reserved: the object's key, and the asset's id if these bytes are
	 *  published as a new file. */
	readonly stagingId: MediaAssetId;
	readonly contentHash: string;
	readonly mimeType: AssetMimeType;
	readonly extension: string;
	readonly kind: MediaKind;
	readonly sizeBytes: number;
	readonly mediaFormat: MediaFormatKey;
	readonly dimensions?: { readonly width: number; readonly height: number };
	readonly durationMs?: number;
	readonly originalFilename: string;
	readonly stagedAt: string;
}
export function stageMediaBytes(input: {
	readonly projectId: string; readonly stagingId: MediaAssetId; readonly bytes: Buffer;
	readonly validated: ValidatedMediaMetadata; readonly originalFilename: string;
}): Promise<StagedMediaFile>;
```

`stageMediaBytes` writes the validated buffer with `lib/storage/media.ts::uploadAssetBytes` to
`pendingGcsObjectKeyFor(projectId, stagingId, validated.extension)`, which is
`pending/<projectId>/<stagingId><ext>`, the key a browser upload's attempt takes. It writes no
`media_assets` row. So before the app exists a brought-in file is in no one's Files, counts against
no budget and is no asset state: it is bytes under the prefix the media contract already owns, whose
rule deletes what nobody confirmed. The id is the caller's because the reading reserves one id per
file before any byte is fetched (14.2), so the document names the same asset before and after the
media step, and two drivers of one reading that stage one file write the same bytes to the same key.

**Why no row** (Departure 15). The media contract's pending state is a `media_assets` row with a
Project and an uploader (`lib/media/CLAUDE.md`, "Two statuses"), and "the dangling row itself is
never reaped". A reading may be removed, or left for good, with every file staged; rows for those
files would stay in the Project's table for ever with no reaper, where the bytes under `pending/`
are deleted by the rule that already exists. The key is the contract's; the row is not written.

**The horizon, decided.** Staged bytes are kept one day, which is what the bucket gives
(`config/media-bucket-policy.json`). Not done: a longer rule for `pending/`, such as seven days,
because moving it means an infrastructure apply between the merge and the deploy plus six more days
of every abandoned browser upload, for a wait that is avoidable another way. So: the reading keeps
each file's **verdict** for the reading's own life, and the bucket keeps its **bytes** for a day.
What a person meets:

- "Check again", on any day: Nova asks CommCare HQ only for files with no verdict. A file judged
  held, over the limit or unplayable is not fetched again to say so.
- "Create", within a day of the media step: the bytes are there.
- "Create", later: `publishReadingMedia` (14.2) finds which staged files have lapsed
  (`publishStagedMedia`'s `lapsed`, 4.1), reads each again from CommCare HQ with the creator's own
  key, checks that the bytes are the ones that were judged, and publishes them. Creation goes on
  in part 12's `publishing-media` phase, whose label is part 12's (its Copy C4). A file CommCare HQ
  no longer has, or whose bytes are now others, loses its verdict: the reading stays `ready`, and
  a creation step fetches and judges that file again with `stageReadingMedia`, the one judge of a
  file (14.2; part 12, section 6.1).

`lib/media/CLAUDE.md` gains the sentence under "Upload" (Contracts).

---

## 3. A reference with no file

Two source facts look alike and are told apart by the map (part 01, section 8.3): **no entry** (the
path is in no `multimedia_map` entry) and **no file** (the entry names no file, or names one CommCare
HQ does not serve: a null `multimedia_id`, the verdict `missing`, or an `unreadable` entry).

### 3.1 What each runtime does, read at source

| Slot, kind | Web Apps, no entry | Web Apps, no file | Android, either |
|---|---|---|---|
| `form`, image | nothing: the `resourceMap` reply returns `undefined` for a path the map lacks (`formplayer/app.js`), and the `<img>` is `visible: mediaSrc(...)` (`multimedia.html`, `help_multimedia.html`) | the reply builds an address from the entry, so the picture shows broken | the missing-file prompt (`MediaLayout.setupImage` to `showMissingMediaView`) |
| `form`, audio or video | a player with nothing to play: the `<audio controls>` and `<video controls>` are `visible: caption_audio`, `caption_video`, `help_audio` and `help_video`, the paths formplayer sends whatever the map holds (`PromptToJson.parseCaption`, `parseQuestion`) | the same player, with an address that has no file | audio shows its button for any reference (`setupStandardAudio`); a video shows the download icon and a toast (`setupVideoButton`) |
| `choice` | nothing: the client never receives a choice's media, because formplayer sends each choice's text and nothing else (`PromptToJson.parseSelect`) | nothing, for the same reason | as `form`: the select widgets lay out each choice through `MediaLayout.buildAudioImageVisualLayout`, which runs the same `setAVT` as a question's label |
| `list-image` | nothing | a picture with no file | `ic_menu_archive` (`EntityView.setupImageLayout`) |
| `tile` | nothing (`menus/views.js`: `imageUrl` is the reply's answer) | a picture with no file | nothing: no bitmap (`MediaUtil.inflateDisplayImage` returns `null`) and the audio button is hidden (`MenuAdapter.setupAudioButton`) |
| `register-action` | nothing | a picture with no file | nothing: the audio button shows only where the file exists (`EntityActionViewUtils.setupActionAudio`, `FileUtil.referenceFileExists`), the icon only for a bitmap that is not null (`setupActionImage`), and the action bar's item takes an icon only for one (`ViewUtil.addActionToMenu`) |
| `logo` | nothing (`cloudcare/utils.py` hands the path to the same reply) | a picture with no file | Android ignores this slot (the entry's platform cell) |
| `unheld-itext` | no runtime draws it (`lib/media/CLAUDE.md`) | the same | the same |

And Android's media check at install, which runs while `cc-content-valid` is not `yes`
(`CommCareApp.areMMResourcesValidated`; the setting is kept at CommCare HQ's value, part 01's
`application-and-settings/17-properties-cc-content-valid`): it checks every `image`, `audio` and
`video` form of every itext entry in every language (`XFormAndroidInstaller.verifyInstallation`),
then each suite entry's audio and icon and each menu's
(`SuiteAndroidInstaller.verifyInstallation`), and the app does not open until they are present or
the person skips (`DispatchActivity.handleUnvalidatedApp`, `CommCareVerificationActivity`).

### 3.2 The rule

```ts
/** Whether a platform draws something for a missing file of this kind in this slot. */
export function mediaSlotDrawnOn(
	slot: HqMediaSlot, kind: MediaKind, platform: Platform, missing: "no-entry" | "no-file",
): boolean;
/** Whether Android's install check reaches the reference, by the manifest entry's own wording. */
export function androidInstallCheckReaches(reference: HqMediaReference, all: readonly HqMediaReference[]): boolean;
```

`mediaSlotDrawnOn`, by 3.1: on `android`, true for `form`, `choice` and `list-image` of any kind,
and false for `tile`, `register-action`, `logo` and `unheld-itext`; on `web-apps`, false for
`choice` and `unheld-itext` whatever is missing, true for every other slot when `missing` is
`no-file`, and when it is `no-entry` true only for `form` with `audio` or `video`.

`androidInstallCheckReaches`: true for a `form`, `choice` or `unheld-itext` reference (every itext
media form); for a `tile` reference on a form or a case list menu item, true for its audio, and for
its icon where that same entry also carries audio; for a `tile` reference on a menu, true only
where every form, every case list menu item and every earlier menu carries both an icon and an
audio label, and then for its audio, and for its icon where that menu also carries audio. This is
the condition the entry
`expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install` states, word for
word.

For a reference with no entry or no file, first match:

| # | When | Result |
|---|---|---|
| 1 | the app runs on Android, `contentValid !== "yes"`, and `androidInstallCheckReaches` | finding `expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install` (REFUSED, `fix-in-hq`) at the reference's place, name the path |
| 2 | some platform the app runs on draws it (`mediaSlotDrawnOn`) and there is no entry | finding `expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws` (new, REFUSED, `fix-in-hq`; 13.1) |
| 3 | some platform the app runs on draws it and there is no file | the circumstance `media-file-unreadable` at `{ kind: "media", path }`, name the path |
| 4 | otherwise | inert: the reference is in `HqMediaPlan.inert`, the reader assembles the slot with no media (its `no-entry` and `unreadable` arms put no asset in a slot), and `HqMediaPlan.claims` files the reference under the INERT entry `expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` (13.1) |

"The app runs on" is `runsOn`, the declaration the draft proposes: what the content runs on,
narrowed to Android where CommCare HQ's Web App setting is off (part 06, section 16.3). A person
who would rather declare Web Apps only cannot pick that to pass row 2, because the account comes
before the review; the finding's next step is the one that also fixes the app for its workers.

Row 4's references are listed in the review ("What Nova leaves out", Copy R3). The first publish
then removes those paths from the forms and menus, and CommCare HQ drops their map entries
(`remove_unused_mappings`). Nothing a worker sees changes, by 3.1, so the first-publish register
needs no entry that touches workers; part 09's `FIRST_PUBLISH_CHANGES` (its section 11.2, B7) holds
row 33, `media-references-with-no-file-removed` (predicate: `mediaLeftOut`, which is
`HqMediaPlan.inert.length`, is above zero; touches workers: no), so the lane's observed difference
has a name.

---

## 4. Media: publication, edges, the budget, paths

### 4.1 Before the birth transaction

`lib/media/publishReadyMedia.ts` (new) is the body of MCP's upload, extracted with no change of
behavior, and `lib/mcp/tools/uploadMediaAsset.ts` calls it:

```ts
export type ReadyMediaPublication =
	| { readonly kind: "published"; readonly assetId: MediaAssetId }
	| { readonly kind: "deduplicated"; readonly assetId: MediaAssetId };

/**
 * Publish validated bytes as one ready file of a Project, or return the ready file that already
 * holds them. Proves `edit` on the Project inside each metadata transaction.
 */
export function publishReadyMedia(input: {
	readonly actorUserId: string; readonly projectId: string; readonly bytes: Buffer;
	readonly validated: ValidatedMediaMetadata; readonly originalFilename: string;
	/** The id a new row takes. */
	readonly assetId: MediaAssetId;
}): Promise<ReadyMediaPublication>;
```

It holds `withMediaObjectKeyLock(gcsObjectKeyFor(projectId, hash, ext))` around the dedup probe
(`findReadyAssetByProjectAndHash`), `uploadAssetBytes` and `insertReadyAssetInTransaction`, with the
lost-commit recovery that file's `recoverFailedMcpPublication` does today, which moves with it as a
private function.

`withUploadPermission` moves too, less its errors. Today it throws `McpAccessError("not_owner",
"project")` for a caller with no role and `ProjectPermissionError(UPLOAD_PERMISSION_MESSAGE)` for a
role without `edit`, both types of `lib/mcp`, which `lib/media` may not import. So the moved
function throws `lib/media/publishReadyMedia.ts::MediaPublishPermissionError`, whose `reason` is
`"not-a-member" | "cannot-edit"`, and `uploadMediaAsset.ts` catches it around its one call and
throws the same two errors it throws today, with today's message. The tool's answers do not change,
which `uploadMediaAsset.postgres.test.ts` holds with its assertions as they stand.

`lib/media/stagedMedia.ts`:

```ts
export const STAGED_MEDIA_PUBLISH_CONCURRENCY = 2; // the media contract's two key-lock bodies
export interface PublishedStagedMedia {
	/** By `stagingId`. */
	readonly published: ReadonlyMap<MediaAssetId, { readonly assetId: MediaAssetId;
		readonly contentHash: string; readonly extension: string }>;
	/** Staged files whose bytes are gone, or no longer the bytes that were judged. */
	readonly lapsed: readonly StagedMediaFile[];
}
export function publishStagedMedia(input: {
	readonly actorUserId: string; readonly projectId: string;
	readonly staged: readonly StagedMediaFile[];
}): Promise<PublishedStagedMedia>;
```

For each staged file, two at a time: `downloadAssetBytes(pendingKey,
ASSET_SIZE_CAPS_BYTES[staged.kind])`, the reader's own signature (a key, a byte cap, an optional
signal). It streams the object and throws what storage throws, so an absent object is told by the
error's `code` of 404, as `getStoredObjectSize` and `readTextObject` in that file tell it: that one
is `lapsed`, and any other failure is thrown. The bytes are judged again with
`validateSniffedMediaBytes` (the contract's rule that a publication re-derives everything from the
stored bytes), and a refusal or a `contentHash` other than the staged one is `lapsed`. Then
`publishReadyMedia` with `assetId: staged.stagingId`, and the pending object is deleted
(`deleteAsset`, best effort: the bucket's rule is the backstop). Running it twice is safe: the
second run finds each file by Project and hash.

Creation reaches it through `publishReadingMedia` (14.2), which part 12 calls after the person asks
to create and before it prepares the candidate, because a deduplicated file's id is an existing
asset's and the document must name it. `adoptedMediaFiles(files: readonly PublishedReadingFile[]):
readonly AdoptedMediaFile[]` (`lib/deployment/reading/projectData/media.ts`) then gives part 10's
type, one per path of each file with `hqPath` as the source spells it, and `readingMediaIndex`
(14.2) gives the reader the asset id each slot holds on the creation's re-read.

### 4.2 Inside it, and after a failure

The birth writes no media row. `lib/db/appGenesis.ts::writePreparedGenesisInTransaction` already
admits every reference under sorted asset share locks (`admitExactMediaReferences`), checks the
format against the declared platforms (`lockAndValidateMediaReferences`, `platform-unplayable`) and
writes the `media_asset_refs` projection; this part changes none of it. Part 10's
`recordAdoptedDeploymentInTransaction` writes the path rows from `assignMediaPaths`.

A creation that fails after publication leaves ready files no app references. They show in the
Project's files to every member, under the names of 2.3; a retry finds each by hash and publishes
nothing twice; anyone with `edit` can delete one. Nova sweeps none: deleting a Project's file needs
fresh authority and the reference check of `lib/db/mediaDeletion.ts`, and a file another member
attached to their own app in the meantime is theirs. This is what a failed Project move leaves, for
the same reason (`lib/db/CLAUDE.md`, "Media byte copies are the only non-destructive pre-transaction
work").

### 4.3 The budget

`mediaBudgetFinding(plan, verdicts): Finding | null`: the manifest finding
`expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app` at
`{ kind: "app" }`, standing `not-yet`, owner `project-data-at-hq-size`, when:

- the plan holds more than `MAX_MEDIA_EXPORT_ASSETS` files: known from the source, so it is in
  `planHqMedia`'s findings and no file is fetched; `detail.name` is `"<n> media files (Nova takes
  500 in one app)"`;
- or, with every verdict in, `exportBudgetExcess` over the held files (as rows `{ status: "ready",
  kind, sizeBytes }`, one per distinct content hash) is not null: `detail.name` is its `reasons`
  joined with " and ".

The birth's own readiness check then never fails on media, which is the bar's clause (a): no finding
is discovered as a gate refusal.

### 4.4 Paths, and the logo

CommCare HQ's path for each file is kept for the project space the app came from, in
`app_deployment_media_paths`, by part 10's rule (its section 4.2): `assignMediaPaths` over this
part's `AdoptedMediaFile` list decides which path each asset keeps and which are re-derived. This
part adds nothing to that table and reads it nowhere. The logo's file goes through the same list, so
a `.ccz` for that project space names the logo at CommCare HQ's own slot path. Nova still writes no
`logo_refs` and still leaves the logo out of the bulk upload (`lib/domain/mediaRefs.ts::
carriesViaBulkUpload`), so CommCare HQ's logo entry is untouched by a publish.

---

## 5. Lookup tables: what comes in

New file `lib/deployment/reading/projectData/lookupTables.ts`, which is pure, and
`lookupTableStore.ts` beside it for the functions that read CommCare HQ and write Postgres
(`readHqLookupTablesForReading`, 5.1, and `writeBroughtInLookupTablesInTransaction` with
`BroughtInTableChangedError`, 7.4; section 14, "Pure files and store files").

### 5.1 Which tables the app reads

The reader is pure and binds a lookup read to a table and columns it is handed, so the tables must
be read before it runs, and which tables it needs is known only when it has run. One list read
breaks the circle:

1. `listHqLookupTables(creds, domain, deadline)`: every table's definition, one throttled read.
2. `candidateLookupTags(sourceText: string, tables: readonly HqLookupTable[]): readonly string[]`,
   in the list's order: the tags `T` of that list for which the source's text (the raw body and
   every form's attachment) holds the string `item-list:T`. This is a substring test of names
   CommCare HQ gave, and it reads no expression. It can only name too many: a form's
   instance of a table is declared `jr://fixture/item-list:<tag>` whatever id the form builder gave
   it, and a suite expression names `instance('item-list:<tag>')`. Part 06's `scanFormReads` (its
   section 17.4) reads the same declarations form by form for the reader's own use; every tag it
   returns that CommCare HQ's list holds is among these candidates, because the declaration it reads
   holds this string.
3. Rows are read for the candidates only, one table at a time (`readHqLookupTableRows`; part 05,
   section 3.2).
4. The reader runs with the catalog of the candidates Nova can hold (5.5, 14.1). Which of them the
   app reads is read off what the reader returns, by `lookupTagsRead(read: Extract<ReadOutcome, {
   kind: "read" }>, catalog: ReaderLookupCatalog): readonly string[]`: the tags of the table ids
   `lib/doc/lookupReferences.ts::extractLookupReferenceTargets` finds in the document, and each
   `tag` of `ReadFacts.unreadTables` (part 06's `UnreadTable`: a read of a table the catalog does
   not hold), each once, in code-unit order. Only those tables come in, and `lookupTableFindings`
   (5.3) is raised only for those tags. A candidate the reader never read brings nothing in and
   raises nothing here: where the source declares it and nothing reads it, the reader claims the
   manifest's INERT
   `expressions-and-data/declared-unreferenced-fixture-instance-item-list-locations-user` itself
   (B6); where the substring test named it only because its tag is the beginning of another's, the
   source never declared it and there is nothing to claim.
5. A tag in `ReadFacts.unreadTables` that CommCare HQ's list does not hold is a read of a table
   that is not there: a finding under part 08's entry M2,
   `expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant` (REFUSED,
   `fix-in-hq`), at `{ kind: "lookup-table", tag }`, `detail.name` the tag. Part 06 leaves a
   select's itemset over such a table to this part (its sections 10.1 and 17.4), and part 08
   raises the same entry itself for an expression (its section 9.2), so one table is one entry
   whichever slot read it.

```ts
export type HqLookupTableRead =
	| { readonly kind: "read"; readonly table: HqLookupTable;
	    readonly rows: readonly HqFixtureRow[]; readonly canonical: CanonicalLookupTable }
	| { readonly kind: "rows-unreadable"; readonly table: HqLookupTable };
export function readHqLookupTablesForReading(input: {
	readonly creds: CommCareCredentials; readonly domain: string; readonly sourceText: string;
	readonly within: HqReadDeadline;
}): Promise<{ readonly tables: readonly HqLookupTableRead[] } | CommCareApiError>;
```

`rows-unreadable` is a non-edge status of 500 or more on one table's rows where the list answered
(run G7, outcome A). Every other failure is returned, and `readReadingProjectData` (14.1) classifies
it with part 05's `classifyHqFailure(error, "lookup-tables")` or `"lookup-rows"`, by which read
failed, before part 12 sees it.

### 5.2 Columns and cells

- **Every column is `text`.** CommCare HQ holds strings (`FixtureResource.dehydrate_fields` serves
  `fields_without_attributes`, a dict of name to string). A typed column would re-spell a number at
  the next push (`lookupFixtureCellText`), turning `007` into `7`, and a refresh would fail the day
  a row held text in a column inferred as a number. Text is the one type under which a re-read of
  what Nova wrote equals what Nova holds.
- **A column's wire name is the field's name, and its label is the name's first 120 characters**
  (`columnLabelFor(name)`, `name.slice(0, LOOKUP_MAX_COLUMN_LABEL_LENGTH)`; a name is ASCII by part
  04's grammar, so a character is a code unit). `lookup_columns` holds a wire name to 255 characters
  and a label to 120 (`20260722053000_lookup_tables.ts`, the two CHECKs; `LOOKUP_MAX_WIRE_NAME_LENGTH`,
  `LOOKUP_MAX_COLUMN_LABEL_LENGTH`), so the whole name as a label would fail the label's CHECK inside
  the birth for a name of 121 to 255 characters. The wire name carries the whole name, which is what
  an expression and a push read; a label is what Project data shows, and two columns whose labels
  are equal are still two columns by wire name. No field name is refused for its length under 256.
- **A cell is the field's string, as it stands.** A field the row lacks is a missing cell. Nova's
  fixture writes an empty element for a missing cell and for an empty string alike
  (`lib/commcare/lookup/fixtures.ts`), which is what CommCare HQ's restore writes for a field a row
  lacks (`ItemListsProvider.to_xml`).
- **A cell of a field the definition does not name is not read.** The restore iterates the table's
  own fields, so no device receives it.
- **Rows keep CommCare HQ's order** (`FixtureResource` serves `sort_key` order).

### 5.3 What Nova cannot hold

`lookupTableFindings(read: HqLookupTableRead, measured: LookupRowsMeasure | null): readonly
Finding[]` is pure. `measured` is `measureLookupRows`'s answer for the table's rows (below). It is
null for a `rows-unreadable` read and for rows that hold other than one string a field, which are a
finding already and have no stored form to measure; the two byte caps are then not judged. It takes
no list of the fields the app reads: every row below is a fact of the table. Each finding is at
`{ kind: "lookup-table", tag }`:

| What | Detected by | Entry | `detail.name` |
|---|---|---|---|
| a field property | `unsupportedLookupContent` | `expressions-and-data/fields-properties-and-multi-valued-cells-name-lang-en-name-name` | `"<tag>: field properties"` |
| a field holding other than one value | `rowsHoldOtherThanOneValue` | the same | `"<tag>: a field with more than one value"` |
| a row attribute | `unsupportedLookupContent` | `expressions-and-data/item-attributes-and-per-row-attribute-values` | `"<tag>: row attributes"` |
| rows that go only to their owners | `unsupportedLookupContent` | `expressions-and-data/is-global-false-row-owners-user-group-location` | `"<tag>: rows limited to certain users"` |
| over a cap (below) | `lookupCapExcess` | `expressions-and-data/table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64` | `"<tag>: "` and the cap's own phrase, one finding per cap |
| the tag `types`, any case | the tag | `expressions-and-data/tag-types` | `"types"` |
| a tag holding `casedb` or `ledgerdb` | `reservedInstanceTagCause` | `expressions-and-data/tag-containing-casedb-or-ledgerdb` (REFUSED) | the tag |
| a tag or a field name outside part 04's grammar | `lookupTagSchema`, `lookupWireNameSchema` | part 04's section 11.2: N4 (a non-ASCII letter), N24 (a period), N5 (a tag equal to an instance name CommCare owns); any other failure is `unrecognized` | the name |
| two fields whose names are equal | the definition | `unrecognized` | the name |
| a cell holding a character XML 1.0 cannot carry | `lib/commcare/xmlText.ts::xmlTextIssue` over every cell of a field the definition names | the circumstance `table-cell-unrepresentable` (13.2), `fix-in-hq` | `"<tag> (the field <field name>)"`, one finding per field |
| rows CommCare HQ could not send | `rows-unreadable` | the circumstance `table-rows-unreadable` | the tag |

Two more findings are about the tables the document reads and are raised beside these, by
`readingProjectDataFindingsFor` (14.1), over `readingLookupSnapshot` (14.3): the tables together
over what one `.ccz` carries (`lookupFixtureBudgetFinding`, below: the caps entry at
`{ kind: "app" }`, `not-yet`), and a table whose rows cannot be a question's choices
(`table-choices-unusable`, 13.2, `fix-in-hq`).

Every row of the table is `not-yet`, owner `project-data-at-hq-size`, but three: the `casedb` tag
(REFUSED) and the two circumstances (`fix-in-hq`). A field name is judged whether or not the app
reads it: a column Nova cannot name cannot be stored, and a copy without it would be pushed short
to another project space.

**Why the character row is here.** Every export of an app runs `lookupXmlTextFindings` over every
table the app reads, in every mode, and refuses with `LOOKUP_CELL_TEXT_UNREPRESENTABLE`
(`lib/export/boundaryValidation.ts::prepareWithRegistry`), whose sentence sends the person to
"Remove those characters in Project data". The birth runs no such check, so a table holding such a
cell would come in clean and then refuse every `.ccz` and every publish of every app that reads it,
with a remedy Nova itself refuses for a managed table (6.3). Found at the reading, it is a fact of
the project space's data with a next step that works: take the character out in CommCare HQ. It is
a circumstance, not `unrecognized`, because it is no shape of the app's source (part 01, section
8.3). A cell with leading or trailing white space is different and comes in as it stands (8.2).

The same test is run in two places, and one table is never found twice. `lookupTableFindings` runs
it over CommCare HQ's cells; a table it finds has no binding (14.1, step 4) and is in no snapshot.
`readingProjectDataFindingsFor` runs it over every table of `readingLookupSnapshot` (14.3), which
holds a Project table the app is bound to as it stands with the Project's own cells, so such a
table is judged as CommCare HQ's own are and acceptance (part 09, section 4) never meets
`LOOKUP_CELL_TEXT_UNREPRESENTABLE`.

**What one `.ccz` carries.** `lib/commcare/lookup/fixtures.ts` holds every table an app reads,
together, to `MAX_LOOKUP_FIXTURE_ROWS` (10,000), `MAX_LOOKUP_FIXTURE_CELLS` (100,000) and
`MAX_LOOKUP_FIXTURE_BYTES` (16 MiB), and two tables of 5,000 rows each pass every cap of one table
and fail that. The birth's export readiness reads no rows, so the bar's clause (a) would be met and
the first `.ccz` refused. The reading judges it: `lookupFixtureBudgetFinding(snapshot:
LookupFixtureDataSnapshot): Finding | null` takes `readingLookupSnapshot(data, reads)` (14.3), builds
the fixtures of every table in it (`buildLookupFixtures` over the snapshot's own naming; a Project
table bound by section 7 is in it with the Project's rows) and, where `lookupFixtureBudgetExcess` is
not null, gives one finding at the app whose `detail.name` joins each axis's phrase with " and ":
`"<n> lookup table rows (Nova takes 10,000 in one app)"`, `"<n> lookup table values (Nova takes
100,000 in one app)"`, `"<size> of lookup table data (Nova takes 16 MB in one app)"`.

`tag-types` stays `not-yet` though a managed copy is never pushed to its own project space: every
other surface pushes or exports the copy (a second project space, the HQ app file, Manage in Nova),
and each would need its own refusal for one tag. Step 7's `project-data-at-hq-size` takes it with
the workbook that could carry it.

**The caps**, each a constant of `lib/lookup/constants.ts`. Four are also a CHECK
(`lookup_tables.row_count`, `column_count` and `data_bytes`; `lookup_rows.value_bytes`); the cell cap
is held by the writers' input parsing (`lib/lookup/coercion.ts`, `schema.ts`) and by no CHECK, so
the managed create and refresh arms hold it through `lookupCapExcess` before they write, and throw
`LookupError("storage_limit", ...)` where it answers a phrase. `lookupCapExcess` lives in
`lib/lookup` for that reason (`lib/lookup` may not import `lib/deployment`), in
`lib/lookup/managedRules.ts` (new, pure), beside `lib/lookup/managed.ts`, which reaches Postgres:
`lookupTableFindings` runs in the reading's check worker, whose bundle holds no store (section 14,
"Pure files and store files"). `lookupTableFindings`, the two arms and the re-read (8.1) import it:

```ts
/** `lib/lookup/managedRules.ts`. What Postgres measured of a table's candidate rows. */
export interface LookupRowsMeasure {
	readonly dataBytes: number; readonly largestRowBytes: number;
}
/**
 * Each cap of the table below that the content is over, as that cap's phrase without the tag
 * and its colon, in the table's order; empty where it is within all five. Pure.
 */
export function lookupCapExcess(
	content: ManagedLookupContent, measured: LookupRowsMeasure,
): readonly string[];
```

A finding's `detail.name` is the tag, a colon, a space and the phrase; `ManagedTableChange`'s
`over-cap` (8.1) and Copy T7 and P10 carry the phrase alone, joined with " and " where there are
several.

| Cap | Limit | The phrase in `detail.name` |
|---|---|---|
| `LOOKUP_MAX_ROWS` | 5,000 | `"<tag>: <n> rows (Nova takes 5,000)"` |
| `LOOKUP_MAX_COLUMNS` | 250 | `"<tag>: <n> columns (Nova takes 250)"` |
| `LOOKUP_MAX_CELL_BYTES` | 64 KiB of UTF-8 in one cell | `"<tag>: a value of <size> (Nova takes 64 KB in one cell)"` |
| `LOOKUP_MAX_ROW_BYTES` | 256 KiB a stored row | `"<tag>: a row of <size> (Nova takes 256 KB in one row)"` |
| `LOOKUP_MAX_TABLE_BYTES` | 8 MiB of stored rows | `"<tag>: <size> of rows (Nova takes 8 MB in one table)"` |

Rows, columns and cells are counted in TypeScript. Row and table bytes are Postgres's measure of the
stored value and are never guessed in JavaScript (`lib/lookup/CLAUDE.md`), so `lib/lookup/managed.ts`
exports a read-only measure the reading step calls with the values keyed by the predeclared column
ids:

```ts
/** The largest candidate row's stored size and the rows' sum, measured by Postgres, writing nothing. */
export function measureLookupRows(rows: readonly LookupRowValues[]): Promise<LookupRowsMeasure>;
// SELECT coalesce(max(octet_length(v::jsonb::text)), 0) AS largest_row_bytes,
//        coalesce(sum(octet_length(v::jsonb::text)), 0) AS data_bytes
// FROM unnest($1::text[]) AS t(v)
```

It returns the two numbers the two caps need and not `lib/lookup/types.ts::LookupStorageMeasurement`,
whose `rowValueBytes` is every row's size: no caller here reads a row's size but the largest.
`octet_length(v::jsonb::text)` is the expression of the generated column `lookup_rows.value_bytes`.

### 5.4 What no API returns

A table's description, a field's indexed flag and row owners are served by no API-key read (part 05,
section 10.3). A managed table is never pushed to its own project space, so none of the three is
touched there. They matter in two places, each said where it happens: "Manage in Nova" says a publish
will clear the first two (`LOOKUP_DISCARD_NOTE`, Copy T9), and a publish to another project space
creates the table there with neither (the plain truth of a new table; nothing is erased). Row owners
on a global table have no effect (`lookupResourcePlan.ts`'s header), and a table that is not global
is `not-yet`.

### 5.5 Ids

`lib/lookup/managed.ts` exports `mintLookupIds(count: number): Promise<readonly string[]>`, the
statement of `authoringBatch.ts::mintIds` over the pool. It lives there and nowhere else. Not done:
a copy in `lib/deployment/reading/store.ts`, because `lib/lookup` is the one place a lookup id is
minted; part 12 passes this one (or a test's own) as `readReadingProjectData`'s `mintIds`. On the
reading's first read,
`readReadingProjectData` (14.1) mints one table id per candidate table and one column id per field,
and answers them with the tag and field name each belongs to:

```ts
/** `lib/deployment/reading/projectData/lookupTables.ts`. What the reading's `minted` column holds. */
export const predeclaredLookupIdsSchema = z.record(lookupTagSchema, z.strictObject({
	tableId: lookupTableIdSchema,
	columns: z.record(lookupWireNameSchema, lookupColumnIdSchema),
}));
export type PredeclaredLookupIds = z.infer<typeof predeclaredLookupIdsSchema>;
```

Part 12 stores that value on the reading's row and hands it back on every later call, so every step
of one reading, and a creation retried after a lost answer, hands the reader the same ids. An id,
once minted for a tag or a field name, is never replaced; a field or a table that appears on a later
read of the same reading gets ids minted then and added. Ids are minted for every candidate, whether
or not the Project holds a table of its tag: a tag that meets a Project table is bound to that
table's id, and a field that table has no column for takes its predeclared column id (7.4). Row ids
are not predeclared: no expression, select source or edge names a
row, so a row takes the column's default `uuidv7()` at insert.

Section 7 decides what each tag is bound to, as a `LookupTableBinding`:

```ts
export interface LookupTableBinding {
	readonly tag: string;
	readonly tableId: LookupTableId;
	/** Field name to the column that holds it. */
	readonly columns: Readonly<Record<string, LookupColumnId>>;
}
```

The reader takes the bindings as part 06's `ReaderLookupCatalog` (its `table(tag)` with
`column(fieldName)`, and `definitions`, the `lib/domain/expression/context.ts::LookupDefinitionIndex`
that part 08's `ExpressionReadEnv.lookup` and the checker read). One function builds it:

```ts
/** The catalog the reader binds against: one entry per binding, and nothing else. */
export function readerLookupCatalog(
	bound: readonly { readonly binding: LookupTableBinding; readonly name: string;
		/** CommCare HQ's field names in its order. */
		readonly fields: readonly string[] }[],
): ReaderLookupCatalog;
```

`definitions` maps each `binding.tableId` to `{ id, name, tag, columns }`, a column per field in
CommCare HQ's order with `id` from `binding.columns`, `wireName` the field's name, `label`
`columnLabelFor(name)` and `dataType: "text"`. For a tag bound to a Project table as it stands
(`same-equal`, or the answer `use-project`) the columns are that table's own, with their own types,
because that is the table the app will read. A candidate this part cannot bring in (5.3) has no
binding and is absent from the catalog, so the reader lists it in `ReadFacts.unreadTables` and makes
no finding of its own for it.

---

## 6. The managed fact on the Project table

### 6.1 DDL

One ledgered migration, `lib/case-store/migrations/20261202000000_hq_bring_in_project_data.ts`,
registered in `migrations/index.ts` after part 10's `20261201000000_hq_bring_in_ledger` (B8). If
`main` holds a later-stamped migration when this pull request is rebased, the stamp moves to the
next free hour after `main`'s newest, and every later stamp of the stack keeps its order; nothing
else changes. It is additive: every new column is nullable with no default, so the revision that
still serves writes rows that pass every new CHECK. Each of the three CHECKs reads only the columns
this migration adds, and that revision names none of them in any insert or update, so an insert of
its leaves them null and an update of its leaves them as they were: no statement it runs on these
three tables can turn a row the CHECKs admit into one they refuse. Each `ADD CONSTRAINT` follows a
`DROP CONSTRAINT IF EXISTS` of the same name, so every statement replays over its own result.

```sql
ALTER TABLE lookup_tables
	ADD COLUMN IF NOT EXISTS hq_server text,
	ADD COLUMN IF NOT EXISTS hq_domain text,
	ADD COLUMN IF NOT EXISTS hq_remote_id text,
	ADD COLUMN IF NOT EXISTS hq_canonical jsonb,
	ADD COLUMN IF NOT EXISTS hq_brought_in_at timestamptz(3),
	ADD COLUMN IF NOT EXISTS hq_brought_in_by text,
	ADD COLUMN IF NOT EXISTS hq_refreshed_at timestamptz(3),
	ADD COLUMN IF NOT EXISTS hq_refreshed_by text,
	ADD COLUMN IF NOT EXISTS hq_taken_over_at timestamptz(3),
	ADD COLUMN IF NOT EXISTS hq_taken_over_by text;

ALTER TABLE lookup_tables DROP CONSTRAINT IF EXISTS lookup_tables_hq_origin_whole;
ALTER TABLE lookup_tables ADD CONSTRAINT lookup_tables_hq_origin_whole CHECK (
	(hq_server IS NULL AND hq_domain IS NULL AND hq_remote_id IS NULL AND hq_canonical IS NULL
		AND hq_brought_in_at IS NULL AND hq_brought_in_by IS NULL
		AND hq_refreshed_at IS NULL AND hq_refreshed_by IS NULL)
	OR (hq_server IN ('production', 'india', 'eu')
		AND btrim(hq_domain) <> '' AND char_length(hq_domain) <= 255
		AND btrim(hq_remote_id) <> ''
		AND jsonb_typeof(hq_canonical) = 'object'
		AND hq_canonical ->> 'digest' ~ '^[0-9a-f]{64}$'
		AND hq_brought_in_at IS NOT NULL AND btrim(hq_brought_in_by) <> ''
		AND hq_refreshed_at IS NOT NULL AND btrim(hq_refreshed_by) <> '')
);
ALTER TABLE lookup_tables DROP CONSTRAINT IF EXISTS lookup_tables_hq_takeover_attributed;
ALTER TABLE lookup_tables ADD CONSTRAINT lookup_tables_hq_takeover_attributed CHECK (
	(hq_taken_over_at IS NULL) = (hq_taken_over_by IS NULL)
	AND (hq_taken_over_at IS NULL OR hq_server IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS lookup_tables_hq_origin
	ON lookup_tables (project_id, hq_server, hq_domain) WHERE hq_server IS NOT NULL;

ALTER TABLE app_organization_state
	ADD COLUMN IF NOT EXISTS hq_server text,
	ADD COLUMN IF NOT EXISTS hq_domain text,
	ADD COLUMN IF NOT EXISTS hq_places_digest text,
	ADD COLUMN IF NOT EXISTS hq_left_out jsonb,
	ADD COLUMN IF NOT EXISTS hq_brought_in_at timestamptz(3),
	ADD COLUMN IF NOT EXISTS hq_brought_in_by text,
	ADD COLUMN IF NOT EXISTS hq_refreshed_at timestamptz(3),
	ADD COLUMN IF NOT EXISTS hq_refreshed_by text;
ALTER TABLE app_organization_state
	DROP CONSTRAINT IF EXISTS app_organization_state_hq_origin_whole;
ALTER TABLE app_organization_state ADD CONSTRAINT app_organization_state_hq_origin_whole CHECK (
	(hq_server IS NULL AND hq_domain IS NULL AND hq_places_digest IS NULL AND hq_left_out IS NULL
		AND hq_brought_in_at IS NULL AND hq_brought_in_by IS NULL
		AND hq_refreshed_at IS NULL AND hq_refreshed_by IS NULL)
	OR (hq_server IN ('production', 'india', 'eu')
		AND btrim(hq_domain) <> '' AND char_length(hq_domain) <= 255
		AND hq_places_digest ~ '^[0-9a-f]{64}$'
		AND jsonb_typeof(hq_left_out) = 'object'
		AND hq_brought_in_at IS NOT NULL AND btrim(hq_brought_in_by) <> ''
		AND hq_refreshed_at IS NOT NULL AND btrim(hq_refreshed_by) <> '')
);

ALTER TABLE app_locations ADD COLUMN IF NOT EXISTS hq_location_id text
	CHECK (hq_location_id IS NULL OR btrim(hq_location_id) <> '');
```

The three server names are the ledger's (`20261015020000_hq_round_trip_deployment_ledger.ts`,
`SERVERS`). `down` drops the index, the three constraints and the nineteen columns. `ADD CONSTRAINT`
validates over rows whose new columns are all null, one pass over two small tables, under
`lock_timeout = '5s'` set and reset as part 10's migration does.

Each App Test namespace clones `lookup_tables` and `app_locations` `LIKE ... INCLUDING CONSTRAINTS`
(`20261004000000_app_test_lookup_definitions.ts`). A namespace made after the migration has the new
columns and one made before it does not; `lib/preview/app-tests/seed.ts` inserts named columns and
never these, so both work. No registry entry moves: `lookup_tables`, `app_organization_state` and
`app_locations` are already in `privilegeConvergence.ts::RUNTIME_READ_WRITE_TABLES`.

`lib/db/pg.ts`: `LookupTablesTable` gains the ten columns (`hq_canonical: JSONColumnType<...> |
null`, the timestamps `Timestamp | null`), `AppOrganizationStateTable` the eight, `AppLocationsTable`
`hq_location_id: string | null`.

Three states of a table follow from the columns, and nothing else stores one:

| State | Columns | Meaning |
|---|---|---|
| plain | all null | a table made in Nova |
| managed in CommCare HQ | `hq_server` set, `hq_taken_over_at` null | Nova holds a copy and refuses every edit |
| managed in Nova, from CommCare HQ | `hq_taken_over_at` set | a person chose Manage in Nova; the origin stays so the table can be handed back |

### 6.2 Types

`lib/lookup/types.ts`:

```ts
/** Where a table came from in CommCare HQ, and who manages it now. */
export interface LookupHqOrigin {
	/** One of CommCare HQ's servers, by the name the deployment ledger uses. */
	readonly server: string;
	readonly domain: string;
	readonly remoteId: string;
	readonly managedBy: "commcare-hq" | "nova";
	readonly broughtInAt: string;
	readonly refreshedAt: string;
	readonly takenOverAt: string | null;
	readonly takenOverBy: string | null;
	/** Columns CommCare HQ's table no longer has, kept because an app still reads them. */
	readonly goneColumnIds: readonly LookupColumnId[];
}
```

`LookupTableSnapshot`, `LookupTableDefinition` and `LookupTableManifestEntry` each gain
`hq?: LookupHqOrigin`, present exactly when `hq_server` is not null; the manifest entry's carries
`goneColumnIds: []` always (the manifest holds no columns) and the other two compute it.
`lib/lookup` types the server as `string` because it may not import `lib/commcare`
(`lib/lookup/CLAUDE.md`, "Boundaries"); the CHECK holds the set and `lib/deployment` narrows it.

`hq_canonical` is `lib/deployment/hqResourceBaseline.ts::canonicalLookupTable`'s value for the last
refresh. `lib/lookup` reads two of its keys through its own schema and passes the rest through:

```ts
/** `lib/lookup/managedRules.ts`. What lib/lookup reads of the stored state. */
export const managedCanonicalSchema = z.looseObject({
	digest: z.string().regex(/^[0-9a-f]{64}$/),
	fields: z.array(z.looseObject({ name: z.string() })),
});
```

`goneColumnIds` is every column whose wire name is in no `fields[].name`.

`lib/collab/lookupManifestFrame.ts::lookupTableManifestEntrySchema` gains the optional key:

```ts
	hq: z.strictObject({
		server: z.string().min(1),
		domain: z.string().min(1),
		remoteId: z.string().min(1),
		managedBy: z.enum(["commcare-hq", "nova"]),
		broughtInAt: z.iso.datetime(),
		refreshedAt: z.iso.datetime(),
		takenOverAt: z.iso.datetime().nullable(),
		takenOverBy: z.string().min(1).nullable(),
		goneColumnIds: z.array(lookupColumnIdSchema).max(0),
	}).optional(),
```

Each time is the column's value as `Date.prototype.toISOString` spells it. `goneColumnIds` is held
empty in a frame, as the manifest entry carries it. The relay omits the key for a plain table, so a
tab still on the previous bundle parses every frame of a Project that holds no brought-in table. In
a Project that holds one, such a tab fails the frame, clears its manifest and refetches, as the
contract has it do for any malformed frame, and the refetch reloads it onto the new bundle (the
deployment id guard, root `CLAUDE.md`, "Deploy").

### 6.3 The refusal arm, for every writer

`lib/lookup/writerTransaction.ts`:

```ts
export type LookupWritePurpose =
	/** A person, the SA or an MCP client changing a table. Refused while CommCare HQ manages it. */
	| "author"
	/** Removing Nova's copy of a table. Allowed in every state: it changes nothing in CommCare HQ. */
	| "remove-table"
	/** Bringing CommCare HQ's content into the copy (6.4). */
	| "hq-refresh"
	/** Changing who manages the table (9). */
	| "hq-management";

export async function lockLookupTableForUpdate(
	tx: Transaction<AppDatabase>, projectId: string, tableId: LookupTableId,
	expectedRevision: LookupRevision | null, purpose: LookupWritePurpose,
): Promise<StoredLookupTable>;
```

The parameter is required, so no writer compiles without stating one. In order: the row `FOR
UPDATE`, or `not_found`; then, for `author` on a row with `hq_server` set and `hq_taken_over_at`
null, `LookupError("managed_in_hq", managedLookupTableRefusal(table.name, table.hq_domain))` (Copy
T8); then the revision compare, skipped where `expectedRevision` is null, which only `hq-refresh`
and `hq-management` pass (a refresh is not an edit of what a person loaded, and it holds the lock
that makes its read current). The managed check comes before the revision compare, so a stale tab
learns the table is managed and is not sent to reload first.

`managedLookupTableRefusal` is a function of `lib/publish/managedData.ts` (Copy), which imports
nothing at run time. `lib/lookup/writerTransaction.ts` may import it, and
`lib/organization/commitIntegrity.ts` and `writerTransaction.ts` may import that file's two
organization sentences (11.4): neither package's "Boundaries" names `lib/publish`, and `biome.json`
restricts the consumers of `lib/commcare` and of two private stores only.

`LookupActionErrorCode` gains `"managed_in_hq"`. `lookupFailure` already carries code and message.

| Writer path | Reaches the lock through | Purpose | What the caller sees |
|---|---|---|---|
| the builder's Project data (`lib/lookup/actions.ts`: rename, tag, add or move or relabel a column, wire name, create or update or delete or move a row) | `service.ts`'s `lockTable` at each of its ten call sites | `author` | the action's failure result with the code and Copy T8; the page shows it and re-reads the manifest |
| the builder's destructive actions (`deleteLookupTableAction`, `removeLookupColumnAction`, `retypeLookupColumnAction`) | `schemaGovernance.ts` | `remove-table` for a table delete, `author` for the two column operations | the same; a delete is still held to the reference blockers |
| CSV replacement (`app/api/projects/[projectId]/lookup/tables/[tableId]/import/route.ts`) | `service.ts::replaceLookupRows` | `author` | the route's failure body with the code and Copy T8, status 409 as for `conflict` |
| the SA's and MCP's `updateLookupTable`, `editLookupColumns`, `editLookupRows`, `replaceLookupRows`, `removeLookupTable` (`lib/agent/tools/lookupTables.ts`) | `authoringBatch.ts::loadWork` | `remove-table` where `input.delete === true`, else `author` | the tool's error result with Copy T8, which names the two ways forward |
| accepted-design materialization | the same batch | `author` | the batch fails as for any refused table; a design cannot edit a table it did not make |
| `createLookupTable` on any surface | no table lock; the tag check | n/a | `tag_taken`, as today, where the tag is a managed table's |

Every switch that is exhaustive over `LookupActionErrorCode` gains the arm; TypeScript names them.
The builder does not rely on the refusal: the table page offers no editing control for a managed
table (12.1). The refusal is what holds a second tab, the SA and an MCP client.

Case submissions lock a table `FOR SHARE` and read it; they are not writers and are unchanged.

### 6.4 The create arm and the refresh arm

`lib/lookup/managed.ts` (new, server-only). It imports `writerTransaction.ts` and shares
`authoringBatch.ts`'s private `createTable` and `insertRows`, which that file exports for it;
`createTable` takes its ids as an argument (`mintIds` stays the public batch's source).

```ts
export interface ManagedOriginWrite {
	readonly server: string; readonly domain: string; readonly remoteId: string;
	/** `canonicalLookupTable(table, rows)`. */
	readonly canonical: Readonly<Record<string, unknown>>;
}
export interface ManagedLookupContent {
	/** CommCare HQ's field names in its order; each passes `lookupWireNameSchema`. */
	readonly fields: readonly string[];
	/** Rows in CommCare HQ's order: field name to the cell's string. */
	readonly rows: readonly Readonly<Record<string, string>>[];
}

/** Create tables that CommCare HQ manages, with the ids the reading minted. One revision, one notice. */
export function createManagedLookupTablesInTransaction(
	tx: Transaction<AppDatabase>, scope: LookupScope,
	tables: readonly { readonly binding: LookupTableBinding; readonly name: string;
		readonly content: ManagedLookupContent; readonly origin: ManagedOriginWrite }[],
	at: Date,
): Promise<LookupAuthoringBatchReceipt>;

export interface ManagedRefreshReceipt extends LookupTableRevisions {
	readonly changed: "nothing" | "rows" | "definition";
	readonly addedColumns: readonly { readonly id: LookupColumnId; readonly wireName: string }[];
	readonly removedColumns: readonly string[];
	/** Columns CommCare HQ no longer has that stay because an app reads them. */
	readonly keptGoneColumns: readonly { readonly id: LookupColumnId; readonly wireName: string;
		readonly apps: readonly LookupReferencingAppSummary[] }[];
}
/** Make the copy hold CommCare HQ's columns and rows. */
export function refreshManagedLookupTableInTransaction(
	tx: Transaction<AppDatabase>, scope: LookupScope,
	input: { readonly tableId: LookupTableId; readonly content: ManagedLookupContent;
		readonly origin: ManagedOriginWrite; readonly at: Date;
		/** `refresh`: the table is managed in CommCare HQ already. `adopt`: it becomes so (7, 9). */
		readonly mode: "refresh" | "adopt";
		/** Column ids for fields the table has no column for; minted where absent. */
		readonly newColumnIds?: Readonly<Record<string, LookupColumnId>> },
): Promise<ManagedRefreshReceipt>;
```

`createManagedLookupTablesInTransaction`: `lockLookupProjectState`; the tag check of
`applyLookupAuthoringBatchInTransaction` (a taken tag is `tag_taken`: a table of that tag appeared
after the review, which the birth answers as 7.4 says); `createTable` per table with the binding's
ids, every column `text` with its label `columnLabelFor(wireName)` (5.2), the table's name `name`
(the tag, see 7.3), then the eight origin columns in the same statement as the insert; one
`advanceLookupProjectRevision`; one notice. The scope needs `edit`.

`refreshManagedLookupTableInTransaction`, in order:

1. `lockLookupProjectState`, then `lockLookupTableForUpdate(..., null, mode === "refresh" ?
   "hq-refresh" : "hq-management")`. In `refresh` mode a table that is not managed in CommCare HQ
   from `origin.server` and `origin.domain` throws `LookupError("conflict", ...)`: someone chose
   Manage in Nova in the meantime, and the caller reports that the table is now Nova's.
2. In `refresh` mode, where the stored `hq_canonical.digest` equals `origin.canonical.digest` and
   `hq_remote_id` equals `origin.remoteId`: write `hq_refreshed_at` and `hq_refreshed_by`, advance
   nothing, notify nothing, return `changed: "nothing"`. A refresh that changed no value must not
   invalidate every open Preview of the Project (`lib/lookup/CLAUDE.md`: a semantic no-op advances
   no revision). The day in Copy T3 then moves for the page that pressed Refresh, from the outcome's
   `table.hq.refreshedAt` (section 9); another open page shows the earlier day until its next read
   of the manifest, and nothing it offers depends on that day.
3. Columns, matched by wire name. A field with no column: a `text` column added, with the id
   `newColumnIds` gives or one minted, its label `columnLabelFor(name)`. A column with no field:
   removed when no `lookup_column_references` edge and no `design_lookup_protections` edge names
   it; kept otherwise, and listed in `keptGoneColumns` with the apps `lib/lookup` already names
   for a blocked removal. Column order becomes CommCare HQ's, kept columns last.

   **Types.** In `refresh` mode every column is `text` already: the create arm made them so and no
   author may retype a managed table (6.3). In `adopt` mode the Project's table may hold `int`,
   `decimal`, `date`, `time` and `datetime` columns (a table equal in every other way is still a
   `choice` for that reason, 7.1), and CommCare HQ's cells are strings, which a typed column does
   not take (`lib/lookup/CLAUDE.md`, "Values, ordering, and limits": an integer is a canonical
   int4, a decimal a JSON number) and which `lookupFixtureCellText` throws on at the next export
   ("a 'decimal' cell holds a non-numeric stored value"). So in `adopt` mode **every** column of
   the table that is not `text`, matched or kept, has its `data_type` set to `text` before step 4,
   and each is a definition change. No stored value is coerced or rewritten: step 4 deletes every
   row and inserts CommCare HQ's strings, and a kept column holds no cells. This is the projection
   change `lib/lookup/CLAUDE.md` allows while a column is referenced ("Projection changes remain
   allowed while referenced and do not rewrite edges"); it is written by this arm directly, under
   the same locks, and not through `schemaGovernance.ts::retypeColumn`, whose work is to prove
   stored cells against the new type and here there are none to prove. What the other apps see: a
   comparison of that column now compares text, said in the choice (Copy R8) and in the hand-back
   (Copy T11).
4. Rows: every row deleted, CommCare HQ's inserted with `balancedKeysBetween` order keys and default
   row ids, as `replaceLookupRows` does; a kept column has no cells. `data_bytes` over
   `LOOKUP_MAX_TABLE_BYTES` or a row over the row CHECK throws `storage_limit`: the caller has
   already judged the caps (8.1), so this is the floor.
5. Counters; `definition_revision` where a column was added, removed, retyped or reordered, and
   always in `adopt` mode (who manages a table is part of its definition as every client reads it,
   section 9); `rows_revision` where a row changed; the eight origin columns, and in `adopt` mode
   `hq_taken_over_at` and `hq_taken_over_by` set to null and `hq_brought_in_at` and
   `hq_brought_in_by` set where they were null; one revision advance; one notice.

Realtime needs nothing new: the advance and `notifyCommittedLookupMutation` are the ones every writer
uses, so every open builder of the Project gets the manifest frame, now with `hq`, and its Preview
cache drops the table's rows.

---

## 7. A tag that meets a Project table

`UNIQUE (project_id, tag)` means one table a tag. The decision is pure:

```ts
export const LOOKUP_TABLE_CHOICES = ["use-commcare-hq", "use-project"] as const;
export type LookupTableChoice = (typeof LOOKUP_TABLE_CHOICES)[number];

export type LookupTableStanding =
	/** No Project table has the tag: a new table, managed in CommCare HQ. */
	| { readonly kind: "new" }
	/** The Project's table is already managed from this project space: the same table. */
	| { readonly kind: "same-managed"; readonly table: LookupTableDefinition }
	/** The Project's table has equal columns and rows, Nova manages it, and one of the Project's
	 *  apps already publishes it as this very table of this project space: the same table. */
	| { readonly kind: "same-equal"; readonly table: LookupTableDefinition }
	/** A table the person chooses about: a different one, or an equal one nothing accounts for. */
	| { readonly kind: "choice"; readonly table: LookupTableDefinition;
	    /** Empty exactly when the two are equal. */
	    readonly differs: readonly ("columns" | "rows")[];
	    /** Who manages the Project's table today. */
	    readonly managed: { readonly by: "nova" }
		| { readonly by: "commcare-hq"; readonly domain: string };
	    readonly apps: readonly LookupReferencingAppSummary[];
	    readonly options: Readonly<Record<LookupTableChoice, LookupChoiceOffer>> };
export type LookupChoiceOffer =
	| { readonly offered: true;
	    /** `use-commcare-hq` only: columns the apps read that CommCare HQ's table lacks. */
	    readonly goneColumns: readonly string[];
	    /** `use-commcare-hq` only: the Project table's columns that are not text and become it
	     *  (6.4, step 3), by label. */
	    readonly retypedColumns: readonly string[] }
	| { readonly offered: false;
	    readonly why: "needs-admin" | "managed-elsewhere" | "app-reads-a-missing-column"
			| "fails-a-project-space-rule";
	    /** `managed-elsewhere`: the other project space. `app-reads-a-missing-column`: the first
	     *  such field, in CommCare HQ's order. Null for the other two. */
	    readonly name: string | null };

export function lookupTableStanding(input: {
	readonly read: Extract<HqLookupTableRead, { kind: "read" }>;
	readonly origin: { readonly server: string; readonly domain: string };
	/** The Project's table of that tag with its rows, or null. One snapshot read. */
	readonly existing: { readonly table: LookupTableDefinition;
		readonly rows: readonly LookupFixtureRow[] } | null;
	readonly apps: readonly LookupReferencingAppSummary[];
	/**
	 * Live mappings of the Project's apps for the Project's table on this project space:
	 * `readSiblingLookupMappings` (10.1) with the reading's id as the app, which matches no
	 * deployment, so every app of the Project is a sibling. Empty where there is no table.
	 */
	readonly siblings: readonly SiblingLookupMapping[];
	/** The field names the reader bound for this tag. */
	readonly appReads: readonly string[];
	readonly mayAdminister: boolean; // the Project's `delete` capability
}): LookupTableStanding;
```

`LOOKUP_TABLE_CHOICES`, `LookupTableChoice` and `LookupChoiceOffer` are declared in
`lib/deployment/reading/projectData/reviewTypes.ts` (14.1), a module whose only run-time import is
`zod`, because part 12's client-safe `types.ts` and part 13's review read them; `lookupTables.ts`
imports them from it and declares the rest.

### 7.1 The table

**Equal** means: the same field names in the same order as the table's columns' wire names, every
column `text`, and the same rows in the same order, cell for cell, a missing cell equal to an empty
one. **Accounted for** means: some `siblings` entry has `pushedIdentity` equal to the tag and
`remoteId` equal to the read table's id, so one of the Project's apps holds a live mapping for the
very table CommCare HQ has under the tag. **Passes the project space's rules** means a workbook to
the reading's project space would take the Project's table as it stands, by the three rules the
export boundary holds such a workbook to (`lib/export/boundaryValidation.ts::prepareWithRegistry`):
its tag is not `types` in any case (`LOOKUP_TAG_RESERVED_BY_HQ`, `lib/commcare/lookup/workbook.ts::
TYPES_SHEET`; a tag CommCare HQ holds under that name is already 5.3's `tag-types`);
`lib/commcare/lookup/hqCellText.ts::lookupHqCellTextFindings` over a snapshot of this one table is
empty (`LOOKUP_CELL_TEXT_CHANGED_BY_HQ`: no cell begins or ends with white space CommCare HQ's
upload would trim); and a workbook of this one table, counted as `lib/commcare/lookup/workbook.ts`
counts `totalWorkbookRows`, is within `MAX_HQ_FIXTURE_WORKBOOK_ROWS` (`LOOKUP_HQ_PUSH_TOO_LARGE`;
500,000, which the tables of one app, held to 10,000 rows together by 5.3, never reach).
`lookupTableStanding` judges all three from `existing`.

| The Project's table of that tag | Result | What creation writes |
|---|---|---|
| none | `new` | `createManagedLookupTablesInTransaction` with the predeclared ids |
| managed in CommCare HQ from this server and project space | `same-managed`: bound to its id, and to its columns by name with predeclared ids for fields it lacks | `refreshManagedLookupTableInTransaction`, mode `refresh`, with those ids |
| plain, or managed in Nova, and equal, and accounted for, and it passes the project space's rules | `same-equal`: bound to it as it is | nothing; the table stays as it was |
| any other: not equal; or equal and not accounted for; or equal and accounted for and failing one of the project space's rules; or managed in CommCare HQ from another project space, equal or not | `choice`, `differs` empty where equal | by the answer, 7.2 |

`same-equal` asks nothing because nothing the person could answer would differ, now or at the first
publish: the app reads the same data, and that publish sends the table under 10.2's arm 2, with the
standing and the shared baseline the sibling's push wrote. The review says which table the app will
use and that the Project's other apps already publish it there (Copy R2).

Equality alone is not enough, for three cases read at source:

- **Equal, and no app of the Project accounts for the table in that project space.** The first
  publish puts the table in the workbook (Nova manages it), meets CommCare HQ's table under the tag
  with no mapping, and stops to ask whether to replace a table Nova didn't make
  (`lookupResourcePlan.ts::planLookupResourcePush`, the arm "Something of that name is there and
  Nova cannot account for it"). That is a question about the table the app came with, asked late.
  This plan asks no confirmation that the source project space already answers (`../6-bring-in.md`,
  "The experience in brief"), so it is asked once, in the review, where both answers are worded:
  `use-commcare-hq` leaves the table to CommCare HQ, and `use-project` says the publish will ask
  before it replaces the table and what that clears (`LOOKUP_ADOPTION_NOTE`).
- **Equal, and managed in CommCare HQ from another project space.** The copy follows that other
  space: every refresh takes its rows, and a publish to this app's own space would push that
  space's copy over the table the app came with (8.2). "One copy cannot follow two" is why 7.2
  refuses `use-commcare-hq` for such a table, and equal content today does not change it. The person
  is told so (R7, R10), and `use-project` is theirs to choose with that said.
- **Equal, accounted for, and failing one of the project space's rules.** Nova manages the table,
  so the first publish puts it in the workbook, and the export boundary refuses that publish for
  the table's own content. Bound as it stands, the app would be born unable to publish, and
  acceptance's check 2 would read that refusal as Nova's mistake (part 09, section 4). So the tag
  is a `choice` whose `use-project` answer is not offered (7.2), with the reason said (R10).

### 7.2 The two answers

| | **Use CommCare HQ's table** (`use-commcare-hq`) | **Use {Project}'s table** (`use-project`) |
|---|---|---|
| The binding | the Project table's id; its columns by name; predeclared ids for fields it lacks | the Project table as it is |
| What creation writes | `refreshManagedLookupTableInTransaction`, mode `adopt`: the table takes CommCare HQ's columns and rows and becomes managed in CommCare HQ from this project space | nothing |
| The other apps that read it | read CommCare HQ's rows from then on. A column one of them reads that CommCare HQ's table lacks stays, with no values (`goneColumns`, named in the choice). Every column becomes text (6.4, step 3), so a column that was a number or a date is compared as text from then on. Nova keeps the table read-only until someone chooses Manage in Nova | unchanged |
| This app | Preview shows CommCare HQ's rows | Preview shows the Project's rows |
| The table in the project space | never written | stays as it is until a publish. That publish finds the tag there with no mapping Nova can account for and asks before replacing it, with `LOOKUP_ADOPTION_NOTE`, as it does today |
| Not offered when, first match | the Project's table is managed in CommCare HQ from another project space (`managed-elsewhere`, `name` that project space): one copy cannot follow two; or the person lacks the Project's `delete` capability (`needs-admin`): turning a table every app shares into a read-only copy is an identity change, the capability `lib/lookup` already asks for a tag or a destructive schema change | the app reads a field the Project's table has no column for (`app-reads-a-missing-column`, `name` the first such field); or the Project's table fails one of the project space's rules of 7.1 (`fails-a-project-space-rule`, `name` null), whether or not it is equal |

`managed-elsewhere` is tested first because Copy R7 chooses its form from that reason (14.1), and
it is true whoever asks.

A `choice` ends no read: the review holds the question open, and only a reading that is ready has a
review (part 12). Creation does not start until every `choice` has an offered answer:
`resolveTableChoices` (14.1) says which tags lack one, and part 12 answers that creation `held`
under part 01's `table-differs-in-project` for a tag with no answer, and refuses an answer whose
offer is `offered: false`, or one for a tag with no choice, as `choice_not_offered` (part 12, 5.3).
Where neither answer is offered, the review says so and the way forward is the one the review
always states beside the question: add the app to another Project (the flow's first step). MCP's
`bring_in_hq_app` takes `table_choices: Record<tag, LookupTableChoice>` (part 13, section 14.4, B12)
and answers the same way.

### 7.3 The names

A new managed table's `name` is its tag. CommCare HQ's table has no other name an API returns, and a
name Nova invented would be a second word for one thing.

### 7.4 What the reader is handed, and when

```ts
/** One binding per read, in the reads' order. `standings` is by tag. Pure. */
export function resolveLookupBindings(
	reads: readonly Extract<HqLookupTableRead, { kind: "read" }>[],
	standings: Readonly<Record<string, LookupTableStanding>>,
	choices: Readonly<Record<string, LookupTableChoice>> | null,
	predeclared: PredeclaredLookupIds,
): readonly LookupTableBinding[];
```

| Standing | Choice | Bound to |
|---|---|---|
| `new` | | the predeclared table id and column ids |
| `same-managed` | | the Project table's id; its columns by wire name; predeclared ids for fields it lacks |
| `same-equal` | | the Project's table as it is |
| `choice` | none yet (a read step: `choices` is null, or holds no answer for the tag) | as `same-managed`: the Project table's id; its columns by wire name; predeclared ids for fields it lacks |
| `choice` | `use-commcare-hq` | as `same-managed` |
| `choice` | `use-project` | the Project's table as it is |

No answer moves a binding the reader read: `use-commcare-hq` keeps this binding, and `use-project`
is offered only where every field the app reads has a column (7.2), so it names the same columns.
Part 12's digest rests on this (its 5.2).

The creation's writes for tables, in the birth transaction, are one call:

```ts
export interface BroughtInTableWrite {
	readonly read: Extract<HqLookupTableRead, { kind: "read" }>;
	readonly standing: LookupTableStanding; readonly choice: LookupTableChoice | null;
	readonly binding: LookupTableBinding;
}
export function writeBroughtInLookupTablesInTransaction(
	tx: Transaction<AppDatabase>,
	scope: { readonly projectId: string; readonly actorUserId: string },
	write: { readonly origin: { readonly server: string; readonly domain: string };
		readonly tables: readonly BroughtInTableWrite[]; readonly at: Date },
): Promise<void>;
```

**Where it runs.** Inside the genesis tail, at part 12's `afterAppInsert` seam (its section 6.2),
first of the seam's two writers (tables, then places, 11.4): after the tail's membership assertion
and its `INSERT apps`, before `lookupContextForAuthoritativeWrite`, so the gate and export
readiness read the tables on the transaction that made them. It does not run before
`writePreparedGenesisInTransaction`: taking `lookup_project_state` before the tail's shared
membership gate can close a cycle with a lookup writer and a membership write (part 12's
Departure 1, which holds at source: an app-bound lookup writer proves fresh membership before it
enters the Project-state prefix, `lib/lookup/CLAUDE.md`, "Valid writes"), and the seam needs no
second gate call.

**Authority.** The tail's `assertProjectCapabilityInTransaction(..., "edit")` has run on this
transaction before the seam. The writer reads the actor's role once more with
`projectRoleForInTransaction` (the gate is already held), builds the `LookupScope` the `lib/lookup`
arms take, and an `adopt` (the answer `use-commcare-hq`) needs that role to hold `delete`.

**What it does.** `lockLookupProjectState`; the Project's tables of the written tags, each with its
rows, read under that lock; `lookupTableStanding` again for each, with `readSiblingLookupMappings`
read on the same transaction. Where a standing's kind is no longer the one the binding was made
for, or an answered offer is no longer offered, it throws `BroughtInTableChangedError(tag)` and the
birth rolls back whole. Otherwise: one `createManagedLookupTablesInTransaction` for the `new`
tables; `refreshManagedLookupTableInTransaction` in `refresh` mode for each `same-managed`, in
`adopt` mode for each `use-commcare-hq`; nothing for `same-equal` and `use-project`. A `choice` with
no answer is an invariant failure here: part 12 answers that creation `held` before the transaction
opens (7.2).

```ts
/** A table the birth was about to write is no longer the table the review showed. */
export class BroughtInTableChangedError extends Error {
	readonly name = "BroughtInTableChangedError";
	readonly tag: string;
	constructor(tag: string);
}
```

Its message is for a developer and a log, never a person: "The lookup table <tag> changed in the
Project between the review and the birth."

**The lock order.** The birth holds its own new app row, then takes Project state, then the tables,
and after that requests no app row at all: every statement of the tail that follows touches the
new app's own rows. `lib/lookup/CLAUDE.md`'s rule ("No code may hold Project state or a lookup table
and later request an app lock") is about a lock another writer can hold, and it stands as written;
the app-first order is the one that file already gives app-bound writers (Contracts).

**What a changed table means to the person.** Part 12 catches `BroughtInTableChangedError` and a
`tag_taken` from the create arm: the row goes back to `reading` and the answer is `review-changed`
(part 12, 6.5), so the page reads again and shows the review with the table as it now stands. This
part names the error and when it is thrown; part 12 names the answer.

---

## 8. Before a publish, another project space, and the HQ app file

### 8.1 The re-read

`lib/deployment/preflight.ts::PREFLIGHT_CHECK_IDS` gains `"managed-data"`, after `"hq-connection"`
and before `"app-readiness"`: the refresh changes the lookup generation, and the export boundary must
validate and emit the generation that results. Title: "Data managed in CommCare HQ". The edge
appears only when a table the app reads is managed in CommCare HQ.

That puts it before `plan-features`, of which `lib/deployment/CLAUDE.md` ("Preflight is a graph")
says it "asks CommCare HQ nothing and comes before every edge that does". The position stands and
the rule is restated (Departure 14, and the Contracts row): `plan-features` comes before every edge
that writes to CommCare HQ or asks the person about a write; `managed-data` alone precedes it,
because it only reads, and what it writes is Nova's own copy of tables CommCare HQ manages. A publish
the person then declines at `plan-features`, or that any later edge refuses, keeps that refresh. It
is no half-done publish: the copy now holds CommCare HQ's current rows, which is what "Refresh from
CommCare HQ" would have written, for every app of the Project alike.

`lib/deployment/managedData.ts` (new) holds the logic; the edge calls
`reReadManagedTablesForPublish`:

```ts
export type ManagedTableChange =
	| { readonly kind: "table-gone" }
	| { readonly kind: "column-gone"; readonly column: string; readonly uses: number }
	| { readonly kind: "unsupported"; readonly holds: readonly UnsupportedLookupContent[] }
	| { readonly kind: "more-than-one-value" }
	| { readonly kind: "over-cap"; readonly phrase: string }
	| { readonly kind: "name"; readonly name: string }
	| { readonly kind: "unrepresentable-text"; readonly column: string };
export interface ManagedTablesReRead {
	/** Tables whose origin is the target and that changed in what the app reads. Stops. */
	readonly blocking: readonly { readonly tag: string; readonly name: string;
		readonly changes: readonly ManagedTableChange[] }[];
	/** Tables refreshed, with what changed. */
	readonly refreshed: readonly { readonly tag: string; readonly receipt: ManagedRefreshReceipt }[];
	/** Tables of another project space the publisher could not read: pushed from the copy as it is. */
	readonly stale: readonly { readonly tag: string; readonly domain: string;
		readonly refreshedAt: string }[];
	/** The target's table list, for the `project-data` edge to reuse. */
	readonly hqTables: readonly HqLookupTable[] | null;
}
export function reReadManagedTablesForPublish(input: {
	readonly access: PreflightInput["access"]; readonly doc: BlueprintDoc;
	readonly target: DeploymentTargetKey; readonly creds: CommCareCredentials;
}): Promise<ManagedTablesReRead
	/** `rows` is the name of the table whose rows could not be read, or null for the list. */
	| { readonly unreadable: HqFailure; readonly rows: string | null }>;
```

A failed read is classified once, by part 05's `classifyHqFailure(error, "lookup-tables")` for the
list and `classifyHqFailure(error, "lookup-rows", { member: true })` for a table's rows (the list
answered a moment before, so the key reaches the project space).

**What "a change to what the app reads" is.** The app reads a table and columns by id:
`extractLookupReferenceTargets(doc)` gives `tableIds` and `columnTargets`. For a managed table of
the target, with CommCare HQ's fresh definition and rows:

| Change | Computed | Result |
|---|---|---|
| no table has the tag | the list | `table-gone`: stops |
| a column this app's `columnTargets` name has no field of its wire name | the definition | `column-gone` with the column and `uses`, the count of `extractLookupReferenceOccurrences(doc)` that name it: stops |
| field properties, row attributes, not global | `unsupportedLookupContent` | `unsupported`: stops |
| a field with more than one value | `rowsHoldOtherThanOneValue` | `more-than-one-value`: stops |
| over a cap of 5.3 | `lookupCapExcess` and `measureLookupRows` | `over-cap`: stops |
| a field name outside the grammar | `lookupWireNameSchema` | `name`: stops |
| a cell holding a character XML 1.0 cannot carry | `xmlTextIssue` over every cell of a field the definition names | `unrepresentable-text` with the first such field's name: stops, so the copy never takes a value every export would then refuse (5.3) |
| anything else: rows, a new field, a field gone that this app does not read, an id CommCare HQ minted again | the canonical digests | the copy is refreshed (`refreshManagedLookupTableInTransaction`, mode `refresh`) |

In order: the Project's definitions of the tables the app reads (`getLookupDefinitions`); those
managed in CommCare HQ split into `here` (origin equals the target) and `elsewhere`.

- **`here`.** `listHqLookupTables(creds, domain)` once; its failure is the returned `unreadable`.
  Rows per table, `LOOKUP_ROWS_READ_CONCURRENCY` at a time; a failure is `unreadable` with that
  table's name. If any table has a stopping change, nothing is refreshed and every stopping change
  of every table is returned, so the person reads them all at once. Otherwise each table whose
  digest moved is refreshed in its own short transaction with the publisher as `hq_refreshed_by`.
- **`elsewhere`.** Grouped by origin. A person stores one CommCare HQ connection: one server, one
  key and the project spaces that key was approved for. `lib/db/settings.ts::getHqCredentials(userId,
  origin.domain)` (today's `getCredentialsForUpload(userId, requested?)`, renamed by part 05, section
  11) answers credentials only where that connection approves the origin's project space, and the
  credentials' `server` must also equal the origin's. Where both hold and the same reads succeed
  with no stopping change, the copy is refreshed. In every other case (`not_configured`,
  `not_authorized`, another server, a failed read, a stopping change) the table is `stale` and the
  publish goes on from the copy. A table of another project space never stops a publish: nothing of
  that space is written, and the copy is what the person sees in Preview.

The edge's outcomes:

| | Check | Refusal |
|---|---|---|
| `unreadable`, kind `permission`, `plan-lacks-api-access`, `key-not-accepted`, `api-cut-off` or `not-a-member` | blocked, Copy P3: the list read needs API access and Access APIs, and the rows read needs Edit Apps as well (`FixtureResource.Meta.authentication` is `RequirePermissionAuthentication(HqPermissions.edit_apps)`), so the one sentence names all three | `hq_resource_state_unknown` |
| `unreadable`, any other kind | blocked, Copy P4 (P5 where a table's rows are named and the kind is `hq-unavailable`) | `hq_resource_state_unknown` |
| `blocking` not empty | blocked, Copy P2 with one item per change (P6 to P11, P17) | `hq_managed_data_changed`, new in `DEPLOYMENT_FAILURE_CODES`; `details` are the items |
| otherwise | passed, Copy P1, items the tables by tag, each `stale` one with Copy P12 | |

`hq_managed_data_changed` offers no "Publish over this": the app's own content depends on what is
gone, and the two ways forward are in each item's words. It folds like any refused preflight (a
reached target's record is unchanged). No lookup write has happened when it is raised.

The refresh is a lookup write on a publish path, and it is the named arm: it holds no lock across a
read of CommCare HQ (the reads finish before the first transaction opens), and it advances the
Project revision only where a value changed.

### 8.2 What a publish sends

`lib/export/boundaryValidation.ts::PrepareExportBoundaryInput` gains
`lookupTarget?: { readonly server: string; readonly domain: string }`, which `hq-upload` passes (its
target) and the other two modes do not. `prepareWithRegistry` then:

- **`hq-upload`**: leaves out of the workbook every definition whose `hq` says `managedBy:
  "commcare-hq"` from exactly that server and project space. The fixapi upload leaves a table it
  does not name alone (`_run_upload`), so leaving it out is the whole of "never written". A managed
  table of another project space stays in the workbook: the publish creates it in the target from
  the copy, through the plan's existing create arm, as a table Nova made there. `hasUnpushableTag`,
  `lookupHqReservedTagFindings`, `lookupWorkbookBudgetFindings` and `lookupHqCellTextFindings` judge
  the tables that go, and only those: a table left out is never sent, so CommCare HQ's upload never
  trims it and its tag is never refused. `lookupHqCellTextFindings` therefore takes the snapshot
  narrowed to the workbook's tables.
- **`hq-json`**: 8.3. Both workbooks are judged, each over its own tables.
- **`ccz`**: unchanged. The archive embeds every table the app reads, the copy included.

`lookupXmlTextFindings` stays over every table the app reads in every mode, as today: the fixture
and both workbooks are XML or become it. For a managed table it finds nothing, because a cell it
would refuse stops the reading (5.3), the re-read (8.1) and a refresh (section 9) before the copy
takes it. A table handed back, or a Project table an answer made managed, holds CommCare HQ's
cells by the same refresh arm.

**Where a boundary finding does name a managed table**, its sentence must not send the person to
edit what Nova refuses to let them edit. Two can: `LOOKUP_CELL_TEXT_CHANGED_BY_HQ` (a managed table
of another project space, or of the HQ app file's second workbook, holding a cell with leading or
trailing white space, which comes in as CommCare HQ holds it) and, as a floor, the XML one. Both
`lib/commcare/lookup/hqCellText.ts::lookupHqCellTextFindings` and
`xmlText.ts::lookupXmlTextFindings` read `table.hq` on the snapshot's definition (6.2) and, where
`managedBy` is `"commcare-hq"`, end their sentence with the managed remedy in place of "in Project
data" (Copy X1, X2). The codes, locations and details are unchanged.

`PreparedExportBoundary` (the boundary's result type, `lib/export/boundaryValidation.ts`) gains
`managedLookupTables: readonly { readonly tableId: LookupTableId; readonly tag: string; readonly
name: string; readonly server: string; readonly domain: string; readonly refreshedAt: string }[]`,
every table the mode left out of its main workbook, in the definitions' order. `lookupWorkbook` is
undefined when no table goes.

`preflight.ts`:

- `publishConfirmationNeeds` hands `requiredConfirmations` two flags today, `lookupTables` (the app
  reads a table) and `places` (`places.length > 0`). `lookupTables` becomes "this publish sends a
  workbook": some table the app reads is not managed in CommCare HQ from the target. The `places`
  flag keeps its expression, and the function's own `places` list, the one the `organization` edge
  plans the push from, is `[]` where the app's places are managed from the target (11.4), so the
  flag is false there. So the `lookup-tables` and `organization` plan features are asked exactly
  when Nova writes that kind there. For the first, the function gains a fifth parameter,
  `managedTableIds: ReadonlySet<string>`: the tables the app reads that are managed in CommCare HQ
  from the target. The preflight passes the ids of `boundary.prepared.managedLookupTables`, and
  `service.ts::projectSpaceConfirmations` those of the definitions `projectLookupNaming` reads
  whose `hq` names the target with `managedBy: "commcare-hq"`. For the second it reads `hq` from
  the snapshot `readOrganization` already answers it (12.2).
- The `project-data` edge runs when a workbook goes, as today, and reuses `hqTables` from the
  `managed-data` edge where that read it. Its passed detail gains, where a table was left out,
  Copy P13.

Just before `uploadLookupTableWorkbook`, `publishAppToHq` reads the `hq_*` columns of the tables in
the workbook again, in one statement; a table that has become managed in CommCare HQ from the target
since preflight stops the publish at `resources`, nothing sent, with the new failure code
`managed_table_handed_back` (`DEPLOYMENT_FAILURE_CODES`) and Copy P18. It does not borrow
`app_changed_while_publishing`: that code's sentence ("This app kept changing while Nova got it
ready to publish ... Publish again once the edits settle.", `lib/deployment/service.ts`) is about
the app's own edits and would be false here. The stop folds like any refusal before a send (a
reached target's record is unchanged), and the next publish leaves the table out. That closes the
window to one statement and one request (10.3).

### 8.3 The HQ app file

The HQ app file is made for no project space, so it must work for the space that manages a table and
for one that has never seen it. It carries two workbooks:

- `lookup-tables.xlsx` (`MANUAL_IMPORT_LOOKUP_WORKBOOK`, unchanged): every table the app reads that
  is not managed in CommCare HQ.
- `lookup-tables-managed-in-commcare-hq.xlsx` (`MANUAL_IMPORT_MANAGED_LOOKUP_WORKBOOK`, new, declared
  beside the first in `lib/publish/manualImportGuide.ts`): every table managed in CommCare HQ, from
  Nova's copy. `PreparedExportBoundary.managedLookupWorkbook: LookupWorkbook | undefined`, undefined
  in the other two modes and where no table is managed.

A separate file is what makes the safe path the default one: a person importing into the project
space that manages the table uploads the first file as the guide has always said and touches
nothing CommCare HQ manages.

`lib/publish/manualImportGuide.ts`: `ManualImportGuideInput` gains `managedLookupTables: readonly {
tag: string; domain: string; refreshedOn: string }[]`; the step kinds gain `"managed-lookup-tables"`,
placed after `"lookup-tables"`; `manualImportGuide` adds the step where the list is not empty (Copy
G1). `refreshedOn` is the UTC day of `hq.refreshedAt`, spelled as part 10's `driftDate` spells a day:
the guide is a file made on the server for whoever opens the zip, so it has no reader's locale to
spell a day in, which is the one place this part's `{date}` is not the reader's own (Copy).

The guide and the archive are built by two functions of
`lib/commcare/multimedia/hqJsonExportArchive.ts`, and both change:

- `hqImportFileGuide(input)` builds the guide's input today, from `lookupWorkbook`. Its input gains
  `managedLookupWorkbook: LookupWorkbook | undefined` and `managedLookupTables` (the list above,
  mapped from `PreparedExportBoundary.managedLookupTables`), which it passes to `manualImportGuide`.
  It also computes `requiredPlanFeatures(doc, { lookupTables: input.lookupWorkbook !== undefined,
  places: false })`; the flag becomes `input.lookupWorkbook !== undefined ||
  input.managedLookupWorkbook !== undefined`. With every table managed there is no first workbook,
  and the guide would otherwise drop the `lookup-tables` plan feature that the second workbook needs
  in any project space but the one that manages the tables.
- `buildHqJsonExportArchive(appName, doc, hqJson, assets, lookupWorkbook, readme)` takes the README
  already rendered. It gains a parameter `managedLookupWorkbook: LookupWorkbook | undefined` after
  `lookupWorkbook` and writes it as `MANUAL_IMPORT_MANAGED_LOOKUP_WORKBOOK` beside the first.

Both have two callers, and both callers pass the two new values from the boundary's result:
`lib/mcp/tools/compileApp.ts` and `app/api/compile/json/route.ts`.

---

## 9. Manage in Nova, Let CommCare HQ manage it again, Refresh

`lib/deployment/managedData.ts` holds the three services; `lib/deployment/managedDataActions.ts`
(new, `"use server"`) holds their Server Actions. Arguments are plain JSON (a Project id, a table
id); each action authenticates, resolves the Project freshly from the id it was given, and never
falls back to the active Project.

```ts
export type ManagedTableOutcome =
	| { readonly ok: true; readonly receipt: ManagedRefreshReceipt | null;
	    readonly table: LookupTableManifestEntry }
	| { readonly ok: false; readonly reason:
		| "not-found" | "not-permitted" | "not-connected" | "cannot-read" | "unavailable"
		| "table-gone" | "unsupported" | "over-cap" | "name" | "unrepresentable-text"
		| "state-changed";
	    readonly message: string };

export function refreshManagedLookupTable(scope: LookupScope, tableId: LookupTableId): Promise<ManagedTableOutcome>;
export function manageLookupTableInNova(scope: LookupScope, tableId: LookupTableId): Promise<ManagedTableOutcome>;
export function letHqManageLookupTable(scope: LookupScope, tableId: LookupTableId): Promise<ManagedTableOutcome>;
/** What the table page shows of a table that came from CommCare HQ. `view`. */
export function readManagedLookupTableView(scope: LookupScope, tableId: LookupTableId): Promise<{
	readonly origin: LookupHqOrigin; readonly serverLabel: string; readonly hqUrl: string;
	/** Whether the viewer has a CommCare HQ connection on that server. */
	readonly connected: boolean;
	readonly apps: readonly LookupReferencingAppSummary[];
	readonly goneColumns: readonly { readonly wireName: string;
		readonly apps: readonly LookupReferencingAppSummary[] }[];
} | null>;
```

`hqUrl` is `${COMMCARE_SERVERS[server].baseUrl}/a/${domain}/fixtures/`, the address
`setupArtifact.ts` already gives for the Lookup Tables page. It is resolved on the server because a
client component may not import `lib/commcare`.

The actions, in `lib/deployment/managedDataActions.ts`. Each of the first four builds its
`LookupScope` from the session and the Project id; each of the last two (11.4, 12.2) builds its
`OrganizationScope` from the session and the app id:

```ts
export async function refreshManagedLookupTableAction(
	projectId: string, tableId: string): Promise<ManagedTableOutcome>;
export async function manageLookupTableInNovaAction(
	projectId: string, tableId: string): Promise<ManagedTableOutcome>;
export async function letHqManageLookupTableAction(
	projectId: string, tableId: string): Promise<ManagedTableOutcome>;
export async function readManagedLookupTableViewAction(
	projectId: string, tableId: string,
): Promise<Awaited<ReturnType<typeof readManagedLookupTableView>>>;
export async function refreshManagedPlacesAction(appId: string): Promise<ManagedPlacesOutcome>;
export async function readManagedPlacesViewAction(
	appId: string): Promise<Awaited<ReturnType<typeof readManagedPlacesView>>>;
```

A caller with no session, or no role in that Project, gets `not-found` from the first three and the
fifth, and null from the two views, as for a table or an app that is not there.

Every `reason` has its sentence, which is the outcome's `message`:

| `reason` | When | `message` |
|---|---|---|
| `not-found` | no such table in the Project, or the caller cannot see the Project | `lib/lookup`'s own `not_found` sentence, unchanged |
| `not-permitted` | the role lacks the capability the action needs | Copy T19: its first sentence for the two management changes, its second for a refresh |
| `not-connected` | the actor has no CommCare HQ connection | Copy T4 |
| `cannot-read` | the connection is on another server or not approved for the project space, or CommCare HQ refused the read | Copy T17 |
| `unavailable` | any other failed read | Copy T18 |
| `table-gone` | `ManagedTableChange` `table-gone` | Copy T5 |
| `unsupported` | `unsupported`, or `more-than-one-value` | Copy T6, `{holds}` being `describeUnsupportedLookupContent`'s phrase, or "a field with more than one value" |
| `over-cap` | `over-cap` | Copy T7 |
| `name` | `name` | Copy T6, `{holds}` being "a column named {name}" |
| `unrepresentable-text` | `unrepresentable-text` | Copy T21 |
| `state-changed` | the refresh arm's `conflict` (6.4, step 1) | Copy T20 |

A refresh from the table page never meets `column-gone`: a column an app reads is kept, and said
(Copy T16). Where several changes stop one refresh, the outcome is the first in the order of 8.1's
table.

| | Refresh from CommCare HQ | Manage in Nova | Let CommCare HQ manage it again |
|---|---|---|---|
| Offered when | the table is managed in CommCare HQ | the same | the table is managed in Nova and came from CommCare HQ |
| Needs | the Project's `edit`; the actor's connection on the origin's server | the Project's `delete` | the Project's `delete`; the actor's connection |
| Reads CommCare HQ | the list, then the table's rows, with the actor's key | no | the same two reads |
| Confirmation | none: it replaces nobody's work | Copy T9, naming the apps that read the table | Copy T11, naming the apps |
| Writes | `refreshManagedLookupTableInTransaction`, mode `refresh` | under Project state and the table lock (`hq-management`): `hq_taken_over_at = now`, `hq_taken_over_by = actor`, and `definition_revision` stamped. No row changes; the Project revision advances once and notifies | `refreshManagedLookupTableInTransaction`, mode `adopt`: CommCare HQ's columns and rows, every column text, the takeover pair set to null, and `definition_revision` stamped whether or not a column changed (6.4, step 5) |
| Refuses when | the table is gone from CommCare HQ, or now holds what Nova cannot hold, or is over a cap, or holds a character CommCare can't carry in a value: the copy stays as it was and the page says which (Copy T5 to T7, T21) | never, once permitted | the same as Refresh |

**Why a change of who manages a table stamps `definition_revision`.** The table page reads its
snapshot (`LookupTableSnapshot`, which carries `hq`, 6.2) through
`components/builder/project-data/useProjectData.ts::useProjectDataTable`, and that read is keyed on
the manifest entry's `tableRevision` "so a co-member's row edit refetches this table and nothing
else". With only the Project revision moving, an open page would get the new manifest frame and
keep its old snapshot: `hq.managedBy`, `hq.goneColumnIds` and every control read from them would be
stale until a reload. Who manages a table decides whether any client may edit it, so it is part of
the definition as a client reads it, and stamping the definition axis is what `lib/lookup/CLAUDE.md`
already asks of a "schema/display" change. Two things follow, both wanted: every open page refetches
the one table and offers or withdraws editing with no reload, and a tab that loaded the table before
the change and writes after it answers `conflict` (or `managed_in_hq`, which is checked first)
rather than landing an edit made under the other regime. `tableEditability` (12.1) reads `hq` from
the manifest entry too, so the list screen and the page agree before the refetch lands.

**The actor's connection.** "Needs the actor's connection" is `getHqCredentials(actor,
origin.domain)` answering credentials whose `server` is the origin's (8.1's rule). `not_configured`
is the outcome `not-connected` (Copy T4); `not_authorized` and another server are `cannot-read`
(Copy T17).

**What Manage in Nova means for the next publish.** The table is no longer left out of the workbook
for its project space. The plan finds CommCare HQ's table under the tag with no mapping; the table's
own columns say a person took it over from there, so the plan pushes it as `adopted`, attributed to
that person and that moment (10.2, arm 3), and the drift check compares CommCare HQ now with
`hq_canonical`, the state at the last refresh. So a change someone made in CommCare HQ between the
last refresh and that publish stops it with `hq_changed`, which is what the confirmation promises.
After that publish the ordinary mapping and push baseline carry the table, and `hq_canonical` is
read again only if the table is handed back.

**The facts a push will clear**, said in the confirmation: a description and indexed fields
(`LOOKUP_DISCARD_NOTE`). A managed table is global with no field properties and no row attributes,
or it would not have come in, so those three are not at stake.

**What Let CommCare HQ manage it again means for the ledger.** Live `lookup-table` mappings the
Project's apps wrote while Nova managed the table stay until each app's next complete push, which
supersedes a mapping it does not name (`recordPushedResources`). Nothing reports the table as left
behind: `resources.ts::leftBehindResources` reports a superseded table only when the Nova table is
gone or its tag differs, and here neither is so.

**The lookup drift stop for a table Nova manages that came from CommCare HQ.** Step 6 keeps "Publish
over this" as the one answer in the dialog (bringing CommCare HQ's changes in at the stop is step
7's `changes-made-in-hq`). The item for such a table gains one sentence that names the second way,
which already exists on the table's page: Copy P14. `describeLookupChange`'s one caller,
`lib/deployment/preflight.ts::lookupRemoteChange`, gains the input `handBackOffered: boolean` (true
where the definition's `hq.managedBy` is `"nova"`, which the `project-data` edge reads with the
origins, 10.2) and, where it is true, appends P14 as the last of the change's `parts`.

---

## 10. Ownership derived across the Project's live mappings

### 10.1 The read

`lib/deployment/store.ts`:

```ts
export interface SiblingLookupMapping {
	readonly tableId: string; readonly appId: string; readonly remoteId: string;
	readonly pushedIdentity: string; readonly ownership: DeploymentResourceOwnership;
	readonly adoptedAt: string | null; readonly adoptedBy: string | null;
}
/** Live lookup-table mappings of the Project's other apps on one project space. `view`. */
export async function readSiblingLookupMappings(
	scope: DeploymentScope, target: DeploymentTargetKey, tableIds: readonly string[],
	tx?: Transaction<AppDatabase>,
): Promise<readonly SiblingLookupMapping[]>;
```

One statement:

```sql
SELECT r.nova_resource_id, d.app_id, r.remote_id, r.pushed_identity, r.ownership,
       r.adopted_at, r.adopted_by
FROM app_deployment_resources r
JOIN app_deployments d ON d.id = r.deployment_id
WHERE d.project_id = $1 AND d.server = $2 AND d.domain = $3 AND d.app_id <> $4
  AND r.kind = 'lookup-table' AND r.superseded_at IS NULL
  AND r.pushed_identity IS NOT NULL AND r.nova_resource_id = ANY($5)
ORDER BY r.nova_resource_id, r.adopted_at NULLS LAST, r.created_at, r.id
```

It counts an app in recently deleted and an app whose deployment there is ended: what either put in
CommCare HQ is still there (part 10, section 8.2, keeps those mappings). An app deleted for good
takes its rows with it by cascade, and the table then reads as it would to a Project that had never
published it.

It has a second caller: the reading (7.1), which asks whether a Project table that equals CommCare
HQ's is already accounted for in the project space the app comes from. `$4` is then the reading's
id, which is the id the app will take and names no deployment yet, so every app of the Project is a
sibling. The function also takes an optional transaction, which the birth passes (7.4) so the answer
it re-derives the standing from is read under the locks it holds.

### 10.2 The plan

`lookupResourcePlan.ts::PlanLookupResourcePushInput` gains:

```ts
	/** Live mappings of the Project's other apps for these tables on this project space. */
	readonly siblings: readonly SiblingLookupMapping[];
	/** Tables a person took over from this project space with Manage in Nova. */
	readonly takenOver: readonly { readonly tableId: string; readonly remoteId: string;
		readonly at: string; readonly by: string }[];
```

`PlannedLookupPush` gains `adoption: { readonly at: string; readonly by: string } | null` (who
handed the table to Nova, where the standing is inherited) and `baseline: "mapping" | "table-origin"
| null` (what the drift check compares with). The arms, first match, for a table whose tag CommCare
HQ holds as `remote`:

| # | When | Push |
|---|---|---|
| 1 | this deployment's live mapping has the tag and `remote.id` (today's arm, unchanged) | the mapping's ownership; `mappedRemoteId` the mapping's; `baseline: "mapping"` |
| 2 | some sibling mapping has `pushedIdentity === tag` and `remoteId === remote.id` | `adopted` where any such sibling is adopted, with `adoption` the earliest one's pair; else `nova-created`; `mappedRemoteId: remote.id`; `baseline: "mapping"` |
| 3 | `takenOver` names the table | `adopted`, `adoption` the takeover's pair; `mappedRemoteId: remote.id`; `baseline: "table-origin"` |
| 4 | the caller named the table in `adoptTableIds` (today's arm) | `adopted`, `adoption: null`, `mappedRemoteId: null` |
| 5 | otherwise | a conflict, as today |

A tag CommCare HQ does not hold is the create arm, unchanged. The `unsupported` refusal still comes
first.

Arm 2 is the end of today's refusal. The standing is the Project's, read from every sibling whose
mapping names the very table CommCare HQ now holds under the tag; a sibling whose `remoteId` is
another id describes a table CommCare HQ has since made again, and says nothing. The drift check for
arm 2 needs no new code: `project_space_resource_baselines` is keyed by the HQ resource within the
Project and project space, so this app compares with the baseline the sibling's push wrote.

Arm 3's comparison: `preflight.ts`'s `lookupRemoteChange` is handed, in place of a stored baseline, a
value built from the table's `hq_canonical` with `remoteId` set to `remote.id`, by `managedData.ts`:

```ts
/**
 * The baseline a taken-over table is compared with: its stored `hq_canonical`, parsed as
 * `CanonicalLookupTable`, under the id CommCare HQ holds the tag at now.
 */
export function baselineFromTableOrigin(input: {
	readonly canonical: unknown; // `lookup_tables.hq_canonical`
	readonly remoteId: string;   // `remote.id`
	readonly refreshedAt: string; // `hq_refreshed_at`
}): Extract<ResourceBaseline, { readonly origin: "push" }>;
// { origin: "push", kind: "lookup-table", remoteId, canonical: { ...parsed, remoteId },
//   digest: parsed.digest, observedAt: refreshedAt }
```

The `project-data` edge reads `hq_canonical` and `hq_refreshed_at` of each taken-over table in the
statement that reads the origins. A stored value that does not parse as a `CanonicalLookupTable`
throws: the CHECK of 6.1 and the one writer of the column rule it out. An id CommCare HQ minted
again since the last refresh is thereby judged by content, the definition digest and then the rows,
which is what the person was promised.

`store.ts::recordPushedResources` writes this deployment's mapping with the planned ownership. Where
it is `adopted` and `adoption` is set, `adopted_at` and `adopted_by` are that pair; where `adoption`
is null (arm 4) they are now and the actor, as today. `writeResourceMapping`'s rule that the pair is
set together holds either way.

`preflight.ts`'s `project-data` edge reads `readSiblingLookupMappings` and the tables' `hq` origins
in the same pass that reads the target's list, and passes both to the plan.

### 10.3 The lock, decided

The standing is derived with no lock held from a publish's plan to its workbook. Not done: deriving
it under the Project state lock and holding that lock until the workbook goes, because a publish
asks CommCare HQ several questions between its plan and its workbook, and no lock spans those round
trips (`lib/deployment/CLAUDE.md`). So:

- The derivation is one snapshot statement (10.1). Two sibling apps that publish one table to one
  project space for the first time at the same moment each plan a create, each upload, and each
  record `nova-created` with the id it read back; the later plan of either takes arm 1 or arm 2 by
  CommCare HQ's current id. Nothing is refused and no table is taken over unasked.
- The two writers that change who manages a table (section 9) take Project state and the table row,
  the lookup writer's own order, so they are serial with each other and with a refresh.
- A publish reads the managed fact again in one statement before its workbook goes (8.2). What stays
  open is one request wide: a table handed back to CommCare HQ after that statement and before the
  upload is written once more. `lib/deployment/CLAUDE.md`'s "What the check cannot close" gains the
  sentence (Contracts).

---

## 11. Places, levels, location properties and worker properties

New files `lib/deployment/reading/projectData/places.ts` (pure), `placeStore.ts` beside it (its one birth
writer, `writeBroughtInPlacesInTransaction`; section 14, "Pure files and store files"),
`lib/organization/managed.ts` and `lib/commcare/reader/worldEntities.ts`. The last holds the two pure
functions the reader itself calls, `worldEntitiesFromReads` (11.5, landing in B6) and `levelsFromHq`
(11.2, joining it in B9): `lib/commcare/reader` may not import `lib/deployment`, which is its consumer
(part 06, section 2.4), so they live in the reader, authored here as part 08 authors B2's expression
files, and `places.ts` imports `levelsFromHq` from the reader (`@/lib/commcare/reader/worldEntities`).

### 11.1 When places come in

When the app's logic reads places: `documentReadsPlaces(doc: BlueprintDoc): boolean` (`places.ts`)
is true where the document the reader assembled holds a `locations`, `location-field`,
`location-level` or `owner-location-at-level` leaf in any expression slot. As with tables, the read
comes first, and the test that decides it can only name too many.

`sourceMayReadPlaces(sourceText: string): boolean` (`places.ts`) is true where the source's text
(the raw body and every form's attachment, the text `readHqLookupTablesForReading` takes, 5.1)
holds `jr://fixture/locations`, or holds the word `locations` directly after a quote
mark in any spelling the text can carry one: `'`, `"`, `&apos;` or `&quot;`. A form reads places
through an instance whose source is that address, whatever id it gives it. A suite expression in the
app's source (a case list filter, a calculated column, a search default) carries no declaration,
since CommCare HQ adds those at build, and names the instance by id in a string literal. Nova's
grammar reads that literal in either quote and with any white space inside the call's parentheses
(`lib/commcare/xpath/grammar.lezer.grammar`, `StringLiteral`), which is why the test looks for the
quoted word and not for `instance('locations')` whole; a double quote inside the JSON body is
written `\"`, which still ends in the quote mark the test looks before. A false yes costs two
reads.

Only then does the reading ask CommCare HQ for `listHqLocationTypes` and `listHqLocations`, under
part 05's project data deadline. A failed read is classified by part 05 and by nothing here:
`classifyHqFailure(error, "location-types")` or `"locations"`, then `hqReadCircumstance(failure)`,
which gives `cannot-read-organization` for the four gates it cannot tell apart and
`plan-lacks-api-access`, `key-not-accepted` and the rest for what they are.

**The backstop.** `readReadingProjectData` answers `placesRead: boolean` (14.1). Where the reader's
document reads places (`documentReadsPlaces`) and `placesRead` is false, the source test missed a
spelling: part 12 calls `readReadingProjectData` once more with `places: "always"`, runs the reader
again with the levels in scope, and logs the miss at error with the reading's id, so the spelling is
added to the test. It is one extra pass, never a loop: the second call always reads places.

An app whose source passes neither test brings no level and no place. One whose source passes the
test and whose logic then reads no place (a false yes) holds the levels CommCare HQ lists, because
the reader's structure stage puts them on its draft before any expression is read (11.2), and no
place: `readsPlaces` is false, so nothing of 11.4 is planned, written or found. Levels alone write
nothing in CommCare HQ (11.3) and stay editable.

### 11.2 Levels

Every level CommCare HQ lists comes in as a document level, parent before child, whether or not the
app's logic names it: a place stands at one, and a tree needs every level between (Departure 16).

```ts
/** `lib/commcare/reader/worldEntities.ts`. Added to the file by B9. Pure. */
export function levelsFromHq(levels: readonly HqLocationType[], resolver: IdentityResolver):
	{ readonly levels: readonly OrganizationLevel[]; readonly findings: readonly Finding[] };
```

The reader's structure stage calls it from B9 and puts `levels` on its draft, so the levels are in
scope when expressions bind (part 06, section 2.3); it raises none of `findings`. They are raised
once, by `readingProjectDataFindingsFor` (14.1), and only where the app reads places: a level Nova
cannot hold is no fact about an app that reads none.

| Slot | Value |
|---|---|
| `uuid` | the `uuid` of `resolver.claim(externalKey.organizationLevel(code), whereText({ kind: "organization" }))` (part 10, sections 2.2 and 2.3; `whereText` is part 06's `reader/place.ts`). CommCare HQ holds one level of a code in a project space (`corehq/apps/locations/models.py::LocationType`, unique on domain and code), so the claim answers `ok: true` |
| `code`, `name` | CommCare HQ's; a code outside `LEVEL_CODE_PATTERN` or over its length is the circumstance `place-not-holdable` (13.2) at `{ kind: "organization" }`, name the level's name, and that level and every level beneath it are left out of `levels`, so a draft never holds a level the gate would refuse |
| `parentLevelUuid` | the level of `parentCode`, or absent |
| `caseFlow` | `{ workers: "assigned", ownsCases: sharesCases, descendantCases: viewDescendants ? { kind: "all" } : { kind: "none" } }` |
| `addressBook` | `{ reach: "own-branch" }` |

`administrative` is not read: `lib/domain/organization.ts` records why (CommCare HQ sets it from
CommTrack and reads `has_users`), and the API does not return `has_users`.

### 11.3 The settings no API returns

`LocationTypeResource.Meta.fields` holds `id`, `domain`, `name`, `code`, `parent_type`,
`administrative`, `shares_cases` and `view_descendants`. It returns none of `has_users`,
`expand_from`, `expand_from_root`, `expand_to`, `include_without_expanding` and `include_only`.
Lifecycle: all alive on `LocationType`. So Nova cannot know which levels hold workers, or how far up
and down a worker's phone carries places. It takes its own defaults, which are CommCare HQ's defaults
for a new level (`has_users` true, no expand settings): `workers: "assigned"` and `reach:
"own-branch"`.

What that changes: nothing in CommCare HQ, since Nova writes no level (`LocationTypeResource` is GET
only) and, for this app in its own project space, no place. It changes Preview: a persona's
`locations` instance is built from the levels' settings (`footprint.ts::locationFixtureRows`), so
where the project space carries more or less of the tree than the default, Preview's place lists
differ from a worker's. The levels stay editable for exactly this reason, and Organization says so
(Copy O3). The review says it once (Copy R5).

Preview shows a worker's places through a persona, and an app just brought in has none. Organization
says that too, with the next step (Copy O4).

### 11.4 The places: a copy managed in CommCare HQ

```ts
/** `lib/organization/managed.ts`. One place of CommCare HQ's, as the copy holds it. */
export interface ManagedPlaceWrite {
	readonly hqLocationId: string; readonly siteCode: string; readonly name: string;
	readonly levelUuid: string; readonly parentSiteCode: string | null;
	readonly latitude: string | null; readonly longitude: string | null;
	/** By location property uuid. */
	readonly values: Readonly<Record<string, string>>;
}
export interface ManagedPlacePlan {
	readonly places: readonly ManagedPlaceWrite[]; // parent before child
	readonly digest: string;
	/** Active places left out because their level is not in the app, by level code. */
	readonly leftOut: Readonly<Record<string, number>>;
	readonly findings: readonly Finding[];
}
/** `lib/deployment/reading/projectData/places.ts`. Pure. */
export function planManagedPlaces(input: {
	readonly hqPlaces: readonly HqLocation[];
	readonly levels: readonly OrganizationLevel[];
	readonly properties: readonly LocationProperty[];
	/** `birth`: a level the app lacks cannot happen. `refresh`: such places are left out. */
	readonly mode: "birth" | "refresh";
}): ManagedPlacePlan;
```

| Checked | Result |
|---|---|
| more than `MAX_LOCATIONS_PER_APP` (10,000) places | the circumstance `places-over-nova-limit`, name `"<n> places"` |
| a site code that fails `siteCodeSchema`, or is not its own lower case, or meets another place's | `place-not-holdable`, name the place's name |
| a name over `LOCATION_NAME_MAX_LENGTH`, or a coordinate `canonicalCoordinate` refuses | `place-not-holdable` |
| a parent that is not in the list, or a level that may not nest under its parent's (`levelMayNestUnder`) | `place-not-holdable` |
| a value, for a location property the app reads, that is not a string or is over the value length | `place-not-holdable`, name `"<place>: <slug>"` |
| a level code no level of the app has | `birth`: `readReadingProjectData` rules it out before any plan is made (14.1, step 6: a place naming a level code the level list lacks means the two reads straddled a change, both are read once more, and a second mismatch is the failure `hq-unavailable`), unless the level was left out by 11.2, whose finding already stands; so the place and everything under it is left out and nothing more is found. `refresh`: the place and everything under it is left out and counted in `leftOut` |

`values` holds, for each location property of the document, the place's `location_data[slug]` where
it is a string. Keys the app reads no property for are not copied: Nova never writes these places,
so nothing of CommCare HQ's is at risk, and a value no expression reads is not data Preview shows.
`external_id` is not served by the v0.6 resource, so the copy holds none (Copy O5). The digest is
`canonicalJsonDigest` of the places in site code order with the fields above.

**What the birth's integrity step would refuse is found here first.** With the copy written inside
the tail (below), `applyOrganizationCommitIntegrity` checks the rows against the document, and a
refusal there would be a gate refusal at creation. Of its checks, a brought-in document can meet
one that `planManagedPlaces` does not already hold: placements are the table's fourth row, values
its fifth (a location property comes in not required, with no choices and no levels, 11.5), and
there is no persona, no fixed owner and no removed level. The one is
`assertReverseHopTargetsUnambiguous`: an `owner-location-at-level` rule needs exactly one live place
at its level below each case-owning place. So, once the reader has returned its document:

```ts
/** The owner rules of `doc` that the copy would refuse, as findings. Pure. */
export function managedPlacesOwnerFindings(doc: BlueprintDoc, plan: ManagedPlacePlan): readonly Finding[];
```

It runs the checks the tail runs, over the planned rows in place of stored ones:
`commitIntegrity.ts`'s `reverseHopDestinationLevelUuids(doc)`, then `reverseLocationOwnerIssue(doc,
rows, levelUuid)` for each (both exported for it, with `ownerVerdictRows`). An issue is the
circumstance `owner-rule-needs-one-place` (13.2) at `{ kind: "organization" }`, `detail.name` the
level's name. `readingProjectDataFindingsFor` (14.1) includes them.

The fact lives on `app_organization_state` (6.1): places are app rows, so the fact is the app's, and
there is no table to share and no tag to collide.

```ts
export function writeManagedPlacesInTransaction(
	tx: Transaction<AppDatabase>,
	input: { readonly appId: string; readonly actorUserId: string;
		readonly origin: { readonly server: string; readonly domain: string };
		readonly plan: ManagedPlacePlan; readonly at: Date },
): Promise<OrganizationRevision>;
```

That is `lib/organization`'s writer. The birth calls it through this part's
`lib/deployment/reading/projectData/places.ts`, as it calls the lookup arms through
`writeBroughtInLookupTablesInTransaction`:

```ts
/** The birth's one call for places. `places` null: the app reads none, and nothing is written. */
export function writeBroughtInPlacesInTransaction(
	tx: Transaction<AppDatabase>,
	scope: { readonly appId: string; readonly projectId: string; readonly actorUserId: string },
	write: { readonly origin: { readonly server: string; readonly domain: string };
		readonly places: ManagedPlacePlan | null; readonly at: Date },
): Promise<void>;
```

**Where it runs.** In the birth transaction, inside the genesis tail, through part 12's
`afterAppInsert` seam, after `writeBroughtInLookupTablesInTransaction`: after the app row, because
`app_organization_state` and `app_locations` reference `apps(id)`; and before the tail's
`applyOrganizationCommitIntegrity` (`lib/db/appGenesis.ts::writePreparedGenesisInTransaction` calls
it before it returns), which checks every place row against the document's levels and location
properties and writes `app_location_references`. It does not run after the tail (part 12's
Departure 1): the integrity step is the one check that proves the copy against the levels the same
birth saves (`assertLocationPlacementsValid`, `assertLocationValuesValid`), and it must see the
rows.

**No place id is predeclared**, and none needs to be. A document names a place in two ways (a
persona's assignment, and a `fixed-location` owner term; `lib/organization/CLAUDE.md`, "The two
directions of cross-store reference"), and a brought-in document holds neither: it has no persona,
and no reading yields `fixed-location`, whose printed value is Nova's own place UUID and which every
export mode refuses (the same file, "Boundaries": "A FIXED PLACE stays refused"), so a document
holding one would fail the bar's clause (a). A reverse hop (`owner-location-at-level`) names levels,
which are document entities. So `writeManagedPlacesInTransaction` mints ids in the transaction (the
statement of `mintIds`).

`writeManagedPlacesInTransaction` inserts `app_organization_state` with the eight origin columns and
`location_count`, and inserts the rows parent before child with `hq_location_id`, `created_by` the
actor, and order keys from `balancedKeysBetween` over the list sorted by depth, parent and name. One
revision advance. It takes no organization lock of its own: the app row is this transaction's own
insert, which no other session can see.

**Read-only in Organization.** `lockOrganizationForWrite`'s options gain a required `purpose:
"author" | "hq-refresh" | "read"`. For `author` on a state row with `hq_server` set it throws
`OrganizationError("managed-in-hq", organizationManagedRefusal(domain))` (Copy O7);
`OrganizationErrorCode` gains the member. The function has two callers today, both in
`lib/organization/service.ts`:

| Caller | Capability | Purpose | On managed places |
|---|---|---|---|
| `withOrganizationWrite`, the one path of `createLocation`, `updateLocation`, `moveLocation` and `setLocationArchived` | `edit` | `author` | refused `managed-in-hq`, so the builder, the SA's and MCP's place tools and a second tab are all held in one place |
| `describeArchiveImpact`, the locked read before an archive | `view` | `read` | never refused: it writes nothing, and its answer is true of the copy. The archive it previews is then refused by the row above |
| `refreshManagedPlacesInTransaction` (new, below) | `edit` | `hq-refresh` | the one writer of a managed copy |

Levels and location properties are document entities and stay editable: adding a location property
is how a person makes a slug readable, and the level settings are 11.3's. A removed location
property sheds its values through the blueprint commit, as today.

**A level or property edit that the copy blocks.** Three refusals of
`lib/organization/commitIntegrity.ts` can meet such an edit, and each today ends by sending the
person to change places, which Nova refuses for a managed copy: `assertRemovedLevelsUnused` ("move
every place to another level"), `assertLocationPlacementsValid` ("move it to another level", "move
it to a valid parent") and `assertLocationValuesValid` (a property made required, or narrowed, over
places that lack a fitting value). Where one of the three is about to throw,
`applyOrganizationCommitIntegrity` reads `hq_server` and `hq_domain` of the app's
`app_organization_state` row (one statement, on the refusal path only), and where they are set it
throws the managed sentence instead (Copy O14 to O16): the same fact, with the next step that
works, which is to change the places in CommCare HQ and refresh. The checks themselves do not move,
a commit that passes reads nothing more, and an app with no managed copy reads today's sentences.

There is no Manage in Nova for places in step 6. The way to add or change a place is CommCare HQ and
Refresh, and the banner says so. Taking an organization over is step 7's `changes-made-in-hq`, with
the merge that would make it safe.

**Refresh.**

```ts
export interface ManagedPlacesRefresh {
	readonly added: number; readonly changed: number; readonly archived: number;
	/** Places gone from CommCare HQ that a persona or an owner rule still names: kept. */
	readonly keptInUse: readonly string[]; // names
	readonly leftOut: Readonly<Record<string, number>>;
}
export function refreshManagedPlacesInTransaction(
	tx: Transaction<AppDatabase>, scope: OrganizationScope,
	input: { readonly plan: ManagedPlacePlan; readonly at: Date },
): Promise<ManagedPlacesRefresh>;
```

`lockOrganizationForWrite(..., { capability: "edit", purpose: "hq-refresh" })`. Where the stored
digest equals the plan's: the two refresh columns, no revision. Otherwise, matched by site code: a
place CommCare HQ has and the copy lacks is inserted; one whose name, level, parent, coordinates,
values or `hq_location_id` differ is updated; one the copy holds live and CommCare HQ no longer lists
is archived (`archived_at`), unless an `app_location_references` row names it, in which case it
stays and is in `keptInUse`; an archived one CommCare HQ lists again is restored. The refresh never
writes the document, so it never unassigns a persona: the person moves the persona and refreshes
again (Copy O6). `hq_left_out` takes the plan's `leftOut`. One revision advance.

`lib/deployment/managedData.ts::refreshManagedPlaces` is the service (the actor's key on the
origin's server, `listHqLocations`, `planManagedPlaces` in `refresh` mode over the document's
levels and location properties, the transaction), and `refreshManagedPlacesAction` its action
(section 9):

```ts
export type ManagedPlacesOutcome =
	| { readonly ok: true; readonly refresh: ManagedPlacesRefresh;
	    /** `hq_refreshed_at` as this refresh wrote it. */
	    readonly refreshedAt: string }
	| { readonly ok: false; readonly reason:
			| "not-found" | "not-permitted" | "not-connected" | "cannot-read" | "unavailable"
			| "over-limit" | "not-holdable";
	    readonly message: string };
export function refreshManagedPlaces(scope: OrganizationScope): Promise<ManagedPlacesOutcome>;
```

Every refusal leaves the copy as it was. `not-found` (the app has no managed places, or the caller
cannot see it) carries `lib/organization`'s own `not_found` sentence; `not-permitted` Copy T19's
second sentence; `not-connected` Copy O17; `cannot-read` Copy O12; `unavailable` Copy T18;
`over-limit` (`places-over-nova-limit` in the plan's findings) Copy O11; `not-holdable`
(`place-not-holdable`) Copy O13 with the first such finding's name. A success shows Copy O9, or O10
where `added`, `changed` and `archived` are all zero, then O6 where `keptInUse` is not empty and O8
where `leftOut` is not.

**At a publish.**

- To the project space that manages them: `publishConfirmationNeeds` plans no place
  (`places: []`), so the `organization` plan feature is not asked and nothing is pushed. The
  `organization` edge still appears where the app has levels and its places are managed here: it
  reads `listHqLocations` (not the levels), runs today's `ambiguousReverseHopsOnTarget` check over
  that read, then refreshes the copy from it (`planManagedPlaces`, `refresh` mode; a plan with
  findings refreshes nothing and adds Copy P16 as an item). Passed detail: Copy P15. An unreadable
  organization blocks as it does today, with today's sentence: the reverse hop check is about what
  Nova's own owner rules would pick there.
- To any other project space: the copy is planned and pushed by `planLocationResourcePush` as it is
  for any app, as places Nova made there, with every existing refusal (a level the target lacks, a
  site code it already uses). "Never pushed" is about the project space that manages them.

**Provisioning workers.** `workerProvisionPlan.ts` turns a persona's places into CommCare HQ ids
through `location` mappings, and managed places have none. Its plan input gains
`managedPlaceIds: ReadonlyMap<string, string>` (Nova place id to `hq_location_id`), which
`workers.ts::provisionWorkers` fills from the rows when the target is the managing project space and
leaves empty otherwise, and puts in the one `planInput` it builds. That file builds
`remoteIdByLocationUuid` twice, and both read it after the mappings:

- `workerProvisionProblems`, which `provisionWorkers` calls first and which refuses a persona whose
  place has no entry ("stands in ..., which isn't on this project space yet"). Its input is a `Pick`
  of the plan input (`"workers" | "mappings" | "workerDataGaps" | "domain"`), which gains
  `"managedPlaceIds"`. Without it every persona standing in a managed place would be refused before
  the plan ran.
- `planWorkerProvisioning`, which sends the ids.

So a persona standing in a managed place gets that very place in CommCare HQ.

### 11.5 Location properties and worker properties

- **A location property** comes in for each slug the app's logic reads as `location_data/<slug>`:
  `{ uuid, slug, label: slug }`, `uuid` that of
  `resolver.claim(externalKey.locationProperty(slug), whereText({ kind: "organization" }))`, not
  `required`, no `choices`, no `levelUuids`. Its definition in CommCare HQ (label, required,
  choices) is served by no API-key read, and Nova writes no definition, so nothing is lost there;
  the person can set a label in Organization.
- **A worker property** comes in for each slug the app's logic reads of the worker's own data
  (`session/user/data/<slug>`, or the worker's record): `{ uuid, slug, label: slug }`, `uuid` that
  of `resolver.claim(externalKey.userProperty(slug), whereText({ kind: "app" }))`. Each distinct
  slug is claimed once, so every claim answers `ok: true`. A slug outside
  `USER_PROPERTY_SLUG_PATTERN`, over its length, or in `BUILT_IN_USER_PROPERTY_SLUGS` is not this
  part's to mint: the reader keeps it in the name-backed `session-user` arm where that arm admits
  it, and gives its own finding where it does not (B6; part 04's hand-off for unchanged grammars).
- Neither has a type in Nova, so nothing is typed from how the app uses it.

**The order, decided.** A read binds to one of these entities by UUID, and only to an entity the
document already holds: `sessionUserPropertySchema` holds `userPropertyUuid` and
`locationRowFieldSchema` a property's uuid (`lib/domain/expression/types.ts`), and the binder gives
the UUID leaf only where the document has exactly one property of that slug
(`lib/commcare/xpath/referenceBindings.ts::formUserProperty`), else the name-backed `session-user`
leaf; a `location_data` step with no property is the issue `unknown-location-property` (part 08,
section 9.2). So "one per slug the reader bound" would mint nothing: the leaves cannot exist before
the entities. The slugs are learned by a first pass, as the tables are (5.1), and with the one way
Nova reads an expression's structure, the grammar (root `CLAUDE.md`: "Never regex-parse XPath"):

1. B6's `readExpressions` (part 08) runs once over the document as the structure readers left it,
   which holds no worker property and no location property. It is asked only for what it met,
   part 08's `ExpressionReading["worldReads"]` (its section 2.5): `{ readonly userFields: readonly
   string[]; readonly locationDataSlugs: readonly string[] }`, the `field` of every name-backed
   `session-user` leaf it produced and the slug of every `location_data/<slug>` step its binder
   met, each distinct, in code-unit order. Its trees and its findings from this pass are dropped.
2. `worldEntitiesFromReads(worldReads: ExpressionReading["worldReads"], resolver: IdentityResolver):
   { readonly userProperties: readonly UserProperty[]; readonly locationProperties: readonly
   LocationProperty[] }` (`lib/commcare/reader/worldEntities.ts`, B6, pure). A user field comes in
   where it passes `userPropertySlugVerdict` and is not in `BUILT_IN_USER_PROPERTY_SLUGS`; a
   location slug where it passes `locationPropertySchema`'s slug grammar. Every other name is left
   out, and the second pass words it. Each list is in the order of its slugs.
3. The reader adds both lists to its draft document and runs `readExpressions` again. This pass is
   the reading: a read of a minted slug binds by UUID, and anything left name-backed or unknown is
   B6's finding or its admitted `session-user` leaf.

This is no text search over an expression and no second fetch: the same parse runs twice over the
same strings. Acceptance check 3 (the fixed point) holds, because a re-read of Nova's emission of
that document runs the same two passes, learns the same slugs from the printed reads, mints the
same UUIDs through the resolver (part 10's `externalKey` is the slug), and binds each read by UUID
both times.

---

## 12. Surfaces

### 12.1 The table page (Project data)

`components/builder/project-data/`:

- `ProjectDataTableListScreen.tsx`: a table with `hq.managedBy === "commcare-hq"` shows the badge
  Copy T1 beside its name.
- `ProjectDataTableScreen.tsx`: above the grid, `ManagedTableBanner.tsx` (new) for a table with
  `hq`. It reads `readManagedLookupTableViewAction` and shows Copy T2 and T3 with the three actions
  (managed in CommCare HQ), or Copy T10 with "Let CommCare HQ manage it again" (managed in Nova).
  Without a connection on that server, Refresh and the hand-back are replaced by Copy T4, a link to
  the CommCare HQ settings.
- `TableActions.tsx`, `ColumnInspectorBody.tsx`, `LookupOrderingSection.tsx` and
  `projectDataInspector.tsx`: for a table managed in CommCare HQ, `useProjectCanEdit` and
  `useCanDelete` are and-ed with "not managed", through one hook `useTableIsEditable(tableId)` in
  `useProjectData.ts`, so no rename, tag, column, row, order, CSV or retype control is offered.
  `projectDataInspector.tsx` is where `canEdit` is read (`useProjectCanEdit`, from
  `lib/session/hooks`) and handed to `RowInspectorBody` and `ColumnInspectorBody` as a prop, so it
  is the file that changes for the two inspectors; `RowInspectorBody.tsx` and `RowConflictBody.tsx`
  keep reading the prop. "Delete table" stays under `useCanDelete`: removing Nova's copy is allowed
  (6.3) and is still held to the reference blockers.
- `useTableIsEditable` reads `hq` from the table's **manifest entry**, which every open builder is
  pushed, and never from the table's snapshot, so it is right the moment a frame lands. The snapshot
  is refetched for the same change, because a change of who manages a table stamps its
  `definition_revision` (section 9).
- A column in `hq.goneColumnIds` shows the header badge Copy T12 and, in its inspector, the apps
  that read it.
- `ManagedTableDialogs.tsx` (new): the two confirmations, built from `@/components/shadcn` like
  `DestructiveChangeDialog.tsx`, with the apps listed as that dialog lists them.

The state model is pure, in `projectDataModel.ts`, and a Vitest holds it:

```ts
/** What a viewer may do with one table, from its manifest entry and their two capabilities. */
export function tableEditability(
	table: Pick<LookupTableManifestEntry, "hq">, canEdit: boolean, canDelete: boolean,
): {
	/** Rename, relabel, add or move a column, every row edit, order, CSV replacement. */
	readonly edit: boolean;
	/** The tag, a column's wire name or type, removing a column. */
	readonly changeSchema: boolean;
	/** Removing Nova's table. Allowed for a managed table too (6.3). */
	readonly deleteTable: boolean;
};
// managed = table.hq?.managedBy === "commcare-hq"
// { edit: canEdit && !managed, changeSchema: canDelete && !managed, deleteTable: canDelete }
```

`useTableIsEditable(tableId)` answers that value for the table's manifest entry, with
`useProjectCanEdit()` and `useCanDelete()` as the two capabilities, and every control of the four
files reads the member that was its capability before.

### 12.2 Organization

`components/builder/app-setup/`:

- `OrganizationSection.tsx`: `ManagedPlacesBanner.tsx` (new) where the organization snapshot holds
  `hq`: Copy O1 and O2, "Refresh from CommCare HQ" and "Open in CommCare HQ"
  (`.../a/<domain>/settings/locations/list/`, the address `setupArtifact.ts` gives). Copy O5
  follows, then Copy O8 where the snapshot's `hq.leftOut` is not empty. Copy O6 (`keptInUse`) is no
  stored fact: the banner shows it from the answer of a refresh pressed in this tab
  (`ManagedPlacesOutcome.refresh`, 11.4) until the tab's next refresh or reload. Without a
  connection on that server, Refresh is replaced by Copy O17, a link to the CommCare HQ settings.
- `PlacesSubsection.tsx`: no add, edit, move or archive control while places are managed.
- `LevelsSubsection.tsx`: Copy O3 above the levels, while places are managed.
- `PersonasSubsection.tsx`: Copy O4 where the app has managed places and no persona.

`lib/organization/types.ts::OrganizationSnapshot` gains `readonly hq?: { readonly server: string;
readonly domain: string; readonly refreshedAt: string; readonly leftOut: Readonly<Record<string,
number>> }` (`hq_server`, `hq_domain`, `hq_refreshed_at` as an ISO string, `hq_left_out`), present
exactly where `hq_server` is not null, which `lib/organization/service.ts::readOrganization` fills
from the state row. It carries no address and no connection: `lib/organization` may not import
`lib/commcare` (`lib/organization/CLAUDE.md`, "Boundaries"), and `readOrganizationAction`
(`lib/organization/actions.ts`) is called straight from the client (`organizationClient.ts`), so
there is no caller in `lib/deployment` to add them. The banner reads them as the table's does,
through a second view of `lib/deployment/managedData.ts`:

```ts
/** What the Organization banner shows of places that came from CommCare HQ. `view`. */
export function readManagedPlacesView(scope: OrganizationScope): Promise<{
	readonly serverLabel: string; readonly hqUrl: string;
	/** Whether the viewer has a CommCare HQ connection on that server. */
	readonly connected: boolean;
} | null>;
```

`readManagedPlacesViewAction(appId)` (`lib/deployment/managedDataActions.ts`, section 9) is its
action; `ManagedPlacesBanner` calls it once when the snapshot holds `hq`. `hqUrl` is
`${COMMCARE_SERVERS[server].baseUrl}/a/${domain}/settings/locations/list/`.

### 12.3 Files

A brought-in file is an ordinary file of the Project. Files shows it under the name of 2.3, the last
segment of its path in CommCare HQ, with its uploader the person who brought the app in. There is no
new control and no new state: a file is in Files only once it is `ready`, which is at creation. The
one string this part adds for Files is the review's line that says the files will be there (Copy
R4), so nobody is surprised by pictures they did not upload.

### 12.4 MCP and the agent

- `getLookupTables` (the SA's tool and MCP's `get_lookup_tables`): each table's result gains
  `managed_in_commcare_hq?: { project_space: string; refreshed_at: string }`, present while CommCare
  HQ manages it. Its description gains: "A table with `managed_in_commcare_hq` is a copy of a table
  that lives in CommCare HQ. Read it freely. Changing it is refused: its rows and columns change in
  CommCare HQ."
- `getOrganization` (and MCP's `get_organization`): the result gains `places_managed_in_commcare_hq?:
  { project_space: string; refreshed_at: string }`, and its description: "When
  `places_managed_in_commcare_hq` is present, the places are a copy of CommCare HQ's. Levels and
  place information can still be changed; places cannot."
- The guide is `lib/agent/authoring/reference.ts::AUTHORING_REFERENCE`. Its `expressions` entry
  holds the paragraph that begins "A form can read a Project data table by its tag", which gains
  one sentence at its end: "A lookup table or a set of places marked managed in CommCare HQ belongs
  to that project space: build on it, and leave changing it to the person."
- `scripts/test-schema.ts` (B9): it imports `getOrganizationTool` beside `createLocationTool` and
  `updateLocationTool` from `lib/agent/tools/organization.ts`, adds the entry `{ name:
  "getOrganization", description: getOrganizationTool.description, schema:
  getOrganizationTool.inputSchema, prompt: "Use getOrganization to read this app's levels and
  places." }` after `getLookupTables`'s, and adds the name to the header's list of known names. B9
  runs nothing billed: B12 sends `getLookupTables` and `getOrganization` in its one run.
- Two MCP tools, served by MCP alone, each with `oauthScopeChallenge(SCOPES.hqWrite)` since both
  change what a later publish may write, registered by B12 over this part's services:

| Tool | Input (strict) | Does |
|---|---|---|
| `refresh_managed_data` | `{ project_id: string, table_id?: string, app_id?: string }`, exactly one of `table_id` and `app_id` | `refreshManagedLookupTable`, or `refreshManagedPlaces` for the app; answers the outcome's sentence |
| `set_lookup_table_management` | `{ project_id: string, table_id: string, managed_by: "nova" \| "commcare-hq", confirmed: boolean }` | with `confirmed: false`, answers what the change does and the apps that read the table, and writes nothing; with `true`, `manageLookupTableInNova` or `letHqManageLookupTable`. A tool never chooses for the person: the description says to show the first answer and ask |

The SA is given neither: a deployment is not authored vocabulary (`lib/deployment/CLAUDE.md`,
"Surfaces").

---

## 13. Findings and the manifest

### 13.1 Manifest entries, by id (B9)

| Entry | Today | From B9 |
|---|---|---|
| `expressions-and-data/media-path-jr-file` | HELD-NEW | HELD, part 01's words (its section 3.5): "the path CommCare HQ holds the file at, kept for the project space the app came from (`app_deployment_media_paths`); every other project space takes Nova's own path", with part 10's sentence on the three re-derived kinds. `subject` and `owner` leave |
| `expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` | HELD-NEW, `valueClass: referenced-path-without-entry` | INERT, `valueClass: path-without-entry-nothing-draws`; `item`: "a media reference with no `multimedia_map` entry on a slot no runtime the app runs on draws without its file: on Android a menu's, a form's, a case list menu item's or the Register action's icon or audio label; in Web Apps every picture, and every sound or video that is not a question's label or help"; `dispositionCell`: "**INERT**: Web Apps resolves a picture's path through the map and shows nothing without an entry (`formplayer/app.js`, the `resourceMap` reply; `multimedia.html`, the `<img>`'s `visible: mediaSrc`); Android's menu list draws no bitmap and hides the audio button (`MenuAdapter.setupImageView`, `setupAudioButton`), and so does the Register action (`EntityActionViewUtils.setupActionImage`, `setupActionAudio`); the reader leaves the reference out and the review lists it". Platforms `not-applicable`; emission `omit`. `subject` and `owner` leave |
| `expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws` | absent | new, REFUSED, `valueClass: path-without-entry-a-runtime-draws`, `subject: media-files`; `item`: "a media reference with no file on a slot a runtime draws: with no `multimedia_map` entry, a question's label or help, a choice or a case list image column in an app that runs on Android, and a question's label or help audio or video in an app that runs in Web Apps"; reason `{ kind: "broken-at-runtime", named: "Android shows its missing-file prompt, an audio button with nothing to play, or the archive icon (`MediaLayout.showMissingMediaView`, `setupStandardAudio`, `EntityView.setupImageLayout`); Web Apps shows a player with nothing to play (`form_entry/multimedia.html` and `help_multimedia.html`: `visible: caption_audio`, `caption_video`, `help_audio`, `help_video`)" }`; `surfaceKeys: ["schema:Application.multimedia_map"]` |
| `expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install` | REFUSED, conditioned on `appSettings.multimediaValidation` | the same entry; in `item` and both cells "with `appSettings.multimediaValidation` on" becomes "where the project space's media check at install is on (`cc-content-valid` other than `yes`, kept at CommCare HQ's value)", and "from step 7, which holds both, the validator refuses the combination" leaves: Nova holds no such setting |

The three classes on `schema:Application.multimedia_map` beside the TARGET-OWNED entry
`application-and-settings/multimedia-map` and the REFUSED entry
`expressions-and-data/multimedia-map-key-not-under-jr-file-that-the-build-keeps` are disjoint by
3.2's first-match order. No lane value-class reader is added: what a slot draws is not in the
export, and part 14's variant on `hq-media` holds the REFUSED class in its `expected.json` (its
section 7.2). The copy needs nothing new: `media-files` has its `fix-in-hq` sentence for
`breaks-when-run` ("A media file here is in a format CommCare can't play, or is missing from
CommCare HQ.").

Every lookup entry of 5.3 keeps its disposition, `subject` (`lookup-tables`) and `owner`
(`project-data-at-hq-size`), as part 01's appendix assigns them. Two are claimed by no reading,
`expressions-and-data/fields-is-indexed` and
`expressions-and-data/absent-field-vs-zero-values-vs-empty-string`: no API-key read shows an indexed
flag, and a field with no value fails the row read (G7). Part 14 exempts both from coverage under
`stated-by-its-part`, with those reasons (its section 7.5).

### 13.2 Circumstances this part needs added to part 01's list

Six facts are about a project space's data, not the app's source, so no manifest entry can name
them (part 01, section 8.3, makes that the test). Each lands in B9, in `READ_CIRCUMSTANCES`,
`CIRCUMSTANCE_STANDINGS` and `CIRCUMSTANCE_COPY` (these are the exact rows, which part 01's
sections 8.3 and 9.3 hold too, with their pull request):

| Code | Standing | Owner | When | `detail.name` | Title | Body | Next |
|---|---|---|---|---|---|---|---|
| `places-over-nova-limit` | not-yet | `project-data-at-hq-size` | the project space has more active places than Nova holds for an app | the count, `"12,400 places"` | This project space has more places than Nova takes | {app} reads places, and {space} has {name}. Nova holds up to 10,000 for an app. | Nothing to change on your side. This will come in once Nova takes larger organizations. |
| `place-not-holdable` | not-yet | `project-data-at-hq-size` | a level's code, a place's site code, name, coordinates, parent or a value the app reads is outside what Nova's organization holds | the level's or the place's name | A place or level is one Nova can't hold yet | {name} in {space} has a code, a name or a value Nova can't hold yet. | Nothing to change on your side. You can check again after Nova's next update. |
| `media-not-played-where-app-runs` | fix-in-hq | | a referenced file's format plays on no platform the rest of the app runs on | the path | A media file doesn't play where this app runs | The app points at {name}, and no platform that can run the rest of this app plays that file's format. | You can replace it in CommCare HQ with a PNG or JPEG picture, an MP3 sound or an H.264 MP4 video, then check again. |
| `table-cell-unrepresentable` | fix-in-hq | | a lookup table the app reads holds, in a field its definition names, a character XML 1.0 cannot carry (`xmlTextIssue`) | `"<tag> (the field <field name>)"` | A lookup table holds a character CommCare can't carry | The lookup table {name} in {space} holds a character CommCare can't carry in a value. | You can take that character out in CommCare HQ, then check again. |
| `owner-rule-needs-one-place` | not-yet | `project-data-at-hq-size` | an owner rule of the app gives a case to the place at a level below the case's current owner, and in the project space that is not exactly one place below every place that owns cases (11.4) | the level's name | An owner rule needs exactly one place | {app} gives a case to the place at the level {name} below its current owner. In {space} that isn't exactly one place everywhere, and Nova holds the rule only where it is. | Nothing to change on your side. You can check again after Nova's next update. |
| `table-choices-unusable` | fix-in-hq | | a question or a search field of the app takes its choices from a lookup table, and that table has no rows, or a row whose value is blank, has white space at an end or repeats another's, or whose label is blank | `"<tag> (the field <field name>)"` | A lookup table's rows can't be a question's choices | A question takes its choices from the lookup table {name} in {space}, and that table has no rows there, or has a row whose value is blank, starts or ends with a space or appears twice, or whose label is blank. | You can change those rows in CommCare HQ, then check again. |

For `table-cell-unrepresentable` and `table-choices-unusable`, `{name}` in the body is the whole
`detail.name`, so the sentence reads "The lookup table regions (the field district_name) in ...".

`table-choices-unusable` is one finding per table, at `{ kind: "lookup-table", tag }`, however many
questions read it and however many of the rules it fails (14.1). `<field name>` is the wire name of
the column the first error of that table names, in the order
`lib/commcare/lookup/selectSourceRows.ts::lookupSelectSourceRowFindings` returns them: the error's
`details.columnId`, or, for `LOOKUP_SELECT_SOURCE_EMPTY`, which names no column, the value column
of the question or search field that reads the table.

### 13.3 Every finding this part raises

| Where | Finding | Standing |
|---|---|---|
| 2.1 | `multimedia-map-key-not-under-jr-file-that-the-build-keeps` | fix-in-hq |
| 2.1, 2.4, 5.3 | `unrecognized` (a slot naming a file of no media kind; a slot naming a file of another kind, but for an audio slot naming a video; bytes of another kind than CommCare HQ filed them as; a refused format no entry names; a tag or a field name that fails the lookup grammar in a way N4, N5 and N24 do not name; two fields of one table whose names are equal) | not-yet |
| 2.1 | `audio-m4a-with-another-brand-isom-mp41-mp42-dash` (an audio slot naming a file CommCare HQ files as video) | fix-in-hq |
| 2.4 | `an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app` (a file; 4.3: the app) | not-yet |
| 2.4 | `image-svg`, `image-tiff-heif`, `audio-wav-that-is-not-8-or-16-bit-pcm`, `audio-m4a-with-another-brand-isom-mp41-mp42-dash` (the guard row), `audio-3gp`, `video-av1-mov-avi-ogg-theora-h-263-3gp` | fix-in-hq |
| 2.4 | `media-not-played-where-app-runs` | fix-in-hq |
| 3.2 | `a-media-reference-with-no-file-on-a-slot-android-s-install`, `a-media-reference-with-no-file-on-a-slot-a-runtime-draws` | fix-in-hq |
| 3.2 | `media-file-unreadable` | fix-in-hq |
| 5.3 | the three lookup content entries (5.3's first four rows: `fields-properties-and-multi-valued-cells-name-lang-en-name-name` twice, `item-attributes-and-per-row-attribute-values`, `is-global-false-row-owners-user-group-location`), the caps entry, `tag-types`, part 04's N4, N5, N24 | not-yet |
| 5.3 | `tag-containing-casedb-or-ledgerdb` | fix-in-hq |
| 5.3 | `table-rows-unreadable`, `table-cell-unrepresentable`, `table-choices-unusable` | fix-in-hq |
| 5.3 | the caps entry at the app (the tables together over what one `.ccz` carries) | not-yet |
| 5.1 | part 08's `an-expression-core-cannot-evaluate-as-its-author-meant` (a select reads a table CommCare HQ does not have) | fix-in-hq |
| 7.2 | `table-differs-in-project`: raised by part 12, only when creation is asked for with a choice unanswered; it ends no read | stop |
| 11.1 | whatever `hqReadCircumstance` gives for a failed level or place read, `cannot-read-organization` among them | stop |
| 11.2, 11.4 | `place-not-holdable`, `places-over-nova-limit`, `owner-rule-needs-one-place` | not-yet |

An entry id in this table, in "Written and not yet run" and in "Decisions in brief" is written
without its area where the section it cites gives it whole: each is under `expressions-and-data/`.

Every one is reported in the pass that finds it, with every other: `planHqMedia`,
`lookupTableFindings` and `planManagedPlaces` return lists and never stop at the first.

---

## 14. The surface the reading and the reader call

Sections 2 to 11 define this part's functions one at a time. This section is the one surface the
reading (part 12, B10) and acceptance (part 09, B7) call: each function below is composed from the
ones above, which stay as its parts and keep their tests. Part 12 calls these names (its sections
3.3, 3.4, 5.1, 6.1 and 6.3); where a signature could as well have been cut another way, the shape
taken and its reason are said. B9 lands beneath B7 and B10 (stack B's order is B8, B9, B7, B10), so
nothing here imports a file of either.

The files, all new and all under `lib/deployment/reading/projectData/`:

| File | Holds |
|---|---|
| `index.ts` | 14.1 but for the review and the read: `ReadingProjectData`, `ReaderProjectDataReads`, `projectDataReadsOf`, `readingProjectDataFindingsFor`, `readingProjectDataWrite`, `ReadingProjectDataWrite`, `resolveTableChoices`. Pure |
| `read.ts` | `readReadingProjectData` (14.1), the one function of 14.1 that reads CommCare HQ and Postgres |
| `reviewTypes.ts` | the types the review's answers carry, with their schemas. Client-safe: its only run-time import is `zod` |
| `review.ts` | `projectDataReview`. Pure |
| `media.ts` | sections 2 to 4, 14.2, and `readingMediaRows` (14.3), less the four functions of `mediaStore.ts`. Pure |
| `mediaStore.ts` | `fetchAndStageHqMediaFile` (2.2), `stageReadingMedia`, `publishReadingMedia`, `discardReadingMedia` (14.2) |
| `lookupTables.ts` | sections 5 and 7, and `readingLookupSnapshot` (14.3), less the functions of `lookupTableStore.ts`. Pure |
| `lookupTableStore.ts` | `readHqLookupTablesForReading` (5.1), `writeBroughtInLookupTablesInTransaction` and `BroughtInTableChangedError` (7.4) |
| `places.ts` | section 11 but for the two functions of `lib/commcare/reader/worldEntities.ts` and the one of `placeStore.ts`. Pure |
| `placeStore.ts` | `writeBroughtInPlacesInTransaction` (11.4) |
| `settlements.ts` | `HandOffSettlement`, `handOffSettlements` (14.3). Pure |

**Pure files and store files.** Part 12 runs the reader, this part's verdicts and acceptance in a
worker thread, and that worker's bundle holds only what computes (its section 3.6): its build
throws where the bundle's inputs hold a path under `lib/db/`, `lib/case-store/`, `lib/storage/` or
`lib/auth/`, `lib/logger.ts`, or anything of `pg`, `@google-cloud/*`, `@sentry/*` or `next`. So no
file the check imports may import one of those at run time, and a file of this part that would
have held both kinds of function is two files. The pure file keeps the name the other parts cite.
The functions that read CommCare HQ, Postgres or the bucket are in the file beside it. A store
file imports its pure sibling; a pure file takes of a store file its types alone, with `import
type`. Beneath this directory two more files are cut the same way, because a pure file here
imports them at run time:

| Pure file | Store file | Which holds what |
|---|---|---|
| `lib/lookup/managedRules.ts` | `lib/lookup/managed.ts` | pure: `LookupRowsMeasure`, `lookupCapExcess`, `ManagedLookupContent`, `managedCanonicalSchema`. Store: `mintLookupIds`, `measureLookupRows`, `ManagedOriginWrite`, the create and refresh arms and `ManagedRefreshReceipt` |
| `lib/media/stagedMediaFile.ts` | `lib/media/stagedMedia.ts` | pure: `StagedMediaFile`, `stagedMediaFileSchema`. Store: `stageMediaBytes`, `publishStagedMedia`, `PublishedStagedMedia`, `STAGED_MEDIA_PUBLISH_CONCURRENCY` |

The build is the judge of the cut, in B10 where the worker is first built: a file it names that
this section does not is cut by the same rule in that pull request, its exports that import a
refused module moving to a file beside it whose name ends `Store`. Part 14's reader bundle is the
lane's own and holds both kinds (its 5.2); the rule is the worker's alone.

`reviewTypes.ts`, whole. Part 12's `lib/deployment/reading/types.ts` re-exports `ReviewTable` and
`ReviewPlaces` from it (its section 5.1), and part 13 draws them:

```ts
import { z } from "zod";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupReferencingAppSummary } from "@/lib/lookup/types";

export const LOOKUP_TABLE_CHOICES = ["use-commcare-hq", "use-project"] as const;
export type LookupTableChoice = (typeof LOOKUP_TABLE_CHOICES)[number];
export type LookupChoiceOffer = /* as section 7 writes it */;

/** JSON, equal for equal CommCare HQ content and equal Project revisions. */
export interface ReviewTable {
	readonly tag: string;
	/** `LookupTableStanding["kind"]` (section 7). */
	readonly standing: "new" | "same-managed" | "same-equal" | "choice";
	/** `HqLookupTableRead.canonical`'s digest: CommCare HQ's columns and rows. */
	readonly hqDigest: string;
	/** The Project table it met, at the revisions the read saw; null for `new`. */
	readonly projectTable: {
		readonly tableId: LookupTableId;
		readonly definitionRevision: string;
		readonly rowsRevision: string;
	} | null;
	/** For `choice`: what differs, who reads the Project's table, and each answer's offer. */
	readonly choice: {
		readonly differs: readonly ("columns" | "rows")[];
		readonly apps: readonly LookupReferencingAppSummary[];
		readonly options: Readonly<Record<LookupTableChoice, LookupChoiceOffer>>;
	} | null;
}
export interface ReviewPlaces {
	readonly count: number;
	/** `ManagedPlacePlan.digest` (11.4). */
	readonly digest: string;
}

export const lookupChoiceOfferSchema: z.ZodType<LookupChoiceOffer> = z.discriminatedUnion("offered", [
	z.strictObject({ offered: z.literal(true),
		goneColumns: z.array(z.string()).readonly(), retypedColumns: z.array(z.string()).readonly() }),
	z.strictObject({ offered: z.literal(false),
		why: z.enum(["needs-admin", "managed-elsewhere", "app-reads-a-missing-column",
			"fails-a-project-space-rule"]),
		name: z.string().nullable() }),
]);
export const reviewTableSchema: z.ZodType<ReviewTable> = z.strictObject({
	tag: z.string().min(1),
	standing: z.enum(["new", "same-managed", "same-equal", "choice"]),
	hqDigest: z.string().regex(/^[0-9a-f]{64}$/),
	projectTable: z.strictObject({
		// A lookup table id. Typed by the cast below: this module imports no schema of `lib/lookup`.
		tableId: z.string().min(1),
		definitionRevision: z.string().regex(/^[0-9]+$/),
		rowsRevision: z.string().regex(/^[0-9]+$/),
	}).nullable(),
	choice: z.strictObject({
		differs: z.array(z.enum(["columns", "rows"])).readonly(),
		apps: z.array(z.strictObject({
			appId: z.string().min(1), appName: z.string(), deleted: z.boolean() })).readonly(),
		options: z.strictObject({
			"use-commcare-hq": lookupChoiceOfferSchema, "use-project": lookupChoiceOfferSchema }),
	}).nullable(),
}) as unknown as z.ZodType<ReviewTable>;
export const reviewPlacesSchema: z.ZodType<ReviewPlaces> = z.strictObject({
	count: z.number().int().min(0),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
});
```

The two revisions are `LookupTableRevisions`' `definitionRevision` and `rowsRevision` as decimal
text, the optimistic tokens every lookup writer advances, so a Project table edited in Nova since
the review moves one of them. `standing` is `choice` exactly where `choice` is not null, and
`projectTable` is null exactly for `new`.

### 14.1 Tables, levels and places

```ts
export interface ReadingProjectData {
	/** Part 06's catalog over the bindings (5.5). */
	readonly lookups: ReaderLookupCatalog;
	/** Part 06's `ReaderOrganization`: `{ levelCodes, levels }`, both empty where no place was read. */
	readonly organization: ReaderOrganization;
	/** The input's ids with any new ones added, never one replaced (5.5). */
	readonly minted: PredeclaredLookupIds;
	/** Whether the levels and places were read (11.1). */
	readonly placesRead: boolean;
	/** Everything read and decided, for the functions below. Held in memory, never stored. */
	readonly gathered: {
		readonly origin: { readonly server: string; readonly domain: string };
		readonly tables: readonly { readonly read: HqLookupTableRead;
			/** 5.3's findings for this table, raised only if the reader reads it. */
			readonly findings: readonly Finding[];
			/** Null where the table cannot come in. */
			readonly standing: LookupTableStanding | null;
			readonly binding: LookupTableBinding | null;
			/** The Project table the tag met, at the revisions step 3 read; null where none. */
			readonly projectTable: { readonly tableId: LookupTableId;
				readonly definitionRevision: string; readonly rowsRevision: string } | null }[];
		/** Step 3's Project read: the Project, its revision, and the rows of each Project table a
		 *  candidate's tag met, by table id. `readingLookupSnapshot` reads them (14.3). */
		readonly project: { readonly projectId: string; readonly projectRevision: LookupRevision;
			readonly rowsByTable: Readonly<Record<string, readonly LookupFixtureRow[]>> };
		/** Tags of CommCare HQ's list, to tell a table that is not there from one Nova cannot hold. */
		readonly hqTags: readonly string[];
		readonly hqLevels: readonly HqLocationType[];
		readonly hqPlaces: readonly HqLocation[];
	};
}

export function readReadingProjectData(input: {
	readonly creds: CommCareCredentials; readonly server: string; readonly domain: string;
	readonly projectId: string; readonly actorUserId: string;
	/** The reading's id, which the app takes: the sibling read's app id (10.1). */
	readonly readingId: string;
	readonly source: HqAppSource;
	readonly minted: PredeclaredLookupIds;
	/** `lib/lookup/managed.ts::mintLookupIds` in production; a test's own. */
	readonly mintIds: (count: number) => Promise<readonly string[]>;
	/** Null at a read step. At creation, the answers `resolveTableChoices` accepted. */
	readonly choices: Readonly<Record<string, LookupTableChoice>> | null;
	/** `always` is 11.1's backstop. */
	readonly places: "when-source-reads" | "always";
	readonly within: HqReadDeadline; // one HQ_PROJECT_DATA_READING_DEADLINE_MS, part 05
}): Promise<
	| { readonly kind: "read"; readonly data: ReadingProjectData }
	| { readonly kind: "failed"; readonly failure: HqFailure }>;
```

In order:

1. `readHqLookupTablesForReading` (5.1, steps 1 to 3). A returned error is `failed`, classified as
   5.1 says. A table's `rows-unreadable` is no failure: it is that table's finding.
2. Ids for every candidate table and field that has none in `minted` (5.5).
3. The Project's side, each a read that exists: `getAllLookupDefinitions(scope)` for the tables
   whose tag is a candidate's; `getLookupFixtureData(scope, ids)` for those tables' rows, one
   snapshot, whose `projectRevision` and rows `gathered.project` keeps; the apps that reference
   each (the summaries `lib/lookup` gives a blocked removal); `readSiblingLookupMappings` (10.1);
   and the actor's role. They are separate statements, and need not be one snapshot: the review's
   digest covers each Project table (`ReviewTable.projectTable`, its two revisions), and the birth
   derives every standing again under the Project's lock (7.4).
4. Per candidate: where its rows were read and each holds one string a field,
   `measureLookupRows` over them keyed by the column ids of step 2 (`measured` is null
   otherwise); then `lookupTableFindings` (5.3). Where there are none, `lookupTableStanding` (7)
   and then `resolveLookupBindings` with `choices` (7.4). A standing's kind does not depend on
   which fields the app reads, so this step passes `appReads: []`; a choice's offers do, and
   `projectDataReview` computes the standing again with the fields the reader read.
5. `readerLookupCatalog` over the bindings.
6. Where `places` is `always` or `sourceMayReadPlaces` is true of the source's text:
   `listHqLocationTypes`, then `listHqLocations`. A returned error is `failed`, classified as 11.1
   says. Where a place names a level code the level list lacks, the two reads straddled a change
   in CommCare HQ: both are read once more, and where the second pair disagrees too the answer is
   `failed` with `{ kind: "hq-unavailable", request: "locations", status: 200 }`, which part 12
   stops the read with as it does any failed read. `organization.levels` is `hqLevels` and
   `organization.levelCodes` their codes in that order.

What the reader read is not known until it has run, and every finding, review entry and write of
project data depends on it: a table matters only if the app reads it, and levels and places only if
the app reads places. So `ReadingProjectData` carries no `findings`, `review` or `write` member;
they are three pure functions of the data and of what the reader read.

```ts
/** What the reader read of project data. */
export interface ReaderProjectDataReads {
	/** Field names read, by the tag of each table the document binds. */
	readonly lookupFields: Readonly<Record<string, readonly string[]>>;
	/** Tags read that the catalog does not hold (`ReadFacts.unreadTables`). */
	readonly unreadTables: readonly string[];
	readonly readsPlaces: boolean;
}
export function projectDataReadsOf(data: ReadingProjectData, outcome: ReadOutcome): ReaderProjectDataReads;

/** Every finding of project data for this read. `doc` is null where the reader gave an account. */
export function readingProjectDataFindingsFor(
	data: ReadingProjectData, reads: ReaderProjectDataReads,
	doc: BlueprintDoc | null, resolver: IdentityResolver,
): readonly Finding[];

/** `review.ts`. `ReviewTable` and `ReviewPlaces` are `reviewTypes.ts`'s, above. */
export function projectDataReview(
	data: ReadingProjectData, reads: ReaderProjectDataReads,
	doc: BlueprintDoc, resolver: IdentityResolver,
): { readonly tables: readonly ReviewTable[]; readonly places: ReviewPlaces | null };

export interface ReadingProjectDataWrite {
	readonly origin: { readonly server: string; readonly domain: string };
	readonly tables: readonly BroughtInTableWrite[]; // 7.4
	readonly places: ManagedPlacePlan | null;        // 11.4
}
export function readingProjectDataWrite(
	data: ReadingProjectData, reads: ReaderProjectDataReads,
	doc: BlueprintDoc, resolver: IdentityResolver,
): ReadingProjectDataWrite;

/** Which review tables need an answer, and whether the answers given can be taken. */
export function resolveTableChoices(
	tables: readonly ReviewTable[], answers: Readonly<Record<string, string>>,
): | { readonly ok: true; readonly choices: Readonly<Record<string, LookupTableChoice>> }
   | { readonly ok: false; readonly missing: readonly string[];
       readonly notOffered: readonly string[]; readonly unknown: readonly string[] };
```

- **`projectDataReadsOf`.** For a `read` outcome: `lookupFields` from
  `extractLookupReferenceTargets(draft.doc).columnTargets` through the bindings, `unreadTables` the
  distinct tags of `draft.facts.unreadTables`, `readsPlaces` from `documentReadsPlaces(draft.doc)`.
  For an `account` there is no document, and the outcome carries the last two itself (part 06,
  section 2.2): `unreadTables` is the distinct tags of the account arm's `UnreadTable[]`,
  `readsPlaces` its `readsLocations`, and `lookupFields` is empty. So a table Nova cannot hold and a
  place it cannot hold are in the same account as the app's other findings.
- **`readingProjectDataFindingsFor`.** For each tag of `lookupFields` and `unreadTables`: that table's
  `findings`; or, where `hqTags` lacks the tag, 5.1's step 5. Then, over `readingLookupSnapshot(data,
  reads)` (14.3): `table-cell-unrepresentable` for a table of the snapshot that holds such a cell (5.3),
  and `lookupFixtureBudgetFinding` (5.3). With a document, one `table-choices-unusable` finding per
  table, at `{ kind: "lookup-table", tag }`, from
  `lib/commcare/lookup/selectSourceRows.ts::lookupSelectSourceRowFindings(doc,
  readingLookupSnapshot(data, reads))` (13.2 says which field it names). Where `readsPlaces`: the
  findings of `levelsFromHq(hqLevels, resolver)` and of `planManagedPlaces` in `birth` mode over those
  levels and the document's location properties (none where `doc` is null, so a value is judged once the
  rest of the app can come in), and, with a document, `managedPlacesOwnerFindings` (11.4). The resolver
  is part 10's `mintingResolver(appId)` with `appId` the reading's id, which the app takes (part 12
  builds it as `mintingResolver(row.id)`, its 3.3 step 7, and hands the reader the same id as
  `ReaderInput.appId`), so the level UUIDs are the ones the reader's document holds. A resolver answers a
  key once (part 10, 2.3) and `levelsFromHq` claims every level's key, so each of the three functions
  here that take `resolver` is handed one of its own, built the same way; a resolver shared between two
  of them would answer the second `ok: false`. No other function raises a finding of `levelsFromHq`: the
  reader's structure stage calls it for the levels alone (11.2).
- **`projectDataReview`** and **`readingProjectDataWrite`** cover the tables of `lookupFields` and,
  where `readsPlaces`, the places. A `ReviewTable` carries CommCare HQ's digest (`hqDigest`,
  `HqLookupTableRead.canonical.digest`) and, copied from `gathered.tables[i].projectTable`, the two
  revisions of the Project table its tag met; the `ReviewPlaces` carries the count of the plan's
  places and `ManagedPlacePlan.digest`. That is what part 12's review digest needs of them (its
  section 5.2): a row edited in CommCare HQ, or a Project table edited in Nova, since the review
  changes the digest. `choice` holds the standing's `differs`, `apps` and `options`, computed with
  the fields the reader read (step 4).
- **`resolveTableChoices`.** `missing`: a `choice` table with no answer. `unknown`: an answer for a
  tag that holds no choice, or a value outside `LOOKUP_TABLE_CHOICES`. `notOffered`: an answer whose
  offer is `offered: false`. Part 12's `bringInInputSchema.tableChoices` is this `answers`.

**The shape of these calls, decided where another was weighed**: `mintLookupIds` lives in
`lib/lookup/managed.ts` alone (5.5); `minted` is `PredeclaredLookupIds`, a record by tag, and not an
array; `findings`, `review` and `write` are the three functions above, and not members of
`ReadingProjectData`; `choices`, `places`, `server`, `actorUserId` and `readingId` are in the input;
step 3 reads the Project's side itself, so part 12 asks `lib/lookup` for no reader of its own; and
the two birth writers take `(tx, scope, write)` with `write` holding `origin` and `at` (7.4, 11.4),
since each stamps both on what it writes.

**Which form of Copy R7 the review draws**, from a `ReviewTable` alone: where `choice.differs` is
not empty, the first; where it is empty and `choice.options["use-commcare-hq"]` is `{ offered:
false, why: "managed-elsewhere" }`, the third, `{otherDomain}` being that offer's `name`; otherwise
the second, without its last sentence where `choice.options["use-project"]` is `{ offered: false,
why: "fails-a-project-space-rule" }`: an app of the Project may publish that table there already
(7.1), and the choice is not open.

### 14.2 Media

```ts
/** `lib/deployment/reading/projectData/media.ts`. What the reading's `media` column holds. */
export interface ReadingMediaPlan {
	/** One per file the document references, in `key` order. No reference and no place is stored. */
	readonly files: readonly { readonly key: string; readonly mediaType: HqMediaFile["mediaType"];
		readonly multimediaId: string; readonly kind: MediaKind; readonly paths: readonly string[];
		/** The asset id reserved for the file when it was first planned. Never replaced. */
		readonly reservedId: MediaAssetId }[];
	readonly verdicts: Readonly<Record<string, HqMediaVerdict>>;
	/** By file key: what creation has published, written to the row at each recorded step. */
	readonly published: Readonly<Record<string, PublishedReadingFile>>;
}
/**
 * A `z.strictObject` of the three members: `files` an array of strict objects (`mediaType` a
 * `z.enum` of `CommCareImage`, `CommCareAudio` and `CommCareVideo`, `kind` `z.enum(MEDIA_KINDS)`,
 * `reservedId` `mediaAssetIdSchema`), `verdicts` `z.record(z.string(), hqMediaVerdictSchema)`,
 * and `published` `z.record(z.string(), publishedReadingFileSchema)`.
 */
export const readingMediaPlanSchema: z.ZodType<ReadingMediaPlan>;
/** How a reading reserves an id: part 12's `provisionalReadingMediaId`, bound to the reading. */
export type ReserveMediaId = (mediaType: HqMediaType, multimediaId: string) => MediaAssetId;

export function readingMediaIndex(input: {
	readonly source: HqAppSource; readonly plan: ReadingMediaPlan | null;
	readonly reserve: ReserveMediaId;
}): ReaderMediaIndex;

export function planReadingMedia(input: {
	readonly source: HqAppSource; readonly references: readonly HqMediaReference[];
	/** The platforms of the declaration the draft proposes (`planHqMedia`'s `runsOn`, 2.1). */
	readonly runsOn: readonly Platform[]; readonly previous: ReadingMediaPlan | null;
	readonly reserve: ReserveMediaId;
}): { readonly plan: ReadingMediaPlan; readonly media: HqMediaPlan };

export function readingMediaFindings(input: {
	readonly media: HqMediaPlan; readonly plan: ReadingMediaPlan;
	/** Every platform some declaration choice of the draft declares (`mediaFindings`' `runsOn`,
	 *  2.4). */
	readonly runsOn: readonly Platform[];
}): { readonly findings: readonly Finding[]; readonly playsOn: readonly Platform[];
      readonly complete: boolean };

export function stageReadingMedia(input: {
	readonly readingId: string; readonly projectId: string; readonly actorUserId: string;
	readonly creds: CommCareCredentials; readonly plan: ReadingMediaPlan;
	readonly maxFiles: number; readonly signal: AbortSignal;
}): Promise<
	| { readonly kind: "staged"; readonly plan: ReadingMediaPlan }
	| { readonly kind: "failed"; readonly plan: ReadingMediaPlan; readonly failure: HqFailure }>;

export function mergeReadingMediaPlans(theirs: ReadingMediaPlan, mine: ReadingMediaPlan): ReadingMediaPlan;

export interface PublishedReadingFile {
	readonly mediaType: HqMediaType; readonly multimediaId: string;
	readonly assetId: MediaAssetId; readonly contentHash: string; readonly extension: string;
	readonly hqPaths: readonly string[];
}
/** A `z.strictObject` of exactly those members; `assetId` by `mediaAssetIdSchema`. */
export const publishedReadingFileSchema: z.ZodType<PublishedReadingFile>;
export function stagedReadingFiles(plan: ReadingMediaPlan): readonly PublishedReadingFile[];

export function publishReadingMedia(input: {
	readonly readingId: string; readonly projectId: string; readonly actorUserId: string;
	readonly creds: CommCareCredentials; readonly plan: ReadingMediaPlan;
	readonly deadlineAt: number;
}): Promise<
	/** Each `plan` is the input's with this call's publications added to `published`. */
	| { readonly kind: "more"; readonly plan: ReadingMediaPlan;
	    readonly done: number; readonly total: number }
	| { readonly kind: "published"; readonly plan: ReadingMediaPlan;
	    readonly files: readonly PublishedReadingFile[] }
	/** A lapsed file is gone from CommCare HQ or holds other bytes: its verdict is dropped. */
	| { readonly kind: "refetch"; readonly plan: ReadingMediaPlan }
	| { readonly kind: "failed"; readonly failure: HqFailure }>;

export function discardReadingMedia(input: {
	readonly projectId: string; readonly plan: ReadingMediaPlan;
}): Promise<void>;
```

| Function | Is |
|---|---|
| `readingMediaIndex` | part 06's index, by 2.1's rows: a path with no entry is `no-entry`; an entry with a null id, an `unreadable` entry, an entry of type `CommCareMultimedia` and a file whose verdict is `missing` are `unreadable`; any other entry is `asset`, `mediaKind` the entry's kind, `assetId` the published file's where `plan.published` holds the file's key, else the plan's `reservedId`, else `reserve(...)`. So before any byte is fetched every path the map holds has the id it will keep until publication, and at creation the index is built from the row's own plan with no second input |
| `planReadingMedia` | `planHqMedia` (2.1), then the stored plan: a file `previous` holds keeps its `reservedId`, its verdict and its `published` entry; a new file takes `reserve(...)`; a file the document no longer references leaves, with its verdict and its `published` entry |
| `readingMediaFindings` | `media.findings`, then `mediaFindings` (2.4) and `mediaBudgetFinding` (4.3) |
| `stageReadingMedia` | for at most `maxFiles` files with no verdict, `HQ_MEDIA_READ_CONCURRENCY` at a time: `fetchAndStageHqMediaFile` (2.2) with `stagingId` the file's `reservedId`, each verdict added to the plan. The first returned error stops the step: the plan reached so far and `classifyHqFailure(error, "media-file")` are `failed` |
| `mergeReadingMediaPlans` | `theirs`, with each verdict and each `published` entry of `mine` for a key `theirs` lacks, so a `published` entry from either side is kept. Two verdicts of one key are equal: one `multimedia_id` is one file's bytes, judged by one function, and both `held` facts name the same `stagingId` and content hash. Two `published` entries of one key are equal too: publication finds a file by Project and hash |
| `stagedReadingFiles` | one `PublishedReadingFile` per file whose verdict is `held`, `assetId` its `stagingId`: the files as a read step knows them |
| `publishReadingMedia` | it skips every file `plan.published` holds. Until `deadlineAt`: `publishStagedMedia` (4.1) over the other held files. For each `lapsed` file: `readHqMediaFile` with `creds`, `validateSniffedMediaBytes`, and, where the content hash is the staged one, `publishReadyMedia` from memory with `assetId: staged.stagingId`. A `missing` answer, a refusal or another hash drops that file's verdict, and the answer is `refetch` with the plan less those verdicts (and with this call's publications), which part 12 writes; the row stays `ready` and a creation step fetches the dropped files with `stageReadingMedia`. A returned error is `failed`, and what the call published before it is found again by Project and hash on the next call. `more` where the deadline came first, with `done` the count of `plan.published` and `total` the count of held files. `published` where every held file is in `plan.published`, `files` being its entries in key order. Each answer's `plan` carries the publications of the call, and part 12 writes it at the row's revision: publication deletes each pending object (4.1), so the row is the one record that a file needs no second fetch. It writes nothing to the reading's row itself |
| `discardReadingMedia` | best effort `deleteAsset` of each held file's pending key (`pendingGcsObjectKeyFor(projectId, stagingId, extension)`). It deletes nothing a ready row names: a ready file's key is `projects/...`, never `pending/...`. What it misses the bucket's rule deletes within a day |

`media_total` is `plan.files.length` and `media_done` the count of files with a verdict.

**The shape of these calls, decided where another was weighed.** A staged file has no `media_assets`
row (2.5), so the id a staged file is known by is its `reservedId`, the same id before and after
staging; staged bytes live one day from the moment they are staged, and using them does not extend
it, and the verdicts live as long as the reading.
`planReadingMedia` takes the reader's references, not the document: a document holds asset ids and
no path, and a reference with no file is in no document at all. `readingMediaFindings` takes the
`HqMediaPlan` of this read, because the stored plan holds no place to put a finding at.
`readingMediaIndex` and `planReadingMedia` take `reserve`, so B9 imports nothing of B10's
`mediaIds.ts`. `publishReadingMedia` answers `refetch`, so a file that changed in CommCare HQ since
it was judged is judged again by `stageReadingMedia` and never by the publisher.
`discardReadingMedia` takes the Project, by which pending keys are named.

**Part 12's decision, held here** (its Departure 14): publication is recorded on the row.
`publishStagedMedia` deletes each pending object it publishes, so a creation that runs in more than
one step could not tell a published file from a lapsed one by the bucket. `ReadingMediaPlan`
therefore holds `published`, each answer of `publishReadingMedia` hands the plan back with the
call's publications, and part 12 writes it at each recorded step.

**The declaration.** `readingMediaFindings().playsOn` is the platforms every held file plays on.
Part 06's `DeclarationChoices` (its section 16.3) are narrowed by it in one place,
`narrowDeclarationsByMedia(choices: DeclarationChoices, playsOn: readonly Platform[]):
DeclarationChoices` (this file). A `kind: "none"` input is returned as it is. Of a `kind: "choices"`
input, a choice that declares a platform outside `playsOn` leaves; the proposal stays where its
choice remains and otherwise moves to the first choice left in the same order; where a choice is
left the result is `kind: "choices"`, with `proposed` the index of that choice among those left and
`narrowedByHq` and `keepsWebApps` as they were. Where none is left the result is `{ kind: "none",
blocking: [] }`, which no caller meets: `playsOn` is then empty, `readingMediaFindings` has raised
`media-not-played-where-app-runs` (2.4), the read is an account, and acceptance, which takes the
`choices` arm alone (part 09, section 2.2), is not called.

### 14.3 What acceptance reads

Part 09 (B7) lands above B9 and imports three pure exports of it. None imports a type of B7.

```ts
/** `lib/deployment/reading/projectData/settlements.ts` (new). */
export interface HandOffSettlement {
	readonly artifact: string;
	readonly where: string;
	readonly key: string;
	readonly by: "inert-claim" | "finding";
}
/** One settlement per hand-off this part judged, with that hand-off's own `artifact`, `where`
 *  and `key`. Pure. */
export function handOffSettlements(
	handOffs: readonly HandOffRecord[], media: HqMediaPlan, findings: readonly Finding[],
): readonly HandOffSettlement[];

/** `lib/deployment/reading/projectData/lookupTables.ts`. Pure. */
export function readingLookupSnapshot(
	data: ReadingProjectData, reads: ReaderProjectDataReads,
): LookupFixtureDataSnapshot; // lib/lookup/types.ts

/** `lib/deployment/reading/projectData/media.ts`. Pure. */
export function readingMediaRows(
	plan: ReadingMediaPlan,
): Parameters<typeof exportReadinessFindings>[2];
```

- **`handOffSettlements`.** `handOffs` is the claim log's (`ClaimLog.handOffs`, part 06, section
  4.5), `media` the `HqMediaPlan` of this read, and `findings` the findings of
  `readingMediaFindings` and `readingProjectDataFindingsFor` for it. A hand-off is settled by its
  `subject`, the media path or the table's tag. `inert-claim`: `HqMediaPlan.claims` holds a
  reference of that path. `finding`: a finding of this part names it, at `{ kind: "media", path }`
  for a path or `{ kind: "lookup-table", tag }` for a tag, or at the reference's own place with the
  path as its `detail.name` (2.1; 3.2, rows 1 and 2). A path that is both gets one settlement,
  `finding`.
  A hand-off neither settles gets none, and part 09's check 1 words what is left (its section 3).
- **`readingLookupSnapshot`.** `definitions`: one per table the document reads (the tags of
  `reads.lookupFields`), under its binding's ids, in tag order. A table that comes in as CommCare
  HQ's (`new`, `same-managed`, the answer `use-commcare-hq`, and a `choice` with no answer yet) is
  the definition `readerLookupCatalog` gives it (5.5), named by its tag, with `rowsByTable` its
  rows in CommCare HQ's order, each cell under its column's id. A table bound to a Project table as
  it stands (`same-equal`, the answer `use-project`) is that table's own definition, with the
  Project's rows from `gathered.project.rowsByTable`. `projectId` is the reading's Project and
  `projectRevision` the revision step 3 read with `getLookupFixtureData`, both from
  `gathered.project`. A row's `id` is the Project row's own, or, for a row of CommCare HQ's,
  CommCare HQ's id for it (`HqFixtureRow.id`, cast to `LookupRowId`): no document names a row, and
  the id is read only as an example in a finding's details.
- **`readingMediaRows`.** The media rows `exportReadinessFindings` takes as its third argument
  (`lib/doc/commitVerdicts.ts`: a `ReadonlyMap<string, MediaAssetRecord>` by asset id), from the
  held files' verdicts: one entry per file whose verdict is `held`, keyed by the id the document
  names it by (`plan.published[key].assetId` where the file is published, else its `reservedId`).
  Each record takes `contentHash`, `mimeType`, `extension`, `sizeBytes`, `dimensions`,
  `durationMs`, `mediaFormat`, `kind` and `originalFilename` from the verdict's `StagedMediaFile`,
  `status: "ready"`, and `created_at` from `stagedAt`. `project_id`, `owner` and `gcsObjectKey` are
  the empty string: the plan names no Project, and the gate's media rules read `status`, `kind`,
  `mimeType`, `mediaFormat` and `sizeBytes` alone (`lib/commcare/validator/rules/media/`,
  `lib/media/exportBudget.ts`). The map is acceptance's input and is never stored.

---

## Copy

Every string is exported from `lib/publish/managedData.ts` (new, client-safe, no run-time import),
so the builder, MCP and the docs read one text. `{date}` is a day in the reader's locale, in every
string but the HQ app file's guide (G1), which is made on the server for no one reader and spells
the UTC day (8.3).

**The table page.**

| Id | Where | Text |
|---|---|---|
| T1 | badge | Managed in CommCare HQ |
| T2 | banner | This table lives in {domain} on CommCare HQ. Nova keeps a copy so your apps and Preview can read it, and never changes it there. |
| T3 | banner | You can change it on CommCare HQ's Lookup Tables page, then refresh. Nova's copy was refreshed on {date}. |
| | buttons | Refresh from CommCare HQ · Open in CommCare HQ · Manage in Nova |
| T4 | no connection | Connect CommCare HQ to refresh this table |
| T5 | refresh, table gone | CommCare HQ no longer has a lookup table named {tag} in {domain}. Nova kept its copy as it was. You can make the table again in CommCare HQ, or choose Manage in Nova to publish this copy there. |
| T6 | refresh, unsupported | This table now holds {holds} in CommCare HQ, which Nova can't hold yet. Nova kept its copy as it was. |
| T7 | refresh, over a cap | This table now has {phrase} in CommCare HQ. Nova kept its copy as it was. |
| T8 | every refused write (`managedLookupTableRefusal`) | The lookup table {name} is managed in CommCare HQ ({domain}), so Nova can't change it here. You can change it in CommCare HQ and refresh Nova's copy, or choose Manage in Nova on the table's page. |
| T9 | Manage in Nova, title | Manage {name} in Nova? |
| | body | From now on you change this table in Nova, and each publish to {domain} replaces the table there with Nova's columns and rows. |
| | body | If someone changes it in CommCare HQ after this, your next publish there stops and shows you what changed before it sends anything. |
| | body | `LOOKUP_DISCARD_NOTE`, unchanged |
| | body | These apps read it: {apps}. |
| | buttons | Manage in Nova · Keep it in CommCare HQ |
| T10 | banner, managed in Nova | Nova manages this table. It came from {domain} on CommCare HQ, and publishing there replaces that table with Nova's. |
| | button | Let CommCare HQ manage it again |
| T11 | hand back, title | Let CommCare HQ manage {name} again? |
| | body | Nova takes CommCare HQ's columns and rows as they are in {domain} right now, and stops changing the table there. Changes made in Nova that were never published there are replaced. |
| | body, where a column is not text | Every column becomes text, as CommCare HQ holds it. {columns} held numbers or dates in Nova, so apps that compare them will compare text. |
| | body | These apps read it: {apps}. |
| | buttons | Let CommCare HQ manage it · Keep managing it in Nova |
| T12 | column badge | Gone in CommCare HQ |
| T13 | refresh, nothing changed | Nova's copy already matches CommCare HQ. |
| T14 | refresh, rows | Nova's copy now has CommCare HQ's rows. |
| T15 | refresh, columns | Nova's copy now has CommCare HQ's columns and rows. |
| T16 | refresh, a kept column | CommCare HQ no longer has the column {column}, and {apps} still read it. Nova kept the column, with no values, so those apps keep opening. Their next publish to {domain} stops until the column is back in CommCare HQ or they stop reading it. |
| T17 | cannot read | Nova couldn't read lookup tables in {domain} with your CommCare HQ account. It needs API access on that project space, and the Edit Apps and Access APIs permissions on your account. |
| T18 | unavailable | CommCare HQ didn't answer just now. You can try again in a moment. |
| T19 | no permission, Manage in Nova or the hand-back | An admin of this Project can choose this. |
| | no permission, a refresh of a table or of places | An editor of this Project can refresh this copy. |
| T20 | the table became Nova's meanwhile | Someone chose Manage in Nova for this table a moment ago, so there was nothing to refresh. |
| T21 | refresh, a character CommCare can't carry | The column {column} now holds a character CommCare can't carry in a value. Nova kept its copy as it was. You can take that character out in CommCare HQ, then refresh. |

T17 names Edit Apps because the rows read asks for it: `fixtures/resources/v0_1.py::FixtureResource`
authenticates with `RequirePermissionAuthentication(HqPermissions.edit_apps)`, where the table list
(`LookupTableResource`) asks only for API access, and part 05 classifies a refused rows read as
`edit-apps-and-access-apis` because the two cannot be told apart from the answer.

**Organization.**

| Id | Where | Text |
|---|---|---|
| O1 | banner label | Places managed in CommCare HQ |
| O2 | banner | These places live in {domain} on CommCare HQ. Nova keeps a copy so Preview can show them, and never changes them there. You can add or change places in CommCare HQ, then refresh. Nova's copy was refreshed on {date}. |
| | buttons | Refresh from CommCare HQ · Open in CommCare HQ |
| O3 | above the levels | CommCare HQ doesn't tell Nova which levels hold workers or how far a worker's phone carries places. Nova assumed every level holds workers and each worker carries their own branch. If {domain} is set up differently, you can match it here so Preview shows what workers see. |
| O4 | personas, none yet | Preview shows a worker's places through a persona. You can add a persona and stand them in a place to see this app's place lists. |
| O5 | banner, small | CommCare HQ doesn't send external IDs for places, so Nova's copy has none. |
| O6 | after a refresh, places in use | {count} places are gone from CommCare HQ, and a persona or an owner rule still uses them: {names}. Nova kept them. You can move those personas or rules, then refresh again. |
| O7 | every refused write (`organizationManagedRefusal`) | This app's places are managed in CommCare HQ ({domain}), so Nova can't change them here. You can change them in CommCare HQ, then refresh Nova's copy in Organization. |
| O8 | after a refresh, left out | {count} places in CommCare HQ sit at a level this app doesn't have ({codes}), so Nova's copy leaves them out. You can add a level with that code, then refresh. |
| O9 | refresh, changed | Nova's copy now matches CommCare HQ: {added} added, {changed} changed, {archived} archived. |
| O10 | refresh, nothing changed | Nova's copy already matches CommCare HQ. |
| O11 | refresh, over the limit | {domain} now has {count} places, and Nova holds up to 10,000 for an app. Nova kept its copy as it was. |
| O12 | cannot read | Nova couldn't read the organization in {domain} with your CommCare HQ account. That project space needs Locations and API access on its plan, and your account needs the Edit Locations and Access APIs permissions. |
| O13 | refresh, a place Nova can't hold | {name} in {domain} has a code, a name or a value Nova can't hold yet. Nova kept its copy as it was. |
| O14 | a level removed while places stand at it (`assertRemovedLevelsUnused`, managed) | {level} still has places in it, and this app's places are managed in CommCare HQ ({domain}). You can move those places to another level there and refresh, then remove the level. |
| O15 | a level change that leaves a place with no valid parent or level (`assertLocationPlacementsValid`, managed) | {place} wouldn't fit where it stands after this level change, and this app's places are managed in CommCare HQ ({domain}). You can move it there and refresh, then try the change again. |
| O16 | a property change a place's value doesn't fit (`assertLocationValuesValid`, managed) | {place} blocks this change. {issue} This app's places are managed in CommCare HQ ({domain}), so you can change that value there and refresh, then try the change again. |
| O17 | no connection | Connect CommCare HQ to refresh these places |

O12 names the plan feature "Locations", as CommCare HQ does and as part 01's block for
`cannot-read-organization` does (its section 9.3).

O14 to O16 are one function of the same file, called by `lib/organization/commitIntegrity.ts` where
the app's state row holds `hq_server` (11.4):

```ts
export function managedOrganizationCommitRefusal(
	refusal:
		| { readonly kind: "level-in-use"; readonly levels: readonly string[] } // O14
		| { readonly kind: "placement"; readonly place: string } // O15
		| { readonly kind: "value"; readonly place: string; readonly issue: string }, // O16
	domain: string,
): string;
```

Where several levels are named, `{level}` joins them with " and " and the verb agrees ("still
have"). O15 is one sentence for the three placements that check refuses (a place at a level the change
removes, a place left with no parent, a place no longer under a level above its own). `{issue}` in
O16 is `locationValueCatalogIssue`'s sentence, as today's refusal carries it.

**Publish.**

| Id | Where | Text |
|---|---|---|
| P1 | `managed-data`, passed | Nova checked the lookup tables CommCare HQ manages for this app. Nothing this app reads is missing, and Nova sends none of them. |
| P2 | `hq_managed_data_changed` | A lookup table this app reads changed in CommCare HQ in a way the app depends on, so Nova stopped before sending anything. |
| P3 | unreadable, the key or the account | Nova can't read the lookup tables {domain} manages for this app, so it can't tell whether they still hold what the app reads, and it stopped before sending anything. Reading them needs API access on that project space, and the Edit Apps and Access APIs permissions on your CommCare HQ account. |
| P4 | unreadable, otherwise | Nova couldn't ask {domain} about the lookup tables it manages for this app, so it stopped before sending anything. You can try publishing again in a moment. |
| P5 | a table's rows unreadable | Nova couldn't read the rows of the lookup table {name} in {domain}, so it stopped before sending anything. A row there with an empty value can cause this. Filling that value in CommCare HQ, or trying again in a moment, lets the next publish read it. |
| P6 | item, column gone | The column {column} is gone from {tag} in CommCare HQ, and this app reads it in {uses} places. You can put it back in CommCare HQ, or choose Manage in Nova on the table's page and publish Nova's columns. |
| P7 | item, table gone | CommCare HQ no longer has the lookup table {tag}. You can make it again in CommCare HQ, or choose Manage in Nova on the table's page and publish Nova's copy. |
| P8 | item, unsupported | {tag} now holds {holds} in CommCare HQ, which Nova can't hold yet. You can take those out in CommCare HQ, then publish again. |
| P9 | item, more than one value | {tag} now has a field with more than one value in CommCare HQ, which Nova can't hold yet. You can give each field one value there, then publish again. |
| P10 | item, over a cap | {tag} now has {phrase} in CommCare HQ. You can shorten it there, then publish again. |
| P11 | item, a name | {tag} now has a column named {name} in CommCare HQ, which Nova can't hold yet. You can rename it there, then publish again. |
| P12 | item, another project space's table | Nova's copy of {tag} was last refreshed from {originDomain} on {date}. This publish puts that copy in {domain}. |
| P13 | `project-data`, passed, with tables left out | CommCare HQ manages {tags} in {domain}, so Nova leaves them as they are. |
| P14 | drift item, a table Nova manages that came from CommCare HQ | You can also choose Let CommCare HQ manage it again on the table's page to take CommCare HQ's version. |
| P15 | `organization`, passed, managed places | {domain} manages this app's places. Nova refreshed its copy and sends none. |
| P16 | `organization`, item, copy not refreshed | Nova's copy of these places couldn't be refreshed. Organization says why. |
| P17 | item, a character CommCare can't carry | The column {column} of {tag} now holds a character CommCare can't carry in a value. You can take it out in CommCare HQ, then publish again. |
| P18 | `managed_table_handed_back` | A lookup table this app reads was handed back to CommCare HQ while Nova was publishing, so nothing was sent. You can publish again, and Nova will leave that table as it is. |

`{holds}` is `describeUnsupportedLookupContent`'s phrase. `{phrase}` is the cap's phrase of 5.3
without the tag. A project space's name stands bare in every string of this section, as it does in
the table page's and Organization's: `{domain}` is never quoted.

**The export boundary, for a table managed in CommCare HQ (8.2).** Each replaces the last sentence
of the finding it belongs to; the first sentence, which names the column, the table and the count,
is today's. These two live beside their findings, in `lib/commcare/lookup/xmlText.ts` and
`hqCellText.ts`, where the boundary's sentences are written; `{domain}` is `table.hq.domain`.

| Id | Finding | Today's last sentence | For a managed table |
|---|---|---|---|
| X1 | `LOOKUP_CELL_TEXT_UNREPRESENTABLE` | Remove those characters in Project data so CommCare can preserve the values. | CommCare HQ manages this table in {domain}. You can take those characters out there, then refresh Nova's copy on the table's page. |
| X2 | `LOOKUP_CELL_TEXT_CHANGED_BY_HQ` | Remove that whitespace in Project data. | CommCare HQ manages this table in {domain}. You can take that white space out there, then refresh Nova's copy on the table's page. |

**The HQ app file's guide (G1).** Title: "Lookup tables managed in CommCare HQ". Lines:

```
These tables are managed in CommCare HQ, and Nova only keeps a copy:
  <tag> (in <domain>, copied on <date>)

If you're importing into that project space, it already has them, so leave
"lookup-tables-managed-in-commcare-hq.xlsx" out. Uploading it there would
replace their rows with Nova's copy.

For any other project space, upload it on the Lookup Tables page too, the
same way as the file above.
```

**The review, handed to part 13 (B11), which places it.** `projectDataReview(...)` in
`lib/deployment/reading/projectData/review.ts` returns the data; the sentences are in
`lib/publish/managedData.ts`.

| Id | Section of the review | Text |
|---|---|---|
| R1 | managed in CommCare HQ, tables | Lookup tables managed in CommCare HQ: {tags}. Nova copies them so Preview can read them, and never changes them in {domain}. |
| R2 | the same, an equal table that is accounted for (`same-equal`) | {tag} is already in {Project} with the same columns and rows, so this app will use that table. Your other apps publish it to {domain} already, so nothing changes there. |
| R3 | what Nova leaves out | {count} media references point at no file, and no worker sees anything for them. Nova leaves them out. |
| R4 | what will be created | {count} pictures, sounds and videos, added to {Project}'s files. |
| R5 | managed in CommCare HQ, places | {count} places from {domain}, managed in CommCare HQ. Nova copies them so Preview can show them, and never changes them there. CommCare HQ doesn't tell Nova which levels hold workers or how far a worker's phone reaches, so Nova assumed its defaults. You can change them in Organization. |
| R6 | the choice, title, where the tables differ | {tag} is already in {Project}, and it's different |
| | the choice, title, where they are equal | {tag} is already in {Project} |
| R7 | the choice, body, where the tables differ | This app reads the lookup table {tag} from {domain}. {Project} already has a table by that name with different {columns, rows, or columns and rows}, read by {apps}. |
| | the choice, body, where they are equal and Nova manages the Project's | This app reads the lookup table {tag} from {domain}. {Project} already has a table by that name with the same columns and rows, managed in Nova and read by {apps}. No app of {Project} publishes it to {domain} yet, so it's yours to say which one this app uses. |
| | the choice, body, where they are equal and another project space manages the Project's | This app reads the lookup table {tag} from {domain}. {Project} already has a table by that name with the same columns and rows, managed in CommCare HQ from {otherDomain} and read by {apps}. |
| R8 | answer one | Use CommCare HQ's table |
| | under it | {Project}'s {tag} takes CommCare HQ's columns and rows and becomes managed in CommCare HQ. {apps} will read CommCare HQ's rows from then on, and Nova keeps it read-only until someone chooses Manage in Nova. |
| | under it, where a column is not text | Every column becomes text, as CommCare HQ holds it. {columns} held numbers or dates in Nova, so apps that compare them will compare text. |
| | under it, gone columns | {apps} read the column {column}, which CommCare HQ's table doesn't have. It stays, with no values. |
| R9 | answer two | Use {Project}'s table |
| | under it | This app reads {Project}'s rows in Preview. The table in {domain} stays as it is until someone publishes, and that publish asks before replacing it. |
| R10 | not offered, by the offer's `why`: `needs-admin` / `managed-elsewhere` / `app-reads-a-missing-column` / `fails-a-project-space-rule` | An admin of {Project} can choose this. / {Project}'s table is managed in CommCare HQ ({otherDomain}), so it can't follow two project spaces. / This app reads the column {column}, which {Project}'s table doesn't have. / {Project}'s table holds something CommCare HQ won't take in {domain} as it is, so this app can't use it there. |
| R11 | beside the choice, always | Or go back and add this app to another Project. |
| R12 | while only step one has run and it found something | Nova checks pictures and sounds once everything else can come in. |

Which of R7's three forms is drawn is read from the `ReviewTable` alone, by 14.1's rule: the third
("managed in CommCare HQ from {otherDomain}") is chosen where `options["use-commcare-hq"]` is
`{ offered: false, why: "managed-elsewhere" }`, `{otherDomain}` being that offer's `name`, and the
second loses its last sentence where `use-project` is not offered for `fails-a-project-space-rule`.
`{otherDomain}` and `{column}` in R10 are the offer's `name`. Where no app reads the Project's
table, `{apps}` clauses are dropped: R7 ends "with different {...}.", and its two equal forms end
"managed in Nova." and "managed in CommCare HQ from {otherDomain}." before their next sentence.
`{columns}` in R8 is
`LookupChoiceOffer.retypedColumns`, and in T11 the labels of the table's columns whose type is not
text, read from the page's own snapshot; the line is left out where there are none.

---

## Tests

Nothing here is run by this plan. Each test names its boundary and the failure it would catch.
Where a pure case needs CommCare HQ's lookup or place answer, it starts from a retained one under
`proof/hq-reads/lookups/` or `proof/hq-reads/places/`, decoded by part 05's readers, and changes
the one value the case is about; none is written whole by hand. Part 14 names
`lookupTables.test.ts` and `places.test.ts` as what holds this part's readers outside proof 6 (its
sections 5.1 and 7.5).

**Pure (Vitest, no database).**

| File | Holds | Would catch |
|---|---|---|
| `lib/media/__tests__/validateSniffed.test.ts` | over the package's real byte fixtures: each accepted format passes with the metadata `validateMediaBytes` gives it under its true name; a PNG's bytes pass whatever name CommCare HQ had; random bytes and a TIFF are refused with the reason and `sniffedMime` of 2.3. SVG, four ways, each `svg-not-accepted` with `image/svg+xml`: bare `<svg`, after `<?xml ` (which `file-type` sniffs as `application/xml`), after a byte order mark and a comment, and in UTF-16. An XML document whose root is not `svg` is `mime-claim-mismatch` with `application/xml` | a name deciding the verdict; a refusal losing its sniffed type; an SVG with a declaration filed as Nova's to classify |
| `lib/deployment/reading/projectData/__tests__/media.test.ts` | `planHqMedia` over a built source: every row of 2.1's table, among them an audio reference naming a `CommCareVideo` (the M4A entry, and the file in no `references`), a picture slot naming a sound (`unrecognized`), and an entry with a null id (no file, not no entry); two paths of one file become one `HqMediaFile`; a file only a mismatched reference names is not in `files`; 501 files give the budget finding and no file list is cut. `hqMediaRefusalEntry`: one refused fixture per row of its table, a format no row names gives `null`, and an Ogg sound refused for its codec gives `null`, not the video entry. `mediaFindings`: each verdict's finding, standing and `detail.name`; a file only Android plays in an app that runs in Web Apps gives `media-not-played-where-app-runs`. Two findings of different kinds are both reported. `hqMediaReferencesOf`: each row of its slot table, and a slot string outside it throws | a finding stopping the pass; a wrong entry id; a format silently accepted; a video handed to an audio slot and refused at the birth |
| the same file | `mediaSlotDrawnOn` and `androidInstallCheckReaches`: each cell of 3.1 by slot, kind, platform and which of the two is missing (a question's audio with no entry is drawn in Web Apps and its image is not; a choice's media is drawn nowhere in Web Apps; the Register action is drawn nowhere on Android); 3.2's four rows over each slot, each of the three declarations and `contentValid` `"yes"`, `"no"` and null; a menu's audio is reached only when every form and earlier menu carries both | a missing file read as inert where a worker sees a prompt or a player, or a finding where nothing draws |
| `.../__tests__/readingMedia.test.ts` | section 14.2's pure functions. `readingMediaIndex`: each of its rows; a path keeps one id from before staging to after it, and takes the published id once `plan.published` holds its file. `planReadingMedia`: a file `previous` holds keeps its id, its verdict and its `published` entry; a file no longer referenced leaves with both. `mergeReadingMediaPlans`: a verdict wins over none from either side, and a `published` entry of either side is kept. `stagedReadingFiles`: only held files. `readingMediaPlanSchema`: a plan with `published` round-trips, and an unknown member is refused. `narrowDeclarationsByMedia`: a choice whose platform no held file plays on leaves; the proposal stays where its choice remains and otherwise is the first choice left; `narrowedByHq` and `keepsWebApps` pass through; a `none` input comes back as it is. `readingMediaRows`: one `ready` record per held file under the id the document names, the published id once there is one, and none for a file with another verdict | a document whose asset ids change at the media step; a lost fetch between two drivers; a publication forgotten between two creation steps; a proposal moved though its choice was still offered |
| `.../__tests__/lookupTables.test.ts` | `candidateLookupTags`: a tag in a form's instance source, in a suite expression, in a search prompt; a tag that is a prefix of another names both. `lookupTableFindings`: each row of 5.3, each cap one over and exactly at (`lookupCapExcess` with a hand-made `LookupRowsMeasure`); a cell holding a character XML cannot carry gives `table-cell-unrepresentable` naming its field; two findings on one table both reported. `columnLabelFor`: a field name of 120 characters is its own label, one of 121 and one of 255 are cut to 120. `lookupFixtureBudgetFinding`: two tables of 5,000 rows give the caps entry at the app. `lookupTableStanding`: each row of 7.1, among them an equal plain table with no sibling mapping (`choice`, `differs` empty), the same with a sibling mapping of that remote id (`same-equal`) and of another remote id (`choice`), and an equal table managed from another project space (`choice`, `use-commcare-hq` not offered); equality with a missing cell against an empty string, with rows in another order, with a typed column; each `LookupChoiceOffer` arm and `retypedColumns`; an equal, accounted-for Project table holding a cell that ends in a space is a `choice` whose `use-project` offer is `fails-a-project-space-rule`, and the same table without that cell is `same-equal`; a table managed from another project space that the person may not administer answers `managed-elsewhere`, not `needs-admin`. `resolveLookupBindings`: each row of 7.4's table, a `choice` with no answer binding the Project table's id as `use-commcare-hq` does. `readingLookupSnapshot`: a table that comes in as CommCare HQ's holds its rows under the binding's column ids in CommCare HQ's order, a table bound as it stands holds the Project's definition and rows, and `projectRevision` is the one step 3 read. `readingProjectDataFindingsFor` over a built `ReadingProjectData`, one case per rule of `lookupSelectSourceRowFindings` (no rows, a blank value, a value with white space at an end, a repeated value, a blank label): each gives one `table-choices-unusable` at the table naming the field, two rules failing on one table still give one finding, and a Project table bound as it stands that holds a character XML cannot carry gives `table-cell-unrepresentable`. `reviewTableSchema` and `reviewPlacesSchema`: `projectDataReview`'s answer round-trips, and a `choice` standing with a null `choice` is what the function never answers. `readerLookupCatalog`: a column per field in CommCare HQ's order, each `text`. `resolveTableChoices`: `missing`, `unknown` and `notOffered` | a table brought in that the app does not read; a first publish that asks about the table the app came with; a choice offered that cannot be written; a birth failing a label's CHECK; an app born unable to publish for a cell of a table it was bound to; a table's rows worded as Nova's mistake by acceptance |
| `.../__tests__/places.test.ts` | `sourceMayReadPlaces`: `instance('locations')`, `instance("locations")`, `instance( 'locations' )`, the JSON-escaped and the XML-escaped quote, a form's `jr://fixture/locations` under another id, and a source that reads none. `planManagedPlaces`: each row of 11.4 in both modes; the digest ignores the order CommCare HQ listed places in. `managedPlacesOwnerFindings`: an owner rule with two places at its level below one owner, and with none, each give `owner-rule-needs-one-place`; with exactly one, nothing. | a refresh that advances on a reordered list; places never read for an app whose case list filter reads them; a birth refused by the organization's integrity step |
| `lib/commcare/reader/__tests__/worldEntities.test.ts` (B6 lands the file with its `worldEntitiesFromReads` cases; B9 adds the `levelsFromHq` cases) | `worldEntitiesFromReads`: a slug in the grammar is minted with the resolver's UUID; a built-in worker slug and a slug outside the grammar are not. `levelsFromHq`: parent before child, the `caseFlow` of each of the four flag pairs, and a level whose code Nova cannot hold gives `place-not-holdable` and leaves `levels` with every level beneath it | a level setting invented from `administrative`; a worker property minted for a built-in slug; a draft holding a level the gate refuses |
| `.../__tests__/settlements.test.ts` | `handOffSettlements`: a hand-off whose path `HqMediaPlan.claims` holds is `inert-claim`; one a finding names, at the media place or at the reference's place, is `finding`; a table tag a finding names is `finding`; a path that is both gets one settlement; a hand-off nothing judged gets none; each settlement carries its hand-off's own `artifact`, `where` and `key` | a hand-off settled twice or never, which acceptance's check 1 would word as Nova's mistake |
| `lib/deployment/__tests__/lookupResourcePlan.test.ts` (extended) | 10.2's five arms; a sibling mapping with another remote id gives arm 5; any adopted sibling makes the push adopted with the earliest pair; a taken-over table with a re-minted id still compares by content | the sibling refusal coming back; an adoption attributed to the wrong person |
| `lib/deployment/__tests__/managedReRead.test.ts` | `reReadManagedTablesForPublish` over controlled HQ answers (the `hq/` client's own test doubles for its transport): each row of 8.1's table, the character row among them; two stopping tables are both returned and nothing is refreshed; a table of another project space the publisher cannot read, or whose server is not the publisher's connection's, is `stale` and never stops; a refused rows read is classified `permission` and gives P3 | a publish that sends content reading a column that is gone; a refresh half applied before a stop |
| `lib/export/__tests__/boundaryManagedTables.test.ts` | `hq-upload` with a `lookupTarget`: a table managed there is in no sheet of the workbook and in `managedLookupTables`; the same table for another target is in the workbook; all tables managed gives no workbook. A managed table left out, holding a cell with trailing white space, raises no `LOOKUP_CELL_TEXT_CHANGED_BY_HQ`; the same table sent to another target raises it with Copy X2's ending, and a plain table raises it with today's. `hq-json`: two workbooks, each table in exactly one. `ccz`: every table's fixture | a managed table written in its own project space; an export refused with a remedy Nova refuses |
| `lib/publish/__tests__/manualImportGuide.test.ts` (extended) | the managed step is present exactly when a table is managed, names each tag and domain, and names the second file | a guide that tells a person to replace a table CommCare HQ manages |
| `lib/commcare/multimedia/__tests__/hqJsonExportArchive.test.ts` (extended) | `hqImportFileGuide` with only a managed workbook still lists the `lookup-tables` plan feature and the managed step; `buildHqJsonExportArchive` writes both workbooks under their two names | the plan feature dropped from the guide of an app whose every table is managed |
| `lib/deployment/__tests__/workerProvisionPlan.test.ts` (extended) | `workerProvisionProblems` reports no problem for a persona standing in a place `managedPlaceIds` holds, and still reports one for a place neither it nor the mappings hold; `planWorkerProvisioning` sends the `hq_location_id` | a worker refused for standing in a place CommCare HQ manages |
| `components/builder/project-data/__tests__/projectDataModel.test.ts` (extended) | `tableEditability` for each of the three states under each of view, edit and delete | an edit control offered on a managed table (the state model; the page is Playwright's) |
| `lib/collab/__tests__/lookupManifestFrame.test.ts` (extended) | a frame with `hq` parses; a plain table's entry has no `hq` key; a malformed `hq` fails the frame | a managed table reaching a tab as an editable one |
| `lib/mcp/__tests__/servedSchemas.test.ts` (extended, with B12) | the two new tools' served inputs | an input drifting from this table |

**Real Postgres (`*.postgres.test.ts`, one invocation per package).**

| File | Holds | Would catch |
|---|---|---|
| `lib/lookup/__tests__/managed.postgres.test.ts` | **The refusal arm, one case per writer path of 6.3's table**, each driven through its production entry (`updateLookupTableName`, `updateLookupTableTag`, `addLookupColumn`, `updateLookupColumnLabel`, `updateLookupColumnWireName`, `moveLookupColumn`, `createLookupRow`, `updateLookupRow`, `deleteLookupRow`, `moveLookupRow`, `replaceLookupRows`, `applyLookupSchemaGovernance` for remove column and retype, `applyLookupAuthoringBatchInTransaction` for each `updateTables` operation kind) against a managed table: each throws `managed_in_hq`, the table's rows, columns and both revisions are unchanged, and the Project revision did not advance. The same calls succeed after the takeover pair is set. A table delete succeeds on an unreferenced managed table and is refused as `referenced` on a referenced one. A stale `expectedTableRevision` on a managed table answers `managed_in_hq`, not `conflict` | a writer that reaches a managed table by a path that forgot the purpose |
| the same file | **The create arm**: tables are created with the predeclared table and column ids, every column `text`, the origin columns set; a field whose name is 200 characters long is created, its wire name whole and its label 120 characters; a tag already taken rolls the whole call back with rows written before the failure gone; one revision advance and one notice for three tables | a document naming an id the table does not have; a half-created set; a label that fails its CHECK inside the birth |
| the same file | **The refresh arm**: an equal digest advances nothing and stamps the two columns; changed rows advance `rows_revision` alone; a new field adds a column with the given id; a field gone with no reference removes its column; a field gone that an app's `lookup_column_references` edge names stays, empty, and is returned with the app; `adopt` mode on a plain table sets the origin and clears a takeover; `adopt` mode on a table holding an `int`, a `decimal` and a `date` column, each matched by a field of CommCare HQ's, leaves all three `text`, holds CommCare HQ's strings as they stand (`007` stays `007`), keeps the `lookup_column_references` edges of an app that reads them, and the table's fixture then builds (`buildLookupFixtures` does not throw); `adopt` mode with equal columns and rows still stamps `definition_revision`; `refresh` mode on a table taken over meanwhile throws `conflict`. A real concurrent `updateLookupRow` held at its lock runs after the refresh commits and is refused | a refresh that drops a column an app reads; a lost update between a refresh and an edit; CommCare HQ's text stored under a number column |
| the same file | the two CHECKs: a row with half the origin columns, and a takeover with no origin, are each refused by the database | a writer leaving a table in no state |
| `lib/organization/__tests__/managed.postgres.test.ts` | `writeManagedPlacesInTransaction` writes a three-level tree with parents resolved and `hq_location_id` set, and `applyOrganizationCommitIntegrity` run after it on the same transaction, over a document holding those levels and an owner rule with one place at its level, passes; each of `createLocation`, `updateLocation`, `moveLocation`, `setLocationArchived` is refused `managed-in-hq` with no row and no revision changed, and `describeArchiveImpact` on the same app answers its counts; a blueprint commit on a managed app that removes an occupied level, re-parents a level over its places, and makes a location property required over places with no value is refused with Copy O14, O15 and O16 in turn, and the same three commits on an app with no managed copy give today's sentences; `refreshManagedPlacesInTransaction` adds, updates, archives and restores by site code, keeps a place an `app_location_references` row names and reports it, and advances nothing on an equal digest | a place edit that would be pushed nowhere and shown in Preview; a refresh orphaning a persona; a locked read refused as a write; a level edit refused with a remedy Nova refuses |
| `lib/deployment/__tests__/projectLookupStanding.postgres.test.ts` | **Derived ownership**, through `publishAppToHq` with the HQ client's transport answering as CommCare HQ would: app A publishes table T to a project space, then app B of the same Project publishes: B is not refused, pushes, and records its own mapping `nova-created`; where A adopted T, B's mapping is `adopted` with A's pair; an app of another Project with the same tag is still refused; A in recently deleted still counts; after A is deleted for good B is asked; B's drift check stops on a change made in CommCare HQ after A's push (the shared baseline) | the refusal that asks an app to take over Nova's own table; ownership leaking across Projects |
| `lib/deployment/__tests__/managedTables.postgres.test.ts` | a publish to the managing project space with every table managed sends no workbook and writes no `lookup-table` mapping; with a changed row in CommCare HQ the copy is refreshed before the boundary reads it and the import's content sees the new generation; with a column the app reads gone it stops `hq_managed_data_changed`, the copy untouched; `manageLookupTableInNova` stamps the table's `definition_revision`, so its `tableRevision` in the next manifest moves, and writes no row; a publish after it records an `adopted` mapping attributed to the person who took it over, and stops `hq_changed` first where CommCare HQ's rows moved since the last refresh; `letHqManageLookupTable` takes CommCare HQ's rows and the next publish leaves the table out; a table handed back between preflight and the upload stops the publish `managed_table_handed_back` with Copy P18 and nothing sent. **Refresh, through its service**: `refreshManagedLookupTable` with CommCare HQ answering through undici's `MockAgent`, as `publishSequence.postgres.test.ts` answers a publish's reads: changed rows give `changed: "rows"` and the copy holds them; a table gone, a field property, a table over a cap and a cell holding a character XML cannot carry each leave the copy as it was with their outcome; a refused rows read gives `cannot-read`; an actor whose stored connection is on another server gives `cannot-read`, and one with none `not-connected` | a managed table written; a takeover that silently replaces a colleague's later upload; an open page left with a stale managed snapshot |
| `lib/deployment/__tests__/managedPlaces.postgres.test.ts` | a publish to the managing project space sends no place batch and asks no `organization` plan feature; a publish to another plans the copy; `provisionWorkers` for a persona standing in a managed place is not refused by `workerProvisionProblems` and sends that place's `hq_location_id` | places patched in the space that manages them; a worker made standing nowhere, or refused |
| `lib/deployment/reading/projectData/__tests__/readingProjectData.postgres.test.ts` | section 14.1 through `readReadingProjectData`, CommCare HQ answering through `MockAgent`: ids are minted once and the second call returns the same `minted`; a `choice` tag binds the Project table's id with and without an answer; a failed list read is `failed` with part 05's kind; `places: "always"` reads places for a source the test says reads none; a place list naming a level code the level list lacks reads both lists once more and then answers `failed` with `hq-unavailable`; a tag that meets a Project table carries that table's id and two revisions in `gathered.tables`, and `projectDataReview` copies them. `readingProjectDataFindingsFor`: a table Nova cannot hold raises its finding only where the reader read it; a tag in `unreadTables` that CommCare HQ's list lacks raises part 08's entry. `writeBroughtInLookupTablesInTransaction` and `writeBroughtInPlacesInTransaction`, in the order and at the point the seam calls them: the case inserts an app row on its own transaction, calls the two writers, then `lookupContextForAuthoritativeWrite` and `applyOrganizationCommitIntegrity`. The lookup context finds the tables, the integrity step passes, and a Project table changed after the read throws `BroughtInTableChangedError` and leaves no row. This is the whole of B9's case and it stays as it is: the seam itself, `writePreparedGenesisInTransaction`'s `afterAppInsert`, is B10's, and part 12's `birth.postgres.test.ts` holds the two writers running through it | the reading and the birth disagreeing on an id; a table found after the gate looked for it |
| `lib/media/__tests__/stagedMedia.postgres.test.ts` (`@/lib/storage/media` replaced with `vi.mock`, as `lib/mcp/__tests__/uploadMediaAsset.postgres.test.ts` replaces it: the package has no fake bucket) | `stageMediaBytes` writes the pending key of the id it was given and no row; `publishStagedMedia` publishes a ready row with the staging id, deletes the pending object, and on a second run returns the same asset by hash; bytes already in the Project return the existing asset's id; a download that rejects with `code: 404` is `lapsed` and nothing is published for it, and one that rejects with any other error rejects the call; `downloadAssetBytes` is called with the kind's cap; the caller losing `edit` before publication inserts nothing. `publishReadingMedia`: a lapsed file is read again through `MockAgent` and published under its reserved id; a lapsed file CommCare HQ no longer has answers `refetch` with its verdict gone; the `published` answer's plan holds every file in `published`; a second call handed that plan downloads nothing and publishes nothing; a call cut off by its deadline answers `more` with the files it published in `plan.published` | a file in Files before the app exists; a duplicate row on retry; a storage outage read as lapsed bytes |
| `lib/mcp/__tests__/uploadMediaAsset.postgres.test.ts` (existing, unchanged assertions) | the extraction changed no behavior of MCP's upload, its two permission errors among them | a regression in the path it was lifted from |
| `lib/case-store/migrations/__tests__/hqBringInProjectData.postgres.test.ts` | `up` on a database holding plain tables, places and state rows leaves every row valid; `up` run a second time over its own result, with the ledger row erased, raises nothing; an insert and an update that name none of the new columns (the previous revision's statements) pass on a plain row, and the same update passes on a row whose `hq_*` columns are set; `down` restores the columns' absence; `lock_timeout` is 0 after `up` | a migration that fails over existing rows or on a replay; a CHECK the revision still serving can break |

**Playwright (`e2e/tests/app/`).** `managed-project-data.spec.ts`, tagged `@seed:managed-data`, over
a seeded app whose table and places carry the origin columns (the profile is new in
`e2e/lib/smokeProfiles.ts` and `smokeSeedFactory.ts`, and `e2e/seed.ts` writes them through
`createManagedLookupTablesInTransaction` and `writeManagedPlacesInTransaction`): the
table page shows the banner and no editing control, and the three actions; Manage in Nova's dialog
names the app and, confirmed, the grid becomes editable in this tab and in a second tab without a
reload (the stamped `definition_revision` is what refetches the second tab's table); Organization
shows the banner, no place control, the levels note and the persona line.

The spec does not press Refresh or "Let CommCare HQ manage it again". Both are Server Actions whose
requests to CommCare HQ leave the Next server, where a page route never sees them:
`publish-flow.spec.ts` routes `_next/static` chunks, `/api/apps/<id>` and `/api/compile/json`, all
requests the browser makes, and no e2e helper answers as CommCare HQ. So the spec asserts that the
two controls are offered to a connected member and replaced by Copy T4 for one who is not, and what
they do is proven in `managedTables.postgres.test.ts` through the services, with `MockAgent`
answering. Manage in Nova reads no CommCare HQ, which is why it is the one action the spec drives.

**The proof lane (part 14 owns the lane; B9 adds these, as its section 11.2 lists them).**
`proof/views/test_lookup_upload.py::test_a_replacing_upload_leaves_an_unnamed_table_alone` (run R1).
The targeted document `targeted-missing-media` and its Android and Web Apps reads (run R2). The
capture: `proof/corpus/publish.ts` and `proof/corpus/targetPeer.ts`, whose peer answers the lookup
table reads the `managed-data` preflight makes (part 14, section 2.5), with the matching case in
`proof/corpus/__tests__/publish.postgres.test.ts`. The bases are part 14's and land in B13 (its
section 6.2): `hq-media` exhibits a held path, a file two paths name and a menu icon whose path
has no map entry; `hq-lookups` a table a select reads, one the form declares and nothing reads, and
a table whose tag holds a hyphen (part 04); `hq-places` two levels with a location property, active
and archived places and a form whose logic reads the worker's place. Its variants (its section
7.2): on `hq-media`, a question image whose path has no map entry; on `hq-lookups`, a form that
reads a tag CommCare HQ's table list lacks.

---

## Contracts and docs these changes make false

Each lands in B9 unless B14 is named.

| Where | Old | New |
|---|---|---|
| `lib/lookup/CLAUDE.md`, "Valid writes", after the lock order | (no sentence) | "`lockLookupTableForUpdate` takes the write's purpose. A table managed in CommCare HQ (`hq_server` set, no takeover) refuses an `author` write with `managed_in_hq` before its revision is compared; `remove-table` is allowed in every state; `hq-refresh` and `hq-management` are `managed.ts`'s alone. No writer reaches a table row another way." |
| the same, "No code may hold Project state or a lookup table and later request an app lock." | as quoted | the sentence stands as written; add after it: "A birth that brings tables in from CommCare HQ is app-first like every app-bound writer: it inserts its own app row, which no other session can name, then takes Project state and writes the tables (`lib/db/appGenesis.ts`, the `afterAppInsert` seam), and requests no other app row after." |
| the same, "Identity and tenancy", first bullet: "Tables, columns, and rows use the distinct server-minted UUIDv7 identities" | as quoted | the sentence stands; add: "A table brought in from CommCare HQ takes table and column ids minted from Postgres when its reading starts (`managed.ts::mintLookupIds`), so every step of the reading names the same ones." |
| the same, new section "Tables from CommCare HQ" | (none) | the three states of 6.1; what the refresh arm does to columns and rows; that every column of a managed table is text, and that taking CommCare HQ's table over a Project table sets every column to text with no stored value coerced; that `hq_canonical` is `lib/deployment`'s value of which `lib/lookup` reads `digest` and `fields[].name`; that a refresh with an equal digest advances no revision; and that a change of who manages a table stamps `definition_revision`, because every client reads editability from it |
| the same, "Reads and realtime": "the two CommCare HQ modes turn it into the fixapi workbook" | as quoted | "the two CommCare HQ modes turn it into the fixapi workbook, leaving out a table CommCare HQ manages in the project space the upload is for, and putting such tables in a second workbook of the HQ app file" |
| `lib/media/CLAUDE.md`, "Upload", after "MCP has no untrusted PUT round trip..." | (no sentence) | "Bringing an app in from CommCare HQ stages each file's validated bytes at the same `pending/<project_id>/<id>` key with no row at all (`stagedMedia.ts`), and publishes them at creation through `publishReadyMedia`, the one in-memory publisher MCP's upload also calls. The bucket's one-day rule is the only keeper of staged bytes; the reading keeps the verdict." |
| the same, "Accepted formats": "`validate.ts::validateMediaBytes` is the format gate (extension allowlist → ...)" | as quoted | add: "`validateSniffedMediaBytes` is its entry for bytes with no trustworthy name: the format is sniffed first and the name built from it." |
| root `CLAUDE.md`, the `lib/lookup` paragraph: the sentence that begins "every export mode carries the data: local `.ccz` export resolves their current names" and ends "shipped beside the app JSON for a manual import." | as it stands | "every export mode carries the data Nova manages: local `.ccz` export embeds every table as fixture bytes, and the two HQ modes build the fixapi workbook, pushed before the app's content on a direct upload and shipped beside the app JSON for a manual import. A table brought in from CommCare HQ is a copy that project space manages: Nova never writes it there, refuses edits to it, refreshes it before a publish, and ships it in a second workbook of the HQ app file." (B14) |
| root `CLAUDE.md`, the `lib/deployment` paragraph: "never writes over a remote resource Nova cannot account for: a name clash refuses..." | as quoted | add after it: "A Project's table is accounted for when any of the Project's apps holds a live mapping for the table CommCare HQ has under that tag." (B14) |
| `docs/architecture/contracts.md`, "Locations and restore scope", first paragraph | "Organization structure lives partly in the blueprint and partly in app-scoped rows, so mutations and row writes share the app-row lock discipline." | the sentence stands; add: "An app brought in from CommCare HQ whose logic reads places holds them as a copy that project space manages: every place write but the refresh is refused, a publish to that project space sends no place, and a publish to any other creates them from the copy. Levels and place information stay document entities and stay editable; level settings no CommCare HQ API returns take Nova's defaults and are said so in Organization." (B14) |
| `docs/architecture/contracts.md`, "HQ deployment safety": "Remote-resource mappings additionally key the Nova resource UUID and store ownership/adoption, remote id, pushed identity, and revision." | as quoted | add: "A lookup table's standing in a project space is the Project's: a publish reads it from every app of the Project that holds a live mapping for the table CommCare HQ has under the tag, so a second app publishes the Project's own table without being asked to take it over." (B14) |
| the same: "Nova never auto-adopts a same-named HQ resource, overwrites an unowned resource..." | as quoted | add: "A table or a set of places managed in CommCare HQ is never written in the project space that manages it. Manage in Nova is the one way a person hands such a table to Nova, and it is recorded on the table with who and when." (B14) |
| `docs/architecture/contracts.md`, "One Postgres system": "Lookup definitions and rows are Project-scoped." | as quoted | add: "A table records where in CommCare HQ it came from and who manages it; an app's organization state records the same for its places." (B14) |
| `lib/deployment/CLAUDE.md`, "Preflight is a graph": "`project-data`, `organization` and `target-app` are the three edges that TALK to CommCare HQ" | as quoted | "`managed-data`, `project-data`, `organization` and `target-app` are the four edges that talk to CommCare HQ"; add the paragraph of 8.1 on `managed-data`, its refusal `hq_managed_data_changed`, and that it precedes the export boundary because it can change the lookup generation |
| the same: "`plan-features`, titled "What this project space needs", asks CommCare HQ nothing and comes before every edge that does." | as quoted | "`plan-features`, titled "What this project space needs", asks CommCare HQ nothing and comes before every edge that writes to CommCare HQ or asks a person about a write. `managed-data` alone precedes it: it only reads CommCare HQ and refreshes Nova's copy of the tables CommCare HQ manages, and the export boundary must validate the refreshed generation. A publish refused later keeps that refresh, which is CommCare HQ's current state and nothing of the publish." |
| the same, "Ownership, and why superseded rows are kept": "the push is planned against the ownership ledger" and the paragraph that begins "Recording is not optional on a refusal" | as they stand | add the two arms of 10.2 (a sibling's mapping; a takeover) and: "A table CommCare HQ manages in the target has no mapping and is in no workbook." The sentence "There is deliberately no arm for 'matched by name'" stands unchanged: a sibling's mapping accounts for a table by the Nova table's id, a takeover is a person's recorded act, and a tag met at a reading is bound by the review's rule of 7.1 before any app exists, never by a publish. This settles the research's step 6 row. |
| the same, "What the check cannot close" | (no sentence) | "A table handed back to CommCare HQ between a publish's last read of that fact and its workbook upload is written once more." |
| the same, "Provisioning workers": the places a persona stands in | resolved through `location` mappings | add: "and, for places CommCare HQ manages in the target, through each place's `hq_location_id`" |
| `lib/organization/CLAUDE.md`, the writer section | every writer takes `lockOrganizationForWrite` | add the purpose and its three values (`author` for the four place writers, `read` for `describeArchiveImpact`, `hq-refresh` for the refresh), the refusal `managed-in-hq`, `managed.ts`'s two transaction-taking writers, that a birth writes the copy inside the genesis tail before the integrity step, and that a refresh never writes the document |
| the same, "The two directions of cross-store reference" | the three row-to-document refusals each end by sending the author to move or change places | add: "Where an app's places are managed in CommCare HQ, the same three refusals say so and send the author to CommCare HQ and Refresh." |
| `lib/export/CLAUDE.md`: "`hq-upload` build the fixapi workbook (`lookupWorkbook`)" | as quoted | add `lookupTarget`, `managedLookupTables` and `managedLookupWorkbook`, that the HQ cell-text check judges only the tables a workbook carries, and that both cell-text findings end with the managed remedy for a table CommCare HQ manages |
| `lib/deployment/CLAUDE.md`, the failure codes | (no entry) | `managed_table_handed_back`: a table became managed in CommCare HQ from the target between preflight and the workbook; nothing was sent |
| `lib/commcare/surface/entries/expressions-and-data.json` | the four entries of 13.1 | as 13.1 |
| `content/docs/project-data.mdx` (B14), "What happens to a table when you publish": "**Publishing to CommCare HQ** puts them on the project space before the app's content goes, and replaces their rows with the rows in Nova every time you publish." | as quoted | the bullet stands for a table Nova manages and gains two sentences: "A table managed in CommCare HQ is different: Nova never writes it in the project space that manages it, and checks before each publish that it still holds what your app reads. When several of your Project's apps read one table, each of them publishes it without being asked to take it over." The file also gains a section "Tables managed in CommCare HQ", in the words of T1 to T3, T9, T11 and T16: what the copy is, that Nova keeps it read-only, Refresh, Manage in Nova and what it means for the next publish, handing the table back, and a column that is gone in CommCare HQ |
| the same, "If a cell contains a character CommCare cannot preserve ... You can remove the character" | as quoted | add: "For a table managed in CommCare HQ, you can take the character out there and refresh Nova's copy." |
| the same, **The CommCare HQ app file** bullet | "comes as a zip with a `lookup-tables.xlsx` beside it" | add: "Tables managed in CommCare HQ come in a second file, `lookup-tables-managed-in-commcare-hq.xlsx`, which you leave out when you import into the project space that already has them." |
| `content/docs/organization.mdx` (B14): "Nova authors this model, and publishing puts these places on your CommCare HQ project space." and "Publishing puts the places themselves on the project space." | as quoted | each gains "except places managed in CommCare HQ, which Nova copies and never changes there"; the file gains a section "Places managed in CommCare HQ", in the words of O2, O3 and O7: what the copy is, that places change in CommCare HQ and Refresh brings them in, that levels and place information stay editable, and the level settings Nova assumed |
| `content/docs/publishing.mdx` (B14) | no section | a short section "Lookup tables and places managed in CommCare HQ": the `managed-data` check in the words of P1 and P2, and links to the two sections above, which hold the rest |
| `content/docs/mcp/tools.mdx` (B14) | no rows | rows for `refresh_managed_data` and `set_lookup_table_management`, and the new result keys of `get_lookup_tables` and `get_organization` |

---

## Departures

Each numbered item is a decision of this part with its evidence. Some depart from the outline, the
research or a contract of the repo, and say which. The others record an alternative that was
weighed and not taken, as "Not done", so that an implementer who reaches for it finds the reason.

1. **Staged bytes are kept one day, and the verdicts for as long as the reading lives** (2.5). Not
   done: keeping the bytes seven days in the pending state. Evidence:
   `config/media-bucket-policy.json` deletes `pending/` at one day;
   `lib/storage/media.ts::verifyMediaBucketStoragePolicy` holds the bucket to that file exactly;
   changing it is an apply outside a deploy, and step 6 ships by its stacks' ordinary deploys with
   nothing run beside them (`../6-bring-in.md`, "Migrations and the cutover"); and it would keep
   every abandoned browser upload six days longer. What the person loses is a second fetch when
   they create more than a day after the read, during the creation's `publishing-media` phase
   (part 12, Copy C4).
2. **A Project table's standing is derived with no lock held from the plan to the workbook.** Not
   done: deriving it under the Project state lock. Evidence: `lib/deployment/CLAUDE.md`, "No lock
   spans the CommCare HQ round trips". Decision: 10.3, with the window stated.
3. **Managed places are never pushed to the project space that manages them, and are pushed to any
   other** (11.4). A publish to another project space creates them there from the copy, as it
   creates a managed table there (8.2), because an app that reads places cannot run there without
   them and the existing plan already refuses what that space cannot hold. Not done: places that
   are pushed nowhere.
4. **`app_locations.hq_location_id` holds CommCare HQ's id of each managed place.** Managed data
   has no per-app ledger mapping (8.2, 11.4). Provisioning a worker resolves a persona's places
   through `location` mappings (`workerProvisionPlan.ts`), so without CommCare HQ's id on the row a
   persona standing in a managed place could not be made a worker there. One nullable column, read
   by worker provisioning (`workers.ts`) and compared by the refresh (11.4).
5. **From the outline's item 3 and its cutover** ("recorded as referenced in its project space";
   "each lookup table's per-app deployment records merge into one record per Project table and
   project space"). No `referenced` ownership value, no Project-level table and no data move: the
   fact is on the lookup table, and ownership is derived (section 10). Not done: merging the
   per-app records by a backfill, because the migration Job runs while the previous revision still
   serves (`lib/case-store/CLAUDE.md`: "the migrate Job runs while the OLD revision is still
   serving"), and that revision keeps writing per-app mappings
   (`lib/deployment/store.ts::recordPushedResources`), so a table it pushed after the backfill
   would have no merged record and would read as a stranger's on the next publish. The outline's
   "each publish reads referenced data first" is 8.1. The contract's "no arm for 'matched by
   name'" keeps its sentence in `lib/deployment/CLAUDE.md` (the research's `referenced` wording
   for this row is not taken; the row stands unchanged).
6. **From the research ("a table tagged `types` can be referenced but not adopted"; "its per-table
   caps grow to hold any table HQ holds").** Both stay `not-yet` in step 6 (5.3).
7. **"Use CommCare HQ's rows" is not offered at the lookup drift stop.** Step 6 keeps one answer at
   the stop, "Publish over this" (section 9; bringing CommCare HQ's changes in there is step 7's
   `changes-made-in-hq`), and the table page gives "Let CommCare HQ manage it again", which takes
   CommCare HQ's columns as well as its rows; the stop's item names it (Copy P14). Not done: a
   second answer at the stop that replaces the rows alone, because CommCare HQ's table is its
   columns too (`lib/lookup/service.ts::replaceLookupRows` replaces rows under the table's current
   columns).
8. **The HQ app file carries managed tables in a second workbook, and its guide names each** (8.3).
   Not done: one workbook, with the guide alone naming the managed tables, because a guide that
   named a table inside the one workbook would rely on a person editing a spreadsheet to be safe.
9. **From part 05's media read (its section 9: a body is "returned as bytes with the declared type
   as a hint").** The response's content type is not passed to `lib/media`. A hint that may not
   change the verdict is a second input with no reader.
10. **A reference with no file is judged by slot, kind and platform, each read at source** (3.1):
    inert and listed where no runtime the app runs on draws it, and a finding otherwise. Every
    cell was read to a verdict: the Register action's on Android (nothing is drawn:
    `EntityActionViewUtils.setupActionAudio`, `setupActionImage`), a choice's in Web Apps (nothing
    is drawn: `PromptToJson.parseSelect` sends no media), and a question's sound or video in Web
    Apps with no map entry (a player is drawn: `multimedia.html`). No cell is held to one side for
    want of a read.
11. **Six circumstances join part 01's list in B9** (13.2), each a fact of a project space's data
    that no manifest entry can name. Part 01 holds all six (its sections 8.3 and 9.3). The sixth,
    `table-choices-unusable`, is part 09's ask: without it acceptance's check 2 would word a
    table's rows as Nova's mistake.
12. **From the research (worker and location properties "typed from how it reads them").** Nothing
    is typed; see "Claim corrected".
13. **No document migration and no document slot.** Every new fact is a nullable column of a
    Project or app table.
14. **From `lib/deployment/CLAUDE.md`, "Preflight is a graph" ("`plan-features` ... asks CommCare HQ
    nothing and comes before every edge that does").** `managed-data` asks CommCare HQ and comes
    before `plan-features` (`PREFLIGHT_CHECK_IDS` today: `hq-connection`, `app-readiness`,
    `plan-features`, `project-data`, ...). Evidence that the position is needed: the refresh changes
    the Project's lookup generation, and `app-readiness` runs the export boundary, which reads one
    generation and whose bytes are the ones sent (`lib/export/boundaryValidation.ts`, the header of
    `PreparedExportBoundary`); refreshed after it, the publish would validate rows it does not
    send. What the rule protects is that nothing is written to CommCare HQ, and nothing asked of
    the person about a write, before they have confirmed what the project space needs; a read of
    CommCare HQ and a refresh of Nova's own copy is neither. The rule is restated so (Contracts),
    and a publish refused later keeps the refresh, which is what Refresh would have written.
15. **Staged bytes take the media contract's `pending/` key and no `media_assets` row** (2.5). Not
    done: fetching into the contract's existing pending state, because that state is a
    `media_assets` row (`lib/media/CLAUDE.md`, "Two statuses"). Evidence: the same section says a
    pending row a client never confirms is "never reaped (no row reaper today)", and a reading can
    be removed or left for good with every file staged, so rows would accumulate in the Project's
    table with nothing to delete them, where the bucket's rule deletes the bytes. No third asset
    state is added: there is no asset at all until publication.
16. **Every level CommCare HQ lists comes in once the app reads places, whether or not an
    expression names it** (11.2). Not done: bringing in only the levels the app's logic reads.
    Evidence: a place row names a level (`app_locations.level_uuid`),
    `levelMayNestUnder` judges a place against its parent's level, and
    the tail's `assertLocationPlacementsValid` refuses a place whose level the document lacks. A
    copy of the active places with only the read levels would leave out every place at another
    level and the branches under it. Location properties do come in from what the app reads: one
    per slug read (11.5). A source that passes 11.1's text test and whose logic then reads no place
    keeps the levels and brings no place (11.1): the reader puts the levels on its draft before it
    has read an expression.
17. **The surface of section 14, where another shape was weighed**: staged files have no row and
    live one day; `mintLookupIds` lives in `lib/lookup/managed.ts` alone; findings, review and
    write are functions of what the reader read, and not members of what the read returns;
    `readReadingProjectData` reads the Project's side itself. Each is said with its reason in
    section 14. Four things are part 12's decisions and are held here, each argued there at
    source (its Departures 1, 12, 13 and 14): the two birth writers run at the `afterAppInsert`
    seam (7.4, 11.4); a table that changed under the birth sends the row back to `reading` (7.4);
    a `choice` tag binds the Project table's id before any answer (7.4); and publication is
    recorded on the row, so `ReadingMediaPlan` holds `published` and a lapsed file that changed is
    fetched again from a creation step while the row stays `ready` (14.2).
18. **Three exports for acceptance** (14.3). `handOffSettlements`, `readingLookupSnapshot` and
    `readingMediaRows` are part 09's ask, taken whole: B7 does not compile without them, and each
    is a pure function of values this part already holds.
19. **Two functions live in the reader.** `levelsFromHq` and `worldEntitiesFromReads` are in
    `lib/commcare/reader/worldEntities.ts`. Not done: placing them
    under `lib/deployment/reading/projectData/` with the rest of this part, because the reader
    calls both and may not import `lib/deployment`; `worldEntitiesFromReads` lands in B6 with the
    stage that calls it.

---

## Files by pull request

**B9.**

- New: `lib/media/publishReadyMedia.ts`, `lib/media/stagedMedia.ts` (`stageMediaBytes`,
  `publishStagedMedia`), `lib/media/stagedMediaFile.ts` (`StagedMediaFile`,
  `stagedMediaFileSchema`; pure); `lib/lookup/managed.ts` (`mintLookupIds`, `measureLookupRows`,
  the create and refresh arms), `lib/lookup/managedRules.ts` (`LookupRowsMeasure`,
  `lookupCapExcess`, `ManagedLookupContent`, `managedCanonicalSchema`; pure);
  `lib/organization/managed.ts`;
  `lib/deployment/managedData.ts`, `lib/deployment/managedDataActions.ts`;
  `lib/deployment/reading/projectData/index.ts` (pure), `read.ts` (`readReadingProjectData`),
  `reviewTypes.ts` (`LOOKUP_TABLE_CHOICES`,
  `LookupTableChoice`, `LookupChoiceOffer`, `lookupChoiceOfferSchema`, `ReviewTable`,
  `reviewTableSchema`, `ReviewPlaces`, `reviewPlacesSchema`), `review.ts` (`projectDataReview`),
  `media.ts` (pure, with `readingMediaRows`), `mediaStore.ts` (`fetchAndStageHqMediaFile`,
  `stageReadingMedia`, `publishReadingMedia`, `discardReadingMedia`), `lookupTables.ts` (pure,
  with `readingLookupSnapshot`), `lookupTableStore.ts` (`readHqLookupTablesForReading`,
  `writeBroughtInLookupTablesInTransaction`, `BroughtInTableChangedError`),
  `places.ts` (pure: `documentReadsPlaces`, `sourceMayReadPlaces`, `planManagedPlaces`,
  `managedPlacesOwnerFindings`), `placeStore.ts` (`writeBroughtInPlacesInTransaction`),
  `settlements.ts` (`HandOffSettlement`, `handOffSettlements`); `lib/publish/managedData.ts`;
  `lib/case-store/migrations/20261202000000_hq_bring_in_project_data.ts`;
  `components/builder/project-data/ManagedTableBanner.tsx`, `ManagedTableDialogs.tsx`;
  `components/builder/app-setup/ManagedPlacesBanner.tsx`; every test file of "Tests", among them
  `lib/deployment/reading/projectData/__tests__/settlements.test.ts`; `proof/targeted/` document
  `targeted-missing-media`.
- The reader's B9 lines, as part 06 lists them (its "Files by pull request", B9):
  `lib/commcare/reader/worldEntities.ts` gains `levelsFromHq`, and
  `lib/commcare/reader/__tests__/worldEntities.test.ts` its cases; `lib/commcare/reader/structure.ts`
  (`readStructure` puts the levels on the draft and raises none of their findings) with
  `structure.test.ts`.
- Changed: `lib/media/validate.ts` (`validateSniffedMediaBytes`); `lib/mcp/tools/uploadMediaAsset.ts`
  (calls `publishReadyMedia`); `lib/lookup/writerTransaction.ts`, `service.ts`, `authoringBatch.ts`,
  `schemaGovernance.ts`, `definitionSnapshot.ts`, `types.ts`, `errors.ts`, `actions.ts`;
  `lib/collab/lookupManifestFrame.ts`; `lib/organization/writerTransaction.ts`, `service.ts`
  (the two callers' purposes), `commitIntegrity.ts` (the managed sentences; three helpers
  exported), `errors.ts`, `types.ts`; `lib/db/pg.ts`; `lib/case-store/migrations/index.ts`;
  `lib/deployment/preflight.ts`, `lookupResourcePlan.ts`, `service.ts`, `store.ts`, `types.ts`
  (`hq_managed_data_changed`, `managed_table_handed_back`), `workerProvisionPlan.ts` (both maps
  and the `Pick`), `workers.ts`;
  `lib/export/boundaryValidation.ts`; `lib/commcare/lookup/xmlText.ts`, `hqCellText.ts` (the
  managed endings); `lib/publish/manualImportGuide.ts`;
  `lib/commcare/multimedia/hqJsonExportArchive.ts` (`hqImportFileGuide`,
  `buildHqJsonExportArchive`); `lib/mcp/tools/compileApp.ts` and `app/api/compile/json/route.ts`
  (the two callers of both);
  `lib/agent/tools/getLookupTables.ts` and `lib/agent/tools/organization.ts::getOrganizationTool`
  (result keys, descriptions);
  `lib/agent/authoring/reference.ts` (`AUTHORING_REFERENCE.expressions`, one sentence);
  `scripts/test-schema.ts` (the `getOrganization` entry); `lib/models.ts`
  (`MODEL_CONTEXT_VERSION`);
  `lib/publish/hqFindings.ts`, `hqFindingCopy.ts` (the six circumstances of 13.2);
  `lib/commcare/surface/entries/expressions-and-data.json`;
  `app/api/projects/[projectId]/lookup/tables/[tableId]/import/route.ts` (the new code's status);
  `components/builder/project-data/ProjectDataTableListScreen.tsx`, `ProjectDataTableScreen.tsx`,
  `TableActions.tsx`, `projectDataInspector.tsx`, `ColumnInspectorBody.tsx`,
  `LookupOrderingSection.tsx`, `useProjectData.ts`, `projectDataModel.ts`;
  `components/builder/app-setup/OrganizationSection.tsx`, `PlacesSubsection.tsx`,
  `LevelsSubsection.tsx`, `PersonasSubsection.tsx`; `proof/views/test_lookup_upload.py`;
  `proof/corpus/publish.ts` and `proof/corpus/targetPeer.ts` (the peer answers the lookup table
  reads the `managed-data` preflight makes; part 14 section 2.5), with the matching case in
  `proof/corpus/__tests__/publish.postgres.test.ts`;
  `e2e/lib/smokeProfiles.ts`, `e2e/lib/smokeSeedFactory.ts` and `e2e/seed.ts` (the seed profile
  `managed-data`: an app whose table and places carry the origin columns, written through
  `createManagedLookupTablesInTransaction` and `writeManagedPlacesInTransaction`);
  `lib/lookup/CLAUDE.md`, `lib/media/CLAUDE.md`, `lib/organization/CLAUDE.md`,
  `lib/deployment/CLAUDE.md`, `lib/export/CLAUDE.md`.
- No new `/api` route, so no `lib/hostnames.ts` entry: every new browser call is a Server Action.

**B6** (part 08's pull request) lands `lib/commcare/reader/worldEntities.ts` with
`worldEntitiesFromReads`, exactly as 11.5 writes it, and
`lib/commcare/reader/__tests__/worldEntities.test.ts` with that function's cases ("Tests"), beside
the stage that calls it (part 08, "Files by pull request").

**B12** (part 13) registers `refresh_managed_data` and `set_lookup_table_management` (its section
14.6) and holds stack B's one billed schema check, which sends `getLookupTables` and
`getOrganization` (its section 15.3). **B14** (part 15) lands the root `CLAUDE.md`, `contracts.md`
and public docs rows above. **B7** (part 09) holds the register entry
`media-references-with-no-file-removed` (its section 11.2, row 33) and imports the three exports
of 14.3. **B10** (part 12) calls section 14's surface and owns the `afterAppInsert` seam. **B13**
(part 14) lands the bases `hq-media`, `hq-lookups` and `hq-places` and their variants.

---

## What this part needs of other parts

Each need is met by the part named, at the section named; part 15's is what this part hands the
stack and the step 7 rewrite.

- **Part 01 (`01-the-bar-and-the-manifest.md`, A2).** Its `READ_CIRCUMSTANCES`,
  `CIRCUMSTANCE_STANDINGS` and `CIRCUMSTANCE_COPY` take the six rows of 13.2 in B9
  (`places-over-nova-limit`, `place-not-holdable`, `media-not-played-where-app-runs`,
  `table-cell-unrepresentable`, `owner-rule-needs-one-place`, `table-choices-unusable`), each
  written out there with its code, standing, sentence and next step (its sections 8.3 and 9.3),
  and its completeness test then holds them. Its section 3.5 row for
  `expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` ("an INERT
  class ... and a `fix-in-hq` class") is met by 13.1: the entry itself becomes the INERT class and
  a new REFUSED entry,
  `expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws`, is the other.
  Its appendix count for `media-files` moves by one REFUSED entry in B9. `media-file-unreadable`'s
  "When" already says "on a slot a runtime reads"; 3.2, row 3, is that test.
- **Part 04 (`04-names.md`, A9).** Its lookup grammar (section 9) is what `lookupTagSchema` and
  `lookupWireNameSchema` hold when B9 lands, hyphen admitted, and its entries N4, N5 and N24
  (section 11.2) take the names 5.3 sends them. The hand-off it asked for: this part reads no
  grammar wider than its own, and a name outside it is a finding, never a late gate refusal.
- **Part 05 (`05-reading-commcare-hq.md`, B1).** `readHqMediaFile` (its section 9),
  `listHqLookupTables`, `readHqLookupTableRows` (3.2), `rowsHoldOtherThanOneValue`,
  `listHqLocationTypes` and `listHqLocations` with their deadline parameter; `HqMediaMapItem` with
  `unreadable` (7); `HqAppSource.logoRefs`; `HqFailure`, `classifyHqFailure` with its request kinds
  `lookup-tables`, `lookup-rows`, `location-types`, `locations` and `media-file`, and
  `hqReadCircumstance` (4); `getHqCredentials(userId, domain)`, its rename of
  `getCredentialsForUpload` (11); `HQ_MEDIA_READ_CONCURRENCY` and `HQ_MEDIA_FILES_PER_STEP`; run G7.
  The one project data deadline is opened by part 12's step 5 (its section 3.3) and handed to
  `readReadingProjectData` as `within`.
- **Part 10 (`10-identity-and-the-ledger.md`, B8).** `AdoptedMediaFile`, `assignMediaPaths` and the
  path rows (its section 4.2); `externalKey`'s `organizationLevel`, `locationProperty` and
  `userProperty` (2.2), which `lib/commcare/reader/identity.ts` holds from B2; the `server` and
  `domain` it carries onto `app_deployment_resources` are not needed here (10.1 joins the
  deployment row). Its G2, outcome C, lands as "Written and not yet run" says.
- **Part 06 (`06-the-reader-forms.md`, B2 and B3) and part 07
  (`07-the-reader-cases-menus-lists.md`, B4 and B5).** This part builds the three inputs part 06
  names, in its types: `ReaderLookupCatalog` (`readerLookupCatalog`, 5.5), `ReaderOrganization`
  (14.1) and `ReaderMediaIndex` (`readingMediaIndex`, 14.2). What it reads of them:
  - `ReaderOrganization`: part 06 section 2.2 holds `{ levelCodes, levels }`; the structure stage
    puts the levels on the draft from B9 and raises none of their findings, which
    `readingProjectDataFindingsFor` raises where the app reads places. No API-key read lists a
    project space's location properties, so the type names none, and the slugs an app reads are
    learned from the app (11.5).
  - `ReadFacts` holds `mediaReferences` and `pendingMedia: readonly PendingMedia[]`, which part
    06's 17.3 already holds (every reference the index answered `no-entry` or `unreadable`), and
    lists in the second, with the slot `unheld_itext`, each itext media form on a slot Nova holds
    no media for whose path has no file, so `hqMediaReferencesOf` (2.1) sees every reference and
    Android's install check is judged over all of them (3.2). The Register action's two carriers
    reach it under the `MediaRefLocation` kinds part 02 (A5) adds.
  - A `ReadOutcome` of kind `account` carries `unreadTables: readonly UnreadTable[]` and
    `readsLocations` (part 06, section 2.2), so this part's findings for a table or a place Nova
    cannot hold join the same account (14.1, `projectDataReadsOf`).
  - The reader claims nothing for a pending media reference and for a select over a table the
    catalog lacks, and hands each off (`ClaimLog.handOffs`, part 06, section 4.5). This part gives
    the entry each stands under: `HqMediaPlan.claims` (2.1) and the findings of
    `readingProjectDataFindingsFor` (14.1), which part 12 adds to the reading's claim log and
    findings, and `handOffSettlements` (14.3) says which settled each.
  - Part 07's `readNavMedia`, which resolves through the same `ReaderMediaIndex`; this part adds
    no second reader of a media map.
  - `lib/commcare/reader/worldEntities.ts` is this part's file in the reader: B6 lands it with
    `worldEntitiesFromReads` and B9 adds `levelsFromHq` (part 06, section 2.1 and its "Files by
    pull request").
- **Part 08 (`08-the-reader-expressions.md`, B6).** `ExpressionReadEnv.lookup` is
  `ReaderLookupCatalog.definitions`, a `LookupDefinitionIndex` (5.5). Its entry M2,
  `expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant`, is the one this
  part raises for a select over a table CommCare HQ does not have (5.1). And `readExpressions`
  runs twice (its section 2.5): its first run returns `ExpressionReading.worldReads` (the
  name-backed `session-user` fields and the `location_data` slugs it met) and nothing else is kept
  of it; the reader calls `worldEntitiesFromReads`, adds the entities to its draft, and the second
  run is the reading (11.5). A worker slug outside the property grammar stays B6's own finding or
  its admitted `session-user` leaf. B6 lands `worldEntities.ts` and its test with that stage.
- **Part 09 (`09-acceptance-and-the-first-publish.md`, B7).** B7 lands above B9 and imports its
  pure exports; nothing here imports a type of B7.
  - `FIRST_PUBLISH_CHANGES` holds row 33, `media-references-with-no-file-removed` (its section
    11.2), whose predicate reads `mediaLeftOut`: `HqMediaPlan.inert.length`. Its
    `MEDIA_REFERENCE_PATHS` are the slots `hqMediaReferencesOf` reads (2.1).
  - `acceptReading` (its section 2.2) is handed `settlements` from `handOffSettlements`, `lookup`
    from `readingLookupSnapshot`, `media.rows` from `readingMediaRows(plan)` and `media.files` from
    `adoptedMediaFiles`, and `choices` from `narrowDeclarationsByMedia(draft.declaration,
    readingMediaFindings(...).playsOn)` (14.2, 14.3). Its fixed-point re-read is handed the same
    catalog, organization and media index as the reading.
  - Its check 2 (its section 4) relies on four facts of this part: `table-choices-unusable` is
    raised before acceptance, so no `LOOKUP_SELECT_SOURCE_*` finding reaches it;
    `table-cell-unrepresentable` is judged over the snapshot, a bound Project table included
    (5.3); a Project table that fails one of the three rules of a workbook to the reading's
    project space is never `same-equal`, and its `use-project` offer is not offered (7.1, 7.2);
    and the fixture budget is this part's finding (5.3).
- **Part 12 (`12-the-reading-and-the-birth.md`, B10).** It calls the surface of section 14 and
  nothing beneath it:
  - Its `minted` column holds `PredeclaredLookupIds`, and it passes
    `lib/lookup/managed.ts::mintLookupIds` as `mintIds`; `store.ts::mintLookupIds` is not made.
  - Its step 5 (its section 3.3) calls `readReadingProjectData`, with `choices: null` at a read
    step and the accepted answers at creation, and `places: "when-source-reads"`, then `"always"`
    where the document reads places and `placesRead` is false (11.1).
  - After the reader it calls `projectDataReadsOf`, then `readingProjectDataFindingsFor`, and for
    a clean read `projectDataReview` and `readingProjectDataWrite`.
  - A `choice` tag binds as 7.4 says: the Project table's id, before and after any answer.
    Creation validates the answers with `resolveTableChoices`, answers an unanswered choice `held`
    under part 01's `table-differs-in-project` and an unoffered one `choice_not_offered` (its
    section 5.3).
  - Its `media` column holds `ReadingMediaPlan`, parsed by `readingMediaPlanSchema`. A staged file
    has no row and its id is the `reservedId`; it passes its `provisionalReadingMediaId`, bound to
    the reading, as `reserve`. Staged bytes live one day.
  - Its media step (its section 3.4) calls `stageReadingMedia`; its read step calls
    `planReadingMedia` with `hqMediaReferencesOf(draft.facts)`, then `readingMediaFindings`, and
    narrows the declaration with `narrowDeclarationsByMedia` before acceptance.
  - Creation (its section 6.1) calls `publishReadingMedia` in recorded steps and writes each
    answer's `plan` at the row's revision; on `refetch` it writes the plan and keeps the row
    `ready`, and a creation step fetches the dropped files with `stageReadingMedia`.
    `Gathered.mediaFiles` is `adoptedMediaFiles(files)`, `files` the `published` arm's.
  - The two birth writers run at its `afterAppInsert` seam (its section 6.3), tables then places:
    `writeBroughtInLookupTablesInTransaction(tx, { projectId, actorUserId }, { origin, tables:
    write.tables, at })`, then `writeBroughtInPlacesInTransaction(tx, { appId, projectId,
    actorUserId }, { origin, places: write.places, at })`, which takes a null `places`.
    `BroughtInTableChangedError` and `tag_taken` return the row to `reading` with `review-changed`
    (its section 6.5).
  - "Remove" calls `discardReadingMedia({ projectId, plan })`.
  - Its `types.ts` re-exports `ReviewTable` and `ReviewPlaces` from this part's `reviewTypes.ts`
    (its section 5.1), and its `bringInInputSchema` reads `LOOKUP_TABLE_CHOICES` from the same
    module.
  - Its table of circumstances (its section 3.8) gains the rows of this part's six (13.2): each
    makes a read an account.
- **Part 13 (`13-the-experience.md`, B11 and B12).** The review places Copy R1 to R12 from
  `projectDataReview` (its sections 8.4 to 8.6), draws the choice of 7.2 with the offers and each
  of R10's four reasons (8.5), and passes the answers; `bring_in_hq_app` takes `table_choices` and
  names the same reasons (14.4); B12 registers the two tools of 12.4 with their scopes (14.6) and
  holds the billed check (15.3); the `upload_to_hq` skill's sweep covers "along with the lookup
  tables it reads and the places in its organization", which is no longer true of data CommCare HQ
  manages (16.2). It reads `LookupTableChoice`, `ReviewTable` and `ReviewPlaces` from
  `reviewTypes.ts`, through `lib/deployment/index.ts`'s re-export.
- **Part 14 (`14-proof.md`, A1 and B13).** Runs R1 and R2 as written (its section 11.2 lists them
  for B9, with the capture's managed-table reads, its section 2.5). The bases `hq-media`,
  `hq-lookups` and `hq-places` (6.2). Its variants for this part (7.2): on `hq-media`, a question
  image whose path has no map entry; on `hq-lookups`, a form that reads a tag CommCare HQ's table
  list lacks. A table with a field property and one with a row attribute are no variants, since
  no variant patches a lookup answer: part 14 exempts their entries under `not-in-app-source`
  with `lookupTables.test.ts` as their evidence, and exempts the two lookup entries of 13.1 under
  `stated-by-its-part` (7.5). Its `runReadingCheck` builds `ReaderOrganization` as `{ levelCodes,
  levels }`.
- **Part 15 (`15-stack-contracts-and-exit.md`; B14).** The rows of "Contracts"
  marked B14. In the step 7 rewrite: step 7's `changes-made-in-hq` group gains taking an
  organization over (11.4) and the lookup drift stop's second answer (9); step 7's
  `project-data-at-hq-size` group gains a table tagged `types`.

## What other parts read from this one

- **The surface of section 14, which is what part 12 (B10), part 09 (B7), part 13 (B11, B12) and
  part 14 (B13) call and all they call**, every file but the last under
  `lib/deployment/reading/projectData/`:
  - `index.ts` (pure): `ReadingProjectData`, `ReaderProjectDataReads`,
    `projectDataReadsOf`, `readingProjectDataFindingsFor`, `readingProjectDataWrite`,
    `ReadingProjectDataWrite`, `resolveTableChoices`. `read.ts`: `readReadingProjectData`.
  - `reviewTypes.ts` (client-safe; its only run-time import is `zod`): `LOOKUP_TABLE_CHOICES`,
    `LookupTableChoice`, `LookupChoiceOffer`, `lookupChoiceOfferSchema`, `ReviewTable`,
    `reviewTableSchema`, `ReviewPlaces`, `reviewPlacesSchema`. `ReviewTable` holds `tag`,
    `standing`, `hqDigest`, `projectTable` and `choice`; `ReviewPlaces` holds `count` and `digest`.
  - `review.ts`: `projectDataReview`.
  - `media.ts` (pure): `ReadingMediaPlan` (with `published`), `readingMediaPlanSchema`,
    `ReserveMediaId`, `readingMediaIndex`, `planReadingMedia`, `readingMediaFindings`,
    `mergeReadingMediaPlans`, `stagedReadingFiles`, `PublishedReadingFile`,
    `publishedReadingFileSchema`, `narrowDeclarationsByMedia`, `hqMediaReferencesOf`,
    `adoptedMediaFiles`, `readingMediaRows`. `mediaStore.ts`: `stageReadingMedia`,
    `publishReadingMedia`, `discardReadingMedia`.
  - `lookupTables.ts` (pure): `PredeclaredLookupIds`, `predeclaredLookupIdsSchema`,
    `LookupTableBinding`, `readerLookupCatalog`, `BroughtInTableWrite`, `readingLookupSnapshot`.
    `lookupTableStore.ts`: `writeBroughtInLookupTablesInTransaction`,
    `BroughtInTableChangedError`.
  - `places.ts` (pure): `documentReadsPlaces`. `placeStore.ts`:
    `writeBroughtInPlacesInTransaction`.
  - The cut between each pure file and the store file beside it is section 14's "Pure files and
    store files": part 12's check worker imports the pure files alone.
  - `settlements.ts`: `HandOffSettlement`, `handOffSettlements`.
  - `lib/commcare/reader/worldEntities.ts`, which the reader itself calls (parts 06 and 08):
    `worldEntitiesFromReads` (B6), `levelsFromHq` (B9).
- **Media, beneath that surface**: `validateSniffedMediaBytes`, `SniffedMediaValidation`
  (`lib/media/validate.ts`); `publishReadyMedia`, `ReadyMediaPublication`,
  `MediaPublishPermissionError` (`lib/media/publishReadyMedia.ts`);
  `stageMediaBytes`, `publishStagedMedia`, `PublishedStagedMedia`,
  `STAGED_MEDIA_PUBLISH_CONCURRENCY` (`lib/media/stagedMedia.ts`); `StagedMediaFile`,
  `stagedMediaFileSchema` (`lib/media/stagedMediaFile.ts`);
  `HqMediaReference`, `HQ_MEDIA_SLOTS`, `HqMediaSlot`, `HqMediaFile`, `HqMediaPlan`, `planHqMedia`,
  `HqMediaVerdict`, `hqMediaVerdictSchema`, `mediaFindings`,
  `mediaBudgetFinding`, `hqMediaRefusalEntry`, `mediaSlotDrawnOn` (slot, kind, platform, missing),
  `androidInstallCheckReaches` (`lib/deployment/reading/projectData/media.ts`);
  `fetchAndStageHqMediaFile` (`projectData/mediaStore.ts`).
- **Lookup tables, beneath it**: `LookupHqOrigin`, `LookupWritePurpose`, the error code
  `managed_in_hq` (`lib/lookup`); `mintLookupIds` (here and nowhere else), `measureLookupRows`,
  `ManagedOriginWrite`, `createManagedLookupTablesInTransaction`,
  `refreshManagedLookupTableInTransaction`, `ManagedRefreshReceipt` (`lib/lookup/managed.ts`);
  `LookupRowsMeasure`, `lookupCapExcess`, `managedCanonicalSchema`, `ManagedLookupContent`
  (`lib/lookup/managedRules.ts`);
  `candidateLookupTags`, `HqLookupTableRead`, `lookupTagsRead`,
  `lookupTableFindings` (a read and its measure; no list of fields), `lookupFixtureBudgetFinding`
  (over the snapshot), `columnLabelFor`, `LookupTableStanding`, `lookupTableStanding`,
  `resolveLookupBindings` (`lib/deployment/reading/projectData/lookupTables.ts`);
  `readHqLookupTablesForReading` (`projectData/lookupTableStore.ts`).
- **Managed data**: `refreshManagedLookupTable`, `manageLookupTableInNova`, `letHqManageLookupTable`,
  `readManagedLookupTableView`, `readManagedPlacesView`, `ManagedTableOutcome`,
  `ManagedPlacesOutcome`, `reReadManagedTablesForPublish`, `ManagedTableChange`,
  `ManagedTablesReRead`, `baselineFromTableOrigin`, `refreshManagedPlaces`
  (`lib/deployment/managedData.ts`); the six actions of `managedDataActions.ts`
  (`refreshManagedLookupTableAction`, `manageLookupTableInNovaAction`,
  `letHqManageLookupTableAction`, `readManagedLookupTableViewAction`, `refreshManagedPlacesAction`,
  `readManagedPlacesViewAction`); the preflight check `managed-data`, which precedes
  `plan-features`; the failure codes `hq_managed_data_changed` and `managed_table_handed_back`;
  `publishConfirmationNeeds`' fifth parameter `managedTableIds` and `lookupRemoteChange`'s
  `handBackOffered`; `PrepareExportBoundaryInput.lookupTarget`,
  `PreparedExportBoundary.managedLookupTables` and `managedLookupWorkbook`;
  `MANUAL_IMPORT_MANAGED_LOOKUP_WORKBOOK` (`lib/publish/manualImportGuide.ts`); the guide step kind
  `managed-lookup-tables`; `hqImportFileGuide`'s `managedLookupWorkbook` and `managedLookupTables`
  and `buildHqJsonExportArchive`'s `managedLookupWorkbook`.
- **Ownership**: `SiblingLookupMapping`, `readSiblingLookupMappings` (`lib/deployment/store.ts`);
  `PlanLookupResourcePushInput.siblings` and `takenOver`; `PlannedLookupPush.adoption` and
  `baseline`.
- **Places**: `OrganizationSnapshot.hq` (`server`, `domain`, `refreshedAt`, `leftOut`); the error
  code `managed-in-hq`; `lockOrganizationForWrite`'s `purpose` (`"author" | "hq-refresh" |
  "read"`); `ManagedPlaceWrite`, `ManagedPlacePlan`, `writeManagedPlacesInTransaction` (the
  `lib/organization` writer the birth reaches through `writeBroughtInPlacesInTransaction`),
  `refreshManagedPlacesInTransaction`, `ManagedPlacesRefresh` (`lib/organization/managed.ts`);
  `reverseHopDestinationLevelUuids`, `reverseLocationOwnerIssue` and `ownerVerdictRows`, exported
  from `lib/organization/commitIntegrity.ts`; `sourceMayReadPlaces`, `planManagedPlaces`,
  `managedPlacesOwnerFindings` (`lib/deployment/reading/projectData/places.ts`); `tableEditability`
  and `useTableIsEditable` (`components/builder/project-data/`); the provisioning
  plan's `managedPlaceIds`, read by `workerProvisionProblems` and `planWorkerProvisioning`.
- **DDL**: the migration `20261202000000_hq_bring_in_project_data`; `lookup_tables.hq_server`,
  `hq_domain`, `hq_remote_id`, `hq_canonical`, `hq_brought_in_at`, `hq_brought_in_by`,
  `hq_refreshed_at`, `hq_refreshed_by`, `hq_taken_over_at`, `hq_taken_over_by`; the constraints
  `lookup_tables_hq_origin_whole` and `lookup_tables_hq_takeover_attributed`; the index
  `lookup_tables_hq_origin`; `app_organization_state.hq_server`, `hq_domain`, `hq_places_digest`,
  `hq_left_out`, `hq_brought_in_at`, `hq_brought_in_by`, `hq_refreshed_at`, `hq_refreshed_by` and
  `app_organization_state_hq_origin_whole`; `app_locations.hq_location_id`.
- **Manifest and findings**: the new entry
  `expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws`; the value classes
  `path-without-entry-nothing-draws` and `path-without-entry-a-runtime-draws`; the circumstances
  `places-over-nova-limit`, `place-not-holdable`, `media-not-played-where-app-runs`,
  `table-cell-unrepresentable`, `owner-rule-needs-one-place` and `table-choices-unusable`, all six
  landing in B9; the register entry `media-references-with-no-file-removed` (part 09's row 33).
- **Copy**: `lib/publish/managedData.ts` (T1 to T21, O1 to O17, P1 to P18, G1, R1 to R12,
  `managedLookupTableRefusal`, `organizationManagedRefusal`, `managedOrganizationCommitRefusal`);
  X1 and X2 in `lib/commcare/lookup/xmlText.ts` and `hqCellText.ts`. R10 holds four sentences, one
  per reason an answer is not offered.
- **MCP**: the tools `refresh_managed_data` and `set_lookup_table_management` (registered by B12);
  the result keys `managed_in_commcare_hq` and `places_managed_in_commcare_hq`;
  `MODEL_CONTEXT_VERSION` `v7-hq-round-trip-bring-in.b9`.
- **Runs**: R1 and R2; the landing of part 05's G7 and part 10's G2 outcome C.
- **Facts**: one `multimedia_id` is one file's bytes; a picture with no map entry draws nothing in
  Web Apps, a question's sound or video with none draws a player with nothing to play, and a
  choice's media is drawn nowhere in Web Apps; on Android a missing file draws inside a form and in
  a list's image column and nowhere on a menu, a form's tile or the Register action; an audio slot
  whose map entry CommCare HQ files as video never receives the bytes; a workbook upload leaves a
  table it does not name alone; `FixtureResource`
  serves strings and asks for Edit Apps, and a field a row lacks is an empty element on a device
  either way; the place API returns active places only, no external id, and no level setting but
  `shares_cases` and `view_descendants`; staged bytes live one day and have no row, and verdicts
  live as long as the reading; a managed table and managed places have no ledger mapping; every
  column of a managed table is text; a change of who manages a table stamps its
  `definition_revision`; a Project table's standing in a project space is the Project's; a tag
  that meets a Project table binds that table's id before and after any answer; a Project table
  that a workbook to the reading's project space would refuse is never bound as it stands; the
  birth writes tables and places inside the genesis tail, at the `afterAppInsert` seam, after the
  app row and before the lookup context and the organization's integrity step; publication is
  recorded in the reading's plan; `media-not-played-where-app-runs` is raised exactly where no
  platform the content runs on plays every held file; a brought-in document names no place.
